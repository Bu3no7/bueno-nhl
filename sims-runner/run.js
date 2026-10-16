#!/usr/bin/env node
'use strict';
/* ============================================================================
NHL SIMS RUNNER — precomputes the canonical "best sim" per game, twice daily.
----------------------------------------------------------------------------
Concept: instead of every visitor running sims on demand, this script runs the
site's own correlated Monte Carlo engine (sims-runner reuses ../engine.js —
the exact same math as the browser) on the server, but ONLY for games whose
lineups are locked (dressed roster posted to the NHL boxscore). Results are
published to sims/<date>.json and pushed to GitHub; the site's Sims tab just
displays the published sim per game.

Lineup gate:  boxscore playerByGameStats shows >= 10 forwards AND >= 5
              defensemen for BOTH teams  =>  lineups locked.
Goalies:      a boxscore goalie flagged starter => confirmed; otherwise the
              projected starter (or TBD) — recorded, but NEVER blocks publish.
Re-runs:      a game is (re)simmed only when newly locked or when the dressed
              roster changed since the published sim (rosterHash).

Usage:
  node sims-runner/run.js [--date=YYYY-MM-DD] [--push] [--sims=N]
  --date  slate date (default: today in America/Phoenix)
  --push  push sims/<date>.json to GitHub (Bu3no7/bueno-nhl, branch main)
  --sims  Monte Carlo iterations per game (default 20000)
============================================================================ */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const E = require('../engine.js');

const API = 'https://api-web.nhle.com/v1';
const SITE_DIR = path.resolve(__dirname, '..');
const SIMS_DIR = path.join(SITE_DIR, 'sims');
const GITHUB_BIN = '/opt/hatch/bin/github';
const GH_OWNER = 'Bu3no7';
const GH_REPO = 'bueno-nhl';
const GH_BRANCH = 'main';

const LOCK_MIN_F = 10; // forwards needed per team to call lineups locked
const LOCK_MIN_D = 5;  // defensemen needed per team

const argv = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    return m ? [m[1], m[2] === undefined ? true : m[2]] : ['_', a];
  })
);
const phoenixToday = () =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Phoenix', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const dateStr = argv.date || phoenixToday();
const DO_PUSH = argv.push === true || argv.push === 'true';
const SIMS_N = parseInt(argv.sims, 10) || 20000;

const playerCache = new Map();
async function getPlayer(pid) {
  if (playerCache.has(pid)) return playerCache.get(pid);
  const d = await E.fetchJSON(`${API}/player/${pid}/landing`);
  playerCache.set(pid, d);
  return d;
}

function lockStatus(box) {
  // Lineups are "locked" when the NHL boxscore carries a dressed roster for
  // both teams. Empty boxscore (hours before puck) => not locked.
  if (!box || !box.playerByGameStats) return { locked: false };
  const count = (t) => ({ f: (t.forwards || []).length, d: (t.defense || []).length });
  const a = count(box.playerByGameStats.awayTeam || {});
  const h = count(box.playerByGameStats.homeTeam || {});
  const locked = a.f >= LOCK_MIN_F && a.d >= LOCK_MIN_D && h.f >= LOCK_MIN_F && h.d >= LOCK_MIN_D;
  return { locked, away: a, home: h };
}

