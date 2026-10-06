'use strict';

const test = require('node:test');
const assert = require('node:assert');
const net = require('net');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { resolveConfig } = require('../server');
const { CSP } = require('../lib/http');
const { boot, request, client, signup, login, loginAdmin, makeUser, makePublic, cookieOf, tmp } = require('./helper');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const SPEC_CSP = "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";

function assertSecure(res, label, { https = false } = {}) {
  const h = res.headers;
  assert.strictEqual(h['x-content-type-options'], 'nosniff', `${label}: nosniff`);
  assert.strictEqual(h['referrer-policy'], 'no-referrer', `${label}: referrer`);
  assert.strictEqual(h['x-frame-options'], 'DENY', `${label}: frame`);
  assert.strictEqual(h['cross-origin-opener-policy'], 'same-origin', `${label}: COOP`);
  assert.strictEqual(h['content-security-policy'], SPEC_CSP, `${label}: CSP`);
  if (https) assert.match(h['strict-transport-security'], /^max-age=\d+/, `${label}: HSTS`);
  else assert.strictEqual(h['strict-transport-security'], undefined, `${label}: no HSTS over plain http`);
  assert.strictEqual(h['x-powered-by'], undefined, `${label}: no X-Powered-By`);
}

// raw TCP, for the requests Node answers itself
function rawExchange(port, text, { end = false, wait = 500 } = {}) {
  return new Promise((resolve) => {
    const s = net.connect(port, '127.0.0.1');
    let data = '';
    s.on('data', (d) => { data += d; });
    s.on('close', () => resolve(data));
    s.on('error', () => resolve(data));
    s.write(text);
    if (end) s.end();
    setTimeout(() => { s.destroy(); }, wait);
  });
}
const parseRaw = (raw) => {
  const [head] = raw.split('\r\n\r\n');
  const lines = head.split('\r\n');
  const headers = {};
  for (const l of lines.slice(1)) { const i = l.indexOf(':'); headers[l.slice(0, i).toLowerCase()] = l.slice(i + 1).trim(); }
  return { status: Number(/^HTTP\/1\.\d (\d+)/.exec(lines[0])[1]), headers, text: raw.split('\r\n\r\n').slice(1).join('\r\n\r\n') };
};

test('the CSP constant is exactly the one in the spec', () => {
  assert.strictEqual(CSP, SPEC_CSP);
});

