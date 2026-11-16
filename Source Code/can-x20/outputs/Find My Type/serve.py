#!/usr/bin/env python3
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from functools import partial
from pathlib import Path
import webbrowser, threading, subprocess, json, re, time
from urllib.parse import urlparse
FONT_CACHE = None
FONT_FILES = {}
FONT_LOCK = threading.Lock()
def font_catalog():
    global FONT_CACHE
    with FONT_LOCK:
        if FONT_CACHE is not None: return FONT_CACHE
        data = json.loads(subprocess.check_output(["/usr/sbin/system_profiler", "SPFontsDataType", "-json"], timeout=120))
        faces = []
        for item in data.get("SPFontsDataType", []):
            path = Path(item.get("path", ""))
            if not path.is_file() or item.get("enabled") == "no": continue
            token = str(len(FONT_FILES))
            FONT_FILES[token] = path
            for face in item.get("typefaces", []):
                if face.get("enabled") == "no" or not face.get("family"): continue
                if face["family"].startswith("."): continue
                faces.append({"family": face["family"], "style": face.get("style", "Regular"), "fullName": face.get("fullname", face["family"]), "postscriptName": face.get("_name", ""), "file": "/api/font/" + token, "extension": path.suffix.lower(), "installedAt": int(getattr(path.stat(), "st_birthtime", 0) * 1000)})
        FONT_CACHE = faces
        return faces
ROOT = Path(__file__).resolve().parent
PORT = 8765
class Handler(SimpleHTTPRequestHandler):
    def do_GET(self):
        route = urlparse(self.path).path
        if route.startswith("/api/"):
            if self.headers.get("Host", "") not in {f"127.0.0.1:{PORT}", f"localhost:{PORT}"} or self.headers.get("Sec-Fetch-Site") == "cross-site":
                self.send_error(403); return
            if route == "/api/local-fonts":
                try:
                    payload = json.dumps(font_catalog()).encode()
                except Exception as error:
                    self.send_error(500, "Could not read installed fonts"); return
                self.send_response(200); self.send_header("Content-Type", "application/json"); self.send_header("Content-Length", str(len(payload))); self.end_headers(); self.wfile.write(payload); return
            if route.startswith("/api/font/"):
                token = route.removeprefix("/api/font/") if hasattr(str, "removeprefix") else route[len("/api/font/"):]
                path = FONT_FILES.get(token)
                if path is None: self.send_error(404); return
                payload = path.read_bytes()
                self.send_response(200); self.send_header("Content-Type", "application/octet-stream"); self.send_header("Content-Length", str(len(payload))); self.end_headers(); self.wfile.write(payload); return
            self.send_error(404); return
        super().do_GET()
    def end_headers(self):
        self.send_header("Permissions-Policy", "local-fonts=(self)")
        super().end_headers()
def open_app():
    url = f"http://127.0.0.1:{PORT}"
    chrome = Path("/Applications/Google Chrome.app")
    if chrome.exists():
        subprocess.run(["open", "-a", str(chrome), url], check=False)
    else:
        webbrowser.open(url)
try:
    server = ThreadingHTTPServer(("127.0.0.1", PORT), partial(Handler, directory=str(ROOT)))
except OSError as error:
    raise SystemExit(f"Could not start Find My Type: {error}. Close an existing Find My Type window/launcher or free port {PORT}.")
print(f"Find My Type is running locally at http://127.0.0.1:{PORT}")
print("Keep this terminal open. Press Control+C to stop Find My Type.")
threading.Timer(0.5, open_app).start()
try:
    server.serve_forever()
except KeyboardInterrupt:
    print("\nFind My Type stopped.")
finally:
    server.server_close()
