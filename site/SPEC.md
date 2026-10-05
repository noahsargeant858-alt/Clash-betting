# ClashBets website (own hosting, own sign-in)

The ClashBets page (`artifact/clashbets.html`, ~3000 lines, one file) was built for claude.ai's artifact
platform, which only lets the owner and email-invited editors save data. Friends could only look. This
directory hosts the same page on a normal website: friends create an account (or open a personal invite
link) and bet; the admin (the owner) approves, gifts coins, and so on.

**Principle: the page's own logic (odds, integrity rules, settlement) does not change.** The page talks to a
tiny `window.claude` API (`use('db')`, `use('user')`). We provide those two over HTTP, and enforce on the
server the same access rules the artifact platform enforced. Zero npm dependencies (Node >= 18, built-ins only).

```
site/
  server.js            entry point: HTTP server, routing, static files, background jobs
  lib/store.js         document store: docs, versions, change log, limits, persistence hooks
  lib/rules.js         who may read/write which path (pure functions, unit-tested)
  lib/auth.js          accounts, scrypt passwords, sessions, invites, rate limits
  lib/persist.js       file persistence (+ optional encrypted GitHub snapshot backend)
  lib/importer.js      pulls battles.json, runs scripts/daily-import.js against the store
  lib/http.js          small helpers: body parsing, cookies, security headers, static serving
  public/login.html    sign in / create account page
  public/shim.js       browser: window.claude = { use('db'|'user') } over the HTTP API, account button + admin panel
  build.js             builds public/app.html from ../artifact/clashbets.html
  test/*.test.js       node:test tests (server)
  DEPLOY.md, ../render.yaml
```

## Environment (all optional unless noted)

| var | default | meaning |
|---|---|---|
| `PORT` | 3000 | listen port |
| `DATA_DIR` | `./site-data` | where `db.json` and `auth.json` live (must persist between restarts) |
| `ADMIN_USERNAME` | `admin` | the owner's username (lowercase) |
| `ADMIN_PASSWORD` | none | if set, the admin account always has this password (change the variable to reset it). If unset and no admin exists yet, a random one is generated and printed once to stdout |
| `SIGNUP_CODE` | none | if set, creating an account needs this group code |
| `PUBLIC_URL` | derived from request Host | used to build invite links |
| `TRUST_PROXY` | `1` when `NODE_ENV=production` | read `X-Forwarded-For` / `X-Forwarded-Proto` |
| `COOKIE_SECURE` | auto (https) | force the Secure flag |
| `SESSION_DAYS` | 90 | session lifetime |
| `BATTLES_URL` | `https://raw.githubusercontent.com/noahsargeant858-alt/Clash-betting/battle-data/battles.json` | official battles feed |
| `IMPORT_INTERVAL_MIN` | 20 | how often to look for new battles (0 = off) |
| `SNAPSHOT_REPO`, `SNAPSHOT_BRANCH`, `SNAPSHOT_TOKEN`, `SNAPSHOT_KEY` | none | optional backup for hosts whose disk is wiped on restart: encrypted (AES-256-GCM with `SNAPSHOT_KEY`) copy of both data files, pushed to a branch via the GitHub contents API, restored at boot if `DATA_DIR` is empty |

## Data model

Two JSON files in `DATA_DIR`, each written atomically (temp file + rename), debounced ~1 s, flushed on SIGTERM.

### `db.json` — the document store (what the page reads and writes)
```
{ "seq": 1234, "docs": { "<doc path>": { "data": {...}, "version": 3, "updatedAt": "ISO" } } }
```
Doc paths are exactly the artifact's: `players/<id>`, `matches/<id>`, `links/<playerId>`, `claims/<uid>`,
`bets/<uid>`, `acts/<uid>/items/<id>`, `config/<settings|house|specials|importState>`, `data/users/<uid>/...`.
Path grammar: even number of `/`-separated segments for a document (odd for a collection); each segment
`[A-Za-z0-9_\-.~:@+]{1,200}`, never `.` or `..`; at most 16 segments and 1000 bytes. A doc body is a JSON
object <= 256 KiB, <= 32 levels deep. At most 25,000 docs. `seq` increments on every committed change; a change
log of the last 5,000 `{seq, path}` is kept in memory (not persisted).

