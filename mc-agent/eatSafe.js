'use strict';
// ─── MANGER POUR SE SOIGNER, ET VÉRIFIER QU'ON A MANGÉ (24/10) ──────────────────────────────────
// Mesure (6 h, mineurs NethBot1-3, 28 sessions, 71 morts) :
//   • 26 épisodes ≥ 1 min sous 10 PV avec une faim < 18 (pas de régénération vanilla), dont 18 avec de
//     la nourriture en poche ; 18 des 26 finissent par une mort dans les 2 min ;
//   • 198 des 388 `ate` (51 %) étaient FACTICES : même faim, mêmes PV, 5 s après le précédent — le
//     `cooked_porkchop` « mangé » toutes les 5 s à faim 17 (43 fois), le `beef` à faim 17 (NethBot2,
//     17 fois en 80 s, PV figés à 11,43). Deux causes :
//       1. `withTimeout` d'index.js ne lève JAMAIS (il résout `{ok:false}` sur erreur ET sur délai) :
//          le `try { await withTimeout(equip+consume) ; ate = true }` du filet émettait `ate` quoi qu'il
//          arrive ;
//       2. mineflayer termine `consume()` SANS manger dès que l'objet en main change (`heldItemChanged`
//          → `eatingTask.finish()`) — or le branch-mine ré-équipe sa pioche (`bm_approach` dans 39 des
//          contextes), l'aura son épée. Et `bot.usingHeldItem` (que l'aura consulte) est remis à faux
//          par N'IMPORTE quel paquet `entity_status`, de n'importe quelle entité.
//   • NethBot2 (session 606) : 1,1 PV, faim 13, rien en poche, `gift_batch_craft:low_hp_skip` relancé
//     en boucle — la raison préfixée échappait à la récupération de runSkillWithTelemetry (cf. lowhp.js).
// Un joueur blessé mange jusqu'à 18-20 pour se soigner, et ne range pas son steak au milieu de la bouchée.

const HEAL_HP = 16;              // sous 16 PV, on veut régénérer
const REGEN_TARGET = 18;         // la régénération naturelle exige une faim ≥ 18
const MAX_HEAL_BITES = 4;        // bouchées enchaînées dans un même tick (≈ 4 × 1,6 s)
const EAT_LOCK_MS = 2600;        // une bouchée = 1,6 s (+ equip + latence) : pas d'equip/dig étranger
const COOK_FIRST_MIN_HP = 10;    // blessé mais pas en danger : cuire d'abord SI le bot est libre
const NO_EFFECT_BACKOFF_MS = [0, 15000, 30000, 60000];   // après 1, 2, 3+ bouchées sans effet

// PAS DE BOUCHÉE AU CONTACT (26/10, itération 3 zéro→fer) : NethBot3 en fer complet — `reflex eat` ×6 en
// 20 s, `reflex fight zombie duel:true`, `reflex eat`, puis `fight_last_stand hp:3.2 dist:2.3` et mort.
// Une bouchée = 1,6 s sans frapper, le zombie collé frappe toutes les secondes. Un joueur finit le combat
// (ou recule), PUIS mange. Exceptions : muré dans l'abri (la paroi arrête les coups), ou PV ≤ 4 sans
// aucun coup possible (pas d'arme, ou cible hors de portée de coup) — la bouchée reste la seule chance.
const COMBAT_EAT_REACH = 3.5;      // hostile à ≤ 3,5 blocs : on est au corps-à-corps
const COMBAT_EAT_STRIKE = 3;       // portée de coup d'un joueur
const COMBAT_EAT_DESPERATE_HP = 4; // PV ≤ 4 et aucun coup possible : manger quand même

const n = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** PUR — blessé ET la faim coupe la régénération : il faut manger pour se soigner. */
function healEatWanted({ health, food } = {}) {
  const h = n(health); const f = n(food);
  return h != null && f != null && h > 0 && h < HEAL_HP && f < REGEN_TARGET;
}

/** PUR — la bouchée a-t-elle eu lieu ? (faim montée OU objet consommé). Inconnu → non. */
function eatEffective({ foodBefore, foodAfter, countBefore, countAfter } = {}) {
  const fb = n(foodBefore); const fa = n(foodAfter);
  if (fb != null && fa != null && fa > fb) return true;
  const cb = n(countBefore); const ca = n(countAfter);
  return cb != null && ca != null && ca < cb;
}

/** PUR — nombre total d'objets `name` dans items [{name,count}]. */
function itemCount(items, name) {
  let t = 0;
  for (const it of Array.isArray(items) ? items : []) if (it && it.name === name) t += Number(it.count) || 0;
  return t;
}

/** PUR — délai avant de retenter après `streak` bouchées sans effet d'affilée. */
function noEffectBackoffMs(streak) {
  const s = Math.max(0, Math.floor(Number(streak) || 0) - 1);   // 1er raté : on retente au tick suivant
  return NO_EFFECT_BACKOFF_MS[Math.min(s, NO_EFFECT_BACKOFF_MS.length - 1)];
}

/**
 * PUR — combien de ms un equip/dig ÉTRANGER doit-il attendre ? 0 = tout de suite.
 * La bouchée en cours (verrou jusqu'à `lockUntil`) passe ; un equip de NOURRITURE (le repas lui-même)
 * aussi. Une horloge à rebours ou un verrou absurde (> EAT_LOCK_MS) n'attend jamais : pas de gel.
 */
function eatLockWaitMs({ lockUntil, now, isFood = false } = {}) {
  if (isFood) return 0;
  const u = n(lockUntil); const t = n(now);
  if (u == null || t == null || u <= t) return 0;
  return Math.min(u - t, EAT_LOCK_MS);
}

/** PUR — blessé et la cuisson est possible tout de suite : cuire avant d'avaler du cru ? */
function cookFirstWhenHurt({ health, canCook, free } = {}) {
  const h = n(health);
  return !!canCook && !!free && h != null && h >= COOK_FIRST_MIN_HP;
}

/** PUR — faut-il retenir la bouchée parce qu'on se bat au contact ? Distance inconnue → non. */
function combatEatBlocked({ nearestDist, health, attackDamage, sealed } = {}) {
  if (sealed) return false;
  const d = n(nearestDist);
  if (d == null || d > COMBAT_EAT_REACH) return false;
  const h = n(health);
  const canStrike = (n(attackDamage) || 0) > 0 && d <= COMBAT_EAT_STRIKE;
  if (h != null && h <= COMBAT_EAT_DESPERATE_HP && !canStrike) return false;
  return true;
}

module.exports = {
  COMBAT_EAT_REACH, COMBAT_EAT_STRIKE, COMBAT_EAT_DESPERATE_HP, combatEatBlocked,
  HEAL_HP, REGEN_TARGET, MAX_HEAL_BITES, EAT_LOCK_MS, COOK_FIRST_MIN_HP, NO_EFFECT_BACKOFF_MS,
  healEatWanted, eatEffective, itemCount, noEffectBackoffMs, eatLockWaitMs, cookFirstWhenHurt,
};
