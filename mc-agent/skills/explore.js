'use strict';
// Exploration de surface autonome (0 LLM). Quand une ressource n'est PAS dans le rayon de scan,
// le bot voyage en ANNEAUX EXPANSIFS de waypoints en re-scannant à chaque point, jusqu'à la trouver
// (ou budget épuisé). findBlock ne voit que les chunks chargés → c'est le déplacement physique qui
// charge le terrain. Humanisé (jitter sur les waypoints ∝ profil) pour ne pas quadriller comme un bot.
// Les réflexes de survie (manger/fuir/défendre) restent gérés ailleurs et tournent en parallèle.
// Les waypoints sont des buts XZ (altitude inconnue → jamais inventée) et un bot ENFERMÉ (échecs de goto
// instantanés sur place, d'affilée) sort en `stuck` au lieu de « parcourir » toute la spirale sur place.

// goals.GoalNear / GoalNearXZ : déplacement vers un point à `range` près. Chargé optionnellement (tests legacy).
let goals;
try { goals = require('mineflayer-pathfinder').goals; } catch (e) { goals = null; }
const { directedTarget, targetKey } = require('../worldMemory');

// Anti-emballement : un goto rejeté INSTANTANÉMENT sans que le bot ait bougé n'est pas « une route
// difficile », c'est un bot enfermé/coincé. STUCK_AFTER échecs de ce type d'affilée → on abandonne la spirale.
const STUCK_AFTER = 6;        // échecs instantanés consécutifs avant de renoncer
const INSTANT_FAIL_MS = 1500; // « instantané » = rejet du pathfinder en < 1,5 s (mesuré world_ax5 : ≈ 0,3 s)
const STUCK_MOVE_EPS = 2;     // …ET déplacement horizontal < 2 blocs depuis la tentative précédente

// Nb de points sur un anneau de rayon r pour garder un espacement d'arc ≤ arcSpacing (recouvrement
// des disques de scan → pas de trou de couverture). Min 4.
function pointsOnRing(r, arcSpacing) {
  return Math.max(4, Math.ceil((2 * Math.PI * r) / arcSpacing));
}

/**
 * Waypoints en anneaux expansifs autour de `origin`, au niveau y de l'origine. Pur & déterministe.
 * (Le y est INFORMATIF : explore() vise ces points en but XZ, l'altitude réelle de la surface y est inconnue.)
 *  step      : pas radial entre anneaux (déf 80 ; < 2×scanRadius pour recouvrir radialement)
 *  maxRadius : rayon max exploré (déf 256 → garde-fou anti-boucle-infinie)
 *  arcSpacing: espacement cible entre 2 points d'un anneau (déf 100 ; < 2×scanRadius)
 * Les anneaux impairs sont déphasés d'un demi-secteur pour mailler les trous des anneaux pairs.
 */
function nextWaypoints(origin, opts = {}) {
  const step = opts.step || 80;
  const maxRadius = opts.maxRadius || 256;
  const arcSpacing = opts.arcSpacing || 100;
  // BORNE CONFINE (anti-drift NE, piège #54) : {x,z,radius} = poche sèche autour de l'ancre. La
  // spirale reste centrée sur la position COURANTE (origin), mais tout point qui sort de la poche
  // est jeté — sinon un worker sous --confine re-dérive à 600+ blocs entre deux enforcements.
  const bounds = opts.bounds || null;
  const ox = origin.x, oy = origin.y, oz = origin.z;
  const wps = [];
  let ring = 0;
  for (let r = step; r <= maxRadius + 1e-9; r += step) {
    ring++;
    const n = pointsOnRing(r, arcSpacing);
    const phase = (ring % 2) * (Math.PI / n);
    for (let k = 0; k < n; k++) {
      const theta = phase + (2 * Math.PI * k) / n;
      const x = ox + r * Math.cos(theta), z = oz + r * Math.sin(theta);
      if (bounds && Math.hypot(x - bounds.x, z - bounds.z) > bounds.radius) continue;  // hors poche → jeté
      wps.push({ x, y: oy, z, r });
    }
  }
  return wps;
}

