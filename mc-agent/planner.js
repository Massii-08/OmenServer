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

    // Fingerprint étendu : inv + table + position (x,y,z floored). Un dig de deepslate sans pickup
    // ne change PAS l'inv → si on ne regardait que l'inv, branchMine resterait au même endroit et
    // stallerait après 4 iters. La position couvre les skills exploratoires (descend/branchMine).
    const _bx = bot && bot.entity && bot.entity.position ? Math.floor(bot.entity.position.x) : 0;
    const _bz = bot && bot.entity && bot.entity.position ? Math.floor(bot.entity.position.z) : 0;
    const _by = ctx.y !== undefined ? Math.floor(ctx.y) : 0;
    const before = JSON.stringify(ctx.inv) + '|' + (ctx.hasTable ? 1 : 0) + '|' + _bx + ',' + _by + ',' + _bz;
    if (opts.onStep) { try { opts.onStep(goal); } catch (e) {} }
    try { await runSkill(goal, bot); } catch (e) { /* compté comme stall */ }
    if (token && token.cancelled) return { cancelled: true };

    const ctx2 = Object.assign({ inv: buildCtxInv(bot) }, ctxExtra());
    const _ax = bot && bot.entity && bot.entity.position ? Math.floor(bot.entity.position.x) : 0;
    const _az = bot && bot.entity && bot.entity.position ? Math.floor(bot.entity.position.z) : 0;
    const _ay = ctx2.y !== undefined ? Math.floor(ctx2.y) : 0;
    const after = JSON.stringify(ctx2.inv) + '|' + (ctx2.hasTable ? 1 : 0) + '|' + _ax + ',' + _ay + ',' + _az;
    if (after === before) { stalls++; } else { stalls = 0; }
    if (stalls >= maxStalls) return { stalled: true, goal: goal.name };
  }
}

module.exports = { runPlanner };
