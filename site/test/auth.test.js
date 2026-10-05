'use strict';

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { boot, request, client, signup, login, loginAdmin, makeUser, cookieOf, ADMIN_PASSWORD } = require('./helper');
const { Hasher, RateLimiter } = require('../lib/auth');

const withApp = (opts, fn) => async (t) => {
  const app = await boot(opts);
  t.after(() => app.close());
  return fn(app, t);
};

test('signup: account, session cookie, me, no secrets in the response', withApp({}, async (app) => {
  const anon = client(app);
  const res = await anon.post('/api/auth/signup', { username: 'jamie', password: 'correct horse 1', display: '  Jamie B  ' });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.json.ok, true);
  assert.deepStrictEqual(Object.keys(res.json.me).sort(), ['admin', 'display', 'hasPassword', 'playerId', 'uid', 'username']);
  assert.match(res.json.me.uid, /^u_[A-Za-z0-9_-]{22}$/);
  assert.strictEqual(res.json.me.username, 'jamie');
  assert.strictEqual(res.json.me.display, 'Jamie B');
  assert.strictEqual(res.json.me.admin, false);
  assert.strictEqual(res.json.me.hasPassword, true);
  assert.strictEqual(res.json.me.playerId, null);
  assert.ok(!/pass|hash|s1:/i.test(res.text.replace('hasPassword', '')), 'no hashes in the response');

  const cookie = cookieOf(res);
  assert.match(cookie, /^cb_session=[A-Za-z0-9_-]{43}$/, '32 random bytes as base64url');
  const me = await client(app, cookie).get('/api/auth/me');
  assert.strictEqual(me.status, 200);
  assert.deepStrictEqual(me.json, res.json.me);

  // stored: the hash of the token, never the token; scrypt hash of the password, never the password
  app.persist.flush();
  const text = fs.readFileSync(path.join(app.dataDir, 'auth.json'), 'utf8');
  assert.ok(!text.includes(cookie.split('=')[1]), 'session token must not be stored');
  assert.ok(!text.includes('correct horse 1'));
  const stored = JSON.parse(text);
  const user = Object.values(stored.users).find((u) => u.username === 'jamie');
  assert.match(user.pass, /^s1:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/);
  assert.strictEqual(user.via, 'signup');
  assert.strictEqual(user.admin, false);
  assert.strictEqual(user.disabled, false);
  assert.strictEqual(Object.keys(stored.sessions).length, 1, 'booting the admin makes no session; the signup made one');
  assert.ok(Object.keys(stored.sessions).every((k) => /^[0-9a-f]{64}$/.test(k)), 'sessions are keyed by sha256(token)');
  assert.strictEqual(fs.statSync(path.join(app.dataDir, 'auth.json')).mode & 0o077, 0, 'auth.json is private to the owner');
}));

test('signup: display defaults to the username; names are lowercased', withApp({}, async (app) => {
  const res = await client(app).post('/api/auth/signup', { username: '  Zac_01  ', password: 'correct horse 1' });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.json.me.username, 'zac_01');
  assert.strictEqual(res.json.me.display, 'zac_01');
  const login2 = await client(app).post('/api/auth/login', { username: 'ZAC_01', password: 'correct horse 1' });
  assert.strictEqual(login2.status, 200, 'login ignores case');
}));

