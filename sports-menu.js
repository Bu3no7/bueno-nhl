/* ============ Sports menu (hamburger) — shared by every page ============
   Any element with [data-sports-menu] opens a bottom sheet listing all
   six sports with their official league logos (Soccer, a seven-league
   section, uses the ball mark from its own page instead). Tapping one
   navigates to that sport's page. Emoji shows only if a logo fails. */
(function () {
  const SPORTS = [
    { key: 'nhl', name: 'Hockey', href: 'nhl.html', emoji: '🏒',
      logo: 'https://assets.nhle.com/logos/nhl/svg/NHL_light.svg' },
    { key: 'nba', name: 'Basketball', href: 'nba.html', emoji: '🏀',
      logo: 'https://a.espncdn.com/i/teamlogos/leagues/500/nba.png' },
    { key: 'mlb', name: 'Baseball', href: 'mlb.html', emoji: '⚾',
      logo: 'https://a.espncdn.com/i/teamlogos/leagues/500/mlb.png' },
    { key: 'nfl', name: 'Football', href: 'nfl.html', emoji: '🏈',
      logo: 'https://a.espncdn.com/i/teamlogos/leagues/500/nfl.png' },
    { key: 'ufc', name: 'UFC', href: 'ufc.html', emoji: '🥊', invert: true,
      logo: 'https://a.espncdn.com/i/teamlogos/leagues/500/ufc.png' },
    { key: 'soccer', name: 'Soccer', href: 'soccer.html', emoji: '⚽',
      svg: '<svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="#B9E356" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="8.6"/><path d="M12 8.4 15.4 10.9 14.1 14.9H9.9L8.6 10.9Z"/><path d="M12 8.4V4.9M15.4 10.9l3.3-1.1M14.1 14.9l2.1 2.8M9.9 14.9l-2.1 2.8M8.6 10.9 5.3 9.8"/></svg>' },
  ];
  const here = (location.pathname.split('/').pop() || 'index.html').toLowerCase();
  const isHome = here === '' || here === 'index.html';
  const currentKey = isHome ? null
    : (SPORTS.find((s) => s.href === here) || {}).key || null;

  const sheet = document.createElement('div');
  sheet.className = 'sports-sheet';
  sheet.hidden = true;
  sheet.setAttribute('role', 'dialog');
  sheet.setAttribute('aria-label', 'Choose a sport');
  sheet.innerHTML = `
    <div class="sports-backdrop"></div>
    <div class="sports-panel">
      <div class="sports-head">
        <span>Choose a sport</span>
        <button class="sports-close" type="button" aria-label="Close">&times;</button>
      </div>
      <a class="sports-row${isHome ? ' current' : ''}" href="index.html">
        <span class="sports-ico">⌂</span>
        <span class="sports-name">Home</span>
        ${isHome ? '<span class="sports-tag">You\'re here</span>' : '<span class="sports-arrow">›</span>'}
      </a>
      ${SPORTS.map((s) => `
      <a class="sports-row${s.key === currentKey ? ' current' : ''}" href="${s.href}">
        <span class="sports-ico">${s.svg ? s.svg : `<img src="${s.logo}" alt="" loading="lazy"${s.invert ? ' class="logo-invert"' : ''} onerror="this.parentNode.textContent='${s.emoji}'">`}</span>
        <span class="sports-name">${s.name}</span>
        ${s.key === currentKey ? '<span class="sports-tag">You\'re here</span>' : '<span class="sports-arrow">›</span>'}
      </a>`).join('')}
    </div>`;
  document.body.appendChild(sheet);

  const open = () => { sheet.hidden = false; document.body.classList.add('sheet-open'); };
  const close = () => { sheet.hidden = true; document.body.classList.remove('sheet-open'); };
  sheet.querySelector('.sports-backdrop').addEventListener('click', close);
  sheet.querySelector('.sports-close').addEventListener('click', close);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
  document.querySelectorAll('[data-sports-menu]').forEach((b) =>
    b.addEventListener('click', open));
})();
