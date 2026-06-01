'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { createTaskController } = require('../tasks');

test('begin retourne un token non annulé + active', () => {
  const c = createTaskController();
  const t = c.begin('take', () => {});
  assert.strictEqual(t.cancelled, false);
  assert.strictEqual(c.active, 'take');
});

test('une nouvelle tâche annule la précédente (cleanup + token.cancelled)', () => {
  const c = createTaskController();
  let cleaned = 0;
  const t1 = c.begin('guard', () => { cleaned++; });
  const t2 = c.begin('take', () => {});
  assert.strictEqual(cleaned, 1);
  assert.strictEqual(t1.cancelled, true);
  assert.strictEqual(t2.cancelled, false);
  assert.strictEqual(c.active, 'take');
});

test('cancel exécute le cleanup et vide active', () => {
  const c = createTaskController();
  let cleaned = 0;
  const t = c.begin('loiter', () => { cleaned++; });
  c.cancel();
  assert.strictEqual(cleaned, 1);
  assert.strictEqual(t.cancelled, true);
  assert.strictEqual(c.active, null);
});

test('setCleanup met à jour le cleanup courant', () => {
  const c = createTaskController();
  let a = 0, b = 0;
  c.begin('guard', () => { a++; });
  c.setCleanup(() => { b++; });
  c.cancel();
  assert.strictEqual(a, 0);
  assert.strictEqual(b, 1);
});
