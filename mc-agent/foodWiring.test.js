'use strict';
// NOURRITURE — LE CÂBLAGE D'index.js, EXÉCUTÉ (pas seulement lu).
//
// index.js ne s'importe pas (il crée le bot au chargement), et les tests « regex sur le source » ne
// prouvent que la FORME du code : un nom mal tapé, une dépendance mal branchée ou un drapeau lu au
// mauvais niveau passent tous. Ici on extrait du source RÉEL les fonctions de câblage et on les
// exécute dans un bac à sable avec de faux `bot`, `lootNearby`, `withTimeout`… — si la production
// référence un nom qui n'existe pas, le bac à sable lève une ReferenceError (la classe de bug des
// pièges #56 et #61 : « tests verts, process mort au premier tick »).
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const homewarp = require('./homewarp');
const F = require('./food');

const SRC = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');
function slice(from, to) {
  const a = SRC.indexOf(from);
  assert.ok(a >= 0, `repère introuvable : ${from}`);
  const b = SRC.indexOf(to, a + from.length);
  assert.ok(b > a, `fin introuvable : ${to}`);
  return SRC.slice(a, b);
}
const settle = async () => { for (let i = 0; i < 12; i++) await new Promise((r) => setImmediate(r)); };

// ─── Les drapeaux de niveau module que le câblage lit : ils DOIVENT exister en production ────────
test('index.js : les drapeaux lus par le butin après combat existent AU NIVEAU MODULE (colonne 0)', () => {
  for (const name of ['_combatLootWired', '_combatLootBusy', '_combatTarget',
    '_migrating', '_imminentBusy', 'panicInFlight', '_armorBusy', '_baseBusy', '_escaping', '_deathDebtBusy',
    '_surfaceTripBusy', '_foodRunBusy']) {
    assert.match(SRC, new RegExp(`^let ${name}\\b`, 'm'), `${name} doit être déclaré en \`let\` à la colonne 0, jamais dans onSpawn`);
  }
});

// ─── BUTIN APRÈS COMBAT ─────────────────────────────────────────────────────────────────────────
const FLAGS = ['_migrating', '_imminentBusy', 'panicInFlight', '_armorBusy', '_baseBusy', '_escaping', '_deathDebtBusy'];

function combatGlue(over = {}) {
  const w = {
    bot: Object.assign(new EventEmitter(), {
      entity: { position: { x: 0, y: 64, z: 0 } },
      entities: {},
      pvp: { target: undefined },
      pathfinder: { goal: null },
      isAlive: true,
    }),
    sleeps: [],
    looted: [],
    events: [],
    hostiles: [],
    inWater: false,
    owner: 'autonomous',
    lootResult: 2,
    lootThrows: false,
    ...over,
  };
  const src = slice('function wireCombatLoot() {', '// Post-mort (cible keepInventory OFF');
  const env = {
    bot: w.bot,
    sleep: async (ms) => { w.sleeps.push(ms); },
    homewarp,
    nearbyHostiles: () => w.hostiles,
    isInWater: () => w.inWater,
    taskCtl: { get active() { return w.owner; } },
    shouldLootAfterCombat: F.shouldLootAfterCombat,
    lootNearby: async (o) => { w.looted.push(o); if (w.lootThrows) throw new Error('goto KO'); return w.lootResult; },
    emit: (e) => w.events.push(e),
    COMBAT_LOOT_RADIUS: F.COMBAT_LOOT_RADIUS,
    COMBAT_LOOT_ITEMS: F.COMBAT_LOOT_ITEMS,
    COMBAT_LOOT_MS: F.COMBAT_LOOT_MS,
    COMBAT_LOOT_HOSTILE_RADIUS: F.COMBAT_LOOT_HOSTILE_RADIUS,
    COMBAT_LOOT_SETTLE_MS: F.COMBAT_LOOT_SETTLE_MS,
  };
  const names = Object.keys(env);
  const factory = new Function(...names, `
    let _combatLootWired = false;
    let _combatLootBusy = false;
    let _combatTarget = null;
    ${FLAGS.map((f) => `let ${f} = false;`).join('\n    ')}
    ${src}
    return {
      wireCombatLoot, lootAfterCombat,
      state: () => ({ wired: _combatLootWired, busy: _combatLootBusy, target: _combatTarget }),
      setFlag: (k, v) => { switch (k) { ${FLAGS.map((f) => `case '${f}': ${f} = v; break;`).join(' ')} default: throw new Error('flag inconnu ' + k); } },
    };
  `);
  w.glue = factory(...names.map((n) => env[n]));
  return w;
}
const drop = (x = 2, z = 0) => ({ type: 'item', position: { x, y: 64, z } });
const ZOMBIE = { name: 'zombie', kind: 'Hostile mobs', type: 'hostile', position: { x: 3, y: 64, z: 0 } };

// Un combat complet : startedAttacking (la cible est lue sur bot.pvp.target), puis stoppedAttacking
// (mineflayer-pvp a déjà vidé la cible à ce moment-là).
async function fight(w, target) {
  w.bot.pvp.target = target;
  w.bot.emit('startedAttacking');
  w.bot.pvp.target = undefined;
  w.bot.emit('stoppedAttacking');
  await settle();
}

test('butin : le câblage pose DEUX écouteurs, UNE seule fois par process', () => {
  const w = combatGlue();
  assert.strictEqual(w.glue.wireCombatLoot(), true);
  assert.strictEqual(w.bot.listenerCount('startedAttacking'), 1);
  assert.strictEqual(w.bot.listenerCount('stoppedAttacking'), 1);
  assert.strictEqual(w.glue.wireCombatLoot(), false, 'deuxième appel : rien de plus');
  assert.strictEqual(w.bot.listenerCount('startedAttacking'), 1);
  assert.strictEqual(w.bot.listenerCount('stoppedAttacking'), 1);
});

test('butin : zombie tué, voie libre, un objet à 2 blocs → lootNearby(rayon 6, 4 objets, 5 s) et event combat_loot', async () => {
  const w = combatGlue();
  w.bot.entities = { 1: drop(2, 0) };
  w.glue.wireCombatLoot();
  await fight(w, ZOMBIE);
  assert.deepStrictEqual(w.looted, [{ radius: 6, maxItems: 4, budgetMs: 5000, abortOnFail: true }]);
  assert.deepStrictEqual(w.events, [{ type: 'combat_loot', items: 2, target: 'zombie' }]);
  assert.deepStrictEqual(w.sleeps, [400], 'court délai de décantation avant de décider');
  assert.deepStrictEqual(w.glue.state(), { wired: true, busy: false, target: null });
});

