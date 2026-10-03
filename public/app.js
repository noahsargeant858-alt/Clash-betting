'use strict';

let state = { players: [], matches: [], bets: [], settings: {} };
let slip = null; // { a, b, market, marketName, selection, label, decimal, fractional }

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const nameOf = (id) => (state.players.find((p) => p.id === id) || {}).name || id;
const fmtDate = (iso) => new Date(iso).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const yn = (v) => (v == null ? '?' : v ? 'Y' : 'N');

async function api(method, url, body) {
  const res = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Something broke');
  return data;
}

function toast(msg, bad) {
  const t = $('#toast');
  t.textContent = msg; t.className = 'show' + (bad ? ' bad' : '');
  clearTimeout(toast.timer); toast.timer = setTimeout(() => (t.className = ''), 3500);
}

async function refresh() {
  state = await api('GET', '/api/state');
  renderPlayerSelects();
  renderPlayers();
  renderMatches();
  renderBets();
  renderSettings();
  const active = $('#tabs .active').dataset.tab;
  if (active === 'odds') loadOdds();
  if (active === 'insights') loadInsights();
}

// ---------- tabs ----------
$('#tabs').addEventListener('click', (e) => {
  const btn = e.target.closest('button'); if (!btn) return;
  $$('#tabs button').forEach((b) => b.classList.toggle('active', b === btn));
  $$('.tab').forEach((t) => t.classList.toggle('active', t.id === 'tab-' + btn.dataset.tab));
  if (btn.dataset.tab === 'odds') loadOdds();
  if (btn.dataset.tab === 'insights') loadInsights();
});

