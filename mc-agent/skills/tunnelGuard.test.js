'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { Vec3 } = require('vec3');
const G = require('./tunnelGuard');

// Monde : couloir est-ouest à z=0, y=16..17 ; tout le reste plein. `placed` = cases remplies par le bot.
function fakeBot({ health = 14, food = 18, sword = true, cobble = 16, mobs = [], y = 16, sky = 0 } = {}) {
  const filled = new Set();
  const key = (p) => `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`;
  const isAir = (p) => !filled.has(key(p)) && Math.floor(p.z) === 0 && (Math.floor(p.y) === y || Math.floor(p.y) === y + 1);
  const items = [];
  if (sword) items.push({ name: 'stone_sword', count: 1 });
  if (cobble) items.push({ name: 'cobblestone', count: cobble });
  const calls = { attack: [], place: [], flee: 0, eat: 0, stop: 0 };
  const entities = {};
  mobs.forEach((m, i) => { entities[i + 1] = { id: i + 1, name: m.name, kind: 'Hostile mobs', position: new Vec3(m.x, y, m.z) }; });
  const bot = {
    entity: { position: new Vec3(0.5, y, 0.5) }, health, food, entities,
    inventory: { items: () => items },
    blockAt: (p) => ({ name: isAir(p) ? 'air' : 'stone', boundingBox: isAir(p) ? 'empty' : 'block', skyLight: sky }),
    equip: async () => {},
    placeBlock: async (ref, face) => { const t = ref.position ? ref.position.plus(face) : null; calls.place.push(face); if (t) filled.add(key(t)); },
    pvp: { attack: (e) => calls.attack.push(e.name), stop: () => {} },
  };
  // blockAt doit porter sa position pour que placeBlock sache où poser
  const raw = bot.blockAt;
  bot.blockAt = (p) => Object.assign(raw(p), { position: new Vec3(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)) });
  return { bot, calls, filled };
}
const deps = (calls) => ({ fleeFrom: () => { calls.flee++; }, stopMotion: () => { calls.stop++; }, eat: async () => { calls.eat++; }, emit: () => {} });
const tick = () => new Promise((r) => setTimeout(r, 20));

test('tunnelFlee : armé dans le couloir, zombie à 3 blocs → frappe, ne fuit pas', () => {
  G._resetForTests();
  const { bot, calls } = fakeBot({ mobs: [{ name: 'zombie', x: 3.5, z: 0.5 }] });
  assert.strictEqual(G.tunnelFlee(bot, deps(calls)), 'hold');
  assert.deepStrictEqual(calls.attack, ['zombie']);
  assert.strictEqual(calls.flee, 0);
});

test('tunnelFlee : PV bas → mure le côté du mob (pieds + tête), mange, ne court pas', async () => {
  G._resetForTests();
  const { bot, calls, filled } = fakeBot({ health: 5, mobs: [{ name: 'zombie', x: 3.5, z: 0.5 }] });
  assert.strictEqual(G.tunnelFlee(bot, deps(calls)), 'wall');
  await tick();
  assert.ok(filled.has('1,16,0') && filled.has('1,17,0'), 'les deux cases côté est sont murées');
  assert.ok(!filled.has('-1,16,0'), 'le côté ouest reste ouvert');
  assert.strictEqual(calls.flee, 0);
  assert.strictEqual(calls.eat, 1);
});

test('tunnelFlee : en surface (ciel visible) → fuite habituelle', () => {
  G._resetForTests();
  const { bot, calls } = fakeBot({ y: 70, sky: 15, mobs: [{ name: 'zombie', x: 3.5, z: 0.5 }] });
  assert.strictEqual(G.tunnelFlee(bot, deps(calls)), 'flee');
  assert.strictEqual(calls.flee, 1);
});

test('tunnelFlee : désarmé et sans bloc → fuite (rien d\'autre à faire)', () => {
  G._resetForTests();
  const { bot, calls } = fakeBot({ sword: false, cobble: 0, mobs: [{ name: 'zombie', x: 3.5, z: 0.5 }] });
  assert.strictEqual(G.tunnelFlee(bot, deps(calls)), 'flee');
  assert.strictEqual(calls.flee, 1);
});
