'use strict';
// Équipement & stratégie de minage RÉEL (phase 2, anti-xray). Pur/testable.
//  - Y optimal par type (1.21) : où branch-miner quand la carte n'a pas de cible exposée.
//  - cheapestPickFor : pioche LA MOINS CHÈRE adéquate pour la roche nue (économise le fer/diamant
//    sur les milliers de blocs de tunnel — la meilleure pioche reste pour les ORES).
//  - pickaxePlan : quoi crafter pour maintenir l'outillage (stone pick = cobble infini en sous-sol).
//  - mostLackingType : le type à viser en priorité (déficit relatif max — l'or a bloqué 3 bots hier).

const { TIERS } = require('./ores');

// Y de branch mining par type (centre de la bande de spawn la plus dense, 1.18+).
// NB gold = -16 (pic de spawn réel 1.18). REVERT du fix #10 (-54) : le gold mappé est concentré à -16
// (pic dense), pas à -54 (queue rare) → strip-miner à -54 cherchait un gold ~inexistant → relocate en
// boucle, 0 minage (live 22/06). Le strip à -16 (fix #8) reste le MEILLEUR débit gold observé (0→36)
// malgré les noyades (couche aquifère). Le gold est world-limité sur ce monde (−16 dense mais noyé).
// lapis : la bande dense est ~y0 (triangle -32→+32 piqué à 0). À -58 (batch "buried" uniforme) c'est
// SEC mais trop SPARSE → débit ~0 (live 22/06 soir : lapis gelé à 42 pendant 8 min, bots minant à -59
// sans rien trouver). Les mappers DÉTECTENT des veines à y-9/-7 (deepslate, couche dense exposée) → il
// EXISTE un accès dense exploitable. On vise -12 : dans la bande dense (~62% du pic, ≫ buried), assez
// bas pour passer SOUS l'aquifère de surface y0, et la garde anti-eau de branchMine (water_ahead →
// tourne vers le sec, scelle les faces d'eau) gère les nappes locales. Compromis dense+accessible >>
// dense+noyé (y0) et sec+stérile (-58).
const Y_OPT = { diamond: -58, redstone: -58, gold: -16, lapis: -12, iron: 16 };

// Palier de pioche requis pour MINER le type (index TIERS : 2=stone, 3=iron).
const TIER_FOR = { diamond: 3, gold: 3, redstone: 3, lapis: 2, iron: 2, coal: 0, copper: 2 };

function _pickTier(name) {
  const i = TIERS.findIndex((t) => name === t + '_pickaxe');
  return i;
}

/** Toutes les pioches de l'inventaire → [{name, tier, count}] trié par tier croissant. */
function listPicks(items) {
  const out = [];
  for (const it of items || []) {
    if (!it || !it.name || !it.name.endsWith('_pickaxe')) continue;
    const tier = _pickTier(it.name);
    if (tier >= 0) out.push({ name: it.name, tier, count: it.count || 1 });
  }
  return out.sort((a, b) => a.tier - b.tier);
}

/** Meilleur palier en poche (-1 = aucune pioche). */
function bestTier(items) {
  const picks = listPicks(items);
  return picks.length ? picks[picks.length - 1].tier : -1;
}

/**
 * Pioche à utiliser pour un bloc. Ore → la MEILLEURE (vitesse + palier requis) ; roche nue →
 * la MOINS CHÈRE qui casse (stone pick). REVERT du « meilleure partout » phase 3 : mesuré en
 * live (V3Res1 : fer 64→51 en 1h), une pioche fer = 250 blocs = 3 lingots — le gain de
 * 0.375 s/bloc (94 s/pioche) coûte PLUS CHER que re-miner+fondre 3 fers (minutes). La pierre
 * est gratuite (cobble infini en creusant). null si aucune pioche.
 */
function cheapestPickFor(items, blockName) {
  const picks = listPicks(items);
  if (!picks.length) return null;
  const isOre = typeof blockName === 'string' && (blockName.endsWith('_ore') || blockName === 'ancient_debris');
  if (isOre) return picks[picks.length - 1].name;            // meilleure pour l'ore
  return picks[0].name;                                       // la moins chère pour la roche
}

