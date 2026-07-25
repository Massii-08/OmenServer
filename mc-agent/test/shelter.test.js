'use strict';
// Abri nocturne (survie kit) : détection nuit pure + flow creuser/attendre/sortir.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { isNightTime } = require('../skills/shelter');

describe('isNightTime (pur)', () => {
  it('jour (0, 6000, 12000) → false ; nuit (13000, 18000, 23000) → true', () => {
    for (const t of [0, 6000, 12000, 23800]) assert.equal(isNightTime(t), false, `t=${t}`);
    for (const t of [13000, 18000, 23000]) assert.equal(isNightTime(t), true, `t=${t}`);
  });
  it('wrap 24000 + null-safe', () => {
    assert.equal(isNightTime(24000 + 18000), true);
    assert.equal(isNightTime(null), false);
    assert.equal(isNightTime(undefined), false);
  });
});

// ─── PLAN B : se murer quand creuser est impossible (mesure live world_ax4, 25/07) ──
// 40 % des abris échouaient : void_below 19, dig_failed 17, danger_below 9. Or un abri raté =
// une nuit ENTIÈRE à découvert, tous mobs confondus (squelette 52 morts, zombie 23, creeper 17).
// Creuser n'est pas la seule mise à l'abri : un vrai joueur se boxe avec ce qu'il a.
const { shelterUntilDawn } = require('../skills/shelter');

function nightBot() {
  return {
    time: { timeOfDay: 13000 },            // nuit → la boucle d'attente s'arme
    entity: { position: { floored: () => ({ x: 0, y: 64, z: 0, offset: () => ({ x: 0, y: 66, z: 0 }), plus: () => ({ x: 1, y: 64, z: 0 }) }) } },
    inventory: { items: () => [] },
    blockAt: () => null,
    dig: async () => {},
    equip: async () => {},
    placeBlock: async () => {},
  };
}

describe('abri : plan B « se murer »', () => {
  it('creuser impossible (void_below) + blocs dispo → SE MURE au lieu d\'abandonner', async () => {
    const events = [];
    const bot = nightBot();
    bot.time.timeOfDay = 1000;             // jour : on ne bloque pas sur l'attente
    const r = await shelterUntilDawn(bot, null, {
      emit: (e) => events.push(e),
      sleep: async () => {},
      mineDown: async () => ({ ok: false, reason: 'void_below' }),
      wallIn: async () => ({ ok: true, placed: 6 }),
    });
    assert.equal(r.ok, true, 'l\'abri doit réussir par le mur');
    const walled = events.find((e) => e.action === 'walled_in');
    assert.ok(walled, 'event walled_in attendu');
    assert.equal(walled.after, 'void_below', 'la raison du creusage raté est tracée');
    assert.equal(events.some((e) => e.action === 'abort'), false, 'plus d\'abandon');
  });

  it('creuser impossible ET murer impossible → abandon (comportement d\'origine)', async () => {
    const events = [];
    const bot = nightBot();
    bot.time.timeOfDay = 1000;
    const r = await shelterUntilDawn(bot, null, {
      emit: (e) => events.push(e),
      sleep: async () => {},
      mineDown: async () => ({ ok: false, reason: 'dig_failed' }),
      wallIn: async () => ({ ok: false, reason: 'no_block' }),
    });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'dig_failed');
    assert.ok(events.some((e) => e.action === 'abort'));
  });

  it('sortie d\'un abri MURÉ : on perce une paroi, pas de pilier', async () => {
    const events = [];
    const bot = nightBot();
    bot.time.timeOfDay = 1000;
    await shelterUntilDawn(bot, null, {
      emit: (e) => events.push(e),
      sleep: async () => {},
      mineDown: async () => ({ ok: false, reason: 'void_below' }),
      wallIn: async () => ({ ok: true, placed: 4 }),
    });
    const out = events.find((e) => e.action === 'out');
    assert.equal(out.mode, 'walled', 'un bot muré au sol n\'a pas de trou à remonter');
  });
});
