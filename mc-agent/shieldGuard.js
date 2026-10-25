'use strict';
// ─── BOUCLIER TENU EN CONTINU (25/10, run Hard keepInventory OFF) ─────────────────────────────────
// Mesure (22 morts « shot by Skeleton » depuis 12:05 UTC) : les 2 bots qui avaient un bouclier en main
// secondaire sont morts SANS l'avoir levé une seule fois — NethBot3 (session 744, 4 pièces de fer +
// bouclier) : `block wall` 9 PV → `cover corner` 4 PV → mort. Cause : `bot.inventory.items()` couvre les
// slots 9..44, la main secondaire (slot 45) n'y est PAS → `_skelShield()` rendait null dès que le
// bouclier était équipé : `hasShield:false` dans la décision et `_skelShieldUp` ne levait rien. Et même
// trouvé, le bouclier ne montait que par impulsions de 2 s.
// Ce que fait un joueur : bouclier levé TANT QU'UN SQUELETTE LE VOIT (il bloque toute flèche de face),
// baissé le temps de frapper quand la cible est à portée, baissé pour manger. Vanilla : le bouclier ne
// bloque qu'après 5 ticks d'utilisation — relancer `use_item` sans cesse le rendrait inutile, donc on ne
// relève QUE sur une transition baissé → levé.
// Décisions PURES ici ; le tick (index.js shieldGuardTick) ne fait que lire le monde et brancher.

const GUARD_RANGE = 16;      // portée de tir d'un squelette (SKEL_RANGE)
const STRIKE_REACH = 3.2;    // portée de coup (mineflayer-pvp attackRange 3 + marge)

function _num(x) { return typeof x === 'number' && Number.isFinite(x); }

/** PUR — le bouclier du bot : main secondaire (slot 45) d'abord, sinon dans le sac. Rend l'item ou null. */
function shieldItem({ offhand, items } = {}) {
  if (offhand && offhand.name === 'shield') return offhand;
  const list = Array.isArray(items) ? items : [];
  return list.find((i) => i && i.name === 'shield') || null;
}

/**
 * PUR — posture du bouclier : 'up' | 'down' | 'hold' (ne rien toucher).
 * @param {{hasShield:boolean, threats:Array<{dist:number, los:boolean}>, eating:boolean,
 *          strikeDist:number|null, range?:number, reach?:number}} s
 *   threats    = tireurs connus (squelettes/stray/bogged) avec leur distance et ligne de vue
 *   eating     = la main principale est en cours d'utilisation (repas) — on ne l'interrompt pas
 *   strikeDist = distance à la cible qu'on frappe (charge/riposte pvp), null si on ne frappe pas
 */
function shieldStance({ hasShield, threats, eating, strikeDist, range = GUARD_RANGE, reach = STRIKE_REACH } = {}) {
  if (!hasShield) return 'down';
  if (eating) return 'hold';
  // frapper : impossible bouclier levé → baissé le temps du coup (le tick suivant le relève si la cible
  // s'éloigne). C'est le « baisse, frappe, relève » du joueur.
  if (_num(strikeDist) && strikeDist <= reach) return 'down';
  const seen = (Array.isArray(threats) ? threats : [])
    .some((t) => t && t.los !== false && _num(t.dist) && t.dist <= range);
  return seen ? 'up' : 'down';
}

/** PUR — action à envoyer : 'raise' (transition seulement), 'lower', ou null. */
function shieldAction({ stance, raised } = {}) {
  if (stance === 'up' && !raised) return 'raise';
  if (stance === 'down' && raised) return 'lower';
  return null;
}

module.exports = { shieldItem, shieldStance, shieldAction, GUARD_RANGE, STRIKE_REACH };
