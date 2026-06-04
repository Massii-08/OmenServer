'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { branchMine, ORE_NAMES } = require('./branchMine');

function pos(x, y, z) { return { x, y, z, offset(dx, dy, dz) { return pos(x + dx, y + dy, z + dz); } }; }

// Fake bot : permet de placer des "ores" + lave + cobble dans le sac.
function makeBot({ y = -54, yaw = -Math.PI / 2, world = {}, inv = null, gathered = {} } = {}) {
  const inventory = inv || [
    { name: 'iron_pickaxe', count: 1, type: 'pickaxe' },
    { name: 'cobblestone', count: 32, type: 'block' },
  ];
  const calls = { dig: [], placeBlock: [], gather: [], goto: [] };
  const bot = {
    entity: { position: pos(0, y, 0), yaw },
    registry: { blocksByName: {
      stone: { id: 1 }, deepslate: { id: 2 },
      diamond_ore: { id: 56 }, deepslate_diamond_ore: { id: 57 },
      iron_ore: { id: 58 }, deepslate_iron_ore: { id: 59 },
      coal_ore: { id: 60 }, deepslate_coal_ore: { id: 61 },
      redstone_ore: { id: 62 }, deepslate_redstone_ore: { id: 63 },
      lapis_ore: { id: 64 }, deepslate_lapis_ore: { id: 65 },
      gold_ore: { id: 66 }, deepslate_gold_ore: { id: 67 },
      cobblestone: { id: 4 }, cobbled_deepslate: { id: 5 },
      lava: { id: 10 }, flowing_lava: { id: 11 },
      air: { id: 0 }, cave_air: { id: 0 },
    } },
    inventory: { items: () => inventory.slice() },
    blockAt(p) {
      const key = `${p.x},${p.y},${p.z}`;
      if (world[key]) return { name: world[key], position: p, boundingBox: world[key] === 'air' ? 'empty' : 'block' };
      // par défaut : deepslate partout (Y=-54 = deepslate IRL)
      return { name: 'deepslate', position: p, boundingBox: 'block' };
    },
    async dig(block) {
      calls.dig.push(block);
      const key = `${block.position.x},${block.position.y},${block.position.z}`;
      world[key] = 'air';
      // si c'était un ore, on simule l'ajout à l'inventaire (gather mocké via flag gathered)
    },
    async equip() {},
    async placeBlock(ref, face) {
      calls.placeBlock.push({ ref: ref.position, face });
      // simule : la case (ref + face) devient cobblestone
      const key = `${ref.position.x + face.x},${ref.position.y + face.y},${ref.position.z + face.z}`;
      world[key] = 'cobblestone';
      // consomme 1 cobble
      const cob = inventory.find((i) => i.name === 'cobblestone');
      if (cob) cob.count -= 1;
    },
    setControlState() {},
    async lookAt() {},
    async waitForTicks() {},
    nearestEntity() { return null; },                          // pas d'hostile
    pvp: { attack() {} },
    findBlock({ matching, maxDistance }) {
      // simule la détection de minerai : si un ore a été placé dans `world`, on le retourne.
      const ids = matching || [];
      for (const key of Object.keys(world)) {
        const name = world[key];
        const def = bot.registry.blocksByName[name];
        if (def && ids.includes(def.id)) {
          const [x, y, z] = key.split(',').map(Number);
          return { name, position: pos(x, y, z), boundingBox: 'block' };
        }
      }
      return null;
    },
    // Pathfinder mocké : déplace la position du bot vers la cible du goal (téléport synchrone).
    // Le vrai mineflayer-pathfinder marche jusqu'au goal ; ici on simule l'effet net pour que
    // les digs suivants soient logiquement "à portée" depuis la nouvelle position.
    pathfinder: {
      async goto(goal) {
        const tx = (goal && (goal.x !== undefined ? goal.x : (goal.target && goal.target.x)));
        const ty = (goal && (goal.y !== undefined ? goal.y : (goal.target && goal.target.y)));
        const tz = (goal && (goal.z !== undefined ? goal.z : (goal.target && goal.target.z)));
        if (typeof tx === 'number' && typeof ty === 'number' && typeof tz === 'number') {
          calls.goto.push({ x: tx, y: ty, z: tz });
          bot.entity.position = pos(tx, ty, tz);
        }
      },
    },
    collectBlock: {
      async collect(block) {
        // simule : on ajoute le drop à l'inventaire (raw item du nom du bloc)
        let drop = block.name;
        if (drop === 'diamond_ore' || drop === 'deepslate_diamond_ore') drop = 'diamond';
        if (drop === 'iron_ore' || drop === 'deepslate_iron_ore') drop = 'raw_iron';
        if (drop === 'coal_ore' || drop === 'deepslate_coal_ore') drop = 'coal';
        if (drop === 'redstone_ore' || drop === 'deepslate_redstone_ore') drop = 'redstone';
        if (drop === 'lapis_ore' || drop === 'deepslate_lapis_ore') drop = 'lapis_lazuli';
        if (drop === 'gold_ore' || drop === 'deepslate_gold_ore') drop = 'raw_gold';
        const existing = inventory.find((i) => i.name === drop);
        if (existing) existing.count += 1;
        else inventory.push({ name: drop, count: 1, type: 'item' });
        calls.gather.push(drop);
        // efface du monde
        const key = `${block.position.x},${block.position.y},${block.position.z}`;
        world[key] = 'air';
      },
    },
  };
  return { bot, calls, world, inventory };
}

