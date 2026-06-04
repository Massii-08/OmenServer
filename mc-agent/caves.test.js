'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { detectCaveEntrance } = require('./caves');

// Fake bot : colonne y→nom de bloc (défaut 'stone'). blockAt lit p.y (Vec3 réel ou POJO).
function makeBot(column) {
  return {
    blockAt(p) {
      const name = column[p.y] !== undefined ? column[p.y] : 'stone';
      return { name, boundingBox: (name === 'air' || name === 'cave_air') ? 'empty' : 'block' };
    },
  };
}

const FEET = { x: 100.5, y: 64, z: -20.5 };

test('entrée de grotte : colonne d\'air ≥ minDepth sous les pieds → found', () => {
  // y 63..58 = air (6 blocs) sous les pieds (y64)
  const col = { 63: 'air', 62: 'air', 61: 'air', 60: 'air', 59: 'air', 58: 'air' };
  const r = detectCaveEntrance(makeBot(col), FEET, { minDepth: 4 });
  assert.strictEqual(r.found, true);
  assert.deepStrictEqual(r.pos, { x: 100, y: 63, z: -21 }); // haut de l'ouverture, coords floored (floor(-20.5)=-21)
});

test('sol plein → pas d\'entrée', () => {
  assert.strictEqual(detectCaveEntrance(makeBot({}), FEET, { minDepth: 4 }).found, false); // tout stone
});

test('ouverture trop peu profonde → pas d\'entrée', () => {
  const col = { 63: 'air', 62: 'air', 61: 'stone' }; // 2 air seulement
  assert.strictEqual(detectCaveEntrance(makeBot(col), FEET, { minDepth: 4 }).found, false);
});

test('puits de lave/eau → pas une entrée de grotte (la colonne est coupée)', () => {
  const col = { 63: 'air', 62: 'lava', 61: 'air', 60: 'air' }; // air-lava-air → runs max = 2 < 4
  assert.strictEqual(detectCaveEntrance(makeBot(col), FEET, { minDepth: 4 }).found, false);
});

test('blocs non chargés (null) ne comptent pas comme ouverture', () => {
  const bot = { blockAt: () => null };
  assert.strictEqual(detectCaveEntrance(bot, FEET, { minDepth: 4 }).found, false);
});

// ---------------------------------------------------------------------------
// findCaveEntranceNear — heuristique ÉLARGIE (retour live Massii : « cave_found
// n'a jamais fire en jeu » — le scan sous-les-pieds seul ne suffit pas, le
// pathfinder ÉVITE de marcher au-dessus des trous). Scan d'un VOISINAGE :
// trou sous une lèvre (colonne d'air ≥4 sous le plan du sol, murée) +
// ouverture à flanc de colline (tunnel 2-haut toituré qui pénètre le terrain).
// ---------------------------------------------------------------------------
const { findCaveEntranceNear } = require('./caves');

// Fake bot terrain 3D : fn(x,y,z) → nom de bloc ('air'/'stone'/'water'/null=non chargé).
function makeTerrainBot(fn) {
  return {
    blockAt(p) {
      const name = fn(p.x, p.y, p.z);
      if (name === null) return null;
      return { name, boundingBox: (name === 'air' || name === 'cave_air') ? 'empty' : 'block' };
    },
  };
}
// Sol plat : solide sous y64 (le bot a les pieds en y64, sol = y63).
const flat = (x, y, z) => (y < 64 ? 'stone' : 'air');

test('near: sol plat partout → rien', () => {
  const r = findCaveEntranceNear(makeTerrainBot(flat), FEET, { minDepth: 4, radius: 8, step: 2 });
  assert.strictEqual(r.found, false);
});

test('near: trou muré à 4 blocs (colonne d\'air ≥4 sous le plan, lèvre solide) → found', () => {
  // Trou 1×1 en (104, -21) : air de y63 à y58 (le reste = sol plat → murs solides autour).
  const world = (x, y, z) => (x === 104 && z === -21 && y <= 63 && y >= 58 ? 'air' : flat(x, y, z));
  const r = findCaveEntranceNear(makeTerrainBot(world), FEET, { minDepth: 4, radius: 8, step: 2 });
  assert.strictEqual(r.found, true);
  assert.deepStrictEqual(r.pos, { x: 104, y: 63, z: -21 });
});

