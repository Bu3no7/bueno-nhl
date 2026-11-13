#!/usr/bin/env python3
"""NHL player types — weekly clustering job (GMG replication, Hockey port).

Builds data/nhl-types.json: every skater in the latest slate bundle typed
by WHERE his shots come from, using the NHL's own EDGE shot-location data
(17 areas + danger bands), pulled keyless per skater with curl (the VM's
egress proxy truncates urllib chunked reads; curl is the house pattern).

Design (DESIGN-BRIEF.md §C, mock nhl-types-standouts-mock-v1.png):
  - Forwards and defensemen are split FIRST, then clustered separately.
  - Forwards: A Rush creator · B Perimeter shooter · C Slot finisher ·
    D Net-front. Defensemen get their own letter run starting at E:
    E Point shooter · F Activating defenseman.
  - Clusters are labelled by matching centroids to archetype signatures
    (first run) or to the saved letter centers (later runs — the letter
    lock, so a player's letter doesn't permute week to week).
  - fit = margin to the nearest other letter's centroid; lean = that
    letter when the margin is thin (borderline). The lean search spans
    BOTH groups, which is how a defenseman can lean Rush creator.
  - DISPLAY ONLY. Nothing here feeds a price anywhere.

Re-runnable weekly: EDGE payloads are cached under
data-builder/cache/edge-shotloc/ (fresh < 6 days = reused), centers are
saved to data-builder/cache/nhl-types-centers.json, and players typed in
earlier runs who are not in this week's universe are carried over with
stale=true rather than dropped.

Usage: python3 data-builder/nhl-types.py [--bundle data/YYYY-MM-DD.json]
       [--floor 20] [--no-cache]
"""
import argparse, itertools, json, math, os, subprocess, sys, time
from concurrent.futures import ThreadPoolExecutor
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
SITE = os.path.dirname(HERE)
SEASON_FORM = "20262027/2"
EDGE_URL = "https://api-web.nhle.com/v1/edge/skater-shot-location-detail/{pid}/" + SEASON_FORM
CACHE_DIR = os.path.join(HERE, "cache", "edge-shotloc")
CENTERS_FILE = os.path.join(HERE, "cache", "nhl-types-centers.json")
OUT_FILE = os.path.join(SITE, "data", "nhl-types.json")
CACHE_MAX_AGE = 6 * 86400

AREAS = ["Behind the Net", "Beyond Red Line", "Center Point", "Crease",
         "High Slot", "L Circle", "L Corner", "L Net Side", "L Point",
         "Low Slot", "Offensive Neutral Zone", "Outside L", "Outside R",
         "R Circle", "R Corner", "R Net Side", "R Point"]
GROUPS = {
    "netfront": ["Crease", "Behind the Net", "L Net Side", "R Net Side"],
    "slot": ["High Slot", "Low Slot"],
    "circles": ["L Circle", "R Circle"],
    "points": ["Center Point", "L Point", "R Point"],
    "corners": ["L Corner", "R Corner"],
    "outside": ["Outside L", "Outside R"],
    "long": ["Beyond Red Line", "Offensive Neutral Zone"],
}
GROUP_KEYS = list(GROUPS.keys())
FEATURES = GROUP_KEYS + ["hdShare", "entropy", "slotConv"]

LETTERS = {
    "A": {"name": "Rush creator", "group": "F",
          "desc": "Scores from everywhere — a spread diet, driven off the rush."},
    "B": {"name": "Perimeter shooter", "group": "F",
          "desc": "Lives in the circles — beats goalies clean from mid-range."},
    "C": {"name": "Slot finisher", "group": "F",
          "desc": "Home-plate diet — his shots come from the slot, and they convert."},
    "D": {"name": "Net-front", "group": "F",
          "desc": "Crease and net-side diet — tips, rebounds and clean-up goals."},
    "E": {"name": "Point shooter", "group": "D",
          "desc": "The offense runs through his point shot from the blue line."},
    "F": {"name": "Activating defenseman", "group": "D",
          "desc": "Jumps into the play — shoots from the circles and slot like a forward."},
}
ANCHORS = {8477492: "A", 8476453: "B", 8479318: "C", 8470621: "D", 8480069: "E"}
BORDERLINE_FIT = 0.10


