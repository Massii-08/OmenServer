'use strict';
// LA FUITE DE MOVEMENTS (19/10). collectBlock.collect et pvp.attack posent LEUR Movements d'usine
// (placeCost 1, eau `replaceable`, échafaudage terre+pierre) et ne rendent jamais la nôtre : après la
// 1re récolte, tous les trajets suivants partaient à placeCost 1 — probablement LA cause des ponts.
// On vérifie ici, avec la VRAIE classe Movements de mineflayer-pathfinder 2.4.5 :
//   1. nos réglages de sécurité passent dans les Movements des plugins SANS partager d'objet mutable ;
//   2. la nominale est RENDUE à la fin de chaque usage plugin (succès, échec, usages imbriqués,
//      combat), jamais pendant qu'un autre usage court ;
//   3. le câblage existe bien dans index.js (un test qui injecte ne prouve pas qu'on BRANCHE).
const { test } = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const { copySafetySettings, createMovesKeeper, SAFETY_PROPS, RESTORE_EMIT_MIN_MS } = require('./pluginMoves');
const { withTempMovements } = require('./movement');

let real = null;
try {
  const registry = require('prismarine-registry')('1.21.4');
  real = { registry, Movements: require('mineflayer-pathfinder').Movements };
} catch (e) { real = null; }
const SKIP = !real && 'mineflayer-pathfinder / prismarine-registry introuvables';

/** Faux bot : un vrai EventEmitter (events pvp) + un pathfinder qui expose `movements` comme la lib. */
function makeBot() {
  const bot = new EventEmitter();
  bot.registry = real.registry;
  bot.blockAt = () => null;
  bot.entity = { position: { x: 0, y: 70, z: 0 }, effects: {} };
  bot.inventory = { items: () => [] };
  bot.game = { minY: -64 };
  let active = null;
  bot.sets = [];
  bot.pathfinder = {
    bestHarvestTool: () => null,
    setMovements(m) { active = m; bot.sets.push(m); },
    get movements() { return active; },                  // getter réel de la lib (index.js:104-115)
  };
  return bot;
}

