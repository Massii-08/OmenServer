'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const ores = require('./ores');

// --- oreBase (matériau de base) ---
test('oreBase : strip deepslate_/nether_ + _ore, ancient_debris intact', () => {
  assert.strictEqual(ores.oreBase('iron_ore'), 'iron');
  assert.strictEqual(ores.oreBase('coal_ore'), 'coal');
  assert.strictEqual(ores.oreBase('deepslate_iron_ore'), 'iron');
  assert.strictEqual(ores.oreBase('deepslate_diamond_ore'), 'diamond');
  assert.strictEqual(ores.oreBase('nether_gold_ore'), 'gold');
  assert.strictEqual(ores.oreBase('nether_quartz_ore'), 'quartz');
  assert.strictEqual(ores.oreBase('ancient_debris'), 'ancient_debris');
  assert.strictEqual(ores.oreBase(''), null);
  assert.strictEqual(ores.oreBase(null), null);
  assert.strictEqual(ores.oreBase(42), null);
});

// --- DEFAULT_PRIORITY ---
test('DEFAULT_PRIORITY : ordre décroissant attendu', () => {
  assert.deepStrictEqual(ores.DEFAULT_PRIORITY,
    ['ancient_debris', 'diamond', 'emerald', 'gold', 'redstone', 'lapis', 'iron', 'copper', 'coal']);
});

// --- requiredPickTier (palier minimal) ---
test('requiredPickTier : vanilla rules', () => {
  // index dans ['wooden','golden','stone','iron','diamond','netherite']
  assert.strictEqual(ores.requiredPickTier('diamond_ore'), 3);          // fer
  assert.strictEqual(ores.requiredPickTier('emerald_ore'), 3);          // fer
  assert.strictEqual(ores.requiredPickTier('gold_ore'), 3);             // fer
  assert.strictEqual(ores.requiredPickTier('nether_gold_ore'), 3);      // fer
  assert.strictEqual(ores.requiredPickTier('redstone_ore'), 3);         // fer
  assert.strictEqual(ores.requiredPickTier('deepslate_redstone_ore'), 3);
  assert.strictEqual(ores.requiredPickTier('ancient_debris'), 4);       // diamant
  assert.strictEqual(ores.requiredPickTier('iron_ore'), 2);            // pierre
  assert.strictEqual(ores.requiredPickTier('deepslate_iron_ore'), 2);
  assert.strictEqual(ores.requiredPickTier('lapis_ore'), 2);          // pierre
  assert.strictEqual(ores.requiredPickTier('copper_ore'), 2);         // pierre
  assert.strictEqual(ores.requiredPickTier('coal_ore'), 0);           // bois
  assert.strictEqual(ores.requiredPickTier('mystery_ore'), 0);        // inconnu → prudent
});

// --- listOres (filtre valides, pas de mutation) ---
test('listOres : filtre les entrées valides, ne mute pas', () => {
  const mem = { worlds: { w: { ores: [
    { material: 'iron_ore', x: 1, y: 2, z: 3 },
    { material: '', x: 1, y: 2, z: 3 },              // material vide
    { material: 'diamond_ore', x: 'a', y: 2, z: 3 }, // x non num
    { material: 'gold_ore', x: 4, y: Infinity, z: 3 }, // y non fini
    { x: 4, y: 2, z: 3 },                            // pas de material
    { material: 'coal_ore', x: 9, y: 8, z: 7 },
  ] } } };
  const before = JSON.stringify(mem);
  const r = ores.listOres(mem, 'w');
  assert.strictEqual(r.length, 2);
  assert.deepStrictEqual(r.map(o => o.material), ['iron_ore', 'coal_ore']);
  assert.strictEqual(JSON.stringify(mem), before); // pas de mutation
});

test('listOres : memory/world absent → []', () => {
  assert.deepStrictEqual(ores.listOres(null, 'w'), []);
  assert.deepStrictEqual(ores.listOres({ worlds: {} }, 'w'), []);
  assert.deepStrictEqual(ores.listOres({ worlds: { w: {} } }, 'w'), []);
  assert.deepStrictEqual(ores.listOres({ worlds: { w: { ores: 'nope' } } }, 'w'), []);
});

// --- oreKey ---
test('oreKey : coords arrondies "x,y,z"', () => {
  assert.strictEqual(ores.oreKey({ x: 1, y: 2, z: 3 }), '1,2,3');
  assert.strictEqual(ores.oreKey({ x: 10.4, y: 39.6, z: -3.5 }), '10,40,-3');
});

// --- nextOreTarget ---
test('nextOreTarget : priorité prime sur la distance (diamond loin bat iron proche)', () => {
  const mem = { worlds: { w: { ores: [
    { material: 'iron_ore', x: 5, y: 0, z: 0 },
    { material: 'diamond_ore', x: 100, y: 0, z: 0 },
  ] } } };
  const t = ores.nextOreTarget(mem, 'w', { x: 0, y: 0, z: 0 });
  assert.strictEqual(t.material, 'diamond_ore');
});

