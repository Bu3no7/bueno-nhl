#!/usr/bin/env python3
"""nhl-heat.py — Heat Check sidecar for NHL player cards.

Per skater, 5v5, season to date: on-ice shots for/against (shots ON GOAL
only — shot-on-goal + goal events), on-ice goals for/against, on-ice
SH% = GF/SF, on-ice SV% = 1 - GA/SA, PDO = SH% + SV% (x100 scale) and
the player's league percentile for on-ice SH% among floor-clearing
skaters. Players under the sample floor (200 min 5v5 TOI or 120 on-ice
SF) are simply absent from the file.

Built exactly like nhl-lines.py: shifts come from the NHL's official
Time On Ice reports (shared cache under data-builder/cache/lines/),
events from the keyless NHL API play-by-play, and a player is on ice
for an event when a shift satisfies s < t <= e (the goal-attribution
rule the Lines builder validated). 5v5 = situationCode '1551' (both
goalies in, five skaters a side); empty-net and special-teams codes
are excluded. Skaters only.

DISPLAY ONLY — a read layer like Streaks/Types/Lines; feeds no price.

Usage: python3 data-builder/nhl-heat.py [--through YYYY-MM-DD]
Output: data/nhl-heat.json.
"""
import json, os, re, subprocess, sys, time
from collections import defaultdict

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
CACHE = os.path.join(HERE, "cache", "lines")   # shared with nhl-lines.py
REPORTS = os.path.join(CACHE, "reports")
os.makedirs(REPORTS, exist_ok=True)
PBP_DIR = os.path.join(CACHE, "pbp")
os.makedirs(PBP_DIR, exist_ok=True)
OUT = os.path.join(ROOT, "data", "nhl-heat.json")
SEASON = "20262027"
UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36"
TEAMS = ["ANA","BOS","BUF","CAR","CBJ","CGY","CHI","COL","DAL","DET","EDM","FLA",
         "LAK","MIN","MTL","NJD","NSH","NYI","NYR","OTT","PHI","PIT","SEA","SJS",
         "STL","TBL","TOR","UTA","VAN","VGK","WPG","WSH"]
FLOOR_MIN = 200.0    # 5v5 TOI minutes
FLOOR_SF = 120       # on-ice shots for
HOT_SH = 12.5        # on-ice SH% tag bands (percent)
DUE_SH = 7.5

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

def fetch_pbp(gid):
    p = os.path.join(PBP_DIR, f"{gid}.json")
    if os.path.exists(p) and os.path.getsize(p) > 1000:
        return json.load(open(p))
    j = json.loads(curl(f"https://api-web.nhle.com/v1/gamecenter/{gid}/play-by-play"))
    json.dump(j, open(p, "w"))
    return j

# ---------------------------------------------------------------- schedule
def load_schedule():
    """Fresh walk each run (a handful of weekly pages); also refreshes the
    shared cache file nhl-lines.py reads, in its format."""
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
    json.dump(games, open(os.path.join(CACHE, "schedule.json"), "w"))
    return games

# ---------------------------------------------------------------- rosters
def load_rosters():
    """team -> sweaterNumber(str) -> {pid, name, last, pos}.
    Reuses the shared cache when it was written today; otherwise rebuilds
    it fresh (a traded player's new team must know his sweater)."""
    p = os.path.join(CACHE, "rosters.json")
    if os.path.exists(p) and time.strftime("%Y-%m-%d", time.localtime(os.path.getmtime(p))) == time.strftime("%Y-%m-%d"):
        return json.load(open(p))
    out = {}
    for t in TEAMS:
        j = json.loads(curl(f"https://api-web.nhle.com/v1/roster/{t}/{SEASON}"))
        json.dump(j, open(os.path.join(CACHE, f"roster-{t}.json"), "w"))
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
    """-> (skater intervals [(pid, pos, start, end)], dressed pids) for ONE team."""
    intervals, dressed = [], set()
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

def psec_5v5(away_int, home_int):
    """Exact-5v5 seconds per skater (both sides at five skaters), swept the
    same way as nhl-lines.py's accumulate_extra."""
    times = sorted({t for _, _, s, e in away_int + home_int for t in (s, e)})
    out = [defaultdict(float), defaultdict(float)]
    for a, b in zip(times, times[1:]):
        if b - a <= 0:
            continue
        mid = (a + b) / 2
        ons = [tuple(pid for pid, pos, s, e in ints if s <= mid < e)
               for ints in (away_int, home_int)]
        if len(ons[0]) == 5 and len(ons[1]) == 5:
            for k in range(2):
                for pid in ons[k]:
                    out[k][pid] += b - a
    return out[0], out[1]

