'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const {
  createGoalTrace, installGoalTrace, callerFromStack,
  TOP_N, MAX_KEYS, DEFAULT_WINDOW_MS, UNKNOWN, OVERFLOW,
} = require('./goalTrace');

// ─── Fixtures de piles V8 ────────────────────────────────────────────────────────────────────────
// Chemins VOLONTAIREMENT avec espaces (le vrai dépôt vit dans « omenserver Project/Projet serveur »).
// Les formes de frames ci-dessous sont celles RELEVÉES en réel (node 22) : fonction nommée, anonyme
// sans parenthèses, plomberie `(<anonymous>)`, receveur `Object.x`, alias `[as setGoal]`, async.
const MC = '/Users/massimiliano/omenserver Project/Projet serveur/mc-agent';
const NM = MC + '/node_modules';
// Notre wrapper tel que V8 le montre quand setGoal est appelé en méthode (c'est TOUJOURS la 1re frame).
const WRAP = `    at Object.setGoalTraced [as setGoal] (${MC}/goalTrace.js:175:23)`;
const stack = (...frames) => ['Error', WRAP, ...frames.map((f) => '    at ' + f)].join('\n');

// ─── callerFromStack ─────────────────────────────────────────────────────────────────────────────
test('appelant nommé → fonction@fichier:ligne (basename seul, chemin avec espaces)', () => {
  const s = stack(
    `fleeFrom (${MC}/skills/fleeFrom.js:59:20)`,
    `EventEmitter.emit (node:events:519:28)`,
  );
  assert.equal(callerFromStack(s), 'fleeFrom@fleeFrom.js:59');
});

test('fonction anonyme (forme SANS parenthèses, chemin avec espaces) → <anonymous>@fichier:ligne', () => {
  const s = stack(
    `${MC}/index.js:5018:20`,
    `Array.forEach (<anonymous>)`,
    `tick (${MC}/index.js:5010:9)`,
  );
  assert.equal(callerFromStack(s), '<anonymous>@index.js:5018');
});

test('plomberie V8 sans fichier (new Promise, Array.forEach) ignorée', () => {
  const s = stack(
    `new Promise (<anonymous>)`,
    `Array.forEach (<anonymous>)`,
    `async Promise.all (index 0)`,
    `onHealth (${MC}/reflexes.js:298:15)`,
  );
  assert.equal(callerFromStack(s), 'onHealth@reflexes.js:298');
});

test('stopMotion est sauté : on rend l\'appelant DE stopMotion', () => {
  const s = stack(
    `stopMotion (${MC}/index.js:5609:36)`,
    `fleeNow (${MC}/index.js:3201:5)`,
    `Timeout._onTimeout (${MC}/index.js:5018:20)`,
    `listOnTimeout (node:internal/timers:585:17)`,
    `process.processTimers (node:internal/timers:521:7)`,
  );
  assert.equal(callerFromStack(s), 'fleeNow@index.js:3201');
});

test('stopMotion avec receveur (Object.stopMotion) et celui de skills/branchMine.js : sautés aussi', () => {
  const s = stack(
    `stopMotion (${MC}/skills/branchMine.js:59:60)`,
    `Object.stopMotion (${MC}/index.js:5609:36)`,
    `approach (${MC}/skills/branchMine.js:88:7)`,
  );
  assert.equal(callerFromStack(s), 'approach@branchMine.js:88');
});

test('goalHold (verrou de but, posé PAR-DESSUS goalTrace) est sauté : on rend le VRAI appelant, pas "held"', () => {
  // Pile réelle relevée en prod (NethBot1/MapBot1, 21/10) : depuis que goalHold.js enveloppe
  // setGoal PAR-DESSUS goalTrace, CHAQUE appel passe par son passe-plats `held` (goalHold.js:40,
  // `return orig.apply(this, arguments)`) avant d'atteindre notre wrapper — qui attribuait alors
  // TOUT, sans exception, à "Object.held@goalHold.js:40" au lieu du vrai appelant. Le diagnostic
  // censé dire « qui me vole mon but » (cf. en-tête du fichier) ne disait plus rien d'utile.
  const s = stack(
    `Object.held (${MC}/goalHold.js:40:12)`,
    `explore (${MC}/skills/explore.js:210:15)`,
  );
  assert.equal(callerFromStack(s), 'explore@explore.js:210');
});

