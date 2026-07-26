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
  'copper_ore', 'deepslate_copper_ore',
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

module.exports = { WANTED_ORES, isWantedOre, canHarvest, shouldGrab };
