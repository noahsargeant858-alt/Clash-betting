'use strict';

// The document store: what the page reads and writes. Documents live in memory,
// persistence is somebody else's job (see persist.js). Every committed change gets
// the next `seq`, bumps the document's `version` and lands in a short change log
// that the long-poll endpoint reads. Nothing here knows about users or sessions.

const { parsePath, ownerOf } = require('./rules');

const FORBIDDEN = new Set(['__proto__', 'constructor', 'prototype']);
const MAX_DOC_BYTES = 256 * 1024;
const MAX_DEPTH = 32;
const MAX_DOCS = 25000;
const MAX_LOG = 5000;
const MAX_TOTAL_BYTES = 32 * 1024 * 1024;
const OWNER_DOCS = 400;             // what one ordinary account may keep in its own folders
const OWNER_BYTES = 512 * 1024;
const PUBLIC_SHARE = 0.75;          // ordinary accounts stop at this share of the whole store, so the admin can always write

class StoreError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// Walks parsed JSON: null when fine, 'key' for a prototype-pollution key, 'deep' when nested too far.
// Recursion stops at maxDepth, so a hostile body can't blow the stack.
function scan(value, maxDepth) {
  const walk = (v, depth) => {
    if (v === null || typeof v !== 'object') return null;
    if (depth > maxDepth) return 'deep';
    if (Array.isArray(v)) {
      for (const x of v) { const r = walk(x, depth + 1); if (r) return r; }
      return null;
    }
    for (const k of Object.keys(v)) {
      if (FORBIDDEN.has(k)) return 'key';
      const r = walk(v[k], depth + 1);
      if (r) return r;
    }
    return null;
  };
  return walk(value, 1);
}

// `update`: top-level fields merge, nested objects merge, arrays and scalars replace. Builds a new object.
function merge(base, patch) {
  const out = {};
  for (const k of Object.keys(base)) if (!FORBIDDEN.has(k)) out[k] = base[k];
  for (const k of Object.keys(patch)) {
    if (FORBIDDEN.has(k)) continue;
    out[k] = isPlain(patch[k]) && isPlain(out[k]) ? merge(out[k], patch[k]) : patch[k];
  }
  return out;
}

const bytesOf = (data) => Buffer.byteLength(JSON.stringify(data));

class Store {
  constructor(opts = {}) {
    this.maxDocs = opts.maxDocs || MAX_DOCS;
    this.maxLog = opts.maxLog || MAX_LOG;
    this.maxDocBytes = opts.maxDocBytes || MAX_DOC_BYTES;
    this.maxTotalBytes = opts.maxTotalBytes || MAX_TOTAL_BYTES;
    this.ownerDocs = opts.ownerDocs || OWNER_DOCS;
    this.ownerBytes = opts.ownerBytes || OWNER_BYTES;
    this.docs = new Map();      // path -> { data, version, updatedAt, size }
    this.children = new Map();  // collection path -> Set of document paths directly inside it
    this.owners = new Map();    // uid -> { docs, bytes } across their own folders
    this.totalBytes = 0;
    this.seq = 0;
    this.log = [];              // [{ seq, path }], newest last, never persisted
    this.logBase = 0;           // the log holds every change with seq > logBase
    this.listeners = new Set(); // fn(seq, path) after each commit
    this.onChange = null;       // persistence hook
  }

  // ---------- loading and saving ----------

  // Returns how many documents were skipped because they broke the rules
  load(json) {
    let skipped = 0;
    const docs = json && isPlain(json.docs) ? json.docs : {};
    for (const path of Object.keys(docs)) {
      const rec = docs[path], segs = parsePath(path);
      if (!segs || segs.length % 2 !== 0 || !isPlain(rec) || !isPlain(rec.data) || !Number.isInteger(rec.version) || rec.version < 1
        || scan(rec.data, MAX_DEPTH)) { skipped++; continue; }
      const size = bytesOf(rec.data);
      this._index(path, segs, { data: rec.data, version: rec.version, updatedAt: typeof rec.updatedAt === 'string' ? rec.updatedAt : new Date(0).toISOString(), size });
    }
    this.seq = json && Number.isInteger(json.seq) && json.seq >= 0 ? json.seq : 0;
    this.logBase = this.seq; // changes from before this boot aren't in the log
    return skipped;
  }

  serialize() {
    const docs = {};
    for (const [path, r] of this.docs) docs[path] = { data: r.data, version: r.version, updatedAt: r.updatedAt };
    return JSON.stringify({ seq: this.seq, docs });
  }

  _index(path, segs, rec) {
    const old = this.docs.get(path);
    this.docs.set(path, rec);
    if (!old) {
      const parent = segs.slice(0, -1).join('/');
      let set = this.children.get(parent);
      if (!set) this.children.set(parent, (set = new Set()));
      set.add(path);
    }
    this._count(segs, old ? 0 : 1, rec.size - (old ? old.size : 0));
  }

  _unindex(path, segs) {
    const old = this.docs.get(path);
    if (!old) return;
    this.docs.delete(path);
    const parent = segs.slice(0, -1).join('/');
    const set = this.children.get(parent);
    if (set) { set.delete(path); if (!set.size) this.children.delete(parent); }
    this._count(segs, -1, -old.size);
  }

