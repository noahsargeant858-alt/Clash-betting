'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

// Tiny .env loader so nobody has to install dotenv
const envFile = path.join(__dirname, '.env');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

const { DB, newId } = require('./lib/db');
const clash = require('./lib/clash-api');
const { buildMarkets, settleSelection, orientPair } = require('./lib/odds');
const stats = require('./lib/stats');

const PORT = process.env.PORT || 3000;
const db = new DB(process.env.DB_FILE || path.join(__dirname, 'data', 'db.json'));
const PUBLIC = path.join(__dirname, 'public');

class HttpError extends Error {
  constructor(status, msg) { super(msg); this.status = status; }
}

const playerById = (id) => db.data.players.find((p) => p.id === id);
const nameOf = (id) => (playerById(id) || {}).name || id;
const triBool = (v) => (v === true || v === 'true' || v === 'yes' ? true : v === false || v === 'false' || v === 'no' ? false : null);

// ---------- matches ----------

function normaliseMatch(input) {
  const playerA = String(input.playerA || ''), playerB = String(input.playerB || '');
  if (!playerA || !playerB) throw new HttpError(400, 'Pick both players.');
  if (playerA === playerB) throw new HttpError(400, 'A player can\'t play themselves. Well, they can, but we\'re not taking bets on it.');
  const crownsA = Number(input.crownsA), crownsB = Number(input.crownsB);
  for (const c of [crownsA, crownsB]) if (!Number.isInteger(c) || c < 0 || c > 3) throw new HttpError(400, 'Crowns must be 0–3.');
  if (crownsA === 3 && crownsB === 3) throw new HttpError(400, '3–3 is impossible — the game ends when a King Tower falls.');

  let winner = input.winner || null;
  if (!winner) winner = crownsA > crownsB ? 'A' : crownsB > crownsA ? 'B' : 'draw';
  if (!['A', 'B', 'draw'].includes(winner)) throw new HttpError(400, 'Bad winner.');
  if (winner === 'draw' && crownsA !== crownsB) throw new HttpError(400, 'A draw needs equal crowns.');
  if (winner === 'A' && crownsA < crownsB) throw new HttpError(400, 'Player A can\'t win with fewer crowns.');
  if (winner === 'B' && crownsB < crownsA) throw new HttpError(400, 'Player B can\'t win with fewer crowns.');

  let overtime = triBool(input.overtime);
  if (overtime == null && winner === 'draw') overtime = true; // draws only happen after OT
  if (overtime == null && crownsA === crownsB && winner !== 'draw') overtime = true; // tiebreakers too

  let dmgA = triBool(input.dmgA), dmgB = triBool(input.dmgB);
  // If you took a tower in regulation you obviously did 1000+ damage
  if (overtime === false) {
    if (dmgA == null && crownsA > 0) dmgA = true;
    if (dmgB == null && crownsB > 0) dmgB = true;
  }

  let firstCrown = input.firstCrown || null;
  if (crownsA + crownsB === 0) firstCrown = 'none';
  else if (!firstCrown && crownsA === 0) firstCrown = 'B';
  else if (!firstCrown && crownsB === 0) firstCrown = 'A';
  if (firstCrown && !['A', 'B', 'none'].includes(firstCrown)) throw new HttpError(400, 'Bad first tower value.');

  const cards = (v) => (Array.isArray(v) ? v : String(v || '').split(',')).map((c) => String(c).trim()).filter(Boolean).slice(0, 8);
  const date = input.date ? new Date(input.date) : new Date();
  if (isNaN(date)) throw new HttpError(400, 'Bad date.');

  return {
    id: newId(),
    date: date.toISOString(),
    playerA, playerB,
    nameA: input.nameA || nameOf(playerA), nameB: input.nameB || nameOf(playerB),
    crownsA, crownsB, winner, overtime, dmgA, dmgB, firstCrown,
    cardsA: cards(input.cardsA), cardsB: cards(input.cardsB),
    notes: String(input.notes || '').slice(0, 500),
    source: input.source || 'manual',
    battleTime: input.battleTime || null,
    createdAt: new Date().toISOString(),
  };
}

const matchKey = (m) => m.battleTime && `${m.battleTime}|${[m.playerA, m.playerB].sort().join('|')}`;

function addMatch(input) {
  const m = normaliseMatch(input);
  const key = matchKey(m);
  if (key && db.data.matches.some((x) => matchKey(x) === key)) return null; // already imported
  db.data.matches.push(m);
  db.data.matches.sort((x, y) => x.date.localeCompare(y.date));
  settleBetsFor(m);
  return m;
}

// ---------- bets ----------

