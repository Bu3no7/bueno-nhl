/* ================= Home + NHL Lab ================= */
let nhlStandingsCache = null;
let nhlStandingsCacheTime = 0;
async function fetchStandings() {
  const now = Date.now();
  if (nhlStandingsCache && now - nhlStandingsCacheTime < 5 * 60 * 1000) return nhlStandingsCache;
  try {
    // NOTE: /standings/now 307-redirects off-proxy (CORS-killed) — use date-specific path
    const data = await fetchJSON(`${API}/standings/${state.date}`);
    nhlStandingsCache = data.standings || [];
    nhlStandingsCacheTime = now;
  } catch (e) {
    nhlStandingsCache = [];
  }
  return nhlStandingsCache;
}
const DIV_NAMES = { A: 'Atlantic', M: 'Metropolitan', C: 'Central', P: 'Pacific' };
const DIV_ORDER = ['A', 'M', 'C', 'P'];
function groupStandingsByDiv(all) {
  const byDiv = { A: [], M: [], C: [], P: [] };
  for (const s of (all || [])) {
    const div = s.divisionAbbrev;
    if (byDiv[div]) byDiv[div].push(s);
  }
  return byDiv;
}
function teamLogoCell(abbr) {
  return `<span class="team-cell"><img class="team-logo" src="${teamLogoUrl(abbr)}" alt="" ${imgFallback}>${esc(abbr)}</span>`;
}
function teamLogoOnly(abbr) {
  return `<img class="team-logo" src="${teamLogoUrl(abbr)}" alt="" ${imgFallback} style="width:28px;height:28px;vertical-align:middle;margin-right:.4rem">`;
}
/* ---- section switching (bottom nav) ---- */
function setSection(sec) {
  state.section = sec;
  document.querySelectorAll('.bnav-btn').forEach((b) => b.classList.toggle('active', b.dataset.section === sec));
  const labNav = $('labNav');
  if (labNav) labNav.hidden = sec !== 'lab';
  if (sec === 'home') {
    setView('home');
  } else {
    // NHL Lab: show the lab sub-view (default to markets)
    const labViews = ['markets', 'longshots', 'parlay', 'slate', 'goals', 'board'];
    setView(labViews.includes(state.view) ? state.view : 'markets');
  }
}
/* ---- Home: top picks ---- */
function renderHomePicks() {
  const el = $('homePicksBody');
  if (!el) return;
  const skaters = (state.skaters || []).filter((s) => s.pos !== 'G' && s.p > 0);
  if (!skaters.length) {
    el.innerHTML = `<p class="muted">Loading…</p>`;
    return;
  }
  const top = [...skaters].sort((a, b) => b.p - a.p).slice(0, 5);
  el.innerHTML = top.map((r) => {
    const g = state.games.find((gg) => String(gg.id) === String(r.gameId));
    const matchup = g ? `${g.away} @ ${g.home}` : esc(r.team);
    const pct = Math.round(r.p * 100);
    return `<div class="pick-row hero-pick" data-pid="${r.pid}" data-gid="${r.gameId}" role="button" tabindex="0">
      <div class="hero-num">${pct}<small>%</small></div>
      <img class="pick-head" src="${esc(r.headshot || '')}" alt="" ${imgFallback}>
      <div><div class="pick-name">${esc(r.name)}</div>
      <div class="pick-meta">${esc(r.team)} · ${esc(matchup)} · ${r.goals}G</div>
      <div class="pick-fair">${r.fair} fair</div></div>
    </div>`;
  }).join('');
}
/* ---- Home: yesterday's results ---- */
async function renderHomeResults() {
  const el = $('homeResultsBody');
  if (!el) return;
  try {
    const y = new Date();
    y.setDate(y.getDate() - 1);
    const dateStr = y.toISOString().slice(0, 10);
    const sched = await fetchJSON(`${API}/schedule/${dateStr}`);
    const day = (sched.gameWeek || []).find((w) => w.date === dateStr);
    const games = day ? day.games.filter((g) => g.gameState === 'OFF' || g.gameState === 'FINAL') : [];
    if (!games.length) {
      el.innerHTML = `<p class="muted">No games yesterday.</p>`;
      return;
    }
    let html = '';
    for (const g of games) {
      const a = g.awayTeam, h = g.homeTeam;
      html += `<div class="result-game">
        <div class="result-score"><strong>${esc(a.abbrev)} ${a.score} — ${h.score} ${esc(h.abbrev)}</strong></div>
        <div class="result-goals" id="rg-${g.id}"><span class="muted small">Loading scorers…</span></div>
      </div>`;
    }
    el.innerHTML = html;
    // Load scorers per game
    for (const g of games) {
      try {
        const pbp = await fetchJSON(`${API}/gamecenter/${g.id}/play-by-play`);
        const goals = extractGoals(pbp, g);
        const gel = $(`rg-${g.id}`);
        if (!gel) continue;
        if (!goals.length) { gel.innerHTML = `<span class="muted small">No goals.</span>`; continue; }
        gel.innerHTML = goals.map((gl, i) => {
          const t = GOAL_TYPE_LABEL[gl.type] || gl.type;
          return `<button class="gtype gtype-${gl.type.toLowerCase()} gtype-clickable result-goal-btn" data-gidx="${i}" data-gid="${g.id}">${esc(gl.scorer)} <span class="muted">(${t})</span></button>`;
        }).join(' ');
        // Wire replay
        gel.querySelectorAll('.result-goal-btn').forEach((b) => {
          const gl = goals[+b.dataset.gidx];
          b._goal = { ...gl, gameAway: g.awayTeam.abbrev, gameHome: g.homeTeam.abbrev, awayScore: g.awayTeam.score, homeScore: g.homeTeam.score };
          b.addEventListener('click', () => playGoalAnimation(b._goal));
        });
      } catch (e) { /* leave loading text */ }
    }
  } catch (e) {
    el.innerHTML = `<p class="muted">Couldn't load results.</p>`;
  }
}
/* ---- Home: standings preview (compact, by division) ---- */
async function renderHomeStandings() {
  const el = $('homeStandingsBody');
  if (!el) return;
  const all = await fetchStandings();
  if (!all.length) {
    el.innerHTML = `<p class="muted">Couldn't load standings.</p>`;
    return;
  }
  const byDiv = groupStandingsByDiv(all);
  let html = '';
  for (const div of DIV_ORDER) {
    const teams = byDiv[div].slice(0, 4);
    if (!teams.length) continue;
    html += `<p class="home-div-label">${DIV_NAMES[div]}</p>`;
    html += `<div class="table-wrap"><table class="standings-mini"><tbody>`;
    html += teams.map((s) => `<tr class="team-row" data-team="${esc(s.teamAbbrev.default)}" role="button" tabindex="0">
      <td>${teamLogoCell(s.teamAbbrev.default)}</td>
      <td class="num"><strong>${s.points}</strong></td>
    </tr>`).join('');
    html += `</tbody></table></div>`;
  }
  html += `<button class="ghost-btn home-standings-more" id="homeStandingsMore" type="button">Full standings &rarr;</button>`;
  el.innerHTML = html;
  const more = $('homeStandingsMore');
  if (more) more.addEventListener('click', (e) => { e.stopPropagation(); setView('standings'); });
}
/* ---- Full standings view ---- */
function standingsRowHtml(s) {
  const diff = (s.goalFor || 0) - (s.goalAgainst || 0);
  const diffStr = diff > 0 ? '+' + diff : String(diff);
  const streak = (s.streakCode || '') + (s.streakCount || '');
  return `<tr class="team-row" data-team="${esc(s.teamAbbrev.default)}" role="button" tabindex="0">
    <td>${teamLogoCell(s.teamAbbrev.default)}</td>
    <td class="num">${s.gamesPlayed}</td>
    <td class="num">${s.wins}</td>
    <td class="num">${s.losses}</td>
    <td class="num">${s.otLosses}</td>
    <td class="num"><strong>${s.points}</strong></td>
    <td class="num">${diffStr}</td>
    <td class="num">${esc(streak)}</td>
  </tr>`;
}
const STANDINGS_HEAD = `<thead><tr><th>Team</th><th class="num">GP</th><th class="num">W</th><th class="num">L</th><th class="num">OTL</th><th class="num">PTS</th><th class="num">DIFF</th><th class="num">STRK</th></tr></thead>`;
async function renderStandings() {
  const el = $('standingsBody');
  if (!el) return;
  const all = await fetchStandings();
  if (!all.length) {
    el.innerHTML = `<p class="muted">Couldn't load standings. Check your connection.</p>`;
    return;
  }
  const byDiv = groupStandingsByDiv(all);
  let html = '';
  for (const div of DIV_ORDER) {
    if (!byDiv[div].length) continue;
    html += `<h3 class="standings-div">${DIV_NAMES[div]}</h3>`;
    html += `<div class="table-wrap"><table class="standings-table">${STANDINGS_HEAD}<tbody>`;
    html += byDiv[div].map(standingsRowHtml).join('');
    html += `</tbody></table></div>`;
  }
  el.innerHTML = html;
}
/* ---- Team lineup view (from standings) ---- */
function openTeamLineup(abbr) {
  state.teamLineupAbbr = abbr;
  setView('teamlineup');
  renderTeamLineup();
}
function renderTeamLineup() {
  const abbr = state.teamLineupAbbr;
  const titleEl = $('teamLineupTitle');
  const bodyEl = $('teamLineupBody');
  if (!bodyEl) return;
  if (titleEl) titleEl.innerHTML = `${teamLogoOnly(abbr)}${esc(teamFullName(abbr))}`;
  // Find the team's most relevant game (today's slate, prefer unstarted)
  const games = (state.games || []).filter((g) =>
    g.away === abbr || g.home === abbr);
  let gameId = null;
  if (games.length) {
    const unstarted = games.find((g) => g.state !== 'LIVE' && g.state !== 'OFF');
    gameId = String((unstarted || games[0]).id);
  }
  if (!gameId) {
    // No game today — fall back to the team's current roster
    renderTeamRoster(abbr);
    return;
  }
  const html = teamLineupHtml(abbr, gameId);
  bodyEl.innerHTML = html ? `<div class="lu-wrap">${html}</div>`
    : `<p class="muted">Lineup not available yet.</p>`;
}
const TEAM_FULL_NAMES = {
  ANA: 'Anaheim Ducks', BOS: 'Boston Bruins', BUF: 'Buffalo Sabres', CAR: 'Carolina Hurricanes',
  CBJ: 'Columbus Blue Jackets', CGY: 'Calgary Flames', CHI: 'Chicago Blackhawks', COL: 'Colorado Avalanche',
  DAL: 'Dallas Stars', DET: 'Detroit Red Wings', EDM: 'Edmonton Oilers', FLA: 'Florida Panthers',
  LAK: 'Los Angeles Kings', MIN: 'Minnesota Wild', MTL: 'Montreal Canadiens', NJD: 'New Jersey Devils',
  NSH: 'Nashville Predators', NYI: 'New York Islanders', NYR: 'New York Rangers', OTT: 'Ottawa Senators',
  PHI: 'Philadelphia Flyers', PIT: 'Pittsburgh Penguins', SEA: 'Seattle Kraken', SJS: 'San Jose Sharks',
  STL: 'St. Louis Blues', TBL: 'Tampa Bay Lightning', TOR: 'Toronto Maple Leafs', UTA: 'Utah Mammoth',
  VAN: 'Vancouver Canucks', VGK: 'Vegas Golden Knights', WSH: 'Washington Capitals', WPG: 'Winnipeg Jets',
};
function teamFullName(abbr) { return TEAM_FULL_NAMES[abbr] || abbr; }
/* Fallback: show current roster grouped by position when the team has no game today */
async function renderTeamRoster(abbr) {
  const bodyEl = $('teamLineupBody');
  const titleEl = $('teamLineupTitle');
  if (titleEl) titleEl.innerHTML = `${teamLogoOnly(abbr)}${esc(teamFullName(abbr))}`;
  if (!bodyEl) return;
  bodyEl.innerHTML = `<p class="muted">Loading roster…</p>`;
  try {
    // NOTE: /roster/{team}/current 307-redirects off-proxy — use season path
    const d = new Date();
    const seasonId = `${d.getMonth() >= 6 ? d.getFullYear() : d.getFullYear() - 1}${(d.getMonth() >= 6 ? d.getFullYear() : d.getFullYear() - 1) + 1}`;
    const data = await fetchJSON(`${API}/roster/${abbr}/${seasonId}`);
    const skaters = (data.forwards || []).concat(data.defensemen || []);
    const goalies = data.goalies || [];
    if (!skaters.length && !goalies.length) throw new Error('empty');
    const fwds = skaters.filter((p) => (p.positionCode || '') !== 'D' && (p.positionCode || '') !== 'G');
    const defs = skaters.filter((p) => (p.positionCode || '') === 'D');
    const cell = (p) => {
      const pid = p.id;
      const name = `${p.firstName?.default || ''} ${p.lastName?.default || ''}`.trim();
      const last = name.split(' ').slice(-1)[0];
      const hs = headshotUrl(abbr, pid);
      // stash minimal skater so openPlayer can find them (with bio data)
      if (!state.skaters.some((s) => String(s.pid) === String(pid))) {
        state.skaters.push({ pid, gameId: 'roster', name, pos: p.positionCode || '', team: abbr, headshot: hs,
          goals: 0, assists: 0, points: 0, gp: 0, shots: 0, toiMin: 0, p: 0, fair: '—', lam: 0, factors: [],
          markets: { shots: [], assists: [], points: [] }, zone: {}, last5: [],
          bio: { number: p.sweaterNumber, dob: p.birthDate, birthplace: [p.birthCity?.default, p.birthCountry].filter(Boolean).join(', '),
                 height: p.heightInInches ? `${Math.floor(p.heightInInches/12)}'${p.heightInInches%12}"` : null,
                 weight: p.weightInPounds ? `${p.weightInPounds} lbs` : null, shoots: p.shootsCatches } });
      }
      return `<div class="lu-cell" data-pid="${pid}" data-gid="roster" role="button" tabindex="0" title="${esc(name)}">
        <img class="lu-head" src="${esc(hs)}" alt="" ${typeof imgFallback !== 'undefined' ? imgFallback : ''}>
        <div class="lu-name">${esc(last)}</div>
        <div class="lu-sub muted">${esc(p.positionCode || '')}</div>
      </div>`;
    };
    let html = `<div class="lu-team"><div class="lu-teamhead">${esc(teamFullName(abbr))} — roster</div>`;
    if (fwds.length) html += `<div class="lu-row"><div class="lu-label">F</div><div class="lu-players">${fwds.map(cell).join('')}</div></div>`;
    if (defs.length) html += `<div class="lu-row"><div class="lu-label">D</div><div class="lu-players">${defs.map(cell).join('')}</div></div>`;
    if (goalies.length) html += `<div class="lu-row"><div class="lu-label">G</div><div class="lu-players">${goalies.map(cell).join('')}</div></div>`;
    bodyEl.innerHTML = html + '</div>';
  } catch (e) {
    bodyEl.innerHTML = `<p class="muted">Roster unavailable right now.</p>`;
  }
}
/* ---- Playoff odds: donut + table (Monte Carlo season sim) ---- */
let _oddsRun = 0;
async function renderPlayoffOdds() {
  const homeEl = $('homeOddsBody');
  const fullEl = $('oddsBody');
  const run = ++_oddsRun;
  const loading = `<p class="muted">Simulating season…</p>`;
  if (homeEl) homeEl.innerHTML = loading;
  if (fullEl) fullEl.innerHTML = loading;
  try {
    const standings = await fetchStandings();
    const odds = await getSeasonOdds(state.date, standings, 10000, (done, total) => {
      if (run !== _oddsRun) return;
      const msg = `<p class="muted">Simulating ${total.toLocaleString()} seasons… ${Math.round(done / total * 100)}%</p>`;
      if (homeEl) homeEl.innerHTML = msg;
      if (fullEl) fullEl.innerHTML = msg;
    });
    if (run !== _oddsRun) return; // superseded
    const rows = Object.entries(odds)
      .map(([abbr, o]) => ({ abbr, po: o.playoffPct, cup: o.cupPct }))
      .sort((a, b) => b.po - a.po);
    if (homeEl) {
      homeEl.innerHTML = `
        <div class="po-donut-wrap">${playoffDonutSvg(rows.slice(0, 8))}</div>
        <div class="po-legend">${rows.slice(0, 4).map((t) => {
          const color = TEAM_COLORS[t.abbr] || '#3adbe3';
          return `<div class="legend-item"><div class="legend-dot" style="background:${color};box-shadow:0 0 6px ${color}"></div>${esc(t.abbr)} ${t.po.toFixed(1)}%</div>`;
        }).join('')}</div>
        <button class="ghost-btn" id="homeOddsMore" type="button">Full odds &rarr;</button>
        <p class="muted small po-note">10,000 simulated seasons · model estimates</p>`;
      const more = $('homeOddsMore');
      if (more) more.addEventListener('click', () => setView('playoffodds'));
    }
    if (fullEl) {
      fullEl.innerHTML = `
        <div class="po-donut-wrap">${playoffDonutSvg(rows.slice(0, 8))}</div>
        <div class="table-wrap"><table class="odds-table">
          <thead><tr><th>Team</th><th class="num">Playoffs</th><th class="num">Cup</th></tr></thead>
          <tbody>${rows.map((t) => `<tr class="team-row" data-team="${esc(t.abbr)}" role="button" tabindex="0">
            <td>${teamLogoCell(t.abbr)}</td>
            <td class="num ${oddsClass(t.po)}">${t.po.toFixed(1)}%</td>
            <td class="num muted">${t.cup.toFixed(1)}%</td>
          </tr>`).join('')}</tbody>
        </table></div>
        <p class="muted small po-note">10,000 simulated seasons · model estimates</p>`;
    }
  } catch (e) {
    const msg = `<p class="muted">Couldn't run the simulation. Check your connection.</p>`;
    if (homeEl) homeEl.innerHTML = msg;
    if (fullEl) fullEl.innerHTML = msg;
  }
}
function playoffDonutSvg(teams) {
  const cx = 90, cy = 90, r = 62, sw = 24;
  const circ = 2 * Math.PI * r;
  const total = teams.reduce((a, t) => a + t.po, 0) || 1;
  let offset = 25; // start at top
  const segs = teams.map((t) => {
    const frac = t.po / total;
    const len = frac * circ;
    const color = TEAM_COLORS[t.abbr] || '#3adbe3';
    const s = `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${color}" stroke-width="${sw}" stroke-dasharray="${len.toFixed(1)} ${(circ - len).toFixed(1)}" stroke-dashoffset="${(-offset).toFixed(1)}" style="filter:drop-shadow(0 0 6px ${color})"/>`;
    offset += len;
    return s;
  }).join('');
  return `<svg class="po-donut" viewBox="0 0 180 180" width="180" height="180">
    <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="#1d2839" stroke-width="${sw}"/>
    ${segs}
    <text x="${cx}" y="${cy - 4}" text-anchor="middle" fill="#f2f5f9" font-size="15" font-weight="700">Make</text>
    <text x="${cx}" y="${cy + 14}" text-anchor="middle" fill="#f2f5f9" font-size="15" font-weight="700">Playoffs</text>
  </svg>`;
}
function oddsClass(p) {
  return p >= 85 ? 'odds-high' : p >= 60 ? 'odds-mid' : 'odds-low';
}
function renderHome() {
  renderHomePicks();
  renderHomeResults();
  renderHomeStandings();
  renderPlayoffOdds();
}
/* ---- Share: screenshot the current view ---- */
function ensureHtml2Canvas(cb) {
  if (window.html2canvas) return cb();
  const s = document.createElement('script');
  s.src = 'https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js';
  s.onload = cb;
  s.onerror = () => alert('Could not load screenshot tool. Try again.');
  document.head.appendChild(s);
}
async function shareCurrentView() {
  const btn = $('shareBtn');
  if (btn) btn.textContent = 'Capturing…';
  ensureHtml2Canvas(async () => {
    try {
      // capture the active view only
      const target = document.querySelector('.view.active') || document.body;
      const canvas = await html2canvas(target, { backgroundColor: '#070b12', scale: 2, useCORS: true });
      const blob = await new Promise((res) => canvas.toBlob(res, 'image/png'));
      const file = new File([blob], `bueno-sports-${state.view || 'home'}.png`, { type: 'image/png' });
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file], title: 'Bueno Sports' });
      } else {
        // fallback: download the image
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = file.name;
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 5000);
      }
    } catch (e) {
      alert('Screenshot failed. Try again.');
    }
    if (btn) btn.textContent = 'Share';
  });
}
const _shareBtn = $('shareBtn');
if (_shareBtn) _shareBtn.addEventListener('click', shareCurrentView);
/* Sport picker navigation */
(function initSportPicker() {
  const sel = document.getElementById('sportSelect');
  if (!sel) return;
  sel.addEventListener('change', () => {
    const v = sel.value;
    window.location.href = v + '.html';
  });
})();