test('cookie flags: HttpOnly, SameSite=Lax, Path=/, Max-Age; Secure only over https', async (t) => {
  const plain = await boot({ sessionDays: 30 });
  t.after(() => plain.close());
  const res = await client(plain).post('/api/auth/signup', { username: 'ann', password: 'correct horse 1' });
  const line = res.headers['set-cookie'].find((l) => l.startsWith('cb_session='));
  assert.match(line, /; HttpOnly/);
  assert.match(line, /; SameSite=Lax/);
  assert.match(line, /; Path=\//);
  assert.match(line, new RegExp(`; Max-Age=${30 * 86400}(;|$)`));
  assert.doesNotMatch(line, /Secure/);
  assert.strictEqual(res.headers['strict-transport-security'], undefined);

  // behind a proxy that says https
  const proxied = await boot({ trustProxy: 1 });
  t.after(() => proxied.close());
  const viaProxy = await request(proxied.port, { method: 'POST', path: '/api/auth/signup', headers: { 'Content-Type': 'application/json', 'X-CB': '1', 'X-Forwarded-Proto': 'https' }, body: { username: 'bob', password: 'correct horse 1' } });
  assert.match(viaProxy.headers['set-cookie'].find((l) => l.startsWith('cb_session=')), /; Secure/);
  assert.match(viaProxy.headers['strict-transport-security'], /max-age=\d+/);
  // the header is ignored when we are not behind a proxy
  const spoof = await request(plain.port, { method: 'POST', path: '/api/auth/signup', headers: { 'Content-Type': 'application/json', 'X-CB': '1', 'X-Forwarded-Proto': 'https' }, body: { username: 'cat', password: 'correct horse 1' } });
  assert.doesNotMatch(spoof.headers['set-cookie'].find((l) => l.startsWith('cb_session=')), /Secure/);
  assert.strictEqual(spoof.headers['strict-transport-security'], undefined);

  // forced on
  const forced = await boot({ cookieSecure: true });
  t.after(() => forced.close());
  const f = await client(forced).post('/api/auth/signup', { username: 'dan', password: 'correct horse 1' });
  assert.match(f.headers['set-cookie'].find((l) => l.startsWith('cb_session=')), /; Secure/);
});

test('login, logout, me', withApp({}, async (app) => {
  await signup(app, 'alice');
  const anon = client(app);
  assert.strictEqual((await anon.get('/api/auth/me')).status, 401);
  const res = await anon.post('/api/auth/login', { username: 'alice', password: 'correct horse 1' });
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.json.me.username, 'alice');
  const alice = client(app, cookieOf(res));
  assert.strictEqual((await alice.get('/api/auth/me')).json.username, 'alice');

  const out = await alice.post('/api/auth/logout');
  assert.strictEqual(out.status, 200);
  assert.deepStrictEqual(out.json, { ok: true });
  const cleared = out.headers['set-cookie'].find((l) => l.startsWith('cb_session='));
  assert.match(cleared, /^cb_session=;/);
  assert.match(cleared, /Max-Age=0/);
  assert.strictEqual((await alice.get('/api/auth/me')).status, 401, 'the session is gone on the server, not just in the browser');
  // logging out twice, or while signed out, is fine
  assert.strictEqual((await alice.post('/api/auth/logout')).status, 200);
  assert.strictEqual((await anon.post('/api/auth/logout')).status, 200);
}));

test('wrong credentials: one message and one cost, whether or not the name exists', withApp({}, async (app) => {
  await signup(app, 'alice');
  let calls = 0;
  const real = app.auth.hasher._scrypt.bind(app.auth.hasher);
  app.auth.hasher._scrypt = (...a) => { calls++; return real(...a); };
  const anon = client(app);
  const wrongPw = await anon.post('/api/auth/login', { username: 'alice', password: 'not the password' });
  const noUser = await anon.post('/api/auth/login', { username: 'nobody', password: 'not the password' });
  const junk = await anon.post('/api/auth/login', { username: 'x', password: 'whatever' });
  for (const r of [wrongPw, noUser, junk]) {
    assert.strictEqual(r.status, 401);
    assert.deepStrictEqual(r.json, { error: 'Wrong username or password' });
    assert.strictEqual(r.headers['set-cookie'], undefined);
  }
  assert.strictEqual(calls, 3, 'every attempt, even for a name that does not exist, costs one full scrypt');
  for (const body of [{}, { username: 'alice' }, { password: 'x' }, { username: 5, password: 5 }, { username: ['alice'], password: ['correct horse 1'] }, { username: 'alice', password: 'x'.repeat(5000) }]) {
    assert.strictEqual((await anon.post('/api/auth/login', body)).status, 401, JSON.stringify(body).slice(0, 60));
  }
}));

