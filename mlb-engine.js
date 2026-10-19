/* ============================================================================
BUENO MLB ENGINE — shared pure functions (no DOM, no localStorage, no globals)
----------------------------------------------------------------------------
Home-run probability model for the public site's MLB page (mlb.html).

RULES: only add pure functions here (inputs in, outputs out). Never reference
`window`, `document`, `localStorage`, or the app's `state` object. The fetch
helpers below are the only exception — they are thin wrappers over the free,
keyless MLB Stats API (https://statsapi.mlb.com/api/v1/).

v1 model (keep it simple, iterate later):
  - hitter base rate: regressed HR per plate appearance
  - pitcher adjustment: starter's HR/9 vs league average -> multiplier
  - park factor: structure is here, defaults to 1.0 (real park factors later)
  - output: P(home run in this game) via Poisson on expected plate appearances
============================================================================ */

'use strict';

const MLB_API = 'https://statsapi.mlb.com/api/v1';
const MLB_SEASON = 2026;

/* ---------------- team map: abbreviation -> MLBAM team id ---------------- */
const MLB_TEAMS = {
  ARI: 109, ATL: 144, BAL: 110, BOS: 111, CHC: 112, CWS: 145, CIN: 113,
  CLE: 114, COL: 115, DET: 116, HOU: 117, KC: 118, LAA: 108, LAD: 119,
  MIA: 146, MIL: 158, MIN: 142, NYY: 19,  NYM: 121, OAK: 133, ATH: 133,
  PHI: 143, PIT: 134, SD: 135,  SF: 137,  SEA: 136, STL: 138, TB: 139,
  TEX: 140, TOR: 141, WSH: 120,
};

function mlbTeamIds() {
  return { ...MLB_TEAMS };
}

function mlbTeamId(abbr) {
  return MLB_TEAMS[String(abbr || '').toUpperCase()] || null;
}

/* ---------------- league priors (tune as the season fills in) ------------ */
const MLB_LEAGUE_HR_PA = 0.032;   // ~3.2% of plate appearances end in a HR
const MLB_LEAGUE_HR9   = 1.15;    // league-average home runs per 9 innings
const MLB_HITTER_REG_K = 300;     // PA needed for half weight on observed rate
const MLB_PITCHER_REG_K = 90;     // innings needed for half weight on observed HR/9

const mlbClamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

function mlbRegress(obs, n, prior, k) {
  const w = n / (n + k);
  return w * obs + (1 - w) * prior;
}

/* Reverse lookup: MLBAM id -> abbreviation (schedule payload sometimes omits it). */
const MLB_ID_TO_ABBR = {};
for (const [abbr, id] of Object.entries(MLB_TEAMS)) {
  if (!(id in MLB_ID_TO_ABBR)) MLB_ID_TO_ABBR[id] = abbr;
}

/* ---------------- fetch helpers (MLB Stats API, free, keyless) ------------ */
async function mlbFetchJSON(url) {
  const r = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!r.ok) throw new Error('MLB API ' + r.status + ' for ' + url);
  return r.json();
}

/* Schedule for a date: games with teams, records, probable pitchers.
   dateStr: 'YYYY-MM-DD' */
async function fetchMlbSchedule(dateStr) {
  const d = await mlbFetchJSON(`${MLB_API}/schedule?sportId=1&date=${dateStr}`);
  const games = (d.dates && d.dates[0] && d.dates[0].games) || [];
  return games.map((g) => {
    const side = (s) => {
      const t = g.teams[s] || {};
      const pp = t.probablePitcher || null;
      return {
        id: t.team ? t.team.id : null,
        abbr: t.team
          ? (t.team.abbreviation || MLB_ID_TO_ABBR[t.team.id] || null)
          : null,
        name: t.team ? t.team.name : null,
        record: t.leagueRecord ? `${t.leagueRecord.wins}-${t.leagueRecord.losses}` : null,
        probablePitcher: pp ? { id: pp.id, name: pp.fullName } : null,
      };
    };
    return {
      gamePk: g.gamePk,
      date: g.officialDate,
      status: g.status ? g.status.detailedState : null,
      state: g.status ? g.status.abstractGameState : null,
      venue: g.venue ? g.venue.name : null,
      away: side('away'),
      home: side('home'),
    };
  });
}

/* 40-man roster for a team. Returns [] when the API has nothing (offseason). */
async function fetchMlbRoster(teamId) {
  try {
    const d = await mlbFetchJSON(`${MLB_API}/teams/${teamId}/roster`);
    return (d.roster || []).map((p) => ({
      id: p.person.id,
      name: p.person.fullName,
      pos: p.position.abbreviation,
      jersey: p.jerseyNumber || null,
    }));
  } catch (e) {
    return [];
  }
}

