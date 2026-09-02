#!/usr/bin/env python3
"""
test_update_bets.py

Unit tests for update_bets.py's pure, data-only functions -- no network
calls. Run with: python -m unittest test_update_bets.py

The home/away vs. Kärpät-relative result bug (fixed in this repo's history)
lived exactly in update_matches()'s winner-determination logic, which is
why that's the center of these tests.
"""

import unittest

from update_bets import build_indexes, find_game, update_matches


def game(home, away, start, ended=True, home_winner=None,
         home_goals=0, away_goals=0, finished_type="ENDED_DURING_REGULAR_GAME_TIME"):
    return {
        "homeTeamName": home,
        "awayTeamName": away,
        "start": start,
        "ended": ended,
        "homeTeamWinner": home_winner,
        "homeTeamGoals": home_goals,
        "awayTeamGoals": away_goals,
        "finishedType": finished_type,
    }


def match(home, away, date_str, result=""):
    return {"homeTeam": home, "awayTeam": away, "date": date_str, "result": result}


class TestResultResolution(unittest.TestCase):
    """The bug: '1'/'2' must mean Kärpät win/loss, not home/away win."""

    def test_karpat_home_win_resolves_to_1(self):
        games = [game("Kärpät", "Ässät", "2026-09-01T15:30:00Z", home_winner=True, home_goals=3, away_goals=1)]
        exact, pairs = build_indexes(games)
        matches = [match("Kärpät", "Ässät", "01.09.2026 18.30")]
        updated, _ = update_matches(matches, exact, pairs)
        self.assertEqual(updated, 1)
        self.assertEqual(matches[0]["result"], "1")

    def test_karpat_home_loss_resolves_to_2(self):
        games = [game("Kärpät", "Ässät", "2026-09-01T15:30:00Z", home_winner=False, home_goals=1, away_goals=3)]
        exact, pairs = build_indexes(games)
        matches = [match("Kärpät", "Ässät", "01.09.2026 18.30")]
        update_matches(matches, exact, pairs)
        self.assertEqual(matches[0]["result"], "2")

    def test_karpat_away_win_resolves_to_1_not_2(self):
        # Kärpät play AWAY and win: the home team (Tappara) did NOT win, so
        # homeTeamWinner is False -- but the bug used homeTeamWinner directly
        # as the "1"/"2" result, which would have produced "2" (a Kärpät
        # loss) here even though Kärpät actually won.
        games = [game("Tappara", "Kärpät", "2026-09-22T15:30:00Z", home_winner=False, home_goals=1, away_goals=4)]
        exact, pairs = build_indexes(games)
        matches = [match("Tappara", "Kärpät", "22.09.2026 18.30")]
        update_matches(matches, exact, pairs)
        self.assertEqual(matches[0]["result"], "1")

    def test_karpat_away_loss_resolves_to_2_not_1(self):
        # Kärpät play away and lose: the home team DID win (homeTeamWinner
        # True), which the bug would have reported as "1" (a Kärpät win).
        games = [game("Tappara", "Kärpät", "2026-09-22T15:30:00Z", home_winner=True, home_goals=4, away_goals=1)]
        exact, pairs = build_indexes(games)
        matches = [match("Tappara", "Kärpät", "22.09.2026 18.30")]
        update_matches(matches, exact, pairs)
        self.assertEqual(matches[0]["result"], "2")


class TestUpdateMatches(unittest.TestCase):
    def test_never_overwrites_an_already_resolved_match(self):
        games = [game("Kärpät", "Ässät", "2026-09-01T15:30:00Z", home_winner=False)]
        exact, pairs = build_indexes(games)
        matches = [match("Kärpät", "Ässät", "01.09.2026 18.30", result="1")]
        updated, _ = update_matches(matches, exact, pairs)
        self.assertEqual(updated, 0)
        self.assertEqual(matches[0]["result"], "1")  # untouched despite game saying the opposite

    def test_skips_a_game_that_has_not_ended(self):
        games = [game("Kärpät", "JYP", "2026-09-05T15:30:00Z", ended=False, home_winner=None)]
        exact, pairs = build_indexes(games)
        matches = [match("Kärpät", "JYP", "05.09.2026 17.00")]
        updated, _ = update_matches(matches, exact, pairs)
        self.assertEqual(updated, 0)
        self.assertEqual(matches[0]["result"], "")

    def test_carries_goals_and_finished_type(self):
        games = [game("Kärpät", "Ässät", "2026-09-01T15:30:00Z", home_winner=True,
                       home_goals=3, away_goals=1, finished_type="ENDED_DURING_OVERTIME")]
        exact, pairs = build_indexes(games)
        matches = [match("Kärpät", "Ässät", "01.09.2026 18.30")]
        update_matches(matches, exact, pairs)
        self.assertEqual(matches[0]["homeGoals"], 3)
        self.assertEqual(matches[0]["awayGoals"], 1)
        self.assertEqual(matches[0]["finishedType"], "ENDED_DURING_OVERTIME")


class TestFindGame(unittest.TestCase):
    def test_exact_date_match(self):
        games = [game("Kärpät", "Ässät", "2026-09-01T15:30:00Z")]
        exact, pairs = build_indexes(games)
        m = match("Kärpät", "Ässät", "01.09.2026 18.30")
        found, note = find_game(m, exact, pairs)
        self.assertIsNotNone(found)
        self.assertIsNone(note)

    def test_reschedule_fallback_when_single_candidate_within_window(self):
        # Game moved from the 1st to the 3rd -- still within the 10-day window
        # and there's only one Kärpät-Ässät game, so it's accepted.
        games = [game("Kärpät", "Ässät", "2026-09-03T15:30:00Z")]
        exact, pairs = build_indexes(games)
        m = match("Kärpät", "Ässät", "01.09.2026 18.30")
        found, note = find_game(m, exact, pairs)
        self.assertIsNotNone(found)
        self.assertIsNotNone(note)

    def test_no_fallback_when_two_candidates_in_window(self):
        # Two legs of a home-and-away pair both fall in the window -- must
        # not guess which one, to avoid silently resolving the wrong game.
        games = [
            game("Kärpät", "Ässät", "2026-09-01T15:30:00Z"),
            game("Kärpät", "Ässät", "2026-09-08T15:30:00Z"),
        ]
        exact, pairs = build_indexes(games)
        m = match("Kärpät", "Ässät", "04.09.2026 18.30")
        found, note = find_game(m, exact, pairs)
        self.assertIsNone(found)


if __name__ == "__main__":
    unittest.main()
