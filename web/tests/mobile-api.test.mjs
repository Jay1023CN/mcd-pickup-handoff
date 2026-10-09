import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { createMobileHandler } from "../lib/mobile-api.mjs";

// SQLite executes the same statements as D1; a batch is one transaction.
export function testDatabase() {
  const connection = new DatabaseSync(":memory:");
  const migrations = new URL("../drizzle/", import.meta.url);
  for (const name of readdirSync(migrations).filter(name => name.endsWith(".sql")).sort()) connection.exec(readFileSync(new URL(name, migrations), "utf8"));
  function prepare(sql) {
    let params = [];
    const statement = {
      bind(...values) { params = values; return statement; },
      async first() { return connection.prepare(sql).get(...params) || null; },
      async all() { return { results: connection.prepare(sql).all(...params) }; },
      run() { return { meta: connection.prepare(sql).run(...params) }; },
    };
    return statement;
  }
  return {
    connection, prepare,
    async batch(statements) {
      connection.exec("BEGIN");
      try { const result = []; for (const statement of statements) result.push(statement.run()); connection.exec("COMMIT"); return result; }
      catch (error) { connection.exec("ROLLBACK"); throw error; }
    },
  };
}
function fixture() {
  const db = testDatabase();
  let now = Date.parse("2026-10-09T16:00:00Z");
  const handle = createMobileHandler(db, { clock: () => now });
  const cookieTokens = new Map();
  async function cookieFor(user) {
    if (!cookieTokens.has(user)) {
      const token = Array.from(crypto.getRandomValues(new Uint8Array(32)), v => v.toString(16).padStart(2, "0")).join("");
      cookieTokens.set(user, token);
      const digest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token))), v => v.toString(16).padStart(2, "0")).join("");
      db.connection.prepare("INSERT INTO mobile_owner_sessions(token_hash,owner_id,created_at,expires_at) VALUES(?,?,?,?)").run(digest, user, now, now + 30 * 24 * 60 * 60_000);
    }
    return `__Host-mcd_owner=${cookieTokens.get(user)}`;
  }
  async function call(path, body, { user = null, token = null, headers = {}, method = body === undefined ? "GET" : "POST" } = {}) {
    const request = new Request(`https://handoff.test/api/mobile${path}`, {
      method,
      headers: { ...(body !== undefined ? { "content-type": "application/json", origin: "https://handoff.test" } : {}), ...(user ? { cookie: await cookieFor(user) } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const response = await handle(request);
    if (user && response.headers.get("set-cookie")) cookieTokens.set(user, response.headers.get("set-cookie").split(";")[0].split("=")[1]);
    return { status: response.status, data: await response.json(), headers: response.headers };
  }
  return { db, handle, call, time: () => now, advance: n => now += n };
}
async function paired(f, user = "owner-a") {
  const response = await f.call("/devices/enroll", {}); assert.equal(response.status, 200);
  const device = response.data;
  assert.equal((await f.call("/devices/claim", { pair_code: device.pair_code }, { user })).status, 200);
  return device;
}
function mockCard(f, pickupCode = "TEST-CODE") {
  return { kind: "mcp", retrieved_at: new Date(f.time()).toISOString(), store_name: "测试餐厅", store_address: "测试门店地址", pickup_mode: "外带", status_text: "配餐中", items: [{ name: "测试汉堡", quantity: 2 }], pickup_code: pickupCode };
}
async function startJob(f, d, action, args, user = "owner-a") {
  const response = await f.call("/jobs", { action, args }, { user }); assert.equal(response.status, 200);
  const poll = await f.call("/devices/poll", { device_id: d.device_id }, { token: d.device_token });
  assert.equal(poll.status, 200); assert.equal(poll.data.job.id, response.data.job_id);
  return poll.data.job;
}
async function finish(f, d, j, result) {
  const response = await f.call("/devices/complete", { device_id: d.device_id, job_id: j.id, result }, { token: d.device_token });
  assert.equal(response.status, 200); return response;
}
async function createdShare(f, d, user = "owner-a") {
  const job = await startJob(f, d, "create", { selection: "opaque-selection", include_pickup_code: true }, user);
  await finish(f, d, job, { card: mockCard(f), record_id: "a".repeat(32), expires_at: new Date(f.time() + 600_000).toISOString(), queried_at: new Date(f.time()).toISOString() });
  const done = await f.call(`/jobs/${job.id}`, undefined, { user }); assert.equal(done.data.state, "done");
  assert.equal(done.data.result.record_id, undefined);
  const { id, url } = done.data.result.share;
  return { id, token: new URL(`https://handoff.test${url}`).hash.slice("#access=".length), job, result: done.data.result };
}

test("session and pairing isolate identity; only hashes persist; pair code is single use", async () => {
  const f = fixture();
  assert.deepEqual((await f.call("/session")).data, { authenticated: false });
  const d = await paired(f);
  const row = f.db.connection.prepare("SELECT * FROM mobile_devices").get();
  assert.notEqual(row.token_hash, d.device_token); assert.equal(row.pair_hash, null);
  assert.equal((await f.call("/devices/claim", { pair_code: d.pair_code }, { user: "owner-b" })).status, 410);
  const a = await f.call("/session", undefined, { user: "owner-a" }); assert.equal(a.data.device.online, true);
  assert.match(a.data.user.id, /^[a-f0-9]{32}$/);
  assert.equal(row.owner_id, a.data.user.id);
  const b = await f.call("/session", undefined, { user: "owner-b" }); assert.equal(b.data.device, undefined);
  assert.equal((await f.call("/devices/claim", { pair_code: "random" })).status, 422);
});

test("expired pair code cannot claim and public enrollment is throttled", async () => {
  const f = fixture(); const d = (await f.call("/devices/enroll", {})).data;
  f.advance(600_001);
  assert.equal((await f.call("/devices/claim", { pair_code: d.pair_code }, { user: "owner-a" })).status, 410);
  for (let i = 0; i < 5; i++) assert.equal((await f.call("/devices/enroll", {})).status, 200);
  assert.equal((await f.call("/devices/enroll", {})).status, 429);
});

test("owner queue only accepts the three contracts and strips no injected official fields", async () => {
  const f = fixture(); await paired(f);
  const options = { user: "owner-a" };
  assert.equal((await f.call("/jobs", { action: "refresh", args: { record_id: "guessed" } }, options)).status, 422);
  assert.equal((await f.call("/jobs", { action: "orders", args: { orderId: "guess" } }, options)).status, 422);
  assert.equal((await f.call("/jobs", { action: "create", args: { selection: "opaque", include_pickup_code: "yes" } }, options)).status, 422);
  assert.equal((await f.call("/jobs", { action: "inspect", args: { selection: "opaque", pickup_code: "fake" } }, options)).status, 422);
  assert.equal((await f.call("/jobs", { action: "orders", args: {} })).status, 401);
  assert.equal((await f.call("/jobs", { action: "orders", args: {} }, { user: "owner-b" })).status, 409);
});

test("device heartbeat during a job cannot claim a second task, even in concurrent polls", async () => {
  const f = fixture(), d = await paired(f);
  const a = await f.call("/jobs", { action: "orders", args: {} }, { user: "owner-a" });
  const b = await f.call("/jobs", { action: "inspect", args: { selection: "opaque" } }, { user: "owner-a" });
  const polls = await Promise.all([f.call("/devices/poll", { device_id: d.device_id }, { token: d.device_token }), f.call("/devices/poll", { device_id: d.device_id }, { token: d.device_token })]);
  assert.equal(polls.filter(p => p.data.job).length, 1);
  const claimed = polls.find(p => p.data.job).data.job;
  assert.ok([a.data.job_id, b.data.job_id].includes(claimed.id));
  f.advance(30_000);
  assert.equal((await f.call("/devices/poll", { device_id: d.device_id }, { token: d.device_token })).data.job, null);
  const row = f.db.connection.prepare("SELECT heartbeat FROM mobile_devices WHERE id=?").get(d.device_id); assert.equal(row.heartbeat, f.time());
  const result = { orders: [], queried_at: new Date(f.time()).toISOString(), server_time: null, source: "mcp" };
  await finish(f, d, claimed, result);
  assert.equal((await f.call("/devices/poll", { device_id: d.device_id }, { token: d.device_token })).data.job.action, claimed.action === "orders" ? "inspect" : "orders");
});

test("private jobs cannot be read or completed by other owners/devices and reject late results", async () => {
  const f = fixture(), d = await paired(f), other = await paired(f, "owner-b");
  const j = await startJob(f, d, "orders", {});
  assert.equal((await f.call(`/jobs/${j.id}`, undefined, { user: "owner-b" })).status, 404);
  assert.equal((await f.call(`/jobs/${j.id}`)).status, 401);
  const result = { orders: [], queried_at: new Date(f.time()).toISOString(), server_time: null, source: "mcp" };
  assert.equal((await f.call("/devices/complete", { device_id: other.device_id, job_id: j.id, result }, { token: other.device_token })).status, 409);
  assert.equal((await f.call("/devices/poll", { device_id: d.device_id }, { token: other.device_token })).status, 401);
  f.advance(180_001);
  assert.deepEqual((await f.call("/devices/complete", { device_id: d.device_id, job_id: j.id, result }, { token: d.device_token })).data, { ok: true });
  assert.equal((await f.call(`/jobs/${j.id}`, undefined, { user: "owner-a" })).data.state, "failed");
});

test("completed create gives a single-share capability and keeps record ID private", async () => {
  const f = fixture(), d = await paired(f), s = await createdShare(f, d);
  assert.equal(s.result.card.pickup_code, "TEST-CODE");
  const row = f.db.connection.prepare("SELECT * FROM mobile_shares WHERE id=?").get(s.id);
  assert.notEqual(row.token_hash, s.token); assert.equal(row.record_id, "a".repeat(32));
  const view = await f.call(`/shares/${s.id}/view`, {}, { token: s.token });
  assert.equal(view.status, 200); assert.equal(view.data.verified, true); assert.equal(view.data.card.pickup_code, "TEST-CODE");
  assert.equal(view.data.record_id, undefined); assert.equal(view.data.owner_id, undefined);
  assert.equal((await f.call(`/shares/${s.id}/view`, {})).status, 401);
  assert.equal((await f.call(`/jobs/${s.job.id}`, undefined, { token: s.token })).status, 401);
  assert.equal((await f.call(`/shares/${s.id}/view`, {}, { token: "b".repeat(64) })).status, 404);
});

test("share refresh has scoped job access and verified latest content", async () => {
  const f = fixture(), d = await paired(f), a = await createdShare(f, d), b = await createdShare(f, d);
  const refresh = await f.call(`/shares/${a.id}/refresh`, {}, { token: a.token }); assert.equal(refresh.status, 200);
  assert.equal((await f.call(`/shares/${a.id}/refresh`, {}, { token: a.token })).status, 429);
  assert.equal((await f.call(`/shares/${b.id}/jobs/${refresh.data.job_id}`, undefined, { token: b.token })).status, 404);
  assert.equal((await f.call(`/shares/${a.id}/view`, {}, { token: a.token })).data.card.pickup_code, "");
  const j = (await f.call("/devices/poll", { device_id: d.device_id }, { token: d.device_token })).data.job;
  assert.equal(j.action, "refresh"); assert.deepEqual(j.args, { record_id: "a".repeat(32) });
  f.advance(1000);
  await finish(f, d, j, { verified: true, card: mockCard(f), queried_at: new Date(f.time()).toISOString(), notice: "已复查" });
  const job = await f.call(`/shares/${a.id}/jobs/${j.id}`, undefined, { token: a.token });
  assert.equal(job.data.state, "done"); assert.equal(job.data.result.verified, true);
  const view = await f.call(`/shares/${a.id}/view`, {}, { token: a.token });
  assert.equal(view.data.card.pickup_code, "TEST-CODE"); assert.equal(view.data.queried_at, new Date(f.time()).toISOString());
});

test("changed, failed and invalid-field refreshes clear the pickup code", async () => {
  for (const failure of ["changed", "error", "injected"]) {
    const f = fixture(), d = await paired(f), s = await createdShare(f, d);
    const refresh = await f.call(`/shares/${s.id}/refresh`, {}, { token: s.token }); assert.equal(refresh.status, 200);
    const j = (await f.call("/devices/poll", { device_id: d.device_id }, { token: d.device_token })).data.job;
    const completion = failure === "error" ? { error: "DO-NOT-SAVE-TOKEN-or-orderId" } : { result: { verified: false, card: { ...mockCard(f), status_text: "订单已完成" }, queried_at: new Date(f.time()).toISOString(), notice: "状态改变", ...(failure === "injected" ? { orderId: "DO-NOT-SAVE" } : {}) } };
    const completed = await f.call("/devices/complete", { device_id: d.device_id, job_id: j.id, ...completion }, { token: d.device_token }); assert.equal(completed.status, 200);
    const view = await f.call(`/shares/${s.id}/view`, {}, { token: s.token });
    assert.equal(view.data.verified, false); assert.equal(view.data.card.pickup_code, "");
    const serialized = JSON.stringify(f.db.connection.prepare("SELECT * FROM mobile_jobs").all()); assert.equal(serialized.includes("DO-NOT-SAVE"), false);
  }
});

test("offline devices cannot masquerade as live and expired/revoked links cannot be used", async () => {
  const f = fixture(), d = await paired(f), s = await createdShare(f, d);
  f.advance(61_000);
  const view = await f.call(`/shares/${s.id}/view`, {}, { token: s.token });
  assert.equal(view.data.online, false); assert.equal(view.data.verified, false); assert.equal(view.data.card.pickup_code, "");
  assert.equal((await f.call(`/shares/${s.id}/refresh`, {}, { token: s.token })).status, 503);
  assert.equal((await f.call("/jobs", { action: "orders", args: {} }, { user: "owner-a" })).status, 503);
  assert.equal((await f.call(`/shares/${s.id}/revoke`, {}, { user: "owner-b" })).status, 404);
  assert.equal((await f.call(`/shares/${s.id}/revoke`, {}, { user: "owner-a" })).status, 200);
  assert.equal((await f.call(`/shares/${s.id}/view`, {}, { token: s.token })).status, 410);
  assert.equal((await f.call(`/shares/${s.id}/refresh`, {}, { token: s.token })).status, 410);
  const g = fixture(), gd = await paired(g), gs = await createdShare(g, gd); g.advance(600_000);
  assert.equal((await g.call(`/shares/${gs.id}/view`, {}, { token: gs.token })).status, 410);
});

test("timed-out refresh removes cached code and releases device queue lock", async () => {
  const f = fixture(), d = await paired(f), s = await createdShare(f, d);
  const refresh = await f.call(`/shares/${s.id}/refresh`, {}, { token: s.token });
  const j = (await f.call("/devices/poll", { device_id: d.device_id }, { token: d.device_token })).data.job; assert.equal(j.id, refresh.data.job_id);
  f.advance(180_001);
  const status = await f.call(`/shares/${s.id}/jobs/${j.id}`, undefined, { token: s.token }); assert.equal(status.data.state, "failed");
  const view = await f.call(`/shares/${s.id}/view`, {}, { token: s.token }); assert.equal(view.data.card.pickup_code, "");
  const row = f.db.connection.prepare("SELECT running_job FROM mobile_devices WHERE id=?").get(d.device_id); assert.equal(row.running_job, null);
});

test("request origin, sizes and unsupported methods are enforced", async () => {
  const f = fixture();
  assert.equal((await f.call("/devices/enroll", {}, { headers: { origin: "https://evil.test" } })).status, 403);
  assert.equal((await f.call("/devices/enroll", {}, { headers: { "sec-fetch-site": "cross-site" } })).status, 403);
  assert.equal((await f.call("/devices/enroll", {}, { headers: { "content-type": "text/plain" } })).status, 415);
  assert.equal((await f.call("/devices/enroll", {}, { headers: { "content-length": "131073" } })).status, 413);
  const request = new Request("https://handoff.test/api/mobile/devices/enroll", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ long: "x".repeat(131072) }) });
  assert.equal((await f.handle(request)).status, 413);
  assert.equal((await f.call("/session", undefined, { method: "DELETE" })).status, 405);
  assert.equal((await f.call("/missing-route", undefined)).status, 404);
  assert.equal((await f.call("/session")).headers.get("cache-control"), "no-store");
});

