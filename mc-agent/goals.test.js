'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { invCount, buildCtxInv, MVP_CHAIN, IRON_CHAIN, DIAMOND_CHAIN, chainFor, firstUnmet } = require('./goals');

// Faux bot : inventaire = liste d'items {name, count}
function fakeBot(items) {
  return { inventory: { items: () => items.map((i) => ({ name: i[0], count: i[1] })) } };
}

test('invCount somme les piles du meme item', () => {
  const bot = fakeBot([['oak_planks', 4], ['oak_planks', 3], ['stick', 2]]);
  const inv = buildCtxInv(bot);
  assert.strictEqual(invCount(inv, 'oak_planks'), 7);
  assert.strictEqual(invCount(inv, 'stick'), 2);
  assert.strictEqual(invCount(inv, 'cobblestone'), 0);
});

test('firstUnmet renvoie le 1er but non satisfait dans l\'ordre', () => {
  // inventaire vide -> 1er but = recolter du bois
  let ctx = { inv: {}, hasTable: false };
  assert.strictEqual(firstUnmet(MVP_CHAIN, ctx).name, 'logs');

  // a deja 3 logs -> but suivant = planks
  ctx = { inv: { oak_log: 3 }, hasTable: false };
  assert.strictEqual(firstUnmet(MVP_CHAIN, ctx).name, 'planks');

  // objectif atteint (a une pioche pierre) -> firstUnmet = null
  ctx = { inv: { stone_pickaxe: 1 }, hasTable: true };
  assert.strictEqual(firstUnmet(MVP_CHAIN, ctx), null);
});

test('la chaine MVP ne contient plus de but place_table', () => {
  assert.ok(!MVP_CHAIN.some((g) => g.name === 'place_table'));
});

test('ordre exact de la chaine MVP (7 buts)', () => {
  assert.deepStrictEqual(
    MVP_CHAIN.map((g) => g.name),
    ['logs', 'planks', 'crafting_table', 'sticks', 'wooden_pickaxe', 'cobblestone', 'stone_pickaxe'],
  );
});

test('a une table en inventaire (pas posee) -> but suivant = sticks', () => {
  // crafting_table dans l\'inv suffit (portable) ; hasTable est ignore
  const ctx = { inv: { oak_planks: 12, crafting_table: 1 }, hasTable: false };
  assert.strictEqual(firstUnmet(MVP_CHAIN, ctx).name, 'sticks');
});

test('a table + planks + sticks -> but suivant = wooden_pickaxe', () => {
  const ctx = { inv: { crafting_table: 1, oak_planks: 6, stick: 4 }, hasTable: false };
  assert.strictEqual(firstUnmet(MVP_CHAIN, ctx).name, 'wooden_pickaxe');
});

// --- Chaîne FER ---

test('chainFor selectionne MVP (pierre) ou IRON selon l\'objectif', () => {
  assert.strictEqual(chainFor('iron_pickaxe'), IRON_CHAIN);
  assert.strictEqual(chainFor('stone_pickaxe'), MVP_CHAIN);
  assert.strictEqual(chainFor(undefined), MVP_CHAIN);  // défaut
});

test('ordre exact de la chaine FER (12 buts, cobble scindé pick/four)', () => {
  assert.deepStrictEqual(
    IRON_CHAIN.map((g) => g.name),
    ['logs', 'planks', 'crafting_table', 'sticks', 'wooden_pickaxe',
     'cobble_pick', 'stone_pickaxe', 'cobble_furnace', 'furnace',
     'iron_ore', 'iron_ingot', 'iron_pickaxe'],
  );
});

test('IRON firstUnmet : vide -> logs ; pioche fer -> null (tout fait)', () => {
  assert.strictEqual(firstUnmet(IRON_CHAIN, { inv: {} }).name, 'logs');
  assert.strictEqual(firstUnmet(IRON_CHAIN, { inv: { iron_pickaxe: 1 } }), null);
});

test('IRON firstUnmet : a four + 3 raw_iron (pioches+sticks) -> iron_ingot (smelt)', () => {
  // état réaliste mi-chaîne : pioches bois+pierre, four en poche, sticks restants, minerai miné
  const ctx = { inv: { wooden_pickaxe: 1, stone_pickaxe: 1, furnace: 1, stick: 4, raw_iron: 3 } };
  assert.strictEqual(firstUnmet(IRON_CHAIN, ctx).name, 'iron_ingot');
});

