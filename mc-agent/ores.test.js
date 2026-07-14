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

test('nextOreTarget : EXPOSÉ prime sur la distance, à priorité égale (G-bis)', () => {
  const mem = { worlds: { w: { ores: [
    { material: 'diamond_ore', x: 0, y: 0, z: 5, exposed: false },  // proche mais enterré
    { material: 'diamond_ore', x: 0, y: 0, z: 40, exposed: true },  // loin mais EXPOSÉ (grotte)
  ] } } };
  const t = ores.nextOreTarget(mem, 'w', { x: 0, y: 0, z: 0 });
  assert.strictEqual(t.z, 40, 'le diamant exposé (grotte) doit primer sur l\'enterré plus proche');
  // preferExposed:false → rétro-compat distance pure
  const t2 = ores.nextOreTarget(mem, 'w', { x: 0, y: 0, z: 0 }, { preferExposed: false });
  assert.strictEqual(t2.z, 5, 'preferExposed:false → plus proche (distance pure)');
});

test('nextOreTarget : NOYÉ (wet) EXCLU → le sec enterré est choisi (H7+ anti-noyade)', () => {
  const mem = { worlds: { w: { ores: [
    { material: 'diamond_ore', x: 0, y: 0, z: 5, exposed: true, wet: true },    // exposé MAIS noyé (proche)
    { material: 'diamond_ore', x: 0, y: 0, z: 30, exposed: false, wet: false }, // enterré SEC (loin)
  ] } } };
  const t = ores.nextOreTarget(mem, 'w', { x: 0, y: 0, z: 0 });
  assert.strictEqual(t.z, 30, 'le sec enterré doit primer sur l\'exposé NOYÉ (évite la noyade)');
});

test('nextOreTarget : wet EXCLU même SEULE cible (H7+ exclusion DURE — on sacrifie, survie prime)', () => {
  const mem = { worlds: { w: { ores: [
    { material: 'diamond_ore', x: 0, y: 0, z: 5, exposed: true, wet: true },   // SEUL diamant, mais NOYÉ
  ] } } };
  // preferExposed par défaut (mode quota/cave) → AUCUNE cible : le diamant noyé est sacrifié (jamais l'eau)
  assert.strictEqual(ores.nextOreTarget(mem, 'w', { x: 0, y: 0, z: 0 }), null);
  // preferExposed:false (legacy distance pure) → wet encore éligible (rétro-compat stricte)
  const t2 = ores.nextOreTarget(mem, 'w', { x: 0, y: 0, z: 0 }, { preferExposed: false });
  assert.strictEqual(t2 && t2.z, 5);
});

test('nextOreTarget : diamant noyé sacrifié → bascule sur un autre type SEC', () => {
  const mem = { worlds: { w: { ores: [
    { material: 'diamond_ore', x: 0, y: 0, z: 3, exposed: true, wet: true },   // diamant NOYÉ (prioritaire mais exclu)
    { material: 'gold_ore', x: 0, y: 0, z: 10, exposed: true, wet: false },     // or SEC
  ] } } };
  const t = ores.nextOreTarget(mem, 'w', { x: 0, y: 0, z: 0 });
  assert.strictEqual(t && t.material, 'gold_ore', 'diamant noyé exclu → or sec choisi (jamais l\'eau)');
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

// ─── Détection des minerais exposés (cartographe) ───
const { ORE_NAMES, QUOTA_ORE_NAMES, isExposed, isWaterAdjacent, scanExposedOres, scanAllOres, exposedOreFoundEvent, oresFoundEvent } = require('./ores');

// Fake monde 3D : fonction (x,y,z) → nom de bloc. blockAt construit le bloc.
// boundingBox 'empty' pour air/cave_air/void_air/water/lava, 'block' sinon ; null pour 'unloaded'.
const _EMPTY = new Set(['air', 'cave_air', 'void_air', 'water', 'lava']);
function makeBot(world, extra = {}) {
  return Object.assign({
    blockAt(p) {
      const name = world(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z));
      if (name === 'unloaded') return null;
      return { name, position: { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) },
               boundingBox: _EMPTY.has(name) ? 'empty' : 'block' };
    },
  }, extra);
}

// ─── isExposed ───────────────────────────────────────────────────────────────

test('isExposed : minerai avec un voisin air → true', () => {
  // voisin +x = air, le reste stone (le minerai lui-même importe peu)
  const w = (x, y, z) => (x === 11 && y === 64 && z === 0) ? 'air' : 'stone';
  assert.strictEqual(isExposed(makeBot(w), { x: 10, y: 64, z: 0 }), true);
});

