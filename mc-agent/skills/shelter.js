'use strict';
// ABRI NOCTURNE (vécu Surv4 : 7 morts de nuit pendant le kit) — le réflexe humain sans armure :
// creuser 3 blocs sous ses pieds, se boucher au-dessus, ATTENDRE L'AUBE, ressortir en pilier (#7).
// Le bot (2 blocs de haut) tient alors ENTIER sous la surface, dans une CELLULE FERMÉE (cf. _buildCell).
// Les réflexes restent ON pendant l'attente.
const { Vec3 } = require('vec3');
const { mineDown } = require('./mineDown');
const { panicWall } = require('./panicWall');
const { pillarUp } = require('./pillarUp');
const { POSABLE } = require('../dirt');
const { bestToolFor, toolCategoryFor } = require('../tools');
const { boundedDig, boundedEquip, bounded, DIG_STEP_TIMEOUT_MS } = require('../digBound');

// ─── CHAQUE ÉTAPE EST BORNÉE (live 21/10, NethBot3 session 48) ─────────────────────────────────────
// `shelter dig_in` puis PLUS RIEN pendant 10+ min, jour levé, planner gelé : un `/home safe` (retour à
// la base après la mort) téléportait le bot 29 ms APRÈS le début du creusage, et `bot.dig` attend pour
// toujours la mise à jour d'un bloc resté à 400 blocs de là (cf. digBound). Désormais : un coup ≤ 15 s
// (et abandonné au téléport), murer / colmater / toit ≤ 30 s, remonter ≤ 60 s. Une étape qui n'aboutit
// pas compte comme ratée ; l'abri continue (plan B) ou se termine — il ne gèle jamais.
const SHELTER_STAGE_MS = 30 * 1000;
const SHELTER_PILLAR_MS = 60 * 1000;

// Creuse en ÉQUIPANT le bon outil (Massii 2026-07-26 : « neth1 casse la pierre avec ses mains »).
// Ce module appelait `bot.dig` NU trois fois : la pierre à la main c'est ~7,5 s par bloc contre
// ~1,15 s à la pioche pierre. L'abri nocturne prenait donc des MINUTES, passées à découvert — soit
// exactement la situation qu'il est censé éviter.
async function _digWithTool(bot, block, token = null, timeoutMs = DIG_STEP_TIMEOUT_MS) {
  if (!block) return false;
  try {
    const tool = bestToolFor(bot, block);
    if (tool) await boundedEquip(bot, tool, 'hand');   // borné ; raté → on creuse quand même
  } catch (e) { /* best-effort */ }
  const r = await boundedDig(bot, block, { token, timeoutMs });
  return r.ok;
}

/** PUR : est-ce la nuit (hostiles spawnent) ? timeOfDay ∈ [0,24000), nuit ≈ 12800-23200. */
function isNightTime(timeOfDay) {
  if (timeOfDay == null) return false;
  const t = ((timeOfDay % 24000) + 24000) % 24000;
  return t >= 12800 && t <= 23200;
}

/** Nuit côté bot (bot.time.timeOfDay). */
function isNight(bot) {
  return !!(bot && bot.time && isNightTime(bot.time.timeOfDay));
}

// ─── L'AUBE N'EST PAS LA FIN DES MONSTRES (live 19/10, spawn sous la canopée d'une vieille forêt) ──
// Mesuré en live : 14 des 17 morts des 10 dernières minutes étaient « shot by Skeleton », avec TOUJOURS
// la même séquence : shelter dig_in → shelter dawn → shelter out → goal logs → reflex fight_ranged →
// reflex flee → take_cover placed:0 ok:false → mort. L'abri sortait dès que `isNight` devenait faux,
// sans regarder si les monstres de la nuit attendaient dehors. À l'ombre d'une canopée, zombies et
// squelettes NE BRÛLENT PAS au lever du jour : ils sont toujours là, et le bot sort droit dans leur arc.
// Étape 3bis : entre l'aube et la sortie, tant qu'un hostile rôde ET que le bot est nu, on RESTE.
const DAWN_WAIT_MAX_MS = 120 * 1000;   // borne DURE : au-delà on sort quand même (VITESSE — le propriétaire veut
                                       // que rien ne traîne ; à découvert sous une canopée ils ne partiront pas)
const DAWN_WAIT_CHECK_MS = 3000;       // on re-vérifie toutes les 3 s
// « Nu » = moins de 2 pièces portées : le mot de caution.CAUTION_MIN_WORN, homes.DEBT_MIN_WORN et
// unstuck.SPAWN_DANGER_MIN_WORN (copié, pas importé — ce module reste léger ; un test épingle les quatre).
const DAWN_WAIT_MIN_WORN = 2;

/**
 * Décision PURE : attendre dans l'abri ou en sortir, à l'aube ? → 'wait' | 'go'.
 * 'wait' SSI le bot est NU (< minWorn pièces) ET des hostiles rôdent ET on n'a pas encore attendu maxMs.
 * Tout le reste → 'go' : un bot armé sort tout de suite, comme avant ; personne dehors, on sort ; et
 * passé la borne on sort quand même. Entrée absurde → 'go' (jamais coincé dans le trou sur une erreur).
 * `worn` inconnu (inventaire illisible) = 0 = nu : on attend, borné — « 0 = prudent », comme les autres gardes.
 * @param {{hostilesNear:number|boolean, waitedMs:number, worn:number, maxMs?:number, minWorn?:number}} opts
 */
function dawnExitDecision(opts) {
  const o = (opts && typeof opts === 'object') ? opts : {};
  const minWorn = Number.isFinite(o.minWorn) ? o.minWorn : DAWN_WAIT_MIN_WORN;
  const maxMs = (Number.isFinite(o.maxMs) && o.maxMs >= 0) ? o.maxMs : DAWN_WAIT_MAX_MS;
  const worn = (Number.isFinite(o.worn) && o.worn > 0) ? o.worn : 0;
  if (worn >= minWorn) return 'go';
  const h = o.hostilesNear;
  const hostiles = Number.isFinite(h) ? h : (h === true ? 1 : 0);
  if (hostiles <= 0) return 'go';
  const waited = (Number.isFinite(o.waitedMs) && o.waitedMs > 0) ? o.waitedMs : 0;
  return waited >= maxMs ? 'go' : 'wait';
}

