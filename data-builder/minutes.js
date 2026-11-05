'use strict';
/* ============================================================================
MINUTES BUILDER — last-6 TOI breakdowns with PP/PK shift labeling.
----------------------------------------------------------------------------
For every skater on the slate, emits data/min-<date>.json:
  { date, builtAt, players: { "<pid>": [ game, ... ] } }   (oldest -> newest)
  game = { g, d, opp, hr, toi, per:[p1,p2,p3,ot], pp, pk, seg:[[s,e,k],...] }
    toi/per/pp/pk in seconds; seg on the absolute game clock (seconds),
    k: 0 = even strength, 1 = power play, 2 = penalty kill.

Sources per game (both immutable once final, cached forever):
  - shift charts: https://api.nhle.com/stats/rest/en/shiftcharts?cayenneExp=gameId=<id>
  - play-by-play: api-web gamecenter pbp (penalties -> manpower windows)
Cache: data-builder/cache/shift-finals.json (committed by the workflow,
same as zone-finals.json). A game is cached as:
  { d, h, a, ht, at, len, pp: {"<teamId>": [[s,e],...]},
    pl: { "<pid>": { t, per:[...], seg:[...] } } }
This module NEVER fails the bundle build: callers wrap it in try/catch and
a missing sidecar just hides the card section on the site.
============================================================================ */
const fs = require('fs');
const path = require('path');
const E = require('../engine.js');

const API = 'https://api-web.nhle.com/v1';
const STATS = 'https://api.nhle.com/stats/rest/en';
const CACHE_DIR = path.join(__dirname, 'cache');
const CACHE_FILE = path.join(CACHE_DIR, 'shift-finals.json');
const DATA_DIR = path.join(__dirname, '..', 'data');

const mmss = (s) => {
  const m = String(s || '').match(/^(\d+):(\d{2})$/);
  return m ? Number(m[1]) * 60 + Number(m[2]) : 0;
};
const periodBase = (p) => (p - 1) * 1200; // REG periods are 20:00; OT base 3600 still holds

