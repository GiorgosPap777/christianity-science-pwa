#!/bin/sh
# Container entrypoint: verify the archive is mounted, (re)build the index from
# whatever is actually on disk, then serve.
set -eu

ARCHIVE_ROOT="${ARCHIVE_ROOT:-/archive}"
HOST="${HOST:-0.0.0.0}"
PORT="${PORT:-8080}"
REBUILD_INDEX="${REBUILD_INDEX:-1}"
INDEX_OUT="${INDEX_OUT:-/app/_site/index.json}"
export ARCHIVE_ROOT INDEX_OUT

if [ ! -d "$ARCHIVE_ROOT" ]; then
  echo "ERROR: archive not mounted at $ARCHIVE_ROOT" >&2
  echo "       run with:  -v /path/to/christianity-science:/archive:ro" >&2
  exit 1
fi

if ! find "$ARCHIVE_ROOT" -maxdepth 1 -type d -name '*Κύκλος Εκπομπών' | grep -q .; then
  echo "WARNING: no '<N>ος Κύκλος Εκπομπών' folders found in $ARCHIVE_ROOT" >&2
  echo "         check the mount path and that the files are readable by uid $(id -u)" >&2
fi

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