test("create result whitelist rejects official IDs/raw credentials and duplicate completion", async () => {
  const f = fixture(), d = await paired(f);
  const j = await startJob(f, d, "create", { selection: "opaque", include_pickup_code: false });
  const result = { card: mockCard(f, ""), record_id: "a".repeat(32), expires_at: new Date(f.time() + 600_000).toISOString(), queried_at: new Date(f.time()).toISOString(), orderId: "secret-order" };
  await finish(f, d, j, result);
  const done = await f.call(`/jobs/${j.id}`, undefined, { user: "owner-a" }); assert.equal(done.data.state, "failed");
  assert.equal(f.db.connection.prepare("SELECT count(*) AS n FROM mobile_shares").get().n, 0);
  assert.deepEqual((await f.call("/devices/complete", { device_id: d.device_id, job_id: j.id, result }, { token: d.device_token })).data, { ok: true });
  assert.equal(JSON.stringify(f.db.connection.prepare("SELECT * FROM mobile_jobs").all()).includes("secret-order"), false);
});

test("paired Skill devices can publish links; unclaimed or different device credentials cannot", async () => {
  const f = fixture(); const unclaimed = (await f.call("/devices/enroll", {})).data;
  const payload = { device_id: unclaimed.device_id, card: mockCard(f), record_id: "c".repeat(32), expires_at: new Date(f.time() + 600_000).toISOString(), queried_at: new Date(f.time()).toISOString() };
  assert.equal((await f.call("/devices/share", payload, { token: unclaimed.device_token })).status, 409);
  const d = await paired(f);
  assert.equal((await f.call("/devices/share", { ...payload, device_id: d.device_id }, { token: unclaimed.device_token })).status, 401);
  assert.equal((await f.call("/devices/share", { ...payload, device_id: d.device_id, orderId: "forbidden" }, { token: d.device_token })).status, 422);
  const published = await f.call("/devices/share", { ...payload, device_id: d.device_id }, { token: d.device_token }); assert.equal(published.status, 200);
  assert.equal(published.data.record_id, undefined);
  const { id: shareId, url } = published.data.share;
  const token = new URL(`https://handoff.test${url}`).hash.slice("#access=".length);
  assert.equal((await f.call(`/shares/${shareId}/view`, {}, { token })).data.card.pickup_code, "TEST-CODE");
  assert.equal((await f.call(`/shares/${shareId}/revoke`, {}, { user: "owner-b" })).status, 404);
  assert.equal((await f.call(`/shares/${shareId}/revoke`, {}, { user: "owner-a" })).status, 200);
});

