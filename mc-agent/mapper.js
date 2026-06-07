'use strict';
// Boucle de cartographie du bot « cartographe » (1b, 0 LLM) — MARCHE ALÉATOIRE PERSISTANTE
// (#4 final, re-précision Massii) : le bot bouge comme un VRAI joueur qui explore —
//  - une DIRECTION GÉNÉRALE qui DÉRIVE lentement et aléatoirement (forte autocorrélation de cap :
//    virages doux ±~25°/jambe, bifurcation franche occasionnelle ≤90°) → ni cercles, ni ligne
//    parfaitement droite, ni allées-retours systématiques ; progression GLOBALE vers du terrain neuf ;
//  - obstacles (océan connu #5, eau droit devant, jambe inatteignable) → TOURNE franchement et
//    continue depuis sa position — JAMAIS de retour à un point comme mode de balayage ;
//  - cellules déjà mappées : biais doux pour s'en écarter (les traverser ponctuellement = OK,
//    la dédup gère) ; couverture incomplète assumée (N mappers × caps différents) ;
//  - secteur multi-mappers (sectors.js) : cap initial tiré DANS le wedge, re-tiré s'il en dérive,
//    re-balance LIVE via getSector (stdin manager) ;
//  - cluster anti-stuck (#1 eau / #8 flottant / #9 lianes) vérifié à chaque itération ;
//  - à chaque arrivée : biome → biome_seen ; entrée de grotte (caves.js) → cave_found ;
//    dédup locale par cellule 128 (le store backend dédup aussi, ceinture+bretelles) ;
//  - survie « basique + » (survival.js) re-tickée avant chaque déplacement, cap anti-blocage.
// Ne retourne JAMAIS sauf annulation du token (c'est un rôle, pas une tâche finie).
const { sectorRange, inSector, isCellMapped } = require('./sectors');
const { detectCaveEntrance } = require('./caves');
const { scanAllOres, oresFoundEvent } = require('./ores');
const { findAllSignatures, findSpawner, structureFoundEvent } = require('./structures');
const { nextFrontierCell } = require('./frontier');
const { biomeSeenEvent, caveFoundEvent, resolveBiome } = require('./worldMemory');
const { survivalTick } = require('./survival');
const { isInWater, escapeWater, clearSnares, isFloatingStuck, recoverFloating, WATER } = require('./unstuck');
let vec3; try { vec3 = require('vec3'); } catch (e) { vec3 = null; }

const GRID = 128;          // même grille que le store backend (quantif/dédup)
const SURVIVAL_CAP = 10;   // re-ticks survie max avant de reprendre la route (anti-blocage)
const TAU = 2 * Math.PI;

function _norm(a) { return ((a % TAU) + TAU) % TAU; }

/** Clé de cellule quantifiée (grille 128, floor — cohérent côté négatif). */
function cellKey(x, z, grid = GRID) {
  return Math.floor(x / grid) * grid + ',' + Math.floor(z / grid) * grid;
}

/** La cellule de (x,z) est-elle un biome OCÉAN connu de la mémoire ? (#5 — on n'y va pas) */
function isOceanCell(memory, worldKey, x, z, grid = GRID) {
  const w = memory && memory.worlds && memory.worlds[worldKey];
  if (!w) return false;
  const q = (v) => Math.floor(v / grid) * grid;
  const qx = q(x), qz = q(z);
  return (w.biomes || []).some((b) => b.name && b.name.includes('ocean') && q(b.x) === qx && q(b.z) === qz);
}

function _v(x, y, z) { return vec3 ? vec3(x, y, z) : { x, y, z }; }

/**
 * Y a-t-il de l'EAU droit devant ? Échantillonne la surface le long du cap (mi-distance + bout),
 * dans les chunks CHARGÉS (≤24 blocs — au-delà on ne sait pas, best-effort → false). (#5)
 */
