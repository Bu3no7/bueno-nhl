/* Bueno Sports — Thanksgiving skin (Alex-approved animated mock v3, 2026-11-20).
   Date-keyed: Mon Nov 23, 2026 8:30 PM – Fri Nov 27, 2026 (visitor-local),
   self-reverting. (Alex moved the cosmetics live early, 2026-11-23; the
   Week 12 data and boards still update Nov 25.)
   Site-wide: falling leaves ONLY — fields, courts, rinks and pitches untouched.
   Football page: leaves + the turkey pass play (background scene on the
   field itself: a turkey at the 50 airs it out to another at the 30, who
   runs it into the top endzone) + a Full Plate banner.
   Home page: leaves + a one-time Happy Thanksgiving popup (waits for the
   What's New popup to close first). Preview anytime with ?tgpreview=1. */
(function () {
  var now = new Date();
  var start = new Date(2026, 10, 23, 20, 30, 0);
  var end = new Date(2026, 10, 28, 0, 0, 0);
  var inWindow = now >= start && now < end;
  var preview = /[?&]tgpreview=1/.test(location.search);
  if (!inWindow && !preview) return;
  if (window.__tgSkin) return;
  window.__tgSkin = true;

  var file = location.pathname.split('/').pop() || '';
  var isHome = file === '' || file === 'index.html' || file === 'index';
  var isNFL = file === 'nfl.html' || file === 'nfl';

  var CSS = [
    '.tg-leaves{position:fixed;inset:0;overflow:hidden;pointer-events:none;z-index:1090;}',
    '.tg-leaf{position:absolute;top:-20px;border-radius:0 65% 0 65%;opacity:.85;animation-name:tgFall;animation-timing-function:linear;animation-iteration-count:infinite;}',
    '@keyframes tgFall{0%{transform:translate(0,-20px) rotate(0deg);}25%{transform:translate(12px,26vh) rotate(100deg);}50%{transform:translate(-9px,52vh) rotate(190deg);}75%{transform:translate(10px,78vh) rotate(280deg);}100%{transform:translate(-5px,104vh) rotate(360deg);}}',
    /* NFL Full Plate banner */
    '.tg-banner{display:block;text-align:center;padding:9px 12px;background:linear-gradient(90deg,#e07b39,#b5443c);color:#fff;font:800 .72rem/1.3 -apple-system,"Segoe UI",Roboto,sans-serif;letter-spacing:.14em;text-decoration:none;}',
    '.tg-banner b{color:#ffe9b8;}',
    /* Turkey pass play (Football background scene, on the field itself) */
    '.tg-pass{position:fixed;inset:0;z-index:-1;pointer-events:none;}',
    '.tg-pass svg{display:block;width:100%;height:100%;animation:tgSceneFade 6s linear infinite;}',
    '@keyframes tgSceneFade{0%{opacity:0;}5%{opacity:1;}93%{opacity:1;}100%{opacity:0;}}',
    '.tg-recmove{animation:tgRecMove 6s linear infinite;}',
    '@keyframes tgRecMove{0%{transform:translate(0px,15px);}15%,30%{transform:translate(0px,0px);}33%{transform:translate(0px,-7px);}36%{transform:translate(0px,0px);}42%{transform:translate(-6px,-32px);}48%{transform:translate(-12px,-66px);}54%{transform:translate(-18px,-100px);}60%{transform:translate(-24px,-134px);}66%{transform:translate(-30px,-164px);}68%{transform:translate(-34px,-180px);}72%{transform:translate(-34px,-190px);}76%,80%{transform:translate(-34px,-180px);}80.5%{transform:translate(-34px,-188px);}84%,100%{transform:translate(-34px,-180px);}}',
    '.tg-qbmove{animation:tgQbHop 6s linear infinite;}',
    '@keyframes tgQbHop{0%,54%{transform:translate(0px,0px);}58%{transform:translate(0px,-7px);}62%{transform:translate(0px,0px);}66%{transform:translate(0px,-5px);}70%,100%{transform:translate(0px,0px);}}',
    '.tg-recleg{transform-box:fill-box;transform-origin:50% 6%;animation:tgRecLeg 6s linear infinite;}',
    '@keyframes tgRecLeg{0%,35%{transform:rotate(0deg);}39%{transform:rotate(-30deg);}43%{transform:rotate(24deg);}47%{transform:rotate(-30deg);}51%{transform:rotate(24deg);}55%{transform:rotate(-30deg);}59%{transform:rotate(24deg);}63%{transform:rotate(-26deg);}67%,100%{transform:rotate(0deg);}}',
    '.tg-pwing{transform-box:fill-box;transform-origin:25% 20%;}',
    '.tg-qb .tg-pwing{animation:tgQbWing 6s linear infinite;}',
    '@keyframes tgQbWing{0%,11%{transform:rotate(0deg);}15%{transform:rotate(-42deg);}19%{transform:rotate(16deg);}26%,100%{transform:rotate(0deg);}}',
    '.tg-rec .tg-pwing{animation:tgRecWing 6s linear infinite;}',
    '@keyframes tgRecWing{0%,66%{transform:rotate(0deg);}71%,88%{transform:rotate(-55deg);}93%,100%{transform:rotate(0deg);}}',
    '.tg-qb .tg-heldball{animation:tgQbBall 6s linear infinite;}',
    '@keyframes tgQbBall{0%,17%{opacity:1;}18%,100%{opacity:0;}}',
    '.tg-rec .tg-heldball{opacity:0;animation:tgRecBall 6s linear infinite;}',
    '@keyframes tgRecBall{0%,31%{opacity:0;}32%,100%{opacity:1;}}',
    '.tg-flyball{opacity:0;animation:tgFlyBall 6s linear infinite;}',
    '@keyframes tgFlyBall{0%,17%{transform:translate(0px,0px);opacity:0;}18%{transform:translate(0px,0px);opacity:1;}25%{transform:translate(43px,-118px);opacity:1;}32%{transform:translate(92px,-125px);opacity:1;}34%,100%{transform:translate(92px,-125px);opacity:0;}}',
    '.tg-flyspin{transform-box:fill-box;transform-origin:50% 50%;animation:tgFlySpin .45s linear infinite;}',
    '@keyframes tgFlySpin{from{transform:rotate(0deg);}to{transform:rotate(360deg);}}',
    '.tg-tdglow{opacity:0;animation:tgTdGlow 6s linear infinite;}',
    '@keyframes tgTdGlow{0%,66%{opacity:0;}73%{opacity:.75;}82%{opacity:.45;}90%{opacity:.65;}100%{opacity:0;}}',
    '.tg-body{transform-box:fill-box;transform-origin:50% 85%;animation:tgSquash .26s ease-in-out infinite alternate;}',
    '@keyframes tgSquash{from{transform:scale(1.03,.94) rotate(-1.6deg) translateY(2px);}to{transform:scale(.98,1.03) rotate(1.6deg) translateY(-3px);}}',
    '.tg-head{transform-box:fill-box;transform-origin:20% 80%;animation:tgThrust .52s ease-in-out infinite;}',
    '@keyframes tgThrust{0%,100%{transform:translateX(0) rotate(0deg);}30%{transform:translateX(6px) rotate(3deg);}55%{transform:translateX(1px) rotate(-1deg);}80%{transform:translateX(5px) rotate(2deg);}}',
    '.tg-wattle{transform-box:fill-box;transform-origin:50% 0%;animation:tgSwing .52s ease-in-out infinite;}',
    '@keyframes tgSwing{0%,100%{transform:rotate(-13deg);}50%{transform:rotate(15deg);}}',
    '.tg-fan1{transform-box:fill-box;transform-origin:50% 100%;animation:tgFan 1.04s ease-in-out infinite alternate;}',
    '.tg-fan2{transform-box:fill-box;transform-origin:50% 100%;animation:tgFan 1.04s ease-in-out .12s infinite alternate;}',
    '.tg-fan3{transform-box:fill-box;transform-origin:50% 100%;animation:tgFan 1.04s ease-in-out .24s infinite alternate;}',
    '.tg-fan4{transform-box:fill-box;transform-origin:50% 100%;animation:tgFan 1.04s ease-in-out .36s infinite alternate;}',
    '.tg-fan5{transform-box:fill-box;transform-origin:50% 100%;animation:tgFan 1.04s ease-in-out .48s infinite alternate;}',
    '@keyframes tgFan{from{transform:rotate(-3.4deg);}to{transform:rotate(3.4deg);}}',
    '.tg-thighA{transform-box:fill-box;transform-origin:50% 8%;animation:tgThigh .26s ease-in-out infinite alternate;}',
    '.tg-thighB{transform-box:fill-box;transform-origin:50% 8%;animation:tgThigh .26s ease-in-out infinite alternate-reverse;}',
    '@keyframes tgThigh{from{transform:rotate(27deg);}to{transform:rotate(-27deg);}}',
    '.tg-shinA{transform-box:fill-box;transform-origin:50% 6%;animation:tgShin .26s ease-in-out infinite alternate;}',
    '.tg-shinB{transform-box:fill-box;transform-origin:50% 6%;animation:tgShin .26s ease-in-out infinite alternate-reverse;}',
    '@keyframes tgShin{from{transform:rotate(-8deg);}to{transform:rotate(38deg);}}',
    '.tg-wing{transform-box:fill-box;transform-origin:25% 20%;animation:tgPump .26s ease-in-out infinite alternate;}',
    '@keyframes tgPump{from{transform:rotate(-7deg) translateY(0);}to{transform:rotate(6deg) translateY(-2px);}}',
    '.tg-shadow{transform-box:fill-box;transform-origin:50% 50%;animation:tgShad .26s ease-in-out infinite alternate;}',
    '@keyframes tgShad{from{transform:scaleX(1.12);opacity:.34;}to{transform:scaleX(.88);opacity:.22;}}',
    '.tg-puff{animation:tgPuff .52s ease-out infinite;}',
    '.tg-puff2{animation:tgPuff .52s ease-out .26s infinite;}',
    '@keyframes tgPuff{0%{transform:translate(0,0) scale(.4);opacity:.55;}100%{transform:translate(-16px,-9px) scale(1.25);opacity:0;}}',
    '.tg-speed{animation:tgSpd .5s ease-in-out infinite alternate;}',
    '@keyframes tgSpd{from{opacity:.12;}to{opacity:.5;}}',
    /* Home popup */
    '.tg-backdrop{position:fixed;inset:0;z-index:1150;display:flex;align-items:center;justify-content:center;padding:16px;background:rgba(3,6,12,.66);}',
    '.tg-card{width:100%;max-width:360px;border-radius:20px;padding:22px 20px 16px;text-align:center;color:#eef3fa;background:linear-gradient(165deg,rgba(24,32,52,.88),rgba(7,11,18,.92));backdrop-filter:blur(16px) saturate(1.35);-webkit-backdrop-filter:blur(16px) saturate(1.35);border:1px solid rgba(224,123,57,.55);box-shadow:0 0 26px rgba(224,123,57,.28),inset 0 0 24px rgba(181,68,60,.10);}',
    '.tg-card .tg-script{font-family:"Alex Brush","Brush Script MT",cursive;font-size:2.5rem;line-height:1.1;background:linear-gradient(180deg,#f5b942,#e07b39);-webkit-background-clip:text;background-clip:text;color:transparent;}',
    '.tg-card .tg-sub{margin-top:6px;font-size:.9rem;line-height:1.45;color:#c6cfdd;font-weight:600;}',
    '.tg-card .tg-cta{display:block;margin-top:14px;padding:.72rem 1rem;border-radius:12px;background:linear-gradient(90deg,#e07b39,#b5443c);color:#fff;font-weight:900;letter-spacing:.03em;text-decoration:none;font-size:.95rem;}',
    '.tg-card .tg-close{margin-top:9px;width:100%;padding:.55rem 1rem;border:1px solid rgba(255,255,255,.22);border-radius:12px;background:transparent;color:#aeb8c6;font-weight:700;cursor:pointer;font-size:.85rem;}',
    '@media (prefers-reduced-motion: reduce){.tg-leaves{display:none;}.tg-pass *{animation:none !important;}}'
  ].join('\n');

  var TURKEY =
    '<svg width="122" height="108" viewBox="0 0 200 168" aria-hidden="true">' +
    '<defs>' +
    '<linearGradient id="tgFA" x1="0" y1="1" x2="0" y2="0"><stop offset="0" stop-color="#5d3a17"/><stop offset=".72" stop-color="#a33c31"/><stop offset=".88" stop-color="#e8b04b"/><stop offset="1" stop-color="#8a5a2b"/></linearGradient>' +
    '<linearGradient id="tgFB" x1="0" y1="1" x2="0" y2="0"><stop offset="0" stop-color="#5d3a17"/><stop offset=".72" stop-color="#c96a2c"/><stop offset=".88" stop-color="#f2cd7e"/><stop offset="1" stop-color="#a06a30"/></linearGradient>' +
    '<radialGradient id="tgBodyG" cx=".38" cy=".3" r=".95"><stop offset="0" stop-color="#a06a30"/><stop offset=".6" stop-color="#7a4a21"/><stop offset="1" stop-color="#54300f"/></radialGradient>' +
    '<linearGradient id="tgHelm" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#2c4a7d"/><stop offset="1" stop-color="#101f3a"/></linearGradient>' +
    '</defs>' +
    '<ellipse class="tg-shadow" cx="102" cy="160" rx="52" ry="6" fill="#000"/>' +
    '<g fill="#e8dcc3"><circle class="tg-puff" cx="76" cy="152" r="6"/><circle class="tg-puff2" cx="118" cy="154" r="5"/></g>' +
    '<g class="tg-speed" stroke="#ffffff" stroke-width="3.4" stroke-linecap="round"><line x1="2" y1="76" x2="26" y2="76"/><line x1="8" y1="94" x2="30" y2="94"/><line x1="2" y1="112" x2="22" y2="112"/></g>' +
    '<g class="tg-body">' +
    '<g><g class="tg-fan1"><ellipse cx="52" cy="52" rx="15" ry="40" fill="url(#tgFA)" transform="rotate(-52 52 96)"/></g>' +
    '<g class="tg-fan2"><ellipse cx="62" cy="40" rx="15" ry="44" fill="url(#tgFB)" transform="rotate(-30 62 96)"/></g>' +
    '<g class="tg-fan3"><ellipse cx="76" cy="34" rx="15" ry="46" fill="url(#tgFA)" transform="rotate(-10 76 96)"/></g>' +
    '<g class="tg-fan4"><ellipse cx="90" cy="34" rx="15" ry="46" fill="url(#tgFB)" transform="rotate(12 90 96)"/></g>' +
    '<g class="tg-fan5"><ellipse cx="102" cy="42" rx="14" ry="42" fill="url(#tgFA)" transform="rotate(32 102 96)"/></g></g>' +
    '<g class="tg-thighA"><line x1="92" y1="124" x2="90" y2="140" stroke="#6b3f1c" stroke-width="8" stroke-linecap="round"/><g class="tg-shinA"><line x1="90" y1="138" x2="88" y2="154" stroke="#e07b39" stroke-width="5.4" stroke-linecap="round"/><path d="M79 156 h19" stroke="#e07b39" stroke-width="5.4" stroke-linecap="round"/></g></g>' +
    '<g class="tg-thighB"><line x1="118" y1="124" x2="120" y2="140" stroke="#54300f" stroke-width="8" stroke-linecap="round"/><g class="tg-shinB"><line x1="120" y1="138" x2="124" y2="154" stroke="#d96f2e" stroke-width="5.4" stroke-linecap="round"/><path d="M115 156 h19" stroke="#d96f2e" stroke-width="5.4" stroke-linecap="round"/></g></g>' +
    '<ellipse cx="104" cy="102" rx="46" ry="34" fill="url(#tgBodyG)"/>' +
    '<ellipse cx="114" cy="110" rx="29" ry="21" fill="#8f5a28" opacity=".55"/>' +
    '<ellipse cx="88" cy="88" rx="16" ry="9" fill="#c98d4e" opacity=".35" transform="rotate(-18 88 88)"/>' +
    '<g class="tg-head"><circle cx="146" cy="62" r="18" fill="#8a5a2b"/><circle cx="140" cy="52" r="7" fill="#c98d4e" opacity=".4"/>' +
    '<path d="M160 60 l17 5 l-17 6 z" fill="#f59e0b"/>' +
    '<g class="tg-wattle"><path d="M157 68 q6 13 0 19 q-8 -7 -5 -18 z" fill="#c0392b"/></g>' +
    '<circle cx="150" cy="58" r="3.4" fill="#fff"/><circle cx="151.4" cy="58" r="1.8" fill="#14100a"/>' +
    '<path d="M127 60 a19 19 0 0 1 38 -3 l0 4 l-38 3 z" fill="url(#tgHelm)"/>' +
    '<path d="M143 42 a19 19 0 0 1 8 2 l-2 6 a14 14 0 0 0 -6 -2 z" fill="#f5b942"/>' +
    '<ellipse cx="138" cy="47" rx="7" ry="3.4" fill="#ffffff" opacity=".35" transform="rotate(-24 138 47)"/>' +
    '<path d="M163 58 l10 2 M163 66 l10 0" stroke="#cfd6de" stroke-width="3" stroke-linecap="round"/></g>' +
    '<g class="tg-wing"><path d="M96 92 q26 2 34 18 q-20 10 -34 -2 z" fill="#54300f"/>' +
    '<ellipse cx="140" cy="106" rx="19" ry="13" fill="#8a4b2a" transform="rotate(24 140 106)"/>' +
    '<path d="M127 97 q13 9 26 18" stroke="#fff" stroke-width="3" fill="none"/>' +
    '<path d="M135 102 l9 6 M139 99 l9 6" stroke="#fff" stroke-width="2.4"/></g>' +
    '</g></svg>';

  /* Pass play scene: the site turkey, twice — a QB at the 50 and a
     receiver who takes the pass at the 30 and runs it into the top
     endzone. Drawn in the field background's own 400x800 coordinates so
     it lines up with the yard lines on any screen. One 6s master cycle
     drives the throw, the flight, the run and the touchdown glow. */
  var TGK = '<ellipse cx="102" cy="160" rx="52" ry="6" fill="#000" opacity=".25"/>' +
    '<g><g class="tg-fan1"><ellipse cx="52" cy="52" rx="15" ry="40" fill="url(#tgKFA)" transform="rotate(-52 52 96)"/></g>' +
    '<g class="tg-fan2"><ellipse cx="62" cy="40" rx="15" ry="44" fill="url(#tgKFB)" transform="rotate(-30 62 96)"/></g>' +
    '<g class="tg-fan3"><ellipse cx="76" cy="34" rx="15" ry="46" fill="url(#tgKFA)" transform="rotate(-10 76 96)"/></g>' +
    '<g class="tg-fan4"><ellipse cx="90" cy="34" rx="15" ry="46" fill="url(#tgKFB)" transform="rotate(12 90 96)"/></g></g>' +
    '<g class="tg-fan5"><ellipse cx="102" cy="42" rx="14" ry="42" fill="url(#tgKFA)" transform="rotate(32 102 96)"/></g></g>' +
    '<line x1="94" y1="124" x2="92" y2="156" stroke="#e07b39" stroke-width="5.4" stroke-linecap="round"/>' +
    '<path d="M83 158 h19" stroke="#e07b39" stroke-width="5.4" stroke-linecap="round"/>' +
    '<g class="LEGCLS"><line x1="118" y1="122" x2="121" y2="140" stroke="#54300f" stroke-width="8" stroke-linecap="round"/>' +
    '<line x1="121" y1="138" x2="128" y2="155" stroke="#d96f2e" stroke-width="5.4" stroke-linecap="round"/>' +
    '<path d="M121 157 h19" stroke="#d96f2e" stroke-width="5.4" stroke-linecap="round"/></g>' +
    '<ellipse cx="104" cy="102" rx="46" ry="34" fill="url(#tgKBodyG)"/>' +
    '<ellipse cx="114" cy="110" rx="29" ry="21" fill="#8f5a28" opacity=".55"/>' +
    '<ellipse cx="88" cy="88" rx="16" ry="9" fill="#c98d4e" opacity=".35" transform="rotate(-18 88 88)"/>' +
    '<g><circle cx="146" cy="62" r="18" fill="#8a5a2b"/><circle cx="140" cy="52" r="7" fill="#c98d4e" opacity=".4"/>' +
    '<path d="M160 60 l17 5 l-17 6 z" fill="#f59e0b"/>' +
    '<g class="tg-wattle"><path d="M157 68 q6 13 0 19 q-8 -7 -5 -18 z" fill="#c0392b"/></g>' +
    '<circle cx="150" cy="58" r="3.4" fill="#fff"/><circle cx="151.4" cy="58" r="1.8" fill="#14100a"/>' +
    '<path d="M127 60 a19 19 0 0 1 38 -3 l0 4 l-38 3 z" fill="url(#tgKHelm)"/>' +
    '<path d="M143 42 a19 19 0 0 1 8 2 l-2 6 a14 14 0 0 0 -6 -2 z" fill="#f5b942"/>' +
    '<ellipse cx="138" cy="47" rx="7" ry="3.4" fill="#ffffff" opacity=".35" transform="rotate(-24 138 47)"/>' +
    '<path d="M163 58 l10 2 M163 66 l10 0" stroke="#cfd6de" stroke-width="3" stroke-linecap="round"/></g>' +
    '<g class="tg-pwing"><path d="M96 92 q26 2 34 18 q-20 10 -34 -2 z" fill="#54300f"/>' +
    '<ellipse class="tg-heldball" cx="140" cy="106" rx="19" ry="13" fill="#8a4b2a" transform="rotate(24 140 106)"/>' +
    '<path class="tg-heldball" d="M127 97 q13 9 26 18" stroke="#fff" stroke-width="3" fill="none"/>' +
    '<path class="tg-heldball" d="M135 102 l9 6 M139 99 l9 6" stroke="#fff" stroke-width="2.4"/></g>' + '';
  function tgTurkey(cls, legCls, x, y) {
    return '<g class="' + cls + '"><g transform="translate(' + x + ',' + y + ') scale(0.37)"><g>' +
      TGK.replace('LEGCLS', legCls) + '</g></g></g>';
  }
  var PASSSCENE =
    '<svg viewBox="0 0 400 800" preserveAspectRatio="xMidYMid slice" aria-hidden="true">' +
    '<defs>' +
    '<linearGradient id="tgKFA" x1="0" y1="1" x2="0" y2="0"><stop offset="0" stop-color="#5d3a17"/><stop offset=".72" stop-color="#a33c31"/><stop offset=".88" stop-color="#e8b04b"/><stop offset="1" stop-color="#8a5a2b"/></linearGradient>' +
    '<linearGradient id="tgKFB" x1="0" y1="1" x2="0" y2="0"><stop offset="0" stop-color="#5d3a17"/><stop offset=".72" stop-color="#c96a2c"/><stop offset=".88" stop-color="#f2cd7e"/><stop offset="1" stop-color="#a06a30"/></linearGradient>' +
    '<radialGradient id="tgKBodyG" cx=".38" cy=".3" r=".95"><stop offset="0" stop-color="#a06a30"/><stop offset=".6" stop-color="#7a4a21"/><stop offset="1" stop-color="#54300f"/></radialGradient>' +
    '<linearGradient id="tgKHelm" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#2c4a7d"/><stop offset="1" stop-color="#101f3a"/></linearGradient>' +
    '</defs>' +
    '<ellipse class="tg-tdglow" cx="206" cy="60" rx="54" ry="36" fill="none" stroke="#f5b942" stroke-width="3"/>' +
    '<g class="tg-qbmove">' + tgTurkey('tg-qb', 'tg-qbleg', 109.5, 342.8) + '</g>' +
    '<g class="tg-recmove">' + tgTurkey('tg-rec', 'tg-recleg', 201.5, 217.8) + '</g>' +
    '<g class="tg-flyball"><g transform="translate(161,382)"><g class="tg-flyspin">' +
    '<ellipse cx="0" cy="0" rx="17" ry="11" fill="#7a4820"/>' +
    '<path d="M-8 0 h16" stroke="#f0f0eb" stroke-width="2.6"/>' +
    '<path d="M-4 -3.4 v6.8 M0 -3.4 v6.8 M4 -3.4 v6.8" stroke="#f0f0eb" stroke-width="2"/>' +
    '</g></g></g>' +
    '</svg>';

  function init() {
    var style = document.createElement('style');
    style.id = 'tg-skin-css';
    style.textContent = CSS;
    document.head.appendChild(style);
    document.body.classList.add('tg-week');

    /* Falling leaves — every page, nothing else changes. */
    var leaves = document.createElement('div');
    leaves.className = 'tg-leaves';
    leaves.setAttribute('aria-hidden', 'true');
    var COLORS = ['#e07b39', '#f5b942', '#b5443c', '#d99a3a'];
    var cfg = [
      [6, 13, 6.2, 0], [14, 9, 7.4, 1.2], [23, 12, 5.6, 2.1], [33, 8, 8.1, 0.6],
      [42, 12, 6.8, 3.0], [51, 9, 5.9, 1.7], [59, 11, 7.9, 4.0], [67, 8, 6.5, 4.6],
      [74, 13, 6.1, 0.9], [82, 9, 7.2, 2.8], [89, 11, 5.7, 3.7], [95, 8, 8.4, 1.9]
    ];
    cfg.forEach(function (c, i) {
      var leaf = document.createElement('span');
      leaf.className = 'tg-leaf';
      leaf.style.left = c[0] + '%';
      leaf.style.width = c[1] + 'px';
      leaf.style.height = c[1] + 'px';
      leaf.style.background = COLORS[i % COLORS.length];
      leaf.style.animationDuration = c[2] + 's';
      leaf.style.animationDelay = c[3] + 's';
      leaves.appendChild(leaf);
    });
    document.body.appendChild(leaves);

    if (isNFL) {
      var banner = document.createElement('a');
      banner.className = 'tg-banner';
      banner.href = '#';
      banner.innerHTML = 'THANKSGIVING WEEK &middot; <b>THE FULL PLATE</b> &middot; BOARDS WED, THU &amp; FRI';
      banner.addEventListener('click', function (e) { e.preventDefault(); window.scrollTo({ top: 0, behavior: 'smooth' }); });
      document.body.insertBefore(banner, document.body.firstChild);

      var pass = document.createElement('div');
      pass.className = 'tg-pass';
      pass.setAttribute('aria-hidden', 'true');
      pass.innerHTML = PASSSCENE;
      document.body.appendChild(pass);
    }

    if (isHome) {
      var SEEN = 'bueno-tg-2026-seen';
      var seen = false;
      try { seen = !!localStorage.getItem(SEEN); } catch (e) { }
      if (seen && !preview) return;
      var tries = 0;
      var wait = setInterval(function () {
        tries++;
        var wn = document.getElementById('wnBackdrop');
        var wnOpen = wn && !wn.hidden;
        if (wnOpen && tries < 40) return; /* let What's New finish first */
        clearInterval(wait);
        if (document.querySelector('.tg-backdrop')) return;
        var bd = document.createElement('div');
        bd.className = 'tg-backdrop';
        bd.innerHTML =
          '<div class="tg-card" role="dialog" aria-modal="true" aria-label="Happy Thanksgiving">' +
          TURKEY.replace('width="122" height="108"', 'width="110" height="97"') +
          '<div class="tg-script">Happy Thanksgiving</div>' +
          '<div class="tg-sub">From us to you. The Full Plate is served on Football all week &mdash; the opener Wednesday night, three games Thursday, and the dessert Friday.</div>' +
          '<a class="tg-cta" href="/nfl.html">See the Full Plate</a>' +
          '<button class="tg-close" type="button">Close</button>' +
          '</div>';
        bd.querySelector('.tg-close').addEventListener('click', function () {
          try { localStorage.setItem(SEEN, '1'); } catch (e) { }
          bd.remove();
        });
        bd.addEventListener('click', function (e) { if (e.target === bd) bd.querySelector('.tg-close').click(); });
        document.body.appendChild(bd);
      }, 700);
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
