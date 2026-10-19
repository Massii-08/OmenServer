'use strict';
// LA FUITE DE MOVEMENTS (trouvée le 19/10 en traquant les « ponts énormes en surface »).
//
// mineflayer-collectblock (CollectBlock.collect) et mineflayer-pvp (PVP.attack) appellent
// `bot.pathfinder.setMovements(<leur Movements d'usine>)` à CHAQUE usage — placeCost 1, liquidCost 1,
// eau/lave `replaceable` (poser DANS l'eau), échafaudage terre + pierre seulement, aucun évitement des
// stalactites — et ne rendent JAMAIS la nôtre. Rien dans l'agent ne la remettait non plus, hors le
// `finally` de movement.withTempMovements. Après la 1re récolte ou le 1er combat, TOUS les trajets
// suivants (explore, base, chantier…) partaient donc à placeCost 1 : la config nominale soignée
// d'onSpawn (placeCost 45/60, aquaphobie, échafaudage élargi, stalactites) ne tournait presque jamais.
// Probablement LA cause des passerelles (un pont y coûte 2, autant que marcher).
//
// Deux parades, ici :
//   1. `copySafetySettings` : au boot, nos réglages de sécurité passent dans les Movements des
//      plugins — pendant une récolte ou un combat, nos règles s'appliquent quand même ;
//   2. `createMovesKeeper` : à la FIN de chaque usage plugin (collect enveloppé, event pvp
//      `stoppedAttacking`), on rend `bot._mcaMoves` — qui désigne déjà la Movements active légitime,
//      fenêtre withTempMovements comprise. Jamais pendant qu'un autre usage plugin court encore.
//
// Aucun accès réseau ni horloge en dur (bot, emit et now injectés) : testable avec la vraie classe
// Movements de mineflayer-pathfinder, sans serveur (pluginMoves.test.js).

// Ce qui fait NOTRE sécurité de déplacement (index.js, config Movements d'onSpawn). Volontairement
// SANS `dontCreateFlow` / `dontMineUnderFallingBlock` : collectBlock les remet à false sur SA Movements
// à chaque collect (c'est son métier : miner sous du gravier, à côté de l'eau) — on ne lutte pas.
// SANS `allowSprinting` : le sprint-curb le bascule à chaud sur `_mcaMoves` ; une copie au boot
// figerait une valeur qui bouge.
const SAFETY_PROPS = Object.freeze([
  'placeCost', 'liquidCost', 'replaceables', 'scafoldingBlocks', 'blocksToAvoid',
  'maxDropDown', 'allowParkour', 'allow1by1towers', 'canDig',
]);

// Rapport `moves_restored` : au plus un par minute (une flotte qui récolte en boucle restaure toutes
// les quelques secondes — un event par restauration serait un emballement de logs, cf. #52b).
const RESTORE_EMIT_MIN_MS = 60 * 1000;

const WRAPPED = Symbol.for('mca.pluginMoves.wrapped');

/** Copie PROFONDE d'un réglage : un Set ou un tableau de la nominale n'est jamais partagé. */
function _cloneSetting(v) {
  if (v instanceof Set) return new Set(v);
  if (Array.isArray(v)) return v.slice();
  return v;
}

/**
 * Recopie dans `to` (Movements d'un plugin) nos réglages de sécurité lus sur `from` (la nominale).
 * Sets et tableaux sont DUPLIQUÉS : ce qu'un plugin modifie chez lui ne contamine jamais la nominale
 * (et réciproquement). Un réglage absent de `from`, ou d'un type inattendu (objet), n'est pas copié.
 * @returns {string[]} les clés effectivement recopiées
 */
function copySafetySettings(from, to, props = SAFETY_PROPS) {
  const copied = [];
  if (!from || !to || typeof from !== 'object' || typeof to !== 'object') return copied;
  for (const k of props) {
    const v = from[k];
    if (v === undefined) continue;
    const plain = v === null || typeof v !== 'object';
    if (!plain && !(v instanceof Set) && !Array.isArray(v)) continue;   // objet inconnu : ne pas partager
    try { to[k] = _cloneSetting(v); copied.push(k); } catch (e) { /* propriété figée : on passe */ }
  }
  return copied;
}

