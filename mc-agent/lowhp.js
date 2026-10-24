'use strict';
// ─── PV CRITIQUES : RÉCUPÉRER AVANT DE CRAFTER (22/10) ──────────────────────────────────────────
// 0990f4c (veille 21/10) a fait refuser tout craft à PV critiques (≤ 6, homewarp.IMMINENT_HP) :
// `_craftDepth > 0` coupe l'aura/équipement pendant la fenêtre de craft (et cette fenêtre comprend
// la marche vers une table), donc crafter pendant un combat à 4,33 PV désarmait le bot — NethBot3 en
// est mort ~500 ms après. L'intention est juste ; le défaut était ce qui venait APRÈS le refus :
// `{ok:false, reason:'low_hp_skip'}` remontait au planner comme un échec ordinaire, il relançait le
// même but en boucle (NethBot1 `furnace` ×12, NethBot3 `crafting_table` ×16 en 10 min, 4 échecs en
// 300 ms → stall), et le bot restait planté à ~3,6-5,3 PV qui ne remontaient jamais (food 13-14 :
// sous 18, pas de régénération vanilla) jusqu'à sa mort.
// Un joueur à deux cœurs ne réessaie pas son craft : il mange, va chercher à manger si la faim lui
// coupe la régénération, se mure si un monstre est collé, sinon il attend que ça remonte.
//
// `lowHpStep` est la décision PURE d'un pas de récupération ; elle sert aussi de GARDE au craft
// (craftSmart refuse tant qu'elle ne rend pas 'ok' ou 'proceed').
const { IMMINENT_HP } = require('./homewarp');
const { REGEN_FOOD } = require('./reflexes');

const LOWHP_THREAT_RADIUS = 16;        // un hostile en vue : il peut revenir pendant le craft
const LOWHP_SEAL_RADIUS = 8;           // assez près pour se murer plutôt qu'attendre à découvert
const LOWHP_RECOVERY_BUDGET_MS = 60000;   // une récupération rend la main au planner au bout d'1 min
const LOWHP_FOOD_RUN_TTL_MS = 5 * 60000;  // une sortie nourriture tentée vaut pour 5 min
const LOWHP_MAX_EAT_FAILS = 3;         // eat_failed répété → on cesse d'essayer (pas de spin)

function isCritical(health) {
  return typeof health === 'number' && !Number.isNaN(health) && health <= IMMINENT_HP;
}

/**
 * Un pas de récupération. Entrées (toutes optionnelles, rien ne lève) :
 *   health, food (0-20, null = inconnu), hasFood (nourriture en poche), eatFails,
 *   threatDist (distance du plus proche hostile, null = aucun), sealed (déjà muré dans cet épisode),
 *   foodRunTriedRecently.
 * Rend :
 *   'ok'      PV au-dessus du seuil critique : rien à récupérer, le craft peut partir ;
 *   'seal'    hostile à ≤ 8 blocs et pas encore muré (passe AVANT 'eat' depuis le 24/10) ;
 *   'eat'     de quoi manger et la faim coupe (ou coupera) la régénération ;
 *   'wait'    hostile en vue (≤ 16) OU régénération en cours (food ≥ 18) : rester immobile ;
 *   'food_run' rien à manger, pas de régénération : lancer la sortie nourriture bornée ;
 *   'proceed' rien à manger, sortie déjà tentée, personne en vue : attendre ne rendra AUCUN PV,
 *             et un craft sans menace ne coûte rien (il ne fait pas perdre de PV) — on le laisse
 *             partir plutôt que de figer le bot (l'intention de 0990f4c, c'est la MENACE).
 */
