'use strict';
// Réflexes déterministes (ZÉRO appel LLM) : survie de base. Manger quand faim basse,
// fuir quand PV bas ou creeper proche, RIPOSTER quand attaqué au corps-à-corps (phase B).
// Pilotés par les events natifs de Mineflayer.

const HUNGER_THRESHOLD = 6;   // sur 20
const HEALTH_THRESHOLD = 6;   // sur 20
const CREEPER_RADIUS = 6;     // blocs
// Phase B (régen) : blessé, on mange dès que la faim ne permet plus la régen naturelle (≥18).
const HURT_HEALTH = 14;       // en dessous : on veut régénérer
const REGEN_FOOD = 17;        // en dessous de 18 la régen s'arrête → on remange

const FOODS = new Set([
  'bread', 'apple', 'cooked_beef', 'cooked_porkchop', 'cooked_chicken', 'cooked_mutton',
  'cooked_cod', 'cooked_salmon', 'baked_potato', 'carrot', 'golden_carrot', 'melon_slice',
  'cooked_rabbit', 'beetroot', 'sweet_berries', 'mushroom_stew',
]);

// Hostiles au corps-à-corps qu'on RIPOSTE (phase B). PAS le creeper (fuite, il explose) ;
// le squelette tire à distance → riposte seulement s'il est déjà au contact (≤ MELEE_RADIUS).
const MELEE_HOSTILES = new Set([
  'zombie', 'husk', 'drowned', 'zombie_villager', 'skeleton', 'stray', 'wither_skeleton',
  'spider', 'cave_spider', 'silverfish', 'slime', 'magma_cube', 'pillager', 'vindicator',
  'vex', 'witch', 'endermite', 'zombified_piglin', 'piglin', 'hoglin', 'bogged', 'breeze',
]);
const MELEE_RADIUS = 5;       // blocs — un assaillant au contact

/** Mange si faim basse — OU si blessé et que la faim ne permet plus la régen (phase B). */
async function tryEat(bot) {
  if (bot.food == null) return false;
  const hungry = bot.food <= HUNGER_THRESHOLD;
  const needRegen = bot.health != null && bot.health <= HURT_HEALTH && bot.food <= REGEN_FOOD;
  if (!hungry && !needRegen) return false;
  const items = (bot.inventory && bot.inventory.items()) || [];
  const food = items.find((it) => FOODS.has(it.name));
  if (!food) return false;
  await bot.equip(food, 'hand');
  await bot.consume();
  return true;
}

/** Vrai s'il faut fuir : PV bas OU creeper dans le rayon. */
function shouldFlee(bot) {
  if (bot.health != null && bot.health <= HEALTH_THRESHOLD) return true;
  const self = (bot.entity && bot.entity.position) || { x: 0, y: 0, z: 0 };
  const creeper = bot.nearestEntity((e) =>
    e && e.type === 'mob' && e.name === 'creeper' && e.position &&
    e.position.distanceTo ? e.position.distanceTo(self) <= CREEPER_RADIUS
                          : e && e.name === 'creeper');
  return !!creeper;
}

/** Hostile mêlée au contact (≤ MELEE_RADIUS) — la cible de riposte. null sinon. */
function meleeAssailant(bot) {
  const self = (bot.entity && bot.entity.position) || null;
  if (!self || typeof bot.nearestEntity !== 'function') return null;
  return bot.nearestEntity((e) => {
    if (!e || e.type !== 'mob' || !MELEE_HOSTILES.has(e.name) || !e.position) return false;
    if (typeof e.position.distanceTo === 'function') return e.position.distanceTo(self) <= MELEE_RADIUS;
    const d = Math.sqrt((e.position.x - self.x) ** 2 + (e.position.y - self.y) ** 2 + (e.position.z - self.z) ** 2);
    return d <= MELEE_RADIUS;
  });
}

const OXYGEN_THRESHOLD = 5;   // sur 20 — en dessous : urgence remonter