test('security headers and CSP on every kind of response', async (t) => {
  const app = await boot({ limits: { signupPerHour: 1000 }, bodyTimeoutMs: 400 });
  t.after(() => app.close());
  const admin = await loginAdmin(app);
  const user = makeUser(app, 'plain');
  await admin.set('players/p1', { name: 'Jamie' });
  const inv = (await admin.post('/api/admin/invites', { playerId: 'p1' })).json;
  const used = (await admin.post('/api/admin/invites', { playerId: 'p1' })).json;
  app.auth.invites.get(used.id).usedAt = new Date().toISOString();
  const taken = makeUser(app, 'holder');
  await admin.set('players/p2', { name: 'Taken' });
  await admin.set('links/p2', { uid: taken.uid, at: 'x', former: [] });
  const takenInv = (await admin.post('/api/admin/invites', { playerId: 'p2' })).json;
  const port = app.port;
  const R = (opts) => request(port, opts);
  const J = { 'Content-Type': 'application/json', 'X-CB': '1' };
  const results = [];
  const add = (label, res, status) => { if (status !== undefined) assert.strictEqual(res.status, status, label); results.push([label, res]); };

  // pages and static
  add('healthz', await R({ path: '/healthz' }), 200);
  add('HEAD healthz', await R({ method: 'HEAD', path: '/healthz' }), 200);
  add('/ signed out (redirect)', await R({ path: '/' }), 302);
  add('/ signed in (app)', await R({ path: '/', headers: { Cookie: user.client.cookie } }), 200);
  add('/login', await R({ path: '/login' }), 200);
  add('/login signed in (redirect)', await R({ path: '/login', headers: { Cookie: user.client.cookie } }), 302);
  const shim = await R({ path: '/shim.js' });
  add('/shim.js', shim, 200);
  add('/shim.js 304', await R({ path: '/shim.js', headers: { 'If-None-Match': shim.headers.etag } }), 304);
  add('/robots.txt', await R({ path: '/robots.txt' }), 200);
  add('404 page', await R({ path: '/nope' }), 404);
  add('404 api', await R({ path: '/api/nope', headers: { Cookie: user.client.cookie } }), 404);
  add('join page', await R({ path: `/join/${inv.token}` }), 200);
  add('join gone', await R({ path: `/join/${used.token}` }), 410);
  add('join junk', await R({ path: '/join/zzz' }), 410);
  add('join taken', await R({ path: `/join/${takenInv.token}` }), 409);
  add('join redirect', await R({ path: `/join/${used.token}`, headers: { Cookie: client(app).cookie || '' } }), 410);
  // API: every status the spec lists
  add('200 json', await R({ path: '/api/auth/config' }), 200);
  add('400 json', await R({ method: 'POST', path: '/api/auth/login', body: '{bad', headers: J }), 400);
  add('401', await R({ path: '/api/auth/me' }), 401);
  add('403 csrf', await R({ method: 'POST', path: '/api/auth/login', body: {}, headers: { 'Content-Type': 'application/json' } }), 403);
  add('403 rules', await user.client.set('players/x', { a: 1 }), 403);
  add('403 admin', await user.client.get('/api/admin/accounts'), 403);
  add('409', await client(app).post('/api/auth/signup', { username: 'plain', password: 'correct horse 1' }), 409);
  add('413', await R({ method: 'POST', path: '/api/db/write', body: 'x'.repeat(400 * 1024), headers: { ...J, Cookie: admin.cookie } }), 413);
  let deep = { v: 1 };
  for (let i = 0; i < 32; i++) deep = { n: deep };
  add('507', await admin.set('misc/deep', deep), 507);
  const limited = client(app);
  for (let i = 0; i < 10; i++) await limited.post('/api/auth/login', { username: 'ghost', password: 'wrong wrong' });
  add('429', await limited.post('/api/auth/login', { username: 'ghost', password: 'wrong wrong' }), 429);
  const orig = app.store.list;
  app.store.list = () => { throw new Error('secret internal detail /home/x/y'); };
  const five = await admin.list('players');
  app.store.list = orig;
  add('500', five, 500);
  assert.deepStrictEqual(five.json, { error: 'Something went wrong on our side.' }, 'no internals in a 500');
  assert.ok(!five.text.includes('secret') && !five.text.includes('/home'));
  const s0 = (await admin.get('/api/changes?since=0')).json.seq;
  add('long-poll timeout', await admin.get(`/api/changes?since=${s0}&wait=1`), 200);
  add('OPTIONS preflight', await R({ method: 'OPTIONS', path: '/api/db/write', headers: { Origin: 'https://evil.example', 'Access-Control-Request-Method': 'POST' } }), 403);
  add('HEAD api', await R({ method: 'HEAD', path: '/api/auth/config' }), 200);
  add('PATCH', await R({ method: 'PATCH', path: '/api/db/write', body: {}, headers: { ...J, Cookie: admin.cookie } }), 404);
  // the body timeout answer
  const slow = await rawExchange(port, `POST /api/auth/login HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nX-CB: 1\r\nContent-Length: 50\r\n\r\n{"user`, { wait: 1500 });
  const slowRes = parseRaw(slow);
  add('408 body timeout', { status: slowRes.status, headers: slowRes.headers }, 408);
  // parser-level failures
  const long = parseRaw(await rawExchange(port, `GET / HTTP/1.1\r\nHost: x\r\nX-Long: ${'a'.repeat(40000)}\r\n\r\n`));
  add('431 headers too large', { status: long.status, headers: long.headers }, 431);
  const junk = parseRaw(await rawExchange(port, '\x00\x01 NOT HTTP AT ALL\r\n\r\n'));
  add('400 garbage', { status: junk.status, headers: junk.headers }, 400);

  for (const [label, res] of results) assertSecure(res, label);
  // API responses are never cached; pages that carry state aren't either
  for (const [label, res] of results) {
    if (/json|api|401|403|409|413|429|500|507|408|400 json|long-poll|HEAD api|PATCH|OPTIONS/.test(label) && res.headers['content-type'] && /json/.test(res.headers['content-type'])) {
      assert.strictEqual(res.headers['cache-control'], 'no-store', `${label}: no-store`);
    }
  }
  assert.strictEqual((await R({ path: '/', headers: { Cookie: user.client.cookie } })).headers['cache-control'], 'no-store');
  assert.match(shim.headers['content-type'], /^text\/javascript/);
  assert.strictEqual(shim.headers['cache-control'], 'no-cache');
  assert.ok(shim.headers.etag);
});

