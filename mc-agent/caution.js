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
//
// La section 6 (famine / ficelle, 18/08) élargit le module au-delà du cartographe : c'est la même
// famille de questions — « ai-je le droit de prendre ce risque, et à partir de quand ? ».
// `rodPlan` en est le SEUL import : une décision pure d'un module pur (skills/fish.js), consommée
// en LECTURE SEULE pour ne pas recopier ici la recette de la canne à pêche.
const { rodPlan } = require('./skills/fish');

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

// ─── 6) FAMINE : aller chercher la FICELLE, et partir plus tôt (18/08, run world_mn15) ──────────
//
// La faim est devenue la cause de mort DOMINANTE : 5 « starved to death » en 10 minutes sur des
// bots pourtant BLINDÉS (4/5 en armure fer complète, épées) — ce n'est donc plus un problème de
// combat, c'est un problème d'ACQUISITION. La chaîne était rompue en bout de course :
//     faim → chasse (`no_prey` : la zone est chassée à mort depuis des heures)
//          → pêche  (`no_rod` ×444 : la canne coûte 3 bâtons + 2 FICELLES, il n'y a pas de ficelle)
//          → RIEN.
// La ficelle n'a qu'une source : l'ARAIGNÉE — qui, elle, pullule autour du camp (les bots la
// tuaient déjà quand ils étaient nus). D'où les deux décisions ci-dessous : la PORTE (qui a le
// droit d'aller la chercher) et le DÉCLENCHEUR (à partir de quand on part chercher à manger).

// On ne va chatouiller une araignée que BLINDÉ — et le plancher est le même que celui de la
// prudence nocturne (section 1) : sous 2 pièces portées, tout contact est un pari.
const STRING_HUNT_MIN_WORN = CAUTION_MIN_WORN;

/** Nombre de pièces portées, quelle que soit la forme reçue (nombre, Set, tableau) — NaN si
 *  indéchiffrable. index.js manipule `_wornArmor()` tantôt en Set, tantôt en `.size`, tantôt en
 *  tableau : `Number(new Set([...]))` vaut NaN et se lirait « 0, nu », rendant la porte
 *  définitivement fermée sans qu'aucune erreur ne le signale (piège #61). */
function _wornCount(worn) {
  if (worn == null) return NaN;
  if (typeof worn === 'number') return Number.isFinite(worn) ? worn : NaN;
  if (Array.isArray(worn)) return worn.length;
  if (typeof worn.size === 'number') return worn.size;
  return NaN;
}

/** Inventaire en LISTE `[{name,count}]`, qu'on l'ait reçu ainsi ou en carte `{nom: nombre}`
 *  (la forme que rend `buildCtxInv`). `rodPlan` n'itère que la liste — lui passer une carte lève
 *  un TypeError (objet nu non itérable), c'est-à-dire un crash au pire moment. */
function _asItemList(inventory) {
  if (!inventory) return [];
  if (Array.isArray(inventory)) return inventory;
  if (typeof inventory !== 'object') return [];
  if (typeof inventory[Symbol.iterator] === 'function') return [...inventory];
  return Object.keys(inventory).map((name) => ({ name, count: inventory[name] }));
}

/**
 * PUR — faut-il partir chasser l'araignée pour sa FICELLE ?
 * sig = { inventory: [{name,count}] | {nom: nombre}, worn: nb|Set|tableau de pièces PORTÉES,
 *         hasWeapon: bool }
 * → true SEULEMENT si les quatre conditions tiennent ensemble :
 *   1. pas de canne en poche              (sinon la pêche marche déjà)
 *   2. la canne n'est pas fabricable      (déficit de FICELLE, pas de bâtons — s'il manque des
 *      bâtons c'est du BOIS qu'il faut, une araignée n'en donne pas : `no_rod` ne veut pas dire
 *      « chasse l'araignée »)
 *   3. au moins 2 pièces d'armure PORTÉES
 *   4. une arme en poche                  (à mains nues : 1 dégât contre 5)
 * Le déficit est lu par `rodPlan` (skills/fish.js) et JAMAIS recalculé ici : la recette de la
 * canne ne doit vivre qu'à un seul endroit.
 */
function stringHuntNeeded(sig = {}) {
  if (!sig) return false;
  const plan = rodPlan(_asItemList(sig.inventory));
  if (!plan || !plan.missing || !(plan.missing.string > 0)) return false;
  const worn = _wornCount(sig.worn);
  if (!Number.isFinite(worn) || worn < STRING_HUNT_MIN_WORN) return false;
  return !!sig.hasWeapon;
}

// Partir chercher à manger AVANT le point de non-retour. Les filets existants ne se déclenchent
// qu'en urgence (faim ≤ 8 pour « mange ce que tu as », ≤ 6 pour la prudence de combat) — beaucoup
// trop tard pour une EXPÉDITION : à ce niveau la régénération est déjà coupée (< 18) et le bot
// meurt en route. 14 = le seuil auquel un joueur mange (EAT_HUNGER de survival.js), donc celui
// auquel un bot sans réserve doit se mettre en quête.
const FOOD_RUN_HUNGER = 14;
// Rationnement (même patron que le cooldown d'`equipRetryPlan`) : une quête de nourriture
// mobilise le bot plusieurs minutes ; la relancer en boucle le ferait tourner en rond au lieu de
// travailler — et une zone vidée de gibier ne se repeuple pas en trente secondes.
const FOOD_RUN_COOLDOWN_MS = 180000;

/**
 * PUR — faut-il lancer MAINTENANT une quête de nourriture (chasse/pêche/butin) ?
 * sig = { food: 0-20|inconnu, foodItems: nb d'items comestibles en poche (FOODS ∪ EMERGENCY_FOODS),
 *         now, lastRunAt, cooldownMs? }
 * → false si la faim est inconnue (`bot.food` n'est pas livré juste après une connexion : le lire
 *   via `Number(null) === 0` enverrait le bot chasser à chaque spawn), si elle est confortable, s'il
 *   reste quelque chose à manger (c'est alors au filet « manger » d'agir, pas à une chasse), ou si
 *   la dernière tentative est trop récente.
 * Un stock INCONNU est traité comme VIDE : une chasse de trop coûte quelques minutes, une mort de
 * faim coûte la session.
 */
function foodRunNeeded(sig = {}) {
  if (!sig) return false;
  if (!(typeof sig.food === 'number' && Number.isFinite(sig.food))) return false;
  if (sig.food > FOOD_RUN_HUNGER) return false;
  const stock = Number(sig.foodItems);
  if (Number.isFinite(stock) && stock > 0) return false;
  const now = Number(sig.now);
  const last = Number(sig.lastRunAt);
  const cooldownMs = sig.cooldownMs != null ? Number(sig.cooldownMs) : FOOD_RUN_COOLDOWN_MS;
  if (Number.isFinite(now) && Number.isFinite(last) && last > 0 && now - last < cooldownMs) return false;
  return true;
}

module.exports = {
  mapperCaution, CAUTION_MIN_WORN, regroupCaution,
  equipRetryPlan, EQUIP_RETRY_WAIT_MS, EQUIP_MAX_ATTEMPTS, EQUIP_RETRY_COOLDOWN_MS,
  isEquipPickup, PICKUP_EQUIP_DELAY_MS,
  normalizeSmeltResult,
  sprintAllowed, SPRINT_HUNGER_FLOOR, SPRINT_HUNGER_RESUME,
  stringHuntNeeded, STRING_HUNT_MIN_WORN,
  foodRunNeeded, FOOD_RUN_HUNGER, FOOD_RUN_COOLDOWN_MS,
};
