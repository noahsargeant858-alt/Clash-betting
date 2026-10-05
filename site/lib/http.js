'use strict';

// Small HTTP helpers: security headers, JSON in and out, cookies, client addresses,
// the CSRF check, and serving the few static files from a fixed allow-list.

const fs = require('fs');
const path = require('path');
const net = require('net');
const zlib = require('zlib');
const crypto = require('crypto');
const { scan } = require('./store');

class HttpError extends Error {
  constructor(status, message, headers) { super(message); this.status = status; this.headers = headers || null; }
}

const CSP = [
  "default-src 'none'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  'font-src https://fonts.gstatic.com',
  "img-src 'self' data:",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

// set on every response before anything else happens, so errors and redirects carry them too
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
  'Content-Security-Policy': CSP,
};
function securityHeaders(res, https) {
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
  if (https) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
}
// the same headers as a raw block, for responses written straight to a socket
function rawSecurityHeaders() {
  return Object.entries(SECURITY_HEADERS).map(([k, v]) => `${k}: ${v}\r\n`).join('');
}

function sendJson(res, status, obj, headers) {
  const body = Buffer.from(JSON.stringify(obj));
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': body.length, 'Cache-Control': 'no-store', ...headers });
  res.end(body);
}

function sendText(res, status, text, type = 'text/plain; charset=utf-8', headers) {
  const body = Buffer.from(text);
  res.writeHead(status, { 'Content-Type': type, 'Content-Length': body.length, 'Cache-Control': 'no-store', ...headers });
  res.end(body);
}

function redirect(res, location, status = 302) {
  res.writeHead(status, { Location: location, 'Cache-Control': 'no-store', 'Content-Length': 0 });
  res.end();
}

// ---------- request bodies ----------

const HARD_BODY_LIMIT = 8 * 1024 * 1024; // past this we stop listening to the client altogether

// Reads the whole body. Over `limit` bytes it keeps discarding (so the client can finish and read
// the 413) up to a hard cap. Slow senders are cut off after `timeoutMs`.
function readBody(req, limit, timeoutMs) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > HARD_BODY_LIMIT) {
      const e = new HttpError(413, 'That request is too big.'); e.close = true; return reject(e);
    }
    const chunks = [];
    let size = 0, done = false;
    const finish = (fn, v) => { if (done) return; done = true; clearTimeout(timer); fn(v); };
    const timer = setTimeout(() => { const e = new HttpError(408, 'That request took too long to arrive.'); e.close = true; finish(reject, e); }, timeoutMs);
    req.on('data', (c) => {
      if (done) return;
      size += c.length;
      if (size > HARD_BODY_LIMIT) { const e = new HttpError(413, 'That request is too big.'); e.close = true; finish(reject, e); return; }
      if (size <= limit) chunks.push(c); else chunks.length = 0;
    });
    req.on('end', () => (size > limit ? finish(reject, new HttpError(413, 'That request is too big.')) : finish(resolve, Buffer.concat(chunks))));
    req.on('error', () => finish(reject, new HttpError(400, 'The connection closed early.'))); // a client that hangs up mid-upload
    req.on('close', () => finish(reject, new HttpError(400, 'The connection closed early.')));
  });
}

// An empty body counts as {}. Anything but a JSON object is refused, as are prototype-pollution keys.
function parseJsonObject(buf) {
  if (!buf.length) return {};
  let v;
  try { v = JSON.parse(buf.toString('utf8')); } catch { throw new HttpError(400, 'That request was not valid JSON.'); }
  if (v === null || typeof v !== 'object' || Array.isArray(v)) throw new HttpError(400, 'Send a JSON object.');
  const problem = scan(v, 34);
  if (problem === 'key') throw new HttpError(400, 'That request contains a forbidden field name.');
  if (problem === 'deep') throw new HttpError(400, 'That request is nested too deeply.');
  return v;
}

// ---------- cookies ----------

function parseCookies(header) {
  const out = Object.create(null);
  if (typeof header !== 'string' || header.length > 8192) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 1) continue;
    const k = part.slice(0, i).trim();
    if (!(k in out)) out[k] = part.slice(i + 1).trim(); // first one wins
  }
  return out;
}

function cookieString(name, value, { maxAge, secure }) {
  return `${name}=${value}; Max-Age=${maxAge}; Path=/; HttpOnly; SameSite=Lax${maxAge === 0 ? '; Expires=Thu, 01 Jan 1970 00:00:00 GMT' : ''}${secure ? '; Secure' : ''}`;
}

// ---------- who is asking ----------

const stripV4 = (ip) => ip.replace(/^::ffff:/i, '');

// trust = how many proxies sit in front of us (0 = none). Then the client is the Nth address from the right.
function clientIp(req, trust) {
  let ip = stripV4(req.socket.remoteAddress || '0.0.0.0');
  const hops = Math.floor(Number(trust));
  if (hops > 0) {
    const xff = String(req.headers['x-forwarded-for'] || '').split(',').map((s) => s.trim()).filter(Boolean);
    const pick = xff.length >= hops ? stripV4(xff[xff.length - hops]) : null;
    if (pick && net.isIP(pick)) ip = pick;
  }
  return ip;
}

