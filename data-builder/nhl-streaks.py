#!/usr/bin/env python3
"""NHL streaks — hit-rate boards from OUR OWN game logs (NHL API only).

Builds data/nhl-streaks.json: for every skater on the latest slate,
how often he has actually scored this season — games with >= 1 goal
over games played — across windows: season, last 20, last 10, last 5,
home only, away only, plus a last-5 form array (chronological).

The concept is a streak sheet (scored-in rates), NOT a projection:
raw counts only in the file; percentages are computed at display time.
Data source is the official NHL API game-log route, pulled keyless
with curl (the VM's egress proxy truncates urllib chunked reads; curl
is the house pattern). Shootout goals never appear in the game-log
goals field, so they never count. DISPLAY ONLY — nothing here feeds
a price anywhere.

Re-runnable: game-log payloads are cached under
data-builder/cache/gamelogs/ (fresh < 6 h = reused).

Usage: python3 data-builder/nhl-streaks.py [--bundle data/YYYY-MM-DD.json]
       [--no-cache]
"""
import argparse, json, math, os, subprocess, sys, time
from concurrent.futures import ThreadPoolExecutor

HERE = os.path.dirname(os.path.abspath(__file__))
SITE = os.path.dirname(HERE)
GAMELOG_URL = "https://api-web.nhle.com/v1/player/{pid}/game-log/20262027/2"
ROSTER_URL = "https://api-web.nhle.com/v1/roster/{team}/20262027"
CACHE_DIR = os.path.join(HERE, "cache", "gamelogs")
OUT_FILE = os.path.join(SITE, "data", "nhl-streaks.json")
CACHE_MAX_AGE = 6 * 3600

# Correctness anchors: scored-in / GP from the official game logs,
# hand-verified 2026-11-15. If these move, the GP denominator or the
# goals field changed meaning — stop and look before shipping.
ANCHORS = {8477934: (12, 21),   # Leon Draisaitl
           8478402: (9, 21),    # Connor McDavid
           8480803: (9, 21),    # Evan Bouchard
           8478109: (5, 8)}     # Victor Olofsson


def latest_bundle():
    cands = sorted(f for f in os.listdir(os.path.join(SITE, "data"))
                   if len(f) == 15 and f[:4].isdigit() and f.endswith(".json"))
    return os.path.join(SITE, "data", cands[-1])


def _add_roster(out, team, roster):
    for grp in ("forwards", "defensemen"):
        for p in roster.get(grp, []):
            out[int(p["id"])] = {
                "pid": int(p["id"]),
                "name": f"{p['firstName']['default']} {p['lastName']['default']}",
                "team": team, "pos": p["positionCode"],
                "headshot": p.get("headshot"),
            }


def universe(bundle):
    """Skaters on today's slate: bundle rosters first, any slate team
    missing from the bundle rosters filled from the NHL roster
    endpoint (same fix as nhl-types.py — a bundle built ahead of a
    game can ship without a team's roster block)."""
    out = {}
    rosters = bundle.get("rosters") or {}
    for team, roster in rosters.items():
        _add_roster(out, team, roster)
    slate_teams = set()
    for g in bundle.get("games", []):
        if g.get("away"):
            slate_teams.add(g["away"])
        if g.get("home"):
            slate_teams.add(g["home"])
    for team in sorted(slate_teams - set(rosters)):
        try:
            r = subprocess.run(["curl", "-s", "--max-time", "20", "-H",
                                "User-Agent: Mozilla/5.0",
                                ROSTER_URL.format(team=team)],
                               capture_output=True, text=True, timeout=30)
            d = json.loads(r.stdout)
            if d.get("forwards") or d.get("defensemen"):
                _add_roster(out, team, d)
                print(f"universe: {team} roster filled from NHL API "
                      f"(missing from bundle rosters)", flush=True)
            else:
                print(f"universe: {team} roster fetch returned no skaters", flush=True)
        except Exception as e:
            print(f"universe: {team} roster fill failed ({e})", flush=True)
    return out


