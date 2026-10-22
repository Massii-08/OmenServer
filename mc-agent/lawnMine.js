'use strict';
// TRACÉ EN LACETS du branch-mine fer (22/10) — PUR, aucun bot.
//
// Mesure (chrono world_oct22, 61 min) : NethBot3 = 29 min d'iron_deep pour 8 fers. Le serpentin
// virait au hasard tous les 4 à 8 blocs ; une marche au hasard revient sur ses pas et LONGE ses
// propres galeries, et chacun des 10 appels repartait du même home work avec un cap tiré du regard.
// Résultat : une zone de 40 × 50 blocs creusée en tous sens, où chaque nouveau bloc creusé touche
// des parois déjà vues. Le fer ne se voit qu'une fois : creuser à côté d'une galerie existante ne
// rapporte RIEN.
//
// Un joueur fait l'inverse : de longues galeries PARALLÈLES espacées de 3 (2 blocs de pilier entre
// elles), reliées par un court décalage — chaque bloc de paroi est découvert exactement une fois.
// C'est ce que décrit l'état ci-dessous, une galerie unique en lacets :
//     long (≈16, irrégulier) → décalage de 3 → long en sens inverse → décalage de 3 (même côté) → …
// Le serpentin garde toute sa mécanique (eau, lave, grottes, chute, torches) ; seuls ses virages
// suivent ce motif. Un obstacle (eau, grotte, vide) pendant une longue galerie fait prendre le
// décalage tout de suite, ce qui garde les galeries parallèles.

const LAWN_LENGTH = 16;      // longueur de base d'une longue galerie
const LAWN_JITTER = 3;       // + 0..2 : jamais une longueur métronomique
const LAWN_SPACING = 3;      // décalage entre deux galeries = 2 blocs de pilier
const LAWN_RESUME_NEAR = 8;  // le bot est « au front » s'il en est à ≤ 8 blocs (XZ)…
const LAWN_RESUME_DY = 4;    // …sur la même couche
const LAWN_RESUME_TTL_MS = 6 * 3600 * 1000;

function _rot(h, turn) {
  // turn +1 = gauche (leftOf de branchMine), -1 = droite
  return turn > 0 ? { dx: (-h.dz) || 0, dz: h.dx || 0 } : { dx: h.dz || 0, dz: (-h.dx) || 0 };
}

function _longLen(o = {}) {
  const base = Number.isFinite(o.length) ? o.length : LAWN_LENGTH;
  const rng = typeof o.rng === 'function' ? o.rng : Math.random;
  return base + Math.floor(rng() * LAWN_JITTER);
}

function _spacing(o = {}) { return Number.isFinite(o.spacing) ? o.spacing : LAWN_SPACING; }

/** État initial : une longue galerie dans le cap `heading` ({dx,dz} cardinal). */
function lawnInit(heading, o = {}) {
  const h = heading && (heading.dx || heading.dz) ? { dx: Math.sign(heading.dx || 0), dz: Math.sign(heading.dz || 0) } : { dx: 1, dz: 0 };
  if (h.dx && h.dz) h.dz = 0;
  return { heading: h, leg: 'long', turn: 1, left: _longLen(o) };
}

/** Fin de tronçon : long → décalage (même sens de virage) ; décalage → long en sens inverse, virage suivant inversé. */
function _turn(st, o) {
  if (st.leg === 'long') return { heading: _rot(st.heading, st.turn), leg: 'short', turn: st.turn, left: _spacing(o) };
  return { heading: _rot(st.heading, st.turn), leg: 'long', turn: -st.turn, left: _longLen(o) };
}

/** Après un pas creusé : décompte, virage en fin de tronçon. Rend un NOUVEL état. */
function lawnAfterStep(st, o = {}) {
  const left = (st.left | 0) - 1;
  if (left > 0) return { heading: st.heading, leg: st.leg, turn: st.turn, left };
  return _turn(st, o);
}

/** Obstacle devant (eau, grotte, vide) : on termine le tronçon courant tout de suite. */
function lawnObstacle(st, o = {}) { return _turn(st, o); }

function lawnValid(st) {
  if (!st || typeof st !== 'object' || !st.heading) return false;
  const { dx, dz } = st.heading;
  if (![-1, 0, 1].includes(dx) || ![-1, 0, 1].includes(dz) || Math.abs(dx) + Math.abs(dz) !== 1) return false;
  return (st.leg === 'long' || st.leg === 'short') && (st.turn === 1 || st.turn === -1)
    && Number.isFinite(st.left) && st.left > 0;
}

/**
 * Reprise d'un tracé mémorisé ({state, x, y, z, at} du mémo base) : l'état si le bot est au front
 * (même chantier, même couche, pas périmé), sinon null (nouveau tracé depuis le regard).
 */
function lawnResume(saved, pos, now) {
  if (!saved || !lawnValid(saved.state) || !pos) return null;
  if (![saved.x, saved.y, saved.z, pos.x, pos.y, pos.z].every(Number.isFinite)) return null;
  const t = Number.isFinite(now) ? now : Date.now();
  if (!Number.isFinite(saved.at) || saved.at > t || t - saved.at > LAWN_RESUME_TTL_MS) return null;
  if (Math.abs(pos.y - saved.y) > LAWN_RESUME_DY) return null;
  if (Math.hypot(pos.x - saved.x, pos.z - saved.z) > LAWN_RESUME_NEAR) return null;
  return saved.state;
}

module.exports = {
  LAWN_LENGTH, LAWN_JITTER, LAWN_SPACING, LAWN_RESUME_NEAR, LAWN_RESUME_DY, LAWN_RESUME_TTL_MS,
  lawnInit, lawnAfterStep, lawnObstacle, lawnValid, lawnResume,
};
