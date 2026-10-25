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
  { const r = await craftItem(bot, { name: 'oak_planks', _sleep: sleep }); assert.strictEqual(r.ok, false); assert.strictEqual(r.reason, 'craft_failed'); }
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

// ─── PLACE POUR LE RÉSULTAT : pickJunkToToss / needsRoomFor (fonctions PURES) ─────────────────
// Remède de fond de l'incident : inventaire PLEIN → mineflayer JETTE le résultat du craft au sol
// (putSelectedItemRange : « no room => drop it »). Avant de crafter, craftItem jette UNE pile de
// déchet. Les déchets sont une LISTE BLANCHE ordonnée : tout le reste n'est jamais touché.
const { pickJunkToToss, needsRoomFor, COBBLE_KEEP, JUNK_TIERS } = require('./craft');

// Fabrique un inventaire minimal [{name,count}] à partir de paires — `slot` croissant comme en vrai.
const stacksOf = (pairs) => pairs.map(([name, count], i) => ({ name, count, slot: 9 + i }));
const pick = (pairs, opts) => {
  const items = stacksOf(pairs);
  const it = pickJunkToToss(items, opts);
  return it ? { name: it.name, count: it.count } : null;
};

test('pickJunkToToss : priorité terre > gravier > granite/diorite/andésite/tuf/calcite > netherrack > cobbled_deepslate > cobble', () => {
  const items = stacksOf([
    ['cobblestone', 64], ['cobblestone', 64], ['cobbled_deepslate', 64], ['cobbled_deepslate', 50],
    ['netherrack', 64], ['calcite', 40], ['granite', 12], ['tuff', 3], ['gravel', 30],
    ['rooted_dirt', 20], ['dirt', 10], ['coarse_dirt', 5],
  ]);
  const order = [];
  let left = items.slice();
  for (;;) {
    const it = pickJunkToToss(left);
    if (!it) break;
    order.push(it.name + ':' + it.count);
    left = left.filter((x) => x !== it);
  }
  assert.deepStrictEqual(order, [
    'coarse_dirt:5', 'dirt:10', 'rooted_dirt:20',      // palier 1, la PLUS PETITE pile d'abord
    'gravel:30',
    'tuff:3', 'granite:12', 'calcite:40',              // palier 3 (idem)
    'netherrack:64',
    'cobbled_deepslate:50',                            // au-delà de 32 : la pile de 50 part (reste 64)…
    'cobblestone:64',                                  // …la 2e (64 seule → il resterait 0) est protégée ; cobble : 2 piles de 64 → une part
  ]);
  assert.deepStrictEqual(left.map((x) => x.name + ':' + x.count), ['cobblestone:64', 'cobbled_deepslate:64'],
    'il reste exactement la réserve : une pile de chaque cobble');
});

test('pickJunkToToss : terre / rooted_dirt / coarse_dirt forment UN palier (la plus petite pile gagne)', () => {
  assert.deepStrictEqual(pick([['rooted_dirt', 7], ['dirt', 40], ['coarse_dirt', 30]]), { name: 'rooted_dirt', count: 7 });
  assert.deepStrictEqual(pick([['dirt', 40], ['coarse_dirt', 30], ['rooted_dirt', 7]]), { name: 'rooted_dirt', count: 7 });
});

test('pickJunkToToss : à taille égale la 1re rencontrée gagne (déterministe) et le résultat est la RÉFÉRENCE', () => {
  const items = stacksOf([['gravel', 10], ['gravel', 10], ['dirt', 64], ['cobblestone', 64], ['cobblestone', 64]]);
  assert.strictEqual(pickJunkToToss(items), items[2], 'terre d\'abord, même si elle est plus grosse que le gravier');
  // Remblai (FILL_KEEP 64, 23/10) : jeter les 64 de terre laisserait 20 blocs au total → le gravier part.
  const thin = stacksOf([['gravel', 10], ['gravel', 10], ['dirt', 64]]);
  assert.strictEqual(pickJunkToToss(thin), thin[0], 'la réserve de remblai de 64 prime sur l\'ordre des paliers');
  const g = stacksOf([['gravel', 10], ['gravel', 10]]);
  assert.strictEqual(pickJunkToToss(g), g[0]);
});

test('pickJunkToToss : le cobble SOUS 32 n\'est jamais jeté (ni 32 pile, ni une pile unique, ni deux demi-réserves)', () => {
  assert.strictEqual(COBBLE_KEEP, 32);
  for (const name of ['cobblestone', 'cobbled_deepslate']) {
    assert.strictEqual(pick([[name, 10]]), null, name + ' ×10');
    assert.strictEqual(pick([[name, 32]]), null, name + ' ×32 pile');
    assert.strictEqual(pick([[name, 33]]), null, name + ' ×33 en UNE pile : il resterait 0');
    assert.strictEqual(pick([[name, 64]]), null, name + ' ×64 en UNE pile : il resterait 0');
    assert.strictEqual(pick([[name, 20], [name, 12]]), null, name + ' 20+12 = 32 : partir de l\'une perce la réserve');
    assert.strictEqual(pick([[name, 20], [name, 20]]), null, name + ' 20+20 = 40 mais aucune pile ne part sans passer sous 32');
  }
});

