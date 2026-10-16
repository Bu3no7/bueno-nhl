#!/usr/bin/env node
'use strict';
/* ============================================================================
NHL DATA BUILDER — precomputes the site's entire slate bundle, 3x daily.
----------------------------------------------------------------------------
Concept: instead of every visitor's browser making ~300 NHL API requests on
load (schedule, per-game pbps, rosters, 7 schedule scans, zone pbps, ~220
player landings, standings), this script fetches everything ONCE on a schedule
and writes ONE slim file data/<date>.json. The site loads that single file
(~1 request) and falls back to the live /nhl-api/* proxy only if the bundle
is missing or stale.

The bundle keeps the EXACT field names the site's renderers read — it is
slimmed (unused fields dropped), not reshaped — so the downstream code paths
(rosterSpots, plays, homeTeam/awayTeam, clock, etc.) work unchanged.

What gets fetched per date D:
  1. schedule/D                                              (1 call)
  2. gamecenter/{gid}/play-by-play  (per game on the slate)
  3. roster/{team}/{season}         (only teams whose pbp has no roster)
  4. schedule/D-1 .. D-7            (7 calls, recent finals per team)
  5. gamecenter/{recentId}/play-by-play (<=1 per team, zone + goalie data)
  6. player/{pid}/landing           (every dressed/projected skater + goalies)
  7. standings/D                    (1 call)

Slim pbp keeps, per game:
  - rosterSpots: playerId, firstName/lastName.default, positionCode, teamId, headshot
  - goal plays: full details (scorer, assists, goalieInNetId, coords, time,
    sortOrder, situationCode, shotType, scores, penaltyShot)
  - shot attempts: typeDescKey + shootingPlayerId/coords/team only
  - homeTeam/awayTeam: id, abbrev, score, sog
  - clock.timeRemaining, periodDescriptor.number, gameState,
    homeTeamDefendingSide
  - _starters: precomputed {away:{id,name}, home:{id,name}} via the same
    first-goalieInNetId logic the site uses (builder sees the full pbp)

Players are stored in the site's own slimLanding() shape
{sub:{...}, totals:[...], last5:[...]} so the browser can feed them straight
through unslimLanding() -> skaterSeason() with zero changes.

Usage:
  node data-builder/build.js [--date=YYYY-MM-DD]
  (GitHub Actions runs this 3x daily and commits data/ itself via git.)
============================================================================ */

const fs = require('fs');
const path = require('path');
const E = require('../engine.js');

const API = 'https://api-web.nhle.com/v1';
const SITE_DIR = path.resolve(__dirname, '..');
const DATA_DIR = path.join(SITE_DIR, 'data');

const argv = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    return m ? [m[1], m[2] === undefined ? true : m[2]] : ['_', a];
  })
);
const phoenixToday = () =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Phoenix', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const dateStr = argv.date || phoenixToday();
const [ry, rm] = dateStr.split('-').map(Number);
const seasonId = `${rm >= 7 ? ry : ry - 1}${(rm >= 7 ? ry : ry - 1) + 1}`;

const SHOT_KEYS = new Set(['shot-on-goal', 'missed-shot', 'blocked-shot']);

function slimTeam(t) {
  if (!t) return { id: null, abbrev: '', score: 0, sog: null };
  return {
    id: t.id != null ? t.id : null,
    abbrev: t.abbrev || '',
    score: typeof t.score === 'number' ? t.score : 0,
    sog: typeof t.sog === 'number' ? t.sog : null,
  };
}

// Same logic as the site's goalieStarter(): first goalieInNetId seen
// defending for the team, in chronological play order.
function starterFor(pbp, teamAbbrev) {
  if (!pbp) return { id: null, name: '' };
  const home = pbp.homeTeam || {}, away = pbp.awayTeam || {};
  if (teamAbbrev !== home.abbrev && teamAbbrev !== away.abbrev) return { id: null, name: '' };
  const info = {};
  for (const r of (pbp.rosterSpots || [])) {
    if (r.positionCode !== 'G') continue;
    info[r.playerId] = {
      name: `${(r.firstName || {}).default || ''} ${(r.lastName || {}).default || ''}`.trim(),
      teamId: r.teamId,
    };
  }
  const idToAbbrev = {};
  if (home.id != null) idToAbbrev[home.id] = home.abbrev;
  if (away.id != null) idToAbbrev[away.id] = away.abbrev;
  for (const p of (pbp.plays || [])) {
    const gid = (p.details || {}).goalieInNetId;
    const gi = gid && info[gid];
    if (!gi) continue;
    if (idToAbbrev[gi.teamId] === teamAbbrev) return { id: gid, name: gi.name };
  }
  return { id: null, name: '' };
}

