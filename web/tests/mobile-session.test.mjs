import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createMobileHandler } from "../lib/mobile-api.mjs";
import { createTestDatabase } from "./helpers/d1.mjs";

function fixture() {
  const db = createTestDatabase(); let now = Date.now();
  const handler = createMobileHandler(db, { clock: () => now });
  async function call(path, body, { cookie, token, headers = {} } = {}) {
    const response = await handler(new Request(`https://handoff.test/api/mobile${path}`, { method: body === undefined ? "GET" : "POST", headers: { ...(body === undefined ? {} : { "content-type": "application/json", origin: "https://handoff.test" }), ...(cookie ? { cookie } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }));
    return { status: response.status, data: await response.json(), cookie: response.headers.get("set-cookie"), headers: response.headers };
  }
  async function paired() {
    const d = (await call("/devices/enroll", {})).data;
    const claim = await call("/devices/claim", { pair_code: d.pair_code });
    assert.equal(claim.status, 200);
    const cookie = claim.cookie.split(";")[0], session = await call("/session", undefined, { cookie });
    return { d, cookie, owner: session.data.user.id, claim };
  }
  return { db, handler, call, paired, advance: n => now += n, time: () => now };
}

test("anonymous phone claim returns only device ID and stores a hashed secure 30-day session", async () => {
  const f = fixture(), a = await f.paired();
  assert.deepEqual(a.claim.data, { device_id: a.d.device_id });
  assert.match(a.claim.cookie, /^__Host-mcd_owner=[a-f0-9]{64};/);
  for (const flag of ["Path=/", "HttpOnly", "Secure", "SameSite=Strict", "Max-Age=2592000"]) assert.ok(a.claim.cookie.includes(flag));
  assert.equal(a.claim.headers.get("cache-control"), "no-store");
  const raw = a.cookie.split("=")[1], row = f.db.connection.prepare("SELECT * FROM mobile_owner_sessions").get();
  assert.notEqual(row.token_hash, raw); assert.equal(row.owner_id, a.owner); assert.equal(row.expires_at - row.created_at, 30 * 24 * 60 * 60_000);
  assert.equal(JSON.stringify(a.claim.data).includes(raw), false);
  const restored = await f.call("/session", undefined, { cookie: a.cookie });
  assert.equal(restored.data.user.name, "我的取餐"); assert.equal(restored.data.user.id, a.owner); assert.equal(restored.data.device.id, a.d.device_id);
});

test("Sites headers, random cookies and share/device bearer tokens never authorize owner routes", async () => {
  const f = fixture(), a = await f.paired();
  const forged = { headers: { "oai-authenticated-user-id": a.owner } };
  assert.deepEqual((await f.call("/session", undefined, forged)).data, { authenticated: false });
  assert.equal((await f.call("/jobs", { action: "orders", args: {} }, forged)).status, 401);
  assert.equal((await f.call("/shares", undefined, { token: a.d.device_token })).status, 401);
  assert.equal((await f.call("/shares", undefined, { cookie: "__Host-mcd_owner=" + "a".repeat(64) })).status, 401);
  assert.equal((await f.call("/shares", undefined, { cookie: a.cookie + "; " + a.cookie })).status, 401);
});

test("a pairing code is consumed exactly once under concurrent anonymous claims", async () => {
  const f = fixture(), d = (await f.call("/devices/enroll", {})).data;
  const claims = await Promise.all([f.call("/devices/claim", { pair_code: d.pair_code }), f.call("/devices/claim", { pair_code: d.pair_code })]);
  assert.equal(claims.filter(r => r.status === 200).length, 1); assert.equal(claims.filter(r => r.status === 410).length, 1);
  assert.equal(claims.find(r => r.status === 410).cookie, null);
  assert.equal(f.db.connection.prepare("SELECT count(*) AS n FROM mobile_owner_sessions").get().n, 1);
  assert.equal((await f.call("/devices/claim", { pair_code: d.pair_code })).status, 410);
});

test("phone sessions isolate private jobs and revocation while public shares retain their single-order scope", async () => {
  const f = fixture(), a = await f.paired(), b = await f.paired(); assert.notEqual(a.owner, b.owner);
  const job = await f.call("/jobs", { action: "orders", args: {} }, { cookie: a.cookie }); assert.equal(job.status, 200);
  assert.equal((await f.call(`/jobs/${job.data.job_id}`, undefined, { cookie: b.cookie })).status, 404);
  const stamp = new Date(f.time()).toISOString();
  const issue = await f.call("/devices/share", { device_id: a.d.device_id, card: { kind: "mcp", retrieved_at: stamp, store_name: "测试餐厅", store_address: "", pickup_mode: "外带", status_text: "配餐中", items: [{ name: "测试餐品", quantity: 1 }], pickup_code: "SYNTHETIC_CODE" }, record_id: "a".repeat(32), expires_at: new Date(f.time() + 600_000).toISOString(), queried_at: stamp }, { token: a.d.device_token });
  assert.equal(issue.status, 200);
  assert.equal((await f.call("/shares", undefined, { cookie: b.cookie })).data.entries.length, 0);
  assert.equal((await f.call(`/shares/${issue.data.share.id}/revoke`, {}, { cookie: b.cookie })).status, 404);
  const token = issue.data.share.url.split("#access=")[1];
  assert.equal((await f.call(`/shares/${issue.data.share.id}/view`, {}, { token })).status, 200);
  assert.equal((await f.call("/shares", undefined, { token })).status, 401);
  assert.equal((await f.call(`/shares/${issue.data.share.id}/revoke`, {}, { cookie: a.cookie })).status, 200);
});

test("renew adds a second phone to the existing owner without replacing its device or merging another owner", async () => {
  const f = fixture(), a = await f.paired(), b = await f.paired();
  const renew = await f.call("/devices/renew", { device_id: a.d.device_id, reset_owner: false }, { token: a.d.device_token });
  assert.equal(renew.data.paired, true); assert.match(renew.data.pair_code, /^[a-f0-9]{16}$/);
  const extra = await f.call("/devices/claim", { pair_code: renew.data.pair_code }, { cookie: b.cookie }); assert.equal(extra.status, 200);
  const replaced = extra.cookie.split(";")[0];
  assert.equal((await f.call("/session", undefined, { cookie: replaced })).data.user.id, a.owner);
  assert.equal((await f.call("/session", undefined, { cookie: a.cookie })).data.user.id, a.owner);
  assert.equal((await f.call("/session", undefined, { cookie: b.cookie })).data.authenticated, false);
  assert.equal(f.db.connection.prepare("SELECT owner_id FROM mobile_devices WHERE id=?").get(b.d.device_id).owner_id, b.owner);
  assert.equal(f.db.connection.prepare("SELECT owner_id FROM mobile_devices WHERE id=?").get(a.d.device_id).owner_id, a.owner);
  assert.equal((await f.call("/devices/claim", { pair_code: renew.data.pair_code })).status, 410);
});

test("logout revokes only this phone session, clears its cookie and preserves paired devices and other phones", async () => {
  const f = fixture(), a = await f.paired();
  const renew = await f.call("/devices/renew", { device_id: a.d.device_id, reset_owner: false }, { token: a.d.device_token });
  const extra = await f.call("/devices/claim", { pair_code: renew.data.pair_code }); const second = extra.cookie.split(";")[0];
  const logout = await f.call("/session/logout", {}, { cookie: a.cookie }); assert.equal(logout.status, 200);
  assert.ok(logout.cookie.includes("Max-Age=0")); assert.ok(logout.cookie.includes("HttpOnly; Secure; SameSite=Strict"));
  assert.equal((await f.call("/session", undefined, { cookie: a.cookie })).data.authenticated, false);
  assert.equal((await f.call("/session", undefined, { cookie: second })).data.authenticated, true);
  assert.equal(f.db.connection.prepare("SELECT owner_id FROM mobile_devices WHERE id=?").get(a.d.device_id).owner_id, a.owner);
});

test("expired sessions fail closed and are removed with a bounded indexed cleanup", async () => {
  const f = fixture(), a = await f.paired(); f.advance(30 * 24 * 60 * 60_000);
  assert.equal((await f.call("/session", undefined, { cookie: a.cookie })).data.authenticated, false);
  assert.equal((await f.call("/shares", undefined, { cookie: a.cookie })).status, 401);
  assert.equal(f.db.connection.prepare("SELECT count(*) AS n FROM mobile_owner_sessions").get().n, 0);
  const insert = f.db.connection.prepare("INSERT INTO mobile_owner_sessions(token_hash,owner_id,created_at,expires_at) VALUES(?,'old-owner',?,?)");
  for (let i = 0; i < 60; i++) insert.run(`old-hash-${i}`, f.time() - 100, f.time() - 1);
  await f.call("/session"); assert.equal(f.db.connection.prepare("SELECT count(*) AS n FROM mobile_owner_sessions").get().n, 10);
  const plan = f.db.connection.prepare("EXPLAIN QUERY PLAN SELECT token_hash FROM mobile_owner_sessions WHERE expires_at<=? ORDER BY expires_at LIMIT 50").all(f.time()).map(r => r.detail).join(" ");
  assert.match(plan, /mobile_owner_sessions_expiry_idx/);
});

test("claim, owner mutations and logout reject missing or foreign Origin and cross-site browser requests", async () => {
  const f = fixture(), a = await f.paired(), d = (await f.call("/devices/enroll", {})).data;
  for (const origin of ["", "https://evil.test"]) {
    assert.equal((await f.call("/devices/claim", { pair_code: d.pair_code }, { headers: { origin } })).status, 403);
    assert.equal((await f.call("/jobs", { action: "orders", args: {} }, { cookie: a.cookie, headers: { origin } })).status, 403);
    assert.equal((await f.call("/session/logout", {}, { cookie: a.cookie, headers: { origin } })).status, 403);
  }
  assert.equal((await f.call("/devices/claim", { pair_code: d.pair_code }, { headers: { "sec-fetch-site": "cross-site" } })).status, 403);
  assert.equal((await f.call("/devices/claim", { pair_code: d.pair_code })).status, 200);
  assert.equal((await f.call("/session", undefined, { cookie: a.cookie })).data.authenticated, true);
});

test("local HTTP integration claims a device, restores owner by cookie and logs out without any external account", async () => {
  const f = fixture();
  const server = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const url = `http://127.0.0.1:${server.address().port}${req.url}`;
    const request = new Request(url, { method: req.method, headers: req.headers, ...(req.method === "GET" ? {} : { body: Buffer.concat(chunks) }) });
    const response = await f.handler(request);
    res.writeHead(response.status, Object.fromEntries(response.headers)); res.end(await response.text());
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const post = (path, body, cookie) => fetch(base + "/api/mobile" + path, { method: "POST", headers: { "content-type": "application/json", origin: base, ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body) });
    const enroll = await post("/devices/enroll", {}); assert.equal(enroll.status, 200); const d = await enroll.json();
    const claim = await post("/devices/claim", { pair_code: d.pair_code }); assert.equal(claim.status, 200);
    const setCookie = claim.headers.get("set-cookie"); assert.ok(setCookie.includes("HttpOnly; Secure; SameSite=Strict"));
    const cookie = setCookie.split(";")[0];
    const current = await fetch(base + "/api/mobile/session", { headers: { cookie } }); assert.equal((await current.json()).device.id, d.device_id);
    assert.equal((await post("/jobs", { action: "orders", args: {} }, cookie)).status, 200);
    const logout = await post("/session/logout", {}, cookie); assert.equal(logout.status, 200);
    const ended = await fetch(base + "/api/mobile/session", { headers: { cookie } }); assert.equal((await ended.json()).authenticated, false);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