function buildNearGoal(x, y, z, range) {
  if (goals && goals.GoalNear) return new goals.GoalNear(x, y, z, range);
  return { x, y, z };
}

// But XZ : x,z à `range` près, altitude LIBRE (GoalNearXZ ne contraint pas y). Les waypoints d'anneau et
// les cibles dirigées find/biome n'ont AUCUNE altitude connue : y planter celle du bot (GoalNear 3D)
// donnait, sur terrain vallonné, une sphère en l'air ou dans la roche → NoPath en 0,3 s à CHAQUE waypoint
// (world_ax5 : 35 waypoints « parcourus » en 10 s, bot immobile, `logs not_found` 84-94 %). Même cause que
// la jambe de migration (GoalNear(leg.x, yRef, leg.z) : moved:0 en 24 jambes), même remède.
function buildNearXZGoal(x, z, range) {
  if (goals && goals.GoalNearXZ) return new goals.GoalNearXZ(x, z, range);
  return { x, z };
}

// But d'une cible DIRIGÉE : une CAVE porte le y de son entrée → GoalNear 3D précis (le pathfinder doit
// pouvoir y descendre) ; un find/biome n'a que x,z → but XZ (jamais d'altitude inventée).
function buildDirectedGoal(target, range) {
  if (typeof target.y === 'number') return buildNearGoal(target.x, target.y, target.z, range);
  return buildNearXZGoal(target.x, target.z, range);
}

// goto borné : pathfinder.goto peut rester gelé INDÉFINIMENT sur une cible inatteignable
// (océan, surplomb) → timeout → setGoal(null) + reject → l'appelant passe à la suite
// (directed → anneaux ; waypoint → waypoint suivant). Le skill ne gèle jamais.
// `abortIf` (optionnel, run 10 20/10) : relu toutes les ABORT_POLL_MS pendant le trajet ; vrai → on coupe
// le pathfinder et on rejette 'goto_danger'. C'est ce qui permet d'INTERROMPRE une marche de 90 s vers un
// waypoint lointain quand un hostile surgit à côté d'un bot nu (63 % des morts du run 10 pendant `logs`,
// dont 43 sur 71 au 3e anneau d'exploration) au lieu de la finir sous les flèches. Un prédicat qui lève
// vaut « non » (on ne coupe pas un trajet sur une erreur de lecture).
const ABORT_POLL_MS = 500;
function gotoWithTimeout(bot, goal, ms, abortIf = null) {
  if (!(bot.pathfinder && bot.pathfinder.goto)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    let done = false;
    let poll = null;
    const finish = () => { done = true; clearTimeout(t); if (poll) clearInterval(poll); };
    const t = setTimeout(() => {
      if (done) return; finish();
      try { bot.pathfinder.setGoal && bot.pathfinder.setGoal(null); } catch (e) {}
      reject(new Error('goto_timeout'));
    }, ms);
    if (typeof abortIf === 'function') {
      poll = setInterval(() => {
        if (done) return;
        let stop = false;
        try { stop = !!abortIf(); } catch (e) { stop = false; }
        if (!stop) return;
        finish();
        try { bot.pathfinder.setGoal && bot.pathfinder.setGoal(null); } catch (e) {}
        reject(new Error('goto_danger'));
      }, ABORT_POLL_MS);
    }
    bot.pathfinder.goto(goal).then(
      (v) => { if (!done) { finish(); resolve(v); } },
      (e) => { if (!done) { finish(); reject(e); } }
    );
  });
}