function slimPbp(pbp) {
  if (!pbp) return null;
  const rosterSpots = (pbp.rosterSpots || []).map((r) => ({
    playerId: r.playerId,
    firstName: { default: (r.firstName || {}).default || '' },
    lastName: { default: (r.lastName || {}).default || '' },
    positionCode: r.positionCode || '',
    teamId: r.teamId != null ? r.teamId : null,
    headshot: r.headshot || '',
  }));
  const plays = [];
  for (const p of (pbp.plays || [])) {
    const k = p.typeDescKey;
    const det = p.details || {};
    const pd = p.periodDescriptor || {};
    if (k === 'goal') {
      plays.push({
        typeDescKey: 'goal',
        details: {
          scoringPlayerId: det.scoringPlayerId != null ? det.scoringPlayerId : null,
          assist1PlayerId: det.assist1PlayerId != null ? det.assist1PlayerId : null,
          assist2PlayerId: det.assist2PlayerId != null ? det.assist2PlayerId : null,
          goalieInNetId: det.goalieInNetId != null ? det.goalieInNetId : null,
          shootingPlayerId: det.shootingPlayerId != null ? det.shootingPlayerId : null,
          xCoord: det.xCoord != null ? det.xCoord : null,
          yCoord: det.yCoord != null ? det.yCoord : null,
          eventOwnerTeamId: det.eventOwnerTeamId != null ? det.eventOwnerTeamId : null,
          shotType: det.shotType || '',
          awayScore: det.awayScore != null ? det.awayScore : null,
          homeScore: det.homeScore != null ? det.homeScore : null,
          penaltyShot: !!det.penaltyShot,
        },
        periodDescriptor: { number: pd.number != null ? pd.number : 0, periodType: pd.periodType || '' },
        timeInPeriod: p.timeInPeriod || '',
        sortOrder: p.sortOrder || 0,
        situationCode: p.situationCode || '',
      });
    } else if (SHOT_KEYS.has(k)) {
      if (det.xCoord == null || det.yCoord == null) continue;
      plays.push({
        typeDescKey: k,
        details: {
          shootingPlayerId: det.shootingPlayerId != null ? det.shootingPlayerId : null,
          xCoord: det.xCoord,
          yCoord: det.yCoord,
          eventOwnerTeamId: det.eventOwnerTeamId != null ? det.eventOwnerTeamId : null,
        },
        periodDescriptor: { number: pd.number != null ? pd.number : 0, periodType: pd.periodType || '' },
      });
    }
    // every other play type is dropped — the site never reads them
  }
  const home = slimTeam(pbp.homeTeam), away = slimTeam(pbp.awayTeam);
  return {
    gameState: pbp.gameState || '',
    homeTeam: home,
    awayTeam: away,
    clock: pbp.clock && pbp.clock.timeRemaining ? { timeRemaining: pbp.clock.timeRemaining } : null,
    periodDescriptor: pbp.periodDescriptor && pbp.periodDescriptor.number != null
      ? { number: pbp.periodDescriptor.number } : null,
    homeTeamDefendingSide: pbp.homeTeamDefendingSide || null,
    rosterSpots,
    plays,
    _starters: {
      away: starterFor(pbp, away.abbrev),
      home: starterFor(pbp, home.abbrev),
    },
  };
}

function slimRosterSpot(r) {
  return {
    id: r.id,
    firstName: { default: (r.firstName || {}).default || '' },
    lastName: { default: (r.lastName || {}).default || '' },
    positionCode: r.positionCode || '',
    headshot: r.headshot || '',
  };
}

