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
  view: 'home',
  section: 'home',    // bottom-nav section: 'home' | 'lab'
  marketKind: 'atg',  // Markets tab: one market at a time — 'atg' | 'twoplus' | 'firstgoal' | 'shots' | 'assists' | 'points'
  goalSearch: '',     // Markets tab player-name search filter
  goalGame: 'all',    // Markets tab game filter ('all' or game id)
  bookOdds: {},       // pid -> raw book-odds input string (Ice Breaker)
  sortBy: 'prob',
  teamFilter: '',
  boardMarket: 'anytime',
  boardQuery: '',
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
// Team primary colors for glowing bars (playoff odds, etc.)
const TEAM_COLORS = {
  ANA: '#F47A38', BOS: '#FFB81C', BUF: '#003087', CGY: '#C8102E',
  CAR: '#a6192e', CHI: '#CF0A2C', COL: '#6F263D', CBJ: '#002654', DAL: '#006847',
  DET: '#CE1126', EDM: '#FF4C00', FLA: '#C8102E', LAK: '#A2AAAD', MIN: '#006847',
  MTL: '#AF1E2D', NSH: '#FFB81C', NJD: '#CE1126', NYI: '#00539B', NYR: '#0038A8',
  OTT: '#C8102E', PHI: '#F74902', PIT: '#FCB514', SJS: '#006D75', SEA: '#68A2B9',
  STL: '#002F87', TBL: '#002868', TOR: '#00205B', UTA: '#6CACE4', VAN: '#00205B',
  VGK: '#ffb81c', WSH: '#C8102E', WPG: '#041E42',
};
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
// Remembered Markets pick: localStorage only, same local-only pattern as
// the parlay — nothing leaves the browser.
const LS_MARKET_KEY = 'bueno-nhl-market-v1';
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
    const r = await dataFetch(`data/${dateStr}.json`, { headers: { 'Accept': 'application/json' } });
    if (!r.ok) return null;
    const d = await r.json();
    if (!d || d.date !== dateStr || !Array.isArray(d.games)) return null;
    pre = d;
  } catch (e) { return null; }
  if (!pre.games.length) return { empty: true };
  // Health smell test: a degraded bundle (every goalie a flat .900 AND no
  // zone shots — the data builder's known throttle failure) is unusable.
  // Returning null here takes the normal live-fallback path below instead
  // of pricing skaters off defaults.
  {
    const svVals = Object.values(pre.goalieSv || {}).flatMap((v) =>
      (typeof v === 'number' ? [v] : Object.values(v || {})));
    const flatGoalies = svVals.length > 0 && svVals.every((v) => v === 0.9);
    const noZoneShots = !pre.zoneShots || !Object.keys(pre.zoneShots).length;
    if (flatGoalies && noZoneShots) return null;
  }
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
  state.zoneShots = pre.zoneShots || {};
  state.recentIds = recentIds;
  return { games, pbps, rosterMap, recentIds, zonePbps, zoneShots: pre.zoneShots || {}, goalieSv: pre.goalieSv || {}, lines: pre.lines || {} };
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
  const { games, pbps, rosterMap, recentIds, zonePbps, zoneShots, goalieSv } = ctx;
  const dfoLines = ctx.lines || {};
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
  // zone shots per skater: tonight's pbp + recent finals for their team.
  // zoneByPid feeds the MODEL (old shotsFromPbp, frozen behavior);
  // displayByPid feeds the DISPLAY maps (goals + per-period rotation).
  const zoneByPid = {};
  const displayByPid = {};
  defs.forEach((d) => { zoneByPid[d.pid + ':' + d.gameId] = []; displayByPid[d.pid + ':' + d.gameId] = []; });
  const pushZone = (pbp, onlyPid) => {
    if (!pbp) return;
    const dmap = displayShotsByPid(pbp);
    for (const d of defs) {
      if (onlyPid && d.pid !== onlyPid) continue;
      const key = d.pid + ':' + d.gameId;
      if (!zoneByPid[key]) continue;
      const shots = shotsFromPbp(pbp, d.pid);
      // only count shots where the shooter's team matches (avoid traded-player noise)
      zoneByPid[key].push(...shots);
      displayByPid[key].push(...(dmap[d.pid] || []));
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
    // goalieSv is per-team ({away, home}) in new bundles: a skater faces
    // the OPPOSING team's goalie. Older bundles hold one number per game.
    const gsEntry = goalieSv[d.gameId];
    const oppSv = (typeof gsEntry === 'number')
      ? gsEntry
      : (gsEntry ? ((d.team === g.awayTeam.abbrev ? gsEntry.home : gsEntry.away) || 0.900) : 0.900);
    const m = computeProb(s, z.share, oppSv, d.pos);
    return {
      ...d, ...s, zone: z, oppSv, oppAbbr,
      p: m.p, lam: m.lam, factors: m.factors,
      fair: fairOdds(m.p),
      isLongshot: m.p <= LONGSHOT_DISPLAY_P,
      markets: computeMarkets(s, d.pos),
      shots: zoneByPid[d.pid + ':' + d.gameId] || [],
      matchupShots: displayByPid[d.pid + ':' + d.gameId] || [],
      // Season shots from the bundle (display only — the model's zone factor
      // above still uses the load-time window). Live-path bundles predate
      // zoneShots, so those rows fall back in heatMapShots().
      seasonShots: ((zoneShots || {})[d.pid] || []).map(([x, y, gl]) => ({ x, y, goal: gl === 1 })),
    };
  });
  /* ---------------- lines ----------------
     Real line combinations come from Daily Faceoff, baked into the
     precomputed bundle by the data builder (build.js step 8) and matched
     to skaters by normalized name. Skaters DFO doesn't cover fall back
     to a TOI estimate that only fills line slots DFO left open, and are
     always labeled "est." — never presented as confirmed. */
  const normName = (n) => (n || '').normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  for (const r of state.skaters) {
    const tl = dfoLines[r.team];
    const hit = tl && tl.players ? tl.players[normName(r.name)] : null;
    if (!hit) continue;
    if (hit.line) { r.line = hit.line; r.lineEst = false; }
    if (hit.pos) r.linePos = hit.pos;
    if (hit.pp) r.ppUnit = hit.pp;
  }
  const FWD_POS = new Set(['C', 'L', 'R']);
  const fwdsByTeamGame = {};
  for (const r of state.skaters) {
    if (!FWD_POS.has(r.pos)) continue;
    if (r.line) continue; // DFO line already set
    const k = r.team + ':' + r.gameId;
    (fwdsByTeamGame[k] = fwdsByTeamGame[k] || []).push(r);
  }
  for (const k of Object.keys(fwdsByTeamGame)) {
    const [team, gid] = k.split(':');
    // open slots per line after DFO assignments
    const open = { L1: 3, L2: 3, L3: 3, L4: 3 };
    for (const s of state.skaters) {
      if (s.team === team && String(s.gameId) === gid && s.line && open[s.line] != null) open[s.line]--;
    }
    fwdsByTeamGame[k].sort((a, b) => b.toiMin - a.toiMin);
    for (const r of fwdsByTeamGame[k]) {
      const slot = ['L1', 'L2', 'L3', 'L4'].find((L) => open[L] > 0);
      if (slot) { r.line = slot; open[slot]--; }
      else r.line = null; // extra forward — not on a regular line
      r.lineEst = true;
    }
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
  const names = {}, shots = {}, nums = {};
  for (const r of (pbp.rosterSpots || [])) {
    names[r.playerId] = `${r.firstName.default} ${r.lastName.default}`;
    if (r.headshot) shots[r.playerId] = r.headshot;
    if (r.sweaterNumber != null) nums[r.playerId] = r.sweaterNumber;
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
        scorerNum: nums[det.scoringPlayerId] || '',
        assistNums: aids.map((id) => nums[id] || ''),
        headshot: shots[det.scoringPlayerId] || '',
        assists: aids.map((id) => names[id] || 'Unknown'),
        team: teamOf(det.eventOwnerTeamId),
        period: pd.number,
        periodType: pd.periodType,
        time: p.timeInPeriod || '',
        type: goalTypeFromSituation(p.situationCode, scoredByHome, pd.periodType === 'SO', !!det.penaltyShot),
        awayScore: det.awayScore, homeScore: det.homeScore,
        shotType: det.shotType || '',
        x: det.xCoord != null ? det.xCoord : (p.details && p.details.xCoord),
        y: det.yCoord != null ? det.yCoord : (p.details && p.details.yCoord),
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
  const playBtn = inModel
    ? `<button class="goal-play" data-pid="${gl.scorerId}" data-gid="${gl.gameId}" aria-label="View ${esc(gl.scorer)}">▶</button>`
    : '';
  return `<div class="goal-item">
    <img class="headshot" src="${hs}" alt="" ${imgFallback}>
    ${playBtn}
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
  // Unified league-wide timeline: all goals, newest first
  const allGoals = [];
  for (const g of state.games) {
    if (!g.pbp) continue;
    for (const gl of extractGoals(g.pbp, g)) {
      allGoals.push({ ...gl, gameAway: g.away, gameHome: g.home });
    }
  }
  if (!allGoals.length) {
    const hasData = state.games.some((g) => g.pbp);
    feed.innerHTML = hasData
      ? '<p class="muted">No goals yet tonight.</p>'
      : '<p class="muted">No game data yet — check back once games start.</p>';
    return;
  }
  // sort newest first (by game start + period/time — approximate via reverse)
  allGoals.reverse();
  feed.innerHTML = `<div class="goal-timeline">${allGoals.map((gl) => {
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
        <div class="goal-meta muted small">${esc(gl.gameAway)} @ ${esc(gl.gameHome)} · ${perLabel} ${esc(gl.time)}${gl.shotType ? ' · ' + esc(gl.shotType) : ''}</div>
      </div>
      <div class="goal-right">
        <span class="gtype gtype-${gl.type.toLowerCase()}">${GOAL_TYPE_LABEL[gl.type] || gl.type}</span>
        <div class="goal-score num">${gl.awayScore}–${gl.homeScore}</div>
      </div>
    </div>`;
  }).join('')}</div>`;
  feed.querySelectorAll('.pname').forEach((b) =>
    b.addEventListener('click', () => openPlayer(b.dataset.pid, b.dataset.gid)));
  feed.querySelectorAll('.goal-play').forEach((b) =>
    b.addEventListener('click', () => openPlayer(b.dataset.pid, b.dataset.gid)));
  // Goal type badges replay the animation — attach goal data
  feed.querySelectorAll('.gtype').forEach((badge, i) => {
    badge.classList.add('gtype-clickable');
    badge._goal = allGoals[i];
  });
}
/* ---------------- EVERY GOAL — live visual (header of the goal feed) ----------------
   The Every Goal video's look, live: a rink map of EVERY goal tonight
   (not just card calls), a scores rail, and a spotlight card that plays
   the night back in the order the goals went in. It renders into
   #egWrap, inserted at the top of this view directly above #goalsFeed;
   the feed below it is untouched. Data is the play-by-play the page
   already keeps live in state.games through the /nhl-api proxy (the
   two-tier refresh below) — the only fetch this visual adds is the
   scorer's EDGE season shot-speed chip, via the same edgeFetch route
   and explicit season form the player card uses. Factual only: shot
   type, distance, assists, season goal #, EDGE season hardest/average.
   No model probabilities, no call labels, no prices. */
const egState = {
  goals: [],        // chronological; shootout goals excluded
  idx: -1,          // spotlight index into goals
  spotKey: null,    // key of the spotlighted goal (stable across refreshes)
  follow: true,     // spotlight rides the latest goal until a manual jump
  playing: true,    // autoplay until a manual jump pauses it
  timer: null,
  sig: '',          // last rendered signature — skip no-change renders
  edge: new Map(),  // pid -> Promise<{top, avg} | null>
};
const EG_PER = { 1: '1ST', 2: '2ND', 3: '3RD', 4: 'OT' };
function egPerLabel(gl) {
  return gl.periodType === 'OT' ? 'OT' : (EG_PER[gl.period] || ('P' + gl.period));
}
function egWrapEl() {
  let w = $('egWrap');
  if (w) return w;
  const view = $('view-goals');
  if (!view) return null;
  w = document.createElement('div');
  w.id = 'egWrap';
  w.className = 'eg-wrap';
  view.appendChild(w);
  w.addEventListener('click', (ev) => {
    const t = ev.target.closest('[data-eg]');
    if (!t) return;
    const n = egState.goals.length;
    const act = t.dataset.eg;
    if (act === 'jump') egJump(+t.dataset.i);
    else if (act === 'prev' && n) egJump((egState.idx - 1 + n) % n);
    else if (act === 'next' && n) egJump((egState.idx + 1) % n);
    else if (act === 'play') { egState.playing = !egState.playing; egRender(); }
  });
  return w;
}
function egJump(i) {
  const n = egState.goals.length;
  if (!n || i < 0 || i >= n) return;
  egState.idx = i;
  egState.spotKey = egState.goals[i].key;
  egState.follow = i === n - 1;
  egState.playing = false; // a manual jump pauses autoplay; ▶ resumes
  egRender();
}
/* Every non-shootout goal on tonight's slate, oldest first. Shot
   coordinates are normalized exactly like the video renderer's: if
   x < 0, negate x and y so every goal attacks the right net, and the
   distance is the feet from (x, y) to the goal line at x = 89. */
function egCollect() {
  const out = [];
  for (const g of state.games) {
    const pbp = g.pbp;
    if (!pbp || !Array.isArray(pbp.plays) || !pbp.homeTeam || !pbp.awayTeam) continue;
    const names = {}, shots = {};
    for (const r of (pbp.rosterSpots || [])) {
      names[r.playerId] = `${r.firstName.default} ${r.lastName.default}`;
      if (r.headshot) shots[r.playerId] = r.headshot;
    }
    const homeId = pbp.homeTeam.id;
    const startMs = g.startUTC ? Date.parse(g.startUTC) : NaN;
    for (const p of pbp.plays) {
      if (p.typeDescKey !== 'goal') continue;
      const pd = p.periodDescriptor || {};
      if (pd.periodType === 'SO') continue; // shootout goals never count
      const det = p.details || {};
      const byHome = det.eventOwnerTeamId === homeId;
      const tp = String(p.timeInPeriod || '0:00').split(':');
      const tsec = (+tp[0] || 0) * 60 + (+tp[1] || 0);
      let x = det.xCoord != null ? det.xCoord : null;
      let y = det.yCoord != null ? det.yCoord : null;
      let dist = null;
      if (x != null && y != null) {
        if (x < 0) { x = -x; y = -y; }
        dist = Math.round(Math.hypot(89 - x, y));
      }
      out.push({
        key: `${g.id}:${p.sortOrder != null ? p.sortOrder : (p.eventId || '')}`,
        gameId: g.id, away: g.away, home: g.home,
        scorerId: det.scoringPlayerId,
        scorer: names[det.scoringPlayerId] || 'Unknown',
        team: byHome ? g.home : g.away,
        headshot: shots[det.scoringPlayerId] || '',
        assists: [det.assist1PlayerId, det.assist2PlayerId].filter(Boolean)
          .map((id) => names[id]).filter(Boolean),
        period: pd.number || 0, periodType: pd.periodType || 'REG',
        time: p.timeInPeriod || '',
        type: goalTypeFromSituation(p.situationCode, byHome, false, !!det.penaltyShot),
        shotType: (det.shotType || '').toUpperCase(),
        x, y, dist,
        seasonGoal: det.scoringPlayerTotal || null,
        aScore: det.awayScore != null ? det.awayScore : null,
        hScore: det.homeScore != null ? det.homeScore : null,
        // approximate wall-clock: game start + elapsed periods (45 min
        // blocks incl. intermission) — orders goals across games.
        wall: (isFinite(startMs) ? startMs : 0) + ((pd.number || 1) - 1) * 2700000 + tsec * 1000,
        order: p.sortOrder || 0,
      });
    }
  }
  out.sort((a, b) => (a.wall - b.wall) || (a.order - b.order));
  return out;
}
function egRailData() {
  return state.games.map((g) => {
    let a = 0, h = 0, status = '';
    const pbp = g.pbp;
    if (pbp && pbp.awayTeam && pbp.homeTeam) {
      a = pbp.awayTeam.score || 0;
      h = pbp.homeTeam.score || 0;
    }
    const fin = g.state === 'OFF' || g.state === 'FINAL'
      || (pbp && (pbp.gameState === 'OFF' || pbp.gameState === 'FINAL'));
    const live = g.state === 'LIVE' || g.state === 'CRIT'
      || (pbp && (pbp.gameState === 'LIVE' || pbp.gameState === 'CRIT'));
    if (fin) status = 'FINAL';
    else if (live && pbp && pbp.periodDescriptor) {
      const pd = pbp.periodDescriptor;
      const per = pd.periodType === 'SO' ? 'SO' : (EG_PER[pd.number] || ('P' + (pd.number || '')));
      status = per + (pbp.clock && pbp.clock.timeRemaining ? ` · ${pbp.clock.timeRemaining}` : '');
    } else if (g.startUTC) {
      try { status = new Date(g.startUTC).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); }
      catch (e) { status = ''; }
    }
    return { a, h, status };
  });
}
function egRailHtml(spotGameId) {
  const data = egRailData();
  const rows = state.games.map((g, i) => {
    const on = spotGameId != null && String(g.id) === String(spotGameId) ? ' on' : '';
    return `<div class="eg-rail-row${on}">
      <img class="eg-rail-logo" src="${teamLogoUrl(g.away)}" alt="${esc(g.away)}" ${imgFallback}>
      <span class="eg-rail-score">${data[i].a} – ${data[i].h}</span>
      <img class="eg-rail-logo" src="${teamLogoUrl(g.home)}" alt="${esc(g.home)}" ${imgFallback}>
      <span class="eg-rail-status">${esc(data[i].status)}</span>
    </div>`;
  }).join('');
  return `<div class="eg-rail"><div class="eg-rail-h">SCORES</div>${rows}</div>`;
}
/* Clock-only rail updates land in place, so the 10s fast tier never
   restarts the rink's draw-in animation. */
function egUpdateRail() {
  const wrap = $('egWrap');
  if (!wrap || wrap.style.display === 'none') return;
  const rows = wrap.querySelectorAll('.eg-rail-row');
  const data = egRailData();
  if (!rows.length || rows.length !== data.length) return;
  rows.forEach((row, i) => {
    const sc = row.querySelector('.eg-rail-score');
    const st = row.querySelector('.eg-rail-status');
    const sTxt = `${data[i].a} – ${data[i].h}`;
    if (sc && sc.textContent !== sTxt) sc.textContent = sTxt;
    if (st && st.textContent !== data[i].status) st.textContent = data[i].status;
  });
}
/* Half-rink in the video's geometry: window x in [-15, 100], y in
   [-42.5, 42.5]; red line x=0, blue line x=25, goal line x=89, crease
   at (89, 0), faceoff circles at (69, ±22). Attacks the right net. */
function egRinkSvg() {
  const goals = egState.goals, idx = egState.idx;
  const X = (fx) => (fx + 15).toFixed(1);
  const Y = (fy) => (42.5 - fy).toFixed(1);
  let s = '<svg class="eg-rink" viewBox="0 0 115 85" role="img" aria-label="Map of tonight\'s goals">';
  s += '<defs><linearGradient id="egIce" x1="0" y1="0" x2="0" y2="1">'
    + '<stop offset="0" stop-color="#172941"/><stop offset="1" stop-color="#0c1626"/></linearGradient></defs>';
  s += '<rect x="0.4" y="0.4" width="114.2" height="84.2" rx="4" fill="url(#egIce)" stroke="rgba(165,195,255,.35)" stroke-width="0.5"/>';
  s += `<line x1="${X(0)}" y1="1" x2="${X(0)}" y2="84" stroke="rgba(255,110,110,.45)" stroke-width="0.8"/>`;
  s += `<line x1="${X(25)}" y1="1" x2="${X(25)}" y2="84" stroke="rgba(110,160,255,.5)" stroke-width="1.4"/>`;
  s += `<line x1="${X(89)}" y1="1" x2="${X(89)}" y2="84" stroke="rgba(255,110,110,.5)" stroke-width="0.5"/>`;
  for (const fy of [22, -22]) {
    s += `<circle cx="${X(69)}" cy="${Y(fy)}" r="15" fill="none" stroke="rgba(160,200,255,.4)" stroke-width="0.5"/>`;
    s += `<circle cx="${X(69)}" cy="${Y(fy)}" r="1.1" fill="rgba(255,110,110,.85)"/>`;
  }
  s += `<path d="M ${X(89)} ${Y(6)} A 6 6 0 0 0 ${X(89)} ${Y(-6)} Z" fill="rgba(110,170,255,.30)" stroke="rgba(255,110,110,.7)" stroke-width="0.4"/>`;
  s += `<rect x="${X(88.2)}" y="${Y(3)}" width="2.4" height="6" fill="rgba(255,80,80,.18)" stroke="#ff5050" stroke-width="0.6"/>`;
  const spot = goals[idx];
  if (spot && spot.x != null && spot.y != null) {
    const sx = spot.x + 15, sy = 42.5 - spot.y;
    const nx = 88.2 + 15, ny = 42.5;
    const mx = (sx + nx) / 2, my = (sy + ny) / 2;
    const d = Math.max(1, Math.hypot(nx - sx, ny - sy));
    // the video's bend: bow toward center ice, gentler near the middle
    const bend = d * 0.14 * (Math.abs(spot.y) > 4 ? 1 : 0.4);
    const cy = my + (spot.y >= 0 ? bend : -bend);
    s += `<path class="eg-path" pathLength="100" d="M ${sx.toFixed(1)} ${sy.toFixed(1)} Q ${mx.toFixed(1)} ${cy.toFixed(1)} ${nx.toFixed(1)} ${ny.toFixed(1)}"/>`;
    s += `<circle class="eg-ring" cx="${sx.toFixed(1)}" cy="${sy.toFixed(1)}" r="3.6"/>`;
  }
  goals.forEach((gl, i) => {
    if (gl.x == null || gl.y == null) return;
    s += `<circle class="eg-dot${i === idx ? ' on' : ''}" data-eg="jump" data-i="${i}" cx="${(gl.x + 15).toFixed(1)}" cy="${(42.5 - gl.y).toFixed(1)}" r="${i === idx ? 2.1 : 1.5}"/>`;
  });
  return s + '</svg>';
}
function egHeadHtml(nGoals) {
  const d = new Date(state.date + 'T12:00:00');
  const dl = isNaN(d) ? '' : d.toLocaleDateString('en-US',
    { weekday: 'long', month: 'long', day: 'numeric' }).toUpperCase();
  const g = state.games.length;
  const parts = [dl, `${g} GAME${g === 1 ? '' : 'S'}`, `${nGoals} GOAL${nGoals === 1 ? '' : 'S'}`]
    .filter(Boolean);
  return `<div class="eg-head"><h3 class="eg-title">EVERY GOAL</h3>`
    + `<p class="eg-sub">${esc(parts.join(' · '))}</p></div>`;
}
function egCardHtml() {
  const goals = egState.goals, i = egState.idx, gl = goals[i];
  if (!gl) return '';
  const hs = gl.headshot ? esc(gl.headshot) : headshotUrl(gl.team, gl.scorerId);
  const ring = TEAM_COLORS[gl.team] || '#f5b942';
  let line = `${gl.away} @ ${gl.home} · ${egPerLabel(gl)} ${gl.time}`;
  if (gl.assists.length) line += ` · ASSISTS ${gl.assists.join(', ')}`;
  const chips = [];
  const shotBits = [gl.shotType, gl.dist != null ? `${gl.dist} FT` : ''].filter(Boolean).join(' · ');
  if (shotBits) chips.push(`<span class="eg-chip eg-chip-mut">${esc(shotBits)}</span>`);
  if (gl.type === 'PP') chips.push('<span class="eg-chip eg-chip-gold">POWER PLAY</span>');
  else if (gl.type === 'SH') chips.push('<span class="eg-chip eg-chip-gold">SHORT-HANDED</span>');
  else if (gl.type === 'EN') chips.push('<span class="eg-chip eg-chip-gold">EMPTY NET</span>');
  else if (gl.type === 'PS') chips.push('<span class="eg-chip eg-chip-gold">PENALTY SHOT</span>');
  if (gl.seasonGoal) chips.push(`<span class="eg-chip eg-chip-teal">SEASON GOAL #${gl.seasonGoal}</span>`);
  return `<div class="eg-card">
    <img class="pavatar eg-face" src="${hs}" alt="" ${imgFallback} style="border-color:${ring}">
    <div class="eg-card-main">
      <div class="eg-kicker">GOAL ${i + 1} OF ${goals.length}</div>
      <div class="eg-name">${esc(gl.scorer)}</div>
      <div class="eg-line">${esc(line)}</div>
      <div class="eg-chips">${chips.join('')}</div>
    </div>
    <span class="eg-edge-slot"></span>
  </div>`;
}
function egProgressHtml() {
  const goals = egState.goals;
  const dots = goals.map((gl, i) =>
    `<button type="button" class="eg-pdot${i <= egState.idx ? ' seen' : ''}${i === egState.idx ? ' cur' : ''}" data-eg="jump" data-i="${i}" aria-label="Goal ${i + 1}"></button>`).join('');
  return `<div class="eg-progress">
    <button type="button" class="eg-navbtn" data-eg="prev" aria-label="Previous goal">‹</button>
    <div class="eg-pdots">${dots}</div>
    <button type="button" class="eg-navbtn" data-eg="play" aria-label="${egState.playing ? 'Pause' : 'Play'}">${egState.playing ? '❚❚' : '▶'}</button>
    <button type="button" class="eg-navbtn" data-eg="next" aria-label="Next goal">›</button>
  </div>
  <p class="eg-order">${goals.length} GOALS · IN THE ORDER THEY WENT IN</p>`;
}
function egFeedHtml() {
  const goals = egState.goals;
  const rows = goals.map((gl, i) => ({ gl, i })).reverse().map(({ gl, i }) => {
    const hs = gl.headshot ? esc(gl.headshot) : headshotUrl(gl.team, gl.scorerId);
    const shot = gl.shotType
      ? gl.shotType.charAt(0) + gl.shotType.slice(1).toLowerCase() : '';
    const parts = [`${egPerLabel(gl)} ${gl.time}`, shot,
      gl.dist != null ? `${gl.dist} ft` : ''].filter(Boolean);
    return `<button type="button" class="eg-frow${i === egState.idx ? ' on' : ''}" data-eg="jump" data-i="${i}">
      <img class="pavatar" src="${hs}" alt="" ${imgFallback}>
      <span class="eg-frow-main">
        <span class="eg-frow-name">${esc(gl.scorer)}</span>
        <span class="eg-frow-meta">${esc(parts.join(' · '))}</span>
      </span>
      <span class="eg-frow-teams">
        <img src="${teamLogoUrl(gl.away)}" alt="${esc(gl.away)}" ${imgFallback}>
        <span class="eg-frow-score">${gl.aScore != null ? gl.aScore : 0} – ${gl.hScore != null ? gl.hScore : 0}</span>
        <img src="${teamLogoUrl(gl.home)}" alt="${esc(gl.home)}" ${imgFallback}>
      </span>
    </button>`;
  }).join('');
  return `<div class="eg-feed">${rows}</div>`;
}
/* EDGE season shot speed for the spotlighted scorer — same endpoint
   and season form as the player card's EDGE section, fail-soft: no
   chip when the scorer has no EDGE record. */
function egEdgePromise(pid) {
  if (!egState.edge.has(pid)) {
    egState.edge.set(pid, edgeFetch(`skater-shot-speed-detail/${pid}/${EDGE_PATH}`)
      .then((d) => {
        const sd = d && d.shotSpeedDetails;
        const top = sd && sd.topShotSpeed ? edgeNum(sd.topShotSpeed.imperial) : null;
        const avg = sd && sd.avgShotSpeed ? edgeNum(sd.avgShotSpeed.imperial) : null;
        return (top != null && avg != null && top > 0 && avg > 0) ? { top, avg } : null;
      })
      .catch(() => null));
  }
  return egState.edge.get(pid);
}
function egFillEdge() {
  const gl = egState.goals[egState.idx];
  const wrap = $('egWrap');
  if (!gl || !gl.scorerId || !wrap) return;
  const key = gl.key;
  egEdgePromise(gl.scorerId).then((res) => {
    if (!res) return;
    const cur = egState.goals[egState.idx];
    if (!cur || cur.key !== key) return; // spotlight moved on
    const slot = wrap.querySelector('.eg-edge-slot');
    if (slot) slot.innerHTML = `<span class="eg-chip eg-chip-gold">SEASON HARDEST ${res.top.toFixed(1)} MPH · AVG ${res.avg.toFixed(1)}</span>`;
  });
}
function egRender() {
  const wrap = egWrapEl();
  if (!wrap) return;
  const goals = egState.goals;
  const spot = goals[egState.idx];
  const railSig = state.games.map((g) => {
    const pbp = g.pbp;
    return `${g.id}:${pbp && pbp.awayTeam ? pbp.awayTeam.score : ''}-${pbp && pbp.homeTeam ? pbp.homeTeam.score : ''}:${g.state}`;
  }).join('|');
  const sig = goals.map((x) => x.key).join(',') + '#' + egState.idx + '#'
    + (egState.playing ? 1 : 0) + '#' + railSig + '#' + (spot ? spot.gameId : '');
  if (sig === egState.sig) return;
  egState.sig = sig;
  if (!goals.length) {
    wrap.innerHTML = egHeadHtml(0)
      + `<div class="eg-main">${egRinkSvg()}${egRailHtml(null)}</div>`
      + '<p class="eg-quiet">The first goal tonight will light this up.</p>';
    return;
  }
  wrap.innerHTML = egHeadHtml(goals.length)
    + `<div class="eg-main">${egRinkSvg()}${egRailHtml(spot ? spot.gameId : null)}</div>`
    + egCardHtml() + egProgressHtml() + egFeedHtml();
  egFillEdge();
}
function egStartTimer() {
  if (egState.timer) return;
  egState.timer = setInterval(() => {
    if (typeof document !== 'undefined' && document.hidden) return;
    if (state.view !== 'goals' || !egState.playing) return;
    const n = egState.goals.length;
    if (n < 2 || egState.idx < 0) return;
    egState.idx = (egState.idx + 1) % n;
    egState.spotKey = egState.goals[egState.idx].key;
    egState.follow = egState.idx === n - 1;
    egRender();
  }, 2500);
}
function renderLiveGoals() {
  const wrap = egWrapEl();
  if (!wrap) return;
  if (!state.games.length) { // no slate today: the visual hides
    wrap.style.display = 'none';
    if (egState.sig !== 'hidden') { wrap.innerHTML = ''; egState.sig = 'hidden'; }
    egState.goals = [];
    egState.spotKey = null;
    return;
  }
  wrap.style.display = '';
  const goals = egCollect();
  let idx = goals.findIndex((x) => x.key === egState.spotKey);
  if (egState.follow || idx < 0) idx = goals.length - 1; // default: latest goal
  egState.goals = goals;
  egState.idx = idx;
  egState.spotKey = idx >= 0 ? goals[idx].key : null;
  egStartTimer();
  egRender();
  egUpdateRail();
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
function pnameBtn(r, compact) {
  const hs = r.headshot || headshotUrl(r.team, r.pid);
  return `<button class="pname" data-pid="${r.pid}" data-gid="${r.gameId}"><img class="pavatar" src="${esc(hs)}" alt="" ${imgFallback}>${esc(r.name)}${typeBadgeHtml(r.pid, compact)}</button>`;
}
/* ---------------- market heat (good-bet glow) ----------------
   Every market table scores each name: green = the model's strongest
   looks tonight, yellow = middle of the pack, red = weakest. The score
   blends the skater's percentile within tonight's market (60%) with his
   raw probability against the market's elite reference (40%), so green
   takes both relative and absolute strength. Bands are computed at
   render time from the currently priced skaters, so the heat re-scores
   on every refresh \u2014 as lineups confirm and goalies lock in, names move. */
const HEAT_REF = { atg: 0.45, twoplus: 0.25, firstgoal: 0.10, shots: 0.75, assists: 0.65, points: 0.55, longshot: 0.12 };
function heatBandOf(score) { return score >= 67 ? 'hot' : score >= 40 ? 'mid' : 'cold'; }
function heatBands(rows, getP, ref) {
  const vals = rows.map(getP).sort((a, b) => a - b);
  const n = vals.length;
  const m = new Map();
  if (!n) return m;
  for (const r of rows) {
    const v = getP(r);
    let below = 0;
    while (below < n && vals[below] < v) below++;
    let ties = 0;
    while (below + ties < n && vals[below + ties] === v) ties++;
    const rank = below + Math.max(0, ties - 1) / 2;
    const pctile = n > 1 ? (rank / (n - 1)) * 100 : 50;
    const abs = Math.min(100, (v / ref) * 100);
    m.set(r.pid, heatBandOf(0.6 * pctile + 0.4 * abs));
  }
  return m;
}
const HEAT_LEGEND = '<p class="muted small heat-legend"><span class="heat-dot hot"></span>Model\'s strongest tonight <span class="heat-dot mid"></span>middle <span class="heat-dot cold"></span>weakest \u00b7 heat re-scores as lineups confirm</p>';
function probTableHtml(rows, pKey, fairKey, bands, v) {
  return rows.map((r) => {
    const b = bands ? bands.get(r.pid) : null;
    return `
    <tr${b ? ` class="heat-row ${b}"` : ''}>
      <td>${b ? `<span class="heat-dot ${b}"></span>` : ''}${pnameBtn(r, true)}</td>
      <td><span class="team-cell"><img src="${teamLogoUrl(r.team)}" alt="" ${imgFallback}>${esc(r.team)}</span></td>
      <td class="num"><strong>${pct1(r[pKey])}</strong></td>
      <td class="num">${r[fairKey]}</td>
      ${v ? `<td class="num">${addBtnHtml(r, v)}</td>` : ''}
    </tr>`;
  }).join('');
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
  const l1tag = r.line === 'L1' ? ` <span class="muted small" title="${r.lineEst === false ? 'First line (Daily Faceoff)' : 'Estimated first line'} — opening-shift premium applied">L1</span>` : '';
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
  try { localStorage.setItem(LS_MARKET_KEY, kind); } catch (e) { /* storage unavailable */ }
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
  renderLeaders();
}
/* Goals tab filters: player-name search + game dropdown. Both combine
   with each other and with the goal-type dropdown; they filter the
   already-loaded rows, no new requests. */
/* Remembered market: restore the last Markets pick once per load (called
   from renderAll before the first setMarketKind). Missing or invalid
   stored values fall back to Anytime via setMarketKind's validation. */
let marketKindRestored = false;
function restoreMarketKind() {
  if (marketKindRestored) return;
  marketKindRestored = true;
  try {
    const v = localStorage.getItem(LS_MARKET_KEY);
    if (v && MARKET_SUBS[v]) state.marketKind = v;
  } catch (e) { /* storage unavailable — Anytime default stands */ }
}
/* Bottom-nav live badge: "N live" on Top Shelf while games are live,
   counted with the same isWatchable check the live ticks use. Clears
   when nothing is live; refreshed on slate load and every live tick. */
function syncLiveBadge() {
  const badge = $('bnavLiveBadge');
  if (!badge) return;
  const n = (state.games || []).filter(isWatchable).length;
  if (n > 0) { badge.textContent = `${n} live`; badge.hidden = false; }
  else badge.hidden = true;
}
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
    const all = twoPlusProbs();
    html = probTableHtml(filterGoalRows(all), 'tpP', 'tpFair', heatBands(all, (r) => r.tpP, HEAT_REF.twoplus), 'twoplus');
  } else if (type === 'firstgoal') {
    const all = firstGoalProbs();
    html = probTableHtml(filterGoalRows(all), 'fgP', 'fgFair', heatBands(all, (r) => r.fgP, HEAT_REF.firstgoal), 'firstgoal');
  } else {
    const bands = heatBands(state.skaters, (r) => r.p, HEAT_REF.atg);
    const rows = filterGoalRows(state.skaters.slice().sort((a, b) => b.p - a.p));
    html = rows.map((r) => { const b = bands.get(r.pid); return `
    <tr class="heat-row ${b}">
      <td><span class="heat-dot ${b}"></span>${pnameBtn(r, true)}</td>
      <td><span class="team-cell"><img src="${teamLogoUrl(r.team)}" alt="" ${imgFallback}>${esc(r.team)}</span></td>
      <td class="num"><strong>${pct1(r.p)}</strong></td>
      <td class="num">${r.fair}</td>
      <td class="num">${addBtnHtml(r, 'atg')}</td>
    </tr>`; }).join('');
  }
  tb.innerHTML = html || '<tr><td colspan="5" class="muted">No skaters match.</td></tr>';
  wirePnameClicks(tb);
}
async function renderSlate() {
  const grid = $('gamesGrid');
  const d = new Date(state.date + 'T12:00:00');
  $('slateTitle').textContent = 'Slate — ' + d.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' });
  const stMap = await getStandings().catch(() => ({}));
  const rec = (abbr) => { const s = stMap[abbr]; return s ? `${s.wins}-${s.losses}-${s.otLosses}` : ''; };
  // model odds: ML, puck line (-1.5), total — from Poisson team totals
  const oddsHtml = (g) => {
    try {
      const lamA = simUnits(state.skaters, g.id, g.away).total;
      const lamB = simUnits(state.skaters, g.id, g.home).total;
      if (!lamA || !lamB) return '';
      const wp = matchupWinProb(lamA, lamB);
      const mlA = fairOdds(wp.a), mlB = fairOdds(wp.b);
      const total = (lamA + lamB).toFixed(1);
      // puck line: P(win by 2+)
      let plA = 0, plB = 0;
      for (let i = 0; i <= 15; i++) for (let j = 0; j <= 15; j++) {
        const p = poissonPmf(i, lamA) * poissonPmf(j, lamB);
        if (i - j >= 2) plA += p;
        if (j - i >= 2) plB += p;
      }
      const favA = wp.a >= wp.b;
      const plFav = favA ? fairOdds(plA) : fairOdds(plB);
      const plDog = favA ? fairOdds(1 - plB) : fairOdds(1 - plA);
      const colA = TEAM_COLORS[g.away] || '#7d90a5', colB = TEAM_COLORS[g.home] || '#7d90a5';
      return `<div class="game-odds"><span class="pill"><span class="lbl">ML</span><span class="dot" style="background:${colA}"></span><b>${esc(g.away)} ${mlA}</b><span class="sep">·</span><span class="dot" style="background:${colB}"></span><b>${esc(g.home)} ${mlB}</b></span><span class="pill"><span class="lbl">PL</span><b>${favA ? esc(g.away) + ' −1.5' : esc(g.home) + ' −1.5'} ${plFav}</b></span><span class="pill"><span class="lbl">Total</span><b>${total}</b></span></div>`;
    } catch (e) { return ''; }
  };
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
        <span class="team"><img src="${teamLogoUrl(g.away)}" alt="" ${imgFallback}>${esc(g.away)}<span class="team-rec">${rec(g.away)}</span></span>
        <span class="muted">@</span>
        <span class="team"><img src="${teamLogoUrl(g.home)}" alt="" ${imgFallback}>${esc(g.home)}<span class="team-rec">${rec(g.home)}</span></span>
      </div>
      <div class="score-line"><span>${as}</span><span>${hs}</span></div>
      <div class="game-meta"><span>${gameStatusText(g)}</span>${sogHtml}</div>
      ${oddsHtml(g)}
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
/* ---------------- lineup (estimated from TOI rank) ---------------- */
function lineupCellHtml(r, isSelf) {
  const last = r.name.split(' ').slice(-1)[0];
  return `<div class="lu-cell${isSelf ? ' self' : ''}" data-pid="${r.pid}" data-gid="${r.gameId}" role="button" tabindex="0" title="${esc(r.name)}">
    <img class="lu-head" src="${esc(r.headshot)}" alt="" ${imgFallback}>
    <div class="lu-name">${esc(last)}</div>
    <div class="lu-sub muted">${esc(r.linePos || r.pos)} · ${r.toiMin.toFixed(1)}</div>
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
    const POSORD = { LW: 0, C: 1, RW: 2 };
    line.sort((a, b) => ((POSORD[a.linePos] ?? 9) - (POSORD[b.linePos] ?? 9)) || (b.toiMin - a.toiMin));
    html += `<div class="lu-row"><div class="lu-label">L${i}</div><div class="lu-players">${line.map((s) => lineupCellHtml(s, false)).join('')}</div></div>`;
  }
  const hasDfoPairs = defs.some((s) => /^D[123]$/.test(s.line || ''));
  if (hasDfoPairs) {
    for (let i = 1; i <= 3; i++) {
      const pair = defs.filter((s) => s.line === 'D' + i);
      if (!pair.length) continue;
      html += `<div class="lu-row"><div class="lu-label">D${i}</div><div class="lu-players">${pair.map((s) => lineupCellHtml(s, false)).join('')}</div></div>`;
    }
    const extraD = defs.filter((s) => !/^D[123]$/.test(s.line || ''));
    for (let i = 0; i < extraD.length; i += 2) {
      const pair = extraD.slice(i, i + 2);
      html += `<div class="lu-row"><div class="lu-label muted">D</div><div class="lu-players">${pair.map((s) => lineupCellHtml(s, false)).join('')}</div></div>`;
    }
  } else {
    for (let i = 0; i < 3; i++) {
      const pair = defs.slice(i * 2, i * 2 + 2);
      if (!pair.length) continue;
      html += `<div class="lu-row"><div class="lu-label">D${i + 1}</div><div class="lu-players">${pair.map((s) => lineupCellHtml(s, false)).join('')}</div></div>`;
    }
  }
  const bench = rows.filter((s) => ['C', 'L', 'R'].includes(s.pos) && !s.line);
  if (bench.length) {
    html += `<div class="lu-row"><div class="lu-label muted">Bench</div><div class="lu-players">${bench.map((s) => lineupCellHtml(s, false)).join('')}</div></div>`;
  }
  // PP units: Daily Faceoff when available, else estimated from
  // power-play points per game (top 5 → PP1, next 5 → PP2)
  let pp1, pp2;
  if (rows.some((s) => s.ppUnit)) {
    pp1 = rows.filter((s) => s.ppUnit === 'PP1');
    pp2 = rows.filter((s) => s.ppUnit === 'PP2');
  } else {
    const ppRanked = rows.filter((s) => s.gp > 0).sort((a, b) => ((b.ppp || 0) / b.gp) - ((a.ppp || 0) / a.gp));
    pp1 = ppRanked.slice(0, 5); pp2 = ppRanked.slice(5, 10);
  }
  if (pp1.length) {
    html += `<div class="lu-row"><div class="lu-label" style="color:var(--gold)">PP1</div><div class="lu-players">${pp1.map((s) => lineupCellHtml(s, false)).join('')}</div></div>`;
  }
  if (pp2.length) {
    html += `<div class="lu-row"><div class="lu-label" style="color:var(--gold)">PP2</div><div class="lu-players">${pp2.map((s) => lineupCellHtml(s, false)).join('')}</div></div>`;
  }
  return html + '</div>';
}
function matchupLineupHtml(gameId) {
  const g = state.games.find((gg) => String(gg.id) === String(gameId));
  if (!g) return '';
  const a = teamLineupHtml(g.away, gameId);
  const h = teamLineupHtml(g.home, gameId);
  if (!a && !h) return '';
  const anyDfo = state.skaters.some((s) => String(s.gameId) === String(gameId) && (s.lineEst === false || s.ppUnit));
  return `<h4 class="tape-title">Lineup <span class="muted small">${anyDfo ? 'via Daily Faceoff' : 'est. from ice time'}</span></h4><div class="lu-wrap">${a}${h}</div>`;
}
/* ---------------- stat bars (sideways bar graph per stat) ---------------- */
const STATBAR_DEFS = [
  { key: 'gpg', label: 'Goals/GP', max: 0.7, avgF: 0.25, avgD: 0.08, fmt: (v) => v.toFixed(2) },
  { key: 'apg', label: 'Assists/GP', max: 1.0, avgF: 0.35, avgD: 0.25, fmt: (v) => v.toFixed(2) },
  { key: 'ptspg', label: 'Points/GP', max: 1.5, avgF: 0.60, avgD: 0.33, fmt: (v) => v.toFixed(2) },
  { key: 'sogpg', label: 'Shots/GP', max: 5.0, avgF: 2.2, avgD: 1.6, fmt: (v) => v.toFixed(1) },
  { key: 'toi', label: 'TOI', max: 26, avgF: 16, avgD: 20, fmt: (v) => fmtToi(v) },
  { key: 'shpct', label: 'Shoot %', max: 0.20, avgF: 0.105, avgD: 0.06, fmt: (v) => (v * 100).toFixed(1) + '%' },
];
function statBarsHtml(r) {
  const gp = Math.max(r.gp, 1);
  const isD = r.pos === 'D';
  const shots = Number.isFinite(r.shots) ? r.shots : 0;
  const vals = {
    gpg: r.goals / gp,
    apg: r.assists / gp,
    ptspg: r.points / gp,
    sogpg: shots / gp,
    toi: r.toiMin || 0,
    shpct: shots > 0 ? r.goals / shots : 0,
  };
  const rows = STATBAR_DEFS.map((d) => {
    const v = vals[d.key];
    const avg = isD ? d.avgD : d.avgF;
    const pct = Math.min(100, (v / d.max) * 100);
    const avgPct = Math.min(100, (avg / d.max) * 100);
    const elite = pct >= 75;
    return `<div class="sbar-row"><div class="sbar-label">${d.label}</div>`
      + `<div class="sbar-track"><div class="sbar-fill${elite ? ' elite' : ''}" style="width:${pct.toFixed(1)}%"></div>`
      + `<div class="sbar-avg" style="left:${avgPct.toFixed(1)}%"></div></div>`
      + `<div class="sbar-val">${d.fmt(v)}</div></div>`;
  }).join('');
  return `<h4 style="margin:.8rem 0 .3rem">Stat bars <span class="muted small">vs ${isD ? 'defense' : 'forward'} avg</span></h4>`
    + `<div class="sbar-wrap">${rows}</div>`;
}
/* Player bio strip: number, age, position, height, weight, shoots, birthplace */
function playerBioHtml(r, compact) {
  const b = r.bio;
  if (!b) return `<div class="pc-bio${compact ? ' compact' : ''}" data-bio-loading="${esc(String(r.pid))}"><span class="muted small">Loading bio…</span></div>`;
  const age = b.dob ? Math.floor((Date.now() - new Date(b.dob).getTime()) / 3.15576e10) : null;
  const items = [];
  if (b.number != null) items.push(`<span><strong>#${esc(String(b.number))}</strong></span>`);
  if (r.pos) items.push(`<span>${esc(r.pos)}</span>`);
  if (age != null) items.push(`<span>Age ${age}</span>`);
  if (!compact) {
    if (b.dob) items.push(`<span class="muted">Born ${esc(b.dob)}</span>`);
    if (b.height) items.push(`<span>${esc(b.height)}</span>`);
    if (b.weight) items.push(`<span>${esc(b.weight)}</span>`);
    if (b.shoots) items.push(`<span>Shoots ${esc(b.shoots)}</span>`);
    if (b.birthplace) items.push(`<span class="muted">${esc(b.birthplace)}</span>`);
  } else {
    if (b.shoots) items.push(`<span class="muted small">${esc(b.shoots)}</span>`);
  }
  if (!items.length) return '';
  return `<div class="pc-bio${compact ? ' compact' : ''}">${items.join('<span class="pc-bio-sep">·</span>')}</div>`;
}
/* Round-2 card polish: bio folded into a collapsed Details row (closed by
   default) so it no longer pushes the hockey sections down. */
function pcDetailsHtml(r) {
  const b = r.bio;
  if (!b) return `<details class="pc-details" data-bio-loading="${esc(String(r.pid))}"><summary><span>▸ Details</span></summary><p class="muted small">Loading bio…</p></details>`;
  const items = [];
  if (b.height) items.push(esc(b.height));
  if (b.weight) items.push(esc(b.weight));
  if (b.shoots) items.push(`Shoots ${esc(b.shoots)}`);
  if (b.birthplace) items.push(esc(b.birthplace));
  if (b.dob) items.push(`Born ${esc(b.dob)}`);
  if (!items.length) return '';
  return `<details class="pc-details"><summary><span>▸ Details</span></summary><p>${items.join(' · ')}</p></details>`;
}
/* Round-2 card polish: freshest game from last5[0]. Opponent is included
   only if the entry carries one (field name varies by payload); otherwise
   the line shows goals/shots alone. '' when there is no last-5 sample. */
function pcLastGameHtml(l5) {
  const lg = (l5 || [])[0];
  if (!lg) return '';
  const oppRaw = lg.opponent ?? lg.opp ?? lg.oppAbbr ?? lg.opponentAbbr
    ?? (lg.opponentTeam && (lg.opponentTeam.abbrev || lg.opponentTeam.abbr)) ?? null;
  const oppTxt = oppRaw ? ` vs ${esc(String(oppRaw))}` : '';
  return `<div class="pc-lastgame">Last game: <b>${lg.goals ?? 0}G, ${lg.shots ?? 0} SOG</b>${oppTxt}</div>`;
}
/* Lazy-load bio for players who don't have it yet (e.g. live game skaters) */
async function ensurePlayerBio(r) {
  if (r.bio || r._bioLoading) return;
  r._bioLoading = true;
  try {
    const d = await fetchJSON(`${API}/player/${r.pid}/landing`);
    r.bio = {
      number: d.sweaterNumber,
      dob: d.birthDate,
      birthplace: [d.birthCity?.default, d.birthCountry].filter(Boolean).join(', '),
      height: d.heightInInches ? `${Math.floor(d.heightInInches/12)}'${d.heightInInches%12}"` : null,
      weight: d.weightInPounds ? `${d.weightInPounds} lbs` : null,
      shoots: d.shootsCatches,
    };
    const el = document.querySelector(`[data-bio-loading="${r.pid}"]`);
    if (el) el.outerHTML = pcDetailsHtml(r);
    const jn = document.querySelector(`[data-jnum-loading="${r.pid}"]`);
    if (jn && r.bio.number != null) {
      jn.textContent = `#${r.bio.number}`;
      jn.hidden = false;
      jn.removeAttribute('data-jnum-loading');
    }
  } catch (e) { /* bio stays empty */ }
  r._bioLoading = false;
}
/* ---------------- player-card polish (approved draft v2) ----------------
   Tonight strip, team-color header glow, form margin bars, and glowing
   linemate headshots. All values come from data the card already has —
   nothing is invented; a section is omitted when its data isn't there. */
function lightenHex(hex, amt) {
  // mix a #rrggbb color toward white by amt (0..1); falls back to input
  const m = /^#([0-9a-fA-F]{6})$/.exec(hex || '');
  if (!m) return hex || '#888';
  const n = parseInt(m[1], 16);
  const mix = (c) => Math.round(c + (255 - c) * amt);
  return '#' + [mix((n >> 16) & 255), mix((n >> 8) & 255), mix(n & 255)]
    .map((v) => v.toString(16).padStart(2, '0')).join('');
}
function pcTonightHtml(r, g) {
  // Line + PP unit + opposing goalie, all from existing card data.
  // Fields that aren't available are omitted, never faked.
  if (!g) return '';
  const bits = [];
  if (r.line) bits.push(`<b>Line:</b> ${esc(r.line)}${r.lineEst === false ? '' : ' <span class="muted small">est.</span>'}`);
  if (r.ppUnit) bits.push(`<b>PP:</b> ${esc(r.ppUnit)}`);
  const pg = panelGoalie(g, r.oppAbbr);
  if (pg.id) bits.push(`<b>Opposing goalie:</b> ${esc(pg.name)}${pg.tag ? ` <span class="muted small">${esc(pg.tag)}</span>` : ''} · ${(r.oppSv * 100).toFixed(1)}% SV`);
  else if (r.oppSv) bits.push(`<b>Opposing goalie:</b> ${esc(r.oppAbbr)} · ${(r.oppSv * 100).toFixed(1)}% SV`);
  if (!bits.length) return '';
  const caseBits = [];
  if (r.line === 'L1') caseBits.push('top line');
  if (r.ppUnit === 'PP1') caseBits.push('top power play');
  if (pg.id) caseBits.push(`against ${esc(pg.name.split(' ').slice(-1)[0])}`);
  const caseLine = caseBits.length
    ? `<div class="pc-tonight-case">${caseBits.join(', ').replace(/, ([^,]*)$/, ' and $1')}.</div>` : '';
  return `<div class="pc-tonight"><h4>Tonight</h4><div class="pc-tonight-rows">${bits.join('<br>')}</div>${caseLine}</div>`;
}
function pcFormBarsHtml(r, l5g, l5s) {
  // Last-5 goals and shots vs 5-game season pace. White mark = season pace;
  // bar past the mark = hot. Falls back to null (caller keeps old text line)
  // when there is no last-5 or season sample.
  const l5 = (r.last5 || []).slice(0, 5);
  if (!l5.length || !(r.gp > 0)) return null;
  const row = (label, actual, pace) => {
    if (!(pace > 0)) return '';
    const scale = Math.max(actual, pace) * 1.05;
    const fill = Math.min(100, (actual / scale) * 100);
    const mark = Math.min(100, (pace / scale) * 100);
    const hot = actual > pace;
    return `<div class="pc-frow"><label><span>${label} · last 5: <b>${actual}</b></span><span class="muted">season pace: ${pace.toFixed(1)}</span></label>`
      + `<div class="pc-fbar"><i class="${hot ? 'hot' : 'cold'}" style="width:${fill.toFixed(1)}%"></i><span class="pc-fmark" style="left:${mark.toFixed(1)}%"></span></div>`
      + `<p class="muted small">${hot ? 'Running hot — bar past the white season-pace mark.' : 'Below season pace.'}</p></div>`;
  };
  const goalsRow = row('Goals', l5g, 5 * (r.goals / r.gp));
  const shotsRow = row('Shots', l5s, 5 * (r.sogpg || 0));
  if (!goalsRow && !shotsRow) return null;
  return `<div class="pc-form"><h4>Form — last 5 vs season pace</h4>${goalsRow}${shotsRow}</div>`;
}
function linematesHtml(r) {
  const mates = state.skaters.filter((s) => s.team === r.team && String(s.gameId) === String(r.gameId) && String(s.pid) !== String(r.pid));
  let title = '', list = [];
  if (['C', 'L', 'R'].includes(r.pos) && r.line) {
    const line = mates.filter((s) => s.line === r.line);
    if (!line.length) return '';
    title = `Line ${r.line} — linemates`;
    const POSORD = { LW: 0, C: 1, RW: 2 };
    list = line.sort((a, b) => ((POSORD[a.linePos] ?? 9) - (POSORD[b.linePos] ?? 9)) || (b.toiMin - a.toiMin));
  } else if (r.pos === 'D' && r.line && /^D[123]$/.test(r.line)) {
    const pair = mates.filter((s) => s.pos === 'D' && s.line === r.line);
    if (!pair.length) return '';
    title = `Pair ${r.line} — partner`;
    list = pair;
  } else if (r.pos === 'D') {
    const defs = [r, ...mates.filter((s) => s.pos === 'D')].sort((a, b) => b.toiMin - a.toiMin);
    const idx = defs.findIndex((s) => String(s.pid) === String(r.pid));
    const pair = defs.slice(Math.floor(idx / 2) * 2, Math.floor(idx / 2) * 2 + 2).filter((s) => String(s.pid) !== String(r.pid));
    if (!pair.length) return '';
    title = `Pair D${Math.floor(idx / 2) + 1} — partner`;
    list = pair;
  } else {
    return '';
  }
  const estTag = r.lineEst === false ? '' : ' <span class="muted small">est.</span>';
  const tc = TEAM_COLORS[r.team] || '#888';
  const cells = list.map((s) => {
    const last = s.name.split(' ').slice(-1)[0];
    const initials = s.name.split(' ').map((w) => w[0]).join('').slice(0, 2).toUpperCase();
    return `<button class="pc-mate" data-pid="${s.pid}" data-gid="${s.gameId}" title="Open ${esc(s.name)} card">
      <img src="${esc(s.headshot)}" alt="" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'">
      <span class="pc-mate-fb">${esc(initials)}</span>
      <b>${esc(last)}</b><small>${esc(s.linePos || s.pos)}</small>
    </button>`;
  }).join('');
  return `<h4 style="margin:.5rem 0 .15rem">${esc(title)}${estTag}</h4><div class="pc-mates" style="--pc-tc:${tc}">${cells}</div>`;
}
/* ---------------- NHL game sheet (slate-card expansion) ----------------
   Tapping a slate card opens the matchup modal; the modal body is the
   game sheet. Everything here rides data already fetched for the slate —
   no new API calls. Section open-state persists across re-renders within
   the session (same pattern as the NBA game sheet). */
const sheetSecs = {}; // section key -> open bool, session only
const SHEET_SEC_DEFAULTS = { scorers: true, goalies: true, preview: true, lineups: true, teamstats: true };
function sheetSecOpen(key) { return key in sheetSecs ? sheetSecs[key] : !!SHEET_SEC_DEFAULTS[key]; }
function sheetDetailsOpen() {
  // capture current open-state before a re-render wipes the DOM
  document.querySelectorAll('#matchupBody details.gs-sec').forEach((d) => { sheetSecs[d.dataset.sec] = d.open; });
}
function sheetBindToggles() {
  document.querySelectorAll('#matchupBody details.gs-sec').forEach((d) => {
    d.addEventListener('toggle', () => { sheetSecs[d.dataset.sec] = d.open; });
  });
}
function renderMatchupBody(g, lamA, lamB, wp, st) {
  sheetDetailsOpen();
  $('matchupBody').innerHTML = matchupHtml(g, lamA, lamB, wp, st);
  drawGoalieRinks();
  sheetBindToggles();
  sheetBindLast10();
}
// Sheet scorers feed: newest-first goals from this game's pbp. Each row
// replays the existing goal animation (goal-anim.js) — no new animation code.
// The gl objects are augmented with the game's team abbreviations, which
// playGoalAnimation needs for its team logos.
const sheetGoalsByGame = {}; // gameId -> [gl...] for animation replay
function sheetScorersHtml(g) {
  const goals = extractGoals(g.pbp, g).map((gl) => ({
    ...gl, gameAway: g.away, gameHome: g.home, awayAbbr: g.away, homeAbbr: g.home,
  }));
  sheetGoalsByGame[g.id] = goals;
  if (!goals.length) return `<p class="muted small">No goals yet.</p>`;
  return `<div class="gs-feed">${goals.map((gl, i) => {
    const perLabel = gl.periodType === 'OT' ? 'OT' : gl.periodType === 'SO' ? 'SO' : `P${gl.period}`;
    const assists = gl.assists.length ? ` · ${gl.assists.map(esc).join(', ')}` : '';
    return `<button class="gs-feed-row" data-sheet-goal="${g.id}:${i}" title="Replay goal animation">
      <img class="gs-tlogo" src="${teamLogoUrl(gl.team)}" alt="" ${imgFallback}>
      <span class="gtype gtype-${gl.type.toLowerCase()}">${GOAL_TYPE_LABEL[gl.type] || gl.type}</span>
      <span class="gs-scorer"><strong>${esc(gl.scorer)}</strong><span class="muted small">${assists}</span></span>
      <span class="gs-meta">${perLabel} ${esc(gl.time)}<span class="gs-score">${gl.awayScore}–${gl.homeScore}</span><span class="gs-tap">Tap for animation ▸</span></span>
    </button>`;
  }).join('')}</div>`;
}
// Sheet goalie matchup cards: compact entry points to the existing full
// goalie card. They reuse the .goalie-open document handler (same as the
// goalie heads in the detail panels), so no new goalie wiring is needed.
function sheetGoalieCardsHtml(g) {
  return `<div class="gs-goalies">${[g.away, g.home].map((t) => {
    const pg = panelGoalie(g, t);
    if (!pg.id) return `<div class="gs-gcard"><strong>${esc(pg.name)}</strong><span class="muted small">${esc(t)} · TBD</span></div>`;
    const sv = goalieSvCache[pg.id];
    const svTxt = sv ? ` · Save % ${(sv * 100).toFixed(1)}%` : '';
    return `<button class="gs-gcard goalie-open" data-goalie="${pg.id}" data-team="${esc(t)}" data-game="${g.id}" title="Open ${esc(pg.name)} card">
      <img class="gs-hs" src="${esc(headshotUrl(t, pg.id))}" alt="" ${imgFallback}>
      <span class="gs-ginfo"><strong>${esc(pg.name)}</strong><span class="muted small">${esc(t)} · ${esc(pg.tag || '')}${svTxt}</span></span>
      <span class="gs-tap">Goalie card ▸</span>
    </button>`;
  }).join('')}</div>`;
}
// Sheet team-stat bars in team colors. Data already on hand: live SOG from
// the pbp, season goals for/against per game from standings (same fetch the
// preview tape uses). Hits / faceoffs are NOT in any fetched payload, so
// they are deliberately not shown rather than fabricated.
function sheetTeamStatsHtml(g, st) {
  const pbp = g.pbp;
  const sogA = pbp && pbp.awayTeam && typeof pbp.awayTeam.sog === 'number' ? pbp.awayTeam.sog : null;
  const sogH = pbp && pbp.homeTeam && typeof pbp.homeTeam.sog === 'number' ? pbp.homeTeam.sog : null;
  const sa = st ? st[g.away] : null, sh = st ? st[g.home] : null;
  const perGame = (s, f) => (s && s.gamesPlayed > 0) ? f(s) : null;
  const gfA = perGame(sa, (s) => s.goalFor / s.gamesPlayed);
  const gfH = perGame(sh, (s) => s.goalFor / s.gamesPlayed);
  const gaA = perGame(sa, (s) => s.goalAgainst / s.gamesPlayed);
  const gaH = perGame(sh, (s) => s.goalAgainst / s.gamesPlayed);
  const cA = TEAM_COLORS[g.away] || '#888', cH = TEAM_COLORS[g.home] || '#888';
  const bar = (label, a, h, fmt) => {
    if (a == null || h == null || (a + h) <= 0) return '';
    const pa = (a / (a + h)) * 100;
    return `<div class="gs-stat"><label><span>${label} · ${esc(g.away)} ${fmt(a)}</span><span>${fmt(h)} ${esc(g.home)}</span></label>`
      + `<div class="gs-bar"><i style="width:${pa.toFixed(1)}%;background:${cA};box-shadow:0 0 10px ${cA}"></i>`
      + `<i style="flex:1;background:${cH};box-shadow:0 0 10px ${cH}"></i></div></div>`;
  };
  const rows = [
    bar('Shots on goal', sogA, sogH, (v) => v),
    bar('Goals for / game', gfA, gfH, (v) => v.toFixed(2)),
    bar('Goals against / game', gaA, gaH, (v) => v.toFixed(2)),
  ].join('');
  return rows || `<p class="muted small">Team stats unavailable.</p>`;
}
/* ---------------- Live win % bar (game sheet) ----------------
   Pregame, the bar shows the existing Poisson model number, labeled
   "Model". Once live, the bar is driven by a LIVE calculation from
   score + clock (draft: ~/workspace/nhl-live-wp-draft.md), recomputed
   on every live tick while the sheet is open. The live number is a
   calculation from what has already happened, NOT a projection, and the
   sheet must never label it one.
   Flow terms (shot attempts, takeaways, zone faceoffs) are implemented
   below but DISABLED behind LIVE_WP_FLOW_ENABLED until the backtest
   beats score+clock alone — the bar moves on score + clock only until
   then, and the sublabel says so ("from score & clock so far").
   WP history points are recorded per recompute (session only) as data
   for the future WP graph; no graph is rendered yet. */
const LIVE_WP_FLOW_ENABLED = false; // BACKTEST GATE — do not flip without the backtest (see draft).
// PLACEHOLDER weights from the draft — replace with fitted coefficients after backtest.
const LIVE_WP_SCORE_A = 0.55, LIVE_WP_SCORE_B = 1.10;
const LIVE_WP_FLOW_C = 0.80, LIVE_WP_FLOW_D = 0.30, LIVE_WP_FLOW_E = 0.40;
const liveWpHistory = {}; // gameId -> [{t, period, clock, home}] — session only
let sheetOpenGameId = null; // game id of the currently open sheet, if any
let sheetStandings = null; // last standings map used by the open sheet (fallback for tick refreshes)
function liveWpLogit(p) { const c = Math.min(0.99, Math.max(0.01, p)); return Math.log(c / (1 - c)); }
function liveWpSigmoid(x) { return 1 / (1 + Math.exp(-x)); }
// Minutes elapsed from period + clock. OT is 5 min, SO counts as 65.
// During intermission the API clock counts the break, not the period, so
// elapsed is taken as the end of the last completed period.
function liveWpElapsed(g) {
  const pbp = g.pbp || {};
  const pd = pbp.periodDescriptor || {};
  const n = pd.number || 0;
  const clockStr = (pbp.clock && pbp.clock.timeRemaining) || '';
  if (!n) return { elapsed: 0, period: 0, clock: clockStr };
  if (pbp.clock && pbp.clock.inIntermission) return { elapsed: (n - 1) * 20, period: n, clock: clockStr };
  let rem = 0;
  const m = /^(\d+):(\d+)$/.exec(clockStr);
  if (m) rem = (+m[1]) * 60 + (+m[2]);
  let elapsed;
  if (n <= 3) elapsed = (n - 1) * 20 + Math.max(0, 20 - rem / 60);
  else if (n === 4) elapsed = 60 + Math.max(0, 5 - rem / 60);
  else elapsed = 65;
  return { elapsed, period: n, clock: clockStr };
}
// Flow term from pbp plays. Gated off (see LIVE_WP_FLOW_ENABLED); when
// enabled, team attribution uses details.eventOwnerTeamId vs the pbp
// team ids, and zoneCode is read relative to the event owner team.
// Returns 0 whenever the data needed is missing — never fabricates.
function liveWpFlowTerm(g, goalDiff) {
  if (!LIVE_WP_FLOW_ENABLED) return 0;
  const pbp = g.pbp || {};
  const plays = pbp.plays || [];
  const idA = pbp.awayTeam && pbp.awayTeam.id, idH = pbp.homeTeam && pbp.homeTeam.id;
  if (!idA || !idH || !plays.length) return 0;
  let cfA = 0, cfH = 0, tkA = 0, tkH = 0, ozA = 0, ozH = 0;
  for (const p of plays) {
    const det = p.details || {};
    const tid = det.eventOwnerTeamId;
    if (tid !== idA && tid !== idH) continue;
    const isA = tid === idA;
    if (p.typeDescKey === 'shot-on-goal' || p.typeDescKey === 'missed-shot' || p.typeDescKey === 'blocked-shot') {
      if (isA) cfA++; else cfH++;
    } else if (p.typeDescKey === 'takeaway') {
      if (isA) tkA++; else tkH++;
    } else if (p.typeDescKey === 'faceoff' && det.zoneCode === 'O') {
      if (isA) ozA++; else ozH++;
    }
  }
  const corsiEdge = (cfA + cfH) > 0 ? (cfH - cfA) / (cfH + cfA) : 0;
  const takeawayEdge = Math.tanh((tkH - tkA) / 5);
  const ozEdge = (ozA + ozH) > 0 ? (ozH - ozA) / (ozH + ozA) : 0;
  const damp = Math.max(0, 1 - Math.abs(goalDiff) / 4);
  return damp * (LIVE_WP_FLOW_C * corsiEdge + LIVE_WP_FLOW_D * takeawayEdge + LIVE_WP_FLOW_E * ozEdge);
}
// Returns {a, b, mode} with a = away win %, b = home win % (same
// convention as matchupWinProb). mode: 'model' (pregame), 'live', 'final'.
function liveWinProb(g, pregameWp) {
  const mode = (g.state === 'LIVE' || g.state === 'CRIT') ? 'live'
    : (g.state === 'OFF' || g.state === 'FINAL') ? 'final' : 'model';
  if (mode === 'model') return { a: pregameWp.a, b: pregameWp.b, mode };
  const pbp = g.pbp || {};
  const sA = pbp.awayTeam && typeof pbp.awayTeam.score === 'number' ? pbp.awayTeam.score : null;
  const sH = pbp.homeTeam && typeof pbp.homeTeam.score === 'number' ? pbp.homeTeam.score : null;
  if (sA == null || sH == null) return { a: pregameWp.a, b: pregameWp.b, mode: 'model' };
  if (mode === 'final') {
    // A decided game is not a probability anymore.
    const home = sH > sA ? 1 : sH < sA ? 0 : 0.5;
    return { a: 1 - home, b: home, mode };
  }
  const goalDiff = sH - sA; // home perspective
  const el = liveWpElapsed(g);
  const frac = Math.min(1, Math.max(0, el.elapsed / 60));
  const logit = liveWpLogit(pregameWp.b) + goalDiff * (LIVE_WP_SCORE_A + LIVE_WP_SCORE_B * frac) + liveWpFlowTerm(g, goalDiff);
  // Empty net: flow is already disabled, so score + clock dominate by construction.
  const home = Math.min(0.99, Math.max(0.01, liveWpSigmoid(logit)));
  const pt = { t: new Date().toISOString(), period: el.period, clock: el.clock, home: Math.round(home * 100) };
  const hist = liveWpHistory[g.id] || (liveWpHistory[g.id] = []);
  const last = hist[hist.length - 1];
  if (!last || last.period !== pt.period || last.clock !== pt.clock || last.home !== pt.home) hist.push(pt);
  return { a: 1 - home, b: home, mode };
}
/* ---------------- Live win % graph (game sheet) ----------------
   Pure-string SVG path of the home win % through the game, drawn inside
   matchupHtml under the win bar (the sheet re-renders wholesale per tick,
   so no canvas and no separate updater). The path is the same honest
   score & clock calculation as the live bar — never a projection. Series
   source, in order: (a) this session's recorded liveWpHistory points,
   (b) a reconstruction from the pbp goals, stepping the score+clock
   formula at each goal. Goal dots mark each goal at its after-goal win %;
   the biggest single-goal swing gets the callout under the chart. */
function wpClockMin(str) {
  const m = /^(\d+):(\d+)$/.exec(String(str || ''));
  return m ? (+m[1]) + (+m[2]) / 60 : 0;
}
// History points store period + timeRemaining clock (like liveWpElapsed).
function wpElapsedFromPeriodClock(period, clockStr) {
  const rem = wpClockMin(clockStr);
  if (!period) return 0;
  if (period <= 3) return (period - 1) * 20 + Math.max(0, 20 - rem);
  if (period === 4) return 60 + Math.max(0, 5 - rem);
  return 65;
}
// extractGoals' time is timeInPeriod — ELAPSED in the period (the scorers
// feed prints it as-is), unlike the live clock's timeRemaining.
function wpGoalElapsed(gl) {
  const t = wpClockMin(gl.time);
  const p = gl.period || 0;
  if (p >= 5) return 65;
  if (p === 4) return 60 + t;
  if (p >= 1) return (p - 1) * 20 + t;
  return t;
}
function wpChartHtml(g, wp) {
  const live = liveWinProb(g, wp);
  if (live.mode !== 'live' && live.mode !== 'final') return '';
  const H = g.home, A = g.away;
  const pre = wp && typeof wp.b === 'number' ? wp.b : 0.5;
  const wpAt = (diff, elapsed) => liveWpSigmoid(liveWpLogit(pre)
    + diff * (LIVE_WP_SCORE_A + LIVE_WP_SCORE_B * Math.min(1, Math.max(0, elapsed / 60))));
  const perLab = (gl) => (gl.periodType === 'OT' || gl.period === 4) ? 'OT' : `P${gl.period}`;
  // Goals in chronological order (extractGoals returns newest first);
  // shootout goals never move the score, so they are excluded.
  const goals = extractGoals(g.pbp, g)
    .filter((gl) => gl.periodType !== 'SO' && (gl.period || 0) >= 1 && (gl.period || 0) < 5)
    .sort((a, b) => (a.order || 0) - (b.order || 0));
  let runDiff = 0, biggest = null;
  for (const gl of goals) {
    gl._e = wpGoalElapsed(gl);
    const hasScore = typeof gl.homeScore === 'number' && typeof gl.awayScore === 'number';
    const diffAfter = hasScore ? gl.homeScore - gl.awayScore
      : runDiff + (gl.team === H ? 1 : gl.team === A ? -1 : 0);
    const diffBefore = hasScore ? diffAfter - (gl.team === H ? 1 : -1) : runDiff;
    gl._wpBefore = wpAt(diffBefore, gl._e);
    gl._wpAfter = wpAt(diffAfter, gl._e);
    gl._delta = gl._wpAfter - gl._wpBefore;
    runDiff = diffAfter;
    if (!biggest || Math.abs(gl._delta) > Math.abs(biggest._delta)) biggest = gl;
  }
  const pbp = g.pbp || {};
  const finalDiff = (pbp.homeTeam && typeof pbp.homeTeam.score === 'number'
    && pbp.awayTeam && typeof pbp.awayTeam.score === 'number')
    ? pbp.homeTeam.score - pbp.awayTeam.score : runDiff;
  const elNow = liveWpElapsed(g);
  let pts;
  const hist = liveWpHistory[g.id] || [];
  if (hist.length >= 2) {
    pts = hist.map((pt) => [wpElapsedFromPeriodClock(pt.period, pt.clock),
      Math.min(0.99, Math.max(0.01, (pt.home || 0) / 100))])
      .sort((a, b) => a[0] - b[0]);
    if (live.mode === 'final') {
      if (pts[pts.length - 1][0] < 65) pts.push([65, wpAt(finalDiff, 65)]);
    } else {
      const last = pts[pts.length - 1];
      if (Math.abs(last[0] - elNow.elapsed) > 0.01 || Math.abs(last[1] - live.b) > 0.001) {
        pts.push([elNow.elapsed, live.b]);
      }
    }
  } else {
    pts = [[0, pre]];
    const evts = [];
    for (const gl of goals) evts.push({ e: gl._e, gl });
    for (const pe of [20, 40, 60]) {
      if (live.mode === 'final' || pe <= elNow.elapsed + 1e-9) evts.push({ e: pe, gl: null });
    }
    evts.sort((x, y) => (x.e - y.e) || ((x.gl ? 0 : 1) - (y.gl ? 0 : 1)));
    let diff = 0;
    for (const ev of evts) {
      if (ev.gl) {
        const hasScore = typeof ev.gl.homeScore === 'number' && typeof ev.gl.awayScore === 'number';
        const after = hasScore ? ev.gl.homeScore - ev.gl.awayScore
          : diff + (ev.gl.team === H ? 1 : ev.gl.team === A ? -1 : 0);
        const before = hasScore ? after - (ev.gl.team === H ? 1 : -1) : diff;
        pts.push([ev.e, wpAt(before, ev.e)], [ev.e, wpAt(after, ev.e)]);
        diff = after;
      } else {
        pts.push([ev.e, wpAt(diff, ev.e)]);
      }
    }
    // Endpoint: live = the current score & clock point; final = the
    // score & clock formula at the final diff, stepped to 65 (a shootout
    // game honestly ends at its pre-SO win %, not at 0/100).
    if (live.mode === 'final') pts.push([65, wpAt(diff, 65)]);
    else pts.push([elNow.elapsed, live.b]);
  }
  const series = [];
  for (const p of pts) {
    const l = series[series.length - 1];
    if (!l || Math.abs(l[0] - p[0]) > 1e-9 || Math.abs(l[1] - p[1]) > 1e-9) series.push(p);
  }
  if (series.length < 2) return '';
  const X = (e) => (Math.min(65, Math.max(0, e)) / 65) * 320;
  const Y = (w) => 8 + (1 - Math.min(1, Math.max(0, w))) * 84;
  const linePts = series.map(([e, w]) => `${X(e).toFixed(1)},${Y(w).toFixed(1)}`).join(' ');
  const x0 = X(series[0][0]), x1 = X(series[series.length - 1][0]);
  const cA = TEAM_COLORS[A] || '#888', cH = TEAM_COLORS[H] || '#888';
  const dividers = [20, 40, 60].map((pe) =>
    `<line x1="${X(pe).toFixed(1)}" y1="8" x2="${X(pe).toFixed(1)}" y2="92" stroke="rgba(255,255,255,.08)"/>`).join('');
  const labels = [['P1', 10], ['P2', 30], ['P3', 50], ['OT', 62.5]].map(([t, c]) =>
    `<text x="${X(c).toFixed(1)}" y="106" font-size="8" fill="#8b96ab" text-anchor="middle">${t}</text>`).join('');
  const shade = (live.mode === 'live' && elNow.elapsed < 64.9)
    ? `<rect x="${X(elNow.elapsed).toFixed(1)}" y="8" width="${(320 - X(elNow.elapsed)).toFixed(1)}" height="84" fill="rgba(255,255,255,.045)"/><text x="${Math.min(314, X(elNow.elapsed) + 5).toFixed(1)}" y="17" font-size="7.5" fill="#8b96ab">still to play</text>` : '';
  const dots = goals.map((gl) =>
    `<circle cx="${X(gl._e).toFixed(1)}" cy="${Y(gl._wpAfter).toFixed(1)}" r="3" fill="#f5b942" stroke="#0a101c" stroke-width="1"><title>${esc(gl.scorer)} · ${perLab(gl)} ${esc(gl.time)} · ${gl.awayScore}–${gl.homeScore}</title></circle>`).join('');
  const svg = `<svg viewBox="0 0 320 118" style="display:block;width:100%;height:auto" role="img" aria-label="Win probability path">`
    + `<polygon points="${linePts} ${x1.toFixed(1)},8 ${x0.toFixed(1)},8" fill="${cA}" opacity="0.10"/>`
    + `<polygon points="${linePts} ${x1.toFixed(1)},92 ${x0.toFixed(1)},92" fill="${cH}" opacity="0.16"/>`
    + dividers + shade
    + `<line x1="0" y1="50" x2="320" y2="50" stroke="rgba(255,255,255,.35)" stroke-dasharray="4 4"/>`
    + `<line x1="0" y1="92" x2="320" y2="92" stroke="rgba(255,255,255,.15)"/>`
    + `<polyline points="${linePts}" fill="none" stroke="${cH}" stroke-width="2" stroke-linejoin="round"/>`
    + dots + labels + `</svg>`;
  let swing = '';
  if (biggest) {
    const toward = biggest.team === H ? biggest._delta : -biggest._delta;
    swing = `<div class="gs-wp-swing">Biggest swing · ${esc(biggest.scorer)} · ${perLab(biggest)} ${esc(biggest.time)} · ${toward >= 0 ? '+' : '-'}${Math.round(Math.abs(toward) * 100)}% ${esc(biggest.team)}</div>`;
  }
  const note = live.mode === 'final' ? `<div class="gs-wp-note">Win % path · score &amp; clock</div>` : '';
  return `<div class="gs-wp-chart">${svg}</div>${swing}${note}`;
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
  const live = liveWinProb(g, wp);
  const pctA = Math.round(live.a * 100), pctH = Math.round(live.b * 100);
  const cA = TEAM_COLORS[A] || '#888', cH = TEAM_COLORS[H] || '#888';
  return `
  <div class="gs-head" style="background:linear-gradient(120deg, ${cA}2e, transparent 55%, ${cH}24)">
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
  </div>
  <div class="gs-wp-head"><span>Win probability</span><span class="gs-wp-tag">${live.mode === 'live' ? 'Live win %' : live.mode === 'final' ? 'Final' : 'Model'}</span></div>
  <div class="split-bar" aria-label="Win probability">
    <div class="split-a" style="width:${(live.a * 100).toFixed(1)}%;background:${cA};box-shadow:0 0 12px ${cA}"></div><div class="split-b" style="width:${(live.b * 100).toFixed(1)}%;background:${cH};box-shadow:0 0 12px ${cH}"></div>
  </div>
  <div class="split-labels"><span><strong style="color:${cA};text-shadow:0 0 10px ${cA}">${pctA}%</strong> ${esc(A)}</span><span>${esc(H)} <strong style="color:${cH};text-shadow:0 0 10px ${cH}">${pctH}%</strong></span></div>
  ${live.mode === 'live' ? `<div class="gs-wp-sub">from score &amp; clock so far</div>` : ''}
  ${wpChartHtml(g, wp)}
  <div class="matchup-proj">Projected <strong>${esc(A)} ${lamA.toFixed(1)} – ${lamB.toFixed(1)} ${esc(H)}</strong></div>
  ${sheetLast10StripHtml(g)}
  <details class="gs-sec" data-sec="scorers"${sheetSecOpen('scorers') ? ' open' : ''}><summary>Scorers feed</summary><div class="gs-sec-body">${sheetScorersHtml(g)}</div></details>
  <details class="gs-sec" data-sec="goalies"${sheetSecOpen('goalies') ? ' open' : ''}><summary>Goalie matchup</summary><div class="gs-sec-body">${sheetGoalieCardsHtml(g)}</div></details>
  <details class="gs-sec" data-sec="preview"${sheetSecOpen('preview') ? ' open' : ''}><summary>Game preview</summary><div class="gs-sec-body">
  <h4 class="tape-title">Game preview</h4>
  <div class="tape">
    ${tapeRow(fmt2(gfA), 'Goals for / game', fmt2(gfH), cmpRow(gfA, gfH))}
    ${tapeRow(fmt2(gaA), 'Goals against / game', fmt2(gaH), cmpRow(gaA, gaH, true))}
    ${tapeRow(rec(sa), 'Record', rec(sh), cmpRow(ptA, ptH))}
    ${tapeRow(streak(sa), 'Streak', streak(sh), null)}
    ${tapeRow(l10rec(sa), 'Last 10', l10rec(sh), cmpRow(l10A, l10H))}
  </div>
  </div></details>
  <details class="gs-sec" data-sec="lineups"${sheetSecOpen('lineups') ? ' open' : ''}><summary>Lineup</summary><div class="gs-sec-body">${matchupLineupHtml(g.id)}</div></details>
  <details class="gs-sec" data-sec="teamstats"${sheetSecOpen('teamstats') ? ' open' : ''}><summary>Team stats</summary><div class="gs-sec-body">${sheetTeamStatsHtml(g, st)}</div></details>
  <p class="muted small matchup-note">${live.mode === 'live' ? 'Live win % from score &amp; clock so far — a live calculation, not a projection.' : live.mode === 'final' ? 'Final result.' : 'Win % from each team\'s Poisson scoring rate (regulation ties split evenly).'} Team stats via NHL standings, cached per date. Goalie maps live in the full goalie card — tap a goalie above.</p>`;
}
async function openMatchup(gameId) {
  const g = state.games.find((gg) => String(gg.id) === String(gameId));
  if (!g) return;
  sheetOpenGameId = g.id;
  const lamA = simUnits(state.skaters, g.id, g.away).total;
  const lamB = simUnits(state.skaters, g.id, g.home).total;
  const wp = matchupWinProb(lamA, lamB);
  // show win prob + projection immediately; fill in standings when they arrive
  renderMatchupBody(g, lamA, lamB, wp, null);
  $('matchupModal').classList.remove('hidden');
  loadL10Sidecar().then(() => { if (l10SidecarState === 'ok') refreshOpenSheet(); });
  const st = await getStandings();
  await ensureGoalieProj(g);
  if (!$('matchupModal').classList.contains('hidden')) {
    sheetStandings = st;
    renderMatchupBody(g, lamA, lamB, wp, st);
  }
}
function closeMatchup() { sheetOpenGameId = null; $('matchupModal').classList.add('hidden'); }
// Re-render the open sheet on live ticks so the win % bar moves with the
// game. Called from rerenderLiveViews (both tick paths funnel through it).
// Standings are cached per date, so this adds no new fetches after open.
async function refreshOpenSheet() {
  try {
    if (!sheetOpenGameId || $('matchupModal').classList.contains('hidden')) return;
    const g = state.games.find((gg) => String(gg.id) === String(sheetOpenGameId));
    if (!g) return;
    const lamA = simUnits(state.skaters, g.id, g.away).total;
    const lamB = simUnits(state.skaters, g.id, g.home).total;
    const wp = matchupWinProb(lamA, lamB);
    let st = sheetStandings;
    try { st = await getStandings(); sheetStandings = st; } catch (e) { /* keep last standings */ }
    if (!$('matchupModal').classList.contains('hidden')) renderMatchupBody(g, lamA, lamB, wp, st);
  } catch (e) { /* never break live views on a sheet refresh */ }
}
function sortedSkaters() {
  let rows = state.skaters.slice();
  if (state.teamFilter) rows = rows.filter((r) => r.team === state.teamFilter);
  const by = state.sortBy;
  if (by === 'fit' && state.finderWeights) {
    const w = state.finderWeights;
    const fit = (r) => {
      // normalize each factor to 0-1, weight by slider
      const shoot = Math.min(1, Math.max(0, ((r.factors.find(f => f.label === 'Shooting talent')?.mult || 1) - 0.85) / 0.4));
      const vol = Math.min(1, r.sogpg / 5);
      const pp = Math.min(1, (r.ppp || 0) / Math.max(r.gp, 1) / 0.8);
      const zone = r.zone.share || 0;
      const toi = Math.min(1, r.toiMin / 24);
      return w.shoot * shoot + w.vol * vol + w.pp * pp + w.zone * zone + w.toi * toi;
    };
    rows.forEach((r) => r._fit = fit(r));
    rows.sort((a, b) => b._fit - a._fit);
    return rows;
  }
  rows.sort((a, b) => by === 'name' ? a.name.localeCompare(b.name)
    : by === 'team' ? (a.team + a.name).localeCompare(b.team + b.name)
    : by === 'zone' ? b.zone.share - a.zone.share
    : b.p - a.p);
  return rows;
}
/* Finder: slider weights → re-sort board by fit */
function initFinder() {
  const finder = $('boardFinder');
  if (!finder || finder._init) return;
  finder._init = true;
  finder.querySelectorAll('input[type=range]').forEach((s) => {
    s.addEventListener('input', () => {
      finder.querySelector(`.factor-val[data-f="${s.dataset.f}"]`).textContent = s.value;
    });
  });
  $('finderApply').addEventListener('click', () => {
    const w = {};
    let total = 0;
    finder.querySelectorAll('input[type=range]').forEach((s) => { w[s.dataset.f] = +s.value; total += +s.value; });
    if (!total) return;
    // normalize to sum to 1
    for (const k in w) w[k] /= total;
    state.finderWeights = w;
    state.sortBy = 'fit';
    renderBoard();
  });
  $('finderReset').addEventListener('click', () => {
    state.finderWeights = null;
    state.sortBy = 'prob';
    $('sortSelect').value = 'prob';
    finder.querySelectorAll('input[type=range]').forEach((s) => {
      s.value = 15;
      finder.querySelector(`.factor-val[data-f="${s.dataset.f}"]`).textContent = '15';
    });
    renderBoard();
  });
}
/* ---------------- board: projection table for the markets ----------------
   One table, every market. The Market dropdown switches the projection and
   its factor breakdown (colored numbers; Prob keeps the teal heat bands);
   Sort keeps its old job, plus Game grouping. Projections only — line
   prices and probability ladders stay in Markets. */
const BOARD_TIERS = { anytime: [30, 22, 15, 10], brace: [15, 11, 7, 4], first: [9, 7, 5, 3.5], shots: [62, 58, 54, 50], assists: [55, 50, 45, 40], points: [28, 24, 20, 16] };
const BOARD_HEADLINE = { shots: 2.5, assists: 0.5, points: 1.5 };
const BOARD_HEADS = {
  anytime: ['FORM<br>G/GP', 'SHOTS<br>/GAME', 'TALENT<br>×', 'ICE TIME<br>×', 'POWER PLAY<br>×', 'VS GOALIE<br>×', 'ZONE<br>×'],
  brace: ['FORM<br>G/GP', 'SHOTS<br>/GAME', 'TALENT<br>×', 'ICE TIME<br>×', 'POWER PLAY<br>×', 'VS GOALIE<br>×', 'ZONE<br>×'],
  first: ['HIS λ<br>GOAL RATE', 'GAME λ<br>TOTAL', 'ANYTIME<br>%'],
  shots: ['RATE<br>SOG/GM', 'LAST 5<br>SHOTS', 'ICE TIME<br>AVG'],
  assists: ['RATE<br>AST/GM', 'LAST 5<br>ASSISTS', 'ICE TIME<br>AVG'],
  points: ['RATE<br>PTS/GM', 'LAST 5<br>POINTS', 'ICE TIME<br>AVG'],
};
function boardBand(v, hi, mid) { return v >= hi ? 'g' : v >= mid ? 'y' : 'r'; }
function boardMult(m) { return { text: '×' + (m || 1).toFixed(2), band: (m || 1) >= 1.10 ? 'g' : (m || 1) >= 0.95 ? 'y' : 'r' }; }
function boardMarketInfo(kindArg) {
  const kind = kindArg || state.boardMarket;
  const map = new Map();
  if (kind === 'brace') { for (const r of twoPlusProbs()) map.set(r.pid, { p: r.tpP, fair: r.tpFair }); }
  else if (kind === 'first') { for (const r of firstGoalProbs()) map.set(r.pid, { p: r.fgP, fair: r.fgFair }); }
  else if (BOARD_HEADLINE[kind]) {
    for (const r of state.skaters) {
      const e = (r.markets[kind] || []).find((x) => x.line === BOARD_HEADLINE[kind]);
      if (e) map.set(r.pid, { p: e.over, fair: e.overFair, lam: e.lam });
    }
  } else { for (const r of state.skaters) map.set(r.pid, { p: r.p, fair: r.fair }); }
  return map;
}
function boardCells(r, info, gameLamTotal) {
  const kind = state.boardMarket;
  const fac = (label) => r.factors.find((f) => f.label === label) || { mult: 1, value: '' };
  if (kind === 'anytime' || kind === 'brace') {
    const gpg = r.goals / Math.max(r.gp, 1);
    const shotsReg = parseFloat(fac('Shot volume').value) || 0;
    return [
      { text: gpg.toFixed(2), band: boardBand(gpg, 0.55, 0.35) },
      { text: shotsReg.toFixed(1), band: boardBand(shotsReg, 3.0, 2.2) },
      boardMult(fac('Shooting talent').mult),
      boardMult(fac('Ice time').mult),
      boardMult(fac('Power play').mult),
      boardMult(fac('Opponent goalie').mult),
      boardMult(fac('Zone score').mult),
    ];
  }
  if (kind === 'first') {
    return [
      { text: r.lam.toFixed(2), band: boardBand(r.lam, 0.55, 0.38) },
      { text: gameLamTotal.toFixed(1), band: boardBand(gameLamTotal, 6.4, 5.8) },
      { text: Math.round(r.p * 100) + '%', band: boardBand(r.p * 100, 35, 25) },
    ];
  }
  const l5avg = (k) => { const l5 = r.last5 || []; return l5.length ? l5.reduce((a, x) => a + (x[k] || 0), 0) / l5.length : 0; };
  const toi = { text: fmtToi(r.toiMin), band: boardBand(r.toiMin, 20, 17) };
  const lam = (info.get(r.pid) || {}).lam || 0;
  if (kind === 'shots') return [
    { text: lam.toFixed(1), band: boardBand(lam, 3.2, 2.4) },
    { text: l5avg('shots').toFixed(1), band: boardBand(l5avg('shots'), 3.5, 2.5) }, toi];
  if (kind === 'assists') return [
    { text: lam.toFixed(2), band: boardBand(lam, 0.55, 0.38) },
    { text: l5avg('assists').toFixed(1), band: boardBand(l5avg('assists'), 0.8, 0.4) }, toi];
  return [
    { text: lam.toFixed(2), band: boardBand(lam, 0.95, 0.65) },
    { text: l5avg('points').toFixed(1), band: boardBand(l5avg('points'), 1.2, 0.6) }, toi];
}
function renderBoard() {
  initFinder();
  const tb = $('boardBody');
  const head = $('boardHead');
  const kind = state.boardMarket;
  const tiers = BOARD_TIERS[kind] || BOARD_TIERS.anytime;
  const info = boardMarketInfo();
  const gameLam = {};
  for (const r of state.skaters) gameLam[r.gameId] = (gameLam[r.gameId] || 0) + Math.max(r.lam, 0);
  const gameOrder = {};
  state.games.forEach((g, i) => { gameOrder[g.id] = i; });
  const scorerByGame = {};
  for (const g of state.games) scorerByGame[g.id] = scorerCounts(g);

  let rows = sortedSkaters();
  if (state.boardQuery) rows = rows.filter((r) => r.name.toLowerCase().includes(state.boardQuery));
  const bp = (r) => (info.get(r.pid) || { p: 0 }).p || 0;
  if (state.sortBy === 'prob') rows.sort((a, b) => bp(b) - bp(a));
  if (state.sortBy === 'game') rows.sort((a, b) => ((gameOrder[a.gameId] ?? 99) - (gameOrder[b.gameId] ?? 99)) || (bp(b) - bp(a)));

  if (head) head.innerHTML = '<th>Skater</th><th>Team</th><th class="num">Prob</th><th class="num">Fair</th>' +
    (BOARD_HEADS[kind] || BOARD_HEADS.anytime).map((h) => `<th class="num">${h}</th>`).join('');

  const tbl = $('boardTable');
  if (tbl && state.skaters.length) {
    const longest = Math.max(...state.skaters.map((r) => r.name.length));
    tbl.style.setProperty('--bnw', (30 + 8 + 20 + Math.ceil(longest * 7.9) + 26 + (typesState === 'ok' ? 34 : 0)) + 'px');
  }

  if (!rows.length) {
    tb.innerHTML = '<tr><td colspan="12" class="board-wide muted">No skaters match.</td></tr>';
    return;
  }
  let html = '';
  let lastGame = null;
  for (const r of rows) {
    if (state.sortBy === 'game' && r.gameId !== lastGame) {
      lastGame = r.gameId;
      const g = state.games.find((x) => x.id === r.gameId);
      if (g) {
        const aAb = (g.awayTeam && g.awayTeam.abbrev) || g.away || '';
        const hAb = (g.homeTeam && g.homeTeam.abbrev) || g.home || '';
        const stUtc = g.startTimeUTC || g.startUTC;
        const t = stUtc ? new Date(stUtc).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }) : '';
        html += `<tr class="board-game-row"><td colspan="12">${esc(aAb)} @ ${esc(hAb)}${t ? ' · ' + esc(t) : ''}</td></tr>`;
      }
    }
    const ng = (scorerByGame[r.gameId] || {})[r.pid] || 0;
    const badge = ng ? `<span class="goal-badge">${ng > 1 ? ng + 'G' : 'GOAL'}</span>` : '';
    const fitBadge = state.sortBy === 'fit' && r._fit != null ? `<span class="fit-badge">${Math.round(r._fit * 100)}</span>` : '';
    const l5g = (r.last5 || []).slice(0, 5).reduce((a, x) => a + (x.goals || 0), 0);
    const streak = l5g >= 3 ? `<span class="streak hot" title="${l5g} goals in last 5">🔥</span>`
      : l5g <= 1 && (r.last5 || []).length >= 3 ? `<span class="streak cold" title="${l5g} goals in last 5">❄️</span>` : '';
    const p = bp(r);
    const fair = (info.get(r.pid) || {}).fair || '–';
    const pct = p * 100;
    const heat = pct >= tiers[0] ? 'h5' : pct >= tiers[1] ? 'h4' : pct >= tiers[2] ? 'h3' : pct >= tiers[3] ? 'h2' : 'h1';
    const cells = boardCells(r, info, gameLam[r.gameId] || 0).map((c) => `<td class="num fac ${c.band}">${c.text}</td>`).join('');
    html += `
    <tr${ng ? ' class="scored"' : ''}>
      <td>${pnameBtn(r, true)}${badge}${fitBadge}${streak}</td>
      <td><span class="team-cell"><img src="${teamLogoUrl(r.team)}" alt="${esc(r.team)}" ${imgFallback}></span></td>
      <td class="num heat ${heat}"><strong>${pct1(p)}</strong></td>
      <td class="num">${fair}</td>
      ${cells}
    </tr>`;
  }
  tb.innerHTML = html;
  tb.querySelectorAll('.pname').forEach((b) =>
    b.addEventListener('click', () => openPlayer(b.dataset.pid, b.dataset.gid)));
}
function renderLongshots() {
  const ls = state.skaters.filter((r) => r.isLongshot).sort((a, b) => b.p - a.p);
  const el = $('longshotsList');
  if (!ls.length) { el.innerHTML = '<p class="muted">No longshots on this slate.</p>'; return; }
  const lsBands = heatBands(ls, (r) => r.p, HEAT_REF.longshot);
  el.innerHTML = ls.map((r) => `
    <div class="ls-card heat-edge-${lsBands.get(r.pid)}">
      <img class="headshot" src="${esc(r.headshot || headshotUrl(r.team, r.pid))}" alt="" ${imgFallback}>
      <div class="ls-info">
        <span class="heat-dot ${lsBands.get(r.pid)}"></span><button class="pname" data-pid="${r.pid}" data-gid="${r.gameId}">${esc(r.name)}</button>${typeBadgeHtml(r.pid)}
        <div class="ls-stats">${esc(r.team)} · ${esc(r.pos)} · ${pct1(r.p)} model · ${r.goals}G/${r.gp}GP</div>
      </div>
      <div class="ls-odds"><div class="fair">${r.fair}</div><div class="ls-stats">fair</div></div>
      <div class="ls-add">${addBtnHtml(r, 'atg')}</div>
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
    const bands = heatBands(state.skaters, (r) => marketOver(r, kind, MARKET_HEADLINE[kind]), HEAT_REF[kind]);
    const body = sorted.map((r) => { const b = bands.get(r.pid); return `
      <tr class="heat-row ${b}">
        <td><span class="heat-dot ${b}"></span>${pnameBtn(r, true)}</td>
        <td><span class="team-cell"><img src="${teamLogoUrl(r.team)}" alt="" ${imgFallback}>${esc(r.team)}</span></td>
        ${r.markets[kind].map((m) => `
          <td class="num"><strong>${pct1(m.over)}</strong><div class="small muted">${m.overFair}</div></td>`).join('')}
        <td class="num">${addBtnHtml(r, kind + '|' + MARKET_HEADLINE[kind])}</td>
      </tr>`; }).join('');
    return `<h3 class="mkt-title">${meta.label} <span class="muted small">over / under · Poisson λ from ${meta.short}/game</span></h3>
      <div class="table-wrap"><table><thead><tr><th>Skater</th><th>Team</th>
      ${MARKET_LINES[kind].map((l) => `<th class="num">o${l}</th>`).join('')}<th></th></tr></thead>
      <tbody>${body || `<tr><td colspan="${3 + MARKET_LINES[kind].length}" class="muted">No skaters.</td></tr>`}</tbody></table></div>` + HEAT_LEGEND;
  }).join('');
  wrap.querySelectorAll('.pname').forEach((b) =>
    b.addEventListener('click', () => openPlayer(b.dataset.pid, b.dataset.gid)));
}
/* ---------------- market leaders board ----------------
   Collapsible leaders board at the top of the Markets view. Goals,
   assists, points and shots show the league-wide CURRENT-SEASON top 3
   (NHL leaders feed + NHL stats API); brace and first goal have no
   official season leaderboard, so those two stay tonight's model top 3.
   Rows matching tonight's slate get the full clickable player card via
   pnameBtn; other season leaders render as static face cards. */
const seasonLeadersState = { loaded: false, data: null };
async function loadSeasonLeaders() {
  if (seasonLeadersState.loaded) return seasonLeadersState.data;
  const out = {};
  try {
    const d = await fetchJSON(`${API}/skater-stats-leaders/${SEASON}/2?categories=goals,assists,points&limit=3`);
    for (const cat of ['goals', 'assists', 'points']) {
      out[cat] = (d[cat] || []).map((r) => ({
        pid: r.id,
        name: `${(r.firstName || {}).default || ''} ${(r.lastName || {}).default || ''}`.trim(),
        team: r.teamAbbrev, headshot: r.headshot, value: r.value,
      }));
    }
  } catch (e) { /* season groups fall back to tonight's model rows */ }
  try {
    const sort = encodeURIComponent(JSON.stringify([{ property: 'shots', direction: 'DESC' }]));
    const d2 = await fetchJSON(`/nhl-stats/skater/summary?limit=3&start=0&sort=${sort}&cayenneExp=seasonId%3D${SEASON}`);
    out.shots = (d2.data || []).map((r) => ({
      pid: r.playerId, name: r.skaterFullName,
      team: String(r.teamAbbrevs || '').split(',').pop().trim(),
      headshot: null, value: r.shots,
    }));
  } catch (e) { /* shots group falls back to tonight's model rows */ }
  seasonLeadersState.loaded = true;
  seasonLeadersState.data = out;
  return out;
}
function leaderRowHtml(item, rank, valHtml) {
  const match = (state.skaters || []).find((s) => String(s.pid) === String(item.pid));
  if (match) {
    return `<div class="leader-row"><span class="leader-rank">${rank}</span>${pnameBtn(match)}<span class="leader-val">${valHtml}</span></div>`;
  }
  const hs = item.headshot || headshotUrl(item.team, item.pid);
  return `<div class="leader-row"><span class="leader-rank">${rank}</span><span class="pname-static"><img class="pavatar" src="${esc(hs)}" alt="" ${imgFallback}>${esc(item.name)} <span class="muted">${esc(item.team || '')}</span></span><span class="leader-val">${valHtml}</span></div>`;
}
function renderLeaders() {
  const grid = $('leadersGrid');
  if (!grid) return;
  const sk = state.skaters || [];
  if (!sk.length) {
    grid.innerHTML = '<p class="muted small">Leaders load with the slate.</p>';
    return;
  }
  if (!seasonLeadersState.loaded) {
    loadSeasonLeaders().then(() => renderLeaders());
  }
  const season = seasonLeadersState.data || {};
  const probVal = (pKey, fairKey) => (r) =>
    `<strong>${pct1(r[pKey])}</strong> <span class="muted">${r[fairKey]}</span>`;
  const seasonGroup = (title, cat, unit, fallbackRows, fallbackVal) => {
    const rows = season[cat];
    if (rows && rows.length) {
      return { title: `${title} · season`, html: rows.map((it, i) =>
        leaderRowHtml(it, i + 1, `<strong>${it.value}</strong> <span class="muted">${unit}</span>`)).join('') };
    }
    return { title: `${title} · season`, html: fallbackRows.map((r, i) =>
      leaderRowHtml(r, i + 1, fallbackVal(r))).join('') };
  };
  const tonightGroup = (title, rows, val) => ({
    title: `${title} · tonight`,
    html: rows.map((r, i) => leaderRowHtml(r, i + 1, val(r))).join(''),
  });
  const atgRows = sk.slice().sort((a, b) => b.p - a.p).slice(0, 3);
  const shotsLine = MARKET_HEADLINE.shots;
  const shotsRows = sk.slice()
    .sort((a, b) => marketOver(b, 'shots', shotsLine) - marketOver(a, 'shots', shotsLine))
    .slice(0, 3);
  const poissonVal = (kind) => (r) => {
    const line = MARKET_HEADLINE[kind];
    const m = (r.markets[kind] || []).find((x) => x.line === line);
    return `<strong>${pct1(m ? m.over : 0)}</strong> <span class="muted">${m ? m.overFair : '–'}</span>`;
  };
  const shotsVal = poissonVal('shots');
  const astRows = sk.slice().sort((a, b) => (b.apg || 0) - (a.apg || 0)).slice(0, 3);
  const ptsRows = sk.slice().sort((a, b) => (b.ptspg || 0) - (a.ptspg || 0)).slice(0, 3);
  const groups = [
    seasonGroup('Goals', 'goals', 'G', atgRows, probVal('p', 'fair')),
    tonightGroup('Brace', twoPlusProbs().slice(0, 3), probVal('tpP', 'tpFair')),
    tonightGroup('First goal', firstGoalProbs().slice(0, 3), probVal('fgP', 'fgFair')),
    seasonGroup('Shots', 'shots', 'SOG', shotsRows, shotsVal),
    seasonGroup('Assists', 'assists', 'A', astRows, poissonVal('assists')),
    seasonGroup('Points', 'points', 'P', ptsRows, poissonVal('points')),
  ];
  grid.innerHTML = groups.map((g) => `
    <div class="leader-group">
      <h4>${esc(g.title)}</h4>
      ${g.html}
    </div>`).join('');
  wirePnameClicks(grid);
}
/* ---------------- parlay builder ---------------- */
function buildLeg(r, v) {
  if (v === 'atg') {
    if (!(r.p > 0.0005)) return null;
    return { key: `${r.pid}:atg`, name: r.name, team: r.team, gameId: r.gameId, label: 'Anytime goal', prob: r.p, fair: r.fair };
  }
  if (v === 'twoplus') {
    const lam = Math.max(r.lam, 0);
    const p = 1 - Math.exp(-lam) * (1 + lam);
    if (!(p > 0.0005)) return null;
    return { key: `${r.pid}:twoplus`, name: r.name, team: r.team, gameId: r.gameId, label: 'Brace (2+ goals)', prob: p, fair: fairOddsSafe(p) };
  }
  if (v === 'firstgoal') {
    let denom = 0;
    for (const sk of state.skaters) if (sk.gameId === r.gameId) denom += Math.max(sk.lam, 0);
    const p = denom > 0 ? Math.max(r.lam, 0) / denom : 0;
    if (!(p > 0.0005)) return null;
    return { key: `${r.pid}:firstgoal`, name: r.name, team: r.team, gameId: r.gameId, label: 'First goal', prob: p, fair: fairOddsSafe(p) };
  }
  const [kind, lineStr] = String(v).split('|');
  const line = parseFloat(lineStr);
  const m = (r.markets[kind] || []).find((x) => x.line === line);
  if (!m || !(m.over > 0.0005) || m.overFair === '–') return null;
  return { key: `${r.pid}:${kind}:${line}`, name: r.name, team: r.team, gameId: r.gameId, label: `${MARKET_META[kind].label} o${line}`, prob: m.over, fair: m.overFair };
}
function addParlayLeg(r, v) {
  const leg = buildLeg(r, v);
  if (!leg) return;
  if (!state.parlay.some((l) => l.key === leg.key)) state.parlay.push(leg);
  closePlayer();
  setView('parlay');
  renderParlay();
}
/* Quick-add from the market boards: the + on a row toggles that market's
   leg for the player without leaving the board; the button shows ✓
   while the leg is in the parlay. */
function addBtnHtml(r, v) {
  const leg = buildLeg(r, v);
  if (!leg) return '';
  const on = state.parlay.some((l) => l.key === leg.key);
  return `<button class="addbtn${on ? ' added' : ''}" data-add="${esc(v)}" data-pid="${r.pid}" type="button" title="${on ? 'Remove from parlay' : 'Add to parlay'}" aria-label="Toggle parlay leg">${on ? '✓' : '+'}</button>`;
}
function toggleParlayLeg(r, v, btn) {
  const leg = buildLeg(r, v);
  if (!leg) return;
  const i = state.parlay.findIndex((l) => l.key === leg.key);
  if (i >= 0) state.parlay.splice(i, 1); else state.parlay.push(leg);
  if (btn) {
    const on = i < 0;
    btn.classList.toggle('added', on);
    btn.textContent = on ? '✓' : '+';
    btn.title = on ? 'Remove from parlay' : 'Add to parlay';
  }
  renderParlay();
}
function renderParlay() {
  const el = $('parlayLegs');
  if (!el) return;
  if (!state.parlay.length) {
    el.innerHTML = '<p class="muted">No legs yet — tap + on any market row to add one, or open a player card and use the parlay dropdown.</p>';
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
  renderSendToBook();
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
/* ---------------- Send to book (Gambly / Pikkit) ----------------
   v1 is a TEXT handoff only: the site formats the ticket, copies it,
   and opens the bot's page in a new tab. No API key, no backend, no
   odds fetching, no placement — the user confirms at the book's price.
   Link targets are the bots' own documented pages; no other bot URLs
   are used here. */
const STB_GAMBLY_URL = 'https://gambly.com/chat';
const STB_PIKKIT_URL = 'https://pikkit.com/autofill';
const STB_CHECKLIST = [
  'Book price wins over model fair — check every leg at the book before confirming.',
  'If a line moved or a market isn’t offered, that leg may fail to match — rebuild just that leg in the book.',
  'You set the stake and place the bet. Nothing here places it for you.',
];
function stbDateStr() {
  return new Date().toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
}
function stbNhlLegGame(l) {
  let gid = l.gameId;
  if (gid == null && l.key) {
    const pid = String(l.key).split(':')[0];
    const s = (state.skaters || []).find((x) => String(x.pid) === pid);
    if (s) gid = s.gameId;
  }
  if (gid == null) return null;
  return (state.games || []).find((g) => String(g.id) === String(gid)) || null;
}
function stbNhlLegWording(l) {
  const parts = String(l.key || '').split(':');
  const kind = parts[1], line = parts[2];
  if (kind === 'atg') return 'Anytime Goalscorer';
  if (kind === 'shots') return `Over ${line} Shots on Goal`;
  if (kind === 'assists') return `Over ${line} Assists`;
  if (kind === 'points') return `Over ${line} Points`;
  // Defensive only — the card picker cannot currently add these leg types.
  if (/brace/i.test(l.label || '')) return '2+ Goals';
  if (/first/i.test(l.label || '')) return 'First Goalscorer';
  return l.label || '';
}
function stbNhlTicket() {
  const legs = state.parlay || [];
  if (!legs.length) return null;
  // Copied text is legs only: player + market, nothing else. Fair odds
  // stay visible in the ticket totals on screen and the book-price
  // checklist stays in the chooser — neither is pasted to the bot.
  return legs.map((l) => `${l.name} — ${stbNhlLegWording(l)}`).join('\n');
}
async function stbCopyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (e) { /* fall through to the textarea fallback */ }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return !!ok;
  } catch (e2) { return false; }
}
function stbSendOpen(ticket, url, statusEl, fallbackEl, doneMsg) {
  stbCopyText(ticket).then((ok) => {
    if (ok) {
      statusEl.textContent = doneMsg;
      window.open(url, '_blank', 'noopener');
    } else {
      statusEl.textContent = 'Copy didn’t work in this browser — copy the ticket below manually.';
      fallbackEl.value = ticket;
      fallbackEl.classList.remove('hidden');
      fallbackEl.select();
    }
  });
}
function renderSendToBook() {
  const wrap = $('sendToBookWrap');
  if (!wrap) return;
  if (!state.parlay.length) { wrap.innerHTML = ''; return; }
  wrap.innerHTML = `
    <button class="btn" id="stbOpenBtn" type="button">Send to book</button>
    <div id="stbChooser" class="stb-chooser hidden">
      <ul class="stb-check">${STB_CHECKLIST.map((c) => `<li>${esc(c)}</li>`).join('')}</ul>
      <div class="stb-row">
        <button class="btn" id="stbGambly" type="button">Via Gambly</button>
        <button class="btn" id="stbPikkit" type="button">Via Pikkit</button>
        <button class="ghost-btn" id="stbCopy" type="button">Copy ticket text</button>
      </div>
      <p class="muted small" id="stbStatus"></p>
      <textarea id="stbFallback" class="stb-fallback hidden" rows="8" readonly aria-label="Ticket text"></textarea>
    </div>`;
  $('stbOpenBtn').addEventListener('click', () => $('stbChooser').classList.toggle('hidden'));
  const statusEl = $('stbStatus'), fallbackEl = $('stbFallback');
  $('stbGambly').addEventListener('click', () => {
    const t = stbNhlTicket();
    if (t) stbSendOpen(t, STB_GAMBLY_URL, statusEl, fallbackEl, 'Ticket copied — paste it into Gambly Chat, then follow its deeplink to your book.');
  });
  $('stbPikkit').addEventListener('click', () => {
    const t = stbNhlTicket();
    if (t) stbSendOpen(t, STB_PIKKIT_URL, statusEl, fallbackEl, 'Ticket copied — paste it into Pikkit QuickPick, then Autofill to your book.');
  });
  $('stbCopy').addEventListener('click', () => {
    const t = stbNhlTicket();
    if (!t) return;
    stbCopyText(t).then((ok) => {
      if (ok) statusEl.textContent = 'Ticket copied.';
      else {
        statusEl.textContent = 'Copy didn’t work in this browser — copy the ticket below manually.';
        fallbackEl.value = t; fallbackEl.classList.remove('hidden'); fallbackEl.select();
      }
    });
  });
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
  // Vertical rink, net at top, Bueno zone-block skin: deep-teal point,
  // teal sides, gold slot wash, hot low slot — shared by the player
  // shot/goal map and both goalie maps.
  const W = 400, H = 430;
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d');
  const X = (y) => 20 + ((y + 42.5) / 85) * (W - 40);   // across the ice
  const Y = (x) => 16 + ((100 - x) / 103) * (H - 32);   // along the ice, net up
  const pxX = (W - 40) / 85, pxY = (H - 32) / 103;
  const bg = ctx.createRadialGradient(W / 2, H * 0.4, 40, W / 2, H / 2, 320);
  bg.addColorStop(0, '#16233f'); bg.addColorStop(0.6, '#101b31'); bg.addColorStop(1, '#0a1120');
  ctx.fillStyle = bg; ctx.fillRect(0, 0, W, H);
  const rinkPath = () => {
    ctx.beginPath();
    ctx.moveTo(X(-42.5), Y(-3));
    ctx.lineTo(X(-42.5), Y(70));
    ctx.quadraticCurveTo(X(-42.5), Y(100), X(-13), Y(100));
    ctx.lineTo(X(13), Y(100));
    ctx.quadraticCurveTo(X(42.5), Y(100), X(42.5), Y(70));
    ctx.lineTo(X(42.5), Y(-3));
    ctx.closePath();
  };
  // polygon from rink coords [x, y]
  const poly = (pts, fill) => {
    ctx.beginPath();
    pts.forEach(([rx, ry], i) => { const cx = X(ry), cy = Y(rx); if (i) ctx.lineTo(cx, cy); else ctx.moveTo(cx, cy); });
    ctx.closePath(); ctx.fillStyle = fill; ctx.fill();
  };
  ctx.save();
  rinkPath(); ctx.clip();
  // ---- zone block fills ----
  ctx.fillStyle = 'rgba(24,68,84,0.55)';
  ctx.fillRect(0, Y(47), W, H - Y(47)); // point
  poly([[100, -42.5], [100, -10], [69, -22], [54, -22], [54, -11], [47, -11], [47, -42.5]], 'rgba(23,94,108,0.45)'); // left side
  poly([[100, 42.5], [100, 10], [69, 22], [54, 22], [54, 11], [47, 11], [47, 42.5]], 'rgba(23,94,108,0.45)'); // right side
  poly([[89, -9], [69, -22], [54, -22], [54, -11], [47, -11], [47, 11], [54, 11], [54, 22], [69, 22], [89, 9]], 'rgba(160,104,20,0.50)'); // slot
  poly([[100, -10], [100, 10], [74, 10], [74, -10]], 'rgba(196,44,30,0.78)'); // low slot
  // ---- markings ----
  ctx.strokeStyle = 'rgba(232,161,61,0.5)'; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(X(-22), Y(69)); ctx.lineTo(X(-10), Y(76)); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(X(22), Y(69)); ctx.lineTo(X(10), Y(76)); ctx.stroke();
  for (const fy of [-22, 22]) {
    ctx.strokeStyle = 'rgba(235,242,255,0.35)'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.ellipse(X(fy), Y(69), 15 * pxX, 15 * pxY, 0, 0, Math.PI * 2); ctx.stroke();
    ctx.fillStyle = '#e5484d';
    ctx.beginPath(); ctx.arc(X(fy), Y(69), 3.4, 0, Math.PI * 2); ctx.fill();
  }
  ctx.strokeStyle = '#3b82f6'; ctx.lineWidth = 4; ctx.globalAlpha = 0.85;
  ctx.beginPath(); ctx.moveTo(X(-42.5), Y(25)); ctx.lineTo(X(42.5), Y(25)); ctx.stroke();
  ctx.globalAlpha = 1;
  ctx.strokeStyle = 'rgba(232,200,50,0.45)'; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(X(-42.5), Y(47)); ctx.lineTo(X(42.5), Y(47)); ctx.stroke();
  ctx.strokeStyle = '#e5484d'; ctx.lineWidth = 3;
  ctx.beginPath(); ctx.moveTo(X(-42.5), Y(89)); ctx.lineTo(X(42.5), Y(89)); ctx.stroke();
  ctx.save();
  ctx.fillStyle = 'rgba(94,200,248,0.30)';
  ctx.strokeStyle = 'rgba(94,200,248,0.85)'; ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.ellipse(X(0), Y(89), 6 * pxX, 6 * pxY, 0, 0, Math.PI); ctx.closePath(); ctx.fill(); ctx.stroke();
  ctx.restore();
  ctx.fillStyle = '#0d1524'; ctx.strokeStyle = 'rgba(255,255,255,0.45)'; ctx.lineWidth = 1.5;
  ctx.fillRect(X(-3), Y(93), X(3) - X(-3), Y(89) - Y(93));
  ctx.strokeRect(X(-3), Y(93), X(3) - X(-3), Y(89) - Y(93));
  // ---- shots: goals glow, attempts dim ----
  for (const s of shots) {
    const px = X(Math.max(-42.5, Math.min(42.5, s.y)));
    const py = Y(Math.max(-3, Math.min(100, s.x)));
    ctx.save();
    if (s.goal) {
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
  ctx.restore();
  rinkPath();
  ctx.strokeStyle = 'rgba(235,242,255,0.55)'; ctx.lineWidth = 3; ctx.stroke();
}
/* ---------------- ice time · last 6 (minutes sidecar) ----------------
   data/min-<date>.json is built by data-builder/minutes.js: per skater,
   the last 6 games with TOI bars and a shift map (green even strength,
   gold power play, blue penalty kill, red off). Loaded lazily on the
   first card open; a missing sidecar just hides the section. */
let minSidecar = null, minSidecarState = 'idle'; // idle | loading | ok | fail
const minSel = {}; // pid -> selected game index
function minFmtSec(s) {
  s = Math.round(s || 0);
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
}
function minFmtDate(dstr) {
  if (!dstr) return '';
  return new Date(dstr + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}
async function loadMinSidecar() {
  if (minSidecarState === 'loading' || minSidecarState === 'ok') return;
  minSidecarState = 'loading';
  try {
    const r = await dataFetch(`data/min-${state.date}.json`, { headers: { 'Accept': 'application/json' } });
    if (!r.ok) throw new Error('no sidecar');
    minSidecar = await r.json();
    minSidecarState = 'ok';
  } catch (e) { minSidecarState = 'fail'; }
}
function minGamesFor(r) {
  return (minSidecar && minSidecar.players && minSidecar.players[String(r.pid)]) || [];
}
function pcMinSlotHtml(r) {
  if (minSidecarState === 'ok') return pcMinutesHtml(r);
  if (minSidecarState === 'fail') return '';
  return `<div class="pc-min" data-min-slot="${esc(String(r.pid))}"><div class="pc-min-h"><span class="pc-min-t">Ice time</span></div><p class="muted small" style="margin:.35rem 0 0">Loading ice time…</p></div>`;
}
function pcMinutesHtml(r) {
  const games = minGamesFor(r);
  if (!games.length) return '';
  const sel = Math.max(0, Math.min(minSel[r.pid] != null ? minSel[r.pid] : games.length - 1, games.length - 1));
  minSel[r.pid] = sel;
  const maxToi = Math.max(...games.map((g) => g.toi), 1);
  const avgSec = (r.toiMin || 0) * 60;
  const avgBottomPx = Math.min(92, (avgSec / maxToi) * 92); // .min-barzone is 92px tall
  const cols = games.map((g, i) => {
    const h = Math.max(9, (g.toi / maxToi) * 100);
    return `<button type="button" class="min-col${i === sel ? ' sel' : ''}" data-mi="${i}" aria-label="Break down the game ${g.hr === 'R' ? 'at' : 'vs'} ${esc(g.opp)}">
      <span class="min-val">${minFmtSec(g.toi)}</span>
      <span class="min-barzone"><span class="min-bar" style="height:${h.toFixed(1)}%"></span></span>
    </button>`;
  }).join('');
  const labs = games.map((g) => `<span class="min-lab">${esc(g.hr === 'R' ? '@' + g.opp : g.opp)}</span>`).join('');
  return `<div class="pc-min" data-min-root>
    <div class="pc-min-h"><span class="pc-min-t">Ice time · last ${games.length}</span><span class="pc-min-avg">AVG ${fmtToi(r.toiMin || 0)}</span></div>
    <div class="min-chart"><div class="min-avgline" style="bottom:${avgBottomPx.toFixed(0)}px"></div><div class="min-cols">${cols}</div></div>
    <div class="min-labs">${labs}</div>
    <div class="min-hint">Tap a bar to break down that game</div>
    ${minMapHtml(games[sel])}
  </div>`;
}
function minMapHtml(g) {
  if (!g) return '';
  const len = g.len || (g.per && g.per[3] > 0 ? 3900 : 3600);
  const pct = (s) => (s / len) * 100;
  const segs = (g.seg || []).map(([s, e, k]) =>
    `<span class="min-seg k${k}" style="left:${pct(s).toFixed(2)}%;width:${Math.max(0.7, pct(e - s)).toFixed(2)}%"></span>`).join('');
  const divs = [1200, 2400, 3600].filter((t) => t < len)
    .map((t) => `<span class="min-div" style="left:${pct(t).toFixed(2)}%"></span>`).join('');
  const nPer = len > 3600 ? 4 : 3;
  const plabs = [];
  for (let i = 0; i < nPer; i++) {
    const c = i < 3 ? i * 1200 + 600 : 3750;
    plabs.push(`<span class="min-plab" style="left:${pct(c).toFixed(2)}%">${i < 3 ? 'P' + (i + 1) : 'OT'}</span>`);
  }
  const chips = [];
  for (let i = 0; i < nPer; i++) {
    if (i === 3 && !(g.per[3] > 0)) continue;
    chips.push(`<span class="min-chip">${i < 3 ? 'P' + (i + 1) : 'OT'} ${minFmtSec(g.per[i])}</span>`);
  }
  if (g.pp >= 10) chips.push(`<span class="min-chip pp">PP ${minFmtSec(g.pp)}</span>`);
  if (g.pk >= 10) chips.push(`<span class="min-chip pk">PK ${minFmtSec(g.pk)}</span>`);
  const legend = [];
  if (g.pp > 0) legend.push('<span><i style="background:#f5b942"></i>PP</span>');
  if (g.pk > 0) legend.push('<span><i style="background:#60a5fa"></i>PK</span>');
  legend.push('<span><i style="background:#34d399"></i>even</span>');
  legend.push('<span><i style="background:#e24b4b"></i>off</span>');
  return `<div class="min-map">
    <div class="min-map-h"><span class="min-map-t">${g.hr === 'R' ? 'at' : 'vs'} ${esc(g.opp)} · ${esc(minFmtDate(g.d))}</span><span class="min-legend">${legend.join('')}</span></div>
    <div class="min-track">${segs}${divs}</div>
    <div class="min-plabels">${plabs.join('')}</div>
    <div class="min-chips">${chips.join('')}</div>
  </div>`;
}
function wireMinutes(r) {
  const body = $('modalBody');
  if (!body) return;
  body.querySelectorAll('[data-mi]').forEach((b) => b.addEventListener('click', () => {
    minSel[r.pid] = Number(b.dataset.mi);
    const root = body.querySelector('[data-min-root]');
    if (root) { root.outerHTML = pcMinutesHtml(r); wireMinutes(r); }
  }));
}
/* Accordion helper (NBA-style folded card): when a lazy sidecar section
   resolves to no content, drop the whole folded section rather than
   stranding a "Loading…" placeholder inside it. */
function dropAccSlot(slot) {
  const sec = slot.closest('details.pcacc');
  if (sec) sec.remove(); else slot.remove();
}
async function ensureMinutes(r) {
  await loadMinSidecar();
  const body = $('modalBody');
  if (!body) return;
  const slot = body.querySelector(`[data-min-slot="${esc(String(r.pid))}"]`);
  if (!slot) return;
  const html = minSidecarState === 'ok' ? pcMinutesHtml(r) : '';
  if (!html) { dropAccSlot(slot); return; }
  slot.outerHTML = html;
  wireMinutes(r);
}
/* ---------------- chemistry (chem sidecar) ----------------
   data/chem-<date>.json from data-builder/chem.js: season goal
   involvement (scores vs sets up, fed by, feeds) + shared-TOI %. */
let chemSidecar = null, chemSidecarState = 'idle';
async function loadChemSidecar() {
  if (chemSidecarState === 'loading' || chemSidecarState === 'ok') return;
  chemSidecarState = 'loading';
  try {
    const r = await dataFetch(`data/chem-${state.date}.json`, { headers: { 'Accept': 'application/json' } });
    if (!r.ok) throw new Error('no sidecar');
    chemSidecar = await r.json();
    chemSidecarState = 'ok';
  } catch (e) { chemSidecarState = 'fail'; }
}
function pcChemSlotHtml(r) {
  if (chemSidecarState === 'ok') return pcChemHtml(r);
  if (chemSidecarState === 'fail') return '';
  return `<div class="pc-min" data-chem-slot="${esc(String(r.pid))}"><div class="pc-min-h"><span class="pc-min-t">Chemistry</span></div><p class="muted small" style="margin:.35rem 0 0">Loading chemistry…</p></div>`;
}
function chemRowsHtml(list, base, cls) {
  if (!list || !list.length || !base) return '';
  return list.map((x) => {
    const p = Math.round((x.n / base) * 100);
    return `<div class="chem-row"><span class="chem-name">${esc(x.name)}</span><span class="chem-track"><span class="chem-fill ${cls}" style="width:${Math.max(3, p)}%"></span></span><span class="chem-pct">${p}%</span></div>`;
  }).join('');
}
function pcChemHtml(r) {
  const c = (chemSidecar && chemSidecar.players && chemSidecar.players[String(r.pid)]) || null;
  if (!c || (c.g + c.a) < 4) return '';
  const inv = c.g + c.a;
  const scoreP = Math.round((c.g / inv) * 100);
  const setupP = 100 - scoreP;
  const splitLab = (p, txt) => (p >= 26 ? `${txt} ${p}%` : `${p}%`);
  let h = `<div class="pc-min" data-chem-root>
    <div class="pc-min-h"><span class="pc-min-t">Chemistry</span></div>
    <div class="chem-sec-t" style="margin-top:.55rem">Role · his ${inv} goal involvements this season</div>
    <div class="chem-split"><span class="cs-gold" style="width:${scoreP}%">${splitLab(scoreP, 'SCORES')}</span><span class="cs-teal" style="width:${setupP}%">${splitLab(setupP, 'SETS UP')}</span></div>
    <p class="chem-sub">${c.g} goals · ${c.a} assists${c.a >= 3 ? ` — ${c.a1} of the ${c.a} assists are primary` : ''}</p>`;
  if (c.g >= 3 && c.fed && c.fed.length) {
    h += `<div class="chem-sec-t">Fed by · % of his ${c.g} goals with an assist from</div>${chemRowsHtml(c.fed, c.g, 'teal')}`;
  }
  if (c.a >= 3 && c.feeds && c.feeds.length) {
    h += `<div class="chem-sec-t">Feeds · % of his ${c.a} assists finished by</div>${chemRowsHtml(c.feeds, c.a, 'gold')}`;
  }
  if (c.shared && c.shared.length) {
    h += `<div class="chem-sec-t">Shares the ice with · last ${c.sharedGames} games</div>` + c.shared.map((x) =>
      `<div class="chem-row"><span class="chem-name">${esc(x.name)}</span><span class="chem-track"><span class="chem-fill blue" style="width:${Math.max(3, x.pct)}%"></span></span><span class="chem-pct">${x.pct}%</span></div>`).join('');
  }
  return h + '</div>';
}
async function ensureChem(r) {
  await loadChemSidecar();
  const body = $('modalBody');
  if (!body) return;
  const slot = body.querySelector(`[data-chem-slot="${esc(String(r.pid))}"]`);
  if (!slot) return;
  const html = chemSidecarState === 'ok' ? pcChemHtml(r) : '';
  if (!html) { dropAccSlot(slot); return; }
  slot.outerHTML = html;
}
/* ---------------- finishing vs shot quality (finish sidecar) ----------------
   data/finish-<date>.json is exported LOCALLY by
   ~/workspace/nhl-specific/shooter-xg/export_finish.py (frozen sklearn
   xG model — it cannot run in the Actions node builder) and committed,
   same pattern as the manual healthy-bundle fallback. Window =
   2025-26 + this season to date: goals vs expected goals (xG), with the
   multiplier shrunk toward the position average. DISPLAY ONLY — it
   feeds no price anywhere. Loaded lazily on the first card open; a
   missing sidecar (or a player under the sample floor) hides the
   section silently. */
let finSidecar = null, finSidecarState = 'idle'; // idle | loading | ok | fail
async function loadFinSidecar() {
  if (finSidecarState === 'loading' || finSidecarState === 'ok') return;
  finSidecarState = 'loading';
  try {
    const r = await dataFetch(`data/finish-${state.date}.json`, { headers: { 'Accept': 'application/json' } });
    if (!r.ok) throw new Error('no sidecar');
    finSidecar = await r.json();
    finSidecarState = 'ok';
  } catch (e) { finSidecarState = 'fail'; }
}
function pcFinSlotHtml(r) {
  if (finSidecarState === 'ok') return pcFinHtml(r);
  if (finSidecarState === 'fail') return '';
  return `<div class="pc-min" data-fin-slot="${esc(String(r.pid))}"><div class="pc-min-h"><span class="pc-min-t">Finishing</span></div><p class="muted small" style="margin:.35rem 0 0">Loading finishing…</p></div>`;
}
function pcFinHtml(r) {
  const f = (finSidecar && finSidecar.players && finSidecar.players[String(r.pid)]) || null;
  if (!f) return '';
  const mult = f.mult;
  const band = mult >= 1.10 ? 'up' : mult < 0.95 ? 'down' : 'mid';
  const chip = band === 'up' ? 'BURYING HIS CHANCES' : band === 'down' ? 'GETTING CHANCES, NOT FINISHING' : 'RIGHT AT EXPECTATION';
  const multCol = band === 'up' ? 'var(--teal)' : band === 'down' ? 'var(--gold)' : 'inherit';
  const maxv = Math.max(f.goals, f.xg, 1);
  const diff = f.goals - f.xg;
  const delta = diff >= 0.5 ? `+${diff.toFixed(1)} goals above what his shots usually produce`
    : diff <= -0.5 ? `${Math.abs(diff).toFixed(1)} goals below what his shots usually produce`
    : 'Right in line with what his shots usually produce';
  const through = finSidecar.through
    ? new Date(finSidecar.through + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
    : '';
  let h = `<div class="pc-min" data-fin-root>
    <div class="pc-min-h"><span class="pc-min-t">Finishing</span><span class="fin-mult" style="color:${multCol}">${mult.toFixed(2)}×</span></div>
    <div class="fin-win">${esc(finSidecar.windowLabel || '2025-26 + this season')} · goals vs shot quality${through ? ` · through ${esc(through)}` : ''}</div>
    <span class="fin-chip ${band}">${chip}</span>
    <div class="fin-bar-row"><div class="fin-bar-lab"><span>GOALS</span><span class="fin-bar-val">${f.goals}</span></div><div class="fin-track"><span class="fin-fill goals" style="width:${(f.goals / maxv * 100).toFixed(1)}%"></span></div></div>
    <div class="fin-bar-row"><div class="fin-bar-lab"><span>EXPECTED (SHOT QUALITY)</span><span class="fin-bar-val">${f.xg.toFixed(1)}</span></div><div class="fin-track"><span class="fin-fill xg" style="width:${(f.xg / maxv * 100).toFixed(1)}%"></span></div></div>
    <p class="fin-delta">${delta}</p>`;
  const l10 = f.last10 || [];
  if (l10.length >= 3) {
    const maxG = Math.max(3, ...l10.map((x) => x.g));
    const cols = l10.map((x) => {
      const bh = x.g > 0 ? Math.max(10, (x.g / maxG) * 100) : 0;
      const ty = Math.min(96, (x.xg / maxG) * 100);
      return `<div class="fin-col"><span class="fin-gnum">${x.g > 0 ? x.g : ''}</span><span class="fin-gzone">${x.g > 0 ? `<span class="fin-gbar" style="height:${bh.toFixed(0)}%"></span>` : ''}<span class="fin-tick" style="bottom:${ty.toFixed(0)}%"></span></span></div>`;
    }).join('');
    const tg = l10.reduce((a, x) => a + x.g, 0);
    const tx = l10.reduce((a, x) => a + x.xg, 0);
    h += `<div class="chem-sec-t">Last ${l10.length} games · this season</div>
    <div class="fin-strip">${cols}</div>
    <p class="fin-cap">Teal = goals · gold tick = expected that game · ${tg} goals vs ${tx.toFixed(1)} expected</p>`;
  }
  h += `<p class="fin-foot">What he's done with his chances — not a price input.</p></div>`;
  return h;
}
async function ensureFinish(r) {
  await loadFinSidecar();
  const body = $('modalBody');
  if (!body) return;
  const slot = body.querySelector(`[data-fin-slot="${esc(String(r.pid))}"]`);
  if (!slot) return;
  const html = finSidecarState === 'ok' ? pcFinHtml(r) : '';
  if (!html) { dropAccSlot(slot); return; }
  slot.outerHTML = html;
}
/* ---------------- NHL EDGE tracking (live EDGE endpoints) ----------------
   Season tracking from the NHL's own EDGE API — shot speed, skating
   speed/bursts and zone time for skaters; save % by danger band for
   goalies — fetched live through the same /nhl-api proxy as every
   other NHL call (api-web.nhle.com sends no CORS headers; the
   netlify.toml rewrite is the browser route). The /now form
   307-redirects off-proxy, so the explicit season form is used.
   DISPLAY ONLY — EDGE numbers feed no price, probability or sort
   anywhere. Loaded lazily on the section's first open, cached per
   player for the session; any fetch error or an empty EDGE record
   drops the section silently. */
const EDGE_PATH = `${SEASON}/2`; // EDGE season form, e.g. 20262027/2
const edgeSkaterCache = new Map(); // pid -> Promise<parsed|null>
const edgeGoalieCache = new Map(); // pid -> Promise<parsed|null>
function edgeNum(x) { const n = Number(x); return Number.isFinite(n) ? n : null; }
function edgePctLabel(p) {
  if (p == null) return '';
  const v = p * 100;
  if (v >= 99.95) return '100th';
  if (v >= 99) return v.toFixed(1) + 'th';
  const n = Math.round(v);
  const suf = (n % 100 >= 10 && n % 100 <= 20) ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] || 'th');
  return n + suf;
}
function edgeFetch(path) {
  return fetchJSON(`${API}/edge/${path}`).catch(() => null);
}
/* --- skater --- */
function parseEdgeSkater(detail, shot, skate) {
  const d = { shot: null, skating: null, zone: null, teamAbbr: null };
  if (detail && detail.player && detail.player.team && detail.player.team.abbrev) d.teamAbbr = detail.player.team.abbrev;
  const sd = shot && shot.shotSpeedDetails;
  const topSrc = (sd && sd.topShotSpeed) || (detail && detail.topShotSpeed);
  if (topSrc && edgeNum(topSrc.imperial) != null) {
    const avg = sd && sd.avgShotSpeed;
    const bands = [];
    if (sd) {
      const band = (lab, o) => { const v = o && edgeNum(o.value); if (v != null) bands.push({ lab, n: v }); };
      band('70–80 mph', sd.shotAttempts70To80);
      band('80–90 mph', sd.shotAttempts80To90);
      const hi = (sd.shotAttempts90To100 ? edgeNum(sd.shotAttempts90To100.value) : null);
      const over = (sd.shotAttemptsOver100 ? edgeNum(sd.shotAttemptsOver100.value) : null);
      if (hi != null || over != null) bands.push({ lab: '90+ mph', n: (hi || 0) + (over || 0) });
    }
    d.shot = {
      top: { v: topSrc.imperial, pct: edgeNum(topSrc.percentile), lg: topSrc.leagueAvg ? edgeNum(topSrc.leagueAvg.imperial) : null },
      avg: (avg && edgeNum(avg.imperial) != null)
        ? { v: avg.imperial, pct: edgeNum(avg.percentile), lg: avg.leagueAvg ? edgeNum(avg.leagueAvg.imperial) : null } : null,
      bands,
      overlay: topSrc.overlay || null,
    };
  }
  const kd = skate && skate.skatingSpeedDetails;
  const kTop = (kd && kd.maxSkatingSpeed) || (detail && detail.skatingSpeed && detail.skatingSpeed.speedMax);
  if (kTop && edgeNum(kTop.imperial) != null) {
    const b22 = kd && kd.burstsOver22 ? edgeNum(kd.burstsOver22.value) : null;
    const b2022 = kd && kd.bursts20To22 ? edgeNum(kd.bursts20To22.value) : null;
    const b20 = detail && detail.skatingSpeed && detail.skatingSpeed.burstsOver20;
    d.skating = {
      top: { v: kTop.imperial, pct: edgeNum(kTop.percentile), lg: kTop.leagueAvg ? edgeNum(kTop.leagueAvg.imperial) : null },
      bursts: (b22 != null || b2022 != null) ? (b22 || 0) + (b2022 || 0) : (b20 ? edgeNum(b20.value) : null),
      bursts22: b22,
      burstsPct: b20 ? edgeNum(b20.percentile) : null,
    };
  }
  const z = detail && detail.zoneTimeDetails;
  if (z && edgeNum(z.offensiveZonePctg) != null && edgeNum(z.neutralZonePctg) != null && edgeNum(z.defensiveZonePctg) != null) {
    d.zone = {
      off: z.offensiveZonePctg * 100, neu: z.neutralZonePctg * 100, def: z.defensiveZonePctg * 100,
      offPct: edgeNum(z.offensiveZonePercentile), offLg: edgeNum(z.offensiveZoneLeagueAvg),
    };
  }
  return (d.shot || d.skating || d.zone) ? d : null;
}
function loadEdgeSkater(pid) {
  const key = String(pid);
  if (!edgeSkaterCache.has(key)) {
    edgeSkaterCache.set(key, (async () => {
      const [detail, shot, skate] = await Promise.all([
        edgeFetch(`skater-detail/${pid}/${EDGE_PATH}`),
        edgeFetch(`skater-shot-speed-detail/${pid}/${EDGE_PATH}`),
        edgeFetch(`skater-skating-speed-detail/${pid}/${EDGE_PATH}`),
      ]);
      return parseEdgeSkater(detail, shot, skate);
    })());
  }
  return edgeSkaterCache.get(key);
}
function edgeTileHtml(lab, valHtml, sub, pct) {
  return `<div class="edge-tile"><div class="edge-tile-lab">${lab}</div><div class="edge-tile-val">${valHtml}</div>`
    + (sub ? `<div class="edge-tile-sub">${sub}</div>` : '')
    + (pct != null ? `<div class="edge-pbar"><span style="width:${Math.max(2, Math.round(pct * 100))}%"></span></div>` : '')
    + `</div>`;
}
function edgeTileSub(pct, lg, unit) {
  const parts = [];
  if (pct != null) parts.push(`${edgePctLabel(pct)} %ile`);
  if (lg != null) parts.push(`league ${lg.toFixed(1)}${unit || ''}`);
  return parts.join(' · ');
}
function pcEdgeHtml(r, d) {
  let h = `<div class="pc-min" data-edge-root>
    <div class="pc-min-h"><span class="pc-min-t">NHL Edge</span><span class="edge-season">2026-27 season</span></div>`;
  if (d.shot) {
    const s = d.shot;
    h += `<div class="chem-sec-t" style="margin-top:.55rem">Shot speed</div><div class="edge-tiles">`;
    h += edgeTileHtml('HARDEST', `${s.top.v.toFixed(1)} <small>mph</small>`, edgeTileSub(s.top.pct, s.top.lg), s.top.pct);
    if (s.avg) h += edgeTileHtml('AVERAGE', `${s.avg.v.toFixed(1)} <small>mph</small>`, edgeTileSub(s.avg.pct, s.avg.lg), s.avg.pct);
    h += `</div>`;
    if (s.bands.length) {
      const maxN = Math.max(...s.bands.map((b) => b.n));
      h += `<div class="edge-bands"><span>Attempts by band:</span>`
        + s.bands.map((b) => `<span class="edge-chip${b.n === maxN && maxN > 0 ? ' hot' : ''}">${b.lab} ×${b.n}</span>`).join('')
        + `</div>`;
    }
    const ov = s.overlay;
    if (ov && ov.gameDate && ov.awayTeam && ov.homeTeam) {
      const mon = new Date(ov.gameDate + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
      const homeGame = ov.homeTeam.abbrev === (d.teamAbbr || r.team);
      const opp = homeGame ? ov.awayTeam.abbrev : ov.homeTeam.abbrev;
      const per = ov.periodDescriptor && ov.periodDescriptor.number;
      const perOrd = per === 1 ? '1st' : per === 2 ? '2nd' : per === 3 ? '3rd' : per ? `${per}th` : '';
      h += `<p class="edge-note">Season hardest: ${esc(mon)} ${homeGame ? 'vs' : 'at'} ${esc(opp)}${perOrd ? ` · ${perOrd} period` : ''}${ov.timeInPeriod ? `, ${esc(ov.timeInPeriod)}` : ''}</p>`;
    }
  }
  if (d.skating) {
    const k = d.skating;
    h += `<div class="chem-sec-t">Skating</div><div class="edge-tiles">`;
    h += edgeTileHtml('TOP SPEED', `${k.top.v.toFixed(1)} <small>mph</small>`, edgeTileSub(k.top.pct, k.top.lg), k.top.pct);
    if (k.bursts != null) {
      const sub = [k.bursts22 != null ? `${k.bursts22} at 22+ mph` : '', k.burstsPct != null ? `${edgePctLabel(k.burstsPct)} %ile` : ''].filter(Boolean).join(' · ');
      h += edgeTileHtml('BURSTS 20+ MPH', `${k.bursts}`, sub, k.burstsPct);
    }
    h += `</div>`;
  }
  if (d.zone) {
    const z = d.zone;
    const znote = z.offPct != null ? `Offensive zone ${edgePctLabel(z.offPct)} %ile${z.offLg != null ? ` · league ${(z.offLg * 100).toFixed(1)}%` : ''}` : '';
    h += `<div class="chem-sec-t">Zone time${znote ? ` <span class="edge-zone-note">${znote}</span>` : ''}</div>
    <div class="edge-zonebar"><span class="z-off" style="width:${z.off.toFixed(1)}%"></span><span class="z-neu" style="width:${z.neu.toFixed(1)}%"></span><span class="z-def" style="width:${z.def.toFixed(1)}%"></span></div>
    <div class="edge-zone-labs"><span><b>Offensive</b> ${z.off.toFixed(1)}%</span><span><b>Neutral</b> ${z.neu.toFixed(1)}%</span><span><b>Defensive</b> ${z.def.toFixed(1)}%</span></div>
    <p class="edge-note">Share of ice time by zone · all situations</p>`;
  }
  h += `<p class="fin-foot">NHL EDGE tracking · display only — not a price input</p></div>`;
  return h;
}
function pcEdgeSlotHtml(r) {
  return `<div class="pc-min" data-edge-slot="${esc(String(r.pid))}"><div class="pc-min-h"><span class="pc-min-t">NHL Edge</span></div><p class="muted small" style="margin:.35rem 0 0">Loading NHL EDGE tracking…</p></div>`;
}
async function ensureEdge(r) {
  const d = await loadEdgeSkater(r.pid);
  const body = $('modalBody');
  if (!body) return;
  const slot = body.querySelector(`[data-edge-slot="${esc(String(r.pid))}"]`);
  if (!slot) return;
  const html = d ? pcEdgeHtml(r, d) : '';
  if (!html) { dropAccSlot(slot); return; }
  slot.outerHTML = html;
}
/* --- goalie (danger-band save %; strip lives on the goalie card) --- */
function parseEdgeGoalie(payload) {
  const rows = (payload && payload.shotLocationSummary) || [];
  const by = {};
  for (const row of rows) if (row && row.locationCode) by[row.locationCode] = row;
  const band = (code) => {
    const row = by[code];
    if (!row || edgeNum(row.savePctg) == null) return null;
    const saves = edgeNum(row.saves) || 0;
    const ga = edgeNum(row.goalsAgainst) || 0;
    return { sv: row.savePctg, saves, shots: saves + ga, lg: edgeNum(row.savePctgLeagueAvg) };
  };
  const out = { all: band('all'), high: band('high'), mid: band('mid'), long: band('long') };
  if (!out.all && payload && payload.player && edgeNum(payload.player.savePctg) != null) {
    out.all = { sv: payload.player.savePctg, saves: 0, shots: 0, lg: null };
  }
  return (out.high || out.mid || out.long) ? out : null;
}
function loadEdgeGoalie(pid) {
  const key = String(pid);
  if (!edgeGoalieCache.has(key)) {
    edgeGoalieCache.set(key, edgeFetch(`goalie-detail/${pid}/${EDGE_PATH}`).then(parseEdgeGoalie));
  }
  return edgeGoalieCache.get(key);
}
function edgeSvFmt(sv) {
  const s = sv.toFixed(3);
  return s.startsWith('0') ? s.slice(1) : s;
}
function pcGedgeHtml(pg, d) {
  const bandTile = (cls, lab, b) => {
    if (!b) return '';
    const delta = b.lg != null ? b.sv - b.lg : null;
    const dHtml = delta != null
      ? `<div class="edge-band-delta ${delta >= 0.01 ? 'up' : delta <= -0.01 ? 'dn' : ''}">${delta >= 0 ? '+' : '−'}${Math.abs(delta).toFixed(3).replace(/^0/, '')} vs lg</div>` : '';
    return `<div class="edge-band ${cls}"><div class="edge-band-lab">${lab}</div>`
      + `<div class="edge-band-val">${edgeSvFmt(b.sv)}</div>${dHtml}`
      + (b.shots ? `<div class="edge-band-vol">${b.saves} saves · ${b.shots} shots</div>` : '')
      + (b.lg != null ? `<div class="edge-band-lg">league ${edgeSvFmt(b.lg)}</div>` : '')
      + `</div>`;
  };
  return `<div class="pc-min" data-gedge-root>
    <div class="pc-min-h"><span class="pc-min-t">NHL Edge · danger bands</span>${d.all ? `<span class="edge-all">ALL SHOTS ${edgeSvFmt(d.all.sv)}</span>` : ''}</div>
    <div class="edge-bands3">${bandTile('hi', 'HIGH DANGER', d.high)}${bandTile('mid', 'MID RANGE', d.mid)}${bandTile('lng', 'LONG RANGE', d.long)}</div>
    <p class="fin-foot">NHL EDGE tracking · display only — not a price input</p></div>`;
}
function pcGedgeSlotHtml(pg) {
  return `<div class="pc-min" data-gedge-slot="${esc(String(pg.id))}"><div class="pc-min-h"><span class="pc-min-t">NHL Edge · danger bands</span></div><p class="muted small" style="margin:.35rem 0 0">Loading NHL EDGE tracking…</p></div>`;
}
async function ensureGoalieEdge(pg) {
  const d = await loadEdgeGoalie(pg.id);
  const body = $('modalBody');
  if (!body) return;
  const slot = body.querySelector(`[data-gedge-slot="${esc(String(pg.id))}"]`);
  if (!slot) return;
  const html = d ? pcGedgeHtml(pg, d) : '';
  if (html) slot.outerHTML = html; else slot.remove();
}
/* ---------------- player types (nhl-types sidecar) ----------------
   data/nhl-types.json is built WEEKLY by data-builder/nhl-types.py:
   every skater clustered on his season shot diet (NHL EDGE shot
   locations) — forwards A–D, defensemen from E. The letter rides
   beside his name across the site (Markets, Board, Leaders, Longshots,
   search, player card). DISPLAY ONLY — types feed no price,
   probability or sort anywhere. A missing sidecar or an untyped
   player renders exactly as before. */
let typesSidecar = null, typesState = 'idle'; // idle | loading | ok | fail
async function loadTypes() {
  if (typesState === 'loading' || typesState === 'ok') return;
  typesState = 'loading';
  try {
    const r = await dataFetch('data/nhl-types.json', { headers: { 'Accept': 'application/json' } });
    if (!r.ok) throw new Error('no types sidecar');
    typesSidecar = await r.json();
    typesState = 'ok';
  } catch (e) { typesState = 'fail'; }
  if (typesState === 'ok') refreshTypeSurfaces();
}
function typeOf(pid) {
  if (typesState !== 'ok' || !typesSidecar || !typesSidecar.players) return null;
  return typesSidecar.players[String(pid)] || null;
}
/* Shared badge helper: glass teal letter chip. Returns '' for untyped
   players so every call site is fail-soft. Dense surfaces (Board rows,
   Markets tables) pass compact=true and get the letter only — the full
   letter + name pill hides the table on phone widths. The card header,
   Types view, Longshots, Standouts and search keep the full pill. */
function typeBadgeHtml(pid, compact) {
  const t = typeOf(pid);
  if (!t) return '';
  const meta = (typesSidecar.letters || {})[t.letter] || {};
  const leanName = t.lean ? ((typesSidecar.letters[t.lean] || {}).name || t.lean) : null;
  const title = `${t.letter} · ${t.type}${leanName ? ` · borderline, leans ${t.lean} ${leanName}` : ''}${meta.desc ? ` — ${meta.desc}` : ''} Display only, not a price input.`;
  if (compact) return `<span class="type-badge compact" title="${esc(title)}"><span class="tb-l">${esc(t.letter)}</span></span>`;
  return `<span class="type-badge" title="${esc(title)}"><span class="tb-l">${esc(t.letter)}</span><span class="tb-n">${esc(t.type)}</span></span>`;
}
function refreshTypeSurfaces() {
  renderTypes();
  if (!state.skaters || !state.skaters.length) return;
  setMarketKind(state.marketKind); // Markets tables + Leaders carry pnameBtn badges
  renderBoard();
  renderLongshots();
  renderStandouts();
}
const TYPE_AREA_LABEL = { netfront: 'net-front', slot: 'slot', circles: 'circles', points: 'point', corners: 'corners', outside: 'outside', long: 'long range' };
function pcTypeStripHtml(r) {
  const t = typeOf(r.pid);
  if (!t) return '';
  const meta = (typesSidecar.letters || {})[t.letter] || {};
  const leanMeta = t.lean ? (typesSidecar.letters[t.lean] || {}) : null;
  const top = (t.topAreas || []).map((a) => `${esc(TYPE_AREA_LABEL[a.area] || a.area)} ${Math.round(a.share * 100)}%`).join(' · ');
  return `<div class="pc-type-strip"><span class="pts-lab">TYPE ${esc(t.letter)} · ${esc((t.type || '').toUpperCase())}</span>${esc(meta.desc || '')}`
    + `<div class="pts-fit">Fit ${Math.round((t.fit || 0) * 100)}%${leanMeta ? ` · borderline — leans ${esc(t.lean)} ${esc(leanMeta.name || '')}` : ''}${top ? ` · diet: ${top}` : ''} · ${t.sog} shots on goal this season · display only</div></div>`;
}
/* Types view: a pills row (one pill per letter) over a single glass
   panel — only the selected type renders, so the view is one screen
   instead of six stacked groups. The panel header carries the type's
   descriptor; member rows show the face and the TEAM LOGO (logos, not
   abbreviations, per Alex's site-wide rule). */
let typeSel = 'A';
function renderTypes() {
  const el = $('typesBody');
  if (!el) return;
  if (typesState !== 'ok' || !typesSidecar) {
    el.innerHTML = '<p class="muted">Player types have not loaded for this slate yet.</p>';
    return;
  }
  const letters = typesSidecar.letters || {};
  const players = typesSidecar.players || {};
  const byLetter = {};
  for (const [pid, t] of Object.entries(players)) (byLetter[t.letter] = byLetter[t.letter] || []).push({ pid, ...t });
  const order = Object.keys(letters).sort();
  if (!order.length) {
    el.innerHTML = '<p class="muted">No typed skaters yet.</p>';
    return;
  }
  if (!order.includes(typeSel)) typeSel = order[0];
  const slate = new Map((state.skaters || []).map((r) => [String(r.pid), r]));
  let html = '<div class="type-pills">' + order.map((L) =>
    `<button type="button" class="type-pill${L === typeSel ? ' on' : ''}" data-typepill="${esc(L)}" aria-pressed="${L === typeSel}"><span class="tp-l">${esc(L)}</span><span class="tp-n">${esc(letters[L].name)}</span></button>`
  ).join('') + '</div>';
  const L = typeSel;
  const meta = letters[L];
  const members = (byLetter[L] || []).slice().sort((a, b) => ((b.fit || 0) - (a.fit || 0)) || ((b.sog || 0) - (a.sog || 0)));
  html += `<div class="types-group"><div class="types-head"><span class="type-badge"><span class="tb-l">${esc(L)}</span><span class="tb-n">${esc(meta.name)}</span></span><span class="types-count">${members.length} skaters</span></div>`
    + `<p class="types-desc">${esc(meta.desc || '')}</p><div class="types-members">`;
  html += members.map((m) => {
    const row = slate.get(String(m.pid));
    const nameHtml = row
      ? pnameBtn(row)
      : `<span class="pname pname-static"><img class="pavatar" src="${esc(m.headshot || headshotUrl(m.team, m.pid))}" alt="" ${imgFallback}><span class="pname-name">${esc(m.name)}</span></span>`;
    const lean = m.lean ? ` <span class="type-badge lean" title="Borderline — leans ${esc(m.lean)} ${esc((letters[m.lean] || {}).name || '')}"><span class="tb-l">${esc(m.lean)}</span></span>` : '';
    const top = (m.topAreas || []).map((a) => `${esc(TYPE_AREA_LABEL[a.area] || a.area)} ${Math.round(a.share * 100)}%`).join(' · ');
    return `<div class="type-row">${nameHtml}${lean}<img class="type-tlogo" src="${esc(teamLogoUrl(m.team))}" alt="" ${imgFallback}><span class="type-row-meta">${esc(m.pos)} · ${m.sog} SOG${top ? ` · ${top}` : ''}</span><span class="type-fit">${Math.round((m.fit || 0) * 100)}% fit</span></div>`;
  }).join('');
  html += '</div></div>';
  el.innerHTML = html;
  el.querySelectorAll('[data-typepill]').forEach((b) => b.addEventListener('click', () => { typeSel = b.dataset.typepill; renderTypes(); }));
  wirePnameClicks(el);
}
/* ---------------- standouts (goalie-matchup reads) ----------------
   Tonight's slate read against the goalie each skater faces, computed
   client-side from the day's bundle. READ layer: the opposing priced
   goalie's save % (the bundle price), his recent danger-band and zone
   numbers from charted shots, and the skater's zone fit against that
   goalie's weak zones — the same machinery as the card's Vs-goalie
   section. MODEL layer: the site's own probability for the chosen
   category. The two are shown separately, never blended. STACKED =
   the zone-fit read and the model agree (real fit AND a strong
   price). A row whose only case is a soft goalie is flagged as one —
   no fake edges. Every row prints its basis (goalie, priced SV,
   charted sample) or does not render: no priced goalie, no row.
   "Priced goalie" = the goalie the bundle priced (panelGoalie) — the
   page cannot confirm starters beyond the bundle. */
let soCat = 'atg';
let soCacheDate = null;
const SO_CATS = [
  { key: 'atg', label: 'Anytime Goal', floor: 0.15 },
  { key: 'firstgoal', label: 'First Goal', floor: 0.035 },
  { key: 'shots', label: 'Shots · o2.5', floor: 0.35, line: ['shots', 2.5] },
  { key: 'points', label: 'Points · o1.5', floor: 0.28, line: ['points', 1.5] },
  { key: 'twoplus', label: '2+ Goals', floor: 0.05 },
];
const SO_ZONE_LABEL = { 'Left-Low': 'low left', 'Center-Low': 'low middle', 'Right-Low': 'low right', 'Left-High': 'high left', 'Center-High': 'high middle', 'Right-High': 'high right' };
const soSvPct = (sv) => `${(sv * 100).toFixed(1)}%`;
const soGoalieCache = new Map();
function soGoalieStats(goalieId) {
  const key = String(goalieId);
  if (soGoalieCache.has(key)) return soGoalieCache.get(key);
  const shots = shotsAgainstGoalie(goalieId);
  const goals = goalsAgainstGoalie(goalieId);
  const hdS = shots.filter((s) => isHighDanger(s.x, s.y));
  const hdG = goals.filter((s) => isHighDanger(s.x, s.y));
  const out = {
    n: shots.length,
    hdN: hdS.length,
    hdSv: hdS.length >= 8 ? 1 - hdG.length / hdS.length : null,
    zones: goalieZoneStats(goalieId),
  };
  soGoalieCache.set(key, out);
  return out;
}
function buildStandoutCtx() {
  const games = new Map();
  for (const g of state.games || []) {
    for (const side of ['away', 'home']) {
      const team = g[side];
      games.set(`${g.id}|${team}`, { game: g, team, pg: panelGoalie(g, team) });
    }
  }
  const priced = new Map();
  const svs = [];
  for (const r of state.skaters || []) {
    const k = `${r.gameId}|${r.oppAbbr}`;
    if (!priced.has(k) && r.oppSv != null) priced.set(k, r.oppSv);
    if (r.oppSv != null) svs.push(r.oppSv);
  }
  svs.sort((a, b) => a - b);
  const q = (f) => (svs.length ? svs[Math.min(svs.length - 1, Math.floor(f * svs.length))] : null);
  return { games, priced, q1: q(0.25), q3: q(0.75) };
}
/* The read for one skater against his priced goalie. Returns null when
   there is no basis (no priced goalie / no priced SV) — the row then
   never renders. Kept separate from rendering so the logic is testable. */
function standoutRead(r, ctx) {
  const ent = ctx.games.get(`${r.gameId}|${r.oppAbbr}`);
  if (!ent || !ent.pg || !ent.pg.id) return null;
  const pricedSv = ctx.priced.get(`${r.gameId}|${r.oppAbbr}`);
  if (pricedSv == null) return null;
  const gs = soGoalieStats(ent.pg.id);
  const last = ent.pg.name.split(' ').slice(-1)[0];
  const soft = ctx.q1 != null && pricedSv <= ctx.q1;
  const tough = ctx.q3 != null && pricedSv >= ctx.q3;
  const diet = (r.seasonShots && r.seasonShots.length >= 8) ? r.seasonShots : (r.shots || []);
  let fit = false, antiFit = false, antiZone = null;
  const fitParts = [];
  if (diet.length >= 8 && gs.n >= 8) {
    const counts = {};
    for (const s of diet) { const z = netZone(s.x, s.y); counts[z] = (counts[z] || 0) + 1; }
    const topZones = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 2);
    const zoned = NET_ZONES.filter((z) => gs.zones[z] && gs.zones[z].sv != null);
    const weak = zoned.slice().sort((a, b) => gs.zones[a].sv - gs.zones[b].sv).slice(0, 2);
    const strong = zoned.slice().sort((a, b) => gs.zones[b].sv - gs.zones[a].sv).slice(0, 1);
    for (const [z, n] of topZones) {
      const share = n / diet.length;
      if (share < 0.18) continue;
      const gz = gs.zones[z];
      if (!gz || gz.sv == null) continue;
      if (weak.includes(z) && gz.sv <= 0.87) {
        fit = true;
        fitParts.push(`${Math.round(share * 100)}% of his shots go ${SO_ZONE_LABEL[z] || z} — that is where ${last} leaks (${soSvPct(gz.sv)} SV on ${gz.shots} shots)`);
      } else if (strong.includes(z) && gz.sv >= 0.93) {
        antiFit = true;
        antiZone = { z, sv: gz.sv, share };
      }
    }
    const hdShare = r.zone && !r.zone.lowSample ? r.zone.share : null;
    if (hdShare != null && hdShare >= 0.40 && gs.hdSv != null && gs.hdSv <= 0.815) {
      fit = true;
      fitParts.push(`his diet is ${Math.round(hdShare * 100)}% high-danger, and ${last} stops ${soSvPct(gs.hdSv)} of high-danger shots (${gs.hdN} charted)`);
    }
  }
  return { pg: ent.pg, pricedSv, gs, soft, tough, fit, antiFit, antiZone, fitParts };
}
function soProbFor(r, catKey, maps) {
  if (catKey === 'atg') return { p: r.p, fair: r.fair };
  if (catKey === 'firstgoal') { const e = maps.fg.get(r.pid); return e ? { p: e.fgP, fair: e.fgFair } : null; }
  if (catKey === 'twoplus') { const e = maps.tp.get(r.pid); return e ? { p: e.tpP, fair: e.tpFair } : null; }
  const cat = SO_CATS.find((c) => c.key === catKey);
  const m = cat && cat.line ? marketOver(r, cat.line[0], cat.line[1]) : null;
  return m ? { p: m.over, fair: m.overFair } : null;
}
function renderStandouts() {
  const body = $('standoutsBody');
  const catsEl = $('standoutCats');
  if (!body) return;
  if (catsEl) {
    catsEl.innerHTML = SO_CATS.map((c) => `<button type="button" class="so-cat${c.key === soCat ? ' on' : ''}" data-socat="${c.key}">${c.label}</button>`).join('');
    catsEl.querySelectorAll('[data-socat]').forEach((b) => b.addEventListener('click', () => { soCat = b.dataset.socat; renderStandouts(); }));
  }
  if (!(state.skaters || []).length) {
    body.innerHTML = '<p class="muted">No slate loaded yet.</p>';
    return;
  }
  if (soCacheDate !== state.date) { soGoalieCache.clear(); soCacheDate = state.date; }
  const cat = SO_CATS.find((c) => c.key === soCat) || SO_CATS[0];
  const ctx = buildStandoutCtx();
  const maps = {
    fg: new Map(firstGoalProbs().map((e) => [e.pid, e])),
    tp: new Map(twoPlusProbs().map((e) => [e.pid, e])),
  };
  const rows = [];
  for (const r of state.skaters) {
    const read = standoutRead(r, ctx);
    if (!read) continue;
    const pr = soProbFor(r, cat.key, maps);
    if (!pr || !(pr.p > 0)) continue;
    rows.push({ r, read, p: pr.p, fair: pr.fair });
  }
  const ps = rows.map((x) => x.p).sort((a, b) => a - b);
  const pQ3 = ps.length ? ps[Math.min(ps.length - 1, Math.floor(0.75 * ps.length))] : 1;
  for (const x of rows) {
    x.stacked = x.read.fit && (x.read.soft || x.p >= pQ3);
    x.goalieOnly = x.read.soft && !x.read.fit;
  }
  const standouts = rows.filter((x) => (x.read.fit || x.read.soft) && x.p >= cat.floor)
    .sort((a, b) => (Number(b.stacked) - Number(a.stacked)) || (b.p - a.p)).slice(0, 6);
  const toughSpots = rows.filter((x) => !x.read.fit && (x.read.tough || x.read.antiFit) && x.p >= cat.floor)
    .sort((a, b) => b.p - a.p).slice(0, 5);
  const lastOf = (name) => name.split(' ').slice(-1)[0];
  const rowHtml = (x, isTough) => {
    const { r, read } = x;
    const g = (state.games || []).find((gg) => String(gg.id) === String(r.gameId));
    const match = g ? `${r.team} ${r.team === g.home ? 'vs' : '@'} ${r.oppAbbr}` : r.team;
    let readText;
    if (read.fitParts.length) readText = read.fitParts.join('; ') + '.';
    else if (isTough) {
      readText = `${lastOf(read.pg.name)} is priced at ${soSvPct(read.pricedSv)} SV — toughest quarter tonight.`
        + (read.antiFit && read.antiZone ? ` His favourite area (${SO_ZONE_LABEL[read.antiZone.z] || read.antiZone.z}) is ${lastOf(read.pg.name)}'s strongest (${soSvPct(read.antiZone.sv)} SV).` : ' No zone fit either.');
    } else {
      readText = `No zone fit — the read is ${lastOf(read.pg.name)}'s priced number, softest quarter tonight.`;
    }
    const basis = `Basis — vs ${esc(read.pg.name)} (${esc(read.pg.tag ? read.pg.tag.toLowerCase() : 'priced goalie')}) · priced ${soSvPct(read.pricedSv)} SV`
      + (read.gs.hdSv != null ? ` · high-danger ${soSvPct(read.gs.hdSv)} SV on ${read.gs.hdN} charted shots` : '')
      + ` · ${read.gs.n} charted shots against, recent window`;
    return `<div class="so-row"><div class="so-row-head">${pnameBtn(r)}<span class="so-match">${esc(match)}</span>`
      + (x.stacked ? '<span class="so-stacked">STACKED</span>' : '')
      + (x.goalieOnly && !isTough ? '<span class="so-flag">⚠ CASE = SOFT GOALIE ONLY</span>' : '')
      + `</div><div class="so-read">${esc(readText)}</div>`
      + `<div class="so-model">Model — ${esc(cat.label)}: ${pct1(x.p)} (${esc(x.fair)} fair)</div>`
      + `<div class="so-basis">${basis}</div></div>`;
  };
  let html = '<p class="muted small">All reads are vs the <strong>priced goalie</strong> in each game — the goalie the bundle priced. The page cannot confirm starters beyond the bundle.</p>';
  html += '<div class="so-h">BIGGEST STANDOUTS TONIGHT</div>';
  html += standouts.length ? standouts.map((x) => rowHtml(x, false)).join('') : '<p class="muted">No standout reads in this category tonight — nobody with a real price has a zone fit or a soft priced goalie.</p>';
  if (toughSpots.length) {
    html += '<div class="so-h tough">TOUGH SPOTS TONIGHT</div>' + toughSpots.map((x) => rowHtml(x, true)).join('');
  }
  html += '<p class="so-foot">Goalie numbers are a read — the goalie\'s numbers, not a price. Stacked = the zone-fit read and the model agree. Zone and band numbers come from charted shots in the recent window, so samples are small — the basis line shows them.</p>';
  body.innerHTML = html;
  wirePnameClicks(body);
}
/* ---------------- last-10 shots vs projection (last10 sidecar) ----------------
   data/last10-<date>.json comes from data-builder/last10.js (build step
   12): per skater, SOG + attempt locations over his last 10 played games.
   DISPLAY ONLY — feeds no price. The player-card block joins the Shot Map
   section (Alex, 2026-11-08) under the existing rink canvas; the game
   sheet shows a strip of that game's own top shooters. Loaded lazily;
   a missing sidecar or thin sample hides the blocks silently. */
