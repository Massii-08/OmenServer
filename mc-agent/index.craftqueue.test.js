'use strict';
// CÂBLAGE de la file de craft (fix 20/10). Mesuré (NethBot2, session 278) : t1_sword craft_failed ×2 +
// craft_no_effect ×2 et crafting_table craft_no_effect, tous en plein combat ou juste après un /tpa de
// squad tiré pendant le craft. On exécute le VRAI texte de craftSmart / craftCombatNow /
// craftMatterSummary dans un bac à sable `vm` strict (piège #56 : un identifiant hors niveau module lève ici).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { isFleeHostile } = require('./skills/fleeFrom');
const { NEUTRAL_NO_PROVOKE } = require('./survival');
const homewarp = require('./homewarp');
const { FOODS, EMERGENCY_FOODS } = require('./reflexes');
const lowhp = require('./lowhp');

const SRC = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');
function grab(re, label) {
  const m = SRC.match(re);
  assert.ok(m, `${label} introuvable dans index.js (déplacé, renommé, ou déclaré hors niveau module ?)`);
  return m[0];
}
const fnSrc = (name) => grab(new RegExp(`^(?:async )?function ${name}\\([^)]*\\) \\{[\\s\\S]*?^\\}$`, 'm'), `function ${name}`);
const constSrc = (name) => grab(new RegExp(`^const ${name} = [^;]+;`, 'm'), `const ${name}`);
const letSrc = (name) => grab(new RegExp(`^let ${name} = [^;]+;`, 'm'), `let ${name}`);
const run = (sb, code) => vm.runInContext("'use strict';\n" + code, sb);

const zombie = (dx) => ({ name: 'zombie', kind: 'Hostile mobs', position: { x: dx, y: 70, z: 0 }, isValid: true });

function sandbox({ entities = [], raw } = {}) {
  const clock = { t: 0 };
  const sb = {
    events: [], log: [], clock,
    _auraEmit(type, payload) { sb.events.push(Object.assign({ type }, payload)); },
    Date: { now: () => clock.t },
    sleep: async (ms) => { clock.t += ms; },
    setTimeout, clearTimeout, Promise,
    isFleeHostile, NEUTRAL_NO_PROVOKE, homewarp, FOODS, EMERGENCY_FOODS,
    craftBlockedAtLowHp: lowhp.craftBlockedAtLowHp, LOWHP_FOOD_RUN_TTL_MS: lowhp.LOWHP_FOOD_RUN_TTL_MS,
    bot: {
      entity: { position: { x: 0, y: 70, z: 0 } },
      entities: Object.fromEntries(entities.map((e, i) => [i, e])),
      pvp: { target: null },
      health: 20,
      inventory: { items: () => [{ name: 'birch_planks', count: 1 }, { name: 'acacia_planks', count: 1 }, { name: 'dirt', count: 5 }], emptySlotCount: () => 0 },
    },
    _craftSmartRaw: raw || (async (a) => { sb.log.push('start:' + a.name); await Promise.resolve(); sb.log.push('end:' + a.name); return { ok: true }; }),
  };
  vm.createContext(sb);
  for (const c of ['CRAFT_QUEUE_MAX_WAIT_MS', 'CRAFT_COMBAT_WAIT_MS', 'CRAFT_COMBAT_RADIUS']) run(sb, constSrc(c));
  for (const l of ['_craftTail', '_craftDepth', '_lowHpFoodRunAt']) run(sb, letSrc(l));
  for (const f of ['craftCombatNow', 'craftMatterSummary', 'lowHpSignals', 'craftLowHpBlocked', 'craftSmart']) run(sb, fnSrc(f));
  return sb;
}

