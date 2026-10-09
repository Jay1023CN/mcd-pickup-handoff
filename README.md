![麦麦取餐交接官](docs/hero.png)

# 麦麦取餐交接官

麦麦取餐交接官用来把麦当劳订单整理给帮忙取餐的朋友。选好订单后，门店地址、餐品数量、取餐方式、取餐码和订单状态会自动排成一张交接卡。信息来自麦当劳 MCP，发给朋友前可以重新查一遍，省去截图、抄信息和来回解释的麻烦。

[查看演示](https://jay1023cn.github.io/mcd-pickup-handoff/) · [下载安装包 v0.3.0](packages/mcd-pickup-handoff-v0.3.0.zip) · [参赛报名 #128](https://github.com/M-China/mcd-developer-innovation-challenge/issues/128)

正在开会、排队，或者临时走不开，让朋友帮忙取餐时，发一张卡就能交代清楚。餐品按份数列出来，门店地址和取餐码放在一起，朋友打开就能看。卡片可以下载为 HTML，也可以复制或下载交接文字。

<img src="docs/demo.png" alt="使用虚构订单制作的交接卡" width="400">

在线演示使用模拟订单，无需登录。本机工作台读取自己的真实订单。

## 用自己的订单

需要 Python 3.10+，无需安装第三方 Python 包。

1. 下载上面的 ZIP 并解压，或克隆本仓库。
2. 在项目根目录创建 `.env`，写入 `MCD_MCP_TOKEN=你的Token`。Token 从[麦当劳 MCP 平台](https://open.mcd.cn/mcp)申请。
3. Windows 双击 `start-local.cmd`；其他系统运行 `python3 scripts/live_app.py`。
4. 在打开的工作台选择到店订单，核对门店和餐品，点击“再次核对并生成交接单”。
5. 下载交接卡或交接文字，发给帮忙取餐的朋友。

官方返回取餐码时，交接卡默认带上；取消勾选即可隐藏。没返回时显示“暂无取餐码”。订单编号、手机号、付款链接和配送地址不放进卡片。

生成和下载前会重新查询订单。已完成、已取消、未支付和无法识别状态的订单不能生成待取餐交接卡。配套 JSON 记录可导回本机工作台复查，检查内容是否被改动，以及订单是否发生变化；记录有效期为十分钟。

`.env` 和真实订单记录保存在本机，均被 Git 忽略，也不会打进安装包。环境变量 `MCD_MCP_TOKEN` 的优先级高于 `.env`。

交接卡用于传递信息，取餐按官方订单页和门店要求办理。离线 HTML、文字和截图本身不能验真；复查在生成记录的本机服务上完成。

## 在 Agent 中使用

安装包顶层包含 `SKILL.md`。在支持导入 Skill 的客户端中安装，并阅读[技能流程](SKILL.md)。例如：

> 把我刚才的麦当劳到店订单整理成取餐卡，带上取餐码，我发给朋友。

客户端需能运行项目脚本并读取本机凭据。真实卡片由本机服务直接查询 MCP 后生成；离线 JSON 生成器用于模拟演示。

WorkBuddy 的 MCP 配置可参考 [mcp-config.example.json](mcp-config.example.json) 和[官方教程](https://github.com/M-China/mcd-developer-innovation-challenge#workbuddy-开发指南)。本项目尚未完成 WorkBuddy 验收。

## MCP 在这里做什么

| 工具 | 作用 |
| --- | --- |
| `order-list` | 读取账户订单，让用户选定要交接的一笔 |
| `query-order` | 查询门店、餐品、取餐方式、取餐码和最新状态；生成、下载与复查时再次核对 |
| `now-time-info` | 获取官方服务器时间，与本机查询时间一起留作核对 |

客户端仅允许这三个只读工具。前端不能提交门店、状态或取餐码来替代官方结果。[接入说明](MCP_INTEGRATION.md)记录了数据映射和校验方式。

## 演示与验证

```sh
python3 scripts/render_card.py examples/order.synthetic.json --output private/demo --include-pickup-code
python3 -m unittest discover -s tests -v
python3 scripts/package_skill.py
```

2026-10-09：本机真实 MCP 订单列表、订单详情和服务器时间查询成功；42 项测试通过。真实账户现有订单均已完成，已验证历史订单无法生成交接卡。生成、下载和复查的完整浏览器流程使用模拟接口验证。[详细验证记录](docs/VALIDATION.md)

作品参加麦当劳程序员创意开发大赛，按公开 Star 排名。报名 #128 已获官方确认，成功参赛；欢迎点 Star 或提交使用反馈。

[参赛材料](docs/REGISTRATION.md) · [官方规则](https://github.com/M-China/mcd-developer-innovation-challenge/blob/main/activityGuidelines.md) · [来源与素材许可](docs/SOURCES.md)

项目代码和文档采用 MIT 许可；官方参赛声明及第三方素材遵循各自许可。
