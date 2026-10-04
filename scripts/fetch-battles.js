'use strict';

// Runs in GitHub Actions. Pulls each squad member's recent battles from the
// Clash Royale API (through the RoyaleAPI proxy, so the key can whitelist one
// fixed IP: 45.79.218.79) and merges the 1v1 friendlies into battles.json on
// the battle-data branch. The API only keeps ~25 battles per player, so this
// runs every hour to catch friendlies before ladder games push them out.
//
//   node scripts/fetch-battles.js <out.json> [previous.json]
// Writes <out.json> only when something changed.

const fs = require('fs');
const path = require('path');

const BASE = process.env.CR_API_BASE || 'https://proxy.royaleapi.dev/v1';
const TOKEN = process.env.CR_API_TOKEN;
const [OUT = 'battles.json', PREV] = process.argv.slice(2);
const MAX_BATTLES = 3000;

if (!TOKEN) {
  console.error('The CR_API_TOKEN secret is missing. Add it on GitHub: Settings > Secrets and variables > Actions > New repository secret.');
  process.exit(1);
}

const normTag = (t) => '#' + String(t).trim().toUpperCase().replace(/^#/, '').replace(/O/g, '0');
const squad = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'squad.json'), 'utf8')).filter((p) => p.tag);

async function get(p) {
  const res = await fetch(BASE + p, { headers: { Authorization: `Bearer ${TOKEN}`, Accept: 'application/json' } });
  if (!res.ok) {
    let reason = '';
    try { const j = await res.json(); reason = j.reason || j.message || ''; } catch { /* not json */ }
    const hint = res.status === 403 ? ' (check the key lists 45.79.218.79 under allowed IP addresses)' : '';
    throw new Error(`HTTP ${res.status} ${reason}${hint}`);
  }
  return res.json();
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

(async () => {
  const prev = PREV && fs.existsSync(PREV) ? JSON.parse(fs.readFileSync(PREV, 'utf8')) : { players: {}, battles: [] };
  const battles = new Map((prev.battles || []).map((b) => [b.key, b]));
  const players = { ...(prev.players || {}) };
  let added = 0, failed = 0;

  for (const p of squad) {
    const tag = normTag(p.tag), enc = encodeURIComponent(tag);
    try {
      const [profile, log] = await Promise.all([get(`/players/${enc}`), get(`/players/${enc}/battlelog`)]);
      players[tag] = { name: profile.name, trophies: profile.trophies, bestTrophies: profile.bestTrophies, expLevel: profile.expLevel };
      let mine = 0;
      for (const b of log) {
        if (!b.team || !b.opponent || b.team.length !== 1 || b.opponent.length !== 1) continue; // 1v1 only
        if (!/friendly|clanmate/i.test(b.type || '')) continue; // friendly battles only
        const key = `${b.battleTime}|${[b.team[0].tag, b.opponent[0].tag].sort().join('|')}`;
        if (battles.has(key)) continue;
        battles.set(key, { key, battleTime: b.battleTime, type: b.type, gameMode: b.gameMode || null, team: side(b.team[0]), opponent: side(b.opponent[0]) });
        added++; mine++;
      }
      console.log(`${p.name} (${tag}): ${log.length} battles in log, ${mine} new friendlies`);
    } catch (e) {
      failed++;
      console.error(`${p.name} (${tag}): ${e.message}`);
    }
  }

  const list = [...battles.values()].sort((x, y) => y.battleTime.localeCompare(x.battleTime)).slice(0, MAX_BATTLES);
  const next = { players, battles: list };
  const before = JSON.stringify({ players: prev.players || {}, battles: prev.battles || [] });
  if (JSON.stringify(next) !== before) {
    fs.writeFileSync(OUT, JSON.stringify({ updatedAt: new Date().toISOString(), ...next }, null, 1) + '\n');
    console.log(`Saved: ${added} new friendlies, ${list.length} stored.`);
  } else console.log('Nothing new.');
  if (squad.length && failed === squad.length) process.exit(1); // every player failed: show the run as failed
})();
