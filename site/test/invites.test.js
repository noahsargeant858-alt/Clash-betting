'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { boot, request, client, signup, loginAdmin, makeUser, cookieOf } = require('./helper');

async function world(t, opts) {
  const app = await boot(opts);
  t.after(() => app.close());
  const admin = await loginAdmin(app);
  for (const [id, name] of [['p1', 'Jamie'], ['p2', 'Zac'], ['p3', 'Sek']]) await admin.set(`players/${id}`, { name, addedAt: '2026-01-01T00:00:00.000Z' });
  return { app, admin, anon: client(app) };
}

const mint = async (w, playerId = 'p1') => {
  const r = await w.admin.post('/api/admin/invites', { playerId });
  assert.strictEqual(r.status, 200, r.text);
  return r.json;
};
const tokenOf = (inv) => inv.token;
const page = (w, token, cookie) => request(w.app.port, { path: `/join/${token}`, headers: cookie ? { Cookie: cookie } : {} });

test('create: returns the link once, lists never show tokens, only the admin can', async (t) => {
  const w = await world(t);
  const inv = await mint(w);
  assert.deepStrictEqual(Object.keys(inv).sort(), ['expiresAt', 'id', 'token', 'url']);
  assert.match(inv.token, /^[A-Za-z0-9_-]{32}$/);
  assert.strictEqual(inv.url, `http://127.0.0.1:${w.app.port}/join/${inv.token}`, 'built from the Host header');
  const days = (Date.parse(inv.expiresAt) - Date.now()) / 86400e3;
  assert.ok(days > 13.9 && days <= 14.01, `expires in about 14 days (${days})`);

  const list = await w.admin.get('/api/admin/invites');
  assert.strictEqual(list.status, 200);
  assert.deepStrictEqual(list.json.invites.map((i) => Object.keys(i).sort()), [['createdAt', 'expiresAt', 'id', 'playerId', 'usedAt', 'usedBy']]);
  assert.strictEqual(list.json.invites[0].playerId, 'p1');
  assert.strictEqual(list.json.invites[0].usedAt, null);
  assert.ok(!list.text.includes(inv.token), 'tokens are never listed');
  assert.ok(!list.text.includes('hash'));
  app_hashNotStored(w, inv);

  assert.strictEqual((await w.admin.post('/api/admin/invites', { playerId: 'nobody' })).status, 404);
  assert.strictEqual((await w.admin.post('/api/admin/invites', { playerId: 5 })).status, 404);
  assert.strictEqual((await w.admin.post('/api/admin/invites', { playerId: '../config' })).status, 404);
  assert.strictEqual((await w.admin.post('/api/admin/invites', {})).status, 404);

  const user = makeUser(w.app, 'plain');
  for (const c of [user.client, w.anon]) {
    assert.strictEqual((await c.post('/api/admin/invites', { playerId: 'p1' })).status, 403);
    assert.strictEqual((await c.get('/api/admin/invites')).status, 403);
    assert.strictEqual((await c.del(`/api/admin/invites/${inv.id}`)).status, 403);
  }
  assert.strictEqual(w.app.auth.invites.size, 1, 'nothing was created by the refused calls');
});

function app_hashNotStored(w, inv) {
  const stored = [...w.app.auth.invites.values()][0];
  assert.ok(!JSON.stringify(stored).includes(inv.token), 'only a hash of the token is kept');
  assert.match(stored.hash, /^[0-9a-f]{64}$/);
}

test('PUBLIC_URL decides the link when set', async (t) => {
  const w = await world(t, { publicUrl: 'https://clashbets.example.com/' });
  const inv = await mint(w);
  assert.strictEqual(inv.url, `https://clashbets.example.com/join/${inv.token}`);
});

