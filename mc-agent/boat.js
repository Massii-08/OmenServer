'use strict';
// Traversée d'océan en bateau (phase mappeur terre-only). Décisions PURES (testables sans client
// MC) + actions bot best-effort. Le bateau ne sert QU'À traverser l'eau vers la terre neuve —
// jamais à cartographier l'océan.
const { sectorRange, inSector } = require('./sectors');

const TAU = Math.PI * 2;
const _norm = (a) => ((a % TAU) + TAU) % TAU;

const WATER_NAMES = new Set(['water', 'flowing_water', 'seagrass', 'tall_seagrass', 'kelp', 'kelp_plant', 'bubble_column']);

/** Cap vers le LARGE : à l'opposé du centroïde mappé, contraint au wedge du secteur (fan-out). PUR. */
function outwardHeading(fromPos, centroid, sector, rng) {
  const r = rng || Math.random;
  const dx = fromPos.x - centroid.x, dz = fromPos.z - centroid.z;
  let base = (Math.abs(dx) < 1e-6 && Math.abs(dz) < 1e-6) ? r() * TAU : Math.atan2(dz, dx);
  if (sector && sector.count > 1) {
    const range = sectorRange(sector.index, sector.count, sector.overlapDeg || 15);
    if (!range.full && !inSector(base, range)) {
      const width = _norm(range.end - range.start) || TAU;
      base = range.start + r() * width;
    }
  }
  return _norm(base);
}

/**
 * Terre devant au cap ? Échantillonne le sol le long du heading (colonnes espacées de `step`
 * jusqu'à `reach`) via `sampleBlock(x,y,z)` injecté (block-like {name,boundingBox} | null).
 * → { found:true, pos } sur le 1er sol SOLIDE non-eau ; sinon { found:false }. PUR.
 */
function landAhead(sampleBlock, fromPos, headingYaw, opts = {}) {
  const reach = opts.reach || 40;
  const step = opts.step || 4;
  const seaY = Math.floor(fromPos.y);
  for (let d = step; d <= reach; d += step) {
    const x = Math.floor(fromPos.x + Math.cos(headingYaw) * d);
    const z = Math.floor(fromPos.z + Math.sin(headingYaw) * d);
    for (let y = seaY + 4; y >= seaY - 4; y--) {
      const b = sampleBlock(x, y, z);
      if (!b) break;                                   // non chargé → colonne suivante
      if (WATER_NAMES.has(b.name)) break;              // eau en surface → pas de terre ici
      if (b.name === 'air' || b.boundingBox === 'empty') continue;
      return { found: true, pos: { x, y, z } };        // solide non-eau → côte
    }
  }
  return { found: false };
}

/**
 * Première EAU de surface le long du cap (colonne d'eau au niveau de la mer) — pour marcher
 * jusqu'à la côte et y poser le bateau. sampleBlock injecté. → { found, pos } | { found:false }. PUR.
 */
function waterEdgeAlong(sampleBlock, fromPos, headingYaw, opts = {}) {
  const reach = opts.reach || 48;
  const step = opts.step || 2;
  const seaY = Math.floor(fromPos.y);
  for (let d = step; d <= reach; d += step) {
    const x = Math.floor(fromPos.x + Math.cos(headingYaw) * d);
    const z = Math.floor(fromPos.z + Math.sin(headingYaw) * d);
    for (let y = seaY + 4; y >= seaY - 6; y--) {
      const b = sampleBlock(x, y, z);
      if (!b) break;                                   // non chargé → colonne suivante
      if (WATER_NAMES.has(b.name)) return { found: true, pos: { x, y, z } };  // AVANT le check empty (l'eau est « empty »)
      if (b.name === 'air' || b.boundingBox === 'empty') continue;
      break;                                           // solide → pas encore l'eau, colonne suivante
    }
  }
  return { found: false };
}

