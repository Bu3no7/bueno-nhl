# NHL Goal Model — static site edition

A factor-based Poisson model estimating each skater's **anytime-goal
probability** for tonight's games. All data comes from the public NHL API,
fetched live in the browser. No backend, no keys.

## Formula

**Inputs per skater** (season to date, from `/player/{id}/landing`):

| Symbol    | Meaning |
|-----------|---------|
| `GP`      | games played |
| `G`       | goals |
| `SHOTS`   | shots on goal |
| `TOI_MIN` | average time on ice (minutes) |
| `PPG`     | power-play goals |
| `HD_SHARE`| share of the skater's recent shot attempts from the high-danger zone |
| `OPP_SV`  | opposing goalie's season save percentage |

**Step 1 — base expected goals** (scoring form weighted first, shot volume second):

```
gpg      = G / GP
sogpg    = SHOTS / GP
lam_base = 0.6 * gpg + 0.4 * (sogpg * 0.105)
```

`0.105` is the league-average shooting percentage.

**Step 2 — multiplicative adjustments** (each clamped):

```
m_toi  = clamp(0.6 + 0.4 * (TOI_MIN / 20), 0.7, 1.3)
m_pp   = 1 + clamp((PPG / GP) * 2, 0, 0.35)
m_goal = clamp((1 - OPP_SV) / 0.10, 0.7, 1.4)        # vs .900 baseline
m_zone = 1 + clamp((HD_SHARE - 0.30) * 1.2, -0.25, 0.35)
```

**Step 3 — calibration dampening** (the low end must not run hot):

```
lam  = lam_base * m_toi * m_pp * m_goal * m_zone
lam *= 0.88                       # global empirical factor
if lam < 1/6: lam *= 0.85         # extra tail dampening below the +500 line
```

The extra tail dampening comes from a real calibration test: on the
2026-10-13 sixteen-game slate the model predicted 10.6% average for
+500-or-longer skaters but the actual hit rate was 6.8%.

**Step 4 — Poisson anytime-goal probability:**

```
p = 1 - exp(-lam)
```

**Fair American odds** from `p`:

```
p >= 0.5  →  −round(100 * p / (1 − p))
p <  0.5  →  +round(100 * (1 − p) / p)
```

## Zone score

Shot locations come from play-by-play `xCoord`/`yCoord` (tonight's games
plus up to two recent finals per team). Coordinates are normalized so the
shooting team always attacks `+x` (net at `x = 89`, using
`homeTeamDefendingSide`).

**High-danger ("home plate"):** `x ≤ 89` AND `sqrt((89 − x)² + y²) < 30`
— a 30-foot circle around the net mouth.

`HD_SHARE` = high-danger attempts ÷ total located attempts. Skaters with
fewer than 5 located attempts fall back to the league-neutral `0.30`
(marked with `*` on the board).

## Longshots

A skater is a longshot when the model's fair odds are **+500 or longer**
(`p ≤ 1/6`). The Longshots view ranks them by model probability.

## Data sources (all public, no keys)

- Schedule/scores: `api-web.nhle.com/v1/schedule/YYYY-MM-DD`
- Live scores: `api-web.nhle.com/v1/scoreboard/now`
- Play-by-play (rosters, shot coordinates, goalies):
  `api-web.nhle.com/v1/gamecenter/{gameId}/play-by-play`
- Skater & goalie season stats: `api-web.nhle.com/v1/player/{playerId}/landing`
- Team rosters (not-yet-started games): `api-web.nhle.com/v1/roster/{TEAM}/current`
- Headshots: `assets.nhle.com/mugs/nhl/20262027/{TEAM}/{playerId}.png`
- Team logos: `assets.nhle.com/logos/nhl/svg/{TEAM}_light.svg`

## Limitations

- Probabilities are estimates, not betting advice.
- For games that haven't started, "dressed" skaters come from the team
  roster (not the official game lineup); scratches aren't known yet.
- Opponent goalie falls back to league-average `.900` when unknown.
- Zone data needs located shots; depth players with few attempts use the
  neutral share.