// The site's slimLanding() shape, verbatim — the browser feeds these straight
// through unslimLanding() -> skaterSeason().
function slimPlayer(d) {
  const sub = (d.featuredStats && d.featuredStats.regularSeason && d.featuredStats.regularSeason.subSeason) || {};
  return {
    sub: {
      gamesPlayed: sub.gamesPlayed || 0,
      goals: sub.goals || 0,
      shots: sub.shots || 0,
      assists: sub.assists || 0,
      points: sub.points || 0,
      powerPlayGoals: sub.powerPlayGoals || 0,
      powerPlayPoints: sub.powerPlayPoints || 0,
      savePctg: sub.savePctg || 0,
    },
    totals: (d.seasonTotals || [])
      .filter((t) => t.gameTypeId === 2 && t.avgToi)
      .map((t) => ({ season: t.season, avgToi: t.avgToi })),
    last5: d.last5Games || [],
  };
}

function slimStandings(d) {
  const map = {};
  for (const s of (d.standings || [])) {
    const ab = s.teamAbbrev && s.teamAbbrev.default;
    if (!ab) continue;
    map[ab] = {
      wins: s.wins || 0, losses: s.losses || 0, otLosses: s.otLosses || 0,
      gamesPlayed: s.gamesPlayed || 0,
      goalFor: s.goalFor || 0, goalAgainst: s.goalAgainst || 0,
      pointPctg: s.pointPctg || 0,
      l10Wins: s.l10Wins || 0, l10Losses: s.l10Losses || 0,
      l10OtLosses: s.l10OtLosses || 0, l10GamesPlayed: s.l10GamesPlayed || 0,
      streakCode: s.streakCode || '', streakCount: s.streakCount || 0,
    };
  }
  return map;
}

const playerCache = new Map();
async function getPlayer(pid) {
  if (playerCache.has(pid)) return playerCache.get(pid);
  const p = E.fetchJSON(`${API}/player/${pid}/landing`).then((d) => {
    playerCache.set(pid, d);
    return d;
  }).catch(() => { playerCache.set(pid, null); return null; });
  playerCache.set(pid, p);
  return p;
}

