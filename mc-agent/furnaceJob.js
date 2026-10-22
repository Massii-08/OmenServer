'use strict';
// FONDRE EN MINANT (Massii 21/10 : « fais qu'ils fassent comme les joueurs normaux »).
//
// Un joueur au fond de sa mine pose son four, y met son fer et son charbon, et CONTINUE de miner ; il
// repasse prendre ses lingots. Le bot, lui, fondait debout devant le four (smelt : poll ≤ 3 min, 10 s par
// minerai, `_stillBusy`), ou pas du tout tant que le branch-mine tournait (le timer de fonte
// opportuniste attend que le bot ne creuse plus). Ici la décision PURE d'un « travail de four » laissé
// derrière soi ; le câblage vit dans index.js (hook de survie du branch-mine).

const SMELT_JOB_MIN_RAW = 8;              // on lance un four dès 8 minerais (Massii : « dès qu'il y en a 8+ »)
const SMELT_JOB_MAX = 64;                 // une pile
const SMELT_ITEM_MS = 10000;              // 10 s par objet dans un four vanilla
const SMELT_JOB_MARGIN_MS = 3000;
const SMELT_JOB_COLLECT_DIST = 48;        // au-delà, on attend d'être revenu (fin de branche, fin du but)
const SMELT_JOB_ABANDON_DIST = 96;        // ≈ la distance de simulation : plus loin le four ne cuit plus
// 22/10 (NethBot1/3, chrono armure de fer) : 44 + 13 minerais de fer laissés dans des fours de mine —
// « oubliés » au bout de 20 min, à 96 blocs, ou par une relance du process. Le contenu d'un four ne
// disparaît pas : on ne l'oublie qu'au bout de 2 h, et loin on ATTEND (cf. furnaceCollectRoute).
const SMELT_JOB_ABANDON_MS = 2 * 3600 * 1000;
const FURNACE_RETRY_MS = 3 * 60 * 1000;   // après une ouverture ratée : on ne re-tente pas avant 3 min
const FURNACE_WORK_NEAR = 16;             // le chantier `work` est « au four » s'il est à ≤ 16 blocs (XZ)

/** PUR — unités de fonte d'un combustible (vanilla : charbon 8, planche 1,5, bûche 1,5). */
function fuelValue(name) {
  if (name === 'coal' || name === 'charcoal') return 8;
  if (typeof name === 'string' && (name.endsWith('_planks') || name.endsWith('_log'))) return 1.5;
  return 0;
}

/**
 * PUR — quel combustible charger pour fondre `count` objets ? Charbon d'abord (le bois sert aux outils),
 * puis planches, puis bûches. items = [{name,count}]. → { loads: [{name, qty}], units, smeltable }.
 * `smeltable` = ce que le combustible chargé permet réellement de fondre (≤ count).
 */
function fuelLoadPlan(items, count) {
  const want = Math.max(0, Math.floor(Number(count) || 0));
  const totals = {};
  for (const it of items || []) {
    if (!it || !it.name || !(fuelValue(it.name) > 0)) continue;
    totals[it.name] = (totals[it.name] || 0) + (it.count || 0);
  }
  const rank = (n) => (n === 'coal' ? 0 : n === 'charcoal' ? 1 : n.endsWith('_planks') ? 2 : 3);
  // Un four n'a qu'UN emplacement de combustible : une seule sorte par chargement — celle qui fond le
  // plus (jusqu'à `want`), à égalité le charbon avant le bois.
  let best = null;
  for (const n of Object.keys(totals)) {
    const v = fuelValue(n);
    const qty = Math.min(totals[n], Math.ceil(want / v));
    const cover = Math.min(want, Math.floor(qty * v));
    if (qty <= 0) continue;
    if (!best || cover > best.cover || (cover === best.cover && rank(n) < rank(best.name))) best = { name: n, qty, cover, units: qty * v };
  }
  const loads = best ? [{ name: best.name, qty: best.qty }] : [];
  const units = best ? best.units : 0;
  return { loads, units, smeltable: Math.min(want, Math.floor(units)) };
}

/**
 * PUR — quoi faire du four de mine ?
 * sig = { job: {pos, count, at, readyAt} | null, raw, hasFurnace, items, now, dist (au four, null = ?) }
 * → { act: 'start', count } | { act: 'collect' } | { act: 'abandon', why } | { act: 'wait' } | { act: null }
 */
