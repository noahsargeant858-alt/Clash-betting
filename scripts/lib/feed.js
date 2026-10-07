'use strict';

// Shared by the GitHub sync (scripts/fetch-battles.js) and the website's live import (site/lib/livefeed.js):
// which battles from a player's Clash battle log we keep, how each is stored, and how the two players' copies
// of one battle are merged.

const normTag = (t) => '#' + String(t).trim().toUpperCase().replace(/^#/, '').replace(/O/g, '0');

// One battle shows up in both players' logs, and the two copies' times can differ by a second. Same two
// players within 10 seconds with the score mirrored = the same battle; keep the first copy.
const when = (t) => Date.parse(t.replace(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2}).*$/, '$1-$2-$3T$4:$5:$6Z'));
function sameBattle(x, y) {
  const pair = (b) => [b.team.tag, b.opponent.tag].sort().join();
  if (pair(x) !== pair(y) || Math.abs(when(x.battleTime) - when(y.battleTime)) > 10000) return false;
  const [ya, yb] = x.team.tag === y.team.tag ? [y.team, y.opponent] : [y.opponent, y.team];
  return x.team.crowns === ya.crowns && x.opponent.crowns === yb.crowns;
}
function dedupe(list) {
  const out = [];
  for (const b of list.sort((x, y) => x.battleTime.localeCompare(y.battleTime))) if (!out.some((o) => sameBattle(o, b))) out.push(b);
  return out;
}

// Everything the site can use from one side of a battle
const side = (s) => ({
  tag: s.tag,
  name: s.name,
  crowns: s.crowns,
  kingTowerHitPoints: s.kingTowerHitPoints ?? null,
  princessTowersHitPoints: s.princessTowersHitPoints ?? null,
  elixirLeaked: s.elixirLeaked ?? null,
  cards: (s.cards || []).map((c) => ({ name: c.name, level: c.level, maxLevel: c.maxLevel, evolutionLevel: c.evolutionLevel ?? null })),
});

// The 1v1 friendlies in one player's battle log, as stored in the feed
function friendlies(log) {
  const out = [];
  for (const b of Array.isArray(log) ? log : []) {
    if (!b || !b.team || !b.opponent || b.team.length !== 1 || b.opponent.length !== 1) continue; // 1v1 only
    if (!/friendly|clanmate/i.test(b.type || '')) continue; // friendly battles only
    const key = `${b.battleTime}|${[b.team[0].tag, b.opponent[0].tag].sort().join('|')}`;
    out.push({ key, battleTime: b.battleTime, type: b.type, gameMode: b.gameMode || null, team: side(b.team[0]), opponent: side(b.opponent[0]) });
  }
  return out;
}

// Several lists of stored battles as one: the first copy of each key wins, the two players' copies of one
// battle become one, newest first, at most `max`
function mergeBattles(lists, max = 3000) {
  const byKey = new Map();
  for (const list of lists) for (const b of Array.isArray(list) ? list : []) if (b && typeof b.key === 'string' && typeof b.battleTime === 'string' && b.team && b.opponent && !byKey.has(b.key)) byKey.set(b.key, b);
  return dedupe([...byKey.values()]).sort((x, y) => y.battleTime.localeCompare(x.battleTime)).slice(0, max);
}

module.exports = { normTag, sameBattle, dedupe, side, friendlies, mergeBattles };
