# 麦当劳 MCP 接入与业务流程

## Server

- 官方服务：麦当劳中国 MCP Server
- 端点：`https://mcp.mcd.cn`
- 传输：Streamable HTTP，认证：本地配置的 Bearer Token
- 官方说明：https://github.com/M-China/mcd-mcp-server
- 配置示例：[mcp-config.example.json](mcp-config.example.json)

## 实现的 Tool 使用流程

| 官方 Tool | 使用时机 | 在本作品中的价值 |
| --- | --- | --- |
| `order-list` | 用户没有明确订单标识 | 查找近期到店/外送订单候选，请用户选择正确的到店取餐订单 |
| `query-order` | 已有标识或选定候选后 | 查询门店、餐品、取餐方式、状态与官方实际返回的凭证 |
| `now-time-info` | 需要服务器时间时 | 辅助标注状态查询时点；返回不可用时，使用客户端带时区的实际查询时间并明确口径 |

独立 CLI 实现上述工具的发现和调用。参数来自当前 `tools/list` 返回的 schema，不预置未经验证的参数。不同 Agent 客户端可能给工具增加前缀或将连字符变为下划线，应按实际暴露的名称调用。

## 调用链

1. MCP initialize → notifications/initialized → tools/list。
2. 用户提供标识：query-order；标识不明：order-list → 用户选定 → query-order。
3. 核对是到店取餐；保留官方状态原文，无法确认时停止生成。
4. 从实际返回提取白名单字段到本地规范化输入；不要传播完整原始响应。
5. 本地生成 HTML / TXT；仅用户明确要求时加入文字取餐码。
6. 用户核对并自行交给朋友。卡片不会代替官方取餐资格检查。

## 操作范围

CLI 以固定白名单限制为三个只读 Tool，调用其他 Tool 在发请求之前即被拒绝。Skill 不调用 create-order、cancel-order、积分兑换、领券、地址创建或支付相关操作。生成器不连接网络。

## 真实使用状态

**截至当前版本：连接流程已实现，真实 MCP 调用尚未验证。** 当前开发环境未配置麦当劳 Token，样例全部为明确标注的模拟数据。这份说明记录实现方式，不宣称已查询过真实订单或获得代取授权。

正式报名之前，需要用参赛者自己的 MCP 连接执行实际 order-list/query-order，验证字段映射并补充不含 Token、完整订单 ID、电话、住址或取餐凭证的联调记录。官方规则要求“参赛项目须真实使用麦当劳 MCP 能力”。
