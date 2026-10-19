'use strict';
// CÂBLAGE de la fuite dès le spawn + de l'historique de morts persisté (live 19/10, MapBot1).
//
// La LOGIQUE est testée dans unstuck.test.js (fonctions pures). Ce fichier teste ce qui ne peut pas
// l'être là : la GLUE de index.js — exactement l'endroit où ce projet a déjà perdu des fonctionnalités
// sans une seule erreur (pièges #56 et #61 : un champ lu au mauvais niveau, une couche qui oublie un
// champ, un `let` dans onSpawn lu par un timer → ReferenceError en prod, 1153 tests verts).
//
// Technique : on EXTRAIT le texte réel des fonctions de index.js et on l'EXÉCUTE dans un bac à sable
// `vm` en mode strict, dont le seul contenu est ce que le module fournit vraiment au niveau module.
//   - un identifiant oublié/mal orthographié → ReferenceError (et pas un `undefined` silencieux) ;
//   - une affectation à une variable non déclarée → ReferenceError aussi ('use strict').
// Le smoke test (index.smoke.test.js) charge le module mais n'exécute jamais ces chemins : ni le
// handler `death`, ni `spawn` ne tirent avant qu'un vrai serveur ne parle.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SRC = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');
const U = require('./unstuck');
const { isFleeHostile } = require('./skills/fleeFrom');
const { NEUTRAL_NO_PROVOKE } = require('./survival');

// ── extraction ─────────────────────────────────────────────────────────────────────────────────
function grab(re, label) {
  const m = SRC.match(re);
  assert.ok(m, `${label} introuvable dans index.js (déplacé, renommé, ou déclaré hors niveau module ?)`);
  return m[0];
}
/** Une fonction déclarée au niveau MODULE (colonne 0) — `^}` ferme la fonction, jamais un bloc interne. */
const fnSrc = (name) => grab(new RegExp(`^(?:async )?function ${name}\\([^)]*\\) \\{[\\s\\S]*?^\\}$`, 'm'), `function ${name}`);
/** Un handler `bot.on('<evt>', () => {...});` au niveau module. */
const handlerSrc = (evt) => grab(new RegExp(`^bot\\.on\\('${evt}', \\(\\) => \\{[\\s\\S]*?^\\}\\);$`, 'm'), `bot.on('${evt}')`);

const T0 = 1_700_000_000_000;

/**
 * Bac à sable = le niveau MODULE de index.js, réduit à ce que ces fonctions ont le droit de lire.
 * `disk` est le « fichier » du mémo de base : partagé entre deux bacs, il joue la relance du process.
 */
function sandbox({ disk = { memo: null }, clock = { t: T0 }, ...extra } = {}) {
  const sb = {
    events: [], calls: [], disk, clock,
    emit(e) { sb.events.push(e); },
    Date: { now: () => clock.t },
    // E/S du mémo : on passe par JSON comme le vrai fichier (rien ne survit par référence)
    loadBaseState: () => (disk.memo ? JSON.parse(JSON.stringify(disk.memo)) : null),
    saveBaseState(st) {
      disk.memo = JSON.parse(JSON.stringify(st));
      sb.calls.push('save:' + (Array.isArray(st.deaths) ? st.deaths.length : 'none'));
      return true;
    },
    // fonctions pures RÉELLES (ce que index.js importe de ./unstuck)
    spawnDanger: U.spawnDanger, deathTimesLoad: U.deathTimesLoad, deathTimesPrune: U.deathTimesPrune,
    deathMemoWith: U.deathMemoWith, escapeArmed: U.escapeArmed, deathLoopTripped: U.deathLoopTripped,
    // état de niveau module
    deathTimes: [], _deathHistoryLoaded: false, _escapeOnSpawn: false, _bootAt: clock.t,
    ...extra,
  };
  return vm.createContext(sb);
}
const run = (sb, code) => vm.runInContext("'use strict';\n" + code, sb);

// ═════════════════════════════ 1. spawnDangerNow / armSpawnEscapeIfDanger ═════════════════════════
const zombieAt = (dx, dz = 0, name = 'zombie') =>
  ({ name, kind: 'Hostile mobs', position: { x: dx, y: 70, z: dz }, isValid: true });