/**
 * Plan de maintenance d'outillage : que crafter MAINTENANT ?
 *  → {craft: 'stone_pickaxe'|'iron_pickaxe', why} | {ok:true} | {ok:false, needs}
 * Règles : toujours ≥2 stone picks d'avance (tunnel) si cobble+sticks dispo ;
 * une iron pick si le quota exige tier 3 (diamant/or/redstone) et qu'on n'en a pas
 * mais qu'on a 3 lingots.
 */
function pickaxePlan(items, neededTypes) {
  const counts = {};
  for (const it of items || []) counts[it.name] = (counts[it.name] || 0) + (it.count || 1);
  const picks = listPicks(items);
  const stonePicks = picks.filter((p) => p.tier === 2).reduce((n, p) => n + p.count, 0);
  const needTier3 = (neededTypes || []).some((t) => (TIER_FOR[t] || 0) >= 3);
  const hasTier3 = picks.some((p) => p.tier >= 3);
  const sticks = counts.stick || 0;

  if (needTier3 && !hasTier3) {
    // raw_iron compte aussi : le caller (ensureGearFor) fond raw→ingot AVANT le craft —
    // exiger les lingots ici créait un œuf-et-poule (mine du fer ×50 sans jamais crafter,
    // vécu phase 2 : 2 bots bloqués à 3-5 diamants avec 64 raw_iron en poche).
    if (((counts.iron_ingot || 0) >= 3 || (counts.raw_iron || 0) >= 3) && sticks >= 2) {
      return { craft: 'iron_pickaxe', why: 'tier3_needed' };
    }
    if (picks.length === 0 && (counts.cobblestone || 0) >= 3 && sticks >= 2) {
      return { craft: 'stone_pickaxe', why: 'no_pick' };      // au moins miner du fer en attendant
    }
  }
  if (picks.length === 0) {
    if ((counts.cobblestone || 0) >= 3 && sticks >= 2) return { craft: 'stone_pickaxe', why: 'no_pick' };
    return { ok: false, needs: 'cobble_or_sticks' };
  }
  if (stonePicks < 2 && (counts.cobblestone || 0) >= 3 && sticks >= 2) {
    return { craft: 'stone_pickaxe', why: 'spare' };          // pioche d'avance pour le tunnel
  }
  return { ok: true };
}

/**
 * Fonte OPPORTUNISTE (piste n°1 rapport water-wall) : faut-il fondre MAINTENANT ?
 * Le but smeltIron de la chaîne n'arrivait jamais (mort/reboucle avant) alors que fer+fuel+four
 * étaient réunis en poche (vécu Bot2 : 9 raw_iron + four + bois, 0 lingot). Décision PURE appelée
 * par un timer : go dès (raw_iron ≥ minRaw ET furnace en poche ET ≥1 fuel), passe bornée à 8.
 * Fuel accepté = celui de fuelNames() : coal/charcoal/planches/bûches.
 */
function smeltPlan(items, opts = {}) {
  const maxIngots = opts.maxIngots || 24;      // armure complète = 24 lingots : au-delà, rien à gagner
  const counts = {};
  for (const it of items || []) counts[it.name] = (counts[it.name] || 0) + (it.count || 1);
  const raw = counts.raw_iron || 0;
  // SEUIL ADAPTATIF (décision Massii 25/07, 4e run sans le moindre lingot) : tant qu'AUCUN lingot
  // n'est banké, on fond dès le 1er minerai. Les bots atteignent le branch-mine Y16 de façon
  // fiable mais meurent avant d'avoir 3 bruts → attendre le lot signifiait ne jamais fondre. Le
  // 1er lingot débloque le bouclier et devient un acquis que la mort n'annule plus. Une fois
  // amorcé on repasse au lot de 3 : fondre immobilise ~10 s, cher payé sous terre.
  const minRaw = opts.minRaw || ((counts.iron_ingot || 0) === 0 ? 1 : 3);
  const fuel = Object.keys(counts).some((n) =>
    n === 'coal' || n === 'charcoal' || n.endsWith('_planks') || n.endsWith('_log'));
  if (raw < minRaw) return { go: false, why: 'raw' };
  if (!counts.furnace) return { go: false, why: 'furnace' };
  if (!fuel) return { go: false, why: 'fuel' };
  if ((counts.iron_ingot || 0) >= maxIngots) return { go: false, why: 'enough' };
  return { go: true, count: Math.min(raw, 8) };
}

/** La position courante permet-elle une fonte fiable ? (pur) La pose du four portable échoue en
 * eau / en l'air / en plein déplacement (vécu live NethBot3 : opportunistic_smelt + armor_smelt
 * no_furnace pendant l'exploration de surface) → on n'ouvre le four que sur sol stable et immobile. */