### `auth.json` — accounts (never exposed through the db API)
```
users:    { "<uid>": { uid, username, display, admin, disabled, pass: "s1:<saltB64>:<hashB64>" | null, via: "signup"|"invite"|"admin", createdAt, lastSeenAt } }
sessions: { "<sha256(token) hex>": { uid, createdAt, lastUsedAt, expiresAt } }
invites:  { "<id>": { id, hash: "<sha256(token) hex>", playerId, createdAt, expiresAt, usedAt|null, usedBy|null } }
```
`uid` = `u_` + 22 chars of base64url (16 random bytes). `username` is lowercase `^[a-z0-9][a-z0-9_.-]{2,23}$`, unique.
`display` is 1-30 chars, trimmed, no control characters (the page HTML-escapes every name it shows).
Passwords: 8-200 chars, scrypt (N=2^15, r=8, p=1, 64-byte output, 16-byte random salt, `maxmem` raised to 64 MiB),
compared in constant time. Unknown username gets a dummy scrypt so timing doesn't reveal which names exist.
Sessions: random 32-byte token (base64url) in cookie `cb_session` (HttpOnly; SameSite=Lax; Path=/; Max-Age=SESSION_DAYS;
Secure when https); only its sha256 is stored. At most 20 sessions per user (oldest dropped). Changing or resetting a
password revokes all of that user's other sessions. A disabled account's sessions stop working at once.

## Access rules (`lib/rules.js`) — identical in effect to the artifact's db rules

`user` is `{uid, admin}` (admin = the owner). The owner meets every rule except another person's private subtree.

| path | read | write |
|---|---|---|
| `data/users/<uid>/...` | that uid only (nobody else, admin included) | that uid only |
| `players/..`, `config/..`, `links/..`, `matches/..` | any signed-in user | admin only |
| `claims/<uid>` (doc) | any signed-in user | that uid, or admin |
| `bets/<uid>` (doc) | any signed-in user | that uid, or admin |
| `acts/<uid>/...` | any signed-in user | that uid, or admin |
| anything else | any signed-in user | admin only |

Signed-out requests get 401 from every `/api/db/*` and `/api/changes` and `/api/profiles`.
A user may only write a doc whose first (or, for `acts`, second) segment equals their own uid; this is checked on
the parsed path segments, never on substrings. `set` replaces; `update` merges top-level fields (nested objects merge,
arrays replace) and requires the doc to exist; `delete` is idempotent.

## HTTP API

Everything is JSON. Every POST/PUT/DELETE must carry `Content-Type: application/json` and header `X-CB: 1`, and if an
`Origin` header is present its host must equal the request `Host` (else 403) — together with SameSite=Lax this blocks
cross-site requests. Request bodies are capped at 300 KB (413). Errors: `{ "error": "plain-English message" }` with 400/401/403/404/409/413/429/507/500.

### Pages
* `GET /` — signed in: `public/app.html` (`Cache-Control: no-store`); otherwise `302 /login`.
* `GET /login` — `public/login.html`. If already signed in, `302 /`.
* `GET /join/<token>` — server-rendered landing page for a personal invite: "You've been invited as **Jamie**" with a
  button. It must NOT consume the token (chat apps pre-fetch links). The button POSTs `/api/auth/redeem`.
  Invalid/used/expired token: a friendly page saying so (HTTP 410), revealing nothing else.
* `GET /shim.js`, `GET /healthz` (`ok`), other `public/` files by exact name only (no directory traversal; a fixed allow-list).

### Auth
* `GET  /api/auth/config` → `{ siteName: "ClashBets", signupCode: boolean }` (no auth).
* `POST /api/auth/signup` `{username, password, display?, code?}` → `{ok:true, me}` + cookie. `display` defaults to username.
  Errors: taken username (409), weak password/invalid fields (400), wrong group code (403), rate limit (429: 10 signups/hour/IP).
* `POST /api/auth/login` `{username, password}` → `{ok:true, me}` + cookie. Wrong credentials: 401 "Wrong username or password"
  (same message and timing for unknown user). Limits: 10 failures / 15 min per username and 30 / 15 min per IP → 429.
  A disabled account: 403 "This account is switched off. Ask the admin."
* `POST /api/auth/logout` → clears the cookie, deletes the session.
* `GET  /api/auth/me` → `{ uid, username, display, admin, hasPassword, playerId|null }` or 401. `playerId` = the player whose
  `links/<playerId>.uid` is this user.
