'use strict';
// MENACES « RÉELLES » PENDANT LA RÉCOLTE DE BOIS (run 12, 20/10) — décisions PURES.
//
// Vécu NethBot1, de jour : `threat_hide {why:"wood", mob:"skeleton", dist:10.5}` → abri 62 s →
// immédiatement `threat_hide` du MÊME squelette à la MÊME distance, 6 fois de suite (> 6 min sans rien
// faire), puis déconnexion. Le squelette était IMMOBILE, sans ligne de tir (derrière un mur / sous la
// canopée / dans une grotte). Trois causes, trois règles :
//   1. une menace sans LIGNE DE VUE vers le bot et à plus de 6 blocs ne tire pas, ne charge pas : ce
//      n'est pas une menace (raycast de blocs pleins entre les yeux du bot et l'entité) ;
//   2. une menace qui ne s'est pas approchée depuis la dernière cachette (même entité, ou même position
//      ± 2 blocs, distance ± 2) ne justifie pas une nouvelle cachette : on l'IGNORE et on continue —
//      tant qu'elle ne se rapproche pas ;
//   3. au plus 2 cachettes par séquence de buts `logs`, puis on récolte malgré tout.
// Aucun accès au bot ici : `blockAt` et les entités sont injectés (tests sans serveur).

const CLOSE_RADIUS = 6;          // à ≤ 6 blocs, une menace compte même sans ligne de vue (elle arrive)
const STATIC_POS_TOL = 2;        // « même position » : ± 2 blocs
const STATIC_DIST_TOL = 2;       // « même distance » : ± 2 blocs (et pas plus proche que ça)
const WOOD_MAX_HIDES = 2;        // cachettes max par séquence de buts `logs`
const WOOD_HIDE_RESET_MS = 10 * 60 * 1000;   // une séquence `logs` oubliée au bout de 10 min
const EYE_HEIGHT = 1.62;

/** Un bloc arrête-t-il un projectile / le regard ? Plein = boundingBox 'block' (feuilles comprises). */
function _opaque(b) {
  return !!(b && b.boundingBox === 'block');
}

/**
 * PUR — y a-t-il une ligne de vue dégagée entre `from` et `to` ? Pas de 0.25 bloc ; les blocs des deux
 * extrémités sont ignorés (le bot et le mob sont DANS le leur). `blockAt({x,y,z})` → bloc|null ; un
 * blockAt qui lève vaut « pas de bloc » (on ne masque jamais une menace sur une erreur de lecture).
 */
function hasLineOfSight(from, to, blockAt, opts = {}) {
  if (!from || !to || typeof blockAt !== 'function') return true;
  const vals = [from.x, from.y, from.z, to.x, to.y, to.z];
  if (!vals.every(Number.isFinite)) return true;
  const step = opts.step || 0.25;
  const dx = to.x - from.x, dy = to.y - from.y, dz = to.z - from.z;
  const len = Math.hypot(dx, dy, dz);
  if (len < 1e-6) return true;
  const n = Math.ceil(len / step);
  const key = (x, y, z) => Math.floor(x) + ',' + Math.floor(y) + ',' + Math.floor(z);
  const k0 = key(from.x, from.y, from.z), k1 = key(to.x, to.y, to.z);
  const seen = new Set();
  for (let i = 1; i < n; i++) {
    const t = i / n;
    const x = from.x + dx * t, y = from.y + dy * t, z = from.z + dz * t;
    const k = key(x, y, z);
    if (k === k0 || k === k1 || seen.has(k)) continue;
    seen.add(k);
    let b = null;
    try { b = blockAt({ x: Math.floor(x), y: Math.floor(y), z: Math.floor(z) }); } catch (e) { b = null; }
    if (_opaque(b)) return false;
  }
  return true;
}

/** Une entrée ignorée (menace statique) l'est-elle encore ? Oui tant qu'elle ne s'est pas rapprochée. */
function _stillIgnored(ign, cand) {
  if (!ign || !cand) return false;
  const sameId = ign.id != null && cand.id != null && ign.id === cand.id;
  const samePos = Number.isFinite(ign.x) && Math.abs(ign.x - cand.x) <= STATIC_POS_TOL
    && Math.abs(ign.y - cand.y) <= STATIC_POS_TOL && Math.abs(ign.z - cand.z) <= STATIC_POS_TOL;
  if (!sameId && !samePos) return false;
  return cand.dist >= ign.dist - STATIC_DIST_TOL;   // rapprochée de plus de 2 blocs → redevient une menace
}

