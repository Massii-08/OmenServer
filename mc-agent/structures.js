'use strict';
// Détection de structures (Phase 2). Pur/testable. Encode les 3 voies de la recherche « F3 pie-ray »
// côté bot (données pures, plus fiable que la triangulation visuelle humaine) + les parseurs /locate.
//   (1) /locate structure  → coords précises (si le bot est op) : parseurs purs ci-dessous.
//   (2) cluster d'entités  → le « pie-ray » du bot, sans permission ni id (donjon/bastion).
//   (3) spawner + blocs-signature → données pures via findBlock (1 spawner = 1 donjon).

// --- (1) /locate : parseurs purs (aucune permission requise pour parser) ---

/** Ids de structures depuis bot.tabComplete('/locate structure ') : strings OU {match}/{text}. */
function parseStructureIds(matches) {
  const out = [];
  for (const m of matches || []) {
    const s = typeof m === 'string' ? m : (m && (m.match || m.text));
    if (typeof s === 'string' && s.trim()) out.push(s.trim());
  }
  return out;
}

/** Réponse chat de /locate : "The nearest X is at [x, ~, z] (d blocks away)" → {x,z,dist} | null. */
function parseLocateResponse(text) {
  if (!text || typeof text !== 'string') return null;
  const m = text.match(/\[\s*(-?\d+)\s*,\s*(-?\d+|~)\s*,\s*(-?\d+)\s*\]/);  // [x, y|~, z]
  if (!m) return null;
  const dm = text.match(/\(\s*(\d+)\s*blocks?\s*away\s*\)/i);
  return { x: parseInt(m[1], 10), z: parseInt(m[3], 10), dist: dm ? parseInt(dm[1], 10) : null };
}

// --- (2) cluster d'entités hostiles (le « pie-ray » du bot) ---

const _HOSTILE_KINDS = new Set(['Hostile mobs', 'Monster']);
function isHostile(e) {
  if (!e) return false;
  if (e.kind && _HOSTILE_KINDS.has(e.kind)) return true;
  return e.type === 'hostile' || e.type === 'monster';
}

/** Cluster d'≥ minCount mobs hostiles dans `radius` autour du bot → {found,count,center} | {found:false}. */
function detectMobCluster(bot, { radius = 12, minCount = 4 } = {}) {
  const self = bot.entity && bot.entity.position;
  if (!self) return { found: false };
  const ents = Object.values(bot.entities || {}).filter(
    (e) => isHostile(e) && e.position && e.position.distanceTo && e.position.distanceTo(self) <= radius);
  if (ents.length < minCount) return { found: false };
  let sx = 0, sy = 0, sz = 0;
  for (const e of ents) { sx += e.position.x; sy += e.position.y; sz += e.position.z; }
  const n = ents.length;
  return { found: true, count: n, center: { x: sx / n, y: sy / n, z: sz / n } };
}

// --- (3) spawner + blocs-signature (findBlock, données pures) ---

function _blockIds(bot, names) {
  if (!bot.registry || !bot.registry.blocksByName) return null;
  const ids = names.map((n) => bot.registry.blocksByName[n]).filter(Boolean).map((d) => d.id);
  return ids.length ? ids : null;
}

/** Un spawner à portée = un donjon (équivalent direct de l'« ID stationnaire » du F3). */
function findSpawner(bot, { maxDistance = 48 } = {}) {
  const ids = _blockIds(bot, ['spawner', 'mob_spawner']);
  if (!ids) return { found: false };
  const b = bot.findBlock({ matching: ids, maxDistance });
  return b ? { found: true, type: 'dungeon', pos: b.position } : { found: false };
}

// Blocs-signature HIGH-SIGNAL uniquement (best-effort, datapack-agnostique). On évite stone_bricks/rail
// (trop communs → faux positifs). Le rating définitif d'une structure vient de /locate quand dispo.
const SIGNATURE = [
  { type: 'dungeon', blocks: ['mossy_cobblestone', 'infested_cobblestone'] },
  { type: 'fortress', blocks: ['nether_bricks', 'nether_brick'] },             // pertinent dans le Nether
  { type: 'ancient_city', blocks: ['reinforced_deepslate', 'sculk_catalyst'] }, // uniques à l'ancient city
];
function findSignature(bot, { maxDistance = 32 } = {}) {
  for (const sig of SIGNATURE) {
    const ids = _blockIds(bot, sig.blocks);
    if (!ids) continue;
    const b = bot.findBlock({ matching: ids, maxDistance });
    if (b) return { found: true, type: sig.type, block: b.name, pos: b.position };
  }
  return { found: false };
}

module.exports = {
  parseStructureIds, parseLocateResponse, isHostile, detectMobCluster, findSpawner, findSignature,
};
