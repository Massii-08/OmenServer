'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { Vec3 } = require('vec3');
const { bookmark } = require('./homewarp');

// Puits d'air en x=-344,z=358 de y43 à y74, surface y75 ailleurs (cas NethBot3, 22/10).
function mkBot(pos) {
  const said = [];
  const bot = {
    chat: (m) => said.push(m),
    entity: { position: new Vec3(pos.x, pos.y, pos.z) },
    blockAt: (v) => {
      assert.ok(v instanceof Vec3, 'blockAt reçoit un Vec3');
      if (v.x === -344 && v.z === 358 && v.y >= 43 && v.y <= 74) return { name: 'air', boundingBox: 'empty' };
      return v.y <= 74 ? { name: 'stone', boundingBox: 'block' } : { name: 'air', boundingBox: 'empty' };
    },
  };
  return { bot, said };
}

test('bookmark : home safe au-dessus du puits → REFUSÉ (rien envoyé), hook notifié', () => {
  const { bot, said } = mkBot({ x: -343.4, y: 75, z: 358.7 });
  let seen = null;
  bot._mcaOnBookmarkRefused = (i) => { seen = i; };
  assert.strictEqual(bookmark(bot, 'safe'), false);
  assert.deepStrictEqual(said, []);
  assert.strictEqual(seen.name, 'safe');
  assert.strictEqual(seen.reason, 'void_below');
  assert.strictEqual(bot._mcaBookmarkRefused.name, 'safe');
});

test('bookmark : en plein vol dans le puits (y59) → refusé ; work aussi', () => {
  const { bot, said } = mkBot({ x: -343.4, y: 59.3, z: 358.7 });
  assert.strictEqual(bookmark(bot, 'safe'), false);
  assert.strictEqual(bookmark(bot, 'work'), false);
  assert.deepStrictEqual(said, []);
});

test('bookmark : sur la terre ferme → posé ; `death` jamais bloqué (marque juste le lieu)', () => {
  const ok = mkBot({ x: -340.5, y: 75, z: 358.5 });
  assert.strictEqual(bookmark(ok.bot, 'safe'), 'safe');
  assert.deepStrictEqual(ok.said, ['/sethome safe']);
  const air = mkBot({ x: -343.4, y: 60, z: 358.7 });
  assert.strictEqual(bookmark(air.bot, 'death'), 'death');
  assert.deepStrictEqual(air.said, ['/sethome death']);
});

test('bookmark : sol illisible (chunk pas chargé) → comportement d avant, on pose', () => {
  const { bot, said } = mkBot({ x: 0, y: 70, z: 0 });
  bot.blockAt = () => null;
  assert.strictEqual(bookmark(bot, 'safe'), 'safe');
  assert.deepStrictEqual(said, ['/sethome safe']);
});
