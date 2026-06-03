'use strict';
// Anti-stuck EAU (#1 retours live Massii) : le bot se coince dans un angle en nageant (le pathfinder
// rame en eau). Détection (isInWater) + manœuvre d'évasion : nager vers la SURFACE (jump) puis
// rejoindre la TERRE FERME la plus proche (bloc solide, 2 airs au-dessus, hors eau). Borné dans le
// temps (jamais de boucle infinie) ; chaque goto interne est lui-même bordé.
let pfGoals; try { pfGoals = require('mineflayer-pathfinder').goals; } catch (e) { pfGoals = null; }

const WATER = new Set(['water', 'flowing_water', 'seagrass', 'tall_seagrass', 'kelp', 'kelp_plant', 'bubble_column']);

/** Le bot est-il dans l'eau ? (flag mineflayer, fallback bloc aux pieds) */
function isInWater(bot) {
  if (bot && bot.entity && bot.entity.isInWater !== undefined && bot.entity.isInWater !== null) {
    return !!bot.entity.isInWater;
  }
  try {
    const p = bot.entity.position;
    const b = bot.blockAt(p.floored ? p.floored() : p);
    return !!(b && WATER.has(b.name));
  } catch (e) { return false; }
}

/**
 * Bloc de TERRE FERME le plus proche : solide, non-eau, 2 cases d'air au-dessus (le bot peut s'y
 * tenir), pas le fond de l'océan (y pas trop sous le bot). null si rien en vue (chunks chargés only).
 */
function findLandTarget(bot, maxDistance = 48) {
  if (!bot || typeof bot.findBlocks !== 'function') return null;
  let posns = [];
  try {
    posns = bot.findBlocks({
      matching: (b) => !!(b && b.boundingBox === 'block' && !WATER.has(b.name)),
      maxDistance,
      count: 200,
    }) || [];
  } catch (e) { return null; }
  const self = bot.entity.position;
  const open = (b) => !!(b && !WATER.has(b.name) && (b.name === 'air' || b.boundingBox === 'empty'));
  let best = null, bestD = Infinity;
  for (const p of posns) {
    if (p.y < self.y - 6) continue;                       // fond marin : pas une sortie
    if (!open(bot.blockAt(p.offset(0, 1, 0)))) continue;  // case du corps
    if (!open(bot.blockAt(p.offset(0, 2, 0)))) continue;  // case de la tête
    const d = p.distanceTo(self);
    if (d < bestD) { bestD = d; best = p; }
  }
  return best;
}

function _withTimeout(promise, ms, onTimeout) {
  return new Promise((resolve) => {
    let done = false;
    const t = setTimeout(() => { if (!done) { done = true; try { onTimeout && onTimeout(); } catch (e) {} resolve(null); } }, ms);
    Promise.resolve(promise)
      .then((r) => { if (!done) { done = true; clearTimeout(t); resolve(r); } })
      .catch(() => { if (!done) { done = true; clearTimeout(t); resolve(null); } });
  });
}

/**
 * Manœuvre d'évasion : surface (jump) → terre ferme la plus proche. Bornée (timeoutMs, déf 30s).
 * Retourne {ok} (ok=true si plus dans l'eau à la fin). Injectables : sleep, emit, goto (tests).
 */
async function escapeWater(bot, opts = {}) {
  const emit = opts.emit || (() => {});
  const sleep = opts.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const timeoutMs = opts.timeoutMs || 30000;
  const t0 = Date.now();
  emit({ type: 'unstuck', cause: 'water' });
  const doGoto = opts.goto || (async (p) => {
    if (!pfGoals || !bot.pathfinder || !bot.pathfinder.goto) return;
    await bot.pathfinder.goto(new pfGoals.GoalNear(p.x, p.y + 1, p.z, 1));
  });
  try { bot.setControlState('jump', true); } catch (e) {}   // nage vers la surface
  while (isInWater(bot) && Date.now() - t0 < timeoutMs) {
    const land = findLandTarget(bot, opts.maxDistance || 48);
    if (land) {
      await _withTimeout(doGoto(land), opts.gotoTimeoutMs || 15000, () => {
        try { bot.pathfinder && bot.pathfinder.setGoal(null); } catch (e) {}
      });
    } else {
      // pas de terre en vue (chunks) : nage vers l'avant en sautant pour sortir de l'angle
      try { bot.setControlState('forward', true); } catch (e) {}
      await sleep(1500);
      try { bot.setControlState('forward', false); } catch (e) {}
    }
    await sleep(300);
  }
  try { bot.setControlState('jump', false); bot.setControlState('forward', false); } catch (e) {}
  const ok = !isInWater(bot);
  emit({ type: 'unstuck_done', cause: 'water', ok });
  return { ok };
}

module.exports = { isInWater, findLandTarget, escapeWater, WATER };
