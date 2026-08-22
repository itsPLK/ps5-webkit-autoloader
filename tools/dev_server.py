#!/usr/bin/env python3
"""
Quick local dev server for the WebKit Autoloader frontend.

Serves frontend/autoloader/ the same way the PC host does for the PS5
browser: the autoloader HTML hardcodes /app/ paths (that is the cached
layout served by the ELF), so this server maps /app/* back to the base
directory. It also injects the real version/build-time values into the
[[VERSION_PLACEHOLDER]] / [[BUILD_TIME_PLACEHOLDER]] tokens so the page
looks exactly like a real build.

Usage:  make dev          (or python3 tools/dev_server.py [--port N])
"""
import argparse
import io
import os
import posixpath
import sys
import webbrowser
from email.utils import formatdate
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

VERSION_TOKEN = b"[[VERSION_PLACEHOLDER]]"
BUILD_TIME_TOKEN = b"[[BUILD_TIME_PLACEHOLDER]]"

DEFAULT_PORT = 8123


def get_version_info():
    try:
        from gen_version import get_version_info as _gvi

        return _gvi()
    except Exception:
        return {"full": "dev", "build_time": "dev"}


def make_handler(base_dir, version, build_time):
    def translate(rel):
        # The autoloader HTML hardcodes /app/ for the ELF cache structure.
        # Map /app/ back to the root so the standalone files resolve.
        if rel.startswith("/app/"):
            rel = rel[len("/app/"):]
        rel = posixpath.normpath(rel).lstrip("/")
        return rel

    class DevHandler(SimpleHTTPRequestHandler):
        def __init__(self, *args, **kwargs):
            super().__init__(*args, directory=base_dir, **kwargs)

        def translate_path(self, path):
            rel = translate(self.path.split("?", 1)[0].split("#", 1)[0])
            full = os.path.join(base_dir, *rel.split("/"))
            return os.path.abspath(full)

        def do_GET(self):
            rel = translate(self.path.split("?", 1)[0].split("#", 1)[0])
            full = os.path.abspath(os.path.join(base_dir, *rel.split("/")))
            if rel == "" or rel.endswith("/"):
                full = os.path.join(full, "index.html")
            if not (os.path.isfile(full) and full.startswith(os.path.abspath(base_dir) + os.sep)):
                self.send_error(404, "File not found")
                return
            with open(full, "rb") as f:
                data = f.read()
            # Resolve version/build-time placeholders in the HTML entry page
            # so the dev page mirrors a real build.
            if rel.endswith((".html", ".htm")) or rel == "index.html":
                data = data.replace(VERSION_TOKEN, version).replace(BUILD_TIME_TOKEN, build_time)
            if rel == "app.js":
                # Build-time exploit override (auto | umtx2 | poops | p2jb),
                # from the FORCE_EXPLOIT env — same token as the ELF/host builds.
                mode = os.environ.get("FORCE_EXPLOIT", "auto")
                data = data.replace(b"[[EXPLOIT_MODE]]", mode.encode("utf-8"))
            ctype = self.guess_type(full)
            self.send_response(200)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Last-Modified", formatdate(os.path.getmtime(full), usegmt=True))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(data)

    return DevHandler


def find_free_port(port):
    import socket

    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        try:
            s.bind(("127.0.0.1", port))
            return port
        except OSError:
            pass
    for candidate in range(port + 1, port + 100):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            try:
                s.bind(("127.0.0.1", candidate))
                return candidate
            except OSError:
                continue
    return port


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--port",
        type=int,
        default=DEFAULT_PORT,
        help=f"HTTP port to bind (default: {DEFAULT_PORT})",
    )
    parser.add_argument(
        "--no-open",
        action="store_true",
        help="Do not open the page in the default browser",
    )
    parser.add_argument(
        "--base",
        default=os.path.join(
            os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
            "frontend",
            "autoloader",
        ),
        help="Base frontend directory to serve",
    )
    args = parser.parse_args()

    base_dir = os.path.abspath(args.base)
    if not os.path.isdir(base_dir):
        print(f"Error: base directory not found: {base_dir}")
        sys.exit(1)

    port = find_free_port(args.port)
    info = get_version_info()
    handler = make_handler(base_dir, info["full"].encode("utf-8"), info["build_time"].encode("utf-8"))
    httpd = ThreadingHTTPServer(("127.0.0.1", port), handler)
    url = f"http://localhost:{port}/app/index.html"

    print(f"Serving {base_dir}")
    print(f"  -> {url}")
    if args.port != port:
        print(f"  (port {args.port} busy, using {port})")
    print("Press Ctrl+C to stop.")

    if not args.no_open:
        webbrowser.open(url)

    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")
        httpd.server_close()


if __name__ == "__main__":
    main()
