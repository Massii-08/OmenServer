'use strict';
// Boucle de buts déterministe (0 token). firstUnmet → runSkill → re-loop.
const { buildCtxInv, firstUnmet } = require('./goals');

/**
 * runPlanner(bot, opts, token)
 *  opts.chain   : tableau de buts (goals.MVP_CHAIN)
 *  opts.runSkill: async (goal, bot) => {ok, reason?}   (dispatch vers les skills réels)
 *  opts.ctxExtra: () => ({ hasTable })                 (état monde non-inventaire)
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

    const before = JSON.stringify(ctx.inv) + '|' + (ctx.hasTable ? 1 : 0);
    if (opts.onStep) { try { opts.onStep(goal); } catch (e) {} }
    try { await runSkill(goal, bot); } catch (e) { /* compté comme stall */ }
    if (token && token.cancelled) return { cancelled: true };

    const ctx2 = Object.assign({ inv: buildCtxInv(bot) }, ctxExtra());
    const after = JSON.stringify(ctx2.inv) + '|' + (ctx2.hasTable ? 1 : 0);
    if (after === before) { stalls++; } else { stalls = 0; }
    if (stalls >= maxStalls) return { stalled: true, goal: goal.name };
  }
}

module.exports = { runPlanner };
