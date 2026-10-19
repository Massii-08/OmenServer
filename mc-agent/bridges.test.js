'use strict';
// PONTS ÉNORMES EN SURFACE (Massii : « évite que les bots créent des ponts énormes en surface, ça ne
// sert à rien »). Deux étages de tests :
//   1. la décision PURE `voidBridgePenalty` sur une colonne fabriquée à la main ;
//   2. l'INTÉGRATION avec la VRAIE classe `Movements` de mineflayer-pathfinder 2.4.5 et la vraie A*,
//      sur un monde en mémoire (registre 1.21.4 réel, aucun serveur) — c'est elle qui prouve que la
//      pénalité arrive bien là où le pathfinder décide de poser, et qu'elle ne casse PAS les tours.
const { test } = require('node:test');
const assert = require('node:assert');
const {
  voidBridgePenalty, installBridgeGuard,
  BRIDGE_FORBID, SURFACE_MIN_Y, VOID_MAX_DEPTH, VOID_FORBID_DEPTH, FLUID_SCAN_DEPTH,
} = require('./bridges');
const { withTempMovements } = require('./movement');

// ─── Monde pur : colonne fabriquée ─────────────────────────────────────────────────────────────
const AIR = { name: 'air', boundingBox: 'empty' };
const STONE = { name: 'stone', boundingBox: 'block' };
const WATER = { name: 'water', boundingBox: 'empty' };
const LAVA = { name: 'lava', boundingBox: 'empty' };
const GRASS = { name: 'short_grass', boundingBox: 'empty' };
const SEAGRASS = { name: 'seagrass', boundingBox: 'empty' };

/** blockAt d'un monde où `col(y)` décrit la colonne (x, z) testée ; ailleurs : pierre. */
function columnWorld(x, z, col) {
  const seen = [];
  const blockAt = (p) => {
    seen.push(p);
    if (p.x !== x || p.z !== z) return STONE;
    return col(p.y);
  };
  blockAt.seen = seen;
  return blockAt;
}
/** Le bloc que le pathfinder passe à exclusionPlace (seule la position compte). */
const at = (x, y, z) => ({ name: 'air', boundingBox: 'empty', position: { x, y, z } });

test('constantes : interdit = bien au-delà du plafond 100 de la lib ; seuils cohérents', () => {
  assert.ok(BRIDGE_FORBID > 100, 'la lib rejette un mouvement au-delà de 100');
  assert.strictEqual(SURFACE_MIN_Y, 50);
  assert.strictEqual(VOID_MAX_DEPTH, 4);
  assert.strictEqual(VOID_FORBID_DEPTH, 3);
  assert.strictEqual(FLUID_SCAN_DEPTH, 4);
});

test('pont au-dessus d une VALLÉE de 10 blocs en surface → interdit', () => {
  // case d'arrivée (feet) à y=70 : la pose se ferait en y=69, vide jusqu'au fond en y=59
  const blockAt = columnWorld(5, 0, (y) => (y >= 60 ? AIR : STONE));
  assert.strictEqual(voidBridgePenalty(blockAt, at(5, 70, 0)), BRIDGE_FORBID);
});

test('fossé de 1 bloc en surface → autorisé (0)', () => {
  const blockAt = columnWorld(5, 0, (y) => (y >= 69 ? AIR : STONE));
  assert.strictEqual(voidBridgePenalty(blockAt, at(5, 70, 0)), 0);
});

test('fossé de 2 blocs en surface → autorisé (0)', () => {
  const blockAt = columnWorld(5, 0, (y) => (y >= 68 ? AIR : STONE));
  assert.strictEqual(voidBridgePenalty(blockAt, at(5, 70, 0)), 0);
});

test('seuil : 3 blocs de vide sous la pose en surface → interdit', () => {
  const blockAt = columnWorld(5, 0, (y) => (y >= 67 ? AIR : STONE));
  assert.strictEqual(voidBridgePenalty(blockAt, at(5, 70, 0)), BRIDGE_FORBID);
});

test('au-dessus de l EAU en surface → interdit (pont sur l eau, décision du 19/07)', () => {
  // un bloc d'air puis la surface du lac
  const blockAt = columnWorld(5, 0, (y) => (y === 69 ? AIR : y >= 60 ? WATER : STONE));
  assert.strictEqual(voidBridgePenalty(blockAt, at(5, 70, 0)), BRIDGE_FORBID);
});

