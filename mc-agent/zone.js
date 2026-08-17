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

// ⚠️ CES SEUILS S'APPLIQUENT À UNE FENÊTRE GLISSANTE, PAS À UN CUMUL DE ZONE (fix world_mn14,
// 28/07). Les compteurs d'ÉVÉNEMENTS (waterFails / logsNotFound / ironMined) sont désormais
// alimentés par `windowAdd` et lus par `windowSum` sur les ZONE_WINDOW_MS dernières minutes —
// cf. le bloc « FENÊTRE GLISSANTE » plus bas pour la cause racine mesurée.
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

// ⚠️ BOIS : le plancher s'INVERSE (mesuré live world_mn11, 28/07 : 13 migrations 'wood' sur 16
// échouaient `underground:true`). Le plancher normal de 200 faisait sauter le bot par-dessus la
// forêt LA PLUS PROCHE (une flower_forest à 18-110 blocs) pour viser une forêt à 238-374 blocs —
// injoignable depuis le fond de la mine (le trek horizontal souterrain rend NoPath, le bot ne
// surface qu'après l'échec) → le bois n'était JAMAIS restocké, `done` figé à 0. Pour restocker du
// bois on veut la forêt la plus proche ; le plancher ne sert plus qu'à garantir un déplacement
// RÉEL (≥ MIGRATE_MIN_PROGRESS, sinon `zone_migrated dist<64` ne compterait pas). C'est l'exact
// contraire de l'épuisement (où la cellule d'à côté est le même sous-sol déjà fouillé).
const MIGRATE_WOOD_MIN_DIST = 64;   // == MIGRATE_MIN_PROGRESS (littéral : ce const est défini AVANT, pas de hoisting sur `const`)

/** Distance minimale de migration selon le motif : loin pour l'épuisement, court pour le bois
 *  (la forêt la plus proche), normal sinon. (pur) */
function minDistFor(reason) {
  if (_FAR_REASONS.has(reason)) return MIGRATE_FAR_MIN_DIST;
  if (reason === 'wood') return MIGRATE_WOOD_MIN_DIST;
  return MIGRATE_MIN_DIST;
}

// Distance minimale pour qu'un déplacement COMPTE comme une migration (mesuré live world_mn11 :
// un `zone_migrated dist:2 took_s:3` — le pathfinder avait rendu NoPath en 3 s sur une cible à
// 236 blocs, et le bot re-ancrait sa base 2 blocs plus loin en croyant avoir déménagé, cooldown
// brûlé, toujours dans la zone morte). En deçà, ce n'est pas un déménagement.
const MIGRATE_MIN_PROGRESS = 64;

// Marche par JAMBES : la seule facon d'aller loin. ⚠️ Une jambe doit tenir DANS LES CHUNKS
// CHARGES, sinon le pathfinder ne voit pas le terrain et rend NoPath immediatement.
// Mesure decisive (world_mn11, 28/07) : `view-distance=6` = 96 blocs cote serveur — or les
// jambes valaient 128 et la cible directe 250+. Resultat : `hop_failed moved:8` puis
// `zone_migration_failed`, a chaque migration bois. C'est le meme plafond que celui deja
// mesure pour les cartographes (piege #52b : portee reelle du cache client = 96 blocs).
// 64 laisse une vraie marge : le bot avance pendant que les chunks suivants se chargent.
const LEG_DIST = 64;
const MAX_LEGS = 24;               // 24 × 64 ≈ 1536 blocs : meme portee totale qu'avant
const LOADED_RADIUS = 96;          // au-dela, le pathfinder est aveugle → passer par les jambes

