'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { maybeRunKit } = require('./kit');

test('maybeRunKit : pas de commande configurée → run:false', () => {
  assert.strictEqual(maybeRunKit({ kitCommand: '', lastRunAt: null, now: 1000 }).run, false);
  assert.strictEqual(maybeRunKit({ kitCommand: null, lastRunAt: null, now: 1000 }).run, false);
});

test('maybeRunKit : commande + jamais lancé → run:true', () => {
  const r = maybeRunKit({ kitCommand: '/kit', lastRunAt: null, now: 1000 });
  assert.strictEqual(r.run, true);
});

test('maybeRunKit : re-appel avant cooldown → run:false ; après cooldown → run:true', () => {
  assert.strictEqual(maybeRunKit({ kitCommand: '/kit', lastRunAt: 1000, now: 1000 + 60000, cooldownMs: 300000 }).run, false);
  assert.strictEqual(maybeRunKit({ kitCommand: '/kit', lastRunAt: 1000, now: 1000 + 300000, cooldownMs: 300000 }).run, true);
});
