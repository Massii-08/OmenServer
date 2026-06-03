'use strict';
// Boucle de cartographie du bot « cartographe » (1b, 0 LLM) — ERRANCE ORGANIQUE (#4 retours live :
// « pas des cercles, trop suspect » — un joueur humain n'explore pas en anneaux) :
//  - cible suivante tirée AU HASARD : cap biaisé continuation (±60°, parfois grand virage),
//    distance variable 48-144 blocs — aucune géométrie régulière détectable ;
//  - ÉVITE LES OCÉANS (#5) : cellules de biome océan connues + échantillon du terrain droit devant
//    (surface = eau → autre cap) ; s'il finit quand même à l'eau → unstuck.js (#1) ;
//  - secteur multi-mappers (sectors.js) : la cible vue depuis la MAISON reste dans le wedge,
//    lu LIVE via getSector (re-balance stdin du manager) ;
//  - skip des cellules déjà mappées (mémoire bootstrap du groupe + cellules locales) ;
//  - FALLBACK : plus aucune cible valable autour → RETOUR AU SPAWN (home) puis repart dans une
//    autre direction aléatoire (backoff anti boucle chaude) ;
//  - à chaque arrivée : biome → biome_seen ; entrée de grotte (caves.js) → cave_found ;
//    dédup locale par cellule 128 (le store backend dédup aussi, ceinture+bretelles) ;
//  - survie « basique + » (survival.js) re-tickée avant chaque déplacement, cap anti-blocage.
// Ne retourne JAMAIS sauf annulation du token (c'est un rôle, pas une tâche finie).
const { sectorRange, headingOf, inSector, isCellMapped } = require('./sectors');
const { detectCaveEntrance } = require('./caves');
const { biomeSeenEvent, caveFoundEvent, resolveBiome } = require('./worldMemory');
const { survivalTick } = require('./survival');
const { isInWater, escapeWater, WATER } = require('./unstuck');
let vec3; try { vec3 = require('vec3'); } catch (e) { vec3 = null; }

const GRID = 128;          // même grille que le store backend (quantif/dédup)
const SURVIVAL_CAP = 10;   // re-ticks survie max avant de reprendre la route (anti-blocage)

/** Clé de cellule quantifiée (grille 128, floor — cohérent côté négatif). */
function cellKey(x, z, grid = GRID) {
  return Math.floor(x / grid) * grid + ',' + Math.floor(z / grid) * grid;
}

/** La cellule de (x,z) est-elle un biome OCÉAN connu de la mémoire ? (#5 — on n'y va pas) */
function isOceanCell(memory, worldKey, x, z, grid = GRID) {
  const w = memory && memory.worlds && memory.worlds[worldKey];
  if (!w) return false;
  const q = (v) => Math.floor(v / grid) * grid;
  const qx = q(x), qz = q(z);
  return (w.biomes || []).some((b) => b.name && b.name.includes('ocean') && q(b.x) === qx && q(b.z) === qz);
}

function _v(x, y, z) { return vec3 ? vec3(x, y, z) : { x, y, z }; }

/**
 * Y a-t-il de l'EAU droit devant ? Échantillonne la surface le long du cap (mi-distance + bout),
 * dans les chunks CHARGÉS (≤24 blocs — au-delà on ne sait pas, best-effort → false). (#5)
 */
function waterAhead(bot, from, target, opts = {}) {
  if (!bot || typeof bot.blockAt !== 'function') return false;
  const dx = target.x - from.x, dz = target.z - from.z;
  const dist = Math.sqrt(dx * dx + dz * dz) || 1;
  const sampleDist = Math.min(dist, opts.sampleDist || 24);
  for (const f of [0.5, 1]) {
    const sx = Math.floor(from.x + (dx / dist) * sampleDist * f);
    const sz = Math.floor(from.z + (dz / dist) * sampleDist * f);
    // descend depuis y+8 : premier bloc de SURFACE (non-air) → eau ? terre ?
    for (let y = Math.floor(from.y) + 8; y >= Math.floor(from.y) - 20; y--) {
      const b = bot.blockAt(_v(sx, y, sz));
      if (!b) break;                                          // non chargé → pas d'info
      if (WATER.has(b.name)) return true;                     // surface = eau
      if (b.name === 'air' || b.boundingBox === 'empty') continue;
      break;                                                  // surface = solide → terre ferme
    }
  }
  return false;
}

