'use strict';
// VERDICT DE ZONE ET MIGRATION AUTONOME (demande Massii, 27/07).
//
// « Le fer et les autres matériaux ne sont pas qu'au spawn. Sur un serveur public, ou quand la zone
// est pleine de poches d'eau, ils doivent s'éloigner assez pour trouver une nouvelle zone tout
// seuls, continuer à marcher jusqu'à trouver le bon endroit, y poser leur home safe, et miner LÀ.
// Ce n'est pas parce qu'il reste 5-6 veines de fer qu'il faut rester dans une zone déjà exploitée —
// et pareil pour l'eau : 5-6 veines sèches dans une zone noyée ne justifient pas d'y rester. »
//
// C'est le frein n°1 MESURÉ, pas une intuition :
//   - world_mn9 : `descend_y16` échoue à 73-87 % (eau + vide), `logs` à 82 % (zone rasée) ;
//   - world_ax4 : `logs` = 2001 essais / 1853 échecs (93 %), soit 46 % de TOUS les buts du run,
//     parce que l'exploration revisitait 2036 fois la cellule que les bots avaient eux-mêmes rasée.
//
// Module PUR (aucun accès bot/fs, horloge injectée) → testable sans client Minecraft.

const { vanillaHint, DEPLETED_RADIUS } = require('./worldMemory');

// ─── Seuils ─────────────────────────────────────────────────────────────────────────────────────
// HYSTÉRÉSIS OBLIGATOIRE : sans elle la flotte devient nomade et ne produit plus rien — une
// migration coûte plusieurs minutes de marche, elle doit être payée par un vrai constat d'échec.

const MIN_MINUTES_IN_ZONE = 15;                 // temps minimum sur place avant TOUT verdict
const MIGRATION_COOLDOWN_MS = 20 * 60 * 1000;   // délai minimum entre deux migrations

// ⚠️ PREUVE ÉCRASANTE — mesuré le 27/07 sur `world_mn10`, régression signalée par Massii
// (« avant on réussissait en 45 min à avoir quasi fini toute l'armure », et là l'armure stagnait
// à 3 depuis des heures) :
//     logsNotFound: 24 (seuil 8) · depletedNear: 10 (seuil 3) · ironMined: 0  →  verdict STAY
// L'hystérésis et le cooldown existent pour empêcher le NOMADISME sur une preuve FAIBLE. Face à
// une preuve massive ils deviennent absurdes : le bot reste vingt minutes dans une zone où il ne
// peut RIEN faire. Un joueur part tout de suite. On ne les supprime pas — on les raccourcit quand
// la zone est prouvée morte au-delà de tout doute (3× les seuils).
// C'est invisible sur un monde SONDÉ (mn9 : les bots n'avaient jamais besoin de migrer) et
// mortel sur un monde brut — exactement le cas que Massii veut faire tenir aux bots.
const OVERWHELMING_FACTOR = 3;
const MIN_MINUTES_URGENT = 4;                   // on laisse quand même le temps de constater
const COOLDOWN_URGENT_MS = 5 * 60 * 1000;       // et on garde un anti-yo-yo

const WATER_FAILS_MAX = 6;         // échecs eau (water_ahead/drowning/sauvetages) → nappe, pas malchance
const LOGS_NOT_FOUND_MAX = 8;      // `logs not_found` → la zone est rasée (le goulot d'ax4)
const EXHAUSTED_MINING_MIN = 20;   // minutes de minage effectif avant de juger le rendement
const EXHAUSTED_IRON_MIN = 8;      // moins de N fers sur cette durée = filon épuisé
const DEPLETED_NEAR_MAX = 3;       // cellules déjà épuisées dans le rayon → on tourne en rond

// Fourchette de migration : assez loin pour sortir de la zone exploitée (les cellules voisines sont
// le même terrain déjà fouillé), assez près pour que le trek reste survivable.
const MIGRATE_MIN_DIST = 200;
const MIGRATE_MAX_DIST = 1500;