test('nextOreTarget : proximité 3D (pas horizontale) départage à priorité égale', () => {
  const mem = { worlds: { w: { ores: [
    // dist horizontale plus petite mais 3D plus grande à cause de y
    { material: 'iron_ore', x: 10, y: -60, z: 0 }, // 3D = sqrt(100+3600)
    { material: 'iron_ore', x: 0, y: 0, z: 50 },   // 3D = 50
  ] } } };
  const t = ores.nextOreTarget(mem, 'w', { x: 0, y: 0, z: 0 });
  assert.deepStrictEqual({ x: t.x, y: t.y, z: t.z }, { x: 0, y: 0, z: 50 });
});

test('nextOreTarget : dédup par position exacte', () => {
  const mem = { worlds: { w: { ores: [
    { material: 'iron_ore', x: 7, y: 8, z: 9 },
    { material: 'iron_ore', x: 7, y: 8, z: 9 },
  ] } } };
  const t = ores.nextOreTarget(mem, 'w', { x: 0, y: 0, z: 0 });
  assert.ok(t);
  assert.deepStrictEqual({ x: t.x, y: t.y, z: t.z }, { x: 7, y: 8, z: 9 });
});

test('nextOreTarget : skip (Set ou Array) ignore la cible → suivante retournée', () => {
  const mem = { worlds: { w: { ores: [
    { material: 'iron_ore', x: 5, y: 0, z: 0 },
    { material: 'iron_ore', x: 50, y: 0, z: 0 },
  ] } } };
  const fromO = { x: 0, y: 0, z: 0 };
  // sans skip → le plus proche (5)
  assert.deepStrictEqual(ores.nextOreTarget(mem, 'w', fromO).x, 5);
  // skip le plus proche via Set
  let t = ores.nextOreTarget(mem, 'w', fromO, { skip: new Set(['5,0,0']) });
  assert.strictEqual(t.x, 50);
  // skip via Array
  t = ores.nextOreTarget(mem, 'w', fromO, { skip: ['5,0,0'] });
  assert.strictEqual(t.x, 50);
  // tout skippé → null
  assert.strictEqual(ores.nextOreTarget(mem, 'w', fromO, { skip: ['5,0,0', '50,0,0'] }), null);
});

test('nextOreTarget : pickTier filtre les cibles trop dures', () => {
  const mem = { worlds: { w: { ores: [
    { material: 'diamond_ore', x: 1, y: 0, z: 0 }, // exige fer (3)
    { material: 'iron_ore', x: 80, y: 0, z: 0 },   // exige pierre (2)
  ] } } };
  const fromO = { x: 0, y: 0, z: 0 };
  // pickTier=2 (pierre) → diamond exclu, iron retourné
  assert.strictEqual(ores.nextOreTarget(mem, 'w', fromO, { pickTier: 2 }).material, 'iron_ore');
  // pickTier=3 (fer) → diamond accessible et prioritaire
  assert.strictEqual(ores.nextOreTarget(mem, 'w', fromO, { pickTier: 3 }).material, 'diamond_ore');
  // sans pickTier → pas de filtre, diamond prioritaire
  assert.strictEqual(ores.nextOreTarget(mem, 'w', fromO).material, 'diamond_ore');
});

test('nextOreTarget : priority custom (iron avant diamond)', () => {
  const mem = { worlds: { w: { ores: [
    { material: 'diamond_ore', x: 1, y: 0, z: 0 },
    { material: 'iron_ore', x: 1, y: 0, z: 0, z2: 1 },
  ] } } };
  // positions distinctes pour éviter la dédup
  mem.worlds.w.ores[1] = { material: 'iron_ore', x: 2, y: 0, z: 0 };
  const t = ores.nextOreTarget(mem, 'w', { x: 0, y: 0, z: 0 }, { priority: ['iron', 'diamond'] });
  assert.strictEqual(t.material, 'iron_ore');
});

test('nextOreTarget : matériau inconnu sélectionnable si rien d\'autre, mais après les listés', () => {
  // inconnu seul → choisi
  let mem = { worlds: { w: { ores: [{ material: 'mystery_ore', x: 3, y: 0, z: 0 }] } } };
  assert.strictEqual(ores.nextOreTarget(mem, 'w', { x: 0, y: 0, z: 0 }).material, 'mystery_ore');
  // inconnu vs coal (listé en dernier) → coal gagne même plus loin
  mem = { worlds: { w: { ores: [
    { material: 'mystery_ore', x: 1, y: 0, z: 0 },
    { material: 'coal_ore', x: 90, y: 0, z: 0 },
  ] } } };
  assert.strictEqual(ores.nextOreTarget(mem, 'w', { x: 0, y: 0, z: 0 }).material, 'coal_ore');
});

test('nextOreTarget : entrées invalides / monde absent / memory null → null proprement', () => {
  assert.strictEqual(ores.nextOreTarget(null, 'w', { x: 0, y: 0, z: 0 }), null);
  assert.strictEqual(ores.nextOreTarget({ worlds: {} }, 'w', { x: 0, y: 0, z: 0 }), null);
  const mem = { worlds: { w: { ores: [
    { material: 'iron_ore', x: 'x', y: 0, z: 0 },
    { x: 1, y: 2, z: 3 },
  ] } } };
  assert.strictEqual(ores.nextOreTarget(mem, 'w', { x: 0, y: 0, z: 0 }), null);
});
