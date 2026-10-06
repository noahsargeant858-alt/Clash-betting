'use strict';

const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { startServer } = require('../server');
const { GithubSnapshot, writeAtomic } = require('../lib/persist');
const { boot, request, client, signup, login, loginAdmin, makeUser, tmp, makePublic, cookieOf, ADMIN_PASSWORD } = require('./helper');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const readJson = (dir, f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));

// ---------- files ----------

test('everything survives a restart: accounts, sessions, documents, versions, seq', async (t) => {
  const dataDir = tmp('cb-persist-');
  const a = await boot({ dataDir });
  const friend = await signup(a, 'friend', { display: 'Fran' });
  const admin = await loginAdmin(a);
  await admin.set('players/p1', { name: 'Ann' });
  await admin.set('players/p1', { name: 'Anne' });
  await admin.write('update', 'players/p1', { coins: 7 });
  const betDoc = { list: [{ id: 'b1', fx: 'f1', stake: 5, placedAt: new Date().toISOString() }] };
  await friend.client.set(`bets/${friend.uid}`, betDoc);
  await admin.set('matches/gone', { x: 1 });
  await admin.write('delete', 'matches/gone');
  const inv = (await admin.post('/api/admin/invites', { playerId: 'p1' })).json;
  const seq = (await admin.get('/api/changes?since=0')).json.seq;
  await a.close();

  const files = fs.readdirSync(dataDir).sort();
  assert.deepStrictEqual(files, ['auth.json', 'db.json'], 'no temp files left behind');
  const db = readJson(dataDir, 'db.json');
  assert.deepStrictEqual(Object.keys(db).sort(), ['docs', 'seq']);
  assert.strictEqual(db.seq, seq);
  assert.deepStrictEqual(Object.keys(db.docs['players/p1']).sort(), ['data', 'updatedAt', 'version']);
  assert.strictEqual(db.docs['players/p1'].version, 3);
  assert.ok(!('matches/gone' in db.docs));
  const auth = readJson(dataDir, 'auth.json');
  assert.deepStrictEqual(Object.keys(auth).sort(), ['invites', 'sessions', 'users']);

  const b = await boot({ dataDir });
  t.after(() => b.close());
  // the browser that was signed in still is
  const again = client(b, friend.cookie);
  assert.strictEqual((await again.get('/api/auth/me')).json.username, 'friend');
  assert.strictEqual((await client(b, admin.cookie).get('/api/auth/me')).json.admin, true);
  assert.strictEqual((await client(b).post('/api/auth/login', { username: 'friend', password: 'correct horse 1' })).status, 200);
  // documents, versions and seq
  const doc = (await again.doc('players/p1')).json;
  assert.deepStrictEqual([doc.data, doc.version, doc.seq], [{ name: 'Anne', coins: 7 }, 3, seq]);
  assert.deepStrictEqual((await again.doc(`bets/${friend.uid}`)).json.data, betDoc);
  assert.strictEqual((await again.doc('matches/gone')).json.exists, false);
  // new writes carry on from where it left off
  const w = await client(b, admin.cookie).set('players/p1', { name: 'Again' });
  assert.deepStrictEqual(w.json, { version: 4, seq: seq + 1 });
  // the invite is still open and still works; there is still only one admin
  assert.strictEqual((await client(b).post('/api/auth/redeem', { token: inv.token })).status, 200);
  assert.strictEqual([...b.auth.users.values()].filter((u) => u.admin).length, 1);
});

test('writes reach disk within about a second without waiting for shutdown', async (t) => {
  const app = await boot({ debounceMs: 30 });
  t.after(() => app.close());
  const admin = await loginAdmin(app);
  await admin.set('players/p1', { name: 'Ann' });
  await sleep(250);
  assert.strictEqual(readJson(app.dataDir, 'db.json').docs['players/p1'].data.name, 'Ann');
  assert.ok(Object.keys(readJson(app.dataDir, 'auth.json').sessions).length >= 1, 'the sign-in too');
  assert.ok(!fs.readdirSync(app.dataDir).some((f) => f.endsWith('.tmp')));
});