test("owner hiding-code choice is enforced even if bridge accidentally includes one", async () => {
  const f = fixture(), d = await paired(f);
  const j = await startJob(f, d, "create", { selection: "opaque", include_pickup_code: false });
  await finish(f, d, j, { card: mockCard(f), record_id: "d".repeat(32), expires_at: new Date(f.time() + 600_000).toISOString(), queried_at: new Date(f.time()).toISOString() });
  const done = await f.call(`/jobs/${j.id}`, undefined, { user: "owner-a" });
  assert.equal(done.data.state, "done"); assert.equal(done.data.result.card.pickup_code, "");
  const row = f.db.connection.prepare("SELECT card FROM mobile_shares").get(); assert.equal(JSON.parse(row.card).pickup_code, "");
});

test("closed order cannot be issued or declared valid by a mistaken bridge", async () => {
  const f = fixture(), d = await paired(f);
  const payload = { device_id: d.device_id, card: { ...mockCard(f), status_text: "订单已完成" }, record_id: "e".repeat(32), expires_at: new Date(f.time() + 600_000).toISOString(), queried_at: new Date(f.time()).toISOString() };
  assert.equal((await f.call("/devices/share", payload, { token: d.device_token })).status, 422);
  const s = await createdShare(f, d);
  await f.call(`/shares/${s.id}/refresh`, {}, { token: s.token });
  const j = (await f.call("/devices/poll", { device_id: d.device_id }, { token: d.device_token })).data.job;
  await finish(f, d, j, { verified: true, card: { ...mockCard(f), status_text: "订单已完成" }, queried_at: new Date(f.time()).toISOString(), notice: "状态改变" });
  const view = await f.call(`/shares/${s.id}/view`, {}, { token: s.token });
  assert.equal(view.data.verified, false); assert.equal(view.data.card.pickup_code, "");
});