test('pickJunkToToss : le cobble AU-DELÀ de 32 part pile par pile, en gardant toujours ≥ 32', () => {
  assert.deepStrictEqual(pick([['cobblestone', 32], ['cobblestone', 8]]), { name: 'cobblestone', count: 8 }, '40 au total : la pile de 8 part, il reste 32');
  assert.deepStrictEqual(pick([['cobblestone', 64], ['cobblestone', 40]]), { name: 'cobblestone', count: 40 }, 'la plus petite pile jetable');
  assert.deepStrictEqual(pick([['cobblestone', 64], ['cobblestone', 64], ['cobblestone', 64]]), { name: 'cobblestone', count: 64 });
  // La réserve se compte PAR NOM (lecture littérale « au-delà de 32 », prudente) : 30 + 30 mélangés ne s'additionnent pas.
  assert.strictEqual(pick([['cobblestone', 30], ['cobbled_deepslate', 30]]), null);
});

test('pickJunkToToss : cobbled_deepslate part avant le cobblestone', () => {
  assert.deepStrictEqual(
    pick([['cobblestone', 64], ['cobblestone', 64], ['cobbled_deepslate', 64], ['cobbled_deepslate', 64]]),
    { name: 'cobbled_deepslate', count: 64 });
});

// JAMAIS : outils, armure, nourriture, bois/planches/bâtons, minerais/lingots/charbon, table, four,
// torches, seau, canne… — liste blanche : ce qui n'y figure pas ne peut pas partir, même isolé.
test('pickJunkToToss : JAMAIS outils, armure, nourriture, bois, minerais, utilitaires (liste blanche)', () => {
  const never = [
    'wooden_pickaxe', 'stone_pickaxe', 'iron_pickaxe', 'diamond_pickaxe', 'iron_axe', 'stone_shovel', 'iron_hoe',
    'wooden_sword', 'diamond_sword', 'bow', 'crossbow', 'shield', 'arrow',
    'iron_helmet', 'iron_chestplate', 'iron_leggings', 'iron_boots', 'diamond_helmet',
    'cooked_beef', 'cooked_porkchop', 'bread', 'apple', 'golden_apple', 'carrot', 'baked_potato', 'beef',
    'oak_log', 'spruce_log', 'birch_log', 'oak_planks', 'birch_planks', 'stick',
    'coal', 'charcoal', 'raw_iron', 'iron_ingot', 'gold_ingot', 'raw_gold', 'diamond', 'redstone', 'lapis_lazuli',
    'copper_ingot', 'raw_copper', 'iron_ore', 'deepslate_iron_ore', 'coal_ore',
    'crafting_table', 'furnace', 'chest', 'torch', 'bucket', 'water_bucket', 'lava_bucket', 'fishing_rod',
  ];
  assert.strictEqual(pickJunkToToss(stacksOf(never.map((n) => [n, 64]))), null);
  // Mêlés à UN déchet, seul le déchet est choisi.
  const mixed = stacksOf(never.map((n) => [n, 64]).concat([['gravel', 5]]));
  assert.strictEqual(pickJunkToToss(mixed).name, 'gravel');
});

test('pickJunkToToss : opts.exclude protège ce que la recette consomme ou produit (tableau ou Set)', () => {
  const inv = [['dirt', 40], ['gravel', 10], ['cobblestone', 64], ['cobblestone', 64]];
  assert.deepStrictEqual(pick(inv, { exclude: ['dirt'] }), { name: 'gravel', count: 10 });
  assert.deepStrictEqual(pick(inv, { exclude: new Set(['dirt', 'gravel']) }), { name: 'cobblestone', count: 64 });
  assert.strictEqual(pick(inv, { exclude: ['dirt', 'gravel', 'cobblestone'] }), null);
  assert.deepStrictEqual(pick(inv, { exclude: undefined }), { name: 'dirt', count: 40 }, 'sans exclusion : la terre, comme par défaut');
});

test('pickJunkToToss : entrées bizarres → null sans crash, et l\'entrée n\'est jamais modifiée', () => {
  for (const bad of [undefined, null, 'x', 42, {}, []]) assert.strictEqual(pickJunkToToss(bad), null);
  const items = [null, undefined, { count: 5 }, { name: 'dirt' }, { name: 'dirt', count: 0 }, { name: 'dirt', count: 'abc' }, { name: 'gravel', count: 3 }];
  const copy = JSON.parse(JSON.stringify(items));
  assert.deepStrictEqual(pickJunkToToss(items), items[6], 'seules les piles bien formées et non vides comptent');
  assert.deepStrictEqual(JSON.parse(JSON.stringify(items)), copy, 'aucune mutation');
});

