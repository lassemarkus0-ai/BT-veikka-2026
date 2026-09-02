/* scoring.js — puhtaat pisteytysfunktiot, ilman DOM- tai fetch-riippuvuuksia.
   Toimii sekä selaimessa (window.BTScoring) että Node.js:ssä (module.exports),
   jotta samat funktiot voi testata ajamalla scoring.test.js suoraan `node`:lla
   tai lataamalla test.html selaimessa -- ei build-askelta, ei riippuvuuksia. */

(function (root, factory) {
  "use strict";
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.BTScoring = factory();
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  function isResolved(match) {
    return match.result === "1" || match.result === "2";
  }

  // Suomalainen desimaalipilkku; painot ovat aina 1, 1,5 tai 2, tai näiden summia,
  // joten ei kellumaluku-pyöristysongelmia, mutta pyöristetään silti varmuuden vuoksi.
  function fmtPoints(n) {
    var r = Math.round(n * 10) / 10;
    return (r % 1 === 0 ? String(r) : r.toFixed(1)).replace(".", ",");
  }

  function fmtPct(n) {
    return n.toFixed(1).replace(".", ",") + " %";
  }

  /* ---------- Painokertoimet ----------
     Sääntö: eniten veikattu vaihtoehto = paino 1, vähiten veikattu = paino 2,
     tasan mennyt jako = paino 1,5 molemmille. Paino riippuu vain siitä miten
     porukka veikkasi, ei ottelun lopputuloksesta — voidaan siis laskea myös
     vielä pelaamattomalle ottelulle. */

  function voteCounts(match, players) {
    var c1 = 0, c2 = 0;
    players.forEach(function (name) {
      var p = match.predictions ? match.predictions[name] : undefined;
      if (p === "1") c1++;
      else if (p === "2") c2++;
    });
    return { c1: c1, c2: c2 };
  }

  function matchWeights(match, players) {
    var v = voteCounts(match, players);
    var w;
    if (v.c1 === v.c2) w = { w1: 1.5, w2: 1.5 };
    else if (v.c1 > v.c2) w = { w1: 1, w2: 2 };
    else w = { w1: 2, w2: 1 };
    w.c1 = v.c1;
    w.c2 = v.c2;
    return w;
  }

  // Toteutuneen tuloksen kerroin — tämä on ainoa kerroin joka vaikuttaa pisteisiin.
  function resultWeight(match, players) {
    if (!isResolved(match)) return null;
    var w = matchWeights(match, players);
    return match.result === "1" ? w.w1 : w.w2;
  }

  /* ---------- Kausiveikkaukset ---------- */

  function normVal(v) {
    if (v === null || v === undefined) return "";
    return String(v).trim().toLowerCase();
  }

  function isResolvedCat(cat) {
    return cat.answer !== null && cat.answer !== undefined && String(cat.answer).trim() !== "";
  }

  function rankGroupCats(categories, rankGroup) {
    return categories.filter(function (c) { return c.rankGroup === rankGroup; });
  }

  function rankGroupResolved(categories, rankGroup) {
    var group = rankGroupCats(categories, rankGroup);
    return group.length > 0 && group.every(isResolvedCat);
  }

  // Palauttaa pisteet yhdestä veikkauksesta, tai null jos kategoria ei ole
  // vielä ratkennut (tarkkuusveikkauksissa "lähimpänä" -bonus lasketaan erikseen).
  // Toimii sekä virallisille (answer) että live-ennakon kategorioille -- kutsuja
  // päättää mistä "answer" on peräisin.
  function pointsForCategory(cat, categories, pick) {
    if (cat.type === "team-rank") {
      if (!rankGroupResolved(categories, cat.rankGroup)) return null;
      if (!pick) return 0;
      if (normVal(pick) === normVal(cat.answer)) return 3;
      var group = rankGroupCats(categories, cat.rankGroup);
      var rightTeamWrongSlot = group.some(function (c) { return normVal(c.answer) === normVal(pick); });
      return rightTeamWrongSlot ? 1 : 0;
    }
    if (cat.type === "exact") {
      if (!isResolvedCat(cat)) return null;
      if (!pick) return 0;
      return normVal(pick) === normVal(cat.answer) ? 1 : 0;
    }
    if (cat.type === "numeric-tolerance") {
      if (!isResolvedCat(cat)) return null;
      if (pick === "" || pick === null || pick === undefined || isNaN(Number(pick))) return 0;
      var diff = Math.abs(Number(pick) - Number(cat.answer));
      return diff <= cat.tolerance ? 1 : 0;
    }
    return null;
  }

  // Ketkä osuivat lähimmäs oikeaa lukuarvoa (jaettu bonuspiste tasapelissä).
  function closestPlayers(cat, players, predictions) {
    if (!isResolvedCat(cat)) return [];
    var answer = Number(cat.answer);
    // Kahden vaiheen laskenta (kaikki erot ensin, sitten suodatus) eikä
    // juokseva paras-niin-pitkälle -vertailu: liukulukujen tarkka === ei
    // luotettavasti tunnista aitoja tasapelejä (esim. 92,49 ja 92,69 kun
    // vastaus on 92,59 -- molemmat erot ovat "0,1" mutta eivät bittitasolla
    // identtiset), joten tasapeli tunnistetaan pienellä toleranssilla.
    var EPS = 1e-9;
    var diffs = [];
    players.forEach(function (name) {
      var pick = predictions[name];
      if (pick === undefined || pick === null || pick === "" || isNaN(Number(pick))) return;
      diffs.push({ name: name, diff: Math.abs(Number(pick) - answer) });
    });
    if (!diffs.length) return [];
    var minDiff = diffs.reduce(function (m, d) { return Math.min(m, d.diff); }, Infinity);
    return diffs
      .filter(function (d) { return Math.abs(d.diff - minDiff) <= EPS; })
      .map(function (d) { return d.name; });
  }

  // Laskee jokaisen kategorian veikkaukset + pisteet ja pelaajakohtaiset summat
  // VIRALLISTEN (season-bets.json:in "answer") vastausten perusteella.
  function computeSeasonScores(season, players) {
    var categories = season.categories;
    var totals = {};
    players.forEach(function (name) { totals[name] = 0; });

    var detail = categories.map(function (cat) {
      var predictions = (season.predictions && season.predictions[cat.id]) || {};
      var closest = cat.type === "numeric-tolerance" ? closestPlayers(cat, players, predictions) : [];

      var picks = {};
      players.forEach(function (name) {
        var pick = predictions[name];
        var pts = pointsForCategory(cat, categories, pick);
        if (pts !== null && closest.indexOf(name) !== -1) pts += 1;
        picks[name] = { value: pick, points: pts };
        if (pts) totals[name] += pts;
      });

      return { cat: cat, picks: picks, closest: closest };
    });

    return { totals: totals, detail: detail };
  }

  // Pelaajakohtaiset kausiveikkausten KOKONAISPISTEET "jos kausi loppuisi nyt":
  // ratkenneet kategoriat pisteytetään virallisella vastauksella (ei koskaan
  // muutu), ratkeamattomat annetulla liveAnswerFor-funktiolla siltä osin kuin
  // sellainen on saatavilla. Kutsuja (app.js) antaa liveAnswerFor:in, koska se
  // riippuu Liiga-APIn datamuodosta eikä kuulu puhtaaseen pisteytyslogiikkaan.
  function computeLiveSeasonTotals(season, players, live, liveAnswerFor) {
    if (!season || !live) return null;

    var categories = season.categories.map(function (cat) {
      if (isResolvedCat(cat)) return cat;
      var clone = {};
      for (var k in cat) if (Object.prototype.hasOwnProperty.call(cat, k)) clone[k] = cat[k];
      clone.answer = liveAnswerFor(cat.id, live);
      return clone;
    });

    var totals = {};
    players.forEach(function (name) { totals[name] = 0; });

    categories.forEach(function (cat) {
      var predictions = (season.predictions && season.predictions[cat.id]) || {};
      var closest = cat.type === "numeric-tolerance" ? closestPlayers(cat, players, predictions) : [];
      players.forEach(function (name) {
        var pick = predictions[name];
        var pts = pointsForCategory(cat, categories, pick);
        if (pts !== null && closest.indexOf(name) !== -1) pts += 1;
        if (pts) totals[name] += pts;
      });
    });

    return totals;
  }

  /* ---------- Ottelupisteiden laskenta ---------- */

  function computeMatchPoints(data) {
    var points = {}, hits = {}, played = {};
    data.players.forEach(function (name) { points[name] = 0; hits[name] = 0; played[name] = 0; });

    data.matches.forEach(function (match) {
      if (!isResolved(match)) return;
      var weight = resultWeight(match, data.players);
      data.players.forEach(function (name) {
        var pick = match.predictions ? match.predictions[name] : undefined;
        if (pick !== "1" && pick !== "2") return;
        played[name]++;
        if (pick === match.result) {
          hits[name]++;
          points[name] += weight;
        }
      });
    });

    return { points: points, hits: hits, played: played };
  }

  function computeStandings(data, seasonTotals) {
    seasonTotals = seasonTotals || {};
    var mp = computeMatchPoints(data);

    var rows = data.players.map(function (name) {
      return {
        name: name,
        points: mp.points[name] + (seasonTotals[name] || 0),
        hits: mp.hits[name],
        played: mp.played[name]
      };
    });

    rows.sort(function (a, b) {
      if (b.points !== a.points) return b.points - a.points;
      return a.name.localeCompare(b.name, "fi");
    });
    return rows;
  }

  // Lisämerkintä jatkoajasta / voittolaukauksista
  function overtimeTag(finishedType) {
    if (!finishedType) return "";
    if (finishedType.indexOf("WINNING_SHOT") !== -1) return "vl";
    if (finishedType.indexOf("OVERTIME") !== -1) return "ja";
    return "";
  }

  return {
    isResolved: isResolved,
    fmtPoints: fmtPoints,
    fmtPct: fmtPct,
    voteCounts: voteCounts,
    matchWeights: matchWeights,
    resultWeight: resultWeight,
    normVal: normVal,
    isResolvedCat: isResolvedCat,
    rankGroupCats: rankGroupCats,
    rankGroupResolved: rankGroupResolved,
    pointsForCategory: pointsForCategory,
    closestPlayers: closestPlayers,
    computeSeasonScores: computeSeasonScores,
    computeLiveSeasonTotals: computeLiveSeasonTotals,
    computeMatchPoints: computeMatchPoints,
    computeStandings: computeStandings,
    overtimeTag: overtimeTag
  };
});
