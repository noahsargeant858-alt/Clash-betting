'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { Store, StoreError, scan, merge } = require('../lib/store');

const fails = (fn, status, pattern) => assert.throws(fn, (e) => e instanceof StoreError && e.status === status && (!pattern || pattern.test(e.message)), `expected ${status}`);

test('set, update, delete: versions and seq', () => {
  const s = new Store();
  assert.deepStrictEqual(s.write('set', 'players/a', { name: 'Ann' }), { version: 1, seq: 1 });
  assert.deepStrictEqual(s.write('set', 'players/a', { name: 'Anne' }), { version: 2, seq: 2 });
  assert.deepStrictEqual(s.write('update', 'players/a', { coins: 5 }), { version: 3, seq: 3 });
  assert.deepStrictEqual(s.get('players/a').data, { name: 'Anne', coins: 5 });
  assert.deepStrictEqual(s.write('delete', 'players/a'), { version: 0, seq: 4 });
  assert.strictEqual(s.get('players/a'), undefined);
  // delete is idempotent and not a change
  assert.deepStrictEqual(s.write('delete', 'players/a'), { version: 0, seq: 4 });
  assert.strictEqual(s.seq, 4);
  assert.strictEqual(s.log.length, 4);
});

test('update merges top-level and nested objects, arrays and scalars replace, needs the doc to exist', () => {
  const s = new Store();
  fails(() => s.write('update', 'players/a', { x: 1 }), 400, /does not exist/);
  s.write('set', 'players/a', { a: 1, o: { x: 1, y: { deep: 1, keep: 2 } }, arr: [1, 2, 3], gone: 'yes' });
  s.write('update', 'players/a', { b: 2, o: { y: { deep: 9 }, z: 3 }, arr: [4], gone: null });
  assert.deepStrictEqual(s.get('players/a').data, { a: 1, o: { x: 1, y: { deep: 9, keep: 2 }, z: 3 }, arr: [4], gone: null, b: 2 });
  // an object patch over a scalar replaces it, and a scalar patch over an object replaces it
  s.write('update', 'players/a', { a: { now: 'object' }, o: 5 });
  assert.deepStrictEqual(s.get('players/a').data.a, { now: 'object' });
  assert.strictEqual(s.get('players/a').data.o, 5);
});

test('ifVersion: 0 means create-only, mismatches are 409 and change nothing', () => {
  const s = new Store();
  assert.strictEqual(s.write('set', 'a/b', { v: 1 }, { ifVersion: 0 }).version, 1);
  fails(() => s.write('set', 'a/b', { v: 2 }, { ifVersion: 0 }), 409);
  fails(() => s.write('set', 'a/b', { v: 2 }, { ifVersion: 5 }), 409);
  fails(() => s.write('update', 'a/b', { v: 2 }, { ifVersion: 5 }), 409);
  fails(() => s.write('delete', 'a/b', undefined, { ifVersion: 5 }), 409);
  fails(() => s.write('set', 'a/new', { v: 1 }, { ifVersion: 3 }), 409);
  assert.deepStrictEqual(s.get('a/b').data, { v: 1 });
  assert.strictEqual(s.write('set', 'a/b', { v: 2 }, { ifVersion: 1 }).version, 2);
  assert.strictEqual(s.write('delete', 'a/b', undefined, { ifVersion: 2 }).version, 0);
  for (const bad of [-1, 1.5, '1', true]) fails(() => s.write('set', 'a/c', {}, { ifVersion: bad }), 400);
  assert.strictEqual(s.seq, 3);
});

test('bad paths, bad bodies, bad ops', () => {
  const s = new Store();
  for (const bad of ['', 'players', 'a/b/c', 'a/../b', 'a/b/..', 'a//b', '/a/b']) fails(() => s.write('set', bad, {}), 400);
  for (const data of [undefined, null, 5, 'x', [1], true]) fails(() => s.write('set', 'a/b', data), 400);
  fails(() => s.write('upsert', 'a/b', {}), 400);
  assert.strictEqual(s.seq, 0);
});

