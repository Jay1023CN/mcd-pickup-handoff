import copy
import io
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from render_card import normalize, render
from mcp_readonly import Client, decode_sse, read_token

ROOT = Path(__file__).resolve().parents[1]


class CardTests(unittest.TestCase):
    def setUp(self):
        self.data = json.loads((ROOT / "examples/order.synthetic.json").read_text(encoding="utf-8"))

    def test_default_omits_credentials_and_original_private_fields(self):
        page, text = render(self.data)
        for value in ["DEMO-001", "NEVER-SHARE-ORDER-ID", "NEVER-SHARE-PHONE",
                      "NEVER-SHARE-PAYMENT-LINK", "NEVER-SHARE-HOME-ADDRESS"]:
            self.assertNotIn(value, page + text)
        self.assertIn("模拟订单", text)
        self.assertIn(self.data["source"]["retrieved_at"], text)

    def test_code_is_only_included_when_explicitly_requested(self):
        page, text = render(self.data, include_pickup_code=True)
        self.assertIn("DEMO-001", page)
        self.assertIn("DEMO-001", text)
        self.assertNotIn("NEVER-SHARE-PHONE", page + text)

    def test_missing_code_is_not_invented(self):
        del self.data["pickup_code"]
        _, text = render(self.data, include_pickup_code=True)
        self.assertIn("暂无取餐码", text)

    def test_residential_or_untyped_address_is_omitted(self):
        for kind in ["residential", None]:
            self.data["store"]["address_kind"] = kind
            self.data["store"]["address"] = "PRIVATE-HOME"
            page, text = render(self.data)
            self.assertNotIn("PRIVATE-HOME", page + text)

    def test_html_injection_is_escaped(self):
        attack = '</textarea><script>alert("pwn")</script>'
        self.data["store"]["name"] = attack
        self.data["items"][0]["name"] = attack
        self.data["pickup_code"] = attack
        page, _ = render(self.data, True)
        self.assertNotIn(attack, page)
        self.assertIn("&lt;script&gt;", page)
        self.assertEqual(page.count("<script>"), 1)

    def test_delivery_is_rejected(self):
        self.data["is_store_pickup"] = False
        with self.assertRaises(ValueError):
            render(self.data)

    def test_time_must_include_timezone(self):
        self.data["source"]["retrieved_at"] = "2026-10-09T17:30:00"
        with self.assertRaises(ValueError):
            render(self.data)

    def test_boolean_or_zero_quantities_are_rejected(self):
        for count in [True, 0, -1, "2"]:
            self.data["items"][0]["quantity"] = count
            with self.assertRaises(ValueError):
                render(self.data)

    def test_unknown_source_is_rejected(self):
        self.data["source"]["kind"] = "unknown"
        with self.assertRaises(ValueError):
            render(self.data)

    def test_status_is_literal_without_inferred_readiness(self):
        self.data["status_text"] = "已取消"
        _, text = render(self.data)
        self.assertIn("官方状态：已取消", text)
        self.assertNotIn("已备好", text)

    def test_empty_item_details_are_explicit(self):
        self.data["items"] = []
        _, text = render(self.data)
        self.assertIn("官方返回未提供餐品明细", text)


class MCPTests(unittest.TestCase):
    def test_environment_token_takes_precedence(self):
        with patch.dict("os.environ", {"MCD_MCP_TOKEN": "environment-test-token"}):
            self.assertEqual(read_token(ROOT / "missing-env-file"), "environment-test-token")

    def test_local_env_reads_only_token_and_does_not_execute_values(self):
        with tempfile.TemporaryDirectory() as directory, patch.dict("os.environ", {}, clear=True):
            path = Path(directory) / ".env"
            path.write_text('# 本地配置\nOTHER=$(never-run)\nMCD_MCP_TOKEN="local-test-token"\n', encoding="utf-8-sig")
            self.assertEqual(read_token(path), "local-test-token")

    def test_missing_or_unrelated_env_has_no_token(self):
        with tempfile.TemporaryDirectory() as directory, patch.dict("os.environ", {}, clear=True):
            path = Path(directory) / ".env"
            self.assertEqual(read_token(path), "")
            path.write_text('OTHER=value\n# MCD_MCP_TOKEN=ignored\n', encoding="utf-8")
            self.assertEqual(read_token(path), "")

    def test_write_tools_are_blocked_before_network(self):
        client = Client("synthetic-local-test-token")
        for name in ["create-order", "cancel-order", "auto-bind-coupons", "mall-create-order", "campaign-calendar", "available-coupons"]:
            with patch("mcp_readonly.urlopen") as network:
                with self.assertRaises(ValueError):
                    client.rpc("tools/call", {"name": name, "arguments": {}})
                network.assert_not_called()

    def test_empty_or_placeholder_token_is_rejected(self):
        for token in ["", "   ", "${MCD_MCP_TOKEN}"]:
            with self.assertRaises(ValueError):
                Client(token)

    def test_sse_skips_notifications_and_selects_matching_id(self):
        stream = io.BytesIO(b': keepalive\n\ndata: {"jsonrpc":"2.0","method":"notice"}\n\ndata: {"id":5,"result":{}}\n\ndata: {"id":6,"result":{"ok":true}}\n\n')
        self.assertEqual(decode_sse(stream, 6)["result"], {"ok": True})

    def test_sse_without_matching_response_is_rejected(self):
        with self.assertRaises(ValueError):
            decode_sse(io.BytesIO(b'data: {"id":1,"result":{}}\n\n'), 2)

    def test_pagination_and_read_tool_filter(self):
        client = Client("synthetic-local-test-token")
        pages = [{"tools": [{"name": "order-list"}, {"name": "create-order"}], "nextCursor": "next"},
                 {"tools": [{"name": "query-order"}]}]
        with patch.object(client, "rpc", side_effect=pages) as rpc:
            self.assertEqual([tool["name"] for tool in client.tools()], ["order-list", "query-order"])
            self.assertEqual(rpc.call_args.args[1], {"cursor": "next"})


if __name__ == "__main__":
    unittest.main()
