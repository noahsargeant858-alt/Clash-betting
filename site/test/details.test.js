'use strict';

// One-tap answers about what the battle log can't show (did it go to overtime, who took the first tower).
// Bets can settle on two players agreeing, so an answer is dated now and can't be changed or deleted.

const test = require('node:test');
const assert = require('node:assert');
const { boot, request, ADMIN_PASSWORD } = require('./helper');

const J = { 'Content-Type': 'application/json', 'X-CB': '1' };
const post = (port, p, body, headers = {}) => request(port, { method: 'POST', path: p, headers: { ...J, ...headers }, body });
const iso = (ms) => new Date(ms === undefined ? Date.now() : ms).toISOString();
async function member(app, name) {
  const r = await post(app.port, '/api/auth/signup', { username: name, password: 'Friend-pass-123' });
  assert.strictEqual(r.status, 200, JSON.stringify(r.json));
  return { cookie: r.headers['set-cookie'][0].split(';')[0], uid: r.json.me.uid };
}
const write = (app, u, op, path, data) => post(app.port, '/api/db/write', { op, path, data }, { Cookie: u.cookie });
const answer = (extra = {}) => ({ type: 'detail', ref: 'm:cr_20261006T144501.000Z890UCYCGU80JRVYRQC', field: 'overtime', value: true, at: iso(), ...extra });

test('an answer is accepted once, dated now, and then can\'t be changed or deleted', async () => {
  const app = await boot();
  try {
    const u = await member(app, 'rishi');
    const path = `acts/${u.uid}/items/d_1`;
    assert.strictEqual((await write(app, u, 'set', path, answer())).status, 200);
    assert.strictEqual((await write(app, u, 'set', path, answer({ value: false }))).status, 409, 'changing your mind after the fact');
    assert.strictEqual((await write(app, u, 'delete', path)).status, 409, 'deleting it');
    assert.strictEqual((await write(app, u, 'set', `acts/${u.uid}/items/d_2`, answer({ at: iso(Date.now() - 3600e3) }))).status, 409, 'backdated');
    assert.strictEqual((await write(app, u, 'set', `acts/${u.uid}/items/d_3`, answer({ field: 'winner' }))).status, 409, 'a field the page never asks about');
    assert.strictEqual((await write(app, u, 'set', `acts/${u.uid}/items/d_4`, answer({ value: 'maybe' }))).status, 409, 'a value the page never offers');
    assert.strictEqual((await write(app, u, 'set', `acts/${u.uid}/items/d_5`, answer({ ref: 'x'.repeat(301) }))).status, 409, 'an absurd reference');
    for (const [field, value] of [['overtime', false], ['firstCrown', 'me'], ['firstCrown', 'opp'], ['overtime', 'unsure']]) {
      assert.strictEqual((await write(app, u, 'set', `acts/${u.uid}/items/d_${field}_${value}`, answer({ field, value }))).status, 200, `${field} ${value}`);
    }
    // the admin can still clear one up, as with fixtures and locks
    const a = await post(app.port, '/api/auth/login', { username: 'admin', password: ADMIN_PASSWORD });
    const admin = { cookie: a.headers['set-cookie'][0].split(';')[0] };
    assert.strictEqual((await write(app, admin, 'delete', path)).status, 200);
  } finally { await app.close(); }
});