test('goalHold via son propriétaire (holdSetGoal, fuite creeper) : sauté aussi, on remonte au code qui pose le verrou', () => {
  const s = stack(
    `Object.held (${MC}/goalHold.js:40:12)`,
    `holdSetGoal (${MC}/goalHold.js:50:44)`,
    `fleeNow (${MC}/index.js:3201:5)`,
  );
  assert.equal(callerFromStack(s), 'fleeNow@index.js:3201');
});

test('goto via le VRAI pathfinder : frames mineflayer-pathfinder + new Promise sautées → la fonction qui a lancé le goto', () => {
  // Pile réelle relevée avec le plugin mineflayer-pathfinder 2.4.5 injecté sur un faux bot.
  const s = stack(
    `${NM}/mineflayer-pathfinder/lib/goto.js:63:20`,
    `new Promise (<anonymous>)`,
    `goto (${NM}/mineflayer-pathfinder/lib/goto.js:17:10)`,
    `bot.pathfinder.goto (${NM}/mineflayer-pathfinder/index.js:159:12)`,
    `gotoSafe (${MC}/skills/explore.js:97:24)`,
    `explore (${MC}/skills/explore.js:210:15)`,
  );
  assert.equal(callerFromStack(s), 'gotoSafe@explore.js:97');
});

test('frame dans node_modules/<lib> → le nom de la lib (mineflayer-pvp pose ses propres buts)', () => {
  // Piles réelles : attack() (générateur __awaiter) et forceStop().
  const attack = stack(
    `PVP.<anonymous> (${NM}/mineflayer-pvp/lib/PVP.js:72:24)`,
    `Generator.next (<anonymous>)`,
    `fulfilled (${NM}/mineflayer-pvp/lib/PVP.js:5:58)`,
    `process.processTicksAndRejections (node:internal/process/task_queues:103:5)`,
  );
  assert.equal(callerFromStack(attack), 'mineflayer-pvp');
  const forceStop = stack(
    `PVP.forceStop (${NM}/mineflayer-pvp/lib/PVP.js:134:20)`,
    `stopFight (${MC}/index.js:4100:12)`,
  );
  assert.equal(callerFromStack(forceStop), 'mineflayer-pvp');
});

test('lib scopée → @scope/pkg ; node_modules imbriqués → la lib la plus interne', () => {
  assert.equal(callerFromStack(stack(`f (${NM}/@scope/pkg/lib/a.js:1:1)`)), '@scope/pkg');
  assert.equal(
    callerFromStack(stack(`g (${NM}/foo/node_modules/mineflayer-pvp/lib/PVP.js:9:9)`)),
    'mineflayer-pvp');
  // un mineflayer-pathfinder imbriqué est lui aussi « le pathfinder » : sauté
  assert.equal(
    callerFromStack(stack(
      `h (${NM}/foo/node_modules/mineflayer-pathfinder/index.js:3:3)`,
      `mine (${MC}/skills/gather.js:46:12)`)),
    'mine@gather.js:46');
});

test('méthode de classe : receveur conservé ; préfixe async et alias [as x] retirés', () => {
  assert.equal(callerFromStack(stack(`K.meth (${MC}/skills/x.js:10:5)`)), 'K.meth@x.js:10');
  assert.equal(callerFromStack(stack(`async explore (${MC}/skills/explore.js:210:15)`)), 'explore@explore.js:210');
  assert.equal(callerFromStack(stack(`Object.handler [as onHealth] (${MC}/reflexes.js:12:3)`)), 'Object.handler@reflexes.js:12');
  assert.equal(callerFromStack(stack(`Object.<anonymous> (${MC}/index.js:30:1)`)), 'Object.<anonymous>@index.js:30');
});

