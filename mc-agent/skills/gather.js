'use strict';
// `take <bloc> [n]` : récolte n× le bloc le + proche avec le meilleur outil, en se défendant.
const { bestToolFor, bestWeapon } = require('../tools');
const { explore } = require('./explore');
const { materialFoundEvent, resolveBiome } = require('../worldMemory');

function _ids(bot, name) {
  if (!bot.registry || !bot.registry.blocksByName) return null;
  if (Array.isArray(name)) {
    const ids = name
      .map((n) => bot.registry.blocksByName[n])
      .filter(Boolean)
      .map((def) => def.id);
    return ids.length > 0 ? ids : null;
  }
  const def = bot.registry.blocksByName[name];
  return def ? [def.id] : null;
}

/** Mob hostile à portée (≤ radius) du bot, ou null. */
function nearbyHostile(bot, radius = 4) {
  const self = bot.entity && bot.entity.position;
  if (!self) return null;
  return bot.nearestEntity((e) => {
    if (!e || e.type !== 'mob' || e.kind !== 'Hostile mobs' || !e.position) return false;
    const d = e.position.distanceTo ? e.position.distanceTo(self) : 999;
    return d <= radius;
  });
}

/** Si un hostile est proche : équipe la meilleure arme et l'attaque. true si défense engagée. */
async function defendIfNeeded(bot) {
  const foe = nearbyHostile(bot);
  if (!foe) return false;
  const w = bestWeapon(bot);
  if (w) { try { await bot.equip(w, 'hand'); } catch (e) {} }
  try { bot.pvp.attack(foe); } catch (e) {}
  return true;
}

/** Récolte `count`× le bloc `name` le + proche. {ok, reason?/got}. `token` = annulation. */
// --- Anti-détection ore (retour Massii A) ---------------------------------------------------------
// JAMAIS de beeline vers un ore CACHÉ : findBlock voit à travers la roche (x-ray de fait) → tell n°1
// d'un bot + flag des plugins de détection statistique. On ne cible un ORE que s'il est EXPOSÉ
// (≥1 face air/non-solide — ce qu'un joueur pourrait voir). Bonus : ça neutralise aussi l'anti-xray
// serveur (engine-mode 2 = faux ores ENTERRÉS côté client → jamais exposés → jamais ciblés ;
// mode 1 = ores cachés invisibles → rien à cibler) → fallback naturel = branch-mine légit.
// ⚠️ dupliqué de branchMine.ORE_NAMES (require croisé impossible : branchMine require gather).
const ORE_BLOCKS = new Set([
  'diamond_ore', 'deepslate_diamond_ore', 'iron_ore', 'deepslate_iron_ore',
  'coal_ore', 'deepslate_coal_ore', 'redstone_ore', 'deepslate_redstone_ore',
  'lapis_ore', 'deepslate_lapis_ore', 'gold_ore', 'deepslate_gold_ore',
  'copper_ore', 'deepslate_copper_ore', 'emerald_ore', 'deepslate_emerald_ore',
]);
const NONSOLID = new Set(['air', 'cave_air', 'void_air', 'water', 'flowing_water', 'lava', 'flowing_lava']);
let Vec3; try { Vec3 = require('vec3').Vec3; } catch (e) { Vec3 = null; }
function _v(x, y, z) { return Vec3 ? new Vec3(x, y, z) : { x, y, z }; }

// E (révision de A) : approche courte autorisée vers un ore enterré — un joueur « au pif » creuse
// parfois 3-5 blocs vers une veine (bruit, intuition). L'INTERDIT = la longue percée droite.
const MAX_ORE_APPROACH = 5;
// Les 4 cibles marathon ne sont JAMAIS throttlées (H3 : on ne passe pas devant un diamant) ;
// les communs (fer/charbon/cuivre) sont parfois ignorés (ratio humain).
const PRECIOUS_ORES = new Set(['diamond_ore', 'deepslate_diamond_ore', 'redstone_ore', 'deepslate_redstone_ore',
  'lapis_ore', 'deepslate_lapis_ore', 'gold_ore', 'deepslate_gold_ore', 'emerald_ore', 'deepslate_emerald_ore']);
