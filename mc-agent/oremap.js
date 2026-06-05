'use strict';
// Oremap partagée : store JSON multi-process (K cartographes + M bots ressources écrivent,
// le backend Python lit sans lock). Ce fichier contient (a) la LOGIQUE PURE (testable sans
// fs) et (b) le client store I/O (lock mkdir O_EXCL + écriture atomique tmp+rename) —
// cf. spec docs/superpowers/specs/2026-06-05-mc-agent-oremap-quota-design.md (décision D1).
const fs = require('fs');
const path = require('path');

// Claim TTL : un bot rafraîchit sa claim à chaque itération ; bot mort → claim expirée →
// l'ore redevient prenable par un autre bot (pas de coordination explicite nécessaire).
const CLAIM_TTL_MS = 120000;
const LOCK_STALE_MS = 10000;   // lock plus vieux que ça = process mort → on le vole
const LOCK_RETRY_MS = 50;
const LOCK_MAX_WAIT_MS = 5000;

// 10 IDs de blocs (1.20.1 ET 1.21.4) → 5 types logiques.
const ORE_TYPES = {
  diamond_ore: 'diamond', deepslate_diamond_ore: 'diamond',
  gold_ore: 'gold', deepslate_gold_ore: 'gold',
  redstone_ore: 'redstone', deepslate_redstone_ore: 'redstone',
  lapis_ore: 'lapis', deepslate_lapis_ore: 'lapis',
  iron_ore: 'iron', deepslate_iron_ore: 'iron',
};
const TYPES = ['diamond', 'gold', 'redstone', 'lapis', 'iron'];

function normalizeOreName(name) { return ORE_TYPES[name] || null; }

function emptyMap(runId, zone) {
  return { runId: runId || null, zone: zone || null, updatedAt: 0, ores: {}, bots: {} };
}

// Ajoute une liste de {name|type, x, y, z}. Dédup par clé "x,y,z" : une entrée existante
// n'est JAMAIS écrasée (un re-scan cartographe ne ressuscite pas une ore mined/gone et ne
// vole pas une claim). Retourne le nombre d'entrées réellement ajoutées.
function addOres(map, list, foundBy, now) {
  let added = 0;
  for (const o of list || []) {
    const type = TYPES.indexOf(o.type) !== -1 ? o.type : normalizeOreName(o.name);
    if (!type) continue;
    const k = `${o.x},${o.y},${o.z}`;
    if (map.ores[k]) continue;
    map.ores[k] = {
      type, x: o.x, y: o.y, z: o.z,
      foundBy: foundBy || null, at: now,
      claimedBy: null, claimedAt: 0, status: 'new',
    };
    added++;
  }
  return added;
}

function isClaimActive(ore, now, ttl) {
  return !!ore.claimedBy && (now - ore.claimedAt) < (ttl || CLAIM_TTL_MS);
}

// L'ore 'new' du type demandé la plus proche de `from`, hors claims actives d'AUTRES bots
// (sa propre claim est re-rendable : reprise idempotente) et hors Set `skip` local.
// Pose la claim avant de retourner. null si aucune dispo.
function claimNext(map, { type, from, username, now, ttl, skip }) {
  let best = null, bestD = Infinity;
  for (const k of Object.keys(map.ores)) {
    const o = map.ores[k];
    if (o.status !== 'new' || o.type !== type) continue;
    if (skip && skip.has(k)) continue;
    if (isClaimActive(o, now, ttl) && o.claimedBy !== username) continue;
    const d = (o.x - from.x) ** 2 + (o.y - from.y) ** 2 + (o.z - from.z) ** 2;
    if (d < bestD) { bestD = d; best = o; }
  }
  if (best) { best.claimedBy = username; best.claimedAt = now; }
  return best;
}

function refreshClaim(map, key, username, now) {
  const o = map.ores[key];
  if (!o || o.claimedBy !== username) return false;
  o.claimedAt = now;
  return true;
}

function releaseClaim(map, key, username) {
  const o = map.ores[key];
  if (!o || o.claimedBy !== username) return false;
  o.claimedBy = null; o.claimedAt = 0;
  return true;
}

function _setStatus(map, key, status) {
  const o = map.ores[key];
  if (!o) return false;
  o.status = status; o.claimedBy = null; o.claimedAt = 0;
  return true;
}
function markMined(map, key) { return _setStatus(map, key, 'mined'); }
function markGone(map, key) { return _setStatus(map, key, 'gone'); }

