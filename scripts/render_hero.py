#!/usr/bin/env python3
"""Render the repository's illustrated cover, using the same local assets."""
from html import escape
from pathlib import Path
from visual_assets import ROOT, asset_uri, font_faces


def render() -> str:
    return '''<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>麦麦取餐交接官</title>
<style>''' + font_faces() + '''
*{box-sizing:border-box}body{margin:0;background:#fff9ec;color:#171512;font-family:'Noto Sans SC',sans-serif}
.cover{width:1200px;height:630px;position:relative;overflow:hidden;padding:44px 56px;background-image:url(''' + asset_uri("paper.png") + ''');background-size:660px}
.top{display:flex;justify-content:space-between;align-items:center;font:500 12px 'DM Mono',monospace;letter-spacing:.12em;border-bottom:2px dotted #e44226;padding-bottom:18px}.top strong{display:flex;align-items:center;gap:12px;font:900 20px 'Noto Sans SC',sans-serif;letter-spacing:0}.top strong img{width:44px;height:44px}
.tag{display:inline-block;background:#f4c635;transform:rotate(-2deg);font-size:16px;font-weight:800;padding:9px 15px;margin:31px 0 10px}
.title{position:absolute;left:41px;top:158px;width:580px;z-index:2}.hands{position:absolute;right:-31px;top:133px;width:560px;transform:rotate(5deg)}
.caption{position:absolute;left:56px;bottom:88px;font-size:21px;font-weight:600;line-height:1.7}.caption small{display:block;color:#796e5b;font-size:14px;font-weight:400;margin-top:5px}
.bottom{position:absolute;left:56px;right:56px;bottom:30px;border-top:2px dotted #e44226;padding-top:15px;display:flex;justify-content:space-between;font:12px 'DM Mono',monospace;color:#e44226}
</style><main class="cover"><div class="top"><strong><img src="''' + asset_uri("brand/handoff-mark.svg") + '''" alt="">麦麦取餐交接官</strong><span>PICKUP / HANDOFF · 2026</span></div>
<div class="tag">一个链接，把这单交代清楚。</div><img class="title" src="''' + asset_uri("title.png") + '''" alt="这单，拜托你啦。"><img class="hands" src="''' + asset_uri("handoff.png") + '''" alt="手绘纸袋交接">
<div class="caption">门店、餐品、取餐码，发给帮忙取餐的朋友。<small>手机选单与分享 · 麦当劳 MCP 实时查询</small></div>
<div class="bottom"><span>ONE ORDER. A LITTLE FAVOUR.</span><span>READ → REVIEW → SHARE</span></div></main></html>'''


if __name__ == "__main__":
    path = ROOT / "docs/hero.html"
    path.write_text(render(), encoding="utf-8")
    print(path)
