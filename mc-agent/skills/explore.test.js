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

test('explore : biais dirigé — va direct au biome connu (mémoire) sans ratisser', async () => {
  const { bot, calls } = makeBot({ target: pos(640, 70, 128) }); // bois loin, mais connu de la mémoire
  const memory = { worlds: { w: { finds: [{ material: 'oak_log', biome: 'forest', x: 640, z: 128 }], biomes: [] } } };
  const res = await explore(bot, { name: 'oak_log', matching: [17], memory, worldKey: 'w' });
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.directed, true, 'trouvé via le ciblage dirigé');
  assert.strictEqual(calls.goto.length, 1, 'un seul déplacement (pas de recherche en anneaux)');
  assert.ok(Math.abs(calls.goto[0].x - 640) <= 1 && Math.abs(calls.goto[0].z - 128) <= 1, 'allé droit au biome connu');
});

test('explore : biais dirigé via amorce vanilla (biomes connus, pas de finds)', async () => {
  const { bot, calls } = makeBot({ target: pos(200, 70, 0) });
  const memory = { worlds: { w: { finds: [], biomes: [{ name: 'forest', x: 200, z: 0 }] } } };
  const res = await explore(bot, { name: 'oak_log', matching: [17], memory, worldKey: 'w' });
  assert.strictEqual(res.directed, true);
  assert.ok(Math.abs(calls.goto[0].x - 200) <= 1, 'allé au biome forest connu (amorce *_log)');
});

test('explore : biais caves (1d) — minerai → va à l\'entrée de grotte connue la + proche', async () => {
  const { bot, calls } = makeBot({ target: pos(300, 70, -100) }); // minerai exposé près de la cave
  const memory = { worlds: { w: { finds: [], biomes: [], caves: [
    { x: 300, y: 45, z: -100 }, { x: 2000, y: 30, z: 2000 },
  ] } } };
  const emits = [];
  const res = await explore(bot, { name: 'iron_ore', matching: [42], memory, worldKey: 'w', emit: (e) => emits.push(e) });
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.directed, true, 'trouvé via le biais cave');
  assert.strictEqual(calls.goto.length, 1, 'un seul déplacement, direct à la cave');
  assert.ok(Math.abs(calls.goto[0].x - 300) <= 1 && Math.abs(calls.goto[0].z - (-100)) <= 1, 'allé à la cave la + proche');
  const ev = emits.find((e) => e.type === 'explore_directed');
  assert.ok(ev && ev.cave === true, 'event explore_directed taggé cave:true');
});

test('explore : multi-matériaux → cible dirigée la + PROCHE tous noms confondus (pas le 1er qui matche)', async () => {
  const { bot, calls } = makeBot({ target: pos(100, 70, 50) });
  const memory = { worlds: { w: { finds: [
    { material: 'oak_log', biome: 'forest', x: 1400, z: 0 },   // 1er du tableau mais LOIN
    { material: 'birch_log', biome: 'forest', x: 100, z: 50 }, // 2e mais tout proche
  ], biomes: [] } } };
  const res = await explore(bot, { name: ['oak_log', 'birch_log'], matching: [17, 18], memory, worldKey: 'w' });
  assert.strictEqual(res.directed, true);
  assert.ok(Math.abs(calls.goto[0].x - 100) <= 1 && Math.abs(calls.goto[0].z - 50) <= 1,
    `allé au gisement le + proche (birch), pas au 1er nom du tableau (goto=${JSON.stringify(calls.goto[0])})`);
});

test('explore : cible dirigée ÉPUISÉE (rien sur place) → continue en anneaux derrière', async () => {
  // Le gisement appris a été vidé : le bot arrive, scan vide → la recherche en anneaux reprend
  // depuis sa position (le directed n'est qu'un préfixe, jamais un cul-de-sac).
  const { bot, calls } = makeBot({ target: pos(90, 70, 130) }); // vraie ressource ailleurs, trouvable en anneaux
  const memory = { worlds: { w: { finds: [{ material: 'oak_log', biome: 'forest', x: 600, z: 0 }], biomes: [] } } };
  // findBlock ne voit la cible que ≤64 : à (600,0) il n'y a RIEN → directed miss → anneaux depuis (600,0)...
  // (le fake téléporte le bot à chaque goto, la géométrie reste cohérente)
  const res = await explore(bot, { name: 'oak_log', matching: [17], memory, worldKey: 'w' });
  assert.strictEqual(calls.goto.length >= 2, true, 'directed (1) puis waypoints anneaux derrière');
  assert.ok(Math.abs(calls.goto[0].x - 600) <= 1, 'a d\'abord tenté la cible apprise');
  assert.strictEqual(res.ok, false, 'pas trouvé ici (ressource hors des anneaux post-directed) mais PAS de hang');
});

