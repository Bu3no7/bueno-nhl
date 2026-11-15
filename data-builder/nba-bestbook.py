#!/usr/bin/env python3
"""NBA best book — best book price + line per player/market (SmartPicks feed).

Builds data/nba-bestbook.json: for every priced player on today's
slate, the best OVER price the books are offering — via the SmartPicks
(Checkd) feed, odds-api.checkd-dev.com, no auth — for the four markets
our engine prices cleanly: Points (PP), Rebounds (PR), Assists (PA),
Threes (PT). Per player/market we keep ONLY their line, the book name,
the American odds and the decimal odds, plus OUR probability of going
over that EXACT line.

NBA selections are LINE-based (over 24.5 at -115), not binary like the
NHL anytime market, so the comparison number is priced by the site
engine at their line — never a probability priced at a different
line. Pricing is done by data-builder/nba-bestbook-price.js, which
mirrors the accuracy harness (~/workspace/nba-model/capture.js):
completed-season ESPN core stats, last-3 box scores for minutes, team
ratings for opponent/environment, nbaPricePlayer + nbaProbOver on a
half-point grid. If a player's exact line falls outside the grid, he
is excluded from that market's board (counted in the build log).

Their hit-rate stats are deliberately NOT stored or displayed: the
feed's stats block never leaves this script. (The one form number we
DO show — "cleared this line in X of last 10" — is computed from OUR
OWN game logs, the stats.nba.com PlayerGameLogs cache that
data-builder/nba-types.py maintains, joined through
data-builder/nba-crosswalk.json. Bonus layer: any failure there just
omits the field.)

Join discipline: their fixtures are matched to our games by team-code
pairing (never by date string — their dates are UTC), and their
players are joined to our priced universe by IDENTITY (team +
normalized name; last name + first initial as fallback). Unmatched or
ambiguous names are logged, never force-fit.

DISPLAY ONLY — a market reference beside our own fair prices; nothing
here feeds a price anywhere.

FAIL-SOFT CONTRACT: on any fetch/parse failure, or a degenerate result
(no matched games, no joined players), the script exits non-zero
WITHOUT touching an existing sidecar. The new file is written to a
temp path and atomically renamed over the old one only after the full
build succeeds.

Usage: python3 data-builder/nba-bestbook.py [--date YYYY-MM-DD]
       [--priced-json PATH] [--no-bonus]
"""
import argparse, csv, glob, json, os, re, subprocess, sys, unicodedata
from datetime import datetime, timezone
from zoneinfo import ZoneInfo

HERE = os.path.dirname(os.path.abspath(__file__))
SITE = os.path.dirname(HERE)
API = "https://odds-api.checkd-dev.com/prod"
FIXTURES_URL = API + "/flashpicks/smartpicks/fixtures?competition=NBA&date=3days"
PLAYERS_URL = API + "/flashpicks/smartpicks/players?market={code}&basedOn=season&fixtures={ids}"
OUT_FILE = os.path.join(SITE, "data", "nba-bestbook.json")
PRICE_JS = os.path.join(HERE, "nba-bestbook-price.js")
CACHE = os.path.join(HERE, "cache")
CROSSWALK_PATH = os.path.join(HERE, "nba-crosswalk.json")
VENV_PY = os.path.expanduser("~/workspace/research_notes/nba-api-data/test/venv/bin/python")
GAMELOG_SEASON = "2026-27"

MARKETS = {"PP": "PTS", "PR": "REB", "PA": "AST", "PT": "3PM"}
GAMELOG_STAT = {"PTS": "PTS", "REB": "REB", "AST": "AST", "3PM": "FG3M"}

BOOK_DISPLAY = {"bet365": "bet365", "betmgm": "BetMGM",
                "draftkings": "DraftKings", "fanatics": "Fanatics",
                "caesars": "Caesars", "fanduel": "FanDuel",
                "espnbet": "ESPN BET", "betrivers": "BetRivers",
                "pointsbet": "PointsBet", "wynnbet": "WynnBET"}

