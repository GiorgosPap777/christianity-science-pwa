#!/usr/bin/env python3
"""Scan the Χριστιανισμός - Επιστήμη archive and emit _site/index.json.

Reads the archive in place. Never moves, renames, or copies audio.

Layout expected:
    <archive root>/<N>ος Κύκλος Εκπομπών/<Title> - <D> <Month> <YYYY>/<n>.mp3

Usage:
    python3 _site/build_index.py [--no-durations] [--jobs N]
"""

import argparse
import concurrent.futures
import json
import os
import re
import subprocess
import sys
import unicodedata
from datetime import datetime, timezone
from urllib.parse import quote

SITE_DIR = os.path.dirname(os.path.abspath(__file__))
# Overridable so the scanner can run in a container where the audio is mounted
# somewhere else entirely.
ARCHIVE_ROOT = os.environ.get("ARCHIVE_ROOT") or os.path.dirname(SITE_DIR)
OUT_PATH = os.environ.get("INDEX_OUT") or os.path.join(SITE_DIR, "index.json")

# Greek month names in the genitive, as they appear in folder names.
# The second spelling of February is a typo present in exactly one folder
# ("... - 27 Φεβρουρίου 2020"); aliased here so the folder need not be renamed.
MONTHS = {
    "Ιανουαρίου": 1,
    "Φεβρουαρίου": 2,
    "Φεβρουρίου": 2,
    "Μαρτίου": 3,
    "Απριλίου": 4,
    "Μαΐου": 5,
    "Μαίου": 5,
    "Ιουνίου": 6,
    "Ιουλίου": 7,
    "Αυγούστου": 8,
    "Σεπτεμβρίου": 9,
    "Οκτωβρίου": 10,
    "Νοεμβρίου": 11,
    "Δεκεμβρίου": 12,
}

MONTHS_EN = ["", "January", "February", "March", "April", "May", "June",
             "July", "August", "September", "October", "November", "December"]

# Episode folder names are "<title> - <day> <month> <year>". Titles frequently
# contain " - " themselves, so the date is anchored to the END of the name.
DATE_RE = re.compile(r"^(.*?)\s*[-–—]\s*(\d{1,2})\s+(\S+)\s+(\d{4})\s*$")

SEASON_RE = re.compile(r"^(\d+)ος\s+Κύκλος\s+Εκπομπών$")

# Episodes known to legitimately have fewer than 4 parts. Reported as info,
# not as a warning.
KNOWN_SHORT = {
    "15ος Κύκλος Εκπομπών/Το πείραμα του Milgram - 10 Μαρτίου 2022": 3,
}


def ffprobe_duration(path):
    """Return duration in seconds, or None if it cannot be determined."""
    try:
        out = subprocess.run(
            ["ffprobe", "-v", "error", "-show_entries", "format=duration",
             "-of", "default=nw=1:nk=1", path],
            capture_output=True, text=True, timeout=30,
        )
        return round(float(out.stdout.strip()), 3)
    except (ValueError, OSError, subprocess.SubprocessError):
        return None


def have_ffprobe():
    try:
        subprocess.run(["ffprobe", "-version"], capture_output=True, timeout=10)
        return True
    except (OSError, subprocess.SubprocessError):
        return False


