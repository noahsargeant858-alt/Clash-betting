'use strict';

// The odds engine. Everything is Bayesian smoothing: each probability starts
// from a sensible prior (what usually happens in a triple draft friendly) and
// gets pulled towards the real data as more matches are logged. Few matches →
// odds stay close to the prior; lots of matches → the data takes over.

const PRIORS = {
  drawRate: 0.04, drawStrength: 25,
  winStrength: 6,          // pseudo-games at 50% added to each player's record
  h2hStrength: 4,          // how many pseudo-games the overall model is worth vs head-to-head
  trophyScale: 1500,       // Elo-style scale for the trophy prior (triple draft is random, so it's weak)
  trophyWeight: 0.35,
  // How many crowns the winner gets (0 = won on tiebreaker with no towers)
  winnerCrowns: { 0: 0.02, 1: 0.28, 2: 0.35, 3: 0.35 }, crownStrength: 10, playerCrownStrength: 8,
  // Loser crowns given winner crowns. Equal crowns = tiebreaker win.
  loserCrowns: {
    0: { 0: 1 },
    1: { 0: 0.9, 1: 0.1 },
    2: { 0: 0.6, 1: 0.35, 2: 0.05 },
    3: { 0: 0.55, 1: 0.35, 2: 0.1 },
  },
  loserStrength: 8,
  drawCrowns: { 0: 0.55, 1: 0.4, 2: 0.05 },
  overtime: 0.3, otStrength: 10, playerOtStrength: 8,
  dmg1000: 0.7, dmgStrength: 10, playerDmgStrength: 8,
  firstCrownStrength: 6, firstCrownWinLink: 0.6,
};

const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
const logit = (p) => { p = clamp(p, 1e-6, 1 - 1e-6); return Math.log(p / (1 - p)); };
const logistic = (x) => 1 / (1 + Math.exp(-x));
const smooth = (hits, n, mean, strength) => (hits + mean * strength) / (n + strength);
// Probability a beats b given each one's win rate vs the field (Bill James' log5)
const log5 = (a, b) => logistic(logit(a) - logit(b));

function dirichlet(counts, prior, strength) {
  const keys = Object.keys(prior);
  const n = keys.reduce((s, k) => s + (counts[k] || 0), 0);
  const out = {};
  for (const k of keys) out[k] = ((counts[k] || 0) + prior[k] * strength) / (n + strength);
  return out;
}

const addCounts = (...objs) => objs.reduce((acc, o) => {
  for (const [k, v] of Object.entries(o)) acc[k] = (acc[k] || 0) + v;
  return acc;
}, {});

// View a match from one player's side. Returns null if they weren't in it.
function orient(m, id) {
  let mine;
  if (m.playerA === id) mine = 'A';
  else if (m.playerB === id) mine = 'B';
  else return null;
  const opp = mine === 'A' ? 'B' : 'A';
  return {
    id: m.id,
    me: id,
    opp: m['player' + opp],
    oppName: m['name' + opp],
    myCrowns: m['crowns' + mine],
    oppCrowns: m['crowns' + opp],
    result: m.winner === 'draw' ? 'D' : m.winner === mine ? 'W' : 'L',
    overtime: m.overtime,
    firstCrown: m.firstCrown == null ? null : m.firstCrown === 'none' ? 'none' : m.firstCrown === mine ? 'me' : 'opp',
    dmgMe: m['dmg' + mine],
    dmgOpp: m['dmg' + opp],
    myCards: m['cards' + mine] || [],
    oppCards: m['cards' + opp] || [],
    date: m.date,
  };
}

// Same match, but expressed as A/B for a specific pair (used by settlement)
function orientPair(m, a) {
  const o = orient(m, a);
  if (!o) return null;
  return {
    a: o.myCrowns, b: o.oppCrowns,
    winner: o.result === 'D' ? 'D' : o.result === 'W' ? 'A' : 'B',
    overtime: o.overtime,
    firstCrown: o.firstCrown == null ? null : o.firstCrown === 'none' ? 'none' : o.firstCrown === 'me' ? 'A' : 'B',
    dmgA: o.dmgMe, dmgB: o.dmgOpp,
  };
}