// « Si une zone a été vidée de ses minerais, il s'éloigne de BEAUCOUP » (Massii, 27/07).
// Une nappe d'eau ou une forêt rasée sont des problèmes LOCAUX : 200 blocs en sortent. Un filon
// épuisé, non — les cellules voisines sont le même sous-sol, déjà fouillé par la même flotte.
// Migrer de 200 blocs pour cause d'épuisement, c'est déménager dans la pièce d'à côté.
const MIGRATE_FAR_MIN_DIST = 600;
const _FAR_REASONS = new Set(['exhausted', 'depleted']);

/** Distance minimale de migration selon le motif : loin pour l'épuisement, normal sinon. (pur) */
function minDistFor(reason) {
  return _FAR_REASONS.has(reason) ? MIGRATE_FAR_MIN_DIST : MIGRATE_MIN_DIST;
}

// Marche à l'aveugle (carte encore vide) : jambes courtes, vérifiées, et un cap TOTAL.
const LEG_DIST = 128;
const MAX_LEGS = 12;               // 12 × 128 ≈ 1536 blocs, cohérent avec MIGRATE_MAX_DIST

const _WET_BIOME_RE = /ocean|river/i;

/** Biome aquatique (océan/rivière) : un ouvrier n'y va jamais — ce sont les cartographes qui naviguent. */
function isWetBiome(name) {
  return typeof name === 'string' && _WET_BIOME_RE.test(name);
}

function _num(v) { return Number.isFinite(v) ? v : 0; }
function _horiz(ax, az, bx, bz) { return Math.hypot(ax - bx, az - bz); }

/**
 * Faut-il quitter cette zone ? (PUR)
 *
 * @param {object} s compteurs accumulés depuis le dernier ré-ancrage :
 *   minutesInZone, waterFails, logsNotFound, ironMined, miningMinutes, depletedNear,
 *   dryCellKnown (une cellule sèche mappée est-elle atteignable ?), lastMigrationAt, now.
 * @returns {{verdict:'stay'|'migrate', reason:string}}
 */
function zoneVerdict(s, opts = {}) {
  if (!s || typeof s !== 'object') return { verdict: 'stay', reason: 'no_data' };
  // Zone prouvée morte AU-DELÀ DE TOUT DOUTE → seuils d'urgence (cf. OVERWHELMING_FACTOR).
  const damning = _num(s.logsNotFound) >= LOGS_NOT_FOUND_MAX * OVERWHELMING_FACTOR
    || _num(s.depletedNear) >= DEPLETED_NEAR_MAX * OVERWHELMING_FACTOR
    || (_num(s.waterFails) >= WATER_FAILS_MAX * OVERWHELMING_FACTOR && !s.dryCellKnown);

  const minMinutes = opts.minMinutes != null ? opts.minMinutes
    : (damning ? MIN_MINUTES_URGENT : MIN_MINUTES_IN_ZONE);
  const cooldownMs = opts.cooldownMs != null ? opts.cooldownMs
    : (damning ? COOLDOWN_URGENT_MS : MIGRATION_COOLDOWN_MS);

  const inZone = s.minutesInZone;
  if (!Number.isFinite(inZone) || inZone < minMinutes) return { verdict: 'stay', reason: 'too_soon' };

  const now = _num(s.now);
  if (_num(s.lastMigrationAt) > 0 && (now - _num(s.lastMigrationAt)) < cooldownMs) {
    return { verdict: 'stay', reason: 'cooldown' };
  }

  // 1) EAU — mais seulement si on n'a pas déjà mieux à portée : une cellule sèche mappée est une
  //    bien meilleure réponse qu'un trek de 1500 blocs (et le code sait déjà y aller, cf. driestCell).
  if (_num(s.waterFails) >= WATER_FAILS_MAX && !s.dryCellKnown) {
    return { verdict: 'migrate', reason: 'water' };
  }

  // 2) ZONE ÉPUISÉE — « ce n'est pas parce qu'il reste 5-6 veines de fer qu'il faut rester ».
  // DÉPLÉTION SPATIALE — la carte montre ≥N cellules déjà épuisées autour ⇒ on « tourne en rond ».
  // MAIS un filon qui PAIE encore prime sur ce signal de carte. Mesuré world_mn10 (27/07) : des
  // bots à 36-103 fers/~20 min migraient QUAND MÊME sur le seul depletedNear≥3, perdant base + mine
  // + bois pour une zone fraîche souvent SANS ARBRES → churn bois↔profondeur (frein n°1, done 1→0).
  // On ne quitte pour dépletion QUE si le rendement courant est sous le plancher `exhausted` : un
  // bot qui sort du fer n'est pas « en rond ». Un vrai secteur ratissé (fer<seuil) part vite, sans
  // devoir attendre les 20 min de `exhausted` (le signal spatial suffit à trancher). Placé AVANT
  // `exhausted` pour garder une raison distincte (spatial + rendement, ≠ rendement seul).
  if (_num(s.depletedNear) >= DEPLETED_NEAR_MAX && _num(s.ironMined) < EXHAUSTED_IRON_MIN) {
    return { verdict: 'migrate', reason: 'depleted' };
  }
  if (_num(s.miningMinutes) >= EXHAUSTED_MINING_MIN && _num(s.ironMined) < EXHAUSTED_IRON_MIN) {
    return { verdict: 'migrate', reason: 'exhausted' };
  }

  // 3) BOIS — la zone est rasée autour de l'ancre (46 % de tous les buts échoués sur ax4).
  if (_num(s.logsNotFound) >= LOGS_NOT_FOUND_MAX) {
    return { verdict: 'migrate', reason: 'wood' };
  }

  return { verdict: 'stay', reason: 'ok' };
}

