# 麦当劳 MCP 接入与业务流程

## Server

- 官方服务：麦当劳中国 MCP Server
- 端点：`https://mcp.mcd.cn`
- 传输：Streamable HTTP，认证：本地配置的 Bearer Token
- 官方说明：https://github.com/M-China/mcd-mcp-server
- 配置示例：[mcp-config.example.json](mcp-config.example.json)
- 实际连接入口：`python3 scripts/connect_mcp.py`，读取环境变量 MCD_MCP_TOKEN；或在本地终端加 `--prompt-token` 隐藏输入，仅保存在进程内存。

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

CLI 以固定白名单限制为上述三个只读 Tool，调用其他 Tool 在发请求之前即被拒绝。Skill 不调用 create-order、cancel-order、积分兑换、领券、地址创建或支付相关操作。生成器不连接网络。全部 33 个公开工具的精确目录见 [MCP_TOOLS.md](docs/MCP_TOOLS.md)。

## 真实使用状态

**2026-10-09：已完成真实账户 MCP 联调。** initialize / tools/list 成功，now-time-info、order-list、query-order 均真实调用成功。公开演示全部为模拟数据；真实订单和原始响应只保存在忽略提交的 private/。当前云环境已通过个人保险库绑定 MCD_MCP_TOKEN，实际请求验证成功；本地 Windows 需要独立配置自己的凭据。

正式报名仍需按官方 Issue 流程提交。当前云端 GitHub 集成的 GraphQL 和 REST 创建 Issue 均返回无权限，尚未报名成功。WorkBuddy 专项另需实际使用 WorkBuddy 并提供真实脱敏记录；本次使用 Codex，不能伪装成 WorkBuddy 开发。

取餐交接仍需用户明确选定订单后核对实际取餐方式；真实查询成功不证明门店保证支持朋友代取。
