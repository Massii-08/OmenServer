'use strict';
// #7 retours live : montée en pilier — saut puis pose du bloc sous les pieds À L'APEX du saut.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { Vec3 } = require('vec3');
const { pillarUp, waitForApex, SCAFFOLD } = require('../skills/pillarUp');

// Fake bot physique : le saut donne vy=0.42, chaque poll de waitForApex fait retomber vy de 0.12
// (gravité simulée). La pose à l'apex remonte le bot d'un bloc (comme le vrai pillaring).
function jumpBot({ inventory = ['cobblestone'], solidBelow = true } = {}) {
  const placeCalls = [];
  const bot = {
    entity: { position: new Vec3(0.5, 64, 0.5), velocity: new Vec3(0, 0, 0), yaw: 0 },
    controls: {},
    inventory: { items: () => inventory.map((n) => ({ name: n, count: 64 })) },
    setControlState(c, v) {
      this.controls[c] = v;
      if (c === 'jump' && v) this.entity.velocity = new Vec3(0, 0.42, 0); // impulsion de saut
    },
    blockAt(p) {
      const fy = Math.floor(p.y);
      const feetY = Math.floor(this.entity.position.y);
      if (fy === feetY - 1) {
        if (!solidBelow) return { name: 'air', boundingBox: 'empty', position: new Vec3(0, fy, 0) };
        return { name: 'stone', boundingBox: 'block', position: new Vec3(0, fy, 0) };
      }
      // l'ancienne case des pieds : un bloc s'y trouve si on vient d'y poser
      const k = `${Math.floor(p.x)},${fy},${Math.floor(p.z)}`;
      if (bot._placedAt && bot._placedAt.has(k)) return { name: 'cobblestone', boundingBox: 'block', position: new Vec3(p.x, fy, p.z) };
      return { name: 'air', boundingBox: 'empty', position: new Vec3(p.x, fy, p.z) };
    },
    _placedAt: new Set(),
    lookAt: async () => {},
    equip: async () => {},
    placeBlock: async (ref, face) => {
      placeCalls.push({ ref, face, vyAtPlace: bot.entity.velocity.y });
      const p = ref.position.plus(face);
      bot._placedAt.add(`${Math.floor(bot.entity.position.x)},${Math.floor(p.y)},${Math.floor(bot.entity.position.z)}`);
      bot.entity.position = bot.entity.position.offset(0, 1, 0); // retombe sur le nouveau bloc
      bot.entity.velocity = new Vec3(0, 0, 0);
    },
    _placeCalls: placeCalls,
  };
  // gravité simulée à chaque sleep de poll
  bot._sleep = async () => {
    const vy = bot.entity.velocity.y;
    if (vy !== 0) bot.entity.velocity = new Vec3(0, Math.max(vy - 0.12, -0.3), 0);
  };
  return bot;
}

describe('waitForApex', () => {
  it('détecte le sommet : vy monte puis repasse sous 0.05', async () => {
    const bot = jumpBot();
    bot.setControlState('jump', true);
    const apex = await waitForApex(bot, { sleep: bot._sleep, timeoutMs: 5000 });
    assert.equal(apex, true);
    assert.ok(bot.entity.velocity.y <= 0.05, `vy=${bot.entity.velocity.y} : pas l'apex`);
  });

  it('borné : pas de saut → false au timeout (jamais de boucle infinie)', async () => {
    const bot = jumpBot();
    const apex = await waitForApex(bot, { sleep: async () => {}, timeoutMs: 1 });
    assert.equal(apex, false);
  });
});

describe('pillarUp (#7)', () => {
  it('pose le bloc sous les pieds À L\'APEX (vy ≈ 0, jamais en pleine montée)', async () => {
    const bot = jumpBot();
    const r = await pillarUp(bot, { height: 1 }, null, { sleep: bot._sleep });
    assert.equal(r.ok, true);
    assert.equal(r.placed, 1);
    assert.equal(bot._placeCalls.length, 1);
    const call = bot._placeCalls[0];
    assert.ok(call.vyAtPlace <= 0.05, `posé à vy=${call.vyAtPlace} — trop tôt (avant l'apex)`);
    assert.deepEqual([call.face.x, call.face.y, call.face.z], [0, 1, 0]); // face supérieure
    assert.equal(call.ref.boundingBox, 'block');                          // #6 : référence pleine
    assert.equal(bot.controls.jump, false);                               // contrôles relâchés
  });

  it('monte de N blocs (le bot gagne N de hauteur)', async () => {
    const bot = jumpBot();
    const y0 = bot.entity.position.y;
    const r = await pillarUp(bot, { height: 3 }, null, { sleep: bot._sleep });
    assert.equal(r.ok, true);
    assert.equal(r.placed, 3);
    assert.equal(bot.entity.position.y, y0 + 3);
  });

  it('#6 : refuse de poser sans support PLEIN sous les pieds', async () => {
    const bot = jumpBot({ solidBelow: false });
    const r = await pillarUp(bot, { height: 1 }, null, { sleep: bot._sleep });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'no_support');
    assert.equal(bot._placeCalls.length, 0);
  });

  it('sans bloc de pilier en poche → no_blocks (rien tenté)', async () => {
    const bot = jumpBot({ inventory: ['stick'] });
    const r = await pillarUp(bot, { height: 1 }, null, { sleep: bot._sleep });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'no_blocks');
  });

  it('token annulé → stop propre', async () => {
    const bot = jumpBot();
    const r = await pillarUp(bot, { height: 5 }, { cancelled: true }, { sleep: bot._sleep });
    assert.equal(r.placed, 0);
    assert.equal(r.cancelled, true);
  });

  it('SCAFFOLD : cobblestone et dirt en font partie, pas la crafting_table', () => {
    assert.ok(SCAFFOLD.includes('cobblestone'));
    assert.ok(SCAFFOLD.includes('dirt'));
    assert.ok(!SCAFFOLD.includes('crafting_table'));
  });
});
