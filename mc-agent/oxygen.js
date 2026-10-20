'use strict';
// Garde d'oxygène : mineflayer (entities.js, handler entity_metadata) écrit bot.oxygenLevel pour
// N'IMPORTE QUELLE entité portant air_supply (zombie qui se noie, poisson…) et émet 'breath'.
// reflexes.js croit alors le bot en train de se noyer. On ne garde que l'air du bot lui-même.

const DEFAULT_AIR_KEY = 1;

// Air du bot (0..20) lu dans un paquet entity_metadata, ou null si le paquet ne le concerne pas.
function selfAirFromMetadata(packet, selfId, airKeyIndex) {
  if (!packet || selfId == null || packet.entityId !== selfId) return null;
  const list = Array.isArray(packet.metadata) ? packet.metadata : [];
  const key = airKeyIndex == null ? DEFAULT_AIR_KEY : airKeyIndex;
  for (const m of list) {
    if (m && m.key === key && typeof m.value === 'number') return Math.round(m.value / 15);
  }
  return null;
}

function resolveAirKey(bot) {
  try {
    const keys = bot.registry.entitiesByName.player.metadataKeys;
    const i = keys.indexOf('air_supply');
    if (i >= 0) return i;
  } catch (e) { /* registre pas prêt */ }
  return DEFAULT_AIR_KEY;
}

// opts.onForeign : appelé quand un paquet d'une AUTRE entité porte air_supply (écriture ignorée).
function installOxygenGuard(bot, opts = {}) {
  const onForeign = opts.onForeign || (() => {});
  bot._selfO2 = 20;
  let airKey = null;
  Object.defineProperty(bot, 'oxygenLevel', {
    configurable: true,
    enumerable: true,
    get() { return bot._selfO2; },
    set() { /* écriture de mineflayer ignorée : seule l'air du bot compte (voir listener) */ },
  });
  const client = bot._client;
  if (!client) return;
  const handler = (p) => {
    if (airKey == null) airKey = resolveAirKey(bot);
    const selfId = bot.entity && bot.entity.id;
    const v = selfAirFromMetadata(p, selfId, airKey);
    if (v != null) { bot._selfO2 = v; return; }
    if (p && Array.isArray(p.metadata) && p.metadata.some((m) => m && m.key === airKey)) onForeign(p.entityId);
  };
  if (typeof client.prependListener === 'function') client.prependListener('entity_metadata', handler);
  else client.on('entity_metadata', handler);
}

module.exports = { selfAirFromMetadata, installOxygenGuard, resolveAirKey };
