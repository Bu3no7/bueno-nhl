/* ---------------- Video game goal animation ---------------- */
const GOAL_TYPE_STYLE = {
  EV: { label: 'EVEN STRENGTH', color: '#3adbe3' },
  PP: { label: 'POWER PLAY', color: '#ffd700' },
  SH: { label: 'SHORTHANDED', color: '#ff6b6b' },
  EN: { label: 'EMPTY NET', color: '#8a94a6' },
};
function playGoalAnimation(gl) {
  const takeover = document.getElementById('goalTakeover');
  const rinkPhase = document.getElementById('rinkPhase');
  const goalPhase = document.getElementById('goalPhase');
  if (!takeover) return;
  const cfg = GOAL_TYPE_STYLE[gl.type] || GOAL_TYPE_STYLE.EV;
  // Fill in scorer info
  const gtype = document.querySelector('.goal-text');
  gtype.style.textShadow = `0 0 40px ${cfg.color}, 0 4px 0 #000`;
  const badge = document.getElementById('goalTypeBadge');
  badge.textContent = cfg.label;
  badge.style.color = cfg.color;
  badge.style.border = `1px solid ${cfg.color}`;
  document.getElementById('goalScorerName').textContent = gl.scorer || '';
  // Team logos
  const homeLogo = document.getElementById('goalHomeLogo');
  const awayLogo = document.getElementById('goalAwayLogo');
  if (homeLogo) homeLogo.src = teamLogoUrl(gl.homeAbbr || gl.gameHome);
  if (awayLogo) awayLogo.src = teamLogoUrl(gl.awayAbbr || gl.gameAway);
  document.getElementById('goalScorerMeta').textContent =
    `${gl.team || ''} · ${gl.periodType === 'OT' ? 'OT' : 'P' + gl.period} ${gl.time || ''}` +
    (gl.assists && gl.assists.length ? ` · 🍎 ${gl.assists.join(', ')}` : '');
  document.getElementById('goalScoreText').textContent = ` ${gl.awayScore}–${gl.homeScore} `;
  const hs = gl.headshot || headshotUrl(gl.team, gl.scorerId);
  document.getElementById('goalScorerHs').src = hs;
  // Jersey numbers from pbp (works for yesterday's games too)
  document.getElementById('goalScorerNum').textContent = gl.scorerNum || '';
  // Show takeover: video intro first, then overlay
  takeover.classList.add('go');
  rinkPhase.classList.remove('hide');
  goalPhase.classList.remove('show');
  const vid = document.getElementById('goalIntroVid');
  if (vid) {
    vid.currentTime = 0;
    vid.play().catch(() => {});
    vid.onended = () => {
      rinkPhase.classList.add('hide');
      goalPhase.classList.add('show');
      setTimeout(() => takeover.classList.remove('go'), 3200);
    };
    // Fallback if video fails
    setTimeout(() => {
      if (!goalPhase.classList.contains('show')) {
        rinkPhase.classList.add('hide');
        goalPhase.classList.add('show');
        setTimeout(() => takeover.classList.remove('go'), 3200);
      }
    }, 6000);
  } else {
    animateGoalRink(gl, () => {
      rinkPhase.classList.add('hide');
      goalPhase.classList.add('show');
      setTimeout(() => takeover.classList.remove('go'), 3200);
    });
  }
}
function animateGoalRink(gl, onDone) {
  const canvas = document.getElementById('rinkAnim');
  const ctx = canvas.getContext('2d');
  const W = 420, H = 200;
  const netX = 389, netY = 100;
  // Map NHL coords to canvas
  const mapX = (x) => ((x + 100) / 200) * W;
  const mapY = (y) => ((y + 42) / 85) * H;
  const shotX = gl.x != null ? Math.max(0, Math.min(W - 30, mapX(gl.x))) : 200;
  const shotY = gl.y != null ? Math.max(20, Math.min(H - 20, mapY(gl.y))) : 100;
  function drawRink() {
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = '#0e1a2e'; ctx.fillRect(0, 0, W, H);
    ctx.strokeStyle = 'rgba(255,255,255,.15)'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(210, 0); ctx.lineTo(210, H); ctx.stroke();
    ctx.strokeStyle = 'rgba(58,150,255,.3)';
    ctx.beginPath(); ctx.moveTo(140, 0); ctx.lineTo(140, H); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(280, 0); ctx.lineTo(280, H); ctx.stroke();
    // Faceoff circles
    ctx.strokeStyle = 'rgba(255,80,80,.4)';
    ctx.beginPath(); ctx.arc(330, 45, 28, 0, Math.PI * 2); ctx.stroke();
    ctx.beginPath(); ctx.arc(330, 155, 28, 0, Math.PI * 2); ctx.stroke();
    // Crease + net
    ctx.fillStyle = 'rgba(100,150,255,.15)';
    ctx.beginPath(); ctx.arc(netX, netY, 22, -Math.PI/2.2, Math.PI/2.2); ctx.closePath(); ctx.fill();
    ctx.strokeStyle = '#ff4444'; ctx.lineWidth = 3;
    ctx.strokeRect(netX, 80, 8, 40);
  }
  const dur = 900, start = performance.now();
  (function frame(now) {
    const t = Math.min((now - start) / dur, 1);
    const e = t * t * t;
    const x = shotX + (netX - shotX) * e;
    const y = shotY + (netY - shotY) * e;
    drawRink();
    // Trail
    ctx.fillStyle = 'rgba(58,219,227,.3)';
    for (let i = 1; i <= 5; i++) {
      ctx.beginPath();
      ctx.arc(x - (x - shotX) * 0.08 * i, y - (y - shotY) * 0.08 * i, 5 - i * 0.7, 0, Math.PI * 2);
      ctx.fill();
    }
    // Puck
    ctx.fillStyle = '#111'; ctx.strokeStyle = '#3adbe3'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(x, y, 7, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    if (t < 1) requestAnimationFrame(frame);
    else { ctx.fillStyle = 'rgba(0,255,127,.35)'; ctx.fillRect(0, 0, W, H); setTimeout(onDone, 350); }
  })(start);
}
// Make goal type badges clickable to replay animation
document.addEventListener('click', (e) => {
  const badge = e.target.closest('.gtype-clickable');
  if (!badge || !badge._goal) return;
  playGoalAnimation(badge._goal);
});
