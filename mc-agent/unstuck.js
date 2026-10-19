'use strict';
// Anti-stuck EAU (#1 retours live Massii) : le bot se coince dans un angle en nageant (le pathfinder
// rame en eau). Détection (isInWater) + manœuvre d'évasion : nager vers la SURFACE (jump) puis
// rejoindre la TERRE FERME la plus proche (bloc solide, 2 airs au-dessus, hors eau). Borné dans le
// temps (jamais de boucle infinie) ; chaque goto interne est lui-même bordé.
let pfGoals; try { pfGoals = require('mineflayer-pathfinder').goals; } catch (e) { pfGoals = null; }
// H6 : pillarUp pour ÉMERGER d'une grotte/ravin inondé (bot sur le sol, eau au-dessus → pose des blocs
// sous ses pieds pour remonter à l'air) quand AUCUNE terre n'est en vue — au lieu de nager indéfiniment
// et se noyer (vécu live : 9-14 noyades/35 min). No-op si flottant (pas de support sous les pieds).
let _pillarUp; try { _pillarUp = require('./skills/pillarUp').pillarUp; } catch (e) { _pillarUp = null; }

const WATER = new Set(['water', 'flowing_water', 'seagrass', 'tall_seagrass', 'kelp', 'kelp_plant', 'bubble_column']);

/** Le bot est-il dans l'eau ? (flag mineflayer, fallback bloc aux pieds) */
function isInWater(bot) {
  if (bot && bot.entity && bot.entity.isInWater !== undefined && bot.entity.isInWater !== null) {
    return !!bot.entity.isInWater;
  }
  try {
    const p = bot.entity.position;
    const b = bot.blockAt(p.floored ? p.floored() : p);
    return !!(b && WATER.has(b.name));
  } catch (e) { return false; }
}

/**
 * Bloc de TERRE FERME le plus proche : solide, non-eau, 2 cases d'air au-dessus (le bot peut s'y
 * tenir), pas le fond de l'océan (y pas trop sous le bot). null si rien en vue (chunks chargés only).
 */
function findLandTarget(bot, maxDistance = 48) {
  if (!bot || typeof bot.findBlocks !== 'function') return null;
  let posns = [];
  try {
    posns = bot.findBlocks({
      matching: (b) => !!(b && b.boundingBox === 'block' && !WATER.has(b.name)),
      maxDistance,
      count: 200,
    }) || [];
  } catch (e) { return null; }
  const self = bot.entity.position;
  const open = (b) => !!(b && !WATER.has(b.name) && (b.name === 'air' || b.boundingBox === 'empty'));
  let best = null, bestD = Infinity;
  for (const p of posns) {
    if (p.y < self.y - 6) continue;                       // fond marin : pas une sortie
    if (!open(bot.blockAt(p.offset(0, 1, 0)))) continue;  // case du corps
    if (!open(bot.blockAt(p.offset(0, 2, 0)))) continue;  // case de la tête
    const d = p.distanceTo(self);
    if (d < bestD) { bestD = d; best = p; }
  }
  return best;
}

function _withTimeout(promise, ms, onTimeout) {
  return new Promise((resolve) => {
    let done = false;
    const t = setTimeout(() => { if (!done) { done = true; try { onTimeout && onTimeout(); } catch (e) {} resolve(null); } }, ms);
    Promise.resolve(promise)
      .then((r) => { if (!done) { done = true; clearTimeout(t); resolve(r); } })
      .catch(() => { if (!done) { done = true; clearTimeout(t); resolve(null); } });
  });
}

/**
 * Manœuvre d'évasion : surface (jump) → terre ferme la plus proche. Bornée (timeoutMs, déf 30s).
 * Retourne {ok} (ok=true si plus dans l'eau à la fin). Injectables : sleep, emit, goto (tests).
 */
