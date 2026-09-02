/* BT-Veikkaus — lukee data.json ja piirtää taulukon, seuraavan ottelun ja ottelulokin. */

(function () {
  "use strict";

  var TEAM = "Kärpät";
  var state = { data: null, season: null, filter: "all", initials: {} };

  var $ = function (id) { return document.getElementById(id); };

  /* ---------- Apufunktiot ---------- */

  // "01.09.2026 18.30" -> Date
  function parseDate(str) {
    var m = /^(\d{2})\.(\d{2})\.(\d{4})\s+(\d{1,2})\.(\d{2})$/.exec(String(str).trim());
    if (!m) return null;
    return new Date(+m[3], +m[2] - 1, +m[1], +m[4], +m[5]);
  }

  function fmtDay(d) {
    if (!d) return "";
    var p = function (n) { return n < 10 ? "0" + n : String(n); };
    return p(d.getDate()) + "." + p(d.getMonth() + 1) + ".";
  }

  function fmtLong(d) {
    if (!d) return "";
    var days = ["su", "ma", "ti", "ke", "to", "pe", "la"];
    var p = function (n) { return n < 10 ? "0" + n : String(n); };
    return days[d.getDay()] + " " + p(d.getDate()) + "." + p(d.getMonth() + 1) + ". klo " +
           d.getHours() + "." + p(d.getMinutes());
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

  // Laskee jokaisen kategorian veikkaukset + pisteet ja pelaajakohtaiset summat.
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

  // Lisämerkintä jatkoajasta / voittolaukauksista
  function overtimeTag(finishedType) {
    if (!finishedType) return "";
    if (finishedType.indexOf("WINNING_SHOT") !== -1) return "vl";
    if (finishedType.indexOf("OVERTIME") !== -1) return "ja";
    return "";
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

  /* ---------- Laskenta ---------- */

  function computeStandings(data, seasonTotals) {
    seasonTotals = seasonTotals || {};
    var rows = data.players.map(function (name) {
      return { name: name, points: 0, hits: 0, played: 0 };
    });
    var byName = {};
    rows.forEach(function (r) { byName[r.name] = r; });

    data.matches.forEach(function (match) {
      if (!isResolved(match)) return;
      var weight = resultWeight(match, data.players);

      data.players.forEach(function (name) {
        var pick = match.predictions ? match.predictions[name] : undefined;
        if (pick !== "1" && pick !== "2") return;   // ei veikkausta
        var row = byName[name];
        row.played++;
        if (pick === match.result) {
          row.hits++;
          row.points += weight;
        }
      });
    });

    // Kausiveikkausten pisteet lisätään samaan kokonaissummaan.
    rows.forEach(function (r) { r.points += seasonTotals[r.name] || 0; });

    rows.sort(function (a, b) {
      if (b.points !== a.points) return b.points - a.points;
      return a.name.localeCompare(b.name, "fi");
    });
    return rows;
  }

  /* ---------- Piirto ---------- */

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

      list.appendChild(li);
    });
  }

  function renderSeason(season, players, computed) {
    var section = $("season-section");
    if (!season || !computed) { section.hidden = true; return; }
    section.hidden = false;

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

        list.appendChild(li);
      });

      groupEl.appendChild(list);
      container.appendChild(groupEl);
    });
  }

  function renderAll() {
    var seasonComputed = state.season ? computeSeasonScores(state.season, state.data.players) : null;
    renderStandings(computeStandings(state.data, seasonComputed ? seasonComputed.totals : {}));
    renderNext(state.data);
    renderMatches(state.data);
    renderSeason(state.season, state.data.players, seasonComputed);
  }

  /* ---------- Suodattimet ---------- */

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

  /* ---------- Käynnistys ---------- */

  function boot() {
    var seasonFetch = fetch("season-bets.json", { cache: "no-cache" })
      .then(function (r) { return r.ok ? r.json() : null; })
      .catch(function () { return null; }); // kausiveikkaukset ovat valinnaiset -- sivu toimii ilmankin

    Promise.all([
      fetch("data.json", { cache: "no-cache" }).then(function (r) {
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.json();
      }),
      seasonFetch
    ])
      .then(function (results) {
        var data = results[0];
        var season = results[1];
        if (!data || !Array.isArray(data.players) || !Array.isArray(data.matches)) {
          throw new Error("data.json ei sisällä players- ja matches-listoja");
        }
        state.data = data;
        state.season = (season && Array.isArray(season.categories)) ? season : null;
        state.initials = buildInitials(data.players);
        $("status").hidden = true;
        wireFilters();
        renderAll();

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
