'use strict';
/* ============================================================================
CHEMISTRY BUILDER — linemate / partner percentage data for player cards.
----------------------------------------------------------------------------
Emits data/chem-<date>.json:
  { date, builtAt, players: { "<pid>": {
      g, a, a1, a2,                       // season goal involvement
      fed:   [{ pid, name, n }],          // n = his goals with an assist from pid
      feeds: [{ pid, name, n }],          // n = his assists on goals scored by pid
      shared: [{ pid, name, pct }],       // % of his TOI shared (shift-cache window)
      sharedGames } } }
Goal involvement accumulates over EVERY regular-season final of the slate
teams (shootout goals excluded). Finals are immutable -> per-game deltas
are cached forever in data-builder/cache/involve-finals.json:
  { games: { "<gid>": { "<pid>": { g, a, a1, a2, fed: {}, feeds: {} } } },
    names: { "<pid>": "Full Name" } }
Shared TOI comes from the minutes builder's shift cache (last-6 window).
Best effort like the minutes step: never fails the bundle build.
============================================================================ */
const fs = require('fs');
const path = require('path');
const E = require('../engine.js');
const M = require('./minutes.js');

const API = 'https://api-web.nhle.com/v1';
const CACHE_DIR = path.join(__dirname, 'cache');
const CACHE_FILE = path.join(CACHE_DIR, 'involve-finals.json');
const DATA_DIR = path.join(__dirname, '..', 'data');

function loadCache() {
  try {
    const c = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')) || {};
    return { games: c.games || {}, names: c.names || {} };
  } catch (e) { return { games: {}, names: {} }; }
}
function saveCache(cache) {
  if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.writeFileSync(CACHE_FILE, JSON.stringify(cache));
}

/* Per-game involvement deltas from one final's play-by-play. */
function gameInvolvement(pbp) {
  const out = {};
  const bump = (pid, fn) => {
    if (!pid) return;
    const e = out[String(pid)] || (out[String(pid)] = { g: 0, a: 0, a1: 0, a2: 0, fed: {}, feeds: {} });
    fn(e);
  };
  for (const p of (pbp.plays || [])) {
    if (p.typeDescKey !== 'goal') continue;
    if (((p.periodDescriptor || {}).periodType || '') === 'SO') continue;
    const det = p.details || {};
    const s = det.scoringPlayerId, x1 = det.assist1PlayerId, x2 = det.assist2PlayerId;
    if (!s) continue;
    bump(s, (e) => {
      e.g++;
      if (x1) e.fed[String(x1)] = (e.fed[String(x1)] || 0) + 1;
      if (x2) e.fed[String(x2)] = (e.fed[String(x2)] || 0) + 1;
    });
    if (x1) bump(x1, (e) => { e.a++; e.a1++; e.feeds[String(s)] = (e.feeds[String(s)] || 0) + 1; });
    if (x2) bump(x2, (e) => { e.a++; e.a2++; e.feeds[String(s)] = (e.feeds[String(s)] || 0) + 1; });
  }
  return out;
}

function overlapSecs(a, b) {
  // two-pointer overlap of two sorted, non-overlapping [s, e] lists
  let i = 0, j = 0, tot = 0;
  while (i < a.length && j < b.length) {
    const s = Math.max(a[i][0], b[j][0]);
    const e = Math.min(a[i][1], b[j][1]);
    if (e > s) tot += e - s;
    if (a[i][1] < b[j][1]) i++; else j++;
  }
  return tot;
}

