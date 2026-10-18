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
    return `<div class="pick-row" data-pid="${r.pid}" data-gid="${r.gameId}" role="button" tabindex="0">
      <img class="pick-head" src="${esc(r.headshot || '')}" alt="" ${imgFallback}>
      <div><div class="pick-name">${esc(r.name)}</div>
      <div class="pick-meta">${esc(r.team)} · ${esc(matchup)} · ${r.goals}G</div></div>
      <div class="pick-prob">${pct1(r.p)}</div>
    </div>`;
  }).join('');
}
/* ---- Home: yesterday's results (placeholder — graded data is local-only) ---- */
function renderHomeResults() {
  const el = $('homeResultsBody');
  if (!el) return;
  el.innerHTML = `<p class="muted">Results post after last night's games.</p>`;
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
    const cell = (p) => `<div class="lu-cell"><span>${esc(p.firstName?.default || '')} ${esc(p.lastName?.default || '')}</span><span class="muted small">${esc(p.positionCode || '')}</span></div>`;
    let html = `<div class="lu-team"><div class="lu-teamhead">${esc(teamFullName(abbr))} — roster</div>`;
    if (fwds.length) html += `<div class="lu-row"><div class="lu-label">F</div><div class="lu-players">${fwds.map(cell).join('')}</div></div>`;
    if (defs.length) html += `<div class="lu-row"><div class="lu-label">D</div><div class="lu-players">${defs.map(cell).join('')}</div></div>`;
    if (goalies.length) html += `<div class="lu-row"><div class="lu-label">G</div><div class="lu-players">${goalies.map(cell).join('')}</div></div>`;
    bodyEl.innerHTML = html + '</div>';
  } catch (e) {
    bodyEl.innerHTML = `<p class="muted">Roster unavailable right now.</p>`;
  }
}
/* ---- Playoff odds: donut + table (placeholder data, final visual) ---- */
const ODDS_PREVIEW = [
  { abbr: 'CAR', po: 96.5, cup: 10.3 }, { abbr: 'VGK', po: 94.4, cup: 8.3 },
  { abbr: 'COL', po: 92.5, cup: 8.4 }, { abbr: 'MIN', po: 88.1, cup: 5.2 },
  { abbr: 'EDM', po: 84.7, cup: 7.1 }, { abbr: 'TBL', po: 82.3, cup: 4.8 },
  { abbr: 'DAL', po: 80.9, cup: 5.9 }, { abbr: 'FLA', po: 78.4, cup: 4.1 },
];
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
function renderPlayoffOdds() {
  const homeEl = $('homeOddsBody');
  if (homeEl) {
    homeEl.innerHTML = `
      <div class="po-donut-wrap">${playoffDonutSvg(ODDS_PREVIEW.slice(0, 8))}</div>
      <div class="po-legend">${ODDS_PREVIEW.slice(0, 4).map((t) => {
        const color = TEAM_COLORS[t.abbr] || '#3adbe3';
        return `<div class="legend-item"><div class="legend-dot" style="background:${color};box-shadow:0 0 6px ${color}"></div>${esc(t.abbr)} ${t.po.toFixed(1)}%</div>`;
      }).join('')}</div>
      <button class="ghost-btn" id="homeOddsMore" type="button">Full odds &rarr;</button>
      <p class="muted small po-note">Preview — live simulation coming soon.</p>`;
    const more = $('homeOddsMore');
    if (more) more.addEventListener('click', () => setView('playoffodds'));
  }
  const fullEl = $('oddsBody');
  if (fullEl) {
    fullEl.innerHTML = `
      <div class="po-donut-wrap">${playoffDonutSvg(ODDS_PREVIEW)}</div>
      <div class="table-wrap"><table class="odds-table">
        <thead><tr><th>Team</th><th class="num">Playoffs</th><th class="num">Cup</th></tr></thead>
        <tbody>${ODDS_PREVIEW.map((t) => `<tr class="team-row" data-team="${esc(t.abbr)}" role="button" tabindex="0">
          <td>${teamLogoCell(t.abbr)}</td>
          <td class="num ${oddsClass(t.po)}">${t.po.toFixed(1)}%</td>
          <td class="num muted">${t.cup.toFixed(1)}%</td>
        </tr>`).join('')}</tbody>
      </table></div>
      <p class="muted small po-note">Preview data — live season simulation coming soon.</p>`;
  }
}
function renderHome() {
  renderHomePicks();
  renderHomeResults();
  renderHomeStandings();
  renderPlayoffOdds();
}