async function main() {
  console.log(`[data-builder] date=${dateStr}`);
  let nFetch = 0;
  const counted = (p) => { nFetch++; return p; };

  // 1. schedule
  const sched = await counted(E.fetchJSON(`${API}/schedule/${dateStr}`));
  const day = (sched.gameWeek || []).find((w) => w.date === dateStr);
  const games = day ? day.games : [];
  console.log(`[data-builder] ${games.length} games on slate`);

  const out = {
    date: dateStr,
    builtAt: new Date().toISOString(),
    games: games.map((g) => ({
      id: g.id,
      away: g.awayTeam.abbrev, home: g.homeTeam.abbrev,
      state: g.gameState, startUTC: g.startTimeUTC,
    })),
    pbps: {}, rosters: {}, recentIds: {}, zonePbps: {},
    players: {}, goalieSv: {}, standings: {},
  };
  if (!games.length) {
    write(out);
    console.log('[data-builder] no games — wrote empty bundle');
    return;
  }

  // 2. per-game pbps (keep full copies for the goalieForGame replication below)
  const fullPbpCache = {};
  const pbps = await E.limitedMap(games, 4, async (g) => {
    try {
      const full = await counted(E.fetchJSON(`${API}/gamecenter/${g.id}/play-by-play`));
      fullPbpCache[String(g.id)] = full;
      return slimPbp(full);
    }
    catch (e) { return null; }
  });
  games.forEach((g, i) => { out.pbps[String(g.id)] = pbps[i]; });

  // 3. rosters for teams whose pbp has no roster (pre-game)
  const needRoster = games.filter((g, i) => !pbps[i] || !(pbps[i].rosterSpots || []).length);
  const rosterTeams = [...new Set(
    games.filter((g, i) => !pbps[i] || !(pbps[i].rosterSpots || []).length)
      .flatMap((g) => [g.awayTeam.abbrev, g.homeTeam.abbrev])
  )];
  await E.limitedMap(rosterTeams, 4, async (t) => {
    try {
      const r = await counted(E.fetchJSON(`${API}/roster/${t}/${seasonId}`));
      out.rosters[t] = {
        forwards: (r.forwards || []).map(slimRosterSpot),
        defensemen: (r.defensemen || []).map(slimRosterSpot),
      };
    } catch (e) { out.rosters[t] = { forwards: [], defensemen: [] }; }
  });
  console.log(`[data-builder] rosters for ${rosterTeams.length} teams`);

  // 4+5. recent finals per team + their pbps (zone + goalie data)
  const recentByTeam = await E.recentFinalsByTeam(API, dateStr, 1);
  nFetch += 7; // recentFinalsByTeam does 7 schedule fetches
  const teams = [...new Set(games.flatMap((g) => [g.awayTeam.abbrev, g.homeTeam.abbrev]))];
  for (const t of teams) out.recentIds[t] = recentByTeam[t] || [];
  const zoneIds = [...new Set(Object.values(out.recentIds).flat())];
  await E.limitedMap(zoneIds, 4, async (id) => {
    try { out.zonePbps[String(id)] = slimPbp(await counted(E.fetchJSON(`${API}/gamecenter/${id}/play-by-play`))); }
    catch (e) { /* skip */ }
  });
  console.log(`[data-builder] ${zoneIds.length} zone pbps`);

  // 6. every skater + goalie landing, slimmed to the site's slimLanding shape
  const pidSet = new Set();
  const goalieIds = new Set();
  games.forEach((g, i) => {
    const pbp = pbps[i];
    if (pbp && (pbp.rosterSpots || []).length) {
      for (const r of pbp.rosterSpots) {
        if (r.positionCode === 'G') { goalieIds.add(r.playerId); continue; }
        pidSet.add(r.playerId);
      }
    } else {
      for (const t of [g.awayTeam.abbrev, g.homeTeam.abbrev]) {
        for (const r of [...((out.rosters[t] || {}).forwards || []), ...((out.rosters[t] || {}).defensemen || [])]) {
          pidSet.add(r.id);
        }
      }
    }
    // goalies also appear via _starters
    const st = (pbp && pbp._starters) || {};
    for (const s of [st.away, st.home]) if (s && s.id) goalieIds.add(s.id);
  });
  // recent-final starters (projected goalie fallback)
  for (const zid of Object.keys(out.zonePbps)) {
    const st = out.zonePbps[zid]._starters || {};
    for (const s of [st.away, st.home]) if (s && s.id) goalieIds.add(s.id);
  }
  const allPids = [...pidSet, ...goalieIds];
  console.log(`[data-builder] ${pidSet.size} skaters + ${goalieIds.size} goalies = ${allPids.length} landings`);
  await E.limitedMap(allPids, 6, async (pid) => {
    const d = await getPlayer(pid).catch(() => null);
    nFetch++;
    if (d) out.players[String(pid)] = slimPlayer(d);
  });

  // goalie save pct per game — EXACT site logic replicated: goalieForGame()
  // takes the FIRST goalieInNetId seen in chronological play order of the
  // FULL pbp (before slimming). One sv% per game, applied to all skaters.
  const fullPbps = {};
  games.forEach((g, i) => { fullPbps[String(g.id)] = fullPbpCache[String(g.id)] || null; });
  games.forEach((g) => {
    const gid = String(g.id);
    const full = fullPbps[gid];
    let goalieId = null;
    if (full) {
      for (const p of (full.plays || [])) {
        const det = p.details || {};
        if (det.goalieInNetId) { goalieId = det.goalieInNetId; break; }
      }
    }
    const slim = goalieId ? out.players[String(goalieId)] : null;
    out.goalieSv[gid] = (slim && slim.sub.savePctg) || 0.900;
  });

  // 7. standings
  try {
    const st = await counted(E.fetchJSON(`${API}/standings/${dateStr}`));
    out.standings = slimStandings(st);
  } catch (e) { out.standings = {}; }

  write(out);
  const bytes = fs.statSync(path.join(DATA_DIR, `${dateStr}.json`)).size;
  console.log(`[data-builder] done: ${nFetch} API calls -> data/${dateStr}.json (${(bytes / 1024).toFixed(0)} KB)`);
}

function write(out) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(path.join(DATA_DIR, `${out.date}.json`), JSON.stringify(out));
}

if (require.main === module) {
  main().catch((e) => { console.error('[data-builder] fatal:', e); process.exit(1); });
}
module.exports = { slimPbp, slimPlayer, slimStandings, starterFor };
