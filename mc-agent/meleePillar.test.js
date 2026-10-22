'use strict';
const test = require('node:test');
const assert = require('node:assert');
const mp = require('./meleePillar');

const SELF = { x: 0, y: 64, z: 0 };
const mob = (name, x, y, z, extra = {}) => Object.assign({ name, position: { x, y, z } }, extra);
const base = (over = {}) => Object.assign({
  self: SELF, entities: [mob('zombie', 1, 64, 0), mob('zombie', 0, 64, 1.5)],
  fightAdvised: false, blocks: 20, inWater: false, busy: false, headroom: true, now: 100000, lastFailAt: 0,
}, over);

test('le cas live NethBot3 : 4 zombies à 0,5-1,7 bloc, nu → pilier de 3', () => {
  const r = mp.meleePillarPlan(base({ entities: [mob('zombie', 0.5, 64, 0), mob('zombie', -1, 64, 1), mob('zombie', 1.7, 64, 0), mob('husk', 0, 64, -1.2)] }));
  assert.deepStrictEqual([r.act, r.reason, r.mobs, r.height], ['pillar', 'melee_crowd', 4, 3]);
});

test('un seul zombie, ou les mobs au-delà de 4 blocs : pas de pilier', () => {
  assert.strictEqual(mp.meleePillarPlan(base({ entities: [mob('zombie', 1, 64, 0)] })).reason, 'few_mobs');
  assert.strictEqual(mp.meleePillarPlan(base({ entities: [mob('zombie', 1, 64, 0), mob('zombie', 5, 64, 0)] })).reason, 'few_mobs');
});

test('squelettes, creepers, endermen ne comptent pas', () => {
  const r = mp.meleePillarPlan(base({ entities: [mob('skeleton', 1, 64, 0), mob('creeper', 0, 64, 1), mob('enderman', 1, 64, 1), mob('zombie', 2, 64, 0)] }));
  assert.strictEqual(r.act, 'none');
  assert.strictEqual(r.mobs, 1);
});

test('araignée et zombie villageois comptent ; entité retirée du monde (isValid:false) non', () => {
  assert.strictEqual(mp.meleePillarPlan(base({ entities: [mob('spider', 1, 64, 0), mob('zombie_villager', 0, 64, 1)] })).act, 'pillar');
  assert.strictEqual(mp.meleePillarPlan(base({ entities: [mob('zombie', 1, 64, 0), mob('zombie', 0, 64, 1, { isValid: false })] })).act, 'none');
});

test('armé de quoi les battre (boldFightAdvised vrai) : on se bat, pas de pilier', () => {
  assert.strictEqual(mp.meleePillarPlan(base({ fightAdvised: true })).reason, 'fight_advised');
});

test('sans bloc (ou 1 seul) → none/no_blocks (la fuite actuelle reste) ; 2 blocs → pilier de 2', () => {
  assert.strictEqual(mp.meleePillarPlan(base({ blocks: 0 })).reason, 'no_blocks');
  assert.strictEqual(mp.meleePillarPlan(base({ blocks: 1 })).reason, 'no_blocks');
  const r = mp.meleePillarPlan(base({ blocks: 2 }));
  assert.deepStrictEqual([r.act, r.height], ['pillar', 2]);
});

test('dans l eau, déjà occupé, plafond dangereux, cooldown après un échec : none', () => {
  assert.strictEqual(mp.meleePillarPlan(base({ inWater: true })).reason, 'in_water');
  assert.strictEqual(mp.meleePillarPlan(base({ busy: true })).reason, 'busy');
  assert.strictEqual(mp.meleePillarPlan(base({ headroom: false })).reason, 'headroom');
  assert.strictEqual(mp.meleePillarPlan(base({ lastFailAt: 90000 })).reason, 'cooldown');
  assert.strictEqual(mp.meleePillarPlan(base({ lastFailAt: 100000 - mp.PILLAR_FAIL_COOLDOWN_MS })).act, 'pillar');
  assert.strictEqual(mp.meleePillarPlan(base({ self: null })).reason, 'no_position');
});

test('headroomOk : lave, eau, sable, gravier au-dessus → non ; air, feuilles, terre → oui', () => {
  assert.strictEqual(mp.headroomOk(['air', 'oak_leaves', 'dirt']), true);
  assert.strictEqual(mp.headroomOk([null, null, null]), true);
  assert.strictEqual(mp.headroomOk(['air', 'lava', 'air']), false);
  assert.strictEqual(mp.headroomOk(['water']), false);
  assert.strictEqual(mp.headroomOk(['gravel']), false);
  assert.strictEqual(mp.headroomOk(['air', 'air', 'sand']), false);
  assert.strictEqual(mp.headroomOk(undefined), true);
});

test('scaffoldCount : somme des blocs sacrifiables seulement', () => {
  const items = [{ name: 'dirt', count: 12 }, { name: 'cobblestone', count: 5 }, { name: 'oak_log', count: 30 }, null];
  assert.strictEqual(mp.scaffoldCount(items, ['dirt', 'cobblestone']), 17);
  assert.strictEqual(mp.scaffoldCount(items, new Set(['dirt'])), 12);
  assert.strictEqual(mp.scaffoldCount(null, ['dirt']), 0);
});

test('pillarHoldStatus : mobs encore sous le pilier → on reste ; partis → clear ; creeper → descendre ; 90 s → max', () => {
  const top = { x: 0, y: 67, z: 0 };
  const under = [mob('zombie', 0.8, 64, 0), mob('zombie', 0, 64, 1)];
  assert.deepStrictEqual(mp.pillarHoldStatus({ self: top, entities: under, t0: 0, now: 10000 }), { done: false, why: null, melee: 2 });
  assert.strictEqual(mp.pillarHoldStatus({ self: top, entities: [mob('zombie', 9, 64, 0)], t0: 0, now: 10000 }).why, 'clear');
  assert.strictEqual(mp.pillarHoldStatus({ self: top, entities: under.concat([mob('creeper', 3, 64, 0)]), t0: 0, now: 10000 }).why, 'creeper');
  assert.strictEqual(mp.pillarHoldStatus({ self: top, entities: under, t0: 0, now: mp.PILLAR_HOLD_MAX_MS }).why, 'max');
  assert.strictEqual(mp.pillarHoldStatus({ self: top, entities: [mob('skeleton', 1, 64, 0)], t0: 0, now: 1 }).why, 'clear',
    'un squelette ne retient pas le bot là-haut');
});

test('pillarStrikeTarget : zombie collé au pied du pilier de 3 → à portée ; à 3 blocs de côté → non', () => {
  const top = { x: 0, y: 67, z: 0 };
  const z1 = mob('zombie', 0.7, 64, 0, { height: 1.95 });
  assert.strictEqual(mp.pillarStrikeTarget(top, [z1, mob('skeleton', 0.5, 64, 0)]), z1);
  assert.strictEqual(mp.pillarStrikeTarget(top, [mob('zombie', 3.2, 64, 0)]), null);
  assert.strictEqual(mp.pillarStrikeTarget(top, [mob('creeper', 0.5, 64, 0)]), null);
  assert.strictEqual(mp.pillarStrikeTarget(null, [z1]), null);
});