/** Branche les réflexes sur le bot. opts: { emit, fleeFrom, attack, onWaterStuck, now } injectables.
 *  attack(target) : riposte (phase B) — fourni par index.js (équipe la meilleure arme + pvp).
 *  onWaterStuck() : appelé quand le bot BARBOTE (≥4 épisodes de surfacing en 90 s) — le réflexe
 *  oxygène le fait flotter mais rien ne le SORT de l'eau (vécu V3Res1/4 : 199 épisodes en 30 min
 *  pendant le kit, et une noyade sous plafond d'aquifère). Cooldown 60 s entre invocations. */
function installReflexes(bot, opts = {}) {
  const emit = opts.emit || (() => {});
  const flee = opts.fleeFrom || (() => {});
  const attack = opts.attack || null;
  const onWaterStuck = opts.onWaterStuck || null;
  const now = opts.now || Date.now;
  let fleeing = false;
  let surfacing = false;
  let lastHealth = null;
  let fighting = false;
  let surfaceEpisodes = [];     // timestamps des débuts d'épisode de surfacing
  let lastRescue = -Infinity;   // -∞ : le 1er rescue n'est jamais bloqué par le cooldown

  const react = () => {
    tryEat(bot).then((ate) => { if (ate) emit({ type: 'reflex', action: 'eat' }); }).catch(() => {});
    if (shouldFlee(bot)) {
      if (!fleeing) { flee(bot); emit({ type: 'reflex', action: 'flee' }); fleeing = true; }
      lastHealth = bot.health;
      return;
    }
    fleeing = false;
    // RIPOSTE (phase B) : PV en baisse (on vient d'être frappé), pas en zone de fuite, et un
    // hostile mêlée au contact → on se défend au lieu d'encaisser en minant. Creeper exclu
    // (shouldFlee le gère). Un seul déclenchement par assaut (anti-spam : fighting).
    if (attack && bot.health != null && lastHealth != null && bot.health < lastHealth) {
      const foe = meleeAssailant(bot);
      if (foe && !fighting) {
        fighting = true;
        try { attack(foe); emit({ type: 'reflex', action: 'fight', mob: foe.name }); } catch (e) {}
        // re-autorise une riposte après 5 s (le pvp plugin poursuit la cible entre-temps)
        setTimeout(() => { fighting = false; }, 5000);
      }
    }
    lastHealth = bot.health;
  };

  // Anti-noyade (vu live HarvT7 : drowned ×3 — pathfinder traverse l'eau, flee sous l'eau → air
  // épuisé). Air bas → on coupe TOUT goal (la traversée/le flee) et on remonte (jump). PRIORITAIRE
  // sur les autres réflexes : un mort ne fuit plus.
  const breathe = () => {
    const o2 = bot.oxygenLevel;
    if (o2 == null) return;
    if (o2 <= OXYGEN_THRESHOLD) {
      if (!surfacing) {
        surfacing = true;
        try { bot.pathfinder && bot.pathfinder.setGoal && bot.pathfinder.setGoal(null); } catch (e) {}
        try { bot.setControlState && bot.setControlState('jump', true); } catch (e) {}
        emit({ type: 'reflex', action: 'surface' });
        // BARBOTAGE : épisodes répétés = le bot flotte sans sortir → évasion d'eau musclée.
        // Seuil 2 (vécu V3Res1 : noyade ×3 en 7 min — chaque épisode est une quasi-noyade,
        // attendre le 4e laissait mourir sous les plafonds d'aquifère).
        const t = now();
        surfaceEpisodes.push(t);
        surfaceEpisodes = surfaceEpisodes.filter((x) => t - x <= 90000);
        if (onWaterStuck && surfaceEpisodes.length >= 2 && t - lastRescue >= 45000) {
          lastRescue = t;
          surfaceEpisodes = [];
          emit({ type: 'reflex', action: 'water_rescue' });
          try { onWaterStuck(); } catch (e) {}
        }
      }
    } else if (surfacing && o2 >= 15) { // hystérésis : on relâche une fois l'air franchement revenu
      surfacing = false;
      try { bot.setControlState && bot.setControlState('jump', false); } catch (e) {}
    }
  };

  bot.on('health', react);
  bot.on('breath', breathe);
  return { react, breathe };
}

module.exports = { tryEat, shouldFlee, meleeAssailant, installReflexes, HUNGER_THRESHOLD, HEALTH_THRESHOLD, FOODS, MELEE_HOSTILES };
