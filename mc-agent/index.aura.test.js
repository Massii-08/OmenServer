'use strict';
// CÂBLAGE de la frappe passive (aura) et du tick creeper (AltoClef MobDefenseChain, 20/10).
// La logique est testée dans aura.test.js / creeper.test.js ; ici on EXÉCUTE le vrai texte des fonctions
// de index.js dans un bac à sable `vm` strict (même technique que index.spawnflee.test.js) : un
// identifiant lu hors du niveau module (piège #56) → ReferenceError ici, pas en prod.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const A = require('./aura');
const CR = require('./creeper');
const TG = require('./threatgate');

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

const mob = (name, dx, extra = {}) => Object.assign({ id: 100 + dx, name, kind: 'Hostile mobs', type: 'hostile',
  position: { x: dx, y: 70, z: 0 }, height: 1.95, isValid: true }, extra);

function sandbox({ entities = [], held = null, items = [], digging = false, using = false, pvpTarget = null, clock = { t: 1_700_000_000_000 }, shelter = null } = {}) {
  const sb = {
    events: [], calls: [], clock,
    emit(e) { sb.events.push(e); },
    Date: { now: () => clock.t },
    bot: {
      health: 20,
      entity: { position: { x: 0, y: 70, z: 0 } },
      entities: Object.fromEntries(entities.map((e, i) => [i, e])),
      heldItem: held ? { name: held } : null,
      inventory: { items: () => items.map((name) => ({ name, count: 1 })) },
      targetDigBlock: digging ? { name: 'oak_log' } : null,
      usingHeldItem: using,
      pvp: { target: pvpTarget, stop: () => sb.calls.push('pvp_stop') },
      equip: (it) => { sb.calls.push('equip:' + it.name); sb.bot.heldItem = { name: it.name }; return Promise.resolve(); },
      attack: (e) => sb.calls.push('attack:' + e.name),
      blockAt: () => null,
      pathfinder: { setGoal: (g) => sb.calls.push('goal:' + (g ? Math.round(g.x) + ',' + Math.round(g.z) : 'null')) },
    },
    bestWeapon: (b) => { const w = b.inventory.items().find((i) => i.name.endsWith('_sword') || i.name.endsWith('_axe')); return w || null; },
    auraTarget: A.auraTarget, auraPlan: A.auraPlan, hasLineOfSight: TG.hasLineOfSight,
    creeperPlan: CR.creeperPlan, isCreeperFusing: CR.isCreeperFusing, creeperAwayPoint: CR.awayPoint,
    CREEPER_FLEE_KEEP: CR.FLEE_KEEP, CREEPER_STEP_AWAY_KEEP: CR.STEP_AWAY_KEEP,
    vec3Lib: (x, y, z) => ({ x, y, z }),
    pfGoals: { GoalNearXZ: function (x, z, r) { this.x = x; this.z = z; this.r = r; } },
    _shelterInFlight: shelter, _stillBusy: false,
  };
  vm.createContext(sb);
  for (const c of ['AURA_EVENT_EVERY_MS', 'CREEPER_SCAN_RADIUS', 'CREEPER_MOVE_MS']) run(sb, constSrc(c));
  for (const l of ['_auraLastHitAt', '_auraBusy', '_auraEvAt', '_creeperMoveUntil']) run(sb, letSrc(l));
  for (const f of ['_auraEmit', 'canSeeEntityNow', 'auraTick', 'creeperTick']) run(sb, fnSrc(f));
  return sb;
}
const flush = () => new Promise((r) => setImmediate(r));

test('auraTick : zombie à 2 blocs, épée en main → frappe + aura_hit ; re-tick immédiat → cooldown, pas de 2e coup', () => {
  const sb = sandbox({ entities: [mob('zombie', 2)], held: 'stone_sword', items: ['stone_sword'] });
  run(sb, 'auraTick()');
  assert.deepStrictEqual(sb.calls, ['attack:zombie']);
  const ev = sb.events.find((e) => e.type === 'aura_hit');
  assert.ok(ev && ev.mob === 'zombie' && ev.dist === 2);
  sb.clock.t += 300;
  run(sb, 'auraTick()');
  assert.deepStrictEqual(sb.calls, ['attack:zombie'], 'cooldown épée 625 ms');
  sb.clock.t += 400;
  run(sb, 'auraTick()');
  assert.deepStrictEqual(sb.calls, ['attack:zombie', 'attack:zombie']);
  assert.strictEqual(sb.events.filter((e) => e.type === 'aura_hit').length, 1, 'event throttlé (1 / 10 s)');
});

