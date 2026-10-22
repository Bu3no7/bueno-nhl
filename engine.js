/* ============================================================================
BUENO ENGINE — shared pure functions (no DOM, no localStorage, no globals)
----------------------------------------------------------------------------
Used by BOTH:
  - the browser site (nhl.html loads this before app.js; everything here
    becomes a global for app.js), and
  - sims-runner/run.js in Node (via require('../engine.js')).

RULES: only add pure functions here (inputs in, outputs out). Never reference
`window`, `document`, `localStorage`, or the app's `state` object. If you
change the math, both consumers change together — that is the point.
============================================================================ */

'use strict';

const SEASON = '20262027';

const LEAGUE_SH_PCT = 0.105;

const CALIBRATION = 0.88;

const TAIL_DAMP = 0.85;

const LONGSHOT_P = 1 / 6;
const LONGSHOT_DISPLAY_P = 1 / 11; // +1000 cutoff for the Longshots tab (backtest: value lives in the deep tail)

const HD_NEUTRAL = 0.30;

const REG_K = 12;

const LEAGUE_XG = 3.15; // league-average team expected goals (for team-level shrinkage)

const PRIORS = {
  F: { g: 0.20, s: 2.0, a: 0.32, p: 0.52 },
  D: { g: 0.07, s: 1.5, a: 0.12, p: 0.19 },
};

function regress(obs, gp, prior) {
  const w = gp / (gp + REG_K);
  return w * obs + (1 - w) * prior;
}

const priorsFor = (pos) => PRIORS[pos === 'D' ? 'D' : 'F'];

const MIN_ZONE_ATTEMPTS = 5;

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

async function fetchJSON(url) {
  const r = await fetch(url, { headers: { 'Accept': 'application/json' } });
  if (!r.ok) throw new Error(`NHL API ${r.status} for ${url}`);
  return r.json();
}

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

function computeProb(s, hdShare, oppSv, pos) {
  const gp = Math.max(s.gp, 1);
  const pr = priorsFor(pos);
  const gpg = regress(s.goals / gp, gp, pr.g);
  const sogpg = regress(s.shots / gp, gp, pr.s);
  const lamBase = 0.6 * gpg + 0.4 * (sogpg * LEAGUE_SH_PCT);
  const mToi = clamp(0.6 + 0.4 * (s.toiMin / 20), 0.7, 1.3);
  const mPp = 1 + clamp((s.ppg / gp) * 2, 0, 0.35);
  const mGoal = clamp((1 - oppSv) / 0.10, 0.7, 1.4);
  const mZone = 1 + clamp((hdShare - HD_NEUTRAL) * 1.2, -0.25, 0.35);
  // shooting talent: regressed season SH% vs league average (elite finishers are real)
  const shPctReg = (s.goals + 10.5) / (s.shots + 100);
  const mShoot = 1 + clamp((shPctReg - LEAGUE_SH_PCT) * 2.0, -0.15, 0.25);
  let lam = lamBase * mToi * mPp * mGoal * mZone * mShoot;
  lam *= CALIBRATION;
  if (lam < LONGSHOT_P) lam *= TAIL_DAMP;
  const p = 1 - Math.exp(-lam);
  return {
    p, lam,
    factors: [
      { label: 'Scoring form', value: `${s.goals} G / ${s.gp} GP`, mult: null },
      { label: 'Shot volume', value: `${sogpg.toFixed(1)} SOG/game`, mult: null },
      { label: 'Shooting talent', value: `${(shPctReg * 100).toFixed(1)}% reg. SH%`, mult: mShoot },
      { label: 'Ice time', value: `${fmtToi(s.toiMin)} avg`, mult: mToi },
      { label: 'Power play', value: `${s.ppg} PPG`, mult: mPp },
      { label: 'Opponent goalie', value: `${(oppSv * 100).toFixed(1)}% SV`, mult: mGoal },
      { label: 'Zone score', value: `${Math.round(hdShare * 100)} HD share`, mult: mZone },
    ],
  };
}

function normalizeShot(x, y, shooterTeamId, homeId, homeDefSide) {
  let attackingRight;
  if (shooterTeamId === homeId) attackingRight = (homeDefSide === 'left');
  else attackingRight = (homeDefSide === 'right');
  return { x: attackingRight ? x : -x, y };
}

