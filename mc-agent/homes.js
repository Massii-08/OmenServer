'use strict';
// SYSTÈME À 3 HOMES (demande Massii, 27/07) — « les bots utiliseront uniquement 3 homes ».
//
//   safe  = LA BASE (unique)   : dépôt du surplus et du loot demandé, repli de survie, ancre de confine.
//   work  = le chantier courant : posé AVANT toute excursion volontaire (bois, dépôt, livraison
//                                 d'armure, aide à un coéquipier) → on revient bosser par /home work.
//   death = la dette de mort    : posée à l'imminence de la mort (sauf lave) → après respawn on y
//                                 re-TP, on tue tout, on ramasse, et on ne SUPPRIME le home qu'une
//                                 fois TOUT le loot récupéré.
//
// ⚠️ CE N'EST PAS QU'UNE PRÉFÉRENCE — c'est un BUGFIX. Le serveur limite à 3 homes
// (`sethome-multiple: default: 3` dans /plugins/Essentials/config.yml, vérifié le 27/07) et le
// code posait QUATRE noms : safe, canchor, death, wsite. Le 4ᵉ `/sethome` échoue EN SILENCE, et
// lequel manque dépend de l'ordre de pose → chaque bot avait un filet de sécurité différent troué.
// Observé sur world_mn5 : NethBot2 n'avait PAS de home `safe` (sa roue de secours anti-noyade était
// un no-op), NethBot5 n'avait pas de `wsite`. 3 noms pour 3 slots : plus aucun échec silencieux.
//
// Module PUR (aucun accès bot/fs, horloge injectée) → testable sans client Minecraft.

const HOME_SAFE = 'safe';
const HOME_WORK = 'work';
const HOME_DEATH = 'death';

/** Les 3 SEULS noms de home posés par la flotte. Tient exactement dans la limite serveur. */
const HOMES = [HOME_SAFE, HOME_WORK, HOME_DEATH];

/** Anciens noms à SUPPRIMER au boot (`/delhome`) : sans ce ménage, les comptes existants ont déjà
 *  consommé leurs 3 slots avec les vieux noms et les `sethome safe/work` échouent en silence. */
const LEGACY_HOMES = ['canchor', 'wsite'];

// ─── Le home `safe` doit être EN SURFACE (bugfix world_mn10, 27/07) ──────────────────────────────
// `safe` = LA BASE : on y remonte chercher le bois (arbres + table de craft) et c'est le point de
// respawn (/spawnpoint). La migration de zone le re-posait à la position COURANTE du bot en ne
// gardant QUE la garde `!isInWater` — un mineur à y=-7 qui « migrait » de 11 blocs (marche à
// l'aveugle sans cible → aucun déplacement réel) re-ancrait sa base SOUS TERRE. Résultat mesuré
// live sur world_mn10 : `/home safe` téléportait dans l'eau souterraine → water_rescue_home_safe en
// boucle → jamais de bois → `logs not_found` 98.9 %, done figé à 0, armure qui s'érode. Le lieu où
// l'on pose `safe`/base/spawnpoint DOIT passer ce prédicat.

const SAFE_HOME_MIN_Y = 58;   // même seuil « surface » que partout ailleurs (confine.js, index.js)

/**
 * Ce spot convient-il pour ancrer le home `safe` / la base / le /spawnpoint ? (pur)
 * Surface sèche uniquement : sous terre il n'y a NI bois NI table, et un home mouillé rend tous les
 * /home morts (teleport-safety). `y` absent/non fini → refus (on ne pose pas un safe sur une
 * lecture de position ratée).
 * @param {{y?: number, inWater?: boolean}} s
 */
function isSurfaceSpot(s = {}) {
  if (s && s.inWater) return false;
  const y = s && s.y;
  return typeof y === 'number' && Number.isFinite(y) && y >= SAFE_HOME_MIN_Y;
}

