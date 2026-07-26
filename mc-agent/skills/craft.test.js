'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { _nearestTable, TABLE_REACH, TABLE_SEEK } = require('./craft');

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