* `POST /api/auth/password` `{current?, next, username?}` → sets/changes the password. `current` is required when the account
  already has a password. An invite account (no password yet) may also pass `username` to pick its username (must be free).
  Revokes the user's other sessions, keeps this one. → `{ok:true, me}`.
* `POST /api/auth/redeem` `{token}` → creates the account for an invite (or, if the caller is already signed in, links their
  existing account), writes `links/<playerId>` `{uid, at, former}` (keep any existing `former` array), marks the invite used,
  sets the cookie. → `{ok:true, me, playerId}`. The invite must exist, be unused and unexpired, and its player must exist and not be
  currently linked to an enabled account (else 409 "That player already has an account. Ask the admin."). Username for a new
  invite account = slug of the player's name (`[a-z0-9]`, >= 3 chars, suffix `2`,`3`… if taken). Invite accounts have `pass: null`.
  A signed-in account that is already linked to a player gets 409 "You're already <name>".

### Admin (signed-in admin only, else 403)
* `GET    /api/admin/accounts` → `{accounts:[{uid, username, display, admin, disabled, hasPassword, via, createdAt, lastSeenAt, playerId|null}]}`
* `POST   /api/admin/accounts/<uid>/reset-password` → `{tempPassword}` (16 random chars from an unambiguous alphabet; shown once; revokes all that user's sessions)
* `POST   /api/admin/accounts/<uid>/disable` `{disabled:boolean}` (cannot disable yourself) → `{ok:true}`
* `POST   /api/admin/invites` `{playerId}` → `{id, token, url, expiresAt}` where `url` = `<PUBLIC_URL or Host-derived>/join/<token>`. 404 if the player doesn't exist. The token is only ever returned here.
* `GET    /api/admin/invites` → `{invites:[{id, playerId, createdAt, expiresAt, usedAt, usedBy}]}` (never tokens)
* `DELETE /api/admin/invites/<id>` → `{ok:true}`

### Database (signed in)
* `GET  /api/db/list?collection=<collection path>` → `{ docs:[{id, data, version}], seq }` — direct children of that collection that the caller may read, ordered by id.
* `GET  /api/db/doc?path=<doc path>` → `{ id, exists, data?, version?, seq }` (unreadable behaves exactly like missing).
* `POST /api/db/write` `{op:"set"|"update"|"delete", path, data?, ifVersion?}` → `{version, seq}` (`version` 0 for delete). 403 if the rules forbid it,
  400 for a bad path/body/`update` of a missing doc, 409 if `ifVersion` is given and doesn't match, 507 if over a limit. Writes are applied one at a time (single-threaded), each bumps the doc `version` and `seq`.
  Per-user write limit: 120/min (429).
* `GET  /api/changes?since=<seq>&wait=<seconds, max 25>` → long-poll. Returns at once if `seq > since`, else holds until a change the caller may read happens or `wait` elapses. →
  `{ seq, reset:false, changes:[{path, exists, data?, version}] }`. If `since` is older than the change log, returns `{seq, reset:true, changes:[]}` and the client re-lists. Max 4 concurrent long-polls per user (the oldest is answered empty).
* `POST /api/profiles` `{ids:[uid,...]}` (<= 100) → `{ profiles: { "<uid>": { name } } }` where `name` is the account's display name ("" if no such account).

## Browser shim (`public/shim.js`)

Runs before the page's own script. Defines `window.claude = { use(name) }` where `use('db')` and `use('user')` resolve (after
one `GET /api/auth/me`; a 401 redirects to `/login`), `use('sample')` and anything else resolve `null`.

`db`: `collection(path)` → `{ doc(id), onSnapshot(next, error), get() }`; `doc(path)` → `{ id, path, get, set, update, delete, onSnapshot, collection }`.
Snapshots look like the artifact platform's: collection `{docs:[{id, exists:true, data()}], size, empty}`; doc `{id, exists, data()}`.
`onSnapshot` fires soon after subscribing (initial fetch) and again on every change; a subscription to a collection never fires
for another collection. The shim keeps one local mirror of every subscribed collection/doc, one long-poll loop on `/api/changes`
(reconnect with backoff, `reset` → re-list everything), and applies the caller's own writes to the mirror immediately.
Errors reject with `{code, message}`: 403 → `invalid_argument`; 400 → `invalid_argument`; 429 → `resource_exhausted`; 507 → `quota_exceeded`; 401 → redirect to `/login`; network/5xx → `unavailable`.

