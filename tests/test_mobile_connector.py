"""Native connector window smoke checks and controller lifecycle tests."""
from datetime import datetime, timedelta, timezone
from importlib.machinery import SourceFileLoader
import importlib.util
import json
import os
from pathlib import Path
import sys
import tempfile
import time
import tkinter as tk
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from live_handoff import HandoffError
from mobile_bridge import InstanceLock, write_private

loader = SourceFileLoader("mobile_connector_gui", str(Path(__file__).resolve().parents[1] / "scripts/mobile_connector.pyw"))
spec = importlib.util.spec_from_loader(loader.name, loader)
gui = importlib.util.module_from_spec(spec)
loader.exec_module(gui)


class ConnectorTests(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.addCleanup(self.folder.cleanup)
        self.root = Path(self.folder.name)
        self.directory = self.root / "private/mobile"
        self.env = self.root / ".env"
        self.process = Mock()
        self.process.poll.return_value = None
        self.launcher = Mock(return_value=self.process)
        self.prepare = Mock()
        self.controller = gui.ConnectorController(self.root, self.directory, launcher=self.launcher, prepare=self.prepare)
        # Keep the test display, while isolating credentials and app settings.
        display = {key: os.environ[key] for key in ("DISPLAY", "XAUTHORITY") if key in os.environ}
        self.environment = patch.dict(os.environ, display, clear=True)
        self.environment.start()
        self.addCleanup(self.environment.stop)

    def test_token_save_preserves_unrelated_settings_and_blank_reuses_existing(self):
        self.env.write_text("# local settings\nOTHER=keep\nMCD_MCP_TOKEN=OLD_TEST_TOKEN\n", encoding="utf-8")
        self.controller.configure("")
        self.assertIn("OLD_TEST_TOKEN", self.env.read_text(encoding="utf-8"))
        self.controller.configure("NEW_TEST_TOKEN")
        value = self.env.read_text(encoding="utf-8")
        self.assertIn("# local settings\nOTHER=keep\n", value)
        self.assertIn("MCD_MCP_TOKEN=NEW_TEST_TOKEN", value)
        self.assertNotIn("OLD_TEST_TOKEN", value)
        self.assertEqual(os.environ["MCD_MCP_TOKEN"], "NEW_TEST_TOKEN")
        for invalid in ("TOKEN\nOTHER=injected", "TOKEN with space", "$(bad)"):
            with self.assertRaises(HandoffError):
                self.controller.configure(invalid)
        self.assertEqual(self.env.read_text(encoding="utf-8"), value)

    def test_start_uses_windowless_python_and_never_passes_token_on_commandline(self):
        self.controller.configure("SYNTHETIC_MCP_TOKEN")
        self.controller.start()
        command = self.launcher.call_args.args[0]
        self.assertTrue(command[0].endswith("pythonw.exe") if os.name == "nt" else command[0] == sys.executable)
        self.assertIn("--no-browser", command)
        self.assertNotIn("SYNTHETIC_MCP_TOKEN", json.dumps(command))
        self.assertEqual(self.launcher.call_args.kwargs["stdout"], gui.subprocess.DEVNULL)
        self.controller.start()
        self.launcher.assert_called_once()

    def test_existing_bridge_is_reused_without_spawning_duplicate(self):
        with InstanceLock(self.directory / "bridge.lock"):
            self.assertEqual(self.controller.start(), "连接程序正在运行。")
            self.launcher.assert_not_called()

    def test_frozen_start_reuses_exe_as_independent_hidden_bridge_without_python(self):
        self.controller.configure("SYNTHETIC_MCP_TOKEN")
        executable = self.root / "McdPickupHandoff.exe"
        executable.touch()
        with patch.object(gui.sys, "frozen", True, create=True), patch.object(gui.sys, "executable", str(executable)):
            self.controller.start()
        command = self.launcher.call_args.args[0]
        self.assertEqual(command[:2], [str(executable), "--bridge"])
        self.assertNotIn("-X", command)
        self.assertFalse(any(part.endswith(".py") for part in command))
        self.assertIn("--no-browser", command)
        options = self.launcher.call_args.kwargs
        self.assertEqual(options["env"]["PYINSTALLER_RESET_ENVIRONMENT"], "1")
        self.assertEqual(options["cwd"], str(self.root))
        if os.name == "nt":
            self.assertEqual(options["creationflags"], gui.subprocess.CREATE_NO_WINDOW)
        self.assertNotIn("SYNTHETIC_MCP_TOKEN", json.dumps(command))

    def test_stop_is_graceful_and_preserves_private_records(self):
        write_private(self.directory / "completion.json", {"test": "keep"})
        self.controller.stop()
        self.assertTrue((self.directory / "stop.request").is_file())
        self.assertTrue((self.directory / "completion.json").is_file())
        self.process.terminate.assert_not_called()

    def test_open_phone_renews_pair_without_reset_and_does_not_disclose_mcp_token(self):
        config = {"site": "https://example.invalid", "paired": True, "pair_code": "a" * 16, "expires_at": (datetime.now(timezone.utc) + timedelta(minutes=10)).isoformat(), "device_token": "SYNTHETIC_DEVICE_TOKEN"}
        self.prepare.return_value = (config, Mock())
        with patch("webbrowser.open") as opened:
            info = self.controller.open_phone()
        self.assertEqual(self.prepare.call_args.kwargs, {"pair": True})
        opened.assert_not_called()
        self.assertEqual(info["url"], "https://example.invalid/#pair=" + "a" * 16)
        self.assertEqual(info["pair_code"], "a" * 16)
        self.assertIn("不用注册或登录", info["notice"])
        self.assertNotIn("SYNTHETIC_DEVICE_TOKEN", json.dumps(info))

    def test_repair_requires_stopped_bridge_and_preserves_old_outbox(self):
        with InstanceLock(self.directory / "bridge.lock"), self.assertRaises(HandoffError):
            self.controller.re_pair()
        self.prepare.assert_not_called()
        write_private(self.directory / "completion.json", {"old": "keep"})
        self.controller.configure("SYNTHETIC_MCP_TOKEN")
        self.prepare.return_value = ({"site": "https://example.invalid", "paired": False, "pair_code": "b" * 16, "expires_at": (datetime.now(timezone.utc) + timedelta(minutes=10)).isoformat()}, Mock())
        with patch("webbrowser.open") as opened:
            info = self.controller.re_pair()
        opened.assert_not_called()
        self.assertEqual(info["pair_code"], "b" * 16)
        self.assertTrue(self.prepare.call_args.kwargs["reset_owner"])
        self.assertFalse((self.directory / "completion.json").exists())
        saved = list(self.directory.glob("completion.before-repair.*.json"))
        self.assertEqual(len(saved), 1)
        self.assertEqual(json.loads(saved[0].read_text(encoding="utf-8")), {"old": "keep"})

    def test_running_bridge_requires_stop_before_token_change(self):
        self.controller.configure("SYNTHETIC_OLD_TOKEN")
        with InstanceLock(self.directory / "bridge.lock"), self.assertRaises(HandoffError):
            self.controller.configure("SYNTHETIC_OTHER_TOKEN")
        self.assertIn("SYNTHETIC_OLD_TOKEN", self.env.read_text(encoding="utf8"))
        self.assertEqual(os.environ["MCD_MCP_TOKEN"], "SYNTHETIC_OLD_TOKEN")

    def test_expired_phone_information_is_not_returned(self):
        self.prepare.return_value = ({"site": "https://example.invalid", "paired": True, "pair_code": "a" * 16, "expires_at": "2020-01-01T00:00:00Z"}, Mock())
        with self.assertRaises(HandoffError):
            self.controller.open_phone()

    def test_pairing_qr_is_local_rgb_with_quiet_zone_for_the_exact_phone_url(self):
        url = "https://example.invalid/#pair=" + "b" * 16
        original = gui.QrCode.encode_text
        with patch.object(gui.QrCode, "encode_text", wraps=original) as encoded:
            raw = gui.pairing_qr_ppm(url)
        encoded.assert_called_once_with(url, gui.QrCode.Ecc.MEDIUM)
        magic, dimensions, maximum, pixels = raw.split(b"\n", 3)
        self.assertEqual((magic, maximum), (b"P6", b"255"))
        width, height = map(int, dimensions.split())
        self.assertEqual(width, height)
        self.assertLessEqual(width, 208)
        self.assertEqual(len(pixels), width * height * 3)
        self.assertEqual(pixels[:width * 3], b"\xff" * (width * 3))
        self.assertIn(b"\x00\x00\x00", pixels)
        self.assertEqual(gui.pairing_qr_ppm(url), raw)

    def test_pairing_qr_rejects_account_and_share_credentials(self):
        for url in ("https://example.invalid/#access=" + "a" * 64, "https://example.invalid/?token=SYNTHETIC_TOKEN", "https://example.invalid/#pair=SYNTHETIC_MCP_TOKEN", "http://example.invalid/#pair=" + "a" * 16):
            with self.subTest(kind=url.split("#")[0]), self.assertRaises(HandoffError):
                gui.pairing_qr_ppm(url)

    def test_live_pairing_status_and_process_exit_are_reflected(self):
        import time
        with InstanceLock(self.directory / "bridge.lock"):
            write_private(self.directory / "status.json", {"online": True, "paired": False, "checked_at": time.time()})
            self.assertEqual(self.controller.status()[0], "在线 · 等待配对")
            write_private(self.directory / "status.json", {"online": True, "paired": True, "checked_at": time.time()})
            self.assertEqual(self.controller.status()[0], "在线 · 已配对")
            write_private(self.directory / "status.json", {"online": True, "paired": True, "checked_at": time.time() - 100})
            self.assertEqual(self.controller.status()[0], "连接重试中")
        self.controller.process = self.process
        self.process.poll.return_value = 2
        self.assertEqual(self.controller.status()[0], "已停止")

    def test_native_tk_window_renders_without_showing_saved_token(self):
        self.controller.configure("SYNTHETIC_SAVED_TOKEN")
        source_logo = Path(__file__).resolve().parents[1] / "assets/brand/handoff-mark.png"
        self.assertTrue(source_logo.is_file())
        window = tk.Tk()
        window.withdraw()
        self.addCleanup(window.destroy)
        app = gui.ConnectorWindow(window, self.controller)
        self.addCleanup(lambda: app.executor.shutdown(wait=False))
        window.update_idletasks()
        self.assertEqual(app.token_entry.get(), "")
        self.assertEqual(app.token_entry.cget("show"), "●")
        self.assertIn("已在本机保存", app.saved_text.get())
        self.assertNotIn("SYNTHETIC_SAVED_TOKEN", app.saved_text.get())
        self.assertEqual(app.start_button.cget("text"), "启动连接")
        self.assertEqual(app.open_button.cget("text"), "打开手机入口")
        self.assertEqual(app.stop_button.cget("text"), "停止连接")
        self.assertEqual(app.repair_button.cget("text"), "断开原手机，重新配对")
        self.assertIsNotNone(app.brand_icon)
        self.assertEqual((app.brand_icon.width(), app.brand_icon.height()), (64, 64))
        info = {"pair_code": "c" * 16, "expires_at": (datetime.now(timezone.utc) + timedelta(minutes=10)).isoformat(), "url": "https://example.invalid/#pair=" + "c" * 16, "notice": "模拟手机配对"}
        app.events.put((True, info)); app.poll()
        self.assertEqual(app.pair_code_text.get(), "c" * 16)
        self.assertEqual(app.pair_url_text.get(), info["url"])
        self.assertIsNotNone(app.pair_qr)
        self.assertLessEqual(app.pair_qr.width(), 208)
        self.assertEqual(app.pair_qr.get(0, 0), (255, 255, 255))
        window.update_idletasks()
        self.assertLessEqual(window.winfo_reqheight(), 725)
        self.assertEqual(str(app.copy_code_button.cget("state")), "normal")
        app.copy_pair("pair_code")
        self.assertEqual(window.clipboard_get(), "c" * 16)
        app.copy_pair("url")
        self.assertEqual(window.clipboard_get(), info["url"])
        self.assertNotIn("SYNTHETIC_SAVED_TOKEN", app.pair_url_text.get())
        app.show_pair({**info, "expires_at": "2020-01-01T00:00:00Z"}); app.poll()
        self.assertEqual(app.pair_code_text.get(), "临时码已过期")
        self.assertEqual(app.pair_url_text.get(), "")
        self.assertIsNone(app.pair_qr)
        self.assertFalse(app.qr_label.cget("image"))
        self.assertEqual(str(app.copy_code_button.cget("state")), "disabled")
        app.closed = True

    def test_short_screen_keeps_all_controls_reachable_at_three_font_scales(self):
        # These are real Tk widgets/font rasterization. The OS display settings
        # stay unchanged; the logical work-area cases also stress DPI virtualization.
        for scale in (1, 1.25, 1.5):
            for area in ((0, 0, 1366, 728), (0, 0, int(1366 / scale), int(728 / scale))):
                with self.subTest(scale=scale, area=area), patch.object(gui, "work_area", return_value=area):
                    window = tk.Tk()
                    window.withdraw()
                    window.tk.call("tk", "scaling", 96 * scale / 72)
                    app = gui.ConnectorWindow(window, self.controller)
                    try:
                        info = {"pair_code": "c" * 16, "expires_at": (datetime.now(timezone.utc) + timedelta(minutes=10)).isoformat(), "url": "https://example.invalid/#pair=" + "c" * 16, "notice": "模拟手机配对"}
                        app.show_pair(info)
                        window.deiconify()
                        window.update()
                        self.assertLessEqual(window.winfo_width(), area[2] - 16)
                        self.assertLessEqual(window.winfo_height(), area[3] - 16)
                        self.assertLessEqual(window.minsize()[1], window.winfo_height())
                        if os.name == "nt":
                            import ctypes
                            from ctypes import wintypes
                            rect = wintypes.RECT()
                            hwnd = ctypes.windll.user32.GetAncestor(window.winfo_id(), 2)
                            ctypes.windll.user32.GetWindowRect(hwnd, ctypes.byref(rect))
                            self.assertGreaterEqual(rect.left, area[0])
                            self.assertGreaterEqual(rect.top, area[1])
                            self.assertLessEqual(rect.right, area[2])
                            self.assertLessEqual(rect.bottom, area[3])
                        viewport = app.canvas.winfo_height()
                        overflow = app.content.winfo_reqheight() > viewport
                        self.assertEqual(bool(app.scrollbar.winfo_ismapped()), overflow)
                        if scale == 1:
                            self.assertFalse(overflow)
                            self.assertLessEqual(app.content.winfo_reqheight(), viewport)
                        if overflow:
                            app.scroll_wheel(Mock(delta=-120))
                            window.update_idletasks()
                            self.assertGreater(app.canvas.yview()[0], 0)

                        def reveal(widget):
                            app.canvas.yview_moveto(0)
                            window.update_idletasks()
                            offset = widget.winfo_rooty() - app.content.winfo_rooty()
                            app.canvas.yview_moveto(max(0, (offset - 8) / app.content.winfo_height()))
                            window.update_idletasks()

                        def visible(widget):
                            self.assertGreaterEqual(widget.winfo_rooty(), app.canvas.winfo_rooty())
                            self.assertLessEqual(widget.winfo_rooty() + widget.winfo_height(), app.canvas.winfo_rooty() + viewport)
                            self.assertGreaterEqual(widget.winfo_rootx(), app.canvas.winfo_rootx())
                            self.assertLessEqual(widget.winfo_rootx() + widget.winfo_width(), app.canvas.winfo_rootx() + app.canvas.winfo_width())

                        reveal(app.start_button)
                        for button in (app.start_button, app.open_button, app.stop_button):
                            visible(button)
                        reveal(app.pair_frame)
                        for widget in (app.qr_label, app.copy_code_button, app.copy_link_button):
                            visible(widget)
                        app.canvas.yview_moveto(1)
                        window.update_idletasks()
                        visible(app.notice_label)
                        visible(app.repair_button)
                        self.assertIsNotNone(app.pair_qr)
                    finally:
                        app.closed = True
                        app.executor.shutdown(wait=False)
                        for timer in window.tk.call("after", "info"):
                            window.after_cancel(timer)
                        window.destroy()

    def test_native_pythonw_background_start_duplicate_and_graceful_exit(self):
        # A genuine hidden interpreter runs the Bridge loop against synthetic transport.
        # Files and process locks are confined to this test's temporary directory.
        scripts = self.root / "scripts"
        scripts.mkdir()
        source = Path(__file__).resolve().parents[1] / "scripts"
        wrapper = (
            "import sys\n"
            f"sys.path.insert(0, {str(source)!r})\n"
            "from pathlib import Path\n"
            "from mobile_bridge import Bridge, InstanceLock\n"
            f"directory = Path({str(self.directory)!r})\n"
            "class FakeTransport:\n"
            "    def call(self, path, data):\n"
            "        return {'paired': True, 'job': None}\n"
            "with InstanceLock(directory / 'bridge.lock'):\n"
            "    Bridge(FakeTransport(), 'synthetic-device', None, directory).run()\n"
        )
        (scripts / "mobile_bridge.py").write_text(wrapper, encoding="utf-8")
        self.controller.launcher = gui.subprocess.Popen
        self.controller.configure("SYNTHETIC_MCP_TOKEN")
        self.controller.start()
        process = self.controller.process
        self.addCleanup(lambda: process.kill() if process.poll() is None else None)
        deadline = time.monotonic() + 8
        while time.monotonic() < deadline and self.controller.status()[0] != "在线 · 已配对":
            if process.poll() is not None:
                self.fail("Hidden Python process exited before the first heartbeat")
            time.sleep(0.05)
        self.assertEqual(self.controller.status()[0], "在线 · 已配对")
        self.controller.start()
        self.assertIs(self.controller.process, process)
        self.controller.stop()
        self.assertEqual(process.wait(timeout=8), 0)
        self.assertEqual(self.controller.status()[0], "已停止")
        status = json.loads((self.directory / "status.json").read_text(encoding="utf-8"))
        self.assertTrue(status["stopped"])
        self.assertNotIn("SYNTHETIC_MCP_TOKEN", json.dumps(status))
