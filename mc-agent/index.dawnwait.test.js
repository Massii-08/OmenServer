'use strict';
// CÂBLAGE de l'attente à l'aube dans l'abri (live 19/10, spawn sous la canopée d'une vieille forêt).
//
// La LOGIQUE est testée ailleurs : la décision pure dans skills/shelter.test.js (dawnExitDecision), le
// flux de l'abri dans test/shelter.test.js, le balayage d'hostiles dans unstuck.test.js. Ce fichier teste
// la GLUE de index.js : ce que `maybeNightShelter` passe réellement à `shelterUntilDawn`. Une glue qui
// oublie de brancher le prédicat n'échoue JAMAIS : `deps.hostilesNear` absent = « aucune attente »,
// exactement l'ancien comportement — la fonctionnalité serait morte sans une erreur, tests verts
// (piège #61). D'où l'exécution du VRAI texte de index.js dans un bac à sable `vm` strict (même
// technique que index.spawnflee.test.js) : un identifiant oublié lève une ReferenceError.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const CR = require('./creeper');
const SRC = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');
const U = require('./unstuck');
const SH = require('./skills/shelter');
const C = require('./caution');
const { isFleeHostile } = require('./skills/fleeFrom');
const { NEUTRAL_NO_PROVOKE } = require('./survival');

function grab(re, label) {
  const m = SRC.match(re);
  assert.ok(m, `${label} introuvable dans index.js (déplacé, renommé, ou déclaré hors niveau module ?)`);
  return m[0];
}
/** Une fonction déclarée au niveau MODULE (colonne 0) — `^}` ferme la fonction, jamais un bloc interne. */
const fnSrc = (name) => grab(new RegExp(`^(?:async )?function ${name}\\([^)]*\\) \\{[\\s\\S]*?^\\}$`, 'm'), `function ${name}`);
const run = (sb, code) => vm.runInContext("'use strict';\n" + code, sb);

const zombie = (dx, dz = 0, name = 'zombie', extra = {}) =>
  Object.assign({ name, kind: 'Hostile mobs', position: { x: dx, y: 70, z: dz }, isValid: true }, extra);

/** Bac à sable = le niveau MODULE de index.js, réduit à ce que ces fonctions ont le droit de lire. */
function sandbox(extra = {}) {
  const sb = {
    events: [],
    emit(e) { sb.events.push(e); },
    isFleeHostile, NEUTRAL_NO_PROVOKE, hostilesWithin: U.hostilesWithin, creeperIsThreat: CR.creeperIsThreat,
    ...extra,
  };
  return vm.createContext(sb);
}
function withPredicate(extra = {}) {
  const sb = sandbox(extra);
  run(sb, fnSrc('isThreatHostile'));
  run(sb, fnSrc('hostilesNearNow'));
  return sb;
}
const botAt = (entities, position = { x: 0, y: 70, z: 0 }) =>
  ({ entity: position && { position }, entities: Object.assign({}, entities) });

// ═════════════════════ 1. le prédicat hostile COMMUN (spawn + abri) ═════════════════════════════════
test('isThreatHostile : zombie/squelette (kind) et creeper QUI GONFLE (par nom) oui ; enderman neutre, vache, entité retirée, null non', () => {
  const sb = withPredicate({ bot: botAt([]) });
  assert.strictEqual(sb.isThreatHostile(zombie(3)), true);
  const swell = []; swell[CR.SWELL_DIR_INDEX] = 1;
  assert.strictEqual(sb.isThreatHostile({ name: 'creeper', position: { x: 1, y: 70, z: 0 }, metadata: swell }), true, 'listé par nom, kind pas résolu');
  // AltoClef 20/10 : un creeper CALME n'est pas une raison de se terrer (il s'évite, cf. creeper.js)
  assert.strictEqual(sb.isThreatHostile({ name: 'creeper', position: { x: 1, y: 70, z: 0 } }), false, 'creeper calme : pas une menace');
  assert.strictEqual(sb.isThreatHostile({ name: 'creeper', position: { x: 9, y: 70, z: 0 }, metadata: swell }), false, 'gonfle mais à > 7 blocs');
  assert.strictEqual(sb.isThreatHostile(zombie(3, 0, 'enderman')), false, 'neutre tant qu on ne le regarde pas');
  assert.strictEqual(sb.isThreatHostile({ name: 'cow', kind: 'Passive mobs', position: { x: 1, y: 70, z: 0 } }), false);
  assert.strictEqual(sb.isThreatHostile(zombie(3, 0, 'zombie', { isValid: false })), false, 'entité retirée du monde');
  assert.strictEqual(sb.isThreatHostile(null), false);
  assert.strictEqual(sb.isThreatHostile(undefined), false);
});

