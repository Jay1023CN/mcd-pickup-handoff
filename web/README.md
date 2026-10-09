# 麦麦取餐交接官 · 手机站

手机用电脑显示的一次性配对码连接，无需注册或登录。朋友通过交接链接查看单笔订单。

源码入口：app/ui/workbench.tsx（本人）、app/ui/friend-handoff.tsx（朋友）、lib/mobile-api.mjs（授权和队列）。MCP在项目根目录的scripts/mobile_bridge.py执行，Token不配置到云站。

需要Node.js 22.13+。安装和开发：

```sh
npm run install:ci
npm run dev
```

数据库迁移在drizzle/，按编号顺序应用。新增迁移使用npm run db:generate，不能修改已应用文件。Sites生产部署自动携带迁移；本地DB独立保存在被忽略的.wrangler/。

```sh
node --test tests/mobile-api.test.mjs tests/mobile-renew.test.mjs tests/mobile-session.test.mjs tests/retention.test.mjs
node node_modules/typescript/bin/tsc --noEmit
npm run build
```

运行时沿用Sites/Vinext模板，build/和scripts/中的平台适配不作为用户功能入口。不要把.env、.sites-runtime、node_modules或.wrangler上传。部署checkout在项目同级.sites/，用根目录scripts/sync_mobile_source.py同步。

完整说明见[项目README](../README.md)、[文件管理](../docs/PROJECT_LAYOUT.md)和[接口契约](../docs/WEB_ARCHITECTURE.md)。