function loadCache() {
  try { return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')) || {}; }
  catch (e) { return {}; }
}
function saveCache(cache) {
  if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.writeFileSync(CACHE_FILE, JSON.stringify(cache));
}

/* Manpower simulation -> PP windows per team.
   Penalties: MIN 2:00 (ends early on a PP goal), DBL = two stacked minors,
   MAJ (no early end), BENCH 2:00. MIS / PS / dur>=10 misconducts never
   reduce skaters and are skipped. Coincidental minors cancel out through
   the skater-diff sweep, so 4-on-4 reads as even strength. */
function computeWindows(pbp) {
  const homeId = pbp.homeTeam && pbp.homeTeam.id;
  const awayId = pbp.awayTeam && pbp.awayTeam.id;
  const pens = { [homeId]: [], [awayId]: [] }; // {start,end,major,chain}
  const goals = [];
  let maxPeriod = 3;
  const plays = [...(pbp.plays || [])].sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0));
  for (const p of plays) {
    const pd = (p.periodDescriptor || {}).number || 0;
    if (pd >= 1 && pd <= 4) maxPeriod = Math.max(maxPeriod, pd);
    if (pd < 1 || pd > 3) continue; // penalties/goals that move windows are regulation plays
    const t = periodBase(pd) + mmss(p.timeInPeriod);
    const det = p.details || {};
    if (p.typeDescKey === 'penalty') {
      const team = det.eventOwnerTeamId;
      if (team !== homeId && team !== awayId) continue;
      const type = det.typeCode || '';
      const dur = det.duration || 0;
      if (type === 'MIS' || type === 'PS' || dur >= 10) continue;
      if (type === 'DBL' || dur === 4) {
        const a = { start: t, end: t + 120, major: false, chain: null };
        const b = { start: t + 120, end: t + 240, major: false, chain: null };
        a.chain = b;
        pens[team].push(a, b);
      } else if (type === 'MAJ' || dur === 5) {
        pens[team].push({ start: t, end: t + (dur || 5) * 60, major: true, chain: null });
      } else {
        pens[team].push({ start: t, end: t + (dur || 2) * 60, major: false, chain: null });
      }
    } else if (p.typeDescKey === 'goal') {
      goals.push({ t, team: det.eventOwnerTeamId });
    }
  }
  const len = maxPeriod >= 4 ? 3900 : 3600;
  // a PP goal ends the scoring team's oldest active minor against them
  for (const g of goals) {
    const opp = g.team === homeId ? awayId : g.team === awayId ? homeId : null;
    if (!opp) continue;
    const mine = pens[g.team].filter((x) => x.start <= g.t && g.t < x.end).length;
    const theirs = pens[opp].filter((x) => x.start <= g.t && g.t < x.end);
    if (theirs.length > mine) {
      const victim = theirs.filter((x) => !x.major).sort((a, b) => a.end - b.end)[0];
      if (victim && g.t < victim.end) {
        victim.end = g.t;
        if (victim.chain) {
          const c = victim.chain;
          c.start = g.t;
          c.end = g.t + 120;
        }
      }
    }
  }
  // sweep elementary intervals; PP where the opponent has more men in the box
  const pp = { [homeId]: [], [awayId]: [] };
  const points = new Set([0, len]);
  for (const team of [homeId, awayId]) {
    for (const x of pens[team]) { points.add(Math.max(0, x.start)); points.add(Math.min(len, x.end)); }
  }
  const sorted = [...points].sort((a, b) => a - b);
  const active = (team, t) => pens[team].filter((x) => x.start <= t && t < x.end).length;
  for (let i = 0; i + 1 < sorted.length; i++) {
    const s = sorted[i], e = sorted[i + 1];
    if (e - s < 1) continue;
    const mid = (s + e) / 2;
    const hA = active(homeId, mid), aA = active(awayId, mid);
    const push = (team, arr) => {
      const last = arr[arr.length - 1];
      if (last && last[1] === s) last[1] = e; else arr.push([s, e]);
    };
    if (aA > hA) push(homeId, pp[homeId]);
    else if (hA > aA) push(awayId, pp[awayId]);
  }
  return { homeId, awayId, len, pp };
}

function gameEntry(pbp, shiftsJson) {
  const w = computeWindows(pbp);
  const posByPid = {};
  for (const r of (pbp.rosterSpots || [])) posByPid[String(r.playerId)] = r.positionCode || '';
  const byPid = {};
  for (const r of (shiftsJson.data || [])) {
    const per = r.period;
    if (!per || per < 1 || per > 4) continue;
    const s = periodBase(per) + mmss(r.startTime);
    const e = periodBase(per) + mmss(r.endTime);
    if (e <= s) continue;
    const key = String(r.playerId);
    const pl = byPid[key] || (byPid[key] = { t: r.teamId, shifts: [] });
    pl.shifts.push([s, e]);
  }
  const pl = {};
  for (const [pid, v] of Object.entries(byPid)) {
    const teamId = v.t;
    const ownPP = w.pp[teamId] || [];
    const oppId = teamId === w.homeId ? w.awayId : w.homeId;
    const oppPP = w.pp[oppId] || [];
    const per = [0, 0, 0, 0];
    const seg = [];
    const cutsFor = (a, b) => {
      const cuts = new Set([a, b]);
      for (const [ws, we] of [...ownPP, ...oppPP]) {
        if (a < ws && ws < b) cuts.add(ws);
        if (a < we && we < b) cuts.add(we);
      }
      return [...cuts].sort((x, y) => x - y);
    };
    const kindAt = (t) => {
      if (ownPP.some(([ws, we]) => ws <= t && t < we)) return 1;
      if (oppPP.some(([ws, we]) => ws <= t && t < we)) return 2;
      return 0;
    };
    for (const [a, b] of v.shifts.sort((x, y) => x[0] - y[0])) {
      const pi = Math.min(3, Math.floor(a / 1200));
      per[pi] += b - a;
      const cuts = cutsFor(a, b);
      for (let i = 0; i + 1 < cuts.length; i++) {
        const s = cuts[i], e = cuts[i + 1];
        if (e - s < 1) continue;
        const k = kindAt((s + e) / 2);
        const last = seg[seg.length - 1];
        if (last && last[2] === k && last[1] === s) last[1] = e;
        else seg.push([s, e, k]);
      }
    }
    if (seg.length) pl[pid] = { t: teamId, pos: posByPid[pid] || '', per, seg };
  }
  return {
    d: pbp.gameDate || '',
    h: (pbp.homeTeam || {}).abbrev || '',
    a: (pbp.awayTeam || {}).abbrev || '',
    ht: w.homeId, at: w.awayId, len: w.len,
    pp: { [String(w.homeId)]: w.pp[w.homeId], [String(w.awayId)]: w.pp[w.awayId] },
    pl,
  };
}

