'use strict';

const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { createImporter } = require('../lib/importer');
const { Store } = require('../lib/store');
const lib = require('../../scripts/lib/battles');
const { boot, loginAdmin, makeUser, tmp } = require('./helper');

const REPO = path.join(__dirname, '..', '..');
const squad = JSON.parse(fs.readFileSync(path.join(REPO, 'squad.json'), 'utf8'));
const tagOf = (name) => squad.find((s) => s.name === name).tag;
const JAMIE = tagOf('jamie'), ZAC = tagOf('zac'), SEK = tagOf('sek');

const side = (tag, crowns, king, princess) => ({ tag, name: tag, crowns, kingTowerHitPoints: king, princessTowersHitPoints: princess, cards: [{ name: 'Knight', level: 11, maxLevel: 16 }] });
const stamp = (ms) => new Date(ms).toISOString().replace(/[-:]/g, '');
const battle = (ms, a, b, mode = 'Draft_Competitive') => {
  const time = stamp(ms);
  return { key: `${time}|${a.tag}|${b.tag}`, battleTime: time, type: 'friendly', gameMode: { name: mode }, team: a, opponent: b };
};
const HOUR = 3600e3, DAY = 24 * HOUR;

// a feed server with ETag support, counting what it was asked
function feedServer(initial) {
  const st = { body: initial, version: 1, requests: [], status: 200, headers: {} };
  const server = http.createServer((req, res) => {
    st.requests.push({ inm: req.headers['if-none-match'], ua: req.headers['user-agent'] });
    if (st.status !== 200) { res.writeHead(st.status, st.headers); return res.end('nope'); }
    const etag = `"v${st.version}"`;
    if (req.headers['if-none-match'] === etag) { res.writeHead(304); return res.end(); }
    res.writeHead(200, { 'Content-Type': 'application/json', ETag: etag, ...st.headers });
    res.end(typeof st.body === 'string' ? st.body : JSON.stringify(st.body));
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
    st, url: `http://127.0.0.1:${server.address().port}/battles.json`,
    set(body) { st.body = body; st.version++; },
    close: () => new Promise((r) => { server.close(r); server.closeAllConnections(); }),
  })));
}

function fixture() {
  const now = Date.now();
  const b1 = battle(now - 1 * DAY, side(JAMIE, 1, 4824, [3052, 900]), side(ZAC, 0, 4100, [3052]));
  const b2 = battle(now - 2 * DAY, side(ZAC, 2, 4824, [3052, 2000]), side(JAMIE, 1, 4000, [3052, 100]));
  const ladder = battle(now - 3 * HOUR, side(JAMIE, 1, 4824, [3052, 900]), side(ZAC, 0, 4100, [3052]), 'Ladder');
  const stranger = battle(now - 5 * HOUR, side(JAMIE, 1, 4824, [3052, 900]), side('#NOTINSQUAD', 0, 4100, [3052]));
  const old = battle(now - 9 * DAY, side(JAMIE, 3, 4824, [3052, 3052]), side(ZAC, 0, 4100, [3052]));
  const checked = { [JAMIE]: new Date(now - 60e3).toISOString(), [ZAC]: new Date(now - 60e3).toISOString() };
  return { b1, b2, feed: { updatedAt: new Date(now).toISOString(), players: {}, battles: [b1, b2, ladder, stranger, old], checked } };
}

async function world(t, feedBody, opts) {
  const feed = await feedServer(feedBody);
  t.after(() => feed.close());
  const app = await boot({ battlesUrl: feed.url, repoRoot: REPO, ...opts });
  t.after(() => app.close());
  const admin = await loginAdmin(app);
  await admin.set('players/jp', { name: 'Jamie', addedAt: '2026-01-01T00:00:00.000Z' }); // names match squad.json case-insensitively
  await admin.set('players/zp', { name: 'zac', addedAt: '2026-01-02T00:00:00.000Z' });
  await admin.set('players/sp', { name: 'Sek', addedAt: '2026-01-03T00:00:00.000Z' });
  return { app, admin, feed };
}

