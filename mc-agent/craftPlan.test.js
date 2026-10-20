'use strict';
const test = require('node:test');
const assert = require('node:assert');
const P = require('./craftPlan');

test('objet hors table → known:false (l appelant fait comme avant)', () => {
  assert.deepStrictEqual(P.planIntermediates('golden_apple', { gold_ingot: 9 }), { known: false });
});

test('cas MapBot2 (session 318) : 3 planches, 8 bâtons, 930 cobble, pas de table → no_wood:table', () => {
  const r = P.planIntermediates('stone_pickaxe', { cobblestone: 930, birch_planks: 3, stick: 8 }, { tableAvailable: false });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'no_wood:table');
  assert.strictEqual(r.need, 4);
  assert.strictEqual(r.have, 3);
});

test('même poche avec une table en vue → prêt, aucune étape', () => {
  const r = P.planIntermediates('stone_pickaxe', { cobblestone: 930, birch_planks: 3, stick: 8 }, { tableAvailable: true });
  assert.deepStrictEqual(r, { known: true, ok: true, steps: [] });
});

test('bûches seulement (birch_log 15, acacia_planks 1) → planches birch, bâtons, table, dans cet ordre', () => {
  const r = P.planIntermediates('stone_pickaxe', { cobblestone: 188, birch_log: 15, acacia_planks: 1 }, { tableAvailable: false });
  assert.strictEqual(r.ok, true);
  // table 4 + bâtons 2 = 6 planches birch → 2 bûches (8 planches) ; l'acacia isolé ne sert à rien
  assert.deepStrictEqual(r.steps, [
    { name: 'birch_planks', count: 2 }, { name: 'stick', count: 1 }, { name: 'crafting_table', count: 1 },
  ]);
});

test('essences mélangées : 3 oak + 3 birch ne font PAS une table (même essence exigée)', () => {
  const r = P.planIntermediates('crafting_table', { oak_planks: 3, birch_planks: 3 });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'no_wood:planks');
  const r2 = P.planIntermediates('crafting_table', { oak_planks: 3, birch_planks: 3, oak_log: 1 });
  assert.deepStrictEqual(r2.steps, [{ name: 'oak_planks', count: 1 }]);
});

test('torche : bûches 47 + 1 oak + 1 birch, pas de charbon → no_coal (pas de bois brûlé pour rien)', () => {
  const r = P.planIntermediates('torch', { birch_log: 47, oak_planks: 1, birch_planks: 1 });
  assert.deepStrictEqual({ ok: r.ok, reason: r.reason }, { ok: false, reason: 'no_coal' });
  const r2 = P.planIntermediates('torch', { birch_log: 47, oak_planks: 1, birch_planks: 1, coal: 2 });
  // birch : 1 planche + 1 bûche → 5 ≥ 2 ; oak n'a pas de bûche
  assert.deepStrictEqual(r2.steps, [{ name: 'birch_planks', count: 1 }, { name: 'stick', count: 1 }]);
});

test('pierre : la SOMME des pierres de taille suffit à ne pas rejeter ; sinon no_stone', () => {
  assert.strictEqual(P.planIntermediates('stone_pickaxe', { cobblestone: 2, cobbled_deepslate: 1, stick: 2 }, { tableAvailable: true }).ok, true);
  const r = P.planIntermediates('stone_pickaxe', { cobblestone: 2, stick: 2 }, { tableAvailable: true });
  assert.strictEqual(r.reason, 'no_stone');
});

test('fer : iron_helmet avec 4 lingots → no_iron ; avec 11 et sans table ni bois → no_wood:table', () => {
  assert.strictEqual(P.planIntermediates('iron_helmet', { iron_ingot: 4 }, { tableAvailable: true }).reason, 'no_iron');
  const r = P.planIntermediates('iron_helmet', { iron_ingot: 11, acacia_planks: 1, cobblestone: 39 }, { tableAvailable: false });
  assert.strictEqual(r.reason, 'no_wood:table');
});

test('count multiplie le besoin : 4 crafts de bâtons = 8 planches d une essence', () => {
  const r = P.planIntermediates('stick', { spruce_log: 2 }, { count: 4 });
  assert.deepStrictEqual(r.steps, [{ name: 'spruce_planks', count: 2 }]);
  assert.strictEqual(P.planIntermediates('stick', { spruce_log: 1 }, { count: 4 }).reason, 'no_wood:planks');
});

test('mushroom_stem et bois écorcé ne comptent pas comme bûches', () => {
  const r = P.planIntermediates('crafting_table', { mushroom_stem: 9, stripped_oak_log: 9 });
  assert.strictEqual(r.reason, 'no_wood:planks');
});

test('accepte un tableau d items mineflayer', () => {
  const r = P.planIntermediates('stick', [{ name: 'oak_planks', count: 1 }, { name: 'oak_planks', count: 1 }]);
  assert.deepStrictEqual(r, { known: true, ok: true, steps: [] });
});

test('craftSignature : ignore ce qui n est pas de la matière de craft, ordre stable', () => {
  const a = P.craftSignature([{ name: 'dirt', count: 3 }, { name: 'stick', count: 2 }, { name: 'oak_log', count: 1 }]);
  const b = P.craftSignature({ oak_log: 1, stick: 2, rotten_flesh: 4 });
  assert.strictEqual(a, b);
  assert.notStrictEqual(a, P.craftSignature({ oak_log: 2, stick: 2 }));
});

test('backoff : exponentiel par (item, raison) tant que la matière ne change pas', () => {
  const B = P.createCraftBackoff({ baseMs: 1000, maxMs: 5000 });
  assert.strictEqual(B.blocked('x', 's', 0), null);
  assert.strictEqual(B.fail('x', 'r', 's', 0), 1000);
  assert.ok(B.blocked('x', 's', 500));
  assert.strictEqual(B.blocked('x', 's', 1000), null, 'attente écoulée');
  assert.strictEqual(B.fail('x', 'r', 's', 1000), 2000);
  assert.strictEqual(B.fail('x', 'r', 's', 3000), 4000);
  assert.strictEqual(B.fail('x', 'r', 's', 7000), 5000, 'plafonné');
  assert.strictEqual(B.fail('x', 'autre', 's', 8000), 1000, 'autre raison → repart de la base');
});

test('backoff : la matière change → levé immédiatement ; ok() efface', () => {
  const B = P.createCraftBackoff({ baseMs: 1000 });
  B.fail('x', 'r', 's1', 0);
  assert.strictEqual(B.blocked('x', 's2', 10), null);
  assert.strictEqual(B.fail('x', 'r', 's2', 10), 1000, 'nouvelle matière = compteur repart');
  B.ok('x');
  assert.strictEqual(B.size(), 0);
});