test('password rules', withApp({}, async (app) => {
  const anon = client(app);
  const attempt = (name, password) => anon.post('/api/auth/signup', { username: name, password });
  const short = await attempt('pw1', 'abcdefg');
  assert.strictEqual(short.status, 400);
  assert.match(short.json.error, /at least 8/);
  for (const bad of [undefined, null, 12345678, ['correct horse'], { a: 1 }, '', '1234567']) assert.strictEqual((await attempt('pw2', bad)).status, 400, String(bad));
  assert.strictEqual((await attempt('pw3', 'abcdefgh')).status, 200, '8 characters is enough');
  const long = await attempt('pw4', 'x'.repeat(201));
  assert.strictEqual(long.status, 400);
  assert.match(long.json.error, /200/);
  assert.strictEqual((await attempt('pw5', 'x'.repeat(200))).status, 200, '200 is the maximum');
  assert.strictEqual((await attempt('pw6', '\u{1F600}'.repeat(7))).status, 400, 'characters are counted, not UTF-16 units');
  assert.strictEqual((await attempt('pw7', '\u{1F600}'.repeat(8))).status, 200);
  assert.strictEqual((await attempt('sameasname', 'sameasname')).status, 400, 'not the username');
  assert.strictEqual((await attempt('spaces1', '        ')).status, 200, 'we do not tell people what to put in a password beyond the length');
  // and it works to log in with a long unicode password
  assert.strictEqual((await anon.post('/api/auth/login', { username: 'pw7', password: '\u{1F600}'.repeat(8) })).status, 200);
  assert.strictEqual((await anon.post('/api/auth/login', { username: 'pw5', password: 'x'.repeat(200) })).status, 200);
}));

test('username rules and duplicates', withApp({}, async (app) => {
  const anon = client(app);
  const attempt = (username, extra) => anon.post('/api/auth/signup', { username, password: 'correct horse 1', ...extra });
  const bad = ['', 'ab', 'a'.repeat(25), '_abc', '.abc', '-abc', 'has space', 'has/slash', 'ünïcode', 'semi;colon', 'quo"te', '<b>x</b>', 'a\nb', undefined, null, 42, ['abc'], { a: 1 }];
  for (const name of bad) {
    const r = await attempt(name);
    assert.strictEqual(r.status, 400, JSON.stringify(name));
    assert.match(r.json.error, /Usernames/);
  }
  for (const ok of ['abc', 'a'.repeat(24), '1abc', 'a_b.c-d', 'a--', 'user.name']) assert.strictEqual((await attempt(ok)).status, 200, ok);
  // duplicates, including by case and by the admin's name
  assert.strictEqual((await attempt('abc')).status, 409);
  const dup = await attempt('ABC');
  assert.strictEqual(dup.status, 409);
  assert.match(dup.json.error, /taken/);
  assert.strictEqual((await attempt('admin')).status, 409);
  assert.strictEqual((await attempt(' Admin ')).status, 409);
  assert.strictEqual(app.auth.users.size, 1 + 6, 'only the real signups exist, plus the admin');
}));

test('display name rules', withApp({}, async (app) => {
  const anon = client(app);
  const attempt = (n, display) => anon.post('/api/auth/signup', { username: `user${n}`, password: 'correct horse 1', display });
  for (const [i, bad] of ['a'.repeat(31), '\u0007bell', 'line\nbreak', 'tab\there', 'nul\u0000', 'rtl‮evil', 'sep x', 5, ['x'], {}].entries()) {
    assert.strictEqual((await attempt(`b${i}`, bad)).status, 400, JSON.stringify(bad));
  }
  assert.strictEqual((await attempt('w1', '   ')).status, 400, 'blank after trimming');
  const ok = await attempt('ok1', 'a'.repeat(30));
  assert.strictEqual(ok.status, 200);
  const html = await attempt('ok2', '<img src=x onerror=alert(1)>');
  assert.strictEqual(html.status, 200);
  assert.strictEqual(html.json.me.display, '<img src=x onerror=alert(1)>', 'stored as typed: the page escapes names when it shows them');
  assert.match(html.headers['content-type'], /^application\/json/);
  assert.strictEqual((await attempt('ok3', 'Zoë ✨ \u{1F468}‍\u{1F469}')).status, 200, 'accents, emoji and joiners are fine');
  assert.strictEqual((await attempt('ok4', null)).json.me.display, 'userok4', 'null means "use the username"');
}));