test('craftSmart : deux crafts concurrents (planner + filet à minuterie) sont SÉRIALISÉS', async () => {
  let releaseA;
  const sb = sandbox({
    raw: async (a) => {
      sb.log.push('start:' + a.name + ':' + run(sb, '_craftDepth'));
      if (a.name === 'A') await new Promise((r) => { releaseA = r; });
      sb.log.push('end:' + a.name);
      return { ok: true };
    },
  });
  const pa = run(sb, "craftSmart({ name: 'A' })");
  const pb = run(sb, "craftSmart({ name: 'B' })");
  await new Promise((r) => setImmediate(r));
  assert.deepStrictEqual(sb.log, ['start:A:1'], 'B attend la fin de A');
  releaseA();
  await pa; await pb;
  assert.deepStrictEqual(sb.log, ['start:A:1', 'end:A', 'start:B:1', 'end:B']);
  assert.strictEqual(run(sb, '_craftDepth'), 0);
});

test('craftSmart : zombie à 3 blocs → attend (borné 8 s) puis crafte + craft_deferred ; zombie à 9 → crafte tout de suite', async () => {
  const sb = sandbox({ entities: [zombie(3)] });
  const r = await run(sb, "craftSmart({ name: 'stone_sword' })");
  assert.strictEqual(r.ok, true);
  const ev = sb.events.find((e) => e.type === 'craft_deferred');
  assert.ok(ev && ev.name === 'stone_sword' && ev.waited_ms >= 8000 && ev.combat === true, JSON.stringify(ev));
  const sb2 = sandbox({ entities: [zombie(9)] });
  await run(sb2, "craftSmart({ name: 'stone_sword' })");
  assert.ok(!sb2.events.some((e) => e.type === 'craft_deferred'));
  assert.strictEqual(sb2.clock.t, 0);
});

test('craftSmart : combat pvp en cours → attend qu il finisse', async () => {
  const sb = sandbox({});
  sb.bot.pvp.target = { id: 9 };
  const orig = sb.sleep;
  sb.sleep = async (ms) => { await orig(ms); if (sb.clock.t >= 1500) sb.bot.pvp.target = null; };
  await run(sb, "craftSmart({ name: 'stick' })");
  const ev = sb.events.find((e) => e.type === 'craft_deferred');
  assert.ok(ev && ev.combat === false && ev.waited_ms === 1500, JSON.stringify(ev));
});

test('craftSmart : échec → craft_fail_ctx avec la matière PAR ESSENCE et les cases vides ; jamais bloqué si le craft lève', async () => {
  const sb = sandbox({ raw: async () => ({ ok: false, reason: 'no_recipe' }) });
  const r = await run(sb, "craftSmart({ name: 'stick' })");
  assert.strictEqual(r.reason, 'no_recipe');
  const ev = sb.events.find((e) => e.type === 'craft_fail_ctx');
  assert.ok(ev, 'event attendu');
  assert.deepStrictEqual({ ...ev.mat }, { birch_planks: 1, acacia_planks: 1 });
  assert.strictEqual(ev.empty, 0);
  const sb2 = sandbox({ raw: async () => { throw new Error('boom'); } });
  await assert.rejects(() => run(sb2, "craftSmart({ name: 'x' })"));
  assert.strictEqual(run(sb2, '_craftDepth'), 0, 'compteur rendu même sur exception');
  await assert.rejects(() => run(sb2, "craftSmart({ name: 'y' })"), 'la file n est pas bloquée : le craft suivant s exécute');
});

