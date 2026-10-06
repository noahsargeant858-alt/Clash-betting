'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { boot, request, client, signup, loginAdmin, makeUser } = require('./helper');

// admin + two ordinary users, and one of each kind of document
async function world(t, opts) {
  const app = await boot(opts);
  t.after(() => app.close());
  const admin = await loginAdmin(app);
  const alice = makeUser(app, 'alice'), bob = makeUser(app, 'bob');
  for (const [p, d] of [['players/p1', { name: 'Ann' }], ['config/settings', { adminUid: 'x' }], ['links/p1', { uid: alice.uid }], ['matches/m1', { date: 'd' }]]) {
    assert.strictEqual((await admin.set(p, d)).status, 200, p);
  }
  return { app, admin, alice, bob, anon: client(app) };
}

const A = (w) => w.alice.uid, B = (w) => w.bob.uid;

test('every row of the access table, for the owner, other users, and the admin', async (t) => {
  const w = await world(t);
  const rows = [
    // [path, who may write, who may read]  (a = alice, b = bob, d = admin)
    [`data/users/${A(w)}/n1`, 'a', 'a'],
    [`data/users/${B(w)}/n1`, 'b', 'b'],
    ['players/x1', 'd', 'abd'],
    ['config/x1', 'd', 'abd'],
    ['links/x1', 'd', 'abd'],
    ['matches/x1', 'd', 'abd'],
    [`claims/${A(w)}`, 'ad', 'abd'],
    [`bets/${A(w)}`, 'ad', 'abd'],
    [`acts/${A(w)}/items/i1`, 'ad', 'abd'],
    [`claims/${B(w)}`, 'bd', 'abd'],
    [`bets/${B(w)}`, 'bd', 'abd'],
    [`acts/${B(w)}/items/i1`, 'bd', 'abd'],
    ['misc/thing', 'd', 'abd'],
    ['data/other', 'd', 'abd'],
  ];
  const people = { a: w.alice.client, b: w.bob.client, d: w.admin };
  for (const [path, canWrite, canRead] of rows) {
    // the first writer in the list creates it, so that reads have something to find
    let created = false;
    for (const [who, c] of Object.entries(people)) {
      const r = await c.set(path, { by: who, secret: 'hello', list: [] });
      if (canWrite.includes(who)) {
        assert.strictEqual(r.status, 200, `${who} should be able to write ${path}: ${r.text}`);
        created = true;
      } else {
        assert.strictEqual(r.status, 403, `${who} must not write ${path} (got ${r.status})`);
        assert.match(r.json.error, /can't change that/);
      }
    }
    assert.ok(created, path);
    for (const [who, c] of Object.entries(people)) {
      const d = await c.doc(path);
      assert.strictEqual(d.status, 200);
      assert.strictEqual(d.json.exists, canRead.includes(who), `${who} reading ${path}`);
      if (!d.json.exists) assert.deepStrictEqual(Object.keys(d.json).sort(), ['exists', 'id', 'seq'], 'unreadable looks exactly like missing');
      const coll = path.split('/').slice(0, -1).join('/');
      const l = await c.list(coll);
      assert.strictEqual(l.status, 200);
      assert.strictEqual(l.json.docs.some((x) => x.id === path.split('/').pop()), canRead.includes(who), `${who} listing ${coll}`);
    }
    // deleting follows the write rule
    for (const [who, c] of Object.entries(people)) {
      const r = await c.write('delete', path);
      // a bet list can't be torn up by its owner (that would be a way to dodge a loss); only the admin may
      const expected = !canWrite.includes(who) ? 403 : path.startsWith('bets/') && who !== 'd' ? 409 : 200;
      assert.strictEqual(r.status, expected, `${who} deleting ${path}`);
    }
  }
});

test('another user\'s data/users subtree is invisible even to the admin', async (t) => {
  const w = await world(t);
  assert.strictEqual((await w.alice.client.set(`data/users/${A(w)}/n1`, { text: 'private' })).status, 200);
  assert.strictEqual((await w.alice.client.set(`data/users/${A(w)}/n2`, { text: 'private too' })).status, 200);
  // alice sees her own
  assert.strictEqual((await w.alice.client.list(`data/users/${A(w)}`)).json.docs.length, 2);
  assert.strictEqual((await w.alice.client.doc(`data/users/${A(w)}/n1`)).json.data.text, 'private');
  // nobody else does, and listing it is empty rather than an error
  for (const other of [w.bob.client, w.admin]) {
    assert.strictEqual((await other.doc(`data/users/${A(w)}/n1`)).json.exists, false);
    assert.deepStrictEqual((await other.list(`data/users/${A(w)}`)).json.docs, []);
    assert.strictEqual((await other.set(`data/users/${A(w)}/n3`, { x: 1 })).status, 403);
    assert.strictEqual((await other.write('update', `data/users/${A(w)}/n1`, { x: 1 })).status, 403);
    assert.strictEqual((await other.write('delete', `data/users/${A(w)}/n1`)).status, 403);
    // the whole area without a uid belongs to nobody, not even the admin
    assert.strictEqual((await other.set('data/users', { x: 1 })).status, 403);
    assert.strictEqual((await other.doc('data/users')).json.exists, false);
  }
  assert.strictEqual(w.app.store.get(`data/users/${A(w)}/n1`).data.text, 'private', 'and none of that changed it');
  // the change feed never mentions it to anyone else either
  for (const other of [w.bob.client, w.admin]) {
    const feed = await other.get('/api/changes?since=0');
    assert.ok(!JSON.stringify(feed.json).includes('private'));
    assert.ok(!feed.json.changes.some((c) => c.path.startsWith('data/users/')));
  }
  assert.ok((await w.alice.client.get('/api/changes?since=0')).json.changes.some((c) => c.path === `data/users/${A(w)}/n1`));
  // the admin has their own private area, like anyone
  const adminUid = (await w.admin.get('/api/auth/me')).json.uid;
  assert.strictEqual((await w.admin.set(`data/users/${adminUid}/mine`, { ok: 1 })).status, 200);
  assert.strictEqual((await w.alice.client.doc(`data/users/${adminUid}/mine`)).json.exists, false);
});

test('path tricks cannot cross into someone else\'s documents', async (t) => {
  const w = await world(t);
  const me = A(w), other = B(w);
  const call = (c, method, p, body) => c.call(method, p, body);
  const writeBad = async (path, status = 400, c = w.alice.client) => {
    const r = await c.set(path, { x: 1 });
    assert.strictEqual(r.status, status, `${JSON.stringify(path)} -> ${r.status} ${r.text.slice(0, 80)}`);
    return r;
  };
  // traversal and odd segments are refused outright
  for (const p of ['bets/../config/settings', 'claims/' + me + '/../' + other, `acts/${me}/../${other}/items/x`, 'players/../players/x', './players/x', 'players/./x',
    '../x', 'a/b/..', 'claims//' + me, '/claims/' + me, `claims/${me}/`, 'claims\\' + other, `claims/${other}%2F..%2F${me}`, 'claims/%2e%2e/x', 'players/x%00', 'players/∕x', 'a/b c', 'a/\n',
    'players/x?y=1', 'players/x#y']) {
    await writeBad(p);
  }
  // lookalikes of your own uid are other people's documents (403), not yours
  for (const p of [`claims/${me}x`, `claims/x${me}`, `claims/${me.toUpperCase()}`, `bets/${me}.`, `bets/${me}:x`, `acts/${me}x/items/x`, `acts/x/${me}/x`, `claims/${other}`, `acts/${other}/items/x`,
    `acts/${other}`, 'claims/u_other', 'acts/u_other/items/x', `bets/x/${me}/y`, `players/${me}`, `matches/${me}`, `config/${me}`, `links/${me}`, `claims/${me}/sub/doc`, `data/users/${other}/a`]) {
    await writeBad(p, 403);
  }
  // and nothing above landed anywhere
  assert.deepStrictEqual([...w.app.store.docs.keys()].filter((k) => k.includes(other) || k.includes(me)), []);
  // reads: the same strings are bad paths or simply nothing
  for (const p of ['bets/../config/settings', `claims/${me}/../${other}`, 'config/settings/..', 'config//settings']) {
    assert.strictEqual((await w.alice.client.doc(p)).status, 400, p);
  }
  assert.strictEqual((await w.alice.client.list('bets/../config')).status, 400);
  // encoded slashes: one level of decoding, as the URL spec says; double encoding is a literal % and not allowed
  const raw = (c, q) => request(w.app.port, { path: `/api/db/doc?path=${q}`, headers: { Cookie: c.cookie } });
  assert.strictEqual((await raw(w.alice.client, 'players%2Fp1')).json.data.name, 'Ann');
  assert.strictEqual((await raw(w.alice.client, 'players%252Fp1')).status, 400);
  assert.strictEqual((await raw(w.alice.client, 'players%2F..%2Fconfig%2Fsettings')).status, 400);
  assert.strictEqual((await raw(w.alice.client, 'players%2f%2e%2e%2fconfig')).status, 400);
  assert.strictEqual((await raw(w.alice.client, `data%2Fusers%2F${other}%2Fx`)).json.exists, false);
  assert.strictEqual((await raw(w.alice.client, 'players%5Cp1')).status, 400);
  assert.strictEqual((await raw(w.alice.client, '%ff%fe')).status, 400, 'invalid UTF-8');
  assert.strictEqual((await raw(w.alice.client, '')).status, 400);
  assert.strictEqual((await request(w.app.port, { path: '/api/db/doc', headers: { Cookie: w.alice.client.cookie } })).status, 400, 'no path at all');
  assert.strictEqual((await request(w.app.port, { path: '/api/db/doc?path=a&path=b', headers: { Cookie: w.alice.client.cookie } })).status, 400, 'first of repeated parameters is used, and "a" is not a doc');
  // a collection path where a document is expected, and the other way round
  assert.strictEqual((await w.alice.client.doc('players')).status, 400);
  assert.strictEqual((await w.alice.client.list('players/p1')).status, 400);
  assert.strictEqual((await w.alice.client.set('players', { x: 1 })).status, 400);
  assert.strictEqual((await w.admin.set('players/p1/notes', { x: 1 })).status, 400);
  // the route itself: encoded slashes or dots in the URL path do not reach a different handler
  for (const p of ['/api/db%2Fdoc?path=players/p1', '/api/db/doc/../write', '/api//db/doc', '/api/db/doc/', '/%61pi/db/doc?path=players/p1']) {
    assert.strictEqual((await request(w.app.port, { path: p, headers: { Cookie: w.alice.client.cookie } })).status, 404, p);
  }
});

test('very long paths and deep paths', async (t) => {
  const w = await world(t);
  const seg = (n) => 'x'.repeat(n);
  const wr = (c, p) => c.set(p, { v: 1 }).then((r) => r.status);
  assert.strictEqual(await wr(w.admin, `misc/${seg(200)}`), 200, '200 characters is the longest segment');
  assert.strictEqual(await wr(w.admin, `misc/${seg(201)}`), 400);
  assert.strictEqual(await wr(w.admin, `misc/${seg(5000)}`), 400);
  const segs = (n) => Array.from({ length: n }, (_, i) => `s${i}`).join('/');
  assert.strictEqual(await wr(w.admin, segs(16)), 200, '16 segments is the most');
  assert.strictEqual(await wr(w.admin, segs(18)), 400, '17+ segments');
  assert.strictEqual(await wr(w.admin, segs(17)), 400);
  assert.strictEqual(await wr(w.admin, segs(100)), 400);
  assert.strictEqual(await wr(w.admin, Array(6).fill(seg(180)).join('/')), 400, 'over 1000 bytes in total');
  assert.strictEqual(await wr(w.admin, `a/${seg(990)}`), 400);
  // a 17-segment path under your own uid is no way round the limit either
  assert.strictEqual(await wr(w.alice.client, `acts/${A(w)}/${segs(15)}`), 400);
  assert.strictEqual(await wr(w.alice.client, `acts/${A(w)}/${segs(14)}`), 200);
  // a 16-deep collection is fine to list, 17 is not
  assert.strictEqual((await w.admin.list(segs(15))).status, 200);
  assert.strictEqual((await w.admin.list(segs(17))).status, 400);
  // reads of long paths are plain 400s, not crashes
  assert.strictEqual((await w.admin.doc(`a/${seg(9000)}`)).status, 400);
  const huge = await request(w.app.port, { path: `/api/db/doc?path=${'a%2F'.repeat(2000)}x`, headers: { Cookie: w.admin.cookie } });
  assert.strictEqual(huge.status, 400);
  // past the header size limit Node itself answers 431, and it still carries our security headers
  const tooLong = await w.admin.doc(`a/${seg(100000)}`);
  assert.strictEqual(tooLong.status, 431);
  assert.strictEqual(tooLong.headers['x-content-type-options'], 'nosniff');
});

test('bodies: prototype pollution keys, wrong shapes, size limits', async (t) => {
  const w = await world(t);
  const post = (body, extra = {}) => request(w.app.port, {
    method: 'POST', path: '/api/db/write', body,
    headers: { 'Content-Type': 'application/json', 'X-CB': '1', Cookie: w.admin.cookie, ...extra },
  });
  const before = JSON.stringify(Object.getOwnPropertyNames(Object.prototype).sort());
  const polluted = [
    '{"op":"set","path":"misc/a","data":{"__proto__":{"admin":true}}}',
    '{"op":"set","path":"misc/a","data":{"x":{"y":[{"__proto__":{"admin":true}}]}}}',
    '{"op":"set","path":"misc/a","data":{"constructor":{"prototype":{"admin":true}}}}',
    '{"op":"set","path":"misc/a","data":{"prototype":1}}',
    '{"__proto__":{"admin":true},"op":"set","path":"misc/a","data":{}}',
    '{"op":"set","path":"misc/a","data":{},"constructor":{"x":1}}',
    '{"op":"update","path":"misc/a","data":{"a":{"__proto__":{"polluted":"yes"}}}}',
  ];
  await w.admin.set('misc/a', { ok: 1 });
  for (const body of polluted) {
    const r = await post(body);
    assert.strictEqual(r.status, 400, body);
    assert.match(r.json.error, /forbidden/);
  }
  assert.strictEqual(({}).admin, undefined);
  assert.strictEqual(({}).polluted, undefined);
  assert.strictEqual(JSON.stringify(Object.getOwnPropertyNames(Object.prototype).sort()), before);
  assert.deepStrictEqual(w.app.store.get('misc/a').data, { ok: 1 });
  // the same guard on the other endpoints that take bodies
  const anon = (path, body) => request(w.app.port, { method: 'POST', path, body, headers: { 'Content-Type': 'application/json', 'X-CB': '1' } });
  assert.strictEqual((await anon('/api/auth/signup', '{"username":"evil","password":"correct horse 1","__proto__":{"admin":true}}')).status, 400);
  assert.strictEqual((await anon('/api/auth/login', '{"username":"admin","password":"x","constructor":{"a":1}}')).status, 400);
  assert.strictEqual((await post('{"ids":["u_x"],"__proto__":{"a":1}}', {})).status, 400);
  assert.strictEqual(w.app.auth.byName.has('evil'), false);
  // wrong shapes
  for (const body of ['', 'not json', '[]', '"str"', '5', 'null', '{', '{"op":"set"}', '{"op":"set","path":5}', '{"op":"nuke","path":"misc/a"}', '{"op":"set","path":"misc/a"}',
    '{"op":"set","path":"misc/a","data":[1]}', '{"op":"set","path":"misc/a","data":"x"}', '{"op":"set","path":"misc/a","data":null}', '{"op":"update","path":"misc/zzz","data":{}}',
    '{"op":"set","path":"misc/a","data":{},"ifVersion":"1"}', '{"op":"set","path":"misc/a","data":{},"ifVersion":-1}', '{"op":"set","path":"misc/a","data":{},"ifVersion":1.5}']) {
    const r = await post(body);
    assert.strictEqual(r.status, 400, `${body} -> ${r.status} ${r.text}`);
    assert.ok(r.json.error);
  }
  // sizes: the request cap is 300 KB (413); a document over 256 KiB inside that is 507
  const exactly = (n) => JSON.stringify({ op: 'set', path: 'misc/big', data: { s: 'x'.repeat(n) } });
  assert.strictEqual((await post(exactly(300 * 1024))).status, 413, 'body over 300 KB');
  assert.strictEqual((await post(exactly(300 * 1024 + 5000))).status, 413);
  assert.strictEqual((await post(exactly(270000))).status, 507, 'under the request cap but over 256 KiB');
  assert.strictEqual((await post(exactly(256 * 1024 - 20))).status, 200, 'just under the document cap');
  assert.strictEqual((await post(exactly(5 * 1024 * 1024))).status, 413, '5 MB is refused and the client still gets the answer');
  // past the point where we stop listening the server answers and hangs up, so a reset is as good as the 413
  const hugeTry = await post(exactly(9 * 1024 * 1024)).then((r) => r.status, (e) => e.code);
  assert.ok(hugeTry === 413 || hugeTry === 'ECONNRESET' || hugeTry === 'EPIPE', String(hugeTry));
  assert.strictEqual((await w.admin.get('/api/auth/me')).status, 200, 'the server is fine afterwards');
  // chunked, no content-length
  const chunked = await new Promise((resolve, reject) => {
    const req = require('http').request({ host: '127.0.0.1', port: w.app.port, method: 'POST', path: '/api/db/write', agent: false, headers: { 'Content-Type': 'application/json', 'X-CB': '1', Cookie: w.admin.cookie } }, (res) => {
      res.resume(); res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject);
    const big = exactly(400 * 1024);
    for (let i = 0; i < big.length; i += 64 * 1024) req.write(big.slice(i, i + 64 * 1024));
    req.end();
  });
  assert.strictEqual(chunked, 413);
  // nesting
  let deep = { v: 1 };
  for (let i = 0; i < 31; i++) deep = { n: deep };
  assert.strictEqual((await w.admin.set('misc/deep', deep)).status, 200, '32 levels');
  assert.strictEqual((await w.admin.set('misc/deeper', { n: deep })).status, 507, '33 levels');
  const nested = '{"op":"set","path":"misc/x","data":{"a":' + '['.repeat(100000) + ']'.repeat(100000) + '}}';
  const r = await post(nested);
  assert.strictEqual(r.status, 400, 'absurd nesting is refused without blowing the stack');
  assert.strictEqual((await w.admin.get('/api/auth/me')).status, 200);
  // a content-type with a charset is fine
  assert.strictEqual((await post(JSON.stringify({ op: 'set', path: 'misc/cs', data: { a: 1 } }), { 'Content-Type': 'application/json; charset=utf-8' })).status, 200);
  assert.strictEqual((await post(JSON.stringify({ op: 'set', path: 'misc/cs2', data: { a: 1 } }), { 'Content-Type': 'Application/JSON' })).status, 200);
});

test('set, update, delete, ifVersion, version bumps and seq over HTTP', async (t) => {
  const w = await world(t);
  const c = w.admin;
  const s0 = (await c.doc('misc/a')).json.seq;
  assert.deepStrictEqual((await c.set('misc/a', { n: 1 })).json, { version: 1, seq: s0 + 1 });
  assert.deepStrictEqual((await c.set('misc/a', { n: 2 })).json, { version: 2, seq: s0 + 2 });
  assert.deepStrictEqual((await c.write('update', 'misc/a', { m: 3, nested: { a: 1 } })).json, { version: 3, seq: s0 + 3 });
  assert.deepStrictEqual((await c.write('update', 'misc/a', { nested: { b: 2 } })).json, { version: 4, seq: s0 + 4 });
  const d = (await c.doc('misc/a')).json;
  assert.deepStrictEqual(d, { id: 'a', exists: true, data: { n: 2, m: 3, nested: { a: 1, b: 2 } }, version: 4, seq: s0 + 4 });
  // update of a missing doc
  const missing = await c.write('update', 'misc/none', { a: 1 });
  assert.strictEqual(missing.status, 400);
  // ifVersion
  assert.strictEqual((await c.set('misc/a', { n: 9 }, { ifVersion: 3 })).status, 409);
  assert.strictEqual((await c.set('misc/a', { n: 9 }, { ifVersion: 0 })).status, 409);
  assert.strictEqual((await c.write('delete', 'misc/a', undefined, { ifVersion: 3 })).status, 409);
  assert.strictEqual((await c.doc('misc/a')).json.version, 4, 'refused writes change nothing');
  assert.strictEqual((await c.set('misc/a', { n: 9 }, { ifVersion: 4 })).json.version, 5);
  assert.strictEqual((await c.set('misc/fresh', { n: 1 }, { ifVersion: 0 })).json.version, 1, 'ifVersion 0 = create only');
  assert.strictEqual((await c.set('misc/fresh', { n: 1 }, { ifVersion: 0 })).status, 409);
  // delete
  const seqBefore = (await c.doc('misc/a')).json.seq;
  assert.deepStrictEqual((await c.write('delete', 'misc/a')).json, { version: 0, seq: seqBefore + 1 });
  assert.deepStrictEqual((await c.doc('misc/a')).json, { id: 'a', exists: false, seq: seqBefore + 1 });
  assert.deepStrictEqual((await c.write('delete', 'misc/a')).json, { version: 0, seq: seqBefore + 1 }, 'idempotent, and not a change');
  // racing writers with the same ifVersion: exactly one wins
  await c.set('misc/race', { n: 0 });
  const results = await Promise.all(Array.from({ length: 6 }, (_, i) => c.set('misc/race', { n: i + 1 }, { ifVersion: 1 })));
  assert.deepStrictEqual(results.map((r) => r.status).sort(), [200, 409, 409, 409, 409, 409]);
  assert.strictEqual((await c.doc('misc/race')).json.version, 2);
  // the page sends numbers, booleans, nulls, arrays and unicode; all survive
  const rich = { n: 1.5, t: true, f: false, z: null, arr: [1, 'two', { three: 3 }], s: 'café \u{1F680}', nested: { deep: { er: [] } } };
  await c.set('misc/rich', rich);
  assert.deepStrictEqual((await c.doc('misc/rich')).json.data, rich);
});

test('list: direct children only, ordered by id, with version and seq', async (t) => {
  const w = await world(t);
  for (const id of ['b', 'a', 'c']) await w.admin.set(`misc/${id}`, { id });
  await w.admin.set('misc/a/sub/s1', { deep: true });
  await w.admin.set('misc/a/sub/s2', { deep: true });
  const l = await w.alice.client.list('misc');
  assert.deepStrictEqual(l.json.docs.map((d) => d.id), ['a', 'b', 'c']);
  assert.deepStrictEqual(Object.keys(l.json.docs[0]).sort(), ['data', 'id', 'version']);
  assert.strictEqual(l.json.docs[0].version, 1);
  assert.strictEqual(typeof l.json.seq, 'number');
  assert.deepStrictEqual((await w.alice.client.list('misc/a/sub')).json.docs.map((d) => d.id), ['s1', 's2']);
  assert.deepStrictEqual((await w.alice.client.list('nothing')).json.docs, []);
  // a collection with some unreadable children shows only the readable ones
  await w.alice.client.set(`acts/${A(w)}/items/i1`, { t: 1 });
  await w.bob.client.set(`acts/${B(w)}/items/i1`, { t: 2 });
  assert.deepStrictEqual((await w.alice.client.list(`acts/${A(w)}/items`)).json.docs.map((d) => d.data.t), [1]);
  assert.deepStrictEqual((await w.alice.client.list(`acts/${B(w)}/items`)).json.docs.map((d) => d.data.t), [2], 'acts are readable by everyone');
  assert.deepStrictEqual((await w.alice.client.list('data')).json.docs, [], 'the private area never shows up in a listing of its parent');
  // the page's collections
  for (const coll of ['players', 'matches', 'claims', 'links', 'bets']) assert.strictEqual((await w.alice.client.list(coll)).status, 200);
});

test('everything under /api/db, /api/changes and /api/profiles needs a session', async (t) => {
  const w = await world(t);
  const anon = w.anon;
  for (const r of [await anon.doc('players/p1'), await anon.list('players'), await anon.set('players/p1', { a: 1 }), await anon.get('/api/changes?since=0'),
    await anon.post('/api/profiles', { ids: [] }), await anon.get('/api/auth/me'), await anon.post('/api/auth/password', { next: 'x' })]) {
    assert.strictEqual(r.status, 401, r.text);
    assert.deepStrictEqual(Object.keys(r.json), ['error']);
  }
  assert.strictEqual(w.app.store.get('players/p1').data.name, 'Ann', 'the unauthenticated write did nothing');
  // a made-up or revoked cookie is the same as none
  assert.strictEqual((await client(w.app, 'cb_session=' + 'a'.repeat(43)).doc('players/p1')).status, 401);
});

test('per-user write limit: 120 a minute, 429 after that, per user', async (t) => {
  const w = await world(t);
  const ok = [];
  for (let i = 0; i < 120; i++) ok.push((await w.alice.client.set(`acts/${A(w)}/items/i${i}`, { i })).status);
  assert.ok(ok.every((s) => s === 200));
  const r = await w.alice.client.set(`acts/${A(w)}/items/over`, { i: 1 });
  assert.strictEqual(r.status, 429);
  assert.ok(Number(r.headers['retry-after']) > 0);
  assert.strictEqual((await w.bob.client.set(`acts/${B(w)}/items/i1`, { i: 1 })).status, 200, 'other users are unaffected');
  assert.strictEqual((await w.alice.client.doc('players/p1')).status, 200, 'reads are not limited');
  assert.strictEqual(w.app.store.get(`acts/${A(w)}/items/over`), undefined);
});

test('an ordinary account has a storage allowance; the admin does not', async (t) => {
  const w = await world(t, { storeLimits: { ownerDocs: 4 } });
  for (let i = 0; i < 4; i++) assert.strictEqual((await w.alice.client.set(`acts/${A(w)}/items/i${i}`, { i })).status, 200);
  const r = await w.alice.client.set(`acts/${A(w)}/items/i4`, { i: 4 });
  assert.strictEqual(r.status, 507);
  assert.match(r.json.error, /used up/);
  assert.strictEqual((await w.alice.client.set(`acts/${A(w)}/items/i0`, { i: 'again' })).status, 200, 'changing an existing doc is fine');
  assert.strictEqual((await w.bob.client.set(`acts/${B(w)}/items/i0`, { i: 1 })).status, 200, 'everyone has their own');
  assert.strictEqual((await w.admin.set(`acts/${A(w)}/items/by-admin`, { i: 1 })).status, 200);
  assert.strictEqual((await w.alice.client.write('delete', `acts/${A(w)}/items/i1`)).status, 200);
  assert.strictEqual((await w.alice.client.set(`acts/${A(w)}/items/i5`, { i: 5 })).status, 507, 'the admin\'s doc in her folder still counts toward it');
});

test('a user cannot write by pretending to be someone else in the body', async (t) => {
  const w = await world(t);
  // fields in the body (uid, admin, user...) mean nothing; only the session decides
  const r = await w.alice.client.post('/api/db/write', { op: 'set', path: `claims/${B(w)}`, data: { a: 1 }, uid: B(w), user: { uid: B(w), admin: true }, admin: true });
  assert.strictEqual(r.status, 403);
  const hdr = await w.alice.client.call('POST', '/api/db/write', { op: 'set', path: 'players/hack', data: { a: 1 } }, { 'X-User': 'admin', 'X-Admin': '1', 'X-Forwarded-User': 'admin' });
  assert.strictEqual(hdr.status, 403);
  assert.strictEqual(w.app.store.get('players/hack'), undefined);
});

test('a signed-up friend can place bets and log things in their own folders end to end', async (t) => {
  const w = await world(t);
  const friend = await signup(w.app, 'friend');
  const bet = { id: 'b1', fx: 'f1', stake: 10, placedAt: new Date().toISOString() };
  assert.strictEqual((await friend.client.set(`bets/${friend.uid}`, { list: [bet] })).status, 200);
  assert.strictEqual((await friend.client.set(`claims/${friend.uid}`, { playerId: 'p1', at: 'now' })).status, 200);
  assert.strictEqual((await friend.client.set('players/p9', { name: 'Hacker' })).status, 403);
  assert.strictEqual((await w.alice.client.doc(`bets/${friend.uid}`)).json.data.list[0].stake, 10, 'others can read it');
  assert.strictEqual((await w.alice.client.set(`bets/${friend.uid}`, { list: [] })).status, 403, 'but not change it');
  assert.strictEqual((await friend.client.set(`bets/${friend.uid}`, { list: [] })).status, 409, 'and even they cannot take a placed bet back');
  assert.strictEqual((await w.admin.set(`bets/${friend.uid}`, { list: [], voided: true })).status, 200, 'the admin can');
});
