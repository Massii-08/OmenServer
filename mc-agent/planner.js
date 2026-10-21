'use strict';
// Boucle de buts déterministe (0 token). firstUnmet → runSkill → re-loop.
const { buildCtxInv, firstUnmet } = require('./goals');

// ─── GARDE ANTI-BOUCLE-CHAUDE (19/10) ─────────────────────────────────────────────────────────
// NethBot2, mesuré en live : juste après une téléportation (`wood_trip` → `teleport_detected` →
// `safe_warp warped:true`), `goal planks` a été émis 111× en 2,2 s (un toutes les ~20 ms), AUCUN
// `goal_failed`, puis le serveur a expulsé le bot (flood de paquets : chaque tour envoyait un craft).
// Les deux sorties historiques étaient aveugles à ce cas :
//   - failStreak ne compte que les {ok:false} EXPLICITES — le skill rendait {ok:true} (ou rien) ;
//   - le fingerprint inv+position stalle quand RIEN ne bouge — or juste après un tp le bot retombe
//     et se recale, donc sa position change à chaque tour et `stalls` repart à 0.
// La garde ne regarde ni le résultat ni la position : elle mesure la DURÉE du skill. Un vrai skill
// (marche, minage, fonte, craft sur table) prend des secondes ; un but relancé en boucle dont le skill
// rend la main en < 150 ms n'a rien fait de réel, quoi qu'il réponde. Au 3e tour instantané consécutif
// sur le même but on ATTEND avant de relancer (le flood s'arrête, le monde a le temps de se recaler),
// au 8e on abandonne : l'appelant sait déjà gérer `stalled` (re-dérivation, relocalisation…).
const HOT_LOOP_MS = 150;                          // < 150 ms = tour « instantané » (150 pile = lent)
const HOT_LOOP_BACKOFF_FROM = 3;                  // dès le 3e tour instantané consécutif : on attend
const HOT_LOOP_STALL_AT = 8;                      // au 8e : stalled { reason: 'hot_loop' }
const HOT_LOOP_BACKOFF_STEPS = [250, 500, 1000, 2000];   // croissant ; le dernier palier est le plafond

// Attente (ms) imposée après le n-ième tour instantané consécutif : 3 → 250, 4 → 500, 5 → 1000,
// 6 et au-delà → 2000 (plafond).
function hotLoopBackoffMs(instantTurns) {
  const i = Math.min(Math.max(instantTurns - HOT_LOOP_BACKOFF_FROM, 0), HOT_LOOP_BACKOFF_STEPS.length - 1);
  return HOT_LOOP_BACKOFF_STEPS[i];
}

const _realSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * runPlanner(bot, opts, token)
 *  opts.chain   : tableau de buts (goals.MVP_CHAIN)
 *  opts.runSkill: async (goal, bot) => {ok, reason?}   (dispatch vers les skills réels)
 *  opts.ctxExtra: () => ({ hasTable })                 (état monde non-inventaire)
 *  opts.maxStalls: nb d'itérations sans progrès avant fallback (défaut 4)
 *  opts.onStep  : (goal) => void                       (hook events, optionnel)
 *  opts.skip    : (goal, ctx) => bool                  (but DIFFÉRÉ : sauté au profit du suivant faisable,
 *                                                       cf. goals.firstUnmet — nuit au travail 21/10)
 *  opts.now     : () => ms                             (horloge de la garde anti-boucle-chaude ; défaut Date.now)
 *  opts.sleep   : async (ms) => void                   (attente du back-off ; défaut setTimeout) — les deux
 *                                                       sont injectables pour que les tests n'attendent rien
 * Retour : { done, steps } | { cancelled } | { stalled, goal, reason? }
 *  steps = nb de skills exécutés par CE run. 0 = chaîne satisfaite d'office : sans ce compte, le
 *  caller ne distinguait pas « objectif atteint après une heure de travail » de « rien à faire » —
 *  d'où la boucle à vide mapper_armor→mapper_armor ×47 791 du run 17-18/08 (fix 18/08).
 *  reason n'est renseigné que par la garde anti-boucle-chaude ('hot_loop') ; les stalls historiques
 *  (failStreak, fingerprint) gardent EXACTEMENT leur forme { stalled, goal }.
 */
