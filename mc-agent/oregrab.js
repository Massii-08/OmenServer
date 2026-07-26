'use strict';
// « Ramasser le minerai en passant » — Massii 2026-07-26 : « il y a plein de fois où les bots
// passent à côté du fer mais ne le prennent pas ».
//
// La collecte opportuniste n'existait QUE dans branchMine (les minerais que ses propres coups
// exposent). Partout ailleurs — trajet vers la base, descente, sortie de grotte, retour au
// chantier — un bloc de fer à un bloc du nez était ignoré : le planner ne mine que ce qu'il a
// décidé de miner. Un joueur, lui, casse ce qui est à portée de main et continue sa route.
//
// Contrat : on ne mine QUE ce qui est déjà à portée de bras (aucun déplacement, aucun
// pathfinding) — donc ça n'interrompt jamais la tâche en cours, ça la ponctue.
// Décisions pures ici ; le scan et le dig vivent dans index.js.

// Ce qui vaut un coup de pioche en passant. Pas de pierre/terre : on ne ramasse pas du remblai.
const WANTED_ORES = new Set([
  'iron_ore', 'deepslate_iron_ore',
  'coal_ore', 'deepslate_coal_ore',
  'diamond_ore', 'deepslate_diamond_ore',
  'gold_ore', 'deepslate_gold_ore',
  'redstone_ore', 'deepslate_redstone_ore',
  'lapis_ore', 'deepslate_lapis_ore',
  'emerald_ore', 'deepslate_emerald_ore',
  // CUIVRE RETIRE (mesure 27/07) : 106 `ore_grabbed` de cuivre pour 27 de fer — 78 % des
  // detours servaient un minerai INUTILE aux chaines fer et diamant, que `junkItems` fait
  // jeter juste apres (il n'est dans aucun quota). Miner pour jeter, et saturer l'inventaire
  // au passage (d'ou les makeRoomInPlace a repetition).
  'raw_iron_block', 'ancient_debris',
]);

function isWantedOre(name) {
  return WANTED_ORES.has(String(name || ''));
}

/**
 * L'outil tenu permet-il de RÉCOLTER ce bloc ? PUR.
 * Décisif ici : miner du fer à la pioche de bois casse le bloc et ne donne RIEN. mineflayer expose
 * `block.harvestTools` = { <itemId>: true } quand un outil est requis ; absent ⇒ tout va.
 */
function canHarvest(block, heldItemId) {
  if (!block) return false;
  const need = block.harvestTools;
  if (!need) return true;                         // aucun outil requis
  if (heldItemId == null) return false;
  return !!need[heldItemId] || !!need[String(heldItemId)];
}

/**
 * Faut-il tenter une prise opportuniste maintenant ? PUR.
 * Non pendant un combat, une panique, une noyade, un dig déjà en cours, ou si le bot est occupé
 * par une manœuvre critique — la prise en passant est un bonus, jamais une priorité.
 */
function shouldGrab(s = {}) {
  if (s.busy) return false;
  if (s.digging) return false;
  if (s.inWater) return false;
  if (s.hostilesNear) return false;
  if (typeof s.health === 'number' && s.health <= 8) return false;   // survie d'abord
  return true;
}

// ─── ITEMS AU SOL QUI VALENT UN DÉTOUR ─────────────────────────────────────────────────────────
// Massii, live 26/07 : « si il y a des item qui leur servent (genre diamant) il doivent les
// prendre ». Un minerai miné hors du rayon de ramassage automatique tombe au sol et y restait.
// Liste VOLONTAIREMENT étroite : on se détourne pour ce qui fait avancer la chaîne (minerais,
// lingots, combustible, outils, armure), jamais pour du remblai ou du décor — sinon le bot
// passerait sa vie à ramasser du gravier au lieu de miner.
const VALUABLE_DROPS = new Set([
  'diamond', 'emerald', 'ancient_debris', 'netherite_scrap', 'netherite_ingot',
  'raw_iron', 'iron_ingot', 'raw_gold', 'gold_ingot',   // cuivre exclu : rien ne le consomme
  'coal', 'charcoal', 'redstone', 'lapis_lazuli', 'quartz', 'amethyst_shard',
]);
const _VALUABLE_SUFFIX = ['_pickaxe', '_axe', '_sword', '_shovel', '_helmet', '_chestplate', '_leggings', '_boots'];

/** Cet item au sol vaut-il qu'on se détourne pour le ramasser ? (pur) */
function isValuableDrop(name) {
  if (!name || typeof name !== 'string') return false;
  if (VALUABLE_DROPS.has(name)) return true;
  return _VALUABLE_SUFFIX.some((sfx) => name.endsWith(sfx));   // outils/armure tombés (mort, toss)
}

// ─── MINERAIS QUI VALENT DE QUITTER SA TÂCHE ───────────────────────────────────────────────────
// Massii, live 26/07 : « neth 4 a reussi a esquiver une cave, alors que dans la cave il y avait un
// diamant ». Le ramassage opportuniste ne mordait qu'à portée de BRAS (4,2 blocs) et `caveHunt`
// n'entre en scène qu'en fin de chaîne : pendant la DESCENTE, un diamant visible à dix blocs était
// simplement ignoré. Liste très courte — seul ce qui est rare justifie d'interrompre le travail ;
// le fer et le charbon restent opportunistes, à portée de bras.
const DETOUR_ORES = new Set([
  'diamond_ore', 'deepslate_diamond_ore',
  'emerald_ore', 'deepslate_emerald_ore',
  'ancient_debris',
]);

/** Ce minerai visible justifie-t-il un détour de quelques blocs ? (pur) */
function isDetourWorthy(name) {
  return !!name && DETOUR_ORES.has(String(name));
}

module.exports = {
  WANTED_ORES, isWantedOre, canHarvest, shouldGrab,
  VALUABLE_DROPS, isValuableDrop, DETOUR_ORES, isDetourWorthy,
};
