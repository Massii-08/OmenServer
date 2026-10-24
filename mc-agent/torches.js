'use strict';
// DISCIPLINE DE TORCHE — calée sur une capture RÉELLE de partie à deux (Massitom2008 ×
// alexdon1837, 33 min, jusqu'au diamant + portail du nether, 26/07).
//
// Mesuré chez les humains : **131 et 97 torches posées en 33 minutes** (≈ 3-4 par minute), torche
// en main ~10 % du temps. Ils éclairent SYSTÉMATIQUEMENT ce qu'ils traversent.
// Le bot, lui, ne posait de torche que dans le tunnel de branch-mine (`torchEvery`) — le reste de
// sa vie souterraine (descente, récolte, déplacements) se passait dans le noir, or block-light 0
// est la condition EXACTE d'apparition des mobs. C'est le poste n°1 des 235 morts du run.
//
// RATIONNEMENT « JOUEUR » (Massii en jeu 24/10 : « il y a besoin de moins de torches »).
// Mesuré sur NethBot1/NethBot3 (sessions 588/590, 30 min) : 54 et 58 torches (~2/min), moitié galerie
// (branchMine), moitié tick d'ambiance. En galerie à LACETS (parallèles espacées de 3) une torche
// tombait tous les 5-8 blocs, et le tick d'ambiance en reposait une 0,5 s après juste à côté (il ne
// voyait pas les torches de la galerie). La lumière lue côté client vaut 0 même à côté d'une torche
// fraîche (light:0 dans 100 % des events) : elle ne peut PAS décider seule.
// Règle d'un joueur : une torche seulement si le sol est noir (≤ 3) ET qu'aucune torche n'est à
// ≤ TORCH_SPACING blocs (3D) — le long d'une galerie, une tous les ~12 blocs. Pas d'escalier jalonné.
//
// Décision PURE et bornée ; la pose (bot.placeBlock) reste côté appelant.

const TORCH_INTERVAL_MS = 12000;   // borne de cadence (le vrai frein est l'espacement)
const TORCH_MIN_MOVE = 6;          // blocs — inutile d'en empiler au même endroit
const SURFACE_Y = 50;              // au-dessus, la lumière du ciel fait le travail de jour
const DARK_LEVEL = 3;              // lumière connue > 3 → assez clair, pas de torche
const TORCH_SPACING = 11;          // une torche à ≤ 11 blocs (3D) éclaire déjà l'endroit
const STAIR_DARK_MS = 45000;       // escalier : torche seulement après 45 s d'obscurité continue

const _num = (v) => typeof v === 'number' && Number.isFinite(v);

/**
 * PUR — faut-il poser une torche maintenant ?
 * @param {{y:number, lightLevel:number|null, torches:number, now:number,
 *          lastAt:number, pos:{x,z}, lastPos:{x,z}|null, nearestTorch?:number|null,
 *          stair?:boolean, darkForMs?:number|null, opts?:object}} s
 *  - nearestTorch : distance 3D de la torche connue la plus proche (scan + registre), null = aucune
 *  - stair : descente en escalier en cours → seulement si noir total depuis ≥ STAIR_DARK_MS (darkForMs)
 * @returns {boolean}
 */
function shouldPlaceTorch(s) {
  const o = s || {};
  if (!o.torches || o.torches < 1) return false;              // rien à poser
  const opts = o.opts || {};
  const surfaceY = opts.surfaceY === undefined ? SURFACE_Y : opts.surfaceY;
  if (typeof o.y === 'number' && o.y > surfaceY) return false; // en surface, le ciel suffit
  if (!galleryTorchWanted({ lightLevel: o.lightLevel, nearestTorch: o.nearestTorch, opts })) return false;
  // Descente en escalier : on ne jalonne pas l'escalier ; seulement un noir total qui dure.
  if (o.stair) {
    const need = opts.stairDarkMs === undefined ? STAIR_DARK_MS : opts.stairDarkMs;
    if (!(_num(o.darkForMs) && o.darkForMs >= need)) return false;
  }
  const interval = opts.intervalMs === undefined ? TORCH_INTERVAL_MS : opts.intervalMs;
  if (typeof o.lastAt === 'number' && (o.now - o.lastAt) < interval) return false;
  // Anti-empilement : il faut avoir avancé depuis la dernière torche.
  const minMove = opts.minMove === undefined ? TORCH_MIN_MOVE : opts.minMove;
  if (o.lastPos && o.pos) {
    const d = Math.hypot(o.pos.x - o.lastPos.x, o.pos.z - o.lastPos.z);
    if (d < minMove) return false;
  }
  return true;
}