// ─── SORTIE D'ABRI « QUAND C'EST SÛR » (fix 20/10) ───────────────────────────────────────────────
// Mesuré (run 20/10, 1 h, 36 morts) : 9 morts juste après `shelter:out`. Trois signatures : (1) la sortie
// d'un bot ARMÉ (≥ 2 pièces) n'attendait jamais, même avec 5 zombies devant la porte (NethBot3 :
// `out` → `fight_chosen hostiles:5` → mort 57 s plus tard) ; (2) la borne de 60-120 s tombait avec
// 1-3 hostiles encore là (`dawn_wait reason:timeout hostiles_left:3` → `out` → mort 4 s après) ;
// (3) un creeper calme à 6-10 blocs ne comptait pas (`out` → creeper à 3,6 blocs 1 s après → explosion).
// Règle (opt-in, `deps.exitThreats`) : ne sortir que si
//   - l'heure MC est dans [0, 11500] (soleil levé : zombies et squelettes à découvert brûlent) ;
//   - aucun hostile non-creeper à ≤ 16 blocs EN VUE de la sortie ;
//   - aucun creeper à ≤ 10 blocs (calme ou non) ;
// sinon attendre par tranches de 10 s, borné à 180 s, puis sortir quand même. Armé ou nu : même règle.
const DAWN_SAFE_EXIT_MAX_MS = 180 * 1000;
const DAWN_SAFE_CHECK_MS = 10 * 1000;
const DAY_SAFE_END = 11500;            // timeOfDay ∈ [0, 11500] = jour franc

/**
 * PUR — sortir de l'abri ? opts = { hostiles, creepers, timeOfDay, waitedMs, maxMs }.
 * → { act: 'go'|'wait', reason: 'timeout'|'dark'|'creeper'|'hostiles'|'clear' }.
 * Entrées absentes/absurdes : comptées 0 / heure ignorée (jamais coincé dans le trou sur une erreur).
 */
function dawnExitPlan(opts) {
  const o = (opts && typeof opts === 'object') ? opts : {};
  const maxMs = (Number.isFinite(o.maxMs) && o.maxMs >= 0) ? o.maxMs : DAWN_SAFE_EXIT_MAX_MS;
  const waited = (Number.isFinite(o.waitedMs) && o.waitedMs > 0) ? o.waitedMs : 0;
  if (waited >= maxMs) return { act: 'go', reason: 'timeout' };
  const t = o.timeOfDay;
  if (Number.isFinite(t) && t >= 0 && (t % 24000) > DAY_SAFE_END) return { act: 'wait', reason: 'dark' };
  if (Number.isFinite(o.creepers) && o.creepers > 0) return { act: 'wait', reason: 'creeper' };
  if (Number.isFinite(o.hostiles) && o.hostiles > 0) return { act: 'wait', reason: 'hostiles' };
  return { act: 'go', reason: 'clear' };
}

// ─── ABRI QUITTÉ (discipline de nuit, 19/10 soir) ────────────────────────────────────────────────
// L'attente ne regardait que l'horloge : un bot DÉLOGÉ de son trou (fuite réflexe, riposte pvp qui
// poursuit sa cible, sauvetage d'eau, /home d'urgence) restait « à l'abri » jusqu'au matin, debout
// dehors — et la discipline de nuit d'index.js, qui attend la fin de l'abri en cours avant de se
// ré-abriter, attendait avec lui. Le trou fait 1×1 : en sortir, c'est quitter sa colonne (≥ 1,5 bloc
// à plat) ou remonter au niveau du sol (≥ 1,5 en hauteur — un saut fait 1,25, il ne compte pas).
const SHELTER_DISPLACED_BLOCKS = 1.5;

/** PUR : le bot a-t-il quitté son abri ? anchor/pos = {x,y,z}. Coordonnée absente/absurde → false
 *  (jamais déclaré dehors sur une donnée manquante — c'est aussi la rétro-compat des faux bots). */
function shelterDisplaced(anchor, pos, maxBlocks = SHELTER_DISPLACED_BLOCKS) {
  const ok = (p) => !!p && Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z);
  if (!ok(anchor) || !ok(pos)) return false;
  return Math.hypot(pos.x - anchor.x, pos.z - anchor.z) >= maxBlocks || Math.abs(pos.y - anchor.y) >= maxBlocks;
}

/**
 * Étape 3bis — rester dans l'abri tant que dawnExitDecision dit 'wait'. Relevés LIVE (jamais mis en
 * cache : le monde bouge pendant l'attente), un toutes les `checkMs`. Le temps attendu est le plus
 * grand de deux compteurs : le CUMUL des pas (avec un sleep instantané, en test, la boucle reste bornée
 * au lieu de tourner sans fin) et l'HORLOGE MURALE (quand le process rame et que les sleeps durent plus
 * que prévu, la borne de 120 s reste de 120 s RÉELLES — « rien ne doit traîner »).
 * Émet UN SEUL event `dawn_wait` à la sortie de l'attente (pas un par tick), et seulement si on a
 * réellement attendu : `hostiles` = ce qui nous a retenus (au début), `hostiles_left` = ce qu'il restait
 * en sortant, `waited_s`, `reason` : 'clear' (dégagé) | 'timeout' (borne atteinte, on sort quand même)
 * | 'armed' (de l'armure est arrivée) | 'cancelled' | 'displaced' (délogé du trou : attendre n'a plus
 * de sens). `isDisplaced` (optionnel) = le relevé « abri quitté » de shelterUntilDawn.
 * @returns {{cancelled:boolean, displaced?:boolean}}
 */
async function _waitOutDawnMobs(bot, token, deps, emit, sleep, isDisplaced = null) {
  if (typeof deps.exitThreats === 'function') return _waitSafeExit(bot, token, deps, emit, sleep, isDisplaced);
  const maxMs = Number.isFinite(deps.dawnWaitMaxMs) ? deps.dawnWaitMaxMs : DAWN_WAIT_MAX_MS;
  const checkMs = (Number.isFinite(deps.dawnCheckMs) && deps.dawnCheckMs > 0) ? deps.dawnCheckMs : DAWN_WAIT_CHECK_MS;
  // Un relevé qui LÈVE vaut « rien » : on ne reste jamais coincé dans le trou sur une erreur de lecture.
  const readHostiles = () => {
    try { const v = deps.hostilesNear(); return Number.isFinite(v) ? v : (v ? 1 : 0); } catch (e) { return 0; }
  };
  // Pièces PORTÉES : injecté (index.js : _wornArmor, usées exclues), sinon les slots 5-8 du bot.
  const readWorn = () => {
    try {
      if (typeof deps.worn === 'function') { const v = deps.worn(); return Number.isFinite(v) ? v : 0; }
      const slots = bot && bot.inventory && bot.inventory.slots;
      return Array.isArray(slots) ? slots.slice(5, 9).filter(Boolean).length : 0;
    } catch (e) { return 0; }
  };

  const t0 = Date.now();
  let waitedMs = 0;
  let first = null;          // hostiles quand l'attente a COMMENCÉ (null = on n'a jamais attendu)
  let left = 0;
  let worn = 0;
  const done = (reason) => {
    if (first === null) return;                 // rien attendu → rien à dire
    emit({ type: 'shelter', action: 'dawn_wait', hostiles: first, hostiles_left: left,
      waited_s: Math.round(waitedMs / 1000), reason });
  };
  for (;;) {
    if (token && token.cancelled) { done('cancelled'); return { cancelled: true }; }
    if (isDisplaced && isDisplaced()) { done('displaced'); return { cancelled: false, displaced: true }; }
    left = readHostiles();
    worn = readWorn();
    if (dawnExitDecision({ hostilesNear: left, waitedMs, worn, maxMs }) !== 'wait') break;
    if (first === null) first = left;
    await sleep(checkMs);
    waitedMs = Math.max(waitedMs + checkMs, Date.now() - t0);
  }
  done(worn >= DAWN_WAIT_MIN_WORN ? 'armed' : (left > 0 ? 'timeout' : 'clear'));
  return { cancelled: false };
}