function settleBetsFor(match) {
  const open = db.data.bets.filter((b) => b.status === 'open'
    && ((b.a === match.playerA && b.b === match.playerB) || (b.a === match.playerB && b.b === match.playerA))
    && b.placedAt <= match.date);
  for (const bet of open) {
    const o = orientPair(match, bet.a);
    const result = settleSelection(bet.market, bet.selection, o);
    const bettor = playerById(bet.bettor);
    bet.status = result === true ? 'won' : result === false ? 'lost' : 'void';
    bet.matchId = match.id;
    bet.settledAt = new Date().toISOString();
    bet.payout = bet.status === 'won' ? Math.round(bet.stake * bet.odds) : bet.status === 'void' ? bet.stake : 0;
    if (bettor) bettor.coins += bet.payout;
  }
}

function unsettleBetsFor(matchId) {
  for (const bet of db.data.bets.filter((b) => b.matchId === matchId)) {
    const bettor = playerById(bet.bettor);
    if (bettor) bettor.coins -= bet.payout || 0;
    Object.assign(bet, { status: 'open', matchId: null, settledAt: null, payout: null });
  }
}

function placeBet({ bettor, a, b, market, selection, stake }) {
  const who = playerById(bettor);
  if (!who) throw new HttpError(400, 'Who\'s placing this bet?');
  stake = Math.floor(Number(stake));
  if (!(stake > 0)) throw new HttpError(400, 'Stake must be a positive number of coins.');
  if (stake > who.coins) throw new HttpError(400, `${who.name} only has ${who.coins} coins. The bank of mum is closed.`);
  const book = buildMarkets(a, b, db.data.matches, db.data.players, db.data.settings);
  const mk = book.markets.find((x) => x.key === market);
  const sel = mk && mk.selections.find((x) => x.key === selection);
  if (!sel) throw new HttpError(400, 'That selection doesn\'t exist.');
  who.coins -= stake;
  const bet = {
    id: newId(), bettor, a, b, market, selection,
    label: `${book.nameA} v ${book.nameB} — ${mk.name}: ${sel.label}`,
    odds: sel.decimal, fractional: sel.fractional, stake,
    status: 'open', placedAt: new Date().toISOString(),
  };
  db.data.bets.push(bet);
  return bet;
}

// ---------- players / Clash API sync ----------

function addPlayer({ tag, name }) {
  let id;
  if (tag) {
    id = clash.normaliseTag(tag);
    if (!id) throw new HttpError(400, `"${tag}" doesn't look like a Clash Royale tag.`);
  } else {
    if (!name) throw new HttpError(400, 'Give a tag or at least a name.');
    id = 'p_' + newId();
  }
  if (playerById(id)) throw new HttpError(400, 'Already added that player.');
  const p = { id, tag: tag ? id : null, name: String(name || id).slice(0, 40), coins: db.data.settings.startingCoins, addedAt: new Date().toISOString() };
  db.data.players.push(p);
  return p;
}

async function syncPlayer(p) {
  if (!p.tag) return { player: p.name, imported: 0, note: 'No tag — manual-only player.' };
  const [profile, log] = await Promise.all([clash.getPlayer(p.tag), clash.getBattleLog(p.tag)]);
  // Keep the nickname you gave them; remember the in-game name separately
  if (!p.name || p.name === p.id) p.name = profile.name;
  Object.assign(p, {
    igName: profile.name, trophies: profile.trophies, bestTrophies: profile.bestTrophies,
    expLevel: profile.expLevel, arena: profile.arena && profile.arena.name,
    clan: profile.clan && profile.clan.name, lastSynced: new Date().toISOString(),
  });
  let imported = 0;
  for (const b of clash.draftBattles(log, db.data.settings)) {
    const m = addMatch({ ...b, playerA: b.tagA, playerB: b.tagB, source: 'api' });
    if (m) imported++;
  }
  // Keep names on old matches in sync with renames
  for (const m of db.data.matches) {
    if (m.playerA === p.id) m.nameA = p.name;
    if (m.playerB === p.id) m.nameB = p.name;
  }
  return { player: p.name, imported, scanned: (log || []).length };
}

// ---------- HTTP plumbing ----------

async function readBody(req) {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 1e6) throw new HttpError(413, 'Body too large');
  }
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { throw new HttpError(400, 'Invalid JSON'); }
}

const send = (res, status, body) => {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
};

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };

function serveStatic(req, res, pathname) {
  const file = path.normalize(path.join(PUBLIC, pathname === '/' ? 'index.html' : pathname));
  if (!file.startsWith(PUBLIC) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404); return res.end('Not found');
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
}

