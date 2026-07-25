'use strict';
// cover.js — décisions PURES pour se mettre à COUVERT d'un tireur (squelette/stray/bogged).
//
// Pourquoi (preuve live world_ax4, 25/07) : les squelettes sont le tueur n°1 des bots nus.
// NethBot2 est mort 8× en 4 minutes (« was shot by Skeleton »), NethBot3 et MapBot2 aussi.
// Les deux réponses codées jusqu'ici perdent quand le bot n'a ni bouclier ni épée :
//   - CHARGER (onRanged → pvp.attack) = traverser 10-16 blocs à découvert sous les flèches ;
//   - FUIR en ligne droite = rester dans la ligne de vue, donc continuer à encaisser.
// Un vrai joueur CASSE LA LIGNE DE VUE : un squelette qui ne te voit plus cesse de tirer.
// D'où : poser 1-2 blocs entre soi et le tireur (bien moins cher qu'un panicWall 4 côtés).

/** Signe « dominant » d'un vecteur 2D : l'axe le plus fort gagne (mur perpendiculaire au tir). */
function _dominantAxis(dx, dz) {
  if (Math.abs(dx) >= Math.abs(dz)) return { ax: dx === 0 ? 0 : Math.sign(dx), az: 0 };
  return { ax: 0, az: Math.sign(dz) };
}

/**
 * PUR — positions des blocs à poser pour masquer le bot du tireur.
 * Un mur de 2 de haut (pieds + tête) sur la case adjacente, du côté du tireur : c'est ce qui
 * coupe la ligne de vue d'un squelette (qui vise la tête).
 * @param {{x:number,y:number,z:number}} botPos    position du bot (entiers ou flottants)
 * @param {{x:number,y:number,z:number}} shooterPos position du tireur
 * @returns {Array<{x:number,y:number,z:number}>|null} 2 positions, ou null si superposés
 */
function coverPlan(botPos, shooterPos) {
  if (!botPos || !shooterPos) return null;
  const bx = Math.floor(botPos.x), by = Math.floor(botPos.y), bz = Math.floor(botPos.z);
  const dx = shooterPos.x - botPos.x;
  const dz = shooterPos.z - botPos.z;
  if (dx === 0 && dz === 0) return null;          // même colonne : aucune direction à couvrir
  const { ax, az } = _dominantAxis(dx, dz);
  return [
    { x: bx + ax, y: by, z: bz + az },            // niveau des pieds
    { x: bx + ax, y: by + 1, z: bz + az },        // niveau de la tête = celui qui coupe la visée
  ];
}

// Seuils d'engagement. Au contact (< MELEE_OK) on tape : le squelette recule et meurt en 2-3 coups,
// c'est la bonne réponse même mal équipé. Au-delà, tout dépend de l'équipement.
const MELEE_OK = 5;              // blocs — distance sous laquelle charger reste correct
const SAFE_HEALTH = 14;          // PV au-dessus desquels on tolère de traverser à découvert
const SAFE_ARMOR = 8;            // points d'armure (≈ set fer complet = 15) rendant la charge viable

/**
 * PUR — faut-il se mettre à couvert plutôt que charger/fuir à découvert ?
 * @param {{distance:number, health:number, armorPoints:number, weaponDamage:number,
 *          hasShield:boolean, hasBlock:boolean}} s
 * @returns {boolean}
 */
function shouldTakeCover(s) {
  const o = s || {};
  if (!o.hasBlock) return false;                       // rien à poser → inutile de décider oui
  const dist = typeof o.distance === 'number' ? o.distance : 0;
  if (dist <= MELEE_OK) return false;                  // au contact : on tape, on ne se terre pas
  if (o.hasShield) return false;                       // bouclier = la charge est couverte
  const hp = typeof o.health === 'number' ? o.health : 20;
  const armor = typeof o.armorPoints === 'number' ? o.armorPoints : 0;
  const dmg = typeof o.weaponDamage === 'number' ? o.weaponDamage : 0;
  if (armor >= SAFE_ARMOR && hp > SAFE_HEALTH && dmg > 0) return false;  // équipé et en forme → charge
  return true;                                         // nu / blessé / désarmé → couvert
}

module.exports = { coverPlan, shouldTakeCover, MELEE_OK, SAFE_HEALTH, SAFE_ARMOR };
