#!/usr/bin/env python3
"""Local static server for the Χριστιανισμός - Επιστήμη archive.

The document root is the archive root (this script's parent directory), so the
mp3 files are served straight from where they already live -- nothing is copied.

Unlike `python3 -m http.server`, this handles HTTP Range requests (206 Partial
Content), which is what lets the browser seek inside a part without first
downloading the whole file.

Three things protect a small home uplink shared by every listener:

- Listening is paced: after the first PLAY_BURST bytes, an mp3 response goes
  at PLAY_KBPS. Otherwise the browser pulls the rest of the part as fast as
  the line allows, and that queue (the router's, and the proxy's socket) is
  what the next seek -- anyone's -- waits behind.
- A download made to save an episode for offline listening (the app adds
  ?save=1) is sent at SAVE_KBPS, and at most SAVE_SLOTS of them run at once;
  the rest get 503 and a Retry-After, and the app tries again later. Pacing
  has to happen here: a browser reads a response at full speed however slowly
  the page consumes it.
- Smaller copies of high-bitrate parts, made by make_lite.py, are served from
  LITE_ROOT under /_lite/. The index points at them; the archive is untouched.

Usage:
    python3 _site/serve.py [--port 8080] [--host 127.0.0.1] [--lite DIR]
"""

import argparse
import functools
import os
import re
import shutil
import ssl
import threading
import time
import urllib.parse
import sys
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

from make_lite import mp3_kbps

SITE_DIR = os.path.dirname(os.path.abspath(__file__))
# In a container the audio is a separate mount, so the archive root is
# configurable; locally it defaults to the folder this script sits in.
ARCHIVE_ROOT = os.environ.get("ARCHIVE_ROOT") or os.path.dirname(SITE_DIR)
SITE_NAME = "_site"          # URL prefix -- kept fixed, sw.js depends on it
# The generated index may live outside the site directory when that directory
# is not writable by the running user (see the container's /data).
INDEX_OUT = os.environ.get("INDEX_OUT")
INDEX_OUT = os.path.abspath(INDEX_OUT) if INDEX_OUT else None
LITE_ROOT = os.environ.get("LITE_ROOT")
LITE_ROOT = os.path.abspath(LITE_ROOT) if LITE_ROOT else None
LITE_NAME = "_lite"          # URL prefix of the smaller copies


def env_int(name, default):
    try:
        return max(0, int(os.environ.get(name, default)))
    except ValueError:
        return default


# Offline saves: kbit/s each (0 = unpaced) and how many at once (0 = no cap).
# 2 x 256 kbit/s leaves most of a 5 Mbit/s uplink to live listening.
SAVE_KBPS = env_int("SAVE_KBPS", 256)
SAVE_SLOTS = env_int("SAVE_SLOTS", 2)
SAVE_RETRY_AFTER = 30        # seconds, for a save turned away while slots are full
_save_slots = threading.BoundedSemaphore(SAVE_SLOTS) if SAVE_SLOTS else None

# Listening: kbit/s after the first PLAY_BURST bytes (0 = unpaced). 512 keeps
# a 64 kbps part 8x ahead of playback; the burst gets playback going at once.
# A part above 128 kbps (one with no smaller copy) gets PLAY_AHEAD times its
# own rate instead.
PLAY_KBPS = env_int("PLAY_KBPS", 512)
PLAY_BURST = env_int("PLAY_BURST", 128 * 1024)
PLAY_AHEAD = 4
# A client that fell behind (a phone in a tunnel) catches up with at most
# this many seconds' worth at full speed, not with everything it missed.
PACE_SLACK = 1.0

RANGE_RE = re.compile(r"^bytes=(\d*)-(\d*)$")
NO_CACHE_EXT = (".html", ".js", ".css", ".json", ".webmanifest")
# Clients that hang up mid-transfer -- routine for <audio>, not an error. A
# timeout is the same thing from the other side: a paused <audio> that stopped
# reading, or a connection left idle.
CLIENT_GONE = (ConnectionResetError, BrokenPipeError, ConnectionAbortedError,
               TimeoutError)

# Everything the app itself loads from /_site/. Anything else there (sources,
# the README, .git when the repo sits inside the archive) is not served.
SITE_FILES = {"", "index.html", "app.js", "i18n.js", "styles.css", "sw.js",
              "manifest.webmanifest", "index.json"}
ICON_RE = re.compile(r"icons/[\w.-]+\.png")

# Seconds a client gets to finish the TLS handshake, then to send each request
# or accept each chunk of a response. Without them an idle connection holds a
# thread forever.
HANDSHAKE_TIMEOUT = 15
IDLE_TIMEOUT = 120