test('SIGNUP_CODE: required when set, checked before anything else is revealed', withApp({ signupCode: 'tiger-claw-9' }, async (app) => {
  const anon = client(app);
  assert.deepStrictEqual((await anon.get('/api/auth/config')).json, { siteName: 'ClashBets', signupCode: true });
  const body = { username: 'newbie', password: 'correct horse 1' };
  for (const code of [undefined, '', 'wrong', 'tiger-claw-9x', 'TIGER-CLAW-9', 5, ['tiger-claw-9']]) {
    const r = await anon.post('/api/auth/signup', { ...body, code });
    assert.strictEqual(r.status, 403, String(code));
    assert.match(r.json.error, /group code/);
    assert.strictEqual(r.headers['set-cookie'], undefined);
  }
  // a wrong code does not reveal whether a name is taken, and bad fields don't get past it either
  assert.strictEqual((await anon.post('/api/auth/signup', { username: 'admin', password: 'x', code: 'nope' })).status, 403);
  assert.strictEqual(app.auth.byName.has('newbie'), false);
  const ok = await anon.post('/api/auth/signup', { ...body, code: 'tiger-claw-9' });
  assert.strictEqual(ok.status, 200);
  assert.ok(cookieOf(ok));
  assert.strictEqual((await anon.post('/api/auth/signup', { ...body, username: 'other', code: '  tiger-claw-9  ' })).status, 200, 'stray spaces from a paste are fine');
  // the gate is for new accounts only: logging in needs no code
  assert.strictEqual((await anon.post('/api/auth/login', { username: 'newbie', password: 'correct horse 1' })).status, 200);
}));

test('without SIGNUP_CODE the config says so', withApp({}, async (app) => {
  assert.deepStrictEqual((await client(app).get('/api/auth/config')).json, { siteName: 'ClashBets', signupCode: false });
}));

test('login rate limit: 10 failures per username in 15 minutes, 30 per address', withApp({}, async (app) => {
  await signup(app, 'victim');
  const anon = client(app);
  for (let i = 0; i < 10; i++) assert.strictEqual((await anon.post('/api/auth/login', { username: 'victim', password: `guess ${i} guess` })).status, 401);
  const blocked = await anon.post('/api/auth/login', { username: 'victim', password: 'correct horse 1' });
  assert.strictEqual(blocked.status, 429, 'even the right password is refused while blocked');
  assert.ok(Number(blocked.headers['retry-after']) > 0);
  assert.strictEqual((await anon.post('/api/auth/login', { username: 'VICTIM', password: 'correct horse 1' })).status, 429, 'case does not dodge it');
  // the same applies to a name that does not exist (so it reveals nothing)
  for (let i = 0; i < 10; i++) await anon.post('/api/auth/login', { username: 'ghost', password: 'guess guess' });
  assert.strictEqual((await anon.post('/api/auth/login', { username: 'ghost', password: 'guess guess' })).status, 429);
  // other names still work until the per-address limit (10 + 10 failures so far, 10 more to go)
  await signup(app, 'bystander');
  assert.strictEqual((await anon.post('/api/auth/login', { username: 'bystander', password: 'correct horse 1' })).status, 200);
  for (let i = 0; i < 10; i++) assert.strictEqual((await anon.post('/api/auth/login', { username: `many${i}`, password: 'guess guess' })).status, 401);
  const ipBlocked = await anon.post('/api/auth/login', { username: 'bystander', password: 'correct horse 1' });
  assert.strictEqual(ipBlocked.status, 429, '30 failures from one address blocks that address');
}));