async function escapeWater(bot, opts = {}) {
  const emit = opts.emit || (() => {});
  const sleep = opts.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const timeoutMs = opts.timeoutMs || 60000;  // 60s : traverser un plan d'eau prend du temps (Surv7)
  const t0 = Date.now();
  emit({ type: 'unstuck', cause: 'water' });
  const doGoto = opts.goto || (async (p) => {
    if (!pfGoals || !bot.pathfinder || !bot.pathfinder.goto) return;
    await bot.pathfinder.goto(new pfGoals.GoalNear(p.x, p.y + 1, p.z, 1));
  });
  try { bot.setControlState('jump', true); } catch (e) {}   // nage vers la surface
  // cap de nage FIXE quand aucune terre n'est en vue (vécu Surv7 : fond d'un trou inondé, 25 échecs
  // en re-scannant sur place) — on nage AVEC PERSISTANCE dans une direction en re-scannant la terre.
  let swimYaw = null;
  let noLand = 0;
  while (isInWater(bot) && Date.now() - t0 < timeoutMs) {
    const land = findLandTarget(bot, opts.maxDistance || 48);
    if (land) {
      noLand = 0;
      await _withTimeout(doGoto(land), opts.gotoTimeoutMs || 15000, () => {
        try { bot.pathfinder && bot.pathfinder.setGoal(null); } catch (e) {}
      });
    } else {
      // pas de terre en vue : nage persistante au cap fixe (jump maintenu = surface), 3s par segment
      if (swimYaw == null) swimYaw = (bot.entity && bot.entity.yaw) || 0;
      try { if (bot.look) await bot.look(swimYaw, 0, true); } catch (e) {}
      try { bot.setControlState('forward', true); } catch (e) {}
      await sleep(3000);
      try { bot.setControlState('forward', false); } catch (e) {}
      noLand++;
      // H6 : 2 segments sans terre, toujours noyé → PILLAR UP pour ÉMERGER (grotte/ravin inondé). Le
      // bot sur le sol pose des blocs sous lui pour remonter à l'air. No-op si flottant (no_support).
      if (_pillarUp && noLand >= 2 && isInWater(bot)) {
        try { bot.setControlState('jump', false); } catch (e) {}
        try { await _pillarUp(bot, { height: opts.pillarHeight || 6 }, null, { sleep }); } catch (e) {}
        try { if (isInWater(bot)) bot.setControlState('jump', true); } catch (e) {}
        noLand = 0;
      }
    }
    await sleep(300);
  }
  try { bot.setControlState('jump', false); bot.setControlState('forward', false); } catch (e) {}
  const ok = !isInWater(bot);
  emit({ type: 'unstuck_done', cause: 'water', ok });
  return { ok };
}

// --- #9 retours live : LIANES & pièges traversables (le pathfinder s'y accroche) -----------------
// Blocs-pièges cassables à mains nues (instantané ou quasi) : on les dégage au lieu de pousser dessus.
const SNARES = new Set([
  'vine', 'cave_vines', 'cave_vines_plant', 'twisting_vines', 'twisting_vines_plant',
  'weeping_vines', 'weeping_vines_plant', 'glow_lichen', 'cobweb', 'sweet_berry_bush',
  // STALACTITES (Massii 2026-07-26 : « ils ont toujours des difficultés à passer / à ne pas se
  // bloquer dans d'autres blocs, surtout les stalactites »). Le pointed_dripstone a une boîte de
  // collision partielle que le pathfinder juge franchissable, alors qu'elle bloque le pas — et il
  // BLESSE (1 mort « skewered by a falling stalactite » mesurée sur ce run). Cassable à la main.
  'pointed_dripstone',
]);

/**
 * Casse les lianes/toiles ADJACENTES (pieds, tête, 4 voisins × 2 niveaux). Best-effort, rapide,
 * no-op si rien. Retourne le nb de blocs dégagés.
 */
async function clearSnares(bot) {
  if (!bot || typeof bot.blockAt !== 'function' || typeof bot.dig !== 'function') return 0;
  const p = bot.entity && bot.entity.position;
  if (!p) return 0;
  const feet = p.floored ? p.floored() : { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) };
  const at = (dx, dy, dz) => (feet.offset ? feet.offset(dx, dy, dz) : { x: feet.x + dx, y: feet.y + dy, z: feet.z + dz });
  const cells = [at(0, 0, 0), at(0, 1, 0)];
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    cells.push(at(dx, 0, dz), at(dx, 1, dz));
  }
  let cleared = 0;
  for (const c of cells) {
    try {
      const b = bot.blockAt(c);
      if (b && SNARES.has(b.name)) { await bot.dig(b); cleared++; }
    } catch (e) { /* best-effort */ }
  }
  return cleared;
}

