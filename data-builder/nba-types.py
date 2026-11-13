#!/usr/bin/env python3
"""
NBA Player Types for nba.html — DISPLAY ONLY, nothing here feeds pricing.

Assigns every current-season (2026-27) player a shot-style type (A-I, plus the
hand-split J) from the taxonomy locked on the 2025-26 corpus, and builds a
type-vs-defense table (how each type's production moves against each opponent).

  data/nba-types.json            {date, season, generatedAt, floor, playerCount,
                                  types, players, defense}
  data-builder/nba-types-lock.json  The taxonomy lock: scaler mean/scale + the
                                  9 scaled KMeans centers keyed by letter A-I,
                                  fit EXACTLY as gmg-replication/cluster_check.py
                                  fits shotdetail_2025.csv (FGA floor 400,
                                  StandardScaler, KMeans k=9 n_init=20
                                  random_state=7, depth ordering to letters).
                                  Reused on later runs; refit only with --relock.

Run with a python that has nba_api / sklearn / pandas, e.g.:
  ~/workspace/research_notes/nba-api-data/test/venv/bin/python \
      data-builder/nba-types.py --date=2026-11-12

stats.nba.com throttles in bursts: calls are spaced ~1.6s, retried with
backoff, and every raw response is cached under data-builder/cache/ (keyed by
date, so a re-run the same day is free).
"""
import argparse, json, os, sys, time
from datetime import date as _date

import numpy as np
import pandas as pd

HERE = os.path.dirname(os.path.abspath(__file__))
SITE = os.path.dirname(HERE)
CACHE = os.path.join(HERE, 'cache')
LOCK_PATH = os.path.join(HERE, 'nba-types-lock.json')
CROSSWALK_PATH = os.path.join(HERE, 'nba-crosswalk.json')
CORPUS = os.path.expanduser('~/workspace/nba-model/corpus/shotdetail/'
                            'shotdetail_2025.csv')
GMG_DIR = os.path.expanduser('~/workspace/gmg-replication')
SPACING = 1.6                  # seconds between stats.nba.com calls
SEASON = '2026-27'

sys.path.insert(0, GMG_DIR)
import cluster_check as cc     # reuse build()/kind_of/FEATS verbatim

FEATS = cc.FEATS
LETTERS = [chr(ord('A') + i) for i in range(9)]   # A..I

TYPES = {
    'A': {'name': 'Deep catch-and-shoot',
          'desc': 'Lives beyond the arc — spot-up threes are the diet.'},
    'B': {'name': 'Pull-up combo guard',
          'desc': 'Creates his own shot off the dribble, deep and in the float game.'},
    'C': {'name': 'Step-back creator',
          'desc': 'Step-backs and pull-ups — self-created separation.'},
    'D': {'name': 'Mid-range artisan',
          'desc': 'The mid-range is home: fades, turnarounds, tough twos.'},
    'E': {'name': 'Balanced wing',
          'desc': 'A bit of everything — no single shot diet dominates.'},
    'F': {'name': 'Spot-up stretch big',
          'desc': 'A big who spots up outside; cuts and putbacks inside.'},
    'G': {'name': 'Floater / drive guard',
          'desc': 'Paint touches — floaters and drives are the meal.'},
    'H': {'name': 'Post hub',
          'desc': 'The offense runs through the post: hooks and paint touches.'},
    'I': {'name': 'Rim runner',
          'desc': 'Cuts, lobs and putbacks — lives at the rim.'},
    'J': {'name': 'Rim attacker',
          'desc': 'Gets to the rim by driving through people.'},
}

# ESPN abbreviation -> NBA.com abbreviation where they differ (from nba-sidecar.py)
ABBR_ALIAS = {'UTAH': 'UTA', 'GS': 'GSW', 'NY': 'NYK', 'SA': 'SAS',
              'NO': 'NOP', 'WSH': 'WAS'}
NBA_TO_ESPN = {v: k for k, v in ABBR_ALIAS.items()}


def espn_abbr(nba_abbr):
    return NBA_TO_ESPN.get(nba_abbr, nba_abbr)