/* Fetch + cache any of `gameIds` not already cached. Returns the cache. */
async function ensureGames(gameIds, fetchRetry, counted) {
  const cache = loadCache();
  let dirty = false, fetched = 0;
  const todo = [...new Set(gameIds.map(String))].filter((id) => !cache[id]);
  await E.limitedMap(todo, 3, async (id) => {
    try {
      const pbp = await counted(fetchRetry(`${API}/gamecenter/${id}/play-by-play`, 'minPbp'));
      const sh = await counted(fetchRetry(`${STATS}/shiftcharts?cayenneExp=gameId=${id}`, 'shifts'));
      if (!pbp || !sh || !Array.isArray(sh.data)) return;
      const entry = gameEntry(pbp, sh);
      // The stats API only retains a rolling window of shift charts —
      // older games return total:0. Don't cache those: a later build (or
      // a future archival source) should get another shot at them.
      if (!Object.keys(entry.pl).length) return;
      cache[id] = entry;
      dirty = true; fetched++;
    } catch (e) { /* skip game — histories just run shorter */ }
  });
  if (dirty) saveCache(cache);
  return { cache, fetched };
}

/* finalsByTeam: { ABBR: [gameId, ...] most recent first } for slate teams.
   pidSet: Set<number> of slate skaters (goalies excluded by the caller).
   Writes data/min-<dateStr>.json. Returns a small summary for logging. */
async function buildMinutes({ dateStr, finalsByTeam, pidSet, fetchRetry, counted }) {
  const wanted = new Set();
  for (const ids of Object.values(finalsByTeam || {})) {
    for (const id of (ids || []).slice(0, 6)) wanted.add(id);
  }
  const { cache, fetched } = await ensureGames([...wanted], fetchRetry, counted);
  const gamesAsc = Object.entries(cache)
    .filter(([id]) => wanted.has(Number(id)) || wanted.has(id))
    .sort((a, b) => (a[1].d || '').localeCompare(b[1].d || '') || Number(a[0]) - Number(b[0]));
  const hist = {}; // pid -> [game,...] ascending
  for (const [gid, g] of gamesAsc) {
    for (const [pid, v] of Object.entries(g.pl || {})) {
      if (!pidSet.has(Number(pid))) continue;
      const home = v.t === g.ht;
      let toi = 0, pp = 0, pk = 0;
      for (const [s, e, k] of v.seg) {
        toi += e - s;
        if (k === 1) pp += e - s; else if (k === 2) pk += e - s;
      }
      (hist[pid] = hist[pid] || []).push({
        g: Number(gid), d: g.d, opp: home ? g.a : g.h, hr: home ? 'H' : 'R',
        toi, per: v.per, pp, pk, len: g.len, seg: v.seg,
      });
    }
  }
  const players = {};
  for (const [pid, arr] of Object.entries(hist)) {
    players[pid] = arr.slice(-6);
  }
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(path.join(DATA_DIR, `min-${dateStr}.json`),
    JSON.stringify({ date: dateStr, builtAt: new Date().toISOString(), players }));
  return { players: Object.keys(players).length, gamesFetched: fetched, gamesWanted: wanted.size };
}

module.exports = { computeWindows, gameEntry, ensureGames, buildMinutes, loadCache };