function summarise(id, matches) {
  const s = {
    games: 0, wins: 0, losses: 0, draws: 0,
    winCrowns: {}, lossCrowns: {},  // winner crowns in games I won / lost
    otKnown: 0, ot: 0,
    dmgKnown: 0, dmg: 0, dmgConcededKnown: 0, dmgConceded: 0,
    firstKnown: 0, first: 0,
    crowns: 0, crownsAgainst: 0, threeCrowns: 0, form: [],
  };
  for (const m of matches) {
    const o = orient(m, id);
    if (!o) continue;
    s.games++;
    s.crowns += o.myCrowns; s.crownsAgainst += o.oppCrowns;
    if (o.result === 'W') {
      s.wins++; s.winCrowns[o.myCrowns] = (s.winCrowns[o.myCrowns] || 0) + 1;
      if (o.myCrowns === 3) s.threeCrowns++;
    } else if (o.result === 'L') {
      s.losses++; s.lossCrowns[o.oppCrowns] = (s.lossCrowns[o.oppCrowns] || 0) + 1;
    } else s.draws++;
    if (o.overtime != null) { s.otKnown++; if (o.overtime) s.ot++; }
    if (o.dmgMe != null) { s.dmgKnown++; if (o.dmgMe) s.dmg++; }
    if (o.dmgOpp != null) { s.dmgConcededKnown++; if (o.dmgOpp) s.dmgConceded++; }
    if (o.firstCrown === 'me' || o.firstCrown === 'opp') { s.firstKnown++; if (o.firstCrown === 'me') s.first++; }
    s.form.push(o.result);
  }
  s.decisive = s.wins + s.losses;
  s.form = s.form.slice(-5);
  return s;
}

function globalModel(matches) {
  const winnerCrowns = {}, loserCrowns = { 0: {}, 1: {}, 2: {}, 3: {} }, drawCrowns = {};
  let draws = 0, otKnown = 0, ot = 0, dmgKnown = 0, dmg = 0;
  for (const m of matches) {
    if (m.winner === 'draw') {
      draws++;
      drawCrowns[m.crownsA] = (drawCrowns[m.crownsA] || 0) + 1;
    } else {
      const w = m.winner === 'A' ? m.crownsA : m.crownsB;
      const l = m.winner === 'A' ? m.crownsB : m.crownsA;
      winnerCrowns[w] = (winnerCrowns[w] || 0) + 1;
      if (loserCrowns[w]) loserCrowns[w][l] = (loserCrowns[w][l] || 0) + 1;
    }
    if (m.overtime != null) { otKnown++; if (m.overtime) ot++; }
    for (const side of ['A', 'B']) {
      if (m['dmg' + side] != null) { dmgKnown++; if (m['dmg' + side]) dmg++; }
    }
  }
  return {
    n: matches.length,
    drawRate: smooth(draws, matches.length, PRIORS.drawRate, PRIORS.drawStrength),
    winnerCrowns: dirichlet(winnerCrowns, PRIORS.winnerCrowns, PRIORS.crownStrength),
    loserCrowns: Object.fromEntries(Object.entries(PRIORS.loserCrowns).map(([w, prior]) =>
      [w, dirichlet(loserCrowns[w], prior, PRIORS.loserStrength)])),
    drawCrowns: dirichlet(drawCrowns, PRIORS.drawCrowns, PRIORS.crownStrength),
    overtime: smooth(ot, otKnown, PRIORS.overtime, PRIORS.otStrength),
    dmg1000: smooth(dmg, dmgKnown, PRIORS.dmg1000, PRIORS.dmgStrength),
  };
}

// Trophy-based prior for who wins. Deliberately weak: in triple draft
// everyone gets the same random card pool, so ladder trophies matter less.
function trophyPrior(pa, pb) {
  const ta = pa && pa.trophies, tb = pb && pb.trophies;
  if (!ta || !tb) return 0.5;
  const elo = 1 / (1 + Math.pow(10, (tb - ta) / PRIORS.trophyScale));
  return 0.5 + (elo - 0.5) * PRIORS.trophyWeight;
}

