/* ============================================================================
NHL GOAL MODEL — anytime-goal probability engine (static client version)
----------------------------------------------------------------------------
MODEL FORMULA (see MODEL.md for the full write-up):

  Inputs per skater (season to date):
    GP        games played
    G         goals
    SHOTS     shots on goal
    TOI_MIN   average time on ice, minutes
    PPG       power-play goals
    HD_SHARE  share of the skater's shot attempts from the high-danger zone
              (slot / home-plate circle around the net, from play-by-play x/y)
    OPP_SV    opposing goalie's season save percentage

  Step 1 — base expected goals (form blended with volume):
    gpg       = G / GP
    sogpg     = SHOTS / GP
    lam_base  = 0.6 * gpg + 0.4 * (sogpg * 0.105)
              (0.105 = league-average shooting percentage; scoring form is
               weighted first, shot volume second)

  Step 2 — multiplicative adjustments, each clamped:
    m_toi   = clamp(0.6 + 0.4 * (TOI_MIN / 20), 0.7, 1.3)
    m_pp    = 1 + clamp((PPG / GP) * 2, 0, 0.35)
    m_goal  = clamp((1 - OPP_SV) / 0.10, 0.7, 1.4)      # vs .900 baseline
    m_zone  = 1 + clamp((HD_SHARE - 0.30) * 1.2, -0.25, 0.35)

  Step 3 — calibration dampening (low end must not run hot):
    lam     = lam_base * m_toi * m_pp * m_goal * m_zone
    lam    *= 0.88                                          # global factor
    if (lam < 1/6) lam *= 0.85      # extra tail dampening below the +500 line

  Step 4 — Poisson anytime-goal probability:
    p = 1 - exp(-lam)

  Fair American odds from p:
    p >= 0.5  ->  -round(100 * p / (1 - p))
    p <  0.5  ->  +round(100 * (1 - p) / p)

  High-danger definition (normalized attacking coordinates, net at x=89):
    x <= 89 AND sqrt((89 - x)^2 + y^2) < 30   (30-ft circle around the net)

  Longshot = fair odds of +500 or longer  <=>  p <= 1/6.
============================================================================ */

'use strict';

// API access: the NHL API does not send CORS headers, so browsers block direct
// cross-origin fetch(). The site therefore talks to a same-origin proxy path.
// On Netlify the included netlify.toml rewrites /nhl-api/* to the NHL API.
// Override with ?api= for local dev, e.g. ?api=https://api-web.nhle.com/v1
// (only useful where CORS is not enforced, e.g. Node tests).
const API = (() => {
  try {
    const q = new URLSearchParams(window.location.search).get('api');
    if (q) return q.replace(/\/$/, '');
  } catch (e) { /* non-browser (tests) */ }
  if (typeof window !== 'undefined' && window.__NHL_API_BASE__) return window.__NHL_API_BASE__;
  return '/nhl-api';
})();
const NHL_DIRECT = 'https://api-web.nhle.com/v1';
const SEASON = '20262027';
const LEAGUE_SH_PCT = 0.105;
const CALIBRATION = 0.88;
const TAIL_DAMP = 0.85;
const LONGSHOT_P = 1 / 6;
const HD_NEUTRAL = 0.30;
const MIN_ZONE_ATTEMPTS = 5;

const state = {
  date: '2026-10-14',
  games: [],          // {id, away, home, awayId, homeId, state, startUTC, pbp}
  skaters: [],        // computed model rows
  playerCache: new Map(),
  view: 'anytime',
  sortBy: 'prob',
  teamFilter: '',
  refreshTimer: null,
  parlay: [],         // {key, name, team, label, prob, fair}
};

/* ---------------- utils ---------------- */
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const headshotUrl = (team, pid) => `https://assets.nhle.com/mugs/nhl/${SEASON}/${team}/${pid}.png`;
const teamLogoUrl = (abbr) => `https://assets.nhle.com/logos/nhl/svg/${abbr}_light.svg`;
const imgFallback = `onerror="this.style.display='none'"`;

async function fetchJSON(url) {
  const r = await fetch(url, { headers: { 'Accept': 'application/json' } });
  if (!r.ok) throw new Error(`NHL API ${r.status} for ${url}`);
  return r.json();
}

// run fn over items with at most n in flight
async function limitedMap(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      try { out[idx] = await fn(items[idx], idx); }
      catch (e) { out[idx] = null; }
    }
  }
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
  return out;
}

