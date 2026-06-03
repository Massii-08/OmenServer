'use strict';
// Boucle de cartographie (1b) : ERRANCE ORGANIQUE (#4 — pas de cercles), anti-océan (#5),
// secteur multi-mappers, skip cellules mappées, fallback retour maison, biome_seen / cave_found.
const { test } = require('node:test');
const assert = require('node:assert');
const vec3 = require('vec3');
const { pickWanderTarget, isOceanCell, waterAhead, cellKey, runMapper } = require('./mapper');
const { headingOf, sectorRange, inSector } = require('./sectors');

// rng déterministe cyclant sur une séquence
function seqRng(seq) { let i = 0; return () => seq[i++ % seq.length]; }

// --- cellKey / isOceanCell (purs) ---

test('cellKey : quantifie sur la grille 128 (même cellule → même clé)', () => {
  assert.strictEqual(cellKey(10, 20), cellKey(100, 120));
  assert.notStrictEqual(cellKey(10, 20), cellKey(200, 20));
  assert.strictEqual(cellKey(-5, 0), cellKey(-120, 100)); // floor (pas trunc) côté négatif
});

test('isOceanCell : cellule avec biome océan connu → true ; terre/inconnu → false', () => {
  const memory = { worlds: { overworld: { biomes: [
    { name: 'deep_ocean', x: 300, z: 40 },
    { name: 'forest', x: 30, z: 40 },
  ], caves: [] } } };
  assert.ok(isOceanCell(memory, 'overworld', 310, 50));      // même cellule 128 que deep_ocean
  assert.ok(!isOceanCell(memory, 'overworld', 30, 40));      // forêt
  assert.ok(!isOceanCell(memory, 'overworld', -500, -500));  // inconnu
  assert.ok(!isOceanCell(null, 'overworld', 310, 50));
});

// --- pickWanderTarget (pur) ---

test('pickWanderTarget : cible à distance [minDist..maxDist], heading rendu', () => {
  const pos = { x: 0, y: 64, z: 0 };
  const t = pickWanderTarget(pos, { rng: seqRng([0.3, 0.5]), minDist: 48, maxDist: 144 });
  assert.ok(t && typeof t.heading === 'number');
  const d = Math.sqrt(t.x * t.x + t.z * t.z);
  assert.ok(d >= 48 - 1e-9 && d <= 144 + 1e-9, `distance ${d} hors [48..144]`);
});

test('pickWanderTarget : caps ALÉATOIRES — pas de quadrillage régulier (deux seeds ≠ deux cibles ≠)', () => {
  const pos = { x: 0, y: 64, z: 0 };
  const a = pickWanderTarget(pos, { rng: seqRng([0.1, 0.5]) });
  const b = pickWanderTarget(pos, { rng: seqRng([0.8, 0.2]) });
  assert.ok(Math.abs(a.heading - b.heading) > 0.5, 'les caps devraient différer (aléatoire)');
});

test('pickWanderTarget : biais continuation — 70% des tirages restent à ±60° du cap précédent', () => {
  const pos = { x: 0, y: 64, z: 0 };
  // rng: 0.5 (<0.7 → continuation), 0.5 (delta=0), 0.5 (dist)
  const t = pickWanderTarget(pos, { rng: seqRng([0.5]), lastHeading: 1.0 });
  assert.ok(Math.abs(t.heading - 1.0) <= Math.PI / 3 + 1e-9, 'cap hors du cône de continuation');
});

test('pickWanderTarget : secteur — la cible vue depuis HOME reste dans le wedge du mapper', () => {
  const home = { x: 0, y: 64, z: 0 };
  const range = sectorRange(1, 2);
  for (let s = 0; s < 20; s++) {
    const t = pickWanderTarget({ x: 10, y: 64, z: 5 }, {
      rng: seqRng([(s * 37 % 100) / 100, 0.6, 0.2, 0.9]), sector: { index: 1, count: 2 }, home,
    });
    if (!t) continue; // tirage épuisé → acceptable
    assert.ok(inSector(headingOf(home, t), range), `cible hors secteur: ${t.x},${t.z}`);
  }
});

