# 交接卡的规范化输入

本格式是本地生成器的输入，**不是官方 query-order 原始 JSON schema**。Agent 读取真实工具返回后，明确映射字段；无法辨认或缺失的内容不猜测。source.kind 的标记由调用者提供，生成器本身不认证其真实性。

```json
{
  "source": {
    "kind": "mcp",
    "tool": "query-order",
    "retrieved_at": "2026-10-09T17:30:00+08:00"
  },
  "is_store_pickup": true,
  "store": {
    "name": "来自订单的门店名称",
    "address": "来自门店字段的餐厅地址（可省略）",
    "address_kind": "restaurant"
  },
  "pickup_mode": "来自官方返回的取餐方式",
  "status_text": "来自官方返回的状态原文",
  "items": [{"name": "来自官方返回的餐品名称", "quantity": 1}],
  "pickup_code": "只有官方实际返回时才填写（可省略）"
}
```

- 示例中的内容均为字段说明；不能直接当作真实订单渲染。实际数据保存在 `private/handoff.json`。
- source.kind 只接受 `mcp` 或 `synthetic`。离线示例用后者，页面有演示标签。
- retrieved_at 必须是带时区的实际查询时间。即使查的是已取消订单，也要原样保留状态，不能自动转换为已备好。
- is_store_pickup 必须是在查看真实订单之后明确确认的 true；不能靠设置 true 把外送单变为到店单。
- 地址只在 address_kind 为 restaurant 时输出；Agent 必须确认来自餐厅字段，不能把收货地址放入此字段。
- items 可为空，此时页面明确显示官方未提供明细；数量须为正整数，不允许自行估算。
- pickup_code 默认不输出。使用 --include-pickup-code 前取得这笔订单本人的明确分享意愿。没有凭证时，仍标注“取餐码未包含”。
- 不支持二维码、配送地址、姓名、手机号、付款链接、备注、订单 ID 或任意原始字段透传。

默认卡片省略结构化敏感字段，并不是任意文本自动脱敏器。错误地把电话号码写成门店名等白名单字段仍可能泄露；真实字段映射和发送前核对由调用者负责。
