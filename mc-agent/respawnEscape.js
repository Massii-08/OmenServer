'use strict';
// SORTIR D'UN POINT DE RÉAPPARITION CAMPÉ COMME UN JOUEUR (live 23/10, world_oct22, NethBot1).
//
// Mesuré (sessions 477/482, journal serveur 16:30-16:50 UTC) : nu, chrono de zéro, 9 morts en 20 min
// (zombies, araignée, squelette, noyade) autour du MÊME point de réapparition (5,71,-605), à ~600 blocs
// de l'équipe. À chaque vie : `spawn_guard hide` (zombie à 4 blocs) → pilier raté (`place_failed`) →
// fuite d'avant-abri coincée (`respawn_flee_done dist:0.3`) → mort. L'évasion à pied n'était tentée
// qu'APRÈS l'abri ET au calme — jamais, dans un camp où il y a toujours un zombie à 4 blocs — et elle
// ne courait que 30-60 blocs (`death_camp_escape_failed hostileDist:7`). Rien ne déplaçait le point de
// réapparition : le seul ré-ancrage tenté (`void_reanchor`, après un faux « vide » de 4 blocs sous la
// réapparition) était, à raison, VETOÉ dans le camp (`spawnpoint_vetoed camped` ×100, toutes les 3 s
// pendant 5 min) — et abandonné dès que le bot s'éloignait de 24 blocs. Le veto disait « pas ici »,
// personne ne disait « ailleurs ».
//
// Ce qu'un joueur fait : il se fait téléporter chez un coéquipier équipé (/tpa), sinon il COURT loin
// (≥ 48 blocs, sans s'arrêter au premier zombie), puis, une fois au calme sur un sol plein, il repose
// son point de réapparition loin du camp. Décisions PURES ici ; la glue vit dans index.js.

const CAMP_ESCAPE_MIN_DIST = 48;          // fuite à pied / ré-ancrage : au moins ça du camp
const CAMP_ESCAPE_MAX_DIST = 64;
const CAMP_DEATH_WINDOW_MS = 5 * 60 * 1000;   // « ≥ 2 morts en ≤ 5 min au point de réapparition »
const CAMP_DEATH_RADIUS = 24;             // même rayon que homeSafety.spawnpointVeto
const CAMP_MIN_DEATHS = 2;
const MATE_FRESH_MS = 150 * 1000;         // heartbeat toutes les 60 s : 2,5 battements = vivant
const MATE_MIN_WORN = 2;                  // « armé » = ≥ 2 pièces de fer PORTÉES (seuil SPAWN_DANGER_MIN_WORN)
const REANCHOR_CALM_RADIUS = 16;          // aucun hostile à ≤ 16 blocs (= ESCAPE_SAFE_RADIUS)
const REANCHOR_MIN_BLOCK_LIGHT = 8;
const REANCHOR_MIN_SKY_LIGHT = 12;
const PENDING_TTL_MS = 30 * 60 * 1000;    // = respawnCamp.CAMPED_TTL_MS

const _num = (v) => typeof v === 'number' && Number.isFinite(v);
const _d2 = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);

/**
 * PUR — le point où l'on vient de réapparaître est-il un camp ? Deux preuves, l'une suffit :
 *   - respawnCamp.campedRespawn (≥ 2 vies de < 60 s commencées ici, rendu en `shortLives`) ;
 *   - ≥ 2 morts à ≤ 24 blocs de ce point dans les 5 dernières minutes (`deathPos` du mémo).
 * @param {{spawn:{x,z}, deathPos?:Array<{x,z,at}>, shortLives?:{x,z,deaths}|null, now:number}} o
 * @returns {{x:number, z:number, deaths:number, why:'short_lives'|'deaths_near'}|null}
 */
function respawnCampVerdict(o = {}) {
  const s = o && o.spawn;
  if (!s || !_num(s.x) || !_num(s.z) || !_num(o.now)) return null;
  const sl = o.shortLives;
  if (sl && _num(sl.x) && _num(sl.z) && _d2(sl, s) <= CAMP_DEATH_RADIUS) {
    return { x: Math.round(sl.x), z: Math.round(sl.z), deaths: sl.deaths || CAMP_MIN_DEATHS, why: 'short_lives' };
  }
  const n = (Array.isArray(o.deathPos) ? o.deathPos : []).filter((d) => d && _num(d.x) && _num(d.z) && _num(d.at)
    && d.at <= o.now && o.now - d.at <= CAMP_DEATH_WINDOW_MS && _d2(d, s) <= CAMP_DEATH_RADIUS).length;
  if (n >= CAMP_MIN_DEATHS) return { x: Math.round(s.x), z: Math.round(s.z), deaths: n, why: 'deaths_near' };
  return null;
}

/** Ce coéquipier est-il un mineur AU TRAVAIL (sous terre, fer produit dans sa zone) ? */
function _working(m) { return _num(m.y) && m.y <= 40 && (m.ironZone || 0) > 0; }

/**
 * PUR — chez qui se faire téléporter ? Un coéquipier VIVANT (heartbeat frais), MINEUR (ni cartographe,
 * ni bûcheron), ARMÉ (≥ 2 pièces de fer portées : `worn` du heartbeat) et LOIN du camp (≥ 48 blocs —
 * se téléporter dans le camp n'est pas une fuite). Le mieux armé d'abord, puis le mineur au travail,
 * puis le plus proche, puis le nom (déterministe). null si personne.
 * @param {{camp:{x,z}, selfName?:string, mates?:Array, now:number, minWorn?:number, freshMs?:number}} o
 */