// --- #8 retours live : FLOTTANT/SUSPENDU hors saut = état physiquement implausible ----------------

/**
 * PUR : le bot est-il « coincé en l'air » ? (pas au sol, pas dans l'eau, position horizontale
 * quasi inchangée entre 2 échantillons espacés d'au moins minMs). samples = {x,z,t}.
 */
function isFloatingStuck(prev, cur, { onGround, inWater, vy, groundBelow, minMs = 1500, eps = 0.35, maxVy = 0.12 } = {}) {
  if (onGround || inWater || !prev || !cur) return false;
  // FAUX POSITIF terre (vécu live world_dry_a/plains) : un bot immobile sur terrain solide peut avoir
  // bot.entity.onGround=FALSE par flakiness physique mineflayer → l'ancienne détection croyait au
  // flottement → recoverFloating attend onGround (jamais atteint, rien à récupérer) → ok:false en BOUCLE
  // → 0 minage, 2/3 des ResBots paralysés. Si un BLOC SOLIDE est juste sous les pieds, le bot N'EST PAS
  // en l'air → on supprime le faux positif (le call-site calcule groundBelow via bot.blockAt).
  if (groundBelow === true) return false;
  // En train de TOMBER ou de MONTER (saut/chute/pilier en cours) ≠ coincé : un bot réellement
  // coincé-flottant a une vélocité verticale ≈ 0. Garde optionnelle (rétro-compat si vy absent).
  if (vy != null && Math.abs(vy) > maxVy) return false;
  if (cur.t - prev.t < minMs) return false;
  const d = Math.sqrt((cur.x - prev.x) ** 2 + (cur.z - prev.z) ** 2);
  return d < eps;
}

/**
 * Recovery #8 : RELÂCHER TOUT (clearControlStates), couper le pathfinder, laisser retomber au sol.
 * Borné. Retourne {ok} (ok = au sol à la fin).
 */
async function recoverFloating(bot, opts = {}) {
  const emit = opts.emit || (() => {});
  const sleep = opts.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  emit({ type: 'unstuck', cause: 'floating' });
  try {
    if (typeof bot.clearControlStates === 'function') bot.clearControlStates();
    else ['forward', 'back', 'left', 'right', 'jump', 'sneak'].forEach((c) => { try { bot.setControlState(c, false); } catch (e) {} });
  } catch (e) {}
  try { bot.pathfinder && bot.pathfinder.setGoal(null); } catch (e) {}
  await clearSnares(bot);                               // souvent la cause : lianes/toile (#9)
  const t0 = Date.now();
  const timeoutMs = opts.timeoutMs || 4000;
  while (!(bot.entity && bot.entity.onGround) && Date.now() - t0 < timeoutMs) {
    await sleep(200);
  }
  const ok = !!(bot.entity && bot.entity.onGround);
  emit({ type: 'unstuck_done', cause: 'floating', ok });
  return { ok };
}

/**
 * DESYNC client/serveur (piste n°5 rapport water-wall, vécu NethBot1) : le process vit, les events
 * tournent, mais la position reste identique AU DIXIÈME pendant des minutes (le client croit être
 * quelque part où le serveur ne le voit plus bouger). Ni le jam-watchdog (exige un goal pathfinder
 * gelé) ni le connection-watchdog (les ticks arrivent) ne le voient. Signature PURE : `need`
 * échantillons consécutifs strictement égaux (arrondis au dixième). Le remède = re-login
 * (process.exit → self-healing respawne, back-off RC2 en garde-fou).
 */
function isFrozenDesync(samples, { need = 10, digging = false } = {}) {
  // En plein dig, l'immobilité est LÉGITIME → on n'ignore plus (vécu world_ax2 : 3 bots gelés EN
  // PLEIN minage, targetDigBlock figé → l'ancien reset rendait le desync invisible), on double
  // la fenêtre : un dig honnête ne dure jamais 10 min, un dig gelé si.
  const effNeed = digging ? need * 2 : need;
  if (!Array.isArray(samples) || samples.length < effNeed) return false;
  const last = samples.slice(-effNeed);
  const k = (p) => `${Math.round(p.x * 10)},${Math.round(p.y * 10)},${Math.round(p.z * 10)}`;
  const first = k(last[0]);
  return last.every((p) => p && k(p) === first);
}

