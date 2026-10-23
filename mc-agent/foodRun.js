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
//   runHuntCook    — la chaîne chasse → cuisson → pêche, UNE vague. Un seul trajet lointain, et
//                    seulement à vraie faim : l'EXPÉDITION vers le terrain à animaux (foodTrip.js).
//
// Les deux se partagent UN budget (food.createBudget) : chaque phase reçoit min(son plafond, ce qui
// reste du total). Retiré de la chaîne (trop long pour ce qu'ils rapportent) : le trajet vers l'eau
// connue (jusqu'à 300 s), la chasse à la ficelle (90 s) et les 3 vagues de 120 s. La ficelle vient
// désormais du ramassage opportuniste APRÈS un combat contre une araignée.
const F = require('./food');
const TRIP = require('./foodTrip');
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
 * PÊCHE DURABLE (optionnelle, 22/10) — deps en plus : { canCraftRod():bool, fishSession:true,
 *          spiderInView():bool, stringCount():nombre, health():nombre,
 *          huntString({ms,token,cancel}):Promise } ; `fish` reçoit alors aussi {session, target}.
 * Canne fabricable = canne prête ; ficelle manquante + araignée en vue = ≤ 30 s pour la prendre ;
 * chasse bredouille sans expédition = SÉANCE de pêche de 75 s (food.fishWindow).
 *
 * `target` garde son sens historique (« pièces de viande voulues ») et se convertit en points :
 * 4 → 12 (le seuil du kit), 6 → 18 (≈ celui d'ensureFood). Un GAIN de points est un succès, même
 * sous le but : une chasse qui rapporte nourrit, et le planner / le timer re-décident ensuite.
 *
 * EXPÉDITION (optionnelle, 19/10) — deps en plus : { tripState():{isDay,y,migrating,ordered,busy,tripBusy},
 *          grazingCell():{x,z,biome,dist}|null, tripLock?():bool, tripUnlock?():void,
 *          tripWalk({cell,ms,token,cancel}):Promise<{ok,arrived,legs}>, tripTried?(cell):void }
 * Aucun gibier à ≤ 32 blocs ET vraie faim (< 6 points) ET jour ET surface (foodTrip.shouldFoodTrip) :
 * UNE marche vers la cellule à animaux la plus proche connue (≤ 75 s, hors budget), puis la chasse
 * habituelle sur place avec le budget INTACT. Sans ces deps (ou à la moindre porte fermée) le
 * comportement est strictement celui d'avant.
 */
async function runHuntCook(d, target, opts = {}) {
  const emit = d.emit || _noop;
  const now = d.now || Date.now;
  let budget = opts.budget || F.createBudget(opts.budgetMs != null ? opts.budgetMs : F.HUNT_COOK_BUDGET_MS, now);
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
  let tripReason = null;              // l'expédition : pourquoi on est parti / pourquoi pas (tracé dans le bilan)
  let trip = null;                    // l'expédition EN COURS : { cell, t0, pts0, kills0, locked, closed, arrived, legs }

  // FIN d'expédition — UNE seule fois (idempotente), sur TOUS les chemins de sortie. Relâche le verrou
  // (sinon le confine / le squad ne ramèneraient plus jamais le bot), annonce la fin (chaque
  // `food_trip` a son `food_trip_done`) et, si l'expédition n'a rien rapporté, ÉCARTE la cellule : la
  // même ne sera pas re-visée avant 20 min. Une expédition interrompue (tâche annulée, exception) n'est
  // pas un échec de la cellule : elle reste éligible.
  const closeTrip = (aborted) => {
    const t = trip;
    if (!t || t.closed) return;
    t.closed = true;
    let got = 0;
    try { got = points() - t.pts0; } catch (e) { got = 0; }
    const kills = stats.kills - t.kills0;
    if (t.locked) { try { d.tripUnlock(); } catch (e) { /* best-effort : le verrou ne doit pas masquer la suite */ } }
    const ev = { type: 'food_trip_done', got: Math.max(0, got), took_ms: now() - t.t0, kills, arrived: t.arrived, legs: t.legs };
    if (aborted) ev.aborted = true;
    emit(ev);
    if (!aborted && !(kills > 0 || got > 0) && typeof d.tripTried === 'function') {
      try { d.tripTried(t.cell); } catch (e) { /* best-effort */ }
    }
  };

  // Sortie UNIQUE : toute tentative laisse EXACTEMENT une trace (un échec silencieux finit toujours
  // par cacher un bug pendant des runs — #55a) et mesure ce qu'elle a coûté.
  const finish = (res) => {
    closeTrip(res.reason === 'cancelled');
    const ev = {
      type: 'hunt_cook_done', before, after: points(), goal, took_ms: now() - t0,
      kills: stats.kills, cooked: stats.cooked, fished: stats.fished,
      ok: !!res.ok, reason: res.reason || null,
    };
    if (stats.strings != null) ev.strings = stats.strings;
    if (tripReason) ev.trip = tripReason;   // « pourquoi il n'est pas parti » : sans ça `no_prey:no_passive` reste muet
    emit(ev);
    return res;
  };

  try {
    // 0) EXPÉDITION — aucun gibier à ≤ 32 blocs : la chasse ne partirait pas, et le bot reste à 0 point.
    //    Si la faim est VRAIE (< 6 points), qu'il fait jour et qu'on est en surface (décision pure
    //    foodTrip.shouldFoodTrip), UNE marche vers la cellule à animaux la plus proche CONNUE, puis la
    //    chasse ci-dessous rejoue sur place. La marche a son propre plafond (75 s) : elle n'est PAS
    //    facturée au budget de chasse, qu'on recrée avec ce qu'il restait AVANT de partir.
    //    `afterFail` (23/10) : la chasse vient d'échouer sur une bête VUE mais injoignable (derrière l'eau,
    //    sur une falaise, au fond d'un ravin) — 37 des 42 `hunt_failed` de 6 h avaient un troupeau connu.
    //    La marche ne s'arrête alors PAS sur « gibier en vue » (c'est la bête injoignable qu'on verrait).
    const tryTrip = async (afterFail) => {
      if (!_tripWired(d) || cancelled() || trip) return false;
      if (!afterFail && safe(d.passiveInView, false)) return false;
      let world = {};
      try { world = d.tripState() || {}; } catch (e) { world = {}; }   // monde illisible → heure inconnue → on reste
      const verdict = TRIP.shouldFoodTrip(Object.assign({}, world, {
        points: points(), passiveInView: false, leftMs: budget.left(),
      }));
      tripReason = verdict.reason;
      if (!verdict.go) return false;
      let cell = null;
      try { cell = d.grazingCell() || null; } catch (e) { cell = null; }
      if (!cell) { tripReason = 'no_cell'; return false; }
      if (typeof d.tripLock === 'function' && d.tripLock() === false) { tripReason = 'trip_busy'; return false; }
      tripReason = afterFail ? 'went_after_fail' : 'went';
      trip = {
        cell, t0: now(), pts0: points(), kills0: stats.kills,
        locked: typeof d.tripLock === 'function', closed: false, arrived: false, legs: null,
      };
      emit({
        type: 'food_trip', toX: cell.x, toZ: cell.z, biome: cell.biome,
        dist: Math.round(Number(cell.dist) || 0), points: trip.pts0, ...(afterFail ? { after_fail: true } : {}),
      });
      const leftBefore = budget.left();
      // Le jeton se coupe tout seul dès qu'un gibier est en vue (la marche s'arrête à sa jambe
      // et on chasse) ou que le but est atteint ; il suit aussi la tâche (annulée = on s'arrête).
      const ctl = F.boundedToken(parent, afterFail
        ? () => points() >= goal
        : () => safe(d.passiveInView, false) || points() >= goal);
      let r = null;
      try { r = await d.tripWalk({ cell, ms: TRIP.FOOD_TRIP_MS, token: ctl.token, cancel: ctl.cancel }); } catch (e) { r = null; }
      ctl.cancel();
      trip.arrived = !!(r && r.arrived);
      trip.legs = r && r.legs != null ? r.legs : null;
      budget = F.createBudget(leftBefore, now);
      // (tâche annulée PENDANT la marche : la boucle de chasse ci-dessous s'arrête sur `cancelled()`)
      return true;
    };
    await tryTrip(false);

    // 1) CHASSE — une vague, SEULEMENT si une proie est EN VUE. Le jeton dérivé s'arrête tout seul dès
    //    que le but est atteint (huntPassive le relit à chaque proie) et est coupé à la fin de la vague :
    //    rien ne court en fond après nous.
    let retried = false;
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
      if (!r || !r.ok) {
        why = 'hunt_failed';
        // La cellule de troupeau proche que la chasse n'atteint pas est marquée ratée (20 min) : la marche
        // ci-dessous, la prochaine sortie et la porte de descente visent le SUIVANT.
        if (typeof d.huntFailed === 'function') { try { d.huntFailed(); } catch (e) { /* best-effort */ } }
        // Bête vue mais injoignable : UNE seconde chance, après la marche vers le troupeau connu le plus
        // proche (jamais si une expédition a déjà eu lieu dans cette sortie — un seul trajet lointain).
        if (!retried && await tryTrip(true)) { retried = true; wave--; continue; }
        break;
      }
    }

    // 2) CUISSON — un four EN POCHE, ≥ 2 crus du même type, du temps ET un but pas encore atteint : cuire
    //    est un MOYEN d'y arriver (3 → 8 points la pièce), pas un rituel. Le cru qui atteint déjà le but
    //    se mange tel quel. Le plus abondant d'abord ; le nombre de pièces est rogné par le temps restant.
    //    23/10 (cookMeat.js) : avec la dep `cookLot`, on cuit le LOT comme un joueur — quel que soit le but
    //    en points (le cru l'atteignait déjà 13 fois sur 23 et rien ne cuisait) et HORS du budget de 60 s
    //    (la dep a son propre plafond ~45 s). Elle décide seule (≥ 3 crus, four, combustible hors réserve
    //    du fer) et rend le nombre de pièces cuites.
    if (typeof d.cookLot === 'function') {
      if (cancelled()) return finish({ ok: false, reason: 'cancelled' });
      try { stats.cooked += Number(await d.cookLot({ token: parent })) || 0; } catch (e) { /* best-effort */ }
      if (cancelled()) return finish({ ok: false, reason: 'cancelled' });
    } else {
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

    // 2bis) FICELLE (22/10) — la canne ne manque que de ficelle et une araignée est EN VUE : on la prend
    //    (≤ 30 s, dans le budget). Sans les deps (appelants anciens) : rien ne change. Cf. food.stringHuntPlan.
    const rodReady = () => safe(d.hasRod, false) || safe(d.canCraftRod, false);
    if (!cancelled() && points() < goal && typeof d.huntString === 'function') {
      const sp = F.stringHuntPlan({
        rodReady: rodReady(), string: _num(d.stringCount), spiderInView: safe(d.spiderInView, false),
        hp: _num(d.health), leftMs: budget.left(),
      });
      if (sp.go) {
        const s0 = _num(d.stringCount);
        const ctl = F.boundedToken(parent);
        try { await d.huntString({ ms: budget.take(sp.ms), token: ctl.token, cancel: ctl.cancel }); } catch (e) { /* best-effort */ }
        ctl.cancel();
        stats.strings = Math.max(0, _num(d.stringCount) - s0);
        if (cancelled()) return finish({ ok: false, reason: 'cancelled' });
        if (!rodReady()) why = 'no_string';
      }
    }

    // 3) PÊCHE — canne en poche OU fabricable (fishCatch la fabrique), de l'eau à portée (vérifié par
    //    fishCatch), et le but pas déjà atteint. Sans prise de chasse ni expédition, c'est une SÉANCE de
    //    75 s à 48 blocs (food.fishWindow) : la seule source qui ne s'épuise pas.
    if (!cancelled() && points() < goal) {
      const fw = F.fishWindow({
        rod: rodReady(), leftMs: budget.left(), kills: stats.kills, trip: !!trip, session: d.fishSession === true,
      });
      if (fw.fish) {
        const ctl = F.boundedToken(parent, () => points() >= goal);
        let fr = null;
        const o = { ms: fw.ms, token: ctl.token, cancel: ctl.cancel, session: fw.session };
        if (fw.session) o.target = F.fishTargetFor(goal - points());
        try { fr = await d.fish(o); } catch (e) { fr = null; }
        ctl.cancel();
        if (fr && fr.caught) stats.fished += fr.caught;
        if (fr && fr.reason) why = _zoneNeutral(fr.reason);
      }
    }
    if (cancelled()) return finish({ ok: false, reason: 'cancelled' });

    const after = points();
    if (after >= goal || after > before) return finish({ ok: true, got: after });
    return finish({ ok: false, reason: `no_prey:${why}` });
  } finally {
    // L'expédition se ferme avec la SORTIE (finish) : le verrou couvre donc aussi la cuisson et la pêche —
    // le bot est alors loin de l'ancre, et un /home du confine en plein four abandonnerait le four et ses
    // pièces sur place. Ici, le filet : une exception inattendue relâche le verrou sans accuser la cellule
    // (no-op si `finish` a déjà fermé l'expédition).
    closeTrip(true);
  }
}

// Les raisons d'échec d'un skill alimentent le verdict de ZONE (index.js noteZoneFailure → zone.js
// zoneFailureKind) : tout ce qui contient « water » y compte comme une zone INONDÉE. Or `no_water`,
// côté pêche, dit l'inverse (pas d'eau pour pêcher) — il aurait poussé le bot à migrer pour une zone
// « trop humide » qui ne l'est pas. On le renomme donc avant de le mettre dans la raison.
function _zoneNeutral(reason) {
  return String(reason).replace(/water/gi, 'pond').replace(/flood|drown/gi, 'wet');
}

// Lecture défensive d'une dépendance numérique : illisible → 0.
function _num(fn) {
  try { const n = typeof fn === 'function' ? Number(fn()) : NaN; return Number.isFinite(n) ? n : 0; } catch (e) { return 0; }
}

// Lecture défensive d'une dépendance booléenne : illisible → valeur de repli (côté prudent).
function safe(fn, fallback) {
  try { return typeof fn === 'function' ? !!fn() : fallback; } catch (e) { return fallback; }
}

// L'expédition n'existe que si ses TROIS dépendances obligatoires sont câblées (état du monde, cellule,
// marche) : un câblage partiel — tests anciens, appelant qui n'en veut pas — retombe sur le
// comportement d'avant, sans exception. Le verrou et la mémoire des cellules ratées sont optionnels.
function _tripWired(d) {
  return typeof d.tripState === 'function' && typeof d.grazingCell === 'function' && typeof d.tripWalk === 'function';
}

/**
 * PUR (23/10) — la sortie nourriture du TIMER doit-elle préempter le planner ?
 * Mesure : 36 des 42 `hunt_failed` de 6 h montrent la marche vers la bête annulée par un autre goto
 * (collectBlock, branchMine, descendDiagonal, ramassage de minerai…) — le planner continuait de miner EN
 * PARALLÈLE de la chasse (le pathfinder n'a qu'UN but ; même classe que la migration, piège #72a).
 * s = { active, inProgress, migrating, switching, huntBusy } → bool
 * Seulement quand c'est LE PLANNER qui a la main (jamais par-dessus un ordre direct, une migration, une
 * bascule de rôle) et qu'aucune chasse n'est déjà en vol (le hook de descente chasse DANS le planner).
 */
function foodRunPreempt(s = {}) {
  if (!s || s.active !== 'autonomous') return false;
  if (!s.inProgress) return false;
  if (s.migrating || s.switching) return false;
  if (s.huntBusy) return false;
  return true;
}

module.exports = { runEnsureFood, runHuntCook, foodRunPreempt };
