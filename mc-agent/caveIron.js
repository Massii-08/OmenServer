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
// et on exclut : trop loin (> 80 blocs), hors de la zone de confinement, réservée par un
// coéquipier (claim `cave:<cellule>`), tentée en échec il y a moins de 30 min (mémo de base
// persisté), ou noyée (part de minerais `wet` ≥ 1/3 — on ne descend pas dans une grotte inondée).
//
// PUR : aucune I/O, aucun bot. Les décisions vivent ici ; le trajet et le minage dans
// skills/caveIron.js, la glue dans index.js.

const IRON_ORES = new Set(['iron_ore', 'deepslate_iron_ore']);
const CAVE_LINK = 6;                     // blocs : deux minerais plus proches appartiennent à la même paroi
const CAVE_MIN_ORES = 3;                 // en dessous, ce n'est pas une grotte rentable
const CAVE_MAX_DIST = 80;                // blocs À PLAT (mesuré : à 170-190 blocs, 70 cibles sur 81 `unreachable`)
const CAVE_MAX_DROP = 80;                // blocs de dénivelé (escalier dirigé, 22/10)
const CAVE_UNREACH_STREAK = 3;           // disjoncteur : 3 échecs `unreachable`…
const CAVE_UNREACH_WINDOW_MS = 15 * 60 * 1000;   // …en moins de 15 min…
const CAVE_COOLDOWN_MS = 20 * 60 * 1000;         // …=> plus de cible pendant 20 min (branch-mine habituel)
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

/**
 * Disjoncteur : instant (ms) jusqu'auquel plus aucune grappe n'est proposée, ou 0. Déclenché par
 * CAVE_UNREACH_STREAK échecs `unreachable` consécutifs dans CAVE_UNREACH_WINDOW_MS ; le repos court
 * CAVE_COOLDOWN_MS à compter du dernier de la série.
 */
function caveCooldownUntil(fails, now) {
  const t = Number.isFinite(now) ? now : Date.now();
  const at = caveFailsPrune(fails, t).filter((f) => f.why === 'unreachable').map((f) => f.at).sort((a, b) => a - b);
  let until = 0;
  for (let i = CAVE_UNREACH_STREAK - 1; i < at.length; i++) {
    if (at[i] - at[i - (CAVE_UNREACH_STREAK - 1)] <= CAVE_UNREACH_WINDOW_MS) until = Math.max(until, at[i] + CAVE_COOLDOWN_MS);
  }
  return until > t ? until : 0;
}

// ── ACCÈS PLAUSIBLE (21/10) ───────────────────────────────────────────────────────────────────
// Mesure 3 h (21/10 20:14→23:14, 32 cibles) : 25 `cave_failed unreachable`, dont 11 visaient une grappe
// à plus de 24 blocs en VERTICAL du bot (jusqu'à 62) — une paroi vue par un cartographe depuis une
// autre grotte, sans chemin connu depuis le tunnel du mineur. On ne vise donc une grappe que si elle
// est à ≤ 24 blocs en vertical, OU s'il existe près d'elle une ENTRÉE DE GROTTE ouverte connue
// (`worlds.<w>.caves` {x,y,z,at,flooded}, notée par les cartographes — caves.js) au-dessus d'elle.
const CAVE_ACCESS_DY = 24;
const CAVE_ENTRANCE_NEAR = 32;           // blocs en XZ entre l'entrée connue et le centre de la grappe
const CAVE_ENTRANCE_BELOW_TOL = 4;       // une entrée plus BASSE que la grappe ne mène pas à elle

/** PUR — la grappe `c` est-elle plausiblement atteignable depuis `from` ? */
function caveAccessible(c, from, caves) {
  if (!_valid(c) || !_valid(from)) return false;
  if (Math.abs(from.y - c.y) <= CAVE_ACCESS_DY) return true;
  for (const e of Array.isArray(caves) ? caves : []) {
    if (!_valid(e) || e.flooded) continue;
    if (e.y < c.y - CAVE_ENTRANCE_BELOW_TOL) continue;
    if (Math.hypot(e.x - c.x, e.z - c.z) <= CAVE_ENTRANCE_NEAR) return true;
  }
  return false;
}

// ── ESCALADE DU DISJONCTEUR (21/10) ─────────────────────────────────────────────────────────────
// Le repos de 20 min ne suffisait pas : 12 `unreachable` par bot en 3 h, les MÊMES grappes reprises
// dès que leur échec sortait des 30 min de TTL. Au 2e déclenchement en 2 h, `iron_cave` est coupé 2 h
// (branch-mine habituel). Les déclenchements sont persistés dans le mémo base (`caveBreaks`) : un
// process neuf après une mort ne repart pas de zéro.
const CAVE_ESCALATE_WINDOW_MS = 2 * 3600 * 1000;
const CAVE_DISABLE_MS = 2 * 3600 * 1000;
const CAVE_BREAKS_CAP = 10;

