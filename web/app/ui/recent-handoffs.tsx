"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, expired, progressText, readableStatus, request, Session, ShareSummary, timeText } from "./mobile-api";
import { Loading, Notice } from "./shared";
type ShareHistory = { owner_id: string; entries: ShareSummary[] };

export function RecentHandoffs({ ownerId, refreshTick, now, ownerBusy, onIdentityChanged, onRevoke, onSummary }: { ownerId: string; refreshTick: number; now: number; ownerBusy: boolean; onIdentityChanged: () => Promise<void>; onRevoke: (id: string) => void; onSummary: (entry: ShareSummary) => void }) {
  const [entries, setEntries] = useState<ShareSummary[]>([]), [busy, setBusy] = useState<string | null>("load");
  const [error, setError] = useState(""), [feedback, setFeedback] = useState(""), [recovered, setRecovered] = useState<ShareSummary | null>(null);
  const lifecycle = useRef<AbortController | null>(null), epoch = useRef(0), quietRequest = useRef<AbortController | null>(null), operationBusy = useRef(false);
  const canShare = useCallback((entry: ShareSummary) => !entry.revoked && !expired(entry.expires_at) && entry.progress?.step !== "collected" && !!entry.url, []);

  const confirmOwner = useCallback(async (signal: AbortSignal) => {
    const session = await request<Session>("/session", undefined, undefined, signal);
    if (signal.aborted) throw new DOMException("请求已取消", "AbortError");
    if (!session.authenticated || session.user?.id !== ownerId) {
      await onIdentityChanged();
      throw new DOMException("账户已改变", "AbortError");
    }
  }, [ownerId, onIdentityChanged]);

  const confirmHistoryOwner = useCallback(async (result: ShareHistory, signal: AbortSignal) => {
    if (signal.aborted) throw new DOMException("请求已取消", "AbortError");
    if (result.owner_id !== ownerId) {
      await onIdentityChanged();
      throw new DOMException("交接记录归属已改变", "AbortError");
    }
  }, [ownerId, onIdentityChanged]);

  const load = useCallback(async () => {
    operationBusy.current = true; quietRequest.current?.abort();
    const version = ++epoch.current; lifecycle.current?.abort(); const controller = new AbortController(); lifecycle.current = controller;
    setBusy("load"); setError(""); setFeedback(""); setRecovered(null); setEntries([]);
    const current = () => version === epoch.current && !controller.signal.aborted;
    try {
      await confirmOwner(controller.signal); if (!current()) return;
      const result = await request<ShareHistory>("/shares", undefined, undefined, controller.signal);
      if (!current()) return; await confirmHistoryOwner(result, controller.signal);
      if (current()) { setEntries(result.entries.slice(0, 20)); result.entries.forEach(onSummary); }
    } catch (e) {
      if (!current() || (e instanceof Error && e.name === "AbortError")) return;
      if (e instanceof ApiError && e.status === 401) { await onIdentityChanged(); return; }
      setError(e instanceof Error ? e.message : "交接记录读取失败，请重试。");
    } finally { if (current()) { operationBusy.current = false; setBusy(null); } }
  }, [confirmOwner, confirmHistoryOwner, onIdentityChanged, onSummary]);

  useEffect(() => {
    let mounted = true; void Promise.resolve().then(() => { if (mounted) return load(); });
    const invalidate = () => { ++epoch.current; lifecycle.current?.abort(); };
    return () => { mounted = false; invalidate(); };
  }, [load, refreshTick]);

  // Friend feedback is already stored on the server; this never queries MCP.
  const hasActiveShares = entries.some((entry) => !entry.revoked && !expired(entry.expires_at, now) && entry.progress?.step !== "collected");
  useEffect(() => {
    if (!hasActiveShares || busy || ownerBusy) return;
    let mounted = true, delay = 12_000, timer: ReturnType<typeof setTimeout>;
    const version = epoch.current;
    const current = (controller: AbortController) => mounted && version === epoch.current && !controller.signal.aborted && !operationBusy.current && document.visibilityState === "visible";
    const schedule = () => { if (mounted) timer = setTimeout(() => void poll(), delay); };
    const poll = async () => {
      // Leave selected link/address text alone while the user copies it.
      const editing = document.activeElement?.matches("input,textarea") || !!window.getSelection()?.toString();
      if (document.visibilityState !== "visible" || operationBusy.current || editing) { schedule(); return; }
      const controller = new AbortController(); quietRequest.current = controller;
      try {
        await confirmOwner(controller.signal); if (!current(controller)) return;
        const result = await request<ShareHistory>("/shares", undefined, undefined, controller.signal);
        if (!current(controller)) return; await confirmHistoryOwner(result, controller.signal);
        if (!current(controller)) return;
        const latest = result.entries.slice(0, 20);
        setEntries(latest); latest.forEach(onSummary);
        setRecovered((previous) => previous ? latest.find((entry) => entry.id === previous.id && canShare(entry)) || null : null);
        delay = 12_000;
        if (!latest.some((entry) => !entry.revoked && !expired(entry.expires_at) && entry.progress?.step !== "collected")) return;
      } catch (e) {
        if (!current(controller) || (e instanceof Error && e.name === "AbortError")) return;
        if (e instanceof ApiError && [401, 403, 404, 410].includes(e.status)) { await onIdentityChanged(); return; }
        delay = Math.min(delay * 2, 120_000);
      } finally { if (quietRequest.current === controller) quietRequest.current = null; }
      schedule();
    };
    const stop = () => { mounted = false; clearTimeout(timer); quietRequest.current?.abort(); };
    const onVisibility = () => { if (document.visibilityState !== "visible") stop(); };
    schedule(); document.addEventListener("visibilitychange", onVisibility); window.addEventListener("pagehide", stop);
    return () => { stop(); document.removeEventListener("visibilitychange", onVisibility); window.removeEventListener("pagehide", stop); };
  }, [hasActiveShares, busy, ownerBusy, confirmOwner, confirmHistoryOwner, canShare, onIdentityChanged, onSummary]);

  async function recover(entry: ShareSummary) {
    if (busy || !canShare(entry)) return;
    const version = epoch.current, signal = lifecycle.current?.signal;
    if (!signal) return; operationBusy.current = true; quietRequest.current?.abort(); setBusy(`share:${entry.id}`); setError(""); setFeedback(""); setRecovered(null);
    const current = () => version === epoch.current && !signal.aborted;
    try {
      await confirmOwner(signal); if (!current()) return;
      const result = await request<ShareHistory>("/shares", undefined, undefined, signal); if (!current()) return;
      await confirmHistoryOwner(result, signal); if (!current()) return;
      setEntries(result.entries.slice(0, 20)); result.entries.forEach(onSummary);
      const latest = result.entries.find((value) => value.id === entry.id);
      if (!latest || !canShare(latest)) throw new ApiError("这条交接现在无法分享，请重新生成。");
      const url = new URL(latest.url!, window.location.origin).href; setRecovered(latest);
      try {
        if (navigator.share) { await navigator.share({ title: `帮我取一下麦当劳 · ${latest.store_name}`, text: "取餐信息在这里，到了门店再刷新一次。", url }); if (current()) setFeedback("已打开分享，发给这次帮你取餐的朋友即可。"); }
        else if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(url); if (current()) setFeedback("原交接链接已复制，发给朋友即可。"); }
        else if (current()) setFeedback("原链接已恢复，长按下面的链接复制。");
      } catch (e) { if (e instanceof Error && e.name === "AbortError") return; if (current()) setFeedback("原链接已恢复，长按下面的链接复制。"); }
    } catch (e) {
      if (!current() || (e instanceof Error && e.name === "AbortError")) return;
      if (e instanceof ApiError && e.status === 401) { await onIdentityChanged(); return; }
      setRecovered(null); setError(e instanceof Error ? e.message : "链接恢复失败，请重试。");
    } finally { if (current()) { operationBusy.current = false; setBusy(null); } }
  }

  async function revoke(entry: ShareSummary) {
    if (busy || entry.revoked || expired(entry.expires_at)) return;
    const version = epoch.current, signal = lifecycle.current?.signal;
    if (!signal) return; operationBusy.current = true; quietRequest.current?.abort(); setBusy(`revoke:${entry.id}`); setError(""); setFeedback(""); setRecovered(null); onRevoke(entry.id);
    const current = () => version === epoch.current && !signal.aborted;
    try {
      await confirmOwner(signal); if (!current()) return;
      await request(`/shares/${encodeURIComponent(entry.id)}/revoke`, {}, undefined, signal); if (!current()) return;
      setEntries((previous) => previous.map((value) => value.id === entry.id ? { ...value, revoked: true, verified: false, url: undefined } : value));
      setFeedback("这条交接已撤销，原链接不再显示取餐码。");
    } catch (e) {
      if (!current() || (e instanceof Error && e.name === "AbortError")) return;
      if (e instanceof ApiError && e.status === 401) { await onIdentityChanged(); return; }
      setEntries((previous) => previous.map((value) => value.id === entry.id ? { ...value, url: undefined } : value));
      setError(e instanceof Error ? e.message : "撤销未完成，请刷新记录后重试。");
    } finally { if (current()) { operationBusy.current = false; setBusy(null); } }
  }

  const recoveredIsValid = recovered && !recovered.revoked && !expired(recovered.expires_at, now) && recovered.progress?.step !== "collected" && recovered.url;
  return <section className="recent-handoffs" aria-label="最近的交接"><div className="section-header"><div><span className="section-number">最近七天</span><h2>最近的交接</h2></div><button className="icon-button" aria-label="刷新交接记录" disabled={!!busy} onClick={() => void load()}>↻</button></div>
    <p className="microcopy">返回这里，也能找回刚才的链接。</p>
    {error && <Notice>{error}</Notice>}{feedback && <Notice tone="success">{feedback}</Notice>}
    {busy === "load" ? <div className="recent-empty"><Loading>正在读取交接记录</Loading></div> : entries.length === 0 ? <div className="recent-empty">还没有交接记录，生成的链接会留在这里。</div> : <div className="recent-list">{entries.map((entry) => {
      const ended = entry.revoked || expired(entry.expires_at, now);
      const status = entry.revoked ? "已撤销" : expired(entry.expires_at, now) ? "已过期" : entry.progress?.step === "collected" ? "朋友已取好" : !entry.online ? "电脑离线" : !entry.verified ? "需刷新核对" : "可分享";
      const available = !ended && entry.progress?.step !== "collected" && !!entry.url;
      return <article className={`recent-entry ${ended ? "ended" : ""}`} key={entry.id}><div className="recent-entry-heading"><h3>{entry.store_name}</h3><span className={`badge ${ended ? "muted" : ""}`}>{status}</span></div><p className="recent-status">官方订单 · {readableStatus(entry.status_text)}</p>{entry.progress && <p className="recent-progress">朋友反馈：<strong>{progressText(entry.progress.step)}</strong><time>{timeText(entry.progress.updated_at)}</time></p>}<div className="recent-times"><span>查询于 {timeText(entry.queried_at)}</span><span>{ended ? `有效期至 ${timeText(entry.expires_at)}` : `有效至 ${timeText(entry.expires_at)}`}</span></div>{!ended && <div className="recent-entry-actions">{available ? <button className="text-button" disabled={!!busy} onClick={() => void recover(entry)}>{busy === `share:${entry.id}` ? "正在恢复…" : "找回链接，发给朋友 ↗"}</button> : <span className="microcopy">{entry.progress?.step === "collected" ? "朋友已反馈取好" : "没有可恢复的链接"}</span>}<button className="text-button danger" disabled={!!busy} onClick={() => void revoke(entry)}>{busy === `revoke:${entry.id}` ? "正在撤销…" : "撤销"}</button></div>}</article>;
    })}</div>}
    {recoveredIsValid && <label className="share-url-label recent-recovered">原交接链接<input className="share-url" aria-label="恢复的交接链接" readOnly value={new URL(recovered.url!, typeof window === "undefined" ? "https://example.invalid" : window.location.origin).href} onFocus={(event) => event.currentTarget.select()} /><span className="microcopy">有效期保持原样，取餐前让朋友刷新一次。</span></label>}
  </section>;
}
