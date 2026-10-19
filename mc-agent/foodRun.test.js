'use strict';
// NOURRITURE — les deux orchestrateurs (ensureFood, huntCookGoal) testés avec des dépendances
// FAUSSES et une horloge fausse : on vérifie QUOI tourne, DANS QUEL ORDRE et SOUS QUEL PLAFOND de
// temps. C est le test qui compte : un budget qui n est pas appliqué est un budget qui ment, et un
// seuil lu au mauvais endroit ne plante jamais — il rend juste la fonctionnalité morte (piège #61).
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const F = require('./food');
const { runEnsureFood, runHuntCook } = require('./foodRun');

function fakeClock(t0 = 1000) {
  const c = { t: t0, now: () => c.t, advance: (ms) => { c.t += ms; } };
  return c;
}

// ─── ensureFood ─────────────────────────────────────────────────────────────────────────────────

// Un monde minimal : inventaire (carte), altitude, faim, et des dépendances qui consomment du temps.
function ensureWorld(over = {}) {
  const clock = fakeClock();
  const w = {
    clock,
    inv: {},
    y: 70,
    hunger: 8,
    calls: [],
    events: [],
    lootTakes: 0,          // temps que consomme le balayage de butin
    lootGives: null,       // inventaire gagné par le balayage
    tripTakes: 6000,
    tripToY: 70,
    huntTakes: 0,
    huntGives: null,
    ...over,
  };
  const give = (inv, add) => { if (add) for (const k of Object.keys(add)) inv[k] = (inv[k] || 0) + add[k]; };
  w.deps = {
    now: clock.now,
    inventory: () => w.inv,
    y: () => w.y,
    hunger: () => w.hunger,
    foodItems: () => Object.keys(w.inv).filter((k) => F.FOOD_POINTS[k]).reduce((s, k) => s + w.inv[k], 0),
    loot: async (o) => { w.calls.push(['loot', o]); clock.advance(w.lootTakes); give(w.inv, w.lootGives); return w.lootGives ? 3 : 0; },
    surfaceTrip: async (o) => { w.calls.push(['trip', o]); clock.advance(w.tripTakes); w.y = w.tripToY; },
    hunt: async (o) => { w.calls.push(['hunt', { left: o.budget.left() }]); clock.advance(w.huntTakes); give(w.inv, w.huntGives); },
    canGive: false,
    give: () => { w.calls.push(['give']); },
    emit: (e) => { w.events.push(e); },
  };
  return w;
}
const names = (w) => w.calls.map((c) => c[0]);

test('ensureFood : déjà ≥ 20 points en poche → on ne sort PAS (10 chairs putréfiées suffisent)', async () => {
  const w = ensureWorld({ inv: { rotten_flesh: 10 } });
  const r = await runEnsureFood(w.deps);
  assert.deepStrictEqual(names(w), [], 'ni balayage, ni chasse, ni remontée');
  assert.strictEqual(r.why, 'enough');
  assert.strictEqual(r.points, 20);
});

test('ensureFood : 19 points → on sort encore (le seuil est bien 20, pas 19)', async () => {
  const w = ensureWorld({ inv: { rotten_flesh: 9, mutton: 0, beef: 0, potato: 1 } });   // 18 + 1
  assert.strictEqual(F.foodPoints(w.inv), 19);
  await runEnsureFood(w.deps);
  assert.deepStrictEqual(names(w).slice(0, 1), ['loot']);
});

test('ensureFood : le balayage de butin est de rayon 10, 6 objets, ≤ 8 s (et jamais plus que le budget)', async () => {
  const w = ensureWorld({ y: 70 });
  await runEnsureFood(w.deps);
  const loot = w.calls.find((c) => c[0] === 'loot')[1];
  assert.strictEqual(loot.radius, 10);
  assert.strictEqual(loot.maxItems, 6);
  assert.strictEqual(loot.abortOnFail, true, 'un objet inatteignable ne mange pas le budget');
  assert.ok(loot.budgetMs <= 8000 && loot.budgetMs > 0, `budgetMs=${loot.budgetMs}`);
});

test('ensureFood : le butin ramassé suffit (≥ 20) → pas de chasse', async () => {
  const w = ensureWorld({ lootGives: { rotten_flesh: 12 } });
  const r = await runEnsureFood(w.deps);
  assert.deepStrictEqual(names(w), ['loot']);
  assert.strictEqual(r.why, 'enough');
  assert.ok(w.events.some((e) => e.type === 'food_loot_swept' && e.items === 3), 'le balayage reste tracé');
});