test('login failures from other addresses (behind a proxy) are counted separately', withApp({ trustProxy: 1, limits: { signupPerHour: 1000, loginPerIp: 3 } }, async (app) => {
  await signup(app, 'victim');
  const from = (ip) => request(app.port, { method: 'POST', path: '/api/auth/login', headers: { 'Content-Type': 'application/json', 'X-CB': '1', 'X-Forwarded-For': ip }, body: { username: 'victim', password: 'wrong wrong' } });
  for (let i = 0; i < 3; i++) assert.strictEqual((await from('203.0.113.7')).status, 401);
  assert.strictEqual((await from('203.0.113.7')).status, 429);
  assert.strictEqual((await from('203.0.113.8')).status, 401, 'a different address has its own count');
  // the rightmost entry is the one our proxy saw; anything to its left is client-supplied and ignored
  assert.strictEqual((await from('1.2.3.4, 203.0.113.7')).status, 429);
  assert.strictEqual((await from('203.0.113.7, 9.9.9.9')).status, 401);
  // IPv6: one /64 counts as one client
  for (let i = 0; i < 3; i++) assert.strictEqual((await from(`2001:db8:1:2::${i + 1}`)).status, 401);
  assert.strictEqual((await from('2001:db8:1:2:ffff::9')).status, 429);
  assert.strictEqual((await from('2001:db8:1:3::1')).status, 401);
}));

test('without a trusted proxy, X-Forwarded-For cannot dodge the limit', withApp({ limits: { signupPerHour: 1000, loginPerIp: 3 } }, async (app) => {
  const from = (ip) => request(app.port, { method: 'POST', path: '/api/auth/login', headers: { 'Content-Type': 'application/json', 'X-CB': '1', 'X-Forwarded-For': ip }, body: { username: 'x1', password: 'wrong wrong' } });
  for (let i = 0; i < 3; i++) assert.strictEqual((await from(`10.0.0.${i}`)).status, 401);
  assert.strictEqual((await from('10.0.0.99')).status, 429);
}));

test('signup rate limit: 10 per hour per address by default', async (t) => {
  const app = await boot({ limits: {} });
  t.after(() => app.close());
  const anon = client(app);
  for (let i = 0; i < 10; i++) assert.strictEqual((await anon.post('/api/auth/signup', { username: `user${i}`, password: 'correct horse 1' })).status, 200, `signup ${i}`);
  const r = await anon.post('/api/auth/signup', { username: 'user10', password: 'correct horse 1' });
  assert.strictEqual(r.status, 429);
  assert.ok(Number(r.headers['retry-after']) > 0);
  assert.strictEqual(app.auth.byName.has('user10'), false);
});

test('signup rate limit also stops group-code guessing', withApp({ signupCode: 'right-code', limits: { signupPerHour: 4 } }, async (app) => {
  const anon = client(app);
  for (let i = 0; i < 4; i++) assert.strictEqual((await anon.post('/api/auth/signup', { username: 'guesser', password: 'correct horse 1', code: `guess${i}` })).status, 403);
  assert.strictEqual((await anon.post('/api/auth/signup', { username: 'guesser', password: 'correct horse 1', code: 'right-code' })).status, 429);
}));

test('a disabled account cannot sign in, and its sessions die at once', withApp({}, async (app) => {
  const jo = await signup(app, 'joe');
  const admin = await loginAdmin(app);
  assert.strictEqual((await jo.client.get('/api/auth/me')).status, 200);
  assert.strictEqual((await admin.post(`/api/admin/accounts/${jo.uid}/disable`, { disabled: true })).status, 200);
  assert.strictEqual((await jo.client.get('/api/auth/me')).status, 401);
  assert.strictEqual((await jo.client.doc('players/x')).status, 401);
  const right = await client(app).post('/api/auth/login', { username: 'joe', password: 'correct horse 1' });
  assert.strictEqual(right.status, 403);
  assert.strictEqual(right.json.error, 'This account is switched off. Ask the admin.');
  assert.strictEqual(right.headers['set-cookie'], undefined);
  const wrong = await client(app).post('/api/auth/login', { username: 'joe', password: 'wrong wrong' });
  assert.strictEqual(wrong.status, 401, 'a wrong password does not reveal that the account exists');
  assert.strictEqual((await admin.post(`/api/admin/accounts/${jo.uid}/disable`, { disabled: false })).status, 200);
  assert.strictEqual((await client(app).post('/api/auth/login', { username: 'joe', password: 'correct horse 1' })).status, 200);
}));