test('pose DANS l eau (case de pose = eau) → interdit aussi', () => {
  // cas des Movements PAR DÉFAUT des plugins (collectBlock / pvp) : l'eau y reste `replaceable`
  const blockAt = columnWorld(5, 0, (y) => (y >= 60 ? WATER : STONE));
  assert.strictEqual(voidBridgePenalty(blockAt, at(5, 70, 0)), BRIDGE_FORBID);
});

test('au-dessus de l eau SOUS TERRE → interdit aussi (partout, pas seulement en surface)', () => {
  const blockAt = columnWorld(5, 0, (y) => (y === 29 ? AIR : y >= 20 ? WATER : STONE));
  assert.strictEqual(voidBridgePenalty(blockAt, at(5, 30, 0)), BRIDGE_FORBID);
});

test('au-dessus de la LAVE → interdit', () => {
  const blockAt = columnWorld(5, 0, (y) => (y >= 28 && y <= 29 ? AIR : y >= 20 && y < 28 ? LAVA : STONE));
  assert.strictEqual(voidBridgePenalty(blockAt, at(5, 30, 0)), BRIDGE_FORBID);
});

test('fluide : à 4 blocs sous la pose → interdit ; à 5 (sous terre, vide sec au-dessus) → autorisé', () => {
  const four = columnWorld(5, 0, (y) => (y >= 27 ? AIR : y === 26 ? WATER : STONE));     // i = 1..3 air, i = 4 eau
  assert.strictEqual(voidBridgePenalty(four, at(5, 30, 0)), BRIDGE_FORBID);
  const five = columnWorld(5, 0, (y) => (y >= 26 ? AIR : y === 25 ? WATER : STONE));     // i = 1..4 air, i = 5 eau
  assert.strictEqual(voidBridgePenalty(five, at(5, 30, 0)), 0);
});

test('plantes aquatiques (seagrass) = de l EAU : pont au-dessus → interdit', () => {
  const blockAt = columnWorld(5, 0, (y) => (y === 69 ? AIR : y === 68 ? SEAGRASS : STONE));
  assert.strictEqual(voidBridgePenalty(blockAt, at(5, 70, 0)), BRIDGE_FORBID);
});

test('fluide SOUS un sol plein ne compte pas (on ne pose pas au-dessus de lui)', () => {
  // pose en y=69 sur un sol de pierre en y=68, poche d'eau en y=67 : le sol sépare tout
  const blockAt = columnWorld(5, 0, (y) => (y === 69 ? AIR : y === 68 ? STONE : y === 67 ? WATER : STONE));
  assert.strictEqual(voidBridgePenalty(blockAt, at(5, 70, 0)), 0);
});

test('vide profond SOUS TERRE (y < 50) → autorisé (0) : ravin de grotte, pas une vallée', () => {
  const blockAt = columnWorld(5, 0, (y) => (y >= 15 ? AIR : STONE));
  assert.strictEqual(voidBridgePenalty(blockAt, at(5, 30, 0)), 0);
});

test('TOUR (bloc des pieds, sol plein dessous) → 0', () => {
  // getMoveUp passe `block1` = la case des pieds du nœud : dessous, c'est le sol où il se tient
  const blockAt = columnWorld(0, 0, (y) => (y >= 70 ? AIR : STONE));
  assert.strictEqual(voidBridgePenalty(blockAt, at(0, 70, 0)), 0);
});

test('végétation (herbe haute) = traversable : comptée comme vide, fossé de 1 → autorisé', () => {
  const blockAt = columnWorld(5, 0, (y) => (y === 69 ? GRASS : y >= 70 ? AIR : STONE));
  assert.strictEqual(voidBridgePenalty(blockAt, at(5, 70, 0)), 0);
  const valley = columnWorld(5, 0, (y) => (y === 69 ? GRASS : y >= 60 ? AIR : STONE));
  assert.strictEqual(voidBridgePenalty(valley, at(5, 70, 0)), BRIDGE_FORBID);
});

test('chunk non chargé (blockAt → null) → 0 : on ne sait pas, on ne bloque pas', () => {
  assert.strictEqual(voidBridgePenalty(() => null, at(5, 70, 0)), 0);
});

test('vide connu puis inconnu : on juge sur ce qu on SAIT', () => {
  // 3 blocs d'air lisibles puis null : la vallée est prouvée → interdit
  const known3 = (p) => (p.y >= 67 ? AIR : null);
  assert.strictEqual(voidBridgePenalty(known3, at(5, 70, 0)), BRIDGE_FORBID);
  // 1 bloc d'air puis null : rien de prouvé → 0
  const known1 = (p) => (p.y >= 69 ? AIR : null);
  assert.strictEqual(voidBridgePenalty(known1, at(5, 70, 0)), 0);
});