const ORE_THROTTLE = 0.25; // ~1 ore commun sur 4 ignoré

function _dist(bot, p) {
  const b = bot.entity && bot.entity.position;
  if (!b) return Infinity;
  return Math.sqrt((b.x - p.x) ** 2 + (b.y - p.y) ** 2 + (b.z - p.z) ** 2);
}

/** Un ore est-il ciblable façon humaine ? exposé = oui ; enterré = seulement à ≤MAX_ORE_APPROACH. */
function oreTargetable(bot, p, name, rng) {
  if (!ORE_BLOCKS.has(name)) return true;                       // pas un ore → pas de règle
  const near = _dist(bot, p) <= MAX_ORE_APPROACH;
  if (!isExposed(bot, p) && !near) return false;                // longue percée interdite (le tell)
  if (!PRECIOUS_ORES.has(name) && (rng || Math.random)() < ORE_THROTTLE) return false; // throttle communs
  return true;
}

/** L'ore en `p` a-t-il ≥1 face visible (air/liquide) ? Un ore 100% enterré n'est JAMAIS une cible. */
function isExposed(bot, p) {
  const fx = Math.floor(p.x), fy = Math.floor(p.y), fz = Math.floor(p.z);
  for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) {
    const b = bot.blockAt(_v(fx + dx, fy + dy, fz + dz));
    if (b && (NONSOLID.has(b.name) || b.boundingBox === 'empty')) return true;
  }
  return false;
}

/** Premier ore CIBLABLE façon humaine (exposé, ou enterré ≤MAX_ORE_APPROACH) parmi `names`. */
function findExposedOre(bot, names, maxDistance = 32, rng) {
  const ids = _ids(bot, names);
  if (!ids) return null;
  let cands = [];
  if (typeof bot.findBlocks === 'function') cands = bot.findBlocks({ matching: ids, maxDistance, count: 16 }) || [];
  else { const b = bot.findBlock({ matching: ids, maxDistance }); if (b) cands = [b.position]; }
  for (const p of cands) {
    const b = bot.blockAt(_v(p.x, p.y, p.z));
    if (b && oreTargetable(bot, p, b.name, rng)) return b;
  }
  return null;
}
const findTargetableOre = findExposedOre; // alias sémantique (E)

// P51 (OOM ×6, snapshot : Generators/__awaiter par millions) : la boucle interne de collectblock
// SPINNE quand un drop est inatteignable (itemDrop ré-appendé, jamais ramassé) → ~15 Mo/s de
// promesses. On BORNE chaque collect (race) + cancelTask au timeout.
async function collectBounded(bot, block, ms = 25000) {
  let to = null;
  try {
    await Promise.race([
      bot.collectBlock.collect(block),
      new Promise((_, rej) => { to = setTimeout(() => rej(new Error('collect_timeout')), ms); }),
    ]);
  } finally {
    if (to) clearTimeout(to);
  }
}
async function cancelCollect(bot) {
  try { if (bot.collectBlock && bot.collectBlock.cancelTask) await bot.collectBlock.cancelTask(); } catch (e) {}
}

// Clé de blacklist d'une position (cibles incollectables, cf. P7).
function _key(p) { return `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`; }

// Cible la + proche HORS blacklist. findBlocks (candidats multiples) si dispo, sinon findBlock.
function _findTarget(bot, ids, maxDistance, blacklist, rng) {
  if (typeof bot.findBlocks === 'function') {
    const cands = bot.findBlocks({ matching: ids, maxDistance, count: 24 }) || [];
    for (const p of cands) {
      if (blacklist.has(_key(p))) continue;
      const b = bot.blockAt ? bot.blockAt(p) : null;
      if (!b || b.boundingBox !== 'block') continue;
      if (!oreTargetable(bot, p, b.name, rng)) continue;        // stealth x-ray (Massii A→E)
      return b;
    }
    return null;
  }
  const b = bot.findBlock({ matching: ids, maxDistance });
  if (!b || blacklist.has(_key(b.position))) return null;
  if (!oreTargetable(bot, b.position, b.name, rng)) return null; // stealth x-ray (Massii A→E)
  return b;
}

