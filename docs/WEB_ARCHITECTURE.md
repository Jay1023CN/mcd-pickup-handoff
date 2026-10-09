# 手机网页与本机 MCP 连接

web/ 是手机网页和云端 API 的源码；scripts/mobile_bridge.py 负责本机 MCP，private/mobile/ 保存连接和真实记录。站点部署 checkout 位于任务根目录 .sites/，不混进项目 Git。旧工作台保留为开发工具，不作为手机入口。

## 数据流

手机网页用电脑显示的一次性配对码连接，无需任何外部账号。电脑连接程序向云端注册设备，得到临时配对码及设备凭据；手机输入配对码后，云端生成随机取餐账户和手机会话。会话 Cookie 为 HttpOnly、Secure、SameSite=Strict，三十天有效；数据库只存会话凭据的 SHA256 哈希。API 忽略 Sites 或其他来源提供的身份头。MCP Token 仍只从本机 .env 读取。云端只排队有限查询任务，不保存 MCP Token 或官方订单编号。

分享页由随机链接访问，朋友只可查看被分享的单笔订单及请求刷新，不能枚举账户订单。交接信息有效期十分钟，支持撤销。网页展示最新查询时点，刷新失败清除当前取餐码，不能把缓存伪装为最新官方结果。

## API 契约 v1

所有请求 JSON，所有响应 JSON；业务错误为 {error:string} 配 HTTP 4xx/5xx。api 前缀 /api/mobile。Token 均是设备/分享凭据，绝不为 MCP Token。

GET /session -> {authenticated:boolean, user?:{id:string,name:'我的取餐'}, device?:{id:string,online:boolean}}
POST /session/logout {}（手机会话）-> {ok:true}，注销当前会话并清除 Cookie，不解除设备绑定
POST /devices/enroll {} -> {device_id:string,device_token:string,pair_code:string,expires_at:string}
POST /devices/claim {pair_code:string}（匿名手机、同源 Origin）-> {device_id:string}，会话凭据只通过 Set-Cookie 交给浏览器
POST /devices/renew {device_id:string,reset_owner:boolean}（Bearer 设备凭据）-> {paired:boolean,pair_code:string,expires_at:string}
POST /devices/poll {device_id:string}（Bearer 设备凭据）-> {paired:boolean,job:null|{id:string,action:string,args:object}}
POST /devices/complete {device_id:string,job_id:string,result?:object,error?:string}（Bearer 设备凭据）-> {ok:true}
POST /devices/share {device_id:string,card:object,record_id:string,expires_at:string,queried_at:string}（已配对设备）-> {card,expires_at,share:{id,url}}
POST /jobs {action:'orders'|'inspect'|'create', args:object}（手机会话）-> {job_id:string}
GET /jobs/{id}（手机会话，归属检查）-> {state:'queued'|'running'|'done'|'failed',result?:object,error?:string}
POST /shares/{id}/refresh {}（Bearer 分享凭据）-> {job_id:string}
GET /shares/{id}/jobs/{job_id}（Bearer 分享凭据）-> {state:string,result?:object,error?:string}
POST /shares/{id}/view {}（Bearer 分享凭据）-> {card:object,expires_at:string,queried_at:string,verified:boolean,online:boolean}
POST /shares/{id}/revoke {}（手机会话，归属检查）-> {ok:true}
GET /shares（手机会话）-> {entries:[{id,store_name,status_text,queried_at,expires_at,revoked,verified,online,url?:string}]}

创建 args {selection:string,include_pickup_code:boolean}；详情 args {selection:string}；列表 args {}。桥接调用 HandoffService，返回：orders 与 inspect 原结果；create 为 {card,record_id,expires_at,queried_at}；refresh args {record_id:string} 为 {verified,card,queried_at,notice}。云端完成 create 任务时把 record_id 留在数据库，发给网页的 result 仅为 {card,expires_at,share:{id,url}}，url 含分享凭据在 fragment，格式 /take/{id}#access=...。

配对码为随机十六位小写十六进制，十分钟过期，claim 后立即失效；并发认领只能有一个成功。首次配对沿用有效手机会话的取餐账户，或创建新的随机账户。已绑定电脑可用设备凭据生成额外配对码，将另一部手机接入同一取餐账户，保留原绑定和交接记录。若新手机已有另一取餐账户，会换为目标账户的新会话，不合并两个账户；原设备不会因此解绑。只有明确 reset_owner:true 才解除原绑定并撤销其交接链接。

设备、分享和手机会话表保留凭据哈希；会话原值只在 Set-Cookie 中传递，不进 JSON 或日志。创建任务的结果在有效期内暂存分享链接，供本人恢复交接，过期或撤销后清除。MCP Token 始终不上传。设备身份和 job 的 owner/device/share 归属必须检查。手机配对、下任务、撤销和退出的 POST 必须携带本站 Origin；所有请求也拒绝跨站 Sec-Fetch-Site。对公开注册、配对、刷新和任务请求限流，body 大小限制 128KB；每台设备最多三个排队任务和一个运行任务，重复订单列表任务合并。刷新只接受云端保存的 record_id，不接受朋友输入订单编号。

近期交接仅返回本人最近七天、最多二十条摘要，不包含取餐码或餐品详情。已撤销和到期记录不再返回分享链接。每次 API 请求分批清除过期结果和取餐码、三十天到期会话哈希，并删除超过七天的过期任务与分享行，查询均有相应索引。直接由 Skill 发布的链接不会额外保存原始访问凭据，仍可在近期交接中撤销。

分享刷新失败、已完成、内容改变或到期时，不展示可继续使用的旧码。该协议的公网入口由 Sites 提供 HTTPS；连接程序只向外发起 HTTPS 请求，无需公开电脑端口。

## 本地鉴权验收

web/tests/mobile-session.test.mjs 使用全部 Drizzle 迁移创建 SQLite/D1 测试适配库，检查匿名认领、同源限制、并发单次消费、账户隔离、Cookie 标志、会话到期和只注销当前手机。HTTP 集成检查通过真实本地端口完成 enroll → claim → 按响应 Cookie 查询 session → 提交订单列表任务 → logout；测试客户端手动保管 Cookie，仅使用模拟设备和餐品。浏览器对 Secure Cookie 的实际接收及跨手机体验需在部署后的 HTTPS 站点验收。
