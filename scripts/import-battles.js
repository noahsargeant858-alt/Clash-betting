'use strict';

// Turns the official battles saved by the sync (battles.json) into ClashBets
// results, and lines up hand-logged results with the official ones.
//
//   node scripts/import-battles.js <battles.json> <matches.json> <players.json> <out-dir>
//
// matches.json: the site's current `matches` docs [{id, ...}]
// players.json: the site's `players` docs [{id, name}]
// Writes <out-dir>/docs/<id>.json (one per result to save), plan.json and
// a readable report. Nothing is written to the site by this script.

const fs = require('fs');
const path = require('path');

const [BATTLES, MATCHES, PLAYERS, OUT] = process.argv.slice(2);
const P_HP = 3052, K_HP = 4824;
const squad = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'squad.json'), 'utf8'));
const players = JSON.parse(fs.readFileSync(PLAYERS, 'utf8'));
const manual = JSON.parse(fs.readFileSync(MATCHES, 'utf8'));
const { battles } = JSON.parse(fs.readFileSync(BATTLES, 'utf8'));

// squad tag -> site player id (matched by name)
const idByName = Object.fromEntries(players.map((p) => [String(p.name).toLowerCase(), p.id]));
const playerOf = {};
for (const s of squad) if (s.tag && idByName[s.name.toLowerCase()]) playerOf[s.tag] = idByName[s.name.toLowerCase()];

const iso = (t) => t.replace(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(\.\d+)?Z$/, '$1-$2-$3T$4:$5:$6$7Z');
const towersOf = (s) => {
  const pr = Array.isArray(s.princessTowersHitPoints) ? s.princessTowersHitPoints : [];
  return { left: pr[0] ?? 0, king: s.kingTowerHitPoints ?? 0, right: pr[1] ?? 0 };
};
const taken = (t) => P_HP - t.left + (P_HP - t.right) + (K_HP - t.king);
const lowest = (t) => Math.min(...[t.left, t.right, t.king].filter((h) => h > 0), Infinity);
const otPossible = (a, b) => Math.abs(a - b) === 1 || (Math.max(a, b) === 3 && Math.min(a, b) <= 1);
const towerKey = (t) => [t.left, t.right].sort((x, y) => x - y).concat(t.king).join(',');

// One official battle -> a result, filling in everything the game's rules prove
function fromBattle(b) {
  const A = b.team, B = b.opponent;
  const tA = towersOf(A), tB = towersOf(B), cA = A.crowns, cB = B.crowns;
  let winner = cA > cB ? 'A' : cB > cA ? 'B' : null;
  if (!winner) { const lA = lowest(tA), lB = lowest(tB); winner = lA > lB ? 'A' : lB > lA ? 'B' : 'draw'; } // tiebreaker: healthiest weakest tower
  const level = cA === cB;
  const overtime = level ? true : !otPossible(cA, cB) ? false : null;
  const dealtA = taken(tB), dealtB = taken(tA);
  const dmg = (dealt, crowns, other) => {
    if (dealt < 1000) return false;
    if (overtime === false) return true;
    if (overtime === true && Math.min(crowns, other) >= 1) return true; // crowns held when regulation ended
    return null;
  };
  return {
    playerA: playerOf[A.tag], playerB: playerOf[B.tag], crownsA: cA, crownsB: cB, winner, overtime,
    dmgA: dmg(dealtA, cA, cB), dmgB: dmg(dealtB, cB, cA),
    kingA: cB >= 1 || tA.king < K_HP, kingB: cA >= 1 || tB.king < K_HP, // losing a tower or taking damage wakes the King
    firstCrown: cA + cB === 0 ? 'none' : cB === 0 ? 'A' : cA === 0 ? 'B' : null,
    towersA: tA, towersB: tB, dealtA, dealtB,
    cardsA: (A.cards || []).map((c) => c.name), cardsB: (B.cards || []).map((c) => c.name),
    elixirLeakedA: A.elixirLeaked ?? null, elixirLeakedB: B.elixirLeaked ?? null,
    notes: '', date: iso(b.battleTime), finalAt: iso(b.battleTime), hp: { princess: P_HP, king: K_HP },
    fx: null, source: 'api', battleKey: b.key, loggedBy: 'api',
  };
}

