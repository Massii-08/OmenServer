'use strict';
// Exploration de surface autonome (0 LLM). Quand une ressource n'est PAS dans le rayon de scan,
// le bot voyage en ANNEAUX EXPANSIFS de waypoints en re-scannant à chaque point, jusqu'à la trouver
// (ou budget épuisé). findBlock ne voit que les chunks chargés → c'est le déplacement physique qui
// charge le terrain. Humanisé (jitter sur les waypoints ∝ profil) pour ne pas quadriller comme un bot.
// Les réflexes de survie (manger/fuir/défendre) restent gérés ailleurs et tournent en parallèle.

// goals.GoalNear : déplacement vers un point à `range` près. Chargé optionnellement (tests legacy).
let goals;
try { goals = require('mineflayer-pathfinder').goals; } catch (e) { goals = null; }
const { directedTarget, targetKey } = require('../worldMemory');

// Nb de points sur un anneau de rayon r pour garder un espacement d'arc ≤ arcSpacing (recouvrement
// des disques de scan → pas de trou de couverture). Min 4.
function pointsOnRing(r, arcSpacing) {
  return Math.max(4, Math.ceil((2 * Math.PI * r) / arcSpacing));
}

/**
 * Waypoints en anneaux expansifs autour de `origin`, au niveau y de l'origine. Pur & déterministe.
 *  step      : pas radial entre anneaux (déf 80 ; < 2×scanRadius pour recouvrir radialement)
 *  maxRadius : rayon max exploré (déf 256 → garde-fou anti-boucle-infinie)
 *  arcSpacing: espacement cible entre 2 points d'un anneau (déf 100 ; < 2×scanRadius)
 * Les anneaux impairs sont déphasés d'un demi-secteur pour mailler les trous des anneaux pairs.
 */
function nextWaypoints(origin, opts = {}) {
  const step = opts.step || 80;
  const maxRadius = opts.maxRadius || 256;
  const arcSpacing = opts.arcSpacing || 100;
  const ox = origin.x, oy = origin.y, oz = origin.z;
  const wps = [];
  let ring = 0;
  for (let r = step; r <= maxRadius + 1e-9; r += step) {
    ring++;
    const n = pointsOnRing(r, arcSpacing);
    const phase = (ring % 2) * (Math.PI / n);
    for (let k = 0; k < n; k++) {
      const theta = phase + (2 * Math.PI * k) / n;
      wps.push({ x: ox + r * Math.cos(theta), y: oy, z: oz + r * Math.sin(theta), r });
    }
  }
  return wps;
}

function buildNearGoal(x, y, z, range) {
  if (goals && goals.GoalNear) return new goals.GoalNear(x, y, z, range);
  return { x, y, z };
}

// goto borné : pathfinder.goto peut rester gelé INDÉFINIMENT sur une cible inatteignable
// (océan, surplomb) → timeout → setGoal(null) + reject → l'appelant passe à la suite
// (directed → anneaux ; waypoint → waypoint suivant). Le skill ne gèle jamais.
function gotoWithTimeout(bot, goal, ms) {
  if (!(bot.pathfinder && bot.pathfinder.goto)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    let done = false;
    const t = setTimeout(() => {
      if (done) return; done = true;
      try { bot.pathfinder.setGoal && bot.pathfinder.setGoal(null); } catch (e) {}
      reject(new Error('goto_timeout'));
    }, ms);
    bot.pathfinder.goto(goal).then(
      (v) => { if (!done) { done = true; clearTimeout(t); resolve(v); } },
      (e) => { if (!done) { done = true; clearTimeout(t); reject(e); } }
    );
  });
}

/**
 * explore(bot, opts) → {ok:true, found:pos, traveled} | {ok:false, reason:'not_found'|'cancelled'|'no_pos'}
 *  name      : nom du bloc (pour log)            matching : ids findBlock (résolus par l'appelant)
 *  scanRadius: rayon findBlock à chaque waypoint (déf 64)
 *  step/maxRadius : passés à nextWaypoints       profile  : pour movementJitter (sinon bot._mcaProfile)
 *  rng       : injectable (tests)                token    : annulation     emit : hook events (optionnel)
 */
