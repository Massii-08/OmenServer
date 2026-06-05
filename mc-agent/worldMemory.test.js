'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const wm = require('./worldMemory');

test('vanillaHint : *_log → forêts/taiga ; sand → desert ; inconnu → []', () => {
  assert.ok(wm.vanillaHint('oak_log').includes('forest'));
  assert.ok(wm.vanillaHint('spruce_log').includes('taiga'));
  assert.ok(wm.vanillaHint('sand').includes('desert'));
  assert.deepStrictEqual(wm.vanillaHint('diamond'), []);
  assert.deepStrictEqual(wm.vanillaHint(null), []);
});

test('parseMemory : JSON valide gardé, sinon {worlds:{}}', () => {
  assert.deepStrictEqual(wm.parseMemory('{"worlds":{"w":{}}}'), { worlds: { w: {} } });
  assert.deepStrictEqual(wm.parseMemory('pas json'), { worlds: {} });
  assert.deepStrictEqual(wm.parseMemory('{"x":1}'), { worlds: {} });  // pas de clé worlds
});

test('worldKey : label explicite prioritaire, sinon dimension, sinon unknown', () => {
  assert.strictEqual(wm.worldKey({ game: { dimension: 'minecraft:overworld' } }), 'minecraft:overworld');
  assert.strictEqual(wm.worldKey({ game: { dimension: 'minecraft:overworld' } }, 'mining'), 'mining');
  assert.strictEqual(wm.worldKey({}), 'unknown');
});

test('readBiome : name+id, ou name seul, ou rien (biome custom)', () => {
  assert.deepStrictEqual(wm.readBiome({ biome: { name: 'forest', id: 4 } }), { name: 'forest', id: 4 });
  assert.deepStrictEqual(wm.readBiome({ biome: { id: 200 } }), { name: null, id: 200 }); // custom sans nom
  assert.deepStrictEqual(wm.readBiome({}), { name: null, id: null });
});

test('biomeSeenEvent : construit l\'event taggé monde, coords arrondies', () => {
  const ev = wm.biomeSeenEvent('w', { biome: { name: 'forest', id: 4 } }, { x: 10.7, z: -3.2 });
  assert.deepStrictEqual(ev, { type: 'biome_seen', world: 'w', name: 'forest', id: 4, x: 11, z: -3 });
});

test('caveFoundEvent / materialFoundEvent', () => {
  assert.deepStrictEqual(wm.caveFoundEvent('w', { x: 1.4, y: 63.9, z: 2.5 }),
    { type: 'cave_found', world: 'w', x: 1, y: 64, z: 3 });
  assert.deepStrictEqual(wm.materialFoundEvent('w', 'oak_log', 'forest', { x: 5.2, z: 9.8 }),
    { type: 'material_found', world: 'w', material: 'oak_log', biome: 'forest', x: 5, z: 10 });
});

test('directedTarget : associations apprises (finds) priment', () => {
  const mem = { worlds: { w: { finds: [
    { material: 'oak_log', biome: 'forest', x: 640, z: 128 },
    { material: 'oak_log', biome: 'taiga', x: 5000, z: 0 },
  ], biomes: [] } } };
  const t = wm.directedTarget(mem, 'w', 'oak_log', { x: 0, z: 0 });
  assert.deepStrictEqual(t, { x: 640, z: 128, biome: 'forest', learned: true }); // le + proche
});

test('directedTarget : fallback amorce vanilla si pas de finds', () => {
  const mem = { worlds: { w: { finds: [], biomes: [
    { name: 'forest', x: 200, z: 0 }, { name: 'desert', x: 50, z: 0 },
  ] } } };
  const t = wm.directedTarget(mem, 'w', 'oak_log', { x: 0, z: 0 });
  assert.deepStrictEqual(t, { x: 200, z: 0, biome: 'forest', learned: false }); // forest = hint *_log
});

