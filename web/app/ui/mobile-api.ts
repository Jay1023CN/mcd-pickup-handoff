export type Card = { store_name: string; store_address?: string; pickup_mode: string; status_text: string; retrieved_at: string; items: { name: string; quantity: number }[]; pickup_code?: string };
export type Order = { selection: string; store_name: string; status_text: string; created_at?: string; is_pickup: boolean };
export type Session = { authenticated: boolean; user?: { id: string; name: string }; device?: { id: string; online: boolean } };
export type FriendProgress = { step: "accepted" | "arrived" | "collected"; updated_at: string };
export type ShareSummary = { id: string; store_name: string; status_text: string; queried_at: string; expires_at: string; revoked: boolean; verified: boolean; online: boolean; url?: string; progress?: FriendProgress };
export type Inspection = { card: Card; can_handoff: boolean; has_pickup_code: boolean; status_category: string; notice: string };
export type ShareResult = { card: Card; expires_at: string; share: { id: string; url: string }; progress?: FriendProgress };
export type ShareView = { card?: Card; expires_at: string; queried_at: string; verified: boolean; online: boolean; notice?: string; progress?: FriendProgress };
export function progressText(step: FriendProgress["step"]) { return { accepted: "我来取", arrived: "我到店了", collected: "已帮你取好" }[step]; }
export function mapLink(card: Card) { const query = new URLSearchParams({ keyword: [card.store_name, card.store_address].filter(Boolean).join(" "), view: "map", src: "mcd-pickup-handoff", callnative: "1" }); return `https://uri.amap.com/search?${query}`; }
export class ApiError extends Error { constructor(message: string, public status = 0) { super(message); } }
export async function request<T>(path: string, body?: object, access?: string, signal?: AbortSignal): Promise<T> {
  const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 15_000);
  const cancel = () => controller.abort(); signal?.addEventListener("abort", cancel, { once: true });
  if (signal?.aborted) controller.abort();
  try {
    const response = await fetch(`/api/mobile${path}`, { method: body === undefined ? "GET" : "POST", headers: { ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...(access ? { Authorization: `Bearer ${access}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body), cache: "no-store", credentials: "same-origin", signal: controller.signal });
    let data: Record<string, unknown>;
    try { data = await response.json(); } catch { throw new ApiError("连接暂时不可用，请稍后再试。", response.status); }
    if (!response.ok) throw new ApiError(typeof data.error === "string" ? data.error : "操作未完成，请重新试一次。", response.status);
    return data as T;
  } catch (error) {
    if (signal?.aborted) throw new DOMException("页面已关闭", "AbortError");
    if (error instanceof ApiError) throw error;
    throw new ApiError(controller.signal.aborted ? "连接超时，请稍后重试。" : "网络连接失败，请检查网络后重试。");
  } finally { clearTimeout(timeout); signal?.removeEventListener("abort", cancel); }
}
export async function waitForJob<T>(id: string, share?: { id: string; access: string }, signal?: AbortSignal): Promise<T> {
  const path = share ? `/shares/${encodeURIComponent(share.id)}/jobs/${encodeURIComponent(id)}` : `/jobs/${encodeURIComponent(id)}`;
  const deadline = Date.now() + 200_000;
  while (Date.now() < deadline) {
    if (signal?.aborted) throw new DOMException("页面已关闭", "AbortError");
    const job = await request<{ state: string; result?: T; error?: string }>(path, undefined, share?.access, signal);
    if (job.state === "done") { if (!job.result) throw new ApiError("查询没有返回完整信息，请重试。"); return job.result; }
    if (job.state === "failed") throw new ApiError(job.error || "查询失败，请检查电脑连接后重试。");
    if (job.state !== "queued" && job.state !== "running") throw new ApiError("查询已结束，请重新发起。");
    await new Promise<void>((resolve, reject) => {
      const cancel = () => { clearTimeout(timer); signal?.removeEventListener("abort", cancel); reject(new DOMException("页面已关闭", "AbortError")); };
      const timer = setTimeout(() => { signal?.removeEventListener("abort", cancel); resolve(); }, 1200);
      signal?.addEventListener("abort", cancel, { once: true }); if (signal?.aborted) cancel();
    });
  }
  throw new ApiError("等待查询超时，请检查电脑连接后重试。");
}
export async function runJob<T>(action: "orders" | "inspect" | "create", args: object, signal?: AbortSignal): Promise<T> { const { job_id } = await request<{ job_id: string }>("/jobs", { action, args }, undefined, signal); return waitForJob<T>(job_id, undefined, signal); }
export function timeText(value?: string) { if (!value) return "暂无时间"; const date = new Date(value); if (Number.isNaN(date.getTime())) return value; return date.toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }); }
export function readableStatus(status: string) { return ({ "1": "待支付", "2": "配餐中", "10": "配餐中", "4": "配送中", "6": "已完成", "7": "已取消", "8": "已评价" } as Record<string, string>)[status] ?? status; }
export function expired(value?: string, now = Date.now()) { return !value || !Number.isFinite(Date.parse(value)) || Date.parse(value) <= now; }
