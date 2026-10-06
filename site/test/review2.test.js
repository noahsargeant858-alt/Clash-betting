'use strict';

// Fixes for the second round of the security review: forged locks and bets, shared storage, signup ceilings,
// connections that never speak, and a flood of bogus logins crowding out real ones.

const test = require('node:test');
const assert = require('node:assert');
const net = require('net');
const { boot, request, ADMIN_PASSWORD } = require('./helper');

const J = { 'Content-Type': 'application/json', 'X-CB': '1' };
const post = (port, p, body, headers = {}) => request(port, { method: 'POST', path: p, headers: { ...J, ...headers }, body });
const iso = (ms) => new Date(ms === undefined ? Date.now() : ms).toISOString();

async function member(app, name) {
  const r = await post(app.port, '/api/auth/signup', { username: name, password: 'Friend-pass-123', code: undefined });
  assert.strictEqual(r.status, 200, JSON.stringify(r.json));
  return { cookie: r.headers['set-cookie'][0].split(';')[0], uid: r.json.me.uid };
}
const write = (app, u, op, path, data, extra = {}) => post(app.port, '/api/db/write', { op, path, data, ...extra }, { Cookie: u.cookie });
const adminLogin = async (app) => { const r = await post(app.port, '/api/auth/login', { username: 'admin', password: ADMIN_PASSWORD }); return { cookie: r.headers['set-cookie'][0].split(';')[0] }; };

const bet = (id, fx, extra = {}) => ({ id, fx, bettor: 'sek', a: 'jamie', b: 'zac', market: 'result', selection: 'A', odds: 2, stake: 50, placedAt: iso(), ...extra });

test('a lock can only freeze bets that really exist in their owners\' bet lists', async () => {
  const app = await boot();
  try {
    const mal = await member(app, 'mallory'), vic = await member(app, 'victor');
    const fx = `${mal.uid}~f_1`;
    assert.strictEqual((await write(app, mal, 'set', `acts/${mal.uid}/items/f_1`, { type: 'fixture', a: 'jamie', b: 'zac', at: iso() })).status, 200);
    // victor placed one real bet
    const real = bet('b_real', fx);
    assert.strictEqual((await write(app, vic, 'set', `bets/${vic.uid}`, { list: [real] })).status, 200);
    const forged = { ...bet('b_fake', fx, { stake: 250, odds: 12, selection: 'B' }), uid: vic.uid };
    const lockDoc = (bets) => ({ type: 'lock', fx, a: 'jamie', b: 'zac', pin: {}, at: iso(), bets });
    const bad = await write(app, mal, 'set', `acts/${mal.uid}/items/l_1`, lockDoc([forged]));
    assert.strictEqual(bad.status, 409, JSON.stringify(bad.json));
    const altered = await write(app, mal, 'set', `acts/${mal.uid}/items/l_1`, lockDoc([{ ...real, uid: vic.uid, stake: 400 }]));
    assert.strictEqual(altered.status, 409, 'a real bet with a changed stake is a forgery too');
    const wrongFx = await write(app, mal, 'set', `acts/${mal.uid}/items/l_1`, lockDoc([{ ...real, uid: vic.uid, fx: 'other' }]));
    assert.strictEqual(wrongFx.status, 409);
    const good = await write(app, mal, 'set', `acts/${mal.uid}/items/l_1`, lockDoc([{ ...real, uid: vic.uid }]));
    assert.strictEqual(good.status, 200, JSON.stringify(good.json));
  } finally { await app.close(); }
});

