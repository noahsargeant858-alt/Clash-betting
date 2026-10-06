'use strict';

// Pulls the official battles feed and runs scripts/daily-import.js against the store, the same way the
// scheduled session did: build a work directory in the layout the script documents, run it, apply the
// batch files it writes as system writes, delete the directory.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { SEGMENT } = require('./rules');

const MAX_FEED = 5 * 1024 * 1024;
const DAY = 86400e3;
const safeId = (id) => SEGMENT.test(id) && id !== '.' && id !== '..';

// Players' own hand logs can end up merged into official results, so only well-formed fields are passed on
const canon = (t) => typeof t === 'string' && t.length === 24 && Number.isFinite(Date.parse(t)) && new Date(Date.parse(t)).toISOString() === t;
const txt = (v, max) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ').slice(0, max) : null);
const tri = (v) => (typeof v === 'boolean' ? v : null);
const int03 = (v) => (Number.isInteger(v) && v >= 0 && v <= 3 ? v : null);
const num = (v) => (Number.isFinite(v) && v >= 0 && v <= 100000 ? v : null);
const towers = (t) => (t && typeof t === 'object' && ['left', 'king', 'right'].every((k) => Number.isFinite(t[k]) && t[k] >= 0 && t[k] <= 100000) ? { left: t.left, king: t.king, right: t.right } : null);
const cards = (c) => (Array.isArray(c) ? c.filter((x) => typeof x === 'string').slice(0, 8).map((x) => txt(x, 40)) : []);
function cleanHandLog(x) {
  if (!x || typeof x !== 'object' || x.type !== 'match') return null;
  const pa = txt(x.playerA, 64), pb = txt(x.playerB, 64);
  if (!pa || !pb || !safeId(pa) || !safeId(pb) || !canon(x.date) || !canon(x.loggedAt) || int03(x.crownsA) === null || int03(x.crownsB) === null || !['A', 'B', 'draw'].includes(x.winner)) return null;
  const fx = typeof x.fx === 'string' && x.fx.length <= 200 && /^[A-Za-z0-9_.~:@+-]+$/.test(x.fx) ? x.fx : null;
  return {
    type: 'match', playerA: pa, playerB: pb, crownsA: x.crownsA, crownsB: x.crownsB, winner: x.winner, date: x.date, loggedAt: x.loggedAt,
    overtime: tri(x.overtime), dmgA: tri(x.dmgA), dmgB: tri(x.dmgB), kingA: tri(x.kingA), kingB: tri(x.kingB),
    firstCrown: ['A', 'B', 'none'].includes(x.firstCrown) ? x.firstCrown : null, towersA: towers(x.towersA), towersB: towers(x.towersB),
    dealtA: num(x.dealtA), dealtB: num(x.dealtB), cardsA: cards(x.cardsA), cardsB: cards(x.cardsB), notes: txt(x.notes, 400) || '', fx,
  };
}

