#!/usr/bin/env python3
"""Turn normalized, scoped order records into a local illustrated journal."""
import argparse
from datetime import datetime
from html import escape
import json
import os
from pathlib import Path
from string import Template

from footprints import build_summary, InputError
from visual_assets import ROOT, asset_uri, font_faces


def text(value, field):
    if not isinstance(value, str) or not value.strip() or len(value) > 1000:
        raise InputError(f"{field} must be a nonempty string of at most 1000 characters")
    return value.strip()


def benefits_view(payload, kind):
    """Optional recommendations, independently timed; no claiming or writes."""
    if payload is None:
        return '<div class="empty">本次未查询福利。想看当前可领券与活动，可让助手只读查询后再生成。</div>', []
    if not isinstance(payload, dict) or not isinstance(payload.get("source"), dict):
        raise InputError("benefits.source must be an object")
    source = payload["source"]
    if source.get("kind") != kind:
        raise InputError("benefits and order records must have the same source kind")
    names = source.get("tools")
    if not isinstance(names, list) or not names or any(n not in ("campaign-calendar", "available-coupons") for n in names):
        raise InputError("benefits.source.tools must identify read-only benefit tools")
    timestamp = text(source.get("retrieved_at"), "benefits.source.retrieved_at")
    moment = datetime.fromisoformat(timestamp.replace("Z", "+00:00"))
    if moment.tzinfo is None:
        raise InputError("benefits.source.retrieved_at must include a timezone")
    entries = payload.get("entries")
    if not isinstance(entries, list):
        raise InputError("benefits.entries must be a list")
    fragments, lines = [], []
    for item in entries:
        if not isinstance(item, dict) or item.get("kind") not in ("coupon", "campaign"):
            raise InputError("benefit kind must be coupon or campaign")
        required_tool = "available-coupons" if item["kind"] == "coupon" else "campaign-calendar"
        if required_tool not in names:
            raise InputError("benefit entry is missing its source tool")
        title = text(item.get("title"), "benefit title")
        details = text(item.get("details"), "benefit details")
        validity = text(item["validity"], "benefit validity") if item.get("validity") is not None else "官方未提供有效期，请查看官方详情。"
        label = "优惠券" if item["kind"] == "coupon" else "活动"
        if kind == "synthetic":
            label = "模拟" + label
        fragments.append(f'<article class="benefit"><span class="tiny-tag">{label}</span><h3>{escape(title)}</h3><p>{escape(details)}</p><small>{escape(validity)}</small></article>')
        lines.append(f"{label}：{title}；{details}；{validity}")
    if not entries:
        fragments.append('<div class="empty">本次成功查询未返回推荐。只代表该次返回结果。</div>')
    html = '<div class="benefit-grid">' + ''.join(fragments) + '</div>'
    html += f'<p class="note">福利查询时间：{escape(timestamp)}。活动列表可能含往期或未来活动，请核对有效期、门店和适用条件；本报告未领取任何优惠券。</p>'
    return html, lines