test('JUNK_TIERS : liste blanche exacte, dans l\'ordre demandé', () => {
  assert.deepStrictEqual(JUNK_TIERS.map((t) => t.names), [
    ['dirt', 'coarse_dirt', 'rooted_dirt'], ['gravel'], ['granite', 'diorite', 'andesite', 'tuff', 'calcite'],
    ['netherrack'],
    ['dripstone_block', 'pointed_dripstone', 'flint', 'feather', 'bone', 'egg', 'wheat_seeds', 'leather',
      'armadillo_scute', 'oak_sapling', 'birch_sapling', 'spruce_sapling', 'acacia_sapling', 'jungle_sapling',
      'dark_oak_sapling', 'cherry_sapling', 'mangrove_propagule', 'amethyst_shard', 'clay_ball', 'sand', 'red_sand',
      'spider_eye', 'sandstone', 'mossy_cobblestone', 'smooth_basalt'],
    ['cobbled_deepslate'], ['cobblestone'],
  ]);
  assert.deepStrictEqual(JUNK_TIERS.map((t) => t.keep), [0, 0, 0, 0, 0, 32, 32]);
});

test('needsRoomFor : seulement si AUCUNE case vide ET pas de place dans les piles du produit', () => {
  const planks = (n) => [{ name: 'oak_planks', count: n, stackSize: 64 }];
  assert.strictEqual(needsRoomFor({ emptySlots: 0, items: [], product: 'oak_planks', need: 4 }), true, 'plein, aucune pile du produit');
  assert.strictEqual(needsRoomFor({ emptySlots: 1, items: [], product: 'oak_planks', need: 4 }), false, 'une case vide suffit');
  assert.strictEqual(needsRoomFor({ emptySlots: 12, items: [], product: 'oak_planks', need: 4 }), false);
  assert.strictEqual(needsRoomFor({ emptySlots: null, items: [], product: 'oak_planks', need: 4 }), false, 'nombre de cases inconnu : on ne jette rien');
  assert.strictEqual(needsRoomFor({ emptySlots: undefined, items: [], product: 'oak_planks', need: 4 }), false);
  assert.strictEqual(needsRoomFor({ emptySlots: 0, items: planks(10), product: 'oak_planks', need: 4 }), false, '54 de place dans la pile');
  assert.strictEqual(needsRoomFor({ emptySlots: 0, items: planks(60), product: 'oak_planks', need: 4 }), false, 'place pile pour 4 : 64-60');
  assert.strictEqual(needsRoomFor({ emptySlots: 0, items: planks(61), product: 'oak_planks', need: 4 }), true, '3 de place < 4');
  assert.strictEqual(needsRoomFor({ emptySlots: 0, items: planks(64), product: 'oak_planks', need: 1 }), true, 'pile pleine');
});

test('needsRoomFor : la place se CUMULE sur plusieurs piles ; une autre pile (autre item) n\'en offre pas', () => {
  const items = [{ name: 'oak_planks', count: 62, stackSize: 64 }, { name: 'oak_planks', count: 62, stackSize: 64 }, { name: 'dirt', count: 1, stackSize: 64 }];
  assert.strictEqual(needsRoomFor({ emptySlots: 0, items, product: 'oak_planks', need: 4 }), false, '2 + 2 = 4');
  assert.strictEqual(needsRoomFor({ emptySlots: 0, items, product: 'oak_planks', need: 5 }), true);
  assert.strictEqual(needsRoomFor({ emptySlots: 0, items, product: 'stick', need: 1 }), true, 'la terre ne sert pas de place pour des bâtons');
});

test('needsRoomFor : taille de pile du produit (non empilable = jamais de place) et défauts', () => {
  assert.strictEqual(needsRoomFor({ emptySlots: 0, items: [{ name: 'shield', count: 1, stackSize: 1 }], product: 'shield', need: 1 }), true);
  // Une pile qui n'expose pas stackSize : on prend celui du registre (param), puis 64.
  assert.strictEqual(needsRoomFor({ emptySlots: 0, items: [{ name: 'torch', count: 60 }], product: 'torch', need: 4 }), false, 'défaut 64 → 4 de place');
  assert.strictEqual(needsRoomFor({ emptySlots: 0, items: [{ name: 'ender_pearl', count: 15 }], product: 'ender_pearl', need: 1, stackSize: 16 }), false);
  assert.strictEqual(needsRoomFor({ emptySlots: 0, items: [{ name: 'ender_pearl', count: 16 }], product: 'ender_pearl', need: 1, stackSize: 16 }), true);
  // need absent / invalide → 1 exemplaire.
  const fullPlanks = [{ name: 'oak_planks', count: 64, stackSize: 64 }];
  assert.strictEqual(needsRoomFor({ emptySlots: 0, items: [], product: 'oak_planks' }), true);
  assert.strictEqual(needsRoomFor({ emptySlots: 0, items: fullPlanks, product: 'oak_planks', need: 0 }), true);
  assert.strictEqual(needsRoomFor(), false, 'sans argument : emptySlots indéfini → rien à faire');
});

