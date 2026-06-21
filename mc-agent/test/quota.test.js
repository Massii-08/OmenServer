'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { countItems, createQuotaTracker, normalizeQuota } = require('../quota');

test('countItems: lingots comptés comme métal récolté (livraison fondue)', () => {
  const c = countItems([
    { name: 'gold_ingot', count: 10 }, { name: 'raw_gold', count: 5 },
    { name: 'iron_ingot', count: 20 }, { name: 'raw_iron', count: 4 },
    { name: 'diamond', count: 3 }, { name: 'redstone', count: 7 }, { name: 'lapis_lazuli', count: 9 },
  ]);
  assert.strictEqual(c.gold, 15);   // raw_gold + gold_ingot
  assert.strictEqual(c.iron, 24);   // raw_iron + iron_ingot
  assert.strictEqual(c.diamond, 3);
  assert.strictEqual(c.redstone, 7);
  assert.strictEqual(c.lapis, 9);
});

test('createQuotaTracker: have = banked + inventaire courant', () => {
  const t = createQuotaTracker({ diamond: 64, gold: 64, iron: 64, redstone: 64, lapis: 64 });
  const inv0 = [{ name: 'diamond', count: 30 }];
  assert.strictEqual(t.progress(inv0).diamond.have, 30);
  // on banke (dépose) les 30 diamants : avant=30, après=0
  t.noteBanked([{ name: 'diamond', count: 30 }], []);
  // inventaire vidé mais le compte tient (banked=30)
  assert.strictEqual(t.progress([]).diamond.have, 30);
  // on re-mine 40 → 30 banked + 40 portés = 70 ≥ 64
  assert.strictEqual(t.progress([{ name: 'diamond', count: 40 }]).diamond.have, 70);
});

test('createQuotaTracker: une MORT (perte inventaire) NE retombe PAS sous le banked', () => {
  const t = createQuotaTracker({ diamond: 64 });
  t.noteBanked([{ name: 'diamond', count: 50 }], []); // 50 bankés en coffre
  // mort → inventaire vide → have reste 50 (les 50 sont saufs dans le coffre)
  assert.strictEqual(t.progress([]).diamond.have, 50);
  assert.strictEqual(t.met([]), false);
});

test('met: quota atteint quand banked+inv couvre tous les types', () => {
  const t = createQuotaTracker({ diamond: 2, iron: 2 });
  t.noteBanked([{ name: 'diamond', count: 2 }, { name: 'iron_ingot', count: 2 }], []);
  assert.strictEqual(t.met([]), true);
});

test('normalizeQuota: 64×5', () => {
  assert.deepStrictEqual(normalizeQuota({ diamond: 64, gold: 64, iron: 64, redstone: 64, lapis: 64 }),
    { diamond: 64, gold: 64, redstone: 64, lapis: 64, iron: 64 });
});
