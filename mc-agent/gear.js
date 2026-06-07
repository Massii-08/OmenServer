'use strict';
// Équipement & stratégie de minage RÉEL (phase 2, anti-xray). Pur/testable.
//  - Y optimal par type (1.21) : où branch-miner quand la carte n'a pas de cible exposée.
//  - cheapestPickFor : pioche LA MOINS CHÈRE adéquate pour la roche nue (économise le fer/diamant
//    sur les milliers de blocs de tunnel — la meilleure pioche reste pour les ORES).
//  - pickaxePlan : quoi crafter pour maintenir l'outillage (stone pick = cobble infini en sous-sol).
//  - mostLackingType : le type à viser en priorité (déficit relatif max — l'or a bloqué 3 bots hier).

const { TIERS } = require('./ores');

// Y de branch mining par type (centre de la bande de spawn la plus dense, 1.18+).
const Y_OPT = { diamond: -58, redstone: -58, gold: -16, lapis: 0, iron: 16 };

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

module.exports = { Y_OPT, TIER_FOR, listPicks, bestTier, cheapestPickFor, pickaxePlan, mostLackingType, armorPlan, ARMOR_PIECES };