function smeltReady({ onGround, inWater, moving } = {}) {
  return !!onGround && !inWater && !moving;
}

/** Type au DÉFICIT RELATIF max parmi progress {type:{have,target}}. null si tout est servi. */
function mostLackingType(progress) {
  let best = null, bestRatio = 0;
  for (const [t, v] of Object.entries(progress || {})) {
    if (!v || !v.target) continue;
    const deficit = Math.max(0, v.target - v.have) / v.target;
    if (deficit > bestRatio) { bestRatio = deficit; best = t; }
  }
  return best;
}

// ── Armure de fer (survie mobs #1, Massii) : coût en lingots par pièce + slot d'équipement.
// On craft du moins cher au plus cher (bottes→casque→jambières→plastron) pour gagner de la
// protection tôt. On ne touche au fer que si le bot en a LARGEMENT (buffer ≥ ironKeep) — le
// quota fer (64) doit rester atteignable ; un set complet = 24 lingots.
const ARMOR_PIECES = [
  { name: 'iron_boots', slot: 'feet', ingots: 4 },
  { name: 'iron_helmet', slot: 'head', ingots: 5 },
  { name: 'iron_leggings', slot: 'legs', ingots: 7 },
  { name: 'iron_chestplate', slot: 'torso', ingots: 8 },
];

// Rang de matière d'armure (pour équiper la MEILLEURE pièce dispo par slot, jamais downgrade).
const _ARMOR_MAT_RANK = { leather: 1, golden: 2, chainmail: 2, iron: 3, diamond: 4, netherite: 5 };
const _ARMOR_SUFFIX_SLOT = { _helmet: 'head', _chestplate: 'torso', _leggings: 'legs', _boots: 'feet' };
function _armorSlot(name) {
  for (const [suf, slot] of Object.entries(_ARMOR_SUFFIX_SLOT)) if (name.endsWith(suf)) return slot;
  return null;
}
function _armorRank(name) {
  const mat = String(name).split('_')[0];
  return _ARMOR_MAT_RANK[mat] || 0;
}

/**
 * bestArmorToEquip(items, worn) → [{name, slot}] : pour chaque slot, la MEILLEURE pièce d'armure
 * en poche STRICTEMENT supérieure à ce qui est déjà porté (jamais de downgrade). Sert à équiper
 * un kit donné (ex. armure diamant fournie au lancement) — l'ancien ensureArmor ne connaissait
 * QUE les pièces de fer (ARMOR_PIECES) → un kit diamant restait en poche, bots NON armurés = morts.
 * Pur/testable. items=[{name,count}], worn=Set de noms portés.
 */
function bestArmorToEquip(items, worn) {
  const wornSet = worn instanceof Set ? worn : new Set(worn || []);
  // rang max actuellement porté par slot
  const wornRank = {};
  for (const n of wornSet) {
    const slot = _armorSlot(n); if (slot) wornRank[slot] = Math.max(wornRank[slot] || 0, _armorRank(n));
  }
  // meilleure pièce en poche par slot
  const best = {};
  for (const it of items || []) {
    if (!it || !it.name) continue;
    const slot = _armorSlot(it.name); if (!slot) continue;
    const rank = _armorRank(it.name); if (!rank) continue;
    if (!best[slot] || rank > best[slot].rank) best[slot] = { name: it.name, rank };
  }
  const out = [];
  for (const [slot, b] of Object.entries(best)) {
    if (b.rank > (wornRank[slot] || 0)) out.push({ name: b.name, slot });
  }
  return out;
}

/**
 * Plan d'armure : prochaine pièce à crafter (la moins chère manquante) compte tenu des lingots
 * dispos ET d'un buffer fer à préserver pour le quota. items = [{name,count}], opts:
 *  - have : ensemble des pièces DÉJÀ portées/possédées (noms)
 *  - ironKeep : lingots-équivalents de fer à NE PAS consommer (déf 0)
 * → { craft, slot, ingots } | null. (pur/testable)
 */
