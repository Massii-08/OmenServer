'use strict';
// DISCIPLINE DE TORCHE — calée sur une capture RÉELLE de partie à deux (Massitom2008 ×
// alexdon1837, 33 min, jusqu'au diamant + portail du nether, 26/07).
//
// Mesuré chez les humains : **131 et 97 torches posées en 33 minutes** (≈ 3-4 par minute), torche
// en main ~10 % du temps. Ils éclairent SYSTÉMATIQUEMENT ce qu'ils traversent.
// Le bot, lui, ne posait de torche que dans le tunnel de branch-mine (`torchEvery`) — le reste de
// sa vie souterraine (descente, récolte, déplacements) se passait dans le noir, or block-light 0
// est la condition EXACTE d'apparition des mobs. C'est le poste n°1 des 235 morts du run.
//
// Décision PURE et bornée ; la pose (bot.placeBlock) reste côté appelant.

const TORCH_INTERVAL_MS = 12000;   // ~3-5 torches/min en déplacement, comme dans la capture
const TORCH_MIN_MOVE = 6;          // blocs — inutile d'en empiler au même endroit
const SURFACE_Y = 50;              // au-dessus, la lumière du ciel fait le travail de jour
const DARK_LEVEL = 7;              // un mob apparaît dès que la lumière de bloc tombe à 0 ; on
                                   // garde une marge : sous 8, la zone est « à éclairer »

/**
 * PUR — faut-il poser une torche maintenant ?
 * @param {{y:number, lightLevel:number|null, torches:number, now:number,
 *          lastAt:number, pos:{x,z}, lastPos:{x,z}|null, opts?:object}} s
 * @returns {boolean}
 */
function shouldPlaceTorch(s) {
  const o = s || {};
  if (!o.torches || o.torches < 1) return false;              // rien à poser
  const opts = o.opts || {};
  const surfaceY = opts.surfaceY === undefined ? SURFACE_Y : opts.surfaceY;
  if (typeof o.y === 'number' && o.y > surfaceY) return false; // en surface, le ciel suffit
  // Lumière : si on la connaît et qu'elle est correcte, ne rien gaspiller.
  const dark = opts.darkLevel === undefined ? DARK_LEVEL : opts.darkLevel;
  if (typeof o.lightLevel === 'number' && o.lightLevel > dark) return false;
  const interval = opts.intervalMs === undefined ? TORCH_INTERVAL_MS : opts.intervalMs;
  if (typeof o.lastAt === 'number' && (o.now - o.lastAt) < interval) return false;
  // Anti-empilement : il faut avoir avancé depuis la dernière torche.
  const minMove = opts.minMove === undefined ? TORCH_MIN_MOVE : opts.minMove;
  if (o.lastPos && o.pos) {
    const d = Math.hypot(o.pos.x - o.lastPos.x, o.pos.z - o.lastPos.z);
    if (d < minMove) return false;
  }
  return true;
}

module.exports = { shouldPlaceTorch, TORCH_INTERVAL_MS, TORCH_MIN_MOVE, SURFACE_Y, DARK_LEVEL };
