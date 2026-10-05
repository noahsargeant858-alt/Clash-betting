'use strict';

const test = require('node:test');
const assert = require('node:assert');
const lib = require('../scripts/lib/battles');

const side = (tag, crowns, king, princess) => ({ tag, name: tag, crowns, kingTowerHitPoints: king, princessTowersHitPoints: princess, cards: [] });
const battle = (time, a, b) => ({ key: `${time}|${a.tag}|${b.tag}`, battleTime: time, gameMode: { name: 'Draft_Competitive' }, team: a, opponent: b });
const playerOf = { '#AAA': 'ann', '#BBB': 'bob' };

test('one battle seen from both players a second apart counts once', () => {
  const x = battle('20261004T132415.000Z', side('#AAA', 0, 4824, [3052]), side('#BBB', 1, 4824, [2000, 3052]));
  const y = battle('20261004T132416.000Z', side('#BBB', 1, 4824, [2000, 3052]), side('#AAA', 0, 4824, [3052]));
  const z = battle('20261004T140000.000Z', side('#AAA', 1, 4824, [3052, 3052]), side('#BBB', 0, 4824, [3052]));
  assert.strictEqual(lib.uniqueBattles([x, y, z]).length, 2);
});

test('official battle becomes a result with what the rules prove', () => {
  const [r] = lib.officialResults([battle('20261004T120000.000Z', side('#AAA', 2, 4824, [3052]), side('#BBB', 0, 4824, null))], playerOf, '2026-10-05T09:00:00.000Z');
  assert.deepStrictEqual([r.playerA, r.playerB, r.crownsA, r.crownsB, r.winner], ['ann', 'bob', 2, 0, 'A']);
  assert.strictEqual(r.overtime, false); // a 2-0 can't finish in sudden-death overtime
  assert.strictEqual(r.firstCrown, 'A');
  assert.strictEqual(r.kingB, true); // lost a tower, so the King woke
  assert.strictEqual(r.dealtA, 6104);
  assert.strictEqual(r.finalAt, '2026-10-05T09:00:00.000Z');
});

test('hand logs pair with their official game, including tiebreakers', () => {
  const docs = Object.fromEntries(lib.officialResults([
    battle('20261004T120000.000Z', side('#AAA', 1, 4824, [3052, 900]), side('#BBB', 0, 4100, [3052])),
    battle('20261004T130000.000Z', side('#AAA', 0, 4824, [3052]), side('#BBB', 1, 4824, [47, 3052])),
  ], playerOf).map((r) => [lib.docId(r.battleKey), r]));
  const hand = [
    { key: 'h1', playerA: 'bob', playerB: 'ann', crownsA: 0, crownsB: 1, winner: 'B', towersA: { left: 3052, king: 4824, right: 0 }, towersB: { left: 900, king: 4824, right: 3052 }, date: '2026-10-04T12:05:00.000Z', overtime: false },
    { key: 'h2', playerA: 'ann', playerB: 'bob', crownsA: 0, crownsB: 0, winner: 'B', towersA: { left: 10, king: 4824, right: 3052 }, towersB: { left: 20, king: 4824, right: 3052 }, date: '2026-10-04T13:02:00.000Z' },
    { key: 'h3', playerA: 'bob', playerB: 'ann', crownsA: 0, crownsB: 1, winner: 'B', towersA: { left: 3052, king: 4824, right: 0 }, towersB: { left: 900, king: 4824, right: 3052 }, date: '2026-10-04T18:00:00.000Z' },
  ];
  const p = lib.pairUp(hand, docs);
  assert.deepStrictEqual(p.merged.map((x) => x.key).sort(), ['h1', 'h2']);
  assert.deepStrictEqual(p.duplicates.map((x) => x.key), ['h3']);
  const tb = Object.values(docs).find((r) => r.date.startsWith('2026-10-04T13'));
  assert.strictEqual(tb.tiebreaker, true);
  assert.strictEqual(tb.overtime, true);
});

