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
    { type: 'cave_found', world: 'w', x: 1, y: 64, z: 3, flooded: false });
  assert.deepStrictEqual(wm.caveFoundEvent('w', { x: 1, y: 64, z: 3 }, { flooded: true }),
    { type: 'cave_found', world: 'w', x: 1, y: 64, z: 3, flooded: true });
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

test('directedTarget : grotte INONDÉE ignorée → cave sèche suivante (Massii 2026-06-22)', () => {
  const mem = { worlds: { w: { finds: [], biomes: [], caves: [
    { x: 100, y: 40, z: -50, flooded: true },   // la + proche mais NOYÉE → sautée (anti-noyade)
    { x: 400, y: 30, z: 0, flooded: false },     // sèche → choisie
  ] } } };
  const t = wm.directedTarget(mem, 'w', 'iron_ore', { x: 0, z: 0 });
  assert.deepStrictEqual(t, { x: 400, z: 0, y: 30, biome: null, learned: false, cave: true });
});

test('directedTarget : toutes les caves inondées → null (repli minage profond sec)', () => {
  const mem = { worlds: { w: { finds: [], biomes: [], caves: [
    { x: 100, y: 40, z: -50, flooded: true },
  ] } } };
  assert.strictEqual(wm.directedTarget(mem, 'w', 'iron_ore', { x: 0, z: 0 }), null);
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

// ─── Exclusion des cibles ÉPUISÉES (RC4 water-wall) ────────────────────────────────────────────
// Un find appris prime TOUJOURS, même quand le gisement est pelé (vécu NethBot1 world_ax1 :
// boucle explore_directed ×48 sur la même prairie sans arbres). explore.js marque la cible
// « épuisée » quand il ARRIVE dessus et ne trouve rien → directedTarget doit la sauter.

test('targetKey : clé arrondie "x,z"', () => {
  assert.strictEqual(wm.targetKey(10.6, -3.2), '11,-3');
  assert.strictEqual(wm.targetKey(0, 0), '0,0');
});

test('directedTarget : find épuisé exclu → find suivant le + proche', () => {
  const mem = { worlds: { w: { finds: [
    { material: 'oak_log', biome: 'meadow', x: 100, z: 0 },
    { material: 'oak_log', biome: 'forest', x: 300, z: 0 },
  ], biomes: [] } } };
  const exclude = new Set([wm.targetKey(100, 0)]);
  const t = wm.directedTarget(mem, 'w', 'oak_log', { x: 0, z: 0 }, { exclude });
  assert.deepStrictEqual(t, { x: 300, z: 0, biome: 'forest', learned: true });
});

test('directedTarget : tous les finds exclus → fallback biome vanilla', () => {
  const mem = { worlds: { w: { finds: [
    { material: 'oak_log', biome: 'meadow', x: 100, z: 0 },
  ], biomes: [{ name: 'forest', x: 500, z: 0 }] } } };
  const exclude = new Set([wm.targetKey(100, 0)]);
  const t = wm.directedTarget(mem, 'w', 'oak_log', { x: 0, z: 0 }, { exclude });
  assert.deepStrictEqual(t, { x: 500, z: 0, biome: 'forest', learned: false });
});

test('directedTarget : biomes et caves exclus aussi (même clé x,z)', () => {
  const memB = { worlds: { w: { finds: [], biomes: [
    { name: 'forest', x: 200, z: 0 }, { name: 'forest', x: 800, z: 0 },
  ] } } };
  const tB = wm.directedTarget(memB, 'w', 'oak_log', { x: 0, z: 0 }, { exclude: new Set([wm.targetKey(200, 0)]) });
  assert.deepStrictEqual(tB, { x: 800, z: 0, biome: 'forest', learned: false });
  const memC = { worlds: { w: { finds: [], biomes: [], caves: [
    { x: 100, y: 40, z: -50 }, { x: 400, y: 30, z: 0 },
  ] } } };
  const tC = wm.directedTarget(memC, 'w', 'iron_ore', { x: 0, z: 0 }, { exclude: new Set([wm.targetKey(100, -50)]) });
  assert.deepStrictEqual(tC, { x: 400, z: 0, y: 30, biome: null, learned: false, cave: true });
});

test('directedTarget : exclude absent/vide → comportement historique inchangé', () => {
  const mem = { worlds: { w: { finds: [
    { material: 'oak_log', biome: 'meadow', x: 100, z: 0 },
  ], biomes: [] } } };
  assert.deepStrictEqual(wm.directedTarget(mem, 'w', 'oak_log', { x: 0, z: 0 }, { exclude: new Set() }),
    { x: 100, z: 0, biome: 'meadow', learned: true });
  assert.deepStrictEqual(wm.directedTarget(mem, 'w', 'oak_log', { x: 0, z: 0 }),
    { x: 100, z: 0, biome: 'meadow', learned: true });
});