let l10Sidecar = null, l10SidecarState = 'idle'; // idle | loading | ok | fail
async function loadL10Sidecar() {
  if (l10SidecarState === 'loading' || l10SidecarState === 'ok') return;
  l10SidecarState = 'loading';
  try {
    const r = await dataFetch(`data/last10-${state.date}.json`, { headers: { 'Accept': 'application/json' } });
    if (!r.ok) throw new Error('no sidecar');
    l10Sidecar = await r.json();
    l10SidecarState = 'ok';
  } catch (e) { l10SidecarState = 'fail'; }
}
function l10For(r) {
  const d = (l10Sidecar && l10Sidecar.players && l10Sidecar.players[String(r.pid)]) || null;
  return d && typeof d.n === 'number' && typeof d.sog === 'number' && Array.isArray(d.att) ? d : null;
}
function l10Proj(r, n) {
  const mk = r.markets && r.markets.shots;
  const lam = Array.isArray(mk) ? (mk[0] && mk[0].lam) : (mk && mk.lam);
  return typeof lam === 'number' ? lam * n : null;
}
/* Bubble shot map on a half rink, Bueno style: teal rings = attempts,
   gold dots = goals, gold dashed line = home plate. att entries are
   [x, y, goal] in the display frame (attacking net at +x). */
