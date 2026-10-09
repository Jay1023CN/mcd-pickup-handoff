// Owner, device and single-share authorization are isolated here. No MCP tokens or order IDs.
const TTL = 600_000, LEASE = 180_000, ONLINE = 60_000, RETENTION = 7 * 24 * 60 * 60_000;
const SESSION_TTL = 30 * 24 * 60 * 60_000, OWNER_COOKIE = "__Host-mcd_owner";
class ApiError extends Error { constructor(status, message) { super(message); this.status = status; } }
const fail = (status, message) => { throw new ApiError(status, message); };
const object = value => value && typeof value === "object" && !Array.isArray(value);
function fields(value, allowed, required = allowed) {
  if (!object(value) || Object.keys(value).some(k => !allowed.includes(k)) || required.some(k => !(k in value))) fail(422, "请求字段不符合约定。");
}
function string(value, max = 1000, empty = false) {
  if (typeof value !== "string" || value.length > max || (!empty && !value.trim())) fail(422, "请求内容不完整。");
  return value;
}
function boolean(value) { if (typeof value !== "boolean") fail(422, "请明确选择取餐码选项。"); return value; }
function iso(value) {
  string(value, 60);
  if (!/(Z|[+-]\d\d:\d\d)$/.test(value) || !Number.isFinite(Date.parse(value))) fail(422, "查询时间无效。");
  return value;
}
function id(value) { string(value, 100); if (!/^[A-Za-z0-9_-]+$/.test(value)) fail(422, "标识无效。"); return value; }
function random(bytes = 32) { return Array.from(crypto.getRandomValues(new Uint8Array(bytes)), v => v.toString(16).padStart(2, "0")).join(""); }
async function hash(value) { return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))), v => v.toString(16).padStart(2, "0")).join(""); }
function card(value) {
  fields(value, ["kind", "retrieved_at", "store_name", "store_address", "pickup_mode", "status_text", "items", "pickup_code"]);
  if (value.kind !== "mcp") fail(422, "连接程序必须返回实际查询结果。");
  iso(value.retrieved_at);
  for (const k of ["store_name", "store_address", "pickup_mode", "status_text", "pickup_code"]) string(value[k], 1000, ["store_address", "pickup_code"].includes(k));
  if (!Array.isArray(value.items) || !value.items.length || value.items.length > 100) fail(422, "餐品信息无效。");
  for (const item of value.items) {
    fields(item, ["name", "quantity"]); string(item.name);
    if (!Number.isSafeInteger(item.quantity) || item.quantity < 1 || item.quantity > 10000) fail(422, "餐品数量无效。");
  }
  return value;
}
function sanitizeResult(action, value) {
  if (action === "orders") {
    fields(value, ["orders", "queried_at", "server_time", "source"]);
    if (value.source !== "mcp" || !Array.isArray(value.orders) || value.orders.length > 100) fail(422, "订单列表无效。");
    iso(value.queried_at); if (value.server_time !== null) iso(value.server_time);
    for (const row of value.orders) {
      fields(row, ["selection", "store_name", "created_at", "status_text", "is_pickup"]);
      id(row.selection); string(row.store_name); string(row.created_at);
      if (!(typeof row.status_text === "string" || Number.isSafeInteger(row.status_text))) fail(422, "订单状态无效。");
      boolean(row.is_pickup);
    }
  } else if (action === "inspect") {
    fields(value, ["card", "status_category", "can_handoff", "has_pickup_code", "notice"]);
    card(value.card); string(value.status_category, 30); boolean(value.can_handoff); boolean(value.has_pickup_code); string(value.notice);
  } else if (action === "create") {
    fields(value, ["card", "record_id", "expires_at", "queried_at"]);
    card(value.card); id(value.record_id); iso(value.expires_at); iso(value.queried_at);
  } else if (action === "refresh") {
    fields(value, ["verified", "card", "queried_at", "notice"], ["verified", "notice"]);
    boolean(value.verified); string(value.notice);
    if (value.card !== undefined) card(value.card);
    if (value.queried_at !== undefined) iso(value.queried_at);
    if (value.verified && (!value.card || !value.queried_at)) fail(422, "复查信息不完整。");
  } else fail(422, "任务类型无效。");
  return value;
}
const safeFailure = "本次查询没有完成，请重新查询。";
const activeStatus = status => ["2", "10", "配餐中", "配餐中-已支付", "配餐中-餐厅确认配餐中"].includes(status);
const progressRanks = { accepted: 1, arrived: 2, collected: 3 };
const progressOf = row => row.progress_step ? { step: row.progress_step, updated_at: row.progress_updated_at } : undefined;
export function createMobileHandler(db, { clock = () => Date.now() } = {}) {
  const one = (sql, ...params) => db.prepare(sql).bind(...params).first();
  const run = (sql, ...params) => db.prepare(sql).bind(...params).run();
  async function cleanup(now) {
    // Expired content is redacted first; seven-day-old rows are deleted in bounded batches.
    // Expiry indexes are provided by the migration; no tables are created here.
    await db.batch([
      db.prepare("UPDATE mobile_jobs SET result=NULL WHERE id IN (SELECT id FROM mobile_jobs WHERE state IN ('done','failed') AND result IS NOT NULL AND expires_at<=? ORDER BY expires_at LIMIT 25)").bind(now),
      db.prepare("UPDATE mobile_shares SET verified=0,card=json_set(card,'$.pickup_code','') WHERE id IN (SELECT id FROM mobile_shares WHERE expires_at<=? AND (verified!=0 OR json_extract(card,'$.pickup_code')!='') ORDER BY expires_at LIMIT 25)").bind(now),
      db.prepare("DELETE FROM mobile_rate_limits WHERE key IN (SELECT key FROM mobile_rate_limits WHERE expires_at<=? ORDER BY expires_at LIMIT 50)").bind(now),
      db.prepare("DELETE FROM mobile_jobs WHERE id IN (SELECT id FROM mobile_jobs WHERE expires_at<? ORDER BY expires_at LIMIT 50)").bind(now - RETENTION),
      db.prepare("DELETE FROM mobile_shares WHERE id IN (SELECT id FROM mobile_shares WHERE expires_at<? ORDER BY expires_at LIMIT 25)").bind(now - RETENTION),
      db.prepare("DELETE FROM mobile_owner_sessions WHERE token_hash IN (SELECT token_hash FROM mobile_owner_sessions WHERE expires_at<=? ORDER BY expires_at LIMIT 50)").bind(now),
    ]);
  }
  async function session(req, now) {
    const cookies = (req.headers.get("cookie") || "").split(";").map(part => part.trim()).filter(part => part.startsWith(OWNER_COOKIE + "="));
    if (cookies.length !== 1) return null;
    const value = cookies[0].slice(OWNER_COOKIE.length + 1);
    if (!/^[a-f0-9]{64}$/.test(value)) return null;
    return one("SELECT token_hash,owner_id,expires_at FROM mobile_owner_sessions WHERE token_hash=? AND expires_at>?", await hash(value), now);
  }
  async function owner(req, now) { const current = await session(req, now); if (!current) fail(401, "请先用电脑配对码连接这台手机。"); return current.owner_id; }
  function sessionCookie(token, expires) { return `${OWNER_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${token ? SESSION_TTL / 1000 : 0}; Expires=${new Date(expires).toUTCString()}`; }
  function bearer(req) { const v = req.headers.get("authorization") || ""; if (!/^Bearer [a-f0-9]{64}$/.test(v)) fail(401, "访问凭据无效。"); return v.slice(7); }
  async function device(req, deviceId) {
    const row = await one("SELECT * FROM mobile_devices WHERE id=? AND token_hash=?", id(deviceId), await hash(bearer(req)));
    if (!row) fail(401, "连接凭据无效。"); return row;
  }
  async function share(req, shareId, now) {
    const row = await one("SELECT * FROM mobile_shares WHERE id=? AND token_hash=?", id(shareId), await hash(bearer(req)));
    if (!row) fail(404, "交接链接无效。");
    if (row.revoked || row.expires_at <= now) fail(410, "交接链接已撤销或到期。"); return row;
  }
  async function online(deviceId, now) {
    const d = await one("SELECT heartbeat FROM mobile_devices WHERE id=?", deviceId);
    return !!d && d.heartbeat > now - ONLINE;
  }
  async function rate(key, limit, now, duration = 60_000) {
    const k = `${key}:${Math.floor(now / duration)}`;
    const row = await one("INSERT INTO mobile_rate_limits(key,count,expires_at) VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET count=count+1 RETURNING count", k, now + duration);
    if (row.count > limit) fail(429, "操作太频繁，请稍后重试。");
  }
  async function invalidate(s) {
    const c = JSON.parse(s.card); c.pickup_code = "";
    await run("UPDATE mobile_shares SET verified=0,card=? WHERE id=?", JSON.stringify(c), s.id);
  }
  async function expiredJobs(deviceId, now) {
    const rows = await db.prepare("SELECT share_id FROM mobile_jobs WHERE device_id=? AND state IN ('queued','running','completing') AND (expires_at<=? OR (state IN ('running','completing') AND lease_until<=?))").bind(deviceId, now, now).all();
    for (const j of rows.results || []) if (j.share_id) {
      const s = await one("SELECT * FROM mobile_shares WHERE id=?", j.share_id); if (s) await invalidate(s);
    }
    await run("UPDATE mobile_jobs SET state='failed',error=?,result=NULL WHERE device_id=? AND state IN ('queued','running','completing') AND (expires_at<=? OR (state IN ('running','completing') AND lease_until<=?))", safeFailure, deviceId, now, now);
    await run("UPDATE mobile_devices SET running_job=NULL,lock_until=0 WHERE id=? AND (lock_until<=? OR running_job IN (SELECT id FROM mobile_jobs WHERE state IN ('done','failed')))", deviceId, now);
  }
  async function enqueue(ownerId, deviceId, action, args, now, shareId = null, expires = now + TTL) {
    const pendingOrders = () => one("SELECT id FROM mobile_jobs WHERE device_id=? AND owner_id=? AND action='orders' AND state IN ('queued','running','completing') AND expires_at>? AND (state='queued' OR lease_until>?) ORDER BY created_at LIMIT 1", deviceId, ownerId, now, now);
    if (action === "orders") {
      const pending = await pendingOrders(); if (pending) return { job_id: pending.id };
    }
    const jobId = random(16);
    const inserted = await one("INSERT INTO mobile_jobs(id,owner_id,device_id,share_id,action,args,state,created_at,expires_at) SELECT ?,?,?,?,?,?,'queued',?,? WHERE (SELECT count(*) FROM mobile_jobs WHERE device_id=? AND state='queued' AND expires_at>?)<3 AND (SELECT count(*) FROM mobile_jobs WHERE device_id=? AND state IN ('running','completing') AND expires_at>? AND lease_until>?)<=1 AND (?!='orders' OR NOT EXISTS(SELECT 1 FROM mobile_jobs WHERE device_id=? AND owner_id=? AND action='orders' AND state IN ('queued','running','completing') AND expires_at>? AND (state='queued' OR lease_until>?))) RETURNING id", jobId, ownerId, deviceId, shareId, action, JSON.stringify(args), now, expires, deviceId, now, deviceId, now, now, action, deviceId, ownerId, now, now);
    if (!inserted) {
      if (action === "orders") { const pending = await pendingOrders(); if (pending) return { job_id: pending.id }; }
      fail(429, "查询任务已排满，请等待当前查询完成。");
    }
    return { job_id: jobId };
  }
  async function shareRecord(ownerId, deviceId, value, now, jobId = null) {
    const result = sanitizeResult("create", value);
    if (!activeStatus(result.card.status_text)) fail(422, "这笔订单现在不能生成取餐交接链接。");
    const expires = Math.min(Date.parse(result.expires_at), now + TTL);
    if (expires <= now) fail(410, "交接记录已过期，请重新生成。");
    const shareId = random(16), token = random();
    return {
      statement: db.prepare("INSERT INTO mobile_shares(id,owner_id,device_id,token_hash,record_id,card,queried_at,expires_at,verified,revoked,refreshed_at) SELECT ?,?,?,?,?,?,?,?,1,0,0 WHERE EXISTS(SELECT 1 FROM mobile_devices WHERE id=? AND owner_id=?) AND (? IS NULL OR EXISTS(SELECT 1 FROM mobile_jobs WHERE id=? AND device_id=? AND owner_id=? AND state='completing' AND lease_until>? AND expires_at>?))").bind(shareId, ownerId, deviceId, await hash(token), result.record_id, JSON.stringify(result.card), result.queried_at, expires, deviceId, ownerId, jobId, jobId, deviceId, ownerId, now, now),
      result: { card: result.card, expires_at: new Date(expires).toISOString(), share: { id: shareId, url: `/take/${shareId}#access=${token}` } },
    };
  }
  async function jobView(job, now) {
    await expiredJobs(job.device_id, now);
    const current = await one("SELECT * FROM mobile_jobs WHERE id=?", job.id);
    if (current.expires_at <= now) {
      // Targeted deletion also protects the requested result beyond cleanup's batch limit.
      await run("UPDATE mobile_jobs SET result=NULL WHERE id=?", current.id);
      return { state: "failed", error: "查询结果已过期，请重新查询。" };
    }
    const state = current.state === "completing" ? "running" : current.state;
    if (state === "done" && !current.result) return { state: "failed", error: current.error || "查询结果已撤销，请重新查询。" };
    const result = state === "done" ? JSON.parse(current.result) : undefined;
    const resultShareId = current.share_id || (current.action === "create" ? result?.share?.id : null);
    if (result?.card && resultShareId) {
      const s = await one("SELECT progress_step FROM mobile_shares WHERE id=? AND owner_id=? AND device_id=?", resultShareId, current.owner_id, current.device_id);
      if (s?.progress_step === "collected") {
        result.card.pickup_code = "";
        if (result.share) delete result.share.url;
      }
    }
    return { state, ...(state === "done" ? { result } : {}), ...(state === "failed" ? { error: current.error || safeFailure } : {}) };
  }
  async function dispatch(req, path, body, now) {
    const method = req.method;
    if (path === "/session" && method === "GET") {
      const current = await session(req, now), userId = current?.owner_id;
      const d = userId && await one("SELECT id,heartbeat FROM mobile_devices WHERE owner_id=? ORDER BY heartbeat DESC LIMIT 1", userId);
      return { authenticated: !!userId, ...(userId ? { user: { id: userId, name: "我的取餐" } } : {}), ...(d ? { device: { id: d.id, online: d.heartbeat > now - ONLINE } } : {}) };
    }
    if (path === "/session/logout" && method === "POST") {
      fields(body, []);
      const current = await session(req, now);
      if (current) await run("DELETE FROM mobile_owner_sessions WHERE token_hash=?", current.token_hash);
      return Response.json({ ok: true }, { headers: { "Set-Cookie": sessionCookie("", 0) } });
    }
    if (path === "/devices/enroll" && method === "POST") {
      fields(body, []);
      await rate(`enroll:${req.headers.get("cf-connecting-ip") || "global"}`, 5, now, TTL);
      const deviceId = random(16), token = random(), code = random(8), expires = now + TTL;
      await run("INSERT INTO mobile_devices(id,token_hash,pair_hash,pair_expires,heartbeat,created_at) VALUES(?,?,?,?,?,?)", deviceId, await hash(token), await hash(code), expires, now, now);
      return { device_id: deviceId, device_token: token, pair_code: code, expires_at: new Date(expires).toISOString() };
    }
    if (path === "/devices/claim" && method === "POST") {
      fields(body, ["pair_code"]); string(body.pair_code, 16);
      if (!/^[a-f0-9]{16}$/.test(body.pair_code)) fail(422, "配对码应为16位字母和数字。");
      await rate(`claim:${req.headers.get("cf-connecting-ip") || "global"}`, 10, now);
      const current = await session(req, now), pairHash = await hash(body.pair_code);
      const d = await one("SELECT id,owner_id FROM mobile_devices WHERE pair_hash=? AND pair_expires>?", pairHash, now);
      if (!d) fail(410, "配对码已使用、已过期或不存在。");
      // An unbound device creates a fresh owner, including after explicit reset.
      // Reusing an old phone's cookie here would restore other unrepaired phones.
      const ownerId = d.owner_id || random(16), token = random(), tokenHash = await hash(token), expires = now + SESSION_TTL;
      const statements = [
        db.prepare("UPDATE mobile_devices SET owner_id=COALESCE(owner_id,?),pair_hash=NULL WHERE id=? AND pair_hash=? AND pair_expires>?").bind(ownerId, d.id, pairHash, now),
        db.prepare("INSERT INTO mobile_owner_sessions(token_hash,owner_id,created_at,expires_at) SELECT ?,owner_id,?,? FROM mobile_devices WHERE id=? AND owner_id=? AND changes()=1").bind(tokenHash, now, expires, d.id, ownerId),
      ];
      if (current) statements.push(db.prepare("DELETE FROM mobile_owner_sessions WHERE token_hash=? AND EXISTS(SELECT 1 FROM mobile_owner_sessions WHERE token_hash=?)").bind(current.token_hash, tokenHash));
      const committed = await db.batch(statements);
      if (!committed[0]?.meta?.changes || !committed[1]?.meta?.changes) fail(410, "配对码已使用、已过期或不存在。");
      return Response.json({ device_id: d.id }, { headers: { "Set-Cookie": sessionCookie(token, expires) } });
    }
    if (path === "/devices/renew" && method === "POST") {
      fields(body, ["device_id", "reset_owner"]); boolean(body.reset_owner);
      const d = await device(req, body.device_id);
      await rate(`renew:${d.id}`, 5, now, TTL);
      const code = random(8), expires = now + TTL;
      const statements = [];
      if (body.reset_owner) {
        statements.push(db.prepare("UPDATE mobile_shares SET revoked=1,verified=0,card=json_set(card,'$.pickup_code','') WHERE device_id=?").bind(d.id));
        statements.push(db.prepare("UPDATE mobile_jobs SET state='failed',result=NULL,error=? WHERE device_id=?").bind("电脑连接已重新配对。", d.id));
      }
      statements.push(db.prepare("UPDATE mobile_devices SET owner_id=CASE WHEN ?=1 THEN NULL ELSE owner_id END,pair_hash=?,pair_expires=?,running_job=CASE WHEN ?=1 THEN NULL ELSE running_job END,lock_until=CASE WHEN ?=1 THEN 0 ELSE lock_until END WHERE id=?").bind(body.reset_owner ? 1 : 0, await hash(code), expires, body.reset_owner ? 1 : 0, body.reset_owner ? 1 : 0, d.id));
      await db.batch(statements);
      const current = await one("SELECT owner_id,pair_hash FROM mobile_devices WHERE id=?", d.id);
      if (current.pair_hash !== await hash(code)) fail(409, "配对码已更新，请重试。");
      return { paired: !!current.owner_id, pair_code: code, expires_at: new Date(expires).toISOString() };
    }
    if (path === "/devices/poll" && method === "POST") {
      fields(body, ["device_id"]); const d = await device(req, body.device_id);
      await rate(`poll:${d.id}`, 90, now);
      await run("UPDATE mobile_devices SET heartbeat=? WHERE id=?", now, d.id);
      if (!d.owner_id) return { paired: false, job: null };
      await expiredJobs(d.id, now);
      const claimed = await one("UPDATE mobile_devices SET running_job=(SELECT id FROM mobile_jobs WHERE device_id=? AND state='queued' AND expires_at>? ORDER BY created_at,id LIMIT 1),lock_until=? WHERE id=? AND running_job IS NULL AND EXISTS(SELECT 1 FROM mobile_jobs WHERE device_id=? AND state='queued' AND expires_at>?) RETURNING running_job", d.id, now, now + LEASE, d.id, d.id, now);
      if (!claimed?.running_job) return { paired: true, job: null };
      const j = await one("UPDATE mobile_jobs SET state='running',lease_until=? WHERE id=? AND device_id=? AND state='queued' AND expires_at>? RETURNING id,action,args", now + LEASE, claimed.running_job, d.id, now);
      if (!j) return { paired: true, job: null };
      return { paired: true, job: { id: j.id, action: j.action, args: JSON.parse(j.args) } };
    }
    if (path === "/devices/share" && method === "POST") {
      fields(body, ["device_id", "card", "record_id", "expires_at", "queried_at"]);
      const d = await device(req, body.device_id);
      if (!d.owner_id) fail(409, "请先在网页认领这个连接。");
      await rate(`publish:${d.id}`, 10, now);
      const { device_id: ignored, ...value } = body;
      void ignored;
      const publication = await shareRecord(d.owner_id, d.id, value, now);
      const committed = await db.batch([publication.statement, db.prepare("UPDATE mobile_devices SET heartbeat=? WHERE id=?").bind(now, d.id)]);
      if (!committed[0]?.meta?.changes) fail(409, "连接配对已变化，请重新查询。");
      return publication.result;
    }
    if (path === "/devices/complete" && method === "POST") {
      fields(body, ["device_id", "job_id", "result", "error"], ["device_id", "job_id"]);
      const d = await device(req, body.device_id); id(body.job_id);
      await expiredJobs(d.id, now);
      const j = await one("SELECT * FROM mobile_jobs WHERE id=? AND device_id=? AND owner_id=?", body.job_id, d.id, d.owner_id);
      if (!j) fail(409, "任务已失效或不属于这个连接。");
      if (["done", "failed"].includes(j.state)) return { ok: true };
      if ((body.result === undefined) === (body.error === undefined)) fail(422, "只能提交结果或错误其中一项。");
      if (j.state !== "running" || j.lease_until <= now || j.expires_at <= now) fail(409, "任务已失效或不属于这个连接。");
      let result, error;
      try {
        if (body.error !== undefined) { string(body.error); error = safeFailure; }
        else result = sanitizeResult(j.action, body.result);
      } catch (e) {
        if (!(e instanceof ApiError)) throw e;
        error = "连接程序返回了无效字段，未保存结果。";
      }
      const claimed = await one("UPDATE mobile_jobs SET state='completing' WHERE id=? AND state='running' AND lease_until>? RETURNING id", j.id, now);
      if (!claimed) fail(409, "任务结果已提交。");
      const statements = [];
      if (j.action === "create" && !error) {
        if (JSON.parse(j.args).include_pickup_code === false) result.card.pickup_code = "";
        try {
          const publication = await shareRecord(j.owner_id, d.id, result, now, j.id);
          statements.push(publication.statement); result = publication.result;
        } catch (e) { if (!(e instanceof ApiError)) throw e; error = e.message; }
      }
      if (j.action === "refresh") {
        const s = await one("SELECT * FROM mobile_shares WHERE id=? AND device_id=?", j.share_id, d.id);
        if (!s || s.revoked || s.expires_at <= now) error = "交接链接已撤销或到期。";
        if (s) {
          const latest = result?.card || JSON.parse(s.card);
          const verified = !!(!error && result?.verified && activeStatus(latest.status_text) && s.expires_at > now && !s.revoked);
          if (!verified) latest.pickup_code = "";
          const queriedAt = result?.queried_at || s.queried_at;
          statements.push(db.prepare("UPDATE mobile_shares SET card=?,queried_at=?,verified=? WHERE id=? AND revoked=0 AND expires_at>?").bind(JSON.stringify(latest), queriedAt, verified ? 1 : 0, s.id, now));
          if (!error) result = { verified, card: latest, queried_at: queriedAt, notice: result.notice };
        }
      }
      statements.push(db.prepare("UPDATE mobile_jobs SET state=?,result=?,error=? WHERE id=? AND state='completing'").bind(error ? "failed" : "done", error ? null : JSON.stringify(result), error || null, j.id));
      statements.push(db.prepare("UPDATE mobile_devices SET running_job=NULL,lock_until=0,heartbeat=? WHERE id=? AND running_job=?").bind(now, d.id, j.id));
      try { await db.batch(statements); }
      catch (e) {
        // D1 batch rollback leaves no issued share. Restore the owned job for outbox retry.
        await run("UPDATE mobile_jobs SET state='running' WHERE id=? AND device_id=? AND owner_id=? AND state='completing' AND lease_until>? AND expires_at>?", j.id, d.id, d.owner_id, now, now);
        throw e;
      }
      return { ok: true };
    }
    if (path === "/jobs" && method === "POST") {
      const userId = await owner(req, now); fields(body, ["action", "args"]);
      if (!["orders", "inspect", "create"].includes(body.action)) fail(422, "任务类型无效。");
      fields(body.args, body.action === "orders" ? [] : body.action === "inspect" ? ["selection"] : ["selection", "include_pickup_code"]);
      if (body.action !== "orders") id(body.args.selection);
      if (body.action === "create") boolean(body.args.include_pickup_code);
      await rate(`jobs:${userId}`, 20, now);
      const d = await one("SELECT * FROM mobile_devices WHERE owner_id=? ORDER BY heartbeat DESC LIMIT 1", userId);
      if (!d) fail(409, "请先连接电脑上的麦当劳账户。");
      if (!(d.heartbeat > now - ONLINE)) fail(503, "电脑连接已离线，请先启动连接程序。");
      return enqueue(userId, d.id, body.action, body.args, now);
    }
    if (path === "/shares" && method === "GET") {
      const userId = await owner(req, now);
      const rows = await db.prepare("SELECT id,device_id,card,queried_at,expires_at,revoked,verified,progress_step,progress_updated_at FROM mobile_shares WHERE owner_id=? AND expires_at>=? ORDER BY expires_at DESC,id DESC LIMIT 20").bind(userId, now - 7 * 24 * 60 * 60_000).all();
      const entries = [];
      for (const s of rows.results || []) {
        const c = JSON.parse(s.card), connected = await online(s.device_id, now);
        const active = !s.revoked && s.expires_at > now;
        const entry = { id: s.id, store_name: c.store_name, status_text: c.status_text, queried_at: s.queried_at, expires_at: new Date(s.expires_at).toISOString(), revoked: !!s.revoked, verified: !!s.verified && active && connected, online: connected };
        if (progressOf(s)) entry.progress = progressOf(s);
        if (active && s.progress_step !== "collected") {
          const j = await one("SELECT result FROM mobile_jobs WHERE device_id=? AND owner_id=? AND action='create' AND state='done' AND expires_at>? AND json_extract(result,'$.share.id')=? ORDER BY created_at DESC LIMIT 1", s.device_id, userId, now, s.id);
          const link = j?.result && JSON.parse(j.result).share?.url;
          if (typeof link === "string" && new RegExp(`^/take/${s.id}#access=[a-f0-9]{64}$`).test(link)) entry.url = link;
        }
        entries.push(entry);
      }
      return { entries };
    }
    let match = path.match(/^\/jobs\/([a-f0-9]{32})$/);
    if (match && method === "GET") {
      const userId = await owner(req, now); const j = await one("SELECT * FROM mobile_jobs WHERE id=? AND owner_id=? AND share_id IS NULL", match[1], userId);
      if (!j) fail(404, "任务不存在。"); return jobView(j, now);
    }
    match = path.match(/^\/shares\/([a-f0-9]{32})\/(view|refresh|revoke|progress|jobs\/([a-f0-9]{32}))$/);
    if (match) {
      const [, shareId, operation, jobId] = match;
      if (operation === "revoke" && method === "POST") {
        const userId = await owner(req, now); fields(body, []);
        const s = await one("SELECT * FROM mobile_shares WHERE id=? AND owner_id=?", shareId, userId);
        if (!s) fail(404, "交接链接不存在。");
        const c = JSON.parse(s.card); c.pickup_code = "";
        await db.batch([
          db.prepare("UPDATE mobile_shares SET revoked=1,verified=0,card=? WHERE id=?").bind(JSON.stringify(c), shareId),
          db.prepare("UPDATE mobile_jobs SET state='failed',result=NULL,error=? WHERE share_id=?").bind("交接链接已撤销。", shareId),
          db.prepare("UPDATE mobile_jobs SET state='failed',result=NULL,error=? WHERE device_id=? AND owner_id=? AND action='create' AND json_extract(result,'$.share.id')=?").bind("交接链接已撤销。", s.device_id, userId, shareId),
        ]);
        return { ok: true };
      }
      const s = await share(req, shareId, now);
      if (operation === "progress" && method === "POST") {
        fields(body, ["step"]);
        if (typeof body.step !== "string" || !Object.hasOwn(progressRanks, body.step)) fail(422, "取餐反馈步骤无效。");
        await rate(`progress:${shareId}`, 30, now);
        const rank = progressRanks[body.step];
        const changed = await one("UPDATE mobile_shares SET progress_step=?,progress_updated_at=? WHERE id=? AND revoked=0 AND expires_at>? AND CASE progress_step WHEN 'accepted' THEN 1 WHEN 'arrived' THEN 2 WHEN 'collected' THEN 3 ELSE 0 END<? RETURNING progress_step,progress_updated_at", body.step, new Date(now).toISOString(), shareId, now, rank);
        if (changed) return { progress: progressOf(changed) };
        const current = await one("SELECT progress_step,progress_updated_at,revoked,expires_at FROM mobile_shares WHERE id=?", shareId);
        if (!current || current.revoked || current.expires_at <= now) fail(410, "交接链接已撤销或到期。");
        if (current.progress_step !== body.step) fail(409, "朋友的取餐反馈已更新，请刷新查看。");
        return { progress: progressOf(current) };
      }
      if (operation === "view" && method === "POST") {
        fields(body, []); await expiredJobs(s.device_id, now);
        const current = await one("SELECT * FROM mobile_shares WHERE id=?", shareId);
        const connected = await online(s.device_id, now), c = JSON.parse(current.card);
        if (!connected || !current.verified || current.progress_step === "collected") c.pickup_code = "";
        return { card: c, expires_at: new Date(s.expires_at).toISOString(), queried_at: current.queried_at, verified: !!current.verified && connected, online: connected, ...(progressOf(current) ? { progress: progressOf(current) } : {}) };
      }
      if (operation === "refresh" && method === "POST") {
        fields(body, []); await rate(`refresh:${shareId}`, 6, now);
        await expiredJobs(s.device_id, now);
        if (!(await online(s.device_id, now))) { await invalidate(s); fail(503, "电脑连接已离线，暂时不能复查。"); }
        const locked = await one("UPDATE mobile_shares SET refreshed_at=? WHERE id=? AND revoked=0 AND expires_at>? AND refreshed_at<=? AND NOT EXISTS(SELECT 1 FROM mobile_jobs WHERE share_id=? AND state IN ('queued','running','completing')) RETURNING id", now, shareId, now, now - 5000, shareId);
        if (!locked) fail(429, "正在复查，请稍等。");
        await invalidate(s);
        return enqueue(s.owner_id, s.device_id, "refresh", { record_id: s.record_id }, now, shareId, s.expires_at);
      }
      if (jobId && method === "GET") {
        const j = await one("SELECT * FROM mobile_jobs WHERE id=? AND share_id=?", jobId, shareId);
        if (!j) fail(404, "复查任务不存在。"); return jobView(j, now);
      }
    }
    fail(404, "接口不存在。");
  }
  return async function handle(request) {
    try {
      const url = new URL(request.url), prefix = "/api/mobile";
      if (!(url.pathname === prefix || url.pathname.startsWith(prefix + "/"))) fail(404, "接口不存在。");
      if (!["GET", "POST"].includes(request.method)) fail(405, "请求方式不支持。");
      const origin = request.headers.get("origin");
      if (origin && origin !== url.origin) fail(403, "请从本站打开。");
      const privatePost = ["/devices/claim", "/session/logout", "/jobs"].includes(url.pathname.slice(prefix.length)) || /^\/shares\/[a-f0-9]{32}\/revoke$/.test(url.pathname.slice(prefix.length));
      if (request.method === "POST" && privatePost && origin !== url.origin) fail(403, "请从本站打开。");
      const fetchSite = request.headers.get("sec-fetch-site");
      if (fetchSite && !["same-origin", "none"].includes(fetchSite)) fail(403, "请从本站打开。");
      let body = null;
      if (request.method === "POST") {
        if (!(request.headers.get("content-type") || "").startsWith("application/json")) fail(415, "请发送 JSON 内容。");
        const stated = Number(request.headers.get("content-length") || 0);
        if (!Number.isFinite(stated) || stated > 131072) fail(413, "请求内容过大。");
        const reader = request.body?.getReader(); const parts = []; let size = 0;
        if (reader) while (true) {
          const { done, value } = await reader.read(); if (done) break;
          size += value.byteLength; if (size > 131072) { await reader.cancel(); fail(413, "请求内容过大。"); } parts.push(value);
        }
        const bytes = new Uint8Array(size); let offset = 0; for (const part of parts) { bytes.set(part, offset); offset += part.length; }
        try { body = JSON.parse(new TextDecoder().decode(bytes)); } catch { fail(400, "JSON 内容无效。"); }
      }
      const now = clock();
      await cleanup(now);
      const data = await dispatch(request, url.pathname.slice(prefix.length), body, now);
      if (data instanceof Response) {
        data.headers.set("Cache-Control", "no-store"); data.headers.set("X-Content-Type-Options", "nosniff"); data.headers.set("Referrer-Policy", "no-referrer");
        return data;
      }
      return Response.json(data, { headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer" } });
    } catch (e) {
      return Response.json({ error: e instanceof ApiError ? e.message : "服务暂时不可用，请稍后重试。" }, { status: e instanceof ApiError ? e.status : 503, headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
    }
  };
}
