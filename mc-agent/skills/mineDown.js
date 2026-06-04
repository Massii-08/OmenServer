'use strict';
// `mine down <n>` : creuse le bloc sous les pieds n fois, outil auto, garde-fou lave/vide.
// P6 (Marathon run#6, piège #41 enfin fixé) : un bot à position FRACTIONNAIRE (à cheval sur une
// arête, ex. y=53.75) creuse sous lui mais NE TOMBE PAS (supporté par le bloc voisin) → void_below
// au tour suivant. Fix : (a) se CENTRER sur le bloc via pathfinder GoalBlock avant chaque dig ;
// (b) attendre la CHUTE après le dig avant l'itération suivante. Les deux ne s'activent que si
// bot.pathfinder existe (les fake-bots des tests historiques n'en ont pas → comportement inchangé).
const { bestToolFor } = require('../tools');
const DANGER = new Set(['lava', 'flowing_lava', 'water', 'flowing_water']);
const VOID = new Set(['air', 'cave_air', 'void_air']);

let goals;
try { goals = require('mineflayer-pathfinder').goals; } catch (e) { goals = null; }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Recentre le bot sur la colonne de son bloc (anti-arête). Borné, best-effort.
async function centerOnBlock(bot) {
  if (!bot.pathfinder || !bot.pathfinder.goto) return;
  const p = bot.entity.position;
  if (typeof p.x !== 'number') return;
  const cx = Math.floor(p.x) + 0.5;
  const cz = Math.floor(p.z) + 0.5;
  if (Math.abs(p.x - cx) <= 0.25 && Math.abs(p.z - cz) <= 0.25) return;
  const goal = goals && goals.GoalBlock
    ? new goals.GoalBlock(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z))
    : { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) };
  try {
    await Promise.race([
      bot.pathfinder.goto(goal),
      new Promise((_, rej) => setTimeout(() => rej(new Error('center_timeout')), 8000)),
    ]);
  } catch (e) { /* best-effort */ }
}

// Attend que la gravité fasse tomber le bot sous fromY (max ms). true si descendu.
async function waitFall(bot, fromY, ms = 2500) {
  if (!bot.pathfinder) return false; // fake-bots tests : pas de physique simulée
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const p = bot.entity.position;
    if (typeof p.y === 'number' && Math.floor(p.y) < fromY) return true;
    await sleep(100);
  }
  return false;
}

async function mineDown(bot, { count, depth } = {}, token = null) {
  // `depth` accepté comme alias (P6a : 3 call-sites passaient depth → 1 seul bloc creusé)
  const total = count !== undefined ? count : (depth !== undefined ? depth : 1);
  let dug = 0;
  for (let i = 0; i < total; i++) {
    if (token && token.cancelled) return { ok: true, dug, cancelled: true };
    await centerOnBlock(bot);
    const pos = bot.entity && bot.entity.position;
    if (!pos) return { ok: false, reason: 'no_pos' };
    const fy = typeof pos.y === 'number' ? Math.floor(pos.y) : null;
    const below = bot.blockAt(pos.offset(0, -1, 0));
    if (!below || VOID.has(below.name)) {
      // peut-être notre propre trou (dig précédent sans chute) : maintenant centré → on tombe ?
      if (fy !== null && await waitFall(bot, fy, 1500)) continue;
      return dug > 0 ? { ok: false, dug, reason: 'void_below' } : { ok: false, reason: 'void_below' };
    }
    if (DANGER.has(below.name)) return dug > 0 ? { ok: false, dug, reason: 'danger_below' } : { ok: false, reason: 'danger_below' };
    const below2 = bot.blockAt(pos.offset(0, -2, 0));
    if (below2 && DANGER.has(below2.name)) return dug > 0 ? { ok: false, dug, reason: 'danger_below' } : { ok: false, reason: 'danger_below' };
    const tool = bestToolFor(bot, below);
    if (tool) { try { await bot.equip(tool, 'hand'); } catch (e) {} }
    try { await bot.dig(below); dug++; }
    catch (e) { return { ok: dug > 0, dug, reason: 'dig_failed' }; }
    if (fy !== null) await waitFall(bot, fy); // laisser la gravité agir avant le palier suivant
  }
  return { ok: true, dug };
}

module.exports = { mineDown, DANGER, VOID };