test('chemin Windows (antislash, lettre de lecteur) → basename', () => {
  const s = stack('run (C:\\proj\\mc-agent\\skills\\run.js:7:3)');
  assert.equal(callerFromStack(s), 'run@run.js:7');
});

test('fins de ligne \\r\\n tolérées', () => {
  const s = stack(`fleeFrom (${MC}/skills/fleeFrom.js:59:20)`).replace(/\n/g, '\r\n');
  assert.equal(callerFromStack(s), 'fleeFrom@fleeFrom.js:59');
});

test('frame eval (pas d\'emplacement exploitable) ignorée', () => {
  const s = stack(
    `eval (eval at <anonymous> (${MC}/index.js:1:1), <anonymous>:1:1)`,
    `real (${MC}/index.js:9:9)`,
  );
  assert.equal(callerFromStack(s), 'real@index.js:9');
});

test('entrées invalides ou sans frame exploitable → (inconnu), jamais d\'exception', () => {
  for (const bad of [undefined, null, 42, {}, [], '', 'Error', 'Error: boom\n  pas une frame']) {
    assert.equal(callerFromStack(bad), UNKNOWN, `entrée ${JSON.stringify(bad)}`);
  }
  // tout est écarté (wrapper, stopMotion, plomberie, pathfinder) → rien à rendre
  const s = stack(
    `stopMotion (${MC}/index.js:5609:36)`,
    `new Promise (<anonymous>)`,
    `goto (${NM}/mineflayer-pathfinder/lib/goto.js:17:10)`,
  );
  assert.equal(callerFromStack(s), UNKNOWN);
});

// ─── createGoalTrace ─────────────────────────────────────────────────────────────────────────────
test('compte les appels et les interruptions par appelant ; drain remet à zéro', () => {
  const t = createGoalTrace({ now: () => 0 });
  t.note('a@x.js:1', true);
  t.note('a@x.js:1', false);
  t.note('b@y.js:2', true);
  assert.deepEqual(t.drain().top, [
    { by: 'a@x.js:1', calls: 2, interrupted: 1 },
    { by: 'b@y.js:2', calls: 1, interrupted: 1 },
  ]);
  assert.deepEqual(t.drain().top, [], 'la fenêtre précédente ne doit pas fuiter');
});

test('tri : interrupted décroissant, puis calls décroissant, puis ordre alphabétique ; top 8', () => {
  assert.equal(TOP_N, 8);
  const t = createGoalTrace({ now: () => 0 });
  const feed = (by, calls, interrupted) => {
    for (let i = 0; i < calls; i++) t.note(by, i < interrupted);
  };
  feed('gros-volume-jamais-interrompu', 50, 0);
  feed('petit-mais-interrompu', 1, 1);
  feed('b-egalite', 3, 2);
  feed('a-egalite', 3, 2);
  feed('tres-interrompu', 9, 9);
  // 5 appelants de plus, plus faibles : les derniers doivent tomber hors du top 8
  for (let i = 0; i < 5; i++) feed(`faible-${i}`, 1 + i, 0);
  const top = t.drain().top;
  assert.equal(top.length, 8);
  assert.deepEqual(top.slice(0, 5).map((r) => r.by),
    ['tres-interrompu', 'a-egalite', 'b-egalite', 'petit-mais-interrompu', 'gros-volume-jamais-interrompu']);
  // puis les sans-interruption par volume décroissant ; faible-0 (1 appel) est tombé
  assert.deepEqual(top.slice(5).map((r) => r.by), ['faible-4', 'faible-3', 'faible-2']);
});

test('windowS = temps RÉEL écoulé depuis le dernier drain (horloge injectée), jamais négatif', () => {
  let now = 1000;
  const t = createGoalTrace({ now: () => now });
  now = 1000 + 60000;
  assert.equal(t.drain().windowS, 60);
  now += 61500;
  assert.equal(t.drain().windowS, 62, 'une fenêtre en retard est rapportée telle quelle, pas ramenée au nominal');
  now += 400;
  assert.equal(t.drain().windowS, 0);
  now -= 5000;                                         // horloge qui recule
  assert.equal(t.drain().windowS, 0);
});