test('butin : la cible est relevée au DÉBUT du combat (à la fin, mineflayer-pvp l a déjà vidée)', async () => {
  const w = combatGlue();
  w.bot.entities = { 1: drop(1, 1) };
  w.glue.wireCombatLoot();
  w.bot.pvp.target = ZOMBIE;
  w.bot.emit('startedAttacking');
  assert.strictEqual(w.glue.state().target.name, 'zombie');
  w.bot.pvp.target = undefined;                   // état au moment de stoppedAttacking
  w.bot.emit('stoppedAttacking');
  await settle();
  assert.strictEqual(w.looted.length, 1);
  assert.strictEqual(w.glue.state().target, null, 'la cible est consommée par la fin du combat');
});

test('butin : le GIBIER chassé n ouvre PAS la porte (huntPassive a son propre ramassage)', async () => {
  const w = combatGlue();
  w.bot.entities = { 1: drop(1, 0) };
  w.glue.wireCombatLoot();
  await fight(w, { name: 'cow', kind: 'Passive mobs', type: 'animal' });
  assert.strictEqual(w.looted.length, 0);
});

test('butin : fin de combat sans début observé (cible inconnue) → rien', async () => {
  const w = combatGlue();
  w.bot.entities = { 1: drop(1, 0) };
  w.glue.wireCombatLoot();
  w.bot.emit('stoppedAttacking');
  await settle();
  assert.strictEqual(w.looted.length, 0);
});

test('butin : rien au sol → pas de ramassage', async () => {
  const w = combatGlue();
  w.glue.wireCombatLoot();
  await fight(w, ZOMBIE);
  assert.strictEqual(w.looted.length, 0);
});

test('butin : un objet hors du rayon de 6 blocs est ignoré', async () => {
  const w = combatGlue();
  w.bot.entities = { 1: drop(9, 0) };
  w.glue.wireCombatLoot();
  await fight(w, ZOMBIE);
  assert.strictEqual(w.looted.length, 0);
});

test('butin : un hostile à ≤ 8 blocs → non (le combat continue)', async () => {
  const w = combatGlue({ hostiles: [ZOMBIE] });
  w.bot.entities = { 1: drop(1, 0) };
  w.glue.wireCombatLoot();
  await fight(w, ZOMBIE);
  assert.strictEqual(w.looted.length, 0);
});

test('butin : lecture des hostiles impossible → prudence (on ne ramasse pas)', async () => {
  const w = combatGlue();
  w.bot.entities = { 1: drop(1, 0) };
  const src = slice('function wireCombatLoot() {', '// Post-mort (cible keepInventory OFF');
  assert.match(src, /catch \(e\) \{ hostilesNear = true; \}/);
});

test('butin : PENDANT une migration → jamais', async () => {
  const w = combatGlue();
  w.bot.entities = { 1: drop(1, 0) };
  w.glue.setFlag('_migrating', true);
  w.glue.wireCombatLoot();
  await fight(w, ZOMBIE);
  assert.strictEqual(w.looted.length, 0);
  w.glue.setFlag('_migrating', false);
  await fight(w, ZOMBIE);
  assert.strictEqual(w.looted.length, 1, 'la migration finie, la porte se rouvre');
});

test('butin : la survie passe devant (panique, armure, base, fuite, noyade, dette de mort, mise à l eau)', async () => {
  for (const flag of ['_imminentBusy', 'panicInFlight', '_armorBusy', '_baseBusy', '_escaping', '_deathDebtBusy']) {
    const w = combatGlue();
    w.bot.entities = { 1: drop(1, 0) };
    w.glue.setFlag(flag, true);
    w.glue.wireCombatLoot();
    await fight(w, ZOMBIE);
    assert.strictEqual(w.looted.length, 0, flag);
  }
  const eau = combatGlue({ inWater: true });
  eau.bot.entities = { 1: drop(1, 0) };
  eau.glue.wireCombatLoot();
  await fight(eau, ZOMBIE);
  assert.strictEqual(eau.looted.length, 0, 'dans l eau');
});

test('butin : un AUTRE trajet pathfinder est en cours → seulement pour un objet à ≤ 4 blocs', async () => {
  const loin = combatGlue();
  loin.bot.pathfinder.goal = { some: 'goal' };
  loin.bot.entities = { 1: drop(5, 0) };
  loin.glue.wireCombatLoot();
  await fight(loin, ZOMBIE);
  assert.strictEqual(loin.looted.length, 0, 'objet à 5 blocs : on ne vole pas le trajet');

  const pres = combatGlue();
  pres.bot.pathfinder.goal = { some: 'goal' };
  pres.bot.entities = { 1: drop(3, 0) };
  pres.glue.wireCombatLoot();
  await fight(pres, ZOMBIE);
  assert.strictEqual(pres.looted.length, 1, 'objet à 3 blocs : détour négligeable');
});

test('butin : un NOUVEAU combat a déjà commencé (attack() enchaîne stop puis start) → on ne ramasse pas', async () => {
  const w = combatGlue();
  w.bot.entities = { 1: drop(1, 0) };
  w.glue.wireCombatLoot();
  w.bot.pvp.target = ZOMBIE;
  w.bot.emit('startedAttacking');
  w.bot.emit('stoppedAttacking');                  // mineflayer-pvp.attack() : stop de l ancienne cible…
  w.bot.pvp.target = { name: 'skeleton', kind: 'Hostile mobs' };    // …puis nouvelle cible déjà posée
  await settle();
  assert.strictEqual(w.looted.length, 0);
});

test('butin : les ordres directs (follow, guard, take…) gardent la main ; planner, mappeur et repos laissent faire', async () => {
  for (const [owner, attendu] of [['follow', 0], ['guard', 0], ['take', 0], ['migration', 0], ['autonomous', 1], [null, 1]]) {
    const w = combatGlue({ owner });
    w.bot.entities = { 1: drop(1, 0) };
    w.glue.wireCombatLoot();
    await fight(w, ZOMBIE);
    assert.strictEqual(w.looted.length, attendu, String(owner));
  }
});

test('butin : bot mort pendant l attente → rien (la dette de mort ramassera)', async () => {
  const w = combatGlue();
  w.bot.entities = { 1: drop(1, 0) };
  w.glue.wireCombatLoot();
  w.bot.pvp.target = ZOMBIE;
  w.bot.emit('startedAttacking');
  w.bot.pvp.target = undefined;
  w.bot.isAlive = false;
  w.bot.emit('stoppedAttacking');
  await settle();
  assert.strictEqual(w.looted.length, 0);
});

