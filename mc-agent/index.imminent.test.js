'use strict';
// ESSAIM 6-10 PV + GROTTE BLESSÉ (chrono 22/10 12:10-14:36) — le CÂBLAGE d'index.js, EXÉCUTÉ.
//
// La logique est testée dans homewarp.test.js (swarmEscapeEarly) et caveIron.test.js (caveHpOk). Ici on
// extrait le texte RÉEL des fonctions de glue et on l'exécute dans un bac à sable `vm` strict qui ne
// contient que ce que le module fournit au niveau module : un identifiant oublié ou un `let` déclaré
// dans onSpawn lève une ReferenceError ici, pas en prod (pièges #56/#61).

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const homewarp = require('./homewarp');
const caveIronPick = require('./caveIron');

const SRC = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');
function grab(re, label) {
  const m = SRC.match(re);
  assert.ok(m, `${label} introuvable dans index.js (déplacé, renommé, ou déclaré hors niveau module ?)`);
  return m[0];
}
const fnSrc = (name) => grab(new RegExp(`^(?:async )?function ${name}\\([^)]*\\) \\{[\\s\\S]*?^\\}$`, 'm'), `function ${name}`);
const run = (sb, code) => vm.runInContext("'use strict';\n" + code, sb);

const T0 = 1_700_000_000_000;

function glue({ health = 20, hostiles = 0, worn = 0, water = false, refusedAt, veto = false, food = 15, cave = { key: 'c1' } } = {}) {
  const sb = {
    events: [], clock: { t: T0 }, vetoCalls: 0,
    bot: { health, food, oxygenLevel: 20 },
    homewarp, caveIronPick,
    isInWater: () => water,
    lavaNearby: () => false,
    nearbyHostiles: () => Array.from({ length: hostiles }, () => ({ name: 'zombie' })),
    _wornArmor: () => new Set(Array.from({ length: worn }, (_, i) => `p${i}`)),
    _homeRefusedAt: refusedAt ? { safe: refusedAt } : {},
    ironCaveCtx: () => cave,
  };
  sb.emit = (e) => sb.events.push(e);
  sb.Date = { now: () => sb.clock.t };
  sb.safeHomeVeto = () => { sb.vetoCalls++; return veto ? { why: 'camped' } : null; };
  vm.createContext(sb);
  run(sb, grab(/^let _caveLowHpEmitAt = 0;$/m, 'let _caveLowHpEmitAt (niveau module)'));
  for (const f of ['imminentState', 'imminentVerdictNow', 'ironCaveForPlanner']) run(sb, fnSrc(f));
  run(sb, 'globalThis.api = { imminentState, imminentVerdictNow, ironCaveForPlanner };');
  return sb;
}

test('watchdog PV : 9 PV, 2 mobs, nu → départ anticipé (escape, early)', () => {
  const sb = glue({ health: 9, hostiles: 2, worn: 0 });
  const s = sb.api.imminentState();
  assert.strictEqual(s.armorPieces, 0);
  assert.strictEqual(s.nearbyHostiles, 2);
  assert.deepStrictEqual({ ...sb.api.imminentVerdictNow(s) }, { verdict: 'escape', early: true });
});

test('watchdog PV : bande 6-10 dégradée (home campé / refusé) → null, jamais escape_no_warp (rester planté à 9 PV)', () => {
  const camped = glue({ health: 9, hostiles: 3, worn: 1, veto: true });
  assert.deepStrictEqual({ ...camped.api.imminentVerdictNow(camped.api.imminentState()) }, { verdict: null, early: true });
  const refused = glue({ health: 9, hostiles: 3, worn: 1, refusedAt: T0 - 1000 });
  assert.deepStrictEqual({ ...refused.api.imminentVerdictNow(refused.api.imminentState()) }, { verdict: null, early: true });
});

test('watchdog PV : ≤ 6 PV inchangé (escape, escape_no_warp si campé, bookmark à un mob)', () => {
  const a = glue({ health: 4, hostiles: 2, worn: 4 });
  assert.deepStrictEqual({ ...a.api.imminentVerdictNow(a.api.imminentState()) }, { verdict: 'escape', early: false });
  const b = glue({ health: 4, hostiles: 2, veto: true });
  assert.strictEqual(b.api.imminentVerdictNow(b.api.imminentState()).verdict, 'escape_no_warp');
  const c = glue({ health: 3, hostiles: 1 });
  assert.strictEqual(c.api.imminentVerdictNow(c.api.imminentState()).verdict, 'bookmark');
});

test('watchdog PV : fer complet ou un seul mob à 9 PV → rien (et le veto n\'est même pas lu)', () => {
  const full = glue({ health: 9, hostiles: 3, worn: 4 });
  assert.strictEqual(full.api.imminentVerdictNow(full.api.imminentState()).verdict, null);
  assert.strictEqual(full.vetoCalls, 0);
  const one = glue({ health: 9, hostiles: 1, worn: 0 });
  assert.strictEqual(one.api.imminentVerdictNow(one.api.imminentState()).verdict, null);
});

test('le watchdog d\'index.js passe bien par imminentState + imminentVerdictNow, et la bande essaim ne note pas de camp de mort', () => {
  assert.match(SRC, /const s = imminentState\(\);\s*\n[\s\S]{0,300}const \{ verdict, early \} = imminentVerdictNow\(s\);/);
  assert.match(SRC, /if \(!early\) \{\s*\n\s*const pZ = bot\.entity && bot\.entity\.position;\s*\n\s*if \(pZ\) \{\s*\n\s*const dz = deathzones\.note\(/);
});

test('planner : grotte sautée sous 12 PV (event throttlé 1 / min), visée au-dessus', () => {
  const sb = glue({ health: 5, food: 14 });
  assert.strictEqual(sb.api.ironCaveForPlanner(), null);
  assert.strictEqual(sb.api.ironCaveForPlanner(), null);
  assert.strictEqual(sb.events.filter((e) => e.type === 'cave_skipped_low_hp').length, 1);
  assert.deepStrictEqual({ ...sb.events[0] }, { type: 'cave_skipped_low_hp', hp: 5, food: 14 });
  sb.clock.t += 61000;
  sb.api.ironCaveForPlanner();
  assert.strictEqual(sb.events.filter((e) => e.type === 'cave_skipped_low_hp').length, 2);
  sb.bot.health = 12;
  assert.deepStrictEqual({ ...sb.api.ironCaveForPlanner() }, { key: 'c1' });
});

test('le ctx du planner lit ironCaveForPlanner (pas ironCaveCtx en direct)', () => {
  assert.match(SRC, /^\s*ironCave: ironCaveForPlanner\(\),$/m);
});
