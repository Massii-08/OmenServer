/**
 * lib/watchlist.js — le PLAN d'import « watchlist TradingView -> favoris
 * OmenServer » (PUR, zéro I/O, zéro chrome.*).
 *
 * Un seul sens (spec §8) : TV -> Omen, sur clic explicite. ``bridge.js`` lit
 * les symboles affichés dans le panneau de droite, ``content.js`` demande ici
 * QUOI poster, puis poste un par un (``POST /api/paper/watchlist {symbol}``,
 * idempotent côté serveur mais on ne le prend pas comme excuse pour marteler
 * la route).
 *
 * Trois familles en sortie :
 *   - ``post``    : les symboles Yahoo à créer, dans l'ordre d'apparition ;
 *   - ``skipped`` : déjà dans les favoris (comparaison INSENSIBLE À LA CASSE,
 *                   comme ``paper_watchlist_add``) ;
 *   - ``unknown`` : les symboles TradingView que ``tvToYahoo`` ne sait pas
 *                   traduire — jamais inventés, listés tels quels pour que le
 *                   récapitulatif puisse les nommer.
 *
 * La traduction est prise dans ``OmenLib.symbols`` À L'APPEL (comme le fait
 * ``content.js``), ou injectée par ``options.map`` pour les tests. Sans
 * traducteur, TOUT est inconnu : on n'invente pas un symbole Yahoo.
 */
(function () {
  'use strict';

  /* Plafond d'un import, aligné sur ``paper_router.MAX_WATCHLIST`` (30) : au
     delà ce n'est plus une liste de suivi, et le serveur refuserait en 400. */
  var DEFAULT_CAP = 30;

  function mapperFrom(options) {
    if (options && typeof options.map === 'function') { return options.map; }
    var lib = globalThis.OmenLib || {};
    var symbols = lib.symbols || null;
    return (symbols && typeof symbols.tvToYahoo === 'function')
      ? symbols.tvToYahoo : null;
  }

  /** Les favoris déjà là, en majuscules : accepte les lignes du serveur
   *  (``{symbol, name, ...}``) comme une simple liste de chaînes. */
  function knownSet(existing) {
    var out = {};
    var list = Array.isArray(existing) ? existing : [];
    for (var i = 0; i < list.length; i += 1) {
      var row = list[i];
      var symbol = (row && typeof row === 'object') ? row.symbol : row;
      var cleaned = String(symbol === null || symbol === undefined ? '' : symbol)
        .trim().toUpperCase();
      if (cleaned) { out[cleaned] = true; }
    }
    return out;
  }

  /**
   * ``planImport(tvSymbols, existing, options)`` -> ``{post, skipped, unknown,
   * capped, cap, seen}``.
   *
   * ``seen`` compte les symboles TradingView RETENUS après dédoublonnage —
   * c'est le total honnête du récapitulatif (« N importés, M ignorés,
   * K inconnus » ne peut pas dépasser ce nombre).
   */
  function planImport(tvSymbols, existing, options) {
    var conf = options || {};
    var cap = (typeof conf.cap === 'number' && conf.cap > 0)
      ? Math.floor(conf.cap) : DEFAULT_CAP;
    var map = mapperFrom(conf);
    var already = knownSet(existing);
    var list = Array.isArray(tvSymbols) ? tvSymbols : [];

    var post = [];
    var skipped = [];
    var unknown = [];
    var seenTv = {};
    var seenYahoo = {};
    var seen = 0;
    var capped = false;

    for (var i = 0; i < list.length; i += 1) {
      var raw = String(list[i] === null || list[i] === undefined ? '' : list[i]).trim();
      if (!raw) { continue; }
      var key = raw.toUpperCase();
      if (Object.prototype.hasOwnProperty.call(seenTv, key)) { continue; }
      seenTv[key] = true;
      seen += 1;

      var yahoo = null;
      if (map) {
        try { yahoo = map(raw); } catch (e) { yahoo = null; }
      }
      if (!yahoo) { unknown.push(raw); continue; }

      var canonical = String(yahoo).trim().toUpperCase();
      /* Deux lignes TradingView peuvent viser le MÊME titre Yahoo
         (BX:NESR et SIX:NESN -> NESN.SW) : une seule création. */
      if (Object.prototype.hasOwnProperty.call(seenYahoo, canonical)) { continue; }
      seenYahoo[canonical] = true;

      if (Object.prototype.hasOwnProperty.call(already, canonical)) {
        skipped.push(canonical);
        continue;
      }
      if (post.length >= cap) { capped = true; continue; }
      post.push(canonical);
    }

    return {
      post: post,
      skipped: skipped,
      unknown: unknown,
      capped: capped,
      cap: cap,
      seen: seen
    };
  }

  var api = {
    planImport: planImport,
    knownSet: knownSet,
    DEFAULT_CAP: DEFAULT_CAP
  };

  globalThis.OmenLib = globalThis.OmenLib || {};
  globalThis.OmenLib.watchlist = api;
  if (typeof module !== 'undefined' && module.exports) { module.exports = api; }
})();
