'use strict';
// OÙ POSER LA TABLE QUAND ÇA RATE (22/10, NethBot3 sessions 200/217/226/246) — décisions PURES.
//
// Mesuré en live, deux mécanismes distincts derrière la même boucle :
//  1. `spare_picks` `no_table:no_space` ×4 en 6 ms, `around`/`under` = « unloaded » ×8 : la pose est
//     tentée juste APRÈS un téléport (`regroup_tpa`, 453 blocs) — les chunks d'arrivée ne sont pas encore
//     reçus, `blockAt` rend null partout, toutes les passes sautent, et le planner re-tente 4 fois dans
//     la même milliseconde. Ce n'est pas un manque de place : c'est un monde pas encore chargé.
//  2. `crafting_table` `timeout` ×4 (90 s chacun) sous terre (y 15-20) : `recycleNearbyTable` marchait
//     vers une table abandonnée 38 blocs PLUS HAUT (y 53), le goto (30 s) n'arrivait pas, puis
//     `reclaimBlock` lançait `collectBlock.collect` — NON borné — vers cette table hors d'atteinte. Le
//     but expirait sans jamais émettre `table_recycled`, alors qu'une bûche en poche suffisait à
//     fabriquer une table neuve.
// Et le cas « vrai » no_space (tunnel, voisins sans sol) : après 2 échecs AU MÊME ENDROIT, se décaler de
// quelques blocs dans le tunnel avant de réessayer, comme un joueur — jamais boucler sur la même case.

const RECYCLE_MAX_DY = 6;          // une table à plus de 6 blocs de dénivelé = un autre étage/tunnel/la surface
const NO_SPACE_RADIUS = 2;         // « même endroit » : à ≤ 2 blocs (le bot oscille d'une case en tunnel)
const NO_SPACE_TTL_MS = 10 * 60 * 1000;
const NO_SPACE_SHIFT_AFTER = 2;    // 2 échecs ici → on se décale avant le suivant
const STEP_MIN = 2;
const STEP_MAX = 4;

/** Table abandonnée qu'il vaut la peine d'aller REPRENDRE ? Dénivelé ≤ RECYCLE_MAX_DY. */
function recycleWorthIt(botPos, tablePos, maxDy = RECYCLE_MAX_DY) {
  if (!botPos || !tablePos) return false;
  return Math.abs(tablePos.y - botPos.y) <= maxDy;
}

/** Vrai si le diagnostic de placeBlockNear montre un voisinage NON CHARGÉ (pas un manque de place). */
function neighbourhoodUnloaded(diag) {
  if (!diag) return false;
  const all = [].concat(diag.around || [], diag.under || []);
  return all.length > 0 && all.some((n) => n === 'unloaded');
}

/**
 * Mémoire des échecs `no_space` par endroit. `note(pos, now)` enregistre un échec et rend le nombre
 * d'échecs récents à ≤ radius de pos (celui-ci compris). `shouldShift(pos, now)` = assez d'échecs ici
 * pour se décaler. Pur (horloge passée en argument).
 */
function createNoSpaceMemo(opts = {}) {
  const radius = opts.radius != null ? opts.radius : NO_SPACE_RADIUS;
  const ttlMs = opts.ttlMs != null ? opts.ttlMs : NO_SPACE_TTL_MS;
  const after = opts.shiftAfter != null ? opts.shiftAfter : NO_SPACE_SHIFT_AFTER;
  let fails = [];
  const prune = (now) => { fails = fails.filter((f) => now - f.at < ttlMs); };
  const near = (a, b) => Math.abs(a.x - b.x) <= radius && Math.abs(a.y - b.y) <= radius && Math.abs(a.z - b.z) <= radius;
  function count(pos, now) {
    prune(now);
    if (!pos) return 0;
    return fails.filter((f) => near(f, pos)).length;
  }
  return {
    note(pos, now) {
      if (pos) fails.push({ x: Math.floor(pos.x), y: Math.floor(pos.y), z: Math.floor(pos.z), at: now });
      return count(pos, now);
    },
    count,
    shouldShift(pos, now) { return count(pos, now) >= after; },
    size() { return fails.length; },
  };
}

const PASSABLE = new Set(['air', 'cave_air', 'void_air', 'short_grass', 'grass', 'tall_grass', 'fern', 'snow']);
const isPassable = (b) => !!b && (PASSABLE.has(b.name) || (b.boundingBox === 'empty' && !/water|lava|fire|cobweb|portal/.test(b.name)));
const isFloor = (b) => !!b && b.boundingBox === 'block' && !/lava|magma/.test(b.name);

/**
 * Cases où se DÉCALER (avancer/reculer dans le tunnel) : sur les 4 axes, à STEP_MIN..STEP_MAX blocs, une
 * case pieds+tête praticables sur un sol plein, joignable EN LIGNE DROITE (toutes les cases intermédiaires
 * praticables — on reste dans le tunnel, on ne creuse pas). `read(x, y, z)` → bloc ou null (non chargé).
 * Plus proches d'abord. Rend [] si rien (le bot reste et l'appelant dira pourquoi).
 */
function stepAsideCells(base, read, opts = {}) {
  const min = opts.min != null ? opts.min : STEP_MIN;
  const max = opts.max != null ? opts.max : STEP_MAX;
  const out = [];
  const axes = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  for (const [dx, dz] of axes) {
    for (let k = 1; k <= max; k++) {
      const x = base.x + dx * k;
      const z = base.z + dz * k;
      const feet = read(x, base.y, z);
      const head = read(x, base.y + 1, z);
      if (!isPassable(feet) || !isPassable(head)) break;   // mur ou non chargé : le couloir s'arrête là
      if (k >= min && isFloor(read(x, base.y - 1, z))) out.push({ x, y: base.y, z, dist: k });
    }
  }
  out.sort((a, b) => a.dist - b.dist);
  return out;
}

module.exports = {
  recycleWorthIt, neighbourhoodUnloaded, createNoSpaceMemo, stepAsideCells,
  RECYCLE_MAX_DY, NO_SPACE_RADIUS, NO_SPACE_TTL_MS, NO_SPACE_SHIFT_AFTER, STEP_MIN, STEP_MAX,
};
