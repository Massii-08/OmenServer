'use strict';
// KIT DE SECOURS EN COFFRE (run 10, 20/10) — décisions PURES ; la glue (craft du coffre, pose, dépôt,
// retrait) est dans index.js (stashKitIfReady / restoreStashIfUseful).
//
// Mesuré sur le run 10 (keepInventory OFF, 263 vies d'ouvrier) : 181 vies ne dépassent jamais `logs`,
// 6 seulement atteignent `iron_deep` — chaque mort renvoie un bot NU recommencer au bois, dans une zone
// dont la forêt est rasée. Un humain laisse un coffre à sa base. Ici : dès que l'ouvrier a ses outils de
// pierre ET son four, il dépose son SURPLUS (jamais ce dont il a besoin pour continuer) ; au respawn, s'il
// a tout perdu, est près du coffre et que la zone n'est pas campée, il reprend le kit au lieu du bois.
//
// Indépendant de keepInventory, sans le supposer : sous keepInventory ON, le bot respawne AVEC sa pioche
// → restorePlan rend 'skip' (has_pickaxe) et le coffre reste là pour le jour où le réglage changera ;
// le dépôt, lui, ne prend que du surplus — il ne coûte rien à un bot qui garde tout.

const STASH_RESTORE_RADIUS = 48;   // au-delà, la marche coûte plus que le kit (règle de vitesse)
const STASH_NEAR_BASE = 24;        // on ne dépose QU'À la base (c'est là qu'on respawne)

// Ce qu'on GARDE sur soi (le reste est du surplus déposable) — de quoi continuer la chaîne sans revenir.
const KEEP = { logs: 4, planks: 8, sticks: 4, food: 6 };
// Ce qu'on dépose au plus (un kit, pas un entrepôt : la récolte doit continuer à servir la chaîne).
const CAP = { logs: 16, planks: 16, sticks: 8, food: 8 };
const FOODS = new Set(['bread', 'cooked_beef', 'cooked_porkchop', 'cooked_chicken', 'cooked_mutton',
  'cooked_rabbit', 'cooked_cod', 'cooked_salmon', 'baked_potato', 'apple', 'carrot', 'beef', 'porkchop',
  'chicken', 'mutton', 'rabbit', 'cod', 'salmon', 'potato']);
const PICK_TIER = { wooden_pickaxe: 0, golden_pickaxe: 0, stone_pickaxe: 1, iron_pickaxe: 2, diamond_pickaxe: 3, netherite_pickaxe: 4 };

function _items(inv) { return Array.isArray(inv) ? inv.filter((i) => i && typeof i.name === 'string' && Number.isFinite(i.count) && i.count > 0) : []; }
function _sum(inv, pred) { return _items(inv).filter((i) => pred(i.name)).reduce((s, i) => s + i.count, 0); }
const isLog = (n) => n.endsWith('_log');
const isPlank = (n) => n.endsWith('_planks');
const isPick = (n) => n.endsWith('_pickaxe');
const isSword = (n) => n.endsWith('_sword');

/** PUR — l'inventaire contient-il une pioche de pierre ou mieux ? */
function hasStonePick(inv) {
  return _items(inv).some((i) => isPick(i.name) && (PICK_TIER[i.name] || 0) >= 1);
}

/**
 * Prend `want` unités parmi les piles correspondant à `pred`, plus grosses piles d'abord.
 * @returns [{name, count}]
 */
function _take(inv, pred, want) {
  const out = [];
  let left = want;
  const piles = {};
  for (const i of _items(inv)) if (pred(i.name)) piles[i.name] = (piles[i.name] || 0) + i.count;
  for (const [name, count] of Object.entries(piles).sort((a, b) => b[1] - a[1])) {
    if (left <= 0) break;
    const n = Math.min(count, left);
    out.push({ name, count: n });
    left -= n;
  }
  return out;
}

