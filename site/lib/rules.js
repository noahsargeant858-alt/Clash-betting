'use strict';

// Who may read or write which document. Pure functions over parsed path segments,
// so the rules can be tested without a server. `user` is { uid, admin }.
// The owner (admin) meets every rule except another person's private subtree.

const SEGMENT = /^[A-Za-z0-9_\-.~:@+]{1,200}$/;
const MAX_SEGMENTS = 16;
const MAX_PATH = 1000;

// "a/b/c" -> ['a', 'b', 'c'], or null if the path breaks the grammar.
// The grammar is ASCII only, so string length is also byte length.
function parsePath(str) {
  if (typeof str !== 'string' || str.length === 0 || str.length > MAX_PATH) return null;
  const segs = str.split('/');
  if (segs.length > MAX_SEGMENTS) return null;
  for (const s of segs) if (s === '.' || s === '..' || !SEGMENT.test(s)) return null;
  return segs;
}

// documents have an even number of segments, collections an odd number
const isDoc = (segs) => segs.length % 2 === 0;

// data/users/<uid>/... belongs to that uid alone. Returns the uid, '' for the
// private area without a uid (nobody may touch it), or null if the path is elsewhere.
function privateOwner(segs) {
  if (segs[0] === 'data' && segs[1] === 'users') return segs.length >= 3 ? segs[2] : '';
  return null;
}

function canRead(user, segs) {
  if (!user || !user.uid) return false;
  const owner = privateOwner(segs);
  if (owner !== null) return owner !== '' && owner === user.uid;
  return true;
}

// The rules compare parsed segments, never substrings of the path.
function canWrite(user, segs) {
  if (!user || !user.uid) return false;
  const owner = privateOwner(segs);
  if (owner !== null) return owner !== '' && owner === user.uid; // not even the admin
  if (user.admin === true) return true;
  switch (segs[0]) {
    case 'claims':
    case 'bets': return segs.length === 2 && segs[1] === user.uid;
    case 'acts': return segs.length >= 2 && segs[1] === user.uid;
    default: return false; // players, config, links, matches and anything else: admin only
  }
}

// Whose storage allowance a path counts against (null = shared, admin-managed data)
function ownerOf(segs) {
  if (segs[0] === 'data' && segs[1] === 'users') return segs.length >= 3 ? segs[2] : null;
  if (segs[0] === 'claims' || segs[0] === 'bets' || segs[0] === 'acts') return segs.length >= 2 ? segs[1] : null;
  return null;
}

module.exports = { SEGMENT, MAX_SEGMENTS, MAX_PATH, parsePath, isDoc, privateOwner, canRead, canWrite, ownerOf };
