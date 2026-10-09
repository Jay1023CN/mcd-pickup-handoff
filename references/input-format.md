# 输入与交接记录

## 真实订单

真实卡片通过 `HandoffService` 直接查询官方 MCP 生成，不接受手写 JSON 声称 `source.kind=mcp`。工作台 API 只接受临时选择标识及取餐码开关：

```json
{"selection":"从本次订单列表获得的标识","include_pickup_code":true}
```

前端不能提供门店、状态或取餐码。服务根据实际 `query-order` 字段创建规范化快照，以 HMAC 签署记录；原始订单绑定只保存在本机。复查请求为 `{"receipt":交接记录}`，有效期十分钟。

默认包含官方文字取餐码，传 `false` 可隐藏；官方缺失时显示“暂无取餐码”。姓名、手机、付款链接、配送地址、订单编号、备注和二维码不进入输出。

## 离线演示

`scripts/render_card.py` 命令行仅接受 `source.kind=synthetic` 的模拟输入，见 [examples/order.synthetic.json](../examples/order.synthetic.json)。页面和文字显示“离线演示 · 模拟订单”。演示码用 `--include-pickup-code` 显示。

内部规范化字段为 `source.kind/tool/retrieved_at`、`is_store_pickup`、`store.name/address/address_kind`、`pickup_mode`、`status_text`、`items[].name/quantity` 和可选 `pickup_code`。其中数量须为正整数，时间须包含时区，地址只接受 `restaurant`。这不是官方原始响应 schema。

内部渲染函数供可信查询服务使用；给任意 JSON 填上 `mcp` 不会使它获得来源证明。离线卡片可被编辑，验真需在生成服务中复查签署记录，并逐项对照刚查询的内容。
