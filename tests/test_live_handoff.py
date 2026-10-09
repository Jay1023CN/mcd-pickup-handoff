import copy
from datetime import datetime, timedelta, timezone
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import unittest
from urllib.error import HTTPError
from urllib.request import Request, urlopen

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from live_handoff import HandoffError, HandoffService, business_data, official_snapshot
from live_app import AppServer


class FakeGateway:
    def __init__(self):
        self.rows = [{"orderId": "SYNTHETIC_ORDER", "orderType": "1", "beType": "1", "storeName": "模拟测试餐厅", "createTime": "2026-10-09 12:00:00", "orderStatus": "2"}]
        self.detail = {"orderId": "SYNTHETIC_ORDER", "storeName": "模拟测试餐厅", "storeAddress": "模拟餐厅地址", "takeWay": "外带", "orderStatus": "2",
                       "orderProductList": [{"productName": "模拟汉堡", "quantity": 1}], "pickupCode": "SYNTHETIC_CODE", "payId": "PRIVATE_PAYMENT", "remark": "PRIVATE_REMARK"}
        self.calls = []
        self.fail = False

    def call(self, tool, arguments):
        self.calls.append((tool, arguments))
        if self.fail:
            raise HandoffError("模拟官方接口故障")
        if tool == "order-list":
            return {"list": copy.deepcopy(self.rows)}
        if tool == "query-order":
            assert arguments == {"orderId": "SYNTHETIC_ORDER"}
            return copy.deepcopy(self.detail)
        if tool == "now-time-info":
            return {"utc": "2026-10-09T04:00:00Z"}
        raise AssertionError("Unreviewed tool")