/**
 * PUR — règle de LIEU commune (galerie comme ambiance) : sol noir (lumière connue ≤ DARK_LEVEL, inconnue
 * = sombre) ET aucune torche connue à ≤ TORCH_SPACING blocs.
 */
function galleryTorchWanted({ lightLevel = null, nearestTorch = null, opts = {} } = {}) {
  const o = opts || {};
  const dark = o.darkLevel === undefined ? DARK_LEVEL : o.darkLevel;
  if (_num(lightLevel) && lightLevel > dark) return false;
  const spacing = o.spacing === undefined ? TORCH_SPACING : o.spacing;
  if (_num(nearestTorch) && nearestTorch <= spacing) return false;
  return true;
}

/**
 * Registre des torches POSÉES par ce process (toutes sources : galerie, grotte, ambiance). Il couvre le
 * cas où le scan des blocs ne voit pas encore la torche (blockUpdate en retard) ou n'existe pas.
 * Les torches restent au monde : pas de TTL, juste un plafond.
 */
function createTorchRegistry(cap = 128) {
  const list = [];
  const ok = (q) => !!q && _num(q.x) && _num(q.y) && _num(q.z);
  return {
    note(pos) {
      if (!ok(pos)) return;
      list.push({ x: pos.x, y: pos.y, z: pos.z });
      if (list.length > cap) list.splice(0, list.length - cap);
    },
    nearest(pos) {
      if (!ok(pos)) return null;
      let best = null;
      for (const t of list) {
        const d = Math.hypot(t.x - pos.x, t.y - pos.y, t.z - pos.z);
        if (best == null || d < best) best = d;
      }
      return best;
    },
    size() { return list.length; },
    clear() { list.length = 0; },
  };
}
// Registre PARTAGÉ du process (niveau module : lu par le tick d'ambiance, la grotte ET la galerie).
const sharedTorchRegistry = createTorchRegistry();

const TORCH_BLOCKS = ['torch', 'wall_torch', 'soul_torch', 'soul_wall_torch', 'lantern', 'soul_lantern'];

/**
 * Distance 3D de la torche la plus proche de `pos` : registre partagé + scan des blocs chargés
 * (`bot.findBlocks`, rayon `radius`, autour de `pos`). null = aucune connue. Jamais de throw.
 */
function nearestTorchDist(bot, pos, { registry = sharedTorchRegistry, radius = TORCH_SPACING + 1 } = {}) {
  if (!pos || !_num(pos.x) || !_num(pos.y) || !_num(pos.z)) return null;
  let best = null;
  try { best = registry ? registry.nearest(pos) : null; } catch (e) { best = null; }
  try {
    if (bot && typeof bot.findBlocks === 'function' && bot.registry && bot.registry.blocksByName) {
      const ids = TORCH_BLOCKS.map((n) => bot.registry.blocksByName[n] && bot.registry.blocksByName[n].id)
        .filter((x) => x != null);
      if (ids.length) {
        let point = pos;
        try { point = require('vec3')(pos.x, pos.y, pos.z); } catch (e) { /* POJO */ }
        const hits = bot.findBlocks({ matching: ids, maxDistance: radius, count: 1, point }) || [];
        for (const h of hits) {
          if (!h) continue;
          const d = Math.hypot(h.x - pos.x, h.y - pos.y, h.z - pos.z);
          if (best == null || d < best) best = d;
        }
      }
    }
  } catch (e) { /* scan raté → registre seul */ }
  return best;
}

module.exports = {
  shouldPlaceTorch, galleryTorchWanted, createTorchRegistry, sharedTorchRegistry, nearestTorchDist,
  TORCH_INTERVAL_MS, TORCH_MIN_MOVE, SURFACE_Y, DARK_LEVEL, TORCH_SPACING, STAIR_DARK_MS, TORCH_BLOCKS,
};
