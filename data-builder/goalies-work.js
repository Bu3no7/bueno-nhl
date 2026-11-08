'use strict';
/* ============================================================================
GOALIE WORKLOAD BUILDER — last-5 starts per goalie for the goalie card.
----------------------------------------------------------------------------
For every goalie on the slate, emits data/goalies-<date>.json:
  { date, builtAt, goalies: { "<pid>": { starts: [start, ...] } } }
  starts are oldest -> newest, at most 5, starts only (gamesStarted === 1):
  start = { d, opp, hr, sa, ga, dec, sv }
    d = gameDate 'YYYY-MM-DD', opp = opponentAbbrev, hr = 'H' | 'R',
    sa = shotsAgainst, ga = goalsAgainst, dec = decision ('W'|'L'|'O'),
    sv = savePctg rounded to 3 decimals.

Source per goalie (one call each):
  GET https://api-web.nhle.com/v1/player/{id}/game-log/{season}/2
  (gameLog is most recent first; the season is derived from the slate date:
  the season starting in year Y covers Sep Y .. Jun Y+1.)

Best effort like the minutes/chemistry steps: per-goalie failures are
skipped, the module never throws, and a missing sidecar just hides the
card section on the site.
============================================================================ */
const fs = require('fs');
const path = require('path');
const E = require('../engine.js');

const API = 'https://api-web.nhle.com/v1';
const DATA_DIR = path.join(__dirname, '..', 'data');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* Season string for a slate date: month >= 9 -> season starts this year. */
function seasonForDate(dateStr) {
  const [y, m] = String(dateStr || '').split('-').map(Number);
  const start = m >= 9 ? y : y - 1;
  return `${start}${start + 1}`;
}

/* One goalie's last-5 starts, oldest -> newest. Throws on fetch failure
   (the caller in buildGoalieWork skips that goalie). */
async function fetchStarts(pid, season, fetchLog) {
  const d = await fetchLog(pid, season);
  const log = (d && d.gameLog) || [];
  const starts = log
    .filter((g) => g && g.gamesStarted === 1)
    .slice(0, 5)
    .reverse()
    .map((g) => ({
      d: g.gameDate || '',
      opp: g.opponentAbbrev || '',
      hr: g.homeRoadFlag || '',
      sa: g.shotsAgainst || 0,
      ga: g.goalsAgainst || 0,
      dec: g.decision || '',
      sv: Math.round((g.savePctg || 0) * 1000) / 1000,
    }));
  return starts;
}

/* ctx: { dateStr, goalieIds (Set|Array), fetchRetry?, counted? }
   build.js passes its shared fetchRetry + counted so failures land in
   failCounts.goalieWork; standalone runs fall back to a local retry. */
async function buildGoalieWork(ctx) {
  const dateStr = (ctx && ctx.dateStr) || '';
  const ids = [...new Set([...((ctx && ctx.goalieIds) || [])].map(Number).filter(Boolean))];
  const season = seasonForDate(dateStr);
  const fetchRetry = ctx && ctx.fetchRetry;
  const counted = (ctx && ctx.counted) || ((p) => p);
  const fetchLog = async (pid) => {
    const url = `${API}/player/${pid}/game-log/${season}/2`;
    if (fetchRetry) return counted(fetchRetry(url, 'goalieWork'));
    let lastErr = null;
    for (let n = 0; n < 3; n++) {
      try { return await E.fetchJSON(url); }
      catch (e) { lastErr = e; if (n < 2) await sleep(400 * (n + 1)); }
    }
    throw lastErr;
  };
  const goalies = {};
  await E.limitedMap(ids, 4, async (pid) => {
    try {
      const starts = await fetchStarts(pid, season, fetchLog);
      if (starts.length) goalies[String(pid)] = { starts };
    } catch (e) { /* skip goalie — his card just hides the section */ }
  });
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(path.join(DATA_DIR, `goalies-${dateStr}.json`),
    JSON.stringify({ date: dateStr, builtAt: new Date().toISOString(), goalies }));
  return { goalies: Object.keys(goalies).length, wanted: ids.length };
}

/* CLI: node data-builder/goalies-work.js --date=YYYY-MM-DD
   The id list comes from that date's bundle: every pbp roster spot with
   positionCode 'G', plus the pbp starters (tonight's + zone pbps). */
async function cliMain() {
  const argv = Object.fromEntries(
    process.argv.slice(2).map((a) => {
      const m = a.match(/^--([^=]+)(?:=(.*))?$/);
      return m ? [m[1], m[2] === undefined ? true : m[2]] : ['_', a];
    })
  );
  const dateStr = argv.date || new Intl.DateTimeFormat('en-CA',
    { timeZone: 'America/Phoenix', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const bundle = JSON.parse(fs.readFileSync(path.join(DATA_DIR, `${dateStr}.json`), 'utf8'));
  const ids = new Set();
  for (const src of [bundle.pbps || {}, bundle.zonePbps || {}]) {
    for (const pbp of Object.values(src)) {
      if (!pbp) continue;
      for (const r of (pbp.rosterSpots || [])) {
        if (r.positionCode === 'G' && r.playerId) ids.add(r.playerId);
      }
      const st = pbp._starters || {};
      for (const s of [st.away, st.home]) if (s && s.id) ids.add(s.id);
    }
  }
  console.log(`[goalies-work] date=${dateStr} goalies=${ids.size}`);
  const res = await buildGoalieWork({ dateStr, goalieIds: ids });
  console.log(`[goalies-work] wrote data/goalies-${dateStr}.json: ${res.goalies}/${res.wanted} goalies with starts`);
}

if (require.main === module) {
  cliMain().catch((e) => { console.error('[goalies-work] fatal:', e); process.exit(1); });
}
module.exports = { buildGoalieWork, seasonForDate };
