'use strict';
// Boucle de cartographie du bot « cartographe » (1b, 0 LLM). Exploration CONTINUE en anneaux
// (réutilise la géométrie d'explore, SANS « trouvé→stop ») :
//  - à chaque waypoint : lit le biome → émet biome_seen ; détecte une entrée de grotte (caves.js)
//    → émet cave_found ; dédup locale par cellule 128 (le store backend dédup aussi, ceinture+bretelles) ;
//  - secteur multi-mappers (sectors.js) lu LIVE via getSector (re-balance stdin du manager) ;
//  - skip des cellules déjà mappées (mémoire bootstrap du groupe + cellules locales) ;
//  - survie « basique + » (survival.js) re-tickée avant chaque déplacement, avec cap anti-blocage ;
//  - la frontière AVANCE : après chaque batch visité, re-origine sur la position courante (les
//    cellules vues sont skippées → le mapper pousse naturellement vers l'inconnu).
// Ne retourne JAMAIS sauf annulation du token (c'est un rôle, pas une tâche finie).
const { nextWaypoints } = require('./skills/explore');
const { sectorRange, filterToSector, skipMapped } = require('./sectors');
const { detectCaveEntrance } = require('./caves');
const { biomeSeenEvent, caveFoundEvent } = require('./worldMemory');
const { survivalTick } = require('./survival');

const GRID = 128;          // même grille que le store backend (quantif/dédup)
const SURVIVAL_CAP = 10;   // re-ticks survie max avant de reprendre la route (anti-blocage)

/** Clé de cellule quantifiée (grille 128, floor — cohérent côté négatif). */
function cellKey(x, z, grid = GRID) {
  return Math.floor(x / grid) * grid + ',' + Math.floor(z / grid) * grid;
}

/**
 * Waypoints d'un batch d'anneaux [fromRadius..toRadius] autour d'origin (PUR, testable) :
 * anneaux d'explore → filtre secteur (si mapper sectorisé) → skip cellules mémoire + locales.
 */
function planBatch(origin, opts = {}) {
  const step = opts.step || 80;
  const from = opts.fromRadius || 0;
  const to = opts.toRadius || 256;
  const grid = opts.grid || GRID;
  let wps = nextWaypoints(origin, { step, maxRadius: to }).filter((w) => w.r > from + 1e-9);
  if (opts.sector && opts.sector.count > 1) {
    wps = filterToSector(wps, origin, sectorRange(opts.sector.index, opts.sector.count, opts.overlapDeg));
  }
  if (opts.memory && opts.worldKey) wps = skipMapped(wps, opts.memory, opts.worldKey, grid);
  if (opts.localSeen) wps = wps.filter((w) => !opts.localSeen.has(cellKey(w.x, w.z, grid)));
  return wps;
}

function _pos(bot) {
  const p = bot.entity && bot.entity.position;
  return p ? { x: p.x, y: p.y, z: p.z } : { x: 0, y: 64, z: 0 };
}

/**
 * runMapper(bot, opts, token) — boucle de cartographie continue. Retourne {ok:true, cancelled:true}
 * à l'annulation (seule sortie).
 *  opts.worldKey  : clé de monde (label || dimension) — obligatoire pour les events
 *  opts.memory    : mémoire bootstrap du groupe (skip des cellules déjà mappées)
 *  opts.getSector : () => {index,count}|null — lu à chaque batch (re-balance live via stdin)
 *  opts.emit      : hook events ; opts.goto : injectable (défaut pathfinder.goto GoalNear)
 *  opts.fleeFrom  : injecté dans survivalTick ; opts.sleep : injectable (tests)
 *  opts.step/batchRadius/maxLookahead : géométrie (déf 80 / 256 / 2048)
 */
async function runMapper(bot, opts = {}, token = { cancelled: false }) {
  const worldKey = opts.worldKey || 'unknown';
  const emit = opts.emit || (() => {});
  const sleep = opts.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const step = opts.step || 80;
  const batchRadius = opts.batchRadius || 256;
  const maxLookahead = opts.maxLookahead || 2048; // au-delà : pause + re-origine (terrain peut changer)
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
        if (block && block.biome) emit(biomeSeenEvent(worldKey, block, p));
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

  let origin = _pos(bot);
  let from = 0;
  record(); // la cellule de départ compte

  while (!token.cancelled) {
    const wps = planBatch(origin, {
      step, fromRadius: from, toRadius: from + batchRadius,
      sector: getSector(), memory, worldKey, localSeen,
    });

    if (!wps.length) {
      // tout le batch est déjà mappé → regarder plus loin ; au-delà du lookahead, pause + re-origine
      from += batchRadius;
      if (from >= maxLookahead) {
        emit({ type: 'mapper_idle', lookahead: from });
        await sleep(opts.idleMs || 30000);
        origin = _pos(bot); from = 0;
      }
      continue;
    }

    let visited = 0;
    for (const wp of wps) {
      if (token.cancelled) break;
      await settleSurvival();
      if (token.cancelled) break;
      try { await doGoto(wp); } catch (e) { continue; } // waypoint inatteignable → suivant
      record();
      visited++;
    }
    if (token.cancelled) break;

    if (visited > 0) { origin = _pos(bot); from = 0; }  // la frontière avance
    else { from += batchRadius; }                        // rien d'atteignable → plus loin
  }
  return { ok: true, cancelled: true };
}

module.exports = { planBatch, cellKey, runMapper, GRID };