class LiveTests(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.addCleanup(self.folder.cleanup)
        self.gateway = FakeGateway()
        self.now = datetime(2026, 10, 9, 4, tzinfo=timezone.utc)
        self.service = HandoffService(Path(self.folder.name), lambda: self.gateway, lambda: self.now)

    def select(self):
        return self.service.list_orders()["orders"][0]["selection"]

    def create(self, include=False):
        return self.service.create(self.select(), include)

    def test_candidates_do_not_expose_order_id_or_raw_payload(self):
        result = self.service.list_orders()
        self.assertNotIn("SYNTHETIC_ORDER", json.dumps(result))
        self.assertIn("server_time", result)
        self.assertEqual(self.gateway.calls[0][0], "order-list")

    def test_unknown_selection_never_queries_an_arbitrary_order(self):
        with self.assertRaises(HandoffError):
            self.service.inspect("forged-order-selection")
        self.assertEqual(self.gateway.calls, [])

    def test_expired_selection_must_refresh(self):
        selected = self.select()
        self.now += timedelta(minutes=10)
        count = len(self.gateway.calls)
        with self.assertRaises(HandoffError):
            self.service.inspect(selected)
        self.assertEqual(len(self.gateway.calls), count)

    def test_snapshot_whitelists_fields_and_code_is_opt_in(self):
        result = self.create()
        serialized = json.dumps(result, ensure_ascii=False)
        for value in ["SYNTHETIC_ORDER", "SYNTHETIC_CODE", "PRIVATE_PAYMENT", "PRIVATE_REMARK"]:
            self.assertNotIn(value, serialized)
        self.assertEqual(result["card"]["pickup_mode"], "外带")
        with_code = self.create(True)
        self.assertEqual(with_code["card"]["pickup_code"], "SYNTHETIC_CODE")

    def test_code_choice_requires_actual_boolean(self):
        for value in ["true", 1, None]:
            with self.assertRaises(HandoffError):
                self.service.create(self.select(), value)

    def test_default_handoff_includes_official_code_and_missing_code_stays_missing(self):
        result = self.service.create(self.select())
        self.assertEqual(result["card"]["pickup_code"], "SYNTHETIC_CODE")
        self.assertIn("SYNTHETIC_CODE", self.service.card_html(result["receipt"]))
        self.gateway.detail.pop("pickupCode")
        result = self.service.create(self.select())
        self.assertEqual(result["card"]["pickup_code"], "")
        self.assertIn("暂无取餐码", self.service.card_html(result["receipt"]))

    def test_completed_history_is_visible_but_cannot_create(self):
        self.gateway.detail["orderStatus"] = "订单已完成"
        selected = self.select()
        view = self.service.inspect(selected)
        self.assertFalse(view["can_handoff"])
        self.assertEqual(view["card"]["status_text"], "订单已完成")
        with self.assertRaises(HandoffError):
            self.service.create(selected, False)

    def test_unpaid_cancelled_and_unknown_states_cannot_create(self):
        for status in ["1", "7", "4", "未识别状态", "READY_FROM_USER"]:
            self.gateway.detail["orderStatus"] = status
            with self.assertRaises(HandoffError):
                self.create()

    def test_create_rechecks_after_inspection(self):
        selected = self.select()
        self.assertTrue(self.service.inspect(selected)["can_handoff"])
        self.gateway.detail["orderStatus"] = "订单已取消"
        with self.assertRaises(HandoffError):
            self.service.create(selected, False)

    def test_delivery_conflict_is_rejected(self):
        self.gateway.detail["deliveryInfo"] = {"addressDetail": "PRIVATE_HOME"}
        with self.assertRaises(HandoffError):
            self.create()
        del self.gateway.detail["deliveryInfo"]
        self.gateway.rows[0]["orderType"] = "2"
        with self.assertRaises(HandoffError):
            self.create()

    def test_binding_and_required_fields_are_checked(self):
        for key, value in [("orderId", "OTHER_ORDER"), ("storeName", "另一家门店"), ("takeWay", None), ("takeWay", "无法识别")]:
            original = self.gateway.detail[key]
            self.gateway.detail[key] = value
            with self.assertRaises(HandoffError):
                self.create()
            self.gateway.detail[key] = original

    def test_invalid_items_do_not_silently_disappear(self):
        for products in [[None], [{"productName": "模拟汉堡", "quantity": True}], "invalid"]:
            self.gateway.detail["orderProductList"] = products
            with self.assertRaises(HandoffError):
                self.create()

    def test_modified_receipt_is_rejected_before_network(self):
        receipt = self.create()["receipt"]
        receipt["payload"]["snapshot"]["store"]["name"] = "FORGED_STORE"
        count = len(self.gateway.calls)
        result = self.service.verify(receipt)
        self.assertFalse(result["verified"])
        self.assertEqual(result["reason"], "modified")
        self.assertEqual(len(self.gateway.calls), count)

    def test_modified_local_record_is_rejected(self):
        receipt = self.create()["receipt"]
        path = Path(self.folder.name) / (receipt["payload"]["record_id"] + ".json")
        envelope = json.loads(path.read_text(encoding="utf-8"))
        envelope["payload"]["binding"]["orderId"] = "FORGED_ORDER"
        path.write_text(json.dumps(envelope), encoding="utf-8")
        count = len(self.gateway.calls)
        self.assertEqual(self.service.verify(receipt)["reason"], "modified")
        self.assertEqual(len(self.gateway.calls), count)

    def test_verification_requeries_and_detects_changed_items(self):
        receipt = self.create()["receipt"]
        count = len(self.gateway.calls)
        self.assertTrue(self.service.verify(receipt)["verified"])
        self.assertGreater(len(self.gateway.calls), count)
        self.gateway.detail["orderProductList"][0]["quantity"] = 2
        result = self.service.verify(receipt)
        self.assertFalse(result["verified"])
        self.assertIn("items", result["changed_fields"])

    def test_completed_status_invalidates_old_handoff(self):
        receipt = self.create()["receipt"]
        self.gateway.detail["orderStatus"] = "订单已完成"
        result = self.service.verify(receipt)
        self.assertFalse(result["verified"])
        self.assertIn("status_text", result["changed_fields"])

    def test_expired_record_does_not_claim_current_verification(self):
        receipt = self.create()["receipt"]
        self.now += timedelta(minutes=10)
        count = len(self.gateway.calls)
        self.assertEqual(self.service.verify(receipt)["reason"], "expired")
        self.assertEqual(len(self.gateway.calls), count)
        with self.assertRaises(HandoffError):
            self.service.card_html(receipt)

    def test_network_failure_has_no_success_or_demo_fallback(self):
        receipt = self.create()["receipt"]
        self.gateway.fail = True
        with self.assertRaises(HandoffError):
            self.service.verify(receipt)

    def test_restart_retains_key_but_not_old_selections(self):
        selected = self.select()
        receipt = self.service.create(selected, False)["receipt"]
        new = HandoffService(Path(self.folder.name), lambda: self.gateway, lambda: self.now)
        self.assertTrue(new.verify(receipt)["verified"])
        with self.assertRaises(HandoffError):
            new.inspect(selected)

    def test_offline_mcp_claim_is_rejected_by_cli(self):
        root = Path(__file__).resolve().parents[1]
        data = json.loads((root / "examples/order.synthetic.json").read_text(encoding="utf-8"))
        data["source"]["kind"] = "mcp"
        path = Path(self.folder.name) / "fake.json"
        path.write_text(json.dumps(data), encoding="utf-8")
        output = Path(self.folder.name) / "forged-card"
        result = subprocess.run([sys.executable, str(root / "scripts/render_card.py"), str(path), "--output", str(output)], capture_output=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(output.with_suffix(".html").exists())

    def test_business_failure_and_ambiguous_content_are_rejected(self):
        for result in [{"isError": True}, {"structuredContent": {"success": False, "data": {}}},
                       {"structuredContent": {"data": {}}}, {"content": [{"type": "text", "text": "not-json"}]}]:
            with self.assertRaises(HandoffError):
                business_data(result)
        self.assertEqual(business_data({"content": [{"type": "text", "text": '{"success":true,"data":{"ok":true}}'}]}), {"ok": True})


class HTTPTests(unittest.TestCase):
    def setUp(self):
        LiveTests.setUp(self)
        self.server = AppServer(("127.0.0.1", 0), self.service)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.addCleanup(self.stop)

    def stop(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)

    def request(self, path, body, authenticated=True, extra=None):
        headers = {"Content-Type": "application/json"}
        if authenticated:
            headers["X-Handoff-Key"] = self.server.access_key
        headers.update(extra or {})
        request = Request(self.server.base_url + path, data=json.dumps(body).encode(), headers=headers)
        try:
            with urlopen(request, timeout=5) as response:
                return response.status, json.load(response)
        except HTTPError as response:
            return response.code, json.load(response)

    def test_http_rejects_unauthenticated_and_other_origins(self):
        self.assertEqual(self.request("/api/orders", {}, False)[0], 401)
        self.assertEqual(self.request("/api/orders", {}, extra={"Origin": "https://untrusted.example"})[0], 403)
        self.assertEqual(self.request("/api/orders", {}, extra={"Host": "untrusted.example"})[0], 403)
        self.assertEqual(self.gateway.calls, [])

    def test_http_complete_workflow_and_frontend_field_injection(self):
        status, rows = self.request("/api/orders", {})
        self.assertEqual(status, 200)
        selection = rows["orders"][0]["selection"]
        status, _ = self.request("/api/create", {"selection": selection, "include_pickup_code": False, "status_text": "2"})
        self.assertEqual(status, 422)
        status, result = self.request("/api/create", {"selection": selection, "include_pickup_code": False})
        self.assertEqual(status, 200)
        status, verified = self.request("/api/verify", {"receipt": result["receipt"]})
        self.assertEqual(status, 200)
        self.assertTrue(verified["verified"])
        status, card = self.request("/api/card", {"receipt": result["receipt"]})
        self.assertEqual(status, 200)
        self.assertIn("离线文件及截图无法验真", card["html"])
        self.assertNotIn("SYNTHETIC_CODE", card["html"])


if __name__ == "__main__":
    unittest.main()