test('sessions: at most 20 per user, expired ones stop working, a returning visitor gets a fresh cookie', withApp({}, async (app) => {
  await signup(app, 'busy');
  const cookies = [];
  for (let i = 0; i < 22; i++) cookies.push(cookieOf(await client(app).post('/api/auth/login', { username: 'busy', password: 'correct horse 1' })));
  const alive = [];
  for (const c of cookies) alive.push((await client(app, c).get('/api/auth/me')).status === 200);
  assert.strictEqual(alive.filter(Boolean).length, 20);
  assert.deepStrictEqual(alive.slice(0, 2), [false, false], 'the oldest are dropped');
  assert.strictEqual(alive[21], true);

  // expiry
  const c = client(app, cookies[21]);
  const key = [...app.auth.sessions.keys()].find((k) => crypto.createHash('sha256').update(cookies[21].split('=')[1]).digest('hex') === k);
  app.auth.sessions.get(key).expiresAt = new Date(Date.now() - 1000).toISOString();
  assert.strictEqual((await c.get('/api/auth/me')).status, 401);
  assert.strictEqual(app.auth.sessions.has(key), false);

  // a session not used for a while is extended, and the browser is sent the cookie again
  const d = client(app, cookies[20]);
  const key2 = crypto.createHash('sha256').update(cookies[20].split('=')[1]).digest('hex');
  const s = app.auth.sessions.get(key2);
  s.lastUsedAt = new Date(Date.now() - 3 * 86400e3).toISOString();
  s.expiresAt = new Date(Date.now() + 10 * 86400e3).toISOString();
  const res = await d.get('/api/auth/me');
  assert.strictEqual(res.status, 200);
  const renewed = res.headers['set-cookie'].find((l) => l.startsWith('cb_session='));
  assert.ok(renewed.startsWith(cookies[20] + ';'), 'same token, new lifetime');
  assert.match(renewed, /Max-Age=7776000/);
  assert.ok(Date.parse(app.auth.sessions.get(key2).expiresAt) > Date.now() + 89 * 86400e3);
  // used again straight away: nothing to renew
  assert.strictEqual((await d.get('/api/auth/me')).headers['set-cookie'], undefined);
  // garbage cookies
  for (const bad of ['cb_session=', 'cb_session=abc', `cb_session=${'a'.repeat(43)}`, `cb_session=${'a'.repeat(500)}`, 'cb_session=%00', 'other=1']) {
    assert.strictEqual((await client(app, bad).get('/api/auth/me')).status, 401, bad);
  }
}));

test('change password: current required, wrong current is 403, other sessions are revoked', withApp({}, async (app) => {
  const a = await signup(app, 'alice');
  const b = client(app, cookieOf(await client(app).post('/api/auth/login', { username: 'alice', password: 'correct horse 1' })));
  assert.strictEqual((await b.get('/api/auth/me')).status, 200);

  const anon = await client(app).post('/api/auth/password', { next: 'new password 1' });
  assert.strictEqual(anon.status, 401);
  const noCurrent = await a.client.post('/api/auth/password', { next: 'new password 1' });
  assert.strictEqual(noCurrent.status, 400);
  const wrong = await a.client.post('/api/auth/password', { current: 'not it', next: 'new password 1' });
  assert.strictEqual(wrong.status, 403, 'not 401: the page must not treat it as "signed out"');
  assert.match(wrong.json.error, /current password/);
  const weak = await a.client.post('/api/auth/password', { current: 'correct horse 1', next: 'short' });
  assert.strictEqual(weak.status, 400);
  assert.strictEqual((await a.client.post('/api/auth/password', { current: 'correct horse 1', next: 'alice' })).status, 400, 'not the username');
  assert.strictEqual((await a.client.post('/api/auth/password', { current: 'correct horse 1', next: 'new password 1', username: 'someone-else' })).status, 400, 'username can only be chosen when first setting a password');

  const ok = await a.client.post('/api/auth/password', { current: 'correct horse 1', next: 'new password 1' });
  assert.strictEqual(ok.status, 200);
  assert.strictEqual(ok.json.ok, true);
  assert.strictEqual(ok.json.me.username, 'alice');
  assert.strictEqual((await a.client.get('/api/auth/me')).status, 200, 'this browser stays signed in');
  assert.strictEqual((await b.get('/api/auth/me')).status, 401, 'every other session is signed out');
  assert.strictEqual((await client(app).post('/api/auth/login', { username: 'alice', password: 'correct horse 1' })).status, 401);
  assert.strictEqual((await client(app).post('/api/auth/login', { username: 'alice', password: 'new password 1' })).status, 200);
}));

