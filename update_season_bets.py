#!/usr/bin/env python3
"""
update_season_bets.py

Fills in resolved "answer" values in season-bets.json for the categories
that can be derived from the Liiga API: final regular-season standings
(top 3, last place, Kärpät's position), statistical leaders (points,
goals, penalty minutes, +/-), the league's best goalkeeper by save
percentage, and Kärpät's home-game attendance average.

These only get set once the regular season is fully played (every
scheduled runkosarja game has ended) -- "the season's top scorer" only
means something once the season is over.

Medal (kulta/hopea/pronssi) and relegation (putoaja_1..3) categories are
decided by the playoffs and the qualification series, which this script
doesn't model. Resolve those by hand once known:
    python update_season_bets.py --set-answer kulta=Tappara --set-answer hopea=Kärpät

Usage:
    python update_season_bets.py
    python update_season_bets.py --data season-bets.json --season 2027
    python update_season_bets.py --dry-run
    python update_season_bets.py --set-answer pronssi=HIFK
"""

import argparse
import json
import os
import sys

from liiga_common import current_season, fetch_json, log, warn, write_json_atomic

TOURNAMENT = "runkosarja"
KARPAT = "Kärpät"

# Liiga doesn't publish an official minimum-games qualifier for its save%
# leaderboard via this API; this is a stand-in so a goalie with a couple of
# relief appearances can't win on a tiny sample. Override with
# --gk-min-games if the group disagrees with the pick it produces.
GK_MIN_GAMES_DEFAULT = 20


def player_name(rec: dict) -> str:
    return f"{rec['firstName']} {rec['lastName']}"


def top_by(records: list[dict], key: str, team: str | None = None) -> dict | None:
    pool = [r for r in records if team is None or r.get("teamName") == team]
    if not pool:
        return None
    best = max(pool, key=lambda r: r[key])
    ties = [r for r in pool if r[key] == best[key]]
    if len(ties) > 1:
        warn(f"Tie for max {key}" + (f" ({team})" if team else "") +
             f": {', '.join(player_name(r) for r in ties)} ({best[key]}) -- picked {player_name(best)}")
    return best


def bottom_by(records: list[dict], key: str, team: str | None = None) -> dict | None:
    pool = [r for r in records if team is None or r.get("teamName") == team]
    if not pool:
        return None
    best = min(pool, key=lambda r: r[key])
    ties = [r for r in pool if r[key] == best[key]]
    if len(ties) > 1:
        warn(f"Tie for min {key}" + (f" ({team})" if team else "") +
             f": {', '.join(player_name(r) for r in ties)} ({best[key]}) -- picked {player_name(best)}")
    return best


def resolve_standings(categories: dict, standings: list[dict]) -> list[str]:
    changes = []
    by_rank = {t["ranking"]: t["teamName"] for t in standings}
    max_rank = max(by_rank)
    karpat = next((t for t in standings if t["teamName"] == KARPAT), None)

    mapping = {
        "runkosarja_1": by_rank.get(1),
        "runkosarja_2": by_rank.get(2),
        "runkosarja_3": by_rank.get(3),
        "runkosarjan_viimeinen": by_rank.get(max_rank),
        "karpat_liigasijoitus": str(karpat["ranking"]) if karpat else None,
    }
    for cat_id, answer in mapping.items():
        cat = categories.get(cat_id)
        if cat is None or answer is None or cat.get("answer"):
            continue
        cat["answer"] = answer
        changes.append(f"{cat_id} -> {answer}")
    return changes


def resolve_skaters(categories: dict, skaters: list[dict]) -> list[str]:
    changes = []
    mapping = {
        "liiga_paras_pisteporssi":   top_by(skaters, "points"),
        "karpat_paras_pisteporssi":  top_by(skaters, "points", KARPAT),
        "liiga_paras_maalintekija":  top_by(skaters, "goals"),
        "karpat_paras_maalintekija": top_by(skaters, "goals", KARPAT),
        "liiga_jaahykuningas":       top_by(skaters, "penaltyMinutes"),
        "karpat_jaahykuningas":      top_by(skaters, "penaltyMinutes", KARPAT),
        "liiga_paras_plusmiinus":    top_by(skaters, "plusMinus"),
        "karpat_paras_plusmiinus":   top_by(skaters, "plusMinus", KARPAT),
        "liiga_huonoin_plusmiinus":  bottom_by(skaters, "plusMinus"),
        "karpat_huonoin_plusmiinus": bottom_by(skaters, "plusMinus", KARPAT),
    }
    for cat_id, rec in mapping.items():
        cat = categories.get(cat_id)
        if cat is None or rec is None or cat.get("answer"):
            continue
        cat["answer"] = player_name(rec)
        changes.append(f"{cat_id} -> {cat['answer']} ({rec['teamName']})")
    return changes