const routes = [];
const route = (method, pattern, fn) => routes.push({ method, re: new RegExp('^' + pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$'), fn });

route('GET', '/api/state', () => ({ ...db.data, apiConfigured: !!process.env.CR_API_TOKEN }));

route('POST', '/api/players', (req, body) => { const p = addPlayer(body); db.save(); return p; });
route('DELETE', '/api/players/:id', (req, body, { id }) => {
  db.data.players = db.data.players.filter((p) => p.id !== id);
  db.save(); return { ok: true };
});
route('POST', '/api/players/:id/sync', async (req, body, { id }) => {
  const p = playerById(id);
  if (!p) throw new HttpError(404, 'No such player');
  const r = await syncPlayer(p); db.save(); return r;
});
route('POST', '/api/sync-all', async () => {
  const results = [];
  for (const p of db.data.players.filter((x) => x.tag)) {
    try { results.push(await syncPlayer(p)); } catch (e) { results.push({ player: p.name, error: e.message }); }
  }
  db.save(); return results;
});
route('POST', '/api/players/:id/coins', (req, body, { id }) => {
  const p = playerById(id);
  if (!p) throw new HttpError(404, 'No such player');
  p.coins = Math.max(0, Math.floor(Number(body.coins) || 0));
  db.save(); return p;
});

route('POST', '/api/matches', (req, body) => {
  const m = addMatch(body);
  db.save();
  return m || { duplicate: true };
});
// Fill in the details the API doesn't know (overtime, damage, first tower...)
route('PUT', '/api/matches/:id', (req, body, { id }) => {
  const i = db.data.matches.findIndex((m) => m.id === id);
  if (i < 0) throw new HttpError(404, 'No such match');
  const old = db.data.matches[i];
  const updated = { ...normaliseMatch({ ...old, ...body }), id, createdAt: old.createdAt };
  unsettleBetsFor(id);
  db.data.matches[i] = updated;
  settleBetsFor(updated);
  db.save(); return updated;
});
route('DELETE', '/api/matches/:id', (req, body, { id }) => {
  unsettleBetsFor(id);
  db.data.matches = db.data.matches.filter((m) => m.id !== id);
  db.save(); return { ok: true };
});

route('GET', '/api/odds', (req, body, params, url) => {
  const a = url.searchParams.get('a'), b = url.searchParams.get('b');
  if (!a || !b || a === b) throw new HttpError(400, 'Pick two different players.');
  return buildMarkets(a, b, db.data.matches, db.data.players, db.data.settings);
});

route('POST', '/api/bets', (req, body) => { const bet = placeBet(body); db.save(); return bet; });
route('POST', '/api/bets/:id/void', (req, body, { id }) => {
  const bet = db.data.bets.find((x) => x.id === id);
  if (!bet || bet.status !== 'open') throw new HttpError(400, 'Only open bets can be voided.');
  bet.status = 'void'; bet.payout = bet.stake; bet.settledAt = new Date().toISOString();
  const who = playerById(bet.bettor); if (who) who.coins += bet.stake;
  db.save(); return bet;
});

route('GET', '/api/insights', () => ({
  players: stats.playerTable(db.data.players, db.data.matches),
  h2h: stats.h2hMatrix(db.data.players, db.data.matches),
  cards: stats.cardTable(db.data.matches),
}));
route('GET', '/api/matchup', (req, body, params, url) =>
  stats.matchup(url.searchParams.get('a'), url.searchParams.get('b'), db.data.matches));

route('PUT', '/api/settings', (req, body) => {
  const s = db.data.settings;
  if (body.margin != null) s.margin = Math.min(50, Math.max(0, Number(body.margin) || 0));
  if (body.startingCoins != null) s.startingCoins = Math.max(0, Math.floor(Number(body.startingCoins) || 0));
  for (const k of ['modeRegex', 'typeRegex']) {
    if (body[k] != null) {
      try { new RegExp(body[k]); } catch { throw new HttpError(400, `${k} isn't a valid regex.`); }
      s[k] = String(body[k]);
    }
  }
  db.save(); return s;
});

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (!url.pathname.startsWith('/api/')) return serveStatic(req, res, url.pathname);
  for (const r of routes) {
    const m = r.method === req.method && r.re.exec(url.pathname);
    if (!m) continue;
    try {
      const body = ['POST', 'PUT'].includes(req.method) ? await readBody(req) : {};
      const params = Object.fromEntries(Object.entries(m.groups || {}).map(([k, v]) => [k, decodeURIComponent(v)]));
      return send(res, 200, await r.fn(req, body, params, url));
    } catch (e) {
      if (!(e instanceof HttpError)) console.error(e);
      return send(res, e.status || 500, { error: e.message });
    }
  }
  send(res, 404, { error: 'No such endpoint' });
});

// Anyone listed in squad.json is added automatically on startup
function loadSquad(file = path.join(__dirname, 'squad.json')) {
  if (!fs.existsSync(file)) return 0;
  let added = 0;
  for (const { tag, name } of JSON.parse(fs.readFileSync(file, 'utf8'))) {
    const id = clash.normaliseTag(tag);
    if (!id) { console.warn(`squad.json: skipping bad tag ${tag}`); continue; }
    if (playerById(id)) continue;
    addPlayer({ tag, name }); added++;
  }
  if (added) db.save();
  return added;
}

if (require.main === module) {
  const added = loadSquad();
  if (added) console.log(`👥 Added ${added} player(s) from squad.json`);
  server.listen(PORT, () => {
    console.log(`🏆 Clash Bets running on http://localhost:${PORT}`);
    if (!process.env.CR_API_TOKEN) console.log('⚠️  No CR_API_TOKEN — auto-import is off, manual logging still works.');
  });
}

module.exports = { server, db, normaliseMatch, loadSquad };
