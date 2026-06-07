'use strict';
// Branch mining déterministe à Y target (-54 par défaut, juste au-dessus de la nappe de lave
// du diamant — cf. spec §3). Tunnel principal 1×2 + branches latérales 1×2 espacées de
// `branchSpacing` blocs. Anti-lave : sondage 6-voisins avant chaque dig ; lave détectée → murage
// avec cobblestone/cobbled_deepslate (réserve ≥8 sinon `cobble_low`). Opportuniste : tout ore
// quota (diamant/fer/or/redstone/lapis/charbon/cuivre/émeraude) visible dans le voisinage du
// bloc miné est ramassé via gather (collectBlock).
//
// PHASE 3 (vitesse) :
//  - la ROCHE NUE est minée via bot.dig DIRECT (pas collectBlock : son pathfinding vers chaque
//    drop doublait le temps par bloc — le bot ramasse les drops en avançant dans le tunnel) ;
//  - equip avec CACHE (on ne ré-équipe pas l'outil déjà en main : ~50-100 ms/bloc économisés) ;
//  - `opts.stopOre {items, count}` : arrêt sur DELTA d'items récoltés depuis le début du call
//    (mode quota : le bot PORTE déjà des diamants — l'ancien stop `diamond >= 1` absolu rendait
//    branchMine inutilisable après le 1er diamant → tout venait des cibles mappées lointaines) ;
//  - `opts.heading {dx,dz}` : cap imposé par l'appelant (persistance entre calls → le tunnel
//    CONTINUE tout droit au lieu de repartir dans une direction aléatoire et se recroiser) ;
//  - `opts.torchEvery` : pose une torche au sol tous les N paliers du tunnel principal
//    (mob-aware, phase B — best-effort : sans torche en poche, on continue sans).
//
// /!\ Important : avant chaque paire de digs (foot+head), on appelle pathfinder.goto pour
// s'APPROCHER de la cible (GoalNear range 3). Sans ça, le bot reste à la position de départ et
// dès que i≥6-7 le bloc cible est hors range mineflayer (~6 blocs) → bot.dig échoue silencieusement
// → stall (risque #5 du rapport build précédent).
const { bestToolFor } = require('../tools');
const { gather } = require('./gather');
const { Vec3 } = require('vec3');
let _emit; try { _emit = require('../io').emit; } catch (e) { _emit = () => {}; }
function dbg(_label, payload) { try { _emit({ type: 'dbg', from: 'branchMine', ...payload }); } catch (e) {} }

// Pathfinder.goals — utilisé uniquement pour le DÉPLACEMENT entre digs. Charge optionnelle (tests).
let goals;
try { goals = require('mineflayer-pathfinder').goals; } catch (e) { goals = null; }
function buildNearGoal(x, y, z, range = 3) {
  if (goals && goals.GoalNear) return new goals.GoalNear(x, y, z, range);
  return { x, y, z };
}

// Rapproche le bot d'une cible avant le dig. Si le pathfinder est indisponible (tests sans mock),
// no-op silencieux. Si la cible est inaccessible, on ne fait pas échouer : le dig direct prendra
// le relais et échouera proprement avec dig_failed si vraiment hors range.
async function approach(bot, target, range = 3) {
  if (!bot.pathfinder || !bot.pathfinder.goto) return;
  try { await bot.pathfinder.goto(buildNearGoal(target.x, target.y, target.z, range)); }
  catch (e) { /* cible bloquée → on tente quand même le dig direct */ }
}

const COBBLE_RESERVE_MIN = 8;
const COBBLE_TARGET_INIT = 16;
// Matériaux de murage anti-lave : le creusage de deepslate génère du cobbled_deepslate à l'infini
// → fini les aborts cobble_low en profondeur (le cobblestone de surface n'est plus le seul stock).
const WALL_BLOCKS = ['cobblestone', 'cobbled_deepslate'];

function isLava(name) { return name === 'lava' || name === 'flowing_lava'; }

function countItem(bot, name) {
  return (bot.inventory.items() || []).filter((i) => i.name === name).reduce((s, i) => s + i.count, 0);
}
function countItems(bot, names) {
  const set = new Set(names || []);
  return (bot.inventory.items() || []).filter((i) => set.has(i.name)).reduce((s, i) => s + i.count, 0);
}
function countWallable(bot) { return countItems(bot, WALL_BLOCKS); }

// Équipe `tool` seulement s'il n'est pas déjà en main (cache : equip a un coût par appel).
async function equipCached(bot, tool) {
  if (!tool) return;
  if (bot.heldItem && bot.heldItem.name === tool.name) return;
  try { await bot.equip(tool, 'hand'); } catch (e) {}
}

