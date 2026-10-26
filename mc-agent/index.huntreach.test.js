'use strict';
// CÂBLAGE (22/10) : le filet « manger » de index.js mange aussi BLESSÉ sous 18 (sinon les PV ne remontent
// jamais), choisit le poulet cru en dernier, attend la fin du corps-à-corps sauf muré dans l'abri.
// Le VRAI texte de la fonction tourne dans un bac à sable `vm` strict (piège #56).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const R = require('./reflexes');
const C = require('./cookMeat');
const E = require('./eatSafe');

const SRC = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');
function grab(re, label) {
  const m = SRC.match(re);
  assert.ok(m, `${label} introuvable dans index.js`);
  return m[0];
}
const fnSrc = (name) => grab(new RegExp(`^(?:async )?function ${name}\\([^)]*\\) \\{[\\s\\S]*?^\\}$`, 'm'), `function ${name}`);
const letSrc = (name) => grab(new RegExp(`^let ${name} = [^;]+;`, 'm'), `let ${name}`);

function sandbox(o = {}) {
  const sb = {
    events: [], eaten: [], cooks: [], cookFailed: false,
    inv: (o.items || []).map((name) => ({ name, count: 1 })),
    emit(e) { sb.events.push(e); },
    Object, Math, Number, Array, JSON, Promise, String, Error,
    pickFood: R.pickFood, eatWanted: R.eatWanted,
    healEatWanted: E.healEatWanted, eatEffective: E.eatEffective, itemCount: E.itemCount,
    noEffectBackoffMs: E.noEffectBackoffMs, cookFirstWhenHurt: E.cookFirstWhenHurt,
    EAT_LOCK_MS: E.EAT_LOCK_MS, MAX_HEAL_BITES: E.MAX_HEAL_BITES,
    sleep: async () => {},
    locks: [],
    isRawMeat: C.isRawMeat, rawEatAllowed: C.rawEatAllowed, ateFields: C.ateFields,
    // Cuisson (23/10) : par défaut IMPOSSIBLE (ni four ni combustible) → le cru se mange comme avant.
    netMeatCookable: () => !!o.cookable && !sb.cookFailed,
    netCookFree: () => o.free !== false,
    cookMeatLot: async (tag, opts) => {
      sb.cooks.push([tag, opts]);
      if (o.cookWorks === false) { sb.cookFailed = true; return 0; }
      const it = sb.inv.find((i) => C.isRawMeat(i.name));
      if (it) it.name = C.RAW2COOKED[it.name];
      return 1;
    },
    Date: o.now ? { now: () => o.now } : Date,
    withTimeout: (p) => p,
    _nearestThreatDist: () => (o.threat == null ? null : o.threat),
    // PAS DE BOUCHÉE AU CONTACT (26/10) : `combat` = [{name, d}] hostiles autour, `atk` = dégât de l'arme.
    nearbyHostiles: () => (o.combat || []).map((h) => ({ name: h.name, position: { x: h.d, y: 0, z: 0 } })),
    attackDamage: () => (o.atk == null ? 6 : o.atk),
    combatEatBlocked: E.combatEatBlocked, COMBAT_EAT_REACH: E.COMBAT_EAT_REACH,
    bot: {
      food: o.food, health: o.health, entity: { position: { x: 0, y: 0, z: 0 } },
      pvp: { target: o.fighting ? { name: 'zombie' } : null },
      inventory: { items: () => sb.inv.map((i) => ({ name: i.name, count: i.count })) },
      stopDigging() {},
      equip: async (it) => { sb.eaten.push(it.name); sb.held = it.name; },
      // Une VRAIE bouchée consomme l'objet et remonte la faim (+4) ; `noEffect` = le bug du 24/10
      // (consume() rendu sans manger : objet en main changé par le branch-mine / l'aura).
      consume: async () => {
        if (o.consumeThrows) throw new Error('busy');
        sb.locks.push(sb.bot._eatLockUntil || 0);
        if (o.noEffect) return;
        const i = sb.inv.findIndex((x) => x.name === sb.held);
        if (i >= 0) sb.inv.splice(i, 1);
        sb.bot.food = Math.min(20, sb.bot.food + 4);
      },
    },
  };
  vm.createContext(sb);
  vm.runInContext("'use strict';\n" + [letSrc('_hungerBusy'), letSrc('_rawDeferSince'), letSrc('_eatNoEffectStreak'),
    letSrc('_eatBackoffUntil'), ...(o.combat ? [letSrc('_combatEatHeldEmitAt'), fnSrc('_combatEatHeld')] : []), fnSrc('eatBite'), fnSrc('hungerNetTick'),
    'this.hungerNetTick = hungerNetTick;'].join('\n'), sb);
  return sb;
}