test('branchMine : à Y=-54, deepslate plein -> termine sans erreur', async () => {
  const { bot } = makeBot({ y: -54 });
  const r = await branchMine(bot, { targetY: -54, mainLength: 6, branchSpacing: 3, branchLength: 4 });
  assert.strictEqual(r.ok, true);
});

test('branchMine : wrong_depth si Y=10 (loin de targetY)', async () => {
  const { bot } = makeBot({ y: 10 });
  const r = await branchMine(bot, { targetY: -54, mainLength: 6 });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'wrong_depth');
});

test('branchMine : token.cancelled stoppe net', async () => {
  const { bot } = makeBot({ y: -54 });
  const r = await branchMine(bot, { targetY: -54, mainLength: 100 }, { cancelled: true });
  assert.strictEqual(r.ok, true);
  assert.ok(r.cancelled);
});

test('branchMine : diamond_ore détecté en voisin -> gotDiamond:true', async () => {
  // Place un diamant juste sur le chemin du tunnel principal (yaw est = +x).
  const world = { '3,-54,0': 'deepslate_diamond_ore' };
  const { bot } = makeBot({ y: -54, world });
  const r = await branchMine(bot, { targetY: -54, mainLength: 10, branchSpacing: 3, branchLength: 4 });
  assert.strictEqual(r.gotDiamond, true);
  assert.ok(r.ores.diamond >= 1);
});

test('branchMine : lave devant -> mure avec cobble (placeBlock appelé)', async () => {
  const world = { '2,-54,0': 'lava' };
  const { bot, calls } = makeBot({ y: -54, world });
  await branchMine(bot, { targetY: -54, mainLength: 6, branchSpacing: 3, branchLength: 4 });
  assert.ok(calls.placeBlock.length > 0, 'should have placed cobble to wall lava');
});

test('branchMine : cobble<8 -> reason cobble_low', async () => {
  const { bot } = makeBot({ y: -54, inv: [
    { name: 'iron_pickaxe', count: 1, type: 'pickaxe' },
    { name: 'cobblestone', count: 5, type: 'block' },
  ] });
  const r = await branchMine(bot, { targetY: -54, mainLength: 6 });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'cobble_low');
});

test('branchMine : ramasse opportunément le fer voisin', async () => {
  const world = { '2,-54,0': 'deepslate_iron_ore' };
  const { bot } = makeBot({ y: -54, world });
  const r = await branchMine(bot, { targetY: -54, mainLength: 6, branchSpacing: 3, branchLength: 4 });
  assert.ok(r.ores.iron >= 1, `ores.iron=${r.ores.iron} should be >= 1`);
});