/**
 * Variante « sortie sûre » de l'étape 3bis (deps.exitThreats → { hostiles, creepers }, relu à chaque pas ;
 * l'heure vient de bot.time.timeOfDay). Un event `dawn_hold {reason, waited_s}` à chaque changement de
 * raison, puis le `dawn_wait` habituel à la sortie (reason : 'clear' | 'timeout' | 'cancelled' | 'displaced').
 * Borne : deps.dawnWaitMaxMs s'il est fourni (abri de menace de jour), sinon 180 s ; pas : 10 s.
 */
async function _waitSafeExit(bot, token, deps, emit, sleep, isDisplaced) {
  const maxMs = Number.isFinite(deps.dawnWaitMaxMs) ? deps.dawnWaitMaxMs : DAWN_SAFE_EXIT_MAX_MS;
  const checkMs = (Number.isFinite(deps.dawnCheckMs) && deps.dawnCheckMs > 0) ? deps.dawnCheckMs : DAWN_SAFE_CHECK_MS;
  const read = () => {
    let r = null;
    try { r = deps.exitThreats(); } catch (e) { r = null; }
    const tod = bot && bot.time && Number.isFinite(bot.time.timeOfDay) ? bot.time.timeOfDay : null;
    return { hostiles: r && Number.isFinite(r.hostiles) ? r.hostiles : 0,
      creepers: r && Number.isFinite(r.creepers) ? r.creepers : 0, timeOfDay: tod };
  };
  const t0 = Date.now();
  let waitedMs = 0;
  let first = null;
  let lastReason = null;
  let cur = { hostiles: 0, creepers: 0 };
  const done = (reason) => {
    if (first === null) return;
    emit({ type: 'shelter', action: 'dawn_wait', hostiles: first, hostiles_left: cur.hostiles + cur.creepers,
      waited_s: Math.round(waitedMs / 1000), reason });
  };
  for (;;) {
    if (token && token.cancelled) { done('cancelled'); return { cancelled: true }; }
    if (isDisplaced && isDisplaced()) { done('displaced'); return { cancelled: false, displaced: true }; }
    cur = read();
    const plan = dawnExitPlan({ hostiles: cur.hostiles, creepers: cur.creepers, timeOfDay: cur.timeOfDay, waitedMs, maxMs });
    if (plan.act !== 'wait') { done(plan.reason); return { cancelled: false }; }
    if (first === null) first = cur.hostiles + cur.creepers;
    if (plan.reason !== lastReason) {
      lastReason = plan.reason;
      emit({ type: 'dawn_hold', reason: plan.reason, waited_s: Math.round(waitedMs / 1000),
        hostiles: cur.hostiles, creepers: cur.creepers, tod: cur.timeOfDay });
    }
    await sleep(checkMs);
    waitedMs = Math.max(waitedMs + checkMs, Date.now() - t0);
  }
}

// ─── LA CELLULE FERMÉE (19/10 soir) ──────────────────────────────────────────────────────────────
// Mesure live (20 sessions) : 120 abris → 46 abandonnés (39 `void_below`, 7 `dig_failed`), et 10 SEULEMENT
// avec un toit. Trois causes, toutes physiques — reproduites dans test/shelter.cell.test.js, un monde
// simulé où l'ancien code donne exactement la signature live (`dig_in > no_roof`, bot resté en surface) :
//   1. `mineDown(bot, { depth: 2 })` : mineDown lit `count` (1 par défaut) → UN bloc creusé. La case du
//      toit (pieds + 2) tombait AU-DESSUS du sol, sans aucun bloc voisin contre lequel poser sur terrain
//      plat → pose impossible, et en SILENCE (ni `roofed` ni `no_roof`). Un `count: 2` naïf échouait aussi :
//      le 2e coup partait avant que le bot soit retombé → `void_below` (cf. mineDown, option `land`).
//   2. Le bot ne tombait souvent PAS dans son propre trou : sa boîte fait 0,6 de large ; pas centrée, elle
//      déborde sur la case voisine (≈ 84 % des positions au hasard) et il reste DEBOUT sur le bord quand on
//      creuse sous son centre — les 29 `no_roof` : resté en surface, il n'avait pas de paroi où miner un bloc.
//   3. Un bloc cassé n'est ramassable qu'après 10 ticks (0,5 s) : la poche était lue tout de suite, vide, et
//      le code minait alors les parois de SON PROPRE abri pour trouver de quoi poser.
// Le geste juste, celui du joueur : se centrer, creuser 3 blocs en attendant chaque atterrissage, attendre
// le ramassage, poser le toit contre la paroi naturelle (à fleur du sol), colmater ce qui reste ouvert.
// Pourquoi 3 et pas 2 : à 2 de profondeur la tête est au niveau du sol et la case du toit AU-DESSUS, sans
// voisin plein — il faut alors un bloc de support (géré, cf. _placeRoof, mais c'est un bloc de plus).
const SHELTER_PIT_DEPTH = 3;
const SHELTER_MIN_DEPTH = 2;      // en dessous, la tête dépasse du sol : ce n'est plus un abri
const CHUNK_WAIT_MS = 2500;       // respawn : les chunks arrivent en ~1 s — sinon `blockAt` → null → void_below
const PICKUP_WAIT_MS = 1500;      // 10 ticks de délai de ramassage + chute de l'item au fond du puits
const STEP_MAX = 3;               // sol non plein sous les pieds → UN pas vers un voisin au sol plein, ≤ 3 blocs
const STEP_TIMEOUT_MS = 4000;
const SPOT_RADIUS = 2;            // « au même endroit »
const SPOT_TTL_MS = 10 * 60 * 1000;
const SPOT_MAX_FAILS = 2;         // 2 échecs au même endroit → plan B « mur sur place », sans re-creuser
// Blocs de toit/paroi : SANS gravité (sable et gravier retomberaient sur la tête), la terre d'abord — elle
// se reprend à la main à l'aube, la pierre non (sans pioche, rien ne tombe). Planches en dernier recours.
const CELL_BLOCKS = ['dirt', 'coarse_dirt', 'grass_block', 'rooted_dirt', 'cobblestone', 'cobbled_deepslate',
  'stone', 'deepslate', 'tuff', 'granite', 'diorite', 'andesite', 'netherrack'];