test('explore : goto dirigé interrompu (GoalChanged ponctuel, ex. réflexe flee) → RE-TENTE le directed avant les anneaux', async () => {
  // Vu live HarvT7 : un flee pendant le trajet dirigé → goto rejette → explore dégradait en anneaux
  // pour tout l'appel. Un humain interrompu reprend SA route : on redonne UNE chance au directed.
  const { bot, calls } = makeBot({ target: pos(300, 70, -100) });
  const realGoto = bot.pathfinder.goto;
  let n = 0;
  bot.pathfinder.goto = async (goal) => {
    if (n++ === 0) throw new Error('GoalChanged'); // 1re tentative interrompue (réflexe)
    return realGoto(goal);
  };
  const memory = { worlds: { w: { finds: [{ material: 'oak_log', biome: 'forest', x: 300, z: -100 }], biomes: [] } } };
  const res = await explore(bot, { name: 'oak_log', matching: [17], memory, worldKey: 'w' });
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.directed, true, 'trouvé via le directed RE-TENTÉ (pas dégradé en anneaux)');
  assert.strictEqual(n, 2, 'goto dirigé tenté 2 fois');
});

test('explore : goto dirigé qui hang → timeout borné → retombe en anneaux', async () => {
  const { bot, calls } = makeBot({ target: pos(100, 70, 0) });
  const realGoto = bot.pathfinder.goto;
  let hangs = 0;
  bot.pathfinder.goto = async (goal) => {
    if (hangs++ === 0) return new Promise(() => {}); // 1er goto (directed) ne resolve JAMAIS
    return realGoto(goal);
  };
  bot.pathfinder.setGoal = () => {}; // stop du goto au timeout
  const memory = { worlds: { w: { finds: [{ material: 'oak_log', biome: 'forest', x: 600, z: 0 }], biomes: [] } } };
  const res = await explore(bot, { name: 'oak_log', matching: [17], memory, worldKey: 'w', directedGotoTimeoutMs: 40, gotoTimeoutMs: 5000 });
  assert.strictEqual(res.ok, true, 'trouvé via les anneaux malgré le goto dirigé gelé');
  assert.notStrictEqual(res.directed, true);
});

test('explore : waypoint goto qui hang → timeout → waypoint suivant (pas de gel du skill)', async () => {
  const { bot, calls } = makeBot({ target: pos(100, 70, 0) });
  const realGoto = bot.pathfinder.goto;
  let n = 0;
  bot.pathfinder.goto = async (goal) => {
    if (n++ === 0) return new Promise(() => {}); // 1er waypoint gelé
    return realGoto(goal);
  };
  bot.pathfinder.setGoal = () => {};
  const res = await explore(bot, { name: 'oak_log', matching: [17], gotoTimeoutMs: 40 });
  assert.strictEqual(res.ok, true, 'trouvé via les waypoints suivants malgré le 1er gelé');
});

test('explore : cible cave avec y → le goal dirigé vise le y de l\'ENTRÉE (pas origin.y)', async () => {
  const { bot, calls } = makeBot({ target: pos(300, 45, -100) });
  const memory = { worlds: { w: { finds: [], biomes: [], caves: [{ x: 300, y: 45, z: -100 }] } } };
  await explore(bot, { name: 'iron_ore', matching: [42], memory, worldKey: 'w' });
  assert.strictEqual(calls.goto[0].y, 45, 'goal au y de l\'entrée de cave (GoalNear 3D précis)');
});

test('explore : mémoire muette pour ce matériau → fallback aveugle (anneaux) intact', async () => {
  const { bot, calls } = makeBot({ target: pos(100, 70, 0) });
  const memory = { worlds: { w: { finds: [{ material: 'sand', biome: 'desert', x: 500, z: 500 }], biomes: [], caves: [] } } };
  const res = await explore(bot, { name: 'oak_log', matching: [17], memory, worldKey: 'w' });
  assert.strictEqual(res.ok, true, 'trouvé quand même via les anneaux');
  assert.notStrictEqual(res.directed, true, 'pas de ciblage dirigé (rien de connu pour oak_log)');
  assert.ok(calls.goto.length >= 1, 'recherche en anneaux effectuée');
});
