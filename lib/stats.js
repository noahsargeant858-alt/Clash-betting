'use strict';

const { orient, summarise } = require('./odds');

const pct = (n, d) => (d ? Math.round((n / d) * 1000) / 10 : null);

function playerTable(players, matches) {
  return players.map((p) => {
    const s = summarise(p.id, matches);
    return {
      id: p.id, name: p.name, games: s.games, wins: s.wins, losses: s.losses, draws: s.draws,
      winPct: pct(s.wins, s.games),
      threeCrownPct: pct(s.threeCrowns, s.wins),
      otPct: pct(s.ot, s.otKnown),
      dmgPct: pct(s.dmg, s.dmgKnown),
      firstPct: pct(s.first, s.firstKnown),
      avgCrowns: s.games ? Math.round((s.crowns / s.games) * 100) / 100 : null,
      avgCrownsAgainst: s.games ? Math.round((s.crownsAgainst / s.games) * 100) / 100 : null,
      form: s.form,
    };
  });
}

function h2hMatrix(players, matches) {
  const rows = {};
  for (const a of players) {
    rows[a.id] = {};
    for (const b of players) {
      if (a.id === b.id) continue;
      const s = summarise(a.id, matches.filter((m) => (m.playerA === a.id && m.playerB === b.id) || (m.playerA === b.id && m.playerB === a.id)));
      rows[a.id][b.id] = { w: s.wins, l: s.losses, d: s.draws };
    }
  }
  return rows;
}

// Outcome breakdown for one matchup — "what usually happens when X plays Y"
function matchup(a, b, matches) {
  const list = matches
    .filter((m) => (m.playerA === a && m.playerB === b) || (m.playerA === b && m.playerB === a))
    .map((m) => orient(m, a));
  const tally = (fn) => list.reduce((t, o) => t + (fn(o) ? 1 : 0), 0);
  const scorelines = {};
  for (const o of list) {
    const k = `${o.result === 'D' ? 'D' : o.result === 'W' ? 'A' : 'B'}:${o.myCrowns}-${o.oppCrowns}`;
    scorelines[k] = (scorelines[k] || 0) + 1;
  }
  const otKnown = list.filter((o) => o.overtime != null);
  return {
    games: list.length,
    aWins: tally((o) => o.result === 'W'), bWins: tally((o) => o.result === 'L'), draws: tally((o) => o.result === 'D'),
    aThree: tally((o) => o.result === 'W' && o.myCrowns === 3), bThree: tally((o) => o.result === 'L' && o.oppCrowns === 3),
    byOne: tally((o) => o.result !== 'D' && Math.abs(o.myCrowns - o.oppCrowns) === 1),
    overtime: otKnown.filter((o) => o.overtime).length, otKnown: otKnown.length,
    scorelines,
    matches: list,
  };
}

// Card-level stats: which drafted cards turn up in wins / 3-crowns
function cardTable(matches, minGames = 1) {
  const cards = {};
  for (const m of matches) {
    for (const side of ['A', 'B']) {
      const o = orient(m, m['player' + side]);
      for (const c of o.myCards) {
        const r = (cards[c] ||= { card: c, games: 0, wins: 0, threeCrowns: 0, crowns: 0 });
        r.games++; r.crowns += o.myCrowns;
        if (o.result === 'W') r.wins++;
        if (o.result === 'W' && o.myCrowns === 3) r.threeCrowns++;
      }
    }
  }
  return Object.values(cards)
    .filter((r) => r.games >= minGames)
    .map((r) => ({ ...r, winPct: pct(r.wins, r.games), threeCrownPct: pct(r.threeCrowns, r.games), avgCrowns: Math.round((r.crowns / r.games) * 100) / 100 }))
    .sort((x, y) => y.games - x.games || y.winPct - x.winPct);
}

module.exports = { playerTable, h2hMatrix, matchup, cardTable };
