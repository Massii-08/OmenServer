'use strict';
// HOME `safe` CAMPÉ — mesuré live le 19/10 sur un monde neuf : spawn sous la CANOPÉE d'une vieille
// forêt de bouleaux, où zombies, squelettes et creepers ne brûlent pas de jour.
//
// Le home `safe` est posé au spawn, et c'est la destination de secours de TOUT le code : sauvetage de
// noyade, retour du cartographe avant de s'abriter la nuit, sortie d'urgence `imminent_escape`,
// remontée nourriture, relocate sous NO_GIVE… Or ce spawn était CAMPÉ. MapBot2 y est mort 8 fois en
// 3 min, en boucle :
//   mapper_home_return > safe_warp:safe > reflex:fight > shelter:dig_in > reflex:flee > mort
//   water_rescue_warp:drowning > water_rescue_home_safe > … > mort
// Chaque « secours » le RAMENAIT dans le camp qui venait de le tuer (12 morts en 5 min sur la flotte,
// dont 6 creepers). Un humain ne rentre pas dormir dans la maison où il vient de mourir trois fois.
//
// Décisions PURES (aucun accès bot/fs, horloge injectée) ; la glue vit dans index.js :
//   1. homeCamped          : ≥ 2 morts RÉELLES à ≤ 24 blocs du home dans les 10 dernières minutes ;
//   2. rescueWarpVeto      : home campé ET (nuit OU hostile signalé près du home) → le warp de SECOURS
//                            n'a pas lieu ; l'appelant prend son repli habituel (nager, creuser sur
//                            place, s'abriter là où il est) — un repli local bat un aller simple au camp ;
//   3. safeHomeMove        : en surface, au sec, de JOUR, au calme, LOIN du camp → `/sethome safe` ICI ;
//   4. spawnSafeHomeAction : au spawn d'un process neuf, ne pas re-poser `safe` DANS le camp.
//
// Les positions de mort sont persistées dans le mémo de base (champ `deathPos`, À CÔTÉ des instants
// `deaths` d'unstuck.js, qui restent des nombres : escapeArmed/deathLoopTripped n'en savent rien, et un
// ancien lecteur ignore simplement le champ). Elles DOIVENT survivre au process : le death_loop fait
// process.exit(2) et le process neuf respawne… au même camp — une mémoire de process ne le verrait
// jamais (même classe que les pièges #52/#63b).
// Distinct de deathspots.js (morts répétées, mémoire de SESSION, XZ, pour les électeurs de cible) et de
// deathzones.js (alertes PRÉ-mortem) : ici la seule question est « ma destination de secours est-elle un
// piège ? », et la réponse doit être la même dans le process suivant.

const { isSurfaceSpot } = require('./homes');

const CAMP_RADIUS = 24;                    // « près du home »
const CAMP_WINDOW_MS = 10 * 60 * 1000;     // morts des 10 dernières minutes (= fenêtre de `deaths`, épinglé)
const CAMP_MIN_DEATHS = 2;                 // 1 mort = accident ; 2 au même endroit = camp
const DEATH_POS_CAP = 10;                  // le mémo reste minuscule (2 suffisent à juger)
const HOSTILE_SEEN_MS = 5 * 60 * 1000;     // un hostile aperçu près du home y « campe » encore 5 min
const CAMPED_EVENT_EVERY_MS = 60 * 1000;   // `home_safe_camped` : 1×/min max (les watchdogs tournent à 1 s)
const MOVE_EVERY_MS = 5 * 60 * 1000;       // `home_safe_moved` : 1×/5 min max
const MOVE_CALM_RADIUS = 24;               // aucun hostile à ≤ 24 blocs du bot pour re-poser ici

function _finite(n) { return typeof n === 'number' && Number.isFinite(n); }

/** {x,y,z} propre (y = null si illisible) ou null si x/z manquent. */
function _pos(p) {
  if (!p || !_finite(p.x) || !_finite(p.z)) return null;
  return { x: p.x, y: _finite(p.y) ? p.y : null, z: p.z };
}

/**
 * Distance 3D quand les DEUX altitudes sont connues : deux morts au fond de la mine creusée SOUS la base
 * ne campent pas la base de surface (même XZ, 50 blocs de roche entre les deux). Altitude illisible
 * d'un côté → horizontale (on ne perd pas une mort sur une lecture ratée).
 */
function _dist(a, b) {
  const dx = a.x - b.x;
  const dz = a.z - b.z;
  if (_finite(a.y) && _finite(b.y)) return Math.hypot(dx, a.y - b.y, dz);
  return Math.hypot(dx, dz);
}

