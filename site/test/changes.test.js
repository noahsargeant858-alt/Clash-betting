'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { boot, client, signup, loginAdmin, makeUser } = require('./helper');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function world(t, opts) {
  const app = await boot(opts);
  t.after(() => app.close());
  const admin = await loginAdmin(app);
  return { app, admin, alice: makeUser(app, 'alice'), bob: makeUser(app, 'bob') };
}

const seqOf = async (c) => (await c.get('/api/changes?since=0&wait=0')).json.seq;

test('returns at once when there is something newer, with the current state of each changed doc', async (t) => {
  const w = await world(t);
  const s0 = await seqOf(w.alice.client);
  await w.admin.set('players/p1', { name: 'Ann' });
  await w.admin.set('players/p2', { name: 'Bob' });
  await w.admin.set('players/p1', { name: 'Anne' });
  await w.admin.write('delete', 'players/p2');
  const t0 = Date.now();
  const r = await w.alice.client.get(`/api/changes?since=${s0}&wait=20`);
  assert.ok(Date.now() - t0 < 2000, 'did not hold the request');
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.json.reset, false);
  assert.strictEqual(r.json.seq, s0 + 4);
  // one entry per document, latest state, in order of last change
  assert.deepStrictEqual(r.json.changes.map((c) => c.path), ['players/p1', 'players/p2'], 'ordered by last change');
  const p1 = r.json.changes.find((c) => c.path === 'players/p1');
  assert.deepStrictEqual(p1, { path: 'players/p1', exists: true, data: { name: 'Anne' }, version: 2 });
  const p2 = r.json.changes.find((c) => c.path === 'players/p2');
  assert.deepStrictEqual(p2, { path: 'players/p2', exists: false, version: 0 });
  // up to date: nothing new, and no wait asked for means no waiting
  const none = await w.alice.client.get(`/api/changes?since=${r.json.seq}`);
  assert.deepStrictEqual(none.json, { seq: r.json.seq, reset: false, changes: [] });
});

test('holds the request until a change arrives, then answers straight away', async (t) => {
  const w = await world(t);
  const s0 = await seqOf(w.alice.client);
  const t0 = Date.now();
  const pending = w.alice.client.get(`/api/changes?since=${s0}&wait=20`);
  await sleep(150);
  await w.admin.set('matches/m1', { date: 'x' });
  const r = await pending;
  const took = Date.now() - t0;
  assert.ok(took >= 140 && took < 3000, `woke on the change (${took} ms)`);
  assert.strictEqual(r.json.reset, false);
  assert.strictEqual(r.json.seq, s0 + 1);
  assert.deepStrictEqual(r.json.changes, [{ path: 'matches/m1', exists: true, data: { date: 'x' }, version: 1 }]);
});

test('times out empty after the wait, with the unchanged seq', async (t) => {
  const w = await world(t);
  const s0 = await seqOf(w.alice.client);
  const t0 = Date.now();
  const r = await w.alice.client.get(`/api/changes?since=${s0}&wait=1`);
  const took = Date.now() - t0;
  assert.ok(took >= 900 && took < 2500, `held about a second (${took} ms)`);
  assert.deepStrictEqual(r.json, { seq: s0, reset: false, changes: [] });
  assert.strictEqual(r.headers['cache-control'], 'no-store');
  // wait that is not a number, or negative, means don't wait
  for (const wait of ['abc', '-5', '', 'NaN']) {
    const t1 = Date.now();
    assert.strictEqual((await w.alice.client.get(`/api/changes?since=${s0}&wait=${wait}`)).status, 200);
    assert.ok(Date.now() - t1 < 500, `wait=${wait}`);
  }
});

test('wait is capped at 25 seconds', async (t) => {
  const w = await world(t);
  const s0 = await seqOf(w.alice.client);
  const timers = [];
  const realSet = global.setTimeout;
  global.setTimeout = (fn, ms, ...a) => { timers.push(ms); return realSet(fn, ms, ...a); };
  try {
    const pending = w.alice.client.get(`/api/changes?since=${s0}&wait=3600`);
    await sleep(100);
    await w.admin.set('matches/m1', { a: 1 }); // wake it so the test is quick
    await pending;
  } finally { global.setTimeout = realSet; }
  assert.ok(timers.includes(25000), 'the hold timer was 25 s, not an hour');
  assert.ok(!timers.includes(3600000));
});

test('bad since values and no session', async (t) => {
  const w = await world(t);
  for (const q of ['', 'since=', 'since=abc', 'since=-1', 'since=1.5', 'since=1e3', 'since=0x10', 'since=NaN', 'since=%00']) {
    assert.strictEqual((await w.alice.client.get(`/api/changes?${q}`)).status, 400, q);
  }
  assert.strictEqual((await client(w.app).get('/api/changes?since=0')).status, 401);
  assert.strictEqual((await client(w.app).get('/api/changes?since=0&wait=5')).status, 401, 'signed-out requests are not held');
});

