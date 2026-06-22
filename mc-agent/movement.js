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

module.exports = { shouldSprint, SPRINT_MIN_FOOD, SPRINT_RESUME_FOOD };