test('imports official results between squad players through the real daily-import script', async (t) => {
  const { b1, b2, feed: body } = fixture();
  const w = await world(t, body);
  const user = makeUser(w.app, 'watcher');
  const seq0 = w.app.store.seq;
  const run = await w.admin.post('/api/admin/import-now');
  assert.strictEqual(run.status, 200, run.text);
  assert.match(run.json.summary, /2 official results in the window, 2 new/);
  assert.match(run.json.summary, /New: jp \d-\d zp|New: zp \d-\d jp/);
  assert.match(run.json.summary, /Applied 3 writes/, '2 results and the coverage marker');
  assert.match(w.app.logs.join('\n'), /\[import\] 2 new results, 0 CHECK, 0 SKIPPED, 3 written/);

  const matches = w.app.store.list('matches');
  assert.strictEqual(matches.length, 2, 'the ladder game, the stranger and the week-old game were left out');
  const doc1 = w.app.store.get(`matches/${lib.docId(b1.key)}`), doc2 = w.app.store.get(`matches/${lib.docId(b2.key)}`);
  assert.ok(doc1 && doc2);
  assert.strictEqual(doc1.version, 1);
  assert.deepStrictEqual([doc1.data.playerA, doc1.data.playerB, doc1.data.crownsA, doc1.data.crownsB, doc1.data.winner], ['jp', 'zp', 1, 0, 'A']);
  assert.deepStrictEqual([doc2.data.playerA, doc2.data.playerB, doc2.data.crownsA, doc2.data.crownsB, doc2.data.winner], ['zp', 'jp', 2, 1, 'A']);
  assert.strictEqual(doc1.data.source, 'api');
  assert.strictEqual(doc1.data.loggedBy, 'api');
  assert.strictEqual(doc1.data.battleKey, b1.key);
  assert.ok(Math.abs(Date.parse(doc1.data.finalAt) - Date.now()) < 60e3, 'new results count as final from the moment they are imported');
  assert.strictEqual('id' in doc1.data, false);
  const state = w.app.store.get('config/importState');
  assert.deepStrictEqual(Object.keys(state.data.through).sort(), ['jp', 'zp']);
  assert.ok(Date.parse(state.data.ranAt) > 0);
  assert.ok(w.app.store.seq >= seq0 + 3, 'each write is a committed change');
  // everyone can see them straight away, through the normal change feed
  const feedNow = await user.client.get(`/api/changes?since=${seq0}`);
  assert.ok(feedNow.json.changes.some((c) => c.path === `matches/${lib.docId(b1.key)}`));
  // and it was saved
  w.app.persist.flush();
  assert.ok(fs.readFileSync(path.join(w.app.dataDir, 'db.json'), 'utf8').includes(lib.docId(b2.key)));
});

test('the second run asks with If-None-Match, gets 304 and does nothing', async (t) => {
  const { feed: body } = fixture();
  const w = await world(t, body);
  await w.admin.post('/api/admin/import-now');
  const seq = w.app.store.seq;
  const again = await w.admin.post('/api/admin/import-now');
  assert.strictEqual(again.status, 200);
  assert.match(again.json.summary, /has not changed/);
  assert.strictEqual(w.feed.st.requests.length, 2);
  assert.strictEqual(w.feed.st.requests[0].inm, undefined);
  assert.strictEqual(w.feed.st.requests[1].inm, '"v1"');
  assert.strictEqual(w.feed.st.requests[0].ua, 'clashbets-site');
  assert.strictEqual(w.app.store.seq, seq);
  // a changed feed is read again, and results already on the site are not touched or duplicated
  w.feed.set({ ...(typeof w.feed.st.body === 'string' ? JSON.parse(w.feed.st.body) : w.feed.st.body), updatedAt: '2026-10-07T10:00:00.000Z' });
  const third = await w.admin.post('/api/admin/import-now');
  assert.match(third.json.summary, /2 official results in the window, 0 new/);
  assert.strictEqual(w.app.store.list('matches').length, 2);
  for (const d of w.app.store.list('matches')) assert.strictEqual(d.version, 1, 'unchanged results keep their version');
});