test('prototype-pollution keys are refused at any depth, and merge never writes them', () => {
  const s = new Store();
  for (const key of ['__proto__', 'constructor', 'prototype']) {
    fails(() => s.write('set', 'a/b', JSON.parse(`{"${key}":{"x":1}}`)), 400);
    fails(() => s.write('set', 'a/b', JSON.parse(`{"ok":{"deeper":[{"${key}":1}]}}`)), 400);
  }
  assert.strictEqual(({}).x, undefined);
  s.write('set', 'a/b', { ok: 1 });
  // if a polluted doc got on disk anyway, merge drops the key instead of copying it
  const merged = merge(JSON.parse('{"__proto__":{"polluted":true},"a":1}'), JSON.parse('{"b":{"__proto__":{"p":1}}}'));
  assert.strictEqual(({}).polluted, undefined);
  assert.strictEqual(({}).p, undefined);
  assert.deepStrictEqual(Object.keys(merged).sort(), ['a', 'b']);
  assert.strictEqual(scan({ a: [{ b: { constructor: 1 } }] }, 32), 'key');
});

test('limits: depth, size, document count, total bytes', () => {
  const s = new Store({ maxDocs: 3 });
  let deep = { v: 1 };
  for (let i = 0; i < 31; i++) deep = { n: deep }; // 32 levels
  assert.ok(s.write('set', 'a/ok', deep));
  fails(() => s.write('set', 'a/deep', { n: deep }), 507, /deeply/);
  const big = { s: 'x'.repeat(256 * 1024) };
  fails(() => s.write('set', 'a/big', big), 507, /too big/);
  assert.ok(s.write('set', 'a/fits', { s: 'x'.repeat(256 * 1024 - 20) }));
  s.write('set', 'a/three', { v: 1 });
  fails(() => s.write('set', 'a/four', { v: 1 }), 507, /full/);
  assert.ok(s.write('set', 'a/three', { v: 2 }), 'replacing an existing doc is fine when full');
  s.write('delete', 'a/three');
  assert.ok(s.write('set', 'a/four', { v: 1 }));
  const small = new Store({ maxTotalBytes: 1000 });
  small.write('set', 'a/x', { s: 'x'.repeat(500) });
  fails(() => small.write('set', 'a/y', { s: 'y'.repeat(600) }), 507, /space/);
  assert.ok(small.write('set', 'a/x', { s: 'z'.repeat(600) }), 'a rewrite only counts the difference');
});

test('per-account allowance applies to ordinary writers, not to the owner or the importer', () => {
  const s = new Store({ ownerDocs: 3, ownerBytes: 400 });
  for (let i = 0; i < 3; i++) s.write('set', `acts/u_a/items/${i}`, { i }, { quota: true });
  fails(() => s.write('set', 'acts/u_a/items/3', { i: 3 }, { quota: true }), 507, /used up/);
  assert.ok(s.write('set', 'acts/u_b/items/0', { i: 0 }, { quota: true }), 'another account has its own allowance');
  assert.ok(s.write('set', 'acts/u_a/items/3', { i: 3 }), 'the owner is not limited');
  s.write('delete', 'acts/u_a/items/0', undefined, { quota: true });
  s.write('delete', 'acts/u_a/items/1', undefined, { quota: true });
  assert.ok(s.write('set', 'acts/u_a/items/9', { i: 9 }, { quota: true }), 'deleting frees allowance');
  const t = new Store({ ownerDocs: 100, ownerBytes: 300 });
  t.write('set', 'bets/u_a', { s: 'x'.repeat(200) }, { quota: true });
  fails(() => t.write('set', 'acts/u_a/items/x', { s: 'y'.repeat(200) }, { quota: true }), 507);
  assert.ok(t.write('set', 'bets/u_a', { s: 'z'.repeat(250) }, { quota: true }), 'rewriting counts the difference only');
});