/**
 * Gardien de la Movements nominale : la rend à la fin de chaque usage plugin.
 * @param {object} o
 * @param {object} o.bot      — lit `bot._mcaMoves`, `bot.pathfinder.{movements,setMovements}`, `bot.pvp.target`
 * @param {Function} [o.emit] — reçoit `{ type: 'moves_restored', by: 'collect'|'pvp', count }`
 * @param {Function} [o.now]  — horloge (ms), injectable
 * @param {number} [o.emitEveryMs] — intervalle minimal entre deux rapports
 */
function createMovesKeeper({ bot, emit = () => {}, now = Date.now, emitEveryMs = RESTORE_EMIT_MIN_MS } = {}) {
  let collectInUse = 0;          // collects en vol (deux peuvent se chevaucher : le 2e annule le 1er)
  let pending = 0;               // restaurations pas encore rapportées
  let lastEmitAt = -Infinity;
  let restores = 0;

  // Le combat est « en cours » tant que le plugin a une CIBLE : c'est sa source de vérité (stop() la
  // vide avant d'émettre stoppedAttacking ; attack() la pose juste avant d'émettre startedAttacking).
  const pvpBusy = () => { try { return !!(bot && bot.pvp && bot.pvp.target); } catch (e) { return false; } };

  /** Rend la nominale si plus aucun usage plugin ne court. @returns {boolean} true si restaurée */
  function restore(by) {
    try {
      if (collectInUse > 0 || pvpBusy()) return false;
      const pf = bot && bot.pathfinder;
      const nominal = bot && bot._mcaMoves;
      if (!pf || !nominal || typeof pf.setMovements !== 'function') return false;
      // déjà la bonne → pas de setMovements (il remet le chemin à zéro : resetPath + clearControlStates)
      if (pf.movements === nominal) return false;
      pf.setMovements(nominal);
      restores += 1;
      pending += 1;
      const t = now();
      if (t - lastEmitAt >= emitEveryMs) {
        try { emit({ type: 'moves_restored', by, count: pending }); } catch (e) { /* télémétrie */ }
        pending = 0;
        lastEmitAt = t;
      }
      return true;
    } catch (e) {
      return false;                                  // jamais d'exception dans le chemin d'un plugin
    }
  }

  /**
   * Enveloppe `collectBlock.collect` : compte l'usage, rend la nominale à la fin (succès, rejet,
   * exception synchrone). Le plugin pose SA Movements de façon synchrone dès l'appel : le compteur
   * est donc incrémenté AVANT. `this` = le plugin, toujours (son mode callback rappelle `this.collect`
   * hors de tout objet). Idempotent.
   */
  function wrapCollect(collectBlock) {
    if (!collectBlock || typeof collectBlock.collect !== 'function') return false;
    if (collectBlock.collect[WRAPPED]) return true;
    const original = collectBlock.collect;
    const done = () => { collectInUse = Math.max(0, collectInUse - 1); restore('collect'); };
    const wrapped = function collectRestoringMoves(...args) {
      collectInUse += 1;
      let p;
      try {
        p = original.apply(collectBlock, args);
      } catch (e) {
        done();
        throw e;
      }
      return Promise.resolve(p).finally(done);
    };
    wrapped[WRAPPED] = true;
    collectBlock.collect = wrapped;
    return true;
  }

  /** Fin de combat mineflayer-pvp (stop, forceStop, cible morte ou hors de vue) → restauration. */
  function watchPvp(emitter) {
    if (!emitter || typeof emitter.on !== 'function') return false;
    emitter.on('stoppedAttacking', () => { restore('pvp'); });
    return true;
  }

  return {
    wrapCollect, watchPvp, restore,
    inUse: () => ({ collect: collectInUse, pvp: pvpBusy() }),
    get restores() { return restores; },
  };
}

module.exports = { copySafetySettings, createMovesKeeper, SAFETY_PROPS, RESTORE_EMIT_MIN_MS };