test('the default debounce is about a second, and closing flushes what is waiting', async (t) => {
  const app = await boot({ debounceMs: undefined });
  const admin = await loginAdmin(app);
  await admin.set('players/p1', { name: 'Ann' });
  assert.ok(!('players/p1' in readJson(app.dataDir, 'db.json').docs), 'not written yet: the write is waiting for the debounce');
  await app.close();
  assert.strictEqual(readJson(app.dataDir, 'db.json').docs['players/p1'].data.name, 'Ann', 'close() flushed it');
  void t;
});

test('files are written atomically and privately', () => {
  const dir = tmp('cb-atomic-');
  const file = path.join(dir, 'x.json');
  writeAtomic(file, '{"a":1}');
  writeAtomic(file, '{"a":2}');
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { a: 2 });
  assert.deepStrictEqual(fs.readdirSync(dir), ['x.json']);
  assert.strictEqual(fs.statSync(file).mode & 0o777, 0o600);
  // if the rename can't happen the old file is untouched
  const realRename = fs.renameSync;
  fs.renameSync = () => { throw new Error('disk gone'); };
  try { assert.throws(() => writeAtomic(file, '{"a":3}'), /disk gone/); } finally { fs.renameSync = realRename; }
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { a: 2 });
});

test('a damaged data file stops the boot and is left alone', async () => {
  for (const name of ['db.json', 'auth.json']) {
    const dir = tmp('cb-corrupt-');
    fs.writeFileSync(path.join(dir, name), '{"seq": 5, "docs": {"a/b": {"da');
    const before = fs.readFileSync(path.join(dir, name), 'utf8');
    await assert.rejects(startServer({ env: {}, port: 0, host: '127.0.0.1', dataDir: dir, publicDir: makePublic(), scryptN: 1024, importIntervalMin: 0, log: () => {} }), new RegExp(`${name.replace('.', '\\.')}.*not valid JSON`));
    assert.strictEqual(fs.readFileSync(path.join(dir, name), 'utf8'), before, 'we did not overwrite what might still be rescued');
  }
});

test('damaged documents inside db.json are skipped, not fatal', async (t) => {
  const dir = tmp('cb-damaged-');
  fs.writeFileSync(path.join(dir, 'db.json'), JSON.stringify({ seq: 9, docs: {
    'players/ok': { data: { name: 'Fine' }, version: 2, updatedAt: '2026-01-01T00:00:00.000Z' },
    'players/../bad': { data: {}, version: 1 }, 'odd': { data: {}, version: 1 }, 'players/arr': { data: [1], version: 1 }, 'players/v0': { data: {}, version: 0 },
  } }));
  const app = await boot({ dataDir: dir });
  t.after(() => app.close());
  assert.match(app.logs.join('\n'), /ignored 4 damaged documents/);
  const admin = await loginAdmin(app);
  assert.strictEqual((await admin.doc('players/ok')).json.data.name, 'Fine');
  assert.strictEqual((await admin.list('players')).json.docs.length, 1);
  assert.strictEqual((await admin.doc('players/ok')).json.seq, 9);
});