test('butin : deux fins de combat rapprochées → UN seul ramassage (garde de ré-entrée)', async () => {
  const w = combatGlue();
  w.bot.entities = { 1: drop(1, 0) };
  w.glue.wireCombatLoot();
  w.bot.pvp.target = ZOMBIE; w.bot.emit('startedAttacking');
  w.bot.pvp.target = undefined;
  w.bot.emit('stoppedAttacking');
  w.bot.pvp.target = ZOMBIE; w.bot.emit('startedAttacking');
  w.bot.pvp.target = undefined;
  w.bot.emit('stoppedAttacking');
  await settle();
  assert.strictEqual(w.looted.length, 1);
});

test('butin : la garde de ré-entrée est RELÂCHÉE même si lootNearby jette', async () => {
  const w = combatGlue({ lootThrows: true });
  w.bot.entities = { 1: drop(1, 0) };
  w.glue.wireCombatLoot();
  await fight(w, ZOMBIE);
  assert.strictEqual(w.looted.length, 1);
  assert.strictEqual(w.glue.state().busy, false);
  w.lootThrows = false;
  await fight(w, ZOMBIE);
  assert.strictEqual(w.looted.length, 2, 'le combat suivant ramasse normalement');
});

test('butin : rien ramassé (inatteignable) → pas d event combat_loot', async () => {
  const w = combatGlue({ lootResult: 0 });
  w.bot.entities = { 1: drop(1, 0) };
  w.glue.wireCombatLoot();
  await fight(w, ZOMBIE);
  assert.strictEqual(w.looted.length, 1);
  assert.deepStrictEqual(w.events, []);
});

test('butin : le câblage est posé APRÈS le gardien de Movements — nominale rendue avant de marcher', () => {
  const watch = SRC.indexOf('.watchPvp(bot)');
  const wire = SRC.indexOf('wireCombatLoot();', watch);
  assert.ok(watch > 0 && wire > watch, 'wireCombatLoot() doit suivre watchPvp : mêmes events, ordre d enregistrement');
  assert.ok(wire < SRC.indexOf('bot.pathfinder.setMovements(moves);', watch));
});

// ─── lootNearby : budget réellement tenu ────────────────────────────────────────────────────────

function lootGlue(over = {}) {
  const w = {
    bot: { entity: { position: { x: 0, y: 64, z: 0 } }, entities: {}, pathfinder: { goto: async () => {} } },
    gotos: [],
    timeouts: [],
    sleeps: 0,
    gotoResult: undefined,
    ...over,
  };
  const src = slice('async function lootNearby(opts = {}) {', '// ── BUTIN APRÈS UN COMBAT');
  const env = {
    bot: w.bot, homewarp,
    pfGoals: { GoalNear: function GoalNear(x, y, z, r) { this.x = x; this.y = y; this.z = z; this.r = r; } },
    withTimeout: async (p, ms) => { w.timeouts.push(ms); return w.gotoResult; },
    stopMotion: () => {},
    sleep: async () => { w.sleeps++; },
  };
  const names = Object.keys(env);
  const factory = new Function(...names, `${src}\nreturn lootNearby;`);
  w.loot = factory(...names.map((n) => env[n]));
  return w;
}

test('lootNearby : chaque goto est rogné par le budget RESTANT (un balayage de 8 s ne dure plus 8 + 15 s)', async () => {
  const w = lootGlue();
  w.bot.entities = { 1: { type: 'item', position: { x: 2, y: 64, z: 0 } } };
  w.bot.pathfinder.goto = () => new Promise(() => {});          // jamais résolu : seul le délai compte
  await w.loot({ radius: 10, maxItems: 6, budgetMs: 8000 });
  assert.ok(w.timeouts[0] <= 8000 && w.timeouts[0] >= 1500, `délai du goto = ${w.timeouts[0]}`);
  // budget large (45 s par défaut, balayages historiques) : plafond de 15 s inchangé
  const w2 = lootGlue();
  w2.bot.entities = { 1: { type: 'item', position: { x: 2, y: 64, z: 0 } } };
  await w2.loot({ radius: 20, maxItems: 1, budgetMs: 45000 });
  assert.strictEqual(w2.timeouts[0], 15000);
});

test('lootNearby : abortOnFail — un goto qui ÉCHOUE abandonne le ramassage (au lieu de re-tenter le même objet maxItems fois)', async () => {
  const w = lootGlue({ gotoResult: { ok: false, reason: 'error' } });
  w.bot.entities = { 1: { type: 'item', position: { x: 2, y: 64, z: 0 } } };
  const got = await w.loot({ radius: 10, maxItems: 6, budgetMs: 8000, abortOnFail: true });
  assert.strictEqual(w.timeouts.length, 1, 'un seul essai');
  assert.strictEqual(got, 0, 'et il ne compte pas un objet qu on n a pas atteint');
});

test('lootNearby : SANS abortOnFail le comportement historique est conservé (récupération des objets de mort)', async () => {
  // Un échec passager (un réflexe a pris le pathfinder une seconde) n y doit pas abandonner le butin.
  const w = lootGlue({ gotoResult: { ok: false, reason: 'error' } });
  w.bot.entities = { 1: { type: 'item', position: { x: 2, y: 64, z: 0 } } };
  await w.loot({ radius: 20, maxItems: 3, budgetMs: 45000 });
  assert.strictEqual(w.timeouts.length, 3, 'il re-tente, comme avant');
});

test('lootNearby : un goto réussi compte et enchaîne', async () => {
  const w = lootGlue({ gotoResult: undefined });
  w.bot.entities = { 1: { type: 'item', position: { x: 2, y: 64, z: 0 } } };
  const got = await w.loot({ radius: 10, maxItems: 2, budgetMs: 8000 });
  assert.strictEqual(got, 2);
  assert.strictEqual(w.timeouts.length, 2);
});

// ─── ensureFood : les dépendances sont branchées sur les bons globaux ───────────────────────────

