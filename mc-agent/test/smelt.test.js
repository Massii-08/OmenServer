'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { smelt, fuelUnits, burnValue } = require('../skills/smelt');

// Faux bot + faux four. Le four "fond instantanément" (pour le test) : outputItem() rend un lingot
// tant que taken<want, takeOutput() incrémente. fuelItem() non-null = combustible toujours présent.
function makeBot({ furnaceFound = true, input = 'raw_iron', inputCount = 3, fuel = 'oak_planks', hasFuel = true, fuelCount = 10 } = {}) {
  const want0 = inputCount;
  let taken = 0;
  const calls = { putInput: [], putFuel: [], takeOutput: 0, opened: 0 };
  const inv = [];
  if (inputCount > 0) inv.push({ name: input, count: inputCount });
  if (hasFuel) inv.push({ name: fuel, count: fuelCount });
  const furnace = {
    putInput: async (id, m, c) => { calls.putInput.push([id, c]); },
    putFuel: async (id, m, c) => { calls.putFuel.push([id, c]); },
    inputItem: () => (taken < want0 ? { name: input, count: want0 - taken } : null),
    fuelItem: () => (hasFuel ? { name: fuel, count: 5 } : null),
    outputItem: () => (taken < want0 ? { name: 'iron_ingot', count: 1 } : null),
    takeOutput: async () => { calls.takeOutput += 1; taken += 1; return { name: 'iron_ingot', count: 1 }; },
    close: () => {},
  };
  return {
    _calls: calls,
    registry: {
      blocksByName: { furnace: { id: 61 } },
      itemsByName: { raw_iron: { id: 100 }, iron_ingot: { id: 101 }, oak_planks: { id: 5 }, coal: { id: 6 } },
    },
    inventory: { items: () => inv },
    findBlock: () => (furnaceFound ? { name: 'furnace', position: { x: 0, y: 64, z: 0 } } : null),
    openFurnace: async () => { calls.opened += 1; return furnace; },
  };
}

test('smelt: fond count items et récupère la sortie', async () => {
  const bot = makeBot({ inputCount: 3 });
  const r = await smelt(bot, { input: 'raw_iron', output: 'iron_ingot', count: 3, fuel: ['coal', 'oak_planks'], pollMs: 1 });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.got, 3);
  assert.strictEqual(bot._calls.takeOutput, 3);
  assert.strictEqual(bot._calls.putInput.length, 1);
  assert.ok(bot._calls.putFuel.length >= 1);
  assert.strictEqual(bot._calls.opened, 1);
});

test('smelt: borne count par l’inventaire disponible', async () => {
  const bot = makeBot({ inputCount: 2 });           // seulement 2 raw_iron dispo
  const r = await smelt(bot, { input: 'raw_iron', output: 'iron_ingot', count: 5, fuel: ['oak_planks'], pollMs: 1 });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.got, 2);                     // n'a fondu que ce qu'il avait
});

test('smelt: pas de four proche -> no_furnace', async () => {
  const bot = makeBot({ furnaceFound: false });
  const r = await smelt(bot, { input: 'raw_iron', count: 3, fuel: ['oak_planks'], pollMs: 1 });
  assert.deepStrictEqual(r, { ok: false, reason: 'no_furnace' });
});

test('smelt: pas de combustible -> no_fuel', async () => {
  const bot = makeBot({ hasFuel: false });
  const r = await smelt(bot, { input: 'raw_iron', count: 3, fuel: ['oak_planks', 'coal'], pollMs: 1 });
  assert.deepStrictEqual(r, { ok: false, reason: 'no_fuel' });
});

test('smelt: pas d’input -> no_input', async () => {
  const bot = makeBot({ inputCount: 0 });
  const r = await smelt(bot, { input: 'raw_iron', count: 3, fuel: ['oak_planks'], pollMs: 1 });
  assert.deepStrictEqual(r, { ok: false, reason: 'no_input' });
});

test('smelt: item inconnu -> unknown_item', async () => {
  const bot = makeBot();
  const r = await smelt(bot, { input: 'zzz_not_an_item', count: 1, fuel: ['oak_planks'], pollMs: 1 });
  assert.deepStrictEqual(r, { ok: false, reason: 'unknown_item' });
});

// --- Pré-check déficit de combustible (lever vérifié) ---

test('burnValue: valeurs MC standard + essences de bois + inconnu=0', () => {
  assert.strictEqual(burnValue('coal'), 8);
  assert.strictEqual(burnValue('charcoal'), 8);
  assert.strictEqual(burnValue('coal_block'), 80);
  assert.strictEqual(burnValue('oak_planks'), 1.5);
  assert.strictEqual(burnValue('spruce_log'), 1.5);
  assert.strictEqual(burnValue('crimson_stem'), 1.5);
  assert.strictEqual(burnValue('lava_bucket'), 100);
  assert.strictEqual(burnValue('cobblestone'), 0);
  assert.strictEqual(burnValue(null), 0);
});

test('fuelUnits: somme le combustible-équivalent des seuls items ACCEPTÉS', () => {
  const items = [
    { name: 'coal', count: 2 },        // 2 × 8 = 16
    { name: 'oak_planks', count: 4 },  // 4 × 1.5 = 6
    { name: 'raw_iron', count: 30 },   // pas un fuel → 0
    { name: 'diamond', count: 1 },     // pas dans `fuel` → 0
  ];
  assert.strictEqual(fuelUnits(items, ['coal', 'charcoal', 'oak_planks']), 22);
  // un item de fuel NON listé dans `fuel` (charbon exclu) n'est pas compté
  assert.strictEqual(fuelUnits(items, ['oak_planks']), 6);
  assert.strictEqual(fuelUnits([], ['coal']), 0);
});

test('smelt: BORNE want par le combustible dispo (ne surcharge pas le four)', async () => {
  // 24 raw_iron en poche mais 1 seul charbon (8 fontes) → ne charge QUE 8 dans le four
  const bot = makeBot({ inputCount: 24, fuel: 'coal', fuelCount: 1 });
  const r = await smelt(bot, { input: 'raw_iron', output: 'iron_ingot', count: 24, fuel: ['coal', 'oak_planks'], pollMs: 1 });
  assert.strictEqual(r.got, 8);                          // fondu = ce que le fuel permet
  assert.deepStrictEqual(bot._calls.putInput[0], [100, 8]); // putInput chargé avec 8, pas 24
});

test('smelt: combustible sous 1 unité utile -> no_fuel', async () => {
  // 1 seul stick = 0.5 unité → floor(0.5)=0 → on ne peut pas fondre 1 item plein
  const bot = makeBot({ inputCount: 3, fuel: 'stick', fuelCount: 1 });
  bot.registry.itemsByName.stick = { id: 7 };
  const r = await smelt(bot, { input: 'raw_iron', count: 3, fuel: ['stick'], pollMs: 1 });
  assert.deepStrictEqual(r, { ok: false, reason: 'no_fuel' });
});
