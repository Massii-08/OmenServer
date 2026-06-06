'use strict';
// Tunnel 1×2 vers une CIBLE ARBITRAIRE (x,y,z) — l'approche finale des minerais ENFOUIS.
// Pourquoi : pathfinder ne sait PAS descendre 60 blocs dans la roche pleine (A* explose →
// chemins partiels qui plafonnent en surface — vécu live : 3 bots à y=62 au-dessus de leurs
// claims à y≈0, zéro progrès en 25 min). On creuse donc À LA MAIN, pas à pas, comme
// descendDiagonal (digs manuels + avance pathfinder d'1 bloc), mais ORIENTÉ vers la cible :
//  - tant que la cible est ≥2 blocs plus bas → marche d'escalier descendante (devant-bas + devant) ;
//  - sinon → corridor horizontal (devant + devant-haut) vers l'axe dominant ;
//  - cible au-dessus (>2) → {ok:false, reason:'target_above'} (remonter = pathfinder, pas nous).
// Anti-lave : mêmes 5 sondages que descendDiagonal avant CHAQUE pas ; lave → abandon propre
// (le caller relâche la claim, un autre bot — ou un autre angle — retentera).
const { bestToolFor } = require('../tools');
const { DANGER, VOID } = require('./mineDown');                // mêmes ensembles → 1 source de vérité

let goals;
try { goals = require('mineflayer-pathfinder').goals; } catch (e) { goals = null; }
// Vrai Vec3 pour bot.blockAt (leçon dcd874d / piège #41 : un POJO nu throw .floored en prod —
// c'était LE crash silencieux de la v1 : tunnel_result reason:'error' à chaque approche).
let vec3; try { vec3 = require('vec3'); } catch (e) { vec3 = null; }
function _at(q) { return vec3 ? vec3(q.x, q.y, q.z) : q; }

function isLava(name) { return name === 'lava' || name === 'flowing_lava'; }

function buildGoal(x, y, z) {
  // GoalBlock (exact) et pas GoalNear(1) : range 1 permettait de rester AU-DESSUS de la
  // marche creusée (vécu live : yo-yo 57↔62, jamais de descente nette).
  if (goals && goals.GoalBlock) return new goals.GoalBlock(x, y, z);
  if (goals && goals.GoalNear) return new goals.GoalNear(x, y, z, 1);
  return { x, y, z };
}

/**
 * tunnelTo(bot, target, opts, token) → {ok:true[, cancelled]} | {ok:false, reachedDist, reason}
 * S'arrête à ≤3 blocs de la cible (le collect — portée dig ~6 — prend le relais).
 * reasons : lava_ahead | dig_failed | target_above | max_steps | no_pos
 */
async function tunnelTo(bot, target, opts = {}, token = null) {
  const maxSteps = opts.maxSteps || 320;
  let lastDir = null;   // hystérésis de cap : on garde l'axe tant qu'il reste utile (anti-spirale)
  const dist = () => {
    const p = bot.entity && bot.entity.position;
    if (!p) return Infinity;
    return Math.sqrt((p.x - target.x) ** 2 + (p.y - target.y) ** 2 + (p.z - target.z) ** 2);
  };

  for (let steps = 0; steps < maxSteps; steps++) {
    if (token && token.cancelled) return { ok: true, cancelled: true };
    const p = bot.entity && bot.entity.position;
    if (!p) return { ok: false, reachedDist: Infinity, reason: 'no_pos' };
    if (dist() <= 3) return { ok: true };

    const fx = Math.floor(p.x), fy = Math.floor(p.y), fz = Math.floor(p.z);
    const dxT = Math.floor(target.x) - fx;
    const dyT = Math.floor(target.y) - fy;
    const dzT = Math.floor(target.z) - fz;
    if (dyT > 2 && Math.abs(dxT) <= 2 && Math.abs(dzT) <= 2) {
      return { ok: false, reachedDist: dist(), reason: 'target_above' };
    }

    // Direction cardinale = axe horizontal DOMINANT vers la cible. Si la cible est pile en
    // dessous (pas d'écart horizontal), on garde un cap stable dérivé du pas (jamais creuser
    // droit sous ses pieds — leçon mineDown : le bot off-center ne tombe pas).
    let dir;
    // Hystérésis : si le cap précédent réduit ENCORE la distance sur son axe, on le garde —
    // recalculer l'axe dominant à chaque pas faisait zigzaguer l'escalier (spirale → le bot
    // remontait ses propres marches). On ne tourne que quand l'axe est épuisé.
    if (lastDir && ((lastDir.dx && Math.sign(dxT) === lastDir.dx) || (lastDir.dz && Math.sign(dzT) === lastDir.dz))) {
      dir = lastDir;
    } else if (Math.abs(dxT) >= Math.abs(dzT) && dxT !== 0) dir = { dx: Math.sign(dxT), dz: 0 };
    else if (dzT !== 0) dir = { dx: 0, dz: Math.sign(dzT) };
    else dir = lastDir || { dx: 1, dz: 0 };                   // pile en dessous → cap stable
    lastDir = dir;

    const descending = dyT < -1;

    // Sondages anti-lave (pattern descendDiagonal) : devant, devant-bas, devant-haut,
    // devant×2, devant-bas×2.
    const ahead = { x: fx + dir.dx, y: fy, z: fz + dir.dz };
    const aheadLow = { x: ahead.x, y: fy - 1, z: ahead.z };
    const aheadHigh = { x: ahead.x, y: fy + 1, z: ahead.z };
    const ahead2 = { x: fx + 2 * dir.dx, y: fy, z: fz + 2 * dir.dz };
    const ahead2Low = { x: ahead2.x, y: fy - 1, z: ahead2.z };
    const probes = [ahead, aheadLow, aheadHigh, ahead2, ahead2Low].map((q) => bot.blockAt(_at(q)));
    for (const b of probes) {
      if (b && isLava(b.name)) return { ok: false, reachedDist: dist(), reason: 'lava_ahead' };
    }

    // Cibles à miner : descente = marche (devant-bas + devant) ; horizontal = corridor
    // (devant + devant-haut). La cible du déplacement = la case des PIEDS après le pas.
    const digTargets = descending ? [aheadLow, ahead] : [ahead, aheadHigh];
    const stepCell = descending ? aheadLow : ahead;
    for (const q of digTargets) {
      const t = bot.blockAt(_at(q));
      if (!t) continue;                                       // unloaded → skip
      if (VOID.has(t.name)) continue;                         // déjà air → rien à faire
      if (DANGER.has(t.name)) return { ok: false, reachedDist: dist(), reason: 'lava_ahead' };
      const tool = bestToolFor(bot, t);
      if (tool) { try { await bot.equip(tool, 'hand'); } catch (e) {} }
      try { await bot.dig(t); } catch (e) { return { ok: false, reachedDist: dist(), reason: 'dig_failed' }; }
    }

    // AVANCE d'un pas via pathfinder (seul déplacement fiable en prod, cf. descendDiagonal).
    if (bot.pathfinder && bot.pathfinder.goto) {
      try { await bot.pathfinder.goto(buildGoal(stepCell.x, stepCell.y, stepCell.z)); }
      catch (e) { /* pas raté ponctuel — on retentera au prochain tour */ }
    }
  }

  return { ok: false, reachedDist: dist(), reason: 'max_steps' };
}

module.exports = { tunnelTo };