test('ensureFood : en SURFACE → pas de remontée, une chasse qui reçoit le budget RESTANT', async () => {
  const w = ensureWorld({ y: 70, lootTakes: 8000 });
  await runEnsureFood(w.deps);
  assert.deepStrictEqual(names(w), ['loot', 'hunt']);
  const hunt = w.calls.find((c) => c[0] === 'hunt')[1];
  assert.strictEqual(hunt.left, 52000, '60 s − 8 s de butin : le budget est PARTAGÉ, pas remis à zéro');
});

test('ensureFood : sous terre, affamé, à sec (< 6 points) → on remonte (≤ 30 s), PUIS on chasse', async () => {
  const w = ensureWorld({ y: 12, hunger: 4, tripToY: 70 });
  await runEnsureFood(w.deps);
  assert.deepStrictEqual(names(w), ['loot', 'trip', 'hunt']);
  const trip = w.calls.find((c) => c[0] === 'trip')[1];
  assert.ok(trip.ms <= 30000 && trip.ms > 0, `ms=${trip.ms}`);
  assert.strictEqual(trip.y, 12);
  assert.strictEqual(trip.food, 4);
});

test('ensureFood : l altitude est RELUE après la remontée (sinon la chasse jugerait sur l ancienne position)', async () => {
  // Piège #61 : un champ lu au mauvais moment ne plante jamais, il rend la fonctionnalité morte.
  const w = ensureWorld({ y: 12, hunger: 4, tripToY: 70 });
  await runEnsureFood(w.deps);
  assert.ok(names(w).includes('hunt'), 'remonté en surface ⇒ la chasse doit avoir lieu');
  // …et si la remontée n a RIEN changé (signet cassé), pas de chasse sous terre :
  const w2 = ensureWorld({ y: 12, hunger: 4, tripToY: 12 });
  await runEnsureFood(w2.deps);
  assert.deepStrictEqual(names(w2), ['loot', 'trip']);
});

test('ensureFood : sous terre avec ≥ 6 points → on NE remonte PAS (la remontée n est que pour qui est à sec)', async () => {
  // 3 chairs = 6 points : de quoi tenir, le filet « manger » suffit. (foodItems > 0 l interdisait déjà ;
  // la consigne le pose aussi en points — les deux garde-fous doivent tenir.)
  const w = ensureWorld({ y: 12, hunger: 4, inv: { rotten_flesh: 3 } });
  await runEnsureFood(w.deps);
  assert.deepStrictEqual(names(w), ['loot'], 'ni remontée ni chasse sous terre');
});

test('ensureFood : la porte « < 6 points » est INDÉPENDANTE du compte d items (deux gardes, toutes deux obligatoires)', async () => {
  // foodItems() dit « rien de comestible » mais le sac vaut 8 points : deux mesures qui se
  // contredisent. La consigne pose la remontée « seulement si foodPoints < 6 » — c est LA qui tranche.
  const w = ensureWorld({ y: 12, hunger: 4, inv: { cooked_beef: 1 } });
  w.deps.foodItems = () => 0;
  await runEnsureFood(w.deps);
  assert.strictEqual(names(w).includes('trip'), false);
  // …et inversement, 5 points (< 6) mais des items en poche : surfaceTripNeeded refuse (le filet « manger » suffit)
  const w2 = ensureWorld({ y: 12, hunger: 4, inv: { beef: 1, mutton: 1 } });
  await runEnsureFood(w2.deps);
  assert.strictEqual(names(w2).includes('trip'), false);
});

test('ensureFood : sous terre mais PAS affamé (faim 15) → pas de remontée', async () => {
  const w = ensureWorld({ y: 12, hunger: 15 });
  await runEnsureFood(w.deps);
  assert.deepStrictEqual(names(w), ['loot']);
});

test('ensureFood : budget épuisé par le butin → ni remontée ni chasse (le total ne dépasse jamais 60 s)', async () => {
  const w = ensureWorld({ y: 70, lootTakes: 61000 });
  await runEnsureFood(w.deps);
  assert.deepStrictEqual(names(w), ['loot']);
});

test('ensureFood : sans-give → jamais de /give, même à court (la chasse reste le SEUL ravitaillement)', async () => {
  const w = ensureWorld({ y: 70 });
  w.deps.canGive = false;
  const r = await runEnsureFood(w.deps);
  assert.strictEqual(names(w).includes('give'), false);
  assert.strictEqual(r.why, 'no_give');
});

test('ensureFood : serveur de test (give permis) et toujours < 20 points → /give en dernier recours', async () => {
  const w = ensureWorld({ y: 70 });
  w.deps.canGive = true;
  const r = await runEnsureFood(w.deps);
  assert.deepStrictEqual(names(w), ['loot', 'hunt', 'give']);
  assert.strictEqual(r.why, 'give');
});

