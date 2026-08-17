'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { craftItem, _nearestTable, TABLE_REACH, TABLE_SEEK } = require('./craft');

// Bot minimal : on capture l'argument passé à findBlock pour vérifier le rayon.
function fakeBot(found = { position: { x: 0, y: 0, z: 0 } }) {
  const calls = [];
  return {
    calls,
    registry: { blocksByName: { crafting_table: { id: 58 } } },
    findBlock(opts) { calls.push(opts); return found; },
  };
}

test('_nearestTable : rayon par défaut = portée de CRAFT (bot.craft exige la table à portée)', () => {
  const bot = fakeBot();
  _nearestTable(bot);
  assert.strictEqual(bot.calls[0].maxDistance, TABLE_REACH);
  assert.ok(TABLE_REACH <= 6, 'la portée de craft doit rester courte');
});

// Massii, 26/07 : « il fait plein de crafting alors qu'il y en a à côté, au spawn il y en a une
// vingtaine ». Avec un rayon unique de 6, une table posée 10 blocs plus loin est INVISIBLE → le bot
// en repose une au lieu d'aller à l'existante. On sépare donc CHERCHER (large, on marche jusqu'à
// elle) de CRAFTER (court, la table doit être à portée de main).
test('_nearestTable : rayon explicite pour CHERCHER une table existante au loin', () => {
  const bot = fakeBot();
  _nearestTable(bot, TABLE_SEEK);
  assert.strictEqual(bot.calls[0].maxDistance, TABLE_SEEK);
  assert.ok(TABLE_SEEK >= 32, 'la recherche doit porter bien au-delà de la portée de craft');
});

test('_nearestTable : registre sans crafting_table → null (jamais findBlock(matching:null))', () => {
  const bot = { registry: { blocksByName: {} }, findBlock() { throw new Error('ne doit pas être appelé'); } };
  assert.strictEqual(_nearestTable(bot), null);
});

test('_nearestTable : aucune table trouvée → null (et pas undefined)', () => {
  const bot = fakeBot(null);
  assert.strictEqual(_nearestTable(bot), null);
});

// ─── craftItem × planches hétérogènes ─────────────────────────────────────────────────────────
// Run world_mn14 : 235 `craft_failed:table_present` + 5 `no_recipe` sur le but `shield` en 3 h,
// 100 % d'échec, alors que 3 boucliers étaient sortis plus tôt (inventaires homogènes).
//
// Le bot de test rejoue les VRAIES recettes de minecraft-data et les VRAIES fonctions de
// mineflayer (`recipesFor`/`requirementsMetForRecipe`/`craft`, lib/plugins/craft.js) : c'est le
// mécanisme réel qui est mis à l'épreuve, pas ma reconstitution de ce mécanisme.
const registry = require('prismarine-registry')('1.21.4');
const { Recipe } = require('prismarine-recipe')(registry);

function craftBot(inv, { table = { position: { x: 0, y: 0, z: 0 } } } = {}) {
  const counts = Object.assign({}, inv);
  const crafted = [];
  const bot = {
    registry,
    counts,
    crafted,
    inventory: {
      items: () => Object.keys(counts).filter((n) => counts[n] > 0)
        .map((name, i) => ({ name, count: counts[name], type: registry.itemsByName[name].id, slot: 9 + i })),
      // mineflayer : requirementsMetForRecipe appelle count(id, metadata)
      count: (id) => { const d = registry.items[id]; return d ? (counts[d.name] || 0) : 0; },
    },
    findBlock: () => table,
    // copie fidèle de mineflayer/lib/plugins/craft.js
    recipesFor(itemType, metadata, minResultCount, craftingTable) {
      const min = minResultCount == null ? 1 : minResultCount;
      return Recipe.find(itemType, metadata).filter((r) => {
        if (r.requiresTable && !craftingTable) return false;
        const craftCount = Math.ceil(min / r.result.count);
        for (const d of r.delta) if (bot.inventory.count(d.id) + d.count * craftCount < 0) return false;
        return true;
      });
    },
    recipesAll(itemType, metadata, craftingTable) {
      return Recipe.find(itemType, metadata).filter((r) => !r.requiresTable || craftingTable);
    },
    async craft(recipe, count, craftingTable) {
      const n = count == null ? 1 : count;
      if (recipe.requiresTable && !craftingTable) throw new Error('Recipe requires craftingTable');
      for (let i = 0; i < n; i++) {
        for (const d of recipe.delta) {
          const name = registry.items[d.id].name;
          const next = (counts[name] || 0) + d.count;
          if (next < 0) throw new Error('missing ingredient'); // mineflayer clickShape
          counts[name] = next;
        }
      }
      crafted.push({ item: registry.items[recipe.result.id].name, count: n });
    },
  };
  return bot;
}

// LA PREUVE du mécanisme : ce n'est pas `bot.craft` qui lève, c'est `recipesFor` qui rend [].
// minecraft-data n'a pas de recette « n'importe quelles planches » : le bouclier en a 12,
// une par essence, chacune exigeant 6 planches de CETTE essence.
test('DIAGNOSTIC : 6 planches sur 2 essences → recipesFor rend [] (recettes CONCRÈTES par essence)', () => {
  const bot = craftBot({ oak_planks: 3, birch_planks: 3, iron_ingot: 1 });
  const id = registry.itemsByName.shield.id;
  assert.equal(bot.recipesAll(id, null, {}).length, 12, '12 recettes, une par essence de planche');
  assert.equal(bot.recipesFor(id, null, 1, {}).length, 0, 'aucune essence n\'atteint 6 → aucune recette');
  // …et 6 planches d'UNE essence suffisent : la matière n'a jamais manqué, l'essence si.
  assert.equal(craftBot({ oak_planks: 6, iron_ingot: 1 }).recipesFor(id, null, 1, {}).length, 1);
});

