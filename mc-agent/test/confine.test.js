'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { parseConfine, confineSpreadCommand } = require('../confine');

test('parseConfine: valid "X Z R" → {x,z,radius}', () => {
  assert.deepStrictEqual(parseConfine('-352 272 14'), { x: -352, z: 272, radius: 14 });
});

test('parseConfine: rounds floats', () => {
  assert.deepStrictEqual(parseConfine('-352.7 271.2 13.6'), { x: -353, z: 271, radius: 14 });
});

test('parseConfine: empty / null → null (confinement off)', () => {
  assert.strictEqual(parseConfine(''), null);
  assert.strictEqual(parseConfine(null), null);
  assert.strictEqual(parseConfine(undefined), null);
});

test('parseConfine: too few fields → null', () => {
  assert.strictEqual(parseConfine('1 2'), null);
});

test('parseConfine: radius must be > 0', () => {
  assert.strictEqual(parseConfine('1 2 0'), null);
  assert.strictEqual(parseConfine('1 2 -5'), null);
});

test('parseConfine: non-numeric → null', () => {
  assert.strictEqual(parseConfine('a b c'), null);
});

test('confineSpreadCommand: builds /spreadplayers within radius around anchor', () => {
  assert.strictEqual(
    confineSpreadCommand('ResBot1', { x: -352, z: 272, radius: 14 }),
    '/spreadplayers -352 272 0 14 false ResBot1'
  );
});
