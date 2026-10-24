'use strict';
const test = require('node:test');
const assert = require('node:assert');
const G = require('./goals');

const chain = G.diamondChain(192);
const first = (ctx) => { const g = G.firstUnmet(chain, ctx); return g && g.name; };
// Mineur au fond : pioche fer, table en poche, four, y -54.
const miner = (inv, extra) => Object.assign({
  inv: Object.assign({ iron_pickaxe: 1, crafting_table: 1, furnace: 1, cobblestone: 32, stick: 4 }, inv),
  y: -54, worn: ['iron_helmet', 'iron_chestplate', 'iron_leggings', 'iron_boots'], diaPickUpgraded: true,
}, extra || {});

test('chaîne diamant : dia_pick puis dia_armor en tête', () => {
  assert.strictEqual(chain[0].name, 'dia_pick');
  assert.strictEqual(chain[1].name, 'dia_armor');
  assert.strictEqual(chain[1].skill, 'diaArmor');
  assert.strictEqual(chain[1].optional, true);
});

test('dia_armor : 11 diamants → plastron diamant avant de continuer à miner', () => {
  assert.strictEqual(first(miner({ diamond: 11 })), 'dia_armor');
  assert.deepStrictEqual(G.diamondArmorPlanOf(miner({ diamond: 11 })).name, 'diamond_chestplate');
  // 10 diamants : réserve pioche (3) → on mine encore
  assert.strictEqual(first(miner({ diamond: 10 })), 'diamond_caves');
});

test('dia_armor : la pioche diamant passe avant (pas de pioche fer, pas encore améliorée)', () => {
  const c = miner({ diamond: 20, iron_pickaxe: 0 }, { diaPickUpgraded: false });
  assert.strictEqual(first(c), 'dia_pick');
});

test('dia_armor : armure diamant complète → plus rien, minage', () => {
  const worn = ['diamond_helmet', 'diamond_chestplate', 'diamond_leggings', 'diamond_boots'];
  assert.strictEqual(first(miner({ diamond: 60 }, { worn })), 'diamond_caves');
});

test('dia_armor : pièce diamant usée (sortie de worn) → refaite en diamant', () => {
  const worn = ['diamond_chestplate', 'diamond_leggings', 'diamond_boots'];   // casque usé exclu
  const c = miner({ diamond: 8 }, { worn, pocketArmorGood: [] });
  assert.strictEqual(first(c), 'dia_armor');
  assert.strictEqual(G.diamondArmorPlanOf(c).name, 'diamond_helmet');
});

test('0 diamant en poche après l armure : pas de retour au bois/fer de surface', () => {
  // Pioche diamant + armure diamant portée, poche vidée de ses diamants par les crafts.
  const c = { inv: { diamond_pickaxe: 1, cobblestone: 32, stick: 4 }, y: -54,
    worn: ['diamond_chestplate', 'diamond_leggings'], diaPickUpgraded: true };
  const g = G.firstUnmet(chain, c);
  assert.ok(g && ['dia_armor', 'diamond_caves'].includes(g.name), 'premier but = ' + (g && g.name));
  // Même avec une simple pioche fer : l'armure diamant portée prouve l'amont.
  const c2 = Object.assign({}, c, { inv: { iron_pickaxe: 1, cobblestone: 32, stick: 4 } });
  const g2 = G.firstUnmet(chain, c2);
  assert.ok(g2 && !['logs', 'planks', 'crafting_table', 'furnace', 'iron_ore', 'iron_ingot'].includes(g2.name),
    'premier but = ' + (g2 && g2.name));
});
