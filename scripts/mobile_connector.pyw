"""Small Windows connector window. MCP credentials stay in this project directory."""
from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
import json
import os
from pathlib import Path
from queue import Empty, Queue
import re
import secrets
import subprocess
import sys
import time
import tkinter as tk
from tkinter import messagebox, ttk

from live_handoff import HandoffError
from mcp_readonly import read_token
from mobile_bridge import DEFAULT_SITE, DIRECTORY, ROOT, InstanceLock, Transport, bridge_running, phone_url, prepare_connection, write_private
from vendor.qrcodegen import QrCode


def pairing_qr_ppm(url: str, maximum=208) -> bytes:
    """Encode a scoped phone URL locally, including its four-module quiet zone."""
    # Reuse the bridge's URL contract rather than accepting MCP/device credentials.
    from urllib.parse import urlsplit
    value = urlsplit(url)
    code = value.fragment.removeprefix("pair=")
    if value.path != "/" or value.query or not value.fragment.startswith("pair=") or not re.fullmatch(r"[a-f0-9]{16}", code):
        raise HandoffError("手机配对链接格式无效。")
    Transport(value.scheme + "://" + value.netloc)
    qr = QrCode.encode_text(url, QrCode.Ecc.MEDIUM)
    size, border = qr.get_size(), 4
    scale = max(2, maximum // (size + border * 2))
    width = (size + border * 2) * scale
    rows = []
    for y in range(-border, size + border):
        row = b"".join((b"\x00\x00\x00" if qr.get_module(x, y) else b"\xff\xff\xff") * scale for x in range(-border, size + border))
        rows.extend([row] * scale)
    return f"P6\n{width} {width}\n255\n".encode("ascii") + b"".join(rows)


def save_token(value: str, env_file: Path = ROOT / ".env") -> None:
    """Replace only the token key; preserve unrelated local settings."""
    token = value.strip()
    if not token:
        return
    if not re.fullmatch(r"[A-Za-z0-9_~+./=-]{1,4096}", token):
        raise HandoffError("Token 含有空格或不支持的字符，请重新复制。")
    original = env_file.read_text(encoding="utf-8-sig") if env_file.exists() else ""
    lines, written = [], False
    for line in original.splitlines():
        if line.strip().partition("=")[0].strip() == "MCD_MCP_TOKEN":
            if not written:
                lines.append("MCD_MCP_TOKEN=" + token)
                written = True
        else:
            lines.append(line)
    if not written:
        lines.append("MCD_MCP_TOKEN=" + token)
    env_file.parent.mkdir(parents=True, exist_ok=True)
    temp = env_file.with_name(env_file.name + "." + secrets.token_hex(4) + ".tmp")
    fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="") as stream:
            stream.write("\n".join(lines) + "\n")
        os.replace(temp, env_file)
    finally:
        temp.unlink(missing_ok=True)


