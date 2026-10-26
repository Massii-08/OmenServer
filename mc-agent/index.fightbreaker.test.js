'use strict';
// Câblage index.js du disjoncteur de combat (22/10). Sandbox vm : on extrait les fonctions de NIVEAU
// MODULE (piège #56) et on vérifie ce qu'elles font réellement sur un faux bot.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { createFightBreaker } = require('./fightBreaker');
const { isFleeHostile } = require('./skills/fleeFrom');

const SRC = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');
function grab(re, label) {
  const m = SRC.match(re);
  assert.ok(m, `${label} introuvable dans index.js (déplacé, renommé, ou déclaré hors niveau module ?)`);
  return m[0];
}
const fnSrc = (name) => grab(new RegExp(`^(?:async )?function ${name}\\([^)]*\\) \\{[\\s\\S]*?^\\}$`, 'm'), `function ${name}`);
const NAMES = ['_fightSituation', '_fightCanEngage', '_fightNoteFlee', 'fightGateDeps', '_fightInProgress', '_fightBreakerCheck', 'wireFightBreaker'];

function setup({ health = 20, hostiles = [], extra = {} } = {}) {
  const bot = new EventEmitter();
  bot.health = health;
  bot.entity = { position: { x: 0, y: -6, z: 0 } };
  const attacked = [];
  let stops = 0;
  bot.pvp = {
    target: null,
    attack(t) { attacked.push(t.name); this.target = t; bot.emit('startedAttacking'); },
    stop() { stops++; this.target = null; },
  };
  const events = [];
  let fled = 0;
  const sb = {
    bot, emit: (e) => events.push(e), IS_MAPPER: false, Date, Math, Number, String,
    _fightBreaker: createFightBreaker(), isFleeHostile,
    nearbyHostiles: () => hostiles, fleeFrom: () => { fled++; return true; },
    // porte squelette (22/10) : les fuites du disjoncteur passent par skeletonFirstFlee
    skeletonFirstFlee: () => { fled++; return true; },
    ...extra,
  };
  vm.createContext(sb);
  vm.runInContext(`'use strict';
    var _fightBreakerWired = false; var _fightRefusedAt = -Infinity; var _fightRefuseFleeAt = -Infinity; var _pvpAttackRaw = null;
    ${NAMES.map(fnSrc).join('\n')}
    globalThis.api = { wireFightBreaker, fightGateDeps, get wired() { return _fightBreakerWired; }, get raw() { return _pvpAttackRaw; } };`, sb);
  return { bot, sb, events, attacked, get stops() { return stops; }, get fled() { return fled; } };
}

const zombie = (x) => ({ name: 'zombie', kind: 'Hostile mobs', position: { x, y: -6, z: 0 } });

test('wireFightBreaker : chute de 7 PV en combat → pvp.stop + fuite + fight_aborted', () => {
  const z = zombie(2);
  const h = setup({ health: 20, hostiles: [z, zombie(3)] });
  assert.strictEqual(h.sb.api.wireFightBreaker(), true);
  h.bot.pvp.attack(z);                       // 20 PV, 2 hostiles : engagement permis
  assert.deepStrictEqual(h.attacked, ['zombie']);
  h.bot.health = 13; h.bot.emit('health');
  const ab = h.events.find((e) => e.type === 'fight_aborted');
  assert.ok(ab, 'fight_aborted émis');
  assert.strictEqual(ab.drop, 7);
  assert.strictEqual(ab.hostiles, 2);
  assert.strictEqual(ab.reason, 'drop');
  assert.strictEqual(h.stops, 1);
  assert.strictEqual(h.fled, 1);
  assert.strictEqual(h.bot.pvp.target, null);
});

test('wireFightBreaker : après abandon, tout pvp.attack sur un hostile est refusé (fuite + fight_refused)', () => {
  const z = zombie(5);
  const h = setup({ health: 20, hostiles: [z] });
  h.sb.api.wireFightBreaker();
  h.bot.pvp.attack(z);
  h.bot.health = 9; h.bot.emit('health');   // sous 10 → abandon
  assert.ok(h.events.some((e) => e.type === 'fight_aborted' && e.reason === 'floor'));
  h.bot.entity.position.x = 6;              // il a fui (pas acculé)
  h.bot.pvp.attack(z);
  assert.deepStrictEqual(h.attacked, ['zombie'], 'pas de 2ᵉ attaque');
  assert.ok(h.events.some((e) => e.type === 'fight_refused'));
});

test('wireFightBreaker : PV 14 face à 2 hostiles → engagement refusé dès le départ', () => {
  const h = setup({ health: 14.12, hostiles: [zombie(3), zombie(4)] });
  h.sb.api.wireFightBreaker();
  h.bot.pvp.attack(zombie(3));
  assert.deepStrictEqual(h.attacked, []);
  const r = h.events.find((e) => e.type === 'fight_refused');
  assert.strictEqual(r.reason, 'low_hp');
});

