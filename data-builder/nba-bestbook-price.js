/* NBA best-book pricing helper — prices today's slate with the site
   engine (nba-engine.js) exactly the way the accuracy harness does
   (~/workspace/nba-model/capture.js): completed-season (2025-26) ESPN
   core stats for base rates, last-3 box scores for recent minutes,
   team ratings for opponent + game-environment factors.
 *
 * Emits, per priced player, the model's P(over line) on a grid of
 * half-point lines for Points / Rebounds / Assists / Threes, so the
 * Python builder (nba-bestbook.py) can read off the probability at a
 * book's EXACT line — never a probability priced at a different line.
 *
 * Usage: node nba-bestbook-price.js [YYYY-MM-DD]   (default: today,
 * America/Phoenix). JSON goes to stdout; progress goes to stderr.
 * Exits non-zero if the slate can't be priced at all.
 */
const E = require('/home/hatch/workspace/nhl-goal-model-site/nba-engine.js');
const API = 'https://site.api.espn.com/apis/site/v2/sports/basketball/nba';
const CORE = 'https://sports.core.api.espn.com/v2/sports/basketball/leagues/nba';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function get(u, tries = 4) {
  for (let i = 0; i < tries; i++) {
    try { const r = await fetch(u); if (r.ok) return await r.json(); } catch (e) { /* retry */ }
    if (i < tries - 1) await sleep(1500);
  }
  return null;
}
const dateArg = process.argv[2];
const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Phoenix' });
const DATE = dateArg || today;
const ymd = DATE.replace(/-/g, '');

/* Half-point line grids (P(over line) read off by exact key). */
const GRIDS = {
  points: [4.5, 49.5],
  rebounds: [0.5, 24.5],
  assists: [0.5, 19.5],
  threes: [0.5, 9.5],
};
function gridFor(dist, [lo, hi]) {
  const g = {};
  for (let line = lo; line <= hi; line += 1) {
    g[line.toFixed(1)] = Math.round(E.nbaProbOver(dist, line) * 10000) / 10000;
  }
  return g;
}

