'use strict';
// « Ramasser le minerai en passant » — Massii 2026-07-26 : « il y a plein de fois où les bots
// passent à côté du fer mais ne le prennent pas ».
//
// La collecte opportuniste n'existait QUE dans branchMine (les minerais que ses propres coups
// exposent). Partout ailleurs — trajet vers la base, descente, sortie de grotte, retour au
// chantier — un bloc de fer à un bloc du nez était ignoré : le planner ne mine que ce qu'il a
// décidé de miner. Un joueur, lui, casse ce qui est à portée de main et continue sa route.
//
// Contrat d'origine : on ne mine QUE ce qui est déjà à portée de bras (aucun déplacement). Il a
// grandi depuis — détour pour un minerai RARE (DETOUR_ORES), quelques pas vers du minerai visible
// (`oreStepPlan` 'walk'), marche vers un item au sol de valeur, approche quand le bloc est derrière
// une paroi — et chacun de ces gestes POSE UN BUT PATHFINDER. Or le pathfinder n'a qu'un but : poser
// le nôtre fait rejeter le `goto` en cours (GoalChanged). Mesure goal_trace (19/10) : le premier
// appelant qui interrompait un trajet du planner était CE timer (sa marche 'walk').
// D'où `grabScope` : pendant une migration, rien ; quand un AUTRE trajet est en cours, portée de bras
// seulement (le détour vers du rare reste permis : il vaut l'interruption) ; sans trajet, tout.
// Décisions pures ici ; le scan, les goto et le dig vivent dans index.js.

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

// ─── QUELQUES PAS POUR DU MINERAI VISIBLE (Massii, photo à l'appui, 27/07) ─────────────────────
// « Il y a clairement 3 veines de fer et on voit le passage des bots, mais ils n'ont rien pris. »
// Et, correction de Massii : « certains ont encore des pioches mais ils ne creusent pas le fer »
// — donc ce n'était PAS un problème d'outil.
//
// La cause est dans le contrat d'origine de ce module : « on ne mine QUE ce qui est déjà à portée
// de bras (4,2 blocs), aucun déplacement ». Dans une salle creusée, le fer est dans les PAROIS, à
// 5-10 blocs — visible, atteignable en trois pas, et systématiquement ignoré. Un joueur fait les
// trois pas. Le détour existait déjà, mais réservé au diamant (`DETOUR_ORES`) : le fer, qui est
// LE goulot de la chaîne d'armure, en était exclu.
//
// On garde le principe (une ponctuation, pas une priorité) : rayon court, un seul minerai par
// passe, et toutes les gardes de `shouldGrab` inchangées.
const ORE_STEP_MAX = 12;      // portee de marche ET rayon de scan (index.js) : une seule source de verite
const ORE_REACH = 4.2;        // portée de bras : en deçà, aucun déplacement nécessaire

/**
 * Faut-il faire quelques pas pour ce minerai ? (pur)
 * @returns {'reach'|'walk'|null} — 'reach' = déjà à portée, 'walk' = s'en approcher, null = laisser.
 */
function oreStepPlan({ name, dist, maxDist = ORE_STEP_MAX, reach = ORE_REACH } = {}) {
  if (!isWantedOre(name)) return null;
  if (typeof dist !== 'number' || !Number.isFinite(dist) || dist < 0) return null;
  if (dist <= reach) return 'reach';
  return dist <= maxDist ? 'walk' : null;
}

// ─── NE PAS VOLER LE TRAJET EN COURS (mesure goal_trace, 19/10) ────────────────────────────────
// Le premier appelant qui interrompait un `pathfinder.goto` du planner (explore, migration, branch-
// mine) était `Timeout._onTimeout@index.js:6083` : la marche 'walk' de ce timer. Tout ce qui fait
// MARCHER le bot (walk, drop, approche) pose un but → GoalChanged → le trajet du planner échoue.
//
// Le scan se limite à ce qu'on a le droit de miner : en portée de bras, `ORE_REACH` + 2 suffit
// (findBlocks mesure depuis la position ARRONDIE, oreStepPlan depuis la position EXACTE : < √3 d'écart).
const REACH_SCAN = ORE_REACH + 2;

/**
 * Ce que la prise opportuniste a le DROIT de faire maintenant, vu le trajet en cours. (PUR)
 *
 *   - migration en cours → RIEN (`run:false`) : la migration est EXCLUSIVE — un but posé sous ses
 *     jambes lui volerait le pathfinder, un dig se battrait avec les creusages de la jambe ;
 *   - un AUTRE but pathfinder est posé → minerais déjà à portée de bras SEULEMENT (ni marche, ni
 *     drop, ni approche) ; le DÉTOUR vers un minerai rare (DETOUR_ORES) reste permis — rare, il vaut
 *     l'interruption ;
 *   - aucun autre but → comportement d'avant, inchangé.
 *
 * « Autre » : `ownGoal` est le dernier but posé PAR le ramassage. mineflayer-pathfinder ne remet pas
 * `goal` à null après un NoPath ou un chemin vide — sans cette exception, un minerai inatteignable une
 * seule fois laisserait le timer en portée de bras jusqu'au prochain trajet de quelqu'un d'autre.
 *
 * @param {{migrating?: boolean, goal?: *, ownGoal?: *}} [s] — `goal` = bot.pathfinder.goal
 * @returns {{run: boolean, detour: boolean, walk: boolean, drops: boolean, approach: boolean,
 *            maxDist: number, scan: number}} — `maxDist` à passer à oreStepPlan, `scan` à findBlocks
 */
function grabScope({ migrating = false, goal = null, ownGoal = null } = {}) {
  if (migrating) {
    return { run: false, detour: false, walk: false, drops: false, approach: false, maxDist: 0, scan: 0 };
  }
  const otherTrip = goal != null && goal !== ownGoal;
  if (otherTrip) {
    return { run: true, detour: true, walk: false, drops: false, approach: false, maxDist: ORE_REACH, scan: REACH_SCAN };
  }
  return { run: true, detour: true, walk: true, drops: true, approach: true, maxDist: ORE_STEP_MAX, scan: ORE_STEP_MAX };
}

/**
 * Minerai à portée mais hors ligne de vue : peut-on s'en approcher (GoalGetToBlock = un but) ? (PUR)
 * Sans autre trajet, oui ; sinon seulement pour du rare — c'est un détour comme un autre.
 */
function mayApproach(scope, oreName) {
  if (!scope || !scope.run) return false;
  return !!scope.approach || (!!scope.detour && isDetourWorthy(oreName));
}

module.exports = {
  WANTED_ORES, isWantedOre, canHarvest, shouldGrab,
  VALUABLE_DROPS, isValuableDrop, DETOUR_ORES, isDetourWorthy,
  oreStepPlan, ORE_STEP_MAX, ORE_REACH,
  grabScope, mayApproach, REACH_SCAN,
};
