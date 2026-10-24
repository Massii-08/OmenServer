'use strict';
// ─── ARMURE EN DIAMANT DES MINEURS (Massii 24/10 soir) ───────────────────────────────────────────
// « Le but c'est qu'ils survivent le plus longtemps possible pour récupérer le plus de diamants
// possible. » Mesure live : l'armure de FER s'use plus vite que les bots ne la refont (mineurs à 2-3
// pièces sur 4) → morts fréquentes. Un joueur au fond, les poches pleines de diamants, se fait une
// armure en diamant (durabilité ×2, protection supérieure) et la refait en diamant quand elle s'use.
//  - ORDRE STRICT, protection max d'abord : plastron (8) → jambières (7) → casque (5) → bottes (4).
//    On ATTEND d'avoir de quoi faire la pièce suivante (on ne fait pas les bottes avant le plastron).
//  - Une pièce diamant SAINE en poche s'enfile (gratuit). Le fer remplacé reste en poche (rechange,
//    ou don à un cartographe nu : cf. isIronDonor).
//  - La pioche d'abord : sans pioche capable de miner le diamant, rien (dia_pick passe avant), et on
//    garde 3 diamants de réserve pour refaire une pioche diamant tant qu'il n'y a pas de rechange.
//  - Réparation : `worn` exclut les pièces quasi cassées (index.js _wornArmor) → le slot redevient
//    non couvert → la pièce est refaite EN DIAMANT, pas en fer.
// PUR : aucune dépendance au bot.

const DIA_ARMOR_ORDER = [
  { name: 'diamond_chestplate', suffix: 'chestplate', slot: 'torso', units: 8 },
  { name: 'diamond_leggings', suffix: 'leggings', slot: 'legs', units: 7 },
  { name: 'diamond_helmet', suffix: 'helmet', slot: 'head', units: 5 },
  { name: 'diamond_boots', suffix: 'boots', slot: 'feet', units: 4 },
];
const DIA_PICK_RESERVE = 3;      // = goals.DIA_PICK_COST
const DONOR_MIN_DIAMONDS = 24;   // surplus exigé pour céder son vieux fer à un cartographe
const _DIA_RE = /^(diamond|netherite)_(helmet|chestplate|leggings|boots)$/;
const _IRON_RE = /^(iron|diamond|netherite)_(helmet|chestplate|leggings|boots)$/;

const _list = (x) => { try { return Array.from(x || []); } catch (e) { return []; } };
const _hasSlot = (names, suffix, re) => names.some((n) => re.test(String(n)) && String(n).endsWith('_' + suffix));

/** Pièces diamant (ou mieux) PORTÉES. */
function diaWornCount(worn) {
  const w = _list(worn);
  return DIA_ARMOR_ORDER.filter((p) => _hasSlot(w, p.suffix, _DIA_RE)).length;
}

/** Palier d'armure PORTÉE : 'diamant' (4 diamant+), 'mixte' (≥1 diamant), 'fer' (≥1 fer), 'nu'. */
function armorTier(worn) {
  const w = _list(worn);
  const dia = diaWornCount(w);
  if (dia >= 4) return 'diamant';
  if (dia > 0) return 'mixte';
  return DIA_ARMOR_ORDER.some((p) => _hasSlot(w, p.suffix, _IRON_RE)) ? 'fer' : 'nu';
}

/**
 * Prochaine action d'armure diamant. null = rien à faire maintenant (complet, ou pas de quoi faire
 * la pièce suivante dans l'ordre).
 * @param {object} o inv {nom:count} (poche), worn (pièces portées SAINES), pocketGood (pièces d'armure
 *   SAINES en poche ; absent = toutes les pièces de `inv`), pickCount (pioches fer+ en poche),
 *   tableOk (table posable), reserve (diamants à garder ; défaut 3 sans pioche de rechange).
 * @returns {null|{act:'equip',name,slot}|{act:'craft',name,slot,units}}
 */
function diamondArmorNext({ inv, worn, pocketGood, pickCount, tableOk, reserve } = {}) {
  const i = inv || {};
  const w = _list(worn);
  const pocket = pocketGood !== undefined && pocketGood !== null
    ? _list(pocketGood) : Object.keys(i).filter((n) => (i[n] || 0) > 0);
  const picks = Number(pickCount) || 0;
  const keep = Number.isFinite(reserve) ? reserve : (picks >= 2 ? 0 : DIA_PICK_RESERVE);
  const diamonds = Number(i.diamond) || 0;
  for (const p of DIA_ARMOR_ORDER) {
    if (_hasSlot(w, p.suffix, _DIA_RE)) continue;
    const inPocket = pocket.find((n) => _DIA_RE.test(String(n)) && String(n).endsWith('_' + p.suffix));
    if (inPocket) return { act: 'equip', name: inPocket, slot: p.slot };
    if (picks < 1 || !tableOk) return null;
    if (diamonds - keep >= p.units) return { act: 'craft', name: p.name, slot: p.slot, units: p.units };
    return null;                                   // ordre strict : on attend la pièce suivante
  }
  return null;
}

/** Ce mineur peut-il céder son ancien fer (armure diamant complète + surplus + fer sain en poche) ? */
function isIronDonor({ diaWorn, diamonds, spareIron } = {}) {
  return (Number(diaWorn) || 0) >= 4 && (Number(diamonds) || 0) >= DONOR_MIN_DIAMONDS
    && (Number(spareIron) || 0) >= 1;
}

module.exports = { DIA_ARMOR_ORDER, DIA_PICK_RESERVE, DONOR_MIN_DIAMONDS, diaWornCount, armorTier,
  diamondArmorNext, isIronDonor };