test('daily import: an official game replaces the hand log without rewriting history', () => {
  const fs = require('fs'), os = require('os'), path = require('path'), { execFileSync } = require('child_process');
  const W = fs.mkdtempSync(path.join(os.tmpdir(), 'import-'));
  const put = (f, v) => { fs.mkdirSync(path.dirname(path.join(W, f)), { recursive: true }); fs.writeFileSync(path.join(W, f), JSON.stringify(v)); };
  put('battles.json', { battles: [battle('20261004T120000.000Z', side('#AAA', 1, 4824, [3052, 900]), side('#BBB', 0, 4100, [3052]))] });
  put('squad.json', [{ tag: '#AAA', name: 'ann' }, { tag: '#BBB', name: 'bob' }]);
  put('db/players/ann.json', { name: 'ann' }); put('db/players/bob.json', { name: 'bob' });
  const hand = { playerA: 'bob', playerB: 'ann', crownsA: 0, crownsB: 1, winner: 'B', towersA: { left: 3052, king: 4824, right: 0 }, towersB: { left: 900, king: 4824, right: 3052 },
    date: '2026-10-04T12:05:00.000Z', loggedAt: '2026-10-04T12:06:00.000Z', finalAt: '2026-10-04T12:06:00.000Z', fx: 'admin~f1', overtime: false };
  put('db/matches/h1.json', hand);
  put('db/matches/old.json', { ...hand, date: '2026-10-04T12:30:00.000Z', deletedAt: '2026-10-04T13:00:00.000Z' });
  put('versions.json', { 'matches/h1': 3, 'matches/old': 2 });
  put('window.json', { since: '2026-09-28T00:00:00.000Z', now: '2026-10-05T08:54:00.000Z' });
  execFileSync(process.execPath, [path.join(__dirname, '../scripts/daily-import.js'), W], { stdio: 'pipe' });
  const writes = JSON.parse(fs.readFileSync(path.join(W, 'batch-1.json'), 'utf8'));
  const body = (w) => JSON.parse(fs.readFileSync(w.file_path, 'utf8'));
  const official = writes.find((w) => w.doc_id.startsWith('cr_')), gone = writes.find((w) => w.doc_id === 'h1');
  assert.strictEqual(writes.length, 2); // the already-deleted log is left alone
  assert.deepStrictEqual([body(official).fx, body(official).loggedAt, body(official).finalAt], ['admin~f1', '2026-10-04T12:06:00.000Z', '2026-10-05T08:54:00.000Z']);
  assert.strictEqual(gone.op, 'set'); // marked deleted, never erased
  assert.strictEqual(gone.if_version, 3);
  assert.deepStrictEqual([body(gone).deletedAt, body(gone).mergedInto, body(gone).crownsB], ['2026-10-05T08:54:00.000Z', official.doc_id, 1]);
  fs.rmSync(W, { recursive: true, force: true });
});

