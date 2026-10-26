'use strict';
// ─── DISJONCTEUR DE COMBAT (22/10) ──────────────────────────────────────────────────────────────
// Mesure live (25 min, mineurs NethBot1-3 en Hard, 2-3 pièces de fer) : 8 morts, signature
// `fight_chosen {canDealWith:8, hostiles:2, health:14.12}` → `imminent_bookmark_death hp:1.3` 3 s plus
// tard. 6 morts sur 10 surviennent quand le bot ENGAGE à ≤ 16,8 PV. Deux trous :
//   1. on engageait un groupe à 14 PV (la règle de nuit s'arrêtait à 14, la formule canDealWith
//      d'AltoClef est calibrée pour une difficulté normale) ;
//   2. une fois engagé, plus RIEN ne regardait les PV fondre — mineflayer-pvp poursuit sa cible
//      jusqu'à la mort de l'un des deux, et la fuite n'arrivait qu'au seuil critique (trop tard).
// Ce module : la règle d'ENGAGEMENT (PV minimum selon le nombre), le DISJONCTEUR (chute ≥ 6 PV en 4 s
// ou PV < 10 → on lâche le combat) et le délai de RÉ-ENGAGEMENT (8 s, sauf acculé). Décisions PURES +
// une petite machine à état sans horloge propre (le temps est toujours passé en argument).

const FIGHT_GROUP_MIN_HP = 18;     // ≥ 2 hostiles : on n'engage qu'à 18 PV ou plus
// ARMURÉ (26/10) : en armure de fer complète, un groupe de zombies se combat jusqu'à 10 PV — fuir à 17,8 PV
// une horde de 4 qui court aussi vite a tué NethBot2 4 fois en 4 min (`fight_refused low_hp` puis rattrapé).
const FIGHT_GROUP_MIN_HP_ARMORED = 10;
const FIGHT_SOLO_MIN_HP = 12;      // 1 hostile : on n'engage pas sous 12 PV
const ABORT_DROP_HP = 6;           // chute de PV qui déclenche le disjoncteur…
const ABORT_WINDOW_MS = 4000;      // …sur cette fenêtre glissante
const ABORT_FLOOR_HP = 10;         // sous ce seuil, on lâche le combat quoi qu'il arrive
const REENGAGE_COOLDOWN_MS = 8000; // pas de ré-engagement pendant 8 s après un abandon…
const CORNERED_AFTER_MS = 2000;    // …sauf ACCULÉ : la fuite tourne depuis 2 s…
const CORNERED_MOVE = 1.5;         // …le bot a bougé de moins de 1,5 bloc…
const CORNERED_REACH = 3.5;        // …et l'assaillant est encore à portée de coup
const ABORT_MIN_GAP_MS = 1000;     // anti-rafale : un abandon au plus par seconde
// FUITE PERDUE (live 22/10, `fight_refused low_hp` : un mineur fuit UN zombie en perdant 13,6→9,2→4,8 PV).
// Un zombie marche aussi vite qu'un bot qui ne sprinte pas (faim ≤ 6 = sprint coupé) : la fuite ne le
// distance pas, il frappe dans le dos. Seul contre un seul assaillant, se battre vaut mieux que mourir
// en courant → « acculé » même si le bot a bougé, dès que la fuite a COÛTÉ des PV sans décrocher.
const OUTRUN_LOSS_HP = 2;          // PV perdus depuis le début de la fuite…
const OUTRUN_AFTER_MS = 1000;      // …après au moins 1 s de fuite, l'assaillant toujours à portée de coup

// DUEL CONTRE UN ZOMBIE (23/10) — mesure sur 11 h de sessions mineurs, rencontres SANS squelette ni
// creeper : commencée en FUYANT la rencontre finit en mort 22/40 (55 %), commencée en COMBATTANT 11/50
// (22 %) ; combat jamais lâché 1/26 (4 %), combat lâché pour fuir 10/24 (42 %) ; à 6-12 PV au départ,
// fuir 10/18 (56 %) contre combattre 4/9 (44 %). Un zombie se distance mal à pied (galeries, culs-de-sac,
// sprint coupé) et frappe dans le dos : seul contre UN zombie et armé, on se bat jusqu'à 6 PV, et le
// disjoncteur ne coupe plus sur la chute de PV (2 coups en 4 s, c'est le rythme normal d'un duel).
// Groupes, squelettes, creepers : règles inchangées.
const ZOMBIE_FAMILY = new Set(['zombie', 'husk', 'drowned', 'zombie_villager']);
const DUEL_MIN_HP = 6;             // en duel : on engage à ≥ 6 PV, on lâche sous 6
const DUEL_MIN_DAMAGE = 5;         // dégât plein (survival.attackDamage) d'une épée / hache de pierre

