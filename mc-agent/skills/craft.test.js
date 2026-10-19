'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { craftItem, _nearestTable, tableKey, TABLE_REACH, TABLE_SEEK } = require('./craft');
const { createExpiringSet } = require('../mapper');   // la liste noire RÉELLEMENT branchée dans index.js

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

// ─── _nearestTable × liste noire (`exclude`) ──────────────────────────────────────────────────
// Run du 17-18/08 (216 sessions) : `reclaim_failed` ×11 565 et `table_recycled` ×11 440, quasi 1:1.
// Une table INATTEIGNABLE (tunnel d'un autre, derrière un mur, au-dessus d'un vide) était re-vue à
// chaque craft : marche de 30 s, reprise ratée, table neuve semée — puis rebelote au craft suivant.
// `findBlock` ne rend que la PLUS PROCHE : si c'est justement la table interdite, on reste aveugle
// aux autres. Avec `exclude`, `_nearestTable` demande donc plusieurs candidates (`findBlocks`).

test('tableKey : coordonnées ENTIÈRES du bloc, « x,y,z »', () => {
  assert.strictEqual(tableKey({ x: 12, y: -3, z: 7 }), '12,-3,7');
  // Une position fractionnaire désigne le bloc qui la contient (floor, pas trunc : -2.1 → -3).
  assert.strictEqual(tableKey({ x: 12.9, y: -2.1, z: 7.5 }), '12,-3,7');
});

// Bot à PLUSIEURS tables. `findBlocks` les rend dans l'ordre DONNÉ — volontairement désordonné
// dans les tests, pour prouver que le tri par distance est fait par `_nearestTable` lui-même.
function tablesBot(positions, at = { x: 0, y: 0, z: 0 }) {
  const calls = { findBlock: [], findBlocks: [], blockAt: [] };
  return {
    calls,
    registry: { blocksByName: { crafting_table: { id: 58 } } },
    entity: { position: at },
    findBlock(opts) { calls.findBlock.push(opts); throw new Error('avec exclude → findBlocks, jamais findBlock'); },
    findBlocks(opts) { calls.findBlocks.push(opts); return positions.slice(); },
    blockAt(pos) { calls.blockAt.push(pos); return { name: 'crafting_table', position: pos }; },
  };
}
const NEAR = { x: 3, y: 0, z: 0 };
const MID = { x: 10, y: 0, z: 0 };
const FAR = { x: 30, y: 0, z: 0 };
const keys = (...ps) => new Set(ps.map(tableKey));

test('_nearestTable sans exclude : chemin HISTORIQUE inchangé (un seul findBlock, forme exacte)', () => {
  for (const opts of [undefined, {}, { exclude: undefined }, { exclude: null }]) {
    const bot = fakeBot();        // pas de findBlocks : l'appeler lèverait un TypeError
    const t = opts === undefined ? _nearestTable(bot, TABLE_SEEK) : _nearestTable(bot, TABLE_SEEK, opts);
    assert.deepStrictEqual(bot.calls, [{ matching: [58], maxDistance: TABLE_SEEK }]);
    assert.deepStrictEqual(t, { position: { x: 0, y: 0, z: 0 } });
  }
});

test('exclude : saute la table la plus proche si elle est exclue et rend la SUIVANTE', () => {
  const bot = tablesBot([FAR, NEAR, MID]);
  const t = _nearestTable(bot, TABLE_SEEK, { exclude: keys(NEAR) });
  assert.deepStrictEqual(t.position, MID);
  assert.strictEqual(t.name, 'crafting_table');
});

test('exclude : rien d\'exclu → la plus proche, quel que soit l\'ordre rendu par findBlocks', () => {
  const bot = tablesBot([FAR, NEAR, MID]);
  assert.deepStrictEqual(_nearestTable(bot, TABLE_SEEK, { exclude: keys() }).position, NEAR);
});