test('ensureFood : la chasse a rempli le sac → pas de /give', async () => {
  const w = ensureWorld({ y: 70, huntGives: { cooked_beef: 4 } });
  w.deps.canGive = true;
  const r = await runEnsureFood(w.deps);
  assert.deepStrictEqual(names(w), ['loot', 'hunt']);
  assert.strictEqual(r.why, 'enough');
});

test('ensureFood : une dépendance qui JETTE n interrompt pas la chaîne (best-effort partout)', async () => {
  const w = ensureWorld({ y: 12, hunger: 4 });
  w.deps.loot = async () => { w.calls.push(['loot']); throw new Error('goto KO'); };
  w.deps.surfaceTrip = async () => { w.calls.push(['trip']); w.y = 70; throw new Error('warp KO'); };
  w.deps.hunt = async () => { w.calls.push(['hunt']); throw new Error('chasse KO'); };
  const r = await runEnsureFood(w.deps);
  assert.deepStrictEqual(names(w), ['loot', 'trip', 'hunt'], 'aucune exception n arrête la suite');
  assert.ok(r && typeof r.points === 'number');
});

test('ensureFood : horloge réelle par défaut, aucune dépendance de temps imposée', async () => {
  const w = ensureWorld({ y: 70 });
  delete w.deps.now;
  const r = await runEnsureFood(w.deps);
  assert.ok(r.points >= 0);
});

// ─── huntCookGoal ───────────────────────────────────────────────────────────────────────────────

function huntWorld(over = {}) {
  const clock = fakeClock();
  const w = {
    clock,
    inv: {},
    parent: { cancelled: false },
    passive: true,
    furnace: false,
    rod: false,
    calls: [],
    events: [],
    huntTakes: 20000,
    huntGives: { beef: 3 },
    huntResult: null,
    cookTakes: 20000,
    fishTakes: 30000,
    fishGives: { cod: 2 },
    fishResult: null,
    ...over,
  };
  const give = (add) => { if (add) for (const k of Object.keys(add)) w.inv[k] = (w.inv[k] || 0) + add[k]; };
  w.deps = {
    now: clock.now,
    token: w.parent,
    inventory: () => w.inv,
    passiveInView: () => w.passive,
    hunt: async (o) => {
      w.calls.push(['hunt', { count: o.count, ms: o.ms, token: o.token, cancel: o.cancel }]);
      clock.advance(Math.min(w.huntTakes, o.ms)); give(w.huntGives);
      return w.huntResult || { ok: true, kills: 2 };
    },
    rawStacks: () => Object.keys(w.inv)
      .filter((k) => ['beef', 'porkchop', 'chicken', 'mutton', 'rabbit', 'cod', 'salmon'].includes(k) && w.inv[k] > 0)
      .map((k) => ({ name: k, out: 'cooked_' + k, count: w.inv[k] }))
      .sort((a, b) => b.count - a.count),
    hasFurnace: () => w.furnace,
    cook: async (o) => {
      w.calls.push(['cook', o]);
      clock.advance(Math.min(w.cookTakes, o.maxMs));
      w.inv[o.name] -= o.count; w.inv[o.out] = (w.inv[o.out] || 0) + o.count;
      return o.count;
    },
    hasRod: () => w.rod,
    fish: async (o) => {
      w.calls.push(['fish', { ms: o.ms, token: o.token }]);
      clock.advance(Math.min(w.fishTakes, o.ms)); give(w.fishGives);
      return w.fishResult || { ok: true, caught: 2, reason: 'timeout' };
    },
    emit: (e) => { w.events.push(e); },
  };
  return w;
}

test('huntCook : déjà assez de points → rien ne tourne', async () => {
  const w = huntWorld({ inv: { cooked_beef: 2 } });            // 16 ≥ 4×3 = 12
  const r = await runHuntCook(w.deps, 4);
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(names(w), []);
});

test('huntCook : le but en points = target × 3 (4 pièces → 12, 6 → 18 : les seuils du kit et d ensureFood)', async () => {
  const w = huntWorld({ inv: { beef: 3 } });                   // 9 points : < 12 → on chasse
  await runHuntCook(w.deps, 4);
  assert.deepStrictEqual(names(w).slice(0, 1), ['hunt']);
  const w2 = huntWorld({ inv: { beef: 4 } });                  // 12 : atteint
  await runHuntCook(w2.deps, 4);
  assert.deepStrictEqual(names(w2), []);
  const w3 = huntWorld({ inv: { beef: 5 } });                  // 15 < 18 : target 6 → on chasse
  await runHuntCook(w3.deps, 6);
  assert.deepStrictEqual(names(w3).slice(0, 1), ['hunt']);
});

