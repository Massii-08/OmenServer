'use strict';
// Confinement (test en ARÈNE de minage contrôlée) : garde un bot ressource dans un petit rayon
// autour d'une ancre SÈCHE, au lieu de le disperser via relocateToRegion (qui vise 256..520 blocs
// = HORS d'une arène de 33×33 → le bot atterrit en terrain naturel humide/cavé et n'y revient
// jamais — vécu nuit du 22/06 : ResBot1 warpé à -869 sur un seul floating_relocate). Quand --confine
// "X Z R" est passé, TOUT relocate (nearSpawn/diamondCluster/forest/plain) re-spread dans R de (X,Z).

/** "X Z R" → { x, z, radius } (entiers) ; null si absent/invalide ou radius ≤ 0. */
function parseConfine(s) {
  if (!s) return null;
  const p = String(s).trim().split(/\s+/).map(Number);
  if (p.length < 3 || p.some((n) => !Number.isFinite(n))) return null;
  const x = Math.round(p[0]), z = Math.round(p[1]), radius = Math.round(p[2]);
  if (radius <= 0) return null;
  return { x, z, radius };
}

/** /spreadplayers <x> <z> <spreadDistance=0> <maxRange=radius> false <user> → atterrit à ≤radius de l'ancre. */
function confineSpreadCommand(username, conf) {
  return '/spreadplayers ' + conf.x + ' ' + conf.z + ' 0 ' + conf.radius + ' false ' + username;
}

// ─── Confine NO-GIVE (briques 1-2, Massii 16/07) ────────────────────────────────────────────────
// /spreadplayers est BLOQUÉ par nogive → en sans-give l'enforcement passe par un HOME posé à
// l'ancre (commande joueur légitime /home). Et comme chaque semaine = un NOUVEAU monde (seed non
// choisi), le bot s'AUTO-ancre : la première position stable (au sol, hors eau, en surface)
// devient l'ancre de sa poche sèche — bois local + fer/diamant en creusant sur place.
//
// ⚠️ 27/07 : ce home était `canchor`, un QUATRIÈME nom alors que le serveur n'en autorise que 3
// (`sethome-multiple: default: 3`) → un `/sethome` échouait en silence sur chaque bot, et lequel
// dépendait de l'ordre de pose. L'ancre est maintenant le home `safe` — c'est de toute façon le
// même endroit : LA BASE (cf. homes.js). Un nom de moins, un filet de sécurité de plus.

const { HOME_SAFE } = require('./homes');

const CONFINE_HOME = HOME_SAFE;        // l'ancre de confine EST la base (cf. homes.js)
const DEFAULT_CONFINE_RADIUS = 140;    // poche assez grande pour bois + mine, assez petite pour
                                       // que l'enforcement coupe les longs trajets mortels

/**
 * Faut-il RAMENER le bot à l'ancre maintenant ? (pur)
 * - marge ×1.25 : on ne yo-yote pas à la frontière du rayon ;
 * - jamais pendant une activité légitime (dig/fonte/abri/sauvetage) ;
 * - cooldown 2 min entre deux enforcement (le /home + re-dérive prend du temps).
 */
function shouldEnforceConfine({ dist, radius, busy, now, lastAt, cooldownMs = 120000, factor = 1.25 } = {}) {
  if (busy) return false;
  if (!(dist > radius * factor)) return false;
  return (now - (lastAt || 0)) >= cooldownMs;
}

// ⚠️ LE CERCLE VICIEUX DE LA ZONE RASÉE (mesuré live 27/07, `world_mn9`, 0 `confine_anchored`
// sur 8 sessions). Exiger du bois pour s'ancrer date d'AVANT la migration de zone : c'était le
// seul garde-fou contre une poche stérile. Mais une zone rasée n'a plus d'arbre → le bot ne
// s'ancre jamais → les compteurs de zone ne démarrent pas → le verdict n'est jamais évalué →
// il ne peut PAS migrer. Autrement dit : **avoir tout épuisé était précisément ce qui
// l'empêchait de partir** (symptôme Massii : « ils sont encore au spawn alors qu'il n'y a plus
// rien »). On préfère toujours une zone boisée, mais on n'attend pas indéfiniment : passé le
// délai de grâce on ancre quand même, et c'est le verdict de zone qui déménagera le bot.
const ANCHOR_WOOD_GRACE_MS = 3 * 60 * 1000;

