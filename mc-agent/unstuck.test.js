'use strict';
// Anti-stuck eau (#1 retours live) : détection + évasion vers la terre ferme.
const { test } = require('node:test');
const assert = require('node:assert');
const vec3 = require('vec3');
const { isInWater, findLandTarget, escapeWater, WATER } = require('./unstuck');

function waterBot({ inWater = true, landAt = null, pos = { x: 0, y: 62, z: 0 } } = {}) {
  const bot = {
    entity: { position: vec3(pos.x, pos.y, pos.z), isInWater: inWater },
    controls: {},
    setControlState(c, v) { this.controls[c] = v; },
    pathfinder: { setGoal: () => {}, goto: async () => {} },
    findBlocks({ count }) {
      if (!landAt) return [];
      return [vec3(landAt.x, landAt.y, landAt.z)];
    },
    blockAt(p) {
      if (landAt && p.x === landAt.x && p.z === landAt.z) {
        if (p.y === landAt.y) return { name: 'grass_block', boundingBox: 'block' };
        return { name: 'air', boundingBox: 'empty' };                 // l'air au-dessus de la terre
      }
      return { name: 'water', boundingBox: 'empty' };
    },
  };
  return bot;
}

test('isInWater : flag mineflayer prioritaire, fallback bloc aux pieds', () => {
  assert.ok(isInWater(waterBot({ inWater: true })));
  assert.ok(!isInWater(waterBot({ inWater: false })));
  // fallback : pas de flag → bloc aux pieds
  const b = waterBot({}); delete b.entity.isInWater;
  assert.ok(isInWater(b)); // blockAt → water
});

test('findLandTarget : trouve le bloc solide avec 2 airs au-dessus, rejette le fond marin', () => {
  const bot = waterBot({ landAt: { x: 10, y: 63, z: 4 } });
  const land = findLandTarget(bot);
  assert.ok(land && land.x === 10 && land.z === 4);
  // fond marin (y trop bas sous le bot) → rejeté
  const deep = waterBot({ landAt: { x: 10, y: 40, z: 4 } });
  assert.strictEqual(findLandTarget(deep), null);
});

test('escapeWater : nage (jump) + goto vers la terre → ok quand sorti de l\'eau', async () => {
  const bot = waterBot({ landAt: { x: 10, y: 63, z: 4 } });
  const gotos = [];
  const events = [];
  const r = await escapeWater(bot, {
    emit: (e) => events.push(e),
    sleep: async () => {},
    goto: async (p) => { gotos.push(p); bot.entity.isInWater = false; }, // atteindre la terre = sorti
  });
  assert.ok(r.ok);
  assert.strictEqual(gotos.length, 1);
  assert.strictEqual(gotos[0].x, 10);
  assert.strictEqual(bot.controls.jump, false);               // contrôles relâchés à la fin
  assert.ok(events.some((e) => e.type === 'unstuck' && e.cause === 'water'));
});

test('escapeWater : borné dans le temps — rend ok:false si toujours dans l\'eau (pas de boucle infinie)', async () => {
  const bot = waterBot({ landAt: null });                     // aucune terre en vue
  const r = await escapeWater(bot, { sleep: async () => {}, timeoutMs: 1, goto: async () => {} });
  assert.strictEqual(r.ok, false);
});

test('WATER couvre les blocs aquatiques courants', () => {
  for (const n of ['water', 'flowing_water', 'kelp', 'seagrass']) assert.ok(WATER.has(n));
});

// --- #9 lianes / #8 flottant ---
const { clearSnares, isFloatingStuck, recoverFloating, SNARES } = require('./unstuck');

test('clearSnares : casse les lianes adjacentes (pieds/tête/voisins), no-op sinon', async () => {
  const dug = [];
  const bot = {
    entity: { position: vec3(0.5, 64, 0.5) },
    blockAt(p) {
      if (p.x === 0 && p.y === 65 && p.z === 0) return { name: 'vine', boundingBox: 'empty', position: p };
      if (p.x === 1 && p.y === 64 && p.z === 0) return { name: 'cobweb', boundingBox: 'empty', position: p };
      return { name: 'air', boundingBox: 'empty', position: p };
    },
    dig: async (b) => { dug.push(b.name); },
  };
  const n = await clearSnares(bot);
  assert.strictEqual(n, 2);
  assert.ok(dug.includes('vine') && dug.includes('cobweb'));
  // monde propre → 0
  bot.blockAt = (p) => ({ name: 'air', boundingBox: 'empty', position: p });
  assert.strictEqual(await clearSnares(bot), 0);
});