function waterAhead(bot, from, target, opts = {}) {
  if (!bot || typeof bot.blockAt !== 'function') return false;
  const dx = target.x - from.x, dz = target.z - from.z;
  const dist = Math.sqrt(dx * dx + dz * dz) || 1;
  const sampleDist = Math.min(dist, opts.sampleDist || 24);
  for (const f of [0.5, 1]) {
    const sx = Math.floor(from.x + (dx / dist) * sampleDist * f);
    const sz = Math.floor(from.z + (dz / dist) * sampleDist * f);
    // descend depuis y+8 : premier bloc de SURFACE (non-air) → eau ? terre ?
    for (let y = Math.floor(from.y) + 8; y >= Math.floor(from.y) - 20; y--) {
      const b = bot.blockAt(_v(sx, y, sz));
      if (!b) break;                                          // non chargé → pas d'info
      if (WATER.has(b.name)) return true;                     // surface = eau
      if (b.name === 'air' || b.boundingBox === 'empty') continue;
      break;                                                  // surface = solide → terre ferme
    }
  }
  return false;
}

/** Tire un cap initial : uniforme dans le wedge du mapper (secteur), sinon 0..2π. PUR. */
function drawHeading(rng, sector, overlapDeg) {
  if (sector && sector.count > 1) {
    const range = sectorRange(sector.index, sector.count, overlapDeg);
    if (!range.full) {
      const width = _norm(range.end - range.start) || TAU;
      return _norm(range.start + rng() * width);
    }
  }
  return rng() * TAU;
}

/**
 * Fait ÉVOLUER le cap (marche aléatoire persistante, #4 final) : dérive douce ±driftRad (déf ~25°),
 * rare bifurcation franche ≤90° (proba bigTurnP, déf 8%). PUR — jamais un cap fixe (ligne droite
 * robotique), jamais un saut de cap à chaque tick (erratique).
 */
function driftHeading(heading, rng, opts = {}) {
  const driftRad = opts.driftRad != null ? opts.driftRad : Math.PI / 7;   // ±~25°
  const bigTurnP = opts.bigTurnP != null ? opts.bigTurnP : 0.08;
  if (rng() < bigTurnP) return _norm(heading + (rng() * 2 - 1) * (Math.PI / 2)); // bifurcation ponctuelle
  return _norm(heading + (rng() * 2 - 1) * driftRad);                            // virage doux
}

/** Prochaine jambe de marche le long du cap : distance variable 24-64 blocs. PUR. */
function legTarget(pos, heading, rng, opts = {}) {
  const minDist = opts.minDist || 24;
  const maxDist = opts.maxDist || 64;
  const dist = minDist + rng() * (maxDist - minDist);
  return { x: pos.x + dist * Math.cos(heading), z: pos.z + dist * Math.sin(heading) };
}

function _pos(bot) {
  const p = bot.entity && bot.entity.position;
  return p ? { x: p.x, y: p.y, z: p.z } : { x: 0, y: 64, z: 0 };
}

/**
 * Y de SURFACE à (x,z) : premier bloc non-air en descendant depuis fromY (chunks chargés only).
 * null si colonne non chargée. Sert à détecter « enterré » (le kit laisse le bot au fond du trou
 * à cobble → sans remontée, le mapper TUNNELLERAIT entre ses jambes au lieu de mapper la surface).
 */
function surfaceYAt(bot, x, z, fromY) {
  if (!bot || typeof bot.blockAt !== 'function') return null;
  for (let y = fromY; y > fromY - 120; y--) {
    const b = bot.blockAt(_v(Math.floor(x), y, Math.floor(z)));
    if (!b) return null;                                   // non chargé → pas d'info
    if (b.name !== 'air' && b.boundingBox !== 'empty') return y;
  }
  return null;
}

/**
 * runMapper(bot, opts, token) — marche cartographique continue. Retourne {ok:true, cancelled:true}
 * à l'annulation (seule sortie).
 *  opts.worldKey  : clé de monde (label || dimension) — obligatoire pour les events
 *  opts.memory    : mémoire bootstrap du groupe (océans connus + biais cellules mappées)
 *  opts.getSector : () => {index,count}|null — lu à chaque jambe (re-balance live via stdin)
 *  opts.emit      : hook events ; opts.goto : injectable (défaut pathfinder.goto GoalNear)
 *  opts.fleeFrom  : injecté dans survivalTick ; opts.sleep/rng/now : injectables (tests)
 *  opts.onPeriodic/periodicEvery : hook toutes les N arrivées (ex. re-tentative kit)
 *  opts.teleport  : watcher TP (teleport.js, #10) — pending consommé en tête de boucle → RÉ-ANCRAGE
 */