test('SIGTERM saves both files and exits cleanly (real process)', async () => {
  const dataDir = tmp('cb-sigterm-');
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { PATH: process.env.PATH, PORT: '0', HOST: '127.0.0.1', DATA_DIR: dataDir, ADMIN_PASSWORD: ADMIN_PASSWORD, IMPORT_INTERVAL_MIN: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  const exited = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })));
  let port;
  for (let i = 0; i < 100 && !port; i++) { const m = /listening on port (\d+)/.exec(out); if (m) port = Number(m[1]); else await sleep(100); }
  assert.ok(port, `server started: ${out}`);
  const post = (p, body, cookie) => request(port, { method: 'POST', path: p, body, headers: { 'Content-Type': 'application/json', 'X-CB': '1', ...(cookie ? { Cookie: cookie } : {}) } });
  const res = await post('/api/auth/login', { username: 'admin', password: ADMIN_PASSWORD });
  assert.strictEqual(res.status, 200, out);
  const cookie = cookieOf(res);
  assert.strictEqual((await post('/api/db/write', { op: 'set', path: 'players/shutdown-test', data: { name: 'Saved' } }, cookie)).status, 200);
  // within the debounce window: not on disk yet
  assert.ok(!('players/shutdown-test' in readJson(dataDir, 'db.json').docs));
  child.kill('SIGTERM');
  const { code, signal } = await exited;
  assert.strictEqual(signal, null);
  assert.strictEqual(code, 0, out);
  assert.match(out, /SIGTERM: saving and shutting down/);
  assert.strictEqual(readJson(dataDir, 'db.json').docs['players/shutdown-test'].data.name, 'Saved');
  const auth = readJson(dataDir, 'auth.json');
  assert.ok(Object.keys(auth.sessions).length >= 1, 'the sign-in was saved too');
  assert.ok(!out.includes(ADMIN_PASSWORD), 'the password is not in the output');
});

// ---------- seeding ----------

test('first boot loads the seed and points the admin placeholder at the real admin', async (t) => {
  const dir = tmp('cb-seed-');
  const seedFile = path.join(dir, 'seed.json');
  fs.writeFileSync(seedFile, JSON.stringify({ docs: {
    'players/triqqi': { data: { name: 'triqqi', addedAt: '2026-01-01T00:00:00.000Z' } },
    'links/triqqi': { data: { uid: '__ADMIN_UID__', at: '2026-01-01T00:00:00.000Z', former: [{ uid: '__ADMIN_UID__', until: 'x' }, 'not__ADMIN_UID__'] } },
    'config/settings': { data: { adminUid: '__ADMIN_UID__', nested: { list: ['__ADMIN_UID__', 5, null, { deep: '__ADMIN_UID__' }] }, keep: '__ADMIN_UID__ and more' } },
    'players/../escape': { data: { x: 1 } },
    'players/proto': { data: JSON.parse('{"__proto__":{"admin":true}}') },
    'odd': { data: {} },
  } }));
  const dataDir = path.join(dir, 'data');
  const app = await boot({ dataDir, seedFile });
  const adminUid = app.auth.userByName('admin').uid;
  const admin = await loginAdmin(app);
  const links = (await admin.doc('links/triqqi')).json;
  assert.strictEqual(links.data.uid, adminUid);
  assert.deepStrictEqual(links.data.former, [{ uid: adminUid, until: 'x' }, 'not__ADMIN_UID__'], 'only strings that are exactly the placeholder change');
  assert.strictEqual(links.version, 1);
  const settings = (await admin.doc('config/settings')).json.data;
  assert.strictEqual(settings.adminUid, adminUid);
  assert.deepStrictEqual(settings.nested.list, [adminUid, 5, null, { deep: adminUid }]);
  assert.strictEqual(settings.keep, '__ADMIN_UID__ and more');
  assert.strictEqual((await admin.get('/api/auth/me')).json.playerId, 'triqqi', 'the owner is linked to their player');
  assert.strictEqual(app.store.get('players/triqqi').version, 1);
  const log = app.logs.join('\n');
  assert.match(log, /\[seed\] loaded 3 documents/);
  assert.match(log, /skipped players\/\.\.\/escape/);
  assert.match(log, /skipped players\/proto/);
  assert.match(log, /skipped odd/);
  assert.strictEqual(app.store.get('players/proto'), undefined);
  // the page's own first-boot chore also finds everything in place
  await admin.write('delete', 'players/triqqi');
  await app.close();
  // a restart does not load the seed again, even if something was deleted
  fs.writeFileSync(seedFile, JSON.stringify({ docs: { 'players/newcomer': { data: { name: 'x' } } } }));
  const again = await boot({ dataDir, seedFile });
  t.after(() => again.close());
  const admin2 = await loginAdmin(again);
  assert.strictEqual((await admin2.doc('players/triqqi')).json.exists, false);
  assert.strictEqual((await admin2.doc('players/newcomer')).json.exists, false);
  assert.ok(!/\[seed\]/.test(again.logs.join('\n')));
});

