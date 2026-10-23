'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const lg = require('./lavaGuard');

const STONE = { name: 'stone', boundingBox: 'block' };
const AIR = { name: 'air', boundingBox: 'empty' };
const LAVA = { name: 'lava', boundingBox: 'empty' };
const FIRE = { name: 'fire', boundingBox: 'empty' };
function world(map, dflt = STONE) {
  return (p) => map[`${p.x},${p.y},${p.z}`] || dflt;
}

test('lavaFaces : les 6 faces, entiers, rien en diagonale', () => {
  const blockAt = world({ '1,10,0': LAVA, '0,11,0': LAVA, '1,11,1': LAVA });
  const f = lg.lavaFaces(blockAt, { x: 0.4, y: 10.2, z: 0.9 });
  assert.deepStrictEqual(f.sort((a, b) => a.x - b.x), [{ x: 0, y: 11, z: 0 }, { x: 1, y: 10, z: 0 }]);
  assert.strictEqual(lg.lavaAdjacent(blockAt, { x: 5, y: 10, z: 5 }), false);
});

test('lavaFaces : blockAt reçoit des Vec3 et une lecture qui jette ne casse rien', () => {
  let vec = true;
  const f = lg.lavaFaces((p) => { if (typeof p.floored !== 'function') vec = false; throw new Error('x'); }, { x: 0, y: 0, z: 0 });
  assert.deepStrictEqual(f, []);
  assert.ok(vec);
});

test('lavaStepPenalty : 0 loin de la lave, 40 au bord, 95 en fenêtre de fuite (jamais ≥ 100)', () => {
  lg._resetStrict();
  const blockAt = world({ '1,10,0': LAVA });
  const near = { position: { x: 0, y: 10, z: 0 } };
  const far = { position: { x: 9, y: 10, z: 9 } };
  assert.strictEqual(lg.lavaStepPenalty(blockAt, far, { now: 0 }), 0);
  assert.strictEqual(lg.lavaStepPenalty(blockAt, near, { now: 0 }), lg.LAVA_STEP_PENALTY);
  lg.strictFor(5000, 1000);
  assert.strictEqual(lg.lavaStepPenalty(blockAt, near, { now: 2000 }), lg.LAVA_STEP_STRICT);
  assert.ok(lg.LAVA_STEP_STRICT < 100);
  assert.strictEqual(lg.lavaStepPenalty(blockAt, near, { now: 7000 }), lg.LAVA_STEP_PENALTY, 'la fenêtre se referme');
  lg._resetStrict();
});

test('lavaStepPenalty : lave SOUS la case (sol de lave) compte aussi', () => {
  const blockAt = world({ '0,9,0': LAVA });
  assert.strictEqual(lg.lavaStepPenalty(blockAt, { position: { x: 0, y: 10, z: 0 } }, { now: 0 }), lg.LAVA_STEP_PENALTY);
});

test('strafeCell : yaw 0 (face au nord, -z) → droite = +x, gauche = -x', () => {
  assert.deepStrictEqual(lg.strafeCell({ x: 0.5, y: 10, z: 0.5 }, 0, 'right', 1), { x: 1, y: 10, z: 0 });
  assert.deepStrictEqual(lg.strafeCell({ x: 0.5, y: 10, z: 0.5 }, 0, 'left', 1), { x: -1, y: 10, z: 0 });
  assert.strictEqual(lg.strafeCell({ x: 0, y: 0, z: 0 }, 0, 'forward'), null);
});

test('lateralHazard : lave dans la case, dans son sol, ou sous un sol vide ; feu ; sinon null', () => {
  const me = { x: 0.5, y: 10, z: 0.5 };
  assert.strictEqual(lg.lateralHazard(world({}), me, 0, 'right'), null);
  assert.strictEqual(lg.lateralHazard(world({ '1,10,0': LAVA }), me, 0, 'right'), 'lava');
  assert.strictEqual(lg.lateralHazard(world({ '1,9,0': LAVA }), me, 0, 'right'), 'lava');
  assert.strictEqual(lg.lateralHazard(world({ '2,9,0': LAVA }), me, 0, 'right'), 'lava', 'élan : 2 blocs');
  assert.strictEqual(lg.lateralHazard(world({ '1,9,0': AIR, '1,8,0': LAVA }), me, 0, 'right'), 'lava');
  assert.strictEqual(lg.lateralHazard(world({ '1,10,0': FIRE }), me, 0, 'right'), 'fire');
  assert.strictEqual(lg.lateralHazard(world({ '1,10,0': LAVA }), me, 0, 'left'), null, 'l autre côté est sûr');
});