async function runPlanner(bot, opts, token) {
  const chain = opts.chain;
  const runSkill = opts.runSkill;
  const ctxExtra = opts.ctxExtra || (() => ({}));
  const maxStalls = opts.maxStalls || 4;
  const now = typeof opts.now === 'function' ? opts.now : Date.now;
  const sleep = typeof opts.sleep === 'function' ? opts.sleep : _realSleep;
  let stalls = 0;
  let failStreak = 0;   // échecs EXPLICITES consécutifs du même but ({ok:false} du skill)
  let lastGoal = null;
  let steps = 0;        // skills réellement lancés dans ce run (succès comme échec)
  let hotGoal = null;   // but du tour précédent, pour la garde anti-boucle-chaude
  let instant = 0;      // tours INSTANTANÉS (< HOT_LOOP_MS) consécutifs sur ce même but

  while (true) {
    if (token && token.cancelled) return { cancelled: true };
    const ctx = Object.assign({ inv: buildCtxInv(bot) }, ctxExtra());
    const goal = firstUnmet(chain, ctx, opts.skip);
    if (!goal) return { done: true, steps };

    // Fingerprint étendu : inv + table + position (x,y,z floored). Un dig de deepslate sans pickup
    // ne change PAS l'inv → si on ne regardait que l'inv, branchMine resterait au même endroit et
    // stallerait après 4 iters. La position couvre les skills exploratoires (descend/branchMine).
    const _bx = bot && bot.entity && bot.entity.position ? Math.floor(bot.entity.position.x) : 0;
    const _bz = bot && bot.entity && bot.entity.position ? Math.floor(bot.entity.position.z) : 0;
    const _by = ctx.y !== undefined ? Math.floor(ctx.y) : 0;
    const before = JSON.stringify(ctx.inv) + '|' + (ctx.hasTable ? 1 : 0) + '|' + _bx + ',' + _by + ',' + _bz;
    if (opts.onStep) { try { opts.onStep(goal); } catch (e) {} }
    let result = null;
    steps++;
    const t0 = now();
    try { result = await runSkill(goal, bot); } catch (e) { result = { ok: false }; }
    const elapsed = now() - t0;     // durée RÉELLE du skill (exception comprise) — alimente la garde plus bas
    if (token && token.cancelled) return { cancelled: true };

    // Échecs explicites (phase 3, vécu V3Res2/4) : le fingerprint POSITION empêchait tout stall
    // sur un but EXPLORATOIRE (gatherLog en anneaux = position qui change à chaque tentative →
    // stalls remis à 0 → boucle infinie logs timeout). Un skill qui RÉPOND {ok:false} 4× de
    // suite sur le même but = stall, peu importe le déplacement.
    if (goal.name !== lastGoal) { lastGoal = goal.name; failStreak = 0; }
    if (result && result.ok === false) failStreak++;
    else if (result && result.ok) failStreak = 0;
    if (failStreak >= maxStalls) return { stalled: true, goal: goal.name };

    const ctx2 = Object.assign({ inv: buildCtxInv(bot) }, ctxExtra());
    const _ax = bot && bot.entity && bot.entity.position ? Math.floor(bot.entity.position.x) : 0;
    const _az = bot && bot.entity && bot.entity.position ? Math.floor(bot.entity.position.z) : 0;
    const _ay = ctx2.y !== undefined ? Math.floor(ctx2.y) : 0;
    const after = JSON.stringify(ctx2.inv) + '|' + (ctx2.hasTable ? 1 : 0) + '|' + _ax + ',' + _ay + ',' + _az;
    if (after === before) { stalls++; } else { stalls = 0; }
    if (stalls >= maxStalls) return { stalled: true, goal: goal.name };

    // GARDE ANTI-BOUCLE-CHAUDE — APRÈS les deux sorties historiques, qui gardent la priorité (leur
    // forme de retour et leur moment de déclenchement ne changent pas). Un changement de but ou un
    // tour lent (≥ HOT_LOOP_MS) remet le compteur à zéro ; le résultat du skill n'y entre pas (c'est
    // justement ce que failStreak ne voyait pas), pas plus que la position (idem pour le fingerprint).
    if (goal.name !== hotGoal) { hotGoal = goal.name; instant = 0; }
    instant = elapsed < HOT_LOOP_MS ? instant + 1 : 0;
    if (instant >= HOT_LOOP_BACKOFF_FROM) {
      // Seul le MÊME but relancé compte : si ce tour vient de le satisfaire, il n'y a rien à
      // freiner (et un but qui s'achève en 3 tours rapides n'est pas une boucle).
      const next = firstUnmet(chain, ctx2, opts.skip);
      if (next && next.name === goal.name) {
        if (instant >= HOT_LOOP_STALL_AT) return { stalled: true, goal: goal.name, reason: 'hot_loop' };
        await sleep(hotLoopBackoffMs(instant));
        // Annulé pendant l'attente : on ne relance RIEN. (Le haut de boucle le ferait aussi au tour
        // suivant ; on le dit ici, sur place, pour que l'intention se lise sans suivre le flot.)
        if (token && token.cancelled) return { cancelled: true };
      }
    }
  }
}

module.exports = { runPlanner, hotLoopBackoffMs, HOT_LOOP_MS, HOT_LOOP_BACKOFF_FROM, HOT_LOOP_STALL_AT };
