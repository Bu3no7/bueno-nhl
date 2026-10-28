/* ---------------- Video game goal animation ---------------- */
/* Rink replay edition: the goal takeover keeps its overlay (scorer
   banner, team logos, headshot, horn), but the animation inside is a
   top-down rink replay in Bueno style — dark ice, glowing team-color
   dots with jersey numbers, attack going left like the reference replay.
   The play runs smooth, not quick: dots fade in at the faceoff, glide
   on curved paths into the zone, the puck rides with the scorer, then
   flies from the real pbp shot spot into the net, where a buzzer-red
   goal light behind the net lights up with the horn.
   Real anchors from the pbp: faceoff at center, shot spot, net, scorer,
   assists, goalie. The skaters' glide paths between those anchors are
   staged — the public feed doesn't carry full player tracking.
   Used by live scorer rows AND the Yesterday's results recap — both
   call playGoalAnimation. */
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
  const canvas = document.getElementById('rinkAnim');
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  // --- team colors (TEAM_COLORS lives in app.js, loaded before this file) ---
  const TC = (typeof TEAM_COLORS !== 'undefined') ? TEAM_COLORS : {};
  const scorerCol = TC[gl.team] || '#7fd4e8';
  const home = gl.homeAbbr || gl.gameHome || '', away = gl.awayAbbr || gl.gameAway || '';
  const oppAbbr = gl.team === home ? away : gl.team === away ? home : '';
  const oppCol = TC[oppAbbr] || '#31435f';
  // number ink: dark on light team colors (e.g. LAK silver), white otherwise
  function numInk(hex) {
    const m = /^#([0-9a-f]{6})$/i.exec(hex || '');
    if (!m) return '#fff';
    const r = parseInt(m[1].slice(0, 2), 16), g = parseInt(m[1].slice(2, 4), 16), b = parseInt(m[1].slice(4, 6), 16);
    return (0.299 * r + 0.587 * g + 0.114 * b) > 150 ? '#111' : '#fff';
  }
  // glow ink: lighten dark team colors so dots read on dark ice
  function glowCol(hex) {
    const m = /^#([0-9a-f]{6})$/i.exec(hex || '');
    if (!m) return '#7fd4e8';
    const r = parseInt(m[1].slice(0, 2), 16), g = parseInt(m[1].slice(2, 4), 16), b = parseInt(m[1].slice(4, 6), 16);
    const lum = 0.299 * r + 0.587 * g + 0.114 * b;
    if (lum > 90) return hex;
    const f = 1.7;
    const mix = (v) => Math.min(255, Math.round(v * f + 40));
    return `rgb(${mix(r)},${mix(g)},${mix(b)})`;
  }

  // --- shot spot from real pbp coords, mirrored into attacking frame (goal at +89) ---
  let gx = gl.x, gy = gl.y;
  if (gx != null && gx < 0) { gx = -gx; gy = -gy; }
  const shot = (gx != null && gy != null)
    ? { x: clamp(gx, 25, 86), y: clamp(gy, -38, 38) }
    : { x: 60, y: -15 };
  // Attack goes LEFT on canvas, like the reference replay: +89 (goal) -> left edge.
  const mapX = (x) => W - ((x + 100) / 200) * W;
  const mapY = (y) => ((y + 42) / 84) * H;

  // --- skaters: scorer ends at the real shot spot; assists + fillers stage around it ---
  const CX = (v, lo, hi) => clamp(v, lo, hi);
  const skaters = [
    { num: gl.scorerNum ? String(gl.scorerNum) : '', col: scorerCol, x0: 0, y0: 0, x1: shot.x, y1: shot.y, star: true },
    { num: (gl.assistNums && gl.assistNums[0]) ? String(gl.assistNums[0]) : '', col: scorerCol, x0: -10, y0: 12, x1: CX(shot.x - 25, 25, 85), y1: CX(shot.y + 22, -38, 38) },
    { num: (gl.assistNums && gl.assistNums[1]) ? String(gl.assistNums[1]) : '', col: scorerCol, x0: -10, y0: -12, x1: CX(shot.x - 30, 25, 85), y1: CX(shot.y - 20, -38, 38) },
    { num: '', col: scorerCol, x0: 8, y0: 16, x1: 55, y1: 10 },
    { num: '', col: scorerCol, x0: 8, y0: -16, x1: 70, y1: 8 },
    { num: '', col: oppCol, x0: 84, y0: 0, x1: 84, y1: 0, goalie: true },
    { num: '', col: oppCol, x0: 60, y0: -10, x1: 74, y1: -14 },
    { num: '', col: oppCol, x0: 60, y0: 10, x1: 74, y1: 14 },
    { num: '', col: oppCol, x0: 40, y0: 0, x1: 60, y1: 0 },
  ];
  // Gentle curve per skater so the skate arcs instead of running on rails.
  skaters.forEach((s, i) => {
    const dx = s.x1 - s.x0, dy = s.y1 - s.y0, len = Math.hypot(dx, dy) || 1;
    const bend = (i % 2 === 0 ? 1 : -1) * (6 + (i % 3) * 4);
    s.cx = (s.x0 + s.x1) / 2 + (-dy / len) * bend;
    s.cy = (s.y0 + s.y1) / 2 + (dx / len) * bend;
    s.delay = i * 0.12;
  });

  // --- timeline (seconds): smooth, not quick — same pacing as the approved draft ---
  const FADE_IN = 1.4, GLIDE_START = 1.4, GLIDE_DUR = 6.0;
  const PUCK_AT = 8.0, PUCK_DUR = 1.0, GOAL_AT = 9.0, RINK_END = 10.2;
  function smooth(t) { t = Math.max(0, Math.min(1, t)); return t * t * t * (t * (t * 6 - 15) + 10); }
  function quad(p0, p1, p2, t) {
    const u = 1 - t;
    return { x: u * u * p0.x + 2 * u * t * p1.x + t * t * p2.x,
             y: u * u * p0.y + 2 * u * t * p1.y + t * t * p2.y };
  }
  function skaterPos(s, t) {
    const local = (t - GLIDE_START - s.delay) / GLIDE_DUR;
    if (local <= 0) return { x: s.x0, y: s.y0 };
    return quad({ x: s.x0, y: s.y0 }, { x: s.cx, y: s.cy }, { x: s.x1, y: s.y1 }, smooth(local));
  }

  function drawRink() {
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = '#0a1e33'; ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = 'rgba(120,180,230,0.05)';
    ctx.beginPath(); ctx.ellipse(W / 2, H * 0.3, W * 0.48, H * 0.28, 0, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = '#c23b3b'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(mapX(89), 0); ctx.lineTo(mapX(89), H); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(mapX(-89), 0); ctx.lineTo(mapX(-89), H); ctx.stroke();
    ctx.strokeStyle = '#3b82c4'; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.moveTo(mapX(25), 0); ctx.lineTo(mapX(25), H); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(mapX(-25), 0); ctx.lineTo(mapX(-25), H); ctx.stroke();
    ctx.strokeStyle = 'rgba(194,59,59,0.85)'; ctx.lineWidth = 1.5; ctx.setLineDash([5, 5]);
    ctx.beginPath(); ctx.moveTo(mapX(0), 0); ctx.lineTo(mapX(0), H); ctx.stroke();
    ctx.setLineDash([]);
    ctx.strokeStyle = 'rgba(220,80,80,0.8)'; ctx.lineWidth = 1.5;
    for (const [fx, fy] of [[69, 22], [69, -22], [-69, 22], [-69, -22]]) {
      ctx.beginPath(); ctx.arc(mapX(fx), mapY(fy), 13, 0, Math.PI * 2); ctx.stroke();
      ctx.fillStyle = 'rgba(220,80,80,0.9)';
      ctx.beginPath(); ctx.arc(mapX(fx), mapY(fy), 2, 0, Math.PI * 2); ctx.fill();
    }
    ctx.beginPath(); ctx.arc(mapX(0), mapY(0), 13, 0, Math.PI * 2); ctx.stroke();
    ctx.strokeStyle = '#d7e3f4'; ctx.lineWidth = 2;
    ctx.strokeRect(mapX(89) - 4, mapY(0) - 9, 6, 18);
    ctx.strokeRect(mapX(-89) - 2, mapY(0) - 9, 6, 18);
    // buzzer-red goal light housing behind the attacking net (lit at GOAL_AT)
    ctx.beginPath(); ctx.arc(mapX(89) - 14, mapY(0), 7, 0, Math.PI * 2);
    ctx.fillStyle = '#2a0d0d'; ctx.fill();
    ctx.strokeStyle = '#5a2020'; ctx.lineWidth = 1.5; ctx.stroke();
    // faint gold slot wash
    ctx.fillStyle = 'rgba(255,215,106,0.07)';
    ctx.beginPath();
    ctx.moveTo(mapX(89), mapY(-9)); ctx.lineTo(mapX(69), mapY(-22)); ctx.lineTo(mapX(54), mapY(-22));
    ctx.lineTo(mapX(54), mapY(22)); ctx.lineTo(mapX(69), mapY(22)); ctx.lineTo(mapX(89), mapY(9));
    ctx.closePath(); ctx.fill();
  }

  function drawDot(s, pos, alpha) {
    const cx = mapX(pos.x), cy = mapY(pos.y);
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.beginPath(); ctx.arc(cx, cy, s.goalie ? 11 : 10, 0, Math.PI * 2);
    ctx.fillStyle = s.col;
    ctx.shadowColor = glowCol(s.col);
    ctx.shadowBlur = s.star ? 14 : 8;
    ctx.fill(); ctx.shadowBlur = 0;
    ctx.strokeStyle = 'rgba(255,255,255,.85)'; ctx.lineWidth = 1.5; ctx.stroke();
    if (s.num) {
      ctx.fillStyle = numInk(s.col); ctx.font = 'bold 9px system-ui';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(s.num, cx, cy);
    }
    ctx.restore();
  }

  // goal horn, guarded (takeover is click-triggered, so audio is allowed)
  let hornDone = false;
  function horn() {
    if (hornDone) return; hornDone = true;
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      const ac = new AC();
      if (ac.state === 'suspended') ac.resume();
      const t = ac.currentTime;
      [196, 147].forEach(f => {
        const o = ac.createOscillator(), g = ac.createGain();
        o.type = 'sawtooth'; o.frequency.value = f;
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(0.07, t + 0.05);
        g.gain.setValueAtTime(0.07, t + 0.8);
        g.gain.exponentialRampToValueAtTime(0.0001, t + 1.1);
        o.connect(g); g.connect(ac.destination);
        o.start(t); o.stop(t + 1.1);
      });
    } catch (e) { /* visuals carry it */ }
  }

  const t0 = performance.now();
  let done = false, hornPlayed = false, trail = [];

  function draw(t) {
    drawRink();
    const fade = Math.min(1, t / FADE_IN);
    let kap = null;
    for (const s of skaters) {
      const pos = skaterPos(s, t);
      if (s.star) kap = pos;
      drawDot(s, pos, fade);
    }
    // Puck: rides with the scorer through the glide, then flies to the net with a fading trail.
    let puck;
    if (t < PUCK_AT) { puck = kap; }
    else if (t < PUCK_AT + PUCK_DUR) {
      const k = 1 - Math.pow(1 - Math.min(1, (t - PUCK_AT) / PUCK_DUR), 2);
      puck = { x: kap.x + (89 - kap.x) * k, y: kap.y + (0 - kap.y) * k };
    } else { puck = { x: 89, y: 0 }; }
    if (t >= PUCK_AT && t < GOAL_AT + 0.4) {
      trail.push({ x: puck.x, y: puck.y });
      if (trail.length > 16) trail.shift();
    }
    ctx.save();
    trail.forEach((p, i) => {
      ctx.globalAlpha = (i / trail.length) * 0.5;
      ctx.beginPath(); ctx.arc(mapX(p.x), mapY(p.y), 2.5, 0, Math.PI * 2);
      ctx.fillStyle = '#ffffff'; ctx.fill();
    });
    ctx.restore();
    ctx.beginPath(); ctx.arc(mapX(puck.x), mapY(puck.y), 3.5, 0, Math.PI * 2);
    ctx.fillStyle = '#0b0f14'; ctx.shadowColor = '#fff'; ctx.shadowBlur = 6; ctx.fill(); ctx.shadowBlur = 0;

    if (t >= GOAL_AT) {
      if (!hornPlayed) { hornPlayed = true; horn(); }
      const pulse = 0.5 + 0.5 * Math.sin((t - GOAL_AT) * 2.5); // gentle pulse, not a strobe
      ctx.fillStyle = `rgba(255,215,106,${0.10 + 0.08 * pulse})`;
      ctx.fillRect(mapX(89) - 30, 0, 30, H);
      // buzzer-red goal light: bright red beacon behind the net, on with the horn
      const lx = mapX(89) - 14, ly = mapY(0);
      ctx.save();
      ctx.globalAlpha = 0.20 + 0.12 * pulse;
      ctx.beginPath(); ctx.arc(lx, ly, 20, 0, Math.PI * 2);
      ctx.fillStyle = '#ff2222'; ctx.fill();
      ctx.globalAlpha = 1;
      ctx.beginPath(); ctx.arc(lx, ly, 7, 0, Math.PI * 2);
      ctx.fillStyle = '#ff2a2a'; ctx.shadowColor = '#ff2222'; ctx.shadowBlur = 22; ctx.fill(); ctx.shadowBlur = 0;
      ctx.restore();
    }
  }

  (function frame(now) {
    const t = (now - t0) / 1000;
    draw(t);
    if (t < RINK_END) requestAnimationFrame(frame);
    else if (!done) { done = true; onDone(); }
  })(t0);
}
// Make goal type badges clickable to replay animation
document.addEventListener('click', (e) => {
  const badge = e.target.closest('.gtype-clickable');
  if (!badge || !badge._goal) return;
  playGoalAnimation(badge._goal);
});
