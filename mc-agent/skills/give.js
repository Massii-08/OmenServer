'use strict';
// `give <objet>` (tout d'un type) / `give all` (tout l'inventaire) : jette vers le joueur.

function _match(bot, name) {
  const n = String(name || '').toLowerCase();
  return ((bot.inventory && bot.inventory.items()) || []).filter((it) => it && it.name && (it.name === n || it.name.includes(n)));
}

async function _faceAndToss(bot, sender, item) {
  try {
    const ent = sender && bot.players[sender] && bot.players[sender].entity;
    if (ent && ent.position && bot.lookAt) await bot.lookAt(ent.position);
  } catch (e) {}
  await bot.tossStack(item);
}

async function giveItem(bot, { name } = {}, sender = null) {
  const items = _match(bot, name);
  if (!items.length) return { ok: false, reason: 'no_item' };
  for (const it of items) { try { await _faceAndToss(bot, sender, it); } catch (e) {} }
  return { ok: true, count: items.length };
}

async function giveAll(bot, _args = {}, sender = null) {
  const items = (bot.inventory && bot.inventory.items()) || [];
  if (!items.length) return { ok: false, reason: 'empty' };
  for (const it of items) { try { await _faceAndToss(bot, sender, it); } catch (e) {} }
  return { ok: true, count: items.length };
}

module.exports = { giveItem, giveAll, _match };