// ─── craftItem × inventaire PLEIN (bout en bout, VRAIES recettes) ─────────────────────────────
// Bot à INVENTAIRE PAR CASES (36 cases utiles, 9..44) qui rejoue la gestion de la place de mineflayer
// (putSelectedItemRange) :
//   - ingrédients retirés des piles (une pile VIDÉE libère sa case) ;
//   - résultat fusionné dans une pile NON PLEINE du même item, sinon posé dans la 1re case vide,
//     sinon JETÉ au sol (« no room => drop it ») — et le craft « réussit » quand même ;
//   - `tossStack(item)` jette la pile visée (`toss(type, null, count)` en variante, `useToss`).
function slotBot(stacks, { table = null, useToss = false, emptyCount = true } = {}) {
  const slots = new Array(46).fill(null);
  const useful = () => slots.slice(9, 45);
  stacks.forEach(([name, count], i) => {
    const def = registry.itemsByName[name];
    slots[9 + i] = { name, type: def.id, count, stackSize: def.stackSize, slot: 9 + i };
  });
  const dropped = [];
  const tossed = [];
  const bot = {
    registry, slots, dropped, tossed,
    inventory: {
      slots,
      items: () => useful().filter(Boolean),
      count: (id) => useful().reduce((n, s) => n + (s && s.type === id ? s.count : 0), 0),
    },
    findBlock: () => table,
    // copies fidèles de mineflayer/lib/plugins/craft.js (comme craftBot)
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
      if (recipe.requiresTable && !craftingTable) throw new Error('Recipe requires craftingTable');
      for (let i = 0; i < (count == null ? 1 : count); i++) {
        for (const d of recipe.delta) {
          if (d.count >= 0) continue;
          let need = -d.count;
          for (let s = 9; s < 45 && need > 0; s++) {
            const it = slots[s];
            if (!it || it.type !== d.id) continue;
            const take = Math.min(it.count, need);
            it.count -= take; need -= take;
            if (it.count === 0) slots[s] = null;               // pile vidée → case libérée
          }
          if (need > 0) throw new Error('missing ingredient');
        }
        const rid = recipe.result.id;
        const def = registry.items[rid];
        let left = recipe.result.count;
        for (let s = 9; s < 45 && left > 0; s++) {              // 1. pile NON PLEINE du même item
          const it = slots[s];
          if (it && it.type === rid && it.count < def.stackSize) {
            const put = Math.min(def.stackSize - it.count, left);
            it.count += put; left -= put;
          }
        }
        while (left > 0) {
          const s = slots.findIndex((x, idx) => idx >= 9 && idx < 45 && x === null);   // 2. 1re case vide
          if (s === -1) { dropped.push({ name: def.name, count: left }); break; }       // 3. JETÉ au sol
          const put = Math.min(def.stackSize, left);
          slots[s] = { name: def.name, type: rid, count: put, stackSize: def.stackSize, slot: s };
          left -= put;
        }
      }
    },
  };
  if (emptyCount) bot.inventory.emptySlotCount = () => useful().filter((s) => s === null).length;
  if (useToss) {
    bot.toss = async (type, meta, count) => {                   // prélève dans la 1re pile du type
      tossed.push({ type, meta, count });
      for (let s = 9; s < 45; s++) if (slots[s] && slots[s].type === type) { slots[s] = null; return; }
    };
  } else {
    bot.tossStack = async (item) => { tossed.push(item.name); slots[item.slot] = null; };
  }
  return bot;
}
// Complète à 36 piles avec de la nourriture (JAMAIS jetable) : inventaire PLEIN.
const fullInv = (stacks) => stacks.concat(new Array(36 - stacks.length).fill(['cooked_beef', 64]));
const countOf = (bot, name) => bot.inventory.count(registry.itemsByName[name].id);

