'use strict';
// PRUDENCE ET FIABILITÉ D'ÉQUIPEMENT DU CARTOGRAPHE — décisions PURES (aucune dépendance
// mineflayer), consommées par index.js. Nées d'une mesure live (world_mn14, stats vanilla du
// serveur = source canonique) : les 3 cartographes concentrent LA MOITIÉ des morts de la flotte.
//   MapBot1  92 morts (squelette ×25, zombie ×15, creeper ×8)   MapBot2 79   MapBot3 70
//   les 5 ouvriers BLINDÉS meurent 2 à 4 fois moins.
// Et MapBot1 a `picked_up: iron_chestplate 1, iron_helmet 1` dans ses stats (pièces reçues d'un
// coéquipier) pendant que la présence le donne `armor:0` : il ne PORTE pas ce qu'il a en poche.
// Trois causes, trois décisions ici :
//   1. l'équipement rate en silence et n'est jamais re-tenté     → equipRetryPlan
//   2. une pièce fraîchement RAMASSÉE n'est portée qu'au prochain cycle → isEquipPickup
//   3. un cartographe NU voyage quand même la nuit               → mapperCaution
// (+ la raison d'échec de fonte, maillon du même pipeline d'armure : `armor_smelt reason:"?"`
//  vu en session vivante = un échec dont la cause est PERDUE → normalizeSmeltResult.)

// ─── 1) Prudence nocturne du cartographe ────────────────────────────────────────────────────────

// Sous 2 pièces portées, un cartographe de nuit est un cadavre en sursis (difficulté hard :
// un squelette le descend en quelques flèches). 2 pièces = le minimum pour encaisser le temps
// de fuir. Au-delà, il travaille : se terrer trop souvent mène à zéro carte.
const CAUTION_MIN_WORN = 2;

/**
 * PUR — que doit faire le cartographe MAINTENANT ?
 * sig = { worn: nb de pièces d'armure PORTÉES, isNight: bool|null (null = inconnu),
 *         hostilesNear: bool }
 * → 'shelter' (se terrer et attendre l'aube) | 'map' (cartographier).
 *
 * `isNight === null` (bot.time pas encore livré : juste après un spawn/une reconnexion, soit
 * exactement le moment où le bot est nu) → on retombe sur la présence d'hostiles, même patron
 * que `shouldShelter` (skills/shelter.js) face à un niveau de lumière inconnu. Un hostile proche
 * EN PLEIN JOUR ne justifie pas de se terrer : fuir/riposter est le rôle de survivalTick, et un
 * cartographe qui se terre de jour ne cartographie jamais.
 */
function mapperCaution(sig = {}) {
  const n = Number(sig && sig.worn);
  const worn = Number.isFinite(n) ? n : 0;
  if (worn >= CAUTION_MIN_WORN) return 'map';
  const night = (sig && sig.isNight) == null ? !!(sig && sig.hostilesNear) : !!sig.isNight;
  return night ? 'shelter' : 'map';
}

// ─── 1bis) Prudence nocturne du REGROUPEMENT post-mort (18/08, suite directe) ───────────────────
// Flagrant délit world_mn15 ~02:30 : 6 morts en 2 min AU MÊME POINT. Chaque mort → respawn →
// `/tpa` immédiat vers le groupe (--regroup) → bot téléporté NU, DE NUIT, dans le camp où les
// hostiles ont convergé → re-mort → re-tpa. Le regroupement (pensé pour la logistique de jour :
// entraide de lingots, cohésion de squad) devient un aimant à morts la nuit — il CONCENTRE les
// bots sans armure là où les hostiles convergent et COURT-CIRCUITE l'abri-si-nu (le bot se
// téléporte au lieu de s'abriter). Exactement le mécanisme de mapperCaution ; seul le vocabulaire
// de sortie change ('regroup' au lieu de 'map', puisque index.js appelle tryRegroup/trySquad, pas
// une boucle de cartographie). Délègue plutôt que de dupliquer : le seuil (CAUTION_MIN_WORN) et le
// traitement d'un signal isNight/hostilesNear inconnu ne doivent vivre qu'à UN endroit.
function regroupCaution(sig = {}) {
  return mapperCaution(sig) === 'shelter' ? 'shelter' : 'regroup';
}

// ─── 2) Ré-essai d'équipement ───────────────────────────────────────────────────────────────────

// `bot.equip` échoue surtout EN MOUVEMENT (le serveur refuse le changement de slot pendant un
// déplacement ou un dig). D'où le protocole : couper le mouvement, souffler, re-tenter UNE fois.
const EQUIP_RETRY_WAIT_MS = 1500;
const EQUIP_MAX_ATTEMPTS = 2;      // 1 passe normale + 1 ré-essai à l'arrêt. Jamais plus :
                                   // s'acharner sur un équipement impossible fige le bot.
