#!/usr/bin/env python3
"""Create local pickup handoff cards from explicitly normalized order data."""
from __future__ import annotations

import argparse
from datetime import datetime
from html import escape
import json
import os
from pathlib import Path
from typing import Any
from string import Template
from visual_assets import ROOT, asset_uri, font_faces


def text_field(value: Any, label: str, *, required: bool = True) -> str:
    if value is None and not required:
        return ""
    if not isinstance(value, str) or (required and not value.strip()):
        raise ValueError(f"{label} must be a nonempty string")
    if len(value) > 1000:
        raise ValueError(f"{label} is too long")
    return value.strip()


def normalize(data: dict[str, Any], include_pickup_code: bool = False) -> dict[str, Any]:
    """Whitelist the presentation fields; never copy the original object."""
    source = data["source"]
    kind = source["kind"]
    if kind not in {"synthetic", "mcp"}:
        raise ValueError("source.kind must be synthetic or mcp")
    if source.get("tool") != "query-order":
        raise ValueError("source.tool must identify query-order")
    if data.get("is_store_pickup") is not True:
        raise ValueError("the selected order must explicitly be a store pickup")
    sampled_at = text_field(source["retrieved_at"], "retrieved_at")
    moment = datetime.fromisoformat(sampled_at.replace("Z", "+00:00"))
    if moment.tzinfo is None:
        raise ValueError("retrieved_at must include a timezone")
    store = data["store"]
    # Unknown address types are omitted. No residential address is displayed.
    address = text_field(store.get("address"), "restaurant address", required=False) if store.get("address_kind") == "restaurant" else ""
    items = []
    for item in data.get("items", []):
        count = item["quantity"]
        if type(count) is not int or count <= 0:
            raise ValueError("item quantity must be a positive integer")
        items.append({"name": text_field(item["name"], "item name"), "quantity": count})
    code = text_field(data.get("pickup_code"), "pickup code", required=False) if include_pickup_code else ""
    return {"kind": kind, "retrieved_at": sampled_at,
            "store_name": text_field(store["name"], "store name"), "store_address": address,
            "pickup_mode": text_field(data["pickup_mode"], "pickup mode"),
            "status_text": text_field(data["status_text"], "official status"),
            "items": items, "pickup_code": code}


def render(data: dict[str, Any], include_pickup_code: bool = False) -> tuple[str, str]:
    card = normalize(data, include_pickup_code)
    label = "离线演示 · 模拟订单" if card["kind"] == "synthetic" else "订单查询快照"
    item_lines = [f"{item['name']} × {item['quantity']}" for item in card["items"]]
    if not item_lines:
        item_lines = ["官方返回未提供餐品明细"]
    code_line = f"取餐码：{card['pickup_code']}" if card["pickup_code"] else "取餐码未包含，请向订单本人获取或查看官方订单页。"
    summary = "\n".join(["麦麦取餐交接官", label,
                          f"门店：{card['store_name']}",
                          *([f"门店地址：{card['store_address']}"] if card['store_address'] else []),
                          f"取餐方式：{card['pickup_mode']}", f"官方状态：{card['status_text']}",
                          f"查询时间：{card['retrieved_at']}", "餐品：", *item_lines, code_line,
                          "状态可能变化；是否支持代取及凭证要求，以官方订单页和门店为准。"])
    items_html = "".join(f"<li><span>{escape(item['name'])}</span><b>× {item['quantity']}</b></li>" for item in card["items"])
    if not items_html:
        items_html = "<li>官方返回未提供餐品明细</li>"
    address_html = f"<span class='address'>{escape(card['store_address'])}</span>" if card["store_address"] else ""
    code_html = (f"<div class='credential with-code'><p>仅交给指定代取人</p><strong class='private-code'>{escape(card['pickup_code'])}</strong></div>"
                 if card["pickup_code"] else "<div class='credential'><strong>取餐码未包含</strong><p>请向订单本人获取，或查看官方订单页。</p></div>")
    moment = datetime.fromisoformat(card["retrieved_at"].replace("Z", "+00:00"))
    zone = moment.strftime("%z")
    friendly_time = moment.strftime("%Y-%m-%d %H:%M") + " UTC" + zone[:3] + ":" + zone[3:]
    template = Template((ROOT / "templates/card.html").read_text(encoding="utf-8"))
    page = template.substitute(
        font_faces=font_faces(), paper=asset_uri("paper.png"),
        handoff=asset_uri("handoff.png"), title_art=asset_uri("title.png"),
        label=escape(label), store_name=escape(card["store_name"]),
        address_html=address_html, pickup_mode=escape(card["pickup_mode"]),
        status_text=escape(card["status_text"]), retrieved_at=escape(card["retrieved_at"]),
        friendly_time=escape(friendly_time), items_html=items_html,
        code_html=code_html, summary=escape(summary),
        store_icon=asset_uri("icons/storefront.svg"), bag_icon=asset_uri("icons/bag.svg"),
        clock_icon=asset_uri("icons/clock.svg"), info_icon=asset_uri("icons/clipboard-text.svg"),
        copy_icon=asset_uri("icons/clipboard-text.svg"),
    )
    return page, summary


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("input", type=Path)
    parser.add_argument("--output", type=Path, default=Path("private/card"), help="output file prefix")
    parser.add_argument("--include-pickup-code", action="store_true", help="use only after the owner explicitly agrees")
    args = parser.parse_args()
    try:
        page, summary = render(json.loads(args.input.read_text(encoding="utf-8")), args.include_pickup_code)
        args.output.parent.mkdir(parents=True, exist_ok=True)
        for suffix, content in [(".html", page), (".txt", summary)]:
            path = args.output.parent / (args.output.name + suffix)
            fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
            with os.fdopen(fd, "w", encoding="utf-8") as file:
                file.write(content)
            os.chmod(path, 0o600)
            print(path)
    except (KeyError, TypeError, ValueError, OSError) as exc:
        parser.exit(2, f"Cannot generate a card: {exc}\n")


if __name__ == "__main__":
    main()
