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

  Longshot = fair odds of +1000 or longer  <=>  p <= 1/11.
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

// --- regression to the mean ---
// Early in the season raw per-game rates are noisy: 2 goals in 2 games reads as
// a 1.00 G/GP scorer. Shrink observed rates toward league-average priors, with
// the weight on the observed rate growing as games accumulate.
// games of prior

const state = {
  date: '2026-10-14',
  games: [],          // {id, away, home, awayId, homeId, state, startUTC, pbp}
  skaters: [],        // computed model rows
  playerCache: new Map(),
  view: 'markets',
  marketKind: 'atg',  // Markets tab: one market at a time — 'atg' | 'twoplus' | 'firstgoal' | 'shots' | 'assists' | 'points'
  goalSearch: '',     // Markets tab player-name search filter
  goalGame: 'all',    // Markets tab game filter ('all' or game id)
  bookOdds: {},       // pid -> raw book-odds input string (Ice Breaker)
  sortBy: 'prob',
  teamFilter: '',
  refreshTimer: null,
  parlay: [],         // {key, name, team, label, prob, fair}
};

/* ---------------- utils ---------------- */
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const headshotUrl = (team, pid) => `https://assets.nhle.com/mugs/nhl/${SEASON}/${team}/${pid}.png`;
const teamLogoUrl = (abbr) => `https://assets.nhle.com/logos/nhl/svg/${abbr}_light.svg`;
const imgFallback = `onerror="this.style.display='none'"`;

// run fn over items with at most n in flight
const pct1 = (p) => (p * 100).toFixed(1) + '%';
function fairOdds(p) {
  if (p >= 0.5) return '−' + Math.round(100 * p / (1 - p));
  return '+' + Math.round(100 * (1 - p) / p);
}

/* ---------------- model ---------------- */

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
// median of Poisson(λ): smallest k with P(X ≤ k) ≥ 0.5
function poissonMedian(lam) {
  if (!(lam > 0)) return 0;
  let s = 0;
  for (let k = 0; k <= Math.ceil(lam) + 10; k++) {
    s += poissonPmf(k, lam);
    if (s >= 0.5) return k;
  }
  return Math.round(lam);
}
function fairOddsSafe(p) {
  if (!(p > 0.0005) || !(p < 0.9995)) return '–';
  return fairOdds(p);
}

