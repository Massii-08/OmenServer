'use strict';
// ─── WATCHDOG DU PLANNER (live 21/10, NethBot3 session 48) ───────────────────────────────────────
// Un `await` qui ne rend jamais la main quelque part sous le planner (vécu : `bot.dig` de l'abri de nuit
// après un téléport) gèle le bot SANS UNE ERREUR : plus un seul event `goal`, ni retry, ni abri fini,
// alors que le jour est levé. Toutes les bornes locales du monde ne couvrent que les chemins qu'on a
// pensé à borner ; ce filet-ci regarde le SYMPTÔME — plus aucun but depuis 6 min — et relance.
// PUR : la décision. Le câblage (relance de startAutonomous) vit dans index.js.

const PLANNER_STALE_MS = 6 * 60 * 1000;          // plus un seul `goal` depuis 6 min = suspect
const PLANNER_BUSY_CEIL_MS = 17 * 60 * 1000;     // plafond d'une immobilité LÉGITIME (abri 16 min, skill 15 min)
const PLANNER_WATCHDOG_GAP_MS = 6 * 60 * 1000;   // une relance au plus toutes les 6 min

/**
 * → { fire:boolean, why:string, idleS:number }
 * s : { now, active (planner autonome actif), lastGoalAt, lastFireAt, migrating,
 *       shelterSince (0 = pas d'abri), sleeping, nightHold (nb), skillInFlight (nb) }
 * Légitime (pas de relance avant PLANNER_BUSY_CEIL_MS) : abri en cours, sommeil, retenue de nuit,
 * skill en vol — chacun a sa propre borne ≤ 16 min ; au-delà, c'est qu'elle n'a pas joué.
 */
function plannerWatchdogVerdict(s = {}) {
  const now = Number.isFinite(s.now) ? s.now : Date.now();
  const last = Number.isFinite(s.lastGoalAt) && s.lastGoalAt > 0 ? s.lastGoalAt : now;
  const idle = Math.max(0, now - last);
  const idleS = Math.round(idle / 1000);
  if (!s.active) return { fire: false, why: 'inactive', idleS };
  if (s.migrating) return { fire: false, why: 'migrating', idleS };
  if (Number.isFinite(s.lastFireAt) && s.lastFireAt > 0 && now - s.lastFireAt < PLANNER_WATCHDOG_GAP_MS) {
    return { fire: false, why: 'cooldown', idleS };
  }
  if (idle < PLANNER_STALE_MS) return { fire: false, why: 'fresh', idleS };
  const shelterAge = s.shelterSince > 0 ? now - s.shelterSince : null;
  let busy = null;
  if (shelterAge != null) busy = shelterAge < PLANNER_BUSY_CEIL_MS ? 'shelter' : null;
  else if (s.sleeping) busy = 'sleeping';
  else if ((s.nightHold || 0) > 0) busy = 'night_hold';
  else if ((s.skillInFlight || 0) > 0) busy = 'skill';
  if (busy && idle < PLANNER_BUSY_CEIL_MS) return { fire: false, why: busy, idleS };
  return { fire: true, why: shelterAge != null ? 'shelter_stuck' : (busy ? busy + '_stuck' : 'stale'), idleS };
}

/** Jeton DÉRIVÉ : annulé si le parent l'est OU si on l'annule lui-même (le parent n'est jamais touché). */
function deriveToken(parent) {
  let own = false;
  return {
    get cancelled() { return own || !!(parent && parent.cancelled); },
    set cancelled(v) { own = !!v; },
  };
}

module.exports = {
  plannerWatchdogVerdict, deriveToken,
  PLANNER_STALE_MS, PLANNER_BUSY_CEIL_MS, PLANNER_WATCHDOG_GAP_MS,
};
