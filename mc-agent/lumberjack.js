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
function woodWaitDecision({ isLumberjack, isMapper, lumberjack, request, timedOutAt, now,
  ttlMs = WOOD_REQUEST_TTL_MS, cooldownMs = WOOD_REQUEST_COOLDOWN_MS } = {}) {
  const t = now || Date.now();
  if (isLumberjack || isMapper) return { action: 'self', clear: !!request };
  if (!lumberjack) return { action: 'self', clear: !!request };
  if (!request && timedOutAt && (t - timedOutAt) < cooldownMs) return { action: 'self', clear: false };
  if (!request) return { action: 'request' };
  const age = t - (request.at || 0);
  // Demande héritée d'un process d'il y a longtemps (mémo base) : ce n'est pas un échec du bûcheron
  // d'aujourd'hui, on repart d'une demande neuve plutôt que de conclure à un timeout.
  if (age >= 2 * ttlMs || age < 0) return { action: 'request' };
  if (age >= ttlMs) return { action: 'timeout' };
  return { action: 'wait', remainingMs: ttlMs - age };
}

/**
 * PUR — le bûcheron PRÉFÉRÉ du groupe (déterministe : tous les bots calculent le même) :
 * l'ouvrier le mieux armé (pièces fer acquises), nom ASC en départage. Jamais un cartographe.
 * null s'il y a moins de 2 ouvriers frais (seul, un bûcheron n'aurait personne à servir et ne
 * ferait plus rien d'autre). `selfArmor` = MON armure réelle (pas celle publiée il y a 60 s).
 */
function preferredLumberjack({ selfName, selfArmor, mates, now, freshMs = LUMBERJACK_FRESH_MS } = {}) {
  const t = now || Date.now();
  const all = [];
  if (selfName) all.push({ name: String(selfName), armor: selfArmor || 0 });
  for (const m of mates || []) {
    if (!m || !m.name || m.name === selfName || m.role === 'mapper') continue;
    if (!_fresh(m, t, freshMs)) continue;
    all.push({ name: String(m.name), armor: m.armor || 0 });
  }
  if (all.length < 2) return null;
  all.sort((a, b) => (b.armor - a.armor) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return all[0].name;
}

/**
 * PUR — verdict d'élection pour CE bot.
 *  holder = claim `lumberjack` courante ({by, at} déjà purgée des expirées) ou null.
 *  'follower' : un autre est bûcheron (ou je ne suis pas le préféré) ;
 *  'keep'     : la claim est à moi → je suis (ou deviens) bûcheron, je rafraîchis ;
 *  'claim'    : claim libre et c'est à moi de la prendre (préféré, ou déjà bûcheron = sticky) ;
 *  'release'  : je tiens la claim mais il n'y a plus personne à servir (seul ouvrier frais).
 */
function lumberjackVerdict({ selfName, holder, preferred, amLumberjack } = {}) {
  if (holder && holder.by && holder.by !== selfName) return 'follower';
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

module.exports = {
  WOOD_REQUEST_TTL_MS, WOOD_REQUEST_COOLDOWN_MS, LUMBERJACK_FRESH_MS, WOOD_WANT_MIN, WOOD_WANT_MAX,
  LUMBERJACK_STOCK, LUMBERJACK_RESERVE, WOOD_MIN_GIFT,
  isWoodGoal, woodWantFor, logCount, activeLumberjack, woodWaitDecision, preferredLumberjack,
  lumberjackVerdict, pickWoodRequest, tossPlan,
};