function _validTrips(trips, now) {
  return (Array.isArray(trips) ? trips : []).filter((b) => b && Number.isFinite(b.at) && Number.isFinite(b.until)
    && b.at <= now && b.until >= b.at);
}

/**
 * PUR — enregistre un repos du disjoncteur (`until` = caveCooldownUntil). Un repos revu (même série,
 * ou prolongé par un échec de plus) n'est PAS un nouveau déclenchement : il n'en devient un que s'il
 * commence après la fin du précédent. Élague au-delà de fenêtre + désactivation, plafonné.
 */
function caveBreakerNote(trips, until, now) {
  const t = Number.isFinite(now) ? now : Date.now();
  const keep = _validTrips(trips, t).filter((b) => t - b.at <= CAVE_ESCALATE_WINDOW_MS + CAVE_DISABLE_MS)
    .map((b) => ({ at: b.at, until: b.until })).sort((a, b) => a.at - b.at);
  if (!Number.isFinite(until) || until <= t) return keep.slice(-CAVE_BREAKS_CAP);
  const at = Math.min(t, until - CAVE_COOLDOWN_MS);
  const last = keep[keep.length - 1];
  if (last && at <= last.until) last.until = Math.max(last.until, until);
  else keep.push({ at, until });
  return keep.slice(-CAVE_BREAKS_CAP);
}

/** PUR — instant jusqu'auquel `iron_cave` est désactivé (2 déclenchements en ≤ 2 h → +2 h), ou 0. */
function caveDisabledUntil(trips, now) {
  const t = Number.isFinite(now) ? now : Date.now();
  const v = _validTrips(trips, t).sort((a, b) => a.at - b.at);
  let off = 0;
  for (let i = 1; i < v.length; i++) {
    if (v[i].at - v[i - 1].at <= CAVE_ESCALATE_WINDOW_MS) off = Math.max(off, v[i].at + CAVE_DISABLE_MS);
  }
  return off > t ? off : 0;
}

// ── ESCALIER DIRIGÉ VERS UNE GRAPPE (22/10) ────────────────────────────────────────────────────────
// L'escalier de descendDiagonal avance d'1 bloc pour 1 bloc descendu, dans un cap cardinal fixe. Pour
// arriver SUR la grappe, on part du point situé `drop` blocs AVANT elle sur l'axe principal (celui où
// l'écart horizontal est le plus grand), le cap tourné vers elle. Au-delà de STAIR_MIN_DROP blocs de
// dénivelé seulement : plus près, le pathfinder (marche/creusage court) suffit.
const STAIR_MIN_DROP = 4;

/** yaw mineflayer d'un cap cardinal (inverse exact de descendDiagonal.cardinalFromYaw). */
function yawOf(dir) {
  if (!dir) return 0;
  if (dir.dz > 0) return 0;
  if (dir.dx < 0) return Math.PI / 2;
  if (dir.dz < 0) return Math.PI;
  return -Math.PI / 2;
}

/**
 * PUR — plan d'escalier de `from` vers `t` ({x,y,z}) : {dir, start:{x,z}, drop, targetY, yaw}, ou null
 * si la cible n'est pas à plus de STAIR_MIN_DROP blocs SOUS le bot.
 */
function stairPlan(from, t) {
  if (!_valid(from) || !_valid(t)) return null;
  const drop = Math.floor(from.y) - Math.floor(t.y);
  if (!(drop > STAIR_MIN_DROP)) return null;
  const dx = t.x - from.x, dz = t.z - from.z;
  const dir = Math.abs(dx) >= Math.abs(dz)
    ? { dx: dx < 0 ? -1 : 1, dz: 0 }
    : { dx: 0, dz: dz < 0 ? -1 : 1 };
  const start = { x: Math.round(t.x - dir.dx * drop), z: Math.round(t.z - dir.dz * drop) };
  return { dir, start, drop, targetY: Math.floor(t.y), yaw: yawOf(dir) };
}

const STAIR_ARRIVE_DY = 1;               // pieds à la couche de la grappe ± 1…
const STAIR_ARRIVE_NEAR = 4;             // …ou à ≤ 4 blocs d'elle en 3D