// --- ANTI-CAMPING DU SPAWNPOINT : décisions PURES de la fuite d'évasion ---------------------------
//
// Flagrant délit world_mn15 (NethBot3, 02:50-02:51 — 26 morts en 1 h 30) :
//   02:50:37 shot by Skeleton · 02:50:54 shot by Skeleton · 02:50:57 issued /spawnpoint
//   02:51:01 shot by Skeleton · 02:51:05 issued /spawnpoint · 02:51:13 shot by Skeleton
// Un squelette campe le point de réapparition ; le bot respawne, se fait abattre avant d'avoir agi,
// et RÉ-ANCRE son respawn au même endroit — la boucle se referme sur elle-même.
//
// Pourquoi l'anti-camping existant ne servait à rien EN SANS-GIVE : son évasion était
// `relocateToRegion()`, c'est-à-dire un `/spreadplayers` — commande de triche BLOQUÉE par
// nogive.js. Le « warp » était donc un NO-OP silencieux… mais le `/spawnpoint` qui le suivait
// s'exécutait quand même, sur place. Le seul effet net du secours était de CIMENTER le piège
// (piège projet #47b : « les warps historiques deviennent des no-ops → chaque secours doit avoir
// un fallback vrai joueur »).
//
// Le fallback vrai joueur, c'est ce qu'un humain fait : il COURT, puis il ne repose son lit que
// là où plus rien ne le vise.

const ESCAPE_MIN_DIST = 30;      // assez pour sortir de la portée d'arc + de l'agro du campeur
const ESCAPE_MAX_DIST = 60;      // et pas plus : on fuit, on n'émigre pas (le confine/la base restent)
const ESCAPE_SAFE_RADIUS = 16;   // « zone sûre » = aucun hostile à ≤16 blocs de l'arrivée
const ESCAPE_REACHED_DIST = 16;  // fuite RÉUSSIE = on a vraiment quitté le lieu du camping

/**
 * PUR — plan d'évasion après une mort en rafale sur un spawnpoint campé.
 *
 * @param {object} opts
 *   noGive  {boolean}          mode sans-give : les warps serveur sont bloqués → fuite À PIED
 *   pos     {{x,y,z}}          position de respawn (le lieu campé)
 *   hostile {{x,y,z}|null}     position de l'hostile le plus proche s'il est en vue
 *   rand    {function}         générateur [0,1) injectable (tests déterministes)
 * @returns {{mode:'walk',x:number,y:number,z:number,dist:number,heading:number}
 *           |{mode:'warp'}|null}
 */
function escapePlan(opts = {}) {
  // Mode ADMIN (give autorisé : mappeurs, serveurs de test historiques) : /spreadplayers marche
  // vraiment là-bas → on ne touche à rien, le warp historique reste le meilleur outil.
  if (!opts.noGive) return { mode: 'warp' };

  const pos = opts.pos;
  if (!pos || !Number.isFinite(pos.x) || !Number.isFinite(pos.z)) return null;
  const rand = typeof opts.rand === 'function' ? opts.rand : Math.random;

  // Cap : à l'OPPOSÉ du campeur quand on le voit (c'est lui le problème), sinon au hasard.
  let heading = null;
  const h = opts.hostile;
  if (h && Number.isFinite(h.x) && Number.isFinite(h.z)) {
    const dx = pos.x - h.x;
    const dz = pos.z - h.z;
    if (Math.hypot(dx, dz) > 1e-6) heading = Math.atan2(dz, dx);
    // même colonne (mob PILE sur le bot) → pas de direction opposée définie : cap arbitraire.
  }
  if (heading == null) heading = rand() * Math.PI * 2;

  const dist = ESCAPE_MIN_DIST + rand() * (ESCAPE_MAX_DIST - ESCAPE_MIN_DIST);
  return {
    mode: 'walk',
    x: Math.round(pos.x + Math.cos(heading) * dist),
    // altitude de RÉFÉRENCE (celle du respawn) : le but reste un GoalNearXZ, ce y ne sert qu'aux
    // appelants qui veulent une cible 3D — jamais à contraindre la fuite.
    y: pos.y,
    z: Math.round(pos.z + Math.sin(heading) * dist),
    dist,
    heading,
  };
}