test('IRON firstUnmet : lingots fondus -> iron_pickaxe (dernier but)', () => {
  const ctx = { inv: { wooden_pickaxe: 1, stone_pickaxe: 1, furnace: 1, stick: 4, iron_ingot: 3 } };
  assert.strictEqual(firstUnmet(IRON_CHAIN, ctx).name, 'iron_pickaxe');
});

test('IRON cobble scindé : 3 cobble + pioche pierre -> cobble_furnace (pas re-pick)', () => {
  // après la pioche pierre (S), cobble_pick est gaté par S ; il reste à gather les 8 du four
  const ctx = { inv: { wooden_pickaxe: 1, stone_pickaxe: 1, stick: 4 } };
  assert.strictEqual(firstUnmet(IRON_CHAIN, ctx).name, 'cobble_furnace');
});

// --- Chaîne DIAMANT ---

test('chainFor("diamond") selectionne DIAMOND_CHAIN', () => {
  assert.strictEqual(chainFor('diamond'), DIAMOND_CHAIN);
});

test('DIAMOND_CHAIN contient les 12 buts IRON + 3 buts diamant en queue', () => {
  const names = DIAMOND_CHAIN.map((g) => g.name);
  assert.deepStrictEqual(
    names,
    ['logs', 'planks', 'crafting_table', 'sticks', 'wooden_pickaxe',
     'cobble_pick', 'stone_pickaxe', 'cobble_furnace', 'furnace',
     'iron_ore', 'iron_ingot', 'iron_pickaxe',
     'cobble_buffer', 'descend_y54', 'branch_mine'],
  );
});

test('DIAMOND firstUnmet : inventaire vide -> logs (1er but)', () => {
  assert.strictEqual(firstUnmet(DIAMOND_CHAIN, { inv: {} }).name, 'logs');
});

test('DIAMOND firstUnmet : pioche fer obtenue -> cobble_buffer (16 cobble pour murage)', () => {
  const ctx = { inv: { iron_pickaxe: 1, stick: 4 }, y: 64 };
  assert.strictEqual(firstUnmet(DIAMOND_CHAIN, ctx).name, 'cobble_buffer');
});

test('DIAMOND firstUnmet : pioche fer + 16 cobble + Y=64 -> descend_y54', () => {
  const ctx = { inv: { iron_pickaxe: 1, cobblestone: 16, stick: 4 }, y: 64 };
  assert.strictEqual(firstUnmet(DIAMOND_CHAIN, ctx).name, 'descend_y54');
});

test('DIAMOND firstUnmet : Y atteint -54, pioche fer, cobble -> branch_mine', () => {
  const ctx = { inv: { iron_pickaxe: 1, cobblestone: 16, stick: 4 }, y: -54 };
  assert.strictEqual(firstUnmet(DIAMOND_CHAIN, ctx).name, 'branch_mine');
});

test('DIAMOND firstUnmet : diamant obtenu -> null (objectif atteint)', () => {
  // ⚠️ monotonie : tout l'amont doit redevenir "satisfait" via le gating |D
  const ctx = { inv: { diamond: 1 }, y: -54 };
  assert.strictEqual(firstUnmet(DIAMOND_CHAIN, ctx), null);
});

test('DIAMOND monotonie : diamond:1 satisfait TOUS les buts amont (même si ressources consommées)', () => {
  // Cas réaliste : on a miné un diamant, les cobble/iron/sticks/planks/logs ont été consommés.
  // Aucun but ne doit redevenir "non satisfait" → firstUnmet = null.
  const ctx = { inv: { diamond: 1 }, y: -54 };
  for (const goal of DIAMOND_CHAIN) {
    assert.ok(goal.met(ctx), `but "${goal.name}" devrait etre satisfait quand diamond:1`);
  }
});

test('DIAMOND descend_y54 : met=false si y=64, true si y<=-52, true si diamond:1', () => {
  const goal = DIAMOND_CHAIN.find((g) => g.name === 'descend_y54');
  assert.strictEqual(goal.met({ inv: {}, y: 64 }), false);
  assert.strictEqual(goal.met({ inv: {}, y: -52 }), true);
  assert.strictEqual(goal.met({ inv: {}, y: -54 }), true);
  assert.strictEqual(goal.met({ inv: { diamond: 1 }, y: 64 }), true);
});

