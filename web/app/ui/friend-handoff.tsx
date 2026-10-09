"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { Card, expired, request, ShareView, timeText, waitForJob } from "./mobile-api";
import { Brand, Footer, Loading, MealCard, Notice } from "./shared";
import { demoCard } from "./simulated-data";

export function FriendHandoff({ id, demo = false }: { id: string; demo?: boolean }) {
  const [view, setView] = useState<ShareView | null>(null), [busy, setBusy] = useState(true), [error, setError] = useState("");
  const [access, setAccess] = useState(""), [now, setNow] = useState(() => Date.now()), [simulatedClosed, setSimulatedClosed] = useState(false);
  const running = useRef(false), accessRef = useRef(""), demoCodeRef = useRef(true), lifecycle = useRef<AbortController | null>(null), epoch = useRef(0);
  const hideCode = useCallback(() => { setView((previous) => previous ? { ...previous, verified: false, card: previous.card ? { ...previous.card, pickup_code: "" } : undefined } : previous); }, []);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    let live = true;
    const fragment = new URLSearchParams(window.location.hash.slice(1)).get("access");
    if (window.location.hash) window.history.replaceState(null, "", window.location.pathname + window.location.search);
    const storageKey = `mcd-share:${id}`;
    if (demo) demoCodeRef.current = new URLSearchParams(window.location.search).get("code") !== "no";
    if (fragment) sessionStorage.setItem(storageKey, fragment);
    const token = demo ? "simulated" : fragment || sessionStorage.getItem(storageKey) || "";
    accessRef.current = token;
    const load = async () => {
      if (!live) return;
      const version = ++epoch.current; lifecycle.current?.abort(); const controller = new AbortController(); lifecycle.current = controller; running.current = false;
      setNow(Date.now()); hideCode(); setAccess(token);
      if (!token) { setError("这个链接缺少访问凭据，请让朋友重新发完整链接。"); setBusy(false); return; }
      setBusy(true); setError("");
      const current = () => live && version === epoch.current && !controller.signal.aborted;
      try {
        if (demo && localStorage.getItem("mcd-demo-revoked") === "yes") throw new Error("这张模拟交接卡已撤销，请回到演示页重新生成。");
        const next = demo ? { card: { ...demoCard(), pickup_code: demoCodeRef.current ? "A008" : "" }, expires_at: new Date(Date.now() + 600_000).toISOString(), queried_at: new Date().toISOString(), verified: true, online: true } : await request<ShareView>(`/shares/${encodeURIComponent(id)}/view`, {}, token, controller.signal);
        if (!current()) return;
        if (!next.verified || !next.online || expired(next.expires_at)) { if (next.card) next.card = { ...next.card, pickup_code: "" }; }
        setView(next);
      } catch (e) { if (current()) { setView(null); setError(e instanceof Error ? e.message : "链接暂时无法读取，请重试。"); } } finally { if (current()) setBusy(false); }
    };
    const invalidate = () => { ++epoch.current; lifecycle.current?.abort(); };
    const clear = () => { invalidate(); running.current = false; hideCode(); setNow(Date.now()); setBusy(false); };
    const onVisible = () => { if (document.visibilityState === "visible") void load(); else clear(); };
    const onShow = (event: PageTransitionEvent) => { if (event.persisted) void load(); };
    void Promise.resolve().then(load);
    document.addEventListener("visibilitychange", onVisible); window.addEventListener("pageshow", onShow); window.addEventListener("pagehide", clear);
    return () => { live = false; invalidate(); document.removeEventListener("visibilitychange", onVisible); window.removeEventListener("pageshow", onShow); window.removeEventListener("pagehide", clear); };
  }, [id, demo, hideCode]);

  async function refresh() {
    if (!accessRef.current || running.current || (view && expired(view.expires_at))) return;
    running.current = true; setBusy(true); setError(""); hideCode();
    const version = epoch.current, signal = lifecycle.current?.signal;
    const current = () => version === epoch.current && !signal?.aborted;
    try {
      let expiresAt = view?.expires_at || "";
      if (demo) {
        await new Promise((resolve) => setTimeout(resolve, 650));
        if (!current()) return;
        if (localStorage.getItem("mcd-demo-revoked") === "yes") throw new Error("这张模拟交接卡已撤销，请回到演示页重新生成。");
        setView((previous) => ({ card: { ...demoCard(), status_text: simulatedClosed ? "订单已完成" : "配餐中", pickup_code: simulatedClosed || !demoCodeRef.current ? "" : "A008" }, expires_at: previous?.expires_at || new Date(Date.now() + 600_000).toISOString(), queried_at: new Date().toISOString(), verified: !simulatedClosed, online: true, notice: simulatedClosed ? "订单已完成，请联系发起人确认。" : undefined }));
      } else {
        if (!expiresAt) { const initial = await request<ShareView>(`/shares/${encodeURIComponent(id)}/view`, {}, accessRef.current, signal); expiresAt = initial.expires_at; }
        const { job_id } = await request<{ job_id: string }>(`/shares/${encodeURIComponent(id)}/refresh`, {}, accessRef.current, signal);
        const result = await waitForJob<{ verified: boolean; card?: Card; queried_at?: string; notice?: string }>(job_id, { id, access: accessRef.current }, signal);
        if (!current()) return;
        setView({ expires_at: expiresAt, queried_at: result.queried_at || "", online: true, verified: result.verified === true, card: result.card ? { ...result.card, pickup_code: result.verified === true ? result.card.pickup_code : "" } : undefined, notice: result.notice });
      }
    } catch (e) { if (current()) { setError(e instanceof Error ? e.message : "刷新失败，请联系发起人。"); setView((previous) => previous ? { ...previous, verified: false, online: false } : previous); } }
    finally { if (current()) { running.current = false; setBusy(false); } }
  }

  const isExpired = view ? expired(view.expires_at, now) : false;
  const canUse = !!view?.verified && !!view.online && !isExpired && !busy;
  const safeCard = view?.card ? { ...view.card, pickup_code: canUse ? view.card.pickup_code : "", retrieved_at: view.queried_at || view.card.retrieved_at } : null;
  return <div className="site-shell friend-shell"><Brand demo={demo} /><main>
    <section className="friend-intro"><span className="eyebrow">{demo ? "朋友收到的页面 · 模拟数据" : "朋友托你帮忙取这一单"}</span><h1>这一单，<br />拜托你啦。</h1><p>先看门店和餐品，到了再刷新一下。</p><span className="friend-arrow" aria-hidden="true">↓</span></section>
    {demo && <Notice tone="neutral">模拟交接卡 · 所有信息均为演示数据，没有真实订单。</Notice>}
    {error && <Notice>{error}</Notice>}
    {busy && !safeCard ? <div className="panel empty-state"><Loading>正在读取交接信息</Loading></div> : safeCard && <MealCard card={safeCard} showCode={canUse} busy={busy} demo={demo} />}
    {view && <div className="friend-actions">{isExpired ? <Notice>交接链接已过期，请让朋友重新生成。</Notice> : !view.online ? <Notice>发起人的电脑暂时离线，取餐码已隐藏。请联系朋友，或稍后再刷新。</Notice> : !view.verified && !busy ? <Notice>{view.notice || "信息需要重新确认。点下方刷新，重新查询订单。"}</Notice> : null}
      {!isExpired && <button className="button primary" disabled={busy || !access} onClick={refresh}>{busy ? <Loading>正在重新查询</Loading> : <>取餐前，刷新一次 <span aria-hidden="true">↻</span></>}</button>}
      <div className="friend-meta"><span>{canUse ? "已核对最新订单" : busy ? "查询期间暂不显示取餐码" : "取餐码暂不显示"}</span><span>{isExpired ? "链接已过期" : `有效至 ${timeText(view.expires_at)}`}</span></div>
      <p className="microcopy">交接信息供朋友核对，门店取餐以官方订单凭证为准。</p>
    </div>}
    {!view && !busy && access && <button className="button secondary" onClick={refresh}>重试读取</button>}
    {demo && <div className="demo-controls"><label className="code-toggle"><input type="checkbox" checked={simulatedClosed} onChange={(e) => setSimulatedClosed(e.target.checked)} /><span><strong>模拟订单已完成</strong><small>勾选后刷新，查看取餐码隐藏的效果</small></span></label><a className="small-link" href="/demo">← 回到发起人演示</a></div>}
  </main><Footer /></div>;
}