/**
 * PUR — a-t-on VRAIMENT quitté le lieu du camping ? (distance horizontale ; l'altitude ne compte
 * pas : fuir en descendant dans un ravin reste une fuite). Un `goto` peut rendre NoPath ou expirer
 * après quelques blocs — c'est la distance parcourue qui tranche, pas le retour du pathfinder.
 */
function escapeReached(from, to, minDist = ESCAPE_REACHED_DIST) {
  if (!from || !to) return false;
  if (!Number.isFinite(from.x) || !Number.isFinite(to.x)) return false;
  return Math.hypot(to.x - from.x, to.z - from.z) >= minDist;
}

/**
 * PUR — LE cœur du fix : peut-on ré-ancrer le respawn ICI ?
 * Deux conditions, jamais l'une sans l'autre :
 *   - la fuite a réussi (sinon on ré-ancrerait sur le lieu du camping, exactement le bug) ;
 *   - la zone d'arrivée est propre (aucun hostile à ≤ ESCAPE_SAFE_RADIUS).
 * Fuite ratée (bot acculé/coincé) ⇒ on ne ré-ancre PAS DU TOUT cette fois : garder l'ancien
 * spawnpoint est moins pire que d'en poser un neuf sous le nez d'un archer.
 */
function canReanchorSpawn(opts = {}) {
  if (!opts || opts.escaped !== true) return false;
  const d = opts.nearestHostileDist;
  if (d == null) return true;                    // aucun hostile en vue
  if (typeof d !== 'number' || Number.isNaN(d)) return false;   // mesure douteuse → on ne cimente rien
  return d > ESCAPE_SAFE_RADIUS;
}

// --- FUITE DÈS LE SPAWN, SANS ATTENDRE DE MOURIR (live 19/10, MapBot1) ----------------------------
//
// Journal serveur MESURÉ (cartographe non-op, pas de lit) :
//   17:47:20 login (-3, 70, -1) sous la canopée d'une forêt de bouleaux — les zombies n'y brûlent pas
//   en plein jour — puis « was slain by Zombie » à :25, :32, :37, :54 → death_loop → process.exit →
//   relance 25 s plus tard au MÊME spawn → 4 morts de plus…
//
// L'évasion ci-dessus ne s'armait QU'APRÈS des morts (2 en 60 s, ou 3 en 10 min) : chaque génération
// de process perdait 2-3 vies avant de seulement penser à courir. Un humain, lui, VOIT les zombies au
// login et part. D'où une décision PURE « y a-t-il danger MAINTENANT ? », posée au spawn.

const SPAWN_DANGER_RADIUS = 12;     // plus loin, les réflexes et le planner ont le temps de voir venir
// « Nu » = moins de 2 pièces. Même mot que caution.CAUTION_MIN_WORN et homes.DEBT_MIN_WORN : on ne
// l'importe pas (unstuck.js reste sans dépendance, il est sur le chemin chaud de mapper.js) mais un
// test épingle les trois valeurs — une seule définition du mot, pas trois qui divergent en silence.
const SPAWN_DANGER_MIN_WORN = 2;

/** Hostile par défaut : le `kind` de mineflayer. L'appelant injecte mieux (noms listés, neutres exclus). */
function _defaultIsHostile(e) { return !!e && e.kind === 'Hostile mobs'; }

/**
 * PUR — faut-il fuir tout de suite, avant d'avoir pris un seul coup ?
 * Vrai SSI le bot est NU (< `minWorn` pièces portées) ET un hostile est à ≤ `radius` blocs (3D).
 * Le campeur n'a pas besoin de t'avoir déjà tué pour être un campeur.
 *
 * @param {object} opts
 *   worn       {number}      pièces d'armure PORTÉES. Absent/NaN/négatif = 0 (inventaire pas encore
 *                            livré juste après un spawn → « 0 = prudent », comme les autres gardes) ;
 *   pos        {{x,y,z}}     position du bot ;
 *   entities   {Array}       entités autour (Object.values(bot.entities)) — { position:{x,y,z}, name, kind } ;
 *   isHostile  {function}    prédicat injectable (défaut : kind === 'Hostile mobs') ;
 *   radius, minWorn          seuils injectables.
 * @returns {{flee:boolean, reason:string, dist:number|null, mob:string|null, worn:number}}
 *   reason : 'armored' | 'no_position' | 'no_hostile' | 'too_far' | 'naked_hostile_near'.
 *   `dist`/`mob` sont renseignés dès qu'un hostile a été vu, même trop loin : ils servent à tracer
 *   POURQUOI le bot est resté (le silence est un bug).
 */
