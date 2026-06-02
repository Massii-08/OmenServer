'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { branchMine } = require('./branchMine');

function pos(x, y, z) { return { x, y, z, offset(dx, dy, dz) { return pos(x + dx, y + dy, z + dz); } }; }

// Fake bot : permet de placer des "ores" + lave + cobble dans le sac.
function makeBot({ y = -54, yaw = -Math.PI / 2, world = {}, inv = null, gathered = {} } = {}) {
  const inventory = inv || [
    { name: 'iron_pickaxe', count: 1, type: 'pickaxe' },
    { name: 'cobblestone', count: 32, type: 'block' },
  ];
  const calls = { dig: [], placeBlock: [], gather: [] };
  const bot = {
    entity: { position: pos(0, y, 0), yaw },
    registry: { blocksByName: {
      stone: { id: 1 }, deepslate: { id: 2 },
      diamond_ore: { id: 56 }, deepslate_diamond_ore: { id: 57 },
      iron_ore: { id: 58 }, deepslate_iron_ore: { id: 59 },
      coal_ore: { id: 60 }, deepslate_coal_ore: { id: 61 },
      cobblestone: { id: 4 },
      lava: { id: 10 }, flowing_lava: { id: 11 },
      air: { id: 0 }, cave_air: { id: 0 },
    } },
    inventory: { items: () => inventory.slice() },
    blockAt(p) {
      const key = `${p.x},${p.y},${p.z}`;
      if (world[key]) return { name: world[key], position: p, boundingBox: world[key] === 'air' ? 'empty' : 'block' };
      // par défaut : deepslate partout (Y=-54 = deepslate IRL)
      return { name: 'deepslate', position: p, boundingBox: 'block' };
    },
    async dig(block) {
      calls.dig.push(block);
      const key = `${block.position.x},${block.position.y},${block.position.z}`;
      world[key] = 'air';
      // si c'était un ore, on simule l'ajout à l'inventaire (gather mocké via flag gathered)
    },
    async equip() {},
    async placeBlock(ref, face) {
      calls.placeBlock.push({ ref: ref.position, face });
      // simule : la case (ref + face) devient cobblestone
      const key = `${ref.position.x + face.x},${ref.position.y + face.y},${ref.position.z + face.z}`;
      world[key] = 'cobblestone';
      // consomme 1 cobble
      const cob = inventory.find((i) => i.name === 'cobblestone');
      if (cob) cob.count -= 1;
    },
    setControlState() {},
    async lookAt() {},
    async waitForTicks() {},
    nearestEntity() { return null; },                          // pas d'hostile
    pvp: { attack() {} },
    findBlock({ matching, maxDistance }) {
      // simule la détection de minerai : si un ore a été placé dans `world`, on le retourne.
      const ids = matching || [];
      for (const key of Object.keys(world)) {
        const name = world[key];
        const def = bot.registry.blocksByName[name];
        if (def && ids.includes(def.id)) {
          const [x, y, z] = key.split(',').map(Number);
          return { name, position: pos(x, y, z), boundingBox: 'block' };
        }
      }
      return null;
    },
    collectBlock: {
      async collect(block) {
        // simule : on ajoute le drop à l'inventaire (raw item du nom du bloc)
        let drop = block.name;
        if (drop === 'diamond_ore' || drop === 'deepslate_diamond_ore') drop = 'diamond';
        if (drop === 'iron_ore' || drop === 'deepslate_iron_ore') drop = 'raw_iron';
        if (drop === 'coal_ore' || drop === 'deepslate_coal_ore') drop = 'coal';
        const existing = inventory.find((i) => i.name === drop);
        if (existing) existing.count += 1;
        else inventory.push({ name: drop, count: 1, type: 'item' });
        calls.gather.push(drop);
        // efface du monde
        const key = `${block.position.x},${block.position.y},${block.position.z}`;
        world[key] = 'air';
      },
    },
  };
  return { bot, calls, world, inventory };
}

test('branchMine : à Y=-54, deepslate plein -> termine sans erreur', async () => {
  const { bot } = makeBot({ y: -54 });
  const r = await branchMine(bot, { targetY: -54, mainLength: 6, branchSpacing: 3, branchLength: 4 });
  assert.strictEqual(r.ok, true);
});

test('branchMine : wrong_depth si Y=10 (loin de targetY)', async () => {
  const { bot } = makeBot({ y: 10 });
  const r = await branchMine(bot, { targetY: -54, mainLength: 6 });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'wrong_depth');
});

test('branchMine : token.cancelled stoppe net', async () => {
  const { bot } = makeBot({ y: -54 });
  const r = await branchMine(bot, { targetY: -54, mainLength: 100 }, { cancelled: true });
  assert.strictEqual(r.ok, true);
  assert.ok(r.cancelled);
});

test('branchMine : diamond_ore détecté en voisin -> gotDiamond:true', async () => {
  // Place un diamant juste sur le chemin du tunnel principal (yaw est = +x).
  const world = { '3,-54,0': 'deepslate_diamond_ore' };
  const { bot } = makeBot({ y: -54, world });
  const r = await branchMine(bot, { targetY: -54, mainLength: 10, branchSpacing: 3, branchLength: 4 });
  assert.strictEqual(r.gotDiamond, true);
  assert.ok(r.ores.diamond >= 1);
});

test('branchMine : lave devant -> mure avec cobble (placeBlock appelé)', async () => {
  const world = { '2,-54,0': 'lava' };
  const { bot, calls } = makeBot({ y: -54, world });
  await branchMine(bot, { targetY: -54, mainLength: 6, branchSpacing: 3, branchLength: 4 });
  assert.ok(calls.placeBlock.length > 0, 'should have placed cobble to wall lava');
});

test('branchMine : cobble<8 -> reason cobble_low', async () => {
  const { bot } = makeBot({ y: -54, inv: [
    { name: 'iron_pickaxe', count: 1, type: 'pickaxe' },
    { name: 'cobblestone', count: 5, type: 'block' },
  ] });
  const r = await branchMine(bot, { targetY: -54, mainLength: 6 });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'cobble_low');
});

test('branchMine : ramasse opportunément le fer voisin', async () => {
  const world = { '2,-54,0': 'deepslate_iron_ore' };
  const { bot } = makeBot({ y: -54, world });
  const r = await branchMine(bot, { targetY: -54, mainLength: 6, branchSpacing: 3, branchLength: 4 });
  assert.ok(r.ores.iron >= 1, `ores.iron=${r.ores.iron} should be >= 1`);
});

test('branchMine : Y dans la tolérance ±2 (Y=-52 OK)', async () => {
  const { bot } = makeBot({ y: -52 });
  const r = await branchMine(bot, { targetY: -54, mainLength: 4 });
  // ne doit PAS retourner wrong_depth
  assert.notStrictEqual(r.reason, 'wrong_depth');
});
