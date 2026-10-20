'use strict';
// ENDERMAN — ne jamais le regarder, et savoir quoi faire quand il est déjà en colère (run 20/10).
//
// Mesuré live (world_oct9, 20/10) : 3 morts « slain by Enderman » en 1 h 20 (MapBot1 en surface,
// NethBot3 à y 23, NethBot2 en surface), aucune précédée d'un combat choisi : le bot ne réagissait
// pas du tout. Deux trous dans le code :
//   1. RIEN ne protégeait le REGARD. Un enderman s'énerve quand on regarde sa tête (vanilla
//      `Enderman.isLookingAtMe` : produit scalaire vue·(yeux de l'enderman) > 1 − 0,025 / distance,
//      jusqu'à 64 blocs, ligne de vue). Or TOUS les bots tournent avec --humanize 1 : la boucle de
//      bruit de visée idle balaie la tête toutes les ~250 ms, et le pathfinder marche pitch 0 — un
//      enderman à 15 blocs, yeux à 2,55, est à 3,5° de l'horizon pour un cône vanilla de 3,3°.
//   2. Une fois énervé, il était INVISIBLE : `NEUTRAL_NO_PROVOKE` (survival.js), aura.js, gather.js et
//      la garde de spawn l'écartent tous (à raison tant qu'il est calme) — un enderman qui frappe ne
//      déclenchait donc ni fuite ni combat.
//
// Ici, tout est PUR (vecteurs, décisions) ; index.js ne fait que câbler. La seule fonction qui touche
// un bot (`wrapLook`) le reçoit en argument et se teste avec un faux bot.

const ENDERMAN = 'enderman';
const LOOK_RANGE = 64;            // vanilla : au-delà, il ne « voit » pas qu'on le regarde
const EYE_HEIGHT = 2.55;          // yeux de l'enderman (hauteur 2,9)
const HEAD_TOP = 2.9;
const VANILLA_K = 0.025;          // seuil vanilla : dot > 1 − K / d
const MARGIN = 2;                 // on DOUBLE le cône vanilla (visée interpolée, latence réseau)
const MIN_CONE_RAD = 5 * Math.PI / 180;   // et jamais moins de ~5° (spec Massii)
// Pitchs de repli, du plus naturel au plus extrême (pitch mineflayer : positif = vers le HAUT).
// Regarder ses pieds est le geste humain classique ; si l'enderman est EN DESSOUS (grotte), on lève.
const SAFE_PITCHES = [-0.7, -1.1, -1.5, 1.1, 1.5];

const ANGRY_DIST = 2.5;           // repli sans métadonnée : collé = menace
const WATER_RADIUS = 6;           // l'eau le blesse : il ne nous suit pas dedans
const ENDERMAN_FIGHT_WEIGHT = 2;  // 40 PV, ~10 de dégâts en Hard : il compte pour deux mobs

/** Vecteur de vue mineflayer (même convention que bot.lookAt : yaw = atan2(-dx, -dz), pitch = atan2(dy, sol)). */
function viewVector(yaw, pitch) {
  const c = Math.cos(pitch);
  return { x: -Math.sin(yaw) * c, y: Math.sin(pitch), z: -Math.cos(yaw) * c };
}

function _isEnderman(e) {
  return !!(e && e.name === ENDERMAN && e.position && Number.isFinite(e.position.x));
}

function _list(entities) {
  if (!entities) return [];
  return Array.isArray(entities) ? entities : Object.values(entities);
}

/**
 * PUR — la direction (yaw, pitch) depuis `selfEye` pointe-t-elle vers la tête d'un enderman à ≤ 64 blocs ?
 * Rend l'enderman fautif, ou null. On teste plusieurs hauteurs de la tête (yeux, haut du crâne, milieu)
 * et un cône = max(2 × cône vanilla, 5°) : mieux vaut baisser les yeux pour rien que mourir.
 */
function lookIsUnsafe(yaw, pitch, selfEye, entities, opts = {}) {
  if (!selfEye || !Number.isFinite(yaw) || !Number.isFinite(pitch)) return null;
  const range = opts.range || LOOK_RANGE;
  const v = viewVector(yaw, pitch);
  const minCos = Math.cos(MIN_CONE_RAD);
  for (const e of _list(entities)) {
    if (!_isEnderman(e)) continue;
    for (const h of [EYE_HEIGHT, HEAD_TOP, (EYE_HEIGHT + HEAD_TOP) / 2 - 0.4]) {
      const dx = e.position.x - selfEye.x;
      const dy = e.position.y + h - selfEye.y;
      const dz = e.position.z - selfEye.z;
      const d = Math.hypot(dx, dy, dz);
      if (!(d > 1e-6) || d > range) continue;
      const dot = (v.x * dx + v.y * dy + v.z * dz) / d;
      const threshold = Math.min(1 - MARGIN * VANILLA_K / d, minCos);
      if (dot > threshold) return e;
    }
  }
  return null;
}

