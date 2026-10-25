'use strict';
// SORTIE SÛRE (fix 20/10) : 9 morts juste après `shelter:out` en 1 h. Un bot armé sortait face à
// 5 zombies, la borne de 60-120 s tombait avec 1-3 hostiles encore là, un creeper calme à 6-10 blocs ne
// comptait pas. Règle opt-in (`deps.exitThreats`) : heure ∈ [0, 11500], aucun hostile en vue à ≤ 16,
// aucun creeper à ≤ 10 ; sinon tranches de 10 s, borne 180 s ; armé ou nu, même règle.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const SH = require('../skills/shelter');

function harness(over = {}) {
  const events = [];
  const sleeps = [];
  const deps = {
    emit: (e) => events.push(e),
    sleep: async (ms) => { sleeps.push(ms); },
    mineDown: async () => ({ ok: false, reason: 'void_below' }),
    wallIn: async () => ({ ok: true, placed: 4 }),
    ...over,
  };
  const bot = {
    time: { timeOfDay: 1000 },
    entity: { position: { floored: () => ({ x: 0, y: 64, z: 0, offset: () => ({ x: 0, y: 66, z: 0 }), plus: () => ({ x: 1, y: 64, z: 0 }) }) } },
    inventory: { items: () => [] },
    blockAt: () => null,
    dig: async () => {}, equip: async () => {}, placeBlock: async () => {},
  };
  return { bot, deps, events, sleeps };
}
const actions = (events) => events.map((e) => e.action);

describe('dawnExitPlan (pur)', () => {
  it('jour franc + personne → go clear ; aube (23500) ou crépuscule (12000) → wait dark', () => {
    assert.deepEqual(SH.dawnExitPlan({ hostiles: 0, creepers: 0, timeOfDay: 500, waitedMs: 0 }), { act: 'go', reason: 'clear' });
    assert.deepEqual(SH.dawnExitPlan({ timeOfDay: 23500 }), { act: 'wait', reason: 'dark' });
    assert.deepEqual(SH.dawnExitPlan({ timeOfDay: 12000 }), { act: 'wait', reason: 'dark' });
    assert.deepEqual(SH.dawnExitPlan({ timeOfDay: 11500 }), { act: 'go', reason: 'clear' });
    assert.deepEqual(SH.dawnExitPlan({ timeOfDay: 24000 + 100 }), { act: 'go', reason: 'clear' }, 'wrap 24000');
  });
  it('creeper à ≤ 10 → wait creeper ; hostile en vue → wait hostiles ; heure inconnue = ignorée', () => {
    assert.deepEqual(SH.dawnExitPlan({ creepers: 1, hostiles: 0, timeOfDay: 1000 }), { act: 'wait', reason: 'creeper' });
    assert.deepEqual(SH.dawnExitPlan({ creepers: 0, hostiles: 2 }), { act: 'wait', reason: 'hostiles' });
    assert.deepEqual(SH.dawnExitPlan({}), { act: 'go', reason: 'clear' });
    assert.deepEqual(SH.dawnExitPlan(null), { act: 'go', reason: 'clear' });
  });
  it('borne 180 s : au-delà on sort quand même, quoi qu il y ait dehors', () => {
    assert.equal(SH.DAWN_SAFE_EXIT_MAX_MS, 180000);
    assert.equal(SH.DAWN_SAFE_CHECK_MS, 10000);
    assert.equal(SH.dawnExitPlan({ hostiles: 3, creepers: 1, timeOfDay: 23500, waitedMs: 179999 }).act, 'wait');
    assert.deepEqual(SH.dawnExitPlan({ hostiles: 3, creepers: 1, timeOfDay: 23500, waitedMs: 180000 }), { act: 'go', reason: 'timeout' });
  });
});

