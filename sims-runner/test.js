'use strict';
/* Unit tests for sims-runner gate logic. Run: node sims-runner/test.js */
const assert = require('assert');
const E = require('../engine.js');
const R = require('./run.js');

let pass = 0, fail = 0;
const t = async (name, fn) => { try { await fn(); pass++; console.log('  ok:', name); } catch (e) { fail++; console.error('  FAIL:', name, '-', e.message); } };

// --- stub boxscore builders ---
const mkPlayer = (pid, pos) => ({ playerId: pid, name: { default: 'T. Test' }, position: pos });
const mkBox = (nf, nd, starter = true) => {
  const mk = (n, pos, base) => Array.from({ length: n }, (_, i) => mkPlayer(base + i, pos));
  const side = (b) => ({ forwards: mk(nf, 'C', b), defense: mk(nd, 'D', b + 100), goalies: [{ playerId: b + 200, name: { default: 'G. Oalie' }, starter }] });
  return { playerByGameStats: { awayTeam: side(1000), homeTeam: side(2000) } };
};

(async () => {
  // 1. locked -> gate passes
  await t('locked boxscore (12F/6D both teams) passes', () => {
    assert.strictEqual(R.lockStatus(mkBox(12, 6)).locked, true);
  });
  // 2. unlocked (empty, hours before puck) -> skipped
  await t('empty boxscore fails (not locked)', () => {
    assert.strictEqual(R.lockStatus(mkBox(0, 0)).locked, false);
  });
  await t('null boxscore fails', () => {
    assert.strictEqual(R.lockStatus(null).locked, false);
  });
  await t('one team short fails (12F/6D vs 9F/6D)', () => {
    const box = mkBox(12, 6);
    box.playerByGameStats.awayTeam.forwards = box.playerByGameStats.awayTeam.forwards.slice(0, 9);
    assert.strictEqual(R.lockStatus(box).locked, false);
  });
  await t('threshold edge: exactly 10F/5D passes', () => {
    assert.strictEqual(R.lockStatus(mkBox(10, 5)).locked, true);
  });
  await t('just under threshold fails: 10F/4D', () => {
    assert.strictEqual(R.lockStatus(mkBox(10, 4)).locked, false);
  });

  // 3. rosterHash: stable, changes on scratch
  await t('rosterHash stable for same roster', () => {
    assert.strictEqual(R.rosterHash(mkBox(12, 6)), R.rosterHash(mkBox(12, 6)));
  });
  await t('rosterHash changes on late scratch', () => {
    const a = mkBox(12, 6), b = mkBox(12, 6);
    b.playerByGameStats.homeTeam.forwards.pop();
    assert.notStrictEqual(R.rosterHash(a), R.rosterHash(b));
  });

  // 4. full buildAndSim with stubbed network: locked -> publishes with goalie status
  await t('buildAndSim publishes locked game, records goalie confirmation', async () => {
    const box = mkBox(12, 6, true);
    const landing = (sv) => ({
      firstName: { default: 'Test' }, lastName: { default: 'Player' },
      featuredStats: { regularSeason: { subSeason: { gamesPlayed: 8, goals: 3, shots: 20, assists: 3, points: 6, powerPlayGoals: 1, powerPlayPoints: 2, savePctg: sv } } },
      seasonTotals: [{ gameTypeId: 2, season: 20262027, avgToi: '17:30' }],
      last5Games: [],
    });
    const realFetch = E.fetchJSON;
    E.fetchJSON = async (url) => {
      if (url.includes('/landing')) return landing(0.905);
      if (url.includes('play-by-play')) return { homeTeam: { id: 1 }, plays: [], rosterSpots: [] };
      if (url.includes('/schedule/')) return { gameWeek: [] };
      throw new Error('unexpected ' + url);
    };
    try {
      const g = { id: 999, awayTeam: { abbrev: 'PIT' }, homeTeam: { abbrev: 'COL' }, startTimeUTC: '2026-10-16T00:00:00Z' };
      const res = await R.buildAndSim(g, box);
      assert.strictEqual(res.lineupLocked, true);
      assert.strictEqual(res.n, 20000);
      assert.ok(Math.abs(res.winA + res.winB + res.tie - 1) < 0.001, 'probs sum to 1');
      assert.strictEqual(res.goalieAway.confirmed, true);
      assert.strictEqual(res.goalieHome.confirmed, true);
      assert.ok(res.top.length === 5 && Array.isArray(res.top[0]));
      assert.ok(res.rosterHash);
    } finally { E.fetchJSON = realFetch; }
  });

  // 5. goalie NOT confirmed -> projected, does not block publish
  await t('unconfirmed goalie recorded as projected (no block)', async () => {
    const box = mkBox(12, 6, false); // starter flag false
    const realFetch = E.fetchJSON;
    E.fetchJSON = async (url) => {
      if (url.includes('/landing')) return { firstName: { default: 'A' }, lastName: { default: 'B' }, featuredStats: { regularSeason: { subSeason: { savePctg: 0.9 } } }, seasonTotals: [], last5Games: [] };
      if (url.includes('play-by-play')) return { homeTeam: { id: 1 }, plays: [], rosterSpots: [] };
      return { gameWeek: [] };
    };
    try {
      const g = { id: 999, awayTeam: { abbrev: 'PIT' }, homeTeam: { abbrev: 'COL' }, startTimeUTC: '2026-10-16T00:00:00Z' };
      const res = await R.buildAndSim(g, box);
      assert.strictEqual(res.lineupLocked, true, 'still publishes');
      assert.strictEqual(res.goalieAway.confirmed, false);
      assert.strictEqual(res.goalieHome.confirmed, false);
    } finally { E.fetchJSON = realFetch; }
  });

  console.log('done: ' + pass + ' passed, ' + fail + ' failed');
  if (fail) process.exit(1);
})().catch(e => { console.error(e); process.exit(1); });
