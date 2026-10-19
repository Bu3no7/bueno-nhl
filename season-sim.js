/* ============================================================================
SEASON SIM — Monte Carlo NHL season + Stanley Cup playoffs (browser)
----------------------------------------------------------------------------
Builds regressed team strengths from current standings, simulates remaining
games with Poisson goal models, applies the NHL playoff format (top 3 per
division + 2 wild cards per conference), simulates the bracket, and returns
per-team playoff/cup probabilities.

Loaded after engine.js (uses LEAGUE_XG, SEASON). No DOM, no app state here —
home.js handles fetching standings and rendering. All randomness via
Math.random; callers can run simSeasonAsync in chunks to keep the page alive.
============================================================================ */
'use strict';

const SEASON_GAMES = 82;
const SIM_REG_W = 20;       // standings regression weight, in games
const SIM_HFA = 0.10;       // home-ice edge, in goals
const SIM_KMAX = 12;        // poisson truncation for game probs
const SIM_DEFAULT_N = 10000;

/* ---------------- team strengths ---------------- */
function buildSeasonTeams(standings) {
  const teams = [];
  for (const s of (standings || [])) {
    const abbr = s.teamAbbrev && s.teamAbbrev.default;
    if (!abbr) continue;
    const div = s.divisionAbbrev;
    const conf = s.conferenceAbbrev || (div === 'A' || div === 'M' ? 'E' : 'W');
    const gp = s.gamesPlayed || 0;
    const w = gp / (gp + SIM_REG_W);
    const avg = (typeof LEAGUE_XG === 'number' ? LEAGUE_XG : 3.15);
    const off = gp > 0 ? w * (s.goalFor / gp) + (1 - w) * avg : avg;
    const def = gp > 0 ? w * (s.goalAgainst / gp) + (1 - w) * avg : avg;
    teams.push({
      abbr, div, conf, gp,
      points: s.points || 0,
      diff: (s.goalFor || 0) - (s.goalAgainst || 0),
      off, def,
    });
  }
  return teams;
}

/* ---------------- poisson game probabilities ---------------- */
function simPoissonPmf(k, lam) {
  let p = Math.exp(-lam);
  for (let i = 1; i <= k; i++) p *= lam / i;
  return p;
}

// Regulation outcome probabilities for a home/away goal-expectation pair.
function gameProbs(xgH, xgA) {
  const ph = new Array(SIM_KMAX + 1), pa = new Array(SIM_KMAX + 1);
  for (let i = 0; i <= SIM_KMAX; i++) { ph[i] = simPoissonPmf(i, xgH); pa[i] = simPoissonPmf(i, xgA); }
  let pHR = 0, pAR = 0, pT = 0;
  for (let i = 0; i <= SIM_KMAX; i++) {
    for (let j = 0; j <= SIM_KMAX; j++) {
      const p = ph[i] * pa[j];
      if (i > j) pHR += p;
      else if (j > i) pAR += p;
      else pT += p;
    }
  }
  return { pHR, pAR, pT };
}

// Precompute every ordered matchup once: regulation probs, P(home wins incl.
// OT), and expected goal differential (used as a standings tiebreak).
function precomputeMatchups(teams) {
  const n = teams.length;
  const M = new Array(n);
  for (let h = 0; h < n; h++) {
    M[h] = new Array(n);
    for (let a = 0; a < n; a++) {
      if (h === a) { M[h][a] = null; continue; }
      let xgH = (teams[h].off + teams[a].def) / 2 + SIM_HFA;
      let xgA = (teams[a].off + teams[h].def) / 2 - SIM_HFA;
      xgH = Math.min(7, Math.max(0.5, xgH));
      xgA = Math.min(7, Math.max(0.5, xgA));
      const { pHR, pAR, pT } = gameProbs(xgH, xgA);
      M[h][a] = { pHR, pAR, pT, pHomeWin: pHR + pT * 0.5, dxg: xgH - xgA };
    }
  }
  return M;
}

/* ---------------- remaining schedule ---------------- */
// Balanced dummy schedule: each team gets (82 - gp) games, opponents drawn
// weighted by their own remaining-game counts (strength-neutral without real
// schedule data). Zero network cost.
function generateDummySchedule(teams) {
  const n = teams.length;
  const rem = teams.map((t) => Math.max(0, SEASON_GAMES - t.gp));
  const games = [];
  for (;;) {
    let i = -1, best = 0;
    for (let k = 0; k < n; k++) if (rem[k] > best) { best = rem[k]; i = k; }
    if (i < 0) break;
    let tot = 0;
    for (let k = 0; k < n; k++) if (k !== i) tot += rem[k];
    if (tot <= 0) break;
    let r = Math.random() * tot, j = -1;
    for (let k = 0; k < n; k++) {
      if (k === i) continue;
      r -= rem[k];
      if (r <= 0) { j = k; break; }
    }
    if (j < 0) break;
    rem[i]--; rem[j]--;
    let h = i, a = j;
    if (Math.random() < 0.5) { h = j; a = i; }
    games.push({ h, a });
  }
  return games;
}

/* ---------------- playoff bracket ---------------- */
// A, B: {t: teamIdx, seed}. Lower seed holds home ice (games 1, 2, 5, 7).
function simSeries(A, B, M) {
  const HT = A.seed <= B.seed ? A : B;
  const AT = A.seed <= B.seed ? B : A;
  let wHT = 0, wAT = 0;
  for (let g = 0; g < 7; g++) {
    const htHome = (g === 0 || g === 1 || g === 4 || g === 6);
    const H = htHome ? HT : AT, W = htHome ? AT : HT;
    const winner = Math.random() < M[H.t][W.t].pHomeWin ? H : W;
    if (winner === HT) wHT++; else wAT++;
    if (wHT === 4 || wAT === 4) break;
  }
  return wHT === 4 ? HT : AT;
}

