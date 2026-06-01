'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { createMemory } = require('../memory');

test('append + history par joueur (insensible casse)', () => {
  const m = createMemory();
  m.append('Bob', 'user', 'salut');
  m.append('bob', 'assistant', 'hello');
  assert.deepStrictEqual(m.history('BOB'), [
    { role: 'user', content: 'salut' },
    { role: 'assistant', content: 'hello' },
  ]);
  assert.deepStrictEqual(m.history('Alice'), []);
});

test('fenêtre tronquée à maxTurns', () => {
  const m = createMemory({ maxTurns: 3 });
  for (let i = 0; i < 5; i++) m.append('Bob', 'user', 'm' + i);
  assert.deepStrictEqual(m.history('Bob').map((t) => t.content), ['m2', 'm3', 'm4']);
});

test('TTL : reset après inactivité (horloge mockée)', () => {
  let now = 1000;
  const m = createMemory({ ttlMs: 500, now: () => now });
  m.append('Bob', 'user', 'a');
  now = 1400; // < ttl
  assert.strictEqual(m.history('Bob').length, 1);
  now = 2000; // > ttl depuis le dernier accès
  assert.deepStrictEqual(m.history('Bob'), []);
});