test('a hand-logged result that is now official is replaced, using the versions the importer staged', async (t) => {
  const { b1, feed: body } = fixture();
  const w = await world(t, body);
  const played = Date.parse(lib.iso(b1.battleTime));
  const hand = { playerA: 'zp', playerB: 'jp', crownsA: 0, crownsB: 1, winner: 'B', towersA: { left: 3052, king: 4824, right: 0 }, towersB: { left: 900, king: 4824, right: 3052 },
    date: new Date(played + 5 * 60e3).toISOString(), loggedAt: new Date(played + 6 * 60e3).toISOString(), finalAt: new Date(played + 6 * 60e3).toISOString(), overtime: false, source: 'hand' };
  await w.admin.set('matches/h1', hand);
  await w.admin.set('matches/h1', { ...hand, notes: 'edited once, so version 2' });
  assert.strictEqual(w.app.store.get('matches/h1').version, 2);
  const run = await w.admin.post('/api/admin/import-now');
  assert.match(run.json.summary, /Merged matches\/h1 into cr_/);
  assert.match(run.json.summary, /Removed hand log h1 \(merged\)/);
  const h1 = w.app.store.get('matches/h1');
  assert.strictEqual(h1.version, 3, 'the hand log was marked deleted with an if_version of 2');
  assert.ok(h1.data.deletedAt);
  assert.match(h1.data.mergedInto, /^cr_/);
  assert.strictEqual(h1.data.notes, 'edited once, so version 2', 'marked, not erased');
  assert.strictEqual(w.app.store.list('matches').filter((d) => d.data.source === 'api').length, 2);
  // a result the admin deleted on the site stays deleted
  const official = w.app.store.list('matches').find((d) => d.data.source === 'api' && d.data.crownsA === 1);
  await w.admin.write('update', `matches/${official.id}`, { deletedAt: new Date().toISOString() });
  const v = w.app.store.get(`matches/${official.id}`).version;
  w.feed.set(w.feed.st.body);
  await w.admin.post('/api/admin/import-now');
  assert.strictEqual(w.app.store.get(`matches/${official.id}`).version, v, 'untouched');
});

test('a write whose document changed meanwhile is skipped and logged, and is retried next time', async (t) => {
  const root = tmp('cb-fake-repo-');
  fs.mkdirSync(path.join(root, 'scripts'));
  fs.writeFileSync(path.join(root, 'squad.json'), '[]');
  fs.writeFileSync(path.join(root, 'scripts', 'daily-import.js'), `
const fs = require('fs'), path = require('path');
const W = process.argv[2];
fs.mkdirSync(path.join(W, 'out'), { recursive: true });
fs.writeFileSync(path.join(W, 'out', 'a.json'), JSON.stringify({ n: 'applied' }));
fs.writeFileSync(path.join(W, 'out', 'b.json'), JSON.stringify({ n: 'stale' }));
fs.writeFileSync(path.join(W, 'out', 'c.json'), JSON.stringify({ n: 'fresh' }));
fs.writeFileSync(path.join(W, 'batch-1.json'), JSON.stringify([
  { op: 'set', collection: 'matches', doc_id: 'new1', file_path: path.join(W, 'out', 'a.json') },
  { op: 'set', collection: 'matches', doc_id: 'existing', file_path: path.join(W, 'out', 'b.json'), if_version: 99 },
  { op: 'set', collection: 'matches', doc_id: 'existing2', file_path: path.join(W, 'out', 'c.json'), if_version: 1 },
]));
console.log('New: fake result');
`);
  const feed = await feedServer({ battles: [] });
  t.after(() => feed.close());
  const store = new Store();
  store.write('set', 'matches/existing', { date: new Date().toISOString(), n: 'mine' });
  store.write('set', 'matches/existing2', { date: new Date().toISOString(), n: 'mine too' });
  const logs = [];
  const imp = createImporter({ store, repoRoot: root, battlesUrl: feed.url, intervalMin: 0, log: (l) => logs.push(l) });
  const r = await imp.runImport();
  assert.strictEqual(r.applied, 2);
  assert.strictEqual(r.skipped, 1);
  assert.match(r.summary, /SKIPPED write to matches\/existing: it changed on the site meanwhile/);
  assert.strictEqual(store.get('matches/new1').data.n, 'applied');
  assert.strictEqual(store.get('matches/existing').data.n, 'mine', 'the stale write changed nothing');
  assert.strictEqual(store.get('matches/existing2').data.n, 'fresh');
  assert.ok(logs.some((l) => /1 SKIPPED/.test(l)) && logs.some((l) => /SKIPPED write to matches\/existing/.test(l)));
  // because something was skipped, the feed is not treated as done: the next run fetches it again
  await imp.runImport();
  assert.strictEqual(feed.st.requests.length, 2);
  assert.strictEqual(feed.st.requests[1].inm, undefined);
});