# Their team code -> ESPN abbreviation where they differ
TEAM_ALIAS = {"UTA": "UTAH", "NYK": "NY", "SAS": "SA", "GSW": "GS",
              "NOP": "NO", "WAS": "WSH"}

# First-name aliases seen across book feeds / ESPN listings
# (same table as data-builder/nba-sidecar.py)
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


def fail(msg):
    print(f"nba-bestbook: FAILED — {msg}; existing sidecar left untouched", flush=True)
    return 1


def fetch_json(url, what):
    r = subprocess.run(["curl", "-s", "--max-time", "40", "-H",
                        "User-Agent: Mozilla/5.0", url],
                       capture_output=True, text=True, timeout=60)
    if r.returncode != 0 or not r.stdout:
        raise RuntimeError(f"{what}: curl failed (rc={r.returncode})")
    d = json.loads(r.stdout)
    if not isinstance(d, dict) or d.get("code") != 0 or not isinstance(d.get("events"), list):
        raise RuntimeError(f"{what}: unexpected payload shape")
    return d


def norm_name(s):
    s = unicodedata.normalize('NFKD', s or '')
    s = ''.join(c for c in s if not unicodedata.combining(c))
    s = s.lower().replace('.', ' ').replace("'", '').replace('-', ' ')
    toks = [t for t in s.split() if t not in SUFFIXES]
    s = ' '.join(toks)
    return NAME_ALIASES.get(s, s)


def espn_abbr(their_code):
    return TEAM_ALIAS.get(their_code, their_code)


def price_slate(date, priced_json):
    """Run the node pricing helper (or read a precomputed dump) ->
    {games, players} with per-market P(over line) grids."""
    if priced_json:
        with open(priced_json) as f:
            return json.load(f)
    r = subprocess.run(["node", PRICE_JS, date], capture_output=True,
                       text=True, timeout=1500)
    sys.stderr.write(r.stderr or "")
    if r.returncode != 0 or not r.stdout:
        raise RuntimeError(f"pricing helper failed (rc={r.returncode})")
    return json.loads(r.stdout)


# ---------------------------------------------------------------- bonus
def load_gamelogs(date):
    """(rows, source_label) from OUR OWN pipeline's game-log cache —
    the PlayerGameLogs CSV data-builder/nba-types.py maintains. Tries
    today's cache, then a fresh pull via the nba_api venv, then the
    newest cache on disk. Returns (None, reason) if unavailable."""
    cpath = os.path.join(CACHE, f"nba-types-gamelogs-{date}.csv")
    if not os.path.exists(cpath):
        pull = (
            "from nba_api.stats.endpoints import PlayerGameLogs\n"
            f"df = PlayerGameLogs(season_nullable='{GAMELOG_SEASON}', timeout=90).get_data_frames()[0]\n"
            f"df.to_csv({cpath!r}, index=False)\n"
            "print(len(df))\n"
        )
        try:
            r = subprocess.run([VENV_PY, "-c", pull], capture_output=True,
                               text=True, timeout=300)
            if r.returncode == 0 and os.path.exists(cpath):
                print(f"gamelogs: fresh pull via venv ({(r.stdout or '').strip()} rows)", flush=True)
            else:
                print(f"gamelogs: fresh pull failed (rc={r.returncode}) — falling back", flush=True)
        except Exception as e:
            print(f"gamelogs: fresh pull unavailable ({e}) — falling back", flush=True)
    if not os.path.exists(cpath):
        cands = sorted(glob.glob(os.path.join(CACHE, "nba-types-gamelogs-*.csv")))
        if not cands:
            return None, "no gamelogs cache on disk"
        cpath = cands[-1]
    try:
        with open(cpath, newline="") as f:
            rows = list(csv.DictReader(f))
    except Exception as e:
        return None, f"gamelogs cache unreadable ({e})"
    if not rows:
        return None, "gamelogs cache empty"
    latest = max((r.get("GAME_DATE") or "")[:10] for r in rows)
    return rows, f"{os.path.basename(cpath)} (latest game {latest})"


