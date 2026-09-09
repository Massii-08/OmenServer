'use strict';

/**
 * tests/price_axis.test.js — l'ordonnée d'un Alt+clic -> un prix.
 */
const test = require('node:test');
const assert = require('node:assert');

const axis = require('../lib/price_axis.js');

/* Un pane de 400 px de haut, posé à 100 px du bord de la fenêtre, qui affiche
   la plage 78 000 -> 80 000 (from = bas, to = haut). */
const TOP = 100;
const HEIGHT = 400;
const FROM = 78000;
const TO = 80000;

test('le haut du pane porte le prix HAUT, le bas le prix BAS', () => {
  assert.strictEqual(axis.priceAtY(TOP, TOP, HEIGHT, FROM, TO), TO);
  assert.strictEqual(axis.priceAtY(TOP + HEIGHT, TOP, HEIGHT, FROM, TO), FROM);
});

test('le milieu du pane est le milieu de la plage', () => {
  assert.strictEqual(axis.priceAtY(TOP + (HEIGHT / 2), TOP, HEIGHT, FROM, TO), 79000);
  /* Un quart en partant du haut = trois quarts de la plage. */
  assert.strictEqual(axis.priceAtY(TOP + 100, TOP, HEIGHT, FROM, TO), 79500);
});

test('un clic hors du cadre est BORNÉ à la plage affichée', () => {
  assert.strictEqual(axis.priceAtY(TOP - 50, TOP, HEIGHT, FROM, TO), TO);
  assert.strictEqual(axis.priceAtY(TOP + HEIGHT + 500, TOP, HEIGHT, FROM, TO), FROM);
});

test('une plage inversée reste juste (on ne suppose pas to > from)', () => {
  assert.strictEqual(axis.priceAtY(TOP, TOP, HEIGHT, TO, FROM), FROM);
  assert.strictEqual(axis.priceAtY(TOP + HEIGHT, TOP, HEIGHT, TO, FROM), TO);
});

test('mesure manquante ou hauteur nulle -> null (jamais un prix inventé)', () => {
  assert.strictEqual(axis.priceAtY(null, TOP, HEIGHT, FROM, TO), null);
  assert.strictEqual(axis.priceAtY(120, null, HEIGHT, FROM, TO), null);
  assert.strictEqual(axis.priceAtY(120, TOP, 0, FROM, TO), null);
  assert.strictEqual(axis.priceAtY(120, TOP, -40, FROM, TO), null);
  assert.strictEqual(axis.priceAtY(120, TOP, HEIGHT, null, TO), null);
  assert.strictEqual(axis.priceAtY(120, TOP, HEIGHT, FROM, undefined), null);
  assert.strictEqual(axis.priceAtY('abc', TOP, HEIGHT, FROM, TO), null);
});

test('un petit prix garde ses décimales', () => {
  /* Plage 0,10 -> 0,20 sur 200 px : le milieu vaut 0,15. */
  const price = axis.priceAtY(100, 0, 200, 0.1, 0.2);
  assert.ok(Math.abs(price - 0.15) < 1e-12);
});

test('roundPrice suit la précision d’affichage du panneau', () => {
  assert.strictEqual(axis.roundPrice(78760.10312938), 78760.1);
  assert.strictEqual(axis.roundPrice(42.123456789), 42.1235);
  assert.strictEqual(axis.roundPrice(0.000123456789), 0.000123);
  assert.strictEqual(axis.roundPrice(null), null);
  assert.strictEqual(axis.roundPrice('abc'), null);
});

test('la condition se choisit sur le prix live', () => {
  assert.strictEqual(axis.opForPrice(105, 100), 'above');
  assert.strictEqual(axis.opForPrice(95, 100), 'below');
  /* Pile sur le cours : « au-dessus », et le serveur refusera de toute façon. */
  assert.strictEqual(axis.opForPrice(100, 100), 'above');
  /* Sans prix live on ne devine pas : « au-dessus » par défaut. */
  assert.strictEqual(axis.opForPrice(105, null), 'above');
  assert.strictEqual(axis.opForPrice(null, 100), 'above');
});

test('wouldBeRefused est le miroir de price_alerts.condition_met (inclusif)', () => {
  assert.strictEqual(axis.wouldBeRefused('above', 100, 101), true);
  assert.strictEqual(axis.wouldBeRefused('above', 100, 100), true);
  assert.strictEqual(axis.wouldBeRefused('above', 100, 99), false);
  assert.strictEqual(axis.wouldBeRefused('below', 100, 99), true);
  assert.strictEqual(axis.wouldBeRefused('below', 100, 100), true);
  assert.strictEqual(axis.wouldBeRefused('below', 100, 101), false);
  /* Sans cours, aucun refus annoncé : on n'invente pas un verdict. */
  assert.strictEqual(axis.wouldBeRefused('above', 100, null), false);
  assert.strictEqual(axis.wouldBeRefused('n’importe quoi', 100, 101), false);
});
