'use strict';

// Dead simple JSON-file database. Fine for a group of mates; if this ever
// becomes the next Bet365, swap it for SQLite or Postgres.
const fs = require('fs');
const path = require('path');

const DEFAULTS = {
  players: [],
  matches: [],
  bets: [],
  settings: {
    margin: 5,                        // bookie's overround, in %
    startingCoins: 1000,
    modeRegex: 'draft',               // battlelog gameMode.name must match this...
    typeRegex: 'friendly|clanmate',   // ...and battle type must match this
  },
};

class DB {
  constructor(file) {
    this.file = file;
    this.data = structuredClone(DEFAULTS);
    if (fs.existsSync(file)) {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      this.data = { ...this.data, ...raw, settings: { ...DEFAULTS.settings, ...(raw.settings || {}) } };
    }
  }

  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    fs.renameSync(tmp, this.file);
  }
}

const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

module.exports = { DB, DEFAULTS, newId };