test('no seed file is fine; an unreadable one is reported and skipped', async (t) => {
  const dir = tmp('cb-seed2-');
  fs.writeFileSync(path.join(dir, 'seed.json'), '{not json');
  const app = await boot({ dataDir: path.join(dir, 'd1'), seedFile: path.join(dir, 'seed.json') });
  t.after(() => app.close());
  assert.match(app.logs.join('\n'), /could not read seed\.json/);
  assert.strictEqual(app.store.docs.size, 0);
  const none = await boot({ seedFile: path.join(dir, 'missing.json') });
  t.after(() => none.close());
  assert.strictEqual(none.store.docs.size, 0);
  assert.ok(!/seed/.test(none.logs.join('\n')));
});

// ---------- encrypted GitHub snapshot ----------

// a small imitation of the parts of the GitHub API the backup uses
function mockGithub({ token = 'ghp_secrettoken' } = {}) {
  const st = { files: new Map(), branches: new Map([['main', 'sha-main']]), requests: [], conflictOnce: false, puts: 0, token };
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      const body = raw ? JSON.parse(raw) : null;
      const url = new URL(req.url, 'http://mock');
      st.requests.push({ method: req.method, path: url.pathname, authorization: req.headers.authorization, accept: req.headers.accept });
      const send = (status, obj, text) => {
        const out = text !== undefined ? text : JSON.stringify(obj);
        res.writeHead(status, { 'Content-Type': text !== undefined ? 'application/octet-stream' : 'application/json' });
        res.end(out);
      };
      if (req.headers.authorization !== `Bearer ${st.token}`) return send(401, { message: 'Bad credentials' });
      let m;
      if ((m = /^\/repos\/o\/r\/contents\/(.+)$/.exec(url.pathname))) {
        const file = m[1];
        if (req.method === 'GET') {
          const branch = url.searchParams.get('ref') || 'main';
          const f = st.files.get(`${branch}:${file}`);
          if (!st.branches.has(branch) || !f) return send(404, { message: 'Not Found' });
          if (/raw/.test(req.headers.accept || '')) return send(200, null, f.text);
          return send(200, { name: file, path: file, sha: f.sha, encoding: 'base64', content: Buffer.from(f.text).toString('base64') });
        }
        if (req.method === 'PUT') {
          st.puts++;
          if (!st.branches.has(body.branch)) return send(404, { message: `Branch ${body.branch} not found` });
          const f = st.files.get(`${body.branch}:${file}`);
          if (st.conflictOnce) { st.conflictOnce = false; return send(409, { message: `${file} does not match ${f ? f.sha : 'x'}` }); }
          if (f && !body.sha) return send(422, { message: 'Invalid request.\n\n"sha" wasn\'t supplied.' });
          if (f && body.sha !== f.sha) return send(409, { message: `${file} does not match ${f.sha}` });
          const text = Buffer.from(body.content, 'base64').toString('utf8');
          const sha = crypto.createHash('sha1').update(text + st.puts).digest('hex');
          st.files.set(`${body.branch}:${file}`, { text, sha });
          return send(f ? 200 : 201, { content: { sha } });
        }
      }
      if (req.method === 'GET' && url.pathname === '/repos/o/r') return send(200, { default_branch: 'main' });
      if (req.method === 'GET' && (m = /^\/repos\/o\/r\/git\/ref\/heads\/(.+)$/.exec(url.pathname))) return st.branches.has(m[1]) ? send(200, { object: { sha: st.branches.get(m[1]) } }) : send(404, { message: 'Not Found' });
      if (req.method === 'POST' && url.pathname === '/repos/o/r/git/refs') {
        const name = body.ref.replace('refs/heads/', '');
        if (st.branches.has(name)) return send(422, { message: 'Reference already exists' });
        st.branches.set(name, body.sha);
        return send(201, { ref: body.ref });
      }
      return send(404, { message: 'Not Found' });
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ st, url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => { server.close(r); server.closeAllConnections(); }) })));
}