const _CARD = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const _FLUID = new Set(['water', 'lava', 'flowing_water', 'flowing_lava']);
// Sol où creuser : plein et cassable — ni feuillage (rien dessous), ni glace (le trou se remplit d'eau),
// ni bloc utile du camp, ni incassable.
const _NO_DIG = /^(bedrock|barrier|ice|packed_ice|blue_ice|frosted_ice|crafting_table|furnace|blast_furnace|smoker|chest|trapped_chest|barrel|spawner|end_portal_frame|reinforced_deepslate)$|_leaves$|_bed$/;

/** Coupe tout geste en vol (creusage, trajet, touches) — après une étape de l'abri qui n'a pas abouti. */
function _stopAll(bot) {
  try { if (bot.targetDigBlock && typeof bot.stopDigging === 'function') bot.stopDigging(); } catch (e) { /* best-effort */ }
  try { if (bot.pathfinder && typeof bot.pathfinder.setGoal === 'function') bot.pathfinder.setGoal(null); } catch (e) { /* best-effort */ }
  try { if (typeof bot.clearControlStates === 'function') bot.clearControlStates(); } catch (e) { /* best-effort */ }
}
function _solid(b) { return !!b && b.boundingBox === 'block'; }
function _clear(b) { return !!b && b.boundingBox === 'empty' && !_FLUID.has(b.name); }
function _xyz(p) { return !!p && Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z); }
function _hasPick(bot) {
  try { return ((bot.inventory && bot.inventory.items()) || []).some((i) => /_pickaxe$/.test(i.name)); } catch (e) { return false; }
}
/** Sol où creuser VITE : plein, cassable ; à mains nues seulement s'il rend un bloc (pas la pierre sans pioche :
 *  7,5 s par bloc et RIEN qui tombe — donc pas de toit). */
function _diggable(b, pick) { return _solid(b) && !_NO_DIG.test(b.name) && (pick || toolCategoryFor(b.name) !== 'pickaxe'); }

/** Le bloc de toit/paroi à poser (ordre CELL_BLOCKS, puis planches), ou null. */
function cellBlockItem(bot) {
  const items = (bot.inventory && bot.inventory.items()) || [];
  for (const name of CELL_BLOCKS) { const it = items.find((i) => i.name === name && i.count > 0); if (it) return it; }
  return items.find((i) => typeof i.name === 'string' && i.name.endsWith('_planks') && i.count > 0) || null;
}
/** Combien de blocs de toit/paroi en poche. */
function cellBlockCount(bot) {
  let n = 0;
  for (const i of ((bot.inventory && bot.inventory.items()) || [])) {
    if (i && (CELL_BLOCKS.includes(i.name) || (typeof i.name === 'string' && i.name.endsWith('_planks')))) n += i.count || 0;
  }
  return n;
}

/** Mémoire des creusages ratés (« 2 échecs au même endroit → plan B »). Injectable (deps.spotMemory). */
function createSpotMemory() {
  let spot = null;
  const same = (x, z, now) => !!spot && now - spot.at <= SPOT_TTL_MS && Math.hypot(spot.x - x, spot.z - z) <= SPOT_RADIUS;
  return {
    fails(x, z, now) { return same(x, z, now) ? spot.n : 0; },
    fail(x, z, now) { if (same(x, z, now)) { spot.n += 1; spot.at = now; } else spot = { x, z, n: 1, at: now }; return spot.n; },
    clear() { spot = null; },
  };
}
// NIVEAU MODULE : l'abri suivant (la discipline de nuit se ré-abrite 20 s plus tard) doit s'en souvenir.
const _spots = createSpotMemory();

/** Respawn : attend que le monde sous les pieds soit lu (borné, en NOMBRE de pas). */
async function _waitWorld(bot, sleep) {
  const steps = Math.ceil(CHUNK_WAIT_MS / 250);
  for (let i = 0; i <= steps; i++) {
    const p = bot.entity && bot.entity.position;
    if (_xyz(p) && bot.blockAt(p.offset(0, -1, 0))) return true;
    if (i < steps) await sleep(250);
  }
  return false;
}

/** Peut-on se tenir en `f` (pieds) et y creuser ? `deep` = colonne pleine jusqu'au fond du puits ;
 *  `open` = côtés de la FUTURE cellule (au fond du puits) qui ne sont pas pleins — chacun coûtera un bloc. */
function _footingAt(bot, f, pick) {
  if (!_clear(bot.blockAt(f)) || !_clear(bot.blockAt(f.offset(0, 1, 0)))) return null;
  if (!_diggable(bot.blockAt(f.offset(0, -1, 0)), pick)) return null;
  let deep = true;
  for (let d = 2; d <= SHELTER_PIT_DEPTH + 1 && deep; d++) deep = _solid(bot.blockAt(f.offset(0, -d, 0)));
  return { pos: f, deep, open: _openSides(bot, f.offset(0, -SHELTER_PIT_DEPTH, 0)) };
}

/** Le voisin (≤ STEP_MAX) où creuser : colonne pleine d'abord, puis la cellule la plus fermée, puis le plus
 *  proche. `avoid` = cases ratées. */
function _pickFooting(bot, feet, pick, avoid) {
  let best = null;
  for (let dx = -STEP_MAX; dx <= STEP_MAX; dx++) {
    for (let dz = -STEP_MAX; dz <= STEP_MAX; dz++) {
      const dist = Math.hypot(dx, dz);
      if ((!dx && !dz) || dist > STEP_MAX) continue;
      if (avoid && avoid.some((a) => a.x === feet.x + dx && a.z === feet.z + dz)) continue;
      for (const dy of [0, -1, 1]) {
        const c = _footingAt(bot, feet.offset(dx, dy, dz), pick);
        if (!c) continue;
        const score = (c.deep ? 0 : 10) + c.open + dist + Math.abs(dy) * 0.5;
        if (!best || score < best.score) best = { pos: c.pos, score };
        break;
      }
    }
  }
  return best ? best.pos : null;
}

/** UN pas vers `f` (injectable deps.stepTo ; sinon le pathfinder, borné). → true si arrivé sur la case. */
async function _stepTo(bot, f, deps) {
  try {
    if (typeof deps.stepTo === 'function') await deps.stepTo(f);
    else if (bot.pathfinder && typeof bot.pathfinder.goto === 'function') {
      const { goals } = require('mineflayer-pathfinder');
      let timer = null;
      try {
        await Promise.race([
          bot.pathfinder.goto(new goals.GoalBlock(f.x, f.y, f.z)),
          new Promise((resolve, reject) => { timer = setTimeout(() => reject(new Error('step_timeout')), STEP_TIMEOUT_MS); }),
        ]);
      } finally { if (timer) clearTimeout(timer); }
    } else return false;
  } catch (e) { try { if (bot.pathfinder) bot.pathfinder.setGoal(null); } catch (e2) { /* best-effort */ } }
  const p = bot.entity && bot.entity.position;
  return !!(_xyz(p) && Math.floor(p.x) === f.x && Math.floor(p.z) === f.z);
}

