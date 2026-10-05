'use strict';

// Shared test plumbing: start the real server on a random port with a temp DATA_DIR, and talk to it
// over real HTTP. Passwords are hashed with a cheap scrypt cost here (one test checks the real one).

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { startServer } = require('../server');

// temp folders are removed when the test process ends
const made = [];
process.on('exit', () => { for (const d of made) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } } });
const tmp = (prefix) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); made.push(d); return d; };

// stand-ins for the browser builder's files, so these tests don't depend on them
function makePublic(files) {
  const dir = tmp('cb-public-');
  const all = files || {
    'login.html': '<!doctype html><title>login page</title><p>login</p>',
    'app.html': '<!doctype html><title>app page</title><script src="/shim.js"></script>',
    'shim.js': '/* shim */ window.claude = {};',
  };
  for (const [name, text] of Object.entries(all)) fs.writeFileSync(path.join(dir, name), text);
  return dir;
}

const ADMIN_PASSWORD = 'admin-pass-123';

async function boot(opts = {}) {
  const dataDir = opts.dataDir || tmp('cb-data-');
  const logs = [];
  const app = await startServer({
    env: {}, port: 0, host: '127.0.0.1', dataDir,
    publicDir: makePublic(), seedFile: path.join(dataDir, 'no-seed.json'),
    adminPassword: ADMIN_PASSWORD, scryptN: 1024, importIntervalMin: 0, debounceMs: 20,
    limits: { signupPerHour: 1000 }, log: (line) => logs.push(line),
    ...opts,
  });
  app.logs = logs;
  app.dataDir = dataDir;
  return app;
}

// one raw HTTP exchange; never keeps connections alive
function request(port, { method = 'GET', path: p = '/', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : (typeof body === 'string' || Buffer.isBuffer(body)) ? body : JSON.stringify(body);
    const h = { ...headers };
    if (data !== null && h['Content-Length'] === undefined) h['Content-Length'] = Buffer.byteLength(data);
    const req = http.request({ host: '127.0.0.1', port, method, path: p, headers: h, agent: false }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch { /* not JSON */ }
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on('error', reject);
    req.end(data);
  });
}

// a browser with (maybe) a session cookie: sends the CSRF headers the page sends
function client(app, cookie) {
  const c = {
    cookie,
    call(method, p, body, headers = {}) {
      return request(app.port, {
        method, path: p, body,
        headers: { ...(method !== 'GET' ? { 'Content-Type': 'application/json', 'X-CB': '1' } : {}), ...(c.cookie ? { Cookie: c.cookie } : {}), ...headers },
      });
    },
    get: (p, h) => c.call('GET', p, undefined, h),
    post: (p, b, h) => c.call('POST', p, b === undefined ? {} : b, h),
    del: (p, h) => c.call('DELETE', p, undefined, h),
    // db helpers
    doc: (p) => c.get(`/api/db/doc?path=${encodeURIComponent(p)}`),
    list: (p) => c.get(`/api/db/list?collection=${encodeURIComponent(p)}`),
    write: (op, p, data, extra) => c.post('/api/db/write', { op, path: p, ...(data === undefined ? {} : { data }), ...extra }),
    set: (p, data, extra) => c.write('set', p, data, extra),
  };
  return c;
}

const cookieOf = (res) => {
  const raw = res.headers['set-cookie'];
  const line = (Array.isArray(raw) ? raw : raw ? [raw] : []).find((l) => l.startsWith('cb_session='));
  return line ? line.split(';')[0] : null;
};

// sign up over HTTP; returns { client, uid, cookie, res }
async function signup(app, username, extra = {}) {
  const anon = client(app);
  const res = await anon.post('/api/auth/signup', { username, password: 'correct horse 1', ...extra });
  if (res.status !== 200) throw new Error(`signup ${username} failed: ${res.status} ${res.text}`);
  const c = client(app, cookieOf(res));
  return { client: c, uid: res.json.me.uid, cookie: c.cookie, res };
}

async function login(app, username, password) {
  const res = await client(app).post('/api/auth/login', { username, password });
  if (res.status !== 200) throw new Error(`login ${username} failed: ${res.status} ${res.text}`);
  return client(app, cookieOf(res));
}

const loginAdmin = (app) => login(app, 'admin', ADMIN_PASSWORD);

// a user without hashing or rate limits: for tests that need many accounts quickly
function makeUser(app, username, { admin = false, display } = {}) {
  const user = app.auth.createUser({ username, display: display || username, admin, pass: null, via: 'admin' });
  const token = app.auth.createSession(user.uid);
  return { uid: user.uid, user, client: client(app, `cb_session=${token}`) };
}

module.exports = { boot, request, client, signup, login, loginAdmin, makeUser, makePublic, cookieOf, tmp, ADMIN_PASSWORD };
