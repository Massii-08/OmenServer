'use strict';
// FER EN GROTTE (Massii 20/10 : « aller plus vite vers l'armure de fer sans tricher, comme un humain »).
//
// Le fer de la chaîne T1 venait d'un branch-mine AVEUGLE à Y16 : on creuse un tunnel et on prend ce
// que les coups exposent. Un joueur fait l'inverse : il va dans les GROTTES et les RAVINS, où le fer
// se voit sur les parois, et il en ramasse bien plus par minute. C'est légitime : un minerai qui
// touche l'air est vu par n'importe quel joueur — et, avec l'anti-xray Paper (engine-mode 1), ce
// sont même les SEULS que le client reçoit. Les cartographes les notent `exposed:true` dans la
// mémoire de monde partagée (`worlds.<w>.ores`, forme {material,x,y,z,at,exposed,wet}).
//
// Un minerai isolé ne vaut pas le déplacement ; une GRAPPE (≥ 3 minerais à ≤ 6 blocs les uns des
// autres) signe une paroi de grotte. On choisit la grappe la plus RENTABLE :
//     score = minerais secs / (distance + pénalité de profondeur)
// et on exclut : trop loin (> 200 blocs), hors de la zone de confinement, réservée par un
// coéquipier (claim `cave:<cellule>`), tentée en échec il y a moins de 30 min (mémo de base
// persisté), ou noyée (part de minerais `wet` ≥ 1/3 — on ne descend pas dans une grotte inondée).
//
// PUR : aucune I/O, aucun bot. Les décisions vivent ici ; le trajet et le minage dans
// skills/caveIron.js, la glue dans index.js.

const IRON_ORES = new Set(['iron_ore', 'deepslate_iron_ore']);
const CAVE_LINK = 6;                     // blocs : deux minerais plus proches appartiennent à la même paroi
const CAVE_MIN_ORES = 3;                 // en dessous, ce n'est pas une grotte rentable
const CAVE_MAX_DIST = 200;               // blocs
const CAVE_FAIL_TTL_MS = 30 * 60 * 1000; // une grappe ratée n'est pas re-tentée avant 30 min
const CAVE_FAIL_NEAR = 8;                // une grappe dont le centre est à ≤ 8 blocs d'un essai raté = la même
const CAVE_FAILS_CAP = 40;
const CAVE_CELL = 16;                    // cellule de claim (une grotte tient rarement dans moins)
const DEPTH_K = 1;                       // chaque bloc à DESCENDRE compte double (roche, escalier, retour)
const WET_SHARE_MAX = 1 / 3;
const CONFINE_MARGIN = 8;

function isIronOre(name) { return IRON_ORES.has(String(name || '')); }

function _valid(o) {
  return o && typeof o === 'object' && Number.isFinite(o.x) && Number.isFinite(o.y) && Number.isFinite(o.z);
}