function spawnDanger(opts) {
  const o = (opts && typeof opts === 'object') ? opts : {};
  const minWorn = Number.isFinite(o.minWorn) ? o.minWorn : SPAWN_DANGER_MIN_WORN;
  const radius = (Number.isFinite(o.radius) && o.radius >= 0) ? o.radius : SPAWN_DANGER_RADIUS;
  const worn = (Number.isFinite(o.worn) && o.worn > 0) ? Math.floor(o.worn) : 0;
  const out = (flee, reason, best) => ({
    flee, reason, worn, dist: best ? best.dist : null, mob: best ? best.mob : null,
  });

  if (worn >= minWorn) return out(false, 'armored', null);
  const p = o.pos;
  if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y) || !Number.isFinite(p.z)) {
    return out(false, 'no_position', null);
  }
  const isHostile = typeof o.isHostile === 'function' ? o.isHostile : _defaultIsHostile;

  let best = null;
  for (const e of (Array.isArray(o.entities) ? o.entities : [])) {
    if (!e || !e.position) continue;
    // Un prédicat qui lève sur UNE entité ne doit ni tuer la décision ni masquer les autres.
    let hostile = false;
    try { hostile = !!isHostile(e); } catch (err) { hostile = false; }
    if (!hostile) continue;
    const d = Math.hypot(e.position.x - p.x, e.position.y - p.y, e.position.z - p.z);
    if (!Number.isFinite(d)) continue;                       // coordonnée illisible : ni plus proche ni plus loin
    if (!best || d < best.dist) best = { dist: d, mob: e.name || null };
  }
  if (!best) return out(false, 'no_hostile', null);
  if (best.dist > radius) return out(false, 'too_far', best);
  return out(true, 'naked_hostile_near', best);
}

// --- L'HISTORIQUE DE MORTS DOIT SURVIVRE AU PROCESS -------------------------------------------------
//
// `deathTimes` vivait dans la mémoire du process. Or le garde-fou `death_loop` (5 morts / 10 min) fait
// `process.exit(2)` et le self-healing relance un process NEUF dont la mémoire est vide : l'armement de
// l'évasion (2 morts <60 s, ou 3 en 10 min) repartait de zéro à chaque génération. Même classe que la
// mémoire de zone (zone.js, #63/#66a) : une mémoire d'échec par process ne sert à rien quand les
// sessions redémarrent sans cesse. L'historique rejoint donc le mémo de base, à côté de la dette de mort
// et de l'état de zone — élagué au chargement, rétro-compatible d'un mémo qui n'a pas le champ.

const DEATH_WINDOW_MS = 10 * 60 * 1000;   // la fenêtre de l'ancien `deathTimes.filter(...)`
const DEATH_HISTORY_CAP = 10;             // le garde-fou sort à 5 : 10 suffit largement, et le fichier reste minuscule

/**
 * PUR — ne garde que les morts récentes : nombres finis, ≤ now, âgés de MOINS de `windowMs`
 * (frontière exclusive, comme l'ancien filtre), triés du plus ancien au plus récent, plafonnés aux
 * `cap` plus récentes. Ne mute jamais l'entrée ; toute entrée absurde → [].
 * ⚠️ Une mort datée du FUTUR est jetée : horloge reculée ou mémo hérité d'un autre monde, elle
 * compterait « récente » (âge négatif) jusqu'à ce que l'horloge la rattrape.
 */
