/* ============ Bueno Sports home (landing) — standalone ============
   Fills each sport card with a live one-liner. Every fetch is
   best-effort: on failure the card keeps its default line. */
(function () {
  const setLine = (id, txt) => {
    const el = document.getElementById(id);
    if (el && txt) el.textContent = txt;
  };
  const today = new Date();
  const ymd = (d) => `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  const isoDay = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

  // NHL: tonight's game count from the prebuilt slate bundle,
  // falling back to the live scoreboard through the site proxy.
  (async () => {
    let n = 0;
    try {
      const r = await fetch(`data/${isoDay(today)}.json`, { cache: 'no-store' });
      if (r.ok) { const d = await r.json(); n = (d.games || []).length; }
    } catch (e) { /* fall through */ }
    if (!n) {
      try {
        const r = await fetch(`/nhl-api/scoreboard/${isoDay(today)}`);
        if (r.ok) { const d = await r.json(); n = (d.games || []).length; }
      } catch (e) { /* keep default */ }
    }
    setLine('landNhlLine', n
      ? `${n} game${n === 1 ? '' : 's'} tonight · top picks, live board & Top Shelf`
      : 'Top picks, live board & Top Shelf');
  })();

  // NBA: games tonight (ESPN scoreboard, browser-local date)
  (async () => {
    try {
      const r = await fetch(`https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard?dates=${ymd(today)}`);
      const d = await r.json();
      const n = (d.events || []).length;
      if (n) setLine('landNbaLine', `${n} game${n === 1 ? '' : 's'} tonight · live board & standings`);
    } catch (e) { /* keep default line */ }
  })();

  // NFL: next game on the board (ESPN scoreboard)
  (async () => {
    try {
      const r = await fetch('https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard');
      const d = await r.json();
      const ev = (d.events || [])[0];
      if (ev) {
        const t = new Date(ev.date);
        const when = t.toLocaleDateString([], { weekday: 'short' }) + ' ' +
          t.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
        setLine('landNflLine', `${ev.shortName} · ${when}`);
      }
    } catch (e) { /* keep default line */ }
  })();

  // MLB: today's game, else tomorrow's (MLB Stats API)
  (async () => {
    try {
      const iso = (d) => d.toISOString().slice(0, 10);
      let r = await fetch(`https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=${iso(today)}`);
      let d = await r.json();
      let games = ((d.dates || [])[0] || {}).games || [];
      let dayLabel = 'Today';
      if (!games.length) {
        const tm = new Date(today.getTime() + 86400000);
        r = await fetch(`https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=${iso(tm)}`);
        d = await r.json();
        games = ((d.dates || [])[0] || {}).games || [];
        dayLabel = tm.toLocaleDateString([], { weekday: 'short' });
      }
      if (games.length) {
        const g = games[0];
        const t = new Date(g.gameDate);
        const when = t.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
        setLine('landMlbLine', `${g.teams.away.team.name} @ ${g.teams.home.team.name} · ${dayLabel} ${when}`);
      }
    } catch (e) { /* keep default line */ }
  })();
})();