function ensureGlue(over = {}) {
  const w = {
    bot: { entity: { position: { x: 0, y: 70, z: 0 } }, food: 9, username: 'WorkBot', chats: [], chat(m) { this.chats.push(m); } },
    captured: null,
    events: [],
    loots: [],
    warps: [],
    timeouts: [],
    hunts: [],
    NO_GIVE: false,
    ...over,
  };
  const src = slice('async function ensureFood() {', '// Kit de départ DÉTERMINISTE');
  const env = {
    runEnsureFood: async (d) => { w.captured = d; },
    buildCtxInv: () => ({ cooked_beef: 1 }),
    bot: w.bot,
    foodStock: () => 7,
    lootNearby: async (o) => { w.loots.push(o); return 3; },
    emit: (e) => w.events.push(e),
    withTimeout: async (p, ms) => { w.timeouts.push(ms); return p; },
    safeWarpHome: async (name) => { w.warps.push(name); await new Promise((r) => setImmediate(r)); },
    HOME_SAFE: 'safe',
    stopMotion: () => {},
    huntCookGoal: async (t, o) => { w.hunts.push([t, o]); return { ok: true }; },
    ENSURE_SKIP_POINTS: F.ENSURE_SKIP_POINTS,
    NO_GIVE: w.NO_GIVE,
    markWorkBeforeTrip: (why) => { w.marks = (w.marks || []).concat([why]); return true; },
  };
  const names = Object.keys(env);
  const factory = new Function(...names, `let _surfaceTripBusy = false;\nlet _foodSurfaceTripAt = 0;\n${src}\nreturn ensureFood;`);
  w.ensureFood = factory(...names.map((n) => env[n]));
  return w;
}

test('ensureFood (câblage) : chaque dépendance est branchée sur le bon global', async () => {
  const w = ensureGlue();
  await w.ensureFood();
  const d = w.captured;
  assert.ok(d, 'runEnsureFood doit être appelé');
  assert.deepStrictEqual(d.inventory(), { cooked_beef: 1 });
  assert.strictEqual(d.y(), 70);
  assert.strictEqual(d.hunger(), 9);
  assert.strictEqual(d.foodItems(), 7);
  assert.strictEqual(await d.loot({ radius: 10 }), 3);
  assert.deepStrictEqual(w.loots, [{ radius: 10 }]);
  assert.strictEqual(d.canGive, true);
  d.give();
  assert.deepStrictEqual(w.bot.chats, ['/give WorkBot cooked_beef 32']);
  assert.ok(w.events.some((e) => e.type === 'food_resupply' && e.via === 'give'));
});

test('ensureFood (câblage) : la chasse vise le MÊME seuil que la sortie anticipée (20 points)', async () => {
  const w = ensureGlue();
  await w.ensureFood();
  const budget = F.createBudget(60000);
  await w.captured.hunt({ budget });
  assert.deepStrictEqual(w.hunts, [[6, { budget, goalPoints: 20 }]]);
});

test('ensureFood (câblage) : sans-give → canGive faux', async () => {
  const w = ensureGlue({ NO_GIVE: true });
  // l env du bac à sable lit NO_GIVE au moment de la création : on la recrée avec le drapeau levé
  const src = slice('async function ensureFood() {', '// Kit de départ DÉTERMINISTE');
  let captured = null;
  const f = new Function('runEnsureFood', 'buildCtxInv', 'bot', 'foodStock', 'lootNearby', 'emit', 'withTimeout', 'safeWarpHome',
    'HOME_SAFE', 'stopMotion', 'huntCookGoal', 'ENSURE_SKIP_POINTS', 'NO_GIVE',
    `let _surfaceTripBusy = false;\nlet _foodSurfaceTripAt = 0;\n${src}\nreturn ensureFood;`)(
    async (d) => { captured = d; }, () => ({}), w.bot, () => 0, async () => 0, () => {}, async (p) => p, async () => {},
    'safe', () => {}, async () => {}, 20, true);
  await f();
  assert.strictEqual(captured.canGive, false);
});

test('ensureFood (câblage) : la remontée passe par safeWarpHome(home safe) sous le plafond donné', async () => {
  const w = ensureGlue();
  await w.ensureFood();
  await w.captured.surfaceTrip({ ms: 30000, y: 12, food: 4 });
  assert.deepStrictEqual(w.warps, ['safe']);
  assert.deepStrictEqual(w.timeouts, [30000]);
  assert.ok(w.events.some((e) => e.type === 'food_surface_trip' && e.y === 12 && e.food === 4));
  assert.deepStrictEqual(w.marks, ['food'], 'signet du chantier posé AVANT la remontée (retour /home work)');
});

test('ensureFood (câblage) : UNE seule remontée à la fois (appel concurrent = no-op), puis le verrou est relâché', async () => {
  const w = ensureGlue();
  await w.ensureFood();
  const premiere = w.captured.surfaceTrip({ ms: 30000, y: 12, food: 4 });
  await w.captured.surfaceTrip({ ms: 30000, y: 12, food: 4 });            // pendant que la 1re court
  await premiere;
  assert.deepStrictEqual(w.warps, ['safe'], 'un seul warp');
  await w.captured.surfaceTrip({ ms: 30000, y: 12, food: 4 });
  assert.deepStrictEqual(w.warps, ['safe', 'safe'], 'verrou relâché une fois la remontée finie');
});

test('ensureFood (câblage) : le verrou de remontée est relâché même si le warp jette', async () => {
  const w = ensureGlue();
  const src = slice('async function ensureFood() {', '// Kit de départ DÉTERMINISTE');
  let captured = null;
  let warps = 0;
  const f = new Function('runEnsureFood', 'buildCtxInv', 'bot', 'foodStock', 'lootNearby', 'emit', 'withTimeout', 'safeWarpHome',
    'HOME_SAFE', 'stopMotion', 'huntCookGoal', 'ENSURE_SKIP_POINTS', 'NO_GIVE', 'markWorkBeforeTrip',
    `let _surfaceTripBusy = false;\nlet _foodSurfaceTripAt = 0;\n${src}\nreturn ensureFood;`)(
    async (d) => { captured = d; }, () => ({}), w.bot, () => 0, async () => 0, () => {},
    async (p) => p, async () => { warps++; throw new Error('warp KO'); },
    'safe', () => {}, async () => {}, 20, false, () => true);
  await f();
  await assert.rejects(captured.surfaceTrip({ ms: 1000, y: 10, food: 3 }), /warp KO/);
  await assert.rejects(captured.surfaceTrip({ ms: 1000, y: 10, food: 3 }), /warp KO/);
  assert.strictEqual(warps, 2, 'le 2e appel a pu repartir : le verrou n est pas resté pris');
});