// DERNIER CARRÉ (25/10, run keepInventory OFF, 22 morts en 2 h) : 7 `fight_aborted` contre UN seul hostile,
// 6 morts dans les 20 s (4 en ≤ 4 s), toutes « slain by Zombie » — le bot nu, à 4-10 PV, tourne le dos au
// zombie COLLÉ et prend le coup suivant dans le dos. Seul contre un zombie déjà à portée de coup, on finit
// le combat : ni coupure du disjoncteur, ni fuite réflexe sur PV bas, l'engagement reste permis. Au-delà de
// la portée de coup, ou dès qu'un 2ᵉ hostile (creeper compris) est là, les règles d'origine reprennent.
const LAST_STAND_REACH = 3.5;      // = CORNERED_REACH : l'assaillant frappe encore
// Une VRAIE arme (épée/hache de bois ou mieux) : aux poings un zombie de 20 PV ne se tue pas, la fuite reste
// la seule chance — ce cas garde la règle d'origine (test survival_duel « zombie à 9 PV SANS arme → fuite »).
const LAST_STAND_MIN_DAMAGE = 4;

function _num(x) { return typeof x === 'number' && Number.isFinite(x); }

/** PUR — un seul hostile proche (creeper compris), de la famille zombie, à portée de coup, et une arme ? */
function isLoneZombieContact({ names, nearestDist, attackDamage } = {}) {
  if (!Array.isArray(names) || names.length !== 1 || !ZOMBIE_FAMILY.has(names[0])) return false;
  if (!_num(attackDamage) || attackDamage < LAST_STAND_MIN_DAMAGE) return false;
  return _num(nearestDist) && nearestDist <= LAST_STAND_REACH;
}

/**
 * PUR — duel contre un zombie ? `names` = TOUS les hostiles proches (creeper compris) ; exactement un,
 * de la famille zombie, et une arme d'au moins `DUEL_MIN_DAMAGE` (épée/hache de pierre).
 */
function isZombieDuel({ names, attackDamage } = {}) {
  if (!Array.isArray(names) || names.length !== 1) return false;
  if (!ZOMBIE_FAMILY.has(names[0])) return false;
  return _num(attackDamage) && attackDamage >= DUEL_MIN_DAMAGE;
}

/**
 * PUR — règle d'ENGAGEMENT selon les PV et le nombre d'hostiles. PV ou nombre inconnus → autorisé
 * (rétro-compat : on ne refuse que sur une donnée lue).
 */
function engageAllowedByHp({ health, hostiles, duel, armored } = {}) {
  if (!_num(health) || !_num(hostiles) || hostiles < 1) return true;
  if (duel) return health >= DUEL_MIN_HP;
  if (hostiles >= 2) return health >= (armored === true ? FIGHT_GROUP_MIN_HP_ARMORED : FIGHT_GROUP_MIN_HP);
  return health >= FIGHT_SOLO_MIN_HP;
}

/** PUR — chute de PV sur la fenêtre : max des PV relevés dans [now-window, now] moins les PV actuels. */
function hpDrop(samples, now, health, windowMs = ABORT_WINDOW_MS) {
  if (!_num(health) || !_num(now) || !Array.isArray(samples)) return 0;
  let peak = health;
  for (const s of samples) {
    if (!s || !_num(s.t) || !_num(s.hp)) continue;
    if (s.t > now || now - s.t > windowMs) continue;
    if (s.hp > peak) peak = s.hp;
  }
  return Math.max(0, peak - health);
}

/** PUR — faut-il lâcher le combat en cours ? Rend 'floor' | 'drop' | null. */
function shouldAbortFight({ inFight, health, drop, duel, lastStand } = {}) {
  if (!inFight || !_num(health)) return null;
  if (lastStand) return null;
  if (duel) return health < DUEL_MIN_HP ? 'floor' : null;
  if (health < ABORT_FLOOR_HP) return 'floor';
  if (_num(drop) && drop >= ABORT_DROP_HP) return 'drop';
  return null;
}