`user`: `id()` → uid; `isOwner()` / `canEdit()` → admin; `can('data.write')` → true; `me()` → `{id, name, avatarUrl, color, email:null, isOwner, canEdit}`;
`name()`; `profiles(ids)` → `{ [id]: {id, name, avatarUrl, color, email:null, isMe, guest:false} }` via `/api/profiles` (cached, refreshed); `email()` → null.
(`avatarUrl`/`color`: generate an initials SVG data: URL and a hash colour locally.)

Account button: a small fixed "Account" pill bottom-left (clear of the page's mobile slip bar) opening a modal: signed-in name and
@username; change/set password (and, for an invite account, choose a username); Sign out. All text via `textContent`.

Admin panel: if an element `#siteAdmin` exists (the page puts one in the Admin tab) and the user is admin, the shim fills it
(and keeps it fresh when the tab is shown) with **Website accounts** (table from `/api/admin/accounts`: username, name, linked player, last seen, buttons Reset password / Switch off|on)
and **Invite links** (a player `<select>` filled from the page's players via `db.collection('players')`, a "Create invite link" button that shows the URL with Copy / Share buttons, and the open invites with Revoke).
Reset password shows the temporary password once in the panel.

## Login page (`public/login.html`)
Dark arena theme like the page (Lilita One + Barlow from Google Fonts, same colour tokens: `--bg:#0d1530; --panel:#152149; --gold:#f6c544` …),
mobile first, no horizontal scroll. Two tabs: **Sign in** and **Create account** (fields: username, display name, password, and "Group code" only if `signupCode`).
Plain-English errors, a disabled button while submitting, `autocomplete` attributes set properly (username / current-password / new-password) so password managers work.
Success → `location.replace(new URLSearchParams(location.search).get('next') if it starts with '/' and not '//', else '/')`.

## Importer (`lib/importer.js`)
Every `IMPORT_INTERVAL_MIN` minutes (and once ~10 s after boot): `GET BATTLES_URL` (send `If-None-Match` with the last ETag; 304 = nothing to do), then
build a work dir in the layout `scripts/daily-import.js` documents (`battles.json`, `squad.json` from the repo root, `window.json` {since: now-7d, now},
`db/players/*.json`, `db/matches/*.json` (docs dated within the window), `db/links/*.json`, `db/acts/<uid>/items/*.json` (type=="match" within the window),
`versions.json` ({"matches/<id>": version, "config/importState": version})), run `node scripts/daily-import.js <dir>` (timeout 60 s),
and apply the produced `batch-N.json` writes (set ops whose `file_path` JSON is the doc, with optional `if_version`) as system writes; a version mismatch skips that write and logs it.
The work dir is deleted afterwards. Exposes `runImport()` for tests and for `POST /api/admin/import-now` (admin only) → `{summary}`.
Log one line per run (new results count, CHECK/SKIPPED lines).

## First boot / seeding
If `db.json` doesn't exist and `site/seed/seed.json` does (`{docs:{path:{data}}}`), load it. Any string equal to the placeholder `__ADMIN_UID__`
inside seed doc data is replaced by the admin's uid, so `links/triqqi.uid` and `config/settings.adminUid` point at the real admin account.

## Security requirements (the review will check these)
* No eval/Function, no shell string building (use `execFile` with an argument array); no path built from user input touches the filesystem except fixed allow-listed static files.
* Prototype pollution: parse JSON then copy through objects with `Object.create(null)` or reject keys `__proto__`, `constructor`, `prototype` in doc bodies and request bodies.
* Responses: `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `X-Frame-Options: DENY`, `Cross-Origin-Opener-Policy: same-origin`, HSTS when https, and a CSP:
  `default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`.
  API responses `Cache-Control: no-store`.
* Never log passwords, tokens or cookies. Never return password hashes, session hashes or invite hashes from any endpoint.
* Constant-time comparisons for secrets; generic login errors; rate limits on login/signup/invite redeem (20/15 min/IP).
* A user can never read another user's `data/users/...`, write another user's `claims|bets|acts` doc, or write `players|links|matches|config` unless admin.
* Request timeouts: headers 15 s, body 15 s; long-poll max 25 s; a global cap of 200 concurrent connections.