// How sure are we that hand log m is official game r? -1 = can't be.
// Same players and crowns, played up to 3 days before it was logged, scored by
// how many of the six tower HP values are identical (left/right may be swapped).
const eqTowers = (x, y) => (x.king === y.king) + Math.max((x.left === y.left) + (x.right === y.right), (x.left === y.right) + (x.right === y.left));
function score(m, r) {
  let flip;
  if (m.playerA === r.playerA && m.playerB === r.playerB) flip = false;
  else if (m.playerA === r.playerB && m.playerB === r.playerA) flip = true;
  else return { s: -1 };
  const mc = flip ? [m.crownsB, m.crownsA] : [m.crownsA, m.crownsB];
  if (mc[0] !== r.crownsA || mc[1] !== r.crownsB) return { s: -1 };
  const played = Date.parse(r.date), logged = Date.parse(m.date);
  if (played > logged + 10 * 60e3 || played < logged - 72 * 3600e3) return { s: -1 };
  const mA = flip ? m.towersB : m.towersA, mB = flip ? m.towersA : m.towersB;
  const s = mA && mB ? eqTowers(mA, r.towersA) + eqTowers(mB, r.towersB) : 0;
  return { s, flip, gap: logged - played };
}
const samePlayers = (x, y) => (x.playerA === y.playerA && x.playerB === y.playerB) || (x.playerA === y.playerB && x.playerB === y.playerA);
const towersOnly = (m, r) => m.towersA && m.towersB && (
  (eqTowers(m.towersA, r.towersA) + eqTowers(m.towersB, r.towersB) >= 5) || (eqTowers(m.towersA, r.towersB) + eqTowers(m.towersB, r.towersA) >= 5));

// One battle can be saved twice (once from each player's log, times a second
// apart): same two players within 10 seconds with the score mirrored.
const when = (t) => Date.parse(iso(t));
const sameBattle = (x, y) => {
  const pair = (b) => [b.team.tag, b.opponent.tag].sort().join();
  if (pair(x) !== pair(y) || Math.abs(when(x.battleTime) - when(y.battleTime)) > 10000) return false;
  const [ya, yb] = x.team.tag === y.team.tag ? [y.team, y.opponent] : [y.opponent, y.team];
  return x.team.crowns === ya.crowns && x.opponent.crowns === yb.crowns;
};
const unique = [];
for (const b of [...battles].sort((x, y) => x.battleTime.localeCompare(y.battleTime))) if (!unique.some((o) => sameBattle(o, b))) unique.push(b);

const results = unique
  .filter((b) => playerOf[b.team.tag] && playerOf[b.opponent.tag] && /draft/i.test((b.gameMode && b.gameMode.name) || ''))
  .map(fromBattle);

const docs = {}, merged = [], duplicates = [], mislabeled = [], unmatched = [], notes = [];
for (const r of results) docs['cr_' + r.battleKey.replace(/[^A-Za-z0-9_.~:@+-]/g, '')] = r;

// Pair hand logs with official games, most certain first, one-to-one
const cands = [];
for (const m of manual) for (const [id, r] of Object.entries(docs)) { const sc = score(m, r); if (sc.s >= 2) cands.push({ m, id, r, ...sc }); }
cands.sort((x, y) => y.s - x.s || x.gap - y.gap);
const usedM = new Set(), usedR = new Map();
for (const c of cands) {
  if (usedM.has(c.m.id) || usedR.has(c.id)) continue;
  usedM.add(c.m.id); usedR.set(c.id, c.m.id);
  const { m, r, flip } = c, sw = (k) => (flip ? ({ A: 'B', B: 'A' }[k] || k) : k);
  // keep what only a human saw, where the official record can't say
  if (r.overtime == null && m.overtime != null) r.overtime = m.overtime;
  if (r.firstCrown == null && m.firstCrown && m.firstCrown !== 'none') r.firstCrown = sw(m.firstCrown);
  for (const sd of ['A', 'B']) { const ms = flip ? (sd === 'A' ? 'B' : 'A') : sd; if (r['dmg' + sd] == null && m['dmg' + ms] != null) r['dmg' + sd] = m['dmg' + ms]; }
  if (m.notes) r.notes = m.notes;
  merged.push({ manual: m.id, into: c.id, towersMatching: c.s });
}
// Tiebreakers: a game hand-logged with level crowns shows up officially with one
// extra crown for the winner. Pair those by players, winner and timing, and
// record that the game went to overtime (a tiebreaker always does).
const tbCands = [];
for (const m of manual) {
  if (usedM.has(m.id) || m.crownsA !== m.crownsB || !['A', 'B'].includes(m.winner)) continue;
  for (const [id, r] of Object.entries(docs)) {
    if (usedR.has(id)) continue;
    const flip = m.playerA === r.playerB && m.playerB === r.playerA;
    if (!flip && !(m.playerA === r.playerA && m.playerB === r.playerB)) continue;
    const w = flip ? ({ A: 'B', B: 'A' })[m.winner] : m.winner, c = m.crownsA;
    const [wc, lc] = w === 'A' ? [r.crownsA, r.crownsB] : [r.crownsB, r.crownsA];
    if (r.winner !== w || wc !== c + 1 || lc !== c) continue;
    const gap = Date.parse(m.date) - Date.parse(r.date);
    if (gap < -10 * 60e3 || gap > 3 * 3600e3) continue;
    tbCands.push({ m, id, r, flip, gap });
  }
}
tbCands.sort((x, y) => x.gap - y.gap);
for (const c of tbCands) {
  if (usedM.has(c.m.id) || usedR.has(c.id)) continue;
  usedM.add(c.m.id); usedR.set(c.id, c.m.id);
  c.r.overtime = true; c.r.tiebreaker = true;
  if (c.m.notes) c.r.notes = c.m.notes;
  merged.push({ manual: c.m.id, into: c.id, towersMatching: 'tiebreaker', minutesAfter: Math.round(c.gap / 60e3) });
}

