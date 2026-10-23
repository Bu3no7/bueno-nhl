/* Bueno Sports — NBA player-prop pricing engine (v2)
 *
 * Pure functions, browser-compatible (classic script, no imports), same
 * pattern as mlb-engine.js. The model, in one paragraph:
 *
 *   Minutes first: projected minutes = last-season MPG regressed toward a
 *   rotation prior, blended with the player's recent games. Then
 *   per-minute rates (points / rebounds / assists / 3PA) from season
 *   totals, each market priced through its own distribution:
 *     points        ~ Normal(mean, SD = max(3.5, 0.40 * mean))
 *     rebounds      ~ NegativeBinomial(mean, k = 8)   (fatter than Poisson)
 *     assists       ~ NegativeBinomial(mean, k = 6)
 *     threes        ~ Binomial(projected attempts, regressed 3P%)
 *   A market's fair line is its median; over/under fair odds come from the
 *   same distribution, so alt lines are just other points on the curve —
 *   exactly how DK builds their ladder.
 *
 * v2 layers (all optional via opts; no opts = exact v1 behavior):
 *   1. Minutes/role — opts.recentGames (minutes, most recent first) blends
 *      a last-3 average instead of one game, and the blend weight rises
 *      when recent minutes diverge from the projection (role shift:
 *      trade, injury ahead of him, promotion). opts.roleMin is a manual
 *      override for news the box scores haven't shown yet.
 *   2. Opponent adjustment — opts.oppDefRtg (opponent points allowed per
 *      100 poss) vs opts.lgDefRtg (league average, default 115.6) scales
 *      each market by a per-market beta: points full, threes/assists
 *      partial, rebounds slight-inverse (good defenses create misses).
 *   3. Game environment — opts.paceAdj now scales every market, and
 *      nbaEnvFactors() derives it keylessly from ESPN-style ratings
 *      (pace + offensive/defensive efficiency) instead of Vegas totals.
 */

const NBA_PRIORS = {
  minPrior: 24,        // rotation-player minutes prior for regression
  minShrink: 0.85,     // weight on last-season MPG
  ptsSdShare: 0.40,    // points SD as a share of the mean
  ptsSdFloor: 3.5,
  rebK: 8,             // negative-binomial dispersion, rebounds
  astK: 6,             // negative-binomial dispersion, assists
  threePctPrior: 0.355,
  threePctK: 250,      // attempts of prior weight for 3P%
  lgDefRtg: 115.6,     // league-average points allowed per 100 poss (2025-26 early)
  roleShiftBand: 0.20, // recent-vs-projection minutes gap that reads as a role change
  roleBlendBase: 0.40, // blend weight on recent minutes, no shift detected
  roleBlendShift: 0.65, // blend weight when a role shift is detected
  oppBeta: { points: 1.0, threes: 0.8, assists: 0.7, rebounds: -0.3 },
};

/* Build per-minute rates from an ESPN-core-style season stat map.
   season: { minutes, points, assists, rebounds, threeAtt, threeMade, threePct (0..1), avgMinutes } */
function nbaRates(season) {
  const min = Math.max(1, (season && season.minutes) || 0);
  return {
    pts: ((season && season.points) || 0) / min,
    reb: ((season && season.rebounds) || 0) / min,
    ast: ((season && season.assists) || 0) / min,
    tpa: ((season && season.threeAtt) || 0) / min,
    tpm: ((season && season.threeMade) || 0) / min,
    threePct: season && season.threePct != null ? season.threePct : null,
    avgMinutes: (season && season.avgMinutes) || 0,
  };
}

/* Projected minutes (v2 role layer): last-season MPG regressed toward the
   prior, blended with recent games. recentGames (most recent first) uses
   a last-3 average; the blend weight rises from roleBlendBase to
   roleBlendShift when recent minutes diverge from the projection by more
   than roleShiftBand — the signature of a role change (trade, injury
   ahead of him, promotion) that last season's line can't know about.
   A bare recentMin (v1 callers) is treated as a one-game sample.
   opts.roleMin, when given, replaces the projection outright (news layer:
   a reported minutes plan the box scores haven't shown yet). */