def season_of(date_str):
    y, m = int(date_str[:4]), int(date_str[5:7])
    return f'{y}-{str(y + 1)[2:]}' if m >= 10 else f'{y - 1}-{str(y)[2:]}'


def retry(fn, label, tries=3):
    last = None
    for i in range(tries):
        try:
            return fn()
        except Exception as e:  # throttling shows up as timeouts / proxy errors
            last = e
            print(f'  retry {i + 1} {label}: {type(e).__name__} {str(e)[:120]}')
            time.sleep(5 * (i + 1))
    raise last


# ---------------------------------------------------------------- lock fit
def load_corpus_rows():
    """Feature rows for the 2025-26 corpus, built exactly as cluster_check does."""
    df = pd.read_csv(CORPUS, usecols=['PLAYER_ID', 'PLAYER_NAME', 'ACTION_TYPE',
                                      'SHOT_TYPE', 'SHOT_ZONE_BASIC',
                                      'SHOT_DISTANCE', 'GAME_ID'])
    return cc.build(df)


def assign_letters(P, lock):
    """Nearest lock center (scaled space) for each row of a build() frame.
    Returns {pid: (letter, second_letter, fit, dists_sorted)}."""
    mean = np.array(lock['scalerMean'])
    scale = np.array(lock['scalerScale'])
    centers = np.array([lock['centers'][L] for L in LETTERS])
    X = (P[FEATS].astype(float).values - mean) / scale
    d = np.linalg.norm(X[:, None, :] - centers[None, :, :], axis=2)
    out = {}
    for j, pid in enumerate(P.index):
        order = np.argsort(d[j])
        d1, d2 = float(d[j][order[0]]), float(d[j][order[1]])
        out[pid] = (LETTERS[order[0]], LETTERS[order[1]],
                    1.0 - d1 / d2 if d2 > 0 else 0.0)
    return out


SANITY_EXPECTED = {'Klay Thompson': 'A', 'Rudy Gobert': 'I',
                   'Stephen Curry': 'B', 'Nikola Jokić': 'H'}
J_VALIDATE = ['Giannis Antetokounmpo', 'Zion Williamson', 'Paolo Banchero']
J_ORIG = {'baseLetter': 'G', 'zRimMin': 0.60, 'driveMin': 0.15}


def j_letter(base, z_rim, k_drive, rule):
    if (base == rule['baseLetter'] and z_rim >= rule['zRimMin']
            and k_drive >= rule['driveMin']):
        return 'J'
    return base


def derive_j_rule(P, lock):
    """Original rule: base G + z_rim >= 0.60 + drive share >= 0.15. Paolo
    Banchero (base G, drive-heavy) sits at z_rim ~0.36 on the corpus, so the
    0.60 rim bar only ever catches the two rim-only outliers. If the original
    rule misses any of the three validation names, step the rim bar down in
    0.05 increments (drive floor untouched) to the highest bar that lands
    all three in J, and report before/after."""
    assigned = assign_letters(P, lock)
    by_name = {}
    for pid, row in P.iterrows():
        by_name[row['name']] = (pid, row)

    def check(rule):
        res = {}
        for name in J_VALIDATE:
            pid, row = by_name[name]
            base = assigned[pid][0]
            res[name] = {'base': base, 'zRim': round(float(row['z_rim']), 3),
                         'kDrive': round(float(row['k_drive']), 3),
                         'letter': j_letter(base, float(row['z_rim']),
                                            float(row['k_drive']), rule)}
        return res

    before = check(J_ORIG)
    if all(v['letter'] == 'J' for v in before.values()):
        return dict(J_ORIG), before, before
    rule = dict(J_ORIG)
    after = before
    for rim in (0.55, 0.50, 0.45, 0.40, 0.35, 0.30):
        rule = {'baseLetter': 'G', 'zRimMin': rim, 'driveMin': J_ORIG['driveMin']}
        after = check(rule)
        if all(v['letter'] == 'J' for v in after.values()):
            break
    return rule, before, after


