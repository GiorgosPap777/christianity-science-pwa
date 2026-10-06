#!/usr/bin/env python3
"""Download new episodes of Χριστιανισμός - Επιστήμη from the official site
into the archive, then rebuild the index.

The site's radio page lists every broadcast as a table row: the date, the
title, and one mp3 link per part. Broadcasts are matched to the archive by
date. Those newer than the newest one already in the archive are downloaded
into the archive's own layout:

    <archive>/<N>ος Κύκλος Εκπομπών/<Title> - <D> <Month> <YYYY>/<n>.mp3

Older broadcasts missing from the archive are only reported, since they may
be missing on purpose; --include-older downloads them too. One whose download
was begun (it has a folder in .incoming) is not missing on purpose: it is
retried even after a newer one has been saved, say in the same run.

An episode is downloaded into <archive>/.incoming first and moved into its
season folder only when every part is complete, so neither the index nor
anyone browsing the share ever sees half an episode. An interrupted download
carries on from the last complete part.

The site may list a broadcast before all of its parts are up. A new episode
with fewer than the usual 4 parts therefore waits in .incoming, and is
completed on a later run, or saved as it is once it has looked the same for
SHORT_WAIT_DAYS. A recent episode already in the archive that has fewer parts
than the site now lists gets the missing ones.

With a folder for smaller copies ($LITE_ROOT or --lite), each run also makes
64 kbps copies of new high-bitrate parts (make_lite.py).

Usage:
    python3 _site/fetch_new.py [--dry-run] [--include-older] [--every 6h]
"""

import argparse
import html
import os
import re
import signal
import subprocess
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timedelta
from urllib.parse import urljoin, urlsplit

import make_lite
from build_index import DATE_RE, MONTHS, SEASON_RE

SITE_DIR = os.path.dirname(os.path.abspath(__file__))
ARCHIVE_ROOT = os.environ.get("ARCHIVE_ROOT") or os.path.dirname(SITE_DIR)
PAGE_URL = os.environ.get("FETCH_URL") or "https://christianity-science.gr/radio.htm"
USER_AGENT = ("christianity-science-pwa "
              "(+https://github.com/GiorgosPap777/christianity-science-pwa)")
LITE_ROOT = os.environ.get("LITE_ROOT")
INCOMING = ".incoming"         # skipped by build_index.py, like every dot-name
USUAL_PARTS = 4
SHORT_WAIT_DAYS = 3            # a new episode with fewer parts is saved after this
RECENT_DAYS = 60               # archive episodes checked for parts added late
LISTED = ".listed"             # in a staged episode: when it was first seen, and how

# Folder names use the proper spellings; MONTHS also accepts typos.
MONTH_NAMES = ["", "Ιανουαρίου", "Φεβρουαρίου", "Μαρτίου", "Απριλίου", "Μαΐου",
               "Ιουνίου", "Ιουλίου", "Αυγούστου", "Σεπτεμβρίου", "Οκτωβρίου",
               "Νοεμβρίου", "Δεκεμβρίου"]

# In the archive, a folder name longer than 200 bytes has its title cut to
# leave 199 bytes, and an ellipsis added; new ones follow suit.
MAX_NAME_BYTES = 200

LINK_RE = re.compile(
    r'href\s*=\s*"([^"]*?/?mp3/broadcasts/Season_(\d+)/(\d{4})_(\d\d)_(\d\d)/([^"/]+\.mp3))"',
    re.I)
PART_RE = re.compile(r"\((\d+)\)")
TIMEOUT = 60
CHUNK = 1 << 20
MAX_PART_BYTES = 500 * 10**6   # the largest real part is ~40 MB; this guards the share


def log(msg):
    print(f"{datetime.now():%Y-%m-%d %H:%M:%S} {msg}", flush=True)


# ------------------------------------------------------------------ the site

def text(fragment):
    s = re.sub(r"<[^>]+>", " ", fragment)
    return re.sub(r"\s+", " ", html.unescape(s)).strip()


