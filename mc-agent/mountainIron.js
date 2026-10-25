'use strict';
// FER DES MONTAGNES (25/10, run Hard keepInventory OFF : 53 morts en 4 h, surtout en descente et en grotte).
//
// Config anti-xray du serveur (Paper, vérifiée) : `engine-mode: 1`, `max-block-height: 64`. Au-dessus de
// y = 64 les minerais ne sont PAS masqués : dans une colline ou une montagne, le fer est envoyé au client tel
// quel, même enterré dans la roche — `bot.findBlocks` le voit. Un joueur qui voit du fer à flanc de colline
// ne descend pas à Y16 : il creuse jusqu'à lui, à la lumière du jour, sans grotte ni descente.
// Sous 64, un minerai enterré est masqué : on n'y touche pas ici (c'est le travail d'iron_cave/iron_deep).
//
// Module PUR (zéro I/O) : filtrage, grappes, choix, portes. Le câblage (scan, trajet, minage) vit dans
// index.js (runMountainIron).

const MOUNTAIN_MIN_Y = 65;            // strictement au-dessus de max-block-height (64) : jamais masqué
const MOUNTAIN_SCAN_DIST = 56;        // rayon du scan findBlocks (borné : coût synchrone, piège #43a)
const MOUNTAIN_SCAN_COUNT = 64;       // borne en nombre du scan
const MOUNTAIN_MAX_DIST = 56;         // grappe visée à ≤ 56 blocs 3D
const MOUNTAIN_BOT_MIN_Y = 50;        // le bot doit être en surface (sous terre, le fer de montagne est loin)
const MOUNTAIN_MIN_HP = 10;           // blessé : pas de chantier de surface
const MOUNTAIN_FAIL_TTL_MS = 30 * 60 * 1000;   // grappe ratée : mise de côté 30 min
const MOUNTAIN_FAILS_MAX = 40;
const MOUNTAIN_CLUSTER_GAP = 2;       // deux minerais à ≤ 2 blocs (Chebyshev) = même grappe
const MOUNTAIN_MAX_MS = 4 * 60 * 1000;   // un chantier = 4 min au plus, trajet compris

const IRON_NAMES = new Set(['iron_ore', 'deepslate_iron_ore']);

function _fin(n) { return typeof n === 'number' && Number.isFinite(n); }
function _valid(o) { return o && _fin(o.x) && _fin(o.y) && _fin(o.z); }

/**
 * PUR — positions brutes (findBlocks + nom) → minerais de fer de montagne, forme {material,x,y,z,wet}.
 * `isWet(p)` optionnel : un minerai à ≤ 2 blocs de l'eau est écarté (anti-noyade, même règle que la carte).
 */
function mountainOres(raw, isWet) {
  const out = [];
  const seen = new Set();
  for (const o of Array.isArray(raw) ? raw : []) {
    if (!_valid(o) || !IRON_NAMES.has(o.material)) continue;
    const p = { x: Math.floor(o.x), y: Math.floor(o.y), z: Math.floor(o.z) };
    if (p.y < MOUNTAIN_MIN_Y) continue;
    const k = p.x + ',' + p.y + ',' + p.z;
    if (seen.has(k)) continue;
    seen.add(k);
    let wet = false;
    try { wet = typeof isWet === 'function' ? !!isWet(p) : false; } catch (e) { wet = false; }
    if (wet) continue;
    out.push({ material: o.material, x: p.x, y: p.y, z: p.z });
  }
  return out;
}

/** PUR — grappes (composantes connexes à ≤ MOUNTAIN_CLUSTER_GAP blocs, Chebyshev). */
function mountainClusters(ores) {
  const list = (Array.isArray(ores) ? ores : []).filter(_valid);
  const used = new Array(list.length).fill(false);
  const out = [];
  for (let i = 0; i < list.length; i++) {
    if (used[i]) continue;
    used[i] = true;
    const comp = [list[i]];
    for (let q = 0; q < comp.length; q++) {
      const a = comp[q];
      for (let j = 0; j < list.length; j++) {
        if (used[j]) continue;
        const b = list[j];
        if (Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y), Math.abs(a.z - b.z)) <= MOUNTAIN_CLUSTER_GAP) {
          used[j] = true;
          comp.push(b);
        }
      }
    }
    out.push(comp);
  }
  return out;
}