function parseToi(t) { // "21:55" -> minutes
  if (!t || typeof t !== 'string') return 0;
  const [m, s] = t.split(':').map(Number);
  return (m || 0) + (s || 0) / 60;
}
function fmtToi(min) {
  const m = Math.floor(min), s = Math.round((min - m) * 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}
const pct1 = (p) => (p * 100).toFixed(1) + '%';
function fairOdds(p) {
  if (p >= 0.5) return '−' + Math.round(100 * p / (1 - p));
  return '+' + Math.round(100 * (1 - p) / p);
}

/* ---------------- model ---------------- */
function computeProb(s, hdShare, oppSv) {
  const gp = Math.max(s.gp, 1);
  const gpg = s.goals / gp;
  const sogpg = s.shots / gp;
  const lamBase = 0.6 * gpg + 0.4 * (sogpg * LEAGUE_SH_PCT);
  const mToi = clamp(0.6 + 0.4 * (s.toiMin / 20), 0.7, 1.3);
  const mPp = 1 + clamp((s.ppg / gp) * 2, 0, 0.35);
  const mGoal = clamp((1 - oppSv) / 0.10, 0.7, 1.4);
  const mZone = 1 + clamp((hdShare - HD_NEUTRAL) * 1.2, -0.25, 0.35);
  let lam = lamBase * mToi * mPp * mGoal * mZone;
  lam *= CALIBRATION;
  if (lam < LONGSHOT_P) lam *= TAIL_DAMP;
  const p = 1 - Math.exp(-lam);
  return {
    p, lam,
    factors: [
      { label: 'Scoring form', value: `${s.goals} G / ${s.gp} GP`, mult: null },
      { label: 'Shot volume', value: `${sogpg.toFixed(1)} SOG/game`, mult: null },
      { label: 'Ice time', value: `${fmtToi(s.toiMin)} avg`, mult: mToi },
      { label: 'Power play', value: `${s.ppg} PPG`, mult: mPp },
      { label: 'Opponent goalie', value: `${(oppSv * 100).toFixed(1)}% SV`, mult: mGoal },
      { label: 'Zone score', value: `${Math.round(hdShare * 100)} HD share`, mult: mZone },
    ],
  };
}

/* ---------------- markets: shots / assists / points over-under ----------------
   Each skater gets a Poisson rate per market:
     shots   λ = shots on goal per game
     assists λ = assists per game
     points  λ = points (goals + assists) per game
   P(over n.5) = 1 − Σ_{k=0}^{n} e^(−λ) λ^k / k!
   Fair American odds come from the same fairOdds() as anytime goals.
   No calibration history or learned multipliers here — raw rates only.
------------------------------------------------------------------------------ */
const MARKET_LINES = {
  shots: [1.5, 2.5, 3.5],
  assists: [0.5, 1.5, 2.5, 3.5],
  points: [0.5, 1.5, 2.5],
};
const MARKET_META = {
  shots: { label: 'Shots on goal', short: 'SOG', unit: 'SOG', rateKey: 'sogpg', last5Key: 'shots' },
  assists: { label: 'Assists', short: 'AST', unit: 'A', rateKey: 'apg', last5Key: 'assists' },
  points: { label: 'Points', short: 'PTS', unit: 'P', rateKey: 'ptspg', last5Key: 'points' },
};

function fact(n) { let f = 1; for (let i = 2; i <= n; i++) f *= i; return f; }
function poissonPmf(k, lam) {
  if (lam <= 0) return k === 0 ? 1 : 0;
  return Math.exp(-lam) * Math.pow(lam, k) / fact(k);
}
// P(X > n.5) = P(X >= n+1) = 1 − Σ_{k=0}^{n} pmf(k)
function pOverLine(lam, n) {
  let s = 0;
  for (let k = 0; k <= n; k++) s += poissonPmf(k, lam);
  return clamp(1 - s, 0, 1);
}
function fairOddsSafe(p) {
  if (!(p > 0.0005) || !(p < 0.9995)) return '–';
  return fairOdds(p);
}

function computeMarkets(s) {
  const out = {};
  for (const kind of Object.keys(MARKET_LINES)) {
    const lam = s[MARKET_META[kind].rateKey] || 0;
    out[kind] = MARKET_LINES[kind].map((line) => {
      const over = pOverLine(lam, Math.floor(line));
      return {
        line, lam, over, under: 1 - over,
        overFair: fairOddsSafe(over), underFair: fairOddsSafe(1 - over),
      };
    });
  }
  return out;
}
function marketOver(r, kind, line) {
  const m = (r.markets[kind] || []).find((x) => x.line === line);
  return m ? m.over : 0;
}

/* ---------------- beat/miss snapshots ----------------
   Compact per-line rationale: lean, one-line beat case, one-line miss case,
   grounded in season rate, last-5 hit rate, ice time, and PP involvement. */
function marketSnapshot(r, kind, line, over) {
  const meta = MARKET_META[kind];
  const rate = r[meta.rateKey] || 0;
  const vals = (r.last5 || []).slice(0, 5).map((x) => x[meta.last5Key] || 0);
  const n = vals.length;
  const hitN = vals.filter((v) => v > line).length;
  const last2 = vals.slice(0, 2).reduce((a, b) => a + b, 0);
  const edge = Math.abs(over - 0.5);
  const lean = (edge >= 0.18 ? 'Strong ' : edge >= 0.08 ? '' : 'Slight ') + (over >= 0.5 ? 'OVER' : 'UNDER');

  let beat;
  if (rate >= line + 0.75) beat = `Averaging ${rate.toFixed(1)} ${meta.unit}/g — clears ${line} with room`;
  else if (n >= 4 && hitN >= 3) beat = `Beat ${line} in ${hitN} of last ${n}`;
  else if (kind === 'assists' && (r.ppp || 0) >= 4) beat = `${r.ppp} power-play points — PP time feeds helpers`;
  else if (r.toiMin >= 19) beat = `Heavy minutes (${fmtToi(r.toiMin)} avg) fuel ${meta.unit} volume`;
  else if (last2 > line) beat = `Heating up: ${last2} ${meta.unit} in last 2`;
  else beat = `Ceiling case: ${rate.toFixed(1)} ${meta.unit}/g season rate`;

  let miss;
  if (rate < line) miss = `Averaging ${rate.toFixed(1)} ${meta.unit}/g — sits below the line`;
  else if (n >= 4 && (n - hitN) >= 3) miss = `Missed in ${n - hitN} of last ${n}`;
  else if (r.toiMin < 14) miss = `Limited role (${fmtToi(r.toiMin)} avg) caps ${meta.unit}`;
  else miss = `Cold patch: just ${last2} ${meta.unit} in last 2`;

  return { lean, leanOver: over >= 0.5, beat, miss };
}

/* ---------------- parlay math (fair odds, no-vig) ---------------- */
function americanToDecimal(o) {
  const v = parseFloat(String(o).replace(/−/g, '-').replace('+', ''));
  if (!isFinite(v) || v === 0) return null;
  return v > 0 ? 1 + v / 100 : 1 + 100 / Math.abs(v);
}
function decimalToAmerican(d) {
  if (!isFinite(d) || d <= 1.0001) return '–';
  if (d >= 2) return '+' + Math.round((d - 1) * 100);
  return '−' + Math.round(100 / (d - 1));
}

/* ---------------- shot zones ---------------- */
// Normalize so the shooting team always attacks +x (net at x=89).
function normalizeShot(x, y, shooterTeamId, homeId, homeDefSide) {
  let attackingRight;
  if (shooterTeamId === homeId) attackingRight = (homeDefSide === 'left');
  else attackingRight = (homeDefSide === 'right');
  return { x: attackingRight ? x : -x, y };
}
function isHighDanger(x, y) {
  if (x > 89) return false;
  return Math.hypot(89 - x, y) < 30;
}

function zoneShareFor(shots) {
  // shots: [{x, y}] normalized; returns {share, n, hd}
  const n = shots.length;
  if (n < MIN_ZONE_ATTEMPTS) return { share: HD_NEUTRAL, n, hd: 0, lowSample: true };
  const hd = shots.filter((s) => isHighDanger(s.x, s.y)).length;
  return { share: hd / n, n, hd, lowSample: false };
}

/* ---------------- data loading ---------------- */
async function getPlayer(pid) {
  if (state.playerCache.has(pid)) return state.playerCache.get(pid);
  const d = await fetchJSON(`${API}/player/${pid}/landing`);
  state.playerCache.set(pid, d);
  return d;
}

function skaterSeason(d) {
  const sub = (d.featuredStats && d.featuredStats.regularSeason && d.featuredStats.regularSeason.subSeason) || {};
  let avgToi = '';
  const totals = d.seasonTotals || [];
  for (let i = totals.length - 1; i >= 0; i--) {
    if (totals[i].gameTypeId === 2 && totals[i].season === 20262027 && totals[i].avgToi) {
      avgToi = totals[i].avgToi; break;
    }
  }
  const gp = sub.gamesPlayed || 0;
  if (!gp) return { gp: 0, goals: 0, shots: 0, assists: 0, points: 0, ppg: 0, ppp: 0, toiMin: 12, last5: [], sogpg: 0, apg: 0, ptspg: 0 }; // rookie prior-ish
  const assists = sub.assists || 0;
  const points = sub.points || 0;
  return {
    gp,
    goals: sub.goals || 0,
    shots: sub.shots || 0,
    assists,
    points,
    ppg: sub.powerPlayGoals || 0,
    ppp: sub.powerPlayPoints || 0,
    toiMin: parseToi(avgToi) || 12,
    last5: d.last5Games || [],
    sogpg: (sub.shots || 0) / gp,
    apg: assists / gp,
    ptspg: points / gp,
  };
}

async function recentFinalGameIds(teamAbbrev, beforeDate, maxN) {
  // scan previous 7 days of schedule for completed games involving team
  const ids = [];
  const base = new Date(beforeDate + 'T12:00:00Z');
  for (let back = 1; back <= 7 && ids.length < maxN; back++) {
    const dt = new Date(base.getTime() - back * 86400000);
    const ds = dt.toISOString().slice(0, 10);
    try {
      const sched = await fetchJSON(`${API}/schedule/${ds}`);
      for (const w of (sched.gameWeek || [])) {
        if (w.date !== ds) continue;
        for (const g of (w.games || [])) {
          const st = g.gameState;
          if ((st === 'OFF' || st === 'FINAL') &&
              (g.awayTeam.abbrev === teamAbbrev || g.homeTeam.abbrev === teamAbbrev)) {
            ids.push(g.id);
            if (ids.length >= maxN) break;
          }
        }
      }
    } catch (e) { /* skip bad days */ }
  }
  return ids;
}

function shotsFromPbp(pbp, playerId) {
  // all attempts by playerId with coords, normalized to attacking +x
  const out = [];
  const homeId = pbp.homeTeam.id;
  const homeDefSide = pbp.homeTeamDefendingSide;
  for (const p of (pbp.plays || [])) {
    const k = p.typeDescKey;
    if (k !== 'shot-on-goal' && k !== 'goal' && k !== 'missed-shot' && k !== 'blocked-shot') continue;
    const det = p.details || {};
    if (det.shootingPlayerId !== playerId) continue;
    if (det.xCoord == null || det.yCoord == null) continue;
    const n = normalizeShot(det.xCoord, det.yCoord, det.eventOwnerTeamId, homeId, homeDefSide);
    out.push({ x: n.x, y: n.y, goal: k === 'goal' });
  }
  return out;
}

function goalieForGame(pbp) {
  // find a goalie in net + their name
  let gid = null;
  for (const p of (pbp.plays || [])) {
    const det = p.details || {};
    if (det.goalieInNetId) { gid = det.goalieInNetId; break; }
  }
  const names = {};
  for (const r of (pbp.rosterSpots || [])) {
    names[r.playerId] = `${r.firstName.default} ${r.lastName.default}`;
  }
  return { id: gid, name: gid ? (names[gid] || 'Opposing goalie') : 'Opposing goalie' };
}

async function loadDate(dateStr) {
  showLoading(`Loading ${dateStr}…`);
  hideError();
  state.date = dateStr;
  state.games = [];
  state.skaters = [];

  const sched = await fetchJSON(`${API}/schedule/${dateStr}`);
  const day = (sched.gameWeek || []).find((w) => w.date === dateStr);
  const games = day ? day.games : [];
  if (!games.length) {
    showLoading('');
    renderEmpty('No NHL games scheduled for this date.');
    return;
  }

  // play-by-play per game (null for unstarted)
  const pbps = await limitedMap(games, 4, async (g) => {
    try { return await fetchJSON(`${API}/gamecenter/${g.id}/play-by-play`); }
    catch (e) { return null; }
  });

  // rosters for games without pbp (future games)
  const needRoster = games.filter((g, i) => !pbps[i]);
  const rosterTeams = [...new Set(needRoster.flatMap((g) => [g.awayTeam.abbrev, g.homeTeam.abbrev]))];
  const rosterMap = {};
  await limitedMap(rosterTeams, 4, async (t) => {
    try {
      const r = await fetchJSON(`${API}/roster/${t}/current`);
      rosterMap[t] = [...(r.forwards || []), ...(r.defensemen || [])];
    } catch (e) { rosterMap[t] = []; }
  });

  // zone data: recent finals per team (max 2) + tonight's pbp
  const teams = [...new Set(games.flatMap((g) => [g.awayTeam.abbrev, g.homeTeam.abbrev]))];
  const recentIds = {};
  await limitedMap(teams, 4, async (t) => {
    recentIds[t] = await recentFinalGameIds(t, dateStr, 2);
  });
  const zonePbps = {};
  const allZoneIds = [...new Set(Object.values(recentIds).flat())];
  await limitedMap(allZoneIds, 4, async (id) => {
    try { zonePbps[id] = await fetchJSON(`${API}/gamecenter/${id}/play-by-play`); }
    catch (e) { /* skip */ }
  });

  // goalie save pct per game
  const goalieSv = {};
  await limitedMap(games, 4, async (g, i) => {
    const pbp = pbps[i];
    if (!pbp) return;
    const { id } = goalieForGame(pbp);
    if (!id) return;
    try {
      const gl = await fetchJSON(`${API}/player/${id}/landing`);
      const sub = gl.featuredStats?.regularSeason?.subSeason || {};
      goalieSv[g.id] = sub.savePctg || 0.900;
    } catch (e) { goalieSv[g.id] = 0.900; }
  });

  // build skater list
  const skaterDefs = []; // {pid, name, pos, team, gameId, headshot}
  games.forEach((g, i) => {
    const pbp = pbps[i];
    if (pbp && pbp.rosterSpots) {
      for (const r of pbp.rosterSpots) {
        if (r.positionCode === 'G') continue;
        const teamAb = r.teamId === pbp.homeTeam.id ? pbp.homeTeam.abbrev : pbp.awayTeam.abbrev;
        skaterDefs.push({
          pid: r.playerId,
          name: `${r.firstName.default} ${r.lastName.default}`,
          pos: r.positionCode, team: teamAb, gameId: g.id,
          headshot: r.headshot || headshotUrl(teamAb, r.playerId),
          lineup: 'confirmed', // dressed: in the official game roster
        });
      }
    } else {
      for (const t of [g.awayTeam.abbrev, g.homeTeam.abbrev]) {
        for (const r of (rosterMap[t] || [])) {
          skaterDefs.push({
            pid: r.id,
            name: `${r.firstName.default} ${r.lastName.default}`,
            pos: r.positionCode, team: t, gameId: g.id,
            headshot: r.headshot || headshotUrl(t, r.id),
            lineup: 'projected', // game not started: from team roster, not confirmed dressed
          });
        }
      }
    }
  });
  // de-dupe (a player could appear twice only if traded mid-day; keep first)
  const seen = new Set();
  const defs = skaterDefs.filter((d) => {
    const k = d.pid + ':' + d.gameId;
    if (seen.has(k)) return false;
    seen.add(k); return true;
  });

  // season stats per skater (cached)
  const landings = await limitedMap(defs, 4, async (d) => {
    try { return await getPlayer(d.pid); } catch (e) { return null; }
  });

  // zone shots per skater: tonight's pbp + recent finals for their team
  const zoneByPid = {};
  defs.forEach((d) => { zoneByPid[d.pid + ':' + d.gameId] = []; });
  const pushZone = (pbp, onlyPid) => {
    if (!pbp) return;
    for (const d of defs) {
      if (onlyPid && d.pid !== onlyPid) continue;
      const key = d.pid + ':' + d.gameId;
      if (!zoneByPid[key]) continue;
      const shots = shotsFromPbp(pbp, d.pid);
      // only count shots where the shooter's team matches (avoid traded-player noise)
      zoneByPid[key].push(...shots);
    }
  };
  games.forEach((g, i) => { if (pbps[i]) pushZone(pbps[i]); });
  for (const [team, ids] of Object.entries(recentIds)) {
    for (const id of ids) {
      if (zonePbps[id]) pushZone(zonePbps[id]);
    }
  }

  // compute model rows
  state.skaters = defs.map((d, i) => {
    const land = landings[i];
    const s = land ? skaterSeason(land) : { gp: 0, goals: 0, shots: 0, assists: 0, points: 0, ppg: 0, ppp: 0, toiMin: 12, last5: [], sogpg: 0, apg: 0, ptspg: 0 };
    const z = zoneShareFor(zoneByPid[d.pid + ':' + d.gameId] || []);
    const g = games.find((gg) => gg.id === d.gameId);
    const oppAbbr = (d.team === g.awayTeam.abbrev) ? g.homeTeam.abbrev : g.awayTeam.abbrev;
    const oppSv = goalieSv[d.gameId] || 0.900;
    const m = computeProb(s, z.share, oppSv);
    return {
      ...d, ...s, zone: z, oppSv, oppAbbr,
      p: m.p, lam: m.lam, factors: m.factors,
      fair: fairOdds(m.p),
      isLongshot: m.p <= LONGSHOT_P,
      markets: computeMarkets(s),
      shots: zoneByPid[d.pid + ':' + d.gameId] || [],
    };
  });

  /* ---------------- line estimates ----------------
     The NHL API exposes no official line combinations, so lines are
     ESTIMATED: forwards on each team+game are ranked by average TOI —
     top 3 ≈ L1, next 3 ≈ L2, next 3 ≈ L3, rest ≈ L4. Always labeled
     "est." — never presented as confirmed. */
  const FWD_POS = new Set(['C', 'L', 'R']);
  const fwdsByTeamGame = {};
  for (const r of state.skaters) {
    if (!FWD_POS.has(r.pos)) continue;
    const k = r.team + ':' + r.gameId;
    (fwdsByTeamGame[k] = fwdsByTeamGame[k] || []).push(r);
  }
  for (const k of Object.keys(fwdsByTeamGame)) {
    fwdsByTeamGame[k].sort((a, b) => b.toiMin - a.toiMin);
    fwdsByTeamGame[k].forEach((r, i) => {
      r.line = 'L' + Math.min(4, Math.floor(i / 3) + 1);
      r.lineEst = true;
    });
  }

  state.games = games.map((g, i) => ({
    id: g.id,
    away: g.awayTeam.abbrev, home: g.homeTeam.abbrev,
    state: g.gameState, startUTC: g.startTimeUTC,
    pbp: pbps[i],
  }));

  showLoading('');
  populateTeamFilter();
  renderAll();
}

/* ---------------- rendering ---------------- */
function showLoading(t) {
  const bar = $('loadingBar');
  if (!t) { bar.classList.add('hidden'); return; }
  bar.classList.remove('hidden');
  $('loadingText').textContent = t;
}
function hideError() { $('errorBanner').classList.add('hidden'); }
function showError(msg) {
  const b = $('errorBanner');
  b.innerHTML = esc(msg) + ' <button class="btn" style="margin-left:.5rem" onclick="location.reload()">Retry</button>';
  b.classList.remove('hidden');
}
function renderEmpty(msg) {
  $('gamesGrid').innerHTML = `<p class="muted">${esc(msg)}</p>`;
  $('boardBody').innerHTML = '';
  $('longshotsList').innerHTML = '';
  if ($('goalsFeed')) $('goalsFeed').innerHTML = '';
  if ($('anytimeBody')) $('anytimeBody').innerHTML = '';
  if ($('firstgoalBody')) $('firstgoalBody').innerHTML = '';
  if ($('twoplusBody')) $('twoplusBody').innerHTML = '';
  if ($('marketsWrap')) $('marketsWrap').innerHTML = '';
}

function gameStatusText(g) {
  const pbp = g.pbp;
  if (g.state === 'LIVE' || g.state === 'CRIT') {
    if (pbp && pbp.clock) {
      const n = pbp.periodDescriptor ? pbp.periodDescriptor.number : '';
      const label = n > 3 ? (n === 4 ? 'OT' : 'SO') : `P${n}`;
      return `<span class="live-dot">● LIVE</span> ${label} · ${esc(pbp.clock.timeRemaining || '')}`;
    }
    return '<span class="live-dot">● LIVE</span>';
  }
  if (g.state === 'OFF' || g.state === 'FINAL') return 'Final';
  const dt = new Date(g.startUTC);
  return dt.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function scorersHtml(g) {
  if (!g.pbp) return '';
  const names = {};
  for (const r of (g.pbp.rosterSpots || [])) names[r.playerId] = `${r.firstName.default} ${r.lastName.default}`;
  const goals = (g.pbp.plays || []).filter((p) => p.typeDescKey === 'goal');
  if (!goals.length) return '';
  const items = goals.map((p) => {
    const det = p.details || {};
    const who = names[det.scoringPlayerId] || 'Unknown';
    return `${esc(who)} (${p.periodDescriptor.number}, ${esc(p.timeInPeriod)})`;
  });
  return `<details class="scorers"><summary>Goals (${goals.length})</summary>${items.join('<br>')}</details>`;
}

/* ---------------- live goal feed ----------------
   Goal type is derived from the NHL situationCode, a 4-char string:
     [awayGoalie][awaySkaters][homeSkaters][homeGoalie]
   e.g. "1551" = 5v5, "1451" = home 5v4 PP, "0641" = away goalie pulled, 6v4.
   Empty net = the conceding team's goalie is not in net. */
const GOAL_TYPE_LABEL = {
  EV: 'Even strength', PP: 'Power play', SH: 'Shorthanded',
  EN: 'Empty net', SO: 'Shootout', PS: 'Penalty shot',
};

function goalTypeFromSituation(code, scoredByHome, isShootout, isPenaltyShot) {
  if (isPenaltyShot) return 'PS';
  if (isShootout) return 'SO';
  const c = String(code || '');
  if (c.length < 4) return 'EV';
  const awayG = +c[0], awayS = +c[1], homeS = +c[2], homeG = +c[3];
  if (![awayG, awayS, homeS, homeG].every((n) => isFinite(n))) return 'EV';
  const myS = scoredByHome ? homeS : awayS;
  const oppS = scoredByHome ? awayS : homeS;
  const oppG = scoredByHome ? awayG : homeG;
  if (oppG === 0) return 'EN';
  if (myS > oppS) return 'PP';
  if (myS < oppS) return 'SH';
  return 'EV';
}

function extractGoals(pbp, game) {
  if (!pbp) return [];
  const names = {}, shots = {};
  for (const r of (pbp.rosterSpots || [])) {
    names[r.playerId] = `${r.firstName.default} ${r.lastName.default}`;
    if (r.headshot) shots[r.playerId] = r.headshot;
  }
  const homeId = pbp.homeTeam.id, awayId = pbp.awayTeam.id;
  const teamOf = (tid) => (tid === homeId ? pbp.homeTeam.abbrev
    : tid === awayId ? pbp.awayTeam.abbrev : '');
  return (pbp.plays || [])
    .filter((p) => p.typeDescKey === 'goal')
    .map((p) => {
      const det = p.details || {};
      const pd = p.periodDescriptor || {};
      const scoredByHome = det.eventOwnerTeamId === homeId;
      const aids = [det.assist1PlayerId, det.assist2PlayerId].filter(Boolean);
      return {
        scorerId: det.scoringPlayerId,
        scorer: names[det.scoringPlayerId] || 'Unknown',
        headshot: shots[det.scoringPlayerId] || '',
        assists: aids.map((id) => names[id] || 'Unknown'),
        team: teamOf(det.eventOwnerTeamId),
        period: pd.number,
        periodType: pd.periodType,
        time: p.timeInPeriod || '',
        type: goalTypeFromSituation(p.situationCode, scoredByHome, pd.periodType === 'SO', !!det.penaltyShot),
        awayScore: det.awayScore, homeScore: det.homeScore,
        shotType: det.shotType || '',
        order: p.sortOrder || 0,
        gameId: game.id,
      };
    })
    .sort((a, b) => b.order - a.order); // newest first
}

function goalItemHtml(gl) {
  const perLabel = gl.periodType === 'OT' ? 'OT' : gl.periodType === 'SO' ? 'SO' : `P${gl.period}`;
  const assists = gl.assists.length
    ? `<div class="goal-assists muted small">${gl.assists.map(esc).join(', ')}</div>` : '';
  const inModel = state.skaters.some((s) =>
    String(s.pid) === String(gl.scorerId) && String(s.gameId) === String(gl.gameId));
  const nameHtml = inModel
    ? `<button class="pname" data-pid="${gl.scorerId}" data-gid="${gl.gameId}">${esc(gl.scorer)}</button>`
    : `<span class="pname-static">${esc(gl.scorer)}</span>`;
  const hs = gl.headshot ? esc(gl.headshot) : headshotUrl(gl.team, gl.scorerId);
  return `<div class="goal-item">
    <img class="headshot" src="${hs}" alt="" ${imgFallback}>
    <div class="goal-info">
      <div>${nameHtml}${assists}</div>
      <div class="goal-meta muted small">${esc(gl.team)} · ${perLabel} ${esc(gl.time)}${gl.shotType ? ' · ' + esc(gl.shotType) : ''}</div>
    </div>
    <div class="goal-right">
      <span class="gtype gtype-${gl.type.toLowerCase()}">${GOAL_TYPE_LABEL[gl.type] || gl.type}</span>
      <div class="goal-score num">${gl.awayScore}–${gl.homeScore}</div>
    </div>
  </div>`;
}

function renderGoals() {
  const feed = $('goalsFeed');
  if (!feed) return;
  const blocks = state.games
    .map((g) => ({ g, goals: extractGoals(g.pbp, g) }))
    .filter((b) => b.g.pbp);
  if (!blocks.length) {
    feed.innerHTML = '<p class="muted">No game data yet — check back once games start.</p>';
    return;
  }
  feed.innerHTML = blocks.map(({ g, goals }) => {
    const pbp = g.pbp;
    const items = goals.length
      ? goals.map(goalItemHtml).join('')
      : '<p class="muted small goal-none">No goals yet.</p>';
    return `<div class="goal-game game-card">
      <div class="matchup">
        <span class="team"><img src="${teamLogoUrl(g.away)}" alt="" ${imgFallback}>${esc(g.away)}</span>
        <span class="score-line goal-final">${pbp.awayTeam.score}–${pbp.homeTeam.score}</span>
        <span class="team"><img src="${teamLogoUrl(g.home)}" alt="" ${imgFallback}>${esc(g.home)}</span>
      </div>
      <div class="game-meta"><span>${gameStatusText(g)}</span><span>${goals.length} goal${goals.length === 1 ? '' : 's'}</span></div>
      <div class="goal-list">${items}</div>
    </div>`;
  }).join('');
  feed.querySelectorAll('.pname').forEach((b) =>
    b.addEventListener('click', () => openPlayer(b.dataset.pid, b.dataset.gid)));
}

/* ---------------- first-goal & 2+ goals views ----------------
   First goal: competing scoring rates within a matchup —
     P(first goal by i) = λ_i / Σ_j λ_j   (all skaters in that game)
   2+ goals: from the Poisson goal rate —
     P(2+) = 1 − e^(−λ) − λ·e^(−λ) */
function firstGoalProbs() {
  const sumByGame = {};
  for (const r of state.skaters) {
    sumByGame[r.gameId] = (sumByGame[r.gameId] || 0) + Math.max(r.lam, 0);
  }
  return state.skaters.map((r) => {
    const denom = sumByGame[r.gameId] || 1;
    const p = denom > 0 ? Math.max(r.lam, 0) / denom : 0;
    return { ...r, fgP: p, fgFair: fairOddsSafe(p) };
  }).sort((a, b) => b.fgP - a.fgP);
}

function twoPlusProbs() {
  return state.skaters.map((r) => {
    const lam = Math.max(r.lam, 0);
    const p = 1 - Math.exp(-lam) * (1 + lam);
    return { ...r, tpP: p, tpFair: fairOddsSafe(p) };
  }).sort((a, b) => b.tpP - a.tpP);
}

function probTableHtml(rows, pKey, fairKey) {
  return rows.map((r) => `
    <tr>
      <td><button class="pname" data-pid="${r.pid}" data-gid="${r.gameId}">${esc(r.name)}</button></td>
      <td><span class="team-cell"><img src="${teamLogoUrl(r.team)}" alt="" ${imgFallback}>${esc(r.team)}</span></td>
      <td class="num"><strong>${pct1(r[pKey])}</strong></td>
      <td class="num">${r[fairKey]}</td>
    </tr>`).join('');
}
function wirePnameClicks(tbody) {
  tbody.querySelectorAll('.pname').forEach((b) =>
    b.addEventListener('click', () => openPlayer(b.dataset.pid, b.dataset.gid)));
}

function renderFirstGoal() {
  const tb = $('firstgoalBody');
  if (!tb) return;
  tb.innerHTML = probTableHtml(firstGoalProbs(), 'fgP', 'fgFair');
  wirePnameClicks(tb);
}

function renderTwoPlus() {
  const tb = $('twoplusBody');
  if (!tb) return;
  tb.innerHTML = probTableHtml(twoPlusProbs(), 'tpP', 'tpFair');
  wirePnameClicks(tb);
}

/* ---------------- anytime-goals view ---------------- */
function renderAnytime() {
  const tb = $('anytimeBody');
  if (!tb) return;
  const rows = state.skaters.slice().sort((a, b) => b.p - a.p);
  tb.innerHTML = rows.map((r) => `
    <tr>
      <td><button class="pname" data-pid="${r.pid}" data-gid="${r.gameId}">${esc(r.name)}</button></td>
      <td><span class="team-cell"><img src="${teamLogoUrl(r.team)}" alt="" ${imgFallback}>${esc(r.team)}</span></td>
      <td class="num"><strong>${pct1(r.p)}</strong></td>
      <td class="num">${r.fair}</td>
    </tr>`).join('');
  tb.querySelectorAll('.pname').forEach((b) =>
    b.addEventListener('click', () => openPlayer(b.dataset.pid, b.dataset.gid)));
}

function renderSlate() {
  const grid = $('gamesGrid');
  const d = new Date(state.date + 'T12:00:00');
  $('slateTitle').textContent = 'Slate — ' + d.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' });
  grid.innerHTML = state.games.map((g) => {
    const pbp = g.pbp;
    const as = pbp ? pbp.awayTeam.score : 0;
    const hs = pbp ? pbp.homeTeam.score : 0;
    const asog = pbp ? pbp.awayTeam.sog : '–';
    const hsog = pbp ? pbp.homeTeam.sog : '–';
    return `<div class="game-card">
      <div class="matchup">
        <span class="team"><img src="${teamLogoUrl(g.away)}" alt="" ${imgFallback}>${esc(g.away)}</span>
        <span class="muted">@</span>
        <span class="team"><img src="${teamLogoUrl(g.home)}" alt="" ${imgFallback}>${esc(g.home)}</span>
      </div>
      <div class="score-line"><span>${as}</span><span>${hs}</span></div>
      <div class="game-meta"><span>${gameStatusText(g)}</span><span>SOG ${asog}–${hsog}</span></div>
      ${scorersHtml(g)}
    </div>`;
  }).join('');
  const ud = $('utilDate');
  if (ud) ud.textContent = d.toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' });
  const ug = $('utilGames');
  if (ug) ug.textContent = state.games.length + (state.games.length === 1 ? ' game' : ' games');
}

function sortedSkaters() {
  let rows = state.skaters.slice();
  if (state.teamFilter) rows = rows.filter((r) => r.team === state.teamFilter);
  const by = state.sortBy;
  rows.sort((a, b) => by === 'name' ? a.name.localeCompare(b.name)
    : by === 'team' ? (a.team + a.name).localeCompare(b.team + b.name)
    : by === 'zone' ? b.zone.share - a.zone.share
    : b.p - a.p);
  return rows;
}

function renderBoard() {
  const tb = $('boardBody');
  tb.innerHTML = sortedSkaters().map((r) => `
    <tr>
      <td><button class="pname" data-pid="${r.pid}" data-gid="${r.gameId}">${esc(r.name)}</button>
        <div class="prob-bar"><i style="width:${Math.min(100, r.p * 100 * 2.5)}%"></i></div></td>
      <td><span class="team-cell"><img src="${teamLogoUrl(r.team)}" alt="" ${imgFallback}>${esc(r.team)}</span></td>
      <td>${esc(r.pos)}</td>
      <td class="num"><strong>${pct1(r.p)}</strong></td>
      <td class="num">${r.fair}</td>
      <td class="num">${(r.goals / Math.max(r.gp, 1)).toFixed(2)}</td>
      <td class="num">${r.gp ? r.sogpg.toFixed(1) : '–'}</td>
      <td class="num">${fmtToi(r.toiMin)}</td>
      <td class="num">${Math.round(r.zone.share * 100)}${r.zone.lowSample ? '*' : ''}</td>
    </tr>`).join('');
  tb.querySelectorAll('.pname').forEach((b) =>
    b.addEventListener('click', () => openPlayer(b.dataset.pid, b.dataset.gid)));
}

function renderLongshots() {
  const ls = state.skaters.filter((r) => r.isLongshot).sort((a, b) => b.p - a.p);
  const el = $('longshotsList');
  if (!ls.length) { el.innerHTML = '<p class="muted">No longshots on this slate.</p>'; return; }
  el.innerHTML = ls.map((r) => `
    <div class="ls-card">
      <img class="headshot" src="${esc(r.headshot)}" alt="" ${imgFallback}>
      <div class="ls-info">
        <button class="pname" data-pid="${r.pid}" data-gid="${r.gameId}">${esc(r.name)}</button>
        <div class="ls-stats">${esc(r.team)} · ${esc(r.pos)} · ${pct1(r.p)} model · ${r.goals}G/${r.gp}GP</div>
      </div>
      <div class="ls-odds"><div class="fair">${r.fair}</div><div class="ls-stats">fair</div></div>
    </div>`).join('');
  el.querySelectorAll('.pname').forEach((b) =>
    b.addEventListener('click', () => openPlayer(b.dataset.pid, b.dataset.gid)));
}

/* ---------------- markets view ---------------- */
const MARKET_HEADLINE = { shots: 2.5, assists: 0.5, points: 1.5 };

function renderMarkets() {
  const wrap = $('marketsWrap');
  if (!wrap) return;
  let rows = state.skaters.slice();
  if (state.teamFilter) rows = rows.filter((r) => r.team === state.teamFilter);
  wrap.innerHTML = ['shots', 'assists', 'points'].map((kind) => {
    const meta = MARKET_META[kind];
    const sorted = rows.slice()
      .sort((a, b) => marketOver(b, kind, MARKET_HEADLINE[kind]) - marketOver(a, kind, MARKET_HEADLINE[kind]))
      .slice(0, 80);
    const body = sorted.map((r) => `
      <tr>
        <td><button class="pname" data-pid="${r.pid}" data-gid="${r.gameId}">${esc(r.name)}</button></td>
        <td><span class="team-cell"><img src="${teamLogoUrl(r.team)}" alt="" ${imgFallback}>${esc(r.team)}</span></td>
        ${r.markets[kind].map((m) => `
          <td class="num"><strong>${pct1(m.over)}</strong><div class="small muted">${m.overFair}</div></td>`).join('')}
      </tr>`).join('');
    return `<h3 class="mkt-title">${meta.label} <span class="muted small">over / under · Poisson λ from ${meta.short}/game</span></h3>
      <div class="table-wrap"><table><thead><tr><th>Skater</th><th>Team</th>
      ${MARKET_LINES[kind].map((l) => `<th class="num">o${l}</th>`).join('')}</tr></thead>
      <tbody>${body || `<tr><td colspan="${2 + MARKET_LINES[kind].length}" class="muted">No skaters.</td></tr>`}</tbody></table></div>`;
  }).join('');
  wrap.querySelectorAll('.pname').forEach((b) =>
    b.addEventListener('click', () => openPlayer(b.dataset.pid, b.dataset.gid)));
}

/* ---------------- parlay builder ---------------- */
function addParlayLeg(r, v) {
  let leg;
  if (v === 'atg') {
    if (!(r.p > 0.0005)) return;
    leg = { key: `${r.pid}:atg`, name: r.name, team: r.team, label: 'Anytime goal', prob: r.p, fair: r.fair };
  } else {
    const [kind, lineStr] = String(v).split('|');
    const line = parseFloat(lineStr);
    const m = (r.markets[kind] || []).find((x) => x.line === line);
    if (!m || !(m.over > 0.0005) || m.overFair === '–') return;
    leg = { key: `${r.pid}:${kind}:${line}`, name: r.name, team: r.team, label: `${MARKET_META[kind].label} o${line}`, prob: m.over, fair: m.overFair };
  }
  if (!state.parlay.some((l) => l.key === leg.key)) state.parlay.push(leg);
  closePlayer();
  setView('parlay');
  renderParlay();
}

function renderParlay() {
  const el = $('parlayLegs');
  if (!el) return;
  if (!state.parlay.length) {
    el.innerHTML = '<p class="muted">No legs yet — open any player card and use the parlay dropdown to add one.</p>';
  } else {
    el.innerHTML = state.parlay.map((l, i) => `
      <div class="parlay-leg">
        <div><strong>${esc(l.name)}</strong> <span class="muted">${esc(l.team)} · ${esc(l.label)}</span></div>
        <div class="num">${pct1(l.prob)} <span class="muted">(${esc(l.fair)})</span><button class="linklike" data-i="${i}" aria-label="Remove leg">✕</button></div>
      </div>`).join('');
    el.querySelectorAll('.linklike').forEach((b) => b.addEventListener('click', () => {
      state.parlay.splice(+b.dataset.i, 1);
      renderParlay();
    }));
  }
  renderParlayTotals();
}

function renderParlayTotals() {
  const box = $('parlayTotals');
  if (!box) return;
  const stake = Math.max(0, parseFloat(($('parlayStake') || {}).value) || 0);
  const decs = state.parlay.map((l) => americanToDecimal(l.fair)).filter((d) => d && d > 1);
  if (!state.parlay.length || decs.length !== state.parlay.length || !stake) {
    box.innerHTML = '<p class="muted small">Add legs and a stake to see the math.</p>';
    return;
  }
  const dec = decs.reduce((a, b) => a * b, 1);
  const joint = state.parlay.reduce((a, l) => a * l.prob, 1);
  box.innerHTML = `
    <div class="totals-grid">
      <div><div class="t-label">Combined odds</div><div class="t-val">${decimalToAmerican(dec)}</div></div>
      <div><div class="t-label">Payout</div><div class="t-val">$${(stake * dec).toFixed(2)}</div></div>
      <div><div class="t-label">Profit</div><div class="t-val">$${(stake * (dec - 1)).toFixed(2)}</div></div>
      <div><div class="t-label">Implied prob</div><div class="t-val">${pct1(1 / dec)}</div></div>
      <div><div class="t-label">Model hit rate</div><div class="t-val">${pct1(joint)}</div></div>
    </div>
    <p class="muted small">Same-game legs are correlated — books may restrict or shade these, and the joint model rate assumes independence. Fair (no-vig) odds. Not betting advice.</p>`;
}

function populateTeamFilter() {
  const sel = $('teamFilter');
  const teams = [...new Set(state.skaters.map((r) => r.team))].sort();
  const opts = '<option value="">All teams</option>' +
    teams.map((t) => `<option value="${t}">${t}</option>`).join('');
  sel.innerHTML = opts;
  const mkt = $('mktTeamFilter');
  if (mkt) mkt.innerHTML = opts;
  state.teamFilter = '';
}
function applyTeamFilter(v) {
  state.teamFilter = v;
  if ($('teamFilter')) $('teamFilter').value = v;
  if ($('mktTeamFilter')) $('mktTeamFilter').value = v;
  renderBoard();
  renderMarkets();
}

/* ---------------- player card ---------------- */
function drawRink(canvas, shots, teamColor) {
  const W = 420, H = 400;
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d');
  // map normalized coords: x in [0,100] -> px, y in [-42.5,42.5] -> py
  const X = (x) => 20 + (x / 100) * (W - 40);
  const Y = (y) => 20 + ((y + 42.5) / 85) * (H - 40);
  ctx.fillStyle = '#f4f6f8'; ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = '#c33'; ctx.lineWidth = 2;
  // rink outline (offensive half)
  ctx.strokeRect(X(0), Y(-42.5), X(100) - X(0), Y(42.5) - Y(-42.5));
  // goal line + net
  ctx.beginPath(); ctx.moveTo(X(89), Y(-6)); ctx.lineTo(X(89), Y(6)); ctx.stroke();
  ctx.strokeStyle = '#999';
  // blue line
  ctx.beginPath(); ctx.moveTo(X(25), Y(-42.5)); ctx.lineTo(X(25), Y(42.5)); ctx.stroke();
  // faceoff circles
  for (const fy of [-22, 22]) {
    ctx.beginPath(); ctx.arc(X(69), Y(fy), 15, 0, Math.PI * 2); ctx.stroke();
  }
  // high-danger circle
  ctx.save();
  ctx.strokeStyle = '#e8a13d'; ctx.setLineDash([6, 4]); ctx.lineWidth = 2;
  ctx.beginPath(); ctx.arc(X(89), Y(0), (30 / 100) * (W - 40), 0, Math.PI * 2); ctx.stroke();
  ctx.restore();
  // shots
  for (const s of shots) {
    const px = X(Math.max(0, Math.min(100, s.x)));
    const py = Y(Math.max(-42.5, Math.min(42.5, s.y)));
    ctx.beginPath();
    ctx.arc(px, py, s.goal ? 7 : 4.5, 0, Math.PI * 2);
    ctx.fillStyle = s.goal ? '#d4a017' : teamColor;
    ctx.globalAlpha = s.goal ? 1 : 0.75;
    ctx.fill();
    if (s.goal) { ctx.lineWidth = 2; ctx.strokeStyle = '#7a5b00'; ctx.stroke(); }
    ctx.globalAlpha = 1;
  }
  if (!shots.length) {
    ctx.fillStyle = '#8b98ab'; ctx.font = '14px sans-serif'; ctx.textAlign = 'center';
    ctx.fillText('No located shots in recent games', W / 2, H / 2);
  }
}

function openPlayer(pid, gameId) {
  const r = state.skaters.find((s) => String(s.pid) === String(pid) && String(s.gameId) === String(gameId));
  if (!r) return;
  const g = state.games.find((gg) => gg.id === r.gameId);
  const l5 = (r.last5 || []).slice(0, 5);
  const l5g = l5.reduce((a, x) => a + (x.goals || 0), 0);
  const l5s = l5.reduce((a, x) => a + (x.shots || 0), 0);
  const factorRows = r.factors.map((f) => `
    <tr><td>${esc(f.label)}</td><td>${esc(f.value)}${f.mult != null ? ` <span class="muted">×${f.mult.toFixed(2)}</span>` : ''}</td></tr>`).join('');

  // markets + beat/miss snapshots
  const marketsHtml = ['shots', 'assists', 'points'].map((kind) => {
    const meta = MARKET_META[kind];
    const rows = r.markets[kind].map((m) => {
      const snap = marketSnapshot(r, kind, m.line, m.over);
      return `<div class="snap">
        <div class="snap-top"><strong>o${m.line}</strong>
          <span>${pct1(m.over)} <span class="muted">(${m.overFair})</span></span>
          <span class="lean ${snap.leanOver ? 'lean-over' : 'lean-under'}">${esc(snap.lean)}</span></div>
        <div class="snap-line"><span class="snap-arrow up">▲</span>${esc(snap.beat)}</div>
        <div class="snap-line"><span class="snap-arrow dn">▼</span>${esc(snap.miss)}</div>
        <div class="snap-under muted small">u${m.line} ${pct1(m.under)} (${m.underFair})</div>
      </div>`;
    }).join('');
    return `<h4 class="mkt-h">${meta.label} <span class="muted small">λ ${r.markets[kind][0].lam.toFixed(2)}/g</span></h4>${rows}`;
  }).join('');

  // parlay leg picker
  const legOpts = [`<option value="atg">Anytime goal — ${pct1(r.p)} (${r.fair})</option>`];
  for (const kind of ['shots', 'assists', 'points']) {
    for (const m of r.markets[kind]) {
      if (m.overFair === '–') continue;
      legOpts.push(`<option value="${kind}|${m.line}">${esc(MARKET_META[kind].label)} o${m.line} — ${pct1(m.over)} (${m.overFair})</option>`);
    }
  }

  // line badge (estimated from TOI rank) + dressed status
  const lineBadge = r.line
    ? `<span class="line-badge" title="Estimated from average ice time — not official">${r.line}<span class="est">est.</span></span>`
    : '';
  const statusPill = r.lineup === 'confirmed'
    ? '<span class="status-pill ok">In lineup</span>'
    : '<span class="status-pill proj">Projected</span>';

  $('modalBody').innerHTML = `
    <div class="pc-head">
      <img class="headshot" src="${esc(r.headshot)}" alt="" ${imgFallback}>
      <div>
        <h3 class="pc-name">${esc(r.name)}</h3>
        <div><img class="tlogo" src="${teamLogoUrl(r.team)}" alt="" ${imgFallback}>
          <span class="muted">${esc(r.team)} · ${esc(r.pos)} · ${g ? esc(g.away + ' @ ' + g.home) : ''}</span></div>
      </div>
      <div style="margin-left:auto;text-align:right">
        <div class="pc-prob">${pct1(r.p)}</div>
        <div class="pc-fair">${r.fair} fair</div>
      </div>
    </div>
    <div class="pc-status">${lineBadge}${statusPill}</div>
    <table class="factor-table">${factorRows}
      <tr><td>Expected goals (λ)</td><td>${r.lam.toFixed(3)}</td></tr>
      <tr><td>Opponent</td><td>${esc(r.oppAbbr)} goalie ${(r.oppSv * 100).toFixed(1)}% SV</td></tr>
    </table>
    <p class="small muted">Season: ${r.goals}G ${r.assists}A ${r.points}P / ${r.gp}GP · Last 5: ${l5g}G, ${l5s} SOG${r.zone.lowSample ? ' · <em>zone share uses league-average (small sample)</em>' : ''}</p>
    <h4 style="margin:.8rem 0 .2rem">Markets <span class="muted small">Poisson over/under</span></h4>
    ${marketsHtml}
    <div class="parlay-add">
      <select id="parlayLegSelect" aria-label="Choose a parlay leg">${legOpts.join('')}</select>
      <button class="btn" id="parlayAddBtn">Add to parlay</button>
    </div>
    <h4 style="margin:.6rem 0 .2rem">Shot map <span class="muted small">recent games, attacking →</span></h4>
    <canvas class="rink" id="rinkCanvas"></canvas>
    <div class="legend"><span><span class="dot" style="background:#2f6fed"></span>attempt</span>
      <span><span class="dot" style="background:#d4a017"></span>goal</span>
      <span><span class="dot" style="border:2px dashed #e8a13d;background:none"></span>high-danger zone</span></div>`;
  $('playerModal').classList.remove('hidden');
  drawRink($('rinkCanvas'), r.shots, '#2f6fed');
  $('parlayAddBtn').addEventListener('click', () => addParlayLeg(r, $('parlayLegSelect').value));
}

function closePlayer() { $('playerModal').classList.add('hidden'); }

/* ---------------- views & refresh ---------------- */
function renderAll() {
  renderSlate();
  renderGoals();
  renderBoard();
  renderAnytime();
  renderFirstGoal();
  renderTwoPlus();
  renderLongshots();
  renderMarkets();
  renderParlay();
  renderSimSetup();
}

async function refreshScores() {
  // light 30s refresh: re-fetch pbp for live games, update slate only
  const live = state.games.filter((g) => g.state === 'LIVE' || g.state === 'CRIT');
  if (!live.length) return;
  for (const g of live) {
    try {
      const pbp = await fetchJSON(`${API}/gamecenter/${g.id}/play-by-play`);
      g.pbp = pbp;
      if (pbp.gameState === 'OFF' || pbp.gameState === 'FINAL') g.state = 'OFF';
    } catch (e) { /* keep old */ }
  }
  if (state.view === 'slate') renderSlate();
  if (state.view === 'goals') renderGoals();
}

function setView(v) {
  state.view = v;
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.view === v));
  document.querySelectorAll('.view').forEach((s) => s.classList.toggle('active', s.id === 'view-' + v));
  $('autoRefreshNote').style.visibility = v === 'slate' ? 'visible' : 'hidden';
}