test('HSTS appears only over https (behind a trusted proxy), on every kind of response', async (t) => {
  const app = await boot({ trustProxy: 1 });
  t.after(() => app.close());
  const H = { 'X-Forwarded-Proto': 'https' };
  for (const [label, opts] of [
    ['health', { path: '/healthz' }], ['redirect', { path: '/' }], ['login', { path: '/login' }], ['404', { path: '/nope' }], ['api 401', { path: '/api/auth/me' }],
    ['api config', { path: '/api/auth/config' }], ['shim', { path: '/shim.js' }], ['api 403', { method: 'POST', path: '/api/auth/login', body: {} }],
  ]) {
    const res = await request(app.port, { ...opts, headers: { ...H, ...opts.headers } });
    assertSecure(res, `${label} (https)`, { https: true });
    assertSecure(await request(app.port, opts), `${label} (http)`);
  }
});

test('CSRF: state-changing requests need JSON, the X-CB header, and (if present) a same-site Origin', async (t) => {
  const app = await boot();
  t.after(() => app.close());
  const admin = await loginAdmin(app);
  const alice = await signup(app, 'alice');
  await admin.set('players/p1', { name: 'Jamie' });
  const inv = (await admin.post('/api/admin/invites', { playerId: 'p1' })).json;
  const target = makeUser(app, 'target');
  const port = app.port;
  const origin = `http://127.0.0.1:${port}`;
  const endpoints = [
    // [who, method, path, body]
    [alice, 'POST', '/api/auth/logout', {}],
    [alice, 'POST', '/api/auth/password', { current: 'correct horse 1', next: 'hijacked password' }],
    [alice, 'POST', '/api/db/write', { op: 'set', path: `bets/${alice.uid}`, data: { csrf: true, list: [] } }],
    [alice, 'POST', '/api/profiles', { ids: [] }],
    [alice, 'POST', '/api/auth/redeem', { token: inv.token }],
    [null, 'POST', '/api/auth/signup', { username: 'csrfuser', password: 'correct horse 1' }],
    [null, 'POST', '/api/auth/login', { username: 'alice', password: 'correct horse 1' }],
    [admin, 'POST', `/api/admin/accounts/${target.uid}/disable`, { disabled: true }],
    [admin, 'POST', `/api/admin/accounts/${target.uid}/reset-password`, {}],
    [admin, 'POST', '/api/admin/invites', { playerId: 'p1' }],
    [admin, 'DELETE', `/api/admin/invites/${inv.id}`, undefined],
    [admin, 'POST', '/api/admin/import-now', {}],
  ];
  const sent = (who, method, p, body, headers) => request(port, { method, path: p, body: body === undefined ? undefined : body, headers: { ...(who ? { Cookie: who.cookie } : {}), ...headers } });
  const good = { 'Content-Type': 'application/json', 'X-CB': '1' };
  const bad = [
    ['no headers at all', {}],
    ['missing X-CB', { 'Content-Type': 'application/json' }],
    ['X-CB is 0', { ...good, 'X-CB': '0' }],
    ['X-CB is true', { ...good, 'X-CB': 'true' }],
    ['X-CB empty', { ...good, 'X-CB': '' }],
    ['no Content-Type', { 'X-CB': '1' }],
    ['text/plain (a cross-site form can send this)', { ...good, 'Content-Type': 'text/plain' }],
    ['form-urlencoded', { ...good, 'Content-Type': 'application/x-www-form-urlencoded' }],
    ['multipart', { ...good, 'Content-Type': 'multipart/form-data; boundary=x' }],
    ['application/jsonp', { ...good, 'Content-Type': 'application/jsonp' }],
    ['text/json', { ...good, 'Content-Type': 'text/json' }],
    ['foreign Origin', { ...good, Origin: 'https://evil.example' }],
    ['Origin null (sandboxed iframe)', { ...good, Origin: 'null' }],
    ['same host, other port', { ...good, Origin: `http://127.0.0.1:${port + 1}` }],
    ['host as a prefix of an evil one', { ...good, Origin: `${origin}.evil.example` }],
    ['host as a suffix of an evil one', { ...good, Origin: `http://evil${port}.127.0.0.1:${port}` }],
    ['garbage Origin', { ...good, Origin: '%%%' }],
    ['file origin', { ...good, Origin: 'file://' }],
    ['browser says cross-site', { ...good, 'Sec-Fetch-Site': 'cross-site' }],
  ];
  const before = { users: app.auth.users.size, invites: app.auth.invites.size, sessions: app.auth.sessions.size, docs: app.store.docs.size, seq: app.store.seq };
  for (const [who, method, p, body] of endpoints) {
    for (const [label, headers] of bad) {
      const r = await sent(who, method, p, body, headers);
      assert.strictEqual(r.status, 403, `${method} ${p}: ${label} -> ${r.status} ${r.text.slice(0, 80)}`);
      assert.deepStrictEqual(Object.keys(r.json), ['error']);
    }
  }
  assert.deepStrictEqual({ users: app.auth.users.size, invites: app.auth.invites.size, sessions: app.auth.sessions.size, docs: app.store.docs.size, seq: app.store.seq }, before, 'not one blocked request changed anything');
  assert.strictEqual(app.auth.users.get(target.uid).disabled, false);
  assert.strictEqual((await client(app, alice.cookie).get('/api/auth/me')).status, 200, 'alice is still signed in: the forged logout did nothing');
  assert.strictEqual((await client(app).post('/api/auth/login', { username: 'alice', password: 'correct horse 1' })).status, 200, 'and her password was not changed');
  // the same requests with the right headers and our own Origin work
  const ok = await sent(alice, 'POST', '/api/db/write', { op: 'set', path: `bets/${alice.uid}`, data: { fine: true, list: [] } }, { ...good, Origin: origin });
  assert.strictEqual(ok.status, 200);
  assert.strictEqual((await sent(alice, 'POST', '/api/profiles', { ids: [] }, { 'Content-Type': 'application/json; charset=UTF-8', 'X-CB': '1', Origin: origin.toUpperCase().replace('HTTP', 'http'), 'Sec-Fetch-Site': 'same-origin' })).status, 200, 'charset, upper-case host and same-origin are fine');
  assert.strictEqual((await sent(alice, 'POST', '/api/profiles', { ids: [] }, { ...good, 'Sec-Fetch-Site': 'same-site' })).status, 200, 'without an Origin header the cookie rules (SameSite=Lax) are what protect us');
  // GET endpoints change nothing, so there is nothing to forge
  for (const p of ['/api/auth/logout', '/api/db/write', '/api/auth/login', '/api/auth/signup', '/api/auth/password', '/api/auth/redeem', '/api/admin/invites/x', '/api/admin/import-now', `/api/admin/accounts/${target.uid}/disable`]) {
    assert.strictEqual((await sent(alice, 'GET', p, undefined, {})).status, 404, `GET ${p}`);
  }
  assert.strictEqual((await sent(alice, 'POST', '/api/db/write?_method=DELETE', { op: 'set', path: 'bets/x', data: {} }, { ...good, 'X-HTTP-Method-Override': 'DELETE' })).status, 403);
});