test('change password: repeated wrong current passwords are rate limited', withApp({}, async (app) => {
  const a = await signup(app, 'alice');
  for (let i = 0; i < 10; i++) assert.strictEqual((await a.client.post('/api/auth/password', { current: `wrong ${i} wrong`, next: 'new password 1' })).status, 403);
  assert.strictEqual((await a.client.post('/api/auth/password', { current: 'correct horse 1', next: 'new password 1' })).status, 429);
}));

test('an account made by invite (no password yet) can set one and choose a username', withApp({}, async (app) => {
  const inv = makeUser(app, 'jamie2');
  inv.user.pass = null;
  inv.user.via = 'invite';
  makeUser(app, 'taken');
  const me = await inv.client.get('/api/auth/me');
  assert.strictEqual(me.json.hasPassword, false);
  assert.strictEqual((await client(app).post('/api/auth/login', { username: 'jamie2', password: '' })).status, 401, 'no password means no password login');
  assert.strictEqual((await inv.client.post('/api/auth/password', { next: 'new password 1', username: 'taken' })).status, 409);
  assert.strictEqual((await inv.client.post('/api/auth/password', { next: 'new password 1', username: 'No Spaces' })).status, 400);
  assert.strictEqual(app.auth.users.get(inv.uid).pass, null, 'a refused change changes nothing');
  assert.strictEqual(app.auth.users.get(inv.uid).username, 'jamie2');
  const ok = await inv.client.post('/api/auth/password', { next: 'new password 1', username: 'Jamie' });
  assert.strictEqual(ok.status, 200);
  assert.strictEqual(ok.json.me.username, 'jamie');
  assert.strictEqual(ok.json.me.hasPassword, true);
  assert.strictEqual((await client(app).post('/api/auth/login', { username: 'jamie', password: 'new password 1' })).status, 200);
  assert.strictEqual((await client(app).post('/api/auth/login', { username: 'jamie2', password: 'new password 1' })).status, 401, 'the old username is gone');
  assert.strictEqual(app.auth.userByName('jamie2'), undefined);
}));

