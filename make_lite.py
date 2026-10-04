#!/usr/bin/env python3
"""Make smaller copies of the archive's high-bitrate parts, for streaming.

The newest seasons are 112-192 kbps mono speech, two to three times the size
of the 64 kbps parts of seasons 1-15, which sound fine for this content. On a
home uplink shared by every listener, that size is what limits how many can
listen at once. This writes a 64 kbps mono copy of every part above that rate
into a separate folder, mirroring the archive's layout:

    <lite root>/<N>ος Κύκλος Εκπομπών/<Title> - <date>/<n>.mp3

The archive itself is only read. build_index.py points the index at a copy
when one exists and is at least as new as its original, and serve.py serves
the copies under /_lite/. A copy is written to a temporary name and renamed
when complete, so a half-encoded file is never served.

Usage:
    python3 _site/make_lite.py --lite DIR [--root ARCHIVE] [--dry-run]
"""

import argparse
import json
import os
import subprocess
import sys
import time
from datetime import datetime

from build_index import SEASON_RE, up_to_date

SITE_DIR = os.path.dirname(os.path.abspath(__file__))
ARCHIVE_ROOT = os.environ.get("ARCHIVE_ROOT") or os.path.dirname(SITE_DIR)
LITE_ROOT = os.environ.get("LITE_ROOT")

TARGET_KBPS = 64
SAMPLE_RATE = 44100          # what the 64 kbps seasons use
# Only parts clearly above the target are copied; re-encoding a 64 kbps file
# would lose quality and save nothing.
MIN_KBPS = 80
# Parts already found to be at or below the target, by size and mtime, so a
# later run does not read a thousand files over the share again to learn it.
LOW_FILE = ".low.json"

# MPEG audio frame header -> bitrate in kbps, by [version][layer][index].
# version: 3 = MPEG-1, 2 = MPEG-2, 0 = MPEG-2.5; layer: 1 = III, 2 = II, 3 = I.
_V1 = {1: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
       2: [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384],
       3: [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448]}
_V2 = {1: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
       2: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
       3: [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256]}


def log(msg):
    print(f"{datetime.now():%Y-%m-%d %H:%M:%S} {msg}", flush=True)


def mp3_kbps(path):
    """Bitrate of the first audio frame, or None. Every part in the archive
    is constant-bitrate, so the first frame speaks for the whole file. Reads
    a few KB instead of running ffprobe over the network share."""
    try:
        with open(path, "rb") as fh:
            head = fh.read(10)
            start = 0
            if head[:3] == b"ID3" and len(head) == 10:      # skip an ID3v2 tag
                start = 10 + ((head[6] & 0x7F) << 21 | (head[7] & 0x7F) << 14 |
                              (head[8] & 0x7F) << 7 | (head[9] & 0x7F))
            fh.seek(start)
            buf = fh.read(16384)
    except OSError:
        return None
    for i in range(len(buf) - 3):
        if buf[i] != 0xFF or buf[i + 1] & 0xE0 != 0xE0:
            continue
        version, layer = (buf[i + 1] >> 3) & 3, (buf[i + 1] >> 1) & 3
        index = buf[i + 2] >> 4
        if version == 1 or layer == 0 or index in (0, 15) or (buf[i + 2] >> 2) & 3 == 3:
            continue                                         # reserved / free / bad
        return (_V1 if version == 3 else _V2)[layer][index]
    return None


def parts(root):
    """(relative path, absolute path) of every part, in archive order."""
    for sdir in sorted(os.listdir(root)):
        spath = os.path.join(root, sdir)
        if not SEASON_RE.match(sdir) or not os.path.isdir(spath):
            continue
        for ename in sorted(os.listdir(spath)):
            epath = os.path.join(spath, ename)
            if ename.startswith(".") or not os.path.isdir(epath):
                continue
            for f in sorted(os.listdir(epath)):
                if f.lower().endswith(".mp3") and not f.startswith("."):
                    yield os.path.join(sdir, ename, f), os.path.join(epath, f)