test('entrées absurdes → 0, jamais d exception', () => {
  assert.strictEqual(voidBridgePenalty(null, at(5, 70, 0)), 0);
  assert.strictEqual(voidBridgePenalty(() => AIR, null), 0);
  assert.strictEqual(voidBridgePenalty(() => AIR, {}), 0);                    // bloc factice de la lib (chunk non chargé)
  assert.strictEqual(voidBridgePenalty(() => AIR, at(NaN, 70, 0)), 0);
  assert.strictEqual(voidBridgePenalty(() => { throw new Error('boom'); }, at(5, 70, 0)), 0);
});

test('blockAt reçoit des Vec3 (mineflayer appelle pos.floored() : un objet nu le ferait planter)', () => {
  const blockAt = columnWorld(5, 0, (y) => (y >= 60 ? AIR : STONE));
  voidBridgePenalty(blockAt, at(5, 70, 0));
  assert.ok(blockAt.seen.length > 0);
  for (const p of blockAt.seen) assert.strictEqual(typeof p.floored, 'function');
  assert.deepStrictEqual(blockAt.seen.map((p) => p.y), [69, 68, 67, 66]);   // de la case de pose vers le bas, borné
});

test('options injectables : seuil de surface et profondeurs', () => {
  const valley = columnWorld(5, 0, (y) => (y >= 15 ? AIR : STONE));
  assert.strictEqual(voidBridgePenalty(valley, at(5, 30, 0), { surfaceMinY: 0 }), BRIDGE_FORBID);
  const ditch2 = columnWorld(5, 0, (y) => (y >= 68 ? AIR : STONE));
  assert.strictEqual(voidBridgePenalty(ditch2, at(5, 70, 0), { forbidDepth: 2 }), BRIDGE_FORBID);
});

// ─── installBridgeGuard : branchement sur une Movements ────────────────────────────────────────
test('installBridgeGuard : refuse proprement une cible invalide', () => {
  assert.strictEqual(installBridgeGuard(null, () => AIR), false);
  assert.strictEqual(installBridgeGuard({}, () => AIR), false);
  assert.strictEqual(installBridgeGuard({ exclusionAreasPlace: [] }, null), false);
});

test('installBridgeGuard : idempotent (une seule pénalité même posé deux fois)', () => {
  const m = { exclusionAreasPlace: [], getMoveUp() {} };
  assert.strictEqual(installBridgeGuard(m, () => AIR), true);
  assert.strictEqual(installBridgeGuard(m, () => AIR), true);
  assert.strictEqual(m.exclusionAreasPlace.length, 1);
});

// ─── INTÉGRATION : vraie Movements + vraie A* de mineflayer-pathfinder, monde en mémoire ───────
let real = null;
try {
  const registry = require('prismarine-registry')('1.21.4');
  real = {
    registry,
    Block: require('prismarine-block')(registry),
    Vec3: require('vec3').Vec3,
    Movements: require('mineflayer-pathfinder').Movements,
    goals: require('mineflayer-pathfinder').goals,
    AStar: require('mineflayer-pathfinder/lib/astar'),
    Move: require('mineflayer-pathfinder/lib/move'),
  };
} catch (e) { real = null; }
const SKIP = !real && 'mineflayer-pathfinder / prismarine-registry introuvables';

