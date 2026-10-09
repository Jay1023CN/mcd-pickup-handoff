# 麦当劳 MCP 接入与业务流程

官方服务为 `https://mcp.mcd.cn`，使用 Streamable HTTP 和 Bearer Token。[官方说明](https://github.com/M-China/mcd-mcp-server)

本机凭据优先读取 `MCD_MCP_TOKEN` 环境变量，其次读取项目根目录 `.env`。Token 不传给浏览器。工作台只监听 `127.0.0.1`，每次启动生成独立会话密钥；接口校验 Host、Origin、会话密钥和请求字段。

## 实际调用链

| 阶段 | 调用 | 校验与输出 |
| --- | --- | --- |
| 列表 | initialize → tools/list → order-list → now-time-info | 当前工具契约、账户内候选及查询时间；前端只拿到临时选择标识 |
| 详情 | query-order → now-time-info | 订单编号与候选一致、门店匹配、确认为到店订单；展示官方状态原文 |
| 生成 | 再次 query-order → now-time-info | 最新状态属于已识别的配餐中状态，字段有效后生成卡片和记录 |
| 下载和复查 | 校验记录 → query-order → now-time-info | 检查十分钟有效期、记录完整性与最新订单内容；变化时停止使用旧卡 |

读取列表与详情中的 `orderId`、`storeName` 来绑定候选。餐厅地址来自 `storeAddress`，取餐方式来自 `takeWay`，餐品来自 `orderProductList[].productName/quantity`，状态来自 `orderStatus`，取餐码来自 `pickupCode`。`deliveryInfo` 非空时拒绝到店交接。

实际返回的 `orderStatus` 可为中文原文，也可为 schema 描述的数字枚举。另一个 `status` 字段未获得明确映射，不拿它猜订单状态。未识别的状态和取餐方式不生成交接卡。查询时间是本机完成详情请求的带时区时间；服务器 UTC 另作辅助记录。

取餐码默认加入，用户可隐藏。缺失时显示“暂无取餐码”。不传播完整响应、配送住址、订单编号、手机号码、支付字段或备注。

## 记录与复查

服务用本机随机 HMAC-SHA256 密钥签署规范化交接记录。实际订单绑定另存于 `private/handoffs/`，下载的记录不含订单编号。复查先验证签名和原始记录，再向官方查询，比对最新字段，并显示本次查到的内容供用户对照。

本机签名是该服务的完整性校验，不能当作官方签名。HTML、文字和截图可被编辑，单独拿着它们无法验真；配套记录需回到生成它的本机服务复查。本机地址不提供异地访问。

## 工具范围与实测

客户端只允许 `order-list`、`query-order`、`now-time-info`。写入工具在网络请求前拒绝。2026-10-09 实际 `tools/list` 返回 35 个工具，公开 README 表列出 33 个；差异见 [工具目录](docs/MCP_TOOLS.md)。

本机实际完成握手、工具发现、服务器时间、订单列表和到店订单详情查询，业务 `success=true`。账户内十笔订单均已完成，历史订单被工作台拒绝生成。完整的配餐中订单生成和状态变化流程使用模拟接口测试，尚无实际待取餐订单的门店交接记录。详情见 [验证记录](docs/VALIDATION.md)。

报名已获官方成功参赛回复：[官方 Issue #128](https://github.com/M-China/mcd-developer-innovation-challenge/issues/128)。WorkBuddy 尚未验收，没有虚构对话记录。
