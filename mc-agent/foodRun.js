'use strict';
// NOURRITURE — LES DEUX ORCHESTRATEURS, BORNÉS (Massii, 19/10 : « L'important c'est la VITESSE : pas
// de choix qui font trop durer. Et dans le pire des cas, il y a la viande de zombie. »)
//
// Ce module ne touche ni le bot ni l'horloge : tout passe par des dépendances injectées (index.js
// les câble sur le vrai bot, les tests sur des fausses + une horloge fausse). On y teste ce qui
// compte — QUOI tourne, DANS QUEL ORDRE, SOUS QUEL PLAFOND — parce qu'un budget non appliqué ou un
// seuil lu au mauvais endroit ne plante jamais : il rend juste la fonctionnalité morte (piège #61).
//
//   runEnsureFood  — la sortie « nourriture » : butin → remontée (à sec seulement) → chasse.
//   runHuntCook    — la chaîne chasse → cuisson → pêche, UNE vague, jamais de trajet lointain.
//
// Les deux se partagent UN budget (food.createBudget) : chaque phase reçoit min(son plafond, ce qui
// reste du total). Retiré de la chaîne (trop long pour ce qu'ils rapportent) : le trajet vers l'eau
// connue (jusqu'à 300 s), la chasse à la ficelle (90 s) et les 3 vagues de 120 s. La ficelle vient
// désormais du ramassage opportuniste APRÈS un combat contre une araignée.
const F = require('./food');
const { surfaceTripNeeded, FOOD_SURFACE_Y } = require('./caution');

const _noop = () => {};

/**
 * ensureFood : ravitaillement borné à FOOD_RUN_BUDGET_MS (60 s) au TOTAL.
 *
 * deps : { inventory():carte, y():nombre, hunger():nombre|undefined, foodItems():nombre,
 *          loot(o):Promise<nombre>, surfaceTrip({ms,y,food}):Promise, hunt({budget}):Promise,
 *          canGive:bool, give():void, emit(e):void, now?():ms, budget? }
 * → { points, steps:[…], why:'enough'|'no_give'|'give' }
 *
 * Ordre (consigne) : sortie anticipée à ≥ 20 points → balayage de butin (rayon 10, ≤ 8 s) →
 * remontée /home safe SEULEMENT si on est sous terre, affamé ET à sec (< 6 points) → chasse en
 * surface avec ce qui reste du budget → /give en dernier recours (jamais en sans-give).
 * Chaque dépendance est best-effort : une exception n'interrompt jamais la chaîne.
 */
async function runEnsureFood(d) {
  const emit = d.emit || _noop;
  const budget = d.budget || F.createBudget(F.FOOD_RUN_BUDGET_MS, d.now);
  const points = () => F.foodPoints(d.inventory());
  const out = { points: 0, steps: [], why: null };
  const done = (why) => { out.points = points(); out.why = why; return out; };

  if (points() >= F.ENSURE_SKIP_POINTS) return done('enough');

  // 1) BUTIN D'ABORD — la chair putréfiée et la viande crue nourrissent (EMERGENCY_FOODS), déjà
  //    tuées, à quelques blocs. Court : on ne transforme pas la faim en expédition.
  if (budget.left() >= F.MIN_PHASE_MS) {
    try {
      const got = await d.loot({ radius: F.LOOT_SWEEP_RADIUS, maxItems: 6, budgetMs: budget.take(F.LOOT_SWEEP_MS), abortOnFail: true });
      out.steps.push('loot');
      if (got) emit({ type: 'food_loot_swept', items: got });
    } catch (e) { /* best-effort */ }
  }
  if (points() >= F.ENSURE_SKIP_POINTS) return done('enough');

  // 2) SOUS TERRE ET À SEC : remonter d'abord (le home `safe` est en surface — un warp, pas une
  //    expédition). Deux portes, qui doivent TOUTES DEUX être ouvertes : le sac est vide au sens de
  //    caution.surfaceTripNeeded (plus rien de comestible) ET sous SURFACE_TRIP_POINTS.
  let y = d.y();
  if (points() < F.SURFACE_TRIP_POINTS && budget.left() >= F.MIN_PHASE_MS
      && surfaceTripNeeded({ y, food: d.hunger(), foodItems: d.foodItems() })) {
    try {
      await d.surfaceTrip({ ms: budget.take(F.SURFACE_TRIP_MS), y, food: d.hunger() });
      out.steps.push('trip');
    } catch (e) { /* best-effort : à défaut on retombe sur le comportement d'avant */ }
    // RELIRE l'altitude : sans ça la chasse jugerait sur la position d'AVANT le warp et la
    // remontée n'aurait servi à rien (piège #61).
    y = d.y();
  }

  // 3) CHASSE — en surface seulement (FOOD_SURFACE_Y : le MÊME plancher que la remontée, sinon un
  //    bot remonte à 44 pour se voir refuser la chasse à 44). Elle reçoit le budget RESTANT.
  if (y >= FOOD_SURFACE_Y && budget.left() >= F.MIN_PHASE_MS) {
    try { await d.hunt({ budget }); out.steps.push('hunt'); } catch (e) { /* best-effort */ }
  }
  if (points() >= F.ENSURE_SKIP_POINTS) return done('enough');
  if (!d.canGive) return done('no_give');            // sans-give : la chasse reste le SEUL ravitaillement
  // Sous terre la chasse est impossible (pas de passifs à Y-58) → filet déterministe anti-mort.
  try { d.give(); out.steps.push('give'); } catch (e) { /* best-effort */ }
  return done('give');
}

