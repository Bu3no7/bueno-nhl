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
  return { games, pbps, rosterMap, recentIds, zonePbps, goalieSv: pre.goalieSv || {}, lines: pre.lines || {} };
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
      return `<div class="game-odds"><span><strong>ML</strong> ${esc(g.away)} ${mlA} · ${esc(g.home)} ${mlB}</span><span><strong>PL</strong> ${favA ? esc(g.away) + ' −1.5' : esc(g.home) + ' −1.5'} ${plFav}</span><span><strong>Total</strong> ${total}</span></div>`;
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
    if (el) el.outerHTML = playerBioHtml(r, true);
  } catch (e) { /* bio stays empty */ }
  r._bioLoading = false;
}
function linematesHtml(r) {
  const mates = state.skaters.filter((s) => s.team === r.team && String(s.gameId) === String(r.gameId) && String(s.pid) !== String(r.pid));
  let title = '', cells = '';
  if (['C', 'L', 'R'].includes(r.pos) && r.line) {
    const line = mates.filter((s) => s.line === r.line);
    if (!line.length) return '';
    title = `Line ${r.line} — linemates`;
    const POSORD = { LW: 0, C: 1, RW: 2 };
    cells = [r, ...line]
      .sort((a, b) => ((POSORD[a.linePos] ?? 9) - (POSORD[b.linePos] ?? 9)) || (b.toiMin - a.toiMin))
      .map((s) => lineupCellHtml(s, String(s.pid) === String(r.pid))).join('');
  } else if (r.pos === 'D' && r.line && /^D[123]$/.test(r.line)) {
    const pair = [r, ...mates.filter((s) => s.pos === 'D' && s.line === r.line)];
    if (pair.length < 2) return '';
    title = `Pair ${r.line} — partner`;
    cells = pair.map((s) => lineupCellHtml(s, String(s.pid) === String(r.pid))).join('');
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
  const estTag = r.lineEst === false ? '' : ' <span class="muted small">est.</span>';
  return `<h4 style="margin:.5rem 0 .15rem">${esc(title)}${estTag}</h4><div class="lu-row"><div class="lu-players">${cells}</div></div>`;
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
  <h4 class="tape-title">Game preview</h4>
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
function renderBoard() {
  initFinder();
  const tb = $('boardBody');
  const scorerByGame = {};
  for (const g of state.games) scorerByGame[g.id] = scorerCounts(g);
  tb.innerHTML = sortedSkaters().map((r) => {
    const ng = (scorerByGame[r.gameId] || {})[r.pid] || 0;
    const badge = ng ? `<span class="goal-badge">${ng > 1 ? ng + 'G' : 'GOAL'}</span>` : '';
    const pct = r.p * 100;
    const heat = pct >= 30 ? 'h5' : pct >= 22 ? 'h4' : pct >= 15 ? 'h3' : pct >= 10 ? 'h2' : 'h1';
    const fitBadge = state.sortBy === 'fit' && r._fit != null ? `<span class="fit-badge">${Math.round(r._fit * 100)}</span>` : '';
    // hot/cold: goals in last 5 games
    const l5g = (r.last5 || []).slice(0, 5).reduce((a, x) => a + (x.goals || 0), 0);
    const streak = l5g >= 3 ? `<span class="streak hot" title="${l5g} goals in last 5">🔥</span>`
      : l5g <= 1 && (r.last5 || []).length >= 3 ? `<span class="streak cold" title="${l5g} goals in last 5">❄️</span>` : '';
    return `
    <tr${ng ? ' class="scored"' : ''}>
      <td>${pnameBtn(r)}${badge}${fitBadge}${streak}
        <div class="prob-bar"><i style="width:${Math.min(100, r.p * 100 * 2.5)}%"></i></div></td>
      <td><span class="team-cell"><img src="${teamLogoUrl(r.team)}" alt="" ${imgFallback}>${esc(r.team)}</span></td>
      <td>${esc(r.pos)}</td>
      <td class="num heat ${heat}"><strong>${pct1(r.p)}</strong></td>
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
/* ---------------- market leaders board ----------------
   Collapsible top-3 per market at the top of the Markets view: anytime
   goal, brace, first goal, and the headline Poisson line for shots,
   assists and points. Face cards + clickable names via pnameBtn. */
function renderLeaders() {
  const grid = $('leadersGrid');
  if (!grid) return;
  const sk = state.skaters || [];
  if (!sk.length) {
    grid.innerHTML = '<p class="muted small">Leaders load with the slate.</p>';
    return;
  }
  const probVal = (pKey, fairKey) => (r) =>
    `<strong>${pct1(r[pKey])}</strong> <span class="muted">${r[fairKey]}</span>`;
  const groups = [
    { title: 'Anytime goal', rows: sk.slice().sort((a, b) => b.p - a.p).slice(0, 3), val: probVal('p', 'fair') },
    { title: 'Brace', rows: twoPlusProbs().slice(0, 3), val: probVal('tpP', 'tpFair') },
    { title: 'First goal', rows: firstGoalProbs().slice(0, 3), val: probVal('fgP', 'fgFair') },
  ];
  for (const kind of ['shots', 'assists', 'points']) {
    const line = MARKET_HEADLINE[kind];
    const rows = sk.slice()
      .sort((a, b) => marketOver(b, kind, line) - marketOver(a, kind, line))
      .slice(0, 3);
    groups.push({
      title: `${MARKET_META[kind].label} o${line}`,
      rows,
      val: (r) => {
        const m = (r.markets[kind] || []).find((x) => x.line === line);
        return `<strong>${pct1(m ? m.over : 0)}</strong> <span class="muted">${m ? m.overFair : '–'}</span>`;
      },
    });
  }
  grid.innerHTML = groups.map((g) => `
    <div class="leader-group">
      <h4>${esc(g.title)}</h4>
      ${g.rows.map((r, i) => `
        <div class="leader-row">
          <span class="leader-rank">${i + 1}</span>
          ${pnameBtn(r)}
          <span class="leader-val">${g.val(r)}</span>
        </div>`).join('')}
    </div>`).join('');
  wirePnameClicks(grid);
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
  $('modalBody').innerHTML = `
    <div class="pc-head hero-card-head">
      <img class="headshot" src="${esc(r.headshot)}" alt="" ${imgFallback}>
      <div>
        <h3 class="pc-name">${esc(r.name)}</h3>
        <div><img class="tlogo" src="${teamLogoUrl(r.team)}" alt="" ${imgFallback}>
          <span class="muted">${esc(r.team)} · ${esc(r.pos)} · ${g ? esc(g.away + ' @ ' + g.home) : ''}</span></div>
      </div>
      <div style="margin-left:auto;text-align:center">
        <div class="hero-card-num">${Math.round(r.p * 100)}<small>%</small></div>
        <div class="hero-card-label">Anytime Goal</div>
        <div class="pc-fair">${r.fair} fair</div>
      </div>
    </div>
    <div class="pc-status">${lineBadge}${statusPill}</div>
    ${playerBioHtml(r, !r.bio)}
    <div class="stat-inline"><span><strong>${r.goals}</strong> goals</span><span><strong>${r.assists}</strong> assists</span><span><strong>${r.points}</strong> points</span><span><strong>${r.gp}</strong> GP</span></div>
    <div class="section-div"></div>
    ${linematesHtml(r)}
    <div class="section-div"></div>
    ${vsGoalieHtml(r, g)}
    <details class="factors-details">
      <summary class="sec-title" style="cursor:pointer">Factors <span style="color:var(--gold)">how we got here</span></summary>
      <table class="factor-table">${factorRows}
        <tr><td>Expected goals (λ)</td><td>${r.lam.toFixed(3)}</td></tr>
        <tr><td>Opponent</td><td>${esc(r.oppAbbr)} goalie ${(r.oppSv * 100).toFixed(1)}% SV</td></tr>
      </table>
    </details>
    <p class="small muted">Season: ${r.goals}G ${r.assists}A ${r.points}P / ${r.gp}GP · Last 5: ${l5g}G, ${l5s} SOG${r.zone.lowSample ? ' · <em>zone share uses league-average (small sample)</em>' : ''}</p>
    <div class="sec-title">vs League Average</div>
    ${statBarsHtml(r)}
    <h4 style="margin:.8rem 0 .2rem">Markets <span class="muted small">Poisson over/under</span></h4>
    ${marketsHtml}
    <div class="parlay-add">
      <select id="parlayLegSelect" aria-label="Choose a parlay leg">${legOpts.join('')}</select>
      <button class="btn" id="parlayAddBtn">Add to parlay</button>
    </div>
    <details class="rink-details" open>
      <summary class="sec-title" style="cursor:pointer"><span id="rinkTitle" style="color:var(--gold)">Shot map</span> <span class="muted small">recent games, attacking ↑</span></summary>
      <div style="margin:.4rem 0"><button class="pill on" id="rinkShots">Shots</button> <button class="pill" id="rinkGoals">Goals</button></div>
      <canvas class="rink" id="rinkCanvas"></canvas>
      <div class="legend"><span><span class="dot" style="background:#2f6fed"></span>attempt</span>
        <span><span class="dot" style="background:#d4a017"></span>goal</span>
      <span><span class="dot" style="background:#a06414"></span>slot</span> <span><span class="dot" style="background:#c42c1e"></span>low slot</span></div>
    </details>
    ${heatMapSectionHtml(r)}`;
  $('playerModal').classList.remove('hidden');
  ensurePlayerBio(r);
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
/* ---------------- goal heat map (player card) ----------------
   Where a skater's goals come from: heat grid over his shot attempts
   (tonight + recent games, normalized attacking coords), the slot /
   home-plate area outlined, goals starred, and zone stats as chips. */
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
function heatMapSectionHtml(r) {
  const shots = r.shots || [];
  if (shots.length < 5) {
    return `<details class="rink-details heat-details">
      <summary class="sec-title" style="cursor:pointer"><span style="color:var(--gold)">Goal heat map</span> <span class="muted small">where his goals come from</span></summary>
      <p class="muted small" style="margin:.5rem 0 0">Not enough shot data yet — the map fills in as games are played.</p>
    </details>`;
  }
  const zs = zoneStats(shots);
  const total = shots.length;
  const pct = (k) => Math.round((zs[k].att / total) * 100);
  const hot = ['lowSlot', 'slot', 'left', 'right', 'point'].reduce((a, b) => (zs[a].att >= zs[b].att ? a : b));
  const zlabel = (k, name, left, top) => `<div class="zlabel" style="left:${left}%; top:${top}%"><div class="zname">${name}</div><div class="zbig${k === hot ? ' hot' : ''}">${pct(k)}%</div><div class="zchips"><span class="zchip"><b>${zs[k].att}</b> att</span><span class="zchip g"><b>${zs[k].goals}</b> G</span></div></div>`;
  const slotShare = (zs.lowSlot.att + zs.slot.att) / total;
  const take = slotShare >= 0.5
    ? `Lives in the slot — ${Math.round(slotShare * 100)}% of his shots come from the home-plate area${zs.lowSlot.goals ? ', and the low slot is where the goals are' : ''}.`
    : (zs.point.att / total >= 0.3
      ? 'Does his damage from distance — point shots and perimeter looks.'
      : 'Scores from all over the zone — no single home base.');
  return `<details class="rink-details heat-details">
    <summary class="sec-title" style="cursor:pointer"><span style="color:var(--gold)">Goal heat map</span> <span class="muted small">where his goals come from</span></summary>
    <div class="zonemap">
      <svg viewBox="0 0 380 430" aria-hidden="true">
        <defs>
          <clipPath id="zmClip"><path d="M14 426 L14 120 A176 108 0 0 1 366 120 L366 426 Z"/></clipPath>
          <radialGradient id="zmIce" cx="50%" cy="38%" r="80%">
            <stop offset="0%" stop-color="#16233f"/><stop offset="60%" stop-color="#101b31"/><stop offset="100%" stop-color="#0a1120"/>
          </radialGradient>
        </defs>
        <g clip-path="url(#zmClip)">
          <rect x="0" y="0" width="380" height="430" fill="url(#zmIce)"/>
          <rect x="0" y="300" width="380" height="130" fill="rgba(24,68,84,.55)"/>
          <polygon points="14,26 190,26 190,300 14,300" fill="rgba(23,94,108,.45)"/>
          <polygon points="190,26 366,26 366,300 190,300" fill="rgba(23,94,108,.45)"/>
          <polygon points="190,96 128,168 108,300 272,300 252,168" fill="rgba(160,104,20,.5)"/>
          <rect x="140" y="30" width="100" height="118" fill="rgba(196,44,30,.78)"/>
          <circle cx="105" cy="215" r="58" fill="none" stroke="rgba(235,242,255,.35)" stroke-width="2"/>
          <circle cx="275" cy="215" r="58" fill="none" stroke="rgba(235,242,255,.35)" stroke-width="2"/>
          <circle cx="105" cy="215" r="4" fill="#e5484d"/>
          <circle cx="275" cy="215" r="4" fill="#e5484d"/>
          <line x1="14" y1="86" x2="366" y2="86" stroke="#e5484d" stroke-width="2.5"/>
          <line x1="14" y1="300" x2="366" y2="300" stroke="#3b82f6" stroke-width="3.5"/>
          <path d="M158 86 A32 32 0 0 0 222 86 Z" fill="rgba(94,200,248,.35)"/>
          <rect x="172" y="18" width="36" height="16" fill="#0d1524" stroke="rgba(255,255,255,.45)"/>
          <line x1="128" y1="168" x2="105" y2="215" stroke="rgba(232,161,61,.65)" stroke-width="2"/>
          <line x1="252" y1="168" x2="275" y2="215" stroke="rgba(232,161,61,.65)" stroke-width="2"/>
        </g>
        <path d="M14 426 L14 120 A176 108 0 0 1 366 120 L366 426" fill="none" stroke="rgba(235,242,255,.55)" stroke-width="3"/>
      </svg>
      ${zlabel('lowSlot', 'LOW SLOT', 50, 24)}
      ${zlabel('slot', 'SLOT', 50, 56)}
      ${zlabel('left', 'LEFT SIDE', 19, 40)}
      ${zlabel('right', 'RIGHT SIDE', 81, 40)}
      ${zlabel('point', 'POINT', 50, 85)}
    </div>
    <div class="outside-strip">OUTSIDE THE ZONE: ${zs.outside.att} ATT · ${pct('outside')}% · ${zs.outside.goals} G</div>
    <p class="small muted" style="margin:.55rem 0 0">${take} <span class="muted">(${total} attempts tracked)</span></p>
  </details>`;
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
/* Home + NHL Lab code lives in home.js */
function renderAll() {
  renderSlate();
  renderGoals();
  renderBoard();
  renderLongshots();
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
const HOME_VIEWS = ['home', 'standings', 'teamlineup', 'playoffodds'];
const LAB_VIEWS = ['markets', 'longshots', 'parlay', 'slate', 'goals', 'board'];
function setView(v) {
  state.view = v;
  // Keep the section in sync with the view
  if (HOME_VIEWS.includes(v)) state.section = 'home';
  else if (LAB_VIEWS.includes(v)) state.section = 'lab';
  document.querySelectorAll('.bnav-btn').forEach((b) => b.classList.toggle('active', b.dataset.section === state.section));
  const labNav = $('labNav');
  if (labNav) labNav.hidden = state.section !== 'lab';
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.view === v));
  document.querySelectorAll('.view').forEach((s) => s.classList.toggle('active', s.id === 'view-' + v));
  const arn = $('autoRefreshNote');
  if (arn) arn.style.visibility = v === 'slate' ? 'visible' : 'hidden';
  if (v === 'home') renderHome();
  if (v === 'standings') renderStandings();
  if (v === 'teamlineup') renderTeamLineup();
  if (v === 'playoffodds') renderPlayoffOdds();
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
  t.addEventListener('click', () => setView(t.dataset.view)));
// Bottom nav: Home / NHL Lab section switching
document.querySelectorAll('.bnav-btn').forEach((b) =>
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
  const pr = e.target.closest('.pick-row[data-pid]');
  if (pr && pr.dataset.pid) openPlayer(pr.dataset.pid, pr.dataset.gid);
});
// Home + standings + odds: team rows open the team lineup view
document.addEventListener('click', (e) => {
  const tr = e.target.closest('.team-row[data-team]');
  if (tr && tr.dataset.team) openTeamLineup(tr.dataset.team);
});
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' && e.key !== ' ') return;
  const pr = e.target.closest && e.target.closest('.pick-row[data-pid]');
  if (pr && pr.dataset.pid) { e.preventDefault(); openPlayer(pr.dataset.pid, pr.dataset.gid); return; }
  const tr = e.target.closest && e.target.closest('.team-row[data-team]');
  if (tr && tr.dataset.team) { e.preventDefault(); openTeamLineup(tr.dataset.team); }
});
// Home is the default section on boot
state.section = 'home';
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