@functools.lru_cache(maxsize=4096)
def part_kbps(path, mtime, size):
    """The bitrate of a part, read once per version of the file."""
    return mp3_kbps(path)


class ArchiveHandler(SimpleHTTPRequestHandler):
    """Static handler with byte-range support and a redirect from / to the site."""

    # HTTP/1.1 keeps the connection alive between the many range requests an
    # <audio> element makes, and some browsers are stricter about 1.0 responses.
    # Every response below must therefore carry an accurate Content-Length.
    protocol_version = "HTTP/1.1"
    timeout = IDLE_TIMEOUT

    def __init__(self, *args, **kwargs):
        self._range = None  # (start, length) for the in-flight response
        self._save = False  # the in-flight response is an offline save
        self._mp3 = False   # the in-flight response is audio (paced too)
        super().__init__(*args, directory=ARCHIVE_ROOT, **kwargs)

    def do_GET(self):
        """An offline save takes one of the save slots for as long as it
        runs. With all of them busy it is turned away at once rather than
        queued here, where it would hold a connection open doing nothing."""
        split = urllib.parse.urlsplit(self.path)
        self._mp3 = split.path.lower().endswith(".mp3")
        self._save = (self._mp3 and
                      "1" in urllib.parse.parse_qs(split.query).get("save", []))
        if self._save and _save_slots and not _save_slots.acquire(blocking=False):
            self.send_response(HTTPStatus.SERVICE_UNAVAILABLE)
            self.send_header("Retry-After", str(SAVE_RETRY_AFTER))
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        try:
            super().do_GET()
        finally:
            if self._save and _save_slots:
                _save_slots.release()

    def do_HEAD(self):
        self._save = self._mp3 = False   # reused across keep-alive requests
        super().do_HEAD()

    # -- routing ---------------------------------------------------------
    def allowed(self, name):
        """Only what the app needs: its own files under /_site/, and mp3s
        everywhere else. `name` is the decoded path, without the query."""
        if any(seg.startswith(".") for seg in name.split("/")):
            return False                     # .git, .env, and ".." tricks
        prefix = "/" + SITE_NAME
        if name == prefix:
            return True                      # redirected to /_site/
        if name.startswith(prefix + "/"):
            rest = name[len(prefix) + 1:]
            return rest in SITE_FILES or bool(ICON_RE.fullmatch(rest))
        if name.startswith("/" + LITE_NAME + "/") and not LITE_ROOT:
            return False
        return name.lower().endswith(".mp3")

    def list_directory(self, path):
        """No directory listings: the app never needs one, and they would
        expose the whole archive layout."""
        self.send_error(HTTPStatus.NOT_FOUND, "File not found")
        return None

    def translate_path(self, path):
        """Serve /_site/* from the bundled site, everything else from the
        archive. Locally these are the same tree; in a container they are two
        different mounts."""
        clean = urllib.parse.urlsplit(path).path
        prefix = "/" + SITE_NAME
        if INDEX_OUT and clean == prefix + "/index.json":
            return INDEX_OUT
        for pre, root in ((prefix, SITE_DIR), ("/" + LITE_NAME, LITE_ROOT)):
            if root and (clean == pre or clean.startswith(pre + "/")):
                saved, self.directory = self.directory, root
                try:
                    return super().translate_path(clean[len(pre):] or "/")
                finally:
                    self.directory = saved
        return super().translate_path(path)

    # -- range-aware file serving ----------------------------------------
    def send_head(self):
        """Shared by GET and HEAD, so the routing lives here."""
        self._range = None
        clean = urllib.parse.urlsplit(self.path).path
        if clean == "/favicon.ico":
            self.send_response(HTTPStatus.NO_CONTENT)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return None
        if clean in ("/", "/index.html"):
            self.send_response(HTTPStatus.MOVED_PERMANENTLY)
            self.send_header("Location", f"/{SITE_NAME}/")
            self.send_header("Content-Length", "0")
            self.end_headers()
            return None
        name = urllib.parse.unquote(clean)
        if "\x00" in name:                   # open() would raise ValueError
            self.send_error(HTTPStatus.BAD_REQUEST, "Bad path")
            return None
        if not self.allowed(name):
            self.send_error(HTTPStatus.NOT_FOUND, "File not found")
            return None
        path = self.translate_path(self.path)

        if os.path.isdir(path):
            # Let the base class handle directory index / trailing-slash redirect.
            return super().send_head()

        range_header = self.headers.get("Range")
        if not range_header:
            return super().send_head()

        m = RANGE_RE.match(range_header.strip())
        if not m:
            return super().send_head()  # unparseable -> serve whole file

        try:
            fh = open(path, "rb")
        except (OSError, ValueError):
            self.send_error(HTTPStatus.NOT_FOUND, "File not found")
            return None

        try:
            st = os.fstat(fh.fileno())
            size = st.st_size
            last_modified = self.date_time_string(int(st.st_mtime))
            first, last = m.group(1), m.group(2)

            # If-Range: a range only makes sense against the copy the client
            # already has. If the file changed since, send all of it, rather
            # than splice two different files together.
            if_range = self.headers.get("If-Range")
            if (first == "" and last == "") or (if_range and if_range.strip() != last_modified):
                fh.close()
                return super().send_head()

            if first == "":
                # suffix form: bytes=-N  (final N bytes)
                length = min(int(last), size)
                start = size - length
                end = size - 1
            else:
                start = int(first)
                end = int(last) if last else size - 1
                end = min(end, size - 1)
                length = end - start + 1
            if start >= size or start > end or length <= 0:   # incl. bytes=-0
                fh.close()
                self.send_response(HTTPStatus.REQUESTED_RANGE_NOT_SATISFIABLE)
                self.send_header("Content-Range", f"bytes */{size}")
                self.send_header("Content-Length", "0")
                self.end_headers()
                return None

            fh.seek(start)
            self._range = (start, length)

            self.send_response(HTTPStatus.PARTIAL_CONTENT)
            self.send_header("Content-Type", self.guess_type(path))
            self.send_header("Content-Length", str(length))
            self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
            self.send_header("Accept-Ranges", "bytes")
            self.send_header("Last-Modified", last_modified)
            self.end_headers()
            return fh
        except Exception:
            fh.close()
            raise

    def pace(self, source):
        """(bytes/s, unpaced bytes first) for the in-flight response; 0 bytes/s
        sends it at full speed."""
        if self._save:
            return SAVE_KBPS * 1000 / 8, 0
        if not (self._mp3 and PLAY_KBPS):
            return 0, 0
        kbps = PLAY_KBPS
        try:
            st = os.fstat(source.fileno())
            kbps = max(kbps, PLAY_AHEAD * (part_kbps(source.name, st.st_mtime, st.st_size) or 0))
        except (OSError, AttributeError, TypeError):
            pass
        return kbps * 1000 / 8, PLAY_BURST

    def copyfile(self, source, outputfile):
        rate, burst = self.pace(source)
        if self._range is None and not rate:
            try:
                return super().copyfile(source, outputfile)
            except CLIENT_GONE:
                return None
        if self._range:
            remaining = self._range[1]
        else:
            remaining = os.fstat(source.fileno()).st_size - source.tell()
        # Small chunks when paced, so the line sees an even trickle rather
        # than 64 KB bursts with long gaps.
        size = 16 * 1024 if rate else 64 * 1024
        sent, due = 0, None      # due: when the next chunk may go out
        try:
            while remaining > 0:
                chunk = source.read(min(size, remaining))
                if not chunk:
                    break
                outputfile.write(chunk)
                sent += len(chunk)
                remaining -= len(chunk)
                # No wait after the last chunk: a save would hold its slot,
                # and the next request on this connection would wait too.
                if rate and remaining > 0 and sent >= burst:
                    now = time.monotonic()
                    due = max(due or now, now - PACE_SLACK) + len(chunk) / rate
                    if due > now:
                        time.sleep(due - now)
        except CLIENT_GONE:
            pass          # client seeked away or closed the tab

    # -- headers ---------------------------------------------------------
    def end_headers(self):
        if getattr(self, "_headers_buffer", None) is not None:
            # Errors raised while parsing the request line (400, 414, 505)
            # are sent before self.path exists.
            clean = (getattr(self, "path", "") or "").split("?", 1)[0].lower()
            if not self._has_header("accept-ranges"):
                self.send_header("Accept-Ranges", "bytes")
            if clean.endswith("/sw.js"):
                self.send_header("Service-Worker-Allowed", "/")
            if not self._has_header("cache-control"):
                # no-cache, not no-store: the browser keeps a copy but asks
                # before every use, and an unchanged file costs a 304 (the base
                # class answers If-Modified-Since) instead of the whole body.
                # index.json alone is ~800 KB.
                if clean.endswith(NO_CACHE_EXT) or clean.endswith("/"):
                    self.send_header("Cache-Control", "no-cache")
                elif self._save:
                    # The app keeps its own copy; the HTTP cache need not.
                    self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def _has_header(self, lower_name):
        prefix = (lower_name + ":").encode("latin-1")
        buf = getattr(self, "_headers_buffer", None) or []
        return any(h.lower().startswith(prefix) for h in buf)

    def guess_type(self, path):
        low = path.lower()
        if low.endswith(".mp3"):
            return "audio/mpeg"
        if low.endswith(".webmanifest"):
            return "application/manifest+json"
        return super().guess_type(low)

    # -- quieter logging -------------------------------------------------
    def log_message(self, fmt, *args):
        msg = fmt % args
        if any((" %s " % c) in msg for c in (200, 204, 206, 301, 304)):
            return  # only surface problems
        if msg.startswith("Request timed out"):
            return  # an idle keep-alive connection being closed
        sys.stderr.write("%s - %s\n" % (self.address_string(), msg))


