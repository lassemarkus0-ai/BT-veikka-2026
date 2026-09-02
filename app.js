/* BT-Veikkaus — lukee data.json ja piirtää taulukon, seuraavan ottelun ja ottelulokin.
   liiga-live.js tuo lisäksi valinnaisen suoran yhteyden Liiga.fi:n APIin: live-tilanne,
   maalikohtaiset tapahtumat, kausiveikkausten "nyt johdossa" -ennakko, tilastoreferenssi
   ja voittoennuste. Kaikki tuo on parhaan yrityksen lisäys -- jos liiga.fi ei vastaa,
   sivu toimii silti normaalisti pelkän data.json/season-bets.json varassa. */

(function () {
  "use strict";

  var TEAM = "Kärpät";
  var GK_MIN_GAMES = 20; // sama oletus kuin update_season_bets.py:ssä
  var FORECAST_TRIALS = 10000;
  var LIVE_POLL_MS = 45000;

  var state = {
    data: null, season: null, live: null,
    filter: "all", initials: {}, liveTimer: null
  };

  var $ = function (id) { return document.getElementById(id); };

  /* ---------- Apufunktiot ---------- */

  function pad2(n) { return n < 10 ? "0" + n : String(n); }

  // "01.09.2026 18.30" -> Date
  function parseDate(str) {
    var m = /^(\d{2})\.(\d{2})\.(\d{4})\s+(\d{1,2})\.(\d{2})$/.exec(String(str).trim());
    if (!m) return null;
    return new Date(+m[3], +m[2] - 1, +m[1], +m[4], +m[5]);
  }

  // "01.09.2026 18.30" -> "2026-09-01" (Liiga-APIn odottama muoto)
  function toApiDate(dataDateStr) {
    var m = /^(\d{2})\.(\d{2})\.(\d{4})/.exec(String(dataDateStr).trim());
    return m ? (m[3] + "-" + m[2] + "-" + m[1]) : null;
  }

  function fmtDay(d) {
    if (!d) return "";
    return pad2(d.getDate()) + "." + pad2(d.getMonth() + 1) + ".";
  }

  function fmtLong(d) {
    if (!d) return "";
    var days = ["su", "ma", "ti", "ke", "to", "pe", "la"];
    return days[d.getDay()] + " " + pad2(d.getDate()) + "." + pad2(d.getMonth() + 1) + ". klo " +
           d.getHours() + "." + pad2(d.getMinutes());
  }

  // Lyhenteet: kasvatetaan kirjainmäärää kunnes jokainen on yksilöllinen
  // (Asko ja Absolut erottuvat vasta kahdella kirjaimella).
  function buildInitials(players) {
    var out = {};
    var len = 1;
    while (len <= 6) {
      var seen = {}, clash = false;
      for (var i = 0; i < players.length; i++) {
        var k = players[i].slice(0, len);
        if (seen[k]) { clash = true; break; }
        seen[k] = true;
      }
      if (!clash) break;
      len++;
    }
    for (var j = 0; j < players.length; j++) {
      out[players[j]] = players[j].slice(0, len);
    }
    return out;
  }

  function isResolved(match) {
    return match.result === "1" || match.result === "2";
  }

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = text;
    return n;
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

  /* ---------- Kausiveikkaukset ----------
     Erillinen kausikohtainen veikkaussarja (season-bets.json): mitalit,
     runkosarjan kärkisijat, putoajat ja yksittäiset tilastoveikkaukset.
     "answer" on null/tyhjä kunnes lopputulos tiedetään -- siihen asti
     kategoria ei anna pisteitä, vaikka veikkaukset näkyvätkin. */

  var SEASON_GROUP_ORDER = ["medals", "standings", "relegation", "misc", "tolerance"];
  var SEASON_GROUP_LABELS = {
    medals: "Mitalit",
    standings: "Runkosarjan kärkisijat",
    relegation: "Putoajat",
    misc: "Muut veikkaukset",
    tolerance: "Tarkkuusveikkaukset"
  };

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
    var best = null;
    var winners = [];
    players.forEach(function (name) {
      var pick = predictions[name];
      if (pick === undefined || pick === null || pick === "" || isNaN(Number(pick))) return;
      var diff = Math.abs(Number(pick) - answer);
      if (best === null || diff < best) {
        best = diff;
        winners = [name];
      } else if (diff === best) {
        winners.push(name);
      }
    });
    return winners;
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

  /* ---------- Kausiveikkausten "live" ennakko ----------
     Lasketaan Liiga.fi:n tuoreesta datasta sama vastaus jonka
     update_season_bets.py laskisi kauden päätyttyä -- MUTTA vain näytöksi:
     ei koskaan kirjoiteta season-bets.json:iin eikä lasketa mukaan
     sarjataulukon kokonaispisteisiin. Vain kategorioille joilla on suora
     tilastollinen lähde; mitalit/putoajat ratkeavat pudotuspeleissä eikä
     niille ole live-lähdettä. */

  function liveName(rec) { return rec ? LiigaLive.playerName(rec) : null; }

  function liveQualifiedGoalie(goalies) {
    if (!goalies) return null;
    var pool = goalies.filter(function (g) { return (g.games || 0) >= GK_MIN_GAMES; });
    return pool.length ? LiigaLive.topBy(pool, "savePercentage") : null;
  }

  function liveAnswerFor(catId, live) {
    if (!live) return null;
    var standings = live.standings, skaters = live.skaters, goalies = live.goalies;

    function rankTeam(rank) {
      if (!standings) return null;
      var hit = standings.filter(function (s) { return s.ranking === rank; });
      return hit.length ? hit[0].teamName : null;
    }

    switch (catId) {
      case "runkosarja_1": return rankTeam(1);
      case "runkosarja_2": return rankTeam(2);
      case "runkosarja_3": return rankTeam(3);
      case "runkosarjan_viimeinen": {
        if (!standings || !standings.length) return null;
        var maxRank = standings.reduce(function (m, s) { return Math.max(m, s.ranking); }, 0);
        return rankTeam(maxRank);
      }
      case "karpat_liigasijoitus": {
        if (!standings) return null;
        var k = standings.filter(function (s) { return s.teamName === TEAM; });
        return k.length ? String(k[0].ranking) : null;
      }
      case "liiga_paras_pisteporssi":  return skaters ? liveName(LiigaLive.topBy(skaters, "points")) : null;
      case "karpat_paras_pisteporssi": return skaters ? liveName(LiigaLive.topBy(skaters, "points", TEAM)) : null;
      case "liiga_paras_maalintekija": return skaters ? liveName(LiigaLive.topBy(skaters, "goals")) : null;
      case "karpat_paras_maalintekija":return skaters ? liveName(LiigaLive.topBy(skaters, "goals", TEAM)) : null;
      case "liiga_jaahykuningas":      return skaters ? liveName(LiigaLive.topBy(skaters, "penaltyMinutes")) : null;
      case "karpat_jaahykuningas":     return skaters ? liveName(LiigaLive.topBy(skaters, "penaltyMinutes", TEAM)) : null;
      case "liiga_paras_plusmiinus":   return skaters ? liveName(LiigaLive.topBy(skaters, "plusMinus")) : null;
      case "karpat_paras_plusmiinus":  return skaters ? liveName(LiigaLive.topBy(skaters, "plusMinus", TEAM)) : null;
      case "liiga_huonoin_plusmiinus": return skaters ? liveName(LiigaLive.bottomBy(skaters, "plusMinus")) : null;
      case "karpat_huonoin_plusmiinus":return skaters ? liveName(LiigaLive.bottomBy(skaters, "plusMinus", TEAM)) : null;
      case "liiga_paras_maalivahti":   return liveName(liveQualifiedGoalie(goalies));
      case "liiga_mv_torjuntaprosentti": {
        var g = liveQualifiedGoalie(goalies);
        return g ? g.savePercentage : null;
      }
      // kulta/hopea/pronssi/putoaja_1-3: ratkeavat pudotuspeleissä/karsinnassa,
      // ei live-lähdettä. karpat_yleisokeskiarvo: vaatisi jokaisen pelatun
      // kotiottelun erillisen haun -- jätetty pois ylläpidon yksinkertaisuuden vuoksi.
      default: return null;
    }
  }

  // Sama pisteytys kuin viralliselle datalle, mutta "answer" korvataan
  // live-lasketulla arvolla. Palauttaa catId -> { answer, picks: {name: points} }.
  function computeLiveSeasonPreview(season, players, live) {
    if (!season || !live) return null;

    var liveCats = season.categories.map(function (cat) {
      var clone = {};
      for (var k in cat) if (Object.prototype.hasOwnProperty.call(cat, k)) clone[k] = cat[k];
      clone.answer = liveAnswerFor(cat.id, live);
      return clone;
    });

    var detail = {};
    liveCats.forEach(function (cat) {
      var predictions = (season.predictions && season.predictions[cat.id]) || {};
      var closest = cat.type === "numeric-tolerance" ? closestPlayers(cat, players, predictions) : [];
      var picks = {};
      players.forEach(function (name) {
        var pick = predictions[name];
        var pts = pointsForCategory(cat, liveCats, pick);
        if (pts !== null && closest.indexOf(name) !== -1) pts += 1;
        picks[name] = pts;
      });
      detail[cat.id] = { answer: cat.answer, picks: picks };
    });
    return detail;
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

  /* ---------- Piirto: Sarjataulukko / Seuraava ottelu / Otteluloki ---------- */

  function renderStandings(rows) {
    var list = $("standings");
    list.innerHTML = "";

    var best = rows.length ? rows[0].points : 0;
    var anyPlayed = rows.some(function (r) { return r.played > 0; });

    rows.forEach(function (row, i) {
      var leading = anyPlayed && row.points === best && best > 0;

      var li = el("li", "stand-row" + (leading ? " is-lead" : ""));

      li.appendChild(el("span", "stand-rank", String(i + 1)));

      var main = el("div", "stand-main");
      main.appendChild(el("span", "stand-name", row.name));

      var track = el("div", "track");
      var fill = el("span", "fill");
      // Palkin pituus suhteessa kärkeen, ei osumaprosenttiin — painotetut
      // pisteet voivat ylittää pelattujen otteluiden määrän.
      var pct = best ? (row.points / best) * 100 : 0;
      track.appendChild(fill);
      main.appendChild(track);
      li.appendChild(main);

      var figs = el("div", "stand-figs");
      figs.appendChild(el("span", "stand-pts", fmtPoints(row.points)));
      figs.appendChild(el("span", "stand-pct",
        row.played ? row.hits + "/" + row.played + " oikein" : "ei pelejä"));
      li.appendChild(figs);

      list.appendChild(li);

      // Palkki kasvaa kerran latauksen jälkeen.
      requestAnimationFrame(function () {
        requestAnimationFrame(function () { fill.style.width = pct + "%"; });
      });
    });

    var resolved = state.data.matches.filter(isResolved).length;
    $("board-note").textContent = resolved
      ? resolved + " / " + state.data.matches.length + " ottelua ratkennut"
      : "Kausi ei ole vielä alkanut";
  }

  function renderNext(data) {
    var upcoming = data.matches
      .filter(function (m) { return !isResolved(m); })
      .map(function (m) { return { m: m, d: parseDate(m.date) }; })
      .filter(function (x) { return x.d; })
      .sort(function (a, b) { return a.d - b.d; });

    var sec = $("next-section");
    if (!upcoming.length) { sec.hidden = true; return; }

    var next = upcoming[0];
    sec.hidden = false;
    $("next-date").textContent = fmtLong(next.d);

    var teams = $("next-teams");
    teams.innerHTML = "";
    [next.m.homeTeam, "–", next.m.awayTeam].forEach(function (part, i) {
      if (i === 1) { teams.appendChild(document.createTextNode(" – ")); return; }
      var s = el("span", part === TEAM ? "m-karpat" : null, part);
      teams.appendChild(s);
    });

    var list = $("next-picks");
    list.innerHTML = "";
    data.players.forEach(function (name) {
      var pick = next.m.predictions ? next.m.predictions[name] : "";
      var li = el("li", "next-pick");
      li.appendChild(el("span", "next-pick-name", name));
      li.appendChild(el("span", "next-pick-val", pick || "–"));
      list.appendChild(li);
    });

    var splitEl = $("next-split");
    var vw = matchWeights(next.m, data.players);
    if (vw.c1 + vw.c2 > 0) {
      splitEl.hidden = false;
      splitEl.textContent = "Jako juuri nyt: 1 = " + vw.c1 + " (kerroin ×" + fmtPoints(vw.w1) +
        "), 2 = " + vw.c2 + " (kerroin ×" + fmtPoints(vw.w2) + ")";
    } else {
      splitEl.hidden = true;
    }

    // Veikkauksen kerroin -- valinnainen, haetaan taustalla eikä estä muuta piirtoa.
    var oddsEl = $("next-odds");
    oddsEl.hidden = true;
    if (window.LiigaLive) {
      var apiDate = toApiDate(next.m.date);
      var karpatHome = next.m.homeTeam === TEAM;
      if (apiDate) {
        LiigaLive.fetchGamesForDate(apiDate).then(function (games) {
          var game = LiigaLive.findGame(games, next.m.homeTeam, next.m.awayTeam);
          var p = LiigaLive.impliedWinProbability(game, karpatHome);
          if (p !== null) {
            oddsEl.hidden = false;
            oddsEl.textContent = "Veikkauksen kerroin ennustaa Kärpille " +
              (p * 100).toFixed(0) + " % voittotodennäköisyyttä.";
          }
        });
      }
    }
  }

  function renderMatches(data) {
    var list = $("matches");
    var emptyMsg = $("log-empty");
    list.innerHTML = "";

    var items = data.matches
      .map(function (m) { return { m: m, d: parseDate(m.date) }; })
      .sort(function (a, b) {
        if (!a.d || !b.d) return 0;
        return a.d - b.d;
      });

    if (state.filter === "played") {
      items = items.filter(function (x) { return isResolved(x.m); });
    } else if (state.filter === "upcoming") {
      items = items.filter(function (x) { return !isResolved(x.m); });
    }

    if (!items.length) {
      emptyMsg.hidden = false;
      emptyMsg.textContent = state.filter === "played"
        ? "Yhtään ottelua ei ole vielä pelattu."
        : "Kaikki ottelut on pelattu.";
      return;
    }
    emptyMsg.hidden = true;

    items.forEach(function (x) {
      var m = x.m;
      var resolved = isResolved(m);

      var li = el("li", "match" + (resolved ? "" : " is-upcoming"));

      var top = el("div", "m-top");
      top.appendChild(el("span", "m-date", fmtDay(x.d)));

      var teams = el("span", "m-teams");
      var home = el("span", m.homeTeam === TEAM ? "m-karpat" : null, m.homeTeam);
      var away = el("span", m.awayTeam === TEAM ? "m-karpat" : null, m.awayTeam);
      teams.appendChild(home);
      teams.appendChild(document.createTextNode(" – "));
      teams.appendChild(away);
      top.appendChild(teams);

      var score;
      if (resolved && m.homeGoals !== undefined && m.awayGoals !== undefined) {
        score = el("span", "m-score");
        score.appendChild(document.createTextNode(m.homeGoals + "–" + m.awayGoals));
        var tag = overtimeTag(m.finishedType);
        if (tag) score.appendChild(el("span", "m-ot", tag));
      } else if (resolved) {
        score = el("span", "m-score", m.result === "1" ? "1" : "2");
      } else {
        score = el("span", "m-score is-pending", "–");
      }
      if (resolved) {
        var vw = matchWeights(m, data.players);
        var weight = m.result === "1" ? vw.w1 : vw.w2;
        score.appendChild(el("span", "m-weight", "×" + fmtPoints(weight)));
        score.title = "Veikkausjako: 1 – " + vw.c1 + " kpl, 2 – " + vw.c2 +
          " kpl. Oikean veikkauksen kerroin ×" + fmtPoints(weight) + ".";
      }
      top.appendChild(score);
      li.appendChild(top);

      var picks = el("ul", "m-picks");
      data.players.forEach(function (name) {
        var pick = m.predictions ? m.predictions[name] : "";
        var cls = "chip";
        if (resolved && pick) cls += (pick === m.result) ? " is-hit" : " is-miss";

        var chip = el("li", cls);
        chip.appendChild(document.createTextNode(state.initials[name]));
        chip.appendChild(el("b", null, pick || "–"));

        var verdict = resolved && pick
          ? (pick === m.result ? "osui" : "meni ohi")
          : "ratkeamatta";
        chip.title = name + ": " + (pick || "ei veikkausta") + " – " + verdict;
        picks.appendChild(chip);
      });
      li.appendChild(picks);

      if (resolved && window.LiigaLive) {
        var expandBtn = el("button", "m-expand-btn", "Maalit ▸");
        expandBtn.type = "button";
        expandBtn.addEventListener("click", function () {
          toggleGameDetail(li, m);
          var d = li.querySelector(".m-detail");
          expandBtn.textContent = (d && !d.hidden) ? "Maalit ▾" : "Maalit ▸";
        });
        li.appendChild(expandBtn);
      }

      list.appendChild(li);
    });
  }

  // Maalikohtaiset tapahtumat -- haetaan Liiga.fi:stä vasta kun rivi avataan,
  // ja välimuistitetaan (liiga-live.js) jos samaa päivää kysytään uudelleen.
  function toggleGameDetail(li, match) {
    var existing = li.querySelector(".m-detail");
    if (existing) { existing.hidden = !existing.hidden; return; }

    var detail = el("div", "m-detail");
    detail.appendChild(el("p", "m-detail-loading", "Ladataan maaleja…"));
    li.appendChild(detail);

    var apiDate = toApiDate(match.date);
    if (!apiDate) { detail.innerHTML = ""; detail.appendChild(el("p", "m-detail-empty", "Ei saatavilla.")); return; }

    LiigaLive.fetchGamesForDate(apiDate).then(function (games) {
      var game = LiigaLive.findGame(games, match.homeTeam, match.awayTeam);
      detail.innerHTML = "";

      if (!game) {
        detail.appendChild(el("p", "m-detail-empty", "Ottelun tapahtumia ei löytynyt."));
        return;
      }

      var events = [];
      ["homeTeam", "awayTeam"].forEach(function (side) {
        var team = game[side];
        if (!team || !team.goalEvents) return;
        team.goalEvents.forEach(function (ev) {
          events.push({
            period: ev.period,
            gameTime: ev.gameTime,
            scorer: ev.scorerPlayer ? (ev.scorerPlayer.firstName + " " + ev.scorerPlayer.lastName) : "?",
            assists: (ev.assistantPlayers || []).map(function (p) { return p.firstName + " " + p.lastName; }),
            teamName: team.teamName
          });
        });
      });

      if (!events.length) {
        detail.appendChild(el("p", "m-detail-empty", "Ei maalitietoja."));
        return;
      }

      events.sort(function (a, b) { return (a.period - b.period) || (a.gameTime - b.gameTime); });

      var ul = el("ul", "goal-events");
      events.forEach(function (ev) {
        var row = el("li", "goal-event" + (ev.teamName === TEAM ? " is-karpat" : ""));
        // gameTime on ottelun kokonaiskulunut aika, ei erän sisäinen -- muunnetaan
        // erän sisäiseksi ajaksi (20 min/erä; jatkoaika ei mahdu tähän kaavaan,
        // mutta jatkoaikamaalit ovat harvinaisia eikä niiden aika ole kriittinen).
        var inPeriod = ev.gameTime - (ev.period - 1) * 20 * 60;
        if (inPeriod < 0) inPeriod = ev.gameTime;
        var mins = Math.floor(inPeriod / 60);
        var secs = inPeriod % 60;
        row.appendChild(el("span", "goal-time", ev.period + ". erä " + mins + ":" + pad2(secs)));
        var who = el("span", "goal-who");
        who.appendChild(el("b", null, ev.scorer));
        if (ev.assists.length) who.appendChild(document.createTextNode(" (" + ev.assists.join(", ") + ")"));
        row.appendChild(who);
        ul.appendChild(row);
      });
      detail.appendChild(ul);
    });
  }

  /* ---------- Piirto: Kausiveikkaukset ---------- */

  function renderSeason(season, players, computed, liveDetail) {
    var section = $("season-section");
    if (!season || !computed) { section.hidden = true; return; }
    section.hidden = false;

    var anyLive = false;

    var byGroup = {};
    computed.detail.forEach(function (d) {
      var g = d.cat.group;
      (byGroup[g] = byGroup[g] || []).push(d);
    });

    var container = $("season-groups");
    container.innerHTML = "";

    SEASON_GROUP_ORDER.forEach(function (g) {
      var items = byGroup[g];
      if (!items || !items.length) return;

      var groupEl = el("div", "season-group");
      groupEl.appendChild(el("h3", "season-group-h", SEASON_GROUP_LABELS[g] || g));

      var list = el("ul", "season-cats");
      items.forEach(function (d) {
        var cat = d.cat;
        var resolved = isResolvedCat(cat);

        var li = el("li", "season-cat" + (resolved ? "" : " is-upcoming"));

        var top = el("div", "sc-top");
        top.appendChild(el("span", "sc-label", cat.label));
        var answerText = resolved ? String(cat.answer) + (cat.unit ? " " + cat.unit : "") : "avoinna";
        top.appendChild(el("span", "sc-answer" + (resolved ? "" : " is-pending"), answerText));
        li.appendChild(top);

        var picks = el("ul", "m-picks");
        players.forEach(function (name) {
          var p = d.picks[name];
          var cls = "chip";
          if (p.points !== null) cls += p.points > 0 ? " is-hit" : " is-miss";

          var chip = el("li", cls);
          chip.appendChild(document.createTextNode(state.initials[name]));
          var valText = (p.value === undefined || p.value === null || p.value === "") ? "–" : String(p.value);
          chip.appendChild(el("b", null, valText));
          if (p.points) chip.appendChild(el("span", "sc-pts", "+" + p.points));

          var verdict = p.points === null ? "ratkeamatta" : (p.points > 0 ? p.points + " p" : "ei osunut");
          chip.title = name + ": " + valText + " – " + verdict;
          picks.appendChild(chip);
        });
        li.appendChild(picks);

        // "Nyt johdossa" -ennakko: vain ratkeamattomille kategorioille joilla
        // on live-lähde, eikä koskaan sarjataulukon pisteisiin.
        if (!resolved && liveDetail && liveDetail[cat.id] && liveDetail[cat.id].answer !== null) {
          anyLive = true;
          var lv = liveDetail[cat.id];
          var liveLine = el("p", "sc-live");
          liveLine.appendChild(document.createTextNode("Nyt johdossa: "));
          liveLine.appendChild(el("b", null, String(lv.answer) + (cat.unit ? " " + cat.unit : "")));
          var scorers = players.filter(function (name) { return lv.picks[name] > 0; });
          if (scorers.length) {
            var txt = scorers.map(function (name) {
              return state.initials[name] + " +" + lv.picks[name];
            }).join(", ");
            liveLine.appendChild(document.createTextNode(" (" + txt + ")"));
          }
          li.appendChild(liveLine);
        }

        list.appendChild(li);
      });

      groupEl.appendChild(list);
      container.appendChild(groupEl);
    });

    $("season-live-note").hidden = !anyLive;
  }

  /* ---------- Piirto: Tilastot-välilehti ---------- */

  function topN(records, key, n, team) {
    var pool = records.filter(function (r) { return !team || r.teamName === team; });
    return pool.slice().sort(function (a, b) { return b[key] - a[key]; }).slice(0, n);
  }

  function statLeaderBlock(title, rows, key, unit, valueFmt) {
    var block = el("div", "stat-block");
    block.appendChild(el("h3", "stat-block-h", title));
    if (!rows.length) {
      block.appendChild(el("p", "empty", "Ei vielä tilastoja."));
      return block;
    }
    var ol = el("ol", "stat-leader-list");
    rows.forEach(function (r) {
      var li = el("li", "stat-leader-row" + (r.teamName === TEAM ? " is-karpat" : ""));
      li.appendChild(el("span", "stat-leader-name", LiigaLive.playerName(r) + " (" + r.teamName + ")"));
      var val = valueFmt ? valueFmt(r[key]) : r[key];
      li.appendChild(el("span", "stat-leader-val", val + (unit ? " " + unit : "")));
      ol.appendChild(li);
    });
    block.appendChild(ol);
    return block;
  }

  function renderStatsReference() {
    var content = $("stats-content");
    content.innerHTML = "";

    var live = state.live;
    if (!live || (!live.standings && !live.skaters && !live.goalies)) {
      content.appendChild(el("p", "empty", "Tilastoja ei saatu ladattua Liiga.fi:stä."));
      return;
    }

    if (live.standings && live.standings.length) {
      var table = el("div", "stats-table-wrap");
      var head = el("div", "stats-row stats-head");
      ["#", "Joukkue", "O", "Pisteet"].forEach(function (h) {
        head.appendChild(el("span", null, h));
      });
      table.appendChild(head);

      var sorted = live.standings.slice().sort(function (a, b) { return a.ranking - b.ranking; });
      sorted.forEach(function (s) {
        var row = el("div", "stats-row" + (s.teamName === TEAM ? " is-karpat" : ""));
        row.appendChild(el("span", null, String(s.ranking)));
        row.appendChild(el("span", null, s.teamName));
        row.appendChild(el("span", null, String(s.games)));
        row.appendChild(el("span", "stats-pts", String(s.points)));
        table.appendChild(row);
      });
      content.appendChild(table);
    }

    if (live.skaters && live.skaters.length) {
      var grid = el("div", "stat-grid");
      grid.appendChild(statLeaderBlock("Pisteet", topN(live.skaters, "points", 5), "points"));
      grid.appendChild(statLeaderBlock("Maalit", topN(live.skaters, "goals", 5), "goals"));
      grid.appendChild(statLeaderBlock("Jäähyt", topN(live.skaters, "penaltyMinutes", 5), "penaltyMinutes", "min"));
      grid.appendChild(statLeaderBlock("Paras +/-", topN(live.skaters, "plusMinus", 5), "plusMinus"));
      content.appendChild(grid);
    }

    if (live.goalies && live.goalies.length) {
      var qualified = live.goalies.filter(function (g) { return (g.games || 0) >= GK_MIN_GAMES; });
      var gkNote = el("p", "sec-note",
        "Torjuntaprosentin kärki vaatii vähintään " + GK_MIN_GAMES + " ottelua.");
      content.appendChild(gkNote);
      var gkGrid = el("div", "stat-grid");
      gkGrid.appendChild(statLeaderBlock(
        "Torjuntaprosentti", topN(qualified, "savePercentage", 5), "savePercentage", "%",
        function (v) { return String(v).replace(".", ","); }));
      content.appendChild(gkGrid);
    }
  }

  /* ---------- Piirto: Live-banneri ---------- */

  function renderLiveBanner(game) {
    var banner = $("live-banner");
    if (!game || !game.started || game.ended || !game.homeTeam || !game.awayTeam) {
      banner.hidden = true;
      return;
    }
    banner.hidden = false;
    var period = game.currentPeriod ? game.currentPeriod + ". erä" : "käynnissä";
    $("live-text").textContent = game.homeTeam.teamName + " " + game.homeTeam.goals + "–" +
      game.awayTeam.goals + " " + game.awayTeam.teamName + " · " + period;
  }

  function stopLivePolling() {
    if (state.liveTimer) { clearInterval(state.liveTimer); state.liveTimer = null; }
  }

  function checkLiveGame() {
    if (!window.LiigaLive || !state.data) return;

    var today = new Date();
    var todayShort = pad2(today.getDate()) + "." + pad2(today.getMonth() + 1) + "." + today.getFullYear();
    var apiDate = today.getFullYear() + "-" + pad2(today.getMonth() + 1) + "-" + pad2(today.getDate());

    var todaysMatch = state.data.matches.filter(function (m) {
      return !isResolved(m) && m.date.indexOf(todayShort) === 0;
    })[0];
    if (!todaysMatch) return;

    function poll() {
      LiigaLive.fetchGamesForDate(apiDate).then(function (games) {
        var game = LiigaLive.findGame(games, todaysMatch.homeTeam, todaysMatch.awayTeam);
        renderLiveBanner(game);
        if (game && game.ended) stopLivePolling();
      });
    }

    poll();
    state.liveTimer = setInterval(poll, LIVE_POLL_MS);

    document.addEventListener("visibilitychange", function () {
      if (document.hidden) {
        stopLivePolling();
      } else if (!state.liveTimer) {
        poll();
        state.liveTimer = setInterval(poll, LIVE_POLL_MS);
      }
    });
  }

  /* ---------- Piirto: Voittoennuste ---------- */

  function fallbackProb(match, players) {
    var v = voteCounts(match, players);
    var total = v.c1 + v.c2;
    return total ? v.c1 / total : 0.5;
  }

  function runForecast() {
    var data = state.data;
    var players = data.players;
    var unresolved = data.matches.filter(function (m) { return !isResolved(m); });
    var mp = computeMatchPoints(data);

    var content = $("forecast-content");
    content.innerHTML = "";
    content.appendChild(el("p", "empty", "Haetaan kertoimia…"));

    if (!unresolved.length) {
      content.innerHTML = "";
      content.appendChild(el("p", "empty", "Kausi on jo ratkennut."));
      return;
    }

    var probPromises = unresolved.map(function (m) {
      var karpatHome = m.homeTeam === TEAM;
      var apiDate = toApiDate(m.date);
      if (!apiDate || !window.LiigaLive) return Promise.resolve(fallbackProb(m, players));
      return LiigaLive.fetchGamesForDate(apiDate).then(function (games) {
        var game = LiigaLive.findGame(games, m.homeTeam, m.awayTeam);
        var p = LiigaLive.impliedWinProbability(game, karpatHome);
        return p === null ? fallbackProb(m, players) : p;
      });
    });

    Promise.all(probPromises).then(function (probs) {
      renderForecastResult(unresolved, probs, mp, players);
    });
  }

  function renderForecastResult(unresolved, probs, mp, players) {
    var wins = {};
    players.forEach(function (name) { wins[name] = 0; });

    // Esilasketaan jokaisen jäljellä olevan ottelun kerroin + veikkaukset,
    // jotta itse simulointisilmukka on kevyt.
    var matchesInfo = unresolved.map(function (m, i) {
      var vw = matchWeights(m, players);
      return { picks: m.predictions || {}, w1: vw.w1, w2: vw.w2, p: probs[i] };
    });

    for (var t = 0; t < FORECAST_TRIALS; t++) {
      var totals = {};
      players.forEach(function (name) { totals[name] = mp.points[name]; });

      matchesInfo.forEach(function (info) {
        var karpatWins = Math.random() < info.p;
        var result = karpatWins ? "1" : "2";
        var weight = karpatWins ? info.w1 : info.w2;
        players.forEach(function (name) {
          if (info.picks[name] === result) totals[name] += weight;
        });
      });

      var bestPts = -Infinity;
      players.forEach(function (name) { if (totals[name] > bestPts) bestPts = totals[name]; });
      var leaders = players.filter(function (name) { return totals[name] === bestPts; });
      // Tasapelissä jaetaan "voitto" tasan kärkeen päätyneiden kesken --
      // yksinkertaisempi kuin täydellinen jakosääntö, mutta riittävä ennusteeseen.
      leaders.forEach(function (name) { wins[name] += 1 / leaders.length; });
    }

    var rows = players.map(function (name) {
      return { name: name, pct: (wins[name] / FORECAST_TRIALS) * 100 };
    }).sort(function (a, b) { return b.pct - a.pct; });

    var content = $("forecast-content");
    content.innerHTML = "";
    content.appendChild(el("p", "sec-note", unresolved.length + " jäljellä olevaa ottelua simuloitu (" +
      FORECAST_TRIALS.toLocaleString("fi") + " kierrosta)."));

    var list = el("ul", "forecast-list");
    var best = rows.length ? rows[0].pct : 0;
    rows.forEach(function (row) {
      var li = el("li", "forecast-row" + (row.pct === best && best > 0 ? " is-lead" : ""));
      li.appendChild(el("span", "forecast-name", row.name));
      var track = el("div", "track");
      var fill = el("span", "fill");
      track.appendChild(fill);
      li.appendChild(track);
      li.appendChild(el("span", "forecast-pct", fmtPct(row.pct)));
      list.appendChild(li);

      requestAnimationFrame(function () {
        requestAnimationFrame(function () {
          fill.style.width = (best ? (row.pct / best) * 100 : 0) + "%";
        });
      });
    });
    content.appendChild(list);
  }

  /* ---------- Välilehdet ja suodattimet ---------- */

  function wireTabs() {
    var buttons = document.querySelectorAll(".tab");
    var panels = document.querySelectorAll(".tab-panel");
    Array.prototype.forEach.call(buttons, function (btn) {
      btn.addEventListener("click", function () {
        var tab = btn.getAttribute("data-tab");
        Array.prototype.forEach.call(buttons, function (b) {
          var on = b === btn;
          b.classList.toggle("is-on", on);
          b.setAttribute("aria-selected", on ? "true" : "false");
        });
        Array.prototype.forEach.call(panels, function (p) {
          p.hidden = p.id !== "tab-" + tab;
        });
      });
    });
  }

  function wireFilters() {
    var buttons = document.querySelectorAll(".filter");
    Array.prototype.forEach.call(buttons, function (btn) {
      btn.addEventListener("click", function () {
        state.filter = btn.getAttribute("data-filter");
        Array.prototype.forEach.call(buttons, function (b) {
          b.classList.toggle("is-on", b === btn);
        });
        renderMatches(state.data);
      });
    });
  }

  function wireForecast() {
    var btn = $("forecast-run");
    if (btn) btn.addEventListener("click", runForecast);
  }

  /* ---------- Kaiken piirto ---------- */

  function renderAll() {
    var seasonComputed = state.season ? computeSeasonScores(state.season, state.data.players) : null;
    var liveDetail = (state.season && state.live)
      ? computeLiveSeasonPreview(state.season, state.data.players, state.live)
      : null;

    renderStandings(computeStandings(state.data, seasonComputed ? seasonComputed.totals : {}));
    renderNext(state.data);
    renderMatches(state.data);
    renderSeason(state.season, state.data.players, seasonComputed, liveDetail);
    renderStatsReference();
  }

  /* ---------- Käynnistys ---------- */

  function boot() {
    var seasonFetch = fetch("season-bets.json", { cache: "no-cache" })
      .then(function (r) { return r.ok ? r.json() : null; })
      .catch(function () { return null; }); // kausiveikkaukset ovat valinnaiset -- sivu toimii ilmankin

    var liveFetch = window.LiigaLive
      ? LiigaLive.fetchAll(LiigaLive.currentSeason())
      : Promise.resolve(null); // liiga-live.js valinnainen -- sivu toimii ilmankin

    Promise.all([
      fetch("data.json", { cache: "no-cache" }).then(function (r) {
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.json();
      }),
      seasonFetch,
      liveFetch
    ])
      .then(function (results) {
        var data = results[0];
        var season = results[1];
        var live = results[2];
        if (!data || !Array.isArray(data.players) || !Array.isArray(data.matches)) {
          throw new Error("data.json ei sisällä players- ja matches-listoja");
        }
        state.data = data;
        state.season = (season && Array.isArray(season.categories)) ? season : null;
        state.live = live;
        state.initials = buildInitials(data.players);

        $("status").hidden = true;
        $("tabs").hidden = false;

        wireTabs();
        wireFilters();
        wireForecast();
        renderAll();
        checkLiveGame();

        var resolved = data.matches.filter(isResolved);
        if (resolved.length) {
          var last = resolved[resolved.length - 1];
          $("foot-upd").textContent = "Viimeisin päivitetty ottelu: " + last.date;
        }
      })
      .catch(function (err) {
        var s = $("status");
        s.hidden = false;
        s.className = "status is-error";
        s.textContent = "Veikkauksia ei saatu ladattua (" + err.message +
          "). Tarkista että data.json on samassa kansiossa kuin index.html.";
      });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