function deathTimesPrune(times, now, opts) {
  if (!Array.isArray(times) || !Number.isFinite(now)) return [];
  const o = (opts && typeof opts === 'object') ? opts : {};
  const windowMs = Number.isFinite(o.windowMs) ? o.windowMs : DEATH_WINDOW_MS;
  const cap = Number.isFinite(o.cap) && o.cap > 0 ? o.cap : DEATH_HISTORY_CAP;
  const kept = times
    .filter((t) => typeof t === 'number' && Number.isFinite(t) && t <= now && (now - t) < windowMs)
    .sort((a, b) => a - b);
  return kept.length > cap ? kept.slice(kept.length - cap) : kept;
}

/** PUR — historique à reprendre d'un mémo (absent / ancien format sans le champ → []), élagué À LA LECTURE. */
function deathTimesLoad(memo, now) {
  return deathTimesPrune(memo && typeof memo === 'object' ? memo.deaths : null, now);
}

/**
 * PUR — le mémo à écrire : une COPIE du mémo courant où seul `deaths` change (base, dette de mort,
 * état de zone… traversent intacts). C'est l'aller-retour complet : tout écrivain du mémo doit
 * fusionner ainsi, un `{ ... }` neuf efface les champs des autres (piège #61).
 */
function deathMemoWith(memo, times, now) {
  const base = (memo && typeof memo === 'object' && !Array.isArray(memo)) ? memo : {};
  return Object.assign({}, base, { deaths: deathTimesPrune(times, now) });
}

const ESCAPE_BURST_MS = 60 * 1000;   // « rafale » : 2 morts dans cette fenêtre…
const ESCAPE_BURST_DEATHS = 2;
const ESCAPE_SLOW_DEATHS = 3;        // …ou 3 morts dans la fenêtre de 10 min (camping LENT, « fix fable1 ter »)

/**
 * PUR — l'historique dit-il que CE spawn est campé ? (armement de l'évasion au prochain spawn)
 * Extrait tel quel de `bot.on('death')` pour que la mort ET le chargement d'un process neuf jugent
 * pareil : sans ça, le drapeau `_escapeOnSpawn` armé à la 5ᵉ mort mourait avec le process.
 */
function escapeArmed(times, now) {
  const recent = deathTimesPrune(times, now);
  const burst = recent.filter((t) => now - t < ESCAPE_BURST_MS).length;
  return burst >= ESCAPE_BURST_DEATHS || recent.length >= ESCAPE_SLOW_DEATHS;
}

const DEATH_LOOP_LIMIT = 5;          // 5 morts / 10 min DANS CE PROCESS → process.exit(2)

/**
 * PUR — ce process est-il pris dans une boucle de morts ? Ne compte que SES morts (`t >= bootAt`).
 * Les morts héritées d'un process précédent arment l'évasion (escapeArmed) mais ne comptent PAS ici :
 * sinon l'historique persisté (5) + 1 ferait sortir CHAQUE relance à sa première mort, des vies de
 * moins de 15 s, et le backend (3 vies < 15 s d'affilée = crash_on_spawn) abandonnerait le bot pour
 * de bon. Le garde-fou mesure « CE process est-il coincé ? » (planner périmé → process neuf), pas
 * « le monde est-il mortel ? ». Sans `bootAt`, tout compte (comportement historique).
 */
function deathLoopTripped(times, opts) {
  const o = (opts && typeof opts === 'object') ? opts : {};
  const limit = Number.isFinite(o.limit) && o.limit > 0 ? o.limit : DEATH_LOOP_LIMIT;
  const bootAt = Number.isFinite(o.bootAt) ? o.bootAt : -Infinity;
  return deathTimesPrune(times, o.now).filter((t) => t >= bootAt).length >= limit;
}

module.exports = {
  isInWater, findLandTarget, escapeWater, WATER, SNARES, clearSnares, isFloatingStuck, recoverFloating, isFrozenDesync,
  escapePlan, escapeReached, canReanchorSpawn,
  ESCAPE_MIN_DIST, ESCAPE_MAX_DIST, ESCAPE_SAFE_RADIUS, ESCAPE_REACHED_DIST,
  spawnDanger, SPAWN_DANGER_RADIUS, SPAWN_DANGER_MIN_WORN,
  deathTimesPrune, deathTimesLoad, deathMemoWith, escapeArmed, deathLoopTripped,
  DEATH_WINDOW_MS, DEATH_HISTORY_CAP, DEATH_LOOP_LIMIT,
};
