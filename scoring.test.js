/* scoring.test.js — scoring.js:n testit. Ei riipu mistään testikehyksestä:
   toimii ajettuna suoraan `node scoring.test.js` (CI) tai ladattuna
   test.html:n kautta selaimessa (paikallinen tarkistus).

   Uusi testi: kutsu test(nimi, funktio) ja heitä virhe assertEqual/assert-
   funktiolla epäonnistumisesta -- muuta ei tarvita. */

(function () {
  "use strict";

  var isNode = typeof module === "object" && module.exports;
  var S = isNode ? require("./scoring.js") : window.BTScoring;

  var results = [];

  function test(name, fn) {
    try {
      fn();
      results.push({ name: name, ok: true });
    } catch (e) {
      results.push({ name: name, ok: false, error: e.message });
    }
  }

  function assert(cond, msg) {
    if (!cond) throw new Error(msg || "assert epäonnistui");
  }

  function assertEqual(actual, expected, msg) {
    var a = JSON.stringify(actual), e = JSON.stringify(expected);
    if (a !== e) {
      throw new Error((msg ? msg + ": " : "") + "odotettiin " + e + ", saatiin " + a);
    }
  }

  var PLAYERS = ["Asko", "Markus", "Ilpo"];

  /* ---------- voteCounts / matchWeights / resultWeight ---------- */

  test("matchWeights: enemmistö saa painon 1, vähemmistö painon 2", function () {
    var m = { predictions: { Asko: "1", Markus: "1", Ilpo: "2" } };
    var w = S.matchWeights(m, PLAYERS);
    assertEqual(w.w1, 1);
    assertEqual(w.w2, 2);
    assertEqual(w.c1, 2);
    assertEqual(w.c2, 1);
  });

  test("matchWeights: tasan mennyt jako antaa painon 1,5 kummallekin", function () {
    var m = { predictions: { Asko: "1", Markus: "2" } };
    var w = S.matchWeights(m, ["Asko", "Markus"]);
    assertEqual(w.w1, 1.5);
    assertEqual(w.w2, 1.5);
  });

  test("resultWeight: null jos ottelu ei ole ratkennut", function () {
    var m = { result: "", predictions: { Asko: "1", Markus: "1", Ilpo: "2" } };
    assertEqual(S.resultWeight(m, PLAYERS), null);
  });

  test("resultWeight: käyttää voittanutta puolta vastaavaa painoa", function () {
    var m = { result: "1", predictions: { Asko: "1", Markus: "1", Ilpo: "2" } };
    assertEqual(S.resultWeight(m, PLAYERS), 1); // "1" oli enemmistö -> paino 1
  });

  test("isResolved: vain \"1\" tai \"2\" lasketaan ratkenneeksi", function () {
    assert(S.isResolved({ result: "1" }) === true);
    assert(S.isResolved({ result: "2" }) === true);
    assert(S.isResolved({ result: "" }) === false);
    assert(S.isResolved({ result: undefined }) === false);
  });

  /* ---------- fmtPoints / fmtPct ---------- */

  test("fmtPoints: kokonaisluku ilman desimaalia", function () {
    assertEqual(S.fmtPoints(2), "2");
  });

  test("fmtPoints: puolikas suomalaisella pilkulla", function () {
    assertEqual(S.fmtPoints(1.5), "1,5");
  });

  /* ---------- computeMatchPoints / computeStandings ---------- */

  test("computeMatchPoints: laskee osumat ja pisteet oikein", function () {
    var data = {
      players: PLAYERS,
      matches: [
        { result: "1", predictions: { Asko: "1", Markus: "1", Ilpo: "2" } }, // 1 on enemmistö, paino 1
        { result: "2", predictions: { Asko: "1", Markus: "2", Ilpo: "2" } }  // 2 on enemmistö, paino 1
      ]
    };
    var mp = S.computeMatchPoints(data);
    assertEqual(mp.points.Asko, 1);   // osui ekaan (paino 1), hävisi tokan
    assertEqual(mp.points.Markus, 2); // osui molempiin
    assertEqual(mp.points.Ilpo, 1);   // hävisi ekan, osui tokkaan
    assertEqual(mp.hits.Markus, 2);
    assertEqual(mp.played.Asko, 2);
  });

  test("computeStandings: järjestää pisteiden mukaan, tasapelissä nimen mukaan", function () {
    // Molemmat veikkasivat samoin ja osuivat -> sama pistemäärä, ratkaisu aakkosjärjestyksellä.
    var data = {
      players: ["Bertta", "Asko"],
      matches: [{ result: "1", predictions: { Bertta: "1", Asko: "1" } }]
    };
    var rows = S.computeStandings(data);
    assertEqual(rows[0].name, "Asko");
    assertEqual(rows[0].points, rows[1].points); // tasapelissä pisteet yhtä suuret
  });

  test("computeStandings: kausipisteet lisätään kokonaissummaan", function () {
    var data = { players: PLAYERS, matches: [] };
    var rows = S.computeStandings(data, { Asko: 3, Markus: 1 });
    var byName = {};
    rows.forEach(function (r) { byName[r.name] = r.points; });
    assertEqual(byName.Asko, 3);
    assertEqual(byName.Ilpo, 0);
  });

  /* ---------- pointsForCategory: team-rank ---------- */

  var medalCats = [
    { id: "kulta", rankGroup: "medals", type: "team-rank", answer: "Tappara" },
    { id: "hopea", rankGroup: "medals", type: "team-rank", answer: "Kärpät" },
    { id: "pronssi", rankGroup: "medals", type: "team-rank", answer: "HIFK" }
  ];

  test("pointsForCategory team-rank: null kunnes koko ryhmä ratkennut", function () {
    var partial = [medalCats[0], { id: "hopea", rankGroup: "medals", type: "team-rank", answer: null }, medalCats[2]];
    assertEqual(S.pointsForCategory(partial[0], partial, "Tappara"), null);
  });

  test("pointsForCategory team-rank: oikea joukkue oikeassa kohdassa = 3", function () {
    assertEqual(S.pointsForCategory(medalCats[0], medalCats, "Tappara"), 3);
  });

  test("pointsForCategory team-rank: oikea joukkue väärässä kohdassa = 1", function () {
    assertEqual(S.pointsForCategory(medalCats[0], medalCats, "Kärpät"), 1); // Kärpät = hopea, ei kulta
  });

  test("pointsForCategory team-rank: väärä joukkue = 0", function () {
    assertEqual(S.pointsForCategory(medalCats[0], medalCats, "Jukurit"), 0);
  });

  /* ---------- pointsForCategory: exact ---------- */

  test("pointsForCategory exact: täsmää = 1, ei täsmää = 0, avoinna = null", function () {
    var open = { id: "x", type: "exact", answer: null };
    var resolved = { id: "x", type: "exact", answer: "Matyas Kantner" };
    assertEqual(S.pointsForCategory(open, [open], "Matyas Kantner"), null);
    assertEqual(S.pointsForCategory(resolved, [resolved], "Matyas Kantner"), 1);
    assertEqual(S.pointsForCategory(resolved, [resolved], "Roni Hirvonen"), 0);
  });

  /* ---------- pointsForCategory: numeric-tolerance + closestPlayers ---------- */

  var toleranceCat = { id: "torj", type: "numeric-tolerance", tolerance: 0.2, answer: 92.59 };

  test("pointsForCategory numeric-tolerance: toleranssin sisällä = 1, ulkona = 0", function () {
    assertEqual(S.pointsForCategory(toleranceCat, [toleranceCat], 92.5), 1);
    assertEqual(S.pointsForCategory(toleranceCat, [toleranceCat], 90), 0);
  });

  test("closestPlayers: lähimpänä ollut voittaa, tasapelissä jaetaan", function () {
    var preds = { Asko: 92.5, Markus: 90, Ilpo: 92.7 };
    assertEqual(S.closestPlayers(toleranceCat, PLAYERS, preds), ["Asko"]);

    var tiePreds = { Asko: 92.49, Markus: 92.69, Ilpo: 90 };
    assertEqual(S.closestPlayers(toleranceCat, PLAYERS, tiePreds), ["Asko", "Markus"]);
  });

  /* ---------- computeSeasonScores / computeLiveSeasonTotals ---------- */

  test("computeSeasonScores: laskee kokonaispisteet useasta kategoriasta", function () {
    // medalCats: kulta=Tappara, hopea=Kärpät, pronssi=HIFK
    var season = {
      categories: medalCats,
      predictions: {
        kulta: { Asko: "Tappara", Markus: "Kärpät" },  // Asko oikein (3), Markus väärässä kohdassa (1)
        hopea: { Asko: "Jukurit", Markus: "Kärpät" },  // Asko väärä joukkue (0), Markus oikein (3)
        pronssi: { Asko: "HIFK", Markus: "Jukurit" }   // Asko oikein (3), Markus väärä joukkue (0)
      }
    };
    var r = S.computeSeasonScores(season, ["Asko", "Markus"]);
    assertEqual(r.totals.Asko, 3 + 0 + 3);   // = 6
    assertEqual(r.totals.Markus, 1 + 3 + 0); // = 4
  });

  test("computeLiveSeasonTotals: ratkennut kategoria säilyttää virallisen, avoin käyttää live-vastausta", function () {
    var season = {
      categories: [
        { id: "a", type: "exact", answer: "Tappara" }, // jo ratkennut
        { id: "b", type: "exact", answer: null }        // avoinna
      ],
      predictions: {
        a: { Asko: "Tappara", Markus: "Jokerit" },
        b: { Asko: "Kärpät", Markus: "Jokerit" }
      }
    };
    var liveAnswerFor = function (id) { return id === "b" ? "Kärpät" : null; };
    var totals = S.computeLiveSeasonTotals(season, ["Asko", "Markus"], { fake: true }, liveAnswerFor);
    assertEqual(totals.Asko, 1 + 1);  // a virallinen osui, b live-vastaus osui
    assertEqual(totals.Markus, 0);
  });

  /* ---------- overtimeTag ---------- */

  test("overtimeTag: tunnistaa jatkoajan ja voittolaukaukset", function () {
    assertEqual(S.overtimeTag("ENDED_DURING_WINNING_SHOT_COMPETITION"), "vl");
    assertEqual(S.overtimeTag("ENDED_DURING_OVERTIME"), "ja");
    assertEqual(S.overtimeTag("ENDED_DURING_REGULAR_GAME_TIME"), "");
  });

  /* ---------- Yhteenveto ---------- */

  var failed = results.filter(function (r) { return !r.ok; });
  var summary = results.length + " testiä, " + failed.length + " epäonnistui";

  if (isNode) {
    results.forEach(function (r) {
      console.log((r.ok ? "PASS" : "FAIL") + " - " + r.name + (r.error ? ": " + r.error : ""));
    });
    console.log(summary);
    if (failed.length) process.exit(1);
  } else {
    window.BTTestResults = { results: results, summary: summary };
  }
})();