test('only the writes the script is meant to make are applied, from files inside its work directory', async (t) => {
  const root = tmp('cb-fake-repo-');
  fs.mkdirSync(path.join(root, 'scripts'));
  fs.writeFileSync(path.join(root, 'squad.json'), '[]');
  fs.writeFileSync(path.join(root, 'scripts', 'daily-import.js'), `
const fs = require('fs'), path = require('path');
const W = process.argv[2];
fs.mkdirSync(path.join(W, 'out'), { recursive: true });
fs.writeFileSync(path.join(W, 'out', 'ok.json'), JSON.stringify({ n: 'ok' }));
fs.writeFileSync(path.join(W, 'out', 'proto.json'), '{"__proto__":{"x":1}}');
fs.writeFileSync(path.join(__dirname, '..', 'seen.json'), JSON.stringify({ dir: W, mode: fs.statSync(W).mode & 0o777, env: Object.keys(process.env), cwd: process.cwd(), files: fs.readdirSync(W).sort(), dbfiles: fs.existsSync(path.join(W, 'db')) ? fs.readdirSync(path.join(W, 'db')).sort() : [] }));
fs.writeFileSync(path.join(W, 'batch-1.json'), JSON.stringify([
  { op: 'set', collection: 'matches', doc_id: 'ok', file_path: path.join(W, 'out', 'ok.json') },
  { op: 'set', collection: 'players', doc_id: 'hacked', file_path: path.join(W, 'out', 'ok.json') },
  { op: 'set', collection: 'matches', doc_id: 'outside', file_path: path.join(__dirname, '..', 'squad.json') },
  { op: 'set', collection: 'matches', doc_id: 'passwd', file_path: '/etc/passwd' },
  { op: 'set', collection: 'matches', doc_id: 'dots', file_path: path.join(W, 'out', '..', '..', 'squad.json') },
  { op: 'delete', collection: 'matches', doc_id: 'ok' },
  { op: 'set', collection: 'matches', doc_id: '../escape', file_path: path.join(W, 'out', 'ok.json') },
  { op: 'set', collection: 'matches', doc_id: 'proto', file_path: path.join(W, 'out', 'proto.json') },
  { op: 'set', collection: 'config', doc_id: 'importState', file_path: path.join(W, 'out', 'ok.json') },
  null, 5, { op: 'set' },
]));
console.log('hello from the fake script');
`);
  const feed = await feedServer({ battles: [], checked: {} });
  t.after(() => feed.close());
  process.env.SNAPSHOT_TOKEN = 'must-not-leak'; process.env.ADMIN_PASSWORD = 'must-not-leak-either';
  const store = new Store();
  // a doc that the script is shown, to prove the staging layout
  store.write('set', 'players/pp', { name: 'x' });
  store.write('set', 'links/pp', { uid: 'u1', at: 'a', former: [] });
  const logs = [];
  let r;
  try { r = await createImporter({ store, repoRoot: root, battlesUrl: feed.url, intervalMin: 0, log: (l) => logs.push(l) }).runImport(); } finally { delete process.env.SNAPSHOT_TOKEN; delete process.env.ADMIN_PASSWORD; }
  assert.strictEqual(r.applied, 2, 'matches/ok and config/importState');
  assert.strictEqual(r.skipped, 10);
  assert.deepStrictEqual(store.list('matches').map((d) => d.id), ['ok']);
  assert.strictEqual(store.get('players/hacked'), undefined);
  assert.strictEqual(store.get('matches/outside'), undefined);
  assert.strictEqual(store.get('matches/passwd'), undefined);
  assert.strictEqual(store.get('matches/proto'), undefined, 'the store\'s own checks apply to imported documents too');
  assert.strictEqual(({}).x, undefined);
  assert.deepStrictEqual(store.get('config/importState').data, { n: 'ok' });
  const seen = JSON.parse(fs.readFileSync(path.join(root, 'seen.json'), 'utf8'));
  assert.strictEqual(seen.mode, 0o700, 'private work directory');
  assert.deepStrictEqual(seen.env, ['NODE_ENV'], 'the script sees none of the site\'s secrets');
  assert.strictEqual(path.dirname(seen.dir), require('os').tmpdir());
  assert.strictEqual(fs.existsSync(seen.dir), false, 'work directory deleted afterwards');
  assert.deepStrictEqual(seen.files, ['battles.json', 'db', 'out', 'squad.json', 'versions.json', 'window.json']); // out/ is the script's own
  assert.deepStrictEqual(seen.dbfiles, ['links', 'players']);
});

