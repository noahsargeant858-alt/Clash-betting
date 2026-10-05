'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { startServer } = require('../server');
const { boot, request, client, signup, login, loginAdmin, makeUser, tmp, makePublic, cookieOf, ADMIN_PASSWORD } = require('./helper');

async function world(t, opts) {
  const app = await boot(opts);
  t.after(() => app.close());
  return { app, admin: await loginAdmin(app), anon: client(app) };
}

test('every admin endpoint is for the signed-in admin only', async (t) => {
  const w = await world(t);
  const user = await signup(w.app, 'plain');
  const target = makeUser(w.app, 'target');
  const calls = [
    ['GET', '/api/admin/accounts'],
    ['POST', `/api/admin/accounts/${target.uid}/reset-password`],
    ['POST', `/api/admin/accounts/${target.uid}/disable`, { disabled: true }],
    ['POST', '/api/admin/invites', { playerId: 'p1' }],
    ['GET', '/api/admin/invites'],
    ['DELETE', '/api/admin/invites/abc'],
    ['POST', '/api/admin/import-now'],
  ];
  await w.admin.set('players/p1', { name: 'Jamie' });
  for (const [method, path, body] of calls) {
    for (const [who, c] of [['a plain user', user.client], ['nobody', w.anon]]) {
      const r = await c.call(method, path, method === 'GET' ? undefined : body || {});
      assert.strictEqual(r.status, 403, `${who}: ${method} ${path} -> ${r.status}`);
      assert.deepStrictEqual(Object.keys(r.json), ['error']);
    }
  }
  // and nothing happened
  assert.strictEqual(w.app.auth.users.get(target.uid).disabled, false);
  assert.ok(w.app.auth.users.get(target.uid).pass === null, 'password untouched');
  assert.strictEqual(w.app.auth.invites.size, 0);
  // the admin flag cannot be claimed from the request
  const sneaky = await user.client.call('GET', '/api/admin/accounts', undefined, { 'X-Admin': '1', Authorization: 'Bearer admin' });
  assert.strictEqual(sneaky.status, 403);
  assert.strictEqual((await user.client.get('/api/admin/accounts?admin=1')).status, 403);
});

test('accounts list: what the admin panel needs and nothing secret', async (t) => {
  const w = await world(t);
  const friend = await signup(w.app, 'friend', { display: 'Fran' });
  const invited = makeUser(w.app, 'invited');
  invited.user.via = 'invite';
  invited.user.pass = null;
  await w.admin.set('players/p1', { name: 'Jamie' });
  await w.admin.set('links/p1', { uid: friend.uid, at: 'x', former: [] });
  const r = await w.admin.get('/api/admin/accounts');
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.json.accounts.length, 3);
  for (const a of r.json.accounts) {
    assert.deepStrictEqual(Object.keys(a).sort(), ['admin', 'createdAt', 'disabled', 'display', 'hasPassword', 'lastSeenAt', 'playerId', 'uid', 'username', 'via']);
  }
  const by = Object.fromEntries(r.json.accounts.map((a) => [a.username, a]));
  assert.strictEqual(by.admin.admin, true);
  assert.strictEqual(by.admin.via, 'admin');
  assert.strictEqual(by.friend.playerId, 'p1');
  assert.strictEqual(by.friend.display, 'Fran');
  assert.strictEqual(by.friend.via, 'signup');
  assert.strictEqual(by.friend.hasPassword, true);
  assert.strictEqual(by.invited.hasPassword, false);
  assert.strictEqual(by.invited.via, 'invite');
  assert.strictEqual(by.invited.playerId, null);
  assert.ok(!/s1:|"pass"|"hash"|session|token/i.test(r.text), 'no hashes or tokens');
  assert.deepStrictEqual(r.json.accounts.map((a) => a.username), ['admin', 'friend', 'invited'], 'oldest first');
});