def fetch_page(cache):
    """The page's HTML, or None when it is unchanged since the last fetch."""
    headers = {"User-Agent": USER_AGENT}
    if cache.get("etag"):
        headers["If-None-Match"] = cache["etag"]
    if cache.get("modified"):
        headers["If-Modified-Since"] = cache["modified"]
    req = urllib.request.Request(PAGE_URL, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as res:
            raw = res.read()
            etag, modified = res.headers.get("ETag"), res.headers.get("Last-Modified")
    except urllib.error.HTTPError as e:
        if e.code == 304:
            return None
        raise
    # The page declares windows-1253 in a <meta>, not in its headers.
    m = re.search(rb'charset\s*=\s*["\']?([\w-]+)', raw[:4096], re.I)
    charset = m.group(1).decode("ascii") if m else "windows-1253"
    try:
        page = raw.decode(charset, errors="replace")
    except LookupError:
        page = raw.decode("windows-1253", errors="replace")
    cache.update(etag=etag, modified=modified)
    return page


def parse_page(page):
    """{(y, m, d): {"season", "title", "parts": [(n, url), ...]}}"""
    found = {}
    for row in re.findall(r"<tr[^>]*>(.*?)</tr>", page, re.S | re.I):
        links = LINK_RE.findall(row)
        if not links:
            continue
        cells = re.findall(r"<td[^>]*>(.*?)</td>", row, re.S | re.I)
        title = text(cells[1]) if len(cells) > 1 else ""
        for order, (href, season, y, m, d, fname) in enumerate(links):
            url = urljoin(PAGE_URL, href)
            if urlsplit(url).hostname != urlsplit(PAGE_URL).hostname:
                continue          # the site links its own files; never another host's
            key = (int(y), int(m), int(d))
            ep = found.setdefault(key, {"season": int(season), "title": title, "parts": {}})
            pm = PART_RE.search(fname)
            n = int(pm.group(1)) if pm else order + 1
            ep["parts"].setdefault(n, url)
    for ep in found.values():
        ep["parts"] = sorted(ep["parts"].items())
    return found


# --------------------------------------------------------------- the archive

def season_dirs(root):
    """{season number: folder name}"""
    out = {}
    for name in os.listdir(root):
        m = SEASON_RE.match(name)
        if m and os.path.isdir(os.path.join(root, name)):
            out[int(m.group(1))] = name
    return out


def archive_folders(root):
    """{(y, m, d): path of that date's episode folder}"""
    found = {}
    for sdir in season_dirs(root).values():
        for name in os.listdir(os.path.join(root, sdir)):
            m = DATE_RE.match(name)
            if m and m.group(3) in MONTHS:
                found[(int(m.group(4)), MONTHS[m.group(3)], int(m.group(2)))] = \
                    os.path.join(root, sdir, name)
    return found


def staged_dates(root):
    """Dates with a download begun in .incoming: a failed attempt, or a short
    episode waiting for its last parts."""
    found = set()
    base = os.path.join(root, INCOMING)
    for sdir in (os.listdir(base) if os.path.isdir(base) else []):
        if not SEASON_RE.match(sdir) or not os.path.isdir(os.path.join(base, sdir)):
            continue
        for name in os.listdir(os.path.join(base, sdir)):
            m = DATE_RE.match(name)
            if m and m.group(3) in MONTHS:
                found.add((int(m.group(4)), MONTHS[m.group(3)], int(m.group(2))))
    return found


def part_numbers(folder):
    out = set()
    for f in os.listdir(folder):
        stem, ext = os.path.splitext(f)
        if ext.lower() == ".mp3" and stem.isdigit():
            out.add(int(stem))
    return out


def folder_name(title, date):
    """The archive's naming: straight double quotes become single ones and a
    colon a hyphen, as in the existing folders; other characters a Windows
    share refuses become hyphens; a long title is cut with an ellipsis."""
    y, m, d = date
    t = title.replace('"', "'").replace(":", "-")
    t = re.sub(r'[\\/*?<>|]', "-", t)
    t = re.sub(r"\s+", " ", t).strip(" .") or "Εκπομπή"
    suffix = f" - {d} {MONTH_NAMES[m]} {y}"
    name = t + suffix
    if len(name.encode()) > MAX_NAME_BYTES:
        while t and len((t + suffix).encode()) > MAX_NAME_BYTES - 1:
            t = t[:-1]
        name = t.rstrip() + "…" + suffix
    return name


# ---------------------------------------------------------------- downloads

def looks_like_mp3(head):
    return head[:3] == b"ID3" or (len(head) > 1 and head[0] == 0xFF and head[1] & 0xE0 == 0xE0)


def download(url, dest):
    """Fetch url to dest, via dest.part; raises on anything incomplete."""
    tmp = dest + ".part"
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as res, open(tmp, "wb") as fh:
            expected = res.headers.get("Content-Length")
            expected = int(expected) if expected and expected.isdigit() else None
            if expected is not None and expected > MAX_PART_BYTES:
                raise ValueError(f"too large for a part: {expected} bytes")
            got = 0
            while True:
                chunk = res.read(CHUNK)
                if not chunk:
                    break
                if got == 0 and not looks_like_mp3(chunk[:4]):
                    raise ValueError(f"not an mp3 ({res.headers.get('Content-Type')})")
                fh.write(chunk)
                got += len(chunk)
                if got > MAX_PART_BYTES:
                    raise ValueError(f"too large for a part: over {MAX_PART_BYTES} bytes")
        if got == 0 or (expected is not None and got != expected):
            raise ValueError(f"incomplete: {got} of {expected} bytes")
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise
    os.replace(tmp, dest)
    return got


def fetch_parts(parts, folder):
    """Download each (n, url) to folder/<n>.mp3 unless it is already there.
    Returns the bytes downloaded; raises after three failed attempts."""
    total = 0
    for n, url in parts:
        dest = os.path.join(folder, f"{n}.mp3")
        if os.path.exists(dest):              # only ever written whole
            log(f"  part {n}: kept from an earlier attempt")
            continue
        for attempt in range(1, 4):
            try:
                size = download(url, dest)
                total += size
                log(f"  part {n}: {size / 1e6:.1f} MB")
                break
            except (OSError, ValueError, urllib.error.URLError) as e:
                log(f"  part {n}: attempt {attempt} failed: {e}")
                if attempt == 3:
                    raise
                time.sleep(20 * attempt)
    return total


def short_and_waiting(stage, count):
    """True while a staged episode with fewer than the usual parts should
    wait for the rest. It is saved anyway once the site has listed the same
    number of parts for SHORT_WAIT_DAYS: some episodes really are shorter."""
    if count >= USUAL_PARTS:
        return False
    marker = os.path.join(stage, LISTED)
    now = time.time()
    try:
        with open(marker, encoding="utf-8") as fh:
            since, seen = (float(x) for x in fh.read().split())
    except (OSError, ValueError):
        since, seen = now, -1
    if seen != count:                         # first seen, or the site changed
        since = now
        with open(marker, "w", encoding="utf-8") as fh:
            fh.write(f"{since} {count}")
    return now - since < SHORT_WAIT_DAYS * 86400


def remove_empty_parents(path, stop):
    while path != stop:
        try:
            os.rmdir(path)
        except OSError:
            return
        path = os.path.dirname(path)


def fetch_episode(root, seasons, date, ep, dry_run):
    season = ep["season"]
    sdir = seasons.get(season, f"{season}ος Κύκλος Εκπομπών")
    name = folder_name(ep["title"], date)
    final = os.path.join(root, sdir, name)
    count = len(ep["parts"])
    log(f"New: {sdir}/{name} ({count} parts)")
    if dry_run:
        for n, url in ep["parts"]:
            log(f"  would fetch {url} -> {n}.mp3")
        if count < USUAL_PARTS:
            log(f"  WARNING incomplete: the site lists {count} of the usual "
                f"{USUAL_PARTS} parts; it would wait for the rest")
        return False
    if os.path.exists(final):
        log("  already there; skipped")
        return False

    stage = os.path.join(root, INCOMING, sdir, name)
    os.makedirs(stage, exist_ok=True)
    total = fetch_parts(ep["parts"], stage)
    if short_and_waiting(stage, count):
        log(f"  WARNING incomplete: the site lists {count} of the usual {USUAL_PARTS} "
            f"parts; kept in {INCOMING} until the rest appear (or for "
            f"{SHORT_WAIT_DAYS} days)")
        return False

    try:
        os.unlink(os.path.join(stage, LISTED))
    except OSError:
        pass
    os.makedirs(os.path.join(root, sdir), exist_ok=True)
    os.rename(stage, final)
    remove_empty_parents(os.path.dirname(stage), root)
    log(f"  saved ({total / 1e6:.1f} MB downloaded)")
    return True


def complete_episode(root, folder, date, ep, dry_run):
    """Fetch parts the site lists that an archive episode lacks. They are
    downloaded beside the archive in .incoming and moved in one by one, each
    complete, so the episode folder never holds a partial file."""
    missing = [(n, url) for n, url in ep["parts"] if n not in part_numbers(folder)]
    if not missing:
        return False
    rel = os.path.relpath(folder, root)
    log(f"Incomplete: {rel} lacks part(s) {[n for n, _ in missing]} that the site now lists")
    if dry_run:
        for n, url in missing:
            log(f"  would fetch {url} -> {n}.mp3")
        return False
    stage = os.path.join(root, INCOMING, rel)
    os.makedirs(stage, exist_ok=True)
    fetch_parts(missing, stage)
    for n, _ in missing:
        os.replace(os.path.join(stage, f"{n}.mp3"), os.path.join(folder, f"{n}.mp3"))
    remove_empty_parents(stage, root)
    log("  completed")
    return True


def rebuild_index(root, lite=None, out=None):
    log("Rebuilding the index ...")
    cmd = [sys.executable, os.path.join(SITE_DIR, "build_index.py"),
           "--root", root, "--jobs", "4"]
    if out:
        cmd += ["--out", out]
    if lite:
        cmd += ["--lite", lite]
    res = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    # 1 only means the scan has warnings; build_index prints them.
    for line in res.stdout.splitlines():
        if line.strip() and not re.match(r"\s*\d+/\d+\s*$", line):
            log(f"  {line.strip()}")
    if res.returncode not in (0, 1):
        log(f"  index build failed (exit {res.returncode})")


# --------------------------------------------------------------------- runs

def run_once(args, cache, reported):
    """Returns how many episodes were saved or completed."""
    root = args.root
    page = fetch_page(cache)
    if page is None:
        log("The site's page is unchanged.")
        return 0
    site = parse_page(page)
    if not site:
        log("Found no broadcasts on the page; has its layout changed? Nothing done.")
        return 0

    folders = archive_folders(root)
    have = set(folders)
    newest = max(have) if have else (0, 0, 0)

    if not args.dry_run and not os.access(root, os.W_OK):
        log(f"Cannot write to {root}. Mount the archive read-write for this "
            "container (without :ro).")
        return 0

    # Recent episodes saved before the site listed all of their parts.
    saved = 0
    cutoff = datetime.now() - timedelta(days=RECENT_DAYS)
    for d in sorted(have & set(site)):
        if datetime(*d) < cutoff:
            continue
        try:
            if complete_episode(root, folders[d], d, site[d], args.dry_run):
                saved += 1
        except Exception as e:
            log(f"  gave up on completing it for now: {e}")
            cache.clear()
    missing = sorted(d for d in site if d not in have)
    begun = staged_dates(root)
    newer = [d for d in missing if d > newest or d in begun]
    older = [d for d in missing if d not in newer]

    if older and not args.include_older and tuple(older) != reported.get("older"):
        reported["older"] = tuple(older)
        log(f"{len(older)} older broadcast(s) on the site are not in the archive "
            "(not downloaded; see --include-older):")
        for d in older:
            log(f"  {d[0]:04d}-{d[1]:02d}-{d[2]:02d}  {site[d]['title']}")

    todo = newer + (older if args.include_older else [])
    if not todo:
        if not saved:
            log(f"Nothing new ({len(site)} broadcasts on the site, "
                f"{len(have)} in the archive).")
        return saved
    if len(todo) > args.max:
        log(f"{len(todo)} episodes to fetch; only the first {args.max} this time "
            "(--max raises the limit).")
        todo = todo[:args.max]

    seasons = season_dirs(root)
    waiting = False
    for d in todo:
        try:
            if fetch_episode(root, seasons, d, site[d], args.dry_run):
                saved += 1
                seasons = season_dirs(root)
            elif len(site[d]["parts"]) < USUAL_PARTS:
                waiting = True
        except Exception as e:                # carry on with the next one
            log(f"  gave up on this episode for now: {e}")
            cache.clear()                     # so the next run looks again
    if waiting:
        cache.clear()     # look again next run even if the page has not changed
    return saved


def parse_interval(s):
    m = re.fullmatch(r"\s*(\d+(?:\.\d+)?)\s*([smhd]?)\s*", s or "")
    if not m:
        raise argparse.ArgumentTypeError(f"not a duration: {s!r} (try 6h, 30m, 1d)")
    return float(m.group(1)) * {"": 1, "s": 1, "m": 60, "h": 3600, "d": 86400}[m.group(2)]


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--root", default=ARCHIVE_ROOT, help="archive root (default $ARCHIVE_ROOT)")
    ap.add_argument("--dry-run", action="store_true", help="report, download nothing")
    ap.add_argument("--include-older", action="store_true",
                    help="also fetch older broadcasts that are missing from the archive")
    ap.add_argument("--max", type=int, default=10, help="episodes per run at most (default 10)")
    ap.add_argument("--no-index", action="store_true", help="do not rebuild the index afterwards")
    ap.add_argument("--out", metavar="FILE",
                    help="where the rebuilt index goes (default $INDEX_OUT, else "
                         "_site/index.json; set it when trying a test archive)")
    ap.add_argument("--lite", default=LITE_ROOT, metavar="DIR",
                    help="also make 64 kbps copies of high-bitrate parts here "
                         "(default $LITE_ROOT)")
    ap.add_argument("--no-lite", action="store_true", help="make no smaller copies")
    ap.add_argument("--every", type=parse_interval, metavar="INTERVAL",
                    help="keep running, checking again after INTERVAL (e.g. 6h)")
    args = ap.parse_args()
    args.root = os.path.abspath(args.root)
    if not os.path.isdir(args.root):
        print(f"Archive root does not exist: {args.root}", file=sys.stderr)
        return 2
    args.lite = None if args.no_lite or not args.lite else os.path.abspath(args.lite)
    if args.lite and os.path.commonpath([args.root, args.lite]) == args.root:
        print("The smaller copies must not go inside the archive.", file=sys.stderr)
        return 2

    # As PID 1 in a container, SIGTERM is ignored unless handled.
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))

    cache, reported = {}, {}
    if args.every:
        log(f"Checking {PAGE_URL} every {args.every / 3600:g} h for new episodes "
            f"for {args.root}.")
    while True:
        failed = False
        saved = made = 0
        try:
            saved = run_once(args, cache, reported)
        except Exception as e:
            log(f"Check failed: {e}")
            failed = True
        if args.lite and not args.dry_run:
            try:
                os.makedirs(args.lite, exist_ok=True)
                made = make_lite.run(args.root, args.lite)
            except Exception as e:
                log(f"Making smaller copies failed: {e}")
        if (saved or made) and not args.no_index and not args.dry_run:
            rebuild_index(args.root, args.lite, args.out)
        if not args.every:
            return 1 if failed else 0
        time.sleep(args.every)


if __name__ == "__main__":
    sys.exit(main())
