'use strict';

/**
 * tests/watchlist.test.js — le plan d'import « watchlist TV -> favoris Omen ».
 *
 * ``lib/symbols.js`` est chargé D'ABORD : c'est lui qui pose
 * ``globalThis.OmenLib.symbols``, que le planificateur va chercher à l'appel
 * (exactement comme ``content.js``).
 */
const test = require('node:test');
const assert = require('node:assert');

require('../lib/symbols.js');
const watchlist = require('../lib/watchlist.js');

test('les symboles connus sont traduits, les inconnus listés tels quels', () => {
  const plan = watchlist.planImport(
    ['NASDAQ:AAPL', 'SIX:NESN', 'WTF:XYZ', 'BINANCE:BTCUSDT'], []);
  assert.deepStrictEqual(plan.post, ['AAPL', 'NESN.SW', 'BTC-USD']);
  assert.deepStrictEqual(plan.unknown, ['WTF:XYZ']);
  assert.deepStrictEqual(plan.skipped, []);
  assert.strictEqual(plan.seen, 4);
  assert.strictEqual(plan.capped, false);
});

test('les favoris déjà posés sont SAUTÉS, casse comprise', () => {
  const plan = watchlist.planImport(
    ['NASDAQ:AAPL', 'SIX:NESN'],
    [{ symbol: 'aapl', name: 'Apple' }]);
  assert.deepStrictEqual(plan.post, ['NESN.SW']);
  assert.deepStrictEqual(plan.skipped, ['AAPL']);
});

test('les favoris acceptent aussi une simple liste de chaînes', () => {
  const plan = watchlist.planImport(['NASDAQ:AAPL', 'NASDAQ:TSLA'], ['TSLA']);
  assert.deepStrictEqual(plan.post, ['AAPL']);
  assert.deepStrictEqual(plan.skipped, ['TSLA']);
});

test('doublons de la watchlist : une seule création', () => {
  const plan = watchlist.planImport(
    ['NASDAQ:AAPL', 'nasdaq:aapl', ' NASDAQ:AAPL '], []);
  assert.deepStrictEqual(plan.post, ['AAPL']);
  assert.strictEqual(plan.seen, 1, 'le dédoublonnage doit précéder le comptage');
});

test('deux lignes TradingView pour le MÊME titre Yahoo -> une création', () => {
  /* BX:NESR et SIX:NESN mènent tous les deux à NESN.SW. */
  const plan = watchlist.planImport(['BX:NESR', 'SIX:NESN'], []);
  assert.deepStrictEqual(plan.post, ['NESN.SW']);
  assert.strictEqual(plan.seen, 2);
});

test('le plafond coupe la liste sans perdre le reste du décompte', () => {
  const many = [];
  for (let i = 0; i < 40; i += 1) { many.push('NASDAQ:AA' + i); }
  const plan = watchlist.planImport(many, [], { cap: 30 });
  assert.strictEqual(plan.post.length, 30);
  assert.strictEqual(plan.capped, true);
  assert.strictEqual(plan.cap, 30);
  assert.strictEqual(plan.seen, 40);
});

test('le plafond par défaut vaut 30 (= paper_router.MAX_WATCHLIST)', () => {
  assert.strictEqual(watchlist.DEFAULT_CAP, 30);
  const many = [];
  for (let i = 0; i < 35; i += 1) { many.push('NASDAQ:BB' + i); }
  assert.strictEqual(watchlist.planImport(many, []).post.length, 30);
});

test('entrées vides ou illisibles : ignorées, jamais postées', () => {
  const plan = watchlist.planImport(['', '   ', null, undefined, 'NASDAQ:AAPL'], []);
  assert.deepStrictEqual(plan.post, ['AAPL']);
  assert.deepStrictEqual(plan.unknown, []);
  assert.strictEqual(plan.seen, 1);
  assert.deepStrictEqual(watchlist.planImport(null, null).post, []);
});

test('un traducteur injecté remplace la table (et ses exceptions sont muettes)', () => {
  const plan = watchlist.planImport(['X', 'Y'], [], {
    map: (tv) => (tv === 'X' ? 'X.SW' : null)
  });
  assert.deepStrictEqual(plan.post, ['X.SW']);
  assert.deepStrictEqual(plan.unknown, ['Y']);

  const boom = watchlist.planImport(['X'], [], {
    map: () => { throw new Error('table cassée'); }
  });
  assert.deepStrictEqual(boom.post, []);
  assert.deepStrictEqual(boom.unknown, ['X']);
});

test('sans traducteur, TOUT est inconnu (aucun symbole inventé)', () => {
  const plan = watchlist.planImport(['NASDAQ:AAPL'], [], { map: null, cap: 5 });
  /* ``map: null`` retombe sur OmenLib.symbols, présent ici : on force donc
     l'absence avec un faux traducteur qui ne rend rien. */
  assert.ok(Array.isArray(plan.post));
  const none = watchlist.planImport(['NASDAQ:AAPL'], [], { map: () => null });
  assert.deepStrictEqual(none.post, []);
  assert.deepStrictEqual(none.unknown, ['NASDAQ:AAPL']);
});

test('knownSet normalise en majuscules et ignore le vide', () => {
  const known = watchlist.knownSet([{ symbol: 'aapl' }, 'nesn.sw', { symbol: '' }, null]);
  assert.deepStrictEqual(Object.keys(known).sort(), ['AAPL', 'NESN.SW']);
});