function bubbleMapSvg(att, opts) {
  const size = opts === true ? 'mini' : (opts && opts.size) || 'card';
  const pts = (att || [])
    .map((a) => (Array.isArray(a) ? { x: a[0], y: a[1], goal: !!a[2] } : { x: a.x, y: a.y, goal: !!a.goal }))
    .filter((p) => p.x != null && p.y != null);
  if (size === 'full') {
    // 400x430 — the exact footprint of the old canvas/zone maps on player
    // and goalie cards (Alex, 2026-11-08: bubble look, same scale).
    const sx = (y) => 20 + ((Math.max(-42.5, Math.min(42.5, y)) + 42.5) / 85) * 360;
    const sy = (x) => 16 + ((100 - Math.max(-3, Math.min(100, x))) / 103) * 398;
    let h = '<svg viewBox="0 0 400 430" width="100%" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Shot map">';
    h += '<path d="M20 414 L20 118 Q20 16 108 16 L292 16 Q380 16 380 118 L380 414 Z" fill="#0d1830" stroke="rgba(165,195,255,.4)" stroke-width="2"/>';
    h += '<line x1="24" y1="58" x2="376" y2="58" stroke="rgba(240,102,94,.45)" stroke-width="3"/>';
    h += '<path d="M174.5 58 A25.5 23 0 0 0 225.5 58 Z" fill="rgba(94,168,255,.20)" stroke="rgba(165,195,255,.45)"/>';
    h += '<rect x="187" y="42" width="26" height="17" rx="2" fill="none" stroke="rgba(232,238,247,.75)" stroke-width="1.6"/>';
    for (const cx of [107, 293]) {
      h += `<ellipse cx="${cx}" cy="136" rx="64" ry="58" fill="none" stroke="rgba(165,195,255,.35)" stroke-width="2"/><circle cx="${cx}" cy="136" r="4" fill="rgba(165,195,255,.5)"/>`;
    }
    h += '<polygon points="107,194 180,58 220,58 293,194" fill="none" stroke="rgba(245,185,66,.55)" stroke-width="1.6" stroke-dasharray="6 5"/>';
    pts.forEach((p, i) => {
      const r = 7.5 + ((i * 37) % 10) / 10 * 3.6;
      const cx = sx(p.y).toFixed(0), cy = sy(p.x).toFixed(0);
      h += p.goal
        ? `<circle cx="${cx}" cy="${cy}" r="${r.toFixed(1)}" fill="#f5b942" stroke="#ffd97a" stroke-width="1.4"/>`
        : `<circle cx="${cx}" cy="${cy}" r="${r.toFixed(1)}" fill="rgba(58,219,227,.13)" stroke="rgba(58,219,227,.75)" stroke-width="1.5"/>`;
    });
    if (!pts.length && opts && opts.emptyText) {
      h += `<text x="200" y="228" text-anchor="middle" fill="#8b98ab" font-size="15">${esc(opts.emptyText)}</text>`;
    }
    return h + '</svg>';
  }
  const mini = size === 'mini';
  const H = mini ? 250 : 300;
  const sx = (y) => 170 + (y / 42.5) * 150;
  const sy = (x) => Math.max(26, Math.min(H - 8, 52 + (89 - x) * ((H - 60) / 64)));
  let h = `<svg viewBox="0 0 340 ${H}" width="100%" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Shot map, last games">`;
  h += `<rect x="10" y="8" width="320" height="${H - 16}" rx="46" fill="rgba(130,170,255,.05)" stroke="rgba(165,195,255,.4)" stroke-width="1.6"/>`;
  h += '<line x1="14" y1="52" x2="326" y2="52" stroke="rgba(240,102,94,.45)" stroke-width="2"/>';
  h += '<path d="M146 52 a24 15 0 0 0 48 0 z" fill="rgba(94,168,255,.20)" stroke="rgba(165,195,255,.45)"/>';
  h += '<rect x="158" y="34" width="24" height="13" rx="2" fill="none" stroke="rgba(232,238,247,.75)" stroke-width="1.6"/>';
  for (const cx of [95, 245]) {
    h += `<circle cx="${cx}" cy="120" r="44" fill="none" stroke="rgba(165,195,255,.35)" stroke-width="1.4"/><circle cx="${cx}" cy="120" r="4" fill="rgba(165,195,255,.5)"/>`;
  }
  h += '<polygon points="95,164 148,60 192,60 245,164" fill="none" stroke="rgba(245,185,66,.55)" stroke-width="1.3" stroke-dasharray="5 4"/>';
  pts.forEach((p, i) => {
    const r = (mini ? 5.4 : 6.5) + ((i * 37) % 10) / 10 * 4;
    const cx = sx(p.y).toFixed(0), cy = sy(p.x).toFixed(0);
    h += p.goal
      ? `<circle cx="${cx}" cy="${cy}" r="${r.toFixed(1)}" fill="#f5b942" stroke="#ffd97a" stroke-width="1.2"/>`
      : `<circle cx="${cx}" cy="${cy}" r="${r.toFixed(1)}" fill="rgba(58,219,227,.13)" stroke="rgba(58,219,227,.75)" stroke-width="1.3"/>`;
  });
  return h + '</svg>';
}
function pcLast10Html(r) {
  const d = l10For(r);
  if (!d) return '';
  const proj = l10Proj(r, d.n);
  if (proj == null) return '';
  const diff = d.sog - proj;
  const over = diff >= 0;
  return `<div class="l10-block">
    <div class="l10-head"><span class="l10-title">Last ${d.n} vs proj</span><span class="l10-sub">shots on goal</span></div>
    ${bubbleMapSvg(d.att, { size: 'full' })}
    <div class="l10-vsrow">
      <div class="l10-big ${over ? 'over' : 'under'}">${Math.abs(diff).toFixed(1)}<span class="l10-word">${over ? 'OVER PROJ' : 'UNDER PROJ'}</span></div>
      <div class="l10-lines"><div><strong>${d.sog} SOG</strong> in last ${d.n} GP</div><div class="muted">Proj <strong class="teal-num">${proj.toFixed(1)}</strong></div></div>
    </div>
    <div class="l10-legend"><span><span class="l10-sw shot"></span>attempt</span><span><span class="l10-sw goal"></span>goal</span><span><span class="l10-sw plate"></span>home plate</span><span class="muted">map: last ${d.n} games</span></div>
  </div>`;
}
function pcLast10SlotHtml(r) {
  if (l10SidecarState === 'ok') return pcLast10Html(r);
  if (l10SidecarState === 'fail') return '';
  return `<div data-l10-slot="${esc(String(r.pid))}"><p class="muted small" style="margin:.5rem 0 0">Loading last 10…</p></div>`;
}
async function ensureLast10(r) {
  await loadL10Sidecar();
  const body = $('modalBody');
  if (!body) return;
  const slot = body.querySelector(`[data-l10-slot="${esc(String(r.pid))}"]`);
  if (!slot) return;
  const html = l10SidecarState === 'ok' ? pcLast10Html(r) : '';
  if (!html) { slot.remove(); return; }
  slot.outerHTML = html;
}
/* Game sheet strip: this game's own top shooters by last-10 SOG volume
   (needs at least 5 counted games), each card opening the player card. */