/**
 * Tire la PROCHAINE CIBLE d'errance (#4). PUR (rng injectable), testable.
 *  pos         : position courante {x,y,z}
 *  opts.rng    : () => [0,1)            opts.lastHeading : cap précédent (biais continuation 70%)
 *  opts.sector : {index,count}|null     (cible vue depuis HOME dans le wedge)
 *  opts.memory/worldKey/localSeen      : skip cellules mappées + océans connus
 *  opts.home   : point d'ancrage        opts.maxRange : borne (déf 1024) autour de home
 *  opts.isLand : (x,z)=>bool            (échantillon terrain — eau droit devant → autre cap)
 * → {x, z, heading} | null (rien de valable → l'appelant rentre à la maison)
 */
function pickWanderTarget(pos, opts = {}) {
  const rng = opts.rng || Math.random;
  const minDist = opts.minDist || 48;
  const maxDist = opts.maxDist || 144;
  const tries = opts.tries || 14;
  const home = opts.home || pos;
  const maxRange = opts.maxRange || 1024;
  const range = (opts.sector && opts.sector.count > 1)
    ? sectorRange(opts.sector.index, opts.sector.count, opts.overlapDeg) : null;
  for (let i = 0; i < tries; i++) {
    let heading;
    if (opts.lastHeading != null && rng() < 0.7) {
      heading = opts.lastHeading + (rng() * 2 - 1) * (Math.PI / 3);   // continue ±60° (organique)
    } else {
      heading = rng() * 2 * Math.PI;                                   // grand changement de cap
    }
    const dist = minDist + rng() * (maxDist - minDist);
    const x = pos.x + dist * Math.cos(heading);
    const z = pos.z + dist * Math.sin(heading);
    const dx = x - home.x, dz = z - home.z;
    if (Math.sqrt(dx * dx + dz * dz) > maxRange) continue;             // trop loin de la maison
    if (range && !inSector(headingOf(home, { x, z }), range)) continue; // hors du wedge du mapper
    if (opts.memory && opts.worldKey && isCellMapped(opts.memory, opts.worldKey, x, z, opts.grid || GRID)) continue;
    if (opts.localSeen && opts.localSeen.has(cellKey(x, z, opts.grid || GRID))) continue;
    if (isOceanCell(opts.memory, opts.worldKey, x, z, opts.grid || GRID)) continue; // océan connu (#5)
    if (opts.isLand && !opts.isLand(x, z)) continue;                   // eau droit devant (#5)
    return { x, z, heading };
  }
  return null;
}

function _pos(bot) {
  const p = bot.entity && bot.entity.position;
  return p ? { x: p.x, y: p.y, z: p.z } : { x: 0, y: 64, z: 0 };
}

/**
 * runMapper(bot, opts, token) — errance cartographique continue. Retourne {ok:true, cancelled:true}
 * à l'annulation (seule sortie).
 *  opts.worldKey  : clé de monde (label || dimension) — obligatoire pour les events
 *  opts.memory    : mémoire bootstrap du groupe (skip cellules mappées + océans connus)
 *  opts.getSector : () => {index,count}|null — lu à chaque cible (re-balance live via stdin)
 *  opts.emit      : hook events ; opts.goto : injectable (défaut pathfinder.goto GoalNear)
 *  opts.fleeFrom  : injecté dans survivalTick ; opts.sleep/rng : injectables (tests)
 *  opts.home/maxRange/minDist/maxDist : géométrie de l'errance
 */
