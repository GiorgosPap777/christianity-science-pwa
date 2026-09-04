#!/usr/bin/env python3
"""Local static server for the Χριστιανισμός - Επιστήμη archive.

The document root is the archive root (this script's parent directory), so the
mp3 files are served straight from where they already live -- nothing is copied.

Unlike `python3 -m http.server`, this handles HTTP Range requests (206 Partial
Content), which is what lets the browser seek inside a part without first
downloading the whole file.

Usage:
    python3 _site/serve.py [--port 8080] [--host 127.0.0.1]
"""

import argparse
import os
import re
import shutil
import urllib.parse
import sys
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

SITE_DIR = os.path.dirname(os.path.abspath(__file__))
# In a container the audio is a separate mount, so the archive root is
# configurable; locally it defaults to the folder this script sits in.
ARCHIVE_ROOT = os.environ.get("ARCHIVE_ROOT") or os.path.dirname(SITE_DIR)
SITE_NAME = "_site"          # URL prefix -- kept fixed, sw.js depends on it

RANGE_RE = re.compile(r"^bytes=(\d*)-(\d*)$")
NO_CACHE_EXT = (".html", ".js", ".css", ".json", ".webmanifest")


class ArchiveHandler(SimpleHTTPRequestHandler):
    """Static handler with byte-range support and a redirect from / to the site."""

    # HTTP/1.1 keeps the connection alive between the many range requests an
    # <audio> element makes, and some browsers are stricter about 1.0 responses.
    # Every response below must therefore carry an accurate Content-Length.
    protocol_version = "HTTP/1.1"

    def __init__(self, *args, **kwargs):
        self._range = None  # (start, length) for the in-flight response
        super().__init__(*args, directory=ARCHIVE_ROOT, **kwargs)

    # -- routing ---------------------------------------------------------
    def do_GET(self):
        if self.path == "/favicon.ico":
            self.send_response(HTTPStatus.NO_CONTENT)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        if self.path in ("/", "/index.html"):
            self.send_response(HTTPStatus.MOVED_PERMANENTLY)
            self.send_header("Location", f"/{SITE_NAME}/")
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        super().do_GET()

    def translate_path(self, path):
        """Serve /_site/* from the bundled site, everything else from the
        archive. Locally these are the same tree; in a container they are two
        different mounts."""
        clean = urllib.parse.urlsplit(path).path
        prefix = "/" + SITE_NAME
        if clean == prefix or clean.startswith(prefix + "/"):
            saved, self.directory = self.directory, SITE_DIR
            try:
                return super().translate_path(clean[len(prefix):] or "/")
            finally:
                self.directory = saved
        return super().translate_path(path)

    # -- range-aware file serving ----------------------------------------
    def send_head(self):
        self._range = None
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
        except OSError:
            self.send_error(HTTPStatus.NOT_FOUND, "File not found")
            return None

        try:
            size = os.fstat(fh.fileno()).st_size
            first, last = m.group(1), m.group(2)

            if first == "":
                if last == "":
                    fh.close()
                    return super().send_head()
                # suffix form: bytes=-N  (final N bytes)
                length = min(int(last), size)
                start = size - length
                end = size - 1
            else:
                start = int(first)
                end = int(last) if last else size - 1
                end = min(end, size - 1)
                if start >= size or start > end:
                    fh.close()
                    self.send_response(HTTPStatus.REQUESTED_RANGE_NOT_SATISFIABLE)
                    self.send_header("Content-Range", f"bytes */{size}")
                    self.send_header("Content-Length", "0")
                    self.end_headers()
                    return None
                length = end - start + 1

            fh.seek(start)
            self._range = (start, length)

            self.send_response(HTTPStatus.PARTIAL_CONTENT)
            self.send_header("Content-Type", self.guess_type(path))
            self.send_header("Content-Length", str(length))
            self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
            self.send_header("Accept-Ranges", "bytes")
            self.send_header("Last-Modified", self.date_time_string(
                int(os.fstat(fh.fileno()).st_mtime)))
            self.end_headers()
            return fh
        except Exception:
            fh.close()
            raise

    def copyfile(self, source, outputfile):
        if self._range is None:
            try:
                return super().copyfile(source, outputfile)
            except (ConnectionResetError, BrokenPipeError, ConnectionAbortedError):
                return None
        _, remaining = self._range
        try:
            while remaining > 0:
                chunk = source.read(min(64 * 1024, remaining))
                if not chunk:
                    break
                outputfile.write(chunk)
                remaining -= len(chunk)
        except (ConnectionResetError, BrokenPipeError, ConnectionAbortedError):
            pass          # client seeked away or closed the tab

    # -- headers ---------------------------------------------------------
    def end_headers(self):
        if getattr(self, "_headers_buffer", None) is not None:
            if not self._has_header("accept-ranges"):
                self.send_header("Accept-Ranges", "bytes")
            if self.path.split("?", 1)[0].endswith("/sw.js"):
                self.send_header("Service-Worker-Allowed", "/")
            if not self._has_header("cache-control"):
                clean = self.path.split("?", 1)[0].lower()
                if clean.endswith(NO_CACHE_EXT) or clean.endswith("/"):
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
    def handle_error(self, *args):
        exc = sys.exc_info()[1]
        if isinstance(exc, (ConnectionResetError, BrokenPipeError, ConnectionAbortedError)):
            return
        super().handle_error(*args)

    def log_message(self, fmt, *args):
        msg = fmt % args
        if any((" %s " % c) in msg for c in (200, 204, 206, 301, 304)):
            return  # only surface problems
        sys.stderr.write("%s - %s\n" % (self.address_string(), msg))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8080)
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--cert", help="TLS certificate (PEM) -- serve over HTTPS")
    ap.add_argument("--key", help="TLS private key (PEM)")
    ap.add_argument("--root", help="archive root (overrides $ARCHIVE_ROOT)")
    args = ap.parse_args()

    global ARCHIVE_ROOT
    if args.root:
        ARCHIVE_ROOT = os.path.abspath(args.root)
    if not os.path.isdir(ARCHIVE_ROOT):
        print(f"Archive root does not exist: {ARCHIVE_ROOT}", file=sys.stderr)
        return 1

    if not os.path.exists(os.path.join(SITE_DIR, "index.json")):
        print("index.json is missing -- run:  python3 _site/build_index.py",
              file=sys.stderr)

    ThreadingHTTPServer.allow_reuse_address = True
    httpd = ThreadingHTTPServer((args.host, args.port), ArchiveHandler)

    scheme = "http"
    if args.cert:
        import ssl
        ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        ctx.load_cert_chain(args.cert, args.key or args.cert)
        httpd.socket = ctx.wrap_socket(httpd.socket, server_side=True)
        scheme = "https"

    url = f"{scheme}://{args.host}:{args.port}/"
    print(f"Χριστιανισμός - Επιστήμη")
    print(f"  archive : {ARCHIVE_ROOT}")
    print(f"  site    : {SITE_DIR}")
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