// ─── /home safe SILENCIEUX depuis sous terre = signet cassé ──────────────────────────────────────
// Mesuré live sur world_mn11 (28/07) : NethBot3 est resté 392 min piégé à y≈17, `safe_warp
// warped:false` en boucle, SANS un seul `home_tp_refused`. La voie « refus » (refusedHome, sur
// message Essentials) ne couvre que le refus EXPLICITE de la teleport-safety ; un `/home safe` qui
// n'a tout simplement PAS téléporté (signet pointant sous terre, ou home absent) est un no-op
// MUET → `_homeRefusedAt.safe` restait nul → le self-heal `safe_home_reset` ne s'armait jamais →
// le bot ne remontait JAMAIS chercher du bois ni se re-poser un safe sain. C'est le cœur du piège :
// safe sous terre → impossible de remonter → impossible de re-poser safe en surface.
//
// On ne se fie qu'au signal robuste : le TP n'a pas déplacé le bot (warped:false), il n'a pas été
// annulé (mouvement/coup → simple retry, pas un signet cassé), et le bot est SOUS TERRE (y<58) —
// c'est là, et seulement là, que le no-op piège (en surface, un /home safe muet = déjà chez soi,
// sans danger). L'appelant ne déclenche qu'après quelques occurrences CONSÉCUTIVES pour ignorer un
// warmup teleport-delay ponctuel plus long que le timeout d'attente. (pur)
// @param {{name?: string, warped?: boolean, cancelled?: boolean, y?: number}} s
function isSilentSafeFailure(s = {}) {
  if (!s || s.name !== HOME_SAFE) return false;
  if (s.warped || s.cancelled) return false;
  const y = s.y;
  if (typeof y !== 'number' || !Number.isFinite(y)) return false;
  return y < SAFE_HOME_MIN_Y;
}

// ─── Garde lave sur la pose du home `death` ─────────────────────────────────────────────────────
// Massii : « posé quand il va mourir (sauf si l'endroit est dans la lave) ». Revenir dans la lave
// n'est pas une récupération, c'est une deuxième mort — et le loot y a de toute façon brûlé.

const _LAVA_RE = /lava/i;

/**
 * Peut-on marquer ce lieu de mort ? (pur)
 * @param {{feet?: string|null, below?: string|null}} s  noms des blocs aux pieds et dessous.
 * Blocs inconnus (registry pas prêt) → on AUTORISE : ne jamais perdre une dette sur une lecture ratée.
 */
function canBookmarkDeath(s = {}) {
  const feet = s && s.feet;
  const below = s && s.below;
  if (typeof feet === 'string' && _LAVA_RE.test(feet)) return false;
  if (typeof below === 'string' && _LAVA_RE.test(below)) return false;
  return true;
}

// ─── Cycle de vie de la dette de mort ───────────────────────────────────────────────────────────
// La dette est PERSISTÉE (memo base par bot) : elle doit survivre au redémarrage du process, sinon
// le self-healing (qui relance le bot après chaque mort) la perdrait précisément quand elle sert.

/** Despawn vanilla des items au sol : 5 min. Au-delà, il n'y a plus rien à récupérer — c'est CETTE
 *  borne qui empêche « il revient encore et encore » de devenir une boucle infinie. */
const DEBT_TTL_MS = 5 * 60 * 1000;

/** Ouvre une dette au lieu de mort. Retourne {x,y,z,at} (entiers) ou null si la position manque. */
function openDebt(pos, now) {
  if (!pos || typeof pos.x !== 'number' || typeof pos.z !== 'number') return null;
  return {
    x: Math.round(pos.x),
    y: Math.round(typeof pos.y === 'number' ? pos.y : 64),
    z: Math.round(pos.z),
    at: now,
  };
}

// ─── De NUIT, un bot nu ne retourne pas dans le camp qui vient de le tuer ────────────────────────
// Trace live (run de référence, NethBot3 — 9 morts en 4 min) :
//   16:50:22 shelter dig_in         ← le planner commence l'abri
//   16:50:23 death_recover_home     ← /home death : TÉLÉPORTÉ au lieu de sa mort
//   16:50:29 reflex fight zombie    ← re-tué par ce qui campe le loot
// La récupération démarre au spawn, HORS du gestionnaire de tâches : elle arrachait le bot à son
// abri nocturne pour le renvoyer exactement là où les monstres viennent de le tuer — une boucle de
// mort. Sous ce nombre de pièces portées (même seuil que `caution.CAUTION_MIN_WORN`), un bot ne
// survit pas à une nuit à découvert en difficulté hard : on DIFFÈRE jusqu'à l'aube ou jusqu'à ce
// qu'il ait de quoi encaisser. La borne reste le despawn vanilla (5 min) : tant que la dette est
// valide on peut attendre, passé le TTL elle se lève — de nuit comme de jour.
const DEBT_MIN_WORN = 2;

