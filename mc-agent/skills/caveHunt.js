'use strict';
// CAVE-FIRST (Massii, live 26/07 : « les diamants il les allait chercher dans les cave = pas de
// tunnel où ils creusent en continu, l'unique moment où ils creusent c'est quand ils passent d'une
// cave a l'autre » + « cave first mais jamais celle inondée c'est important »).
//
// L'objectif diamant se terminait par un branch-mine de 48 blocs × 16 galeries : un tunnel continu,
// la stratégie inverse. Ici on ne vise QUE des minerais déjà cartographiés, EXPOSÉS (visibles depuis
// une grotte) et SECS — l'exclusion des noyés est celle de `nextOreTarget`, active par défaut et
// non négociable (la survie prime, décision Massii après les noyades en série).
//
// Le creusement ne disparaît pas : il devient le TRAJET entre deux grottes. C'est l'appelant qui le
// fournit en repli quand plus aucune cible cave n'est connue (cf. dispatch `caveHunt` d'index.js) —
// borné et court, jamais un strip-mine.

const { nextOreTarget, oreBase, requiredPickTier, scanExposedOres, isWaterAdjacent } = require('../ores');

/**
 * Cible EXPOSÉE vue par le bot lui-même, ici et maintenant. (défaut de `opts.scanLocal`)
 *
 * Massii, live 26/07 : « ils ont plein de cave autour mais je ne vois aucun qui va vers ». La
 * première version ne consultait que la MÉMOIRE DE MONDE : sans minerai cartographié à proximité,
 * elle rendait `no_cave_target` et le bot se mettait à creuser — alors qu'une grotte pleine de
 * minerai était visible à dix blocs. Un bot a des yeux, pas seulement une carte.
 */
/** Noms de blocs d'un matériau : 'diamond' → diamond_ore + deepslate_diamond_ore. */
function oreNamesOf(material) {
  const b = oreBase(material);
  return [`${b}_ore`, `deepslate_${b}_ore`];
}

function _defaultScanLocal(bot, material, skip, maxDistance, out = null) {
  let best = null, bestD = Infinity;
  const p = bot.entity && bot.entity.position;
  if (!p) return null;
  // Scan RESTREINT au matériau cherché (24/10) : un scan « 40 minerais les plus proches, tous types »
  // rendait charbon/redstone/fer et jamais le diamant de la grotte à 25 blocs.
  let n = 0;
  for (const o of (scanExposedOres(bot, { maxDistance, count: 40, names: oreNamesOf(material) }) || [])) {
    if (oreBase(o.material) !== oreBase(material)) continue;
    if (nearSkipped(skip, o)) continue;     // la GRAPPE entière, pas seulement le bloc raté
    try { if (isWaterAdjacent(bot, o)) continue; } catch (e) { /* pas d'info → on garde */ }
    n++;
    const d = Math.hypot(o.x - p.x, o.y - p.y, o.z - p.z);
    if (d < bestD) { bestD = d; best = o; }
  }
  if (out) out.count = n;
  return best;
}

/**
 * Cibles inatteignables mises de côté ENTRE deux appels (24/10 : 203 `cave_unreachable` pour 91 cibles
 * distinctes en 106 min — le Set local à chaque appel faisait retenter les mêmes à chaque reprise du but).
 * TTL : une grotte peut devenir atteignable (un coéquipier l'a ouverte, le bot est ailleurs).
 */
function createSkipStore(ttlMs = 20 * 60 * 1000, nowFn = Date.now) {
  const m = new Map();
  const live = (k) => { const t = m.get(k); if (t == null) return false; if (nowFn() - t >= ttlMs) { m.delete(k); return false; } return true; };
  return {
    add(k) { m.set(k, nowFn()); },
    has(k) { return live(k); },
    keys() { return [...m.keys()].filter(live); },
    size() { return this.keys().length; },
    clear() { m.clear(); },
  };
}
const sharedSkipStore = createSkipStore();