test('bouclier : 3 oak + 3 birch + bûches → le craft PASSE (homogénéisation d\'essence)', async () => {
  const bot = craftBot({ oak_planks: 3, birch_planks: 3, iron_ingot: 1, oak_log: 30 });
  const r = await craftItem(bot, { name: 'shield' });
  assert.equal(r.ok, true, 'échec inattendu : ' + r.reason);
  assert.equal(bot.counts.shield, 1);
  assert.equal(bot.counts.oak_log, 29, 'une seule bûche convertie (3 + 4 = 7 ≥ 6)');
  assert.equal(bot.counts.birch_planks, 3, 'le bouleau n\'est pas touché');
  assert.equal(bot.counts.iron_ingot, 0);
});

// L'inventaire réel des ouvriers : 30 à 240 bûches en poche pendant tout le run.
test('bouclier : zéro planche mais 240 bûches → 2 bûches converties, craft OK', async () => {
  const bot = craftBot({ iron_ingot: 1, oak_log: 240 });
  const r = await craftItem(bot, { name: 'shield' });
  assert.equal(r.ok, true, 'échec inattendu : ' + r.reason);
  assert.equal(bot.counts.oak_log, 238);
  assert.equal(bot.counts.oak_planks, 2, '8 planches craftées, 6 consommées');
});

test('bouclier : planches mixtes SANS bûches → no_recipe PROPRE (contrat inchangé pour index.js)', async () => {
  const bot = craftBot({ oak_planks: 3, birch_planks: 3, iron_ingot: 1 });
  const r = await craftItem(bot, { name: 'shield' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'no_recipe', 'craftSmart teste `reason === no_recipe` à l\'identique');
  assert.equal(r.planks, 'no_logs', 'la vraie cause est tracée à côté, sans changer `reason`');
  assert.equal(bot.crafted.length, 0, 'aucun craft tenté : rien de brûlé pour rien');
});

// Le lingot manque : convertir du bois ne débloquerait rien → on n'y touche pas.
test('bouclier : lingot manquant → aucune bûche convertie', async () => {
  const bot = craftBot({ oak_planks: 3, birch_planks: 3, oak_log: 30 });
  const r = await craftItem(bot, { name: 'shield' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'no_recipe');
  assert.equal(bot.counts.oak_log, 30, 'stock de bûches intact');
});

// La réserve protège l'input du charbon de bois (smeltCharcoalGoal veut count+1 bûches).
test('bouclier : réserve de bûches respectée → no_recipe/reserve, stock intact', async () => {
  const bot = craftBot({ oak_planks: 3, birch_planks: 3, iron_ingot: 1, oak_log: 2 });
  const r = await craftItem(bot, { name: 'shield' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'no_recipe');
  assert.equal(r.planks, 'reserve');
  assert.equal(bot.counts.oak_log, 2);
});

// Le correctif est GÉNÉRIQUE : toutes les recettes à planches en profitent, pas le seul bouclier.
test('table de craft (4 planches, 2×2 sans table) : mixte + bûches → craft OK', async () => {
  const bot = craftBot({ oak_planks: 2, birch_planks: 2, oak_log: 30 }, { table: null });
  const r = await craftItem(bot, { name: 'crafting_table' });
  assert.equal(r.ok, true, 'échec inattendu : ' + r.reason);
  assert.equal(bot.counts.crafting_table, 1);
});

test('bâtons (2 planches) : 1 oak + 1 birch + bûches → craft OK', async () => {
  const bot = craftBot({ oak_planks: 1, birch_planks: 1, oak_log: 30 }, { table: null });
  const r = await craftItem(bot, { name: 'stick' });
  assert.equal(r.ok, true, 'échec inattendu : ' + r.reason);
  assert.equal(bot.counts.stick, 4);
});

// Le vrai blocage est alors la TABLE, pas l'essence : on ne convertit rien avant d'y être.
// (`withCraftingTable` rappellera craftItem une fois le bot devant la table.)
test('recette 3×3 sans table à portée : rien n\'est converti (le blocage est la table)', async () => {
  const bot = craftBot({ oak_planks: 3, birch_planks: 3, iron_ingot: 1, oak_log: 30 }, { table: null });
  const r = await craftItem(bot, { name: 'shield' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'no_recipe');
  assert.equal(bot.counts.oak_log, 30, 'stock intact tant que la table manque');
});

test('craftItem : item inconnu → unknown_item (contrat inchangé)', async () => {
  const bot = craftBot({ oak_log: 30 });
  assert.deepEqual(await craftItem(bot, { name: 'pas_un_item' }), { ok: false, reason: 'unknown_item' });
});

// Rétro-compat : un bot sans `recipesAll` (vieux stub) ne doit pas planter, juste ne rien tenter.
test('craftItem : bot sans recipesAll → no_recipe, aucun crash', async () => {
  const bot = craftBot({ oak_planks: 3, birch_planks: 3, iron_ingot: 1, oak_log: 30 });
  bot.recipesAll = undefined;
  const r = await craftItem(bot, { name: 'shield' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'no_recipe');
});