def cleared_counts(rows, crosswalk, players_out):
    """players_out: {espnId: {MKT: entry}} — adds entry['hit10'] =
    {x, n} counting OUR OWN last-10 games where the player cleared
    tonight's line (stat > line), per market. Needs >= 5 games."""
    by_nba = {}
    for r in rows:
        try:
            by_nba.setdefault(int(r["PLAYER_ID"]), []).append(r)
        except (KeyError, TypeError, ValueError):
            continue
    for games in by_nba.values():
        games.sort(key=lambda r: (r.get("GAME_DATE") or ""), reverse=True)
    by_espn = (crosswalk or {}).get("byEspn") or {}
    added = 0
    for pid, mkts in players_out.items():
        cw = by_espn.get(str(pid))
        if not cw or not cw.get("nbaId"):
            continue
        games = by_nba.get(int(cw["nbaId"])) or []
        if len(games) < 5:
            continue
        last10 = games[:10]
        for mkt, entry in mkts.items():
            col = GAMELOG_STAT[mkt]
            try:
                vals = [float(g[col]) for g in last10]
            except (KeyError, TypeError, ValueError):
                continue
            x = sum(1 for v in vals if v > entry["line"])
            entry["hit10"] = {"x": x, "n": len(vals)}
            added += 1
    return added


