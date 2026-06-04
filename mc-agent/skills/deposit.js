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

/**
 * Dépôt SÉLECTIF (marathon) : `only` = items déposés en entier (valuables) ; `surplus` =
 * {name: gardés} → dépose seulement l'excédent. Tout le reste (outils, torches, food, réserves)
 * reste en poche. Lit le contenu du coffre après dépôt → source de vérité pour world.banked.
 */
async function depositFiltered(bot, { only = [], surplus = {} } = {}) {
  const block = _nearestChest(bot);
  if (!block) return { ok: false, reason: 'no_chest' };
  let chest;
  try { chest = await bot.openContainer(block); }
  catch (e) { return { ok: false, reason: 'open_failed' }; }
  const deposited = {};
  const byName = {};
  for (const it of (bot.inventory && bot.inventory.items()) || []) {
    (byName[it.name] = byName[it.name] || []).push(it);
  }
  for (const [name, piles] of Object.entries(byName)) {
    const total = piles.reduce((s, i) => s + i.count, 0);
    let toDrop = 0;
    if (only.includes(name)) toDrop = total;
    else if (surplus[name] !== undefined) toDrop = Math.max(0, total - surplus[name]);
    if (!toDrop) continue;
    try { await chest.deposit(piles[0].type, null, toDrop); deposited[name] = toDrop; }
    catch (e) { /* coffre plein pour cet item → on garde en poche, pas grave */ }
  }
  const contents = {};
  try {
    for (const it of (chest.containerItems ? chest.containerItems() : [])) {
      contents[it.name] = (contents[it.name] || 0) + it.count;
    }
  } catch (e) {}
  try { chest.close(); } catch (e) {}
  return { ok: true, deposited, chest: contents };
}

module.exports = { deposit, depositFiltered, _nearestChest };

