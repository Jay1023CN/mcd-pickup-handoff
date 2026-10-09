"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ApiError, Card, expired, Inspection, Order, progressText, readableStatus, request, runJob, Session, ShareResult, ShareSummary, timeText } from "./mobile-api";
import { Brand, Footer, Loading, MealCard, Notice, QueryStamp, Step } from "./shared";
import { RecentHandoffs } from "./recent-handoffs";
export type DemoAdapter = { orders: Order[]; inspect: (order: Order) => Promise<Inspection>; create: (includeCode: boolean) => Promise<ShareResult> };
export function OwnerWorkbench({ demo }: { demo?: DemoAdapter }) {
  const [session, setSession] = useState<Session | null>(demo ? { authenticated: true, user: { id: "simulated", name: "演示用户" }, device: { id: "demo", online: true } } : null);
  const [orders, setOrders] = useState<Order[]>([]), [queriedAt, setQueriedAt] = useState("");
  const [selected, setSelected] = useState<Order | null>(null), [detail, setDetail] = useState<Inspection | null>(null);
  const [includeCode, setIncludeCode] = useState(true), [share, setShare] = useState<ShareResult | null>(null);
  const [busy, setBusy] = useState<string | null>(demo ? null : "session"), [error, setError] = useState(""), [feedback, setFeedback] = useState(""), [pairCode, setPairCode] = useState("");
  const [now, setNow] = useState(() => Date.now());
  const [historyRefresh, setHistoryRefresh] = useState(0);
  const syncSummary = useCallback((entry: ShareSummary) => {
    setShare((previous) => {
      if (!previous || previous.share.id !== entry.id) return previous;
      if (entry.revoked) return null;
      const code = entry.progress?.step === "collected" || !entry.verified || !entry.online ? "" : previous.card.pickup_code;
      if (previous.progress?.step === entry.progress?.step && previous.progress?.updated_at === entry.progress?.updated_at && previous.card.pickup_code === code) return previous;
      return { ...previous, progress: entry.progress, card: { ...previous.card, pickup_code: code } };
    });
  }, []);
  const operation = useRef(false), detailRef = useRef<HTMLElement>(null), lifecycle = useRef<AbortController | null>(null), epoch = useRef(0), pendingPair = useRef<string | null>(null), pairInput = useRef<HTMLInputElement>(null);
  useEffect(() => { const interval = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(interval); }, []);
  const loadOrders = useCallback(async () => {
    const version = epoch.current, signal = lifecycle.current?.signal;
    setBusy("orders"); setError(""); setFeedback(""); setSelected(null); setDetail(null); setShare(null); setOrders([]);
    try { const result = demo ? { orders: demo.orders, queried_at: new Date().toISOString() } : await runJob<{ orders: Order[]; queried_at: string }>("orders", {}, signal); if (version !== epoch.current || signal?.aborted) return; setOrders(result.orders); setQueriedAt(result.queried_at); }
    catch (e) { if (version === epoch.current && !signal?.aborted) { setError(e instanceof Error ? e.message : "订单查询失败，请重试。"); if (e instanceof ApiError && e.status === 401) setSession({ authenticated: false }); } }
    finally { if (version === epoch.current && !signal?.aborted) setBusy(null); }
  }, [demo]);
  const resetAndLoad = useCallback(async () => {
    const version = ++epoch.current; lifecycle.current?.abort(); const controller = new AbortController(); lifecycle.current = controller; operation.current = false;
    const pair = pendingPair.current;
    setNow(Date.now()); setOrders([]); setDetail(null); setShare(null); setSelected(null); setQueriedAt(""); setSession(null); setBusy(pair ? "pair" : "session"); setError(""); setFeedback("");
    const current = () => version === epoch.current && !controller.signal.aborted;
    try {
      if (pair) {
        if (!/^[a-f0-9]{16}$/.test(pair)) throw new ApiError("请输入完整的16位配对码。");
        await request("/devices/claim", { pair_code: pair }, undefined, controller.signal); if (!current()) return;
        pendingPair.current = null; setPairCode("");
      }
      const next = await request<Session>("/session", undefined, undefined, controller.signal);
      if (!current()) return; setSession(next); setBusy(null);
      if (next.authenticated && next.device?.online) await loadOrders();
    } catch (e) {
      if (!current()) return;
      pendingPair.current = null;
      if (e instanceof ApiError && e.status === 410) setPairCode("");
      setError(e instanceof Error ? e.message : "连接失败，请刷新页面。"); setBusy(null);
      try { const next = await request<Session>("/session", undefined, undefined, controller.signal); if (current()) setSession(next); } catch { /* Keep the existing connection error. */ }
    }
  }, [loadOrders]);
  useEffect(() => {
    const invalidate = () => { ++epoch.current; lifecycle.current?.abort(); };
    if (demo) { lifecycle.current = new AbortController(); void Promise.resolve().then(loadOrders); return invalidate; }
    const receivedPair = new URLSearchParams(window.location.hash.slice(1)).get("pair");
    if (window.location.hash) window.history.replaceState(null, "", window.location.pathname + window.location.search);
    // Retire the old redirect flow; pairing codes are never persisted now.
    sessionStorage.removeItem("mcd-pair");
    if (receivedPair) pendingPair.current = receivedPair.replace(/\s/g, "").toLowerCase();
    let mounted = true; void Promise.resolve().then(() => { if (mounted) return resetAndLoad(); });
    const clear = () => { invalidate(); operation.current = false; setOrders([]); setDetail(null); setShare(null); setSelected(null); setQueriedAt(""); setSession(null); setNow(Date.now()); setBusy("session"); };
    const onVisible = () => { if (document.visibilityState === "visible") void resetAndLoad(); else clear(); };
    const onShow = (event: PageTransitionEvent) => { if (event.persisted) void resetAndLoad(); };
    document.addEventListener("visibilitychange", onVisible); window.addEventListener("pageshow", onShow); window.addEventListener("pagehide", clear);
    return () => { mounted = false; invalidate(); document.removeEventListener("visibilitychange", onVisible); window.removeEventListener("pageshow", onShow); window.removeEventListener("pagehide", clear); };
  }, [demo, loadOrders, resetAndLoad]);
  async function act(kind: string, fn: (version: number, signal?: AbortSignal) => Promise<void>) {
    if (operation.current) return; operation.current = true; setBusy(kind); setError(""); setFeedback("");
    const version = epoch.current, signal = lifecycle.current?.signal;
    try { await fn(version, signal); } catch (e) {
      if (version !== epoch.current || signal?.aborted) return;
      setError(e instanceof Error ? e.message : "操作未完成，请重试。");
      if (e instanceof ApiError && e.status === 401) { setOrders([]); setDetail(null); setShare(null); setSelected(null); setSession({ authenticated: false }); }
    } finally { if (version === epoch.current && !signal?.aborted) { operation.current = false; setBusy(null); } }
  }
  async function inspect(order: Order) {
    if (operation.current) return;
    setSelected(order); setDetail(null); setShare(null); setIncludeCode(true);
    await act("inspect", async (version, signal) => { const result = demo ? await demo.inspect(order) : await runJob<Inspection>("inspect", { selection: order.selection }, signal); if (version !== epoch.current || signal?.aborted) return; setDetail(result); window.setTimeout(() => { if (version === epoch.current) detailRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }); }, 100); });
  }
  async function create() {
    if (!selected || !detail?.can_handoff) return; setShare(null);
    await act("create", async (version, signal) => { try { const result = demo ? await demo.create(includeCode) : await runJob<ShareResult>("create", { selection: selected.selection, include_pickup_code: includeCode }, signal); if (version === epoch.current && !signal?.aborted) { setShare(result); setHistoryRefresh((value) => value + 1); } } catch (e) { if (version === epoch.current) setDetail(null); throw e; } });
  }
  async function shareLink() {
    if (!share || expired(share.expires_at) || share.progress?.step === "collected") return; const url = new URL(share.share.url, window.location.origin).href;
    try { if (navigator.share) { await navigator.share({ title: `帮我取一下麦当劳 · ${share.card.store_name}`, text: "门店、餐品和取餐码都在这里，取餐前点一下刷新。", url }); setFeedback("已打开分享。发给帮你取餐的朋友即可。"); } else if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(url); setFeedback("链接已复制，发给帮你取餐的朋友即可。"); } else { setFeedback("请长按下面的链接复制，再发给朋友。"); } } catch (e) { if (e instanceof Error && e.name === "AbortError") return; setFeedback("请长按下面的链接复制，再发给朋友。"); }
  }
  async function revoke() { if (!share) return; await act("revoke", async (version, signal) => { try { if (!demo) await request(`/shares/${encodeURIComponent(share.share.id)}/revoke`, {}, undefined, signal); else localStorage.setItem("mcd-demo-revoked", "yes"); if (version !== epoch.current || signal?.aborted) return; setShare(null); setDetail(null); setSelected(null); setHistoryRefresh((value) => value + 1); setFeedback("交接链接已撤销，朋友打开后将看不到取餐码。"); } catch (e) { if (version === epoch.current) { setShare(null); setDetail(null); setHistoryRefresh((value) => value + 1); } throw e; } }); }
  async function reconnect() { await resetAndLoad(); }
  async function connectWithCode(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (busy) return;
    const code = pairCode.replace(/\s/g, "").toLowerCase();
    if (!/^[a-f0-9]{16}$/.test(code)) { setError("请输入完整的16位配对码。"); pairInput.current?.focus(); return; }
    pendingPair.current = code; await resetAndLoad();
  }
  const shareExpired = !!share && expired(share.expires_at, now), minutes = share ? Math.max(0, Math.min(10, Math.ceil((Date.parse(share.expires_at) - now) / 60000))) : 0;
  const currentCard: Card | undefined = share?.card || detail?.card;
  return <div className="site-shell"><Brand demo={!!demo} /><main>
    <section className="intro"><div className="eyebrow">{demo ? "体验完整流程 · 全部为模拟数据" : "临时走不开，让朋友顺路帮忙"}</div><h1>这顿麦当劳，<br />帮我取一下。</h1><p>选好订单，把门店、餐品和取餐码发给朋友。<br className="wide-only" />取餐前再刷新一次，信息就清楚了。</p><div className="intro-mark" aria-hidden="true">↗</div></section>
    <div className="steps"><Step number="01" label="选订单" active={!selected} /><Step number="02" label="确认取餐" active={!!selected && !share} /><Step number="03" label="发给朋友" active={!!share} /></div>
    {demo && <Notice tone="neutral">这里是模拟演示，不会查询或操作你的真实订单。<Link href="/">使用真实订单 →</Link></Notice>}
    {error && <Notice>{error}</Notice>}{feedback && <Notice tone="success">{feedback}</Notice>}
    {!session && <section className="panel connection-panel"><Loading>{busy === "pair" ? "正在连接你的麦当劳账户" : "正在检查连接"}</Loading>{!busy && <button className="button secondary" onClick={reconnect}>重新连接</button>}</section>}
    {session && !session.authenticated && <section className="panel connection-panel" id="pair-connection"><div className="pairing-heading"><span className="section-number">第一次使用</span><button className="small-link text-button" onClick={() => pairInput.current?.focus()}>我有配对码 ↗</button></div><h2>连接你的麦当劳账户。</h2><p>打开电脑上的连接程序，把配对码填在这里。连接一次，之后就在手机上选订单、发链接。</p><form className="pairing-form" onSubmit={connectWithCode}><label htmlFor="pair-code">一次性配对码</label><input ref={pairInput} id="pair-code" className="pair-code-input" type="text" name="pair_code" autoComplete="off" autoCapitalize="none" autoCorrect="off" spellCheck={false} placeholder="输入16位配对码" value={pairCode} onChange={(event) => setPairCode(event.target.value.replace(/\s/g, "").toLowerCase())} maxLength={24} disabled={!!busy} aria-describedby="pair-code-help" /><p className="pair-code-help" id="pair-code-help">配对码只用一次，十分钟内有效。</p><button className="button primary" type="submit" disabled={!!busy || !/^[a-f0-9]{16}$/.test(pairCode)}>{busy === "pair" ? <Loading>正在连接</Loading> : <>连接 <span aria-hidden="true">↗</span></>}</button></form><div className="pairing-links"><a className="small-link" href="https://github.com/Jay1023CN/mcd-pickup-handoff#手机使用">查看电脑连接步骤</a><Link className="small-link" href="/demo">先试试模拟演示 →</Link></div></section>}
    {session?.authenticated && !session.device && <section className="panel connection-panel"><span className="section-number">首次使用</span><h2>连接你的麦当劳账户。</h2><p>在保存麦当劳 Token 的电脑上完成一次配对。之后用手机选订单、发链接就行，Token 留在你的电脑上。</p><a className="button primary" href="https://github.com/Jay1023CN/mcd-pickup-handoff#手机使用">查看连接步骤 <span aria-hidden="true">↗</span></a><button className="button secondary" onClick={reconnect} disabled={!!busy}>我已连接，刷新</button></section>}
    {session?.authenticated && session.device && !session.device.online && <section className="panel connection-panel"><span className="offline-dot" /> <span>电脑暂时离线</span><h2>打开连接程序，再继续取餐。</h2><p>电脑连上后，这个网页就能重新读取订单。</p><button className="button primary" onClick={reconnect} disabled={!!busy}>{busy ? <Loading>正在检查连接</Loading> : "刷新连接状态"}</button></section>}
    {session?.authenticated && session.device?.online && <div className="workflow-grid"><section className="orders-section"><div className="section-header"><div><span className="section-number">01 / 选订单</span><h2>取哪一单</h2></div><button className="icon-button" onClick={() => { if (!operation.current) void loadOrders(); }} disabled={!!busy} aria-label="刷新订单列表">↻</button></div><QueryStamp value={queriedAt} busy={busy === "orders"} />
      {busy === "orders" ? <div className="empty-state"><Loading>正在读取你的订单</Loading></div> : orders.length === 0 ? <div className="empty-state"><span className="empty-symbol" aria-hidden="true">☷</span><h3>还没有查到订单</h3><p>下单后，点上方刷新再看一眼。</p></div> : <div className="orders-list">{orders.map((order) => <button key={order.selection} className={`order-option ${selected?.selection === order.selection ? "selected" : ""}`} disabled={!!busy || !order.is_pickup} onClick={() => void inspect(order)}><div className="order-top"><span className={`badge ${order.is_pickup ? "" : "muted"}`}>{order.is_pickup ? "到店取餐" : "外送订单"}</span><span className="order-status">{readableStatus(order.status_text)}</span></div><strong>{order.store_name}</strong><div className="order-bottom"><time>{timeText(order.created_at)}</time><span>{order.is_pickup ? "查看详情 ↗" : "无需到店取餐"}</span></div></button>)}</div>}
    </section><section className="detail-section" ref={detailRef}><div className="section-header"><div><span className="section-number">{share ? "03 / 发给朋友" : "02 / 确认取餐"}</span><h2>{share ? "交接已准备好" : "看清楚再交接"}</h2></div>{selected && !share && <button className="small-link text-button" disabled={!!busy} onClick={() => void inspect(selected)}>重新查询</button>}</div>
      {busy === "inspect" ? <div className="panel empty-state"><Loading>正在查询这笔订单</Loading></div> : !currentCard ? <div className="panel empty-state detail-placeholder"><span className="empty-symbol" aria-hidden="true">↖</span><p>{selected ? "没有取得完整详情，请重新查询。" : "选一笔到店订单，详情会出现在这里。"}</p>{selected && <button className="button secondary" disabled={!!busy} onClick={() => void inspect(selected)}>重新查询</button>}</div> : <><MealCard card={currentCard} showCode={!!share && !shareExpired && share.progress?.step !== "collected"} busy={!!busy} demo={!!demo} />
        {share ? <div className="share-actions">{share.progress && <Notice tone="success">朋友反馈：{progressText(share.progress.step)} · {timeText(share.progress.updated_at)}</Notice>}{shareExpired ? <Notice>交接链接已过期。请重新查询订单，再生成新的链接。</Notice> : share.progress?.step === "collected" ? <p className="microcopy">朋友已反馈取好，取餐码和再次分享入口已隐藏。</p> : <><div className="share-ready"><span className="online-dot" /><span>链接已生成 · 约 {minutes} 分钟后过期</span></div><button className="button primary" disabled={!!busy} onClick={shareLink}>发给朋友 <span aria-hidden="true">↗</span></button><label className="share-url-label">分享链接<input className="share-url" aria-label="分享链接" readOnly value={new URL(share.share.url, typeof window === "undefined" ? "https://example.invalid" : window.location.origin).href} onFocus={(e) => e.currentTarget.select()} /></label><p className="microcopy">链接里有取餐信息，只发给这次帮你取餐的朋友。</p></>}<div className="share-secondary"><button className="text-button danger" onClick={revoke} disabled={!!busy}>{busy === "revoke" ? "正在撤销…" : "撤销交接链接"}</button>{shareExpired && selected && <button className="text-button" onClick={() => void inspect(selected)} disabled={!!busy}>重新查询</button>}</div></div> : <div className="create-actions">{detail?.can_handoff ? <><label className="code-toggle"><input type="checkbox" checked={includeCode} onChange={(e) => setIncludeCode(e.target.checked)} disabled={!!busy} /><span><strong>带上取餐码</strong><small>{detail.has_pickup_code ? "朋友打开链接就能看到" : "暂未返回取餐码，生成时会再查一次"}</small></span></label><button className="button primary" onClick={create} disabled={!!busy}>{busy === "create" ? <Loading>正在重新查询并生成</Loading> : <>生成交接链接 <span aria-hidden="true">↗</span></>}</button></> : <Notice tone="neutral">{detail?.notice || "这笔订单现在无法交接。"}</Notice>}</div>}
      </>}
    </section></div>}
    {!demo && session?.authenticated && session.user?.id && <RecentHandoffs key={session.user.id} ownerId={session.user.id} refreshTick={historyRefresh} now={now} onIdentityChanged={resetAndLoad} onSummary={syncSummary} onRevoke={(id) => { if (share?.share.id === id) { setShare(null); setDetail(null); setSelected(null); } }} />}
  </main><Footer /></div>;
}