/** La position courante est-elle ancre-able ? (au sol, hors eau, en surface — pur) */
function pickAnchorNow({ onGround, inWater, y, woodNear, waitedMs = 0 } = {}) {
  const physOk = !!onGround && !inWater && typeof y === 'number' && y >= 58;
  if (!physOk) return false;                    // l'attente ne dispense JAMAIS du physique
  if (woodNear === false && (!Number.isFinite(waitedMs) || waitedMs < ANCHOR_WOOD_GRACE_MS)) {
    return false;                               // on laisse sa chance à une zone boisée
  }
  return true;
}

/**
 * Confine STATIQUE pas encore ancré : faut-il MARCHER vers l'ancre ? (pur)
 *
 * DEADLOCK vécu live (26/07, run Minestrator) : poser l'ancre exige d'être à ≤`nearRadius`
 * de (x,z) — sinon le `/sethome canchor` marquerait le camp au mauvais endroit — mais
 * l'enforcement qui ramènerait le bot exige justement que l'ancre soit posée. Hors de ce
 * rayon, RIEN ne ramène le bot : 2 workers sur 5 sont partis à 200+ blocs sans jamais
 * revenir (l'un avec 12 `squad_join` restés sans effet). La seule sortie est de MARCHER
 * vers l'ancre — le confinement ne s'auto-amorce pas.
 *
 * Cooldown : un goto long ne doit pas être relancé en rafale.
 */
function shouldTravelToAnchor({
  confine, anchored, dist, busy, now, lastAt, cooldownMs = 60000, nearRadius = 24,
} = {}) {
  if (!confine || anchored || busy) return false;
  if (typeof dist !== 'number' || !Number.isFinite(dist)) return false;
  if (dist <= nearRadius) return false;                 // pickAnchorNow va poser l'ancre
  return (now - (lastAt || 0)) >= cooldownMs;
}

/**
 * La position courante permet-elle de POSER l'ancre d'un confine statique ? (pur)
 *
 * La fenêtre de pose doit couvrir TOUT le disque de confinement, pas un rayon plus petit.
 * Vécu live 26/07 : la garde exigeait ≤24 blocs de (x,z). Un bot qui dérivait à 30 blocs ne
 * pouvait plus s'ancrer ; or l'enforcement qui l'aurait retenu exige justement l'ancre → il
 * n'était plus retenu par rien et partait à 300 blocs. Poser `/home canchor` n'importe où
 * DANS le disque donne un point de retour à l'intérieur de la zone voulue — exactement ce que
 * l'enforcement demande. Hors du disque on refuse : le camp ne doit pas sortir de la zone.
 */
function canAnchorHere({ confine, dist } = {}) {
  if (!confine) return true;                            // auto-ancrage dynamique : sur place
  if (typeof dist !== 'number' || !Number.isFinite(dist)) return false;
  return dist <= confine.radius;
}

/**
 * Confine RÉELLEMENT applicable : la base PERSISTÉE prime sur l'argument `--confine`. (pur)
 *
 * Après une migration de zone (Massii 27/07), l'ancre du bot n'est plus celle de son lancement.
 * Or le self-healing backend relance la session avec le memo `--confine` d'origine, et le keeper
 * `mc-keep8.sh` garde le sien : sans cette précédence, chaque mort ramenait le bot à l'ANCIENNE
 * zone et l'enforcement l'y clouait — le split-brain confine qui a déjà mordu deux fois.
 * `--confine` devient donc un simple AMORÇAGE (il fixe encore le rayon) ; la base fait foi.
 */
function effectiveConfine({ confine, base } = {}) {
  const radius = (confine && Number.isFinite(confine.radius)) ? confine.radius : DEFAULT_CONFINE_RADIUS;
  if (base && Number.isFinite(base.x) && Number.isFinite(base.z)) {
    return { x: Math.round(base.x), z: Math.round(base.z), radius };
  }
  return confine || null;
}

module.exports = {
  parseConfine, confineSpreadCommand,
  CONFINE_HOME, DEFAULT_CONFINE_RADIUS, ANCHOR_WOOD_GRACE_MS, shouldEnforceConfine, pickAnchorNow,
  shouldTravelToAnchor, canAnchorHere, effectiveConfine,
};