test('exclude : la distance se mesure depuis le BOT (pas depuis l\'origine du monde)', () => {
  const bot = tablesBot([{ x: 0, y: 0, z: 0 }, { x: 110, y: 0, z: 0 }], { x: 100, y: 0, z: 0 });
  assert.deepStrictEqual(_nearestTable(bot, TABLE_SEEK, { exclude: keys() }).position, { x: 110, y: 0, z: 0 });
  // …et la verticale compte : une table 2 blocs plus haut passe après une table à plat à 1 bloc.
  const b2 = tablesBot([{ x: 5, y: 0, z: 0 }, { x: 5, y: 2, z: 0 }], { x: 4, y: 2, z: 0 });
  assert.deepStrictEqual(_nearestTable(b2, TABLE_SEEK, { exclude: keys() }).position, { x: 5, y: 2, z: 0 });
});

test('exclude : toutes les tables exclues → null (et pas undefined)', () => {
  const bot = tablesBot([FAR, NEAR, MID]);
  assert.strictEqual(_nearestTable(bot, TABLE_SEEK, { exclude: keys(NEAR, MID, FAR) }), null);
});

test('exclude : aucune table en vue (findBlocks → [] / null / undefined) → null', () => {
  for (const found of [[], null, undefined]) {
    const bot = tablesBot([]);
    bot.findBlocks = (opts) => { bot.calls.findBlocks.push(opts); return found; };
    assert.strictEqual(_nearestTable(bot, TABLE_SEEK, { exclude: keys() }), null);
  }
});

test('exclude : interroge findBlocks (matching, maxDistance, count 16) — jamais findBlock', () => {
  const bot = tablesBot([NEAR]);
  _nearestTable(bot, TABLE_REACH, { exclude: keys() });
  assert.deepStrictEqual(bot.calls.findBlocks, [{ matching: [58], maxDistance: TABLE_REACH, count: 16 }]);
  assert.strictEqual(bot.calls.findBlock.length, 0);
});

test('exclude : seule la table rendue est résolue en bloc (blockAt sur la 1re position PERMISE)', () => {
  const bot = tablesBot([FAR, NEAR, MID]);
  _nearestTable(bot, TABLE_SEEK, { exclude: keys(NEAR) });
  assert.deepStrictEqual(bot.calls.blockAt, [MID]);
});

test('exclude : blockAt nul (chunk évaporé) → on passe à la candidate suivante', () => {
  const bot = tablesBot([NEAR, MID]);
  bot.blockAt = (pos) => (pos === NEAR ? null : { name: 'crafting_table', position: pos });
  assert.deepStrictEqual(_nearestTable(bot, TABLE_SEEK, { exclude: keys() }).position, MID);
});

test('exclude : registre sans crafting_table → null, rien n\'est appelé', () => {
  const bot = tablesBot([NEAR]);
  bot.registry = { blocksByName: {} };
  assert.strictEqual(_nearestTable(bot, TABLE_SEEK, { exclude: keys() }), null);
  assert.strictEqual(bot.calls.findBlocks.length, 0);
});

test('exclude : bot sans `entity` (stub partiel) → ordre de findBlocks conservé, aucun crash', () => {
  const bot = tablesBot([NEAR, MID]);
  delete bot.entity;
  assert.deepStrictEqual(_nearestTable(bot, TABLE_SEEK, { exclude: keys(NEAR) }).position, MID);
});

test('exclude : tout objet exposant has(clé) convient (duck typing)', () => {
  const bot = tablesBot([NEAR, MID]);
  const asked = [];
  const exclude = { has: (k) => { asked.push(k); return k === tableKey(NEAR); } };
  assert.deepStrictEqual(_nearestTable(bot, TABLE_SEEK, { exclude }).position, MID);
  assert.deepStrictEqual(asked, [tableKey(NEAR), tableKey(MID)], 'les candidates sont testées de la plus proche à la plus lointaine');
});

