'use strict';

// The ClashBets website: serves the page, gives it a tiny database API and its own sign-in.
// Zero dependencies. Run it with `npm run site`; see SPEC.md for the contract and DEPLOY.md for hosting.

const http = require('http');
const fs = require('fs');
const path = require('path');

const { Store, StoreError } = require('./lib/store');
const rules = require('./lib/rules');
const { Auth } = require('./lib/auth');
const { Persist, GithubSnapshot } = require('./lib/persist');
const H = require('./lib/http');
const pages = require('./lib/pages');
const { createImporter } = require('./lib/importer');

const { HttpError } = H;
const COOKIE = 'cb_session';
const integrity = require('./lib/integrity');
const BODY_LIMIT = 300 * 1024;
const MAX_CHANGES = 1000;               // more than this and the client is told to re-list instead
const MAX_CHANGE_BYTES = 4 * 1024 * 1024;
const BATTLES_URL = 'https://raw.githubusercontent.com/noahsargeant858-alt/Clash-betting/battle-data/battles.json';
const GONE = 'That invite link has already been used or has expired. Ask the admin for a fresh one.';
const PLAYER_ALREADY = 'That player already has an account. Ask the admin.';

// ---------- configuration ----------

const num = (v, d) => (v !== undefined && v !== '' && Number.isFinite(Number(v)) ? Number(v) : d);

// Options win over environment variables; tests pass `env: {}` so nothing leaks in from the shell.
function resolveConfig(opts) {
  const env = opts.env || process.env;
  const pick = (key, name, d) => (opts[key] !== undefined ? opts[key] : env[name] !== undefined && env[name] !== '' ? env[name] : d);
  const production = env.NODE_ENV === 'production';
  let trust = pick('trustProxy', 'TRUST_PROXY', production ? 'auto' : 0);
  trust = /^auto$/i.test(String(trust)) ? 'auto' : /^(true|yes|on)$/i.test(String(trust)) ? 1 : /^(false|no|off)$/i.test(String(trust)) ? 0 : Math.max(0, Math.floor(num(trust, 0)));
  const secureRaw = pick('cookieSecure', 'COOKIE_SECURE', undefined);
  const cookieSecure = secureRaw === undefined ? undefined : /^(1|true|yes|on)$/i.test(String(secureRaw)) ? true : /^(0|false|no|off)$/i.test(String(secureRaw)) ? false : undefined;
  const snap = opts.snapshot || {
    repo: env.SNAPSHOT_REPO, branch: env.SNAPSHOT_BRANCH, token: env.SNAPSHOT_TOKEN, key: env.SNAPSHOT_KEY, apiBase: env.SNAPSHOT_API_BASE,
    intervalMs: env.SNAPSHOT_INTERVAL_MIN ? num(env.SNAPSHOT_INTERVAL_MIN, 10) * 60e3 : undefined,
  };
  return {
    port: num(pick('port', 'PORT', 3000), 3000),
    host: pick('host', 'HOST', undefined),
    production,
    dataDirGiven: pick('dataDir', 'DATA_DIR', undefined) !== undefined,
    dataDir: path.resolve(String(pick('dataDir', 'DATA_DIR', 'site-data'))),
    adminUsername: String(pick('adminUsername', 'ADMIN_USERNAME', 'admin')).trim().toLowerCase(),
    adminPassword: pick('adminPassword', 'ADMIN_PASSWORD', ''),
    signupCode: String(pick('signupCode', 'SIGNUP_CODE', '')).trim(),
    publicUrl: String(pick('publicUrl', 'PUBLIC_URL', '')).replace(/\/+$/, ''),
    trustProxy: trust,
    cookieSecure,
    sessionDays: num(pick('sessionDays', 'SESSION_DAYS', 90), 90),
    inviteDays: num(pick('inviteDays', 'INVITE_DAYS', 14), 14),
    maxAccounts: num(pick('maxAccounts', 'MAX_ACCOUNTS', 200), 200),
    skewSeconds: num(pick('skewSeconds', 'TIME_SKEW_SECONDS', 120), 120),
    battlesUrl: pick('battlesUrl', 'BATTLES_URL', BATTLES_URL),
    importIntervalMin: num(pick('importIntervalMin', 'IMPORT_INTERVAL_MIN', 5), 5), // cheap: an unchanged feed is a 304
    publicDir: opts.publicDir || path.join(__dirname, 'public'),
    seedFile: opts.seedFile || path.join(__dirname, 'seed', 'seed.json'),
    repoRoot: opts.repoRoot || path.join(__dirname, '..'),
    debounceMs: opts.debounceMs === undefined ? 1000 : opts.debounceMs,
    bodyTimeoutMs: opts.bodyTimeoutMs || 15000,
    scryptN: opts.scryptN,
    limits: opts.limits,
    storeLimits: opts.storeLimits || {},
    snapshot: snap,
    log: opts.log || ((line) => console.log(line)),
  };
}

