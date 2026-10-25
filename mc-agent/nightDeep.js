'use strict';
// LA NUIT SOUS TERRE PLUTÔT QU'EN SURFACE (25/10, run Hard keepInventory OFF : 53 morts en 4 h, surtout la
// nuit en surface — zombies, squelettes, creepers).
//
// Deux décisions PURES, câblées dans index.js :
//  1. duskDeepPlan — un bot nu ou peu armé (< 2 pièces) en surface au crépuscule ou la nuit : s'il a un
//     chantier profond (`/home work` noté sous y 45), il y retourne ; sinon, avec une pioche, il descend en
//     escalier (tryNightWork) et travaille la nuit en bas ; l'abri de surface n'est que le dernier recours.
//  2. undergroundShelterVeto — Massii 25/10 : « s'ils passent leur temps sous terre à miner, pas besoin de
//     se faire un couvert, ça leur fait perdre que du temps ». Sous terre, jamais de puits, de mur ni
//     d'attente de l'aube : il mine, se défend, pose ses torches. Seule exception, l'URGENCE RÉELLE : un
//     hostile collé (≤ 3 blocs) avec des PV critiques (≤ 6).

const DUSK_DEEP_MAX_WORN = 2;          // < 2 pièces portées = nu ou peu armé
const WORK_DEEP_Y = 45;                // chantier « profond » = sous la frontière de nuit (NIGHT_UNDERGROUND_Y)
const WORK_DEEP_MIN_RISE = 8;          // déjà à moins de 8 blocs au-dessus : rien à gagner au /home
const WORK_DEEP_MAX_AGE_MS = 2 * 60 * 60 * 1000;
const WORK_CAMP_RADIUS = 16;
const WORK_CAMP_WINDOW_MS = 15 * 60 * 1000;
const WORK_CAMP_DEATHS = 2;
const URGENT_HP = 6;                   // = homewarp.IMMINENT_HP
const URGENT_DIST = 3;

function _fin(n) { return typeof n === 'number' && Number.isFinite(n); }
function _pos(p) { return (p && _fin(p.x) && _fin(p.y) && _fin(p.z)) ? p : null; }

/**
 * PUR — chantier profond mémorisé encore utilisable ? work = { x, y, z, at } (mémo base `workDepth`).
 * → { ok, why } : sous y 45, récent (≤ 2 h), au moins 8 blocs sous le bot, pas un camp de mort
 * (2 morts à ≤ 16 blocs en 15 min).
 */
function workDeepUsable({ work, pos, now, deaths } = {}) {
  const w = _pos(work);
  if (!w || !_fin(work.at)) return { ok: false, why: 'none' };
  if (!_fin(now) || work.at > now || now - work.at > WORK_DEEP_MAX_AGE_MS) return { ok: false, why: 'stale' };
  if (w.y >= WORK_DEEP_Y) return { ok: false, why: 'shallow' };
  const p = _pos(pos);
  if (p && p.y - w.y < WORK_DEEP_MIN_RISE) return { ok: false, why: 'already_deep' };
  const camped = (Array.isArray(deaths) ? deaths : []).filter((d) => _pos(d) && _fin(d.at) && d.at <= now
    && now - d.at <= WORK_CAMP_WINDOW_MS && Math.hypot(d.x - w.x, d.y - w.y, d.z - w.z) <= WORK_CAMP_RADIUS);
  if (camped.length >= WORK_CAMP_DEATHS) return { ok: false, why: 'camped' };
  return { ok: true, why: 'ok' };
}

/**
 * PUR — au crépuscule / la nuit, que fait un bot en surface ?
 * sig = { dusk, night, underground, worn, inWater, isMapper, isLumberjack, hasPick, work, pos, now, deaths }
 * → { action: 'none' | 'work_home' | 'descend' | 'shelter', why }
 *   'none'      : rien à décider ici (jour, déjà sous terre, bot assez armé → comportement historique) ;
 *   'work_home' : /home work vers le chantier profond, puis il y travaille ;
 *   'descend'   : escalier vers le bas + sceau + torche (tryNightWork) ;
 *   'shelter'   : l'abri de surface (mappeur, bûcheron, pas de pioche, dans l'eau).
 */
function duskDeepPlan(sig = {}) {
  const s = sig || {};
  if (!s.dusk && !s.night) return { action: 'none', why: 'day' };
  if (s.underground) return { action: 'none', why: 'underground' };
  if (_fin(s.worn) && s.worn >= DUSK_DEEP_MAX_WORN) return { action: 'none', why: 'armored' };
  if (s.isMapper) return { action: 'shelter', why: 'mapper' };
  if (s.isLumberjack) return { action: 'shelter', why: 'lumberjack' };
  if (s.inWater) return { action: 'shelter', why: 'water' };
  const wk = workDeepUsable({ work: s.work, pos: s.pos, now: s.now, deaths: s.deaths });
  if (wk.ok) return { action: 'work_home', why: 'work' };
  if (s.hasPick) return { action: 'descend', why: 'no_work:' + wk.why };
  return { action: 'shelter', why: 'no_pick' };
}

/**
 * PUR — sous terre, refuser l'abri (puits, mur, attente) ? true = PAS d'abri.
 * sig = { underground, hp, threatDist }. Urgence réelle (hostile ≤ 3 blocs ET PV ≤ 6) : l'abri reste permis.
 */
function undergroundShelterVeto(sig = {}) {
  const s = sig || {};
  if (!s.underground) return false;
  const urgent = _fin(s.hp) && s.hp <= URGENT_HP && _fin(s.threatDist) && s.threatDist <= URGENT_DIST;
  return !urgent;
}

module.exports = {
  duskDeepPlan, workDeepUsable, undergroundShelterVeto,
  DUSK_DEEP_MAX_WORN, WORK_DEEP_Y, WORK_DEEP_MIN_RISE, WORK_DEEP_MAX_AGE_MS, URGENT_HP, URGENT_DIST,
};