/** Recentre la position dans SA case — le geste de mineflayer-pathfinder à chaque fin de trajet (fullStop) :
 *  < 0,5 bloc, sans changer de case. Sinon la boîte (0,6) déborde sur la voisine et le bot reste debout sur
 *  le bord du trou qu'il creuse sous son centre. */
function _centerInBlock(bot) {
  const e = bot.entity;
  const p = e && e.position;
  if (!_xyz(p)) return false;
  const cx = Math.floor(p.x) + 0.5;
  const cz = Math.floor(p.z) + 0.5;
  let moved = false;
  if (Math.abs(p.x - cx) > 0.1) { p.x = cx; moved = true; }
  if (Math.abs(p.z - cz) > 0.1) { p.z = cz; moved = true; }
  if (e.velocity) { e.velocity.x = 0; e.velocity.z = 0; }
  try { if (typeof bot.clearControlStates === 'function') bot.clearControlStates(); } catch (er) { /* best-effort */ }
  return moved;
}

/** Les 8 côtés de la cellule (4 aux pieds, 4 à la tête) qui ne sont pas pleins. */
function _openSides(bot, feet) {
  let n = 0;
  for (const dy of [0, 1]) for (const [dx, dz] of _CARD) if (!_solid(bot.blockAt(feet.offset(dx, dy, dz)))) n++;
  return n;
}

/** Attend que les blocs creusés arrivent en poche (délai de ramassage) jusqu'à en avoir `need`, borné en
 *  nombre de pas. → le nombre en poche. */
async function _waitCellBlocks(bot, sleep, need) {
  const steps = Math.ceil(PICKUP_WAIT_MS / 100);
  for (let i = 0; i <= steps; i++) {
    if (cellBlockCount(bot) >= need) break;
    if (i < steps) await sleep(100);
  }
  return cellBlockCount(bot);
}

/**
 * COLMATER les côtés ouverts de la cellule (pieds et tête), contre N'IMPORTE quelle face pleine voisine de la
 * case à boucher — jamais contre l'intérieur de la cellule (c'est de l'air, et c'est le bot). panicWall ne sait
 * poser que sur le bloc DU DESSOUS : à côté d'une grotte il pontait d'abord sous le côté, un bloc gâché.
 * → nombre de blocs posés.
 */
async function _sealSides(bot, feet) {
  const inside = (p) => p.x === feet.x && p.z === feet.z && (p.y === feet.y || p.y === feet.y + 1);
  const FACES = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
  let placed = 0;
  for (const dy of [0, 1]) {
    for (const [dx, dz] of _CARD) {
      const t = feet.offset(dx, dy, dz);
      if (_solid(bot.blockAt(t))) continue;
      for (const [rx, ry, rz] of FACES) {
        const rp = t.offset(rx, ry, rz);
        if (inside(rp)) continue;
        const ref = bot.blockAt(rp);
        if (!_solid(ref)) continue;
        const item = cellBlockItem(bot);
        if (!item) return placed;
        try { await bot.equip(item, 'hand'); await bot.placeBlock(ref, new Vec3(-rx, -ry, -rz)); } catch (e) { continue; }
        if (_solid(bot.blockAt(t))) { placed++; break; }
      }
    }
  }
  return placed;
}

/**
 * Le TOIT, au-dessus de la tête (pieds + 2) : déjà plein (plafond de grotte, feuillage) → rien à faire ;
 * sinon contre une paroi pleine voisine de la case (puits de 3 : le sol tout autour) ; sinon (puits de 2,
 * cellule murée : rien autour de la case) un bloc de SUPPORT posé sur une paroi à hauteur de tête, puis le
 * toit contre ce support. → { ok, placed, how: 'natural' | 'wall' | 'support' | null }
 */
async function _placeRoof(bot, feet) {
  const roof = feet.offset(0, 2, 0);
  if (_solid(bot.blockAt(roof))) return { ok: true, placed: 0, how: 'natural' };
  let placed = 0;
  const put = async (ref, face) => {
    const item = cellBlockItem(bot);
    if (!item) return false;
    try { await bot.equip(item, 'hand'); await bot.placeBlock(ref, face); placed++; return true; } catch (e) { return false; }
  };
  for (const [dx, dz] of _CARD) {
    const ref = bot.blockAt(roof.offset(dx, 0, dz));
    if (!_solid(ref)) continue;
    await put(ref, new Vec3(-dx, 0, -dz));
    if (_solid(bot.blockAt(roof))) return { ok: true, placed, how: 'wall' };
  }
  for (const [dx, dz] of _CARD) {
    const base = bot.blockAt(feet.offset(dx, 1, dz));
    const sup = roof.offset(dx, 0, dz);
    if (!_solid(base) || !_clear(bot.blockAt(sup))) continue;
    if (!(await put(base, new Vec3(0, 1, 0)))) continue;
    const support = bot.blockAt(sup);
    if (!_solid(support)) continue;
    await put(support, new Vec3(-dx, 0, -dz));
    if (_solid(bot.blockAt(roof))) return { ok: true, placed, how: 'support' };
  }
  return { ok: false, placed, how: null };
}

/**
 * Mise à l'abri : creuser ICI (ou à 1 pas, ou plan B « mur sur place »), couvrir, colmater, puis UNE ligne
 * `{type:'shelter', action:'sealed', sealed, why, mode, depth, placed, moved, took_ms}` — la mesure live
 * du taux de cellules fermées. → { ok, mode: 'pit' | 'walled', depth } | { ok:false, reason }
 * Sans coordonnées (faux bots des tests d'origine) : le chemin d'origine — creuser, sinon se murer.
 */
