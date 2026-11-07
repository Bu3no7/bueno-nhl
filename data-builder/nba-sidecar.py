#!/usr/bin/env python3
"""
NBA display sidecars for nba.html — DISPLAY ONLY, nothing here feeds pricing.

Produces, for a slate date (default: today):
  data/nba-zones-<date>.json   Shot zones: last-20 + full-season splits per priced
                               player (NBA.com ShotChartDetail), shot dots for the
                               last-20 window, and tonight's opponents' allowed-by-zone.
  data/nba-guards-<date>.json  Guarded-by: each priced player's primary/secondary
                               defender season-to-date (LeagueSeasonMatchups rollup)
                               plus the top defender on tonight's opponent, if met.
  data-builder/nba-crosswalk.json  ESPN <-> NBA.com player-ID crosswalk (built once
                               from ESPN team rosters + nba_api's static player list,
                               then reused; rebuild with --crosswalk).

Run with a python that has nba_api installed, e.g.:
  ~/workspace/research_notes/nba-api-data/test/venv/bin/python \
      data-builder/nba-sidecar.py --date=2026-11-07

stats.nba.com throttles in bursts: calls are spaced ~1.6s, retried with backoff,
and every raw response is cached under data-builder/cache/ (keyed by date, so a
re-run the same day is free). A circuit breaker stops the zones pass after 8
straight failures rather than hammering the endpoint.
Priced-player source: ~/workspace/nba-model/captures/<date>.json (harness capture).
"""
import argparse, json, os, re, sys, time, unicodedata, urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
SITE = os.path.dirname(HERE)
CACHE = os.path.join(HERE, 'cache')
CROSSWALK_PATH = os.path.join(HERE, 'nba-crosswalk.json')
CAPTURES = os.path.expanduser('~/workspace/nba-model/captures')
MIN_MATCHUP_SEC = 240          # >= 4 matchup minutes for a defender to count
ZONE_MIN_PROJMIN = 15          # zones sidecar only for players projected >= 15 min
SPACING = 1.6                  # seconds between stats.nba.com calls

ZONE_MAP = {
    'Restricted Area': 'rim',
    'In The Paint (Non-RA)': 'paint',
    'Mid-Range': 'mid',
    'Left Corner 3': 'c3',
    'Right Corner 3': 'c3',
    'Above the Break 3': 'ab3',
}
ZKEYS = ['rim', 'paint', 'mid', 'c3', 'ab3']
# ESPN abbreviation -> NBA.com abbreviation where they differ
ABBR_ALIAS = {'UTAH': 'UTA', 'GS': 'GSW', 'NY': 'NYK', 'SA': 'SAS', 'NO': 'NOP', 'WSH': 'WAS'}
# First-name aliases seen across ESPN / NBA.com listings
NAME_ALIASES = {
    'alex sarr': 'alexandre sarr',
    'nic claxton': 'nicolas claxton',
    'cam johnson': 'cameron johnson',
    'cam thomas': 'cameron thomas',
    'moe wagner': 'moritz wagner',
    'trey murphy': 'trey murphy iii',
    'herb jones': 'herbert jones',
    'jake laravia': 'jake laravia',
    'naji marshall': 'naji marshall',
}
SUFFIXES = {'jr', 'sr', 'ii', 'iii', 'iv', 'v'}


def norm_name(s):
    s = unicodedata.normalize('NFKD', s or '')
    s = ''.join(c for c in s if not unicodedata.combining(c))
    s = s.lower().replace('.', ' ').replace("'", '').replace('-', ' ')
    toks = [t for t in s.split() if t not in SUFFIXES]
    return ' '.join(toks)


def fetch_json(url, timeout=30):
    req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode('utf-8'))


def build_crosswalk():
    from nba_api.stats.static import players as nba_players
    espn = {}   # espnId -> {name, team}
    for tid in range(1, 31):
        d = fetch_json(f'https://site.api.espn.com/apis/site/v2/sports/basketball/nba/teams/{tid}/roster')
        abbr = ((d.get('team') or {}).get('abbreviation') or '').upper()
        for a in d.get('athletes') or []:
            espn[str(a['id'])] = {'name': a.get('displayName') or a.get('fullName') or '', 'team': abbr}
        time.sleep(0.15)
    all_static = nba_players.get_players()
    # Father/son pairs (Nance, Payton, Smith) collide on normalized name in the
    # all-time list — match active players first, fall back to a unique all-time hit.
    nba_active, nba_all = {}, {}
    for p in all_static:
        nba_all.setdefault(norm_name(p['full_name']), []).append(str(p['id']))
        if p.get('is_active'):
            nba_active.setdefault(norm_name(p['full_name']), []).append(str(p['id']))
    by_espn, by_nba, unmatched = {}, {}, []
    for eid, info in espn.items():
        key = norm_name(info['name'])
        keys = [key]
        if key in NAME_ALIASES:
            keys.append(norm_name(NAME_ALIASES[key]))
        cands = []
        for k in keys:
            cands = nba_active.get(k) or []
            if len(cands) == 1:
                break
            cands = nba_all.get(k) or []
            if len(cands) == 1:
                break
            cands = []
        if len(cands) != 1:
            unmatched.append({'espnId': eid, 'name': info['name'], 'team': info['team'],
                              'candidates': cands})
            continue
        nid = cands[0]
        by_espn[eid] = {'nbaId': int(nid), 'name': info['name'], 'team': info['team']}
        by_nba[nid] = {'espnId': eid, 'name': info['name'], 'team': info['team']}
    cw = {'builtAt': time.strftime('%Y-%m-%d %H:%M:%S'),
          'byEspn': by_espn, 'byNba': by_nba, 'unmatchedEspn': unmatched}
    with open(CROSSWALK_PATH, 'w') as f:
        json.dump(cw, f, indent=1)
    print(f'crosswalk: {len(by_espn)} matched of {len(espn)} ESPN roster players; '
          f'{len(unmatched)} unmatched')
    return cw


