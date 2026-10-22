'use strict';
// PILIER ANTI-MÊLÉE (live 22/10, world_oct22) — le geste de joueur contre une grappe de zombies.
//
// Mesuré : NethBot3, 9 morts « slain by Zombie » en 2 min 27 s EN PLEIN JOUR (heure MC ~5000), au
// point de réapparition (93,64,-50) posé par `/spawnpoint` (raison `base`) en lisière de FORÊT
// (`material_found oak_log biome:forest` à 10 blocs) : sous la canopée les zombies ne brûlent pas.
// À chaque réapparition, 2 à 4 zombies à 0,5-1,7 bloc : `spawn_guard hide` → `respawn_flee` → coincé
// → `reflex fight` (nu, épée seule) → mort en ~6 s, l'abri (puits de 3) n'ayant jamais le temps
// d'être creusé.
//
// Un joueur, lui, saute sur 3 blocs de terre : un zombie ne frappe que ce que sa boîte d'attaque
// (sa propre boîte élargie HORIZONTALEMENT) touche — à 2 blocs de haut ses 1,95 de taille ne
// touchent plus les pieds du joueur ; à 3 il y a de la marge. Il frappe vers le bas, attend que la
// grappe se disperse, puis redescend en cassant son pilier.
//
// Ce module est le CERVEAU PUR (aucun bot, aucune horloge en dur) : les décisions. Le geste vit dans
// index.js (meleePillarRun) et réutilise skills/pillarUp.
// ⚠️ Les squelettes et creepers NE déclenchent PAS le pilier (un archer tire mieux sur une cible
// perchée ; un creeper souffle le pilier) : un creeper qui approche FAIT REDESCENDRE (la fuite
// creeper existante prend le relais).
// ⚠️ Doute assumé : l'araignée GRIMPE un pilier. Elle est dans la liste parce que c'est la consigne
// (et qu'au sommet on la frappe vers le bas quand elle arrive) ; à surveiller en live.

const MELEE_MOBS = Object.freeze(new Set([
  'zombie', 'husk', 'zombie_villager', 'drowned', 'spider', 'cave_spider',
  'vindicator', 'piglin_brute',
]));

const PILLAR_TRIGGER_RADIUS = 4;      // ≥ 2 mobs de mêlée à ≤ 4 blocs (3D)…
const PILLAR_MIN_MOBS = 2;
const PILLAR_HEIGHT = 3;              // …on monte de 3
const PILLAR_MIN_HEIGHT = 2;          // 2 suffit contre un zombie (1,95 de haut) : en dessous, échec → fuite
const PILLAR_HOLD_MAX_MS = 90000;     // l'attente au sommet est BORNÉE (règle de vitesse du propriétaire)
const PILLAR_CLEAR_RADIUS = 6;        // la grappe est « partie » quand plus aucun mob de mêlée à ≤ 6 (horizontal)
const PILLAR_CREEPER_RADIUS = 6;      // un creeper à ≤ 6 : on redescend (il soufflerait le pilier)
const PILLAR_STRIKE_REACH = 3.4;      // des yeux au corps du mob (colonne), ≈ portée de frappe vanilla
const PILLAR_FAIL_COOLDOWN_MS = 20000; // pilier raté (pas de bloc posable, pose ratée) : pas de rafale d'essais
const EYE_HEIGHT = 1.62;
const MOB_HEIGHT = 1.95;

const FALLING = new Set(['sand', 'red_sand', 'gravel', 'suspicious_sand', 'suspicious_gravel']);

function _num(v) { return typeof v === 'number' && Number.isFinite(v); }
function _pos(p) { return p && _num(p.x) && _num(p.y) && _num(p.z); }
function _name(e) { return e && typeof e.name === 'string' ? e.name : null; }
function _alive(e) { return !!e && e.isValid !== false && _pos(e.position); }

/** PUR — mobs de mêlée à ≤ `radius` (3D), du plus proche au plus loin : [{ e, name, dist }]. */
function meleeNear(self, entities, radius = PILLAR_TRIGGER_RADIUS) {
  if (!_pos(self) || !Array.isArray(entities)) return [];
  const out = [];
  for (const e of entities) {
    if (!_alive(e) || !MELEE_MOBS.has(_name(e))) continue;
    const p = e.position;
    const d = Math.hypot(p.x - self.x, p.y - self.y, p.z - self.z);
    if (d <= radius) out.push({ e, name: e.name, dist: d });
  }
  return out.sort((a, b) => a.dist - b.dist);
}

/** PUR — nombre de blocs de pilier en poche (items mineflayer { name, count }). */
function scaffoldCount(items, scaffold) {
  if (!Array.isArray(items) || !scaffold) return 0;
  const set = scaffold instanceof Set ? scaffold : new Set(scaffold);
  return items.reduce((n, it) => n + ((it && set.has(it.name) && _num(it.count)) ? it.count : 0), 0);
}

/**
 * PUR — la colonne au-dessus de la tête permet-elle de monter ? `above` = noms des blocs aux étages
 * +2, +3, +4 au-dessus des pieds (null = inconnu/air). Liquide (lave ! eau) ou bloc qui tombe
 * (sable, gravier : pillarUp casse le plafond, ce qui le ferait tomber sur la tête) → non.
 */
function headroomOk(above) {
  if (!Array.isArray(above)) return true;
  for (const n of above) {
    if (typeof n !== 'string') continue;
    if (n === 'lava' || n === 'water' || n.endsWith('_lava')) return false;
    if (FALLING.has(n)) return false;
  }
  return true;
}