async function runMapper(bot, opts = {}, token = { cancelled: false }) {
  const worldKey = opts.worldKey || 'unknown';
  const emit = opts.emit || (() => {});
  const sleep = opts.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const rng = opts.rng || Math.random;
  const getSector = opts.getSector || (() => opts.sector || null);
  const memory = opts.memory || null;

  const doGoto = opts.goto || (async (wp) => {
    const { goals } = require('mineflayer-pathfinder');
    await bot.pathfinder.goto(new goals.GoalNear(wp.x, wp.y, wp.z, 8));
  });

  const localSeen = new Set();   // cellules visitées (skip planif)
  const biomeCells = new Set();  // cellules dont le biome a été émis
  const caveCells = new Set();   // cellules dont une grotte a été émise

  // Note la position courante : biome (1×/cellule) + entrée de grotte éventuelle.
  function record() {
    const p = _pos(bot);
    const ck = cellKey(p.x, p.z);
    localSeen.add(ck);
    if (!biomeCells.has(ck)) {
      biomeCells.add(ck);
      try {
        const block = bot.blockAt(bot.entity.position.floored ? bot.entity.position.floored() : bot.entity.position);
        if (block && block.biome) {
          // resolveBiome (worldMemory) : nom résolu via registry quand mineflayer ne livre que l'id
          // (live 1.21.4 : biome.name = '' — les noms alimentent l'amorce vanilla des récolteurs).
          emit(biomeSeenEvent(worldKey, { biome: resolveBiome(bot, block) }, p));
        }
      } catch (e) { /* chunk non chargé → on émettra à la prochaine cellule */ }
    }
    try {
      const cave = detectCaveEntrance(bot, p);
      if (cave.found) {
        const cck = cellKey(cave.pos.x, cave.pos.z);
        if (!caveCells.has(cck)) { caveCells.add(cck); emit(caveFoundEvent(worldKey, cave.pos)); }
      }
    } catch (e) { /* best-effort */ }
  }

  // Survie : re-tick jusqu'au calme (cap anti-blocage : on reprend la route même si ça reste chaud).
  async function settleSurvival() {
    for (let i = 0; i < SURVIVAL_CAP; i++) {
      if (token.cancelled) return;
      const action = await survivalTick(bot, { fleeFrom: opts.fleeFrom, emit });
      if (!action) return;
      await sleep(1500); // laisser l'action (fuite/combat/chasse) produire son effet
    }
  }

  const home = opts.home || _pos(bot);   // point d'ancrage (« au pire il reviendra au spawn »)
  const maxRange = opts.maxRange || 1024;
  let lastHeading = null;
  let misses = 0;                        // tirages sans cible valable d'affilée (backoff)
  record(); // la cellule de départ compte

  while (!token.cancelled) {
    // #1 : dans l'eau ? s'en extraire AVANT toute autre chose (sinon le pathfinder rame dans l'angle)
    if (isInWater(bot)) { await escapeWater(bot, { emit, sleep }); if (token.cancelled) break; }
    await settleSurvival();
    if (token.cancelled) break;

    const here = _pos(bot);
    const target = pickWanderTarget(here, {
      rng, lastHeading, sector: getSector(), memory, worldKey, localSeen,
      home, maxRange, minDist: opts.minDist, maxDist: opts.maxDist,
      isLand: (x, z) => !waterAhead(bot, here, { x, z }),
    });

    if (!target) {
      // plus rien de valable autour (tout mappé / océans) → retour maison + nouveau cap (#4 fallback)
      misses++;
      emit({ type: 'mapper_return_home', misses });
      try { await doGoto({ x: home.x, y: home.y, z: home.z }); } catch (e) { /* best-effort */ }
      lastHeading = null;                                       // repart dans une direction aléatoire
      await sleep(Math.min(misses, 6) * (opts.idleMs || 5000)); // backoff anti boucle chaude
      continue;
    }

    misses = 0;
    lastHeading = target.heading;
    try { await doGoto({ x: target.x, y: here.y, z: target.z }); } catch (e) { continue; } // inatteignable → autre cap
    record();
  }
  return { ok: true, cancelled: true };
}

module.exports = { pickWanderTarget, isOceanCell, waterAhead, cellKey, runMapper, GRID };