test('reset password: temporary password shown once, all sessions revoked, old password dead', async (t) => {
  const w = await world(t);
  const jo = await signup(w.app, 'joe');
  const second = await login(w.app, 'joe', 'correct horse 1');
  const r = await w.admin.post(`/api/admin/accounts/${jo.uid}/reset-password`);
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(Object.keys(r.json), ['tempPassword']);
  const temp = r.json.tempPassword;
  assert.match(temp, /^[A-HJ-NP-Za-km-z2-9]{16}$/, '16 characters, none that look alike');
  assert.strictEqual((await jo.client.get('/api/auth/me')).status, 401, 'every session of that user is gone');
  assert.strictEqual((await second.get('/api/auth/me')).status, 401);
  assert.strictEqual((await w.admin.get('/api/auth/me')).status, 200, 'the admin is not affected');
  assert.strictEqual((await client(w.app).post('/api/auth/login', { username: 'joe', password: 'correct horse 1' })).status, 401);
  const ok = await client(w.app).post('/api/auth/login', { username: 'joe', password: temp });
  assert.strictEqual(ok.status, 200);
  assert.ok(!w.app.logs.join('\n').includes(temp), 'never logged');
  // each reset gives a different one
  const again = await w.admin.post(`/api/admin/accounts/${jo.uid}/reset-password`);
  assert.notStrictEqual(again.json.tempPassword, temp);
  // an invite account (no password yet) can be given one
  const inv = makeUser(w.app, 'invitee');
  inv.user.pass = null;
  const given = await w.admin.post(`/api/admin/accounts/${inv.uid}/reset-password`);
  assert.strictEqual((await client(w.app).post('/api/auth/login', { username: 'invitee', password: given.json.tempPassword })).status, 200);
  // unknown or malformed ids
  assert.strictEqual((await w.admin.post('/api/admin/accounts/u_aaaaaaaaaaaaaaaaaaaaaa/reset-password')).status, 404);
  assert.strictEqual((await w.admin.post('/api/admin/accounts/nope/reset-password')).status, 404);
  assert.strictEqual((await w.admin.post('/api/admin/accounts/../reset-password')).status, 404);
});

test('disable: needs a boolean, not yourself, kills sessions at once, can be undone', async (t) => {
  const w = await world(t);
  const jo = await signup(w.app, 'joe');
  const adminUid = (await w.admin.get('/api/auth/me')).json.uid;
  for (const body of [{}, { disabled: 'yes' }, { disabled: 1 }, { disabled: null }]) {
    assert.strictEqual((await w.admin.post(`/api/admin/accounts/${jo.uid}/disable`, body)).status, 400, JSON.stringify(body));
  }
  const self = await w.admin.post(`/api/admin/accounts/${adminUid}/disable`, { disabled: true });
  assert.strictEqual(self.status, 400);
  assert.strictEqual((await w.admin.get('/api/auth/me')).status, 200);
  assert.strictEqual((await w.admin.post('/api/admin/accounts/u_aaaaaaaaaaaaaaaaaaaaaa/disable', { disabled: true })).status, 404);
  const off = await w.admin.post(`/api/admin/accounts/${jo.uid}/disable`, { disabled: true });
  assert.deepStrictEqual(off.json, { ok: true });
  assert.strictEqual((await jo.client.get('/api/auth/me')).status, 401);
  assert.strictEqual((await jo.client.set(`bets/${jo.uid}`, { a: 1 })).status, 401, 'a switched-off account cannot write either');
  const listed = (await w.admin.get('/api/admin/accounts')).json.accounts.find((a) => a.username === 'joe');
  assert.strictEqual(listed.disabled, true);
  assert.deepStrictEqual((await w.admin.post(`/api/admin/accounts/${jo.uid}/disable`, { disabled: false })).json, { ok: true });
  assert.strictEqual((await jo.client.get('/api/auth/me')).status, 401, 'old sessions stay dead; they sign in again');
  assert.strictEqual((await login(w.app, 'joe', 'correct horse 1')).cookie !== undefined, true);
});

