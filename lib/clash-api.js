'use strict';

// Thin client for the official Clash Royale API (developer.clashroyale.com).
// The API needs a token tied to a whitelisted IP. If your IP keeps changing,
// point CR_API_BASE at the RoyaleAPI proxy (https://proxy.royaleapi.dev/v1)
// and whitelist 45.79.218.79 on your key instead.

const BASE = process.env.CR_API_BASE || 'https://api.clashroyale.com/v1';

// Tags never contain the letter O — people always type it instead of zero.
function normaliseTag(tag) {
  const t = String(tag || '').trim().toUpperCase().replace(/^#/, '').replace(/O/g, '0');
  if (!/^[0289PYLQGRJCUV]{3,12}$/.test(t)) return null;
  return '#' + t;
}

async function call(pathname) {
  const token = process.env.CR_API_TOKEN;
  if (!token) throw new Error('No CR_API_TOKEN set — add your Clash Royale API key to .env (see README).');
  const res = await fetch(BASE + pathname, { headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' } });
  if (!res.ok) {
    let reason = '';
    try { reason = (await res.json()).reason || ''; } catch { /* not json */ }
    if (res.status === 403) throw new Error(`Clash API said 403 (${reason || 'forbidden'}) — usually your IP isn't whitelisted on the key.`);
    if (res.status === 404) throw new Error('Clash API: player not found. Check the tag.');
    throw new Error(`Clash API error ${res.status} ${reason}`);
  }
  return res.json();
}

const enc = (tag) => encodeURIComponent(tag);
const getPlayer = (tag) => call(`/players/${enc(tag)}`);
const getBattleLog = (tag) => call(`/players/${enc(tag)}/battlelog`);

// "20261003T163800.000Z" → ISO string
function parseBattleTime(t) {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})/.exec(t || '');
  return m ? `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z` : new Date().toISOString();
}

// Pick out the 1v1 triple draft friendlies from a battlelog and turn them
// into match records. Overtime / damage / first tower aren't in the API, so
// those stay null until someone fills them in on the Log Match tab.
function draftBattles(log, { modeRegex = 'draft', typeRegex = 'friendly|clanmate' } = {}) {
  const mode = new RegExp(modeRegex, 'i'), type = new RegExp(typeRegex, 'i');
  return (log || [])
    .filter((b) => type.test(b.type || '') && mode.test((b.gameMode && b.gameMode.name) || '')
      && b.team && b.team.length === 1 && b.opponent && b.opponent.length === 1)
    .map((b) => {
      const me = b.team[0], opp = b.opponent[0];
      return {
        battleTime: b.battleTime,
        date: parseBattleTime(b.battleTime),
        mode: b.gameMode.name,
        tagA: me.tag, nameA: me.name, crownsA: me.crowns,
        tagB: opp.tag, nameB: opp.name, crownsB: opp.crowns,
        cardsA: (me.cards || []).map((c) => c.name),
        cardsB: (opp.cards || []).map((c) => c.name),
      };
    });
}

module.exports = { normaliseTag, getPlayer, getBattleLog, draftBattles, parseBattleTime };
