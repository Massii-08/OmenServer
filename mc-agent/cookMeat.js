'use strict';
// CUIRE LA VIANDE COMME UN JOUEUR (23/10). Décisions PURES ; le câblage vit dans index.js
// (cookMeatLot, filet anti-faim, hook du branch-mine, entre deux buts) et foodRun.js (après la chasse).
//
// Mesure live (6 h, mineurs NethBot1-3) : 288 viandes CRUES mangées pour 8 cuites, 102 `hunt_cook_done`
// sur 103 à `cooked:0`. Trois causes, toutes dans la chaîne d'avant :
//   1. la cuisson n'avait lieu QUE si le but en points n'était pas encore atteint — or le cru compte
//      3 points la pièce : 13 chasses fructueuses sur 23 atteignaient le but en cru, et ne cuisaient rien ;
//   2. elle puisait dans le budget de 60 s de la chasse : après une vague de ~35 s il restait rarement
//      les 28 s nécessaires à 2 pièces (`no_time`) ;
//   3. le filet anti-faim (timer 5 s) avalait le cru aussitôt (blessé + faim < 18), avant toute cuisson.
// Cru = 2-3 points, cuit = 6-8 + bien plus de saturation : on jetait les deux tiers de chaque bête.

const RAW2COOKED = Object.freeze({
  beef: 'cooked_beef', porkchop: 'cooked_porkchop', chicken: 'cooked_chicken',
  mutton: 'cooked_mutton', rabbit: 'cooked_rabbit', cod: 'cooked_cod', salmon: 'cooked_salmon',
});

const COOK_LOT_MIN = 3;               // on sort le four dès 3 pièces crues (tous types confondus)
const COOK_PIECE_MIN = 2;             // et seulement s'il peut en cuire au moins 2 (combustible/temps)
const COOK_ITEM_MS = 10000;           // four vanilla : 10 s par objet
const COOK_OVERHEAD_MS = 4000;        // poser / ouvrir / reprendre le four
const COOK_LOT_MAX_MS = 45000;        // plafond d'une cuisson (→ 4 pièces)
const COOK_LOT_HARD_MS = COOK_LOT_MAX_MS + 10000;   // garde-fou dur (marche ≤ 24 blocs, reprise du four)
const COOK_FUEL_MARGIN = 8;           // 1 charbon de marge au-delà de ce que le fer réclame
const COOK_FAIL_COOLDOWN_MS = 3 * 60 * 1000;        // une cuisson ratée : on ne retente pas avant 3 min
const RAW_EAT_HUNGER = 6;             // le cru se mange sans attendre à faim ≤ 6
const RAW_DEFER_MAX_MS = 90000;       // sinon on diffère le cru au plus 90 s (aucune occasion de cuire → on mange)

const isRawMeat = (name) => Object.prototype.hasOwnProperty.call(RAW2COOKED, name);

/** PUR — piles crues cuisables [{name,out,count}], la plus abondante d'abord. items = [{name,count}]. */
function rawMeatStacks(items) {
  const tot = {};
  for (const it of Array.isArray(items) ? items : []) {
    if (!it || !isRawMeat(it.name)) continue;
    const n = Number(it.count) || 0;
    if (n > 0) tot[it.name] = (tot[it.name] || 0) + n;
  }
  return Object.keys(tot)
    .map((name) => ({ name, out: RAW2COOKED[name], count: tot[name] }))
    .sort((a, b) => b.count - a.count || (a.name < b.name ? -1 : 1));
}

function rawMeatCount(items) {
  return rawMeatStacks(items).reduce((s, st) => s + st.count, 0);
}

/**
 * PUR — combustible (en « objets fondables ») à NE PAS brûler pour la viande : la fonte du fer passe
 * avant. rawIron = minerai en poche, smeltNeed = lingots encore à fondre pour l'armure (goals.smeltNeed).
 */
function ironFuelReserve({ rawIron = 0, smeltNeed = 0 } = {}) {
  const n = (v) => Math.max(0, Number(v) || 0);
  return n(rawIron) + n(smeltNeed) + COOK_FUEL_MARGIN;
}

/**
 * PUR — que cuire maintenant ?
 * sig = { items, furnace: 'pocket'|'placed'|null, fuelUnits, reserveUnits, maxMs? }
 * → { go, reason: 'ok'|'few_raw'|'no_furnace'|'no_fuel'|'no_time', pieces, lots:[{name,out,count}] }
 */
function cookLotPlan(sig = {}) {
  const s = sig || {};
  const no = (reason) => ({ go: false, reason, pieces: 0, lots: [] });
  const stacks = rawMeatStacks(s.items);
  const raw = stacks.reduce((a, st) => a + st.count, 0);
  if (raw < COOK_LOT_MIN) return no('few_raw');
  if (s.furnace !== 'pocket' && s.furnace !== 'placed') return no('no_furnace');
  const fuel = Number(s.fuelUnits);
  const reserve = Math.max(0, Number(s.reserveUnits) || 0);
  const spare = Number.isFinite(fuel) ? Math.floor(fuel - reserve) : 0;
  if (!(spare >= COOK_PIECE_MIN)) return no('no_fuel');
  const maxMs = s.maxMs != null ? Number(s.maxMs) : COOK_LOT_MAX_MS;
  const room = Number.isFinite(maxMs) ? Math.floor((maxMs - COOK_OVERHEAD_MS) / COOK_ITEM_MS) : 0;
  let left = Math.min(raw, spare, room);
  if (!(left >= COOK_PIECE_MIN)) return no('no_time');
  const lots = [];
  for (const st of stacks) {
    if (left <= 0) break;
    const c = Math.min(st.count, left);
    lots.push({ name: st.name, out: st.out, count: c });
    left -= c;
  }
  return { go: true, reason: 'ok', pieces: lots.reduce((a, l) => a + l.count, 0), lots };
}

/**
 * PUR — le filet anti-faim peut-il manger du CRU ? Oui à faim ≤ 6, blessé (`hurt`), s'il est impossible de cuire
 * (ni four ni combustible), ou si on l'a déjà différé RAW_DEFER_MAX_MS sans trouver l'occasion de cuire.
 */
function rawEatAllowed({ food, canCook = false, deferredMs = 0, hurt = false } = {}) {
  if (typeof food === 'number' && food <= RAW_EAT_HUNGER) return true;
  // BLESSÉ sous 18 de faim (24/10, eatSafe.healEatWanted) : pas de régénération tant qu'on n'a pas mangé —
  // différer le cru, c'est rester à 1 PV. La cuisson d'abord ne se décide qu'au filet (bot libre, PV ≥ 10).
  if (hurt) return true;
  if (!canCook) return true;
  return Number(deferredMs) >= RAW_DEFER_MAX_MS;
}

/** PUR — champs `raw`/`cooked` de l'event `ate`. */
function ateFields(name) {
  return { raw: isRawMeat(name), cooked: typeof name === 'string' && name.startsWith('cooked_') };
}

module.exports = {
  RAW2COOKED, COOK_LOT_MIN, COOK_PIECE_MIN, COOK_ITEM_MS, COOK_OVERHEAD_MS, COOK_LOT_MAX_MS, COOK_LOT_HARD_MS,
  COOK_FUEL_MARGIN, COOK_FAIL_COOLDOWN_MS, RAW_EAT_HUNGER, RAW_DEFER_MAX_MS,
  isRawMeat, rawMeatStacks, rawMeatCount, ironFuelReserve, cookLotPlan, rawEatAllowed, ateFields,
};