function dangerSandbox({ worn = 0, entities = [], position = { x: 0, y: 70, z: 0 }, extra = {} } = {}) {
  const sb = sandbox({
    bot: { entity: position && { position }, entities: Object.assign({}, entities) },
    _wornArmor: () => new Set(['iron_helmet', 'iron_boots', 'iron_leggings', 'iron_chestplate'].slice(0, worn)),
    isFleeHostile, NEUTRAL_NO_PROVOKE,
    ...extra,
  });
  run(sb, fnSrc('isThreatHostile'));    // le prédicat « hostile à craindre » est partagé avec l'abri (cf. index.dawnwait.test.js)
  run(sb, fnSrc('spawnDangerNow'));
  run(sb, fnSrc('armSpawnEscapeIfDanger'));
  return sb;
}

test('spawnDangerNow : bot nu + zombie à 8 blocs → danger (lit VRAIMENT le bot, aucune ReferenceError avalée)', () => {
  const sb = dangerSandbox({ worn: 0, entities: [zombieAt(8)] });
  const d = sb.spawnDangerNow();
  assert.ok(d, 'le danger doit être détecté — null ici = identifiant manquant avalé par le try/catch');
  assert.strictEqual(d.flee, true);
  assert.strictEqual(d.mob, 'zombie');
  assert.strictEqual(d.dist, 8);
  assert.strictEqual(d.worn, 0);
});

test('spawnDangerNow : armure complète → pas de danger même avec un zombie collé', () => {
  assert.strictEqual(dangerSandbox({ worn: 4, entities: [zombieAt(2)] }).spawnDangerNow(), null);
  assert.strictEqual(dangerSandbox({ worn: 2, entities: [zombieAt(2)] }).spawnDangerNow(), null);
  assert.ok(dangerSandbox({ worn: 1, entities: [zombieAt(2)] }).spawnDangerNow(), '1 pièce = encore nu');
});

test('spawnDangerNow : hostile à 20 blocs → pas de danger ; aucun hostile → pas de danger', () => {
  assert.strictEqual(dangerSandbox({ entities: [zombieAt(20)] }).spawnDangerNow(), null);
  assert.strictEqual(dangerSandbox({ entities: [] }).spawnDangerNow(), null);
  assert.strictEqual(dangerSandbox({ entities: [{ name: 'cow', kind: 'Passive mobs', position: { x: 2, y: 70, z: 0 } }] }).spawnDangerNow(), null);
});

test('spawnDangerNow : les mobs listés PAR NOM (kind pas résolu) comptent — même prédicat que escapeDeathCamp', () => {
  const sb = dangerSandbox({ entities: [{ name: 'creeper', position: { x: 5, y: 70, z: 0 }, isValid: true }] });
  const d = sb.spawnDangerNow();
  assert.ok(d && d.mob === 'creeper');
});

test('spawnDangerNow : l enderman (neutre tant qu on ne le regarde pas) ne fait pas fuir ; le zombie derrière, si', () => {
  const ender = zombieAt(3, 0, 'enderman');
  assert.strictEqual(dangerSandbox({ entities: [ender] }).spawnDangerNow(), null);
  const d = dangerSandbox({ entities: [ender, zombieAt(10)] }).spawnDangerNow();
  assert.ok(d && d.mob === 'zombie', 'l enderman ne doit pas masquer le zombie');
});

test('spawnDangerNow : une entité retirée du monde (isValid:false) est ignorée', () => {
  const ghost = Object.assign(zombieAt(4), { isValid: false });
  assert.strictEqual(dangerSandbox({ entities: [ghost] }).spawnDangerNow(), null);
});

test('spawnDangerNow : bot sans position / inventaire qui lève → null, jamais de throw (le spawn ne doit pas casser)', () => {
  assert.strictEqual(dangerSandbox({ position: null, entities: [zombieAt(3)] }).spawnDangerNow(), null);
  const boom = dangerSandbox({ entities: [zombieAt(3)], extra: { _wornArmor: () => { throw new Error('inv'); } } });
  assert.strictEqual(boom.spawnDangerNow(), null);
});

