'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { branchMine, floodFillVein } = require('./branchMine');

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
      gold_ore: { id: 62 }, deepslate_gold_ore: { id: 63 },
      redstone_ore: { id: 64 }, deepslate_redstone_ore: { id: 65 },
      lapis_ore: { id: 66 }, deepslate_lapis_ore: { id: 67 },
      cobblestone: { id: 4 }, cobbled_deepslate: { id: 5 }, torch: { id: 12 },
      lava: { id: 10 }, flowing_lava: { id: 11 }, water: { id: 8 }, flowing_water: { id: 9 },
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
        if (drop === 'gold_ore' || drop === 'deepslate_gold_ore') drop = 'raw_gold';
        if (drop === 'redstone_ore' || drop === 'deepslate_redstone_ore') drop = 'redstone';
        if (drop === 'lapis_ore' || drop === 'deepslate_lapis_ore') drop = 'lapis_lazuli';
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

test('branchMine : eau voisine -> scelle avec cobble AVANT de miner (placeBlock appelé)', async () => {
  // Aquifère à profondeur diamant : sans scellement le tunnel se noie → boucle anti-noyade/warp
  // (vécu live ResBot1/3). On vérifie que la face d'eau est murée (placeBlock) comme pour la lave.
  const world = { '2,-54,0': 'water' };
  const { bot, calls } = makeBot({ y: -54, world });
  await branchMine(bot, { targetY: -54, mainLength: 6, branchSpacing: 3, branchLength: 4 });
  assert.ok(calls.placeBlock.length > 0, 'should have placed cobble to seal water');
});

