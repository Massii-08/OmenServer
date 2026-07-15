'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { outwardHeading, landAhead, boatStuck, ensureBoat, sailToLand } = require('./boat');

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

test('ensureBoat : bateau déjà en poche → ok sans craft', async () => {
  const bot = { inventory: { items: () => [{ name: 'oak_boat', count: 1 }] } };
  let crafted = false;
  const r = await ensureBoat(bot, { craft: async () => { crafted = true; return { ok: true }; } });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(crafted, false);
});

test('ensureBoat : pas de bateau, bois dispo → crafte le bateau de l’essence', async () => {
  const bot = { inventory: { items: () => [{ name: 'birch_planks', count: 8 }] } };
  const calls = [];
  const r = await ensureBoat(bot, { craft: async (a) => { calls.push(a); return { ok: true }; } });
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(calls[0], { name: 'birch_boat', count: 1 });
});

test('sailToLand : s’arrête et débarque dès que la terre est détectée devant', async () => {
  let ticks = 0;
  const ctl = {};
  const bot = {
    entity: { position: { x: 0, y: 64, z: 0 } },
    look: async () => {},
    setControlState: (k, v) => { ctl[k] = v; },
    clearControlStates: () => { ctl.cleared = true; },
    dismount: async () => { ctl.dismounted = true; },
    blockAt: () => null,
  };
  const sampleBlock = () => (++ticks >= 3 ? { name: 'stone', boundingBox: 'block' } : { name: 'water', boundingBox: 'empty' });
  const r = await sailToLand(bot, 0, {
    sampleBlock, reach: 8, step: 8, tickMs: 0, timeoutMs: 5000,
    now: (() => { let t = 0; return () => (t += 100); })(), sleep: async () => {},
  });
  assert.strictEqual(r.landed, true);
  assert.strictEqual(ctl.cleared, true);
  assert.strictEqual(ctl.dismounted, true);
});

test('sailToLand : jamais de terre + timeout → landed:false, contrôles relâchés', async () => {
  const ctl = {};
  const bot = {
    entity: { position: { x: 0, y: 64, z: 0 } },
    look: async () => {}, setControlState: () => {},
    clearControlStates: () => { ctl.cleared = true; }, dismount: async () => {}, blockAt: () => null,
  };
  const r = await sailToLand(bot, 0, {
    sampleBlock: () => ({ name: 'water', boundingBox: 'empty' }),
    reach: 8, step: 8, tickMs: 0, timeoutMs: 300,
    now: (() => { let t = 0; return () => (t += 200); })(), sleep: async () => {},
  });
  assert.strictEqual(r.landed, false);
  assert.strictEqual(ctl.cleared, true);
});