function startAutoRefresh() {
  if (state.refreshTimer) clearInterval(state.refreshTimer);
  state.refreshTimer = setInterval(() => {
    if (document.hidden) return;
    refreshScores().catch(() => {});
  }, 30000);
}

/* ---------------- sims (Monte Carlo, client-side) ---------------- */
const simState = { scope: 'all' };

// Recover each skater's Poisson goal rate from their anytime-goal probability.
function simLambda(p) {
  if (!(p > 0)) return 0;
  return p >= 0.9999 ? 9 : -Math.log(1 - p);
}

// Knuth's algorithm — exact Poisson draws, fast for the small rates here.
function poissonSample(lam) {
  if (lam <= 0) return 0;
  const L = Math.exp(-lam);
  let k = 0, pr = 1;
  do { k++; pr *= Math.random(); } while (pr > L);
  return k - 1;
}

function teamPool(gameId, team) {
  const pool = [];
  for (const sk of state.skaters) {
    if (sk.gameId !== gameId || sk.team !== team) continue;
    const lam = simLambda(sk.p);
    if (lam > 0) pool.push({ name: sk.name, lam });
  }
  return pool;
}

function pickWeighted(pool, total) {
  if (!pool.length || total <= 0) return { name: '—' };
  let r = Math.random() * total;
  for (const s of pool) { r -= s.lam; if (r <= 0) return s; }
  return pool[pool.length - 1];
}