/**
 * explore(bot, opts) → {ok:true, found:pos, traveled} | {ok:false, reason:'not_found'|'cancelled'|'no_pos', stuck?:true}
 *  name      : nom du bloc (pour log)            matching : ids findBlock (résolus par l'appelant)
 *  scanRadius: rayon findBlock à chaque waypoint (déf 64)
 *  step/maxRadius : passés à nextWaypoints       profile  : pour movementJitter (sinon bot._mcaProfile)
 *  rng       : injectable (tests)                token    : annulation     emit : hook events (optionnel)
 *  now       : horloge injectable (tests) — mesure la durée d'un rejet de goto (détection `stuck`)
 *
 * `stuck:true` (avec reason 'not_found') : STUCK_AFTER (6) gotos de waypoint rejetés INSTANTANÉMENT
 * (< 1,5 s) SANS que le bot ait bougé (< 2 blocs) d'affilée → il est enfermé/coincé ; creuser ou fuir n'est
 * pas le rôle d'explore, mais on n'« explore » plus la carte sur place. La cible dirigée n'est alors PAS
 * marquée épuisée (jamais approchée). Un rejet LENT (le pathfinder a cherché) ou un timeout ne compte pas.
 * Events : explore_directed / explore_waypoint / directed_exhausted (inchangés) + UN `explore_summary`
 * { waypoints, reached, failedFast, stuck, lastError } en fin d'appel (pas si rien n'a été tenté).
 */
async function explore(bot, opts = {}) {
  const origin = bot.entity && bot.entity.position;
  if (!origin) return { ok: false, reason: 'no_pos' };
  const token = opts.token || null;
  if (token && token.cancelled) return { ok: false, reason: 'cancelled' };

  // Compteurs du bilan : remplis par exploreRun, publiés UNE fois quelle que soit la sortie (trouvé,
  // épuisé, stuck, annulé, même exception) — c'est ce qui rend « 35 waypoints sur place » visible.
  const stats = { waypoints: 0, reached: 0, failedFast: 0, stuck: false, lastError: null };
  try {
    return await exploreRun(bot, opts, origin, stats);
  } finally {
    if (opts.emit) {
      try {
        opts.emit({
          type: 'explore_summary', waypoints: stats.waypoints, reached: stats.reached,
          failedFast: stats.failedFast, stuck: stats.stuck, lastError: stats.lastError,
        });
      } catch (e) { /* best-effort */ }
    }
  }
}