test('filet : blessé (PV 5) à faim 14 avec du porc cru → il MANGE (le cas du chrono du 22/10)', async () => {
  const sb = sandbox({ food: 14, health: 5, items: ['porkchop'] });
  assert.strictEqual(await sb.hungerNetTick(), true);
  assert.deepStrictEqual(sb.eaten, ['porkchop']);
  assert.ok(sb.events.some((e) => e.type === 'ate' && e.via === 'net'));
});

test('filet : rassasié (18) ou indemne → ne mange pas', async () => {
  assert.strictEqual(await sandbox({ food: 18, health: 5, items: ['beef'] }).hungerNetTick(), false);
  assert.strictEqual(await sandbox({ food: 14, health: 20, items: ['beef'] }).hungerNetTick(), false);
});

test('filet : poulet cru en DERNIER recours', async () => {
  const sb = sandbox({ food: 4, health: 20, items: ['chicken', 'beef'] });
  await sb.hungerNetTick();
  assert.deepStrictEqual(sb.eaten, ['beef']);
});

test('filet : blessé en plein corps-à-corps → attend (épée en main) ; affamé (≤ 8) → mange quand même', async () => {
  assert.strictEqual(await sandbox({ food: 14, health: 5, items: ['beef'], threat: 3 }).hungerNetTick(), false);
  assert.strictEqual(await sandbox({ food: 14, health: 5, items: ['beef'], fighting: true }).hungerNetTick(), false);
  assert.strictEqual(await sandbox({ food: 6, health: 5, items: ['beef'], threat: 3 }).hungerNetTick(), true);
});

test('filet : muré dans l abri (sealed) → le zombie derrière la paroi ne l empêche pas de manger', async () => {
  const sb = sandbox({ food: 14, health: 5, items: ['beef'], threat: 2 });
  assert.strictEqual(await sb.hungerNetTick('shelter', { sealed: true }), true);
  assert.ok(sb.events.some((e) => e.type === 'ate' && e.via === 'shelter'));
});

test('filet : échec de consommation → eat_failed tracé, rend false', async () => {
  const sb = sandbox({ food: 4, health: 20, items: ['beef'], consumeThrows: true });
  assert.strictEqual(await sb.hungerNetTick(), false);
  assert.ok(sb.events.some((e) => e.type === 'eat_failed'));
});

test('index.js : timers et état de la chasse/des troupeaux au NIVEAU MODULE (piège #56)', () => {
  assert.match(SRC, /^let _hungerBusy = false;$/m);
  assert.match(SRC, /^let _herdSavedAt = 0;$/m);
  assert.match(SRC, /^setInterval\(\(\) => \{ herdScanTick\(\); \}, HERD_SCAN_MS\);$/m);
  assert.match(SRC, /^setInterval\(\(\) => \{ hungerNetTick\(\)\.catch\(\(\) => \{\}\); \}, 5000\);$/m);
  assert.ok(SRC.indexOf('const HERD_SCAN_MS') < SRC.indexOf('}, HERD_SCAN_MS);'), 'constante déclarée avant le timer');
});


// ─── CUIRE AVANT D'AVALER DU CRU (23/10) — 286 `ate via:net` sur 296 étaient du cru ──────────────
test('filet : du cuit en poche → le CUIT d abord, event ate {raw:false, cooked:true}', async () => {
  const sb = sandbox({ food: 10, health: 5, items: ['beef', 'cooked_beef'], cookable: true });
  assert.strictEqual(await sb.hungerNetTick(), true);
  assert.strictEqual(sb.eaten[0], 'cooked_beef', 'le cuit d abord');
  const ate = sb.events.find((e) => e.type === 'ate');
  assert.strictEqual(ate.raw, false);
  assert.strictEqual(ate.cooked, true);
  assert.strictEqual(sb.cooks.length, 0);
});

test('filet : cru + four et combustible + faim 14, blessé sans danger (PV 12, bot libre) → il CUIT puis mange le cuit', async () => {
  const sb = sandbox({ food: 14, health: 12, items: ['mutton', 'mutton', 'mutton'], cookable: true });
  assert.strictEqual(await sb.hungerNetTick(), true);
  assert.deepStrictEqual(sb.cooks.map((c) => c[0]), ['net']);
  assert.strictEqual(sb.cooks[0][1].walk, false, 'depuis un timer : jamais de marche');
  assert.deepStrictEqual(sb.eaten, ['cooked_mutton']);
});