/**
 * PUR — la visée à appliquer : la demandée si elle est sûre, sinon le même yaw avec un pitch de repli
 * (yeux vers le sol d'abord). `{ yaw, pitch, avoided, enderman }`.
 */
function safeLook(yaw, pitch, selfEye, entities, opts = {}) {
  const bad = lookIsUnsafe(yaw, pitch, selfEye, entities, opts);
  if (!bad) return { yaw, pitch, avoided: false, enderman: null };
  for (const p of SAFE_PITCHES) {
    if (!lookIsUnsafe(yaw, p, selfEye, entities, opts)) return { yaw, pitch: p, avoided: true, enderman: bad };
  }
  return { yaw, pitch: -Math.PI / 2, avoided: true, enderman: bad };
}

/** Index de la métadonnée « creepy » (enderman qui hurle = il nous cible) d'après minecraft-data. */
function creepyIndex(registry) {
  try {
    const def = registry && registry.entitiesByName && registry.entitiesByName[ENDERMAN];
    const i = def && Array.isArray(def.metadataKeys) ? def.metadataKeys.indexOf('creepy') : -1;
    if (i >= 0) return i;
  } catch (e) { /* repli ci-dessous */ }
  return 17;   // 1.21.x
}

/**
 * PUR — cet enderman est-il EN COLÈRE contre nous ?
 * Source sûre : la métadonnée « creepy » (posée par le serveur quand il prend une cible). Repli si la
 * métadonnée manque : il vient de nous frapper (`hurtBy`) ou il est collé (≤ 2,5 blocs).
 */
function isAngryEnderman(e, { creepyIdx = 17, selfPos = null, hurtBy = false } = {}) {
  if (!_isEnderman(e)) return false;
  const md = e.metadata;
  if (Array.isArray(md) && md[creepyIdx] === true) return true;
  if (md && !Array.isArray(md) && typeof md === 'object' && md[creepyIdx] === true) return true;
  if (hurtBy) return true;
  if (selfPos) {
    const d = Math.hypot(e.position.x - selfPos.x, e.position.y - selfPos.y, e.position.z - selfPos.z);
    if (d <= ANGRY_DIST) return true;
  }
  return false;
}

/**
 * PUR — que faire face à un enderman énervé ?
 *   'water' : de l'eau à ≤ 6 blocs → y entrer (il fuit l'eau, qui le blesse) ;
 *   'fight' : la règle canDealWith le permet (boldFightAdvised injecté, l'enderman compte double) ;
 *   'flee'  : sinon.
 */
function endermanResponse({ waterDist = null, health, canDealWith, food, boldFightAdvised } = {}) {
  if (Number.isFinite(waterDist) && waterDist <= WATER_RADIUS) return 'water';
  if (typeof boldFightAdvised === 'function'
      && boldFightAdvised({ health, fightCount: ENDERMAN_FIGHT_WEIGHT, canDealWith, food })) return 'fight';
  return 'flee';
}

/**
 * Enveloppe `bot.look` : toute visée (pathfinder, lookAt, bruit idle, combat) passe par `safeLook`.
 * `opts.entities()` → entités ; `opts.eye()` → position des yeux du bot ; `opts.allow()` → true pour
 * laisser passer tel quel (on combat l'enderman exprès) ; `opts.onAvoid(info)`.
 * Idempotent (un 2e appel ne ré-enveloppe pas). Rend la fonction d'origine.
 */
function wrapLook(bot, opts = {}) {
  if (!bot || typeof bot.look !== 'function') return null;
  if (bot.look._endermanGuard) return bot.look._orig;
  const orig = bot.look.bind(bot);
  const guarded = (yaw, pitch, force) => {
    try {
      if (!(opts.allow && opts.allow())) {
        const eye = opts.eye ? opts.eye() : null;
        const s = safeLook(yaw, pitch, eye, opts.entities ? opts.entities() : null);
        if (s.avoided) {
          if (opts.onAvoid) { try { opts.onAvoid(s); } catch (e) { /* observabilité seulement */ } }
          return orig(s.yaw, s.pitch, force);
        }
      }
    } catch (e) { /* garde best-effort : jamais bloquer une visée */ }
    return orig(yaw, pitch, force);
  };
  guarded._endermanGuard = true;
  guarded._orig = orig;
  bot.look = guarded;
  return orig;
}

module.exports = {
  viewVector, lookIsUnsafe, safeLook, creepyIndex, isAngryEnderman, endermanResponse, wrapLook,
  LOOK_RANGE, EYE_HEIGHT, VANILLA_K, MARGIN, MIN_CONE_RAD, SAFE_PITCHES, ANGRY_DIST, WATER_RADIUS,
  ENDERMAN_FIGHT_WEIGHT,
};