test('inventaire PLEIN + terre : la terre est jetée, PUIS le craft a lieu → {ok:true, freed:"dirt"}', async () => {
  const bot = slotBot(fullInv([['oak_log', 8], ['dirt', 40]]));
  assert.strictEqual(bot.inventory.emptySlotCount(), 0, 'inventaire bien plein au départ');
  const sleep = fakeSleep();
  const r = await craftItem(bot, { name: 'oak_planks', count: 1, _sleep: sleep });
  assert.deepStrictEqual(r, { ok: true, freed: 'dirt' });
  assert.deepStrictEqual(bot.tossed, ['dirt']);
  assert.strictEqual(countOf(bot, 'oak_planks'), 4, 'les planches sont EN POCHE');
  assert.strictEqual(countOf(bot, 'dirt'), 0);
  assert.strictEqual(countOf(bot, 'oak_log'), 7, 'une seule bûche consommée');
  assert.deepStrictEqual(bot.dropped, [], 'plus rien jeté au sol');
  assert.deepStrictEqual(sleep.log, [], 'effet vu dès la 1re lecture');
});

test('TÉMOIN : le MÊME inventaire plein sans déchet → rien jeté, le résultat part au sol, craft_no_effect (sans champ freed)', async () => {
  const bot = slotBot(fullInv([['oak_log', 8]]));
  const sleep = fakeSleep();
  const r = await craftItem(bot, { name: 'oak_planks', count: 1, _sleep: sleep });
  assert.deepStrictEqual(r, { ok: false, reason: 'craft_no_effect' });
  assert.deepStrictEqual(bot.tossed, [], 'aucun déchet : on ne jette ni la nourriture ni les bûches');
  assert.deepStrictEqual(bot.dropped, [{ name: 'oak_planks', count: 4 }], 'le mécanisme mineflayer : le produit est par terre');
  assert.strictEqual(countOf(bot, 'oak_log'), 7);
  assert.deepStrictEqual(sleep.log, new Array(12).fill(50));
});

test('des cases LIBRES : rien n\'est jeté, résultat exact {ok:true} (pas de champ freed)', async () => {
  const bot = slotBot([['oak_log', 8], ['dirt', 40], ['cooked_beef', 64]]);          // 33 cases libres
  const r = await craftItem(bot, { name: 'oak_planks', count: 1, _sleep: fakeSleep() });
  assert.deepStrictEqual(r, { ok: true });
  assert.deepStrictEqual(bot.tossed, []);
  assert.strictEqual(countOf(bot, 'dirt'), 40);
  assert.strictEqual(countOf(bot, 'oak_planks'), 4);
});

test('UNE seule case libre suffit : rien n\'est jeté', async () => {
  const stacks = fullInv([['oak_log', 8], ['dirt', 40]]);
  stacks.pop();                                                                         // 35 piles → 1 case libre
  const bot = slotBot(stacks);
  assert.strictEqual(bot.inventory.emptySlotCount(), 1);
  assert.deepStrictEqual(await craftItem(bot, { name: 'oak_planks', count: 1, _sleep: fakeSleep() }), { ok: true });
  assert.deepStrictEqual(bot.tossed, []);
});

test('plein MAIS une pile du produit a la place du rendement : rien n\'est jeté (mineflayer complète la pile)', async () => {
  const bot = slotBot(fullInv([['oak_log', 8], ['oak_planks', 10], ['dirt', 40]]));
  const r = await craftItem(bot, { name: 'oak_planks', count: 1, _sleep: fakeSleep() });
  assert.deepStrictEqual(r, { ok: true });
  assert.deepStrictEqual(bot.tossed, []);
  assert.strictEqual(countOf(bot, 'oak_planks'), 14);
  assert.deepStrictEqual(bot.dropped, []);
});

test('plein ET la pile du produit n\'a PAS la place du rendement (62/64 pour 4) : une pile de déchet part', async () => {
  const bot = slotBot(fullInv([['oak_log', 8], ['oak_planks', 62], ['dirt', 40]]));
  const r = await craftItem(bot, { name: 'oak_planks', count: 1, _sleep: fakeSleep() });
  assert.deepStrictEqual(r, { ok: true, freed: 'dirt' });
  assert.strictEqual(countOf(bot, 'oak_planks'), 66, '2 complètent la pile, 2 vont dans la case libérée');
  assert.deepStrictEqual(bot.dropped, []);
});

test('le rendement compte : count × résultat de la recette (3 crafts de planches = 12 planches à loger)', async () => {
  // 56/64 : la place (8) suffit pour UN craft (4 planches) mais pas pour TROIS (12) → il faut de la place.
  const three = slotBot(fullInv([['oak_log', 8], ['oak_planks', 56], ['gravel', 20]]));
  assert.deepStrictEqual(await craftItem(three, { name: 'oak_planks', count: 3, _sleep: fakeSleep() }),
    { ok: true, freed: 'gravel' });
  assert.strictEqual(countOf(three, 'oak_planks'), 68, '56 + 12');
  assert.deepStrictEqual(three.dropped, [], 'rien n\'est jeté au sol : la case libérée a reçu le surplus');
  // Témoin : le MÊME inventaire pour un seul craft (4 planches) n'a besoin de rien.
  const one = slotBot(fullInv([['oak_log', 8], ['oak_planks', 56], ['gravel', 20]]));
  assert.deepStrictEqual(await craftItem(one, { name: 'oak_planks', count: 1, _sleep: fakeSleep() }), { ok: true });
  assert.deepStrictEqual(one.tossed, []);
});

