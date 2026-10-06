'use strict';

// Regression tests for the hosting-side fixes from the security review:
//  - which forwarded address to believe (X-Forwarded-For), by default on a host's proxy
//  - hand-logged results that get merged into official ones are re-built from known-good fields
//  - the health check says so when saving to disk is failing
//  - a production start refuses to run without a data folder or an admin password

const test = require('node:test');
const assert = require('node:assert');
const { clientIp, ipKey } = require('../lib/http');
const { cleanHandLog } = require('../lib/importer');
const { startServer, resolveConfig } = require('../server');
const { boot, request, tmp, makePublic } = require('./helper');

const req = (peer, xff) => ({ socket: { remoteAddress: peer }, headers: xff === undefined ? {} : { 'x-forwarded-for': xff } });

test('clientIp "auto": X-Forwarded-For counts only when the connection came from a proxy, and only the first outside address', () => {
  // straight from the internet: the header is a lie
  assert.strictEqual(clientIp(req('203.0.113.9', '1.2.3.4'), 'auto'), '203.0.113.9');
  // from the host's own load balancer (private address): the rightmost non-proxy address is who it saw
  assert.strictEqual(clientIp(req('10.1.2.3', '198.51.100.7'), 'auto'), '198.51.100.7');
  assert.strictEqual(clientIp(req('::ffff:10.1.2.3', '198.51.100.7'), 'auto'), '198.51.100.7');
  // a client who adds their own made-up addresses to the left gains nothing
  assert.strictEqual(clientIp(req('10.1.2.3', '9.9.9.9, 8.8.8.8, 198.51.100.7'), 'auto'), '198.51.100.7');
  // an extra proxy hop (Cloudflare, then the host's balancer) is skipped over
  assert.strictEqual(clientIp(req('10.1.2.3', '198.51.100.7, 172.70.1.1'), 'auto'), '198.51.100.7');
  // junk or missing header: fall back to the peer
  assert.strictEqual(clientIp(req('10.1.2.3', 'banana'), 'auto'), '10.1.2.3');
  assert.strictEqual(clientIp(req('10.1.2.3'), 'auto'), '10.1.2.3');
  assert.strictEqual(clientIp(req('10.1.2.3', '1.2.3.4, banana'), 'auto'), '10.1.2.3', 'garbage on the right is not trusted');
  // numbers still mean "the Nth address from the right", and 0 means ignore the header
  assert.strictEqual(clientIp(req('10.1.2.3', '1.1.1.1, 2.2.2.2'), 1), '2.2.2.2');
  assert.strictEqual(clientIp(req('10.1.2.3', '1.1.1.1, 2.2.2.2'), 2), '1.1.1.1');
  assert.strictEqual(clientIp(req('10.1.2.3', '1.1.1.1'), 0), '10.1.2.3');
  assert.strictEqual(ipKey('2001:db8:1:2:3:4:5:6'), ipKey('2001:db8:1:2:ffff::1'), 'a home IPv6 connection counts as one');
});

const good = () => {
  const at = new Date().toISOString();
  return { type: 'match', playerA: 'jamie', playerB: 'zac', crownsA: 2, crownsB: 1, winner: 'A', date: at, loggedAt: at };
};

test('a hand-logged result is rebuilt from known-good fields before it is shown to the importer script', () => {
  const ok = cleanHandLog({ ...good(), overtime: true, firstCrown: 'B', towersA: { left: 1, king: 0, right: 2 }, cardsA: ['Knight', 'Archers'], notes: 'gg', evil: '<script>', __proto__: { x: 1 } });
  assert.strictEqual(ok.winner, 'A');
  assert.strictEqual(ok.overtime, true);
  assert.deepStrictEqual(ok.towersA, { left: 1, king: 0, right: 2 });
  assert.deepStrictEqual(ok.cardsA, ['Knight', 'Archers']);
  assert.strictEqual(ok.evil, undefined, 'unknown fields are dropped');
  assert.strictEqual(ok.notes, 'gg');
  // anything malformed is dropped whole
  for (const bad of [null, 'x', [], {}, { ...good(), type: 'fixture' }, { ...good(), playerA: '' }, { ...good(), playerA: '../x' }, { ...good(), crownsA: 4 },
    { ...good(), crownsA: 1.5 }, { ...good(), winner: 'C' }, { ...good(), date: 'yesterday' }, { ...good(), date: '2026-01-01' }, { ...good(), loggedAt: undefined }]) {
    assert.strictEqual(cleanHandLog(bad), null, JSON.stringify(bad));
  }
  // control characters and enormous text can't ride along
  const noisy = cleanHandLog({ ...good(), notes: `a\u0000b\n${'z'.repeat(5000)}`, cardsA: Array(30).fill('x'.repeat(500)), fx: 'bad fx with spaces' });
  assert.ok(noisy.notes.length <= 400 && !/[\u0000-\u001f]/.test(noisy.notes));
  assert.strictEqual(noisy.cardsA.length, 8);
  assert.ok(noisy.cardsA.every((c) => c.length <= 40));
  assert.strictEqual(noisy.fx, null);
  assert.strictEqual(cleanHandLog({ ...good(), fx: 'u_a~f_1' }).fx, 'u_a~f_1');
});

test('/healthz turns to 503 when saving to disk has been failing, and recovers', async (t) => {
  const app = await boot();
  t.after(() => app.close());
  assert.strictEqual((await request(app.port, { path: '/healthz' })).status, 200);
  app.persist.failedSince = Date.now() - 60000;
  const down = await request(app.port, { path: '/healthz' });
  assert.strictEqual(down.status, 503);
  assert.match(down.text, /saving to disk is failing/);
  app.persist.failedSince = 0;
  assert.strictEqual((await request(app.port, { path: '/healthz' })).status, 200);
});

test('a production start refuses to run without a data folder, or without an admin password on a fresh install', async () => {
  const base = { port: 0, host: '127.0.0.1', publicDir: makePublic(), importIntervalMin: 0, scryptN: 1024, log: () => {} };
  await assert.rejects(startServer({ ...base, env: { NODE_ENV: 'production', ADMIN_PASSWORD: 'long enough admin password' } }), /DATA_DIR/);
  const dir = tmp('cb-prod-');
  await assert.rejects(startServer({ ...base, env: { NODE_ENV: 'production', DATA_DIR: dir } }), /ADMIN_PASSWORD/);
  // with both, it starts (and a missing group code is only a warning in the log)
  const logs = [];
  const app = await startServer({ ...base, log: (l) => logs.push(l), env: { NODE_ENV: 'production', DATA_DIR: dir, ADMIN_PASSWORD: 'long enough admin password' }, seedFile: `${dir}/none.json` });
  try {
    assert.ok(logs.some((l) => /SIGNUP_CODE is not set/.test(l)));
    assert.strictEqual(app.config.trustProxy, 'auto');
  } finally { await app.close(); }
  assert.strictEqual(resolveConfig({ env: { NODE_ENV: 'production', DATA_DIR: dir } }).dataDirGiven, true);
});

test('the sign-up limit default lets a friend group on one wifi address all make accounts', async (t) => {
  const app = await boot({ limits: {} });
  t.after(() => app.close());
  for (let i = 0; i < 12; i++) {
    const r = await request(app.port, { method: 'POST', path: '/api/auth/signup', headers: { 'Content-Type': 'application/json', 'X-CB': '1' }, body: { username: `mate${i}`, password: 'correct horse 1' } });
    assert.strictEqual(r.status, 200, `friend ${i}`);
  }
});
