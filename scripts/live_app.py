#!/usr/bin/env python3
"""Local order workbench. No MCP credential is ever sent to the browser."""
from __future__ import annotations

import argparse
import hmac
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import secrets
import threading
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import ProxyHandler, Request, build_opener
import webbrowser

from live_handoff import HandoffError, HandoffService

ROOT = Path(__file__).resolve().parents[1]


class AppServer(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, address, service):
        super().__init__(address, Handler)
        self.service = service
        self.access_key = secrets.token_urlsafe(32)
        self.operation_lock = threading.Lock()
        self.base_url = f"http://127.0.0.1:{self.server_port}"


class Handler(BaseHTTPRequestHandler):
    server: AppServer

    def log_message(self, format, *args):
        pass

    def _host_allowed(self):
        return self.headers.get("Host") == f"127.0.0.1:{self.server.server_port}"

    def _reply(self, status, value, mime="application/json; charset=utf-8"):
        raw = value.encode("utf-8") if isinstance(value, str) else json.dumps(value, ensure_ascii=False, allow_nan=False).encode("utf-8")
        self.send_response(status)
        for key, content in {"Content-Type": mime, "Content-Length": str(len(raw)), "Cache-Control": "no-store",
                             "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer", "X-Frame-Options": "DENY",
                             "Content-Security-Policy": "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src data:; frame-src 'self' blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'"}.items():
            self.send_header(key, content)
        self.end_headers()
        self.wfile.write(raw)

    def do_GET(self):
        if not self._host_allowed():
            return self._reply(403, {"error": "请使用启动入口打开本机工作台。"})
        if self.path == "/":
            return self._reply(200, (ROOT / "templates/workbench.html").read_text(encoding="utf-8"), "text/html; charset=utf-8")
        self._reply(404, {"error": "页面不存在。"})

    def do_POST(self):
        # Read the bounded request before replying. Closing a Windows socket
        # with an unread POST body can reset it before the client sees 401/403.
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if not 0 < length <= 131072 or self.headers.get("Transfer-Encoding"):
                return self._reply(413, {"error": "请求长度无效。"})
            self.connection.settimeout(5)
            raw_body = self.rfile.read(length)
            if len(raw_body) != length:
                return self._reply(400, {"error": "请求内容不完整。"})
        except (ValueError, TimeoutError, OSError):
            return self._reply(400, {"error": "请求内容无效或读取超时。"})
        if not self._host_allowed() or (self.headers.get("Origin") not in {None, self.server.base_url}):
            return self._reply(403, {"error": "请求来源无效。"})
        supplied = self.headers.get("X-Handoff-Key", "")
        if not hmac.compare_digest(supplied.encode("utf-8"), self.server.access_key.encode("utf-8")):
            return self._reply(401, {"error": "工作台会话已失效，请从启动入口重新打开。"})
        if self.headers.get("Content-Type", "").split(";", 1)[0] != "application/json":
            return self._reply(415, {"error": "请求必须使用 JSON。"})
        if not self.server.operation_lock.acquire(blocking=False):
            return self._reply(429, {"error": "已有查询正在进行，请稍候。"})
        try:
            body = json.loads(raw_body)
            contracts = {"/api/session": set(), "/api/orders": set(), "/api/inspect": {"selection"}, "/api/create": {"selection", "include_pickup_code"},
                         "/api/verify": {"receipt"}, "/api/card": {"receipt"}}
            if self.path not in contracts:
                return self._reply(404, {"error": "操作不存在。"})
            if not isinstance(body, dict) or set(body) != contracts[self.path]:
                raise HandoffError("请求字段无效；门店、状态和凭证只能由官方查询提供。")
            if "selection" in body and not isinstance(body["selection"], str):
                raise HandoffError("请从查询结果中选择订单。")
            service = self.server.service
            if self.path == "/api/session":
                result = {"application": "mcd-pickup-handoff", "version": "0.3.0"}
            elif self.path == "/api/orders":
                result = service.list_orders()
            elif self.path == "/api/inspect":
                result = service.inspect(body["selection"])
            elif self.path == "/api/create":
                result = service.create(body["selection"], body["include_pickup_code"])
            elif self.path == "/api/verify":
                result = service.verify(body["receipt"])
            else:
                result = {"html": service.card_html(body["receipt"]), "text": service.card_text(body["receipt"])}
            self._reply(200, result)
        except HandoffError as error:
            self._reply(422, {"error": str(error)})
        except HTTPError as error:
            self._reply(502, {"error": f"官方 MCP 返回 HTTP {error.code}，请检查凭据或稍后重试。"})
        except (URLError, TimeoutError):
            self._reply(502, {"error": "官方查询暂时不可用。未使用缓存或模拟结果替代。"})
        except (ValueError, TypeError, KeyError, OSError):
            self._reply(422, {"error": "配置、官方返回或本机记录无效，未生成交接卡。"})
        except Exception:
            self._reply(500, {"error": "本机工作台发生错误，本次结果未被确认。"})
        finally:
            self.server.operation_lock.release()


def existing_launch(port):
    try:
        runtime = json.loads((ROOT / "private/live-app.local.json").read_text(encoding="utf-8"))
        base = f"http://127.0.0.1:{port}"
        launch = runtime["launch_url"]
        if runtime["url"] != base or not launch.startswith(base + "/#key="):
            return None
        key = urlsplit(launch).fragment.removeprefix("key=")
        request = Request(base + "/api/session", data=b"{}", headers={"Content-Type": "application/json", "X-Handoff-Key": key})
        with build_opener(ProxyHandler({})).open(request, timeout=2) as response:
            value = json.loads(response.read(1024))
        if value == {"application": "mcd-pickup-handoff", "version": "0.3.0"}:
            return launch
    except (ValueError, KeyError, TypeError, OSError):
        pass
    return None


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--no-browser", action="store_true")
    args = parser.parse_args()
    launch = existing_launch(args.port)
    if launch:
        print("本机工作台已在运行。", flush=True)
        if not args.no_browser:
            webbrowser.open(launch)
        return
    try:
        service = HandoffService(ROOT / "private/handoffs")
        server = AppServer(("127.0.0.1", args.port), service)
    except (ValueError, OSError):
        parser.exit(2, "无法启动；检查本机端口和 private/ 目录。\n")
    launch = server.base_url + "/#key=" + server.access_key
    runtime = ROOT / "private/live-app.local.json"
    runtime.parent.mkdir(exist_ok=True)
    fd = os.open(runtime, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as stream:
        json.dump({"pid": os.getpid(), "url": server.base_url, "launch_url": launch}, stream)
    print("本机取餐交接工作台：" + server.base_url, flush=True)
    print("关闭窗口或按 Ctrl+C 停止。订单只在本机查询；此地址不能发给异地朋友。", flush=True)
    if not args.no_browser:
        webbrowser.open(launch)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