def process_events(pbp, away_int, home_int, stats, counters):
    """Credit 5v5 shots on goal (shot-on-goal + goal plays, situationCode
    1551) to the skaters on the ice: SF/GF to the shooting side, SA/GA to
    the other side. On-ice = a shift with s < t <= e."""
    sides = [away_int, home_int]
    id2side = {pbp["awayTeam"]["id"]: 0, pbp["homeTeam"]["id"]: 1}
    for play in pbp.get("plays", []):
        tk = play.get("typeDescKey")
        if tk not in ("shot-on-goal", "goal"):
            continue
        pd = play.get("periodDescriptor", {})
        if pd.get("periodType") == "SO" or pd.get("number", 99) > 4:
            continue
        if (play.get("situationCode") or "") != "1551":
            continue
        m = re.match(r"^(\d+):(\d{2})$", play.get("timeInPeriod", ""))
        if not m:
            continue
        t = (pd["number"] - 1) * 1200 + int(m.group(1)) * 60 + int(m.group(2))
        det = play.get("details", {})
        si = id2side.get(det.get("eventOwnerTeamId"))
        if si is None:
            continue
        on = [{pid for pid, pos, s, e in ints if s < t <= e} for ints in sides]
        shooter = det.get("scoringPlayerId") if tk == "goal" else det.get("shootingPlayerId")
        counters[tk]["total"] += 1
        if shooter is not None and shooter not in on[si]:
            counters[tk]["miss"] += 1
        for pid in on[si]:
            stats[pid]["sf"] += 1
            if tk == "goal":
                stats[pid]["gf"] += 1
        for pid in on[1 - si]:
            stats[pid]["sa"] += 1
            if tk == "goal":
                stats[pid]["ga"] += 1

# ---------------------------------------------------------------- main
def main():
    games = load_schedule()
    if THROUGH:
        games = [g for g in games if g["date"] <= THROUGH]
    rosters = load_rosters()
    print(f"games: {len(games)} ({games[0]['date']} .. {games[-1]['date']})")
    pid_name = {}
    for t, m in rosters.items():
        for info in m.values():
            pid_name[info["pid"]] = info

    stats = defaultdict(lambda: {"sec": 0.0, "sf": 0, "gf": 0, "sa": 0, "ga": 0, "team": None})
    counters = {"goal": {"total": 0, "miss": 0}, "shot-on-goal": {"total": 0, "miss": 0}}
    fails = []
    for i, g in enumerate(games):
        try:
            a_html = fetch_report(g["id"], "TV")
            h_html = fetch_report(g["id"], "TH")
            pbp = fetch_pbp(g["id"])
        except Exception as ex:
            fails.append((g["id"], str(ex)[:80]))
            continue
        a_int, _ = game_units(parse_shifts(a_html), rosters[g["away"]])
        h_int, _ = game_units(parse_shifts(h_html), rosters[g["home"]])
        a_sec, h_sec = psec_5v5(a_int, h_int)
        for ab, secs in ((g["away"], a_sec), (g["home"], h_sec)):
            for pid, sec in secs.items():
                stats[pid]["sec"] += sec
                stats[pid]["team"] = ab
        process_events(pbp, a_int, h_int, stats, counters)
        if (i + 1) % 50 == 0:
            print(f"  {i + 1}/{len(games)}")
        time.sleep(0.05)
    if fails:
        print(f"WARNING: {len(fails)} games skipped (report/pbp fetch failed): {fails[:5]}")
    for tk, c in counters.items():
        rate = (100.0 * c["miss"] / c["total"]) if c["total"] else 0.0
        print(f"{tk}: {c['total']} events, shooter-not-on-ice {c['miss']} ({rate:.2f}%)")

    rows = {}
    for pid, s in stats.items():
        toi = s["sec"] / 60.0
        if toi < FLOOR_MIN or s["sf"] < FLOOR_SF or s["sa"] < 1:
            continue
        info = pid_name.get(pid, {})
        sh = 100.0 * s["gf"] / s["sf"]
        sv = 100.0 * (1 - s["ga"] / s["sa"])
        rows[pid] = {"name": info.get("name", str(pid)), "team": s["team"],
                     "toi": round(toi), "sf": s["sf"], "gf": s["gf"],
                     "shPct": round(sh, 1), "sa": s["sa"], "ga": s["ga"],
                     "svPct": round(sv, 1), "pdo": round(sh + sv, 1),
                     "tag": "HOT" if sh >= HOT_SH else "DUE" if sh <= DUE_SH else None}
    n = len(rows)
    for pid, r in rows.items():
        below = sum(1 for q in rows.values() if q["shPct"] < r["shPct"])
        r["pct"] = int(100.0 * below / (n - 1) + 0.5) if n > 1 else 100
    # stable key order in the file: hottest first reads best in a diff
    players = {str(pid): rows[pid] for pid in sorted(rows, key=lambda p: -rows[p]["shPct"])}
    result = {"generated": time.strftime("%Y-%m-%d"), "through": games[-1]["date"],
              "games": len(games), "players": players}
    json.dump(result, open(OUT, "w"), indent=1)
    print(f"wrote {OUT}: {n} players over the floor ({FLOOR_MIN:.0f} min, {FLOOR_SF} SF)")

    shs = sorted(r["shPct"] for r in rows.values())
    med = shs[len(shs) // 2] if shs else 0
    print(f"league median on-ice SH%: {med:.1f}%  (min {shs[0]:.1f}, max {shs[-1]:.1f})")
    mc = rows.get(8478402)
    print("McDavid:", mc)
    cold = min(rows.values(), key=lambda r: r["shPct"])
    print("coldest:", cold)
    hot = sum(1 for r in rows.values() if r["tag"] == "HOT")
    due = sum(1 for r in rows.values() if r["tag"] == "DUE")
    print(f"tags: {hot} HOT, {due} DUE")

if __name__ == "__main__":
    main()