test('huntCook : UNE seule vague par défaut, ≤ 45 s', async () => {
  const w = huntWorld({ huntGives: { beef: 1 } });             // un gain trop maigre : on ne rechasse pas
  await runHuntCook(w.deps, 6);
  const hunts = w.calls.filter((c) => c[0] === 'hunt');
  assert.strictEqual(hunts.length, 1, 'plus de 3 vagues de 120 s');
  assert.ok(hunts[0][1].ms <= 45000, `ms=${hunts[0][1].ms}`);
  assert.strictEqual(hunts[0][1].count, 4, 'au plus 4 proies par vague');
});

test('huntCook : waves explicite → on peut en demander plusieurs (le paramètre existe), le budget reste commun', async () => {
  const w = huntWorld({ huntGives: { beef: 1 }, huntTakes: 15000 });
  await runHuntCook(w.deps, 6, { waves: 3 });
  assert.strictEqual(w.calls.filter((c) => c[0] === 'hunt').length, 3);
  // …mais pas au-delà du budget total (60 s) : 3 × 15 s = 45 s tient, une 4e n existe pas de toute façon
  const w2 = huntWorld({ huntGives: { beef: 1 }, huntTakes: 40000 });
  await runHuntCook(w2.deps, 6, { waves: 3 });
  const hunts = w2.calls.filter((c) => c[0] === 'hunt');
  assert.ok(hunts.length <= 2, `budget épuisé après ${hunts.length} vagues`);
  assert.ok(hunts[hunts.length - 1][1].ms <= 20000, 'la dernière vague est rognée par ce qui reste du budget');
});

test('huntCook : AUCUNE proie en vue → pas de chasse du tout (la chasse n est lancée que si on voit du gibier)', async () => {
  const w = huntWorld({ passive: false });
  const r = await runHuntCook(w.deps, 4);
  assert.deepStrictEqual(names(w), []);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'no_prey:no_passive');
});

test('huntCook : le jeton de la chasse s arrête TOUT SEUL dès que le but est atteint', async () => {
  const w = huntWorld({ huntGives: { beef: 4 } });             // 12 points d un coup
  let tokenAvantGain = null;
  const hunt = w.deps.hunt;
  w.deps.hunt = async (o) => {
    tokenAvantGain = o.token.cancelled;                        // avant que le gibier ne tombe
    const r = await hunt(o);
    w.tokenApresGain = o.token.cancelled;                      // après : objectif atteint
    return r;
  };
  await runHuntCook(w.deps, 4);
  assert.strictEqual(tokenAvantGain, false);
  assert.strictEqual(w.tokenApresGain, true, 'huntPassive s arrête à la proie suivante, pas au bout de ses 4');
});

test('huntCook : le jeton de la chasse suit le jeton de la tâche (annulation = arrêt immédiat)', async () => {
  const w = huntWorld();
  let tok = null;
  const hunt = w.deps.hunt;
  w.deps.hunt = async (o) => { tok = o.token; return hunt(o); };
  await runHuntCook(w.deps, 4);
  w.parent.cancelled = true;
  assert.strictEqual(tok.cancelled, true);
});

test('huntCook : le jeton de chasse est COUPÉ une fois la vague finie (rien ne court en fond après nous)', async () => {
  const w = huntWorld({ huntGives: { beef: 1 } });
  let tok = null;
  const hunt = w.deps.hunt;
  w.deps.hunt = async (o) => { tok = o.token; return hunt(o); };
  await runHuntCook(w.deps, 6);
  assert.strictEqual(tok.cancelled, true);
});

test('huntCook : cuisson SEULEMENT avec un four en poche, ≥ 2 crus et du temps', async () => {
  // four + 3 bœufs crus, 20 s de chasse → il reste 40 s : (40 − 8) / 10 = 3 pièces
  const w = huntWorld({ furnace: true, huntGives: { beef: 3 } });
  await runHuntCook(w.deps, 6);                                 // 9 points < 18 → on continue la chaîne
  const cook = w.calls.find((c) => c[0] === 'cook');
  assert.ok(cook, 'cuisson attendue');
  assert.strictEqual(cook[1].name, 'beef');
  assert.strictEqual(cook[1].out, 'cooked_beef');
  assert.strictEqual(cook[1].count, 3);
  assert.ok(cook[1].maxMs <= 3 * 10000 + 5000);

  const sans = huntWorld({ furnace: false, huntGives: { beef: 3 } });
  await runHuntCook(sans.deps, 6);
  assert.strictEqual(names(sans).includes('cook'), false, 'sans four en poche : on garde le cru, il se mange');

  const un = huntWorld({ furnace: true, huntGives: { beef: 1 } });
  await runHuntCook(un.deps, 6);
  assert.strictEqual(names(un).includes('cook'), false, 'un seul cru : pas de four pour ça');
});

