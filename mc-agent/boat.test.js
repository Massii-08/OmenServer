'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { outwardHeading, landAhead, boatStuck, ensureBoat, sailToLand, waterEdgeAlong } = require('./boat');

test('outwardHeading : pointe à l’opposé du centroïde mappé', () => {
  const h = outwardHeading({ x: 100, z: 100 }, { x: 0, z: 0 }, null, () => 0.5);
  assert.ok(Math.abs(h - Math.atan2(100, 100)) < 1e-6);   // ~π/4 (NE)
});

test('outwardHeading : au centre exact → cap tiré (pas de NaN)', () => {
  const h = outwardHeading({ x: 0, z: 0 }, { x: 0, z: 0 }, null, () => 0.25);
  assert.ok(Number.isFinite(h) && h >= 0 && h < Math.PI * 2);
});

test('landAhead : détecte la côte (eau puis sol solide au cap +x)', () => {
  const sampler = (x, y, z) => {
    if (y > 64) return { name: 'air', boundingBox: 'empty' };
    if (x < 20) return { name: 'water', boundingBox: 'empty' };
    return { name: 'stone', boundingBox: 'block' };
  };
  const r = landAhead(sampler, { x: 0, y: 64, z: 0 }, 0, { reach: 40, step: 4 });
  assert.strictEqual(r.found, true);
  assert.ok(r.pos.x >= 20 && r.pos.x <= 24);
});

test('landAhead : océan à perte de vue → found:false', () => {
  const sampler = (x, y, z) => (y > 64 ? { name: 'air', boundingBox: 'empty' } : { name: 'water', boundingBox: 'empty' });
  assert.strictEqual(landAhead(sampler, { x: 0, y: 64, z: 0 }, 0, { reach: 40, step: 4 }).found, false);
});

test('boatStuck : immobile assez longtemps → true ; bouge ou trop tôt → false', () => {
  assert.strictEqual(boatStuck({ x: 0, z: 0 }, { x: 0, z: 0 }, 12000), true);
  assert.strictEqual(boatStuck({ x: 0, z: 0 }, { x: 10, z: 0 }, 12000), false);
  assert.strictEqual(boatStuck({ x: 0, z: 0 }, { x: 0, z: 0 }, 5000), false);
});

test('ensureBoat : bateau déjà en poche → ok sans craft', async () => {
  const bot = { inventory: { items: () => [{ name: 'oak_boat', count: 1 }] } };
  let crafted = false;
  const r = await ensureBoat(bot, { craft: async () => { crafted = true; return { ok: true }; } });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(crafted, false);
});

test('ensureBoat : pas de bateau, bois dispo → crafte le bateau de l’essence', async () => {
  const bot = { inventory: { items: () => [{ name: 'birch_planks', count: 8 }] } };
  const calls = [];
  const r = await ensureBoat(bot, { craft: async (a) => { calls.push(a); return { ok: true }; } });
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(calls[0], { name: 'birch_boat', count: 1 });
});

test('sailToLand : s’arrête et débarque dès que la terre est détectée devant', async () => {
  let ticks = 0;
  const ctl = {};
  const bot = {
    entity: { position: { x: 0, y: 64, z: 0 } },
    vehicle: {},   // embarqué (sailToLand est appelé après avoir mis le bot dans un bateau)
    look: async () => {},
    setControlState: (k, v) => { ctl[k] = v; },
    clearControlStates: () => { ctl.cleared = true; },
    dismount: async () => { ctl.dismounted = true; },
    blockAt: () => null,
  };
  const sampleBlock = () => (++ticks >= 3 ? { name: 'stone', boundingBox: 'block' } : { name: 'water', boundingBox: 'empty' });
  const r = await sailToLand(bot, 0, {
    sampleBlock, reach: 8, step: 8, tickMs: 0, timeoutMs: 5000,
    now: (() => { let t = 0; return () => (t += 100); })(), sleep: async () => {},
  });
  assert.strictEqual(r.landed, true);
  assert.strictEqual(ctl.cleared, true);
  assert.strictEqual(ctl.dismounted, true);
});

test('sailToLand : jamais de terre + timeout → landed:false, contrôles relâchés', async () => {
  const ctl = {};
  const bot = {
    entity: { position: { x: 0, y: 64, z: 0 } },
    look: async () => {}, setControlState: () => {},
    clearControlStates: () => { ctl.cleared = true; }, dismount: async () => {}, blockAt: () => null,
  };
  const r = await sailToLand(bot, 0, {
    sampleBlock: () => ({ name: 'water', boundingBox: 'empty' }),
    reach: 8, step: 8, tickMs: 0, timeoutMs: 300,
    now: (() => { let t = 0; return () => (t += 200); })(), sleep: async () => {},
  });
  assert.strictEqual(r.landed, false);
  assert.strictEqual(ctl.cleared, true);
});