/**
 * Faut-il TRACER ce verdict ? (PUR, dedup anti-emballement)
 *
 * `checkZoneVerdict` tourne toutes les 60 s mais n'émettait RIEN sur 'stay' : impossible de savoir
 * POURQUOI une flotte visiblement noyée ne migre jamais (trop tôt ? cooldown ? cellule sèche déjà
 * connue qui supprime la migration eau ?). Le verdict de migration n'a jamais tiré de toute une
 * journée (0 event) et sans cette trace on ne peut ni prouver ni infirmer que c'est un bug.
 * On trace au CHANGEMENT de raison (un bot passe la plupart de sa vie sur 'too_soon' → 1 seul
 * event) et TOUJOURS sur 'migrate'.
 *
 * @param {{verdict:string,reason:string}} v  verdict courant
 * @param {string|null} prevReason  dernière raison tracée (état du caller)
 * @returns {{log:boolean, reason:string|null}} reason = la nouvelle raison à mémoriser
 */
function verdictTelemetry(v, prevReason) {
  const prev = prevReason == null ? null : prevReason;
  if (!v || typeof v !== 'object') return { log: false, reason: prev };
  const reason = v.reason == null ? null : v.reason;
  return { log: v.verdict === 'migrate' || prev !== reason, reason };
}

/**
 * Où migrer ? (PUR, DÉTERMINISTE)
 *
 * Déterministe = tous les ouvriers du groupe calculent la MÊME cible depuis la même carte
 * partagée → l'escouade migre ENSEMBLE au même endroit, sans négociation. (Le claim partagé
 * `migration:<cellule>` posé par le caller sert juste à ce que le premier arrivé fixe le choix
 * si les cartes divergent d'un bot à l'autre.)
 *
 * Priorité : cellule BOISÉE (le bois est le goulot n°1) > autre terre ; à rang égal, la plus
 * proche ; à distance égale, l'ordre lexicographique de (x,z) — jamais l'ordre du tableau.
 *
 * @returns {{x,z,source:'mapped',biome:string}|null} — null = carte inutilisable, le caller
 *          bascule sur la marche à l'aveugle (migrationLeg).
 */