test('huntCook : le cru qui ATTEINT déjà le but ne se cuit pas (cuire est un moyen, pas un rituel)', async () => {
  // 4 bœufs crus = 12 points = le but du kit (4 pièces × 3) : un four en poche et 10 s de cuisson
  // par pièce ne rapporteraient que du confort. Vitesse d abord.
  const w = huntWorld({ furnace: true, huntGives: { beef: 4 } });
  const r = await runHuntCook(w.deps, 4);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(names(w).includes('cook'), false);
  // le même sac, mais pour un but plus haut (ensureFood vise 20) : là, cuire sert à y arriver
  const w2 = huntWorld({ furnace: true, huntGives: { beef: 4 } });
  await runHuntCook(w2.deps, 4, { goalPoints: 20 });
  assert.strictEqual(names(w2).includes('cook'), true);
});

test('huntCook : pas assez de temps pour cuire → on garde le cru (et le résultat reste un succès)', async () => {
  const w = huntWorld({ furnace: true, huntGives: { beef: 4 }, huntTakes: 45000 });   // 15 s restantes
  const r = await runHuntCook(w.deps, 6);
  assert.strictEqual(names(w).includes('cook'), false);
  assert.strictEqual(r.ok, true, '12 points de viande crue = un gain réel');
});

test('huntCook : la cuisson distribue les types, le plus abondant d abord, dans la limite du temps', async () => {
  const w = huntWorld({ furnace: true, huntGives: { beef: 3, porkchop: 2 }, huntTakes: 5000, cookTakes: 10000 });
  await runHuntCook(w.deps, 8);                                // but 24 points : on cuit tant que ça tient
  const cooks = w.calls.filter((c) => c[0] === 'cook').map((c) => c[1]);
  assert.ok(cooks.length >= 1);
  assert.strictEqual(cooks[0].name, 'beef', 'le plus abondant d abord');
});

test('huntCook : pêche SEULEMENT avec une canne en poche, et si le but n est pas déjà atteint', async () => {
  const w = huntWorld({ rod: true, passive: false });
  await runHuntCook(w.deps, 4);
  const f = w.calls.find((c) => c[0] === 'fish');
  assert.ok(f, 'canne + rien chassé → on pêche');
  assert.ok(f[1].ms <= 40000, `ms=${f[1].ms}`);

  const sans = huntWorld({ rod: false, passive: false });
  const r = await runHuntCook(sans.deps, 4);
  assert.strictEqual(names(sans).includes('fish'), false, 'pas de canne : pas de pêche (ni fabrication, ni chasse à la ficelle)');
  assert.strictEqual(r.reason, 'no_prey:no_passive');

  const rempli = huntWorld({ rod: true, huntGives: { beef: 4 } });   // la chasse a suffi
  await runHuntCook(rempli.deps, 4);
  assert.strictEqual(names(rempli).includes('fish'), false);
});

test('huntCook : la pêche est rognée par le budget restant, et coupée si trop peu (< 12 s)', async () => {
  const w = huntWorld({ rod: true, huntGives: { beef: 1 }, huntTakes: 45000 });     // reste 15 s
  await runHuntCook(w.deps, 6);
  const f = w.calls.find((c) => c[0] === 'fish');
  assert.ok(f && f[1].ms <= 15000, `pêche rognée à ${f && f[1].ms}`);

  const juste = huntWorld({ rod: true, huntGives: { beef: 1 }, huntTakes: 45000 });
  await runHuntCook(juste.deps, 6, { budget: F.createBudget(55000, juste.clock.now) });   // reste 10 s
  assert.strictEqual(names(juste).includes('fish'), false, 'moins de 12 s : une ligne n a même pas le temps de mordre');
});

test('huntCook : le jeton de la pêche suit le même contrat que celui de la chasse', async () => {
  const w = huntWorld({ rod: true, passive: false });
  let tok = null;
  const fish = w.deps.fish;
  w.deps.fish = async (o) => { tok = o.token; return fish(o); };
  await runHuntCook(w.deps, 4);
  assert.strictEqual(tok.cancelled, true, 'coupé une fois la pêche finie');
});