test('only the admin can do the importer\'s manual run; others get nothing', async (t) => {
  const w = await world(t, { battlesUrl: '' });
  const user = makeUser(w.app, 'plain');
  assert.strictEqual((await user.client.post('/api/admin/import-now')).status, 403);
  const r = await w.admin.post('/api/admin/import-now');
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(Object.keys(r.json), ['summary']);
  assert.match(r.json.summary, /BATTLES_URL/);
});

test('admin bootstrap with ADMIN_PASSWORD: that password works, and is never logged', async (t) => {
  const app = await boot({ adminPassword: 'owner secret 42', adminUsername: 'Noah' });
  t.after(() => app.close());
  assert.strictEqual((await client(app).post('/api/auth/login', { username: 'noah', password: 'owner secret 42' })).status, 200);
  assert.strictEqual((await client(app).post('/api/auth/login', { username: 'admin', password: 'owner secret 42' })).status, 401);
  const me = (await (await login(app, 'noah', 'owner secret 42')).get('/api/auth/me')).json;
  assert.strictEqual(me.admin, true);
  assert.strictEqual(me.username, 'noah');
  assert.strictEqual(me.display, 'Noah');
  assert.ok(!app.logs.join('\n').includes('owner secret 42'), 'the password must not be printed');
  assert.match(app.logs.join('\n'), /Created the admin account "noah" with the password from ADMIN_PASSWORD/);
  assert.strictEqual([...app.auth.users.values()].filter((u) => u.admin).length, 1);
});

test('ADMIN_PASSWORD is applied on every boot: change the variable to reset the password', async (t) => {
  const dataDir = tmp('cb-admin-');
  const a = await boot({ dataDir, adminPassword: 'first password 1' });
  const admin = await login(a, 'admin', 'first password 1');
  const uid = (await admin.get('/api/auth/me')).json.uid;
  await a.close();
  // same password: sessions survive the restart
  const b = await boot({ dataDir, adminPassword: 'first password 1' });
  assert.strictEqual((await client(b, admin.cookie).get('/api/auth/me')).status, 200, 'an unchanged password does not sign the admin out');
  assert.strictEqual(b.logs.filter((l) => /Created the admin/.test(l)).length, 0);
  await b.close();
  // new password: takes over, old sessions end
  const c = await boot({ dataDir, adminPassword: 'second password 2' });
  t.after(() => c.close());
  assert.strictEqual((await client(c, admin.cookie).get('/api/auth/me')).status, 401);
  assert.strictEqual((await client(c).post('/api/auth/login', { username: 'admin', password: 'first password 1' })).status, 401);
  const again = await login(c, 'admin', 'second password 2');
  assert.strictEqual((await again.get('/api/auth/me')).json.uid, uid, 'same account, not a new one');
  // renaming through ADMIN_USERNAME renames the owner's account (it is still the same uid)
  await c.close();
  const d = await boot({ dataDir, adminPassword: 'second password 2', adminUsername: 'boss' });
  t.after(() => d.close());
  const boss = await login(d, 'boss', 'second password 2');
  assert.strictEqual((await boss.get('/api/auth/me')).json.uid, uid);
  assert.strictEqual(d.auth.byName.has('admin'), false);
});

test('a switched-off admin is switched back on by ADMIN_PASSWORD', async (t) => {
  const dataDir = tmp('cb-admin-');
  const a = await boot({ dataDir });
  a.auth.users.get(a.auth.userByName('admin').uid).disabled = true;
  a.auth.changed();
  await a.close();
  const b = await boot({ dataDir });
  t.after(() => b.close());
  assert.strictEqual((await client(b).post('/api/auth/login', { username: 'admin', password: ADMIN_PASSWORD })).status, 200);
});