function nbaProjectMinutes(rates, recentMin, opts) {
  opts = opts || {};
  if (opts.roleMin != null && Number.isFinite(opts.roleMin)) {
    return Math.max(4, Math.min(42, opts.roleMin));
  }
  let m = NBA_PRIORS.minShrink * (rates.avgMinutes || 0) +
    (1 - NBA_PRIORS.minShrink) * NBA_PRIORS.minPrior;
  let recent = null;
  let multiGame = false;
  if (Array.isArray(opts.recentGames) && opts.recentGames.length) {
    const g = opts.recentGames.filter((x) => Number.isFinite(x)).slice(0, 3);
    if (g.length) { recent = g.reduce((a, b) => a + b, 0) / g.length; multiGame = g.length >= 2; }
  } else if (recentMin != null && Number.isFinite(recentMin)) {
    recent = recentMin;
  }
  if (recent != null) {
    const shift = m > 0 ? Math.abs(recent - m) / m : 0;
    const w = multiGame && shift > NBA_PRIORS.roleShiftBand ? NBA_PRIORS.roleBlendShift : NBA_PRIORS.roleBlendBase;
    m = (1 - w) * m + w * recent;
  }
  return Math.max(4, Math.min(40, m));
}

/* Opponent adjustment: multiplicative factor for one market from the
   opponent's defensive rating (points ALLOWED per 100) vs league average.
   A stingy defense (allows less than average) -> factor < 1 for scoring
   markets; a leaky one -> factor > 1. The rebounds beta is negative on
   purpose (better defense = more misses = slightly more rebound chances).
   Clamped to ±8%. */
function nbaOppFactor(oppDefRtg, market, lgDefRtg) {
  if (oppDefRtg == null || !Number.isFinite(oppDefRtg)) return 1;
  const lg = lgDefRtg || NBA_PRIORS.lgDefRtg;
  const beta = NBA_PRIORS.oppBeta[market] != null ? NBA_PRIORS.oppBeta[market] : 0;
  const raw = 1 + beta * (oppDefRtg - lg) / lg;
  return Math.max(0.92, Math.min(1.08, raw));
}

/* Game-environment factors from team ratings (keyless; ESPN core team
   stats shape): pace = estimated possessions per game for both teams,
   offRtg/defRtg = points scored/allowed per 100. Returns per-team
   paceAdj to pass into nbaPricePlayer, from the expected-score formula
   exp = gamePace/100 * (offRtg + oppDefRtg - lgAvg), normalized so a
   league-average matchup returns exactly 1.0. */
function nbaEnvFactors(teamA, teamB, lg) {
  lg = lg || { pace: 100, rtg: NBA_PRIORS.lgDefRtg };
  const gamePace = (teamA.pace + teamB.pace) / 2;
  const expA = gamePace / 100 * (teamA.offRtg + teamB.defRtg - lg.rtg);
  const expB = gamePace / 100 * (teamB.offRtg + teamA.defRtg - lg.rtg);
  const base = lg.pace / 100 * lg.rtg;
  const clampF = (x) => Math.max(0.90, Math.min(1.10, x));
  return { a: clampF(expA / base), b: clampF(expB / base), expA, expB, gamePace };
}

function nbaNormCdf(x) {
  // Abramowitz–Stegun approximation
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const poly = t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 +
    t * (-1.821255978 + t * 1.330274429))));
  const p = 1 - Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI) * poly;
  return x >= 0 ? p : 1 - p;
}

function nbaNbPmf(k, mu, r) {
  // Negative binomial: failures k before r successes, mean mu.
  const p = r / (r + mu);
  // log-gamma via Lanczos-lite: use Stirling-free iterative ratio from P(0)
  let logP = r * Math.log(p);
  let pmf = Math.exp(logP);
  if (k === 0) return pmf;
  for (let i = 1; i <= k; i++) {
    pmf *= ((r + i - 1) / i) * (1 - p);
  }
  return pmf;
}
function nbaNbCdf(k, mu, r) {
  let s = 0;
  for (let i = 0; i <= k; i++) s += nbaNbPmf(i, mu, r);
  return Math.min(1, s);
}
function nbaBinomCdf(k, n, p) {
  if (p <= 0) return 1;
  if (p >= 1) return k >= n ? 1 : 0;
  let pmf = Math.pow(1 - p, n); // P(0)
  let total = pmf;
  for (let i = 1; i <= k; i++) {
    pmf *= ((n - i + 1) / i) * (p / (1 - p));
    total += pmf;
  }
  return Math.min(1, total);
}