function fillSelect(sel, keepIndex) {
  const prev = sel.value;
  sel.innerHTML = state.players.map((p) => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('');
  if (state.players.some((p) => p.id === prev)) sel.value = prev;
  else if (state.players[keepIndex]) sel.value = state.players[keepIndex].id;
}

function renderPlayerSelects() {
  for (const [a, b] of [['#oddsA', '#oddsB'], ['#muA', '#muB']]) { fillSelect($(a), 0); fillSelect($(b), 1); }
  const sels = $$('#matchForm .playerSelect');
  sels.forEach((s, i) => fillSelect(s, i));
}

// ---------- odds ----------
async function loadOdds() {
  const a = $('#oddsA').value, b = $('#oddsB').value;
  const box = $('#markets');
  if (state.players.length < 2) {
    box.innerHTML = '<div class="card empty">Add at least two players on the Players tab and the bookies will open for business. 📈</div>';
    $('#oddsMeta').textContent = ''; return;
  }
  if (!a || !b || a === b) { box.innerHTML = '<div class="card empty">Pick two different players. Nobody\'s betting on a mirror match.</div>'; return; }
  try {
    const book = await api('GET', `/api/odds?a=${encodeURIComponent(a)}&b=${encodeURIComponent(b)}`);
    const s = book.sample;
    const conf = s.h2h >= 10 ? 'high' : s.a + s.b >= 15 ? 'medium' : 'low';
    $('#oddsMeta').innerHTML = `Based on <b>${s.a}</b> games for ${esc(book.nameA)}, <b>${s.b}</b> for ${esc(book.nameB)}, <b>${s.h2h}</b> head-to-head
      (${book.h2h.aWins}-${book.h2h.bWins}-${book.h2h.draws}). Confidence: <span class="tag ${conf}">${conf}</span>`;
    box.innerHTML = book.markets.map((m) => `
      <div class="card market">
        <h4>${esc(m.name)}</h4><p class="muted">${esc(m.blurb)}</p>
        <div class="sels">${m.selections.map((sel) => `
          <button class="price" data-market="${esc(m.key)}" data-mname="${esc(m.name)}" data-sel="${esc(sel.key)}"
            data-label="${esc(sel.label)}" data-dec="${sel.decimal}" data-frac="${esc(sel.fractional)}">
            <span class="lbl">${esc(sel.label)}</span>
            <span class="odd">${sel.fractional}<small>${sel.decimal.toFixed(2)} · ${(sel.p * 100).toFixed(1)}%</small></span>
          </button>`).join('')}</div>
      </div>`).join('');
  } catch (e) { box.innerHTML = `<div class="card empty">${esc(e.message)}</div>`; }
}
$('#oddsA').addEventListener('change', loadOdds);
$('#oddsB').addEventListener('change', loadOdds);

$('#markets').addEventListener('click', (e) => {
  const b = e.target.closest('.price'); if (!b) return;
  slip = { a: $('#oddsA').value, b: $('#oddsB').value, market: b.dataset.market, marketName: b.dataset.mname,
    selection: b.dataset.sel, label: b.dataset.label, decimal: +b.dataset.dec, fractional: b.dataset.frac };
  renderSlip();
});

function renderSlip() {
  const body = $('#slipBody');
  if (!slip) { body.innerHTML = 'Tap any price to add it here.'; body.className = 'muted'; return; }
  body.className = '';
  body.innerHTML = `
    <div class="slip-sel"><b>${esc(slip.label)}</b><br><span class="muted">${esc(nameOf(slip.a))} v ${esc(nameOf(slip.b))} · ${esc(slip.marketName)}</span>
      <div class="big-odd">${slip.fractional} <small>(${slip.decimal.toFixed(2)})</small></div></div>
    <label>Bettor<select id="slipBettor">${state.players.map((p) => `<option value="${esc(p.id)}">${esc(p.name)} (${p.coins} 🪙)</option>`).join('')}</select></label>
    <label>Stake (coins)<input id="slipStake" type="number" min="1" value="50"></label>
    <div id="slipReturn" class="muted"></div>
    <button class="primary" id="slipPlace">Place Bet</button>
    <button id="slipClear">Clear</button>`;
  const upd = () => ($('#slipReturn').textContent = `Potential return: ${Math.round((+$('#slipStake').value || 0) * slip.decimal)} coins`);
  $('#slipStake').addEventListener('input', upd); upd();
  $('#slipClear').onclick = () => { slip = null; renderSlip(); };
  $('#slipPlace').onclick = async () => {
    try {
      await api('POST', '/api/bets', { bettor: $('#slipBettor').value, a: slip.a, b: slip.b, market: slip.market, selection: slip.selection, stake: $('#slipStake').value });
      toast('Bet placed. No refunds, no crying. 🎰');
      slip = null; renderSlip(); refresh();
    } catch (e) { toast(e.message, true); }
  };
}

// ---------- bets ----------
function renderBets() {
  const ranked = [...state.players].sort((x, y) => y.coins - x.coins);
  $('#leaderboard').innerHTML = ranked.length ? `<table><tr><th>#</th><th>Player</th><th>Coins</th><th>Open</th></tr>${ranked.map((p, i) => `
    <tr><td>${i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : i + 1}</td><td>${esc(p.name)}</td><td><b>${p.coins}</b></td>
    <td>${state.bets.filter((b) => b.bettor === p.id && b.status === 'open').length}</td></tr>`).join('')}</table>` : '<p class="muted">No players yet.</p>';
  const bets = [...state.bets].reverse();
  $('#betList').innerHTML = bets.length ? `<table><tr><th>Bettor</th><th>Bet</th><th>Odds</th><th>Stake</th><th>Status</th><th></th></tr>${bets.map((b) => `
    <tr><td>${esc(nameOf(b.bettor))}</td><td>${esc(b.label)}<br><small class="muted">${fmtDate(b.placedAt)}</small></td>
    <td>${esc(b.fractional)}</td><td>${b.stake}</td>
    <td><span class="tag ${b.status}">${b.status}${b.status === 'won' ? ' +' + b.payout : ''}</span></td>
    <td>${b.status === 'open' ? `<button class="small" data-void="${b.id}">Void</button>` : ''}</td></tr>`).join('')}</table>`
    : '<p class="muted">No bets yet. Cowards.</p>';
}
$('#betList').addEventListener('click', async (e) => {
  const id = e.target.dataset.void; if (!id) return;
  try { await api('POST', `/api/bets/${id}/void`); toast('Bet voided, stake refunded.'); refresh(); } catch (err) { toast(err.message, true); }
});

// ---------- log match ----------
function resetMatchForm() {
  const f = $('#matchForm'); f.reset(); f.matchId.value = '';
  $('#logTitle').textContent = 'Log a Triple Draft Battle';
  $('#logSubmit').textContent = 'Log Match';
  $('#logCancel').classList.add('hidden');
  renderPlayerSelects();
}

$('#matchForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const body = Object.fromEntries(new FormData(e.target));
  const id = body.matchId; delete body.matchId;
  if (body.date) body.date = new Date(body.date).toISOString(); else delete body.date; // blank = right now
  try {
    if (id) { await api('PUT', `/api/matches/${id}`, body); toast('Match updated.'); }
    else { await api('POST', '/api/matches', body); toast('Match logged. Open bets on this matchup have been settled. 💸'); }
    resetMatchForm(); refresh();
  } catch (err) { toast(err.message, true); }
});
$('#logCancel').onclick = resetMatchForm;

