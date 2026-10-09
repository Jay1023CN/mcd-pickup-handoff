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
POST /shares/{id}/progress {step:'accepted'|'arrived'|'collected'}（Bearer 分享凭据）-> {progress:{step,updated_at}}
POST /shares/{id}/revoke {}（手机会话，归属检查）-> {ok:true}
GET /shares（手机会话）-> {owner_id:string,entries:[{id,store_name,status_text,queried_at,expires_at,revoked,verified,online,url?:string}]}

owner_id 表明这次响应实际属于哪个账户，匿名请求仍返回 401。手机在读取、自动轮询和恢复链接时，先核验它与当前页面的 ownerId 一致，再更新列表、卡片反馈和恢复链接。若另一标签页刚换了 Cookie，导致 /session 查到 A、随后的 /shares 返回 B，页面会取消旧操作并重新加载账户，避免同时显示两人的信息。自动轮询只读取云端摘要，不调用 MCP；复制、操作或切到后台时暂停，暂时失败后退避重试，所有链接到期或已取餐后停止。

分享 view 和近期 entries 可包含 progress:{step,updated_at}，表示朋友手动反馈的“已接手”“已到店”“反馈已取餐”。可直接反馈已取餐，相同步骤重复提交不会改变首次反馈时间，倒退返回 409。更新通过单笔分享凭据授权，已到期或撤销拒绝，电脑离线或尚未复查也能反馈；反馈不会调用 MCP、改动官方订单状态、查询时点或 verified。反馈已取餐后，公共 view、刷新任务响应及本人重新读取原创建任务时均隐藏取餐码，原创建任务与近期记录不再提供该张交接的再次分享 URL；保留的官方查询结果与手动反馈分开存储，不能把手动反馈当成官方订单完成。

创建 args {selection:string,include_pickup_code:boolean}；详情 args {selection:string}；列表 args {}。桥接调用 HandoffService，返回：orders 与 inspect 原结果；create 为 {card,record_id,expires_at,queried_at}；refresh args {record_id:string} 为 {verified,card,queried_at,notice}。云端完成 create 任务时把 record_id 留在数据库，发给网页的 result 仅为 {card,expires_at,share:{id,url}}，url 含分享凭据在 fragment，格式 /take/{id}#access=...。

配对码为随机十六位小写十六进制，十分钟过期，claim 后立即失效；并发认领只能有一个成功。未绑定电脑首次配对或明确重置后认领时创建全新的随机取餐账户，不继承手机的旧 Cookie 账户，原来的其他手机必须重新配对才能访问这台电脑。已绑定电脑可用设备凭据生成额外配对码，将另一部手机接入同一取餐账户，保留原绑定和交接记录。若新手机已有另一取餐账户，会换为目标账户的新会话，不合并两个账户；原设备不会因此解绑。只有明确 reset_owner:true 才解除原绑定并撤销其交接链接。

设备、分享和手机会话的鉴权凭据保留 SHA256 哈希；会话原值只在 Set-Cookie 中传递，不进 JSON 或日志。网页创建和 Skill 直接发布统一在分享行的 delivery_url 中短期保存含访问凭据的链接原文，供归属一致的手机账户恢复；公开分享仍独立核验 token_hash，不使用 delivery_url 作为鉴权记录。创建任务仅保存 share.id，读取时按 owner/device 归属从分享行补入有效 URL，任务结果不再重复存储访问凭据。到期、撤销、朋友反馈已取餐或明确重置电脑绑定时，delivery_url 清为 NULL，不再返回原链接。MCP Token 始终不上传。设备身份和 job 的 owner/device/share 归属必须检查。手机配对、下任务、撤销和退出的 POST 必须携带本站 Origin；所有请求也拒绝跨站 Sec-Fetch-Site。对公开注册、配对、刷新和任务请求限流，body 大小限制 128KB；每台设备最多三个排队任务和一个运行任务，重复订单列表任务合并。刷新只接受云端保存的 record_id，不接受朋友输入订单编号。

近期交接仅返回本人最近七天、最多二十条摘要，不包含取餐码或餐品详情。已撤销和到期记录不再返回分享链接。每次 API 请求分批清除过期结果和取餐码、三十天到期会话哈希，并删除超过七天的过期任务与分享行，查询均有相应索引。Skill 直接发布和网页创建均可在有效期内恢复同一链接并撤销。一个 owner/device 下同一个本机 record_id 只发行一次：重试返回既有卡片、截止时间和链接，不更新官方信息或延长有效期；若原记录包含取餐码、这次 direct 请求传空码或网页明确排除取餐码，拒绝复用，不返回原 URL，须重新查询生成新记录。并发发行也以事务中实际胜出的记录核验：direct 返回 409，网页任务安全失败并释放锁，不改原分享；已到期、撤销或反馈已取餐的原记录不能重新发行，须本机重新查询生成新记录。分享表 issue_key 使用 nullable 部分唯一索引；0006 迁移遇到历史重复 record_id 时保留所有行，仅选一个可恢复的有效记录作为 canonical，其余保留摘要。旧网页任务中归属一致且仍有效的链接迁入 delivery_url，旧任务中的 URL 清除；旧 Skill 原文链接从未保存，无法从哈希重建，因此旧记录只保留查看摘要和撤销入口。

分享刷新失败、已完成、内容改变或到期时，不展示可继续使用的旧码。该协议的公网入口由 Sites 提供 HTTPS；连接程序只向外发起 HTTPS 请求，无需公开电脑端口。

## 本地鉴权验收

web/tests/mobile-session.test.mjs 使用全部 Drizzle 迁移创建 SQLite/D1 测试适配库，检查匿名认领、同源限制、并发单次消费、账户隔离、Cookie 标志、会话到期和只注销当前手机。HTTP 集成检查通过真实本地端口完成 enroll → claim → 按响应 Cookie 查询 session → 提交订单列表任务 → logout；测试客户端手动保管 Cookie，仅使用模拟设备和餐品。浏览器对 Secure Cookie 的实际接收及跨手机体验需在部署后的 HTTPS 站点验收。

## 分享交付验收

web/tests/mobile-delivery.test.mjs 覆盖直接发布恢复、同记录并发与串行重试、网页创建与 Skill 同时发布、账户与设备隔离，以及撤销、到期、已取餐反馈和重置后的 URL 物理清理。使用已应用 0000–0005 且包含历史重复记录的数据库验证 0006 迁移不会删除历史或恢复无效链接；过期 delivery_url 每次请求最多清理二十五条，并使用专用部分索引。近期列表与创建任务投影均不再返回失效 URL，超过七天的过期分享仍按既有规则物理删除。

v0.5 验收还覆盖隐藏码请求与含码发行在两种提交顺序下的竞争：已有含码记录不能借重试变成“隐藏码分享”，冲突请求不取得原 URL，网页失败任务释放锁并可确认重发回执。原本隐藏码的记录仍能幂等恢复。owner_id 的读取、轮询和恢复链接三个身份竞态也已在全模拟 API 的 Chromium 页面通过；63 项 Node 测试通过。Sites v4 源提交 b647676ac13972dabff5b8a4c92681130a2b6204 已构建，尚未部署，发布与 CI 结果另记在 VALIDATION.md。
