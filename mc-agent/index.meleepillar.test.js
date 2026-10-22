'use strict';
// CÂBLAGE (live 22/10, NethBot3 : 9 morts « slain by Zombie » en 2 min 27 s, en plein jour, au point de
// réapparition) — pilier anti-mêlée + point de réapparition campé. Le texte RÉEL de index.js exécuté dans
// un bac à sable vm strict (cf. index.deathcampflee.test.js) : un identifiant oublié lève ici.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const meleePillar = require('./meleePillar');
const respawnCamp = require('./respawnCamp');
const { SCAFFOLD } = require('./skills/pillarUp');
const goalHold = require('./goalHold');
const bed = require('./bed');

const SRC = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');
const fnSrc = (name) => {
  const m = SRC.match(new RegExp(`^(?:async )?function ${name}\\([^)]*\\) \\{[\\s\\S]*?^\\}$`, 'm'));
  assert.ok(m, `function ${name} introuvable au niveau module de index.js`);
  return m[0];
};
const constSrc = (name) => {
  const m = SRC.match(new RegExp(`^const ${name} = [^\\n]*$`, 'm'));
  assert.ok(m, `const ${name} introuvable`);
  return m[0];
};

function v3(x, y, z) {
  return { x, y, z, floored() { return v3(Math.floor(x), Math.floor(y), Math.floor(z)); }, offset(a, b, c) { return v3(x + a, y + b, z + c); } };
}

function sandbox(opts = {}) {
  const zombies = opts.zombies || [
    { name: 'zombie', position: v3(0.5, 64, 0) }, { name: 'zombie', position: v3(-1, 64, 1) },
    { name: 'zombie', position: v3(1.7, 64, 0) },
  ];
  const ents = {};
  zombies.forEach((z, i) => { ents[i] = z; });
  const blocks = {};   // "x,y,z" → name
  const bot = {
    health: 20, food: 20, time: { timeOfDay: 5000 },
    entity: { position: v3(0.5, 64, 0.5) },
    entities: ents,
    inventory: { items: () => (opts.items || [{ name: 'dirt', count: 32 }]) },
    pathfinder: { setGoal() {} },
    blockAt(p) { const k = `${p.x},${p.y},${p.z}`; return blocks[k] ? { name: blocks[k], position: p } : { name: 'air', position: p }; },
    attacks: 0,
  };
  const memo = { value: opts.memo || {} };
  const sb = vm.createContext({
    events: [], bot, memo,
    emit(e) { sb.events.push(e); },
    meleePillar, respawnCamp, SCAFFOLD,
    boldFightAdvised: () => !!opts.fightAdvised, canDealWith: () => 1, armorPoints: () => 0, attackDamage: () => 1,
    isNight: () => false, isInWater: () => false,
    bestToolFor: () => null, boundedEquip: async () => {},
    boundedDig: async (b, blk) => { sb.dug.push(blk.name); delete blocks[`${blk.position.x},${blk.position.y},${blk.position.z}`]; bot.entity.position = v3(bot.entity.position.x, bot.entity.position.y - 1, bot.entity.position.z); },
    dug: [],
    pillarUp: opts.pillarUp || (async (b, { height }) => {
      for (let i = 0; i < height; i++) {
        const f = b.entity.position.floored();
        blocks[`${f.x},${f.y},${f.z}`] = 'dirt';
        b.entity.position = v3(b.entity.position.x, b.entity.position.y + 1, b.entity.position.z);
      }
      sb.pillarCalls++;
      return { ok: true, placed: height };
    }),
    pillarCalls: 0,
    withTimeout: (p) => p,
    sleep: async () => { sb.ticks++; if (opts.onSleep) opts.onSleep(sb); },
    ticks: 0,
    strikeInPlace: () => { bot.attacks++; sb._auraLastHitAt = Date.now(); },
    _auraLastHitAt: 0,
    holdGoal: goalHold.hold, holdSetGoal: goalHold.holdSetGoal, releaseGoalHold: goalHold.release,
    _creeperHold: goalHold.createHoldState(), _creeperFlee: opts.creeperFlee || null,
    _shelterInFlight: null, _shelterTok: null, _shelterStartedAt: 0, _stillBusy: false,
    _escapeOnSpawn: false,
    loadBaseState: () => memo.value,
    saveBaseState: (m) => { memo.value = JSON.parse(JSON.stringify(m)); return true; },   // REMPLACE (comme le vrai)
    bedOf: bed.bedOf, bedMemoCleared: bed.bedMemoCleared, bedRetryMemo: bed.bedRetryMemo,
    Math, Date, Object, Promise, String, Number,
  });
  const code = [
    'let _meleePillar = null;', 'let _meleePillarFailAt = 0;', 'let _respawnCampedLast = null;',
    constSrc('PILLAR_UP_MAX_MS'), constSrc('PILLAR_POLL_MS'), constSrc('PILLAR_HIT_EVERY_MS'),
    fnSrc('meleePillarPlanNow'), fnSrc('pillarDescend'), fnSrc('meleePillarRun'), fnSrc('meleePillarTick'),
    fnSrc('noteRespawnLife'), fnSrc('noteRespawnDeath'),
    'globalThis.__get = () => ({ _meleePillar, _meleePillarFailAt });',
  ].join('\n');
  vm.runInContext("'use strict';\n" + code, sb);
  sb.blocks = blocks;
  return sb;
}

