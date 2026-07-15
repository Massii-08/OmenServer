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