test('createAvoidedThrottle : un event par lieu et par fenêtre', () => {
  const ok = lg.createAvoidedThrottle(10000);
  assert.strictEqual(ok('ore_grab', 0), true);
  assert.strictEqual(ok('ore_grab', 5000), false);
  assert.strictEqual(ok('vein', 5000), true);
  assert.strictEqual(ok('ore_grab', 10001), true);
});

// ─── INTÉGRATION : vraie Movements + vraie A* de mineflayer-pathfinder ─────────────────────────
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
function makeBot(w) {
  const bot = {
    registry: real.registry,
    blockAt: (p) => w.blockAt(p),
    entity: { position: new real.Vec3(0, 0, 0), effects: {} },
    entities: {},
    inventory: { items: () => [] },
    game: { minY: -64 },
    pathfinder: { bestHarvestTool: () => null, setMovements() {} },
  };
  return bot;
}
function astar(moves, start, goal) {
  const a = new real.AStar(start, moves, goal, 5000, 40, 256);
  let r = a.compute();
  while (r.status === 'partial') r = a.compute();
  return r;
}
/** Sol de pierre y=9, marche à y=10 ; une mare de lave le long de la ligne droite z=0 (x 3..8, y=10, z=1). */
function poolWorld() {
  const w = makeWorld();
  w.fill(-5, 0, -10, 20, 9, 10, 'stone');
  w.fill(3, 10, 1, 8, 10, 1, 'lava');    // mare posée sur le sol, juste à côté de la ligne droite
  return w;
}
const bordersLava = (w, mv) => lg.lavaAdjacent(w.blockAt, { x: mv.x, y: mv.y, z: mv.z });

test('VRAIE A* — témoin : sans garde-fou, le chemin direct longe la mare de lave', { skip: SKIP }, () => {
  const w = poolWorld();
  const m = new real.Movements(makeBot(w));
  const r = astar(m, new real.Move(0, 10, 0, 0, 0), new real.goals.GoalBlock(12, 10, 0));
  assert.strictEqual(r.status, 'success');
  assert.ok(r.path.some((mv) => bordersLava(w, mv)), 'le témoin doit longer la lave');
});

test('VRAIE A* : avec garde-fou, le chemin contourne la mare (aucune case bordière)', { skip: SKIP }, () => {
  const w = poolWorld();
  const m = new real.Movements(makeBot(w));
  assert.strictEqual(lg.installLavaGuard(m, w.blockAt), true);
  assert.strictEqual(lg.installLavaGuard(m, w.blockAt), true, 'idempotent');
  assert.strictEqual(m.exclusionAreasStep.length, 1);
  const r = astar(m, new real.Move(0, 10, 0, 0, 0), new real.goals.GoalBlock(12, 10, 0));
  assert.strictEqual(r.status, 'success');
  assert.ok(!r.path.some((mv) => bordersLava(w, mv)), 'aucun pas au bord de la lave');
});

test('VRAIE A* : bord de lave SEULE issue → chemin trouvé quand même (fenêtre de fuite comprise)', { skip: SKIP }, () => {
  const w = makeWorld();
  w.fill(-5, 0, -1, 20, 9, 1, 'stone');
  w.fill(-5, 10, -1, 20, 12, -1, 'stone');   // couloir 1 de large z=0, murs z=-1 / z=1
  w.fill(-5, 10, 1, 20, 12, 1, 'stone');
  w.fill(5, 10, 1, 5, 10, 1, 'lava');        // une case de lave dans la paroi
  const m = new real.Movements(makeBot(w));
  lg.installLavaGuard(m, w.blockAt);
  lg.strictFor(60000);
  const r = astar(m, new real.Move(0, 10, 0, 0, 0), new real.goals.GoalBlock(10, 10, 0));
  lg._resetStrict();
  assert.strictEqual(r.status, 'success', 'jamais de noPath pour une simple bordure');
});

test('VRAIE Movements : safeToBreak refuse un bloc qui retient la lave, même avec dontCreateFlow=false (collectBlock)', { skip: SKIP }, () => {
  const w = makeWorld();
  w.fill(-5, 0, -5, 5, 20, 5, 'stone');
  w.fill(2, 10, 0, 2, 10, 0, 'lava');
  w.fill(-2, 10, 0, -2, 10, 0, 'water');
  const m = new real.Movements(makeBot(w));
  m.dontCreateFlow = false;                         // ce que collectBlock fait à chaque collect
  lg.installLavaGuard(m, w.blockAt);
  const nextToLava = w.blockAt({ x: 1, y: 10, z: 0 });
  const nextToWater = w.blockAt({ x: -1, y: 10, z: 0 });
  const plain = w.blockAt({ x: 0, y: 15, z: 0 });
  assert.strictEqual(m.safeToBreak(nextToLava), false);
  assert.strictEqual(m.safeToBreak(nextToWater), true, 'l eau reste le choix de collectBlock');
  assert.strictEqual(m.safeToBreak(plain), true);
  // une copie Object.assign (withTempMovements) hérite de la garde
  const t = new real.Movements(makeBot(w));
  Object.assign(t, m);
  assert.strictEqual(t.safeToBreak(nextToLava), false);
});

