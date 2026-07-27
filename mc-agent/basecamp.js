'use strict';
// « Base personnelle » — demande Massii 2026-07-26 (run world_ax5).
//
// LE PROBLÈME. `homewarp.js` pose le home 'safe' à l'endroit EXACT où le bot spawne, c'est-à-dire
// au spawn du monde. Conséquence mesurée sur le run world_ax4 : les 3 ouvriers et la totalité de
// leurs 235 respawns s'empilent sur le même carré de terrain →
//   (a) la forêt du spawn est rasée en une heure et le reste (récolte de bois : 93 % d'échec,
//       46 % de tous les buts du run — le goulot n°1 du projet) ;
//   (b) chaque mort renvoie au même endroit, donc à la même boucle de mort.
//
// LA CONSIGNE. « Les bots doivent aussi apprendre à survivre dès qu'ils spawnent (tu pourras pas
// changer le spawn juste pour éviter les morts) ; le mieux ce serait qu'ils se déplacent et
// mettent un home pour l'utiliser comme spawn. » Donc : on ne touche PAS au spawn du monde, le
// bot s'éloigne PAR SES PROPRES MOYENS, pose son home là-bas, et c'est ce home qui devient son
// point de départ après chaque mort.
//
// Décisions PURES et testables ici ; la marche, le /sethome et la persistance vivent dans index.js.
// Aucune horloge, aucun Math.random : un bot relancé par le self-healing doit retrouver LE MÊME
// cap (sinon il repart poser une base ailleurs à chaque mort, et on a re-créé le churn).

const { vanillaHint, DEPLETED_RADIUS } = require('./worldMemory');

// Sous cette distance du spawn du monde, on est encore dans la zone d'empilement (respawns des 3
// bots + zone déjà rasée) → une base posée là ne remplit pas son rôle.
const MIN_BASE_DIST = 64;
// Cible par défaut : assez loin pour avoir sa propre forêt, assez près pour que la marche
// d'installation ne soit pas un roaming mortel de nuit.
const BASE_DIST = 120;
// Au-delà, la marche d'installation coûte plus que ce qu'elle rapporte (un bot nu qui traverse
// 400 blocs de nuit meurt en route — c'est le churn qu'on essaie de tuer, pas de déplacer).
const BASE_MAX_DIST = 260;
// En-dessous de ce rayon autour de sa base, le bot est « chez lui » (pas de /home inutile).
const HOME_RADIUS = 40;
// Seuil « surface » (même valeur que homes.SAFE_HOME_MIN_Y / confine.js) : une base persistée sous
// ce Y est souterraine → `/home safe` mortel → re-établissement forcé au respawn.
const SURFACE_MIN_Y = 58;

function _horiz(ax, az, bx, bz) { return Math.hypot(ax - bx, az - bz); }

/** Écart angulaire absolu entre deux caps, replié sur [0, π] (gère le passage par 2π). */
function _angleDiff(a, b) {
  let d = (a - b) % (2 * Math.PI);
  if (d > Math.PI) d -= 2 * Math.PI;
  if (d < -Math.PI) d += 2 * Math.PI;
  return Math.abs(d);
}

function _pt(p, fallback) {
  const x = p && Number.isFinite(p.x) ? p.x : (fallback ? fallback.x : 0);
  const z = p && Number.isFinite(p.z) ? p.z : (fallback ? fallback.z : 0);
  return { x, z };
}

/**
 * Le bot doit-il (encore) établir sa base ? PUR.
 * Vrai si aucune base n'est enregistrée, OU si la base enregistrée est collée au spawn du monde
 * (cas des runs précédents : 'safe' posé sur place au boot → à re-poser ailleurs).
 * Spawn du monde inconnu → on garde la base connue (pas de re-marche gratuite).
 */
function needsBase({ base, spawn, minDist = MIN_BASE_DIST } = {}) {
  if (!base || !Number.isFinite(base.x) || !Number.isFinite(base.z)) return true;
  if (!spawn || !Number.isFinite(spawn.x) || !Number.isFinite(spawn.z)) return false;
  return _horiz(base.x, base.z, spawn.x, spawn.z) < minDist;
}

/**
 * Cap d'installation du bot `index` parmi `count`, en radians. PUR et déterministe.
 * Éventail régulier : 3 bots partent à 120° l'un de l'autre, donc chacun sa forêt — sans quoi ils
 * refont à trois exactement ce qu'ils faisaient à trois autour du spawn.
 */
function baseHeading(index, count, offset = 0) {
  const n = Number.isFinite(count) && count > 0 ? Math.floor(count) : 1;
  const i = Number.isFinite(index) ? Math.floor(index) : 0;
  return offset + (2 * Math.PI * (((i % n) + n) % n)) / n;
}