// Rate limits count an IPv6 /64 as one client (a home connection has billions of addresses)
function ipKey(ip) {
  if (net.isIPv6(ip)) {
    const clean = ip.split('%')[0], dbl = clean.indexOf('::');
    const head = (dbl === -1 ? clean : clean.slice(0, dbl)).split(':').filter(Boolean);
    const tail = dbl === -1 ? [] : clean.slice(dbl + 2).split(':').filter(Boolean);
    const groups = [...head, ...Array(Math.max(0, 8 - head.length - tail.length)).fill('0'), ...tail];
    if (groups.length === 8) return groups.slice(0, 4).map((g) => parseInt(g, 16).toString(16)).join(':') + '::/64';
  }
  return ip;
}

function isHttps(req, trust) {
  if (req.socket.encrypted) return true;
  return Math.floor(Number(trust)) > 0 && String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase() === 'https';
}

// Safe to put into a URL we hand out: a plain host[:port], else a placeholder
function hostOf(req) {
  const h = String(req.headers.host || '');
  return /^[A-Za-z0-9.\-]+(:\d{1,5})?$|^\[[0-9A-Fa-f:.]+\](:\d{1,5})?$/.test(h) ? h : 'localhost';
}

// ---------- CSRF ----------

// State-changing requests must be JSON with our own header (a plain cross-site form or fetch can't send both
// without a CORS preflight, which we never grant) and, if the browser says where it came from, it must be us.
function csrfOk(req) {
  if (req.headers['x-cb'] !== '1') return false;
  if (String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase() !== 'application/json') return false;
  const origin = req.headers.origin;
  if (origin !== undefined) {
    let host;
    try { host = new URL(origin).host; } catch { return false; }
    if (host.toLowerCase() !== String(req.headers.host || '').toLowerCase()) return false;
  }
  if (req.headers['sec-fetch-site'] === 'cross-site') return false;
  return true;
}

// constant-time string comparison (digests first, so lengths don't leak)
function safeEqual(a, b) {
  const h = (s) => crypto.createHash('sha256').update(String(s)).digest();
  return crypto.timingSafeEqual(h(a), h(b));
}

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' }[c]));

// ---------- static files ----------

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
  '.txt': 'text/plain; charset=utf-8',
};
const COMPRESSIBLE = new Set(['.html', '.js', '.css', '.svg', '.webmanifest', '.txt']);

// Serves named files from one directory. Names come from a fixed table in server.js, never from the
// request; each file is re-read only when its mtime or size changes.
class StaticFiles {
  constructor(dir) { this.dir = dir; this.cache = new Map(); }

  load(name) {
    if (name !== path.basename(name)) return null;
    const file = path.join(this.dir, name);
    let st;
    try { st = fs.statSync(file); } catch { return null; }
    if (!st.isFile()) return null;
    const hit = this.cache.get(name);
    if (hit && hit.mtime === st.mtimeMs && hit.size === st.size) return hit;
    let body;
    try { body = fs.readFileSync(file); } catch { return null; }
    const ext = path.extname(name).toLowerCase();
    const entry = {
      mtime: st.mtimeMs, size: st.size, body, ext,
      type: TYPES[ext] || 'application/octet-stream',
      etag: `"${crypto.createHash('sha1').update(body).digest('hex').slice(0, 20)}"`,
      gzip: COMPRESSIBLE.has(ext) && body.length > 1024 ? zlib.gzipSync(body) : null,
    };
    this.cache.set(name, entry);
    return entry;
  }

  // false if the file doesn't exist (the caller decides what to say)
  serve(req, res, name, cacheControl) {
    const f = this.load(name);
    if (!f) return false;
    const headers = { 'Content-Type': f.type, 'Cache-Control': cacheControl, ETag: f.etag, Vary: 'Accept-Encoding' };
    if (cacheControl !== 'no-store') {
      const inm = String(req.headers['if-none-match'] || '');
      if (inm && inm.split(',').some((t) => t.trim().replace(/^W\//, '') === f.etag)) { res.writeHead(304, headers); res.end(); return true; }
    }
    let body = f.body;
    if (f.gzip && /\bgzip\b/.test(String(req.headers['accept-encoding'] || ''))) { body = f.gzip; headers['Content-Encoding'] = 'gzip'; }
    headers['Content-Length'] = body.length;
    res.writeHead(200, headers);
    res.end(body);
    return true;
  }
}

module.exports = {
  HttpError, CSP, securityHeaders, rawSecurityHeaders, sendJson, sendText, redirect, readBody, parseJsonObject,
  parseCookies, cookieString, clientIp, ipKey, isHttps, hostOf, csrfOk, safeEqual, escapeHtml, StaticFiles,
};