test('grappe de 3 zombies au contact, nu, 32 terre → pilier 3, frappe, la grappe part → redescend en cassant SES 3 blocs', async () => {
  const sb = sandbox({
    onSleep: (s) => { if (s.ticks >= 3) { for (const k of Object.keys(s.bot.entities)) delete s.bot.entities[k]; } },
  });
  const plan = sb.meleePillarPlanNow();
  assert.strictEqual(plan.act, 'pillar');
  const r = await sb.meleePillarRun('spawn', plan);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.placed, 3);
  assert.strictEqual(r.why, 'clear');
  const phases = sb.events.filter((e) => e.type === 'melee_pillar').map((e) => e.phase);
  assert.deepStrictEqual(phases, ['up', 'hold', 'down']);
  assert.ok(sb.bot.attacks >= 1, 'frappe vers le bas pendant l attente');
  assert.deepStrictEqual([...sb.dug], ['dirt', 'dirt', 'dirt'], 'redescend en cassant le pilier');
  assert.strictEqual(sb.bot.entity.position.y, 64);
  assert.strictEqual(sb._shelterInFlight, null, 'verrou d abri relâché');
  assert.strictEqual(sb._stillBusy, false);
  assert.strictEqual(sb.__get()._meleePillar, null);
  assert.ok(!goalHold.isHeld(sb._creeperHold, Date.now()) || sb._creeperHold.owner !== 'melee_pillar');
});

test('pendant le pilier, l abri est VERROUILLÉ (_shelterInFlight posé) et le but pathfinder étranger est ignoré', async () => {
  let seen = null;
  const sb = sandbox({
    onSleep: (s) => {
      if (!seen) {
        seen = { shelter: !!s._shelterInFlight, busy: s._stillBusy, held: goalHold.isHeld(s._creeperHold, Date.now()), owner: s._creeperHold.owner };
      }
      for (const k of Object.keys(s.bot.entities)) delete s.bot.entities[k];
    },
  });
  await sb.meleePillarRun('tick', sb.meleePillarPlanNow());
  assert.deepStrictEqual(seen, { shelter: true, busy: true, held: true, owner: 'melee_pillar' });
});

test('mort sur le pilier (jeton annulé par abortShelterOnDeath) : pas de descente, verrous relâchés', async () => {
  const sb = sandbox({ onSleep: (s) => { if (s._shelterTok) s._shelterTok.cancelled = true; } });
  const r = await sb.meleePillarRun('tick', sb.meleePillarPlanNow());
  assert.strictEqual(r.why, 'cancelled');
  assert.strictEqual(sb.dug.length, 0);
  assert.strictEqual(sb._shelterInFlight, null);
});

test('pose ratée (1 seul étage) → failed + cooldown : le tick suivant ne relance pas', async () => {
  const sb = sandbox({ pillarUp: async () => ({ ok: true, placed: 1, reason: 'place_failed' }) });
  const r = await sb.meleePillarRun('tick', sb.meleePillarPlanNow());
  assert.strictEqual(r.ok, false);
  assert.ok(sb.events.some((e) => e.type === 'melee_pillar' && e.phase === 'failed' && e.reason === 'place_failed'));
  assert.ok(sb.__get()._meleePillarFailAt > 0);
  assert.strictEqual(sb.meleePillarPlanNow().reason, 'cooldown');
});

