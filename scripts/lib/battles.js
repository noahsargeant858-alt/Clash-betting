'use strict';

// Shared rules for turning official Clash Royale battles into ClashBets
// results and pairing them with results people logged by hand.

const P_HP = 3052, K_HP = 4824;

const normTag = (t) => '#' + String(t).trim().toUpperCase().replace(/^#/, '').replace(/O/g, '0');
const iso = (t) => t.replace(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(\.\d+)?Z$/, '$1-$2-$3T$4:$5:$6$7Z');
const docId = (battleKey) => 'cr_' + battleKey.replace(/[^A-Za-z0-9_.~:@+-]/g, '');

// squad tag -> site player id, matching squad.json names to the site's players
function playerMap(squad, players) {
  const idByName = Object.fromEntries(players.map((p) => [String(p.name).toLowerCase(), p.id]));
  const map = {};
  for (const s of squad) if (s.tag && idByName[s.name.toLowerCase()]) map[normTag(s.tag)] = idByName[s.name.toLowerCase()];
  return map;
}

// One battle shows up in both players' logs, the copies' times up to a second
// apart: same two players within 10 seconds with the score mirrored.
function sameBattle(x, y) {
  const pair = (b) => [b.team.tag, b.opponent.tag].sort().join();
  if (pair(x) !== pair(y) || Math.abs(Date.parse(iso(x.battleTime)) - Date.parse(iso(y.battleTime))) > 10000) return false;
  const [ya, yb] = x.team.tag === y.team.tag ? [y.team, y.opponent] : [y.opponent, y.team];
  return x.team.crowns === ya.crowns && x.opponent.crowns === yb.crowns;
}
function uniqueBattles(battles) {
  const out = [];
  for (const b of [...battles].sort((x, y) => x.battleTime.localeCompare(y.battleTime))) if (!out.some((o) => sameBattle(o, b))) out.push(b);
  return out;
}

const towersOf = (s) => {
  const pr = Array.isArray(s.princessTowersHitPoints) ? s.princessTowersHitPoints : [];
  return { left: pr[0] ?? 0, king: s.kingTowerHitPoints ?? 0, right: pr[1] ?? 0 };
};
const taken = (t) => P_HP - t.left + (P_HP - t.right) + (K_HP - t.king);
const lowest = (t) => Math.min(...[t.left, t.right, t.king].filter((h) => h > 0), Infinity);
const otPossible = (a, b) => Math.abs(a - b) === 1 || (Math.max(a, b) === 3 && Math.min(a, b) <= 1);

// One official battle -> a result, filling in everything the game's rules prove
function fromBattle(b, playerOf, finalAt) {
  const A = b.team, B = b.opponent;
  const tA = towersOf(A), tB = towersOf(B), cA = A.crowns, cB = B.crowns;
  let winner = cA > cB ? 'A' : cB > cA ? 'B' : null;
  if (!winner) { const lA = lowest(tA), lB = lowest(tB); winner = lA > lB ? 'A' : lB > lA ? 'B' : 'draw'; } // tiebreaker: healthiest weakest tower
  const overtime = cA === cB ? true : !otPossible(cA, cB) ? false : null;
  const dealtA = taken(tB), dealtB = taken(tA);
  const dmg = (dealt, crowns, other) => {
    if (dealt < 1000) return false;
    if (overtime === false) return true;
    if (overtime === true && Math.min(crowns, other) >= 1) return true; // crowns held when regulation ended
    return null;
  };
  return {
    playerA: playerOf[normTag(A.tag)], playerB: playerOf[normTag(B.tag)], crownsA: cA, crownsB: cB, winner, overtime,
    dmgA: dmg(dealtA, cA, cB), dmgB: dmg(dealtB, cB, cA),
    kingA: cB >= 1 || tA.king < K_HP, kingB: cA >= 1 || tB.king < K_HP, // losing a tower or taking damage wakes the King
    firstCrown: cA + cB === 0 ? 'none' : cB === 0 ? 'A' : cA === 0 ? 'B' : null,
    towersA: tA, towersB: tB, dealtA, dealtB,
    cardsA: (A.cards || []).map((c) => c.name), cardsB: (B.cards || []).map((c) => c.name),
    elixirLeakedA: A.elixirLeaked ?? null, elixirLeakedB: B.elixirLeaked ?? null,
    notes: '', date: iso(b.battleTime), finalAt: finalAt || iso(b.battleTime), hp: { princess: P_HP, king: K_HP },
    fx: null, source: 'api', battleKey: b.key, loggedBy: 'api',
  };
}
const officialResults = (battles, playerOf, finalAt) => uniqueBattles(battles)
  .filter((b) => playerOf[normTag(b.team.tag)] && playerOf[normTag(b.opponent.tag)] && /draft/i.test((b.gameMode && b.gameMode.name) || ''))
  .map((b) => fromBattle(b, playerOf, finalAt));

// ---------- pairing hand logs with official games ----------
const eqTowers = (x, y) => (x.king === y.king) + Math.max((x.left === y.left) + (x.right === y.right), (x.left === y.right) + (x.right === y.left));
const samePlayers = (x, y) => (x.playerA === y.playerA && x.playerB === y.playerB) || (x.playerA === y.playerB && x.playerB === y.playerA);
const towersOnly = (m, r) => !!(m.towersA && m.towersB && r.towersA && r.towersB) && (
  (eqTowers(m.towersA, r.towersA) + eqTowers(m.towersB, r.towersB) >= 5) || (eqTowers(m.towersA, r.towersB) + eqTowers(m.towersB, r.towersA) >= 5));

// How sure are we that hand log m is official game r? Same players and crowns,
// played up to 3 days before it was logged, scored by identical tower HP values.
function score(m, r) {
  let flip;
  if (m.playerA === r.playerA && m.playerB === r.playerB) flip = false;
  else if (m.playerA === r.playerB && m.playerB === r.playerA) flip = true;
  else return { s: -1 };
  const mc = flip ? [m.crownsB, m.crownsA] : [m.crownsA, m.crownsB];
  if (mc[0] !== r.crownsA || mc[1] !== r.crownsB) return { s: -1 };
  const played = Date.parse(r.date), logged = Date.parse(m.loggedAt || m.date);
  if (played > logged + 10 * 60e3 || played < logged - 72 * 3600e3) return { s: -1 };
  const mA = flip ? m.towersB : m.towersA, mB = flip ? m.towersA : m.towersB;
  return { s: mA && mB ? eqTowers(mA, r.towersA) + eqTowers(mB, r.towersB) : 0, flip, gap: logged - played };
}
// Tiebreakers: hand-logged level crowns show up officially with one extra crown for the winner
function tiebreakMatch(m, r) {
  if (m.crownsA !== m.crownsB || !['A', 'B'].includes(m.winner)) return null;
  const flip = m.playerA === r.playerB && m.playerB === r.playerA;
  if (!flip && !(m.playerA === r.playerA && m.playerB === r.playerB)) return null;
  const w = flip ? ({ A: 'B', B: 'A' })[m.winner] : m.winner, c = m.crownsA;
  const [wc, lc] = w === 'A' ? [r.crownsA, r.crownsB] : [r.crownsB, r.crownsA];
  if (r.winner !== w || wc !== c + 1 || lc !== c) return null;
  const gap = Date.parse(m.loggedAt || m.date) - Date.parse(r.date);
  return gap < -10 * 60e3 || gap > 3 * 3600e3 ? null : { flip, gap };
}
// Copy what only a human saw onto the official result
function absorb(r, m, flip) {
  const sw = (k) => (flip ? ({ A: 'B', B: 'A' }[k] || k) : k);
  if (r.overtime == null && m.overtime != null) r.overtime = m.overtime;
  if (r.firstCrown == null && m.firstCrown && m.firstCrown !== 'none') r.firstCrown = sw(m.firstCrown);
  for (const sd of ['A', 'B']) { const ms = flip ? (sd === 'A' ? 'B' : 'A') : sd; if (r['dmg' + sd] == null && m['dmg' + ms] != null) r['dmg' + sd] = m['dmg' + ms]; }
  if (m.notes) r.notes = m.notes;
}

// Pair hand logs (each {key, ...result}) with official results ({id: result}).
// Returns which were merged, which are second copies, mislabeled or unmatched.
function pairUp(handLogs, docs, isTaken = () => false) {
  const merged = [], duplicates = [], mislabeled = [], unmatched = [];
  const usedM = new Set(), usedR = new Map();
  for (const id of Object.keys(docs)) if (isTaken(id)) usedR.set(id, '(earlier)');
  const cands = [];
  for (const m of handLogs) for (const [id, r] of Object.entries(docs)) { const sc = score(m, r); if (sc.s >= 2) cands.push({ m, id, r, ...sc }); }
  cands.sort((x, y) => y.s - x.s || x.gap - y.gap);
  for (const c of cands) {
    if (usedM.has(c.m.key) || usedR.has(c.id)) continue;
    usedM.add(c.m.key); usedR.set(c.id, c.m.key);
    absorb(c.r, c.m, c.flip);
    merged.push({ key: c.m.key, into: c.id, how: `${c.s} of 6 tower values match` });
  }
  const tb = [];
  for (const m of handLogs) if (!usedM.has(m.key)) for (const [id, r] of Object.entries(docs)) { const t = tiebreakMatch(m, r); if (t) tb.push({ m, id, r, ...t }); }
  tb.sort((x, y) => x.gap - y.gap);
  for (const c of tb) {
    if (usedM.has(c.m.key) || usedR.has(c.id)) continue;
    usedM.add(c.m.key); usedR.set(c.id, c.m.key);
    c.r.overtime = true; c.r.tiebreaker = true; if (c.m.notes) c.r.notes = c.m.notes;
    merged.push({ key: c.m.key, into: c.id, how: `tiebreaker, logged ${Math.round(c.gap / 60e3)} min after` });
  }
  for (const m of handLogs) {
    if (usedM.has(m.key)) continue;
    const label = `${m.playerA} ${m.crownsA}-${m.crownsB} ${m.playerB}`;
    const twin = cands.find((c) => c.m.key === m.key);
    if (twin) { duplicates.push({ key: m.key, label, sameGameAs: usedR.get(twin.id), official: twin.id }); continue; }
    const copyOf = handLogs.find((o) => o.key !== m.key && usedM.has(o.key) && samePlayers(o, m) && towersOnly(o, m));
    if (copyOf) { duplicates.push({ key: m.key, label, sameGameAs: copyOf.key }); continue; }
    const wrong = Object.entries(docs).find(([, r]) => towersOnly(m, r));
    if (wrong) mislabeled.push({ key: m.key, label, official: `${wrong[1].playerA} ${wrong[1].crownsA}-${wrong[1].crownsB} ${wrong[1].playerB}`, officialId: wrong[0] });
    else unmatched.push({ key: m.key, label, date: m.date });
  }
  return { merged, duplicates, mislabeled, unmatched };
}

module.exports = { normTag, iso, docId, playerMap, uniqueBattles, officialResults, pairUp };
