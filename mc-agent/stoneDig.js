'use strict';
// PIERRE « COMME UN JOUEUR » (Massii 21/10 : « que les bots soient RAPIDES pour passer de zéro à
// l'armure de fer »).
//
// Mesure (run de zéro du 21/10, 3 ouvriers, 303 min) : `cobble_furnace` 25 min + `cobble_lava` 22 min
// pour 8 et 12 pierres. Hors nuit et migration, ~35 min passées dans `gather('stone')` : trois tranches
// de 480 s finies en `timeout` sans un seul bloc (collectBlock qui marche vers une pierre trouvée par
// findBlock à 30-60 blocs — souvent dans une colline, 90 s de collect × 2 par bloc), une autre partie
// explorer 17 waypoints de surface faute de pierre « visible » à 64 blocs, alors qu'elle était 3-5 blocs
// SOUS ses pieds. Un humain creuse un escalier (jamais un puits droit) et a ses 30 cobble en une minute.
//
// Ici : la décision PURE (faut-il l'escalier, jusqu'où) et la TAILLE DU LOT. Le câblage (index.js, but
// `gather` pierre) appelle descendDiagonal avec `stopWhen` = « le lot est en poche », puis retombe sur
// l'ancien chemin (mineDown + gather explore) si l'escalier s'arrête sur de l'eau, de la lave ou un vide.

// LOT : la chaîne T1 demande la pierre en QUATRE fois (pioche 3, four 8, pioche de rechange 6, réserve
// anti-lave 12, + épée 2 et hache 3) — quatre trajets, quatre recherches. Un joueur en prend une
// trentaine d'un coup. 32 = four 8 + rechange 3 + lave 12 + épée 2 + hache 3 + 4 de marge (1 pile).
const STONE_BATCH = 32;
// Jamais d'escalier au-dessous de ça pour de la pierre : la deepslate (y ≤ 8) donne de la
// cobbled_deepslate, que les buts ne comptent pas.
const STONE_STAIR_MIN_Y = 20;
// Paliers max par appel : 2 blocs par palier, ~4 de terre au-dessus de la roche → 32 cobble ≈ 20 paliers.
const STONE_STAIR_MAX_STEPS = 40;

const STONE_PICKS = new Set(['stone_pickaxe', 'iron_pickaxe', 'diamond_pickaxe', 'netherite_pickaxe', 'golden_pickaxe']);

/** PUR — meilleure pioche en poche : 'stone' (pierre ou mieux), 'wood', ou null. `items` = [{name,count}]. */
function pickTier(items) {
  let wood = false;
  for (const i of items || []) {
    if (!i || !i.name) continue;
    if (STONE_PICKS.has(i.name)) return 'stone';
    if (i.name === 'wooden_pickaxe') wood = true;
  }
  return wood ? 'wood' : null;
}

/**
 * PUR — combien de pierres récolter pour ce but. `count` = ce que le but demande, `have` = cobble en poche.
 * Avec une pioche pierre (durable) et hors cartographe, on prend le LOT (on complète jusqu'à STONE_BATCH) ;
 * avec une pioche en bois (59 coups) on s'en tient au besoin du but — la casser coûterait tout le bootstrap.
 */
function stoneBatchWant({ count = 1, have = 0, tier = null, isMapper = false } = {}) {
  const c = Math.max(1, Number(count) || 1);
  if (tier !== 'stone' || isMapper) return c;
  return Math.max(c, STONE_BATCH - Math.max(0, Number(have) || 0));
}

/**
 * PUR — l'escalier est-il le bon moyen ? null = non (pas de pioche, déjà trop bas, altitude inconnue).
 * → { targetY, maxDepth }. `y` = altitude des pieds.
 */
function stoneStairPlan({ y, tier = null } = {}) {
  if (!tier) return null;                                   // sans pioche on ne creuse pas la roche
  if (!(typeof y === 'number' && Number.isFinite(y))) return null;
  if (y <= STONE_STAIR_MIN_Y + 2) return null;
  return { targetY: STONE_STAIR_MIN_Y, maxDepth: STONE_STAIR_MAX_STEPS };
}

module.exports = { pickTier, stoneBatchWant, stoneStairPlan, STONE_BATCH, STONE_STAIR_MIN_Y, STONE_STAIR_MAX_STEPS };
