'use strict';

// Accounts, passwords, sessions, invites and rate limits. Held in memory, saved to auth.json
// by persist.js. Never exposed through the db API; only hashes of secrets are stored.

const crypto = require('crypto');
const { HttpError } = require('./http');

const USERNAME = /^[a-z0-9][a-z0-9_.-]{2,23}$/;
const INVITE_TOKEN = /^[A-Za-z0-9_-]{20,64}$/;
const MAX_SESSIONS = 20;
const DAY = 86400e3;
// no 0 O 1 l I: temporary passwords get read out and typed on phones
const TEMP_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
// control characters, line separators and the bidi overrides that can make a name read backwards
const BAD_DISPLAY = new RegExp('[\\u0000-\\u001f\\u007f-\\u009f\\u2028\\u2029\\u202a-\\u202e\\u2066-\\u2069]');

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const iso = (ms) => new Date(ms === undefined ? Date.now() : ms).toISOString();
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// ---------- password hashing ----------

// scrypt (N=2^15, r=8, p=1, 64-byte output) on the thread pool. Only a few run at once and the queue is
// bounded, so a flood of login attempts can't eat all the memory (each hash needs 32 MiB).
class Hasher {
  constructor(n = 32768, slots = 4, maxQueue = 64) {
    this.n = n; this.slots = slots; this.maxQueue = maxQueue;
    this.active = 0; this.queue = [];
    this.dummySalt = crypto.randomBytes(16);
  }

  async _slot() {
    if (this.active < this.slots) { this.active++; return; }
    if (this.queue.length >= this.maxQueue) throw new HttpError(503, 'The site is busy. Try again in a moment.');
    await new Promise((resolve) => this.queue.push(resolve));
  }

  _release() {
    const next = this.queue.shift();
    if (next) next(); else this.active--;
  }

  async _scrypt(password, salt) {
    await this._slot();
    try {
      return await new Promise((resolve, reject) => {
        crypto.scrypt(password, salt, 64, { N: this.n, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (e, k) => (e ? reject(e) : resolve(k)));
      });
    } finally { this._release(); }
  }

  async hash(password) {
    const salt = crypto.randomBytes(16);
    return `s1:${salt.toString('base64')}:${(await this._scrypt(password, salt)).toString('base64')}`;
  }

  // Unknown account (stored = null) costs the same as a wrong password, so timing doesn't show which names exist
  async verify(password, stored) {
    const m = typeof stored === 'string' ? /^s1:([A-Za-z0-9+/=]+):([A-Za-z0-9+/=]+)$/.exec(stored) : null;
    if (!m) { await this._scrypt(password, this.dummySalt); return false; }
    const want = Buffer.from(m[2], 'base64'), got = await this._scrypt(password, Buffer.from(m[1], 'base64'));
    return want.length === got.length && crypto.timingSafeEqual(want, got);
  }
}

// ---------- rate limits ----------

// Sliding window of event times per key, with a bounded number of keys
class RateLimiter {
  constructor(limit, windowMs, maxKeys = 20000) {
    this.limit = limit; this.windowMs = windowMs; this.maxKeys = maxKeys;
    this.hits = new Map();
  }

  _live(key, now) {
    const arr = this.hits.get(key);
    if (!arr) return null;
    let i = 0;
    while (i < arr.length && arr[i] <= now - this.windowMs) i++;
    if (i) arr.splice(0, i);
    if (!arr.length) { this.hits.delete(key); return null; }
    return arr;
  }

  count(key, now = Date.now()) { const a = this._live(key, now); return a ? a.length : 0; }
  blocked(key, now = Date.now()) { return this.count(key, now) >= this.limit; }

  add(key, now = Date.now()) {
    let arr = this._live(key, now);
    if (!arr) {
      if (this.hits.size >= this.maxKeys) {
        for (const k of [...this.hits.keys()]) this._live(k, now);
        if (this.hits.size >= this.maxKeys) this.hits.delete(this.hits.keys().next().value);
      }
      arr = [];
      this.hits.set(key, arr);
    }
    arr.push(now);
  }

  // counts the event if there is room; false means over the limit
  take(key, now = Date.now()) {
    if (this.blocked(key, now)) return false;
    this.add(key, now);
    return true;
  }

