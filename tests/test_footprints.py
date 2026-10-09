"""Semantics and privacy checks for the read-only normalized-order engine."""

from copy import deepcopy
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("footprints", ROOT / "scripts" / "footprints.py")
footprints = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(footprints)


def record(identifier="private-order", **overrides):
    value = {"id": identifier, "created_at": "2026-10-09T12:00:00+08:00",
             "status": "completed", "store": {"id": "private-store", "name": "示例店", "city": "示例城"},
             "items": [{"name": "示例商品", "quantity": 1}], "paid_cents": 1999}
    value.update(overrides)
    return value


def payload(*orders):
    return {"source": {"kind": "synthetic", "tools": ["query-order", "order-list"],
                       "retrieved_at": "2026-10-09T12:00:00+08:00",
                       "coverage": {"complete": False, "description": "纯虚构部分记录"}},
            "year": 2026, "orders": list(orders)}


class FootprintsTests(unittest.TestCase):
    def test_money_is_integer_and_incomplete_is_explicit(self):
        unknown = record("unknown-money")
        del unknown["paid_cents"]
        result = footprints.build_summary(payload(record(), record("free", paid_cents=0), unknown))
        summary = result["summary"]
        self.assertEqual(summary["paid_cents_known"], 1999)
        self.assertEqual(summary["paid_orders_known"], 2)
        self.assertEqual(summary["paid_orders_unknown"], 1)
        self.assertEqual(result["monthly"][9]["paid_cents_known"], 1999)
        self.assertIn("missing_paid_amount", [w["code"] for w in result["warnings"]])

    def test_duplicates_removed_and_conflicts_rejected(self):
        order = record()
        result = footprints.build_summary(payload(order, deepcopy(order)))
        self.assertEqual(result["summary"]["completed_orders"], 1)
        conflict = deepcopy(order)
        conflict["paid_cents"] = 2000
        with self.assertRaisesRegex(footprints.InputError, "conflicting duplicate"):
            footprints.build_summary(payload(order, conflict))

    def test_only_completed_contributes_to_public_activity(self):
        result = footprints.build_summary(payload(record(), record("cancel", status="cancelled", paid_cents=90000),
                                                  record("pending", status="pending"),
                                                  record("unclear", status="unknown")))
        self.assertEqual(result["summary"]["completed_orders"], 1)
        self.assertEqual(result["summary"]["cancelled_orders"], 1)
        self.assertEqual(result["summary"]["pending_orders"], 1)
        self.assertEqual(result["summary"]["unknown_status_orders"], 1)
        self.assertEqual(result["summary"]["paid_cents_known"], 1999)
        self.assertEqual(result["items"], [{"name": "示例商品", "quantity": 1}])
        with self.assertRaises(footprints.InputError):
            footprints.build_summary(payload(record(status="OFFICIAL_ENUM_MUST_BE_MAPPED")))

    def test_year_uses_order_timezone_without_utc_conversion(self):
        result = footprints.build_summary(payload(record(created_at="2026-01-01T00:10:00+14:00"),
                                                  record("previous", created_at="2025-12-31T23:59:00-12:00")))
        self.assertEqual(result["summary"]["completed_orders"], 1)
        self.assertEqual(result["monthly"][0]["completed_orders"], 1)
        with self.assertRaisesRegex(footprints.InputError, "timezone"):
            footprints.build_summary(payload(record(created_at="2026-01-01T12:00:00")))

    def test_store_identity_is_official_id_and_missing_is_not_invented(self):
        result = footprints.build_summary(payload(record(), record("second", store={"id": "another-private-id", "name": "示例店", "city": "示例城"}),
                                                  record("missing", store={"name": "示例店"})))
        self.assertEqual(result["summary"]["distinct_stores"], 2)
        self.assertEqual(result["summary"]["orders_missing_store_id"], 1)
        self.assertEqual(result["summary"]["orders_missing_city"], 1)
        self.assertEqual(result["summary"]["cities"], 1)
        self.assertEqual(result["cities"][0]["completed_orders"], 2)
        self.assertEqual(result["cities"][0]["distinct_stores"], 2)

    def test_collaborations_require_evidence_and_count_orders_not_item_units(self):
        items = [{"name": "示例甲", "quantity": 3, "collaboration": "示例联名", "collaboration_source": "official"},
                 {"name": "示例乙", "quantity": 2, "collaboration": "示例联名", "collaboration_source": "user_confirmed"},
                 {"name": "示例丙", "quantity": 100, "collaboration": "未经核验联名"}]
        result = footprints.build_summary(payload(record(items=items)))
        self.assertEqual(result["collaborations"], [{"name": "示例联名", "completed_orders": 1, "item_quantity": 5}])
        self.assertEqual(result["summary"]["item_quantity"], 105)
        self.assertIn("unverified_collaboration_ignored", [w["code"] for w in result["warnings"]])

    def test_partial_coverage_title_and_no_private_identifiers(self):
        result = footprints.build_summary(payload(record()))
        serialized = json.dumps(result, ensure_ascii=False)
        self.assertNotIn("private-order", serialized)
        self.assertNotIn("private-store", serialized)
        self.assertNotIn("2026-10-09T12:00:00+08:00", json.dumps(result["stores"]))
        self.assertEqual(result["coverage"]["complete"], False)
        self.assertIn("已获取订单范围", result["title"])
        self.assertEqual(len(result["monthly"]), 12)

    def test_invalid_quantity_and_money_fail_without_coercion(self):
        for quantity in (0, -1, True, 1.5, "2"):
            with self.subTest(quantity=quantity), self.assertRaises(footprints.InputError):
                footprints.build_summary(payload(record(items=[{"name": "示例", "quantity": quantity}])))
        for amount in (-1, True, 1.2, "1999"):
            with self.subTest(amount=amount), self.assertRaises(footprints.InputError):
                footprints.build_summary(payload(record(paid_cents=amount)))

    def test_labels_are_safe_for_rendering(self):
        result = footprints.build_summary(payload(record(store={"id": "s", "name": "<script>\n店", "city": None})))
        self.assertNotIn("<", result["stores"][0]["name"])
        self.assertNotIn("\n", result["stores"][0]["name"])
        self.assertIsNone(result["stores"][0]["city"])

    def test_long_names_remain_distinct_and_oversized_names_fail(self):
        prefix = "示" * 160
        result = footprints.build_summary(payload(record(items=[{"name": prefix + "甲", "quantity": 1},
                                                               {"name": prefix + "乙", "quantity": 2}])))
        self.assertEqual(len(result["items"]), 2)
        self.assertEqual({i["name"] for i in result["items"]}, {prefix + "甲", prefix + "乙"})
        with self.assertRaisesRegex(footprints.InputError, "1000 characters"):
            footprints.build_summary(payload(record(items=[{"name": "示" * 1001, "quantity": 1}])))

    def test_source_tools_allow_only_supported_nonempty_names(self):
        for tools in ([], ["create-order"], ["query-order", "other"], "order-list", [True], [" order-list"]):
            source = payload(record())
            source["source"]["tools"] = tools
            with self.subTest(tools=tools), self.assertRaises(footprints.InputError):
                footprints.build_summary(source)
        source = payload(record())
        source["source"]["tools"] = ["now-time-info", "order-list", "query-order"]
        self.assertEqual(footprints.build_summary(source)["source"]["tools"],
                         ["now-time-info", "order-list", "query-order"])

    def test_output_is_deterministic_and_empty_range_valid(self):
        orders = [record("a"), record("b", store={"id": "b", "name": "另一个示例店", "city": "另一个示例城"})]
        self.assertEqual(footprints.build_summary(payload(*orders)), footprints.build_summary(payload(*reversed(orders))))
        self.assertEqual(footprints.build_summary(payload())["summary"]["completed_orders"], 0)

    def test_changing_labels_does_not_change_store_identity_or_output_order(self):
        orders = [record("a", store={"id": "same-store", "name": "A 示例", "city": "示例城"}),
                  record("b", store={"id": "same-store", "name": "B 示例", "city": "示例城"}),
                  record("c", store={"id": "same-store", "name": "B 示例", "city": "示例城"})]
        first = footprints.build_summary(payload(*orders))
        self.assertEqual(first, footprints.build_summary(payload(*reversed(orders))))
        self.assertEqual(first["summary"]["distinct_stores"], 1)
        self.assertEqual(first["stores"][0]["completed_orders"], 3)
        self.assertIn("store_labels_vary", [w["code"] for w in first["warnings"]])

    def test_synthetic_fixture_cli_is_read_only(self):
        fixture = ROOT / "examples" / "footprints.synthetic.json"
        original = fixture.read_bytes()
        result = subprocess.run([sys.executable, str(ROOT / "scripts" / "footprints.py"), str(fixture)],
                                text=True, capture_output=True, check=True)
        report = json.loads(result.stdout)
        self.assertEqual(fixture.read_bytes(), original)
        self.assertEqual(report["data_kind"], "synthetic")
        self.assertEqual(report["summary"]["completed_orders"], 9)
        self.assertEqual(report["summary"]["distinct_stores"], 6)
        self.assertEqual(report["summary"]["paid_cents_known"], 19450)
        self.assertEqual(report["summary"]["paid_orders_unknown"], 1)

    def test_cli_creates_output_parents_and_private_file_permissions(self):
        fixture = ROOT / "examples" / "footprints.synthetic.json"
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "nested" / "private" / "summary.json"
            command = [sys.executable, str(ROOT / "scripts" / "footprints.py"), str(fixture), "-o", str(output)]
            subprocess.run(command, check=True, capture_output=True, text=True)
            self.assertEqual(output.stat().st_mode & 0o777, 0o600)
            self.assertEqual(json.loads(output.read_text())["data_kind"], "synthetic")
            output.chmod(0o644)
            subprocess.run(command, check=True, capture_output=True, text=True)
            self.assertEqual(output.stat().st_mode & 0o777, 0o600)


if __name__ == "__main__":
    unittest.main()
