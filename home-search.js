/* ============ Bueno Sports home search ============
   Opened from the 🔍 button in the home top bar. Searches what the
   site has so far — mainly Hockey (tonight's slate rosters from the
   prebuilt bundle) and Basketball (tonight's teams' ESPN rosters) —
   plus the sport pages themselves. Tapping a player hands off to
   that sport's page via localStorage ('bueno-pending-open'), which
   the page reads on load to open the player's card directly. */
(function () {
  const overlay = document.getElementById('hsOverlay');
  const input = document.getElementById('hsInput');
  const clearBtn = document.getElementById('hsClear');
  const results = document.getElementById('hsResults');
  if (!overlay || !input || !results) return;

  const TEAM_FULL = {
    ANA: 'Anaheim Ducks', BOS: 'Boston Bruins', BUF: 'Buffalo Sabres',
    CGY: 'Calgary Flames', CAR: 'Carolina Hurricanes', CHI: 'Chicago Blackhawks',
    COL: 'Colorado Avalanche', CBJ: 'Columbus Blue Jackets', DAL: 'Dallas Stars',
    DET: 'Detroit Red Wings', EDM: 'Edmonton Oilers', FLA: 'Florida Panthers',
    LAK: 'Los Angeles Kings', MIN: 'Minnesota Wild', MTL: 'Montreal Canadiens',
    NSH: 'Nashville Predators', NJD: 'New Jersey Devils', NYI: 'New York Islanders',
    NYR: 'New York Rangers', OTT: 'Ottawa Senators', PHI: 'Philadelphia Flyers',
    PIT: 'Pittsburgh Penguins', SJS: 'San Jose Sharks', SEA: 'Seattle Kraken',
    STL: 'St. Louis Blues', TBL: 'Tampa Bay Lightning', TOR: 'Toronto Maple Leafs',
    UTA: 'Utah Mammoth', VAN: 'Vancouver Canucks', VGK: 'Vegas Golden Knights',
    WSH: 'Washington Capitals', WPG: 'Winnipeg Jets',
  };
  const SPORTS = [
    { name: 'Hockey — Center Ice', sub: 'Tonight’s slate, Top Shelf markets & parlay builder', href: 'nhl.html', keys: 'hockey nhl center ice top shelf slate' },
    { name: 'Basketball — The Fast Break', sub: 'Slate, Markets, In the Paint & parlay builder', href: 'nba.html', keys: 'basketball nba fast break slate markets' },
    { name: 'Baseball — The Dugout', sub: 'Home-run probabilities', href: 'mlb.html', keys: 'baseball mlb dugout home runs' },
    { name: 'Football', sub: 'Scores & standings', href: 'nfl.html', keys: 'football nfl scores standings' },
    { name: 'UFC', sub: 'Coming soon', href: 'ufc.html', keys: 'ufc mma fights' },
    { name: 'Soccer', sub: 'Coming soon', href: 'soccer.html', keys: 'soccer mls football' },
  ];
  const norm = (n) => (n || '').normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const esc = (t) => String(t == null ? '' : t).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const isoDay = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const ymd = (d) => isoDay(d).replace(/-/g, '');

  let nhlPlayers = [];   // {pid, name, team, teamFull, pos, gameId}
  let nbaPlayers = [];   // {pid, name, teamName, pos}
  let loadStarted = false;
  let loading = false;

  async function loadNhl() {
    for (const offset of [0, -1]) {
      try {
        const day = new Date(Date.now() + offset * 86400000);
        const r = await fetch(`data/${isoDay(day)}.json`, { cache: 'no-store' });
        if (!r.ok) continue;
        const d = await r.json();
        const gameByTeam = {};
        for (const g of d.games || []) {
          gameByTeam[g.away] = g.id;
          gameByTeam[g.home] = g.id;
        }
        const out = [];
        for (const [team, ros] of Object.entries(d.rosters || {})) {
          for (const grp of ['forwards', 'defensemen']) {
            for (const p of ros[grp] || []) {
              const name = `${(p.firstName || {}).default || ''} ${(p.lastName || {}).default || ''}`.trim();
              if (!name) continue;
              out.push({
                pid: p.id, name, team, teamFull: TEAM_FULL[team] || team,
                pos: p.positionCode || '', gameId: gameByTeam[team] || null,
              });
            }
          }
        }
        if (out.length) { nhlPlayers = out; return; }
      } catch (e) { /* try the next day / give up quietly */ }
    }
  }

  async function loadNba() {
    try {
      const r = await fetch(`https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard?dates=${ymd(new Date())}`);
      if (!r.ok) return;
      const d = await r.json();
      const teams = new Map();
      for (const ev of d.events || []) {
        for (const comp of ((ev.competitions || [])[0] || {}).competitors || []) {
          const t = comp.team || {};
          if (t.id && !teams.has(t.id)) teams.set(t.id, t.displayName || t.name || '');
        }
      }
      const lists = await Promise.all([...teams.entries()].map(async ([tid, tname]) => {
        try {
          const rr = await fetch(`https://site.api.espn.com/apis/site/v2/sports/basketball/nba/teams/${tid}/roster`);
          if (!rr.ok) return [];
          const rd = await rr.json();
          return (rd.athletes || []).map((a) => ({
            pid: String(a.id),
            name: a.displayName || a.fullName || '',
            teamName: tname,
            pos: (a.position || {}).abbreviation || '',
          })).filter((p) => p.name);
        } catch (e) { return []; }
      }));
      nbaPlayers = lists.flat();
    } catch (e) { /* group just stays empty */ }
  }

  async function ensureLoaded() {
    if (loadStarted) return;
    loadStarted = true;
    loading = true;
    await Promise.all([loadNhl(), loadNba()]);
    loading = false;
    render();
  }

  function groupHtml(title, rows) {
    if (!rows.length) return '';
    return `<div class="ci-group"><h4>${esc(title)}</h4>${rows.join('')}</div>`;
  }
  function rowHtml(main, sub, badge, badgeClass, dataAttrs) {
    return `<button class="ci-row" type="button" ${dataAttrs}>` +
      `<span>${esc(main)}${sub ? ` <span class="act">${esc(sub)}</span>` : ''}</span>` +
      (badge ? `<span class="pct${badgeClass ? ' ' + badgeClass : ''}">${esc(badge)}</span>` : '') +
      `</button>`;
  }

  function render() {
    const q = norm(input.value);
    clearBtn.classList.toggle('show', !!input.value);
    if (!q) {
      results.innerHTML = '<p class="ci-empty">Start typing — try “Draisaitl”, “Jokić” or “Basketball”.</p>';
      return;
    }
    const match = (text) => norm(text).includes(q);
    let html = '';
    const nhl = nhlPlayers.filter((p) => match(p.name) || match(p.teamFull) || match(p.team)).slice(0, 5);
    html += groupHtml('Hockey Players', nhl.map((p) =>
      rowHtml(p.name, p.teamFull, p.pos, '', `data-kind="nhl" data-pid="${p.pid}" data-game="${p.gameId || ''}"`)));
    const nba = nbaPlayers.filter((p) => match(p.name) || match(p.teamName)).slice(0, 5);
    html += groupHtml('Basketball Players', nba.map((p) =>
      rowHtml(p.name, p.teamName, p.pos, 'orange', `data-kind="nba" data-pid="${p.pid}"`)));
    const sports = SPORTS.filter((sp) => match(sp.name) || match(sp.keys)).slice(0, 5);
    html += groupHtml('Sports', sports.map((sp) =>
      rowHtml(sp.name, sp.sub, '', '', `data-kind="sport" data-href="${sp.href}"`)));
    if (!html) {
      html = loading
        ? '<p class="ci-empty">Loading tonight’s players…</p>'
        : '<p class="ci-empty">No matches on Bueno Sports yet.</p>';
    } else if (loading && (!nhlPlayers.length || !nbaPlayers.length)) {
      html += '<p class="ci-empty">Still loading tonight’s players…</p>';
    }
    results.innerHTML = html;
    results.querySelectorAll('.ci-row').forEach((b) => b.addEventListener('click', () => go(b)));
  }

  function go(b) {
    const kind = b.dataset.kind;
    if (kind === 'sport') { location.href = b.dataset.href; return; }
    const payload = kind === 'nhl'
      ? { type: 'nhl', pid: Number(b.dataset.pid), gameId: b.dataset.game ? Number(b.dataset.game) : null, ts: Date.now() }
      : { type: 'nba', pid: String(b.dataset.pid), ts: Date.now() };
    try { localStorage.setItem('bueno-pending-open', JSON.stringify(payload)); } catch (e) { /* still navigate */ }
    location.href = kind === 'nhl' ? 'nhl.html' : 'nba.html';
  }

  function open() {
    overlay.hidden = false;
    document.body.classList.add('sheet-open');
    render();
    ensureLoaded();
    setTimeout(() => input.focus(), 30);
  }
  function close() {
    overlay.hidden = true;
    document.body.classList.remove('sheet-open');
  }
  document.getElementById('hsOpenBtn').addEventListener('click', open);
  document.getElementById('hsCancel').addEventListener('click', close);
  clearBtn.addEventListener('click', () => { input.value = ''; render(); input.focus(); });
  input.addEventListener('input', render);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      const first = results.querySelector('.ci-row');
      if (first) { e.preventDefault(); go(first); }
    }
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !overlay.hidden) close(); });
})();