  reset(key) { this.hits.delete(key); }

  // whole seconds until one more event would be allowed
  retryAfter(key, now = Date.now()) {
    const arr = this._live(key, now);
    return arr && arr.length >= this.limit ? Math.max(1, Math.ceil((arr[arr.length - this.limit] + this.windowMs - now) / 1000)) : 0;
  }
}

// ---------- accounts ----------

class Auth {
  constructor(opts = {}) {
    this.sessionMs = (opts.sessionDays || 90) * DAY;
    this.inviteMs = (opts.inviteDays || 14) * DAY;
    this.hasher = new Hasher(opts.scryptN);
    this.users = new Map();     // uid -> user
    this.byName = new Map();    // username -> uid
    this.sessions = new Map();  // sha256(token) -> { uid, createdAt, lastUsedAt, expiresAt }
    this.invites = new Map();   // id -> invite
    this.inviteByHash = new Map();
    this.onChange = null;
    const L = opts.limits || {};
    this.limits = {
      // wrong passwords: 10 per person-and-connection pair, 30 per connection, 300 per username overall (so one
      // stranger can't lock a friend out from everywhere); and every attempt, right or wrong, counts toward
      // loginAttempt, so a flood of correct logins can't hog the password hasher either
      loginUser: new RateLimiter(L.loginPerUser || 10, 15 * 60e3),
      loginIp: new RateLimiter(L.loginPerIp || 30, 15 * 60e3),
      loginUserAll: new RateLimiter(L.loginPerUserAll || 300, 15 * 60e3),
      loginAttempt: new RateLimiter(L.loginAttemptsPerIp || 60, 5 * 60e3),
      signupIp: new RateLimiter(L.signupPerHour || 30, 60 * 60e3),
      signupAll: new RateLimiter(L.signupAllPerHour || 60, 60 * 60e3),
      redeemIp: new RateLimiter(L.redeemPer15Min || 20, 15 * 60e3),
      password: new RateLimiter(L.passwordPerUser || 10, 15 * 60e3),
      write: new RateLimiter(L.writesPerMin || 120, 60e3),
    };
  }

  changed() { if (this.onChange) { try { this.onChange(); } catch { /* reported by persist */ } } }

  // ---------- loading and saving ----------

  load(json) {
    const j = isObj(json) ? json : {};
    for (const u of Object.values(isObj(j.users) ? j.users : {})) {
      if (!isObj(u) || typeof u.uid !== 'string' || typeof u.username !== 'string' || this.byName.has(u.username)) continue;
      this.users.set(u.uid, {
        uid: u.uid, username: u.username, display: typeof u.display === 'string' ? u.display : u.username, admin: u.admin === true, disabled: u.disabled === true,
        pass: typeof u.pass === 'string' ? u.pass : null, via: ['signup', 'invite', 'admin'].includes(u.via) ? u.via : 'signup',
        createdAt: typeof u.createdAt === 'string' ? u.createdAt : iso(0), lastSeenAt: typeof u.lastSeenAt === 'string' ? u.lastSeenAt : iso(0),
      });
      this.byName.set(u.username, u.uid);
    }
    const now = Date.now();
    for (const [k, s] of Object.entries(isObj(j.sessions) ? j.sessions : {})) {
      if (isObj(s) && this.users.has(s.uid) && Date.parse(s.expiresAt) > now) this.sessions.set(k, { uid: s.uid, createdAt: s.createdAt, lastUsedAt: s.lastUsedAt, expiresAt: s.expiresAt });
    }
    for (const inv of Object.values(isObj(j.invites) ? j.invites : {})) {
      if (!isObj(inv) || typeof inv.id !== 'string' || typeof inv.hash !== 'string' || typeof inv.playerId !== 'string') continue;
      this.invites.set(inv.id, { id: inv.id, hash: inv.hash, playerId: inv.playerId, createdAt: inv.createdAt, expiresAt: inv.expiresAt, usedAt: inv.usedAt || null, usedBy: inv.usedBy || null });
      this.inviteByHash.set(inv.hash, inv.id);
    }
  }

  serialize() {
    return JSON.stringify({
      users: Object.fromEntries(this.users), sessions: Object.fromEntries(this.sessions), invites: Object.fromEntries(this.invites),
    });
  }