test('what the script is shown: the window, versions, links, players and people\'s own logs', async (t) => {
  const root = tmp('cb-fake-repo-');
  fs.mkdirSync(path.join(root, 'scripts'));
  fs.writeFileSync(path.join(root, 'squad.json'), '[{"tag":"#A","name":"x"}]');
  fs.writeFileSync(path.join(root, 'scripts', 'daily-import.js'), `
const fs = require('fs'), path = require('path');
const W = process.argv[2];
const ls = (d) => (fs.existsSync(path.join(W, d)) ? fs.readdirSync(path.join(W, d)).sort() : null);
fs.writeFileSync(path.join(__dirname, '..', 'seen.json'), JSON.stringify({
  window: JSON.parse(fs.readFileSync(path.join(W, 'window.json'), 'utf8')), versions: JSON.parse(fs.readFileSync(path.join(W, 'versions.json'), 'utf8')),
  squad: fs.readFileSync(path.join(W, 'squad.json'), 'utf8'), battles: fs.readFileSync(path.join(W, 'battles.json'), 'utf8'),
  players: ls('db/players'), matches: ls('db/matches'), links: ls('db/links'), acts: ls('db/acts'), actsItems: ls('db/acts/u_a/items'), actsB: ls('db/acts/u_b/items'),
  link: JSON.parse(fs.readFileSync(path.join(W, 'db/links/pp.json'), 'utf8')),
}));
`);
  const body = JSON.stringify({ battles: [{ key: 'k' }], odd: 'kept byte for byte' });
  const feed = await feedServer(body);
  t.after(() => feed.close());
  const store = new Store();
  const now = Date.now(), recent = new Date(now - 2 * DAY).toISOString(), old = new Date(now - 20 * DAY).toISOString();
  store.write('set', 'players/pp', { name: 'x' });
  store.write('set', 'players/pp2', { name: 'y' });
  store.write('set', 'links/pp', { uid: 'u_a', at: 'a', former: [] });
  store.write('set', 'matches/recent', { date: recent, playerA: 'pp' });
  store.write('set', 'matches/recent', { date: recent, playerA: 'pp', again: true });
  store.write('set', 'matches/old', { date: old });
  store.write('set', 'matches/nodate', { x: 1 });
  const hand = (date) => ({ type: 'match', playerA: 'pp', playerB: 'pp2', crownsA: 2, crownsB: 1, winner: 'A', date, loggedAt: date });
  store.write('set', 'acts/u_a/items/m1', hand(recent));
  store.write('set', 'acts/u_a/items/m-old', hand(old));
  store.write('set', 'acts/u_a/items/m-junk', { type: 'match', date: recent });
  store.write('set', 'acts/u_a/items/fixture', { type: 'fixture', date: recent });
  store.write('set', 'acts/u_b/items/m2', hand(recent));
  store.write('set', 'acts/u_b/other/m3', hand(recent));
  store.write('set', 'config/importState', { ranAt: 'x' });
  const before = Date.now();
  await createImporter({ store, repoRoot: root, battlesUrl: feed.url, intervalMin: 0 }).runImport();
  const seen = JSON.parse(fs.readFileSync(path.join(root, 'seen.json'), 'utf8'));
  assert.ok(Date.parse(seen.window.now) >= before - 1000 && Date.parse(seen.window.now) <= Date.now());
  assert.ok(Math.abs(Date.parse(seen.window.now) - Date.parse(seen.window.since) - 7 * DAY) < 5, 'a seven day window');
  assert.deepStrictEqual(seen.versions, { 'matches/recent': 2, 'config/importState': 1 });
  assert.strictEqual(seen.battles, body, 'the feed as received');
  assert.strictEqual(seen.squad, '[{"tag":"#A","name":"x"}]');
  assert.deepStrictEqual(seen.players, ['pp.json', 'pp2.json']);
  assert.deepStrictEqual(seen.matches, ['recent.json'], 'only results inside the window');
  assert.deepStrictEqual(seen.links, ['pp.json']);
  assert.deepStrictEqual(seen.acts.sort(), ['u_a', 'u_b']);
  assert.deepStrictEqual(seen.actsItems, ['m1.json'], 'only well-formed logged results inside the window');
  assert.deepStrictEqual(seen.actsB, ['m2.json']);
  assert.deepStrictEqual(seen.link, { uid: 'u_a', at: 'a', former: [] });
});

