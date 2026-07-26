'use strict';
// CAVE-FIRST (Massii, live 26/07 : « les diamants il les allait chercher dans les cave = pas de
// tunnel où ils creusent en continu, l'unique moment où ils creusent c'est quand ils passent d'une
// cave a l'autre » + « cave first mais jamais celle inondée c'est important »).
//
// L'objectif diamant se terminait par un branch-mine de 48 blocs × 16 galeries : un tunnel continu,
// la stratégie inverse. Ici on ne vise QUE des minerais déjà cartographiés, EXPOSÉS (visibles depuis
// une grotte) et SECS — l'exclusion des noyés est celle de `nextOreTarget`, active par défaut et
// non négociable (la survie prime, décision Massii après les noyades en série).
//
// Le creusement ne disparaît pas : il devient le TRAJET entre deux grottes. C'est l'appelant qui le
// fournit en repli quand plus aucune cible cave n'est connue (cf. dispatch `caveHunt` d'index.js) —
// borné et court, jamais un strip-mine.

const { nextOreTarget, oreBase, requiredPickTier, scanExposedOres, isWaterAdjacent } = require('../ores');

/**
 * Cible EXPOSÉE vue par le bot lui-même, ici et maintenant. (défaut de `opts.scanLocal`)
 *
 * Massii, live 26/07 : « ils ont plein de cave autour mais je ne vois aucun qui va vers ». La
 * première version ne consultait que la MÉMOIRE DE MONDE : sans minerai cartographié à proximité,
 * elle rendait `no_cave_target` et le bot se mettait à creuser — alors qu'une grotte pleine de
 * minerai était visible à dix blocs. Un bot a des yeux, pas seulement une carte.
 */
function _defaultScanLocal(bot, material, skip, maxDistance) {
  let best = null, bestD = Infinity;
  const p = bot.entity && bot.entity.position;
  if (!p) return null;
  for (const o of (scanExposedOres(bot, { maxDistance, count: 40 }) || [])) {
    if (oreBase(o.material) !== oreBase(material)) continue;
    const key = `${o.x},${o.y},${o.z}`;
    if (skip.has(key)) continue;
    try { if (isWaterAdjacent(bot, o)) continue; } catch (e) { /* pas d'info → on garde */ }
    const d = Math.hypot(o.x - p.x, o.y - p.y, o.z - p.z);
    if (d < bestD) { bestD = d; best = o; }
  }
  return best;
}

/** Meilleur palier de pioche en poche (0 = aucune). Sert à ne cibler que le minable. */
function pickTierOf(inv) {
  const t = { wooden_pickaxe: 1, stone_pickaxe: 2, iron_pickaxe: 3, diamond_pickaxe: 4, netherite_pickaxe: 5 };
  let best = 0;
  for (const name of Object.keys(t)) { if ((inv[name] || 0) > 0 && t[name] > best) best = t[name]; }
  return best;
}

/**
 * Chasse cave-first : enchaîne les minerais mappés EXPOSÉS et SECS du matériau demandé.
 *
 * opts:
 *   material   : 'diamond' (base d'ore, cf. oreBase)
 *   count      : nombre de minerais à ramener
 *   memory/world : mémoire de monde + clé (défaut bot._worldMemory / bot._worldKey)
 *   maxDist    : rayon de recherche autour du bot (défaut 256)
 *   goTo(pos)  : déplacement borné, injecté (défaut : pathfinder de l'appelant)
 *   mineAt(pos): minage + filon, injecté
 *   emit       : événements
 *
 * → { ok:true, got } | { ok:false, reason:'no_cave_target'|'no_pick'|'cancelled', got }
 * `no_cave_target` n'est PAS une erreur : c'est le signal « plus rien de visible ici, il faut
 * creuser vers la grotte suivante » — l'appelant enchaîne un trajet court.
 */
async function caveHunt(bot, opts = {}, token = null) {
  const material = opts.material || 'diamond';
  const need = opts.count || 1;
  const maxDist = opts.maxDist || 96;   // 256 visait des cibles hors de portee du pathfinder
  const emit = opts.emit || (() => {});
  const memory = opts.memory || bot._worldMemory || null;
  const world = opts.world || bot._worldKey || 'overworld';
  const goTo = opts.goTo;
  const mineAt = opts.mineAt;
  const pickNext = opts.nextOreTarget || nextOreTarget;

  const inv = {};
  for (const it of ((bot.inventory && bot.inventory.items()) || [])) inv[it.name] = (inv[it.name] || 0) + it.count;
  const tier = pickTierOf(inv);
  if (tier < requiredPickTier(material)) return { ok: false, reason: 'no_pick', got: 0 };

  const skip = new Set();
  let got = 0;
  while (got < need) {
    if (token && token.cancelled) return { ok: false, reason: 'cancelled', got };
    const from = bot.entity && bot.entity.position ? bot.entity.position : null;
    // ORDRE : ce que le bot VOIT d'abord, la carte ensuite. Mesure live 26/07 : avec la carte en
    // premier, 95 cibles sur 98 étaient `cave_unreachable` et pas un seul diamant miné — on visait
    // des minerais cartographiés à des centaines de blocs, derrière de la roche pleine que le
    // pathfinder ne sait pas traverser. Un minerai VISIBLE est dans les chunks chargés, donc
    // atteignable ; un minerai cartographié n'est qu'une rumeur.
    const scanLocal = opts.scanLocal || _defaultScanLocal;
    let target = scanLocal(bot, material, skip, opts.localRange || 48);
    if (target) emit({ type: 'cave_local', material, x: target.x, y: target.y, z: target.z });
    if (!target) {
      target = pickNext(memory, world, from, {
        allowTypes: [oreBase(material)],
        exposedOnly: true,      // JAMAIS un minerai enterré : on n'exploite que le visible
        excludeWet: true,       // JAMAIS une grotte inondée (exigence explicite, non négociable)
        pickTier: tier,
        maxDist,
        skip,
      });
    }
    if (!target) return { ok: got > 0, reason: got > 0 ? undefined : 'no_cave_target', got };

    emit({ type: 'cave_target', material, x: target.x, y: target.y, z: target.z, d: got });
    let reached = false;
    try { reached = !!(await goTo(target)); } catch (e) { reached = false; }
    if (token && token.cancelled) return { ok: false, reason: 'cancelled', got };
    if (!reached) {
      skip.add(`${target.x},${target.y},${target.z}`);   // inatteignable → on ne s'y acharne pas
      emit({ type: 'cave_unreachable', x: target.x, y: target.y, z: target.z });
      continue;
    }
    let mined = 0;
    try { mined = (await mineAt(target)) || 0; } catch (e) { mined = 0; }
    if (mined > 0) { got += mined; emit({ type: 'cave_mined', material, got }); }
    else { skip.add(`${target.x},${target.y},${target.z}`); }
  }
  return { ok: true, got };
}

module.exports = { caveHunt, pickTierOf };