function pickMigrationTarget({
  from, biomes, depleted, minDist = MIGRATE_MIN_DIST, maxDist = MIGRATE_MAX_DIST,
  depletedRadius = DEPLETED_RADIUS,
} = {}) {
  if (!from || !Number.isFinite(from.x) || !Number.isFinite(from.z)) return null;
  const list = Array.isArray(biomes) ? biomes : [];
  if (!list.length) return null;
  const wooded = vanillaHint('log');
  const dep = Array.isArray(depleted) ? depleted : [];
  const isDepleted = (x, z) => dep.some((d) => d && Number.isFinite(d.x)
    && _horiz(d.x, d.z, x, z) <= depletedRadius);

  let best = null;
  let bestScore = null;
  for (const b of list) {
    if (!b || !b.name || !Number.isFinite(b.x) || !Number.isFinite(b.z)) continue;
    if (isWetBiome(b.name)) continue;                       // ouvriers ≠ cartographes : jamais l'eau
    const d = _horiz(from.x, from.z, b.x, b.z);
    if (d < minDist || d > maxDist) continue;               // trop près = déjà exploité ; trop loin = suicide
    if (isDepleted(b.x, b.z)) continue;
    const score = [wooded.includes(b.name) ? 0 : 1, d, b.x, b.z];
    if (!bestScore || _lex(score, bestScore) < 0) { best = b; bestScore = score; }
  }
  if (!best) return null;
  return { x: Math.round(best.x), z: Math.round(best.z), source: 'mapped', biome: best.name };
}

/** Comparaison lexicographique de deux tuples numériques (départage 100 % déterministe). */
function _lex(a, b) {
  for (let i = 0; i < a.length; i++) {
    if (a[i] < b[i]) return -1;
    if (a[i] > b[i]) return 1;
  }
  return 0;
}

/**
 * Marche à l'aveugle : point de la jambe suivante sur le cap. (PUR)
 * Retourne null au-delà du cap total — la migration n'est jamais un nomadisme sans fin.
 */
function migrationLeg({ from, heading = 0, legs = 0, legDist = LEG_DIST, maxLegs = MAX_LEGS } = {}) {
  if (!from || !Number.isFinite(from.x) || !Number.isFinite(from.z)) return null;
  if (!Number.isFinite(legs) || legs >= maxLegs) return null;
  return {
    x: Math.round(from.x + legDist * Math.cos(heading)),
    z: Math.round(from.z + legDist * Math.sin(heading)),
  };
}

// ─── L'ÉTAT DE ZONE DOIT SURVIVRE AU PROCESS (cause racine trouvée le 27/07 au soir) ────────────
//
// La migration n'a JAMAIS tiré de la journée, alors que la flotte était visiblement noyée
// (`descend_y16` échouait à 77-82 % sur `water_ahead`, ~20 sauvetages d'eau par session).
// Raison : l'horloge de zone et les compteurs vivaient dans le PROCESS. Or le self-healing
// relance un bot toutes les quelques minutes → chaque respawn les remettait à zéro → l'hystérésis
// de 15 min n'était JAMAIS atteinte, et la porte `too_soon` bloquait en permanence.
//
// C'est exactement la classe de bug documentée le matin même (pièges #52 et #63) : **une mémoire
// d'échec par process ne sert à rien quand les sessions redémarrent sans cesse.** L'état de zone
// rejoint donc le mémo de base, là où vit déjà la dette de mort.

/** Compteurs de zone vierges, horloge démarrée maintenant. (pur) */
function zoneStateInit(now) {
  return {
    anchoredAt: now, waterFails: 0, logsNotFound: 0,
    ironMined: 0, miningMs: 0, lastMigrationAt: 0,
  };
}

/**
 * Reprend un état persisté — l'horloge CONTINUE au lieu de repartir de zéro. (pur)
 * Retombe sur un état frais si le mémo est absent, corrompu, ou daté du futur (changement
 * d'heure, mémo hérité d'un autre monde) : une horloge future gèlerait la zone à vie.
 */
