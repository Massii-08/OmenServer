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

// ─── CRAFTER DANS LE TROU (22/10) ───────────────────────────────────────────────────────────────
test('shelterCraftNext : 3 bûches, rien d autre → planches, puis table, bâtons, pioche en bois (une étape à la fois)', () => {
  assert.deepStrictEqual(N.shelterCraftNext([{ name: 'oak_log', count: 3 }], { cellMode: 'pit' }), { name: 'oak_planks', count: 3 });
  assert.deepStrictEqual(N.shelterCraftNext([{ name: 'oak_planks', count: 12 }], { cellMode: 'pit' }), { name: 'crafting_table', count: 1 });
  assert.deepStrictEqual(N.shelterCraftNext([{ name: 'oak_planks', count: 8 }, { name: 'crafting_table', count: 1 }], { cellMode: 'pit' }), { name: 'stick', count: 1 });
  assert.deepStrictEqual(N.shelterCraftNext([{ name: 'oak_planks', count: 6 }, { name: 'crafting_table', count: 1 }, { name: 'stick', count: 4 }], { cellMode: 'pit' }),
    { name: 'wooden_pickaxe', count: 1 });
});

test('shelterCraftNext : pas assez de bois pour aller jusqu à la pioche → rien (pas de craft inutile)', () => {
  assert.strictEqual(N.shelterCraftNext([{ name: 'oak_log', count: 1 }], { cellMode: 'pit' }), null);
  assert.strictEqual(N.shelterCraftNext([{ name: 'oak_planks', count: 8 }], { cellMode: 'pit' }), null);
  assert.strictEqual(N.shelterCraftNext([], { cellMode: 'pit' }), null);
  assert.strictEqual(N.shelterCraftNext(null), null);
});

test('shelterCraftNext : cellule MURÉE → aucune recette 3×3 (la table ne se pose pas dans un mur posé)', () => {
  assert.deepStrictEqual(N.shelterCraftNext([{ name: 'oak_log', count: 3 }], { cellMode: 'walled' }), null);
  const inv = [{ name: 'wooden_pickaxe', count: 1 }, { name: 'coal', count: 2 }, { name: 'stick', count: 4 }];
  assert.deepStrictEqual(N.shelterCraftNext(inv, { cellMode: 'walled' }), { name: 'torch', count: 1 }, 'torches = 2×2, permises');
});

test('shelterCraftNext : un craft raté cet abri n est pas retenté', () => {
  const inv = [{ name: 'oak_planks', count: 12 }];
  assert.strictEqual(N.shelterCraftNext(inv, { cellMode: 'pit', skip: new Set(['crafting_table']) }), null);
  assert.strictEqual(N.shelterCraftNext([{ name: 'oak_log', count: 3 }], { cellMode: 'pit', skip: ['oak_planks'] }), null);
});

test('shelterCraftNext : avec pioche en bois + cobble en poche → pioche pierre, épée, four, torches', () => {
  const base = [{ name: 'wooden_pickaxe', count: 1 }, { name: 'crafting_table', count: 1 }, { name: 'stick', count: 4 }];
  assert.deepStrictEqual(N.shelterCraftNext(base.concat([{ name: 'cobblestone', count: 3 }]), { cellMode: 'pit' }), { name: 'stone_pickaxe', count: 1 });
  const inv2 = [{ name: 'stone_pickaxe', count: 1 }, { name: 'crafting_table', count: 1 }, { name: 'stick', count: 2 }, { name: 'cobblestone', count: 10 }];
  assert.deepStrictEqual(N.shelterCraftNext(inv2, { cellMode: 'pit' }), { name: 'stone_sword', count: 1 });
  const inv3 = inv2.concat([{ name: 'stone_sword', count: 1 }]);
  assert.deepStrictEqual(N.shelterCraftNext(inv3, { cellMode: 'pit' }), { name: 'furnace', count: 1 });
  // rien en poche qui serve : null → l'appelant passe à la descente
  assert.strictEqual(N.shelterCraftNext([{ name: 'stone_pickaxe', count: 1 }], { cellMode: 'pit' }), null);
  // bâtons manquants mais planches : bâtons d'abord
  const inv4 = [{ name: 'wooden_pickaxe', count: 1 }, { name: 'crafting_table', count: 1 }, { name: 'oak_planks', count: 2 }, { name: 'cobblestone', count: 3 }];
  assert.deepStrictEqual(N.shelterCraftNext(inv4, { cellMode: 'pit' }), { name: 'stick', count: 1 });
});

test('nightWorkPlan fromShelter : surface relevée au-dessus du puits, hostiles ignorés, cellule murée refusée', () => {
  // fond du puits à 67, surface 70 → cible 58 (12 sous la SURFACE, pas sous le fond)
  assert.deepStrictEqual(N.nightWorkPlan({ y: 67, hasPick: true, fromShelter: true, cellMode: 'pit', surfaceY: 70, hostileDist: 2 }),
    { action: 'descend', targetY: 58, surfaceY: 70 });
  assert.strictEqual(N.nightWorkPlan({ y: 67, hasPick: true, fromShelter: true, cellMode: 'walled', surfaceY: 70 }).why, 'walled');
  assert.strictEqual(N.nightWorkPlan({ y: 67, hasPick: false, fromShelter: true, cellMode: 'pit', surfaceY: 70 }).action, 'shelter');
  assert.strictEqual(N.nightWorkPlan({ y: 67, hasPick: true, fromShelter: true, cellMode: 'pit', surfaceY: 70, triedThisNight: true }).action, 'shelter');
  // sans fromShelter, le comportement historique (fuite) est intact
  assert.strictEqual(N.nightWorkPlan({ y: 70, hasPick: true, hostileDist: 2 }).action, 'flee');
});