test('sans bloc en poche, armé pour gagner (boldFightAdvised), ou fuite creeper en cours : pas de pilier', () => {
  assert.strictEqual(sandbox({ creeperFlee: { startedAt: 1 } }).meleePillarPlanNow().reason, 'busy');
  assert.strictEqual(sandbox({ items: [{ name: 'oak_log', count: 10 }] }).meleePillarPlanNow().reason, 'no_blocks');
  assert.strictEqual(sandbox({ fightAdvised: true }).meleePillarPlanNow().reason, 'fight_advised');
});

test('meleePillarTick : ne part pas pendant un abri déjà en cours (zombies sur le toit à ≤ 4 blocs)', async () => {
  const sb = sandbox();
  sb._shelterInFlight = Promise.resolve();
  sb.meleePillarTick();
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(sb.pillarCalls, 0);
  sb._shelterInFlight = null;
  sb.meleePillarTick();
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(sb.pillarCalls, 1);
});

test('point de réapparition campé : 2 vies de quelques secondes au même point → respawn_camped, évasion armée, camp retenu', () => {
  const sb = sandbox();
  sb.noteRespawnLife({ x: 94.7, y: 64.75, z: -49.3 });
  assert.strictEqual(sb.noteRespawnDeath(), null, '1 mort : pas encore campé');
  sb.noteRespawnLife({ x: 94.7, y: 64.75, z: -49.3 });
  const camp = sb.noteRespawnDeath();
  assert.deepStrictEqual(JSON.parse(JSON.stringify(camp)), { x: 95, z: -49, deaths: 2 });
  assert.strictEqual(sb._escapeOnSpawn, true);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(sb.events.filter((e) => e.type === 'respawn_camped'))), [{ type: 'respawn_camped', x: 95, z: -49, deaths: 2 }]);
  assert.ok(respawnCamp.campedNear(sb.memo.value, { x: 100, z: -45 }, Date.now()), 'camp persisté dans le mémo');
  sb.noteRespawnLife({ x: 94, y: 64, z: -50 });
  sb.noteRespawnDeath();
  assert.strictEqual(sb.events.filter((e) => e.type === 'respawn_camped').length, 1, 'un event par camp, pas par mort');
});

test('le point campé EST le lit du bot → lit abandonné (mémo vidé + retry différé), le reste du mémo intact', () => {
  const sb = sandbox({ memo: { base: { x: 90, z: -50 }, bed: { x: 93, y: 64, z: -50, at: 1 } } });
  for (let i = 0; i < 2; i++) { sb.noteRespawnLife({ x: 94, y: 64, z: -49 }); sb.noteRespawnDeath(); }
  assert.strictEqual(bed.bedOf(sb.memo.value), null);
  assert.ok(bed.bedRetryActive(sb.memo.value, Date.now()));
  assert.deepStrictEqual(sb.memo.value.base, { x: 90, z: -50 });
  assert.ok(sb.events.some((e) => e.type === 'bed_abandoned' && e.why === 'respawn_camped'));
});

test('lit AILLEURS que le point campé : gardé', () => {
  const sb = sandbox({ memo: { bed: { x: 57, y: 67, z: -23, at: 1 } } });
  for (let i = 0; i < 2; i++) { sb.noteRespawnLife({ x: 94, y: 64, z: -49 }); sb.noteRespawnDeath(); }
  assert.ok(bed.bedOf(sb.memo.value));
});

test('hideFromThreat essaie le pilier AVANT la fuite et le puits ; guardSpawn passe par hideFromThreat', () => {
  const hide = fnSrc('hideFromThreat');
  const iPillar = hide.indexOf('meleePillarRun(');
  const iFlee = hide.indexOf('fleeBeforeHide(');
  const iDig = hide.indexOf('shelterUntilDawn(');
  assert.ok(iPillar > 0 && iPillar < iFlee && iFlee < iDig);
  assert.ok(/await hideFromThreat\('spawn'/.test(fnSrc('guardSpawn')));
  assert.ok(/_meleePillar\) break/.test(fnSrc('fleeBeforeHide')), 'la fuite d avant-abri cède au pilier');
  assert.ok(/if \(_meleePillar\) return true;/.test(fnSrc('shelterHoldNow')), 'perché = tenir la case (réflexes)');
  assert.ok(/setInterval\(meleePillarTick, PILLAR_TICK_MS\)/.test(SRC), 'timer branché');
  assert.ok(/noteRespawnLife\(_lastRespawnPos\)/.test(SRC) && /\n  noteRespawnDeath\(\);/.test(SRC), 'vies branchées au spawn et à la mort');
  assert.ok(/bedFail\('camped_spot'\)/.test(fnSrc('ensureBedGoal')), 'pas de lit sur un camp');
});