function armorPlan(items, opts = {}) {
  const have = new Set(opts.have || []);
  const cnt = (n) => (items || []).filter((i) => i.name === n).reduce((a, i) => a + (i.count || 0), 0);
  const ingots = cnt('iron_ingot');
  const ironKeep = opts.ironKeep || 0;
  const spendable = ingots - ironKeep;                        // lingots qu'on s'autorise à fondre en armure
  for (const piece of ARMOR_PIECES) {
    if (have.has(piece.name)) continue;
    if (((items || []).some((i) => i.name === piece.name))) continue; // déjà en poche → à équiper, pas crafter
    if (spendable >= piece.ingots) return { craft: piece.name, slot: piece.slot, ingots: piece.ingots };
  }
  return null;
}

// ── Upgrade d'armure vers une matière cible (run nether 2026-07-13 : armure DIAMANT auto-craftée).
// Coûts par pièce (diamants), moins chère d'abord — même logique que ARMOR_PIECES pour le fer.
const _UPGRADE_PIECES = {
  diamond: [
    { name: 'diamond_boots', slot: 'feet', units: 4 },
    { name: 'diamond_helmet', slot: 'head', units: 5 },
    { name: 'diamond_leggings', slot: 'legs', units: 7 },
    { name: 'diamond_chestplate', slot: 'torso', units: 8 },
  ],
};

/**
 * armorUpgradePlan(items, worn, {material:'diamond'}) → prochaine pièce à crafter pour amener
 * chaque SLOT au rang de `material` : slot ignoré si une pièce portée OU en poche a déjà un rang
 * ≥ matière cible (jamais de downgrade ni de doublon). Gated par le stock d'unités (💎). Pur/testable.
 * → { craft, slot, units } | null.
 */
function armorUpgradePlan(items, worn, opts = {}) {
  const material = opts.material || 'diamond';
  const pieces = _UPGRADE_PIECES[material];
  if (!pieces) return null;
  const targetRank = _ARMOR_MAT_RANK[material] || 0;
  const wornSet = worn instanceof Set ? worn : new Set(worn || []);
  const cnt = (n) => (items || []).filter((i) => i && i.name === n).reduce((a, i) => a + (i.count || 0), 0);
  // rang max par slot, porté OU en poche
  const slotRank = {};
  const consider = (n) => {
    const slot = _armorSlot(n); if (!slot) return;
    slotRank[slot] = Math.max(slotRank[slot] || 0, _armorRank(n));
  };
  for (const n of wornSet) consider(n);
  for (const it of items || []) { if (it && it.name && (it.count || 0) > 0) consider(it.name); }
  const units = cnt(material);                        // 'diamond' est aussi le nom de l'item
  for (const piece of pieces) {
    if ((slotRank[piece.slot] || 0) >= targetRank) continue;   // slot déjà à niveau (ou mieux)
    if (units >= piece.units) return { craft: piece.name, slot: piece.slot, units: piece.units };
    return null;                                      // pas assez pour la moins chère manquante
  }
  return null;
}

/**
 * Gate « ok pour descendre en profondeur » : bottes + casque + un bouclier (n'importe quel
 * palier d'armure suffit). worn = tableau OU Set de noms d'items équipés. (pur/testable)
 */
function isMinimallyArmored(worn, hasShield) {
  const names = Array.from(worn || []);
  const hasBoots = names.some((n) => typeof n === 'string' && n.endsWith('_boots'));
  const hasHelmet = names.some((n) => typeof n === 'string' && n.endsWith('_helmet'));
  return hasBoots && hasHelmet && hasShield === true;
}

/**
 * Plan bouclier (rend testable la logique inline d'index.js). items = [{name,count}].
 * → { craft: 'shield' } si (pas de bouclier) ET (≥6 planches, tout type) ET (≥1 lingot fer) ;
 * sinon null. (pur/testable)
 */
function shieldPlan(items, hasShield) {
  if (hasShield) return null;
  const planks = (items || [])
    .filter((i) => i && typeof i.name === 'string' && i.name.endsWith('_planks'))
    .reduce((a, i) => a + (i.count || 0), 0);
  const iron = (items || [])
    .filter((i) => i && i.name === 'iron_ingot')
    .reduce((a, i) => a + (i.count || 0), 0);
  if (planks >= 6 && iron >= 1) return { craft: 'shield' };
  return null;
}

module.exports = { Y_OPT, TIER_FOR, listPicks, bestTier, cheapestPickFor, pickaxePlan, mostLackingType, armorPlan, ARMOR_PIECES, bestArmorToEquip, armorUpgradePlan, isMinimallyArmored, shieldPlan, smeltPlan, smeltReady };
