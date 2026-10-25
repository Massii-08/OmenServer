'use strict';
// Câblage index.js du bouclier tenu en continu (25/10). Sandbox vm : fonctions de NIVEAU MODULE extraites
// (piège #56) sur un faux bot. Mesure live d'origine : NethBot3 session 744, 4 pièces de fer + bouclier en
// main secondaire, mort 3× « shot by Skeleton » sans avoir levé le bouclier (items() ne voit pas le slot 45).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { shieldItem, shieldStance, shieldAction } = require('./shieldGuard');
const { shooterSees } = require('./skeletonResponse');
const { RANGED } = require('./reflexes');

const SRC = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');
const grab = (re, label) => { const m = SRC.match(re); assert.ok(m, `${label} introuvable`); return m[0]; };
const fnSrc = (n) => grab(new RegExp(`^(?:async )?function ${n}\\([^)]*\\) \\{[\\s\\S]*?^\\}$`, 'm'), n);
const constSrc = (n) => grab(new RegExp(`^const ${n} = [^;]+;`, 'm'), n);

function setup({ offhand = { name: 'shield' }, bag = [], skel = { x: 8, y: 64, z: 0 }, wall = false, pvpTarget = null, using = false } = {}) {
  const calls = { act: [], deact: 0, equip: [], look: 0 };
  const slots = []; slots[45] = offhand;
  const ents = {};
  if (skel) ents[7] = { id: 7, name: 'skeleton', type: 'hostile', position: Object.assign({ offset: (a, b, c) => ({ x: skel.x + a, y: skel.y + b, z: skel.z + c }) }, skel) };
  const bot = {
    health: 20, entity: { id: 1, position: { x: 0, y: 64, z: 0 } }, entities: ents,
    inventory: { slots, items: () => bag },
    usingHeldItem: using,
    pvp: { target: pvpTarget },
    pathfinder: { isMoving: () => false },
    blockAt: (v) => ({ boundingBox: (v.y <= 63 || (wall && v.x === 4 && v.y <= 66)) ? 'block' : 'empty', shapes: [[0, 0, 0, 1, 1, 1]] }),
    activateItem(off) { calls.act.push(!!off); this.usingHeldItem = true; },
    deactivateItem() { calls.deact++; this.usingHeldItem = false; },
    equip: async (it, dest) => { calls.equip.push([it.name, dest]); },
    lookAt: async () => { calls.look++; },
    on() {},
  };
  const events = [];
  const sb = { bot, RANGED, shooterSees, shieldItem, shieldStance, shieldAction, Date, Math, Object,
    emit: (e) => events.push(e), vec3Lib: (x, y, z) => ({ x, y, z }) };
  vm.createContext(sb);
  vm.runInContext(`'use strict';
    ${constSrc('SKEL_RANGE')}
    let _shieldRaised = false; let _shieldGuardWant = false; let _shieldWrappedBot = null;
    let _shieldEquipAt = -Infinity; let _shieldEmitAt = -Infinity; let _shieldRaises = 0; let _skelRushBusy = false;
    ${['_skelBlockAt', 'skeletonSees', '_skelShield', 'shieldPulseRelease', 'wireShieldGuard', 'shieldGuardTick'].map(fnSrc).join('\n')}
    globalThis.api = { tick: shieldGuardTick, shield: _skelShield, release: shieldPulseRelease,
      get raised() { return _shieldRaised; }, get want() { return _shieldGuardWant; } };`, sb);
  return { bot, sb, calls, events };
}

test('_skelShield trouve le bouclier en MAIN SECONDAIRE (avant : null → jamais levé)', () => {
  const h = setup();
  assert.strictEqual(h.sb.api.shield().name, 'shield');
});

test('squelette qui voit le bot à 8 blocs → bouclier levé (main secondaire), UNE seule fois sur 3 ticks', () => {
  const h = setup();
  h.sb.api.tick(); h.sb.api.tick(); h.sb.api.tick();
  assert.deepStrictEqual(h.calls.act, [true], 'pas de relance de use_item (délai vanilla de 5 ticks)');
  assert.strictEqual(h.sb.api.raised, true);
  assert.ok(h.events.some((e) => e.type === 'shield_guard' && e.act === 'raise'));
  assert.ok(h.calls.look >= 1, 'face au tireur à l\'arrêt');
});

test('l\'impulsion historique de 2 s ne baisse PAS un bouclier que le garde tient', () => {
  const h = setup();
  h.sb.api.tick();
  assert.strictEqual(h.sb.api.release(), false);
  assert.strictEqual(h.calls.deact, 0);
});

test('squelette disparu → bouclier baissé', () => {
  const h = setup();
  h.sb.api.tick();
  delete h.bot.entities[7];
  h.sb.api.tick();
  assert.strictEqual(h.calls.deact, 1);
  assert.strictEqual(h.sb.api.raised, false);
});

test('mur entre les deux (pas de ligne de vue) → pas levé', () => {
  const h = setup({ wall: true });
  h.sb.api.tick();
  assert.deepStrictEqual(h.calls.act, []);
});

test('cible pvp à portée de coup → baissé pour frapper', () => {
  const h = setup({ skel: { x: 2, y: 64, z: 0 } });
  h.bot.pvp.target = h.bot.entities[7];
  h.sb.api.tick();
  assert.deepStrictEqual(h.calls.act, []);
});

test('repas en cours (main principale utilisée) → on ne l\'interrompt pas', () => {
  const h = setup({ using: true });
  h.sb.api.tick();
  assert.deepStrictEqual(h.calls.act, []);
  assert.strictEqual(h.calls.deact, 0);
});

test('bouclier dans le SAC + tireur qui voit → équipé en main secondaire', () => {
  const h = setup({ offhand: null, bag: [{ name: 'shield' }] });
  h.sb.api.tick();
  assert.deepStrictEqual(h.calls.equip, [['shield', 'off-hand']]);
});