test('pickWanderTarget : skip cellules mappées (mémoire + localSeen) et océans connus', () => {
  const pos = { x: 0, y: 64, z: 0 };
  const rng = seqRng([0.0, 0.5]); // heading 0 (est), dist médiane → cellule (64..96, ~0)
  const t0 = pickWanderTarget(pos, { rng: seqRng([0.0, 0.5]) });
  // 1) la cellule de t0 en mémoire → un tirage identique doit donner autre chose (ou null)
  const memory = { worlds: { w: { biomes: [{ name: 'plains', x: t0.x, z: t0.z }], caves: [] } } };
  const t1 = pickWanderTarget(pos, { rng: seqRng([0.0, 0.5]), memory, worldKey: 'w', tries: 1 });
  assert.strictEqual(t1, null, 'cellule mappée → tirage rejeté');
  // 2) même cellule en biome océan → rejetée aussi
  const memOcean = { worlds: { w: { biomes: [{ name: 'ocean', x: t0.x, z: t0.z }], caves: [] } } };
  assert.strictEqual(pickWanderTarget(pos, { rng: seqRng([0.0, 0.5]), memory: memOcean, worldKey: 'w', tries: 1 }), null);
  // 3) localSeen
  const seen = new Set([cellKey(t0.x, t0.z)]);
  assert.strictEqual(pickWanderTarget(pos, { rng: seqRng([0.0, 0.5]), localSeen: seen, tries: 1 }), null);
});

test('pickWanderTarget : borne maxRange autour de home + isLand rejette l\'eau', () => {
  // trop loin de la maison → rejeté
  const far = pickWanderTarget({ x: 2000, y: 64, z: 0 }, {
    rng: seqRng([0.0, 0.5]), home: { x: 0, y: 64, z: 0 }, maxRange: 1024, tries: 1,
  });
  assert.strictEqual(far, null);
  // isLand false partout → null (l'appelant rentre à la maison)
  const wet = pickWanderTarget({ x: 0, y: 64, z: 0 }, { rng: seqRng([0.3, 0.5]), isLand: () => false, tries: 5 });
  assert.strictEqual(wet, null);
});

// --- waterAhead (fake bot Vec3) ---

test('waterAhead : surface d\'eau droit devant → true ; terre → false ; non chargé → false', () => {
  const mkBot = (surface) => ({
    blockAt(p) {
      if (surface === null) return null;                                  // non chargé
      if (p.y > 63) return { name: 'air', boundingBox: 'empty' };
      return surface === 'water'
        ? { name: 'water', boundingBox: 'empty' }
        : { name: 'grass_block', boundingBox: 'block' };
    },
  });
  const from = { x: 0, y: 64, z: 0 };
  assert.ok(waterAhead(mkBot('water'), from, { x: 100, z: 0 }));
  assert.ok(!waterAhead(mkBot('land'), from, { x: 100, z: 0 }));
  assert.ok(!waterAhead(mkBot(null), from, { x: 100, z: 0 }));
});

// --- runMapper (boucle, fake bot Vec3) ---

function fakeMapperBot({ caveAt = null } = {}) {
  // sol = pierre pleine ; biome dépend de x ; option : colonne d'air (grotte) sous (caveAt.x, caveAt.z)
  const bot = {
    entity: { position: vec3(0, 64, 0), isInWater: false },
    entities: {},
    health: 20, food: 20,
    inventory: { items: () => [] },
    nearestEntity: () => null,
    findBlocks: () => [],
    setControlState: () => {},
    blockAt(p) {
      if (caveAt && Math.floor(p.x) === caveAt.x && Math.floor(p.z) === caveAt.z && p.y < 64 && p.y > 64 - 10) {
        return { name: 'air', boundingBox: 'empty', biome: { name: 'plains', id: 1 } };
      }
      if (p.y > 63) return { name: 'air', boundingBox: 'empty', biome: { name: 'plains', id: 1 } };
      const biome = p.x >= 200 ? { name: 'desert', id: 5 } : { name: 'plains', id: 1 };
      return { name: 'stone', boundingBox: 'block', biome };
    },
    pvp: { attack: () => {}, stop: () => {} },
    pathfinder: { setGoal: () => {}, goto: async () => {} },
    registry: { itemsByName: {} },
    equip: async () => {}, consume: async () => {},
  };
  return bot;
}