test('reset: when since is older than the change log, or from the future', async (t) => {
  const w = await world(t, { storeLimits: { maxLog: 5 } });
  const s0 = await seqOf(w.alice.client);
  for (let i = 0; i < 8; i++) await w.admin.set(`misc/d${i}`, { i });
  const old = await w.alice.client.get(`/api/changes?since=${s0}`);
  assert.deepStrictEqual(old.json, { seq: s0 + 8, reset: true, changes: [] });
  const edge = await w.alice.client.get(`/api/changes?since=${s0 + 3}`);
  assert.strictEqual(edge.json.reset, false, 'the log still covers everything after seq+3');
  assert.strictEqual(edge.json.changes.length, 5);
  const future = await w.alice.client.get(`/api/changes?since=${s0 + 1000}&wait=5`);
  assert.strictEqual(future.json.reset, true, 'a client ahead of the server (a restored backup) must re-list, not hang');
  assert.strictEqual(future.json.seq, s0 + 8);
});

test('after a restart the log is empty: older clients re-list, current ones carry on', async (t) => {
  const dataDir = require('./helper').tmp('cb-restart-');
  const a = await boot({ dataDir });
  const admin = await loginAdmin(a);
  await admin.set('misc/a', { v: 1 });
  await admin.set('misc/b', { v: 1 });
  const seq = (await admin.get('/api/changes?since=0')).json.seq;
  await a.close();
  const b = await boot({ dataDir });
  t.after(() => b.close());
  const admin2 = await loginAdmin(b);
  assert.strictEqual((await admin2.get(`/api/changes?since=${seq - 1}`)).json.reset, true);
  const same = await admin2.get(`/api/changes?since=${seq}`);
  assert.deepStrictEqual(same.json, { seq, reset: false, changes: [] });
  await admin2.set('misc/c', { v: 1 });
  assert.strictEqual((await admin2.get(`/api/changes?since=${seq}`)).json.changes[0].path, 'misc/c');
});

test('too many changes at once means "re-list", not an enormous answer', async (t) => {
  const w = await world(t);
  const s0 = await seqOf(w.alice.client);
  for (let i = 0; i < 1100; i++) w.app.store.write('set', `misc/bulk${i}`, { i });
  const r = await w.alice.client.get(`/api/changes?since=${s0}`);
  assert.strictEqual(r.json.reset, true);
  assert.deepStrictEqual(r.json.changes, []);
});

test('never leaks paths the caller cannot read: not at once, not by waking, not in the data', async (t) => {
  const w = await world(t);
  const a = w.alice, b = w.bob;
  const s0 = await seqOf(a.client);
  // bob writes in his private area; alice (and the admin) must not hear of it
  const t0 = Date.now();
  const alicePending = a.client.get(`/api/changes?since=${s0}&wait=1`);
  const adminPending = w.admin.get(`/api/changes?since=${s0}&wait=1`);
  await sleep(100);
  assert.strictEqual((await b.client.set(`data/users/${b.uid}/diary`, { text: 'top secret' })).status, 200);
  const [ra, rd] = await Promise.all([alicePending, adminPending]);
  assert.ok(Date.now() - t0 >= 900, 'a change they cannot read does not wake them');
  for (const r of [ra, rd]) {
    assert.deepStrictEqual(r.json.changes, []);
    assert.ok(!r.text.includes('secret') && !r.text.includes('diary'));
  }
  // asking again from the start: still nothing, and no hint of the path
  for (const c of [a.client, w.admin]) {
    const r = await c.get('/api/changes?since=0');
    assert.ok(!r.text.includes('top secret') && !r.text.includes('diary') && !r.text.includes('data/users'));
  }
  // bob sees his own
  const mine = await b.client.get('/api/changes?since=0');
  assert.ok(mine.json.changes.some((c) => c.path === `data/users/${b.uid}/diary` && c.data.text === 'top secret'));
  // and a readable change in between does arrive, alone
  await b.client.set(`claims/${b.uid}`, { playerId: 'p1' });
  const mixed = await a.client.get(`/api/changes?since=${s0}`);
  assert.deepStrictEqual(mixed.json.changes.map((c) => c.path), [`claims/${b.uid}`]);
  // a delete of an unreadable doc is not visible either
  const s1 = mixed.json.seq;
  await b.client.write('delete', `data/users/${b.uid}/diary`);
  const afterDelete = await a.client.get(`/api/changes?since=${s1}`);
  assert.deepStrictEqual(afterDelete.json.changes, []);
});

test('at most 4 long-polls per user: the oldest is answered empty', async (t) => {
  const w = await world(t);
  const s0 = await seqOf(w.alice.client);
  const polls = [];
  for (let i = 0; i < 5; i++) {
    polls.push(w.alice.client.get(`/api/changes?since=${s0}&wait=10`).then((r) => ({ r, at: Date.now() })));
    await sleep(60);
  }
  const first = await Promise.race([polls[0], sleep(3000).then(() => null)]);
  assert.ok(first, 'the oldest was answered without a change');
  assert.deepStrictEqual(first.r.json, { seq: s0, reset: false, changes: [] });
  // the rest are still waiting; another user is not affected by alice's count
  const bobPoll = w.bob.client.get(`/api/changes?since=${s0}&wait=10`);
  await sleep(100);
  await w.admin.set('players/p1', { name: 'Ann' });
  const rest = await Promise.all([...polls.slice(1), bobPoll]);
  for (const x of rest) {
    const r = x.r || x;
    assert.strictEqual(r.json.changes[0].path, 'players/p1');
  }
});

