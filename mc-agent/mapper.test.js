'use strict';
// Boucle de cartographie (1b) : exploration CONTINUE en anneaux (sans « trouvé→stop »),
// secteur multi-mappers, skip des cellules déjà mappées, émission biome_seen / cave_found.
const { test } = require('node:test');
const assert = require('node:assert');
const vec3 = require('vec3');
const { planBatch, cellKey, runMapper } = require('./mapper');
const { headingOf, sectorRange, inSector } = require('./sectors');

// --- planBatch (pur) ---

test('planBatch : anneaux entre fromRadius et toRadius seulement', () => {
  const wps = planBatch({ x: 0, y: 64, z: 0 }, { step: 80, fromRadius: 80, toRadius: 240 });
  assert.ok(wps.length > 0);
  for (const w of wps) {
    assert.ok(w.r > 80 && w.r <= 240, `r=${w.r} hors [80..240]`);
  }
});

test('planBatch : filtre secteur (waypoints dans le wedge du mapper 0/4 uniquement)', () => {
  const origin = { x: 0, y: 64, z: 0 };
  const wps = planBatch(origin, { step: 80, toRadius: 240, sector: { index: 0, count: 4 } });
  assert.ok(wps.length > 0);
  const range = sectorRange(0, 4);
  for (const w of wps) {
    assert.ok(inSector(headingOf(origin, w), range), `waypoint hors secteur: ${w.x},${w.z}`);
  }
  // un mapper full-circle a ~4x plus de waypoints
  const all = planBatch(origin, { step: 80, toRadius: 240 });
  assert.ok(wps.length < all.length);
});

test('planBatch : skip des cellules déjà en mémoire (bootstrap) ET des cellules locales', () => {
  const origin = { x: 0, y: 64, z: 0 };
  const all = planBatch(origin, { step: 80, toRadius: 160 });
  const target = all[0];
  const memory = { worlds: { overworld: { biomes: [{ name: 'plains', x: target.x, z: target.z }], caves: [] } } };
  const filtered = planBatch(origin, { step: 80, toRadius: 160, memory, worldKey: 'overworld' });
  assert.ok(!filtered.some((w) => cellKey(w.x, w.z) === cellKey(target.x, target.z)));
  // localSeen : même effet
  const seen = new Set([cellKey(all[1].x, all[1].z)]);
  const filtered2 = planBatch(origin, { step: 80, toRadius: 160, localSeen: seen });
  assert.ok(!filtered2.some((w) => cellKey(w.x, w.z) === cellKey(all[1].x, all[1].z)));
});

test('cellKey : quantifie sur la grille 128 (même cellule → même clé)', () => {
  assert.strictEqual(cellKey(10, 20), cellKey(100, 120));
  assert.notStrictEqual(cellKey(10, 20), cellKey(200, 20));
  assert.strictEqual(cellKey(-5, 0), cellKey(-120, 100)); // floor (pas trunc) côté négatif
});

// --- runMapper (boucle, fake bot Vec3) ---

