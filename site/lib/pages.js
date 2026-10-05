'use strict';

// The few pages the server renders itself: the invite landing page, "that link is dead", and "not built yet".
// Everything user-supplied goes through escapeHtml. Inline script and style are allowed by the CSP.

const { escapeHtml } = require('./http');

const STYLE = `
:root{--bg:#0d1530;--panel:#152149;--line:#27366b;--gold:#f6c544;--ink:#eef2ff;--mute:#9fb0e0;--bad:#ff8a8a}
*{box-sizing:border-box}
html,body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.5 Barlow,system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
body{min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px 16px}
main{width:100%;max-width:420px;background:var(--panel);border:1px solid var(--line);border-radius:18px;padding:28px 22px;text-align:center;box-shadow:0 10px 40px #0008}
h1{font-family:'Lilita One',Barlow,system-ui,sans-serif;font-weight:400;font-size:30px;margin:0 0 4px;letter-spacing:.5px;color:var(--gold)}
h2{font-size:21px;font-weight:600;margin:14px 0 6px}
p{margin:8px 0;color:var(--mute)}
b{color:var(--ink)}
button,.btn{display:block;width:100%;margin-top:14px;padding:13px 16px;border:0;border-radius:12px;background:var(--gold);color:#251a00;font:700 17px Barlow,system-ui,sans-serif;cursor:pointer;text-decoration:none}
button.alt,.btn.alt{background:transparent;color:var(--ink);border:1px solid var(--line);font-weight:600;font-size:15px}
button[disabled]{opacity:.6;cursor:default}
a{color:var(--gold)}
.err{min-height:1.4em;color:var(--bad);margin-top:12px}
.small{font-size:14px}
`;

const FONTS = '<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>'
  + '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Barlow:wght@400;600;700&family=Lilita+One&display=swap">';

function layout(title, body, script) {
  return `<!doctype html>
<html lang="en-GB">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<meta name="color-scheme" content="dark">
<title>${escapeHtml(title)}</title>
${FONTS}
<style>${STYLE}</style>
</head>
<body>
<main>
<h1>ClashBets</h1>
${body}
</main>
${script ? `<script>${script}</script>` : ''}
</body>
</html>
`;
}

// The page behind a personal invite link. Opening it changes nothing (chat apps pre-fetch links);
// only the button does. `me` is the signed-in account, if any: { display, username }.
function joinPage({ name, token, me }) {
  const who = escapeHtml(name);
  const body = me
    ? `<h2>You've been invited as <b>${who}</b></h2>
<p>You're signed in as <b>${escapeHtml(me.display)}</b> (@${escapeHtml(me.username)}).</p>
<button id="go" data-token="${escapeHtml(token)}">Make my account ${who}</button>
<button id="fresh" class="alt" data-token="${escapeHtml(token)}">I'm someone else: sign out and join as ${who}</button>
<div class="err" id="err" role="alert"></div>`
    : `<h2>You've been invited as <b>${who}</b></h2>
<p>Tap the button to get your own ClashBets account. No password needed to start; you can set one later.</p>
<button id="go" data-token="${escapeHtml(token)}">Join as ${who}</button>
<p class="small">Already have an account? <a href="/login?next=${encodeURIComponent('/join/' + token)}">Sign in first</a>.</p>
<div class="err" id="err" role="alert"></div>`;
  const script = `
(function () {
  var err = document.getElementById('err');
  function post(url, body) {
    return fetch(url, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-CB': '1' }, body: JSON.stringify(body) })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { return { ok: r.ok, body: j }; }); });
  }
  function join(btn, signOutFirst) {
    var all = document.querySelectorAll('button');
    for (var i = 0; i < all.length; i++) all[i].disabled = true;
    err.textContent = '';
    var start = signOutFirst ? post('/api/auth/logout', {}) : Promise.resolve({ ok: true });
    start.then(function () { return post('/api/auth/redeem', { token: btn.getAttribute('data-token') }); })
      .then(function (r) {
        if (r.ok) { location.replace('/'); return; }
        err.textContent = (r.body && r.body.error) || 'Something went wrong. Try again.';
        for (var i = 0; i < all.length; i++) all[i].disabled = false;
      })
      .catch(function () {
        err.textContent = 'Could not reach the site. Check your connection and try again.';
        for (var i = 0; i < all.length; i++) all[i].disabled = false;
      });
  }
  var go = document.getElementById('go'), fresh = document.getElementById('fresh');
  go.addEventListener('click', function () { join(go, false); });
  if (fresh) fresh.addEventListener('click', function () { join(fresh, true); });
})();`;
  return layout(`You're invited to ClashBets`, body, script);
}

// Shown for an invalid, used or expired token. Says nothing about which, or about anyone.
function gonePage() {
  return layout('Invite link', `<h2>That invite link doesn't work any more</h2>
<p>It may have been used already or it has expired. Ask the admin for a fresh one.</p>
<a class="btn alt" href="/login">Go to sign in</a>`);
}

// A valid invite whose player already has an account
function takenPage() {
  return layout('Invite link', `<h2>That player already has an account</h2>
<p>Ask the admin if this should be you.</p>
<a class="btn alt" href="/login">Go to sign in</a>`);
}

function unavailablePage() {
  return layout('Back in a minute', `<h2>Back in a minute</h2>
<p>The site is being updated. Try again shortly.</p>`);
}

module.exports = { joinPage, gonePage, takenPage, unavailablePage };