test('isFloatingStuck : flottant immobile ≥1.5s → true ; au sol / dans l\'eau / en mouvement → false', () => {
  const prev = { x: 0, z: 0, t: 0 };
  assert.ok(isFloatingStuck(prev, { x: 0.1, z: 0, t: 2000 }, { onGround: false, inWater: false }));
  assert.ok(!isFloatingStuck(prev, { x: 0.1, z: 0, t: 2000 }, { onGround: true, inWater: false }));
  assert.ok(!isFloatingStuck(prev, { x: 0.1, z: 0, t: 2000 }, { onGround: false, inWater: true }));
  assert.ok(!isFloatingStuck(prev, { x: 5, z: 5, t: 2000 }, { onGround: false, inWater: false }));   // bouge
  assert.ok(!isFloatingStuck(prev, { x: 0.1, z: 0, t: 800 }, { onGround: false, inWater: false }));  // trop tôt
});

test('isFloatingStuck : en CHUTE/SAUT (vy fort) → false (pas coincé) ; vy≈0 → true', () => {
  const prev = { x: 0, z: 0, t: 0 };
  const cur = { x: 0.1, z: 0, t: 2000 };                                  // immobile horizontalement
  assert.ok(!isFloatingStuck(prev, cur, { onGround: false, inWater: false, vy: -1.2 })); // chute
  assert.ok(!isFloatingStuck(prev, cur, { onGround: false, inWater: false, vy: 0.42 }));  // saut (montée)
  assert.ok(isFloatingStuck(prev, cur, { onGround: false, inWater: false, vy: 0.02 }));   // vraiment coincé
  assert.ok(isFloatingStuck(prev, cur, { onGround: false, inWater: false }));             // vy absent = rétro-compat
});

test('recoverFloating : relâche TOUT + coupe le pathfinder + retombe au sol', async () => {
  let cleared = 0, goalCleared = 0, polls = 0;
  const bot = {
    entity: { position: vec3(0, 66, 0), onGround: false },
    clearControlStates() { cleared++; },
    pathfinder: { setGoal: (g) => { if (g === null) goalCleared++; } },
    blockAt: (p) => ({ name: 'air', boundingBox: 'empty', position: p }),
    dig: async () => {},
  };
  const r = await recoverFloating(bot, {
    sleep: async () => { polls++; if (polls >= 2) bot.entity.onGround = true; }, // retombe après 2 polls
  });
  assert.ok(r.ok);
  assert.strictEqual(cleared, 1);
  assert.ok(goalCleared >= 1);
});

test('SNARES couvre lianes jungle + cave vines + cobweb', () => {
  for (const n of ['vine', 'cave_vines', 'twisting_vines', 'weeping_vines', 'cobweb']) assert.ok(SNARES.has(n), n);
});

// ─── Watchdog DESYNC (piste n°5 rapport water-wall) : NethBot1 figé 15 min, position au dixième
// près identique pendant que les events tournent (client désynchronisé, invisible du self-healing
// et du jam-watchdog qui exige un goal pathfinder). Signature = N échantillons STRICTEMENT égaux.

const { isFrozenDesync } = require('./unstuck');

test('isFrozenDesync : 10 échantillons strictement identiques → true', () => {
  const s = Array.from({ length: 10 }, () => ({ x: -337.5, y: 104.0, z: -437.3 }));
  assert.strictEqual(isFrozenDesync(s), true);
});

test('isFrozenDesync : le moindre mouvement (>0.1) casse la détection', () => {
  const s = Array.from({ length: 10 }, () => ({ x: -337.5, y: 104.0, z: -437.3 }));
  s[7] = { x: -337.9, y: 104.0, z: -437.3 };    // 0.4 de dérive = vivant
  assert.strictEqual(isFrozenDesync(s), false);
});

test('isFrozenDesync : micro-jitter sous le dixième compte comme identique (arrondi)', () => {
  const s = Array.from({ length: 10 }, (_, i) => ({ x: -337.5 + i * 0.001, y: 104.0, z: -437.3 }));
  assert.strictEqual(isFrozenDesync(s), true);
});

test('isFrozenDesync : pas assez d\'échantillons → false (fenêtre incomplète)', () => {
  const s = Array.from({ length: 6 }, () => ({ x: 0, y: 64, z: 0 }));
  assert.strictEqual(isFrozenDesync(s), false);
  assert.strictEqual(isFrozenDesync([], {}), false);
  assert.strictEqual(isFrozenDesync(null), false);
});