test('isExposed : minerai enterré (6 voisins stone) → false', () => {
  const w = () => 'stone';
  assert.strictEqual(isExposed(makeBot(w), { x: 10, y: 64, z: 0 }), false);
});

test('isExposed : voisin cave_air → true', () => {
  const w = (x, y, z) => (x === 10 && y === 65 && z === 0) ? 'cave_air' : 'stone';
  assert.strictEqual(isExposed(makeBot(w), { x: 10, y: 64, z: 0 }), true);
});

test('isExposed : voisin water SEUL → false (H7+ : eau ≠ exposition, grotte noyée évitée)', () => {
  // L'eau ne compte PLUS comme exposition : un minerai dont la seule face ouverte donne sur l'eau
  // est en zone NOYÉE — pas une cible « visible sèche ». Décision Massii : la survie prime, on sacrifie.
  const w = (x, y, z) => (x === 10 && y === 64 && z === 1) ? 'water' : 'stone';
  assert.strictEqual(isExposed(makeBot(w), { x: 10, y: 64, z: 0 }), false);
});

test('isExposed : 5 stone + 1 lava (lave seule) → false', () => {
  const w = (x, y, z) => (x === 10 && y === 63 && z === 0) ? 'lava' : 'stone';
  assert.strictEqual(isExposed(makeBot(w), { x: 10, y: 64, z: 0 }), false);
});

test('isExposed : voisin lava + voisin air (l\'air suffit) → true', () => {
  const w = (x, y, z) => {
    if (x === 10 && y === 63 && z === 0) return 'lava';
    if (x === 10 && y === 65 && z === 0) return 'air';
    return 'stone';
  };
  assert.strictEqual(isExposed(makeBot(w), { x: 10, y: 64, z: 0 }), true);
});

test('isExposed : voisin null (chunk non chargé) + 5 stone → false', () => {
  const w = (x, y, z) => (x === 11 && y === 64 && z === 0) ? 'unloaded' : 'stone';
  assert.strictEqual(isExposed(makeBot(w), { x: 10, y: 64, z: 0 }), false);
});

test('isExposed : bot sans blockAt → false', () => {
  assert.strictEqual(isExposed({}, { x: 10, y: 64, z: 0 }), false);
  assert.strictEqual(isExposed(null, { x: 10, y: 64, z: 0 }), false);
});

// ─── isWaterAdjacent (H7+ : flag `wet` anti-noyade, rayon élargi) ─────────────

test('isWaterAdjacent : eau en voisin direct (face) → true', () => {
  const w = (x, y, z) => (x === 11 && y === 64 && z === 0) ? 'water' : 'stone';
  assert.strictEqual(isWaterAdjacent(makeBot(w), { x: 10, y: 64, z: 0 }), true);
});

test('isWaterAdjacent : eau en DIAGONALE dist-1 → true (la veine floodFill l\'atteint)', () => {
  const w = (x, y, z) => (x === 11 && y === 65 && z === 0) ? 'water' : 'stone';  // coin haut +x
  assert.strictEqual(isWaterAdjacent(makeBot(w), { x: 10, y: 64, z: 0 }), true);
});

test('isWaterAdjacent : eau à 2 blocs (cardinal) → true (anti-percée en minant la roche entre deux)', () => {
  const w = (x, y, z) => (x === 12 && y === 64 && z === 0) ? 'water' : 'stone';  // +x dist 2
  assert.strictEqual(isWaterAdjacent(makeBot(w), { x: 10, y: 64, z: 0 }), true);
});

test('isWaterAdjacent : eau à 3 blocs → false (hors rayon, pas une menace immédiate)', () => {
  const w = (x, y, z) => (x === 13 && y === 64 && z === 0) ? 'water' : 'stone';  // +x dist 3
  assert.strictEqual(isWaterAdjacent(makeBot(w), { x: 10, y: 64, z: 0 }), false);
});

test('isWaterAdjacent : aucune eau dans le rayon → false (sec)', () => {
  assert.strictEqual(isWaterAdjacent(makeBot(() => 'stone'), { x: 10, y: 64, z: 0 }), false);
});

test('isWaterAdjacent : kelp / flowing_water comptent comme eau', () => {
  assert.strictEqual(isWaterAdjacent(makeBot((x, y, z) => (x === 11 && y === 64 && z === 0) ? 'kelp' : 'stone'), { x: 10, y: 64, z: 0 }), true);
  assert.strictEqual(isWaterAdjacent(makeBot((x, y, z) => (x === 9 && y === 64 && z === 0) ? 'flowing_water' : 'stone'), { x: 10, y: 64, z: 0 }), true);
});