test('priorité à l\'œuvre : la terre part avant le gravier, même plus grosse', async () => {
  const bot = slotBot(fullInv([['oak_log', 8], ['gravel', 10], ['dirt', 50], ['netherrack', 5]]));
  const r = await craftItem(bot, { name: 'oak_planks', count: 1, _sleep: fakeSleep() });
  assert.deepStrictEqual(r, { ok: true, freed: 'dirt' });
  assert.deepStrictEqual(bot.tossed, ['dirt'], 'UNE seule pile, la plus anodine');
  assert.strictEqual(countOf(bot, 'gravel'), 10);
  assert.strictEqual(countOf(bot, 'netherrack'), 5);
});

test('le cobble SOUS 32 n\'est jamais jeté, même avec l\'inventaire plein (craft_no_effect, rien de perdu)', async () => {
  for (const cobble of [[['cobblestone', 32]], [['cobblestone', 20], ['cobblestone', 12]], [['cobbled_deepslate', 30]]]) {
    const bot = slotBot(fullInv([['oak_log', 8]].concat(cobble)));
    const r = await craftItem(bot, { name: 'oak_planks', count: 1, _sleep: fakeSleep() });
    assert.deepStrictEqual(r, { ok: false, reason: 'craft_no_effect' }, JSON.stringify(cobble));
    assert.deepStrictEqual(bot.tossed, [], JSON.stringify(cobble));
  }
});

test('le cobble AU-DELÀ de 32 part (la plus petite pile) et la réserve de 32 reste', async () => {
  const bot = slotBot(fullInv([['oak_log', 8], ['cobblestone', 64], ['cobblestone', 40]]));
  const r = await craftItem(bot, { name: 'oak_planks', count: 1, _sleep: fakeSleep() });
  assert.deepStrictEqual(r, { ok: true, freed: 'cobblestone' });
  assert.strictEqual(countOf(bot, 'cobblestone'), 64, 'la pile de 40 est partie, 64 restent (≥ 32)');
});

test('un INGRÉDIENT part seulement AU-DELÀ de réserve + besoin : le four (8 cobble) garde de quoi se faire', async () => {
  const table = { position: { x: 0, y: 0, z: 0 } };
  // 128 cobble : une pile de 64 part, il en reste 64 ≥ 32 + 8 → le four se fait.
  const bot = slotBot(fullInv([['cobblestone', 64], ['cobblestone', 64]]), { table });
  const r = await craftItem(bot, { name: 'furnace', count: 1, _sleep: fakeSleep() });
  assert.deepStrictEqual(r, { ok: true, freed: 'cobblestone' });
  assert.strictEqual(countOf(bot, 'furnace'), 1);
  assert.strictEqual(countOf(bot, 'cobblestone'), 56);
  // 32 + 8 = 40 : jeter la pile de 8 laisserait 32 < 32 + 8 → intouchable, le contrôle d'effet tranche.
  const tight = slotBot(fullInv([['cobblestone', 32], ['cobblestone', 8]]), { table });
  assert.deepStrictEqual(await craftItem(tight, { name: 'furnace', count: 1, _sleep: fakeSleep() }), { ok: false, reason: 'craft_no_effect' });
  assert.deepStrictEqual(tight.tossed, []);
  // …et s'il y a de la terre, c'est elle qui libère la case (palier le plus anodin).
  const bot2 = slotBot(fullInv([['cobblestone', 64], ['cobblestone', 64], ['dirt', 3]]), { table });
  assert.deepStrictEqual(await craftItem(bot2, { name: 'furnace', count: 1, _sleep: fakeSleep() }), { ok: true, freed: 'dirt' });
  assert.strictEqual(countOf(bot2, 'furnace'), 1);
});

// RÉGRESSION LIVE (23/10, NethBot1 session 408) : 55 min bloqué. Poche PLEINE, 587 cobble en 10 piles,
// seul déchet en poche ; `stone_pickaxe` → craft_no_effect ×N (mineflayer jetait la pioche au sol)
// parce que le cobble, ingrédient, était exclu EN BLOC du tri.
test('LIVE NethBot1 : poche pleine de cobble → une pile de cobble part et la pioche pierre ARRIVE en poche', async () => {
  const table = { position: { x: 0, y: 0, z: 0 } };
  const cobble = new Array(9).fill(['cobblestone', 64]).concat([['cobblestone', 11]]);
  const stacks = cobble.concat([['stick', 3], ['oak_log', 5], ['iron_ingot', 5], ['oak_planks', 9], ['crafting_table', 1]]);
  const bot = slotBot(fullInv(stacks), { table });
  assert.strictEqual(bot.inventory.emptySlotCount(), 0);
  const r = await craftItem(bot, { name: 'stone_pickaxe', count: 1, _sleep: fakeSleep() });
  assert.deepStrictEqual(r, { ok: true, freed: 'cobblestone' });
  assert.strictEqual(countOf(bot, 'stone_pickaxe'), 1, 'la pioche est EN POCHE');
  assert.deepStrictEqual(bot.dropped, [], 'rien au sol');
  assert.strictEqual(countOf(bot, 'cobblestone'), 587 - 11 - 3, 'la plus petite pile (11) part, 3 consommés');
});