async function exploreRun(bot, opts, origin, stats) {
  const matching = opts.matching !== undefined ? opts.matching : null;
  const scanRadius = opts.scanRadius || 64;
  const step = opts.step || 80;
  const maxRadius = opts.maxRadius || 256;
  const rng = opts.rng || Math.random;
  const token = opts.token || null;
  const emit = opts.emit || null;
  const now = opts.now || Date.now;
  // DANGER (run 10, 20/10) : `opts.danger()` vrai = un bot nu a un hostile à portée → on arrête d'explorer
  // TOUT DE SUITE (avant chaque trajet ET pendant, via gotoWithTimeout/abortIf) et on rend
  // {ok:false, reason:'danger'} : l'appelant s'abrite puis reprend. Jamais de markExhausted sur ce motif
  // (la cible n'a rien prouvé, c'est le bot qui a dû reculer). Absent → comportement d'origine.
  const dangerFn = typeof opts.danger === 'function' ? opts.danger : null;
  const inDanger = () => { if (!dangerFn) return false; try { return !!dangerFn(); } catch (e) { return false; } };
  const isDangerErr = (e) => !!(e && e.message === 'goto_danger');
  const DANGER = { ok: false, reason: 'danger' };
  // Bornes des gotos (cf. gotoWithTimeout) : trajet dirigé long (≤1500 blocs) vs hop de waypoint.
  const directedGotoTimeoutMs = opts.directedGotoTimeoutMs || 240000;
  const gotoTimeoutMs = opts.gotoTimeoutMs || 90000;
  // Dernière erreur de goto (message tronqué à 60) — alimente `lastError` du bilan.
  const noteError = (e) => { stats.lastError = String((e && (e.message || e.name)) || e || 'error').slice(0, 60); };

  const prof = opts.profile || bot._mcaProfile || null;
  // Jitter d'humanisation SEULEMENT en mode furtif (phase 3) : un bot utilitaire vise les
  // waypoints exacts (trajet direct). opts.stealth prime ; sinon bot._mcaStealth (posé au spawn).
  const stealth = opts.stealth !== undefined ? !!opts.stealth : !!bot._mcaStealth;
  const mj = stealth ? ((prof && prof.params && prof.params.movementJitter) || 0.1) : 0;
  const jitterMax = step * 0.15 * mj; // petit décalage humain, bien < marge de recouvrement

  // BIAIS DIRIGÉ : si la mémoire de monde du groupe sait où trouver `name`, on y va D'ABORD
  // (associations apprises sinon amorce vanilla) → un bot frais file au bon biome au lieu de chercher
  // à l'aveugle. Lu via bot._worldMemory/_worldKey (posés par index.js au spawn) ou via opts (tests).
  const memory = opts.memory || bot._worldMemory || null;
  const wkey = opts.worldKey || bot._worldKey || null;
  // Cibles épuisées (RC4) : Set session posé par index.js au spawn (bot._mcaExhausted). Une cible
  // dirigée sur laquelle on est ARRIVÉ sans rien trouver y entre → plus jamais re-proposée par
  // directedTarget (fin de la boucle explore_directed ×48 sur la même prairie pelée, vécu NethBot1).
  const exhausted = opts.exhausted || bot._mcaExhausted || null;
  // BORNE CONFINE (piège #54, drift NE) : un worker sous --confine ne doit explorer QUE sa poche
  // sèche (centre = ancre). Sans elle, la spirale part de la position courante jusqu'à maxRadius et,
  // re-dérivée à chaque échec `logs`, pousse le centre toujours plus loin — vécu NethBot5 world_mn9 :
  // warpé à l'ancre par l'enforcement (dist 136) puis re-dérivé à 607 blocs en < 2 min. On jette les
  // waypoints ET la cible dirigée hors poche. Mappeurs = pas de confine → bounds null → inchangé.
  const bounds = opts.bounds || bot._mcaExploreBounds || null;
  const inBounds = (x, z) => !bounds || Math.hypot(x - bounds.x, z - bounds.z) <= bounds.radius;
  const markExhausted = (t) => {
    if (!exhausted || !t) return;
    const k = targetKey(t.x, t.z);
    if (exhausted.has(k)) return;                    // idempotent : pas de double event
    exhausted.add(k);
    if (emit) { try { emit({ type: 'directed_exhausted', world: wkey || null, x: Math.round(t.x), z: Math.round(t.z) }); } catch (e) {} }
  };
  let dTarget = null; // hoisté : réutilisé par le RAPPEL dirigé pendant les anneaux
  if (memory && wkey) {
    const mats = Array.isArray(opts.name) ? opts.name : (opts.name ? [opts.name] : []);
    // Cible la + PROCHE tous matériaux confondus (un birch_log à 100 blocs bat un oak_log à 1400).
    let target = null, targetD = Infinity;
    for (const mat of mats) {
      const t = directedTarget(memory, wkey, mat, origin, { maxDist: opts.directedMaxDist || 1500, exclude: exhausted });
      if (!t) continue;
      const d = Math.sqrt((t.x - origin.x) ** 2 + (t.z - origin.z) ** 2);
      if (d < targetD) { target = t; targetD = d; }
    }
    if (target && !inBounds(target.x, target.z)) target = null;  // cible dirigée hors poche confine → on ne marche pas jusqu'à elle
    if (target) {
      dTarget = target;
      if (emit) { try { emit({ type: 'explore_directed', x: Math.round(target.x), z: Math.round(target.z), biome: target.biome, learned: !!target.learned, cave: !!target.cave }); } catch (e) {} }
      // Cible LOINTAINE (>300) : le caller a une chance de raccourcir le trajet AVANT la marche
      // (/tpa vers un mappeur proche de la cible — TP-au-mappeur). Best-effort : le hook peut
      // téléporter le bot (le goto dirigé et la persistance repartent de la nouvelle position).
      const beforeLongTrip = opts.beforeLongTrip || bot._mcaBeforeLongTrip || null;
      if (beforeLongTrip) {
        const dSelf = Math.sqrt((target.x - origin.x) ** 2 + (target.z - origin.z) ** 2);
        if (dSelf > (opts.longTripDist || 300)) {
          try { await beforeLongTrip({ x: target.x, z: target.z }); } catch (e) { /* best-effort */ }
        }
      }
      // But : une CAVE porte le y de son entrée (GoalNear 3D précis, le pathfinder peut creuser) ; un
      // find/biome n'a que x,z → but XZ, SANS y inventé (buildDirectedGoal).
      // Persistance dirigée : un goto peut être interrompu en RAFALE (réflexes flee/surface →
      // GoalChanged, vu live HarvT7 barbotant dans une rivière) → on reprend SA route tant que
      // chaque tentative RAPPROCHE de la cible (>8 blocs), avec 1 retry de grâce sans progrès.
      // Un TIMEOUT (cible gelée/inatteignable 240s) ne mérite pas de 2e chance → anneaux.
      const distTo = (p) => Math.sqrt((p.x - target.x) ** 2 + (p.z - target.z) ** 2);
      let lastD = distTo(origin);
      let attempts = 0;
      while (attempts < 6) {
        attempts++;
        if (inDanger()) return DANGER;
        try {
          await gotoWithTimeout(bot, buildDirectedGoal(target, 8), directedGotoTimeoutMs, dangerFn);
          if (token && token.cancelled) return { ok: false, reason: 'cancelled' };
          const hit = bot.findBlock({ matching, maxDistance: scanRadius });
          if (hit) return { ok: true, found: hit.position, traveled: 0, directed: true };
          markExhausted(target); // arrivé mais rien sur place → cible épuisée, ne plus la proposer
          break; // → anneaux depuis ici
        } catch (e) {
          noteError(e);
          if (isDangerErr(e)) return DANGER;
          if (e && e.message === 'goto_timeout') break; // gelé → anneaux
          if (token && token.cancelled) return { ok: false, reason: 'cancelled' };
          const cur = (bot.entity && bot.entity.position) || origin;
          const d = distTo(cur);
          if (d < lastD - 8) { lastD = d; continue; } // on s'est rapproché → persiste
          if (attempts >= 2) break;                   // 2 tentatives sans progrès → anneaux
          // Rejet sans progrès (souvent NoPath TRANSITOIRE : chunks pas encore chargés autour d'un
          // bot frais/tp, vu live HarvT8) → petite grâce avant l'unique retry.
          const grace = opts.directedRetryDelayMs !== undefined ? opts.directedRetryDelayMs : 4000;
          if (grace) await new Promise((r) => setTimeout(r, grace));
        }
      }
    }
  }

  // Anneaux centrés sur la position COURANTE (≠ origin) : après un trajet dirigé vers une cible
  // épuisée, on ratisse AUTOUR du gisement appris (bon prior local) au lieu de retraverser la carte.
  const ringOrigin = (bot.entity && bot.entity.position) || origin;
  const wps = nextWaypoints({ x: ringOrigin.x, y: ringOrigin.y, z: ringOrigin.z }, { step, maxRadius, bounds });
  // RAPPEL dirigé : si le préambule dirigé est mort-né (NoPath transitoire — chunks pas chargés au
  // spawn/tp frais, vu live HarvT9), on RE-TENTE la route dirigée au début de chaque NOUVEL anneau
  // (le bot a bougé → monde chargé) au lieu de ratisser toute la spirale. Borné à 3 rappels.
  let curRing = step, ringRecalls = 3;
  let instantStreak = 0; // échecs de goto INSTANTANÉS et sur place, consécutifs (cf. STUCK_AFTER)
  for (const wp of wps) {
    if (token && token.cancelled) return { ok: false, reason: 'cancelled' };
    if (dTarget && wp.r !== curRing) {
      curRing = wp.r;
      if (ringRecalls > 0) {
        ringRecalls--;
        if (inDanger()) return DANGER;
        try {
          await gotoWithTimeout(bot, buildDirectedGoal(dTarget, 8), directedGotoTimeoutMs, dangerFn);
          if (token && token.cancelled) return { ok: false, reason: 'cancelled' };
          const hit = bot.findBlock({ matching, maxDistance: scanRadius });
          if (hit) return { ok: true, found: hit.position, traveled: 0, directed: true };
          markExhausted(dTarget); // arrivé mais rien sur place → cible épuisée, ne plus la proposer
          ringRecalls = 0; // plus de rappel
        } catch (e) {
          noteError(e);
          if (isDangerErr(e)) return DANGER;
          if (e && e.message === 'goto_timeout') ringRecalls = 0; // gelé → on n'insiste plus
        }
      }
    }
    if (inDanger()) return DANGER;
    const gx = wp.x + (rng() * 2 - 1) * jitterMax;
    const gz = wp.z + (rng() * 2 - 1) * jitterMax;
    if (emit) { try { emit({ type: 'explore_waypoint', x: Math.round(gx), z: Math.round(gz), r: Math.round(wp.r) }); } catch (e) {} }
    stats.waypoints++;
    // Photo AVANT le goto, en NOMBRES (bot.entity.position peut être muté en place par la physique).
    const p0 = bot.entity && bot.entity.position;
    const x0 = p0 ? p0.x : NaN, z0 = p0 ? p0.z : NaN, t0 = now();
    try {
      // But XZ : l'altitude de la surface à ce waypoint est INCONNUE (cf. buildNearXZGoal).
      await gotoWithTimeout(bot, buildNearXZGoal(gx, gz, 8), gotoTimeoutMs, dangerFn);
    } catch (e) {
      if (isDangerErr(e)) { noteError(e); return DANGER; }
      // Waypoint inatteignable ou goto gelé (timeout) → on tente le suivant… sauf si le bot est ENFERMÉ :
      // rejeté en < 1,5 s ET resté sur place (< 2 blocs) STUCK_AFTER fois d'affilée = la spirale entière
      // serait « parcourue » en quelques secondes sans bouger (world_ax5 : 35 waypoints en 10 s). Ne
      // comptent PAS : un timeout (c'est NOTRE minuteur, pas un rejet du pathfinder), un rejet lent (il a
      // cherché) ni un rejet suivi d'un déplacement (chemin partiel) — échecs ordinaires. Position
      // illisible → on ne conclut pas.
      noteError(e);
      const p1 = bot.entity && bot.entity.position;
      const moved = (p1 && Number.isFinite(x0)) ? Math.hypot(p1.x - x0, p1.z - z0) : Infinity;
      const instant = !(e && e.message === 'goto_timeout') && (now() - t0) < INSTANT_FAIL_MS && moved < STUCK_MOVE_EPS;
      if (!instant) { instantStreak = 0; continue; }
      stats.failedFast++;
      if (++instantStreak >= STUCK_AFTER) { stats.stuck = true; break; }
      continue;
    }
    stats.reached++;
    instantStreak = 0;
    if (token && token.cancelled) return { ok: false, reason: 'cancelled' };
    // Waypoint AQUATIQUE (vécu world_ax2 : points d'anneaux en plein lac → le bot nageait, scannait
    // sur place, se noyait — 7-8 water_rescue/bot). Arrivé MOUILLÉ → skip immédiat au suivant,
    // pas de scan (le réflexe anti-noyade gère la sortie). Hook injectable pour les tests.
    const inWater = opts.inWater || bot._mcaInWater || null;
    if (inWater) { try { if (inWater(bot)) continue; } catch (e) { /* best-effort */ } }
    const block = bot.findBlock({ matching, maxDistance: scanRadius });
    if (block) return { ok: true, found: block.position, traveled: wp.r };
  }
  // Sortie ENFERMÉ : pas de markExhausted — une cible jamais approchée n'est pas « épuisée » (la marquer
  // bannirait un bon gisement à cause d'un blocage du BOT, pas du terrain).
  if (stats.stuck) return { ok: false, reason: 'not_found', stuck: true };
  // Explore ÉPUISÉ (rien trouvé, ni via la cible dirigée ni dans toute la spirale d'anneaux) : la
  // cible apprise est stérile OU inatteignable (noyée/murée). On la marque même si on n'a jamais
  // « arrivé » dessus (timeout-to-reach, vécu live 15/07 : boucle logs not_found sur la même cible)
  // → directedTarget en proposera une AUTRE au prochain appel (fin du churn).
  markExhausted(dTarget);
  return { ok: false, reason: 'not_found' };
}

module.exports = { explore, nextWaypoints, pointsOnRing, gotoWithTimeout };
