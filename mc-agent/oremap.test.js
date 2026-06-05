'use strict';
const test = require('node:test');
const assert = require('node:assert');
const {
  normalizeOreName, addOres, claimNext, refreshClaim, releaseClaim,
  markMined, markGone, heartbeat, counts, emptyMap, CLAIM_TTL_MS, ORE_TYPES,
} = require('./oremap');

test('normalizeOreName mappe les 10 IDs de blocs vers 5 types', () => {
  assert.strictEqual(normalizeOreName('diamond_ore'), 'diamond');
  assert.strictEqual(normalizeOreName('deepslate_diamond_ore'), 'diamond');
  assert.strictEqual(normalizeOreName('gold_ore'), 'gold');
  assert.strictEqual(normalizeOreName('deepslate_redstone_ore'), 'redstone');
  assert.strictEqual(normalizeOreName('lapis_ore'), 'lapis');
  assert.strictEqual(normalizeOreName('deepslate_iron_ore'), 'iron');
  assert.strictEqual(normalizeOreName('stone'), null);
  assert.strictEqual(Object.keys(ORE_TYPES).length, 10);
});

test('addOres ajoute, dédup par position, ignore les noms inconnus', () => {
  const m = emptyMap('r1', { cx: 0, cz: 0, radius: 100 });
  const added = addOres(m, [
    { name: 'diamond_ore', x: 1, y: -54, z: 2 },
    { name: 'diamond_ore', x: 1, y: -54, z: 2 },   // doublon exact
    { name: 'stone', x: 3, y: 0, z: 3 },             // pas une ore
    { name: 'iron_ore', x: 5, y: 20, z: 5 },
  ], 'Carto1', 1000);
  assert.strictEqual(added, 2);
  assert.strictEqual(Object.keys(m.ores).length, 2);
  const d = m.ores['1,-54,2'];
  assert.deepStrictEqual(
    { type: d.type, foundBy: d.foundBy, status: d.status, claimedBy: d.claimedBy },
    { type: 'diamond', foundBy: 'Carto1', status: 'new', claimedBy: null });
});

test('addOres ne ressuscite JAMAIS une ore mined/gone (re-scan cartographe)', () => {
  const m = emptyMap('r1', null);
  addOres(m, [{ name: 'iron_ore', x: 0, y: 0, z: 0 }], 'C1', 1000);
  markMined(m, '0,0,0');
  const added = addOres(m, [{ name: 'iron_ore', x: 0, y: 0, z: 0 }], 'C2', 2000);
  assert.strictEqual(added, 0);
  assert.strictEqual(m.ores['0,0,0'].status, 'mined');
});

test('claimNext choisit la plus proche du type, pose claimedBy/claimedAt', () => {
  const m = emptyMap('r1', null);
  addOres(m, [
    { name: 'diamond_ore', x: 100, y: -54, z: 0 },
    { name: 'diamond_ore', x: 10, y: -54, z: 0 },
    { name: 'iron_ore', x: 1, y: -54, z: 0 },
  ], 'C1', 0);
  const ore = claimNext(m, { type: 'diamond', from: { x: 0, y: -54, z: 0 }, username: 'Res1', now: 5000 });
  assert.strictEqual(ore.x, 10);
  assert.strictEqual(m.ores['10,-54,0'].claimedBy, 'Res1');
  assert.strictEqual(m.ores['10,-54,0'].claimedAt, 5000);
});

test('claimNext respecte la claim active d\'un autre bot, mais reprend une claim expirée', () => {
  const m = emptyMap('r1', null);
  addOres(m, [{ name: 'diamond_ore', x: 10, y: 0, z: 0 }], 'C1', 0);
  claimNext(m, { type: 'diamond', from: { x: 0, y: 0, z: 0 }, username: 'Res1', now: 1000 });
  // claim active (TTL pas écoulé) → Res2 ne la prend pas
  assert.strictEqual(claimNext(m, { type: 'diamond', from: { x: 0, y: 0, z: 0 }, username: 'Res2', now: 1000 + CLAIM_TTL_MS - 1 }), null);
  // claim expirée → Res2 la reprend (bot mort)
  const ore = claimNext(m, { type: 'diamond', from: { x: 0, y: 0, z: 0 }, username: 'Res2', now: 1000 + CLAIM_TTL_MS + 1 });
  assert.strictEqual(ore.x, 10);
  assert.strictEqual(m.ores['10,0,0'].claimedBy, 'Res2');
});

