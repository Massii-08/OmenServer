'use strict';
// Boucle de buts déterministe (0 token). firstUnmet → runSkill → re-loop.
const { buildCtxInv, firstUnmet } = require('./goals');

/**
 * Clé de progrès pour la détection de stall.
 * Par défaut : inventaire + présence d'une table (suffit pour les buts qui produisent un objet).
 * Si le but déclare `progress(ctx)` (buts "movement-based" comme descend_y54/branch_mine dont la
 * réussite est une POSITION ou une découverte, pas un objet d'inventaire), on AJOUTE sa valeur à la
 * clé. Ainsi descendre/avancer compte comme un progrès et n'est plus vu comme un faux stall.
 * Combiné (base + progress) → un progrès soit d'inventaire SOIT de position réinitialise le compteur.
 */
function progressKey(goal, ctx) {
  const base = JSON.stringify(ctx.inv) + '|' + (ctx.hasTable ? 1 : 0);
  if (goal && typeof goal.progress === 'function') {
    try { return base + '|' + JSON.stringify(goal.progress(ctx)); } catch (e) { /* fallback base */ }
  }
  return base;
}

/**
 * runPlanner(bot, opts, token)
 *  opts.chain   : tableau de buts (goals.MVP_CHAIN)
 *  opts.runSkill: async (goal, bot) => {ok, reason?}   (dispatch vers les skills réels)
 *  opts.ctxExtra: () => ({ hasTable, x, y, z })        (état monde non-inventaire)
 *  opts.maxStalls: nb d'itérations sans progrès avant fallback (défaut 4)
 *  opts.onStep  : (goal) => void                       (hook events, optionnel)
 * Retour : { done } | { cancelled } | { stalled, goal }
 */
async function runPlanner(bot, opts, token) {
  const chain = opts.chain;
  const runSkill = opts.runSkill;
  const ctxExtra = opts.ctxExtra || (() => ({}));
  const maxStalls = opts.maxStalls || 4;
  let stalls = 0;

  while (true) {
    if (token && token.cancelled) return { cancelled: true };
    const ctx = Object.assign({ inv: buildCtxInv(bot) }, ctxExtra());
    const goal = firstUnmet(chain, ctx);
    if (!goal) return { done: true };

    const before = progressKey(goal, ctx);
    if (opts.onStep) { try { opts.onStep(goal); } catch (e) {} }
    try { await runSkill(goal, bot); } catch (e) { /* compté comme stall */ }
    if (token && token.cancelled) return { cancelled: true };

    const ctx2 = Object.assign({ inv: buildCtxInv(bot) }, ctxExtra());
    const after = progressKey(goal, ctx2);
    if (after === before) { stalls++; } else { stalls = 0; }
    if (stalls >= maxStalls) return { stalled: true, goal: goal.name };
  }
}

module.exports = { runPlanner };