function nbaFairOdds(p) {
  if (!(p > 0.0005) || !(p < 0.9995)) return '–';
  if (p >= 0.5) return '−' + Math.round((100 * p) / (1 - p));
  return '+' + Math.round((100 * (1 - p)) / p);
}

/* P(over line) for a counting market given its distribution descriptor. */
function nbaProbOver(dist, line) {
  const L = Math.floor(line);
  if (dist.kind === 'normal') {
    return 1 - nbaNormCdf((line - dist.mean) / dist.sd);
  }
  if (dist.kind === 'nb') {
    return 1 - nbaNbCdf(L, dist.mean, dist.k);
  }
  if (dist.kind === 'binom') {
    return 1 - nbaBinomCdf(L, dist.n, dist.p);
  }
  return 0.5;
}

/* Median of a counting distribution: the .5 line where over prob crosses 50%. */
function nbaMedianLine(dist) {
  for (let line = 0.5; line < 80; line += 1) {
    if (nbaProbOver(dist, line) < 0.5) return line;
  }
  return 79.5;
}

/* Price one player. season = stat map (see nbaRates). v2 opts:
   recentMin (v1) / recentGames / roleMin — minutes & role layer;
   oppDefRtg (+ lgDefRtg) — opponent adjustment; paceAdj — game
   environment, now applied to every market (v1 applied it to points). */
function nbaPricePlayer(season, opts) {
  opts = opts || {};
  const rates = nbaRates(season);
  const minutes = nbaProjectMinutes(rates, opts.recentMin != null ? opts.recentMin : null, opts);
  const paceAdj = opts.paceAdj || 1.0;
  const opp = (market) => nbaOppFactor(opts.oppDefRtg, market, opts.lgDefRtg);

  const ptsMean = rates.pts * minutes * paceAdj * opp('points');
  const ptsSd = Math.max(NBA_PRIORS.ptsSdFloor, NBA_PRIORS.ptsSdShare * ptsMean);
  const rebMean = rates.reb * minutes * paceAdj * opp('rebounds');
  const astMean = rates.ast * minutes * paceAdj * opp('assists');
  const att = Math.max(0, Math.round(rates.tpa * minutes * paceAdj * opp('threes')));
  const rawPct = rates.threePct != null ? rates.threePct :
    (rates.tpa > 0 ? rates.tpm / rates.tpa : NBA_PRIORS.threePctPrior);
  const attSeason = Math.max(0, Math.round(rates.tpa * Math.max(1, (season && season.minutes) || 0)));
  const threePct = (rawPct * attSeason + NBA_PRIORS.threePctPrior * NBA_PRIORS.threePctK) /
    (attSeason + NBA_PRIORS.threePctK);

  const markets = {
    points: { kind: 'normal', mean: ptsMean, sd: ptsSd },
    rebounds: { kind: 'nb', mean: rebMean, k: NBA_PRIORS.rebK },
    assists: { kind: 'nb', mean: astMean, k: NBA_PRIORS.astK },
    threes: { kind: 'binom', n: att, p: threePct, mean: att * threePct },
  };
  const out = { minutes, markets: {} };
  for (const key of Object.keys(markets)) {
    const d = markets[key];
    const medianLine = nbaMedianLine(d);
    out.markets[key] = {
      mean: Math.round(d.mean * 10) / 10,
      medianLine,
      fairAtMedian: {
        over: nbaFairOdds(nbaProbOver(d, medianLine)),
        under: nbaFairOdds(1 - nbaProbOver(d, medianLine)),
      },
      dist: d,
    };
  }
  return out;
}

/* Node export (browsers ignore this block) */
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    NBA_PRIORS, nbaRates, nbaProjectMinutes, nbaPricePlayer,
    nbaProbOver, nbaMedianLine, nbaFairOdds, nbaNormCdf, nbaNbCdf, nbaBinomCdf,
    nbaOppFactor, nbaEnvFactors,
  };
}
