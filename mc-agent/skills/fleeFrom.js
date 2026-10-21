'use strict';
const { goals } = require('mineflayer-pathfinder');
const { Vec3 } = require('vec3');
const { MELEE_HOSTILES } = require('../reflexes');
// Fuit le HOSTILE le plus proche : destination CONCRÈTE à FLEE_DIST blocs à l'opposé, visée en but XZ
// (jamais de GoalInvert, cf. fleeFrom). Avant : fuyait N'IMPORTE quel mob — y compris une vache
// (fuite absurde, vécu diagnostic).

// Hostiles à fuir : mêlée (reflexes) + creeper + tireurs/volants. JAMAIS les passifs.
const HOSTILE = new Set([...MELEE_HOSTILES,
  'creeper', 'ghast', 'blaze', 'phantom', 'shulker', 'guardian', 'elder_guardian',
  'evoker', 'ravager', 'warden', 'vex', 'illusioner']);

/** PUR : cette entité est-elle un hostile qu'on fuit/craint ? (kind mineflayer OU nom listé). */
function isFleeHostile(e) {
  return !!(e && (e.kind === 'Hostile mobs' || HOSTILE.has(e.name)));
}

// Distance de décrochage. 20 blocs sortent de la portée d'arc utile d'un squelette et de l'agro
// de mêlée, sans envoyer le bot à l'autre bout de la carte.
const FLEE_DIST = 20;

// Rayon du but de fuite. Le but est un DISQUE XZ posé sur une altitude inconnue : 3 (et non 2) laisse un
// peu de marge pour qu'un arbre ou un rocher pile sur le point d'arrivée ne le rende pas insatisfiable.
const FLEE_GOAL_RANGE = 3;

/**
 * PUR — point de fuite : à FLEE_DIST blocs, exactement à l'opposé de la menace.
 * Le `y` renvoyé est celui de DÉPART et reste INFORMATIF : fleeFrom ne vise que (x, z), l'altitude de
 * la surface à FLEE_DIST blocs étant inconnue (cf. GoalNearXZ dans fleeFrom).
 * @returns {{x:number,y:number,z:number}|null}
 */
function fleeTarget(from, threat, dist = FLEE_DIST) {
  if (!from || !threat) return null;
  let dx = from.x - threat.x;
  let dz = from.z - threat.z;
  let len = Math.hypot(dx, dz);
  if (!len || !Number.isFinite(len)) { dx = 1; dz = 0; len = 1; }   // même colonne : cap arbitraire
  return { x: from.x + (dx / len) * dist, y: from.y, z: from.z + (dz / len) * dist };
}

// TIREURS (live 21/10 : 13 morts de cartographes sur 26 en 2 h « shot by Skeleton/Pillager »).
// Fuir en ligne droite dans l'axe du tir laisse le bot dans la ligne de mire : un squelette vise la
// position COURANTE (pas d'anticipation), donc s'écarter en BIAIS esquive les flèches, et passer derrière
// un relief/arbre CASSE la ligne de vue — il cesse de tirer. Ce que fait un vrai joueur nu.
const RANGED_SHOOTERS = new Set(['skeleton', 'stray', 'bogged', 'pillager']);
const RANGED_ALERT = 24;          // au-delà, un tireur n'est pas la menace qui dicte la fuite
// Caps de fuite, en degrés depuis l'axe « dos au tireur » : biais d'abord (esquive), plein dos en dernier.
const RANGED_ANGLES = [60, -60, 90, -90, 35, -35, 120, -120, 0];
const MELEE_KEEP = 6;             // un cap qui finit à < 6 blocs d'un mob de mêlée est écarté

/**
 * PUR — point de fuite face à un TIREUR. `losBlocked(shooterEye, destEye)` → true si un bloc plein coupe
 * la ligne de vue (injecté : index/fleeFrom l'échantillonne sur le monde). Choix : le 1er cap (dans
 * l'ordre RANGED_ANGLES) dont l'arrivée est HORS de la vue du tireur et loin des mobs de mêlée ; sinon
 * le 1er cap en BIAIS (60°) praticable ; sinon plein dos. Rend { x, y, z, angle, covered }.
 */
