'use strict';
// UNE ÉPÉE POUR CHAQUE MINEUR (Massii 24/10 : « NethBot3 a de la terre en main »).
//
// Mesuré (logs Omen, 24 h, mineurs NethBot1-3) : sur les combats où l'inventaire est connu (dernier
// `autonomous_done_ctx`), 1 sur 3 a été mené SANS épée en poche — au poing ou avec ce que le bot tenait
// (terre, pioche). Cause dans le code : la seule épée de toute la filière mineur est `t1_sword`, dans la
// chaîne ARMURE FER, et elle est sautée dès que l'armure fer est couverte (`IA`). La chaîne DIAMANT —
// celle où les mineurs passent des heures à -54 — n'en fabriquait aucune : une épée cassée (ou perdue
// à la mort) n'était jamais refaite.
//
// Règle (Massii) : en DIAMANT dès qu'il reste ≥ 2 diamants de marge APRÈS la réserve pioche (même
// réserve que l'armure diamant : 3, sauf pioche de rechange en poche) + 1 bâton ; sinon fer ; sinon
// pierre. Refaite quand elle casse ou est presque cassée (`swordsGood` = épées SAINES, cf. gear.isNearlyBroken).
// Une épée pierre/fer saine n'est remplacée QUE par une diamant (pas d'escalier fer → fer).
// Jamais bloquant : rien d'abordable → null (le but planner est `optional` et satisfait d'office).
// PUR : aucun accès bot.

const DIA_SWORD_COST = 2;
const IRON_SWORD_COST = 2;
const STONE_SWORD_COST = 2;
const DIA_PICK_RESERVE = 3;            // = diaArmor.DIA_PICK_RESERVE = goals.DIA_PICK_COST
const IRON_PICK_SPARE_INGOTS = 3;      // la pioche de rechange de la chaîne diamant passe avant l'épée fer
const STONES = ['cobblestone', 'cobbled_deepslate', 'blackstone'];

const _RANK = { stone: 1, iron: 2, diamond: 3, netherite: 4 };   // bois/or = 0 : pas une vraie arme

/** PUR — rang d'une épée (0 = pas une épée utile : bois, or, autre objet). */
function swordRank(name) {
  const m = /^([a-z]+)_sword$/.exec(String(name || ''));
  return (m && _RANK[m[1]]) || 0;
}

/** PUR — meilleur rang parmi une liste de noms. */
function bestSwordRank(names) {
  let best = 0;
  for (const n of names || []) best = Math.max(best, swordRank(n));
  return best;
}

function _n(inv, name) { return Number((inv || {})[name]) || 0; }
function _sum(inv, pred) {
  let s = 0;
  for (const k of Object.keys(inv || {})) if (pred(k)) s += Number(inv[k]) || 0;
  return s;
}

/**
 * PUR — l'épée à fabriquer MAINTENANT, ou null.
 * @param {{inv:Object, swordsGood?:string[], pickCount?:number, tableOk?:boolean, reserve?:number}} o
 *   inv : comptes par nom ; swordsGood : épées SAINES (absent = toutes les épées de `inv`) ;
 *   pickCount : pioches fer+ en poche (réserve diamant / fer) ; tableOk : table posable.
 * @returns {null|{name:string, tier:string, cost:number, upgrade:boolean}}
 */
function swordPlan({ inv, swordsGood, pickCount, tableOk, reserve } = {}) {
  const i = inv || {};
  if (!tableOk) return null;                                   // épée = recette 3×3
  const good = Array.isArray(swordsGood) ? swordsGood
    : Object.keys(i).filter((k) => _n(i, k) > 0 && /_sword$/.test(k));
  const cur = bestSwordRank(good);
  const sticksOk = _n(i, 'stick') >= 1 || _sum(i, (k) => /_planks$/.test(k)) >= 2
    || _sum(i, (k) => /_(log|stem)$/.test(k) && !/^stripped_/.test(k) && k !== 'mushroom_stem') >= 1;
  if (!sticksOk) return null;
  const picks = Number(pickCount) || 0;
  const keep = Number.isFinite(reserve) ? reserve : (picks >= 2 ? 0 : DIA_PICK_RESERVE);
  if (cur < _RANK.diamond && _n(i, 'diamond') - keep >= DIA_SWORD_COST) {
    return { name: 'diamond_sword', tier: 'diamond', cost: DIA_SWORD_COST, upgrade: cur > 0 };
  }
  if (cur >= _RANK.stone) return null;                         // une épée saine suffit
  const ingots = _n(i, 'iron_ingot');
  if (ingots >= IRON_SWORD_COST && (picks >= 2 || ingots >= IRON_SWORD_COST + IRON_PICK_SPARE_INGOTS)) {
    return { name: 'iron_sword', tier: 'iron', cost: IRON_SWORD_COST, upgrade: false };
  }
  if (STONES.reduce((s, n) => s + _n(i, n), 0) >= STONE_SWORD_COST) {
    return { name: 'stone_sword', tier: 'stone', cost: STONE_SWORD_COST, upgrade: false };
  }
  return null;
}

module.exports = { swordPlan, swordRank, bestSwordRank, DIA_SWORD_COST, STONE_SWORD_COST, IRON_SWORD_COST };