function randGoalTime() {
  const period = 1 + Math.floor(Math.random() * 3);
  const mm = String(Math.floor(Math.random() * 20)).padStart(2, '0');
  const ss = String(Math.floor(Math.random() * 60)).padStart(2, '0');
  return { period, clock: mm + ':' + ss, ord: period * 3600 + (+mm) * 60 + (+ss) };
}

function simOneGame(g, n) {
  const poolA = teamPool(g.id, g.away);
  const poolB = teamPool(g.id, g.home);
  const lamA = poolA.reduce((s, x) => s + x.lam, 0);
  const lamB = poolB.reduce((s, x) => s + x.lam, 0);
  let sumA = 0, sumB = 0, winA = 0, winB = 0, tie = 0;
  const lines = {};
  let sample = [];
  for (let i = 0; i < n; i++) {
    const a = poissonSample(lamA), b = poissonSample(lamB);
    sumA += a; sumB += b;
    if (a > b) winA++; else if (b > a) winB++; else tie++;
    const k = a + '-' + b;
    lines[k] = (lines[k] || 0) + 1;
    if (i === n - 1) {
      // keep the final sim as the sample box score
      sample = [];
      for (let q = 0; q < a; q++) sample.push({ team: g.away, scorer: pickWeighted(poolA, lamA).name, ...randGoalTime() });
      for (let q = 0; q < b; q++) sample.push({ team: g.home, scorer: pickWeighted(poolB, lamB).name, ...randGoalTime() });
      sample.sort((x, y) => x.ord - y.ord);
    }
  }
  const top = Object.entries(lines).sort((x, y) => y[1] - x[1]).slice(0, 5);
  return { g, n, avgA: sumA / n, avgB: sumB / n, winA: winA / n, winB: winB / n, tie: tie / n, top, sample };
}