/** Bateau coincé : ~0 déplacement horizontal pendant ≥ stuckMs. PUR. */
function boatStuck(prevPos, curPos, dtMs, opts = {}) {
  const minMove = opts.minMove != null ? opts.minMove : 2;
  const stuckMs = opts.stuckMs != null ? opts.stuckMs : 12000;
  if (dtMs < stuckMs) return false;
  return Math.hypot(curPos.x - prevPos.x, curPos.z - prevPos.z) < minMove;
}

/** Garantit un bateau en poche : sinon crafte celui de l'essence de bois dispo. best-effort. */
async function ensureBoat(bot, opts = {}) {
  const craft = opts.craft;
  const items = (bot.inventory && bot.inventory.items()) || [];
  const has = items.find((i) => /_boat$/.test(i.name));
  if (has) return { ok: true, name: has.name };
  if (!craft) return { ok: false, reason: 'no_craft' };
  const wood = items.find((i) => /_(log|planks)$/.test(i.name));
  const kind = wood ? wood.name.replace(/_(log|planks)$/, '') : 'oak';
  const name = kind + '_boat';
  try {
    const r = await craft({ name, count: 1 });
    return { ok: !!(r && r.ok), name };
  } catch (e) { return { ok: false, reason: 'craft_error' }; }
}

const _bpos = (bot) => {
  const p = bot.entity && bot.entity.position;
  return p ? { x: p.x, y: p.y, z: p.z } : { x: 0, y: 64, z: 0 };
};

/**
 * Navigue au cap `headingYaw` (bot supposé déjà embarqué) jusqu'à détecter la terre devant
 * (`landAhead`) OU coincement OU timeout, puis débarque. `sampleBlock`/`now`/`sleep` injectables.
 * → { landed:boolean, reason }. Relâche TOUJOURS les contrôles + dismount en sortie.
 */
async function sailToLand(bot, headingYaw, opts = {}) {
  const now = opts.now || Date.now;
  const sleep = opts.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const sampleBlock = opts.sampleBlock || ((x, y, z) => bot.blockAt({ x, y, z }));
  const tickMs = opts.tickMs != null ? opts.tickMs : 500;
  const timeoutMs = opts.timeoutMs != null ? opts.timeoutMs : 90000;
  const t0 = now();
  let prev = _bpos(bot), prevT = t0;
  let landed = false, reason = 'timeout';
  // Anti « atterrissage sur sa propre côte » (vécu live 2026-07-15, boat-spam ×66) : on n'accepte
  // un débarquement qu'APRÈS être passé au-dessus de l'eau (embarqué OU en nage).
  let overWater = false;
  try {
    while (now() - t0 < timeoutMs) {
      try { await bot.look(headingYaw, 0, true); } catch (e) {}
      bot.setControlState('forward', true);
      const here = _bpos(bot);
      if (!overWater) {
        const under = sampleBlock(Math.floor(here.x), Math.floor(here.y) - 1, Math.floor(here.z));
        if (bot.vehicle || (under && WATER_NAMES.has(under.name))) overWater = true;
      }
      if (!bot.vehicle && overWater) bot.setControlState('jump', true);   // nage : rester en surface
      const ahead = landAhead(sampleBlock, here, headingYaw, opts);
      if (overWater && ahead.found) { landed = true; reason = 'land'; break; }
      const t = now();
      if (boatStuck(prev, here, t - prevT, opts)) { reason = 'stuck'; break; }
      if (t - prevT >= (opts.sampleEvery || 3000)) { prev = here; prevT = t; }
      await sleep(tickMs);
    }
  } finally {
    try { bot.clearControlStates(); } catch (e) {}
    // dismount UNIQUEMENT si réellement embarqué (sinon mineflayer émet un 'error' « not mounted »
    // à chaque tour → bruit d'events, vécu live 2026-07-15).
    try { if (bot.vehicle) await bot.dismount(); } catch (e) {}
  }
  return { landed, reason };
}

module.exports = { outwardHeading, landAhead, waterEdgeAlong, boatStuck, ensureBoat, sailToLand, WATER_NAMES };