def encode(src, dest):
    tmp = os.path.join(os.path.dirname(dest), "." + os.path.basename(dest) + ".tmp")
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    cmd = ["nice", "-n", "15",
           "ffmpeg", "-nostdin", "-v", "error", "-y", "-i", src,
           "-map", "0:a:0", "-c:a", "libmp3lame", "-b:a", f"{TARGET_KBPS}k",
           "-ac", "1", "-ar", str(SAMPLE_RATE),
           "-map_metadata", "0", "-id3v2_version", "3", "-f", "mp3", tmp]
    try:
        res = subprocess.run(cmd, capture_output=True, text=True, timeout=1800)
        if res.returncode != 0 or not os.path.getsize(tmp):
            raise RuntimeError(res.stderr.strip() or f"ffmpeg exit {res.returncode}")
        os.replace(tmp, dest)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def run(root, lite, dry_run=False, limit=0):
    """Encode what is missing. Returns the number of copies written."""
    try:
        with open(os.path.join(lite, LOW_FILE), encoding="utf-8") as fh:
            known_low = json.load(fh)
    except (OSError, ValueError):
        known_low = {}
    still_low = {}
    todo, kept, unknown = [], 0, []
    for rel, src in parts(root):
        dest = os.path.join(lite, rel)
        if up_to_date(src, dest):
            kept += 1
            continue
        try:
            st = os.stat(src)
        except OSError:
            continue
        sig = [st.st_size, int(st.st_mtime)]
        if known_low.get(rel) == sig:
            still_low[rel] = sig
            continue
        kbps = mp3_kbps(src)
        if kbps is None:
            unknown.append(rel)
        elif kbps >= MIN_KBPS:
            todo.append((rel, src, dest, kbps))
        else:
            still_low[rel] = sig
    low = len(still_low)
    if not dry_run and still_low != known_low:
        tmp = os.path.join(lite, "." + LOW_FILE + ".tmp")
        try:
            with open(tmp, "w", encoding="utf-8") as fh:
                json.dump(still_low, fh, ensure_ascii=False)
            os.replace(tmp, os.path.join(lite, LOW_FILE))
        except OSError as e:                  # only a cache: the bitrates are read again
            log(f"could not save {LOW_FILE}: {e}")
    log(f"{len(todo)} part(s) to make smaller; {kept} copies up to date; "
        f"{low} already at {TARGET_KBPS} kbps or less.")
    for rel in unknown:
        log(f"  could not read the bitrate, skipped: {rel}")
    if limit:
        todo = todo[:limit]

    made = 0
    for i, (rel, src, dest, kbps) in enumerate(todo, 1):
        if dry_run:
            log(f"  would encode ({kbps} kbps): {rel}")
            continue
        started = time.monotonic()
        try:
            encode(src, dest)
        except PermissionError as e:
            # The same for every part, every run: say it once, plainly.
            log(f"  cannot write the copies as uid {os.getuid()}: {e}")
            log(f"  Run this as the user who made the copies in {lite}, "
                "or give the folder to this one (chown -R).")
            break
        except Exception as e:
            log(f"  [{i}/{len(todo)}] failed: {rel}: {e}")
            continue
        made += 1
        log(f"  [{i}/{len(todo)}] {kbps} -> {TARGET_KBPS} kbps, "
            f"{os.path.getsize(src) / 1e6:.1f} -> {os.path.getsize(dest) / 1e6:.1f} MB "
            f"in {time.monotonic() - started:.0f} s: {rel}")
    return made


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--root", default=ARCHIVE_ROOT, help="archive root (default $ARCHIVE_ROOT)")
    ap.add_argument("--lite", default=LITE_ROOT, help="where the copies go (default $LITE_ROOT)")
    ap.add_argument("--dry-run", action="store_true", help="list what would be encoded")
    ap.add_argument("--limit", type=int, default=0, help="encode at most N parts this run")
    args = ap.parse_args()
    if not args.lite:
        print("No folder for the copies: pass --lite DIR or set LITE_ROOT.", file=sys.stderr)
        return 2
    root, lite = os.path.abspath(args.root), os.path.abspath(args.lite)
    if not os.path.isdir(root):
        print(f"Archive root does not exist: {root}", file=sys.stderr)
        return 2
    if os.path.commonpath([root, lite]) == root:
        print("The copies must not go inside the archive.", file=sys.stderr)
        return 2
    os.makedirs(lite, exist_ok=True)
    run(root, lite, args.dry_run, args.limit)
    return 0


if __name__ == "__main__":
    sys.exit(main())
