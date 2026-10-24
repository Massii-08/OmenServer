'use strict';
// MINEUR EN ARMURE DIAMANT COMPLÈTE = LIBRE EN SURFACE (Massii 24/10).
//
// Toute la prudence nocturne (abri `shelterUntilDawn`, `night_gate` du bois / de la nourriture / de la
// migration / des trajets, `dawn_wait` à la sortie de l'abri) a été écrite pour des bots NUS ou en fer
// partiel : en hard, un zombie tue un bot à 3 pièces de fer presque aussi vite qu'un bot nu. Un set
// diamant complet (20 points d'armure + 8 de robustesse) encaisse une nuit ordinaire : l'enterrer 10 min
// dans un trou à chaque crépuscule, c'est 10 min de minage perdues pour rien. La règle : pour LUI, la
// nuit n'existe pas pour les gardes de prudence. Les autres gardent toutes leurs règles.
// « Porté » = slots d'armure, pièces usées EXCLUES (index.js `_wornArmor`) : une pièce diamant à bout de
// course ne compte pas — il redevient prudent jusqu'à la reforge.
// PUR.

const { diaWornCount } = require('./diaArmor');

/** PUR — armure diamant (ou mieux) complète PORTÉE ? */
function diamondFree(worn) {
  return diaWornCount(worn) >= 4;
}

/**
 * PUR — la nuit telle que la voient les gardes de prudence : `false` pour un mineur en diamant complet,
 * sinon la valeur reçue (true / false / null = heure inconnue) inchangée.
 */
function cautionNight(night, worn) {
  return diamondFree(worn) ? false : night;
}

// ─── NUIT DU MINEUR DIAMANT (24/10 soir) ─────────────────────────────────────────────────────────
// Mesure : libres la nuit, les bots en diamant complet mouraient de nuit et à l'aube EN SURFACE
// (squelettes, creepers). Le diamant encaisse, il n'est pas immortel. Règle : la nuit, il ne reste en
// surface que pour un VRAI besoin (nourriture critique, bois indispensable) ; sinon il redescend au
// chantier (/home work, deepWork) ; sans chantier connu, l'abri de surface historique. Sous terre il
// travaille (jamais d'abri muré sous terre, règle existante).
const NIGHT_NEED_GOALS = new Set(['logs', 'planks', 'plank_buffer', 'crafting_table', 'sticks', 'wooden_pickaxe']);
const NIGHT_NEED_SKILLS = new Set(['huntCook', 'gatherLog', 'craftPlanks', 'fish']);

/**
 * PUR — que fait un mineur en diamant complet la nuit ?
 * o = { free, night (true/false/null), underground, goalName, goalSkill, foodCritical, deepWorkWarp }
 * → 'none' (pas concerné : règles normales) | 'work' (il travaille) | 'need' (vrai besoin de surface)
 *   | 'go_deep' (redescendre au chantier) | 'shelter' (abri de surface historique)
 */
function diamondNightPlan(o = {}) {
  if (!o.free) return 'none';
  if (o.night !== true) return 'work';
  if (o.underground) return 'work';
  if (o.foodCritical || NIGHT_NEED_GOALS.has(o.goalName) || NIGHT_NEED_SKILLS.has(o.goalSkill)) return 'need';
  if (o.deepWorkWarp) return 'go_deep';
  return 'shelter';
}

module.exports = { diamondFree, cautionNight, diamondNightPlan, NIGHT_NEED_GOALS, NIGHT_NEED_SKILLS };