function sheetLast10StripHtml(g) {
  if (l10SidecarState !== 'ok' || !l10Sidecar) return '';
  const rows = state.skaters
    .filter((sk) => String(sk.gameId) === String(g.id))
    .map((sk) => {
      const d = l10For(sk);
      if (!d || d.n < 5) return null;
      const proj = l10Proj(sk, d.n);
      if (proj == null) return null;
      return { sk, d, proj, diff: d.sog - proj };
    })
    .filter(Boolean)
    .sort((a, b) => b.d.sog - a.d.sog)
    .slice(0, 3);
  if (rows.length < 2) return '';
  const cards = rows.map(({ sk, d, proj, diff }) => {
    const over = diff >= 0;
    const step = Math.max(1, Math.floor(d.att.length / 26));
    const att = d.att.filter((_, i) => i % step === 0);
    return `<button class="l10-card" data-l10-open="${esc(String(sk.pid))}" data-l10-gid="${esc(String(sk.gameId))}">
      <span class="l10-card-name"><img src="${teamLogoUrl(sk.team)}" alt="" ${imgFallback}> ${esc(sk.name.toUpperCase())}</span>
      ${bubbleMapSvg(att, true)}
      <span class="l10-card-big ${over ? 'over' : 'under'}">${Math.abs(diff).toFixed(1)}</span>
      <span class="l10-card-word">${over ? 'OVER PROJ' : 'UNDER PROJ'}</span>
      <span class="l10-card-line">${d.sog} SOG in ${d.n} GP</span>
      <span class="l10-card-line muted">Proj <strong>${proj.toFixed(1)}</strong></span>
    </button>`;
  }).join('');
  return `<div class="l10-strip-wrap"><div class="l10-strip-head"><span class="l10-bar">▎</span> Last 10 vs proj <span class="muted small">shots on goal · this game's shooters</span></div><div class="l10-strip">${cards}</div></div>`;
}
function sheetBindLast10() {
  document.querySelectorAll('#matchupBody [data-l10-open]').forEach((b) =>
    b.addEventListener('click', () => openPlayer(b.dataset.l10Open, b.dataset.l10Gid)));
}
/* NBA-style folded card section (Alex, 2026-11-07 restructure): a
   full-width row — teal accent bar, caps title, chevron — that toggles
   open. Mirrors the Basketball card's sec() helper. Returns '' when the
   body is empty so sections with no data vanish instead of folding air. */