// La vraie liste noire d'index.js : un set à OUBLI (30 min). Une table jugée inutilisable est
// ignorée, puis redevient candidate — le terrain change (un coéquipier ouvre un passage, la
// table est enfin reprise par un autre…), on ne la condamne pas à vie.
test('exclude = createExpiringSet réel : table ignorée pendant le TTL, de nouveau visible après', () => {
  const TTL = 30 * 60 * 1000;
  let now = 1_000;
  const bad = createExpiringSet({ now: () => now, ttlMs: TTL });
  const bot = tablesBot([NEAR, MID]);
  bad.add(tableKey(NEAR));
  assert.deepStrictEqual(_nearestTable(bot, TABLE_SEEK, { exclude: bad }).position, MID);
  now += TTL;                       // pile au TTL : toujours exclue (même seuil que mapper.js : > ttl)
  assert.deepStrictEqual(_nearestTable(bot, TABLE_SEEK, { exclude: bad }).position, MID);
  now += 1;                         // TTL dépassé : la liste l'a oubliée
  assert.deepStrictEqual(_nearestTable(bot, TABLE_SEEK, { exclude: bad }).position, NEAR);
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

// ─── craftItem × EFFET du craft ───────────────────────────────────────────────────────────────
// NethBot2, live : `goal planks` émis 111× en 2,2 s juste après une téléportation, aucun
// `goal_failed`, puis kick (flood de paquets). `craftItem` rendait {ok:true} dès que `bot.craft` ne
// levait pas — sans jamais regarder si l'inventaire avait bougé. Or `bot.craft` ne lève que sur une
// erreur CLIENT (ingrédient manquant, table requise) : un craft que le serveur ignore (fenêtre
// périmée, état désynchronisé après un tp) « réussit » en silence, et le planner le relance à
// l'infini. On attend donc de VOIR le produit arriver en inventaire (sondage 50 ms, 600 ms max) ;
// sinon `craft_no_effect` — une DÉSYNC, pas une recette 3×3 manquante : `craftSmart` (index.js) ne
// teste que 'no_recipe' / 'craft_failed' pour aller chercher une table, il ne doit pas la déclencher.

// `_sleep` factice : enregistre chaque attente, et laisse un test faire « arriver » l'effet côté
// serveur au bout de N ms simulées (`onSleep(totalMs)`). Aucune attente réelle.
function fakeSleep(onSleep) {
  const log = [];
  const fn = async (ms) => { log.push(ms); if (onSleep) onSleep(log.reduce((a, b) => a + b, 0)); };
  fn.log = log;
  fn.total = () => log.reduce((a, b) => a + b, 0);
  return fn;
}

test('effet : craft qui PRODUIT → {ok:true} EXACT, vu dès la 1re lecture (aucune attente)', async () => {
  const bot = craftBot({ oak_log: 4 }, { table: null });
  const sleep = fakeSleep();
  const r = await craftItem(bot, { name: 'oak_planks', count: 1, _sleep: sleep });
  assert.deepStrictEqual(r, { ok: true });
  assert.strictEqual(bot.counts.oak_planks, 4);
  assert.deepStrictEqual(sleep.log, [], 'le produit est déjà là : on ne dort pas');
});

test('effet : bot.craft « réussit » mais l\'inventaire ne bouge pas → craft_no_effect après 600 ms de sondage', async () => {
  const bot = craftBot({ oak_log: 4 }, { table: null });
  bot.craft = async () => {};            // rien levé côté client, rien pris en compte côté serveur
  const sleep = fakeSleep();
  const r = await craftItem(bot, { name: 'oak_planks', count: 1, _sleep: sleep });
  assert.deepStrictEqual(r, { ok: false, reason: 'craft_no_effect' });
  assert.deepStrictEqual(sleep.log, new Array(12).fill(50), '12 attentes de 50 ms = 600 ms, pas une de plus');
});

test('effet TARDIF (le serveur confirme après ~250 ms) : vu au sondage → {ok:true}', async () => {
  const bot = craftBot({ oak_log: 4 }, { table: null });
  bot.craft = async () => {};
  const sleep = fakeSleep((total) => { if (total >= 250) bot.counts.oak_planks = 4; });
  const r = await craftItem(bot, { name: 'oak_planks', count: 1, _sleep: sleep });
  assert.deepStrictEqual(r, { ok: true });
  assert.strictEqual(sleep.total(), 250, 'on sort dès que le produit est vu, sans épuiser les 600 ms');
});

test('effet trop TARDIF (650 ms) : la fenêtre est de 600 ms → craft_no_effect', async () => {
  const bot = craftBot({ oak_log: 4 }, { table: null });
  bot.craft = async () => {};
  const sleep = fakeSleep((total) => { if (total >= 650) bot.counts.oak_planks = 4; });
  const r = await craftItem(bot, { name: 'oak_planks', count: 1, _sleep: sleep });
  assert.deepStrictEqual(r, { ok: false, reason: 'craft_no_effect' });
  assert.strictEqual(sleep.total(), 600);
});

test('effet : seul le PRODUIT compte (un autre item qui augmente ne prouve rien)', async () => {
  const bot = craftBot({ oak_log: 4 }, { table: null });
  bot.craft = async () => { bot.counts.stick = 8; };   // un craft fantôme dépose AUTRE CHOSE
  const r = await craftItem(bot, { name: 'oak_planks', count: 1, _sleep: fakeSleep() });
  assert.deepStrictEqual(r, { ok: false, reason: 'craft_no_effect' });
});

// Inventaire PLEIN, tel que mineflayer le gère (putSelectedItemRange : ni case vide ni pile à
// compléter → « no room => drop it ») : `bot.craft` rend la main normalement, les ingrédients sont
// CONSOMMÉS, le produit est jeté au sol. Piste probable de l'incident NethBot2 (non confirmée en live).
test('effet : inventaire PLEIN (résultat jeté au sol, ingrédients consommés) → craft_no_effect', async () => {
  const bot = craftBot({ oak_log: 6 }, { table: null });
  bot.inventory.emptySlotCount = () => 0;
  bot.craft = async (recipe, count) => {
    for (const d of recipe.delta) {
      if (d.count < 0) bot.counts[registry.items[d.id].name] += d.count * (count == null ? 1 : count);   // ingrédients pris…
    }                                                                                                      // …produit jeté, pas en poche
  };
  const sleep = fakeSleep();
  const r = await craftItem(bot, { name: 'oak_planks', count: 2, _sleep: sleep });
  assert.deepStrictEqual(r, { ok: false, reason: 'craft_no_effect' });
  assert.strictEqual(bot.counts.oak_log, 4, 'les 2 bûches sont parties : le verdict ne les rend pas, il EMPÊCHE de recommencer en boucle');
  assert.strictEqual(bot.counts.oak_planks || 0, 0);
});

test('effet : la raison est DISTINCTE de no_recipe / craft_failed (craftSmart n\'ira pas chercher de table)', async () => {
  const bot = craftBot({ oak_log: 4 }, { table: null });
  bot.craft = async () => {};
  const r = await craftItem(bot, { name: 'oak_planks', _sleep: fakeSleep() });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'craft_no_effect', 'sans cette assertion, les deux ci-dessous passeraient à vide');
  assert.notStrictEqual(r.reason, 'no_recipe');
  assert.notStrictEqual(r.reason, 'craft_failed');
});

test('effet : bot.craft qui LÈVE → craft_failed comme avant, sans attendre 600 ms', async () => {
  const bot = craftBot({ oak_log: 4 }, { table: null });
  bot.craft = async () => { throw new Error('missing ingredient'); };
  const sleep = fakeSleep();
  assert.deepStrictEqual(await craftItem(bot, { name: 'oak_planks', _sleep: sleep }), { ok: false, reason: 'craft_failed' });
  assert.deepStrictEqual(sleep.log, []);
});

// Le produit est lu AVANT le craft : un stock préexistant ne doit pas passer pour un effet.
test('effet : un stock PRÉEXISTANT du produit n\'est pas un effet (on compare à l\'avant-craft)', async () => {
  const bot = craftBot({ oak_log: 4, oak_planks: 7 }, { table: null });
  bot.craft = async () => {};
  const r = await craftItem(bot, { name: 'oak_planks', count: 1, _sleep: fakeSleep() });
  assert.deepStrictEqual(r, { ok: false, reason: 'craft_no_effect' });
});

test('effet : plusieurs piles du produit sont ADDITIONNÉES (la pile pleine ne bouge pas, la 2e reçoit le craft)', async () => {
  const bot = craftBot({ oak_log: 4 }, { table: null });
  const realItems = bot.inventory.items;
  bot.inventory.items = () => {
    const out = realItems().filter((i) => i.name !== 'oak_planks');
    out.push({ name: 'oak_planks', count: 64 });                                            // pile pleine, immobile…
    if (bot.counts.oak_planks > 0) out.push({ name: 'oak_planks', count: bot.counts.oak_planks });   // …et celle qui reçoit
    return out;
  };
  const sleep = fakeSleep();
  assert.deepStrictEqual(await craftItem(bot, { name: 'oak_planks', count: 1, _sleep: sleep }), { ok: true });
  assert.deepStrictEqual(sleep.log, [], 'si seule la 1re pile était lue (64 → 64), on y verrait un craft sans effet');
});

// Rétro-compat : un vieux stub sans inventaire lisible ne permet aucune vérification → on ne
// l'invente pas (contrat inchangé : {ok:true}). Un vrai bot a toujours `inventory.items()`.
test('effet : inventaire illisible (vieux stub) → rien à vérifier, {ok:true} comme avant', async () => {
  const bots = [
    { registry, findBlock: () => null, recipesFor: () => [{ id: 1 }], craft: async () => {} },                               // pas d'inventory
    { registry, findBlock: () => null, inventory: {}, recipesFor: () => [{ id: 1 }], craft: async () => {} },                // pas d'items()
    { registry, findBlock: () => null, inventory: { items: () => { throw new Error('boom'); } },
      recipesFor: () => [{ id: 1 }], craft: async () => {} },                                                               // items() lève
  ];
  for (const bot of bots) {
    const sleep = fakeSleep();
    assert.deepStrictEqual(await craftItem(bot, { name: 'crafting_table', _sleep: sleep }), { ok: true });
    assert.deepStrictEqual(sleep.log, []);
  }
});

// Le `_sleep` traverse la conversion de bûches : un craft de planches sans effet y est attrapé AUSSI,
// et le bouclier n'est jamais « fabriqué » sur du vent. (La raison de surface reste 'no_recipe' —
// contrat inchangé — avec le détail à côté, dans `planks`.)
test('effet × planches hétérogènes : la conversion de bûches sans effet est attrapée (planks_craft_failed)', async () => {
  const bot = craftBot({ oak_planks: 3, birch_planks: 3, iron_ingot: 1, oak_log: 30 });
  const realCraft = bot.craft;
  bot.craft = async (recipe, ...rest) => {
    if (registry.items[recipe.result.id].name === 'oak_planks') return;   // les planches n'arrivent jamais
    return realCraft(recipe, ...rest);
  };
  const sleep = fakeSleep();
  const r = await craftItem(bot, { name: 'shield', _sleep: sleep });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'no_recipe');
  assert.equal(r.planks, 'planks_craft_failed');
  assert.equal(bot.counts.shield || 0, 0);
  assert.deepStrictEqual(sleep.log, new Array(12).fill(50), '_sleep est bien transmis à la conversion de planches');
});

