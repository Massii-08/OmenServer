'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { pillarUp, waitForApex } = require('./pillarUp');

test('waitForApex : critère HAUTEUR (dy≥0.9) accepté même si la vélocité ne redescend pas sous 0.05', async () => {
  let y = 64;
  const bot = { entity: { get position() { return { x: 0, y, z: 0 }; }, velocity: { y: 0.42 } } };
  const p = waitForApex(bot, { startY: 64, sleep: async () => { y += 0.3; }, timeoutMs: 1500, pollMs: 1 });
  assert.strictEqual(await p, true);
});

test('pillarUp : le JUMP reste TENU pendant la pose (coupé après) — sinon le bot retombe avant placeBlock', async () => {
  const ctl = { jump: false };
  let jumpAtPlace = null;
  let y = 64;
  const vys = [0.42, 0.3, 0.15, 0.04];
  let vyi = 0;
  const below = { boundingBox: 'block', position: { x: 0, y: 63, z: 0 }, name: 'stone' };
  const bot = {
    entity: {
      get position() {
        return { x: 0.5, y, z: 0.5, floored: () => ({ x: 0, y: Math.floor(y), z: 0, offset: (a, b, c) => ({ x: 0 + a, y: Math.floor(y) + b, z: 0 + c }) }) };
      },
      velocity: { get y() { return vys[Math.min(vyi++, vys.length - 1)]; } },
    },
    inventory: { items: () => [{ name: 'dirt', count: 5 }] },
    blockAt: (p) => (p.y === 63 ? below : { boundingBox: 'block', name: 'dirt', position: p }),
    equip: async () => {},
    lookAt: async () => {},
    setControlState: (k, v) => { ctl[k] = v; },
    placeBlock: async () => { jumpAtPlace = ctl.jump; y += 1; },
  };
  const r = await pillarUp(bot, { height: 1 }, null, { sleep: async () => {}, apexTimeoutMs: 200, pollMs: 1 });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(jumpAtPlace, true, 'jump doit être TENU au moment du placeBlock');
  assert.strictEqual(ctl.jump, false, 'jump coupé après la pose');
});
