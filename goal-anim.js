/* ---------------- Video game goal animation ---------------- */
/* Air-hockey table edition: the rink is a glossy air-hockey table with
   rails and a goal slot. The camera pans into the table, then tracks the
   puck from the real pbp shot spot into the slot. Players are numbered
   discs in their team colors, and a buzzer box on top of the slot flashes
   (with a horn) when the puck goes in. Used by live scorer rows AND the
   Yesterday's results recap — both call playGoalAnimation. */
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
  const F = W * 0.76;
  const SIN = Math.sin(0.44), COS = Math.cos(0.44);
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

  // --- shot spot from real pbp coords (mirrored so the slot is always far) ---
  let gx = gl.x, gy = gl.y;
  if (gx != null && gx < 0) { gx = -gx; gy = -gy; }
  const start = (gx != null && gy != null)
    ? { x: clamp((gy / 42.5) * 100, -90, 90), z: clamp(20 + ((gx + 100) / 200) * 285, 180, 282) }
    : { x: -48, z: 238 };
  const goal = { x: 0, z: 296 };

  let cam = { x: 60, z: -40, h: 170 };
  function project(x, z, h) {
    const dx = x - cam.x, dz = z - cam.z;
    const fwd = dz * COS + (cam.h - h) * SIN;
    if (fwd < 25) return null;
    const right = dx, up = dz * SIN + (h - cam.h) * COS;
    return { sx: W / 2 + right * F / fwd, sy: H * 0.52 - up * F / fwd, s: F / fwd };
  }
  const poly = (pts, fill, stroke, w) => {
    if (pts.some(p => !p)) return;
    ctx.beginPath(); ctx.moveTo(pts[0].sx, pts[0].sy);
    pts.slice(1).forEach(p => ctx.lineTo(p.sx, p.sy)); ctx.closePath();
    if (fill) { ctx.fillStyle = fill; ctx.fill(); }
    if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = w || 2; ctx.stroke(); }
  };
  const seg = (a, b, col, w) => {
    if (!a || !b) return;
    ctx.beginPath(); ctx.moveTo(a.sx, a.sy); ctx.lineTo(b.sx, b.sy);
    ctx.strokeStyle = col; ctx.lineWidth = w || 2; ctx.stroke();
  };
  const circle3d = (cx, cz, r, col, w) => {
    ctx.beginPath();
    for (let i = 0; i <= 40; i++) {
      const a = i / 40 * Math.PI * 2;
      const p = project(cx + Math.cos(a) * r, cz + Math.sin(a) * r * 1.6, 0);
      if (!p) return;
      i === 0 ? ctx.moveTo(p.sx, p.sy) : ctx.lineTo(p.sx, p.sy);
    }
    ctx.strokeStyle = col; ctx.lineWidth = w || 2; ctx.stroke();
  };

  // players: scorer + assists in scorer-team colors, goalie + defender in opp colors
  const skaters = [
    { x: 0, z: 282, num: '', col: oppCol, big: true },
    { x: -26, z: 266, num: '', col: oppCol },
  ];
  if (gl.assistNums && gl.assistNums[0]) skaters.push({ x: clamp(start.x + 40, -90, 90), z: clamp(start.z - 40, 60, 280), num: String(gl.assistNums[0]), col: scorerCol });
  if (gl.assistNums && gl.assistNums[1]) skaters.push({ x: clamp(start.x - 52, -90, 90), z: clamp(start.z - 26, 60, 280), num: String(gl.assistNums[1]), col: scorerCol });
  function disc(p, shake) {
    const pr = project(p.x, p.z, 0);
    if (!pr) return;
    const r = Math.max(6, 11 * pr.s);
    ctx.beginPath(); ctx.ellipse(pr.sx + shake, pr.sy + r * 0.9 + shake, r * 0.95, r * 0.32, 0, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(0,0,0,.25)'; ctx.fill();
    ctx.beginPath(); ctx.arc(pr.sx + shake, pr.sy + shake, r, 0, Math.PI * 2);
    ctx.fillStyle = p.col; ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,.85)'; ctx.lineWidth = 1.5; ctx.stroke();
    ctx.beginPath(); ctx.ellipse(pr.sx - r * 0.35 + shake, pr.sy - r * 0.4 + shake, r * 0.4, r * 0.22, -0.6, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255,255,255,.28)'; ctx.fill();
    if (p.num) {
      ctx.fillStyle = numInk(p.col); ctx.font = `800 ${Math.max(8, r * 0.95)}px system-ui`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(p.num, pr.sx + shake, pr.sy + shake + 1);
    }
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

  const PAN = 1200, FLIGHT = 800, CELEB = 900;
  const easeIO = t => t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
  const easeOut = t => 1 - Math.pow(1 - t, 3);
  const lerp = (a, b, t) => a + (b - a) * t;
  const t0 = performance.now();
  let done = false, buzzed = false;

  function draw(t) {
    ctx.clearRect(0, 0, W, H);
    let px = start.x, pz = start.z;
    if (t < PAN) {
      const k = easeIO(t / PAN);
      cam.x = lerp(60, start.x * 0.55, k);
      cam.z = lerp(-40, start.z - 135, k);
      cam.h = lerp(170, 95, k);
    } else {
      const st = Math.min((t - PAN) / FLIGHT, 1), e = easeOut(st);
      px = start.x + (goal.x - start.x) * e;
      pz = start.z + (goal.z - start.z) * e;
      cam.x = px * 0.55; cam.z = pz - 135; cam.h = 95;
    }
    const scored = t >= PAN + FLIGHT;
    const shake = scored ? (Math.random() - 0.5) * 5 : 0;

    // table slab side
    poly([project(-122, 20, 0), project(122, 20, 0), project(122, 20, -26), project(-122, 20, -26)], '#101820', null);
    // glossy playfield
    const top = [[-110, 20], [110, 20], [110, 305], [-110, 305]].map(p => project(p[0], p[1], 0));
    if (top.every(Boolean)) {
      const g = ctx.createLinearGradient(0, top[0].sy, 0, top[2].sy);
      g.addColorStop(0, '#f7fafc'); g.addColorStop(0.55, '#dbe8f0'); g.addColorStop(1, '#c2d5e2');
      ctx.beginPath(); ctx.moveTo(top[0].sx, top[0].sy);
      top.slice(1).forEach(p => ctx.lineTo(p.sx, p.sy)); ctx.closePath();
      ctx.fillStyle = g; ctx.fill();
      ctx.strokeStyle = 'rgba(90,120,150,.6)'; ctx.lineWidth = 1.5; ctx.stroke();
    }
    // air holes
    for (let gx2 = -100; gx2 <= 100; gx2 += 20) {
      for (let gz = 30; gz <= 300; gz += 22) {
        const p = project(gx2, gz, 0);
        if (!p) continue;
        ctx.beginPath(); ctx.arc(p.sx + shake, p.sy + shake, Math.max(0.7, 1.1 * p.s), 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(90,120,140,.35)'; ctx.fill();
      }
    }
    // markings
    seg(project(-110, 160, 0), project(110, 160, 0), 'rgba(220,40,50,.9)', 3);
    seg(project(-110, 292, 0), project(110, 292, 0), 'rgba(40,110,220,.8)', 2);
    circle3d(start.x, start.z, 20, 'rgba(220,40,50,.65)', 2);
    circle3d(0, 160, 26, 'rgba(40,110,220,.55)', 2);
    // goal slot
    poly([project(-14, 296, 0), project(26, 296, 0), project(26, 308, 0), project(-14, 308, 0)], '#0a0f16', null);
    // rails (gap left at the slot)
    const rail = (ptsTop, ptsSide) => {
      poly(ptsTop, '#e11d2e', 'rgba(255,255,255,.35)', 1);
      poly(ptsSide, '#7f0f1a', null);
    };
    rail(
      [project(-124, 20, 18), project(-104, 20, 18), project(-104, 305, 18), project(-124, 305, 18)],
      [project(-124, 20, 18), project(-124, 305, 18), project(-124, 305, 0), project(-124, 20, 0)]);
    rail(
      [project(104, 20, 18), project(124, 20, 18), project(124, 305, 18), project(104, 305, 18)],
      [project(124, 20, 18), project(124, 305, 18), project(124, 305, 0), project(124, 20, 0)]);
    rail(
      [project(-124, 292, 18), project(-14, 292, 18), project(-14, 308, 18), project(-124, 308, 18)],
      [project(-124, 292, 18), project(-124, 308, 18), project(-124, 308, 0), project(-124, 292, 0)]);
    rail(
      [project(26, 292, 18), project(124, 292, 18), project(124, 308, 18), project(26, 308, 18)],
      [project(124, 292, 18), project(124, 308, 18), project(124, 308, 0), project(124, 292, 0)]);
    // NET BUZZER above the slot
    const bp = project(0, 300, 32);
    if (bp) {
      const bw = Math.max(10, 20 * bp.s), bh = Math.max(7, 12 * bp.s);
      ctx.save();
      ctx.translate(bp.sx + shake, bp.sy + shake);
      ctx.fillStyle = '#1a1f28'; ctx.strokeStyle = scored ? '#ff2d2d' : '#5a6a7d'; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.roundRect(-bw / 2, -bh, bw, bh, 3); ctx.fill(); ctx.stroke();
      ctx.beginPath(); ctx.arc(0, -bh - 1, bw * 0.28, 0, Math.PI * 2);
      ctx.fillStyle = scored ? '#ff2d2d' : '#5c1a1a'; ctx.fill();
      if (scored) {
        ctx.shadowColor = '#ff2d2d'; ctx.shadowBlur = 16;
        ctx.beginPath(); ctx.arc(0, -bh - 1, bw * 0.28, 0, Math.PI * 2); ctx.fill();
        ctx.shadowBlur = 0;
        const ringR = bw * (0.6 + ((performance.now() / 280) % 1) * 1.6);
        ctx.beginPath(); ctx.arc(0, -bh - 1, ringR, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(255,45,45,.6)'; ctx.lineWidth = 2; ctx.stroke();
      }
      ctx.restore();
    }
    // players far-to-near
    [...skaters].sort((a, b) => b.z - a.z).forEach(p => disc(p, shake));
    // scorer disc at the shot spot
    disc({ x: start.x, z: start.z, num: gl.scorerNum ? String(gl.scorerNum) : '', col: scorerCol }, shake);
    // puck: trail in flight, resting at the stick before the shot
    const puckAt = (tt) => {
      if (tt < PAN) return { x: start.x + 4, z: start.z + 4 };
      const st = Math.min((tt - PAN) / FLIGHT, 1), e = easeOut(st);
      return { x: start.x + (goal.x - start.x) * e, z: start.z + (goal.z - start.z) * e };
    };
    if (t >= PAN) {
      for (let i = 6; i >= 0; i--) {
        const pos = puckAt(Math.max(PAN, t - i * 14));
        const pr = project(pos.x, pos.z, 0);
        if (!pr) continue;
        ctx.beginPath(); ctx.arc(pr.sx + shake, pr.sy + shake, Math.max(2, 4.5 * pr.s * (1 - i / 8)), 0, Math.PI * 2);
        ctx.fillStyle = `rgba(225,29,46,${0.9 - i * 0.11})`; ctx.fill();
      }
    }
    const pos = puckAt(t);
    const pr = project(pos.x, pos.z, 0);
    if (pr) {
      const r = Math.max(3, 5 * pr.s);
      ctx.beginPath(); ctx.arc(pr.sx + shake, pr.sy + shake, r, 0, Math.PI * 2);
      ctx.fillStyle = '#e11d2e'; ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,.85)'; ctx.lineWidth = 1; ctx.stroke();
      ctx.beginPath(); ctx.arc(pr.sx + shake, pr.sy + shake, r * 0.45, 0, Math.PI * 2);
      ctx.fillStyle = '#fff'; ctx.fill();
    }
    if (scored && !buzzed) { buzzed = true; horn(); }
  }

  (function frame(now) {
    const t = now - t0;
    draw(t);
    if (t < PAN + FLIGHT + CELEB) requestAnimationFrame(frame);
    else if (!done) { done = true; onDone(); }
  })(t0);
}
// Make goal type badges clickable to replay animation
document.addEventListener('click', (e) => {
  const badge = e.target.closest('.gtype-clickable');
  if (!badge || !badge._goal) return;
  playGoalAnimation(badge._goal);
});