class ConnectorController:
    def __init__(self, root=ROOT, directory=DIRECTORY, *, launcher=subprocess.Popen, prepare=prepare_connection):
        self.root, self.directory = Path(root), Path(directory)
        self.launcher, self.prepare = launcher, prepare
        self.process = None

    def site(self):
        path = self.directory / "device.json"
        if path.exists():
            config = json.loads(path.read_text(encoding="utf-8"))
            return Transport(config["site"]).site
        return DEFAULT_SITE

    def configure(self, value):
        previous = read_token(self.root / ".env")
        if value.strip() and value.strip() != previous and (bridge_running(self.directory) or (self.process is not None and self.process.poll() is None)):
            raise HandoffError("请先停止连接，再更换麦当劳 Token。")
        save_token(value, self.root / ".env")
        if value.strip():
            os.environ["MCD_MCP_TOKEN"] = value.strip()
        if not read_token(self.root / ".env"):
            raise HandoffError("请先填写本机 MCP Token。")

    def start(self):
        if bridge_running(self.directory):
            return "连接程序正在运行。"
        if self.process is not None and self.process.poll() is None:
            return "连接程序正在启动。"
        self.configure("")
        self.directory.mkdir(parents=True, exist_ok=True)
        (self.directory / "stop.request").unlink(missing_ok=True)
        executable = Path(sys.executable)
        windowless = executable.with_name("pythonw.exe") if os.name == "nt" else executable
        if not windowless.is_file():
            raise HandoffError("没有找到 Python 图形运行程序，请检查 Python 安装。")
        command = [str(windowless), "-X", "utf8", str(self.root / "scripts/mobile_bridge.py"), "--site", self.site(), "--no-browser"]
        options = {"cwd": str(self.root), "stdin": subprocess.DEVNULL, "stdout": subprocess.DEVNULL, "stderr": subprocess.DEVNULL}
        if os.name == "nt":
            options["creationflags"] = subprocess.CREATE_NO_WINDOW
        self.process = self.launcher(command, **options)
        return "连接程序正在启动。"

    def stop(self):
        self.directory.mkdir(parents=True, exist_ok=True)
        write_private(self.directory / "stop.request", {"requested_at": time.time()})
        return "正在停止，当前查询结束后退出。"

    def open_phone(self):
        config, _ = self.prepare(self.site(), self.directory, pair=True)
        return self._pair_info(config, "手机扫码即可连接，也可以在首页输入临时码。不用注册或登录。")

    @staticmethod
    def _pair_info(config, notice):
        url = phone_url(config)
        if "#pair=" not in url:
            raise HandoffError("临时配对码已过期，请重新生成。")
        return {"notice": notice, "pair_code": config["pair_code"], "expires_at": config["expires_at"], "url": url}

    def re_pair(self):
        if bridge_running(self.directory) or (self.process is not None and self.process.poll() is None):
            raise HandoffError("请先停止连接，等当前查询结束后再重新配对。")
        config, _ = self.prepare(self.site(), self.directory, pair=True, reset_owner=True)
        pending = self.directory / "completion.json"
        if pending.exists():
            # Keep old-account outbox data locally instead of submitting it under a new pairing.
            pending.replace(pending.with_name("completion.before-repair." + secrets.token_hex(4) + ".json"))
        self.start()
        return self._pair_info(config, "原来的手机和交接链接已断开。用下面的新码连接手机。")

    def status(self):
        running = bridge_running(self.directory)
        path = self.directory / "status.json"
        try:
            status = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            status = {}
        fresh = isinstance(status.get("checked_at"), (float, int)) and time.time() - status["checked_at"] <= 45
        if not running:
            if self.process is not None and self.process.poll() is None:
                return "正在启动", "正在连接手机网页…"
            return "已停止", "点击启动连接，手机网页就可以查询订单。"
        if not fresh or not status.get("online"):
            return "连接重试中", "网络暂时不可用，连接程序会自动重试。"
        if status.get("paired"):
            return "在线 · 已配对", "手机网页可以查询订单、生成和复查交接卡。"
        return "在线 · 等待配对", "点击打开手机入口，把临时配对码填到手机网页。"


