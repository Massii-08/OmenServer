'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { needDirtBuffer, POSABLE } = require('./dirt');

test('needDirtBuffer : sous le seuil → true, au-dessus → false', () => {
  assert.strictEqual(needDirtBuffer([], 4), true);
  assert.strictEqual(needDirtBuffer([{ name: 'dirt', count: 2 }], 4), true);
  assert.strictEqual(needDirtBuffer([{ name: 'dirt', count: 4 }], 4), false);
  assert.strictEqual(needDirtBuffer([{ name: 'cobblestone', count: 3 }, { name: 'gravel', count: 3 }], 4), false);
});

test('needDirtBuffer : ignore les items non posables (épée, torche)', () => {
  assert.strictEqual(needDirtBuffer([{ name: 'stone_sword', count: 1 }, { name: 'torch', count: 20 }], 4), true);
  assert.ok(POSABLE.has('dirt') && POSABLE.has('cobblestone'));
});
