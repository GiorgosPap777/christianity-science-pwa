#!/bin/sh
# Container entrypoint: verify the archive is mounted and the index is
# writable, rebuild the index from whatever is actually on disk, then serve.
set -eu

ARCHIVE_ROOT="${ARCHIVE_ROOT:-/archive}"
HOST="${HOST:-0.0.0.0}"
PORT="${PORT:-8080}"
REBUILD_INDEX="${REBUILD_INDEX:-1}"
INDEX_OUT="${INDEX_OUT:-/data/index.json}"
export ARCHIVE_ROOT INDEX_OUT

if [ ! -d "$ARCHIVE_ROOT" ]; then
  echo "ERROR: archive not mounted at $ARCHIVE_ROOT" >&2
  echo "       run with:  -v /path/to/christianity-science:/archive:ro" >&2
  exit 1
fi

if [ ! -r "$ARCHIVE_ROOT" ]; then
  echo "ERROR: $ARCHIVE_ROOT is not readable by uid $(id -u)." >&2
  echo "       Either make the archive world-readable, or run the container" >&2
  echo "       as a user that can read it:  --user \"\$(id -u):\$(id -g)\"" >&2
  exit 1
fi

if ! find "$ARCHIVE_ROOT" -maxdepth 1 -type d -name '*Κύκλος Εκπομπών' 2>/dev/null | grep -q .; then
  echo "ERROR: no '<N>ος Κύκλος Εκπομπών' season folders found in $ARCHIVE_ROOT" >&2
  echo "       Mount the folder that CONTAINS the season directories:" >&2
  echo "         -v /path/to/christianity-science:/archive:ro" >&2
  echo "       Also check they are readable by uid $(id -u)." >&2
  exit 1
fi

# Fail fast on a non-writable index: the scan takes a while, and discovering
# the problem afterwards wastes it. A stale file owned by a different uid is
# removed rather than left to break the write.
INDEX_DIR="$(dirname "$INDEX_OUT")"
mkdir -p "$INDEX_DIR" 2>/dev/null || true
if [ -e "$INDEX_OUT" ] && [ ! -w "$INDEX_OUT" ]; then
  rm -f "$INDEX_OUT" 2>/dev/null || true
fi
if ! touch "$INDEX_DIR/.writetest" 2>/dev/null; then
  echo "ERROR: cannot write the episode index to $INDEX_DIR (running as uid $(id -u))." >&2
  echo "       Point INDEX_OUT at a writable path, e.g.:" >&2
  echo "         -e INDEX_OUT=/data/index.json  -v index-data:/data" >&2
  exit 1
fi
rm -f "$INDEX_DIR/.writetest"

if [ "$REBUILD_INDEX" != "0" ] || [ ! -f "$INDEX_OUT" ]; then
  echo "Building index from $ARCHIVE_ROOT ..."
  # exit 1 just means the scan reported warnings; only a missing index is fatal
  python3 /app/_site/build_index.py || true
  if [ ! -f "$INDEX_OUT" ]; then
    echo "ERROR: index build produced no $INDEX_OUT" >&2
    exit 1
  fi
fi

set -- --host "$HOST" --port "$PORT"
if [ -n "${TLS_CERT:-}" ]; then set -- "$@" --cert "$TLS_CERT"; fi
if [ -n "${TLS_KEY:-}" ];  then set -- "$@" --key  "$TLS_KEY";  fi

exec python3 /app/_site/serve.py "$@"
