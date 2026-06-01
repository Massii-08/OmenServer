'use strict';
// `mine down <n>` : creuse le bloc sous les pieds n fois, outil auto, garde-fou lave/vide.
const { bestToolFor } = require('../tools');
const DANGER = new Set(['lava', 'flowing_lava', 'water', 'flowing_water']);
const VOID = new Set(['air', 'cave_air', 'void_air']);

async function mineDown(bot, { count = 1 } = {}, token = null) {
  let dug = 0;
  for (let i = 0; i < count; i++) {
    if (token && token.cancelled) return { ok: true, dug, cancelled: true };
    const pos = bot.entity && bot.entity.position;
    if (!pos) return { ok: false, reason: 'no_pos' };
    const below = bot.blockAt(pos.offset(0, -1, 0));
    if (!below || VOID.has(below.name)) return dug > 0 ? { ok: false, dug, reason: 'void_below' } : { ok: false, reason: 'void_below' };
    if (DANGER.has(below.name)) return dug > 0 ? { ok: false, dug, reason: 'danger_below' } : { ok: false, reason: 'danger_below' };
    const below2 = bot.blockAt(pos.offset(0, -2, 0));
    if (below2 && DANGER.has(below2.name)) return dug > 0 ? { ok: false, dug, reason: 'danger_below' } : { ok: false, reason: 'danger_below' };
    const tool = bestToolFor(bot, below);
    if (tool) { try { await bot.equip(tool, 'hand'); } catch (e) {} }
    try { await bot.dig(below); dug++; }
    catch (e) { return { ok: dug > 0, dug, reason: 'dig_failed' }; }
  }
  return { ok: true, dug };
}

module.exports = { mineDown, DANGER, VOID };