test('branchMine : EAU DEVANT (case cible) -> TOURNE, ne creuse JAMAIS dans l eau (anti-noyade #1)', async () => {
  // BUG #1 Massii (live -53) : la case CIBLE est de l'eau (boundingBox 'empty' = prise pour de l'air)
  // → le bot y avançait → noyade → water_rescue → re-descente en boucle, 0 minage. Fix : water_ahead →
  // demi-tour vers le sec, on N'ENTRE PAS (survie prime, on sacrifie ce tunnel).
  const world = { '1,-54,0': 'water', '1,-53,0': 'water' };   // foot+tête du 1er pas (heading +x)
  const { bot, calls } = makeBot({ y: -54, world });
  await branchMine(bot, { targetY: -54, mainLength: 8, branchLength: 4, heading: { dx: 1, dz: 0 } });
  assert.ok(calls.dig.every((b) => !String(b.name || '').includes('water')),
    'ne doit JAMAIS creuser un bloc d eau (le bot a tourné vers le sec)');
  assert.ok(calls.dig.length > 0, 'doit continuer à miner ailleurs (serpentin sec), pas se figer');
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

// ── MODE SERPENTIN (BUG PRIO 3.1 Massii — minage profond diamant SANS grille) ──────────────
// PRNG déterministe (LCG) : la variabilité serpentine doit être reproductible pour le test.
function seededRng(seed) {
  let s = (seed >>> 0) || 1;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

test('branchMine serpentin : marche CONTINUE qui VIRE à intervalles VARIÉS (zéro branche en grille, anti-tell X-ray)', async () => {
  // Massii refuse le quadrillage régulier pour le diamant. Le mode serpentin doit creuser UNE
  // SEULE galerie ondulante (chaque pas = 1 bloc adjacent — pas de saut de branche), qui change de
  // direction à des intervalles IRRÉGULIERS (jamais métronomique).
  const { bot, calls } = makeBot({ y: -54 });
  await branchMine(bot, { targetY: -54, mainLength: 60, serpentine: true, rng: seededRng(7) });
  // Chemin = digs au niveau des pieds (y=-54), dans l'ordre de creusage.
  const foot = calls.dig.filter((b) => b.position.y === -54).map((b) => ({ x: b.position.x, z: b.position.z }));
  assert.ok(foot.length >= 20, `assez de blocs minés (${foot.length})`);
  // 1) CONTINUITÉ : marche adjacente. Pas = 1 bloc ; au plus 2 quand la galerie RECROISE une case
  //    déjà creusée (= air, non re-minée → un cran sauté dans la séquence des digs, légitime). Une
  //    GRILLE saute par branchLength (≥4, ici 9 : fin de branche → autre côté) ⇒ test KO pour la grille.
  let maxStep = 0;
  for (let i = 1; i < foot.length; i++) {
    maxStep = Math.max(maxStep, Math.abs(foot[i].x - foot[i - 1].x) + Math.abs(foot[i].z - foot[i - 1].z));
  }
  assert.ok(maxStep <= 2, `marche continue adjacente attendue (serpentin), maxStep=${maxStep} (grille = sauts ≥4)`);
  // 2) VIRE au moins 2 fois (ce n'est pas une ligne droite).
  const dirs = [];
  for (let i = 1; i < foot.length; i++) dirs.push(Math.sign(foot[i].x - foot[i - 1].x) + ',' + Math.sign(foot[i].z - foot[i - 1].z));
  const turnAt = [];
  for (let i = 1; i < dirs.length; i++) if (dirs[i] !== dirs[i - 1]) turnAt.push(i);
  assert.ok(turnAt.length >= 2, `le tunnel VIRE ≥2× (serpentin), got ${turnAt.length}`);
  // 3) Intervalles entre virages VARIÉS (irrégulier = pas un motif régulier/métronomique).
  const gaps = [];
  for (let i = 1; i < turnAt.length; i++) gaps.push(turnAt[i] - turnAt[i - 1]);
  assert.ok(new Set(gaps).size >= 2, `intervalles de virage VARIÉS attendus (irrégulier), gaps=${JSON.stringify(gaps)}`);
});

test('branchMine serpentin : ramasse le diamant croisé sur son chemin (le but du minage profond)', async () => {
  // Un diamant enterré pile sur la galerie serpentine doit être extrait (flood-fill veine).
  const world = { '1,-54,0': 'deepslate_diamond_ore' };
  const { bot } = makeBot({ y: -54, world });
  const r = await branchMine(bot, { targetY: -54, mainLength: 20, serpentine: true, rng: seededRng(3) });
  assert.ok(r.ores.diamond >= 1, `diamant ramassé attendu, ores.diamond=${r.ores.diamond}`);
});

test('branchMine : Y dans la tolérance ±2 (Y=-52 OK)', async () => {
  const { bot } = makeBot({ y: -52 });
  const r = await branchMine(bot, { targetY: -54, mainLength: 4 });
  // ne doit PAS retourner wrong_depth
  assert.notStrictEqual(r.reason, 'wrong_depth');
});

test('branchMine : bot PLUS PROFOND que la cible (Y=-61, targetY=-58) ne bail PAS wrong_depth', async () => {
  // Live 22/06 soir : descendDiagonal overshoot à -61 pour targetY -58 (Δ-3). index.js admet le bot
  // (fenêtre [targetY-6, targetY+2]) mais l'ancienne garde |Δ|≤2 le bail wrong_depth → relocate →
  // warp surface → re-descente en boucle, 0 lapis miné. Être plus profond = couche toujours minable.
  const { bot } = makeBot({ y: -61 });
  const r = await branchMine(bot, { targetY: -58, mainLength: 6, branchSpacing: 3, branchLength: 4 });
  assert.notStrictEqual(r.reason, 'wrong_depth');
});

test('branchMine : trop HAUT (Y=-52, targetY=-58) bail wrong_depth (mauvaise couche)', async () => {
  // Au-dessus de la cible de >2 = couche trop haute → bail (le bot doit redescendre, pas miner ici).
  const { bot } = makeBot({ y: -52 });
  const r = await branchMine(bot, { targetY: -58, mainLength: 6 });
  assert.strictEqual(r.reason, 'wrong_depth');
});

test('branchMine : pathfinder.goto appelé entre les digs (bot avance vraiment)', async () => {
  // Garantit que le risque #5 (digs hors range) est mitigé : on doit voir au moins 1 goto par
  // pair (foot+head) du tunnel principal — avant le dig, on s'approche de la cible.
  const { bot, calls } = makeBot({ y: -54 });
  await branchMine(bot, { targetY: -54, mainLength: 6, branchSpacing: 999, branchLength: 0 });
  // mainLength=6 → 6 paliers → au moins 6 gotos pour le tunnel principal.
  assert.ok(calls.goto.length >= 6, `pathfinder.goto should be called per palier (got ${calls.goto.length})`);
});

// ── PHASE 3 (vitesse + quota) ──────────────────────────────────────────────────────────────

test('branchMine : legacy sans stopOre — bail immédiat si diamant déjà en poche', async () => {
  const { bot, calls } = makeBot({ y: -54, inv: [
    { name: 'iron_pickaxe', count: 1, type: 'pickaxe' },
    { name: 'cobblestone', count: 32, type: 'block' },
    { name: 'diamond', count: 1, type: 'item' },
  ] });
  const r = await branchMine(bot, { targetY: -54, mainLength: 10 });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(calls.dig.length, 0, 'aucun dig : objectif DIAMOND_CHAIN déjà rempli');
});

test('branchMine : stopOre delta — mine MÊME avec des diamants déjà en poche (mode quota)', async () => {
  // Le bot PORTE 5 diamants (quota en cours). stopOre demande +2 : il doit creuser, pas bailer.
  const world = { '2,-54,0': 'deepslate_diamond_ore', '4,-54,0': 'deepslate_diamond_ore' };
  const { bot, calls } = makeBot({ y: -54, world, inv: [
    { name: 'iron_pickaxe', count: 1, type: 'pickaxe' },
    { name: 'cobblestone', count: 32, type: 'block' },
    { name: 'diamond', count: 5, type: 'item' },
  ] });
  const r = await branchMine(bot, { targetY: -54, mainLength: 10, branchSpacing: 999, branchLength: 0,
    stopOre: { items: ['diamond'], count: 2 } });
  assert.strictEqual(r.ok, true);
  assert.ok(calls.dig.length > 0 || calls.gather.length > 0, 'doit creuser malgré les diamants en poche');
  assert.ok(r.ores.diamond >= 2, `delta diamants ${r.ores.diamond} >= 2`);
});

test('branchMine : stopOre atteint → arrêt avant mainLength', async () => {
  // 1 diamant sur le chemin, stopOre count 1 → le tunnel s'arrête vite (pas 50 paliers).
  const world = { '2,-54,0': 'deepslate_diamond_ore' };
  const { bot, calls } = makeBot({ y: -54, world });
  await branchMine(bot, { targetY: -54, mainLength: 50, branchSpacing: 999, branchLength: 0,
    stopOre: { items: ['diamond'], count: 1 } });
  assert.ok(calls.goto.length < 10, `arrêt rapide une fois le quota delta atteint (gotos=${calls.goto.length})`);
});

test('branchMine : heading imposé prime sur le yaw', async () => {
  // yaw = est (+x) mais heading {dx:0,dz:1} → le tunnel doit aller vers +z.
  const { bot, calls } = makeBot({ y: -54, yaw: -Math.PI / 2 });
  await branchMine(bot, { targetY: -54, mainLength: 4, branchSpacing: 999, branchLength: 0,
    heading: { dx: 0, dz: 1 } });
  assert.ok(calls.goto.every((g) => g.x === 0), 'aucun déplacement en x');
  assert.ok(calls.goto.some((g) => g.z >= 3), 'progression en +z');
});

test('branchMine : retourne le heading utilisé (persistance entre calls)', async () => {
  const { bot } = makeBot({ y: -54, yaw: -Math.PI / 2 });
  const r = await branchMine(bot, { targetY: -54, mainLength: 2, branchSpacing: 999, branchLength: 0 });
  assert.deepStrictEqual(r.heading, { dx: 1, dz: 0 });
});

test('branchMine : roche nue minée via bot.dig direct (pas collectBlock)', async () => {
  const { bot, calls } = makeBot({ y: -54 });
  await branchMine(bot, { targetY: -54, mainLength: 4, branchSpacing: 999, branchLength: 0 });
  assert.ok(calls.dig.length > 0, 'la roche passe par bot.dig');
  assert.strictEqual(calls.gather.length, 0, 'collectBlock réservé aux ores');
});

test('branchMine : ramasse le redstone/lapis/or voisins (ORE_NAMES étendu)', async () => {
  const world = { '2,-54,0': 'deepslate_redstone_ore', '4,-54,0': 'deepslate_lapis_ore', '6,-54,0': 'deepslate_gold_ore' };
  const { bot, calls } = makeBot({ y: -54, world });
  await branchMine(bot, { targetY: -54, mainLength: 10, branchSpacing: 999, branchLength: 0 });
  assert.ok(calls.gather.includes('redstone'), 'redstone ramassé');
  assert.ok(calls.gather.includes('lapis_lazuli'), 'lapis ramassé');
  assert.ok(calls.gather.includes('raw_gold'), 'or ramassé');
});

test('branchMine : cobbled_deepslate compte comme réserve de murage (pas de cobble_low)', async () => {
  const { bot } = makeBot({ y: -54, inv: [
    { name: 'iron_pickaxe', count: 1, type: 'pickaxe' },
    { name: 'cobbled_deepslate', count: 32, type: 'block' },
  ] });
  const r = await branchMine(bot, { targetY: -54, mainLength: 4, branchSpacing: 999, branchLength: 0 });
  assert.strictEqual(r.ok, true);
  assert.notStrictEqual(r.reason, 'cobble_low');
});

test('branchMine : mure la lave avec cobbled_deepslate quand pas de cobblestone', async () => {
  const world = { '2,-54,0': 'lava' };
  const { bot, calls } = makeBot({ y: -54, world, inv: [
    { name: 'iron_pickaxe', count: 1, type: 'pickaxe' },
    { name: 'cobbled_deepslate', count: 32, type: 'block' },
  ] });
  await branchMine(bot, { targetY: -54, mainLength: 6, branchSpacing: 999, branchLength: 0 });
  assert.ok(calls.placeBlock.length > 0, 'murage avec cobbled_deepslate');
});

test('branchMine : torches posées dans le NOIR avec cadence jitterée (rng injecté)', async () => {
  const { bot, calls } = makeBot({ y: -54, inv: [
    { name: 'iron_pickaxe', count: 1, type: 'pickaxe' },
    { name: 'cobblestone', count: 32, type: 'block' },
    { name: 'torch', count: 8, type: 'block' },
  ] });
  // rng 0 → jitter nul → poses à i=4 et i=8 ; lumière inconnue (fake) = sombre → pose
  await branchMine(bot, { targetY: -54, mainLength: 9, branchSpacing: 999, branchLength: 0, torchEvery: 4, rng: () => 0 });
  const up = calls.placeBlock.filter((c) => c.face && c.face.y === 1);
  assert.ok(up.length >= 2, `au moins 2 torches posées (got ${up.length})`);
});

test('branchMine : endroit ÉCLAIRÉ → pas de torche (économie + naturel)', async () => {
  const { bot, calls } = makeBot({ y: -54, inv: [
    { name: 'iron_pickaxe', count: 1, type: 'pickaxe' },
    { name: 'cobblestone', count: 32, type: 'block' },
    { name: 'torch', count: 8, type: 'block' },
  ] });
  // toutes les cases lues rapportent une lumière 12 (déjà éclairé)
  const origBlockAt = bot.blockAt.bind(bot);
  bot.blockAt = (q) => { const b = origBlockAt(q); if (b) b.light = 12; return b; };
  await branchMine(bot, { targetY: -54, mainLength: 9, branchSpacing: 999, branchLength: 0, torchEvery: 4, rng: () => 0 });
  const up = calls.placeBlock.filter((c) => c.face && c.face.y === 1);
  assert.strictEqual(up.length, 0, 'aucune torche en zone éclairée');
});

test('branchMine : torchEvery sans torche en poche → continue sans bloquer', async () => {
  const { bot } = makeBot({ y: -54 });
  const r = await branchMine(bot, { targetY: -54, mainLength: 6, branchSpacing: 999, branchLength: 0, torchEvery: 2 });
  assert.strictEqual(r.ok, true);
});

// --- Phase 3 : anti-chute (sol manquant ponté) ---------------------------------------------------

test('branchMine : trou de grotte sous la prochaine case -> pont posé (placeBlock vers le bas)', async () => {
  // sous footTarget (2,-54,0) : (2,-55,0) ET (2,-56,0) air → gap de grotte
  const world = { '2,-55,0': 'air', '2,-56,0': 'air' };
  const { bot, calls } = makeBot({ y: -54, world });
  const r = await branchMine(bot, { targetY: -54, mainLength: 4, branchSpacing: 999, branchLength: 0 });
  assert.ok(calls.placeBlock.length >= 1, 'pont posé au-dessus du vide');
  assert.strictEqual(r.ok, true);
});

test('branchMine (Massii #5) : AUCUNE pioche → no_pickaxe, zéro dig à la main', async () => {
  const { bot, calls } = makeBot({ y: -54, inv: [
    { name: 'cobblestone', count: 32, type: 'block' },
  ] });
  const r = await branchMine(bot, { targetY: -54, mainLength: 4, branchSpacing: 999, branchLength: 0 });
  assert.strictEqual(calls.dig.length, 0, 'pas un seul bloc de roche creusé à la main');
  assert.strictEqual(r.ok, false);
});

// --- Hole E : bornage / détection de stall / hook de survie pendant le tunnel ----------------

test('branchMine aborts with reason stalled', async () => {
  // Le bot creuse (deepslate plein, cobble OK, Y=targetY) mais ne BOUGE jamais : on neutralise
  // le téléport du pathfinder mocké → bot.entity.position reste figé et aucun ore n'est ramassé.
  // L'horloge injectée AVANCE à chaque lecture → au bout de quelques itérations sans progrès,
  // now()-lastProgressAt dépasse stallMs → la boucle doit casser avec reason 'stalled'.
  const { bot } = makeBot({ y: -54 });
  bot.pathfinder.goto = async () => {};                  // n'avance PAS le bot (position figée)
  let t = 0;
  const now = () => { t += 4000; return t; };            // +4s par lecture (monotone)
  const r = await branchMine(bot, {
    targetY: -54, mainLength: 50, branchSpacing: 999, branchLength: 0,
    now, stallMs: 5000,
  });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'stalled');
});

test('branchMine survival hook fires every survivalEvery iters', async () => {
  const { bot } = makeBot({ y: -54 });
  const ticks = [];
  await branchMine(bot, {
    targetY: -54, mainLength: 8, branchSpacing: 999, branchLength: 0,
    survivalEvery: 2,
    onSurvivalTick: async (i) => { ticks.push(i); },
  });
  assert.ok(ticks.length > 0, `onSurvivalTick doit être appelé (got ${ticks.length})`);
});

test('approach is time-bounded', async () => {
  // goto ne se résout JAMAIS — sans bornage, branchMine resterait suspendu pour toujours.
  // Avec approachTimeoutMs=20, withTimeout doit relâcher et branchMine doit retourner.
  const { bot } = makeBot({ y: -54 });
  bot.pathfinder.goto = () => new Promise(() => {});      // jamais résolu
  const r = await branchMine(bot, {
    targetY: -54, mainLength: 3, branchSpacing: 999, branchLength: 0,
    approachTimeoutMs: 20,
  });
  assert.ok(r && typeof r.ok === 'boolean', 'branchMine doit retourner (pas de hang)');
});

test('branchMine : onSurvivalTick tourne AUSSI dans les branches latérales — bug review #4', async () => {
  // Le hook survie ne tournait QUE dans la boucle principale ; les for-j de branches (plusieurs min)
  // laissaient le bot sans défense. Vérifie qu'un tag 'branchN' apparaît (survie dans la branche).
  const { bot } = makeBot({ y: -54 });
  const ticks = [];
  await branchMine(bot, {
    targetY: -54, mainLength: 6, branchSpacing: 3, branchLength: 4,
    survivalEvery: 4, onSurvivalTick: (tag) => { ticks.push(tag); },
  });
  assert.ok(
    ticks.some((t) => typeof t === 'string' && t.startsWith('branch')),
    `survie appelée dans une branche latérale (ticks=${JSON.stringify(ticks)})`,
  );
});

test('floodFillVein : vide TOUTE la veine connectée FACE par face (§3.G minage humain), pas juste 1 bloc', async () => {
  // 6 deepslate_diamond connectés ORTHOGONALEMENT (chaque maillon partage une face) + 1 isolé NON connecté.
  const vein = ['0,-58,0', '1,-58,0', '1,-58,1', '1,-59,1', '2,-59,1', '2,-59,2'];
  const isolated = '10,-58,10';
  const all = new Set([...vein, isolated]);
  const mined = [];
  const k = (q) => `${Math.floor(q.x)},${Math.floor(q.y)},${Math.floor(q.z)}`;
  const bot = {
    blockAt(q) {
      return all.has(k(q))
        ? { name: 'deepslate_diamond_ore', position: { x: Math.floor(q.x), y: Math.floor(q.y), z: Math.floor(q.z) } }
        : { name: 'deepslate', boundingBox: 'block' };
    },
    collectBlock: { async collect(b) { all.delete(k(b.position)); mined.push(k(b.position)); } },
  };
  const n = await floodFillVein(bot, { x: 0, y: -58, z: 0 }, null);
  assert.strictEqual(n, 6, `mine les 6 blocs de la veine connectée (got ${n}, mined=${JSON.stringify(mined)})`);
  assert.ok(!mined.includes(isolated), 'le bloc isolé (non connecté) n\'est PAS miné (pas de X-ray global)');
  assert.ok(all.has(isolated), 'le bloc isolé reste en place');
});

test('floodFillVein : un ore connecté SEULEMENT en DIAGONALE n\'est PAS miné (bug #1 anti X-ray)', async () => {
  // Départ (0,-58,0) + un voisin de FACE (1,-58,0) + un ore relié uniquement par un COIN (2,-57,1 :
  // distance Manhattan ≥2 de tout bloc de la veine de face) → un humain ne peut pas le casser à travers
  // le coin → il doit être SACRIFIÉ (jamais miné).
  const face = ['0,-58,0', '1,-58,0'];
  const diagOnly = '2,-57,1';                       // seulement en diagonale du reste → occlus
  const all = new Set([...face, diagOnly]);
  const mined = [];
  const k = (q) => `${Math.floor(q.x)},${Math.floor(q.y)},${Math.floor(q.z)}`;
  const bot = {
    blockAt(q) {
      return all.has(k(q))
        ? { name: 'deepslate_diamond_ore', position: { x: Math.floor(q.x), y: Math.floor(q.y), z: Math.floor(q.z) } }
        : { name: 'deepslate', boundingBox: 'block' };
    },
    collectBlock: { async collect(b) { all.delete(k(b.position)); mined.push(k(b.position)); } },
  };
  const n = await floodFillVein(bot, { x: 0, y: -58, z: 0 }, null);
  assert.strictEqual(n, 2, `seuls les 2 blocs face-connectés sont minés (got ${n}, mined=${JSON.stringify(mined)})`);
  assert.ok(!mined.includes(diagOnly), 'le bloc diagonal-seul n\'est JAMAIS miné (anti X-ray à travers un coin)');
});

test('floodFillVein : bloc de départ non-ore → 0 (no-op)', async () => {
  const bot = { blockAt: () => ({ name: 'deepslate', boundingBox: 'block' }), collectBlock: { async collect() {} } };
  const n = await floodFillVein(bot, { x: 0, y: -58, z: 0 }, null);
  assert.strictEqual(n, 0);
});

// ── FIX n°2 WATER-WALL (run 2026-07-14) : scellement FRONTAL + sortie waterlocked ──────────
// L'évitement tactique seul (tourner) laissait la source couler dans la galerie dès qu'adjacente
// → inondation → water_rescue surface → churn de re-descente (vécu homedeath : smelt:0).

test('branchMine : EAU DEVANT (case cible) -> la SCELLE (cobble posé DANS la case) avant de continuer', async () => {
  const world = { '1,-54,0': 'water', '1,-53,0': 'water' };   // foot+tête du 1er pas (heading +x)
  const { bot, calls } = makeBot({ y: -54, world });
  await branchMine(bot, { targetY: -54, mainLength: 6, branchLength: 4, heading: { dx: 1, dz: 0 } });
  assert.strictEqual(world['1,-54,0'], 'cobblestone', 'case cible mouillée SCELLÉE (plus de source ouverte sur la galerie)');
  assert.ok(calls.dig.every((b) => !String(b.name || '').includes('water')), 'ne creuse jamais l eau');
});

test('branchMine serpentin : scellement IMPOSSIBLE + eau partout -> waterlocked (sortie rapide, pas de stall 30s)', async () => {
  // Aquifère verrouillant : toutes les directions mouillées ET pose de bloc impossible → l'ancien
  // comportement tournait en boucle jusqu'au stall (30s). On veut un échec RAPIDE et NOMMÉ pour
  // que l'appelant se décale (waterlocked_relocate).
  const { bot, calls } = makeBot({ y: -54 });
  const origBlockAt = bot.blockAt.bind(bot);
  bot.blockAt = (q) => {
    if ((q.y === -54 || q.y === -53) && !(q.x === 0 && q.z === 0)) {
      return { name: 'water', position: q, boundingBox: 'empty' };
    }
    return origBlockAt(q);
  };
  bot.placeBlock = async () => { throw new Error('no face'); };  // scellement impossible
  const r = await branchMine(bot, { targetY: -54, mainLength: 40, serpentine: true, rng: seededRng(5) });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'waterlocked');
  assert.ok(calls.dig.every((b) => !String(b.name || '').includes('water')), 'ne creuse jamais l eau');
});

test('branchMine classique : eau partout + scellement impossible -> waterlocked (le couloir n avance plus à l aveugle)', async () => {
  const { bot, calls } = makeBot({ y: -54 });
  const origBlockAt = bot.blockAt.bind(bot);
  bot.blockAt = (q) => {
    if ((q.y === -54 || q.y === -53) && !(q.x === 0 && q.z === 0)) {
      return { name: 'water', position: q, boundingBox: 'empty' };
    }
    return origBlockAt(q);
  };
  bot.placeBlock = async () => { throw new Error('no face'); };
  const r = await branchMine(bot, { targetY: -54, mainLength: 40, branchSpacing: 3, branchLength: 4, heading: { dx: 1, dz: 0 } });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'waterlocked');
  assert.ok(calls.dig.every((b) => !String(b.name || '').includes('water')), 'ne creuse jamais l eau');
});