function needsDetails(m) { return m.overtime == null || m.dmgA == null || m.dmgB == null || m.firstCrown == null; }

function renderMatches() {
  const list = [...state.matches].reverse();
  $('#matchList').innerHTML = list.length ? `<table><tr><th>When</th><th>Match</th><th>OT</th><th>1k dmg A/B</th><th>1st tower</th><th></th></tr>${list.map((m) => {
    const winA = m.winner === 'A', winB = m.winner === 'B';
    return `<tr>
      <td><small>${fmtDate(m.date)}</small><br>${m.source === 'api' ? '<span class="tag">API</span>' : ''} ${needsDetails(m) ? '<span class="tag warn">needs details</span>' : ''}</td>
      <td><span class="${winA ? 'win' : ''}">${esc(m.nameA)}</span> <b>${m.crownsA}–${m.crownsB}</b> <span class="${winB ? 'win' : ''}">${esc(m.nameB)}</span>
        ${m.crownsA === m.crownsB && m.winner !== 'draw' ? '<span class="tag">TB</span>' : ''}${m.winner === 'draw' ? '<span class="tag">Draw</span>' : ''}
        ${m.notes ? `<br><small class="muted">${esc(m.notes)}</small>` : ''}</td>
      <td>${yn(m.overtime)}</td><td>${yn(m.dmgA)} / ${yn(m.dmgB)}</td>
      <td>${m.firstCrown == null ? '?' : m.firstCrown === 'none' ? '—' : esc(m.firstCrown === 'A' ? m.nameA : m.nameB)}</td>
      <td class="nowrap"><button class="small" data-edit="${m.id}">Edit</button> <button class="small danger" data-del="${m.id}">✕</button></td></tr>`;
  }).join('')}</table>` : '<p class="muted">No matches yet. Go play some!</p>';
}

$('#matchList').addEventListener('click', async (e) => {
  const { edit, del } = e.target.dataset;
  if (del) {
    if (!confirm('Delete this match? Any bets it settled go back to open.')) return;
    try { await api('DELETE', `/api/matches/${del}`); toast('Match deleted.'); refresh(); } catch (err) { toast(err.message, true); }
  }
  if (edit) {
    const m = state.matches.find((x) => x.id === edit);
    const f = $('#matchForm');
    // Make sure non-registered opponents (from API imports) are selectable
    for (const sel of $$('.playerSelect', f)) {
      for (const [id, name] of [[m.playerA, m.nameA], [m.playerB, m.nameB]]) {
        if (![...sel.options].some((o) => o.value === id)) sel.add(new Option(name, id));
      }
    }
    f.matchId.value = m.id; f.playerA.value = m.playerA; f.playerB.value = m.playerB;
    f.crownsA.value = m.crownsA; f.crownsB.value = m.crownsB;
    f.winner.value = m.crownsA === m.crownsB ? m.winner : '';
    const tri = (v) => (v == null ? '' : v ? 'yes' : 'no');
    f.overtime.value = tri(m.overtime); f.dmgA.value = tri(m.dmgA); f.dmgB.value = tri(m.dmgB);
    f.firstCrown.value = m.firstCrown || '';
    const d = new Date(m.date); d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
    f.date.value = d.toISOString().slice(0, 16);
    f.cardsA.value = m.cardsA.join(', '); f.cardsB.value = m.cardsB.join(', '); f.notes.value = m.notes || '';
    $('#logTitle').textContent = `Editing ${m.nameA} v ${m.nameB}`;
    $('#logSubmit').textContent = 'Save Changes';
    $('#logCancel').classList.remove('hidden');
    f.scrollIntoView({ behavior: 'smooth' });
  }
});

