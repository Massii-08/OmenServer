/**
 * lib/note.js — la note rapide au carnet d'idées (PUR).
 *
 * Charge utile de ``POST /api/paper/ideas/note`` : ``{text, symbol?, lang?}``,
 * réponse ``{ok: true, entry: {...}}``.
 *
 * Deux règles, et elles tiennent ici pour être testables :
 *  1. 500 CARACTÈRES au maximum — une note est une ligne jetée entre deux
 *     bougies, pas un mémo ; au-delà on COUPE (jamais un refus silencieux).
 *  2. Une note vide n'est pas une note : ``build`` rend ``null`` et le panneau
 *     n'appelle rien du tout.
 *
 * ``symbol`` n'est envoyé QUE s'il est connu : la route l'attend en chaîne, et
 * poster ``null`` sur un champ typé ``str`` ferait un 422 pour rien.
 */
(function () {
  'use strict';

  var MAX_LEN = 500;
  var LANGS = ['fr', 'it', 'en'];

  /**
   * ``normalize(text)`` : espaces des bords retirés, fins de ligne unifiées,
   * coupe à 500 caractères. Rend ``''`` pour tout ce qui n'est pas du texte.
   */
  function normalize(text) {
    if (text === null || text === undefined) { return ''; }
    var cleaned = String(text).replace(/\r\n?/g, '\n').trim();
    return cleaned.length > MAX_LEN ? cleaned.slice(0, MAX_LEN) : cleaned;
  }

  /** Reste-t-il de la place ? (le compteur affiché sous le champ) */
  function remaining(text) {
    var length = normalize(text).length;
    return MAX_LEN - length;
  }

  function normalizeLang(lang) {
    var cleaned = String(lang || '').trim().toLowerCase().slice(0, 2);
    return LANGS.indexOf(cleaned) === -1 ? 'fr' : cleaned;
  }

  /**
   * ``build({text, symbol, lang})`` -> la charge utile, ou ``null`` si la note
   * est vide une fois nettoyée.
   */
  function build(spec) {
    var conf = spec || {};
    var text = normalize(conf.text);
    if (!text) { return null; }
    var payload = { text: text, lang: normalizeLang(conf.lang) };
    var symbol = String(conf.symbol === null || conf.symbol === undefined
      ? '' : conf.symbol).trim();
    if (symbol) { payload.symbol = symbol; }
    return payload;
  }

  /**
   * ``isSendKey(event)`` — Ctrl+Entrée (ou Cmd+Entrée sur Mac) envoie la note.
   * Entrée seule saute une ligne : une note à deux lignes doit rester possible.
   */
  function isSendKey(event) {
    if (!event) { return false; }
    var key = String(event.key || '');
    if (key !== 'Enter' && key !== 'NumpadEnter') { return false; }
    return event.ctrlKey === true || event.metaKey === true;
  }

  var api = {
    normalize: normalize,
    remaining: remaining,
    normalizeLang: normalizeLang,
    build: build,
    isSendKey: isSendKey,
    MAX_LEN: MAX_LEN
  };

  globalThis.OmenLib = globalThis.OmenLib || {};
  globalThis.OmenLib.note = api;
  if (typeof module !== 'undefined' && module.exports) { module.exports = api; }
})();
