# 👑 ClashBets — Triple Draft Sportsbook

A betting site for Clash Royale **triple draft friendlies** between mates. It works out odds from your
match history, lets everyone bet **play-money coins** on each other, and settles bets automatically
when the match is logged.

> ⚠️ Coins only. Taking real money for bets in the UK needs a Gambling Commission licence. Keep it to
> coins, bragging rights, and whoever's skint buying the next round.

## Quick start

```bash
cp .env.example .env      # then paste your Clash Royale API key in (optional, see below)
npm start                 # → http://localhost:3000
```

No `npm install` needed. It's plain Node (18+) with zero dependencies. Data lives in `data/db.json`.

Want to see it with fake data first?

```bash
npm run seed                              # writes data/demo.json with 5 players / 80 matches
DB_FILE=data/demo.json npm start
```

## The tabs

| Tab | What it does |
| --- | --- |
| **Odds Board** | Pick two players and get prices on every market. Tap a price to add it to the bet slip. |
| **Bets & Leaderboard** | Who's up and who's down, plus every bet and how it settled. |
| **Log Match** | Record a battle *and how it happened*: crowns, overtime, 1000+ damage before OT, first tower, both drafted decks, notes. Logging a match settles the open bets on that matchup. |
| **Players** | Add mates by tag (pulls trophies and battles from the Clash API) or by name only. |
| **Insights** | Per-player stats, a head-to-head grid, a **matchup explorer** (every scoreline and deck from X vs Y), and card stats (which drafted cards win or 3-crown most). |
| **Settings** | Bookie margin, starting coins, battlelog filters. |

## Markets

Match Result · Win Method (3/2/1-crown or tiebreaker) · Winning Margin (incl. **win by 1 tower**) ·
Correct Score · Goes to Overtime · **1000+ tower damage before OT** (each player) · First Tower ·
Total Crowns O/U 1.5/2.5/3.5 · Both Players Take a Tower · Win to Nil.

If a bet depends on something nobody recorded (for example, overtime was left as "unknown"), it's **voided**
and the stake is refunded.

## How the odds are set

Every probability is Bayesian-smoothed: it starts from a sensible prior (what usually happens in triple
draft) and moves toward the real data as matches pile up. With 3 games of data the odds barely move.
With 30, the data takes over.

- **Who wins:** each player's win rate vs everyone (log5), nudged slightly by trophies (deliberately weak,
  because in triple draft everyone drafts from the same random pool), then blended with their
  **head-to-head** record.
- **How they win:** the favourite's crown counts in past wins combined with how the opponent tends to lose.
  This gives a full correct-score grid, and win method, margin, totals, BTTS and win-to-nil are all derived from it.
- **Overtime, 1000+ damage, first tower:** each player's rate (and their opponent's "conceded" rate),
  smoothed toward the group average, then blended with head-to-head.
- **Margin:** prices include a house edge (default 5%) and are snapped to the standard UK fractional
  ladder (11/10, 6/4, 5/2…). Decimal odds are shown too.

All the tuning knobs are in `PRIORS` at the top of `lib/odds.js`.

## Clash Royale API key (for auto-importing battles)

1. Sign up at <https://developer.clashroyale.com> and create a key. Whitelist your public IP
   (google "what's my IP").
2. Put it in `.env` as `CR_API_TOKEN=...`.
3. If your IP keeps changing (home broadband, uni Wi-Fi), whitelist `45.79.218.79` instead and set
   `CR_API_BASE=https://proxy.royaleapi.dev/v1` to go through the RoyaleAPI proxy.

**Caveats:**
- The API only keeps each player's **last ~25 battles**, so hit "Sync" regularly (after each session).
  Imported battles are stored permanently, so your history grows over time.
- The API records crowns and decks but **not** overtime, tower damage, or first tower. Imported matches
  show a "needs details" tag. Click Edit and fill those in to sharpen those markets.
- Triple draft battles are detected by `gameMode.name` matching `draft` and battle type matching
  `friendly|clanmate`. If Supercell renames things, change the filters in Settings.

## Dev

```bash
npm test        # odds engine, settlement, API parsing, end-to-end server test
npm run dev     # auto-restart on changes
```