function createImporter({ store, repoRoot, battlesUrl, intervalMin, log = () => {}, fetchImpl }) {
  let etag = null, running = null, timer = null, bootTimer = null;
  const doFetch = fetchImpl || ((...a) => fetch(...a));

  async function readLimited(res) {
    const declared = Number(res.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > MAX_FEED) throw new Error('The battles feed is too big.');
    const chunks = [];
    let size = 0;
    for await (const c of res.body) {
      size += c.length;
      if (size > MAX_FEED) throw new Error('The battles feed is too big.');
      chunks.push(c);
    }
    return Buffer.concat(chunks).toString('utf8');
  }

  const put = (dir, rel, value) => {
    const file = path.join(dir, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));
  };

  // everything the script reads about the site's current state
  function stageDocs(dir, since) {
    const versions = {};
    for (const d of store.list('players')) if (safeId(d.id)) put(dir, `db/players/${d.id}.json`, d.data);
    for (const d of store.list('links')) if (safeId(d.id)) put(dir, `db/links/${d.id}.json`, d.data);
    for (const d of store.list('matches')) {
      if (!safeId(d.id) || typeof d.data.date !== 'string' || d.data.date < since) continue;
      put(dir, `db/matches/${d.id}.json`, d.data);
      versions[`matches/${d.id}`] = d.version;
    }
    for (const coll of store.children.keys()) {
      const m = /^acts\/([^/]+)\/items$/.exec(coll);
      if (!m || !safeId(m[1])) continue;
      for (const d of store.list(coll)) {
        const clean = safeId(d.id) && d.data.type === 'match' && typeof d.data.date === 'string' && d.data.date >= since ? cleanHandLog(d.data) : null;
        if (clean) put(dir, `db/acts/${m[1]}/items/${d.id}.json`, clean);
      }
    }
    const state = store.get('config/importState');
    if (state) versions['config/importState'] = state.version;
    put(dir, 'versions.json', versions);
  }

  function runScript(dir) {
    return new Promise((resolve, reject) => {
      // a bare environment: the script needs nothing, and must never see the site's secrets
      execFile(process.execPath, ['--max-old-space-size=256', path.join(repoRoot, 'scripts', 'daily-import.js'), dir],
        { timeout: 60000, maxBuffer: 4 * 1024 * 1024, cwd: dir, env: { NODE_ENV: 'production' } }, (err, stdout, stderr) => {
          if (err) return reject(new Error(`daily-import.js failed: ${String(stderr || err.message).trim().split('\n')[0].slice(0, 300)}`));
          resolve(String(stdout));
        });
    });
  }

  function applyBatches(dir, lines) {
    const root = path.resolve(dir) + path.sep;
    const batches = fs.readdirSync(dir).filter((f) => /^batch-\d+\.json$/.test(f)).sort((a, b) => parseInt(a.slice(6), 10) - parseInt(b.slice(6), 10));
    let applied = 0, skipped = 0;
    for (const f of batches) {
      const writes = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      for (const w of Array.isArray(writes) ? writes : []) {
        const where = w && `${w.collection}/${w.doc_id}`;
        try {
          // only what the script is meant to write, and only files inside the work directory
          if (!w || w.op !== 'set' || !['matches', 'config'].includes(w.collection) || typeof w.doc_id !== 'string' || typeof w.file_path !== 'string'
            || !path.resolve(w.file_path).startsWith(root)) throw new Error('not a write the importer accepts');
          const data = JSON.parse(fs.readFileSync(path.resolve(w.file_path), 'utf8'));
          store.write('set', where, data, { ifVersion: Number.isInteger(w.if_version) ? w.if_version : undefined });
          applied++;
        } catch (e) {
          skipped++;
          const why = e.status === 409 ? 'it changed on the site meanwhile' : e.message;
          lines.push(`SKIPPED write to ${where}: ${why}`);
        }
      }
    }
    return { applied, skipped };
  }

  async function doImport() {
    if (!battlesUrl) return { summary: 'No battles feed is set up (BATTLES_URL).', newResults: 0, checks: 0, skipped: 0, applied: 0 };
    const now = new Date();
    const nowIso = now.toISOString(), since = new Date(now.getTime() - 7 * DAY).toISOString();

    const res = await doFetch(battlesUrl, { headers: { Accept: 'application/json', 'User-Agent': 'clashbets-site', ...(etag ? { 'If-None-Match': etag } : {}) }, signal: AbortSignal.timeout(30000) });
    if (res.status === 304) return { summary: 'The battles feed has not changed; nothing to do.', newResults: 0, checks: 0, skipped: 0, applied: 0, unchanged: true };
    if (!res.ok) throw new Error(`The battles feed answered HTTP ${res.status}.`);
    const text = await readLimited(res);
    if (text.trimStart()[0] !== '{') throw new Error('The battles feed was not in the expected shape.'); // the script below does the real parsing, in its own process
    const newTag = res.headers.get('etag');

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clashbets-import-'));
    try {
      put(dir, 'battles.json', text);
      put(dir, 'squad.json', fs.readFileSync(path.join(repoRoot, 'squad.json'), 'utf8'));
      put(dir, 'window.json', { since, now: nowIso });
      stageDocs(dir, since);
      const out = await runScript(dir);
      const lines = out.split('\n').map((l) => l.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').trim().slice(0, 300)).filter(Boolean);
      const { applied, skipped } = applyBatches(dir, lines);
      if (!skipped && newTag) etag = newTag; // a skipped write is retried next time rather than waved through as "unchanged"
      const newResults = lines.filter((l) => l.startsWith('New:')).length;
      const notes = lines.filter((l) => /^(CHECK|SKIPPED)/.test(l));
      const summary = `${lines.join('\n')}\nApplied ${applied} write${applied === 1 ? '' : 's'}${skipped ? `, skipped ${skipped}` : ''}.`;
      return { summary, newResults, checks: notes.filter((l) => l.startsWith('CHECK')).length, skipped: notes.filter((l) => l.startsWith('SKIPPED')).length, applied, notes };
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  // one import at a time; a second caller joins the one already running
  function runImport() {
    if (!running) {
      running = doImport().then((r) => {
        log(`[import] ${r.unchanged ? 'feed unchanged' : `${r.newResults} new result${r.newResults === 1 ? '' : 's'}, ${r.checks} CHECK, ${r.skipped} SKIPPED, ${r.applied} written`}`);
        for (const n of r.notes || []) log(`[import] ${n}`);
        return r;
      }).finally(() => { running = null; });
    }
    return running;
  }

  const tick = () => runImport().catch((e) => log(`[import] failed: ${e.message}`));

  function start() {
    if (!(intervalMin > 0) || !battlesUrl) return;
    bootTimer = setTimeout(tick, 10000);
    timer = setInterval(tick, intervalMin * 60e3);
    bootTimer.unref(); timer.unref();
  }

  function stop() { clearTimeout(bootTimer); clearInterval(timer); bootTimer = timer = null; }

  return { runImport, start, stop };
}

module.exports = { createImporter, cleanHandLog };