test('huntCook : la chaîne entière ne dépasse JAMAIS le budget de 60 s (chasse + cuisson + pêche)', async () => {
  // Pire cas : chaque phase voudrait bien plus que ce qu on lui accorde (les fausses dépendances,
  // comme withTimeout, s arrêtent à leur plafond). Le total est rogné, pas additionné.
  const w = huntWorld({
    furnace: true, rod: true, huntGives: { beef: 3 }, fishGives: {},
    huntTakes: 999999, cookTakes: 999999, fishTakes: 999999,
  });
  const t0 = w.clock.now();
  await runHuntCook(w.deps, 8);
  const elapsed = w.clock.now() - t0;
  assert.ok(elapsed <= 60000, `la chaîne a consommé ${elapsed} ms`);
  const hunts = w.calls.filter((c) => c[0] === 'hunt');
  assert.ok(hunts[0][1].ms <= 45000);
  for (const c of w.calls) if (c[0] === 'fish') assert.ok(c[1].ms <= 40000);
});

test('huntCook : même pire cas avec de quoi tout cuire — toujours ≤ 60 s', async () => {
  const w = huntWorld({
    furnace: true, rod: true, huntGives: { beef: 3, porkchop: 3 }, fishGives: {},
    huntTakes: 5000, cookTakes: 999999, fishTakes: 999999,
  });
  const t0 = w.clock.now();
  await runHuntCook(w.deps, 12);                                // but 36 points : jamais atteint, tout est tenté
  assert.ok(w.clock.now() - t0 <= 60000, `consommé : ${w.clock.now() - t0} ms`);
});

test('huntCook : un budget fourni par l appelant est PARTAGÉ (ensureFood passe son reste)', async () => {
  const w = huntWorld();
  const budget = F.createBudget(20000, w.clock.now);
  await runHuntCook(w.deps, 4, { budget });
  const hunt = w.calls.find((c) => c[0] === 'hunt');
  assert.ok(hunt[1].ms <= 20000, `la chasse ne peut pas dépasser le reste du budget de l appelant (${hunt[1].ms})`);
});

test('huntCook : budget épuisé → aucune phase ne démarre', async () => {
  const w = huntWorld();
  const budget = F.createBudget(1000, w.clock.now);             // < 3 s : plus rien ne vaut le coup
  const r = await runHuntCook(w.deps, 4, { budget });
  assert.deepStrictEqual(names(w), []);
  assert.strictEqual(r.ok, false);
});

test('huntCook : tâche annulée pendant la chasse → on s arrête là (ni cuisson ni pêche)', async () => {
  const w = huntWorld({ furnace: true, rod: true, huntGives: { beef: 3 } });
  const hunt = w.deps.hunt;
  w.deps.hunt = async (o) => { const r = await hunt(o); w.parent.cancelled = true; return r; };
  const r = await runHuntCook(w.deps, 8);
  assert.deepStrictEqual(names(w), ['hunt']);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'cancelled');
});

test('huntCook : tâche déjà annulée au départ → rien', async () => {
  const w = huntWorld();
  w.parent.cancelled = true;
  const r = await runHuntCook(w.deps, 4);
  assert.deepStrictEqual(names(w), []);
  assert.strictEqual(r.reason, 'cancelled');
});

test('huntCook : verdict — un GAIN de points est un succès, même sous le but', async () => {
  const w = huntWorld({ huntGives: { beef: 1 } });               // 3 points sur 18 visés
  const r = await runHuntCook(w.deps, 6);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.got, 3);
});

test('huntCook : verdict — aucun gain → échec, raison préfixée no_prey (lue par les télémétries existantes)', async () => {
  const w = huntWorld({ huntGives: null, huntResult: { ok: false, kills: 0 } });
  const r = await runHuntCook(w.deps, 4);
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /^no_prey:/);
  assert.strictEqual(r.reason, 'no_prey:hunt_failed');
});

test('huntCook : verdict — la pêche ratée donne SA raison (no_bite, rod_lost…)', async () => {
  const w = huntWorld({ rod: true, passive: false, fishGives: null, fishResult: { ok: false, caught: 0, reason: 'no_bite' } });
  const r = await runHuntCook(w.deps, 4);
  assert.strictEqual(r.reason, 'no_prey:no_bite');
});

test('huntCook : « no_water » est RENOMMÉ — le verdict de zone lit /water/ comme une zone INONDÉE', async () => {
  // noteZoneFailure(goal, reason) → zoneFailureKind : tout ce qui contient « water » compte comme un
  // échec d eau de la ZONE et pousse vers une migration. Pour la pêche `no_water` dit l inverse (pas
  // d eau où pêcher) : le laisser passer ferait migrer le bot pour une zone « trop humide » qui ne l est pas.
  const w = huntWorld({ rod: true, passive: false, fishGives: null, fishResult: { ok: false, caught: 0, reason: 'no_water' } });
  const r = await runHuntCook(w.deps, 4);
  assert.strictEqual(r.reason, 'no_prey:no_pond');
});