function rosterHash(box) {
  // short hash of the dressed roster; a change (late scratch) triggers a re-sim
  const ids = [];
  for (const side of ['awayTeam', 'homeTeam']) {
    const t = (box.playerByGameStats || {})[side] || {};
    for (const p of [...(t.forwards || []), ...(t.defense || [])]) ids.push(p.playerId);
  }
  const s = ids.sort((x, y) => x - y).join(',');
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

function loadPublished() {
  const fp = path.join(SIMS_DIR, `${dateStr}.json`);
  if (fs.existsSync(fp)) {
    try { return { data: JSON.parse(fs.readFileSync(fp, 'utf8')), fp }; } catch (e) { /* fall through */ }
  }
  return { data: { date: dateStr, generatedAt: null, games: {} }, fp };
}

async function goalieInfo(box, side, oppAbbr) {
  // Confirmed starter from the boxscore, else projected (best available).
  const t = (box.playerByGameStats || {})[side] || {};
  const gl = (t.goalies || []).find((x) => x.starter) || (t.goalies || [])[0] || null;
  if (!gl) return { name: 'TBD', confirmed: false, sv: 0.900 };
  const confirmed = !!gl.starter;
  let name = gl.name && gl.name.default ? gl.name.default : 'TBD';
  let sv = 0.900;
  try {
    const land = await getPlayer(gl.playerId);
    const sub = (land.featuredStats && land.featuredStats.regularSeason && land.featuredStats.regularSeason.subSeason) || {};
    if (sub.savePctg) sv = sub.savePctg;
    const fn = land.firstName && land.firstName.default, ln = land.lastName && land.lastName.default;
    if (fn && ln) name = `${fn[0]}. ${ln}`;
  } catch (e) { /* keep defaults */ }
  return { name, confirmed, sv };
}

async function buildAndSim(g, box) {
  const away = g.awayTeam.abbrev, home = g.homeTeam.abbrev;
  const abbr = { awayTeam: away, homeTeam: home };

  // skater defs from the LOCKED boxscore roster (dressed, confirmed)
  const defs = [];
  for (const side of ['awayTeam', 'homeTeam']) {
    const t = (box.playerByGameStats || {})[side] || {};
    for (const p of [...(t.forwards || []), ...(t.defense || [])]) {
      defs.push({ pid: p.playerId, pos: p.position, team: abbr[side], gameId: g.id, lineup: 'confirmed' });
    }
  }

  // goalies: away skaters face the home goalie and vice versa
  const gAway = await goalieInfo(box, 'awayTeam', away);
  const gHome = await goalieInfo(box, 'homeTeam', home);
  const svFor = (team) => (team === away ? gHome.sv : gAway.sv);

  // season stats per skater (in-memory cache for the run)
  const landings = await E.limitedMap(defs, 6, async (d) => {
    try { return await getPlayer(d.pid); } catch (e) { return null; }
  });

  // zone data: recent finals per team + tonight's pbp (may be empty pre-game)
  const recentByTeam = await E.recentFinalsByTeam(API, dateStr, 1);
  const zoneIds = [...new Set([(recentByTeam[away] || []), (recentByTeam[home] || [])].flat())];
  const zonePbps = {};
  await E.limitedMap(zoneIds, 4, async (id) => {
    try { zonePbps[id] = await E.fetchJSON(`${API}/gamecenter/${id}/play-by-play`); } catch (e) { /* skip */ }
  });
  let tonightPbp = null;
  try { tonightPbp = await E.fetchJSON(`${API}/gamecenter/${g.id}/play-by-play`); } catch (e) { /* pre-game: none */ }

  // model rows (same math as the site)
  const skaters = defs.map((d, i) => {
    const land = landings[i];
    const s = land ? E.skaterSeason(land)
      : { gp: 0, goals: 0, shots: 0, assists: 0, points: 0, ppg: 0, ppp: 0, toiMin: 12, last5: [], sogpg: 0, apg: 0, ptspg: 0 };
    const shots = [];
    if (tonightPbp) shots.push(...E.shotsFromPbp(tonightPbp, d.pid));
    for (const zid of (recentByTeam[d.team] || [])) {
      if (zonePbps[zid]) shots.push(...E.shotsFromPbp(zonePbps[zid], d.pid));
    }
    const z = E.zoneShareFor(shots);
    const m = E.computeProb(s, z.share, svFor(d.team), d.pos);
    return { ...d, ...s, p: m.p, lam: m.lam };
  });

  // line estimates: forwards ranked by TOI (same as site — labeled est.)
  const FWD = new Set(['C', 'L', 'R']);
  const byTeam = {};
  for (const r of skaters) {
    if (!FWD.has(r.pos)) continue;
    (byTeam[r.team] = byTeam[r.team] || []).push(r);
  }
  for (const k of Object.keys(byTeam)) {
    byTeam[k].sort((a, b) => b.toiMin - a.toiMin);
    byTeam[k].forEach((r, i) => { r.line = 'L' + Math.min(4, Math.floor(i / 3) + 1); });
  }

  // the correlated Monte Carlo engine — identical to the browser sim
  const r = E.simOneGame(skaters, { id: g.id, away, home }, SIMS_N);

  return {
    id: g.id, away, home, startUTC: g.startTimeUTC,
    n: r.n,
    winA: +r.winA.toFixed(4), winB: +r.winB.toFixed(4), tie: +r.tie.toFixed(4),
    avgA: +r.avgA.toFixed(2), avgB: +r.avgB.toFixed(2),
    top: r.top.map(([sc, c]) => [sc, +(c / r.n).toFixed(4)]),
    simAt: new Date().toISOString(),
    lineupLocked: true,
    rosterHash: rosterHash(box),
    goalieAway: { name: gAway.name, confirmed: gAway.confirmed },
    goalieHome: { name: gHome.name, confirmed: gHome.confirmed },
  };
}

function pushToGitHub(fp, content) {
  const args = {
    owner: GH_OWNER, repo: GH_REPO, branch: GH_BRANCH,
    message: `sims: publish ${dateStr}`,
    files: [{ path: `sims/${dateStr}.json`, content }],
  };
  execFileSync(GITHUB_BIN, ['call-tool', '--name', 'push_files', '--arguments-json', JSON.stringify(args)],
    { timeout: 180000, stdio: ['ignore', 'pipe', 'pipe'] });
}

async function main() {
  console.log(`[sims-runner] date=${dateStr} sims=${SIMS_N} push=${DO_PUSH}`);
  const sched = await E.fetchJSON(`${API}/schedule/${dateStr}`);
  const day = (sched.gameWeek || []).find((w) => w.date === dateStr);
  const games = day ? day.games : [];
  const pre = games.filter((g) => g.gameState === 'FUT' || g.gameState === 'PRE');
  console.log(`[sims-runner] ${games.length} games on slate, ${pre.length} pre-game`);

  const { data: pub, fp } = loadPublished();
  const gamesOut = { ...(pub.games || {}) };

  const boxes = await E.limitedMap(pre, 4, async (g) => {
    try { return await E.fetchJSON(`${API}/gamecenter/${g.id}/boxscore`); }
    catch (e) { return null; }
  });

  let ran = 0, skippedLocked = 0, skippedUnlocked = 0;
  for (let i = 0; i < pre.length; i++) {
    const g = pre[i], box = boxes[i];
    const gid = String(g.id);
    const lock = lockStatus(box);
    if (!lock.locked) {
      skippedUnlocked++;
      console.log(`[sims-runner] ${g.awayTeam.abbrev}@${g.homeTeam.abbrev}: lineups not locked — skip`);
      continue;
    }
    const hash = rosterHash(box);
    const existing = gamesOut[gid];
    if (existing && existing.lineupLocked && existing.rosterHash === hash) {
      skippedLocked++;
      console.log(`[sims-runner] ${g.awayTeam.abbrev}@${g.homeTeam.abbrev}: already published (roster unchanged) — skip`);
      continue;
    }
    console.log(`[sims-runner] ${g.awayTeam.abbrev}@${g.homeTeam.abbrev}: lineups locked — simming ${SIMS_N}…`);
    try {
      gamesOut[gid] = await buildAndSim(g, box);
      ran++;
    } catch (e) {
      console.error(`[sims-runner] FAILED ${gid}: ${e.message}`);
    }
  }

  const next = { date: dateStr, generatedAt: ran ? new Date().toISOString() : (pub.generatedAt || null), games: gamesOut };
  const nextStr = JSON.stringify(next);
  const prevStr = pub.games ? JSON.stringify({ date: pub.date, generatedAt: pub.generatedAt, games: pub.games }) : null;
  const changed = nextStr !== prevStr;

  if (changed) {
    if (!fs.existsSync(SIMS_DIR)) fs.mkdirSync(SIMS_DIR, { recursive: true });
    fs.writeFileSync(fp, JSON.stringify(next, null, 1));
    console.log(`[sims-runner] wrote ${fp} (${ran} simmed, ${skippedLocked} already published, ${skippedUnlocked} unlocked)`);
    if (DO_PUSH) {
      pushToGitHub(fp, JSON.stringify(next, null, 1));
      console.log('[sims-runner] pushed to GitHub');
    }
  } else {
    console.log(`[sims-runner] no changes (${ran} simmed, ${skippedLocked} already published, ${skippedUnlocked} unlocked) — skip write/push`);
  }
}

if (require.main === module) {
  main().catch((e) => { console.error('[sims-runner] fatal:', e.message); process.exit(1); });
}
module.exports = { lockStatus, rosterHash, buildAndSim, loadPublished, LOCK_MIN_F, LOCK_MIN_D };