test('drain à vide → { windowS, top: [] }', () => {
  const d = createGoalTrace({ now: () => 0 }).drain();
  assert.deepEqual(d, { windowS: 0, top: [] });
});

test('note tolère des entrées bizarres sans lever : clé invalide → (inconnu), interrupted coercé', () => {
  const t = createGoalTrace({ now: () => 0 });
  t.note(undefined, 1);
  t.note(null, 0);
  t.note(42);
  t.note('', 'oui');
  assert.deepEqual(t.drain().top, [{ by: UNKNOWN, calls: 4, interrupted: 2 }]);
});

test('borne mémoire : au-delà de MAX_KEYS appelants distincts, le surplus va dans (autres)', () => {
  const t = createGoalTrace({ now: () => 0 });
  for (let i = 0; i < MAX_KEYS; i++) t.note('k' + i, false);
  t.note('nouveau-a', true);                           // clé NOUVELLE après la borne → (autres)
  t.note('nouveau-b', true);
  t.note('k0', true);                                  // clé DÉJÀ connue → continue de compter normalement
  const top = t.drain().top;
  assert.deepEqual(top[0], { by: OVERFLOW, calls: 2, interrupted: 2 });
  assert.deepEqual(top[1], { by: 'k0', calls: 2, interrupted: 1 });
  assert.ok(!top.some((r) => r.by === 'nouveau-a' || r.by === 'nouveau-b'));
});

test('windowMs : cadence nominale exposée telle que fournie (60 s par défaut)', () => {
  assert.equal(DEFAULT_WINDOW_MS, 60000);
  assert.equal(createGoalTrace().windowMs, 60000);
  assert.equal(createGoalTrace({ windowMs: 15000 }).windowMs, 15000);
});

// ─── installGoalTrace ────────────────────────────────────────────────────────────────────────────
// Faux pathfinder à l'image du vrai plugin : `goal` en GETTER, `setGoal` en flèche inscriptible.
function fakePathfinder() {
  let stateGoal = null;
  const pf = { calls: [] };
  Object.defineProperty(pf, 'goal', { get() { return stateGoal; } });
  pf.setGoal = (goal, dynamic = false) => {
    pf.calls.push([goal, dynamic]);
    stateGoal = goal;
    return 'ret:' + (goal && goal.id);
  };
  return pf;
}

test('wrapper transparent : mêmes arguments (même référence), même valeur de retour, même this', () => {
  const pf = fakePathfinder();
  assert.equal(installGoalTrace(pf, createGoalTrace({ now: () => 0 })), true);
  const g = { id: 'A' };
  assert.equal(pf.setGoal(g, true), 'ret:A');
  assert.equal(pf.calls.length, 1);
  assert.strictEqual(pf.calls[0][0], g);
  assert.equal(pf.calls[0][1], true);

  const withThis = { goal: null, setGoal(goal) { this.goal = goal; return this; } };
  installGoalTrace(withThis, createGoalTrace({ now: () => 0 }));
  assert.strictEqual(withThis.setGoal({ id: 'B' }), withThis, 'this doit rester le pathfinder');
  assert.deepEqual(withThis.goal, { id: 'B' });
});

test('interrupted = un but est actif ET celui qu\'on pose est différent (setGoal(null) sur but actif compris)', () => {
  const notes = [];
  const pf = fakePathfinder();
  installGoalTrace(pf, { note: (by, interrupted) => notes.push(interrupted) });
  const A = { id: 'A' };
  const B = { id: 'B' };
  pf.setGoal(null);   // rien d'actif, on pose null               → false
  pf.setGoal(A);      // rien d'actif, on pose A                  → false
  pf.setGoal(A);      // A actif, on re-pose LE MÊME objet        → false
  pf.setGoal(B);      // A actif, on le REMPLACE par B            → true
  pf.setGoal(null);   // B actif, on l'efface                     → true
  pf.setGoal(null);   // plus rien d'actif                        → false
  assert.deepEqual(notes, [false, false, false, true, true, false]);
});

