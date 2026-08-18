'use strict';
// ALLER LÀ OÙ L'EAU EST — tests de la décision pure `nearestWater` (run world_mn15, 18/08).
//
// Mesure qui a motivé le module : `fish` appelé 737 fois → 0 poisson, dont `no_water` ×20 « purs »
// (les 705 autres étaient des `no_rod` en cascade). `fishCatch` ne cherche l'eau qu'à 24 blocs du
// chantier : quand le puits de mine est à 300 blocs de la rivière, la pêche n'existe pas — alors
// que les cartographes ONT cartographié cette rivière et que la carte du groupe le sait.
// `nearestWater` est le chaînon manquant : de la mémoire de monde vers un point où marcher.
const test = require('node:test');
const assert = require('node:assert');
const { nearestWater, WATER_TRIP_MAX, WATER_CELL, WATER_INSET } = require('./waterfind');

const W = 'overworld';
// Une mémoire de monde minimale, à la forme EXACTE que produit le backend
// (`mc_agent_world_memory.add_biome` : coords quantifiées sur la grille de 128, `name` + `id`).
const mem = (biomes) => ({ worlds: { [W]: { biomes } } });
const cell = (name, x, z) => ({ name, id: null, x, z, at: null });

test('aucune memoire / monde inconnu / carte vide -> null (jamais une exception)', () => {
  const pos = { x: 0, z: 0 };
  assert.strictEqual(nearestWater({ memory: null, worldKey: W, pos }), null);
  assert.strictEqual(nearestWater({ memory: mem([]), worldKey: W, pos }), null);
  assert.strictEqual(nearestWater({ memory: mem([cell('river', 0, 0)]), worldKey: 'nether', pos }), null);
  assert.strictEqual(nearestWater(), null);
  assert.strictEqual(nearestWater({}), null);
});

test('aucune cellule MOUILLEE -> null (une prairie n est pas un coin de peche)', () => {
  const m = mem([cell('plains', 128, 0), cell('forest', 256, 0), cell('desert', 0, 128)]);
  assert.strictEqual(nearestWater({ memory: m, worldKey: W, pos: { x: 0, z: 0 } }), null);
});

test('une riviere connue -> un point DANS la cellule, jamais son coin', () => {
  // Cellule quantifiee (256,0) = la boite [256,384[ x [0,128[. Le bot arrive de l ouest : le point
  // le plus proche du BORD serait (256,0) — pile sur l arete, ou l eau n est justement pas garantie
  // (le biome de la cellule vient d UN echantillon). On rentre donc de WATER_INSET blocs.
  const m = mem([cell('river', 256, 0)]);
  const r = nearestWater({ memory: m, worldKey: W, pos: { x: 0, z: 64 }, maxDist: 400 });
  assert.ok(r, 'une riviere a 256 blocs doit etre trouvee');
  assert.strictEqual(r.biome, 'river');
  assert.strictEqual(r.x, 256 + WATER_INSET);
  assert.ok(r.x > 256 && r.x < 384, 'le point vise est A L INTERIEUR de la cellule');
  assert.ok(r.z >= 0 + WATER_INSET && r.z <= 127 - WATER_INSET);
  assert.strictEqual(Math.round(r.dist), Math.round(Math.hypot(r.x - 0, r.z - 64)));
});

test('trop loin -> null (on ne traverse pas la carte pour un poisson)', () => {
  const m = mem([cell('ocean', 1024, 0)]);
  const pos = { x: 0, z: 0 };
  assert.strictEqual(nearestWater({ memory: m, worldKey: W, pos, maxDist: 250 }), null);
  assert.ok(nearestWater({ memory: m, worldKey: W, pos, maxDist: 2000 }), 'joignable si on autorise le trek');
});

test('le plafond par defaut est celui de la mission (250 blocs)', () => {
  assert.strictEqual(WATER_TRIP_MAX, 250);
  assert.strictEqual(WATER_CELL, 128);          // la grille du backend (add_biome / GRID)
  const m = mem([cell('river', 384, 0)]);       // bord a 384 -> point vise a 384+32 = 416 > 250
  assert.strictEqual(nearestWater({ memory: m, worldKey: W, pos: { x: 0, z: 32 } }), null);
});

test('plusieurs eaux -> la PLUS PROCHE gagne', () => {
  const m = mem([cell('ocean', 512, 0), cell('river', 128, 0), cell('frozen_ocean', -512, 0)]);
  const r = nearestWater({ memory: m, worldKey: W, pos: { x: 0, z: 64 }, maxDist: 1000 });
  assert.strictEqual(r.biome, 'river');
  assert.strictEqual(r.x, 128 + WATER_INSET);
});