const snapOpts = (gh, extra = {}) => ({ repo: 'o/r', branch: 'site-backup', token: gh.st.token, key: 'a-long-backup-key-1234567890', apiBase: gh.url, intervalMs: 0, scryptN: 1024, ...extra });

test('GitHub snapshot: pushed encrypted on shutdown, restored into an empty folder', async (t) => {
  const gh = await mockGithub();
  t.after(() => gh.close());
  const a = await boot({ snapshot: snapOpts(gh) });
  const friend = await signup(a, 'secretname', { display: 'Hidden Person' });
  const admin = await loginAdmin(a);
  await admin.set('players/p1', { name: 'Distinctive Player Name' });
  await a.close();

  // the branch was created from the default branch, the file is there and is not readable
  assert.ok(gh.st.branches.has('site-backup'));
  assert.ok(gh.st.requests.some((r) => r.method === 'POST' && r.path === '/repos/o/r/git/refs'));
  const stored = gh.st.files.get('site-backup:clashbets-snapshot.json');
  assert.ok(stored, 'a snapshot file exists on the branch');
  const env = JSON.parse(stored.text);
  assert.deepStrictEqual(Object.keys(env).sort(), ['alg', 'data', 'iv', 'kdf', 'n', 'salt', 'tag', 'v']);
  assert.strictEqual(env.alg, 'aes-256-gcm');
  for (const secret of ['secretname', 'Hidden Person', 'Distinctive Player Name', 's1:', 'players/p1', 'admin']) {
    assert.ok(!stored.text.includes(secret), `ciphertext must not contain ${secret}`);
    assert.ok(!Buffer.from(env.data, 'base64').toString('latin1').includes(secret));
  }
  assert.ok(gh.st.requests.every((r) => r.authorization === `Bearer ${gh.st.token}`));
  const logs = a.logs.join('\n');
  assert.ok(!logs.includes(gh.st.token) && !logs.includes('a-long-backup-key-1234567890'), 'neither the token nor the key is ever logged');

  // a brand new host with an empty disk
  const b = await boot({ snapshot: snapOpts(gh) });
  t.after(() => b.close());
  assert.match(b.logs.join('\n'), /restored data from the backup branch/);
  assert.ok(gh.st.requests.some((r) => r.method === 'GET' && /raw/.test(r.accept)), 'asked for the raw file');
  const me = await login(b, 'secretname', 'correct horse 1');
  assert.strictEqual((await me.get('/api/auth/me')).json.display, 'Hidden Person');
  assert.strictEqual((await me.doc('players/p1')).json.data.name, 'Distinctive Player Name');
  assert.strictEqual((await client(b, friend.cookie).get('/api/auth/me')).status, 200, 'sessions came back too');
  assert.strictEqual([...b.auth.users.values()].filter((u) => u.admin).length, 1, 'the admin is the restored one, not a new one');
  assert.ok(!/password:/.test(b.logs.join('\n')), 'no new admin password was made');
  assert.ok(!b.logs.join('\n').includes(gh.st.token));
});

test('GitHub snapshot: nothing is restored over an existing data folder', async (t) => {
  const gh = await mockGithub();
  t.after(() => gh.close());
  const a = await boot({ snapshot: snapOpts(gh) });
  await a.close();
  const before = gh.st.requests.length;
  const dir = tmp('cb-has-data-');
  fs.writeFileSync(path.join(dir, 'db.json'), JSON.stringify({ seq: 1, docs: { 'players/local': { data: { name: 'Local' }, version: 1, updatedAt: 'x' } } }));
  const b = await boot({ dataDir: dir, snapshot: snapOpts(gh) });
  t.after(() => b.close());
  assert.strictEqual(b.store.get('players/local').data.name, 'Local');
  assert.ok(!gh.st.requests.slice(before).some((r) => r.method === 'GET' && /contents/.test(r.path)), 'did not even ask for the backup');
});