/** PUR — l'escalier est-il arrivé ? Relu à CHAQUE marche (22/10 : il descendait 17 blocs trop bas). */
function stairArrived(pos, t) {
  if (!_valid(pos) || !_valid(t)) return false;
  if (Math.abs(Math.floor(pos.y) - Math.floor(t.y)) <= STAIR_ARRIVE_DY) return true;
  return Math.hypot(pos.x - (t.x + 0.5), pos.y - t.y, pos.z - (t.z + 0.5)) <= STAIR_ARRIVE_NEAR;
}

/** PUR — pieds plus bas que la couche de la grappe (au-delà de la tolérance) ? */
function stairOvershot(pos, t) {
  if (!_valid(pos) || !_valid(t)) return false;
  return Math.floor(pos.y) < Math.floor(t.y) - STAIR_ARRIVE_DY;
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
  const maxDrop = Number.isFinite(o.maxDrop) ? o.maxDrop : CAVE_MAX_DROP;
  const minOres = Number.isFinite(o.minOres) ? o.minOres : CAVE_MIN_ORES;
  const fails = caveFailsPrune(o.fails, now);
  if (caveCooldownUntil(fails, now)) return [];
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
    // Portée : 80 blocs À PLAT et 80 de dénivelé (22/10). Mesurer la portée en 3D excluait tout le fer
    // sous y≈0 depuis la surface, alors qu'un escalier de 70 marches n'est que 3 min de pioche.
    if (Math.hypot(c.x - from.x, c.z - from.z) > maxDist || Math.abs(c.y - from.y) > maxDrop) continue;
    if (conf && Math.hypot(c.x - conf.x, c.z - conf.z) > conf.radius - CONFINE_MARGIN) continue;
    // ⚠️ PLUS de filtre « accès plausible » (caveAccessible, 21/10) — 22/10, mémoire 943e2c : 5 719 fers
    // exposés secs pour 3 entrées de grotte notées → depuis le spawn (y≈70) la règle ne laissait qu'UNE
    // grappe ciblable, et la flotte retombait sur le branch-mine aveugle (12 minerais/h). Un joueur qui
    // SAIT où est le fer creuse un escalier vers lui : c'est ce que fait désormais le trajet (stairPlan +
    // escalier dirigé côté index.js) pour toute grappe plus basse que lui. Restent exclues : les grappes
    // noyées, trop loin, hors confine, réservées, déjà ratées (< 30 min) ; le disjoncteur reste en place.
    // La profondeur reste PAYÉE dans le score (DEPTH_K) : à rendement égal, la plus proche en 3D d'abord.
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

// PV : NE PAS ENTRER EN GROTTE BLESSÉ (chrono 22/10 12:10-14:36). 12 morts de mineurs pendant
// `iron_cave` contre 5 en branch-mine pour deux fois plus de temps passé : une grotte ouverte, c'est
// plusieurs mobs à la fois et des squelettes à 15 blocs. 4 de ces morts avaient lancé l'escalier vers
// la grappe à ≤ 6 PV. Sous 12 PV, le but est sauté : le bot mine en galerie (étroite, éclairée, un
// seul front) jusqu'à ce que ses PV remontent ou qu'il réapparaisse plein.
const CAVE_MIN_HP = 12;

/** Assez de PV pour viser une grotte ? PV inconnus → true (ne jamais bloquer sans donnée). (pur) */
function caveHpOk(health) {
  if (typeof health !== 'number' || Number.isNaN(health)) return true;
  return health >= CAVE_MIN_HP;
}

/** La grappe la plus rentable, ou null (→ le but `iron_cave` est sauté, branch-mine habituel). */
function pickIronCave(ores, from, o = {}) {
  const r = rankIronCaves(ores, from, o);
  return r.length ? r[0] : null;
}

// ── BUDGET DE GROTTES (23/10, chrono zéro→armure fer, 77 min) ─────────────────────────────────────
// NethBot2 a lancé `iron_cave` 25 fois pour 1 SEUL minerai de fer : 20 `cave_failed` (unreachable
// 98-175 s de trajet, hidden 164 s, interrupted ×3+), `descend_y16` lancé 7 fois seulement — pendant que
// NethBot3, une fois au fond, faisait 3 pièces en 5 min au branch-mine. Le disjoncteur existant ne
// comptait que les `unreachable` CONSÉCUTIFS : hidden / interrupted / stair_missed / timeout le
// contournaient. Un joueur qui rate trois grottes renonce et creuse. Donc :
//   (a) ≥ CAVE_BUDGET_FAILS essais SANS FER (toute raison sauf cancelled) en CAVE_BUDGET_FAIL_WINDOW_MS, ou
//   (b) aucun fer obtenu (grotte OU ailleurs) depuis CAVE_BUDGET_NOIRON_MS alors qu'au moins
//       CAVE_BUDGET_NOIRON_MIN_TRIPS trajets de grotte ont été tentés depuis le dernier fer,
// ⇒ `iron_cave` coupé CAVE_BUDGET_OFF_MS (la chaîne passe au branch-mine Y16). État persisté dans le
// mémo base (`caveBudget` {until, lastIronAt, attempts:[{at,start,why,iron}]}) : survit au self-healing.
// ⚠️ `claimed` et `no_cave_target` ne sont pas des trajets (aucun pas fait) : non comptés.
const CAVE_BUDGET_FAILS = 3;
const CAVE_BUDGET_FAIL_WINDOW_MS = 15 * 60 * 1000;
const CAVE_BUDGET_NOIRON_MS = 20 * 60 * 1000;
const CAVE_BUDGET_NOIRON_MIN_TRIPS = 2;
const CAVE_BUDGET_OFF_MS = 12 * 60 * 1000;
const CAVE_BUDGET_KEEP_MS = 60 * 60 * 1000;
const CAVE_BUDGET_CAP = 30;
const CAVE_BUDGET_IGNORED = new Set(['cancelled', 'claimed', 'no_cave_target']);

/** PUR — état de budget bien formé, essais élagués (> 60 min, futurs, mal formés), plafonné. */
function caveBudgetPrune(b, now) {
  const t = Number.isFinite(now) ? now : Date.now();
  const src = (b && typeof b === 'object') ? b : {};
  const attempts = (Array.isArray(src.attempts) ? src.attempts : [])
    .filter((a) => a && Number.isFinite(a.at) && a.at <= t && t - a.at < CAVE_BUDGET_KEEP_MS)
    .map((a) => ({ at: a.at, start: Number.isFinite(a.start) && a.start <= a.at ? a.start : a.at,
      why: String(a.why || 'failed'), iron: Number.isFinite(a.iron) && a.iron > 0 ? a.iron : 0 }))
    .slice(-CAVE_BUDGET_CAP);
  const out = { attempts };
  if (Number.isFinite(src.lastIronAt) && src.lastIronAt <= t) out.lastIronAt = src.lastIronAt;
  if (Number.isFinite(src.until)) out.until = src.until;
  return out;
}

/** PUR — enregistre la fin d'un essai `iron_cave` ({why, iron, took_s}). Nouvel état. */
function caveBudgetRecord(b, r, now) {
  const t = Number.isFinite(now) ? now : Date.now();
  const st = caveBudgetPrune(b, t);
  const why = String((r && r.why) || 'failed');
  if (CAVE_BUDGET_IGNORED.has(why)) return st;
  const iron = Number.isFinite(r && r.iron) && r.iron > 0 ? r.iron : 0;
  const took = Number.isFinite(r && r.took_s) && r.took_s > 0 ? r.took_s : 0;
  st.attempts.push({ at: t, start: t - took * 1000, why, iron });
  st.attempts = st.attempts.slice(-CAVE_BUDGET_CAP);
  if (iron > 0) st.lastIronAt = t;
  return st;
}

/** PUR — du fer obtenu hors grotte (branch-mine, ramassage) : remet l'horloge « sans fer » à zéro. */
function caveBudgetNoteIron(b, now) {
  const t = Number.isFinite(now) ? now : Date.now();
  const st = caveBudgetPrune(b, t);
  st.lastIronAt = t;
  return st;
}

/** PUR — fin de la coupure en cours (ms), ou 0. Une coupure plus longue que CAVE_BUDGET_OFF_MS = corrompue. */
function caveBudgetUntil(b, now) {
  const t = Number.isFinite(now) ? now : Date.now();
  const u = b && b.until;
  if (!Number.isFinite(u) || u <= t || u - t > CAVE_BUDGET_OFF_MS) return 0;
  return u;
}

/**
 * PUR — verdict : null (on peut viser une grotte) ou {fails, minutesNoIron, until} (budget épuisé, à
 * appliquer par caveBudgetTrip). Jamais de verdict pendant une coupure active.
 */
function caveBudgetCheck(b, now) {
  const t = Number.isFinite(now) ? now : Date.now();
  const st = caveBudgetPrune(b, t);
  if (caveBudgetUntil(st, t)) return null;
  const lastIron = Number.isFinite(st.lastIronAt) ? st.lastIronAt : -Infinity;
  const recentFails = st.attempts.filter((a) => a.iron === 0 && t - a.at <= CAVE_BUDGET_FAIL_WINDOW_MS && a.at > lastIron);
  const sinceIron = st.attempts.filter((a) => a.at > lastIron);
  const firstStart = sinceIron.length ? Math.min(...sinceIron.map((a) => a.start)) : null;
  const noIronMs = firstStart === null ? 0 : t - Math.max(firstStart, lastIron);
  const minutesNoIron = Math.round(noIronMs / 60000);
  const byFails = recentFails.length >= CAVE_BUDGET_FAILS;
  const byTime = sinceIron.length >= CAVE_BUDGET_NOIRON_MIN_TRIPS && noIronMs >= CAVE_BUDGET_NOIRON_MS;
  if (!byFails && !byTime) return null;
  return { fails: recentFails.length, minutesNoIron, until: t + CAVE_BUDGET_OFF_MS };
}

/**
 * PUR — applique un verdict : coupure jusqu'à `v.until`, essais VIDÉS (sinon les trois mêmes échecs
 * re-couperaient dès la fin du repos, sans qu'un seul nouveau trajet ait été tenté).
 */
function caveBudgetTrip(b, v) {
  const st = caveBudgetPrune(b, v && Number.isFinite(v.until) ? v.until - CAVE_BUDGET_OFF_MS : Date.now());
  return Object.assign({}, st, { attempts: [], until: v && Number.isFinite(v.until) ? v.until : st.until });
}

// ── PORTÉE (23/10) : une grappe lointaine coûte 100-175 s de trajet pour souvent rien ─────────────
// On ne vise une grappe exposée que si son centre est à ≤ CAVE_REACH_3D blocs (3D) du bot, ou à
// ≤ CAVE_REACH_BIG_3D si elle compte ≥ CAVE_REACH_BIG_ORES minerais. Au-delà : branch-mine local.
const CAVE_REACH_3D = 48;
const CAVE_REACH_BIG_3D = 64;
const CAVE_REACH_BIG_ORES = 6;

/** PUR — la grappe `c` ({x,y,z,count}) est-elle à portée de `from` ? */
function caveInReach(c, from) {
  if (!_valid(c) || !_valid(from)) return false;
  const d = Math.hypot(c.x - from.x, c.y - from.y, c.z - from.z);
  const n = Number.isFinite(c.count) ? c.count : (Array.isArray(c.ores) ? c.ores.length : 0);
  return d <= (n >= CAVE_REACH_BIG_ORES ? CAVE_REACH_BIG_3D : CAVE_REACH_3D);
}

/**
 * PUR — dans un classement (rankIronCaves), la première grappe à portée. `tooFar` = la meilleure du
 * classement quand elle a été écartée pour la distance (pour l'event `cave_too_far`), sinon null.
 */
function pickReachableCave(ranked, from) {
  const list = Array.isArray(ranked) ? ranked : [];
  const cave = list.find((c) => caveInReach(c, from)) || null;
  const tooFar = list.length && list[0] !== cave ? list[0] : null;
  return { cave, tooFar };
}

module.exports = {
  IRON_ORES, CAVE_LINK, CAVE_MIN_ORES, CAVE_MAX_DIST, CAVE_MAX_DROP, CAVE_FAIL_TTL_MS, CAVE_FAIL_NEAR, CAVE_CELL,
  DEPTH_K, WET_SHARE_MAX, CAVE_FAILS_CAP,
  isIronOre, exposedIronOres, clusterOres, centroid, caveKey, orderOres,
  CAVE_UNREACH_STREAK, CAVE_UNREACH_WINDOW_MS, CAVE_COOLDOWN_MS, caveCooldownUntil,
  caveFailsPrune, caveFailsAdd, rankIronCaves, pickIronCave,
  CAVE_ACCESS_DY, CAVE_ENTRANCE_NEAR, caveAccessible,
  STAIR_MIN_DROP, yawOf, stairPlan, STAIR_ARRIVE_DY, STAIR_ARRIVE_NEAR, stairArrived, stairOvershot,
  CAVE_ESCALATE_WINDOW_MS, CAVE_DISABLE_MS, caveBreakerNote, caveDisabledUntil,
  CAVE_MIN_HP, caveHpOk,
  CAVE_BUDGET_FAILS, CAVE_BUDGET_FAIL_WINDOW_MS, CAVE_BUDGET_NOIRON_MS, CAVE_BUDGET_NOIRON_MIN_TRIPS,
  CAVE_BUDGET_OFF_MS, CAVE_BUDGET_CAP, caveBudgetPrune, caveBudgetRecord, caveBudgetNoteIron,
  caveBudgetUntil, caveBudgetCheck, caveBudgetTrip,
  CAVE_REACH_3D, CAVE_REACH_BIG_3D, CAVE_REACH_BIG_ORES, caveInReach, pickReachableCave,
};
