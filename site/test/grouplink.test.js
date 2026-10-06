'use strict';

// The admin's one group link: /login#code=<the group code>. The server only hands it to the admin; the login page
// reads the code out of the #fragment (which never reaches a server) and fills it in. The code stays in the address bar
// until the account is made, so a reload or "Open in Safari/Chrome" from a chat app's browser keeps it.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { boot, client, loginAdmin, makeUser, cookieOf } = require('./helper');

const CODE = 'Hog Rider #1 / 100%';

test('only the admin gets the group link, with the code safely encoded in the #fragment', async (t) => {
  const app = await boot({ signupCode: CODE });
  t.after(() => app.close());
  const admin = await loginAdmin(app);
  const r = await admin.get('/api/admin/group-link');
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.headers['cache-control'], 'no-store');
  assert.strictEqual(r.json.hasCode, true);
  const url = new URL(r.json.url);
  assert.strictEqual(url.origin, `http://127.0.0.1:${app.port}`);
  assert.strictEqual(url.pathname, '/login');
  assert.strictEqual(url.search, '', 'nothing in the query string, which would be sent to the server and logged');
  assert.ok(url.hash.startsWith('#code='));
  assert.strictEqual(decodeURIComponent(url.hash.slice(6)), CODE);
  assert.ok(!/[\s#%/]/.test(url.hash.slice(6).replace(/%[0-9A-F]{2}/g, '')), 'every awkward character is percent-encoded');

  // nobody else can read it
  const friend = makeUser(app, 'friend');
  assert.strictEqual((await friend.client.get('/api/admin/group-link')).status, 403);
  const anon = await client(app).get('/api/admin/group-link');
  assert.ok(anon.status === 401 || anon.status === 403, `anonymous: ${anon.status}`);
  assert.ok(!anon.text.includes('Hog'), 'and the code is not in the refusal');
  // and the public config still only says whether there is a code
  assert.deepStrictEqual((await client(app).get('/api/auth/config')).json, { siteName: 'ClashBets', signupCode: true });

  // what the page would send after decoding the link makes a real account
  const made = await client(app).post('/api/auth/signup', { username: 'linkmate', password: 'correct horse 1', code: decodeURIComponent(url.hash.slice(6)) });
  assert.strictEqual(made.status, 200);
  assert.ok(cookieOf(made));
});

test('the group link uses PUBLIC_URL when set, and is the plain sign-up page when there is no code', async (t) => {
  const withUrl = await boot({ signupCode: 'gold', publicUrl: 'https://clashbets.example' });
  t.after(() => withUrl.close());
  assert.strictEqual((await (await loginAdmin(withUrl)).get('/api/admin/group-link')).json.url, 'https://clashbets.example/login#code=gold');
  const open = await boot({ signupCode: '' });
  t.after(() => open.close());
  const r = (await (await loginAdmin(open)).get('/api/admin/group-link')).json;
  assert.deepStrictEqual(r, { url: `http://127.0.0.1:${open.port}/login#create`, hasCode: false, tooLong: false });
});

test('the login page reads the code from the link, strips odd characters, and ignores anything else', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'login.html'), 'utf8');
  const src = /function codeFromLink\(hash\) \{[\s\S]*?\n\}/.exec(html)[0];
  const read = new Function(`${src}; return codeFromLink;`)();
  assert.strictEqual(read('#code=' + encodeURIComponent(CODE)), CODE);
  assert.strictEqual(read('#code=gold'), 'gold');
  assert.strictEqual(read('#code=%20gold%20'), 'gold', 'trimmed');
  assert.strictEqual(read('#code=go%00l%0Ad'), 'gold', 'control characters dropped');
  assert.strictEqual(read('#code=' + 'x'.repeat(500)).length, 200, 'capped like the input box');
  assert.match(html, /id="up-code"[^>]*maxlength="200"/);
  for (const none of ['', '#', '#create', '#code=', '#code=%E0%A4%A', '#codex=gold', '#x&code=gold', '?code=gold']) assert.strictEqual(read(none), null, `ignored: ${none}`);
  // the login page keeps the fragment (a reload must still have the code) and reacts when it changes in an open tab;
  // the app drops it (a signed-in person opening the link is sent there)
  const script = html.split('<script>')[1];
  assert.ok(!/replaceState/.test(script), 'the login page never wipes the code before sign-up');
  assert.match(script, /addEventListener\('hashchange', applyLinkCode\)/);
  const shim = fs.readFileSync(path.join(__dirname, '..', 'public', 'shim.js'), 'utf8');
  assert.match(shim, /\^#\(code=\|create\$\)/);
});

test('codes ending in punctuation survive chat apps: the link always ends in a letter, digit or %XX', async (t) => {
  for (const code of ['letsgo!', 'clash.', "rider'", 'king*', 'ok~', 'hog-', 'gold (2)', 'a.b-c!d']) {
    const app = await boot({ signupCode: code });
    t.after(() => app.close());
    const url = (await (await loginAdmin(app)).get('/api/admin/group-link')).json.url;
    const frag = url.split('#code=')[1];
    assert.match(frag, /^(?:[A-Za-z0-9_]|%[0-9A-F]{2})+$/, `${code} -> ${frag}`);
    assert.strictEqual(decodeURIComponent(frag), code);
    const made = await client(app).post('/api/auth/signup', { username: 'p' + Math.abs([...code].reduce((h, c) => (h * 31 + c.charCodeAt(0)) | 0, 7)).toString(36).slice(0, 10), password: 'correct horse 1', code: decodeURIComponent(frag) });
    assert.strictEqual(made.status, 200, code);
  }
});

test('a SIGNUP_CODE with stray spaces is trimmed, and an over-long one is flagged to the admin', async (t) => {
  const { resolveConfig } = require('../server');
  assert.strictEqual(resolveConfig({ env: { SIGNUP_CODE: '  gold \n' } }).signupCode, 'gold');
  const app = await boot({ env: { SIGNUP_CODE: ' gold ' } });
  t.after(() => app.close());
  const r = (await (await loginAdmin(app)).get('/api/admin/group-link')).json;
  assert.strictEqual(r.url, `http://127.0.0.1:${app.port}/login#code=gold`);
  assert.strictEqual(r.tooLong, false);
  assert.strictEqual((await client(app).post('/api/auth/signup', { username: 'spacey', password: 'correct horse 1', code: 'gold' })).status, 200);
  const long = await boot({ signupCode: 'y'.repeat(201) });
  t.after(() => long.close());
  assert.strictEqual((await (await loginAdmin(long)).get('/api/admin/group-link')).json.tooLong, true);
  assert.ok(long.logs.some((l) => /longer than 200 characters/.test(l)));
});
