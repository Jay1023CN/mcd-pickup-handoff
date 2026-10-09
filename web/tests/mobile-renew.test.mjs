import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { createMobileHandler } from "../lib/mobile-api.mjs";

function harness() {
  const sqlite = new DatabaseSync(":memory:");
  const migrations = new URL("../drizzle/", import.meta.url);
  for (const file of readdirSync(migrations).filter(f => f.endsWith(".sql")).sort()) sqlite.exec(readFileSync(new URL(file, migrations), "utf8"));
  const db = {
    prepare(sql) {
      let values = [];
      const statement = { sql, bind(...args) { values = args; return statement; }, async first() { return sqlite.prepare(sql).get(...values) || null; }, async all() { return { results: sqlite.prepare(sql).all(...values) }; }, run() { return { meta: sqlite.prepare(sql).run(...values) }; } };
      return statement;
    },
    async batch(statements) {
      sqlite.exec("BEGIN");
      try { const results = statements.map(s => s.run()); sqlite.exec("COMMIT"); return results; }
      catch (error) { sqlite.exec("ROLLBACK"); throw error; }
    },
  };
  let now = Date.now();
  const handler = createMobileHandler(db, { clock: () => now });
  const cookieTokens = new Map();
  async function cookieFor(user) {
    if (!cookieTokens.has(user)) {
      const token = Array.from(crypto.getRandomValues(new Uint8Array(32)), v => v.toString(16).padStart(2, "0")).join("");
      cookieTokens.set(user, token);
      const digest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token))), v => v.toString(16).padStart(2, "0")).join("");
      sqlite.prepare("INSERT INTO mobile_owner_sessions(token_hash,owner_id,created_at,expires_at) VALUES(?,?,?,?)").run(digest, user, now, now + 30 * 24 * 60 * 60_000);
    }
    return `__Host-mcd_owner=${cookieTokens.get(user)}`;
  }
  async function call(path, body, { user, token } = {}) {
    const response = await handler(new Request(`https://handoff.test/api/mobile${path}`, { method: body === undefined ? "GET" : "POST", headers: { ...(body === undefined ? {} : { "content-type": "application/json", origin: "https://handoff.test" }), ...(user ? { cookie: await cookieFor(user) } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }));
    if (user && response.headers.get("set-cookie")) cookieTokens.set(user, response.headers.get("set-cookie").split(";")[0].split("=")[1]);
    return { status: response.status, data: await response.json() };
  }
  return { sqlite, db, call, advance: amount => now += amount, time: () => now };
}
function publication(f, d) {
  const stamp = new Date(f.time()).toISOString();
  return { device_id: d.device_id, card: { kind: "mcp", retrieved_at: stamp, store_name: "测试餐厅", store_address: "", pickup_mode: "外带", status_text: "配餐中", items: [{ name: "测试餐品", quantity: 1 }], pickup_code: "SYNTHETIC_CODE" }, record_id: "a".repeat(32), expires_at: new Date(f.time() + 600_000).toISOString(), queried_at: stamp };
}

test("renew fixes expired unclaimed pairing, and a normal pair request preserves a claimed owner", async () => {
  const f = harness(), d = (await f.call("/devices/enroll", {})).data;
  f.advance(600_001);
  const renewed = await f.call("/devices/renew", { device_id: d.device_id, reset_owner: false }, { token: d.device_token });
  assert.equal(renewed.status, 200); assert.equal(renewed.data.paired, false); assert.notEqual(renewed.data.pair_code, d.pair_code);
  assert.equal((await f.call("/devices/claim", { pair_code: d.pair_code }, { user: "owner-a" })).status, 410);
  assert.equal((await f.call("/devices/claim", { pair_code: renewed.data.pair_code }, { user: "owner-a" })).status, 200);
  const ordinary = await f.call("/devices/renew", { device_id: d.device_id, reset_owner: false }, { token: d.device_token });
  assert.equal(ordinary.data.paired, true); assert.match(ordinary.data.pair_code, /^[a-f0-9]{16}$/);
  assert.equal(f.sqlite.prepare("SELECT owner_id FROM mobile_devices WHERE id=?").get(d.device_id).owner_id, (await f.call("/session", undefined, { user: "owner-a" })).data.user.id);
  assert.equal((await f.call("/devices/renew", { device_id: d.device_id, reset_owner: false }, { token: "b".repeat(64) })).status, 401);
  assert.equal((await f.call("/devices/renew", { device_id: d.device_id, reset_owner: "true" }, { token: d.device_token })).status, 422);
});

test("explicit repair atomically revokes old shares, clears old results and requires a fresh owner claim", async () => {
  const f = harness(), d = (await f.call("/devices/enroll", {})).data;
  await f.call("/devices/claim", { pair_code: d.pair_code }, { user: "owner-a" });
  const issued = await f.call("/devices/share", publication(f, d), { token: d.device_token }); assert.equal(issued.status, 200);
  const token = new URL(`https://handoff.test${issued.data.share.url}`).hash.slice("#access=".length);
  const queued = await f.call("/jobs", { action: "orders", args: {} }, { user: "owner-a" }); assert.equal(queued.status, 200);
  const repair = await f.call("/devices/renew", { device_id: d.device_id, reset_owner: true }, { token: d.device_token });
  assert.equal(repair.status, 200); assert.equal(repair.data.paired, false);
  assert.equal((await f.call(`/shares/${issued.data.share.id}/view`, {}, { token })).status, 410);
  assert.equal(JSON.parse(f.sqlite.prepare("SELECT card FROM mobile_shares WHERE id=?").get(issued.data.share.id).card).pickup_code, "");
  assert.equal(f.sqlite.prepare("SELECT state FROM mobile_jobs WHERE id=?").get(queued.data.job_id).state, "failed");
  assert.equal((await f.call("/devices/share", publication(f, d), { token: d.device_token })).status, 409);
  assert.equal((await f.call("/devices/claim", { pair_code: repair.data.pair_code }, { user: "owner-b" })).status, 200);
  assert.equal((await f.call("/session", undefined, { user: "owner-a" })).data.device, undefined);
  assert.equal((await f.call("/session", undefined, { user: "owner-b" })).data.device.id, d.device_id);
});

test("repair between completion validation and commit cannot issue an old-account share", async () => {
  const f = harness(), d = (await f.call("/devices/enroll", {})).data;
  await f.call("/devices/claim", { pair_code: d.pair_code }, { user: "owner-a" });
  const queued = await f.call("/jobs", { action: "create", args: { selection: "opaque", include_pickup_code: true } }, { user: "owner-a" });
  await f.call("/devices/poll", { device_id: d.device_id }, { token: d.device_token });
  const original = f.db.batch.bind(f.db); let armed = true;
  f.db.batch = async statements => {
    if (armed && statements.some(s => s.sql.startsWith("INSERT INTO mobile_shares"))) {
      armed = false;
      assert.equal((await f.call("/devices/renew", { device_id: d.device_id, reset_owner: true }, { token: d.device_token })).status, 200);
    }
    return original(statements);
  };
  const { device_id: ignored, ...result } = publication(f, d); void ignored;
  const complete = await f.call("/devices/complete", { device_id: d.device_id, job_id: queued.data.job_id, result }, { token: d.device_token });
  assert.equal(complete.status, 200);
  assert.equal(f.sqlite.prepare("SELECT count(*) AS n FROM mobile_shares").get().n, 0);
  assert.equal(f.sqlite.prepare("SELECT state FROM mobile_jobs WHERE id=?").get(queued.data.job_id).state, "failed");
  assert.equal(f.sqlite.prepare("SELECT owner_id FROM mobile_devices WHERE id=?").get(d.device_id).owner_id, null);
});
