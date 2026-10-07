'use strict';

// Live results: with the Clash API key set, the site reads everyone's battle log itself (through the RoyaleAPI
// proxy), so a finished game shows up in a minute or two instead of waiting for the GitHub sync. GitHub's copy
// stays as a backup. The key never leaves the server.

const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { boot, loginAdmin, client, tmp } = require('./helper');

const TOKEN = 'live-test-token-1234567890';
const squad = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'squad.json'), 'utf8')).filter((p) => p.tag);
const [P1, P2] = squad; // two squad members with tags
const stamp = (ms) => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, '.000Z');
const side = (p, crowns) => ({ tag: p.tag, name: p.name, crowns, kingTowerHitPoints: 4824, princessTowersHitPoints: crowns ? [3052, 1200] : [3052], elixirLeaked: 1.5, cards: [] });
// one finished friendly between P1 and P2, as the API shows it in each player's log
const game = (minsAgo, aWins) => ({ type: 'clanMate', battleTime: stamp(Date.now() - minsAgo * 60e3), gameMode: { id: 72000194, name: 'Draft_Competitive' },
  team: [side(aWins ? P1 : P2, 1)], opponent: [side(aWins ? P2 : P1, 0)] });

function servers() {
  const logs = new Map();
  const add = (g) => { for (const [me, them] of [[g.team[0], g.opponent[0]], [g.opponent[0], g.team[0]]]) { if (!logs.has(me.tag)) logs.set(me.tag, []); logs.get(me.tag).push({ ...g, team: [me], opponent: [them] }); } };
  const clash = http.createServer((req, res) => {
    clash.auth = req.headers.authorization;
    if (req.headers.authorization !== `Bearer ${clash.token || TOKEN}`) { res.writeHead(403, { 'Content-Type': 'application/json' }); return res.end('{"reason":"accessDenied"}'); }
    const m = /^\/players\/([^/]+)\/battlelog$/.exec(req.url);
    res.writeHead(m ? 200 : 404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(m ? (logs.get(decodeURIComponent(m[1])) || []) : {}));
  }).listen(0);
  // GitHub's copy: an older game only
  const gh = { battles: [] };
  const github = http.createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'application/json', ETag: '"v1"' }); res.end(JSON.stringify(gh)); }).listen(0);
  return { clash, github, add, gh, close: () => { clash.close(); github.close(); } };
}

async function siteWith(s, extra = {}) {
  const app = await boot({ crApiToken: TOKEN, crApiBase: `http://127.0.0.1:${s.clash.address().port}`, battlesUrl: `http://127.0.0.1:${s.github.address().port}/b.json`, ...extra });
  for (const p of squad) app.store.write('set', `players/${p.name.toLowerCase()}`, { name: p.name.toLowerCase() });
  return app;
}
const results = (app) => app.store.list('matches').map((d) => d.data).filter((m) => m.source === 'api');

test('a game in the Clash battle log reaches the site without GitHub, and nothing new means no work', async (t) => {
  const s = servers(); t.after(() => s.close());
  const app = await siteWith(s); t.after(() => app.close());
  s.add(game(3, true));
  const admin = await loginAdmin(app);
  const r = await admin.post('/api/admin/import-now');
  assert.strictEqual(r.status, 200, r.text);
  assert.strictEqual(results(app).length, 1, 'the game GitHub has not seen yet is on the site');
  assert.strictEqual(r.json.live.on, true);
  assert.strictEqual(r.json.live.failed, 0);
  assert.ok(r.json.live.at);
  assert.strictEqual(s.clash.auth, `Bearer ${TOKEN}`, 'the key goes to Clash in the header');
  // again with nothing new: no import run at all
  const again = await admin.post('/api/admin/import-now');
  assert.match(again.json.summary, /No new games/);
  assert.strictEqual(results(app).length, 1);
  // the next game shows up on the next read
  s.add(game(1, false));
  await admin.post('/api/admin/import-now');
  assert.strictEqual(results(app).length, 2);
  // what it read is kept for restarts (the API only remembers ~25 battles a player)
  const kept = JSON.parse(fs.readFileSync(path.join(app.dataDir, 'live-battles.json'), 'utf8'));
  assert.strictEqual(kept.battles.length, 2);
  // the key is in no response and no log line
  const st = await admin.get('/api/admin/import-status');
  assert.strictEqual(st.json.live.on, true);
  for (const text of [r.text, again.text, st.text, app.logs.join('\n')]) assert.ok(!text.includes(TOKEN), 'the key never leaks');
  // only the admin sees the status
  assert.strictEqual((await client(app).get('/api/admin/import-status')).status, 403);
});

test('a wrong key or Clash being down falls back to GitHub\'s copy and says why', async (t) => {
  const s = servers(); t.after(() => s.close());
  s.clash.token = 'some-other-key';
  const g = game(90, true); s.gh.battles = [{ key: `${g.battleTime}|${[P1.tag, P2.tag].sort().join('|')}`, battleTime: g.battleTime, type: 'clanMate', gameMode: g.gameMode, team: g.team[0], opponent: g.opponent[0] }];
  const app = await siteWith(s); t.after(() => app.close());
  const admin = await loginAdmin(app);
  const r = await admin.post('/api/admin/import-now');
  assert.strictEqual(r.status, 200, r.text);
  assert.strictEqual(results(app).length, 1, 'GitHub\'s game still came in');
  assert.match(r.json.live.error, /HTTP 403/);
  assert.match(r.json.live.error, /45\.79\.218\.79/, 'the hint names the IP the key must allow');
  assert.ok(app.logs.some((l) => /\[live\]/.test(l)));
  assert.ok(!app.logs.join('\n').includes(TOKEN));
});

test('without a key the site works as before (GitHub only), and the timer reads live every 2 minutes with one', async (t) => {
  const s = servers(); t.after(() => s.close());
  const plain = await boot({ battlesUrl: `http://127.0.0.1:${s.github.address().port}/b.json` }); t.after(() => plain.close());
  const st = await (await loginAdmin(plain)).get('/api/admin/import-status');
  assert.deepStrictEqual(st.json.live, { on: false });
  const { resolveConfig } = require('../server');
  const c = resolveConfig({ env: { CR_API_TOKEN: '  abc  ' } });
  assert.strictEqual(c.crApiToken, 'abc');
  assert.strictEqual(c.crApiBase, 'https://proxy.royaleapi.dev/v1');
  assert.strictEqual(c.liveEverySec, 120);
  // live mode's timer: every liveEverySec (at least 30 s), not every IMPORT_INTERVAL_MIN
  const { createImporter } = require('../lib/importer');
  const { Store } = require('../lib/store');
  const delays = [];
  const realSet = global.setTimeout, realInt = global.setInterval;
  global.setTimeout = (fn, ms, ...a) => { delays.push(['timeout', ms]); return realSet(() => {}, 0, ...a); };
  global.setInterval = (fn, ms, ...a) => { delays.push(['interval', ms]); return realInt(() => {}, 1e9, ...a); };
  try {
    const imp = createImporter({ store: new Store(), repoRoot: path.join(__dirname, '..', '..'), battlesUrl: 'http://127.0.0.1:1/x', intervalMin: 5, live: { pull: async () => ({ battles: [], checked: {} }), status: () => ({}) }, liveEverySec: 120 });
    imp.start(); imp.stop();
  } finally { global.setTimeout = realSet; global.setInterval = realInt; }
  assert.ok(delays.some((d) => d[0] === 'interval' && d[1] === 120000), JSON.stringify(delays));
  void tmp;
});
