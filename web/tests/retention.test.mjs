import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { createMobileHandler } from "../lib/mobile-api.mjs";

test("cloud retention physically deletes bounded old rows, preserving recent summaries and active content", async () => {
  const connection = new DatabaseSync(":memory:");
  const migrations = new URL("../drizzle/", import.meta.url);
  for (const file of readdirSync(migrations).filter(f => f.endsWith(".sql")).sort()) connection.exec(readFileSync(new URL(file, migrations), "utf8"));
  const prepare = sql => {
    let values = [];
    const query = {
      bind(...args) { values = args; return query; },
      async first() { return connection.prepare(sql).get(...values) || null; },
      async all() { return { results: connection.prepare(sql).all(...values) }; },
      run() { return connection.prepare(sql).run(...values); },
    };
    return query;
  };
  const db = { prepare, async batch(statements) {
    connection.exec("BEGIN");
    try { const results = statements.map(q => q.run()); connection.exec("COMMIT"); return results; }
    catch (e) { connection.exec("ROLLBACK"); throw e; }
  } };
  const now = Date.parse("2026-10-09T16:00:00Z"), cutoff = now - 7 * 86400_000;
  const card = JSON.stringify({ pickup_code: "SYNTHETIC-CODE" });
  const share = connection.prepare("INSERT INTO mobile_shares(id,owner_id,device_id,token_hash,record_id,card,queried_at,expires_at,verified) VALUES(?,'test-owner','test-device','hash','record',?,'time',?,0)");
  const job = connection.prepare("INSERT INTO mobile_jobs(id,owner_id,device_id,action,args,state,created_at,expires_at,result) VALUES(?,'test-owner','test-device','orders','{}','done',0,?,NULL)");
  for (let i = 0; i < 80; i++) { share.run(`old-share-${i}`, card, cutoff - i - 1); job.run(`old-job-${i}`, cutoff - i - 1); }
  share.run("recent", card, cutoff); job.run("recent", cutoff);
  share.run("active", card, now + 60_000); job.run("active", now + 60_000);
  const handle = createMobileHandler(db, { clock: () => now });
  const call = () => handle(new Request("https://test.invalid/api/mobile/session"));
  assert.equal((await call()).status, 200);
  assert.equal(connection.prepare("SELECT count(*) n FROM mobile_shares WHERE expires_at<?").get(cutoff).n, 55);
  assert.equal(connection.prepare("SELECT count(*) n FROM mobile_jobs WHERE expires_at<?").get(cutoff).n, 30);
  assert.ok(connection.prepare("SELECT id FROM mobile_shares WHERE id='recent'").get());
  assert.equal(JSON.parse(connection.prepare("SELECT card FROM mobile_shares WHERE id='active'").get().card).pickup_code, "SYNTHETIC-CODE");
  for (let i = 0; i < 3; i++) assert.equal((await call()).status, 200);
  assert.equal(connection.prepare("SELECT count(*) n FROM mobile_shares WHERE expires_at<?").get(cutoff).n, 0);
  assert.equal(connection.prepare("SELECT count(*) n FROM mobile_jobs WHERE expires_at<?").get(cutoff).n, 0);
  for (const table of ["mobile_jobs", "mobile_shares"]) {
    const plan = connection.prepare(`EXPLAIN QUERY PLAN SELECT id FROM ${table} WHERE expires_at<? ORDER BY expires_at LIMIT 25`).all(cutoff);
    assert.ok(plan.some(row => row.detail.includes(`${table}_retention_idx`)));
  }
  connection.close();
});