test('GitHub snapshot: a wrong key or a tampered file is never overwritten', async (t) => {
  const gh = await mockGithub();
  t.after(() => gh.close());
  const a = await boot({ snapshot: snapOpts(gh) });
  await signup(a, 'keeper');
  await a.close();
  const file = 'site-backup:clashbets-snapshot.json';
  const original = gh.st.files.get(file).text;
  const putsBefore = gh.st.puts;

  const wrong = await boot({ snapshot: snapOpts(gh, { key: 'a-completely-different-key-9' }) });
  assert.match(wrong.logs.join('\n'), /COULD NOT RESTORE the backup/);
  assert.ok(!wrong.logs.join('\n').includes('a-completely-different-key-9'));
  assert.strictEqual(wrong.auth.userByName('keeper'), undefined, 'started fresh');
  await signup(wrong, 'newcomer');
  await wrong.close();
  assert.strictEqual(gh.st.puts, putsBefore, 'no push after a failed restore');
  assert.strictEqual(gh.st.files.get(file).text, original, 'the real backup is untouched');

  // flip one byte of the ciphertext
  const env = JSON.parse(original);
  const data = Buffer.from(env.data, 'base64');
  data[10] ^= 1;
  gh.st.files.get(file).text = JSON.stringify({ ...env, data: data.toString('base64') });
  const tampered = await boot({ snapshot: snapOpts(gh) });
  assert.match(tampered.logs.join('\n'), /COULD NOT RESTORE/);
  await tampered.close();
  assert.strictEqual(gh.st.puts, putsBefore);

  // hostile envelope parameters are refused rather than followed
  gh.st.files.get(file).text = JSON.stringify({ ...env, n: 1 << 30 });
  const hostile = await boot({ snapshot: snapOpts(gh) });
  assert.match(hostile.logs.join('\n'), /bad snapshot parameters/);
  await hostile.close();
});

test('GitHub snapshot: an unknown sha and a conflict are both retried', async (t) => {
  const gh = await mockGithub();
  t.after(() => gh.close());
  const a = await boot({ snapshot: snapOpts(gh) });
  await signup(a, 'first');
  await a.close();
  let puts = gh.st.puts;

  // a restored host does not know the file's sha: GitHub says 422 ("sha wasn't supplied"), we look it up and retry
  const b = await boot({ snapshot: snapOpts(gh) });
  await signup(b, 'second');
  await b.close();
  assert.strictEqual(gh.st.puts - puts, 2, 'one refused (422), one accepted');
  assert.match(b.logs.join('\n'), /backed up/);
  assert.ok(!/backup failed/.test(b.logs.join('\n')));
  puts = gh.st.puts;

  // somebody else changed the file in the meantime: 409, look up the sha again, retry
  const c = await boot({ dataDir: tmp('cb-fresh-'), snapshot: snapOpts(gh) });
  await signup(c, 'third');
  gh.st.conflictOnce = true;
  await c.close();
  assert.ok(gh.st.puts - puts >= 2, `retried after the conflict (${gh.st.puts - puts} puts)`);
  assert.ok(!/backup failed/.test(c.logs.join('\n')));

  const d = await boot({ dataDir: tmp('cb-fresh-'), snapshot: snapOpts(gh) });
  t.after(() => d.close());
  assert.ok(d.auth.userByName('first') && d.auth.userByName('second') && d.auth.userByName('third'), 'the retried push is what was stored');
});