test('VRAIE Movements : une CHUTE (dropDown / descente) qui atterrit au bord de la lave est pénalisée', { skip: SKIP }, () => {
  // Le pas de chute de la lib ne passe JAMAIS par exclusionStep pour sa case d'atterrissage : sans
  // enveloppe, un saut de 3 blocs au fond d'une grotte à côté d'une mare coûtait comme ailleurs.
  const w = makeWorld();
  w.fill(-5, 0, -5, 0, 20, 5, 'stone');       // plateau x ≤ 0, sol y=20 → on marche à y=21
  w.fill(1, 0, -5, 10, 17, 5, 'stone');       // fond x ≥ 1, sol y=17 → atterrissage à y=18
  w.fill(1, 18, 1, 1, 18, 1, 'lava');         // une case de lave à côté de l'atterrissage (1,18,0)
  const bot = makeBot(w);
  const plain = new real.Movements(bot);
  const guarded = new real.Movements(bot);
  lg.installLavaGuard(guarded, w.blockAt);
  const land = (m) => m.getNeighbors(new real.Move(0, 21, 0, 0, 0)).find((mv) => mv.x === 1 && mv.y === 18 && mv.z === 0);
  const a = land(plain); const b = land(guarded);
  assert.ok(a && b, 'la chute existe dans les deux cas (jamais rejetée : dernier recours)');
  assert.strictEqual(Math.round(b.cost - a.cost), lg.LAVA_STEP_PENALTY);
  // loin de la lave : aucune différence
  const far = (m) => m.getNeighbors(new real.Move(0, 21, -3, 0, 0)).find((mv) => mv.x === 1 && mv.y === 18 && mv.z === -3);
  assert.strictEqual(far(guarded).cost, far(plain).cost);
});

test('VRAIE Movements : descente verticale (getMoveDown) au bord de la lave pénalisée aussi', { skip: SKIP }, () => {
  const w = makeWorld();
  w.fill(-5, 0, -5, 5, 15, 5, 'stone');       // sol y=15
  w.fill(0, 16, 0, 0, 18, 0, 'air');          // puits : le bot à y=19 sur… rien, landing y=16
  w.fill(1, 16, 0, 1, 16, 0, 'lava');
  const bot = makeBot(w);
  const plain = new real.Movements(bot);
  const guarded = new real.Movements(bot);
  lg.installLavaGuard(guarded, w.blockAt);
  const down = (m) => m.getNeighbors(new real.Move(0, 19, 0, 0, 0)).find((mv) => mv.x === 0 && mv.z === 0 && mv.y < 19);
  const a = down(plain); const b = down(guarded);
  assert.ok(a && b);
  assert.strictEqual(Math.round(b.cost - a.cost), lg.LAVA_STEP_PENALTY);
});

// ─── Câblage (un test qui injecte ne prouve pas qu'on BRANCHE, pièges #61/#68b) ───────────────
const fs = require('node:fs');
const path = require('node:path');
const SRC = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');

test('index.js : garde-fou lave posé sur les 3 Movements (nominale, collectBlock, pvp)', () => {
  assert.match(SRC, /require\('\.\/lavaGuard'\)/);
  const at = SRC.indexOf("emit(Object.assign({ type: 'lava_guard_on' }, lavaOn));");
  assert.ok(at > 0, 'event lava_guard_on introuvable');
  const block = SRC.slice(at - 1400, at);
  assert.match(block, /installLavaGuard\(m, bridgeAt\)/);
  assert.match(block, /\['nominal', moves\]/);
  assert.ok(at < SRC.indexOf('bot.pathfinder.setMovements(moves);', at));
});

test('index.js : ramassage opportuniste — pas de dig d un minerai qui borde la lave', () => {
  const dig = SRC.indexOf('await withTimeout(bot.dig(blk), 12000');
  assert.ok(dig > 0);
  const before = SRC.slice(dig - 1500, dig);
  assert.match(before, /lavaAdjacent\(/);
  assert.match(before, /lavaAvoided\('ore_grab'/);
});

test('index.js : zigzag de la charge squelette gardé contre la lave/le feu', () => {
  const at = SRC.indexOf('zigzagSide(Date.now() - t0, 400)');
  assert.ok(at > 0);
  assert.match(SRC.slice(at, at + 900), /lateralHazard\(/);
});

test('index.js : la fuite creeper ouvre la fenêtre stricte', () => {
  const at = SRC.indexOf("_auraEmit('creeper_flee', { dist, fusing });");
  assert.ok(at > 0);
  assert.match(SRC.slice(at - 1200, at), /strictFor\(/);
});
