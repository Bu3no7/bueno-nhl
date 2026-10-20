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
  // Show takeover, run rink animation
  takeover.classList.add('go');
  rinkPhase.classList.remove('hide');
  goalPhase.classList.remove('show');
  animateGoalRink(gl, () => {
    rinkPhase.classList.add('hide');
    goalPhase.classList.add('show');
    setTimeout(() => takeover.classList.remove('go'), 3200);
  });
}
function animateGoalRink(gl, onDone) {
  // Camera-follow replay on a half-ice rink: the camera pushes in on the
  // shooter, rides with the puck (real pbp shot coords), the ice cracks
  // behind the shot, and the goal light behind the net strobes on the
  // goal — then the usual GOAL! overlay takes over (playGoalAnimation).
  const canvas = document.getElementById('rinkAnim');
  const ctx = canvas.getContext('2d');
  const W = 420, H = 200;          // viewport
  const WW = 360, WH = 300;        // world: half-ice
  const wx = (nx) => ((nx - 20) / 80) * WW;            // NHL x (attacking) -> world
  const wy = (ny) => ((ny + 42.5) / 85) * WH;          // NHL y -> world
  const netX = wx(89), netY = wy(0);
  // normalize direction: mirror left-end goals so the net is always right
  let gx = gl.x, gy = gl.y;
  if (gx != null && gx < 0) { gx = -gx; gy = -gy; }
  const shotX = gx != null ? Math.max(36, Math.min(netX - 24, wx(gx))) : 210;
  const shotY = gy != null ? Math.max(24, Math.min(WH - 24, wy(gy))) : 100;
  const TEAM = '#7fd4e8', OPP = '#31435f';
  const clampW = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const skaters = [
    { x: netX - 52, y: 104, num: '', color: OPP, ring: '#9fb7d9' },
    { x: netX - 42, y: 198, num: '', color: OPP, ring: '#9fb7d9' },
    { x: netX - 13, y: netY, num: '', color: '#e8ecf4', ring: '#ffd700', big: true },
  ];
  if (gl.assistNums && gl.assistNums[0]) skaters.push({ x: clampW(shotX - 48, 26, WW - 20), y: clampW(shotY - 58, 22, WH - 22), num: String(gl.assistNums[0]), color: TEAM, ring: '#e8fbff' });
  if (gl.assistNums && gl.assistNums[1]) skaters.push({ x: clampW(shotX - 84, 26, WW - 20), y: clampW(shotY + 44, 22, WH - 22), num: String(gl.assistNums[1]), color: TEAM, ring: '#e8fbff' });

  function jagged(x, y, ang, len, segs) {
    const pts = [[x, y]];
    let a = ang, cx = x, cy = y;
    for (let i = 0; i < segs; i++) {
      a += (Math.random() - 0.5) * 0.9;
      const step = (len / segs) * (0.6 + Math.random() * 0.7);
      cx += Math.cos(a) * step; cy += Math.sin(a) * step;
      pts.push([cx, cy]);
    }
    return pts;
  }
  let trailCracks = [], burstCracks = [], lightPhase = -1;
  function drawCracks(list, alpha) {
    ctx.save();
    ctx.strokeStyle = `rgba(220,240,255,${alpha})`;
    ctx.lineWidth = 1.6;
    ctx.shadowColor = 'rgba(160,220,255,.8)'; ctx.shadowBlur = 4;
    for (const pts of list) {
      ctx.beginPath();
      pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
      ctx.stroke();
    }
    ctx.restore();
  }
  function drawWorld() {
    ctx.fillStyle = '#0e1a2e'; ctx.fillRect(-80, -80, WW + 160, WH + 160);
    const rg = ctx.createRadialGradient(280, 150, 10, 280, 150, 320);
    rg.addColorStop(0, 'rgba(120,180,255,.16)'); rg.addColorStop(1, 'rgba(120,180,255,0)');
    ctx.fillStyle = rg; ctx.fillRect(0, 0, WW, WH);
    ctx.fillStyle = 'rgba(160,104,20,.16)';
    ctx.beginPath(); ctx.moveTo(netX, 126); ctx.lineTo(238, 74); ctx.lineTo(196, 74); ctx.lineTo(196, 226); ctx.lineTo(238, 226); ctx.lineTo(netX, 174); ctx.closePath(); ctx.fill();
    ctx.fillStyle = 'rgba(196,44,30,.26)'; ctx.fillRect(netX - 70, 116, 70, 68);
    ctx.strokeStyle = 'rgba(58,150,255,.8)'; ctx.lineWidth = 9;
    ctx.shadowColor = 'rgba(58,150,255,.8)'; ctx.shadowBlur = 8;
    ctx.beginPath(); ctx.moveTo(wx(25), 0); ctx.lineTo(wx(25), WH); ctx.stroke();
    ctx.shadowBlur = 0;
    ctx.strokeStyle = 'rgba(229,72,77,.75)'; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.moveTo(netX, 0); ctx.lineTo(netX, WH); ctx.stroke();
    for (const fy of [-22, 22]) {
      ctx.strokeStyle = 'rgba(255,80,80,.5)'; ctx.lineWidth = 2.5;
      ctx.beginPath(); ctx.arc(wx(69), wy(fy), 40, 0, Math.PI * 2); ctx.stroke();
      ctx.fillStyle = 'rgba(255,80,80,.85)';
      ctx.beginPath(); ctx.arc(wx(69), wy(fy), 5, 0, Math.PI * 2); ctx.fill();
    }
    ctx.fillStyle = 'rgba(94,200,248,.32)';
    ctx.beginPath(); ctx.arc(netX, netY, 30, -Math.PI / 2.2, Math.PI / 2.2); ctx.closePath(); ctx.fill();
    ctx.fillStyle = 'rgba(210,225,245,.12)';
    ctx.beginPath(); ctx.moveTo(netX, 120); ctx.lineTo(netX + 13, 126); ctx.lineTo(netX + 13, 174); ctx.lineTo(netX, 180); ctx.closePath(); ctx.fill();
    ctx.strokeStyle = '#ff4444'; ctx.lineWidth = 4;
    ctx.beginPath(); ctx.moveTo(netX, 120); ctx.lineTo(netX, 180); ctx.stroke();
    // goal light, centered behind the goal
    const lx = netX + 20, ly = netY;
    if (lightPhase >= 0) {
      if (lightPhase % 2 === 0) {
        const lg = ctx.createRadialGradient(lx, ly, 2, lx, ly, 54);
        lg.addColorStop(0, 'rgba(255,45,45,.95)'); lg.addColorStop(0.4, 'rgba(255,45,45,.45)'); lg.addColorStop(1, 'rgba(255,45,45,0)');
        ctx.fillStyle = lg; ctx.beginPath(); ctx.arc(lx, ly, 54, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = '#ff2d2d';
      } else ctx.fillStyle = '#7a1616';
      ctx.beginPath(); ctx.arc(lx, ly, 8, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,.5)'; ctx.lineWidth = 1.5; ctx.stroke();
    } else {
      ctx.fillStyle = 'rgba(255,60,60,.4)';
      ctx.beginPath(); ctx.arc(lx, ly, 7, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,.35)'; ctx.lineWidth = 1.5; ctx.stroke();
    }
    ctx.strokeStyle = 'rgba(235,242,255,.3)'; ctx.lineWidth = 4; ctx.strokeRect(2, 2, WW - 4, WH - 4);
  }
  function player(p) {
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,.5)'; ctx.shadowBlur = 6; ctx.shadowOffsetY = 3;
    ctx.fillStyle = p.color;
    ctx.beginPath(); ctx.arc(p.x, p.y, p.big ? 17 : 15, 0, Math.PI * 2); ctx.fill();
    ctx.shadowBlur = 0; ctx.shadowOffsetY = 0;
    ctx.lineWidth = 2.5; ctx.strokeStyle = p.ring; ctx.stroke();
    if (p.num) {
      ctx.fillStyle = '#fff'; ctx.font = '800 15px system-ui'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(p.num, p.x, p.y + 1);
    }
    ctx.restore();
  }
  const SETTLE = 550, FLIGHT = 800, CELEB = 950;
  const t0 = performance.now();
  let lastCrackAt = 0, burstDone = false, done = false;
  function cam(cx, cy, zoom) {
    const vw = W / zoom, vh = H / zoom;
    return { ox: Math.max(0, Math.min(WW - vw, cx - vw / 2)), oy: Math.max(0, Math.min(WH - vh, cy - vh / 2)), zoom };
  }
  (function frame(now) {
    const t = now - t0;
    let px, py, zoom, focusX, focusY;
    const released = t > SETTLE, scored = t > SETTLE + FLIGHT;
    if (!released) {
      const k = Math.min(t / SETTLE, 1), e = 1 - Math.pow(1 - k, 3);
      zoom = 1.2 + e * 0.65;
      focusX = 180 + (shotX - 180) * e; focusY = 150 + (shotY - 150) * e;
      px = shotX; py = shotY;
    } else if (!scored) {
      const ft = Math.min((t - SETTLE) / FLIGHT, 1), e = ft * ft * ft;
      px = shotX + (netX - shotX) * e; py = shotY + (netY - shotY) * e;
      zoom = 1.85 + Math.sin(ft * Math.PI) * 0.2;
      focusX = px; focusY = py;
      if (t - lastCrackAt > 85) {
        lastCrackAt = t;
        const baseAng = Math.atan2(netY - shotY, netX - shotX);
        trailCracks.push(jagged(px, py, baseAng + 2.4 + Math.random() * 0.8, 26, 4));
        trailCracks.push(jagged(px, py, baseAng - 2.4 - Math.random() * 0.8, 22, 4));
        if (Math.random() < 0.6) trailCracks.push(jagged(px, py, baseAng + Math.PI + (Math.random() - 0.5), 16, 3));
      }
    } else {
      px = netX; py = netY; zoom = 2.1; focusX = netX - 30; focusY = netY;
      lightPhase = Math.floor((t - SETTLE - FLIGHT) / 120);
      if (!burstDone) {
        burstDone = true;
        for (let i = 0; i < 11; i++) burstCracks.push(jagged(netX - 4, netY, (i / 11) * Math.PI * 2 + Math.random() * 0.4, 34 + Math.random() * 30, 5));
      }
    }
    const { ox, oy } = cam(focusX, focusY, zoom);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, W, H);
    ctx.setTransform(zoom, 0, 0, zoom, -ox * zoom, -oy * zoom);
    drawWorld();
    drawCracks(trailCracks, 0.75);
    drawCracks(burstCracks, 0.95);
    for (const s of skaters) player(s);
    player({ x: shotX, y: shotY + 24, num: gl.scorerNum ? String(gl.scorerNum) : '', color: TEAM, ring: '#fff' });
    ctx.fillStyle = '#111'; ctx.strokeStyle = '#3adbe3'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(px, py, 8, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    if (t < SETTLE + FLIGHT + CELEB) requestAnimationFrame(frame);
    else if (!done) { done = true; onDone(); }
  })(t0);
}
// Make goal type badges clickable to replay animation
document.addEventListener('click', (e) => {
  const badge = e.target.closest('.gtype-clickable');
  if (!badge || !badge._goal) return;
  playGoalAnimation(badge._goal);
});