/**
 * PUR — faut-il monter en pilier MAINTENANT ?
 * @param {object} o
 *   self {x,y,z}, entities [], fightAdvised (survival.boldFightAdvised déjà évalué), blocks (en poche),
 *   inWater, busy (pilier déjà en cours, abri en cours, véhicule…), headroom (headroomOk déjà évalué),
 *   now, lastFailAt.
 * @returns {{act:'pillar'|'none', reason:string, mobs:number, height:number, nearest:number|null}}
 *   reason : 'melee_crowd' | 'no_position' | 'busy' | 'in_water' | 'few_mobs' | 'fight_advised' |
 *            'no_blocks' | 'headroom' | 'cooldown'.
 */
function meleePillarPlan(o = {}) {
  const opts = (o && typeof o === 'object') ? o : {};
  const minMobs = _num(opts.minMobs) ? opts.minMobs : PILLAR_MIN_MOBS;
  const radius = _num(opts.radius) ? opts.radius : PILLAR_TRIGGER_RADIUS;
  const none = (reason, mobs = 0, nearest = null) => ({ act: 'none', reason, mobs, height: 0, nearest });
  if (!_pos(opts.self)) return none('no_position');
  if (opts.busy) return none('busy');
  const near = meleeNear(opts.self, opts.entities, radius);
  const nearest = near.length ? Math.round(near[0].dist * 10) / 10 : null;
  if (near.length < minMobs) return none('few_mobs', near.length, nearest);
  if (opts.inWater) return none('in_water', near.length, nearest);
  if (opts.fightAdvised) return none('fight_advised', near.length, nearest);
  if (_num(opts.now) && _num(opts.lastFailAt) && opts.lastFailAt > 0
      && opts.now - opts.lastFailAt < PILLAR_FAIL_COOLDOWN_MS) return none('cooldown', near.length, nearest);
  const blocks = _num(opts.blocks) ? Math.floor(opts.blocks) : 0;
  if (blocks < PILLAR_MIN_HEIGHT) return none('no_blocks', near.length, nearest);
  if (opts.headroom === false) return none('headroom', near.length, nearest);
  return { act: 'pillar', reason: 'melee_crowd', mobs: near.length, height: Math.min(PILLAR_HEIGHT, blocks), nearest };
}

/**
 * PUR — l'attente au sommet est-elle finie ?
 * @returns {{done:boolean, why:'clear'|'max'|'creeper'|null, melee:number}}
 *   'clear' : plus aucun mob de mêlée à ≤ clearRadius (horizontal — ils sont en dessous) ;
 *   'creeper' : un creeper à ≤ PILLAR_CREEPER_RADIUS (il soufflerait le pilier : on redescend, la fuite
 *   creeper prend la main) ; 'max' : borne de 90 s.
 */
function pillarHoldStatus(o = {}) {
  const opts = (o && typeof o === 'object') ? o : {};
  const self = opts.self;
  const maxMs = _num(opts.maxMs) ? opts.maxMs : PILLAR_HOLD_MAX_MS;
  const clearR = _num(opts.clearRadius) ? opts.clearRadius : PILLAR_CLEAR_RADIUS;
  let melee = 0, creeper = false;
  if (_pos(self) && Array.isArray(opts.entities)) {
    for (const e of opts.entities) {
      if (!_alive(e)) continue;
      const p = e.position;
      const dh = Math.hypot(p.x - self.x, p.z - self.z);
      if (MELEE_MOBS.has(_name(e)) && dh <= clearR) melee++;
      if (_name(e) === 'creeper' && Math.hypot(dh, p.y - self.y) <= PILLAR_CREEPER_RADIUS) creeper = true;
    }
  }
  if (creeper) return { done: true, why: 'creeper', melee };
  if (melee === 0) return { done: true, why: 'clear', melee };
  if (_num(opts.now) && _num(opts.t0) && opts.now - opts.t0 >= maxMs) return { done: true, why: 'max', melee };
  return { done: false, why: null, melee };
}

/**
 * PUR — le mob de mêlée à frapper depuis le sommet : le plus proche dont le corps (colonne y..y+1,95)
 * est à portée des YEUX du bot. null sinon.
 */
function pillarStrikeTarget(self, entities, reach = PILLAR_STRIKE_REACH) {
  if (!_pos(self) || !Array.isArray(entities)) return null;
  const eyeY = self.y + EYE_HEIGHT;
  let best = null, bestD = Infinity;
  for (const e of entities) {
    if (!_alive(e) || !MELEE_MOBS.has(_name(e))) continue;
    const p = e.position;
    const h = _num(e.height) ? e.height : MOB_HEIGHT;
    const ty = Math.min(Math.max(eyeY, p.y), p.y + h);   // point du corps le plus proche des yeux
    const d = Math.hypot(p.x - self.x, ty - eyeY, p.z - self.z);
    if (d <= reach && d < bestD) { best = e; bestD = d; }
  }
  return best;
}

module.exports = {
  MELEE_MOBS, PILLAR_TRIGGER_RADIUS, PILLAR_MIN_MOBS, PILLAR_HEIGHT, PILLAR_MIN_HEIGHT,
  PILLAR_HOLD_MAX_MS, PILLAR_CLEAR_RADIUS, PILLAR_CREEPER_RADIUS, PILLAR_STRIKE_REACH, PILLAR_FAIL_COOLDOWN_MS,
  meleeNear, scaffoldCount, headroomOk, meleePillarPlan, pillarHoldStatus, pillarStrikeTarget,
};
