'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { huntPassive } = require('./hunt');

const at = (x) => ({ x, y: 64, z: 0, distanceTo(o) { return Math.abs(this.x - o.x); } });
function fakeBot(entities) {
  const attacked = [];
  return {
    attacked,
    entity: { position: at(0) },
    nearestEntity: (f) => entities.filter(f).sort((a, b) => Math.abs(a.position.x) - Math.abs(b.position.x))[0] || null,
    equip: async () => {},
    pvp: { attack: (e) => { attacked.push(e.name); e.isValid = false; }, stop() {} },
  };
}

test('huntPassive names:[sheep] : ignore la vache plus proche, tue le mouton (laine du lit)', async () => {
  const bot = fakeBot([{ name: 'cow', position: at(3), isValid: true }, { name: 'sheep', position: at(10), isValid: true }]);
  const r = await huntPassive(bot, { count: 1, maxDistance: 32, names: ['sheep'] }, null, { sleep: async () => {}, goto: async () => {}, pickupMs: 0 });
  assert.deepStrictEqual(bot.attacked, ['sheep']);
  assert.strictEqual(r.kills, 1);
});

test('huntPassive sans names : comportement historique (le passif le plus proche)', async () => {
  const bot = fakeBot([{ name: 'cow', position: at(3), isValid: true }, { name: 'sheep', position: at(10), isValid: true }]);
  await huntPassive(bot, { count: 1 }, null, { sleep: async () => {}, goto: async () => {}, pickupMs: 0 });
  assert.deepStrictEqual(bot.attacked, ['cow']);
});

test('huntPassive names:[sheep] : mouton hors rayon → 0 kill', async () => {
  const bot = fakeBot([{ name: 'sheep', position: at(60), isValid: true }]);
  const r = await huntPassive(bot, { count: 1, maxDistance: 48, names: ['sheep'] }, null, { sleep: async () => {} });
  assert.strictEqual(r.kills, 0);
});

test('huntPassive : bête injoignable (approche ratée) → écartée, on chasse la suivante', async () => {
  const cow = { name: 'cow', position: at(5), isValid: true };
  const pig = { name: 'pig', position: at(40), isValid: true };
  const bot = fakeBot([cow, pig]);
  const tried = [];
  const r = await huntPassive(bot, { count: 1, maxDistance: 96 }, null, {
    sleep: async () => {}, goto: async () => {}, pickupMs: 0,
    approach: async (e) => { tried.push(e.name); return e.name === 'pig'; },
  });
  assert.deepStrictEqual(tried, ['cow', 'pig']);
  assert.deepStrictEqual(bot.attacked, ['pig']);
  assert.deepStrictEqual(r, { ok: true, kills: 1, fails: 1 });
});

test('huntPassive : une bête à 40 blocs est chassée (portée 96), une à 120 ignorée', async () => {
  const bot = fakeBot([{ name: 'cow', position: at(40), isValid: true }]);
  const r = await huntPassive(bot, { count: 1, maxDistance: 96 }, null, { sleep: async () => {}, goto: async () => {}, pickupMs: 0, approach: async () => true });
  assert.strictEqual(r.kills, 1);
  const far = fakeBot([{ name: 'cow', position: at(120), isValid: true }]);
  const r2 = await huntPassive(far, { count: 1, maxDistance: 96 }, null, { sleep: async () => {}, approach: async () => true });
  assert.strictEqual(r2.kills, 0);
});

test('huntPassive : une bête qui fuit (pas tuée) est écartée, pas toute la sortie ; maxFails borne', async () => {
  const bot = fakeBot([
    { name: 'cow', position: at(3), isValid: true },
    { name: 'cow', position: at(6), isValid: true },
    { name: 'cow', position: at(9), isValid: true },
  ]);
  bot.pvp.attack = (e) => { bot.attacked.push(e.position.x); };   // jamais tuée
  const r = await huntPassive(bot, { count: 3, maxDistance: 96, maxFails: 2 }, null, {
    sleep: async () => {}, approach: async () => true, killTimeoutMs: 1,
  });
  assert.deepStrictEqual(bot.attacked, [3, 6], 'deux bêtes tentées, puis on s arrête');
  assert.deepStrictEqual(r, { ok: false, kills: 0, fails: 2 });
});

test('huntPassive : enchaîne les bêtes proches jusqu à count', async () => {
  const bot = fakeBot([{ name: 'pig', position: at(3), isValid: true }, { name: 'pig', position: at(8), isValid: true }, { name: 'sheep', position: at(12), isValid: true }]);
  const r = await huntPassive(bot, { count: 3, maxDistance: 96 }, null, { sleep: async () => {}, goto: async () => {}, pickupMs: 0, approach: async () => true });
  assert.strictEqual(r.kills, 3);
});

test('huntPassive : jeton coupé pendant l approche → arrêt propre, aucune attaque', async () => {
  const bot = fakeBot([{ name: 'pig', position: at(30), isValid: true }]);
  const token = { cancelled: false };
  const r = await huntPassive(bot, { count: 1, maxDistance: 96 }, token, { sleep: async () => {}, approach: async () => { token.cancelled = true; return true; } });
  assert.deepStrictEqual(bot.attacked, []);
  assert.strictEqual(r.kills, 0);
});

