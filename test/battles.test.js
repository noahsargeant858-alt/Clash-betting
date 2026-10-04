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