const _mk = (t, seed) => ({ t, seed });

function simConference(confIdx, divs, teams, pts, dif, M, acc) {
  const sorted = confIdx.slice().sort((x, y) =>
    (pts[y] - pts[x]) || (dif[y] - dif[x]) || (Math.random() - 0.5));
  const winners = [];
  for (const d of divs) {
    const w = sorted.find((i) => teams[i].div === d);
    if (w != null) winners.push(w);
  }
  winners.sort((x, y) => (pts[y] - pts[x]) || (dif[y] - dif[x]));
  const winSet = new Set(winners);
  let seeds = winners.concat(sorted.filter((i) => !winSet.has(i)).slice(0, 8 - winners.length));
  // safety: always 8 teams
  if (seeds.length < 8) {
    for (const i of sorted) {
      if (seeds.length >= 8) break;
      if (!seeds.includes(i)) seeds.push(i);
    }
  }
  seeds = seeds.slice(0, 8);
  for (const i of seeds) acc.playoff[i]++;
  const w18 = simSeries(_mk(seeds[0], 1), _mk(seeds[7], 8), M);
  const w45 = simSeries(_mk(seeds[3], 4), _mk(seeds[4], 5), M);
  const w27 = simSeries(_mk(seeds[1], 2), _mk(seeds[6], 7), M);
  const w36 = simSeries(_mk(seeds[2], 3), _mk(seeds[5], 6), M);
  const s1 = simSeries(w18, w45, M);
  const s2 = simSeries(w27, w36, M);
  return simSeries(s1, s2, M);
}

/* ---------------- season sim ---------------- */
function simSeasonChunk(teams, M, schedule, idxE, idxW, divsE, divsW, n, acc) {
  const N = teams.length;
  const pts = new Float64Array(N), dif = new Float64Array(N);
  for (let sim = 0; sim < n; sim++) {
    for (let i = 0; i < N; i++) { pts[i] = teams[i].points; dif[i] = teams[i].diff; }
    for (let g = 0; g < schedule.length; g++) {
      const h = schedule[g].h, a = schedule[g].a;
      const m = M[h][a];
      const r = Math.random();
      if (r < m.pHR) pts[h] += 2;
      else if (r < m.pHR + m.pAR) pts[a] += 2;
      else if (Math.random() < 0.5) { pts[h] += 2; pts[a] += 1; } // OT
      else { pts[a] += 2; pts[h] += 1; }
      dif[h] += m.dxg; dif[a] -= m.dxg;
    }
    const cE = simConference(idxE, divsE, teams, pts, dif, M, acc);
    const cW = simConference(idxW, divsW, teams, pts, dif, M, acc);
    // Cup final: home ice to the better regular-season record
    const cup = pts[cE.t] >= pts[cW.t]
      ? simSeries(_mk(cE.t, 1), _mk(cW.t, 2), M)
      : simSeries(_mk(cW.t, 1), _mk(cE.t, 2), M);
    acc.cup[cup.t]++;
    for (let i = 0; i < N; i++) acc.pts[i] += pts[i];
  }
}

async function simSeasonAsync(teams, schedule, nSims, onProgress) {
  const n = nSims || SIM_DEFAULT_N;
  const M = precomputeMatchups(teams);
  const N = teams.length;
  const acc = { playoff: new Float64Array(N), cup: new Float64Array(N), pts: new Float64Array(N) };
  const idxE = [], idxW = [];
  teams.forEach((t, i) => { (t.conf === 'E' ? idxE : idxW).push(i); });
  const divsE = [...new Set(idxE.map((i) => teams[i].div))];
  const divsW = [...new Set(idxW.map((i) => teams[i].div))];
  const CHUNK = 1000;
  let done = 0;
  while (done < n) {
    const m = Math.min(CHUNK, n - done);
    simSeasonChunk(teams, M, schedule, idxE, idxW, divsE, divsW, m, acc);
    done += m;
    if (onProgress) onProgress(done, n);
    await new Promise((r) => setTimeout(r, 0)); // let the page breathe
  }
  const out = {};
  teams.forEach((t, i) => {
    out[t.abbr] = {
      playoffPct: acc.playoff[i] / n * 100,
      cupPct: acc.cup[i] / n * 100,
      avgPoints: acc.pts[i] / n,
    };
  });
  return out;
}

/* ---------------- orchestration + daily cache ---------------- */
async function getSeasonOdds(dateStr, standings, nSims, onProgress) {
  const n = nSims || SIM_DEFAULT_N;
  const key = 'buenoSznOdds:' + dateStr + ':' + n;
  try {
    const raw = localStorage.getItem(key);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && parsed.odds) return parsed.odds;
    }
  } catch (e) { /* private mode etc. */ }
  const teams = buildSeasonTeams(standings);
  if (teams.length < 20) throw new Error('standings incomplete');
  const schedule = generateDummySchedule(teams);
  const odds = await simSeasonAsync(teams, schedule, n, onProgress);
  try { localStorage.setItem(key, JSON.stringify({ odds })); } catch (e) {}
  return odds;
}

/* Node export (browsers ignore this block) */
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    SEASON_GAMES, SIM_DEFAULT_N,
    buildSeasonTeams, simPoissonPmf, gameProbs, precomputeMatchups,
    generateDummySchedule, simSeries, simConference,
    simSeasonChunk, simSeasonAsync, getSeasonOdds,
  };
}
