'use strict';
// CARTOGRAPHIE « EN PASSANT » PAR LES MINEURS (Massii 24/10 : les cartographes sont supprimés, on GARDE
// la carte — ce sont les mineurs qui la nourrissent pendant leur travail).
//
// Reprend les deux lectures utiles du cartographe (mapper.js `record()`) :
//   - le BIOME de la cellule 128 où se tient le bot et de l'anneau voisin (point le plus proche de chaque
//     voisine, cf. mapper.js : le cache client s'arrête à ~96 blocs) → `biome_seen`. SEULEMENT EN SURFACE :
//     sous terre l'échantillon peint des biomes de grotte sur les cellules voisines (piège #52d) ;
//   - les MINERAIS des chunks chargés (`scanAllOres`, drapeaux exposed/wet) → `ores_found` batché, que la
//     chasse aux grottes (caveHunt : minerais MAPPÉS, exposés, secs) consomme ensuite.
// Coût borné : au plus 1 passe / `everyMs` (45 s), jamais pendant un combat, un dig, un craft (`busy`
// fourni par l'appelant) ; scan de minerais en rayon 48 (pas 128 comme le cartographe, qui bloquait
// l'event loop — phase 2) et seulement après ≥ 24 blocs de déplacement ou 10 min ; dédup par bloc.
// `material_found` reste émis par gather (inchangé).

const { scanAllOres, oresFoundEvent } = require('./ores');
const { biomeSeenEvent, resolveBiome } = require('./worldMemory');

const GRID = 128;
const SURVEY_EVERY_MS = 45 * 1000;
const ORE_RESCAN_MS = 10 * 60 * 1000;
const ORE_MOVE_BLOCKS = 24;
const ORE_RADIUS = 48;
const ORE_COUNT = 400;
const SURFACE_Y = 50;          // repli quand le skyLight est illisible
const SURFACE_SKYLIGHT = 10;   // ciel visible (ou presque) aux pieds = surface
const SEEN_CAP = 20000;

function cellKey(x, z, grid = GRID) {
  return Math.floor(x / grid) * grid + ',' + Math.floor(z / grid) * grid;
}

/** PUR — le bot est-il « en surface » (biome lisible sans peindre une grotte) ? */
function isSurfaceSample({ y, skyLight } = {}) {
  if (Number.isFinite(skyLight)) return skyLight >= SURFACE_SKYLIGHT;
  return Number.isFinite(y) && y >= SURFACE_Y;
}

/** PUR — faut-il rescanner les minerais (déplacement ou ancienneté) ? */
function oreScanDue({ pos, last, now, moveBlocks = ORE_MOVE_BLOCKS, rescanMs = ORE_RESCAN_MS } = {}) {
  if (!pos || !Number.isFinite(now)) return false;
  if (!last || !last.pos) return true;
  const d = Math.hypot(pos.x - last.pos.x, pos.y - last.pos.y, pos.z - last.pos.z);
  return d >= moveBlocks || now - last.at >= rescanMs;
}

function _v(x, y, z) {
  try { const { Vec3 } = require('vec3'); return new Vec3(x, y, z); } catch (e) { return { x, y, z }; }
}

/**
 * Relevé « en passant ». `tick(bot, {busy})` → {biomes, ores} | null (rien fait : throttle ou occupé).
 * Jamais de throw.
 */
function createSurvey({ worldKey = () => 'overworld', emit = () => {}, now = () => Date.now(),
  everyMs = SURVEY_EVERY_MS, oreRadius = ORE_RADIUS, oreCount = ORE_COUNT, rings = 1 } = {}) {
  const biomeCells = new Set();
  const oreSeen = new Set();
  let lastAt = 0;
  let lastOre = null;
  const wk = () => { try { return String(typeof worldKey === 'function' ? worldKey() : worldKey); } catch (e) { return 'overworld'; } };

  function biomes(bot, p) {
    let n = 0;
    const world = wk();
    const read = (x, z) => {
      const k = cellKey(x, z);
      if (biomeCells.has(k)) return true;
      let b = null;
      try { b = bot.blockAt(_v(Math.floor(x), Math.floor(p.y), Math.floor(z))); } catch (e) { b = null; }
      if (!b || !b.biome) return false;
      biomeCells.add(k);
      emit(biomeSeenEvent(world, { biome: resolveBiome(bot, b) }, { x, y: p.y, z }));
      n++;
      return true;
    };
    read(p.x, p.z);
    const baseX = Math.floor(p.x / GRID) * GRID, baseZ = Math.floor(p.z / GRID) * GRID;
    const near = (base, d, cur) => (d < 0 ? base + d * GRID + GRID - 1 : d > 0 ? base + d * GRID : Math.floor(cur));
    for (let ring = 1; ring <= rings; ring++) {
      for (let dx = -ring; dx <= ring; dx++) {
        for (let dz = -ring; dz <= ring; dz++) {
          if (Math.max(Math.abs(dx), Math.abs(dz)) !== ring) continue;
          read(near(baseX, dx, p.x), near(baseZ, dz, p.z));
        }
      }
    }
    if (biomeCells.size > SEEN_CAP) biomeCells.clear();
    return n;
  }

  function ores(bot, p, t) {
    if (!oreScanDue({ pos: p, last: lastOre, now: t })) return 0;
    lastOre = { pos: { x: p.x, y: p.y, z: p.z }, at: t };
    const fresh = [];
    for (const o of scanAllOres(bot, { maxDistance: oreRadius, count: oreCount })) {
      const k = o.x + ',' + o.y + ',' + o.z;
      if (oreSeen.has(k)) continue;
      oreSeen.add(k);
      fresh.push(o);
    }
    if (oreSeen.size > SEEN_CAP) oreSeen.clear();
    if (fresh.length) emit(oresFoundEvent(wk(), fresh));
    return fresh.length;
  }

  function tick(bot, opts = {}) {
    try {
      if (opts.busy) return null;
      const t = now();
      if (lastAt && t - lastAt < everyMs) return null;
      const pos = bot && bot.entity && bot.entity.position;
      if (!pos || !Number.isFinite(pos.x) || typeof bot.blockAt !== 'function') return null;
      lastAt = t;
      const p = { x: pos.x, y: pos.y, z: pos.z };   // COPIE (Vec3 muté en place)
      let skyLight = null;
      try { const b = bot.blockAt(_v(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z))); if (b && Number.isFinite(b.skyLight)) skyLight = b.skyLight; } catch (e) { skyLight = null; }
      const nb = isSurfaceSample({ y: p.y, skyLight }) ? biomes(bot, p) : 0;
      let no = 0;
      try { no = ores(bot, p, t); } catch (e) { no = 0; }
      return { biomes: nb, ores: no };
    } catch (e) { return null; }
  }

  return { tick, _state: () => ({ biomeCells: biomeCells.size, oreSeen: oreSeen.size, lastOre }) };
}

module.exports = { createSurvey, isSurfaceSample, oreScanDue, cellKey, SURVEY_EVERY_MS, ORE_RADIUS, ORE_MOVE_BLOCKS, ORE_RESCAN_MS };