test('armSpawnEscapeIfDanger : danger → arme _escapeOnSpawn et TRACE pourquoi (le silence est un bug)', () => {
  const sb = dangerSandbox({ entities: [zombieAt(8)] });
  assert.strictEqual(sb._escapeOnSpawn, false);
  assert.strictEqual(sb.armSpawnEscapeIfDanger(), true);
  assert.strictEqual(sb._escapeOnSpawn, true);
  const ev = sb.events.find((e) => e.type === 'spawn_danger_flee');
  assert.ok(ev, 'event spawn_danger_flee absent');
  assert.deepStrictEqual({ mob: ev.mob, dist: ev.dist, worn: ev.worn }, { mob: 'zombie', dist: 8, worn: 0 });
});

test('armSpawnEscapeIfDanger : rien à craindre → ne touche à RIEN (pas d event, pas d armement)', () => {
  const sb = dangerSandbox({ entities: [zombieAt(30)] });
  assert.strictEqual(sb.armSpawnEscapeIfDanger(), false);
  assert.strictEqual(sb._escapeOnSpawn, false);
  assert.strictEqual(sb.events.length, 0);
});

test('armSpawnEscapeIfDanger : déjà armé (rafale / historique) → ne ré-évalue pas, n émet rien — UNE fuite par spawn', () => {
  let looked = 0;
  const sb = dangerSandbox({ entities: [zombieAt(5)], extra: { _escapeOnSpawn: true } });
  sb.spawnDangerNow = () => { looked++; return { flee: true, mob: 'zombie', dist: 5, worn: 0 }; };
  assert.strictEqual(sb.armSpawnEscapeIfDanger(), false);
  assert.strictEqual(looked, 0);
  assert.strictEqual(sb._escapeOnSpawn, true);
  assert.strictEqual(sb.events.length, 0);
});

// ═════════════════════════════ 2. historique de morts : charger / persister ═══════════════════════
function historySandbox(opts = {}) {
  const sb = sandbox(opts);
  run(sb, fnSrc('loadDeathHistory'));
  run(sb, fnSrc('persistDeathHistory'));
  return sb;
}

test('loadDeathHistory : relit les morts du mémo, ARME l évasion si la rafale le justifie, et le dit', () => {
  const disk = { memo: { base: { x: 1, y: 70, z: 2 }, deaths: [T0 - 50000, T0 - 40000, T0 - 30000, T0 - 20000, T0 - 10000] } };
  const sb = historySandbox({ disk });
  sb.loadDeathHistory();
  assert.strictEqual(sb.deathTimes.length, 5);
  assert.strictEqual(sb._escapeOnSpawn, true, 'process neuf après une rafale : la fuite est armée dès le 1er spawn');
  const ev = sb.events.find((e) => e.type === 'death_history_loaded');
  assert.deepStrictEqual({ count: ev.count, armed: ev.armed }, { count: 5, armed: true });
});

test('loadDeathHistory : élague au chargement — des morts vieilles d une heure ne ressuscitent pas', () => {
  const disk = { memo: { deaths: [T0 - 60 * 60000, T0 - 59 * 60000, T0 - 58 * 60000, T0 - 90000] } };
  const sb = historySandbox({ disk });
  sb.loadDeathHistory();
  assert.deepStrictEqual(Array.from(sb.deathTimes), [T0 - 90000]);
  assert.strictEqual(sb._escapeOnSpawn, false);
});

test('loadDeathHistory : 2 morts lentes (non armées) → chargées mais PAS de fuite à vide', () => {
  const disk = { memo: { deaths: [T0 - 8 * 60000, T0 - 2 * 60000] } };
  const sb = historySandbox({ disk });
  sb.loadDeathHistory();
  assert.strictEqual(sb.deathTimes.length, 2);
  assert.strictEqual(sb._escapeOnSpawn, false);
  assert.strictEqual(sb.events.find((e) => e.type === 'death_history_loaded').armed, false);
});

test('loadDeathHistory : mémo d ANCIEN format (sans `deaths`) / absent → rien (rétro-compat, pas de bruit)', () => {
  for (const memo of [null, { base: { x: 1, y: 70, z: 2 }, personal: true }, { deaths: 'abc' }]) {
    const sb = historySandbox({ disk: { memo } });
    sb.loadDeathHistory();
    assert.strictEqual(sb.deathTimes.length, 0);
    assert.strictEqual(sb._escapeOnSpawn, false);
    assert.strictEqual(sb.events.length, 0, 'aucun event quand il n y a rien à reprendre');
  }
});

