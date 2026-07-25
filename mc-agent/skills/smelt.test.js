'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { pickFuelByPriority } = require('./smelt');

const FUEL = ['coal', 'charcoal', 'oak_planks', 'oak_log']; // ordre = priorité (§0-bis)

test('pickFuelByPriority : charbon préféré au bois même si le bois est 1er en inventaire', () => {
  const inv = [{ name: 'oak_log', count: 10 }, { name: 'coal', count: 3 }];
  assert.strictEqual(pickFuelByPriority(inv, FUEL).name, 'coal');
});

test('pickFuelByPriority : charcoal préféré au bois', () => {
  const inv = [{ name: 'oak_planks', count: 8 }, { name: 'charcoal', count: 2 }];
  assert.strictEqual(pickFuelByPriority(inv, FUEL).name, 'charcoal');
});

test('pickFuelByPriority : sans charbon → repli sur le bois (ordre de la liste)', () => {
  const inv = [{ name: 'oak_log', count: 4 }, { name: 'oak_planks', count: 4 }];
  assert.strictEqual(pickFuelByPriority(inv, FUEL).name, 'oak_planks'); // planks avant log dans FUEL
});

test('pickFuelByPriority : aucun combustible → null', () => {
  assert.strictEqual(pickFuelByPriority([{ name: 'dirt', count: 1 }], FUEL), null);
  assert.strictEqual(pickFuelByPriority([], FUEL), null);
  assert.strictEqual(pickFuelByPriority(null, FUEL), null);
});

// ─── Comptage des lingots récupérés (bug vu en prod, world_ax4 25/07) ─────────
// `furnace.takeOutput()` retire la PILE ENTIÈRE (5 lingots d'un coup), mais la boucle faisait
// `got += 1`. Une fonte parfaitement réussie rendait donc `ok:false` (got=2 pour 7 lingots) →
// le planner croyait à un échec et rebouclait sur un but déjà atteint. Preuve live : trois
// `opportunistic_smelt ok:false` alors que les bots avaient bel et bien 1 et 6 lingots en poche.
const { smelt } = require('./smelt');

function fakeFurnaceBot({ outputStacks }) {
  const stacks = outputStacks.slice();
  let current = null;
  const furnace = {
    putInput: async () => {},
    putFuel: async () => {},
    fuelItem: () => ({ name: 'coal', count: 1 }),
    inputItem: () => (stacks.length ? { name: 'raw_iron', count: 1 } : null),
    outputItem: () => { if (!current && stacks.length) current = { name: 'iron_ingot', count: stacks[0] }; return current; },
    takeOutput: async () => { const t = current; stacks.shift(); current = null; return t; },
    close: () => {},
  };
  return {
    registry: {
      itemsByName: { raw_iron: { id: 1 }, iron_ingot: { id: 2 }, coal: { id: 3 } },
      blocksByName: { furnace: { id: 9 } },   // _findFurnace le lit SOUS registry
    },
    inventory: { items: () => [{ name: 'raw_iron', count: 8 }, { name: 'coal', count: 4 }] },
    findBlock: () => ({ position: { x: 0, y: 64, z: 0 } }),
    openFurnace: async () => furnace,
  };
}

test('smelt compte les lingots RÉELLEMENT pris (pile entière), pas 1 par prise', async () => {
  // 7 demandés, livrés en 2 piles (5 puis 2) → 2 prises. L'ancien code comptait got=2 → ok:false.
  const bot = fakeFurnaceBot({ outputStacks: [5, 2] });
  const r = await smelt(bot, { input: 'raw_iron', output: 'iron_ingot', count: 7, fuel: ['coal'], pollMs: 1 });
  assert.strictEqual(r.got, 7, `got=${r.got} : la pile entière doit compter`);
  assert.strictEqual(r.ok, true, 'une fonte complète ne doit pas être rapportée en échec');
});

test('smelt : fonte partielle réelle → ok:false, mais got reflète le vrai gain', async () => {
  const bot = fakeFurnaceBot({ outputStacks: [2] });
  const r = await smelt(bot, { input: 'raw_iron', output: 'iron_ingot', count: 7, fuel: ['coal'], pollMs: 1 });
  assert.strictEqual(r.got, 2);
  assert.strictEqual(r.ok, false);
});