// The full probability model for A vs B.
function model(a, b, matches, players = []) {
  const g = globalModel(matches);
  const sa = summarise(a, matches), sb = summarise(b, matches);
  const h2hMatches = matches.filter((m) => (m.playerA === a && m.playerB === b) || (m.playerA === b && m.playerB === a));
  const h = summarise(a, h2hMatches);
  const pa = players.find((p) => p.id === a), pb = players.find((p) => p.id === b);

  // Who wins (ignoring draws)
  const ra = smooth(sa.wins, sa.decisive, 0.5, PRIORS.winStrength);
  const rb = smooth(sb.wins, sb.decisive, 0.5, PRIORS.winStrength);
  const prior = trophyPrior(pa, pb);
  let pWin = logistic(logit(log5(ra, rb)) + logit(prior));
  pWin = smooth(h.wins, h.decisive, pWin, PRIORS.h2hStrength);

  const pDraw = smooth(sa.draws + sb.draws, sa.games + sb.games, g.drawRate, PRIORS.drawStrength);
  const pA = (1 - pDraw) * pWin, pB = (1 - pDraw) * (1 - pWin);

  // How the winner wins: their own winning style + how the opponent tends to lose
  const crownsA = dirichlet(addCounts(sa.winCrowns, sb.lossCrowns), g.winnerCrowns, PRIORS.playerCrownStrength);
  const crownsB = dirichlet(addCounts(sb.winCrowns, sa.lossCrowns), g.winnerCrowns, PRIORS.playerCrownStrength);

  // Every possible final scoreline with its probability
  const scores = [];
  for (const [w, pw] of Object.entries(crownsA)) {
    for (const [l, pl] of Object.entries(g.loserCrowns[w])) scores.push({ winner: 'A', a: +w, b: +l, p: pA * pw * pl });
  }
  for (const [w, pw] of Object.entries(crownsB)) {
    for (const [l, pl] of Object.entries(g.loserCrowns[w])) scores.push({ winner: 'B', a: +l, b: +w, p: pB * pw * pl });
  }
  for (const [c, pc] of Object.entries(g.drawCrowns)) scores.push({ winner: 'D', a: +c, b: +c, p: pDraw * pc });

  // Overtime
  const oa = smooth(sa.ot, sa.otKnown, g.overtime, PRIORS.playerOtStrength);
  const ob = smooth(sb.ot, sb.otKnown, g.overtime, PRIORS.playerOtStrength);
  const pOT = smooth(h.ot, h.otKnown, (oa + ob) / 2, PRIORS.h2hStrength);

  // 1000+ tower damage before overtime: attacker's rate + defender's leakiness
  const dmgA0 = smooth(sa.dmg + sb.dmgConceded, sa.dmgKnown + sb.dmgConcededKnown, g.dmg1000, PRIORS.playerDmgStrength);
  const dmgB0 = smooth(sb.dmg + sa.dmgConceded, sb.dmgKnown + sa.dmgConcededKnown, g.dmg1000, PRIORS.playerDmgStrength);
  const pDmgA = smooth(h.dmg, h.dmgKnown, dmgA0, PRIORS.h2hStrength);
  const pDmgB = smooth(h.dmgConceded, h.dmgConcededKnown, dmgB0, PRIORS.h2hStrength);

  // First crown: each player's first-blood rate, nudged by who's favourite
  const fa = smooth(sa.first, sa.firstKnown, 0.5, PRIORS.firstCrownStrength);
  const fb = smooth(sb.first, sb.firstKnown, 0.5, PRIORS.firstCrownStrength);
  let qFirst = logistic(logit(log5(fa, fb)) + PRIORS.firstCrownWinLink * logit(pWin));
  qFirst = smooth(h.first, h.firstKnown, qFirst, PRIORS.h2hStrength);
  const pNoCrowns = scores.filter((s) => s.a === 0 && s.b === 0).reduce((t, s) => t + s.p, 0);

  return {
    pA, pB, pDraw, pWin, scores, pOT, pDmgA, pDmgB, qFirst, pNoCrowns,
    sample: { a: sa.games, b: sb.games, h2h: h.games, total: matches.length },
    h2h: { aWins: h.wins, bWins: h.losses, draws: h.draws },
  };
}

const sumWhere = (scores, fn) => scores.filter(fn).reduce((t, s) => t + s.p, 0);
const isTiebreak = (s) => s.winner !== 'D' && s.a === s.b;
const winnerCrownsOf = (s) => (s.winner === 'A' ? s.a : s.b);