test('loadDeathHistory : UNE fois par process (le spawn se répète à chaque respawn)', () => {
  const disk = { memo: { deaths: [T0 - 5000, T0 - 4000, T0 - 3000] } };
  const sb = historySandbox({ disk });
  sb.loadDeathHistory();
  sb._escapeOnSpawn = false;                                   // consommé par un 1er spawn
  sb.deathTimes = sb.deathTimes.concat([T0 - 1000]);           // une mort survenue depuis, en mémoire
  sb.loadDeathHistory();
  assert.strictEqual(sb._escapeOnSpawn, false, 'ne ré-arme pas à chaque respawn');
  assert.strictEqual(sb.deathTimes.length, 4, 'ne repart pas du fichier (qui n a pas la mort récente)');
  assert.strictEqual(sb.events.filter((e) => e.type === 'death_history_loaded').length, 1);
});

test('loadDeathHistory : ne perd JAMAIS une mort déjà enregistrée en mémoire avant le chargement', () => {
  const disk = { memo: { deaths: [T0 - 20000] } };
  const sb = historySandbox({ disk, deathTimes: [T0 - 2000] });
  sb.loadDeathHistory();
  assert.deepStrictEqual(Array.from(sb.deathTimes), [T0 - 20000, T0 - 2000]);
});

test('persistDeathHistory : écrit `deaths` en PRÉSERVANT base / dette de mort / zone (aller-retour complet)', () => {
  const disk = { memo: {
    base: { x: 10, y: 70, z: -4 }, worldSpawn: { x: 0, z: 0 }, personal: true,
    deathDebt: { x: 1, y: 2, z: 3, at: T0 }, zone: { anchoredAt: T0 - 5000, waterFails: 2 },
  } };
  const sb = historySandbox({ disk, deathTimes: [T0 - 30000, T0 - 1000, T0 - 99 * 60000] });
  assert.strictEqual(sb.persistDeathHistory(), true);
  assert.deepStrictEqual(disk.memo.deaths, [T0 - 30000, T0 - 1000], 'élagué à l écriture');
  assert.deepStrictEqual(disk.memo.base, { x: 10, y: 70, z: -4 });
  assert.deepStrictEqual(disk.memo.deathDebt, { x: 1, y: 2, z: 3, at: T0 });
  assert.deepStrictEqual(disk.memo.zone, { anchoredAt: T0 - 5000, waterFails: 2 });
  assert.strictEqual(disk.memo.personal, true);
});

test('persistDeathHistory : premier lancement (aucun mémo) → crée un mémo qui ne contient que l historique', () => {
  const disk = { memo: null };
  const sb = historySandbox({ disk, deathTimes: [T0 - 1000] });
  assert.strictEqual(sb.persistDeathHistory(), true);
  assert.deepStrictEqual(disk.memo, { deaths: [T0 - 1000] });
});

test('persistDeathHistory : écriture ratée → le DIT (event) et rend false — jamais un échec muet', () => {
  const sb = historySandbox({ deathTimes: [T0 - 1000], saveBaseState: () => false });
  assert.strictEqual(sb.persistDeathHistory(), false);
  assert.ok(sb.events.some((e) => e.type === 'death_history_save_failed'));
});

test('persistDeathHistory : une exception d E/S ne remonte jamais (on est dans un handler de mort)', () => {
  const sb = historySandbox({ deathTimes: [T0 - 1000], saveBaseState: () => { throw new Error('EIO'); } });
  assert.strictEqual(sb.persistDeathHistory(), false);
});