test("poll always reports claimed state, including pending, idle, active and busy branches", async () => {
  const f = fixture(), d = (await f.call("/devices/enroll", {})).data;
  assert.deepEqual((await f.call("/devices/poll", { device_id: d.device_id }, { token: d.device_token })).data, { paired: false, job: null });
  await f.call("/devices/claim", { pair_code: d.pair_code }, { user: "owner-a" });
  assert.deepEqual((await f.call("/devices/poll", { device_id: d.device_id }, { token: d.device_token })).data, { paired: true, job: null });
  await f.call("/jobs", { action: "orders", args: {} }, { user: "owner-a" });
  const active = await f.call("/devices/poll", { device_id: d.device_id }, { token: d.device_token });
  assert.equal(active.data.paired, true); assert.equal(active.data.job.action, "orders");
  assert.deepEqual((await f.call("/devices/poll", { device_id: d.device_id }, { token: d.device_token })).data, { paired: true, job: null });
});

test("lost completion response is safely acknowledged without issuing another share or changing result", async () => {
  const f = fixture(), d = await paired(f), s = await createdShare(f, d);
  const before = f.db.connection.prepare("SELECT state,result,error FROM mobile_jobs WHERE id=?").get(s.job.id);
  const retry = await f.call("/devices/complete", { device_id: d.device_id, job_id: s.job.id, result: { card: mockCard(f, "DIFFERENT-CODE"), record_id: "f".repeat(32), expires_at: new Date(f.time() + 600_000).toISOString(), queried_at: new Date(f.time()).toISOString() } }, { token: d.device_token });
  assert.equal(retry.status, 200); assert.deepEqual(retry.data, { ok: true });
  assert.equal(f.db.connection.prepare("SELECT count(*) AS n FROM mobile_shares").get().n, 1);
  assert.deepEqual(f.db.connection.prepare("SELECT state,result,error FROM mobile_jobs WHERE id=?").get(s.job.id), before);
  const other = await paired(f, "owner-b");
  assert.equal((await f.call("/devices/complete", { device_id: d.device_id, job_id: s.job.id, error: "retry" }, { token: other.device_token })).status, 401);
  assert.equal((await f.call("/devices/complete", { device_id: other.device_id, job_id: s.job.id, error: "retry" }, { token: other.device_token })).status, 409);
});