test('attribution réelle V8 : stopMotion est sauté, l\'interrupteur est son appelant', () => {
  const pf = fakePathfinder();
  const tr = createGoalTrace({ now: () => 0 });
  installGoalTrace(pf, tr);
  function stopMotion() { pf.setGoal(null); }
  function realCaller() { stopMotion(); }
  pf.setGoal({ id: 'A' });                             // un but est actif...
  realCaller();                                        // ... et realCaller l'efface via stopMotion
  const top = tr.drain().top;
  const row = top.find((r) => /^realCaller@goalTrace\.test\.js:\d+$/.test(r.by));
  assert.ok(row, 'realCaller doit être identifié, reçu ' + JSON.stringify(top));
  assert.deepEqual([row.calls, row.interrupted], [1, 1]);
  assert.ok(!top.some((r) => r.by.startsWith('stopMotion@')), 'le passe-plats ne doit jamais apparaître');
  assert.ok(!top.some((r) => r.by.includes('goalTrace.js')), 'le wrapper ne doit jamais apparaître');
});

test('l\'instrumentation ne casse JAMAIS setGoal (note qui lève, getter goal qui lève)', () => {
  const pf = fakePathfinder();
  installGoalTrace(pf, { note() { throw new Error('boom'); } });
  assert.equal(pf.setGoal({ id: 'X' }), 'ret:X');
  assert.equal(pf.calls.length, 1, 'setGoal d\'origine appelé malgré tout');

  const pf2 = { setGoal: (g) => 'ok:' + g };
  Object.defineProperty(pf2, 'goal', { get() { throw new Error('getter'); } });
  installGoalTrace(pf2, createGoalTrace({ now: () => 0 }));
  assert.equal(pf2.setGoal('z'), 'ok:z');
});

test('les erreurs de setGoal lui-même se PROPAGENT (le try/catch ne couvre que l\'instrumentation)', () => {
  const pf = { goal: null, setGoal() { throw new RangeError('setGoal a levé'); } };
  installGoalTrace(pf, createGoalTrace({ now: () => 0 }));
  assert.throws(() => pf.setGoal({}), RangeError);
});

test('idempotent : un second install ne double pas les comptes', () => {
  const pf = fakePathfinder();
  const tr = createGoalTrace({ now: () => 0 });
  assert.equal(installGoalTrace(pf, tr), true);
  assert.equal(installGoalTrace(pf, tr), false);
  pf.setGoal({ id: 'A' });
  assert.equal(tr.drain().top.reduce((n, r) => n + r.calls, 0), 1);
});

test('entrées invalides → false sans exception', () => {
  const tr = createGoalTrace({ now: () => 0 });
  assert.equal(installGoalTrace(null, tr), false);
  assert.equal(installGoalTrace(undefined, tr), false);
  assert.equal(installGoalTrace(fakePathfinder(), null), false);
  assert.equal(installGoalTrace(fakePathfinder(), {}), false);
  assert.equal(installGoalTrace({}, tr), false);
  assert.equal(installGoalTrace({ setGoal: 3 }, tr), false);
});

test('objet gelé / setGoal non inscriptible → false sans exception, setGoal d\'origine intact', () => {
  const frozen = Object.freeze({ setGoal: () => 'orig' });
  assert.equal(installGoalTrace(frozen, createGoalTrace({ now: () => 0 })), false);
  assert.equal(frozen.setGoal(), 'orig');
});

// Mécanisme du symptôme live, rejoué avec le VRAI lib/goto.js : poser un autre but pendant un goto le
// rejette en GoalChanged, et la trace doit nommer (1) la fonction qui a lancé le goto, (2) celle qui l'a cassé.
let gotoUtil = null;
try {
  gotoUtil = require(path.join(path.dirname(require.resolve('mineflayer-pathfinder')), 'lib', 'goto.js'));
} catch (e) { /* paquet absent : test sauté ci-dessous */ }

