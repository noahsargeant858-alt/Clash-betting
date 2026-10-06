'use strict';

// Fixes for what the first security review found about sign-in: floods of correct logins, locking a
// friend out from afar, an open redirect through ?next=, and an admin resetting their own password.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { boot, request, ADMIN_PASSWORD } = require('./helper');

const J = { 'Content-Type': 'application/json', 'X-CB': '1' };
const post = (port, p, body, headers = {}) => request(port, { method: 'POST', path: p, headers: { ...J, ...headers }, body });
const from = (ip) => ({ 'X-Forwarded-For': ip });

async function app(limits) {
  const a = await boot({ env: { TRUST_PROXY: '1' }, trustProxy: 1, limits: { signupPerHour: 1000, ...limits } });
  return a;
}

test('a flood of correct logins from one connection is cut off, and everyone else can still sign in', async () => {
  const a = await app({ loginAttemptsPerIp: 6 });
  try {
    const flood = [];
    for (let i = 0; i < 12; i++) flood.push(await post(a.port, '/api/auth/login', { username: 'admin', password: ADMIN_PASSWORD }, from('10.0.0.1')));
    const codes = flood.map((r) => r.status);
    assert.ok(codes.slice(0, 6).every((c) => c === 200 || c === 401), `first attempts are served: ${codes}`);
    assert.ok(codes.slice(6).every((c) => c === 429), `the rest are refused without hashing: ${codes}`);
    assert.ok(flood[11].headers['retry-after'], 'a Retry-After is given');
    const other = await post(a.port, '/api/auth/login', { username: 'admin', password: ADMIN_PASSWORD }, from('10.0.0.2'));
    assert.strictEqual(other.status, 200, 'a different connection is not affected');
  } finally { await a.close(); }
});

test('wrong guesses from one connection cannot lock an account out for everyone else', async () => {
  const a = await app({ loginPerUser: 3, loginPerIp: 100 });
  try {
    for (let i = 0; i < 6; i++) await post(a.port, '/api/auth/login', { username: 'admin', password: 'nope-nope-' + i }, from('10.0.0.9'));
    const blocked = await post(a.port, '/api/auth/login', { username: 'admin', password: ADMIN_PASSWORD }, from('10.0.0.9'));
    assert.strictEqual(blocked.status, 429, 'the guesser is slowed down');
    const owner = await post(a.port, '/api/auth/login', { username: 'admin', password: ADMIN_PASSWORD }, from('10.0.0.50'));
    assert.strictEqual(owner.status, 200, 'the real owner, from another connection, still gets in');
  } finally { await a.close(); }
});

test('guessing one username from many connections is still stopped in the end', async () => {
  const a = await app({ loginPerUser: 100, loginPerIp: 100, loginPerUserAll: 8 });
  try {
    for (let i = 0; i < 8; i++) await post(a.port, '/api/auth/login', { username: 'admin', password: 'nope-nope-' + i }, from('10.1.0.' + (i + 1)));
    const r = await post(a.port, '/api/auth/login', { username: 'admin', password: ADMIN_PASSWORD }, from('10.1.0.200'));
    assert.strictEqual(r.status, 429);
  } finally { await a.close(); }
});

test('the admin cannot reset their own password through the API (use Change password)', async () => {
  const a = await app();
  try {
    const login = await post(a.port, '/api/auth/login', { username: 'admin', password: ADMIN_PASSWORD });
    const cookie = login.headers['set-cookie'][0].split(';')[0];
    const me = await request(a.port, { path: '/api/auth/me', headers: { Cookie: cookie } });
    const r = await post(a.port, `/api/admin/accounts/${me.json.uid}/reset-password`, {}, { Cookie: cookie });
    assert.strictEqual(r.status, 400);
    const still = await request(a.port, { path: '/api/auth/me', headers: { Cookie: cookie } });
    assert.strictEqual(still.status, 200, 'and the session was not thrown away');
  } finally { await a.close(); }
});

test('login.html only follows ?next= to the front page or a personal invite link', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'login.html'), 'utf8');
  const src = /function nextUrl\(\) \{[\s\S]*?\n\}/.exec(html)[0];
  const run = (search) => new Function('location', 'URLSearchParams', `${src}; return nextUrl();`)({ search, origin: 'https://site.example' }, URLSearchParams);
  const token = 'abcdefghijklmnopqrstuvwxyz012345';
  assert.strictEqual(run(''), '/');
  assert.strictEqual(run('?next=' + encodeURIComponent('/join/' + token)), '/join/' + token);
  for (const bad of ['/.//evil.example/phish', '/.\\/evil.example', '/a/..//evil.example', '/./\\evil.example', '//evil.example', '\\\\evil.example', 'https://evil.example',
    '/login', '/api/auth/me', '/join/short', '/join/' + token + '/x', '/join/' + token + '?x=//evil.example', 'javascript:alert(1)', '/%2f%2fevil.example']) {
    assert.strictEqual(run('?next=' + encodeURIComponent(bad)), '/', `refused: ${bad}`);
  }
});
