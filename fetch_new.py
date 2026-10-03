#!/usr/bin/env python3
"""Download new episodes of Χριστιανισμός - Επιστήμη from the official site
into the archive, then rebuild the index.

The site's radio page lists every broadcast as a table row: the date, the
title, and one mp3 link per part. Broadcasts are matched to the archive by
date. Those newer than the newest one already in the archive are downloaded
into the archive's own layout:

    <archive>/<N>ος Κύκλος Εκπομπών/<Title> - <D> <Month> <YYYY>/<n>.mp3

Older broadcasts missing from the archive are only reported, since they may
be missing on purpose; --include-older downloads them too.

An episode is downloaded into <archive>/.incoming first and moved into its
season folder only when every part is complete, so neither the index nor
anyone browsing the share ever sees half an episode. An interrupted download
carries on from the last complete part.

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
from datetime import datetime
from urllib.parse import urljoin

from build_index import DATE_RE, MONTHS, SEASON_RE

SITE_DIR = os.path.dirname(os.path.abspath(__file__))
ARCHIVE_ROOT = os.environ.get("ARCHIVE_ROOT") or os.path.dirname(SITE_DIR)
PAGE_URL = os.environ.get("FETCH_URL") or "https://christianity-science.gr/radio.htm"
USER_AGENT = ("christianity-science-pwa "
              "(+https://github.com/GiorgosPap777/christianity-science-pwa)")
INCOMING = ".incoming"         # skipped by build_index.py, like every dot-name

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
            key = (int(y), int(m), int(d))
            ep = found.setdefault(key, {"season": int(season), "title": title, "parts": {}})
            pm = PART_RE.search(fname)
            n = int(pm.group(1)) if pm else order + 1
            ep["parts"].setdefault(n, urljoin(PAGE_URL, href))
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


def archive_dates(root):
    dates = set()
    for sdir in season_dirs(root).values():
        for name in os.listdir(os.path.join(root, sdir)):
            m = DATE_RE.match(name)
            if m and m.group(3) in MONTHS:
                dates.add((int(m.group(4)), MONTHS[m.group(3)], int(m.group(2))))
    return dates


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
            got = 0
            while True:
                chunk = res.read(CHUNK)
                if not chunk:
                    break
                if got == 0 and not looks_like_mp3(chunk[:4]):
                    raise ValueError(f"not an mp3 ({res.headers.get('Content-Type')})")
                fh.write(chunk)
                got += len(chunk)
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


def fetch_episode(root, seasons, date, ep, dry_run):
    season = ep["season"]
    sdir = seasons.get(season, f"{season}ος Κύκλος Εκπομπών")
    name = folder_name(ep["title"], date)
    final = os.path.join(root, sdir, name)
    log(f"New: {sdir}/{name} ({len(ep['parts'])} parts)")
    if dry_run:
        for n, url in ep["parts"]:
            log(f"  would fetch {url} -> {n}.mp3")
        return False
    if os.path.exists(final):
        log("  already there; skipped")
        return False

    stage = os.path.join(root, INCOMING, sdir, name)
    os.makedirs(stage, exist_ok=True)
    total = 0
    for n, url in ep["parts"]:
        dest = os.path.join(stage, f"{n}.mp3")
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

    os.makedirs(os.path.join(root, sdir), exist_ok=True)
    os.rename(stage, final)
    for d in (os.path.join(root, INCOMING, sdir), os.path.join(root, INCOMING)):
        try:
            os.rmdir(d)
        except OSError:
            pass
    log(f"  saved ({total / 1e6:.1f} MB downloaded)")
    return True


def rebuild_index(root):
    log("Rebuilding the index ...")
    res = subprocess.run([sys.executable, os.path.join(SITE_DIR, "build_index.py"),
                          "--root", root, "--jobs", "4"],
                         stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    # 1 only means the scan has warnings; build_index prints them.
    for line in res.stdout.splitlines():
        if line.strip() and not re.match(r"\s*\d+/\d+\s*$", line):
            log(f"  {line.strip()}")
    if res.returncode not in (0, 1):
        log(f"  index build failed (exit {res.returncode})")


# --------------------------------------------------------------------- runs

def run_once(args, cache, reported):
    root = args.root
    page = fetch_page(cache)
    if page is None:
        log("The site's page is unchanged.")
        return
    site = parse_page(page)
    if not site:
        log("Found no broadcasts on the page; has its layout changed? Nothing done.")
        return

    have = archive_dates(root)
    newest = max(have) if have else (0, 0, 0)
    missing = sorted(d for d in site if d not in have)
    newer = [d for d in missing if d > newest]
    older = [d for d in missing if d < newest]

    if older and not args.include_older and tuple(older) != reported.get("older"):
        reported["older"] = tuple(older)
        log(f"{len(older)} older broadcast(s) on the site are not in the archive "
            "(not downloaded; see --include-older):")
        for d in older:
            log(f"  {d[0]:04d}-{d[1]:02d}-{d[2]:02d}  {site[d]['title']}")

    todo = newer + (older if args.include_older else [])
    if not todo:
        log(f"Nothing new ({len(site)} broadcasts on the site, {len(have)} in the archive).")
        return
    if len(todo) > args.max:
        log(f"{len(todo)} episodes to fetch; only the first {args.max} this time "
            "(--max raises the limit).")
        todo = todo[:args.max]

    if not args.dry_run and not os.access(root, os.W_OK):
        log(f"Cannot write to {root}. Mount the archive read-write for this "
            "container (without :ro).")
        return

    seasons = season_dirs(root)
    saved = 0
    for d in todo:
        try:
            if fetch_episode(root, seasons, d, site[d], args.dry_run):
                saved += 1
                seasons = season_dirs(root)
        except Exception as e:                # carry on with the next one
            log(f"  gave up on this episode for now: {e}")
            cache.clear()                     # so the next run looks again
    if saved and not args.no_index:
        rebuild_index(root)


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
    ap.add_argument("--every", type=parse_interval, metavar="INTERVAL",
                    help="keep running, checking again after INTERVAL (e.g. 6h)")
    args = ap.parse_args()
    args.root = os.path.abspath(args.root)
    if not os.path.isdir(args.root):
        print(f"Archive root does not exist: {args.root}", file=sys.stderr)
        return 2

    # As PID 1 in a container, SIGTERM is ignored unless handled.
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))

    cache, reported = {}, {}
    if args.every:
        log(f"Checking {PAGE_URL} every {args.every / 3600:g} h for new episodes "
            f"for {args.root}.")
    while True:
        try:
            run_once(args, cache, reported)
        except Exception as e:
            log(f"Check failed: {e}")
            if not args.every:
                return 1
        if not args.every:
            return 0
        time.sleep(args.every)


if __name__ == "__main__":
    sys.exit(main())