function rangedFleeTarget(from, shooter, opts = {}) {
  if (!from || !shooter) return null;
  const dist = opts.dist || FLEE_DIST;
  const melee = Array.isArray(opts.melee) ? opts.melee : [];
  const blocked = typeof opts.losBlocked === 'function' ? opts.losBlocked : null;
  let dx = from.x - shooter.x;
  let dz = from.z - shooter.z;
  if (!Math.hypot(dx, dz)) { dx = 1; dz = 0; }
  const base = Math.atan2(dz, dx);
  const eyeS = { x: shooter.x, y: shooter.y + 1.5, z: shooter.z };
  let firstOk = null;
  for (const deg of RANGED_ANGLES) {
    const a = base + deg * Math.PI / 180;
    const d = { x: from.x + Math.cos(a) * dist, y: from.y, z: from.z + Math.sin(a) * dist };
    if (melee.some((m) => m && Math.hypot(m.x - d.x, m.z - d.z) < MELEE_KEEP)) continue;
    let covered = false;
    if (blocked) { try { covered = !!blocked(eyeS, { x: d.x, y: d.y + 1.6, z: d.z }); } catch (e) { covered = false; } }
    if (covered) return Object.assign(d, { angle: deg, covered: true });
    if (!firstOk) firstOk = Object.assign(d, { angle: deg, covered: false });
  }
  if (firstOk) return firstOk;
  const t = fleeTarget(from, shooter, dist);
  return t && Object.assign(t, { angle: 0, covered: false });
}

/** Un bloc plein coupe-t-il le segment a→b ? Échantillonné tous les 0,5 bloc (≤ 60 lectures). */
function losBlockedOnWorld(bot, a, b) {
  const len = Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
  const n = Math.min(60, Math.max(1, Math.ceil(len / 0.5)));
  for (let i = 1; i < n; i++) {
    const t = i / n;
    let blk = null;
    try {
      blk = bot.blockAt(new Vec3(Math.floor(a.x + (b.x - a.x) * t), Math.floor(a.y + (b.y - a.y) * t), Math.floor(a.z + (b.z - a.z) * t)));
    } catch (e) { blk = null; }
    if (blk && blk.boundingBox === 'block') return true;
  }
  return false;
}

/** Fait fuir le bot loin du HOSTILE le plus proche. Retourne false s'il n'y a aucun hostile. */
function fleeFrom(bot) {
  const threat = bot.nearestEntity((e) => e && e.position && isFleeHostile(e));
  if (!threat) return false;
  // Un TIREUR à portée dicte la fuite (cap en biais / derrière un couvert) même si un mob de mêlée est
  // plus près — en écartant les caps qui finissent dans ses bras.
  try {
    const me = bot.entity.position;
    const shooter = bot.nearestEntity((e) => e && e.position && RANGED_SHOOTERS.has(e.name)
      && e.position.distanceTo && e.position.distanceTo(me) <= RANGED_ALERT);
    if (shooter) {
      const melee = Object.values(bot.entities || {})
        .filter((e) => e && e.position && e !== shooter && isFleeHostile(e) && !RANGED_SHOOTERS.has(e.name)
          && Math.hypot(e.position.x - me.x, e.position.z - me.z) <= 16)
        .map((e) => ({ x: e.position.x, z: e.position.z }));
      const dest = rangedFleeTarget(me, shooter.position, { melee, losBlocked: (a, b) => losBlockedOnWorld(bot, a, b) });
      if (dest) {
        bot.pathfinder.setGoal(new goals.GoalNearXZ(dest.x, dest.z, FLEE_GOAL_RANGE), false);
        return true;
      }
    }
  } catch (e) { /* repli : fuite historique ci-dessous */ }
  // ⚠️ SURTOUT PAS de GoalInvert ici (2 crashes OOM en prod, world_ax4 25/07) : son heuristique
  // vaut -distance, donc s'éloigner d'un bloc ajoute 1 à g et retire 1 à h — la somme `g+h` reste
  // CONSTANTE et l'élagage d'astar.js (`g + h > maxCost`) ne se déclenche JAMAIS. L'A* explore
  // alors indéfiniment quand la fuite est impossible (bot acculé) → 2 Go de heap en quelques
  // secondes. Aucun searchRadius ne peut rattraper ça : il faut un but qui TERMINE.
  // Une destination concrète a une heuristique positive et décroissante → A* fini et bornable.
  const dest = fleeTarget(bot.entity.position, threat.position);
  // But XZ (GoalNearXZ) : l'altitude de la surface à FLEE_DIST blocs est INCONNUE. L'ancien
  // GoalNear(dest.x, from.y, dest.z, 2) était une sphère 3D à l'altitude de DÉPART : sur une pente elle
  // tombe en l'air ou dans la roche → NoPath, et comme on ne fait que `setGoal` (rien à attendre)
  // l'échec est SILENCIEUX — le bot reste planté sous les coups. XZ ne contraint que x,z (atteignable à
  // n'importe quelle altitude) et reste un but CONCRET : heuristique positive et décroissante, A* fini.
  // dynamic=false : la destination est figée. Un but dynamique se recalculerait sur une menace
  // qui poursuit → on repartirait dans une course sans fin.
  bot.pathfinder.setGoal(new goals.GoalNearXZ(dest.x, dest.z, FLEE_GOAL_RANGE), false);
  return true;
}

module.exports = { fleeFrom, fleeTarget, rangedFleeTarget, losBlockedOnWorld, isFleeHostile, HOSTILE, FLEE_DIST, FLEE_GOAL_RANGE, RANGED_SHOOTERS, RANGED_ANGLES };
