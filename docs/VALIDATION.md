# 验证记录

日期：2026-10-09。版本：0.2.1。开发工具：Codex。

## 当前验证

- Python 3.12.14：`python3 -m unittest discover -s tests -v`，16 个取餐交接及 MCP 测试通过。
- 覆盖默认去除取餐码和非白名单字段、显式加入取餐码、缺失凭证和明细、住宅地址过滤、HTML 注入转义、数量和时区校验、保留取消状态原文、SSE 解析和工具分页。
- MCP 客户端只允许 order-list、query-order、now-time-info；创建、取消、兑换、领券、活动和优惠查询等其他工具在网络请求前被拒绝。
- 离线生成器输出明确标注模拟订单的 HTML/TXT；图片与字体内嵌，不需要第三方 Python 包。
- Skill 安装包顶层为 SKILL.md，包含取餐卡所需脚本、引用和素材；不包含 private/、缓存、真实订单或凭据。
- CONTEST_DECLARATION.md 与官方原文逐字节相同。

## 真实 MCP 联调（不含账户内容）

2026-10-09 在实际云环境完成 initialize、tools/list，以及 now-time-info、order-list、query-order 的真实只读调用。业务响应 success 已核查。凭据通过个人保险库绑定，仅用于官方 MCP HTTPS 请求；Token 不写入源码或响应文件。真实返回保存在忽略的 private/，公开演示保持 synthetic。

query-order 实际返回的 orderStatus 为中文状态，和文档描述的数字枚举存在差异。交接卡保留官方状态原文，不自行映射为“已备好”或“可代取”。

## 已有浏览器验证

取餐卡此前在 Chromium / Playwright 的 320、375、390、520、768px 宽度下验证无横向溢出；长门店和餐品名可换行；图片、字体加载和复制按钮的手动回退正常。docs/demo.png 来自明确标注的模拟页面。此次删除扩展功能未修改取餐卡模板与视觉素材。视觉记录见 [design-qa.md](../design-qa.md)。

## Windows 本机验证

- 2026-10-09，Python 3.13.14，在 `D:\Coding\麦当劳\麦麦取餐交接官` 运行 19 项测试全部通过，生成 HTML/TXT 模拟交接卡。
- 修复测试默认使用 GBK 读取 UTF-8 示例的问题；本地续办启动脚本为子进程启用 UTF-8。
- 支持从项目根目录 `.env` 读取 MCD_MCP_TOKEN，环境变量优先。覆盖配置优先级、BOM/引号、缺失配置以及不执行任意配置内容的测试。
- 本机真实 initialize、tools/list、now-time-info、order-list 成功；两个业务查询的 success 均为 true。未生成任何声称可实际代取的订单卡片。
- `git check-ignore .env` 确认凭据被忽略；真实响应只写入 private/。
- 通过本机登录提交官方报名 [Issue #128](https://github.com/M-China/mcd-developer-innovation-challenge/issues/128)，等待官方资格确认。

## 尚未验证或完成

- 未验证用户明确选定的一笔到店订单的完整实际交接、门店代取条件、凭证有效期和状态实时变化。
- 未在 WorkBuddy 实际导入或完成对话验收，没有生成 workbuddy.md。
- 官方报名已提交，尚未收到系统成功/失败回复。

进一步验证时只记录日期、工具和脱敏结果，不记录 Token、取餐码、电话、住址、完整订单 ID 或原始响应。