def fetch_gamelog(pid, use_cache=True):
    path = os.path.join(CACHE_DIR, f"{pid}.json")
    if use_cache and os.path.exists(path) and time.time() - os.path.getmtime(path) < CACHE_MAX_AGE:
        try:
            return json.load(open(path))
        except Exception:
            pass
    url = GAMELOG_URL.format(pid=pid)
    for attempt in range(2):
        try:
            r = subprocess.run(["curl", "-s", "--max-time", "20", "-H",
                                "User-Agent: Mozilla/5.0", url],
                               capture_output=True, text=True, timeout=30)
            d = json.loads(r.stdout)
            if isinstance(d.get("gameLog"), list):
                os.makedirs(CACHE_DIR, exist_ok=True)
                json.dump(d, open(path, "w"))
                return d
        except Exception:
            pass
        time.sleep(0.4)
    return None


def window(games):
    return {"gp": len(games),
            "scored": sum(1 for g in games if (g.get("goals") or 0) >= 1)}


def with_pct(w):
    w = dict(w)
    # half-up rounding (not Python's banker's rounding) so the stored
    # pct matches what a reader computes from the counts by hand
    w["pct"] = math.floor(100.0 * w["scored"] / w["gp"] * 10 + 0.5) / 10 if w["gp"] else 0.0
    return w


def streaks_of(gamelog):
    """gamelog payload -> streak entry (windows + form), or None.
    The API returns the log newest-first; every window slices that
    order, and the form array is the last 5 games flipped back to
    chronological."""
    games = gamelog.get("gameLog") or []
    if not games:
        return None
    season = window(games)
    windows = {
        "season": with_pct(season),
        "l20": with_pct(window(games[:20])),
        "l10": with_pct(window(games[:10])),
        "l5": with_pct(window(games[:5])),
        "home": with_pct(window([g for g in games if g.get("homeRoadFlag") == "H"])),
        "away": with_pct(window([g for g in games if g.get("homeRoadFlag") == "R"])),
    }
    form = [(g.get("goals") or 0) >= 1 for g in reversed(games[:5])]
    return {"gp": season["gp"], "scored": season["scored"],
            "windows": windows, "form": form}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--bundle", default=None)
    ap.add_argument("--no-cache", action="store_true")
    args = ap.parse_args()

    bundle_path = args.bundle or latest_bundle()
    bundle = json.load(open(bundle_path))
    uni = universe(bundle)
    bundle_pids = set(bundle.get("players") or {})
    print(f"bundle {os.path.basename(bundle_path)} - universe {len(uni)} skaters "
          f"({sum(1 for pid in uni if str(pid) in bundle_pids)} also in bundle players map)",
          flush=True)

    with ThreadPoolExecutor(max_workers=6) as ex:
        logs = dict(zip(uni.keys(), ex.map(lambda pid: fetch_gamelog(pid, not args.no_cache), uni.keys())))
    got = sum(1 for v in logs.values() if v)
    failed = [uni[pid]["name"] for pid, v in logs.items() if not v]
    print(f"game logs: {got}/{len(uni)} ok, {len(failed)} failed"
          + (f" ({', '.join(failed[:8])})" if failed else ""), flush=True)

    players = {}
    for pid, u in uni.items():
        if not logs.get(pid):
            continue
        s = streaks_of(logs[pid])
        if not s:
            continue
        players[str(pid)] = {"name": u["name"], "team": u["team"], "pos": u["pos"],
                             "headshot": u["headshot"], **s}

    out = {
        "builtAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "bundleDate": bundle.get("date"),
        "season": "20262027",
        "source": "NHL API game logs (api-web.nhle.com), scored-in rates - display only, not a price input",
        "universe": len(uni), "covered": len(players), "failed": len(failed),
        "players": players,
    }
    json.dump(out, open(OUT_FILE, "w"), indent=1)
    size = os.path.getsize(OUT_FILE)
    print(f"wrote {OUT_FILE}: {len(players)} players, {size/1024:.0f} KB", flush=True)

    bad = []
    for pid, (want_scored, want_gp) in ANCHORS.items():
        e = players.get(str(pid))
        got_pair = (e["scored"], e["gp"]) if e else None
        if got_pair != (want_scored, want_gp):
            bad.append((uni.get(pid, {}).get("name", pid), (want_scored, want_gp), got_pair))
    if bad:
        print("ANCHOR MISMATCH:", bad)
        return 1
    print("anchors OK:", {uni[pid]["name"]: f"{players[str(pid)]['scored']}/{players[str(pid)]['gp']}"
                          for pid in ANCHORS})
    return 0


if __name__ == "__main__":
    sys.exit(main())