/**
 * Que faire de la dette maintenant ? (pur)
 * @param {{debt: object|null, now: number, arrived?: boolean, dropsLeft?: number, ttlMs?: number,
 *          night?: boolean|null, worn?: number}} o
 *   `night` : true = il fait nuit, false = jour, null/absent = heure INCONNUE (bot.time pas encore
 *   livré juste après un spawn) → aucun garde-fou, comportement d'avant. `worn` : nombre de pièces
 *   d'armure portées (absent/NaN = 0, prudent).
 * @returns {{act: 'none'|'recover'|'defer'|'settle', reason?: string}}
 *   'recover' → /home death (puis tuer tout et ramasser) ;
 *   'defer'   → PAS MAINTENANT : nuit + moins de 2 pièces portées, avant le départ. La dette reste
 *               ouverte, l'appelant ne se téléporte pas et re-décide plus tard (relance) ;
 *   'settle'  → /delhome death, dette levée, retour au travail par /home work.
 *   Priorité : dette absente/corrompue/expirée (TTL) > mesure sur place (`arrived`) > report nocturne.
 */
function debtAction(o = {}) {
  const debt = o.debt;
  if (!debt) return { act: 'none' };
  if (typeof debt.at !== 'number' || !Number.isFinite(debt.at)) {
    return { act: 'settle', reason: 'invalid' };   // dette corrompue : la lever plutôt que bloquer à vie
  }
  const ttl = o.ttlMs != null ? o.ttlMs : DEBT_TTL_MS;
  if ((o.now - debt.at) > ttl) return { act: 'settle', reason: 'despawned' };
  // keepInventory ON (entraînement, 20/10) : le respawn rend l'inventaire → rien n'est tombé au sol,
  // la dette n'a plus d'objet. La lever ICI, AVANT le départ : sans ça le bot se téléportait (/home death)
  // nu au lieu exact de sa mort — le camp — pour constater qu'il n'y avait rien à ramasser (185
  // `death_recover_home` sur le run 10). Sous keepInventory OFF l'inventaire est vide au respawn →
  // `keptInventory` faux → comportement inchangé. Le jugement lui-même est inventoryKept (pur).
  if (o.keptInventory === true) return { act: 'settle', reason: 'kept_inventory' };
  if (o.arrived && (o.dropsLeft || 0) <= 0) return { act: 'settle', reason: 'recovered' };
  if (o.arrived) return { act: 'recover', reason: 'drops_left' };
  // Avant le départ seulement (`arrived` a déjà tranché plus haut : sur place, on ne re-diffère pas).
  if (o.night === true && (o.worn || 0) < DEBT_MIN_WORN) return { act: 'defer', reason: 'night_naked' };
  return { act: 'recover' };
}

/**
 * PUR — l'inventaire a-t-il SURVÉCU à la mort (keepInventory ON) ? On compare le total d'objets relevé
 * au moment de la mort (`before`) à celui d'après le respawn (`after`). Ne suppose RIEN du réglage du
 * serveur : il le MESURE, mort après mort (le propriétaire bascule keepInventory entre deux runs).
 *   - rien avant la mort → rien à perdre : faux (aucune preuve, on garde le comportement d'origine) ;
 *   - après ≥ la moitié d'avant → gardé. La moitié, et pas l'égalité : quelques objets peuvent avoir été
 *     consommés/jetés juste avant la mort ; et un /kit de respawn (cartographes) donne une poignée
 *     d'objets, loin de la moitié d'un inventaire de travail — il ne passe pas pour un inventaire gardé.
 * @param {{before?: number, after?: number}} o  totaux d'objets (somme des `count`)
 */
function inventoryKept(o = {}) {
  const before = (o && Number.isFinite(o.before)) ? o.before : 0;
  const after = (o && Number.isFinite(o.after)) ? o.after : 0;
  if (before <= 0) return false;
  return after * 2 >= before;
}

module.exports = {
  inventoryKept,
  HOME_SAFE, HOME_WORK, HOME_DEATH, HOMES, LEGACY_HOMES,
  canBookmarkDeath, openDebt, debtAction, DEBT_TTL_MS, DEBT_MIN_WORN,
  isSurfaceSpot, SAFE_HOME_MIN_Y, isSilentSafeFailure,
};
