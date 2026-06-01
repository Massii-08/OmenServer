'use strict';
// `equip <objet>` : équipe un item précis (slot auto). `eat` : mange maintenant (même rassasié pas plein).
const { FOODS } = require('../reflexes');

const ARMOR = { helmet: 'head', chestplate: 'torso', leggings: 'legs', boots: 'feet' };

function _destFor(name) {
  const n = String(name || '');
  for (const k of Object.keys(ARMOR)) if (n.endsWith('_' + k) || n === k) return ARMOR[k];
  if (n === 'shield') return 'off-hand';
  return 'hand';
}

function _find(bot, name) {
  const n = String(name || '').toLowerCase();
  return ((bot.inventory && bot.inventory.items()) || []).find((it) => it && it.name && (it.name === n || it.name.includes(n)));
}

async function equipItem(bot, { name } = {}) {
  const it = _find(bot, name);
  if (!it) return { ok: false, reason: 'no_item' };
  try { await bot.equip(it, _destFor(it.name)); } catch (e) { return { ok: false, reason: 'equip_failed' }; }
  return { ok: true };
}

async function eat(bot) {
  if (bot.food != null && bot.food >= 20) return { ok: false, reason: 'full' };
  const food = ((bot.inventory && bot.inventory.items()) || []).find((it) => it && FOODS.has(it.name));
  if (!food) return { ok: false, reason: 'no_food' };
  try { await bot.equip(food, 'hand'); await bot.consume(); }
  catch (e) { return { ok: false, reason: 'eat_failed' }; }
  return { ok: true };
}

module.exports = { equipItem, eat, _destFor };
