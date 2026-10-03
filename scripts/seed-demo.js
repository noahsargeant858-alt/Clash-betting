'use strict';

// Fills data/demo.json with made-up players and matches so you can see the
// odds board working before you've logged anything real. Run the app with
// DB_FILE=data/demo.json npm start to use it; your real data/db.json is untouched.
const fs = require('fs');
const path = require('path');

const file = process.env.DB_FILE || path.join(__dirname, '..', 'data', 'demo.json');
if (fs.existsSync(file) && !process.argv.includes('--force')) {
  console.log(`${file} already exists — pass --force to overwrite.`);
  process.exit(0);
}

let seed = 42;
const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
const pick = (arr) => arr[Math.floor(rand() * arr.length)];
const POOL = ['Hog Rider', 'Golem', 'Fireball', 'Zap', 'The Log', 'Musketeer', 'Valkyrie', 'Mega Knight', 'P.E.K.K.A', 'Balloon',
  'Night Witch', 'Lightning', 'Inferno Tower', 'Miner', 'Goblin Barrel', 'X-Bow', 'Royal Giant', 'Electro Wizard', 'Baby Dragon', 'Skeleton Army',
  'Lava Hound', 'Sparky', 'Witch', 'Executioner', 'Tornado', 'Graveyard', 'Poison', 'Bandit', 'Ice Spirit', 'Cannon'];

const players = [
  { name: 'Noah', skill: 0.65 }, { name: 'Big Dave', skill: 0.5 }, { name: 'Jacko', skill: 0.55 },
  { name: 'Mo', skill: 0.4 }, { name: 'Elixir Leaker Ellis', skill: 0.3 },
].map((p, i) => ({ id: 'demo' + i, tag: null, name: p.name, coins: 1000, skill: p.skill, addedAt: new Date().toISOString() }));

const matches = [];
const now = Date.now();
for (let i = 0; i < 80; i++) {
  const a = pick(players); let b = pick(players);
  while (b === a) b = pick(players);
  const pA = a.skill / (a.skill + b.skill);
  const draw = rand() < 0.04;
  const aWins = rand() < pA;
  const r = rand();
  let w = r < 0.3 ? 1 : r < 0.62 ? 2 : 3;
  let l = w === 1 ? 0 : Math.floor(rand() * w * 0.7);
  let crownsA, crownsB, winner;
  if (draw) { crownsA = crownsB = rand() < 0.6 ? 0 : 1; winner = 'draw'; }
  else if (aWins) { crownsA = w; crownsB = l; winner = 'A'; } else { crownsA = l; crownsB = w; winner = 'B'; }
  const overtime = winner === 'draw' || (w < 3 && rand() < 0.45) || rand() < 0.1;
  const deck = () => { const d = new Set(); while (d.size < 8) d.add(pick(POOL)); return [...d]; };
  matches.push({
    id: 'dm' + i, date: new Date(now - (80 - i) * 3.6e6 * 7).toISOString(),
    playerA: a.id, playerB: b.id, nameA: a.name, nameB: b.name, crownsA, crownsB, winner, overtime,
    dmgA: crownsA > 0 || rand() < 0.5, dmgB: crownsB > 0 || rand() < 0.5,
    firstCrown: crownsA + crownsB === 0 ? 'none' : crownsB === 0 ? 'A' : crownsA === 0 ? 'B' : (rand() < 0.5 ? 'A' : 'B'),
    cardsA: deck(), cardsB: deck(), notes: '', source: 'manual', battleTime: null, createdAt: new Date().toISOString(),
  });
}
players.forEach((p) => delete p.skill);

fs.mkdirSync(path.dirname(file), { recursive: true });
fs.writeFileSync(file, JSON.stringify({ players, matches, bets: [] }, null, 2));
console.log(`Wrote ${players.length} players and ${matches.length} matches to ${file}`);
