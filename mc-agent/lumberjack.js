'use strict';
// BÛCHERON D'ÉQUIPE (Massii 20/10) : « un seul bot monte en surface faire le bois, puis il se /tpa
// vers les autres pour leur donner ».
//
// Pourquoi : le bois en surface est LE goulot. Chaque ouvrier qui manque de bois (buts `logs`,
// `plank_buffer`, `gift_planks`, `armor_fuel`… — tous ceux dont le skill est `gatherLog`) remonte,
// explore une zone déjà rasée, et y meurt : 63 % des morts mesurées arrivent en cherchant du bois.
// Un seul bot qui s'en occupe = un seul bot exposé, et les autres restent au fond à miner.
//
// Décisions PURES ici ; l'exécution (attente, /tpa, toss, retour au spot de coupe) vit dans index.js
// — même séparation que teamwork / mapperTp / regroup.
//
// Protocole (tout passe par les deux fichiers partagés du groupe, rien de nouveau côté backend) :
//   - DEMANDE : le demandeur publie `woodWant` (bûches voulues) + `woodAt` (début de la demande) dans
//     son heartbeat de présence. ⚠️ PAS dans `need` : `need` est déjà le nombre de LINGOTS manquants
//     (teamwork.teamStatus), lu par iron_help/pickDonation — y mettre 'wood' casserait l'entraide fer.
//   - ÉLECTION : claim `lumberjack` du lockfile `claims-<group>.json` (TTL 120 s, rafraîchie).
//   - RÉSERVATION d'une livraison : claim `wood:<demandeur>` (anti double-service).

const WOOD_REQUEST_TTL_MS = 240000;       // 4 min sans livraison → le demandeur va chercher lui-même
const WOOD_UNDERGROUND_Y = 50;           // sous cette altitude l'ouvrier est « sous terre » → il attend le bûcheron
const WOOD_REQUEST_COOLDOWN_MS = 600000;  // après un timeout : 10 min d'autonomie bois (pas d'aller-retour attente/quête)
const LUMBERJACK_FRESH_MS = 150000;       // présence > 2,5 battements manqués (60 s) = bûcheron mort/déco
const WOOD_WANT_MIN = 16;
const WOOD_WANT_MAX = 32;
const LUMBERJACK_STOCK = 48;              // stock visé en poche
const LUMBERJACK_RESERVE = 8;             // gardé pour soi (table, bâtons, combustible)
const WOOD_MIN_GIFT = 4;                  // en dessous, le /tpa ne vaut pas le déplacement

function isWoodGoal(goal) { return !!(goal && goal.skill === 'gatherLog'); }

function woodWantFor(goal) {
  const c = Number(goal && goal.args && goal.args.count) || 0;
  return Math.max(WOOD_WANT_MIN, Math.min(WOOD_WANT_MAX, c));
}

/** Bûches en poche (toutes essences ; `stripped_*_log` compris). inv = {nom: nombre}. */
function logCount(inv) {
  let n = 0;
  for (const [k, v] of Object.entries(inv || {})) if (k.endsWith('_log')) n += v || 0;
  return n;
}

const _fresh = (m, now, ms) => !!m && (now - (m.at || 0)) <= ms;

/** PUR — nom du bûcheron actif du groupe (présence fraîche, rôle `lumberjack`), hors soi. */
function activeLumberjack({ mates, selfName, now, freshMs = LUMBERJACK_FRESH_MS } = {}) {
  const t = now || Date.now();
  for (const m of mates || []) {
    if (m && m.name && m.name !== selfName && m.role === 'lumberjack' && _fresh(m, t, freshMs)) return String(m.name);
  }
  return null;
}

/**
 * PUR — que fait un ouvrier face à un but bois ?
 *  'self'    : comportement historique (il va le chercher) — `clear:true` = retirer sa demande ;
 *  'request' : publier une demande puis attendre ;
 *  'wait'    : demande en cours, attendre encore `remainingMs` ;
 *  'timeout' : 4 min écoulées sans livraison → repli sur soi (event wood_request_timeout).
 * request = {want, at} | null ; timedOutAt = instant du dernier timeout (ou null).
 */
