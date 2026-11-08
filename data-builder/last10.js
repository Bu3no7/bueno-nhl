'use strict';
/* ============================================================================
LAST-10 SHOTS SIDECAR — for every skater on the slate, his shots on goal
and attempt locations over his last 10 played games (finals before the
slate date). Powers the player card's "Last 10 vs Proj" block (joined to
the Shot Map section) and the game sheet's shooter strip.

Emits data/last10-<date>.json:
  { date, players: { "<pid>": { n, sog, att } } }
  n   = games counted (3..10; thinner samples are dropped)
  sog = shots on goal in those games (shot-on-goal + goal plays,
        shootout excluded — shootout attempts are not SOG)
  att = [[x, y, goal], ...] attempt locations in the display frame
        (attacking net at +x, same slim shape as the zone cache),
        newest game first, capped at 90.

Source: full play-by-play of each slate team's recent finals, slimmed
once and cached forever in data-builder/cache/last10-finals.json as
  { "<gid>": { "<pid>": [sog, [[x,y,g], ...]] } }
The slimming mirrors engine.displayShotsByPid's rotation (period-1 home
shot median fixes orientation, ends alternate) but also counts SOG.
A game counts as "played" when the player has an attempt entry in it or
a shift-cache entry (shift-finals.json) — a dressed player always has
shifts, so zero-attempt games still count.

Best effort like the minutes/chemistry/goalie steps: failures are
skipped, the module never throws, and a missing sidecar just hides the
blocks on the site.
============================================================================ */
const fs = require('fs');
const path = require('path');
const E = require('../engine.js');

const API = 'https://api-web.nhle.com/v1';
const DATA_DIR = path.join(__dirname, '..', 'data');
const CACHE_PATH = path.join(__dirname, 'cache', 'last10-finals.json');
const SHIFT_CACHE_PATH = path.join(__dirname, 'cache', 'shift-finals.json');
const ATT_TYPES = ['shot-on-goal', 'goal', 'missed-shot', 'blocked-shot'];
const MAX_GAMES = 10;
const FETCH_PER_TEAM = 14; // buffer over 10 for games a player missed
const ATT_CAP = 90;
const MIN_GAMES = 3;

function loadJson(p, dflt) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return dflt; }
}

/* One final's pbp -> { pid: [sog, [[x, y, goal], ...]] } in display frame. */
function slimGame(pbp) {
  const homeId = pbp.homeTeam.id;
  const p1xs = [];
  for (const p of (pbp.plays || [])) {
    const det = p.details || {};
    const pd = p.periodDescriptor || {};
    if (pd.number !== 1 || !ATT_TYPES.includes(p.typeDescKey)) continue;
    if (det.xCoord == null || det.eventOwnerTeamId !== homeId) continue;
    p1xs.push(det.xCoord);
  }
  p1xs.sort((a, b) => a - b);
  const homePlusP1 = p1xs.length ? p1xs[Math.floor(p1xs.length / 2)] > 0 : true;
  const homeAttacksPlus = (period) => homePlusP1 === (period % 2 === 1);
  const out = {};
  for (const p of (pbp.plays || [])) {
    const k = p.typeDescKey;
    if (!ATT_TYPES.includes(k)) continue;
    const pd = p.periodDescriptor || {};
    if ((pd.number || 1) >= 5) continue; // shootout is not SOG hockey
    const det = p.details || {};
    const shooter = k === 'goal' ? det.scoringPlayerId : det.shootingPlayerId;
    if (shooter == null || det.xCoord == null || det.yCoord == null) continue;
    const isHome = det.eventOwnerTeamId === homeId;
    const attPlus = isHome ? homeAttacksPlus(pd.number || 1) : !homeAttacksPlus(pd.number || 1);
    const x = Math.round((attPlus ? det.xCoord : -det.xCoord) * 10) / 10;
    const y = Math.round((attPlus ? det.yCoord : -det.yCoord) * 10) / 10;
    const e = out[shooter] || (out[shooter] = [0, []]);
    if (k === 'shot-on-goal' || k === 'goal') e[0]++;
    e[1].push([x, y, k === 'goal' ? 1 : 0]);
  }
  return out;
}

async function buildLast10({ dateStr, pidSet, pidTeam, finalsByTeam, fetchRetry, counted }) {
  const cache = loadJson(CACHE_PATH, {});
  const shiftCache = loadJson(SHIFT_CACHE_PATH, {});
  const teams = [...new Set(Object.values(pidTeam || {}))];
  const wanted = new Set();
  for (const t of teams) {
    for (const gid of (finalsByTeam[t] || []).slice(0, FETCH_PER_TEAM)) wanted.add(String(gid));
  }
  let fetched = 0;
  await E.limitedMap([...wanted], 3, async (gid) => {
    if (cache[gid]) return;
    try {
      const full = await counted(fetchRetry(`${API}/gamecenter/${gid}/play-by-play`, 'last10'));
      if (full && full.plays) { cache[gid] = slimGame(full); fetched++; }
    } catch (e) { /* best effort: a missing final just shortens windows */ }
  });
  try { fs.writeFileSync(CACHE_PATH, JSON.stringify(cache)); } catch (e) { /* cache is an optimization */ }

  const players = {};
  for (const pid of pidSet) {
    const team = (pidTeam || {})[String(pid)] || (pidTeam || {})[pid];
    if (!team) continue;
    let n = 0, sog = 0;
    const att = [];
    for (const gidRaw of (finalsByTeam[team] || [])) {
      if (n >= MAX_GAMES) break;
      const gid = String(gidRaw);
      const entry = cache[gid];
      const mine = entry && entry[String(pid)];
      const dressed = !!mine || !!((shiftCache[gid] || {}).pl || {})[String(pid)];
      if (!dressed) continue;
      n++;
      if (mine) {
        sog += mine[0];
        for (const s of mine[1]) { if (att.length < ATT_CAP) att.push(s); }
      }
    }
    if (n >= MIN_GAMES) players[String(pid)] = { n, sog, att };
  }
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(path.join(DATA_DIR, `last10-${dateStr}.json`), JSON.stringify({ date: dateStr, players }));
  return { players: Object.keys(players).length, fetched, wanted: wanted.size };
}

module.exports = { buildLast10, slimGame };