describe('abri : sortie sûre (deps.exitThreats)', () => {
  it('ARMÉ face à des zombies → attend aussi (l ancienne règle le laissait sortir) ; tranches de 10 s ; sort dégagé + onExit', async () => {
    let reads = 0; let exited = 0;
    const { bot, deps, events, sleeps } = harness({
      hostilesNear: () => 5, worn: () => 4,
      exitThreats: () => (++reads <= 3 ? { hostiles: 5, creepers: 0 } : { hostiles: 0, creepers: 0 }),
      onExit: () => { exited++; },
    });
    const r = await SH.shelterUntilDawn(bot, null, deps);
    assert.equal(r.ok, true);
    assert.deepEqual(sleeps, [10000, 10000, 10000]);
    const hold = events.filter((e) => e.type === 'dawn_hold');
    assert.equal(hold.length, 1, 'un dawn_hold par changement de raison');
    assert.equal(hold[0].reason, 'hostiles');
    const w = events.find((e) => e.action === 'dawn_wait');
    assert.equal(w.reason, 'clear');
    assert.equal(w.waited_s, 30);
    assert.equal(exited, 1, 'onExit appelé une fois, après la sortie');
    const order = actions(events);
    assert.ok(order.indexOf('dawn_wait') < order.indexOf('out'));
  });

  it('aube encore sombre puis creeper → deux dawn_hold (dark, creeper), sort au jour franc', async () => {
    let step = 0;
    const h = harness({});
    h.deps.exitThreats = () => { step++; if (step === 2) h.bot.time.timeOfDay = 200; return { hostiles: 0, creepers: step === 2 ? 1 : 0 }; };
    h.bot.time.timeOfDay = 23400;
    await SH.shelterUntilDawn(h.bot, null, h.deps);
    assert.deepEqual(h.events.filter((e) => e.type === 'dawn_hold').map((e) => e.reason), ['dark', 'creeper']);
    assert.ok(actions(h.events).includes('out'));
  });

  it('les monstres ne partent jamais → 180 s / 10 s = 18 relevés, puis sortie (timeout) ; relevé qui lève = 0', async () => {
    const { bot, deps, events, sleeps } = harness({ exitThreats: () => ({ hostiles: 2, creepers: 0 }) });
    await SH.shelterUntilDawn(bot, null, deps);
    assert.equal(sleeps.length, 18);
    assert.equal(events.find((e) => e.action === 'dawn_wait').reason, 'timeout');
    const h2 = harness({ exitThreats: () => { throw new Error('x'); } });
    await SH.shelterUntilDawn(h2.bot, null, h2.deps);
    assert.deepEqual(h2.sleeps, [], 'erreur de lecture : jamais coincé');
  });

  it('borne injectée (abri de menace de jour) respectée', async () => {
    const { bot, deps, sleeps } = harness({ exitThreats: () => ({ hostiles: 1, creepers: 0 }), dawnWaitMaxMs: 30000 });
    await SH.shelterUntilDawn(bot, null, deps);
    assert.equal(sleeps.length, 3);
  });
});

// BORNE EXPIRÉE, MONSTRE AU CONTACT (25/10 : `dawn_wait timeout hostiles_left:1` → mort 7 s après).
describe('dawnExitPlan : prolonger quand un hostile est à ≤ 12 blocs (PUR)', () => {
  it('borne passée + close>0 → wait close jusqu à la borne dure (déf. +240 s), puis timeout', () => {
    assert.equal(SH.DAWN_CLOSE_BLOCKS, 12);
    assert.equal(SH.DAWN_CLOSE_EXTRA_MS, 240000);
    assert.deepEqual(SH.dawnExitPlan({ hostiles: 1, close: 1, timeOfDay: 1000, waitedMs: 180000 }), { act: 'wait', reason: 'close' });
    assert.deepEqual(SH.dawnExitPlan({ hostiles: 1, close: 1, timeOfDay: 1000, waitedMs: 419999 }), { act: 'wait', reason: 'close' });
    assert.deepEqual(SH.dawnExitPlan({ hostiles: 1, close: 1, timeOfDay: 1000, waitedMs: 420000 }), { act: 'go', reason: 'timeout' });
    assert.deepEqual(SH.dawnExitPlan({ hostiles: 1, close: 1, waitedMs: 60000, maxMs: 60000, hardMaxMs: 90000 }), { act: 'wait', reason: 'close' });
  });
  it('borne passée, hostile LOIN (close 0) → sortie comme avant', () => {
    assert.deepEqual(SH.dawnExitPlan({ hostiles: 2, close: 0, waitedMs: 180000 }), { act: 'go', reason: 'timeout' });
  });
  it('dans l abri : zombie collé à la porte → reste au-delà de la borne, sort à la borne dure', async () => {
    const { bot, deps, events } = harness({
      exitThreats: () => ({ hostiles: 1, creepers: 0, close: 1 }), dawnWaitMaxMs: 30000,
    });
    await SH.shelterUntilDawn(bot, null, deps);
    const w = events.find((e) => e.action === 'dawn_wait');
    assert.ok(w, JSON.stringify(events));
    assert.equal(w.reason, 'timeout');
    assert.ok(w.waited_s >= 270, `prolongé (${w.waited_s} s)`);
    assert.ok(events.some((e) => e.type === 'dawn_hold' && e.reason === 'close'));
  });
});

describe('crépuscule : abri du bot NU (PUR)', () => {
  it('isDuskTime = [12000, 12800)', () => {
    assert.equal(SH.isDuskTime(11999), false);
    assert.equal(SH.isDuskTime(12000), true);
    assert.equal(SH.isDuskTime(12799), true);
    assert.equal(SH.isDuskTime(12800), false);
    assert.equal(SH.isDuskTime(null), false);
    assert.equal(SH.isDuskTime(24000 + 12100), true);
  });
  it('shouldShelter : crépuscule + nu → dusk ; armé → rien ; sous terre → rien', () => {
    assert.deepEqual(SH.shouldShelter({ dusk: true, naked: true }), { shelter: true, reason: 'dusk' });
    assert.equal(SH.shouldShelter({ dusk: true, naked: false }).shelter, false);
    assert.equal(SH.shouldShelter({ dusk: true, naked: true, underground: true }).shelter, false);
  });
  it('soilRank : terre 0, meuble 1, reste 2', () => {
    assert.equal(SH.soilRank('grass_block'), 0);
    assert.equal(SH.soilRank('dirt'), 0);
    assert.equal(SH.soilRank('sand'), 1);
    assert.equal(SH.soilRank('gravel'), 1);
    assert.equal(SH.soilRank('oak_log'), 2);
    assert.equal(SH.soilRank(undefined), 2);
  });
});