// ═════════════════════════════ 3. le handler `death` ══════════════════════════════════════════════
function deathSandbox(opts = {}) {
  const exits = [];
  const handlers = {};
  const sb = historySandbox({
    exits,
    bot: { entity: { position: { x: -3, y: 70, z: -1 } }, on(evt, fn) { handlers[evt] = fn; } },
    lastDeath: null,
    deathSpots: { noteDeath: () => null },
    abandonWorkIfDeathSpot: () => {},
    // HOME CAMPÉ (19/10) : la position de la mort est notée par le handler (glue réelle testée plus bas
    // et dans index.homesafety.test.js) — ici un témoin qui trace l'ordre des écritures.
    recordDeathPosition: () => { sb.calls.push('pos'); return true; },
    taskCtl: { cancel: () => {} },
    process: { exit(code) { exits.push(code); sb.calls.push('exit:' + code); } },
    ...opts,
  });
  run(sb, handlerSrc('death'));
  sb.die = (atMs) => { sb.clock.t = atMs; handlers.death(); };
  return sb;
}

test('handler death : enregistre la mort, la PERSISTE, arme l évasion à la 2ᵉ mort en rafale', () => {
  const sb = deathSandbox();
  sb.die(T0 + 5000);
  assert.strictEqual(sb.disk.memo.deaths.length, 1);
  assert.strictEqual(sb._escapeOnSpawn, false, '1 mort isolée n arme rien');
  sb.die(T0 + 12000);
  assert.strictEqual(sb.disk.memo.deaths.length, 2);
  assert.strictEqual(sb._escapeOnSpawn, true, '2 morts en < 60 s : rafale');
  assert.deepStrictEqual(sb.exits, []);
});

test('handler death : 3 morts espacées dans les 10 min arment aussi (camping lent, comportement d avant)', () => {
  const sb = deathSandbox();
  sb.die(T0 + 1 * 60000);
  sb.die(T0 + 4 * 60000);
  assert.strictEqual(sb._escapeOnSpawn, false);
  sb.die(T0 + 8 * 60000);
  assert.strictEqual(sb._escapeOnSpawn, true);
});

test('handler death : la 5ᵉ mort PERSISTE l historique COMPLET AVANT process.exit(2) — la relance ne repart pas de zéro', () => {
  const sb = deathSandbox();
  for (const s of [5, 12, 17, 34]) sb.die(T0 + s * 1000);
  assert.deepStrictEqual(sb.exits, []);
  sb.die(T0 + 36 * 1000);                                      // 5ᵉ mort : death_loop
  assert.deepStrictEqual(sb.exits, [2]);
  const exitAt = sb.calls.indexOf('exit:2');
  assert.ok(exitAt > 0);
  assert.ok(sb.calls.slice(0, exitAt).includes('save:5'), `5 morts sur disque AVANT la sortie (journal: ${sb.calls.join(' ')})`);
  assert.strictEqual(sb.disk.memo.deaths.length, 5);
  assert.ok(sb.events.some((e) => e.type === 'autonomous_stalled' && e.reason === 'death_loop'));
});

test('handler death : écriture du mémo ratée AVANT la sortie → l event le dit (la relance repartira de zéro, on le SAIT)', () => {
  const sb = deathSandbox({ saveBaseState: () => false });
  for (const s of [5, 12, 17, 34, 36]) sb.die(T0 + s * 1000);
  assert.deepStrictEqual(sb.exits, [2]);
  assert.ok(sb.events.some((e) => e.type === 'death_history_save_failed'));
});

test('GÉNÉRATIONS : le process B (mémoire vide, même fichier) fuit dès son 1er spawn et NE ressort PAS à sa 1ʳᵉ mort', () => {
  // Process A : la rafale du journal du 19/10
  const disk = { memo: { base: { x: 10, y: 70, z: -4 }, zone: { anchoredAt: T0 - 1000 } } };
  const A = deathSandbox({ disk, clock: { t: T0 }, _bootAt: T0 });
  for (const s of [5, 12, 17, 34, 36]) A.die(T0 + s * 1000);
  assert.deepStrictEqual(A.exits, [2]);

  // Process B : relancé 25 s plus tard — MÉMOIRE NEUVE, seul le fichier a survécu
  const tB = T0 + 36 * 1000 + 25 * 1000;
  const B = deathSandbox({ disk, clock: { t: tB }, _bootAt: tB });
  assert.strictEqual(B.deathTimes.length, 0, 'mémoire neuve');
  B.loadDeathHistory();                                        // ce que fait bot.on('spawn')
  assert.strictEqual(B.deathTimes.length, 5);
  assert.strictEqual(B._escapeOnSpawn, true, 'le spawn de B fuit AVANT toute mort');

  // …et la 1ʳᵉ mort de B ne le renvoie PAS au death_loop (sinon vies < 15 s → give_up backend)
  B.die(tB + 6000);
  assert.deepStrictEqual(B.exits, [], 'les morts héritées ne comptent pas pour la sortie');
  assert.strictEqual(B.disk.memo.deaths.length, 6);
  assert.deepStrictEqual(B.disk.memo.base, { x: 10, y: 70, z: -4 }, 'les autres champs du mémo ont survécu');
  assert.deepStrictEqual(B.disk.memo.zone, { anchoredAt: T0 - 1000 });

  // B ne sort que sur SES 5 morts
  for (const s of [9, 12, 15, 18]) B.die(tB + s * 1000);
  assert.deepStrictEqual(B.exits, [2], 'la 5ᵉ mort PROPRE de B déclenche la sortie');
});