def latest_bundle():
    cands = sorted(f for f in os.listdir(os.path.join(SITE, "data"))
                   if len(f) == 15 and f[:4].isdigit() and f.endswith(".json"))
    return os.path.join(SITE, "data", cands[-1])


def universe(bundle):
    out = {}
    for team, roster in bundle["rosters"].items():
        for grp, pos_group in (("forwards", "F"), ("defensemen", "D")):
            for p in roster.get(grp, []):
                out[int(p["id"])] = {
                    "pid": int(p["id"]),
                    "name": f"{p['firstName']['default']} {p['lastName']['default']}",
                    "team": team, "pos": p["positionCode"], "group": pos_group,
                    "headshot": p.get("headshot"),
                }
    return out


def fetch_edge(pid, use_cache=True):
    path = os.path.join(CACHE_DIR, f"{pid}.json")
    if use_cache and os.path.exists(path) and time.time() - os.path.getmtime(path) < CACHE_MAX_AGE:
        try:
            return json.load(open(path))
        except Exception:
            pass
    url = EDGE_URL.format(pid=pid)
    for attempt in range(2):
        try:
            r = subprocess.run(["curl", "-s", "--max-time", "20", "-H",
                                "User-Agent: Mozilla/5.0", url],
                               capture_output=True, text=True, timeout=30)
            d = json.loads(r.stdout)
            if "shotLocationTotals" in d:
                os.makedirs(CACHE_DIR, exist_ok=True)
                json.dump(d, open(path, "w"))
                return d
        except Exception:
            pass
        time.sleep(0.4)
    return None


def features_of(edge):
    """Feature dict from one EDGE shot-location payload, or None if unusable."""
    totals = {t["locationCode"]: t for t in edge.get("shotLocationTotals", [])}
    all_t = totals.get("all")
    if not all_t or not all_t.get("sog"):
        return None
    sog = all_t["sog"]
    by_area = {d["area"]: d for d in edge.get("shotLocationDetails", [])}
    f = {}
    for g, areas in GROUPS.items():
        f[g] = sum((by_area.get(a) or {}).get("sog", 0) for a in areas) / sog
    high = totals.get("high", {}).get("sog", 0)
    f["hdShare"] = high / sog
    ent = 0.0
    for g in GROUP_KEYS:
        p = max(f[g], 1e-9)
        ent -= p * math.log(p)
    f["entropy"] = ent / math.log(len(GROUP_KEYS))
    slot_sog = sum((by_area.get(a) or {}).get("sog", 0) for a in GROUPS["slot"])
    slot_gls = sum((by_area.get(a) or {}).get("goals", 0) for a in GROUPS["slot"])
    # shrunk slot conversion (prior 0.13, weight 8 attempts) — raw rates are
    # noise at November volumes
    f["slotConv"] = (slot_gls + 8 * 0.13) / (slot_sog + 8)
    f["_sog"] = sog
    f["_goals"] = all_t.get("goals", 0)
    return f


# Feature weights in standardized space: the diet shares ARE the type
# definition, so they dominate; entropy / slot conversion are secondary
# traits; corners and long-range are near-noise at these volumes.
WEIGHTS = {"netfront": 1.4, "slot": 1.4, "circles": 1.2, "points": 1.2,
           "hdShare": 1.2, "outside": 0.7, "entropy": 0.6, "slotConv": 0.6,
           "corners": 0.4, "long": 0.4}
W = np.array([WEIGHTS[f] for f in FEATURES])
# Each prototype counts as this many pseudo-members in its own cluster at
# every centroid update, so converged centers stay near their archetype
# definitions while the partition itself adapts to the real diets.
PSEUDO = 25