test('huntPassive : approche par défaut sans pathfinder → comportement historique (pvp suit)', async () => {
  const bot = fakeBot([{ name: 'pig', position: at(30), isValid: true }]);
  const r = await huntPassive(bot, { count: 1, maxDistance: 96 }, null, { sleep: async () => {}, goto: async () => {}, pickupMs: 0 });
  assert.strictEqual(r.kills, 1);
});

test('huntPassive : approche par défaut — un goto qui « réussit » sans rapprocher ne tourne pas en boucle', async () => {
  const bot = fakeBot([{ name: 'pig', position: at(50), isValid: true }]);
  let gotos = 0;
  bot.pathfinder = { goto: async () => { gotos++; }, setGoal() {} };
  const r = await huntPassive(bot, { count: 1, maxDistance: 96, maxFails: 1 }, null, { sleep: async () => {} });
  assert.strictEqual(gotos, 2);
  assert.strictEqual(r.kills, 0);
});

test('huntPassive : approche par défaut — la marche rapproche → attaque une fois à portée', async () => {
  const pig = { name: 'pig', position: at(50), isValid: true };
  const bot = fakeBot([pig]);
  bot.pathfinder = { goto: async () => { pig.position = at(pig.position.x - 20); }, setGoal() {} };
  const r = await huntPassive(bot, { count: 1, maxDistance: 96 }, null, { sleep: async () => {}, goto: async () => {}, pickupMs: 0 });
  assert.deepStrictEqual(bot.attacked, ['pig']);
  assert.strictEqual(r.kills, 1);
});

test('huntPassive : approche par défaut — NoPath répété sans se rapprocher → bête écartée', async () => {
  const bot = fakeBot([{ name: 'pig', position: at(30), isValid: true }]);
  let gotos = 0;
  bot.pathfinder = { goto: () => { gotos++; return Promise.reject(new Error('NoPath')); }, setGoal() {} };
  const r = await huntPassive(bot, { count: 1, maxDistance: 96, maxFails: 1 }, null, { sleep: async () => {} });
  assert.strictEqual(gotos, 2);
  assert.deepStrictEqual(bot.attacked, []);
  assert.deepStrictEqual(r, { ok: false, kills: 0, fails: 1 });
});

// ─── Comptage honnête (25/10 : kills:4, got:0) ──────────────────────────────────────────────────
const { EventEmitter } = require('events');
const { preyOutcome } = require('./hunt');

function trackedBot(entities, { dies = true, drop = 'beef' } = {}) {
  const bot = Object.assign(new EventEmitter(), fakeBot(entities));
  const items = [];
  bot.inventory = { items: () => items.slice() };
  bot.pvp.attack = (e) => {
    bot.attacked.push(e.name);
    if (dies) { bot.emit('entityDead', e); if (drop) items.push({ name: drop, count: 1 }); }
    e.isValid = false;                      // mort OU sortie de portée de suivi : même symptôme
  };
  return bot;
}

test('preyOutcome : PUR — mort vue ou nourriture gagnée = kill ; sinon perdue', () => {
  assert.strictEqual(preyOutcome({ tracked: false }), 'kill', 'historique sans événements');
  assert.strictEqual(preyOutcome({ tracked: true, died: true, foodBefore: 0, foodAfter: 0 }), 'kill');
  assert.strictEqual(preyOutcome({ tracked: true, died: false, foodBefore: 1, foodAfter: 3 }), 'kill');
  assert.strictEqual(preyOutcome({ tracked: true, died: false, foodBefore: 2, foodAfter: 2 }), 'lost');
});

test('huntPassive : proie qui devient invalide SANS mourir (sortie de portée) → pas un kill, comptée perdue', async () => {
  const bot = trackedBot([{ name: 'cow', position: at(5), isValid: true }], { dies: false });
  let gotos = 0;
  const r = await huntPassive(bot, { count: 1, maxDistance: 96, maxFails: 1 }, null, { sleep: async () => {}, goto: async () => { gotos++; }, pickupMs: 0, approach: async () => true });
  assert.deepStrictEqual(r, { ok: false, kills: 0, fails: 1, lost: 1 });
  assert.strictEqual(gotos, 0, 'pas de ramassage : rien n est tombé');
  assert.strictEqual(bot.listenerCount('entityDead'), 0, 'écouteur retiré');
});

test('huntPassive : mort vue → kill, même forme de retour qu avant', async () => {
  const bot = trackedBot([{ name: 'cow', position: at(5), isValid: true }]);
  const r = await huntPassive(bot, { count: 1, maxDistance: 96 }, null, { sleep: async () => {}, goto: async () => {}, pickupMs: 0, approach: async () => true });
  assert.deepStrictEqual(r, { ok: true, kills: 1, fails: 0 });
  assert.strictEqual(bot.listenerCount('entityDead'), 0);
});