function fakeMapperBot({ caveAt = null } = {}) {
  // sol = pierre pleine ; biome dépend de x (change par grandes bandes) ; option : colonne d'air (grotte)
  const bot = {
    entity: { position: vec3(0, 64, 0) },
    entities: {},
    health: 20, food: 20,
    inventory: { items: () => [] },
    nearestEntity: () => null,
    blockAt(p) {
      if (caveAt && Math.floor(p.x) === caveAt.x && Math.floor(p.z) === caveAt.z && p.y < 64 && p.y > 64 - 10) {
        return { name: 'air', boundingBox: 'empty', biome: { name: 'plains', id: 1 } };
      }
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

test('runMapper : émet biome_seen aux waypoints, dédup par cellule, et NE s\'arrête PAS après une trouvaille', async () => {
  const bot = fakeMapperBot();
  const events = [];
  const token = { cancelled: false };
  await runMapper(bot, {
    worldKey: 'overworld',
    emit: (e) => { events.push(e); if (events.filter((x) => x.type === 'biome_seen').length >= 8) token.cancelled = true; },
    goto: async (wp) => { bot.entity.position = vec3(wp.x, 64, wp.z); },
    step: 80, batchRadius: 240, sleep: async () => {},
  }, token);
  const biomes = events.filter((e) => e.type === 'biome_seen');
  assert.ok(biomes.length >= 8, `seulement ${biomes.length} biome_seen — la boucle s'est arrêtée trop tôt`);
  // dédup par cellule : pas 2 événements même cellule
  const cells = biomes.map((e) => cellKey(e.x, e.z));
  assert.strictEqual(new Set(cells).size, cells.length, 'biome_seen dupliqué dans une même cellule');
  // les events portent la clé de monde
  assert.ok(biomes.every((e) => e.world === 'overworld'));
});

test('runMapper : détecte une entrée de grotte en route → cave_found (coords seulement)', async () => {
  // sous le 1er waypoint réel HORS de la cellule d'origine (déjà marquée par le record() initial)
  const wp0 = planBatch({ x: 0, y: 64, z: 0 }, { step: 80, toRadius: 160, localSeen: new Set([cellKey(0, 0)]) })[0];
  const cave = { x: Math.floor(wp0.x), z: Math.floor(wp0.z) };
  const bot = fakeMapperBot({ caveAt: cave });
  const events = [];
  const token = { cancelled: false };
  await runMapper(bot, {
    worldKey: 'overworld',
    emit: (e) => { events.push(e); if (e.type === 'cave_found' || events.length > 60) token.cancelled = true; },
    goto: async (wp) => { bot.entity.position = vec3(wp.x, 64, wp.z); },
    step: 80, batchRadius: 160, sleep: async () => {},
  }, token);
  const caves = events.filter((e) => e.type === 'cave_found');
  assert.strictEqual(caves.length, 1);
  assert.strictEqual(caves[0].world, 'overworld');
  assert.strictEqual(caves[0].x, cave.x);
  assert.ok(typeof caves[0].y === 'number' && typeof caves[0].z === 'number');
});

test('runMapper : respecte le secteur live (getSector) — tous les gotos dans le wedge', async () => {
  const bot = fakeMapperBot();
  const gotos = [];
  const token = { cancelled: false };
  const origin = { x: 0, y: 64, z: 0 };
  await runMapper(bot, {
    worldKey: 'overworld',
    emit: () => { if (gotos.length >= 6) token.cancelled = true; },
    goto: async (wp) => { gotos.push({ x: wp.x, z: wp.z }); bot.entity.position = vec3(wp.x, 64, wp.z); },
    getSector: () => ({ index: 1, count: 2 }),
    step: 80, batchRadius: 240, sleep: async () => {},
  }, token);
  assert.ok(gotos.length > 0);
  const range = sectorRange(1, 2);
  // le 1er batch part de l'origine (0,0) — les gotos du batch initial doivent être dans le wedge
  for (const g of gotos.slice(0, 3)) {
    assert.ok(inSector(headingOf(origin, g), range), `goto hors secteur: ${g.x},${g.z}`);
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

test('runMapper : batch vide (tout déjà mappé) → regarde plus loin sans boucle chaude', async () => {
  const bot = fakeMapperBot();
  // mémoire bootstrap couvrant TOUTES les cellules jusqu'à 240 : le mapper doit sauter au-delà
  const biomes = [];
  for (let x = -512; x <= 512; x += 128) for (let z = -512; z <= 512; z += 128) biomes.push({ name: 'plains', x, z });
  const memory = { worlds: { overworld: { biomes, caves: [] } } };
  const gotos = [];
  const token = { cancelled: false };
  await runMapper(bot, {
    worldKey: 'overworld', memory,
    emit: () => {},
    goto: async (wp) => { gotos.push(wp); bot.entity.position = vec3(wp.x, 64, wp.z); if (gotos.length >= 2) token.cancelled = true; },
    step: 80, batchRadius: 240, sleep: async () => {},
  }, token);
  // il a fini par sortir de la zone couverte (r > 512 depuis l'origine)
  assert.ok(gotos.length > 0, 'aucun goto — bloqué sur la zone déjà mappée');
  for (const g of gotos) {
    assert.ok(Math.sqrt(g.x * g.x + g.z * g.z) > 512, `goto dans la zone déjà mappée: ${g.x},${g.z}`);
  }
});

test('runMapper : survie prioritaire — hostile×3 → fuit avant de bouger (survivalTick branché)', async () => {
  const bot = fakeMapperBot();
  // 3 zombies collés au bot
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
    fleeFrom: () => { fled++; bot.entities = {}; return true; }, // la fuite « résout » la menace
    step: 80, batchRadius: 160, sleep: async () => {},
  }, token);
  assert.ok(fled >= 1, 'fleeFrom jamais appelé malgré 3 hostiles');
  assert.ok(events.some((e) => e.type === 'survival' && e.action === 'flee'));
});

test('runMapper : résout le nom de biome via bot.registry quand block.biome n\'a qu\'un id (vu live 1.21.4)', async () => {
  const bot = fakeMapperBot();
  bot.registry.biomes = { 28: { name: 'jungle' } };
  bot.blockAt = (p) => ({ name: 'stone', boundingBox: 'block', biome: { id: 28 } }); // PAS de name
  const events = [];
  const token = { cancelled: false };
  await runMapper(bot, {
    worldKey: 'overworld',
    emit: (e) => { events.push(e); if (events.filter((x) => x.type === 'biome_seen').length >= 2) token.cancelled = true; },
    goto: async (wp) => { bot.entity.position = vec3(wp.x, 64, wp.z); },
    step: 80, batchRadius: 160, sleep: async () => {},
  }, token);
  const biomes = events.filter((e) => e.type === 'biome_seen');
  assert.ok(biomes.length >= 1);
  assert.strictEqual(biomes[0].name, 'jungle'); // résolu via registry, pas null
  assert.strictEqual(biomes[0].id, 28);
});