/**
 * PUR — faut-il déposer le kit MAINTENANT, et quoi ?
 * @param {{inv, hasFurnace, stash, nearBase, safe}} o
 *   inv : [{name,count}] ; hasFurnace : four en poche (ou posé à la base) ; stash : le coffre persisté
 *   (null = aucun) ; nearBase : distance à la base ≤ STASH_NEAR_BASE ; safe : de jour, en surface, sans menace.
 * @returns {{act:'deposit'|'skip', reason:string, items?:[{name,count}], craftSparePick?:boolean}}
 */
function depositPlan(o = {}) {
  const inv = _items(o.inv);
  if (o.stash && Array.isArray(o.stash.items) && o.stash.items.length) return { act: 'skip', reason: 'already_stashed' };
  if (!hasStonePick(inv)) return { act: 'skip', reason: 'no_stone_tools' };
  if (!o.hasFurnace) return { act: 'skip', reason: 'no_furnace' };
  if (!o.nearBase) return { act: 'skip', reason: 'not_at_base' };
  if (!o.safe) return { act: 'skip', reason: 'unsafe' };
  const items = [];
  const surplus = (pred, keep, cap) => Math.min(cap, Math.max(0, _sum(inv, pred) - keep));
  // Une pioche de RECHANGE se fabrique si le bot a de quoi (3 cobble + 2 bâtons) sans entamer son minimum :
  // les 2 bâtons sont RÉSERVÉS avant de calculer le surplus de bâtons. La glue la fabrique avant le dépôt.
  const stonePicks = _sum(inv, (n) => n === 'stone_pickaxe');
  const cobble = _sum(inv, (n) => n === 'cobblestone' || n === 'cobbled_deepslate');
  const stickHave = _sum(inv, (n) => n === 'stick');
  const craftSparePick = stonePicks < 2 && cobble >= 3 && stickHave >= KEEP.sticks + 2;
  items.push(..._take(inv, isLog, surplus(isLog, KEEP.logs, CAP.logs)));
  items.push(..._take(inv, isPlank, surplus(isPlank, KEEP.planks, CAP.planks)));
  const sticks = Math.min(CAP.sticks, Math.max(0, stickHave - KEEP.sticks - (craftSparePick ? 2 : 0)));
  if (sticks > 0) items.push({ name: 'stick', count: sticks });
  items.push(..._take(inv, (n) => FOODS.has(n), surplus((n) => FOODS.has(n), KEEP.food, CAP.food)));
  // Outils de RECHANGE seulement : on n'en dépose qu'un si on en porte (ou en fabrique) au moins deux.
  if (stonePicks >= 2 || craftSparePick) items.push({ name: 'stone_pickaxe', count: 1 });
  const swords = _items(inv).filter((i) => isSword(i.name));
  if (swords.reduce((s, i) => s + i.count, 0) >= 2) items.push({ name: swords[swords.length - 1].name, count: 1 });
  if (!items.length && !craftSparePick) return { act: 'skip', reason: 'no_surplus' };
  return { act: 'deposit', reason: 'ready', items, craftSparePick };
}

/**
 * PUR — au respawn, reprendre le kit ?
 * @param {{stash, pos, inv, camped}} o  stash : {x,y,z,items} ; camped : homeCamped(stash) (la zone du coffre)
 * @returns {{act:'restore'|'skip', reason:string, dist?:number}}
 */
function restorePlan(o = {}) {
  const s = o.stash;
  if (!s || !Number.isFinite(s.x) || !Number.isFinite(s.z) || !Array.isArray(s.items) || !s.items.length) return { act: 'skip', reason: 'no_stash' };
  if (hasStonePick(o.inv)) return { act: 'skip', reason: 'has_pickaxe' };   // keepInventory ON, ou déjà rééquipé
  const p = o.pos;
  if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.z)) return { act: 'skip', reason: 'no_position' };
  const dist = Math.hypot(p.x - s.x, p.z - s.z);
  if (dist > STASH_RESTORE_RADIUS) return { act: 'skip', reason: 'too_far', dist };
  if (o.camped) return { act: 'skip', reason: 'camped', dist };
  return { act: 'restore', reason: 'ok', dist };
}

module.exports = { depositPlan, restorePlan, hasStonePick, STASH_RESTORE_RADIUS, STASH_NEAR_BASE, KEEP, CAP };
