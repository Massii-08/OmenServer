'use strict';
// CRAFTS AVEC LE VRAI CODE MINEFLAYER (26/10) — « Error: missing ingredient » avec l'ingrédient en poche.
// Cause démontrée ici : `recipesFor(id, null, 1, table)` ne valide qu'UN craft (minResultCount = 1),
// alors que `bot.craft(recipe, count)` répète la MÊME recette `count` fois (craft.js de mineflayer,
// boucle `craftOnce`). Dès que la quantité demandée n'est couverte qu'en mélangeant les variantes
// (torches : charbon + charbon de bois ; bâtons : chêne + bouleau…), la k-ième itération ne trouve plus
// SON ingrédient (`window.findInventoryItem` → null → `missing ingredient`) alors que la poche en est
// pleine — sous une autre variante.
const { test } = require('node:test');
const assert = require('node:assert');
const { Vec3 } = require('vec3');
const { makeBot } = require('./craftRealBench');
const { craftItem, allocateCrafts } = require('./craft');
const registry = require('prismarine-registry')('1.21.4');

const fast = (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 20)));
function bench(items, products) {
  const bot = makeBot(items, { products });
  bot.findBlock = () => ({ position: new Vec3(1, 0, 0), name: 'crafting_table' });
  return bot;
}
function inv(bot) {
  const out = {};
  for (const it of bot.inventory.items()) out[it.name] = (out[it.name] || 0) + it.count;
  return out;
}

test('DIAGNOSTIC (vrai mineflayer) : une seule recette répétée sur 2 variantes → missing ingredient', async () => {
  const bot = bench([['coal', 1, 9], ['charcoal', 1, 10], ['stick', 6, 11]], ['torch']);
  const table = { position: new Vec3(1, 0, 0) };
  const rs = bot.recipesFor(registry.itemsByName.torch.id, null, 1, table);
  assert.strictEqual(rs.length, 2, 'recipesFor accepte les DEUX variantes (1 craft chacune)');
  await assert.rejects(bot.craft(rs[0], 2, table), /missing ingredient/);
});

test('torches charbon + charbon de bois ×2 : réussit, 8 torches, aucun reste', async () => {
  const bot = bench([['coal', 1, 9], ['charcoal', 1, 10], ['stick', 6, 11]], ['torch']);
  const r = await craftItem(bot, { name: 'torch', count: 2, _sleep: fast });
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  assert.deepStrictEqual(inv(bot), { stick: 4, torch: 8 });
});

test('bâtons sur 2 essences (2 chêne + 2 bouleau, 2 fournées) : réussit', async () => {
  const bot = bench([['oak_planks', 2, 9], ['birch_planks', 2, 10]], ['stick']);
  const r = await craftItem(bot, { name: 'stick', count: 2, _sleep: fast });
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  assert.deepStrictEqual(inv(bot), { stick: 8 });
});

test('bouclier, inventaire mesuré en jeu (épicéa 16 + 1 lingot) : réussit', async () => {
  const bot = bench([['stick', 19, 9], ['iron_ingot', 1, 10], ['spruce_planks', 16, 11], ['spruce_log', 10, 12],
    ['cobblestone', 64, 13], ['cobblestone', 42, 14]], ['shield']);
  const r = await craftItem(bot, { name: 'shield', count: 1, _sleep: fast });
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  assert.strictEqual(inv(bot).shield, 1);
  assert.strictEqual(inv(bot).spruce_planks, 10);
});

test('bouclier, chêne 36 en 2 piles + 1 lingot : réussit', async () => {
  const bot = bench([['oak_planks', 4, 9], ['oak_planks', 32, 20], ['iron_ingot', 1, 38]], ['shield']);
  const r = await craftItem(bot, { name: 'shield', count: 1, _sleep: fast });
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  assert.strictEqual(inv(bot).shield, 1);
});

test('torche sans charbon (inventaire mesuré) : no_recipe, rien ne part au craft', async () => {
  const bot = bench([['oak_log', 2, 9], ['oak_planks', 2, 10], ['birch_log', 1, 11], ['cobblestone', 64, 12],
    ['stick', 6, 13], ['crafting_table', 1, 14]], ['torch']);
  let crafts = 0; const real = bot.craft; bot.craft = (...a) => { crafts++; return real(...a); };
  const r = await craftItem(bot, { name: 'torch', count: 1, _sleep: fast });
  assert.deepStrictEqual(r, { ok: false, reason: 'no_recipe' });
  assert.strictEqual(crafts, 0);
});

test('torche avec charbon : réussit', async () => {
  const bot = bench([['oak_log', 2, 9], ['stick', 6, 13], ['coal', 3, 15]], ['torch']);
  const r = await craftItem(bot, { name: 'torch', count: 3, _sleep: fast });
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  assert.strictEqual(inv(bot).torch, 12);
});

