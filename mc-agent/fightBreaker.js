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
const FIGHT_SOLO_MIN_HP = 12;      // 1 hostile : on n'engage pas sous 12 PV
const ABORT_DROP_HP = 6;           // chute de PV qui déclenche le disjoncteur…
const ABORT_WINDOW_MS = 4000;      // …sur cette fenêtre glissante
const ABORT_FLOOR_HP = 10;         // sous ce seuil, on lâche le combat quoi qu'il arrive
const REENGAGE_COOLDOWN_MS = 8000; // pas de ré-engagement pendant 8 s après un abandon…
const CORNERED_AFTER_MS = 2000;    // …sauf ACCULÉ : la fuite tourne depuis 2 s…
const CORNERED_MOVE = 1.5;         // …le bot a bougé de moins de 1,5 bloc…
const CORNERED_REACH = 3.5;        // …et l'assaillant est encore à portée de coup
const ABORT_MIN_GAP_MS = 1000;     // anti-rafale : un abandon au plus par seconde

function _num(x) { return typeof x === 'number' && Number.isFinite(x); }

/**
 * PUR — règle d'ENGAGEMENT selon les PV et le nombre d'hostiles. PV ou nombre inconnus → autorisé
 * (rétro-compat : on ne refuse que sur une donnée lue).
 */
function engageAllowedByHp({ health, hostiles } = {}) {
  if (!_num(health) || !_num(hostiles) || hostiles < 1) return true;
  if (hostiles >= 2) return health >= FIGHT_GROUP_MIN_HP;
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
function shouldAbortFight({ inFight, health, drop } = {}) {
  if (!inFight || !_num(health)) return null;
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

  function check({ inFight, health, t } = {}) {
    const drop = hpDrop(samples, t, health);
    if (!inFight) return { abort: false, reason: null, drop };
    if (_num(t) && t < corneredUntil) return { abort: false, reason: 'cornered', drop };
    if (_num(t) && t >= lastAbortAt && t - lastAbortAt < ABORT_MIN_GAP_MS) return { abort: false, reason: null, drop };
    const reason = shouldAbortFight({ inFight, health, drop });
    return { abort: !!reason, reason, drop };
  }

  // Une fuite déjà en cours (< REENGAGE_COOLDOWN_MS) garde son point et son heure de départ : sinon
  // chaque refus d'engager la redémarrerait et le test « acculé » (≥ 2 s sans bouger) ne passerait jamais.
  function noteFlee({ t, pos, fleeOk, reset } = {}) {
    const recent = !reset && flee && _num(flee.t) && _num(t) && t >= flee.t && t - flee.t <= REENGAGE_COOLDOWN_MS;
    if (recent) { if (fleeOk === false) flee.failed = true; return; }
    flee = { t: _num(t) ? t : null, pos: _copy(pos), failed: fleeOk === false };
  }

  function noteAbort({ t, pos, fleeOk } = {}) {
    abortedAt = _num(t) ? t : null;
    lastAbortAt = _num(t) ? t : -Infinity;
    corneredUntil = -Infinity;
    noteFlee({ t, pos, fleeOk, reset: true });
  }

  function canEngage({ t, pos, health, hostiles, nearestDist } = {}) {
    const sinceFleeMs = flee && _num(flee.t) && _num(t) ? t - flee.t : null;
    const fleeRecent = sinceFleeMs != null && sinceFleeMs >= 0 && sinceFleeMs <= REENGAGE_COOLDOWN_MS;
    const cornered = fleeRecent && isCornered({ fleePos: flee.pos, pos: _copy(pos), sinceFleeMs, nearestDist, fleeFailed: flee.failed });
    if (cornered) {
      if (_num(t)) corneredUntil = t + REENGAGE_COOLDOWN_MS;
      return { ok: true, cornered: true, reason: 'cornered' };
    }
    if (_num(t) && t < corneredUntil) return { ok: true, cornered: true, reason: 'cornered' };
    if (!reengageAllowed({ now: t, abortedAt, cornered: false })) return { ok: false, cornered: false, reason: 'cooldown' };
    if (!engageAllowedByHp({ health, hostiles })) return { ok: false, cornered: false, reason: 'low_hp' };
    return { ok: true, cornered: false, reason: null };
  }

  return { sample, check, noteAbort, noteFlee, canEngage, _state: () => ({ samples: samples.slice(), abortedAt, flee, corneredUntil }) };
}

module.exports = {
  engageAllowedByHp, hpDrop, shouldAbortFight, isCornered, reengageAllowed, createFightBreaker,
  FIGHT_GROUP_MIN_HP, FIGHT_SOLO_MIN_HP, ABORT_DROP_HP, ABORT_WINDOW_MS, ABORT_FLOOR_HP,
  REENGAGE_COOLDOWN_MS, CORNERED_AFTER_MS, CORNERED_MOVE, CORNERED_REACH, ABORT_MIN_GAP_MS,
};