test('huntCook : AUCUNE raison d échec ne peut accuser la zone (zoneFailureKind → null pour tout le catalogue)', async () => {
  const { zoneFailureKind } = require('./zone');
  const fishReasons = ['target', 'timeout', 'cancelled', 'no_bite', 'rod_lost', 'no_rod', 'no_water', 'no_spot',
    'unreachable', 'no_fish_api', 'error', 'flooded', 'drowned'];
  const seen = new Set();
  for (const fr of fishReasons) {
    const w = huntWorld({ rod: true, passive: false, fishGives: null, fishResult: { ok: false, caught: 0, reason: fr } });
    const r = await runHuntCook(w.deps, 4);
    if (r.reason !== 'cancelled') seen.add(r.reason);
  }
  const w2 = huntWorld({ passive: false });
  seen.add((await runHuntCook(w2.deps, 4)).reason);                                    // no_passive
  const w3 = huntWorld({ huntGives: null, huntResult: { ok: false, kills: 0 } });
  seen.add((await runHuntCook(w3.deps, 4)).reason);                                    // hunt_failed
  const w4 = huntWorld({ huntGives: null });
  seen.add((await runHuntCook(w4.deps, 4)).reason);                                    // no_gain
  const w5 = huntWorld();
  seen.add((await runHuntCook(w5.deps, 4, { budget: F.createBudget(1000, w5.clock.now) })).reason);   // no_time
  assert.ok(seen.size >= 6, `catalogue trop petit : ${[...seen]}`);
  for (const reason of seen) {
    assert.strictEqual(zoneFailureKind('food_stock', reason), null, `« ${reason} » accuserait la zone`);
    assert.strictEqual(zoneFailureKind('huntCook', reason), null, `« ${reason} » accuserait la zone`);
  }
});

test('huntCook : event de synthèse hunt_cook_done — avant/après/durée, pour MESURER la vitesse en live', async () => {
  const w = huntWorld({ furnace: true, huntGives: { beef: 3 } });
  await runHuntCook(w.deps, 6);
  const ev = w.events.find((e) => e.type === 'hunt_cook_done');
  assert.ok(ev, 'le silence est un bug');
  assert.strictEqual(ev.before, 0);
  assert.ok(ev.after > 0);
  assert.ok(ev.took_ms >= 20000);
  assert.strictEqual(ev.goal, 18);
  assert.strictEqual(ev.kills, 2);
  assert.ok(typeof ev.cooked === 'number' && typeof ev.fished === 'number');
});

test('huntCook : rien tenté (déjà au but) → pas d event (pas de bruit dans les logs)', async () => {
  const w = huntWorld({ inv: { cooked_beef: 3 } });
  await runHuntCook(w.deps, 4);
  assert.strictEqual(w.events.length, 0);
});

test('huntCook : lecture « proie en vue » impossible → on ne part pas chasser à l aveugle', async () => {
  const w = huntWorld();
  w.deps.passiveInView = () => { throw new Error('monde illisible'); };
  const r = await runHuntCook(w.deps, 4);
  assert.strictEqual(names(w).includes('hunt'), false);
  assert.strictEqual(r.ok, false);
  const w2 = huntWorld();
  delete w2.deps.passiveInView;                                  // dépendance absente : même verdict, sans exception
  assert.strictEqual((await runHuntCook(w2.deps, 4)).ok, false);
});

test('huntCook : dépendances qui jettent → pas d exception, verdict d échec propre', async () => {
  const w = huntWorld({ furnace: true, rod: true });
  w.deps.hunt = async () => { throw new Error('pvp KO'); };
  w.deps.fish = async () => { throw new Error('canne KO'); };
  w.deps.cook = async () => { throw new Error('four KO'); };
  const r = await runHuntCook(w.deps, 4);
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /^no_prey:/);
});

// ─── Câblage dans index.js ──────────────────────────────────────────────────────────────────────
const SRC = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');
const slice = (from, to) => {
  const a = SRC.indexOf(from);
  assert.ok(a >= 0, `repère introuvable : ${from}`);
  const b = SRC.indexOf(to, a + from.length);
  assert.ok(b > a, `fin introuvable : ${to}`);
  return SRC.slice(a, b);
};

test('index.js : les deux orchestrateurs et le module de points sont requis', () => {
  assert.match(SRC, /require\('\.\/food'\)/);
  assert.match(SRC, /require\('\.\/foodRun'\)/);
});

test('index.js : plus aucune lecture de l ancienne mesure « cuit seulement » (cookedCount)', () => {
  assert.strictEqual(/cookedCount/.test(SRC), false);
});

