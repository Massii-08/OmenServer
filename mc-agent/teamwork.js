'use strict';
// ENTRAIDE D'ÉQUIPE (demande Massii 25/07) : « il faut qu'ils s'aident entre eux, et quand ils
// ont l'armure fer ils se séparent ».
//
// Le cas qui l'a motivé, mesuré en direct sur world_ax4 : NethBot2 portait 3 pièces d'armure et
// gardait **6 lingots d'avance** pendant que NethBot3, à 50 blocs de là, n'avait RIEN et
// rebouclait sur le bootstrap bois. Le fer dormait dans la mauvaise poche.
//
// Deux décisions PURES ici ; l'exécution (marcher jusqu'au coéquipier, `tossStack`) vit dans
// index.js — même séparation que mapperTp/regroup.

const PIECES = ['helmet', 'chestplate', 'leggings', 'boots'];
const INGOTS_PER_PIECE = { helmet: 5, chestplate: 8, leggings: 7, boots: 4 };

/**
 * PUR — mon état d'équipe, publié dans le heartbeat de présence pour que les autres décident.
 * @param {Object} inv  {nom: nombre} (poche)
 * @param {Array<string>} worn  noms des pièces portées (slots 5-8)
 * @returns {{armor:number, ingots:number, need:number}} armor = pièces fer acquises (0-4)
 */
function teamStatus(inv, worn) {
  const i = inv || {};
  const w = new Set(worn || []);
  let armor = 0;
  for (const p of PIECES) {
    const name = `iron_${p}`;
    if (w.has(name) || (i[name] || 0) > 0) armor += 1;
  }
  const ingots = i.iron_ingot || 0;
  // Lingots encore nécessaires pour compléter MON armure (les pièces manquantes uniquement).
  let need = 0;
  for (const p of PIECES) {
    const name = `iron_${p}`;
    if (!w.has(name) && !(i[name] || 0)) need += INGOTS_PER_PIECE[p];
  }
  return { armor, ingots, need };
}

const MIN_GIFT = 3;        // en dessous, le déplacement ne vaut pas le don
const AID_RANGE = 64;      // blocs — au-delà, on ne traverse pas la carte pour donner
const FRESH_MS = 180000;   // présence périmée = coéquipier mort/déco

function _d(ax, az, bx, bz) { return Math.hypot(ax - bx, az - bz); }

/**
 * PUR — dois-je donner des lingots, et à qui ? null si rien à faire.
 *
 * Règle : je ne donne que mon SURPLUS (ce dont je n'ai pas besoin pour finir ma propre armure —
 * on ne se sabote pas pour aider), au coéquipier PROCHE le moins équipé qui en a besoin.
 * À égalité d'armure, le plus proche gagne.
 *
 * @returns {{to:string, amount:number}|null}
 */
function pickDonation({ self, selfName, selfStatus, mates, now, opts = {} } = {}) {
  if (!self || !selfStatus) return null;
  const t = now || Date.now();
  const range = opts.range || AID_RANGE;
  const minGift = opts.minGift || MIN_GIFT;
  const surplus = (selfStatus.ingots || 0) - (selfStatus.need || 0);
  if (surplus < minGift) return null;                       // rien à donner sans se pénaliser

  const cands = (mates || []).filter((m) => m
    && m.name && m.name !== selfName
    && m.role !== 'mapper'                                   // les cartographes ne montent pas d'armure
    && typeof m.x === 'number' && typeof m.z === 'number'
    && (t - (m.at || 0)) <= (opts.freshMs || FRESH_MS)
    && (m.armor === undefined || m.armor < 4)                // déjà équipé → il n'a besoin de rien
    && _d(m.x, m.z, self.x, self.z) <= range);
  if (!cands.length) return null;

  let best = null, bestKey = null;
  for (const m of cands) {
    const armor = m.armor === undefined ? 0 : m.armor;
    const d = _d(m.x, m.z, self.x, self.z);
    const key = [armor, d];                                  // moins équipé d'abord, puis plus proche
    if (!bestKey || key[0] < bestKey[0] || (key[0] === bestKey[0] && key[1] < bestKey[1])) {
      best = m; bestKey = key;
    }
  }
  if (!best) return null;
  // On ne donne pas plus que ce dont il a besoin (le reste servira à quelqu'un d'autre).
  const wants = best.need === undefined ? surplus : Math.max(0, best.need);
  const amount = Math.min(surplus, wants);
  if (amount < minGift) return null;
  return { to: best.name, amount };
}

/**
 * PUR — toute l'équipe est-elle équipée ? (⇒ fin de la phase groupée, chacun repart de son côté)
 * Un coéquipier dont le statut est inconnu est considéré NON équipé : on ne se sépare pas
 * sur une supposition.
 */
function allArmored(selfStatus, mates, opts = {}) {
  if (!selfStatus || (selfStatus.armor || 0) < 4) return false;
  const t = opts.now || Date.now();
  const workers = (mates || []).filter((m) => m && m.role !== 'mapper' && m.name
    && (t - (m.at || 0)) <= (opts.freshMs || FRESH_MS));
  return workers.every((m) => (m.armor || 0) >= 4);
}

module.exports = { teamStatus, pickDonation, allArmored, PIECES, INGOTS_PER_PIECE, MIN_GIFT, AID_RANGE };