// Market definitions. Each selection has a probability function (from the
// model) and a settle function (from a finished match, oriented to A/B).
// settle returns true (won), false (lost) or null (void — data not recorded).
function marketDefs(nameA, nameB) {
  const both = (fn) => [['A', nameA], ['B', nameB]].map(([side, name]) => fn(side, name));
  const defs = [];

  defs.push({
    key: 'result', name: 'Match Result', blurb: 'Who takes the W.',
    selections: [
      { key: 'A', label: nameA, prob: (m) => m.pA, settle: (o) => o.winner === 'A' },
      { key: 'D', label: 'Draw', prob: (m) => m.pDraw, settle: (o) => o.winner === 'D' },
      { key: 'B', label: nameB, prob: (m) => m.pB, settle: (o) => o.winner === 'B' },
    ],
  });

  const methods = [[3, '3-crown win'], [2, '2-crown win'], [1, '1-crown win']];
  defs.push({
    key: 'method', name: 'Win Method', blurb: 'Winner\'s crown count. Tiebreaker = won on tower HP with crowns level.',
    selections: [
      ...both((side, name) => methods.map(([c, txt]) => ({
        key: side + c, label: `${name} ${txt}`,
        prob: (m) => sumWhere(m.scores, (s) => s.winner === side && !isTiebreak(s) && winnerCrownsOf(s) === c),
        settle: (o) => o.winner === side && o.a !== o.b && (side === 'A' ? o.a : o.b) === c,
      }))).flat(),
      ...both((side, name) => ({
        key: side + 'TB', label: `${name} on tiebreaker`,
        prob: (m) => sumWhere(m.scores, (s) => s.winner === side && isTiebreak(s)),
        settle: (o) => o.winner === side && o.a === o.b,
      })),
      { key: 'D', label: 'Draw', prob: (m) => m.pDraw, settle: (o) => o.winner === 'D' },
    ],
  });

  defs.push({
    key: 'margin', name: 'Winning Margin', blurb: 'Crown difference at the end. "Win by 1 tower" lives here.',
    selections: [
      ...both((side, name) => [1, 2, 3].map((d) => ({
        key: side + d, label: `${name} by ${d} tower${d > 1 ? 's' : ''}`,
        prob: (m) => sumWhere(m.scores, (s) => s.winner === side && Math.abs(s.a - s.b) === d),
        settle: (o) => o.winner === side && Math.abs(o.a - o.b) === d,
      }))).flat(),
      { key: 'level', label: 'Level on crowns (draw or tiebreaker)', prob: (m) => sumWhere(m.scores, (s) => s.a === s.b), settle: (o) => o.a === o.b },
    ],
  });

  defs.push({
    key: 'score', name: 'Correct Score', blurb: `Crowns shown as ${nameA}–${nameB}.`,
    selections: [], // built dynamically from the score grid below
  });

  defs.push({
    key: 'overtime', name: 'Goes to Overtime?', blurb: 'Still going when the 3-minute clock runs out.',
    selections: [
      { key: 'yes', label: 'Yes', prob: (m) => m.pOT, settle: (o) => (o.overtime == null ? null : o.overtime) },
      { key: 'no', label: 'No', prob: (m) => 1 - m.pOT, settle: (o) => (o.overtime == null ? null : !o.overtime) },
    ],
  });

  for (const [side, name] of [['A', nameA], ['B', nameB]]) {
    defs.push({
      key: 'dmg' + side, name: `${name}: 1000+ tower damage before OT`, blurb: 'Total damage dealt to towers in regulation time.',
      selections: [
        { key: 'yes', label: 'Yes', prob: (m) => m['pDmg' + side], settle: (o) => (o['dmg' + side] == null ? null : o['dmg' + side]) },
        { key: 'no', label: 'No', prob: (m) => 1 - m['pDmg' + side], settle: (o) => (o['dmg' + side] == null ? null : !o['dmg' + side]) },
      ],
    });
  }

  defs.push({
    key: 'first', name: 'First Tower', blurb: 'Who draws first blood.',
    selections: [
      { key: 'A', label: nameA, prob: (m) => (1 - m.pNoCrowns) * m.qFirst, settle: (o) => (o.firstCrown == null ? null : o.firstCrown === 'A') },
      { key: 'B', label: nameB, prob: (m) => (1 - m.pNoCrowns) * (1 - m.qFirst), settle: (o) => (o.firstCrown == null ? null : o.firstCrown === 'B') },
      { key: 'none', label: 'No towers fall', prob: (m) => m.pNoCrowns, settle: (o) => o.a + o.b === 0 },
    ],
  });

  for (const line of [1.5, 2.5, 3.5]) {
    defs.push({
      key: 'total' + line, name: `Total Crowns O/U ${line}`, blurb: 'Both players\' crowns added together.',
      selections: [
        { key: 'over', label: `Over ${line}`, prob: (m) => sumWhere(m.scores, (s) => s.a + s.b > line), settle: (o) => o.a + o.b > line },
        { key: 'under', label: `Under ${line}`, prob: (m) => sumWhere(m.scores, (s) => s.a + s.b < line), settle: (o) => o.a + o.b < line },
      ],
    });
  }

  defs.push({
    key: 'btts', name: 'Both Players Take a Tower', blurb: 'Everyone gets at least one crown.',
    selections: [
      { key: 'yes', label: 'Yes', prob: (m) => sumWhere(m.scores, (s) => s.a > 0 && s.b > 0), settle: (o) => o.a > 0 && o.b > 0 },
      { key: 'no', label: 'No', prob: (m) => sumWhere(m.scores, (s) => !(s.a > 0 && s.b > 0)), settle: (o) => !(o.a > 0 && o.b > 0) },
    ],
  });

  defs.push({
    key: 'clean', name: 'Clean Sheet Win', blurb: 'Win without losing a single tower.',
    selections: both((side, name) => ({
      key: side, label: `${name} to win to nil`,
      prob: (m) => sumWhere(m.scores, (s) => s.winner === side && (side === 'A' ? s.b : s.a) === 0),
      settle: (o) => o.winner === side && (side === 'A' ? o.b : o.a) === 0,
    })),
  });

  return defs;
}

