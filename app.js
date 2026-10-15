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
  view: 'slate',
  sortBy: 'prob',
  teamFilter: '',
  refreshTimer: null,
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
  if (!gp) return { gp: 0, goals: 0, shots: 0, ppg: 0, toiMin: 12, last5: [] }; // rookie prior-ish
  return {
    gp,
    goals: sub.goals || 0,
    shots: sub.shots || 0,
    ppg: sub.powerPlayGoals || 0,
    toiMin: parseToi(avgToi) || 12,
    last5: d.last5Games || [],
    sogpg: (sub.shots || 0) / gp,
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
    const s = land ? skaterSeason(land) : { gp: 0, goals: 0, shots: 0, ppg: 0, toiMin: 12, last5: [] };
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
      shots: zoneByPid[d.pid + ':' + d.gameId] || [],
    };
  });

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

function populateTeamFilter() {
  const sel = $('teamFilter');
  const teams = [...new Set(state.skaters.map((r) => r.team))].sort();
  sel.innerHTML = '<option value="">All teams</option>' +
    teams.map((t) => `<option value="${t}">${t}</option>`).join('');
  state.teamFilter = '';
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
    <table class="factor-table">${factorRows}
      <tr><td>Expected goals (λ)</td><td>${r.lam.toFixed(3)}</td></tr>
      <tr><td>Opponent</td><td>${esc(r.oppAbbr)} goalie ${(r.oppSv * 100).toFixed(1)}% SV</td></tr>
    </table>
    <p class="small muted">Season: ${r.goals}G / ${r.gp}GP · Last 5: ${l5g}G, ${l5s} SOG${r.zone.lowSample ? ' · <em>zone share uses league-average (small sample)</em>' : ''}</p>
    <h4 style="margin:.6rem 0 .2rem">Shot map <span class="muted small">recent games, attacking →</span></h4>
    <canvas class="rink" id="rinkCanvas"></canvas>
    <div class="legend"><span><span class="dot" style="background:#2f6fed"></span>attempt</span>
      <span><span class="dot" style="background:#d4a017"></span>goal</span>
      <span><span class="dot" style="border:2px dashed #e8a13d;background:none"></span>high-danger zone</span></div>`;
  $('playerModal').classList.remove('hidden');
  drawRink($('rinkCanvas'), r.shots, '#2f6fed');
}

function closePlayer() { $('playerModal').classList.add('hidden'); }

/* ---------------- views & refresh ---------------- */
function renderAll() {
  renderSlate();
  renderBoard();
  renderLongshots();
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

/* ---------------- boot ---------------- */
document.querySelectorAll('.tab').forEach((t) =>
  t.addEventListener('click', () => setView(t.dataset.view)));
$('sortSelect').addEventListener('change', (e) => { state.sortBy = e.target.value; renderBoard(); });
$('teamFilter').addEventListener('change', (e) => { state.teamFilter = e.target.value; renderBoard(); });
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