test('static files: a fixed allow-list, exact names only', async (t) => {
  const publicDir = makePublic({
    'login.html': '<!doctype html><title>the login page</title>',
    'app.html': '<!doctype html><title>the app</title>',
    'shim.js': 'window.claude = {};\n'.repeat(400),
    'secret.txt': 'TOP SECRET FILE',
    'favicon.svg': '<svg xmlns="http://www.w3.org/2000/svg"/>',
  });
  fs.mkdirSync(path.join(publicDir, 'sub'));
  fs.writeFileSync(path.join(publicDir, 'sub', 'x.js'), 'SUB FILE');
  const app = await boot({ publicDir });
  t.after(() => app.close());
  const user = makeUser(app, 'plain');
  for (const p of ['/app.html', '/login.html', '/secret.txt', '/sub/x.js', '/sub', '/sub/', '/public/shim.js', '/site/public/shim.js', '/server.js', '/site/server.js', '/lib/auth.js', '/lib/store.js',
    '/package.json', '/SPEC.md', '/site/SPEC.md', '/auth.json', '/db.json', '/data/auth.json', '/.env', '/.git/config', '/../server.js', '/%2e%2e/server.js', '/%2e%2e%2fserver.js', '/..%2fserver.js',
    '/shim.js/', '/shim.js%00.html', '/shim.js%2f', '/SHIM.JS', '/./shim.js', '//shim.js', '/shim.jsx', '/shim', '/manifest.webmanifest', '/favicon.ico', '/index.html', '/static/shim.js', '/api', '/api/']) {
    for (const cookie of [undefined, user.client.cookie]) {
      const r = await request(app.port, { path: p, headers: cookie ? { Cookie: cookie } : {} });
      assert.strictEqual(r.status, 404, `${p} -> ${r.status}`);
      assert.ok(!/TOP SECRET|SUB FILE|createServer|the app|the login page/.test(r.text), p);
    }
  }
  const shim = await request(app.port, { path: '/shim.js' });
  assert.strictEqual(shim.status, 200);
  assert.strictEqual(shim.text, 'window.claude = {};\n'.repeat(400));
  assert.strictEqual((await request(app.port, { path: '/shim.js?v=123' })).status, 200, 'a query string is ignored');
  assert.strictEqual((await request(app.port, { path: '/favicon.svg' })).headers['content-type'], 'image/svg+xml');
  // conditional requests and compression
  assert.strictEqual((await request(app.port, { path: '/shim.js', headers: { 'If-None-Match': shim.headers.etag } })).status, 304);
  assert.strictEqual((await request(app.port, { path: '/shim.js', headers: { 'If-None-Match': 'W/"other"' } })).status, 200);
  const gz = await new Promise((resolve, reject) => {
    require('http').get({ host: '127.0.0.1', port: app.port, path: '/shim.js', agent: false, headers: { 'Accept-Encoding': 'gzip' } }, (res) => {
      const chunks = []; res.on('data', (c) => chunks.push(c)); res.on('end', () => resolve({ headers: res.headers, body: Buffer.concat(chunks) }));
    }).on('error', reject);
  });
  assert.strictEqual(gz.headers['content-encoding'], 'gzip');
  assert.strictEqual(gz.headers.vary, 'Accept-Encoding');
  assert.strictEqual(zlib.gunzipSync(gz.body).toString(), 'window.claude = {};\n'.repeat(400));
  assert.ok(gz.body.length < 500);
  // the page: only for signed-in people, never cached, and edits on disk are picked up
  assert.strictEqual((await request(app.port, { path: '/' })).headers.location, '/login');
  const home = await request(app.port, { path: '/', headers: { Cookie: user.client.cookie, 'If-None-Match': '*' } });
  assert.strictEqual(home.status, 200);
  assert.strictEqual(home.text, '<!doctype html><title>the app</title>');
  assert.strictEqual(home.headers['cache-control'], 'no-store');
  assert.strictEqual(home.headers.etag, undefined === home.headers.etag ? undefined : home.headers.etag);
  await sleep(20);
  fs.writeFileSync(path.join(publicDir, 'app.html'), '<!doctype html><title>the NEW app</title>');
  assert.match((await request(app.port, { path: '/', headers: { Cookie: user.client.cookie } })).text, /NEW app/);
  assert.match((await request(app.port, { path: '/login' })).text, /the login page/);
  assert.strictEqual((await request(app.port, { path: '/login' })).headers['cache-control'], 'no-cache');
});