test('branchMine : Y dans la tolérance ±2 (Y=-52 OK)', async () => {
  const { bot } = makeBot({ y: -52 });
  const r = await branchMine(bot, { targetY: -54, mainLength: 4 });
  // ne doit PAS retourner wrong_depth
  assert.notStrictEqual(r.reason, 'wrong_depth');
});

test('branchMine : pathfinder.goto appelé entre les digs (bot avance vraiment)', async () => {
  // Garantit que le risque #5 (digs hors range) est mitigé : on doit voir au moins 1 goto par
  // pair (foot+head) du tunnel principal — avant le dig, on s'approche de la cible.
  const { bot, calls } = makeBot({ y: -54 });
  await branchMine(bot, { targetY: -54, mainLength: 6, branchSpacing: 999, branchLength: 0 });
  // mainLength=6 → 6 paliers → au moins 6 gotos pour le tunnel principal.
  assert.ok(calls.goto.length >= 6, `pathfinder.goto should be called per palier (got ${calls.goto.length})`);
});

// --- Extensions MARATHON (64× diamant/redstone/lapis/or) ---------------------------------------

test('marathon: ORE_NAMES couvre redstone/lapis/or (+ variantes deepslate)', () => {
  for (const n of ['redstone_ore', 'deepslate_redstone_ore', 'lapis_ore', 'deepslate_lapis_ore',
    'gold_ore', 'deepslate_gold_ore']) {
    assert.ok(ORE_NAMES.has(n), `${n} doit être dans ORE_NAMES`);
  }
});

test('marathon: réserve scaffold compte cobbled_deepslate (pas de cobble_low à tort)', async () => {
  const { bot } = makeBot({ y: -54, inv: [
    { name: 'iron_pickaxe', count: 1, type: 'pickaxe' },
    { name: 'cobbled_deepslate', count: 32, type: 'block' },
  ] });
  const r = await branchMine(bot, { targetY: -54, mainLength: 4, branchSpacing: 999, branchLength: 0 });
  assert.notStrictEqual(r.reason, 'cobble_low');
  assert.strictEqual(r.ok, true);
});

test('marathon: mure la lave avec cobbled_deepslate quand pas de cobblestone', async () => {
  const world = { '2,-54,0': 'lava' };
  const { bot, calls } = makeBot({ y: -54, world, inv: [
    { name: 'iron_pickaxe', count: 1, type: 'pickaxe' },
    { name: 'cobbled_deepslate', count: 32, type: 'block' },
  ] });
  await branchMine(bot, { targetY: -54, mainLength: 6, branchSpacing: 999, branchLength: 0 });
  assert.ok(calls.placeBlock.length > 0, 'doit murer la lave avec le deepslate cobble');
});

test('marathon: stopWhen custom stoppe le tunnel (ex: inventaire plein)', async () => {
  let probes = 0;
  const { bot, calls } = makeBot({ y: -54 });
  const r = await branchMine(bot, {
    targetY: -54, mainLength: 100, branchSpacing: 999, branchLength: 0,
    stopWhen: () => { probes++; return probes > 3; }, // s'arrête après 3 paliers
  });
  assert.strictEqual(r.ok, true);
  assert.ok(calls.goto.length <= 6, `tunnel court attendu (got ${calls.goto.length} gotos)`);
});

test('marathon: stopWhen défaut = 1 diamant (rétro-compat DIAMOND_CHAIN)', async () => {
  const { bot, calls } = makeBot({ y: -54, inv: [
    { name: 'iron_pickaxe', count: 1, type: 'pickaxe' },
    { name: 'cobblestone', count: 32, type: 'block' },
    { name: 'diamond', count: 1, type: 'item' },
  ] });
  await branchMine(bot, { targetY: -54, mainLength: 100, branchSpacing: 999, branchLength: 0 });
  assert.strictEqual(calls.goto.length, 0, 'diamant déjà en poche → ne mine pas');
});