test('failures are reported, change nothing, and are retried', async (t) => {
  const { feed: body } = fixture();
  const w = await world(t, body);
  const seq = w.app.store.seq;
  // the feed is down
  w.feed.st.status = 503;
  let r = await w.admin.post('/api/admin/import-now');
  assert.strictEqual(r.status, 500);
  assert.match(r.json.error, /The import failed: The battles feed answered HTTP 503/);
  // not JSON, not an object
  w.feed.st.status = 200;
  for (const [bad, pattern] of [['not json', /expected shape/], ['[1,2]', /expected shape/], ['null', /expected shape/]]) {
    w.feed.set(bad);
    r = await w.admin.post('/api/admin/import-now');
    assert.strictEqual(r.status, 500, bad);
    assert.match(r.json.error, pattern);
  }
  // far too big, declared up front
  w.feed.st.headers = { 'Content-Length': String(40 * 1024 * 1024) };
  const big = await w.feed.st.requests.length;
  w.feed.st.body = 'x';
  r = await w.admin.post('/api/admin/import-now');
  assert.strictEqual(r.status, 500);
  void big;
  w.feed.st.headers = {};
  assert.strictEqual(w.app.store.seq, seq, 'nothing was written by any of that');
  assert.strictEqual(w.app.store.list('matches').length, 0);
  // the script itself fails (a broken squad.json): a clear message, no partial writes
  const root = tmp('cb-broken-repo-');
  fs.mkdirSync(path.join(root, 'scripts'));
  fs.writeFileSync(path.join(root, 'squad.json'), '[]');
  fs.writeFileSync(path.join(root, 'scripts', 'daily-import.js'), 'console.error("something exploded\\nsecond line"); process.exit(2);');
  const imp = createImporter({ store: new Store(), repoRoot: root, battlesUrl: w.feed.url, intervalMin: 0 });
  w.feed.set({ battles: [] });
  await assert.rejects(imp.runImport(), /daily-import\.js failed: something exploded$/);
  // a missing squad.json is an error too, and the work directory is still cleaned up
  const empty = tmp('cb-empty-repo-');
  await assert.rejects(createImporter({ store: new Store(), repoRoot: empty, battlesUrl: w.feed.url, intervalMin: 0 }).runImport(), /squad\.json/);
  // finally a good run still works after all that
  w.feed.set(body);
  r = await w.admin.post('/api/admin/import-now');
  assert.strictEqual(r.status, 200);
  assert.strictEqual(w.app.store.list('matches').length, 2);
});

