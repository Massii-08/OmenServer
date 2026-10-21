'use strict';
// DÉFENSE EN TUNNEL — se battre ou se murer DANS le couloir, au lieu de fuir dans le noir.
//
// Run du 21/10 soir (world_oct9, chrono 20:14 → 23:14) : pendant `iron_deep` (branch-mine Y16),
// NethBot2 8 morts et NethBot3 6. Ventilation des 60 s qui précèdent chacune (session-*.jsonl) :
//   - 5/14 « combat puis fuite » : le bot se bat (canDealWith 6-7, PV 19-20) contre 1 à 3 zombies dans
//     son couloir, descend sous le seuil, `reflex: flee` → il PART en courant dans un tunnel noir
//     (torches `light: 0`) et meurt 1 à 4 s plus tard, rattrapé ou pris par le mob suivant
//     (NethBot2 19:07:50, 19:23:44, 20:16:44 ; NethBot3 19:07:45, 19:23:32).
//   - le réflexe de fuite part en même temps que le panic-wall (onPanic) : le mur se pose… et la fuite
//     fait ressortir le bot de sa propre boîte.
// Un joueur fait l'inverse : dans un couloir 1×2 un seul mob passe à la fois — armé, il tient la
// position et frappe ; à bout de PV ou désarmé, il pose deux blocs entre lui et le mob, mange, et
// rouvre plus tard. Courir dans le noir, c'est aller chercher le mob suivant.
//
// Module PUR : la géométrie arrive par une fonction `solidAt(dx, dy, dz)` (relative aux pieds du bot),
// les hostiles par des positions RELATIVES. Testable sans serveur.

const CARDINALS = Object.freeze([
  Object.freeze({ dx: 1, dz: 0 }), Object.freeze({ dx: -1, dz: 0 }),
  Object.freeze({ dx: 0, dz: 1 }), Object.freeze({ dx: 0, dz: -1 }),
]);

const TUNNEL_MAX_Y = 50;          // au-dessus : surface / falaise, la fuite reste la règle
const HOLD_MIN_HP = 8;            // tenir la position seulement avec de la marge (un zombie hard tape 3-4)
const HOLD_MIN_FOOD = 7;          // ≤ 6 : régén coupée et sprint coupé — on ne s'éternise pas
const THREAT_RADIUS = 10;         // un hostile plus loin ne dicte rien
const CREEPER_WALL_RADIUS = 7;    // creeper qui approche : on lui coupe le chemin
const RANGED = new Set(['skeleton', 'stray', 'bogged', 'pillager', 'blaze', 'ghast', 'witch']);

/** Cap cardinal dominant d'un vecteur relatif (x, z) ; null pour un vecteur nul. */
function cardinalOf(x, z) {
  if (!Number.isFinite(x) || !Number.isFinite(z) || (x === 0 && z === 0)) return null;
  if (Math.abs(x) >= Math.abs(z)) return { dx: Math.sign(x), dz: 0 };
  return { dx: 0, dz: Math.sign(z) };
}

/**
 * PUR — le bot est-il dans un COULOIR ? `solidAt(dx,dy,dz)` → true si le bloc relatif aux pieds est plein.
 * Couloir = pieds et tête libres, plafond plein, et au plus 2 côtés cardinaux ouverts (les autres murés
 * aux deux hauteurs). Rend { tunnel, open: [{dx,dz}] } — `open` = côtés où pieds ET tête sont libres.
 */
function tunnelShape(solidAt) {
  const s = (dx, dy, dz) => { try { return !!solidAt(dx, dy, dz); } catch (e) { return false; } };
  if (s(0, 0, 0) || s(0, 1, 0)) return { tunnel: false, open: [] };
  const roof = s(0, 2, 0);
  const open = [];
  let walled = 0;
  for (const c of CARDINALS) {
    const feet = s(c.dx, 0, c.dz);
    const head = s(c.dx, 1, c.dz);
    if (!feet && !head) open.push({ dx: c.dx, dz: c.dz });
    else if (feet && head) walled++;
  }
  return { tunnel: roof && open.length <= 2 && walled >= 2, open };
}

/**
 * PUR — que faire face aux hostiles proches quand on est sous terre ?
 * s = { y, skyLight, shape: {tunnel, open}, health, food, armed, hasBlocks,
 *       hostiles: [{ name, x, z, dist }] (x,z RELATIFS au bot) }
 * → { action: 'hold'|'wall'|null, seal: [{dx,dz}], target: index|null, reason }
 *   - null  : rien de spécial, la fuite habituelle reste la règle (surface, grotte ouverte…) ;
 *   - hold  : se battre sur place (cible = hostile de mêlée le plus proche) ;
 *   - wall  : murer les côtés listés dans `seal` (pieds + tête), puis manger.
 */
function tunnelDefensePlan(s = {}) {
  const none = (reason) => ({ action: null, seal: [], target: null, reason });
  const shape = s.shape || { tunnel: false, open: [] };
  if (!(Number.isFinite(s.y) && s.y < TUNNEL_MAX_Y)) return none('surface');
  if (Number(s.skyLight) > 0) return none('sky');
  if (!shape.tunnel) return none('not_tunnel');
  const hostiles = (Array.isArray(s.hostiles) ? s.hostiles : [])
    .filter((h) => h && Number.isFinite(h.dist) && h.dist <= THREAT_RADIUS)
    .sort((a, b) => a.dist - b.dist);
  if (!hostiles.length) return none('no_threat');
  const open = Array.isArray(shape.open) ? shape.open : [];
  const sameDir = (a, b) => a && b && a.dx === b.dx && a.dz === b.dz;
  // Côtés ouverts d'où vient une menace ; une menace « derrière un mur » arrive forcément par un côté ouvert.
  const facing = [];
  for (const h of hostiles) {
    const d = cardinalOf(h.x, h.z);
    const o = open.find((c) => sameDir(c, d));
    if (o && !facing.some((f) => sameDir(f, o))) facing.push(o);
  }
  const seal = facing.length ? facing : open.slice();
  const canWall = !!s.hasBlocks && seal.length > 0;

  const creeper = hostiles.find((h) => h.name === 'creeper' && h.dist <= CREEPER_WALL_RADIUS);
  if (creeper) return canWall ? { action: 'wall', seal, target: null, reason: 'creeper' } : none('creeper_no_block');
  const melee = hostiles.filter((h) => !RANGED.has(h.name) && h.name !== 'creeper');
  if (!melee.length) {
    // Que des tireurs : se battre au corps à corps à travers un couloir = encaisser toutes les flèches.
    return canWall ? { action: 'wall', seal, target: null, reason: 'ranged' } : none('ranged_no_block');
  }
  const fed = !Number.isFinite(s.food) || s.food >= HOLD_MIN_FOOD;
  if (s.armed && Number.isFinite(s.health) && s.health > HOLD_MIN_HP && fed) {
    return { action: 'hold', seal: [], target: hostiles.indexOf(melee[0]), reason: 'armed' };
  }
  if (canWall) return { action: 'wall', seal, target: null, reason: s.armed ? 'low_hp' : 'unarmed' };
  return none('no_block');
}

module.exports = {
  cardinalOf, tunnelShape, tunnelDefensePlan, CARDINALS,
  TUNNEL_MAX_Y, HOLD_MIN_HP, HOLD_MIN_FOOD, THREAT_RADIUS, CREEPER_WALL_RADIUS, RANGED,
};
