'use strict';
// ─── RÉPONSE AU SQUELETTE (22/10, chrono « de zéro » en Hard) ─────────────────────────────────────
// Mesure live (12 min, mineurs NethBot1-3 peu armés) : 4 morts de mineurs sur 6 = « was shot by
// Skeleton », y compris de jour. Séquences : `aura_hit {mob:skeleton, dist:2.8}` → `fight_refused
// low_hp` → `reflex flee` → mort ; ou `take_cover ok` → `reflex flee` → mort ; ou `death_camp_flee
// via:foot` à 1,5 PV. Un squelette tire à ~15 blocs et vise la position courante : FUIR À DÉCOUVERT
// dans son champ = se faire tuer dans le dos. Ce que fait un joueur :
//   - il est proche (≤ 8 blocs) et on a de quoi frapper → on FONCE dessus en zigzag et on le tue ;
//   - sinon on CASSE LA LIGNE DE VUE : un pas derrière un coin / un arbre (cover), à défaut on pose
//     1-2 blocs entre lui et soi (block) — et on RESTE derrière, on ne repart pas en courant ;
//   - on ne fuit (ranged-aware, cf. fleeFrom) qu'en dernier recours ou face à une mêlée mixte.
// Décisions PURES ici (aucun accès au bot) ; l'exécution vit dans index.js (skeletonRespond).
const { hasLineOfSight } = require('./threatgate');

const RUSH_DIST = 8;          // blocs : au-delà, la course sous les flèches coûte plus qu'elle ne rapporte
const CONTACT_DIST = 3.5;     // blocs : déjà au corps-à-corps — reculer = offrir des tirs gratuits
const RUSH_MIN_HP_CONTACT = 6;
const RUSH_MIN_HP_CLOSE = 10;
const RUSH_DESPERATE_HP = 4;  // sans couvert possible : courir dessus vaut mieux que courir devant lui
const RUSH_FLOOR_HP = 4;
const MIN_WEAPON_DMG = 4;     // épée/hache de bois et mieux (attackDamage AltoClef) ; poing = 1
const COVER_RADIUS = 3;       // cases cherchées autour du bot pour tourner un coin
const SHOOTER_EYE = 1.5;
const BOT_EYE = 1.62;
const BOT_CHEST = 1.0;

function _num(x) { return typeof x === 'number' && Number.isFinite(x); }

/** PUR — PV minimum pour foncer sur un squelette à `dist` blocs (bouclier/armure abaissent le seuil). */
function rushMinHp({ dist, hasShield, armorPoints } = {}) {
  let hp = _num(dist) && dist <= CONTACT_DIST ? RUSH_MIN_HP_CONTACT : RUSH_MIN_HP_CLOSE;
  if (hasShield) hp -= 2;
  if (_num(armorPoints) && armorPoints >= 8) hp -= 2;
  return Math.max(RUSH_FLOOR_HP, hp);
}

/**
 * PUR — que faire face à un squelette ? Rend { action, reason } avec action ∈ rush | cover | block | flee.
 * @param {{dist:number, los:boolean, health:number, armorPoints:number, attackDamage:number,
 *          hasShield:boolean, hasBlock:boolean, meleeOthers:number, shooters:number,
 *          inWater:boolean, coverCell:boolean}} s
 */
function decideSkeletonResponse(s = {}) {
  if (s.inWater) return { action: 'flee', reason: 'water' };
  if (_num(s.meleeOthers) && s.meleeOthers > 0) return { action: 'flee', reason: 'melee_mix' };
  const dist = _num(s.dist) ? s.dist : 99;
  const hp = _num(s.health) ? s.health : 20;
  const armed = _num(s.attackDamage) && s.attackDamage >= MIN_WEAPON_DMG;
  // AU CONTACT (live 23/10 : `cover no_los` à 2 blocs pendant 6 s, puis mort) : un squelette à portée
  // de coup fait le tour d'un muret d'un pas ; rester planté = attendre la flèche. On frappe — à l'épée,
  // et sans arme au poing / à la pioche plutôt que rien. Ligne de vue et PV ne changent rien ici.
  if (dist <= CONTACT_DIST) return { action: 'rush', reason: armed ? 'contact' : 'contact_unarmed' };
  // « caché » démenti par une flèche reçue : on raisonne comme s'il nous voyait.
  if (s.los === false && !s.hurt) return { action: 'cover', reason: 'no_los' };
  const solo = !_num(s.shooters) || s.shooters <= 1;
  const close = dist <= RUSH_DIST;
  if (solo && armed && close && hp >= rushMinHp({ dist, hasShield: s.hasShield, armorPoints: s.armorPoints })) {
    return { action: 'rush', reason: dist <= CONTACT_DIST ? 'contact' : 'close' };
  }
  if (s.coverCell) return { action: 'cover', reason: 'corner' };
  if (s.hasBlock) return { action: 'block', reason: 'wall' };
  if (solo && armed && close && hp >= RUSH_DESPERATE_HP) return { action: 'rush', reason: 'no_cover' };
  return { action: 'flee', reason: 'no_option' };
}

