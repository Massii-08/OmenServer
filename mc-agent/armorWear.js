'use strict';
// ─── USURE DE L'ARMURE DIAMANT — fin de la boucle d'usure (24/10) ──────────────────────────────
// Mesure live (une session) : gear_worn_out ×294, armor_repair ×82 (en FER, objectif diamant),
// armor_equipped ×586 ; 65 diamants minés, 59 dépensés dont 33 en armure, 6 en poche.
// Mécanisme : une pièce diamant passée 85 % d'usure ne compte plus comme portée (`_wornArmor`) →
//  (1) `bestArmorToEquip` voit le slot « vide » et enfile la pièce de FER de la poche ; la pièce
//      diamant retombe en poche, où elle bat le fer porté → ré-enfilée → re-usée → boucle ;
//  (2) le timer d'armure forge une pièce de FER pour le slot « vide » (armor_repair iron_*) ;
//  (3) la chaîne diamant reforge en diamant à 85 % (15 % de durée de vie jetée à chaque fois).
// Règles :
//  - une pièce diamant/netherite n'est « à remplacer » qu'en dessous de 10 % de durabilité restante ;
//  - jamais une pièce de rang inférieur par-dessus une pièce occupant le slot (même usée) ;
//  - même rang : seulement si l'occupante est usée et la candidate saine ;
//  - jamais deux fois la même pièce (slot) en 10 min ;
//  - pas de fer forgé pour un slot occupé par du diamant.
// PUR.

const WEAR_REPLACE_DEFAULT = 0.85;
const WEAR_REPLACE_DIAMOND = 0.90;       // < 10 % de durabilité restante
const RECRAFT_COOLDOWN_MS = 10 * 60 * 1000;

const _ARMOR_RE = /^(leather|chainmail|golden|iron|diamond|netherite|turtle)_(helmet|chestplate|leggings|boots)$/;
const _RANK = { leather: 1, golden: 2, chainmail: 3, turtle: 3, iron: 4, diamond: 5, netherite: 6 };
const _SLOT = { helmet: 'head', chestplate: 'torso', leggings: 'legs', boots: 'feet' };

function armorInfo(name) {
  const m = _ARMOR_RE.exec(String(name || ''));
  if (!m) return null;
  return { mat: m[1], rank: _RANK[m[1]] || 0, slot: _SLOT[m[2]] };
}

/** PUR — seuil d'usure « à remplacer » selon l'objet (armure diamant/netherite = 0,90). */
function wearThresholdFor(name) {
  const a = armorInfo(name);
  return (a && a.rank >= _RANK.diamond) ? WEAR_REPLACE_DIAMOND : WEAR_REPLACE_DEFAULT;
}

/**
 * PUR — peut-on enfiler `cand` ({name, broken}) dans un slot occupé par `occ` ({name, broken} | null) ?
 * Jamais une pièce usée ; jamais de rang inférieur ; même rang seulement pour remplacer une usée.
 */
function canEquipOver(cand, occ) {
  if (!cand || !cand.name || cand.broken) return false;
  const c = armorInfo(cand.name); if (!c) return false;
  if (!occ || !occ.name) return true;
  if (occ.name === cand.name && !occ.broken) return false;     // déjà en place
  const o = armorInfo(occ.name); if (!o) return true;
  if (c.rank > o.rank) return true;
  if (c.rank === o.rank) return !!occ.broken;
  return false;
}

/**
 * PUR — plan d'équipement : pour chaque slot, la meilleure pièce SAINE de la poche qui peut aller
 * par-dessus l'occupante. items = [{name, broken}], occupied = [{name, broken}] (slots portés).
 * @returns {Array<{name, slot}>}
 */
function equipPlan(items, occupied) {
  const occ = {};
  for (const o of occupied || []) { const a = o && armorInfo(o.name); if (a) occ[a.slot] = o; }
  const best = {};
  for (const it of items || []) {
    if (!it || it.broken) continue;
    const a = armorInfo(it.name); if (!a) continue;
    if (!best[a.slot] || a.rank > best[a.slot].rank) best[a.slot] = { name: it.name, rank: a.rank };
  }
  const out = [];
  for (const [slot, b] of Object.entries(best)) {
    if (canEquipOver({ name: b.name, broken: false }, occ[slot] || null)) out.push({ name: b.name, slot });
  }
  return out;
}

/** PUR — ce slot vient-il d'être reforgé (< 10 min) ? map = {slot: ts}. */
function recraftCooling(map, slot, now, ms = RECRAFT_COOLDOWN_MS) {
  const t = map && Number(map[slot]);
  return !!(t && (now - t) >= 0 && (now - t) < ms);
}

/** PUR — slots en refroidissement de reforge. */
function coolingSlots(map, now, ms = RECRAFT_COOLDOWN_MS) {
  return Object.keys(map || {}).filter((s) => recraftCooling(map, s, now, ms));
}

/** PUR — forger une pièce de FER pour ce slot est-il interdit ? (occupé par du diamant/netherite, même usé) */
function ironCraftBlocked(occupantName) {
  const a = armorInfo(occupantName);
  return !!(a && a.rank >= _RANK.diamond);
}

module.exports = { WEAR_REPLACE_DEFAULT, WEAR_REPLACE_DIAMOND, RECRAFT_COOLDOWN_MS, armorInfo,
  wearThresholdFor, canEquipOver, equipPlan, recraftCooling, coolingSlots, ironCraftBlocked };
