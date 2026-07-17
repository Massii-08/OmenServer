'use strict';
// Survie « basique + » du cartographe (spec §5.2). Décisions PURES (testables) + tick orchestrateur.
//  - mange dès que la faim baisse (cuit OU cru — la chasse rapporte de la viande crue) ;
//  - se nourrit : si faim et rien à manger → tue opportunément un mob passif proche (sinon n'engage pas) ;
//  - se défend un minimum : combat 1-2 hostiles à l'épée ; FUIT si submergé (≥3) ou PV bas ;
//  - ne plonge pas en grotte : c'est le mapper qui note l'entrée (caves.js), pas ce module.
// Le tick fait UNE action courte et rend son label — la boucle mapper re-tick tant que ce n'est pas calme.
const { Vec3 } = require('vec3');
const { FOODS, FLEE_ONLY_ALWAYS, FLEE_ONLY_LOWHP, FLEE_ONLY_LOWHP_THRESHOLD, isFleeOnlyMob } = require('./reflexes');
const { bestWeapon } = require('./tools');

const SWARM_COUNT = 3;   // ≥3 hostiles = submergé → fuite (AVEC armure)
const LOW_HEALTH = 8;    // PV ≤ 8 (4 cœurs) → fuite (AVEC armure)
// SANS armure : plus prudent (anti « mort par combo » — un coup dur de 9 PV pouvait tuer avant
// même de croiser le seuil de fuite). L'armure = levier de survie #1 (Massii) → on se bat
// bravement AVEC, on bat en retraite plus tôt SANS.
const SWARM_UNARMORED = 2;      // ≥2 hostiles sans armure = on décroche
// bug #4 (keepInv=false) : 12→16. Live, TOUTES les morts restantes = fight→flee→dead (la fuite arrivait
// trop tard, le bot mourait PENDANT). Sans armure (cas keepInv=false post-mort) on décroche à 8 cœurs
// → plus de marge pour s'échapper avant le combo mortel. La survie prime sur quelques coups d'épée.
const LOW_HEALTH_UNARMORED = 16; // PV ≤ 16 (8 cœurs) sans armure = on décroche TÔT
const HUNT_HUNGER = 12;  // faim ≤ 12 et rien à manger → chasse un passif
const EAT_HUNGER = 14;   // faim ≤ 14 et nourriture en poche → mange (plus tôt que les réflexes)
// bug #3 (Massii) : mobs NEUTRES à NE JAMAIS attaquer/cibler. L'enderman est classé 'Hostile mobs' par
// mineflayer mais reste NEUTRE (passif sauf si on le frappe OU le regarde en face) → l'attaquer l'aggro
// → mort (téléporte + tape fort). Exclu de nearbyHostiles → jamais riposté/ciblé.
const NEUTRAL_NO_PROVOKE = new Set(['enderman']);

// FLEE-ONLY (AltoClef getUniversallyDangerousMob) : hostiles qu'on ne doit JAMAIS engager en mêlée
// (wither_skeleton toujours ; hoglin/zoglin si PV<10). Set canonique + prédicat isFleeOnlyMob définis
// dans reflexes.js (partagés avec la riposte réactive, pas de duplication / import circulaire).

/** Un hostile « trop dangereux pour le contact » est-il présent parmi la liste ? (pur, testable) */
function hasFleeOnly(hostiles, health) {
  return (hostiles || []).some((h) => h && h.name && isFleeOnlyMob(h.name, health));
}

// Viandes crues OK à manger (la chasse en rapporte ; pas d'effet négatif sauf chicken 30% hunger, acceptable).
const RAW_FOODS = new Set(['beef', 'porkchop', 'chicken', 'mutton', 'rabbit', 'cod', 'salmon']);
// Mobs passifs chassables pour se nourrir (drop de la viande).
const PASSIVE_FOOD_MOBS = new Set(['cow', 'pig', 'chicken', 'sheep', 'rabbit', 'mooshroom']);

