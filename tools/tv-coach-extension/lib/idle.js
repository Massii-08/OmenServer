/**
 * lib/idle.js — le minuteur d'inactivité du mode scalp (PUR, sans horloge).
 *
 * Le bilan automatique part après 20 minutes SANS scalp (spec §8). Le module
 * ne lit jamais ``Date.now()`` lui-même : l'appelant lui passe le temps, ce
 * qui rend le comportement testable à la milliseconde près.
 *
 * Contrat :
 *   - ``touch(now_ms)``  : un scalp vient d'être FERMÉ (l'horloge repart) ;
 *   - ``due(now_ms)``    : vrai UNE SEULE FOIS par période d'inactivité, et
 *                          seulement après au moins un ``touch`` — sans scalp
 *                          fermé, il n'y a pas de session à débriefer ;
 *   - ``mute(day_key)``  : plus rien jusqu'à un autre jour (le serveur plafonne
 *                          les bilans à 3/jour et rend 429 : on se tait au lieu
 *                          de le harceler) ;
 *   - ``reset()``        : oublie tout (changement de titre, sortie du scalp).
 *
 * ``dayKey(now_ms)`` rend ``AAAA-MM-JJ`` en heure LOCALE : c'est la journée de
 * Massii qui compte, pas la journée UTC.
 */
(function () {
  'use strict';

  var DEFAULT_IDLE_MS = 20 * 60 * 1000;        /* 20 minutes (spec §8) */

  function num(value) {
    if (value === null || value === undefined || value === '') { return null; }
    var parsed = Number(value);
    return isFinite(parsed) ? parsed : null;
  }

  function pad2(value) {
    return (value < 10 ? '0' : '') + String(value);
  }

  /** ``AAAA-MM-JJ`` local, pour comparer deux journées sans fuseau piégeux. */
  function dayKey(nowMs) {
    var stamp = num(nowMs);
    var moment = new Date(stamp === null ? Date.now() : stamp);
    return String(moment.getFullYear()) + '-' + pad2(moment.getMonth() + 1)
      + '-' + pad2(moment.getDate());
  }

  /**
   * ``createIdle({idle_ms})`` -> le minuteur. Une valeur d'inactivité absente
   * ou absurde retombe sur 20 minutes (jamais sur zéro : un minuteur à zéro
   * déclencherait le bilan à chaque tick).
   */
  function createIdle(options) {
    var conf = options || {};
    var idleMs = num(conf.idle_ms);
    if (idleMs === null || idleMs <= 0) { idleMs = DEFAULT_IDLE_MS; }

    var lastMs = null;      /* dernier scalp fermé */
    var fired = false;      /* le bilan de CETTE période est déjà parti */
    var mutedDay = null;    /* journée où le serveur a dit 429 */

    function touch(nowMs) {
      var stamp = num(nowMs);
      if (stamp === null) { return false; }
      lastMs = stamp;
      fired = false;
      return true;
    }

    function due(nowMs) {
      var stamp = num(nowMs);
      if (stamp === null || lastMs === null || fired) { return false; }
      if (mutedDay !== null && mutedDay === dayKey(stamp)) { return false; }
      if ((stamp - lastMs) < idleMs) { return false; }
      fired = true;
      return true;
    }

    /** Le serveur a plafonné : muet jusqu'à demain, sans réessai. */
    function mute(nowMs) {
      mutedDay = dayKey(nowMs);
      fired = true;
      return mutedDay;
    }

    function isMuted(nowMs) {
      return mutedDay !== null && mutedDay === dayKey(nowMs);
    }

    function reset() {
      lastMs = null;
      fired = false;
      /* Le plafond du jour SURVIT au reset : il vient du serveur, pas de
         l'état local d'un onglet. */
    }

    function snapshot() {
      return { last_ms: lastMs, fired: fired, muted_day: mutedDay, idle_ms: idleMs };
    }

    return {
      touch: touch,
      due: due,
      mute: mute,
      isMuted: isMuted,
      reset: reset,
      snapshot: snapshot,
      idle_ms: idleMs
    };
  }

  var api = {
    createIdle: createIdle,
    dayKey: dayKey,
    DEFAULT_IDLE_MS: DEFAULT_IDLE_MS
  };

  globalThis.OmenLib = globalThis.OmenLib || {};
  globalThis.OmenLib.idle = api;
  if (typeof module !== 'undefined' && module.exports) { module.exports = api; }
})();