async function _buildCell(bot, token, deps, sleep, emit) {
  const t0 = Date.now();
  const digDown = deps.mineDown || mineDown;          // injectables (tests)
  const wallIn = deps.wallIn || panicWall;
  const seal = deps.seal || _sealSides;
  const spots = deps.spotMemory || _spots;
  const now = typeof deps.now === 'function' ? deps.now : Date.now;
  const located = _xyz(bot.entity && bot.entity.position) && typeof bot.blockAt === 'function';
  let moved = false;
  let placed = 0;
  const line = (o) => emit(Object.assign({ type: 'shelter', action: 'sealed' }, o,
    { placed, moved, took_ms: Date.now() - t0 }));

  // ── 1) CREUSER ──────────────────────────────────────────────────────────────────────────────────
  let down = null;
  let depth = 0;
  const digMs = Number.isFinite(deps.digTimeoutMs) && deps.digTimeoutMs > 0 ? deps.digTimeoutMs : DIG_STEP_TIMEOUT_MS;
  const stageMs = Number.isFinite(deps.stageTimeoutMs) && deps.stageTimeoutMs > 0 ? deps.stageTimeoutMs : SHELTER_STAGE_MS;
  // Chaque coup du puits est borné (digTimeoutMs → mineDown/boundedDig) ; l'appel entier aussi (stage).
  const dig = async (opts) => {
    const r = await bounded(digDown(bot, Object.assign({ digTimeoutMs: digMs }, opts), token), stageMs);
    if (!r.ok) { _stopAll(bot); return { ok: false, reason: 'dig_failed' }; }
    return r.value || { ok: false, reason: 'dig_failed' };
  };
  if (!located) {
    down = await dig({ count: SHELTER_PIT_DEPTH });
    depth = down.ok ? SHELTER_PIT_DEPTH : 0;
  } else {
    // L'abri POSSÈDE le bot : un trajet en cours (timer qui l'a lancé, planner) le tirerait hors du trou.
    try { if (bot.pathfinder && typeof bot.pathfinder.setGoal === 'function') bot.pathfinder.setGoal(null); } catch (e) { /* best-effort */ }
    await _waitWorld(bot, sleep);
    const pick = _hasPick(bot);
    const here = () => bot.entity.position.floored();
    const attempt = async () => {
      _centerInBlock(bot);
      const p0 = bot.entity.position;
      const x0 = p0.x; const y0 = p0.y; const z0 = p0.z;   // COPIES : la position est mutée en place (#73d)
      const r = await dig({ count: SHELTER_PIT_DEPTH, land: { sleep } });
      const p1 = bot.entity.position;
      // TÉLÉPORTÉ pendant le creusage (live 21/10 : /home safe parti juste avant l'abri) : l'écart de y
      // n'est PAS une profondeur creusée (vu : « depth 6 » sur un trou jamais fait, ressorti 58 → 64).
      if ((r && r.why === 'teleported') || Math.hypot(p1.x - x0, p1.z - z0) > 2) {
        emit({ type: 'shelter', action: 'teleported', dist: Math.round(Math.hypot(p1.x - x0, p1.z - z0)) });
        return { r: { ok: false, reason: 'teleported' }, depth: 0 };
      }
      return { r, depth: Math.max(0, Math.round(y0 - p1.y)) };
    };
    const f0 = here();
    if (spots.fails(f0.x, f0.z, now()) >= SPOT_MAX_FAILS) {
      down = { ok: false, reason: 'spot_failed' };
    } else {
      if (!_diggable(bot.blockAt(f0.offset(0, -1, 0)), pick)) {
        const to = _pickFooting(bot, f0, pick, null);
        if (to && await _stepTo(bot, to, deps)) moved = true;
      }
      let a = await attempt();
      if (a.depth < SHELTER_MIN_DEPTH && !(token && token.cancelled)) {
        // Raté ici (grotte, bloc incassable, sol qui ne cède pas) : noté, puis UN essai à côté.
        const fx = here();
        spots.fail(fx.x, fx.z, now());
        const to = _pickFooting(bot, fx, pick, [fx]);
        if (to && await _stepTo(bot, to, deps)) {
          moved = true;
          const b = await attempt();
          if (b.depth >= a.depth) a = b;
          if (b.depth < SHELTER_MIN_DEPTH) { const fb = here(); spots.fail(fb.x, fb.z, now()); }
        }
      }
      down = a.r;
      depth = a.depth;
      if (depth >= SHELTER_MIN_DEPTH) spots.clear();
    }
  }
  if (token && token.cancelled) { line({ sealed: false, why: 'cancelled', mode: 'pit', depth }); return { ok: false, reason: 'cancelled' }; }

  // ── 2) PLAN B : SE MURER SUR PLACE (mesure world_ax4 25/07 : 40 % des abris échouaient — un abri raté =
  // une nuit ENTIÈRE à découvert). Un vrai joueur se boxe avec ce qu'il a ; panicWall gère même la
  // grotte ouverte (pontage). Aussi à 1 bloc de profondeur : la tête dépasse, il faut murer.
  let mode = 'pit';
  const pitOk = located ? depth >= SHELTER_MIN_DEPTH : !!(down && down.ok);
  if (!pitOk) {
    const reason = (down && down.reason) || 'shallow';
    const wr = await bounded(wallIn(bot), stageMs);
    if (!wr.ok) _stopAll(bot);
    const walled = wr.ok ? wr.value : null;
    if (!walled || !walled.ok) {
      emit({ type: 'shelter', action: 'abort', reason });
      line({ sealed: false, why: 'abort:' + reason, mode: 'none', depth });
      return { ok: false, reason };
    }
    placed += walled.placed || 0;
    mode = 'walled';
    emit({ type: 'shelter', action: 'walled_in', placed: walled.placed || 0, after: reason });
  }

  if (!located) {
    // faux bots sans coordonnées : rien à mesurer — l'event d'origine, puis la ligne.
    if (!cellBlockItem(bot)) emit({ type: 'shelter', action: 'no_roof' });
    line({ sealed: false, why: 'no_position', mode, depth });
    return { ok: true, mode, depth };
  }

  // ── 3) TOIT (au-dessus de la tête), avec les blocs qu'on vient de creuser. Le délai de ramassage (10 ticks)
  // impose d'ATTENDRE qu'ils soient en poche — assez pour le toit ET les côtés ouverts — au lieu de miner
  // les parois de son propre abri comme avant.
  const feet = bot.entity.position.floored();
  const roofed0 = _solid(bot.blockAt(feet.offset(0, 2, 0)));
  // Un toit contre la paroi coûte 1 bloc ; sans paroi autour de la case (puits de 2, cellule murée), 2 (support + toit).
  const roofDirect = _CARD.some(([dx, dz]) => _solid(bot.blockAt(feet.offset(dx, 2, dz))));
  const need = (roofed0 ? 0 : (roofDirect ? 1 : 2)) + _openSides(bot, feet);
  if (need > 0 && depth > 0) await _waitCellBlocks(bot, sleep, need);
  const hadBlock = cellBlockCount(bot) > 0;
  let roof = { ok: roofed0, placed: 0, how: 'natural' };
  if (!roof.ok && hadBlock) {
    const rr = await bounded(_placeRoof(bot, feet), stageMs);
    roof = rr.ok && rr.value ? rr.value : { ok: false, placed: 0, how: null };
  }
  placed += roof.placed || 0;
  if (roof.ok && roof.how !== 'natural') emit({ type: 'shelter', action: 'roofed', how: roof.how });
  if (!roof.ok && !hadBlock) emit({ type: 'shelter', action: 'no_roof' });

  // ── 4) COLMATER ce qui reste ouvert aux pieds ou à la tête (grotte voisine, cellule murée incomplète)
  if (_openSides(bot, feet) > 0 && cellBlockItem(bot)) {
    const sr = await bounded(seal(bot, feet), stageMs);
    const n = sr.ok ? sr.value : 0;
    placed += Number(n && n.placed != null ? n.placed : n) || 0;
  }
  const open = _openSides(bot, feet);
  const roofed = _solid(bot.blockAt(feet.offset(0, 2, 0)));
  const sealed = roofed && open === 0;
  const why = sealed ? 'ok' : (!roofed ? (hadBlock ? 'roof_failed' : 'no_block') : 'open_sides');
  line({ sealed, why, mode, depth, open, roof: roof.how || null });
  return { ok: true, mode, depth };
}

