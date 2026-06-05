'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { detectCaveEntrance } = require('./caves');

// Fake bot : colonne y→nom de bloc (défaut 'stone'). blockAt lit p.y (Vec3 réel ou POJO).
function makeBot(column) {
  return {
    blockAt(p) {
      const name = column[p.y] !== undefined ? column[p.y] : 'stone';
      return { name, boundingBox: (name === 'air' || name === 'cave_air') ? 'empty' : 'block' };
    },
  };
}

const FEET = { x: 100.5, y: 64, z: -20.5 };

test('entrée de grotte : colonne d\'air ≥ minDepth sous les pieds → found', () => {
  // y 63..58 = air (6 blocs) sous les pieds (y64)
  const col = { 63: 'air', 62: 'air', 61: 'air', 60: 'air', 59: 'air', 58: 'air' };
  const r = detectCaveEntrance(makeBot(col), FEET, { minDepth: 4 });
  assert.strictEqual(r.found, true);
  assert.deepStrictEqual(r.pos, { x: 100, y: 63, z: -21 }); // haut de l'ouverture, coords floored (floor(-20.5)=-21)
});

test('sol plein → pas d\'entrée', () => {
  assert.strictEqual(detectCaveEntrance(makeBot({}), FEET, { minDepth: 4 }).found, false); // tout stone
});

test('ouverture trop peu profonde → pas d\'entrée', () => {
  const col = { 63: 'air', 62: 'air', 61: 'stone' }; // 2 air seulement
  assert.strictEqual(detectCaveEntrance(makeBot(col), FEET, { minDepth: 4 }).found, false);
});

test('puits de lave/eau → pas une entrée de grotte (la colonne est coupée)', () => {
  const col = { 63: 'air', 62: 'lava', 61: 'air', 60: 'air' }; // air-lava-air → runs max = 2 < 4
  assert.strictEqual(detectCaveEntrance(makeBot(col), FEET, { minDepth: 4 }).found, false);
});

test('blocs non chargés (null) ne comptent pas comme ouverture', () => {
  const bot = { blockAt: () => null };
  assert.strictEqual(detectCaveEntrance(bot, FEET, { minDepth: 4 }).found, false);
});