// `ensureArmor` est appelé très souvent (planner, timers, onPeriodic). Un équipement qui échoue
// DURABLEMENT (et pas juste parce que le bot marchait) transformerait le ré-essai en péage
// permanent : 1,5 s d'arrêt à CHAQUE appel. Deux ré-essais forcés ne sont donc jamais espacés de
// moins de ça — les échecs restent tous tracés, seule l'immobilisation est rationnée.
const EQUIP_RETRY_COOLDOWN_MS = 20000;

function _normEntry(f) {
  if (typeof f === 'string') return f ? { piece: f, dest: null, reason: null } : null;
  if (!f || !f.piece) return null;
  return { piece: f.piece, dest: f.dest != null ? f.dest : null, reason: f.reason != null ? f.reason : null };
}

/**
 * PUR — faut-il re-tenter les équipements ratés, et comment ?
 * failed = [{piece, dest?, reason?}] ou [nom]
 * opts = { attempt (1-based), maxAttempts, waitMs, now, lastRetryAt, cooldownMs }
 *   `now`+`lastRetryAt` (les DEUX, sinon pas de rationnement — rétro-compat) : espacement minimal
 *   entre deux ré-essais forcés, cf. EQUIP_RETRY_COOLDOWN_MS.
 * → { retry, pieces: [{piece,dest,reason}], waitMs, stopFirst, reason? }
 */
function equipRetryPlan(failed, opts = {}) {
  const attempt = Number(opts.attempt) || 1;
  const maxAttempts = Number(opts.maxAttempts) || EQUIP_MAX_ATTEMPTS;
  const no = (reason) => ({ retry: false, pieces: [], waitMs: 0, stopFirst: false, reason });
  const seen = new Set();
  const pieces = [];
  for (const f of (failed || [])) {
    const e = _normEntry(f);
    if (!e) continue;
    const k = e.piece + '|' + (e.dest || '');
    if (seen.has(k)) continue;
    seen.add(k);
    pieces.push(e);
  }
  if (!pieces.length) return no('nothing_failed');
  if (attempt >= maxAttempts) return no('max_attempts');
  const now = Number(opts.now);
  const last = Number(opts.lastRetryAt);
  const cooldownMs = opts.cooldownMs != null ? Number(opts.cooldownMs) : EQUIP_RETRY_COOLDOWN_MS;
  if (Number.isFinite(now) && Number.isFinite(last) && now - last < cooldownMs) return no('cooldown');
  return {
    retry: true,
    pieces,
    waitMs: opts.waitMs != null ? opts.waitMs : EQUIP_RETRY_WAIT_MS,
    stopFirst: true,
  };
}

// ─── 3) Ramassage → équipement éclair ───────────────────────────────────────────────────────────

// Débounce : un mineur ramasse des centaines d'items ; une rafale de ramassages ne doit déclencher
// QU'UNE passe d'équipement. Court quand même — la pièce doit être portée dans la foulée, pas au
// prochain onPeriodic (1 arrivée sur 10, MapBot1 mourait avant).
const PICKUP_EQUIP_DELAY_MS = 1000;
const _ARMOR_SUFFIX = /_(helmet|chestplate|leggings|boots)$/;

/** PUR — l'item ramassé vaut-il un équipement immédiat ? (pièce d'armure ou bouclier) */
function isEquipPickup(name) {
  if (typeof name !== 'string' || !name) return false;
  if (name === 'shield') return true;
  return _ARMOR_SUFFIX.test(name);
}

// ─── 4) Raison d'échec de fonte ─────────────────────────────────────────────────────────────────

/**
 * PUR — garantit une RAISON sur tout échec de fonte.
 * `smelt` (skills/smelt.js) rend `{ok: got >= want, got}` : SANS `reason` dès qu'il fond moins que
 * demandé. L'appelant émettait donc `armor_smelt ok:false reason:"?"` — un échec à la cause perdue,
 * sur le chemin qui fabrique l'armure. On distingue au moins « rien n'est sorti » (combustible
 * épuisé, input volé, four repris trop tôt) de « fonte partielle » (le four a produit, mais moins),
 * et on joint la quantité DEMANDÉE : « partial 2/3 » et « partial 2/8 » n'appellent pas la même
 * conclusion. Ne mute jamais l'entrée et n'écrase jamais une raison déjà posée par un chemin amont.
 */