/**
 * shelterUntilDawn(bot, token, deps) → {ok, reason?} — creuse, se couvre, attend l'aube, remonte.
 * deps.sleep injectable ; maxWaitMs borne l'attente (nuit MC ≈ 7 min réels ; déf 12 min).
 * deps.hostilesNear (() => nb d'hostiles à portée) + deps.worn (() => nb de pièces portées) : l'attente
 * des monstres à l'aube (étape 3bis) — SANS hostilesNear injecté, elle est sautée (comportement d'origine).
 * deps.dawnWaitMaxMs / deps.dawnCheckMs : borne (déf 120 s) et pas (déf 3 s) de cette attente.
 * deps.whileSealed (async ({mode, depth, anchor}) => null | 'leave_down') : travail DANS le trou pendant
 * l'attente de nuit (crafts) ; 'leave_down' → {ok:true, reason:'night_work', handoff:'night_work'} SANS sortie.
 * deps.endWhenDisplaced (booléen ou () => booléen, relu au délogement) : un bot DÉLOGÉ de son trou (cf.
 * shelterDisplaced) termine l'abri → {ok:false, reason:'displaced'} (sans lui : comportement d'origine).
 */
async function shelterUntilDawn(bot, token = null, deps = {}) {
  const sleep = deps.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const emit = deps.emit || (() => {});
  const maxWaitMs = deps.maxWaitMs || 12 * 60 * 1000;
  emit({ type: 'shelter', action: 'dig_in' });

  // 1-2) la CELLULE : creuser (ou se murer), se couvrir, colmater — une ligne `sealed` par abri.
  const cellRes = await _buildCell(bot, token, deps, sleep, emit);
  if (!cellRes.ok) return { ok: false, reason: cellRes.reason };
  const dugIn = cellRes.mode === 'pit';
  // MARQUE « scellé, pas encore sorti » (live 21/10, NethBot1 : une migration préemptée pendant
  // l'attente de l'aube — `w.cancelled` ci-dessous — ne sort PAS du trou, « le nouveau maître décide »
  // (test épinglé). Mais le nouveau maître (migrateZone) ne le savait JAMAIS : il tentait de marcher
  // alors que le bot restait muré, `moved:0` à chaque jambe, jusqu'à ce que le watchdog jam_loop
  // abandonne — plusieurs minutes perdues. `bot._mcaShelterPending` est le pont : posé ici, lu par
  // `exitPendingShelter` (export), effacé dès que l'abri sort PROPREMENT (lui-même ou le nouveau maître).
  _markShelterPending(bot, cellRes, dugIn);

  // ANCRE de l'abri, relevée une fois le bot terré et couvert. COPIE des coordonnées : `entity.position`
  // est un Vec3 MUTÉ EN PLACE par le serveur (piège #73d) — une référence gardée « bougerait » avec lui.
  const _p0 = bot.entity && bot.entity.position;
  const anchor = _p0 ? { x: _p0.x, y: _p0.y, z: _p0.z } : null;
  // Délogé ? → tracé UNE fois (l'abri se termine dans la foulée), avec l'écart mesuré. OPT-IN
  // (`deps.endWhenDisplaced`, booléen ou prédicat relu au moment du délogement — posé par la discipline
  // de nuit pour un bot NU) : sans lui, l'abri attend l'aube comme avant, où que soit le bot.
  const endOnLeave = () => {
    try { return typeof deps.endWhenDisplaced === 'function' ? !!deps.endWhenDisplaced() : !!deps.endWhenDisplaced; }
    catch (e) { return false; }   // prédicat qui lève → comportement d'origine
  };
  const left = () => {
    if (!deps.endWhenDisplaced) return false;
    const p = bot.entity && bot.entity.position;
    if (!shelterDisplaced(anchor, p) || !endOnLeave()) return false;
    emit({ type: 'shelter', action: 'displaced',
      dist: Math.round(Math.hypot(p.x - anchor.x, p.z - anchor.z)), dy: Math.round(p.y - anchor.y) });
    return true;
  };

  // 3) attendre l'aube (borné, annulable) — les réflexes survie tournent en parallèle. Un bot DÉLOGÉ
  // (cf. shelterDisplaced) n'attend plus rien : l'abri se termine, l'appelant décide (se ré-abriter).
  const t0 = Date.now();
  while (isNight(bot) && Date.now() - t0 < maxWaitMs) {
    if (token && token.cancelled) return { ok: false, reason: 'cancelled' };
    await sleep(5000);
    if (left()) { _clearShelterPending(bot); return { ok: false, reason: 'displaced' }; }
    // TRAVAILLER DANS LE TROU (22/10, chrono « zéro → fer » : 9 min immobiles à la 1re nuit avec des
    // bûches en poche). `deps.whileSealed(info)` (OPT-IN, index.js) : appelé à chaque pas de l'attente,
    // il crafte avec ce que le bot a en poche (sans sortir) et peut rendre 'leave_down' : le bot a une
    // pioche, il quitte l'abri PAR LE BAS (escalier de la nuit au travail) — on ne casse PAS le toit et on
    // ne remonte pas : aucune ouverture vers la surface la nuit. Hook qui lève = rien (attente normale).
    if (typeof deps.whileSealed === 'function' && cellRes.ok) {
      let act = null;
      try { act = await deps.whileSealed({ mode: cellRes.mode, depth: cellRes.depth || 0, anchor }); }
      catch (e) { act = null; }
      if (token && token.cancelled) return { ok: false, reason: 'cancelled' };
      if (act === 'leave_down') {
        emit({ type: 'shelter', action: 'handoff', to: 'night_work', mode: cellRes.mode, depth: cellRes.depth || 0 });
        _clearShelterPending(bot);
        return { ok: true, reason: 'night_work', handoff: 'night_work', mode: cellRes.mode, depth: cellRes.depth || 0, anchor };
      }
    }
  }
  emit({ type: 'shelter', action: 'dawn' });

  // 3bis) L'AUBE N'EST PAS LA FIN DES MONSTRES : bot nu + hostiles dehors → on reste (borné 120 s).
  // Branchement explicite : sans `deps.hostilesNear` l'attente n'existe pas (comportement d'origine).
  if (typeof deps.hostilesNear === 'function' || typeof deps.exitThreats === 'function') {
    const w = await _waitOutDawnMobs(bot, token, deps, emit, sleep, left);
    if (w.cancelled) return { ok: false, reason: 'cancelled' };
    if (w.displaced) { _clearShelterPending(bot); return { ok: false, reason: 'displaced' }; }
  }

  // 4) ressortir : casser le toit éventuel puis remonter en pilier (#7)
  const res = await _exitCell(bot, token, deps, cellRes, dugIn);
  _clearShelterPending(bot);
  return res;
}

