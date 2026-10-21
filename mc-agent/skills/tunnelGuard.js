'use strict';
// Exécute la décision de tunnelDefense.js sur le vrai bot (cf. l'analyse en tête de ce module).
//
// `tunnelFlee(bot, deps)` remplace la fuite HABITUELLE quand on est dans un couloir souterrain :
//   - hold : on frappe le mob de mêlée le plus proche (bot.pvp.attack) au lieu de courir ;
//   - wall : on s'immobilise et on pose pieds + tête sur les côtés ouverts tournés vers la menace,
//            puis on mange (async, une seule pose à la fois) ;
//   - sinon : `deps.fleeFrom(bot)` — comportement d'avant, inchangé (surface, grotte ouverte, pas de blocs).
// Toujours best-effort : une exception retombe sur la fuite.
const { Vec3 } = require('vec3');
const { tunnelShape, tunnelDefensePlan } = require('../tunnelDefense');

const WALL_ITEMS = ['cobblestone', 'cobbled_deepslate', 'dirt', 'stone', 'deepslate', 'netherrack', 'andesite', 'diorite', 'granite', 'tuff'];
const WALL_MS = 4000;

let _walling = false;   // une seule pose en vol (le réflexe et le tick de survie peuvent tirer ensemble)

function _wallItem(bot) {
  const items = (bot.inventory && bot.inventory.items()) || [];
  for (const n of WALL_ITEMS) { const it = items.find((i) => i && i.name === n); if (it) return it; }
  return null;
}

function _isHostile(e) {
  return !!(e && e.position && (e.kind === 'Hostile mobs' || e.type === 'hostile') && e.name !== 'enderman');
}

function _armed(bot) {
  const items = (bot.inventory && bot.inventory.items()) || [];
  return items.some((i) => i && /_(sword|axe)$/.test(i.name));
}

/** Lit la situation du bot pour tunnelDefensePlan (jamais de throw). */
function readTunnelSituation(bot) {
  const me = bot.entity && bot.entity.position;
  if (!me || typeof bot.blockAt !== 'function') return null;
  const f = { x: Math.floor(me.x), y: Math.floor(me.y), z: Math.floor(me.z) };
  const solidAt = (dx, dy, dz) => {
    const b = bot.blockAt(new Vec3(f.x + dx, f.y + dy, f.z + dz));
    return !!(b && b.boundingBox === 'block');
  };
  let skyLight = 0;
  try { const c = bot.blockAt(new Vec3(f.x, f.y + 1, f.z)); if (c && c.skyLight != null) skyLight = c.skyLight; } catch (e) {}
  const hostiles = [];
  for (const e of Object.values(bot.entities || {})) {
    if (!_isHostile(e) || e === bot.entity) continue;
    const x = e.position.x - me.x; const z = e.position.z - me.z;
    const dist = Math.hypot(x, e.position.y - me.y, z);
    if (dist <= 12) hostiles.push({ name: e.name, x, z, dist, entity: e });
  }
  return {
    y: me.y, skyLight, shape: tunnelShape(solidAt), health: bot.health, food: bot.food,
    armed: _armed(bot), hasBlocks: !!_wallItem(bot), hostiles, floor: f,
  };
}

/** Pose un bloc de mur dans la case `pos` (vide), accroché à n'importe quelle face pleine voisine. */
async function _placeAt(bot, pos, item) {
  const here = bot.blockAt(pos);
  if (here && here.boundingBox === 'block') return true;          // déjà plein
  const faces = [[0, -1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0]];
  for (const [dx, dy, dz] of faces) {
    const ref = bot.blockAt(pos.offset(dx, dy, dz));
    if (!ref || ref.boundingBox !== 'block') continue;
    try {
      await bot.equip(item, 'hand');
      await bot.placeBlock(ref, new Vec3(-dx, -dy, -dz));
      return true;
    } catch (e) { /* face suivante */ }
  }
  return false;
}

/** Mure les côtés `seal` (pieds + tête). Rend le nombre de blocs posés. */
async function sealSides(bot, floor, seal) {
  let placed = 0;
  for (const c of seal) {
    for (const dy of [0, 1]) {
      const it = _wallItem(bot);
      if (!it) return placed;
      try { if (await _placeAt(bot, new Vec3(floor.x + c.dx, floor.y + dy, floor.z + c.dz), it)) placed++; } catch (e) {}
    }
  }
  return placed;
}

/**
 * Remplaçant de fleeFrom sous terre. deps = { fleeFrom, emit, stopMotion, eat, withTimeout? }.
 * Rend 'hold' | 'wall' | 'flee' (ce qui a été fait).
 */
function tunnelFlee(bot, deps = {}) {
  const emit = deps.emit || (() => {});
  const flee = () => { try { return deps.fleeFrom && deps.fleeFrom(bot); } catch (e) { return false; } };
  let s = null;
  try { s = readTunnelSituation(bot); } catch (e) { s = null; }
  if (!s) { flee(); return 'flee'; }
  const plan = tunnelDefensePlan(s);
  if (plan.action === 'hold') {
    const target = s.hostiles.slice().sort((a, b) => a.dist - b.dist)[plan.target] || null;
    const foe = target && target.entity;
    if (!foe || !bot.pvp || typeof bot.pvp.attack !== 'function') { flee(); return 'flee'; }
    try { if (deps.stopMotion) deps.stopMotion(); } catch (e) {}
    try { bot.pvp.attack(foe); } catch (e) {}
    emit({ type: 'tunnel_hold', mob: foe.name, hp: Math.round(bot.health || 0), y: Math.round(s.y) });
    return 'hold';
  }
  if (plan.action === 'wall') {
    if (_walling) return 'wall';
    _walling = true;
    (async () => {
      try {
        try { if (bot.pvp && bot.pvp.target && typeof bot.pvp.stop === 'function') bot.pvp.stop(); } catch (e) {}
        try { if (deps.stopMotion) deps.stopMotion(); } catch (e) {}
        const run = sealSides(bot, s.floor, plan.seal);
        const placed = deps.withTimeout
          ? await deps.withTimeout(run, WALL_MS, () => { try { deps.stopMotion && deps.stopMotion(); } catch (e) {} })
          : await run;
        const n = Number.isFinite(placed) ? placed : 0;
        emit({ type: 'tunnel_wall', reason: plan.reason, sides: plan.seal.length, placed: n, hp: Math.round(bot.health || 0), y: Math.round(s.y) });
        if (n === 0) { flee(); return; }                       // rien posé : mieux vaut courir que rester planté
        try { if (deps.eat) await deps.eat(bot); } catch (e) {}
      } catch (e) { flee(); }
      finally { _walling = false; }
    })();
    return 'wall';
  }
  flee();
  return 'flee';
}

function _resetForTests() { _walling = false; }

module.exports = { tunnelFlee, readTunnelSituation, sealSides, WALL_ITEMS, _resetForTests };