test('ensureFood (câblage) : une exception de runEnsureFood ne remonte jamais (best-effort)', async () => {
  const w = ensureGlue();
  const src = slice('async function ensureFood() {', '// Kit de départ DÉTERMINISTE');
  const f = new Function('runEnsureFood', 'buildCtxInv', 'bot', 'foodStock', 'lootNearby', 'emit', 'withTimeout', 'safeWarpHome',
    'HOME_SAFE', 'stopMotion', 'huntCookGoal', 'ENSURE_SKIP_POINTS', 'NO_GIVE',
    `let _surfaceTripBusy = false;\nlet _foodSurfaceTripAt = 0;\n${src}\nreturn ensureFood;`)(
    async () => { throw new Error('boom'); }, () => ({}), w.bot, () => 0, async () => 0, () => {},
    async (p) => p, async () => {}, 'safe', () => {}, async () => {}, 20, false);
  await f();                                                               // ne doit pas jeter
});

// ─── huntCookGoal : les dépendances sont branchées sur les bons globaux ─────────────────────────

function huntGlue(over = {}) {
  const w = {
    bot: { entity: { position: { x: 0, y: 70, z: 0 } } },
    taskToken: { cancelled: false },
    items: { beef: 3, cooked_beef: 1, furnace: 1, fishing_rod: 1, porkchop: 5, coal: 2 },
    captured: null, capturedArgs: null,
    passive: { name: 'cow' },
    passiveThrows: false,
    hunts: [], smelts: [], fishes: [], timeouts: [], stops: 0,
    ...over,
  };
  const src = slice('async function huntCookGoal(target', '// PÊCHE — plan B nourriture');
  const env = {
    taskToken: w.taskToken,
    runHuntCook: async (d, t, o) => { w.captured = d; w.capturedArgs = [t, o]; return { ok: true }; },
    buildCtxInv: () => ({ ...w.items }),
    bot: w.bot,
    nearestPassive: (b, r) => { if (w.passiveThrows) throw new Error('monde illisible'); w.lastRadius = r; return w.passive; },
    HUNT_SIGHT_RADIUS: F.HUNT_SIGHT_RADIUS,
    withTimeout: async (p, ms, onTimeout) => { w.timeouts.push([ms, onTimeout]); return p; },
    huntPassive: async (b, o, token) => { w.hunts.push([o, token]); return { ok: true, kills: 1 }; },
    stopMotion: () => { w.stops++; },
    RAW2COOKED: { beef: 'cooked_beef', porkchop: 'cooked_porkchop', chicken: 'cooked_chicken' },
    _invTotal: (filter) => Object.keys(w.items).filter((n) => filter({ name: n })).reduce((s, n) => s + w.items[n], 0),
    smeltWithFurnace: async (a, b, c, d, e) => { w.smelts.push([a, b, c, d, e]); return w.smeltResult || { ok: true, got: c }; },
    fuelUnits: (items) => items.reduce((n, i) => n + (i.name === 'coal' ? 8 : i.name.endsWith('_planks') ? 1.5 : 0) * i.count, 0),
    fuelNames: () => ['coal', 'oak_planks'],
    fishGoal: async (t, o) => { w.fishes.push([t, o]); return { ok: true, caught: 1, reason: 'target' }; },
    FISH_TARGET: F.FISH_TARGET,
    FISH_RADIUS: F.FISH_RADIUS,
    emit: () => {},
  };
  w.bot.inventory = { items: () => Object.keys(w.items).map((name) => ({ name, count: w.items[name] })) };
  const names = Object.keys(env);
  const factory = new Function(...names, `${src}\nreturn huntCookGoal;`);
  w.huntCookGoal = factory(...names.map((n) => env[n]));
  return w;
}

test('huntCookGoal (câblage) : jeton CAPTURÉ à l entrée, target et options relayés', async () => {
  const w = huntGlue();
  const budget = F.createBudget(1000);
  await w.huntCookGoal(6, { budget, goalPoints: 20 });
  assert.strictEqual(w.captured.token, w.taskToken);
  assert.deepStrictEqual(w.capturedArgs, [6, { budget, goalPoints: 20 }]);
  await w.huntCookGoal(4);
  assert.deepStrictEqual(w.capturedArgs, [4, {}]);
});

test('huntCookGoal (câblage) : proie en vue = nearestPassive à 32 blocs ; lecture impossible → false', async () => {
  const w = huntGlue();
  await w.huntCookGoal(4);
  assert.strictEqual(w.captured.passiveInView(), true);
  assert.strictEqual(w.lastRadius, 32);
  w.passive = null;
  assert.strictEqual(w.captured.passiveInView(), false);
  w.passiveThrows = true;
  assert.strictEqual(w.captured.passiveInView(), false);
});

test('huntCookGoal (câblage) : la chasse relaie le jeton dérivé à huntPassive, et le plafond COUPE ce jeton', async () => {
  const w = huntGlue();
  await w.huntCookGoal(4);
  const ctl = F.boundedToken(w.taskToken);
  const r = await w.captured.hunt({ count: 4, token: ctl.token, ms: 45000, cancel: ctl.cancel });
  assert.deepStrictEqual(r, { ok: true, kills: 1 });
  assert.deepStrictEqual(w.hunts[0][0], { count: 4, maxDistance: 32 });
  assert.strictEqual(w.hunts[0][1], ctl.token);
  assert.strictEqual(w.timeouts[0][0], 45000);
  // à l expiration du délai : le jeton est coupé ET le mouvement stoppé
  assert.strictEqual(ctl.token.cancelled, false);
  w.timeouts[0][1]();
  assert.strictEqual(ctl.token.cancelled, true);
  assert.strictEqual(w.stops, 1);
});

test('huntCookGoal (câblage) : piles de viande crue — seulement le cru, le plus abondant d abord', async () => {
  const w = huntGlue();
  await w.huntCookGoal(4);
  assert.deepStrictEqual(w.captured.rawStacks(), [
    { name: 'porkchop', out: 'cooked_porkchop', count: 5 },
    { name: 'beef', out: 'cooked_beef', count: 3 },
  ]);
  assert.strictEqual(w.captured.hasFurnace(), true);
  assert.strictEqual(w.captured.hasRod(), true);
  w.items = { cooked_beef: 4 };
  assert.deepStrictEqual(w.captured.rawStacks(), []);
  assert.strictEqual(w.captured.hasFurnace(), false);
  assert.strictEqual(w.captured.hasRod(), false);
});