test('runMapper : émet biome_seen en errance, dédup par cellule, NE s\'arrête PAS après une trouvaille', async () => {
  const bot = fakeMapperBot();
  const events = [];
  const token = { cancelled: false };
  await runMapper(bot, {
    worldKey: 'overworld',
    emit: (e) => {
      events.push(e);
      if (events.filter((x) => x.type === 'biome_seen').length >= 8 || events.length > 600) token.cancelled = true;
    },
    goto: async (wp) => { bot.entity.position = vec3(wp.x, 64, wp.z); },
    sleep: async () => {},
  }, token);
  const biomes = events.filter((e) => e.type === 'biome_seen');
  assert.ok(biomes.length >= 8, `seulement ${biomes.length} biome_seen — la boucle s'est arrêtée trop tôt`);
  const cells = biomes.map((e) => cellKey(e.x, e.z));
  assert.strictEqual(new Set(cells).size, cells.length, 'biome_seen dupliqué dans une même cellule');
  assert.ok(biomes.every((e) => e.world === 'overworld'));
});

test('runMapper : détecte une entrée de grotte en route → cave_found (coords seulement)', async () => {
  // reproduit le 1er tirage avec le même rng ET le même état (cellule d'origine déjà vue par le
  // record() initial) → la grotte est SOUS la 1re cible ; dist 0.9 → sort de la cellule d'origine
  const seq = [0.0, 0.9];
  const first = pickWanderTarget({ x: 0, y: 64, z: 0 }, { rng: seqRng(seq), localSeen: new Set([cellKey(0, 0)]) });
  const cave = { x: Math.floor(first.x), z: Math.floor(first.z) };
  const bot = fakeMapperBot({ caveAt: cave });
  const events = [];
  const token = { cancelled: false };
  await runMapper(bot, {
    worldKey: 'overworld',
    rng: seqRng(seq),
    emit: (e) => { events.push(e); if (e.type === 'cave_found' || events.length > 80) token.cancelled = true; },
    goto: async (wp) => { bot.entity.position = vec3(wp.x, 64, wp.z); },
    sleep: async () => {},
  }, token);
  const caves = events.filter((e) => e.type === 'cave_found');
  assert.strictEqual(caves.length, 1);
  assert.strictEqual(caves[0].world, 'overworld');
  assert.strictEqual(caves[0].x, cave.x);
  assert.ok(typeof caves[0].y === 'number' && typeof caves[0].z === 'number');
});

test('runMapper : secteur live (getSector) — toutes les cibles vues depuis home dans le wedge', async () => {
  const bot = fakeMapperBot();
  const gotos = [];
  const token = { cancelled: false };
  const home = { x: 0, y: 64, z: 0 };
  await runMapper(bot, {
    worldKey: 'overworld',
    emit: () => { if (gotos.length >= 6) token.cancelled = true; },
    goto: async (wp) => { gotos.push({ x: wp.x, z: wp.z }); bot.entity.position = vec3(wp.x, 64, wp.z); },
    getSector: () => ({ index: 1, count: 2 }),
    sleep: async () => {},
  }, token);
  assert.ok(gotos.length > 0);
  const range = sectorRange(1, 2);
  for (const g of gotos) {
    assert.ok(inSector(headingOf(home, g), range), `cible hors secteur: ${g.x},${g.z}`);
  }
});

test('runMapper : token déjà annulé → retour immédiat sans goto', async () => {
  const bot = fakeMapperBot();
  let moved = 0;
  await runMapper(bot, {
    worldKey: 'overworld', emit: () => {},
    goto: async () => { moved++; }, sleep: async () => {},
  }, { cancelled: true });
  assert.strictEqual(moved, 0);
});