test('missing page files give a polite 503, never a crash; healthz and the API carry on', async (t) => {
  const publicDir = makePublic({});
  const app = await boot({ publicDir });
  t.after(() => app.close());
  const user = makeUser(app, 'plain');
  for (const [p, cookie] of [['/login', undefined], ['/shim.js', undefined], ['/', user.client.cookie], ['/login', undefined]]) {
    const r = await request(app.port, { path: p, headers: cookie ? { Cookie: cookie } : {} });
    assert.strictEqual(r.status, 503, p);
    assert.match(r.text, /Back in a minute/);
    assert.ok(Number(r.headers['retry-after']) > 0);
    assertSecure(r, p);
  }
  assert.strictEqual((await request(app.port, { path: '/' })).status, 302, 'signed out still goes to /login (which then says 503)');
  assert.strictEqual((await request(app.port, { path: '/healthz' })).text, 'ok');
  assert.strictEqual((await request(app.port, { path: '/favicon.svg' })).status, 404);
  assert.strictEqual((await user.client.get('/api/auth/me')).status, 200);
  // the files appear later (the other half of the site finishes building): served without a restart
  fs.writeFileSync(path.join(publicDir, 'login.html'), '<!doctype html><title>arrived</title>');
  assert.match((await request(app.port, { path: '/login' })).text, /arrived/);
  // a directory where a file should be is also just "not ready"
  fs.mkdirSync(path.join(publicDir, 'shim.js'));
  assert.strictEqual((await request(app.port, { path: '/shim.js' })).status, 503);
  // the empty-dir server did not throw into the log
  assert.ok(!/error/i.test(app.logs.join('\n')));
});

