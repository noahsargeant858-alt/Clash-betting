'use strict';

// The betting page works out everyone's coins from documents that each browser writes for itself: fixtures,
// locks, logged results, confirmations and bet lists. The platform rules only say WHO may write a document;
// this says what a genuine one looks like, so a friend can't forge history:
//   - times written into events must be about now (no backdating a lock to sneak into a closed betting window)
//   - a fixture or lock can't be rewritten or deleted after the fact
//   - a lock can only freeze bets that really exist in their owners' bet lists (no inventing bets for someone else)
//   - a bet list only ever grows: placed bets can't be edited or taken back, and each new bet is dated now (the admin can fix mistakes)

const IMMUTABLE = new Set(['fixture', 'lock', 'seal']);
const NOT_DELETABLE = new Set(['fixture', 'lock', 'seal', 'confirm']);
const MAX_LOCK_BETS = 400;

const canon = (t) => typeof t === 'string' && t.length === 24 && Number.isFinite(Date.parse(t)) && new Date(Date.parse(t)).toISOString() === t;
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function same(x, y) {
  if (x === y) return true;
  if (Array.isArray(x)) return Array.isArray(y) && x.length === y.length && x.every((v, i) => same(v, y[i]));
  if (isObj(x)) {
    if (!isObj(y)) return false;
    const kx = Object.keys(x), ky = Object.keys(y);
    return kx.length === ky.length && kx.every((k) => Object.prototype.hasOwnProperty.call(y, k) && same(x[k], y[k]));
  }
  return false;
}

// Returns a plain-English reason to refuse the write, or null when it is fine.
//   op, segs   what is being done, and to which document (path split on '/')
//   cur, next  the document's data now (null if new) and as it would become (null for a delete)
//   now        the server's clock (ms); skewMs how far a device's clock may be out
//   getDoc     path -> {data} | undefined, for looking at other documents
function check({ op, segs, cur, next, now, skewMs, getDoc, isAdmin }) {
  const inTime = (v) => canon(v) && Math.abs(Date.parse(v) - now) <= skewMs;
  const CLOCK = 'Your phone\'s clock looks out by more than a couple of minutes. Fix the time on your device and try again.';

  // ----- events in a person's own folder
  if (segs[0] === 'acts' && segs.length === 4 && segs[2] === 'items') {
    if (op === 'delete') {
      return !isAdmin && cur && NOT_DELETABLE.has(cur.type) ? 'Fixtures, locks and confirmations can\'t be deleted.' : null;
    }
    const type = next.type;
    if (IMMUTABLE.has(type) && cur) return same(cur, next) ? null : `A ${type} can't be changed once it's made.`;
    if (cur && IMMUTABLE.has(cur.type)) return `A ${cur.type} can't be turned into something else.`;
    if (type === 'fixture' || type === 'lock' || type === 'seal' || type === 'confirm') {
      if (!inTime(next.at)) return CLOCK;
    }
    if (type === 'match') {
      const was = cur && cur.loggedAt;
      if (!(cur && next.loggedAt === was) && !inTime(next.loggedAt)) return CLOCK;
    }
    if (type === 'lock') {
      const bets = next.bets;
      if (typeof next.fx !== 'string') return 'A lock needs to say which fixture it is for.';
      if (!Array.isArray(bets) || bets.length > MAX_LOCK_BETS) return 'A lock needs its list of bets.';
      for (const e of bets) {
        if (!isObj(e) || typeof e.uid !== 'string' || typeof e.id !== 'string') return 'A lock holds a bet it can\'t vouch for.';
        if (e.fx !== next.fx) return 'A lock can only hold bets on its own fixture.';
        const doc = getDoc(`bets/${e.uid}`);
        const list = doc && Array.isArray(doc.data.list) ? doc.data.list : [];
        const own = list.find((x) => isObj(x) && x.id === e.id && x.fx === e.fx);
        const { uid: _uid, ...rest } = e;
        if (!own || !same(own, rest)) return 'A lock can only hold bets that really are in their owners\' bet lists.';
      }
    }
    return null;
  }

  // ----- a person's bets: only ever added to, each new one dated now
  if (segs[0] === 'bets' && segs.length === 2) {
    if (op === 'delete') return isAdmin ? null : 'Bets can\'t be deleted.';
    if (!Array.isArray(next.list)) return 'A bet list needs its list of bets.';
    if (isAdmin) return null; // the owner can void or fix a bet; frozen locks keep what was already agreed
    const was = new Map();
    for (const b of cur && Array.isArray(cur.list) ? cur.list : []) if (isObj(b) && typeof b.id === 'string') was.set(b.id, b);
    const seen = new Set();
    for (const b of next.list) {
      if (!isObj(b) || typeof b.id !== 'string') return 'That isn\'t a valid bet.';
      if (seen.has(b.id)) return 'Two of your bets have the same id.';
      seen.add(b.id);
      const old = was.get(b.id);
      if (old) { if (!same(old, b)) return 'A bet that has been placed can\'t be changed.'; }
      else if (!inTime(b.placedAt)) return CLOCK;
    }
    for (const id of was.keys()) if (!seen.has(id)) return 'A bet that has been placed can\'t be taken back.';
    return null;
  }
  return null;
}

module.exports = { check, same, canon };