function furnaceJobPlan(sig = {}) {
  const s = sig || {};
  const now = Number(s.now) || 0;
  if (s.job) {
    const d = Number(s.dist);
    if (now - (Number(s.job.at) || 0) > SMELT_JOB_ABANDON_MS) return { act: 'abandon', why: 'old' };
    // Loin : le fer ATTEND dans le four (on y repassera, cf. furnaceCollectRoute). On ne l'abandonne
    // que si l'on peut relancer un four ICI (sinon on perdrait le vieux sans rien gagner).
    if (s.dist != null && Number.isFinite(d) && d > SMELT_JOB_ABANDON_DIST) {
      const raw = Math.max(0, Number(s.raw) || 0);
      const fuel = raw >= SMELT_JOB_MIN_RAW && s.hasFurnace ? fuelLoadPlan(s.items, Math.min(raw, SMELT_JOB_MAX)) : null;
      if (fuel && fuel.smeltable >= SMELT_JOB_MIN_RAW) return { act: 'abandon', why: 'far' };
      return { act: 'wait' };
    }
    if (now < (Number(s.job.readyAt) || 0)) return { act: 'wait' };
    if (s.dist != null && Number.isFinite(d) && d <= SMELT_JOB_COLLECT_DIST) return { act: 'collect' };
    return { act: 'wait' };
  }
  const raw = Math.max(0, Number(s.raw) || 0);
  if (raw < SMELT_JOB_MIN_RAW || !s.hasFurnace) return { act: null };
  const fuel = fuelLoadPlan(s.items, Math.min(raw, SMELT_JOB_MAX));
  if (fuel.smeltable < SMELT_JOB_MIN_RAW) return { act: null };
  return { act: 'start', count: fuel.smeltable };
}

/** PUR — instant où un four lancé à `now` avec `count` objets a fini. */
function jobReadyAt(now, count) {
  return (Number(now) || 0) + Math.max(0, Number(count) || 0) * SMELT_ITEM_MS + SMELT_JOB_MARGIN_MS;
}

/**
 * PUR — relit le four de mine du mémo de base (relance du process : le four et son fer restent au fond).
 * → job valide ou null (mémo absent, abîmé, périmé, ou daté du futur = mémo d'un autre monde).
 */
function furnaceJobRestore(memo, now) {
  const j = memo && memo.furnaceJob;
  if (!j || typeof j !== 'object' || !j.pos) return null;
  const { x, y, z } = j.pos;
  if (![x, y, z].every((v) => typeof v === 'number' && Number.isFinite(v))) return null;
  const at = Number(j.at);
  const t = Number(now) || 0;
  if (!Number.isFinite(at) || at > t || t - at > SMELT_JOB_ABANDON_MS) return null;
  return j;
}

/**
 * PUR — comment aller ramasser le four de mine ?
 * sig = { dist (3D, null = ?), dy (bot.y - four.y), workDist (chantier `work` ↔ four, XZ ; null = pas de
 * chantier), inWater } → 'here' | 'walk' | 'warp_work' | 'later'.
 * Vécu 22/10 (NethBot1) : four 40 blocs SOUS la surface, bot remonté au /home safe → 40 s de pathfinder
 * vers le four à chaque but, 8 ouvertures ratées, fonte d'armure bloquée 14 min. Le chantier `work`
 * était posé à côté du four : un /home work et on y est.
 */
function furnaceCollectRoute(sig = {}) {
  const s = sig || {};
  const d = Number(s.dist);
  if (s.dist == null || !Number.isFinite(d)) return 'walk';
  if (d <= 3.5) return 'here';
  const dy = Number(s.dy) || 0;            // signé : > 0 = le bot est AU-DESSUS du four (remonté en surface)
  const w = Number(s.workDist);
  const workAtFurnace = s.workDist != null && Number.isFinite(w) && w <= FURNACE_WORK_NEAR && !s.inWater;
  if (workAtFurnace && (d > 24 || dy > 8)) return 'warp_work';
  if (d <= SMELT_JOB_COLLECT_DIST) return 'walk';
  return 'later';
}

module.exports = {
  FURNACE_RETRY_MS, FURNACE_WORK_NEAR, furnaceJobRestore, furnaceCollectRoute,
  SMELT_JOB_MIN_RAW, SMELT_JOB_MAX, SMELT_ITEM_MS, SMELT_JOB_COLLECT_DIST, SMELT_JOB_ABANDON_DIST, SMELT_JOB_ABANDON_MS,
  fuelValue, fuelLoadPlan, furnaceJobPlan, jobReadyAt,
};