test('filet : cru, cuisson possible mais bot OCCUPÉ, INDEMNE à faim 8 → il diffère (ne mange pas le cru)', async () => {
  const sb = sandbox({ food: 8, health: 20, items: ['beef'], cookable: true, free: false });
  assert.strictEqual(await sb.hungerNetTick(), false);
  assert.deepStrictEqual(sb.eaten, []);
});

test('filet : BLESSÉ, cuisson possible mais bot occupé → le cru TOUT DE SUITE (24/10 : différer = rester à 1 PV)', async () => {
  const sb = sandbox({ food: 13, health: 1.1, items: ['beef'], cookable: true, free: false });
  assert.strictEqual(await sb.hungerNetTick(), true);
  assert.deepStrictEqual(sb.eaten, ['beef']);
  assert.strictEqual(sb.cooks.length, 0);
});

test('filet : différé plus de 90 s sans occasion de cuire → il mange le cru', async () => {
  const sb = sandbox({ food: 8, health: 20, items: ['beef'], cookable: true, free: false, now: 1000 });
  assert.strictEqual(await sb.hungerNetTick(), false);
  sb.Date = { now: () => 1000 + C.RAW_DEFER_MAX_MS };
  assert.strictEqual(await sb.hungerNetTick(), true);
  assert.deepStrictEqual(sb.eaten, ['beef']);
  assert.strictEqual(sb.events.find((e) => e.type === 'ate').raw, true);
});

test('filet : faim ≤ 6 → le cru tout de suite, même si on pourrait cuire', async () => {
  const sb = sandbox({ food: 6, health: 20, items: ['beef'], cookable: true });
  assert.strictEqual(await sb.hungerNetTick(), true);
  assert.deepStrictEqual(sb.eaten, ['beef']);
  assert.strictEqual(sb.cooks.length, 0);
});

test('filet : cuisson ratée → le cru se mange dans le même tick (pas de bot affamé qui attend)', async () => {
  const sb = sandbox({ food: 14, health: 5, items: ['beef'], cookable: true, cookWorks: false });
  assert.strictEqual(await sb.hungerNetTick(), true);
  assert.deepStrictEqual(sb.eaten, ['beef']);
});

test('filet : muré dans l abri → pas de four posé dans le mur, le cru se mange', async () => {
  const sb = sandbox({ food: 14, health: 5, items: ['beef'], cookable: true });
  assert.strictEqual(await sb.hungerNetTick('shelter', { sealed: true }), true);
  assert.strictEqual(sb.cooks.length, 0);
  assert.deepStrictEqual(sb.eaten, ['beef']);
});

test('index.js : état de la cuisson au NIVEAU MODULE (lu par le timer du filet, piège #56)', () => {
  for (const name of ['_cookBusy', '_cookFailUntil', '_rawDeferSince']) {
    assert.match(SRC, new RegExp(`^let ${name}\\b`, 'm'), `${name} doit être un let de colonne 0`);
  }
  for (const fn of ['cookMeatLot', 'meatCookAccess', 'meatCookPlanNow', 'netMeatCookable', 'netCookFree']) {
    assert.match(SRC, new RegExp(`^(?:async )?function ${fn}\\(`, 'm'), `${fn} doit être de niveau module`);
  }
  assert.match(SRC, /cookLot: \(\) => cookMeatLot\('hunt'\)/, 'la chasse cuit son lot');
  assert.match(SRC, /await cookMeatLot\('mine', \{ walk: false \}\)/, 'le hook du branch-mine cuit sans marcher');
  assert.match(SRC, /await cookMeatLot\('goal'\)/, 'entre deux buts');
  assert.match(SRC, /await cookBetweenGoals\(g\);/, 'runSkillWithTelemetry cuit entre deux buts');
});


// ─── SE SOIGNER EN MANGEANT, ET VÉRIFIER QU'ON A MANGÉ (24/10, eatSafe.js) ──────────────────────
test('filet : blessé → il enchaîne les bouchées jusqu à faim ≥ 18 et émet heal_eat', async () => {
  const sb = sandbox({ food: 10, health: 3, items: ['cooked_beef', 'cooked_beef', 'cooked_beef'] });
  assert.strictEqual(await sb.hungerNetTick(), true);
  assert.deepStrictEqual(sb.eaten, ['cooked_beef', 'cooked_beef'], '10 → 14 → 18 : deux bouchées');
  assert.strictEqual(sb.bot.food, 18);
  const h = sb.events.filter((e) => e.type === 'heal_eat');
  assert.strictEqual(h.length, 2);
  assert.deepStrictEqual([h[0].food_before, h[0].food_after, h[0].item, h[0].hp], [10, 14, 'cooked_beef', 3]);
});