test("expired completion is acknowledged, discards old result and allows the next queued job", async () => {
  const f = fixture(), d = await paired(f), old = await startJob(f, d, "orders", {});
  const next = await f.call("/jobs", { action: "inspect", args: { selection: "opaque" } }, { user: "owner-a" });
  f.advance(180_001);
  const ack = await f.call("/devices/complete", { device_id: d.device_id, job_id: old.id, result: { orders: [], queried_at: new Date(f.time()).toISOString(), server_time: null, source: "mcp" } }, { token: d.device_token });
  assert.equal(ack.status, 200); assert.deepEqual(ack.data, { ok: true });
  const oldRow = f.db.connection.prepare("SELECT state,result FROM mobile_jobs WHERE id=?").get(old.id);
  assert.equal(oldRow.state, "failed"); assert.equal(oldRow.result, null);
  const poll = await f.call("/devices/poll", { device_id: d.device_id }, { token: d.device_token });
  assert.equal(poll.data.job.id, next.data.job_id); assert.equal(poll.data.paired, true);
});

test("expiry cleanup erases owner capability results and pickup codes without touching another valid owner", async () => {
  const f = fixture(), aDevice = await paired(f), a = await createdShare(f, aDevice);
  const initialResult = f.db.connection.prepare("SELECT result FROM mobile_jobs WHERE id=?").get(a.job.id).result;
  assert.ok(initialResult.includes(a.token));
  f.advance(300_000);
  const bDevice = await paired(f, "owner-b"), b = await createdShare(f, bDevice, "owner-b");
  const bBefore = f.db.connection.prepare("SELECT result FROM mobile_jobs WHERE id=?").get(b.job.id).result;
  f.advance(300_001);
  await f.call("/session", undefined, { user: "owner-b" });
  const expiredResult = f.db.connection.prepare("SELECT result FROM mobile_jobs WHERE id=?").get(a.job.id).result;
  assert.equal(expiredResult, null);
  const oldCard = f.db.connection.prepare("SELECT card,verified FROM mobile_shares WHERE id=?").get(a.id);
  assert.equal(JSON.parse(oldCard.card).pickup_code, ""); assert.equal(oldCard.verified, 0);
  const expiredView = await f.call(`/jobs/${a.job.id}`, undefined, { user: "owner-a" });
  assert.equal(expiredView.data.state, "failed"); assert.equal(expiredView.data.result, undefined);
  assert.equal(f.db.connection.prepare("SELECT result FROM mobile_jobs WHERE id=?").get(b.job.id).result, bBefore);
  assert.equal(JSON.parse(f.db.connection.prepare("SELECT card FROM mobile_shares WHERE id=?").get(b.id).card).pickup_code, "TEST-CODE");
  assert.equal(f.db.connection.prepare("SELECT count(*) AS n FROM mobile_rate_limits WHERE expires_at<=?").get(f.time()).n, 0);
  const saved = JSON.stringify(f.db.connection.prepare("SELECT result FROM mobile_jobs").all()); assert.equal(saved.includes(a.token), false); assert.ok(saved.includes(b.token));
});