/**
 * Cap d'installation déduit du NOM du bot. PUR et déterministe.
 * On lit l'indice porté par le nom (NethBot1 → secteur 0, NethBot2 → secteur 1, …) plutôt qu'un
 * hash : les noms de la flotte ne diffèrent QUE par leur dernier caractère, et un FNV-1a leur
 * donnait 3 caps à moins de 5° l'un de l'autre (bases à ~9 blocs de distance = éventail annulé).
 * Nom sans indice → repli sur la somme des codes de caractères (déterministe, ça suffit).
 */
function headingForName(name, count) {
  const s = String(name == null ? '' : name);
  const m = s.match(/(\d+)\s*$/);
  let i;
  if (m) {
    const n = parseInt(m[1], 10);
    i = n > 0 ? n - 1 : 0;            // les noms de bots comptent à partir de 1
  } else {
    let sum = 0;
    for (let k = 0; k < s.length; k++) sum += s.charCodeAt(k);
    i = sum;
  }
  return baseHeading(i, count);
}

/**
 * Où le bot va-t-il installer sa base ? PUR.
 * 1) une cellule de biome BOISÉ connue de la carte, à distance ∈ [minDist, maxDist] du spawn du
 *    monde, non épuisée, la mieux alignée sur le cap du bot (départage : la plus proche) ;
 * 2) à défaut (carte encore vide au démarrage du run) : un point brut sur son cap, à `dist`.
 * Retourne { x, z, source: 'wooded'|'heading', biome? } — coordonnées ENTIÈRES (cibles de goto).
 */
function pickBaseSpot({
  spawn, index, count, biomes, depleted,
  dist = BASE_DIST, minDist = MIN_BASE_DIST, maxDist = BASE_MAX_DIST, heading,
} = {}) {
  const sp = _pt(spawn, { x: 0, z: 0 });
  const h = Number.isFinite(heading) ? heading : baseHeading(index, count);
  const wooded = vanillaHint('log');
  const dep = Array.isArray(depleted) ? depleted : [];
  const isDepleted = (x, z) => dep.some((d) => d && Number.isFinite(d.x)
    && _horiz(d.x, d.z, x, z) <= DEPLETED_RADIUS);

  let best = null;
  let bestScore = null;
  for (const b of Array.isArray(biomes) ? biomes : []) {
    if (!b || !b.name || !wooded.includes(b.name)) continue;
    if (!Number.isFinite(b.x) || !Number.isFinite(b.z)) continue;
    const d = _horiz(sp.x, sp.z, b.x, b.z);
    if (d < minDist || d > maxDist) continue;
    if (isDepleted(b.x, b.z)) continue;
    const score = [_angleDiff(Math.atan2(b.z - sp.z, b.x - sp.x), h), d];
    if (!bestScore || score[0] < bestScore[0] - 1e-9
      || (Math.abs(score[0] - bestScore[0]) <= 1e-9 && score[1] < bestScore[1])) {
      best = b;
      bestScore = score;
    }
  }
  if (best) return { x: Math.round(best.x), z: Math.round(best.z), source: 'wooded', biome: best.name };
  return {
    x: Math.round(sp.x + dist * Math.cos(h)),
    z: Math.round(sp.z + dist * Math.sin(h)),
    source: 'heading',
  };
}

/**
 * Que faire au moment où le bot apparaît (boot OU respawn après une mort) ? PUR.
 *   'establish' → pas encore de base utilisable → aller la poser (marche + /sethome) ;
 *   'return'    → base connue et le bot vient d'être relâché loin d'elle (= au spawn du monde
 *                 après une mort) → /home safe pour rentrer chez lui ;
 *   'stay'      → il est déjà chez lui (ou position inconnue : on ne décide rien de risqué).
 */
function spawnAction({
  base, pos, spawn, minDist = MIN_BASE_DIST, homeRadius = HOME_RADIUS, minSurfaceY = SURFACE_MIN_Y,
} = {}) {
  if (needsBase({ base, spawn, minDist })) return 'establish';
  // Base persistée SOUS TERRE (bugfix world_mn10, 27/07) : une migration ratée avait ancré `safe`/
  // base à y=-7 → `/home safe` noyé, jamais de bois. On RE-ÉTABLIT en surface (establishBase repose
  // /spawnpoint + safe au sec). `y` absent (memo historique) → on ne force rien (rétro-compat).
  if (Number.isFinite(base.y) && base.y < minSurfaceY) return 'establish';
  if (!pos || !Number.isFinite(pos.x) || !Number.isFinite(pos.z)) return 'stay';
  return _horiz(pos.x, pos.z, base.x, base.z) <= homeRadius ? 'stay' : 'return';
}

module.exports = {
  needsBase, baseHeading, headingForName, pickBaseSpot, spawnAction,
  MIN_BASE_DIST, BASE_DIST, BASE_MAX_DIST, HOME_RADIUS,
};
