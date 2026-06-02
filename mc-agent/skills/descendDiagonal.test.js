'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { descendDiagonal } = require('./descendDiagonal');

// --- Fake bot minimal pour tester la géométrie + anti-lave (sans vrai mineflayer).
// On simule une colonne d'air avec un sol stone + un "champ" de blocs nommés à des positions clés.
function pos(x, y, z) { return { x, y, z, offset(dx, dy, dz) { return pos(x + dx, y + dy, z + dz); } }; }

function makeBot({ startY = 10, world = {}, yaw = 0 } = {}) {
  const calls = { dig: [], equip: [], setControlState: [], lookAt: [] };
  const bot = {
    entity: { position: pos(0, startY, 0), yaw },
    registry: { blocksByName: {
      stone: { id: 1 }, deepslate: { id: 2 }, dirt: { id: 3 },
      lava: { id: 10 }, flowing_lava: { id: 11 },
      air: { id: 0 }, cave_air: { id: 0 },
    } },
    inventory: { items: () => [
      { name: 'stone_pickaxe', count: 1, type: 'pickaxe' },
      { name: 'cobblestone', count: 32, type: 'block' },
    ] },
    blockAt(p) {
      const key = `${p.x},${p.y},${p.z}`;
      if (world[key]) return { name: world[key], position: p, boundingBox: world[key] === 'air' ? 'empty' : 'block' };
      // par défaut : stone partout sauf la colonne du bot (air aux pieds + tête)
      const bp = bot.entity.position;
      if (p.x === Math.floor(bp.x) && p.z === Math.floor(bp.z) && (p.y === Math.floor(bp.y) || p.y === Math.floor(bp.y) + 1)) {
        return { name: 'air', position: p, boundingBox: 'empty' };
      }
      return { name: 'stone', position: p, boundingBox: 'block' };
    },
    async dig(block) {
      calls.dig.push(block.position);
      // simule : le bloc miné devient air dans le monde
      const key = `${block.position.x},${block.position.y},${block.position.z}`;
      world[key] = 'air';
    },
    async equip(item, slot) { calls.equip.push({ name: item.name, slot }); },
    setControlState(c, v) { calls.setControlState.push([c, v]); },
    async lookAt(p) { calls.lookAt.push(p); },
    async waitForTicks(n) { /* no-op */ },
  };
  return { bot, calls, world };
}

test('descendDiagonal : descend OK 5 paliers de stone, reachedY décroît', async () => {
  const { bot } = makeBot({ startY: 10 });
  const r = await descendDiagonal(bot, { targetY: 5, maxDepth: 20 });
  assert.strictEqual(r.ok, true);
  assert.ok(r.reachedY <= 5, `reachedY=${r.reachedY} should be <= 5`);
});

test('descendDiagonal : token.cancelled stoppe net', async () => {
  const { bot } = makeBot({ startY: 10 });
  const r = await descendDiagonal(bot, { targetY: -10, maxDepth: 100 }, { cancelled: true });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.cancelled, true);
});

test('descendDiagonal : lave devant -> stop reason=lava_ahead', async () => {
  // place de la lave dans le sens d'avancement (cap est = x+1) à proximité.
  const world = { '1,10,0': 'lava' };
  const { bot } = makeBot({ startY: 10, world, yaw: -Math.PI / 2 });
  const r = await descendDiagonal(bot, { targetY: -10, maxDepth: 50 });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'lava_ahead');
});

test('descendDiagonal : air à Y<=-50 -> stop reason=air_at_y_-50 (grotte/lave possible)', async () => {
  // bot à Y=-49, on lui demande de descendre. La case devant à Y=-50 doit être de l'air.
  const world = { '1,-50,0': 'air' };
  const { bot } = makeBot({ startY: -49, world, yaw: -Math.PI / 2 });
  const r = await descendDiagonal(bot, { targetY: -54, maxDepth: 20 });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'air_at_y_-50');
});

test('descendDiagonal : équipe la pioche pierre (bestToolFor)', async () => {
  const { bot, calls } = makeBot({ startY: 10 });
  await descendDiagonal(bot, { targetY: 5, maxDepth: 20 });
  assert.ok(calls.equip.length > 0, 'should equip a tool');
  assert.ok(calls.equip.some((e) => e.name === 'stone_pickaxe'), 'should equip stone_pickaxe');
});

test('descendDiagonal : maxDepth atteint -> stop avec reachedY', async () => {
  const { bot } = makeBot({ startY: 64 });
  const r = await descendDiagonal(bot, { targetY: -100, maxDepth: 3 });
  // 3 paliers : on a descendu 3 blocs au max
  assert.ok(r.reachedY >= 61, `reachedY=${r.reachedY} should be >= 61 (only 3 steps)`);
  assert.strictEqual(r.reason, 'max_depth');
});

test('descendDiagonal : cardinaux — yaw arrondi à un axe (E/W/N/S)', async () => {
  // yaw ≈ -π/2 (est = +x). Vérifier qu'on creuse bien à x+1 et pas en diagonale xz.
  const { bot, calls } = makeBot({ startY: 10, yaw: -Math.PI / 2 });
  await descendDiagonal(bot, { targetY: 8, maxDepth: 5 });
  // Premiers digs : devraient être à x=1 (ou plus loin), z=0
  const firstDig = calls.dig[0];
  assert.strictEqual(firstDig.x, 1, 'first dig should be at x=1 (east)');
  assert.strictEqual(firstDig.z, 0, 'first dig should be at z=0');
});

test('descendDiagonal : déjà à Y target -> ok immédiat sans miner', async () => {
  const { bot, calls } = makeBot({ startY: -54 });
  const r = await descendDiagonal(bot, { targetY: -54, maxDepth: 50 });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(calls.dig.length, 0);
});
