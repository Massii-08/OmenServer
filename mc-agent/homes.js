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

/**
 * Que faire de la dette maintenant ? (pur)
 * @param {{debt: object|null, now: number, arrived?: boolean, dropsLeft?: number, ttlMs?: number}} o
 * @returns {{act: 'none'|'recover'|'settle', reason?: string}}
 *   'recover' → /home death (puis tuer tout et ramasser) ;
 *   'settle'  → /delhome death, dette levée, retour au travail par /home work.
 */
function debtAction(o = {}) {
  const debt = o.debt;
  if (!debt) return { act: 'none' };
  if (typeof debt.at !== 'number' || !Number.isFinite(debt.at)) {
    return { act: 'settle', reason: 'invalid' };   // dette corrompue : la lever plutôt que bloquer à vie
  }
  const ttl = o.ttlMs != null ? o.ttlMs : DEBT_TTL_MS;
  if ((o.now - debt.at) > ttl) return { act: 'settle', reason: 'despawned' };
  if (o.arrived && (o.dropsLeft || 0) <= 0) return { act: 'settle', reason: 'recovered' };
  if (o.arrived) return { act: 'recover', reason: 'drops_left' };
  return { act: 'recover' };
}

module.exports = {
  HOME_SAFE, HOME_WORK, HOME_DEATH, HOMES, LEGACY_HOMES,
  canBookmarkDeath, openDebt, debtAction, DEBT_TTL_MS,
};