function computeMarkets(s, pos) {
  const out = {};
  const pr = priorsFor(pos);
  const priorKey = { shots: 's', assists: 'a', points: 'p' };
  for (const kind of Object.keys(MARKET_LINES)) {
    const rawLam = s[MARKET_META[kind].rateKey] || 0;
    const lam = regress(rawLam, Math.max(s.gp, 1), pr[priorKey[kind]]);
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
function isHighDanger(x, y) {
  if (x > 89) return false;
  return Math.hypot(89 - x, y) < 30;
}

/* ---------------- data loading ---------------- */
/* ---------------- player landing cache ----------------
   Landings are ~25KB each and change at most once a day. Keep a slimmed copy
   in localStorage (date-stamped, per player) so return visits skip ~220
   network fetches. Data cache only — no identifiers, no cross-site use,
   consistent with the site's no-tracking stance. */
const LS_PLAYER_PREFIX = 'bueno-pl-v1-';
const LS_SWEEP_KEY = 'bueno-pl-v1-sweep';
function lsToday() {
  const n = new Date();
  return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, '0')}-${String(n.getDate()).padStart(2, '0')}`;
}
function slimLanding(d) {
  // keep exactly what skaterSeason() and the goalie save-pct lookup consume
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
function unslimLanding(s) {
  return {
    featuredStats: { regularSeason: { subSeason: s.sub || {} } },
    seasonTotals: (s.totals || []).map((t) => ({ gameTypeId: 2, season: t.season, avgToi: t.avgToi })),
    last5Games: s.last5 || [],
  };
}
function lsGetPlayer(pid) {
  try {
    const raw = localStorage.getItem(LS_PLAYER_PREFIX + pid);
    if (!raw) return null;
    const env = JSON.parse(raw);
    if (!env || env.date !== lsToday() || !env.d) return null;
    return unslimLanding(env.d);
  } catch (e) { return null; }
}
function lsSetPlayer(pid, d) {
  try {
    localStorage.setItem(LS_PLAYER_PREFIX + pid, JSON.stringify({ date: lsToday(), d: slimLanding(d) }));
  } catch (e) { /* quota / private mode: skip */ }
}
function lsSweepPlayers() {
  // drop stale-dated entries once per day so old keys can't eat the quota
  try {
    const today = lsToday();
    if (localStorage.getItem(LS_SWEEP_KEY) === today) return;
    const stale = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.indexOf(LS_PLAYER_PREFIX) === 0) {
        let drop = true;
        try {
          const env = JSON.parse(localStorage.getItem(k));
          drop = !env || env.date !== today || !env.d;
        } catch (e) { /* drop */ }
        if (drop) stale.push(k);
      }
    }
    for (const k of stale) localStorage.removeItem(k);
    localStorage.setItem(LS_SWEEP_KEY, today);
  } catch (e) { /* ignore */ }
}
async function getPlayer(pid) {
  if (state.playerCache.has(pid)) return state.playerCache.get(pid);
  const cached = lsGetPlayer(pid);
  if (cached) {
    state.playerCache.set(pid, cached);
    return cached;
  }
  const d = await fetchJSON(`${API}/player/${pid}/landing`);
  state.playerCache.set(pid, d);
  lsSetPlayer(pid, d);
  return d;
}

/* ---------------- precomputed slate bundle ----------------
   data/<date>.json is built 3x daily by data-builder/build.js (see its
   header for the full endpoint catalog). One request replaces ~300.
   The bundle keeps the exact field names the renderers read — slimmed,
   not reshaped — so all downstream code works unchanged. If the bundle
   is missing or stale, we fall back to the live /nhl-api/* proxy. */
async function ctxFromPrecomputed(dateStr) {
  let pre = null;
  try {
    const r = await fetch(`data/${dateStr}.json`, { headers: { 'Accept': 'application/json' } });
    if (!r.ok) return null;
    const d = await r.json();
    if (!d || d.date !== dateStr || !Array.isArray(d.games)) return null;
    pre = d;
  } catch (e) { return null; }
  if (!pre.games.length) return { empty: true };

  // reshape the slim games to the schedule-like shape the shared code reads
  const games = pre.games.map((g) => ({
    id: g.id,
    awayTeam: { abbrev: g.away },
    homeTeam: { abbrev: g.home },
    gameState: g.state,
    startTimeUTC: g.startUTC,
  }));
  const pbps = pre.games.map((g) => pre.pbps[String(g.id)] || null);
  const rosterMap = {};
  for (const [t, r] of Object.entries(pre.rosters || {})) {
    rosterMap[t] = [...(r.forwards || []), ...(r.defensemen || [])];
  }
  const recentIds = pre.recentIds || {};
  const zonePbps = {};
  for (const [id, pbp] of Object.entries(pre.zonePbps || {})) zonePbps[id] = pbp;

  // pre-populate the player cache: bundle players are already in the site's
  // slimLanding() shape, so unslimLanding() restores exactly what
  // skaterSeason() and the goalie lookup consume. getPlayer() then never
  // fetches in bundle mode.
  state.playerCache.clear();
  for (const [pid, slim] of Object.entries(pre.players || {})) {
    try { state.playerCache.set(Number(pid), unslimLanding(slim)); }
    catch (e) { /* skip bad entry */ }
  }
  // standings straight into the cache getStandings() checks
  state.standingsCache = { key: dateStr, map: pre.standings || {} };
  state.zonePbps = zonePbps;
  state.recentIds = recentIds;

  return { games, pbps, rosterMap, recentIds, zonePbps, goalieSv: pre.goalieSv || {} };
}

async function ctxFromLive(dateStr) {
  const sched = await fetchJSON(`${API}/schedule/${dateStr}`);
  const day = (sched.gameWeek || []).find((w) => w.date === dateStr);
  const games = day ? day.games : [];
  if (!games.length) return null;
  lsSweepPlayers(); // drop yesterday's cached landings so they can't eat quota

  // play-by-play per game (null for unstarted)
  const pbps = await limitedMap(games, 4, async (g) => {
    try { return await fetchJSON(`${API}/gamecenter/${g.id}/play-by-play`); }
    catch (e) { return null; }
  });

  // rosters for games without usable pbp rosters (future games return empty rosterSpots)
  // NOTE: /roster/{team}/current 307-redirects to an absolute api-web.nhle.com URL,
  // which escapes the same-origin proxy and dies on CORS. Use the season path directly.
  const needRoster = games.filter((g, i) => !pbps[i] || !(pbps[i].rosterSpots || []).length);
  const rosterTeams = [...new Set(needRoster.flatMap((g) => [g.awayTeam.abbrev, g.homeTeam.abbrev]))];
  const [ry, rm] = dateStr.split('-').map(Number);
  const seasonId = `${rm >= 7 ? ry : ry - 1}${(rm >= 7 ? ry : ry - 1) + 1}`;
  const rosterMap = {};
  await limitedMap(rosterTeams, 4, async (t) => {
    try {
      const r = await fetchJSON(`${API}/roster/${t}/${seasonId}`);
      rosterMap[t] = [...(r.forwards || []), ...(r.defensemen || [])];
    } catch (e) { rosterMap[t] = []; }
  });

  // zone data: recent finals per team (max 1) + tonight's pbp
  const teams = [...new Set(games.flatMap((g) => [g.awayTeam.abbrev, g.homeTeam.abbrev]))];
  const recentByTeam = await recentFinalsByTeam(API, dateStr, 1);
  const recentIds = {};
  for (const t of teams) recentIds[t] = recentByTeam[t] || [];
  const zonePbps = {};
  const allZoneIds = [...new Set(Object.values(recentIds).flat())];
  await limitedMap(allZoneIds, 4, async (id) => {
    try { zonePbps[id] = await fetchJSON(`${API}/gamecenter/${id}/play-by-play`); }
    catch (e) { /* skip */ }
  });
  state.zonePbps = zonePbps;   // recent finals, reused by matchup goalie panels (no refetch)
  state.recentIds = recentIds; // teamAbbrev -> [recent final gameIds]

  // goalie save pct per game
  const goalieSv = {};
  await limitedMap(games, 4, async (g, i) => {
    const pbp = pbps[i];
    if (!pbp) return;
    const { id } = goalieForGame(pbp);
    if (!id) return;
    try {
      const gl = await getPlayer(id);
      const sub = gl.featuredStats?.regularSeason?.subSeason || {};
      goalieSv[g.id] = sub.savePctg || 0.900;
    } catch (e) { goalieSv[g.id] = 0.900; }
  });

  return { games, pbps, rosterMap, recentIds, zonePbps, goalieSv };
}

async function loadDate(dateStr) {
  showLoading(`Loading ${dateStr}…`);
  hideError();
  state.date = dateStr;
  state.games = [];
  state.skaters = [];
  state.goalSearch = '';
  state.goalGame = 'all';
  const gsi = $('goalSearchInput');
  if (gsi) gsi.value = '';

  // Precomputed bundle first (one request); live proxy only as fallback.
  let ctx = await ctxFromPrecomputed(dateStr);
  if (ctx && ctx.empty) {
    showLoading('');
    renderEmpty('No NHL games scheduled for this date.');
    return;
  }
  if (!ctx) ctx = await ctxFromLive(dateStr);
  if (!ctx) {
    showLoading('');
    renderEmpty('No NHL games scheduled for this date.');
    return;
  }
  const { games, pbps, rosterMap, recentIds, zonePbps, goalieSv } = ctx;

  // build skater list
  const skaterDefs = []; // {pid, name, pos, team, gameId, headshot}
  games.forEach((g, i) => {
    const pbp = pbps[i];
    if (pbp && (pbp.rosterSpots || []).length) {
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
    const m = computeProb(s, z.share, oppSv, d.pos);
    return {
      ...d, ...s, zone: z, oppSv, oppAbbr,
      p: m.p, lam: m.lam, factors: m.factors,
      fair: fairOdds(m.p),
      isLongshot: m.p <= LONGSHOT_DISPLAY_P,
      markets: computeMarkets(s, d.pos),
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
  populateGoalGameFilter();
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
  if ($('goalprobsBody')) $('goalprobsBody').innerHTML = '';
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

// Anytime-goal scorer counts for one game: playerId -> goals scored.
// Shootout goals are excluded (periodType 'SO'), matching anytime-goal
// semantics and the Live feed's goal-type logic. No new fetches.
function scorerCounts(game) {
  const counts = {};
  const pbp = game && game.pbp;
  if (!pbp) return counts;
  for (const p of (pbp.plays || [])) {
    if (p.typeDescKey !== 'goal') continue;
    if ((p.periodDescriptor || {}).periodType === 'SO') continue;
    const id = (p.details || {}).scoringPlayerId;
    if (id) counts[id] = (counts[id] || 0) + 1;
  }
  return counts;
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

/* ---------------- first-goal & brace views ----------------
   First goal: competing scoring rates within a matchup —
     P(first goal by i) = λ_i / Σ_j λ_j   (all skaters in that game)
   Brace: from the Poisson goal rate —
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

function pnameBtn(r) {
  const hs = r.headshot || headshotUrl(r.team, r.pid);
  return `<button class="pname" data-pid="${r.pid}" data-gid="${r.gameId}"><img class="pavatar" src="${esc(hs)}" alt="" ${imgFallback}>${esc(r.name)}</button>`;
}
function probTableHtml(rows, pKey, fairKey) {
  return rows.map((r) => `
    <tr>
      <td>${pnameBtn(r)}</td>
      <td><span class="team-cell"><img src="${teamLogoUrl(r.team)}" alt="" ${imgFallback}>${esc(r.team)}</span></td>
      <td class="num"><strong>${pct1(r[pKey])}</strong></td>
      <td class="num">${r[fairKey]}</td>
    </tr>`).join('');
}
function wirePnameClicks(tbody) {
  tbody.querySelectorAll('.pname').forEach((b) =>
    b.addEventListener('click', () => openPlayer(b.dataset.pid, b.dataset.gid)));
}

/* ---------------- ice breaker (first-goal) tool ----------------
   Base: the SAME competing-rates math as the Goals tab first-goal
   view — P(i) = λ_i / Σ_j λ_j within each game. We start from
   firstGoalProbs() itself, so pre-boost numbers match by construction.
   Adjustments (research-backed baselines, clearly labeled):
     +25% weight for estimated L1 skaters — opening-shift starters score
       first ~25–45% more often than their overall rate implies; we use
       the conservative end because our L1–L4 lines are estimated from
       TOI, not official.
     +8% weight for home-team skaters — blends to ~52% home first-goal
       rate per research.
   Renormalized per game, so team shares always sum to 100%. */
const ICE_L1_BOOST = 1.25;
const ICE_HOME_BOOST = 1.08;
function iceBreakerProbs() {
  const base = firstGoalProbs(); // fgP identical to the Goals tab
  const gmap = new Map(state.games.map((g) => [g.id, g]));
  const weighted = base.map((r) => {
    let w = 1;
    if (r.line === 'L1') w *= ICE_L1_BOOST;
    const g = gmap.get(r.gameId);
    if (g && g.home === r.team) w *= ICE_HOME_BOOST;
    return { ...r, ibW: (r.fgP || 0) * w };
  });
  const sumByGame = {};
  for (const r of weighted) sumByGame[r.gameId] = (sumByGame[r.gameId] || 0) + r.ibW;
  return weighted.map((r) => {
    const denom = sumByGame[r.gameId] || 1;
    const p = denom > 0 ? r.ibW / denom : 0;
    return { ...r, ibP: p, ibFair: fairOddsSafe(p) };
  }).sort((a, b) => b.ibP - a.ibP);
}

/* Ice Breaker Score (0–100): one number blending game context and
   league context. raw = boosted first-goal probability × pace factor,
   where pace factor = this game's expected total goals / slate-average
   expected total goals. Game expected goals reuses the sims' own
   convention (sum of simLambda(sk.p) per team — no new data fetched).
   score = 100 × raw / max raw across the slate, so tonight's top pick
   is 100 and everyone else is relative to him. */
function iceBreakerScores(rows) {
  const xgByGame = {};
  let xgSum = 0, xgN = 0;
  for (const g of state.games) {
    let xg = 0;
    for (const sk of state.skaters) {
      if (sk.gameId === g.id) xg += simLambda(sk.p);
    }
    if (xg > 0) { xgByGame[g.id] = xg; xgSum += xg; xgN++; }
  }
  const avg = xgN > 0 ? xgSum / xgN : 0;
  const scored = rows.map((r) => {
    const xg = xgByGame[r.gameId];
    const pace = (xg > 0 && avg > 0) ? xg / avg : 1; // missing λ → neutral
    return { ...r, ibScoreRaw: (r.ibP || 0) * pace };
  });
  let maxRaw = 0;
  for (const r of scored) if (r.ibScoreRaw > maxRaw) maxRaw = r.ibScoreRaw;
  for (const r of scored) r.ibScore = maxRaw > 0 ? Math.round(100 * r.ibScoreRaw / maxRaw) : 0;
  return scored;
}

/* First-goal timing. Stamped winner time for started games comes from
   the pbp already in memory (first non-shootout goal play); expected
   time to first goal for pre-game games is the Poisson waiting time
   60 / total λ from the sims' skater rates (no new data fetched). */
function firstGoalStamp(pbp) {
  if (!pbp) return null;
  const names = {};
  for (const r of (pbp.rosterSpots || [])) {
    names[r.playerId] = `${r.firstName.default} ${r.lastName.default}`;
  }
  for (const p of (pbp.plays || [])) {
    if (p.typeDescKey !== 'goal') continue;
    if ((p.periodDescriptor || {}).periodType === 'SO') continue;
    const det = p.details || {};
    const full = names[det.scoringPlayerId] || '';
    const parts = full.split(' ');
    const short = parts.length > 1 ? `${parts[0][0]}. ${parts.slice(1).join(' ')}` : full;
    return {
      scorer: short || '—',
      time: p.timeInPeriod || '',
      period: (p.periodDescriptor || {}).number || 0,
    };
  }
  return null;
}
function periodOrd(n) {
  if (!n) return '';
  if (n > 3) return 'OT';
  return n + (n === 1 ? 'st' : n === 2 ? 'nd' : 'rd');
}
function fmtFirstGoalStamp(st) {
  const per = periodOrd(st.period);
  return `${st.scorer} — ${st.time}${per ? ' ' + per : ''}`;
}
function expectedFirstGoalMin(gameId) {
  let lam = 0;
  for (const sk of state.skaters) if (sk.gameId === gameId) lam += simLambda(sk.p);
  return lam > 0 ? 60 / lam : null;
}
function fmtExpFirstGoal(min) {
  const s = Math.round(min * 60);
  return `≈ ${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
// American odds -> implied (no-vig) probability; null when unparseable
function impliedProb(raw) {
  const o = parseFloat(String(raw == null ? '' : raw).replace(/[+\s,]/g, ''));
  if (!isFinite(o) || o === 0) return null;
  return o > 0 ? 100 / (o + 100) : (-o) / ((-o) + 100);
}
function iceEdge(p, bookRaw) {
  const imp = impliedProb(bookRaw);
  if (imp == null) return { txt: '—', cls: 'muted' };
  const e = (p - imp) * 100;
  const sign = e > 0 ? '+' : '';
  return { txt: `${sign}${e.toFixed(1)}pp edge`, cls: e > 0 ? 'edge-pos' : (e < 0 ? 'edge-neg' : 'muted') };
}
/* Ice Breaker spotlight: two featured picks inside the First goal
   market view — the slate's best Ice Breaker (highest Ice Breaker
   Score) and the best longshot Ice Breaker (highest score among
   skaters at fair +1000 or longer, i.e. ibP <= LONGSHOT_DISPLAY_P). The
   longshot pick excludes the best pick's skater so the two cards are
   never identical. */
function wireBookInputs(wrap) {
  wrap.querySelectorAll('.pname').forEach((b) =>
    b.addEventListener('click', () => openPlayer(b.dataset.pid, b.dataset.gid)));
  wrap.querySelectorAll('.book-input').forEach((inp) => {
    inp.addEventListener('input', () => {
      state.bookOdds[inp.dataset.pid] = inp.value;
      const e = iceEdge(parseFloat(inp.dataset.p), inp.value);
      const out = inp.parentElement.querySelector('.edge-out');
      if (out) { out.textContent = e.txt; out.className = 'small edge-out ' + e.cls; }
    });
  });
}
function iceSpotCard(r, label) {
  const g = state.games.find((x) => x.id === r.gameId);
  const matchup = g ? `${g.away} @ ${g.home}` : '';
  const book = state.bookOdds[r.pid] || '';
  const edge = iceEdge(r.ibP, book);
  const st = g ? firstGoalStamp(g.pbp) : null;
  // Timing: stamped winner time if the game already has a first goal,
  // else the expected time to first goal. When stamped, the book/edge
  // input is moot — show the result instead.
  let timingHtml, bookHtml;
  if (st) {
    timingHtml = `<div class="ib-spot-timing">First goal: <strong>${esc(fmtFirstGoalStamp(st))}</strong></div>`;
    bookHtml = '';
  } else {
    const exp = expectedFirstGoalMin(r.gameId);
    timingHtml = exp != null ? `<div class="ib-spot-timing">Expected first goal <strong>${esc(fmtExpFirstGoal(exp))}</strong></div>` : '';
    bookHtml = `<div class="ib-spot-book">
      <input class="book-input" data-pid="${r.pid}" data-p="${r.ibP}" value="${esc(book)}" placeholder="+800" inputmode="text" aria-label="Book odds for ${esc(r.name)}">
      <div class="small edge-out ${edge.cls}">${esc(edge.txt)}</div>
    </div>`;
  }
  const l1tag = r.line === 'L1' ? ' <span class="muted small" title="Estimated first line — opening-shift premium applied">L1</span>' : '';
  return `<div class="ib-spot-card">
    <div class="ib-spot-label">${esc(label)}</div>
    <div class="ib-spot-name">${pnameBtn(r)}${l1tag}</div>
    <div class="ib-spot-meta"><span class="team-cell"><img src="${teamLogoUrl(r.team)}" alt="" ${imgFallback}>${esc(r.team)}</span><span class="muted"> &middot; </span><span class="muted small">${esc(matchup)}</span></div>
    <div class="ib-spot-score"><span class="ib-spot-score-num">${r.ibScore}</span><span class="muted small">Ice Breaker Score</span></div>
    <div class="ib-spot-stats"><strong>${pct1(r.ibP)}</strong> 1st-goal &nbsp;&middot;&nbsp; Fair <strong>${r.ibFair}</strong></div>
    ${timingHtml}
    ${bookHtml}
  </div>`;
}
function iceSpotPicks(rows) {
  const ranked = rows.slice().sort((a, b) => (b.ibScore - a.ibScore) || (b.ibP - a.ibP));
  const best = ranked[0] || null;
  const bestLS = ranked.find((r) => r.ibP <= LONGSHOT_DISPLAY_P && (!best || r.pid !== best.pid)) || null;
  return { best, bestLS };
}
function renderIceSpotlight() {
  const wrap = $('iceSpotWrap');
  if (!wrap) return;
  const rows = iceBreakerScores(iceBreakerProbs());
  if (!rows.length) { wrap.innerHTML = '<p class="muted">No skaters on this slate.</p>'; return; }
  const { best, bestLS } = iceSpotPicks(rows);
  wrap.innerHTML =
    iceSpotCard(best, 'Best Ice Breaker') +
    (bestLS
      ? iceSpotCard(bestLS, 'Best Longshot Ice Breaker')
      : '<div class="ib-spot-card"><div class="ib-spot-label">Best Longshot Ice Breaker</div><p class="muted">No +1000 longshot on this slate.</p></div>');
  wireBookInputs(wrap);
}


/* ---------------- consolidated markets view ----------------
   One "Markets" tab; the mktKindFilter dropdown switches between the
   goal markets (anytime, brace, first goal) and the Poisson over/under
   markets (shots, assists, points). Only the selected market renders.
   The First goal view also carries the Ice Breaker spotlight (two picks:
   best overall and best longshot) above the table. */
const GOAL_KINDS = ['atg', 'twoplus', 'firstgoal'];
const MARKET_SUBS = {
  atg: 'Ranked by model probability &middot; fair no-vig odds.',
  twoplus: 'Probability of scoring a brace.',
  firstgoal: "Each skater's share of their matchup's scoring rate.",
  shots: 'Poisson over/under on shots &middot; λ from SOG/game.',
  assists: 'Poisson over/under on assists &middot; λ from AST/game.',
  points: 'Poisson over/under on points &middot; λ from PTS/game.',
};
/* Show exactly one market: goal markets get the search + game filters
   and the goal-probability table; First goal additionally gets the Ice
   Breaker spotlight; Poisson markets get the team filter and the
   over/under table. */
function setMarketKind(kind) {
  if (!MARKET_SUBS[kind]) kind = 'atg';
  state.marketKind = kind;
  const sel = $('mktKindFilter');
  if (sel) sel.value = kind;
  const isGoal = GOAL_KINDS.includes(kind);
  const isFirstGoal = kind === 'firstgoal';
  const isPoisson = !isGoal;
  $('goalprobsWrap').classList.toggle('hidden', !isGoal);
  $('mktGoalFilters').classList.toggle('hidden', !isGoal);
  $('icebreakerSection').classList.toggle('hidden', !isFirstGoal);
  $('marketsWrap').classList.toggle('hidden', !isPoisson);
  $('marketsNote').classList.toggle('hidden', !isPoisson);
  $('mktTeamFilterWrap').classList.toggle('hidden', !isPoisson);
  const sub = $('marketsSub');
  if (sub) sub.innerHTML = MARKET_SUBS[kind];
  if (isGoal) {
    renderGoalProbs();
    if (isFirstGoal) renderIceSpotlight();
  } else {
    renderMarkets();
  }
}
/* Goals tab filters: player-name search + game dropdown. Both combine
   with each other and with the goal-type dropdown; they filter the
   already-loaded rows, no new requests. */
function populateGoalGameFilter() {
  const sel = $('goalGameSelect');
  if (!sel) return;
  const prev = state.goalGame;
  sel.innerHTML = '<option value="all">All games</option>' +
    state.games.map((g) => `<option value="${g.id}">${esc(g.away)} vs ${esc(g.home)}</option>`).join('');
  // keep selection when the slate still has that game, else reset
  state.goalGame = state.games.some((g) => String(g.id) === String(prev)) ? prev : 'all';
  sel.value = state.goalGame;
}
function filterGoalRows(rows) {
  let out = rows;
  if (state.goalGame !== 'all') {
    out = out.filter((r) => String(r.gameId) === String(state.goalGame));
  }
  const q = (state.goalSearch || '').trim().toLowerCase();
  if (q) out = out.filter((r) => (r.name || '').toLowerCase().includes(q));
  return out;
}
function renderGoalProbs() {
  const tb = $('goalprobsBody');
  if (!tb) return;
  const type = GOAL_KINDS.includes(state.marketKind) ? state.marketKind : 'atg';
  let html;
  if (type === 'twoplus') {
    html = probTableHtml(filterGoalRows(twoPlusProbs()), 'tpP', 'tpFair');
  } else if (type === 'firstgoal') {
    html = probTableHtml(filterGoalRows(firstGoalProbs()), 'fgP', 'fgFair');
  } else {
    const rows = filterGoalRows(state.skaters.slice().sort((a, b) => b.p - a.p));
    html = rows.map((r) => `
    <tr>
      <td>${pnameBtn(r)}</td>
      <td><span class="team-cell"><img src="${teamLogoUrl(r.team)}" alt="" ${imgFallback}>${esc(r.team)}</span></td>
      <td class="num"><strong>${pct1(r.p)}</strong></td>
      <td class="num">${r.fair}</td>
    </tr>`).join('');
  }
  tb.innerHTML = html || '<tr><td colspan="4" class="muted">No skaters match.</td></tr>';
  wirePnameClicks(tb);
}

function renderSlate() {
  const grid = $('gamesGrid');
  const d = new Date(state.date + 'T12:00:00');
  $('slateTitle').textContent = 'Slate — ' + d.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' });
  grid.innerHTML = state.games.map((g) => {
    const pbp = g.pbp;
    const as = pbp ? pbp.awayTeam.score : 0;
    const hs = pbp ? pbp.homeTeam.score : 0;
    const asog = pbp && typeof pbp.awayTeam.sog === 'number' ? pbp.awayTeam.sog : null;
    const hsog = pbp && typeof pbp.homeTeam.sog === 'number' ? pbp.homeTeam.sog : null;
    const sogHtml = (asog !== null && hsog !== null) ? `<span>SOG ${asog}–${hsog}</span>` : '';
    const ga = panelGoalie(g, g.away), gh = panelGoalie(g, g.home);
    const goalieHtml = (ga.id || gh.id) ? `<div class="game-goalies">` +
      [ga, gh].map((pg, i) => pg.id
        ? `<button class="gg-name" data-goid="${pg.id}" data-gteam="${i ? g.home : g.away}" data-ggid="${g.id}" title="Open goalie card">${esc(pg.name.split(' ').slice(-1)[0])}<span class="g-tag ${pg.tag === 'Confirmed' ? 'ok' : 'proj'}">${esc(pg.tag)}</span></button>`
        : '').join('<span class="muted"> vs </span>') + `</div>` : '';
    return `<div class="game-card" data-gid="${g.id}" title="Tap for matchup">
      <div class="matchup">
        <span class="team"><img src="${teamLogoUrl(g.away)}" alt="" ${imgFallback}>${esc(g.away)}</span>
        <span class="muted">@</span>
        <span class="team"><img src="${teamLogoUrl(g.home)}" alt="" ${imgFallback}>${esc(g.home)}</span>
      </div>
      <div class="score-line"><span>${as}</span><span>${hs}</span></div>
      <div class="game-meta"><span>${gameStatusText(g)}</span>${sogHtml}</div>
      ${goalieHtml}
      ${scorersHtml(g)}
    </div>`;
  }).join('');
  const ud = $('utilDate');
  if (ud) ud.textContent = d.toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' });
  const ug = $('utilGames');
  if (ug) ug.textContent = state.games.length + (state.games.length === 1 ? ' game' : ' games');
  grid.querySelectorAll('.game-card').forEach((c) =>
    c.addEventListener('click', (e) => {
      if (e.target.closest('details')) return; // let the Goals toggle work
      const gg = e.target.closest('.gg-name');
      if (gg) { e.stopPropagation(); openGoalie(+gg.dataset.goid, gg.dataset.gteam, +gg.dataset.ggid); return; }
      openMatchup(c.dataset.gid);
    }));
}

/* ---------------- matchup card (tale of the tape) ----------------
   Win probability is computed on tap from the sims' own team λ values
   (sum of simLambda(sk.p) per team) via an exact Poisson race — no full
   sims run, nothing precomputed upfront. Regulation ties are split
   evenly between the teams for the two-way display. */
const FACT = [1];
for (let _i = 1; _i <= 20; _i++) FACT[_i] = FACT[_i - 1] * _i;
function poissonPmf(k, lam) {
  if (!(lam > 0)) return k === 0 ? 1 : 0;
  if (k < 0 || k > 20) return 0;
  return Math.exp(-lam) * Math.pow(lam, k) / FACT[k];
}
function matchupWinProb(lamA, lamB) {
  const KMAX = 15;
  let pA = 0, pTie = 0;
  for (let i = 0; i <= KMAX; i++) {
    const pa = poissonPmf(i, lamA);
    if (pa === 0) continue;
    let less = 0, eq = 0;
    for (let j = 0; j <= KMAX; j++) {
      const pb = poissonPmf(j, lamB);
      if (j < i) less += pb;
      else if (j === i) { eq = pb; break; }
    }
    pA += pa * less;
    pTie += pa * eq;
  }
  const pB = Math.max(0, 1 - pA - pTie);
  const half = pTie / 2;
  return { a: pA + half, b: pB + half, tie: pTie };
}

/* Team stats: ONE standings fetch per date, cached for the session.
   NOTE: /v1/standings/now 307-redirects off-proxy (CORS-killed) like
   /roster/{team}/current did — the date-specific path returns 200. */
async function getStandings() {
  const key = state.date;
  if (state.standingsCache && state.standingsCache.key === key) return state.standingsCache.map;
  const map = {};
  try {
    const d = await fetchJSON(`${API}/standings/${key}`);
    for (const s of (d.standings || [])) {
      const ab = s.teamAbbrev && s.teamAbbrev.default;
      if (ab) map[ab] = s;
    }
  } catch (e) { /* stats stay blank; win prob still shows */ }
  state.standingsCache = { key, map };
  return map;
}

function tapeRow(aVal, label, hVal, better) {
  const ac = better === 'a' ? ' class="better"' : '';
  const hc = better === 'h' ? ' class="better"' : '';
  return `<div class="tape-row"><span${ac}>${aVal}</span><span class="tape-label">${label}</span><span${hc}>${hVal}</span></div>`;
}
// cmp returns 'a' | 'h' | null — higher wins unless lower=true
function cmpRow(aV, hV, lower) {
  if (aV === null || hV === null || aV === hV) return null;
  const aBetter = lower ? aV < hV : aV > hV;
  return aBetter ? 'a' : 'h';
}

/* ---------------- goalie vulnerability (matchup card) ----------------
   Where each goalie gets beaten: goal locations from already-loaded pbps
   (tonight's + recent finals kept in state), plus which shooter positions
   beat him. Zero new requests — everything is in memory.
   Orientation note: normalizeShot() is reused for consistency with the
   player shot charts; since a goal must come from the offensive zone, x is
   mirrored to +x when normalization misses (homeTeamDefendingSide is no
   longer sent by the API), so every goal-against lands in the attacking
   half. Side labels are from the goalie's perspective facing the shooter. */
let pendingGoalieDraw = []; // [{canvasId, goals}] filled by goalieSectionHtml, drawn after inject

function goalieStarter(pbp, teamAbbrev) {
  // starting goalie for teamAbbrev: first goalieInNetId seen defending for them
  if (!pbp) return null;
  const home = pbp.homeTeam || {}, away = pbp.awayTeam || {};
  if (teamAbbrev !== home.abbrev && teamAbbrev !== away.abbrev) return null;
  // precomputed bundle: the builder ran this same scan on the full pbp
  if (pbp._starters) {
    const s = teamAbbrev === home.abbrev ? pbp._starters.home
      : teamAbbrev === away.abbrev ? pbp._starters.away : null;
    return s && s.id ? { id: s.id, name: s.name } : null;
  }
  const info = {};
  for (const r of (pbp.rosterSpots || [])) {
    if (r.positionCode !== 'G') continue;
    info[r.playerId] = { name: `${r.firstName.default} ${r.lastName.default}`, teamId: r.teamId };
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
  return null;
}

function panelGoalie(g, teamAbbrev) {
  // tonight's starter when the game has begun, else the most recent starter
  const pbp = g.pbp;
  if (pbp && (pbp.plays || []).length) {
    const s = goalieStarter(pbp, teamAbbrev);
    if (s) return { ...s, tag: 'Confirmed' };
  }
  const ids = (state.recentIds || {})[teamAbbrev] || [];
  for (const id of ids) {
    const s = goalieStarter((state.zonePbps || {})[id], teamAbbrev);
    if (s) return { ...s, tag: 'Projected' };
  }
  return { id: null, name: 'TBD', tag: null };
}

function goalsAgainstGoalie(goalieId) {
  // every non-shootout goal with this goalie in net, across tonight's + recent pbps
  const out = [];
  if (!goalieId) return out;
  const pbps = [];
  for (const g of state.games) if (g.pbp) pbps.push(g.pbp);
  for (const id of Object.keys(state.zonePbps || {})) pbps.push(state.zonePbps[id]);
  const seen = new Set(), posOf = {};
  for (const pbp of pbps) {
    if (!pbp || seen.has(pbp)) continue;
    seen.add(pbp);
    for (const r of (pbp.rosterSpots || [])) posOf[r.playerId] = r.positionCode;
  }
  for (const s of state.skaters) if (!posOf[s.pid]) posOf[s.pid] = s.pos;
  for (const pbp of seen) {
    const homeId = (pbp.homeTeam || {}).id;
    const homeDefSide = pbp.homeTeamDefendingSide;
    for (const p of (pbp.plays || [])) {
      if (p.typeDescKey !== 'goal') continue;
      if ((p.periodDescriptor || {}).periodType === 'SO') continue;
      const det = p.details || {};
      if (det.goalieInNetId !== goalieId) continue;
      let x = null, y = null;
      if (det.xCoord != null && det.yCoord != null) {
        const n = normalizeShot(det.xCoord, det.yCoord, det.eventOwnerTeamId, homeId, homeDefSide);
        x = Math.abs(n.x); y = n.y;
      }
      out.push({ x, y, pos: posOf[det.scoringPlayerId] || null });
    }
  }
  return out;
}

function goalieZoneStats(goalieId) {
  // per-zone {shots, goals, sv} — shared by the zone grid and the vs-goalie matchup
  const stats = {};
  for (const z of NET_ZONES) stats[z] = { shots: 0, goals: 0, sv: null };
  for (const s of shotsAgainstGoalie(goalieId)) {
    const z = netZone(s.x, s.y);
    if (z) stats[z].shots++;
  }
  for (const gl of goalsAgainstGoalie(goalieId)) {
    const z = netZone(gl.x, gl.y);
    if (z) { stats[z].shots++; stats[z].goals++; }
  }
  for (const z of NET_ZONES) {
    if (stats[z].shots >= 3) stats[z].sv = 1 - stats[z].goals / stats[z].shots;
  }
  return stats;
}

function skaterGoalsVsGoalie(skaterPid, goalieId) {
  // goals by this skater with this specific goalie in net (all scanned pbps)
  if (!skaterPid || !goalieId) return 0;
  let n = 0;
  const pbps = [];
  for (const g of state.games) if (g.pbp) pbps.push(g.pbp);
  for (const id of Object.keys(state.zonePbps || {})) pbps.push(state.zonePbps[id]);
  const seen = new Set();
  for (const pbp of pbps) {
    if (!pbp || seen.has(pbp)) continue;
    seen.add(pbp);
    for (const p of (pbp.plays || [])) {
      if (p.typeDescKey !== 'goal') continue;
      if ((p.periodDescriptor || {}).periodType === 'SO') continue;
      const det = p.details || {};
      if (String(det.scoringPlayerId) === String(skaterPid) &&
          String(det.goalieInNetId) === String(goalieId)) n++;
    }
  }
  return n;
}

function vsGoalieHtml(r, g) {
  // "vs [Goalie]" head-to-head section for a skater's player card
  const pg = panelGoalie(g, r.oppAbbr);
  if (!pg.id) return '';
  const h2h = skaterGoalsVsGoalie(r.pid, pg.id);
  // skater's top shot zones (min 8 located shots for a read)
  const zCount = {};
  for (const s of (r.shots || [])) {
    const z = netZone(s.x, s.y);
    if (z) zCount[z] = (zCount[z] || 0) + 1;
  }
  const zTotal = Object.values(zCount).reduce((a, b) => a + b, 0);
  const topZones = Object.entries(zCount).sort((a, b) => b[1] - a[1]).slice(0, 2);
  // goalie's weakest zones with a real sample
  const gz = goalieZoneStats(pg.id);
  const weakZones = NET_ZONES.filter((z) => gz[z].sv != null)
    .sort((a, b) => gz[a].sv - gz[b].sv).slice(0, 2);
  let overlap = '';
  if (zTotal >= 8 && topZones.length && weakZones.length) {
    const hits = topZones.filter(([z]) => weakZones.includes(z));
    if (hits.length) {
      const [z, n] = hits[0];
      const pct = Math.round(n / zTotal * 100);
      overlap = `<div>Shoots <strong>${pct}%</strong> to <strong>${z.toLowerCase()}</strong> — ${esc(pg.name.split(' ').slice(-1)[0])}'s weakest zone (${(gz[z].sv * 100).toFixed(1)}% SV).</div>`;
    } else {
      const [z, n] = topZones[0];
      const pct = Math.round(n / zTotal * 100);
      overlap = `<div class="muted">Favors <strong>${z.toLowerCase()}</strong> (${pct}% of shots) — not ${esc(pg.name.split(' ').slice(-1)[0])}'s weak spot.</div>`;
    }
  }
  return `<h4 style="margin:.8rem 0 .2rem">vs ${esc(pg.name)} <span class="muted small">head-to-head · model</span></h4>
    <div class="small" style="display:flex;flex-direction:column;gap:.25rem">
      <div><strong>${h2h}</strong> career-tracked goal${h2h === 1 ? '' : 's'} with ${esc(pg.name.split(' ').slice(-1)[0])} in net <span class="muted">(recent games)</span>.</div>
      ${overlap}
    </div>`;
}

function shotsAgainstGoalie(goalieId) {
  // every saved shot-on-goal with this goalie in net, across tonight's + recent pbps
  const out = [];
  if (!goalieId) return out;
  const pbps = [];
  for (const g of state.games) if (g.pbp) pbps.push(g.pbp);
  for (const id of Object.keys(state.zonePbps || {})) pbps.push(state.zonePbps[id]);
  const seen = new Set();
  for (const pbp of pbps) {
    if (!pbp || seen.has(pbp)) continue;
    seen.add(pbp);
    const homeId = (pbp.homeTeam || {}).id;
    const homeDefSide = pbp.homeTeamDefendingSide;
    for (const p of (pbp.plays || [])) {
      if (p.typeDescKey !== 'shot-on-goal') continue;
      const det = p.details || {};
      if (det.goalieInNetId !== goalieId) continue;
      let x = null, y = null;
      if (det.xCoord != null && det.yCoord != null) {
        const n = normalizeShot(det.xCoord, det.yCoord, det.eventOwnerTeamId, homeId, homeDefSide);
        x = Math.abs(n.x); y = n.y;
      }
      out.push({ x, y });
    }
  }
  return out;
}

function netZone(x, y) {
  // 6 net zones, shooter's perspective: y<0 is the shooter's left
  // (goalie's right). Feed is top-down so high/low = shot distance:
  // "Low" = in tight (x>=75), "High" = from distance.
  if (x == null || y == null) return null;
  const col = y < -12 ? 'Left' : y > 12 ? 'Right' : 'Center';
  const row = x >= 75 ? 'Low' : 'High';
  return `${col}-${row}`;
}
const NET_ZONES = ['Left-High', 'Center-High', 'Right-High', 'Left-Low', 'Center-Low', 'Right-Low'];

function zoneSvColor(sv) {
  // red (weak) -> yellow (~.900 league avg) -> green (strong); dark-UI friendly
  const c = Math.max(0, Math.min(1, sv));
  let r, g, b;
  if (c < 0.90) { const t = Math.max(0, Math.min(1, (c - 0.78) / 0.12)); r = 200; g = Math.round(70 + 130 * t); b = 70; }
  else { const t = Math.max(0, Math.min(1, (c - 0.90) / 0.08)); r = Math.round(200 - 140 * t); g = 200; b = 70; }
  return { bg: `rgba(${r},${g},${b},0.22)`, border: `rgba(${r},${g},${b},0.65)`, text: `rgb(${Math.min(255, r + 40)},${Math.min(255, g + 40)},${Math.min(255, b + 40)})` };
}

function goalieZoneGridHtml(goalieId) {
  const stats = goalieZoneStats(goalieId);
  let located = 0;
  for (const z of NET_ZONES) located += stats[z].shots;
  if (!located) return '';
  const cells = NET_ZONES.map((z) => {
    const st = stats[z];
    if (st.shots < 3) {
      return `<div class="gz-cell gz-small"><div class="gz-sv muted">—</div><div class="gz-n muted small">n&lt;3</div><div class="gz-z muted">${z}</div></div>`;
    }
    const sv = 1 - st.goals / st.shots;
    const col = zoneSvColor(sv);
    return `<div class="gz-cell" style="background:${col.bg};border-color:${col.border}">` +
      `<div class="gz-sv" style="color:${col.text}">${(sv * 100).toFixed(1)}%</div>` +
      `<div class="gz-n muted small">${st.shots} shots</div><div class="gz-z muted">${z}</div></div>`;
  }).join('');
  // weakest zone with a real sample
  let worst = null;
  for (const z of NET_ZONES) {
    const st = stats[z];
    if (st.shots < 3) continue;
    const sv = 1 - st.goals / st.shots;
    if (!worst || sv < worst.sv) worst = { z, sv, shots: st.shots };
  }
  const summary = worst
    ? `<div class="gz-sum">Weakest: <strong>${worst.z.toLowerCase()}</strong> — ${(worst.sv * 100).toFixed(1)}% SV on ${worst.shots} shots</div>`
    : '';
  return `<div class="gz-wrap"><div class="gz-grid">${cells}</div>${summary}` +
    `<div class="muted small">Sides from shooter's view · high/low = shot distance (feed is top-down).</div></div>`;
}

function goalZoneLabel(x, y) {
  // net at (89,0); side from the goalie's perspective facing the shooter
  const side = y < -10 ? "goalie's right" : y > 10 ? "goalie's left" : 'middle';
  let zone;
  if (x >= 82) zone = 'in tight';
  else if (x <= 89 && Math.hypot(89 - x, y) < 30) zone = 'the slot';
  else if (x < 55) zone = 'the point';
  else zone = 'mid-range';
  return side === 'middle' ? zone : `${zone}, ${side}`;
}
function topZone(goals) {
  const counts = {};
  for (const gl of goals) {
    if (gl.x == null) continue;
    const z = goalZoneLabel(gl.x, gl.y);
    counts[z] = (counts[z] || 0) + 1;
  }
  const top = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  return top ? top[0] : null;
}

const GOALIE_POS = ['C', 'LW', 'RW', 'D'];
const POS_FIX = { C: 'C', L: 'LW', R: 'RW', D: 'D' };
function goaliePosCounts(goals) {
  const c = { C: 0, LW: 0, RW: 0, D: 0 };
  for (const gl of goals) {
    const l = POS_FIX[gl.pos];
    if (l) c[l]++;
  }
  return c;
}

function goaliePanelHtml(g, teamAbbrev, st) {
  const pg = panelGoalie(g, teamAbbrev);
  const tag = pg.tag ? `<span class="g-tag">${esc(pg.tag)}</span>` : '';
  if (!pg.id) {
    return `<div class="goalie-panel"><div class="goalie-head"><strong>${esc(pg.name)}</strong>${tag}
      <span class="muted small">${esc(teamAbbrev)}</span></div>
      <div class="muted small">No goalie data yet.</div></div>`;
  }
  const goals = goalsAgainstGoalie(pg.id);
  const n = goals.length;
  const canvasId = `grink-${teamAbbrev}-${g.id}`;
  pendingGoalieDraw.push({ canvasId, goals });
  const zone = topZone(goals);
  const pc = goaliePosCounts(goals);
  const pTot = GOALIE_POS.reduce((a, k) => a + pc[k], 0);
  const segs = GOALIE_POS.map((k) => pc[k]
    ? `<div class="pos-seg pos-${k}" style="width:${(pc[k] / pTot * 100).toFixed(1)}%" title="${k}: ${pc[k]}"></div>` : '').join('');
  const legs = GOALIE_POS.map((k) => pc[k]
    ? `<span class="pos-leg"><i class="pos-dot pos-${k}"></i>${k} ${pc[k]}</span>` : '').join('');
  const sample = n < 10 ? `<div class="muted small">Small sample — ${n} goal${n === 1 ? '' : 's'} charted.</div>` : '';
  const map = goals.some((gl) => gl.x != null)
    ? `<canvas class="grink" id="${canvasId}"></canvas>`
    : `<div class="muted small">No located goals charted.</div>`;
  return `<div class="goalie-panel">
    <div class="goalie-head goalie-open" data-goalie="${pg.id}" data-team="${esc(teamAbbrev)}" data-game="${g.id}" role="button" tabindex="0" title="Open ${esc(pg.name)} card"><strong>${esc(pg.name)}</strong>${tag}<span class="muted small">${esc(teamAbbrev)}</span></div>
    ${map}
    ${goalieZoneGridHtml(pg.id)}
    ${zone ? `<div class="goalie-zone">Most beaten: <strong>${esc(zone)}</strong></div>` : ''}
    ${pTot ? `<div class="posbar" aria-label="Goals by shooter position">${segs}</div>
    <div class="pos-legend">${legs}</div>` : ''}
    ${sample}
    ${goalieProjTableHtml(g, teamAbbrev, st)}
  </div>`;
}

function goalieSectionHtml(g, st) {
  pendingGoalieDraw = [];
  return `<h4 class="tape-title">Goalies</h4>
  <div class="goalie-panels">
    ${goaliePanelHtml(g, g.away, st)}
    ${goaliePanelHtml(g, g.home, st)}
  </div>`;
}

/* ---------------- goalie projections (Poisson over/under) ----------------
   Per-starter table: Saves / Shots against / Goals against, each with
   Model (λ), Median, Threshold (median − 0.5, the standard book line),
   and Over % = P(X > threshold). All model estimates, not official lines. */
const goalieSvCache = {}; // goalieId -> season savePct
async function getGoalieSvPct(goalieId) {
  if (!goalieId) return null;
  if (goalieSvCache[goalieId] != null) return goalieSvCache[goalieId];
  try {
    const gl = await getPlayer(goalieId);
    const sv = gl && gl.featuredStats && gl.featuredStats.regularSeason &&
      gl.featuredStats.regularSeason.subSeason
      ? gl.featuredStats.regularSeason.subSeason.savePctg : null;
    goalieSvCache[goalieId] = (sv > 0 && sv < 1) ? sv : 0.900;
  } catch (e) { goalieSvCache[goalieId] = 0.900; }
  return goalieSvCache[goalieId];
}
// shots the goalie's team is expected to face: opponent's goals/game ÷ league-avg shooting%
function oppShotsPerGame(st, oppAbbr) {
  const s = st && st[oppAbbr];
  if (!s || !(s.gamesPlayed > 0)) return null;
  const gpg = s.goalFor / s.gamesPlayed;
  return gpg / 0.105; // 0.105 = league-average shooting%, same as the skater model
}
function goalieProjRow(label, lam) {
  const med = poissonMedian(lam);
  const thresh = med - 0.5;
  const over = pOverLine(lam, med - 1); // P(X > med−0.5) = P(X ≥ med)
  return `<tr><td>${label}</td><td>${lam.toFixed(1)}</td><td>${med}</td>` +
    `<td>${thresh.toFixed(1)}</td><td class="gproj-over">${(over * 100).toFixed(2)}%</td></tr>`;
}
function goalieProjTableHtml(g, teamAbbrev, st) {
  const pg = panelGoalie(g, teamAbbrev);
  if (!pg.id) return '';
  const opp = teamAbbrev === g.away ? g.home : g.away;
  const shots = oppShotsPerGame(st, opp);
  const sv = goalieSvCache[pg.id];
  if (shots == null || sv == null) {
    return `<div class="gproj"><div class="muted small">Loading projections…</div></div>`;
  }
  const lamShots = shots, lamSaves = shots * sv, lamGA = shots * (1 - sv);
  return `<div class="gproj">
    <table class="gproj-table">
      <thead><tr><th>Stat</th><th>Model</th><th>Median</th><th>Threshold</th><th>Over %</th></tr></thead>
      <tbody>
        ${goalieProjRow('Saves', lamSaves)}
        ${goalieProjRow('Shots against', lamShots)}
        ${goalieProjRow('Goals against', lamGA)}
      </tbody>
    </table>
    <div class="muted small">Projected time on ice: 58.5 min <span class="est">est.</span></div>
  </div>`;
}
// fetch both starters' save% so the second matchup render has real numbers
async function ensureGoalieProj(g) {
  const ids = [g.away, g.home].map((t) => panelGoalie(g, t).id).filter(Boolean);
  await Promise.all(ids.map((id) => getGoalieSvPct(id)));
}

function drawGoalieRinks() {
  for (const d of pendingGoalieDraw) {
    const cv = document.getElementById(d.canvasId);
    if (!cv) continue;
    drawRink(cv, d.goals.filter((gl) => gl.x != null).map((gl) => ({ x: gl.x, y: gl.y, goal: true })), '#d4a017');
  }
  pendingGoalieDraw = [];
}

/* ---------------- lineup (estimated from TOI rank) ---------------- */
function lineupCellHtml(r, isSelf) {
  const last = r.name.split(' ').slice(-1)[0];
  return `<div class="lu-cell${isSelf ? ' self' : ''}" data-pid="${r.pid}" data-gid="${r.gameId}" role="button" tabindex="0" title="${esc(r.name)}">
    <img class="lu-head" src="${esc(r.headshot)}" alt="" ${imgFallback}>
    <div class="lu-name">${esc(last)}</div>
    <div class="lu-sub muted">${esc(r.pos)} · ${r.toiMin.toFixed(1)}</div>
  </div>`;
}

function teamLineupHtml(teamAbbr, gameId) {
  const rows = state.skaters.filter((s) => s.team === teamAbbr && String(s.gameId) === String(gameId));
  const fwds = rows.filter((s) => ['C', 'L', 'R'].includes(s.pos) && s.line).sort((a, b) => b.toiMin - a.toiMin);
  const defs = rows.filter((s) => s.pos === 'D').sort((a, b) => b.toiMin - a.toiMin);
  if (!fwds.length && !defs.length) return '';
  let html = `<div class="lu-team"><div class="lu-teamhead">${esc(teamAbbr)}</div>`;
  for (let i = 1; i <= 4; i++) {
    const line = fwds.filter((s) => s.line === 'L' + i);
    if (!line.length) continue;
    html += `<div class="lu-row"><div class="lu-label">L${i}</div><div class="lu-players">${line.map((s) => lineupCellHtml(s, false)).join('')}</div></div>`;
  }
  for (let i = 0; i < 3; i++) {
    const pair = defs.slice(i * 2, i * 2 + 2);
    if (!pair.length) continue;
    html += `<div class="lu-row"><div class="lu-label">D${i + 1}</div><div class="lu-players">${pair.map((s) => lineupCellHtml(s, false)).join('')}</div></div>`;
  }
  return html + '</div>';
}

function matchupLineupHtml(gameId) {
  const g = state.games.find((gg) => String(gg.id) === String(gameId));
  if (!g) return '';
  const a = teamLineupHtml(g.away, gameId);
  const h = teamLineupHtml(g.home, gameId);
  if (!a && !h) return '';
  return `<h4 class="tape-title">Lineup <span class="muted small">est. from ice time</span></h4><div class="lu-wrap">${a}${h}</div>`;
}

function linematesHtml(r) {
  const mates = state.skaters.filter((s) => s.team === r.team && String(s.gameId) === String(r.gameId) && String(s.pid) !== String(r.pid));
  let title = '', cells = '';
  if (['C', 'L', 'R'].includes(r.pos) && r.line) {
    const line = mates.filter((s) => s.line === r.line).sort((a, b) => b.toiMin - a.toiMin);
    if (!line.length) return '';
    title = `Line ${r.line} — linemates`;
    cells = [r, ...line].sort((a, b) => b.toiMin - a.toiMin)
      .map((s) => lineupCellHtml(s, String(s.pid) === String(r.pid))).join('');
  } else if (r.pos === 'D') {
    const defs = [r, ...mates.filter((s) => s.pos === 'D')].sort((a, b) => b.toiMin - a.toiMin);
    const idx = defs.findIndex((s) => String(s.pid) === String(r.pid));
    const pair = defs.slice(Math.floor(idx / 2) * 2, Math.floor(idx / 2) * 2 + 2);
    if (pair.length < 2) return '';
    title = `Pair D${Math.floor(idx / 2) + 1} — partner`;
    cells = pair.map((s) => lineupCellHtml(s, String(s.pid) === String(r.pid))).join('');
  } else {
    return '';
  }
  return `<h4 style="margin:.8rem 0 .2rem">${esc(title)} <span class="muted small">est.</span></h4><div class="lu-row"><div class="lu-players">${cells}</div></div>`;
}

function matchupHtml(g, lamA, lamB, wp, st) {
  const A = g.away, H = g.home;
  const sa = st ? st[A] : null, sh = st ? st[H] : null;
  const rec = (s) => s ? `${s.wins}-${s.losses}-${s.otLosses}` : '–';
  const per = (s, f) => (s && s.gamesPlayed > 0) ? f(s) : null;
  const gfA = per(sa, (s) => s.goalFor / s.gamesPlayed);
  const gfH = per(sh, (s) => s.goalFor / s.gamesPlayed);
  const gaA = per(sa, (s) => s.goalAgainst / s.gamesPlayed);
  const gaH = per(sh, (s) => s.goalAgainst / s.gamesPlayed);
  const ptA = per(sa, (s) => s.pointPctg);
  const ptH = per(sh, (s) => s.pointPctg);
  const l10A = per(sa, (s) => (s.l10Wins + s.l10OtLosses * 0.5) / Math.max(s.l10GamesPlayed, 1));
  const l10H = per(sh, (s) => (s.l10Wins + s.l10OtLosses * 0.5) / Math.max(s.l10GamesPlayed, 1));
  const fmt2 = (v) => v === null ? '–' : v.toFixed(2);
  const streak = (s) => (s && s.streakCode) ? `${s.streakCode}${s.streakCount}` : '–';
  const l10rec = (s) => s ? `${s.l10Wins}-${s.l10Losses}-${s.l10OtLosses}` : '–';

  const pbp = g.pbp;
  const hasScore = pbp && (g.state === 'LIVE' || g.state === 'CRIT' || g.state === 'OFF' || g.state === 'FINAL');
  const liveHtml = hasScore
    ? `<div class="matchup-live"><span>${esc(A)} ${pbp.awayTeam.score}</span><span class="muted">–</span><span>${pbp.homeTeam.score} ${esc(H)}</span></div>
       <div class="matchup-status muted small">${gameStatusText(g)}</div>`
    : '';

  const pctA = Math.round(wp.a * 100), pctH = Math.round(wp.b * 100);
  return `
  <div class="matchup-top">
    <div class="matchup-team">
      <img src="${teamLogoUrl(A)}" alt="${esc(A)}" ${imgFallback}>
      <div class="matchup-abbr">${esc(A)}</div>
      <div class="muted small">${esc(rec(sa))}</div>
    </div>
    <div class="matchup-vs">vs</div>
    <div class="matchup-team">
      <img src="${teamLogoUrl(H)}" alt="${esc(H)}" ${imgFallback}>
      <div class="matchup-abbr">${esc(H)}</div>
      <div class="muted small">${esc(rec(sh))}</div>
    </div>
  </div>
  ${liveHtml}
  <div class="split-bar" aria-label="Win probability">
    <div class="split-a" style="width:${(wp.a * 100).toFixed(1)}%"></div><div class="split-b" style="width:${(wp.b * 100).toFixed(1)}%"></div>
  </div>
  <div class="split-labels"><span><strong>${pctA}%</strong> ${esc(A)}</span><span>${esc(H)} <strong>${pctH}%</strong></span></div>
  <div class="matchup-proj">Projected <strong>${esc(A)} ${lamA.toFixed(1)} – ${lamB.toFixed(1)} ${esc(H)}</strong></div>
  <h4 class="tape-title">Tale of the tape</h4>
  <div class="tape">
    ${tapeRow(fmt2(gfA), 'Goals for / game', fmt2(gfH), cmpRow(gfA, gfH))}
    ${tapeRow(fmt2(gaA), 'Goals against / game', fmt2(gaH), cmpRow(gaA, gaH, true))}
    ${tapeRow(rec(sa), 'Record', rec(sh), cmpRow(ptA, ptH))}
    ${tapeRow(streak(sa), 'Streak', streak(sh), null)}
    ${tapeRow(l10rec(sa), 'Last 10', l10rec(sh), cmpRow(l10A, l10H))}
  </div>
  ${goalieSectionHtml(g, st)}
  ${matchupLineupHtml(g.id)}
  <p class="muted small matchup-note">Win % from each team's Poisson scoring rate (regulation ties split evenly). Team stats via NHL standings, cached per date. Goalie maps chart non-shootout goals with this goalie in net, from tonight's and recent games.</p>`;
}

async function openMatchup(gameId) {
  const g = state.games.find((gg) => String(gg.id) === String(gameId));
  if (!g) return;
  const lamA = simUnits(state.skaters, g.id, g.away).total;
  const lamB = simUnits(state.skaters, g.id, g.home).total;
  const wp = matchupWinProb(lamA, lamB);
  // show win prob + projection immediately; fill in standings when they arrive
  $('matchupBody').innerHTML = matchupHtml(g, lamA, lamB, wp, null);
  drawGoalieRinks();
  $('matchupModal').classList.remove('hidden');
  const st = await getStandings();
  await ensureGoalieProj(g);
  if (!$('matchupModal').classList.contains('hidden')) {
    $('matchupBody').innerHTML = matchupHtml(g, lamA, lamB, wp, st);
    drawGoalieRinks();
  }
}
function closeMatchup() { $('matchupModal').classList.add('hidden'); }

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
  const scorerByGame = {};
  for (const g of state.games) scorerByGame[g.id] = scorerCounts(g);
  tb.innerHTML = sortedSkaters().map((r) => {
    const ng = (scorerByGame[r.gameId] || {})[r.pid] || 0;
    const badge = ng ? `<span class="goal-badge">${ng > 1 ? ng + 'G' : 'GOAL'}</span>` : '';
    return `
    <tr${ng ? ' class="scored"' : ''}>
      <td>${pnameBtn(r)}${badge}
        <div class="prob-bar"><i style="width:${Math.min(100, r.p * 100 * 2.5)}%"></i></div></td>
      <td><span class="team-cell"><img src="${teamLogoUrl(r.team)}" alt="" ${imgFallback}>${esc(r.team)}</span></td>
      <td>${esc(r.pos)}</td>
      <td class="num"><strong>${pct1(r.p)}</strong></td>
      <td class="num">${r.fair}</td>
      <td class="num">${(r.goals / Math.max(r.gp, 1)).toFixed(2)}</td>
      <td class="num">${r.gp ? r.sogpg.toFixed(1) : '–'}</td>
      <td class="num">${fmtToi(r.toiMin)}</td>
      <td class="num">${Math.round(r.zone.share * 100)}${r.zone.lowSample ? '*' : ''}</td>
    </tr>`;
  }).join('');
  tb.querySelectorAll('.pname').forEach((b) =>
    b.addEventListener('click', () => openPlayer(b.dataset.pid, b.dataset.gid)));
}

function renderLongshots() {
  const ls = state.skaters.filter((r) => r.isLongshot).sort((a, b) => b.p - a.p);
  const el = $('longshotsList');
  if (!ls.length) { el.innerHTML = '<p class="muted">No longshots on this slate.</p>'; return; }
  el.innerHTML = ls.map((r) => `
    <div class="ls-card">
      <img class="headshot" src="${esc(r.headshot || headshotUrl(r.team, r.pid))}" alt="" ${imgFallback}>
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
  const kinds = MARKET_META[state.marketKind] ? [state.marketKind] : ['shots'];
  wrap.innerHTML = kinds.map((kind) => {
    const meta = MARKET_META[kind];
    const sorted = rows.slice()
      .sort((a, b) => marketOver(b, kind, MARKET_HEADLINE[kind]) - marketOver(a, kind, MARKET_HEADLINE[kind]))
      .slice(0, 80);
    const body = sorted.map((r) => `
      <tr>
        <td>${pnameBtn(r)}</td>
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

/* ---------------- book parlay calculator (manual odds) ---------------- */
const bookLegs = []; // { id, odds }
let bookLegSeq = 0;
function validAmericanOdds(v) {
  const n = parseFloat(String(v).replace(/−/g, '-').replace('+', '').trim());
  if (!isFinite(n)) return null;
  return (n <= -100 || n >= 100) ? n : null;
}
function syncBookRow(inp) {
  const bad = inp.value.trim() !== '' && validAmericanOdds(inp.value) === null;
  inp.classList.toggle('invalid', bad);
  const hint = inp.closest('.book-leg').querySelector('.book-hint');
  if (hint) hint.classList.toggle('hidden', !bad);
}
function renderBookLegs() {
  const el = $('bookLegs');
  if (!el) return;
  el.innerHTML = bookLegs.map((l, i) => `
    <div class="book-leg">
      <span class="leg-num">Leg ${i + 1}</span>
      <input type="text" data-leg="${l.id}" value="${esc(l.odds)}" inputmode="numeric" placeholder="-110" aria-label="Leg ${i + 1} odds">
      <button class="linklike" data-leg-rm="${l.id}" aria-label="Remove leg">✕</button>
      <span class="book-hint hidden" data-hint="${l.id}">needs American odds (e.g. -110 or +150)</span>
    </div>`).join('');
  el.querySelectorAll('input[data-leg]').forEach((inp) => {
    inp.addEventListener('input', () => {
      const leg = bookLegs.find((x) => x.id === +inp.dataset.leg);
      if (leg) leg.odds = inp.value;
      syncBookRow(inp);
      renderBookTotals();
    });
    syncBookRow(inp);
  });
  el.querySelectorAll('[data-leg-rm]').forEach((b) => b.addEventListener('click', () => {
    const ix = bookLegs.findIndex((x) => x.id === +b.dataset.legRm);
    if (ix > -1) bookLegs.splice(ix, 1);
    renderBookLegs();
    renderBookTotals();
  }));
}
function addBookLeg(odds) {
  bookLegs.push({ id: ++bookLegSeq, odds: odds == null ? '' : String(odds) });
  renderBookLegs();
  renderBookTotals();
}
function renderBookTotals() {
  const box = $('bookTotals');
  if (!box) return;
  const stake = Math.max(0, parseFloat(($('bookStake') || {}).value) || 0);
  const decs = bookLegs
    .map((l) => validAmericanOdds(l.odds))
    .map(americanToDecimal)
    .filter((d) => d && d > 1);
  if (decs.length < 2 || decs.length !== bookLegs.length || !stake) {
    box.innerHTML = '<p class="muted small">Enter valid odds for at least 2 legs and a stake to see the math.</p>';
    return;
  }
  const dec = decs.reduce((a, b) => a * b, 1);
  box.innerHTML = `
    <div class="totals-grid">
      <div><div class="t-label">Combined odds</div><div class="t-val">${decimalToAmerican(dec)}</div></div>
      <div><div class="t-label">Payout</div><div class="t-val">$${(stake * dec).toFixed(2)}</div></div>
      <div><div class="t-label">Profit</div><div class="t-val">$${(stake * (dec - 1)).toFixed(2)}</div></div>
      <div><div class="t-label">Implied prob</div><div class="t-val">${pct1(1 / dec)}</div></div>
    </div>`;
}

/* ---------------- vig checker (two-sided market) ---------------- */
function renderVig() {
  const box = $('vigOut');
  if (!box) return;
  const a = validAmericanOdds(($('vigA') || {}).value || '');
  const b = validAmericanOdds(($('vigB') || {}).value || '');
  const da = a === null ? null : americanToDecimal(a);
  const db = b === null ? null : americanToDecimal(b);
  if (!da || !db) {
    box.innerHTML = '<p class="muted small">Enter valid American odds for both sides.</p>';
    return;
  }
  const pa = 1 / da, pb = 1 / db;
  const total = pa + pb;
  const vig = (total - 1) / total; // book's margin as a share of total handle (-110/-110 = 4.55%)
  const fa = pa / total, fb = pb / total; // no-vig fair probabilities
  box.innerHTML = `
    <div class="totals-grid">
      <div><div class="t-label">Side A implied</div><div class="t-val">${pct1(pa)}</div></div>
      <div><div class="t-label">Side B implied</div><div class="t-val">${pct1(pb)}</div></div>
      <div><div class="t-label">Vig</div><div class="t-val">${pct1(vig)}</div></div>
      <div><div class="t-label">Fair A</div><div class="t-val">${decimalToAmerican(1 / fa)}</div></div>
      <div><div class="t-label">Fair B</div><div class="t-val">${decimalToAmerican(1 / fb)}</div></div>
    </div>`;
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
  setMarketKind(state.marketKind);
}

/* ---------------- player card ---------------- */
function drawRink(canvas, shots, teamColor) {
  const W = 420, H = 400;
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d');
  // map normalized coords: x in [0,100] -> px, y in [-42.5,42.5] -> py
  // (identical mapping to before — all callers unaffected)
  const X = (x) => 20 + (x / 100) * (W - 40);
  const Y = (y) => 20 + ((y + 42.5) / 85) * (H - 40);
  const pxFt = (W - 40) / 100; // px per foot (x axis)

  // ---- dark ice surface ----
  const bg = ctx.createRadialGradient(W / 2, H * 0.45, 40, W / 2, H / 2, 300);
  bg.addColorStop(0, '#182747');
  bg.addColorStop(0.6, '#101b31');
  bg.addColorStop(1, '#0a1120');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);

  // subtle ice sheen: faint diagonal highlight
  ctx.save();
  ctx.globalAlpha = 0.05;
  ctx.fillStyle = '#ffffff';
  ctx.beginPath();
  ctx.moveTo(0, H); ctx.lineTo(W * 0.55, 0); ctx.lineTo(W * 0.8, 0); ctx.lineTo(W * 0.25, H);
  ctx.closePath(); ctx.fill();
  ctx.restore();

  const rinkL = X(0), rinkR = X(100), rinkT = Y(-42.5), rinkB = Y(42.5);

  // ---- home-plate danger zone (subtle filled amber, under the lines) ----
  ctx.save();
  const hpGrad = ctx.createRadialGradient(X(89), Y(0), 4, X(89), Y(0), 30 * pxFt);
  hpGrad.addColorStop(0, 'rgba(232,161,61,0.28)');
  hpGrad.addColorStop(0.7, 'rgba(232,161,61,0.10)');
  hpGrad.addColorStop(1, 'rgba(232,161,61,0)');
  ctx.fillStyle = hpGrad;
  ctx.beginPath();
  // home-plate pentagon in front of the net
  ctx.moveTo(X(89), Y(-9)); ctx.lineTo(X(78), Y(-9)); ctx.lineTo(X(70), Y(0));
  ctx.lineTo(X(78), Y(9)); ctx.lineTo(X(89), Y(9)); ctx.closePath();
  ctx.fill();
  ctx.restore();

  // ---- rink outline: crisp white ----
  ctx.strokeStyle = 'rgba(235,242,255,0.9)'; ctx.lineWidth = 2.5;
  ctx.strokeRect(rinkL, rinkT, rinkR - rinkL, rinkB - rinkT);

  // ---- blue line (x=25), broadcast blue, full weight ----
  ctx.strokeStyle = '#3b82f6'; ctx.lineWidth = 5;
  ctx.beginPath(); ctx.moveTo(X(25), rinkT); ctx.lineTo(X(25), rinkB); ctx.stroke();

  // ---- goal line (x=89), red, full width ----
  ctx.strokeStyle = '#e5484d'; ctx.lineWidth = 3;
  ctx.beginPath(); ctx.moveTo(X(89), rinkT); ctx.lineTo(X(89), rinkB); ctx.stroke();

  // ---- goal crease: light-blue semicircle ----
  ctx.save();
  ctx.fillStyle = 'rgba(94,200,248,0.30)';
  ctx.strokeStyle = 'rgba(94,200,248,0.85)'; ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.ellipse(X(89), Y(0), 6 * pxFt, 6 * pxFt * 1.12, 0, -Math.PI / 2, Math.PI / 2);
  ctx.closePath(); ctx.fill(); ctx.stroke();
  ctx.restore();

  // ---- faceoff circles + dots ----
  for (const fy of [-22, 22]) {
    ctx.strokeStyle = 'rgba(235,242,255,0.75)'; ctx.lineWidth = 1.8;
    ctx.beginPath(); ctx.arc(X(69), Y(fy), 15, 0, Math.PI * 2); ctx.stroke();
    ctx.fillStyle = 'rgba(235,242,255,0.9)';
    ctx.beginPath(); ctx.arc(X(69), Y(fy), 3.2, 0, Math.PI * 2); ctx.fill();
    // hash marks
    ctx.strokeStyle = 'rgba(235,242,255,0.5)'; ctx.lineWidth = 1.5;
    for (const s of [-1, 1]) {
      ctx.beginPath(); ctx.moveTo(X(69) - 22, Y(fy) + s * 10); ctx.lineTo(X(69) - 14, Y(fy) + s * 10); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(X(69) + 22, Y(fy) + s * 10); ctx.lineTo(X(69) + 14, Y(fy) + s * 10); ctx.stroke();
    }
  }

  // ---- net: posts + crossbar + mesh, top-down at the goal line ----
  const netX = X(89), netHW = 3 * pxFt; // 6ft wide
  ctx.save();
  // mesh (behind the line, into the zone end)
  ctx.fillStyle = 'rgba(200,215,235,0.10)';
  ctx.strokeStyle = 'rgba(200,215,235,0.35)'; ctx.lineWidth = 0.8;
  const netDepth = 2.2 * pxFt;
  ctx.beginPath();
  ctx.moveTo(netX, Y(0) - netHW); ctx.lineTo(netX + netDepth, Y(0) - netHW * 0.8);
  ctx.lineTo(netX + netDepth, Y(0) + netHW * 0.8); ctx.lineTo(netX, Y(0) + netHW);
  ctx.closePath(); ctx.fill(); ctx.stroke();
  // mesh crosshatch
  ctx.strokeStyle = 'rgba(200,215,235,0.18)';
  for (let i = 1; i < 4; i++) {
    const t = i / 4;
    ctx.beginPath();
    ctx.moveTo(netX + netDepth * t, Y(0) - netHW * (1 - t * 0.2));
    ctx.lineTo(netX + netDepth * t, Y(0) + netHW * (1 - t * 0.2));
    ctx.stroke();
  }
  // posts + crossbar in goal red
  ctx.strokeStyle = '#e5484d'; ctx.lineWidth = 3.5; ctx.lineCap = 'round';
  ctx.beginPath(); ctx.moveTo(netX, Y(0) - netHW); ctx.lineTo(netX, Y(0) + netHW); ctx.stroke();
  ctx.fillStyle = '#e5484d';
  ctx.beginPath(); ctx.arc(netX, Y(0) - netHW, 2.6, 0, Math.PI * 2); ctx.fill();
  ctx.beginPath(); ctx.arc(netX, Y(0) + netHW, 2.6, 0, Math.PI * 2); ctx.fill();
  ctx.restore();

  // ---- shots: visual hierarchy — goals glow, others dim ----
  for (const s of shots) {
    const px = X(Math.max(0, Math.min(100, s.x)));
    const py = Y(Math.max(-42.5, Math.min(42.5, s.y)));
    ctx.save();
    if (s.goal) {
      // glowing goal marker: halo + gold core + white ring
      ctx.shadowColor = '#ffd54a'; ctx.shadowBlur = 14;
      ctx.beginPath(); ctx.arc(px, py, 7, 0, Math.PI * 2);
      ctx.fillStyle = '#ffd54a'; ctx.fill();
      ctx.shadowBlur = 0;
      ctx.lineWidth = 2; ctx.strokeStyle = 'rgba(255,255,255,0.9)'; ctx.stroke();
      ctx.fillStyle = '#7a5b00';
      ctx.beginPath(); ctx.arc(px, py, 2.2, 0, Math.PI * 2); ctx.fill();
    } else {
      ctx.globalAlpha = 0.55;
      ctx.beginPath(); ctx.arc(px, py, 4, 0, Math.PI * 2);
      ctx.fillStyle = teamColor; ctx.fill();
      ctx.globalAlpha = 0.9;
      ctx.lineWidth = 1; ctx.strokeStyle = 'rgba(255,255,255,0.35)'; ctx.stroke();
    }
    ctx.restore();
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
  const marketsHtml = ['shots', 'assists', 'points'].map((kind, ki) => {
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
    return `<details class="mkt-group"${ki === 0 ? ' open' : ''}><summary class="mkt-h">${meta.label} <span class="muted small">λ ${r.markets[kind][0].lam.toFixed(2)}/g</span><span class="mkt-chev">▾</span></summary><div class="mkt-body">${rows}</div></details>`;
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
        <div class="pc-goals">Total Season Goals: ${r.goals}</div>
      </div>
    </div>
    <div class="pc-status">${lineBadge}${statusPill}</div>
    ${linematesHtml(r)}
    ${vsGoalieHtml(r, g)}
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
    <h4 style="margin:.6rem 0 .2rem"><span id="rinkTitle">Shot map</span> <span class="muted small">recent games, attacking →</span>
      <span style="float:right"><button class="pill on" id="rinkShots">Shots</button> <button class="pill" id="rinkGoals">Goals</button></span></h4>
    <canvas class="rink" id="rinkCanvas"></canvas>
    <div class="legend"><span><span class="dot" style="background:#2f6fed"></span>attempt</span>
      <span><span class="dot" style="background:#d4a017"></span>goal</span>
      <span><span class="dot" style="border:2px dashed #e8a13d;background:none"></span>high-danger zone</span></div>`;
  $('playerModal').classList.remove('hidden');
  // map follows the Markets dropdown on open; pills let you switch without closing
  const mk = state.marketKind;
  let rinkMode = ['atg', 'twoplus', 'firstgoal'].includes(mk) ? 'goals' : 'shots';
  const drawRinkMode = () => {
    const data = rinkMode === 'goals' ? r.shots.filter((s) => s.goal) : r.shots;
    $('rinkTitle').textContent = rinkMode === 'goals' ? 'Goal map' : 'Shot map';
    $('rinkShots').classList.toggle('on', rinkMode === 'shots');
    $('rinkGoals').classList.toggle('on', rinkMode === 'goals');
    drawRink($('rinkCanvas'), data, '#2f6fed');
  };
  $('rinkShots').addEventListener('click', () => { rinkMode = 'shots'; drawRinkMode(); });
  $('rinkGoals').addEventListener('click', () => { rinkMode = 'goals'; drawRinkMode(); });
  drawRinkMode();
  $('parlayAddBtn').addEventListener('click', () => addParlayLeg(r, $('parlayLegSelect').value));
}

function closePlayer() { $('playerModal').classList.add('hidden'); }

/* ---------------- goalie card ---------------- */
async function openGoalie(goalieId, teamAbbrev, gameId) {
  const g = state.games.find((gg) => String(gg.id) === String(gameId));
  if (!g || !goalieId) return;
  const pg = panelGoalie(g, teamAbbrev);
  if (!pg.id) return;
  const tag = pg.tag ? `<span class="status-pill ${pg.tag === 'Confirmed' ? 'ok' : 'proj'}">${esc(pg.tag)}</span>` : '';
  // season stats from the landing (same fetch the projection code uses)
  let season = null;
  try {
    const gl = await getPlayer(goalieId);
    const sub = gl && gl.featuredStats && gl.featuredStats.regularSeason && gl.featuredStats.regularSeason.subSeason;
    if (sub) season = sub;
  } catch (e) { /* keep null */ }
  const statRow = season ? `<div class="totals-grid" style="margin:.6rem 0">
      <div><div class="t-label">Record</div><div class="t-val">${season.wins || 0}-${season.losses || 0}-${season.otLosses || 0}</div></div>
      <div><div class="t-label">Save %</div><div class="t-val">${((season.savePctg || 0) * 100).toFixed(1)}%</div></div>
      <div><div class="t-label">GAA</div><div class="t-val">${(season.goalsAgainstAvg || 0).toFixed(2)}</div></div>
      <div><div class="t-label">Shots against</div><div class="t-val">${season.shotsAgainst || '–'}</div></div>
    </div>` : `<p class="muted small">Season stats unavailable.</p>`;
  // rink map of goals allowed
  const goals = goalsAgainstGoalie(pg.id);
  const canvasId = `gcard-rink-${pg.id}`;
  pendingGoalieDraw.push({ canvasId, goals });
  const map = goals.some((gl) => gl.x != null)
    ? `<canvas class="grink" id="${canvasId}" style="max-width:100%"></canvas>`
    : `<div class="muted small">No located goals charted.</div>`;
  // ensure save% + standings for the projection table
  await getGoalieSvPct(pg.id);
  const st = await getStandings().catch(() => null);
  $('modalBody').innerHTML = `
    <div class="pc-head">
      <img class="headshot" src="${esc(headshotUrl(teamAbbrev, pg.id))}" alt="" ${imgFallback}>
      <div>
        <h3 class="pc-name">${esc(pg.name)}</h3>
        <div><img class="tlogo" src="${teamLogoUrl(teamAbbrev)}" alt="" ${imgFallback}>
          <span class="muted">${esc(teamAbbrev)} · Goalie · ${g ? esc(g.away + ' @ ' + g.home) : ''}</span></div>
      </div>
      <div style="margin-left:auto;text-align:right">${tag}</div>
    </div>
    ${statRow}
    <h4 style="margin:.8rem 0 .2rem">Projections <span class="muted small">model</span></h4>
    ${goalieProjTableHtml(g, teamAbbrev, st)}
    <h4 style="margin:.8rem 0 .2rem">Weak zones <span class="muted small">save% by zone</span></h4>
    ${goalieZoneGridHtml(pg.id)}
    <h4 style="margin:.8rem 0 .2rem">Goals allowed <span class="muted small">locations</span></h4>
    ${map}`;
  $('playerModal').classList.remove('hidden');
  drawGoalieRinks();
}

/* ---------------- views & refresh ---------------- */
function renderAll() {
  renderSlate();
  renderGoals();
  renderBoard();
  renderLongshots();
  setMarketKind(state.marketKind);
  renderParlay();
}

/* ---------------- two-tier live refresh ----------------
   Fast tier (15s): lightweight boxscore per live game (~13KB vs ~118KB pbp).
   Scores, SOG, clock, and period update immediately; the full pbp fires only
   when the fast tier sees a score, period, or game-state change (that's when
   goal details, scorer names, and goal-type badges need refreshing).
   Slow tier (30s): the original full-pbp refresh, kept as a safety backstop. */
const liveScoreCache = {}; // gameId -> {a,h,period,clock,state}

function scoreSnapshot(bs) {
  return {
    a: bs.awayTeam ? bs.awayTeam.score : 0,
    h: bs.homeTeam ? bs.homeTeam.score : 0,
    period: bs.periodDescriptor ? bs.periodDescriptor.number : 0,
    clock: bs.clock ? bs.clock.timeRemaining : '',
    state: bs.gameState || '',
  };
}

function applyBoxscoreToGame(g, bs) {
  // Patch the scoreboard fields in place so renderers pick them up instantly.
  // Goal details (plays/rosterSpots) stay as-is until the slow tier refreshes
  // the full pbp — scores and clocks never wait on it.
  const snap = scoreSnapshot(bs);
  if (g.pbp && g.pbp.awayTeam) {
    g.pbp.awayTeam.score = snap.a;
    g.pbp.homeTeam.score = snap.h;
    g.pbp.awayTeam.sog = bs.awayTeam.sog;
    g.pbp.homeTeam.sog = bs.homeTeam.sog;
    g.pbp.clock = bs.clock;
    g.pbp.periodDescriptor = bs.periodDescriptor;
    g.pbp.gameState = bs.gameState;
  } else {
    // No pbp yet (game just went live): minimal stub so the slate, goal
    // feed, and status text render. Team ids/abbrevs keep extractGoals safe.
    g.pbp = {
      awayTeam: { id: bs.awayTeam.id, abbrev: bs.awayTeam.abbrev, score: snap.a, sog: bs.awayTeam.sog },
      homeTeam: { id: bs.homeTeam.id, abbrev: bs.homeTeam.abbrev, score: snap.h, sog: bs.homeTeam.sog },
      clock: bs.clock, periodDescriptor: bs.periodDescriptor,
      gameState: bs.gameState, plays: [], rosterSpots: [],
    };
  }
  return snap;
}

function rerenderLiveViews() {
  if (state.view === 'slate') renderSlate();
  if (state.view === 'goals') renderGoals();
  if (state.view === 'board') renderBoard();
}

/* ---------------- GitHub Actions live-score file ----------------
   The live.yml workflow polls the NHL API every 5 min and writes
   live/YYYY-MM-DD.json (UTC date). When the file exists and is fresh
   (updatedAt within 10 min), its scores are used instead of hitting
   /nhl-api/* — zero proxy cost. Falls back to proxy polling below when
   the file is missing or stale. */
async function tryLiveFileTick() {
  const utcDate = new Date().toISOString().slice(0, 10);
  let data;
  try {
    const r = await fetch(`live/${utcDate}.json`, { headers: { 'Accept': 'application/json' } });
    if (!r.ok) return false;
    data = await r.json();
  } catch (e) { return false; }
  if (!data || !Array.isArray(data.games) || !data.updatedAt) return false;
  const ageMs = Date.now() - new Date(data.updatedAt).getTime();
  if (!(ageMs >= 0 && ageMs <= 10 * 60 * 1000)) return false; // stale

  let applied = 0;
  for (const entry of data.games) {
    const g = state.games.find((gg) => String(gg.id) === String(entry.id));
    if (!g) continue;
    const prev = liveScoreCache[g.id];
    const cur = {
      a: entry.awayScore | 0, h: entry.homeScore | 0,
      period: entry.period | 0, clock: entry.clock || '',
      state: entry.state || '',
    };
    if (g.pbp && g.pbp.awayTeam) {
      g.pbp.awayTeam.score = cur.a;
      g.pbp.homeTeam.score = cur.h;
      g.pbp.periodDescriptor = { number: cur.period };
      g.pbp.clock = { timeRemaining: cur.clock, inIntermission: !!entry.inIntermission };
      g.pbp.gameState = cur.state;
    } else {
      g.pbp = {
        awayTeam: { abbrev: entry.away, score: cur.a },
        homeTeam: { abbrev: entry.home, score: cur.h },
        clock: { timeRemaining: cur.clock, inIntermission: !!entry.inIntermission },
        periodDescriptor: { number: cur.period },
        gameState: cur.state, plays: [], rosterSpots: [],
      };
    }
    if ((cur.state === 'LIVE' || cur.state === 'CRIT') && g.state !== 'LIVE' && g.state !== 'CRIT') {
      g.state = cur.state; // game just went live
    }
    const meaningfulChange = !prev ||
      prev.a !== cur.a || prev.h !== cur.h ||
      prev.period !== cur.period || prev.state !== cur.state;
    liveScoreCache[g.id] = cur;
    if (meaningfulChange) {
      try {
        const pbp = await fetchJSON(`${API}/gamecenter/${g.id}/play-by-play`);
        g.pbp = pbp;
        if (pbp.gameState === 'OFF' || pbp.gameState === 'FINAL') {
          g.state = 'OFF';
          delete liveScoreCache[g.id];
        }
      } catch (e) { /* keep file scores; backstop retries in 30s */ }
    }
    if (cur.state === 'OFF' || cur.state === 'FINAL') {
      g.state = 'OFF';
      delete liveScoreCache[g.id];
    }
    applied++;
  }
  if (applied) rerenderLiveViews();
  return applied > 0;
}

// A game is "watchable" if it's marked live, OR if its start time has passed
// but the bundle still says FUT (stale bundle — e.g. data built before puck drop).
function isWatchable(g) {
  if (g.state === 'LIVE' || g.state === 'CRIT') return true;
  if (g.state === 'FUT' && g.startUTC) {
    try { return new Date(g.startUTC).getTime() <= Date.now(); } catch (e) { return false; }
  }
  return false;
}

async function fastScoreTick() {
  // Prefer the GitHub Actions live file (no proxy cost); fall back to proxy.
  try {
    if (await tryLiveFileTick()) return;
  } catch (e) { /* fall through to proxy */ }
  const live = state.games.filter(isWatchable);
  if (!live.length) return;
  for (const g of live) {
    try {
      const bs = await fetchJSON(`${API}/gamecenter/${g.id}/boxscore`);
      const prev = liveScoreCache[g.id];
      const cur = applyBoxscoreToGame(g, bs);
      const meaningfulChange = !prev ||
        prev.a !== cur.a || prev.h !== cur.h ||
        prev.period !== cur.period || prev.state !== cur.state;
      liveScoreCache[g.id] = cur;
      if (meaningfulChange) {
        try {
          const pbp = await fetchJSON(`${API}/gamecenter/${g.id}/play-by-play`);
          g.pbp = pbp;
          if (pbp.gameState === 'OFF' || pbp.gameState === 'FINAL') {
            g.state = 'OFF';
            delete liveScoreCache[g.id];
          }
        } catch (e) { /* keep old pbp; backstop retries in 30s */ }
      }
      if (cur.state === 'OFF' || cur.state === 'FINAL') {
        g.state = 'OFF';
        delete liveScoreCache[g.id];
      }
    } catch (e) { /* boxscore failed: keep old data, UI untouched */ }
  }
  rerenderLiveViews();
}

async function refreshScores() {
  // 30s backstop: full pbp for live games (unchanged behavior)
  const live = state.games.filter(isWatchable);
  if (!live.length) return;
  for (const g of live) {
    try {
      const pbp = await fetchJSON(`${API}/gamecenter/${g.id}/play-by-play`);
      g.pbp = pbp;
      if (pbp.gameState === 'OFF' || pbp.gameState === 'FINAL') {
        g.state = 'OFF';
        delete liveScoreCache[g.id];
      }
    } catch (e) { /* keep old */ }
  }
  rerenderLiveViews();
}

function setView(v) {
  state.view = v;
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.view === v));
  document.querySelectorAll('.view').forEach((s) => s.classList.toggle('active', s.id === 'view-' + v));
  $('autoRefreshNote').style.visibility = v === 'slate' ? 'visible' : 'hidden';
}

function startAutoRefresh() {
  if (state.refreshTimer) clearInterval(state.refreshTimer);
  if (state.fastTimer) clearTimeout(state.fastTimer);
  // Smart polling: 10s during active play, 45s during intermissions.
  // Checks the intermission flag after each tick and reschedules accordingly.
  const scheduleFast = (delay) => {
    state.fastTimer = setTimeout(async () => {
      if (!document.hidden) {
        try { await fastScoreTick(); } catch (e) {}
      }
      const anyIntermission = state.games.some((g) =>
        g.pbp && g.pbp.clock && g.pbp.clock.inIntermission && isWatchable(g));
      const anyLive = state.games.some(isWatchable);
      scheduleFast(!anyLive ? 30000 : anyIntermission ? 45000 : 10000);
    }, delay);
  };
  scheduleFast(10000);
  state.refreshTimer = setInterval(() => {
    if (document.hidden) return;
    refreshScores().catch(() => {});
  }, 30000);
}

/* ---------------- boot ---------------- */
document.querySelectorAll('.tab').forEach((t) =>
  t.addEventListener('click', () => setView(t.dataset.view)));
$('sortSelect').addEventListener('change', (e) => { state.sortBy = e.target.value; renderBoard(); });
// Markets goal filters: live search + game dropdown (persist across market switches)
const goalSearchInput = $('goalSearchInput');
if (goalSearchInput) goalSearchInput.addEventListener('input', (e) => { state.goalSearch = e.target.value; renderGoalProbs(); });
const goalGameSelect = $('goalGameSelect');
if (goalGameSelect) goalGameSelect.addEventListener('change', (e) => { state.goalGame = e.target.value; renderGoalProbs(); });
const goalFilterClear = $('goalFilterClear');
if (goalFilterClear) goalFilterClear.addEventListener('click', () => {
  state.goalSearch = ''; state.goalGame = 'all';
  if (goalSearchInput) goalSearchInput.value = '';
  if (goalGameSelect) goalGameSelect.value = 'all';
  renderGoalProbs();
});
$('teamFilter').addEventListener('change', (e) => applyTeamFilter(e.target.value));
const mktFilter = $('mktTeamFilter');
if (mktFilter) mktFilter.addEventListener('change', (e) => applyTeamFilter(e.target.value));
const mktKindFilter = $('mktKindFilter');
if (mktKindFilter) mktKindFilter.addEventListener('change', (e) => setMarketKind(e.target.value));
const stakeInput = $('parlayStake');
if (stakeInput) stakeInput.addEventListener('input', renderParlayTotals);
// book parlay calculator + vig checker (parlay view, below the leg builder)
const bookStakeInput = $('bookStake');
if (bookStakeInput) bookStakeInput.addEventListener('input', renderBookTotals);
const bookAddLeg = $('bookAddLeg');
if (bookAddLeg) bookAddLeg.addEventListener('click', () => addBookLeg());
const vigA = $('vigA'), vigB = $('vigB');
if (vigA) vigA.addEventListener('input', renderVig);
if (vigB) vigB.addEventListener('input', renderVig);
addBookLeg(-110);
addBookLeg(-110);
renderVig();
$('refreshBtn').addEventListener('click', () => boot(true));
$('datePicker').addEventListener('change', (e) => boot(true, e.target.value || state.date));
$('modalClose').addEventListener('click', closePlayer);
$('playerModal').addEventListener('click', (e) => { if (e.target.id === 'playerModal') closePlayer(); });
$('matchupClose').addEventListener('click', closeMatchup);
$('matchupModal').addEventListener('click', (e) => { if (e.target.id === 'matchupModal') closeMatchup(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { closePlayer(); closeMatchup(); } });
// lineup cells (matchup popup + player card linemates) open the player card
document.addEventListener('click', (e) => {
  const cell = e.target.closest('.lu-cell[data-pid]');
  if (cell && cell.dataset.pid) openPlayer(cell.dataset.pid, cell.dataset.gid);
});
// goalie heads in the matchup popup open the goalie card
document.addEventListener('click', (e) => {
  const gh = e.target.closest('.goalie-open[data-goalie]');
  if (gh && gh.dataset.goalie) openGoalie(gh.dataset.goalie, gh.dataset.team, gh.dataset.game);
});

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
// default the picker to today (local date); the HTML ships a stale fallback value
(() => {
  const n = new Date();
  const t = `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, '0')}-${String(n.getDate()).padStart(2, '0')}`;
  const dp = $('datePicker');
  if (dp && t >= dp.min && t <= dp.max) dp.value = t;
})();
boot(false, $('datePicker').value);