// Pas de régression sur les crafts courants (vrai mineflayer, table à portée).
for (const [name, items, count, expect] of [
  ['oak_planks', [['oak_log', 3, 9]], 3, 12],
  ['stick', [['oak_planks', 4, 9]], 2, 8],
  ['crafting_table', [['oak_planks', 4, 9]], 1, 1],
  ['wooden_pickaxe', [['oak_planks', 3, 9], ['stick', 2, 10]], 1, 1],
  ['stone_pickaxe', [['cobblestone', 3, 9], ['stick', 2, 10]], 1, 1],
  ['iron_pickaxe', [['iron_ingot', 3, 9], ['stick', 2, 10]], 1, 1],
  ['stone_sword', [['cobblestone', 2, 9], ['stick', 1, 10]], 1, 1],
  ['iron_sword', [['iron_ingot', 2, 9], ['stick', 1, 10]], 1, 1],
  ['furnace', [['cobblestone', 8, 9]], 1, 1],
  ['iron_helmet', [['iron_ingot', 5, 9]], 1, 1],
  ['iron_chestplate', [['iron_ingot', 8, 9]], 1, 1],
  ['iron_leggings', [['iron_ingot', 7, 9]], 1, 1],
  ['iron_boots', [['iron_ingot', 4, 9]], 1, 1],
  ['bucket', [['iron_ingot', 3, 9]], 1, 1],
]) {
  test(`craft courant (vrai mineflayer) : ${name} ×${count}`, async () => {
    const bot = bench(items, [name]);
    const r = await craftItem(bot, { name, count, _sleep: fast });
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    assert.strictEqual(inv(bot)[name], expect);
  });
}

test('allocateCrafts (PUR) : répartit sur les variantes, partage les ingrédients communs', () => {
  const coalR = { delta: [{ id: 1, count: -1 }, { id: 3, count: -1 }, { id: 9, count: 4 }] };
  const charR = { delta: [{ id: 2, count: -1 }, { id: 3, count: -1 }, { id: 9, count: 4 }] };
  assert.deepStrictEqual(allocateCrafts([charR, coalR], 2, { 1: 1, 2: 1, 3: 6 }).map((p) => [p.recipe === charR ? 'char' : 'coal', p.count]),
    [['char', 1], ['coal', 1]]);
  // le bâton (commun) borne le total
  assert.strictEqual(allocateCrafts([charR, coalR], 3, { 1: 5, 2: 5, 3: 2 }), null);
  // une seule variante suffit → une seule tranche
  assert.deepStrictEqual(allocateCrafts([coalR, charR], 2, { 1: 4, 3: 6 }).map((p) => p.count), [2]);
  // quantité impossible → null (l'appelant garde le chemin historique)
  assert.strictEqual(allocateCrafts([coalR], 5, { 1: 2, 3: 9 }), null);
  assert.strictEqual(allocateCrafts([], 1, {}), null);
});

// ─── CRAFT MANUEL (26/10) : bouclier « missing ingredient » sur le vrai serveur (sonde CraftProbe) ───
const { shapedPlacement, hasAlternatingRow } = require('./craftManual');

test('shapedPlacement / hasAlternatingRow (PURS) : bouclier = planches ×6 + lingot ×1, ligne alternée', () => {
  const P = { id: 36 }; const L = { id: 842 }; const _ = { id: -1 };
  const shield = { inShape: [[P, L, P], [P, P, P], [_, P, _]] };
  assert.deepStrictEqual(shapedPlacement(shield), [{ id: 36, metadata: null, slots: [1, 3, 4, 5, 6, 8] }, { id: 842, metadata: null, slots: [2] }]);
  assert.strictEqual(hasAlternatingRow(shield), true);
  const pick = { inShape: [[L, L, L], [_, { id: 1 }, _], [_, { id: 1 }, _]] };
  assert.strictEqual(hasAlternatingRow(pick), false);
  assert.deepStrictEqual(shapedPlacement({ inShape: [[L, L], [L, _]] }).map((g) => g.slots), [[1, 2, 4]]);
  assert.strictEqual(shapedPlacement({ ingredients: [L] }), null);
  assert.strictEqual(shapedPlacement({ inShape: [[L, L, L, L]] }), null);
});

test('bouclier (vrai mineflayer) : chemin manuel — clics droits, aucun échange, curseur vide, restes rendus', async () => {
  const bot = bench([['oak_planks', 16, 38 - 1], ['iron_ingot', 2, 37 - 1]], ['shield']);
  let crafts = 0; const real = bot.craft; bot.craft = (...a) => { crafts++; return real(...a); };
  const r = await craftItem(bot, { name: 'shield', count: 1, _sleep: fast });
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  assert.strictEqual(crafts, 0, 'bot.craft n\'est pas appelé pour le bouclier');
  assert.deepStrictEqual(inv(bot), { oak_planks: 10, iron_ingot: 1, shield: 1 });
  const clicks = bot._srv.log.filter((l) => l[0] === 'window_click');
  assert.deepStrictEqual(clicks.filter((c) => c[2] === 1).map((c) => c[1]).sort(), [1, 2, 3, 4, 5, 6, 8]);
  assert.ok(clicks.some((c) => c[1] === 0 && c[3] === 1), 'shift-clic sur la case résultat');
  assert.strictEqual(bot.inventory.selectedItem || null, null);
});

test('relais manuel : bot.craft lève « missing ingredient » sur une recette en forme → le manuel sort la pioche', async () => {
  const bot = bench([['iron_ingot', 3, 9], ['stick', 2, 10]], ['iron_pickaxe']);
  bot.craft = async () => { throw new Error('missing ingredient'); };
  const r = await craftItem(bot, { name: 'iron_pickaxe', count: 1, _sleep: fast });
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  assert.deepStrictEqual(inv(bot), { iron_pickaxe: 1 });
});

test('manuel sans assez d\'ingrédients : échec propre, rien de perdu, fenêtre fermée', async () => {
  const bot = bench([['oak_planks', 5, 9], ['iron_ingot', 1, 10]], ['shield']);
  const r = await craftItem(bot, { name: 'shield', count: 1, _sleep: fast });
  assert.strictEqual(r.ok, false);
  await new Promise((res) => setTimeout(res, 30));
  assert.deepStrictEqual(inv(bot), { oak_planks: 5, iron_ingot: 1 });
  assert.strictEqual(bot.currentWindow || null, null);
});