/* Season hitting stats for a player. Returns null when unavailable. */
async function fetchHitterStats(playerId, season) {
  try {
    const d = await mlbFetchJSON(
      `${MLB_API}/people/${playerId}/stats?stats=season&season=${season || MLB_SEASON}&group=hitting`
    );
    const splits = (d.stats && d.stats[0] && d.stats[0].splits) || [];
    if (!splits.length) return null;
    const s = splits[0].stat;
    return {
      gp: s.gamesPlayed || 0,
      pa: s.plateAppearances || 0,
      ab: s.atBats || 0,
      hr: s.homeRuns || 0,
      hits: s.hits || 0,
      avg: parseFloat(s.avg) || 0,
      obp: parseFloat(s.obp) || 0,
      slg: parseFloat(s.slg) || 0,
    };
  } catch (e) {
    return null;
  }
}

/* Season pitching stats for a player. Returns null when unavailable. */
async function fetchPitcherStats(playerId, season) {
  try {
    const d = await mlbFetchJSON(
      `${MLB_API}/people/${playerId}/stats?stats=season&season=${season || MLB_SEASON}&group=pitching`
    );
    const splits = (d.stats && d.stats[0] && d.stats[0].splits) || [];
    if (!splits.length) return null;
    const s = splits[0].stat;
    const ipStr = String(s.inningsPitched || '0');
    // MLB reports IP like "162.2" where .1 = 1 out, .2 = 2 outs
    const ipParts = ipStr.split('.');
    const ip = parseInt(ipParts[0], 10) + (parseInt(ipParts[1] || '0', 10) / 3);
    const hr = s.homeRuns || 0;
    return {
      g: s.gamesPitched || 0,
      gs: s.gamesStarted || 0,
      ip,
      hr,
      hr9: ip > 0 ? (hr / ip) * 9 : null,
      era: parseFloat(s.era) || null,
      whip: parseFloat(s.whip) || null,
    };
  } catch (e) {
    return null;
  }
}

/* ---------------- core model ------------------------------------------------
   hitter:  { pa, hr } from fetchHitterStats (null-safe)
   pitcher: { ip, hr9 } from fetchPitcherStats (null-safe)
   parkFactor: 1.0 default; real park factors plug in here later
   orderIdx: 0-based batting order slot (0..8); null/undefined -> neutral 4.2 PA
   Returns { p, lam, factors } where p = P(at least one HR in the game). */
function hrProbability(hitter, pitcher, parkFactor, orderIdx) {
  const pa = (hitter && hitter.pa) || 0;
  const hr = (hitter && hitter.hr) || 0;
  const obsHrPa = pa > 0 ? hr / pa : 0;
  const hrPa = mlbRegress(obsHrPa, pa, MLB_LEAGUE_HR_PA, MLB_HITTER_REG_K);

  // pitcher: HR/9 vs league average -> multiplier on the hitter's rate
  let pitcherMult = 1;
  let pitcherHr9 = null;
  if (pitcher && pitcher.ip > 0) {
    pitcherHr9 = mlbRegress(pitcher.hr9 != null ? pitcher.hr9 : MLB_LEAGUE_HR9,
      pitcher.ip, MLB_LEAGUE_HR9, MLB_PITCHER_REG_K);
    pitcherMult = mlbClamp(pitcherHr9 / MLB_LEAGUE_HR9, 0.6, 1.5);
  }

  const park = parkFactor != null ? parkFactor : 1.0;

  // expected plate appearances: leadoff ~4.5, bottom of order ~3.7
  const expPA = orderIdx != null
    ? mlbClamp(4.5 - 0.09 * orderIdx, 3.4, 4.6)
    : 4.2;

  const lam = hrPa * expPA * pitcherMult * park;
  const p = 1 - Math.exp(-lam);

  return {
    p,
    lam,
    factors: [
      { label: 'HR rate', value: `${(hrPa * 100).toFixed(2)}% HR/PA`, mult: null },
      { label: 'Pitcher HR/9', value: pitcherHr9 != null ? pitcherHr9.toFixed(2) : 'n/a', mult: pitcherMult },
      { label: 'Park', value: park === 1 ? 'neutral' : park.toFixed(2), mult: park },
      { label: 'Exp. PA', value: expPA.toFixed(1), mult: null },
    ],
  };
}

/* American odds from a probability (matches the NHL site's fairOdds). */
function mlbFairOdds(p) {
  if (!(p > 0.0005) || !(p < 0.9995)) return '–';
  if (p >= 0.5) return '−' + Math.round((100 * p) / (1 - p));
  return '+' + Math.round((100 * (1 - p)) / p);
}

/* One-line convenience: price a hitter against a pitcher. */
function priceHitter(hitter, pitcher, parkFactor, orderIdx) {
  const r = hrProbability(hitter, pitcher, parkFactor, orderIdx);
  return { ...r, fair: mlbFairOdds(r.p) };
}
