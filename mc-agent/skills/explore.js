'use strict';
// Exploration de surface autonome (0 LLM). Quand une ressource n'est PAS dans le rayon de scan,
// le bot voyage en ANNEAUX EXPANSIFS de waypoints en re-scannant à chaque point, jusqu'à la trouver
// (ou budget épuisé). findBlock ne voit que les chunks chargés → c'est le déplacement physique qui
// charge le terrain. Humanisé (jitter sur les waypoints ∝ profil) pour ne pas quadriller comme un bot.
// Les réflexes de survie (manger/fuir/défendre) restent gérés ailleurs et tournent en parallèle.

// goals.GoalNear : déplacement vers un point à `range` près. Chargé optionnellement (tests legacy).
let goals;
try { goals = require('mineflayer-pathfinder').goals; } catch (e) { goals = null; }
const { directedTarget } = require('../worldMemory');

// Nb de points sur un anneau de rayon r pour garder un espacement d'arc ≤ arcSpacing (recouvrement
// des disques de scan → pas de trou de couverture). Min 4.
function pointsOnRing(r, arcSpacing) {
  return Math.max(4, Math.ceil((2 * Math.PI * r) / arcSpacing));
}

/**
 * Waypoints en anneaux expansifs autour de `origin`, au niveau y de l'origine. Pur & déterministe.
 *  step      : pas radial entre anneaux (déf 80 ; < 2×scanRadius pour recouvrir radialement)
 *  maxRadius : rayon max exploré (déf 256 → garde-fou anti-boucle-infinie)
 *  arcSpacing: espacement cible entre 2 points d'un anneau (déf 100 ; < 2×scanRadius)
 * Les anneaux impairs sont déphasés d'un demi-secteur pour mailler les trous des anneaux pairs.
 */
function nextWaypoints(origin, opts = {}) {
  const step = opts.step || 80;
  const maxRadius = opts.maxRadius || 256;
  const arcSpacing = opts.arcSpacing || 100;
  const ox = origin.x, oy = origin.y, oz = origin.z;
  const wps = [];
  let ring = 0;
  for (let r = step; r <= maxRadius + 1e-9; r += step) {
    ring++;
    const n = pointsOnRing(r, arcSpacing);
    const phase = (ring % 2) * (Math.PI / n);
    for (let k = 0; k < n; k++) {
      const theta = phase + (2 * Math.PI * k) / n;
      wps.push({ x: ox + r * Math.cos(theta), y: oy, z: oz + r * Math.sin(theta), r });
    }
  }
  return wps;
}

function buildNearGoal(x, y, z, range) {
  if (goals && goals.GoalNear) return new goals.GoalNear(x, y, z, range);
  return { x, y, z };
}

/**
 * explore(bot, opts) → {ok:true, found:pos, traveled} | {ok:false, reason:'not_found'|'cancelled'|'no_pos'}
 *  name      : nom du bloc (pour log)            matching : ids findBlock (résolus par l'appelant)
 *  scanRadius: rayon findBlock à chaque waypoint (déf 64)
 *  step/maxRadius : passés à nextWaypoints       profile  : pour movementJitter (sinon bot._mcaProfile)
 *  rng       : injectable (tests)                token    : annulation     emit : hook events (optionnel)
 */
async function explore(bot, opts = {}) {
  const matching = opts.matching !== undefined ? opts.matching : null;
  const scanRadius = opts.scanRadius || 64;
  const step = opts.step || 80;
  const maxRadius = opts.maxRadius || 256;
  const rng = opts.rng || Math.random;
  const token = opts.token || null;
  const emit = opts.emit || null;

  const origin = bot.entity && bot.entity.position;
  if (!origin) return { ok: false, reason: 'no_pos' };
  if (token && token.cancelled) return { ok: false, reason: 'cancelled' };

  const prof = opts.profile || bot._mcaProfile || null;
  const mj = (prof && prof.params && prof.params.movementJitter) || 0.1;
  const jitterMax = step * 0.15 * mj; // petit décalage humain, bien < marge de recouvrement

  // BIAIS DIRIGÉ : si la mémoire de monde du groupe sait où trouver `name`, on y va D'ABORD
  // (associations apprises sinon amorce vanilla) → un bot frais file au bon biome au lieu de chercher
  // à l'aveugle. Lu via bot._worldMemory/_worldKey (posés par index.js au spawn) ou via opts (tests).
  const memory = opts.memory || bot._worldMemory || null;
  const wkey = opts.worldKey || bot._worldKey || null;
  if (memory && wkey) {
    const mats = Array.isArray(opts.name) ? opts.name : (opts.name ? [opts.name] : []);
    let target = null;
    for (const mat of mats) {
      target = directedTarget(memory, wkey, mat, origin, { maxDist: opts.directedMaxDist || 1500 });
      if (target) break;
    }
    if (target) {
      if (emit) { try { emit({ type: 'explore_directed', x: Math.round(target.x), z: Math.round(target.z), biome: target.biome, learned: !!target.learned, cave: !!target.cave }); } catch (e) {} }
      try {
        if (bot.pathfinder && bot.pathfinder.goto) await bot.pathfinder.goto(buildNearGoal(target.x, origin.y, target.z, 8));
        if (token && token.cancelled) return { ok: false, reason: 'cancelled' };
        const hit = bot.findBlock({ matching, maxDistance: scanRadius });
        if (hit) return { ok: true, found: hit.position, traveled: 0, directed: true };
      } catch (e) { /* cible inatteignable → on retombe sur la recherche en anneaux */ }
    }
  }

  const wps = nextWaypoints({ x: origin.x, y: origin.y, z: origin.z }, { step, maxRadius });
  for (const wp of wps) {
    if (token && token.cancelled) return { ok: false, reason: 'cancelled' };
    const gx = wp.x + (rng() * 2 - 1) * jitterMax;
    const gz = wp.z + (rng() * 2 - 1) * jitterMax;
    if (emit) { try { emit({ type: 'explore_waypoint', x: Math.round(gx), z: Math.round(gz), r: Math.round(wp.r) }); } catch (e) {} }
    try {
      if (bot.pathfinder && bot.pathfinder.goto) await bot.pathfinder.goto(buildNearGoal(gx, wp.y, gz, 8));
    } catch (e) { continue; } // waypoint inatteignable (mur/eau/chunk non chargé) → on tente le suivant
    if (token && token.cancelled) return { ok: false, reason: 'cancelled' };
    const block = bot.findBlock({ matching, maxDistance: scanRadius });
    if (block) return { ok: true, found: block.position, traveled: wp.r };
  }
  return { ok: false, reason: 'not_found' };
}

module.exports = { explore, nextWaypoints, pointsOnRing };
