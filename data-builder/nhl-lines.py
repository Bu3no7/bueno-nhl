#!/usr/bin/env python3
"""nhl-lines.py — line & pair stability sidecar for the NHL page's Lines view.

Computes, per team, from the NHL's official Time On Ice reports
(www.nhl.com/scores/htmlreports/{season}/T{V,H}{game}.HTM — every player's
shift start/end by period):

  * how many distinct forward lines / defence pairs the team has used at 5v5
    (a unit "counts" in a game once it plays 5+ minutes together), and
  * how often a counted unit stayed together the next game — counted only
    when every player from the unit dressed again (injuries/scratches don't
    count against a team); "stayed together" = 60+ seconds together at 5v5
    in that next game.

DISPLAY ONLY — a read layer like Streaks/Types; feeds no price.

Usage: python3 data-builder/nhl-lines.py [--through YYYY-MM-DD]
Output: data/nhl-lines.json. Reports/rosters/schedule are cached under
data-builder/cache/lines/ so re-runs only fetch new games.
"""
import json, os, re, subprocess, sys, time
from collections import defaultdict

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
CACHE = os.path.join(HERE, "cache", "lines")
REPORTS = os.path.join(CACHE, "reports")
os.makedirs(REPORTS, exist_ok=True)
OUT = os.path.join(ROOT, "data", "nhl-lines.json")
SEASON = "20262027"
UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36"
TEAMS = ["ANA","BOS","BUF","CAR","CBJ","CGY","CHI","COL","DAL","DET","EDM","FLA",
         "LAK","MIN","MTL","NJD","NSH","NYI","NYR","OTT","PHI","PIT","SEA","SJS",
         "STL","TBL","TOR","UTA","VAN","VGK","WPG","WSH"]

THROUGH = None
for i, a in enumerate(sys.argv):
    if a == "--through" and i + 1 < len(sys.argv):
        THROUGH = sys.argv[i + 1]

def curl(url, binary=False):
    r = subprocess.run(["curl", "-s", "-A", UA, "--max-time", "40", url],
                       capture_output=True)
    if r.returncode != 0 or not r.stdout:
        raise RuntimeError(f"curl failed {url}")
    return r.stdout if binary else r.stdout.decode("utf-8", "replace")

def cached_json(name, url):
    p = os.path.join(CACHE, name)
    if os.path.exists(p) and os.path.getsize(p) > 100:
        return json.load(open(p))
    j = json.loads(curl(url))
    json.dump(j, open(p, "w"))
    return j

# ---------------------------------------------------------------- schedule
def load_schedule():
    p = os.path.join(CACHE, "schedule.json")
    if os.path.exists(p):
        games = json.load(open(p))
        if games and (THROUGH is None or games[-1]["date"] >= (THROUGH or "")):
            return games
    games, date = [], "2026-10-05"
    for _ in range(30):
        j = json.loads(curl(f"https://api-web.nhle.com/v1/schedule/{date}"))
        for day in j.get("gameWeek", []):
            for g in day.get("games", []):
                if g.get("gameType") == 2 and g.get("gameState") in ("OFF", "FINAL"):
                    games.append({"id": g["id"], "date": day["date"],
                                  "away": g["awayTeam"]["abbrev"], "home": g["homeTeam"]["abbrev"]})
        nxt = j.get("nextStartDate")
        if not nxt or nxt == date:
            break
        date = nxt
        if THROUGH and date > THROUGH:
            break
    games.sort(key=lambda g: (g["date"], g["id"]))
    json.dump(games, open(p, "w"))
    return games

# ---------------------------------------------------------------- rosters
def load_rosters():
    """team -> sweaterNumber(str) -> {pid, name, last, pos}"""
    p = os.path.join(CACHE, "rosters.json")
    if os.path.exists(p):
        return json.load(open(p))
    out = {}
    for t in TEAMS:
        j = cached_json(f"roster-{t}.json", f"https://api-web.nhle.com/v1/roster/{t}/{SEASON}")
        m = {}
        for grp in ("forwards", "defensemen", "goalies"):
            for pl in j.get(grp, []):
                num = str(pl.get("sweaterNumber", ""))
                if not num:
                    continue
                first = pl["firstName"]["default"]; last = pl["lastName"]["default"]
                m[num] = {"pid": pl["id"], "name": f"{first} {last}", "last": last,
                          "pos": pl.get("positionCode", "G" if grp == "goalies" else "?")}
        out[t] = m
    json.dump(out, open(p, "w"))
    return out

