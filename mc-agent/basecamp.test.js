'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const {
  needsBase, baseHeading, headingForName, pickBaseSpot, spawnAction,
  MIN_BASE_DIST, BASE_DIST, BASE_MAX_DIST,
} = require('./basecamp');

const SPAWN = { x: 0, z: 0 };

// ─── needsBase ──────────────────────────────────────────────────────────────────────────────────

test('needsBase : aucune base enregistrée → oui', () => {
  assert.strictEqual(needsBase({ base: null, spawn: SPAWN }), true);
  assert.strictEqual(needsBase({ base: undefined, spawn: SPAWN }), true);
  assert.strictEqual(needsBase({ spawn: SPAWN }), true);
});

test('needsBase : base COLLÉE au spawn du monde → oui (c est le trou que ça corrige)', () => {
  // Une base posée là où le bot spawne ne sert à rien : les 3 bots + tous leurs respawns
  // s empilent au même endroit (bois rasé, boucle de mort). Elle doit être re-posée ailleurs.
  assert.strictEqual(needsBase({ base: { x: 0, z: 0 }, spawn: SPAWN }), true);
  assert.strictEqual(needsBase({ base: { x: 20, z: -20 }, spawn: SPAWN }), true);
});

test('needsBase : base assez loin du spawn → non', () => {
  assert.strictEqual(needsBase({ base: { x: 120, z: 0 }, spawn: SPAWN }), false);
  assert.strictEqual(needsBase({ base: { x: 0, z: -MIN_BASE_DIST - 1 }, spawn: SPAWN }), false);
});

test('needsBase : le seuil est exactement MIN_BASE_DIST (frontière incluse = trop près)', () => {
  assert.strictEqual(needsBase({ base: { x: MIN_BASE_DIST, z: 0 }, spawn: SPAWN }), false);
  assert.strictEqual(needsBase({ base: { x: MIN_BASE_DIST - 1, z: 0 }, spawn: SPAWN }), true);
});

test('needsBase : spawn du monde inconnu → on garde la base connue (pas de re-marche inutile)', () => {
  assert.strictEqual(needsBase({ base: { x: 5, z: 5 }, spawn: null }), false);
});

test('needsBase : minDist surchargeable', () => {
  assert.strictEqual(needsBase({ base: { x: 80, z: 0 }, spawn: SPAWN, minDist: 200 }), true);
});

// ─── baseHeading ────────────────────────────────────────────────────────────────────────────────

test('baseHeading : éventail déterministe, un cap DIFFÉRENT par bot', () => {
  const caps = [0, 1, 2].map((i) => baseHeading(i, 3));
  assert.strictEqual(new Set(caps).size, 3, 'les 3 bots ne doivent pas partir dans le même cap');
  // reproductible : même entrée → même sortie (pas de Math.random, cf. bots relancés par le self-healing)
  assert.strictEqual(baseHeading(1, 3), caps[1]);
});

test('baseHeading : caps régulièrement répartis sur le tour complet', () => {
  const d = baseHeading(1, 3) - baseHeading(0, 3);
  assert.ok(Math.abs(d - (2 * Math.PI) / 3) < 1e-9, 'écart = 2π/3 pour 3 bots');
});

test('baseHeading : count absent/0/1 ne divise pas par zéro', () => {
  assert.ok(Number.isFinite(baseHeading(0, 0)));
  assert.ok(Number.isFinite(baseHeading(0, 1)));
  assert.ok(Number.isFinite(baseHeading(2)));
});

// ─── headingForName ─────────────────────────────────────────────────────────────────────────────

test('headingForName : les 3 ouvriers RÉELS partent dans 3 caps bien séparés', () => {
  // Régression : un simple hash FNV des noms donnait 237,5° / 241,7° / 240,3° pour NethBot1/2/3
  // (ils ne diffèrent que par le dernier caractère) → les 3 bots posaient leur base à ~9 blocs
  // l'un de l'autre, ce qui annule tout l'intérêt de l'éventail.
  const caps = ['NethBot1', 'NethBot2', 'NethBot3'].map((n) => headingForName(n, 3));
  assert.strictEqual(new Set(caps).size, 3);
  for (let i = 0; i < caps.length; i++) {
    for (let j = i + 1; j < caps.length; j++) {
      let d = Math.abs(caps[i] - caps[j]) % (2 * Math.PI);
      if (d > Math.PI) d = 2 * Math.PI - d;
      assert.ok(d > 1.0, `caps ${i}/${j} trop proches (${(d * 180 / Math.PI).toFixed(1)}°)`);
    }
  }
});

test('headingForName : déterministe (le self-healing relance le bot → même cap)', () => {
  assert.strictEqual(headingForName('NethBot2', 3), headingForName('NethBot2', 3));
});

test('headingForName : nom sans indice → cap quand même défini et fini', () => {
  assert.ok(Number.isFinite(headingForName('Bob', 3)));
  assert.ok(Number.isFinite(headingForName('', 3)));
  assert.ok(Number.isFinite(headingForName(null, 3)));
});

test('headingForName : l indice du nom pilote le cap (bot1 → premier secteur)', () => {
  assert.strictEqual(headingForName('NethBot1', 3), baseHeading(0, 3));
  assert.strictEqual(headingForName('NethBot2', 3), baseHeading(1, 3));
  assert.strictEqual(headingForName('NethBot3', 3), baseHeading(2, 3));
});

test('headingForName : indice au-delà du compte → replié (pas de cap hors éventail)', () => {
  assert.strictEqual(headingForName('NethBot4', 3), baseHeading(0, 3));
});

// ─── pickBaseSpot ───────────────────────────────────────────────────────────────────────────────

