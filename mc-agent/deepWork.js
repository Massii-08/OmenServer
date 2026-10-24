'use strict';
// RETOUR RAPIDE AU CHANTIER DE DIAMANT (Massii 24/10) — comme un joueur avec /home.
//
// Mesuré (logs Omen, 6 h, NethBot1-3) : 329 buts `descend_y54` pour 26 sessions (une session = une vie :
// chaque mort relance un process). Le bot mémorisait bien son chantier profond (`/sethome work` à
// l'arrivée à -54) et `descend_via_home_work` existait — mais derrière un drapeau de PROCESS (`_workSet`)
// remis à faux à chaque mort : après la réapparition, il refaisait ~120 blocs d'escalier, qui échoue
// souvent (food_gate ×50, drop_ahead ×32, water_ahead ×30, air_at_y ×21, dig_failed ×18 sur 6 h).
//
// Règle : à y ≤ -40, sur une case SÛRE (sol plein, ni lave ni eau autour), le home `work` est posé et
// rafraîchi pendant le travail ; il est PERSISTÉ (mémo base `deepWork`). `descend_y54` essaie d'abord
// `/home work` quand ce chantier est profond, récent, sûr et pas un camp de mort récent — avant tout
// escalier. Toujours 3 homes (safe/work/death) : on réutilise `work`, on n'en crée pas.
// PUR (horloge et monde injectés).

const DEEP_WORK_MAX_Y = -40;                // « chantier de diamant » = sous -40
const DEEP_WORK_MIN_GAP_MS = 60 * 1000;     // au plus 1 pose / min
const DEEP_WORK_MOVE_BLOCKS = 16;           // re-pose quand le front a avancé de 16 blocs…
const DEEP_WORK_REFRESH_MS = 10 * 60 * 1000; // …ou toutes les 10 min (la case reste celle du travail récent)
const DEEP_WORK_MAX_AGE_MS = 6 * 60 * 60 * 1000;   // plus vieux : autre monde / autre run probable
const DEEP_WORK_WARP_MIN_RISE = 20;         // déjà à moins de 20 blocs au-dessus : l'escalier est court
const DEEP_WORK_CAMP_RADIUS = 16;
const DEEP_WORK_CAMP_WINDOW_MS = 15 * 60 * 1000;
const DEEP_WORK_CAMP_DEATHS = 2;            // même seuil que homeSafety.homeCamped
const DEEP_WORK_LAND_TOLERANCE = 6;         // atterrissage à ≤ 6 blocs du chantier = c'était bien lui
const HAZARD_RE = /lava|water|bubble_column|powder_snow|fire|magma_block|seagrass|kelp/;

function _fin(n) { return typeof n === 'number' && Number.isFinite(n); }
function _pos(p) { return (p && _fin(p.x) && _fin(p.y) && _fin(p.z)) ? { x: p.x, y: p.y, z: p.z } : null; }
function _d3(a, b) { return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z); }

function _solid(b) {
  if (!b || !b.name) return null;
  if (HAZARD_RE.test(b.name)) return false;
  if (b.boundingBox) return b.boundingBox === 'block';
  return !/^(air|cave_air|void_air)$/.test(b.name);
}

/**
 * PUR — la case est-elle sûre pour un home profond ? `blockAt({x,y,z})` → bloc mineflayer (ou null).
 * Sol plein sous les pieds (2 blocs), pieds et tête libres et SANS fluide, aucune lave/eau dans le cube
 * 5×4×5 autour (y-1 → y+2). Bloc illisible → { ok:false, why:'unknown' } (jamais un home à l'aveugle).
 */
function deepSpotCheck(blockAt, pos) {
  const p = _pos(pos);
  if (!p || typeof blockAt !== 'function') return { ok: false, why: 'unknown' };
  const f = { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) };
  const at = (dx, dy, dz) => { try { return blockAt({ x: f.x + dx, y: f.y + dy, z: f.z + dz }); } catch (e) { return null; } };
  for (const dy of [-1, -2]) {
    const s = _solid(at(0, dy, 0));
    if (s === null) return { ok: false, why: 'unknown' };
    if (!s) return { ok: false, why: 'no_floor' };
  }
  for (const dy of [0, 1]) {
    const b = at(0, dy, 0);
    if (!b || !b.name) return { ok: false, why: 'unknown' };
    if (HAZARD_RE.test(b.name)) return { ok: false, why: 'fluid' };
    if (b.boundingBox === 'block') return { ok: false, why: 'blocked' };
  }
  for (let dx = -2; dx <= 2; dx++) {
    for (let dz = -2; dz <= 2; dz++) {
      for (let dy = -1; dy <= 2; dy++) {
        const b = at(dx, dy, dz);
        if (b && b.name && /lava|water|bubble_column/.test(b.name)) return { ok: false, why: /lava/.test(b.name) ? 'lava_near' : 'water_near' };
      }
    }
  }
  return { ok: true };
}