/** Minerais de fer EXPOSÉS d'une liste d'ores de la mémoire (wet conservé pour le verdict « noyée »). */
function exposedIronOres(ores) {
  const out = [];
  const seen = new Set();
  for (const o of Array.isArray(ores) ? ores : []) {
    if (!_valid(o) || !isIronOre(o.material) || o.exposed !== true) continue;
    const k = `${Math.round(o.x)},${Math.round(o.y)},${Math.round(o.z)}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ material: o.material, x: Math.round(o.x), y: Math.round(o.y), z: Math.round(o.z), wet: !!o.wet });
  }
  return out;
}

/**
 * Regroupe des points en grappes par chaînage simple (deux points à ≤ `link` blocs en 3D sont dans la
 * même grappe, transitivement). Grille de seaux de côté `link` → O(n) voisins par point.
 * @returns {Array<Array<object>>}
 */
function clusterOres(points, link = CAVE_LINK) {
  const n = points.length;
  const parent = points.map((_, i) => i);
  const find = (i) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent[ra] = rb; };
  const cell = (v) => Math.floor(v / link);
  const grid = new Map();
  points.forEach((p, i) => {
    const k = `${cell(p.x)},${cell(p.y)},${cell(p.z)}`;
    if (!grid.has(k)) grid.set(k, []);
    grid.get(k).push(i);
  });
  const l2 = link * link;
  points.forEach((p, i) => {
    const cx = cell(p.x), cy = cell(p.y), cz = cell(p.z);
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
      const bucket = grid.get(`${cx + dx},${cy + dy},${cz + dz}`);
      if (!bucket) continue;
      for (const j of bucket) {
        if (j <= i) continue;
        const q = points[j];
        const ddx = p.x - q.x, ddy = p.y - q.y, ddz = p.z - q.z;
        if (ddx * ddx + ddy * ddy + ddz * ddz <= l2) union(i, j);
      }
    }
  });
  const groups = new Map();
  for (let i = 0; i < n; i++) {
    const r = find(i);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(points[i]);
  }
  return [...groups.values()];
}

function centroid(pts) {
  let x = 0, y = 0, z = 0;
  for (const p of pts) { x += p.x; y += p.y; z += p.z; }
  return { x: Math.round(x / pts.length), y: Math.round(y / pts.length), z: Math.round(z / pts.length) };
}

/** Clé de claim d'une grappe : `cave:<cellule 16³ de son centre>`. */
function caveKey(center) {
  const c = (v) => Math.floor(v / CAVE_CELL);
  return `cave:${c(center.x)},${c(center.y)},${c(center.z)}`;
}

/** Ordre de visite : plus proche voisin depuis `from` (un vrai joueur longe la paroi). */
function orderOres(ores, from) {
  const rest = ores.slice();
  const out = [];
  let cur = from || rest[0];
  while (rest.length) {
    let bi = 0, bd = Infinity;
    for (let i = 0; i < rest.length; i++) {
      const o = rest[i];
      const d = (o.x - cur.x) ** 2 + (o.y - cur.y) ** 2 + (o.z - cur.z) ** 2;
      if (d < bd) { bd = d; bi = i; }
    }
    cur = rest.splice(bi, 1)[0];
    out.push(cur);
  }
  return out;
}

/** Essais ratés encore valides (< 30 min, pas du futur, bien formés). */
function caveFailsPrune(fails, now) {
  const t = Number.isFinite(now) ? now : Date.now();
  return (Array.isArray(fails) ? fails : []).filter((f) => f && Number.isFinite(f.at) && f.at <= t
    && t - f.at < CAVE_FAIL_TTL_MS && Number.isFinite(f.x) && Number.isFinite(f.y) && Number.isFinite(f.z));
}

/** Nouveau tableau d'essais avec celui-ci ajouté (élagué, plafonné, les plus récents gardés). */
function caveFailsAdd(fails, cave, why, now) {
  const t = Number.isFinite(now) ? now : Date.now();
  const kept = caveFailsPrune(fails, t);
  if (!cave || !Number.isFinite(cave.x)) return kept;
  kept.push({ x: cave.x, y: cave.y, z: cave.z, key: cave.key || caveKey(cave), why: String(why || 'failed'), at: t });
  return kept.slice(-CAVE_FAILS_CAP);
}

function _nearFail(center, fails) {
  const n2 = CAVE_FAIL_NEAR * CAVE_FAIL_NEAR;
  return fails.some((f) => (f.x - center.x) ** 2 + (f.y - center.y) ** 2 + (f.z - center.z) ** 2 <= n2);
}

/**
 * Grappes de fer candidates, triées par rentabilité décroissante.
 * @param {Array} ores         worlds.<w>.ores de la mémoire partagée
 * @param {{x,y,z}} from       position du bot
 * @param {object} [o]
 *   now, fails (mémo base), isClaimed(key)→bool (claim d'un AUTRE bot), maxDist, minOres, link,
 *   confine {x,z,radius} (la grappe doit y tenir — l'enforcement ramènerait sinon le bot)
 * @returns {Array<{key,x,y,z,count,wet,dist,score,ores}>}
 */
function rankIronCaves(ores, from, o = {}) {
  if (!from || !Number.isFinite(from.x)) return [];
  const now = Number.isFinite(o.now) ? o.now : Date.now();
  const maxDist = Number.isFinite(o.maxDist) ? o.maxDist : CAVE_MAX_DIST;
  const minOres = Number.isFinite(o.minOres) ? o.minOres : CAVE_MIN_ORES;
  const fails = caveFailsPrune(o.fails, now);
  const isClaimed = typeof o.isClaimed === 'function' ? o.isClaimed : () => false;
  const conf = o.confine && Number.isFinite(o.confine.x) && Number.isFinite(o.confine.radius) ? o.confine : null;
  // Pré-filtre grossier par distance : on ne regroupe pas les minerais de l'autre bout de la carte.
  const reach = maxDist + 32;
  const pts = exposedIronOres(ores).filter((p) => Math.abs(p.x - from.x) <= reach && Math.abs(p.z - from.z) <= reach);
  const out = [];
  for (const g of clusterOres(pts, o.link || CAVE_LINK)) {
    const dry = g.filter((p) => !p.wet);
    if (dry.length < minOres) continue;
    if ((g.length - dry.length) / g.length >= WET_SHARE_MAX) continue;      // grotte inondée
    const c = centroid(dry);
    const dist = Math.hypot(c.x - from.x, c.y - from.y, c.z - from.z);
    if (dist > maxDist) continue;
    if (conf && Math.hypot(c.x - conf.x, c.z - conf.z) > conf.radius - CONFINE_MARGIN) continue;
    const key = caveKey(c);
    if (_nearFail(c, fails)) continue;
    let claimed = false;
    try { claimed = !!isClaimed(key); } catch (e) { claimed = false; }
    if (claimed) continue;
    const depthPen = DEPTH_K * Math.max(0, from.y - c.y);
    const score = dry.length / (dist + depthPen + 1);
    out.push({ key, x: c.x, y: c.y, z: c.z, count: dry.length, wet: g.length - dry.length,
      dist: Math.round(dist), score, ores: orderOres(dry, from) });
  }
  out.sort((a, b) => b.score - a.score || a.dist - b.dist || (a.key < b.key ? -1 : 1));
  return out;
}

/** La grappe la plus rentable, ou null (→ le but `iron_cave` est sauté, branch-mine habituel). */
function pickIronCave(ores, from, o = {}) {
  const r = rankIronCaves(ores, from, o);
  return r.length ? r[0] : null;
}

module.exports = {
  IRON_ORES, CAVE_LINK, CAVE_MIN_ORES, CAVE_MAX_DIST, CAVE_FAIL_TTL_MS, CAVE_FAIL_NEAR, CAVE_CELL,
  DEPTH_K, WET_SHARE_MAX, CAVE_FAILS_CAP,
  isIronOre, exposedIronOres, clusterOres, centroid, caveKey, orderOres,
  caveFailsPrune, caveFailsAdd, rankIronCaves, pickIronCave,
};
