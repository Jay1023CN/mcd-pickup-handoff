![麦麦取餐交接官：这单，拜托你啦。手绘纸袋交接与剪贴艺术字](docs/hero.png)

# 麦麦取餐交接官

**“我走不开，把这单整理给朋友代取。”**

一个基于麦当劳中国 MCP 的取餐交接 Skill。查询已选定的到店取餐订单，把门店、餐品、取餐方式和官方状态整理成一张交接卡，方便订单本人核对后发送给朋友。

[下载 Skill 安装包 v0.2.1](packages/mcd-pickup-handoff-v0.2.1.zip) · [取餐卡 HTML](docs/demo.html) · [33 个官方 MCP 接口](docs/MCP_TOOLS.md)

<table>
<tr><td width="52%" valign="top">
<h3>这单，拜托你啦。</h3>
<p>不用来回问“哪家店、几份、什么状态”。先选对订单，再把需要的信息交给帮忙的人。</p>
<p>剪贴艺术字、手绘纸袋、奶油纸纹理；中文使用 Noto Sans SC，时间与编号使用 DM Mono。卡片可离线打开。</p>
<p><b>01</b> 核对门店与查询快照<br><b>02</b> 查看餐品与份数<br><b>03</b> 按需加入文字取餐码<br><b>→</b> 复制交接文字，自行发送</p>
<p><small>右图为模拟订单，所有数据均为虚构。</small></p>
</td><td width="48%"><img src="docs/demo.png" alt="模拟订单交接卡，默认不包含取餐码" width="360"></td></tr>
</table>

## 目标用户

- 正在开会、排队或暂时走不开，需要朋友帮忙取餐的人。
- 想把门店、餐品、订单状态整理清楚，减少来回询问的同事、同学和家人。
- 不想直接转发含订单编号、电话、付款链接等资料的完整订单截图的人。

## 作品的重点

- **找对这一单**：模糊的“刚才那单”先查询候选；有多笔时请用户选定，再查询订单详情。
- **交接信息清楚**：门店、取餐方式、餐品数量、官方状态和查询时间集中展示。
- **按需分享凭证**：默认不包含取餐码；用户明确要求才加入文字取餐码。二维码本版不处理。
- **状态不误导**：原样展示官方状态，并标明查询时点；卡片不会自动刷新，也不保证他人可代取。
- **只读工具范围**：独立 MCP 客户端允许 `order-list`、`query-order`、`now-time-info`。不会创建、取消、修改订单或领取优惠券。

## 先看离线演示

需要 Python 3.10+，无需第三方 Python 依赖：

```sh
git clone https://github.com/Jay1023CN/mcd-pickup-handoff.git
cd mcd-pickup-handoff
python3 scripts/render_card.py examples/order.synthetic.json --output private/demo
```

打开生成的 `private/demo.html`，或复制 `private/demo.txt`。示例里的门店、餐品、状态、订单和凭证都是模拟数据，页面会明确标注“离线演示”。

如果要演示文字取餐码的呈现：

```sh
python3 scripts/render_card.py examples/order.synthetic.json --output private/demo-with-code --include-pickup-code
```

## Windows 本地运行

本地目录：`D:\coding\麦当劳\麦麦取餐交接官`。需要 Git 和 Python 3.10+，无需安装第三方 Python 包。在 PowerShell 执行：

```powershell
git clone https://github.com/Jay1023CN/mcd-pickup-handoff.git "D:\coding\麦当劳\麦麦取餐交接官"
Set-Location "D:\coding\麦当劳\麦麦取餐交接官"
py -3 scripts/render_card.py examples/order.synthetic.json --output private/demo
Start-Process "private/demo.html"
```

如果目录已存在，先检查是否为本项目及是否有本地修改，不要覆盖；直接在已有项目中运行。上述页面是明确标注的模拟演示。

要在本机验证真实 MCP，运行 `py -3 scripts/connect_mcp.py --prompt-token`，在隐藏输入中填写自己的 Token。云端个人保险库的绑定不会自动迁移到 Windows。此命令只握手和发现工具；查询并选择订单后，按下面的 MCP 流程生成真实交接卡。

## 在 WorkBuddy 使用

