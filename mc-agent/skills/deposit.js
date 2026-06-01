'use strict';
// `deposit` : dépose tout l'inventaire dans le coffre/baril le + proche.

function _nearestChest(bot) {
  const reg = bot.registry && bot.registry.blocksByName;
  const ids = ['chest', 'trapped_chest', 'barrel'].map((n) => reg && reg[n] && reg[n].id).filter((x) => x != null);
  if (!ids.length) return null;
  return bot.findBlock({ matching: ids, maxDistance: 12 }) || null;
}

async function deposit(bot) {
  const block = _nearestChest(bot);
  if (!block) return { ok: false, reason: 'no_chest' };
  let chest;
  try { chest = await bot.openContainer(block); }
  catch (e) { return { ok: false, reason: 'open_failed' }; }
  const items = (bot.inventory && bot.inventory.items()) || [];
  let n = 0;
  for (const it of items) { try { await chest.deposit(it.type, null, it.count); n++; } catch (e) {} }
  try { chest.close(); } catch (e) {}
  return { ok: true, count: n };
}

module.exports = { deposit, _nearestChest };
