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
 * PUR — POURQUOI cet enderman serait-il en colère contre nous ? 'creepy' | 'hurt' | 'close' | null.
 * Source sûre : la métadonnée « creepy » (posée par le serveur quand il prend une cible).
 * ⚠️ Live 21/10 (3 morts « slain by Enderman » de cartographes nus en 37 min, toutes précédées d'un
 * `enderman_fight` à 2,2-3,7 blocs, PV 15-20) : le repli « collé = menace » traitait en colère un
 * enderman CALME qui passait à 2 blocs — et le frapper le provoquait. Or le serveur n'envoie que les
 * métadonnées non par défaut : « creepy » ABSENT d'une métadonnée connue = jamais énervé depuis qu'on
 * le voit = calme. Le repli de proximité ne vaut donc QUE si la métadonnée manque entièrement.
 */
function angerReason(e, { creepyIdx = 17, selfPos = null, hurtBy = false } = {}) {
  if (!_isEnderman(e)) return null;
  const md = e.metadata;
  const known = !!(md && typeof md === 'object');
  const flag = known ? md[creepyIdx] : undefined;
  if (flag === true) return 'creepy';
  if (hurtBy) return 'hurt';
  if (known) return null;                       // métadonnée lue : pas « creepy » → calme, même collé
  if (selfPos) {
    const d = Math.hypot(e.position.x - selfPos.x, e.position.y - selfPos.y, e.position.z - selfPos.z);
    if (d <= ANGRY_DIST) return 'close';
  }
  return null;
}

/** PUR — cet enderman est-il EN COLÈRE contre nous ? (cf. angerReason) */
function isAngryEnderman(e, opts = {}) {
  return angerReason(e, opts) != null;
}

/**
 * PUR — quel enderman nous a frappés ? Rend l'enderman coupable, ou null.
 * `source` = l'entité responsable rapportée par le serveur (damage_event 1.20+, 2e argument de
 * `entityHurt`). Live 21/10 (MapBot1, 14:45) : un coup de ZOMBIE pendant un combat a été mis sur le dos
 * d'un enderman à 4 blocs → `enderman_fight` → enderman provoqué → mort. Avec une source connue, seul
 * un enderman source est coupable ; sans source, un enderman collé ne l'est que si aucun AUTRE hostile
 * n'est aussi près (sinon c'est lui le suspect évident).
 */
function hurtCulprit(source, entities, selfPos, radius = 4) {
  if (source) return _isEnderman(source) ? source : null;
  if (!selfPos) return null;
  let culprit = null;
  let best = Infinity;
  for (const e of _list(entities)) {
    if (!e || !e.position) continue;
    const d = Math.hypot(e.position.x - selfPos.x, e.position.y - selfPos.y, e.position.z - selfPos.z);
    if (d > radius) continue;
    if (_isEnderman(e)) { if (d < best) { best = d; culprit = e; } } else if (e.kind === 'Hostile mobs') return null;
  }
  return culprit;
}

/**
 * PUR — que faire face à un enderman énervé ?
 *   'water' : de l'eau à ≤ 6 blocs → y entrer (il fuit l'eau, qui le blesse) ;
 *   'hide'  : bot qui ne combat pas (cartographe, `preferFlee`) avec des blocs en poche → se murer sur
 *             place (2 de haut, 4 côtés : un enderman de 2,9 ne peut ni y entrer ni frapper par-dessus) ;
 *   'flee'  : bot qui ne combat pas sans blocs, ou NU (40 PV, ~10 de dégâts en Hard : un bot nu ne gagne
 *             pas ce duel — live 21/10, 3/3 cartographes morts en le combattant) ;
 *   'fight' : sinon, si canDealWith le permet (boldFightAdvised injecté, l'enderman compte double).
 */
function endermanResponse({ waterDist = null, health, canDealWith, food, boldFightAdvised, preferFlee = false, naked = false, hasBlock = false } = {}) {
  if (Number.isFinite(waterDist) && waterDist <= WATER_RADIUS) return 'water';
  if (preferFlee) return hasBlock ? 'hide' : 'flee';
  if (naked) return 'flee';
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
  viewVector, lookIsUnsafe, safeLook, creepyIndex, angerReason, isAngryEnderman, hurtCulprit, endermanResponse, wrapLook,
  LOOK_RANGE, EYE_HEIGHT, VANILLA_K, MARGIN, MIN_CONE_RAD, SAFE_PITCHES, ANGRY_DIST, WATER_RADIUS,
  ENDERMAN_FIGHT_WEIGHT,
};
