'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const {
  ITEMS_FOR, QUOTA_TYPES, DEFAULT_QUOTA,
  countItems, normalizeQuota, createQuotaTracker, junkItems,
} = require('./quota');

// ─── countItems ───

test('countItems : compte par type logique (iron = raw_iron + iron_ingot)', () => {
  const items = [
    { name: 'diamond', count: 3 },
    { name: 'raw_gold', count: 2 },
    { name: 'redstone', count: 10 },
    { name: 'lapis_lazuli', count: 7 },
    { name: 'raw_iron', count: 4 },
    { name: 'iron_ingot', count: 5 },
    { name: 'cobblestone', count: 64 },   // hors quota → ignoré
  ];
  assert.deepStrictEqual(countItems(items), { diamond: 3, gold: 2, redstone: 10, lapis: 7, iron: 9 });
});

test('countItems : liste vide/null → tous zéro', () => {
  assert.deepStrictEqual(countItems([]), { diamond: 0, gold: 0, redstone: 0, lapis: 0, iron: 0 });
  assert.deepStrictEqual(countItems(null), { diamond: 0, gold: 0, redstone: 0, lapis: 0, iron: 0 });
});

// ─── normalizeQuota ───

test('normalizeQuota : défaut mission, filtre types inconnus + valeurs invalides', () => {
  assert.deepStrictEqual(normalizeQuota(null), DEFAULT_QUOTA);
  assert.deepStrictEqual(normalizeQuota({ diamond: 5, emerald: 99, gold: 0, lapis: -2, iron: '12' }),
    { diamond: 5, iron: 12 });
  assert.deepStrictEqual(normalizeQuota({ emerald: 99 }), DEFAULT_QUOTA); // rien de valide → défaut
});

// ─── createQuotaTracker ───

test('tracker : progress/met/remainingTypes depuis inventaire', () => {
  const t = createQuotaTracker({ diamond: 2, iron: 3 });
  const inv = [{ name: 'diamond', count: 1 }, { name: 'raw_iron', count: 3 }];
  assert.deepStrictEqual(t.progress(inv), { diamond: { have: 1, target: 2 }, iron: { have: 3, target: 3 } });
  assert.deepStrictEqual(t.remainingTypes(inv), ['diamond']);
  assert.strictEqual(t.met(inv), false);
  assert.strictEqual(t.met([{ name: 'diamond', count: 2 }, { name: 'iron_ingot', count: 3 }]), true);
});

test('tracker : noteBanked crédite la différence positive (dépôt ne fait pas perdre le compte)', () => {
  const t = createQuotaTracker({ diamond: 5 });
  const before = [{ name: 'diamond', count: 3 }];
  const after = [];                                  // tout déposé
  t.noteBanked(before, after);
  assert.deepStrictEqual(t.progress([]), { diamond: { have: 3, target: 5 } });
  // un GAIN d'inventaire (after > before) ne crédite rien
  t.noteBanked([], [{ name: 'diamond', count: 2 }]);
  assert.deepStrictEqual(t.progress([{ name: 'diamond', count: 2 }]), { diamond: { have: 5, target: 5 } });
  assert.strictEqual(t.met([{ name: 'diamond', count: 2 }]), true);
});

// ─── junkItems ───

test('junkItems : jette le junk de creusage, garde outils/bouffe/quota/1 stack cobble', () => {
  const items = [
    { name: 'deepslate', count: 64 },          // junk
    { name: 'gravel', count: 12 },             // junk
    { name: 'cobblestone', count: 64 },        // gardé (1er stack = remblai)
    { name: 'cobblestone', count: 40 },        // jeté (surplus)
    { name: 'diamond', count: 3 },             // quota
    { name: 'diamond_pickaxe', count: 1 },     // outil
    { name: 'bread', count: 5 },               // bouffe
    { name: 'crafting_table', count: 1 },      // utilitaire
    { name: 'andesite', count: 30 },           // junk
  ];
  const junk = junkItems(items);
  const names = junk.map((i) => i.name + ':' + i.count).sort();
  assert.deepStrictEqual(names, ['andesite:30', 'cobblestone:40', 'deepslate:64', 'gravel:12']);
});

test('junkItems : vide/null → []', () => {
  assert.deepStrictEqual(junkItems([]), []);
  assert.deepStrictEqual(junkItems(null), []);
});

// ─── invariants ───

test('QUOTA_TYPES et DEFAULT_QUOTA couvrent les 5 types mission', () => {
  assert.deepStrictEqual(QUOTA_TYPES.sort(), ['diamond', 'gold', 'iron', 'lapis', 'redstone']);
  assert.deepStrictEqual(DEFAULT_QUOTA, { diamond: 15, gold: 15, redstone: 64, lapis: 64, iron: 64 });
  for (const t of QUOTA_TYPES) assert.ok(ITEMS_FOR[t].length >= 1);
});