test('waterEdgeAlong : trouve la première eau de surface au cap', () => {
  const sampler = (x, y, z) => {
    if (y > 64) return { name: 'air', boundingBox: 'empty' };
    return x >= 20 ? { name: 'water', boundingBox: 'empty' } : { name: 'grass_block', boundingBox: 'block' };
  };
  const r = waterEdgeAlong(sampler, { x: 0, y: 64, z: 0 }, 0, { reach: 48, step: 2 });
  assert.strictEqual(r.found, true);
  assert.ok(r.pos.x >= 20 && r.pos.x <= 22);
});

test('waterEdgeAlong : pas d\'eau au cap → found:false', () => {
  const sampler = (x, y, z) => (y > 64 ? { name: 'air', boundingBox: 'empty' } : { name: 'stone', boundingBox: 'block' });
  assert.strictEqual(waterEdgeAlong(sampler, { x: 0, y: 64, z: 0 }, 0, { reach: 48 }).found, false);
});

test('sailToLand : ne débarque JAMAIS sans être passé au-dessus de l\'eau (anti « atterrissage sur sa propre côte »)', async () => {
  const ctl = {};
  const bot = {
    entity: { position: { x: 0, y: 64, z: 0 } },
    look: async () => {}, setControlState: () => {},
    clearControlStates: () => { ctl.cleared = true; }, dismount: async () => {}, blockAt: () => null,
  };
  // terre partout (le bot est SUR son continent) → sans passage au-dessus de l'eau, pas de « landed »
  const r = await sailToLand(bot, 0, {
    sampleBlock: () => ({ name: 'stone', boundingBox: 'block' }),
    reach: 8, step: 8, tickMs: 0, timeoutMs: 400,
    now: (() => { let t = 0; return () => (t += 100); })(), sleep: async () => {},
  });
  assert.strictEqual(r.landed, false);
  assert.strictEqual(ctl.cleared, true);
});

test('waterCrossMode : océan → bateau, rivière → nage, autre eau (flaque/caverne/lac) → null', () => {
  const { waterCrossMode } = require('./boat');
  assert.strictEqual(waterCrossMode('deep_ocean'), 'boat');
  assert.strictEqual(waterCrossMode('river'), 'swim');
  assert.strictEqual(waterCrossMode('frozen_river'), 'swim');
  assert.strictEqual(waterCrossMode('dripstone_caves'), null);
  assert.strictEqual(waterCrossMode('plains'), null);
  assert.strictEqual(waterCrossMode(null), null);
});

// ─── ANTI-BOUCLE DE TRAVERSÉE (analyse run world_ax4, 26/07) ──────────────────
// 115 384 tentatives / 115 342 échecs (87 % de TOUS les events du run), dont 115 138
// `no_crossable_water`, jusqu'à 40 490 dans une seule session. Chaque échec relançait la même
// décision au même endroit. « Pas d'eau traversable ICI » ne change pas tant qu'on n'a pas bougé.
const { shouldRetryBoat, BOAT_RETRY_MIN_MOVE, BOAT_RETRY_COOLDOWN_MS } = require('./boat');

test('1re tentative : toujours autorisée', () => {
  assert.equal(shouldRetryBoat(null, { x: 0, z: 0 }, 1000), true);
});

test('juste après un échec, sans avoir bougé → REFUSÉ (c\'était la boucle)', () => {
  const fail = { at: { x: 0, z: 0 }, t: 1000 };
  assert.equal(shouldRetryBoat(fail, { x: 0, z: 0 }, 1100), false);
  assert.equal(shouldRetryBoat(fail, { x: 5, z: 5 }, 1100), false, 'quelques pas ne suffisent pas');
});

test('après un vrai déplacement → autorisé (la réponse peut changer)', () => {
  const fail = { at: { x: 0, z: 0 }, t: 1000 };
  assert.equal(shouldRetryBoat(fail, { x: BOAT_RETRY_MIN_MOVE, z: 0 }, 1100), true);
});

test('après le temps d\'attente → autorisé même sur place', () => {
  const fail = { at: { x: 0, z: 0 }, t: 1000 };
  assert.equal(shouldRetryBoat(fail, { x: 0, z: 0 }, 1000 + BOAT_RETRY_COOLDOWN_MS), true);
});