test('simultaneous runs share one import', async (t) => {
  const { feed: body } = fixture();
  const w = await world(t, body);
  const results = await Promise.all([w.admin.post('/api/admin/import-now'), w.admin.post('/api/admin/import-now'), w.admin.post('/api/admin/import-now')]);
  assert.ok(results.every((r) => r.status === 200));
  assert.strictEqual(w.feed.st.requests.length, 1, 'one fetch for three requests');
  assert.strictEqual(w.app.store.list('matches').length, 2);
});

test('the timer: one run soon after boot, then every IMPORT_INTERVAL_MIN; 0 means never', async () => {
  const delays = [];
  const realSet = global.setTimeout, realInt = global.setInterval;
  global.setTimeout = (fn, ms, ...a) => { delays.push(['timeout', ms]); return realSet(() => {}, 0, ...a); };
  global.setInterval = (fn, ms, ...a) => { delays.push(['interval', ms]); return realInt(() => {}, 1e9, ...a); };
  try {
    const on = createImporter({ store: new Store(), repoRoot: REPO, battlesUrl: 'http://127.0.0.1:1/x', intervalMin: 20, log: () => {} });
    on.start();
    on.stop();
    const off = createImporter({ store: new Store(), repoRoot: REPO, battlesUrl: 'http://127.0.0.1:1/x', intervalMin: 0, log: () => {} });
    const none = createImporter({ store: new Store(), repoRoot: REPO, battlesUrl: '', intervalMin: 20, log: () => {} });
    const before = delays.length;
    off.start(); none.start();
    assert.strictEqual(delays.length, before, 'nothing scheduled when off or without a feed');
  } finally { global.setTimeout = realSet; global.setInterval = realInt; }
  assert.deepStrictEqual(delays.filter((d) => d[1] === 10000 || d[1] === 20 * 60e3), [['timeout', 10000], ['interval', 1200000]]);
  // a feed that cannot be reached is logged by the timer and never throws
  const logs = [];
  const dead = createImporter({ store: new Store(), repoRoot: REPO, battlesUrl: 'http://127.0.0.1:1/x', intervalMin: 20, log: (l) => logs.push(l) });
  await assert.rejects(dead.runImport());
  const noFeed = createImporter({ store: new Store(), repoRoot: REPO, battlesUrl: '', intervalMin: 0 });
  assert.match((await noFeed.runImport()).summary, /BATTLES_URL/);
});

test('the default feed address is the battle-data branch of the repo', () => {
  const { resolveConfig } = require('../server');
  assert.strictEqual(resolveConfig({ env: {} }).battlesUrl, 'https://raw.githubusercontent.com/noahsargeant858-alt/Clash-betting/battle-data/battles.json');
  assert.strictEqual(resolveConfig({ env: {} }).importIntervalMin, 5);
  assert.strictEqual(resolveConfig({ env: { BATTLES_URL: 'http://x/y', IMPORT_INTERVAL_MIN: '15' } }).importIntervalMin, 15);
  assert.strictEqual(resolveConfig({ env: { IMPORT_INTERVAL_MIN: '0' } }).importIntervalMin, 0);
});