test('DIAMOND cobble_buffer : met=true si cobble>=16 OU diamond:1', () => {
  const goal = DIAMOND_CHAIN.find((g) => g.name === 'cobble_buffer');
  assert.strictEqual(goal.met({ inv: { cobblestone: 15 } }), false);
  assert.strictEqual(goal.met({ inv: { cobblestone: 16 } }), true);
  assert.strictEqual(goal.met({ inv: { diamond: 1 } }), true);
});

test('DIAMOND : le but iron_pickaxe N\'est PLUS le dernier (le diamant l\'est)', () => {
  const names = DIAMOND_CHAIN.map((g) => g.name);
  assert.notStrictEqual(names[names.length - 1], 'iron_pickaxe');
  assert.strictEqual(names[names.length - 1], 'branch_mine');
});

// --- Chaîne MAPPER_KIT (cartographe : pierre épée+pioche obligatoire) ---

const { MAPPER_KIT } = require('./goals');

test('chainFor(mapper) renvoie MAPPER_KIT', () => {
  assert.strictEqual(chainFor('mapper'), MAPPER_KIT);
});

test('MAPPER_KIT ordre exact (9 buts, cobble scindé pick/sword)', () => {
  assert.deepStrictEqual(
    MAPPER_KIT.map((g) => g.name),
    ['logs', 'planks', 'crafting_table', 'sticks', 'wooden_pickaxe',
     'cobble_pick', 'stone_pickaxe', 'cobble_sword', 'stone_sword'],
  );
});

test('MAPPER_KIT : inventaire vide -> 1er but = logs', () => {
  assert.strictEqual(firstUnmet(MAPPER_KIT, { inv: {} }).name, 'logs');
});

test('MAPPER_KIT : pioche pierre obtenue -> but suivant = cobble_sword', () => {
  // cobble consommé par la pioche (3) -> il en reste 2 -> cobble_sword met (>=2)
  const ctx = { inv: { stone_pickaxe: 1, stick: 4, cobblestone: 2, crafting_table: 1 } };
  assert.strictEqual(firstUnmet(MAPPER_KIT, ctx).name, 'stone_sword');
  // cobble épuisé -> re-gather 2
  const ctx2 = { inv: { stone_pickaxe: 1, stick: 4, crafting_table: 1 } };
  assert.strictEqual(firstUnmet(MAPPER_KIT, ctx2).name, 'cobble_sword');
});

test('MAPPER_KIT monotonie : kit complet (pioche+épée pierre) satisfait TOUT (ressources consommées)', () => {
  const ctx = { inv: { stone_pickaxe: 1, stone_sword: 1 } };
  for (const goal of MAPPER_KIT) {
    assert.ok(goal.met(ctx), `but "${goal.name}" devrait etre satisfait avec le kit complet`);
  }
  assert.strictEqual(firstUnmet(MAPPER_KIT, ctx), null);
});

test('MAPPER_KIT monotonie : pioche pierre seule satisfait tout l\'amont bois/table', () => {
  const ctx = { inv: { stone_pickaxe: 1 } };
  for (const name of ['logs', 'planks', 'crafting_table', 'wooden_pickaxe', 'cobble_pick', 'stone_pickaxe']) {
    const goal = MAPPER_KIT.find((g) => g.name === name);
    assert.ok(goal.met(ctx), `but "${name}" devrait etre satisfait avec stone_pickaxe`);
  }
});

test('MAPPER_KIT sticks : 4 requis (2 pioche bois + 2 pioche pierre + 1 épée, crafts en 2 lots)', () => {
  const goal = MAPPER_KIT.find((g) => g.name === 'sticks');
  assert.strictEqual(goal.met({ inv: { stick: 3 } }), false);
  assert.strictEqual(goal.met({ inv: { stick: 4 } }), true);
  assert.strictEqual(goal.met({ inv: { stone_pickaxe: 1, stone_sword: 1 } }), true); // kit final
  assert.deepStrictEqual(goal.args, { name: 'stick', count: 2 });
});
