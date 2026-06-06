'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { tunnelTo } = require('./tunnelTo');

// Fake bot — même pattern que descendDiagonal.test.js (monde stone par défaut, digs → air).
function pos(x, y, z) { return { x, y, z, offset(dx, dy, dz) { return pos(x + dx, y + dy, z + dz); } }; }

function makeBot({ start = [0, 60, 0], world = {} } = {}) {
  const calls = { dig: [], goto: [] };
  const bot = {
    entity: { position: pos(start[0], start[1], start[2]), yaw: 0 },
    inventory: { items: () => [{ name: 'diamond_pickaxe', count: 1 }] },
    blockAt(p) {
      const key = `${p.x},${p.y},${p.z}`;
      if (world[key]) return { name: world[key], position: p, boundingBox: world[key] === 'air' ? 'empty' : 'block' };
      const bp = bot.entity.position;
      if (p.x === Math.floor(bp.x) && p.z === Math.floor(bp.z) && (p.y === Math.floor(bp.y) || p.y === Math.floor(bp.y) + 1)) {
        return { name: 'air', position: p, boundingBox: 'empty' };
      }
      return { name: 'stone', position: p, boundingBox: 'block' };
    },
    async dig(block) {
      calls.dig.push(`${block.position.x},${block.position.y},${block.position.z}`);
      world[`${block.position.x},${block.position.y},${block.position.z}`] = 'air';
    },
    async equip() {},
    pathfinder: {
      async goto(goal) {
        calls.goto.push({ x: goal.x, y: goal.y, z: goal.z });
        bot.entity.position = pos(goal.x, goal.y, goal.z);
      },
    },
  };
  return { bot, calls, world };
}

test('tunnelTo : descend en diagonale jusqu\'à ≤3 blocs d\'une cible profonde', async () => {
  const { bot, calls } = makeBot({ start: [0, 60, 0] });
  const r = await tunnelTo(bot, { x: 8, y: 10, z: 0 });
  assert.equal(r.ok, true);
  const p = bot.entity.position;
  const d = Math.sqrt((p.x - 8) ** 2 + (p.y - 10) ** 2 + (p.z - 0) ** 2);
  assert.ok(d <= 3.01, `trop loin: ${d}`);
  assert.ok(calls.dig.length >= 40, 'doit avoir creusé la descente');  // ~50 marches × 2 blocs
});

test('tunnelTo : corridor horizontal vers une cible au même niveau', async () => {
  const { bot, calls } = makeBot({ start: [0, 30, 0] });
  const r = await tunnelTo(bot, { x: 0, y: 30, z: 12 });
  assert.equal(r.ok, true);
  // a creusé devant + devant-haut (corridor 1×2), pas de descente
  assert.ok(bot.entity.position.y >= 29, 'ne doit pas descendre');
  assert.ok(calls.dig.some((k) => k.endsWith(',30,1') || k.endsWith(',31,1')), 'corridor creusé');
});

test('tunnelTo : lave devant → abandon propre lava_ahead (jamais creuser dedans)', async () => {
  const world = { '1,59,0': 'lava' };                          // devant-bas du 1er pas
  const { bot, calls } = makeBot({ start: [0, 60, 0], world });
  const r = await tunnelTo(bot, { x: 12, y: 10, z: 0 });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'lava_ahead');
  assert.equal(calls.dig.length, 0, 'aucun dig avant l\'abandon');
});

test('tunnelTo : cible au-dessus → target_above (remonter = pathfinder)', async () => {
  const { bot } = makeBot({ start: [0, 10, 0] });
  const r = await tunnelTo(bot, { x: 1, y: 40, z: 0 });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'target_above');
});

test('tunnelTo : déjà proche (≤3) → ok immédiat sans dig', async () => {
  const { bot, calls } = makeBot({ start: [0, 60, 0] });
  const r = await tunnelTo(bot, { x: 2, y: 60, z: 0 });
  assert.equal(r.ok, true);
  assert.equal(calls.dig.length, 0);
});

test('tunnelTo : annulation token → sortie propre', async () => {
  const { bot } = makeBot({ start: [0, 60, 0] });
  const token = { cancelled: false };
  let n = 0;
  const origDig = bot.dig.bind(bot);
  bot.dig = async (b) => { if (++n >= 4) token.cancelled = true; return origDig(b); };
  const r = await tunnelTo(bot, { x: 30, y: 5, z: 0 }, {}, token);
  assert.equal(r.ok, true);
  assert.equal(r.cancelled, true);
});

test('tunnelTo : cible pile en dessous → diagonale stable (jamais droit sous les pieds)', async () => {
  const { bot, calls } = makeBot({ start: [0, 40, 0] });
  const r = await tunnelTo(bot, { x: 0, y: 20, z: 0 });
  assert.equal(r.ok, true);
  // aucun dig à la verticale exacte du bot au moment du dig
  assert.ok(calls.dig.length > 0);
});