test('slotsNeededFor : produit + résidus, piles non pleines complétées d\'abord', () => {
  const { slotsNeededFor } = require('./craft');
  assert.strictEqual(slotsNeededFor({ items: [], outputs: [{ name: 'stone_pickaxe', count: 1, stackSize: 1 }] }), 1);
  assert.strictEqual(slotsNeededFor({ items: [], outputs: [{ name: 'stone_pickaxe', count: 2, stackSize: 1 }] }), 2);
  assert.strictEqual(slotsNeededFor({ items: [{ name: 'oak_planks', count: 60, stackSize: 64 }], outputs: [{ name: 'oak_planks', count: 4 }] }), 0);
  assert.strictEqual(slotsNeededFor({ items: [], outputs: [{ name: 'cake', count: 1, stackSize: 1 }, { name: 'bucket', count: 3, stackSize: 16 }] }), 2,
    'gâteau + 3 seaux rendus = 2 cases');
  assert.strictEqual(slotsNeededFor(), 0);
});

test('conversion de bûches en planches ET craft du bouclier : la terre libère la case des planches, freed remonte', async () => {
  // 0 planche, 64 bûches, 1 lingot, inventaire PLEIN : la conversion (récursion de craftItem) a besoin
  // d'une case pour les 8 planches ; le bouclier, lui, se loge dans la case que le lingot libère.
  const table = { position: { x: 0, y: 0, z: 0 } };
  const bot = slotBot(fullInv([['iron_ingot', 1], ['oak_log', 64], ['dirt', 40]]), { table });
  const r = await craftItem(bot, { name: 'shield', _sleep: fakeSleep() });
  assert.deepStrictEqual(r, { ok: true, freed: 'dirt' });
  assert.deepStrictEqual(bot.tossed, ['dirt'], 'une seule pile jetée pour tout le cycle');
  assert.strictEqual(countOf(bot, 'shield'), 1);
  assert.strictEqual(countOf(bot, 'oak_planks'), 2, '8 planches, 6 consommées');
  assert.deepStrictEqual(bot.dropped, []);
});

test('freed accompagne AUSSI un échec survenu après le jet (craft_failed, craft_no_effect)', async () => {
  const lost = slotBot(fullInv([['oak_log', 8], ['dirt', 40]]));
  lost.craft = async () => { throw new Error('missing ingredient'); };
  assert.deepStrictEqual(await craftItem(lost, { name: 'oak_planks', _sleep: fakeSleep() }),
    { ok: false, reason: 'craft_failed', err: 'missing ingredient', freed: 'dirt' });
  const ghost = slotBot(fullInv([['oak_log', 8], ['dirt', 40]]));
  ghost.craft = async () => {};                                       // le serveur ignore le craft
  assert.deepStrictEqual(await craftItem(ghost, { name: 'oak_planks', _sleep: fakeSleep() }),
    { ok: false, reason: 'craft_no_effect', freed: 'dirt' });
});

test('plusieurs piles jetées dans un même cycle : noms séparés par une virgule', async () => {
  // Deux crafts imbriqués qui ont chacun besoin d'une case : conversion de bûches (terre) puis bouclier
  // (gravier). Le lingot, pile de 1, libérerait la case du bouclier à lui seul — mais le calcul est
  // PESSIMISTE à dessein (il ne devine pas quelles piles la recette videra) : le gravier part quand même.
  const table = { position: { x: 0, y: 0, z: 0 } };
  const bot = slotBot(fullInv([['iron_ingot', 1], ['oak_log', 64], ['dirt', 40], ['gravel', 20]]), { table });
  const r = await craftItem(bot, { name: 'shield', _sleep: fakeSleep() });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.freed, 'dirt,gravel');
  assert.deepStrictEqual(bot.tossed, ['dirt', 'gravel']);
});

test('jet IMPOSSIBLE (tossStack lève) : pas de freed, pas de crash, le contrôle d\'effet tranche', async () => {
  const bot = slotBot(fullInv([['oak_log', 8], ['dirt', 40]]));
  bot.tossStack = async () => { throw new Error('boom'); };
  const r = await craftItem(bot, { name: 'oak_planks', count: 1, _sleep: fakeSleep() });
  assert.deepStrictEqual(r, { ok: false, reason: 'craft_no_effect' });
  assert.strictEqual(countOf(bot, 'dirt'), 40, 'la terre est toujours là');
});