1. 在 [麦当劳 MCP 平台](https://open.mcd.cn/mcp) 用自己的账户申请 MCP Token。
2. 按[比赛官方接入教程](https://github.com/M-China/mcd-developer-innovation-challenge#workbuddy-开发指南)，进入“专家·技能·连接器 → 连接器 → 自定义连接器 → 配置 MCP”，添加 `https://mcp.mcd.cn`，传输类型为 `streamablehttp`。
3. 配置文件见 [mcp-config.example.json](mcp-config.example.json)，只包含 `${MCD_MCP_TOKEN}` 占位符。只有客户端支持环境变量展开时才能直接使用；否则在客户端本地凭据配置中填写真实 Token。不要把占位符原样发送给服务器。
4. 在技能管理中上传上方 ZIP 安装包（顶层为 `SKILL.md`），开启技能和连接器。若当前客户端不支持 ZIP 导入，可在对话中明确让它读取本仓库 `SKILL.md` 和所引用的文件。
5. 发起对话：

   > 查一下我刚才的到店取餐订单，整理一张给朋友的交接卡，先不放取餐码。

   或：

   > 我选的是刚才确认的这笔订单，把文字取餐码放进给朋友的卡片。

工具参数和返回字段以当前连接器 schema 为准；Skill 通过白名单输入生成器输出卡片。真实订单文件和输出保存在忽略的 `private/` 目录。

## 独立连接官方 MCP

先到 [官方平台](https://open.mcd.cn/mcp) 申请自己的 Token。已在环境中配置 `MCD_MCP_TOKEN` 时运行：

```sh
python3 scripts/connect_mcp.py
```

也可以在自己的终端运行下面命令，再在隐藏输入提示中粘贴 Token；脚本只在内存中使用，不保存凭据：

```sh
python3 scripts/connect_mcp.py --prompt-token
```

入口会完成 MCP 握手并读取工具 schema，保存到 `private/mcp/tools.json`，不会自动查询任何订单。确认 `order-list` 的实际参数并在本地准备参数 JSON 后，可直接查询：

```sh
python3 scripts/connect_mcp.py --prompt-token --tool order-list --args-file private/order-list.args.json
```

结果仅写入 `private/mcp/order-list.result.json`，终端不打印订单内容。接着按实际 schema 查询必要的 `query-order`，依照对应 Skill 的输入契约生成取餐卡。Token 不能发进聊天、GitHub 或公开日志。

如果本地已经安全配置 `MCD_MCP_TOKEN`，也可以使用只读 CLI：

```sh
mkdir -p private
python3 scripts/mcp_readonly.py tools > private/read-tools.json
# 根据实际 tools/list schema 在本地创建 private/order-list.args.json
python3 scripts/mcp_readonly.py call order-list --args-file private/order-list.args.json > private/order-list.result.json
# 选定订单，再根据实际 schema 创建 private/query-order.args.json
python3 scripts/mcp_readonly.py call query-order --args-file private/query-order.args.json > private/order.result.json
```

接着按 [输入规范](references/input-format.md) 只提取需要的字段到 `private/handoff.json`：

```sh
python3 scripts/render_card.py private/handoff.json --output private/friend-card
```

CLI 不内置工具参数模板、不猜订单字段映射。原始订单响应可能包含个人信息，不能放进公开仓库。

## 验证与当前状态

```sh
python3 -m unittest discover -s tests -v
python3 scripts/package_skill.py
```

已完成本地生成器、只读客户端、离线演示和真实 MCP 联调。**2026-10-09 已实际完成 MCP 握手、工具发现、订单列表、订单详情及服务器时间查询；尚未在 WorkBuddy 中开发/验收，尚未提交报名。** 公开示例全部仍为模拟数据，真实响应不公开。详见 [验证记录](docs/VALIDATION.md)。

## 参赛材料

仓库包含 `README.md`、官方原版 `CONTEST_DECLARATION.md`、`MCP_INTEGRATION.md`、环境变量配置示例和可运行内容。真实 MCP 联调已完成，报名草稿待提交；申请 WorkBuddy 专项奖励还需要真实使用 WorkBuddy 并导出脱敏对话为根目录 `workbuddy.md`，本仓库不生成虚构对话。

[报名草稿](docs/REGISTRATION.md) · [官方比赛规则](https://github.com/M-China/mcd-developer-innovation-challenge/blob/main/activityGuidelines.md) · [来源与同类调研](docs/SOURCES.md)

这是独立社区作品。是否支持他人代取、取餐凭证要求、订单状态和餐品供应以官方渠道和门店为准。

## 目录

```text
SKILL.md                     Skill 工作流程
scripts/render_card.py       白名单卡片生成器
scripts/mcp_readonly.py      官方 MCP 只读客户端
scripts/connect_mcp.py       隐藏输入 Token 的真实连接入口
scripts/package_skill.py     安装包生成器
assets/                     原创生成素材、字体与图标许可
templates/                  取餐卡离线 HTML 布局
references/                 输入规范与工具说明
examples/                   明确标注的模拟订单
tests/                      字段过滤、渲染与 MCP 边界测试
docs/                       演示、验证记录、引用和报名草稿
packages/                   可下载的 Skill ZIP
```

项目自己的代码和文档采用 MIT 许可；原样复制的官方参赛声明及第三方服务不受本项目许可授权。来源说明见 [SOURCES.md](docs/SOURCES.md)。