test('fixtures and locks can\'t be rewritten, backdated or deleted', async () => {
  const app = await boot();
  try {
    const u = await member(app, 'zed');
    const p = `acts/${u.uid}/items/f_1`;
    assert.strictEqual((await write(app, u, 'set', p, { type: 'fixture', a: 'x', b: 'y', at: iso(Date.now() - 10 * 60e3) })).status, 409, 'backdated');
    assert.strictEqual((await write(app, u, 'set', p, { type: 'fixture', a: 'x', b: 'y', at: iso(Date.now() + 10 * 60e3) })).status, 409, 'post-dated');
    const mk = await write(app, u, 'set', p, { type: 'fixture', a: 'x', b: 'y', at: iso() });
    assert.strictEqual(mk.status, 200);
    assert.strictEqual((await write(app, u, 'update', p, { a: 'q' })).status, 409, 'edited');
    assert.strictEqual((await write(app, u, 'set', p, { type: 'fixture', a: 'x', b: 'y', at: iso(Date.now() - 1000) })).status, 409, 'rewritten');
    assert.strictEqual((await write(app, u, 'delete', p)).status, 409, 'deleted');
    // an ordinary doc of an unknown type is still fine
    assert.strictEqual((await write(app, u, 'set', `acts/${u.uid}/items/misc`, { type: 'note', text: 'hi' })).status, 200);
    // a logged result: new ones are dated now; an edit keeps its original time
    const m = { type: 'match', playerA: 'x', playerB: 'y', loggedAt: iso(), date: iso(Date.now() - 3600e3) };
    assert.strictEqual((await write(app, u, 'set', `acts/${u.uid}/items/m1`, m)).status, 200);
    assert.strictEqual((await write(app, u, 'set', `acts/${u.uid}/items/m1`, { ...m, crownsA: 1 })).status, 200, 'an edit with the same loggedAt');
    assert.strictEqual((await write(app, u, 'set', `acts/${u.uid}/items/m1`, { ...m, loggedAt: iso(Date.now() - 3600e3) })).status, 409, 're-dating');
    assert.strictEqual((await write(app, u, 'set', `acts/${u.uid}/items/m2`, { ...m, loggedAt: iso(Date.now() - 3600e3) })).status, 409, 'a new log claiming it was logged an hour ago');
    // confirmations are dated now too
    assert.strictEqual((await write(app, u, 'set', `acts/${u.uid}/items/c1`, { type: 'confirm', ref: 'a~b', verdict: 'ok', at: iso(Date.now() - 3600e3) })).status, 409);
    assert.strictEqual((await write(app, u, 'set', `acts/${u.uid}/items/c1`, { type: 'confirm', ref: 'a~b', verdict: 'ok', at: iso() })).status, 200);
  } finally { await app.close(); }
});

test('a bet list only grows: placed bets are fixed, new ones are dated now', async () => {
  const app = await boot();
  try {
    const u = await member(app, 'bea');
    const a = bet('b1', 'fx1'), b = bet('b2', 'fx1');
    assert.strictEqual((await write(app, u, 'set', `bets/${u.uid}`, { list: [a] })).status, 200);
    assert.strictEqual((await write(app, u, 'set', `bets/${u.uid}`, { list: [a, b] })).status, 200, 'appending works');
    assert.strictEqual((await write(app, u, 'set', `bets/${u.uid}`, { list: [a] })).status, 409, 'taking one back');
    assert.strictEqual((await write(app, u, 'set', `bets/${u.uid}`, { list: [{ ...a, stake: 1 }, b] })).status, 409, 'editing one');
    assert.strictEqual((await write(app, u, 'set', `bets/${u.uid}`, { list: [a, b, bet('b3', 'fx1', { placedAt: iso(Date.now() - 3600e3) })] })).status, 409, 'backdating a new one');
    assert.strictEqual((await write(app, u, 'set', `bets/${u.uid}`, { list: [a, b, bet('b2', 'fx1')] })).status, 409, 'duplicate id');
    assert.strictEqual((await write(app, u, 'delete', `bets/${u.uid}`)).status, 409, 'deleting the whole list');
    assert.strictEqual((await write(app, u, 'set', `bets/${u.uid}`, { list: [a, b, bet('b3', 'fx1')] })).status, 200);
    // the admin can still void a bet by hand, but not hand over something that isn't a bet list
    const admin = await adminLogin(app);
    assert.strictEqual((await write(app, admin, 'set', `bets/${u.uid}`, { list: [a] })).status, 200, 'the admin can take a bet back');
    assert.strictEqual((await write(app, admin, 'set', `bets/${u.uid}`, { nope: 1 })).status, 409);
    assert.strictEqual((await write(app, u, 'set', `bets/${u.uid}`, { list: [] })).status, 409, 'but the owner still can\'t');
  } finally { await app.close(); }
});