async function buildChem({ dateStr, finalsByTeam, pidSet, goalieSet, fetchRetry, counted }) {
  const wanted = new Set();
  for (const ids of Object.values(finalsByTeam || {})) {
    for (const id of ids || []) wanted.add(String(id));
  }
  // 1. involvement: fetch finals the cache has never seen
  const cache = loadCache();
  let dirty = false, fetched = 0;
  const todo = [...wanted].filter((id) => !cache.games[id]);
  await E.limitedMap(todo, 3, async (id) => {
    try {
      const pbp = await counted(fetchRetry(`${API}/gamecenter/${id}/play-by-play`, 'chemPbp'));
      if (!pbp) return;
      for (const r of (pbp.rosterSpots || [])) {
        const nm = `${(r.firstName || {}).default || ''} ${(r.lastName || {}).default || ''}`.trim();
        if (nm) cache.names[String(r.playerId)] = nm;
      }
      cache.games[id] = gameInvolvement(pbp);
      dirty = true; fetched++;
    } catch (e) { /* skip — totals just run shorter */ }
  });
  if (dirty) saveCache(cache);

  // 2. aggregate season involvement for slate skaters
  const agg = {};
  for (const id of wanted) {
    const game = cache.games[id];
    if (!game) continue;
    for (const [pid, d] of Object.entries(game)) {
      if (!pidSet.has(Number(pid))) continue;
      const e = agg[pid] || (agg[pid] = { g: 0, a: 0, a1: 0, a2: 0, fed: {}, feeds: {} });
      e.g += d.g; e.a += d.a; e.a1 += d.a1; e.a2 += d.a2;
      for (const [k, v] of Object.entries(d.fed || {})) e.fed[k] = (e.fed[k] || 0) + v;
      for (const [k, v] of Object.entries(d.feeds || {})) e.feeds[k] = (e.feeds[k] || 0) + v;
    }
  }

  // 3. shared TOI from the shift cache, each player's last-6 cached games
  const shiftCache = M.loadCache();
  const gamesAsc = Object.entries(shiftCache)
    .sort((x, y) => (x[1].d || '').localeCompare(y[1].d || '') || Number(x[0]) - Number(y[0]));
  const appearances = {}; // pid -> [gameIndex,...] ascending
  gamesAsc.forEach(([, g], gi) => {
    for (const pid of Object.keys(g.pl || {})) {
      if (pidSet.has(Number(pid))) (appearances[pid] = appearances[pid] || []).push(gi);
    }
  });
  const windowGames = new Set();
  for (const list of Object.values(appearances)) {
    for (const gi of list.slice(-6)) windowGames.add(gi);
  }
  const sharedAcc = {}; // pid -> { toi, games:Set, with: {pid2: secs} }
  gamesAsc.forEach(([, g], gi) => {
    if (!windowGames.has(gi)) return;
    const pl = g.pl || {};
    const pids = Object.keys(pl).filter((pid) => pidSet.has(Number(pid)));
    const intervals = {};
    for (const pid of pids) intervals[pid] = pl[pid].seg.map(([s, e]) => [s, e]);
    for (const pid of pids) {
      const acc = sharedAcc[pid] || (sharedAcc[pid] = { toi: 0, games: new Set(), with: {} });
      acc.toi += intervals[pid].reduce((t, [s, e]) => t + (e - s), 0);
      acc.games.add(gi);
      for (const pid2 of pids) {
        if (pid2 === pid) continue;
        if (pl[pid2].t !== pl[pid].t) continue; // teammates only
        if (goalieSet && goalieSet.has(Number(pid2))) continue;
        if ((pl[pid2].pos || '') === 'G') continue;
        const ov = overlapSecs(intervals[pid], intervals[pid2]);
        if (ov > 0) acc.with[pid2] = (acc.with[pid2] || 0) + ov;
      }
    }
  });

  // 4. assemble sidecar (top-5 lists; names from the cache)
  const shortName = (pid) => {
    const full = cache.names[String(pid)] || '';
    if (!full) return '';
    const parts = full.split(' ');
    return parts.length > 1 ? parts.slice(1).join(' ') : full;
  };
  const topList = (map, base) => Object.entries(map || {})
    .map(([pid, n]) => ({ pid: Number(pid), name: shortName(pid), n }))
    .filter((x) => x.name && x.n > 0)
    .sort((a, b) => b.n - a.n)
    .slice(0, 5);
  const players = {};
  for (const [pid, e] of Object.entries(agg)) {
    if (e.g + e.a < 1) continue;
    const acc = sharedAcc[pid];
    const shared = acc && acc.toi > 0
      ? Object.entries(acc.with)
          .map(([p2, secs]) => ({ pid: Number(p2), name: shortName(p2), pct: Math.round((secs / acc.toi) * 100) }))
          .filter((x) => x.name && x.pct >= 5)
          .sort((a, b) => b.pct - a.pct)
          .slice(0, 5)
      : [];
    players[pid] = {
      g: e.g, a: e.a, a1: e.a1, a2: e.a2,
      fed: topList(e.fed), feeds: topList(e.feeds),
      shared, sharedGames: acc ? acc.games.size : 0,
    };
  }
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(path.join(DATA_DIR, `chem-${dateStr}.json`),
    JSON.stringify({ date: dateStr, builtAt: new Date().toISOString(), players }));
  return { players: Object.keys(players).length, gamesFetched: fetched, gamesWanted: wanted.size };
}

module.exports = { buildChem, gameInvolvement };
