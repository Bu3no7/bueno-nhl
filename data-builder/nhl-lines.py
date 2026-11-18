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
PBP_DIR = os.path.join(CACHE, "pbp")
os.makedirs(PBP_DIR, exist_ok=True)
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

def fetch_pbp(gid):
    p = os.path.join(PBP_DIR, f"{gid}.json")
    if os.path.exists(p) and os.path.getsize(p) > 1000:
        return json.load(open(p))
    j = json.loads(curl(f"https://api-web.nhle.com/v1/gamecenter/{gid}/play-by-play"))
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

def accumulate_extra(away_int, home_int):
    """Parallel sweep over the same breakpoints. Returns (away, home) dicts:
    psec {pid: 5v5 seconds} (exact-5v5 intervals only), pp {skater tuple: sec}
    and pk {skater tuple: sec} for man-advantage splits (5,4)/(5,3)/(4,3) in
    either orientation, plus ppTot / pkTot team seconds."""
    times = sorted({t for _, _, s, e in away_int + home_int for t in (s, e)})
    out = [{"psec": defaultdict(float), "pp": defaultdict(float),
            "pk": defaultdict(float), "ppTot": 0.0, "pkTot": 0.0} for _ in range(2)]
    for a, b in zip(times, times[1:]):
        if b - a <= 0:
            continue
        mid = (a + b) / 2
        ons = [tuple(sorted(pid for pid, pos, s, e in ints if s <= mid < e))
               for ints in (away_int, home_int)]
        na, nh = len(ons[0]), len(ons[1])
        if na == 5 and nh == 5:
            for k in range(2):
                for pid in ons[k]:
                    out[k]["psec"][pid] += b - a
        else:
            for adv, dfn, counts in ((0, 1, (na, nh)), (1, 0, (nh, na))):
                if counts in ((5, 4), (5, 3), (4, 3)):
                    out[adv]["pp"][ons[adv]] += b - a
                    out[adv]["ppTot"] += b - a
                    out[dfn]["pk"][ons[dfn]] += b - a
                    out[dfn]["pkTot"] += b - a
                    break
    return out[0], out[1]