test('daily import: only the players\' own, untouched logs can attach a fixture', () => {
  const fs = require('fs'), os = require('os'), path = require('path'), { execFileSync } = require('child_process');
  const run = (logs, extra = {}) => {
    const W = fs.mkdtempSync(path.join(os.tmpdir(), 'import-'));
    const put = (f, v) => { fs.mkdirSync(path.dirname(path.join(W, f)), { recursive: true }); fs.writeFileSync(path.join(W, f), JSON.stringify(v)); };
    put('battles.json', { battles: [battle('20261004T120000.000Z', side('#AAA', 1, 4824, [3052, 900]), side('#BBB', 0, 4100, [3052]))] });
    put('squad.json', [{ tag: '#AAA', name: 'ann' }, { tag: '#BBB', name: 'bob' }]);
    put('db/players/ann.json', { name: 'ann' }); put('db/players/bob.json', { name: 'bob' });
    put('db/links/ann.json', { uid: 'u_ann', at: '2026-10-01T00:00:00.000Z' }); put('db/links/bob.json', { uid: 'u_bob', at: '2026-10-01T00:00:00.000Z' });
    for (const [uid, id, log] of logs) put(`db/acts/${uid}/items/${id}.json`, log);
    for (const [id, doc] of Object.entries(extra)) put(`db/matches/${id}.json`, doc);
    put('window.json', { since: '2026-09-28T00:00:00.000Z', now: '2026-10-05T08:54:00.000Z' });
    execFileSync(process.execPath, [path.join(__dirname, '../scripts/daily-import.js'), W], { stdio: 'pipe' });
    const writes = JSON.parse(fs.readFileSync(path.join(W, 'batch-1.json'), 'utf8'));
    const doc = JSON.parse(fs.readFileSync(writes.find((w) => w.doc_id.startsWith('cr_')).file_path, 'utf8'));
    fs.rmSync(W, { recursive: true, force: true });
    return doc;
  };
  const log = { type: 'match', playerA: 'ann', playerB: 'bob', crownsA: 1, crownsB: 0, winner: 'A', towersA: { left: 3052, king: 4100, right: 3052 }, towersB: { left: 3052, king: 4824, right: 900 },
    date: '2026-10-04T12:04:00.000Z', loggedAt: '2026-10-04T12:04:00.000Z', fx: 'u_ann~f1' };
  assert.strictEqual(run([['u_ann', 'm1', log]]).fx, 'u_ann~f1');
  assert.strictEqual(run([['u_kim', 'm1', log]]).fx, null); // not one of the players
  assert.strictEqual(run([['u_ann', 'm1', { ...log, loggedAt: '+002026-10-04T11:00:00.000Z' }]]).fx, null); // odd timestamp
  assert.strictEqual(run([['u_ann', 'm1', log]], { r1: { ref: 'u_ann~m1', deletedAt: '2026-10-04T13:00:00.000Z', date: '2026-10-04T12:04:00.000Z' } }).fx, null); // admin overruled it
  assert.strictEqual(run([['u_ann', 'm1', { ...log, loggedAt: '2026-10-04T11:50:00.000Z' }]]).loggedAt, '2026-10-04T12:00:00.000Z'); // never before the game
});

test('daily import: records how far the official log is complete for each player', () => {
  const fs = require('fs'), os = require('os'), path = require('path'), { execFileSync } = require('child_process');
  const W = fs.mkdtempSync(path.join(os.tmpdir(), 'import-'));
  const put = (f, v) => { fs.mkdirSync(path.dirname(path.join(W, f)), { recursive: true }); fs.writeFileSync(path.join(W, f), JSON.stringify(v)); };
  put('battles.json', { battles: [], checked: { '#AAA': '2026-10-05T07:23:00.000Z', '#BBB': '2026-10-05T07:23:01.000Z', '#ZZZ': '2026-10-05T07:23:02.000Z' } });
  put('squad.json', [{ tag: '#AAA', name: 'ann' }, { tag: '#BBB', name: 'bob' }]);
  put('db/players/ann.json', { name: 'ann' }); put('db/players/bob.json', { name: 'bob' });
  put('versions.json', { 'config/importState': 4 });
  put('window.json', { since: '2026-09-28T00:00:00.000Z', now: '2026-10-05T08:54:00.000Z' });
  execFileSync(process.execPath, [path.join(__dirname, '../scripts/daily-import.js'), W], { stdio: 'pipe' });
  const [w] = JSON.parse(fs.readFileSync(path.join(W, 'batch-1.json'), 'utf8'));
  assert.deepStrictEqual([w.collection, w.doc_id, w.if_version], ['config', 'importState', 4]);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(w.file_path, 'utf8')), { ranAt: '2026-10-05T08:54:00.000Z', through: { ann: '2026-10-05T07:23:00.000Z', bob: '2026-10-05T07:23:01.000Z' } });
  fs.rmSync(W, { recursive: true, force: true });
});
