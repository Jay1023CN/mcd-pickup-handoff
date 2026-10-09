# 文件放在哪里

| 目录 | 内容 | 是否进 GitHub |
| --- | --- | --- |
| `web/app/` | 手机页面、分享页和 API 路由 | 是 |
| `web/lib/` | 云端授权、队列和交接逻辑 | 是 |
| `web/db/`、`web/drizzle/` | 数据模型、按顺序执行的数据库迁移 | 是 |
| `web/tests/`、`tests/` | 云端和本机测试 | 是 |
| `scripts/` | 本机 MCP 连接器、Skill 和打包工具 | 是 |
| `desktop/` | Windows EXE 入口、白名单构建脚本和许可证 | 是 |
| `packages/` | 可下载的版本包和 SHA-256 校验文件 | 是 |
| `docs/`、`examples/`、`templates/` | 说明、明确标注的模拟订单和交接模板 | 是 |
| `.env` | 本机 MCP Token | 否 |
| `private/mobile/` | 本机设备凭据、连接状态和待重试任务 | 否 |
| `private/handoffs/` | 本机签名密钥、真实订单和交接记录 | 否 |
| `private/desktop-build/` | 隔离构建依赖、构建记录和 EXE 模拟验收 | 否 |
| `%LOCALAPPDATA%/McdPickupHandoff` | Windows 免安装版的本机凭据及交接记录 | 否 |
| `web/node_modules/`、`web/dist/`、`web/.wrangler/` | 依赖、构建和本地测试数据库 | 否 |
| 项目同级 `.sites/mcd-pickup-handoff/` | Sites 专用部署 checkout | 不属于本仓库 |

手机站源码只有一份：`web/`。`scripts/sync_mobile_source.py` 将源码复制到已注册的 Sites checkout；复制前检查目标 Git 根目录和站点 ID，不复制依赖、构建、密钥或真实记录。部署 checkout 不反向覆盖源码。

数据库迁移追加文件，已经应用的迁移不修改。真实订单验收和模拟测试分别记录在验证文档里。打包使用清单，不能直接把整个项目目录压缩上传。

前端、本机连接器和云端 API 按边界分工，主 Agent 合并前检查接口和整体链路。旧 `live_app.py` 工作台供开发排查使用，手机站是用户入口。