/**
 * PUR — faut-il (re)poser le home profond maintenant ? (avant le contrôle de la case, qui coûte des lectures)
 * @param {{pos, last:{x,y,z,at}|null, now:number, lastTryAt?:number}} o
 */
function shouldRefreshDeepWork({ pos, last, now, lastTryAt } = {}) {
  const p = _pos(pos);
  if (!p || !_fin(now)) return false;
  if (p.y > DEEP_WORK_MAX_Y) return false;
  if (_fin(lastTryAt) && now - lastTryAt < DEEP_WORK_MIN_GAP_MS) return false;
  const l = _pos(last);
  if (!l || !_fin(last.at) || last.at > now) return true;
  if (_d3(p, l) >= DEEP_WORK_MOVE_BLOCKS) return true;
  return now - last.at >= DEEP_WORK_REFRESH_MS;
}

/**
 * PUR — `descend_y54` : tenter `/home work` vers le chantier profond avant l'escalier ?
 * @param {{deepWork:{x,y,z,at}|null, pos, now:number, deaths?:Array<{x,y,z,at}>}} o
 * @returns {{warp:boolean, why:string}}
 */
function deepWorkWarpPlan({ deepWork, pos, now, deaths } = {}) {
  const w = _pos(deepWork);
  if (!w || !_fin(deepWork.at)) return { warp: false, why: 'none' };
  if (!_fin(now) || deepWork.at > now || now - deepWork.at > DEEP_WORK_MAX_AGE_MS) return { warp: false, why: 'stale' };
  if (w.y > DEEP_WORK_MAX_Y) return { warp: false, why: 'shallow' };
  const p = _pos(pos);
  if (p && p.y - w.y < DEEP_WORK_WARP_MIN_RISE) return { warp: false, why: 'already_deep' };
  const recent = (deaths || []).filter((d) => d && _pos(d) && _fin(d.at) && d.at <= now
    && now - d.at <= DEEP_WORK_CAMP_WINDOW_MS && _d3(d, w) <= DEEP_WORK_CAMP_RADIUS);
  if (recent.length >= DEEP_WORK_CAMP_DEATHS) return { warp: false, why: 'camped' };
  return { warp: true, why: 'ok' };
}

/** PUR — l'atterrissage du /home work est-il bien le chantier profond ? */
function deepWorkLanded(deepWork, landed) {
  const w = _pos(deepWork), l = _pos(landed);
  if (!w || !l) return false;
  return l.y <= DEEP_WORK_MAX_Y && _d3(w, l) <= DEEP_WORK_LAND_TOLERANCE;
}

/** PUR — mémo `deepWork` normalisé (lecture du mémo base) ou null. */
function deepWorkLoad(memo, now) {
  const d = memo && memo.deepWork;
  const w = _pos(d);
  if (!w || !_fin(d.at)) return null;
  if (_fin(now) && (d.at > now || now - d.at > DEEP_WORK_MAX_AGE_MS)) return null;
  return { x: Math.floor(w.x), y: Math.floor(w.y), z: Math.floor(w.z), at: d.at };
}

module.exports = {
  deepSpotCheck, shouldRefreshDeepWork, deepWorkWarpPlan, deepWorkLanded, deepWorkLoad,
  DEEP_WORK_MAX_Y, DEEP_WORK_MIN_GAP_MS, DEEP_WORK_MOVE_BLOCKS, DEEP_WORK_REFRESH_MS, DEEP_WORK_MAX_AGE_MS,
  DEEP_WORK_WARP_MIN_RISE, DEEP_WORK_CAMP_RADIUS, DEEP_WORK_CAMP_WINDOW_MS,
};