test('isWaterAdjacent : bot sans blockAt → false', () => {
  assert.strictEqual(isWaterAdjacent({}, { x: 10, y: 64, z: 0 }), false);
  assert.strictEqual(isWaterAdjacent(null, { x: 10, y: 64, z: 0 }), false);
});

// ─── scanExposedOres ─────────────────────────────────────────────────────────

function makeRegistry(map) {
  return { blocksByName: map };
}

test('scanExposedOres : 3 trouvés (1 exposé, 1 enterré, 1 chunk non chargé) → 1 seul', () => {
  const exposedPos = { x: 5, y: 30, z: 5 };
  const buriedPos = { x: 6, y: 31, z: 6 };
  const unloadedPos = { x: 7, y: 32, z: 7 };
  // monde : iron exposé (voisin +x air), diamond enterré, position non chargée → null
  const w = (x, y, z) => {
    if (x === 5 && y === 30 && z === 5) return 'iron_ore';
    if (x === 6 && y === 30 && z === 5) return 'air'; // voisin +x de l'iron → exposé
    if (x === 6 && y === 31 && z === 6) return 'diamond_ore';
    if (x === 7 && y === 32 && z === 7) return 'unloaded';
    return 'stone';
  };
  let received = null;
  const bot = makeBot(w, {
    registry: makeRegistry({ iron_ore: { id: 10 }, diamond_ore: { id: 11 } }),
    findBlocks(opts) { received = opts; return [exposedPos, buriedPos, unloadedPos]; },
  });
  const out = scanExposedOres(bot);
  assert.deepStrictEqual(received, { matching: [10, 11], maxDistance: 48, count: 40 });
  assert.deepStrictEqual(out, [{ material: 'iron_ore', x: 5, y: 30, z: 5 }]);
});

test('scanExposedOres : noms absents du registry → skip (pas de crash)', () => {
  // registry sans ancient_debris ni la plupart → ne garde que iron_ore
  const w = (x, y, z) => {
    if (x === 0 && y === 10 && z === 0) return 'iron_ore';
    if (x === 1 && y === 10 && z === 0) return 'air';
    return 'stone';
  };
  let received = null;
  const bot = makeBot(w, {
    registry: makeRegistry({ iron_ore: { id: 10 } }),
    findBlocks(opts) { received = opts; return [{ x: 0, y: 10, z: 0 }]; },
  });
  const out = scanExposedOres(bot);
  assert.deepStrictEqual(received.matching, [10]); // seul id résolu
  assert.deepStrictEqual(out, [{ material: 'iron_ore', x: 0, y: 10, z: 0 }]);
});

test('scanExposedOres : registry vide → [] sans appeler findBlocks', () => {
  let called = false;
  const bot = makeBot(() => 'stone', {
    registry: makeRegistry({}),
    findBlocks() { called = true; return []; },
  });
  assert.deepStrictEqual(scanExposedOres(bot), []);
  assert.strictEqual(called, false);
});

test('scanExposedOres : findBlocks throw → []', () => {
  const bot = makeBot(() => 'stone', {
    registry: makeRegistry({ iron_ore: { id: 10 } }),
    findBlocks() { throw new Error('boom'); },
  });
  assert.deepStrictEqual(scanExposedOres(bot), []);
});

test('scanExposedOres : blockAt null sur une position → skip', () => {
  const bot = makeBot(() => 'unloaded', {
    registry: makeRegistry({ iron_ore: { id: 10 } }),
    findBlocks() { return [{ x: 0, y: 0, z: 0 }]; },
  });
  assert.deepStrictEqual(scanExposedOres(bot), []);
});

// ─── exposedOreFoundEvent ────────────────────────────────────────────────────

test('exposedOreFoundEvent : shape exacte + floor des coords fractionnaires', () => {
  const ev = exposedOreFoundEvent('overworld', 'diamond_ore', { x: 12.7, y: 11.2, z: -3.9 });
  assert.deepStrictEqual(ev, {
    type: 'exposed_ore_found', world: 'overworld', material: 'diamond_ore',
    x: 12, y: 11, z: -4,
  });
});

// ─── ORE_NAMES ───────────────────────────────────────────────────────────────

test('ORE_NAMES contient les minerais clés', () => {
  assert.ok(Array.isArray(ORE_NAMES));
  for (const n of ['coal_ore', 'iron_ore', 'diamond_ore', 'deepslate_diamond_ore', 'ancient_debris']) {
    assert.ok(ORE_NAMES.includes(n), `manque ${n}`);
  }
});

// ─── scanAllOres : scan COMPLET (exposés + enfouis, flag exposed) ───
const v = (x, y, z) => ({ x, y, z });