def load_crosswalk(rebuild=False):
    if not rebuild and os.path.exists(CROSSWALK_PATH):
        with open(CROSSWALK_PATH) as f:
            return json.load(f)
    return build_crosswalk()


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


def zone_split(rows):
    out = {k: {'att': 0, 'mk': 0} for k in ZKEYS}
    for r in rows:
        k = ZONE_MAP.get(r.get('SHOT_ZONE_BASIC'))
        if not k:
            continue
        out[k]['att'] += 1
        out[k]['mk'] += int(r.get('SHOT_MADE_FLAG') or 0)
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--date', required=True, help='slate date YYYY-MM-DD')
    ap.add_argument('--crosswalk', action='store_true', help='rebuild the crosswalk')
    args = ap.parse_args()
    date = args.date
    season = season_of(date)
    os.makedirs(CACHE, exist_ok=True)

    cap_path = os.path.join(CAPTURES, f'{date}.json')
    with open(cap_path) as f:
        cap = json.load(f)
    priced = cap.get('ours') or []
    print(f'capture {date}: {len(priced)} priced players, season {season}')

    cw = load_crosswalk(args.crosswalk)
    by_espn, by_nba = cw['byEspn'], cw['byNba']
    matched = [r for r in priced if str(r['pid']) in by_espn]
    print(f'crosswalk: {len(matched)}/{len(priced)} priced players matched')
    for r in priced:
        if str(r['pid']) not in by_espn:
            print(f'  UNMATCHED priced: {r["name"]} ({r["team"]}) espn {r["pid"]}')

    from nba_api.stats.endpoints import LeagueSeasonMatchups, ShotChartDetail
    from nba_api.stats.static import teams as nba_teams
    nba_team_id = {}
    for t in nba_teams.get_teams():
        nba_team_id[t['abbreviation']] = t['id']

    # ---------- guards (one rollup call for the whole league) ----------
    mcache = os.path.join(CACHE, f'nba-matchups-{date}.csv')
    if os.path.exists(mcache):
        import pandas as pd
        mdf = pd.read_csv(mcache)
    else:
        mdf = retry(lambda: LeagueSeasonMatchups(season=season, timeout=60).get_data_frames()[0],
                    'LeagueSeasonMatchups')
        mdf.to_csv(mcache, index=False)
        time.sleep(SPACING)
    print(f'matchups: {len(mdf)} pairing rows')
    by_off = {}
    for rec in mdf.to_dict('records'):
        by_off.setdefault(int(rec['OFF_PLAYER_ID']), []).append(rec)

    def dent(rec):
        nid = int(rec['DEF_PLAYER_ID'])
        info = by_nba.get(str(nid)) or {}
        fga = int(rec['MATCHUP_FGA'] or 0)
        fgm = int(rec['MATCHUP_FGM'] or 0)
        return {'name': rec['DEF_PLAYER_NAME'], 'nbaId': nid,
                'espnId': info.get('espnId'), 'team': info.get('team') or '',
                'min': round(float(rec['MATCHUP_TIME_SEC'] or 0) / 60.0, 1),
                'pts': int(rec['PLAYER_PTS'] or 0), 'fgm': fgm, 'fga': fga,
                'fgPct': round(fgm / fga, 3) if fga else None,
                'gp': int(rec['GP'] or 0)}

    guards = {}
    for r in matched:
        xw = by_espn[str(r['pid'])]
        rows = [x for x in by_off.get(xw['nbaId'], [])
                if float(x['MATCHUP_TIME_SEC'] or 0) >= MIN_MATCHUP_SEC]
        rows.sort(key=lambda x: -float(x['MATCHUP_TIME_SEC'] or 0))
        if not rows:
            continue
        draws = None
        for x in rows:
            info = by_nba.get(str(int(x['DEF_PLAYER_ID']))) or {}
            if (info.get('team') or '') == r['opp']:
                draws = dent(x)
                break
        guards[str(r['pid'])] = {
            'name': r['name'], 'team': r['team'], 'opp': r['opp'],
            'primary': dent(rows[0]),
            'secondary': dent(rows[1]) if len(rows) > 1 else None,
            'draws': draws,
        }
    gpath = os.path.join(SITE, 'data', f'nba-guards-{date}.json')
    with open(gpath, 'w') as f:
        json.dump({'date': date, 'season': season, 'players': guards}, f)
    print(f'guards: {len(guards)} players -> {gpath}')

    # ---------- zones (per-player shot charts + per-opponent allowed) ----------
    targets = [r for r in matched if (r.get('projMin') or 0) >= ZONE_MIN_PROJMIN]
    targets.sort(key=lambda r: -(r.get('projMin') or 0))
    print(f'zones: {len(targets)} players at projMin >= {ZONE_MIN_PROJMIN}')
    zones_players = {}
    consec_fail = 0
    blocked = False
    for r in targets:
        nid = by_espn[str(r['pid'])]['nbaId']
        cpath = os.path.join(CACHE, f'nba-shots-{date}-{nid}.csv')
        try:
            if os.path.exists(cpath):
                import pandas as pd
                sdf = pd.read_csv(cpath)
            else:
                sdf = retry(lambda: ShotChartDetail(
                    player_id=nid, team_id=0, season_nullable=season,
                    context_measure_simple='FGA', timeout=60).get_data_frames()[0],
                    f'shots {r["name"]}')
                sdf.to_csv(cpath, index=False)
                time.sleep(SPACING)
            consec_fail = 0
        except Exception as e:
            consec_fail += 1
            print(f'  SHOTS FAIL {r["name"]}: {type(e).__name__} {str(e)[:120]} '
                  f'(consecutive {consec_fail})')
            if consec_fail >= 8:
                blocked = True
                print('  CIRCUIT BREAKER: 8 straight failures — stopping zones pass')
                break
            continue
        rows = sdf.to_dict('records')
        games = sorted({(str(x['GAME_DATE']), str(x['GAME_ID'])) for x in rows}, reverse=True)
        l20_ids = {gid for _, gid in games[:20]}
        l20_rows = [x for x in rows if str(x['GAME_ID']) in l20_ids]
        # Dots in ESPN court convention (hoop at x=25, y=0). Half-court heaves
        # (y > 46.5) still count in the zone splits but can't plot on a half-court.
        dots = [{'x': round(25 + float(x['LOC_X']) / 10, 1),
                 'y': round(float(x['LOC_Y']) / 10, 1),
                 'mk': int(x['SHOT_MADE_FLAG'] or 0)}
                for x in l20_rows
                if ZONE_MAP.get(x.get('SHOT_ZONE_BASIC'))
                and 0 <= 25 + float(x['LOC_X']) / 10 <= 50
                and float(x['LOC_Y']) / 10 <= 46.5][:420]
        zones_players[str(r['pid'])] = {
            'season': zone_split(rows), 'l20': zone_split(l20_rows),
            'gamesSeason': len(games), 'gamesL20': len(l20_ids), 'shots': dots,
        }
    print(f'zones players done: {len(zones_players)}')

    opp_allowed = {}
    opp_abbrs = sorted({r['opp'] for r in priced})
    for abbr in opp_abbrs:
        nba_abbr = ABBR_ALIAS.get(abbr, abbr)
        tid = nba_team_id.get(nba_abbr)
        if not tid:
            print(f'  no NBA team id for {abbr}')
            continue
        cpath = os.path.join(CACHE, f'nba-against-{date}-{nba_abbr}.csv')
        try:
            if os.path.exists(cpath):
                import pandas as pd
                adf = pd.read_csv(cpath)
            else:
                adf = retry(lambda: ShotChartDetail(
                    player_id=0, team_id=0, season_nullable=season,
                    context_measure_simple='FGA', opponent_team_id=tid,
                    timeout=60).get_data_frames()[0], f'against {abbr}')
                adf.to_csv(cpath, index=False)
                time.sleep(SPACING)
            opp_allowed[abbr] = zone_split(adf.to_dict('records'))
        except Exception as e:
            print(f'  AGAINST FAIL {abbr}: {type(e).__name__} {str(e)[:120]}')
    print(f'opp allowed: {len(opp_allowed)} teams')

    zpath = os.path.join(SITE, 'data', f'nba-zones-{date}.json')
    with open(zpath, 'w') as f:
        json.dump({'date': date, 'season': season, 'players': zones_players,
                   'opp': opp_allowed}, f)
    print(f'zones: {len(zones_players)} players -> {zpath}')
    print(json.dumps({'guardsPlayers': len(guards), 'zonesPlayers': len(zones_players),
                      'zonesTargets': len(targets), 'oppAllowed': len(opp_allowed),
                      'pricedMatched': len(matched), 'pricedTotal': len(priced),
                      'zonesBlocked': blocked}))


if __name__ == '__main__':
    main()