test("revocation erases associated creation and completed refresh payloads only", async () => {
  const f = fixture(), d = await paired(f), a = await createdShare(f, d), b = await createdShare(f, d);
  await f.call(`/shares/${a.id}/refresh`, {}, { token: a.token });
  const refresh = (await f.call("/devices/poll", { device_id: d.device_id }, { token: d.device_token })).data.job;
  await finish(f, d, refresh, { verified: true, card: mockCard(f), queried_at: new Date(f.time()).toISOString(), notice: "已复查" });
  assert.ok(f.db.connection.prepare("SELECT result FROM mobile_jobs WHERE id=?").get(refresh.id).result.includes("TEST-CODE"));
  assert.equal((await f.call(`/shares/${a.id}/revoke`, {}, { user: "owner-a" })).status, 200);
  for (const jobId of [a.job.id, refresh.id]) {
    const j = f.db.connection.prepare("SELECT state,result FROM mobile_jobs WHERE id=?").get(jobId);
    assert.equal(j.result, null); assert.equal(j.state, "failed");
  }
  assert.equal(JSON.parse(f.db.connection.prepare("SELECT card FROM mobile_shares WHERE id=?").get(a.id).card).pickup_code, "");
  assert.equal((await f.call(`/jobs/${a.job.id}`, undefined, { user: "owner-a" })).data.result, undefined);
  assert.ok(f.db.connection.prepare("SELECT result FROM mobile_jobs WHERE id=?").get(b.job.id).result.includes(b.token));
  assert.equal((await f.call(`/shares/${b.id}/view`, {}, { token: b.token })).data.card.pickup_code, "TEST-CODE");
});

test("expiry cleanup is bounded and its SQL plans use migration expiry indexes", async () => {
  const f = fixture();
  const insertJob = f.db.connection.prepare("INSERT INTO mobile_jobs(id,owner_id,device_id,action,args,state,result,created_at,expires_at) VALUES(?,'test-owner','test-device','orders','{}','done','{}',?,?)");
  const insertShare = f.db.connection.prepare("INSERT INTO mobile_shares(id,owner_id,device_id,token_hash,record_id,card,queried_at,expires_at,verified) VALUES(?,'test-owner','test-device','hash','record',?,?,?,1)");
  const insertBucket = f.db.connection.prepare("INSERT INTO mobile_rate_limits(key,count,expires_at) VALUES(?,1,?)");
  for (let i = 0; i < 110; i++) {
    insertJob.run(`expired-job-${i}`, f.time() - 1000, f.time() - 1);
    insertShare.run(`expired-share-${i}`, JSON.stringify(mockCard(f)), new Date(f.time()).toISOString(), f.time() - 1);
    insertBucket.run(`expired-bucket-${i}`, f.time() - 1);
  }
  await f.call("/session");
  assert.equal(f.db.connection.prepare("SELECT count(*) AS n FROM mobile_jobs WHERE result IS NOT NULL").get().n, 85);
  assert.equal(f.db.connection.prepare("SELECT count(*) AS n FROM mobile_shares WHERE json_extract(card,'$.pickup_code')!=''").get().n, 85);
  assert.equal(f.db.connection.prepare("SELECT count(*) AS n FROM mobile_rate_limits").get().n, 60);
  const queries = [
    "SELECT id FROM mobile_jobs WHERE state IN ('done','failed') AND result IS NOT NULL AND expires_at<=? ORDER BY expires_at LIMIT 25",
    "SELECT id FROM mobile_shares WHERE expires_at<=? AND (verified!=0 OR json_extract(card,'$.pickup_code')!='') ORDER BY expires_at LIMIT 25",
    "SELECT key FROM mobile_rate_limits WHERE expires_at<=? ORDER BY expires_at LIMIT 50",
  ];
  for (const query of queries) {
    const plan = f.db.connection.prepare(`EXPLAIN QUERY PLAN ${query}`).all(f.time()).map(row => row.detail).join(" ");
    assert.match(plan, /USING (?:COVERING )?INDEX/);
    assert.doesNotMatch(plan, /USE TEMP B-TREE/);
  }
});