  _count(segs, docs, bytes) {
    this.totalBytes += bytes;
    const owner = ownerOf(segs);
    if (!owner) return;
    const o = this.owners.get(owner) || { docs: 0, bytes: 0 };
    o.docs += docs; o.bytes += bytes;
    if (o.docs <= 0 && o.bytes <= 0) this.owners.delete(owner); else this.owners.set(owner, o);
  }

  // ---------- reading ----------

  get(path) { return this.docs.get(path); }

  // Direct children of a collection, ordered by id: [{ id, path, data, version }]
  list(collection) {
    const set = this.children.get(collection);
    if (!set) return [];
    const out = [];
    for (const path of set) {
      const r = this.docs.get(path);
      out.push({ id: path.slice(path.lastIndexOf('/') + 1), path, data: r.data, version: r.version });
    }
    return out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  // ---------- writing ----------

  // op: 'set' | 'update' | 'delete'. Returns { version, seq }; throws StoreError.
  // opts.ifVersion: the version the caller last saw (0 = must not exist yet).
  // opts.quota: apply the per-account allowance (everyone but the owner and the importer).
  write(op, pathStr, data, opts = {}) {
    const segs = parsePath(pathStr);
    if (!segs || segs.length % 2 !== 0) throw new StoreError(400, 'That is not a valid document path.');
    if (op !== 'set' && op !== 'update' && op !== 'delete') throw new StoreError(400, 'Unknown operation.');
    const { ifVersion } = opts;
    if (ifVersion !== undefined && ifVersion !== null && (!Number.isInteger(ifVersion) || ifVersion < 0)) throw new StoreError(400, 'ifVersion must be a whole number.');
    if (op !== 'delete' && !isPlain(data)) throw new StoreError(400, 'The document must be a JSON object.');
    const path = segs.join('/');
    const cur = this.docs.get(path);
    if (op === 'update' && !cur) throw new StoreError(400, 'That document does not exist yet, so it can\'t be updated.');
    if (ifVersion !== undefined && ifVersion !== null && ifVersion !== (cur ? cur.version : 0)) {
      throw new StoreError(409, 'Someone else changed this first. Reload and try again.');
    }

    if (op === 'delete') {
      if (!cur) return { version: 0, seq: this.seq }; // idempotent, and not a change
      if (opts.guard) { const why = opts.guard('delete', segs, cur.data, null); if (why) throw new StoreError(409, why); }
      this._unindex(path, segs);
      this._commit(path);
      return { version: 0, seq: this.seq };
    }

    const problem = scan(data, MAX_DEPTH);
    if (problem === 'key') throw new StoreError(400, 'That document contains a forbidden field name.');
    if (problem === 'deep') throw new StoreError(507, 'That document is nested too deeply.');
    const next = op === 'set' ? data : merge(cur.data, data);
    if (opts.guard) { const why = opts.guard(op, segs, cur ? cur.data : null, next); if (why) throw new StoreError(409, why); }
    const size = bytesOf(next);
    if (size > this.maxDocBytes) throw new StoreError(507, 'That document is too big.');
    if (!cur && this.docs.size >= this.maxDocs) throw new StoreError(507, 'The site is full. Ask the admin.');
    if (this.totalBytes + size - (cur ? cur.size : 0) > this.maxTotalBytes) throw new StoreError(507, 'The site is out of space. Ask the admin.');
    if (opts.quota) {
      if (this.totalBytes + size - (cur ? cur.size : 0) > this.maxTotalBytes * PUBLIC_SHARE) throw new StoreError(507, 'The site is nearly out of space. Ask the admin.');
      const owner = ownerOf(segs);
      const o = (owner && this.owners.get(owner)) || { docs: 0, bytes: 0 };
      if (owner && (o.docs + (cur ? 0 : 1) > this.ownerDocs || o.bytes + size - (cur ? cur.size : 0) > this.ownerBytes)) {
        throw new StoreError(507, 'You\'ve used up your space. Delete something first.');
      }
    }
    this._index(path, segs, { data: next, version: (cur ? cur.version : 0) + 1, updatedAt: new Date().toISOString(), size });
    this._commit(path);
    return { version: this.docs.get(path).version, seq: this.seq };
  }

  _commit(path) {
    this.seq += 1;
    this.log.push({ seq: this.seq, path });
    if (this.log.length > this.maxLog) {
      const drop = this.log.splice(0, this.log.length - this.maxLog);
      this.logBase = drop[drop.length - 1].seq;
    }
    if (this.onChange) { try { this.onChange(); } catch { /* persistence problems are reported there */ } }
    for (const fn of this.listeners) { try { fn(this.seq, path); } catch { /* one bad listener must not stop the rest */ } }
  }

  subscribe(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }

  // Changes after `since`: { reset: true } when the log can't cover it (or `since` is from the future),
  // else { reset: false, paths: [paths in order of their last change] }
  changesSince(since) {
    if (since > this.seq || since < this.logBase) return { reset: true, paths: [] };
    let lo = 0, hi = this.log.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (this.log[mid].seq > since) hi = mid; else lo = mid + 1; }
    const seen = new Map();
    for (let i = lo; i < this.log.length; i++) { seen.delete(this.log[i].path); seen.set(this.log[i].path, true); }
    return { reset: false, paths: [...seen.keys()] };
  }
}

module.exports = { Store, StoreError, scan, merge, FORBIDDEN, MAX_DEPTH, MAX_DOC_BYTES, MAX_DOCS, MAX_LOG };
