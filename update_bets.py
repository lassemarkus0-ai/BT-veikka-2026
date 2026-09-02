#!/usr/bin/env python3
"""
update_bets.py

Fetches the Liiga.fi runkosarja (regular season) schedule and fills in the
"result" field for any Kärpät matches in data.json that have finished but
are not yet marked as resolved.

Bet convention (per data.json):
    result / predictions: "1" = home team win, "2" = away team win.
    A game counts once it has ENDED. Regulation, overtime and shootout
    wins all count identically -- Liiga's "homeTeamWinner" flag already
    reflects the final outcome regardless of how the game finished.

Usage:
    python update_bets.py
    python update_bets.py --data data.json --season 2027
    python update_bets.py --dry-run
"""

import argparse
import json
import os
import sys
from datetime import datetime, date
from zoneinfo import ZoneInfo

from liiga_common import current_season, fetch_json, log, warn, write_json_atomic

TOURNAMENT = "runkosarja"
HELSINKI = ZoneInfo("Europe/Helsinki")

# The date/time format used in data.json, e.g. "01.09.2026 18.30"
DATA_DT_FORMAT = "%d.%m.%Y %H.%M"

# How far to look when hunting for a rescheduled fixture
RESCHEDULE_WINDOW_DAYS = 10


def fetch_schedule(season: int, tournament: str = TOURNAMENT) -> list[dict]:
    """Fetch the full season schedule (all teams) from the Liiga API."""
    games = fetch_json("/schedule", params={"tournament": tournament, "season": season})
    if not isinstance(games, list):
        print(f"ERROR: expected a JSON array from /schedule, got {type(games).__name__}", file=sys.stderr)
        sys.exit(1)
    return games


def local_date(game: dict) -> date:
    """Convert an API game's UTC 'start' to its Helsinki local calendar date."""
    start_utc = datetime.fromisoformat(game["start"].replace("Z", "+00:00"))
    return start_utc.astimezone(HELSINKI).date()


def api_game_key(game: dict) -> tuple[str, str, date]:
    """
    (home, away, local date) key for an API game. Date only, not time --
    kickoffs shift for TV, but Kärpät never play the same opponent twice
    on one day, so the date is the stable half of the identifier.
    """
    return (game["homeTeamName"], game["awayTeamName"], local_date(game))


def match_key(match: dict) -> tuple[str, str, date]:
    """The same style of key, for a data.json match entry."""
    dt = datetime.strptime(match["date"], DATA_DT_FORMAT)
    return (match["homeTeam"], match["awayTeam"], dt.date())


def build_indexes(games: list[dict]):
    """
    Returns (exact_index, pair_index):
      exact_index: (home, away, date) -> game
      pair_index:  (home, away)       -> [games]   (for reschedule fallback)
    """
    exact: dict[tuple[str, str, date], dict] = {}
    pairs: dict[tuple[str, str], list[dict]] = {}

    for game in games:
        key = api_game_key(game)
        if key in exact:
            warn(f"Duplicate schedule entry for {key}; keeping the first")
        else:
            exact[key] = game
        pairs.setdefault((game["homeTeamName"], game["awayTeamName"]), []).append(game)

    return exact, pairs


def find_game(match: dict, exact: dict, pairs: dict) -> tuple[dict | None, str | None]:
    """
    Locate the API game for a data.json match.
    Returns (game, note). 'note' is set when a fallback was used.
    """
    home, away, want_date = match_key(match)

    game = exact.get((home, away, want_date))
    if game is not None:
        return game, None

    # Fallback: the fixture may have been rescheduled. Accept it only if
    # exactly one same-pairing game sits within the window, so we can never
    # silently resolve the wrong leg of a two-game set.
    candidates = [
        g for g in pairs.get((home, away), [])
        if abs((local_date(g) - want_date).days) <= RESCHEDULE_WINDOW_DAYS
    ]
    if len(candidates) == 1:
        moved = candidates[0]
        return moved, f"date moved {want_date.strftime('%d.%m.%Y')} -> {local_date(moved).strftime('%d.%m.%Y')}"

    return None, None


def update_matches(matches: list[dict], exact: dict, pairs: dict) -> tuple[int, list[str]]:
    """Fill in result for finished, unresolved matches. Returns (count, changed_descriptions)."""
    updated = 0
    changes: list[str] = []
    missing_past: list[str] = []
    missing_future = 0
    today = date.today()

    for match in matches:
        if match.get("result"):
            continue  # already resolved; never overwrite

        game, note = find_game(match, exact, pairs)

        if game is None:
            _, _, m_date = match_key(match)
            if m_date < today:
                missing_past.append(f"{match['homeTeam']} vs {match['awayTeam']} on {match['date']}")
            else:
                missing_future += 1
            continue

        if not game.get("ended"):
            continue  # not played yet

        winner = "1" if game["homeTeamWinner"] else "2"
        match["result"] = winner
        # Extra context for the season-stats side of the site later.
        match["homeGoals"] = game["homeTeamGoals"]
        match["awayGoals"] = game["awayTeamGoals"]
        match["finishedType"] = game["finishedType"]
        updated += 1

        desc = (f"{match['homeTeam']} {game['homeTeamGoals']}-{game['awayTeamGoals']} {match['awayTeam']} "
                f"({match['date']}) -> result={winner}")
        if note:
            desc += f"  [{note}]"
        changes.append(desc)
        log(f"Resolved: {desc}")

    # Past-dated misses are real problems and get named individually.
    for m in missing_past:
        warn(f"No API game found for a match that should already have been played: {m}")
    # Future misses are usually just schedule churn; one summary line is enough.
    if missing_future:
        log(f"({missing_future} future fixture(s) not currently present in the API response)")

    return updated, changes


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Update data.json with finished Kärpät results from the Liiga API")
    parser.add_argument("--data", default="data.json", help="Path to data.json (default: ./data.json)")
    parser.add_argument("--season", type=int, default=None,
                        help="Liiga season year, e.g. 2027 (default: auto-detected)")
    parser.add_argument("--dry-run", action="store_true",
                        help="Report what would change without writing the file")
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

    if "matches" not in data:
        print(f"ERROR: {args.data} has no 'matches' key", file=sys.stderr)
        sys.exit(1)

    games = fetch_schedule(season)
    log(f"Fetched {len(games)} games from the API")

    exact, pairs = build_indexes(games)
    updated, changes = update_matches(data["matches"], exact, pairs)

    if not updated:
        log("No new results to update.")
        return

    if args.dry_run:
        log(f"\n[dry run] {updated} match(es) would be updated; {args.data} left untouched.")
        return

    write_json_atomic(args.data, data)
    log(f"Updated {updated} match(es); wrote {args.data}")

    # Surface a tidy summary in the GitHub Actions run page, when present.
    summary_path = os.environ.get("GITHUB_STEP_SUMMARY")
    if summary_path:
        with open(summary_path, "a", encoding="utf-8") as f:
            f.write(f"### Updated {updated} Kärpät result(s)\n\n")
            for c in changes:
                f.write(f"- {c}\n")


if __name__ == "__main__":
    main()
