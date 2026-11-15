#!/usr/bin/env python3
"""NHL best book — best anytime-goalscorer price per skater (SmartPicks feed).

Builds data/nhl-bestbook.json: for every skater on the latest slate
who has a book price, the single best odds line across bet365 /
BetMGM / DraftKings / Fanatics, from the SmartPicks (Checkd) feed —
odds-api.checkd-dev.com, no auth. Per player we keep ONLY the book
name, the American odds and the decimal odds. Their hit rates are
deliberately NOT stored: our own streaks sidecar (nhl-streaks.py,
NHL game logs) covers those.

Join discipline: their events are matched to bundle games by
team-code pairing (never by date string — their dates are UTC), and
their players are joined to bundle skaters by IDENTITY (team +
normalized last name + first initial), with same-name collisions
(Vancouver's two Elias Petterssons) disambiguated by position.
Unmatched or ambiguous names are logged, never force-fit.

DISPLAY ONLY — a market reference beside our own fair price; nothing
here feeds a price anywhere.

FAIL-SOFT CONTRACT: on any fetch/parse failure, or a degenerate
result (no matched games, no joined players), the script exits
non-zero WITHOUT touching an existing sidecar. The new file is
written to a temp path and atomically renamed over the old one only
after the full build succeeds.

Usage: python3 data-builder/nhl-bestbook.py [--bundle data/YYYY-MM-DD.json]
"""
import argparse, json, os, re, subprocess, sys, time, unicodedata

HERE = os.path.dirname(os.path.abspath(__file__))
SITE = os.path.dirname(HERE)
API = "https://odds-api.checkd-dev.com/prod"
FIXTURES_URL = API + "/flashpicks/smartpicks/fixtures?competition=NHL&date=3days"
PLAYERS_URL = API + "/flashpicks/smartpicks/players?market=HP1%2BG&basedOn=season&fixtures={ids}"
ROSTER_URL = "https://api-web.nhle.com/v1/roster/{team}/20262027"
OUT_FILE = os.path.join(SITE, "data", "nhl-bestbook.json")

BOOK_DISPLAY = {"bet365": "bet365", "betmgm": "BetMGM",
                "draftkings": "DraftKings", "fanatics": "Fanatics"}
POS_NORM = {"RW": "R", "LW": "L", "C": "C", "D": "D", "G": "G",
            "R": "R", "L": "L"}


def fail(msg):
    print(f"bestbook: FAILED — {msg}; existing sidecar left untouched", flush=True)
    return 1


def fetch_json(url, what):
    r = subprocess.run(["curl", "-s", "--max-time", "30", "-H",
                        "User-Agent: Mozilla/5.0", url],
                       capture_output=True, text=True, timeout=40)
    if r.returncode != 0 or not r.stdout:
        raise RuntimeError(f"{what}: curl failed (rc={r.returncode})")
    d = json.loads(r.stdout)
    if not isinstance(d, dict) or d.get("code") != 0 or not isinstance(d.get("events"), list):
        raise RuntimeError(f"{what}: unexpected payload shape")
    return d


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
            }


def universe(bundle):
    """Slate skaters (same construction as nhl-streaks.py): bundle
    rosters, slate teams missing from the bundle filled from the NHL
    roster endpoint."""
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
                print(f"universe: {team} roster filled from NHL API", flush=True)
        except Exception as e:
            print(f"universe: {team} roster fill failed ({e})", flush=True)
    return out


def norm_name(s):
    s = unicodedata.normalize("NFKD", s).encode("ascii", "ignore").decode()
    return re.sub(r"[^a-z ]", "", s.lower()).strip()


