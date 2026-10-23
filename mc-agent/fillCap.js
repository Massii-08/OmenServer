'use strict';
// PLAFOND DE REMBLAI (23/10, NethBot1 session 408). Un ouvrier ramasse TOUTE la roche qu'il creuse :
// 296 cobble à 13:30, 587 deux heures plus tard, 10 piles — la poche pleine, le craft de pioche part
// au sol (mineflayer « no room => drop it ») et le bot reste 55 min sans pouvoir creuser. Un joueur
// garde deux-trois piles pour ses tours et ses murs et jette le reste.
// Règle : au-delà de FILL_MAX_STACKS piles de remblai (toutes roches de JUNK_TIERS confondues), on jette
// l'excédent — palier le plus anodin d'abord (terre, gravier, roches, netherrack, cobble), la plus
// petite pile d'abord — sans jamais descendre sous FILL_KEEP blocs au total ni sous la réserve de
// cobble par nom (COBBLE_KEEP). Au plus une passe toutes les FILL_CAP_INTERVAL_MS.
// PUR : aucune dépendance au bot. Le câblage (ramassage, jet derrière soi) vit dans index.js.
const { JUNK_TIERS, FILL_NAMES, FILL_KEEP } = require('./skills/craft');

const FILL_MAX_STACKS = 3;
const FILL_CAP_INTERVAL_MS = 20000;

/** Piles de remblai en trop → tableau des piles à jeter (références), dans l'ordre de jet. */
function fillOverflow(items, { maxStacks = FILL_MAX_STACKS, keep = FILL_KEEP } = {}) {
  const list = (Array.isArray(items) ? items : []).filter((it) => it && FILL_NAMES.has(it.name) && Number(it.count) > 0);
  let stacks = list.length;
  if (stacks <= maxStacks) return [];
  let fillTotal = 0;
  const total = {};
  for (const it of list) { fillTotal += Number(it.count); total[it.name] = (total[it.name] || 0) + Number(it.count); }
  const out = [];
  const left = list.slice();
  while (stacks > maxStacks) {
    let pick = null;
    for (const tier of JUNK_TIERS) {
      for (const it of left) {
        if (!tier.names.includes(it.name)) continue;
        if (fillTotal - Number(it.count) < keep) continue;
        if (total[it.name] - Number(it.count) < tier.keep) continue;
        if (!pick || Number(it.count) < Number(pick.count)) pick = it;
      }
      if (pick) break;
    }
    if (!pick) break;
    out.push(pick);
    left.splice(left.indexOf(pick), 1);
    fillTotal -= Number(pick.count);
    total[pick.name] -= Number(pick.count);
    stacks--;
  }
  return out;
}

/** La passe est-elle permise (≤ 1 / intervalle) ? */
function fillCapDue(now, lastAt, intervalMs = FILL_CAP_INTERVAL_MS) {
  return !(Number.isFinite(lastAt) && lastAt > 0 && now - lastAt < intervalMs);
}

module.exports = { fillOverflow, fillCapDue, FILL_MAX_STACKS, FILL_CAP_INTERVAL_MS };