test('requests with strange URLs and methods are answered, not crashed on', async (t) => {
  const app = await boot();
  t.after(() => app.close());
  for (const raw of ['GET http://evil.example/healthz HTTP/1.1', 'GET * HTTP/1.1', 'GET healthz HTTP/1.1']) {
    const res = parseRaw(await rawExchange(app.port, `${raw}\r\nHost: x\r\nConnection: close\r\n\r\n`));
    assert.ok([400, 404].includes(res.status), `${raw} -> ${res.status}`);
    assert.strictEqual(res.headers['x-content-type-options'], 'nosniff');
  }
  for (const p of ['/%', '/%zz', '/a%00b', '/api/db/doc?path=%E0%A4%A', '/api/auth/me?%', '/é']) {
    const r = await request(app.port, { path: p }).catch((e) => ({ status: e.code }));
    assert.ok([400, 401, 404].includes(r.status) || r.status === 'ERR_UNESCAPED_CHARACTERS', `${p} -> ${r.status}`);
  }
  for (const method of ['PUT', 'DELETE', 'TRACE', 'CONNECT', 'PROPFIND']) {
    const r = await request(app.port, { method, path: '/', headers: { 'Content-Type': 'application/json', 'X-CB': '1' } }).catch((e) => ({ status: e.code }));
    assert.ok([404, 405, 501, 'ECONNRESET', 'HPE_INVALID_METHOD'].includes(r.status) || typeof r.status === 'string', `${method} -> ${r.status}`);
  }
  assert.strictEqual((await request(app.port, { path: '/healthz' })).status, 200, 'still alive');
});