const scoreKey = (s) => `${s.winner}:${s.a}-${s.b}`;
function parseScoreKey(k) {
  const m = /^([ABD]):(\d)-(\d)$/.exec(k);
  return m && { winner: m[1], a: +m[2], b: +m[3] };
}

// The standard UK fractional ladder, so prices look like a real bookie's
const LADDER = [
  '1/100', '1/50', '1/33', '1/25', '1/20', '1/16', '1/14', '1/12', '1/10', '1/9', '1/8', '1/7', '1/6', '1/5', '2/9', '1/4',
  '2/7', '3/10', '1/3', '4/11', '2/5', '4/9', '1/2', '8/15', '4/7', '8/13', '4/6', '8/11', '4/5', '5/6', '10/11', '1/1',
  '11/10', '6/5', '5/4', '11/8', '6/4', '13/8', '7/4', '15/8', '2/1', '9/4', '5/2', '11/4', '3/1', '10/3', '7/2', '4/1',
  '9/2', '5/1', '11/2', '6/1', '13/2', '7/1', '15/2', '8/1', '17/2', '9/1', '10/1', '11/1', '12/1', '14/1', '16/1', '18/1',
  '20/1', '25/1', '33/1', '40/1', '50/1', '66/1', '80/1', '100/1', '150/1', '200/1', '250/1', '500/1',
].map((f) => { const [n, d] = f.split('/').map(Number); return { f, x: n / d }; });

// Snap a decimal price to the nearest rung on the ladder (by ratio)
function toFractional(dec) {
  const x = dec - 1;
  let best = LADDER[0];
  for (const r of LADDER) if (Math.abs(Math.log(r.x / x)) < Math.abs(Math.log(best.x / x))) best = r;
  return best;
}

function price(p, marginPct) {
  const book = clamp(p, 0.002, 0.99) * (1 + marginPct / 100);
  const rung = toFractional(Math.max(1.01, 1 / book));
  return { p, decimal: Math.round((1 + rung.x) * 100) / 100, fractional: rung.f };
}

function buildMarkets(a, b, matches, players, settings = {}) {
  const margin = settings.margin ?? 5;
  const nameOf = (id) => (players.find((p) => p.id === id) || {}).name || id;
  const nameA = nameOf(a), nameB = nameOf(b);
  const m = model(a, b, matches, players);
  const markets = marketDefs(nameA, nameB).map((def) => {
    let selections;
    if (def.key === 'score') {
      selections = m.scores
        .filter((s) => s.p >= 0.004)
        .sort((x, y) => y.p - x.p)
        .map((s) => ({
          key: scoreKey(s),
          label: s.winner === 'D' ? `Draw ${s.a}–${s.b}` : `${s.winner === 'A' ? nameA : nameB} ${s.a}–${s.b}${s.a === s.b ? ' (TB)' : ''}`,
          ...price(s.p, margin),
        }));
    } else {
      selections = def.selections.map((sel) => ({ key: sel.key, label: sel.label, ...price(sel.prob(m), margin) }));
    }
    return { key: def.key, name: def.name, blurb: def.blurb, selections };
  });
  return { a, b, nameA, nameB, sample: m.sample, h2h: m.h2h, markets };
}

// Settle one selection against a match (already oriented to the bet's A/B).
function settleSelection(marketKey, selectionKey, o) {
  if (marketKey === 'score') {
    const s = parseScoreKey(selectionKey);
    return !!s && s.winner === o.winner && s.a === o.a && s.b === o.b;
  }
  const def = marketDefs('A', 'B').find((d) => d.key === marketKey);
  const sel = def && def.selections.find((x) => x.key === selectionKey);
  if (!sel) return null;
  return sel.settle(o);
}

module.exports = {
  PRIORS, orient, orientPair, summarise, globalModel, model, buildMarkets, settleSelection,
  toFractional: (dec) => toFractional(dec).f, price, log5, smooth,
};