def url_for(*segments):
    """Absolute URL path from the server document root (the archive root)."""
    return "/" + "/".join(quote(s) for s in segments)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--no-durations", action="store_true",
                    help="skip ffprobe; episode progress bars fall back to per-part only")
    ap.add_argument("--jobs", type=int, default=min(16, (os.cpu_count() or 4) * 4))
    ap.add_argument("--root", help="archive root (overrides $ARCHIVE_ROOT)")
    ap.add_argument("--out", help="output path (overrides $INDEX_OUT)")
    args = ap.parse_args()

    global ARCHIVE_ROOT, OUT_PATH
    if args.root:
        ARCHIVE_ROOT = os.path.abspath(args.root)
    if args.out:
        OUT_PATH = os.path.abspath(args.out)
    if not os.path.isdir(ARCHIVE_ROOT):
        print(f"Archive root does not exist: {ARCHIVE_ROOT}", file=sys.stderr)
        return 2
    print(f"Scanning {ARCHIVE_ROOT}", file=sys.stderr)

    warnings = []
    infos = []

    # --- discover seasons, sorted numerically (1ος .. 19ος, not lexicographically)
    season_dirs = []
    for name in os.listdir(ARCHIVE_ROOT):
        full = os.path.join(ARCHIVE_ROOT, name)
        if not os.path.isdir(full) or name.startswith((".", "_")):
            continue
        m = SEASON_RE.match(name)
        if not m:
            warnings.append(f"Directory does not look like a season folder, skipped: {name}")
            continue
        season_dirs.append((int(m.group(1)), name))
    season_dirs.sort()

    seasons = []
    probe_jobs = []  # (path, part_dict)
    n_eps = n_parts = 0

    for num, sdir in season_dirs:
        spath = os.path.join(ARCHIVE_ROOT, sdir)
        episodes = []

        for ename in sorted(os.listdir(spath)):
            epath = os.path.join(spath, ename)
            if not os.path.isdir(epath):
                if not ename.startswith("."):
                    warnings.append(f"Unexpected file inside season folder: {sdir}/{ename}")
                continue

            ep_id = f"{sdir}/{ename}"

            # --- parse "<title> - <day> <greek month> <year>"
            m = DATE_RE.match(ename)
            if not m:
                warnings.append(f"Cannot parse date from folder name: {ep_id}")
                title, date_iso, date_label, sort_key = ename, None, "", "9999"
                day = month = year = None
            else:
                title = m.group(1).strip()
                day, mon_word, year = int(m.group(2)), m.group(3), int(m.group(4))
                month = MONTHS.get(mon_word)
                if month is None:
                    warnings.append(f"Unknown Greek month '{mon_word}' in: {ep_id}")
                    date_iso, date_label, sort_key = None, "", "9999"
                else:
                    date_iso = f"{year:04d}-{month:02d}-{day:02d}"
                    date_label = f"{day} {mon_word} {year}"
                    sort_key = date_iso

            # --- collect parts, numerically ordered
            entries = sorted(os.listdir(epath))
            mp3s = []
            for f in entries:
                if f.lower().endswith(".mp3"):
                    stem = os.path.splitext(f)[0]
                    mp3s.append((int(stem) if stem.isdigit() else 10**6, f))
                elif not f.startswith("."):
                    warnings.append(f"Non-mp3 file inside episode folder: {ep_id}/{f}")
            mp3s.sort()

            if not mp3s:
                warnings.append(f"Episode folder contains no mp3 files: {ep_id}")
                continue

            # --- flag anything that is not a contiguous 1..N run
            numbers = [n for n, _ in mp3s]
            expected = list(range(1, len(mp3s) + 1))
            if numbers != expected:
                warnings.append(
                    f"Parts are not a contiguous 1..N run ({[f for _, f in mp3s]}): {ep_id}")
            elif len(mp3s) != 4:
                if KNOWN_SHORT.get(ep_id) == len(mp3s):
                    infos.append(f"{len(mp3s)} parts (known and expected): {ep_id}")
                else:
                    warnings.append(f"Episode has {len(mp3s)} parts, expected 4: {ep_id}")

            parts = []
            for n, fname in mp3s:
                fpath = os.path.join(epath, fname)
                part = {
                    "n": n,
                    "url": url_for(sdir, ename, fname),
                    "dur": None,
                    "bytes": os.path.getsize(fpath),
                }
                parts.append(part)
                probe_jobs.append((fpath, part))
            n_parts += len(parts)

            episodes.append({
                "id": ep_id,
                "title": title,
                "folder": ename,
                "season": num,
                "date": date_iso,
                "dateLabel": date_label,
                "dateLabelEn": (f"{day} {MONTHS_EN[month]} {year}"
                                if date_iso else ""),
                "search": normalize(title),
                "_sort": sort_key,
                "parts": parts,
                "totalDur": None,
            })
            n_eps += 1

        # chronological ascending; the UI reverses for display when asked
        episodes.sort(key=lambda e: (e["_sort"], e["folder"]))
        for e in episodes:
            del e["_sort"]

        years = [int(e["date"][:4]) for e in episodes if e["date"]]
        seasons.append({
            "num": num,
            "dir": sdir,
            "yearStart": min(years) if years else None,
            "yearEnd": max(years) if years else None,
            "episodes": episodes,
        })

    # --- durations
    if args.no_durations:
        print("Skipping durations (--no-durations).", file=sys.stderr)
    elif not have_ffprobe():
        warnings.append("ffprobe not found; durations omitted.")
        print("ffprobe not found; durations omitted.", file=sys.stderr)
    else:
        print(f"Probing durations for {len(probe_jobs)} files "
              f"with {args.jobs} workers...", file=sys.stderr)
        done = 0
        with concurrent.futures.ThreadPoolExecutor(max_workers=args.jobs) as pool:
            futs = {pool.submit(ffprobe_duration, p): part for p, part in probe_jobs}
            for fut in concurrent.futures.as_completed(futs):
                futs[fut]["dur"] = fut.result()
                done += 1
                if done % 100 == 0 or done == len(probe_jobs):
                    print(f"  {done}/{len(probe_jobs)}", end="\r", file=sys.stderr)
        print(file=sys.stderr)
        for s in seasons:
            for e in s["episodes"]:
                durs = [p["dur"] for p in e["parts"]]
                if all(d is not None for d in durs):
                    e["totalDur"] = round(sum(durs), 3)
                else:
                    bad = [p["n"] for p in e["parts"] if p["dur"] is None]
                    warnings.append(f"Could not read duration for part(s) {bad}: {e['id']}")

    data = {
        "generated": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "archiveRoot": ARCHIVE_ROOT,
        "counts": {"seasons": len(seasons), "episodes": n_eps, "parts": n_parts},
        "infos": infos,
        "warnings": warnings,
        "seasons": seasons,
    }

    with open(OUT_PATH, "w", encoding="utf-8") as fh:
        json.dump(data, fh, ensure_ascii=False, separators=(",", ":"))

    size_kb = os.path.getsize(OUT_PATH) / 1024
    print(f"\nWrote {OUT_PATH} ({size_kb:.0f} KB)")
    print(f"  seasons:  {len(seasons)}")
    print(f"  episodes: {n_eps}")
    print(f"  parts:    {n_parts}")
    if infos:
        print(f"\nInfo ({len(infos)}):")
        for i in infos:
            print(f"  - {i}")
    if warnings:
        print(f"\nWARNINGS ({len(warnings)}):", file=sys.stderr)
        for w in warnings:
            print(f"  ! {w}", file=sys.stderr)
        return 1
    print("\nNo warnings.")
    return 0


def normalize(s):
    """Lowercase, strip Greek diacritics, fold final sigma. Mirrors app.js."""
    s = unicodedata.normalize("NFD", s.lower())
    s = "".join(c for c in s if not unicodedata.combining(c))
    return s.replace("ς", "σ")


if __name__ == "__main__":
    sys.exit(main())