test('marathon: lapis_ore sur le chemin → ramassé via gather (ores.lapis)', async () => {
  const world = { '2,-54,0': 'deepslate_lapis_ore' };
  const { bot } = makeBot({ y: -54, world });
  const r = await branchMine(bot, { targetY: -54, mainLength: 6, branchSpacing: 999, branchLength: 0,
    stopWhen: () => false });
  assert.ok(r.ores && r.ores.lapis >= 1, `ores.lapis=${r.ores && r.ores.lapis} attendu >= 1`);
});

test('marathon: redstone + or comptés dans le delta ores', async () => {
  const world = { '2,-54,0': 'deepslate_redstone_ore', '4,-54,0': 'deepslate_gold_ore' };
  const { bot } = makeBot({ y: -54, world });
  const r = await branchMine(bot, { targetY: -54, mainLength: 8, branchSpacing: 999, branchLength: 0,
    stopWhen: () => false });
  assert.ok(r.ores.redstone >= 1, `redstone=${r.ores.redstone}`);
  assert.ok(r.ores.gold >= 1, `gold=${r.ores.gold}`);
});

// --- Massii H : mode organique (zig-zag, branches peek, détour précieux) ---------------------------

test('H1: organic — zig-zag latéral ±2, direction générale tenue', async () => {
  const { bot, calls } = makeBot({ y: -54 });
  // rng force la dérive à CHAQUE palier (0.1 < 0.25 puis 0.9 → +1)
  const seq = [0.1, 0.9];
  let k = 0;
  await branchMine(bot, { targetY: -54, mainLength: 8, branchSpacing: 999, branchLength: 0,
    organic: true, rng: () => seq[(k++) % 2], stopWhen: () => false });
  // yaw -π/2 = +x → la latérale est sur z. Au moins un goto dévié en z, et x avance toujours.
  const zs = calls.goto.map((g) => g.z);
  assert.ok(zs.some((z) => z !== 0), `attendu une dérive latérale (zs=${zs.join(',')})`);
  const xs = calls.goto.map((g) => g.x);
  for (let i2 = 1; i2 < xs.length; i2++) assert.ok(xs[i2] >= xs[i2 - 1], 'x doit avancer (direction tenue)');
});

test('H2: branches peek — hauteur de tête SEULEMENT (économie outils), pas de pied cassé', async () => {
  const world = {};
  const { bot } = makeBot({ y: -54, world });
  await branchMine(bot, { targetY: -54, mainLength: 4, branchSpacing: 2, branchLength: 3,
    organic: true, branchStyle: 'peek', rng: () => 0.99, stopWhen: () => false });
  // les branches partent de x=2 (i=2, spacing 2) latéralement en z : pieds (y=-54) jamais creusés en branche
  const dugFeet = Object.keys(world).filter((key) => {
    const [x, y, z] = key.split(',').map(Number);
    return world[key] === 'air' && y === -54 && z !== 0; // hors tunnel principal (z=0)
  });
  assert.strictEqual(dugFeet.length, 0, `pieds de branche creusés: ${dugFeet.join(' | ')}`);
  const dugHeads = Object.keys(world).filter((key) => {
    const [x, y, z] = key.split(',').map(Number);
    return world[key] === 'air' && y === -53 && z !== 0;
  });
  assert.ok(dugHeads.length > 0, 'des trous d\'observation tête doivent exister');
});

test('H3: organic — détour vers un diamant ciblable hors du tunnel (jamais passer devant)', async () => {
  // diamant EXPOSÉ à 3 blocs latéralement du tunnel (z=3), pas sur le chemin
  const world = { '2,-54,3': 'deepslate_diamond_ore', '2,-54,4': 'air' };
  const { bot } = makeBot({ y: -54, world });
  const r = await branchMine(bot, { targetY: -54, mainLength: 6, branchSpacing: 999, branchLength: 0,
    organic: true, rng: () => 0.99, stopWhen: () => false });
  assert.ok(r.ores.diamond >= 1, `diamant à portée non ramassé (ores=${JSON.stringify(r.ores)})`);
});