def resolve_goalies(categories: dict, goalies: list[dict], min_games: int) -> list[str]:
    changes = []
    qualified = [g for g in goalies if g.get("games", 0) >= min_games]
    if not qualified:
        warn(f"No goalie with >= {min_games} games played yet; skipping save% leader")
        return changes

    best = max(qualified, key=lambda g: g["savePercentage"])
    ties = [g for g in qualified if g["savePercentage"] == best["savePercentage"]]
    if len(ties) > 1:
        warn(f"Tie for best save%: {', '.join(player_name(g) for g in ties)} "
             f"({best['savePercentage']}) -- picked {player_name(best)}")

    for cat_id, value in (
        ("liiga_paras_maalivahti", player_name(best)),
        ("liiga_mv_torjuntaprosentti", best["savePercentage"]),
    ):
        cat = categories.get(cat_id)
        if cat is None or cat.get("answer"):
            continue
        cat["answer"] = value
        changes.append(f"{cat_id} -> {value}")
    return changes


def resolve_attendance(categories: dict, games: list[dict]) -> list[str]:
    cat = categories.get("karpat_yleisokeskiarvo")
    if cat is None or cat.get("answer"):
        return []
    home_games = [g for g in games
                  if g.get("homeTeamName") == KARPAT and g.get("ended") and g.get("spectators")]
    if not home_games:
        return []
    avg = round(sum(g["spectators"] for g in home_games) / len(home_games))
    cat["answer"] = avg
    return [f"karpat_yleisokeskiarvo -> {avg} ({len(home_games)} kotiottelua)"]


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Update season-bets.json with resolved answers from the Liiga API")
    parser.add_argument("--data", default="season-bets.json", help="Path to season-bets.json")
    parser.add_argument("--season", type=int, default=None,
                        help="Liiga season year, e.g. 2027 (default: auto-detected)")
    parser.add_argument("--dry-run", action="store_true",
                        help="Report what would change without writing the file")
    parser.add_argument("--gk-min-games", type=int, default=GK_MIN_GAMES_DEFAULT,
                        help=f"Minimum games played to qualify for the save%% leader pick "
                             f"(default: {GK_MIN_GAMES_DEFAULT})")
    parser.add_argument("--set-answer", action="append", default=[], metavar="ID=VALUE",
                        help="Manually resolve one category (repeatable), e.g. --set-answer kulta=Tappara")
    args = parser.parse_args()

    season = args.season or current_season()
    log(f"Season: {season}")

    try:
        with open(args.data, "r", encoding="utf-8") as f:
            data = json.load(f)
    except FileNotFoundError:
        print(f"ERROR: {args.data} not found", file=sys.stderr)
        sys.exit(1)
    except json.JSONDecodeError as e:
        print(f"ERROR: {args.data} is not valid JSON: {e}", file=sys.stderr)
        sys.exit(1)

    if "categories" not in data:
        print(f"ERROR: {args.data} has no 'categories' key", file=sys.stderr)
        sys.exit(1)

    categories = {c["id"]: c for c in data["categories"]}
    changes: list[str] = []

    for raw in args.set_answer:
        if "=" not in raw:
            print(f"ERROR: --set-answer must look like id=value, got {raw!r}", file=sys.stderr)
            sys.exit(1)
        cat_id, value = raw.split("=", 1)
        cat = categories.get(cat_id)
        if cat is None:
            print(f"ERROR: unknown category id {cat_id!r}", file=sys.stderr)
            sys.exit(1)
        cat["answer"] = value
        changes.append(f"{cat_id} -> {value} (manual)")
        log(f"Manually set: {cat_id} -> {value}")

    games = fetch_json("/schedule", params={"tournament": TOURNAMENT, "season": season})
    season_complete = bool(games) and all(g.get("ended") for g in games)
    log(f"Regular season complete: {season_complete} "
        f"({sum(1 for g in games if g.get('ended'))}/{len(games)} games ended)")

    if season_complete:
        standings = fetch_json("/standings", params={"tournament": TOURNAMENT, "season": season})["season"]
        changes += resolve_standings(categories, standings)

        skaters = fetch_json(f"/players/stats/summed/{season}/{season}/{TOURNAMENT}/true",
                              params={"dataType": "basicStats"})
        changes += resolve_skaters(categories, skaters)

        goalies = fetch_json(f"/players/stats/summed/{season}/{season}/{TOURNAMENT}/true",
                              params={"dataType": "basicStatsGk"})
        changes += resolve_goalies(categories, goalies, args.gk_min_games)

        changes += resolve_attendance(categories, games)
    else:
        log("Skipping stat-leader categories until the regular season is finished.")

    if not changes:
        log("No new answers to resolve.")
        return

    for c in changes:
        log(f"Resolved: {c}")

    if args.dry_run:
        log(f"\n[dry run] {len(changes)} answer(s) would be set; {args.data} left untouched.")
        return

    write_json_atomic(args.data, data)
    log(f"Updated {len(changes)} answer(s); wrote {args.data}")

    summary_path = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary_path:
        with open(summary_path, "a", encoding="utf-8") as f:
            f.write(f"### Resolved {len(changes)} season-bet answer(s)\n\n")
            for c in changes:
                f.write(f"- {c}\n")


if __name__ == "__main__":
    main()