function pcAccSec(key, titleHtml, bodyHtml, open) {
  if (!bodyHtml) return '';
  return `<details class="pcacc" data-sec="${key}"${open ? ' open' : ''}><summary>${titleHtml}<span class="chev">▸</span></summary><div class="pcacc-body">${bodyHtml}</div></details>`;
}
function openPlayer(pid, gameId) {
  const r = state.skaters.find((s) => String(s.pid) === String(pid) && String(s.gameId) === String(gameId));
  if (!r) return;
  const g = state.games.find((gg) => gg.id === r.gameId);
  const l5 = (r.last5 || []).slice(0, 5);
  const l5g = l5.reduce((a, x) => a + (x.goals || 0), 0);
  const l5s = l5.reduce((a, x) => a + (x.shots || 0), 0);
  const factorRows = r.factors.map((f) => {
    let multHtml = '';
    if (f.mult != null) {
      const m = f.mult;
      const cls = m >= 1.10 ? 'f-boost' : m <= 0.95 ? 'f-drag' : '';
      multHtml = ` <span class="muted ${cls}">×${m.toFixed(2)}</span>`;
    }
    return `\n    <tr><td>${esc(f.label)}</td><td>${esc(f.value)}${multHtml}</td></tr>`;
  }).join('');
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
    if (!r.markets[kind] || !r.markets[kind].length) return '';
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
  // line badge + dressed status
  const lineBadge = r.line
    ? (r.lineEst === false
      ? `<span class="line-badge" title="Line combinations via Daily Faceoff">${r.line}</span>`
      : `<span class="line-badge" title="Estimated from average ice time — not official">${r.line}<span class="est">est.</span></span>`)
    : '';
  const statusPill = r.lineup === 'confirmed'
    ? '<span class="status-pill ok">In lineup</span>'
    : '<span class="status-pill proj">Projected</span>';
  const tc = TEAM_COLORS[r.team] || '#888';
  const formBars = pcFormBarsHtml(r, l5g, l5s);
  const formHtml = formBars || `<p class="small muted">Season: ${r.goals}G ${r.assists}A ${r.points}P / ${r.gp}GP · Last 5: ${l5g}G, ${l5s} SOG</p>`;
  // Small-sample zone note used to live on the removed trailing season
  // sentence; keep it with the form block so the info isn't lost.
  const zoneNote = r.zone.lowSample ? `<p class="small muted"><em>zone share uses league-average (small sample)</em></p>` : '';
  // Jersey number chip: from bio (sweaterNumber) when already loaded; when
  // the bio arrives later, ensurePlayerBio fills the placeholder in.
  const jnumChip = r.bio && r.bio.number != null
    ? `<span class="pc-jnum">#${esc(String(r.bio.number))}</span>`
    : `<span class="pc-jnum" data-jnum-loading="${esc(String(r.pid))}" hidden></span>`;
  // ---- NBA-style card composition (2026-11-07 restructure) ----
  // Header mirrors the Basketball card: circular headshot, name stack,
  // team line (logo + full name), matchup line, hero stat box at right.
  // The body is a stack of folded pcAccSec rows — only Tonight's lines
  // open by default. Every block from the old flat card survives inside
  // a fold; the lazy sidecars (minutes/chem/finish) now load on first
  // open of their folded section instead of at card open.
  const teamFull = CI_TEAM_FULL[r.team] || r.team;
  const oppAbbr = g ? (r.team === g.home ? g.away : g.home) : r.oppAbbr;
  const oppFull = CI_TEAM_FULL[oppAbbr] || oppAbbr || '';
  const matchLine = g ? `${r.team === g.home ? 'vs' : '@'} ${oppFull} · tonight` : '';
  // Goal lines for Tonight's lines: anytime (the hero price) plus brace
  // and first goal from the same λ math the Markets views use.
  const lamPos = Math.max(r.lam, 0);
  const gameLam = state.skaters
    .filter((s) => String(s.gameId) === String(r.gameId))
    .reduce((a, s) => a + Math.max(s.lam, 0), 0);
  const tpP = 1 - Math.exp(-lamPos) * (1 + lamPos);
  const fgP = gameLam > 0 ? lamPos / gameLam : 0;
  const lineRow = (label, p, fair) => `<div class="pc-line-row"><span class="pc-line-lab">${label}</span><span class="pc-line-pct">${pct1(p)}</span><span class="pc-line-fair">${fair} fair</span></div>`;
  const linesBody = `<div class="pc-lines">${lineRow('Anytime goal', r.p, r.fair)}${lineRow('Brace · 2+ goals', tpP, fairOddsSafe(tpP))}${lineRow('First goal', fgP, fairOddsSafe(fgP))}</div>`
    + `<div class="sec-title" style="margin-top:.7rem">Poisson over/under</div>${marketsHtml}`;
  // Milestones ladder (NBA chip pattern; display-only). Rungs come from
  // the SAME lambdas as Tonight's lines: goals from r.lam (1+ is the
  // anytime price itself, 2+ the brace math above), shots / assists /
  // points from the computeMarkets lambdas through the same pOverLine
  // Poisson survival. Rungs that would print as 0% are dropped; a group
  // with no rungs hides, and pcAccSec hides the section if all are gone.
  const msChip = (t, unit, p) => `<span class="ms-chip"><b>${t}+</b> ${unit} · <span class="p">${Math.round(p * 100)}%</span></span>`;
  const msGroup = (label, chips) => chips.length ? `<div class="ms-ladder-label">${label}</div><div class="ms-ladder">${chips.join('')}</div>` : '';
  const msFromLam = (lam, unit, thresholds) => {
    if (!(lam > 0)) return [];
    return thresholds
      .map((t) => ({ t, p: pOverLine(lam, t - 1) }))
      .filter((x) => x.p >= 0.005)
      .map((x) => msChip(x.t, unit, x.p));
  };
  const msLam = (kind) => (r.markets && r.markets[kind] && r.markets[kind][0]) ? r.markets[kind][0].lam : null;
  const goalChips = [
    ...(r.p >= 0.005 ? [msChip(1, 'G', r.p)] : []),
    ...(tpP >= 0.005 ? [msChip(2, 'G', tpP)] : []),
    ...msFromLam(lamPos, 'G', [3]),
  ];
  const milesBody = [
    msGroup('Goals', goalChips),
    msGroup(MARKET_META.shots.label, msFromLam(msLam('shots'), 'SOG', [2, 3, 4, 5, 6])),
    msGroup(MARKET_META.assists.label, msFromLam(msLam('assists'), 'A', [1, 2, 3])),
    msGroup(MARKET_META.points.label, msFromLam(msLam('points'), 'PTS', [2, 3, 4])),
  ].join('');
  const minN = minSidecarState === 'ok' ? minGamesFor(r).length : 0;
  const chemEnt = (chemSidecarState === 'ok' && chemSidecar && chemSidecar.players) ? chemSidecar.players[String(r.pid)] : null;
  const vsBody = `${vsGoalieEdgeHtml(r, g)}${vsGoalieHtml(r, g)}`;
  const pgForTitle = g ? panelGoalie(g, r.oppAbbr) : null;
  const vsTitle = pgForTitle && pgForTitle.name ? `Vs ${pgForTitle.name.split(' ').slice(-1)[0]}` : 'Vs goalie';
  const seasonBody = `<div class="stat-inline"><span><strong>${r.goals}</strong> goals</span><span><strong>${r.assists}</strong> assists</span><span><strong>${r.points}</strong> points</span><span><strong>${r.gp}</strong> GP</span></div>${statBarsHtml(r)}`;
  const shotMapBody = `<div style="margin:.1rem 0 .4rem"><button class="pill on" id="rinkShots">Shots</button> <button class="pill" id="rinkGoals">Goals</button></div>
      <div id="rinkSvg" class="rink-svg"></div>
      <div class="legend"><span><span class="l10-sw shot"></span>attempt</span>
        <span><span class="l10-sw goal"></span>goal</span>
      <span><span class="l10-sw plate"></span>home plate</span></div>${pcLast10SlotHtml(r)}`;
  const whyBody = `<table class="factor-table">${factorRows}
        <tr><td>Expected goals (λ)</td><td>${r.lam.toFixed(3)}</td></tr>
        <tr><td>Opponent</td><td>${esc(r.oppAbbr)} goalie ${(r.oppSv * 100).toFixed(1)}% SV</td></tr>
      </table>`;
  const parlayBody = `<div class="parlay-add">
      <select id="parlayLegSelect" aria-label="Choose a parlay leg">${legOpts.join('')}</select>
      <button class="btn" id="parlayAddBtn">Add to parlay</button>
    </div>`;
  $('modalBody').innerHTML = `
    <div class="pc-head hero-card-head" style="--pc-tc:${tc}">
      <img class="headshot" src="${esc(r.headshot)}" alt="" ${imgFallback} style="border-color:${tc};box-shadow:0 0 22px ${tc}">
      <div class="pc-head-main">
        <h3 class="pc-name">${jnumChip}${esc(r.name)}${typeBadgeHtml(r.pid)}</h3>
        <div class="pc-teamline"><img class="tlogo" src="${teamLogoUrl(r.team)}" alt="" ${imgFallback}><span>${esc(teamFull)} · ${esc(r.pos)}</span></div>
        ${matchLine ? `<div class="pc-matchline">${esc(matchLine)}</div>` : ''}
      </div>
      <div class="pc-hero">
        <div class="hero-card-num" style="color:${lightenHex(tc, 0.55)};text-shadow:0 0 16px ${tc}">${Math.round(r.p * 100)}<small>%</small></div>
        <div class="hero-card-label">Anytime Goal</div>
      </div>
    </div>
    <div class="pc-status">${lineBadge}${statusPill}</div>
    ${pcTypeStripHtml(r)}
    ${pcTonightHtml(r, g)}
    ${pcAccSec('lines', "Tonight's lines", linesBody, true)}
    ${pcAccSec('miles', 'Milestones', milesBody, false)}
    ${pcAccSec('ice', `Ice time${minN ? ` · last ${minN}` : ''}`, pcMinSlotHtml(r), false)}
    ${pcAccSec('chem', `Chemistry${chemEnt && chemEnt.sharedGames ? ` · last ${chemEnt.sharedGames}` : ''}`, pcChemSlotHtml(r), false)}
    ${pcAccSec('fin', 'Finishing', pcFinSlotHtml(r), false)}
    ${pcAccSec('edge', 'EDGE · NHL tracking', pcEdgeSlotHtml(r), false)}
    ${pcAccSec('form', 'Form', `${formHtml}${pcLastGameHtml(l5)}${zoneNote}`, false)}
    ${pcAccSec('vs', vsTitle, vsBody, false)}
    ${pcAccSec('shotmap', '<span id="rinkTitle">Shot map</span> <span class="pcacc-hint">recent games, attacking ↑</span>', shotMapBody, false)}
    ${pcAccSec('muheat', 'Match-up heat map <span class="pcacc-hint">recent games</span>', heatMapSectionHtml(r, matchupHeatShots(r)), false)}
    ${pcAccSec('seasheat', 'Season heat map <span class="pcacc-hint">where his shots come from this season</span>', seasonHeatMapHtml(r), false)}
    ${pcAccSec('why', 'Why this price', whyBody, false)}
    ${pcAccSec('season', 'Season averages', seasonBody, false)}
    ${pcAccSec('mates', 'Linemates', linematesHtml(r), false)}
    ${pcAccSec('details', 'Details', pcDetailsHtml(r), false)}
    ${pcAccSec('parlay', 'Add to parlay', parlayBody, false)}`;
  $('playerModal').classList.remove('hidden');
  wireMinutes(r);
  // Lazy sidecars (minutes/chem/finish): their sections start folded, so
  // the fetch fires on the section's first open rather than at card open.
  // If a card is re-opened with the sidecar already cached, the slot html
  // rendered inline above and there is nothing left to load.
  const lazySec = (key, fn) => {
    const d = $('modalBody').querySelector(`details.pcacc[data-sec="${key}"]`);
    if (!d) return;
    if (d.open) { fn(); return; }
    d.addEventListener('toggle', () => { if (d.open) fn(); }, { once: true });
  };
  lazySec('ice', () => ensureMinutes(r));
  lazySec('chem', () => ensureChem(r));
  lazySec('fin', () => ensureFinish(r));
  lazySec('edge', () => ensureEdge(r));
  lazySec('shotmap', () => ensureLast10(r));
  ensurePlayerBio(r);
  // map follows the Markets dropdown on open; pills let you switch without closing
  const mk = state.marketKind;
  let rinkMode = ['atg', 'twoplus', 'firstgoal'].includes(mk) ? 'goals' : 'shots';
  const drawRinkMode = () => {
    const mapShots = r.matchupShots || r.shots;
    const data = rinkMode === 'goals' ? mapShots.filter((s) => s.goal) : mapShots;
    $('rinkTitle').textContent = rinkMode === 'goals' ? 'Goal map' : 'Shot map';
    $('rinkShots').classList.toggle('on', rinkMode === 'shots');
    $('rinkGoals').classList.toggle('on', rinkMode === 'goals');
    const rinkEl = $('rinkSvg');
    if (rinkEl) rinkEl.innerHTML = bubbleMapSvg(data, { size: 'full', emptyText: rinkMode === 'goals' ? 'No goals in recent games' : 'No located shots in recent games' });
  };
  $('rinkShots').addEventListener('click', () => { rinkMode = 'shots'; drawRinkMode(); });
  $('rinkGoals').addEventListener('click', () => { rinkMode = 'goals'; drawRinkMode(); });
  drawRinkMode();
  $('parlayAddBtn').addEventListener('click', () => addParlayLeg(r, $('parlayLegSelect').value));
}
function closePlayer() { $('playerModal').classList.add('hidden'); }
/* ---------------- heat maps (player card) ----------------
   Two maps, one renderer (heatMapSectionHtml):
   - Match-up heat map: tonight's live pbp + the team's recent finals,
     rebuilt fresh at card-open (matchupHeatShots), so it updates live.
   - Season heat map: season-to-date shots from the bundle (builder
     section 6b) + tonight's live pbp merged at card-open (heatMapShots).
   Both use the DISPLAY shot path (displayShotsFromPbp: goals via
   scoringPlayerId, per-period rotation into attacking frame). The
   model's zone factor still uses the old shotsFromPbp window — that
   input is frozen pending a backtest, per keep-what-wins. */
