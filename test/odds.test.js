'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { buildMarkets, settleSelection, toFractional, orientPair } = require('../lib/odds');
const { draftBattles, normaliseTag } = require('../lib/clash-api');

const players = [{ id: 'a', name: 'Ann' }, { id: 'b', name: 'Bob' }];
let n = 0;
const match = (o) => ({ id: 'm' + n++, date: '2026-01-01T00:00:00Z', playerA: 'a', playerB: 'b', nameA: 'Ann', nameB: 'Bob',
  overtime: null, dmgA: null, dmgB: null, firstCrown: null, cardsA: [], cardsB: [], ...o });

const marketSum = (book, key) => book.markets.find((m) => m.key === key).selections.reduce((t, s) => t + s.p, 0);

test('every complete market sums to 100% probability', () => {
  const book = buildMarkets('a', 'b', [], players);
  for (const key of ['result', 'method', 'margin', 'overtime', 'dmgA', 'first', 'total2.5', 'btts']) {
    assert.ok(Math.abs(marketSum(book, key) - 1) < 1e-9, `${key} sums to ${marketSum(book, key)}`);
  }
});

test('no data → evens-ish match result', () => {
  const book = buildMarkets('a', 'b', [], players, { margin: 0 });
  const [a, d, b] = book.markets[0].selections;
  assert.ok(Math.abs(a.p - b.p) < 1e-9);
  assert.ok(d.p < 0.1);
});

test('dominant head-to-head record moves the odds', () => {
  const ms = Array.from({ length: 12 }, () => match({ crownsA: 3, crownsB: 0, winner: 'A', overtime: false }));
  const book = buildMarkets('a', 'b', ms, players);
  const res = book.markets.find((m) => m.key === 'result').selections;
  assert.ok(res[0].p > 0.8, 'Ann should be a heavy favourite');
  const method = book.markets.find((m) => m.key === 'method').selections;
  const a3 = method.find((s) => s.key === 'A3'), a1 = method.find((s) => s.key === 'A1');
  assert.ok(a3.p > a1.p, '3-crown should be likelier than 1-crown for Ann');
  // Orientation flips cleanly
  const flipped = buildMarkets('b', 'a', ms, players);
  assert.ok(Math.abs(flipped.markets[0].selections[2].p - res[0].p) < 1e-9);
});

test('margin makes the book overround', () => {
  const book = buildMarkets('a', 'b', [], players, { margin: 10 });
  const implied = book.markets[0].selections.reduce((t, s) => t + 1 / s.decimal, 0);
  assert.ok(implied > 1.05 && implied < 1.15, `implied ${implied}`);
});

test('settlement', () => {
  const o = orientPair(match({ crownsA: 1, crownsB: 2, winner: 'B', overtime: true, dmgA: true, dmgB: true, firstCrown: 'A' }), 'a');
  assert.strictEqual(settleSelection('result', 'B', o), true);
  assert.strictEqual(settleSelection('method', 'B2', o), true);
  assert.strictEqual(settleSelection('margin', 'B1', o), true);
  assert.strictEqual(settleSelection('score', 'B:1-2', o), true);
  assert.strictEqual(settleSelection('score', 'A:1-2', o), false);
  assert.strictEqual(settleSelection('btts', 'yes', o), true);
  assert.strictEqual(settleSelection('total2.5', 'over', o), true);
  assert.strictEqual(settleSelection('first', 'A', o), true);
  // Seen from Bob's side everything flips
  const ob = orientPair(match({ crownsA: 1, crownsB: 2, winner: 'B' }), 'b');
  assert.strictEqual(settleSelection('result', 'A', ob), true);
  // Unknown data → void
  assert.strictEqual(settleSelection('overtime', 'yes', ob), null);
  // Tiebreaker
  const tb = orientPair(match({ crownsA: 1, crownsB: 1, winner: 'A' }), 'a');
  assert.strictEqual(settleSelection('method', 'ATB', tb), true);
  assert.strictEqual(settleSelection('method', 'A1', tb), false);
});

test('fractional odds look like a bookie wrote them', () => {
  assert.strictEqual(toFractional(2), '1/1');
  assert.strictEqual(toFractional(3.5), '5/2');
  assert.strictEqual(toFractional(1.5), '1/2');
  assert.strictEqual(toFractional(11), '10/1');
});

test('tag normalisation', () => {
  assert.strictEqual(normaliseTag(' #2ppoylq '), '#2PP0YLQ');
  assert.strictEqual(normaliseTag('hello!'), null);
});

test('battlelog filter keeps only 1v1 draft friendlies', () => {
  const p = (tag, crowns) => ({ tag, name: tag, crowns, cards: [{ name: 'Hog Rider' }] });
  const log = [
    { type: 'friendly', battleTime: '20261003T163800.000Z', gameMode: { name: 'Friendly_TripleDraft' }, team: [p('#A', 3)], opponent: [p('#B', 1)] },
    { type: 'PvP', battleTime: '20261003T160000.000Z', gameMode: { name: 'Ladder' }, team: [p('#A', 1)], opponent: [p('#C', 0)] },
    { type: 'friendly', battleTime: '20261003T150000.000Z', gameMode: { name: 'Friendly' }, team: [p('#A', 1)], opponent: [p('#B', 0)] },
    { type: 'friendly', battleTime: '20261003T140000.000Z', gameMode: { name: 'TeamVsTeam_TripleDraft' }, team: [p('#A', 1), p('#D', 1)], opponent: [p('#B', 0), p('#E', 0)] },
  ];
  const out = draftBattles(log);
  assert.strictEqual(out.length, 1);
  assert.deepStrictEqual([out[0].tagA, out[0].crownsA, out[0].tagB, out[0].crownsB, out[0].date], ['#A', 3, '#B', 1, '2026-10-03T16:38:00Z']);
});