async function runMapper(bot, opts = {}, token = { cancelled: false }) {
  const worldKey = opts.worldKey || 'unknown';
  const emit = opts.emit || (() => {});
  const sleep = opts.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const rng = opts.rng || Math.random;
  const now = opts.now || (() => Date.now());
  const getSector = opts.getSector || (() => opts.sector || null);
  const memory = opts.memory || null;
  const periodicEvery = opts.periodicEvery || 10;

  const doGoto = opts.goto || (async (wp) => {
    const { goals } = require('mineflayer-pathfinder');
    await bot.pathfinder.goto(new goals.GoalNear(wp.x, wp.y, wp.z, 8));
  });

  const localSeen = new Set();   // cellules visitées
  const biomeCells = new Set();  // cellules dont le biome a été émis
  const caveCells = new Set();   // cellules dont une grotte a été émise
  const oreSeen = new Set();     // minerais déjà émis (dédup par position de BLOC 3D)
  const structSeen = new Set();  // structures émises (dédup type+cellule 64 — le backend dédup aussi)
  let lastScanCell = null;       // cellule du dernier scan d'ores (1 scan/cellule : findBlocks coûte cher)
  const frontierSkip = new Set(); // cellules frontière en échec (eau/inatteignable) — on n'y reboucle pas
  let legs = 0;                  // compteur de jambes (re-lecture mémoire live périodique)

  // Note la position courante : biome (1×/cellule) + entrée de grotte éventuelle.
  function record() {
    const p = _pos(bot);
    const ck = cellKey(p.x, p.z);
    localSeen.add(ck);
    if (!biomeCells.has(ck)) {
      biomeCells.add(ck);
      try {
        const block = bot.blockAt(bot.entity.position.floored ? bot.entity.position.floored() : bot.entity.position);
        if (block && block.biome) {
          // resolveBiome (worldMemory) : nom résolu via registry quand mineflayer ne livre que l'id
          // (live 1.21.4 : biome.name = '' — les noms alimentent l'amorce vanilla des récolteurs).
          emit(biomeSeenEvent(worldKey, { biome: resolveBiome(bot, block) }, p));
        }
      } catch (e) { /* chunk non chargé → on émettra à la prochaine cellule */ }
    }
    // COUVERTURE PLEINE (phase 3, demande Massii) : le biome n'était noté que SOUS le bot —
    // les cellules VOISINES où on détecte structures (≤48) / ores (≤128) restaient « blanches »
    // sur la carte (structure sans biome). On échantillonne aussi les 8 cellules adjacentes
    // (centres à ±GRID) si leurs chunks sont chargés — gratuit (lecture mémoire client).
    for (const dx of [-GRID, 0, GRID]) {
      for (const dz of [-GRID, 0, GRID]) {
        if (dx === 0 && dz === 0) continue;
        const nx = Math.floor((p.x + dx) / GRID) * GRID + GRID / 2;
        const nz = Math.floor((p.z + dz) / GRID) * GRID + GRID / 2;
        const nk = cellKey(nx, nz);
        if (biomeCells.has(nk)) continue;
        try {
          const nb = bot.blockAt(_v(nx, Math.floor(p.y), nz));
          if (nb && nb.biome) {
            biomeCells.add(nk);
            emit(biomeSeenEvent(worldKey, { biome: resolveBiome(bot, nb) }, { x: nx, y: p.y, z: nz }));
          }
        } catch (e) { /* chunk voisin non chargé → plus tard */ }
      }
    }
    try {
      const cave = detectCaveEntrance(bot, p);
      if (cave.found) {
        const cck = cellKey(cave.pos.x, cave.pos.z);
        if (!caveCells.has(cck)) { caveCells.add(cck); emit(caveFoundEvent(worldKey, cave.pos)); }
      }
    } catch (e) { /* best-effort */ }
    // minerais dans les chunks chargés (ores.js — pour les bots ressources) : 1 SEUL scan par
    // cellule 128 (findBlocks sur une région à grottes = 10-20 M de lectures de blocs — un scan
    // par arrivée bloquait l'event loop node → keepalive raté → « Timed out » ×6 mappers, vécu
    // phase 2). Rayon 128 suffit : la frontière visite chaque cellule. Émission BATCHÉE.
    if (ck !== lastScanCell) {
      lastScanCell = ck;
      try {
        const fresh = [];
        for (const ore of scanAllOres(bot, { maxDistance: 128, count: 1200 })) {
          const ok = ore.x + ',' + ore.y + ',' + ore.z;
          if (!oreSeen.has(ok)) { oreSeen.add(ok); fresh.push(ore); }
        }
        if (fresh.length) emit(oresFoundEvent(worldKey, fresh));
      } catch (e) { /* best-effort */ }
    }
    // structures (phase 2) : blocs-signatures + spawner à portée → structure_found (dédup locale
    // type+cellule 64 ; village/mineshaft/stronghold/donjon… — l'anti-xray ne masque pas ces blocs).
    try {
      const hits = findAllSignatures(bot, { maxDistance: 48 });
      const sp = findSpawner(bot, { maxDistance: 48 });
      if (sp.found) hits.push({ type: sp.type, pos: sp.pos });
      for (const h of hits) {
        const sk = h.type + ':' + Math.floor(h.pos.x / 64) + ',' + Math.floor(h.pos.z / 64);
        if (!structSeen.has(sk)) { structSeen.add(sk); emit(structureFoundEvent(worldKey, h.type, h.pos)); }
      }
    } catch (e) { /* best-effort */ }
  }

  // Survie : re-tick jusqu'au calme (cap anti-blocage : on reprend la route même si ça reste chaud).
  async function settleSurvival() {
    for (let i = 0; i < SURVIVAL_CAP; i++) {
      if (token.cancelled) return;
      const action = await survivalTick(bot, { fleeFrom: opts.fleeFrom, emit });
      if (!action) return;
      await sleep(1500); // laisser l'action (fuite/combat/chasse) produire son effet
    }
  }

  // Cluster anti-stuck (#1 eau / #8 flottant / #9 lianes) — appelé à chaque itération.
  // lastSample = DÉBUT de l'épisode « en l'air sans bouger » (conservé tant que l'épisode dure,
  // sinon l'immobilité ne dépasserait jamais minMs et le flottant ne serait jamais détecté).
  let lastSample = null;
  async function antiStuck() {
    if (isInWater(bot)) {
      const r = await escapeWater(bot, { emit, sleep });
      lastSample = null;
      return { waterEscapeFailed: !(r && r.ok) };
    }
    try { await clearSnares(bot); } catch (e) {}                       // #9 : lianes adjacentes
    const p = _pos(bot);
    const cur = { x: p.x, z: p.z, t: now() };
    const onGround = !!(bot.entity && bot.entity.onGround);
    const moved = lastSample ? Math.sqrt((cur.x - lastSample.x) ** 2 + (cur.z - lastSample.z) ** 2) : Infinity;
    if (onGround || moved >= 0.35) { lastSample = cur; return; }       // état sain → nouvel échantillon
    if (isFloatingStuck(lastSample, cur, { onGround, inWater: false })) {
      await recoverFloating(bot, { emit, sleep });                     // #8 : relâcher tout, retomber
      lastSample = null;
    }
    // épisode en cours (pas encore minMs) → on GARDE l'échantillon de départ
  }

  // Cap si la dérive sort du wedge du mapper (secteur actif) → re-tire DANS le wedge.
  function clampToSector(heading, sector) {
    if (!sector || sector.count <= 1) return heading;
    const range = sectorRange(sector.index, sector.count, opts.overlapDeg);
    return inSector(heading, range) ? heading : drawHeading(rng, sector, opts.overlapDeg);
  }

  let heading = opts.initialHeading != null ? _norm(opts.initialHeading) : drawHeading(rng, getSector(), opts.overlapDeg);
  let sectorKey = JSON.stringify(getSector() || null);
  let arrivals = 0;
  let blockedStreak = 0;   // jambes bloquées d'affilée (île/cul-de-sac → souffler, anti boucle chaude)
  let surfaceTries = 0;    // remontées surface d'affilée (anti boucle si la remontée n'aboutit pas)
  let failStreak = 0;      // jambes inatteignables d'affilée (→ jambes courtes pour se dégager)
  record(); // la cellule de départ compte

  while (!token.cancelled) {
    // TÉLÉPORTATION (#10) : le bot a sauté (admin /tp, /home, portail…) → RÉ-ANCRAGE au lieu réel.
    // Origine de mapping = position ACTUELLE, heading propre re-tiré (dans le wedge si secteur),
    // baseline anti-stuck remise à zéro (le saut n'est PAS un blocage), compteurs d'échec purgés
    // (ils décrivaient l'ANCIEN terrain). JAMAIS de retour à pied à l'ancien lieu : le TP est un
    // moyen de DIRIGER le bot (Massii le TP dans une zone → il mappe DE LÀ).
    if (opts.teleport && opts.teleport.peek()) {
      const tp = opts.teleport.consume();
      const r = (p) => ({ x: Math.round(p.x), y: Math.round(p.y), z: Math.round(p.z) });
      emit({ type: 'mapper_reanchor', from: r(tp.from), to: r(tp.to) });
      lastSample = null;
      blockedStreak = 0; surfaceTries = 0; failStreak = 0;
      heading = drawHeading(rng, getSector(), opts.overlapDeg);
      record(); // la cellule d'arrivée compte tout de suite (coords RÉELLES)
    }
    const stuck = await antiStuck();
    // évasion d'eau RATÉE (pas de terre ≤48 : il s'est engagé au large, vécu Surv6 ×9) →
    // DEMI-TOUR franc : on repart d'où on vient au lieu de continuer vers le large.
    if (stuck && stuck.waterEscapeFailed) heading = _norm(heading + Math.PI);
    if (token.cancelled) break;
    await settleSurvival();
    if (token.cancelled) break;

    // ENTERRÉ (fin de kit au fond du trou à cobble, chute en grotte) → REMONTER à la surface
    // d'abord : le cartographe mappe la SURFACE, il ne tunnelle pas entre ses jambes.
    // Borné (3 essais d'affilée) : si la remontée n'aboutit pas, on mappe quand même (best-effort).
    {
      const p = _pos(bot);
      const top = surfaceYAt(bot, p.x, p.z, Math.floor(p.y) + 80);
      if (top != null && top - p.y > 6 && surfaceTries < 3) {
        surfaceTries++;
        emit({ type: 'mapper_surface', from: Math.floor(p.y), to: top });
        try { await doGoto({ x: p.x, y: top + 1, z: p.z }); } catch (e) { /* best-effort, on retentera */ }
        continue;
      }
      if (top == null || top - p.y <= 6) surfaceTries = 0;   // surfacé (ou pas d'info) → compteur remis
    }

    // re-balance live des secteurs (le manager re-pousse {index,count} quand N change)
    const sec = getSector();
    const sk = JSON.stringify(sec || null);
    if (sk !== sectorKey) { sectorKey = sk; heading = drawHeading(rng, sec, opts.overlapDeg); }

    // ── Mode FRONTIÈRE (phase 2, opts.frontier) : remplir la cellule NON couverte la plus
    // proche au lieu de marcher au cap. Mémoire LIVE re-lue toutes les 3 jambes (les autres
    // mappers couvrent en parallèle). Frontière lointaine (> warpDist) + warp dispo → self-warp
    // (bot op, /spreadplayers) : on repart d'un point frais SANS retraverser le déjà-fait.
    if (opts.frontier) {
      legs++;
      if (opts.reloadMemory && legs % 3 === 0) {
        try { memory = opts.reloadMemory() || memory; } catch (e) { /* best-effort */ }
      }
      const here0 = _pos(bot);
      const cell = nextFrontierCell(memory, worldKey, localSeen, here0, { skip: frontierSkip });
      if (cell) {
        const fd = Math.sqrt((cell.center.x - here0.x) ** 2 + (cell.center.z - here0.z) ** 2);
        if (fd > (opts.warpDist || 220) && opts.warp) {
          emit({ type: 'mapper_warp', to: cell.key, d: Math.round(fd) });
          try { await opts.warp(cell.center.x, cell.center.z); } catch (e) { /* best-effort */ }
          await sleep(opts.warpSettleMs != null ? opts.warpSettleMs : 4000);  // chunks + chute spreadplayers
          record();
          continue;
        }
        if (!isOceanCell(memory, worldKey, cell.center.x, cell.center.z)
            && !waterAhead(bot, here0, cell.center)) {
          try {
            await doGoto({ x: cell.center.x, y: here0.y, z: cell.center.z });
            record();
            continue;
          } catch (e) {
            frontierSkip.add(cell.key);          // inatteignable → on n'y reboucle pas
            emit({ type: 'mapper_frontier_skip', cell: cell.key });
            // fallthrough : jambe aléatoire pour se dégager
          }
        } else {
          frontierSkip.add(cell.key);            // eau → couverte « par constat »
        }
      }
      // cell null (tout couvert dans le rayon) ou échec → marche aléatoire ci-dessous
    }

    // le cap DÉRIVE doucement (random walk persistant), confiné au wedge si secteur
    heading = clampToSector(driftHeading(heading, rng, opts), sec);

    const here = _pos(bot);
    let target = legTarget(here, heading, rng, opts);

    // obstacles : océan connu / eau droit devant → TOURNE franchement (90-180°) et continue —
    // jamais de retour à un point. Si tout est bloqué (île) : souffle un peu puis re-essaie.
    let turned = 0;
    while ((isOceanCell(memory, worldKey, target.x, target.z) || waterAhead(bot, here, target)) && turned < 6) {
      heading = clampToSector(_norm(heading + (rng() < 0.5 ? 1 : -1) * (Math.PI / 2 + rng() * Math.PI / 2)), sec);
      target = legTarget(here, heading, rng, opts);
      turned++;
    }
    if (turned >= 6) {
      blockedStreak++;
      emit({ type: 'mapper_blocked', streak: blockedStreak });
      if (blockedStreak >= 3) {
        // ÎLE/PÉNINSULE (vécu Surv10 : 29 cycles bloqués sur place) — TOUTES les directions mènent
        // à l'eau → on TRAVERSE à la nage vers la terre suivante, comme un vrai joueur (cap tiré,
        // jambe longue SANS veto eau ; un timeout en pleine eau est rattrapé par escapeWater qui
        // nage en persistance au cap → on atterrit de l'autre côté).
        const crossHeading = clampToSector(drawHeading(rng, sec, opts.overlapDeg), sec);
        const cross = legTarget(here, crossHeading, rng, { minDist: 100, maxDist: 160 });
        emit({ type: 'mapper_crossing', heading: Number(crossHeading.toFixed(2)) });
        try { await doGoto({ x: cross.x, y: here.y, z: cross.z }); } catch (e) { /* escapeWater prend le relais */ }
        heading = crossHeading;
        blockedStreak = 0;
        record();
        continue;
      }
      await sleep(opts.idleMs || 10000);
      continue;
    }
    if (turned > 0) emit({ type: 'mapper_turn', reason: 'water' });

    // cellule déjà mappée droit devant → biais doux pour s'en écarter (la traverser parfois = OK,
    // c'est humain ; la dédup évite les doublons) — 1 seul re-tirage, pas d'oscillation.
    if ((localSeen.has(cellKey(target.x, target.z)) ||
         (memory && isCellMapped(memory, worldKey, target.x, target.z, GRID))) && rng() < 0.7) {
      heading = clampToSector(driftHeading(heading, rng, { driftRad: Math.PI / 4, bigTurnP: 0 }), sec);
      target = legTarget(here, heading, rng, opts);
    }

    blockedStreak = 0;
    // après des échecs consécutifs : jambes COURTES (8-24) pour se dégager du terrain difficile
    // (jungle dense, falaises) au lieu de re-payer un long timeout sur une cible lointaine.
    if (failStreak >= 2) target = legTarget(here, heading, rng, { minDist: 8, maxDist: 24 });
    try { await doGoto({ x: target.x, y: here.y, z: target.z }); }
    catch (e) {
      // jambe inatteignable (falaise/mur) : dégager les lianes (#9) puis tourner franchement
      failStreak++;
      try { await clearSnares(bot); } catch (e2) {}
      heading = clampToSector(_norm(heading + Math.PI / 2 + rng() * Math.PI), sec);
      emit({ type: 'mapper_turn', reason: 'unreachable', streak: failStreak });
      continue;
    }
    failStreak = 0;
    record();
    arrivals++;
    // hook à chaque arrivée (ex. : chasse opportuniste si le stock de nourriture est bas et qu'une
    // proie est en vue — sans attendre la re-tentative périodique du kit) — best-effort
    if (opts.onArrive) { try { await opts.onArrive(); } catch (e) { /* le mapping continue */ } }
    // hook périodique (ex. : re-tenter le mini-kit s'il avait stallé) — best-effort, jamais bloquant
    if (opts.onPeriodic && arrivals % periodicEvery === 0) {
      try { await opts.onPeriodic(); } catch (e) { /* le mapping continue */ }
    }
  }
  return { ok: true, cancelled: true };
}

module.exports = { drawHeading, driftHeading, legTarget, isOceanCell, waterAhead, surfaceYAt, cellKey, runMapper, GRID };