test('scanAllOres : retourne exposés ET enfouis avec flag exposed', () => {
  const world = (x, y, z) => {
    if (x === 5 && y === 40 && z === 5) return 'iron_ore';        // exposé (air au-dessus)
    if (x === 5 && y === 41 && z === 5) return 'air';
    if (x === 8 && y === -50 && z === 8) return 'deepslate_diamond_ore'; // enterré (stone autour)
    return 'stone';
  };
  const bot = makeBot(world);
  bot.registry = { blocksByName: { iron_ore: { id: 10 }, deepslate_diamond_ore: { id: 11 } } };
  bot.findBlocks = () => [v(5, 40, 5), v(8, -50, 8)];
  const out = scanAllOres(bot);
  assert.strictEqual(out.length, 2);
  const exp = out.find((o) => o.material === 'iron_ore');
  const bur = out.find((o) => o.material === 'deepslate_diamond_ore');
  assert.deepStrictEqual(exp, { material: 'iron_ore', x: 5, y: 40, z: 5, exposed: true, wet: false });
  assert.deepStrictEqual(bur, { material: 'deepslate_diamond_ore', x: 8, y: -50, z: 8, exposed: false, wet: false });
});

test('scanAllOres : ne matche que QUOTA_ORE_NAMES (5 matériaux × 2 variantes)', () => {
  assert.strictEqual(QUOTA_ORE_NAMES.length, 10);
  for (const m of ['diamond', 'gold', 'redstone', 'lapis', 'iron']) {
    assert.ok(QUOTA_ORE_NAMES.includes(m + '_ore'), m + '_ore manquant');
    assert.ok(QUOTA_ORE_NAMES.includes('deepslate_' + m + '_ore'), 'deepslate_' + m + '_ore manquant');
  }
  // registry sans certains noms → skip silencieux (vieille version MC)
  const bot = makeBot(() => 'stone');
  bot.registry = { blocksByName: { iron_ore: { id: 10 } } };
  let asked = null;
  bot.findBlocks = (q) => { asked = q.matching; return []; };
  scanAllOres(bot);
  assert.deepStrictEqual(asked, [10]);
});

test('scanAllOres : best-effort — bot incomplet → []', () => {
  assert.deepStrictEqual(scanAllOres(null), []);
  assert.deepStrictEqual(scanAllOres({}), []);
  const bot = makeBot(() => 'stone');
  bot.registry = null; bot.findBlocks = () => { throw new Error('boom'); };
  assert.deepStrictEqual(scanAllOres(bot), []);
});

test('oresFoundEvent : event batché {type:ores_found, world, ores}', () => {
  const ev = oresFoundEvent('overworld', [
    { material: 'iron_ore', x: 1.7, y: 40.2, z: -3.9, exposed: true },
    { material: 'diamond_ore', x: 2, y: -50, z: 3, exposed: false },
  ]);
  assert.strictEqual(ev.type, 'ores_found');
  assert.strictEqual(ev.world, 'overworld');
  assert.strictEqual(ev.ores.length, 2);
  assert.deepStrictEqual(ev.ores[0], { material: 'iron_ore', x: 1, y: 40, z: -4, exposed: true, wet: false });  // floored
  assert.deepStrictEqual(ev.ores[1], { material: 'diamond_ore', x: 2, y: -50, z: 3, exposed: false, wet: false });
});

test('nextOreTarget : allowTypes restreint aux types de base demandés (mode quota)', () => {
  const memory = { worlds: { w: { ores: [
    { material: 'deepslate_diamond_ore', x: 100, y: -55, z: 0 },
    { material: 'iron_ore', x: 1, y: 40, z: 0 },
    { material: 'redstone_ore', x: 2, y: -20, z: 0 },
  ] } } };
  const from = { x: 0, y: 40, z: 0 };
  // seul iron est encore manquant → l'iron_ore est choisi malgré la priorité diamant
  const t = ores.nextOreTarget(memory, 'w', from, { allowTypes: ['iron'] });
  assert.strictEqual(t.material, 'iron_ore');
  // aucun type permis présent → null
  assert.strictEqual(ores.nextOreTarget(memory, 'w', from, { allowTypes: ['gold'] }), null);
  // sans allowTypes : comportement inchangé (diamant prioritaire)
  assert.strictEqual(ores.nextOreTarget(memory, 'w', from, {}).material, 'deepslate_diamond_ore');
});