// ---------- players ----------
function renderPlayers() {
  $('#apiStatus').innerHTML = state.apiConfigured
    ? '✅ Clash API key loaded — syncing pulls each player\'s trophies and their recent triple draft friendlies.'
    : '⚠️ No Clash API key set, so syncing is off. You can still add players by name and log matches by hand. See the README to plug a key in.';
  $('#syncAll').disabled = !state.apiConfigured;
  $('#playerList').innerHTML = state.players.length ? `<table><tr><th>Player</th><th>Tag</th><th>Trophies</th><th>PB</th><th>Clan</th><th>Coins</th><th>Last sync</th><th></th></tr>${state.players.map((p) => `
    <tr><td><b>${esc(p.name)}</b>${p.igName && p.igName !== p.name ? `<br><small class="muted">in-game: ${esc(p.igName)}</small>` : ''}</td><td><small>${esc(p.tag || '—')}</small></td><td>${p.trophies ?? '—'}</td><td>${p.bestTrophies ?? '—'}</td>
    <td>${esc(p.clan || '—')}</td><td>${p.coins}</td><td><small>${p.lastSynced ? fmtDate(p.lastSynced) : 'never'}</small></td>
    <td class="nowrap">${p.tag && state.apiConfigured ? `<button class="small" data-sync="${esc(p.id)}">⟳</button>` : ''}
      <button class="small" data-coins="${esc(p.id)}">🪙</button>
      <button class="small danger" data-remove="${esc(p.id)}">✕</button></td></tr>`).join('')}</table>`
    : '<p class="muted">No players yet. Add the squad above.</p>';
}

$('#playerForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const body = Object.fromEntries(new FormData(e.target));
  try {
    const p = await api('POST', '/api/players', body);
    e.target.reset();
    toast(`${p.name} has joined the degenerates.`);
    if (p.tag && state.apiConfigured) await syncOne(p.id);
    refresh();
  } catch (err) { toast(err.message, true); }
});

async function syncOne(id) {
  try {
    const r = await api('POST', `/api/players/${encodeURIComponent(id)}/sync`);
    toast(`${r.player}: imported ${r.imported} new triple draft match(es) from the last ${r.scanned} battles.`);
  } catch (err) { toast(err.message, true); }
}

$('#syncAll').onclick = async () => {
  try {
    const rs = await api('POST', '/api/sync-all');
    const errs = rs.filter((r) => r.error);
    toast(errs.length ? `Synced with errors: ${errs.map((r) => r.player + ': ' + r.error).join('; ')}`
      : `Synced ${rs.length} players, imported ${rs.reduce((t, r) => t + (r.imported || 0), 0)} new matches.`, errs.length > 0);
    refresh();
  } catch (err) { toast(err.message, true); }
};

$('#playerList').addEventListener('click', async (e) => {
  const { sync, remove, coins } = e.target.dataset;
  if (sync) { await syncOne(sync); refresh(); }
  if (remove && confirm(`Remove ${nameOf(remove)}? Their matches stay in the history.`)) {
    await api('DELETE', `/api/players/${encodeURIComponent(remove)}`); refresh();
  }
  if (coins) {
    const v = prompt(`Set ${nameOf(coins)}'s coin balance:`, state.players.find((p) => p.id === coins).coins);
    if (v != null) { await api('POST', `/api/players/${encodeURIComponent(coins)}/coins`, { coins: v }); refresh(); }
  }
});

// ---------- insights ----------
const pctCell = (v) => (v == null ? '<span class="muted">—</span>' : v + '%');
const formStr = (f) => f.map((r) => `<span class="form ${r}">${r}</span>`).join('');