def ident_key(name, team):
    parts = norm_name(name).split()
    return (team, parts[-1], parts[0][0]) if parts else (team, "", "")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--bundle", default=None)
    args = ap.parse_args()

    bundle_path = args.bundle or latest_bundle()
    bundle = json.load(open(bundle_path))
    uni = universe(bundle)
    by_key = {}
    for pid, u in uni.items():
        by_key.setdefault(ident_key(u["name"], u["team"]), []).append(u)

    bundle_pairs = {(g["away"], g["home"]) for g in bundle.get("games", [])}
    print(f"bundle {os.path.basename(bundle_path)} - universe {len(uni)} skaters, "
          f"{len(bundle_pairs)} games", flush=True)

    try:
        fx = fetch_json(FIXTURES_URL, "fixtures")
    except Exception as e:
        return fail(str(e))
    matched_ids, matched_pairs = [], set()
    for ev in fx["events"]:
        codes = {c.get("position"): c.get("code") for c in ev.get("contestant", [])}
        pair = (codes.get("away"), codes.get("home"))
        if pair in bundle_pairs:
            matched_ids.append(str(ev["id"]))
            matched_pairs.add(pair)
    print(f"fixtures: {len(fx['events'])} events, {len(matched_ids)} matched to bundle games "
          f"({len(matched_pairs)}/{len(bundle_pairs)} pairs)", flush=True)
    if not matched_ids or len(matched_pairs) < len(bundle_pairs):
        return fail(f"only {len(matched_pairs)}/{len(bundle_pairs)} bundle games matched in their fixtures")

    try:
        board = fetch_json(PLAYERS_URL.format(ids=",".join(matched_ids)), "players")
    except Exception as e:
        return fail(str(e))
    print(f"players board: {len(board['events'])} entries", flush=True)
    if not board["events"]:
        return fail("players board came back empty")

    players, unmatched, ambiguous = {}, [], []
    for e in board["events"]:
        sels = e.get("selections") or []
        if not sels:
            continue
        sel = sels[0]
        st = e.get("stats") or {}
        team = None
        for c in e.get("contestant", []):
            if c.get("id") == st.get("teamId"):
                team = c.get("code")
        if not team or not sel.get("bookmaker") or not sel.get("odds"):
            unmatched.append(sel.get("name", "?"))
            continue
        cands = by_key.get(ident_key(sel["name"], team), [])
        pick = None
        if len(cands) == 1:
            pick = cands[0]
        elif len(cands) > 1:
            their_pos = POS_NORM.get(sel.get("positionAbbreviation") or "", "")
            same_pos = [u for u in cands if u["pos"] == their_pos]
            if len(same_pos) == 1:
                pick = same_pos[0]
            else:
                ambiguous.append(f"{sel['name']} ({team})")
                continue
        if pick is None:
            unmatched.append(f"{sel['name']} ({team})")
            continue
        try:
            dec = float(sel.get("oddsDecimal"))
        except (TypeError, ValueError):
            unmatched.append(f"{sel['name']} ({team})")
            continue
        if not dec > 1.0:
            unmatched.append(f"{sel['name']} ({team})")
            continue
        players[str(pick["pid"])] = {
            "book": BOOK_DISPLAY.get(sel["bookmaker"].lower(), sel["bookmaker"]),
            "odds": str(sel["odds"]),
            "dec": dec,
        }

    print(f"join: {len(players)}/{len(board['events'])} entries joined to bundle skaters", flush=True)
    if unmatched:
        print(f"unmatched ({len(unmatched)}): {', '.join(unmatched[:12])}", flush=True)
    if ambiguous:
        print(f"ambiguous, skipped ({len(ambiguous)}): {', '.join(ambiguous[:12])}", flush=True)
    if not players:
        return fail("zero players joined — refusing to write an empty sidecar")

    out = {
        "builtAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "bundleDate": bundle.get("date"),
        "source": "Best anytime-goalscorer odds (bet365/BetMGM/DraftKings/Fanatics) via SmartPicks - display only",
        "gamesMatched": len(matched_pairs),
        "entries": len(board["events"]),
        "joined": len(players),
        "players": players,
    }
    tmp = OUT_FILE + ".tmp"
    json.dump(out, open(tmp, "w"), indent=1)
    os.replace(tmp, OUT_FILE)
    print(f"wrote {OUT_FILE}: {len(players)} players, {os.path.getsize(OUT_FILE)/1024:.0f} KB", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