test('scanAllOres : portée par défaut couvre la deepslate diamond depuis la surface (≥200)', () => {
  const bot = makeBot(() => 'stone');
  bot.registry = { blocksByName: { iron_ore: { id: 10 } } };
  let captured = null;
  bot.findBlocks = (q) => { captured = q; return []; };
  scanAllOres(bot);
  assert.ok(captured.maxDistance >= 200, `maxDistance ${captured.maxDistance} trop court pour y=-59 depuis la surface`);
  assert.ok(captured.count >= 2000);
});

// --- driestCell (warp near-spawn DRY-AWARE — anti boucle de noyade, BUG PRIO #4/2.4) ---
test('driestCell : choisit la cellule la PLUS SÈCHE près du spawn (anti boucle de noyade)', () => {
  // 2 cellules mappées near-spawn : l'une noyée (wet), l'autre sèche. Le warp doit viser la SÈCHE
  // — le hardcodé (208,528) tombait dans l'eau en world_fresh2 (24-36% wet) → drown loop live.
  const o = [];
  for (let i = 0; i < 8; i++) o.push({ material: 'iron_ore', x: 50 + i, y: 30, z: 50, wet: true });   // WET ~ (50,50)
  for (let i = 0; i < 8; i++) o.push({ material: 'diamond_ore', x: 300 + i, y: -50, z: 300, wet: false }); // SEC ~ (300,300)
  const c = ores.driestCell(o, { base: { x: 0, z: 0 }, range: 800, cellSize: 96 });
  assert.ok(c, 'une cellule sèche est trouvée');
  assert.ok(Math.abs(c.x - 300) < 96 && Math.abs(c.z - 300) < 96, `centre sec attendu ~ (300,300), got (${c.x},${c.z})`);
  assert.strictEqual(c.wetFraction, 0, `cellule choisie sèche (wetFraction=${c.wetFraction})`);
});

test('driestCell : ignore les cellules HORS rayon near-spawn (anti-dispersion)', () => {
  const o = [];
  for (let i = 0; i < 8; i++) o.push({ material: 'iron_ore', x: 5000 + i, y: 30, z: 5000, wet: false });
  const c = ores.driestCell(o, { base: { x: 0, z: 0 }, range: 800, cellSize: 96 });
  assert.strictEqual(c, null, 'aucune cellule dans le rayon → null (l\'appelant retombe sur le hardcodé)');
});

test('driestCell : exige un minimum de minerais mappés (cellule réelle, pas du bruit)', () => {
  const o = [{ material: 'iron_ore', x: 100, y: 30, z: 100, wet: false }];
  const c = ores.driestCell(o, { base: { x: 0, z: 0 }, range: 800, cellSize: 96, minOres: 8 });
  assert.strictEqual(c, null, 'cellule sous le seuil minOres → null');
});

test('driestCell : opts.material filtre par matériau de base (fer, deepslate inclus)', () => {
  // Steering STRATÉGIQUE sans-give (mur de l'eau) : la chaîne iron_armor doit viser une cellule
  // sèche RICHE EN FER — pas une cellule sèche de charbon plus proche. deepslate_iron_ore compte
  // comme fer (oreBase).
  const o = [];
  for (let i = 0; i < 12; i++) o.push({ material: 'coal_ore', x: 100 + i, y: 30, z: 100, wet: false });        // SEC charbon, plus proche
  for (let i = 0; i < 12; i++) o.push({ material: 'deepslate_iron_ore', x: 300 + i, y: 12, z: 300, wet: false }); // SEC fer, plus loin
  const c = ores.driestCell(o, { base: { x: 0, z: 0 }, range: 800, cellSize: 96, minOres: 8, material: 'iron' });
  assert.ok(c, 'une cellule fer sèche est trouvée');
  assert.ok(Math.abs(c.x - 300) < 96 && Math.abs(c.z - 300) < 96, `cellule FER attendue ~ (300,300), got (${c.x},${c.z})`);
  // rétro-compat : sans material, la plus proche des deux (charbon) gagne comme avant
  const all = ores.driestCell(o, { base: { x: 0, z: 0 }, range: 800, cellSize: 96, minOres: 8 });
  assert.ok(Math.abs(all.x - 100) < 96, `sans material, comportement historique (cellule proche), got (${all.x},${all.z})`);
});

test('driestCell : material sans cellule éligible → null', () => {
  const o = [];
  for (let i = 0; i < 12; i++) o.push({ material: 'coal_ore', x: 100 + i, y: 30, z: 100, wet: false });
  const c = ores.driestCell(o, { base: { x: 0, z: 0 }, range: 800, cellSize: 96, minOres: 8, material: 'iron' });
  assert.strictEqual(c, null, 'aucun fer mappé → null (l\'appelant descend sur place comme avant)');
});
