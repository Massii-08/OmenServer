'use strict';
// Réflexes déterministes (ZÉRO appel LLM) : survie de base. Manger quand faim basse,
// fuir quand PV bas ou creeper proche. Pilotés par les events natifs de Mineflayer.

const HUNGER_THRESHOLD = 6;   // sur 20
const HEALTH_THRESHOLD = 6;   // sur 20
const CREEPER_RADIUS = 6;     // blocs

const FOODS = new Set([
  'bread', 'apple', 'cooked_beef', 'cooked_porkchop', 'cooked_chicken', 'cooked_mutton',
  'cooked_cod', 'cooked_salmon', 'baked_potato', 'carrot', 'golden_carrot', 'melon_slice',
  'cooked_rabbit', 'beetroot', 'sweet_berries', 'mushroom_stew',
]);

/** Mange si faim basse et nourriture dispo. Retourne true si une consommation a eu lieu. */
async function tryEat(bot) {
  if (bot.food == null || bot.food > HUNGER_THRESHOLD) return false;
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

const OXYGEN_THRESHOLD = 5;   // sur 20 — en dessous : urgence remonter

/** Branche les réflexes sur le bot. opts: { emit, fleeFrom } injectables. */
function installReflexes(bot, opts = {}) {
  const emit = opts.emit || (() => {});
  const flee = opts.fleeFrom || (() => {});
  let fleeing = false;
  let surfacing = false;

  const react = () => {
    tryEat(bot).then((ate) => { if (ate) emit({ type: 'reflex', action: 'eat' }); }).catch(() => {});
    if (shouldFlee(bot)) {
      if (!fleeing) { flee(bot); emit({ type: 'reflex', action: 'flee' }); fleeing = true; }
    } else {
      fleeing = false;
    }
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

module.exports = { tryEat, shouldFlee, installReflexes, HUNGER_THRESHOLD, HEALTH_THRESHOLD, FOODS };
