'use strict';
const test = require('node:test');
const assert = require('node:assert');
const E = require('./enderman');

const eye = { x: 0, y: 71.62, z: 0 };                 // bot debout à y 70
const ender = (x, y, z, extra = {}) => Object.assign({ name: 'enderman', position: { x, y, z } }, extra);
// yaw/pitch qui font face à un point (formule bot.lookAt)
function faceTo(p) {
  const dx = p.x - eye.x, dy = p.y - eye.y, dz = p.z - eye.z;
  return { yaw: Math.atan2(-dx, -dz), pitch: Math.atan2(dy, Math.hypot(dx, dz)) };
}

test('viewVector : yaw 0 pitch 0 regarde vers -z (convention mineflayer)', () => {
  const v = E.viewVector(0, 0);
  assert.ok(Math.abs(v.z + 1) < 1e-9 && Math.abs(v.x) < 1e-9 && Math.abs(v.y) < 1e-9);
});

test('lookIsUnsafe : regarder droit dans les yeux d\'un enderman à 10 blocs → dangereux', () => {
  const e = ender(0, 70, -10);
  const f = faceTo({ x: 0, y: 70 + E.EYE_HEIGHT, z: -10 });
  assert.strictEqual(E.lookIsUnsafe(f.yaw, f.pitch, eye, [e]), e);
});

test('lookIsUnsafe : marcher pitch 0 vers un enderman à 15 blocs → dangereux (cas du pathfinder)', () => {
  const e = ender(0, 70, -15);
  assert.ok(E.lookIsUnsafe(0, 0, eye, [e]), 'tête à ~3,5° au-dessus de l\'horizon');
});

test('lookIsUnsafe : regarder ses pieds, dos tourné ou enderman à 70 blocs → sûr', () => {
  assert.strictEqual(E.lookIsUnsafe(0, -1.1, eye, [ender(0, 70, -10)]), null);
  assert.strictEqual(E.lookIsUnsafe(Math.PI, 0, eye, [ender(0, 70, -10)]), null);
  assert.strictEqual(E.lookIsUnsafe(0, 0, eye, [ender(0, 70, -70)]), null);
});

test('lookIsUnsafe : ignore les autres mobs et accepte un dictionnaire d\'entités', () => {
  const z = { name: 'zombie', position: { x: 0, y: 70, z: -10 } };
  assert.strictEqual(E.lookIsUnsafe(0, 0, eye, { 1: z }), null);
  assert.ok(E.lookIsUnsafe(0, 0, eye, { 1: z, 2: ender(0, 70, -12) }));
});

test('safeLook : même yaw, pitch abaissé quand la visée est dangereuse ; inchangé sinon', () => {
  const e = ender(0, 70, -15);
  const s = E.safeLook(0, 0, eye, [e]);
  assert.strictEqual(s.avoided, true);
  assert.strictEqual(s.yaw, 0);
  assert.ok(s.pitch < 0, 'regarde vers le sol');
  assert.strictEqual(E.lookIsUnsafe(s.yaw, s.pitch, eye, [e]), null);
  const ok = E.safeLook(0.3, 0.1, eye, []);
  assert.deepStrictEqual([ok.yaw, ok.pitch, ok.avoided], [0.3, 0.1, false]);
});

test('safeLook : enderman SOUS le bot (grotte) → lève les yeux plutôt que les baisser', () => {
  const e = ender(0, 60, -3);                        // tête vers y 62,5 : sous les yeux (71,6)
  const f = faceTo({ x: 0, y: 62.55, z: -3 });
  const s = E.safeLook(f.yaw, f.pitch, eye, [e]);
  assert.strictEqual(s.avoided, true);
  assert.strictEqual(E.lookIsUnsafe(s.yaw, s.pitch, eye, [e]), null);
});

test('creepyIndex : lu dans minecraft-data 1.21.4, repli 17', () => {
  const reg = require('minecraft-data')('1.21.4');
  assert.strictEqual(E.creepyIndex(reg), reg.entitiesByName.enderman.metadataKeys.indexOf('creepy'));
  assert.strictEqual(E.creepyIndex(null), 17);
});

test('isAngryEnderman : métadonnée creepy, coup reçu, ou collé ; calme et loin → non', () => {
  const md = []; md[17] = true;
  assert.strictEqual(E.isAngryEnderman(ender(0, 70, -10, { metadata: md }), { creepyIdx: 17 }), true);
  assert.strictEqual(E.isAngryEnderman(ender(0, 70, -10, { metadata: [] }), { creepyIdx: 17, selfPos: { x: 0, y: 70, z: 0 } }), false);
  assert.strictEqual(E.isAngryEnderman(ender(0, 70, -10), { hurtBy: true }), true);
  assert.strictEqual(E.isAngryEnderman(ender(0, 70, -2), { selfPos: { x: 0, y: 70, z: 0 } }), true);
  assert.strictEqual(E.isAngryEnderman({ name: 'zombie', position: { x: 0, y: 70, z: -1 } }, { hurtBy: true }), false);
});

test('endermanResponse : eau ≤ 6 → water ; sinon combat si boldFightAdvised (poids 2) ; sinon fuite', () => {
  const seen = [];
  const bold = (o) => { seen.push(o.fightCount); return o.canDealWith > o.fightCount && o.health > 8; };
  assert.strictEqual(E.endermanResponse({ waterDist: 4, health: 20, canDealWith: 9, boldFightAdvised: bold }), 'water');
  assert.strictEqual(E.endermanResponse({ waterDist: 9, health: 20, canDealWith: 9, boldFightAdvised: bold }), 'fight');
  assert.strictEqual(E.endermanResponse({ waterDist: null, health: 20, canDealWith: 2, boldFightAdvised: bold }), 'flee');
  assert.strictEqual(E.endermanResponse({ health: 6, canDealWith: 9, boldFightAdvised: bold }), 'flee');
  assert.ok(seen.every((c) => c === E.ENDERMAN_FIGHT_WEIGHT));
});

test('wrapLook : corrige le pitch des visées dangereuses, laisse passer le reste, idempotent', async () => {
  const calls = [];
  const bot = { look: async (y, p, f) => { calls.push([y, p, f]); } };
  let ents = [ender(0, 70, -15)];
  const avoided = [];
  E.wrapLook(bot, { entities: () => ents, eye: () => eye, onAvoid: (s) => avoided.push(s) });
  await bot.look(0, 0, true);
  assert.ok(calls[0][1] < 0 && calls[0][0] === 0 && calls[0][2] === true);
  assert.strictEqual(avoided.length, 1);
  ents = [];
  await bot.look(0.2, 0.05, false);
  assert.deepStrictEqual(calls[1], [0.2, 0.05, false]);
  const again = bot.look;
  E.wrapLook(bot, { entities: () => ents, eye: () => eye });
  assert.strictEqual(bot.look, again, 'pas de double enveloppe');
});

test('wrapLook : allow() vrai (combat volontaire) → visée intacte ; une erreur interne ne bloque jamais', async () => {
  const calls = [];
  const bot = { look: async (y, p) => { calls.push([y, p]); } };
  E.wrapLook(bot, { entities: () => [ender(0, 70, -15)], eye: () => eye, allow: () => true });
  await bot.look(0, 0);
  assert.deepStrictEqual(calls[0], [0, 0]);
  const bot2 = { look: async (y, p) => { calls.push([y, p]); } };
  E.wrapLook(bot2, { entities: () => { throw new Error('boom'); }, eye: () => eye });
  await bot2.look(1, 0);
  assert.deepStrictEqual(calls[1], [1, 0]);
});
