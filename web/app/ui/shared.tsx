"use client";
import { Card, mapLink, readableStatus, timeText } from "./mobile-api";
import { useState } from "react";
import Link from "next/link";
import Image from "next/image";
export function Brand({ demo = false }: { demo?: boolean }) { return <header className="site-header"><Link className="brand" href="/" aria-label="麦麦取餐交接官首页"><Image className="brand-mark" src="/brand/handoff-mark.svg" width={44} height={44} alt="" unoptimized /><span>麦麦取餐<span className="brand-sub">交接官</span></span></Link>{demo ? <span className="badge amber">模拟演示</span> : <Link className="small-link" href="/demo">看看演示 <span aria-hidden="true">↗</span></Link>}</header>; }
export function Footer() { return <footer className="site-footer"><span>麦麦取餐交接官</span><span>把取餐这件事，交代清楚。</span></footer>; }
export function Loading({ children }: { children: React.ReactNode }) { return <span className="loading-label"><span className="spinner" aria-hidden="true" />{children}</span>; }
export function QueryStamp({ value, busy = false }: { value?: string; busy?: boolean }) { return <p className="query-stamp">{busy ? <Loading>正在重新查询订单</Loading> : <>查询时间 <time dateTime={value}>{timeText(value)}</time></>}</p>; }
export function CopyText({ value, label, disabled = false }: { value: string; label: string; disabled?: boolean }) {
  const [fallback, setFallback] = useState(false), [copied, setCopied] = useState(false);
  async function copy() {
    if (!value || disabled) return;
    try { if (!navigator.clipboard?.writeText) throw new Error("clipboard unavailable"); await navigator.clipboard.writeText(value); setCopied(true); }
    catch { setFallback(true); }
  }
  return <div className="copy-control"><button className="text-button" disabled={disabled || !value} onClick={copy}>{copied ? "已复制" : label}</button>{fallback && !disabled && value && <label className="copy-fallback">长按或全选后复制<input type="text" aria-label={`可复制的${label.replace("复制", "")}`} readOnly value={value} onFocus={(event) => event.currentTarget.select()} /><button className="text-button" onClick={(event) => { const field = event.currentTarget.previousElementSibling as HTMLInputElement; field.focus(); field.select(); }}>全选文字</button></label>}</div>;
}
export function MealCard({ card, showCode = true, busy = false, demo = false }: { card: Card; showCode?: boolean; busy?: boolean; demo?: boolean }) {
  return <article className="meal-card"><div className="meal-heading"><span className="eyebrow">{demo ? "模拟订单" : "这次帮忙取的餐"}</span><span className="badge" aria-label={`${demo ? "模拟" : "官方"}订单状态`}>{demo ? "模拟" : "官方"} · {readableStatus(card.status_text)}</span></div><h2>{card.store_name}</h2>{card.store_address && <p className="store-address">{card.store_address}</p>}<div className="store-utilities">{card.store_address && <CopyText key={card.store_address} value={card.store_address} label="复制门店地址" />}<a className="small-link" href={mapLink(card)} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">地图导航 ↗</a></div><div className="pickup-row"><span>取餐方式</span><strong>{card.pickup_mode}</strong></div><div className="meal-divider" /><ul className="meal-items">{card.items.map((item, i) => <li key={`${item.name}-${i}`}><span>{item.name}</span><strong>× {item.quantity}</strong></li>)}</ul>{showCode && <div className="pickup-code"><span>取餐码</span>{busy ? <Loading>刷新后显示</Loading> : card.pickup_code ? <><strong>{card.pickup_code}</strong><CopyText key={card.pickup_code} value={card.pickup_code} label="复制取餐码" disabled={busy} /></> : <p>官方订单暂未返回取餐码</p>}</div>}<QueryStamp value={card.retrieved_at} busy={busy} /></article>;
}
export function Notice({ children, tone = "error" }: { children: React.ReactNode; tone?: "error" | "success" | "neutral" }) { return <div className={`notice ${tone}`} role={tone === "error" ? "alert" : "status"}>{children}</div>; }
export function Step({ number, label, active }: { number: string; label: string; active: boolean }) { return <span className={`step ${active ? "active" : ""}`}><b>{number}</b>{label}</span>; }
