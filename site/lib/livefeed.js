'use strict';

// Live results: ask the Clash API (through the RoyaleAPI proxy, whose fixed IP 45.79.218.79 the key allows)
// for every squad member's battle log, so a finished game reaches the site within a couple of minutes instead
// of waiting for the GitHub sync. The API only remembers each player's last ~25 battles, so what it has seen
// is kept in DATA_DIR/live-battles.json (the last 8 days of friendlies). The key never leaves the server.

const fs = require('fs');
const path = require('path');
const { normTag, friendlies, mergeBattles } = require('../../scripts/lib/feed');

const KEEP_MS = 8 * 86400e3;
const stamp = (t) => Date.parse(String(t).replace(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2}).*$/, '$1-$2-$3T$4:$5:$6Z'));

function createLiveFeed({ token, base = 'https://proxy.royaleapi.dev/v1', repoRoot, dataDir, log = () => {}, fetchImpl }) {
  if (!token) return null;
  const file = path.join(dataDir, 'live-battles.json');
  const doFetch = fetchImpl || ((...a) => fetch(...a));
  let saved = { battles: [], checked: {} }, last = { at: null, players: 0, failed: 0, error: null };
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (j && Array.isArray(j.battles)) saved = { battles: j.battles, checked: j.checked && typeof j.checked === 'object' ? j.checked : {} };
  } catch { /* nothing kept yet */ }

  async function get(p) {
    const res = await doFetch(base + p, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }, signal: AbortSignal.timeout(15000) });
    if (!res.ok) {
      let reason = '';
      try { const j = await res.json(); reason = String(j.reason || j.message || '').replace(/[^\w .,:'-]/g, '').slice(0, 80); } catch { /* not JSON */ }
      throw new Error(`HTTP ${res.status}${reason ? ` ${reason}` : ''}${res.status === 403 ? ' (check the key is right and allows IP 45.79.218.79)' : ''}`);
    }
    return res.json();
  }

  // Every squad member's battle log, merged into what was kept. Returns the friendlies and when each log was read.
  async function pull() {
    const squad = JSON.parse(fs.readFileSync(path.join(repoRoot, 'squad.json'), 'utf8')).filter((p) => p && p.tag);
    const fresh = [], checked = { ...saved.checked };
    let failed = 0, error = null;
    await Promise.all(squad.map(async (p) => {
      const tag = normTag(p.tag);
      try {
        fresh.push(...friendlies(await get(`/players/${encodeURIComponent(tag)}/battlelog`)));
        checked[tag] = new Date().toISOString();
      } catch (e) { failed++; error = error || `${p.name || tag}: ${e.message}`; }
    }));
    const cutoff = Date.now() - KEEP_MS;
    const battles = mergeBattles([saved.battles, fresh]).filter((b) => stamp(b.battleTime) >= cutoff);
    saved = { battles, checked };
    try {
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(saved), { mode: 0o600 });
      fs.renameSync(tmp, file);
    } catch (e) { log(`[live] could not save ${path.basename(file)}: ${e.message}`); }
    last = { at: new Date().toISOString(), players: squad.length, failed, error };
    if (failed) log(`[live] ${failed} of ${squad.length} battle logs could not be read. First problem: ${error}`);
    if (failed === squad.length && squad.length) throw new Error(`Couldn't read any battle log from Clash. ${error}`);
    return saved;
  }

  return { pull, status: () => ({ ...last }) };
}

module.exports = { createLiveFeed };