test('admin bootstrap without ADMIN_PASSWORD: a random password is printed once', async (t) => {
  const dataDir = tmp('cb-admin-');
  const a = await boot({ dataDir, adminPassword: '' });
  const text = a.logs.join('\n');
  const m = /password: (\S+)/.exec(text);
  assert.ok(m, 'a password was printed');
  const pw = m[1];
  assert.match(pw, /^[A-HJ-NP-Za-km-z2-9]{16}$/);
  assert.match(text, /username: admin/);
  assert.match(text, /shown once/);
  assert.strictEqual(a.logs.filter((l) => l.includes(pw)).length, 1, 'printed in one log call only');
  assert.strictEqual((await client(a).post('/api/auth/login', { username: 'admin', password: pw })).status, 200);
  assert.strictEqual((await client(a).post('/api/auth/login', { username: 'admin', password: 'admin' })).status, 401);
  await a.close();
  // second boot: same account, the same password still works, and nothing is printed
  const b = await boot({ dataDir, adminPassword: '' });
  t.after(() => b.close());
  assert.ok(!/password:/.test(b.logs.join('\n')));
  assert.ok(!b.logs.join('\n').includes(pw));
  assert.strictEqual((await client(b).post('/api/auth/login', { username: 'admin', password: pw })).status, 200);
  // two fresh installs get different passwords
  const c = await boot({ adminPassword: '' });
  t.after(() => c.close());
  assert.notStrictEqual(/password: (\S+)/.exec(c.logs.join('\n'))[1], pw);
});

test('an unusable ADMIN_PASSWORD or ADMIN_USERNAME stops the boot with a clear message', async () => {
  const dir = tmp('cb-admin-');
  const base = { env: {}, port: 0, host: '127.0.0.1', dataDir: dir, publicDir: makePublic(), scryptN: 1024, importIntervalMin: 0, log: () => {} };
  await assert.rejects(startServer({ ...base, adminPassword: 'short' }), /ADMIN_PASSWORD: Your password needs at least 8/);
  await assert.rejects(startServer({ ...base, adminPassword: 'long enough password', adminUsername: 'A B' }), /ADMIN_USERNAME/);
  await assert.rejects(startServer({ ...base, adminPassword: 'x'.repeat(201) }), /ADMIN_PASSWORD/);
});

test('someone cannot sign up as the admin, with or without a password set', async (t) => {
  const w = await world(t);
  const r = await client(w.app).post('/api/auth/signup', { username: 'admin', password: 'correct horse 1' });
  assert.strictEqual(r.status, 409);
  assert.strictEqual(w.app.auth.userByName('admin').admin, true);
  // there is exactly one way to be admin: the flag on the stored account
  const sneaky = await client(w.app).post('/api/auth/signup', { username: 'sneaky', password: 'correct horse 1', admin: true, via: 'admin', isOwner: true });
  assert.strictEqual(sneaky.status, 200);
  assert.strictEqual(sneaky.json.me.admin, false);
  assert.strictEqual(w.app.auth.userByName('sneaky').via, 'signup');
});

test('the admin can reset themselves and sign in again with the temporary password', async (t) => {
  const w = await world(t);
  const uid = (await w.admin.get('/api/auth/me')).json.uid;
  const r = await w.admin.post(`/api/admin/accounts/${uid}/reset-password`);
  assert.strictEqual(r.status, 200);
  assert.strictEqual((await w.admin.get('/api/auth/me')).status, 401, 'all sessions end, this one included');
  const back = await client(w.app).post('/api/auth/login', { username: 'admin', password: r.json.tempPassword });
  assert.strictEqual(back.status, 200);
  assert.strictEqual(back.json.me.admin, true);
  assert.ok(cookieOf(back));
});

test('raw requests: admin routes need the CSRF headers too', async (t) => {
  const w = await world(t);
  const target = makeUser(w.app, 'target');
  const r = await request(w.app.port, { method: 'POST', path: `/api/admin/accounts/${target.uid}/disable`, body: { disabled: true }, headers: { Cookie: w.admin.cookie, 'Content-Type': 'application/json' } });
  assert.strictEqual(r.status, 403);
  assert.strictEqual(w.app.auth.users.get(target.uid).disabled, false);
});
