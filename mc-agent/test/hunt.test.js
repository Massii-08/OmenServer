'use strict';
// Kit de survie : chasse de mobs passifs (tuer → ramasser → la cuisson se fait au four ensuite).
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const vec3 = require('vec3');
const { huntPassive } = require('../skills/hunt');

function huntBot({ preys = [], items = [['stone_sword', 1]] } = {}) {
  const calls = { attack: [], equip: [], gotos: [] };
  const bot = {
    entity: { position: vec3(0, 64, 0) },
    entities: Object.fromEntries(preys.map((p, i) => [i, p])),
    inventory: { items: () => items.map(([n, c]) => ({ name: n, count: c })) },
    nearestEntity(fn) {
      let best = null, bestD = Infinity;
      for (const e of Object.values(this.entities)) {
        if (!fn(e)) continue;
        const d = e.position.distanceTo(this.entity.position);
        if (d < bestD) { bestD = d; best = e; }
      }
      return best;
    },
    equip: async (it) => calls.equip.push(it.name),
    pvp: {
      attack: (e) => { calls.attack.push(e.name); e._hits = (e._hits || 0) + 1; },
      stop: () => {},
    },
    pathfinder: { goto: async () => {} },
    registry: { itemsByName: {} },
  };
  return { bot, calls };
}
function prey(name, pos) {
  return { name, kind: 'Passive mobs', type: 'mob', position: vec3(pos.x, pos.y, pos.z), isValid: true };
}

describe('huntPassive (kit de survie)', () => {
  it('tue la proie la plus proche (arme équipée), ramasse les drops sur place', async () => {
    const pig = prey('pig', { x: 6, y: 64, z: 0 });
    const { bot, calls } = huntBot({ preys: [pig] });
    const gotos = [];
    const r = await huntPassive(bot, { count: 1 }, null, {
      sleep: async () => { pig.isValid = false; },             // la proie meurt au 1er poll
      goto: async (p) => gotos.push(p),
      pickupMs: 0,
    });
    assert.equal(r.ok, true);
    assert.equal(r.kills, 1);
    assert.deepEqual(calls.attack, ['pig']);
    assert.deepEqual(calls.equip, ['stone_sword']);
    assert.equal(gotos.length, 1);                             // est allé ramasser
    assert.equal(gotos[0].x, 6);
  });

  it('plusieurs proies : enchaîne jusqu\'à count', async () => {
    const a = prey('cow', { x: 4, y: 64, z: 0 });
    const b = prey('chicken', { x: 9, y: 64, z: 0 });
    const { bot, calls } = huntBot({ preys: [a, b] });
    const r = await huntPassive(bot, { count: 2 }, null, {
      sleep: async () => { for (const e of Object.values(bot.entities)) if (e._hits) e.isValid = false; },
      goto: async () => {},
      pickupMs: 0,
    });
    assert.equal(r.kills, 2);
    assert.deepEqual(calls.attack, ['cow', 'chicken']);        // la plus proche d'abord
  });

  it('aucune proie à portée → {ok:false, kills:0} sans attaque', async () => {
    const { bot, calls } = huntBot({ preys: [prey('cow', { x: 100, y: 64, z: 0 })] }); // hors 32
    const r = await huntPassive(bot, { count: 1 }, null, { sleep: async () => {}, goto: async () => {}, pickupMs: 0 });
    assert.equal(r.ok, false);
    assert.equal(calls.attack.length, 0);
  });

  it('proie qui survit au timeout → stop PROPRE avec les kills déjà faits (pas de boucle infinie)', async () => {
    const tough = prey('cow', { x: 5, y: 64, z: 0 });
    const { bot } = huntBot({ preys: [tough] });
    const r = await huntPassive(bot, { count: 3 }, null, {
      sleep: async () => {}, goto: async () => {}, pickupMs: 0, killTimeoutMs: 1,
    });
    assert.equal(r.ok, false);                                  // 0 kill, sortie propre
    assert.equal(r.kills, 0);
  });

  it('token annulé en cours → sort sans bloquer', async () => {
    const pig = prey('pig', { x: 5, y: 64, z: 0 });
    const { bot } = huntBot({ preys: [pig] });
    const token = { cancelled: false };
    const r = await huntPassive(bot, { count: 5 }, token, {
      sleep: async () => { token.cancelled = true; },
      goto: async () => {}, pickupMs: 0,
    });
    assert.ok(r.kills <= 1);
  });
});