/**
 * PUR — acculé ? La fuite a démarré il y a ≥ 2 s et n'a quasiment rien donné, l'assaillant est encore
 * au contact — OU la fuite n'a même pas pu partir (`fleeFailed` : aucun but posé).
 */
function isCornered({ fleePos, pos, sinceFleeMs, nearestDist, fleeFailed } = {}) {
  if (!_num(nearestDist) || nearestDist > CORNERED_REACH) return false;
  if (fleeFailed) return true;
  if (!fleePos || !pos || !_num(sinceFleeMs) || sinceFleeMs < CORNERED_AFTER_MS) return false;
  const moved = Math.hypot((pos.x - fleePos.x) || 0, (pos.y - fleePos.y) || 0, (pos.z - fleePos.z) || 0);
  return Number.isFinite(moved) && moved < CORNERED_MOVE;
}

/**
 * PUR — la fuite est-elle PERDUE ? Un seul hostile, encore au contact (≤ CORNERED_REACH), la fuite dure
 * depuis ≥ 1 s et le bot a perdu ≥ 2 PV depuis qu'elle a commencé. (Contre un groupe : jamais — la
 * règle « ne pas engager un groupe sous 18 PV » reste souveraine.)
 */
function fleeLosing({ fleeHp, health, sinceFleeMs, nearestDist, hostiles } = {}) {
  if (!_num(fleeHp) || !_num(health) || !_num(sinceFleeMs) || !_num(nearestDist)) return false;
  if (_num(hostiles) && hostiles > 1) return false;
  if (nearestDist > CORNERED_REACH || sinceFleeMs < OUTRUN_AFTER_MS) return false;
  return fleeHp - health >= OUTRUN_LOSS_HP;
}

/** PUR — ré-engagement permis ? (aucun abandon, délai écoulé, horloge reculée, ou acculé) */
function reengageAllowed({ now, abortedAt, cornered } = {}) {
  if (cornered) return true;
  if (!_num(abortedAt) || !_num(now)) return true;
  if (now < abortedAt) return true;
  return now - abortedAt >= REENGAGE_COOLDOWN_MS;
}

/** Copie x/y/z (bot.entity.position est MUTÉ en place par le paquet serveur : jamais de référence). */
function _copy(p) {
  return p && _num(p.x) && _num(p.y) && _num(p.z) ? { x: p.x, y: p.y, z: p.z } : null;
}

/**
 * Machine à état du disjoncteur (une par process, niveau module côté index.js).
 *   sample(hp, t)                    — relever les PV (event `health` + filet périodique) ;
 *   check({inFight, health, t})      — { abort, reason, drop } : faut-il lâcher MAINTENANT ? ;
 *   noteAbort({t, pos, fleeOk})      — l'abandon a eu lieu (démarre le délai de ré-engagement) ;
 *   noteFlee({t, pos, fleeOk})       — une fuite a démarré (refus d'engager), sert au test « acculé » ;
 *   canEngage({t, pos, health, hostiles, nearestDist}) — { ok, cornered, reason }.
 * Un combat accordé parce qu'ACCULÉ n'est pas re-disjoncté pendant REENGAGE_COOLDOWN_MS (courir ne
 * marche pas : lâcher le combat une 2ᵉ fois livrerait le bot sans défense).
 */
