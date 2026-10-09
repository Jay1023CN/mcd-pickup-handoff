"""Build and recheck handoffs exclusively from live, account-bound MCP queries."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
import hashlib
import hmac
import json
import os
from pathlib import Path
import re
import secrets
import threading
from typing import Any

from mcp_readonly import Client, read_token
from render_card import normalize, render


class HandoffError(ValueError):
    """Safe, user-facing error; never includes a credential or raw response."""


def canonical(value: Any) -> bytes:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False).encode("utf-8")


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def business_data(result: dict) -> dict:
    if not isinstance(result, dict) or result.get("isError"):
        raise HandoffError("官方查询失败，没有使用旧数据或模拟数据替代。")
    payload = result.get("structuredContent")
    if not isinstance(payload, dict):
        try:
            texts = [json.loads(c["text"]) for c in result.get("content", []) if c.get("type") == "text"]
        except (ValueError, KeyError, TypeError):
            raise HandoffError("官方返回格式发生变化，请重新检查接口。") from None
        if len(texts) != 1:
            raise HandoffError("官方返回格式不明确，未生成交接卡。")
        payload = texts[0]
    if not isinstance(payload, dict) or payload.get("success") is not True or not isinstance(payload.get("data"), dict):
        raise HandoffError("官方业务查询未成功，未生成交接卡。")
    return payload["data"]


def status_category(value: str) -> str:
    # Numeric orderStatus values are documented in query-order's schema.
    # The separate, undocumented `status` field is deliberately not mapped.
    if value in {"6", "7", "8", "已完成", "已取消", "已评价", "订单已完成", "订单已取消", "订单已评价"}:
        return "closed"
    if value in {"1", "待支付", "订单待支付"}:
        return "unpaid"
    if value in {"4", "配送中"}:
        return "delivery"
    if value in {"2", "10", "配餐中", "配餐中-已支付", "配餐中-餐厅确认配餐中"}:
        return "active"
    return "unknown"


def pickup_candidate(row: dict) -> bool:
    return str(row.get("orderType")) == "1" and str(row.get("beType")) in {"1", "5"}


def official_snapshot(row: dict, detail: dict, sampled_at: str, include_code: bool = False) -> dict:
    if detail.get("orderId") != row.get("orderId"):
        raise HandoffError("订单详情与选定订单不一致，已停止。")
    if not pickup_candidate(row) or detail.get("deliveryInfo"):
        raise HandoffError("这笔是外送或取餐方式无法确认，不能生成到店交接卡。")
    if detail.get("takeWay") not in {"外带", "堂食", "到店取餐", "到店自取", "自取", "得来速", "车道取餐"}:
        raise HandoffError("官方取餐方式尚未识别，请在官方订单页核对。")
    if detail.get("storeName") != row.get("storeName"):
        raise HandoffError("列表和详情的门店信息不一致，请重新查询候选订单。")
    products = detail.get("orderProductList", [])
    if not isinstance(products, list):
        raise HandoffError("官方餐品明细格式不明确。")
    status = detail.get("orderStatus")
    if type(status) is int:
        status = str(status)
    data = {"source": {"kind": "mcp", "tool": "query-order", "retrieved_at": sampled_at},
            "is_store_pickup": True,
            "store": {"name": detail.get("storeName"), "address": detail.get("storeAddress"), "address_kind": "restaurant"},
            "pickup_mode": detail.get("takeWay"), "status_text": status,
            "items": [{"name": item.get("productName"), "quantity": item.get("quantity")} for item in products if isinstance(item, dict)]}
    if len(data["items"]) != len(products):
        raise HandoffError("官方餐品明细格式不明确。")
    if include_code:
        data["pickup_code"] = detail.get("pickupCode")
    try:
        normalize(data, include_code)
    except (ValueError, KeyError, TypeError):
        raise HandoffError("官方返回缺少门店、取餐方式、状态或有效餐品字段，未生成卡片。") from None
    return data


class Gateway:
    def __init__(self):
        self.client = Client(read_token())
        self.client.initialize()
        schemas = {tool["name"]: tool.get("inputSchema", {}) for tool in self.client.tools()}
        for name in ("order-list", "query-order", "now-time-info"):
            if name not in schemas:
                raise HandoffError("官方接口缺少必要工具，不能继续。")
        self.schemas = schemas

    def call(self, name: str, arguments: dict) -> dict:
        schema = self.schemas[name]
        if set(arguments) - set(schema.get("properties", {})) or set(schema.get("required", [])) - set(arguments):
            raise HandoffError("官方工具参数契约发生变化，已停止。")
        return business_data(self.client.rpc("tools/call", {"name": name, "arguments": arguments}))


class HandoffService:
    def __init__(self, directory: Path, gateway_factory=Gateway, clock=utc_now):
        self.directory = directory
        self.directory.mkdir(parents=True, exist_ok=True)
        key_path = directory / "signing.key"
        try:
            fd = os.open(key_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        except FileExistsError:
            pass
        else:
            with os.fdopen(fd, "wb") as stream:
                stream.write(secrets.token_bytes(32))
        self.key = key_path.read_bytes()
        if len(self.key) != 32:
            raise HandoffError("本机校验密钥无效，请保留现场并检查。")
        self.gateway_factory = gateway_factory
        self.clock = clock
        self.selections: dict[str, tuple[dict, datetime]] = {}
        self.lock = threading.RLock()

    def _save(self, record_id: str, data: dict) -> None:
        path = self.directory / (record_id + ".json")
        temporary = self.directory / (record_id + "." + secrets.token_hex(4) + ".tmp")
        fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "wb") as stream:
            stream.write(canonical(data))
        os.replace(temporary, path)

    def _signature(self, payload: dict) -> str:
        return hmac.new(self.key, canonical(payload), hashlib.sha256).hexdigest()

    def _sealed(self, payload: dict) -> dict:
        return {"payload": payload, "signature": self._signature(payload)}

    def _valid_seal(self, envelope: dict) -> bool:
        if not isinstance(envelope, dict) or set(envelope) != {"payload", "signature"}:
            return False
        if not isinstance(envelope["payload"], dict) or not isinstance(envelope["signature"], str):
            return False
        try:
            return hmac.compare_digest(envelope["signature"], self._signature(envelope["payload"]))
        except (ValueError, TypeError):
            return False

    @staticmethod
    def _server_time(gateway) -> str | None:
        try:
            value = gateway.call("now-time-info", {}).get("utc")
            moment = datetime.fromisoformat(value.replace("Z", "+00:00"))
            if moment.tzinfo is not None:
                return moment.isoformat()
        except (HandoffError, ValueError, TypeError, AttributeError):
            pass
        return None

    def list_orders(self) -> dict:
        gateway = self.gateway_factory()
        data = gateway.call("order-list", {})
        rows = data.get("list")
        if not isinstance(rows, list):
            raise HandoffError("官方订单列表格式发生变化。")
        result = []
        now = self.clock()
        with self.lock:
            # Selections expire in 10 minutes, including on service restart.
            self.selections = {k: v for k, v in self.selections.items() if now - v[1] < timedelta(minutes=10)}
            for row in rows:
                if not isinstance(row, dict) or not isinstance(row.get("orderId"), str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,64}", row["orderId"]):
                    raise HandoffError("官方订单标识格式不明确。")
                selection = secrets.token_urlsafe(24)
                self.selections[selection] = (dict(row), now)
                result.append({"selection": selection, "store_name": row.get("storeName"), "created_at": row.get("createTime"),
                               "status_text": row.get("orderStatus"), "is_pickup": pickup_candidate(row)})
        return {"orders": result, "queried_at": now.isoformat(), "server_time": self._server_time(gateway), "source": "mcp"}

    def _selected(self, selection: str) -> dict:
        with self.lock:
            found = self.selections.get(selection)
        if found is None or self.clock() - found[1] >= timedelta(minutes=10):
            raise HandoffError("选择已过期或不是本次查询的订单，请刷新订单列表。")
        return found[0]

    def _query(self, row: dict, include_code=False) -> tuple[dict, bool]:
        gateway = self.gateway_factory()
        detail = gateway.call("query-order", {"orderId": row["orderId"]})
        # Stamp the completed detail request. Server UTC is advisory and never
        # substitutes for an actual query timestamp or changes record expiry.
        stamp = self.clock().isoformat()
        data = official_snapshot(row, detail, stamp, include_code)
        data["source"]["server_time"] = self._server_time(gateway)
        return data, bool(detail.get("pickupCode"))

    def inspect(self, selection: str) -> dict:
        data, has_code = self._query(self._selected(selection))
        card = normalize(data)
        category = status_category(card["status_text"])
        return {"card": card, "status_category": category, "can_handoff": category == "active", "has_pickup_code": has_code,
                "notice": "这是历史或非配餐中的订单，只供查看。" if category != "active" else "已查到最新详情。确认门店和餐品后生成交接单。"}

    def create(self, selection: str, include_code: bool = True) -> dict:
        if type(include_code) is not bool:
            raise HandoffError("取餐码分享选项必须明确选择。")
        row = self._selected(selection)
        data, _ = self._query(row, include_code)
        if status_category(data["status_text"]) != "active":
            raise HandoffError("最新官方状态不属于已确认的配餐中状态，不能创建交接单。")
        now = self.clock()
        record_id = secrets.token_hex(16)
        payload = {"version": 1, "record_id": record_id, "created_at": now.isoformat(),
                   "expires_at": (now + timedelta(minutes=10)).isoformat(), "include_pickup_code": include_code, "snapshot": data}
        receipt = self._sealed(payload)
        record = self._sealed({"receipt": receipt, "binding": {k: row[k] for k in ("orderId", "orderType", "beType", "storeName")}})
        self._save(record_id, record)
        return {"receipt": receipt, "card": normalize(data, include_code), "expires_at": payload["expires_at"], "source": "mcp"}

    def verify(self, receipt: dict) -> dict:
        if not self._valid_seal(receipt):
            return {"verified": False, "reason": "modified", "notice": "交接记录被修改，或不是本机服务生成的记录。"}
        payload = receipt["payload"]
        record_id = payload.get("record_id", "")
        if not isinstance(record_id, str) or not re.fullmatch(r"[a-f0-9]{32}", record_id):
            raise HandoffError("交接记录标识无效。")
        try:
            envelope = json.loads((self.directory / (record_id + ".json")).read_text(encoding="utf-8"))
        except (OSError, ValueError):
            raise HandoffError("本机不存在有效的原始交接记录。") from None
        if not self._valid_seal(envelope) or envelope["payload"].get("receipt") != receipt:
            return {"verified": False, "reason": "modified", "notice": "本机原始记录已改变，无法校验。"}
        if self.clock() >= datetime.fromisoformat(payload["expires_at"]):
            return {"verified": False, "reason": "expired", "notice": "交接记录已超过十分钟，请重新查询并生成。"}
        data, _ = self._query(envelope["payload"]["binding"], payload["include_pickup_code"])
        current = normalize(data, payload["include_pickup_code"])
        original = normalize(payload["snapshot"], payload["include_pickup_code"])
        changed = [k for k in current if k not in {"retrieved_at", "kind"} and current[k] != original[k]]
        active = status_category(data["status_text"]) == "active"
        verified = not changed and active
        return {"verified": verified, "reason": "consistent" if verified else "changed", "changed_fields": changed,
                "card": current, "queried_at": data["source"]["retrieved_at"],
                "notice": "记录完整，内容与刚查到的订单一致。" if verified else "订单信息已变化，请重新生成交接单。"}

    def _render_receipt(self, receipt: dict) -> tuple[str, str]:
        if not self._valid_seal(receipt):
            raise HandoffError("记录校验失败，不能导出卡片。")
        payload = receipt["payload"]
        if self.clock() >= datetime.fromisoformat(payload["expires_at"]):
            raise HandoffError("交接记录已过期，不能导出旧卡片。")
        return render(payload["snapshot"], payload["include_pickup_code"])

    def load_receipt(self, record_id: str) -> dict:
        """Load a bridge-owned record without accepting an arbitrary path/order."""
        if not isinstance(record_id, str) or not re.fullmatch(r"[a-f0-9]{32}", record_id):
            raise HandoffError("交接记录标识无效。")
        try:
            envelope = json.loads((self.directory / (record_id + ".json")).read_text(encoding="utf-8"))
        except (OSError, ValueError):
            raise HandoffError("找不到这笔交接记录，请重新生成链接。") from None
        if not self._valid_seal(envelope):
            raise HandoffError("本机交接记录校验失败。")
        receipt = envelope["payload"].get("receipt")
        if not self._valid_seal(receipt) or receipt["payload"].get("record_id") != record_id:
            raise HandoffError("交接记录与本机原始记录不一致。")
        return receipt

    def card_text(self, receipt: dict) -> str:
        return self._render_receipt(receipt)[1]

    def card_html(self, receipt: dict) -> str:
        page, _ = self._render_receipt(receipt)
        note = ("<p style='text-align:center;padding:16px'>交接说明 · 非官方取餐凭证。"
                "离线文件及截图无法验真；复查请在生成它的本机工作台导入配套交接记录。"
                "校验仅在信任该服务时有效。</p>")
        return page.replace("</body>", note + "</body>")