// First boot: load site/seed/seed.json ({docs:{path:{data}}}), pointing the admin placeholder at the real admin
function seedStore(store, file, adminUid, log) {
  let seed;
  try { seed = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) {
    if (e.code !== 'ENOENT') log(`[seed] could not read ${path.basename(file)}: ${e.message}`);
    return 0;
  }
  const swap = (v) => (v === '__ADMIN_UID__' ? adminUid : Array.isArray(v) ? v.map(swap)
    : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, swap(x)])) : v);
  let n = 0;
  for (const [p, rec] of Object.entries(seed && seed.docs && typeof seed.docs === 'object' ? seed.docs : {})) {
    try { store.write('set', p, swap(rec && rec.data), {}); n++; } catch (e) { log(`[seed] skipped ${p}: ${e.message}`); }
  }
  log(`[seed] loaded ${n} documents.`);
  return n;
}

// "Jamie" -> "jamie"; at least 3 characters from a-z and 0-9
function slugOf(name) {
  let s = String(name).toLowerCase().normalize('NFKD').replace(/[^a-z0-9]/g, '');
  if (s.length < 3) s = (s + 'player');
  return s.slice(0, 20);
}

// ---------- the server ----------

async function startServer(opts = {}) {
  const cfg = resolveConfig(opts);
  const log = cfg.log;
  const trust = cfg.trustProxy;
  if (cfg.production && !cfg.dataDirGiven) throw new Error('Set DATA_DIR to the folder on your persistent disk (on Render: /var/data). Without it every deploy would wipe the accounts and bets.');
  if (cfg.production && !cfg.signupCode) log('[security] SIGNUP_CODE is not set, so anyone who finds the address can make an account. Set a group code.');
  if (cfg.signupCode.length > 200) log('[config] SIGNUP_CODE is longer than 200 characters, which is more than the sign-up box takes. Pick a shorter one.');

  // --- data: restore a backup into an empty folder, then load both files
  const snapshot = GithubSnapshot.create({ ...cfg.snapshot, dir: cfg.dataDir, scryptN: cfg.snapshot.scryptN, log });
  const persist = new Persist({ dir: cfg.dataDir, log, debounceMs: cfg.debounceMs, snapshot });
  if (snapshot && !persist.hasData()) await snapshot.restore();
  const fresh = !fs.existsSync(persist.file('db'));

  const store = new Store(cfg.storeLimits);
  const skipped = store.load(persist.read('db') || {});
  if (skipped) log(`[store] ignored ${skipped} damaged document${skipped === 1 ? '' : 's'} in db.json.`);
  const auth = new Auth({ sessionDays: cfg.sessionDays, inviteDays: cfg.inviteDays, scryptN: cfg.scryptN, limits: cfg.limits });
  auth.load(persist.read('auth') || {});

  persist.provide('db', () => store.serialize());
  persist.provide('auth', () => auth.serialize());

  // --- the owner's account, then seed data (which points at the owner)
  if (cfg.production && !cfg.adminPassword && ![...auth.users.values()].some((u) => u.admin)) throw new Error('Set ADMIN_PASSWORD (in Render: Environment) before the first start, so the admin account gets a password you chose.');
  const boot = await auth.ensureAdmin({ username: cfg.adminUsername, password: cfg.adminPassword });
  if (boot.created) {
    if (boot.generated) {
      log(`[admin] Created the admin account. Sign in with these, then change the password from the Account button.\n[admin]   username: ${boot.admin.username}\n[admin]   password: ${boot.generated}\n[admin] This is shown once.`);
    } else log(`[admin] Created the admin account "${boot.admin.username}" with the password from ADMIN_PASSWORD.`);
  }
  if (fresh) seedStore(store, cfg.seedFile, boot.admin.uid, log);
  store.onChange = () => persist.markDirty('db');
  auth.onChange = () => persist.markDirty('auth');
  persist.markDirty('auth'); // the admin account may be new
  if (fresh) persist.markDirty('db');
  persist.flush();

  const importer = createImporter({ store, repoRoot: cfg.repoRoot, battlesUrl: cfg.battlesUrl, intervalMin: cfg.importIntervalMin, log });
  const statics = new H.StaticFiles(cfg.publicDir);
  const purgeTimer = setInterval(() => auth.purge(), 10 * 60e3);
  purgeTimer.unref();

  // --- helpers over the data
  const links = () => store.list('links');
  const playerIdOf = (uid) => { for (const d of links()) if (d.data && d.data.uid === uid) return d.id; return null; };
  const playerName = (pid) => { const p = store.get(`players/${pid}`); return p && typeof p.data.name === 'string' ? p.data.name : null; };
  const meOf = (u) => ({ uid: u.uid, username: u.username, display: u.display, admin: !!u.admin, hasPassword: !!u.pass, playerId: playerIdOf(u.uid) });
  const baseUrl = (ctx) => cfg.publicUrl || `${ctx.https ? 'https' : 'http'}://${H.hostOf(ctx.req)}`;
  const tooMany = (limiter, key, msg) => new HttpError(429, msg || 'Too many tries. Wait a few minutes and try again.', { 'Retry-After': String(limiter.retryAfter(key) || 60) });

  // --- long-polling
  const waiters = new Set();
  store.subscribe((seq, p) => {
    if (!waiters.size) return;
    const segs = p.split('/');
    for (const w of [...waiters]) if (rules.canRead(w.user, segs)) w.release(false);
  });

  // what changed after `since` that this user may see
  function changesFor(user, since) {
    const r = store.changesSince(since);
    if (r.reset) return { seq: store.seq, reset: true, changes: [] };
    const out = [];
    let bytes = 0;
    for (const p of r.paths) {
      if (!rules.canRead(user, p.split('/'))) continue;
      const d = store.get(p);
      if (d) { bytes += d.size; out.push({ path: p, exists: true, data: d.data, version: d.version }); } else out.push({ path: p, exists: false, version: 0 });
      if (out.length > MAX_CHANGES || bytes > MAX_CHANGE_BYTES) return { seq: store.seq, reset: true, changes: [] };
    }
    return { seq: store.seq, reset: false, changes: out };
  }

  // --- request plumbing
  const needUser = (ctx) => { if (!ctx.user) throw new HttpError(401, 'Please sign in.'); return ctx.user; };
  const needAdmin = (ctx) => { if (!ctx.user || !ctx.user.admin) throw new HttpError(403, 'Only the admin can do that.'); return ctx.user; };
  const body = async (ctx) => H.parseJsonObject(await H.readBody(ctx.req, BODY_LIMIT, cfg.bodyTimeoutMs));
  const json = (ctx, obj, status = 200) => H.sendJson(ctx.res, status, obj);
  const secure = (ctx) => (cfg.cookieSecure !== undefined ? cfg.cookieSecure : ctx.https);
  const maxAge = () => Math.floor(auth.sessionMs / 1000);

  function startSession(ctx, uid) {
    if (ctx.token) auth.revokeToken(ctx.token); // this browser's old session is replaced
    const token = auth.createSession(uid);
    ctx.res.setHeader('Set-Cookie', H.cookieString(COOKIE, token, { maxAge: maxAge(), secure: secure(ctx) }));
    return token;
  }

  // ---------- auth endpoints ----------

  async function signup(ctx) {
    if (!auth.limits.signupIp.take(ctx.ipk)) throw tooMany(auth.limits.signupIp, ctx.ipk, 'Too many accounts made from this connection. Try again later.');
    if (!auth.limits.signupAll.take('all')) throw tooMany(auth.limits.signupAll, 'all', 'A lot of accounts were made in the last hour. Ask the admin for a personal link, or try again later.');
    const b = await body(ctx);
    if (cfg.signupCode && !(typeof b.code === 'string' && H.safeEqual(b.code.trim(), cfg.signupCode))) throw new HttpError(403, 'That group code is not right.');
    const username = auth.normUsername(b.username);
    if (!username) throw new HttpError(400, 'Usernames are 3 to 24 characters: lowercase letters, numbers, dots, dashes and underscores, starting with a letter or number.');
    const display = b.display === undefined || b.display === null || b.display === '' ? username : auth.cleanDisplay(b.display);
    if (display === null) throw new HttpError(400, 'Your name must be 1 to 30 characters, with no control characters.');
    const problem = auth.passwordProblem(b.password, username);
    if (problem) throw new HttpError(400, problem);
    if (auth.byName.has(username)) throw new HttpError(409, 'That username is taken.');
    if (auth.users.size >= cfg.maxAccounts) throw new HttpError(507, 'This site has reached its limit on accounts. Ask the admin.');
    const pass = await oneOfFew(ctx, () => auth.hasher.hash(b.password));
    const user = auth.createUser({ username, display, pass, via: 'signup' }); // checks the name again: someone may have taken it while we hashed
    startSession(ctx, user.uid);
    json(ctx, { ok: true, me: meOf(user) });
  }

  // At most three password hashes in flight per connection, so one machine can't fill the shared queue
  const hashing = new Map();
  async function oneOfFew(ctx, fn) {
    const n = hashing.get(ctx.ipk) || 0;
    if (n >= 3) throw new HttpError(429, 'Slow down: let one sign-in finish before starting another.', { 'Retry-After': '5' });
    hashing.set(ctx.ipk, n + 1);
    try { return await fn(); } finally { const m = (hashing.get(ctx.ipk) || 1) - 1; if (m) hashing.set(ctx.ipk, m); else hashing.delete(ctx.ipk); }
  }

  async function login(ctx) {
    const b = await body(ctx);
    const name = typeof b.username === 'string' ? b.username.trim().toLowerCase().slice(0, 64) : '';
    const L = auth.limits, pair = `${name}|${ctx.ipk}`;
    if (L.loginIp.blocked(ctx.ipk)) throw tooMany(L.loginIp, ctx.ipk);
    if (L.loginUser.blocked(pair)) throw tooMany(L.loginUser, pair);
    if (L.loginUserAll.blocked(name)) throw tooMany(L.loginUserAll, name);
    if (!L.loginAttempt.take(ctx.ipk)) throw tooMany(L.loginAttempt, ctx.ipk, 'Too many sign-in attempts from this connection. Wait a few minutes and try again.');
    const r = await oneOfFew(ctx, () => auth.authenticate(name, b.password));
    if (r.status === 'bad') {
      L.loginIp.add(ctx.ipk); L.loginUser.add(pair); L.loginUserAll.add(name);
      throw new HttpError(401, 'Wrong username or password');
    }
    if (r.status === 'disabled') throw new HttpError(403, 'This account is switched off. Ask the admin.');
    L.loginUser.reset(pair);
    r.user.lastSeenAt = new Date().toISOString();
    startSession(ctx, r.user.uid);
    json(ctx, { ok: true, me: meOf(r.user) });
  }

  function logout(ctx) {
    if (ctx.token) auth.revokeToken(ctx.token);
    ctx.res.setHeader('Set-Cookie', H.cookieString(COOKIE, '', { maxAge: 0, secure: secure(ctx) }));
    json(ctx, { ok: true });
  }

  async function changePassword(ctx) {
    const me = needUser(ctx);
    const user = auth.users.get(me.uid);
    const lim = auth.limits.password;
    if (lim.blocked(user.uid)) throw tooMany(lim, user.uid);
    const b = await body(ctx);
    let newName = null;
    if (b.username !== undefined && b.username !== null && b.username !== '') {
      if (user.pass) throw new HttpError(400, 'You can only choose a username when you first set a password.');
      newName = auth.normUsername(b.username);
      if (!newName) throw new HttpError(400, 'Usernames are 3 to 24 characters: lowercase letters, numbers, dots, dashes and underscores, starting with a letter or number.');
      if (newName !== user.username && auth.byName.has(newName)) throw new HttpError(409, 'That username is taken.');
    }
    if (user.pass) {
      if (typeof b.current !== 'string' || !b.current) throw new HttpError(400, 'Enter your current password.');
      if (!(await oneOfFew(ctx, () => auth.hasher.verify(b.current.slice(0, 1000), user.pass)))) { lim.add(user.uid); throw new HttpError(403, 'Your current password is wrong.'); }
    }
    const problem = auth.passwordProblem(b.next, newName || user.username);
    if (problem) throw new HttpError(400, problem);
    const pass = await oneOfFew(ctx, () => auth.hasher.hash(b.next));
    if (newName && newName !== user.username) auth.setUsername(user, newName); // 409 here if it was taken meanwhile, before anything changed
    user.pass = pass;
    auth.revokeUser(user.uid, ctx.key); // everywhere else is signed out; this browser stays in
    auth.changed();
    json(ctx, { ok: true, me: meOf(user) });
  }

  async function redeem(ctx) {
    if (!auth.limits.redeemIp.take(ctx.ipk)) throw tooMany(auth.limits.redeemIp, ctx.ipk);
    const b = await body(ctx);
    const inv = auth.findInvite(b.token);
    if (!inv || !auth.isOpen(inv)) throw new HttpError(410, GONE);
    const pname = playerName(inv.playerId);
    if (pname === null) throw new HttpError(409, 'That player is no longer on the site. Ask the admin.');
    const me = ctx.user ? auth.users.get(ctx.user.uid) : null;
    if (me) {
      const mine = playerIdOf(me.uid);
      if (mine) throw new HttpError(409, `You're already ${playerName(mine) || 'a player'}`);
    }
    const link = store.get(`links/${inv.playerId}`);
    const oldUid = link && typeof link.data.uid === 'string' ? link.data.uid : null;
    const holder = oldUid ? auth.users.get(oldUid) : null;
    if (holder && !holder.disabled) throw new HttpError(409, PLAYER_ALREADY);
    if (!me && auth.users.size >= cfg.maxAccounts) throw new HttpError(507, 'This site has reached its limit on accounts. Ask the admin.');

    // all synchronous from here: two taps on the same link can't both win
    const now = new Date().toISOString();
    const uid = me ? me.uid : auth.newUid();
    const former = link && Array.isArray(link.data.former) ? link.data.former.slice() : [];
    if (oldUid && oldUid !== uid) former.push({ uid: oldUid, from: link.data.at || null, until: now });
    store.write('set', `links/${inv.playerId}`, { uid, at: now, former: former.slice(-20) });
    let user = me;
    if (!me) {
      const username = auth.freeUsername(slugOf(pname));
      user = auth.createUser({ uid, username, display: auth.cleanDisplay([...pname.trim()].slice(0, 30).join('')) || username, pass: null, via: 'invite' });
      startSession(ctx, uid);
    }
    auth.markUsed(inv, uid);
    json(ctx, { ok: true, me: meOf(user), playerId: inv.playerId });
  }

  // ---------- admin endpoints ----------

  function accounts(ctx) {
    needAdmin(ctx);
    const pid = new Map();
    for (const d of links()) if (d.data && typeof d.data.uid === 'string' && !pid.has(d.data.uid)) pid.set(d.data.uid, d.id);
    const list = [...auth.users.values()].sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0)).map((u) => ({
      uid: u.uid, username: u.username, display: u.display, admin: !!u.admin, disabled: !!u.disabled, hasPassword: !!u.pass,
      via: u.via, createdAt: u.createdAt, lastSeenAt: u.lastSeenAt, playerId: pid.get(u.uid) || null,
    }));
    json(ctx, { accounts: list });
  }

  // One link for the group chat: the sign-up page with the group code already filled in. The code rides in the
  // #fragment, which browsers never send to a server, so it stays out of logs, link previews and Referer headers.
  function groupLink(ctx) {
    needAdmin(ctx);
    const base = `${baseUrl(ctx)}/login`;
    // encodeURIComponent leaves ! ' ( ) * . ~ - alone, and chat apps drop those from the end of a link they detect
    const code = encodeURIComponent(cfg.signupCode).replace(/[!'()*.~-]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
    json(ctx, { url: cfg.signupCode ? `${base}#code=${code}` : `${base}#create`, hasCode: !!cfg.signupCode, tooLong: cfg.signupCode.length > 200 });
  }

  async function resetPassword(ctx, uid) {
    const me = needAdmin(ctx);
    if (uid === me.uid) throw new HttpError(400, 'Use Change password for your own account.');
    const target = auth.users.get(uid);
    if (!target) throw new HttpError(404, 'No such account.');
    const temp = auth.tempPassword();
    await auth.setPassword(target, temp);
    auth.revokeUser(uid);
    json(ctx, { tempPassword: temp });
  }

  async function disable(ctx, uid) {
    const me = needAdmin(ctx);
    const b = await body(ctx);
    if (typeof b.disabled !== 'boolean') throw new HttpError(400, 'Say whether to switch it off or on.');
    const target = auth.users.get(uid);
    if (!target) throw new HttpError(404, 'No such account.');
    if (target.uid === me.uid) throw new HttpError(400, 'You can\'t switch off your own account.');
    auth.setDisabled(target, b.disabled);
    json(ctx, { ok: true });
  }

  async function createInvite(ctx) {
    needAdmin(ctx);
    const b = await body(ctx);
    if (typeof b.playerId !== 'string' || !rules.SEGMENT.test(b.playerId) || playerName(b.playerId) === null) throw new HttpError(404, 'No such player.');
    const { invite, token } = auth.createInvite(b.playerId);
    json(ctx, { id: invite.id, token, url: `${baseUrl(ctx)}/join/${token}`, expiresAt: invite.expiresAt });
  }

  function listInvites(ctx) {
    needAdmin(ctx);
    const list = [...auth.invites.values()].sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0))
      .map((i) => ({ id: i.id, playerId: i.playerId, createdAt: i.createdAt, expiresAt: i.expiresAt, usedAt: i.usedAt, usedBy: i.usedBy }));
    json(ctx, { invites: list });
  }

  function revokeInvite(ctx, id) {
    needAdmin(ctx);
    if (!auth.revokeInvite(id)) throw new HttpError(404, 'No such invite.');
    json(ctx, { ok: true });
  }

  async function importNow(ctx) {
    needAdmin(ctx);
    try { json(ctx, { summary: (await importer.runImport()).summary }); } catch (e) { throw new HttpError(500, `The import failed: ${e.message}`); }
  }

  // ---------- database endpoints ----------

  function dbList(ctx) {
    const user = needUser(ctx);
    const segs = rules.parsePath(ctx.query.get('collection'));
    if (!segs || rules.isDoc(segs)) throw new HttpError(400, 'That is not a valid collection path.');
    const docs = rules.canRead(user, segs)
      ? store.list(segs.join('/')).filter((d) => rules.canRead(user, d.path.split('/'))).map((d) => ({ id: d.id, data: d.data, version: d.version }))
      : [];
    json(ctx, { docs, seq: store.seq });
  }

  function dbDoc(ctx) {
    const user = needUser(ctx);
    const segs = rules.parsePath(ctx.query.get('path'));
    if (!segs || !rules.isDoc(segs)) throw new HttpError(400, 'That is not a valid document path.');
    const id = segs[segs.length - 1];
    const d = rules.canRead(user, segs) ? store.get(segs.join('/')) : undefined; // unreadable looks exactly like missing
    json(ctx, d ? { id, exists: true, data: d.data, version: d.version, seq: store.seq } : { id, exists: false, seq: store.seq });
  }

  async function dbWrite(ctx) {
    const user = needUser(ctx);
    if (!auth.limits.write.take(user.uid)) throw tooMany(auth.limits.write, user.uid, 'Slow down a little: that is a lot of changes in a minute.');
    const b = await body(ctx);
    const segs = rules.parsePath(b.path);
    if (!segs || !rules.isDoc(segs)) throw new HttpError(400, 'That is not a valid document path.');
    if (b.op !== 'set' && b.op !== 'update' && b.op !== 'delete') throw new HttpError(400, 'Unknown operation.');
    if (!rules.canWrite(user, segs)) throw new HttpError(403, 'You can\'t change that.');
    const guard = (op, gsegs, cur, next) => integrity.check({ op, segs: gsegs, cur, next, now: Date.now(), skewMs: cfg.skewSeconds * 1000, getDoc: (p) => store.get(p), isAdmin: user.admin });
    json(ctx, store.write(b.op, segs.join('/'), b.data, { ifVersion: b.ifVersion, quota: !user.admin, guard }));
  }

  function changes(ctx) {
    const user = needUser(ctx);
    const sinceRaw = ctx.query.get('since');
    if (typeof sinceRaw !== 'string' || !/^\d{1,15}$/.test(sinceRaw)) throw new HttpError(400, 'since must be a whole number.');
    const since = Number(sinceRaw);
    const wait = Math.min(25, Math.max(0, Math.floor(Number(ctx.query.get('wait'))) || 0));
    const now = changesFor(user, since);
    if (wait === 0 || now.reset || since < store.seq) return json(ctx, now);

    // nothing yet: hold the request until something this user may read changes (or the wait runs out)
    const mine = [...waiters].filter((w) => w.user.uid === user.uid);
    while (mine.length >= 4) mine.shift().release(true); // at most 4 at once per user: the oldest is answered empty
    const w = { user, since, done: false, timer: null };
    w.release = (empty) => {
      if (w.done) return;
      w.done = true; clearTimeout(w.timer); waiters.delete(w);
      json(ctx, empty ? { seq: store.seq, reset: false, changes: [] } : changesFor(user, since));
    };
    w.timer = setTimeout(() => w.release(true), wait * 1000);
    ctx.res.on('close', () => { if (!w.done) { w.done = true; clearTimeout(w.timer); waiters.delete(w); } });
    waiters.add(w);
  }

  async function profiles(ctx) {
    needUser(ctx);
    const b = await body(ctx);
    if (!Array.isArray(b.ids) || b.ids.length > 100) throw new HttpError(400, 'Send up to 100 ids.');
    const out = Object.create(null);
    for (const id of b.ids) {
      if (typeof id !== 'string' || id.length > 200) continue;
      const u = rules.SEGMENT.test(id) ? auth.users.get(id) : undefined;
      out[id] = { name: u ? u.display : '' };
    }
    json(ctx, { profiles: out });
  }

  // ---------- routing ----------

  const ADMIN_ACCOUNT = /^\/api\/admin\/accounts\/(u_[A-Za-z0-9_-]{22})\/(reset-password|disable)$/;
  const ADMIN_INVITE = /^\/api\/admin\/invites\/([A-Za-z0-9_-]{1,32})$/;
  const routes = {
    'GET /api/auth/config': (ctx) => json(ctx, { siteName: 'ClashBets', signupCode: !!cfg.signupCode }),
    'POST /api/auth/signup': signup,
    'POST /api/auth/login': login,
    'POST /api/auth/logout': logout,
    'GET /api/auth/me': (ctx) => json(ctx, meOf(needUser(ctx))),
    'POST /api/auth/password': changePassword,
    'POST /api/auth/redeem': redeem,
    'GET /api/admin/accounts': accounts,
    'POST /api/admin/invites': createInvite,
    'GET /api/admin/invites': listInvites,
    'GET /api/admin/group-link': groupLink,
    'POST /api/admin/import-now': importNow,
    'GET /api/db/list': dbList,
    'GET /api/db/doc': dbDoc,
    'POST /api/db/write': dbWrite,
    'GET /api/changes': changes,
    'POST /api/profiles': profiles,
  };

  async function api(ctx) {
    const { req, pathname } = ctx;
    if (ctx.m !== 'GET' && !H.csrfOk(req)) throw new HttpError(403, 'That request was blocked.');
    let fn = Object.prototype.hasOwnProperty.call(routes, `${ctx.m} ${pathname}`) ? routes[`${ctx.m} ${pathname}`] : null;
    if (!fn) {
      let m;
      if (ctx.m === 'POST' && (m = ADMIN_ACCOUNT.exec(pathname))) fn = (c) => (m[2] === 'disable' ? disable(c, m[1]) : resetPassword(c, m[1]));
      else if (ctx.m === 'DELETE' && (m = ADMIN_INVITE.exec(pathname))) fn = (c) => revokeInvite(c, m[1]);
    }
    if (!fn) throw new HttpError(404, 'Not found.');
    await fn(ctx);
  }

  // ---------- pages ----------

  const unavailable = (ctx) => H.sendText(ctx.res, 503, pages.unavailablePage(), 'text/html; charset=utf-8', { 'Retry-After': '30' });
  const page = (ctx, file, cache) => { if (!statics.serve(ctx.req, ctx.res, file, cache)) unavailable(ctx); };
  const ASSETS = {
    '/shim.js': ['shim.js', 'no-cache'],
    '/favicon.svg': ['favicon.svg', 'public, max-age=86400'],
    '/favicon.ico': ['favicon.ico', 'public, max-age=86400'],
    '/manifest.webmanifest': ['manifest.webmanifest', 'no-cache'],
  };

  function joinLanding(ctx) {
    const token = ctx.pathname.slice('/join/'.length);
    const gone = () => H.sendText(ctx.res, 410, pages.gonePage(), 'text/html; charset=utf-8');
    const inv = auth.findInvite(token);
    if (!inv) return gone();
    if (inv.usedAt) return ctx.user && inv.usedBy === ctx.user.uid ? H.redirect(ctx.res, '/') : gone(); // the person who used it, tapping again
    if (!auth.isOpen(inv)) return gone();
    const pname = playerName(inv.playerId);
    if (pname === null) return gone();
    const link = store.get(`links/${inv.playerId}`);
    const holder = link && typeof link.data.uid === 'string' ? auth.users.get(link.data.uid) : null;
    if (holder && !holder.disabled) return ctx.user && holder.uid === ctx.user.uid ? H.redirect(ctx.res, '/') : H.sendText(ctx.res, 409, pages.takenPage(), 'text/html; charset=utf-8');
    const me = ctx.user ? { display: ctx.user.display, username: ctx.user.username } : null;
    H.sendText(ctx.res, 200, pages.joinPage({ name: pname.slice(0, 60), token, me }), 'text/html; charset=utf-8');
  }

  function site(ctx) {
    const { pathname } = ctx;
    if (ctx.m !== 'GET') throw new HttpError(404, 'Not found.');
    if (pathname === '/healthz') return persist.failing() ? H.sendText(ctx.res, 503, 'saving to disk is failing') : H.sendText(ctx.res, 200, 'ok');
    if (pathname === '/') return ctx.user ? page(ctx, 'app.html', 'no-store') : H.redirect(ctx.res, '/login');
    if (pathname === '/login') return ctx.user ? H.redirect(ctx.res, '/') : page(ctx, 'login.html', 'no-cache');
    if (pathname.startsWith('/join/')) return joinLanding(ctx);
    if (pathname === '/robots.txt') return H.sendText(ctx.res, 200, 'User-agent: *\nDisallow: /\n');
    if (Object.prototype.hasOwnProperty.call(ASSETS, pathname)) {
      const [file, cache] = ASSETS[pathname];
      if (!statics.serve(ctx.req, ctx.res, file, cache)) { if (file === 'shim.js') return unavailable(ctx); throw new HttpError(404, 'Not found.'); }
      return undefined;
    }
    throw new HttpError(404, 'Not found.');
  }

  async function handle(req, res, https) {
    if (typeof req.url !== 'string' || req.url[0] !== '/') throw new HttpError(400, 'Bad request.');
    const qi = req.url.indexOf('?');
    const ctx = {
      req, res, https, m: req.method === 'HEAD' ? 'GET' : req.method,
      pathname: qi === -1 ? req.url : req.url.slice(0, qi),
      query: new URLSearchParams(qi === -1 ? '' : req.url.slice(qi + 1)),
      ip: null, ipk: null, user: null, token: null, key: null,
    };
    ctx.ip = H.clientIp(req, trust);
    ctx.ipk = H.ipKey(ctx.ip);
    const token = H.parseCookies(req.headers.cookie)[COOKIE];
    const s = token ? auth.session(token) : null;
    if (s) {
      ctx.user = s.user; ctx.token = token; ctx.key = s.key;
      if (s.refresh) res.setHeader('Set-Cookie', H.cookieString(COOKIE, token, { maxAge: maxAge(), secure: secure(ctx) }));
    }
    if (ctx.pathname.startsWith('/api/')) return api(ctx);
    return site(ctx);
  }

  function fail(res, e) {
    if (res.writableEnded) return;
    if (res.headersSent) { res.destroy(); return; }
    const known = e instanceof HttpError || e instanceof StoreError;
    if (!known) log(`[server] error: ${String(e && e.stack ? e.stack : e).split('\n').slice(0, 3).join(' | ')}`);
    const status = known ? e.status : 500;
    H.sendJson(res, status, { error: known ? e.message : 'Something went wrong on our side.' }, { ...(e && e.headers), ...(e && e.close ? { Connection: 'close' } : {}) });
    if (e && e.close) res.once('finish', () => res.req.destroy());
  }

  const server = http.createServer({ connectionsCheckingInterval: 2000 }, (req, res) => {
    H.securityHeaders(res, H.isHttps(req, trust));
    handle(req, res, H.isHttps(req, trust)).catch((e) => fail(res, e));
  });
  server.headersTimeout = 70000;
  server.requestTimeout = 30000;
  server.keepAliveTimeout = 65000; // longer than a proxy's idle timeout, or it sometimes sends on a socket we just closed
  server.maxConnections = 200;
  // A connection that hasn't sent a whole request within 10 seconds is dropped, and when people connect to us
  // directly one address can't hold more than 40 of them open (behind a proxy every connection is the proxy's).
  const open = new Map();
  server.on('connection', (socket) => {
    const addr = socket.remoteAddress || '?';
    const n = (open.get(addr) || 0) + 1;
    if (!trust && n > 40) { socket.destroy(); return; }
    open.set(addr, n);
    socket.once('close', () => { const m = (open.get(addr) || 1) - 1; if (m) open.set(addr, m); else open.delete(addr); });
    socket.setTimeout(10000, () => socket.destroy());
  });
  server.on('request', (req) => req.socket.setTimeout(0));
  // protocol-level failures (junk, oversized headers) still get the security headers
  server.on('clientError', (err, socket) => {
    if (!socket.writable) { socket.destroy(); return; }
    const status = err.code === 'HPE_HEADER_OVERFLOW' ? 431 : 400;
    const text = JSON.stringify({ error: status === 431 ? 'That request has too much in its headers.' : 'That was not a valid request.' });
    socket.end(`HTTP/1.1 ${status} ${status === 431 ? 'Request Header Fields Too Large' : 'Bad Request'}\r\nContent-Type: application/json; charset=utf-8\r\nContent-Length: ${Buffer.byteLength(text)}\r\nCache-Control: no-store\r\nConnection: close\r\n${H.rawSecurityHeaders()}\r\n${text}`);
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(cfg.port, cfg.host, resolve);
  });
  server.on('error', (e) => log(`[server] ${e.message}`)); // e.g. out of file handles: report it, keep serving
  importer.start();

  let closing = null;
  function close() {
    if (closing) return closing;
    closing = (async () => {
      importer.stop();
      clearInterval(purgeTimer);
      for (const w of [...waiters]) w.release(true);
      await new Promise((resolve) => {
        const grace = setTimeout(() => server.closeAllConnections(), 2000);
        server.close(() => { clearTimeout(grace); resolve(); });
        server.closeIdleConnections();
      });
      await persist.close(); // both data files, then one last backup push
    })();
    return closing;
  }

  const port = server.address().port;
  return { server, port, close, store, auth, persist, importer, config: cfg, base: `http://127.0.0.1:${port}` };
}

module.exports = { startServer, resolveConfig, seedStore, slugOf };

if (require.main === module) {
  startServer().then((app) => {
    console.log(`ClashBets is listening on port ${app.port}. Data folder: ${app.config.dataDir}`);
    let stopping = false;
    const stop = (why) => {
      if (stopping) return;
      stopping = true;
      console.log(`[server] ${why}: saving and shutting down.`);
      const force = setTimeout(() => process.exit(1), 15000);
      force.unref();
      app.close().then((saved) => process.exit(saved === false ? 1 : 0), (e) => { console.error(`[server] shutdown problem: ${e.message}`); process.exit(1); });
    };
    process.on('SIGTERM', () => stop('SIGTERM'));
    process.on('SIGINT', () => stop('SIGINT'));
    process.on('uncaughtException', (e) => {
      console.error(`[server] crash: ${e && e.stack ? e.stack : e}`);
      try { app.persist.flush(); } finally { process.exit(1); }
    });
  }).catch((e) => { console.error(`Could not start: ${e.message}`); process.exit(1); });
}