test('seuils surchargeables + entrées bancales → jamais de crash', () => {
  const fail = { at: { x: 0, z: 0 }, t: 1000 };
  assert.equal(shouldRetryBoat(fail, { x: 10, z: 0 }, 1100, { minMove: 5 }), true);
  assert.equal(shouldRetryBoat({}, { x: 0, z: 0 }, 1100), true);
  assert.equal(shouldRetryBoat(fail, null, 1100), true);
});

// ─── sailToLand : la détection d'immobilité doit POUVOIR se déclencher ──────────────────────────
// Bug live 26/07 (Massii : « map 2 est bloqué depuis longtemps sur un bateau au milieu de l'eau,
// il bouge pas ») : la boucle remettait `prev`/`prevT` à jour toutes les `sampleEvery` (3 s) alors
// que `boatStuck` exige `dtMs >= stuckMs` (12 s) → l'écart de temps ne dépassait jamais 3 s et la
// détection retournait TOUJOURS false. On ne rafraîchit désormais la référence que si le bot a
// vraiment parcouru `minMove`.
test('sailToLand : bot immobile sur l\'eau → sort en reason:stuck (et ne tourne pas jusqu\'au timeout)', async () => {
  let t = 0;
  const bot = {
    entity: { position: { x: 0, y: 62, z: 0 } },
    vehicle: {},                                    // embarqué
    look: async () => {}, dismount: async () => {},
    setControlState() {}, clearControlStates() {},
  };
  const res = await sailToLand(bot, 0, {
    now: () => t,
    sleep: async () => { t += 500; },               // le temps avance, le bot NE BOUGE PAS
    sampleBlock: () => ({ name: 'water' }),         // partout de l'eau : aucune terre en vue
    timeoutMs: 90000,
  });
  assert.strictEqual(res.reason, 'stuck');
  assert.ok(t < 30000, `doit sortir bien avant le timeout (sorti à ${t} ms)`);
});

// ─── GATE DE TRAVERSÉE : ÉTAT PARTAGÉ + ESCALADE (run world_mn14, 17/08) ────────────────────────
// `shouldRetryBoat` ci-dessus est un PRÉDICAT SANS MÉMOIRE : chaque boucle `runMapper` gardait son
// `lastBoatFail` dans SA closure. Deux trous mesurés sur les logs de session :
//  (a) un même PROCESS ouvre jusqu'à 23 boucles `runMapper` (`mapper_started` = 23 / 15 / 9 sur les
//      3 mappeurs — une par respawn, onSpawn → startAutonomous → startMapper) : chaque instance
//      NEUVE repart avec le gate GRAND OUVERT, donc le débit agrégé monte avec le nb d'instances ;
//  (b) le seuil « bougé ≥ 32 b » est OFFERT par les échappements du mappeur lui-même
//      (`mapper_crossing` / `mapper_relocate` = bonds de 100-160 b) : échec → bond → « j'ai bougé »
//      → re-tentative, indéfiniment sur la même côte (séquence relevée en clair dans les logs :
//      cross, failed, blocked×3, crossing, blocked×3, crossing, cross, failed, …).
// D'où : un état PARTAGÉ (porté par le bot, pas par la boucle) + une ESCALADE qui bannit la zone.
const { createCrossGate, CROSS_ESCALATE_AFTER, CROSS_ZONE_RADIUS, CROSS_BAN_MS } = require('./boat');

test('createCrossGate : 1re tentative autorisée, puis refusée sur place (le throttle historique)', () => {
  let t = 1000;
  const g = createCrossGate({ now: () => t });
  assert.strictEqual(g.allow({ x: 0, z: 0 }).ok, true);
  g.noteFailure({ x: 0, z: 0 }, 'no_crossable_water');
  t += 1000;
  const r = g.allow({ x: 0, z: 0 });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'cooldown');
});

test('createCrossGate : déplacement franc ou attente → ré-autorisé (on ne bride pas ce qui peut changer)', () => {
  let t = 1000;
  const g = createCrossGate({ now: () => t });
  g.noteFailure({ x: 0, z: 0 }, 'no_crossable_water');
  assert.strictEqual(g.allow({ x: 40, z: 0 }).ok, true, 'après un vrai déplacement');
  const g2 = createCrossGate({ now: () => t });
  g2.noteFailure({ x: 0, z: 0 }, 'no_crossable_water');
  t += CROSS_BAN_MS;   // largement au-delà du cooldown
  assert.strictEqual(g2.allow({ x: 0, z: 0 }).ok, true, 'après l’attente');
});

