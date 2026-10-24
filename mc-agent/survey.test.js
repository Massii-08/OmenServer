'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { createSurvey, isSurfaceSample, oreScanDue } = require('./survey');

// Faux bot : biome par cellule, ciel visible si skyLight fourni, un diamant à (5,-54,5).
function fakeBot({ y = 70, skyLight = 15, ores = [{ x: 5, y: -54, z: 5 }] } = {}) {
  const pos = { x: 10, y, z: 10 };
  return {
    entity: { position: pos },
    registry: { blocksByName: { diamond_ore: { id: 1 }, deepslate_diamond_ore: { id: 2 } }, biomes: {} },
    blockAt: (q) => {
      if (ores.some((o) => o.x === q.x && o.y === q.y && o.z === q.z)) return { name: 'deepslate_diamond_ore', boundingBox: 'block', biome: { name: 'deep_dark' } };
      return { name: 'air', boundingBox: 'empty', skyLight, biome: { name: q.x < 0 ? 'forest' : 'plains' } };
    },
    findBlocks: () => ores.map((o) => ({ x: o.x, y: o.y, z: o.z })),
    calls: 0,
  };
}

test('isSurfaceSample / oreScanDue', () => {
  assert.strictEqual(isSurfaceSample({ y: -54, skyLight: 0 }), false);
  assert.strictEqual(isSurfaceSample({ y: 64, skyLight: 15 }), true);
  assert.strictEqual(isSurfaceSample({ y: 64 }), true);
  assert.strictEqual(isSurfaceSample({ y: 20 }), false);
  assert.strictEqual(oreScanDue({ pos: { x: 0, y: 0, z: 0 }, last: null, now: 1 }), true);
  const last = { pos: { x: 0, y: 0, z: 0 }, at: 0 };
  assert.strictEqual(oreScanDue({ pos: { x: 10, y: 0, z: 0 }, last, now: 1000 }), false);
  assert.strictEqual(oreScanDue({ pos: { x: 30, y: 0, z: 0 }, last, now: 1000 }), true);
  assert.strictEqual(oreScanDue({ pos: { x: 0, y: 0, z: 0 }, last, now: 11 * 60000 }), true);
});

test('en surface : biome de la cellule + anneau voisin, et minerais émis une seule fois', () => {
  const ev = [];
  let t = 1000;
  const s = createSurvey({ emit: (e) => ev.push(e), now: () => t, worldKey: () => 'w1' });
  const bot = fakeBot();
  const r = s.tick(bot, {});
  assert.ok(r.biomes >= 9, 'cellule + 8 voisines : ' + r.biomes);
  assert.strictEqual(r.ores, 1);
  const bs = ev.filter((e) => e.type === 'biome_seen');
  assert.ok(bs.some((e) => e.name === 'forest') && bs.some((e) => e.name === 'plains'));
  assert.ok(bs.every((e) => e.world === 'w1'));
  const of = ev.filter((e) => e.type === 'ores_found');
  assert.strictEqual(of.length, 1);
  assert.strictEqual(of[0].ores[0].material, 'deepslate_diamond_ore');
  // throttle : 2e passe trop tôt → rien
  assert.strictEqual(s.tick(bot, {}), null);
  t += 46000;
  bot.entity.position.x += 40;   // assez bougé pour rescanner : le même diamant n'est pas ré-émis
  const r2 = s.tick(bot, {});
  assert.strictEqual(r2.ores, 0);
  assert.strictEqual(ev.filter((e) => e.type === 'ores_found').length, 1);
});

test('sous terre : pas de biome (on ne peint pas les grottes), mais les minerais oui', () => {
  const ev = [];
  const s = createSurvey({ emit: (e) => ev.push(e), now: () => 5000 });
  const r = s.tick(fakeBot({ y: -54, skyLight: 0 }), {});
  assert.strictEqual(r.biomes, 0);
  assert.strictEqual(r.ores, 1);
  assert.strictEqual(ev.filter((e) => e.type === 'biome_seen').length, 0);
});

test('occupé (combat, dig, craft) → rien, et la passe n est pas consommée', () => {
  const ev = [];
  const s = createSurvey({ emit: (e) => ev.push(e), now: () => 5000 });
  const bot = fakeBot();
  assert.strictEqual(s.tick(bot, { busy: true }), null);
  assert.strictEqual(ev.length, 0);
  assert.ok(s.tick(bot, {}), 'dès que libre, la passe a lieu');
});

test('jamais de throw : bot sans position / blockAt qui lève', () => {
  const s = createSurvey({ now: () => 1 });
  assert.strictEqual(s.tick({}, {}), null);
  const bot = fakeBot();
  bot.blockAt = () => { throw new Error('chunk'); };
  bot.findBlocks = () => { throw new Error('x'); };
  const r = s.tick(bot, {});
  assert.deepStrictEqual(r, { biomes: 0, ores: 0 });
});