test("completion batch rollback restores running state so the outbox retry issues exactly one share", async () => {
  const f = fixture(), d = await paired(f), j = await startJob(f, d, "create", { selection: "opaque", include_pickup_code: true });
  const payload = { device_id: d.device_id, job_id: j.id, result: { card: mockCard(f), record_id: "a".repeat(32), expires_at: new Date(f.time() + 600_000).toISOString(), queried_at: new Date(f.time()).toISOString() } };
  f.db.connection.exec("CREATE TRIGGER fail_completion BEFORE UPDATE ON mobile_jobs WHEN NEW.state='done' BEGIN SELECT RAISE(ABORT,'injected batch failure'); END");
  assert.equal((await f.call("/devices/complete", payload, { token: d.device_token })).status, 503);
  assert.equal(f.db.connection.prepare("SELECT state FROM mobile_jobs WHERE id=?").get(j.id).state, "running");
  assert.equal(f.db.connection.prepare("SELECT count(*) AS n FROM mobile_shares").get().n, 0);
  f.db.connection.exec("DROP TRIGGER fail_completion");
  const retry = await f.call("/devices/complete", payload, { token: d.device_token }); assert.equal(retry.status, 200); assert.deepEqual(retry.data, { ok: true });
  assert.equal(f.db.connection.prepare("SELECT state FROM mobile_jobs WHERE id=?").get(j.id).state, "done");
  assert.equal(f.db.connection.prepare("SELECT count(*) AS n FROM mobile_shares").get().n, 1);
  assert.equal((await f.call("/devices/complete", payload, { token: d.device_token })).status, 200);
  assert.equal(f.db.connection.prepare("SELECT count(*) AS n FROM mobile_shares").get().n, 1);
});

test("duplicate pending orders merge atomically and each device accepts at most three queued jobs", async () => {
  const f = fixture(), d = await paired(f);
  const duplicates = await Promise.all(Array.from({ length: 3 }, () => f.call("/jobs", { action: "orders", args: {} }, { user: "owner-a" })));
  assert.ok(duplicates.every(r => r.status === 200)); assert.equal(new Set(duplicates.map(r => r.data.job_id)).size, 1);
  const more = await Promise.all(Array.from({ length: 3 }, (_, i) => f.call("/jobs", { action: "inspect", args: { selection: `opaque-${i}` } }, { user: "owner-a" })));
  assert.equal(more.filter(r => r.status === 200).length, 2); assert.equal(more.filter(r => r.status === 429).length, 1);
  assert.equal(f.db.connection.prepare("SELECT count(*) AS n FROM mobile_jobs WHERE state='queued'").get().n, 3);
  const poll = await f.call("/devices/poll", { device_id: d.device_id }, { token: d.device_token }); assert.ok(poll.data.job);
  assert.equal((await f.call("/jobs", { action: "inspect", args: { selection: "fourth-slot" } }, { user: "owner-a" })).status, 200);
  assert.equal((await f.call("/jobs", { action: "inspect", args: { selection: "overflow" } }, { user: "owner-a" })).status, 429);
  assert.equal(f.db.connection.prepare("SELECT count(*) AS n FROM mobile_jobs WHERE state='queued'").get().n, 3);
  assert.equal(f.db.connection.prepare("SELECT count(*) AS n FROM mobile_jobs WHERE state='running'").get().n, 1);
  assert.equal((await f.call("/devices/poll", { device_id: d.device_id }, { token: d.device_token })).data.job, null);
});