test('pickBaseSpot : sans carte → point brut sur le cap, à BASE_DIST du spawn', () => {
  const s = pickBaseSpot({ spawn: SPAWN, index: 0, count: 3 });
  assert.strictEqual(s.source, 'heading');
  const d = Math.hypot(s.x - SPAWN.x, s.z - SPAWN.z);
  assert.ok(Math.abs(d - BASE_DIST) < 1, `distance ${d} attendue ~${BASE_DIST}`);
  assert.ok(Number.isInteger(s.x) && Number.isInteger(s.z), 'coordonnées entières (goto)');
});

test('pickBaseSpot : préfère une cellule BOISÉE connue dans la fenêtre de distance', () => {
  const biomes = [
    { name: 'forest', x: 130, z: 0 },
    { name: 'plains', x: 120, z: 0 },     // pas boisé → ignoré
  ];
  const s = pickBaseSpot({ spawn: SPAWN, index: 0, count: 1, biomes });
  assert.strictEqual(s.source, 'wooded');
  assert.strictEqual(s.biome, 'forest');
  assert.strictEqual(s.x, 130);
});

test('pickBaseSpot : ignore les forêts TROP PRÈS du spawn et TROP LOIN', () => {
  const biomes = [
    { name: 'forest', x: 10, z: 0 },                    // trop près (zone d empilement)
    { name: 'taiga', x: BASE_MAX_DIST + 200, z: 0 },    // trop loin (marche mortelle)
  ];
  const s = pickBaseSpot({ spawn: SPAWN, index: 0, count: 1, biomes });
  assert.strictEqual(s.source, 'heading', 'aucune forêt utilisable → repli sur le cap');
});

test('pickBaseSpot : deux bots choisissent des forêts DIFFÉRENTES (éventail)', () => {
  const biomes = [
    { name: 'forest', x: 120, z: 0 },       // est
    { name: 'birch_forest', x: -120, z: 0 }, // ouest
    { name: 'taiga', x: 0, z: 120 },         // sud
  ];
  const a = pickBaseSpot({ spawn: SPAWN, index: 0, count: 3, biomes });
  const b = pickBaseSpot({ spawn: SPAWN, index: 1, count: 3, biomes });
  const c = pickBaseSpot({ spawn: SPAWN, index: 2, count: 3, biomes });
  assert.strictEqual(a.source, 'wooded');
  const keys = new Set([`${a.x},${a.z}`, `${b.x},${b.z}`, `${c.x},${c.z}`]);
  assert.strictEqual(keys.size, 3, 'les 3 bots ne doivent pas viser la MÊME forêt');
});

test('pickBaseSpot : à cap égal, la forêt la plus proche gagne', () => {
  const biomes = [
    { name: 'forest', x: 240, z: 0 },
    { name: 'forest', x: 120, z: 0 },
  ];
  const s = pickBaseSpot({ spawn: SPAWN, index: 0, count: 1, biomes, heading: 0 });
  assert.strictEqual(s.x, 120);
});

test('pickBaseSpot : saute les cellules ÉPUISÉES (déjà rasées par un run précédent)', () => {
  const biomes = [{ name: 'forest', x: 120, z: 0 }, { name: 'forest', x: 0, z: 130 }];
  const s = pickBaseSpot({
    spawn: SPAWN, index: 0, count: 1, biomes, heading: 0,
    depleted: [{ x: 120, z: 0 }],
  });
  assert.notStrictEqual(`${s.x},${s.z}`, '120,0');
});

test('pickBaseSpot : spawn absent → repli sur (0,0), jamais de NaN', () => {
  const s = pickBaseSpot({ index: 0, count: 3 });
  assert.ok(Number.isFinite(s.x) && Number.isFinite(s.z));
});

test('pickBaseSpot : heading explicite respecté (cap imposé par le caller)', () => {
  const s = pickBaseSpot({ spawn: SPAWN, index: 0, count: 3, heading: 0 });
  assert.strictEqual(s.z, 0);
  assert.ok(s.x > 0);
});

// ─── spawnAction ────────────────────────────────────────────────────────────────────────────────

test('spawnAction : pas de base → establish', () => {
  assert.strictEqual(spawnAction({ base: null, pos: { x: 0, z: 0 }, spawn: SPAWN }), 'establish');
});

test('spawnAction : base connue mais bot relâché au spawn du monde → return', () => {
  const base = { x: 150, z: 0 };
  assert.strictEqual(spawnAction({ base, pos: { x: 2, z: 1 }, spawn: SPAWN }), 'return');
});

test('spawnAction : bot déjà chez lui → stay', () => {
  const base = { x: 150, z: 0 };
  assert.strictEqual(spawnAction({ base, pos: { x: 152, z: 3 }, spawn: SPAWN }), 'stay');
});

test('spawnAction : base collée au spawn du monde → establish (on la re-pose ailleurs)', () => {
  assert.strictEqual(
    spawnAction({ base: { x: 5, z: 5 }, pos: { x: 5, z: 5 }, spawn: SPAWN }),
    'establish',
  );
});

test('spawnAction : homeRadius surchargeable', () => {
  const base = { x: 150, z: 0 };
  assert.strictEqual(spawnAction({ base, pos: { x: 190, z: 0 }, spawn: SPAWN, homeRadius: 64 }), 'stay');
  assert.strictEqual(spawnAction({ base, pos: { x: 190, z: 0 }, spawn: SPAWN, homeRadius: 16 }), 'return');
});

test('spawnAction : position inconnue → on ne décide rien de risqué (stay)', () => {
  assert.strictEqual(spawnAction({ base: { x: 150, z: 0 }, pos: null, spawn: SPAWN }), 'stay');
});