function woodWaitDecision({ isLumberjack, isMapper, lumberjack, request, timedOutAt, now, underground = true,
  ttlMs = WOOD_REQUEST_TTL_MS, cooldownMs = WOOD_REQUEST_COOLDOWN_MS } = {}) {
  const t = now || Date.now();
  if (isLumberjack || isMapper) return { action: 'self', clear: !!request };
  if (!lumberjack) return { action: 'self', clear: !!request };
  // En SURFACE un joueur coupe son bois lui-même : la livraison n'a de sens que pour un ouvrier sous terre.
  if (!underground) return { action: 'self', clear: !!request };
  if (!request && timedOutAt && (t - timedOutAt) < cooldownMs) return { action: 'self', clear: false };
  if (!request) return { action: 'request' };
  const age = t - (request.at || 0);
  // Demande héritée d'un process d'il y a longtemps (mémo base) : ce n'est pas un échec du bûcheron
  // d'aujourd'hui, on repart d'une demande neuve plutôt que de conclure à un timeout.
  if (age >= 2 * ttlMs || age < 0) return { action: 'request' };
  if (age >= ttlMs) return { action: 'timeout' };
  return { action: 'wait', remainingMs: ttlMs - age };
}

// ÉLIGIBILITÉ (mesure 3 h, 21/10) : NethBot1 élu bûcheron à 0 pièce — 112 min en `lj_stock` (65 % du
// temps), 16 morts, 135 abris, 18 tranches de fer sans UNE pièce d'armure. Un bûcheron nu en surface
// en Hard meurt en boucle et ne livre rien. On n'élit donc qu'un ouvrier dont l'armure de fer est
// COMPLÈTE ET PORTÉE ; tant que personne ne l'est, pas de bûcheron (chacun suit `iron_armor`, qui
// coupe son bois lui-même en surface — l'attente de bois n'existe que pour un ouvrier sous terre).
const LUMBERJACK_MIN_WORN = 4;
const _ARMOR_SLOTS = ['helmet', 'chestplate', 'leggings', 'boots'];
const _IRON_OR_BETTER = ['iron', 'diamond', 'netherite'];

/**
 * PUR — nombre d'emplacements couverts par une pièce de fer (ou mieux) PORTÉE. `worn` = noms des
 * pièces des slots 5-8 (index.js `_wornArmor()`, qui écarte déjà les pièces quasi cassées).
 */
function wornIronCount(worn) {
  let set;
  try { set = new Set(worn || []); } catch (e) { return 0; }
  let n = 0;
  for (const slot of _ARMOR_SLOTS) {
    if (_IRON_OR_BETTER.some((mat) => set.has(`${mat}_${slot}`))) n += 1;
  }
  return n;
}

/**
 * PUR — le bûcheron PRÉFÉRÉ du groupe (déterministe : tous les bots calculent le même) :
 * parmi les ouvriers ÉLIGIBLES (≥ 4 pièces fer PORTÉES : `worn` du heartbeat, `selfWorn` pour soi —
 * PAS `armor`, qui compte aussi les pièces en poche), le mieux armé, nom ASC en départage. Jamais un
 * cartographe. null s'il y a moins de 2 ouvriers frais (seul, un bûcheron n'aurait personne à servir)
 * ou si aucun n'est éligible. Une présence sans `worn` (ancien process) = non éligible (sens sûr).
 */