test("owner can recover active share links, while another owner or anonymous visitor cannot list them", async () => {
  const f = fixture(), aDevice = await paired(f), a = await createdShare(f, aDevice);
  const bDevice = await paired(f, "owner-b"), b = await createdShare(f, bDevice, "owner-b");
  const list = await f.call("/shares", undefined, { user: "owner-a" }); assert.equal(list.status, 200);
  assert.equal(list.data.entries.length, 1);
  const entry = list.data.entries[0]; assert.equal(entry.id, a.id); assert.ok(entry.url.includes(a.token));
  assert.equal(entry.store_name, "测试餐厅"); assert.equal(entry.revoked, false); assert.equal(entry.verified, true); assert.equal(entry.online, true);
  assert.deepEqual(Object.keys(entry).sort(), ["id", "store_name", "status_text", "queried_at", "expires_at", "revoked", "verified", "online", "url"].sort());
  const bList = await f.call("/shares", undefined, { user: "owner-b" }); assert.equal(bList.data.entries[0].id, b.id);
  assert.equal(JSON.stringify(bList.data).includes(a.id), false); assert.equal(JSON.stringify(bList.data).includes(a.token), false);
  assert.equal((await f.call("/shares")).status, 401);
  assert.equal((await f.call("/session")).data.user, undefined);
});

test("revoked and expired summaries stay visible without URL or code", async () => {
  const f = fixture(), d = await paired(f), expired = await createdShare(f, d), revoked = await createdShare(f, d);
  await f.call(`/shares/${revoked.id}/revoke`, {}, { user: "owner-a" });
  let entries = (await f.call("/shares", undefined, { user: "owner-a" })).data.entries;
  assert.equal(entries.find(e => e.id === revoked.id).revoked, true); assert.equal(entries.find(e => e.id === revoked.id).url, undefined);
  f.advance(600_001);
  entries = (await f.call("/shares", undefined, { user: "owner-a" })).data.entries;
  assert.equal(entries.length, 2);
  const old = entries.find(e => e.id === expired.id); assert.equal(old.url, undefined); assert.equal(old.verified, false);
  assert.equal(JSON.stringify(entries).includes("TEST-CODE"), false); assert.equal(JSON.stringify(entries).includes(expired.token), false);
});

test("direct Skill publication has a revocation summary without inventing a recoverable URL", async () => {
  const f = fixture(), d = await paired(f);
  const publication = await f.call("/devices/share", { device_id: d.device_id, card: mockCard(f), record_id: "c".repeat(32), expires_at: new Date(f.time() + 600_000).toISOString(), queried_at: new Date(f.time()).toISOString() }, { token: d.device_token });
  assert.equal(publication.status, 200);
  const entries = (await f.call("/shares", undefined, { user: "owner-a" })).data.entries;
  assert.equal(entries.length, 1); assert.equal(entries[0].id, publication.data.share.id); assert.equal(entries[0].url, undefined);
  assert.equal((await f.call(`/shares/${entries[0].id}/revoke`, {}, { user: "owner-a" })).status, 200);
  assert.equal((await f.call("/shares", undefined, { user: "owner-a" })).data.entries[0].revoked, true);
});

test("share summaries are restricted to the recent seven days and the twenty latest records", async () => {
  const f = fixture(), d = await paired(f);
  const ownerId = (await f.call("/session", undefined, { user: "owner-a" })).data.user.id;
  const insert = f.db.connection.prepare("INSERT INTO mobile_shares(id,owner_id,device_id,token_hash,record_id,card,queried_at,expires_at,verified) VALUES(?, ?,?,'hash','private-record',?,?,?,1)");
  for (let i = 0; i < 25; i++) insert.run(i.toString(16).padStart(32, "0"), ownerId, d.device_id, JSON.stringify(mockCard(f)), new Date(f.time()).toISOString(), f.time() + i * 1000);
  insert.run("a".repeat(32), ownerId, d.device_id, JSON.stringify(mockCard(f)), new Date(f.time()).toISOString(), f.time() - 8 * 24 * 60 * 60_000);
  const entries = (await f.call("/shares", undefined, { user: "owner-a" })).data.entries;
  assert.equal(entries.length, 20);
  assert.equal(entries[0].id, (24).toString(16).padStart(32, "0"));
  assert.equal(entries[19].id, (5).toString(16).padStart(32, "0"));
  assert.equal(JSON.stringify(entries).includes("private-record"), false);
  assert.equal(JSON.stringify(entries).includes("TEST-CODE"), false);
  assert.ok(entries.every(e => e.url === undefined));
});

test("recovered URL must come from the same owner and device as its share", async () => {
  const f = fixture(), d = await paired(f), s = await createdShare(f, d);
  const ownerId = (await f.call("/session", undefined, { user: "owner-a" })).data.user.id;
  f.db.connection.prepare("UPDATE mobile_jobs SET owner_id='owner-b' WHERE id=?").run(s.job.id);
  assert.equal((await f.call("/shares", undefined, { user: "owner-a" })).data.entries[0].url, undefined);
  f.db.connection.prepare("UPDATE mobile_jobs SET owner_id=?,device_id='other-device' WHERE id=?").run(ownerId, s.job.id);
  assert.equal((await f.call("/shares", undefined, { user: "owner-a" })).data.entries[0].url, undefined);
});
