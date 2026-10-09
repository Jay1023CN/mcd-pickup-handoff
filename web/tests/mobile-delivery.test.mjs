import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { createMobileHandler } from '../lib/mobile-api.mjs';
import { createTestDatabase } from './helpers/d1.mjs';

function fixture() {
  const db = createTestDatabase(); let now = Date.now();
  const handler = createMobileHandler(db, { clock: () => now });
  async function call(path, body, { cookie, token } = {}) {
    const r = await handler(new Request(`https://handoff.test/api/mobile${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { ...(body === undefined ? {} : { 'content-type': 'application/json', origin: 'https://handoff.test' }), ...(cookie ? { cookie } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }));
    return { status: r.status, data: await r.json(), cookie: r.headers.get('set-cookie')?.split(';')[0] };
  }
  async function paired() {
    const d = (await call('/devices/enroll', {})).data;
    const c = await call('/devices/claim', { pair_code: d.pair_code }); assert.equal(c.status, 200);
    return { ...d, cookie: c.cookie };
  }
  const card = () => ({ kind: 'mcp', retrieved_at: new Date(now).toISOString(), store_name: '测试店', store_address: '', pickup_mode: '外带', status_text: '配餐中', items: [{ name: '模拟餐品', quantity: 1 }], pickup_code: 'SYNTHETIC_CODE' });
  const value = (record = 'a'.repeat(32)) => ({ card: card(), record_id: record, expires_at: new Date(now + 600_000).toISOString(), queried_at: new Date(now).toISOString() });
  const publish = (d, v = value()) => call('/devices/share', { device_id: d.device_id, ...v }, { token: d.device_token });
  return { db, call, paired, card, value, publish, time: () => now, advance: n => now += n };
}
const tokenOf = s => s.share.url.split('#access=')[1];

test('direct Skill issuance recovers its exact link without creating a fake MCP job', async () => {
  const f = fixture(), d = await f.paired(), p = await f.publish(d); assert.equal(p.status, 200);
  const list = await f.call('/shares', undefined, { cookie: d.cookie });
  assert.equal(list.data.entries[0].url, p.data.share.url);
  assert.equal(f.db.connection.prepare('SELECT count(*) n FROM mobile_jobs').get().n, 0);
  const stored = f.db.connection.prepare('SELECT * FROM mobile_shares').get();
  assert.equal(stored.delivery_url, p.data.share.url); assert.notEqual(stored.token_hash, tokenOf(p.data)); assert.equal(stored.issue_key, stored.record_id);
  const response = JSON.stringify(list.data); assert.equal(response.includes('SYNTHETIC_CODE'), false); assert.equal(response.includes(stored.record_id), false);
  assert.equal((await f.call('/shares', undefined, { token: d.device_token })).status, 401);
  assert.equal((await f.call('/shares', undefined, { token: tokenOf(p.data) })).status, 401);
});

test('serial and concurrent direct retries issue one capability without extending TTL or overwriting official content', async () => {
  const f = fixture(), d = await f.paired(), v = f.value();
  const replies = await Promise.all(Array.from({ length: 3 }, () => f.publish(d, v)));
  assert.ok(replies.every(r => r.status === 200)); assert.equal(new Set(replies.map(r => r.data.share.url)).size, 1);
  assert.equal(f.db.connection.prepare('SELECT count(*) n FROM mobile_shares').get().n, 1);
  f.advance(5000);
  const retry = await f.publish(d, { ...f.value(), card: { ...f.card(), pickup_code: 'IGNORED_NEW_CODE' } });
  assert.deepEqual(retry.data, replies[0].data);
  const rows = f.db.connection.prepare('SELECT delivery_url,card FROM mobile_shares').all(); assert.equal(JSON.stringify(rows).includes('IGNORED_NEW_CODE'), false);
});

test('the same local record in different owners or devices stays separately scoped', async () => {
  const f = fixture(), a = await f.paired(), b = await f.paired(), pa = await f.publish(a), pb = await f.publish(b);
  assert.notEqual(pa.data.share.id, pb.data.share.id);
  const al = await f.call('/shares', undefined, { cookie: a.cookie }), bl = await f.call('/shares', undefined, { cookie: b.cookie });
  assert.equal(al.data.entries.length, 1); assert.equal(bl.data.entries.length, 1);
  assert.equal(JSON.stringify(al.data).includes(tokenOf(pb.data)), false);
  assert.equal((await f.call(`/shares/${pa.data.share.id}/view`, {}, { token: tokenOf(pb.data) })).status, 404);
  const c = await f.paired();
  const owner = f.db.connection.prepare('SELECT owner_id FROM mobile_devices WHERE id=?').get(a.device_id).owner_id;
  f.db.connection.prepare('UPDATE mobile_devices SET owner_id=? WHERE id=?').run(owner, c.device_id);
  const pc = await f.publish(c); assert.notEqual(pc.data.share.id, pa.data.share.id);
  assert.equal((await f.call('/shares', undefined, { cookie: a.cookie })).data.entries.length, 2);
});

test('revocation, collected feedback, reset and expiry erase delivery URLs and cannot resurrect the same issuance', async () => {
  for (const reason of ['revoke', 'collected', 'reset', 'expiry']) {
    const f = fixture(), d = await f.paired(), p = await f.publish(d); const id = p.data.share.id;
    if (reason === 'revoke') await f.call(`/shares/${id}/revoke`, {}, { cookie: d.cookie });
    if (reason === 'collected') await f.call(`/shares/${id}/progress`, { step: 'collected' }, { token: tokenOf(p.data) });
    if (reason === 'reset') await f.call('/devices/renew', { device_id: d.device_id, reset_owner: true }, { token: d.device_token });
    if (reason === 'expiry') { f.advance(600_001); await f.call('/session'); }
    assert.equal(f.db.connection.prepare('SELECT delivery_url FROM mobile_shares WHERE id=?').get(id).delivery_url, null);
    const list = await f.call('/shares', undefined, { cookie: d.cookie }); assert.ok(list.data.entries.every(e => !e.url));
    const retry = await f.publish(d); assert.equal(retry.status, reason === 'collected' || reason === 'reset' ? 409 : 410);
    assert.equal(f.db.connection.prepare('SELECT count(*) n FROM mobile_shares').get().n, 1);
    if (reason === 'collected') assert.equal(JSON.parse(f.db.connection.prepare('SELECT card FROM mobile_shares').get().card).status_text, '配餐中');
  }
});

test('web completion and simultaneous direct publication converge on one stored issuance and owner projection', async () => {
  const f = fixture(), d = await f.paired();
  const j = await f.call('/jobs', { action: 'create', args: { selection: 'opaque', include_pickup_code: true } }, { cookie: d.cookie });
  await f.call('/devices/poll', { device_id: d.device_id }, { token: d.device_token });
  const v = f.value();
  const [direct, complete] = await Promise.all([f.publish(d, v), f.call('/devices/complete', { device_id: d.device_id, job_id: j.data.job_id, result: v }, { token: d.device_token })]);
  assert.equal(direct.status, 200); assert.equal(complete.status, 200);
  const done = await f.call(`/jobs/${j.data.job_id}`, undefined, { cookie: d.cookie }); assert.equal(done.data.result.share.url, direct.data.share.url);
  assert.equal(f.db.connection.prepare('SELECT count(*) n FROM mobile_shares').get().n, 1);
  const saved = f.db.connection.prepare('SELECT result FROM mobile_jobs').get().result;
  assert.equal(saved.includes('#access='), false); assert.equal(saved.includes(tokenOf(direct.data)), false);
});

test('delivery cleanup is bounded and indexed even when stored codes were already removed', async () => {
  const f = fixture(), d = await f.paired();
  const owner = f.db.connection.prepare('SELECT owner_id FROM mobile_devices WHERE id=?').get(d.device_id).owner_id;
  const insert = f.db.connection.prepare("INSERT INTO mobile_shares(id,owner_id,device_id,token_hash,record_id,card,queried_at,expires_at,verified,delivery_url) VALUES(?,?,?,'hash','old',?,?,?,0,?)");
  for (let i = 0; i < 40; i++) { const id = i.toString(16).padStart(32, '0'); insert.run(id, owner, d.device_id, JSON.stringify({ ...f.card(), pickup_code: '' }), new Date(f.time()).toISOString(), f.time()-1, `/take/${id}#access=${'b'.repeat(64)}`); }
  await f.call('/session'); assert.equal(f.db.connection.prepare('SELECT count(*) n FROM mobile_shares WHERE delivery_url IS NOT NULL').get().n, 15);
  const plan = f.db.connection.prepare('EXPLAIN QUERY PLAN SELECT id FROM mobile_shares WHERE delivery_url IS NOT NULL AND expires_at<=? ORDER BY expires_at LIMIT 25').all(f.time()).map(r => r.detail).join(' ');
  assert.match(plan, /mobile_shares_delivery_cleanup_idx/); assert.doesNotMatch(plan, /TEMP B-TREE/);
});

test('0006 upgrades a populated v3 database with duplicate records without removing history or reviving inactive links', () => {
  const db = new DatabaseSync(':memory:'), migrations = new URL('../drizzle/', import.meta.url), now = Date.now();
  for (const file of readdirSync(migrations).filter(f => /^000[0-5].*\.sql$/.test(f)).sort()) db.exec(readFileSync(new URL(file, migrations), 'utf8'));
  const addShare = db.prepare('INSERT INTO mobile_shares(id,owner_id,device_id,token_hash,record_id,card,queried_at,expires_at,verified,revoked,progress_step) VALUES(?,?,?,?,?,?,?,?,1,?,?)');
  const addJob = db.prepare("INSERT INTO mobile_jobs(id,owner_id,device_id,action,args,state,result,created_at,expires_at) VALUES(?,?,?,'create','{}','done',?,?,?)");
  const urlFor = id => `/take/${id}#access=${'c'.repeat(64)}`;
  const ids = Array.from({ length: 8 }, (_, i) => (i + 1).toString(16).padStart(32, '0'));
  for (let i = 0; i < ids.length; i++) {
    const record = i < 3 ? 'duplicate' : `record-${i}`;
    const revoked = i === 3 ? 1 : 0, progress = i === 4 ? 'collected' : null, expires = i === 5 ? now - 1000 : now + 200_000 + i * 1000;
    addShare.run(ids[i], 'owner', 'device', 'hash', record, JSON.stringify({ pickup_code: 'TEST' }), new Date(now).toISOString(), expires, revoked, progress);
    addJob.run(`job${i}`, i === 6 ? 'wrong-owner' : 'owner', i === 7 ? 'wrong-device' : 'device', JSON.stringify({ share: { id: ids[i], url: urlFor(ids[i]) } }), now+i, expires);
  }
  db.exec(readFileSync(new URL('0006_share_delivery.sql', migrations), 'utf8'));
  assert.equal(db.prepare('SELECT count(*) n FROM mobile_shares').get().n, 8);
  const duplicate = db.prepare("SELECT * FROM mobile_shares WHERE record_id='duplicate' ORDER BY expires_at DESC").all();
  assert.equal(duplicate.filter(s => s.issue_key !== null).length, 1); assert.equal(duplicate[0].delivery_url, urlFor(ids[2]));
  assert.ok(duplicate.slice(1).every(s => s.delivery_url === null));
  for (const id of ids.slice(3)) assert.equal(db.prepare('SELECT delivery_url FROM mobile_shares WHERE id=?').get(id).delivery_url, null);
  assert.ok(db.prepare('SELECT result FROM mobile_jobs').all().every(j => !j.result.includes('#access=')));
  assert.throws(() => db.prepare('UPDATE mobile_shares SET issue_key=record_id WHERE id=?').run(ids[0]), /UNIQUE constraint/);
  db.close();
});

test('reuse cannot defeat a web request that explicitly excludes the pickup code', async () => {
  const f = fixture(), d = await f.paired(), p = await f.publish(d);
  const j = await f.call('/jobs', { action: 'create', args: { selection: 'opaque', include_pickup_code: false } }, { cookie: d.cookie });
  await f.call('/devices/poll', { device_id: d.device_id }, { token: d.device_token });
  const c = await f.call('/devices/complete', { device_id: d.device_id, job_id: j.data.job_id, result: f.value() }, { token: d.device_token }); assert.equal(c.status, 200);
  const done = await f.call(`/jobs/${j.data.job_id}`, undefined, { cookie: d.cookie });
  assert.equal(done.data.state, 'failed'); assert.equal(done.data.result, undefined);
  assert.equal(f.db.connection.prepare('SELECT count(*) n FROM mobile_shares').get().n, 1);
  assert.equal(f.db.connection.prepare('SELECT delivery_url FROM mobile_shares').get().delivery_url, p.data.share.url);
});

test('explicit reset between direct validation and commit cannot return an old owner capability', async () => {
  const f = fixture(), d = await f.paired(), originalBatch = f.db.batch.bind(f.db);
  let armed = true;
  f.db.batch = async statements => {
    if (armed && statements.length === 2) {
      armed = false;
      const reset = await f.call('/devices/renew', { device_id: d.device_id, reset_owner: true }, { token: d.device_token }); assert.equal(reset.status, 200);
    }
    return originalBatch(statements);
  };
  const p = await f.publish(d); assert.equal(p.status, 409);
  assert.equal(f.db.connection.prepare('SELECT count(*) n FROM mobile_shares').get().n, 0);
});

test('direct hidden-code retries reject an existing coded issuance without changing or returning its capability', async () => {
  const f = fixture(), d = await f.paired(), original = await f.publish(d);
  const before = f.db.connection.prepare('SELECT * FROM mobile_shares').get();
  const hidden = { ...f.value(), card: { ...f.card(), pickup_code: '' } };
  const results = await Promise.all([f.publish(d, hidden), f.publish(d, hidden)]);
  for (const r of results) { assert.equal(r.status, 409); assert.equal(r.data.share, undefined); assert.equal(r.data.card, undefined); assert.match(r.data.error, /原交接包含取餐码/); }
  assert.deepEqual(f.db.connection.prepare('SELECT * FROM mobile_shares').get(), before);
  const view = await f.call(`/shares/${original.data.share.id}/view`, {}, { token: tokenOf(original.data) }); assert.equal(view.data.card.pickup_code, 'SYNTHETIC_CODE');
});

test('an originally hidden direct issuance remains idempotent through serial and concurrent retries', async () => {
  const f = fixture(), d = await f.paired(), hidden = { ...f.value(), card: { ...f.card(), pickup_code: '' } };
  const first = await f.publish(d, hidden), retries = await Promise.all([f.publish(d, hidden), f.publish(d, hidden)]);
  assert.equal(first.status, 200); for (const r of retries) { assert.equal(r.status, 200); assert.deepEqual(r.data, first.data); }
  assert.equal(f.db.connection.prepare('SELECT count(*) n FROM mobile_shares').get().n, 1);
});

test('direct coded and hidden candidates are checked against the actual winner in both commit orders', async () => {
  for (const codedWins of [true, false]) {
    const f = fixture(), d = await f.paired(), rawPrepare = f.db.prepare.bind(f.db), rawBatch = f.db.batch.bind(f.db);
    f.db.prepare = sql => Object.assign(rawPrepare(sql), { reviewSql: sql });
    let reached, release; const atCommit = new Promise(r => reached = r), gate = new Promise(r => release = r); let paused = false;
    f.db.batch = async statements => {
      if (!paused && statements.some(s => s.reviewSql?.startsWith('INSERT INTO mobile_shares'))) { paused = true; reached(); await gate; }
      return rawBatch(statements);
    };
    const hidden = { ...f.value(), card: { ...f.card(), pickup_code: '' } };
    const loser = f.publish(d, codedWins ? hidden : f.value()); await atCommit;
    const winner = await f.publish(d, codedWins ? f.value() : hidden); assert.equal(winner.status, 200);
    release(); const lost = await loser;
    if (codedWins) { assert.equal(lost.status, 409); assert.equal(lost.data.share, undefined); }
    else { assert.equal(lost.status, 200); assert.equal(lost.data.card.pickup_code, ''); assert.equal(lost.data.share.url, winner.data.share.url); }
    const row = f.db.connection.prepare('SELECT * FROM mobile_shares').get(); assert.equal(row.delivery_url, winner.data.share.url); assert.equal(JSON.parse(row.card).pickup_code, codedWins ? 'SYNTHETIC_CODE' : '');
    assert.equal(f.db.connection.prepare('SELECT count(*) n FROM mobile_shares').get().n, 1);
  }
});

test('web hidden and direct coded candidates preserve privacy in both commit orders and release the job lock', async () => {
  for (const directWins of [true, false]) {
    const f = fixture(), d = await f.paired();
    const j = await f.call('/jobs', { action: 'create', args: { selection: 'opaque', include_pickup_code: false } }, { cookie: d.cookie });
    await f.call('/devices/poll', { device_id: d.device_id }, { token: d.device_token });
    const rawPrepare = f.db.prepare.bind(f.db), rawBatch = f.db.batch.bind(f.db);
    f.db.prepare = sql => Object.assign(rawPrepare(sql), { reviewSql: sql });
    let reached, release; const atCommit = new Promise(r => reached = r), gate = new Promise(r => release = r); let paused = false;
    f.db.batch = async statements => {
      const issuance = statements.some(s => s.reviewSql?.startsWith('INSERT INTO mobile_shares'));
      const web = statements.some(s => s.reviewSql?.startsWith("UPDATE mobile_jobs SET state='done'"));
      if (!paused && issuance && web === directWins) { paused = true; reached(); await gate; }
      return rawBatch(statements);
    };
    const complete = () => f.call('/devices/complete', { device_id: d.device_id, job_id: j.data.job_id, result: f.value() }, { token: d.device_token });
    const loser = directWins ? complete() : f.publish(d); await atCommit;
    const winner = directWins ? await f.publish(d) : await complete(); assert.equal(winner.status, 200);
    release(); assert.equal((await loser).status, 200);
    const done = await f.call(`/jobs/${j.data.job_id}`, undefined, { cookie: d.cookie });
    if (directWins) { assert.equal(done.data.state, 'failed'); assert.equal(done.data.result, undefined); assert.match(done.data.error, /原交接包含取餐码/); }
    else { assert.equal(done.data.state, 'done'); assert.equal(done.data.result.card.pickup_code, ''); }
    const device = f.db.connection.prepare('SELECT running_job FROM mobile_devices').get(); assert.equal(device.running_job, null);
    assert.equal(f.db.connection.prepare('SELECT count(*) n FROM mobile_shares').get().n, 1);
    assert.equal((await complete()).status, 200); // A failed privacy conflict is ACKed rather than retried forever.
    const card = JSON.parse(f.db.connection.prepare('SELECT card FROM mobile_shares').get().card); assert.equal(card.pickup_code, directWins ? 'SYNTHETIC_CODE' : '');
  }
});

test('private share-history response identifies the actual cookie owner and never exposes identity to anonymous bearer callers', async () => {
  const f = fixture(), a = await f.paired(), b = await f.paired();
  await f.publish(a); await f.publish(b);
  const sessionA = await f.call('/session', undefined, { cookie: a.cookie }), sessionB = await f.call('/session', undefined, { cookie: b.cookie });
  const historyA = await f.call('/shares', undefined, { cookie: a.cookie }), historyB = await f.call('/shares', undefined, { cookie: b.cookie });
  assert.equal(historyA.data.owner_id, sessionA.data.user.id); assert.equal(historyB.data.owner_id, sessionB.data.user.id); assert.notEqual(historyA.data.owner_id, historyB.data.owner_id);
  assert.equal(historyA.data.entries.length, 1); assert.equal(historyB.data.entries.length, 1); assert.notEqual(historyA.data.entries[0].id, historyB.data.entries[0].id);
  assert.deepEqual(Object.keys(historyA.data).sort(), ['entries', 'owner_id']);
  for (const options of [{}, { token: a.device_token }]) { const r = await f.call('/shares', undefined, options); assert.equal(r.status, 401); assert.equal(r.data.owner_id, undefined); assert.equal(r.data.entries, undefined); }
});
