'use strict';
// `bot.dig` qui ne rend JAMAIS la main (live 21/10, NethBot3 session 48 : téléport /home safe 29 ms
// après le début du creusage de l'abri → 10+ min de gel). digBound + l'abri doivent en sortir.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { Vec3 } = require('vec3');
const { boundedDig, bounded } = require('../digBound');
const { shelterUntilDawn } = require('../skills/shelter');

function hangingBot() {
  const bot = new EventEmitter();
  bot.digs = 0;
  bot.stops = 0;
  bot.dig = () => { bot.digs++; bot.targetDigBlock = {}; return new Promise(() => {}); };   // jamais résolu
  bot.stopDigging = () => { bot.stops++; bot.targetDigBlock = null; };
  return bot;
}

describe('boundedDig', () => {
  it('rend la main à la borne et coupe le creusage', async () => {
    const bot = hangingBot();
    const t0 = Date.now();
    const r = await boundedDig(bot, { position: new Vec3(0, 0, 0) }, { timeoutMs: 40 });
    assert.deepEqual(r, { ok: false, reason: 'timeout' });
    assert.ok(Date.now() - t0 < 1000);
    assert.equal(bot.stops, 1);
    assert.equal(bot.listenerCount('forcedMove'), 0);
  });
  it('abandonne au TÉLÉPORT (forcedMove) sans attendre la borne', async () => {
    const bot = hangingBot();
    setTimeout(() => bot.emit('forcedMove'), 10);
    const t0 = Date.now();
    const r = await boundedDig(bot, { position: new Vec3(0, 0, 0) }, { timeoutMs: 15000 });
    assert.equal(r.reason, 'teleported');
    assert.ok(Date.now() - t0 < 1000);
    assert.equal(bot.stops, 1);
  });
  it('abandonne quand le jeton est annulé', async () => {
    const bot = hangingBot();
    const token = { cancelled: false };
    setTimeout(() => { token.cancelled = true; }, 10);
    const r = await boundedDig(bot, { position: new Vec3(0, 0, 0) }, { timeoutMs: 15000, token, pollMs: 5 });
    assert.equal(r.reason, 'cancelled');
    assert.equal(bot.stops, 1);
  });
  it('creusage normal : ok, aucun stopDigging, écouteur retiré', async () => {
    const bot = new EventEmitter();
    let stops = 0;
    bot.dig = async () => {};
    bot.stopDigging = () => { stops++; };
    const r = await boundedDig(bot, { position: new Vec3(0, 0, 0) }, { timeoutMs: 1000 });
    assert.deepEqual(r, { ok: true });
    assert.equal(stops, 0);
    assert.equal(bot.listenerCount('forcedMove'), 0);
  });
  it('bounded : valeur, erreur et borne sans throw', async () => {
    assert.deepEqual(await bounded(Promise.resolve(3), 50), { ok: true, value: 3 });
    assert.deepEqual(await bounded(Promise.reject(new Error('x')), 50), { ok: false, reason: 'error' });
    assert.deepEqual(await bounded(new Promise(() => {}), 20), { ok: false, reason: 'timeout' });
  });
});

/** Monde plat (herbe y=63) où `bot.dig` ne rend JAMAIS la main — le cas live. */
function frozenWorld({ night = false } = {}) {
  const bot = hangingBot();
  bot.time = { timeOfDay: night ? 18000 : 6000, day: 3 };
  bot.entity = { position: new Vec3(0.5, 64, 0.5), onGround: true, velocity: new Vec3(0, 0, 0) };
  bot.inventory = { items: () => [], slots: [] };
  bot.equip = async () => {};
  bot.blockAt = (p) => {
    const y = Math.floor(p.y);
    const name = y > 63 ? 'air' : (y === 63 ? 'grass_block' : 'dirt');
    return { name, boundingBox: name === 'air' ? 'empty' : 'block', position: new Vec3(Math.floor(p.x), y, Math.floor(p.z)) };
  };
  bot.placeBlock = async () => { throw new Error('no'); };
  bot.lookAt = async () => {}; bot.setControlState = () => {}; bot.clearControlStates = () => {};
  return bot;
}

describe('abri : un creusage qui ne rend jamais la main ne gèle plus l\'abri', () => {
  it('borne de coup → plan B → fin de l\'abri, en temps borné', async () => {
    const bot = frozenWorld();
    const events = [];
    const t0 = Date.now();
    const res = await shelterUntilDawn(bot, { cancelled: false }, {
      emit: (e) => events.push(e), sleep: async () => {},
      digTimeoutMs: 30, stageTimeoutMs: 500,
      wallIn: async () => ({ ok: false }),
    });
    assert.ok(Date.now() - t0 < 3000, 'abri sorti en ' + (Date.now() - t0) + ' ms');
    assert.equal(res.ok, false);
    assert.ok(bot.digs >= 1);
    assert.ok(bot.stops >= 1, 'stopDigging appelé');
    assert.ok(events.some((e) => e.type === 'shelter' && e.action === 'sealed'), 'la ligne `sealed` sort');
  });
  it('téléport pendant le creusage (le cas live) → sortie immédiate, sans attendre 15 s', async () => {
    const bot = frozenWorld();
    const events = [];
    setTimeout(() => { bot.entity.position = new Vec3(267.5, 58, 341.5); bot.emit('forcedMove'); }, 15);
    const t0 = Date.now();
    await shelterUntilDawn(bot, { cancelled: false }, {
      emit: (e) => events.push(e), sleep: async () => {}, wallIn: async () => ({ ok: false }),
    });
    assert.ok(Date.now() - t0 < 3000, 'abri sorti en ' + (Date.now() - t0) + ' ms');
    assert.ok(events.some((e) => e.type === 'shelter' && e.action === 'sealed'));
  });
  it('annulation du jeton pendant un creusage gelé → cancelled', async () => {
    const bot = frozenWorld();
    const token = { cancelled: false };
    setTimeout(() => { token.cancelled = true; }, 20);
    const res = await shelterUntilDawn(bot, token, {
      emit: () => {}, sleep: async () => {}, wallIn: async () => ({ ok: false }),
    });
    assert.equal(res.ok, false);
    assert.equal(res.reason, 'cancelled');
  });
});

describe('mineDown digTimeoutMs', () => {
  const { mineDown } = require('../skills/mineDown');
  it('coup gelé → dig_failed borné (why: timeout), creusage coupé', async () => {
    const bot = frozenWorld();
    const t0 = Date.now();
    const r = await mineDown(bot, { count: 3, digTimeoutMs: 30 });
    assert.ok(Date.now() - t0 < 1000);
    assert.equal(r.reason, 'dig_failed');
    assert.equal(r.why, 'timeout');
    assert.equal(bot.stops, 1);
  });
  it('sans digTimeoutMs : contrat d origine (bot.dig nu)', async () => {
    const bot = frozenWorld();
    let n = 0;
    bot.dig = async () => { n++; };
    bot.entity.onGround = true;
    const r = await mineDown(bot, { count: 2 });
    assert.equal(r.ok, true);
    assert.equal(n, 2);
  });
});
