'use strict';
// Montée en PILIER (#7 retours live Massii) — la technique humaine du pillaring :
//  1. regarder vers le bas ; 2. sauter ; 3. attendre l'APEX du saut (velocity.y repasse ≈ 0) ;
//  4. À CET INSTANT poser le bloc contre la FACE SUPÉRIEURE du bloc sous les pieds ; 5. retomber dessus.
// Pas avant l'apex (collision), pas après (on retombe). Retry si la pose rate.
// Garde-fou #6 : JAMAIS de pose sans bloc de référence PLEIN réel (le bloc sous les pieds).
const { Vec3 } = require('vec3');

// Blocs sacrifiables pour le pilier (mêmes familles que le remblai de placeBlockNear).
const SCAFFOLD = [
  'cobblestone', 'dirt', 'cobbled_deepslate', 'netherrack', 'stone',
  'granite', 'diorite', 'andesite', 'tuff', 'coarse_dirt', 'grass_block',
];

/**
 * Attend l'APEX du saut : velocity.y monte (>0.1) puis retombe sous epsilon (≤0.05). Borné.
 * Injectables : sleep (tests). Retourne true à l'apex, false au timeout.
 */
async function waitForApex(bot, opts = {}) {
  const timeoutMs = opts.timeoutMs || 1500;
  const pollMs = opts.pollMs || 20;
  const sleep = opts.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const t0 = Date.now();
  let rising = false;
  while (Date.now() - t0 < timeoutMs) {
    const vy = (bot.entity && bot.entity.velocity && bot.entity.velocity.y) || 0;
    if (vy > 0.1) rising = true;
    else if (rising && vy <= 0.05) return true;   // sommet du saut : c'est MAINTENANT qu'on pose
    await sleep(pollMs);
  }
  return false;
}

/**
 * pillarUp(bot, {height}, token) → {ok, placed, reason?}
 * Monte de `height` blocs en pilier (saut + pose à l'apex). S'arrête proprement si plus de blocs,
 * plus de support plein sous les pieds (#6), ou pose impossible après retry.
 */
async function pillarUp(bot, { height = 1 } = {}, token = null, opts = {}) {
  const sleep = opts.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  // Massii D (pathfinder #54) : poser sous soi en NAGEANT est foireux → refuser, sortir de l'eau d'abord.
  try {
    const feet0 = bot.entity.position.floored ? bot.entity.position.floored() : bot.entity.position;
    const b0 = bot.blockAt(feet0);
    if (b0 && (b0.name === 'water' || b0.name === 'flowing_water')) return { ok: false, placed: 0, reason: 'in_water' };
  } catch (e) {}
  let placed = 0;
  for (let i = 0; i < height; i++) {
    if (token && token.cancelled) return { ok: placed > 0, placed, cancelled: true };
    const item = bot.inventory.items().find((it) => SCAFFOLD.includes(it.name));
    if (!item) return { ok: placed > 0, placed, reason: 'no_blocks' };

    const feet = bot.entity.position.floored ? bot.entity.position.floored() : bot.entity.position;
    const below = bot.blockAt(feet.offset ? feet.offset(0, -1, 0) : { x: feet.x, y: feet.y - 1, z: feet.z });
    if (!below || below.boundingBox !== 'block') return { ok: placed > 0, placed, reason: 'no_support' }; // #6

    try { if (bot.lookAt && below.position) await bot.lookAt(below.position, true); } catch (e) {} // regarder en bas
    try { await bot.equip(item, 'hand'); } catch (e) { return { ok: placed > 0, placed, reason: 'equip_failed' }; }

    let success = false;
    try { bot.setControlState('sneak', true); } catch (e) {}  // Massii D2 : anti-glissade hors du bord
    for (let attempt = 0; attempt < 2 && !success; attempt++) {
      try { bot.setControlState('jump', true); } catch (e) {}
      const apex = await waitForApex(bot, { sleep, timeoutMs: opts.apexTimeoutMs || 1500, pollMs: opts.pollMs });
      try { bot.setControlState('jump', false); } catch (e) {}
      if (!apex) continue;                                   // saut raté → retente
      try {
        await bot.placeBlock(below, new Vec3(0, 1, 0));      // face SUPÉRIEURE du bloc sous les pieds
        const b = bot.blockAt(feet);                         // le bloc posé occupe l'ancienne case des pieds
        success = !!(b && b.boundingBox === 'block');        // #6 : pose confirmée, pas de ghost
      } catch (e) { /* pose ratée (timing) → retry */ }
      if (!success) await sleep(250);                        // retomber avant de retenter
    }
    try { bot.setControlState('sneak', false); } catch (e) {}
    if (!success) return { ok: placed > 0, placed, reason: 'place_failed' };
    placed++;
  }
  return { ok: true, placed };
}

module.exports = { pillarUp, waitForApex, SCAFFOLD };
