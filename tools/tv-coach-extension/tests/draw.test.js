'use strict';

/**
 * tests/draw.test.js — les commandes de dessin, sur deux hypothèses.
 */
const test = require('node:test');
const assert = require('node:assert');

const draw = require('../lib/draw.js');

const NOW = 1757404800;          /* 2026-09-09T08:00:00Z, en secondes */
const PRICE = 100;

const HYPOTHESES = [
  { id: 'h1', direction: 'up', confidence: 'haute', horizon_days: 10, target: 110,
    status: 'open' },
  { id: 'h2', direction: 'down', confidence: 'faible', horizon_days: 5,
    status: 'open' },
  { id: 'h3', direction: 'up', confidence: 'moyenne', horizon_days: 20,
    status: 'closed' }
];

test('bets ne dessine que les paris OUVERTS', () => {
  const commands = draw.bets(HYPOTHESES, PRICE, NOW);
  const ids = commands.map((c) => c.meta.id);
  assert.ok(ids.indexOf('h3') === -1, 'un pari clos a été dessiné');
  /* h1 : tendance + verticale + zone cible ; h2 : tendance + verticale */
  assert.strictEqual(commands.length, 5);
});

test('bets : la ligne de tendance va du prix vers ±3 % à l’horizon', () => {
  const commands = draw.bets([HYPOTHESES[0]], PRICE, NOW);
  const trend = commands[0];
  assert.strictEqual(trend.kind, 'multipoint');
  assert.strictEqual(trend.shape, 'trend_line');
  assert.deepStrictEqual(trend.points[0], { time: NOW, price: 100 });
  assert.strictEqual(trend.points[1].time, NOW + (10 * 86400));
  assert.ok(Math.abs(trend.points[1].price - 103) < 1e-9);
  assert.strictEqual(trend.text, '⌂ coach · A · haute');
});

test('bets : un pari baissier descend de 3 %', () => {
  const commands = draw.bets([HYPOTHESES[1]], PRICE, NOW);
  const trend = commands[0];
  assert.ok(Math.abs(trend.points[1].price - 97) < 1e-9);
  assert.strictEqual(trend.text, '⌂ coach · C · faible');
});

test('bets : verticale d’échéance et zone cible', () => {
  const commands = draw.bets([HYPOTHESES[0]], PRICE, NOW);
  const deadline = commands[1];
  assert.strictEqual(deadline.kind, 'shape');
  assert.strictEqual(deadline.shape, 'vertical_line');
  assert.strictEqual(deadline.point.time, NOW + (10 * 86400));

  const zone = commands[2];
  assert.strictEqual(zone.shape, 'rectangle');
  assert.strictEqual(zone.points.length, 2);
  assert.ok(zone.points[0].price > 110 && zone.points[1].price < 110);
  assert.strictEqual(zone.meta.role, 'target');
});

test('bets : sans horizon, l’échéance est à 30 jours', () => {
  const commands = draw.bets([{ id: 'x', direction: 'up', confidence: 0.9 }],
                             PRICE, NOW);
  assert.strictEqual(commands[0].points[1].time, NOW + (30 * 86400));
  assert.strictEqual(commands[0].text, '⌂ coach · A · haute');
});

test('bets : entrées inutilisables -> aucune commande', () => {
  assert.deepStrictEqual(draw.bets(HYPOTHESES, null, NOW), []);
  assert.deepStrictEqual(draw.bets(HYPOTHESES, PRICE, null), []);
  assert.deepStrictEqual(draw.bets(null, PRICE, NOW), []);
});

test('gradeOf traduit la confiance en note', () => {
  assert.deepStrictEqual(draw.gradeOf('haute'), { grade: 'A', word: 'haute' });
  assert.deepStrictEqual(draw.gradeOf('MEDIUM'), { grade: 'B', word: 'moyenne' });
  assert.deepStrictEqual(draw.gradeOf('bassa'), { grade: 'C', word: 'faible' });
  assert.strictEqual(draw.gradeOf(0.2).grade, 'C');
  assert.strictEqual(draw.gradeOf(80).grade, 'A');
  assert.strictEqual(draw.gradeOf(undefined).grade, 'B');
});

test('levels rend des lignes d’ordre déplaçables', () => {
  const commands = draw.levels({ entry: 100, stop: 98, target: 106,
                                 side: 'buy', qty: 3 });
  assert.deepStrictEqual(commands.map((c) => c.key), ['entry', 'stop', 'target']);
  assert.ok(commands.every((c) => c.kind === 'orderline'));
  assert.strictEqual(commands[0].quantity, '3');
  assert.strictEqual(commands[1].text, '⌂ coach · stop');
});

test('levels ignore les niveaux absents', () => {
  const commands = draw.levels({ entry: 100, side: 'sell' });
  assert.strictEqual(commands.length, 1);
  assert.strictEqual(commands[0].text, '⌂ coach · vente');
  assert.deepStrictEqual(draw.levels({}), []);
});

test('scalp pose les repères de séance, gap comblé exclu', () => {
  const commands = draw.scalp({ vwap: 78620, day_high: 79310, day_low: 78050,
                                cme_gap: { level: 77900, open: true } }, NOW);
  assert.strictEqual(commands.length, 4);
  assert.ok(commands.every((c) => c.shape === 'horizontal_line'));
  assert.strictEqual(commands[0].text, '⌂ coach · VWAP');
  assert.strictEqual(commands[3].point.price, 77900);

  const comble = draw.scalp({ vwap: 1, cme_gap: { level: 2, open: false } }, NOW);
  assert.strictEqual(comble.length, 1);
});

test('clear ne demande qu’une chose', () => {
  assert.deepStrictEqual(draw.clear(), [{ kind: 'clear' }]);
});

test('tout texte posé sur le graphique est taggué', () => {
  const commands = draw.bets(HYPOTHESES, PRICE, NOW)
    .concat(draw.levels({ entry: 1, stop: 2, target: 3 }))
    .concat(draw.scalp({ vwap: 1, day_high: 2, day_low: 3 }, NOW));
  for (const command of commands) {
    assert.ok(String(command.text).indexOf(draw.TAG) === 0,
              'texte non taggué : ' + command.text);
  }
});