test('index.js : spawnDangerNow et hostilesNearNow partagent LE MÊME prédicat (isThreatHostile) — pas deux lectures du mot « hostile »', () => {
  assert.match(fnSrc('spawnDangerNow'), /isHostile: isThreatHostile/);
  assert.match(fnSrc('hostilesNearNow'), /isHostile: isThreatHostile/);
  assert.ok(!/isFleeHostile\(e\) && !NEUTRAL_NO_PROVOKE/.test(fnSrc('spawnDangerNow')), 'plus de copie inline du prédicat dans spawnDangerNow');
});

// ═════════════════════ 2. hostilesNearNow : le relevé injecté dans l'abri ═══════════════════════════
test('hostilesNearNow : compte les hostiles à ≤ 12 blocs (3D), pas les lointains, pas les neutres', () => {
  const sb = withPredicate({
    bot: botAt([zombie(5), zombie(9, 3, 'skeleton'), zombie(12, 0, 'creeper'), zombie(20), zombie(3, 0, 'enderman'),
      { name: 'cow', kind: 'Passive mobs', position: { x: 2, y: 70, z: 0 } }]),
  });
  // AJUSTÉ (20/10) : le creeper CALME à 12 blocs ne compte plus (creeper.js) → zombie 5 + squelette ~9,5
  assert.strictEqual(sb.hostilesNearNow(), 2, 'zombie 5, squelette ~9,5 ; le creeper calme ne compte pas');
});

test('hostilesNearNow : personne autour → 0 ; bot sans position → 0 ; relevé qui lève → 0 (jamais coincé dans le trou)', () => {
  assert.strictEqual(withPredicate({ bot: botAt([]) }).hostilesNearNow(), 0);
  assert.strictEqual(withPredicate({ bot: botAt([zombie(3)], null) }).hostilesNearNow(), 0);
  const exploding = withPredicate({ bot: { entity: { position: { x: 0, y: 70, z: 0 } }, get entities() { throw new Error('boom'); } } });
  assert.strictEqual(exploding.hostilesNearNow(), 0);
});

test('hostilesNearNow : relu à CHAQUE appel (le monde bouge pendant l\'attente), jamais mis en cache', () => {
  const bot = botAt([zombie(4)]);
  const sb = withPredicate({ bot });
  assert.strictEqual(sb.hostilesNearNow(), 1);
  bot.entities = { 1: zombie(40) };                 // il est parti
  assert.strictEqual(sb.hostilesNearNow(), 0);
  bot.entities = { 1: zombie(4), 2: zombie(6) };
  assert.strictEqual(sb.hostilesNearNow(), 2);
});

// ═════════════════════ 3. maybeNightShelter : ce qui est VRAIMENT passé à shelterUntilDawn ══════════
function shelterSandbox({ worn = 0, entities = [zombie(6), zombie(8, 2, 'skeleton')] } = {}) {
  const captured = { calls: [], timeouts: [] };
  const bot = Object.assign(botAt(entities), {
    health: 20,
    blockAt: () => ({ light: 3 }),
    nearestEntity: () => null,
  });
  bot.entity.position.floored = () => bot.entity.position;
  const sb = sandbox({
    captured, bot,
    deathTimes: [],
    Date: { now: () => 1_700_000_000_000 },
    lastShelterT: 0, _stillBusy: false, taskToken: { cancelled: false },
    FORCED_SHELTER_MIN_GAP_MS: 60000, IS_MAPPER: false, _safeHomeSet: false,
    homewarp: { goHome() {} }, sleep: async () => {}, stopMotion() {},
    _wornArmor: () => new Set(['iron_helmet', 'iron_boots', 'iron_leggings', 'iron_chestplate'].slice(0, worn)),
    isNight: () => true,
    shouldShelter: SH.shouldShelter,
    DAWN_WAIT_MAX_MS: SH.DAWN_WAIT_MAX_MS, DAWN_SAFE_EXIT_MAX_MS: SH.DAWN_SAFE_EXIT_MAX_MS,
    // sortie sûre (20/10) : testée dans index.dawnexit.test.js ; ici, seulement présente
    dawnExitThreatsNow: () => ({ hostiles: 0, creepers: 0 }), exitAwayFromThreats: () => {},
    // le shelterUntilDawn « réel » du test : il capture les deps, qui sont ce qu'on veut vérifier
    shelterUntilDawn: async (b, tok, deps) => { captured.calls.push({ b, tok, deps }); return { ok: true }; },
    withTimeout: (p, ms) => { captured.timeouts.push(ms); return p; },
    // discipline de nuit (19/10 soir) : ce que maybeNightShelter lit en plus — un seul abri à la fois,
    // l'écart de 20 s en lockdown, la comptabilité des ré-abris (cf. index.nightlockdown.test.js).
    // Ce bot n'a pas de `bot.time` : heure inconnue → pas de lockdown → comportement d'avant, à l'identique.
    _shelterInFlight: null, _lockdownShelters: null, isInWater: () => false,
    nightLockdown: C.nightLockdown, lockdownShelterNote: C.lockdownShelterNote,
    NIGHT_SHELTER_GAP_MS: C.NIGHT_SHELTER_GAP_MS, NIGHT_UNDERGROUND_Y: C.NIGHT_UNDERGROUND_Y,
  });
  run(sb, fnSrc('isThreatHostile'));
  run(sb, fnSrc('hostilesNearNow'));
  run(sb, fnSrc('nightLockdownNow'));
  run(sb, fnSrc('maybeNightShelter'));
  return sb;
}

