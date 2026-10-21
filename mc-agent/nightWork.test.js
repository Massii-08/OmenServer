'use strict';
const test = require('node:test');
const assert = require('node:assert');
const N = require('./nightWork');

test('nightWorkTargetY : 12 sous la surface, jamais plus bas que 44 (frontière du sous-sol)', () => {
  assert.strictEqual(N.nightWorkTargetY(70), 58);
  assert.strictEqual(N.nightWorkTargetY(64.7), 52);
  assert.strictEqual(N.nightWorkTargetY(50), 44);
  assert.strictEqual(N.nightWorkTargetY(100), 88);
});

test('nightWorkPlan : pioche en poche, sec, personne autour → descendre', () => {
  assert.deepStrictEqual(N.nightWorkPlan({ y: 70.2, hasPick: true }), { action: 'descend', targetY: 58, surfaceY: 70 });
});

test('nightWorkPlan : sans pioche, cartographe, bûcheron, eau, déjà tenté → l abri historique', () => {
  assert.strictEqual(N.nightWorkPlan({ y: 70, hasPick: false }).action, 'shelter');
  assert.strictEqual(N.nightWorkPlan({ y: 70, hasPick: true, isMapper: true }).action, 'shelter');
  assert.strictEqual(N.nightWorkPlan({ y: 70, hasPick: true, isLumberjack: true }).action, 'shelter');
  assert.strictEqual(N.nightWorkPlan({ y: 70, hasPick: true, inWater: true }).action, 'shelter');
  assert.strictEqual(N.nightWorkPlan({ y: 70, hasPick: true, triedThisNight: true }).action, 'shelter');
  assert.strictEqual(N.nightWorkPlan({ hasPick: true }).action, 'shelter', 'altitude inconnue');
  assert.strictEqual(N.nightWorkPlan().action, 'shelter');
  assert.strictEqual(N.nightWorkPlan({ y: 44.5, hasPick: true }).action, 'shelter', 'déjà sous la frontière : rien à descendre');
});

test('nightWorkPlan : hostile à ≤ 8 blocs → fuir d abord ; plus loin → descendre', () => {
  assert.strictEqual(N.nightWorkPlan({ y: 70, hasPick: true, hostileDist: 6 }).action, 'flee');
  assert.strictEqual(N.nightWorkPlan({ y: 70, hasPick: true, hostileDist: 8 }).action, 'flee');
  assert.strictEqual(N.nightWorkPlan({ y: 70, hasPick: true, hostileDist: 12 }).action, 'descend');
  assert.strictEqual(N.nightWorkPlan({ y: 70, hasPick: true, hostileDist: null }).action, 'descend');
});

test('nightUnderground : y < 45 toujours ; descendu cette nuit et ≥ 8 sous la surface ; sinon non', () => {
  const st = { surfaceY: 70, night: 3, at: 1000 };
  assert.strictEqual(N.nightUnderground(null, { y: 40 }), true);
  assert.strictEqual(N.nightUnderground(null, { y: 58 }), false);
  assert.strictEqual(N.nightUnderground(st, { y: 58, night: 3, now: 2000 }), true);
  assert.strictEqual(N.nightUnderground(st, { y: 62, night: 3, now: 2000 }), true, 'pile 8 sous la surface');
  assert.strictEqual(N.nightUnderground(st, { y: 63, night: 3, now: 2000 }), false, 'remonté : surface');
  assert.strictEqual(N.nightUnderground(st, { y: 58, night: 4, now: 2000 }), false, 'autre nuit');
  assert.strictEqual(N.nightUnderground(st, { y: 58, night: 3, now: 1000 + N.NIGHT_WORK_TTL_MS + 1 }), false, 'état périmé');
  assert.strictEqual(N.nightUnderground(st, {}), false);
});

test('nightDeferGoal : seuls les buts de surface, sous terre, en lockdown', () => {
  assert.strictEqual(N.nightDeferGoal({ lockdown: true, underground: true, skill: 'gatherLog' }), true);
  assert.strictEqual(N.nightDeferGoal({ lockdown: true, underground: true, skill: 'huntCook' }), true);
  assert.strictEqual(N.nightDeferGoal({ lockdown: true, underground: true, skill: 'ensureBed' }), true);
  assert.strictEqual(N.nightDeferGoal({ lockdown: true, underground: true, skill: 'branchMine' }), false);
  assert.strictEqual(N.nightDeferGoal({ lockdown: true, underground: false, skill: 'gatherLog' }), false);
  assert.strictEqual(N.nightDeferGoal({ lockdown: false, underground: true, skill: 'gatherLog' }), false);
});

test('nightSealCells : bouche la marche d où l on vient et le dessus de la tête, jamais sous les pieds', () => {
  // Escalier vers +x : marche précédente = (-1, 1) (pieds) et (-1, 2) (tête) depuis le bot en (0,0,0).
  const open = new Set(['-1,1,0', '-1,2,0', '0,1,0', '0,0,0', '0,-1,0']);
  const cells = N.nightSealCells({ x: 0.5, y: 0, z: 0.5 }, (c) => open.has(`${c.x},${c.y},${c.z}`));
  assert.deepStrictEqual(cells, [{ x: -1, y: 1, z: 0 }]);
  const all = N.nightSealCells({ x: 0, y: 0, z: 0 }, () => true);
  assert.strictEqual(all.length, 9);
  assert.ok(!all.some((c) => c.y < 0));
  assert.deepStrictEqual(N.nightSealCells(null, () => true), []);
});