const simPct = (x) => (x * 100).toFixed(1) + '%';

function renderSimResults(results) {
  const wrap = $('simResults');
  if (!wrap) return;
  if (!results.length) { wrap.innerHTML = '<p class="muted">No games on this slate.</p>'; return; }
  wrap.innerHTML = results.map((r) => {
    const g = r.g;
    const chips = r.top.map(([sc, c]) =>
      `<span class="score-chip"><strong>${esc(sc)}</strong> ${simPct(c / r.n)}</span>`).join('');
    const box = r.sample.length
      ? `<details class="sim-box"><summary>Sample box score — ${r.sample.length} goal${r.sample.length === 1 ? '' : 's'}</summary>
         <ul>${r.sample.map((gl) =>
           `<li><span class="sim-team">${esc(gl.team)}</span>${esc(gl.scorer)} <span class="muted small">P${gl.period} ${gl.clock}</span></li>`).join('')}</ul>
         </details>`
      : '<p class="muted small goal-none">Sample sim finished scoreless.</p>';
    const prow = (label, v) =>
      `<div class="sim-prow"><span class="sim-plabel">${label}</span><div class="sim-pbar"><i style="width:${(v * 100).toFixed(1)}%"></i></div><span class="num">${simPct(v)}</span></div>`;
    return `<div class="sim-card">
      <div class="sim-matchup">
        <span class="team"><img src="${teamLogoUrl(g.away)}" alt="" ${imgFallback}>${esc(g.away)}</span>
        <span class="muted">@</span>
        <span class="team"><img src="${teamLogoUrl(g.home)}" alt="" ${imgFallback}>${esc(g.home)}</span>
      </div>
      <div class="sim-avg"><span>${r.avgA.toFixed(2)}</span><span class="muted">avg</span><span>${r.avgB.toFixed(2)}</span></div>
      <div class="sim-probs">
        ${prow(esc(g.away), r.winA)}
        ${prow(esc(g.home), r.winB)}
        <div class="sim-prow tie"><span class="sim-plabel">Tie</span><div class="sim-pbar"><i style="width:${(r.tie * 100).toFixed(1)}%"></i></div><span class="num">${simPct(r.tie)}</span></div>
      </div>
      <p class="sim-sub">Most common scorelines</p>
      <div class="score-chips">${chips}</div>
      ${box}
    </div>`;
  }).join('');
}