test('index.js : ensureFood délègue à runEnsureFood, avec les durées de la consigne', () => {
  const body = slice('async function ensureFood() {', '\n// Kit de départ DÉTERMINISTE');
  assert.match(body, /runEnsureFood\(/);
  assert.match(body, /loot: \(o\) => lootNearby\(o\)/);
  assert.match(body, /canGive: !NO_GIVE/);
  assert.match(body, /_surfaceTripBusy/, 'une seule remontée à la fois');
  assert.match(body, /safeWarpHome\(HOME_SAFE\)/);
  assert.match(body, /huntCookGoal\(6,/, 'la chasse reçoit le budget restant');
});

test('index.js : le timer « food run » est borné à 70 s (et non plus 240 s) et rend points + took_ms', () => {
  const body = slice('let _foodRunBusy = false;', '// ── PLUS DE PIOCHE');
  assert.match(body, /withTimeout\(ensureFood\(\), FOOD_RUN_TIMEOUT_MS/);
  assert.strictEqual(/240000/.test(body), false, 'plus de garde-fou de 4 minutes');
  const done = body.slice(body.indexOf("type: 'food_run_done'"));
  assert.match(done, /points: foodPoints\(buildCtxInv\(bot\)\)/);
  assert.match(done, /took_ms: Date\.now\(\) - /);
  assert.match(done, /gained: after - stock/, 'les champs existants sont conservés');
});

test('index.js : huntCookGoal — une vague, borné, jeton CAPTURÉ, plus de ficelle ni de trajet vers l eau', () => {
  const body = slice('async function huntCookGoal(target', '// PÊCHE — plan B nourriture');
  assert.match(body, /runHuntCook\(/);
  assert.match(body, /const tok = taskToken;/, 'jeton capturé à l entrée (fix 18/08 : taskToken est un global relu tard)');
  assert.strictEqual(/fishAtKnownWater|fishTry|huntSpidersGoal/.test(body), false,
    'ni trajet vers l eau (jusqu à 300 s) ni chasse à la ficelle (90 s) dans la sortie nourriture');
  assert.match(body, /maxDistance: FISH_RADIUS|FISH_RADIUS/);
  assert.match(body, /nearestPassive\(bot, HUNT_SIGHT_RADIUS\)/);
});

test('index.js : fishGoal accepte des options (rayon, durée) sans changer le skill « fish »', () => {
  const body = slice('async function fishGoal(', '// ── PLAN B-bis');
  assert.match(body, /fishGoal\(target = 4, o = \{\}\)/);
  assert.match(body, /Object\.assign\(\{ target, token: taskToken \}, o\)/);
});

test('index.js : le kit — pré-descente et démarrage mappeur — comptent en points, avec garde-fou dur', () => {
  assert.match(SRC, /foodPoints\(buildCtxInv\(bot\)\) < STOCK_POINTS/);
  assert.match(SRC, /withTimeout\(huntCookGoal\(4\), HUNT_COOK_TIMEOUT_MS/);
  assert.match(SRC, /withTimeout\(huntCookGoal\(6\), HUNT_COOK_TIMEOUT_MS/);
  assert.strictEqual(/await huntCookGoal\(6\);/.test(SRC), false, 'le démarrage mappeur n a plus de chasse non bornée');
});

test('index.js : ctxExtra publie passiveNear (try/catch → false), lu par food_stock', () => {
  const body = slice('function ctxExtra() {', '// ── ARMURE DES CARTOGRAPHES');
  assert.match(body, /passiveNear/);
  assert.match(body, /nearestPassive\(bot, HUNT_SIGHT_RADIUS\)/);
  assert.match(body, /catch \(e\)[^]*passiveNear = false/, 'lecture du monde impossible → false (le kit avance), jamais bloquant');
  assert.match(body, /return \{[^}]*passiveNear/, 'dans l objet retourné');
});

test('index.js : opportunistic_hunt du mappeur compte en points, borné à 45 s, jeton arrêté dès le but', () => {
  const body = slice('onArrive: async () => {', '// chaque jambe bornée');
  assert.match(body, /foodPoints\(/);
  assert.match(body, /boundedToken\(/);
  assert.strictEqual(/missing/.test(body), false, 'plus de décompte de pièces cuites');
  assert.match(body, /HUNT_WAVE_MS/);
});

test('index.js : la compétence huntCook n a plus 8 minutes (SKILL_TIMEOUTS)', () => {
  assert.strictEqual(/huntCook: 480000/.test(SRC), false);
  assert.match(SRC, /huntCook: 90000/);
});
