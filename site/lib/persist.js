'use strict';

// Persistence: two JSON files in DATA_DIR (db.json, auth.json), each written atomically
// (temp file + rename), debounced about a second, flushed on shutdown.
// Optional: an encrypted copy of both files pushed to a GitHub branch, for hosts whose
// disk is wiped on every restart. It is restored at boot if DATA_DIR has no data files.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const FILES = { db: 'db.json', auth: 'auth.json' };

function writeAtomic(file, text) {
  const tmp = `${file}.${process.pid}.tmp`;
  const fd = fs.openSync(tmp, 'w', 0o600); // auth.json holds password hashes: owner only
  try { fs.writeFileSync(fd, text); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(tmp, file);
}

class Persist {
  constructor({ dir, log = () => {}, debounceMs = 1000, snapshot = null }) {
    this.dir = dir;
    this.log = log;
    this.debounceMs = debounceMs;
    this.snapshot = snapshot;
    this.providers = {};
    this.dirty = new Set();
    this.timer = null;
    this.failedSince = 0;
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    // half-written copies left by a crash
    for (const f of fs.readdirSync(dir)) if (/\.json\.\d+\.tmp$/.test(f)) { try { fs.unlinkSync(path.join(dir, f)); } catch { /* leave it */ } }
  }

  file(name) { return path.join(this.dir, FILES[name]); }
  hasData() { return Object.keys(FILES).some((n) => fs.existsSync(this.file(n))); }

  // Parsed contents of a data file, or null if it isn't there. A file that exists but isn't valid
  // JSON stops the boot: starting empty would overwrite whatever can still be rescued.
  read(name) {
    let text;
    try { text = fs.readFileSync(this.file(name), 'utf8'); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
    try { return JSON.parse(text); } catch { throw new Error(`${FILES[name]} in ${this.dir} is not valid JSON. Fix or move it, then start again.`); }
  }

  provide(name, fn) { this.providers[name] = fn; }

  markDirty(name) {
    this.dirty.add(name);
    if (this.timer || this.closed) return;
    this.timer = setTimeout(() => { this.timer = null; this.flush(); }, this.debounceMs);
    this.timer.unref();
  }

  // Writes every file that changed. Safe to call any time; failures stay dirty and are retried.
  flush() {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    let wrote = false;
    for (const name of [...this.dirty]) {
      try {
        writeAtomic(this.file(name), this.providers[name]());
        this.dirty.delete(name);
        wrote = true;
        this.failedSince = 0;
      } catch (e) {
        if (!this.failedSince) this.failedSince = Date.now();
        this.log(`[persist] could not write ${FILES[name]}: ${e.message}`);
        if (!this.closed && !this.timer) { this.timer = setTimeout(() => { this.timer = null; this.flush(); }, 5000); this.timer.unref(); }
      }
    }
    if (wrote && this.snapshot) this.snapshot.notify();
    return !this.dirty.size;
  }

  // true when saving has been failing for a while, so the host's health check can say so
  failing() { return this.failedSince > 0 && Date.now() - this.failedSince > 10000; }

  async close() {
    this.closed = true;
    const ok = this.flush();
    if (this.snapshot) await this.snapshot.close();
    return ok;
  }
}

// ---------- encrypted GitHub snapshot ----------

const SNAPSHOT_FILE = 'clashbets-snapshot.json';
const AAD = Buffer.from('clashbets-snapshot-v1');
const scryptAsync = (secret, salt, n) => new Promise((resolve, reject) => {
  crypto.scrypt(secret, salt, 32, { N: n, r: 8, p: 1, maxmem: 256 * 1024 * 1024 }, (e, k) => (e ? reject(e) : resolve(k)));
});
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const enc = encodeURIComponent;

class GithubSnapshot {
  // o: { repo 'owner/name', branch, token, key, apiBase, dir, intervalMs, scryptN, log }
  constructor(o) {
    this.repo = o.repo;
    this.branch = o.branch || 'site-backup';
    this.token = o.token;
    this.key = o.key;
    this.base = String(o.apiBase || 'https://api.github.com').replace(/\/+$/, '');
    this.dir = o.dir;
    this.intervalMs = o.intervalMs == null ? 10 * 60 * 1000 : o.intervalMs;
    this.n = o.scryptN || 32768;
    this.log = o.log || (() => {});
    this.sha = null;          // sha of the snapshot file on the branch, once known
    this.lastDigest = null;   // what the branch holds, so identical data is never pushed twice
    this.lastPush = 0;
    this.pending = false;
    this.retryAt = 0;         // after a failed push, wait before trying again
    this.timer = null;
    this.running = null;
    this.disabled = false;    // set when a restore failed: never overwrite a backup we couldn't read
  }

  // Needs SNAPSHOT_REPO, SNAPSHOT_TOKEN and SNAPSHOT_KEY. Returns null (with a reason logged) if not usable.
  static create(o) {
    const log = o.log || (() => {});
    const given = [o.repo, o.token, o.key].filter(Boolean).length;
    if (given === 0) return null;
    if (given < 3) { log('[snapshot] backup is off: it needs SNAPSHOT_REPO, SNAPSHOT_TOKEN and SNAPSHOT_KEY together.'); return null; }
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(o.repo)) { log('[snapshot] backup is off: SNAPSHOT_REPO must look like owner/name.'); return null; }
    if (o.branch && !/^[A-Za-z0-9._/-]{1,100}$/.test(o.branch)) { log('[snapshot] backup is off: SNAPSHOT_BRANCH has odd characters.'); return null; }
    if (String(o.key).length < 24) { log('[snapshot] backup is off: SNAPSHOT_KEY must be at least 24 characters.'); return null; }
    return new GithubSnapshot(o);
  }

  url() { return `${this.base}/repos/${this.repo}/contents/${SNAPSHOT_FILE}`; }

  async api(method, url, body, accept) {
    const res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: accept || 'application/vnd.github+json',
        'User-Agent': 'clashbets-site',
        'X-GitHub-Api-Version': '2022-11-28',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(20000),
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* raw content or an error page */ }
    return { status: res.status, text, json };
  }

  // never include anything but status and GitHub's own message in logs
  why(r) { return `${r.status} ${String((r.json && r.json.message) || '').slice(0, 160)}`.trim(); }

  async encrypt(files) {
    const salt = crypto.randomBytes(16), iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', await scryptAsync(this.key, salt, this.n), iv);
    cipher.setAAD(AAD);
    const data = Buffer.concat([cipher.update(JSON.stringify({ v: 1, at: new Date().toISOString(), files }), 'utf8'), cipher.final()]);
    return JSON.stringify({ v: 1, alg: 'aes-256-gcm', kdf: 'scrypt', n: this.n, salt: salt.toString('base64'), iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') }) + '\n';
  }

  async decrypt(text) {
    const env = JSON.parse(text);
    if (!env || env.v !== 1 || env.alg !== 'aes-256-gcm') throw new Error('unknown snapshot format');
    const n = Number(env.n);
    if (!Number.isInteger(n) || n < 1024 || n > 131072 || (n & (n - 1)) !== 0) throw new Error('bad snapshot parameters');
    const tag = Buffer.from(String(env.tag), 'base64');
    if (tag.length !== 16) throw new Error('bad snapshot tag');
    const decipher = crypto.createDecipheriv('aes-256-gcm', await scryptAsync(this.key, Buffer.from(env.salt, 'base64'), n), Buffer.from(env.iv, 'base64'), { authTagLength: 16 });
    decipher.setAAD(AAD);
    decipher.setAuthTag(tag);
    const plain = Buffer.concat([decipher.update(Buffer.from(env.data, 'base64')), decipher.final()]).toString('utf8');
    const out = JSON.parse(plain);
    if (!out || out.v !== 1 || !out.files || typeof out.files !== 'object') throw new Error('bad snapshot contents');
    return out.files;
  }

  // 'restored' | 'none' (nothing backed up yet) | 'failed'. A failure switches pushing off.
  async restore() {
    try {
      const r = await this.api('GET', `${this.url()}?ref=${enc(this.branch)}`, null, 'application/vnd.github.raw+json');
      if (r.status === 404) { this.log('[snapshot] no backup on the branch yet; starting fresh.'); return 'none'; }
      if (r.status !== 200) throw new Error(`GitHub said ${this.why(r)}`);
      const files = await this.decrypt(r.text);
      const parsed = {};
      for (const file of Object.values(FILES)) if (typeof files[file] === 'string') parsed[file] = JSON.parse(files[file]); // refuse anything that isn't JSON
      for (const file of Object.keys(parsed)) writeAtomic(path.join(this.dir, file), files[file]);
      this.lastDigest = sha256(JSON.stringify(this.readFiles()));
      this.log('[snapshot] restored data from the backup branch.');
      return 'restored';
    } catch (e) {
      this.disabled = true;
      this.log(`[snapshot] COULD NOT RESTORE the backup (${e.message}). Backups are switched off for this run so the old one isn't overwritten. Check SNAPSHOT_KEY and the token.`);
      return 'failed';
    }
  }

  readFiles() {
    const out = {};
    for (const f of Object.values(FILES)) { try { out[f] = fs.readFileSync(path.join(this.dir, f), 'utf8'); } catch { out[f] = null; } }
    return out;
  }

  // called after the data files changed on disk
  notify() {
    if (this.disabled || this.closing) return;
    this.pending = true;
    if (this.timer || this.running) return;
    const wait = Math.max(0, this.lastPush + this.intervalMs - Date.now(), this.retryAt - Date.now());
    this.timer = setTimeout(() => { this.timer = null; this.pushNow().catch(() => {}); }, wait);
    this.timer.unref();
  }

  pushNow() {
    if (this.disabled) return Promise.resolve(false);
    if (this.running) return this.running;
    this.pending = false;
    const run = this._push().finally(() => {
      this.lastPush = Date.now();
      this.running = null;
      if (this.pending && !this.closing) this.notify();
    });
    this.running = run;
    return run;
  }

  async _push() {
    try {
      const files = this.readFiles();
      const digest = sha256(JSON.stringify(files));
      if (digest === this.lastDigest) return false;
      await this.put(await this.encrypt(files));
      this.lastDigest = digest;
      this.retryAt = 0;
      this.log('[snapshot] backed up.');
      return true;
    } catch (e) {
      this.log(`[snapshot] backup failed: ${e.message}`);
      this.pending = true;
      this.retryAt = Date.now() + 30000;
      return false;
    }
  }

  async put(text) {
    for (let attempt = 0; attempt < 4; attempt++) {
      const body = { message: `Snapshot ${new Date().toISOString()}`, content: Buffer.from(text).toString('base64'), branch: this.branch };
      if (this.sha) body.sha = this.sha;
      const r = await this.api('PUT', this.url(), body);
      if (r.status === 200 || r.status === 201) { this.sha = (r.json && r.json.content && r.json.content.sha) || null; return; }
      const msg = String((r.json && r.json.message) || '');
      if ((r.status === 404 || r.status === 422) && /branch/i.test(msg)) { await this.ensureBranch(); continue; }
      if (r.status === 409 || r.status === 422) { this.sha = await this.fetchSha(); continue; } // stale or missing sha
      throw new Error(`GitHub said ${this.why(r)}`);
    }
    throw new Error('GitHub kept refusing the snapshot');
  }

  async fetchSha() {
    const r = await this.api('GET', `${this.url()}?ref=${enc(this.branch)}`);
    if (r.status === 404) return null;
    if (r.status !== 200 || !r.json || typeof r.json.sha !== 'string') throw new Error(`GitHub said ${this.why(r)}`);
    return r.json.sha;
  }

  // the branch doesn't exist yet: start it from the repository's default branch
  async ensureBranch() {
    const repo = await this.api('GET', `${this.base}/repos/${this.repo}`);
    if (repo.status !== 200 || !repo.json || !repo.json.default_branch) throw new Error(`GitHub said ${this.why(repo)}`);
    const heads = repo.json.default_branch.split('/').map(enc).join('/');
    const ref = await this.api('GET', `${this.base}/repos/${this.repo}/git/ref/heads/${heads}`);
    const sha = ref.json && ref.json.object && ref.json.object.sha;
    if (ref.status !== 200 || !sha) throw new Error(`GitHub said ${this.why(ref)}`);
    const made = await this.api('POST', `${this.base}/repos/${this.repo}/git/refs`, { ref: `refs/heads/${this.branch}`, sha });
    if (made.status !== 201 && made.status !== 422) throw new Error(`GitHub said ${this.why(made)}`);
  }

  // shutdown: one last push of the latest data (after any push already in flight, which may be older),
  // but never hang the exit
  async close(timeoutMs = 8000) {
    this.closing = true;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    if (this.disabled) return;
    let t;
    const last = (async () => {
      if (this.running) await this.running.catch(() => {});
      await this.pushNow();
    })();
    await Promise.race([last, new Promise((resolve) => { t = setTimeout(resolve, timeoutMs); })]);
    clearTimeout(t);
  }
}

module.exports = { Persist, GithubSnapshot, writeAtomic, FILES, SNAPSHOT_FILE };