test('wireFightBreaker : le gibier n\'est jamais filtré', () => {
  const h = setup({ health: 5, hostiles: [] });
  h.sb.api.wireFightBreaker();
  h.bot.pvp.attack({ name: 'cow', kind: 'Passive mobs', position: { x: 1, y: -6, z: 0 } });
  assert.deepStrictEqual(h.attacked, ['cow']);
});

test('fightGateDeps : vide pour un cartographe', () => {
  const h = setup();
  h.sb.IS_MAPPER = true;
  h.sb.api.wireFightBreaker();
  assert.deepStrictEqual(Object.keys(h.sb.api.fightGateDeps()), []);
});

test('wireFightBreaker : garde le pvp.attack d\'origine pour la charge sur squelette (hors porte)', () => {
  const h = setup({ health: 9, hostiles: [zombie(3)] });
  h.sb.api.wireFightBreaker();
  assert.strictEqual(typeof h.sb.api.raw, 'function');
  h.sb.api.raw(zombie(3));                  // 9 PV : la porte refuserait, l'original attaque
  assert.deepStrictEqual(h.attacked, ['zombie']);
});

// ARMURÉ CONTRE UN ZOMBIE SEUL (26/10) : NethBot3 en fer complet, épée de fer, `fight_aborted hp:11.7
// drop:6.1 hostiles:1 reason:drop duel:false` → fuite → mort 3 s plus tard. En armure, plus d'abandon.
const FB = require('./fightBreaker');
const SV = require('./survival');
function armoredExtra(pieces = 4, items = [{ name: 'iron_sword' }]) {
  const slots = [];
  ['iron_helmet', 'iron_chestplate', 'iron_leggings', 'iron_boots'].slice(0, pieces).forEach((n, i) => { slots[5 + i] = { name: n }; });
  return { slots, items };
}
function armoredSetup(health, hostiles, pieces, items) {
  const h = setup({ health, hostiles, extra: {
    isZombieDuel: FB.isZombieDuel, isLoneZombieContact: FB.isLoneZombieContact, isArmoredLoneZombie: FB.isArmoredLoneZombie,
    ARMORED_LONE_CREEPER_DIST: FB.ARMORED_LONE_CREEPER_DIST, attackDamage: SV.attackDamage, armorPieces: SV.armorPieces,
  } });
  const a = armoredExtra(pieces, items);
  h.bot.inventory = { slots: a.slots, items: () => a.items };
  return h;
}

test('armuré (fer complet) + épée, zombie seul à 5 blocs : chute 17,8 → 11,7 → PAS d\'abandon', () => {
  const z = zombie(5);
  const h = armoredSetup(17.8, [z], 4);
  h.sb.api.wireFightBreaker();
  h.bot.pvp.attack(z);
  h.bot.health = 11.7; h.bot.emit('health');
  assert.ok(!h.events.some((e) => e.type === 'fight_aborted'), 'aucun abandon');
  assert.strictEqual(h.stops, 0);
  assert.strictEqual(h.fled, 0);
  // même sous le plancher de 10 : le combat continue
  h.bot.health = 5; h.bot.emit('health');
  assert.ok(!h.events.some((e) => e.type === 'fight_aborted'));
});

test('sans armure, même scène → abandon « drop » (inchangé) ; l\'event porte names/atk', () => {
  const z = zombie(5);
  const h = armoredSetup(17.8, [z], 0, []);
  h.sb.api.wireFightBreaker();
  h.bot.pvp.attack(z);
  h.bot.health = 11.7; h.bot.emit('health');
  const ab = h.events.find((e) => e.type === 'fight_aborted');
  assert.ok(ab);
  assert.strictEqual(ab.reason, 'drop');
  assert.strictEqual(JSON.stringify(ab.names), '["zombie"]');
  assert.strictEqual(ab.atk, 0);
  assert.strictEqual(ab.armored_lone, false);
});

test('armuré mais creeper à 4 blocs : le creeper prime (abandon possible)', () => {
  const z = zombie(5);
  const c = { name: 'creeper', kind: 'Hostile mobs', position: { x: -4, y: -6, z: 0 } };
  const h = armoredSetup(17.8, [z, c], 4);
  h.sb.api.wireFightBreaker();
  h.bot.pvp.attack(z);
  h.bot.health = 9; h.bot.emit('health');
  assert.ok(h.events.some((e) => e.type === 'fight_aborted'));
});

test('cartographe armuré : pas de dernier carré armuré', () => {
  const h = armoredSetup(17.8, [zombie(5)], 4);
  h.sb.IS_MAPPER = true;
  assert.strictEqual(vm.runInContext('_fightSituation().armoredLone', h.sb), false);
});
