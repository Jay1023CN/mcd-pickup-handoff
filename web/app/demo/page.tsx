"use client";
import { OwnerWorkbench, DemoAdapter } from "../ui/workbench";
import { demoCard, demoOrders } from "../ui/simulated-data";
const pause = () => new Promise((resolve) => setTimeout(resolve, 550));
const adapter: DemoAdapter = {
  orders: demoOrders,
  inspect: async (order) => { await pause(); const active = order.selection === "simulated-active"; return { card: { ...demoCard(), pickup_code: "", store_name: order.store_name, status_text: active ? "配餐中" : "订单已完成" }, can_handoff: active, has_pickup_code: active, status_category: active ? "active" : "closed", notice: active ? "模拟详情已准备好。" : "这笔模拟订单已完成，只供查看。" }; },
  create: async (includeCode) => { await pause(); localStorage.removeItem("mcd-demo-revoked"); return { card: { ...demoCard(), pickup_code: includeCode ? "A008" : "" }, expires_at: new Date(Date.now() + 600_000).toISOString(), share: { id: "simulated", url: `/demo/take?code=${includeCode ? "yes" : "no"}` } }; },
};
export default function DemoPage() { return <OwnerWorkbench demo={adapter} />; }
