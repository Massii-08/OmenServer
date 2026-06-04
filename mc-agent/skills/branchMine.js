'use strict';
// Branch mining déterministe à Y target (-54 par défaut, juste au-dessus de la nappe de lave
// du diamant — cf. spec §3). Tunnel principal 1×2 + branches latérales 1×2 espacées de
// `branchSpacing` blocs. Anti-lave : sondage 6-voisins avant chaque dig ; lave détectée → murage
// avec cobblestone (réserve ≥8 sinon `cobble_low`). Opportuniste : si un ore diamant/iron/coal
// est visible dans le voisinage du bloc miné, on le ramasse via gather (collectBlock).
//
// /!\ Important : avant chaque paire de digs (foot+head), on appelle pathfinder.goto pour
// s'APPROCHER de la cible (GoalNear range 3). Sans ça, le bot reste à la position de départ et
// dès que i≥6-7 le bloc cible est hors range mineflayer (~6 blocs) → bot.dig échoue silencieusement
// → stall (risque #5 du rapport build précédent).
const { bestToolFor } = require('../tools');
const { gather, findTargetableOre, PRECIOUS_ORES, collectBounded, cancelCollect } = require('./gather');
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

function isLava(name) { return name === 'lava' || name === 'flowing_lava'; }

function countItem(bot, name) {
  return (bot.inventory.items() || []).filter((i) => i.name === name).reduce((s, i) => s + i.count, 0);
}

// Réserve de murage : à Y deepslate (≤0) le minage produit du cobbled_deepslate, PAS du cobblestone
// → compter les deux, sinon la réserve semble « épuisée » à tort en plein filon (panne long-terme P1).
const SCAFFOLD_NAMES = ['cobblestone', 'cobbled_deepslate'];
function scaffoldCount(bot) {
  return SCAFFOLD_NAMES.reduce((s, n) => s + countItem(bot, n), 0);
}

