# Putting ClashBets on the internet (Render)

ClashBets is a small Node server (no dependencies to install). Render runs it for you, gives it a web address,
and keeps its data on a disk that survives restarts.

## What it costs

About **$7 a month** (Render's "Starter" web service) plus about **$0.25 a month** for the 1 GB disk that holds the
accounts and bets. You pay Render directly. Cancel any time by deleting the service.

## Deploy (about five minutes)

1. Sign in to <https://dashboard.render.com> with GitHub and allow it to see the **Clash-betting** repository.
2. Click **+** → **Blueprint**, pick the repository and the branch `claude/clash-royale-betting-odds-tffx5v`, leave the path as `render.yaml`.
3. Render lists one service, `clashbets (Starter)`, and asks for two values. Type them **into Render's boxes, never into a chat**:
   * `ADMIN_PASSWORD`: the password for your admin account. Make it long.
   * `SIGNUP_CODE`: a word or short phrase friends type when they create an account. It keeps strangers who find the link from making accounts.
4. Click **Deploy Blueprint**. The first build takes a few minutes. When the service says **Live**, open its address (it looks like `https://clashbets.onrender.com`).
5. Sign in as **triqqi** with the admin password. The starter data (players, 110 results, settings) is already loaded and you are already linked to `triqqi`.

## Getting your friends in

Three ways, and you can mix them:

* **Personal link (easiest for them):** Admin tab → **Invite links** → pick the player → **Create invite link**. Send that link to that friend, privately.
  They tap it, tap **Join as …**, and they are in as that player with their coins. No sign-up, no password. A link works once.
  They can set a username and password later from the **Account** button, so they can sign in on another phone.
* **One group link (easiest for you):** Admin tab → **Group link** → **Copy link**, and post it in the group chat. It opens
  **Create account** with the group code already filled in, so they only pick a username and password, then tap their name. You approve them
  under **Admin → Player link requests**. The code sits after the `#` in the link, which browsers never send to a server, so it stays out
  of logs and link previews. It stays in the address bar until they have made their account, so reloading or "Open in Safari" still works.
  Changing `SIGNUP_CODE` on Render makes old group links stop working, and the panel shows the new link within about 15 seconds.
* **They make their own account:** send them the site address and the group code. They create an account, then tap their name
  ("Ask to be jamie") or type their name if they are not on the list. You approve them under **Admin → Player link requests**.

## Coins

Admin tab → **Squad and accounts** → the **Give or take coins** box on the player's row (add a short reason; it shows in the house log).
Everyone starts with the starting coins in Settings (1,000).

## Looking after it

* **Locked-out friend:** Admin tab → **Website accounts** → **Reset password** (you get a one-time temporary password to send them), or just make them a new invite link for the same player after switching their old account off.
* **Switch someone off:** the same table has **Switch off** (signs them out everywhere and stops them signing in).
* **Change your own admin password:** change `ADMIN_PASSWORD` in Render (Environment tab) and let the service restart. The variable is applied every time the server starts.
* **Official Clash results** arrive on their own: the server looks at the battle feed (refreshed hourly by the GitHub Action) every 5 minutes and adds new games. A restart (any deploy) also checks straight away.
* **Results within a couple of minutes (live mode):** GitHub's hourly job often runs late. Give the site your Clash API key and it reads
  everyone's battle log itself every 2 minutes (GitHub's copy stays as a backup). In Render: **clashbets → Environment → Add Environment
  Variable**, key `CR_API_TOKEN`, value = your Clash API key (the same one saved as the GitHub secret; if you don't have it any more, make a
  new key at <https://developer.clashroyale.com> with allowed IP **45.79.218.79**, the RoyaleAPI proxy). Save; the site restarts. The Admin
  tab's **Official results** box then says "Live from Clash: on" with the time of the last read.
  The old claude.ai routine that did this is no longer needed.
* **Backups:** Render keeps daily snapshots of the disk on paid plans. For an extra copy off Render, see the optional encrypted backup below.
* **If friends often see "Too many attempts":** the server works out each visitor's address from Render's proxy by itself (`TRUST_PROXY` is `auto`), so this should not happen. If it does, tell me what the page said and roughly how many of you were on the same wifi.
* **Updates:** the blueprint has `autoDeploy: true`, so every push to the branch you picked redeploys the site (accounts and bets live on the disk and are kept). When this branch is merged, point the service at `main` under Settings → Build & Deploy → Branch.
* **Betting rules the server enforces:** a placed bet can't be edited or taken back (only you, the admin, can void one), fixtures and locks can't be rewritten after the fact, and times must be within a couple of minutes of the server's clock. A friend whose phone clock is badly out sees "Your phone's clock looks out" and needs to fix their device time.
* **Privacy:** the Clash tags of the squad are in `squad.json` in this GitHub repository, which is public. Make the repo private if that bothers anyone (Render can still read it through the GitHub connection).

## Settings (Render → Environment)

| variable | what it does |
|---|---|
| `ADMIN_USERNAME` | your username (set to `triqqi` by the blueprint) |
| `ADMIN_PASSWORD` | your password (always applied at start) |
| `SIGNUP_CODE` | group code for creating accounts; leave empty to allow anyone with the link (not recommended) |
| `PUBLIC_URL` | optional: the address to put in invite links, e.g. `https://clashbets.onrender.com` (otherwise taken from the request) |
| `IMPORT_INTERVAL_MIN` | how often to look for new battles (default 5; `0` turns it off) |
| `CR_API_TOKEN` | your Clash API key: turns on live mode (reads battle logs straight from Clash) |
| `LIVE_EVERY_SEC` | in live mode, how often to read the battle logs (default 120, at least 30) |
| `INVITE_DAYS` | how long a personal link stays valid (default 14) |
| `TRUST_PROXY` | `auto` on Render (default in production). Use a number only if you put your own proxy in front |

## Optional: a free plan with an encrypted backup instead of a disk

Render's free web service has no disk, so its files vanish whenever it restarts. The site can keep an **encrypted** copy of its data
on a branch of this GitHub repository and restore it on start. To use that instead of paying for a disk:

1. In `render.yaml` change `plan: starter` to `plan: free`, delete the `disk:` block, and change `DATA_DIR` to `/tmp/clashbets`.
2. Create a GitHub fine-grained token with **Contents: read and write** on this repository only, and make up a random key of at least 24 characters (shorter keys are refused).
3. In Render → Environment add `SNAPSHOT_REPO` = `noahsargeant858-alt/Clash-betting`, `SNAPSHOT_BRANCH` = `site-data`, `SNAPSHOT_TOKEN` = the token, `SNAPSHOT_KEY` = the key.
   (Keep the key safe: without it the backup cannot be read. The data on the branch is encrypted, so the public repo is fine.)

The trade-offs: the free service sleeps after 15 minutes without visitors (the first tap after that takes about a minute), and a crash can lose up to
10 minutes of bets. For a betting site people check at all hours, the $7 plan is the better deal.

## Running it on your own computer

```bash
ADMIN_PASSWORD='something long' SIGNUP_CODE=gold node site/server.js
# then open http://localhost:3000  (data goes in ./site-data, which git ignores)
```

After changing `artifact/clashbets.html`, run `node site/build.js` to regenerate `site/public/app.html`, which is what the website serves.
Tests: `npm test`. The older single-file server (no accounts) is still there as `npm run legacy`.
