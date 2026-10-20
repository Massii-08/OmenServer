'use strict';
// FRAPPE PASSIVE PENDANT LES TÂCHES (« kill aura » d'AltoClef MobDefenseChain, 20/10) — décisions PURES.
//
// Constat : 63 % des morts arrivent pendant la récolte de bois, souvent sous les coups d'un zombie
// COLLÉ au bot qui continue de couper son arbre. Un humain, lui, donne un coup d'épée sans lâcher son
// chantier. Ici : un hostile (pas un creeper, pas un neutre) à portée de coup (≤ 3 blocs) et visible →
// on le frappe (`bot.attack`) en respectant le cooldown d'attaque 1.9+, SANS annuler la tâche ni poser
// de but pathfinder. Le câblage (index.js, tick 250 ms de niveau module) lit le monde ; tout le reste
// est ici, testable sans serveur.

const { MELEE_HOSTILES } = require('./reflexes');

const AURA_REACH = 3;   // blocs : portée de coup vanilla (yeux → hitbox ≈ 3)

// Jamais frappés : le creeper (le toucher au contact = explosion), les neutres (enderman, piglins : les
// provoquer = mort), les golems et joueurs, et ce qu'on a décidé de fuir (NO_MELEE de gather.js).
const AURA_NEVER = new Set([
  'creeper', 'enderman', 'zombified_piglin', 'piglin', 'piglin_brute', 'iron_golem', 'snow_golem',
  'wither_skeleton', 'warden', 'ravager', 'evoker', 'ghast', 'player',
]);

// Vitesse d'attaque (attaques/s, Java 1.9+) → cooldown = 1000 / vitesse.
const AXE_SPEED = { wooden_axe: 0.8, stone_axe: 0.8, iron_axe: 0.9, golden_axe: 1.0, diamond_axe: 1.0, netherite_axe: 1.0 };
const HOE_SPEED = { wooden_hoe: 1, golden_hoe: 1, stone_hoe: 2, iron_hoe: 3, diamond_hoe: 4, netherite_hoe: 4 };

function _speed(name) {
  if (!name) return 4;                         // poing
  if (name.endsWith('_sword')) return 1.6;
  if (AXE_SPEED[name] != null) return AXE_SPEED[name];
  if (name.endsWith('_pickaxe')) return 1.2;
  if (name.endsWith('_shovel')) return 1.0;
  if (HOE_SPEED[name] != null) return HOE_SPEED[name];
  if (name === 'trident') return 1.1;
  return 4;                                    // tout autre objet en main = poing
}

/** PUR — cooldown (ms) avant un coup à pleine puissance avec l'objet `name` en main (null = poing). */
function attackCooldownMs(name) {
  return Math.ceil(1000 / _speed(name));
}

/** PUR — le cooldown est-il écoulé depuis le dernier coup ? */
function cooldownReady(lastHitAt, now, heldName) {
  if (!lastHitAt) return true;
  return now - lastHitAt >= attackCooldownMs(heldName);
}

/** PUR — une arme de mêlée ? (épée ou hache, comme tools.bestWeapon) */
function isWeapon(name) {
  return typeof name === 'string' && (name.endsWith('_sword') || name.endsWith('_axe'));
}

function _isAuraHostile(e) {
  if (!e || e.isValid === false || !e.position) return false;
  if (e.type === 'player' || AURA_NEVER.has(e.name)) return false;
  return e.kind === 'Hostile mobs' || MELEE_HOSTILES.has(e.name);
}

/**
 * PUR — l'hostile à frapper : le plus proche à ≤ `reach` (3D) et visible (`canSee(e)` injecté ; absent =
 * visible ; qui lève = invisible). null sinon.
 */
function auraTarget(entities, self, opts = {}) {
  if (!self || !Array.isArray(entities)) return null;
  const reach = Number.isFinite(opts.reach) ? opts.reach : AURA_REACH;
  const canSee = typeof opts.canSee === 'function' ? opts.canSee : null;
  let best = null, bestD = Infinity;
  for (const e of entities) {
    if (!_isAuraHostile(e)) continue;
    const q = e.position;
    const d = Math.hypot(q.x - self.x, q.y - self.y, q.z - self.z);
    if (!Number.isFinite(d) || d > reach || d >= bestD) continue;
    if (canSee) {
      let seen = false;
      try { seen = !!canSee(e); } catch (err) { seen = false; }
      if (!seen) continue;
    }
    best = e; bestD = d;
  }
  return best;
}

/**
 * PUR — que faire à ce tick ?
 *   { act:'none' }            : pas de cible, pas d'arme, mange, ou déjà en combat mineflayer-pvp ;
 *   { act:'wait' }            : cooldown de l'objet qui frappera pas écoulé ;
 *   { act:'equip' }           : sortir l'arme (jamais pendant un dig : on frappe alors avec ce qu'on
 *                               tient, pour ne pas casser le minage en cours) ;
 *   { act:'hit' }             : frapper avec l'objet tenu.
 * @param {{target, weapon:string|null, held:string|null, digging, eating, pvpTarget, lastHitAt, now}} o
 */
function auraPlan(o = {}) {
  if (!o.target || o.eating || o.pvpTarget) return { act: 'none' };
  const heldIsWeapon = isWeapon(o.held);
  if (!heldIsWeapon && !isWeapon(o.weapon)) return { act: 'none' };   // aucune arme : pas de frappe passive
  // Changer d'objet en main remet le cooldown à zéro (1.9+) : on équipe à ce tick, le coup part quand le
  // cooldown de l'arme est écoulé (le câblage compte l'équipement comme un « dernier coup »).
  if (!heldIsWeapon && !o.digging) return { act: 'equip' };
  if (!cooldownReady(o.lastHitAt, o.now, o.held)) return { act: 'wait' };
  return { act: 'hit' };
}

module.exports = {
  auraTarget, auraPlan, attackCooldownMs, cooldownReady, isWeapon,
  AURA_REACH, AURA_NEVER,
};