// Compteurs ores ramassés via gather (delta vs avant). Marathon : 4 minerais cibles + fer/charbon.
function snapshotOres(bot) {
  return {
    diamond: countItem(bot, 'diamond'),
    iron: countItem(bot, 'raw_iron') + countItem(bot, 'iron_ingot'),
    coal: countItem(bot, 'coal'),
    redstone: countItem(bot, 'redstone'),
    lapis: countItem(bot, 'lapis_lazuli'),
    gold: countItem(bot, 'raw_gold') + countItem(bot, 'gold_ingot'),
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

// Tente de poser un bloc de cobble pour murer la lave à `where`. On utilise placeBlock contre une
// face solide adjacente. Retourne true si placé, false sinon (pas grave : on changera de direction).
async function wallLava(bot, where) {
  const cob = bot.inventory.items().find((i) => SCAFFOLD_NAMES.includes(i.name));
  if (!cob) return false;
  // Cherche un voisin solide auquel attacher le cobble.
  const dirs = [[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]];
  for (const [dx, dy, dz] of dirs) {
    const ref = bot.blockAt(p(where.x - dx, where.y - dy, where.z - dz));
    if (!ref || ref.boundingBox !== 'block') continue;
    try {
      await bot.equip(cob, 'hand');
      await bot.placeBlock(ref, { x: dx, y: dy, z: dz });
      return true;
    } catch (e) { /* essaie une autre face */ }
  }
  return false;
}

// Détecte un ore dans les voisins 6-connectés d'un bloc. Renvoie le nom de l'ore (string) ou null.
const ORE_NAMES = new Set([
  'diamond_ore', 'deepslate_diamond_ore',
  'iron_ore', 'deepslate_iron_ore',
  'coal_ore', 'deepslate_coal_ore',
  // marathon : redstone/lapis/or (variantes deepslate incluses)
  'redstone_ore', 'deepslate_redstone_ore',
  'lapis_ore', 'deepslate_lapis_ore',
  'gold_ore', 'deepslate_gold_ore',
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
async function safeDigAndOpportunism(bot, target, token) {
  dbg('safeDig', { phase: 'safeDig:enter', target: { x: target.x, y: target.y, z: target.z } });
  // Anti-lave 6-voisins.
  let lava;
  try { lava = neighborsHaveLava(bot, target); }
  catch (e) { dbg('safeDig', { phase: 'safeDig:neighborsThrew', err: String(e && e.message || e).slice(0,200) }); return { ok: false, reason: 'neighbor_err' }; }
  if (lava) {
    const walled = await wallLava(bot, lava.ahead);
    if (!walled) return { ok: false, walled: false, reason: 'lava_unwallable' };
  }
  const block = bot.blockAt(target);
  // Diag : tracer la cible et ce que blockAt voit (smoke phase A — bot resté figé).
  try { dbg('safeDig', { phase: 'safeDig:probe', target: { x: target.x, y: target.y, z: target.z }, blockName: block ? block.name : null, bb: block ? block.boundingBox : null }); } catch (e) {}
  if (!block || block.boundingBox !== 'block') return { ok: true };       // déjà air → rien à faire
  if (isLava(block.name)) return { ok: false, reason: 'lava_at_target' };

  // Si le bloc cible EST un ore (diamant/iron/coal), passe par gather (collectBlock → drop ramassé).
  if (ORE_NAMES.has(block.name)) {
    try { await gather(bot, { name: [block.name], count: 1, maxDistance: 6 }, token); }
    catch (e) { /* fallback dig direct ci-dessous */ }
    return { ok: true };
  }

  const tool = bestToolFor(bot, block);
  if (tool) { try { await bot.equip(tool, 'hand'); } catch (e) {} }
  // collectBlock.collect : pathfind → dig → walk over drop → pickup (sinon le drop reste au sol et
  // l'inventaire ne change jamais → planner stall après 4 iters sans progrès, cf. smoke phase A 1).
  try { dbg('safeDig', { phase: 'safeDig:try', target: { x: target.x, y: target.y, z: target.z }, name: block.name }); } catch (e) {}
  try {
    if (bot.collectBlock && bot.collectBlock.collect) {
      try { await collectBounded(bot, block); }
      catch (e) { await cancelCollect(bot); throw e; }   // P51 : jamais de spin interne illimité
    } else {
      await bot.dig(block);
    }
    try { dbg('safeDig', { phase: 'safeDig:ok', target: { x: target.x, y: target.y, z: target.z } }); } catch (e) {}
  } catch (e) {
    try { dbg('safeDig', { phase: 'safeDig:fail', target: { x: target.x, y: target.y, z: target.z }, err: String(e && e.message || e).slice(0, 200) }); } catch (e2) {}
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
 *  - tunnel principal 1×2 dans le cap initial du bot
 *  - tous les `branchSpacing` blocs (>0), creuse 2 branches symétriques (gauche puis droite) de
 *    `branchLength` blocs
 *  - 6-voisins lava check avant chaque dig (mure si possible)
 *  - opportuniste sur diamond/iron/coal voisins (gather)
 *  - stop si diamant en inventaire, mainLength atteint, ou cobble<8
 */
async function branchMine(bot, opts = {}, token = null) {
  const targetY = opts.targetY !== undefined ? opts.targetY : -54;
  const mainLength = opts.mainLength || 32;
  const branchSpacing = opts.branchSpacing || 3;
  const branchLength = opts.branchLength || 8;
  // Massii H : mode ORGANIQUE (opt-in marathon, legacy inchangé) —
  //  H1 zig-zag ±2 (direction tenue, exécution imparfaite) ; H2 branches « peek » 1-haut ≤3
  //  (économie d'outils : on n'y marche pas, on expose) ; H3 détour court vers tout ore précieux
  //  ciblable (exposé ou ≤5) — on ne passe JAMAIS devant un diamant.
  const organic = !!opts.organic;
  const rng = opts.rng || Math.random;
  const peek = opts.branchStyle === 'peek';
  let lateral = 0;
  // Condition d'arrêt configurable (marathon : inventaire plein / segment fini) ;
  // défaut rétro-compat DIAMOND_CHAIN : 1 diamant en poche suffit.
  const stopWhen = opts.stopWhen || ((b) => countItem(b, 'diamond') >= 1);

  const start = bot.entity && bot.entity.position;
  dbg('start', { phase: 'branchMine:enter', y: start ? start.y : null, x: start ? start.x : null, z: start ? start.z : null, targetY, mainLength, hasPF: !!(bot.pathfinder && bot.pathfinder.goto), hasCB: !!(bot.collectBlock && bot.collectBlock.collect), cobble: countItem(bot, 'cobblestone') });
  if (!start) { dbg('start', { phase: 'branchMine:bail', reason: 'no_pos' }); return { ok: false, reason: 'no_pos' }; }
  if (Math.abs(start.y - targetY) > 2) { dbg('start', { phase: 'branchMine:bail', reason: 'wrong_depth', startY: start.y, targetY }); return { ok: false, reason: 'wrong_depth' }; }

  if (scaffoldCount(bot) < COBBLE_TARGET_INIT / 2) {
    // tolère un peu en dessous de 16 (gather peut en avoir consommé) mais on garde la réserve mini.
    if (scaffoldCount(bot) < COBBLE_RESERVE_MIN) return { ok: false, reason: 'cobble_low' };
  }

  const dir = cardinalFromYaw((bot.entity.yaw || 0));
  const left = leftOf(dir);
  const oresBefore = snapshotOres(bot);

  // Point de départ figé : on calcule les cibles depuis CE point, jamais depuis la position
  // courante (sinon les targets dériveraient à mesure que le bot avance via pathfinder).
  const origin = bot.entity.position;
  const ox = Math.floor(origin.x);
  const oy = Math.floor(origin.y);
  const oz = Math.floor(origin.z);

  dbg('start', { phase: 'branchMine:loop_start', dir, origin: { ox, oy, oz } });

  let i = 1;
  let stopReason = null;

  outer:
  while (i <= mainLength) {
    if (token && token.cancelled) return { ok: true, cancelled: true, ores: deltaOres(oresBefore, snapshotOres(bot)), gotDiamond: countItem(bot, 'diamond') > 0 };
    if (scaffoldCount(bot) < COBBLE_RESERVE_MIN) { stopReason = 'cobble_low'; break; }
    if (stopWhen(bot)) break;                                          // objectif rempli

    // Tunnel 1×2 : pieds + tête. Targets calculés depuis origin (point fixe).
    if (organic && rng() < 0.25) {                       // H1 : dérive latérale occasionnelle
      lateral += rng() < 0.5 ? -1 : 1;
      if (lateral > 2) lateral = 2; else if (lateral < -2) lateral = -2;
    }
    const footTarget = p(ox + dir.dx * i + left.dx * lateral, oy, oz + dir.dz * i + left.dz * lateral);
    const headTarget = p(footTarget.x, footTarget.y + 1, footTarget.z);
    dbg('iter', { phase: 'branchMine:iter', i, footTarget: { x: footTarget.x, y: footTarget.y, z: footTarget.z } });
    // Approche AVANT le dig : sinon hors range à i>=6 (cf. risque #5). GoalNear 3 = arrive à ≤3 blocs.
    try { await approach(bot, footTarget, 3); } catch (e) { dbg('iter', { phase: 'branchMine:approachThrew', err: String(e).slice(0,150) }); }
    dbg('iter', { phase: 'branchMine:postApproach', i, pos: { x: Math.floor(bot.entity.position.x), y: Math.floor(bot.entity.position.y), z: Math.floor(bot.entity.position.z) } });
    for (const t of [footTarget, headTarget]) {
      let r;
      try { r = await safeDigAndOpportunism(bot, t, token); }
      catch (e) { dbg('iter', { phase: 'branchMine:safeDigThrew', err: String(e).slice(0,150) }); r = { ok: false, reason: 'threw' }; }
      if (!r.ok && r.reason === 'lava_unwallable') { stopReason = 'lava'; break outer; }
    }

    // P29 (mort #4 en tunnel sombre, 56 torches en poche jamais posées) : éclairer le tunnel
    // tous les ~8 blocs — anti-spawn hostile, et c'est ce qu'un humain fait.
    if (organic && i % 8 === 0) {
      const torch = bot.inventory.items().find((it) => it.name === 'torch');
      if (torch) {
        try {
          const floor = bot.blockAt(p(footTarget.x, footTarget.y - 1, footTarget.z));
          if (floor && floor.boundingBox === 'block') {
            await bot.equip(torch, 'hand');
            await bot.placeBlock(floor, { x: 0, y: 1, z: 0 });
          }
        } catch (e) { /* pose ratée → tant pis, prochaine occasion */ }
      }
    }

    // H3 (organique) : détour COURT vers tout ore précieux à portée (exposé ou enterré ≤5) —
    // jamais passer devant un diamant. gather borne le pathing à maxDistance 6.
    if (organic) {
      const near = findTargetableOre(bot, [...PRECIOUS_ORES], 5, rng);
      if (near) { try { await gather(bot, { name: [near.name], count: 8, maxDistance: 6, rng }, token); } catch (e) {} }
    }

    // Branches latérales alternées à intervalles de branchSpacing — gauche puis droite (i et i+1 décalés).
    if (i > 0 && i % branchSpacing === 0) {
      const bl = peek ? Math.min(3, branchLength) : branchLength; // H2 : peek ≤3 (portée sans y entrer)
      for (const side of [left, { dx: -left.dx, dz: -left.dz }]) {
        for (let j = 1; j <= bl; j++) {
          if (token && token.cancelled) break;
          if (stopWhen(bot)) break outer;
          if (scaffoldCount(bot) < COBBLE_RESERVE_MIN) { stopReason = 'cobble_low'; break outer; }
          const ft = p(footTarget.x + side.dx * j, footTarget.y, footTarget.z + side.dz * j);
          const ht = p(ft.x, ft.y + 1, ft.z);
          if (peek) {
            // H2 : trou d'observation 1-haut à hauteur de TÊTE seulement — moitié moins de blocs
            // cassés, on ne marche pas dedans (pas d'approach), l'ore exposé est ramassé par gather.
            const r = await safeDigAndOpportunism(bot, ht, token);
            if (!r.ok && r.reason === 'lava_unwallable') { stopReason = 'lava'; break outer; }
            continue;
          }
          // Approche aussi avant la branche — j peut monter à 8, donc range hors limite sans goto.
          await approach(bot, ft, 3);
          for (const t of [ft, ht]) {
            const r = await safeDigAndOpportunism(bot, t, token);
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
  };
}

function deltaOres(a, b) {
  const out = {};
  for (const k of Object.keys(b)) out[k] = Math.max(0, (b[k] || 0) - (a[k] || 0));
  return out;
}

module.exports = { branchMine, cardinalFromYaw, leftOf, ORE_NAMES, SCAFFOLD_NAMES, scaffoldCount };
