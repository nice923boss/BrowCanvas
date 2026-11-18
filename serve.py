"""Static server for BrowCanvas.

Binds 0.0.0.0 so phones and tablets on the same Wi-Fi can open the app,
forces the MIME types ES modules need (Windows registry entries can turn
.js into text/plain), and opens the browser once the port is listening.
"""

import http.server
import os
import socket
import sys
import threading
import webbrowser

PORT = int(os.environ.get("BROWCANVAS_PORT", "8790"))
ROOT = os.path.dirname(os.path.abspath(__file__))
LOCAL_URL = f"http://localhost:{PORT}/"

MIME = {
    ".js": "text/javascript",
    ".mjs": "text/javascript",
    ".json": "application/json",
    ".css": "text/css",
    ".html": "text/html; charset=utf-8",
    ".svg": "image/svg+xml",
    ".jpg": "image/jpeg",
    ".png": "image/png",
    ".webp": "image/webp",
    ".wasm": "application/wasm",
}


class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map, **MIME}

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def end_headers(self):
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def log_message(self, fmt, *args):
        pass  # keep the console readable; errors still go to stderr via log_error


class Server(http.server.ThreadingHTTPServer):
    # On Windows SO_REUSEADDR lets a second server bind a busy port silently.
    allow_reuse_address = False


def lan_ip():
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("10.255.255.255", 1))  # no packet is sent for UDP connect
        return s.getsockname()[0]
    except OSError:
        return None
    finally:
        s.close()


def main():
    try:
        httpd = Server(("0.0.0.0", PORT), Handler)
    except OSError as err:
        print(f"埠 {PORT} 已被占用（{err}）。可能 BrowCanvas 已在執行，直接開啟瀏覽器。")
        webbrowser.open(LOCAL_URL)
        return 1

    ip = lan_ip()
    print("BrowCanvas 眉型設計")
    print(f"  這台電腦：{LOCAL_URL}")
    if ip:
        print(f"  同一個 Wi-Fi 的手機／平板：http://{ip}:{PORT}/")
        print("  （區網網址不是 HTTPS，相機拍照無法使用，請改用「上傳照片」）")
    print("關閉這個視窗即停止伺服器。")
    threading.Timer(0.5, webbrowser.open, args=(LOCAL_URL,)).start()
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        httpd.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
