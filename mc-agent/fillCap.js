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

// OÙ JETER (23/10, NethBot1 session 420 : `fill_capped` ×2 à 9 min d'écart, même liste — muré dans son
// abri 1×1, l'excédent jeté contre la paroi lui retombait dessus et était re-ramassé). Un objet jeté vole
// ~2 blocs devant ; le ramassage serveur porte à ~1,3 bloc du centre du joueur. On ne jette donc que vers
// une direction cardinale OUVERTE sur 2 cases (pieds ET tête, ni fluide ni chunk non chargé) : l'objet
// atterrit hors de portée. Aucune direction → null : on attend d'être sorti (le prochain ramassage relance).
const TOSS_DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]];
function _open(b) {
  if (!b || b.boundingBox !== 'empty') return false;
  return !/water|lava/.test(String(b.name || ''));
}
/** Point à regarder pour jeter (case libre à 2 blocs, hauteur des yeux) ou null si enfermé. PUR. */
function tossTarget(pos, blockAt) {
  if (!pos || typeof blockAt !== 'function') return null;
  const fx = Math.floor(pos.x), fy = Math.floor(pos.y), fz = Math.floor(pos.z);
  if (![fx, fy, fz].every(Number.isFinite)) return null;
  try {
    for (const [dx, dz] of TOSS_DIRS) {
      let ok = true;
      for (let k = 1; k <= 2 && ok; k++) {
        for (let dy = 0; dy <= 1 && ok; dy++) {
          ok = _open(blockAt({ x: fx + dx * k, y: fy + dy, z: fz + dz * k }));
        }
      }
      if (ok) return { x: fx + dx * 2 + 0.5, y: fy + 1.6, z: fz + dz * 2 + 0.5 };
    }
  } catch (e) { return null; }
  return null;
}

module.exports = { fillOverflow, fillCapDue, tossTarget, FILL_MAX_STACKS, FILL_CAP_INTERVAL_MS };
