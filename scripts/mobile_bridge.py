#!/usr/bin/env python3
"""Keep MCP credentials on this computer; serve scoped jobs from the phone site."""
from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import re
import secrets
import threading
import time
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit, quote
from urllib.request import HTTPRedirectHandler, Request, build_opener
import webbrowser

from live_handoff import HandoffError, HandoffService
from mcp_readonly import read_token

ROOT = Path(__file__).resolve().parents[1]
DIRECTORY = ROOT / "private/mobile"
DEFAULT_SITE = "https://mcd-pickup-handoff.epic-rain-2778.chatgpt.site"
USER_AGENT = "Mozilla/5.0 (compatible; MCDPickupConnector/0.4; +https://github.com/Jay1023CN/mcd-pickup-handoff)"


def write_private(path: Path, value: dict):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + "." + secrets.token_hex(4) + ".tmp")
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as stream:
        json.dump(value, stream, ensure_ascii=False, allow_nan=False)
    os.replace(temporary, path)


class Transport:
    def __init__(self, site: str, token="", *, allow_local=False):
        url = urlsplit(site)
        local = allow_local and url.scheme == "http" and url.hostname in {"127.0.0.1", "localhost"}
        if (url.scheme != "https" and not local) or not url.hostname or url.username or url.password or url.path not in {"", "/"} or url.query or url.fragment:
            raise HandoffError("连接地址必须是 HTTPS 网站首页。")
        self.site = site.rstrip("/")
        self.token = token
        self.opener = build_opener(NoRedirect())

    def call(self, path: str, data: dict):
        if path not in {"/devices/enroll", "/devices/renew", "/devices/poll", "/devices/complete", "/devices/share"}:
            raise HandoffError("连接操作无效。")
        headers = {"Content-Type": "application/json", "Accept": "application/json", "User-Agent": USER_AGENT}
        if self.token:
            headers["Authorization"] = "Bearer " + self.token
        request = Request(self.site + "/api/mobile" + path, data=json.dumps(data, allow_nan=False).encode(), headers=headers)
        try:
            with self.opener.open(request, timeout=20) as response:
                raw = response.read(1048577)
            if len(raw) > 1048576:
                raise HandoffError("网页返回过大，连接已停止。")
            result = json.loads(raw)
            if not isinstance(result, dict):
                raise HandoffError("网页连接返回格式无效。")
            return result
        except HTTPError as error:
            if error.code in {401, 403}:
                raise HandoffError("网页连接凭据失效，请重新配对。") from None
            raise HandoffError("网页暂时无法连接，请稍后重试。") from None
        except (URLError, TimeoutError, ValueError):
            raise HandoffError("网页连接未成功，请稍后重试。") from None


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, message, headers, newurl):
        # A device credential is authorized only for the configured Site.
        return None