test('huntCookGoal (câblage) : la cuisson passe le plafond maxMs à smeltWithFurnace et rend le nombre fondu', async () => {
  const w = huntGlue();
  await w.huntCookGoal(4);
  const n = await w.captured.cook({ name: 'beef', out: 'cooked_beef', count: 3, maxMs: 33000 });
  assert.strictEqual(n, 3);
  assert.deepStrictEqual(w.smelts[0], ['beef', 'cooked_beef', 3, undefined, { maxMs: 33000 }]);
  w.smeltResult = { ok: false, got: 1, reason: 'partial' };
  assert.strictEqual(await w.captured.cook({ name: 'beef', out: 'cooked_beef', count: 3, maxMs: 33000 }), 1);
  w.smeltResult = { ok: false, reason: 'no_furnace' };
  assert.strictEqual(await w.captured.cook({ name: 'beef', out: 'cooked_beef', count: 3, maxMs: 33000 }), 0);
});

test('huntCookGoal (câblage) : sans combustible on ne pose pas de four pour rien', async () => {
  const w = huntGlue({ items: { beef: 3, furnace: 1 } });                // ni charbon ni planches
  await w.huntCookGoal(4);
  assert.strictEqual(await w.captured.cook({ name: 'beef', out: 'cooked_beef', count: 3, maxMs: 33000 }), 0);
  assert.strictEqual(w.smelts.length, 0, 'aucun four posé/repris (~5-8 s) pour une fonte impossible');
  w.items = { beef: 3, furnace: 1, oak_planks: 4 };                      // du bois suffit
  assert.strictEqual(await w.captured.cook({ name: 'beef', out: 'cooked_beef', count: 3, maxMs: 33000 }), 3);
});

test('huntCookGoal (câblage) : la pêche est LOCALE (eau ≤ 16 blocs, durées resserrées) et coupée à l expiration', async () => {
  const w = huntGlue();
  await w.huntCookGoal(4);
  const ctl = F.boundedToken(w.taskToken);
  await w.captured.fish({ ms: 40000, token: ctl.token, cancel: ctl.cancel });
  assert.deepStrictEqual(w.fishes[0], [4, { token: ctl.token, maxDistance: 16, totalMs: 40000, perCatchMs: 20000, gotoMs: 12000 }]);
  const lastTimeout = w.timeouts[w.timeouts.length - 1];
  assert.strictEqual(lastTimeout[0], 43000, 'plafond = durée + 3 s de marge');
  lastTimeout[1]();
  assert.strictEqual(ctl.token.cancelled, true);
});

// ─── Cartographe : la chasse opportuniste à chaque arrivée ──────────────────────────────────────

function arriveGlue(over = {}) {
  const w = {
    bot: { entity: { position: { x: 0, y: 70, z: 0 } } },
    inv: {},
    passive: { name: 'cow' },
    night: false,
    mapperToken: { cancelled: false },
    hunts: [], timeouts: [], events: [], stops: 0,
    huntResult: { ok: true, kills: 1 },
    ...over,
  };
  const src = slice('onArrive: async () => {', '    // chaque jambe bornée');
  const env = {
    mapperNightGuard: async () => w.night,
    foodPoints: F.foodPoints,
    buildCtxInv: () => w.inv,
    STOCK_POINTS: F.STOCK_POINTS,
    nearestPassive: (b, r) => { w.lastRadius = r; return w.passive; },
    boundedToken: F.boundedToken,
    mapperToken: w.mapperToken,
    withTimeout: async (p, ms, onTimeout) => { w.timeouts.push([ms, onTimeout]); return p; },
    huntPassive: async (b, o, token) => { w.hunts.push([o, token]); return w.huntImpl ? w.huntImpl(b, o, token) : w.huntResult; },
    HUNT_WAVE_MS: F.HUNT_WAVE_MS,
    stopMotion: () => { w.stops++; },
    emit: (e) => w.events.push(e),
    bot: w.bot,
  };
  const names = Object.keys(env);
  const factory = new Function(...names, `const handlers = {\n${src}\n  };\nreturn handlers.onArrive;`);
  w.onArrive = factory(...names.map((n) => env[n]));
  return w;
}

test('mappeur onArrive : assez de points (cru ou chair putréfiée compris) → aucune chasse', async () => {
  const w = arriveGlue({ inv: { rotten_flesh: 6 } });                   // 12 points
  await w.onArrive();
  assert.strictEqual(w.hunts.length, 0);
  const w2 = arriveGlue({ inv: { beef: 4 } });
  await w2.onArrive();
  assert.strictEqual(w2.hunts.length, 0);
});

test('mappeur onArrive : pas de proie à ≤ 24 blocs, ou nuit → aucune chasse', async () => {
  const sans = arriveGlue({ inv: {}, passive: null });
  await sans.onArrive();
  assert.strictEqual(sans.hunts.length, 0);
  assert.strictEqual(sans.lastRadius, 24);
  const nuit = arriveGlue({ inv: {}, night: true });
  await nuit.onArrive();
  assert.strictEqual(nuit.hunts.length, 0);
});

test('mappeur onArrive : réserve basse + proie → 2 proies max, ≤ 45 s, event de synthèse', async () => {
  const w = arriveGlue({ inv: { cooked_beef: 1 } });                    // 8 points < 12
  await w.onArrive();
  assert.deepStrictEqual(w.hunts[0][0], { count: 2, maxDistance: 24 });
  assert.strictEqual(w.timeouts[0][0], 45000);
  assert.deepStrictEqual(w.events, [{ type: 'opportunistic_hunt', kills: 1 }]);
});

test('mappeur onArrive : le jeton de chasse SUIT celui du cartographe (annulé = la chasse s arrête)', async () => {
  const w = arriveGlue({ inv: { cooked_beef: 1 } });
  w.huntImpl = async (b, o, token) => {
    const avant = token.cancelled;
    w.mapperToken.cancelled = true;                                     // le cartographe est annulé en pleine chasse
    w.observed = [avant, token.cancelled];
    return { ok: true, kills: 0 };
  };
  await w.onArrive();
  assert.deepStrictEqual(w.observed, [false, true]);
});

test('mappeur onArrive : la vague finie, le jeton est coupé (rien ne court en fond) ; le délai stoppe le mouvement', async () => {
  const w = arriveGlue({ inv: { cooked_beef: 1 } });
  await w.onArrive();
  assert.strictEqual(w.hunts[0][1].cancelled, true);
  assert.ok(typeof w.timeouts[0][1] === 'function');
  w.timeouts[0][1]();
  assert.strictEqual(w.stops, 1, 'à l expiration le mouvement est stoppé');
});