test('isFrozenDesync : need injectable (fenêtre plus courte pour les tests live)', () => {
  const s = Array.from({ length: 4 }, () => ({ x: 1, y: 2, z: 3 }));
  assert.strictEqual(isFrozenDesync(s, { need: 4 }), true);
});

test('isFrozenDesync : digging → fenêtre ÉTENDUE (20) au lieu de reset — un dig gelé reste détectable', () => {
  // Vécu live world_ax2 : 3 bots gelés EN PLEIN DIG (targetDigBlock figé non-null) → l'ancien gate
  // resetait les échantillons → desync invisible. Un dig légitime ne dure jamais 10 min.
  const frozen10 = Array.from({ length: 10 }, () => ({ x: -433.5, y: 67.0, z: -296.5 }));
  const frozen20 = Array.from({ length: 20 }, () => ({ x: -433.5, y: 67.0, z: -296.5 }));
  assert.strictEqual(isFrozenDesync(frozen10, { digging: true }), false);   // 5 min en dig = encore légitime
  assert.strictEqual(isFrozenDesync(frozen20, { digging: true }), true);    // 10 min figé en dig = desync
  assert.strictEqual(isFrozenDesync(frozen10, { digging: false }), true);   // hors dig : 5 min suffisent (inchangé)
});

// ─── ANTI-CAMPING DU SPAWNPOINT (escapePlan / escapeReached / canReanchorSpawn) ──────────────────
// Flagrant délit world_mn15 (NethBot3, 02:50-02:51) : un squelette campe le point de réapparition,
// le bot respawne, se fait abattre, ré-ancre le /spawnpoint AU MÊME ENDROIT, recommence.
// 4 morts en 36 s. En sans-give le « warp » d'évasion (/spreadplayers) est bloqué par nogive :
// il ne restait donc QUE le ré-ancrage, qui CIMENTE le piège.
const { escapePlan, escapeReached, canReanchorSpawn,
  ESCAPE_MIN_DIST, ESCAPE_MAX_DIST, ESCAPE_SAFE_RADIUS, ESCAPE_REACHED_DIST } = require('./unstuck');

const _d2 = (a, b) => Math.hypot(b.x - a.x, b.z - a.z);

test('escapePlan : sans-give → fuite À PIED (jamais le warp, qui est un no-op bloqué par nogive)', () => {
  const p = escapePlan({ noGive: true, pos: { x: 10, y: 64, z: -20 }, rand: () => 0.5 });
  assert.strictEqual(p.mode, 'walk');
});

test('escapePlan : mode admin (give autorisé) → warp, comportement historique INCHANGÉ', () => {
  const p = escapePlan({ noGive: false, pos: { x: 10, y: 64, z: -20 }, rand: () => 0.5 });
  assert.strictEqual(p.mode, 'warp');
});

test('escapePlan : distance de fuite dans [30, 60] blocs, quel que soit le tirage', () => {
  for (const r of [0, 0.25, 0.5, 0.75, 0.999]) {
    const p = escapePlan({ noGive: true, pos: { x: 0, y: 64, z: 0 }, rand: () => r });
    assert.ok(p.dist >= ESCAPE_MIN_DIST, `dist ${p.dist} >= ${ESCAPE_MIN_DIST}`);
    assert.ok(p.dist <= ESCAPE_MAX_DIST, `dist ${p.dist} <= ${ESCAPE_MAX_DIST}`);
    // et la cible est bien à cette distance du point campé
    assert.ok(Math.abs(_d2({ x: 0, z: 0 }, p) - p.dist) < 1.5);
  }
});

test('escapePlan : hostile en vue → on part À L OPPOSÉ (jamais vers le squelette)', () => {
  // squelette plein EST du bot → la cible doit être à l'OUEST (x < 0)
  const p = escapePlan({ noGive: true, pos: { x: 0, y: 64, z: 0 }, hostile: { x: 12, y: 64, z: 0 }, rand: () => 0.5 });
  assert.ok(p.x < 0, `cible x=${p.x} doit être à l'opposé (x<0)`);
  assert.ok(Math.abs(p.z) < 1, 'même axe → pas de dérive latérale');
  // et on s'éloigne bien de la menace
  assert.ok(_d2(p, { x: 12, z: 0 }) > _d2({ x: 0, z: 0 }, { x: 12, z: 0 }));
});

test('escapePlan : hostile PILE sur le bot (même colonne) → cap arbitraire, jamais NaN', () => {
  const p = escapePlan({ noGive: true, pos: { x: 5, y: 64, z: 5 }, hostile: { x: 5, y: 64, z: 5 }, rand: () => 0.5 });
  assert.ok(Number.isFinite(p.x) && Number.isFinite(p.z));
  assert.ok(_d2({ x: 5, z: 5 }, p) >= ESCAPE_MIN_DIST - 1);
});