test('directedTarget : rien de connu → null ; hors maxDist → null', () => {
  assert.strictEqual(wm.directedTarget({ worlds: {} }, 'w', 'oak_log', { x: 0, z: 0 }), null);
  const mem = { worlds: { w: { finds: [{ material: 'oak_log', biome: 'forest', x: 9000, z: 0 }] } } };
  assert.strictEqual(wm.directedTarget(mem, 'w', 'oak_log', { x: 0, z: 0 }, { maxDist: 1500 }), null);
});

// --- biais caves (1d) : un minerai sans find appris ni amorce → entrée de grotte connue la + proche ---

test('isOre : *_ore (deepslate inclus) + ancient_debris ; pas le bois/sable', () => {
  assert.strictEqual(wm.isOre('iron_ore'), true);
  assert.strictEqual(wm.isOre('deepslate_diamond_ore'), true);
  assert.strictEqual(wm.isOre('ancient_debris'), true);
  assert.strictEqual(wm.isOre('oak_log'), false);
  assert.strictEqual(wm.isOre('sand'), false);
  assert.strictEqual(wm.isOre(null), false);
});

test('directedTarget : minerai sans find → cave connue la + proche (cave:true)', () => {
  const mem = { worlds: { w: { finds: [], biomes: [], caves: [
    { x: 100, y: 40, z: -50 }, { x: 900, y: 30, z: 900 },
  ] } } };
  const t = wm.directedTarget(mem, 'w', 'iron_ore', { x: 0, z: 0 });
  assert.deepStrictEqual(t, { x: 100, z: -50, y: 40, biome: null, learned: false, cave: true });
});

test('directedTarget : find appris du minerai prime sur la cave', () => {
  const mem = { worlds: { w: { finds: [{ material: 'iron_ore', biome: 'plains', x: 300, z: 0 }],
    biomes: [], caves: [{ x: 100, y: 40, z: -50 }] } } };
  const t = wm.directedTarget(mem, 'w', 'iron_ore', { x: 0, z: 0 });
  assert.deepStrictEqual(t, { x: 300, z: 0, biome: 'plains', learned: true });
});

test('directedTarget : non-minerai → caves ignorées ; cave hors maxDist → null', () => {
  const mem = { worlds: { w: { finds: [], biomes: [], caves: [{ x: 100, y: 40, z: -50 }] } } };
  assert.strictEqual(wm.directedTarget(mem, 'w', 'oak_log', { x: 0, z: 0 }), null);
  const far = { worlds: { w: { finds: [], biomes: [], caves: [{ x: 9000, y: 40, z: 0 }] } } };
  assert.strictEqual(wm.directedTarget(far, 'w', 'iron_ore', { x: 0, z: 0 }, { maxDist: 1500 }), null);
});

// --- resolveBiome (#2 retours live : biome.name = '' en 1.21.4, résolu via registry) ---
const { resolveBiome } = require('./worldMemory');

test('resolveBiome : nom vide + id -> résolu via bot.registry.biomes', () => {
  const bot = { registry: { biomes: { 28: { name: 'jungle' } } } };
  assert.deepStrictEqual(resolveBiome(bot, { biome: { name: '', id: 28 } }), { name: 'jungle', id: 28 });
  assert.deepStrictEqual(resolveBiome(bot, { biome: { id: 28 } }), { name: 'jungle', id: 28 });
});

test('resolveBiome : nom déjà présent -> inchangé ; id inconnu du registry -> id-only (datapack)', () => {
  const bot = { registry: { biomes: {} } };
  assert.deepStrictEqual(resolveBiome(bot, { biome: { name: 'forest', id: 4 } }), { name: 'forest', id: 4 });
  assert.deepStrictEqual(resolveBiome(bot, { biome: { name: '', id: 999 } }), { name: null, id: 999 });
  assert.deepStrictEqual(resolveBiome(bot, null), { name: null, id: null });
});
