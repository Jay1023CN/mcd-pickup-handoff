"""Mobile connector checks using synthetic orders and loopback transport only."""
import copy
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch
from urllib.error import HTTPError, URLError

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
sys.path.insert(0, str(Path(__file__).resolve().parent))
from live_handoff import HandoffError, HandoffService
from mobile_bridge import Bridge, Transport, InstanceLock, USER_AGENT, bridge_running, execute_job, publish_selection, prepare_connection, phone_url, write_private
from test_live_handoff import FakeGateway


class FakeTransport:
    def __init__(self, jobs=(), completion_failures=0):
        self.jobs = list(jobs)
        self.completion_failures = completion_failures
        self.calls = []

    def call(self, path, data):
        self.calls.append((path, copy.deepcopy(data)))
        if path == "/devices/complete":
            if self.completion_failures:
                self.completion_failures -= 1
                raise HandoffError("模拟连接暂时失败")
            return {"ok": True}
        if path == "/devices/poll":
            return {"job": self.jobs.pop(0) if self.jobs else None, "paired": True}
        raise AssertionError("Unexpected transport path")


class MobileJobTests(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.addCleanup(self.folder.cleanup)
        self.directory = Path(self.folder.name)
        self.gateway = FakeGateway()
        self.now = datetime(2026, 10, 9, 4, tzinfo=timezone.utc)
        self.service = HandoffService(self.directory / "handoffs", lambda: self.gateway, lambda: self.now)

    def job(self, action, args):
        return {"id": "synthetic-job", "action": action, "args": args}

    def selected(self):
        return execute_job(self.service, self.job("orders", {}))["orders"][0]["selection"]

    def create(self, include=True):
        return execute_job(self.service, self.job("create", {"selection": self.selected(), "include_pickup_code": include}))

    def assert_private_fields_absent(self, result):
        serialized = json.dumps(result, ensure_ascii=False)
        for value in ("SYNTHETIC_ORDER", "PRIVATE_PAYMENT", "PRIVATE_REMARK", "MCD_MCP_TOKEN", '"receipt"', '"signature"', '"binding"', '"orderId"'):
            self.assertNotIn(value, serialized)

    def test_orders_and_inspect_never_export_account_order_ids(self):
        listed = execute_job(self.service, self.job("orders", {}))
        self.assert_private_fields_absent(listed)
        view = execute_job(self.service, self.job("inspect", {"selection": listed["orders"][0]["selection"]}))
        self.assert_private_fields_absent(view)
        self.assertNotIn("SYNTHETIC_CODE", json.dumps(view))

    def test_create_exports_only_selected_card_and_record_reference(self):
        result = self.create()
        self.assertEqual(set(result), {"card", "record_id", "expires_at", "queried_at"})
        self.assertEqual(result["card"]["pickup_code"], "SYNTHETIC_CODE")
        self.assert_private_fields_absent(result)
        self.assertRegex(result["record_id"], r"^[a-f0-9]{32}$")
        self.assertEqual(result["queried_at"], result["card"]["retrieved_at"])

    def test_create_allows_hiding_code_and_requires_boolean_choice(self):
        self.assertEqual(self.create(False)["card"]["pickup_code"], "")
        for value in (1, "true", None, [], {}):
            with self.subTest(value=value), self.assertRaises(HandoffError):
                execute_job(self.service, self.job("create", {"selection": self.selected(), "include_pickup_code": value}))

    def test_unknown_actions_extra_args_and_arbitrary_order_are_rejected_before_queries(self):
        for job in (
            self.job("query-order", {"orderId": "arbitrary"}),
            self.job("coupon-use", {}),
            self.job("orders", {"token": "synthetic-token"}),
            self.job("create", {"selection": "x", "include_pickup_code": True, "pickup_code": "forged"}),
            self.job("refresh", {"orderId": "arbitrary"}),
            self.job("refresh", {"record_id": "a" * 32, "orderId": "arbitrary"}),
            {**self.job("orders", {}), "token": "synthetic-token"},
            {"id": "x", "action": "orders"},
            None,
        ):
            with self.subTest(job=job), self.assertRaises(HandoffError):
                execute_job(self.service, job)
        self.assertEqual(self.gateway.calls, [])

    def test_nonstring_actions_and_selectors_are_contract_errors(self):
        for action in ([], {}, None, 4):
            with self.subTest(action=action), self.assertRaises(HandoffError):
                execute_job(self.service, self.job(action, {}))
        for action in ("inspect", "create"):
            for selection in ([], {}, None, 1, ""):
                args = {"selection": selection}
                if action == "create":
                    args["include_pickup_code"] = True
                with self.subTest(action=action, selection=selection), self.assertRaises(HandoffError):
                    execute_job(self.service, self.job(action, args))
        self.assertEqual(self.gateway.calls, [])

    def test_refresh_queries_only_persisted_order_and_drops_receipt(self):
        result = self.create()
        self.gateway.calls.clear()
        refreshed = execute_job(self.service, self.job("refresh", {"record_id": result["record_id"]}))
        self.assertTrue(refreshed["verified"])
        self.assertEqual(set(refreshed), {"verified", "card", "queried_at", "notice"})
        self.assertIn(("query-order", {"orderId": "SYNTHETIC_ORDER"}), self.gateway.calls)
        self.assert_private_fields_absent(refreshed)

    def test_refresh_cannot_query_missing_records_or_paths(self):
        for value in ("../signing.key", "..\\signing.key", "/tmp/order", "a" * 32, "A" * 32, None, []):
            with self.subTest(record_id=value), self.assertRaises(HandoffError):
                execute_job(self.service, self.job("refresh", {"record_id": value}))
        self.assertEqual(self.gateway.calls, [])

    def test_load_receipt_rejects_modified_outer_record_without_query(self):
        result = self.create()
        path = self.service.directory / (result["record_id"] + ".json")
        envelope = json.loads(path.read_text(encoding="utf-8"))
        envelope["payload"]["binding"]["orderId"] = "another-order"
        path.write_text(json.dumps(envelope), encoding="utf-8")
        self.gateway.calls.clear()
        with self.assertRaises(HandoffError):
            self.service.load_receipt(result["record_id"])
        self.assertEqual(self.gateway.calls, [])

    def test_load_receipt_rejects_inner_receipt_changed_even_when_outer_seal_is_valid(self):
        result = self.create()
        path = self.service.directory / (result["record_id"] + ".json")
        payload = json.loads(path.read_text(encoding="utf-8"))["payload"]
        payload["receipt"]["payload"]["snapshot"]["pickup_code"] = "forged"
        path.write_text(json.dumps(self.service._sealed(payload)), encoding="utf-8")
        with self.assertRaises(HandoffError):
            self.service.load_receipt(result["record_id"])

    def test_load_receipt_rejects_other_record_identity(self):
        original = self.create()
        another = self.create()
        path = self.service.directory / (original["record_id"] + ".json")
        payload = json.loads(path.read_text(encoding="utf-8"))["payload"]
        payload["receipt"] = self.service.load_receipt(another["record_id"])
        path.write_text(json.dumps(self.service._sealed(payload)), encoding="utf-8")
        with self.assertRaises(HandoffError):
            self.service.load_receipt(original["record_id"])

    def test_expired_record_never_refreshes_official_order(self):
        result = self.create()
        self.now += timedelta(minutes=10)
        self.gateway.calls.clear()
        refreshed = execute_job(self.service, self.job("refresh", {"record_id": result["record_id"]}))
        self.assertFalse(refreshed["verified"])
        self.assertNotIn("card", refreshed)
        self.assertEqual(self.gateway.calls, [])

    def test_skill_publish_sends_one_selected_card_with_no_mcp_token_or_raw_receipt(self):
        config = self.directory / "device.json"
        write_private(config, {"site": "https://example.invalid", "device_id": "synthetic-device", "device_token": "SYNTHETIC_DEVICE_TOKEN"})
        transport = unittest.mock.Mock()
        transport.call.return_value = {"share": {"url": "https://example.invalid/take/test#access=synthetic-access"}}
        with patch("mobile_bridge.Transport", return_value=transport) as factory:
            result = publish_selection(self.service, self.selected(), config_path=config)
        factory.assert_called_once_with("https://example.invalid", "SYNTHETIC_DEVICE_TOKEN")
        path, payload = transport.call.call_args.args
        self.assertEqual(path, "/devices/share")
        self.assertEqual(set(payload), {"device_id", "card", "record_id", "expires_at", "queried_at"})
        self.assertEqual(payload["card"]["pickup_code"], "SYNTHETIC_CODE")
        self.assert_private_fields_absent(payload)
        self.assertNotIn("SYNTHETIC_DEVICE_TOKEN", json.dumps(payload))
        self.assertIn("url", result["share"])

    def test_skill_publish_does_not_upload_a_closed_order(self):
        config = self.directory / "device.json"
        write_private(config, {"site": "https://example.invalid", "device_id": "synthetic-device", "device_token": "SYNTHETIC_DEVICE_TOKEN"})
        self.gateway.detail["orderStatus"] = "订单已完成"
        with patch("mobile_bridge.Transport") as factory, self.assertRaises(HandoffError):
            publish_selection(self.service, self.selected(), config_path=config)
        factory.return_value.call.assert_not_called()

    def make_bridge(self, transport, service=None):
        bridge = Bridge(transport, "synthetic-device", service or self.service, self.directory / "bridge")
        self.addCleanup(lambda: bridge.executor.shutdown(wait=True))
        return bridge

    def test_outbox_retries_identical_completion_before_polling_new_job(self):
        transport = FakeTransport([self.job("orders", {})], completion_failures=1)
        bridge = self.make_bridge(transport)
        bridge.tick()
        bridge.future.result(timeout=3)
        expected = json.loads(bridge.pending.read_text(encoding="utf-8"))
        with self.assertRaises(HandoffError):
            bridge.tick()
        self.assertTrue(bridge.pending.exists())
        self.assertEqual([p for p, _ in transport.calls], ["/devices/poll", "/devices/complete"])
        bridge.tick()
        completions = [data for path, data in transport.calls if path == "/devices/complete"]
        self.assertEqual(completions, [expected, expected])
        self.assertFalse(bridge.pending.exists())
        self.assertEqual(transport.calls[-1][0], "/devices/poll")

    def test_pending_outbox_survives_restart(self):
        bridge = self.make_bridge(FakeTransport())
        completion = {"device_id": "synthetic-device", "job_id": "old-job", "result": {"verified": False}}
        write_private(bridge.pending, completion)
        bridge.tick()
        self.assertEqual(bridge.transport.calls[0], ("/devices/complete", completion))
        self.assertFalse(bridge.pending.exists())

    def test_foreign_device_outbox_is_not_uploaded_or_removed(self):
        transport = FakeTransport()
        bridge = self.make_bridge(transport)
        write_private(bridge.pending, {"device_id": "another-device", "job_id": "x"})
        with self.assertRaises(HandoffError):
            bridge.tick()
        self.assertTrue(bridge.pending.exists())
        self.assertEqual(transport.calls, [])

    def test_queries_are_not_run_in_parallel(self):
        entered, release = threading.Event(), threading.Event()
        calls = []

        class BlockingService:
            def list_orders(self):
                calls.append("query")
                entered.set()
                if not release.wait(3):
                    raise AssertionError("Synthetic query timed out")
                return {"orders": []}

        bridge = self.make_bridge(FakeTransport([self.job("orders", {}), self.job("orders", {})]), BlockingService())
        self.addCleanup(release.set)
        bridge.tick()
        self.assertTrue(entered.wait(2))
        original_future = bridge.future
        try:
            bridge.tick()
        except HandoffError:
            pass
        self.assertIs(bridge.future, original_future)
        self.assertEqual(calls, ["query"])
        release.set()
        bridge.future.result(timeout=3)

    def test_network_and_unexpected_errors_never_export_credentials(self):
        secret = "SYNTHETIC_NETWORK_SECRET"
        for error in (URLError("https://user:" + secret + "@example.invalid"), HTTPError("https://example.invalid/" + secret, 500, secret, {}, None), TimeoutError(secret), RuntimeError(secret)):
            class FailingService:
                def list_orders(self):
                    raise error

            bridge = self.make_bridge(FakeTransport(), FailingService())
            bridge._work(self.job("orders", {}))
            completion = json.loads(bridge.pending.read_text(encoding="utf-8"))
            self.assertIn("error", completion)
            self.assertNotIn("result", completion)
            self.assertNotIn(secret, json.dumps(completion))


class TransportTests(unittest.TestCase):
    def test_transport_identifies_product_to_the_public_gateway(self):
        transport = Transport("https://example.invalid")
        with patch.object(transport.opener, "open") as opened:
            opened.return_value.__enter__.return_value.read.return_value = b'{"paired": true, "job": null}'
            transport.call("/devices/poll", {"device_id": "synthetic-device"})
        request = opened.call_args.args[0]
        self.assertEqual(request.get_header("User-agent"), USER_AGENT)
        self.assertIn("MCDPickupConnector/0.4", request.get_header("User-agent"))

    def test_only_https_homepages_or_explicit_loopback_test_urls_are_accepted(self):
        self.assertEqual(Transport("https://example.invalid/").site, "https://example.invalid")
        self.assertEqual(Transport("http://127.0.0.1:8765", allow_local=True).site, "http://127.0.0.1:8765")
        for site in ("http://example.invalid", "http://127.0.0.1", "file:///tmp/site", "https://user:password@example.invalid", "https://example.invalid/path", "https://example.invalid?token=x", "https://example.invalid#fragment", "//example.invalid", "https://"):
            with self.subTest(site=site), self.assertRaises(HandoffError):
                Transport(site)
        with self.assertRaises(HandoffError):
            Transport("http://example.invalid", allow_local=True)

    def test_paths_cannot_escape_api_prefix(self):
        transport = Transport("https://example.invalid")
        for path in ("//elsewhere", "/../secret", "/devices/poll?token=x", "https://evil.invalid", "/devices/%2e%2e"):
            with self.subTest(path=path), patch.object(transport.opener, "open") as request:
                request.return_value.__enter__.return_value.read.return_value = b'{}'
                with self.assertRaises(HandoffError):
                    transport.call(path, {})
                request.assert_not_called()

    def test_transport_errors_do_not_contain_network_secrets(self):
        transport = Transport("https://example.invalid", "SYNTHETIC_DEVICE_TOKEN")
        for error in (URLError("https://SYNTHETIC_DEVICE_TOKEN@example.invalid"), HTTPError("https://example.invalid", 403, "SYNTHETIC_DEVICE_TOKEN", {}, None)):
            with patch.object(transport.opener, "open", side_effect=error), self.assertRaises(HandoffError) as result:
                transport.call("/devices/poll", {"device_id": "test"})
            self.assertNotIn("SYNTHETIC_DEVICE_TOKEN", str(result.exception))

    def test_transport_rejects_invalid_and_oversized_responses_without_echoing_them(self):
        transport = Transport("https://example.invalid", "SYNTHETIC_DEVICE_TOKEN")
        for raw in (b'not JSON: SYNTHETIC_DEVICE_TOKEN', b'[]', b'null', b'x' * 1048577):
            with self.subTest(size=len(raw)), patch.object(transport.opener, "open") as opened:
                response = opened.return_value.__enter__.return_value
                response.read.return_value = raw
                with self.assertRaises(HandoffError) as result:
                    transport.call("/devices/poll", {"device_id": "test"})
                self.assertNotIn("SYNTHETIC_DEVICE_TOKEN", str(result.exception))
                response.read.assert_called_once_with(1048577)

    def test_redirect_cannot_forward_device_authorization_to_another_origin(self):
        received = []

        class Receiver(BaseHTTPRequestHandler):
            def do_GET(self):
                received.append(self.headers.get("Authorization"))
                self.send_response(200)
                self.end_headers()
                self.wfile.write(b'{"job": null}')

            def log_message(self, *args):
                pass

        receiver = ThreadingHTTPServer(("127.0.0.1", 0), Receiver)
        target = "http://127.0.0.1:" + str(receiver.server_port) + "/other-origin"

        class Redirect(BaseHTTPRequestHandler):
            def do_POST(self):
                self.rfile.read(int(self.headers.get("Content-Length", "0")))
                self.send_response(302)
                self.send_header("Location", target)
                self.end_headers()

            def log_message(self, *args):
                pass

        redirect = ThreadingHTTPServer(("127.0.0.1", 0), Redirect)
        servers = [receiver, redirect]
        threads = [threading.Thread(target=server.serve_forever, daemon=True) for server in servers]
        for thread in threads:
            thread.start()
        try:
            transport = Transport("http://127.0.0.1:" + str(redirect.server_port), "SYNTHETIC_DEVICE_TOKEN", allow_local=True)
            with self.assertRaises(HandoffError):
                transport.call("/devices/poll", {"device_id": "test"})
            self.assertEqual(received, [], "Device authorization reached a different origin")
        finally:
            for server in servers:
                server.shutdown()
                server.server_close()
            for thread in threads:
                thread.join(timeout=2)


class PairingTests(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.addCleanup(self.folder.cleanup)
        self.directory = Path(self.folder.name)
        self.old = {"site": "https://example.invalid", "device_id": "synthetic-device", "device_token": "SYNTHETIC_DEVICE_TOKEN", "pair_code": "a" * 16, "expires_at": "2020-01-01T00:00:00Z"}

    def test_expired_unclaimed_code_is_renewed_without_resetting_owner(self):
        write_private(self.directory / "device.json", self.old)
        transport = unittest.mock.Mock(site=self.old["site"])
        transport.call.return_value = {"paired": False, "pair_code": "b" * 16, "expires_at": (datetime.now(timezone.utc) + timedelta(minutes=10)).isoformat()}
        config, _ = prepare_connection(self.old["site"], self.directory, pair=True, transport_factory=lambda _: transport)
        transport.call.assert_called_once_with("/devices/renew", {"device_id": "synthetic-device", "reset_owner": False})
        self.assertEqual(config["pair_code"], "b" * 16)
        self.assertEqual(config["device_token"], "SYNTHETIC_DEVICE_TOKEN")
        self.assertTrue(phone_url(config).endswith("/#pair=" + "b" * 16))

    def test_already_claimed_device_issues_phone_code_without_resetting_owner(self):
        write_private(self.directory / "device.json", self.old)
        transport = unittest.mock.Mock(site=self.old["site"])
        transport.call.return_value = {"paired": True, "pair_code": "d" * 16, "expires_at": (datetime.now(timezone.utc) + timedelta(minutes=10)).isoformat()}
        config, _ = prepare_connection(self.old["site"], self.directory, pair=True, transport_factory=lambda _: transport)
        self.assertTrue(config["paired"])
        self.assertEqual(config["pair_code"], "d" * 16)
        self.assertEqual(phone_url(config), "https://example.invalid/#pair=" + "d" * 16)
        self.assertFalse(transport.call.call_args.args[1]["reset_owner"])

    def test_adding_another_phone_rotates_only_temporary_code(self):
        write_private(self.directory / "device.json", {**self.old, "paired": True})
        transport = unittest.mock.Mock(site=self.old["site"])
        expiry = (datetime.now(timezone.utc) + timedelta(minutes=10)).isoformat()
        transport.call.side_effect = [{"paired": True, "pair_code": code * 16, "expires_at": expiry} for code in ("b", "c")]
        first, _ = prepare_connection(self.old["site"], self.directory, pair=True, transport_factory=lambda _: transport)
        second, _ = prepare_connection(self.old["site"], self.directory, pair=True, transport_factory=lambda _: transport)
        self.assertNotEqual(phone_url(first), phone_url(second))
        for config in (first, second):
            self.assertTrue(config["paired"])
            self.assertEqual(config["device_id"], self.old["device_id"])
            self.assertEqual(config["device_token"], self.old["device_token"])
        self.assertTrue(all(not call.args[1]["reset_owner"] for call in transport.call.call_args_list))

    def test_expired_or_invalid_phone_code_is_not_exposed_in_url(self):
        self.assertEqual(phone_url({**self.old, "paired": True}), "https://example.invalid/")
        with self.assertRaises(HandoffError):
            phone_url({**self.old, "pair_code": "SYNTHETIC_MCP_TOKEN"})

    def test_invalid_renew_reply_preserves_stored_pairing(self):
        write_private(self.directory / "device.json", self.old)
        for reply in ({"paired": True}, {"paired": True, "pair_code": "x" * 16, "expires_at": "bad"}, {"paired": True, "pair_code": "b" * 16, "expires_at": "bad"}):
            transport = unittest.mock.Mock(site=self.old["site"])
            transport.call.return_value = reply
            with self.subTest(reply=reply), self.assertRaises(HandoffError):
                prepare_connection(self.old["site"], self.directory, pair=True, transport_factory=lambda _: transport)
            self.assertEqual(json.loads((self.directory / "device.json").read_text(encoding="utf8")), self.old)

    def test_normal_restart_preserves_credentials_and_does_not_renew_or_reassign(self):
        write_private(self.directory / "device.json", self.old)
        transport = unittest.mock.Mock(site=self.old["site"])
        config, _ = prepare_connection(self.old["site"], self.directory, transport_factory=lambda _: transport)
        transport.call.assert_not_called()
        self.assertEqual(config, self.old)

    def test_failed_pair_retry_preserves_previous_private_configuration(self):
        write_private(self.directory / "device.json", self.old)
        transport = unittest.mock.Mock(site=self.old["site"])
        transport.call.side_effect = HandoffError("模拟网络失败")
        with self.assertRaises(HandoffError):
            prepare_connection(self.old["site"], self.directory, pair=True, transport_factory=lambda _: transport)
        self.assertEqual(json.loads((self.directory / "device.json").read_text(encoding="utf-8")), self.old)

    def test_explicit_reassignment_is_the_only_reset_owner_request(self):
        write_private(self.directory / "device.json", self.old)
        transport = unittest.mock.Mock(site=self.old["site"])
        transport.call.return_value = {"paired": False, "pair_code": "c" * 16, "expires_at": (datetime.now(timezone.utc) + timedelta(minutes=10)).isoformat()}
        config, _ = prepare_connection(self.old["site"], self.directory, reset_owner=True, transport_factory=lambda _: transport)
        self.assertTrue(transport.call.call_args.args[1]["reset_owner"])
        self.assertEqual(config["pair_code"], "c" * 16)

    def test_single_instance_lock_rejects_duplicate_and_releases_on_exit(self):
        self.assertFalse(bridge_running(self.directory))
        with InstanceLock(self.directory / "bridge.lock"):
            self.assertTrue(bridge_running(self.directory))
            with self.assertRaises(HandoffError):
                with InstanceLock(self.directory / "bridge.lock"):
                    self.fail("Duplicate bridge acquired the process lock")
        self.assertFalse(bridge_running(self.directory))


if __name__ == "__main__":
    unittest.main()