/**
 * Décision de combat PURE : 'flee' (submergé ou PV bas), 'fight' (1-2 hostiles), null (calme).
 * `armored` (optionnel) : SANS armure (false) → seuils prudents (fuit dès 2 hostiles ou PV ≤ 12),
 * anti « mort par combo ». Avec armure OU inconnu → seuils historiques courageux (rétro-compat).
 */
function combatDecision({ health, hostileCount, armored, hasCreeper, lavaNear, preferFlee, nearestDist, fleeOnly, capability }) {
  if (!hostileCount) return null;
  // CREEPER : JAMAIS de mêlée (il explose au contact → mort instantanée même en armure diamant, vécu
  // live R3 22/06 : fight creeper ×2 → dead en deep mining). On FUIT pour casser la ligne d'explosion ;
  // le bot reprend le minage une fois à distance. Prime sur tout (santé/armure/count).
  if (hasCreeper) return 'flee';
  // LAVE proche : mêlée au bord de la lave = mort par knockback (vécu fable1 : ResBot3 « tried to
  // swim in lava » pendant fight zombie en deep-serpentine). On décroche pour se battre au sec.
  if (lavaNear) return 'flee';
  // FLEE-ONLY : mob trop dangereux pour le contact (wither_skeleton / hoglin bas-PV) → fuite forcée
  // AVANT toute logique de combat (proactif : le mode minage tourne SANS preferFlee et engageait
  // tout hostile ≤10 blocs, d'où les morts Nether documentées).
  if (fleeOnly) return 'flee';
  // Mode MAPPEUR (preferFlee, demande Massii live 2026-07-15) : FUIR par défaut — se défendre
  // UNIQUEMENT si l'assaillant est à portée de coup (risque de hit imminent, ≤3 blocs).
  if (preferFlee) return (nearestDist != null && nearestDist <= 3) ? 'fight' : 'flee';
  const swarm = armored === false ? SWARM_UNARMORED : SWARM_COUNT;
  const lowHp = armored === false ? LOW_HEALTH_UNARMORED : LOW_HEALTH;
  if (hostileCount >= swarm) return 'flee';
  if (health != null && health <= lowHp) return 'flee';
  // canDealWith (AltoClef) : CAUTIOUS-ONLY + multi-mob-only — si on ne peut pas « gérer » le nombre
  // d'hostiles (capacité ≤ count), on fuit. Le gate hostileCount>=2 laisse le cas 1-mob aux seuils
  // ci-dessus (pas de sur-prudence qui ferait fuir un unique mob faible). N'AJOUTE que de la prudence
  // (jamais de témérité) → 0 régression sur les bots bien équipés, fixe « une botte en cuir = courageux ».
  if (capability != null && hostileCount >= 2 && capability <= hostileCount) return 'flee';
  return 'fight';
}

/** Lave à ≤radius blocs du bot (boîte horizontale, y-1..+2) ? Un combat engagé là = risque de
 *  knockback dans la lave. Scan borné (≤ (2r+1)²×4 blockAt) — appelé UNIQUEMENT si hostiles. */
function lavaNearby(bot, radius = 3) {
  const self = bot.entity && bot.entity.position;
  if (!self || typeof bot.blockAt !== 'function') return false;
  const bx = Math.floor(self.x); const by = Math.floor(self.y); const bz = Math.floor(self.z);
  for (let dx = -radius; dx <= radius; dx++) {
    for (let dz = -radius; dz <= radius; dz++) {
      for (let dy = -1; dy <= 2; dy++) {
        try {
          const b = bot.blockAt(new Vec3(bx + dx, by + dy, bz + dz));
          if (b && (b.name === 'lava' || b.name === 'flowing_lava')) return true;
        } catch (e) { /* bord de chunk → on continue */ }
      }
    }
  }
  return false;
}

/** A-t-on au moins une pièce d'armure portée (slots inventaire 5-8) ? Proxy de robustesse combat. */
function isArmored(bot) {
  try {
    const slots = bot.inventory && bot.inventory.slots;
    if (!slots) return false;
    return slots.slice(5, 9).some((it) => it && it.name);
  } catch (e) { return false; }
}