// PV CRITIQUES (fix 21/10, veille autonome, NethBot3 session-94) : craft torche déféré 2,5 s pendant
// un combat à 4,33 PV, exécuté dès que le combat redevient momentanément faux → mort ~500 ms après
// (crafter coupe l'aura, cf. test ci-dessous). Aucun craft ne doit partir à PV critiques (≤6, seuil
// homewarp.IMMINENT_HP), ni au départ, ni après un différé où les PV auraient chuté entre-temps.
test('craftSmart : PV critiques → craft SKIPPÉ (ni au départ, ni après un différé)', async () => {
  const sb = sandbox({});
  sb.bot.health = 4.5;
  const r = await run(sb, "craftSmart({ name: 'torch' })");
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'low_hp_skip');
  assert.strictEqual(sb.log.length, 0, 'le craft RAW n a jamais démarré');
  const ev = sb.events.find((e) => e.type === 'craft_skipped_low_hp');
  assert.ok(ev && ev.name === 'torch' && ev.health === 4.5, JSON.stringify(ev));
  assert.strictEqual(run(sb, '_craftDepth'), 0, 'compteur rendu même sur skip');

  // Les PV chutent à critique PENDANT le différé combat (démarre à 20, un zombie à 3 blocs force
  // l attente) : le craft ne doit PAS partir juste parce que le combat s est arrêté avant les PV.
  const sb2 = sandbox({ entities: [zombie(3)] });
  const origSleep = sb2.sleep;
  sb2.sleep = async (ms) => { await origSleep(ms); if (sb2.clock.t >= 1000) sb2.bot.health = 5; };
  const r2 = await run(sb2, "craftSmart({ name: 'torch' })");
  assert.strictEqual(r2.ok, false);
  assert.strictEqual(r2.reason, 'low_hp_skip');
  assert.strictEqual(sb2.log.length, 0);
});

test('craftSmart : PV sains → aucun impact (non-régression)', async () => {
  const sb = sandbox({});
  sb.bot.health = 20;
  const r = await run(sb, "craftSmart({ name: 'torch' })");
  assert.strictEqual(r.ok, true);
  assert.ok(!sb.events.some((e) => e.type === 'craft_skipped_low_hp'));
});