test('limits: 200 connections, header and body timeouts', async (t) => {
  const app = await boot({ bodyTimeoutMs: 300 });
  t.after(() => app.close());
  assert.strictEqual(app.server.maxConnections, 200);
  assert.strictEqual(app.server.headersTimeout, 70000, 'longer than keep-alive, so a proxy never reuses a socket we are closing');
  assert.ok(app.server.requestTimeout >= 15000 && app.server.requestTimeout <= 30000);
  assert.ok(app.server.keepAliveTimeout > 60000 && app.server.keepAliveTimeout < app.server.headersTimeout);
  assert.strictEqual(resolveConfig({ env: {} }).bodyTimeoutMs, 15000);
  // a slow body is cut off
  const t0 = Date.now();
  const raw = await rawExchange(app.port, 'POST /api/auth/login HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nX-CB: 1\r\nContent-Length: 100\r\n\r\n{"a"', { wait: 3000 });
  assert.match(raw, /^HTTP\/1\.1 408/);
  assert.ok(Date.now() - t0 < 2500);
  // the 201st simultaneous connection is turned away
  const socks = [];
  for (let i = 0; i < 200; i++) {
    const s = net.connect(app.port, '127.0.0.1');
    s.on('error', () => {});
    socks.push(s);
  }
  await Promise.all(socks.map((s) => new Promise((r) => s.once('connect', r))));
  const extra = await new Promise((resolve) => {
    const s = net.connect(app.port, '127.0.0.1');
    let got = '';
    s.on('data', (d) => { got += d; });
    s.on('error', () => resolve({ got, closed: true }));
    s.on('close', () => resolve({ got, closed: true }));
    s.write('GET /healthz HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n');
    setTimeout(() => { s.destroy(); resolve({ got, closed: false }); }, 2000);
  });
  assert.strictEqual(extra.got.includes('200 OK'), false, 'no answer for connection 201');
  for (const s of socks) s.destroy();
  await sleep(100);
  assert.strictEqual((await request(app.port, { path: '/healthz' })).status, 200, 'back to normal once they are gone');
});

test('no password, token, cookie or hash appears in the log or in any response where it should not', async (t) => {
  const app = await boot({ adminPassword: 'owner password 99' });
  t.after(() => app.close());
  const admin = await login(app, 'admin', 'owner password 99');
  await admin.set('players/p1', { name: 'Jamie' });
  const seen = [];
  const note = (r) => { seen.push(r.text + JSON.stringify(r.headers['set-cookie'] || '')); return r; };
  const friend = await signup(app, 'friend', { password: 'friend password 77' });
  note(friend.res);
  const inv = note(await admin.post('/api/admin/invites', { playerId: 'p1' })).json;
  const redeemed = note(await client(app).post('/api/auth/redeem', { token: inv.token }));
  note(await friend.client.post('/api/auth/password', { current: 'friend password 77', next: 'friend new password 78' }));
  note(await client(app).post('/api/auth/login', { username: 'friend', password: 'wrong password 1' }));
  const reset = note(await admin.post(`/api/admin/accounts/${friend.uid}/reset-password`)).json;
  // everything an admin or user can read
  const responses = [];
  for (const p of ['/api/auth/me', '/api/admin/accounts', '/api/admin/invites', '/api/db/list?collection=players', '/api/db/list?collection=links', '/api/changes?since=0', '/api/auth/config']) responses.push(await admin.get(p));
  responses.push(await admin.post('/api/profiles', { ids: [friend.uid] }));
  const hashes = [...app.auth.users.values()].map((u) => u.pass).filter(Boolean);
  const sessionKeys = [...app.auth.sessions.keys()];
  const inviteHashes = [...app.auth.invites.values()].map((i) => i.hash);
  assert.ok(hashes.length >= 2 && sessionKeys.length >= 2 && inviteHashes.length === 1);
  for (const r of responses) {
    for (const secret of [...hashes, ...sessionKeys, ...inviteHashes, 's1:']) assert.ok(!r.text.includes(secret), `a secret leaked: ${secret.slice(0, 8)}`);
    for (const s of [inv.token, reset.tempPassword, 'friend password 77', 'owner password 99']) assert.ok(!r.text.includes(s));
  }
  const logs = app.logs.join('\n');
  for (const secret of ['owner password 99', 'friend password 77', 'friend new password 78', 'wrong password 1', inv.token, reset.tempPassword, ...hashes, ...sessionKeys, ...inviteHashes, cookieOf(redeemed).split('=')[1], friend.cookie.split('=')[1]]) {
    assert.ok(!logs.includes(secret), `log must not contain ${String(secret).slice(0, 8)}...`);
  }
  // after a forced error the log has the cause but still no request secrets
  const orig = app.store.list;
  app.store.list = () => { throw new Error('disk on fire'); };
  assert.strictEqual((await admin.get('/api/db/list?collection=players')).status, 500);
  app.store.list = orig;
  assert.match(app.logs.join('\n'), /disk on fire/);
  assert.ok(!app.logs.join('\n').includes(admin.cookie.split('=')[1]));
});