/** Étape 4 (extraite, réutilisée par `exitPendingShelter`) : casser le toit éventuel, percer une paroi
 *  (muré) ou remonter en pilier (creusé). Best-effort, bornée comme avant — comportement inchangé. */
async function _exitCell(bot, token, deps, cellRes, dugIn) {
  const emit = deps.emit || (() => {});
  try {
    const roof = bot.blockAt(bot.entity.position.floored().offset(0, 2, 0));
    if (roof && roof.boundingBox === 'block') await _digWithTool(bot, roof, token);
  } catch (e) {}
  if (!dugIn) {
    // Muré au niveau du sol : on n'est pas dans un trou, donc pas de pilier — on perce une paroi.
    try {
      const feet = bot.entity.position.floored();
      for (const d of [new Vec3(1, 0, 0), new Vec3(-1, 0, 0), new Vec3(0, 0, 1), new Vec3(0, 0, -1)]) {
        const w = bot.blockAt(feet.plus(d));
        if (w && w.boundingBox === 'block' && w.name !== 'bedrock') { await _digWithTool(bot, w, token); break; }
      }
    } catch (e) { /* best-effort */ }
    emit({ type: 'shelter', action: 'out', ok: true, mode: 'walled' });
    _afterExit(deps);
    return { ok: true };
  }
  // Pilier de la hauteur RÉELLEMENT creusée : il rebouche le puits en remontant (aucun trou laissé dans le
  // monde), et à 3 de profondeur il ramène les pieds au niveau du sol.
  const pr = await bounded(pillarUp(bot, { height: Math.max(1, cellRes.depth || 2) }, token, { sleep: deps.pillarSleep || deps.sleep }),
    Number.isFinite(deps.pillarTimeoutMs) && deps.pillarTimeoutMs > 0 ? deps.pillarTimeoutMs : SHELTER_PILLAR_MS);
  if (!pr.ok) _stopAll(bot);
  const up = pr.ok && pr.value ? pr.value : { ok: false, reason: 'timeout' };
  emit({ type: 'shelter', action: 'out', ok: up.ok });
  _afterExit(deps);
  return { ok: true };
}

/** Pose/efface le marqueur « abri scellé, sortie différée » (bot._mcaShelterPending). Pur best-effort. */
function _markShelterPending(bot, cellRes, dugIn) {
  if (!bot || !cellRes || !cellRes.ok) return;
  bot._mcaShelterPending = { mode: cellRes.mode, depth: cellRes.depth || 1, dugIn: !!dugIn };
}
function _clearShelterPending(bot) {
  if (bot) bot._mcaShelterPending = null;
}

/**
 * Le « nouveau maître » (migration, watchdog…) qui prend la main sur un bot APPELLE CECI avant de le
 * faire marcher : si `shelterUntilDawn` l'a laissé scellé (cancelled/timeout sans sortie — « le nouveau
 * maître décide », cf. test), on l'en fait sortir ICI, maintenant, au lieu de laisser une jambe de
 * migration échouer `moved:0` en boucle jusqu'à ce que le watchdog jam_loop abandonne (minutes perdues,
 * live NethBot1 21/10). No-op si rien n'est en attente (bot jamais scellé, ou déjà ressorti proprement).
 * `token` est volontairement celui du NOUVEAU maître (peut être non annulé même si l'ancien l'était) :
 * creuser pour sortir n'est jamais refusé à cause d'une annulation qui nous appartient déjà.
 */
async function exitPendingShelter(bot, token = null, deps = {}) {
  const pending = bot && bot._mcaShelterPending;
  if (!pending) return { ok: true, pending: false };
  _clearShelterPending(bot);
  await _exitCell(bot, token, deps, { ok: true, mode: pending.mode, depth: pending.depth }, pending.dugIn);
  return { ok: true, pending: true };
}

/** Sorti : `deps.onExit` (s'éloigner des hostiles en vue, index.js). Best-effort, jamais de throw. */
function _afterExit(deps) {
  if (typeof deps.onExit !== 'function') return;
  try { deps.onExit(); } catch (e) { /* best-effort */ }
}

/**
 * Décision PURE : comment obtenir le bloc-toit pour sceller l'abri ?
 * inv = [{name,count}] ; ctx = { hasPickaxe, groundMineable }.
 * → { source: 'inventory' | 'mine' | 'none' }.
 */
function roofPlan(inv, ctx = {}) {
  for (const it of inv || []) if (POSABLE.has(it.name) && (it.count || 0) > 0) return { source: 'inventory' };
  if (ctx.groundMineable || ctx.hasPickaxe) return { source: 'mine' };
  return { source: 'none' };
}

/**
 * Décision PURE : faut-il se mettre à l'abri MAINTENANT ? Robuste au niveau de lumière inconnu
 * (mineflayer ne le livre pas toujours) : retombe sur la présence d'hostiles.
 * sig = { night, lightLevel (0-15|null), naked, lowHp, hostilesNear, proactive, underground }.
 * → { shelter: bool, reason }.
 */
function shouldShelter(sig = {}) {
  // SOUS TERRE : jamais d'abri (Massii 16/07) — il y fait TOUJOURS sombre et le mineur en chaîne
  // armure est nu par définition → le trigger 'dark' l'enterrait 10-13 min en boucle DANS sa mine,
  // où « attendre l'aube » ne protège de rien (les mobs de grotte spawnent jour et nuit). Les
  // réflexes combat/fuite + ban-zone couvrent les hostiles souterrains.
  if (sig.underground) return { shelter: false, reason: 'underground' };
  const dark = (sig.lightLevel != null && sig.lightLevel <= 7);
  if (sig.night && (sig.proactive || sig.naked || sig.lowHp)) return { shelter: true, reason: 'night' };
  if (dark && (sig.naked || sig.lowHp || sig.hostilesNear)) return { shelter: true, reason: 'dark' };
  if (sig.hostilesNear && (sig.naked || sig.lowHp)) return { shelter: true, reason: 'hostiles' };
  return { shelter: false, reason: 'safe' };
}

module.exports = {
  isNightTime, isNight, shelterUntilDawn, exitPendingShelter, roofPlan, shouldShelter,
  dawnExitDecision, DAWN_WAIT_MAX_MS, DAWN_WAIT_CHECK_MS, DAWN_WAIT_MIN_WORN,
  dawnExitPlan, DAWN_SAFE_EXIT_MAX_MS, DAWN_SAFE_CHECK_MS, DAY_SAFE_END,
  shelterDisplaced, SHELTER_DISPLACED_BLOCKS,
  createSpotMemory, cellBlockItem, SHELTER_PIT_DEPTH, SHELTER_MIN_DEPTH, CELL_BLOCKS,
  SHELTER_STAGE_MS, SHELTER_PILLAR_MS,
};