test('one stranger can\'t fill the shared storage and lock the admin out of writing', async () => {
  const app = await boot({ storeLimits: { maxTotalBytes: 400 * 1024, ownerBytes: 100 * 1024, ownerDocs: 50 } });
  try {
    const blob = 'x'.repeat(30 * 1024);
    let refused = 0;
    for (let i = 0; i < 10; i++) {
      const u = await member(app, 'filler' + i);
      for (let j = 0; j < 3; j++) { const r = await write(app, u, 'set', `acts/${u.uid}/items/n${j}`, { type: 'note', blob }); if (r.status === 507) refused++; }
    }
    assert.ok(refused > 0, 'ordinary accounts hit a ceiling before the store is full');
    const admin = await adminLogin(app);
    const r = await write(app, admin, 'set', 'players/new1', { name: 'New Guy', addedAt: iso(), blob: 'y'.repeat(35 * 1024) });
    assert.strictEqual(r.status, 200, 'the admin can still write');
  } finally { await app.close(); }
});

test('faking forwarded addresses can\'t make unlimited accounts', async () => {
  const app = await boot({ env: { TRUST_PROXY: '2' }, trustProxy: 2, limits: { signupPerHour: 1000, signupAllPerHour: 5 } });
  try {
    const codes = [];
    for (let i = 0; i < 8; i++) codes.push((await post(app.port, '/api/auth/signup', { username: 'spoof' + i, password: 'Friend-pass-123' }, { 'X-Forwarded-For': `203.0.113.${i},198.51.100.1` })).status);
    assert.deepStrictEqual(codes.slice(0, 5), [200, 200, 200, 200, 200]);
    assert.ok(codes.slice(5).every((c) => c === 429), String(codes));
  } finally { await app.close(); }
});

test('connections that never send anything are dropped, and the site keeps answering', async () => {
  const app = await boot();
  try {
    const socks = [];
    for (let i = 0; i < 30; i++) { const s = net.connect(app.port, '127.0.0.1'); s.on('error', () => {}); socks.push(s); }
    await new Promise((r) => setTimeout(r, 300));
    const ok = await request(app.port, { path: '/healthz' });
    assert.strictEqual(ok.status, 200, 'still serving while they hang about');
    const closed = await Promise.all(socks.map((s) => new Promise((res) => { const t = setTimeout(() => res(false), 13000); s.once('close', () => { clearTimeout(t); res(true); }); })));
    assert.ok(closed.every(Boolean), 'every silent connection was closed within about ten seconds');
  } finally { await app.close(); }
});

test('a flood of bogus logins from one connection can\'t crowd out a real login from another', async () => {
  const app = await boot({ scryptN: 16384, env: { TRUST_PROXY: '1' }, trustProxy: 1, limits: { loginAttemptsPerIp: 1000, loginPerIp: 1000, loginPerUser: 1000, loginPerUserAll: 100000 } });
  try {
    const flood = [];
    for (let i = 0; i < 90; i++) flood.push(post(app.port, '/api/auth/login', { username: 'nobody' + i, password: 'whatever-123' }, { 'X-Forwarded-For': '9.9.9.9' }));
    await new Promise((r) => setTimeout(r, 30));
    const real = await post(app.port, '/api/auth/login', { username: 'admin', password: ADMIN_PASSWORD }, { 'X-Forwarded-For': '1.2.3.4' });
    const results = await Promise.all(flood);
    assert.strictEqual(real.status, 200, 'the real login got through (not a 503)');
    assert.ok(results.filter((r) => r.status === 503).length === 0, 'the flood never fills the shared queue');
    assert.ok(results.some((r) => r.status === 429), 'the flooder is told to slow down');
  } finally { await app.close(); }
});
