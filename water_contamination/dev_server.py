#!/usr/bin/env python3
"""Local preview server for the water contamination site.

index.html loads its CSS, JS, images and data from jsDelivr. This server
serves the files in this folder and, when it sends any HTML/JS/CSS file,
rewrites the jsDelivr prefix to "/" so the browser loads your local copies
instead. The files on disk are never modified.

Usage:  python3 dev_server.py [port]     (default port 8000)
Then open http://localhost:8000
"""
import http.server
import os
import sys

CDN_PREFIX = "https://cdn.jsdelivr.net/gh/ksuelflo/cwamn@v1.1/water_contamination/"
REWRITE_EXT = (".html", ".js", ".css")
ROOT = os.path.dirname(os.path.abspath(__file__))


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def end_headers(self):
        # Never cache, so a browser refresh always picks up your latest edits.
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def do_GET(self):
        path = self.translate_path(self.path)
        if os.path.isdir(path):
            path = os.path.join(path, "index.html")
        if path.endswith(REWRITE_EXT) and os.path.isfile(path):
            with open(path, "r", encoding="utf-8") as f:
                body = f.read().replace(CDN_PREFIX, "/").encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", self.guess_type(path))
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        else:
            super().do_GET()


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
    print(f"Serving {ROOT} at http://localhost:{port} (jsDelivr URLs -> local files)")
    http.server.ThreadingHTTPServer(("", port), Handler).serve_forever()