def render(payload):
    report = build_summary(payload)
    summary = report["summary"]
    synthetic = report["data_kind"] == "synthetic"
    label = "离线演示 · 纯虚构记录" if synthetic else "官方订单记录 · 查询快照"
    max_count = max((m["completed_orders"] for m in report["monthly"]), default=0) or 1
    months = []
    for index, month in enumerate(report["monthly"], 1):
        count = month["completed_orders"]
        height = round(100 * count / max_count, 2)
        months.append(f'<li aria-label="{index}月：已获取记录中完成订单 {count} 笔"><span class="bar-count">{count}</span><div class="bar-track"><div class="bar {"zero" if not count else ""}" style="height:{height}%"></div></div><span class="month-label">{index:02}</span></li>')
    cities = ''.join(f'<span class="city-sticker"><b>{escape(c["name"])}</b><small>{c["completed_orders"]} 笔完成订单</small></span>' for c in report["cities"])
    if not cities:
        cities = '<p class="empty">已获取的完成订单未提供可识别城市。</p>'
    stores = ''.join(f'<li><span class="store-marker">{i:02}</span><div><strong>{escape(s["name"])}</strong><small>{escape(s["city"] or "城市未提供")}</small></div><b>{s["completed_orders"]}<small>笔订单</small></b></li>' for i, s in enumerate(report["stores"], 1))
    if not stores:
        stores = '<li class="empty">没有带可靠门店 ID 的完成订单。</li>'
    collaborations = ''.join(f'<article class="collab"><span class="tiny-tag">{"模拟联名" if synthetic else "有依据的联名记录"}</span><h3>{escape(c["name"])}</h3><div><b>{c["completed_orders"]}</b><span>笔完成订单<br>{c["item_quantity"]} 件关联商品</span></div></article>' for c in report["collaborations"])
    if not collaborations:
        collaborations = '<div class="empty">没有带核验依据的联名标签。不能据此认定从未购买联名。</div>'
    items = ''.join(f'<li><span>{i:02}</span><strong>{escape(item["name"])}</strong><b>{item["quantity"]}<small>件</small></b></li>' for i, item in enumerate(report["items"][:8], 1))
    if not items:
        items = '<li class="empty">已获取记录未提供餐品明细。</li>'
    warnings = ''.join(f'<li>{escape(w["message"])} <span>（{w["count"]}）</span></li>' for w in report["warnings"])
    if not warnings:
        warnings = '<li>本次输入未发现缺失提示；范围仍以来源说明为准。</li>'
    benefits_html, benefit_lines = benefits_view(payload.get("benefits"), report["data_kind"])
    whole, fractional = divmod(summary['paid_cents_known'], 100)
    known_money = f'{whole}.{fractional:02d}'
    lines = [f'{report["year"]} 麦麦轨迹', label, report["coverage"]["scope_label"], report["coverage"]["description"],
             f'完成订单：{summary["completed_orders"]} 笔；可识别门店：{summary["distinct_stores"]} 家；已知城市：{summary["cities"]} 座。',
             '完成订单不等于吃过、实际到访或已取餐次数。',
             f'已知实付合计：¥{known_money}（{summary["paid_orders_known"]} 笔已知，{summary["paid_orders_unknown"]} 笔缺失）。',
             f'取消 {summary["cancelled_orders"]} 笔；进行中 {summary["pending_orders"]} 笔；未知状态 {summary["unknown_status_orders"]} 笔，不计入完成统计。',
             '门店记录：', *[f'{s["name"]}：{s["completed_orders"]} 笔' for s in report["stores"]],
             '联名记录：', *[f'{c["name"]}：{c["completed_orders"]} 笔订单 / {c["item_quantity"]} 件商品' for c in report["collaborations"]],
             '福利推荐：', *(benefit_lines or ['本次无推荐展示，不代表没有福利。']),
             f'订单查询时间：{report["source"]["retrieved_at"]}',
             *[w["message"] for w in report["warnings"]]]
    plain = '\n'.join(lines)
    values = dict(font_faces=font_faces(), paper=asset_uri('paper.png'),
                  collage=asset_uri('footprints-collage.png'), title_art=asset_uri('footprints-title.png'),
                  year=report['year'], label=escape(label), scope=escape(report['coverage']['scope_label']),
                  description=escape(report['coverage']['description']), completed=summary['completed_orders'],
                  store_count=summary['distinct_stores'], city_count=summary['cities'],
                  months_html=''.join(months), cities_html=cities, stores_html=stores,
                  collaborations_html=collaborations, items_html=items, benefits_html=benefits_html,
                  paid_known=summary['paid_orders_known'], paid_unknown=summary['paid_orders_unknown'],
                  known_money=known_money, cancelled=summary['cancelled_orders'], pending=summary['pending_orders'],
                  unknown=summary['unknown_status_orders'], missing_store=summary['orders_missing_store_id'],
                  missing_city=summary['orders_missing_city'], warnings_html=warnings,
                  retrieved_at=escape(report['source']['retrieved_at']), summary_text=escape(plain),
                  copy_icon=asset_uri('icons/clipboard-text.svg'))
    page = Template((ROOT / 'templates/footprints.html').read_text(encoding='utf-8')).substitute(values)
    return page, plain, report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('input', type=Path)
    parser.add_argument('--output-prefix', type=Path, default=Path('private/footprints'))
    args = parser.parse_args()
    try:
        page, plain, report = render(json.loads(args.input.read_text(encoding='utf-8')))
        args.output_prefix.parent.mkdir(parents=True, exist_ok=True)
        for extension, content in [('.html', page), ('.txt', plain), ('.summary.json', json.dumps(report, ensure_ascii=False, indent=2) + '\n')]:
            path = args.output_prefix.parent / (args.output_prefix.name + extension)
            fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
            with os.fdopen(fd, 'w', encoding='utf-8') as handle:
                handle.write(content)
            os.chmod(path, 0o600)
            print(path)
    except (ValueError, TypeError, KeyError, OSError) as exc:
        parser.exit(2, f'Cannot generate a journal: {exc}\n')


if __name__ == '__main__':
    main()