function heartbeat(map, username, info, now) {
  map.bots[username] = {
    x: info.x, y: info.y, z: info.z,
    role: info.role || 'resource', quota: info.quota || null, at: now,
  };
}

function counts(map, now) {
  const out = {};
  for (const k of Object.keys(map.ores)) {
    const o = map.ores[k];
    const c = out[o.type] || (out[o.type] = { new: 0, claimed: 0, mined: 0, gone: 0 });
    if (o.status === 'new') c[isClaimActive(o, now) ? 'claimed' : 'new']++;
    else if (c[o.status] !== undefined) c[o.status]++;
  }
  return out;
}

// ---------- I/O multi-process : lockfile mkdir (O_EXCL) + écriture atomique ----------

// Sleep SYNCHRONE (on est dans une section critique courte ; pas d'await possible dans
// un read-modify-write qui doit rester atomique vis-à-vis du process courant).
function _sleepSync(ms) {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
  catch (e) { const end = Date.now() + ms; while (Date.now() < end) { /* busy */ } }
}

// Acquiert <file>.lock via mkdirSync (atomique au niveau OS). Lock plus vieux que staleMs
// (process mort) → volé. Au-delà de maxWaitMs → throw (le caller retentera son itération).
function _acquireLock(file, staleMs, maxWaitMs) {
  const lockDir = file + '.lock';
  const deadline = Date.now() + (maxWaitMs || LOCK_MAX_WAIT_MS);
  for (;;) {
    try { fs.mkdirSync(lockDir); return lockDir; }
    catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try {
        const st = fs.statSync(lockDir);
        if (Date.now() - st.mtimeMs > (staleMs || LOCK_STALE_MS)) {
          try { fs.rmdirSync(lockDir); } catch (e2) { /* course : un autre l'a volé */ }
          continue;
        }
      } catch (e2) { continue; } // lock disparu entre-temps → retente immédiatement
      if (Date.now() > deadline) throw new Error('oremap_lock_timeout');
      _sleepSync(LOCK_RETRY_MS);
    }
  }
}

function _readMap(file, runId, zone) {
  try {
    const m = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (m && typeof m === 'object' && m.ores && typeof m.ores === 'object') return m;
  } catch (e) { /* absent ou corrompu → map vide (best-effort) */ }
  return emptyMap(runId, zone);
}

// Écriture atomique : temp + rename (POSIX). Un lecteur (backend Python) voit toujours un
// fichier ENTIER (l'ancien ou le nouveau), jamais un fichier à moitié écrit.
function _writeMapAtomic(file, map) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(map));
  fs.renameSync(tmp, file);
}

// Client store : chaque mutation = read-modify-write SOUS LOCK (zéro lost update entre
// process). La lecture seule (load/counts) se fait SANS lock (rename atomique suffit).
function createStore(file, opts) {
  const { runId, zone, now } = opts || {};
  const clock = now || Date.now;
  function withLock(fn) {
    const lock = _acquireLock(file);
    try {
      const map = _readMap(file, runId, zone);
      if (zone && !map.zone) map.zone = zone;
      const result = fn(map, clock());
      map.updatedAt = clock();
      _writeMapAtomic(file, map);
      return result;
    } finally {
      try { fs.rmdirSync(lock); } catch (e) { /* déjà volé/supprimé */ }
    }
  }
  return {
    file,
    load() { return _readMap(file, runId, zone); },
    addOres(list, foundBy) { return withLock((m, t) => addOres(m, list, foundBy, t)); },
    claimNext(o) { return withLock((m, t) => claimNext(m, Object.assign({ now: t }, o))); },
    refreshClaim(key, username) { return withLock((m, t) => refreshClaim(m, key, username, t)); },
    releaseClaim(key, username) { return withLock((m) => releaseClaim(m, key, username)); },
    markMined(key) { return withLock((m) => markMined(m, key)); },
    markGone(key) { return withLock((m) => markGone(m, key)); },
    heartbeat(username, info) { return withLock((m, t) => heartbeat(m, username, info, t)); },
    counts() { return counts(_readMap(file, runId, zone), clock()); },
  };
}

module.exports = {
  CLAIM_TTL_MS, LOCK_STALE_MS, LOCK_RETRY_MS, LOCK_MAX_WAIT_MS,
  ORE_TYPES, TYPES,
  normalizeOreName, emptyMap, addOres, isClaimActive, claimNext,
  refreshClaim, releaseClaim, markMined, markGone, heartbeat, counts,
  createStore,
};