/**
 * huntCookGoal : chasse → cuisson → pêche, borné. UNE vague par défaut.
 *
 * deps : { token, inventory():carte, passiveInView():bool,
 *          hunt({count,token,ms,cancel}):Promise<{ok,kills}>,
 *          rawStacks():[{name,out,count}] (le plus abondant d'abord), hasFurnace():bool,
 *          cook({name,out,count,maxMs}):Promise<nombre>,
 *          hasRod():bool, fish({ms,token,cancel}):Promise<{ok,caught,reason}>,
 *          emit(e):void, now?():ms }
 * opts : { budget?, budgetMs?, waves=1, huntMs=45000, goalPoints? }
 * → { ok:true, got:points } | { ok:false, reason:'cancelled' | 'no_prey:<pourquoi>' }
 *
 * `target` garde son sens historique (« pièces de viande voulues ») et se convertit en points :
 * 4 → 12 (le seuil du kit), 6 → 18 (≈ celui d'ensureFood). Un GAIN de points est un succès, même
 * sous le but : une chasse qui rapporte nourrit, et le planner / le timer re-décident ensuite.
 */
async function runHuntCook(d, target, opts = {}) {
  const emit = d.emit || _noop;
  const now = d.now || Date.now;
  const budget = opts.budget || F.createBudget(opts.budgetMs != null ? opts.budgetMs : F.HUNT_COOK_BUDGET_MS, now);
  const waves = opts.waves != null ? opts.waves : 1;
  const huntMs = opts.huntMs != null ? opts.huntMs : F.HUNT_WAVE_MS;
  const goal = opts.goalPoints != null ? opts.goalPoints : Number(target) * F.RAW_PIECE_POINTS;
  const parent = d.token || null;
  const cancelled = () => { try { return !!(parent && parent.cancelled); } catch (e) { return false; } };
  const points = () => F.foodPoints(d.inventory());

  const t0 = now();
  const before = points();
  if (before >= goal) return { ok: true, got: before };          // assez en poche : rien à faire, rien à tracer
  if (cancelled()) return { ok: false, reason: 'cancelled' };

  const stats = { kills: 0, cooked: 0, fished: 0 };
  let why = 'no_passive';             // la raison d'échec la plus précise connue, affinée au fil des phases
  // Sortie UNIQUE : toute tentative laisse EXACTEMENT une trace (un échec silencieux finit toujours
  // par cacher un bug pendant des runs — #55a) et mesure ce qu'elle a coûté.
  const finish = (res) => {
    emit({
      type: 'hunt_cook_done', before, after: points(), goal, took_ms: now() - t0,
      kills: stats.kills, cooked: stats.cooked, fished: stats.fished,
      ok: !!res.ok, reason: res.reason || null,
    });
    return res;
  };

  // 1) CHASSE — une vague, SEULEMENT si une proie est EN VUE. Le jeton dérivé s'arrête tout seul dès
  //    que le but est atteint (huntPassive le relit à chaque proie) et est coupé à la fin de la vague :
  //    rien ne court en fond après nous.
  for (let wave = 0; wave < waves; wave++) {
    if (cancelled()) return finish({ ok: false, reason: 'cancelled' });
    if (points() >= goal) break;
    if (budget.left() < F.MIN_PHASE_MS) { why = 'no_time'; break; }
    if (!safe(d.passiveInView, false)) break;                   // illisible → pas de proie : on ne part pas à l'aveugle
    why = 'no_gain';
    const ctl = F.boundedToken(parent, () => points() >= goal);
    let r = null;
    try {
      r = await d.hunt({ count: F.HUNT_MAX_KILLS, token: ctl.token, ms: budget.take(huntMs), cancel: ctl.cancel });
    } catch (e) { r = null; }
    ctl.cancel();
    if (cancelled()) return finish({ ok: false, reason: 'cancelled' });
    if (r && r.kills) stats.kills += r.kills;
    if (!r || !r.ok) { why = 'hunt_failed'; break; }
  }

  // 2) CUISSON — un four EN POCHE, ≥ 2 crus du même type, du temps ET un but pas encore atteint : cuire
  //    est un MOYEN d'y arriver (3 → 8 points la pièce), pas un rituel. Le cru qui atteint déjà le but
  //    se mange tel quel. Le plus abondant d'abord ; le nombre de pièces est rogné par le temps restant.
  {
    let stacks = [];
    try { stacks = d.rawStacks() || []; } catch (e) { stacks = []; }
    for (const st of stacks) {
      if (cancelled()) return finish({ ok: false, reason: 'cancelled' });
      if (points() >= goal) break;
      const plan = F.cookPlan({ raw: st.count, furnace: safe(d.hasFurnace, false), leftMs: budget.left() });
      if (plan.cook <= 0) break;                                   // trié par abondance : les suivants n'iront pas mieux
      try { stats.cooked += Number(await d.cook({ name: st.name, out: st.out, count: plan.cook, maxMs: plan.maxMs })) || 0; }
      catch (e) { break; }
    }
  }

  // 3) PÊCHE — canne en poche, de l'eau à ≤ 16 blocs (vérifié par fishCatch), et le but pas déjà atteint.
  if (!cancelled() && points() < goal) {
    const fp = F.fishPlan({ rod: safe(d.hasRod, false), leftMs: budget.left() });
    if (fp.fish) {
      const ctl = F.boundedToken(parent, () => points() >= goal);
      let fr = null;
      try { fr = await d.fish({ ms: fp.ms, token: ctl.token, cancel: ctl.cancel }); } catch (e) { fr = null; }
      ctl.cancel();
      if (fr && fr.caught) stats.fished += fr.caught;
      if (fr && fr.reason) why = _zoneNeutral(fr.reason);
    }
  }
  if (cancelled()) return finish({ ok: false, reason: 'cancelled' });

  const after = points();
  if (after >= goal || after > before) return finish({ ok: true, got: after });
  return finish({ ok: false, reason: `no_prey:${why}` });
}

// Les raisons d'échec d'un skill alimentent le verdict de ZONE (index.js noteZoneFailure → zone.js
// zoneFailureKind) : tout ce qui contient « water » y compte comme une zone INONDÉE. Or `no_water`,
// côté pêche, dit l'inverse (pas d'eau pour pêcher) — il aurait poussé le bot à migrer pour une zone
// « trop humide » qui ne l'est pas. On le renomme donc avant de le mettre dans la raison.
function _zoneNeutral(reason) {
  return String(reason).replace(/water/gi, 'pond').replace(/flood|drown/gi, 'wet');
}

// Lecture défensive d'une dépendance booléenne : illisible → valeur de repli (côté prudent).
function safe(fn, fallback) {
  try { return typeof fn === 'function' ? !!fn() : fallback; } catch (e) { return fallback; }
}

module.exports = { runEnsureFood, runHuntCook };