function preferredLumberjack({ selfName, selfArmor, selfWorn, mates, now, freshMs = LUMBERJACK_FRESH_MS,
  minWorn = LUMBERJACK_MIN_WORN } = {}) {
  const t = now || Date.now();
  const all = [];
  if (selfName) all.push({ name: String(selfName), armor: selfArmor || 0, worn: Number(selfWorn) || 0 });
  for (const m of mates || []) {
    if (!m || !m.name || m.name === selfName || m.role === 'mapper') continue;
    if (!_fresh(m, t, freshMs)) continue;
    all.push({ name: String(m.name), armor: m.armor || 0, worn: Number(m.worn) || 0 });
  }
  if (all.length < 2) return null;
  const eligible = all.filter((c) => c.worn >= minWorn);
  if (!eligible.length) return null;
  eligible.sort((a, b) => (b.armor - a.armor) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return eligible[0].name;
}

/**
 * PUR — verdict d'élection pour CE bot.
 *  holder = claim `lumberjack` courante ({by, at} déjà purgée des expirées) ou null.
 *  'follower' : un autre est bûcheron (ou je ne suis pas le préféré) ;
 *  'keep'     : la claim est à moi → je suis (ou deviens) bûcheron, je rafraîchis ;
 *  'claim'    : claim libre et c'est à moi de la prendre (préféré, ou déjà bûcheron = sticky) ;
 *  'release'  : je tiens la claim mais il n'y a plus personne à servir (seul ouvrier frais), ou je ne
 *               suis plus éligible (`selfEligible === false` : une pièce usée/perdue → je rends le rôle
 *               et je reforge ; un autre ouvrier 4/4 pourra être élu).
 * `selfEligible` absent = comportement historique (pas de garde d'armure).
 */
function lumberjackVerdict({ selfName, holder, preferred, amLumberjack, selfEligible } = {}) {
  if (holder && holder.by && holder.by !== selfName) return 'follower';
  if (selfEligible === false) return (amLumberjack || (holder && holder.by === selfName)) ? 'release' : 'follower';
  if (!preferred) return (holder || amLumberjack) ? 'release' : 'follower';
  if (holder && holder.by === selfName) return 'keep';
  if (amLumberjack || preferred === selfName) return 'claim';
  return 'follower';
}

/**
 * PUR — quelle demande servir ? La plus ANCIENNE (premier arrivé, premier servi), d'un ouvrier frais,
 * demande de moins de 4 min, non déjà servie/réservée (`skip`). Quantité = min(voulu, stock − réserve).
 * @returns {{to, amount, want}|null}
 */
function pickWoodRequest({ mates, selfName, now, stock, skip, reserve = LUMBERJACK_RESERVE,
  minGift = WOOD_MIN_GIFT, ttlMs = WOOD_REQUEST_TTL_MS, freshMs = LUMBERJACK_FRESH_MS } = {}) {
  const t = now || Date.now();
  const avail = Math.max(0, (stock || 0) - reserve);
  if (avail < minGift) return null;
  let best = null;
  for (const m of mates || []) {
    if (!m || !m.name || m.name === selfName || m.role === 'mapper') continue;
    if (!_fresh(m, t, freshMs)) continue;
    if (!(m.woodWant > 0) || !Number.isFinite(m.woodAt)) continue;
    if ((t - m.woodAt) >= ttlMs) continue;
    if (skip && skip.has(m.name)) continue;
    if (!best || m.woodAt < best.woodAt || (m.woodAt === best.woodAt && m.name < best.name)) best = m;
  }
  if (!best) return null;
  const amount = Math.min(best.woodWant, avail);
  if (amount < minGift) return null;
  return { to: String(best.name), amount, want: best.woodWant };
}

/** PUR — piles de bûches à jeter pour totaliser `amount`. items = inventory.items(). */
function tossPlan(items, amount) {
  const out = [];
  let left = Math.max(0, amount || 0);
  for (const it of items || []) {
    if (left <= 0) break;
    if (!it || !it.name || !it.name.endsWith('_log')) continue;
    const n = Math.min(left, it.count || 0);
    if (n > 0) { out.push({ type: it.type, name: it.name, count: n }); left -= n; }
  }
  return out;
}

// ─── ARMURE DU BÛCHERON (20/10 soir) ───────────────────────────────────────────────────────────────
// Mesure 1 h après la mise en service : cartographes nus = 20 morts sur 36. Avant le bûcheron, c'était
// l'ouvrier le mieux armé qui forgeait leur armure (chaîne mapper_armor) — et c'est précisément lui
// qu'on élit bûcheron : il ABANDONNAIT cette chaîne (NethBot3, 10 lingots en poche, en surface).
// Et l'usure : NethBot3 est passé de 4 à 2 pièces portées sans jamais les refaire (l'objectif
// `lumberjack` n'est pas dans le timer d'armure, et sa chaîne n'avait aucun but d'armure).
// Priorités dans LUMBERJACK_CHAIN : livraison de bois > SES pièces > armure cartographe > stock bois.
//
// Le bûcheron NE MINE PAS : il ne gagne jamais de fer. Garder ses lingots « pour plus tard » ne sert
// donc à rien — ce qu'il ne peut pas se forger à lui-même, il le forge pour un cartographe.
const ARMOR_ORDER = [                      // la moins chère d'abord (même ordre que gear.ARMOR_PIECES)
  { slot: 'boots', name: 'iron_boots', ingots: 4 },
  { slot: 'helmet', name: 'iron_helmet', ingots: 5 },
  { slot: 'leggings', name: 'iron_leggings', ingots: 7 },
  { slot: 'chestplate', name: 'iron_chestplate', ingots: 8 },
];
const _RANK = { leather: 1, golden: 2, chainmail: 2, iron: 3, diamond: 4, netherite: 5 };
const _covers = (names, slot) => (names || []).some((n) => typeof n === 'string'
  && n.endsWith('_' + slot) && (_RANK[n.split('_')[0]] || 0) >= 3);
const MIN_PIECE_INGOTS = 4;

/** PUR — pièces fer-ou-mieux manquantes (inv = {nom: n}, worn = noms portés), la moins chère d'abord. */
function missingIronPieces(inv, worn) {
  const have = Object.keys(inv || {}).filter((n) => (inv[n] || 0) > 0).concat(Array.from(worn || []));
  return ARMOR_ORDER.filter((p) => !_covers(have, p.slot)).map((p) => p.name);
}

/**
 * PUR — que faire pour MA propre armure ? `worn` = pièces PORTÉES saines, `pocket` = pièces d'armure
 * SAINES en poche (une pièce usée, sortie de son slot quand on l'a remplacée, n'en est pas une),
 * `ingots` = lingots en poche. {act:'equip', piece} (gratuit) > {act:'forge', piece, ingots} > null.
 */
function ownArmorAction({ worn, pocket, ingots } = {}) {
  const missing = ARMOR_ORDER.filter((p) => !_covers(Array.from(worn || []), p.slot));
  for (const p of missing) {
    const it = (pocket || []).find((n) => _covers([n], p.slot));
    if (it) return { act: 'equip', piece: it };
  }
  const budget = Number(ingots) || 0;
  for (const p of missing) if (budget >= p.ingots) return { act: 'forge', piece: p.name, ingots: p.ingots };
  return null;
}

/**
 * PUR — quel cartographe armer, avec quelles pièces ? Le plus NU d'abord (nom ASC en départage), présence
 * fraîche, pas déjà servi (`skip`). Ses pièces manquantes viennent de `missing` (publié dans sa présence) ;
 * sans ce champ on ne sait quoi forger que s'il est à 0 pièce. Plan glouton la moins chère d'abord : une
 * pièce saine déjà en poche (`pocket`) est gratuite, sinon elle coûte des lingots. Une pièce dont un
 * exemplaire USÉ traîne en poche (`brokenPocket`) n'est pas planifiée : le don jette tout ce qui porte ce nom.
 * @returns {{to, armor, pieces: string[], ingots: number}|null}
 */
function pickMapperForLumberjack({ mates, selfName, now, ingots, pocket, brokenPocket, skip,
  freshMs = LUMBERJACK_FRESH_MS } = {}) {
  const t = now || Date.now();
  const inPocket = new Set(pocket || []);
  const broken = new Set(brokenPocket || []);
  const cands = (mates || []).filter((m) => m && m.name && m.name !== selfName && m.role === 'mapper'
    && _fresh(m, t, freshMs) && (m.armor || 0) < 4 && !(skip && skip.has(m.name)))
    .sort((a, b) => ((a.armor || 0) - (b.armor || 0)) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const m of cands) {
    let need;
    if (Array.isArray(m.missing)) need = new Set(m.missing);
    else if (!(m.armor > 0)) need = new Set(ARMOR_ORDER.map((p) => p.name));
    else continue;                                   // statut d'avant le champ `missing` : on ne devine pas
    let budget = Math.max(0, Number(ingots) || 0);
    let spent = 0;
    const pieces = [];
    for (const p of ARMOR_ORDER) {
      if (!need.has(p.name) || broken.has(p.name)) continue;
      if (inPocket.has(p.name)) { pieces.push(p.name); continue; }
      if (budget >= p.ingots) { pieces.push(p.name); budget -= p.ingots; spent += p.ingots; }
    }
    if (pieces.length) return { to: String(m.name), armor: m.armor || 0, pieces, ingots: spent };
  }
  return null;
}

/** PUR — toutes les pièces prévues sont-elles en poche ? (noms de la poche) */
function ljGiftReady(pieces, pocketNames) {
  if (!pieces || !pieces.length) return false;
  const have = new Set(pocketNames || []);
  return pieces.every((p) => have.has(p));
}

// ─── EXPÉDITION FORESTIÈRE (20/10 soir) ────────────────────────────────────────────────────────────
// Mesure : `lj_stock` timeout ×6 et `logs not_found` ×10 sur une session, 19 `unstuck`. Le bûcheron
// s'acharne sur le même coin. Au 2e échec en 10 min, il part vers la forêt CONNUE la plus proche de la
// carte du groupe (jambes GoalNearXZ, même marche que l'expédition vers le gibier) et y pose `work`.
const LJ_STOCK_FAIL_WINDOW_MS = 10 * 60 * 1000;
const LJ_STOCK_FAILS_FOR_TRIP = 2;
const LJ_STOCK_FAILS_CAP = 6;
const LJ_FOREST_TRIP_MS = 120000;     // plafond de la marche
const LJ_FOREST_MIN_DIST = 48;        // plus près, c'est le coin où l'on échoue déjà
const LJ_FOREST_MAX_DIST = 256;       // ≈ ce que 120 s de jambes couvrent en terrain réel
// Le confine rappelle le bot au-delà de 140 × 1,25 = 175 blocs de la base : une forêt plus loin que ça
// serait quittée au premier `confine_enforce`. On reste dans la poche, avec une marge.
const LJ_FOREST_ANCHOR_MAX = 150;
const LJ_FOREST_DEPLETED_RADIUS = 64; // == worldMemory.DEPLETED_RADIUS (même rayon que directedTarget)
const LJ_FOREST_AVOID_MS = 30 * 60 * 1000;
const LJ_FOREST_AVOID_CAP = 8;
const LJ_FOREST_CELL = 128;
const LJ_FOREST_INSET = 32;           // on entre dans la cellule (son biome vient d'un seul échantillon)
const _FOREST_RE = /forest|taiga|jungle|grove|wooded|mangrove|swamp/;
const _WET_RE = /ocean|river|beach/;

const _finite = (v) => typeof v === 'number' && Number.isFinite(v);

/** PUR — échecs `lj_stock` récents (instants ms), ni futurs ni hors fenêtre, bornés. */
function stockFailsPrune(list, now) {
  const t = _finite(now) ? now : Date.now();
  const out = (Array.isArray(list) ? list : []).filter((x) => _finite(x) && x <= t && (t - x) < LJ_STOCK_FAIL_WINDOW_MS);
  out.sort((a, b) => a - b);
  return out.slice(-LJ_STOCK_FAILS_CAP);
}
function stockFailsAdd(list, now) {
  const t = _finite(now) ? now : Date.now();
  return stockFailsPrune((Array.isArray(list) ? list : []).concat([t]), t);
}
function needsForestTrip(list, now) { return stockFailsPrune(list, now).length >= LJ_STOCK_FAILS_FOR_TRIP; }

/** PUR — un biome où l'on coupe du bois (jamais l'eau). */
function isForestBiome(name) {
  if (typeof name !== 'string' || !name) return false;
  const n = name.startsWith('minecraft:') ? name.slice(10) : name;
  return _FOREST_RE.test(n) && !_WET_RE.test(n);
}

/** PUR — forêts ratées récemment `[{x,z,at}]` (30 min, bornées). */
function forestTriedPrune(list, now) {
  const t = _finite(now) ? now : Date.now();
  const out = (Array.isArray(list) ? list : []).filter((e) => e && _finite(e.x) && _finite(e.z) && _finite(e.at)
    && e.at <= t && (t - e.at) < LJ_FOREST_AVOID_MS).map((e) => ({ x: e.x, z: e.z, at: e.at }));
  out.sort((a, b) => a.at - b.at);
  return out.slice(-LJ_FOREST_AVOID_CAP);
}
function forestTriedAdd(list, cell, now) {
  const t = _finite(now) ? now : Date.now();
  const kept = forestTriedPrune(list, t);
  if (!cell || !_finite(cell.x) || !_finite(cell.z)) return kept;
  return forestTriedPrune(kept.concat([{ x: Math.round(cell.x), z: Math.round(cell.z), at: t }]), t);
}

/**
 * PUR, DÉTERMINISTE — la forêt connue la plus proche. `biomes` = cellules de la mémoire de monde
 * ({name, x, z}, coin SO de 128²) ; point visé = le plus proche du bot DANS la cellule, rentré de 32.
 * Exclut : l'eau, les points à < 48 ou > 256 blocs du bot, à > 150 de la base (`anchor`, si connue),
 * à ≤ 64 d'une cellule RASÉE (`depleted` de kind `wood`, ou sans kind — un épuisement de MINERAI ne
 * coupe pas les arbres, leçon world_mn12), à ≤ 64 d'une forêt ratée il y a < 30 min (`avoid`).
 * Les `old_growth_*` passent après (troncs de 15 blocs dont le haut est hors d'atteinte), puis distance, x, z.
 * @returns {{x, z, biome, dist}|null}
 */
function pickForestCell({ from, anchor, biomes, depleted, avoid, now } = {}) {
  if (!from || !_finite(from.x) || !_finite(from.z)) return null;
  const t = _finite(now) ? now : Date.now();
  const dep = (Array.isArray(depleted) ? depleted : []).filter((d) => d && _finite(d.x) && _finite(d.z)
    && (d.kind === undefined || d.kind === null || d.kind === 'wood'));
  const av = forestTriedPrune(avoid, t);
  const near = (list, x, z) => list.some((d) => Math.hypot(d.x - x, d.z - z) <= LJ_FOREST_DEPLETED_RADIUS);
  const clamp = (v, lo, hi) => (v < lo ? lo : (v > hi ? hi : v));
  let best = null;
  let bestKey = null;
  for (const b of Array.isArray(biomes) ? biomes : []) {
    if (!b || !isForestBiome(b.name) || !_finite(b.x) || !_finite(b.z)) continue;
    const cx = Math.floor(b.x / LJ_FOREST_CELL) * LJ_FOREST_CELL;
    const cz = Math.floor(b.z / LJ_FOREST_CELL) * LJ_FOREST_CELL;
    const x = Math.round(clamp(from.x, cx + LJ_FOREST_INSET, cx + LJ_FOREST_CELL - 1 - LJ_FOREST_INSET));
    const z = Math.round(clamp(from.z, cz + LJ_FOREST_INSET, cz + LJ_FOREST_CELL - 1 - LJ_FOREST_INSET));
    const d = Math.hypot(x - from.x, z - from.z);
    if (d < LJ_FOREST_MIN_DIST || d > LJ_FOREST_MAX_DIST) continue;
    if (anchor && _finite(anchor.x) && _finite(anchor.z) && Math.hypot(x - anchor.x, z - anchor.z) > LJ_FOREST_ANCHOR_MAX) continue;
    if (near(dep, x, z) || near(av, x, z)) continue;
    const key = [String(b.name).includes('old_growth') ? 1 : 0, d, x, z];
    let better = !bestKey;
    for (let i = 0; !better && i < key.length; i++) {
      if (key[i] < bestKey[i]) better = true;
      else if (key[i] > bestKey[i]) break;
    }
    if (better) { best = { x, z, biome: String(b.name), dist: Math.round(d) }; bestKey = key; }
  }
  return best;
}

// ─── BOIS MANQUANT POUR UN CRAFT (20/10, NethBot2 session 312) ────────────────────────────────────
// `gift_pick` échouait 16× `pick_recovery:no_sticks` (+ `craft stick no_table:unknown_item`) avec
// 1 planche d'acacia et 0 bûche, à y 13 — et ne demandait JAMAIS de bois au bûcheron : la demande ne
// partait que pour les buts dont le skill est `gatherLog`. Tout manque de bois pour un craft (bâtons,
// planches, table) doit passer par la même demande que les buts bois.
const WOOD_SHORT_RE = /no_sticks|no_wood|no_planks|no_table|no_recipe|unknown_item/;
const PLANKS_FOR_TABLE = 4;
const PLANKS_FOR_STICKS = 2;               // 2 planches → 4 bâtons

/** PUR — planches disponibles (bûches comptées 4 planches) < planches requises (table si absente, bâtons si < need) ? */
function craftWoodShortage({ logs = 0, planks = 0, sticks = 0, table = false, needSticks = 2, needTable = true } = {}) {
  const required = (needTable && !table ? PLANKS_FOR_TABLE : 0) + (sticks < needSticks ? PLANKS_FOR_STICKS : 0);
  return required > 0 && (planks + logs * 4) < required;
}

/**
 * PUR — cet échec de but vient-il d'un MANQUE DE BOIS ? reason = raison du skill, goalName = but,
 * inv = {nom: n}, hasTable = table de craft à portée. Les bâtons ne comptent que pour un craft qui en
 * consomme (pioche, épée, torche, bâton lui-même) ; une pièce d'armure ne demande qu'une table.
 */
function woodShortForFailure({ reason, goalName, inv, hasTable } = {}) {
  const r = String(reason || '');
  if (!WOOD_SHORT_RE.test(r)) return false;
  const wantSticks = /stick|pick|sword|torch|shovel|axe/.test(r + ' ' + String(goalName || ''));
  let planks = 0;
  for (const [k, v] of Object.entries(inv || {})) if (k.endsWith('_planks')) planks += v || 0;
  return craftWoodShortage({
    logs: logCount(inv), planks, sticks: (inv && inv.stick) || 0,
    table: !!hasTable || ((inv && inv.crafting_table) || 0) > 0,
    needSticks: wantSticks ? 2 : 0,
  });
}

// ─── ARMURE DES CARTOGRAPHES PAR LOTS (20/10, NethBot2) ───────────────────────────────────────────
// La chaîne mapper_armor visait un set COMPLET (24 lingots) : NethBot2, 11 lingots en poche et deux
// cartographes nus, redescendait miner au lieu de forger casque + bottes (9) et de les livrer tout de
// suite. Lot = les pièces MANQUANTES du cartographe réservé qui tiennent dans les lingots en poche, la
// moins chère d'abord (même plan que celui du bûcheron, pickMapperForLumberjack). null = rien d'abordable.
function giftBatchFor({ target, ingots, pocket, brokenPocket, now } = {}) {
  if (!target || !target.name) return null;
  return pickMapperForLumberjack({ mates: [target], selfName: null, now, ingots, pocket, brokenPocket });
}

// ─── BÛCHERON OISIF → FER (21/10) ─────────────────────────────────────────────────────────────────
// Mesure (run de zéro du 21/10) : `lj_wait` = 64 min sur 303 (21 %) — le bûcheron, stock plein et
// personne à servir, attendait par tranches de 5 min. Or c'est LUI qui fournit l'armure des
// cartographes (gift_craft) et la sienne (lj_own_armor), toutes deux en LINGOTS. Un joueur dans sa
// position irait chercher du fer pendant que les autres n'ont besoin de rien.
// Tranche BORNÉE (4 min), PRÉEMPTÉE par toute demande de bois (câblage : index.js ljIronSlice) :
//   'mine'  : (21/10) aucune grappe connue → descente en escalier + branch-mine, retour par /home work ;
//   'smelt' : du fer brut en poche et de quoi fondre (four en poche, ou 8 cobble pour en faire un) ;
//   'cave'  : une grappe de fer EXPOSÉ connue (caveIron — le fer des parois de grotte, proche surface) ;
//   null    : rien d'utile → l'attente historique.
const LJ_IRON_TARGET = 24;              // un set complet de cartographe ; au-delà, le fer attend son forgeron
const LJ_IRON_SLICE_MS = 240000;        // une tranche ; la demande de bois la coupe avant
const LJ_IRON_RETRY_MS = 20000;         // entre deux tranches (anti boucle chaude sur un échec instantané)
const LJ_IRON_CHECK_MS = 30000;         // pendant l'attente, on re-regarde s'il y a du fer à aller chercher
const FURNACE_COBBLE = 8;
const SMELT_BATCH = 4;
const LJ_MINE_COBBLE = 8;               // 'mine' : de quoi murer la lave et sceller en bas
// 'mine' : une tranche fait 4 min — descendre jusqu'à Y16 depuis y 70 en prendrait la moitié (~55 paliers).
// Le fer est fréquent dès y < 56 (pic à 16) : on descend de LJ_MINE_DEPTH blocs, jamais sous 16.
const LJ_MINE_DEPTH = 28;
/** PUR — altitude du couloir d'une tranche 'mine' depuis l'altitude actuelle. */
function ljMineTargetY(y) { return Math.max(16, Math.floor(Number(y) || 0) - LJ_MINE_DEPTH); }

/**
 * PUR — que faire du temps mort du bûcheron ? sig = { rawIron, ingots, cobble, hasFurnace, hasStonePick,
 * caveAvailable, canMine, nightLock, now, lastSliceAt }. → 'smelt' | 'cave' | 'mine' | null.
 */
function ljIronSlicePlan(sig = {}) {
  const raw = Math.max(0, Number(sig.rawIron) || 0);
  const ingots = Math.max(0, Number(sig.ingots) || 0);
  const now = Number(sig.now) || 0;
  if (now - (Number(sig.lastSliceAt) || 0) < LJ_IRON_RETRY_MS) return null;
  // Fondre d'abord : quelques secondes de four, et c'est ce qui débloque les forges. Par lot de 4 (la
  // pièce la moins chère) tant qu'une grotte reste à miner : chaque fonte brûle du stock de bois.
  const canSmelt = sig.hasFurnace || (Number(sig.cobble) || 0) >= FURNACE_COBBLE;
  if (canSmelt && (raw >= SMELT_BATCH || (raw > 0 && !sig.caveAvailable))) return 'smelt';
  if (raw + ingots >= LJ_IRON_TARGET) return null;
  if (sig.nightLock) return null;           // nu de nuit : la discipline de nuit garde la main
  if (!sig.hasStonePick) return null;       // le fer exige une pioche pierre
  // 3e ACTE (21/10, NethBot1 : `lj_wait` 50 min sur 70, 0 tranche — aucune grappe exposée à ≤ 80 blocs).
  // Sans grappe connue, une tranche de branch-mine (descente à Y16 + couloir), toujours bornée et
  // préemptée par la demande de bois. `canMine` (câblage) = de quoi miner proprement : pioche pierre et
  // cobble pour murer la lave ; absent → l'attente historique.
  if (!sig.caveAvailable) return sig.canMine ? 'mine' : null;
  return 'cave';
}

module.exports = {
  ljIronSlicePlan, LJ_MINE_COBBLE, LJ_MINE_DEPTH, ljMineTargetY, LJ_IRON_TARGET, LJ_IRON_SLICE_MS, LJ_IRON_RETRY_MS, LJ_IRON_CHECK_MS,
  WOOD_REQUEST_TTL_MS, WOOD_REQUEST_COOLDOWN_MS, WOOD_UNDERGROUND_Y, LUMBERJACK_FRESH_MS, WOOD_WANT_MIN, WOOD_WANT_MAX,
  LUMBERJACK_STOCK, LUMBERJACK_RESERVE, WOOD_MIN_GIFT,
  isWoodGoal, woodWantFor, logCount, activeLumberjack, woodWaitDecision, preferredLumberjack,
  LUMBERJACK_MIN_WORN, wornIronCount,
  lumberjackVerdict, pickWoodRequest, tossPlan,
  ARMOR_ORDER, MIN_PIECE_INGOTS, missingIronPieces, ownArmorAction, pickMapperForLumberjack, ljGiftReady,
  LJ_STOCK_FAIL_WINDOW_MS, LJ_STOCK_FAILS_FOR_TRIP, LJ_FOREST_TRIP_MS, LJ_FOREST_MIN_DIST, LJ_FOREST_MAX_DIST,
  LJ_FOREST_ANCHOR_MAX, LJ_FOREST_AVOID_MS,
  craftWoodShortage, woodShortForFailure, giftBatchFor,
  stockFailsPrune, stockFailsAdd, needsForestTrip, isForestBiome, forestTriedPrune, forestTriedAdd, pickForestCell,
};