# ---------------------------------------------------------------- reports
HEAD_RE = re.compile(r'class="playerHeading[^"]*"[^>]*>\s*(?:<[^>]+>\s*)*(\d+)\s+([A-ZÀ-Þ\'\-\. ]+),\s*([A-ZÀ-Þ\'\-\. ]+?)\s*<', re.S)
ROW_RE = re.compile(r"<tr[^>]*>(.*?)</tr>", re.S)
CELL_RE = re.compile(r"<td[^>]*>(.*?)</td>", re.S)
TIME_RE = re.compile(r"^(\d+):(\d{2})\s*/")

def fetch_report(gid, side):
    name = f"{gid}-{side}.html"
    p = os.path.join(REPORTS, name)
    if os.path.exists(p) and os.path.getsize(p) > 10000:
        return open(p, encoding="utf-8", errors="replace").read()
    url = f"https://www.nhl.com/scores/htmlreports/{SEASON}/{side}{str(gid)[4:]}.HTM"
    html = curl(url)
    if "Time On Ice Report" not in html:
        raise RuntimeError(f"bad report {url}")
    open(p, "w", encoding="utf-8").write(html)
    return html

def parse_shifts(html):
    """-> {sweaterNumber(str): [(abs_start_s, abs_end_s), ...]}"""
    # split the doc into player blocks by heading positions
    heads = [(m.start(), m.group(1)) for m in HEAD_RE.finditer(html)]
    players = {}
    for idx, (pos0, num) in enumerate(heads):
        end = heads[idx + 1][0] if idx + 1 < len(heads) else len(html)
        block = html[pos0:end]
        shifts = []
        for row in ROW_RE.findall(block):
            cells = [re.sub(r"<[^>]+>|&nbsp;", "", c).strip() for c in CELL_RE.findall(row)]
            if len(cells) < 5 or not cells[1].isdigit():
                continue
            ms, me = TIME_RE.match(cells[2]), TIME_RE.match(cells[3])
            if not ms or not me:
                continue
            per = int(cells[1])
            s = (per - 1) * 1200 + int(ms.group(1)) * 60 + int(ms.group(2))
            e = (per - 1) * 1200 + int(me.group(1)) * 60 + int(me.group(2))
            if e > s:
                shifts.append((s, e))
        if shifts:
            players[num] = shifts
    return players

def game_units(shifts_by_num, roster):
    """-> (units {unit_tuple_pid: seconds}, dressed set of pids) for ONE team."""
    intervals = []  # (pid, pos, start, end)
    dressed = set()
    for num, shifts in shifts_by_num.items():
        info = roster.get(num)
        if not info:
            continue
        pid, pos = info["pid"], info["pos"]
        dressed.add(pid)
        if pos == "G":
            continue
        for s, e in shifts:
            intervals.append((pid, pos, s, e))
    return intervals, dressed

def accumulate(away_int, home_int):
    """Sweep both teams' intervals; at 5v5 accumulate unit TOI per team.
    Returns (away_units, home_units) as {tuple: seconds}."""
    times = sorted({t for _, _, s, e in away_int + home_int for t in (s, e)})
    out = [defaultdict(float), defaultdict(float)]
    for a, b in zip(times, times[1:]):
        if b - a <= 0:
            continue
        mid = (a + b) / 2
        sides = []
        ok = True
        for ints in (away_int, home_int):
            on = [(pid, pos) for pid, pos, s, e in ints if s <= mid < e]
            if len(on) != 5:
                ok = False
                break
            sides.append(on)
        if not ok:
            continue
        for k, on in enumerate(sides):
            f = tuple(sorted(pid for pid, pos in on if pos != "D"))
            d = tuple(sorted(pid for pid, pos in on if pos == "D"))
            if len(f) == 3 and len(d) == 2:
                out[k][("F",) + f] += b - a
                out[k][("D",) + d] += b - a
    return out[0], out[1]