// Points d'armure (défense) par pièce (valeurs MC Java). Sert à graduer la capacité de combat
// (une seule botte en cuir ≠ pleine armure fer — le booléen isArmored ne le distinguait pas).
const ARMOR_POINTS = {
  leather_helmet: 1, leather_chestplate: 3, leather_leggings: 2, leather_boots: 1,
  golden_helmet: 2, golden_chestplate: 5, golden_leggings: 3, golden_boots: 1,
  chainmail_helmet: 2, chainmail_chestplate: 5, chainmail_leggings: 4, chainmail_boots: 1,
  iron_helmet: 2, iron_chestplate: 6, iron_leggings: 5, iron_boots: 2,
  diamond_helmet: 3, diamond_chestplate: 8, diamond_leggings: 6, diamond_boots: 3,
  netherite_helmet: 3, netherite_chestplate: 8, netherite_leggings: 6, netherite_boots: 3,
  turtle_helmet: 2,
};
// Dégât d'arme au sens AltoClef (1 + bonus matériau ; 0 sans épée).
const SWORD_DAMAGE = { wooden_sword: 1, golden_sword: 1, stone_sword: 2, iron_sword: 3, diamond_sword: 4, netherite_sword: 5 };

/** Somme des points d'armure PORTÉE (slots 5-8), 0-20. (pur, testable) */
function armorPoints(bot) {
  try {
    const slots = bot.inventory && bot.inventory.slots;
    if (!slots) return 0;
    return slots.slice(5, 9).reduce((s, it) => s + (it && ARMOR_POINTS[it.name] ? ARMOR_POINTS[it.name] : 0), 0);
  } catch (e) { return 0; }
}
/** Meilleur dégât d'épée en inventaire (0 sans épée). (pur, testable) */
function weaponDamage(bot) {
  const items = (bot.inventory && bot.inventory.items()) || [];
  let best = 0;
  for (const it of items) { const d = SWORD_DAMAGE[it && it.name]; if (d && d > best) best = d; }
  return best;
}
/** Capacité de combat continue (AltoClef canDealWith) = nb de mobs « gérables ». (pur, testable) */
function combatCapability(armorPts, weaponDmg) {
  return Math.ceil((armorPts || 0) * 3.6 / 20 + (weaponDmg || 0) * 0.8) + 1;
}

/** Hostiles (kind mineflayer 'Hostile mobs') dans le rayon. */
function nearbyHostiles(bot, radius = 10) {
  const self = bot.entity && bot.entity.position;
  if (!self) return [];
  return Object.values(bot.entities || {}).filter((e) =>
    e && e.kind === 'Hostile mobs' && !NEUTRAL_NO_PROVOKE.has(e.name) && e.position &&   // bug #3 : jamais l'enderman
    (e.position.distanceTo ? e.position.distanceTo(self) <= radius : false));
}

function _edible(name) { return FOODS.has(name) || RAW_FOODS.has(name); }

/** A-t-on quelque chose à manger (cuit OU cru) ? */
function hasFood(bot) {
  return ((bot.inventory && bot.inventory.items()) || []).some((it) => _edible(it.name));
}

/** Faim + rien à manger → il faut chasser. */
function needHunt(bot) {
  return bot.food != null && bot.food <= HUNT_HUNGER && !hasFood(bot);
}

/** Mob passif chassable le plus proche dans le rayon (null si aucun). Ignore les entités mortes. */
function nearestPassive(bot, radius = 24) {
  const self = bot.entity && bot.entity.position;
  if (!self) return null;
  const e = bot.nearestEntity((x) => x && PASSIVE_FOOD_MOBS.has(x.name) && x.position && x.isValid !== false);
  if (!e) return null;
  const d = e.position.distanceTo ? e.position.distanceTo(self) : Infinity;
  return d <= radius ? e : null;
}

