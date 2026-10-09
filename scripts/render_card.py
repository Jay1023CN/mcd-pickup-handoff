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
    address_html = f"<p class='address'>{escape(card['store_address'])}</p>" if card["store_address"] else ""
    code_html = (f"<div class='credential'><span>仅交给指定代取人</span><strong>{escape(card['pickup_code'])}</strong></div>"
                 if card["pickup_code"] else "<p class='code-note'>取餐码未包含，请向订单本人获取或查看官方订单页。</p>")
    page = f"""<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>麦麦取餐交接官 · {escape(card['store_name'])}</title>
<style>
*{{box-sizing:border-box}}body{{margin:0;background:#f5f0e8;color:#292825;font-family:system-ui,-apple-system,'PingFang SC',sans-serif;padding:32px 16px}}main{{max-width:460px;margin:0 auto}}.brand{{font-size:13px;letter-spacing:.08em;color:#776b5c;margin-bottom:18px}}article{{background:#fffdf8;border-radius:24px;overflow:hidden;border:1px solid #e8e0d4;box-shadow:0 14px 40px #3124070a}}header{{padding:30px 28px 22px;background:#ffdc77}}.badge{{font-size:12px;font-weight:600;border:1px solid #a47d2540;border-radius:30px;padding:5px 10px;display:inline-block}}h1{{font-size:32px;letter-spacing:-.03em;margin:22px 0 8px}}header p{{font-size:14px;margin:0;color:#655022;line-height:1.6}}.body{{padding:26px 28px}}h2{{font-size:21px;line-height:1.4;margin:0 0 8px}}.address{{font-size:13px;color:#736a5d;line-height:1.7;margin:0 0 20px}}dl{{display:grid;grid-template-columns:75px 1fr;gap:10px 12px;font-size:14px;margin:20px 0 22px}}dt{{color:#817466}}dd{{margin:0;overflow-wrap:anywhere}}.time{{font-size:12px;color:#817466;line-height:1.6}}.separator{{border-top:1px dashed #e4ddce;margin:24px 0}}.section-label{{font-size:12px;color:#8b7962;letter-spacing:.08em}}ul{{list-style:none;padding:0;margin:12px 0}}li{{display:flex;justify-content:space-between;gap:20px;padding:11px 0;font-size:14px;border-bottom:1px solid #f1ece2}}li span{{overflow-wrap:anywhere}}li b{{white-space:nowrap}}.code-note{{font-size:13px;line-height:1.7;color:#776b5c;background:#f7f3eb;border-radius:12px;padding:14px}}.credential{{background:#fff1d5;padding:16px;border-radius:14px;text-align:center;margin-top:20px}}.credential span{{display:block;font-size:12px;color:#816841}}.credential strong{{display:block;font-size:30px;letter-spacing:.07em;margin-top:8px;overflow-wrap:anywhere}}.footnote{{font-size:12px;color:#8c8070;line-height:1.7;margin:20px 0 0}}button{{display:block;width:100%;background:#292825;color:white;border:0;border-radius:14px;padding:15px;font-size:14px;cursor:pointer;margin:20px 0 8px}}button:focus-visible{{outline:3px solid #bf850b;outline-offset:4px}}textarea{{width:100%;min-height:190px;border:1px solid #e3dbcd;border-radius:12px;padding:12px;font:12px/1.7 system-ui;background:#fffdf8;color:#5f5547}}.copy-status{{font-size:12px;min-height:20px;color:#776b5c}}details{{margin-top:12px}}summary{{font-size:13px;color:#776b5c;cursor:pointer;margin-bottom:10px}}@media print{{body{{background:white;padding:0}}button,details,.copy-status{{display:none}}article{{box-shadow:none}}}}@media(max-width:360px){{header,.body{{padding-left:20px;padding-right:20px}}}}
</style></head><body><main><div class="brand">麦麦取餐交接官 / PICKUP HANDOFF</div>
<article><header><span class="badge">{escape(label)}</span><h1>这单，拜托你啦。</h1><p>门店、餐品、状态，一张卡交接清楚。</p></header>
<div class="body"><h2>{escape(card['store_name'])}</h2>{address_html}
<dl><dt>取餐方式</dt><dd>{escape(card['pickup_mode'])}</dd><dt>官方状态</dt><dd>{escape(card['status_text'])}</dd></dl>
<p class="time">截至查询时间：<time>{escape(card['retrieved_at'])}</time><br>这份卡片不会自动更新。</p>
<div class="separator"></div><span class="section-label">这单包含</span><ul>{items_html}</ul>{code_html}
<p class="footnote">状态可能变化；是否支持代取及凭证要求，以官方订单页和门店为准。</p></div></article>
<button id="copy" type="button">复制交接文字</button><p id="copy-status" class="copy-status" role="status" aria-live="polite"></p>
<details><summary>查看可复制文字</summary><textarea id="handoff-text" readonly aria-label="交接文字">{escape(summary)}</textarea></details>
</main><script>document.getElementById('copy').addEventListener('click',async()=>{{const t=document.getElementById('handoff-text');try{{await navigator.clipboard.writeText(t.value);document.getElementById('copy-status').textContent='已复制，核对后发送给朋友。';}}catch(e){{document.querySelector('details').open=true;t.focus();t.select();document.getElementById('copy-status').textContent='请手动复制已选中的文字。';}}}});</script></body></html>"""
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