test('index.js : l aura et le /tpa de squad respectent un craft en cours', () => {
  assert.match(fnSrc('auraTick'), /if \(_craftDepth > 0\) return;/);
  assert.match(SRC, /_foodTripBusy \|\| _exploreBusy( \|\| _caveTripBusy)? \|\| _craftDepth > 0;\n  const pick = squadTarget\(/);
});

// ─── 22/10 : refus à PV critiques → RÉCUPÉRER, pas réessayer ─────────────────────────────────
test('craftSmart : PV critiques, rien à manger, sortie nourriture déjà tentée, personne en vue → le craft part', async () => {
  // Attendre ne rendrait aucun PV (faim < 18) : figer le bot ne le sauve pas, un craft sans menace ne coûte rien.
  const sb = sandbox({});
  sb.bot.health = 4.5; sb.bot.food = 13;
  sb.clock.t = 100000;
  run(sb, '_lowHpFoodRunAt = 99000');
  const r = await run(sb, "craftSmart({ name: 'crafting_table' })");
  assert.strictEqual(r.ok, true);
  assert.ok(!sb.events.some((e) => e.type === 'craft_skipped_low_hp'));
});

test('craftSmart : PV critiques + hostile à 12 blocs → toujours refusé (intention de 0990f4c)', async () => {
  const sb = sandbox({ entities: [zombie(12)] });
  sb.bot.health = 4.5; sb.bot.food = 13;
  sb.clock.t = 100000;
  run(sb, '_lowHpFoodRunAt = 99000');
  const r = await run(sb, "craftSmart({ name: 'crafting_table' })");
  assert.strictEqual(r.reason, 'low_hp_skip');
});

test('runSkillWithTelemetry : low_hp_skip → recoverLowHp + wait:true, AVANT goal_failed / noteZoneFailure', () => {
  const body = fnSrc('runSkillWithTelemetry');
  const iSkip = body.indexOf("r.reason === 'low_hp_skip'");
  const iFail = body.indexOf("type: 'goal_failed'");
  assert.ok(iSkip > 0 && iFail > 0 && iSkip < iFail, 'le refus est intercepté avant le bloc d échec');
  assert.match(body, /await recoverLowHp\(g\.name\)/);
  assert.match(body, /return \{ ok: false, reason: 'recovering', wait: true, outcome: rec\.outcome \};/);
});

// recoverLowHp exécuté pour de vrai (bac à sable) : ordre des pas et borne.
function recoverSandbox({ health = 4, food = 13, items = [], entities = [], onSleep } = {}) {
  const clock = { t: 1000 };
  const sb = {
    events: [], calls: [], clock,
    emit(ev) { sb.events.push(ev); },
    Date: { now: () => clock.t },
    sleep: async (ms) => { clock.t += ms; if (onSleep) onSleep(sb); },
    withTimeout: (p) => Promise.resolve(p),
    taskToken: { cancelled: false },
    migrationOwnsBot: () => false,
    stopMotion: () => { sb.calls.push('stopMotion'); },
    nightSeal: async () => { sb.calls.push('seal'); return 3; },
    foodRunTick: async () => { sb.calls.push('food_run'); clock.t += 20000; },
    tryEat: async (b) => { sb.calls.push('eat'); b.food = 20; b._items.length = 0; return true; },
    isFleeHostile, NEUTRAL_NO_PROVOKE, FOODS, EMERGENCY_FOODS,
    lowHpStep: lowhp.lowHpStep, LOWHP_RECOVERY_BUDGET_MS: lowhp.LOWHP_RECOVERY_BUDGET_MS, LOWHP_FOOD_RUN_TTL_MS: lowhp.LOWHP_FOOD_RUN_TTL_MS,
    bot: {
      health, food, _items: items.slice(),
      entity: { position: { x: 0, y: 70, z: 0 } },
      entities: Object.fromEntries(entities.map((e, i) => [i, e])),
      pvp: { target: null },
      stopDigging() {},
    },
  };
  sb.bot.inventory = { items: () => sb.bot._items };
  vm.createContext(sb);
  for (const l of ['_lowHpFoodRunAt', '_lowHpRecoverBusy']) run(sb, letSrc(l));
  for (const f of ['lowHpSignals', 'recoverLowHp']) run(sb, fnSrc(f));
  return sb;
}

test('recoverLowHp : de quoi manger → mange, puis attend la régénération jusqu’au-dessus du seuil', async () => {
  const sb = recoverSandbox({ items: [{ name: 'rotten_flesh', count: 3 }], onSleep: (s) => { s.bot.health += 0.5; } });
  const r = await run(sb, "recoverLowHp('furnace')");
  assert.strictEqual(r.outcome, 'healed');
  assert.deepStrictEqual(sb.calls, ['eat']);
  assert.ok(sb.bot.health > 6);
  const done = sb.events.find((e) => e.type === 'low_hp_recover_done');
  assert.ok(done && done.outcome === 'healed' && done.eats === 1, JSON.stringify(done));
  assert.strictEqual(run(sb, '_lowHpRecoverBusy'), false);
});

test('recoverLowHp : affamé, rien en poche, personne → UNE sortie nourriture puis rend la main (no_regen)', async () => {
  const sb = recoverSandbox({ health: 5.3, food: 13 });
  const r = await run(sb, "recoverLowHp('crafting_table')");
  assert.strictEqual(r.outcome, 'no_regen');
  assert.deepStrictEqual(sb.calls, ['food_run']);
});

test('recoverLowHp : hostile collé sans régénération → se mure une fois puis attend, borné à 60 s', async () => {
  const sb = recoverSandbox({ health: 3.6, food: 13, entities: [zombie(4)] });
  const r = await run(sb, "recoverLowHp('furnace')");
  assert.strictEqual(r.outcome, 'timeout');
  assert.deepStrictEqual(sb.calls, ['stopMotion', 'seal']);
  assert.ok(sb.clock.t - 1000 >= 60000 && sb.clock.t - 1000 <= 61000, 'budget respecté : ' + (sb.clock.t - 1000));
});

test('recoverLowHp : annulé → rend la main tout de suite', async () => {
  const sb = recoverSandbox({ entities: [zombie(4)] });
  sb.taskToken.cancelled = true;
  const r = await run(sb, "recoverLowHp('furnace')");
  assert.strictEqual(r.outcome, 'cancelled');
  assert.deepStrictEqual(sb.calls, []);
});