/**
 * PUR — positions de mort à garder : x/z/at finis, `at` ≤ now et âgé de MOINS de `windowMs` (frontière
 * exclusive, comme deathTimesPrune), arrondies, triées de la plus ancienne à la plus récente, plafonnées
 * aux `cap` plus récentes. Ne mute jamais l'entrée ; toute entrée absurde → [].
 * Une mort datée du FUTUR est jetée (horloge reculée, mémo hérité d'un autre monde).
 * @param {Array<{x,y,z,at}>} list
 * @param {number} now
 * @param {{windowMs?: number, cap?: number}} [opts]  `cap: Infinity` = pas de plafond (comptage).
 */
function deathPosPrune(list, now, opts) {
  if (!Array.isArray(list) || !_finite(now)) return [];
  const o = (opts && typeof opts === 'object') ? opts : {};
  const windowMs = _finite(o.windowMs) ? o.windowMs : CAMP_WINDOW_MS;
  const cap = (typeof o.cap === 'number' && o.cap > 0) ? o.cap : DEATH_POS_CAP;
  const kept = [];
  for (const d of list) {
    if (!d || typeof d !== 'object' || !_finite(d.x) || !_finite(d.z) || !_finite(d.at)) continue;
    if (d.at > now || (now - d.at) >= windowMs) continue;
    kept.push({ x: Math.round(d.x), y: _finite(d.y) ? Math.round(d.y) : null, z: Math.round(d.z), at: d.at });
  }
  kept.sort((a, b) => a.at - b.at);
  return kept.length > cap ? kept.slice(kept.length - cap) : kept;
}

/** PUR — positions à reprendre d'un mémo (absent / ancien format sans le champ → []), élaguées À LA LECTURE. */
function deathPosLoad(memo, now) {
  return deathPosPrune(memo && typeof memo === 'object' ? memo.deathPos : null, now);
}

/**
 * PUR — le mémo à écrire : une COPIE où seul `deathPos` change (base, deaths, dette, zone, safeHome…
 * traversent intacts). Tout écrivain du mémo fusionne ainsi — un `{ ... }` neuf efface les champs des
 * autres (piège #61).
 */
function deathPosMemoWith(memo, list, now) {
  const base = (memo && typeof memo === 'object' && !Array.isArray(memo)) ? memo : {};
  return Object.assign({}, base, { deathPos: deathPosPrune(list, now) });
}

/** PUR — nombre de morts récentes à ≤ `radius` d'un point (0 si le point est illisible). */
function deathsNear(point, deaths, now, opts) {
  const p = _pos(point);
  if (!p || !_finite(now)) return 0;
  const o = (opts && typeof opts === 'object') ? opts : {};
  const radius = _finite(o.radius) ? o.radius : CAMP_RADIUS;
  return deathPosPrune(deaths, now, { windowMs: o.windowMs, cap: Infinity })
    .filter((d) => _dist(p, d) <= radius).length;
}

/**
 * PUR — le home est-il CAMPÉ ? ≥ `minDeaths` morts récentes à ≤ `radius` blocs de lui.
 * @param {{home, deaths, now, radius?, windowMs?, minDeaths?, hostilesNearHomeSeen?}} o
 *   `hostilesNearHomeSeen` est accepté (même objet de contexte que rescueWarpVeto) mais n'entre PAS dans
 *   la définition : un hostile aperçu n'a encore tué personne — c'est le DÉCLENCHEUR du veto (avec la
 *   nuit), pas une preuve de campement.
 */
function homeCamped(o = {}) {
  const minDeaths = _finite(o && o.minDeaths) ? o.minDeaths : CAMP_MIN_DEATHS;
  if (!o || !_pos(o.home)) return false;
  return deathsNear(o.home, o.deaths, o.now, o) >= minDeaths;
}

/**
 * PUR — faut-il REFUSER un `/spawnpoint` ICI ? (run 10, 20/10 : 39 `/spawnpoint` posés, 67 `home_safe_camped`
 * — le point de réapparition devenait le camp lui-même, et chaque mort renvoyait le bot nu sous les arcs.)
 * Veto SSI la position est illisible (on n'ancre pas à l'aveugle) OU campée au sens de homeCamped
 * (≥ 2 morts récentes à ≤ 24 blocs). Garder l'ancien point de réapparition est moins pire que d'en
 * cimenter un neuf dans le camp. Mêmes options que homeCamped (radius, windowMs, minDeaths).
 * @param {{pos, deaths, now}} o
 * @returns {{veto: boolean, reason: 'no_position'|'camped'|'ok', deaths?: number}}
 */