  // ---------- field rules ----------

  normUsername(raw) {
    if (typeof raw !== 'string') return null;
    const u = raw.trim().toLowerCase();
    return USERNAME.test(u) ? u : null;
  }

  // 1-30 characters, trimmed, no control characters. Returns the clean name or null.
  cleanDisplay(raw) {
    if (typeof raw !== 'string') return null;
    const d = raw.trim();
    const len = [...d].length;
    return len >= 1 && len <= 30 && !BAD_DISPLAY.test(d) ? d : null;
  }

  passwordProblem(pw, username) {
    if (typeof pw !== 'string' || [...pw].length < 8) return 'Your password needs at least 8 characters.';
    if ([...pw].length > 200) return 'Your password can be at most 200 characters.';
    if (username && pw.toLowerCase() === username) return 'Your password can\'t be the same as your username.';
    return null;
  }

  tempPassword() {
    let out = '';
    for (let i = 0; i < 16; i++) out += TEMP_ALPHABET[crypto.randomInt(TEMP_ALPHABET.length)];
    return out;
  }

  // ---------- users ----------

  newUid() { return 'u_' + crypto.randomBytes(16).toString('base64url'); }

  createUser({ uid, username, display, admin = false, pass = null, via = 'signup' }) {
    if (this.byName.has(username)) throw new HttpError(409, 'That username is taken.');
    const user = { uid: uid || this.newUid(), username, display, admin, disabled: false, pass, via, createdAt: iso(), lastSeenAt: iso() };
    this.users.set(user.uid, user);
    this.byName.set(username, user.uid);
    this.changed();
    return user;
  }

  userByName(name) { const uid = this.byName.get(name); return uid ? this.users.get(uid) : undefined; }

  // 'ok' | 'bad' | 'disabled', after a full-cost password check whatever the account
  async authenticate(username, password) {
    const name = typeof username === 'string' ? username.trim().toLowerCase() : '';
    const user = this.userByName(name);
    const given = typeof password === 'string' && password.length <= 1000 ? password : '';
    const ok = await this.hasher.verify(given, user ? user.pass : null);
    if (!user || !ok) return { status: 'bad' };
    return { status: user.disabled ? 'disabled' : 'ok', user };
  }

  async setPassword(user, password) {
    user.pass = await this.hasher.hash(password);
    this.changed();
  }

  setUsername(user, username) {
    const other = this.byName.get(username);
    if (other && other !== user.uid) throw new HttpError(409, 'That username is taken.');
    this.byName.delete(user.username);
    user.username = username;
    this.byName.set(username, user.uid);
    this.changed();
  }

  // first free username built from `base`: base, base2, base3 ...
  freeUsername(base) {
    let name = base.slice(0, 20);
    for (let i = 2; this.byName.has(name); i++) name = base.slice(0, 20) + i;
    return name;
  }

  setDisabled(user, disabled) {
    user.disabled = !!disabled;
    if (user.disabled) this.revokeUser(user.uid);
    this.changed();
  }

