'use strict';

const test = require('node:test');
const assert = require('node:assert');
const rules = require('../lib/rules');

const me = { uid: 'u_me', admin: false };
const other = { uid: 'u_other', admin: false };
const admin = { uid: 'u_admin', admin: true };
const p = (s) => rules.parsePath(s);

test('path grammar: segments, parity, limits', () => {
  assert.deepStrictEqual(p('players/abc'), ['players', 'abc']);
  assert.deepStrictEqual(p('a.b/c-d_e~f:g@h+i'), ['a.b', 'c-d_e~f:g@h+i']);
  assert.strictEqual(rules.isDoc(p('a/b')), true);
  assert.strictEqual(rules.isDoc(p('a/b/c')), false);
  for (const bad of ['', '/', 'a//b', '/a/b', 'a/b/', 'a/./b', 'a/../b', '..', '.', 'a/b c', 'a/b%2Fc', 'a/é', 'a/b\\c', 'a/b?c', 'a/b#c', 'a/b\0c']) {
    assert.strictEqual(p(bad), null, JSON.stringify(bad));
  }
  assert.ok(p(Array(16).fill('a').join('/')), '16 segments is fine');
  assert.strictEqual(p(Array(17).fill('a').join('/')), null, '17 segments is too many');
  assert.ok(p('a/' + 'x'.repeat(200)), '200 character segment is fine');
  assert.strictEqual(p('a/' + 'x'.repeat(201)), null, '201 character segment is too long');
  assert.strictEqual(p(Array(8).fill('x'.repeat(130)).join('/')), null, 'over 1000 bytes');
  for (const notString of [undefined, null, 5, {}, ['a/b']]) assert.strictEqual(p(notString), null);
  // dots are only forbidden as a whole segment
  assert.ok(p('a/...'));
  assert.ok(p('a/.hidden'));
});

test('access table, signed-in user', () => {
  const read = (path, u = me) => rules.canRead(u, p(path));
  const write = (path, u = me) => rules.canWrite(u, p(path));
  // private area
  assert.ok(read('data/users/u_me/notes/x') && write('data/users/u_me/notes/x'));
  assert.ok(!read('data/users/u_other/notes/x') && !write('data/users/u_other/notes/x'));
  assert.ok(read('data/users/u_me/notes') && write('data/users/u_me/notes/x'));
  assert.ok(!read('data/users') && !write('data/users'), 'the private area itself belongs to nobody');
  // shared, admin-written
  for (const c of ['players', 'config', 'links', 'matches']) {
    assert.ok(read(`${c}/x`), `${c} readable`);
    assert.ok(!write(`${c}/x`), `${c} not writable`);
  }
  // own docs
  assert.ok(read('claims/u_other') && write('claims/u_me') && !write('claims/u_other'));
  assert.ok(read('bets/u_other') && write('bets/u_me') && !write('bets/u_other'));
  assert.ok(read('acts/u_other/items/x') && write('acts/u_me/items/x') && !write('acts/u_other/items/x'));
  assert.ok(write('acts/u_me/items/x/deeper/y'), 'anything under your own acts folder');
  // anything else: read yes, write admin only
  assert.ok(read('weird/thing') && !write('weird/thing'));
  assert.ok(read('data/x') && !write('data/x'));
  // uid checks are on whole segments
  assert.ok(!write('claims/u_me2') && !write('claims/u_m') && !write('acts/u_me2/items/x'));
  assert.ok(!write('claims/u_me/sub/doc'), 'only claims/<uid> itself');
  assert.ok(!write('bets/x/u_me') && !write('acts/x/u_me/items/y'));
  assert.ok(!write('players/u_me'));
});

test('access table, admin: everything except another person\'s private subtree', () => {
  const read = (path) => rules.canRead(admin, p(path)), write = (path) => rules.canWrite(admin, p(path));
  for (const path of ['players/x', 'config/settings', 'links/x', 'matches/x', 'claims/u_other', 'bets/u_other', 'acts/u_other/items/x', 'weird/thing']) {
    assert.ok(read(path) && write(path), path);
  }
  assert.ok(!read('data/users/u_me/notes/x') && !write('data/users/u_me/notes/x'));
  assert.ok(!read('data/users/u_other') && !write('data/users/u_other/a/b'));
  assert.ok(read('data/users/u_admin/n/x') && write('data/users/u_admin/n/x'));
  assert.ok(!read('data/users') && !write('data/users'));
});

test('no user means no access; odd users get nothing', () => {
  const s = p('players/x');
  assert.strictEqual(rules.canRead(null, s), false);
  assert.strictEqual(rules.canWrite(undefined, s), false);
  assert.strictEqual(rules.canRead({ uid: '', admin: true }, s), false);
  assert.strictEqual(rules.canWrite({ uid: 'u_me', admin: 'yes' }, s), false, 'admin must be exactly true');
  assert.strictEqual(rules.canRead(other, p('data/users/u_me/a')), false);
});

test('ownerOf names whose allowance a path counts against', () => {
  assert.strictEqual(rules.ownerOf(p('acts/u_me/items/x')), 'u_me');
  assert.strictEqual(rules.ownerOf(p('claims/u_me')), 'u_me');
  assert.strictEqual(rules.ownerOf(p('bets/u_me')), 'u_me');
  assert.strictEqual(rules.ownerOf(p('data/users/u_me/n/x')), 'u_me');
  assert.strictEqual(rules.ownerOf(p('players/x')), null);
  assert.strictEqual(rules.ownerOf(p('config/settings')), null);
});