def kmeans(X, k, init=None, seed=7, iters=200, pseudo=None):
    rng = np.random.default_rng(seed)
    n = len(X)
    if init is not None:
        C = np.array(init, dtype=float)
    else:  # k-means++ seeding, deterministic via seed
        idx = [rng.integers(n)]
        d2 = np.sum((X - X[idx[0]]) ** 2, axis=1)
        for _ in range(k - 1):
            probs = d2 / d2.sum()
            idx.append(int(rng.choice(n, p=probs)))
            d2 = np.minimum(d2, np.sum((X - X[idx[-1]]) ** 2, axis=1))
        C = X[idx].copy()
    for _ in range(iters):
        d = np.linalg.norm(X[:, None, :] - C[None, :, :], axis=2)
        lab = d.argmin(axis=1)
        new = C.copy()
        for j in range(k):
            members = X[lab == j]
            if pseudo is not None:
                new[j] = (members.sum(axis=0) + PSEUDO * pseudo[j]) / (len(members) + PSEUDO)
            elif len(members):
                new[j] = members.mean(axis=0)
        if np.allclose(new, C):
            C = new
            break
        C = new
    return C, lab


def sig_scores_F(c):
    """Archetype signature scores for one RAW centroid (feature dict)."""
    return {
        "A": c["entropy"] * 1.2 + (c["slot"] + c["circles"]) * 0.4,
        "B": c["circles"] + c["outside"] * 0.6 - c["netfront"] * 0.5,
        "C": c["slot"] + c["slotConv"] * 0.8 + c["hdShare"] * 0.4,
        "D": c["netfront"] * 1.2 + c["hdShare"] * 0.3 - c["circles"] * 0.3,
    }


def sig_scores_D(c):
    return {
        "E": c["points"],
        "F": c["slot"] + c["circles"],
    }


def best_assignment(raw_centroids, letters, scorer):
    """Permutation of cluster indices -> letters maximising signature match."""
    best, best_score = None, -1e18
    for perm in itertools.permutations(range(len(letters))):
        s = sum(scorer(raw_centroids[perm[i]])[letters[i]] for i in range(len(letters)))
        if s > best_score:
            best, best_score = perm, s
    return {letters[i]: best[i] for i in range(len(letters))}  # letter -> cluster idx


# Archetype prototype diets (raw feature space). K-means is SEEDED with
# these on the first run: shot diets are a continuum (the NBA clustering
# found the same), so blind k-means slices along the slot-share axis and
# the archetypes blur. Seeding at the archetype corners and letting
# Lloyd's algorithm converge keeps the letters meaning what the design
# says they mean; from the second run on, the saved converged centers
# take over (the letter lock). Prototypes are archetype definitions,
# not player fits.
PROTO = {
    "A": {"netfront": .10, "slot": .30, "circles": .28, "points": .10, "corners": .02,
          "outside": .17, "long": .03, "hdShare": .28, "entropy": .85, "slotConv": .15},
    "B": {"netfront": .08, "slot": .16, "circles": .36, "points": .15, "corners": .02,
          "outside": .21, "long": .02, "hdShare": .12, "entropy": .78, "slotConv": .22},
    "C": {"netfront": .10, "slot": .52, "circles": .20, "points": .05, "corners": .01,
          "outside": .10, "long": .02, "hdShare": .45, "entropy": .62, "slotConv": .20},
    "D": {"netfront": .22, "slot": .48, "circles": .10, "points": .04, "corners": .03,
          "outside": .06, "long": .07, "hdShare": .58, "entropy": .68, "slotConv": .13},
    "E": {"netfront": .03, "slot": .13, "circles": .18, "points": .55, "corners": .01,
          "outside": .08, "long": .02, "hdShare": .05, "entropy": .65, "slotConv": .15},
    "F": {"netfront": .06, "slot": .20, "circles": .24, "points": .32, "corners": .02,
          "outside": .14, "long": .02, "hdShare": .08, "entropy": .80, "slotConv": .12},
}