def fit_lock():
    from sklearn.cluster import KMeans
    from sklearn.preprocessing import StandardScaler
    P = load_corpus_rows()
    R = P[P['fga'] >= 400].copy()
    X = StandardScaler().fit_transform(R[FEATS].astype(float))
    km = KMeans(9, n_init=20, random_state=7).fit(X)
    R['cluster'] = km.labels_
    # depth score orders clusters A (deepest shooters) -> I (rim runners)
    prof = R.groupby('cluster')[FEATS].mean()
    prof['depth'] = (1.4 * prof['z_ab3'] + 1.0 * prof['z_c3']
                     + 0.02 * prof['avg_dist'] - 1.2 * prof['z_rim'])
    order = prof.sort_values('depth', ascending=False).index.tolist()
    letters = {}
    for i, c in enumerate(order):
        letters[c] = chr(ord('A') + i)
    scaler = StandardScaler().fit(R[FEATS].astype(float))
    centers = {}
    for c, L in letters.items():
        centers[L] = [round(float(v), 6) for v in km.cluster_centers_[c]]
    lock = {'builtAt': time.strftime('%Y-%m-%d %H:%M:%S'),
            'source': CORPUS, 'fgaFloor': 400, 'feats': FEATS,
            'scalerMean': [round(float(v), 6) for v in scaler.mean_],
            'scalerScale': [round(float(v), 6) for v in scaler.scale_],
            'centers': centers,
            'letterOfCluster': {str(k): v for k, v in letters.items()},
            'nPlayersFga400': int(len(R))}
    rule, before, after = derive_j_rule(P, lock)
    lock['jRule'] = rule
    lock['jValidationBefore'] = before
    lock['jValidationAfter'] = after
    with open(LOCK_PATH, 'w') as f:
        json.dump(lock, f, indent=1)
    print(f'lock: fit on {len(R)} players (FGA>=400) -> {LOCK_PATH}')
    return lock


def load_lock(relock):
    if not relock and os.path.exists(LOCK_PATH):
        with open(LOCK_PATH) as f:
            lock = json.load(f)
        print(f'lock: reused {LOCK_PATH} (built {lock.get("builtAt")})')
        return lock
    return fit_lock()


def sanity_check(P, lock):
    assigned = assign_letters(P, lock)
    by_name = {row['name']: pid for pid, row in P.iterrows()}
    out = {}
    for name, want in SANITY_EXPECTED.items():
        pid = by_name.get(name)
        got = assigned[pid][0] if pid is not None else None
        out[name] = {'expected': want, 'got': got, 'ok': got == want}
        print(f'  sanity {name}: expected {want}, got {got} '
              f'({"OK" if got == want else "MISS"})')
    return out


# ---------------------------------------------------------------- pulls
def pull_shots(date):
    """Leaguewide 2026-27 ShotChartDetail; per-team fallback. Returns
    (df, fallback_used, failures)."""
    from nba_api.stats.endpoints import ShotChartDetail
    cpath = os.path.join(CACHE, f'nba-types-shots-{date}.csv')
    if os.path.exists(cpath):
        print(f'shots: cache hit {cpath}')
        return pd.read_csv(cpath), False, []
    try:
        df = retry(lambda: ShotChartDetail(
            player_id=0, team_id=0, season_nullable=SEASON,
            context_measure_simple='FGA', timeout=90).get_data_frames()[0],
            'ShotChartDetail leaguewide')
        df.to_csv(cpath, index=False)
        time.sleep(SPACING)
        print(f'shots: leaguewide pull {len(df)} rows')
        return df, False, []
    except Exception as e:
        print(f'shots: leaguewide FAILED ({type(e).__name__} {str(e)[:120]}) '
              f'— falling back to per-team calls')
    from nba_api.stats.static import teams as nba_teams
    frames, failures = [], []
    for t in nba_teams.get_teams():
        try:
            f = retry(lambda tid=t['id']: ShotChartDetail(
                player_id=0, team_id=tid, season_nullable=SEASON,
                context_measure_simple='FGA', timeout=90).get_data_frames()[0],
                f"shots team {t['abbreviation']}")
            frames.append(f)
            time.sleep(SPACING)
        except Exception as e:
            failures.append(t['abbreviation'])
            print(f'  team pull FAIL {t["abbreviation"]}: '
                  f'{type(e).__name__} {str(e)[:120]}')
    df = pd.concat(frames, ignore_index=True) if frames else pd.DataFrame()
    if len(df):
        df.to_csv(cpath, index=False)
    print(f'shots: per-team fallback {len(df)} rows, failures {failures}')
    return df, True, failures