async function loadInsights() {
  const ins = await api('GET', '/api/insights');
  $('#statTable').innerHTML = ins.players.length ? `<table><tr><th>Player</th><th>GP</th><th>W-L-D</th><th>Win%</th><th>3-crown% of wins</th><th>OT%</th><th>1k dmg%</th><th>1st tower%</th><th>Crowns for/against</th><th>Form</th></tr>
    ${ins.players.map((p) => `<tr><td><b>${esc(p.name)}</b>${p.igName && p.igName !== p.name ? `<br><small class="muted">in-game: ${esc(p.igName)}</small>` : ''}</td><td>${p.games}</td><td>${p.wins}-${p.losses}-${p.draws}</td><td>${pctCell(p.winPct)}</td>
    <td>${pctCell(p.threeCrownPct)}</td><td>${pctCell(p.otPct)}</td><td>${pctCell(p.dmgPct)}</td><td>${pctCell(p.firstPct)}</td>
    <td>${p.avgCrowns ?? '—'} / ${p.avgCrownsAgainst ?? '—'}</td><td>${formStr(p.form)}</td></tr>`).join('')}</table>` : '<p class="muted">No players.</p>';

  const ps = state.players;
  $('#h2hGrid').innerHTML = ps.length > 1 ? `<table class="grid"><tr><th></th>${ps.map((p) => `<th>${esc(p.name)}</th>`).join('')}</tr>
    ${ps.map((a) => `<tr><th>${esc(a.name)}</th>${ps.map((b) => {
      if (a.id === b.id) return '<td class="muted">—</td>';
      const r = ins.h2h[a.id][b.id]; const n = r.w + r.l + r.d;
      const cls = !n ? '' : r.w > r.l ? 'up' : r.w < r.l ? 'down' : '';
      return `<td class="${cls}">${n ? `${r.w}-${r.l}-${r.d}` : '·'}</td>`;
    }).join('')}</tr>`).join('')}</table>` : '<p class="muted">Need two players.</p>';

  $('#cardTable').innerHTML = ins.cards.length ? `<table><tr><th>Card</th><th>Times drafted</th><th>Win%</th><th>3-crown%</th><th>Avg crowns</th></tr>
    ${ins.cards.slice(0, 60).map((c) => `<tr><td>${esc(c.card)}</td><td>${c.games}</td><td>${pctCell(c.winPct)}</td><td>${pctCell(c.threeCrownPct)}</td><td>${c.avgCrowns}</td></tr>`).join('')}</table>`
    : '<p class="muted">No decks logged yet. Add drafted cards when logging matches (API imports include them automatically).</p>';
  $('#cardList').innerHTML = ins.cards.map((c) => `<option value="${esc(c.card)}">`).join('');
  loadMatchup();
}

async function loadMatchup() {
  const a = $('#muA').value, b = $('#muB').value;
  if (!a || !b || a === b) { $('#matchupOut').innerHTML = '<p class="muted">Pick two different players.</p>'; return; }
  const mu = await api('GET', `/api/matchup?a=${encodeURIComponent(a)}&b=${encodeURIComponent(b)}`);
  if (!mu.games) { $('#matchupOut').innerHTML = '<p class="muted">These two have never played each other. Fix that.</p>'; return; }
  const A = esc(nameOf(a)), B = esc(nameOf(b));
  const lines = Object.entries(mu.scorelines).sort((x, y) => y[1] - x[1]).map(([k, n]) => {
    const [w, sc] = k.split(':');
    return `<span class="chip">${w === 'D' ? 'Draw' : w === 'A' ? A : B} ${sc} <b>×${n}</b></span>`;
  }).join('');
  $('#matchupOut').innerHTML = `
    <div class="stat-row">
      <div><b>${mu.aWins}</b><span>${A} wins</span></div><div><b>${mu.draws}</b><span>Draws</span></div><div><b>${mu.bWins}</b><span>${B} wins</span></div>
      <div><b>${mu.aThree}</b><span>${A} 3-crowns</span></div><div><b>${mu.bThree}</b><span>${B} 3-crowns</span></div>
      <div><b>${mu.byOne}</b><span>Won by 1 tower</span></div><div><b>${mu.otKnown ? mu.overtime + '/' + mu.otKnown : '—'}</b><span>Went to OT</span></div>
    </div>
    <p>Scorelines (${A}–${B}): ${lines}</p>
    <table><tr><th>When</th><th>Score</th><th>${A}'s deck</th><th>${B}'s deck</th></tr>${[...mu.matches].reverse().map((o) => `
      <tr><td><small>${fmtDate(o.date)}</small></td><td><b>${o.myCrowns}–${o.oppCrowns}</b> ${o.result}</td>
      <td><small>${esc(o.myCards.join(', ') || '—')}</small></td><td><small>${esc(o.oppCards.join(', ') || '—')}</small></td></tr>`).join('')}</table>`;
}
$('#muA').addEventListener('change', loadMatchup);
$('#muB').addEventListener('change', loadMatchup);

// ---------- settings ----------
function renderSettings() {
  const f = $('#settingsForm');
  for (const k of ['margin', 'startingCoins', 'modeRegex', 'typeRegex']) if (document.activeElement !== f[k]) f[k].value = state.settings[k];
}
$('#settingsForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  try { await api('PUT', '/api/settings', Object.fromEntries(new FormData(e.target))); toast('Settings saved.'); refresh(); }
  catch (err) { toast(err.message, true); }
});

resetMatchForm();
refresh();