async function gather(bot, { name, count = 1, maxDistance = 64, explore: doExplore = false, rng } = {}, token = null) {
  if (!name || (Array.isArray(name) && name.length === 0)) return { ok: false, reason: 'no_block' };
  const ids = _ids(bot, name);
  let got = 0;
  let explorations = 0;
  let attempts = 0;
  // P7 (Marathon run#8) : une cible INCOLLECTABLE (bûche de canopée flottante laissée par une
  // récolte précédente) était re-choisie en boucle par findBlock → collect_failed infini. On
  // blackliste la cible morte et on passe à la SUIVANTE ; borné par `attempts`.
  const blacklist = new Set();
  while (got < count && attempts < count * 5) {
    attempts++;
    if (token && token.cancelled) return { ok: true, got, cancelled: true };
    await defendIfNeeded(bot);
    let block = _findTarget(bot, ids, maxDistance, blacklist, rng);
    // Rien à portée → exploration de surface autonome (opt-in `explore`, borné). Le bot voyage en
    // anneaux et re-scanne jusqu'à trouver. Désactivé par défaut : les gather opportunistes (type
    // branchMine à maxDistance:6 sur un minerai entrevu) ne doivent PAS partir roamer 256 blocs.
    if (!block && doExplore && explorations <= count) {
      explorations++;
      const ex = await explore(bot, { name, matching: ids, scanRadius: maxDistance, token });
      if (token && token.cancelled) return { ok: true, got, cancelled: true };
      if (ex && ex.ok) block = _findTarget(bot, ids, maxDistance, blacklist, rng);
    }
    if (!block) {
      if (got > 0) break;
      return { ok: false, reason: blacklist.size > 0 ? 'collect_failed' : 'not_found' };
    }
    const tool = bestToolFor(bot, block);
    if (tool) { try { await bot.equip(tool, 'hand'); } catch (e) {} }
    // resolveBiome : en 1.21.4 block.biome.name est '' → résolu via registry (sinon material_found muet)
    const biomeName = resolveBiome(bot, block).name;    // capturé avant collect (le bloc devient air)
    try { await collectBounded(bot, block); got++; }
    catch (e) {
      await cancelCollect(bot);               // P51 : stoppe la boucle interne qui spinne
      // #2 retours live : un dig peut être interrompu (aggro/mouvement/désync) → re-équipe et retente UNE fois
      try {
        const tool2 = bestToolFor(bot, block);
        if (tool2) { try { await bot.equip(tool2, 'hand'); } catch (e2) {} }
        await collectBounded(bot, block); got++;
      } catch (e2) {
        await cancelCollect(bot);
        blacklist.add(_key(block.position));  // cible morte → on tente la SUIVANTE (P7)
        continue;
      }
    }
    // Boucle d'apprentissage (1d) : note "ce matériau a été trouvé dans ce biome ici" → mémoire du
    // groupe (event material_found capté par le manager). Robuste datapacks (on n'apprend que l'observé).
    if (bot._emit && bot._worldKey && block.name && biomeName) {
      try { bot._emit(materialFoundEvent(bot._worldKey, block.name, biomeName, block.position)); } catch (e) {}
    }
  }
  if (got > 0) return { ok: true, got };
  return { ok: false, reason: blacklist.size > 0 ? 'collect_failed' : 'not_found' };
}

module.exports = { gather, nearbyHostile, defendIfNeeded, isExposed, findExposedOre, findTargetableOre, oreTargetable, collectBounded, cancelCollect, ORE_BLOCKS, PRECIOUS_ORES, MAX_ORE_APPROACH };