  // The owner's account comes from the environment. A password in ADMIN_PASSWORD always wins;
  // without one a random password is made on the very first boot and returned once.
  async ensureAdmin({ username, password }) {
    const wanted = this.normUsername(username || 'admin');
    if (!wanted) throw new Error('ADMIN_USERNAME must be 3 to 24 characters: lowercase letters, numbers, dots, dashes or underscores.');
    const set = typeof password === 'string' && password !== '';
    if (set) { const p = this.passwordProblem(password, wanted); if (p) throw new Error(`ADMIN_PASSWORD: ${p}`); }
    const out = { created: false, renamed: false, generated: null };
    let admin = [...this.users.values()].filter((u) => u.admin).sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1))[0];
    if (!admin) {
      const pw = set ? password : this.tempPassword();
      admin = this.createUser({ username: this.freeUsername(wanted), display: wanted[0].toUpperCase() + wanted.slice(1), admin: true, pass: await this.hasher.hash(pw), via: 'admin' });
      out.created = true;
      if (!set) out.generated = pw;
    } else {
      if (admin.username !== wanted && !this.byName.has(wanted)) { this.setUsername(admin, wanted); out.renamed = true; }
      if (set && !(await this.hasher.verify(password, admin.pass))) { await this.setPassword(admin, password); this.revokeUser(admin.uid); }
      if (set && admin.disabled) { admin.disabled = false; this.changed(); }
    }
    out.admin = admin;
    return out;
  }

  // ---------- sessions ----------

  createSession(uid) {
    const token = crypto.randomBytes(32).toString('base64url');
    const now = Date.now();
    this.sessions.set(sha256(token), { uid, createdAt: iso(now), lastUsedAt: iso(now), expiresAt: iso(now + this.sessionMs) });
    const mine = [...this.sessions].filter(([, s]) => s.uid === uid).sort((a, b) => (a[1].createdAt < b[1].createdAt ? -1 : 1));
    for (const [k] of mine.slice(0, Math.max(0, mine.length - MAX_SESSIONS))) this.sessions.delete(k);
    this.changed();
    return token;
  }

  // { user, key, refresh } for a live session, else null. `refresh` means the lifetime was just
  // extended, so the cookie should be sent again (a friend who keeps coming back stays signed in).
  session(token) {
    if (typeof token !== 'string' || token.length < 20 || token.length > 100) return null;
    const key = sha256(token), s = this.sessions.get(key);
    if (!s) return null;
    const now = Date.now();
    if (!(Date.parse(s.expiresAt) > now)) { this.sessions.delete(key); this.changed(); return null; }
    const user = this.users.get(s.uid);
    if (!user || user.disabled) return null;
    let refresh = false;
    if (now - Date.parse(s.lastUsedAt) > 5 * 60e3) {
      s.lastUsedAt = iso(now); user.lastSeenAt = iso(now);
      if (Date.parse(s.expiresAt) - now < this.sessionMs - DAY) { s.expiresAt = iso(now + this.sessionMs); refresh = true; }
      this.changed();
    }
    return { user, key, refresh };
  }

  revokeToken(token) {
    if (typeof token === 'string' && this.sessions.delete(sha256(token))) this.changed();
  }

  // all of a user's sessions, except the one named by `keepKey`
  revokeUser(uid, keepKey) {
    let n = 0;
    for (const [k, s] of this.sessions) if (s.uid === uid && k !== keepKey) { this.sessions.delete(k); n++; }
    if (n) this.changed();
    return n;
  }

  // ---------- invites ----------

  createInvite(playerId) {
    const token = crypto.randomBytes(24).toString('base64url');
    const id = crypto.randomBytes(8).toString('base64url');
    const now = Date.now();
    const invite = { id, hash: sha256(token), playerId, createdAt: iso(now), expiresAt: iso(now + this.inviteMs), usedAt: null, usedBy: null };
    this.invites.set(id, invite);
    this.inviteByHash.set(invite.hash, id);
    this.changed();
    return { invite, token };
  }

  findInvite(token) {
    if (typeof token !== 'string' || !INVITE_TOKEN.test(token)) return null;
    const id = this.inviteByHash.get(sha256(token));
    return id ? this.invites.get(id) || null : null;
  }

  isOpen(invite, now = Date.now()) { return !invite.usedAt && Date.parse(invite.expiresAt) > now; }

  markUsed(invite, uid) { invite.usedAt = iso(); invite.usedBy = uid; this.changed(); }

  revokeInvite(id) {
    const inv = this.invites.get(id);
    if (!inv) return false;
    this.invites.delete(id);
    this.inviteByHash.delete(inv.hash);
    this.changed();
    return true;
  }

  // forget dead sessions and invites that finished long ago
  purge(now = Date.now()) {
    let n = 0;
    for (const [k, s] of this.sessions) if (!(Date.parse(s.expiresAt) > now)) { this.sessions.delete(k); n++; }
    for (const inv of [...this.invites.values()]) {
      const end = inv.usedAt ? Date.parse(inv.usedAt) : Date.parse(inv.expiresAt);
      if (end + 30 * DAY < now) { this.invites.delete(inv.id); this.inviteByHash.delete(inv.hash); n++; }
    }
    if (n) this.changed();
    return n;
  }
}

module.exports = { Auth, Hasher, RateLimiter, INVITE_TOKEN, sha256 };