test('maybeNightShelter : passe à shelterUntilDawn le relevé d hostiles ET le compte de pièces portées (sinon l attente est morte, sans erreur)', async () => {
  const sb = shelterSandbox({ worn: 1 });
  assert.strictEqual(await sb.maybeNightShelter(true), true, 'nuit + proactif → il s abrite');
  assert.strictEqual(sb.captured.calls.length, 1);
  const deps = sb.captured.calls[0].deps;
  assert.strictEqual(typeof deps.hostilesNear, 'function', 'deps.hostilesNear DOIT être branché');
  assert.strictEqual(typeof deps.worn, 'function', 'deps.worn DOIT être branché');
  assert.strictEqual(deps.emit, sb.emit, 'et emit reste branché');
  // ce que ces fonctions lisent est bien l'état du bot RÉEL du module, pas une valeur figée
  assert.strictEqual(deps.hostilesNear(), 2, '2 hostiles à ≤ 12 blocs (zombie 6, squelette ~8,2)');
  assert.strictEqual(deps.worn(), 1);
  sb.bot.entities = {};
  assert.strictEqual(deps.hostilesNear(), 0, 'relu à chaque appel');
});

test('maybeNightShelter : les deps injectés, lus par dawnExitDecision, font ATTENDRE un bot nu entouré et SORTIR un bot armé', async () => {
  const nude = shelterSandbox({ worn: 0 });
  await nude.maybeNightShelter(true);
  const dn = nude.captured.calls[0].deps;
  assert.strictEqual(SH.dawnExitDecision({ hostilesNear: dn.hostilesNear(), waitedMs: 0, worn: dn.worn() }), 'wait');

  const armed = shelterSandbox({ worn: 4 });
  await armed.maybeNightShelter(true);
  const da = armed.captured.calls[0].deps;
  assert.strictEqual(SH.dawnExitDecision({ hostilesNear: da.hostilesNear(), waitedMs: 0, worn: da.worn() }), 'go');
});

test('maybeNightShelter : le timeout EXTÉRIEUR laisse la place à l attente de l aube (13 min + 120 s)', async () => {
  const sb = shelterSandbox({ worn: 0 });
  await sb.maybeNightShelter(true);
  assert.strictEqual(sb.captured.timeouts.length, 1);
  assert.ok(sb.captured.timeouts[0] >= 13 * 60 * 1000 + SH.DAWN_WAIT_MAX_MS,
    `le garde-fou de ${sb.captured.timeouts[0]} ms couperait l attente de l aube en plein milieu`);
});

test('maybeNightShelter : pas de nuit, équipé, rien à craindre → ne s abrite pas (inchangé)', async () => {
  const sb = shelterSandbox({ worn: 4, entities: [] });
  sb.isNight = () => false;
  sb.bot.blockAt = () => ({ light: 15 });
  assert.strictEqual(await sb.maybeNightShelter(false), false);
  assert.strictEqual(sb.captured.calls.length, 0);
});

// ═════════════════════ 4. câblage (imports, niveau module) ══════════════════════════════════════════
test('index.js : importe hostilesWithin (unstuck) et DAWN_WAIT_MAX_MS (shelter) — ce que la glue utilise', () => {
  const unstuckImp = grab(/const \{[^}]*\} = require\('\.\/unstuck'\);/, "require('./unstuck')");
  assert.match(unstuckImp, /\bhostilesWithin\b/);
  const shelterImp = grab(/const \{[^}]*\} = require\('\.\/skills\/shelter'\);/, "require('./skills/shelter')");
  assert.match(shelterImp, /\bDAWN_WAIT_MAX_MS\b/);
});

test('index.js : maybeNightShelter appelle shelterUntilDawn avec hostilesNear ET worn (texte du câblage)', () => {
  const body = fnSrc('maybeNightShelter');
  const call = body.slice(body.indexOf('shelterUntilDawn(bot'));
  assert.match(call, /hostilesNear: hostilesNearNow/);
  assert.match(call, /worn: \(\) => _wornArmor\(\)\.size/);
});
