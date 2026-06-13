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

// Palier DÉFENSIF (hole C) : entre le seuil de fuite (6) et 10 PV — « avant le critique », on lève
// le bouclier / se repositionne au lieu de continuer à miner. La fuite possède la bande ≤ 6.
const DEFENSIVE_HEALTH = 10;  // sur 20 — plafond de la bande défensive (6,10]

// Tireurs à distance (hole D) : on RIPOSTE à distance (charger, viser) quand l'un nous canarde et
// qu'aucun assaillant mêlée n'est au contact. Bande [MELEE_RADIUS, 16] : au-delà du contact, dans
// la portée d'arc. (Au contact, c'est meleeAssailant qui les gère.)
const RANGED = new Set(['skeleton', 'stray', 'bogged']);
const RANGED_MIN = 6;         // blocs — au-delà du contact mêlée
const RANGED_MAX = 16;        // blocs — portée d'arc utile

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

/** Tireur à distance (squelette/stray/bogged) dans la bande [RANGED_MIN, RANGED_MAX] blocs — la
 *  cible d'une riposte à distance. null sinon. Au contact (< RANGED_MIN) → géré par meleeAssailant. */
function rangedThreat(bot) {
  const self = (bot.entity && bot.entity.position) || null;
  if (!self || typeof bot.nearestEntity !== 'function') return null;
  return bot.nearestEntity((e) => {
    if (!e || e.type !== 'mob' || !RANGED.has(e.name) || !e.position) return false;
    const d = (typeof e.position.distanceTo === 'function')
      ? e.position.distanceTo(self)
      : Math.sqrt((e.position.x - self.x) ** 2 + (e.position.y - self.y) ** 2 + (e.position.z - self.z) ** 2);
    return d >= RANGED_MIN && d <= RANGED_MAX;
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

  const onPanic = opts.onPanic || null;
  const onDefensive = opts.onDefensive || null;
  const onRanged = opts.onRanged || null;
  const panicCooldownMs = opts.panicCooldownMs != null ? opts.panicCooldownMs : 8000;
  const defensiveCooldownMs = opts.defensiveCooldownMs != null ? opts.defensiveCooldownMs : 6000;
  let lastPanic = -Infinity;    // -∞ : le 1er panic n'est jamais bloqué par le cooldown
  let lastPanicHealth = null;   // PV au dernier panic — re-tire plus vite si ça rebaisse (attaque soutenue)
  let lastDefensive = -Infinity; // idem : 1er palier défensif jamais bloqué
  const react = () => {
    tryEat(bot).then((ate) => { if (ate) emit({ type: 'reflex', action: 'eat' }); }).catch(() => {});
    // PANIC WALL (Massii survie mobs) : PV critiques → en plus de fuir, se MURER (poser des
    // blocs autour) pour casser le contact mêlée et manger à l'abri. Cooldown panicCooldownMs (8 s
    // par défaut). Sous ATTAQUE SOUTENUE (les PV ont rebaissé depuis le dernier mur) on re-mure
    // deux fois plus vite (panicCooldownMs/2) : le mur précédent a percé, faut re-colmater.
    if (onPanic && bot.health != null && bot.health <= HEALTH_THRESHOLD) {
      const t = now();
      const sustained = lastPanicHealth != null && bot.health < lastPanicHealth;
      const cd = sustained ? panicCooldownMs / 2 : panicCooldownMs;
      if (t - lastPanic >= cd) {
        lastPanic = t; lastPanicHealth = bot.health;
        try { onPanic(); } catch (e) {}
      }
    }
    // PALIER DÉFENSIF (hole C) : bande (HEALTH_THRESHOLD, DEFENSIVE_HEALTH] PV — avant le critique,
    // lever le bouclier / se repositionner. Au-dessus du seuil de fuite (la fuite possède ≤ seuil),
    // en dessous de DEFENSIVE_HEALTH. Cooldown defensiveCooldownMs (6 s). Cible = assaillant mêlée
    // OU tireur à distance le plus pressant.
    if (onDefensive && bot.health != null && bot.health <= DEFENSIVE_HEALTH && bot.health > HEALTH_THRESHOLD) {
      const t = now();
      if (t - lastDefensive >= defensiveCooldownMs) {
        lastDefensive = t;
        const threat = meleeAssailant(bot) || rangedThreat(bot) || null;
        try { onDefensive(threat); } catch (e) {}
      }
    }
    if (shouldFlee(bot)) {
      if (!fleeing) { flee(bot); emit({ type: 'reflex', action: 'flee' }); fleeing = true; }
      lastHealth = bot.health;
      return;
    }
    fleeing = false;
    // RIPOSTE (phase B) : PV en baisse (on vient d'être frappé), pas en zone de fuite, et un
    // hostile mêlée au contact → on se défend au lieu d'encaisser en minant. Creeper exclu
    // (shouldFlee le gère). Un seul déclenchement par assaut (anti-spam : fighting).
    const hurting = bot.health != null && lastHealth != null && bot.health < lastHealth;
    if (attack && hurting) {
      const foe = meleeAssailant(bot);
      if (foe && !fighting) {
        fighting = true;
        try { attack(foe); emit({ type: 'reflex', action: 'fight', mob: foe.name }); } catch (e) {}
        // re-autorise une riposte après 5 s (le pvp plugin poursuit la cible entre-temps)
        setTimeout(() => { fighting = false; }, 5000);
      } else if (onRanged && !foe && !fighting) {
        // RIPOSTE À DISTANCE (hole D) : on encaisse mais AUCUN assaillant mêlée au contact → un
        // tireur nous canarde. La riposte mêlée est PRIORITAIRE ; le ranged n'est traité que sans
        // contact (foe == null).
        const shooter = rangedThreat(bot);
        if (shooter) {
          fighting = true;
          try { onRanged(shooter); emit({ type: 'reflex', action: 'fight_ranged', mob: shooter.name }); } catch (e) {}
          setTimeout(() => { fighting = false; }, 5000);
        }
      }
    } else if (onRanged && hurting) {
      // Pas de skill mêlée fourni mais une riposte ranged l'est : on encaisse → on riposte au tireur.
      const shooter = rangedThreat(bot);
      if (shooter && !fighting) {
        fighting = true;
        try { onRanged(shooter); emit({ type: 'reflex', action: 'fight_ranged', mob: shooter.name }); } catch (e) {}
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

module.exports = { tryEat, shouldFlee, meleeAssailant, rangedThreat, installReflexes, HUNGER_THRESHOLD, HEALTH_THRESHOLD, DEFENSIVE_HEALTH, FOODS, MELEE_HOSTILES, RANGED };