/**
 * PUR — la case la plus proche (≤ radius) où le bot, debout, est HORS de la vue du tireur : yeux ET
 * poitrine masqués par un bloc plein. Case debout = pieds et tête libres, sol plein dessous (jamais
 * au-dessus du vide). La case actuelle du bot est exclue. `isSolid(x,y,z)` injecté. Rend
 * {x,y,z,dist} (coordonnées entières de la case) ou null.
 */
function findCoverCell({ from, shooter, isSolid, blockAt: preciseBlockAt, radius = COVER_RADIUS } = {}) {
  if (!from || !shooter || typeof isSolid !== 'function') return null;
  if (![from.x, from.y, from.z, shooter.x, shooter.y, shooter.z].every(Number.isFinite)) return null;
  const solid = (x, y, z) => { try { return !!isSolid(x, y, z); } catch (e) { return false; } };
  const blockAt = (q) => (solid(q.x, q.y, q.z) ? { boundingBox: 'block' } : null);
  const bx = Math.floor(from.x), by = Math.floor(from.y), bz = Math.floor(from.z);
  const eyeS = { x: shooter.x, y: shooter.y + SHOOTER_EYE, z: shooter.z };
  const cands = [];
  for (let dx = -radius; dx <= radius; dx++) {
    for (let dz = -radius; dz <= radius; dz++) {
      const hd = Math.hypot(dx, dz);
      if (hd > radius + 1e-9) continue;
      for (let dy = -1; dy <= 1; dy++) {
        if (dx === 0 && dz === 0 && dy === 0) continue;
        const x = bx + dx, y = by + dy, z = bz + dz;
        if (solid(x, y, z) || solid(x, y + 1, z) || !solid(x, y - 1, z)) continue;
        cands.push({ x, y, z, dist: Math.hypot(dx, dy, dz),
          away: Math.hypot(x + 0.5 - shooter.x, z + 0.5 - shooter.z) });
      }
    }
  }
  cands.sort((a, b) => (a.dist - b.dist) || (b.away - a.away));
  for (const c of cands) {
    // `blockAt` précis fourni (index.js) : même modèle que shooterSees (collider réel, yeux/poitrine/
    // jambes) — une case « cachée » par une dalle n'en est pas une. Sinon : modèle cases pleines.
    if (typeof preciseBlockAt === 'function') {
      if (!shooterSees({ shooter, target: { x: c.x + 0.5, y: c.y, z: c.z + 0.5 }, blockAt: preciseBlockAt })) {
        return { x: c.x, y: c.y, z: c.z, dist: c.dist };
      }
      continue;
    }
    const eye = { x: c.x + 0.5, y: c.y + BOT_EYE, z: c.z + 0.5 };
    const chest = { x: c.x + 0.5, y: c.y + BOT_CHEST, z: c.z + 0.5 };
    if (!hasLineOfSight(eyeS, eye, blockAt) && !hasLineOfSight(eyeS, chest, blockAt)) {
      return { x: c.x, y: c.y, z: c.z, dist: c.dist };
    }
  }
  return null;
}

// Points visés sur le bot (hauteur au-dessus des pieds) : yeux, poitrine, jambes — un squelette vanilla
// tire vers le tiers bas du corps ; vu par UN SEUL de ces points = vu.
const TARGET_POINTS = [1.62, 1.0, 0.3];
const SKELETON_EYE = 1.74;

/** Un bloc arrête-t-il le point (x,y,z) ? Collider PRÉCIS : une dalle, un escalier, une barrière, un
 *  stalactite ne masquent que leur forme, pas la case entière (l'ancien test « case pleine » prenait
 *  toute case `boundingBox:block` pour un mur). Sans formes connues : case pleine. */
function _blocksPoint(b, x, y, z) {
  if (!b || b.boundingBox !== 'block') return false;
  const shapes = Array.isArray(b.shapes) ? b.shapes : null;
  if (!shapes || !shapes.length) return true;
  const lx = x - Math.floor(x), ly = y - Math.floor(y), lz = z - Math.floor(z);
  return shapes.some((s) => Array.isArray(s) && s.length >= 6
    && lx >= s[0] && lx <= s[3] && ly >= s[1] && ly <= s[4] && lz >= s[2] && lz <= s[5]);
}