test('handler death : la POSITION de chaque mort est persistée (deathPos) AVANT process.exit(2) — le process suivant saura que son home est campé', () => {
  const H = require('./homeSafety');
  const atExit = [];
  const sb = deathSandbox({
    deathPosPrune: H.deathPosPrune, deathPosLoad: H.deathPosLoad, deathPosMemoWith: H.deathPosMemoWith,
    _deathPos: [], _deathPosLoaded: false,
  });
  run(sb, fnSrc('loadDeathPositions'));
  run(sb, fnSrc('recordDeathPosition'));                       // la vraie glue remplace le témoin
  sb.process.exit = (code) => { atExit.push((sb.disk.memo.deathPos || []).length); sb.exits.push(code); };
  for (const s of [5, 12, 17, 34, 36]) sb.die(T0 + s * 1000);
  assert.deepStrictEqual(sb.exits, [2]);
  assert.deepStrictEqual(atExit, [5], '5 positions sur disque au moment de la sortie');
  assert.deepStrictEqual(sb.disk.memo.deathPos[4], { x: -3, y: 70, z: -1, at: T0 + 36000 });
  assert.strictEqual(sb.disk.memo.deaths.length, 5, 'l historique des instants est intact, à côté');
  // le process suivant (même fichier, mémoire neuve) juge le home du spawn campé dès son 1er spawn
  const tB = T0 + 61000;
  assert.strictEqual(H.homeCamped({ home: { x: -3, y: 70, z: -1 }, deaths: H.deathPosLoad(sb.disk.memo, tB), now: tB }), true);
});

test('handler death : sans chargement préalable, il charge lui-même (jamais une mort écrite sur un historique pas relu)', () => {
  const disk = { memo: { deaths: [T0 - 20000, T0 - 10000] } };
  const sb = deathSandbox({ disk });
  sb.die(T0 + 1000);
  assert.strictEqual(sb.disk.memo.deaths.length, 3, 'les 2 morts héritées + la nouvelle, pas la nouvelle seule');
});

// ═════════════════════════════ 4. le handler `spawn` ══════════════════════════════════════════════
test('handler spawn : relit l historique AVANT onSpawn (sinon _escapeOnSpawn est lu trop tôt)', () => {
  const order = [];
  const handlers = {};
  const sb = sandbox({
    bot: { on(evt, fn) { handlers[evt] = fn; } },
    _floatSettleUntil: 0, _zoneAnchoredAt: 0,
    loadZoneState: () => order.push('zone'),
    loadDeathHistory: () => order.push('history'),
    survivalKitUp: () => { order.push('kit'); return Promise.resolve(); },
    onSpawn: () => { order.push('onSpawn'); return Promise.resolve(); },
  });
  run(sb, handlerSrc('spawn'));
  handlers.spawn();
  assert.ok(order.includes('history'), `loadDeathHistory() doit être appelé dans le handler spawn (vu: ${order.join(' ')})`);
  assert.ok(order.indexOf('history') < order.indexOf('onSpawn'));
});