/** Clé stable d'une grappe : son minerai le plus bas puis le plus petit x,z (ne dépend pas de l'ordre). */
function mountainKey(comp) {
  const s = comp.slice().sort((a, b) => (a.y - b.y) || (a.x - b.x) || (a.z - b.z))[0];
  return 'mtn:' + s.x + ',' + s.y + ',' + s.z;
}

/** PUR — mises de côté encore actives (≤ 30 min, horloge du futur écartée). */
function mountainFailsPrune(fails, now) {
  if (!Array.isArray(fails) || !_fin(now)) return [];
  return fails.filter((f) => f && typeof f.key === 'string' && _fin(f.at) && f.at <= now
    && now - f.at < MOUNTAIN_FAIL_TTL_MS);
}

/** PUR — note un essai (raté ou terminé) : la grappe ne sera plus visée pendant 30 min. */
function mountainFailAdd(fails, key, why, now) {
  const kept = mountainFailsPrune(fails, now).filter((f) => f.key !== key);
  kept.push({ key: String(key), why: String(why || 'failed'), at: now });
  return kept.slice(-MOUNTAIN_FAILS_MAX);
}

/**
 * PUR — la grappe de fer de montagne à viser, ou null.
 * opts = { now, fails, isClaimed(key), maxDist }.
 * Coût = distance 3D + la moitié de la montée (grimper coûte plus que marcher) − 3 par minerai en plus
 * (une grappe de 4 vaut un détour de ~9 blocs). Cible = minerai de la grappe le plus proche du bot.
 */
function pickMountainIron(ores, from, opts = {}) {
  if (!_valid(from)) return null;
  const maxDist = _fin(opts.maxDist) ? opts.maxDist : MOUNTAIN_MAX_DIST;
  const now = _fin(opts.now) ? opts.now : 0;
  const failed = new Set(mountainFailsPrune(opts.fails, now).map((f) => f.key));
  let best = null;
  for (const comp of mountainClusters(ores)) {
    const key = mountainKey(comp);
    if (failed.has(key)) continue;
    try { if (typeof opts.isClaimed === 'function' && opts.isClaimed(key)) continue; } catch (e) { /* non claimée */ }
    const sorted = comp.map((o) => Object.assign({}, o, { dist: Math.hypot(o.x - from.x, o.y - from.y, o.z - from.z) }))
      .sort((a, b) => a.dist - b.dist);
    const near = sorted[0];
    if (near.dist > maxDist) continue;
    const cost = near.dist + 0.5 * Math.max(0, near.y - from.y) - 3 * (comp.length - 1);
    if (!best || cost < best.cost) {
      best = { key, x: near.x, y: near.y, z: near.z, count: comp.length, dist: Math.round(near.dist * 10) / 10,
        cost, ores: sorted.map(({ dist, ...o }) => o) };
    }
  }
  if (!best) return null;
  delete best.cost;
  return best;
}

/**
 * PUR — le fer de montagne est-il envisageable maintenant ?
 * sig = { objectiveOk, pickTier, hp, y, night, worn, inWater }
 * → { ok, why }. La NUIT, un bot à moins de 2 pièces ne fait pas de chantier de surface (règle de nuit).
 */
function mountainGate(sig = {}) {
  const s = sig || {};
  if (!s.objectiveOk) return { ok: false, why: 'objective' };
  if (!(_fin(s.pickTier) && s.pickTier >= 2)) return { ok: false, why: 'no_pick' };   // pioche pierre+ (toolGuard)
  if (_fin(s.hp) && s.hp < MOUNTAIN_MIN_HP) return { ok: false, why: 'low_hp' };
  if (!_fin(s.y) || s.y < MOUNTAIN_BOT_MIN_Y) return { ok: false, why: 'underground' };
  if (s.inWater) return { ok: false, why: 'water' };
  if (s.night && !(_fin(s.worn) && s.worn >= 2)) return { ok: false, why: 'night' };
  return { ok: true, why: 'ok' };
}

module.exports = {
  mountainOres, mountainClusters, mountainKey, mountainFailsPrune, mountainFailAdd, pickMountainIron, mountainGate,
  MOUNTAIN_MIN_Y, MOUNTAIN_SCAN_DIST, MOUNTAIN_SCAN_COUNT, MOUNTAIN_MAX_DIST, MOUNTAIN_BOT_MIN_Y, MOUNTAIN_MIN_HP,
  MOUNTAIN_FAIL_TTL_MS, MOUNTAIN_MAX_MS, IRON_NAMES,
};