function createFightBreaker() {
  let samples = [];
  let abortedAt = null;
  let lastAbortAt = -Infinity;
  let flee = null;              // { t, pos, failed }
  let corneredUntil = -Infinity;

  function sample(hp, t) {
    if (!_num(hp) || !_num(t)) return;
    samples.push({ hp, t });
    samples = samples.filter((s) => s.t <= t && t - s.t <= ABORT_WINDOW_MS);
  }

  function check({ inFight, health, t, duel, lastStand } = {}) {
    const drop = hpDrop(samples, t, health);
    if (!inFight) return { abort: false, reason: null, drop };
    if (_num(t) && t < corneredUntil) return { abort: false, reason: 'cornered', drop };
    if (_num(t) && t >= lastAbortAt && t - lastAbortAt < ABORT_MIN_GAP_MS) return { abort: false, reason: null, drop };
    const reason = shouldAbortFight({ inFight, health, drop, duel });
    if (reason && lastStand) return { abort: false, reason: 'last_stand', drop };
    return { abort: !!reason, reason, drop };
  }

  // Une fuite déjà en cours (< REENGAGE_COOLDOWN_MS) garde son point et son heure de départ : sinon
  // chaque refus d'engager la redémarrerait et le test « acculé » (≥ 2 s sans bouger) ne passerait jamais.
  function noteFlee({ t, pos, fleeOk, reset, health } = {}) {
    const recent = !reset && flee && _num(flee.t) && _num(t) && t >= flee.t && t - flee.t <= REENGAGE_COOLDOWN_MS;
    if (recent) { if (fleeOk === false) flee.failed = true; return; }
    flee = { t: _num(t) ? t : null, pos: _copy(pos), failed: fleeOk === false, hp: _num(health) ? health : null };
  }

  function noteAbort({ t, pos, fleeOk, health } = {}) {
    abortedAt = _num(t) ? t : null;
    lastAbortAt = _num(t) ? t : -Infinity;
    corneredUntil = -Infinity;
    noteFlee({ t, pos, fleeOk, reset: true, health });
  }

  function canEngage({ t, pos, health, hostiles, nearestDist, duel, lastStand, armored } = {}) {
    if (lastStand) return { ok: true, cornered: true, reason: 'last_stand' };
    const sinceFleeMs = flee && _num(flee.t) && _num(t) ? t - flee.t : null;
    const fleeRecent = sinceFleeMs != null && sinceFleeMs >= 0 && sinceFleeMs <= REENGAGE_COOLDOWN_MS;
    const cornered = fleeRecent && isCornered({ fleePos: flee.pos, pos: _copy(pos), sinceFleeMs, nearestDist, fleeFailed: flee.failed });
    const losing = fleeRecent && !cornered && fleeLosing({ fleeHp: flee.hp, health, sinceFleeMs, nearestDist, hostiles });
    if (cornered || losing) {
      if (_num(t)) corneredUntil = t + REENGAGE_COOLDOWN_MS;
      return { ok: true, cornered: true, reason: losing ? 'outrun_failed' : 'cornered' };
    }
    if (_num(t) && t < corneredUntil) return { ok: true, cornered: true, reason: 'cornered' };
    if (!reengageAllowed({ now: t, abortedAt, cornered: false })) return { ok: false, cornered: false, reason: 'cooldown' };
    if (!engageAllowedByHp({ health, hostiles, duel, armored })) return { ok: false, cornered: false, reason: 'low_hp' };
    return { ok: true, cornered: false, reason: null };
  }

  // CHARGE SUR UN SQUELETTE (skeletonResponse.js, 22/10) : la décision « rush » a déjà pesé PV, distance
  // et arme ; lâcher ce combat à mi-course (plancher 10 PV) remettrait le bot de dos dans la ligne de tir
  // — c'est exactement ce qui le tuait. Même régime qu'un combat accordé « acculé ».
  function grant({ t, ms } = {}) {
    if (!_num(t) || !_num(ms) || ms <= 0) return;
    corneredUntil = Math.max(corneredUntil, t + ms);
  }

  return { sample, check, noteAbort, noteFlee, canEngage, grant, _state: () => ({ samples: samples.slice(), abortedAt, flee, corneredUntil }) };
}

module.exports = {
  engageAllowedByHp, isZombieDuel, isLoneZombieContact, LAST_STAND_REACH, LAST_STAND_MIN_DAMAGE, ZOMBIE_FAMILY, DUEL_MIN_HP, DUEL_MIN_DAMAGE, hpDrop, shouldAbortFight, isCornered, fleeLosing, reengageAllowed, createFightBreaker,
  OUTRUN_LOSS_HP, OUTRUN_AFTER_MS,
  FIGHT_GROUP_MIN_HP, FIGHT_GROUP_MIN_HP_ARMORED, FIGHT_SOLO_MIN_HP, ABORT_DROP_HP, ABORT_WINDOW_MS, ABORT_FLOOR_HP,
  REENGAGE_COOLDOWN_MS, CORNERED_AFTER_MS, CORNERED_MOVE, CORNERED_REACH, ABORT_MIN_GAP_MS,
};