function heatMapShots(r) {
  // Season shots from the bundle (regular-season finals before slate date)
  // plus tonight's live pbp shots merged at card-open, so the map updates
  // as goals happen. No overlap: season shots exclude tonight's game.
  // [] when the bundle predates zoneShots (season block explains).
  if (!r.seasonShots || !r.seasonShots.length) return [];
  const g = (state.games || []).find((gg) => gg.id === r.gameId);
  const live = g && g.pbp ? displayShotsFromPbp(g.pbp, r.pid) : [];
  return r.seasonShots.concat(live);
}
function matchupHeatShots(r) {
  // Fresh at card-open: tonight's live pbp + the team's recent finals,
  // display-corrected. Falls back to the load-time window when live
  // data is missing (e.g. pregame with no pbp yet still gets recents).
  const g = (state.games || []).find((gg) => gg.id === r.gameId);
  const live = g && g.pbp ? displayShotsFromPbp(g.pbp, r.pid) : [];
  let recent = [];
  for (const id of ((state.recentIds || {})[r.team] || [])) {
    const zp = (state.zonePbps || {})[id];
    if (zp) recent.push(...displayShotsFromPbp(zp, r.pid));
  }
  const merged = live.concat(recent);
  return merged.length ? merged : (r.matchupShots || r.shots || []);
}
function seasonHeatMapHtml(r) {
  if (!r.seasonShots || !r.seasonShots.length) {
    return `<p class="muted small" style="margin:.5rem 0 0">Season map arrives with the next slate build.</p>`;
  }
  return heatMapSectionHtml(r, heatMapShots(r), null, { showGoals: false, minShots: 1 });
}
const HOME_PLATE = [[89, -9], [69, -22], [54, -22], [54, 22], [69, 22], [89, 9]];
function inHomePlate(x, y) {
  let inside = false;
  for (let i = 0, j = HOME_PLATE.length - 1; i < HOME_PLATE.length; j = i++) {
    const [xi, yi] = HOME_PLATE[i], [xj, yj] = HOME_PLATE[j];
    if (((yi > y) !== (yj > y)) && (x < ((xj - xi) * (y - yi)) / (yj - yi) + xi)) inside = !inside;
  }
  return inside;
}
function zoneOf(x, y) {
  if (x >= 74 && Math.abs(y) <= 10) return 'lowSlot';
  if (inHomePlate(x, y) || (Math.abs(y) <= 11 && x >= 47 && x < 54)) return 'slot';
  if (x < 25) return 'outside';
  if (x < 47) return 'point';
  return y < 0 ? 'left' : 'right';
}
function zoneStats(shots) {
  const z = { lowSlot: { att: 0, goals: 0 }, slot: { att: 0, goals: 0 }, left: { att: 0, goals: 0 }, right: { att: 0, goals: 0 }, point: { att: 0, goals: 0 }, outside: { att: 0, goals: 0 } };
  for (const s of shots) { const k = zoneOf(s.x, s.y); z[k].att++; if (s.goal) z[k].goals++; }
  return z;
}
function heatMapSectionHtml(r, shots, emptyText, opts) {
  // Body-only markup since the 2026-11-07 accordion restructure: the
  // folded-section summary carries the title/subtitle now, this returns
  // just the map (or the empty-state line) for the section body.
  // Season map renders percentages-only (no per-zone goal counts) with a
  // 1-shot floor so depth guys show too; Match-up keeps goals + the 5-shot
  // floor by default. Season goal totals already live in the card's
  // stat-inline line, so nothing is lost by dropping G chips here.
  const showGoals = !opts || opts.showGoals !== false;
  const minShots = (opts && opts.minShots) || 5;
  if (!shots || shots.length < minShots) {
    return `<p class="muted small" style="margin:.5rem 0 0">${emptyText || 'Not enough shot data yet — the map fills in as games are played.'}</p>`;
  }
  const zs = zoneStats(shots);
  const total = shots.length;
  const pct = (k) => Math.round((zs[k].att / total) * 100);
  const hot = ['lowSlot', 'slot', 'left', 'right', 'point'].reduce((a, b) => (zs[a].att >= zs[b].att ? a : b));
  const slotShare = (zs.lowSlot.att + zs.slot.att) / total;
  const take = slotShare >= 0.5
    ? `Lives in the slot — ${Math.round(slotShare * 100)}% of his shots come from the home-plate area${(showGoals && zs.lowSlot.goals) ? ', and the low slot is where the goals are' : ''}.`
    : (zs.point.att / total >= 0.3
      ? 'Does his damage from distance — point shots and perimeter looks.'
      : 'Scores from all over the zone — no single home base.');
  const zchip = (k, name) => `<span class="zchip2${k === hot ? ' hot' : ''}">${name} <b>${pct(k)}%</b> · ${zs[k].att} att${showGoals ? ` · ${zs[k].goals} G` : ''}</span>`;
  return `<div class="rink-svg">${bubbleMapSvg(shots, { size: 'full' })}</div>
    <div class="zchips-row">${zchip('lowSlot', 'LOW SLOT')}${zchip('slot', 'SLOT')}${zchip('left', 'LEFT SIDE')}${zchip('right', 'RIGHT SIDE')}${zchip('point', 'POINT')}</div>
    <div class="outside-strip">OUTSIDE THE ZONE: ${zs.outside.att} ATT · ${pct('outside')}%${showGoals ? ` · ${zs.outside.goals} G` : ''}</div>
    <p class="small muted" style="margin:.55rem 0 0">${take} <span class="muted">(${total} attempts tracked)</span></p>`;
}
/* ---------------- goalie workload (goalies sidecar) ----------------
   data/goalies-<date>.json from data-builder/goalies-work.js: each
   goalie's last 5 starts (shots faced, goals against, decision, save %).
   DISPLAY ONLY. Loaded lazily on the first goalie-card open via a cached
   promise (same slot pattern as minutes/chem/finish); a missing sidecar
   or goalie hides the section silently. */
