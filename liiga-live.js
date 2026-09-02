/* liiga-live.js — Suora selainpuolen yhteys Liiga.fi:n julkiseen API:in.
   Kaikki tässä on parhaan yrityksen lisäys staattisen sivun päälle: haut
   epäonnistuvat hiljaa (palauttavat null), jotta sivu toimii normaalisti
   myös silloin kun liiga.fi ei vastaa. Ei kirjoita mihinkään tiedostoon --
   pelkkää lukua selaimessa. */

(function () {
  "use strict";

  var API_ROOT = "https://liiga.fi/api/v2";
  var TOURNAMENT = "runkosarja";
  var KARPAT = "Kärpät";

  var gameCache = {}; // "YYYY-MM-DD" -> Promise<games|null>

  // Sama sääntö kuin liiga_common.py:n current_season(): kausi on nimetty
  // sen päättymisvuoden mukaan (2026-2027 -kausi = 2027).
  function currentSeason() {
    var today = new Date();
    var y = today.getFullYear();
    var m = today.getMonth() + 1;
    return m >= 8 ? y + 1 : y;
  }

  function getJson(url) {
    return fetch(url, { cache: "no-cache" })
      .then(function (r) { return r.ok ? r.json() : null; })
      .catch(function () { return null; });
  }

  function fetchStandings(season) {
    return getJson(API_ROOT + "/standings?tournament=" + TOURNAMENT + "&season=" + season)
      .then(function (d) { return (d && Array.isArray(d.season)) ? d.season : null; });
  }

  function fetchSkaterStats(season) {
    return getJson(API_ROOT + "/players/stats/summed/" + season + "/" + season + "/" + TOURNAMENT + "/true?dataType=basicStats")
      .then(function (d) { return Array.isArray(d) ? d : null; });
  }

  function fetchGoalieStats(season) {
    return getJson(API_ROOT + "/players/stats/summed/" + season + "/" + season + "/" + TOURNAMENT + "/true?dataType=basicStatsGk")
      .then(function (d) { return Array.isArray(d) ? d : null; });
  }

  // dateStr: "YYYY-MM-DD". Välimuistitetaan -- saman päivän kysely toistuu
  // helposti (ottelun laajennus, live-päivitys, veikkauslaskuri).
  function fetchGamesForDate(dateStr) {
    if (!gameCache[dateStr]) {
      gameCache[dateStr] = getJson(API_ROOT + "/games?tournament=" + TOURNAMENT + "&date=" + dateStr)
        .then(function (d) { return (d && Array.isArray(d.games)) ? d.games : null; });
    }
    return gameCache[dateStr];
  }

  function fetchAll(season) {
    return Promise.all([fetchStandings(season), fetchSkaterStats(season), fetchGoalieStats(season)])
      .then(function (r) {
        if (!r[0] && !r[1] && !r[2]) return null; // liiga.fi kokonaan tavoittamattomissa
        return { season: season, standings: r[0], skaters: r[1], goalies: r[2] };
      });
  }

  /* ---------- Tilastojohtajat (sama logiikka kuin update_season_bets.py) ---------- */

  function playerName(rec) { return rec.firstName + " " + rec.lastName; }

  function topBy(records, key, team) {
    var pool = records.filter(function (r) { return !team || r.teamName === team; });
    return pool.reduce(function (best, r) {
      return (best === null || r[key] > best[key]) ? r : best;
    }, null);
  }

  function bottomBy(records, key, team) {
    var pool = records.filter(function (r) { return !team || r.teamName === team; });
    return pool.reduce(function (best, r) {
      return (best === null || r[key] < best[key]) ? r : best;
    }, null);
  }

  function findGame(games, homeTeam, awayTeam) {
    if (!games) return null;
    var found = games.filter(function (g) {
      return g.homeTeam && g.awayTeam &&
        g.homeTeam.teamName === homeTeam && g.awayTeam.teamName === awayTeam;
    });
    return found.length ? found[0] : null;
  }

  /* ---------- Veikkauskertoimet ---------- */

  // Muuntaa Veikkauksen gamblingEvent-kertoimet Kärppien voittotodennäköisyydeksi.
  // Palauttaa null jos kertoimia ei ole tarjolla tai ottelu on jo alkanut --
  // silloin kenttä kuvaa jälkikäteen asetettua (ratkennutta) hintaa, ei ennakkoa.
  function impliedWinProbability(game, karpatIsHome) {
    if (!game || game.started) return null;
    var ge = game.gamblingEvent;
    if (!ge || !ge.homeTeamOdds || !ge.awayTeamOdds || !ge.tieOdds) return null;

    var pHome = 100 / ge.homeTeamOdds;
    var pAway = 100 / ge.awayTeamOdds;
    var pTie = 100 / ge.tieOdds;
    var sum = pHome + pAway + pTie;
    if (!sum) return null;
    pHome /= sum; pAway /= sum; pTie /= sum;

    // Jääkiekko-ottelu ratkeaa aina (jatkoaika/voittolaukaukset) -- jaetaan
    // tasapelin todennäköisyysosuus joukkueiden keskinäisen vahvuussuhteen mukaan.
    var pHomeFinal = pHome + pTie * (pHome / (pHome + pAway));
    return karpatIsHome ? pHomeFinal : (1 - pHomeFinal);
  }

  window.LiigaLive = {
    KARPAT: KARPAT,
    currentSeason: currentSeason,
    fetchAll: fetchAll,
    fetchGamesForDate: fetchGamesForDate,
    findGame: findGame,
    playerName: playerName,
    topBy: topBy,
    bottomBy: bottomBy,
    impliedWinProbability: impliedWinProbability
  };
})();