test('branchMine classique : une BRANCHE qui rencontre l eau NON scellable s arrête là (pas d extension dans le lac)', async () => {
  // Branche latérale (+z à i=3) : à partir du 2e bloc de branche c'est un LAC et la pose de bloc
  // est impossible (pas de face) → la branche doit s'arrêter là, PAS continuer à creuser j=3,4
  // dans la nappe. (Si le scellement réussit, traverser la flaque scellée est OK — cas séparé.)
  const world = {
    '3,-54,2': 'water', '3,-53,2': 'water',
    '3,-54,3': 'water', '3,-53,3': 'water',
    '3,-54,4': 'water', '3,-53,4': 'water',
  };
  const { bot, calls } = makeBot({ y: -54, world });
  bot.placeBlock = async () => { throw new Error('no face'); };  // scellement impossible
  await branchMine(bot, { targetY: -54, mainLength: 6, branchSpacing: 3, branchLength: 4, heading: { dx: 1, dz: 0 } });
  const beyond = calls.dig.filter((b) => b.position.x === 3 && b.position.z >= 3);
  assert.strictEqual(beyond.length, 0, `la branche ne creuse PAS au-delà de l eau (dug: ${JSON.stringify(beyond.map((b)=>({x:b.position.x,z:b.position.z})))})`);
  assert.ok(calls.dig.every((b) => !String(b.name || '').includes('water')), 'ne creuse jamais l eau');
});