/** Monde en mémoire : tout est air sauf ce qu'on remplit ; hors |x|,|z| ≤ 64 = chunk non chargé. */
function makeWorld() {
  const cells = new Map();
  const fill = (x1, y1, z1, x2, y2, z2, name) => {
    for (let x = Math.min(x1, x2); x <= Math.max(x1, x2); x++) {
      for (let y = Math.min(y1, y2); y <= Math.max(y1, y2); y++) {
        for (let z = Math.min(z1, z2); z <= Math.max(z1, z2); z++) cells.set(`${x},${y},${z}`, name);
      }
    }
  };
  const blockAt = (pos) => {
    const x = Math.floor(pos.x); const y = Math.floor(pos.y); const z = Math.floor(pos.z);
    if (Math.abs(x) > 64 || Math.abs(z) > 64) return null;
    const name = cells.get(`${x},${y},${z}`) || 'air';
    const b = real.Block.fromStateId(real.registry.blocksByName[name].defaultState, 0);
    b.position = new real.Vec3(x, y, z);
    return b;
  };
  return { fill, blockAt };
}
/** Le strict nécessaire que `Movements` lit sur le bot (aucun réseau). */
function makeBot(world) {
  const bot = {
    registry: real.registry,
    blockAt: (p) => world.blockAt(p),
    entity: { position: new real.Vec3(0, 0, 0), effects: {} },
    entities: {},
    inventory: { items: () => [] },
    game: { minY: -64 },
    pathfinder: { bestHarvestTool: () => null, setMovements(m) { bot._active = m; } },
  };
  return bot;
}
/** Movements réglée comme un OUVRIER en prod (index.js, onSpawn) — avec ou sans garde-fou. */
function workerMoves(bot, { guard = true, placeCost = 45 } = {}) {
  const m = new real.Movements(bot);
  m.placeCost = placeCost;
  if (guard) installBridgeGuard(m, (p) => bot.blockAt(p));
  return m;
}
const placesInto = (moves, x, z) => moves.some((mv) => mv.toPlace.length && mv.x === x && mv.z === z);
function astar(moves, start, goal) {
  const a = new real.AStar(start, moves, goal, 5000, 40, 256);   // searchRadius = PATHFINDER_SEARCH_RADIUS
  let r = a.compute();
  while (r.status === 'partial') r = a.compute();
  return r;
}

/** Plateau en surface (sol y=69, x ≤ 0) bordé d'une vallée (x ≥ 1) de fond `floorY`. */
function cliffWorld(floorY, { surface = 69, liquid = null, liquidTop = null } = {}) {
  const w = makeWorld();
  w.fill(-10, surface - 19, -10, 0, surface, 10, 'stone');
  w.fill(1, surface - 19, -10, 30, floorY, 10, 'stone');
  if (liquid) w.fill(1, floorY + 1, -10, 30, liquidTop, 10, liquid);
  return w;
}

test('VRAIE Movements — témoin : SANS garde-fou, le pathfinder propose le pas de PONT au-dessus de la vallée', { skip: SKIP }, () => {
  const bot = makeBot(cliffWorld(59));
  const nb = workerMoves(bot, { guard: false }).getNeighbors(new real.Move(0, 70, 0, 64, 0));
  assert.ok(placesInto(nb, 1, 0), 'la lib doit proposer de poser un bloc en (1,69,0) : sinon le test ne prouve rien');
});

test('VRAIE Movements : AVEC garde-fou, plus aucune pose au-dessus de la vallée (pont ni marche en l air)', { skip: SKIP }, () => {
  const bot = makeBot(cliffWorld(59));
  const nb = workerMoves(bot).getNeighbors(new real.Move(0, 70, 0, 64, 0));
  assert.strictEqual(placesInto(nb, 1, 0), false);
  // le reste du plateau est intact : on marche toujours vers l'arrière
  assert.ok(nb.some((mv) => mv.x === -1 && mv.y === 70 && mv.z === 0 && !mv.toPlace.length));
});

test('VRAIE Movements : fossé de 2 → le pas de pont reste proposé avec le garde-fou', { skip: SKIP }, () => {
  const bot = makeBot(cliffWorld(67));
  const nb = workerMoves(bot).getNeighbors(new real.Move(0, 70, 0, 64, 0));
  assert.ok(placesInto(nb, 1, 0));
});

test('VRAIE Movements : ravin sec SOUS TERRE → le pont reste permis', { skip: SKIP }, () => {
  const bot = makeBot(cliffWorld(14, { surface: 29 }));
  const nb = workerMoves(bot).getNeighbors(new real.Move(0, 30, 0, 64, 0));
  assert.ok(placesInto(nb, 1, 0));
});

test('VRAIE Movements par DÉFAUT (celle des plugins collectBlock/pvp : placeCost 1, eau replaceable) : plus de pont sur l eau', { skip: SKIP }, () => {
  const bot = makeBot(cliffWorld(59, { liquid: 'water', liquidTop: 68 }));
  const lib = new real.Movements(bot);                                  // réglages d'usine
  assert.ok(placesInto(lib.getNeighbors(new real.Move(0, 70, 0, 64, 0)), 1, 0), 'témoin : la lib pose sur l eau');
  installBridgeGuard(lib, (p) => bot.blockAt(p));
  assert.strictEqual(placesInto(lib.getNeighbors(new real.Move(0, 70, 0, 64, 0)), 1, 0), false);
});