def pull_gamelogs(date):
    from nba_api.stats.endpoints import PlayerGameLogs
    cpath = os.path.join(CACHE, f'nba-types-gamelogs-{date}.csv')
    if os.path.exists(cpath):
        print(f'gamelogs: cache hit {cpath}')
        return pd.read_csv(cpath)
    df = retry(lambda: PlayerGameLogs(
        season_nullable=SEASON, timeout=90).get_data_frames()[0],
        'PlayerGameLogs')
    df.to_csv(cpath, index=False)
    time.sleep(SPACING)
    print(f'gamelogs: {len(df)} rows')
    return df


# ---------------------------------------------------------------- main
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--date', default=_date.today().isoformat(),
                    help='run date YYYY-MM-DD (default: today)')
    ap.add_argument('--relock', action='store_true',
                    help='refit the taxonomy lock instead of reusing it')
    args = ap.parse_args()
    date = args.date
    season = season_of(date)
    os.makedirs(CACHE, exist_ok=True)

    lock = load_lock(args.relock)
    j_rule = lock['jRule']
    print(f'J rule: base {j_rule["baseLetter"]} + z_rim >= {j_rule["zRimMin"]} '
          f'+ drive share >= {j_rule["driveMin"]} -> J '
          f'(original brief rule: z_rim >= {J_ORIG["zRimMin"]})')
    for name in J_VALIDATE:
        b = lock['jValidationBefore'][name]
        a = lock['jValidationAfter'][name]
        print(f'  J validate {name}: base {b["base"]} z_rim {b["zRim"]} '
              f'drive {b["kDrive"]} -> before {b["letter"]}, after {a["letter"]}')

    print('lock sanity (2025-26 corpus, nearest lock center):')
    P_lock = load_corpus_rows()
    sanity = sanity_check(P_lock, lock)

    with open(CROSSWALK_PATH) as f:
        by_nba = json.load(f)['byNba']

    # ---------- current-season shot features ----------
    sdf, shots_fallback, shots_failures = pull_shots(date)
    P = cc.build(sdf)
    print(f'shots: {len(sdf)} rows -> {len(P)} players with features')

    # player's current team: modal TEAM_ID across his shots (NBA abbr via static list)
    from nba_api.stats.static import teams as nba_teams
    team_abbr_by_id = {t['id']: t['abbreviation'] for t in nba_teams.get_teams()}
    team_of = {}
    if 'TEAM_ID' in sdf.columns:
        for pid, g in sdf.groupby('PLAYER_ID'):
            tid = int(g['TEAM_ID'].mode().iloc[0])
            team_of[int(pid)] = espn_abbr(team_abbr_by_id.get(tid, ''))

    floor_used, typed = None, None
    for floor in (150, 125, 100, 75, 50):
        sub = P[P['fga'] >= floor]
        print(f'  floor {floor}: {len(sub)} players')
        if len(sub) >= 150:
            floor_used, typed = floor, sub
            break
    if typed is None:
        floor_used, typed = 50, P[P['fga'] >= 50]
    print(f'floor used: {floor_used} -> {len(typed)} typed players')

    assigned = assign_letters(typed, lock)
    players = {}
    espn_matched = 0
    for pid, row in typed.iterrows():
        nid = int(pid)
        base, second, fit = assigned[pid]
        letter = j_letter(base, float(row['z_rim']), float(row['k_drive']),
                          j_rule)
        xw = by_nba.get(str(nid)) or {}
        espn_id = xw.get('espnId')
        if espn_id:
            espn_matched += 1
            key = str(espn_id)
        else:
            key = f'nba:{nid}'
        team = team_of.get(nid) or xw.get('team') or ''
        players[key] = {
            'name': row['name'], 'team': team, 'nbaId': nid,
            'espnId': int(espn_id) if espn_id else None,
            'letter': letter, 'fit': round(float(fit), 2),
            'lean': second if fit < 0.12 else None,
            'fga': int(row['fga']),
        }
    print(f'players: {len(players)} typed, {espn_matched} ESPN-matched')

    # ---------- type-vs-defense ----------
    gdf = pull_gamelogs(date)
    typed_ids = {p['nbaId']: p for p in players.values()}
    letter_of_nba = {p['nbaId']: p['letter'] for p in players.values()}
    NBA_ABBRS = set(team_abbr_by_id.values())
    STATS = {'pts': 'PTS', 'tpm': 'FG3M', 'reb': 'REB', 'ast': 'AST',
             'fta': 'FTA'}

    def opp_of(rec):
        toks = str(rec['MATCHUP']).replace('.', '').split()
        abbrs = [t for t in toks if t in NBA_ABBRS]
        team = str(rec['TEAM_ABBREVIATION'])
        others = [a for a in abbrs if a != team]
        return others[0] if others else None

    gdf = gdf[gdf['PLAYER_ID'].isin(typed_ids)].copy()
    gdf['OPP'] = gdf.apply(opp_of, axis=1)
    gdf = gdf[gdf['OPP'].notna()]
    print(f'gamelogs: {len(gdf)} rows for typed players')

    # per-player totals and per-opponent sums (leave-one-out baselines)
    cells = {}   # (letter, opp_espn) -> {'games': int, 'players': set,
                 #                        stat -> [diffs], stat -> [beats]}
    for pid, g in gdf.groupby('PLAYER_ID'):
        letter = letter_of_nba[int(pid)]
        totals = {s: float(g[c].sum()) for s, c in STATS.items()}
        n_tot = len(g)
        for opp, og in g.groupby('OPP'):
            n_opp = len(og)
            if n_tot - n_opp < 1:
                continue  # no non-opponent games to baseline against
            key = (letter, espn_abbr(opp))
            cell = cells.setdefault(key, {'games': 0, 'players': set(),
                                          'd': {s: [] for s in STATS},
                                          'b': {s: [] for s in STATS}})
            cell['games'] += n_opp
            cell['players'].add(int(pid))
            for s, c in STATS.items():
                base = (totals[s] - float(og[c].sum())) / (n_tot - n_opp)
                for v in og[c]:
                    cell['d'][s].append(float(v) - base)
                    cell['b'][s].append(1.0 if float(v) > base else 0.0)
    defense = {}
    n_cells = 0
    for (letter, opp), cell in sorted(cells.items()):
        if cell['games'] < 6:
            continue
        entry = {'games': cell['games'], 'players': len(cell['players'])}
        for s in STATS:
            diffs, beats = cell['d'][s], cell['b'][s]
            entry[s] = {'d': round(float(np.mean(diffs)), 2),
                        'beat': round(float(np.mean(beats)), 2),
                        'n': len(diffs)}
        defense.setdefault(letter, {})[opp] = entry
        n_cells += 1
    print(f'defense: {n_cells} cells (letter x opponent, >= 6 games)')

    out = {'date': date, 'season': season,
           'generatedAt': time.strftime('%Y-%m-%d %H:%M:%S'),
           'floor': floor_used, 'playerCount': len(players),
           'types': TYPES, 'players': players, 'defense': defense}
    opath = os.path.join(SITE, 'data', 'nba-types.json')
    with open(opath, 'w') as f:
        json.dump(out, f)
    size = os.path.getsize(opath)
    print(f'wrote {opath} ({size} bytes)')
    print(json.dumps({
        'floor': floor_used, 'playerCount': len(players),
        'espnMatched': espn_matched,
        'sanity': {k: v['got'] for k, v in sanity.items()},
        'sanityOk': all(v['ok'] for v in sanity.values()),
        'jRule': j_rule,
        'jBefore': {k: v['letter'] for k, v in lock['jValidationBefore'].items()},
        'jAfter': {k: v['letter'] for k, v in lock['jValidationAfter'].items()},
        'defenseCells': n_cells, 'outputBytes': size,
        'shotsFallback': shots_fallback, 'shotsFailures': shots_failures,
    }))


if __name__ == '__main__':
    main()
