'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { shieldItem, shieldStance, shieldAction } = require('./shieldGuard');

test('bouclier en MAIN SECONDAIRE trouvé (session 744 : items() ne couvre pas le slot 45)', () => {
  const off = { name: 'shield', slot: 45 };
  assert.equal(shieldItem({ offhand: off, items: [{ name: 'stone_sword' }] }), off);
});

test('bouclier dans le sac trouvé ; absent → null', () => {
  const sh = { name: 'shield', slot: 20 };
  assert.equal(shieldItem({ offhand: { name: 'torch' }, items: [{ name: 'dirt' }, sh] }), sh);
  assert.equal(shieldItem({ offhand: null, items: [{ name: 'dirt' }] }), null);
  assert.equal(shieldItem({}), null);
});

test('squelette qui VOIT le bot à 10 blocs → bouclier levé', () => {
  assert.equal(shieldStance({ hasShield: true, threats: [{ dist: 10, los: true }] }), 'up');
});

test('squelette caché (pas de ligne de vue) ou hors de portée → baissé', () => {
  assert.equal(shieldStance({ hasShield: true, threats: [{ dist: 10, los: false }] }), 'down');
  assert.equal(shieldStance({ hasShield: true, threats: [{ dist: 22, los: true }] }), 'down');
  assert.equal(shieldStance({ hasShield: true, threats: [] }), 'down');
});

test('cible à portée de coup → baissé pour frapper (on ne peut pas frapper bouclier levé)', () => {
  assert.equal(shieldStance({ hasShield: true, threats: [{ dist: 2.5, los: true }], strikeDist: 2.5 }), 'down');
});

test('approche d\'une charge (cible à 6 blocs) → levé pendant l\'approche', () => {
  assert.equal(shieldStance({ hasShield: true, threats: [{ dist: 6, los: true }], strikeDist: 6 }), 'up');
});

test('repas en cours → on ne touche à rien ; sans bouclier → baissé', () => {
  assert.equal(shieldStance({ hasShield: true, threats: [{ dist: 8, los: true }], eating: true }), 'hold');
  assert.equal(shieldStance({ hasShield: false, threats: [{ dist: 8, los: true }] }), 'down');
});

test('plusieurs tireurs : un seul qui voit suffit à lever', () => {
  assert.equal(shieldStance({ hasShield: true, threats: [{ dist: 9, los: false }, { dist: 14, los: true }] }), 'up');
});

test('shieldAction : relève SEULEMENT sur transition (relancer use_item remet le délai de 5 ticks à zéro)', () => {
  assert.equal(shieldAction({ stance: 'up', raised: false }), 'raise');
  assert.equal(shieldAction({ stance: 'up', raised: true }), null);
  assert.equal(shieldAction({ stance: 'down', raised: true }), 'lower');
  assert.equal(shieldAction({ stance: 'down', raised: false }), null);
  assert.equal(shieldAction({ stance: 'hold', raised: true }), null);
});