/** Mange (cuit OU cru) si faim ≤ EAT_HUNGER. true si une consommation a eu lieu. */
async function eatAny(bot) {
  if (bot.food == null || bot.food > EAT_HUNGER) return false;
  const food = ((bot.inventory && bot.inventory.items()) || []).find((it) => _edible(it.name));
  if (!food) return false;
  try {
    await bot.equip(food, 'hand');
    await bot.consume();
    return true;
  } catch (e) { return false; }
}

/**
 * Un tick de survie : exécute AU PLUS une action courte, rend son label ('flee'|'fight'|'eat'|'hunt')
 * ou null si tout est calme. La boucle mapper re-tick tant que non-null (avec un cap anti-blocage).
 * deps : { fleeFrom, emit? } injectables.
 */
async function survivalTick(bot, deps = {}) {
  const emit = deps.emit || (() => {});
  const hostiles = nearbyHostiles(bot, 10);
  const hasCreeper = hostiles.some((h) => h && h.name === 'creeper');   // creeper → fuir, jamais mêlée (anti-explosion)
  // Lave évaluée seulement s'il y a des hostiles (le scan a un coût) ; injectable pour les tests.
  const lavaNear = hostiles.length ? (deps.lavaNear ? !!deps.lavaNear(bot) : lavaNearby(bot)) : false;
  // distance du plus proche hostile (mode mappeur preferFlee : fight seulement à portée de coup)
  const self = bot.entity && bot.entity.position;
  const nearestDist = (hostiles.length && self) ? Math.min(...hostiles.map((h) => {
    try {
      if (h.position && typeof h.position.distanceTo === 'function') return h.position.distanceTo(self);
      return Math.sqrt((h.position.x - self.x) ** 2 + (h.position.y - self.y) ** 2 + (h.position.z - self.z) ** 2);
    } catch (e) { return Infinity; }
  })) : null;
  const fleeOnly = hasFleeOnly(hostiles, bot.health);   // wither_skeleton / hoglin bas-PV → jamais de mêlée
  const capability = combatCapability(armorPoints(bot), weaponDamage(bot));   // canDealWith (cautious-only)
  const decision = combatDecision({ health: bot.health, hostileCount: hostiles.length, armored: isArmored(bot), hasCreeper, lavaNear, preferFlee: !!deps.preferFlee, nearestDist, fleeOnly, capability });
  if (decision === 'flee') {
    try { deps.fleeFrom && deps.fleeFrom(bot); } catch (e) {}
    const ev = { type: 'survival', action: 'flee', hostiles: hostiles.length };
    if (lavaNear) ev.reason = 'lava_near';
    else if (fleeOnly) ev.reason = 'flee_only';
    emit(ev);
    return 'flee';
  }
  if (decision === 'fight') {
    const w = bestWeapon(bot);
    if (w) { try { await bot.equip(w, 'hand'); } catch (e) {} }
    try { bot.pvp.attack(hostiles[0]); } catch (e) {}
    emit({ type: 'survival', action: 'fight', target: hostiles[0].name });
    return 'fight';
  }
  if (await eatAny(bot)) { emit({ type: 'survival', action: 'eat' }); return 'eat'; }
  if (needHunt(bot)) {
    const prey = nearestPassive(bot, 24);
    if (prey) {
      const w = bestWeapon(bot);
      if (w) { try { await bot.equip(w, 'hand'); } catch (e) {} }
      try { bot.pvp.attack(prey); } catch (e) {}
      emit({ type: 'survival', action: 'hunt', target: prey.name });
      return 'hunt';
    }
  }
  return null;
}

module.exports = {
  combatDecision, isArmored, nearbyHostiles, hasFood, needHunt, nearestPassive, eatAny, survivalTick, lavaNearby,
  hasFleeOnly, armorPoints, weaponDamage, combatCapability,
  SWARM_COUNT, LOW_HEALTH, SWARM_UNARMORED, LOW_HEALTH_UNARMORED, HUNT_HUNGER, EAT_HUNGER,
  RAW_FOODS, PASSIVE_FOOD_MOBS, NEUTRAL_NO_PROVOKE,
  FLEE_ONLY_ALWAYS, FLEE_ONLY_LOWHP, FLEE_ONLY_LOWHP_THRESHOLD,
};
