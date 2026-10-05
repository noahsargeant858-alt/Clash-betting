'use strict';

// Browser half of the ClashBets website. The page was written for claude.ai's artifact platform and
// only knows window.claude.use('db' | 'user'); this file provides both over the site's own HTTP API,
// keeps one live copy of whatever the page subscribes to, and adds the Account button plus, for the
// owner, the accounts and invite links panel. Plain browser code, no dependencies. Anything that came
// from the server or from another person goes into the page with textContent, never as HTML.
(function () {
  const SEG = /^[A-Za-z0-9_\-.~:@+]{1,200}$/;
  const clone = typeof structuredClone === 'function' ? structuredClone : (v) => JSON.parse(JSON.stringify(v));
  const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

  // ---------- small helpers ----------
  const sleepers = new Set();
  const idle = (ms) => new Promise((resolve) => {
    const done = () => { clearTimeout(t); sleepers.delete(done); resolve(); };
    const t = setTimeout(done, ms);
    sleepers.add(done);
  });
  const wakeAll = () => { for (const f of [...sleepers]) f(); };
  const never = () => new Promise(() => {});

  function fail(code, message, status) {
    const e = new Error(message || code);
    e.code = code; e.status = status || 0;
    return e;
  }
  // The page reads error.code: only 400 and 403 may say invalid_argument (it shows "view-only" for that)
  function codeFor(status) {
    if (status === 400 || status === 403) return 'invalid_argument';
    if (status === 429) return 'resource_exhausted';
    if (status === 413 || status === 507) return 'quota_exceeded';
    if (status === 404) return 'not_found';
    if (status === 409) return 'aborted';
    return 'unavailable';
  }
  function plainError(status) {
    if (status === 429) return 'Too many tries. Wait a minute and try again.';
    if (status === 403) return 'You can\'t do that.';
    if (status >= 500) return 'Something went wrong on the server. Try again in a moment.';
    return 'That didn\'t work.';
  }

  // ---------- talking to the server ----------
  let leaving = false;
  function toLogin() {
    if (leaving) return;
    leaving = true;
    const here = location.pathname + location.search;
    location.replace('/login' + (here === '/' ? '' : '?next=' + encodeURIComponent(here)));
  }
  async function request(method, url, body, opts) {
    const o = opts || {};
    const init = { method, credentials: 'same-origin', cache: 'no-store', headers: { 'X-CB': '1' }, signal: o.signal };
    if (body !== undefined) { init.headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(body); }
    let res;
    try { res = await fetch(url, init); } catch (e) { throw fail('unavailable', 'Couldn\'t reach the server. Check your connection.', 0); }
    let data = null;
    try { data = await res.json(); } catch (e) { /* no JSON body */ }
    if (res.status === 401 && !o.keep401) { toLogin(); throw fail('unauthenticated', 'Please sign in.', 401); }
    if (!res.ok) throw fail(codeFor(res.status), (data && typeof data.error === 'string' && data.error) || plainError(res.status), res.status);
    return data || {};
  }
  // Reads are retried a few times when the network blips; anything the server answered is final
  async function withRetry(fn) {
    for (let n = 0; ; n++) {
      try { return await fn(); } catch (e) { if (e.code !== 'unavailable' || n >= 3) throw e; await idle([800, 2000, 5000][n]); }
    }
  }

  // ---------- who is signed in ----------
  let me = null, meReady = null;
  function loadMe() {
    if (!meReady) {
      meReady = (async () => {
        for (let n = 0; ; n++) {
          try { me = await request('GET', '/api/auth/me'); setOnline(true); return me; } catch (e) {
            if (e.code === 'unauthenticated') await never(); // already on its way to the sign-in page
            setOnline(false, true);
            await idle(Math.min(10000, 1000 * (n + 1)));
          }
        }
      })();
    }
    return meReady;
  }
  async function refreshMe() {
    me = await request('GET', '/api/auth/me');
    renderAccount();
    return me;
  }

  // ---------- one live copy of what the page watches ----------
  const colls = new Map();       // collection path -> Map(id -> {data, version, own})
  const loadedColls = new Set(); // collections listed in full (their snapshots are complete)
  const loadedDocs = new Set();  // single documents fetched on their own
  const seqAt = new Map();       // path -> newest server seq we know it at (also for deleted docs)
  const collSubs = new Map(), docSubs = new Map();
  const snapCache = new Map();
  const dirtyColls = new Set(), dirtyDocs = new Set();

  const parentOf = (p) => p.slice(0, p.lastIndexOf('/'));
  const tracked = (p) => loadedColls.has(parentOf(p)) || loadedDocs.has(p);
  function addTo(map, key, v) { if (!map.has(key)) map.set(key, new Set()); map.get(key).add(v); }
  function dropFrom(map, key, v) { const s = map.get(key); if (s) { s.delete(v); if (!s.size) map.delete(key); } }

  // Put what we learnt about one document into the mirror. Anything older than what we already
  // know is ignored, so a slow answer can never undo a newer change (or the caller's own write).
  function applyDoc(path, exists, data, version, seq, own) {
    if ((seqAt.get(path) || 0) > seq) return;
    if (seqAt.size > 50000) seqAt.clear();
    seqAt.set(path, seq);
    if (!tracked(path)) return;
    const coll = parentOf(path), id = path.slice(coll.length + 1);
    let kids = colls.get(coll);
    if (!kids) colls.set(coll, (kids = new Map()));
    const cur = kids.get(id);
    if (!exists) { if (!cur) return; kids.delete(id); }
    else {
      // our own write coming back from the change feed: nothing new
      if (cur && cur.own && cur.version === version) { cur.own = false; return; }
      kids.set(id, { data, version, own: !!own });
    }
    dirtyColls.add(coll); dirtyDocs.add(path); snapCache.delete(coll);
  }
  function applyList(coll, docs, seq) {
    loadedColls.add(coll);
    const seen = new Set();
    for (const d of docs) { seen.add(d.id); applyDoc(coll + '/' + d.id, true, d.data, d.version, seq, false); }
    const kids = colls.get(coll);
    if (kids) for (const id of [...kids.keys()]) if (!seen.has(id)) applyDoc(coll + '/' + id, false, null, 0, seq, false);
    dirtyColls.add(coll); snapCache.delete(coll);
  }

  const lookup = (path) => { const k = colls.get(parentOf(path)); return (k && k.get(path.slice(parentOf(path).length + 1))) || null; };
  function docSnap(path) {
    const ent = lookup(path), id = path.slice(path.lastIndexOf('/') + 1);
    return { id, path, exists: !!ent, data: () => (ent ? clone(ent.data) : undefined) };
  }
  function collSnap(path) {
    let snap = snapCache.get(path);
    if (snap) return snap;
    const kids = colls.get(path) || new Map();
    const docs = [...kids.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)).map((id) => {
      const ent = kids.get(id);
      return { id, path: path + '/' + id, exists: true, data: () => clone(ent.data) };
    });
    snap = { docs, size: docs.length, empty: !docs.length, forEach: (fn) => docs.forEach(fn) };
    snapCache.set(path, snap);
    return snap;
  }

  // Calls the page's listeners once per change batch; a listener that throws never stops the others
  let flushQueued = false;
  function flush() {
    if (flushQueued) return;
    flushQueued = true;
    queueMicrotask(() => {
      flushQueued = false;
      const cs = [...dirtyColls], ds = [...dirtyDocs];
      dirtyColls.clear(); dirtyDocs.clear();
      for (const c of cs) if (loadedColls.has(c)) for (const sub of [...(collSubs.get(c) || [])]) if (sub.ready) deliver(sub, collSnap(c));
      for (const d of ds) if (tracked(d)) for (const sub of [...(docSubs.get(d) || [])]) if (sub.ready) deliver(sub, docSnap(d));
    });
  }
  function deliver(sub, snap) {
    if (!sub.live) return;
    try { sub.next(snap); } catch (e) { console.error(e); }
  }
  function fire(sub, e) {
    if (!sub.live || e.code === 'unauthenticated' || typeof sub.error !== 'function') return;
    try { sub.error(e); } catch (x) { console.error(x); }
  }

  // ---------- fetching ----------
  const loading = new Map();
  async function listColl(path) {
    const r = await withRetry(() => request('GET', '/api/db/list?collection=' + encodeURIComponent(path)));
    applyList(path, Array.isArray(r.docs) ? r.docs : [], r.seq);
    noteSeq(r.seq);
    flush();
    return r.seq;
  }
  async function fetchDoc(path) {
    const r = await withRetry(() => request('GET', '/api/db/doc?path=' + encodeURIComponent(path)));
    loadedDocs.add(path);
    applyDoc(path, !!r.exists, r.data, r.version, r.seq, false);
    dirtyDocs.add(path);
    noteSeq(r.seq);
    flush();
    return r.seq;
  }
  function once(key, make) {
    let p = loading.get(key);
    if (!p) { p = make().finally(() => loading.delete(key)); loading.set(key, p); }
    return p;
  }
  const ensureColl = (path) => (loadedColls.has(path) ? Promise.resolve() : once('c:' + path, () => listColl(path)));
  const ensureDoc = (path) => (tracked(path) ? Promise.resolve() : once('d:' + path, () => fetchDoc(path)));

  // ---------- the change feed (one long poll for the whole page) ----------
  let cursor = null, polling = false, pollOpen = null, abortWhy = null, pollCtl = null;
  function noteSeq(seq) {
    if (!Number.isFinite(seq)) return;
    if (cursor === null) { cursor = seq; startPoll(); }
    else if (seq < cursor) { cursor = seq; restartPoll(); }
  }
  function startPoll() { if (!polling) { polling = true; pollLoop(); } }
  function restartPoll() { if (pollOpen) { abortWhy = 'restart'; pollCtl.abort(); } else wakeAll(); }
  function applyChange(c, seq) {
    if (c && typeof c.path === 'string' && tracked(c.path)) applyDoc(c.path, !!c.exists, c.data, c.version, seq, false);
  }
  async function relistAll() {
    seqAt.clear();
    const seqs = await Promise.all([...[...loadedColls].map(listColl), ...[...loadedDocs].map(fetchDoc)]);
    return seqs.length ? Math.min(...seqs) : null;
  }
  async function pollLoop() {
    let bad = 0;
    for (;;) {
      // after an outage, find out the server is back before holding a long poll that would hide it
      if (!online) {
        try { await request('GET', '/api/auth/me'); setOnline(true); bad = 0; } catch (e) {
          if (e.code === 'unauthenticated') return;
          bad++; await idle(Math.min(15000, 1000 * 2 ** Math.min(bad, 4)));
          continue;
        }
      }
      pollCtl = new AbortController();
      const timer = setTimeout(() => { abortWhy = 'timeout'; pollCtl.abort(); }, 40000);
      const t0 = Date.now();
      try {
        pollOpen = true; abortWhy = null;
        const r = await request('GET', '/api/changes?since=' + cursor + '&wait=25', undefined, { signal: pollCtl.signal });
        pollOpen = false; clearTimeout(timer);
        bad = 0; setOnline(true);
        const list = Array.isArray(r.changes) ? r.changes : [];
        if (r.reset || r.seq < cursor) {
          const s = await relistAll();
          cursor = s === null ? r.seq : Math.min(s, r.seq);
        } else {
          for (const c of list) applyChange(c, r.seq);
          cursor = r.seq;
          flush();
        }
        // answered at once with nothing (another tab took the slot): don't spin
        if (!list.length && Date.now() - t0 < 1500) await idle(1500 + Math.random() * 1500);
      } catch (e) {
        pollOpen = false; clearTimeout(timer);
        if (e.code === 'unauthenticated') return;
        if (abortWhy === 'restart') { abortWhy = null; continue; }
        bad++; setOnline(false);
        await idle(Math.min(15000, 1000 * 2 ** Math.min(bad, 4)));
      }
    }
  }
  document.addEventListener('visibilitychange', () => { if (!document.hidden) restartPoll(); });
  window.addEventListener('online', restartPoll);
  window.addEventListener('offline', () => { setOnline(false, true); restartPoll(); });
  window.addEventListener('pageshow', (e) => { if (e.persisted) restartPoll(); });

  // ---------- online / offline indicator ----------
  let online = true, misses = 0;
  function setOnline(ok, now) {
    misses = ok ? 0 : misses + 1;
    const next = ok || !(now || misses >= 2);
    if (next === online) return;
    online = next;
    renderOnline();
  }

  // ---------- window.claude.use('db') ----------
  function cleanPath(path, wantDoc) {
    const parts = String(path == null ? '' : path).split('/').filter((s) => s !== '');
    if (!parts.length || parts.length > 16 || parts.some((s) => s === '.' || s === '..' || !SEG.test(s))) throw fail('invalid_argument', 'That isn\'t a valid path.');
    if ((parts.length % 2 === 0) !== wantDoc) throw fail('invalid_argument', wantDoc ? 'A document path needs an even number of parts.' : 'A collection path needs an odd number of parts.');
    return parts.join('/');
  }
  function observer(next, error) {
    if (typeof next === 'function') return { next, error };
    if (next && typeof next.next === 'function') return { next: (s) => next.next(s), error: typeof next.error === 'function' ? (e) => next.error(e) : undefined };
    throw fail('invalid_argument', 'onSnapshot needs a function.');
  }
  function subscribe(path, subs, ensure, next, error) {
    const o = observer(next, error);
    const sub = { next: o.next, error: o.error, live: true, ready: false };
    addTo(subs, path, sub);
    ensure(path).then(() => { if (sub.live) { sub.ready = true; deliver(sub, subs === collSubs ? collSnap(path) : docSnap(path)); } }, (e) => fire(sub, e));
    return () => { sub.live = false; dropFrom(subs, path, sub); };
  }

  function docRef(path) {
    const id = path.slice(path.lastIndexOf('/') + 1);
    async function write(op, data, opts) {
      const body = { op, path };
      if (data !== undefined) body.data = data;
      if (opts && opts.ifVersion != null) body.ifVersion = opts.ifVersion;
      return request('POST', '/api/db/write', body);
    }
    function plain(data) {
      if (!isObj(data)) throw fail('invalid_argument', 'A document has to be an object.');
      try { return JSON.parse(JSON.stringify(data)); } catch (e) { throw fail('invalid_argument', 'That document can\'t be saved.'); }
    }
    return {
      id, path,
      collection: (name) => collRef(cleanPath(path + '/' + name, false)),
      onSnapshot: (next, error) => subscribe(path, docSubs, ensureDoc, next, error),
      async get() { await fetchDoc(path); return docSnap(path); },
      async set(data, opts) {
        const json = plain(data);
        const r = await write('set', json, opts);
        applyDoc(path, true, json, r.version, r.seq, true);
        flush();
        return { version: r.version };
      },
      async update(data, opts) {
        const r = await write('update', plain(data), opts);
        await fetchDoc(path); // the server did the merge, so take its result
        return { version: r.version };
      },
      async delete(opts) {
        const r = await write('delete', undefined, opts);
        applyDoc(path, false, null, 0, r.seq, true);
        flush();
      },
    };
  }
  function collRef(path) {
    return {
      id: path.slice(path.lastIndexOf('/') + 1), path,
      doc: (id) => docRef(cleanPath(path + '/' + id, true)),
      onSnapshot: (next, error) => subscribe(path, collSubs, ensureColl, next, error),
      async get() { await listColl(path); return collSnap(path); },
    };
  }
  const db = Object.freeze({
    collection: (path) => collRef(cleanPath(path, false)),
    doc: (path) => docRef(cleanPath(path, true)),
  });

  // ---------- window.claude.use('user') ----------
  const hash = (s) => { let x = 5381; for (const ch of String(s)) x = ((x << 5) + x + ch.codePointAt(0)) >>> 0; return x; };
  function hslToHex(hue, s, l) {
    s /= 100; l /= 100;
    const k = (n) => (n + hue / 30) % 12, a = s * Math.min(l, 1 - l);
    const f = (n) => Math.round(255 * (l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)))));
    return '#' + [f(0), f(8), f(4)].map((v) => v.toString(16).padStart(2, '0')).join('');
  }
  const xmlEscape = (s) => s.replace(/[&<>"']/g, (c) => '&#' + c.charCodeAt(0) + ';');
  function look(uid, name) {
    const words = String(name || '?').trim().split(/\s+/).filter(Boolean);
    const initials = (words.length > 1 ? [words[0], words[words.length - 1]] : [words[0] || '?']).map((w) => Array.from(w)[0]).join('').toUpperCase();
    const color = hslToHex(hash(uid) % 360, 55, 40);
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" fill="${color}"/>`
      + `<text x="32" y="33" dy=".35em" text-anchor="middle" font-family="Arial,Helvetica,sans-serif" font-size="${initials.length > 1 ? 26 : 30}" font-weight="700" fill="#fff">${xmlEscape(initials)}</text></svg>`;
    return { color, avatarUrl: 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg) };
  }
  const profileCache = new Map(), profilePending = new Map();
  function loadProfiles(ids) {
    const now = Date.now();
    const need = ids.filter((id) => !profilePending.has(id) && !((profileCache.get(id) || {}).at > now - 60000));
    const waits = ids.filter((id) => profilePending.has(id)).map((id) => profilePending.get(id));
    for (let i = 0; i < need.length; i += 100) {
      const chunk = need.slice(i, i + 100);
      const p = request('POST', '/api/profiles', { ids: chunk }).then((r) => {
        const got = isObj(r.profiles) ? r.profiles : {};
        for (const id of chunk) profileCache.set(id, { name: got[id] && typeof got[id].name === 'string' ? got[id].name : '', at: Date.now() });
      }).catch(() => { /* keep whatever we had */ }).finally(() => { for (const id of chunk) profilePending.delete(id); });
      for (const id of chunk) profilePending.set(id, p);
      waits.push(p);
    }
    return Promise.all(waits);
  }
  const profileOf = (uid, name) => ({ id: uid, name, ...look(uid, name), email: null, isMe: !!me && uid === me.uid, guest: false });
  const user = Object.freeze({
    id: async () => me.uid,
    isOwner: async () => !!me.admin,
    canEdit: async () => !!me.admin,
    can: async (cap) => cap === 'data.write',
    email: async () => null,
    name: async () => me.display,
    me: async () => ({ ...profileOf(me.uid, me.display), isOwner: !!me.admin, canEdit: !!me.admin }),
    async profiles(ids) {
      const want = [...new Set((Array.isArray(ids) ? ids : []).filter((id) => typeof id === 'string' && id))].slice(0, 500);
      await loadProfiles(want.filter((id) => id !== me.uid));
      const out = {};
      for (const id of want) out[id] = profileOf(id, id === me.uid ? me.display : (profileCache.get(id) || {}).name || '');
      return out;
    },
  });

  // Defined before the page's own script runs
  window.claude = Object.freeze({
    async use(name) {
      if (name !== 'db' && name !== 'user') return null;
      await loadMe();
      return name === 'db' ? db : user;
    },
  });
  loadMe();

  // ====================================================================
  //  Everything below is the visible part: Account button, admin panel
  // ====================================================================
  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? '' : String(v));
    }
    for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid);
    return el;
  }
  const clear = (el) => { while (el.firstChild) el.removeChild(el.firstChild); return el; };
  function ago(iso) {
    const t = Date.parse(iso);
    if (!iso || !Number.isFinite(t)) return 'Never';
    const s = (Date.now() - t) / 1000;
    if (s < 90) return 'Just now';
    if (s < 3600) return Math.round(s / 60) + ' min ago';
    if (s < 86400) return Math.round(s / 3600) + ' h ago';
    if (s < 14 * 86400) { const d = Math.round(s / 86400); return d + (d === 1 ? ' day ago' : ' days ago'); }
    return new Date(t).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
  }
  function inDays(iso) {
    const s = (Date.parse(iso) - Date.now()) / 1000;
    if (!Number.isFinite(s) || s <= 0) return 'expired';
    if (s < 3600) return 'expires in under an hour';
    if (s < 86400) return 'expires in ' + Math.round(s / 3600) + ' h';
    const d = Math.round(s / 86400);
    return 'expires in ' + d + (d === 1 ? ' day' : ' days');
  }
  async function copyText(text) {
    try { await navigator.clipboard.writeText(text); return true; } catch (e) { /* try the old way */ }
    const t = h('textarea', { readonly: true, 'aria-hidden': 'true', tabindex: '-1' });
    t.value = text; t.style.cssText = 'position:fixed;left:-999px;top:0;opacity:0';
    document.body.append(t); t.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch (e) { /* no */ }
    t.remove();
    return ok;
  }

  const CSS = `
#siteAdmin { display: grid; gap: 14px; min-width: 0; }
.cbx-mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 14px; word-break: break-all; }
.cbx-link { flex: 1 1 220px; min-width: 0; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 13px; }
.cbx-msg { min-height: 1.2em; margin: 0; font-size: 13px; color: var(--muted, #95a2cb); }
.cbx-msg.bad { color: var(--red, #ff5d6c); }
.cbx-msg.good { color: var(--green, #43d17a); }
.cbx-new { border-color: var(--gold, #f6c544) !important; }
.cbx-user small { display: block; color: var(--muted, #95a2cb); font-size: 12px; }
.cbx-pill, .cbx-pill * { box-sizing: border-box; }
.cbx-pill { position: fixed; left: 12px; bottom: calc(14px + env(safe-area-inset-bottom, 0px)); z-index: 7; display: inline-flex; align-items: center; gap: 8px;
  background: var(--panel-2, #1c2b5a); color: var(--fg, #eef1fb); border: 1px solid var(--line, #2a3c75); border-radius: 99px; padding: 4px 13px 4px 4px;
  font: 700 13px/1 var(--body, system-ui, sans-serif); cursor: pointer; box-shadow: 0 4px 14px rgb(0 0 0 / .35); }
.cbx-pill:hover { border-color: var(--gold, #f6c544); }
.cbx-pill:focus-visible, .cbx-btn:focus-visible, .cbx-x:focus-visible, .cbx-field input:focus-visible { outline: 2px solid var(--gold, #f6c544); outline-offset: 2px; }
.cbx-pill img { width: 26px; height: 26px; border-radius: 50%; display: block; }
.cbx-dot { width: 9px; height: 9px; border-radius: 50%; background: var(--green, #43d17a); flex: none; }
.cbx-dot.off { background: var(--amber, #ffad42); }
.cbx-dot.nudge { background: var(--gold, #f6c544); box-shadow: 0 0 0 3px rgb(246 197 68 / .25); }
.cbx-bar { position: fixed; top: 0; left: 0; right: 0; z-index: 20; text-align: center; background: var(--amber, #ffad42); color: #2a1d00; font: 700 13px/1.3 var(--body, system-ui, sans-serif); padding: 6px 12px; }
body { padding-bottom: 72px; }
@media (max-width: 820px) { .cbx-pill { bottom: calc(76px + env(safe-area-inset-bottom, 0px)); } body { padding-bottom: 130px; } }
.cbx-dialog { border: 0; padding: 0; background: transparent; color: var(--fg, #eef1fb); width: min(440px, calc(100vw - 24px)); max-height: calc(100dvh - 24px); overflow: visible; }
.cbx-dialog::backdrop { background: rgb(5 10 30 / .74); }
.cbx-card { background: var(--panel, #152149); border: 1px solid var(--line, #2a3c75); border-top: 3px solid var(--gold, #f6c544); border-radius: 14px; padding: 16px; display: grid; gap: 14px;
  max-height: calc(100dvh - 24px); overflow-y: auto; font: 15px/1.45 var(--body, system-ui, sans-serif); }
.cbx-head { display: flex; justify-content: space-between; align-items: center; gap: 10px; }
.cbx-head h2 { margin: 0; font: 400 22px/1.2 var(--display, "Lilita One", sans-serif); letter-spacing: .3px; }
.cbx-x { background: none; border: 0; color: var(--muted, #95a2cb); font-size: 26px; line-height: 1; padding: 2px 8px; cursor: pointer; border-radius: 8px; }
.cbx-x:hover { color: var(--fg, #eef1fb); }
.cbx-who { display: flex; align-items: center; gap: 12px; }
.cbx-who img { width: 48px; height: 48px; border-radius: 50%; flex: none; }
.cbx-who b { display: block; font-size: 17px; overflow-wrap: anywhere; }
.cbx-who span { color: var(--muted, #95a2cb); font-size: 14px; overflow-wrap: anywhere; }
.cbx-tag { display: inline-block; margin-left: 6px; font-size: 11px; font-weight: 700; letter-spacing: .5px; text-transform: uppercase; padding: 1px 8px; border-radius: 99px; border: 1px solid var(--gold, #f6c544); color: var(--gold, #f6c544) !important; }
.cbx-note { margin: 0; padding: 10px 12px; border-radius: 10px; background: var(--panel-2, #1c2b5a); border: 1px dashed var(--gold, #f6c544); font-size: 14px; }
.cbx-form { display: grid; gap: 10px; }
.cbx-form h3 { margin: 0; font-size: 15px; }
.cbx-field { display: grid; gap: 4px; font-size: 13px; font-weight: 600; color: var(--muted, #95a2cb); }
.cbx-field input { background: var(--bg, #0d1530); color: var(--fg, #eef1fb); border: 1px solid var(--line, #2a3c75); border-radius: 10px; padding: 10px 12px; font: 16px var(--body, system-ui, sans-serif); min-width: 0; width: 100%; }
.cbx-vh { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); }
.cbx-row { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; justify-content: space-between; }
.cbx-btn { background: var(--panel-2, #1c2b5a); color: var(--fg, #eef1fb); border: 1px solid var(--line, #2a3c75); border-radius: 10px; padding: 10px 16px; font: 700 15px var(--body, system-ui, sans-serif); cursor: pointer; }
.cbx-btn:hover { border-color: var(--gold, #f6c544); }
.cbx-btn.gold { background: var(--gold, #f6c544); color: var(--gold-ink, #2a1d00); border-color: var(--gold, #f6c544); font: 400 17px var(--display, "Lilita One", sans-serif); letter-spacing: .4px; }
.cbx-btn:disabled { opacity: .5; cursor: not-allowed; }
`;

  // ---------- connection banner ----------
  let bar = null;
  function renderOnline() {
    if (!document.body) return;
    if (!online && !bar) { bar = h('div', { class: 'cbx-bar', role: 'status' }, 'Can\'t reach ClashBets. Trying again…'); document.body.append(bar); }
    if (bar) bar.hidden = online;
    renderAccount();
  }

  // ---------- Account button and window ----------
  let pill = null, dialog = null, card = null, flash = null;
  function buildAccount() {
    document.head.append(h('style', {}, CSS));
    pill = h('button', { type: 'button', class: 'cbx-pill', 'aria-haspopup': 'dialog', onclick: openAccount });
    card = h('div', { class: 'cbx-card' });
    dialog = h('dialog', { class: 'cbx-dialog', 'aria-labelledby': 'cbx-title', onclick: (e) => { if (e.target === dialog) closeAccount(); } }, card);
    document.body.append(pill, dialog);
    renderAccount();
  }
  function renderAccount() {
    if (!pill) return;
    const dot = h('span', { class: 'cbx-dot' + (!online ? ' off' : !me.hasPassword ? ' nudge' : ''), 'aria-hidden': 'true' });
    clear(pill).append(h('img', { src: look(me.uid, me.display).avatarUrl, alt: '' }), 'Account', dot);
    pill.title = !online ? 'Account (offline, trying again)' : !me.hasPassword ? 'Account (set a password so you can sign in on another device)' : 'Account';
    if (dialog.open) renderCard();
  }
  function openAccount() {
    flash = null;
    renderCard();
    if (typeof dialog.showModal === 'function') dialog.showModal(); else dialog.setAttribute('open', '');
  }
  function closeAccount() {
    if (typeof dialog.close === 'function') dialog.close(); else dialog.removeAttribute('open');
    pill.focus();
  }
  function field(id, label, attrs) {
    return h('label', { class: 'cbx-field', for: id }, label, h('input', Object.assign({ id, class: '', required: true }, attrs)));
  }
  function renderCard() {
    const hasPw = !!me.hasPassword;
    const msg = h('p', { class: 'cbx-msg' + (flash ? ' ' + flash.kind : ''), role: 'status' }, flash ? flash.text : '');
    const save = h('button', { type: 'submit', class: 'cbx-btn gold' }, hasPw ? 'Change password' : 'Set password');
    const form = h('form', { class: 'cbx-form', autocomplete: 'on' },
      h('h3', {}, hasPw ? 'Change your password' : 'Set a password'),
      hasPw ? h('input', { class: 'cbx-vh', type: 'text', name: 'username', autocomplete: 'username', value: me.username, readonly: true, tabindex: '-1', 'aria-hidden': 'true' })
        : field('cbx-un', 'Username (you sign in with this)', { name: 'username', type: 'text', autocomplete: 'username', value: me.username, minlength: 3, maxlength: 24, autocapitalize: 'none', autocorrect: 'off', spellcheck: 'false' }),
      hasPw ? field('cbx-cur', 'Current password', { name: 'current', type: 'password', autocomplete: 'current-password', maxlength: 200 }) : null,
      field('cbx-new', 'New password (at least 8 characters)', { name: 'new', type: 'password', autocomplete: 'new-password', minlength: 8, maxlength: 200 }),
      field('cbx-new2', 'New password again', { name: 'new2', type: 'password', autocomplete: 'new-password', minlength: 8, maxlength: 200 }),
      msg,
      h('div', { class: 'cbx-row' }, save));
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const val = (id) => form.querySelector('#' + id).value;
      const next = val('cbx-new');
      const say = (kind, text) => { flash = { kind, text }; msg.className = 'cbx-msg ' + kind; msg.textContent = text; };
      if (next.length < 8) return say('bad', 'Pick a password with at least 8 characters.');
      if (next !== val('cbx-new2')) return say('bad', 'The two new passwords don\'t match.');
      const body = { next };
      if (hasPw) body.current = val('cbx-cur');
      else {
        const wanted = val('cbx-un').trim().toLowerCase();
        if (!/^[a-z0-9][a-z0-9_.-]{2,23}$/.test(wanted)) return say('bad', 'Usernames are 3 to 24 letters, numbers, dots, dashes or underscores.');
        if (wanted !== me.username) body.username = wanted;
      }
      save.disabled = true; save.textContent = 'Saving…';
      try {
        await request('POST', '/api/auth/password', body, { keep401: true });
        await refreshMe();
        flash = { kind: 'good', text: hasPw ? 'Password changed. Your other devices have been signed out.' : 'Password saved. You can now sign in on any device.' };
      } catch (err) {
        if (err.status === 401) { try { await request('GET', '/api/auth/me'); } catch (x) { return; } }
        flash = { kind: 'bad', text: err.message };
      }
      renderCard();
    });
    const signOut = h('button', { type: 'button', class: 'cbx-btn', onclick: async (e) => {
      e.target.disabled = true;
      try { await request('POST', '/api/auth/logout', {}); leaving = true; location.replace('/login'); } catch (err) { e.target.disabled = false; flash = { kind: 'bad', text: err.message }; renderCard(); }
    } }, 'Sign out');
    clear(card).append(
      h('div', { class: 'cbx-head' }, h('h2', { id: 'cbx-title' }, 'Your account'), h('button', { type: 'button', class: 'cbx-x', 'aria-label': 'Close', onclick: closeAccount }, '×')),
      h('div', { class: 'cbx-who' }, h('img', { src: look(me.uid, me.display).avatarUrl, alt: '' }),
        h('div', {}, h('b', {}, me.display), h('span', {}, '@' + me.username), me.admin ? h('span', { class: 'cbx-tag' }, 'Admin') : null)),
      hasPw ? null : h('p', { class: 'cbx-note' }, 'You got in with a personal link. Set a password so you can sign in again on another phone or if you clear your browser.'),
      form,
      h('div', { class: 'cbx-row' }, signOut));
  }

  // ---------- admin panel ----------
  function mountAdmin(root) {
    const S = { accounts: [], invites: [], players: [], links: new Map(), fresh: new Map(), temp: null, ask: null, last: 0 };
    const accMsg = h('p', { class: 'cbx-msg', role: 'status' }), invMsg = h('p', { class: 'cbx-msg', role: 'status' });
    const tempBox = h('div'), accWrap = h('div', { class: 'scroll' });
    const freshBox = h('div'), invList = h('div', { class: 'stack' });
    const pickSel = h('select', { 'aria-label': 'Player to invite' });
    const makeBtn = h('button', { type: 'button', class: 'btn gold', onclick: createInvite }, 'Create invite link');
    const say = (el, kind, text) => { el.className = 'cbx-msg' + (kind ? ' ' + kind : ''); el.textContent = text || ''; };
    const nameOfPlayer = (pid) => { const p = S.players.find((x) => x.id === pid); return p ? p.name : 'Removed player'; };
    const nameOfUid = (uid) => { const a = S.accounts.find((x) => x.uid === uid); return a ? a.display : 'Someone'; };

    clear(root).append(
      h('section', { class: 'panel stack' }, h('h2', {}, 'Website accounts'),
        h('p', { class: 'note' }, 'Everyone who can sign in to this site. Reset a password if someone is locked out; the new one is shown once. Switching an account off signs it out and stops it signing in, and you can switch it back on.'),
        accMsg, tempBox, accWrap),
      h('section', { class: 'panel stack' }, h('h2', {}, 'Invite links'),
        h('p', { class: 'note' }, 'Make a personal link for a player. Whoever opens it is signed in as that player straight away, with no sign-up. Each link works once. Send it to them privately: a link only shows here when you make it, so copy it then. Players who already have an account are greyed out.'),
        h('div', { class: 'row' }, pickSel, makeBtn), invMsg, freshBox, invList));

    // -- accounts
    function renderAccounts() {
      clear(tempBox);
      if (S.temp) {
        tempBox.append(h('div', { class: 'confirm-row cbx-new' },
          h('span', {}, 'New password for ', h('b', {}, S.temp.name), ': ', h('span', { class: 'cbx-mono' }, S.temp.pw)),
          h('span', { class: 'row' },
            h('button', { type: 'button', class: 'btn tiny', onclick: async (e) => { e.target.textContent = (await copyText(S.temp.pw)) ? 'Copied' : 'Press Ctrl+C'; } }, 'Copy'),
            h('button', { type: 'button', class: 'btn tiny', onclick: () => { S.temp = null; renderAccounts(); } }, 'Done'))),
          h('p', { class: 'note' }, 'This is the only time you will see it. Send it to them privately. They sign in with it, then change it under Account. They have been signed out everywhere.'));
      }
      clear(accWrap);
      if (!S.accounts.length) { accWrap.append(h('div', { class: 'empty' }, 'No accounts yet.')); return; }
      const rows = S.accounts.map((a) => {
        const self = a.uid === me.uid;
        const ask = S.ask === 'reset:' + a.uid;
        const acts = h('td', { style: 'white-space:nowrap' },
          self ? null : h('button', { type: 'button', class: 'btn tiny' + (ask ? ' warn' : ''), onclick: () => (ask ? resetPassword(a) : ((S.ask = 'reset:' + a.uid), renderAccounts())) }, ask ? 'Sure? Reset' : 'Reset password'), ' ',
          self ? null : h('button', { type: 'button', class: 'btn tiny' + (a.disabled ? '' : ' warn'), onclick: () => switchAccount(a) }, a.disabled ? 'Switch on' : 'Switch off'));
        return h('tr', { class: self ? 'mine' : '' },
          h('td', { class: 'cbx-user' }, h('b', {}, a.display), a.admin ? [' ', h('span', { class: 'pill admin' }, 'Admin')] : null, a.disabled ? [' ', h('span', { class: 'pill lost' }, 'Off')] : null,
            h('small', {}, '@' + a.username + (a.hasPassword ? '' : ' · no password yet'))),
          h('td', {}, a.playerId ? nameOfPlayer(a.playerId) : h('span', { class: 'na' }, 'None')),
          h('td', { class: 'small' }, ago(a.lastSeenAt)),
          acts);
      });
      accWrap.append(h('table', {}, h('thead', {}, h('tr', {}, h('th', {}, 'Account'), h('th', {}, 'Player'), h('th', {}, 'Last seen'), h('th', {}))), h('tbody', {}, rows)));
    }
    async function resetPassword(a) {
      S.ask = null;
      try {
        const r = await request('POST', '/api/admin/accounts/' + encodeURIComponent(a.uid) + '/reset-password', {});
        S.temp = { name: a.display + ' (@' + a.username + ')', pw: r.tempPassword };
        say(accMsg, 'good', '');
      } catch (e) { say(accMsg, 'bad', e.message); }
      renderAccounts();
    }
    async function switchAccount(a) {
      try {
        await request('POST', '/api/admin/accounts/' + encodeURIComponent(a.uid) + '/disable', { disabled: !a.disabled });
        say(accMsg, 'good', a.display + (a.disabled ? ' can sign in again.' : ' is switched off and signed out.'));
        await loadAccounts();
      } catch (e) { say(accMsg, 'bad', e.message); }
    }
    async function loadAccounts() {
      try { S.accounts = (await request('GET', '/api/admin/accounts')).accounts || []; if (accMsg.classList.contains('bad') && !accMsg.dataset.keep) say(accMsg, '', ''); } catch (e) { say(accMsg, 'bad', e.message); }
      renderAccounts(); renderInvites();
    }

    // -- invites
    function fillPlayers() {
      const prev = pickSel.value;
      const taken = new Set([...S.links].filter(([, uid]) => typeof uid === 'string' && uid).map(([pid]) => pid));
      const list = [...S.players].sort((a, b) => String(a.name).localeCompare(String(b.name)));
      clear(pickSel);
      for (const p of list) pickSel.append(h('option', { value: p.id, disabled: taken.has(p.id) }, p.name + (taken.has(p.id) ? ' (has an account)' : '')));
      const free = list.filter((p) => !taken.has(p.id));
      if (prev && free.some((p) => p.id === prev)) pickSel.value = prev; else if (free[0]) pickSel.value = free[0].id;
      pickSel.disabled = makeBtn.disabled = !free.length;
      if (!list.length) pickSel.append(h('option', { value: '' }, 'No players yet'));
      else if (!free.length) say(invMsg, '', 'Everyone in the squad already has an account.');
      else if (invMsg.textContent === 'Everyone in the squad already has an account.') say(invMsg, '', '');
    }
    async function share(url, name) {
      try { await navigator.share({ title: 'ClashBets', text: name + ', here\'s your ClashBets link. Tap it to join:', url }); } catch (e) { /* closed without sharing */ }
    }
    function linkTools(url, name, big) {
      const btns = [h('button', { type: 'button', class: 'btn tiny', onclick: async (e) => { e.target.textContent = (await copyText(url)) ? 'Copied' : 'Press Ctrl+C'; } }, 'Copy link')];
      if (typeof navigator.share === 'function') btns.push(h('button', { type: 'button', class: 'btn tiny', onclick: () => share(url, name) }, 'Share'));
      return btns;
    }
    async function createInvite() {
      const pid = pickSel.value;
      if (!pid) return;
      makeBtn.disabled = true;
      try {
        const r = await request('POST', '/api/admin/invites', { playerId: pid });
        const name = nameOfPlayer(pid);
        S.fresh.set(r.id, { url: r.url, name });
        const copied = await copyText(r.url);
        say(invMsg, 'good', copied ? `Link for ${name} made and copied. Paste it into your chat.` : `Link for ${name} made. Copy it below.`);
        clear(freshBox).append(h('div', { class: 'confirm-row cbx-new' },
          h('input', { class: 'cbx-link', type: 'text', readonly: true, value: r.url, 'aria-label': 'Invite link for ' + name, onfocus: (e) => e.target.select() }),
          h('span', { class: 'row' }, linkTools(r.url, name), h('button', { type: 'button', class: 'btn tiny', onclick: () => clear(freshBox) }, 'Done'))));
        await loadInvites();
      } catch (e) { say(invMsg, 'bad', e.message); }
      fillPlayers();
    }
    async function revoke(inv) {
      try { await request('DELETE', '/api/admin/invites/' + encodeURIComponent(inv.id)); S.fresh.delete(inv.id); say(invMsg, 'good', 'Link removed.'); await loadInvites(); } catch (e) { say(invMsg, 'bad', e.message); }
    }
    function renderInvites() {
      clear(invList);
      const now = Date.now();
      const state = (i) => (i.usedAt ? 'used' : Date.parse(i.expiresAt) <= now ? 'expired' : 'open');
      const order = { open: 0, used: 1, expired: 2 };
      const sorted = [...S.invites].sort((a, b) => order[state(a)] - order[state(b)] || String(b.createdAt).localeCompare(String(a.createdAt)));
      if (!sorted.length) { invList.append(h('p', { class: 'note' }, 'No links yet.')); return; }
      for (const i of sorted) {
        const st = state(i), f = S.fresh.get(i.id);
        const what = st === 'open' ? 'Waiting · ' + inDays(i.expiresAt) : st === 'used' ? 'Used by ' + nameOfUid(i.usedBy) + ' · ' + ago(i.usedAt) : 'Expired';
        invList.append(h('div', { class: 'confirm-row' },
          h('span', {}, h('b', {}, nameOfPlayer(i.playerId)), ' ', h('span', { class: 'pill ' + (st === 'open' ? 'open' : st === 'used' ? 'won' : '') }, st), ' ', h('span', { class: 'small muted' }, what)),
          h('span', { class: 'row' }, st === 'open' && f ? linkTools(f.url, f.name) : null,
            h('button', { type: 'button', class: 'btn tiny' + (st === 'open' ? ' warn' : ''), onclick: () => revoke(i) }, st === 'open' ? 'Revoke' : 'Remove'))));
      }
    }
    async function loadInvites() {
      try { S.invites = (await request('GET', '/api/admin/invites')).invites || []; } catch (e) { say(invMsg, 'bad', e.message); }
      renderInvites();
    }

    // The players and links come from the same live copy the page uses
    const watch = (name, fn) => subscribe(name, collSubs, ensureColl, (snap) => { fn(snap.docs.map((d) => ({ ...d.data(), id: d.id }))); fillPlayers(); renderAccounts(); renderInvites(); }, () => {});
    watch('players', (docs) => { S.players = docs.filter((d) => typeof d.name === 'string'); });
    watch('links', (docs) => { S.links = new Map(docs.map((d) => [d.id, d.uid])); });

    const refresh = () => { S.last = Date.now(); loadAccounts(); loadInvites(); };
    const visible = () => root.offsetParent !== null || root.getClientRects().length > 0;
    if (typeof IntersectionObserver === 'function') new IntersectionObserver((es) => { if (es.some((e) => e.isIntersecting) && Date.now() - S.last > 2000) refresh(); }).observe(root);
    setInterval(() => { if (!document.hidden && visible() && Date.now() - S.last > 30000) refresh(); }, 10000);
    refresh();
  }

  function boot() {
    renderOnline();
    loadMe().then(() => {
      buildAccount();
      const root = document.getElementById('siteAdmin');
      if (root && me.admin) mountAdmin(root);
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();