// ─── FENÊTRE GLISSANTE DES COMPTEURS D'ÉVÉNEMENTS (fix world_mn14, 28/07) ───────────────────────
//
// Les compteurs d'événements étaient des CUMULS DE ZONE : un bot au passé productif ne migrait
// JAMAIS, même d'une zone morte. Verdicts RÉELS lus dans les session-*.jsonl du run :
//   stay/ok       minutesInZone 221 waterFails 25 logsNotFound 5 ironMined 150 miningMinutes 2 depletedNear 23
//   stay/cooldown minutesInZone 282 waterFails 14 logsNotFound  8 ironMined  67 miningMinutes 3 depletedNear 29
// 150 fers EN CUMUL, 0 récemment (miningMinutes 2 !), 23 cellules épuisées AUTOUR — et le bot vote
// « rester », parce que `ironMined=150` passe la garde anti-migration « le filon produit encore »
// (`depletedNear >= 3 ET ironMined < 8` ne peut JAMAIS être vrai avec un cumul qui ne redescend pas).
// Cascade mesurée : pas de migration → pas de bois frais (camp déforesté, `logs not_found` ×135/h)
// → pas de combustible → les sets d'armure des cartographes ne se complètent jamais.
//
// Un cumul répond à « ce bot a-t-il DÉJÀ produit ici ? ». Le verdict pose une tout autre question :
// « cette zone produit-elle ENCORE ? ». C'est un DÉBIT, donc une fenêtre.
//
// Forme : une liste de seaux `{t, n}` d'une minute, élaguée à chaque ajout. Bornée par construction
// (≤ 21 entrées par compteur), donc sérialisable dans le mémo de base sans le faire enfler — et
// c'est indispensable : le bot meurt toutes les 3 min, la fenêtre DOIT survivre au process, sinon
// on refait le bug de la mémoire d'échec par process (pièges #52, #63b).
const ZONE_WINDOW_MS = 20 * 60 * 1000;   // « récemment » = les 20 dernières minutes
const ZONE_BUCKET_MS = 60 * 1000;        // granularité d'un seau (la résolution exacte n'importe pas)

function _winOpts(opts) {
  const o = opts || {};
  return {
    windowMs: Number.isFinite(o.windowMs) && o.windowMs > 0 ? o.windowMs : ZONE_WINDOW_MS,
    bucketMs: Number.isFinite(o.bucketMs) && o.bucketMs > 0 ? o.bucketMs : ZONE_BUCKET_MS,
  };
}

/** Relit une fenêtre venue du mémo (JSON quelconque) : entrées valides seulement, triées. (pur) */
function windowLoad(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const e of raw) {
    if (!e || typeof e !== 'object') continue;
    const t = e.t; const n = e.n;
    if (!Number.isFinite(t) || !Number.isFinite(n) || n <= 0) continue;
    out.push({ t, n });
  }
  out.sort((a, b) => a.t - b.t);
  return out;
}

/**
 * Élague : ne garde que les seaux DANS la fenêtre. (pur, ne mute jamais l'entrée)
 * Un seau daté du FUTUR est jeté — il ne peut venir que d'un changement d'heure ou d'un mémo
 * hérité (même paranoïa que `zoneStateLoad`), et le garder gèlerait le compteur.
 */
function windowPrune(win, now, opts = {}) {
  const { windowMs } = _winOpts(opts);
  const t1 = _num(now);
  const cutoff = t1 - windowMs;
  return windowLoad(win).filter((e) => e.t > cutoff && e.t <= t1);
}

/** Compte `n` occurrences à l'instant `now`. (pur : rend une NOUVELLE fenêtre, élaguée) */
function windowAdd(win, n, now, opts = {}) {
  const { bucketMs } = _winOpts(opts);
  const t = _num(now);
  const amount = _num(n);
  const out = windowPrune(win, t, opts);
  if (!(amount > 0)) return out;          // un compteur d'événements ne recule jamais
  const bucket = Math.floor(t / bucketMs) * bucketMs;
  // On cherche le seau PARTOUT et on garde la liste triée : `windowAdd` est alors correct TOUT SEUL,
  // sans dépendre de l'invariant « l'élagage a déjà jeté le futur » (une horloge qui recule ne peut
  // pas créer de seau en double). Défensif et gratuit : ≤21 éléments.
  const hit = out.find((e) => e.t === bucket);       // `out` est une copie fraîche : mutation sûre
  if (hit) { hit.n += amount; return out; }
  out.push({ t: bucket, n: amount });
  out.sort((a, b) => a.t - b.t);                     // ≤21 éléments : le tri est gratuit
  return out;
}