function zoneShareFor(shots) {
  // shots: [{x, y}] normalized; returns {share, n, hd}
  const n = shots.length;
  if (n < MIN_ZONE_ATTEMPTS) return { share: HD_NEUTRAL, n, hd: 0, lowSample: true };
  const hd = shots.filter((s) => isHighDanger(s.x, s.y)).length;
  return { share: hd / n, n, hd, lowSample: false };
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

async function recentFinalsByTeam(apiBase, beforeDate, maxN) {
  // Fetch each of the last 7 dates ONCE (one date's schedule covers all teams),
  // then index completed finals by team — newest first, trimmed to maxN per team.
  // This replaces one-scan-per-team (up to 22 teams x 7 dates = 154 requests).
  const base = new Date(beforeDate + 'T12:00:00Z');
  const dates = [];
  for (let back = 1; back <= 7; back++) {
    const dt = new Date(base.getTime() - back * 86400000);
    dates.push(dt.toISOString().slice(0, 10));
  }
  const scheds = await limitedMap(dates, 4, async (ds) => {
    try { return await fetchJSON(`${apiBase}/schedule/${ds}`); }
    catch (e) { return null; }
  });
  const byTeam = {};
  dates.forEach((ds, i) => {
    const sched = scheds[i];
    if (!sched) return;
    for (const w of (sched.gameWeek || [])) {
      if (w.date !== ds) continue;
      for (const g of (w.games || [])) {
        const st = g.gameState;
        if (st === 'OFF' || st === 'FINAL') {
          const a = g.awayTeam.abbrev, h = g.homeTeam.abbrev;
          (byTeam[a] = byTeam[a] || []).push(g.id);
          (byTeam[h] = byTeam[h] || []).push(g.id);
        }
      }
    }
  });
  for (const t of Object.keys(byTeam)) byTeam[t] = byTeam[t].slice(0, maxN);
  return byTeam;
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

function simLambda(p) {
  if (!(p > 0)) return 0;
  return p >= 0.9999 ? 9 : -Math.log(1 - p);
}

function poissonSample(lam) {
  if (lam <= 0) return 0;
  const L = Math.exp(-lam);
  let k = 0, pr = 1;
  do { k++; pr *= Math.random(); } while (pr > L);
  return k - 1;
}

function pickWeighted(pool, total) {
  if (!pool.length || total <= 0) return { name: '—' };
  let r = Math.random() * total;
  for (const s of pool) { r -= s.lam; if (r <= 0) return s; }
  return pool[pool.length - 1];
}

function pickWeightedBy(pool, keyFn) {
  let total = 0;
  for (const s of pool) total += Math.max(keyFn(s), 0);
  if (!pool.length || total <= 0) return pool[pool.length - 1] || { name: '—' };
  let r = Math.random() * total;
  for (const s of pool) { r -= Math.max(keyFn(s), 0); if (r <= 0) return s; }
  return pool[pool.length - 1];
}

function simUnits(skaters, gameId, team) {
  const fwdLines = {};
  const dmen = [];
  for (const sk of skaters) {
    if (sk.gameId !== gameId || sk.team !== team) continue;
    const lam = simLambda(sk.p);
    if (lam <= 0) continue;
    const aLam = regress(sk.apg || 0, Math.max(sk.gp, 1), priorsFor(sk.pos).a);
    const e = { name: sk.name, lam, aLam };
    if (sk.pos === 'D') dmen.push({ ...e, toi: sk.toiMin || 0 });
    else {
      const tag = sk.line || 'L4';
      (fwdLines[tag] = fwdLines[tag] || []).push(e);
    }
  }
  const lines = Object.keys(fwdLines).sort().map((tag) => {
    const members = fwdLines[tag];
    return { tag, members, lam: members.reduce((s, x) => s + x.lam, 0) };
  });
  dmen.sort((a, b) => b.toi - a.toi);
  const pairs = [];
  for (let i = 0; i < dmen.length; i += 2) {
    const members = dmen.slice(i, i + 2);
    pairs.push({ tag: 'D' + (pairs.length + 1), members, lam: members.reduce((s, x) => s + x.lam, 0) });
  }
  const lineLam = lines.reduce((s, x) => s + x.lam, 0);
  const pairLam = pairs.reduce((s, x) => s + x.lam, 0);
  return { lines, pairs, lineLam, pairLam, total: lineLam + pairLam };
}

function drawAssistCount() {
  const r = Math.random();
  return r < 0.68 ? 2 : r < 0.90 ? 1 : 0;
}

function assignGoal(units) {
  const line = units.lines.length ? pickWeighted(units.lines, units.lineLam) : null;
  const pair = units.pairs.length ? pickWeighted(units.pairs, units.pairLam) : null;
  let unit = [];
  if (line) unit = unit.concat(line.members);
  if (pair) unit = unit.concat(pair.members);
  if (!unit.length) return { scorer: '—', assists: [], line: null };
  const scorer = pickWeighted(unit, unit.reduce((s, x) => s + x.lam, 0));
  const helpers = [];
  const rest = unit.filter((x) => x !== scorer);
  const nA = Math.min(drawAssistCount(), rest.length);
  for (let i = 0; i < nA; i++) {
    const h = pickWeightedBy(rest, (x) => x.aLam);
    helpers.push(h.name);
    rest.splice(rest.indexOf(h), 1);
  }
  return { scorer: scorer.name, assists: helpers, line: line ? line.tag : null,
           unit: unit.map((x) => x.name) };
}

const EN_RATE = 0.06;

function scoreStateRates(d, min) {
  // d = score differential from team A's perspective (a ‒ b)
  let mA = 1, mB = 1, enA = 0, enB = 0;
  if (d < 0) { // A trailing: push
    mA = d <= -2 ? 1.25 : 1.15;
    mB = d <= -2 ? 0.90 : 0.95;
  } else if (d > 0) { // B trailing: push
    mB = d >= 2 ? 1.25 : 1.15;
    mA = d >= 2 ? 0.90 : 0.95;
  }
  if (min >= 57) { // pulled-goalie window: trailing by 1–2
    if (d === -1 || d === -2) { mA *= 1.6; enB = EN_RATE; }
    else if (d === 1 || d === 2) { mB *= 1.6; enA = EN_RATE; }
  }
  return { mA, mB, enA, enB };
}

function simGameTrace(g, unitsA, unitsB, lamA, lamB) {
  let a = 0, b = 0;
  const goals = [];
  for (let min = 0; min < 60; min++) {
    const { mA, mB, enA, enB } = scoreStateRates(a - b, min);
    const ga = poissonSample((lamA / 60) * mA);
    const gb = poissonSample((lamB / 60) * mB);
    const gea = poissonSample(enA); // A scores into B's empty net
    const geb = poissonSample(enB); // B scores into A's empty net
    for (let q = 0; q < ga; q++) goals.push({ team: g.away, min, ...assignGoal(unitsA) });
    for (let q = 0; q < gb; q++) goals.push({ team: g.home, min, ...assignGoal(unitsB) });
    for (let q = 0; q < gea; q++) goals.push({ team: g.away, min, en: true, ...assignGoal(unitsA) });
    for (let q = 0; q < geb; q++) goals.push({ team: g.home, min, en: true, ...assignGoal(unitsB) });
    a += ga + gea;
    b += gb + geb;
  }
  return { a, b, goals };
}

function regressTeamXG(lamTeam, teamGP) {
  // shrink a team's summed expected goals toward league average.
  // early season the sum inherits all the skater-level noise, so pull hard
  // toward LEAGUE_XG; weight grows as games accumulate.
  const w = teamGP / (teamGP + 15);
  return w * lamTeam + (1 - w) * LEAGUE_XG;
}

function simOneGame(skaters, g, n) {
  const unitsA = simUnits(skaters, g.id, g.away);
  const unitsB = simUnits(skaters, g.id, g.home);
  let lamA = unitsA.total, lamB = unitsB.total;
  // team-level shrinkage: keep directional edge, kill overconfidence
  const gpA = Math.max(0, ...skaters.filter((sk) => sk.gameId === g.id && sk.team === g.away).map((sk) => sk.gp || 0));
  const gpB = Math.max(0, ...skaters.filter((sk) => sk.gameId === g.id && sk.team === g.home).map((sk) => sk.gp || 0));
  if (lamA > 0) lamA = regressTeamXG(lamA, gpA);
  if (lamB > 0) lamB = regressTeamXG(lamB, gpB);
  let sumA = 0, sumB = 0, winA = 0, winB = 0, tie = 0;
  const lines = {};
  let sample = [];
  for (let i = 0; i < n; i++) {
    const { a, b, goals } = simGameTrace(g, unitsA, unitsB, lamA, lamB);
    sumA += a; sumB += b;
    if (a > b) winA++; else if (b > a) winB++; else tie++;
    const k = a + '-' + b;
    lines[k] = (lines[k] || 0) + 1;
    if (i === n - 1) {
      // keep the final sim as the sample box score
      sample = goals.map((gl) => {
        const period = Math.floor(gl.min / 20) + 1;
        const mm = String(gl.min % 20).padStart(2, '0');
        const ss = String(Math.floor(Math.random() * 60)).padStart(2, '0');
        return { ...gl, period, clock: mm + ':' + ss, ord: gl.min * 60 + (+ss) };
      }).sort((x, y) => x.ord - y.ord);
    }
  }
  const top = Object.entries(lines).sort((x, y) => y[1] - x[1]).slice(0, 5);
  return { g, n, avgA: sumA / n, avgB: sumB / n, winA: winA / n, winB: winB / n, tie: tie / n, top, sample };
}

/* Node export (browsers ignore this block) */
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    SEASON, LEAGUE_SH_PCT, CALIBRATION, TAIL_DAMP, LONGSHOT_P, HD_NEUTRAL,
    REG_K, PRIORS, MIN_ZONE_ATTEMPTS, EN_RATE, LEAGUE_XG,
    clamp, fetchJSON, limitedMap,
    parseToi, fmtToi, regress, priorsFor, computeProb, regressTeamXG,
    normalizeShot, zoneShareFor, skaterSeason,
    recentFinalsByTeam, shotsFromPbp, goalieForGame,
    simLambda, poissonSample, pickWeighted, pickWeightedBy, simUnits,
    drawAssistCount, assignGoal, scoreStateRates, simGameTrace, simOneGame,
  };
}