async function main() {
  console.error('NBA best-book pricing for', DATE);
  const sb = await get(`${API}/scoreboard?dates=${ymd}`);
  if (!sb) { console.error('scoreboard failed'); process.exit(1); }
  const games = [];
  for (const ev of sb.events || []) {
    const comp = (ev.competitions || [])[0];
    const cs = comp.competitors || [];
    const home = cs.find((c) => c.homeAway === 'home');
    const away = cs.find((c) => c.homeAway === 'away');
    if (!home || !away) continue;
    games.push({
      gid: String(ev.id), start: ev.date,
      state: (((comp.status || {}).type) || {}).state || 'pre',
      home: { tid: String(home.team.id), abbr: home.team.abbreviation },
      away: { tid: String(away.team.id), abbr: away.team.abbreviation },
    });
  }
  console.error('games:', games.length);
  if (!games.length) { console.error('no games on slate'); process.exit(1); }

  /* ---- ratings (same construction as capture.js) ---- */
  const st = await get('https://site.api.espn.com/apis/v2/sports/basketball/nba/standings?season=2026');
  const pa = {};
  for (const conf of (st && st.children) || []) for (const e of (conf.standings.entries || [])) {
    const mm = {}; for (const s of e.stats || []) mm[s.name] = s.value;
    if (e.team && e.team.id) pa[e.team.id] = mm.avgPointsAgainst;
  }
  const rc = {};
  async function ratings(tid) {
    if (rc[tid]) return rc[tid];
    const j = await get(`${CORE}/seasons/2026/types/2/teams/${tid}/statistics`);
    const m = {}; for (const c of (((j || {}).splits || {}).categories) || []) for (const s of (c.stats || [])) m[s.name] = s.value;
    const pace = m.avgEstimatedPossessions || 100;
    const r = { pace, offRtg: (m.pointsPerEstimatedPossessions || 1.156) * 100, defRtg: ((pa[tid] || 115.6) / pace) * 100 };
    rc[tid] = r; return r;
  }

  /* ---- verified recent-minutes universe (capture.js discipline:
     a team's recent block is only trusted when the summary actually
     contains that team's block; tonight's own game never leaks in) ---- */
  async function teamRecent(tid) {
    const sched = await get(`${API}/teams/${tid}/schedule`);
    const past = ((sched || {}).events || [])
      .filter((e) => (((e.competitions || [])[0] || {}).status || {}).type?.completed)
      .sort((a, b) => new Date(b.date) - new Date(a.date)).slice(0, 3);
    const byP = {};
    for (const ev of past) {
      if (games.some((g) => String(ev.id) === g.gid)) continue;
      let block = null;
      for (let attempt = 0; attempt < 3 && !block; attempt++) {
        const sum = await get(`${API}/summary?event=${ev.id}`, 2);
        const blocks = ((sum || {}).boxscore || {}).players || [];
        block = blocks.find((tp) => String((tp.team || {}).id) === String(tid)) || null;
        if (!block) await sleep(800);
      }
      if (!block) { console.error(`  !! summary unverified: team ${tid} event ${ev.id}`); continue; }
      const sbb = (block.statistics || [])[0] || {};
      const labels = sbb.labels || []; const mix = labels.indexOf('MIN');
      for (const a of sbb.athletes || []) {
        if (a.didNotPlay) continue;
        const pid = String((a.athlete || {}).id);
        const entry = byP[pid] || (byP[pid] = { name: (a.athlete || {}).displayName, mins: [] });
        entry.mins.push(parseFloat((a.stats || [])[mix]) || 0);
      }
    }
    return byP;
  }

  /* ---- our prices ---- */
  const players = [];
  const coverage = [];
  for (const g of games) {
    for (const side of ['home', 'away']) {
      const mine = g[side], opp = g[side === 'home' ? 'away' : 'home'];
      const recent = await teamRecent(mine.tid);
      const oppR = await ratings(opp.tid), myR = await ratings(mine.tid);
      const env = E.nbaEnvFactors(myR, oppR, { pace: 100, rtg: 115.6 });
      let priced = 0; const failed = [];
      for (const [pid, info] of Object.entries(recent)) {
        const rg = info.mins;
        const avg = rg.reduce((x, y) => x + y, 0) / rg.length;
        if (!(avg >= 10 || rg[0] >= 16)) continue;
        const sj = await get(`${CORE}/seasons/2026/types/2/athletes/${pid}/statistics`, 4);
        if (!sj || !sj.splits) { failed.push(info.name); continue; }
        const m = {}; for (const c of (sj.splits.categories || [])) for (const s of (c.stats || [])) m[s.name] = s.value;
        if (!m.gamesPlayed || !m.minutes) { failed.push(info.name + ' (no 2025-26 stats)'); continue; }
        priced++;
        const season = { minutes: m.minutes, points: m.points, assists: m.assists, rebounds: m.totalRebounds,
          threeAtt: m.threePointFieldGoalsAttempted, threeMade: m.threePointFieldGoalsMade,
          threePct: (m.threePointFieldGoalPct || 0) / 100, avgMinutes: m.avgMinutes };
        const pr = E.nbaPricePlayer(season, { recentGames: rg, oppDefRtg: oppR.defRtg, paceAdj: env.a });
        const markets = {};
        for (const key of ['points', 'rebounds', 'assists', 'threes']) {
          const md = pr.markets[key];
          markets[key] = { mean: md.mean, grid: gridFor(md.dist, GRIDS[key]) };
        }
        players.push({ pid, name: info.name, team: mine.abbr, opp: opp.abbr, gid: g.gid, home: side === 'home',
          projMin: Math.round(pr.minutes * 10) / 10, markets });
        await sleep(30);
      }
      coverage.push({ team: mine.abbr, universe: Object.keys(recent).length, priced, failed });
      console.error(` ${mine.abbr}: priced ${priced}/${Object.keys(recent).length}${failed.length ? ' — failed: ' + failed.join(', ') : ''}`);
    }
  }
  if (!players.length) { console.error('no players priced'); process.exit(1); }
  process.stdout.write(JSON.stringify({ date: DATE, games, coverage, players }));
}

main().catch((e) => { console.error('pricing failed:', e.message); process.exit(1); });