function lowHpStep(s = {}) {
  // `targetHp` (24/10) : seuil d'un skill PLUS exigeant que le critique (caveHunt refuse sous 12 PV, `low_hp`) —
  // on récupère jusqu'à lui, pas seulement jusqu'à 6.
  const target = typeof s.targetHp === 'number' && Number.isFinite(s.targetHp) ? s.targetHp : null;
  if (target != null ? !(typeof s.health === 'number' && s.health < target) : !isCritical(s.health)) return 'ok';
  const food = typeof s.food === 'number' ? s.food : null;
  const regen = food != null && food > REGEN_FOOD;
  const threat = typeof s.threatDist === 'number' && Number.isFinite(s.threatDist) ? s.threatDist : null;
  // 24/10 : se murer AVANT de manger quand un hostile est collé — une bouchée rengaine l'arme 1,6 s et
  // le coup suivant tombe pendant le repas (« reculer/se murer d'abord »). Muré, on mange.
  if (threat != null && threat <= LOWHP_SEAL_RADIUS && !s.sealed) return 'seal';
  if (s.hasFood && !regen && (s.eatFails || 0) < LOWHP_MAX_EAT_FAILS) return 'eat';
  if (threat != null && threat <= LOWHP_THREAT_RADIUS) return 'wait';
  if (regen) return 'wait';
  if (!s.foodRunTriedRecently) return 'food_run';
  return 'proceed';
}

/**
 * La raison d'échec d'un skill est-elle un craft refusé à PV critiques ? (24/10) Les skills qui
 * enchaînent plusieurs crafts remontent la raison PRÉFIXÉE (`gift_batch_craft:low_hp_skip`) : elle
 * échappait au `reason === 'low_hp_skip'` de runSkillWithTelemetry → goal_failed relancé en boucle
 * (NethBot2, ×16 en 10 min à 1,1 PV) au lieu de la récupération.
 */
// 24/10 (NethBot1, `diamond_caves → goal_failed low_hp` ×12 en 10 min) : la garde PV de caveHunt rend la
// raison BRUTE `low_hp` (sous 12 PV, caveIron.CAVE_MIN_HP) — elle échappait aussi à la récupération.
function isLowHpSkip(reason) {
  return typeof reason === 'string' && /(^|:)low_hp(_skip)?$/.test(reason);
}

/** PV à atteindre pour une raison PV donnée : `low_hp` (garde de grotte) → 12 ; `low_hp_skip` → critique (null). */
const LOWHP_CAVE_TARGET = 12;                // = caveIron.CAVE_MIN_HP (pas d'import : cycle évité)
function lowHpTargetFor(reason) {
  return (typeof reason === 'string' && /(^|:)low_hp$/.test(reason)) ? LOWHP_CAVE_TARGET : null;
}

/** Le craft doit-il être refusé ? (garde de craftSmart) */
function craftBlockedAtLowHp(s) {
  const st = lowHpStep(s);
  return st !== 'ok' && st !== 'proceed';
}

// ─── LE TROU DE NUIT NE MARTÈLE PLUS UN CRAFT REFUSÉ (22/10) ─────────────────────────────────────
// Chrono de 61 min : NethBot3, 56 `night_craft torch low_hp_skip` dans son abri — un essai à chaque pas
// de l'attente (≈ 5 s), alors que la garde ne pouvait que refuser tant que les PV ne remontaient pas.
// Une tentative par minute suffit : la garde se relit au pas suivant, et le refus ne coûte rien.
const LOWHP_SKIP_RETRY_MS = 60000;

/** Faut-il NE PAS retenter le craft ce pas-ci ? (refus encore en vigueur, dernier refus < 1 min) (pur) */
function shelterCraftThrottled({ blocked, lastSkipAt, now } = {}) {
  if (!blocked) return false;
  if (typeof lastSkipAt !== 'number' || !(lastSkipAt > 0) || typeof now !== 'number') return false;
  return now - lastSkipAt < LOWHP_SKIP_RETRY_MS && now >= lastSkipAt;
}

module.exports = {
  shelterCraftThrottled, LOWHP_SKIP_RETRY_MS,
  lowHpStep, craftBlockedAtLowHp, isCritical, isLowHpSkip, lowHpTargetFor, LOWHP_CAVE_TARGET,
  LOWHP_THREAT_RADIUS, LOWHP_SEAL_RADIUS, LOWHP_RECOVERY_BUDGET_MS, LOWHP_FOOD_RUN_TTL_MS, LOWHP_MAX_EAT_FAILS,
};
