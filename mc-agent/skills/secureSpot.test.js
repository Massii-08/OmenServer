'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { Vec3 } = require('vec3');
const { secureSpot } = require('./secureSpot');

// Fake bot minimal : monde = Map "x,y,z" → {name, boundingBox}. placeBlock remplit la case
// au-dessus (face +y) ou latérale de la référence. Le bot est debout en (0,64,0).
function makeBot({ solid = [], inv = [{ name: 'dirt', count: 32 }] } = {}) {
  const world = new Map();
  const key = (p) => `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`;
  // sol sous les pieds toujours plein + blocs solides fournis
  world.set('0,63,0', { name: 'stone', boundingBox: 'block' });
  for (const p of solid) world.set(`${p[0]},${p[1]},${p[2]}`, { name: 'stone', boundingBox: 'block' });
  const placed = [];
  const controls = {};
  const bot = {
    entity: { position: new Vec3(0.5, 64, 0.5), velocity: new Vec3(0, 0, 0), onGround: true },
    inventory: { items: () => inv },
    blockAt(p) {
      const b = world.get(key(p));
      if (b) return { ...b, position: new Vec3(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)) };
      return { name: 'air', boundingBox: 'empty', position: new Vec3(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z)) };
    },
    async equip() {},
    async lookAt() {},
    async placeBlock(ref, face) {
      const p = ref.position.plus(face);
      world.set(key(p), { name: 'dirt', boundingBox: 'block' });
      placed.push(key(p));
    },
    setControlState(name, v) { controls[name] = v; },
    clearControlStates() { for (const k of Object.keys(controls)) controls[k] = false; },
  };
  return { bot, placed, controls, world, key };
}

test('secureSpot float : saute (remonter/flotter), aucune pose', async () => {
  const { bot, placed, controls } = makeBot();
  const r = await secureSpot(bot, 'float', {});
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.tactic, 'float');
  assert.strictEqual(controls.jump, true);
  assert.strictEqual(placed.length, 0);
});

test('secureSpot pillar : délègue à pillarUp (injecté) avec height 3', async () => {
  const { bot } = makeBot();
  const calls = [];
  const fakePillar = async (b, o) => { calls.push(o); return { ok: true, placed: 3 }; };
  const r = await secureSpot(bot, 'pillar', { pillarUp: fakePillar });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.tactic, 'pillar');
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].height, 3);
});

test('secureSpot pillar : pilier raté (0 posé) → ok:false (le caller warpe quand même)', async () => {
  const { bot } = makeBot();
  const fakePillar = async () => ({ ok: false, placed: 0, reason: 'no_support' });
  const r = await secureSpot(bot, 'pillar', { pillarUp: fakePillar });
  assert.strictEqual(r.ok, false);
});

test('secureSpot seal : mure les côtés OUVERTS à hauteur de pieds (référence = bloc dessous)', async () => {
  // côtés +x et -x déjà murés (solides aux pieds) ; -z/+z ouverts avec support dessous → 2 poses pieds
  // + les cases tête correspondantes (posées sur le bloc fraîchement placé)
  const { bot, placed } = makeBot({
    solid: [[1, 64, 0], [-1, 64, 0], [1, 65, 0], [-1, 65, 0],   // murs est/ouest complets
      [0, 63, 1], [0, 63, -1]],                                  // supports sous les cases sud/nord
  });
  const r = await secureSpot(bot, 'seal', {});
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.tactic, 'seal');
  assert.ok(placed.includes('0,64,1') && placed.includes('0,64,-1'), 'cases pieds ouvertes murées');
  assert.ok(placed.includes('0,65,1') && placed.includes('0,65,-1'), 'cases tête murées par-dessus');
  assert.ok(!placed.includes('1,64,0') && !placed.includes('-1,64,0'), 'côtés déjà pleins non re-posés');
});

test('secureSpot seal : sans blocs en poche → ok:false, aucune pose', async () => {
  const { bot, placed } = makeBot({ inv: [] });
  const r = await secureSpot(bot, 'seal', {});
  assert.strictEqual(r.ok, false);
  assert.strictEqual(placed.length, 0);
});

test('secureSpot none : no-op ok (le caller fait juste stopMotion+immobile)', async () => {
  const { bot, placed, controls } = makeBot();
  const r = await secureSpot(bot, 'none', {});
  assert.strictEqual(r.ok, true);
  assert.strictEqual(placed.length, 0);
  assert.notStrictEqual(controls.jump, true);
});

test('secureSpot : token annulé → sort immédiatement sans poser', async () => {
  const { bot, placed } = makeBot();
  const r = await secureSpot(bot, 'seal', { token: { cancelled: true } });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(placed.length, 0);
});