test('list: direct children only, ordered by id', () => {
  const s = new Store();
  for (const id of ['b', 'a', 'c', 'B', '10', '9']) s.write('set', `players/${id}`, { id });
  s.write('set', 'players/a/notes/n1', { deep: true });
  s.write('set', 'matches/m1', { m: 1 });
  s.write('set', 'acts/u_x/items/i1', { t: 1 });
  s.write('set', 'acts/u_x/items/i2', { t: 2 });
  assert.deepStrictEqual(s.list('players').map((d) => d.id), ['10', '9', 'B', 'a', 'b', 'c']);
  assert.deepStrictEqual(s.list('players/a/notes').map((d) => d.id), ['n1']);
  assert.deepStrictEqual(s.list('acts/u_x/items').map((d) => d.id), ['i1', 'i2']);
  assert.deepStrictEqual(s.list('acts'), [], 'acts has no direct document children');
  assert.deepStrictEqual(s.list('nothing'), []);
  s.write('delete', 'players/b');
  assert.ok(!s.list('players').some((d) => d.id === 'b'));
  s.write('delete', 'acts/u_x/items/i1'); s.write('delete', 'acts/u_x/items/i2');
  assert.deepStrictEqual(s.list('acts/u_x/items'), []);
});

test('change log: dedupe, order, reset when too old or from the future', () => {
  const s = new Store({ maxLog: 5 });
  assert.deepStrictEqual(s.changesSince(0), { reset: false, paths: [] });
  for (let i = 1; i <= 3; i++) s.write('set', `a/d${i}`, { i });
  s.write('set', 'a/d1', { i: 'again' });
  assert.deepStrictEqual(s.changesSince(0), { reset: false, paths: ['a/d2', 'a/d3', 'a/d1'] });
  assert.deepStrictEqual(s.changesSince(3), { reset: false, paths: ['a/d1'] });
  assert.deepStrictEqual(s.changesSince(4), { reset: false, paths: [] });
  assert.strictEqual(s.changesSince(5).reset, true, 'from the future');
  for (let i = 4; i <= 8; i++) s.write('set', `a/d${i}`, { i });
  assert.strictEqual(s.seq, 9);
  assert.strictEqual(s.log.length, 5);
  assert.strictEqual(s.changesSince(0).reset, true, 'older than the log');
  assert.strictEqual(s.changesSince(3).reset, true);
  assert.strictEqual(s.changesSince(4).reset, false, 'the log covers everything after seq 4');
  assert.strictEqual(s.changesSince(4).paths.length, 5);
  // a delete is a change too
  s.write('delete', 'a/d8');
  assert.strictEqual(s.changesSince(9).paths[0], 'a/d8');
});

test('listeners hear every commit; a throwing listener does not break the rest', () => {
  const s = new Store();
  const heard = [];
  s.subscribe(() => { throw new Error('boom'); });
  const off = s.subscribe((seq, path) => heard.push([seq, path]));
  s.write('set', 'a/b', {});
  s.write('delete', 'a/b');
  s.write('delete', 'a/b'); // not a change
  off();
  s.write('set', 'a/c', {});
  assert.deepStrictEqual(heard, [[1, 'a/b'], [2, 'a/b']]);
});

test('serialize and load round trip; damaged documents are skipped; the log starts empty', () => {
  const s = new Store();
  s.write('set', 'players/a', { name: 'Ann' });
  s.write('set', 'players/a', { name: 'Anne' });
  s.write('set', 'acts/u_x/items/i', { t: 1 });
  const text = s.serialize();
  const t = new Store();
  assert.strictEqual(t.load(JSON.parse(text)), 0);
  assert.strictEqual(t.seq, 3);
  assert.strictEqual(t.get('players/a').version, 2);
  assert.deepStrictEqual(t.list('acts/u_x/items').map((d) => d.id), ['i']);
  assert.strictEqual(t.log.length, 0);
  assert.strictEqual(t.changesSince(2).reset, true, 'changes from before the restart are not in the log');
  assert.strictEqual(t.changesSince(3).reset, false);
  assert.strictEqual(t.serialize(), text);
  const damaged = t.load.call(new Store(), JSON.parse('{"seq":5,"docs":{"a/b":{"data":{"x":1},"version":1},"a/../b":{"data":{},"version":1},"a/c":{"data":[1],"version":1},"a/d":{"data":{},"version":0},"a/e":{"data":{"__proto__":{"p":1}},"version":1},"odd":{"data":{},"version":1}}}'));
  assert.strictEqual(damaged, 5);
});
