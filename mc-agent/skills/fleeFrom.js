'use strict';
const { goals } = require('mineflayer-pathfinder');
const { MELEE_HOSTILES } = require('../reflexes');
// Fuit le HOSTILE le plus proche (GoalInvert : s'éloigner d'un rayon autour de lui).
// Avant : fuyait N'IMPORTE quel mob — y compris une vache (fuite absurde, vécu diagnostic).

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

/**
 * PUR — point de fuite : à FLEE_DIST blocs, exactement à l'opposé de la menace (même altitude).
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

/** Fait fuir le bot loin du HOSTILE le plus proche. Retourne false s'il n'y a aucun hostile. */
function fleeFrom(bot) {
  const threat = bot.nearestEntity((e) => e && e.position && isFleeHostile(e));
  if (!threat) return false;
  // ⚠️ SURTOUT PAS de GoalInvert ici (2 crashes OOM en prod, world_ax4 25/07) : son heuristique
  // vaut -distance, donc s'éloigner d'un bloc ajoute 1 à g et retire 1 à h — la somme `g+h` reste
  // CONSTANTE et l'élagage d'astar.js (`g + h > maxCost`) ne se déclenche JAMAIS. L'A* explore
  // alors indéfiniment quand la fuite est impossible (bot acculé) → 2 Go de heap en quelques
  // secondes. Aucun searchRadius ne peut rattraper ça : il faut un but qui TERMINE.
  // Une destination concrète a une heuristique positive et décroissante → A* fini et bornable.
  const dest = fleeTarget(bot.entity.position, threat.position);
  // dynamic=false : la destination est figée. Un but dynamique se recalculerait sur une menace
  // qui poursuit → on repartirait dans une course sans fin.
  bot.pathfinder.setGoal(new goals.GoalNear(dest.x, dest.y, dest.z, 2), false);
  return true;
}

module.exports = { fleeFrom, fleeTarget, isFleeHostile, HOSTILE, FLEE_DIST };