test('VRAIE A* : traverser la vallée en surface ne se fait plus par un pont (placeCost 1 des plugins)', { skip: SKIP }, () => {
  const w = cliffWorld(59);
  w.fill(12, 50, -10, 30, 69, 10, 'stone');                             // l'autre rive, 11 blocs plus loin
  const bot = makeBot(w);
  const goal = new real.goals.GoalBlock(15, 70, 0);
  // canDig coupé : le seul franchissement possible est la passerelle (pas d'escalier creusé).
  // 14 blocs d'échafaudage en poche (assez pour la passerelle-témoin de 11) : à placeCost 1 chaque
  // étage de tour coûte 2, et une fois le pont interdit l'A* explore TOUT le cône de tours permis
  // par le budget avant de conclure — borné par les blocs en poche (64 → ~2,7 s ici, 14 → ~0,5 s).
  const run = (guard) => {
    const m = workerMoves(bot, { guard, placeCost: 1 });
    m.canDig = false;
    return astar(m, new real.Move(0, 70, 0, 14, 0), goal);
  };
  const free = run(false);
  assert.strictEqual(free.status, 'success', 'témoin : sans garde-fou la lib construit la passerelle');
  assert.ok(free.path.some((n) => n.toPlace.length), 'témoin : le chemin pose des blocs');
  const guarded = run(true);
  assert.strictEqual(guarded.status, 'noPath');
  assert.strictEqual(guarded.path.some((n) => n.toPlace.length), false);
});

/** Puits 1×1 de `depth` blocs creusé dans un plateau de surface (sol y=69), bot au fond. */
function pitWorld(depth) {
  const w = makeWorld();
  w.fill(-10, 40, -10, 10, 69, 10, 'stone');
  w.fill(0, 70 - depth, 0, 0, 69, 0, 'air');
  return w;
}

test('VRAIE A* : sortir d un puits de 5 blocs en surface par une TOUR reste possible (garde-fou posé)', { skip: SKIP }, () => {
  const bot = makeBot(pitWorld(5));
  const moves = workerMoves(bot);
  moves.canDig = false;                                                // seule issue : la tour 1×1
  const r = astar(moves, new real.Move(0, 65, 0, 64, 0), new real.goals.GoalY(70));
  assert.strictEqual(r.status, 'success');
  assert.strictEqual(r.path.length, 5);
});

test('témoin : la pénalité BRUTE (sans exemption de la tour) casse la tour au 4e bloc', { skip: SKIP }, () => {
  // Les blocs d'une tour en cours sont encore de l'AIR dans le monde que lit l'A* : au 4e étage la
  // colonne sous les pieds montre 3 blocs de vide — exactement la signature d'une vallée. D'où
  // l'exemption de getMoveUp dans installBridgeGuard (sinon : bots figés, cf. world_ax5).
  const bot = makeBot(pitWorld(5));
  const moves = workerMoves(bot, { guard: false });
  moves.canDig = false;
  moves.exclusionAreasPlace.push((b) => voidBridgePenalty((p) => bot.blockAt(p), b));
  const r = astar(moves, new real.Move(0, 65, 0, 64, 0), new real.goals.GoalY(70));
  assert.notStrictEqual(r.status, 'success');
});

test('withTempMovements hérite du garde-fou : MÊME tableau exclusionAreasPlace, tour toujours exemptée', { skip: SKIP }, async () => {
  const bot = makeBot(cliffWorld(59));
  const nominal = workerMoves(bot);
  bot._mcaMoves = nominal;
  let seen = null;
  await withTempMovements(bot, real.Movements, { canDig: false }, async () => {
    const temp = bot._mcaMoves;
    seen = {
      isTemp: temp !== nominal && temp.canDig === false,
      sameArray: temp.exclusionAreasPlace === nominal.exclusionAreasPlace,
      bridge: placesInto(temp.getNeighbors(new real.Move(0, 70, 0, 64, 0)), 1, 0),
    };
  });
  assert.deepStrictEqual(seen, { isTemp: true, sameArray: true, bridge: false });
  assert.strictEqual(bot._mcaMoves, nominal, 'la nominale est restaurée');
  // la tour reste exemptée sur une temporaire (getMoveUp enveloppé recopié par Object.assign)
  const pit = makeBot(pitWorld(5));
  pit._mcaMoves = workerMoves(pit);
  let tower = null;
  await withTempMovements(pit, real.Movements, { canDig: false }, async () => {
    tower = astar(pit._mcaMoves, new real.Move(0, 65, 0, 64, 0), new real.goals.GoalY(70)).status;
  });
  assert.strictEqual(tower, 'success');
});