function _segmentClear(a, b, blockAt, skip) {
  const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
  const len = Math.hypot(dx, dy, dz);
  if (len < 1e-6) return true;
  const n = Math.ceil(len / 0.1);
  for (let i = 1; i < n; i++) {
    const t = i / n;
    const x = a.x + dx * t, y = a.y + dy * t, z = a.z + dz * t;
    const cx = Math.floor(x), cy = Math.floor(y), cz = Math.floor(z);
    if (skip.has(cx + ',' + cy + ',' + cz)) continue;
    if (_blocksPoint(blockAt({ x: cx, y: cy, z: cz }), x, y, z)) return false;
  }
  return true;
}

/**
 * PUR — le tireur (pieds en `shooter`) VOIT-il le bot (pieds en `target`) ? Rayons depuis l'ŒIL du
 * squelette (+1,74) vers les yeux, la poitrine et les jambes du bot ; collider précis des blocs ; les
 * cases occupées par les deux corps sont ignorées. En cas de doute (donnée manquante, erreur de
 * lecture) → true : on ne se croit JAMAIS caché par défaut (l'ancien canSeeEntityNow rendait false sur
 * erreur, et un faux « caché » laisse le bot planté sous les flèches).
 */
function shooterSees({ shooter, target, blockAt, shooterEye = SKELETON_EYE } = {}) {
  try {
    if (!shooter || !target || typeof blockAt !== 'function') return true;
    if (![shooter.x, shooter.y, shooter.z, target.x, target.y, target.z].every(Number.isFinite)) return true;
    const eye = { x: shooter.x, y: shooter.y + shooterEye, z: shooter.z };
    const skip = new Set();
    for (const p of [shooter, target]) {
      for (const h of [0, 1]) skip.add(Math.floor(p.x) + ',' + (Math.floor(p.y) + h) + ',' + Math.floor(p.z));
    }
    return TARGET_POINTS.some((h) => _segmentClear(eye, { x: target.x, y: target.y + h, z: target.z }, blockAt, skip));
  } catch (e) { return true; }
}

// ─── CHARGE PROTÉGÉE (23/10) ───────────────────────────────────────────────────────────────────────
// Live : les 7 charges du run finissent `killed:false` ; NethBot1 perd 9 PV en 3,5 s de rush pendant
// que le planner relance `iron_deep` (qui coupe pvp) et que le réflexe « manger » rengaine l'épée 3 fois.
const RUSH_ABORT_HP = 3;      // PV sous lesquels on lâche une charge qui n'a pas encore atteint la cible
const RUSH_EAT_FOOD = 6;      // faim au-delà de laquelle on ne mange pas pendant une charge

/** PUR — pourquoi la charge s'arrête maintenant (killed | preempted | target_lost | timeout | hp_floor) ou null. */
function rushStopReason({ elapsedMs, maxMs, alive, targetOurs, cancelled, hp, dist } = {}) {
  if (alive === false) return 'killed';
  if (cancelled) return 'preempted';
  if (targetOurs === false) return 'target_lost';
  if (_num(elapsedMs) && _num(maxMs) && elapsedMs >= maxMs) return 'timeout';
  if (_num(hp) && hp <= RUSH_ABORT_HP && _num(dist) && dist > CONTACT_DIST) return 'hp_floor';
  return null;
}

/** PUR — manger est-il permis ? Hors charge : oui. En charge : seulement faim ≤ 6 ET PV qui ne baissent pas. */
function eatDuringRush({ rushing, food, hpFalling } = {}) {
  if (!rushing) return true;
  return _num(food) && food <= RUSH_EAT_FOOD && !hpFalling;
}

/** PUR — nom de la 1re fonction d'une pile qui ne correspond à aucun motif `skip` (diagnostic `by`). */
function callerFromStack(stack, skip = []) {
  if (typeof stack !== 'string' || !stack) return null;
  for (const line of stack.split('\n').slice(1)) {
    const m = line.match(/^\s*at (?:async )?([^\s(]+)/);
    if (!m) continue;
    const name = m[1];
    if (skip.some((k) => name.includes(k))) continue;
    if (name === 'new' || name === '<anonymous>') continue;
    return name;
  }
  return null;
}

/** PUR — côté du pas de zigzag à `elapsedMs` depuis le début de la charge (alterne chaque période). */
function zigzagSide(elapsedMs, periodMs = 400) {
  const k = Math.floor(Math.max(0, elapsedMs || 0) / Math.max(1, periodMs));
  return k % 2 === 0 ? 'left' : 'right';
}

module.exports = {
  decideSkeletonResponse, rushMinHp, findCoverCell, zigzagSide, shooterSees,
  rushStopReason, eatDuringRush, callerFromStack, RUSH_ABORT_HP, RUSH_EAT_FOOD,
  RUSH_DIST, CONTACT_DIST, RUSH_MIN_HP_CONTACT, RUSH_MIN_HP_CLOSE, RUSH_DESPERATE_HP, MIN_WEAPON_DMG, COVER_RADIUS,
};
