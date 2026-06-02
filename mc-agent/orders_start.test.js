'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { parseOrder } = require('./orders');

test('parseOrder reconnaît start/mvp → startAutonomous', () => {
  assert.deepStrictEqual(parseOrder('start'), { verb: 'startAutonomous', args: {} });
  assert.deepStrictEqual(parseOrder('mvp'), { verb: 'startAutonomous', args: {} });
  assert.deepStrictEqual(parseOrder('START'), { verb: 'startAutonomous', args: {} });
});
