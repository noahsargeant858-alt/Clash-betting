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

const { normTag, friendlies, mergeBattles } = require('./lib/feed');
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

(async () => {
  const prev = PREV && fs.existsSync(PREV) ? JSON.parse(fs.readFileSync(PREV, 'utf8')) : { players: {}, battles: [] };
  const fresh = [];
  const players = { ...(prev.players || {}) };
  // when each player's log was last read in full: anything they played before then is in this file
  const checked = { ...(prev.checked || {}) };
  let failed = 0;

  for (const p of squad) {
    const tag = normTag(p.tag), enc = encodeURIComponent(tag);
    try {
      const [profile, log] = await Promise.all([get(`/players/${enc}`), get(`/players/${enc}/battlelog`)]);
      players[tag] = { name: profile.name, trophies: profile.trophies, bestTrophies: profile.bestTrophies, expLevel: profile.expLevel };
      const mine = friendlies(log);
      fresh.push(...mine);
      checked[tag] = new Date().toISOString();
      console.log(`${p.name} (${tag}): ${log.length} battles in log, ${mine.length} friendlies`);
    } catch (e) {
      failed++;
      console.error(`${p.name} (${tag}): ${e.message}`);
    }
  }

  const known = new Set((prev.battles || []).map((b) => b.key));
  const added = new Set(fresh.filter((b) => !known.has(b.key)).map((b) => b.key)).size;
  const list = mergeBattles([prev.battles || [], fresh], MAX_BATTLES);
  const next = { players, battles: list, checked };
  const before = JSON.stringify({ players: prev.players || {}, battles: prev.battles || [], checked: prev.checked || {} });
  if (JSON.stringify(next) !== before) {
    fs.writeFileSync(OUT, JSON.stringify({ updatedAt: new Date().toISOString(), ...next }, null, 1) + '\n');
    console.log(`Saved: ${added} new friendlies, ${list.length} stored.`);
  } else console.log('Nothing new.');
  if (squad.length && failed === squad.length) process.exit(1); // every player failed: show the run as failed
})();
