'use strict';
// Claims anti-collision entre bots ressources (M bots, même groupe) : fichier JSON partagé
// `claims-<group>.json` écrit par les BOTS sous lockfile (mkdir O_EXCL — même pattern validé
// qu'oremap.js D1). DISTINCT de la mémoire de monde (qui reste backend-médiée, single-writer) :
// les claims sont une coordination ÉPHÉMÈRE hors contrat worlds[].ores.
//  - claim TTL 120 s, rafraîchie par le claimer à chaque itération de sa boucle ;
//  - bot mort → claim expirée → l'ore redevient prenable (zéro coordination explicite) ;
//  - clé = oreKey "x,y,z" (positions exactes de worlds[].ores).
const fs = require('fs');
const path = require('path');
const { CLAIM_TTL_MS, LOCK_STALE_MS, LOCK_RETRY_MS, LOCK_MAX_WAIT_MS } = require('./oremap');

function _sleepSync(ms) {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
  catch (e) { const end = Date.now() + ms; while (Date.now() < end) { /* busy */ } }
}

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
      } catch (e2) { continue; }
      if (Date.now() > deadline) throw new Error('claims_lock_timeout');
      _sleepSync(LOCK_RETRY_MS);
    }
  }
}

function _read(file) {
  try {
    const m = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (m && typeof m === 'object' && m.claims && typeof m.claims === 'object') return m;
  } catch (e) { /* absent/corrompu → vide (best-effort) */ }
  return { claims: {} };
}

function _writeAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(data));
  fs.renameSync(tmp, file);
}

/** Purge les claims expirées (mutation in place). */
function pruneExpired(map, now, ttl) {
  const t = ttl || CLAIM_TTL_MS;
  for (const k of Object.keys(map.claims)) {
    if (now - map.claims[k].at >= t) delete map.claims[k];
  }
  return map;
}

/**
 * Client claims d'un bot. Toutes les méthodes sont best-effort : un échec d'I/O/lock retourne
 * false (le caller skip l'ore et continue) — un souci de claims ne tue JAMAIS la boucle minage.
 */
function createClaims(file, opts) {
  const { username, now, ttl } = opts || {};
  const clock = now || Date.now;

  function withLock(fn) {
    const lock = _acquireLock(file);
    try {
      const map = pruneExpired(_read(file), clock(), ttl);
      const result = fn(map, clock());
      _writeAtomic(file, map);
      return result;
    } finally {
      try { fs.rmdirSync(lock); } catch (e) { /* déjà volé/supprimé */ }
    }
  }

  function safe(fn) {
    try { return withLock(fn); } catch (e) { return false; }
  }

  return {
    file,
    /** true si la claim est posée (ou déjà à nous) ; false si un AUTRE bot la tient (fraîche). */
    tryClaim(key) {
      return safe((m, t) => {
        const c = m.claims[key];
        if (c && c.by !== username) return false;       // fraîche (pruneExpired a déjà purgé)
        m.claims[key] = { by: username, at: t };
        return true;
      });
    },
    /** Rafraîchit NOTRE claim (no-op si elle n'est pas à nous). */
    refresh(key) {
      return safe((m, t) => {
        const c = m.claims[key];
        if (!c || c.by !== username) return false;
        c.at = t;
        return true;
      });
    },
    /** Relâche NOTRE claim (ore minée/abandonnée). */
    release(key) {
      return safe((m) => {
        const c = m.claims[key];
        if (!c || c.by !== username) return false;
        delete m.claims[key];
        return true;
      });
    },
  };
}

// ─── Présence partagée (TP-au-mappeur, Massii 15/07) ───────────────────────────────────────────
// Chaque bot du groupe bat sa position + son RÔLE dans `positions-<group>.json` (même pattern
// lockfile/write-atomic que les claims, fichier SÉPARÉ — on ne mélange pas les structures).
// Un bot ressource lit la liste → choisit un mappeur LOIN comme cible de /tpa (mapperTp.js).
const PRESENCE_TTL_MS = 180000; // 3 min sans battement = bot mort/déco → purgé

function _readPresence(file) {
  try {
    const m = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (m && typeof m === 'object' && m.pos && typeof m.pos === 'object') return m;
  } catch (e) { /* absent/corrompu → vide (best-effort) */ }
  return { pos: {} };
}

/** Client présence d'un bot — best-effort intégral (un échec d'I/O ne tue jamais la boucle). */
function createPresence(file, opts) {
  const { username, now, ttl } = opts || {};
  const clock = now || Date.now;
  const ttlMs = ttl || PRESENCE_TTL_MS;

  function withLock(fn) {
    const lock = _acquireLock(file);
    try {
      const map = _readPresence(file);
      const t = clock();
      for (const k of Object.keys(map.pos)) {
        if (t - map.pos[k].at >= ttlMs) delete map.pos[k];
      }
      const result = fn(map, t);
      _writeAtomic(file, map);
      return result;
    } finally {
      try { fs.rmdirSync(lock); } catch (e) { /* déjà volé/supprimé */ }
    }
  }

  return {
    file,
    /** Bat la position courante (écrase la précédente du même bot).
     *  `status` (optionnel) = état d'équipe publié aux coéquipiers — {armor, ingots, need} de
     *  teamwork.teamStatus. C'est ce qui permet à un bot de voir QUI a besoin d'aide (demande
     *  Massii 25/07 : « il faut qu'ils s'aident entre eux »). Rétro-compat : sans status, l'entrée
     *  garde exactement l'ancienne forme. */
    beat(x, z, role, status) {
      try {
        return withLock((m, t) => {
          const e = { x, z, role: role || 'worker', at: t };
          if (status && typeof status === 'object') Object.assign(e, status);
          m.pos[username] = e;
          return true;
        });
      } catch (e) { return false; }
    },
    /** Positions FRAÎCHES de tous les bots du groupe → [{name, x, z, role, at}]. */
    list() {
      try {
        return withLock((m) => Object.entries(m.pos).map(([name, p]) => ({ name, ...p })));
      } catch (e) { return []; }
    },
  };
}

module.exports = { createClaims, pruneExpired, createPresence, PRESENCE_TTL_MS };