test('polling in a loop never misses a change, however quickly they come', async (t) => {
  const w = await world(t);
  const seen = new Map();
  let since = await seqOf(w.alice.client), stop = false;
  const loop = (async () => {
    while (!stop) {
      const r = await w.alice.client.get(`/api/changes?since=${since}&wait=2`);
      assert.strictEqual(r.json.reset, false);
      for (const c of r.json.changes) seen.set(c.path, c);
      since = r.json.seq;
    }
  })();
  for (let i = 0; i < 40; i++) {
    await w.admin.set(`misc/d${i % 25}`, { i });
    if (i % 7 === 0) await sleep(20);
  }
  await sleep(200);
  stop = true;
  await w.app.close(); // answers the poll that is still waiting
  await loop;
  assert.strictEqual(seen.size, 25);
  for (let k = 0; k < 25; k++) {
    const last = k + (k + 25 < 40 ? 25 : 0);
    assert.strictEqual(seen.get(`misc/d${k}`).data.i, last, `final state of d${k}`);
  }
});

test('a client that goes away does not leave a waiter behind', async (t) => {
  const w = await world(t);
  const s0 = await seqOf(w.alice.client);
  const http = require('http');
  await new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port: w.app.port, path: `/api/changes?since=${s0}&wait=20`, agent: false, headers: { Cookie: w.alice.client.cookie } });
    req.on('error', () => {});
    req.end();
    setTimeout(() => { req.destroy(); setTimeout(resolve, 150); }, 150);
  });
  await w.admin.set('misc/x', { v: 1 }); // would throw inside the server if it wrote to a dead socket
  assert.strictEqual((await w.alice.client.get('/api/auth/me')).status, 200);
  // closing the server answers any waiting long-poll instead of hanging the shutdown
  const pending = w.bob.client.get(`/api/changes?since=${(await seqOf(w.bob.client))}&wait=20`);
  await sleep(100);
  const t0 = Date.now();
  await w.app.close();
  assert.ok(Date.now() - t0 < 3000);
  assert.deepStrictEqual((await pending).json.changes, []);
});

test('profiles: display names for uids, empty for strangers, nothing else', async (t) => {
  const w = await world(t);
  const friend = await signup(w.app, 'friend', { display: 'Fran <b>' });
  const ids = [friend.uid, w.alice.uid, 'u_doesnotexist', '__proto__', 'a/b', '', 5, null, w.alice.uid, 'x'.repeat(300), 'constructor'];
  const r = await w.alice.client.post('/api/profiles', { ids });
  assert.strictEqual(r.status, 200);
  const p = r.json.profiles;
  assert.deepStrictEqual(p[friend.uid], { name: 'Fran <b>' });
  assert.deepStrictEqual(p[w.alice.uid], { name: 'alice' });
  assert.deepStrictEqual(p.u_doesnotexist, { name: '' });
  assert.deepStrictEqual(Object.keys(p).sort(), [friend.uid, w.alice.uid, 'u_doesnotexist', '__proto__', 'constructor', '', 'a/b'].sort(), 'strings of up to 200 characters get an answer (empty for strangers); the rest are skipped');
  assert.deepStrictEqual(Object.getOwnPropertyDescriptor(p, '__proto__').value, { name: '' }, 'a hostile id is just a key');
  assert.strictEqual(({}).name, undefined);
  assert.ok(!/pass|hash|username|admin|s1:/.test(r.text.replace(/"name"/g, '')), 'names only');
  assert.deepStrictEqual((await w.alice.client.post('/api/profiles', { ids: [] })).json, { profiles: {} });
  // limits and shapes
  assert.strictEqual((await w.alice.client.post('/api/profiles', { ids: Array(100).fill('u_x') })).status, 200);
  assert.strictEqual((await w.alice.client.post('/api/profiles', { ids: Array(101).fill('u_x') })).status, 400);
  for (const body of [{}, { ids: 'u_x' }, { ids: { a: 1 } }, { ids: null }]) assert.strictEqual((await w.alice.client.post('/api/profiles', body)).status, 400, JSON.stringify(body));
  assert.strictEqual((await client(w.app).post('/api/profiles', { ids: [] })).status, 401);
  // a disabled account still has a name (old bets still show who placed them)
  w.app.auth.setDisabled(w.app.auth.users.get(friend.uid), true);
  assert.strictEqual((await w.alice.client.post('/api/profiles', { ids: [friend.uid] })).json.profiles[friend.uid].name, 'Fran <b>');
});