/**
 * PUR — la menace RÉELLE la plus proche pour un bot qui récolte du bois, ou null.
 * Réelle = hostile (prédicat injecté), à ≤ `radius`, ET (à ≤ CLOSE_RADIUS OU avec ligne de vue depuis les
 * yeux du bot vers le centre du mob), ET pas dans `ignore` (menaces statiques déjà jugées).
 * @returns {{id, mob, dist, x, y, z}|null}
 */
function realThreat(o = {}) {
  const p = o.pos;
  if (!p || ![p.x, p.y, p.z].every(Number.isFinite)) return null;
  const radius = Number.isFinite(o.radius) ? o.radius : 16;
  const close = Number.isFinite(o.closeRadius) ? o.closeRadius : CLOSE_RADIUS;
  const isHostile = typeof o.isHostile === 'function' ? o.isHostile : (e) => !!e && e.kind === 'Hostile mobs';
  const ignore = Array.isArray(o.ignore) ? o.ignore : [];
  const eye = { x: p.x, y: p.y + EYE_HEIGHT, z: p.z };
  const cands = [];
  for (const e of (Array.isArray(o.entities) ? o.entities : [])) {
    if (!e || !e.position) continue;
    let h = false;
    try { h = !!isHostile(e); } catch (err) { h = false; }
    if (!h) continue;
    const q = e.position;
    const dist = Math.hypot(q.x - p.x, q.y - p.y, q.z - p.z);
    if (!Number.isFinite(dist) || dist > radius) continue;
    cands.push({ id: e.id != null ? e.id : null, mob: e.name || null, dist, x: q.x, y: q.y, z: q.z, h: e.height });
  }
  cands.sort((a, b) => a.dist - b.dist);
  for (const c of cands) {
    if (ignore.some((ign) => _stillIgnored(ign, c))) continue;
    if (c.dist > close) {
      const target = { x: c.x, y: c.y + (Number.isFinite(c.h) ? c.h * 0.8 : 1.5), z: c.z };
      if (!hasLineOfSight(eye, target, o.blockAt)) continue;
    }
    return { id: c.id, mob: c.mob, dist: c.dist, x: c.x, y: c.y, z: c.z };
  }
  return null;
}

/**
 * PUR — se cacher face à `threat` ?
 *   'skip' / 'max_hides'    : 2 cachettes déjà faites dans cette séquence `logs` ;
 *   'skip' / 'static'       : même menace que la dernière cachette, pas rapprochée → l'ignorer ;
 *   'hide'                  : sinon.
 * @param {{threat, hides:number, last:object|null, maxHides?:number}} o
 */
function woodHidePlan(o = {}) {
  const max = Number.isFinite(o.maxHides) ? o.maxHides : WOOD_MAX_HIDES;
  const t = o.threat;
  if (!t) return { act: 'none', why: 'no_threat' };
  if ((o.hides || 0) >= max) return { act: 'skip', why: 'max_hides' };
  if (o.last && _stillIgnored(o.last, t)) return { act: 'skip', why: 'static' };
  return { act: 'hide', why: 'threat' };
}

/** PUR — l'état de la séquence `logs` (cachettes faites) à `now` : oublié après 10 min. */
function woodHideStateAt(state, now) {
  const s = state && typeof state === 'object' ? state : null;
  if (!s || !Number.isFinite(s.since) || !Number.isFinite(now) || now - s.since > WOOD_HIDE_RESET_MS || now < s.since) {
    return { hides: 0, since: Number.isFinite(now) ? now : 0, last: null, ignore: [] };
  }
  return { hides: s.hides || 0, since: s.since, last: s.last || null, ignore: Array.isArray(s.ignore) ? s.ignore.slice() : [] };
}

module.exports = {
  hasLineOfSight, realThreat, woodHidePlan, woodHideStateAt,
  CLOSE_RADIUS, STATIC_POS_TOL, STATIC_DIST_TOL, WOOD_MAX_HIDES, WOOD_HIDE_RESET_MS,
};