function zoneStateLoad(saved, now) {
  const fresh = zoneStateInit(now);
  if (!saved || typeof saved !== 'object') return fresh;
  const at = saved.anchoredAt;
  if (!Number.isFinite(at) || at > now) return fresh;
  return {
    anchoredAt: at,
    waterFails: _num(saved.waterFails),
    logsNotFound: _num(saved.logsNotFound),
    ironMined: _num(saved.ironMined),
    miningMs: _num(saved.miningMs),
    lastMigrationAt: _num(saved.lastMigrationAt),
  };
}

/** Après une migration : compteurs à zéro, et le cooldown court à partir de maintenant. (pur) */
function zoneStateAfterMigration(now) {
  return Object.assign(zoneStateInit(now), { lastMigrationAt: now });
}

// ─── Quel échec accuse la ZONE, et pas le bot ? (PUR) ───────────────────────────────────────────
// Mesuré live le 27/07 sur `world_mn9`, et c'est toute la cascade que voyait Massii :
//   zone rasée → plus de bois → plus de bâtons → PLUS DE PIOCHE → le bot passe devant des veines
//   de fer sans pouvoir les miner, et « casse la pierre avec les mains ».
// Le signal décisif n'était PAS `logs not_found` (à ce stade le bot n'essaie même plus de couper
// du bois : il boucle sur la réparation de sa pioche) mais `pick_recovery_failed: no_sticks`.
// D'où la règle : on compte le manque de MATIÈRE BOIS quel que soit le but qui l'a rencontré,
// sinon une zone rasée ne se déclare jamais rasée et le bot y reste piégé.

const _WOOD_LACK_RE = /no_wood|no_sticks|no_planks|no_log/i;
const _WATER_LACK_RE = /water|flood|drown/i;
const _WOOD_GOALS = new Set(['logs', 'planks', 'plank_buffer', 'crafting_table', 'sticks', 'wooden_pickaxe']);

/**
 * @returns {'wood'|'water'|null} — ce que cet échec dit de la ZONE (null = il accuse le bot).
 */
function zoneFailureKind(goalName, reason) {
  const r = String(reason == null ? '' : reason);
  if (!r) return null;
  if (_WATER_LACK_RE.test(r)) return 'water';
  if (_WOOD_LACK_RE.test(r)) return 'wood';
  // `not_found` est ambigu : il n'accuse la zone que sur un but de bois (un four introuvable,
  // c'est le bot qui n'en a pas posé, pas la zone qui est stérile).
  if (/not_found/i.test(r) && _WOOD_GOALS.has(goalName)) return 'wood';
  return null;
}

/**
 * Le terrain atteint au bout d'une jambe est-il le « bon endroit » ? (PUR)
 * Exigences minimales de Massii : des arbres (le bois est le goulot), les pieds au sec, pas d'océan.
 */
function legIsGood({ treesNear = 0, inWater = false, biome = null } = {}) {
  if (inWater) return false;
  if (isWetBiome(biome)) return false;
  return _num(treesNear) > 0;
}

module.exports = {
  zoneVerdict, verdictTelemetry, pickMigrationTarget, migrationLeg, legIsGood, isWetBiome, minDistFor, zoneFailureKind,
  zoneStateInit, zoneStateLoad, zoneStateAfterMigration,
  MIN_MINUTES_IN_ZONE, MIGRATION_COOLDOWN_MS, WATER_FAILS_MAX, LOGS_NOT_FOUND_MAX,
  EXHAUSTED_MINING_MIN, EXHAUSTED_IRON_MIN, DEPLETED_NEAR_MAX,
  MIGRATE_MIN_DIST, MIGRATE_MAX_DIST, MIGRATE_FAR_MIN_DIST, LEG_DIST, MAX_LEGS,
  OVERWHELMING_FACTOR, MIN_MINUTES_URGENT, COOLDOWN_URGENT_MS,
};