function normalizeSmeltResult(r, want = 0) {
  if (r && r.ok) return r;
  if (!r) return { ok: false, reason: 'no_result', got: 0, want: Number(want) || 0 };
  if (r.reason) return r;
  const got = Number(r.got) || 0;
  return Object.assign({}, r, { ok: false, reason: got > 0 ? 'partial' : 'no_output', want: Number(want) || 0 });
}

// ─── 5) Réserve de faim pour le sprint (18/08, suite directe) ───────────────────────────────────

// Mesure live world_mn15 (stats vanilla, même source canonique que la section 1) : `sprint_one_cm`
// = 2,2 à 2,5 MILLIONS de cm (22-25 km) par bot en quelques heures, contre `walk_one_cm` ~10× moindre
// — un bot sprinte QUASI EN PERMANENCE, affamé ou pas. Le sprint augmente l'épuisement de faim ~4×
// (mécanique vanilla) ; sous faim ≤6 le SERVEUR coupe le sprint de force (movement.js
// SPRINT_MIN_FOOD/SPRINT_RESUME_FOOD — mécanique du sprint EN COURS, pas une décision de prudence)
// — mais le mal est fait AVANT d'atteindre ce plancher : la régénération de PV (hard) exige faim
// ≥18 (reflexes.js REGEN_FOOD=17), donc un bot qui sprinte jusqu'à 7 puis marche jusqu'à 6 n'a plus
// JAMAIS de réserve suffisante pour régénérer tant qu'il continue de bouger → morts « starved to
// death » en série (3 dans les 25 dernières minutes du run). Un vrai joueur affamé ARRÊTE de courir
// bien avant le plancher dur du serveur, pour garder une marge de manœuvre. `sprintAllowed` pose ce
// plancher PROACTIF, nettement au-dessus du plancher vanilla (12 contre 6/7), avec la même
// hystérésis « +2 » que movement.js pour éviter le clignotement. Vit ICI (pas dans movement.js)
// parce que c'est une question de PRUDENCE (garder une réserve pour plus tard), pas de mécanique de
// déplacement — même famille que mapperCaution/regroupCaution ci-dessus, pas que la mécanique pure
// de shouldSprint.
const SPRINT_HUNGER_FLOOR = 12;
const SPRINT_HUNGER_RESUME = SPRINT_HUNGER_FLOOR + 2;   // hystérésis : ne reprend qu'à 14, jamais pile 12

/**
 * PUR — le sprint reste-t-il autorisé du point de vue de la RÉSERVE de faim ? Orthogonal à
 * `shouldSprint` de movement.js (qui décide de la mécanique EN COURS : déplacement/sol/eau/dig/
 * sneak/plancher dur 6-7) — les deux se combinent en ET côté appelant, celui-ci coupe plus tôt.
 * sig = { food: 0-20|inconnu, curbed: bool (le sprint est déjà coupé par CETTE garde en ce moment,
 *         pour l'hystérésis — même rôle que `sprinting` dans shouldSprint) }
 * → false SEULEMENT si la faim est au plancher ou en dessous (et, si déjà coupé, tant qu'elle n'a
 *   pas atteint le seuil de reprise) ; true sinon, et TOUJOURS true si food est inconnu (rétro-
 *   compat : bot.food peut ne pas être livré juste après une connexion — ne jamais bloquer le
 *   sprint sur une donnée absente).
 * ⚠️ `typeof === 'number'` et PAS `Number(...)` : `Number(null) === 0` (piège JS classique) ferait
 * lire un `food` absent comme « 0, affamé » au lieu de « inconnu » — même idiome que shouldSprint
 * (movement.js : `typeof s.food === 'number' ? s.food : 20`).
 */
function sprintAllowed(sig = {}) {
  const hasFood = !!sig && typeof sig.food === 'number' && Number.isFinite(sig.food);
  if (!hasFood) return true;
  const food = sig.food;
  if (sig.curbed) return food >= SPRINT_HUNGER_RESUME;   // déjà coupé : ne reprend qu'à 14
  return food > SPRINT_HUNGER_FLOOR;                     // pas encore coupé : coupe dès 12
}

module.exports = {
  mapperCaution, CAUTION_MIN_WORN, regroupCaution,
  equipRetryPlan, EQUIP_RETRY_WAIT_MS, EQUIP_MAX_ATTEMPTS, EQUIP_RETRY_COOLDOWN_MS,
  isEquipPickup, PICKUP_EQUIP_DELAY_MS,
  normalizeSmeltResult,
  sprintAllowed, SPRINT_HUNGER_FLOOR, SPRINT_HUNGER_RESUME,
};