# ---------------------------------------------------------------- main
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--date", default=None,
                    help="slate date YYYY-MM-DD (default: today, America/Phoenix)")
    ap.add_argument("--priced-json", default=None,
                    help="precomputed output of nba-bestbook-price.js (skip re-pricing)")
    ap.add_argument("--no-bonus", action="store_true",
                    help="skip the cleared-it (own game logs) layer")
    args = ap.parse_args()
    date = args.date or datetime.now(ZoneInfo("America/Phoenix")).date().isoformat()

    try:
        priced = price_slate(date, args.priced_json)
    except Exception as e:
        return fail(f"pricing: {e}")
    games = priced.get("games") or []
    universe = priced.get("players") or []
    if not games or not universe:
        return fail("pricing produced no games/players")
    print(f"priced universe: {len(universe)} players across {len(games)} games", flush=True)

    # our games by alias-normalized team pair
    our_pairs = {}
    for g in games:
        pair = frozenset([g["home"]["abbr"], g["away"]["abbr"]])
        our_pairs[pair] = g

    try:
        fixtures = fetch_json(FIXTURES_URL, "fixtures")
    except Exception as e:
        return fail(str(e))
    fid_to_game = {}
    seen_pairs = {}
    for ev in fixtures["events"]:
        cs = ev.get("contestant") or []
        codes = [espn_abbr(c.get("code") or "") for c in cs]
        if len(codes) != 2:
            continue
        pair = frozenset(codes)
        g = our_pairs.get(pair)
        if not g:
            continue
        # Their feed sometimes double-lists a game (two fixture ids,
        # one an empty shell). First id wins; log the duplicate.
        if pair in seen_pairs:
            print(f"fixtures: duplicate for {'/'.join(sorted(pair))} — "
                  f"keeping {seen_pairs[pair]}, skipping {ev['id']}", flush=True)
            continue
        seen_pairs[pair] = str(ev["id"])
        fid_to_game[str(ev["id"])] = g
    if not fid_to_game:
        return fail("no SmartPicks fixtures matched today's slate")
    print(f"fixtures matched: {len(seen_pairs)}/{len(games)} games", flush=True)

    # universe indexes for the identity join
    by_full, by_key = {}, {}
    for p in universe:
        nn = norm_name(p["name"])
        toks = nn.split()
        by_full.setdefault((p["team"], nn), []).append(p)
        if toks:
            by_key.setdefault((p["team"], toks[-1], toks[0][0]), []).append(p)

    players_out = {}
    who = {}
    stats = {"entries": 0, "joined": 0, "no_over": 0, "line_outside_grid": 0,
             "multi_over": 0}
    unmatched, excluded = [], []
    fids = ",".join(sorted(fid_to_game))
    for code, mkt in MARKETS.items():
        try:
            board = fetch_json(PLAYERS_URL.format(code=code, ids=fids),
                               f"players {code}")
        except Exception as e:
            return fail(str(e))
        for ev in board["events"]:
            g = fid_to_game.get(str(ev.get("id")))
            if not g:
                continue
            stats["entries"] += 1
            cs = {str(c.get("id")): c for c in (ev.get("contestant") or [])}
            team_id = str((ev.get("stats") or {}).get("teamId") or "")
            team_code = espn_abbr((cs.get(team_id) or {}).get("code") or "")
            sels = ev.get("selections") or []
            overs = [s for s in sels if s.get("type") == "over"]
            if not overs:
                stats["no_over"] += 1
                continue
            if len(overs) > 1:
                stats["multi_over"] += 1
            sel = overs[0]
            name = sel.get("name") or ""
            if not team_code:
                unmatched.append(f"{name} ({mkt}, no team)")
                continue
            nn = norm_name(name)
            toks = nn.split()
            cands = by_full.get((team_code, nn)) or []
            if len(cands) != 1 and toks:
                key_cands = by_key.get((team_code, toks[-1], toks[0][0])) or []
                if len(key_cands) == 1:
                    cands = key_cands
            if len(cands) != 1:
                unmatched.append(f"{name} ({team_code}, {mkt})")
                continue
            p = cands[0]
            try:
                line = float(str(sel.get("handicap") or "").replace("+", ""))
                dec = float(sel.get("oddsDecimal"))
            except (TypeError, ValueError):
                stats["line_outside_grid"] += 1
                excluded.append(f"{name} ({mkt}, unparseable line/odds)")
                continue
            grid = ((p.get("markets") or {}).get(
                {"PTS": "points", "REB": "rebounds", "AST": "assists",
                 "3PM": "threes"}[mkt]) or {}).get("grid") or {}
            our = grid.get(f"{line:.1f}")
            if our is None:
                stats["line_outside_grid"] += 1
                excluded.append(f"{name} ({mkt}, line {line} outside grid)")
                continue
            entry = {
                "line": line,
                "book": BOOK_DISPLAY.get(sel.get("bookmaker") or "",
                                         sel.get("bookmaker") or ""),
                "odds": sel.get("odds") or "",
                "dec": dec,
                "our": our,
            }
            players_out.setdefault(str(p["pid"]), {})[mkt] = entry
            who[str(p["pid"])] = {"name": p["name"], "team": p["team"],
                                  "opp": p["opp"], "gid": p["gid"]}
            stats["joined"] += 1

    if not players_out:
        return fail("no players joined — degenerate result")

    bonus_note = "skipped"
    if not args.no_bonus:
        try:
            rows, src = load_gamelogs(date)
            if rows is None:
                bonus_note = f"unavailable ({src})"
            else:
                cw = None
                try:
                    with open(CROSSWALK_PATH) as f:
                        cw = json.load(f)
                except Exception:
                    cw = None
                n = cleared_counts(rows, cw, players_out)
                bonus_note = f"{src}; hit10 added to {n} player-markets"
        except Exception as e:
            bonus_note = f"failed soft ({e})"
    print(f"bonus cleared-it: {bonus_note}", flush=True)

    out = {
        "builtAt": datetime.now(timezone.utc).isoformat(),
        "date": date,
        "source": "SmartPicks (Checkd) best-odds feed — best OVER price per player/market",
        "gamesMatched": len(seen_pairs),
        "entries": stats["entries"],
        "joined": stats["joined"],
        "players": players_out,
        "who": who,
    }
    tmp = OUT_FILE + ".tmp"
    with open(tmp, "w") as f:
        json.dump(out, f, indent=1)
    os.replace(tmp, OUT_FILE)

    print(f"entries seen: {stats['entries']} | joined: {stats['joined']} "
          f"player-markets across {len(players_out)} players", flush=True)
    print(f"no-over entries: {stats['no_over']} | multi-over anomalies: "
          f"{stats['multi_over']} | line exclusions: {stats['line_outside_grid']}", flush=True)
    if unmatched:
        print(f"unmatched ({len(unmatched)}): " + "; ".join(sorted(set(unmatched))), flush=True)
    if excluded:
        print("excluded: " + "; ".join(sorted(set(excluded))), flush=True)
    print(f"wrote {OUT_FILE}", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