test('claimNext re-rend sa propre claim au même bot + ignore le Set skip', () => {
  const m = emptyMap('r1', null);
  addOres(m, [
    { name: 'iron_ore', x: 1, y: 0, z: 0 },
    { name: 'iron_ore', x: 2, y: 0, z: 0 },
  ], 'C1', 0);
  claimNext(m, { type: 'iron', from: { x: 0, y: 0, z: 0 }, username: 'Res1', now: 0 });
  // re-claim par le même bot (reprise après crash skill) → OK, c'est la sienne
  const again = claimNext(m, { type: 'iron', from: { x: 0, y: 0, z: 0 }, username: 'Res1', now: 10 });
  assert.strictEqual(again.x, 1);
  // skip local : la 1,0,0 est blacklistée → il prend la 2,0,0
  const skipped = claimNext(m, { type: 'iron', from: { x: 0, y: 0, z: 0 }, username: 'Res1', now: 20, skip: new Set(['1,0,0']) });
  assert.strictEqual(skipped.x, 2);
});

test('refreshClaim/releaseClaim ne marchent que pour le propriétaire', () => {
  const m = emptyMap('r1', null);
  addOres(m, [{ name: 'iron_ore', x: 1, y: 0, z: 0 }], 'C1', 0);
  claimNext(m, { type: 'iron', from: { x: 0, y: 0, z: 0 }, username: 'Res1', now: 0 });
  assert.strictEqual(refreshClaim(m, '1,0,0', 'Res2', 100), false);
  assert.strictEqual(refreshClaim(m, '1,0,0', 'Res1', 100), true);
  assert.strictEqual(m.ores['1,0,0'].claimedAt, 100);
  assert.strictEqual(releaseClaim(m, '1,0,0', 'Res2'), false);
  assert.strictEqual(releaseClaim(m, '1,0,0', 'Res1'), true);
  assert.strictEqual(m.ores['1,0,0'].claimedBy, null);
});

test('markMined/markGone sortent l\'ore du pool claimable', () => {
  const m = emptyMap('r1', null);
  addOres(m, [
    { name: 'lapis_ore', x: 1, y: 0, z: 0 },
    { name: 'lapis_ore', x: 2, y: 0, z: 0 },
  ], 'C1', 0);
  markMined(m, '1,0,0');
  markGone(m, '2,0,0');
  assert.strictEqual(claimNext(m, { type: 'lapis', from: { x: 0, y: 0, z: 0 }, username: 'R', now: 0 }), null);
  assert.strictEqual(m.ores['1,0,0'].status, 'mined');
  assert.strictEqual(m.ores['2,0,0'].status, 'gone');
});

test('heartbeat enregistre position/role/quota du bot ; counts agrège par type/statut', () => {
  const m = emptyMap('r1', null);
  addOres(m, [
    { name: 'diamond_ore', x: 1, y: 0, z: 0 },
    { name: 'diamond_ore', x: 2, y: 0, z: 0 },
    { name: 'diamond_ore', x: 3, y: 0, z: 0 },
    { name: 'iron_ore', x: 4, y: 0, z: 0 },
  ], 'C1', 0);
  claimNext(m, { type: 'diamond', from: { x: 0, y: 0, z: 0 }, username: 'Res1', now: 1000 });
  markMined(m, '2,0,0');
  heartbeat(m, 'Res1', { x: 5, y: -50, z: 5, role: 'resource', quota: { diamond: { have: 1, target: 15 } } }, 1000);
  const c = counts(m, 1000);
  assert.deepStrictEqual(c.diamond, { new: 1, claimed: 1, mined: 1, gone: 0 });
  assert.deepStrictEqual(c.iron, { new: 1, claimed: 0, mined: 0, gone: 0 });
  assert.strictEqual(m.bots.Res1.role, 'resource');
  assert.strictEqual(m.bots.Res1.quota.diamond.have, 1);
});