test('GitHub snapshot: unchanged data is not pushed twice, and a dead network does not hang or crash', async (t) => {
  const gh = await mockGithub();
  const a = await boot({ snapshot: snapOpts(gh) });
  await signup(a, 'someone');
  const snap = a.persist.snapshot;
  a.persist.flush();
  // (a push may already be in flight from boot, carrying older data: keep going until there is nothing left to push)
  for (let i = 0; i < 5 && (await snap.pushNow()); i++);
  assert.ok(gh.st.puts >= 1);
  const puts = gh.st.puts;
  assert.strictEqual(await snap.pushNow(), false, 'same bytes, nothing to do');
  assert.strictEqual(gh.st.puts, puts);
  await signup(a, 'another');
  a.persist.flush();
  assert.strictEqual((await snap.pushNow()) || (await snap.pushNow()), true);
  assert.ok(gh.st.puts > puts);
  await a.close();
  await gh.close();
  // GitHub is gone: closing still finishes quickly and the data is safe on disk
  const b = await boot({ dataDir: a.dataDir, snapshot: snapOpts(gh) });
  await signup(b, 'third');
  const t0 = Date.now();
  await b.close();
  assert.ok(Date.now() - t0 < 15000);
  assert.match(b.logs.join('\n'), /backup failed|COULD NOT RESTORE/);
  assert.ok(readJson(a.dataDir, 'auth.json').users, 'local files are fine');
  void t;
});

test('GitHub snapshot: needs all three settings, a sane repo name and a long key', async () => {
  const logs = [];
  const log = (l) => logs.push(l);
  assert.strictEqual(GithubSnapshot.create({ log }), null);
  assert.strictEqual(logs.length, 0, 'not configured at all: silent');
  assert.strictEqual(GithubSnapshot.create({ repo: 'o/r', log }), null);
  assert.strictEqual(GithubSnapshot.create({ repo: 'o/r', token: 't', key: 'short', log }), null);
  assert.strictEqual(GithubSnapshot.create({ repo: 'o/r', token: 't', key: 'a'.repeat(23), log }), null, 'a 23-character key is still too short');
  assert.strictEqual(GithubSnapshot.create({ repo: 'not a repo', token: 't', key: 'a'.repeat(24), log }), null);
  assert.strictEqual(GithubSnapshot.create({ repo: '../x/y', token: 't', key: 'a'.repeat(24), log }), null);
  assert.strictEqual(GithubSnapshot.create({ repo: 'o/r', branch: 'bad branch;', token: 't', key: 'a'.repeat(24), log }), null);
  assert.strictEqual(logs.length, 6);
  assert.ok(GithubSnapshot.create({ repo: 'o/r', token: 't', key: 'a'.repeat(24), log }));
  assert.ok(logs.every((l) => !l.includes('aaaaaaaa')), 'the key is never echoed');
  // through the real server too: a half-configured backup is reported and ignored
  const app = await boot({ snapshot: { repo: 'o/r', token: 'x' } });
  assert.match(app.logs.join('\n'), /backup is off: it needs SNAPSHOT_REPO, SNAPSHOT_TOKEN and SNAPSHOT_KEY/);
  assert.strictEqual(app.persist.snapshot, null);
  await app.close();
});

test('GitHub snapshot settings are read from the environment, API base included', async (t) => {
  const gh = await mockGithub();
  t.after(() => gh.close());
  const app = await startServer({
    env: { SNAPSHOT_REPO: 'o/r', SNAPSHOT_BRANCH: 'from-env', SNAPSHOT_TOKEN: gh.st.token, SNAPSHOT_KEY: 'key-from-the-environment', SNAPSHOT_API_BASE: gh.url, SNAPSHOT_INTERVAL_MIN: '0' },
    port: 0, host: '127.0.0.1', dataDir: tmp('cb-env-'), publicDir: makePublic(), scryptN: 1024, importIntervalMin: 0, log: () => {},
  });
  await app.close();
  assert.ok(gh.st.files.has('from-env:clashbets-snapshot.json'));
});