class InstanceLock:
    """Cross-process lock released by the OS when the connector exits."""
    def __init__(self, path: Path):
        self.path, self.fd = path, None

    def __enter__(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.fd = os.open(self.path, os.O_RDWR | os.O_CREAT, 0o600)
        if os.fstat(self.fd).st_size == 0:
            os.write(self.fd, b"0")
        os.lseek(self.fd, 0, os.SEEK_SET)
        try:
            if os.name == "nt":
                import msvcrt
                msvcrt.locking(self.fd, msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(self.fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            os.close(self.fd)
            self.fd = None
            raise HandoffError("连接程序已在运行。") from None
        return self

    def __exit__(self, *args):
        if self.fd is not None:
            if os.name == "nt":
                import msvcrt
                os.lseek(self.fd, 0, os.SEEK_SET)
                msvcrt.locking(self.fd, msvcrt.LK_UNLCK, 1)
            else:
                import fcntl
                fcntl.flock(self.fd, fcntl.LOCK_UN)
            os.close(self.fd)
            self.fd = None


def bridge_running(directory: Path = DIRECTORY) -> bool:
    try:
        with InstanceLock(directory / "bridge.lock"):
            return False
    except HandoffError:
        return True


def prepare_connection(site: str, directory: Path = DIRECTORY, *, pair=False, reset_owner=False, transport_factory=Transport):
    """Add a phone to the same owner; detach it only for an explicit owner reset."""
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / "device.json"
    config = json.loads(path.read_text(encoding="utf-8")) if path.exists() else None
    transport = transport_factory(site)
    if config and config["site"] != transport.site:
        raise HandoffError("已有连接属于另一个网站，请保留配置并检查。")
    if config is None:
        config = {**transport.call("/devices/enroll", {}), "site": transport.site, "paired": False}
    else:
        transport.token = config["device_token"]
        if pair or reset_owner:
            result = transport.call("/devices/renew", {"device_id": config["device_id"], "reset_owner": reset_owner})
            if not isinstance(result.get("paired"), bool):
                raise HandoffError("网页配对状态格式无效。")
            config["paired"] = result["paired"]
            code, expires = result.get("pair_code"), result.get("expires_at")
            if not isinstance(code, str) or not re.fullmatch(r"[a-f0-9]{16}", code):
                raise HandoffError("网页配对码格式无效。")
            if not isinstance(expires, str):
                raise HandoffError("网页配对有效期格式无效。")
            try:
                deadline = datetime.fromisoformat(expires.replace("Z", "+00:00"))
            except ValueError:
                raise HandoffError("网页配对有效期格式无效。") from None
            if deadline.tzinfo is None or deadline <= datetime.now(timezone.utc):
                raise HandoffError("网页配对码已过期，请重试。")
            config.update(pair_code=code, expires_at=expires)
    transport.token = config["device_token"]
    write_private(path, config)
    return config, transport


def phone_url(config: dict) -> str:
    site = Transport(config["site"]).site
    code = config.get("pair_code")
    if not code:
        return site + "/"
    if not isinstance(code, str) or not re.fullmatch(r"[a-f0-9]{16}", code):
        raise HandoffError("网页配对码格式无效。")
    try:
        deadline = datetime.fromisoformat(config["expires_at"].replace("Z", "+00:00"))
    except (KeyError, ValueError, AttributeError):
        raise HandoffError("网页配对有效期格式无效。") from None
    if deadline.tzinfo is None or deadline <= datetime.now(timezone.utc):
        return site + "/"
    return site + "/#pair=" + quote(code, safe="")


def execute_job(service: HandoffService, job: dict) -> dict:
    if not isinstance(job, dict) or set(job) != {"id", "action", "args"} or not isinstance(job["id"], str):
        raise HandoffError("网页任务格式无效。")
    action, args = job["action"], job["args"]
    contracts = {"orders": set(), "inspect": {"selection"}, "create": {"selection", "include_pickup_code"}, "refresh": {"record_id"}}
    if not isinstance(action, str) or action not in contracts or not isinstance(args, dict) or set(args) != contracts[action]:
        raise HandoffError("网页任务字段无效。")
    if any(not isinstance(args[k], str) for k in {"selection", "record_id"}.intersection(args)):
        raise HandoffError("订单或交接记录标识无效。")
    if action == "orders":
        return service.list_orders()
    if action == "inspect":
        return service.inspect(args["selection"])
    if action == "create":
        result = service.create(args["selection"], args["include_pickup_code"])
        return {"card": result["card"], "record_id": result["receipt"]["payload"]["record_id"],
                "expires_at": result["expires_at"], "queried_at": result["card"]["retrieved_at"]}
    return {k: v for k, v in service.verify(service.load_receipt(args["record_id"])).items()
            if k in {"verified", "card", "queried_at", "notice"}}


def publish_selection(service: HandoffService, selection: str, include_code=True, config_path: Path | None = None) -> dict:
    """Skill entry: live-query a selected order and return a scoped phone link."""
    path = config_path if config_path is not None else DIRECTORY / "device.json"
    config = json.loads(path.read_text(encoding="utf-8"))
    transport = Transport(config["site"], config["device_token"])
    result = execute_job(service, {"id": "skill", "action": "create", "args": {"selection": selection, "include_pickup_code": include_code}})
    return transport.call("/devices/share", {"device_id": config["device_id"], **result})


class Bridge:
    def __init__(self, transport, device_id, service, directory):
        self.transport, self.device_id, self.service = transport, device_id, service
        self.directory = directory
        self.pending = directory / "completion.json"
        self.stop = threading.Event()
        self.executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="mcd-query")
        self.future = None

    def _work(self, job):
        completion = {"device_id": self.device_id, "job_id": job["id"]}
        try:
            completion["result"] = execute_job(self.service, job)
        except HandoffError as error:
            completion["error"] = str(error)
        except (HTTPError, URLError, TimeoutError):
            completion["error"] = "官方查询暂时不可用，请稍后重试。"
        except Exception:
            completion["error"] = "订单查询未完成，请重新查询。"
        write_private(self.pending, completion)

    def tick(self):
        if self.pending.exists() and (self.future is None or self.future.done()):
            completion = json.loads(self.pending.read_text(encoding="utf-8"))
            if completion.get("device_id") != self.device_id:
                raise HandoffError("待提交的任务不属于当前连接。")
            self.transport.call("/devices/complete", completion)
            self.pending.unlink()
            self.future = None
        data = self.transport.call("/devices/poll", {"device_id": self.device_id})
        job = data.get("job")
        if job is not None:
            if self.future is not None and not self.future.done():
                raise HandoffError("已有官方查询正在进行，未执行重复任务。")
            if not isinstance(job, dict) or not isinstance(job.get("id"), str):
                raise HandoffError("网页返回的任务无效。")
            self.future = self.executor.submit(self._work, job)
        if not isinstance(data.get("paired"), bool):
            raise HandoffError("网页配对状态格式无效。")
        write_private(self.directory / "status.json", {"pid": os.getpid(), "online": True, "paired": data["paired"], "checked_at": time.time()})

    def run(self):
        delay = 2
        try:
            while not self.stop.is_set() and not (self.directory / "stop.request").exists():
                try:
                    self.tick()
                    delay = 2
                except (HandoffError, OSError, ValueError):
                    write_private(self.directory / "status.json", {"pid": os.getpid(), "online": False, "checked_at": time.time()})
                    delay = min(30, delay * 2)
                self.stop.wait(delay)
        finally:
            self.executor.shutdown(wait=True)
            write_private(self.directory / "status.json", {"pid": os.getpid(), "online": False, "stopped": True, "checked_at": time.time()})


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--site", default=DEFAULT_SITE)
    parser.add_argument("--pair", action="store_true", help="open or renew device pairing")
    parser.add_argument("--no-browser", action="store_true")
    parser.add_argument("--once", action="store_true", help="single heartbeat for connection checks")
    args = parser.parse_args()
    if not read_token():
        parser.exit(2, "请在本机 .env 中配置 MCD_MCP_TOKEN。\n")
    DIRECTORY.mkdir(parents=True, exist_ok=True)
    try:
        with InstanceLock(DIRECTORY / "bridge.lock"):
            config, transport = prepare_connection(args.site, pair=args.pair)
            if not args.no_browser and (args.pair or not (DIRECTORY / "status.json").exists()):
                webbrowser.open(phone_url(config))
            (DIRECTORY / "stop.request").unlink(missing_ok=True)
            service = HandoffService(ROOT / "private/handoffs")
            bridge = Bridge(transport, config["device_id"], service, DIRECTORY)
            if args.once:
                try:
                    bridge.tick()
                    print("手机网页连接已核验。")
                finally:
                    bridge.executor.shutdown(wait=True)
            else:
                print("手机网页连接已启动；MCP Token 保留在本机。", flush=True)
                bridge.run()
    except KeyboardInterrupt:
        pass
    except (HandoffError, KeyError, ValueError, OSError):
        parser.exit(2, "手机网页连接未完成，请检查网络或重新配对。\n")


if __name__ == "__main__":
    main()