let gworkSidecar = null, gworkPromise = null;
function loadGworkSidecar() {
  if (!gworkPromise) {
    gworkPromise = dataFetch(`data/goalies-${state.date}.json`, { headers: { 'Accept': 'application/json' } })
      .then((r) => { if (!r.ok) throw new Error('no sidecar'); return r.json(); })
      .then((j) => { gworkSidecar = j; return j; })
      .catch(() => { gworkSidecar = null; return null; });
  }
  return gworkPromise;
}
function pcGworkSlotHtml(pg) {
  if (gworkSidecar) return pcGworkHtml(pg);
  return `<div class="pc-min" data-gwork-slot="${esc(String(pg.id))}"><div class="pc-min-h"><span class="pc-min-t">Workload</span></div><p class="muted small" style="margin:.35rem 0 0">Loading workload…</p></div>`;
}
function gworkFmtSv(sv) {
  const s = (sv || 0).toFixed(3);
  return s.startsWith('0') ? s.slice(1) : s;
}
function pcGworkHtml(pg) {
  const entry = (gworkSidecar && gworkSidecar.goalies && gworkSidecar.goalies[String(pg.id)]) || null;
  const starts = (entry && entry.starts) || [];
  if (!starts.length) return '';
  const dayNum = (dstr) => Math.round(new Date(dstr + 'T12:00:00Z').getTime() / 86400000);
  const last = starts[starts.length - 1];
  const rest = dayNum(state.date) - dayNum(last.d);
  const chips = [];
  if (rest === 1) chips.push('<span class="gwork-chip amber">PLAYED LAST NIGHT · B2B IF HE GOES</span>');
  else if (rest >= 4) chips.push(`<span class="gwork-chip teal">${rest} DAYS REST</span>`);
  const inWin = starts.filter((s) => dayNum(s.d) >= dayNum(last.d) - 13);
  if (inWin.length >= 4) {
    const span = dayNum(last.d) - dayNum(inWin[0].d) + 1;
    chips.push(`<span class="gwork-chip gold">${inWin.length} STARTS IN ${span} DAYS</span>`);
  }
  const cols = starts.map((s) => {
    const barH = Math.max(6, (s.sa / 42) * 92); // 92px zone, SA scaled to 42
    const tipH = s.sa > 0 ? Math.max(2, (s.ga / s.sa) * barH) : 0;
    const lit = s.ga >= 4 || s.sv < 0.850;
    return `<div class="gwork-col">
      <span class="min-val">${s.sa}</span>
      <span class="gwork-barzone"><span class="gwork-bar${lit ? ' lit' : ''}" style="height:${barH.toFixed(1)}px"><span class="gwork-tip" style="height:${tipH.toFixed(1)}px"></span></span></span>
    </div>`;
  }).join('');
  const labs = starts.map((s) => `<span class="min-lab">${esc(s.hr === 'R' ? '@' + s.opp : s.opp)}</span>`).join('');
  const subs = starts.map((s) => {
    const lit = s.ga >= 4 || s.sv < 0.850;
    const dec = s.dec === 'O' ? 'OTL' : (s.dec || '–');
    return `<span class="min-lab gwork-dec${lit ? ' bad' : ''}">${esc(dec)} · ${gworkFmtSv(s.sv)}</span>`;
  }).join('');
  return `<div class="pc-min" data-gwork-root>
    <div class="pc-min-h"><span class="pc-min-t">Workload</span><span class="gwork-last">last ${starts.length} starts</span></div>
    ${chips.length ? `<div class="gwork-chips">${chips.slice(0, 3).join('')}</div>` : ''}
    <div class="gwork-cols">${cols}</div>
    <div class="min-labs">${labs}</div>
    <div class="min-labs">${subs}</div>
    <p class="gwork-foot">Bar = shots faced · gold tip = goals against</p>
  </div>`;
}
async function ensureGoalieWork(pg) {
  await loadGworkSidecar();
  const body = $('modalBody');
  if (!body) return;
  const slot = body.querySelector(`[data-gwork-slot="${esc(String(pg.id))}"]`);
  if (!slot) return;
  const html = gworkSidecar ? pcGworkHtml(pg) : '';
  if (html) slot.outerHTML = html; else slot.remove();
}
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
    ? `<div class="grink-bubble" id="${canvasId}"></div>`
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
    ${pcGworkSlotHtml(pg)}
    <h4 style="margin:.8rem 0 .2rem">Projections <span class="muted small">model</span></h4>
    ${goalieProjTableHtml(g, teamAbbrev, st)}
    <h4 style="margin:.8rem 0 .2rem">Weak zones <span class="muted small">save% by zone</span></h4>
    ${goalieZoneGridHtml(pg.id)}
    ${pcGedgeSlotHtml(pg)}
    <h4 style="margin:.8rem 0 .2rem">Goals allowed <span class="muted small">locations</span></h4>
    ${map}`;
  $('playerModal').classList.remove('hidden');
  drawGoalieRinks();
  ensureGoalieWork(pg);
  ensureGoalieEdge(pg);
}
/* ---------------- views & refresh ---------------- */
/* Home + Top Shelf code lives in home.js */
function renderAll() {
  restoreMarketKind();
  syncLiveBadge();
  renderSlate();
  renderGoals();
  renderLiveGoals();
  renderBoard();
  renderLongshots();
  renderStandouts();
  setMarketKind(state.marketKind);
  renderParlay();
  renderHome();
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
  g.state = snap.state; // keep top-level state in sync for gameStatusText
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
  syncLiveBadge();
  if (state.view === 'slate') renderSlate();
  if (state.view === 'goals') renderGoals();
  if (state.view === 'goals') renderLiveGoals();
  if (state.view === 'board') renderBoard();
  if (state.view === 'home') renderHomeTonight(); // keep Tonight scores/clock fresh on Center Ice
  if (state.section === 'lab') shelfSyncNav(); // keep Live dot + bar label fresh on ticks
  refreshOpenSheet();
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
    const r = await dataFetch(`live/${utcDate}.json`, { headers: { 'Accept': 'application/json' } });
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
// but the bundle still says FUT or PRE (stale bundle — e.g. data built
// before puck drop; the bundle's pregame state is PRE, not FUT).
function isWatchable(g) {
  if (g.state === 'LIVE' || g.state === 'CRIT') return true;
  if ((g.state === 'FUT' || g.state === 'PRE') && g.startUTC) {
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
/* ---------------- Collapsible Top Shelf nav ----------------
   Slim bar showing the current section + chevron; expands to the 2×3
   pill stack. First arrival at Top Shelf per SESSION starts EXPANDED
   (user's call); picking a section collapses it, and after that the bar
   just toggles. First-visit state is a plain variable — NOT localStorage,
   so a fresh session sees it expanded again. No burger icon: the sports
   switcher already owns ☰. View switching itself is untouched. */
let shelfNavFirstVisit = true; // session only
const SHELF_LABELS = { markets: 'Markets', leaders: 'Leaders', longshots: 'Longshots', parlay: 'Parlay', slate: 'Slate', goals: 'Live', board: 'Board', standouts: 'Standouts', types: 'Types' };
function shelfSetExpanded(expanded) {
  const stack = $('shelfStack'), bar = $('shelfBar');
  if (!stack || !bar) return;
  stack.classList.toggle('show', expanded);
  bar.classList.toggle('open', expanded);
  bar.setAttribute('aria-expanded', expanded ? 'true' : 'false');
}
function shelfSyncNav() {
  const cur = $('shelfCurrent'), dot = $('liveTabDot');
  if (!cur) return;
  const anyLive = (state.games || []).some(isWatchable);
  const label = SHELF_LABELS[state.view] || 'Markets';
  cur.innerHTML = (state.view === 'goals' && anyLive ? '<span class="live-dot on"></span>' : '') + esc(label);
  if (dot) dot.classList.toggle('on', anyLive);
}
const HOME_VIEWS = ['home', 'standings', 'teamlineup', 'playoffodds'];
const LAB_VIEWS = ['markets', 'leaders', 'longshots', 'parlay', 'slate', 'goals', 'board', 'standouts', 'types'];
function setView(v) {
  state.view = v;
  // Keep the section in sync with the view
  if (HOME_VIEWS.includes(v)) state.section = 'home';
  else if (LAB_VIEWS.includes(v)) state.section = 'lab';
  document.querySelectorAll('.bnav-btn').forEach((b) => b.classList.toggle('active', b.dataset.section === state.section));
  const labNav = $('labNav');
  if (labNav) labNav.hidden = state.section !== 'lab';
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.view === v));
  if (state.section === 'lab') {
    if (shelfNavFirstVisit) shelfSetExpanded(true); // first arrival per session: expanded
    shelfSyncNav();
  }
  document.querySelectorAll('.view').forEach((s) => s.classList.toggle('active', s.id === 'view-' + v));
  const arn = $('autoRefreshNote');
  if (arn) arn.style.visibility = v === 'slate' ? 'visible' : 'hidden';
  if (v === 'home') renderHome();
  if (v === 'standings') renderStandings();
  if (v === 'teamlineup') renderTeamLineup();
  if (v === 'playoffodds') renderPlayoffOdds();
  if (v === 'types') renderTypes();
  if (v === 'standouts') renderStandouts();
  window.scrollTo(0, 0);
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
  t.addEventListener('click', () => {
    setView(t.dataset.view);
    // Picking a section collapses the stack and ends the first-visit state.
    shelfNavFirstVisit = false;
    shelfSetExpanded(false);
  }));
// Collapsible shelf bar: toggles the 2×3 stack (after first-visit expansion).
const shelfBar = $('shelfBar');
if (shelfBar) shelfBar.addEventListener('click', () => {
  const stack = $('shelfStack');
  shelfSetExpanded(!(stack && stack.classList.contains('show')));
});
// Bottom nav: Home / Center Ice / Top Shelf section switching
document.querySelectorAll('.bnav-btn[data-section]').forEach((b) =>
  b.addEventListener('click', () => setSection(b.dataset.section)));
// Back buttons
const standingsBack = $('standingsBack');
if (standingsBack) standingsBack.addEventListener('click', () => setView('home'));
const teamLineupBack = $('teamLineupBack');
if (teamLineupBack) teamLineupBack.addEventListener('click', () => setView('standings'));
const oddsBack = $('oddsBack');
if (oddsBack) oddsBack.addEventListener('click', () => setView('home'));
// Home: pick rows open the player card
document.addEventListener('click', (e) => {
  const pr = e.target.closest('.hero-pick[data-pid]');
  if (pr && pr.dataset.pid) openPlayer(pr.dataset.pid, pr.dataset.gid);
});
document.addEventListener('click', (e) => {
  const b = e.target.closest('.addbtn');
  if (!b) return;
  const r = state.skaters.find((sk) => String(sk.pid) === String(b.dataset.pid));
  if (r) toggleParlayLeg(r, b.dataset.add, b);
});
// Home + standings + odds: team rows open the team lineup view
document.addEventListener('click', (e) => {
  const tr = e.target.closest('.team-row[data-team]');
  if (tr && tr.dataset.team) openTeamLineup(tr.dataset.team);
});
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' && e.key !== ' ') return;
  const pr = e.target.closest && e.target.closest('.hero-pick[data-pid]');
  if (pr && pr.dataset.pid) { e.preventDefault(); openPlayer(pr.dataset.pid, pr.dataset.gid); return; }
  const tr = e.target.closest && e.target.closest('.team-row[data-team]');
  if (tr && tr.dataset.team) { e.preventDefault(); openTeamLineup(tr.dataset.team); }
});
// Center Ice is the default section on boot (site home lives on index.html)
state.section = 'home';
$('sortSelect').addEventListener('change', (e) => { state.sortBy = e.target.value; renderBoard(); });
if ($('boardMarket')) $('boardMarket').addEventListener('change', (e) => { state.boardMarket = e.target.value; renderBoard(); });
if ($('boardSearch')) $('boardSearch').addEventListener('input', (e) => { state.boardQuery = e.target.value.trim().toLowerCase(); renderBoard(); });
if ($('boardFiltersPill')) $('boardFiltersPill').addEventListener('click', () => {
  const panel = $('boardFiltersPanel');
  const open = panel.hidden;
  panel.hidden = !open;
  $('boardFiltersPill').setAttribute('aria-expanded', open ? 'true' : 'false');
  $('boardFiltersPill').classList.toggle('open', open);
});
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
/* ---------------- Center Ice search ----------------
   One bar at the top of Center Ice (view-home): live search across
   tonight's players, goalies, matchups, lineups, and the slate.
   Players first (most-tapped lookup), then Goalies, Matchups, Lineups,
   Slate. Slate fires on "slate"/"tonight" or as a fallback when nothing
   else matches. 5 rows per group. Enter opens the first result. */
const CI_TEAM_FULL = { ANA: 'Anaheim Ducks', BOS: 'Boston Bruins', BUF: 'Buffalo Sabres', CGY: 'Calgary Flames', CAR: 'Carolina Hurricanes', CHI: 'Chicago Blackhawks', COL: 'Colorado Avalanche', CBJ: 'Columbus Blue Jackets', DAL: 'Dallas Stars', DET: 'Detroit Red Wings', EDM: 'Edmonton Oilers', FLA: 'Florida Panthers', LAK: 'Los Angeles Kings', MIN: 'Minnesota Wild', MTL: 'Montreal Canadiens', NSH: 'Nashville Predators', NJD: 'New Jersey Devils', NYI: 'New York Islanders', NYR: 'New York Rangers', OTT: 'Ottawa Senators', PHI: 'Philadelphia Flyers', PIT: 'Pittsburgh Penguins', SJS: 'San Jose Sharks', SEA: 'Seattle Kraken', STL: 'St. Louis Blues', TBL: 'Tampa Bay Lightning', TOR: 'Toronto Maple Leafs', UTA: 'Utah Mammoth', VAN: 'Vancouver Canucks', VGK: 'Vegas Golden Knights', WSH: 'Washington Capitals', WPG: 'Winnipeg Jets' };
const CI_CAP = 5;
const ciNorm = (s) => String(s == null ? '' : s).toLowerCase();
const ciTeamHay = (abbr) => ciNorm(abbr + ' ' + (CI_TEAM_FULL[abbr] || ''));
function ciGoHome() {
  const inp = $('ciSearchInput'); if (inp) inp.value = '';
  const res = $('ciSearchResults'); if (res) { res.innerHTML = ''; res.classList.remove('open'); }
  const clr = $('ciSearchClear'); if (clr) clr.classList.remove('show');
}
function ciRow(labelHtml, subHtml, onClick) {
  const b = document.createElement('button'); b.type = 'button'; b.className = 'ci-row';
  b.innerHTML = '<span>' + labelHtml + '</span><span class="act">' + subHtml + '</span>';
  b.addEventListener('click', onClick); return b;
}
function ciGroup(title, rows) {
  if (!rows.length) return null;
  const d = document.createElement('div'); d.className = 'ci-group';
  const h = document.createElement('h4'); h.textContent = title; d.appendChild(h);
  rows.forEach((r) => d.appendChild(r)); return d;
}
function ciRenderSearch() {
  const inp = $('ciSearchInput'); const res = $('ciSearchResults'); const clr = $('ciSearchClear');
  if (!inp || !res) return;
  const q = ciNorm(inp.value).trim();
  if (clr) clr.classList.toggle('show', !!q);
  res.innerHTML = '';
  if (!q) { res.classList.remove('open'); return; }
  res.classList.add('open');
  const games = state.games || [];
  const skaters = state.skaters || [];
  const pRows = skaters.filter((s) => ciNorm(s.name).includes(q) || ciTeamHay(s.team).includes(q)).slice(0, CI_CAP).map((s) => {
    const b = document.createElement('button'); b.type = 'button'; b.className = 'ci-row';
    b.innerHTML = '<span style="display:flex;align-items:center;gap:.5rem;min-width:0"><img class="pavatar" src="' + esc(s.headshot || headshotUrl(s.team, s.pid)) + '" alt="" ' + imgFallback + '><span>' + esc(s.name) + ' <span class="muted small">' + esc(CI_TEAM_FULL[s.team] || s.team) + '</span></span>' + typeBadgeHtml(s.pid) + '</span><span class="pct">' + Math.round(s.p * 100) + '%</span>';
    b.addEventListener('click', () => { ciGoHome(); openPlayer(s.pid, s.gameId); });
    return b;
  });
  const seenG = new Set(); const gList = [];
  for (const g of games) for (const team of [g.away, g.home]) {
    const pg = panelGoalie(g, team);
    if (!pg.id || seenG.has(pg.id)) continue;
    seenG.add(pg.id); gList.push({ ...pg, team, gameId: g.id });
  }
  const gRows = gList.filter((x) => ciNorm(x.name).includes(q) || ciTeamHay(x.team).includes(q)).slice(0, CI_CAP).map((x) =>
    ciRow(esc(x.name) + ' <span class="muted small">' + esc(CI_TEAM_FULL[x.team] || x.team) + '</span>', 'goalie card', () => { ciGoHome(); openGoalie(x.id, x.team, x.gameId); }));
  const mRows = games.filter((g) => ciTeamHay(g.away).includes(q) || ciTeamHay(g.home).includes(q)
    || q.split(/\s+/).every((t) => (ciTeamHay(g.away) + ' ' + ciTeamHay(g.home)).includes(t))).slice(0, CI_CAP).map((g) => {
    const t = g.startUTC ? new Date(g.startUTC).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '';
    return ciRow(esc(CI_TEAM_FULL[g.away] || g.away) + ' @ ' + esc(CI_TEAM_FULL[g.home] || g.home), esc(t) + ' · game sheet', () => { ciGoHome(); openMatchup(g.id); });
  });
  const teamSet = [];
  for (const g of games) for (const t of [g.away, g.home]) if (!teamSet.includes(t)) teamSet.push(t);
  const lRows = teamSet.filter((t) => ciTeamHay(t).includes(q)).slice(0, CI_CAP).map((t) =>
    ciRow(esc(CI_TEAM_FULL[t] || t) + ' lineup', 'lineup view', () => { ciGoHome(); openTeamLineup(t); }));
  const built = [ciGroup('Players', pRows), ciGroup('Goalies', gRows), ciGroup('Matchups', mRows), ciGroup('Lineups', lRows)].filter(Boolean);
  if (q.includes('slate') || q.includes('tonight') || built.length === 0) {
    built.push(ciGroup('Slate', [ciRow("Tonight's slate · " + games.length + ' games', 'slate view', () => { ciGoHome(); setView('slate'); renderSlate(); })]));
  }
  built.forEach((d) => res.appendChild(d));
  if (!res.children.length) {
    const e = document.createElement('div'); e.className = 'ci-empty';
    e.textContent = "Nothing found for '" + inp.value.trim() + "'. Try a player, goalie, team, or matchup.";
    res.appendChild(e);
  }
}
const ciSearchInput = $('ciSearchInput');
if (ciSearchInput) {
  ciSearchInput.addEventListener('input', ciRenderSearch);
  ciSearchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      const first = $('ciSearchResults') && $('ciSearchResults').querySelector('.ci-row');
      if (first) { e.preventDefault(); first.click(); }
    }
  });
}
const ciSearchClear = $('ciSearchClear');
if (ciSearchClear) ciSearchClear.addEventListener('click', () => { ciGoHome(); if (ciSearchInput) ciSearchInput.focus(); });
/* ---------------- end Center Ice search ---------------- */
$('teamFilter').addEventListener('change', (e) => applyTeamFilter(e.target.value));
const mktFilter = $('mktTeamFilter');
if (mktFilter) mktFilter.addEventListener('change', (e) => applyTeamFilter(e.target.value));
const mktKindFilter = $('mktKindFilter');
if (mktKindFilter) mktKindFilter.addEventListener('change', (e) => setMarketKind(e.target.value));
/* Collapsible header: the chevron in the brand bar hides the util bar
   (date, picker, Share/Refresh) and the lab tab rows to reclaim vertical
   space. The choice persists per device. */
const headerToggle = $('headerToggle');
function applyHeaderCollapsed(collapsed) {
  const hdr = $('siteHeader');
  if (!hdr) return;
  hdr.classList.toggle('header-collapsed', !!collapsed);
  if (headerToggle) {
    headerToggle.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
    headerToggle.setAttribute('aria-label', collapsed ? 'Expand header' : 'Collapse header');
  }
}
try { applyHeaderCollapsed(window.localStorage.getItem('buenoHeaderCollapsed') === '1'); } catch (e) { /* storage unavailable */ }
if (headerToggle) headerToggle.addEventListener('click', () => {
  const hdr = $('siteHeader');
  const collapsed = !(hdr && hdr.classList.contains('header-collapsed'));
  applyHeaderCollapsed(collapsed);
  try { window.localStorage.setItem('buenoHeaderCollapsed', collapsed ? '1' : '0'); } catch (e) { /* ignore */ }
});
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
// player-card linemate headshots open that linemate's card
document.addEventListener('click', (e) => {
  const mate = e.target.closest('.pc-mate[data-pid]');
  if (mate && mate.dataset.pid) openPlayer(mate.dataset.pid, mate.dataset.gid);
});
// goalie heads in the matchup popup open the goalie card
document.addEventListener('click', (e) => {
  const gh = e.target.closest('.goalie-open[data-goalie]');
  if (gh && gh.dataset.goalie) openGoalie(gh.dataset.goalie, gh.dataset.team, gh.dataset.game);
});
// game-sheet scorer rows replay the goal animation (goal-anim.js)
document.addEventListener('click', (e) => {
  const row = e.target.closest('[data-sheet-goal]');
  if (!row) return;
  const [gid, idx] = row.dataset.sheetGoal.split(':');
  const gl = (sheetGoalsByGame[gid] || [])[+idx];
  if (gl && typeof playGoalAnimation === 'function') playGoalAnimation(gl);
});
/* Home-search handoff: index.html stores the tapped player, we open
   his card once the slate has loaded. One-shot — the key is removed
   on first read, and stale handoffs (>10 min) are dropped. */
function tryOpenPendingPlayer() {
  let raw = null;
  try {
    raw = localStorage.getItem('bueno-pending-open');
    if (raw) localStorage.removeItem('bueno-pending-open');
  } catch (e) { /* no storage, no handoff */ }
  if (!raw) return;
  let p = null;
  try { p = JSON.parse(raw); } catch (e) { return; }
  if (!p || p.type !== 'nhl' || !p.pid) return;
  if (Date.now() - (p.ts || 0) > 10 * 60 * 1000) return;
  const row = state.skaters.find((r) => r.pid === p.pid);
  if (row) openPlayer(row.pid, row.gameId || p.gameId);
}
async function boot(isReload, date) {
  try {
    await loadDate(date || state.date);
    renderAll();
    tryOpenPendingPlayer();
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
loadTypes();
boot(false, $('datePicker').value);

