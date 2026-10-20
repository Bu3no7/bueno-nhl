/* Goalie vulnerability + projections — split from app.js (push size).
   Loaded before app.js; all functions are called at runtime. */
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
  if (!g) return '';
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
    </div>
    <div class="sec-title">Goalie weak zones</div>
    ${goalieZoneGridHtml(pg.id)}`;
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