test('mappeur onArrive : le jeton s arrête dès que les points atteignent le seuil (huntPassive le relit à chaque proie)', async () => {
  const w = arriveGlue({ inv: { cooked_beef: 1 } });                    // 8 points
  w.huntImpl = async (b, o, token) => {
    const avant = token.cancelled;
    w.inv = { cooked_beef: 1, beef: 2 };                                // une proie ramassée : 14 points ≥ 12
    const apres = token.cancelled;
    w.observed = [avant, apres];
    return { ok: true, kills: 1 };
  };
  await w.onArrive();
  assert.deepStrictEqual(w.observed, [false, true]);
});

// ─── Contre le VRAI code des plugins et des skills (faux bot, aucun serveur) ────────────────────
// Un test qui INJECTE une dépendance ne prouve pas qu'on la BRANCHE bien — ni que l'ordre des events
// réels est celui qu'on suppose. Ici : la vraie classe PVP de mineflayer-pvp, le vrai huntPassive, le
// vrai fishCatch, pilotés par nos jetons dérivés.
let real = null;
try {
  const registry = require('prismarine-registry')('1.21.4');
  real = {
    registry,
    PVP: require('mineflayer-pvp/lib/PVP').PVP,
    Movements: require('mineflayer-pathfinder').Movements,
    Vec3: require('vec3').Vec3,
  };
} catch (e) { real = null; }
const SKIP_REAL = !real && 'mineflayer-pvp / mineflayer-pathfinder / prismarine-registry introuvables';

function pvpBot() {
  const bot = combatGlue().bot;
  bot.version = '1.21.4';
  bot.registry = real.registry;
  bot.entity = { position: new real.Vec3(0, 70, 0), effects: {} };
  bot.blockAt = () => null;
  bot.inventory = { items: () => [] };
  bot.game = { minY: -64 };
  let active = null;
  bot.pathfinder = {
    goal: null,
    setMovements(m) { active = m; },
    get movements() { return active; },
    setGoal(g) { this.goal = g; },
    stop() { this.goal = null; setImmediate(() => bot.emit('path_stop')); },
  };
  bot.pvp = new real.PVP(bot);
  return bot;
}

function realCombatGlue(bot, over = {}) {
  const w = combatGlue(over);
  // même glue que la production, branché sur CE faux bot (EventEmitter + vraie classe PVP)
  const src = slice('function wireCombatLoot() {', '// Post-mort (cible keepInventory OFF');
  const env = {
    bot, sleep: async (ms) => { w.sleeps.push(ms); await new Promise((r) => setImmediate(r)); }, homewarp,
    nearbyHostiles: () => w.hostiles, isInWater: () => false, taskCtl: { active: 'autonomous' },
    shouldLootAfterCombat: F.shouldLootAfterCombat,
    lootNearby: async (o) => { w.looted.push(o); return 1; },
    emit: (e) => w.events.push(e),
    COMBAT_LOOT_RADIUS: F.COMBAT_LOOT_RADIUS, COMBAT_LOOT_ITEMS: F.COMBAT_LOOT_ITEMS, COMBAT_LOOT_MS: F.COMBAT_LOOT_MS,
    COMBAT_LOOT_HOSTILE_RADIUS: F.COMBAT_LOOT_HOSTILE_RADIUS, COMBAT_LOOT_SETTLE_MS: F.COMBAT_LOOT_SETTLE_MS,
  };
  const names = Object.keys(env);
  w.glue = new Function(...names, `
    let _combatLootWired = false; let _combatLootBusy = false; let _combatTarget = null;
    ${FLAGS.map((f) => `let ${f} = false;`).join(' ')}
    ${src}
    return { wireCombatLoot, state: () => ({ wired: _combatLootWired, busy: _combatLootBusy, target: _combatTarget }) };
  `)(...names.map((n) => env[n]));
  return w;
}
const mob = (name, kind, type, x = 5) => ({ name, kind, type, position: new real.Vec3(x, 70, 0) });

test('VRAI PVP : un zombie combattu puis lâché → la cible est relevée au début, le butin déclenché à la fin', { skip: SKIP_REAL }, async () => {
  const bot = pvpBot();
  const w = realCombatGlue(bot);
  bot.entities = { 1: { type: 'item', position: new real.Vec3(1, 70, 0) } };
  w.glue.wireCombatLoot();
  await bot.pvp.attack(mob('zombie', 'Hostile mobs', 'hostile'));
  assert.strictEqual(w.glue.state().target.name, 'zombie', 'startedAttacking : bot.pvp.target est déjà posée');
  assert.strictEqual(bot.pvp.target.name, 'zombie');
  await bot.pvp.stop();
  assert.strictEqual(bot.pvp.target, undefined, 'stoppedAttacking : mineflayer-pvp a déjà vidé la cible — d où le relevé au début');
  await settle();
  assert.deepStrictEqual(w.looted, [{ radius: 6, maxItems: 4, budgetMs: 5000, abortOnFail: true }]);
});

test('VRAI PVP : une vache chassée puis lâchée (stopMotion de huntPassive) → AUCUN ramassage concurrent', { skip: SKIP_REAL }, async () => {
  const bot = pvpBot();
  const w = realCombatGlue(bot);
  bot.entities = { 1: { type: 'item', position: new real.Vec3(1, 70, 0) } };
  w.glue.wireCombatLoot();
  await bot.pvp.attack(mob('cow', 'Passive mobs', 'animal'));
  await bot.pvp.stop();
  await settle();
  assert.strictEqual(w.looted.length, 0);
});

test('VRAI PVP : stop() sans combat en cours n émet rien (stopMotion appelé partout ne déclenche aucun butin)', { skip: SKIP_REAL }, async () => {
  const bot = pvpBot();
  const w = realCombatGlue(bot);
  bot.entities = { 1: { type: 'item', position: new real.Vec3(1, 70, 0) } };
  w.glue.wireCombatLoot();
  await bot.pvp.stop();
  await bot.pvp.stop();
  await settle();
  assert.strictEqual(w.looted.length, 0);
});

test('VRAI PVP : on enchaîne sur un autre hostile (attack() fait stop puis start) → pas de ramassage au milieu du combat', { skip: SKIP_REAL }, async () => {
  const bot = pvpBot();
  const w = realCombatGlue(bot);
  bot.entities = { 1: { type: 'item', position: new real.Vec3(1, 70, 0) } };
  w.glue.wireCombatLoot();
  await bot.pvp.attack(mob('zombie', 'Hostile mobs', 'hostile'));
  await bot.pvp.attack(mob('skeleton', 'Hostile mobs', 'hostile', 9));     // émet stoppedAttacking PUIS startedAttacking
  await settle();
  assert.strictEqual(w.looted.length, 0, 'un nouveau combat est en cours : la porte reste fermée');
  assert.strictEqual(w.glue.state().target.name, 'skeleton', 'et la cible suivie est la nouvelle');
  await bot.pvp.stop();
  await settle();
  assert.strictEqual(w.looted.length, 1, 'la fin du DERNIER combat, elle, ramasse');
});

