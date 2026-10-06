'use strict';

// The admin's one group link: /login#code=<the group code>. The server only hands it to the admin; the login page
// reads the code out of the #fragment (which never reaches a server), fills it in and wipes it from the address bar.

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
  assert.deepStrictEqual(r, { url: `http://127.0.0.1:${open.port}/login#create`, hasCode: false });
});

test('the login page reads the code from the link, strips odd characters, and ignores anything else', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'login.html'), 'utf8');
  const src = /function codeFromLink\(hash\) \{[\s\S]*?\n\}/.exec(html)[0];
  const read = new Function(`${src}; return codeFromLink;`)();
  assert.strictEqual(read('#code=' + encodeURIComponent(CODE)), CODE);
  assert.strictEqual(read('#code=gold'), 'gold');
  assert.strictEqual(read('#code=%20gold%20'), 'gold', 'trimmed');
  assert.strictEqual(read('#code=go%00l%0Ad'), 'gold', 'control characters dropped');
  assert.strictEqual(read('#code=' + 'x'.repeat(500)).length, 100, 'capped like the input box');
  for (const none of ['', '#', '#create', '#code=', '#code=%E0%A4%A', '#codex=gold', '#x&code=gold', '?code=gold']) assert.strictEqual(read(none), null, `ignored: ${none}`);
  // the page wipes the fragment, and so does the app (a signed-in person opening the link is sent there)
  assert.match(html, /history\.replaceState\(null, '', location\.pathname \+ location\.search\)/);
  const shim = fs.readFileSync(path.join(__dirname, '..', 'public', 'shim.js'), 'utf8');
  assert.match(shim, /\^#\(code=\|create\$\)/);
});
