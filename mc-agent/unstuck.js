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
  const timeoutMs = opts.timeoutMs || 60000;  // 60s : traverser un plan d'eau prend du temps (Surv7)
  const t0 = Date.now();
  emit({ type: 'unstuck', cause: 'water' });
  const doGoto = opts.goto || (async (p) => {
    if (!pfGoals || !bot.pathfinder || !bot.pathfinder.goto) return;
    await bot.pathfinder.goto(new pfGoals.GoalNear(p.x, p.y + 1, p.z, 1));
  });
  try { bot.setControlState('jump', true); } catch (e) {}   // nage vers la surface
  // cap de nage FIXE quand aucune terre n'est en vue (vécu Surv7 : fond d'un trou inondé, 25 échecs
  // en re-scannant sur place) — on nage AVEC PERSISTANCE dans une direction en re-scannant la terre.
  let swimYaw = null;
  while (isInWater(bot) && Date.now() - t0 < timeoutMs) {
    const land = findLandTarget(bot, opts.maxDistance || 48);
    if (land) {
      await _withTimeout(doGoto(land), opts.gotoTimeoutMs || 15000, () => {
        try { bot.pathfinder && bot.pathfinder.setGoal(null); } catch (e) {}
      });
    } else {
      // pas de terre en vue : nage persistante au cap fixe (jump maintenu = surface), 3s par segment
      if (swimYaw == null) swimYaw = (bot.entity && bot.entity.yaw) || 0;
      try { if (bot.look) await bot.look(swimYaw, 0, true); } catch (e) {}
      try { bot.setControlState('forward', true); } catch (e) {}
      await sleep(3000);
      try { bot.setControlState('forward', false); } catch (e) {}
    }
    await sleep(300);
  }
  try { bot.setControlState('jump', false); bot.setControlState('forward', false); } catch (e) {}
  const ok = !isInWater(bot);
  emit({ type: 'unstuck_done', cause: 'water', ok });
  return { ok };
}

// --- #9 retours live : LIANES & pièges traversables (le pathfinder s'y accroche) -----------------
// Blocs-pièges cassables à mains nues (instantané ou quasi) : on les dégage au lieu de pousser dessus.
const SNARES = new Set([
  'vine', 'cave_vines', 'cave_vines_plant', 'twisting_vines', 'twisting_vines_plant',
  'weeping_vines', 'weeping_vines_plant', 'glow_lichen', 'cobweb', 'sweet_berry_bush',
]);

/**
 * Casse les lianes/toiles ADJACENTES (pieds, tête, 4 voisins × 2 niveaux). Best-effort, rapide,
 * no-op si rien. Retourne le nb de blocs dégagés.
 */
async function clearSnares(bot) {
  if (!bot || typeof bot.blockAt !== 'function' || typeof bot.dig !== 'function') return 0;
  const p = bot.entity && bot.entity.position;
  if (!p) return 0;
  const feet = p.floored ? p.floored() : { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) };
  const at = (dx, dy, dz) => (feet.offset ? feet.offset(dx, dy, dz) : { x: feet.x + dx, y: feet.y + dy, z: feet.z + dz });
  const cells = [at(0, 0, 0), at(0, 1, 0)];
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    cells.push(at(dx, 0, dz), at(dx, 1, dz));
  }
  let cleared = 0;
  for (const c of cells) {
    try {
      const b = bot.blockAt(c);
      if (b && SNARES.has(b.name)) { await bot.dig(b); cleared++; }
    } catch (e) { /* best-effort */ }
  }
  return cleared;
}

// --- #8 retours live : FLOTTANT/SUSPENDU hors saut = état physiquement implausible ----------------

/**
 * PUR : le bot est-il « coincé en l'air » ? (pas au sol, pas dans l'eau, position horizontale
 * quasi inchangée entre 2 échantillons espacés d'au moins minMs). samples = {x,z,t}.
 */
function isFloatingStuck(prev, cur, { onGround, inWater, minMs = 1500, eps = 0.35 } = {}) {
  if (onGround || inWater || !prev || !cur) return false;
  if (cur.t - prev.t < minMs) return false;
  const d = Math.sqrt((cur.x - prev.x) ** 2 + (cur.z - prev.z) ** 2);
  return d < eps;
}

/**
 * Recovery #8 : RELÂCHER TOUT (clearControlStates), couper le pathfinder, laisser retomber au sol.
 * Borné. Retourne {ok} (ok = au sol à la fin).
 */
async function recoverFloating(bot, opts = {}) {
  const emit = opts.emit || (() => {});
  const sleep = opts.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  emit({ type: 'unstuck', cause: 'floating' });
  try {
    if (typeof bot.clearControlStates === 'function') bot.clearControlStates();
    else ['forward', 'back', 'left', 'right', 'jump', 'sneak'].forEach((c) => { try { bot.setControlState(c, false); } catch (e) {} });
  } catch (e) {}
  try { bot.pathfinder && bot.pathfinder.setGoal(null); } catch (e) {}
  await clearSnares(bot);                               // souvent la cause : lianes/toile (#9)
  const t0 = Date.now();
  const timeoutMs = opts.timeoutMs || 4000;
  while (!(bot.entity && bot.entity.onGround) && Date.now() - t0 < timeoutMs) {
    await sleep(200);
  }
  const ok = !!(bot.entity && bot.entity.onGround);
  emit({ type: 'unstuck_done', cause: 'floating', ok });
  return { ok };
}

module.exports = { isInWater, findLandTarget, escapeWater, WATER, SNARES, clearSnares, isFloatingStuck, recoverFloating };