function spawnpointVeto(o = {}) {
  if (!o || !_pos(o.pos)) return { veto: true, reason: 'no_position' };
  const n = deathsNear(o.pos, o.deaths, o.now, o);
  const minDeaths = _finite(o.minDeaths) ? o.minDeaths : CAMP_MIN_DEATHS;
  if (n >= minDeaths) return { veto: true, reason: 'camped', deaths: n };
  return { veto: false, reason: 'ok', deaths: n };
}

/** PUR — un hostile a-t-il été SIGNALÉ près du home récemment ? (`true`, ou horodatage de moins de `ttlMs`) */
function hostileSeenRecently(seen, now, ttlMs = HOSTILE_SEEN_MS) {
  if (seen === true) return true;
  if (!_finite(seen) || seen <= 0 || !_finite(now)) return false;
  const age = now - seen;
  return age >= 0 && age <= ttlMs;
}

/**
 * PUR — faut-il REFUSER un warp de SECOURS vers ce home ?
 * Veto SSI le home est campé ET (nuit OU hostile signalé près du home). De jour, sans hostile signalé,
 * le secours part : le camp a peut-être brûlé à l'aube, et un repli local n'est pas gratuit non plus.
 * Heure inconnue (`night` null : bot.time pas livré juste après un spawn) → pas de veto sur la nuit,
 * même convention que debtAction / mapperCaution.
 * @param {{home, deaths, now, night?: boolean|null, hostilesNearHomeSeen?: boolean|number}} o
 * @returns {{veto: boolean, camped: boolean, why: 'night'|'hostile_near_home'|null, deaths: number}}
 */
function rescueWarpVeto(o = {}) {
  const n = (o && _pos(o.home)) ? deathsNear(o.home, o.deaths, o.now) : 0;
  if (n < CAMP_MIN_DEATHS) return { veto: false, camped: false, why: null, deaths: n };
  // L'hostile vu d'abord : c'est la preuve DIRECTE que le camp est occupé maintenant.
  if (hostileSeenRecently(o.hostilesNearHomeSeen, o.now)) return { veto: true, camped: true, why: 'hostile_near_home', deaths: n };
  if (o.night === true) return { veto: true, camped: true, why: 'night', deaths: n };
  return { veto: false, camped: true, why: null, deaths: n };
}

/**
 * PUR — faut-il RE-POSER le home `safe` ICI ?
 * Toutes les conditions, jamais l'une sans les autres : home actuel campé, cooldown passé, en SURFACE
 * au sec (même garde que tout `safe`, homes.isSurfaceSpot), les pieds au sol (un /sethome en plein saut
 * pose un home dans le vide), de JOUR SU, aucun hostile à ≤ 24 blocs, et « ailleurs » = HORS du camp :
 * à ≥ 24 blocs de l'ancien home et pas là où l'on meurt aussi.
 * @param {{home, here, deaths, now, inWater?, onGround?, night?, nearestHostileDist?: number|null,
 *          lastMovedAt?: number}} o
 * @returns {{move: boolean, reason: string, deaths: number}}
 *   reason : 'camped' (on bouge) | 'not_camped' | 'cooldown' | 'not_surface' | 'airborne' | 'night' |
 *            'time_unknown' | 'hostile_near' | 'too_close_to_home' | 'camped_here'.
 */
function safeHomeMove(o = {}) {
  const home = _pos(o && o.home);
  const n = home ? deathsNear(home, o.deaths, o.now) : 0;
  const out = (move, reason) => ({ move, reason, deaths: n });
  if (n < CAMP_MIN_DEATHS) return out(false, 'not_camped');
  if (_finite(o.lastMovedAt) && o.lastMovedAt > 0 && (o.now - o.lastMovedAt) < MOVE_EVERY_MS) return out(false, 'cooldown');
  const here = _pos(o.here);
  if (!here || !isSurfaceSpot({ y: here.y, inWater: !!o.inWater })) return out(false, 'not_surface');
  if (o.onGround !== true) return out(false, 'airborne');
  if (o.night !== false) return out(false, o.night === true ? 'night' : 'time_unknown');
  const hd = o.nearestHostileDist;
  if (hd != null && !(_finite(hd) && hd > MOVE_CALM_RADIUS)) return out(false, 'hostile_near');
  if (_dist(here, home) < CAMP_RADIUS) return out(false, 'too_close_to_home');
  if (deathsNear(here, o.deaths, o.now) >= CAMP_MIN_DEATHS) return out(false, 'camped_here');
  return out(true, 'camped');
}

