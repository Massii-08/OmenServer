'use strict';
// ALLER LÀ OÙ L'EAU EST — décision PURE, lue depuis la mémoire de monde du groupe.
//
// Mesure live (run world_mn15, ~5 h de flotte v6) : `fish` appelé **737 fois → 0 poisson**. Les
// mécanismes de la chaîne alimentaire v6 tournaient tous, mais À VIDE : `fishCatch` ne cherche l'eau
// qu'à `maxDistance` (24) du chantier, or un puits de mine est rarement au bord d'une rivière — d'où
// `no_water`. Le paradoxe est que la flotte SAIT où est l'eau : les cartographes ont peint des
// centaines de cellules de biome dans la carte partagée, océans et rivières compris (c'est même le
// correctif #52b qui a cessé de les jeter). Il manquait juste le chaînon « de la carte vers un point
// où marcher ». C'est tout ce que fait ce module.
//
// Deux invariants portés par le reste du projet, rappelés ici parce qu'ils cadrent le contrat :
//   • LE BOT N'ENTRE JAMAIS DANS L'EAU (la noyade est le premier tueur du projet). On rend un point
//     où ALLER, la berge reste élue par `pickFishingSpot` (skills/fish.js) une fois sur place.
//   • Aucune lecture du monde ici : le module ne connaît que la carte et une position. Testable
//     sans client MC, et donc réellement testé (la flotte est éteinte au moment où ceci est écrit).
const { isWetBiome } = require('./zone');   // « mouillé » = océan|rivière — UNE seule définition

// Plafond de voyage. Au-delà, un aller-retour coûte plus cher en temps (et en morts) que ce qu'il
// rapporte : un bot affamé qui marche 400 blocs meurt en route, c'est exactement ce qu'on répare.
const WATER_TRIP_MAX = 250;
// La grille du backend (`mc_agent_world_memory.GRID`) : une entrée de biome = une cellule de 128².
const WATER_CELL = 128;
// On vise à l'INTÉRIEUR de la cellule, pas sur son arête. Le biome d'une cellule vient d'UN
// échantillon : au bord, on est aussi bien sur la berge d'en face que dans le pré voisin. 32 blocs
// (un quart de cellule) rentre assez pour tomber dans la nappe sans allonger le trajet — et
// `fishCatch` finit le travail avec son propre rayon de recherche.
const WATER_INSET = 32;

function _finite(v) { return typeof v === 'number' && Number.isFinite(v); }
function _clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

/**
 * PUR — le point d'eau CONNU le plus proche, ou null.
 *
 * @param {object} o
 *   memory   : la mémoire de monde chargée (`loadMemory`) — {worlds:{<clé>:{biomes:[…]}}}
 *   worldKey : la clé de monde du bot (`bot._worldKey`)
 *   pos      : {x,z} du bot (un Vec3 fait l'affaire : seuls x et z sont lus)
 *   maxDist  : plafond de voyage (défaut WATER_TRIP_MAX)
 *   cellSize : taille de la grille de biomes (défaut WATER_CELL)
 *   inset    : marge de rentrée dans la cellule (défaut WATER_INSET ; borné à la demi-cellule,
 *              donc un inset absurde donne le CENTRE et jamais un point hors de la boîte)
 * @returns {{x:number, z:number, dist:number, biome:string}|null}
 *
 * Départage 100 % DÉTERMINISTE (distance, puis coin de cellule en lexicographique) : deux bots qui
 * lisent la même carte visent la même eau, et un même bot re-vise la même à chaque tentative — donc
 * pas d'oscillation entre deux nappes équidistantes.
 */
function nearestWater(o = {}) {
  if (!o) return null;
  const pos = o.pos;
  if (!pos || !_finite(pos.x) || !_finite(pos.z)) return null;

  const w = o.memory && o.memory.worlds && o.memory.worlds[o.worldKey];
  const biomes = w && Array.isArray(w.biomes) ? w.biomes : null;
  if (!biomes || !biomes.length) return null;

  const maxDist = o.maxDist != null ? Number(o.maxDist) : WATER_TRIP_MAX;
  const size = o.cellSize != null ? Number(o.cellSize) : WATER_CELL;
  if (!Number.isFinite(maxDist) || !Number.isFinite(size) || size <= 0) return null;
  const rawInset = o.inset != null ? Number(o.inset) : WATER_INSET;
  // Une cellule de 128 va de 0 à 127 : la demi-cellule utilisable est (size-1)/2, sinon un inset
  // trop grand croiserait les bornes et rendrait un point HORS de la cellule (lo > hi).
  const inset = _clamp(Number.isFinite(rawInset) ? rawInset : WATER_INSET, 0, Math.floor((size - 1) / 2));

  let best = null;
  let bestKey = null;
  for (const b of biomes) {
    if (!b || !_finite(b.x) || !_finite(b.z)) continue;
    if (!isWetBiome(b.name)) continue;   // un biome custom sans nom n'est PAS déclaré mouillé
    // On refloore sur la grille : idempotent quand la coordonnée est déjà quantifiée (cas normal,
    // `add_biome` le fait côté backend), correct quand elle ne l'est pas (carte relue à la main).
    const cx = Math.floor(b.x / size) * size;
    const cz = Math.floor(b.z / size) * size;
    const x = _clamp(Math.round(pos.x), cx + inset, cx + size - 1 - inset);
    const z = _clamp(Math.round(pos.z), cz + inset, cz + size - 1 - inset);
    const dist = Math.hypot(x - pos.x, z - pos.z);
    if (dist > maxDist) continue;
    const key = [dist, cx, cz];
    if (!bestKey || _lex(key, bestKey) < 0) {
      bestKey = key;
      best = { x, z, dist, biome: String(b.name) };
    }
  }
  return best;
}

/** Comparaison lexicographique de deux tuples numériques (même idiome que zone.pickMigrationTarget). */
function _lex(a, b) {
  for (let i = 0; i < a.length; i++) {
    if (a[i] < b[i]) return -1;
    if (a[i] > b[i]) return 1;
  }
  return 0;
}

module.exports = { nearestWater, WATER_TRIP_MAX, WATER_CELL, WATER_INSET };