/** Nominale réglée comme un OUVRIER en prod (index.js, onSpawn). */
function nominalMoves(bot) {
  const reg = real.registry;
  const m = new real.Movements(bot);
  m.canDig = true;
  m.allow1by1towers = true;
  m.allowParkour = true;
  m.maxDropDown = 4;
  m.liquidCost = 20;
  m.placeCost = 45;
  m.replaceables.delete(reg.blocksByName.water.id);
  m.replaceables.delete(reg.blocksByName.lava.id);
  for (const n of ['pointed_dripstone', 'powder_snow', 'cactus']) m.blocksToAvoid.add(reg.blocksByName[n].id);
  m.scafoldingBlocks = ['cobblestone', 'cobbled_deepslate', 'dirt', 'tuff'].map((n) => reg.itemsByName[n].id);
  return m;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** collectBlock tel que le plugin se comporte (CollectBlock.collect) : pose SA Movements, ne la rend pas. */
function fakeCollectBlock(bot) {
  const movements = new real.Movements(bot);
  const cb = {
    movements,
    calls: 0,
    collect(target, { delayMs = 5, fail = null, throwSync = null } = {}) {
      if (throwSync) throw throwSync;
      const self = this;
      return (async () => {
        self.calls += 1;
        movements.dontMineUnderFallingBlock = false;      // ce que fait le vrai plugin, à CHAQUE collect
        movements.dontCreateFlow = false;
        bot.pathfinder.setMovements(movements);           // synchrone, avant le 1er await (comme la lib)
        await sleep(delayMs);
        if (fail) throw fail;
        return 'collected:' + target;
      })();
    },
  };
  return cb;
}

/** mineflayer-pvp : attack pose sa Movements + 'startedAttacking' ; stop vide la cible + 'stoppedAttacking'. */
function fakePvp(bot) {
  const pvp = { movements: new real.Movements(bot), target: undefined };
  pvp.attack = (t) => { pvp.target = t; bot.pathfinder.setMovements(pvp.movements); bot.emit('startedAttacking'); };
  pvp.stop = () => { if (!pvp.target) return; pvp.target = undefined; bot.emit('stoppedAttacking'); };
  bot.pvp = pvp;
  return pvp;
}

function setup() {
  const bot = makeBot();
  const nominal = nominalMoves(bot);
  bot._mcaMoves = nominal;
  bot.pathfinder.setMovements(nominal);
  const events = [];
  let t = 0;
  const keeper = createMovesKeeper({ bot, emit: (e) => events.push(e), now: () => t });
  const cb = fakeCollectBlock(bot);
  keeper.wrapCollect(cb);
  const pvp = fakePvp(bot);
  keeper.watchPvp(bot);
  return { bot, nominal, keeper, cb, pvp, events, clock: (ms) => { t = ms; } };
}

// ─── 1. Recopie des réglages de sécurité ───────────────────────────────────────────────────────
test('SAFETY_PROPS : au minimum les 9 réglages de sécurité de la nominale', () => {
  for (const k of ['placeCost', 'liquidCost', 'replaceables', 'scafoldingBlocks', 'blocksToAvoid',
    'maxDropDown', 'allowParkour', 'allow1by1towers', 'canDig']) {
    assert.ok(SAFETY_PROPS.includes(k), k);
  }
  // les deux booléens que collectBlock écrase à chaque collect ne doivent JAMAIS voyager
  assert.ok(!SAFETY_PROPS.includes('dontCreateFlow'));
  assert.ok(!SAFETY_PROPS.includes('dontMineUnderFallingBlock'));
});

test('copySafetySettings (VRAIE Movements) : la Movements du plugin hérite de nos réglages', { skip: SKIP }, () => {
  const bot = makeBot();
  const nominal = nominalMoves(bot);
  const plugin = new real.Movements(bot);                    // usine : placeCost 1, eau replaceable
  assert.strictEqual(plugin.placeCost, 1);
  assert.ok(plugin.replaceables.has(real.registry.blocksByName.water.id), 'témoin : l usine pose dans l eau');
  const copied = copySafetySettings(nominal, plugin);
  assert.deepStrictEqual([...copied].sort(), [...SAFETY_PROPS].sort());
  assert.strictEqual(plugin.placeCost, 45);
  assert.strictEqual(plugin.liquidCost, 20);
  assert.strictEqual(plugin.maxDropDown, 4);
  assert.strictEqual(plugin.allowParkour, true);
  assert.strictEqual(plugin.allow1by1towers, true);
  assert.strictEqual(plugin.canDig, true);
  assert.strictEqual(plugin.replaceables.has(real.registry.blocksByName.water.id), false);
  assert.strictEqual(plugin.replaceables.has(real.registry.blocksByName.lava.id), false);
  assert.ok(plugin.blocksToAvoid.has(real.registry.blocksByName.pointed_dripstone.id));
  assert.deepStrictEqual(plugin.scafoldingBlocks, nominal.scafoldingBlocks);
});

test('copySafetySettings : AUCUN objet mutable partagé avec la nominale', { skip: SKIP }, () => {
  const bot = makeBot();
  const nominal = nominalMoves(bot);
  const plugin = new real.Movements(bot);
  copySafetySettings(nominal, plugin);
  assert.notStrictEqual(plugin.replaceables, nominal.replaceables);
  assert.notStrictEqual(plugin.blocksToAvoid, nominal.blocksToAvoid);
  assert.notStrictEqual(plugin.scafoldingBlocks, nominal.scafoldingBlocks);
  // ce qu'un plugin modifie chez LUI ne contamine pas la nominale
  const water = real.registry.blocksByName.water.id;
  plugin.replaceables.add(water);
  plugin.blocksToAvoid.clear();
  plugin.scafoldingBlocks.push(999999);
  plugin.dontCreateFlow = false;                             // ce que collectBlock fait à chaque collect
  plugin.dontMineUnderFallingBlock = false;
  assert.strictEqual(nominal.replaceables.has(water), false);
  assert.ok(nominal.blocksToAvoid.size > 0);
  assert.ok(!nominal.scafoldingBlocks.includes(999999));
  assert.strictEqual(nominal.dontCreateFlow, true);
  assert.strictEqual(nominal.dontMineUnderFallingBlock, true);
});

test('copySafetySettings : entrées absurdes → [] sans exception', () => {
  assert.deepStrictEqual(copySafetySettings(null, {}), []);
  assert.deepStrictEqual(copySafetySettings({ placeCost: 45 }, null), []);
  assert.deepStrictEqual(copySafetySettings({}, {}), []);
});

// ─── 2. Restauration de la nominale ────────────────────────────────────────────────────────────
test('après un collect, la nominale est rendue (identité + placeCost nominal)', { skip: SKIP }, async () => {
  const { bot, nominal, cb } = setup();
  const p = cb.collect('log');
  assert.strictEqual(bot.pathfinder.movements, cb.movements, 'pendant le collect : la Movements du plugin');
  assert.strictEqual(await p, 'collected:log', 'valeur de retour intacte');
  assert.strictEqual(bot.pathfinder.movements, bot._mcaMoves);
  assert.strictEqual(bot.pathfinder.movements, nominal);
  assert.strictEqual(bot.pathfinder.movements.placeCost, 45);
});

test('un collect qui ÉCHOUE restaure aussi (rejet asynchrone)', { skip: SKIP }, async () => {
  const { bot, nominal, cb } = setup();
  await assert.rejects(cb.collect('log', { fail: new Error('NoPath') }), /NoPath/);
  assert.strictEqual(bot.pathfinder.movements, nominal);
});

test('un collect qui JETTE synchroniquement restaure aussi, et l erreur remonte', { skip: SKIP }, () => {
  const { bot, nominal, cb, keeper } = setup();
  bot.pathfinder.setMovements(cb.movements);                 // reliquat d'un usage précédent
  assert.throws(() => cb.collect('log', { throwSync: new Error('boom') }), /boom/);
  assert.strictEqual(bot.pathfinder.movements, nominal);
  assert.strictEqual(keeper.inUse().collect, 0, 'compteur rendu');
});

test('deux collects IMBRIQUÉS : on ne restaure qu à la fin du DERNIER', { skip: SKIP }, async () => {
  const { bot, nominal, cb } = setup();
  const outer = cb.collect('a', { delayMs: 40 });
  await sleep(5);
  const inner = cb.collect('b', { delayMs: 10 });
  await inner;                                               // le second finit pendant le premier
  assert.strictEqual(bot.pathfinder.movements, cb.movements, 'un collect court encore : pas de restauration');
  await outer;
  assert.strictEqual(bot.pathfinder.movements, nominal);
});

test('collects qui se CHEVAUCHENT dans l autre ordre : restauration à la fin du dernier aussi', { skip: SKIP }, async () => {
  const { bot, nominal, cb } = setup();
  const first = cb.collect('a', { delayMs: 10 });
  await sleep(2);
  const second = cb.collect('b', { delayMs: 40 });
  await first;
  assert.strictEqual(bot.pathfinder.movements, cb.movements);
  await second;
  assert.strictEqual(bot.pathfinder.movements, nominal);
});

test('fin de combat (stoppedAttacking) → nominale rendue', { skip: SKIP }, () => {
  const { bot, nominal, pvp } = setup();
  pvp.attack({ name: 'zombie' });
  assert.strictEqual(bot.pathfinder.movements, pvp.movements);
  pvp.stop();
  assert.strictEqual(bot.pathfinder.movements, nominal);
});

test('pas de restauration PENDANT un combat : la fin d un collect attend la fin du combat', { skip: SKIP }, async () => {
  const { bot, nominal, cb, pvp } = setup();
  const c = cb.collect('log', { delayMs: 10 });
  pvp.attack({ name: 'zombie' });
  await c;
  assert.strictEqual(bot.pathfinder.movements, pvp.movements, 'le combat court : on ne lui vole pas ses réglages');
  pvp.stop();
  assert.strictEqual(bot.pathfinder.movements, nominal);
});

test('pas de restauration PENDANT un collect : la fin d un combat attend la fin du collect', { skip: SKIP }, async () => {
  const { bot, nominal, cb, pvp } = setup();
  pvp.attack({ name: 'zombie' });
  const c = cb.collect('log', { delayMs: 10 });
  pvp.stop();
  assert.strictEqual(bot.pathfinder.movements, cb.movements);
  await c;
  assert.strictEqual(bot.pathfinder.movements, nominal);
});

test('dans une fenêtre withTempMovements, on rend la TEMPORAIRE (= _mcaMoves), puis la nominale', { skip: SKIP }, async () => {
  const { bot, nominal, cb } = setup();
  let seen = null;
  let temp = null;
  await withTempMovements(bot, real.Movements, { canDig: false }, async () => {
    temp = bot._mcaMoves;
    await cb.collect('log');
    seen = bot.pathfinder.movements;
  });
  assert.strictEqual(seen, temp);
  assert.strictEqual(seen.canDig, false);
  assert.strictEqual(bot.pathfinder.movements, nominal);
});

test('aucun setMovements inutile quand la bonne Movements est déjà active', { skip: SKIP }, () => {
  const { bot, keeper } = setup();
  const before = bot.sets.length;
  assert.strictEqual(keeper.restore('pvp'), false);
  assert.strictEqual(bot.sets.length, before);
});

test('wrapCollect : idempotent (un seul comptage), garde le this du plugin', { skip: SKIP }, async () => {
  const { bot, nominal, cb, keeper } = setup();
  assert.strictEqual(keeper.wrapCollect(cb), true);
  const p = cb.collect('log');
  assert.strictEqual(keeper.inUse().collect, 1);
  await p;
  assert.strictEqual(cb.calls, 1);
  assert.strictEqual(bot.pathfinder.movements, nominal);
  assert.strictEqual(keeper.wrapCollect(null), false);
  assert.strictEqual(keeper.watchPvp(null), false);
});

test('moves_restored : au plus 1 event par minute, le compte agrège les restaurations', { skip: SKIP }, () => {
  const { bot, pvp, events, clock } = setup();
  const fight = (atMs) => { clock(atMs); pvp.attack({ name: 'zombie' }); pvp.stop(); };
  fight(0);
  fight(1000);
  fight(2000);
  assert.deepStrictEqual(events, [{ type: 'moves_restored', by: 'pvp', count: 1 }]);
  fight(RESTORE_EMIT_MIN_MS);
  assert.deepStrictEqual(events[1], { type: 'moves_restored', by: 'pvp', count: 3 });
  assert.strictEqual(events.length, 2);
  assert.ok(bot.pathfinder.movements === bot._mcaMoves);
});

// ─── 2 bis. Contre le VRAI code des plugins (CollectBlock / PVP compilés), faux bot sans serveur ───
let plugins = null;
try {
  plugins = {
    CollectBlock: require('mineflayer-collectblock').CollectBlock,
    PVP: require('mineflayer-pvp/lib/PVP').PVP,
    Block: require('prismarine-block')(real.registry),
    Vec3: require('vec3').Vec3,
  };
} catch (e) { plugins = null; }
const SKIP_PLUGINS = (SKIP || !plugins) && 'mineflayer-collectblock / mineflayer-pvp introuvables';

/** Ce que les vrais plugins lisent sur le bot : pathfinder (goto/stop/setGoal), tool, inventaire. */
function pluginBot({ gotoFails = null } = {}) {
  const bot = makeBot();
  bot.version = '1.21.4';
  bot.entity.position = new plugins.Vec3(0, 70, 0);
  bot.tool = { equipForBlock: async () => {} };
  bot.inventory = { items: () => [], emptySlotCount: () => 10 };
  bot.world = {};
  bot.blockAt = () => { const b = plugins.Block.fromStateId(real.registry.blocksByName.air.defaultState, 0); return b; };
  bot.pathfinder.goto = async () => { if (gotoFails) throw gotoFails; };
  bot.pathfinder.setGoal = () => {};
  bot.pathfinder.stop = () => { setImmediate(() => bot.emit('path_stop')); };
  const nominal = nominalMoves(bot);
  bot._mcaMoves = nominal;
  bot.pathfinder.setMovements(nominal);
  return { bot, nominal };
}
const stoneAt = (x, y, z) => {
  const b = plugins.Block.fromStateId(real.registry.blocksByName.stone.defaultState, 0);
  b.position = new plugins.Vec3(x, y, z);
  return b;
};

test('VRAI CollectBlock : il pose bien SA Movements (témoin), et le gardien rend la nominale à la fin', { skip: SKIP_PLUGINS }, async () => {
  const { bot, nominal } = pluginBot();
  const cb = new plugins.CollectBlock(bot);
  // témoin SANS gardien : la fuite telle qu'en prod
  await cb.collect(stoneAt(3, 69, 0));
  assert.strictEqual(bot.pathfinder.movements, cb.movements, 'la lib laisse SA Movements active');
  bot.pathfinder.setMovements(nominal);
  // avec le gardien
  const keeper = createMovesKeeper({ bot });
  keeper.wrapCollect(cb);
  const p = cb.collect(stoneAt(3, 69, 0));
  assert.strictEqual(bot.pathfinder.movements, cb.movements, 'pendant le collect : la sienne (posée en synchrone)');
  await p;
  assert.strictEqual(bot.pathfinder.movements, nominal);
  assert.strictEqual(nominal.dontCreateFlow, true, 'ses dontCreateFlow=false restent chez lui');
});

test('VRAI CollectBlock : un collect qui échoue (NoPath) rend aussi la nominale', { skip: SKIP_PLUGINS }, async () => {
  const err = Object.assign(new Error('No path'), { name: 'NoPath' });
  const { bot, nominal } = pluginBot({ gotoFails: err });
  const cb = new plugins.CollectBlock(bot);
  createMovesKeeper({ bot }).wrapCollect(cb);
  await assert.rejects(cb.collect(stoneAt(3, 69, 0)), /No path/);
  assert.strictEqual(bot.pathfinder.movements, nominal);
});

test('VRAI PVP : attack pose SA Movements, stop (stoppedAttacking) → nominale rendue', { skip: SKIP_PLUGINS }, async () => {
  const { bot, nominal } = pluginBot();
  const pvp = new plugins.PVP(bot);
  bot.pvp = pvp;
  createMovesKeeper({ bot }).watchPvp(bot);
  await pvp.attack({ name: 'zombie', position: new plugins.Vec3(5, 70, 0) });
  assert.strictEqual(bot.pathfinder.movements, pvp.movements, 'combat : la sienne');
  await pvp.stop();
  assert.strictEqual(bot.pathfinder.movements, nominal);
});

// ─── 3. Câblage dans index.js ──────────────────────────────────────────────────────────────────
test('index.js : keeper posé UNE fois par process (garde de NIVEAU MODULE), sur les deux plugins', () => {
  const src = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');
  assert.match(src, /require\('\.\/pluginMoves'\)/);
  assert.match(src, /^let _pluginMovesInstalled = false;/m, 'garde de niveau module (colonne 0), jamais dans onSpawn');
  const at = src.indexOf('if (!_pluginMovesInstalled) {');
  assert.ok(at > 0, 'installation sous la garde de niveau module');
  const block = src.slice(at, at + 1800);
  assert.match(block, /_pluginMovesInstalled = true;/);
  assert.match(block, /copySafetySettings\(moves, bot\.collectBlock && bot\.collectBlock\.movements\)/);
  assert.match(block, /copySafetySettings\(moves, bot\.pvp && bot\.pvp\.movements\)/);
  assert.match(block, /\.wrapCollect\(bot\.collectBlock\)/);
  assert.match(block, /\.watchPvp\(bot\)/);
  assert.match(block, /type: 'moves_keeper_on'/, 'le silence est un bug : l installation doit être confirmée');
  // la recopie doit suivre la config COMPLÈTE de la nominale (après échafaudage + garde-fou anti-pont)
  assert.ok(src.indexOf("type: 'bridge_guard_on'") < at, 'recopie APRÈS la config nominale et le garde-fou');
  assert.ok(at < src.indexOf('bot.pathfinder.setMovements(moves);', at), 'avant la pose de la nominale');
});