// ═════════════════════════════ 5. câblage (niveau module, ordre, aller-retour du mémo) ════════════
test('index.js : les gardes de l historique sont de NIVEAU MODULE (colonne 0) — piège #56', () => {
  assert.match(SRC, /^let deathTimes = \[\];/m);
  assert.match(SRC, /^let _deathHistoryLoaded = false;/m, '_deathHistoryLoaded doit être au niveau module, jamais dans onSpawn');
  assert.match(SRC, /^const _bootAt = Date\.now\(\);/m, '_bootAt doit être au niveau module');
  assert.match(SRC, /^let _escapeOnSpawn = false;/m);
});

test('index.js : importe depuis ./unstuck tout ce que la glue utilise', () => {
  const imp = grab(/const \{[^}]*\} = require\('\.\/unstuck'\);/, "require('./unstuck')");
  for (const name of ['spawnDanger', 'deathTimesPrune', 'deathTimesLoad', 'deathMemoWith', 'escapeArmed', 'deathLoopTripped']) {
    assert.ok(new RegExp(`\\b${name}\\b`).test(imp), `${name} manque dans l import de ./unstuck`);
  }
  assert.match(SRC, /const \{ NEUTRAL_NO_PROVOKE \} = require\('\.\/survival'\);/);
});

test('index.js : onSpawn évalue le danger AVANT de consommer _escapeOnSpawn, et la fuite reste attendue (await)', () => {
  const body = grab(/^async function onSpawn\(\) \{[\s\S]*?^\}$/m, 'onSpawn');
  const arm = body.indexOf('armSpawnEscapeIfDanger()');
  const gate = body.indexOf('if (_escapeOnSpawn) {');
  const flee = body.indexOf('await escapeDeathCamp()');
  assert.ok(arm > 0, 'armSpawnEscapeIfDanger() n est pas appelé dans onSpawn');
  assert.ok(gate > arm, 'le danger doit être évalué AVANT le test de _escapeOnSpawn');
  assert.ok(flee > gate, 'la fuite reste attendue (await) : base, dette, planner attendent sa fin');
});

test('index.js : le handler death n appelle PAS process.exit sans avoir persisté juste avant', () => {
  const h = handlerSrc('death');
  const exit = h.lastIndexOf('process.exit(2);');             // l'instruction (les commentaires citent `process.exit(2)` sans `;`)
  assert.ok(exit > 0, 'process.exit(2); introuvable dans le handler death');
  const lastPersist = h.lastIndexOf('persistDeathHistory();', exit);
  assert.ok(lastPersist > 0 && lastPersist < exit, 'persistDeathHistory(); doit précéder process.exit(2);');
  // …et c'est la branche du garde-fou qui l'appelle (pas seulement l'enregistrement de la mort)
  const guard = h.indexOf('deathLoopTripped(');
  assert.ok(guard > 0 && lastPersist > guard, 'une écriture explicite doit se trouver DANS la branche death_loop, avant la sortie');
  assert.ok(h.indexOf('deathLoopTripped(') > 0, 'le garde-fou doit passer par deathLoopTripped (morts de CE process)');
  assert.ok(h.indexOf('escapeArmed(') > 0, 'l armement doit passer par escapeArmed (même jugement qu au chargement)');
  assert.ok(!/deathTimes\.length >= 5/.test(h), 'plus de comptage brut : il compterait les morts héritées');
});

test('index.js : AUCUN écrivain du mémo de base ne remplace tout l objet (aller-retour complet, piège #61)', () => {
  // `saveBaseState({ ... })` avec un littéral neuf EFFACE `deaths`, `deathDebt` et `zone` à chaque
  // appel (c était le cas à l'établissement de la base). Tout écrivain doit fusionner sur le mémo COURANT.
  assert.ok(!/saveBaseState\(\s*\{/.test(SRC), 'saveBaseState({...}) avec un littéral neuf efface les champs des autres écrivains');
  const est = grab(/^async function establishBase\([^)]*\) \{[\s\S]*?^\}$/m, 'establishBase');
  assert.match(est, /saveBaseState\(Object\.assign\(\{\}, loadBaseState\(\) \|\| \{\}, \{/,
    'établir la base doit fusionner sur l état COURANT du mémo (relu après les gotos de 90 s)');
});

test('index.js : saveBaseState rend un booléen (sinon « s assurer que c est écrit » est invérifiable)', () => {
  const fn = fnSrc('saveBaseState');
  assert.match(fn, /return true;/);
  assert.match(fn, /return false;/);
});