async function explore(bot, opts = {}) {
  const matching = opts.matching !== undefined ? opts.matching : null;
  const scanRadius = opts.scanRadius || 64;
  const step = opts.step || 80;
  const maxRadius = opts.maxRadius || 256;
  const rng = opts.rng || Math.random;
  const token = opts.token || null;
  const emit = opts.emit || null;
  // Bornes des gotos (cf. gotoWithTimeout) : trajet dirigé long (≤1500 blocs) vs hop de waypoint.
  const directedGotoTimeoutMs = opts.directedGotoTimeoutMs || 240000;
  const gotoTimeoutMs = opts.gotoTimeoutMs || 90000;

  const origin = bot.entity && bot.entity.position;
  if (!origin) return { ok: false, reason: 'no_pos' };
  if (token && token.cancelled) return { ok: false, reason: 'cancelled' };

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
  const markExhausted = (t) => {
    if (!exhausted || !t) return;
    exhausted.add(targetKey(t.x, t.z));
    if (emit) { try { emit({ type: 'directed_exhausted', x: Math.round(t.x), z: Math.round(t.z) }); } catch (e) {} }
  };
  let dTarget = null, dTy = origin.y; // hoistés : réutilisés par le RAPPEL dirigé pendant les anneaux
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
    if (target) {
      dTarget = target;
      if (emit) { try { emit({ type: 'explore_directed', x: Math.round(target.x), z: Math.round(target.z), biome: target.biome, learned: !!target.learned, cave: !!target.cave }); } catch (e) {} }
      // y de la cible : une CAVE porte le y de son entrée (GoalNear 3D précis, le pathfinder peut
      // creuser) ; un find/biome n'a que x,z → on garde l'altitude courante.
      const ty = (typeof target.y === 'number') ? target.y : origin.y;
      dTy = ty;
      // Persistance dirigée : un goto peut être interrompu en RAFALE (réflexes flee/surface →
      // GoalChanged, vu live HarvT7 barbotant dans une rivière) → on reprend SA route tant que
      // chaque tentative RAPPROCHE de la cible (>8 blocs), avec 1 retry de grâce sans progrès.
      // Un TIMEOUT (cible gelée/inatteignable 240s) ne mérite pas de 2e chance → anneaux.
      const distTo = (p) => Math.sqrt((p.x - target.x) ** 2 + (p.z - target.z) ** 2);
      let lastD = distTo(origin);
      let attempts = 0;
      while (attempts < 6) {
        attempts++;
        try {
          await gotoWithTimeout(bot, buildNearGoal(target.x, ty, target.z, 8), directedGotoTimeoutMs);
          if (token && token.cancelled) return { ok: false, reason: 'cancelled' };
          const hit = bot.findBlock({ matching, maxDistance: scanRadius });
          if (hit) return { ok: true, found: hit.position, traveled: 0, directed: true };
          markExhausted(target); // arrivé mais rien sur place → cible épuisée, ne plus la proposer
          break; // → anneaux depuis ici
        } catch (e) {
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
  const wps = nextWaypoints({ x: ringOrigin.x, y: ringOrigin.y, z: ringOrigin.z }, { step, maxRadius });
  // RAPPEL dirigé : si le préambule dirigé est mort-né (NoPath transitoire — chunks pas chargés au
  // spawn/tp frais, vu live HarvT9), on RE-TENTE la route dirigée au début de chaque NOUVEL anneau
  // (le bot a bougé → monde chargé) au lieu de ratisser toute la spirale. Borné à 3 rappels.
  let curRing = step, ringRecalls = 3;
  for (const wp of wps) {
    if (token && token.cancelled) return { ok: false, reason: 'cancelled' };
    if (dTarget && wp.r !== curRing) {
      curRing = wp.r;
      if (ringRecalls > 0) {
        ringRecalls--;
        try {
          await gotoWithTimeout(bot, buildNearGoal(dTarget.x, dTy, dTarget.z, 8), directedGotoTimeoutMs);
          if (token && token.cancelled) return { ok: false, reason: 'cancelled' };
          const hit = bot.findBlock({ matching, maxDistance: scanRadius });
          if (hit) return { ok: true, found: hit.position, traveled: 0, directed: true };
          markExhausted(dTarget); // arrivé mais rien sur place → cible épuisée, ne plus la proposer
          ringRecalls = 0; // plus de rappel
        } catch (e) {
          if (e && e.message === 'goto_timeout') ringRecalls = 0; // gelé → on n'insiste plus
        }
      }
    }
    const gx = wp.x + (rng() * 2 - 1) * jitterMax;
    const gz = wp.z + (rng() * 2 - 1) * jitterMax;
    if (emit) { try { emit({ type: 'explore_waypoint', x: Math.round(gx), z: Math.round(gz), r: Math.round(wp.r) }); } catch (e) {} }
    try {
      await gotoWithTimeout(bot, buildNearGoal(gx, wp.y, gz, 8), gotoTimeoutMs);
    } catch (e) { continue; } // waypoint inatteignable ou goto gelé (timeout) → on tente le suivant
    if (token && token.cancelled) return { ok: false, reason: 'cancelled' };
    const block = bot.findBlock({ matching, maxDistance: scanRadius });
    if (block) return { ok: true, found: block.position, traveled: wp.r };
  }
  return { ok: false, reason: 'not_found' };
}

module.exports = { explore, nextWaypoints, pointsOnRing, gotoWithTimeout };