test('createCrossGate : ÉTAT PARTAGÉ — un 2e consommateur (autre boucle runMapper) hérite du throttle', () => {
  let t = 1000;
  const g = createCrossGate({ now: () => t });
  g.noteFailure({ x: 0, z: 0 }, 'no_crossable_water');   // boucle A échoue
  t += 500;
  assert.strictEqual(g.allow({ x: 0, z: 0 }).ok, false,
    'la boucle B ne doit PAS repartir gate ouvert (c’est ça qui multipliait les tentatives)');
});

test('createCrossGate : N échecs consécutifs → ZONE BANNIE, et le bond de 150 b ne rouvre plus rien', () => {
  let t = 1000;
  const g = createCrossGate({ now: () => t });
  let last = null;
  // le bot bouge de 40 b entre chaque échec (ses propres échappements) : le seuil minMove est
  // satisfait à CHAQUE fois — c'est exactement le trou du garde-fou d'origine.
  for (let i = 0; i < CROSS_ESCALATE_AFTER; i++) {
    const pos = { x: i * 40, z: 0 };
    assert.strictEqual(g.allow(pos).ok, true, `tentative ${i + 1} doit être autorisée (le bot a bougé)`);
    last = g.noteFailure(pos, 'no_crossable_water');
    t += 1000;
  }
  assert.strictEqual(last.banned, true, `escalade attendue au bout de ${CROSS_ESCALATE_AFTER} échecs`);
  assert.strictEqual(last.streak, CROSS_ESCALATE_AFTER);
  const after = g.allow({ x: CROSS_ESCALATE_AFTER * 40, z: 0 });
  assert.strictEqual(after.ok, false);
  assert.strictEqual(after.reason, 'zone_banned', 'la zone doit être bannie, pas juste en cooldown');
  // et même en bougeant encore franchement DANS la zone : toujours banni
  assert.strictEqual(g.allow({ x: 0, z: 100 }).ok, false);
});

test('createCrossGate : le ban expire (une zone n’est pas perdue pour la session)', () => {
  let t = 1000;
  // cooldown court devant le ban (en prod : 60 s vs 10 min) pour isoler l'expiration DU BAN
  const g = createCrossGate({ now: () => t, escalateAfter: 2, banMs: 5000, cooldownMs: 1000 });
  g.noteFailure({ x: 0, z: 0 }, 'no_crossable_water');
  const r = g.noteFailure({ x: 0, z: 0 }, 'no_crossable_water');
  assert.strictEqual(r.banned, true);
  t += 4999;
  assert.strictEqual(g.allow({ x: 0, z: 0 }).reason, 'zone_banned');
  t += 2;
  assert.strictEqual(g.allow({ x: 0, z: 0 }).ok, true, 'le ban doit expirer après le TTL');
});

test('createCrossGate : une traversée RÉUSSIE remet tout à zéro (on ne bride jamais ce qui marche)', () => {
  let t = 1000;
  const g = createCrossGate({ now: () => t });
  for (let i = 0; i < CROSS_ESCALATE_AFTER - 1; i++) g.noteFailure({ x: 0, z: 0 }, 'no_crossable_water');
  g.noteSuccess();
  assert.strictEqual(g.allow({ x: 0, z: 0 }).ok, true, 'un succès rouvre immédiatement');
  const r = g.noteFailure({ x: 0, z: 0 }, 'no_crossable_water');
  assert.strictEqual(r.streak, 1, 'le compteur d’escalade repart de zéro après un succès');
});

test('createCrossGate : le ban couvre TOUTE la zone parcourue pendant la série (bond compris)', () => {
  let t = 1000;
  const g = createCrossGate({ now: () => t, escalateAfter: 3 });
  g.noteFailure({ x: 0, z: 0 }, 'no_crossable_water');
  g.noteFailure({ x: 150, z: 0 }, 'no_crossable_water');
  const r = g.noteFailure({ x: 300, z: 0 }, 'no_crossable_water');
  assert.strictEqual(r.banned, true);
  assert.ok(r.zone.r >= 150 + CROSS_ZONE_RADIUS - 1, `rayon trop petit (${r.zone.r})`);
  for (const x of [0, 150, 300]) {
    assert.strictEqual(g.allow({ x, z: 0 }).reason, 'zone_banned', `x=${x} devrait être dans le ban`);
  }
});

test('createCrossGate : entrées bancales → jamais de crash', () => {
  const g = createCrossGate({ now: () => 1000 });
  assert.strictEqual(g.allow(null).ok, true);
  assert.doesNotThrow(() => g.noteFailure(null, undefined));
  assert.doesNotThrow(() => g.state());
});