test('escapePlan : sans hostile en vue → direction aléatoire (rand injectable = déterministe)', () => {
  const a = escapePlan({ noGive: true, pos: { x: 0, y: 64, z: 0 }, rand: () => 0 });
  const b = escapePlan({ noGive: true, pos: { x: 0, y: 64, z: 0 }, rand: () => 0.5 });
  assert.ok(Number.isFinite(a.x) && Number.isFinite(b.x));
  assert.notDeepStrictEqual({ x: a.x, z: a.z }, { x: b.x, z: b.z });   // deux tirages ≠ même cap
});

test('escapePlan : sans position → null (pas de fuite fantôme, pas de ré-ancrage)', () => {
  assert.strictEqual(escapePlan({ noGive: true, pos: null }), null);
  assert.strictEqual(escapePlan({ noGive: true }), null);
});

test('escapePlan : la cible garde une altitude de référence (celle du bot)', () => {
  const p = escapePlan({ noGive: true, pos: { x: 0, y: 71, z: 0 }, rand: () => 0.5 });
  assert.strictEqual(p.y, 71);
});

test('escapeReached : il faut avoir VRAIMENT quitté le lieu du camping', () => {
  const from = { x: 0, y: 64, z: 0 };
  assert.strictEqual(escapeReached(from, { x: 40, y: 64, z: 0 }), true);
  assert.strictEqual(escapeReached(from, { x: 3, y: 64, z: 2 }), false);   // coincé sur place
  assert.strictEqual(escapeReached(from, from), false);
  assert.strictEqual(escapeReached(from, null), false);
  assert.strictEqual(escapeReached(null, { x: 99, y: 64, z: 99 }), false);
});

test('escapeReached : l ALTITUDE ne compte pas (fuir en descendant reste une fuite)', () => {
  assert.strictEqual(escapeReached({ x: 0, y: 64, z: 0 }, { x: 0, y: 12, z: 40 }), true);
});

test('escapeReached : seuil injectable', () => {
  assert.strictEqual(escapeReached({ x: 0, y: 64, z: 0 }, { x: 10, y: 64, z: 0 }, 8), true);
  assert.strictEqual(escapeReached({ x: 0, y: 64, z: 0 }, { x: 10, y: 64, z: 0 }, 12), false);
});

test('canReanchorSpawn : LE cœur du fix — jamais de /spawnpoint sur le lieu du camping', () => {
  // fuite échouée (bot coincé) → on ne ré-ancre PAS DU TOUT cette fois
  assert.strictEqual(canReanchorSpawn({ escaped: false, nearestHostileDist: null }), false);
  // fuite réussie mais un hostile campe encore la zone d'arrivée → pas d'ancrage non plus
  assert.strictEqual(canReanchorSpawn({ escaped: true, nearestHostileDist: 9 }), false);
  // fuite réussie + zone propre → ancrage
  assert.strictEqual(canReanchorSpawn({ escaped: true, nearestHostileDist: null }), true);
  assert.strictEqual(canReanchorSpawn({ escaped: true, nearestHostileDist: Infinity }), true);
  assert.strictEqual(canReanchorSpawn({ escaped: true, nearestHostileDist: ESCAPE_SAFE_RADIUS + 1 }), true);
});

test('canReanchorSpawn : la frontière des 16 blocs est INCLUSIVE côté danger', () => {
  assert.strictEqual(canReanchorSpawn({ escaped: true, nearestHostileDist: ESCAPE_SAFE_RADIUS }), false);
});

test('canReanchorSpawn : entrée vide/absurde → refus (par défaut on ne cimente rien)', () => {
  assert.strictEqual(canReanchorSpawn({}), false);
  assert.strictEqual(canReanchorSpawn(), false);
  assert.strictEqual(canReanchorSpawn({ escaped: true, nearestHostileDist: NaN }), false);
});

test('constantes : les seuils sont exportés et cohérents entre eux', () => {
  assert.ok(ESCAPE_MIN_DIST < ESCAPE_MAX_DIST);
  // on doit pouvoir « réussir » une fuite plus courte que le plan (terrain accidenté, NoPath partiel)
  assert.ok(ESCAPE_REACHED_DIST < ESCAPE_MIN_DIST);
  // sortir de la zone dangereuse doit être garanti par une fuite réussie
  assert.ok(ESCAPE_REACHED_DIST > ESCAPE_SAFE_RADIUS / 2);
});