test('filet : affamé mais INDEMNE → une seule bouchée (pas de gavage, pas de heal_eat)', async () => {
  const sb = sandbox({ food: 4, health: 20, items: ['bread', 'bread', 'bread'] });
  assert.strictEqual(await sb.hungerNetTick(), true);
  assert.deepStrictEqual(sb.eaten, ['bread']);
  assert.ok(!sb.events.some((e) => e.type === 'heal_eat'));
});

test('filet : consume() rendu SANS effet (objet en main changé) → eat_failed no_effect, PAS de faux ate', async () => {
  const sb = sandbox({ food: 17, health: 11.4, items: ['cooked_porkchop', 'cooked_porkchop'], noEffect: true, now: 1000 });
  assert.strictEqual(await sb.hungerNetTick(), false);
  assert.ok(!sb.events.some((e) => e.type === 'ate'), 'le cooked_porkchop toutes les 5 s à faim 17');
  const f = sb.events.find((e) => e.type === 'eat_failed');
  assert.strictEqual(f.reason, 'no_effect');
});

test('filet : bouchées sans effet répétées → backoff (pas de spin toutes les 5 s)', async () => {
  const sb = sandbox({ food: 17, health: 11.4, items: ['cooked_porkchop'], noEffect: true, now: 1000 });
  await sb.hungerNetTick();                         // raté 1 : retente au tick suivant
  await sb.hungerNetTick();                         // raté 2 : backoff 15 s
  assert.strictEqual(sb.eaten.length, 2);
  sb.Date = { now: () => 1000 + 10000 };
  assert.strictEqual(await sb.hungerNetTick(), false);
  assert.strictEqual(sb.eaten.length, 2, 'en backoff : pas de 3e essai');
  sb.Date = { now: () => 1000 + 16000 };
  await sb.hungerNetTick();
  assert.strictEqual(sb.eaten.length, 3, 'backoff écoulé : on retente');
});

test('filet : le verrou de bouchée est posé PENDANT consume et levé après', async () => {
  const sb = sandbox({ food: 13, health: 5, items: ['bread'], now: 5000 });
  await sb.hungerNetTick();
  assert.ok(sb.locks[0] > 5000, 'verrou actif pendant la consommation');
  assert.ok(!(sb.bot._eatLockUntil > 5000), 'levé ensuite');
});

test('index.js : verrou de bouchée câblé (equip/dig étrangers attendent, aura le lit) ; état au niveau MODULE', () => {
  assert.match(SRC, /^let _eatNoEffectStreak = 0;$/m);
  assert.match(SRC, /^let _eatBackoffUntil = 0;$/m);
  assert.match(SRC, /^let _eatLockWired = false;$/m);
  assert.match(SRC, /^function wireEatLock\(\)/m);
  assert.match(SRC, /try \{ wireEatLock\(\); \}/, 'branché au spawn, tous rôles');
  assert.match(SRC, /eating: !!bot\.usingHeldItem \|\| eatLockActive\(\)/, 'l aura ne rengaine pas pendant la bouchée');
  assert.match(SRC, /isLowHpSkip\(r\.reason\)/, 'raison préfixée → récupération');
});

// ─── PAS DE BOUCHÉE AU CONTACT (26/10) : NethBot3 en fer complet mangeait collé à un zombie et mourait ───
test('filet : zombie à 2,3 blocs, armé → pas de bouchée, ni échec ni backoff, trace eat_held_combat', async () => {
  const sb = sandbox({ food: 6, health: 11, items: ['beef'], combat: [{ name: 'zombie', d: 2.3 }] });
  assert.strictEqual(await sb.hungerNetTick(), false);
  assert.deepStrictEqual(sb.eaten, []);
  assert.ok(!sb.events.some((e) => e.type === 'eat_failed'));
  const h = sb.events.find((e) => e.type === 'eat_held_combat');
  assert.ok(h);
  assert.strictEqual(h.dist, 2.3);
});

test('filet : PV 3, aucune arme, zombie collé → il mange (dernière chance)', async () => {
  const sb = sandbox({ food: 6, health: 3, items: ['beef'], combat: [{ name: 'zombie', d: 1.5 }], atk: 0 });
  assert.strictEqual(await sb.hungerNetTick(), true);
});

test('filet : muré dans l abri, zombie collé → il mange', async () => {
  const sb = sandbox({ food: 6, health: 11, items: ['beef'], combat: [{ name: 'zombie', d: 1.5 }] });
  assert.strictEqual(await sb.hungerNetTick('shelter', { sealed: true }), true);
});

test('filet : zombie à 5 blocs → bouchée normale', async () => {
  const sb = sandbox({ food: 6, health: 11, items: ['beef'], combat: [{ name: 'zombie', d: 5 }] });
  assert.strictEqual(await sb.hungerNetTick(), true);
});