test('sans tossStack : repli sur toss(type, null, count)', async () => {
  const bot = slotBot(fullInv([['oak_log', 8], ['dirt', 40]]), { useToss: true });
  const r = await craftItem(bot, { name: 'oak_planks', count: 1, _sleep: fakeSleep() });
  assert.deepStrictEqual(r, { ok: true, freed: 'dirt' });
  assert.deepStrictEqual(bot.tossed, [{ type: registry.itemsByName.dirt.id, meta: null, count: 40 }]);
});

test('sans emptySlotCount : repli sur le comptage des cases 9..44 vides', async () => {
  const full = slotBot(fullInv([['oak_log', 8], ['dirt', 40]]), { emptyCount: false });
  assert.strictEqual(typeof full.inventory.emptySlotCount, 'undefined');
  assert.deepStrictEqual(await craftItem(full, { name: 'oak_planks', _sleep: fakeSleep() }), { ok: true, freed: 'dirt' });
  // …et avec de la place, le repli ne jette toujours rien (les cases 0..8 et 45 ne comptent pas).
  const roomy = slotBot([['oak_log', 8], ['dirt', 40]], { emptyCount: false });
  assert.deepStrictEqual(await craftItem(roomy, { name: 'oak_planks', _sleep: fakeSleep() }), { ok: true });
  assert.deepStrictEqual(roomy.tossed, []);
});

test('aucune information sur les cases (vieux stub : ni emptySlotCount ni slots) : jamais de jet', async () => {
  const bot = craftBot({ oak_log: 4, dirt: 64 }, { table: null });
  bot.tossStack = async () => { throw new Error('ne doit pas être appelé'); };
  bot.toss = async () => { throw new Error('ne doit pas être appelé'); };
  assert.deepStrictEqual(await craftItem(bot, { name: 'oak_planks', count: 1, _sleep: fakeSleep() }), { ok: true });
  // Un emptySlotCount qui ne rend pas un nombre vaut « inconnu » : toujours rien jeté.
  for (const bad of [() => undefined, () => NaN, () => { throw new Error('boom'); }]) {
    const b = craftBot({ oak_log: 4, dirt: 64 }, { table: null });
    b.inventory.emptySlotCount = bad;
    b.tossStack = async () => { throw new Error('ne doit pas être appelé'); };
    assert.deepStrictEqual(await craftItem(b, { name: 'oak_planks', count: 1, _sleep: fakeSleep() }), { ok: true });
  }
});

// La terre grossière est une VRAIE recette (2 terre + 2 gravier → 4 terre grossière) dont le produit
// ET les ingrédients sont tous des déchets de la liste blanche : ni l'un ni l'autre ne doit partir
// pour faire de la place à… eux-mêmes. Seul un déchet étranger à la recette (le tuf) est jetable.
test('le PRODUIT et les INGRÉDIENTS de la recette ne sont jamais jetés, même quand ce sont des déchets', async () => {
  const withTuff = slotBot(fullInv([['dirt', 40], ['gravel', 20], ['tuff', 7]]));
  const r = await craftItem(withTuff, { name: 'coarse_dirt', count: 1, _sleep: fakeSleep() });
  assert.deepStrictEqual(r, { ok: true, freed: 'tuff' });
  assert.deepStrictEqual(withTuff.tossed, ['tuff'], 'ni la terre (ingrédient) ni le gravier (ingrédient) malgré leur priorité');
  assert.strictEqual(countOf(withTuff, 'coarse_dirt'), 4);
  assert.strictEqual(countOf(withTuff, 'dirt'), 38);
  const noOther = slotBot(fullInv([['dirt', 40], ['gravel', 20]]));
  assert.deepStrictEqual(await craftItem(noOther, { name: 'coarse_dirt', count: 1, _sleep: fakeSleep() }),
    { ok: false, reason: 'craft_no_effect' });
  assert.deepStrictEqual(noOther.tossed, []);
  // Le PRODUIT lui-même — ici une pile pleine de terre grossière, sans place pour 4 de plus — n'est
  // pas non plus un candidat : on ne jette pas ce qu'on est en train de fabriquer.
  const fullProduct = slotBot(fullInv([['dirt', 40], ['gravel', 20], ['coarse_dirt', 64]]));
  assert.deepStrictEqual(await craftItem(fullProduct, { name: 'coarse_dirt', count: 1, _sleep: fakeSleep() }),
    { ok: false, reason: 'craft_no_effect' });
  assert.deepStrictEqual(fullProduct.tossed, []);
  assert.strictEqual(countOf(fullProduct, 'coarse_dirt'), 64);
});