// ─── L'incident NethBot2 de bout en bout (craftItem + planner) ────────────────────────────────
// Reproduit la séquence mesurée : le client envoie le craft, le serveur l'ignore, le bot se recale
// (sa position change à chaque tour) — le fingerprint ne stalle donc jamais. Avant : 111 crafts en
// 2,2 s puis kick. Maintenant `craftItem` rend {ok:false, craft_no_effect} : le chemin des échecs
// explicites (failStreak) arrête la boucle au 4e tour.
test('INCIDENT : craft ignoré du serveur + position qui bouge → 4 crafts envoyés puis stalled (et non 111)', async () => {
  const { runPlanner } = require('../planner');
  const bot = craftBot({ oak_log: 8 }, { table: null });
  let x = 0;
  let sent = 0;
  bot.entity = { position: { get x() { return x; }, y: 64, z: 0 } };
  bot.craft = async () => { sent++; x += 1; };       // envoyé, ignoré, et le bot se recale
  const r = await runPlanner(bot, {
    chain: [{ name: 'planks', met: (c) => (c.inv.oak_planks || 0) >= 8, skill: 'craftPlanks', args: { count: 2 } }],
    ctxExtra: () => ({}),
    sleep: async () => {},                              // la garde anti-boucle-chaude dormirait pour de vrai au 3e tour
    runSkill: (g, b) => craftItem(b, { name: 'oak_planks', count: g.args.count, _sleep: fakeSleep() }),
  }, { cancelled: false });
  assert.deepStrictEqual(r, { stalled: true, goal: 'planks' });
  assert.strictEqual(sent, 4, 'le serveur reçoit 4 crafts, pas un flood');
});
