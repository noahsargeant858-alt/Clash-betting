'use strict';

// Daily import, run by a scheduled Claude session. Works out what to write to
// the ClashBets database from the official battles, without touching anything
// older than the window. It never writes to the site itself; it produces batch
// files the session applies, plus a summary.
//
//   node scripts/daily-import.js <work-dir>
//
// <work-dir> holds:
//   battles.json, squad.json            from GitHub
//   db/players/<id>.json                 the site's players
//   db/matches/<id>.json                 the site's results dated within the window
//   db/acts/<uid>/items/<id>.json        (if any) players' own logged results in the window
//   versions.json                        {"matches/<id>": version} for the window's results
//   window.json                          {"since": ISO, "now": ISO}
// Writes <work-dir>/batch-1.json, batch-2.json ... (max 50 writes each) and summary.txt

const fs = require('fs');
const path = require('path');
const lib = require('./lib/battles');

const W = process.argv[2];
if (!W) { console.error('usage: node scripts/daily-import.js <work-dir>'); process.exit(1); }
const read = (f) => JSON.parse(fs.readFileSync(path.join(W, f), 'utf8'));
const readDir = (d) => (fs.existsSync(path.join(W, d)) ? fs.readdirSync(path.join(W, d)).filter((f) => f.endsWith('.json')) : [])
  .map((f) => ({ id: f.slice(0, -5), ...JSON.parse(fs.readFileSync(path.join(W, d, f), 'utf8')) }));

const { since, now } = read('window.json');
const versions = fs.existsSync(path.join(W, 'versions.json')) ? read('versions.json') : {};
const players = readDir('db/players');
const playerOf = lib.playerMap(read('squad.json'), players);
const existing = readDir('db/matches');
const existingIds = new Set(existing.map((m) => m.id));

// Official results in the window; new ones count as final from now, so bets
// placed before this import are judged on the odds they actually saw.
// Results the admin deleted on the site stay deleted and are never touched.
const deletedIds = new Set(existing.filter((m) => typeof m.deletedAt === 'string').map((m) => m.id));
const official = {};
for (const r of lib.officialResults(read('battles.json').battles || [], playerOf, now)) {
  const id = lib.docId(r.battleKey);
  if (r.date >= since && !deletedIds.has(id)) official[id] = r;
}

// Results people logged: the admin's (in matches) and players' own (in acts)
const handLogs = existing.filter((m) => m.source !== 'api' && typeof m.playerA === 'string' && !m.deletedAt).map((m) => ({ ...m, key: 'matches/' + m.id }));
const actsRoot = path.join(W, 'db/acts');
if (fs.existsSync(actsRoot)) {
  for (const uid of fs.readdirSync(actsRoot)) {
    for (const x of readDir(`db/acts/${uid}/items`)) if (x.type === 'match' && typeof x.playerA === 'string') handLogs.push({ ...x, key: `acts/${uid}~${x.id}`, actsKey: `${uid}~${x.id}` });
  }
}

// Official results already on the site keep their data; only a fresh hand log can add to them
const alreadyRef = (id) => existingIds.has(id) && !!(existing.find((m) => m.id === id) || {}).ref;
const docs = {};
for (const [id, r] of Object.entries(official)) docs[id] = existingIds.has(id) ? { ...r, ...existing.find((m) => m.id === id), id: undefined } : r;
const pairs = lib.pairUp(handLogs, docs, alreadyRef);

const writes = [], log = [];
fs.mkdirSync(path.join(W, 'out'), { recursive: true });
// each result to save goes in its own file; batch entries point at it, so nothing is retyped
const saveDoc = (id, r) => { const f = path.resolve(W, 'out', id + '.json'); fs.writeFileSync(f, JSON.stringify(r)); return f; };
const changedIds = new Set();
const conflicts = new Set();
for (const p of pairs.merged) {
  const r = docs[p.into], m = handLogs.find((h) => h.key === p.key), isNew = !existingIds.has(p.into);
  // a result already on the site may gain missing details, but never a second fixture or a new "final" time
  if (m.fx && r.fx && r.fx !== m.fx) { conflicts.add(p.key); log.push(`CHECK: ${p.key} looks like ${p.into}, but they belong to different fixtures. Left both in place.`); continue; }
  if (m.fx && !r.fx) r.loggedAt = m.loggedAt || m.finalAt || m.date; // still counts as logged in time for its fixture
  if (m.fx) r.fx = m.fx;
  if (m.actsKey) r.ref = m.actsKey; // the official record replaces the player's log, keeping its fixture so bets settle
  else if (m.ref && !r.ref) r.ref = m.ref;
  // a new official record enters the odds from now, the moment the log it replaces leaves them
  if (isNew) r.finalAt = now;
  changedIds.add(p.into);
  log.push(`Merged ${p.key} into ${p.into} (${p.how})`);
}
for (const [id, r] of Object.entries(docs)) {
  delete r.id;
  if (!existingIds.has(id)) { writes.push({ op: 'set', collection: 'matches', doc_id: id, file_path: saveDoc(id, r) }); log.push(`New: ${r.playerA} ${r.crownsA}-${r.crownsB} ${r.playerB} (${r.date})`); }
  else if (changedIds.has(id)) {
    const v = versions['matches/' + id];
    if (v) writes.push({ op: 'set', collection: 'matches', doc_id: id, file_path: saveDoc(id, r), if_version: v });
    else log.push(`SKIPPED update of ${id}: no version known`);
  }
}
// The admin's own hand logs that are now inside an official result (or second copies) are
// marked deleted, not erased, so the odds bets were placed at can still be rebuilt;
// players' logs stay where they are and are simply replaced via ref.
for (const x of [...pairs.merged, ...pairs.duplicates]) {
  if (!x.key.startsWith('matches/') || conflicts.has(x.key)) continue;
  const id = x.key.slice('matches/'.length), v = versions[x.key];
  const { id: _id, key: _key, ...m } = handLogs.find((h) => h.key === x.key);
  const gone = { ...m, deletedAt: now, ...(x.into ? { mergedInto: x.into } : {}) };
  if (v) { writes.push({ op: 'set', collection: 'matches', doc_id: id, file_path: saveDoc(id, gone), if_version: v }); log.push(`Removed hand log ${id} (${x.into ? 'merged' : 'second copy'})`); }
  else log.push(`SKIPPED removing ${id}: no version known`);
}
for (const x of pairs.mislabeled) log.push(`CHECK: hand log ${x.key} "${x.label}" has the tower HP of official "${x.official}". Left in place for the admin to look at.`);
for (const x of pairs.unmatched) log.push(`Kept hand log ${x.key} "${x.label}": no official match (yet)`);

for (const f of fs.readdirSync(W)) if (/^batch-\d+\.json$/.test(f)) fs.unlinkSync(path.join(W, f));
for (let i = 0; i < writes.length; i += 50) fs.writeFileSync(path.join(W, `batch-${i / 50 + 1}.json`), JSON.stringify(writes.slice(i, i + 50), null, 1));
const summary = [`Window ${since} to ${now}`, `${Object.keys(official).length} official results in the window, ${writes.filter((w) => w.op === 'set' && !w.if_version).length} new`, ...log].join('\n');
fs.writeFileSync(path.join(W, 'summary.txt'), summary + '\n');
console.log(summary);
console.log(`${Math.ceil(writes.length / 50)} batch file(s), ${writes.length} writes.`);