test('runMapper : tout mappé autour → FALLBACK retour maison (mapper_return_home + goto home)', async () => {
  const bot = fakeMapperBot();
  bot.entity.position = vec3(500, 64, 500);
  // mémoire couvrant TOUT le rayon maxRange autour de home → aucune cible valable
  const biomes = [];
  for (let x = -1280; x <= 1280; x += 128) for (let z = -1280; z <= 1280; z += 128) biomes.push({ name: 'plains', x, z });
  const memory = { worlds: { overworld: { biomes, caves: [] } } };
  const events = [];
  const gotos = [];
  const token = { cancelled: false };
  await runMapper(bot, {
    worldKey: 'overworld', memory,
    home: { x: 500, y: 64, z: 500 }, maxRange: 512,
    emit: (e) => { events.push(e); if (e.type === 'mapper_return_home') token.cancelled = true; },
    goto: async (wp) => { gotos.push(wp); },
    sleep: async () => {},
  }, token);
  assert.ok(events.some((e) => e.type === 'mapper_return_home'));
});

test('runMapper : survie prioritaire — hostile×3 → fuit avant de bouger (survivalTick branché)', async () => {
  const bot = fakeMapperBot();
  for (let i = 0; i < 3; i++) {
    bot.entities[i] = { name: 'zombie', kind: 'Hostile mobs', type: 'mob', position: vec3(2 + i, 64, 0), isValid: true };
  }
  const events = [];
  let fled = 0;
  const token = { cancelled: false };
  await runMapper(bot, {
    worldKey: 'overworld',
    emit: (e) => { events.push(e); if (fled >= 1 && events.length > 2) token.cancelled = true; },
    goto: async (wp) => { bot.entity.position = vec3(wp.x, 64, wp.z); },
    fleeFrom: () => { fled++; bot.entities = {}; return true; },
    sleep: async () => {},
  }, token);
  assert.ok(fled >= 1, 'fleeFrom jamais appelé malgré 3 hostiles');
  assert.ok(events.some((e) => e.type === 'survival' && e.action === 'flee'));
});

test('runMapper : dans l\'eau au départ → escapeWater AVANT de router (#1)', async () => {
  const bot = fakeMapperBot();
  bot.entity.isInWater = true;
  bot.findBlocks = () => [vec3(8, 64, 0)];           // une terre ferme à 8 blocs
  bot.blockAt = (p) => {
    if (p.x === 8 && p.z === 0) {
      if (p.y === 64) return { name: 'grass_block', boundingBox: 'block', biome: { name: 'plains', id: 1 } };
      return { name: 'air', boundingBox: 'empty', biome: { name: 'plains', id: 1 } };
    }
    if (p.y > 63) return { name: 'air', boundingBox: 'empty', biome: { name: 'plains', id: 1 } };
    return { name: 'water', boundingBox: 'empty', biome: { name: 'ocean', id: 0 } };
  };
  bot.pathfinder.goto = async () => { bot.entity.isInWater = false; };  // sortir = atteindre la terre
  const events = [];
  const token = { cancelled: false };
  await runMapper(bot, {
    worldKey: 'overworld',
    emit: (e) => { events.push(e); if (events.some((x) => x.type === 'unstuck_done')) token.cancelled = true; },
    goto: async (wp) => { bot.entity.position = vec3(wp.x, 64, wp.z); },
    sleep: async () => {},
  }, token);
  assert.ok(events.some((e) => e.type === 'unstuck' && e.cause === 'water'), 'escapeWater jamais déclenché');
});

test('runMapper : résout le nom de biome via bot.registry quand block.biome n\'a qu\'un id (vu live 1.21.4)', async () => {
  const bot = fakeMapperBot();
  bot.registry.biomes = { 28: { name: 'jungle' } };
  bot.blockAt = (p) => ({ name: 'stone', boundingBox: 'block', biome: { id: 28, name: '' } });
  const events = [];
  const token = { cancelled: false };
  await runMapper(bot, {
    worldKey: 'overworld',
    emit: (e) => { events.push(e); if (events.filter((x) => x.type === 'biome_seen').length >= 2) token.cancelled = true; },
    goto: async (wp) => { bot.entity.position = vec3(wp.x, 64, wp.z); },
    sleep: async () => {},
  }, token);
  const biomes = events.filter((e) => e.type === 'biome_seen');
  assert.ok(biomes.length >= 1);
  assert.strictEqual(biomes[0].name, 'jungle'); // résolu via registry, pas null
  assert.strictEqual(biomes[0].id, 28);
});