class ConnectorWindow:
    def __init__(self, window, controller=None):
        self.window, self.controller = window, controller or ConnectorController()
        self.events, self.executor = Queue(), ThreadPoolExecutor(max_workers=1, thread_name_prefix="connector-ui")
        self.busy, self.closed = False, False
        self.pair_info, self.pair_qr = None, None
        window.title("麦麦取餐交接官 · 电脑连接")
        window.geometry("800x725")
        window.minsize(730, 710)
        window.configure(bg="#f7f5ef")
        window.protocol("WM_DELETE_WINDOW", self.close)
        style = ttk.Style(window)
        style.configure("TFrame", background="#f7f5ef")
        style.configure("TLabel", background="#f7f5ef", font=("Microsoft YaHei UI", 10))
        style.configure("TButton", font=("Microsoft YaHei UI", 10), padding=(12, 8))
        frame = ttk.Frame(window, padding=25)
        frame.pack(fill="both", expand=True)
        header = ttk.Frame(frame)
        header.pack(fill="x")
        self.brand_icon = None
        logo = self.controller.root / "assets/brand/handoff-concept.png"
        if logo.is_file():
            original = tk.PhotoImage(file=str(logo))
            factor = max(1, (max(original.width(), original.height()) + 63) // 64)
            self.brand_icon = original.subsample(factor, factor)
            window.iconphoto(True, self.brand_icon)
            ttk.Label(header, image=self.brand_icon).pack(side="left", padx=(0, 12))
        ttk.Label(header, text="麦麦取餐交接官\n电脑连接", font=("Microsoft YaHei UI", 17, "bold")).pack(side="left", anchor="w")
        ttk.Label(frame, text="手机扫一次码，就能选订单、发链接。不用注册，Token 留在电脑上。", wraplength=725).pack(anchor="w", pady=(10, 22))
        self.status_text, self.detail_text = tk.StringVar(), tk.StringVar()
        ttk.Label(frame, textvariable=self.status_text, font=("Microsoft YaHei UI", 13, "bold")).pack(anchor="w")
        ttk.Label(frame, textvariable=self.detail_text, wraplength=475).pack(anchor="w", pady=(5, 18))
        ttk.Label(frame, text="本机 MCP Token").pack(anchor="w")
        self.token_entry = ttk.Entry(frame, show="●", font=("Microsoft YaHei UI", 10))
        self.token_entry.pack(fill="x", pady=(5, 3))
        configured = bool(read_token(self.controller.root / ".env"))
        self.saved_text = tk.StringVar(value="已在本机保存，留空继续使用。" if configured else "只保存到本机 .env，填一次即可。")
        ttk.Label(frame, textvariable=self.saved_text).pack(anchor="w")
        buttons = ttk.Frame(frame)
        buttons.pack(fill="x", pady=(20, 8))
        self.start_button = ttk.Button(buttons, text="启动连接", command=self.start)
        self.start_button.pack(side="left")
        self.open_button = ttk.Button(buttons, text="打开手机入口", command=self.open_phone)
        self.open_button.pack(side="left", padx=8)
        self.stop_button = ttk.Button(buttons, text="停止", command=lambda: self.work(self.controller.stop))
        self.stop_button.pack(side="left")
        self.pair_frame = ttk.Frame(frame)
        self.pair_frame.pack(fill="x", pady=(10, 0))
        self.qr_label = ttk.Label(self.pair_frame, text="点击打开手机入口\n生成手机配对二维码", anchor="center", width=24)
        self.qr_label.pack(side="left", padx=(0, 18))
        pair_details = ttk.Frame(self.pair_frame)
        pair_details.pack(side="left", fill="both", expand=True)
        ttk.Label(pair_details, text="手机扫码连接 · 或输入临时码").pack(anchor="w")
        self.pair_code_text = tk.StringVar(value="点击打开手机入口，生成临时码")
        self.pair_expiry_text = tk.StringVar(value="已有手机继续使用；新手机通过临时码加入。")
        code_row = ttk.Frame(pair_details)
        code_row.pack(fill="x", pady=(5, 3))
        self.pair_entry = ttk.Entry(code_row, textvariable=self.pair_code_text, state="readonly", font=("Consolas", 14))
        self.pair_entry.pack(side="left", fill="x", expand=True)
        self.copy_code_button = ttk.Button(code_row, text="复制临时码", command=lambda: self.copy_pair("pair_code"), state="disabled")
        self.copy_code_button.pack(side="left", padx=(8, 0))
        ttk.Label(pair_details, textvariable=self.pair_expiry_text, wraplength=485).pack(anchor="w", pady=(5, 0))
        self.pair_url_text = tk.StringVar()
        link_row = ttk.Frame(pair_details)
        link_row.pack(fill="x", pady=(7, 0))
        self.pair_url_entry = ttk.Entry(link_row, textvariable=self.pair_url_text, state="readonly")
        self.pair_url_entry.pack(side="left", fill="x", expand=True)
        self.copy_link_button = ttk.Button(link_row, text="复制配对链接", command=lambda: self.copy_pair("url"), state="disabled")
        self.copy_link_button.pack(side="left", padx=(8, 0))
        self.repair_button = ttk.Button(frame, text="断开原手机，重新配对", command=self.re_pair)
        self.repair_button.pack(anchor="w", pady=(15, 0))
        self.notice = tk.StringVar(value="关掉这个窗口后，连接会继续运行。不会自动开机启动。")
        ttk.Label(frame, textvariable=self.notice, wraplength=475).pack(anchor="w", pady=(12, 0))
        self.poll()

    def open_phone(self):
        if self.busy:
            return
        self.pair_info = None
        self.pair_qr = None
        self.qr_label.configure(image="", text="正在生成配对二维码…")
        self.pair_code_text.set("正在生成临时码…")
        self.pair_url_text.set("")
        self.work(self.controller.open_phone)

    def copy_pair(self, field):
        if not self.pair_info or self.busy or datetime.fromisoformat(self.pair_info["expires_at"].replace("Z", "+00:00")) <= datetime.now(timezone.utc):
            self.notice.set("临时码已过期，请点击打开手机入口重新生成。")
            return
        self.window.clipboard_clear()
        self.window.clipboard_append(self.pair_info[field])
        self.notice.set("临时码已复制，在手机首页输入即可。" if field == "pair_code" else "配对链接已复制，只发到你自己的手机。")

    def show_pair(self, info):
        self.pair_qr = tk.PhotoImage(master=self.window, data=pairing_qr_ppm(info["url"]), format="PPM")
        self.qr_label.configure(image=self.pair_qr, text="")
        self.pair_info = info
        self.pair_code_text.set(info["pair_code"])
        self.pair_url_text.set(info["url"])

    def work(self, callback):
        if self.busy:
            return
        self.busy = True
        for button in (self.start_button, self.open_button, self.stop_button, self.repair_button):
            button.configure(state="disabled")
        def run():
            try:
                self.events.put((True, callback()))
            except HandoffError as error:
                self.events.put((False, str(error)))
            except Exception:
                self.events.put((False, "操作未完成，请检查网络和本机配置后重试。"))
        self.executor.submit(run)

    def start(self):
        value = self.token_entry.get()
        try:
            self.controller.configure(value)
        except HandoffError as error:
            messagebox.showerror("连接未启动", str(error), parent=self.window)
            return
        self.token_entry.delete(0, "end")
        self.saved_text.set("已在本机保存，留空继续使用。")
        self.work(self.controller.start)

    def re_pair(self):
        if messagebox.askyesno("断开原手机", "原来的手机将无法再查询订单，已分享的交接链接也会撤销。\n\n如果只是加一部手机，点击“打开手机入口”即可。\n请先停止连接。确定断开并重新配对吗？", parent=self.window):
            self.work(self.controller.re_pair)

    def poll(self):
        if self.closed:
            return
        try:
            while True:
                ok, notice = self.events.get_nowait()
                if ok and isinstance(notice, dict):
                    self.show_pair(notice)
                    self.notice.set(notice["notice"])
                else:
                    self.notice.set(notice)
                self.busy = False
                for button in (self.start_button, self.open_button, self.stop_button, self.repair_button):
                    button.configure(state="normal")
                if not ok:
                    messagebox.showerror("连接操作未完成", notice, parent=self.window)
        except Empty:
            pass
        try:
            state, detail = self.controller.status()
            self.status_text.set(state)
            self.detail_text.set(detail)
        except (OSError, ValueError, HandoffError):
            self.status_text.set("状态暂时不可用")
        valid_pair = False
        if self.pair_info:
            remaining = max(0, int((datetime.fromisoformat(self.pair_info["expires_at"].replace("Z", "+00:00")) - datetime.now(timezone.utc)).total_seconds()))
            valid_pair = remaining > 0
            self.pair_expiry_text.set(f"临时码仅用一次，{remaining // 60:02d}:{remaining % 60:02d} 后过期。" if remaining else "临时码已过期，点击打开手机入口重新生成。")
            if not valid_pair:
                self.pair_qr = None
                self.qr_label.configure(image="", text="二维码已过期\n点击打开手机入口重新生成")
                self.pair_code_text.set("临时码已过期")
                self.pair_url_text.set("")
        for button in (self.copy_code_button, self.copy_link_button):
            button.configure(state="normal" if valid_pair and not self.busy else "disabled")
        self.window.after(750, self.poll)

    def close(self):
        self.closed = True
        self.executor.shutdown(wait=False)
        self.window.destroy()


def main():
    window = tk.Tk()
    try:
        with InstanceLock(DIRECTORY / "connector.lock"):
            ConnectorWindow(window)
            window.mainloop()
    except HandoffError:
        window.withdraw()
        messagebox.showinfo("麦麦取餐交接官", "电脑连接窗口已经打开，请查看任务栏。", parent=window)
        window.destroy()


if __name__ == "__main__":
    main()