test('behind a proxy the link uses the forwarded scheme and the Host header', async (t) => {
  const w = await world(t, { trustProxy: 1 });
  const r = await request(w.app.port, { method: 'POST', path: '/api/admin/invites', body: { playerId: 'p1' },
    headers: { 'Content-Type': 'application/json', 'X-CB': '1', Cookie: w.admin.cookie, Host: 'bets.example.org', 'X-Forwarded-Proto': 'https' } });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.json.url, `https://bets.example.org/join/${r.json.token}`);
  const evil = await request(w.app.port, { method: 'POST', path: '/api/admin/invites', body: { playerId: 'p1' },
    headers: { 'Content-Type': 'application/json', 'X-CB': '1', Cookie: w.admin.cookie, Host: 'bad host"><script>' } });
  assert.match(evil.json.url, /^http:\/\/localhost\/join\//, 'a strange Host header never lands in a link');
});

test('landing page: names the player, does not consume the token, escapes everything', async (t) => {
  const w = await world(t);
  const inv = await mint(w);
  for (let i = 0; i < 3; i++) {
    const r = await page(w, inv.token);
    assert.strictEqual(r.status, 200);
    assert.match(r.headers['content-type'], /^text\/html/);
    assert.strictEqual(r.headers['cache-control'], 'no-store');
    assert.match(r.text, /You've been invited as <b>Jamie<\/b>/);
    assert.match(r.text, /<button id="go" data-token="[A-Za-z0-9_-]+">Join as Jamie<\/button>/);
    assert.strictEqual(r.headers['set-cookie'], undefined, 'looking creates nothing');
  }
  const head = await request(w.app.port, { method: 'HEAD', path: `/join/${inv.token}` });
  assert.strictEqual(head.status, 200);
  const stored = (await w.admin.get('/api/admin/invites')).json.invites[0];
  assert.strictEqual(stored.usedAt, null);
  assert.strictEqual(w.app.auth.users.size, 1, 'no account was made by opening the link');
  assert.strictEqual(w.app.store.get('links/p1'), undefined);
  // a hostile player name is escaped
  await w.admin.set('players/p4', { name: '<script>alert(1)</script>"\'&' });
  const evil = await page(w, (await mint(w, 'p4')).token);
  assert.strictEqual(evil.status, 200);
  assert.ok(!evil.text.includes('<script>alert(1)</script>'));
  assert.ok(evil.text.includes('&lt;script&gt;alert(1)&lt;/script&gt;&quot;&#39;&amp;'));
  assert.ok(!/<script>alert/.test(evil.text));
});

test('landing page: bad, used, expired and revoked tokens look the same and reveal nothing', async (t) => {
  const w = await world(t);
  const gone = [];
  for (const token of ['nope', 'a'.repeat(32), '..%2F..%2Fetc%2Fpasswd', '%00', 'x'.repeat(5000), '', '../healthz', 'a/b', encodeURIComponent('<script>')]) {
    const r = await page(w, token);
    gone.push(r);
    assert.strictEqual(r.status, token === '../healthz' || token === 'a/b' ? 410 : 410, token);
  }
  const bodies = new Set(gone.map((r) => r.text));
  assert.strictEqual(bodies.size, 1, 'the same page for every kind of dead link');
  assert.ok(!/Jamie|player|expired/i.test(gone[0].text.replace(/may have been used already or it has expired/, '')), 'says nothing about who or why');
  assert.match(gone[0].text, /doesn't work any more/);
  assert.match(gone[0].headers['content-type'], /^text\/html/);
  // expired
  const inv = await mint(w);
  w.app.auth.invites.get(inv.id).expiresAt = new Date(Date.now() - 1000).toISOString();
  const expired = await page(w, inv.token);
  assert.strictEqual(expired.status, 410);
  assert.strictEqual(expired.text, gone[0].text);
  // revoked
  const inv2 = await mint(w, 'p2');
  assert.strictEqual((await page(w, inv2.token)).status, 200);
  assert.strictEqual((await w.admin.del(`/api/admin/invites/${inv2.id}`)).status, 200);
  const revoked = await page(w, inv2.token);
  assert.strictEqual(revoked.status, 410);
  assert.strictEqual(revoked.text, gone[0].text);
});

test('redeem: creates the account, links the player, signs them in', async (t) => {
  const w = await world(t);
  const inv = await mint(w);
  const res = await w.anon.post('/api/auth/redeem', { token: inv.token });
  assert.strictEqual(res.status, 200, res.text);
  assert.strictEqual(res.json.ok, true);
  assert.strictEqual(res.json.playerId, 'p1');
  assert.strictEqual(res.json.me.username, 'jamie');
  assert.strictEqual(res.json.me.display, 'Jamie');
  assert.strictEqual(res.json.me.hasPassword, false);
  assert.strictEqual(res.json.me.admin, false);
  assert.strictEqual(res.json.me.playerId, 'p1');
  const cookie = cookieOf(res);
  assert.match(cookie, /^cb_session=/);
  assert.match(res.headers['set-cookie'][0], /HttpOnly/);
  const jamie = client(w.app, cookie);
  const me = await jamie.get('/api/auth/me');
  assert.deepStrictEqual(me.json, res.json.me);
  // the link document, written by the server
  const link = w.app.store.get('links/p1');
  assert.strictEqual(link.version, 1);
  assert.deepStrictEqual(Object.keys(link.data).sort(), ['at', 'former', 'uid']);
  assert.strictEqual(link.data.uid, res.json.me.uid);
  assert.deepStrictEqual(link.data.former, []);
  assert.ok(Math.abs(Date.parse(link.data.at) - Date.now()) < 5000);
  assert.strictEqual((await jamie.doc('links/p1')).json.data.uid, res.json.me.uid, 'everyone can read it');
  // the account is an invite account
  const u = w.app.auth.users.get(res.json.me.uid);
  assert.strictEqual(u.via, 'invite');
  assert.strictEqual(u.pass, null);
  assert.strictEqual(u.admin, false);
  // the invite is marked used
  const listed = (await w.admin.get('/api/admin/invites')).json.invites[0];
  assert.ok(listed.usedAt);
  assert.strictEqual(listed.usedBy, res.json.me.uid);
  // and they are straight in: the app page, the data, their own folder
  const app = await request(w.app.port, { path: '/', headers: { Cookie: cookie } });
  assert.strictEqual(app.status, 200);
  assert.match(app.text, /app page/);
  assert.strictEqual((await jamie.list('players')).json.docs.length, 3);
  assert.strictEqual((await jamie.set(`claims/${res.json.me.uid}`, { playerId: 'p1' })).status, 200);
  assert.strictEqual((await jamie.set('links/p2', { uid: res.json.me.uid })).status, 403, 'and still can\'t write the admin\'s data');
  // the admin sees the account, linked
  const acc = (await w.admin.get('/api/admin/accounts')).json.accounts.find((a) => a.username === 'jamie');
  assert.strictEqual(acc.playerId, 'p1');
  assert.strictEqual(acc.via, 'invite');
  assert.strictEqual(acc.hasPassword, false);
});

test('redeem: the link cannot be used twice, nor after it expires or is revoked', async (t) => {
  const w = await world(t);
  const inv = await mint(w);
  const first = await w.anon.post('/api/auth/redeem', { token: inv.token });
  assert.strictEqual(first.status, 200);
  const users = w.app.auth.users.size;
  const again = await w.anon.post('/api/auth/redeem', { token: inv.token });
  assert.strictEqual(again.status, 410);
  assert.match(again.json.error, /already been used or has expired/);
  assert.strictEqual(again.headers['set-cookie'], undefined);
  assert.strictEqual(w.app.auth.users.size, users, 'no second account');
  assert.strictEqual(w.app.store.get('links/p1').version, 1, 'the link was not rewritten');
  // the landing page for a used link: gone for strangers, straight into the app for the person who used it
  assert.strictEqual((await page(w, inv.token)).status, 410);
  const own = await page(w, inv.token, cookieOf(first));
  assert.strictEqual(own.status, 302);
  assert.strictEqual(own.headers.location, '/');
  // expired
  const inv2 = await mint(w, 'p2');
  w.app.auth.invites.get(inv2.id).expiresAt = new Date(Date.now() - 1).toISOString();
  assert.strictEqual((await w.anon.post('/api/auth/redeem', { token: inv2.token })).status, 410);
  assert.strictEqual(w.app.store.get('links/p2'), undefined);
  // revoked
  const inv3 = await mint(w, 'p3');
  assert.strictEqual((await w.admin.del(`/api/admin/invites/${inv3.id}`)).status, 200);
  assert.strictEqual((await w.anon.post('/api/auth/redeem', { token: inv3.token })).status, 410);
  assert.strictEqual((await w.admin.del(`/api/admin/invites/${inv3.id}`)).status, 404, 'revoking twice says so');
  assert.strictEqual((await w.admin.del('/api/admin/invites/nope')).status, 404);
  assert.strictEqual((await w.admin.del('/api/admin/invites/../accounts')).status, 404);
  // junk tokens
  for (const token of [undefined, null, 5, '', 'short', 'x'.repeat(100), ['a'.repeat(32)], { a: 1 }, 'a'.repeat(32), '../../x']) {
    assert.strictEqual((await w.anon.post('/api/auth/redeem', { token })).status, 410, JSON.stringify(token));
  }
});

test('two people tapping the same link at once: exactly one gets in', async (t) => {
  const w = await world(t);
  const inv = await mint(w);
  const results = await Promise.all(Array.from({ length: 5 }, () => client(w.app).post('/api/auth/redeem', { token: inv.token })));
  assert.deepStrictEqual(results.map((r) => r.status).sort(), [200, 410, 410, 410, 410]);
  assert.strictEqual([...w.app.auth.users.values()].filter((u) => u.via === 'invite').length, 1);
});

test('redeem: a player who already has an enabled account cannot be taken over', async (t) => {
  const w = await world(t);
  const owner = makeUser(w.app, 'owner');
  await w.admin.set('links/p1', { uid: owner.uid, at: '2026-01-01T00:00:00.000Z', former: [] });
  const inv = await mint(w);
  const r = await w.anon.post('/api/auth/redeem', { token: inv.token });
  assert.strictEqual(r.status, 409);
  assert.strictEqual(r.json.error, 'That player already has an account. Ask the admin.');
  assert.strictEqual(r.headers['set-cookie'], undefined);
  assert.strictEqual(w.app.store.get('links/p1').data.uid, owner.uid);
  assert.strictEqual((await page(w, inv.token)).status, 409, 'the landing page says so too');
  assert.match((await page(w, inv.token)).text, /already has an account/);
  const stored = w.app.auth.invites.get(inv.id);
  assert.strictEqual(stored.usedAt, null, 'a refused redeem does not use the invite up');
  // the account that holds the link, opening its own invite, is simply sent to the app
  assert.strictEqual((await page(w, inv.token, owner.client.cookie)).status, 302);
  // once the old account is switched off, the player can be claimed, and the old account is remembered
  w.app.auth.setDisabled(w.app.auth.users.get(owner.uid), true);
  const r2 = await w.anon.post('/api/auth/redeem', { token: inv.token });
  assert.strictEqual(r2.status, 200);
  const link = w.app.store.get('links/p1').data;
  assert.strictEqual(link.uid, r2.json.me.uid);
  assert.deepStrictEqual(link.former, [{ uid: owner.uid, from: '2026-01-01T00:00:00.000Z', until: link.at }]);
});

test('redeem: a link left empty keeps its history; a player that was deleted cannot be claimed', async (t) => {
  const w = await world(t);
  const old = [{ uid: 'u_old', from: null, until: '2026-02-02T00:00:00.000Z' }];
  await w.admin.set('links/p1', { uid: null, at: '2026-03-03T00:00:00.000Z', former: old });
  const inv = await mint(w);
  const r = await w.anon.post('/api/auth/redeem', { token: inv.token });
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(w.app.store.get('links/p1').data.former, old, 'the existing former list is kept as it was');
  const inv2 = await mint(w, 'p2');
  await w.admin.write('delete', 'players/p2');
  const gone = await w.anon.post('/api/auth/redeem', { token: inv2.token });
  assert.strictEqual(gone.status, 409);
  assert.match(gone.json.error, /no longer on the site/);
  assert.strictEqual((await page(w, inv2.token)).status, 410);
});

test('redeem: usernames come from the player\'s name and never collide', async (t) => {
  const w = await world(t);
  await w.admin.set('players/q1', { name: 'Jamie' });
  await w.admin.set('players/q2', { name: 'Jamie' });
  await w.admin.set('players/q3', { name: 'Al' });
  await w.admin.set('players/q4', { name: '\u{1F451}\u{1F451}' });
  await w.admin.set('players/q5', { name: 'Zoë O\'Brien-Smith the Third of Many Names' });
  await w.admin.set('players/q6', { name: '  <b>Bold</b>  ' });
  await w.admin.set('players/q7', { name: 'x'.repeat(100) });
  const names = {};
  for (const pid of ['p1', 'q1', 'q2', 'q3', 'q4', 'q5', 'q6', 'q7']) {
    const r = await client(w.app).post('/api/auth/redeem', { token: (await mint(w, pid)).token });
    assert.strictEqual(r.status, 200, `${pid}: ${r.text}`);
    names[pid] = [r.json.me.username, r.json.me.display];
    assert.match(r.json.me.username, /^[a-z0-9][a-z0-9_.-]{2,23}$/, 'always a valid username');
  }
  assert.deepStrictEqual(names.p1, ['jamie', 'Jamie']);
  assert.deepStrictEqual(names.q1, ['jamie2', 'Jamie']);
  assert.deepStrictEqual(names.q2, ['jamie3', 'Jamie']);
  assert.strictEqual(names.q3[0], 'alplayer');
  assert.strictEqual(names.q4[0], 'player');
  assert.strictEqual(names.q5[0], 'zoeobriensmiththethi', 'cut to 20');
  assert.strictEqual(names.q5[1], 'Zo\u00eb O\'Brien-Smith the Third of', 'display cut to 30 characters');
  assert.strictEqual(names.q6[0], 'bboldb');
  assert.strictEqual(names.q6[1], '<b>Bold</b>', 'the display name is stored as the player is called; the page escapes it');
  assert.strictEqual(names.q7[0], 'x'.repeat(20));
  assert.strictEqual(names.q7[1], 'x'.repeat(30));
  assert.strictEqual(new Set(Object.values(names).map((n) => n[0])).size, 8, 'all different');
});

test('redeem: a signed-in account links itself instead of making a new one', async (t) => {
  const w = await world(t);
  const friend = await signup(w.app, 'friend', { display: 'Fran' });
  const before = w.app.auth.users.size;
  const inv = await mint(w, 'p2');
  // the landing page offers to link the account that is signed in
  const landing = await page(w, inv.token, friend.cookie);
  assert.strictEqual(landing.status, 200);
  assert.match(landing.text, /signed in as <b>Fran<\/b> \(@friend\)/);
  assert.match(landing.text, /id="fresh"/);
  const r = await friend.client.post('/api/auth/redeem', { token: inv.token });
  assert.strictEqual(r.status, 200, r.text);
  assert.strictEqual(r.json.me.uid, friend.uid);
  assert.strictEqual(r.json.me.username, 'friend');
  assert.strictEqual(r.json.me.playerId, 'p2');
  assert.strictEqual(r.json.playerId, 'p2');
  assert.strictEqual(w.app.auth.users.size, before, 'no new account');
  assert.strictEqual(w.app.store.get('links/p2').data.uid, friend.uid);
  assert.strictEqual((await friend.client.get('/api/auth/me')).json.playerId, 'p2');
  assert.strictEqual(w.app.auth.users.get(friend.uid).hasOwnProperty('via'), true);
  assert.strictEqual(w.app.auth.users.get(friend.uid).via, 'signup', 'still a normal account');
  assert.strictEqual(w.app.auth.invites.get(inv.id).usedBy, friend.uid);
  // already linked: a second link is refused, and says who they are
  const inv2 = await mint(w, 'p3');
  const second = await friend.client.post('/api/auth/redeem', { token: inv2.token });
  assert.strictEqual(second.status, 409);
  assert.strictEqual(second.json.error, "You're already Zac");
  assert.strictEqual(w.app.auth.invites.get(inv2.id).usedAt, null);
  assert.strictEqual(w.app.store.get('links/p3'), undefined);
  // the landing page for a signed-in, already-linked person still loads (they may be sharing the link)
  assert.strictEqual((await page(w, inv2.token, friend.cookie)).status, 200);
});

test('redeem is rate limited: 20 tries per 15 minutes per address', async (t) => {
  const w = await world(t);
  const inv = await mint(w);
  for (let i = 0; i < 20; i++) assert.strictEqual((await w.anon.post('/api/auth/redeem', { token: `nope${i}`.padEnd(30, 'x') })).status, 410);
  const blocked = await w.anon.post('/api/auth/redeem', { token: inv.token });
  assert.strictEqual(blocked.status, 429);
  assert.ok(Number(blocked.headers['retry-after']) > 0);
  assert.strictEqual(w.app.auth.invites.get(inv.id).usedAt, null);
});

test('redeem needs the same CSRF headers as everything else', async (t) => {
  const w = await world(t);
  const inv = await mint(w);
  const send = (headers) => request(w.app.port, { method: 'POST', path: '/api/auth/redeem', body: { token: inv.token }, headers });
  assert.strictEqual((await send({ 'Content-Type': 'application/json' })).status, 403);
  assert.strictEqual((await send({ 'X-CB': '1' })).status, 403);
  assert.strictEqual((await send({ 'Content-Type': 'application/json', 'X-CB': '1', Origin: 'https://evil.example' })).status, 403);
  assert.strictEqual(w.app.auth.invites.get(inv.id).usedAt, null);
  assert.strictEqual((await send({ 'Content-Type': 'application/json', 'X-CB': '1', Origin: `http://127.0.0.1:${w.app.port}` })).status, 200);
});

test('an invited friend can later set a password and username, then sign in anywhere', async (t) => {
  const w = await world(t);
  const redeemed = await w.anon.post('/api/auth/redeem', { token: (await mint(w)).token });
  const jamie = client(w.app, cookieOf(redeemed));
  assert.strictEqual((await client(w.app).post('/api/auth/login', { username: 'jamie', password: 'anything at all' })).status, 401, 'no password yet, so no password login');
  const set = await jamie.post('/api/auth/password', { next: 'my new password', username: 'jamie.b' });
  assert.strictEqual(set.status, 200);
  assert.strictEqual(set.json.me.username, 'jamie.b');
  assert.strictEqual(set.json.me.playerId, 'p1');
  assert.strictEqual((await client(w.app).post('/api/auth/login', { username: 'jamie.b', password: 'my new password' })).status, 200);
});

test('end to end: admin makes a link, a friend taps it, lands in the app signed in as their player', async (t) => {
  const w = await world(t);
  const inv = await mint(w, 'p2');
  const url = new URL(inv.url);
  const landing = await request(w.app.port, { path: url.pathname });
  assert.match(landing.text, /Join as Zac/);
  const redeemed = await request(w.app.port, { method: 'POST', path: '/api/auth/redeem', body: { token: url.pathname.split('/').pop() }, headers: { 'Content-Type': 'application/json', 'X-CB': '1', Origin: url.origin } });
  assert.strictEqual(redeemed.status, 200);
  const cookie = cookieOf(redeemed);
  const home = await request(w.app.port, { path: '/', headers: { Cookie: cookie } });
  assert.strictEqual(home.status, 200);
  assert.strictEqual(home.headers['cache-control'], 'no-store');
  const friend = client(w.app, cookie);
  const me = (await friend.get('/api/auth/me')).json;
  assert.strictEqual(me.playerId, 'p2');
  assert.strictEqual((await friend.set(`bets/${me.uid}`, { list: [{ id: 'b1', fx: 'f1', stake: 25, placedAt: new Date().toISOString() }] })).status, 200);
  // the same link, opened again in the same browser, goes straight to the app
  const again = await request(w.app.port, { path: url.pathname, headers: { Cookie: cookie } });
  assert.strictEqual(again.status, 302);
  assert.strictEqual(again.headers.location, '/');
  // /login for someone already signed in goes to the app too
  const login = await request(w.app.port, { path: '/login', headers: { Cookie: cookie } });
  assert.strictEqual(login.status, 302);
});