function pickRescueMate(o = {}) {
  const camp = o && o.camp;
  if (!camp || !_num(camp.x) || !_num(camp.z) || !_num(o.now)) return null;
  const minWorn = _num(o.minWorn) ? o.minWorn : MATE_MIN_WORN;
  const freshMs = _num(o.freshMs) ? o.freshMs : MATE_FRESH_MS;
  const self = o.self && _num(o.self.x) && _num(o.self.z) ? o.self : camp;
  const cands = (Array.isArray(o.mates) ? o.mates : []).filter((m) => m && m.name && m.name !== o.selfName
    && m.role !== 'mapper' && (m.role !== 'lumberjack' || o.allowLumberjack === true)
    && _num(m.x) && _num(m.z) && _num(m.at) && m.at <= o.now + 5000 && o.now - m.at <= freshMs
    && _num(m.worn) && m.worn >= minWorn
    && _d2(m, camp) >= CAMP_ESCAPE_MIN_DIST);
  if (!cands.length) return null;
  cands.sort((a, b) => (b.worn - a.worn) || (Number(_working(b)) - Number(_working(a)))
    || (_d2(a, self) - _d2(b, self)) || String(a.name).localeCompare(String(b.name)));
  const m = cands[0];
  return { name: m.name, dist: Math.round(_d2(m, self)), worn: m.worn, working: _working(m) };
}

/**
 * PUR — peut-on reposer le point de réapparition ICI, maintenant ? (sorti du camp et au calme)
 * @param {{pending:{x,z,at}|null, pos:{x,y,z}, now:number, busy?:boolean, onGround?:boolean, inWater?:boolean,
 *          groundOk?:boolean|null, hostileDist?:number|null, camped?:boolean,
 *          blockLight?:number|null, skyLight?:number|null, night?:boolean|null}} o
 *   `groundOk` = voidGuard.groundCheck (≥ 2 pleins sous les pieds) : il faut un `true` EXPLICITE (chunk
 *   illisible = on attend). `camped` = homeSafety.spawnpointVeto ICI (≥ 2 morts à ≤ 24 blocs).
 *   Lumière : lumière de bloc ≥ 8, OU ciel ouvert (≥ 12) de jour ; illisible des deux côtés = on ne bloque pas.
 * @returns {{ok:boolean, reason:string, dist?:number, expired?:boolean}}
 */
function reanchorReady(o = {}) {
  const pend = o && o.pending;
  if (!pend || !_num(pend.x) || !_num(pend.z)) return { ok: false, reason: 'no_pending' };
  if (_num(pend.at) && _num(o.now) && o.now - pend.at > PENDING_TTL_MS) return { ok: false, reason: 'expired', expired: true };
  const p = o.pos;
  if (!p || !_num(p.x) || !_num(p.z)) return { ok: false, reason: 'no_position' };
  const dist = _d2(p, pend);
  if (dist < CAMP_ESCAPE_MIN_DIST) return { ok: false, reason: 'too_close', dist };
  if (o.busy) return { ok: false, reason: 'busy', dist };
  if (o.onGround === false || o.inWater) return { ok: false, reason: 'not_standing', dist };
  if (o.groundOk !== true) return { ok: false, reason: 'no_ground', dist };
  if (_num(o.hostileDist) && o.hostileDist <= REANCHOR_CALM_RADIUS) return { ok: false, reason: 'hostile_near', dist };
  if (o.camped) return { ok: false, reason: 'camped', dist };
  const bl = _num(o.blockLight) ? o.blockLight : null;
  const sl = _num(o.skyLight) ? o.skyLight : null;
  if (bl != null || sl != null) {
    const lit = (bl != null && bl >= REANCHOR_MIN_BLOCK_LIGHT) || (sl != null && sl >= REANCHOR_MIN_SKY_LIGHT && o.night !== true);
    if (!lit) return { ok: false, reason: 'dark', dist };
  }
  return { ok: true, reason: 'ok', dist };
}

/**
 * PUR — la base persistée est-elle DANS un camp ? (≤ 24 blocs d'un camp connu : le camp de réapparition
 * en attente, les camps du mémo, ou un lieu marqué campé/banni par l'appelant via `flagged`).
 * Pourquoi : NethBot1 23/10, base (24,-604) à 19 blocs du camp (5,-605) — chaque rappel du confine
 * (`confine_enforce dist:667` → /home safe) le renvoyait mourir au camp, même après en être sorti.
 * @param {{base:{x,z}|null, camps?:Array<{x,z}>, flagged?:boolean, radius?:number}} o
 */
function baseInCamp(o = {}) {
  const b = o && o.base;
  if (!b || !_num(b.x) || !_num(b.z)) return false;
  if (o.flagged === true) return true;
  const r = _num(o.radius) ? o.radius : CAMP_DEATH_RADIUS;
  return (Array.isArray(o.camps) ? o.camps : []).some((c) => c && _num(c.x) && _num(c.z) && _d2(c, b) <= r);
}

module.exports = {
  baseInCamp,
  CAMP_ESCAPE_MIN_DIST, CAMP_ESCAPE_MAX_DIST, CAMP_DEATH_WINDOW_MS, CAMP_DEATH_RADIUS, CAMP_MIN_DEATHS,
  MATE_FRESH_MS, MATE_MIN_WORN, REANCHOR_CALM_RADIUS, PENDING_TTL_MS,
  respawnCampVerdict, pickRescueMate, reanchorReady,
};
