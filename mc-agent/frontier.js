'use strict';
// Exploration par FRONTIÈRE (phase 2) : la cellule de grille NON couverte la plus proche du bot.
// Remplit les vides de la carte au lieu de longues lignes/cercles (la marche aléatoire de la
// phase 1 couvrait en BANDES avec de gros trous). Pur/testable.
//
// « Couverte » = cellule présente dans memory.worlds[w].biomes (quantifiées grille 128 côté
// backend) OU dans le Set localSeen du bot (cellules visitées pas encore re-lues du fichier).

const GRID = 128;

function cellKey(x, z, grid = GRID) {
  return Math.floor(x / grid) * grid + ',' + Math.floor(z / grid) * grid;
}

/** Set des cellules couvertes : biomes du monde + localSeen (+ cellules océan = couvertes). */
function coveredCells(memory, worldKey, localSeen, grid = GRID) {
  const out = new Set(localSeen || []);
  const w = memory && memory.worlds && memory.worlds[worldKey];
  for (const b of (w && w.biomes) || []) {
    out.add(cellKey(b.x, b.z, grid));
  }
  return out;
}

/**
 * Prochaine cellule NON couverte la plus proche de `from` (spirale par anneaux de cellules).
 * opts = { grid, maxRing (défaut 14 ≈ 1,8 km), skip: Set de cellKeys à éviter (échecs/eau) }.
 * → { key, center: {x, z}, ring } | null si tout est couvert dans le rayon.
 */
function nextFrontierCell(memory, worldKey, localSeen, from, opts = {}) {
  const grid = opts.grid || GRID;
  const maxRing = opts.maxRing != null ? opts.maxRing : 14;
  const skip = opts.skip || null;
  if (!from) return null;
  const covered = coveredCells(memory, worldKey, localSeen, grid);
  const cx = Math.floor(from.x / grid);
  const cz = Math.floor(from.z / grid);

  for (let ring = 0; ring <= maxRing; ring++) {
    let best = null, bestD = Infinity;
    // périmètre de l'anneau (ring 0 = la cellule du bot elle-même)
    for (let dx = -ring; dx <= ring; dx++) {
      for (let dz = -ring; dz <= ring; dz++) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== ring) continue;   // périmètre only
        const gx = (cx + dx) * grid, gz = (cz + dz) * grid;
        const key = gx + ',' + gz;
        if (covered.has(key)) continue;
        if (skip && skip.has(key)) continue;
        const center = { x: gx + grid / 2, z: gz + grid / 2 };
        const d = (center.x - from.x) ** 2 + (center.z - from.z) ** 2;
        if (d < bestD) { bestD = d; best = { key, center, ring }; }
      }
    }
    if (best) return best;       // l'anneau le plus proche gagne ; à anneau égal, la + proche
  }
  return null;
}

/**
 * Prochaine cellule NON couverte la plus proche de `from` qui est de la TERRE, dans un rayon
 * BORNÉ (pas de ciblage à l'aveugle des cases lointaines). opts = { grid, maxRing (défaut 4 ≈
 * 512 blocs), skip: Set, isOcean: (gx,gz)=>bool }. → { key, center, ring } | null si aucune terre
 * locale (→ le mapper passe en traversée bateau).
 */
function nextLandLeg(memory, worldKey, localSeen, from, opts = {}) {
  const grid = opts.grid || GRID;
  const maxRing = opts.maxRing != null ? opts.maxRing : 4;
  const skip = opts.skip || null;
  const isOcean = opts.isOcean || (() => false);
  if (!from) return null;
  const covered = coveredCells(memory, worldKey, localSeen, grid);
  const cx = Math.floor(from.x / grid);
  const cz = Math.floor(from.z / grid);
  for (let ring = 0; ring <= maxRing; ring++) {
    let best = null, bestD = Infinity;
    for (let dx = -ring; dx <= ring; dx++) {
      for (let dz = -ring; dz <= ring; dz++) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== ring) continue;
        const gx = (cx + dx) * grid, gz = (cz + dz) * grid;
        const key = gx + ',' + gz;
        if (covered.has(key)) continue;
        if (skip && skip.has(key)) continue;
        if (isOcean(gx, gz)) continue;                 // terre-only
        const center = { x: gx + grid / 2, z: gz + grid / 2 };
        const d = (center.x - from.x) ** 2 + (center.z - from.z) ** 2;
        if (d < bestD) { bestD = d; best = { key, center, ring }; }
      }
    }
    if (best) return best;
  }
  return null;
}

module.exports = { GRID, cellKey, coveredCells, nextFrontierCell, nextLandLeg };
