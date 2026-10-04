'use strict';

const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const fs = require('fs');

process.env.DB_FILE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'clashbets-')), 'db.json');
delete process.env.CR_API_TOKEN;
const { server } = require('../server');

test('end to end: players, bet, match, settlement', async (t) => {
  await new Promise((r) => server.listen(0, r));
  t.after(() => server.close());
  const base = `http://localhost:${server.address().port}`;
  const call = async (method, url, body) => {
    const res = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  };

  const ann = (await call('POST', '/api/players', { name: 'Ann' })).body;
  const bob = (await call('POST', '/api/players', { name: 'Bob' })).body;
  assert.strictEqual(ann.coins, 1000);

  const odds = (await call('GET', `/api/odds?a=${ann.id}&b=${bob.id}`)).body;
  const sel = odds.markets.find((m) => m.key === 'method').selections.find((s) => s.key === 'A3');

  const bet = (await call('POST', '/api/bets', { bettor: bob.id, a: ann.id, b: bob.id, market: 'method', selection: 'A3', stake: 100 })).body;
  assert.strictEqual(bet.odds, sel.decimal);
  const ot = (await call('POST', '/api/bets', { bettor: bob.id, a: ann.id, b: bob.id, market: 'overtime', selection: 'yes', stake: 100 })).body;

  const tooBig = await call('POST', '/api/bets', { bettor: ann.id, a: ann.id, b: bob.id, market: 'result', selection: 'A', stake: 5000 });
  assert.strictEqual(tooBig.status, 400);

  // Bob logs the match from his own side: Bob 0 – 3 Ann
  const m = (await call('POST', '/api/matches', { playerA: bob.id, playerB: ann.id, crownsA: 0, crownsB: 3 })).body;
  assert.strictEqual(m.winner, 'B');
  assert.strictEqual(m.firstCrown, 'B');

  let st = (await call('GET', '/api/state')).body;
  const won = st.bets.find((b) => b.id === bet.id), voided = st.bets.find((b) => b.id === ot.id);
  assert.strictEqual(won.status, 'won');
  assert.strictEqual(voided.status, 'void'); // overtime wasn't recorded
  assert.strictEqual(st.players.find((p) => p.id === bob.id).coins, 800 + Math.round(100 * bet.odds) + 100);

  // Deleting the match reopens the bets and claws the coins back
  await call('DELETE', `/api/matches/${m.id}`);
  st = (await call('GET', '/api/state')).body;
  assert.strictEqual(st.players.find((p) => p.id === bob.id).coins, 800);
  assert.ok(st.bets.every((b) => b.status === 'open'));

  const bad = await call('POST', '/api/matches', { playerA: ann.id, playerB: bob.id, crownsA: 3, crownsB: 3 });
  assert.strictEqual(bad.status, 400);
});

test('squad.json tags are all valid and load once', () => {
  const { loadSquad, db } = require('../server');
  const squad = require('../squad.json');
  const before = db.data.players.length;
  assert.strictEqual(loadSquad(), squad.length);
  assert.strictEqual(loadSquad(), 0);
  assert.strictEqual(db.data.players.length, before + squad.length);
  assert.ok(db.data.players.some((p) => p.id === '#9Q0L20PL2' && p.name === 'sek'));
  assert.ok(db.data.players.some((p) => p.id === '#8GQQ9YC2' && p.name === 'Nizz'));
  assert.ok(db.data.players.some((p) => p.name === 'rishi'));
});