test('auraTick : arme en poche, bûche en main → équipe (pas de coup ce tick, le cooldown repart)', async () => {
  const sb = sandbox({ entities: [mob('zombie', 2)], held: 'oak_log', items: ['oak_log', 'stone_sword'] });
  run(sb, 'auraTick()');
  await flush();
  assert.deepStrictEqual(sb.calls, ['equip:stone_sword']);
  sb.clock.t += 700;
  run(sb, 'auraTick()');
  assert.deepStrictEqual(sb.calls, ['equip:stone_sword', 'attack:zombie']);
});

test('auraTick : creuse avec une pioche → frappe AVEC la pioche, sans changer d objet', () => {
  const sb = sandbox({ entities: [mob('zombie', 2)], held: 'stone_pickaxe', items: ['stone_pickaxe', 'stone_sword'], digging: true });
  run(sb, 'auraTick()');
  assert.deepStrictEqual(sb.calls, ['attack:zombie']);
});

test('auraTick : creeper / mange / combat pvp en cours / sans arme / hors portée → rien', () => {
  for (const o of [
    { entities: [mob('creeper', 2)], held: 'stone_sword', items: ['stone_sword'] },
    { entities: [mob('zombie', 2)], held: 'stone_sword', items: ['stone_sword'], using: true },
    { entities: [mob('zombie', 2)], held: 'stone_sword', items: ['stone_sword'], pvpTarget: { id: 9 } },
    { entities: [mob('zombie', 2)], held: 'oak_log', items: ['oak_log'] },
    { entities: [mob('zombie', 4)], held: 'stone_sword', items: ['stone_sword'] },
  ]) {
    const sb = sandbox(o);
    run(sb, 'auraTick()');
    assert.deepStrictEqual(sb.calls, [], JSON.stringify(o.entities.map((e) => e.name)));
  }
});

test('auraTick : zombie derrière un mur → pas de coup (ligne de vue)', () => {
  const sb = sandbox({ entities: [mob('zombie', 2.5)], held: 'stone_sword', items: ['stone_sword'] });
  sb.bot.blockAt = (q) => (q.x === 1 ? { boundingBox: 'block' } : null);
  run(sb, 'auraTick()');
  assert.deepStrictEqual(sb.calls, []);
});

const fusingCreeper = (dx) => { const m = []; m[CR.SWELL_DIR_INDEX] = 1; return mob('creeper', dx, { metadata: m }); };

test('creeperTick : creeper qui gonfle à 5 blocs → but de fuite à 10 blocs du creeper (opposé) + creeper_avoid', () => {
  const sb = sandbox({ entities: [fusingCreeper(5)], pvpTarget: { id: 1 } });
  run(sb, 'creeperTick()');
  assert.ok(sb.calls.includes('pvp_stop'), 'coupe le combat en cours');
  assert.ok(sb.calls.includes('goal:-5,0'), sb.calls.join('|'));
  const ev = sb.events.find((e) => e.type === 'creeper_avoid');
  assert.ok(ev && ev.act === 'flee' && ev.fusing === true);
  // mouvement en cours : pas de nouveau but au tick suivant
  sb.clock.t += 250;
  run(sb, 'creeperTick()');
  assert.strictEqual(sb.calls.filter((c) => c.startsWith('goal:')).length, 1);
});

test('creeperTick : creeper calme à 3 blocs → s écarte à 6 blocs ; calme à 8 blocs → rien + creeper_ignored', () => {
  const sb = sandbox({ entities: [mob('creeper', 3)] });
  run(sb, 'creeperTick()');
  assert.ok(sb.calls.includes('goal:-3,0'), sb.calls.join('|'));
  const sb2 = sandbox({ entities: [mob('creeper', 8)] });
  run(sb2, 'creeperTick()');
  assert.deepStrictEqual(sb2.calls, []);
  const ev = sb2.events.find((e) => e.type === 'creeper_ignored');
  assert.ok(ev && ev.fusing === false && ev.dist === 8);
});

test('creeperTick : terré dans un abri → on ne sort pas du trou', () => {
  const sb = sandbox({ entities: [fusingCreeper(4)], shelter: Promise.resolve() });
  run(sb, 'creeperTick()');
  assert.deepStrictEqual(sb.calls, []);
});

test('index.js : les ticks aura/creeper sont armés au NIVEAU MODULE (setInterval) et l assistance d équipe ne vise jamais un creeper', () => {
  assert.match(SRC, /^setInterval\(\(\) => \{ auraTick\(\); creeperTick\(\); \}, AURA_TICK_MS\);$/m);
  assert.match(fnSrc('teamAssistTick'), /name !== 'creeper'/);
});