/**
 * Mise de côté par GRAPPE (24/10, NethBot1 : (120,-9,108) puis (119,-9,109) puis (120,-8,108) — trois blocs
 * de la MÊME grappe retentés l'un après l'autre, 20 s perdues sur une grappe déjà jugée inatteignable).
 * Un bloc à ≤ CLUSTER_R d'une clé mise de côté l'est aussi. PUR.
 */
const CLUSTER_R = 4;
const keyOf = (t) => `${t.x},${t.y},${t.z}`;
function parseKey(k) {
  const a = String(k).split(',').map(Number);
  return a.length === 3 && a.every(Number.isFinite) ? { x: a[0], y: a[1], z: a[2] } : null;
}
function nearSkipped(keys, t, r = CLUSTER_R) {
  if (!keys || !t) return false;
  if (typeof keys.has === 'function' && keys.has(keyOf(t))) return true;
  for (const k of keys) {
    const q = parseKey(k);
    if (q && Math.hypot(q.x - t.x, q.y - t.y, q.z - t.z) <= r) return true;
  }
  return false;
}

/**
 * Temps accordé à l'approche d'un minerai VISIBLE (24/10) : ce qu'il faut à un joueur pour marcher puis
 * creuser jusqu'à lui — 30 s + 1,5 s par bloc, borné à [45 s, 90 s]. PUR.
 */
function approachBudgetMs(dist) {
  const d = Number.isFinite(dist) ? Math.max(0, dist) : 64;
  return Math.max(45000, Math.min(90000, Math.round(30000 + 1500 * d)));
}

/**
 * Prochaine JAMBE vers la cible (24/10) : un point à `step` blocs sur le segment bot → minerai, y RÉEL
 * interpolé (les deux extrémités sont réelles : on creuse la ligne). Assez proche → la cible elle-même.
 * Sert à l'approche en creusant quand un seul but lointain rend NoPath (A* borné dans la roche pleine) :
 * montée comme descente, par jambes courtes. PUR.
 */
function legWaypoint(from, to, step = 8) {
  if (!from || !to) return null;
  const dx = to.x - from.x, dy = to.y - from.y, dz = to.z - from.z;
  const d = Math.hypot(dx, dy, dz);
  if (!(d > step + 2)) return { x: to.x, y: to.y, z: to.z, last: true };
  const k = step / d;
  return { x: Math.round(from.x + dx * k), y: Math.round(from.y + dy * k), z: Math.round(from.z + dz * k), last: false };
}

/** Résultat d'un `goTo` : booléen (historique), 'interrupted', ou { reached, interrupted, why }. PUR. */
function normalizeTravel(r) {
  if (r === true) return { reached: true, interrupted: false, why: null };
  if (r === 'interrupted') return { reached: false, interrupted: true, why: 'interrupted' };
  if (r && typeof r === 'object') return { reached: !!r.reached, interrupted: !!r.interrupted, why: r.why || null };
  return { reached: false, interrupted: false, why: 'unreachable' };
}

/** Coupures tolérées par grappe (un réflexe a pris le pathfinder) avant de la laisser pour cet appel. */
const MAX_INTERRUPTS = 3;

/** Meilleur palier de pioche en poche (0 = aucune). Sert à ne cibler que le minable. */
function pickTierOf(inv) {
  const t = { wooden_pickaxe: 1, stone_pickaxe: 2, iron_pickaxe: 3, diamond_pickaxe: 4, netherite_pickaxe: 5 };
  let best = 0;
  for (const name of Object.keys(t)) { if ((inv[name] || 0) > 0 && t[name] > best) best = t[name]; }
  return best;
}