test('configuration defaults and environment parsing', () => {
  const d = resolveConfig({ env: {} });
  assert.strictEqual(d.port, 3000);
  assert.strictEqual(d.adminUsername, 'admin');
  assert.strictEqual(d.adminPassword, '');
  assert.strictEqual(d.signupCode, '');
  assert.strictEqual(d.sessionDays, 90);
  assert.strictEqual(d.trustProxy, 0);
  assert.strictEqual(d.cookieSecure, undefined);
  assert.strictEqual(d.dataDir, path.resolve('site-data'));
  assert.strictEqual(d.publicUrl, '');
  assert.strictEqual(resolveConfig({ env: { NODE_ENV: 'production' } }).trustProxy, 'auto', 'sorted out by itself in production');
  assert.strictEqual(resolveConfig({ env: { TRUST_PROXY: 'AUTO' } }).trustProxy, 'auto');
  assert.strictEqual(resolveConfig({ env: { NODE_ENV: 'production', TRUST_PROXY: '0' } }).trustProxy, 0);
  assert.strictEqual(resolveConfig({ env: { TRUST_PROXY: 'true' } }).trustProxy, 1);
  assert.strictEqual(resolveConfig({ env: { TRUST_PROXY: '2' } }).trustProxy, 2);
  assert.strictEqual(resolveConfig({ env: { TRUST_PROXY: 'banana' } }).trustProxy, 0);
  assert.strictEqual(resolveConfig({ env: { COOKIE_SECURE: '1' } }).cookieSecure, true);
  assert.strictEqual(resolveConfig({ env: { COOKIE_SECURE: 'false' } }).cookieSecure, false);
  assert.strictEqual(resolveConfig({ env: { COOKIE_SECURE: 'maybe' } }).cookieSecure, undefined);
  const e = resolveConfig({ env: { PORT: '8080', DATA_DIR: '/var/data', ADMIN_USERNAME: ' Boss ', ADMIN_PASSWORD: 'pw', SIGNUP_CODE: 'code', PUBLIC_URL: 'https://x.example/', SESSION_DAYS: '30' } });
  assert.deepStrictEqual([e.port, e.dataDir, e.adminUsername, e.adminPassword, e.signupCode, e.publicUrl, e.sessionDays], [8080, '/var/data', 'boss', 'pw', 'code', 'https://x.example', 30]);
  assert.strictEqual(resolveConfig({ env: { PORT: 'abc' } }).port, 3000);
  assert.strictEqual(resolveConfig({ env: { PORT: '0' } }).port, 0);
  assert.strictEqual(resolveConfig({ env: { PORT: '9' }, port: 7 }).port, 7, 'options beat the environment');
});

test('the server file contains none of the things the spec forbids', () => {
  const dir = path.join(__dirname, '..');
  const files = [path.join(dir, 'server.js'), ...fs.readdirSync(path.join(dir, 'lib')).map((f) => path.join(dir, 'lib', f))];
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    const name = path.relative(dir, f);
    assert.ok(!/\beval\s*\(/.test(src), `${name}: eval`);
    assert.ok(!/new\s+Function\s*\(/.test(src), `${name}: Function constructor`);
    assert.ok(!/\bexec\s*\(|\bexecSync\s*\(|\bspawnSync?\s*\([^)]*shell/.test(src.replace(/\.exec\(/g, '')), `${name}: shell exec`);
    assert.ok(!/require\(['"](?!\.|node:|http|https|fs|path|os|net|zlib|crypto|child_process|url|util|stream|events|assert|string_decoder)/.test(src), `${name}: only built-ins`);
    assert.ok(!/console\.(log|error|warn)\([^)]*(password|token|cookie)/i.test(src), `${name}: logs secrets`);
  }
  const importer = fs.readFileSync(path.join(dir, 'lib', 'importer.js'), 'utf8');
  assert.match(importer, /execFile\(process\.execPath, \[/, 'the importer runs node with an argument array');
});
