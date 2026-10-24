'use strict';
const test = require('node:test');
const assert = require('node:assert');
const DA = require('./diaArmor');

const base = (o) => Object.assign({ inv: {}, worn: [], pickCount: 1, tableOk: true }, o);

test('diamondArmorNext : ordre plastron → jambières → casque → bottes', () => {
  assert.deepStrictEqual(DA.diamondArmorNext(base({ inv: { diamond: 11 } })),
    { act: 'craft', name: 'diamond_chestplate', slot: 'torso', units: 8 });
  const w1 = ['diamond_chestplate'];
  assert.strictEqual(DA.diamondArmorNext(base({ inv: { diamond: 10 }, worn: w1 })).name, 'diamond_leggings');
  const w2 = ['diamond_chestplate', 'diamond_leggings'];
  assert.strictEqual(DA.diamondArmorNext(base({ inv: { diamond: 8 }, worn: w2 })).name, 'diamond_helmet');
  const w3 = w2.concat('diamond_helmet');
  assert.strictEqual(DA.diamondArmorNext(base({ inv: { diamond: 7 }, worn: w3 })).name, 'diamond_boots');
  assert.strictEqual(DA.diamondArmorNext(base({ inv: { diamond: 99 }, worn: w3.concat('diamond_boots') })), null);
});

test('diamondArmorNext : ordre STRICT — pas de bottes tant que le plastron est inabordable', () => {
  // 8 diamants : 8 - 3 de réserve pioche = 5 < 8 → on attend (ni casque ni bottes avant le plastron).
  assert.strictEqual(DA.diamondArmorNext(base({ inv: { diamond: 8 } })), null);
  assert.strictEqual(DA.diamondArmorNext(base({ inv: { diamond: 10 } })), null);
  assert.strictEqual(DA.diamondArmorNext(base({ inv: { diamond: 11 } })).name, 'diamond_chestplate');
});

test('diamondArmorNext : réserve pioche levée avec une pioche de rechange', () => {
  assert.strictEqual(DA.diamondArmorNext(base({ inv: { diamond: 8 }, pickCount: 2 })).name, 'diamond_chestplate');
});

test('diamondArmorNext : la pioche d abord (aucune pioche fer+ → rien), table posable requise', () => {
  assert.strictEqual(DA.diamondArmorNext(base({ inv: { diamond: 40 }, pickCount: 0 })), null);
  assert.strictEqual(DA.diamondArmorNext(base({ inv: { diamond: 40 }, tableOk: false })), null);
});

test('diamondArmorNext : remplace la pièce de FER du slot (le fer porté ne couvre pas)', () => {
  const worn = ['iron_chestplate', 'iron_leggings', 'iron_helmet', 'iron_boots'];
  assert.strictEqual(DA.diamondArmorNext(base({ inv: { diamond: 11 }, worn })).name, 'diamond_chestplate');
});

test('diamondArmorNext : pièce diamant SAINE en poche → l enfiler (gratuit, même sans pioche)', () => {
  assert.deepStrictEqual(DA.diamondArmorNext(base({ inv: { diamond_chestplate: 1 }, pickCount: 0 })),
    { act: 'equip', name: 'diamond_chestplate', slot: 'torso' });
  // pocketGood fourni et vide = la pièce de poche est USÉE → on en refait une
  assert.deepStrictEqual(DA.diamondArmorNext(base({ inv: { diamond_chestplate: 1, diamond: 11 }, pocketGood: [] })),
    { act: 'craft', name: 'diamond_chestplate', slot: 'torso', units: 8 });
});

test('diamondArmorNext : réparation — pièce diamant usée (absente de worn) refaite en diamant', () => {
  // worn exclut déjà les pièces quasi cassées (_wornArmor) : casque usé → slot non couvert.
  const worn = ['diamond_chestplate', 'diamond_leggings', 'diamond_boots'];
  assert.strictEqual(DA.diamondArmorNext(base({ inv: { diamond: 8 }, worn })).name, 'diamond_helmet');
});

test('diaWornCount / armorTier', () => {
  assert.strictEqual(DA.diaWornCount(['diamond_helmet', 'netherite_boots', 'iron_leggings']), 2);
  assert.strictEqual(DA.armorTier([]), 'nu');
  assert.strictEqual(DA.armorTier(['iron_helmet']), 'fer');
  assert.strictEqual(DA.armorTier(['iron_helmet', 'diamond_boots']), 'mixte');
  assert.strictEqual(DA.armorTier(['diamond_helmet', 'diamond_chestplate', 'diamond_leggings', 'diamond_boots']), 'diamant');
  assert.strictEqual(DA.armorTier(null), 'nu');
});

test('isIronDonor : armure diamant complète + ≥ 24 diamants + fer sain en poche', () => {
  assert.strictEqual(DA.isIronDonor({ diaWorn: 4, diamonds: 24, spareIron: 2 }), true);
  assert.strictEqual(DA.isIronDonor({ diaWorn: 4, diamonds: 23, spareIron: 2 }), false);
  assert.strictEqual(DA.isIronDonor({ diaWorn: 3, diamonds: 50, spareIron: 2 }), false);
  assert.strictEqual(DA.isIronDonor({ diaWorn: 4, diamonds: 50, spareIron: 0 }), false);
  assert.strictEqual(DA.isIronDonor({}), false);
});