def cluster_group(players, feats, group, k, letters, scorer, saved):
    """players: list of universe rows; feats: pid -> feature dict.
    Returns (pid -> letter, letter -> raw centroid dict, letter -> std centroid)."""
    pids = [p["pid"] for p in players]
    X = np.array([[feats[pid][f] for f in FEATURES] for pid in pids], dtype=float)
    mu, sd = X.mean(axis=0), X.std(axis=0)
    sd[sd == 0] = 1.0
    Z = (X - mu) / sd * W
    proto = [((np.array([PROTO[L][f] for f in FEATURES]) - mu) / sd * W)
             for L in letters]
    init = None
    locked = False
    if saved and saved.get("groups", {}).get(group, {}).get("k") == k:
        init = [saved["groups"][group]["centers"][L] for L in letters
                if L in saved["groups"][group]["centers"]]
        if len(init) != k:
            init = None
        else:
            locked = True
    if init is None:
        init = [p.tolist() for p in proto]
    C, lab = kmeans(Z, k, init=init, pseudo=np.array(proto))
    raw_centroids = [dict(zip(FEATURES, C[j] / W * sd + mu)) for j in range(k)]
    if locked:
        # letter lock: match new centroids to saved letters by centre distance
        saved_c = saved["groups"][group]["centers"]
        letter_of = {}
        used = set()
        pairs = sorted(((np.linalg.norm(C[j] - np.array(saved_c[L])), L, j)
                        for L in letters for j in range(k)))
        for _, L, j in pairs:
            if L not in letter_of and j not in used:
                letter_of[L] = j
                used.add(j)
    else:
        # seeded run: cluster j IS letter j by construction (prototype
        # seeding + pseudo-member anchoring holds it to its definition)
        letter_of = {letters[j]: j for j in range(k)}
    out = {}
    for i, pid in enumerate(pids):
        for L, j in letter_of.items():
            if lab[i] == j:
                out[pid] = L
    centers_std = {L: C[j].tolist() for L, j in letter_of.items()}
    centers_raw = {L: raw_centroids[j] for L, j in letter_of.items()}
    return out, centers_raw, centers_std, (mu, sd)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--bundle", default=None)
    ap.add_argument("--floor", type=int, default=20, help="minimum EDGE SOG to type")
    ap.add_argument("--no-cache", action="store_true")
    args = ap.parse_args()

    bundle_path = args.bundle or latest_bundle()
    bundle = json.load(open(bundle_path))
    uni = universe(bundle)
    print(f"bundle {os.path.basename(bundle_path)} · universe {len(uni)} skaters", flush=True)

    with ThreadPoolExecutor(max_workers=6) as ex:
        edges = dict(zip(uni.keys(), ex.map(lambda pid: fetch_edge(pid, not args.no_cache), uni.keys())))
    got = sum(1 for v in edges.values() if v)
    print(f"EDGE payloads: {got}/{len(uni)}", flush=True)

    feats, pool = {}, {"F": [], "D": []}
    for pid, u in uni.items():
        if not edges.get(pid):
            continue
        f = features_of(edges[pid])
        if not f or f["_sog"] < args.floor:
            continue
        feats[pid] = f
        pool[u["group"]].append(u)
    print(f"above floor ({args.floor} SOG): F={len(pool['F'])} D={len(pool['D'])}", flush=True)

    saved = None
    if os.path.exists(CENTERS_FILE):
        try:
            saved = json.load(open(CENTERS_FILE))
        except Exception:
            saved = None

    assign, centers_raw_all, centers_std_all, scales = {}, {}, {}, {}
    for group, k, letters, scorer in (
            ("F", 4, ["A", "B", "C", "D"], sig_scores_F),
            ("D", 2, ["E", "F"], sig_scores_D)):
        a, craw, cstd, sc = cluster_group(pool[group], feats, group, k, letters, scorer, saved)
        assign.update(a)
        centers_raw_all.update(craw)
        centers_std_all[group] = {"k": k, "centers": cstd}
        scales[group] = sc
        print(f"group {group}: " + ", ".join(
            f"{L} n={sum(1 for v in a.values() if v == L)}" for L in letters), flush=True)

    # fit / lean from distances to every letter centroid (both groups)
    def std_vec(pid):
        g = uni[pid]["group"]
        mu, sd = scales[g]
        return (np.array([feats[pid][f] for f in FEATURES]) - mu) / sd * W

    # Every letter's centroid expressed in EACH group's standardized
    # space: a player's distances are only comparable inside his own
    # group's space, and the lean search spans both groups' letters.
    all_centers = {}
    for group in ("F", "D"):
        mu, sd = scales[group]
        all_centers[group] = {
            L: (np.array([craw[f] for f in FEATURES]) - mu) / sd * W
            for L, craw in centers_raw_all.items()
        }

    players = {}
    for pid, L in assign.items():
        u = uni[pid]
        v = std_vec(pid)
        dists = sorted(((float(np.linalg.norm(v - c)), l)
                        for l, c in all_centers[u["group"]].items()))
        d1 = next(d for d, l in dists if l == L)
        d2, lean_letter = next((d, l) for d, l in dists if l != L)
        fit = (d2 - d1) / (d2 + d1) if (d2 + d1) > 0 else 0.0
        top = sorted(GROUP_KEYS, key=lambda g: -feats[pid][g])[:2]
        players[str(pid)] = {
            "letter": L, "type": LETTERS[L]["name"], "fit": round(max(0.0, fit), 2),
            "lean": lean_letter if fit < BORDERLINE_FIT else None,
            "sog": feats[pid]["_sog"], "goals": feats[pid]["_goals"],
            "team": u["team"], "pos": u["pos"], "name": u["name"],
            "headshot": u["headshot"],
            "topAreas": [{"area": g, "share": round(feats[pid][g], 3)} for g in top],
            "diet": {g: round(feats[pid][g], 3) for g in GROUP_KEYS},
        }

    # carry over previously typed players not in this week's universe
    carried = 0
    if os.path.exists(OUT_FILE):
        try:
            prev = json.load(open(OUT_FILE))
            for pid, entry in (prev.get("players") or {}).items():
                if pid not in players:
                    entry = dict(entry)
                    entry["stale"] = True
                    players[pid] = entry
                    carried += 1
        except Exception:
            pass

    out = {
        "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "bundleDate": bundle.get("date"),
        "season": "20262027",
        "floorSog": args.floor,
        "letters": {L: {"name": v["name"], "group": v["group"], "desc": v["desc"]}
                    for L, v in LETTERS.items()},
        "centers": {L: {f: round(centers_raw_all[L][f], 3) for f in FEATURES}
                    for L in centers_raw_all},
        "universe": len(uni), "edgeOk": got, "typed": len(assign),
        "carriedStale": carried,
        "players": players,
    }
    json.dump(out, open(OUT_FILE, "w"), indent=1)
    os.makedirs(os.path.dirname(CENTERS_FILE), exist_ok=True)
    json.dump({"groups": centers_std_all,
               "scales": {g: {"mu": scales[g][0].tolist(), "sd": scales[g][1].tolist()}
                          for g in scales}}, open(CENTERS_FILE, "w"), indent=1)

    print(f"wrote {OUT_FILE}: {len(assign)} typed (+{carried} carried stale)")
    bad = [(uni[pid]["name"], want, assign.get(pid)) for pid, want in ANCHORS.items()
           if assign.get(pid) != want]
    if bad:
        print("ANCHOR MISMATCH:", bad)
        return 1
    print("anchors OK:", {uni[pid]["name"]: assign[pid] for pid in ANCHORS})
    return 0


if __name__ == "__main__":
    sys.exit(main())
