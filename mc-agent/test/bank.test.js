'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { planBank, BANK_DELIVERABLES } = require('../bank');

const TARGET = { diamond: 64, gold: 64, redstone: 64, lapis: 64, iron: 64 };

function inv(map) {
  return Object.entries(map).map(([name, count]) => ({ name, count }));
}

test('planBank: rien à banker quand on porte peu de minerai livrable', () => {
  // 2 diamants < diamondThreshold(3) ET < threshold(6) → pas de bank
  const r = planBank(inv({ diamond: 2, cobblestone: 40 }), TARGET);
  assert.strictEqual(r.shouldBank, false);
  assert.deepStrictEqual(r.deposit, []);
});

test('planBank: déclenche quand le porté livrable atteint le seuil', () => {
  const r = planBank(inv({ diamond: 30 }), TARGET, { threshold: 24 });
  assert.strictEqual(r.shouldBank, true);
  assert.deepStrictEqual(r.deposit, [{ name: 'diamond', count: 30 }]);
});

test('planBank: ne banke JAMAIS outils/armure/bouffe/junk', () => {
  const r = planBank(inv({
    diamond: 30, diamond_pickaxe: 1, diamond_chestplate: 1, cooked_beef: 8,
    cobblestone: 64, dirt: 32, torch: 5, crafting_table: 1, furnace: 1, stick: 10,
  }), TARGET, { threshold: 24 });
  assert.strictEqual(r.shouldBank, true);
  assert.deepStrictEqual(r.deposit, [{ name: 'diamond', count: 30 }]);
});

test('planBank: ne banke PAS le brut (raw_iron/raw_gold) — il sera fondu en lingots', () => {
  // 30 diamants déclenchent ; raw_iron/raw_gold restent en poche (fonte → lingot = livrable).
  const r = planBank(inv({ diamond: 30, raw_iron: 40, raw_gold: 20 }), TARGET, { threshold: 24 });
  assert.strictEqual(r.shouldBank, true);
  const names = r.deposit.map((d) => d.name);
  assert.ok(!names.includes('raw_iron'));
  assert.ok(!names.includes('raw_gold'));
  assert.ok(names.includes('diamond'));
});

test('planBank: banke les LINGOTS (gold_ingot/iron_ingot) — déjà fondus = livrables', () => {
  const r = planBank(inv({ gold_ingot: 40, iron_ingot: 40 }), TARGET, { threshold: 24, keepIngot: 8 });
  assert.strictEqual(r.shouldBank, true);
  const dep = Object.fromEntries(r.deposit.map((d) => [d.name, d.count]));
  // garde une réserve de lingots de fer pour craft armure ; or n'est pas un matériau de craft → tout banké
  assert.strictEqual(dep.iron_ingot, 32); // 40 - keepIngot(8)
  assert.strictEqual(dep.gold_ingot, 40);
});

test('planBank: redstone et lapis sont livrables et bankés intégralement', () => {
  const r = planBank(inv({ redstone: 40, lapis_lazuli: 30 }), TARGET, { threshold: 24 });
  assert.strictEqual(r.shouldBank, true);
  const dep = Object.fromEntries(r.deposit.map((d) => [d.name, d.count]));
  assert.strictEqual(dep.redstone, 40);
  assert.strictEqual(dep.lapis_lazuli, 30);
});

test('planBank: le seuil compte le TOTAL livrable porté, pas un seul type', () => {
  // 10 diamond + 10 redstone + 10 lapis = 30 ≥ 24 → banke
  const r = planBank(inv({ diamond: 10, redstone: 10, lapis_lazuli: 10 }), TARGET, { threshold: 24 });
  assert.strictEqual(r.shouldBank, true);
  assert.strictEqual(r.deposit.length, 3);
});

test('planBank: keepIngot ne laisse rien à déposer en fer → pas dans la liste', () => {
  // 6 iron_ingot < keepIngot 8 → rien à banker en fer ; mais 30 diamants déclenchent quand même
  const r = planBank(inv({ diamond: 30, iron_ingot: 6 }), TARGET, { threshold: 24, keepIngot: 8 });
  const names = r.deposit.map((d) => d.name);
  assert.ok(!names.includes('iron_ingot'));
  assert.ok(names.includes('diamond'));
});

test('planBank: les DIAMANTS (rares, goulot) déclenchent à un seuil BAS dédié', () => {
  // 6 diamants seuls (< threshold général 16) déclenchent quand même : diamondThreshold=6.
  // Un bot meurt souvent avec ~7-15 diamants AVANT d'atteindre 16 livrables → on banke tôt.
  const r = planBank(inv({ diamond: 6 }), TARGET, { threshold: 16, diamondThreshold: 6 });
  assert.strictEqual(r.shouldBank, true);
  assert.deepStrictEqual(r.deposit, [{ name: 'diamond', count: 6 }]);
});

test('planBank: 4 diamants seuls (< diamondThreshold) ne déclenchent pas', () => {
  const r = planBank(inv({ diamond: 4 }), TARGET, { threshold: 16, diamondThreshold: 6 });
  assert.strictEqual(r.shouldBank, false);
});

test('planBank: redstone/lapis seuls suivent le seuil GÉNÉRAL (pas le diamant)', () => {
  // 10 redstone < threshold 16 → pas de bank (pas de diamant pour forcer)
  assert.strictEqual(planBank(inv({ redstone: 10 }), TARGET, { threshold: 16, diamondThreshold: 6 }).shouldBank, false);
  // 18 redstone ≥ 16 → bank
  assert.strictEqual(planBank(inv({ redstone: 18 }), TARGET, { threshold: 16, diamondThreshold: 6 }).shouldBank, true);
});

test('BANK_DELIVERABLES expose la liste des items livrables (pas de brut)', () => {
  assert.ok(BANK_DELIVERABLES.has('diamond'));
  assert.ok(BANK_DELIVERABLES.has('iron_ingot'));
  assert.ok(BANK_DELIVERABLES.has('gold_ingot'));
  assert.ok(!BANK_DELIVERABLES.has('raw_iron'));
  assert.ok(!BANK_DELIVERABLES.has('raw_gold'));
});