// Hand logs left over: a second copy of a game already matched, the right towers
// under the wrong players, or nothing like any official game
for (const m of manual) {
  if (usedM.has(m.id)) continue;
  const twin = cands.find((c) => c.m.id === m.id);
  if (twin) { duplicates.push({ manual: m.id, logged: `${m.playerA} ${m.crownsA}-${m.crownsB} ${m.playerB}`, sameGameAs: usedR.get(twin.id), official: twin.id }); continue; }
  // the same towers typed in again for a game another hand log already matched
  const copyOf = manual.find((o) => o.id !== m.id && usedM.has(o.id) && samePlayers(o, m) && towersOnly(o, m));
  if (copyOf) { duplicates.push({ manual: m.id, logged: `${m.playerA} ${m.crownsA}-${m.crownsB} ${m.playerB}`, sameGameAs: copyOf.id }); continue; }
  const wrongPair = Object.entries(docs).find(([, r]) => towersOnly(m, r));
  if (wrongPair) mislabeled.push({ manual: m.id, logged: `${m.playerA} ${m.crownsA}-${m.crownsB} ${m.playerB}`, official: `${wrongPair[1].playerA} ${wrongPair[1].crownsA}-${wrongPair[1].crownsB} ${wrongPair[1].playerB}`, officialId: wrongPair[0] });
  else unmatched.push({ manual: m.id, logged: `${m.playerA} ${m.crownsA}-${m.crownsB} ${m.playerB}`, date: m.date });
}


fs.mkdirSync(path.join(OUT, 'docs'), { recursive: true });
for (const [id, r] of Object.entries(docs)) fs.writeFileSync(path.join(OUT, 'docs', id + '.json'), JSON.stringify(r));
const plan = { write: Object.keys(docs), deleteMerged: merged.map((x) => x.manual), deleteDuplicates: duplicates.map((x) => x.manual), deleteMislabeled: mislabeled.map((x) => x.manual), keep: unmatched.map((x) => x.manual) };
fs.writeFileSync(path.join(OUT, 'plan.json'), JSON.stringify({ plan, merged, duplicates, mislabeled, unmatched, notes }, null, 1));
console.log(`Official results: ${results.length}`);
console.log(`Hand logs merged into an official result: ${merged.length} (towers matching: ${merged.map((x) => x.towersMatching).join(' ')})`);
console.log(`Hand logs that are a second copy of a game already merged: ${duplicates.length}`);
duplicates.forEach((x) => console.log(`  ${x.manual}: "${x.logged}" (same game as ${x.sameGameAs})`));
console.log(`Hand logs whose tower HP matches an official game between different players: ${mislabeled.length}`);
mislabeled.forEach((x) => console.log(`  ${x.manual}: logged "${x.logged}", official "${x.official}"`));
console.log(`Hand logs with no official match: ${unmatched.length}`);
unmatched.forEach((x) => console.log(`  ${x.manual}: "${x.logged}" ${x.date}`));
notes.forEach((n) => console.log('NOTE ' + n));
