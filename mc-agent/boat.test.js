'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { outwardHeading, landAhead, boatStuck } = require('./boat');

test('outwardHeading : pointe à l’opposé du centroïde mappé', () => {
  const h = outwardHeading({ x: 100, z: 100 }, { x: 0, z: 0 }, null, () => 0.5);
  assert.ok(Math.abs(h - Math.atan2(100, 100)) < 1e-6);   // ~π/4 (NE)
});

test('outwardHeading : au centre exact → cap tiré (pas de NaN)', () => {
  const h = outwardHeading({ x: 0, z: 0 }, { x: 0, z: 0 }, null, () => 0.25);
  assert.ok(Number.isFinite(h) && h >= 0 && h < Math.PI * 2);
});

test('landAhead : détecte la côte (eau puis sol solide au cap +x)', () => {
  const sampler = (x, y, z) => {
    if (y > 64) return { name: 'air', boundingBox: 'empty' };
    if (x < 20) return { name: 'water', boundingBox: 'empty' };
    return { name: 'stone', boundingBox: 'block' };
  };
  const r = landAhead(sampler, { x: 0, y: 64, z: 0 }, 0, { reach: 40, step: 4 });
  assert.strictEqual(r.found, true);
  assert.ok(r.pos.x >= 20 && r.pos.x <= 24);
});

test('landAhead : océan à perte de vue → found:false', () => {
  const sampler = (x, y, z) => (y > 64 ? { name: 'air', boundingBox: 'empty' } : { name: 'water', boundingBox: 'empty' });
  assert.strictEqual(landAhead(sampler, { x: 0, y: 64, z: 0 }, 0, { reach: 40, step: 4 }).found, false);
});

test('boatStuck : immobile assez longtemps → true ; bouge ou trop tôt → false', () => {
  assert.strictEqual(boatStuck({ x: 0, z: 0 }, { x: 0, z: 0 }, 12000), true);
  assert.strictEqual(boatStuck({ x: 0, z: 0 }, { x: 10, z: 0 }, 12000), false);
  assert.strictEqual(boatStuck({ x: 0, z: 0 }, { x: 0, z: 0 }, 5000), false);
});
