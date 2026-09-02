#!/usr/bin/env python3
"""
test_update_season_bets.py

Unit tests for update_season_bets.py's pure resolver functions -- no
network calls, all synthetic fixtures. Run with:
    python -m unittest test_update_season_bets.py
"""

import unittest

from update_season_bets import (
    bottom_by,
    resolve_attendance,
    resolve_goalies,
    resolve_skaters,
    resolve_standings,
    top_by,
)


def cat(cat_id, answer=None):
    return {"id": cat_id, "answer": answer}


def categories(*ids):
    return {i: cat(i) for i in ids}


class TestTopByBottomBy(unittest.TestCase):
    def test_top_by_finds_max(self):
        records = [
            {"firstName": "A", "lastName": "1", "teamName": "Kärpät", "points": 5},
            {"firstName": "B", "lastName": "2", "teamName": "Tappara", "points": 9},
        ]
        self.assertEqual(top_by(records, "points")["lastName"], "2")

    def test_top_by_filters_by_team(self):
        records = [
            {"firstName": "A", "lastName": "1", "teamName": "Kärpät", "points": 5},
            {"firstName": "B", "lastName": "2", "teamName": "Tappara", "points": 9},
        ]
        self.assertEqual(top_by(records, "points", "Kärpät")["lastName"], "1")

    def test_top_by_empty_pool_returns_none(self):
        self.assertIsNone(top_by([], "points", "Kärpät"))

    def test_bottom_by_finds_min(self):
        records = [
            {"firstName": "A", "lastName": "1", "teamName": "X", "plusMinus": -3},
            {"firstName": "B", "lastName": "2", "teamName": "Y", "plusMinus": 4},
        ]
        self.assertEqual(bottom_by(records, "plusMinus")["lastName"], "1")


class TestResolveStandings(unittest.TestCase):
    def test_fills_top_three_last_and_karpat_rank(self):
        cats = categories("runkosarja_1", "runkosarja_2", "runkosarja_3",
                           "runkosarjan_viimeinen", "karpat_liigasijoitus")
        standings = [
            {"teamName": "Tappara", "ranking": 1},
            {"teamName": "Kärpät", "ranking": 5},
            {"teamName": "Ilves", "ranking": 2},
            {"teamName": "HIFK", "ranking": 3},
            {"teamName": "Jukurit", "ranking": 16},
        ]
        changes = resolve_standings(cats, standings)
        self.assertEqual(cats["runkosarja_1"]["answer"], "Tappara")
        self.assertEqual(cats["runkosarja_2"]["answer"], "Ilves")
        self.assertEqual(cats["runkosarja_3"]["answer"], "HIFK")
        self.assertEqual(cats["runkosarjan_viimeinen"]["answer"], "Jukurit")
        self.assertEqual(cats["karpat_liigasijoitus"]["answer"], "5")
        self.assertEqual(len(changes), 5)

    def test_never_overwrites_an_already_resolved_category(self):
        cats = categories("runkosarja_1")
        cats["runkosarja_1"]["answer"] = "Kärpät"  # manually pre-resolved
        standings = [{"teamName": "Tappara", "ranking": 1}]
        changes = resolve_standings(cats, standings)
        self.assertEqual(cats["runkosarja_1"]["answer"], "Kärpät")
        self.assertEqual(changes, [])


class TestResolveSkaters(unittest.TestCase):
    def test_fills_league_and_karpat_leaders(self):
        cats = categories("liiga_paras_pisteporssi", "karpat_paras_pisteporssi")
        skaters = [
            {"firstName": "Matyas", "lastName": "Kantner", "teamName": "Kärpät", "points": 10,
             "goals": 4, "penaltyMinutes": 2, "plusMinus": 3},
            {"firstName": "Ben", "lastName": "Rautiainen", "teamName": "Tappara", "points": 15,
             "goals": 8, "penaltyMinutes": 0, "plusMinus": 5},
        ]
        resolve_skaters(cats, skaters)
        self.assertEqual(cats["liiga_paras_pisteporssi"]["answer"], "Ben Rautiainen")
        self.assertEqual(cats["karpat_paras_pisteporssi"]["answer"], "Matyas Kantner")


class TestResolveGoalies(unittest.TestCase):
    def test_requires_minimum_games_to_qualify(self):
        cats = categories("liiga_paras_maalivahti", "liiga_mv_torjuntaprosentti")
        goalies = [
            {"firstName": "A", "lastName": "Short", "teamName": "X", "games": 5, "savePercentage": 99.0},
            {"firstName": "B", "lastName": "Long", "teamName": "Y", "games": 25, "savePercentage": 91.0},
        ]
        resolve_goalies(cats, goalies, min_games=20)
        # "Short" has the best save% but hasn't played enough to qualify.
        self.assertEqual(cats["liiga_paras_maalivahti"]["answer"], "B Long")
        self.assertEqual(cats["liiga_mv_torjuntaprosentti"]["answer"], 91.0)

    def test_no_qualified_goalie_leaves_category_unresolved(self):
        cats = categories("liiga_paras_maalivahti")
        goalies = [{"firstName": "A", "lastName": "Short", "teamName": "X", "games": 2, "savePercentage": 99.0}]
        changes = resolve_goalies(cats, goalies, min_games=20)
        self.assertIsNone(cats["liiga_paras_maalivahti"]["answer"])
        self.assertEqual(changes, [])


class TestResolveAttendance(unittest.TestCase):
    def test_averages_only_ended_karpat_home_games(self):
        cats = categories("karpat_yleisokeskiarvo")
        games = [
            {"homeTeamName": "Kärpät", "ended": True, "spectators": 5000},
            {"homeTeamName": "Kärpät", "ended": True, "spectators": 6000},
            {"homeTeamName": "Kärpät", "ended": False, "spectators": 9999},  # not played -- excluded
            {"homeTeamName": "Tappara", "ended": True, "spectators": 4000},  # not a Kärpät home game
        ]
        resolve_attendance(cats, games)
        self.assertEqual(cats["karpat_yleisokeskiarvo"]["answer"], 5500)

    def test_no_home_games_yet_leaves_category_unresolved(self):
        cats = categories("karpat_yleisokeskiarvo")
        changes = resolve_attendance(cats, [])
        self.assertIsNone(cats["karpat_yleisokeskiarvo"]["answer"])
        self.assertEqual(changes, [])


if __name__ == "__main__":
    unittest.main()