test('passwords are scrypt N=2^15, r=8, p=1, 64 bytes, 16-byte salt, compared in constant time', async (t) => {
  const app = await boot({ scryptN: undefined });
  t.after(() => app.close());
  const res = await client(app).post('/api/auth/signup', { username: 'real', password: 'correct horse 1' });
  assert.strictEqual(res.status, 200);
  const user = app.auth.userByName('real');
  const [tag, salt, hash] = user.pass.split(':');
  assert.strictEqual(tag, 's1');
  assert.strictEqual(Buffer.from(salt, 'base64').length, 16);
  assert.strictEqual(Buffer.from(hash, 'base64').length, 64);
  const expected = crypto.scryptSync('correct horse 1', Buffer.from(salt, 'base64'), 64, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  assert.ok(expected.equals(Buffer.from(hash, 'base64')));
  // two accounts with the same password get different salts and hashes
  await client(app).post('/api/auth/signup', { username: 'real2', password: 'correct horse 1' });
  assert.notStrictEqual(app.auth.userByName('real2').pass, user.pass);
  const src = fs.readFileSync(path.join(__dirname, '../lib/auth.js'), 'utf8');
  assert.match(src, /timingSafeEqual/);
});

test('the admin password is verified with the real cost too', async (t) => {
  const app = await boot({ scryptN: undefined });
  t.after(() => app.close());
  assert.strictEqual((await client(app).post('/api/auth/login', { username: 'admin', password: ADMIN_PASSWORD })).status, 200);
});

test('hashing is bounded: a flood gets 503 instead of unbounded memory', async () => {
  const h = new Hasher(1024, 1, 2);
  const results = await Promise.allSettled(Array.from({ length: 6 }, () => h.hash('password one')));
  const refused = results.filter((r) => r.status === 'rejected');
  assert.ok(refused.length >= 1);
  assert.ok(refused.every((r) => r.reason.status === 503));
  assert.strictEqual(h.active, 0, 'slots are given back');
  assert.strictEqual(h.queue.length, 0);
  assert.ok(await h.verify('password one', await h.hash('password one')));
  assert.strictEqual(await h.verify('password one', null), false);
  assert.strictEqual(await h.verify('x', 'garbage'), false);
  assert.strictEqual(await h.verify('x', 's1:!!!:!!!'), false);
});

test('rate limiter: sliding window, bounded keys', () => {
  const r = new RateLimiter(2, 1000, 3);
  assert.ok(r.take('a', 0) && r.take('a', 100));
  assert.strictEqual(r.take('a', 200), false);
  assert.strictEqual(r.retryAfter('a', 200), 1);
  assert.ok(r.take('a', 1001), 'the first hit has aged out');
  assert.strictEqual(r.take('a', 1002), false);
  r.reset('a');
  assert.ok(r.take('a', 1003));
  for (const k of ['b', 'c', 'd', 'e']) r.add(k, 2000);
  assert.ok(r.hits.size <= 3, 'never more than maxKeys');
});

test('me shows the linked player; sign-in works for the admin; admin flag only for the admin', withApp({}, async (app) => {
  const admin = await loginAdmin(app);
  const me = await admin.get('/api/auth/me');
  assert.strictEqual(me.json.admin, true);
  assert.strictEqual(me.json.username, 'admin');
  const u = makeUser(app, 'zed');
  assert.strictEqual((await u.client.get('/api/auth/me')).json.playerId, null);
  assert.strictEqual((await admin.set('players/p1', { name: 'Zed' })).status, 200);
  assert.strictEqual((await admin.set('links/p1', { uid: u.uid, at: 'x', former: [] })).status, 200);
  const linked = await u.client.get('/api/auth/me');
  assert.strictEqual(linked.json.playerId, 'p1');
  assert.strictEqual(linked.json.admin, false);
}));

test('the number of accounts is capped, for signups and for invites, without half-finished links', async (t) => {
  const app = await boot({ maxAccounts: 3 });
  t.after(() => app.close());
  const admin = await loginAdmin(app);
  assert.strictEqual((await client(app).post('/api/auth/signup', { username: 'one', password: 'correct horse 1' })).status, 200);
  assert.strictEqual((await client(app).post('/api/auth/signup', { username: 'two', password: 'correct horse 1' })).status, 200);
  const full = await client(app).post('/api/auth/signup', { username: 'three', password: 'correct horse 1' });
  assert.strictEqual(full.status, 507);
  assert.match(full.json.error, /limit on accounts/);
  await admin.set('players/p1', { name: 'Jamie' });
  const inv = (await admin.post('/api/admin/invites', { playerId: 'p1' })).json;
  const r = await client(app).post('/api/auth/redeem', { token: inv.token });
  assert.strictEqual(r.status, 507);
  assert.strictEqual(app.store.get('links/p1'), undefined, 'no link was written for an account that was not made');
  assert.strictEqual(app.auth.invites.get(inv.id).usedAt, null);
});