test('near: pente douce (l\'air descend mais AUCUNE lèvre murée) → rien', () => {
  // Surface qui descend de 1 bloc tous les 2 blocs vers +x : à dx=8 l'air va sous le plan
  // du bot mais les voisins au sommet sont de l'air aussi (pas un trou) → rejet par la lèvre.
  const slope = (x, y, z) => (y < 64 - Math.max(0, Math.floor((x - 100) / 2)) ? 'stone' : 'air');
  const r = findCaveEntranceNear(makeTerrainBot(slope), FEET, { minDepth: 4, radius: 8, step: 2 });
  assert.strictEqual(r.found, false);
});

test('near: falaise franche (paroi ouverte, pas un trou) → rien', () => {
  // Pour x ≥ 104 le sol tombe à y53 : à (104,63) un seul voisin solide (la paroi x=103) → rejet.
  const cliff = (x, y, z) => (y < (x >= 104 ? 54 : 64) ? 'stone' : 'air');
  const r = findCaveEntranceNear(makeTerrainBot(cliff), FEET, { minDepth: 4, radius: 8, step: 2 });
  assert.strictEqual(r.found, false);
});

test('near: bouche de tunnel à flanc de colline (2-haut, toit solide, pénètre ≥2) → found', () => {
  // Colline pleine pour x ≥ 103 (jusqu'à y69) ; tunnel 2-haut creusé en z=-21 : air y64-65 pour x 103..106.
  const world = (x, y, z) => {
    if (x >= 103 && z === -21 && x <= 106 && (y === 64 || y === 65)) return 'air';
    if (x >= 103 && y <= 69) return 'stone';
    return flat(x, y, z);
  };
  const r = findCaveEntranceNear(makeTerrainBot(world), FEET, { minDepth: 4, radius: 8, step: 2 });
  assert.strictEqual(r.found, true);
  assert.strictEqual(r.pos.x, 103);
  assert.strictEqual(r.pos.y, 64);
  assert.strictEqual(r.pos.z, -21);
});

test('near: alcôve d\'1 bloc dans la colline (ne pénètre pas) → rien', () => {
  const world = (x, y, z) => {
    if (x === 103 && z === -21 && (y === 64 || y === 65)) return 'air'; // 1 seul bloc de profondeur
    if (x >= 103 && y <= 69) return 'stone';
    return flat(x, y, z);
  };
  const r = findCaveEntranceNear(makeTerrainBot(world), FEET, { minDepth: 4, radius: 8, step: 2 });
  assert.strictEqual(r.found, false);
});

test('near: trou noyé (eau) → rien (l\'eau n\'est pas une ouverture)', () => {
  const world = (x, y, z) => (x === 104 && z === -21 && y <= 63 && y >= 58 ? 'water' : flat(x, y, z));
  const r = findCaveEntranceNear(makeTerrainBot(world), FEET, { minDepth: 4, radius: 8, step: 2 });
  assert.strictEqual(r.found, false);
});

test('near: délègue le sous-les-pieds (compat detectCaveEntrance)', () => {
  // Colonne d'air directement sous le bot (x=100,z=-21) : y63..58.
  const world = (x, y, z) => (x === 100 && z === -21 && y <= 63 && y >= 58 ? 'air' : flat(x, y, z));
  const r = findCaveEntranceNear(makeTerrainBot(world), FEET, { minDepth: 4, radius: 8, step: 2 });
  assert.strictEqual(r.found, true);
  assert.deepStrictEqual(r.pos, { x: 100, y: 63, z: -21 });
});

test('near: chunks non chargés (null partout) → rien, pas de crash', () => {
  const r = findCaveEntranceNear(makeTerrainBot(() => null), FEET, { minDepth: 4, radius: 8, step: 2 });
  assert.strictEqual(r.found, false);
});