// ─── floodFillVein DOIT equiper la pioche (Massii, video live 26/07) ───────────────────────────
// « dans la video il essaye de le casser mais il n'arrive pas » : le bot frappait un diamant de
// deepslate avec un BOUCLIER en main. `collectBlock.collect` n'equipe RIEN (limite connue, deja
// corrigee pour la reprise de blocs mais jamais pour le minage de filons) → vitesse mains nues,
// et aucun drop meme si le bloc cede.
test('floodFillVein : equipe le meilleur outil AVANT de miner chaque bloc du filon', async () => {
  const equipped = [];
  const ore = { name: 'deepslate_diamond_ore', position: { x: 0, y: -54, z: 0 } };
  const bot = {
    registry: { blocksByName: { deepslate_diamond_ore: { id: 1 }, diamond_pickaxe: { id: 9 } } },
    inventory: { items: () => [{ name: 'iron_pickaxe', type: 7, count: 1 }] },
    heldItem: null,
    blockAt: (p) => ((p.x === 0 && p.y === -54 && p.z === 0) ? ore : null),
    equip: async (item) => { equipped.push(item && item.name); },
    collectBlock: { collect: async () => {} },
  };
  await floodFillVein(bot, { x: 0, y: -54, z: 0 });
  assert.ok(equipped.includes('iron_pickaxe'),
    `une pioche doit etre equipee avant le collect (equipes: ${JSON.stringify(equipped)})`);
});
