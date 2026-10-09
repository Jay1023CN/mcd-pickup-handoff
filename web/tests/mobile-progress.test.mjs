import { test } from "node:test";
import assert from "node:assert/strict";
import { createMobileHandler } from "../lib/mobile-api.mjs";
import { createTestDatabase } from "./helpers/d1.mjs";

function fixture() {
  const db = createTestDatabase(); let now = Date.now();
  const handler = createMobileHandler(db, { clock: () => now });
  async function call(path, body, { cookie, token } = {}) {
    const response = await handler(new Request(`https://handoff.test/api/mobile${path}`, { method: body === undefined ? "GET" : "POST", headers: { ...(body === undefined ? {} : { "content-type": "application/json", origin: "https://handoff.test" }), ...(cookie ? { cookie } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }));
    return { status: response.status, data: await response.json(), cookie: response.headers.get("set-cookie")?.split(";")[0] };
  }
  async function paired() {
    const d = (await call("/devices/enroll", {})).data;
    const claim = await call("/devices/claim", { pair_code: d.pair_code }); assert.equal(claim.status, 200);
    return { ...d, cookie: claim.cookie };
  }
  function card() { return { kind: "mcp", retrieved_at: new Date(now).toISOString(), store_name: "测试餐厅", store_address: "", pickup_mode: "外带", status_text: "配餐中", items: [{ name: "测试餐品", quantity: 1 }], pickup_code: "SYNTHETIC_CODE" }; }
  async function issued(d) {
    const j = await call("/jobs", { action: "create", args: { selection: "opaque", include_pickup_code: true } }, { cookie: d.cookie }); assert.equal(j.status, 200);
    const poll = await call("/devices/poll", { device_id: d.device_id }, { token: d.device_token }); assert.equal(poll.data.job.id, j.data.job_id);
    const complete = await call("/devices/complete", { device_id: d.device_id, job_id: j.data.job_id, result: { card: card(), record_id: "a".repeat(32), expires_at: new Date(now + 600_000).toISOString(), queried_at: new Date(now).toISOString() } }, { token: d.device_token }); assert.equal(complete.status, 200);
    const done = await call(`/jobs/${j.data.job_id}`, undefined, { cookie: d.cookie });
    return { id: done.data.result.share.id, token: done.data.result.share.url.split("#access=")[1], create_job_id: j.data.job_id };
  }
  return { db, call, paired, issued, card, advance: n => now += n, time: () => now };
}

test("friend feedback advances monotonically, permits direct collected and is idempotent under concurrent retry", async () => {
  const f = fixture(), d = await f.paired(), s = await f.issued(d);
  const responses = await Promise.all([f.call(`/shares/${s.id}/progress`, { step: "accepted" }, { token: s.token }), f.call(`/shares/${s.id}/progress`, { step: "accepted" }, { token: s.token })]);
  assert.ok(responses.every(r => r.status === 200)); assert.deepEqual(responses[0].data, responses[1].data);
  const firstTime = responses[0].data.progress.updated_at;
  f.advance(2000);
  const again = await f.call(`/shares/${s.id}/progress`, { step: "accepted" }, { token: s.token }); assert.equal(again.data.progress.updated_at, firstTime);
  const arrived = await f.call(`/shares/${s.id}/progress`, { step: "arrived" }, { token: s.token }); assert.equal(arrived.status, 200); assert.equal(arrived.data.progress.updated_at, new Date(f.time()).toISOString());
  assert.equal((await f.call(`/shares/${s.id}/progress`, { step: "accepted" }, { token: s.token })).status, 409);
  f.advance(2000);
  const collected = await f.call(`/shares/${s.id}/progress`, { step: "collected" }, { token: s.token }); assert.equal(collected.status, 200);
  assert.equal((await f.call(`/shares/${s.id}/progress`, { step: "arrived" }, { token: s.token })).status, 409);
  const direct = await f.issued(d);
  assert.equal((await f.call(`/shares/${direct.id}/progress`, { step: "collected" }, { token: direct.token })).status, 200);
});

test("only a particular share bearer can write its progress, owner identity alone grants no public feedback access", async () => {
  const f = fixture(), aDevice = await f.paired(), a = await f.issued(aDevice), bDevice = await f.paired(), b = await f.issued(bDevice);
  assert.equal((await f.call(`/shares/${a.id}/progress`, { step: "accepted" }, { token: b.token })).status, 404);
  assert.equal((await f.call(`/shares/${a.id}/progress`, { step: "accepted" }, { cookie: aDevice.cookie })).status, 401);
  assert.equal((await f.call(`/shares/${a.id}/progress`, { step: "accepted" }, { token: aDevice.device_token })).status, 404);
  assert.equal((await f.call(`/shares/${a.id}/progress`, { step: "accepted" }, { token: a.token })).status, 200);
  const aList = await f.call("/shares", undefined, { cookie: aDevice.cookie }); assert.equal(aList.data.entries[0].progress.step, "accepted");
  const bList = await f.call("/shares", undefined, { cookie: bDevice.cookie }); assert.equal(bList.data.entries[0].progress, undefined);
  assert.equal(bList.data.entries.some(e => e.id === a.id), false);
});

test("invalid steps or fields never modify feedback and revoked or expired shares reject it", async () => {
  const f = fixture(), d = await f.paired(), s = await f.issued(d);
  for (const body of [{ step: "done" }, { step: "__proto__" }, { step: {} }, { step: "accepted", status_text: "订单已完成" }, {}]) assert.equal((await f.call(`/shares/${s.id}/progress`, body, { token: s.token })).status, 422);
  assert.equal(f.db.connection.prepare("SELECT progress_step FROM mobile_shares WHERE id=?").get(s.id).progress_step, null);
  await f.call(`/shares/${s.id}/revoke`, {}, { cookie: d.cookie });
  assert.equal((await f.call(`/shares/${s.id}/progress`, { step: "accepted" }, { token: s.token })).status, 410);
  const old = await f.issued(d); f.advance(600_000);
  assert.equal((await f.call(`/shares/${old.id}/progress`, { step: "collected" }, { token: old.token })).status, 410);
});

test("offline or unverified shares can receive manual feedback without restoring codes or official verification", async () => {
  const f = fixture(), d = await f.paired(), s = await f.issued(d); f.advance(61_000);
  const offline = await f.call(`/shares/${s.id}/progress`, { step: "arrived" }, { token: s.token }); assert.equal(offline.status, 200);
  const view = await f.call(`/shares/${s.id}/view`, {}, { token: s.token });
  assert.equal(view.data.online, false); assert.equal(view.data.verified, false); assert.equal(view.data.card.pickup_code, ""); assert.equal(view.data.card.status_text, "配餐中"); assert.equal(view.data.progress.step, "arrived");
  f.db.connection.prepare("UPDATE mobile_shares SET verified=0,card=json_set(card,'$.pickup_code','') WHERE id=?").run(s.id);
  await f.call("/devices/poll", { device_id: d.device_id }, { token: d.device_token });
  assert.equal((await f.call(`/shares/${s.id}/progress`, { step: "collected" }, { token: s.token })).status, 200);
  const unverified = await f.call(`/shares/${s.id}/view`, {}, { token: s.token }); assert.equal(unverified.data.verified, false); assert.equal(unverified.data.card.pickup_code, "");
});

test("collected is a separate manual report: API hides code and reshare URL without rewriting stored official card", async () => {
  const f = fixture(), d = await f.paired(), s = await f.issued(d);
  const before = f.db.connection.prepare("SELECT card,queried_at,verified FROM mobile_shares WHERE id=?").get(s.id);
  const jobCount = f.db.connection.prepare("SELECT count(*) AS n FROM mobile_jobs").get().n;
  const result = await f.call(`/shares/${s.id}/progress`, { step: "collected" }, { token: s.token }); assert.equal(result.status, 200);
  assert.deepEqual(f.db.connection.prepare("SELECT card,queried_at,verified FROM mobile_shares WHERE id=?").get(s.id), before);
  assert.equal(f.db.connection.prepare("SELECT count(*) AS n FROM mobile_jobs").get().n, jobCount);
  const view = await f.call(`/shares/${s.id}/view`, {}, { token: s.token }); assert.equal(view.data.card.pickup_code, ""); assert.equal(view.data.card.status_text, "配餐中"); assert.equal(view.data.verified, true); assert.equal(view.data.progress.step, "collected");
  const list = await f.call("/shares", undefined, { cookie: d.cookie }); assert.equal(list.data.entries[0].progress.step, "collected"); assert.equal(list.data.entries[0].url, undefined); assert.equal(list.data.entries[0].status_text, "配餐中");
});

test("an official refresh after manual collection keeps its saved result but cannot expose code through public job polling", async () => {
  const f = fixture(), d = await f.paired(), s = await f.issued(d);
  await f.call(`/shares/${s.id}/progress`, { step: "collected" }, { token: s.token });
  const refresh = await f.call(`/shares/${s.id}/refresh`, {}, { token: s.token }); assert.equal(refresh.status, 200);
  const poll = await f.call("/devices/poll", { device_id: d.device_id }, { token: d.device_token }); assert.equal(poll.data.job.id, refresh.data.job_id);
  f.advance(1000);
  const result = { verified: true, card: f.card(), queried_at: new Date(f.time()).toISOString(), notice: "已复查官方订单" };
  assert.equal((await f.call("/devices/complete", { device_id: d.device_id, job_id: refresh.data.job_id, result }, { token: d.device_token })).status, 200);
  const completed = await f.call(`/shares/${s.id}/jobs/${refresh.data.job_id}`, undefined, { token: s.token }); assert.equal(completed.data.result.card.pickup_code, ""); assert.equal(completed.data.result.verified, true); assert.equal(completed.data.result.card.status_text, "配餐中");
  const stored = f.db.connection.prepare("SELECT card,progress_step FROM mobile_shares WHERE id=?").get(s.id); assert.equal(JSON.parse(stored.card).pickup_code, "SYNTHETIC_CODE"); assert.equal(stored.progress_step, "collected");
  assert.equal((await f.call(`/shares/${s.id}/view`, {}, { token: s.token })).data.card.pickup_code, "");
});

test("manual collection also hides code and reshare URL from the owner's old create-job projection", async () => {
  const f = fixture(), d = await f.paired(), s = await f.issued(d), other = await f.issued(d);
  const before = f.db.connection.prepare("SELECT result FROM mobile_jobs WHERE id=?").get(s.create_job_id).result;
  assert.ok(before.includes("SYNTHETIC_CODE")); assert.ok(before.includes(s.token));
  await f.call(`/shares/${s.id}/progress`, { step: "collected" }, { token: s.token });
  const old = await f.call(`/jobs/${s.create_job_id}`, undefined, { cookie: d.cookie });
  assert.equal(old.status, 200); assert.equal(old.data.state, "done"); assert.equal(old.data.result.card.pickup_code, ""); assert.equal(old.data.result.share.url, undefined); assert.equal(old.data.result.card.status_text, "配餐中");
  assert.equal(f.db.connection.prepare("SELECT result FROM mobile_jobs WHERE id=?").get(s.create_job_id).result, before);
  const untouched = await f.call(`/jobs/${other.create_job_id}`, undefined, { cookie: d.cookie }); assert.equal(untouched.data.result.card.pickup_code, "SYNTHETIC_CODE"); assert.ok(untouched.data.result.share.url.includes(other.token));
});