// Compteurs ores ramassés via gather (delta vs avant).
function snapshotOres(bot) {
  return {
    diamond: countItem(bot, 'diamond'),
    iron: countItem(bot, 'raw_iron') + countItem(bot, 'iron_ingot'),
    coal: countItem(bot, 'coal'),
  };
}

// Cardinal arrondi depuis le yaw du bot (même convention que descendDiagonal).
function cardinalFromYaw(yaw) {
  const norm = ((yaw % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
  const q = Math.round(norm / (Math.PI / 2)) % 4;
  if (q === 0) return { dx: 0, dz: 1 };
  if (q === 1) return { dx: -1, dz: 0 };
  if (q === 2) return { dx: 0, dz: -1 };
  return { dx: 1, dz: 0 };
}

// Perpendiculaire 90° gauche d'un cap.
function leftOf(dir) { return { dx: -dir.dz, dz: dir.dx }; }

// Pos = Vec3 (mineflayer's blockAt et placeBlock font des `.floored()` internes : un POJO throw
// `TypeError: pos.floored is not a function`, smoke phase A v3 a confirmé). On garde l'API offset
// pour ne pas casser les tests qui patchent blockAt avec des POJO comparables.
function p(x, y, z) { return new Vec3(x, y, z); }

// Probe 6 voisins (±x, ±y, ±z) du bloc cible — détecte lave/source/flowing.
function neighborsHaveLava(bot, target) {
  const d = [[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]];
  for (const [dx, dy, dz] of d) {
    const b = bot.blockAt(p(target.x + dx, target.y + dy, target.z + dz));
    if (b && isLava(b.name)) return { ahead: p(target.x + dx, target.y + dy, target.z + dz), block: b };
  }
  return null;
}

// Tente de poser un bloc de murage (cobble OU cobbled_deepslate) pour murer la lave à `where`.
// On utilise placeBlock contre une face solide adjacente. Retourne true si placé, false sinon.
async function wallLava(bot, where) {
  const wall = bot.inventory.items().find((i) => WALL_BLOCKS.includes(i.name));
  if (!wall) return false;
  // Cherche un voisin solide auquel attacher le bloc.
  const dirs = [[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]];
  for (const [dx, dy, dz] of dirs) {
    const ref = bot.blockAt(p(where.x - dx, where.y - dy, where.z - dz));
    if (!ref || ref.boundingBox !== 'block') continue;
    try {
      await bot.equip(wall, 'hand');
      await bot.placeBlock(ref, { x: dx, y: dy, z: dz });
      return true;
    } catch (e) { /* essaie une autre face */ }
  }
  return false;
}

// Pose une torche au sol près de `floorTarget` (le bloc des pieds du tunnel). Best-effort :
// pas de torche / pas de face → on continue sans (phase B mob-aware, jamais bloquant).
async function placeTorch(bot, floorTarget) {
  const torch = bot.inventory.items().find((i) => i.name === 'torch');
  if (!torch) return false;
  const ref = bot.blockAt(p(floorTarget.x, floorTarget.y - 1, floorTarget.z));
  if (!ref || ref.boundingBox !== 'block') return false;
  try {
    await bot.equip(torch, 'hand');
    await bot.placeBlock(ref, { x: 0, y: 1, z: 0 });
    return true;
  } catch (e) { return false; }
}

// Détecte un ore dans les voisins 6-connectés d'un bloc. Tous les ores UTILES (quota + torches).
const ORE_NAMES = new Set([
  'diamond_ore', 'deepslate_diamond_ore',
  'iron_ore', 'deepslate_iron_ore',
  'coal_ore', 'deepslate_coal_ore',
  'gold_ore', 'deepslate_gold_ore',
  'redstone_ore', 'deepslate_redstone_ore',
  'lapis_ore', 'deepslate_lapis_ore',
  'copper_ore', 'deepslate_copper_ore',
  'emerald_ore', 'deepslate_emerald_ore',
]);
function oresInNeighborhood(bot, target) {
  const found = [];
  const d = [[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]];
  for (const [dx, dy, dz] of d) {
    const b = bot.blockAt(p(target.x + dx, target.y + dy, target.z + dz));
    if (b && ORE_NAMES.has(b.name)) found.push(b.name);
  }
  return found;
}

// Mine un bloc avec garde-fou lave + opportunisme ore. Retourne {ok, walled?:bool}.
async function safeDigAndOpportunism(bot, target, token, debug) {
  // Anti-lave 6-voisins.
  let lava;
  try { lava = neighborsHaveLava(bot, target); }
  catch (e) { if (debug) dbg('safeDig', { phase: 'safeDig:neighborsThrew', err: String(e && e.message || e).slice(0,200) }); return { ok: false, reason: 'neighbor_err' }; }
  if (lava) {
    const walled = await wallLava(bot, lava.ahead);
    if (!walled) return { ok: false, walled: false, reason: 'lava_unwallable' };
  }
  const block = bot.blockAt(target);
  if (debug) { try { dbg('safeDig', { phase: 'safeDig:probe', target: { x: target.x, y: target.y, z: target.z }, blockName: block ? block.name : null }); } catch (e) {} }
  if (!block || block.boundingBox !== 'block') return { ok: true };       // déjà air → rien à faire
  if (isLava(block.name)) return { ok: false, reason: 'lava_at_target' };

  // Si le bloc cible EST un ore utile, passe par gather (collectBlock → drop ramassé à coup sûr).
  if (ORE_NAMES.has(block.name)) {
    try { await gather(bot, { name: [block.name], count: 1, maxDistance: 6 }, token); }
    catch (e) { /* fallback dig direct ci-dessous */ }
    return { ok: true };
  }

  // ROCHE NUE → dig DIRECT (phase 3) : collectBlock re-pathfindait vers CHAQUE drop (~1-2 s/bloc
  // de surcoût × milliers de blocs). Les drops tombent dans le tunnel 1×2 — le bot les aspire en
  // avançant (approach() du palier suivant passe dessus).
  await equipCached(bot, bestToolFor(bot, block));
  try {
    await bot.dig(block);
  } catch (e) {
    if (debug) { try { dbg('safeDig', { phase: 'safeDig:fail', target: { x: target.x, y: target.y, z: target.z }, err: String(e && e.message || e).slice(0, 200) }); } catch (e2) {} }
    return { ok: false, reason: 'dig_failed' };
  }

  // Opportunisme : si un ore est visible dans le voisinage (révélé par le dig), on tente de le ramasser.
  if (token && token.cancelled) return { ok: true };
  const oresAround = oresInNeighborhood(bot, target);
  if (oresAround.length > 0) {
    try {
      await gather(bot, { name: oresAround, count: oresAround.length, maxDistance: 6 }, token);
    } catch (e) { /* opportuniste : on continue */ }
  }
  return { ok: true };
}

/**
 * Boucle de branch mining déterministe à Y target.
 *  - tunnel principal 1×2 dans le cap initial du bot (ou opts.heading {dx,dz} si fourni)
 *  - tous les `branchSpacing` blocs (>0), creuse 2 branches symétriques (gauche puis droite) de
 *    `branchLength` blocs
 *  - 6-voisins lava check avant chaque dig (mure si possible)
 *  - opportuniste sur tous les ores quota voisins (gather)
 *  - stop : opts.stopOre {items:[names], count:n} = DELTA récolté depuis le début du call
 *    (mode quota) ; défaut legacy = diamant en inventaire (DIAMOND_CHAIN) ;
 *    mainLength atteint, ou réserve de murage <8.
 *  - opts.torchEvery (déf 0=off) : torche au sol tous les N paliers du tunnel principal.
 */
async function branchMine(bot, opts = {}, token = null) {
  const targetY = opts.targetY !== undefined ? opts.targetY : -54;
  const mainLength = opts.mainLength || 32;
  const branchSpacing = opts.branchSpacing || 3;
  const branchLength = opts.branchLength || 8;
  const stopOre = opts.stopOre || null;                  // {items:[...], count:n} — delta depuis le départ
  const torchEvery = opts.torchEvery || 0;
  const debug = !!opts.debug;

  const start = bot.entity && bot.entity.position;
  dbg('start', { phase: 'branchMine:enter', y: start ? start.y : null, x: start ? start.x : null, z: start ? start.z : null, targetY, mainLength, wall: countWallable(bot) });
  if (!start) { dbg('start', { phase: 'branchMine:bail', reason: 'no_pos' }); return { ok: false, reason: 'no_pos' }; }
  if (Math.abs(start.y - targetY) > 2) { dbg('start', { phase: 'branchMine:bail', reason: 'wrong_depth', startY: start.y, targetY }); return { ok: false, reason: 'wrong_depth' }; }

  if (countWallable(bot) < COBBLE_TARGET_INIT / 2) {
    // tolère un peu en dessous de 16 (gather peut en avoir consommé) mais on garde la réserve mini.
    if (countWallable(bot) < COBBLE_RESERVE_MIN) return { ok: false, reason: 'cobble_low' };
  }

  const dir = (opts.heading && (opts.heading.dx || opts.heading.dz))
    ? { dx: Math.sign(opts.heading.dx || 0), dz: Math.sign(opts.heading.dz || 0) }
    : cardinalFromYaw((bot.entity.yaw || 0));
  const left = leftOf(dir);
  const oresBefore = snapshotOres(bot);
  const stopStart = stopOre ? countItems(bot, stopOre.items) : 0;
  const stopReached = () => stopOre
    ? (countItems(bot, stopOre.items) - stopStart >= stopOre.count)
    : (countItem(bot, 'diamond') >= 1);

  // Point de départ figé : on calcule les cibles depuis CE point, jamais depuis la position
  // courante (sinon les targets dériveraient à mesure que le bot avance via pathfinder).
  const origin = bot.entity.position;
  const ox = Math.floor(origin.x);
  const oy = Math.floor(origin.y);
  const oz = Math.floor(origin.z);

  let i = 1;
  let stopReason = null;

  outer:
  while (i <= mainLength) {
    if (token && token.cancelled) return { ok: true, cancelled: true, ores: deltaOres(oresBefore, snapshotOres(bot)), gotDiamond: countItem(bot, 'diamond') > 0, heading: dir };
    if (countWallable(bot) < COBBLE_RESERVE_MIN) { stopReason = 'cobble_low'; break; }
    if (stopReached()) break;                                          // objectif rempli

    // Tunnel 1×2 : pieds + tête. Targets calculés depuis origin (point fixe).
    const footTarget = p(ox + dir.dx * i, oy, oz + dir.dz * i);
    const headTarget = p(footTarget.x, footTarget.y + 1, footTarget.z);
    if (debug) dbg('iter', { phase: 'branchMine:iter', i, footTarget: { x: footTarget.x, y: footTarget.y, z: footTarget.z } });
    // Approche AVANT le dig : sinon hors range à i>=6 (cf. risque #5). GoalNear 3 = arrive à ≤3 blocs.
    try { await approach(bot, footTarget, 3); } catch (e) { if (debug) dbg('iter', { phase: 'branchMine:approachThrew', err: String(e).slice(0,150) }); }
    for (const t of [footTarget, headTarget]) {
      let r;
      try { r = await safeDigAndOpportunism(bot, t, token, debug); }
      catch (e) { if (debug) dbg('iter', { phase: 'branchMine:safeDigThrew', err: String(e).slice(0,150) }); r = { ok: false, reason: 'threw' }; }
      if (!r.ok && r.reason === 'lava_unwallable') { stopReason = 'lava'; break outer; }
    }
    // Torche tous les torchEvery paliers (phase B mob-aware) — best-effort, jamais bloquant.
    if (torchEvery > 0 && i % torchEvery === 0) {
      try { await placeTorch(bot, footTarget); } catch (e) { /* best-effort */ }
    }

    // Branches latérales alternées à intervalles de branchSpacing — gauche puis droite (i et i+1 décalés).
    if (i > 0 && i % branchSpacing === 0) {
      for (const side of [left, { dx: -left.dx, dz: -left.dz }]) {
        for (let j = 1; j <= branchLength; j++) {
          if (token && token.cancelled) break;
          if (stopReached()) break outer;
          if (countWallable(bot) < COBBLE_RESERVE_MIN) { stopReason = 'cobble_low'; break outer; }
          const ft = p(footTarget.x + side.dx * j, footTarget.y, footTarget.z + side.dz * j);
          const ht = p(ft.x, ft.y + 1, ft.z);
          // Approche aussi avant la branche — j peut monter à 8, donc range hors limite sans goto.
          await approach(bot, ft, 3);
          for (const t of [ft, ht]) {
            const r = await safeDigAndOpportunism(bot, t, token, debug);
            if (!r.ok && r.reason === 'lava_unwallable') { stopReason = 'lava'; break outer; }
          }
        }
      }
    }

    i++;
  }

  const oresAfter = snapshotOres(bot);
  const gotDiamond = oresAfter.diamond >= 1;
  return {
    ok: !stopReason || stopReason === 'lava',
    gotDiamond,
    ores: deltaOres(oresBefore, oresAfter),
    reason: stopReason || undefined,
    heading: dir,
  };
}

function deltaOres(a, b) {
  return { diamond: Math.max(0, b.diamond - a.diamond), iron: Math.max(0, b.iron - a.iron), coal: Math.max(0, b.coal - a.coal) };
}

module.exports = { branchMine, cardinalFromYaw, leftOf, ORE_NAMES, WALL_BLOCKS };
