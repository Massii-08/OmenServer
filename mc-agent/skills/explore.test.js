'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { explore, nextWaypoints } = require('./explore');

// pos type minimal avec distanceTo/clone (comme un Vec3 réel — leçon dcd874d : pas de POJO nu).
function pos(x, y, z) {
  return {
    x, y, z,
    distanceTo(o) { return Math.sqrt((x - o.x) ** 2 + (y - o.y) ** 2 + (z - o.z) ** 2); },
    offset(dx, dy, dz) { return pos(x + dx, y + dy, z + dz); },
    clone() { return pos(x, y, z); },
  };
}

// Fake bot : un "bloc cible" caché à `target` ; findBlock ne le voit que si le bot est à ≤ maxDistance.
// pathfinder.goto téléporte le bot au goal (simule la marche). collectBlock retire la cible.
function makeBot({ target = null, profile = null } = {}) {
  const calls = { goto: [], find: 0, collect: [] };
  let tgt = target;
  const bot = {
    entity: { position: pos(0, 70, 0), yaw: 0 },
    _mcaProfile: profile,
    registry: { blocksByName: { oak_log: { id: 17 }, birch_log: { id: 18 } } },
    inventory: { items: () => [] },
    nearestEntity() { return null; },
    pvp: { attack() {} },
    async equip() {},
    findBlock({ matching, maxDistance }) {
      calls.find++;
      if (!tgt) return null;
      const d = bot.entity.position.distanceTo(tgt);
      if (d <= (maxDistance || 64)) return { name: 'oak_log', position: tgt, boundingBox: 'block' };
      return null;
    },
    pathfinder: {
      async goto(goal) {
        const tx = goal && (goal.x !== undefined ? goal.x : goal.target && goal.target.x);
        const ty = goal && (goal.y !== undefined ? goal.y : goal.target && goal.target.y);
        const tz = goal && (goal.z !== undefined ? goal.z : goal.target && goal.target.z);
        if (typeof tx === 'number' && typeof ty === 'number' && typeof tz === 'number') {
          calls.goto.push({ x: tx, y: ty, z: tz });
          bot.entity.position = pos(tx, ty, tz);
        }
      },
    },
    collectBlock: { async collect(b) { calls.collect.push(b); tgt = null; } },
  };
  return { bot, calls };
}

// ---- nextWaypoints (géométrie pure) ----

test('nextWaypoints : borné, fini, dans maxRadius, y constant, déterministe', () => {
  const origin = pos(10, 70, -5);
  const wps = nextWaypoints(origin, { step: 80, maxRadius: 256 });
  assert.ok(wps.length > 0 && wps.length < 1000, 'borné');
  for (const w of wps) {
    const d = Math.sqrt((w.x - 10) ** 2 + (w.z - (-5)) ** 2);
    assert.ok(d <= 256 + 1e-6, `waypoint dans maxRadius (d=${d})`);
    assert.strictEqual(w.y, 70, 'y = origin.y (exploration de surface)');
  }
  const wps2 = nextWaypoints(origin, { step: 80, maxRadius: 256 });
  assert.deepStrictEqual(wps, wps2, 'déterministe');
});

test('nextWaypoints : la couverture grandit avec le rayon (anneaux expansifs)', () => {
  const wps = nextWaypoints(pos(0, 64, 0), { step: 80, maxRadius: 256 });
  const rings = [...new Set(wps.map((w) => w.r))].sort((a, b) => a - b);
  assert.ok(rings.length >= 3, 'au moins 3 anneaux');
  const inner = wps.filter((w) => w.r === rings[0]).length;
  const outer = wps.filter((w) => w.r === rings[rings.length - 1]).length;
  assert.ok(outer > inner, `anneau externe (${outer}) plus dense que interne (${inner})`);
});

// ---- explore (boucle travel + scan) ----

test('explore : trouve une ressource lointaine en se déplaçant', async () => {
  const { bot, calls } = makeBot({ target: pos(100, 70, 0) }); // hors des 64 blocs initiaux
  const res = await explore(bot, { name: 'oak_log', matching: [17], scanRadius: 64, step: 80, maxRadius: 256 });
  assert.strictEqual(res.ok, true, 'doit trouver le bois en explorant');
  assert.ok(res.found, 'retourne la position trouvée');
  assert.ok(calls.goto.length >= 1, 'le bot s\'est déplacé (pathfinder.goto)');
});

test('explore : abandonne proprement après épuisement du budget (pas de hang)', async () => {
  const { bot, calls } = makeBot({ target: null }); // rien nulle part
  const total = nextWaypoints(pos(0, 70, 0), { step: 80, maxRadius: 256 }).length;
  const res = await explore(bot, { name: 'oak_log', matching: [17], scanRadius: 64, step: 80, maxRadius: 256 });
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.reason, 'not_found');
  assert.strictEqual(calls.goto.length, total, 'a tenté tous les waypoints puis s\'est arrêté (borné)');
});

test('explore : token.cancelled arrête tout de suite', async () => {
  const { bot, calls } = makeBot({ target: pos(100, 70, 0) });
  const res = await explore(bot, { name: 'oak_log', matching: [17], token: { cancelled: true } });
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.reason, 'cancelled');
  assert.strictEqual(calls.goto.length, 0, 'aucun déplacement si annulé d\'emblée');
});

test('explore : jitter d\'humanisation ∝ movementJitter du profil', async () => {
  // NB : GoalNear floore les coords → on compare l'ÉCART entre 2 runs (jitter 0 vs +max), robuste au floor.
  const profile = { params: { movementJitter: 1 } };
  const jitterMax = 80 * 0.15 * 1; // = 12
  const a = makeBot({ target: null, profile });
  await explore(a.bot, { name: 'oak_log', matching: [17], step: 80, maxRadius: 80, rng: () => 0.5 }); // jitter 0
  const b = makeBot({ target: null, profile });
  await explore(b.bot, { name: 'oak_log', matching: [17], step: 80, maxRadius: 80, rng: () => 1 });   // jitter +max
  const dx = b.calls.goto[0].x - a.calls.goto[0].x;
  const dz = b.calls.goto[0].z - a.calls.goto[0].z;
  assert.ok(Math.abs(dx - jitterMax) <= 1, `x décalé d'environ +jitterMax (dx=${dx})`);
  assert.ok(Math.abs(dz - jitterMax) <= 1, `z décalé d'environ +jitterMax (dz=${dz})`);
  // profil sans jitter spécifié → jitter par défaut (0.1), bien plus petit
  const c = makeBot({ target: null });
  await explore(c.bot, { name: 'oak_log', matching: [17], step: 80, maxRadius: 80, rng: () => 1 });
  const d2 = makeBot({ target: null });
  await explore(d2.bot, { name: 'oak_log', matching: [17], step: 80, maxRadius: 80, rng: () => 0.5 });
  assert.ok(Math.abs((c.calls.goto[0].x - d2.calls.goto[0].x)) < jitterMax, 'jitter défaut < jitter profil mj=1');
});
