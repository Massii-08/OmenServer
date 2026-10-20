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
    isFleeHostile, NEUTRAL_NO_PROVOKE,
    bot: {
      entity: { position: { x: 0, y: 70, z: 0 } },
      entities: Object.fromEntries(entities.map((e, i) => [i, e])),
      pvp: { target: null },
      inventory: { items: () => [{ name: 'birch_planks', count: 1 }, { name: 'acacia_planks', count: 1 }, { name: 'dirt', count: 5 }], emptySlotCount: () => 0 },
    },
    _craftSmartRaw: raw || (async (a) => { sb.log.push('start:' + a.name); await Promise.resolve(); sb.log.push('end:' + a.name); return { ok: true }; }),
  };
  vm.createContext(sb);
  for (const c of ['CRAFT_QUEUE_MAX_WAIT_MS', 'CRAFT_COMBAT_WAIT_MS', 'CRAFT_COMBAT_RADIUS']) run(sb, constSrc(c));
  for (const l of ['_craftTail', '_craftDepth']) run(sb, letSrc(l));
  for (const f of ['craftCombatNow', 'craftMatterSummary', 'craftSmart']) run(sb, fnSrc(f));
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

test('index.js : l aura et le /tpa de squad respectent un craft en cours', () => {
  assert.match(fnSrc('auraTick'), /if \(_craftDepth > 0\) return;/);
  assert.match(SRC, /_foodTripBusy \|\| _craftDepth > 0;\n  const pick = squadTarget\(/);
});
