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

module.exports = { diamondFree, cautionNight };