function renderSimSetup() {
  const sel = $('simGameSelect');
  if (!sel) return;
  sel.innerHTML = state.games.map((g) =>
    `<option value="${g.id}">${esc(g.away)} @ ${esc(g.home)}</option>`).join('');
  const gc = $('simGameCount');
  if (gc) gc.textContent = state.games.length + (state.games.length === 1 ? ' game' : ' games');
  applySimScope();
}

function applySimScope() {
  const one = $('simOneBtn'), all = $('simAllBtn'), sel = $('simGameSelect');
  if (!one || !all || !sel) return;
  one.classList.toggle('active', simState.scope === 'one');
  all.classList.toggle('active', simState.scope === 'all');
  sel.disabled = simState.scope !== 'one';
}

function runSims() {
  const n = parseInt((($('simCountSelect') || {}).value), 10) || 1000;
  const games = simState.scope === 'one'
    ? state.games.filter((g) => String(g.id) === String(($('simGameSelect') || {}).value))
    : state.games.slice();
  const btn = $('simRunBtn');
  if (btn) { btn.disabled = true; btn.textContent = 'Simulating…'; }
  setTimeout(() => {
    try {
      renderSimResults(games.map((g) => simOneGame(g, n)));
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = 'Run simulation'; }
    }
  }, 30);
}