/**
 * Chasse cave-first : enchaîne les minerais mappés EXPOSÉS et SECS du matériau demandé.
 *
 * opts:
 *   material   : 'diamond' (base d'ore, cf. oreBase)
 *   count      : nombre de minerais à ramener
 *   memory/world : mémoire de monde + clé (défaut bot._worldMemory / bot._worldKey)
 *   maxDist    : rayon de recherche autour du bot (défaut 256)
 *   goTo(pos)  : déplacement borné, injecté (défaut : pathfinder de l'appelant)
 *   mineAt(pos): minage + filon, injecté
 *   emit       : événements
 *
 * → { ok:true, got } | { ok:false, reason:'no_cave_target'|'no_pick'|'cancelled', got }
 * `no_cave_target` n'est PAS une erreur : c'est le signal « plus rien de visible ici, il faut
 * creuser vers la grotte suivante » — l'appelant enchaîne un trajet court.
 */
async function caveHunt(bot, opts = {}, token = null) {
  const material = opts.material || 'diamond';
  const need = opts.count || 1;
  // 64 blocs en 3D (24/10) : ce qu'un joueur va chercher avant de creuser à l'aveugle ; au-delà la
  // « cible » est une rumeur de la carte, derrière de la roche (96 → la moitié des cave_unreachable).
  const maxDist = opts.maxDist || 64;
  const emit = opts.emit || (() => {});
  const memory = opts.memory || bot._worldMemory || null;
  const world = opts.world || bot._worldKey || 'overworld';
  const goTo = opts.goTo;
  const mineAt = opts.mineAt;
  const pickNext = opts.nextOreTarget || nextOreTarget;

  const inv = {};
  for (const it of ((bot.inventory && bot.inventory.items()) || [])) inv[it.name] = (inv[it.name] || 0) + it.count;
  const tier = pickTierOf(inv);
  if (tier < requiredPickTier(material)) return { ok: false, reason: 'no_pick', got: 0 };

  const skip = new Set();
  const store = opts.skipStore || null;     // persistant entre appels (index : sharedSkipStore)
  if (store) { for (const k of store.keys()) skip.add(k); }
  const markSkip = (t) => { const k = keyOf(t); skip.add(k); if (store) store.add(k); };
  // Coupures (réflexe de combat, fuite, détour d'un timer, TP) : pas un verdict sur la grappe — on la
  // retente après que le pathfinder s'est libéré, au plus MAX_INTERRUPTS fois PAR GRAPPE et par appel.
  const interrupts = [];                     // [{ k, n }]
  const softSkip = new Set();                // grappes laissées pour CET appel (non persistées)
  const interruptCount = (t) => {
    for (const e of interrupts) { const q = parseKey(e.k); if (q && Math.hypot(q.x - t.x, q.y - t.y, q.z - t.z) <= CLUSTER_R) return e; }
    const e = { k: keyOf(t), n: 0 }; interrupts.push(e); return e;
  };
  const isDiamond = oreBase(material) === 'diamond';
  const nowFn = opts.now || Date.now;
  const result = (target, t0, outcome, extra = {}) => {
    if (!isDiamond) return;
    emit(Object.assign({ type: 'diamond_cave_result', outcome, took_s: Math.round((nowFn() - t0) / 100) / 10,
      mined: 0, why: null, x: target.x, y: target.y, z: target.z }, extra));
  };
  const maxAttempts = opts.maxAttempts || 40;  // garde anti-boucle chaude (goTo qui rend tout de suite)
  let attempts = 0;
  let got = 0;
  while (got < need) {
    if (token && token.cancelled) return { ok: false, reason: 'cancelled', got };
    // Blessé : pas de grotte (caveIron.caveHpOk) — l'appel sortait au plus tôt à la cible suivante, il
    // enchaînait 6 grappes à 5,9 PV (NethBot1, 24/10) pendant que les réflexes lui volaient le pathfinder.
    if (opts.hpOk && !opts.hpOk()) return { ok: got > 0, reason: got > 0 ? undefined : 'low_hp', got };
    if (++attempts > maxAttempts) return { ok: got > 0, reason: got > 0 ? undefined : 'attempts', got };
    const excluded = { has: (k) => skip.has(k) || softSkip.has(k), [Symbol.iterator]: function* () { yield* skip; yield* softSkip; } };
    const from = bot.entity && bot.entity.position ? bot.entity.position : null;
    // ORDRE : ce que le bot VOIT d'abord, la carte ensuite. Mesure live 26/07 : avec la carte en
    // premier, 95 cibles sur 98 étaient `cave_unreachable` et pas un seul diamant miné — on visait
    // des minerais cartographiés à des centaines de blocs, derrière de la roche pleine que le
    // pathfinder ne sait pas traverser. Un minerai VISIBLE est dans les chunks chargés, donc
    // atteignable ; un minerai cartographié n'est qu'une rumeur.
    const scanLocal = opts.scanLocal || _defaultScanLocal;
    const seen = { count: 0 };
    let target = scanLocal(bot, material, excluded, opts.localRange || 48, seen);
    if (target && nearSkipped(excluded, target)) target = null;   // scanLocal injecté qui ignore la grappe
    let src = target ? 'local' : null;
    if (target) emit({ type: 'cave_local', material, x: target.x, y: target.y, z: target.z });
    if (!target) {
      // La carte ne connaît que les clés exactes : une cible voisine d'une grappe mise de côté est
      // ajoutée au filtre exact et on redemande (borné).
      const exact = new Set([...skip, ...softSkip]);
      for (let i = 0; i < 32; i++) {
        target = pickNext(memory, world, from, {
          allowTypes: [oreBase(material)],
          exposedOnly: true,      // JAMAIS un minerai enterré : on n'exploite que le visible
          excludeWet: true,       // JAMAIS une grotte inondée (exigence explicite, non négociable)
          pickTier: tier,
          maxDist,
          skip: exact,
        });
        if (!target || !nearSkipped(excluded, target)) break;
        exact.add(keyOf(target));
        target = null;
      }
      if (target) src = 'memory';
    }
    if (!target) return { ok: got > 0, reason: got > 0 ? undefined : 'no_cave_target', got };

    emit({ type: 'cave_target', material, x: target.x, y: target.y, z: target.z, d: got });
    if (oreBase(material) === 'diamond') {
      const dist = from ? Math.round(Math.hypot(target.x - from.x, target.y - from.y, target.z - from.z)) : null;
      emit({ type: 'diamond_cave_target', x: target.x, y: target.y, z: target.z, dist, ores: seen.count || 1, src });
    }
    const t0 = nowFn();
    let tr;
    try { tr = normalizeTravel(await goTo(target)); } catch (e) { tr = { reached: false, interrupted: false, why: 'error' }; }
    if (token && token.cancelled) { result(target, t0, 'cancelled', { why: 'cancelled' }); return { ok: false, reason: 'cancelled', got }; }
    if (!tr.reached && tr.interrupted) {
      const e = interruptCount(target);
      e.n++;
      result(target, t0, 'interrupted', { why: tr.why || 'interrupted', tries: e.n });
      if (e.n >= MAX_INTERRUPTS) softSkip.add(keyOf(target));
      // Laisser le réflexe finir (fuite, couvert, détour) AVANT de reposer notre but : sinon on lui vole
      // le pathfinder à notre tour.
      if (opts.settle) { try { await opts.settle(); } catch (err) { /* best-effort */ } }
      continue;
    }
    if (!tr.reached) {
      markSkip(target);                                    // inatteignable → la grappe est mise de côté
      emit({ type: 'cave_unreachable', x: target.x, y: target.y, z: target.z });
      result(target, t0, 'unreachable', { why: tr.why || 'unreachable' });
      continue;
    }
    let mined = 0;
    try { mined = (await mineAt(target)) || 0; } catch (e) { mined = 0; }
    if (mined > 0) { got += mined; emit({ type: 'cave_mined', material, got }); result(target, t0, 'mined', { mined }); }
    else { markSkip(target); result(target, t0, 'empty', { why: 'nothing_mined' }); }
  }
  return { ok: true, got };
}

module.exports = {
  caveHunt, pickTierOf, createSkipStore, sharedSkipStore, oreNamesOf,
  CLUSTER_R, nearSkipped, approachBudgetMs, legWaypoint, normalizeTravel, MAX_INTERRUPTS,
};