/**
 * PUR — au spawn, que faire du home `safe` ?
 * Le bloc générique de onSpawn re-pose `safe` là où le bot apparaît dès qu'un process est NEUF
 * (`_safeHomeSet` repart à false) : après un death_loop, c'est-à-dire précisément dans le camp, il
 * annulait le déménagement du process précédent. Règle : ne jamais DÉPLACER un home qui marche DANS un
 * camp ; un bot sans home connu en pose quand même un (un home connu, même campé, est mis sous veto la
 * nuit et re-posé ailleurs dès que possible — un home inconnu ne peut être ni l'un ni l'autre).
 * @param {{here, deaths, now, hasSafe: boolean, persisted: {x,y,z,at}|null}} o
 * @returns {{act: 'pose'|'keep'|'adopt', camped: boolean, home?: {x,y,z,at}}}
 *   'pose'  → /sethome safe ici (comportement historique) ;
 *   'keep'  → un safe est déjà en main (amélioration surface demandée) : on ne le déplace pas dans le camp ;
 *   'adopt' → le home persisté (dernier /sethome safe de ce bot) est sain : c'est LUI, on ne re-pose rien.
 */
function spawnSafeHomeAction(o = {}) {
  const deaths = o && o.deaths;
  const now = o && o.now;
  if (!homeCamped({ home: o && o.here, deaths, now })) return { act: 'pose', camped: false };
  if (o.hasSafe) return { act: 'keep', camped: true };
  const ps = o.persisted;
  if (ps && _pos(ps) && _finite(ps.y) && !homeCamped({ home: ps, deaths, now })) {
    return { act: 'adopt', camped: true, home: ps };
  }
  return { act: 'pose', camped: true };
}

/** PUR — le home `safe` persisté (dernier /sethome safe de CE bot), ou null s'il manque une coordonnée. */
function safeHomeLoad(memo) {
  const s = memo && typeof memo === 'object' ? memo.safeHome : null;
  if (!s || typeof s !== 'object' || !_finite(s.x) || !_finite(s.y) || !_finite(s.z) || !_finite(s.at)) return null;
  const out = { x: s.x, y: s.y, z: s.z, at: s.at };
  if (typeof s.why === 'string') out.why = s.why;
  return out;
}

/** PUR — copie du mémo où seul `safeHome` change ; position illisible → copie inchangée. */
function safeHomeMemoWith(memo, pos, now, why) {
  const base = (memo && typeof memo === 'object' && !Array.isArray(memo)) ? memo : {};
  const p = _pos(pos);
  if (!p || !_finite(p.y) || !_finite(now)) return Object.assign({}, base);
  const safeHome = { x: Math.round(p.x), y: Math.round(p.y), z: Math.round(p.z), at: now };
  if (typeof why === 'string') safeHome.why = why;
  return Object.assign({}, base, { safeHome });
}

/**
 * PUR — l'hostile le plus proche d'un point (3D si les altitudes sont connues) → {dist, mob} ou null.
 * Un prédicat qui lève sur UNE entité ne tue ni la décision ni les autres entités.
 */
function nearestHostile({ pos, entities, isHostile } = {}) {
  const p = _pos(pos);
  if (!p || typeof isHostile !== 'function') return null;
  let best = null;
  for (const e of (Array.isArray(entities) ? entities : [])) {
    if (!e || !e.position) continue;
    let hostile = false;
    try { hostile = !!isHostile(e); } catch (err) { hostile = false; }
    if (!hostile) continue;
    const q = _pos(e.position);
    if (!q) continue;
    const d = _dist(p, q);
    if (!best || d < best.dist) best = { dist: d, mob: e.name || null };
  }
  return best;
}

/** PUR — un hostile est-il à ≤ `radius` blocs du HOME (pas du bot) ? */
function hostileNearHome({ home, entities, isHostile, radius = CAMP_RADIUS } = {}) {
  const best = nearestHostile({ pos: home, entities, isHostile });
  return !!best && best.dist <= radius;
}

module.exports = {
  homeCamped, spawnpointVeto, rescueWarpVeto, safeHomeMove, spawnSafeHomeAction,
  deathPosPrune, deathPosLoad, deathPosMemoWith, deathsNear,
  safeHomeLoad, safeHomeMemoWith, nearestHostile, hostileNearHome, hostileSeenRecently,
  CAMP_RADIUS, CAMP_WINDOW_MS, CAMP_MIN_DEATHS, DEATH_POS_CAP, HOSTILE_SEEN_MS,
  CAMPED_EVENT_EVERY_MS, MOVE_EVERY_MS, MOVE_CALM_RADIUS,
};
