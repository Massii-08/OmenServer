'use strict';
// Survie « basique + » du cartographe (spec §5.2). Décisions PURES (testables) + tick orchestrateur.
//  - mange dès que la faim baisse (cuit OU cru — la chasse rapporte de la viande crue) ;
//  - se nourrit : si faim et rien à manger → tue opportunément un mob passif proche (sinon n'engage pas) ;
//  - se défend un minimum : combat 1-2 hostiles à l'épée ; FUIT si submergé (≥3) ou PV bas ;
//  - ne plonge pas en grotte : c'est le mapper qui note l'entrée (caves.js), pas ce module.
// Le tick fait UNE action courte et rend son label — la boucle mapper re-tick tant que ce n'est pas calme.
const { FOODS } = require('./reflexes');
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

// Viandes crues OK à manger (la chasse en rapporte ; pas d'effet négatif sauf chicken 30% hunger, acceptable).
const RAW_FOODS = new Set(['beef', 'porkchop', 'chicken', 'mutton', 'rabbit', 'cod', 'salmon']);
// Mobs passifs chassables pour se nourrir (drop de la viande).
const PASSIVE_FOOD_MOBS = new Set(['cow', 'pig', 'chicken', 'sheep', 'rabbit', 'mooshroom']);

/**
 * Décision de combat PURE : 'flee' (submergé ou PV bas), 'fight' (1-2 hostiles), null (calme).
 * `armored` (optionnel) : SANS armure (false) → seuils prudents (fuit dès 2 hostiles ou PV ≤ 12),
 * anti « mort par combo ». Avec armure OU inconnu → seuils historiques courageux (rétro-compat).
 */
function combatDecision({ health, hostileCount, armored, hasCreeper }) {
  if (!hostileCount) return null;
  // CREEPER : JAMAIS de mêlée (il explose au contact → mort instantanée même en armure diamant, vécu
  // live R3 22/06 : fight creeper ×2 → dead en deep mining). On FUIT pour casser la ligne d'explosion ;
  // le bot reprend le minage une fois à distance. Prime sur tout (santé/armure/count).
  if (hasCreeper) return 'flee';
  const swarm = armored === false ? SWARM_UNARMORED : SWARM_COUNT;
  const lowHp = armored === false ? LOW_HEALTH_UNARMORED : LOW_HEALTH;
  if (hostileCount >= swarm) return 'flee';
  if (health != null && health <= lowHp) return 'flee';
  return 'fight';
}

/** A-t-on au moins une pièce d'armure portée (slots inventaire 5-8) ? Proxy de robustesse combat. */
function isArmored(bot) {
  try {
    const slots = bot.inventory && bot.inventory.slots;
    if (!slots) return false;
    return slots.slice(5, 9).some((it) => it && it.name);
  } catch (e) { return false; }
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
  const decision = combatDecision({ health: bot.health, hostileCount: hostiles.length, armored: isArmored(bot), hasCreeper });
  if (decision === 'flee') {
    try { deps.fleeFrom && deps.fleeFrom(bot); } catch (e) {}
    emit({ type: 'survival', action: 'flee', hostiles: hostiles.length });
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
  combatDecision, isArmored, nearbyHostiles, hasFood, needHunt, nearestPassive, eatAny, survivalTick,
  SWARM_COUNT, LOW_HEALTH, SWARM_UNARMORED, LOW_HEALTH_UNARMORED, HUNT_HUNGER, EAT_HUNGER,
  RAW_FOODS, PASSIVE_FOOD_MOBS, NEUTRAL_NO_PROVOKE,
};