/* ---------------- boot ---------------- */
document.querySelectorAll('.tab').forEach((t) =>
  t.addEventListener('click', () => setView(t.dataset.view)));
$('sortSelect').addEventListener('change', (e) => { state.sortBy = e.target.value; renderBoard(); });
$('teamFilter').addEventListener('change', (e) => applyTeamFilter(e.target.value));
const mktFilter = $('mktTeamFilter');
if (mktFilter) mktFilter.addEventListener('change', (e) => applyTeamFilter(e.target.value));
const stakeInput = $('parlayStake');
if (stakeInput) stakeInput.addEventListener('input', renderParlayTotals);
const simOneBtn = $('simOneBtn'), simAllBtn = $('simAllBtn');
if (simOneBtn) simOneBtn.addEventListener('click', () => { simState.scope = 'one'; applySimScope(); });
if (simAllBtn) simAllBtn.addEventListener('click', () => { simState.scope = 'all'; applySimScope(); });
const simRunBtn = $('simRunBtn');
if (simRunBtn) simRunBtn.addEventListener('click', runSims);
$('refreshBtn').addEventListener('click', () => boot(true));
$('datePicker').addEventListener('change', (e) => boot(true, e.target.value || state.date));
$('modalClose').addEventListener('click', closePlayer);
$('playerModal').addEventListener('click', (e) => { if (e.target.id === 'playerModal') closePlayer(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closePlayer(); });

async function boot(isReload, date) {
  try {
    await loadDate(date || state.date);
    renderAll();
  } catch (err) {
    console.error(err);
    showLoading('');
    showError('Couldn\'t reach the NHL API (' + err.message + '). Check your connection and retry.');
  }
}

startAutoRefresh();
boot(false, $('datePicker').value);
