'use strict';
// Sprint « comme un vrai joueur » (décision Massii 2026-06-22).
//
// Un vrai joueur sprinte QUASI TOUT LE TEMPS quand il se déplace. Avant, le bot délèguait
// 100% du sprint à mineflayer-pathfinder (`allowSprinting`), qui ne sprinte que sur de longs
// trajets droits → en minage (déplacements courts/hachés) le bot ne sprintait quasi jamais
// = lent + un tell. Le « 0% de sprint » relevé dans les captures Massitom2008 est un ARTÉFACT
// de mesure du mod (il loggue la touche sprint MAINTENUE et rate le double-tap-W, la façon la
// plus courante de sprinter) → ce n'est JAMAIS une preuve que le joueur ne sprinte pas.
//
// Ce module ne décide QUE (pur, testable sans bot) ; index.js lit l'état réel du bot et applique
// `setControlState('sprint', ...)`. Volontairement INDÉPENDANT du flag `--humanize`.

// Vanilla : le serveur refuse le sprint quand la faim est ≤ 6 (3 boucliers de nourriture).
const SPRINT_MIN_FOOD = 6;
// Hystérésis : pour (RE)démarrer un sprint on exige une petite marge → évite le clignotement
// sprint on/off pile à la limite de faim (qui bouge d'un cran à la fois).
const SPRINT_RESUME_FOOD = 7;

/**
 * Faut-il sprinter cette frame ? PUR.
 * @param {object} state
 *   moving    {boolean} le bot avance (pathfinder en mouvement OU touche avant/arrière)
 *   onGround  {boolean} au sol (pas en chute/saut — le sprint en l'air ne sert à rien)
 *   inWater   {boolean} dans l'eau/la lave → pas de sprint (et on évite l'eau de toute façon)
 *   digging   {boolean} en train de miner un bloc → on ne sprinte pas, on mine
 *   sneaking  {boolean} accroupi (pose de bloc, bord) → incompatible sprint
 *   food      {number}  0..20 (défaut 20 si inconnu)
 *   sprinting {boolean} sprinte déjà (pour l'hystérésis de faim)
 * @returns {boolean}
 */
function shouldSprint(state) {
  const s = state || {};
  if (!s.moving || !s.onGround) return false;
  if (s.inWater || s.digging || s.sneaking) return false;
  const food = (typeof s.food === 'number') ? s.food : 20;
  if (s.sprinting) return food > SPRINT_MIN_FOOD;     // continue tant que faim > 6
  return food >= SPRINT_RESUME_FOOD;                  // (re)démarre seulement à faim ≥ 7
}

// Budget de DÉTOUR du pathfinder, en coût de déplacement (astar.js : maxCost = h_initial +
// searchRadius). Ce n'est PAS un rayon absolu : un but à 1500 blocs reste atteignable (les
// mappeurs voyagent loin), on interdit juste à l'A* de s'éloigner indéfiniment de la ligne
// directe. La lib livre -1 (ILLIMITÉ) — d'où l'OOM live du 25/07 (2 Go en 38 s sur un
// GoalInvert de fuite insatisfiable, bot acculé : aucun nœud ne termine la recherche).
// 256 = large pour contourner un lac/une montagne, fini pour tuer l'errance.
const PATHFINDER_SEARCH_RADIUS = 256;

/**
 * Borne l'espace de recherche du pathfinder (anti-OOM). Best-effort : jamais de crash si le
 * plugin n'est pas encore injecté. Retourne true si la borne a été posée.
 * @param {{searchRadius?: number}} pathfinder — bot.pathfinder
 * @returns {boolean}
 */
function applyPathfinderBounds(pathfinder) {
  if (!pathfinder) return false;
  try {
    pathfinder.searchRadius = PATHFINDER_SEARCH_RADIUS;
    return true;
  } catch (e) {
    return false;
  }
}

// mineflayer-pathfinder n'expose PAS de getter `movements` (v2.4.5 : seul `setMovements` existe)
// → lire `bot.pathfinder.movements` rend `undefined`. L'ancien pattern inline (2 sites d'index.js,
// migration + minage exposé) héritait donc d'undefined (temp aux défauts de la lib : placeCost 1,
// pas d'aquaphobie, blocksToAvoid réduits) et sa restauration `if (prevMoves)` ne tirait jamais —
// après le 1er appel, le bot restait à VIE sur la Movements orpheline. La seule référence tenue
// est `bot._mcaMoves` (posée à la connexion) : c'est elle qu'on hérite et qu'on restaure.
/**
 * Pose une Movements TEMPORAIRE (héritée de l'état courant + tweaks) pour la durée de `fn`, puis
 * restaure la Movements nominale. Best-effort : `fn` s'exécute même si la pose a échoué (la
 * mission de déplacement prime sur le réglage) ; les erreurs de `fn` se PROPAGENT (les call sites
 * ont leurs propres catch), la restauration a lieu quand même (finally).
 * @param {object} bot — le bot mineflayer (lit `_mcaMoves`, `pathfinder.setMovements`)
 * @param {Function} MovementsCtor — le constructeur `Movements` de mineflayer-pathfinder
 * @param {object} tweaks — réglages qui écrasent l'hérité sur la temp (ex: {canDig:false})
 * @param {Function} fn — async, exécutée pendant que la temp est active
 * @returns {Promise<*>} le retour de `fn`
 */
async function withTempMovements(bot, MovementsCtor, tweaks, fn) {
  const prev = bot && bot._mcaMoves;
  let applied = false;
  try {
    const temp = new MovementsCtor(bot);
    if (prev) { try { Object.assign(temp, prev); } catch (e) {} }
    Object.assign(temp, tweaks || {});
    if (bot && bot.pathfinder && typeof bot.pathfinder.setMovements === 'function') {
      bot.pathfinder.setMovements(temp);
      // CONTRAINTE : `_mcaMoves` doit toujours désigner la Movements RÉELLEMENT active, fenêtre
      // temporaire COMPRISE — le sprint-curb (index.js, tick 150 ms) mute `_mcaMoves.allowSprinting`
      // en continu ; sans cette ligne il muterait l'objet INACTIF pendant toute la fenêtre (60-90 s
      // par jambe de migration / cave-first) et la coupe de sprint resterait sans effet.
      bot._mcaMoves = temp;
      applied = true;
    }
  } catch (e) { /* best-effort : sans temp, fn court sur les Movements actuelles */ }
  try {
    return await fn();
  } finally {
    if (applied && prev) {
      try { bot.pathfinder.setMovements(prev); } catch (e) {}
      bot._mcaMoves = prev;   // la nominale redevient l'active : le sprint-curb la re-suit
    }
  }
}

module.exports = {
  shouldSprint, SPRINT_MIN_FOOD, SPRINT_RESUME_FOOD,
  applyPathfinderBounds, PATHFINDER_SEARCH_RADIUS,
  withTempMovements,
};