def process_goals(pbp, away_int, home_int, away_ab, home_ab,
                  player_stats, unit_goals, counters):
    """Credit 5v5 GF/GA (both goalies in net, per situationCode) to the skaters
    on the ice at the goal's absolute time, and to each side's exact on-ice
    F trio / D pair. counters tracks the scorer-on-ice self-check."""
    sides = [(away_int, away_ab), (home_int, home_ab)]
    id2side = {pbp["awayTeam"]["id"]: 0, pbp["homeTeam"]["id"]: 1}
    for play in pbp.get("plays", []):
        if play.get("typeDescKey") != "goal":
            continue
        pd = play.get("periodDescriptor", {})
        if pd.get("periodType") == "SO" or pd.get("number", 99) > 4:
            continue
        code = play.get("situationCode") or ""
        if len(code) != 4 or code[0] != "1" or code[1] != "5" or code[2] != "5" or code[3] != "1":
            continue
        m = re.match(r"^(\d+):(\d{2})$", play.get("timeInPeriod", ""))
        if not m:
            continue
        t = (pd["number"] - 1) * 1200 + int(m.group(1)) * 60 + int(m.group(2))
        det = play.get("details", {})
        si = id2side.get(det.get("eventOwnerTeamId"))
        if si is None:
            continue
        counters["total"] += 1
        # On-ice at a goal uses s < t <= e, NOT s <= t <= e: the clock stops
        # at the goal, so the off-going unit's shifts END at t and the next
        # unit's shifts START at t (the ensuing faceoff). Inclusive both ends
        # credits ~17 skaters/goal (both units); s <= t < e loses the scorer
        # 74% of the time. s < t <= e keeps the scorer and gives (5,5) sets
        # on ~80% of goals (rest = mid-play changes in progress).
        on = [{pid: pos for pid, pos, s, e in ints if s < t <= e} for ints, _ in sides]
        if det.get("scoringPlayerId") not in on[si]:
            counters["miss"] += 1
        for k in range(2):
            ab = sides[k][1]
            for pid in on[k]:
                player_stats[ab][pid][1 if k == si else 2] += 1
            f = tuple(sorted(pid for pid, pos in on[k].items() if pos != "D"))
            dd = tuple(sorted(pid for pid, pos in on[k].items() if pos == "D"))
            for key in (("F",) + f, ("D",) + dd):
                unit_goals[ab][key][0 if k == si else 1] += 1

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
    # season accumulators for the scored-on / PP-PK layers
    player_stats = defaultdict(lambda: defaultdict(lambda: [0.0, 0, 0]))  # team -> pid -> [5v5 sec, gf, ga]
    unit_goals = defaultdict(lambda: defaultdict(lambda: [0, 0]))         # team -> unit -> [gf, ga]
    pp_sets = defaultdict(lambda: defaultdict(float))
    pk_sets = defaultdict(lambda: defaultdict(float))
    pp_tot = defaultdict(float)
    pk_tot = defaultdict(float)
    goal_check = {"total": 0, "miss": 0}
    pbp_fails = []
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
        a_ex, h_ex = accumulate_extra(a_int, h_int)
        for ab, ex in ((g["away"], a_ex), (g["home"], h_ex)):
            for pid, sec in ex["psec"].items():
                player_stats[ab][pid][0] += sec
            for tup, sec in ex["pp"].items():
                pp_sets[ab][tup] += sec
            for tup, sec in ex["pk"].items():
                pk_sets[ab][tup] += sec
            pp_tot[ab] += ex["ppTot"]
            pk_tot[ab] += ex["pkTot"]
        try:
            process_goals(fetch_pbp(g["id"]), a_int, h_int, g["away"], g["home"],
                          player_stats, unit_goals, goal_check)
        except Exception as ex:
            pbp_fails.append((g["id"], str(ex)[:80]))
        team_games[g["away"]].append({"date": g["date"], "units": a_units, "dressed": a_dressed})
        team_games[g["home"]].append({"date": g["date"], "units": h_units, "dressed": h_dressed})
        if (i + 1) % 50 == 0:
            print(f"  {i + 1}/{len(games)}")
        time.sleep(0.05)
    if fails:
        print(f"WARNING: {len(fails)} games failed: {fails[:5]}")
    if pbp_fails:
        print(f"WARNING: {len(pbp_fails)} games missing pbp (goals skipped): {pbp_fails[:5]}")
    gt, gm = goal_check["total"], goal_check["miss"]
    grate = (100.0 * gm / gt) if gt else 0.0
    print(f"5v5 goals: {gt}, scorer-not-on-ice misses: {gm} ({grate:.2f}%)")
    if gt and gm / gt > 0.02:
        raise RuntimeError(f"scorer on-ice miss rate {grate:.2f}% > 2% — refusing to ship")

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
            top_rows = []
            for u, s in top:
                if s < 300:
                    continue
                ugf, uga = unit_goals[team].get(u, [0, 0])
                top_rows.append({"names": [pid_name[p]["last"] for p in u[1:]],
                                 "players": [pid_name[p]["name"] for p in u[1:]],
                                 "toiMin": round(s / 60), "games": unit_games.get(u, 0),
                                 "gf": ugf, "ga": uga,
                                 "gf60": round(ugf * 3600 / s, 2),
                                 "ga60": round(uga * 3600 / s, 2)})
            result[kind][team] = {
                "units": len(used), "kept": kept, "opps": opps,
                "keptPct": (int(1000.0 * kept / opps + 0.5) / 10.0) if opps else None,
                "top": top_rows,
            }
    for kind in ("fwd", "def"):
        rows = [result[kind][t] for t in TEAMS if result[kind][t]["keptPct"] is not None]
        if not rows:
            raise RuntimeError(f"no {kind} rows computed — parse/accumulate produced nothing")
        result.setdefault("league", {})[kind] = {
            "unitsAvg": round(sum(r["units"] for r in rows) / len(rows)),
            "keptAvg": round(sum(r["keptPct"] for r in rows) / len(rows)),
        }

    # ------------------------------------------------ scored-on + PP/PK sets
    uni = []
    for team in TEAMS:
        for pid, (sec, gf, ga) in player_stats[team].items():
            if sec >= 9000:
                info = pid_name.get(pid, {})
                uni.append({"pid": pid, "name": info.get("name", str(pid)),
                            "last": info.get("last", ""), "team": team,
                            "pos": info.get("pos", "?"), "min": round(sec / 60),
                            "ga": ga, "gf": gf,
                            "ga60": round(ga * 3600 / sec, 2),
                            "gf60": round(gf * 3600 / sec, 2), "_sec": sec})
    most = sorted(uni, key=lambda r: (-r["ga60"], -r["_sec"]))[:8]
    fewest = sorted(uni, key=lambda r: (r["ga60"], -r["_sec"]))[:8]
    for r in most + fewest:
        r.pop("_sec", None)
    result["scoredOn"] = {"floorMin": 150, "most": most, "fewest": fewest}

    def set_rows(sets, total):
        rows = []
        for tup, sec in sorted(sets.items(), key=lambda kv: -kv[1]):
            if sec < 120:
                continue
            rows.append({"names": [pid_name[p]["last"] for p in tup],
                         "players": [pid_name[p]["name"] for p in tup],
                         "toiMin": round(sec / 60),
                         "share": (int(1000.0 * sec / total + 0.5) / 10.0) if total else None})
            if len(rows) == 2:
                break
        return rows

    result["pppk"] = {t: {"pp": set_rows(pp_sets[t], pp_tot[t]),
                          "pk": set_rows(pk_sets[t], pk_tot[t])} for t in TEAMS}
    if len(most) < 8 or len(fewest) < 8:
        raise RuntimeError(f"scoredOn rows too few: most={len(most)} fewest={len(fewest)}")
    missing = [t for t in TEAMS if t not in result["pppk"]]
    if missing:
        raise RuntimeError(f"pppk missing teams: {missing}")
    json.dump(result, open(OUT, "w"), indent=1)
    print("wrote", OUT)
    for kind in ("fwd", "def"):
        rows = sorted(TEAMS, key=lambda t: -result[kind][t]["units"])
        print(kind, "most:", [(t, result[kind][t]["units"], result[kind][t]["keptPct"]) for t in rows[:3]],
              "| fewest:", [(t, result[kind][t]["units"], result[kind][t]["keptPct"]) for t in rows[-3:]])
    print("league:", result["league"])
    print("scoredOn most:", [(r["name"], r["team"], r["min"], r["ga"], r["ga60"]) for r in result["scoredOn"]["most"]])
    print("scoredOn fewest:", [(r["name"], r["team"], r["min"], r["ga"], r["ga60"]) for r in result["scoredOn"]["fewest"]])
    print("pppk EDM:", result["pppk"]["EDM"])
    print("EDM fwd top[0]:", result["fwd"]["EDM"]["top"][0] if result["fwd"]["EDM"]["top"] else None)

if __name__ == "__main__":
    main()