class ArchiveServer(ThreadingHTTPServer):
    """Threaded server with TLS done per connection, and quiet about clients
    that hang up.

    socketserver reports exceptions escaping a request thread through the
    *server's* handle_error, not the handler's -- e.g. a phone that opens a
    connection and drops it while the request line is still being read. That
    is routine for mobile audio clients, so only real errors get printed.
    Failed TLS handshakes (scanners, plain HTTP on the HTTPS port) are the
    same kind of noise."""

    allow_reuse_address = True
    ssl_context = None

    def finish_request(self, request, client_address):
        """Runs in the request's own thread. Wrapping the listening socket
        instead would do every handshake inside accept() on the main thread,
        where one client that connects and sends nothing blocks everyone."""
        if self.ssl_context is None:
            return super().finish_request(request, client_address)
        request.settimeout(HANDSHAKE_TIMEOUT)
        conn = self.ssl_context.wrap_socket(request, server_side=True)
        try:
            super().finish_request(conn, client_address)
        finally:
            self.shutdown_request(conn)   # the raw socket was detached by the wrap

    def handle_error(self, request, client_address):
        if isinstance(sys.exc_info()[1], CLIENT_GONE + (ssl.SSLError,)):
            return
        super().handle_error(request, client_address)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8080)
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--cert", help="TLS certificate (PEM) -- serve over HTTPS")
    ap.add_argument("--key", help="TLS private key (PEM)")
    ap.add_argument("--root", help="archive root (overrides $ARCHIVE_ROOT)")
    ap.add_argument("--lite", help="folder of smaller copies (overrides $LITE_ROOT)")
    args = ap.parse_args()

    global ARCHIVE_ROOT, LITE_ROOT
    if args.root:
        ARCHIVE_ROOT = os.path.abspath(args.root)
    if args.lite:
        LITE_ROOT = os.path.abspath(args.lite)
    if not os.path.isdir(ARCHIVE_ROOT):
        print(f"Archive root does not exist: {ARCHIVE_ROOT}", file=sys.stderr)
        return 1

    if not os.path.exists(INDEX_OUT or os.path.join(SITE_DIR, "index.json")):
        print("index.json is missing -- run:  python3 _site/build_index.py",
              file=sys.stderr)

    httpd = ArchiveServer((args.host, args.port), ArchiveHandler)

    scheme = "http"
    if args.cert:
        ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        ctx.load_cert_chain(args.cert, args.key or args.cert)
        httpd.ssl_context = ctx
        scheme = "https"

    url = f"{scheme}://{args.host}:{args.port}/"
    print(f"Χριστιανισμός - Επιστήμη")
    print(f"  archive : {ARCHIVE_ROOT}")
    print(f"  site    : {SITE_DIR}")
    if INDEX_OUT:
        print(f"  index   : {INDEX_OUT}")
    if LITE_ROOT:
        print(f"  lite    : {LITE_ROOT}")
    print(f"  playback: " + (f"{PLAY_KBPS} kbit/s after {PLAY_BURST // 1024} KB" if PLAY_KBPS
                             else "unpaced"))
    print(f"  saves   : " + (f"{SAVE_KBPS} kbit/s each" if SAVE_KBPS else "unpaced") +
          (f", {SAVE_SLOTS} at once" if SAVE_SLOTS else ""))
    print(f"  open    : {url}")
    if scheme == "http" and args.host not in ("127.0.0.1", "localhost", "::1"):
        print("  note    : install/offline need HTTPS on a non-localhost host"
              " -- pass --cert/--key")
    print("  Ctrl+C to stop")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")
    finally:
        httpd.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main() or 0)