test('goto RÉEL (mineflayer-pathfinder/lib/goto.js) : GoalChanged attribué à celui qui interrompt',
  { skip: !gotoUtil && 'mineflayer-pathfinder/lib/goto.js introuvable' },
  async () => {
    const bot = new EventEmitter();
    let stateGoal = null;
    bot.pathfinder = {};
    Object.defineProperty(bot.pathfinder, 'goal', { get() { return stateGoal; } });
    bot.pathfinder.setGoal = (goal, dynamic = false) => {
      stateGoal = goal;
      bot.emit('goal_updated', goal, dynamic);         // c'est CET event que lib/goto.js écoute
    };
    const tr = createGoalTrace({ now: () => 0 });
    installGoalTrace(bot.pathfinder, tr);

    function startTrip() { return gotoUtil(bot, { id: 'trip' }); }
    function stopMotion() { bot.pathfinder.setGoal(null); }
    function breaker() { stopMotion(); }

    const trip = startTrip();
    breaker();
    await assert.rejects(trip, { name: 'GoalChanged' });

    const top = tr.drain().top;
    assert.equal(top.length, 2, JSON.stringify(top));
    assert.match(top[0].by, /^breaker@goalTrace\.test\.js:\d+$/);
    assert.deepEqual([top[0].calls, top[0].interrupted], [1, 1], 'celui qui casse le goto est en tête');
    assert.match(top[1].by, /^startTrip@goalTrace\.test\.js:\d+$/);
    assert.deepEqual([top[1].calls, top[1].interrupted], [1, 0], 'le goto lui-même n\'interrompt rien');
  });

// ─── Câblage dans index.js ───────────────────────────────────────────────────────────────────────
test('index.js : trace au NIVEAU MODULE, wrapper posé une seule fois, event goal_trace (classe #56/#61)', () => {
  // Garde-fou de CÂBLAGE. index.smoke.test.js ne l'attrape PAS : le timer de drain ne tire qu'après 60 s,
  // une `_goalTrace` déclarée dans onSpawn y lèverait une ReferenceError que le chargement ne voit jamais
  // (exactement le piège panicInFlight, #56). `^` + flag m = colonne 0 = niveau module.
  const src = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');
  assert.match(src, /require\('\.\/goalTrace'\)/, 'require(\'./goalTrace\') manquant dans index.js');
  assert.match(src, /^const _goalTrace = createGoalTrace\(/m,
    '_goalTrace doit être déclarée au NIVEAU MODULE (colonne 0), jamais dans onSpawn');
  assert.match(src, /^let _goalTraceInstalled = false;/m,
    '_goalTraceInstalled doit être déclarée au NIVEAU MODULE (colonne 0), jamais dans onSpawn');

  const drain = src.indexOf('_goalTrace.drain()');
  assert.ok(drain > 0, 'drain de la trace introuvable dans index.js');
  const timer = src.lastIndexOf('setInterval(', drain);
  assert.ok(timer > 0 && src[timer - 1] === '\n', 'le setInterval de drain doit être de niveau module (colonne 0)');
  assert.match(src.slice(drain, drain + 300), /type: 'goal_trace'/, 'le drain doit émettre un event `goal_trace`');
  assert.match(src.slice(drain, src.indexOf('}, _goalTrace.windowMs)', drain) + 30), /\.\.\.d\b/,
    'l\'event doit porter { windowS, top } (spread du résultat de drain)');

  assert.match(src, /if \(!_goalTraceInstalled\) \{\s*_goalTraceInstalled = true;[\s\S]{0,400}installGoalTrace\(bot\.pathfinder, _goalTrace\)/,
    'le wrapper doit être posé UNE seule fois par process, sous la garde de niveau module');
  // Le silence est un bug : sans cet event, l'absence de `goal_trace` serait ambiguë (aucun setGoal posé
  // dans la minute VS wrapper jamais installé). `ok` dit si installGoalTrace a réellement posé le wrapper.
  assert.match(src, /emit\(\{ type: 'goal_trace_on', ok: traced \}\)/,
    'l\'event `goal_trace_on { ok }` doit confirmer l\'installation du wrapper');
});
