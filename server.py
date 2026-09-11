#!/usr/bin/env python3
"""AReader 内网服务（标准库 only）。

运行：
  python3 server.py --host 0.0.0.0 --port 8222 [--token xxx] （token是可选的）

其他设备：
  http://<IP>:8222/          查看输出列表
  http://<IP>:8222/api/logs  JSON

"""
import argparse
import json
import os
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

BASE = os.path.dirname(os.path.abspath(__file__))
STORE = os.path.join(BASE, "lan_logs.json")
MAX_LOGS = 200
TOKEN = ""


def load_logs():
    try:
        with open(STORE, "r", encoding="utf-8") as f:
            data = json.load(f)
            return data if isinstance(data, list) else []
    except Exception:
        return []


def save_logs(logs):
    try:
        with open(STORE, "w", encoding="utf-8") as f:
            json.dump(logs[-MAX_LOGS:], f, ensure_ascii=False, indent=2)
    except Exception as e:
        print("save failed:", e)


LOGS = load_logs()


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.end_headers()

    def do_GET(self):
        path = urlparse(self.path).path
        if path == "/api/logs":
            body = json.dumps(LOGS[-MAX_LOGS:], ensure_ascii=False).encode("utf-8")
            self.send_response(200)
            self._cors()
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        if path in ("/", "/index.html"):
            items = []
            for h in reversed(LOGS[-100:]):
                ts = time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(h.get("ts", 0) / 1000))
                txt = (h.get("text") or "").replace("&", "&amp;").replace("<", "&lt;")
                items.append(f"<div class=item><div class=ts>{ts} · {h.get('source','')}</div><div>{txt}</div></div>")
            html = ("<!DOCTYPE html><html lang=zh><head><meta charset=utf-8><title>AReader 输出</title>"
                    "<meta name=viewport content='width=device-width,initial-scale=1'>"
                    "<style>body{font-family:sans-serif;max-width:760px;margin:24px auto;padding:0 16px}"
                    ".item{border-bottom:1px solid #ddd;padding:12px 0;white-space:pre-wrap}.ts{color:#666;font-size:12px}</style>"
                    "<meta http-equiv=refresh content=10></head><body>"
                    f"<h2>AReader 输出（共 {len(LOGS)} 条）</h2>"
                    + ("".join(items) if items else "<p>无输出。</p>") + "</body></html>")
            body = html.encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        self.send_response(404)
        self.end_headers()

    def do_POST(self):
        path = urlparse(self.path).path
        if path != "/ingest":
            self.send_response(404)
            self.end_headers()
            return
        if TOKEN:
            auth = self.headers.get("Authorization", "")
            if auth != "Bearer " + TOKEN:
                self.send_response(401)
                self.end_headers()
                self.wfile.write(b"bad token")
                return
        try:
            length = int(self.headers.get("Content-Length", 0))
        except Exception:
            length = 0
        try:
            payload = json.loads(self.rfile.read(length).decode("utf-8") or "{}")
        except Exception:
            self.send_response(400)
            self.end_headers()
            return
        text = str(payload.get("text", ""))[:4000]
        if not text.strip():
            self.send_response(400)
            self.end_headers()
            return
        LOGS.append({"ts": payload.get("ts") or int(time.time() * 1000), "text": text, "source": payload.get("source", "areader")})
        del LOGS[:-MAX_LOGS]
        save_logs(LOGS)
        print(f"[{time.strftime('%H:%M:%S')}] +1 ({len(text)}字)")
        body = b'{"ok":true}'
        self.send_response(200)
        self._cors()
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--host", default="0.0.0.0")
    ap.add_argument("--port", type=int, default=8222)
    ap.add_argument("--token", default="")
    args = ap.parse_args()
    TOKEN = args.token or os.environ.get("AREADER_TOKEN", "")
    srv = ThreadingHTTPServer((args.host, args.port), Handler)
    print(f"AReader 服务已启动: http://{args.host}:{args.port}/")
    if TOKEN:
        print("启用 Token 鉴权")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