# ---------------------------------------------------------------- main
def main():
    games = load_schedule()
    if THROUGH:
        games = [g for g in games if g["date"] <= THROUGH]
    rosters = load_rosters()
    print(f"games: {len(games)} ({games[0]['date']} .. {games[-1]['date']})")

    # per team: ordered list of {units:{unit:sec}, dressed:set}
    team_games = defaultdict(list)
    pid_name = {}
    for t, m in rosters.items():
        for info in m.values():
            pid_name[info["pid"]] = info
    fails = []
    for i, g in enumerate(games):
        try:
            a_html = fetch_report(g["id"], "TV")
            h_html = fetch_report(g["id"], "TH")
        except Exception as ex:
            fails.append((g["id"], str(ex)[:80]))
            continue
        a_int, a_dressed = game_units(parse_shifts(a_html), rosters[g["away"]])
        h_int, h_dressed = game_units(parse_shifts(h_html), rosters[g["home"]])
        a_units, h_units = accumulate(a_int, h_int)
        team_games[g["away"]].append({"date": g["date"], "units": a_units, "dressed": a_dressed})
        team_games[g["home"]].append({"date": g["date"], "units": h_units, "dressed": h_dressed})
        if (i + 1) % 50 == 0:
            print(f"  {i + 1}/{len(games)}")
        time.sleep(0.05)
    if fails:
        print(f"WARNING: {len(fails)} games failed: {fails[:5]}")

    result = {"builtAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
              "through": games[-1]["date"], "games": len(games), "fwd": {}, "def": {}}
    for kind, tag in (("fwd", "F"), ("def", "D")):
        for team in TEAMS:
            tg = team_games[team]
            used, opps, kept = set(), 0, 0
            season_toi = defaultdict(float)
            unit_games = defaultdict(int)
            for gi, gm in enumerate(tg):
                counted = {u: s for u, s in gm["units"].items() if u[0] == tag and s >= 300}
                for u, s in gm["units"].items():
                    if u[0] == tag:
                        season_toi[u] += s
                for u in counted:
                    used.add(u)
                    unit_games[u] += 1
                if gi + 1 < len(tg):
                    nxt = tg[gi + 1]
                    for u in counted:
                        if all(pid in nxt["dressed"] for pid in u[1:]):
                            opps += 1
                            if nxt["units"].get(u, 0) >= 60:
                                kept += 1
            top = sorted(season_toi.items(), key=lambda kv: -kv[1])[:4 if tag == "F" else 3]
            result[kind][team] = {
                "units": len(used), "kept": kept, "opps": opps,
                "keptPct": (int(1000.0 * kept / opps + 0.5) / 10.0) if opps else None,
                "top": [{"names": [pid_name[p]["last"] for p in u[1:]],
                         "players": [pid_name[p]["name"] for p in u[1:]],
                         "toiMin": round(s / 60), "games": unit_games.get(u, 0)}
                        for u, s in top if s >= 300],
            }
    for kind in ("fwd", "def"):
        rows = [result[kind][t] for t in TEAMS if result[kind][t]["keptPct"] is not None]
        if not rows:
            raise RuntimeError(f"no {kind} rows computed — parse/accumulate produced nothing")
        result.setdefault("league", {})[kind] = {
            "unitsAvg": round(sum(r["units"] for r in rows) / len(rows)),
            "keptAvg": round(sum(r["keptPct"] for r in rows) / len(rows)),
        }
    json.dump(result, open(OUT, "w"), indent=1)
    print("wrote", OUT)
    for kind in ("fwd", "def"):
        rows = sorted(TEAMS, key=lambda t: -result[kind][t]["units"])
        print(kind, "most:", [(t, result[kind][t]["units"], result[kind][t]["keptPct"]) for t in rows[:3]],
              "| fewest:", [(t, result[kind][t]["units"], result[kind][t]["keptPct"]) for t in rows[-3:]])
    print("league:", result["league"])

if __name__ == "__main__":
    main()
