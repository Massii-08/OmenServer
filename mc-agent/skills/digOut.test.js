'use strict';
// Escalier vers la surface (20/10, NethBot1 emmuré à (-43,40,-340) sans home).
const { test } = require('node:test');
const assert = require('node:assert');
const { Vec3 } = require('vec3');
const { digOut, stairStep, isOutside, dirIndexFromYaw } = require('./digOut');

// Monde : pierre pleine sous `surface`, air au-dessus ; overrides "x,y,z" → nom.
function makeWorld({ surface = 60, over = {} } = {}) {
  const dug = new Set();
  const key = (x, y, z) => `${x},${y},${z}`;
  const read = (x, y, z) => {
    const k = key(x, y, z);
    if (dug.has(k)) return { name: 'air', boundingBox: 'empty' };
    if (over[k]) return { name: over[k], boundingBox: over[k] === 'air' || over[k] === 'water' ? 'empty' : 'block' };
    return y < surface ? { name: 'stone', boundingBox: 'block' } : { name: 'air', boundingBox: 'empty' };
  };
  return { read, dug, key };
}

function makeBot(world, start) {
  const digs = [];
  const bot = {
    entity: { position: new Vec3(start.x + 0.5, start.y, start.z + 0.5), yaw: 0 },
    inventory: { items: () => [{ name: 'iron_pickaxe', count: 1 }] },
    blockAt(p) {
      const b = world.read(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z));
      return Object.assign({ position: new Vec3(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)) }, b);
    },
    async equip() {},
    async dig(b) { digs.push(b.name); world.dug.add(world.key(b.position.x, b.position.y, b.position.z)); },
  };
  return { bot, digs };
}
const teleportStep = (bot, to) => { bot.entity.position = new Vec3(to.x + 0.5, to.y, to.z + 0.5); return true; };

test('stairStep : pierre pleine → 3 cases à creuser, marche à +1', () => {
  const w = makeWorld();
  const s = stairStep(w.read, { x: 0, y: 40, z: 0 }, { dx: 1, dz: 0 });
  assert.strictEqual(s.act, 'step');
  assert.deepStrictEqual(s.to, { x: 1, y: 41, z: 0 });
  assert.strictEqual(s.dig.length, 3);
});

test('stairStep : eau au-dessus de la marche → blocked fluid (on ne la lâche pas dans l’escalier)', () => {
  const w = makeWorld({ over: { '1,43,0': 'water' } });
  assert.deepStrictEqual(stairStep(w.read, { x: 0, y: 40, z: 0 }, { dx: 1, dz: 0 }), { act: 'blocked', why: 'fluid' });
});

test('stairStep : eau sur le flanc d’une case ouverte → blocked fluid', () => {
  const w = makeWorld({ over: { '2,41,0': 'water' } });
  assert.strictEqual(stairStep(w.read, { x: 0, y: 40, z: 0 }, { dx: 1, dz: 0 }).why, 'fluid');
});

test('stairStep : bedrock → unbreakable ; vide sous la marche → no_floor', () => {
  const w = makeWorld({ over: { '1,41,0': 'bedrock' } });
  assert.strictEqual(stairStep(w.read, { x: 0, y: 40, z: 0 }, { dx: 1, dz: 0 }).why, 'unbreakable');
  const w2 = makeWorld({ over: { '1,40,0': 'air' } });
  assert.strictEqual(stairStep(w2.read, { x: 0, y: 40, z: 0 }, { dx: 1, dz: 0 }).why, 'no_floor');
});

test('isOutside : ciel ouvert au-dessus de minY oui, poche souterraine non, feuillage ignoré', () => {
  const w = makeWorld({ over: { '0,63,0': 'oak_leaves' } });
  assert.strictEqual(isOutside(w.read, { x: 0, y: 60, z: 0 }), true);
  assert.strictEqual(isOutside(w.read, { x: 0, y: 40, z: 0 }), false);
  // grande grotte ouverte mais sous minY : pas « dehors »
  const cave = makeWorld({ surface: 30 });
  assert.strictEqual(isOutside(cave.read, { x: 0, y: 40, z: 0 }), false);
  // lumière du ciel pleine sur la tête : dehors même sous minY (plaine basse)
  const lowRead = (x, y, z) => ({ name: 'air', boundingBox: 'empty', skyLight: 15 });
  assert.strictEqual(isOutside(lowRead, { x: 0, y: 50, z: 0 }), true);
});

test('digOut : NethBot1 emmuré à y40 → escalier jusqu’à la surface', async () => {
  const w = makeWorld({ surface: 60 });
  const { bot } = makeBot(w, { x: -43, y: 40, z: -340 });
  const r = await digOut(bot, { stepUp: teleportStep, sleep: async () => {} });
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  assert.ok(bot.entity.position.y >= 58);
  assert.strictEqual(r.steps, 18);
});

test('digOut : eau dans la première direction → tourne et sort quand même', async () => {
  const over = {};
  for (let y = 41; y <= 60; y++) over[`2,${y},0`] = "water";   // nappe à 2 blocs côté +x (comme NethBot1)
  const w = makeWorld({ over });
  const { bot } = makeBot(w, { x: 0, y: 40, z: 0 });
  const r = await digOut(bot, { stepUp: teleportStep, sleep: async () => {}, startDir: 0 });
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  assert.notDeepStrictEqual(r.dir, { dx: 1, dz: 0 });
});

test('digOut : fluide partout autour → all_blocked:fluid, rien creusé', async () => {
  const over = { '0,42,0': 'water' };   // au-dessus de la tête : H refusé dans les 4 directions
  const w = makeWorld({ over });
  const { bot, digs } = makeBot(w, { x: 0, y: 40, z: 0 });
  const r = await digOut(bot, { stepUp: teleportStep, sleep: async () => {} });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'all_blocked:fluid');
  assert.strictEqual(digs.length, 0);
});

test('digOut : borné en temps', async () => {
  const w = makeWorld();
  const { bot } = makeBot(w, { x: 0, y: 40, z: 0 });
  let t = 0;
  const r = await digOut(bot, { now: () => (t += 10000), maxMs: 30000, stepUp: teleportStep, sleep: async () => {} });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'timeout');
});

test('digOut : annulé par le jeton', async () => {
  const w = makeWorld();
  const { bot } = makeBot(w, { x: 0, y: 40, z: 0 });
  const r = await digOut(bot, { stepUp: teleportStep, sleep: async () => {} }, { cancelled: true });
  assert.strictEqual(r.reason, 'cancelled');
});

test('digOut : sauts ratés → change de direction puis abandonne proprement', async () => {
  const w = makeWorld();
  const { bot } = makeBot(w, { x: 0, y: 40, z: 0 });
  const r = await digOut(bot, { stepUp: () => false, sleep: async () => {} });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'all_blocked:no_progress');
});

test('dirIndexFromYaw : cardinal du regard', () => {
  assert.strictEqual(dirIndexFromYaw(0), 1);          // yaw 0 → +z
  assert.strictEqual(dirIndexFromYaw(Math.PI), 3);    // → -z
});