/** Ce que la fenêtre compte à l'instant `now` — LA valeur que lit `zoneVerdict`. (pur) */
function windowSum(win, now, opts = {}) {
  let s = 0;
  for (const e of windowPrune(win, now, opts)) s += e.n;
  return s;
}

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
 * ⚠️ CONTRAT DES ENTRÉES (fix world_mn14) — trois régimes, à ne pas mélanger :
 *   • waterFails / logsNotFound / ironMined = compteurs d'ÉVÉNEMENTS **sur la FENÊTRE GLISSANTE**
 *     (`windowSum(win, now)`, 20 min). Un CUMUL de zone rendrait la garde « le filon produit
 *     encore » (`depletedNear>=3 ET ironMined<8`) INSATISFIABLE dès qu'un bot a eu un bon passé —
 *     c'est très exactement le bug mesuré (150 fers cumulés, 0 récent, zone morte, verdict `stay`).
 *   • miningMinutes = CHRONOMÈTRE cumulé depuis le ré-ancrage (effort, pas événement).
 *   • minutesInZone = horloge d'hystérésis, cumulée elle aussi — c'est sa raison d'être.
 *
 * @param {object} s minutesInZone, waterFails, logsNotFound, ironMined, miningMinutes, depletedNear,
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
  depletedRadius = DEPLETED_RADIUS, reason,
} = {}) {
  if (!from || !Number.isFinite(from.x) || !Number.isFinite(from.z)) return null;
  const list = Array.isArray(biomes) ? biomes : [];
  if (!list.length) return null;
  const wooded = vanillaHint('log');
  const dep = Array.isArray(depleted) ? depleted : [];
  // ⚠️ world_mn12 (28/07) : `depleted` traque l'épuisement du MINERAI (#66a), pas les arbres. Une
  // migration BOIS ne doit donc PAS écarter une forêt iron-épuisée : elle a toujours ses troncs.
  // Toutes les forêts proches étaient marquées depleted (les ouvriers y avaient miné le fer) → la
  // migration bois ne gardait qu'une forêt à 371 blocs (beyond_loaded → NoPath → moved:0) → le bois
  // n'arrivait jamais → deadlock pioche → mapper_armor mort toute la nuit. Pour le bois on ignore
  // l'épuisement ; pour un vrai épuisement de filon on continue de l'écarter (on veut du minerai frais).
  const honorDepleted = reason !== 'wood';
  const isDepleted = (x, z) => honorDepleted && dep.some((d) => d && Number.isFinite(d.x)
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

// En dessous de ce déplacement (blocs) pendant une jambe, on considère qu'elle a ÉCHOUÉ (NoPath
// sur un obstacle) : une vraie jambe fait ~LEG_DIST blocs, un NoPath en fait ~0. Seuil franc, bien
// sous une jambe complète.
const LEG_STUCK_MIN = 16;

/**
 * Cap de la jambe de migration SUIVANTE. (PUR)
 *
 * Tant que la marche progresse (`stuckStreak === 0`) on garde le cap de base — droit vers la
 * cible / la direction assignée. Mais quand la jambe précédente n'a PAS avancé (le pathfinder a
 * rendu NoPath sur un obstacle : colline, ravin, mur), re-viser le même cap re-calcule le MÊME
 * point inatteignable et la marche dégénère MAX_LEGS fois sur place (mesuré world_mn12 : `moved:1/9`
 * en 24 jambes). On DÉVIE alors le cap pour tenter de contourner : on oscille de part et d'autre du
 * cap de base (droite, gauche, droite…), d'un angle qui GRANDIT tant qu'on reste bloqué, borné pour
 * ne jamais repartir franchement en arrière.
 */
function legHeading(baseHeading, stuckStreak) {
  const s = Number.isFinite(stuckStreak) ? Math.max(0, Math.floor(stuckStreak)) : 0;
  if (!s) return baseHeading;
  const step = (40 * Math.PI) / 180;          // 40° par palier de déviation
  const cap = (120 * Math.PI) / 180;          // au plus 120° : on contourne, on ne recule pas tout droit
  const magnitude = Math.min(cap, Math.ceil(s / 2) * step);
  const sign = (s % 2 === 1) ? 1 : -1;        // impair → un côté, pair → l'autre
  return baseHeading + sign * magnitude;
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

// Deux familles de compteurs cohabitent, à dessein :
//   • `*Win`  = FENÊTRE GLISSANTE (20 min) — ce que lit le VERDICT : « la zone produit-elle ENCORE ? »
//   • scalaires (`waterFails`, `logsNotFound`, `ironMined`) = CUMUL DE ZONE — conservés parce que
//     d'autres consommateurs posent une question de PALMARÈS, pas de débit : `ironMined` part dans
//     le heartbeat de présence (`ironZone`) où `regroup.squadLeader` s'en sert pour désigner le
//     mineur productif du groupe, et `logsNotFound` arme le verrou `noWood` (qui doit rester
//     enclenché jusqu'à la migration, sinon `plank_buffer` redevient bloquant en plein wood-desert
//     — deadlock world_mn12). Les fenêtrer aurait changé ces comportements-là aussi (piège #55b).
//   • `miningMs` reste un CHRONOMÈTRE cumulé : ce n'est pas un flux d'événements, et le fenêtrer à
//     20 min exigerait de miner 100 % du temps pour atteindre EXHAUSTED_MINING_MIN → règle morte.

/** Compteurs de zone vierges, horloge démarrée maintenant. (pur) */
function zoneStateInit(now) {
  return {
    anchoredAt: now, waterFails: 0, logsNotFound: 0,
    ironMined: 0, miningMs: 0, lastMigrationAt: 0,
    waterFailsWin: [], logsNotFoundWin: [], ironMinedWin: [],
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
    // Les fenêtres SURVIVENT au respawn (c'est tout l'intérêt de les persister : un bot qui meurt
    // toutes les 3 min ne capitalise rien sinon) mais on les élague à l'instant du chargement —
    // le fer d'il y a trois heures ne doit pas ressusciter. Un mémo d'avant le fenêtrage n'a pas
    // ces champs : on repart d'une fenêtre vide, sans casser (rétro-compat).
    waterFailsWin: windowPrune(saved.waterFailsWin, now),
    logsNotFoundWin: windowPrune(saved.logsNotFoundWin, now),
    ironMinedWin: windowPrune(saved.ironMinedWin, now),
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
// ⚠️ world_mn12 28/07 : gift_planks/gift_fuel (les gatherLog de la CHAÎNE mapper_armor) doivent y
// figurer. Un worker qui arme un cartographe ne lance jamais le `logs`/`plank_buffer` de la chaîne
// principale ; sans ces deux buts, ses échecs bois n'alimentaient PAS _zoneLogsNotFound → l'escape
// `noWood` de gift_planks (66a5e45) ne pouvait jamais s'armer → gift_planks bouclait not_found à vie
// en wood-desert → mappeurs JAMAIS armés. Le signal doit être produit par la branche qui le lit (#61).
const _WOOD_GOALS = new Set(['logs', 'planks', 'plank_buffer', 'crafting_table', 'sticks', 'wooden_pickaxe',
  'gift_planks', 'gift_fuel']);

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
  zoneVerdict, verdictTelemetry, pickMigrationTarget, migrationLeg, legHeading, LEG_STUCK_MIN, legIsGood, isWetBiome, minDistFor, zoneFailureKind,
  zoneStateInit, zoneStateLoad, zoneStateAfterMigration,
  windowAdd, windowSum, windowPrune, windowLoad, ZONE_WINDOW_MS, ZONE_BUCKET_MS,
  MIN_MINUTES_IN_ZONE, MIGRATION_COOLDOWN_MS, WATER_FAILS_MAX, LOGS_NOT_FOUND_MAX,
  EXHAUSTED_MINING_MIN, EXHAUSTED_IRON_MIN, DEPLETED_NEAR_MAX,
  MIGRATE_MIN_DIST, MIGRATE_MAX_DIST, MIGRATE_FAR_MIN_DIST, MIGRATE_WOOD_MIN_DIST, MIGRATE_MIN_PROGRESS, LEG_DIST, MAX_LEGS, LOADED_RADIUS,
  OVERWHELMING_FACTOR, MIN_MINUTES_URGENT, COOLDOWN_URGENT_MS,
};