test('VRAI PVP + ordre des écouteurs : le gardien de Movements passe AVANT le butin (nominale rendue avant de marcher)', { skip: SKIP_REAL }, async () => {
  const { createMovesKeeper } = require('./pluginMoves');
  const bot = pvpBot();
  const nominal = new real.Movements(bot);
  bot._mcaMoves = nominal;
  bot.pathfinder.setMovements(nominal);
  const w = realCombatGlue(bot);
  bot.entities = { 1: { type: 'item', position: new real.Vec3(1, 70, 0) } };
  createMovesKeeper({ bot }).watchPvp(bot);              // comme onSpawn : le gardien d abord…
  w.glue.wireCombatLoot();                                // …le butin ensuite
  let movementsAtLoot = null;
  const realLoot = w.looted.push.bind(w.looted);
  w.looted.push = (o) => { movementsAtLoot = bot.pathfinder.movements; return realLoot(o); };
  await bot.pvp.attack(mob('zombie', 'Hostile mobs', 'hostile'));
  assert.strictEqual(bot.pathfinder.movements, bot.pvp.movements, 'pendant le combat : celle du plugin');
  await bot.pvp.stop();
  await settle();
  assert.strictEqual(w.looted.length, 1);
  assert.strictEqual(movementsAtLoot, nominal, 'au moment du ramassage la nominale est de retour');
});

test('VRAI huntPassive : le jeton dérivé s arrête à la proie SUIVANTE dès que les points suffisent', async () => {
  const vec3 = require('vec3');
  const { huntPassive } = require('./skills/hunt');
  const mk = (name, x) => ({ name, kind: 'Passive mobs', type: 'mob', position: vec3(x, 64, 0), isValid: true });
  const a = mk('cow', 4); const b = mk('pig', 8); const c = mk('sheep', 12);
  const inv = {};
  const attacked = [];
  const bot = {
    entity: { position: vec3(0, 64, 0) },
    entities: { 1: a, 2: b, 3: c },
    inventory: { items: () => [] },
    nearestEntity(fn) {
      let best = null; let bestD = Infinity;
      for (const e of Object.values(this.entities)) {
        if (!e.isValid || !fn(e)) continue;
        const d = e.position.distanceTo(this.entity.position);
        if (d < bestD) { bestD = d; best = e; }
      }
      return best;
    },
    equip: async () => {},
    pvp: { attack: (e) => { attacked.push(e.name); e._hit = true; }, stop: () => {} },
    pathfinder: { goto: async () => {} },
    registry: { itemsByName: {} },
  };
  const ctl = F.boundedToken({ cancelled: false }, () => F.foodPoints(inv) >= 12);
  const r = await huntPassive(bot, { count: 4, maxDistance: 32 }, ctl.token, {
    sleep: async () => { for (const e of Object.values(bot.entities)) if (e._hit) e.isValid = false; },
    goto: async () => { inv.beef = (inv.beef || 0) + 4; },        // le 1er gibier rapporte 4 bœufs crus = 12 points
    pickupMs: 0,
  });
  assert.deepStrictEqual(attacked, ['cow'], 'objectif atteint après la 1re proie : on ne chasse pas les deux autres');
  assert.strictEqual(r.kills, 1);
  assert.strictEqual(r.ok, true);
});

test('VRAI huntPassive : le jeton coupé par le plafond arrête une chasse en cours de poursuite', async () => {
  const vec3 = require('vec3');
  const { huntPassive } = require('./skills/hunt');
  const cow = { name: 'cow', kind: 'Passive mobs', type: 'mob', position: vec3(4, 64, 0), isValid: true };
  const bot = {
    entity: { position: vec3(0, 64, 0) },
    entities: { 1: cow },
    inventory: { items: () => [] },
    nearestEntity(fn) { return fn(cow) ? cow : null; },
    equip: async () => {},
    pvp: { attack: () => {}, stop: () => {} },
    pathfinder: { goto: async () => {} },
    registry: { itemsByName: {} },
  };
  const ctl = F.boundedToken({ cancelled: false });
  let polls = 0;
  const r = await huntPassive(bot, { count: 4, maxDistance: 32 }, ctl.token, {
    sleep: async () => { polls++; if (polls === 3) ctl.cancel(); },    // le plafond tombe pendant la poursuite
    pickupMs: 0,
  });
  assert.strictEqual(polls, 3, 'la poursuite s arrête au poll suivant la coupure, pas 20 s plus tard');
  assert.strictEqual(r.kills, 0);
});

test('VRAI fishCatch : le jeton dérivé coupe la pêche entre deux lancers', async () => {
  const { fishCatch } = require('./skills/fish');
  const ctl = F.boundedToken({ cancelled: false }, () => caught >= 1);
  let caught = 0;
  const bot = {
    entity: { position: { x: 0, y: 64, z: 0 } },
    inventory: { items: () => [{ name: 'fishing_rod', count: 1 }] },
    registry: { blocksByName: { water: { id: 1 }, flowing_water: { id: 2 } } },
    findBlocks: () => [{ x: 5, y: 63, z: 0 }],
    // un étang d UN bloc en (5,63,0), de la pierre dessous et à côté, de l air au-dessus
    blockAt: (p) => {
      if (p.x === 5 && p.y === 63 && p.z === 0) return { name: 'water', boundingBox: 'empty' };
      if (p.y <= 63) return { name: 'stone', boundingBox: 'block' };
      return { name: 'air', boundingBox: 'empty' };
    },
    equip: async () => {}, lookAt: async () => {}, activateItem: () => {},
    fish: async () => { caught++; },
  };
  const r = await fishCatch(bot, { sleep: async () => {}, goto: async () => {} },
    { target: 4, token: ctl.token, maxDistance: 16, totalMs: 40000, perCatchMs: 20000, gotoMs: 12000, recastMs: 0 });
  assert.strictEqual(caught, 1, 'une prise suffit au but : pas de 2e lancer');
  assert.strictEqual(r.reason, 'cancelled');
  assert.strictEqual(r.caught, 1);
});