test('egalite parfaite -> depart DETERMINISTE (lexicographique), jamais l ordre du tableau', () => {
  const a = mem([cell('river', 128, 0), cell('ocean', -256, 0)]);
  const b = mem([cell('ocean', -256, 0), cell('river', 128, 0)]);
  const pos = { x: 0, z: 64 };
  const ra = nearestWater({ memory: a, worldKey: W, pos, maxDist: 1000 });
  const rb = nearestWater({ memory: b, worldKey: W, pos, maxDist: 1000 });
  assert.deepStrictEqual([ra.x, ra.z, ra.biome], [rb.x, rb.z, rb.biome]);
});

test('le bot est DEJA dans la cellule d eau -> distance nulle (elargir la recherche suffit)', () => {
  // Cas reel : le chantier est dans une cellule « river » mais la riviere serpente a 40 blocs — la
  // recherche a 24 blocs de fishCatch ne la voit pas. Le voyage est alors un no-op et c est l appelant
  // qui gagne, en relancant la peche avec un rayon elargi.
  const m = mem([cell('river', 0, 0)]);
  const r = nearestWater({ memory: m, worldKey: W, pos: { x: 64, z: 64 } });
  assert.ok(r);
  assert.strictEqual(r.dist, 0);
  assert.strictEqual(r.x, 64);
  assert.strictEqual(r.z, 64);
});

test('coordonnees NON quantifiees (memoire ancienne / relue a la main) : on retrouve la cellule', () => {
  // add_biome quantifie, mais rien ne garantit qu une carte relue ne porte pas une position brute.
  // On refloore donc TOUJOURS sur la grille : idempotent sur une valeur deja quantifiee.
  const quant = nearestWater({ memory: mem([cell('river', 256, 0)]), worldKey: W, pos: { x: 0, z: 64 }, maxDist: 400 });
  const brut = nearestWater({ memory: mem([cell('river', 333, 77)]), worldKey: W, pos: { x: 0, z: 64 }, maxDist: 400 });
  assert.deepStrictEqual([brut.x, brut.z], [quant.x, quant.z]);
});

test('cellules illisibles ignorees, sans faire tomber les bonnes', () => {
  const m = mem([
    null,
    { name: 'river', x: NaN, z: 0 },
    { name: null, id: 42, x: 128, z: 0 },        // biome custom sans nom : on ne peut pas le dire mouille
    { name: 'ocean', x: '128', z: 0 },           // coord non numerique
    cell('river', 128, 128),                     // la seule exploitable
  ]);
  const r = nearestWater({ memory: m, worldKey: W, pos: { x: 0, z: 0 }, maxDist: 1000 });
  assert.ok(r);
  assert.strictEqual(r.biome, 'river');
  assert.strictEqual(r.x, 128 + WATER_INSET);
  assert.strictEqual(r.z, 128 + WATER_INSET);
});

test('position du bot inutilisable -> null (on ne calcule pas une distance depuis nulle part)', () => {
  const m = mem([cell('river', 128, 0)]);
  assert.strictEqual(nearestWater({ memory: m, worldKey: W, pos: null }), null);
  assert.strictEqual(nearestWater({ memory: m, worldKey: W, pos: { x: NaN, z: 0 } }), null);
  assert.strictEqual(nearestWater({ memory: m, worldKey: W }), null);
});

test('la definition de « mouille » est celle de zone.js — une seule source', () => {
  const { isWetBiome } = require('./zone');
  const pos = { x: 0, z: 64 };
  for (const name of ['river', 'frozen_river', 'ocean', 'deep_cold_ocean', 'lukewarm_ocean']) {
    assert.strictEqual(isWetBiome(name), true, name + ' doit etre mouille cote zone.js');
    assert.ok(nearestWater({ memory: mem([cell(name, 128, 0)]), worldKey: W, pos }), name + ' doit etre vise');
  }
  for (const name of ['plains', 'swamp', 'beach', 'forest']) {
    assert.strictEqual(isWetBiome(name), false, name + ' n est pas « mouille » cote zone.js');
    assert.strictEqual(nearestWater({ memory: mem([cell(name, 128, 0)]), worldKey: W, pos }), null);
  }
});

test('cellSize/inset surchargeables, et l inset ne peut jamais retourner la boite', () => {
  const m = mem([cell('river', 128, 0)]);
  const pos = { x: 0, z: 64 };
  // inset absurde (plus grand que la demi-cellule) -> on retombe sur le CENTRE, pas sur un point hors boite.
  const r = nearestWater({ memory: m, worldKey: W, pos, maxDist: 1000, inset: 9999 });
  assert.ok(r.x >= 128 && r.x <= 255, 'reste dans la cellule');
  assert.ok(r.z >= 0 && r.z <= 127, 'reste dans la cellule');
  const small = nearestWater({ memory: m, worldKey: W, pos, maxDist: 1000, cellSize: 16, inset: 0 });
  assert.strictEqual(small.x, 128);              // grille de 16 : la cellule commence pile a 128
});
