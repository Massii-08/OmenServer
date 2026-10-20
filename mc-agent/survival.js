'use strict';
// Survie « basique + » du cartographe (spec §5.2). Décisions PURES (testables) + tick orchestrateur.
//  - mange dès que la faim baisse (cuit OU cru — la chasse rapporte de la viande crue) ;
//  - se nourrit : si faim et rien à manger → tue opportunément un mob passif proche (sinon n'engage pas) ;
//  - se défend un minimum : combat 1-2 hostiles à l'épée ; FUIT si submergé (≥3) ou PV bas ;
//  - ne plonge pas en grotte : c'est le mapper qui note l'entrée (caves.js), pas ce module.
// Le tick fait UNE action courte et rend son label — la boucle mapper re-tick tant que ce n'est pas calme.
const { Vec3 } = require('vec3');
const { FOODS, FLEE_ONLY_ALWAYS, FLEE_ONLY_LOWHP, FLEE_ONLY_LOWHP_THRESHOLD, isFleeOnlyMob, REGEN_FOOD, NO_REGEN_HP_MARGIN } = require('./reflexes');
const { bestWeapon } = require('./tools');
const { creeperPlan } = require('./creeper');

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
// FAIM (hard, Massii : 167 morts/3h dont beaucoup « starved to death while fighting » — un bot
// affamé se battait comme s'il allait régénérer). Deux mécaniques vanilla exploitées par
// combatDecision : sous CRITICAL_HUNGER le sprint est coupé (on ne peut plus fuir vite) → `armored`
// est traité comme false MÊME en armure complète (prudence maximale). Sous REGEN_FOOD (reflexes.js,
// la régén naturelle s'arrête sous 18) chaque PV perdu est DÉFINITIF tant qu'on n'a pas mangé → le
// seuil de fuite basse-santé est relevé de NO_REGEN_HP_MARGIN (on décroche plus tôt).
const CRITICAL_HUNGER = 6;   // faim ≤ 6 (sur 20) : plus de sprint (mécanique vanilla) → prudence max
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
 * `food` (optionnel, 0-20) : hard = pas de régén sous 18 (REGEN_FOOD) ni de sprint sous 7
 * (CRITICAL_HUNGER). Absent/undefined → comportement STRICTEMENT inchangé (rétro-compat).
 */
function combatDecision({ health, hostileCount, armored, hasCreeper, lavaNear, preferFlee, nearestDist, fleeOnly, capability, food, canDealWith, fightCount, night }) {
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
  // COMBATTRE QUAND ON GÈRE LE NOMBRE (AltoClef MobDefenseChain, 20/10) : canDealWith > hostiles proches
  // ET PV > 8 → on se bat au lieu de fuir — y compris NU (une fuite à pied ratée tuait 93 % du temps,
  // run 10). Passe devant les seuils prudents ci-dessous, jamais devant creeper/lave/fleeOnly/mappeur.
  // `canDealWith` absent → rien ne change (rétro-compat).
  if (boldFightAdvised({ health, fightCount: fightCount != null ? fightCount : hostileCount, canDealWith, food, night })) return 'fight';
  // FAIM (hard, cf. CRITICAL_HUNGER ci-dessus) : ≤6 → sprint coupé, on ne peut plus fuir vite →
  // `armored` forcé à false (seuils prudents) MÊME en armure complète. ≤REGEN_FOOD (régén coupée,
  // reflexes.js) → chaque PV perdu est définitif tant qu'on n'a pas mangé → seuil de fuite basse-
  // santé relevé de NO_REGEN_HP_MARGIN. food absent/undefined → aucun des deux ne s'applique (rétro-compat).
  const critical = food != null && food <= CRITICAL_HUNGER;
  const effectiveArmored = critical ? false : armored;
  const swarm = effectiveArmored === false ? SWARM_UNARMORED : SWARM_COUNT;
  let lowHp = effectiveArmored === false ? LOW_HEALTH_UNARMORED : LOW_HEALTH;
  if (food != null && food <= REGEN_FOOD) lowHp += NO_REGEN_HP_MARGIN;
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

// canDealWith AltoClef (MobDefenseChain) : dégât PLEIN de l'arme (épée bois 4 … netherite 8 ; haches
// comptées comme l'épée du même matériau — plus fortes mais plus lentes) ; sans arme 0.
const ATTACK_DAMAGE = {
  wooden_sword: 4, golden_sword: 4, stone_sword: 5, iron_sword: 6, diamond_sword: 7, netherite_sword: 8,
  wooden_axe: 4, golden_axe: 4, stone_axe: 5, iron_axe: 6, diamond_axe: 7, netherite_axe: 8,
};
const BOLD_MIN_HEALTH = 8;     // PV ≤ 8 → la règle « on gère le nombre » ne s'applique plus
const FIGHT_COUNT_RADIUS = 8;  // hostiles comptés pour canDealWith : non-creeper, ≤ 8 blocs, visibles

/** Dégât plein de la meilleure arme en poche (0 sans arme). (pur, testable) */
function attackDamage(bot) {
  const items = (bot && bot.inventory && typeof bot.inventory.items === 'function') ? bot.inventory.items() : [];
  let best = 0;
  for (const it of items || []) { const d = ATTACK_DAMAGE[it && it.name]; if (d && d > best) best = d; }
  return best;
}
/** canDealWith = ceil(armure*3.6/20 + (1+dégât)*0.8) + 1 — nb de mobs qu'on « gère ». (pur) */
function canDealWith(armorPts, attackDmg) {
  // −1e-9 : 5 × 0.8 vaut 4.000000000000001 en flottant (ceil → 5 au lieu de 4).
  return Math.ceil((armorPts || 0) * 3.6 / 20 + (1 + (attackDmg || 0)) * 0.8 - 1e-9) + 1;
}
/**
 * PUR — combattre plutôt que fuir ? canDealWith > fightCount ≥ 1 ET PV > 8. Jamais en faim critique
 * (≤ CRITICAL_HUNGER : pas de régén, chaque coup encaissé est définitif — on garde la prudence).
 */
const BOLD_MAX_WEAK = 2;
const BOLD_STRONG_CDW = 7;
// NUIT (fix 20/10) : 24/37 morts récentes par zombie. Un combat « gérable » à 20 PV contre 1 zombie se
// poursuivait pendant que d'autres arrivaient (NethBot1, 18:27 UTC). La nuit, au-delà d'1 mob et sous
// 14 PV, plus de témérité : les seuils prudents de combatDecision reprennent la main.
const BOLD_NIGHT_MIN_HEALTH = 14;

/** PUR — nuit d'après bot.time.timeOfDay (même fenêtre que skills/shelter.isNightTime). */
function _isNightTod(tod) {
  if (tod == null || !Number.isFinite(tod)) return false;
  const t = ((tod % 24000) + 24000) % 24000;
  return t >= 12800 && t <= 23200;
}

function boldFightAdvised({ health, fightCount, canDealWith: cdw, food, night } = {}) {
  if (cdw == null || !Number.isFinite(cdw)) return false;
  if (!fightCount || fightCount < 1) return false;
  if (health == null || !(health > BOLD_MIN_HEALTH)) return false;
  if (food != null && food <= CRITICAL_HUNGER) return false;
  // Hard : la formule AltoClef est calibrée pour une difficulté normale. Sans armure (capacité < 7,
  // soit l'épée seule), on n'affronte jamais plus de 2 mobs à la fois.
  if (fightCount > BOLD_MAX_WEAK && cdw < BOLD_STRONG_CDW) return false;
  if (night === true && fightCount > 1 && health < BOLD_NIGHT_MIN_HEALTH) return false;
  return cdw > fightCount;
}

function _d3(a, b) {
  try {
    if (a && typeof a.distanceTo === 'function') return a.distanceTo(b);
    return Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2 + (a.z - b.z) ** 2);
  } catch (e) { return Infinity; }
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
const FIGHT_CHOSEN_EVERY_MS = 10000;   // event `fight_chosen` : au plus 1 / 10 s
let _lastFightChosenAt = -Infinity;
async function survivalTick(bot, deps = {}) {
  const emit = deps.emit || (() => {});
  const now = typeof deps.now === 'function' ? deps.now : Date.now;
  const self = bot.entity && bot.entity.position;
  // CREEPER (AltoClef, 20/10) : un creeper CALME à > 4 blocs n'est ni une raison de fuir ni une cible —
  // il sort de la liste ; gonfle à ≤ 7 ou calme à ≤ 4 → `hasCreeper` (fuite / s'écarter, jamais de mêlée).
  const all = nearbyHostiles(bot, 10);
  let hasCreeper = false;
  const hostiles = [];
  for (const h of all) {
    if (h && h.name === 'creeper') {
      const plan = creeperPlan(h, self);
      if (plan === 'flee' || plan === 'step_away') { hasCreeper = true; hostiles.push(h); }
      continue;
    }
    hostiles.push(h);
  }
  // Lave évaluée seulement s'il y a des hostiles (le scan a un coût) ; injectable pour les tests.
  const lavaNear = hostiles.length ? (deps.lavaNear ? !!deps.lavaNear(bot) : lavaNearby(bot)) : false;
  // distance du plus proche hostile (mode mappeur preferFlee : fight seulement à portée de coup)
  const nearestDist = (hostiles.length && self) ? Math.min(...hostiles.map((h) => _d3(h.position, self))) : null;
  const fleeOnly = hasFleeOnly(hostiles, bot.health);   // wither_skeleton / hoglin bas-PV → jamais de mêlée
  const capability = combatCapability(armorPoints(bot), weaponDamage(bot));   // canDealWith (cautious-only)
  // canDealWith « audacieux » : hostiles non-creeper à ≤ 8 blocs ET visibles (deps.canSee injecté ;
  // absent = visible ; qui lève = invisible).
  const canSee = typeof deps.canSee === 'function' ? deps.canSee : null;
  const fighters = hostiles.filter((h) => h.name !== 'creeper' && self && _d3(h.position, self) <= FIGHT_COUNT_RADIUS &&
    (!canSee || (() => { try { return !!canSee(h); } catch (e) { return false; } })()));
  const cdw = canDealWith(armorPoints(bot), attackDamage(bot));
  const night = _isNightTod(bot.time && bot.time.timeOfDay);
  const decision = combatDecision({ health: bot.health, hostileCount: hostiles.length, armored: isArmored(bot), hasCreeper, lavaNear, preferFlee: !!deps.preferFlee, nearestDist, fleeOnly, capability, food: bot.food, canDealWith: cdw, fightCount: fighters.length, night });
  if (decision === 'flee') {
    try { deps.fleeFrom && deps.fleeFrom(bot); } catch (e) {}
    const ev = { type: 'survival', action: 'flee', hostiles: hostiles.length };
    if (lavaNear) ev.reason = 'lava_near';
    else if (fleeOnly) ev.reason = 'flee_only';
    emit(ev);
    return 'flee';
  }
  if (decision === 'fight') {
    // Jamais le creeper (il n'arrive ici que si `hasCreeper` est faux, mais on ne frappe pas un creeper).
    const target = fighters[0] || hostiles.find((h) => h.name !== 'creeper');
    if (!target) return null;
    if (!deps.preferFlee && boldFightAdvised({ health: bot.health, fightCount: fighters.length, canDealWith: cdw, food: bot.food, night })) {
      const t = now();
      if (t < _lastFightChosenAt || t - _lastFightChosenAt >= FIGHT_CHOSEN_EVERY_MS) {   // horloge reculée → prêt
        _lastFightChosenAt = t;
        emit({ type: 'fight_chosen', canDealWith: cdw, hostiles: fighters.length, health: bot.health });
      }
    }
    const w = bestWeapon(bot);
    if (w) { try { await bot.equip(w, 'hand'); } catch (e) {} }
    try { bot.pvp.attack(target); } catch (e) {}
    emit({ type: 'survival', action: 'fight', target: target.name });
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
  canDealWith, attackDamage, boldFightAdvised, BOLD_MIN_HEALTH, BOLD_NIGHT_MIN_HEALTH, FIGHT_COUNT_RADIUS, ATTACK_DAMAGE,
  SWARM_COUNT, LOW_HEALTH, SWARM_UNARMORED, LOW_HEALTH_UNARMORED, HUNT_HUNGER, EAT_HUNGER, CRITICAL_HUNGER,
  RAW_FOODS, PASSIVE_FOOD_MOBS, NEUTRAL_NO_PROVOKE,
  FLEE_ONLY_ALWAYS, FLEE_ONLY_LOWHP, FLEE_ONLY_LOWHP_THRESHOLD, REGEN_FOOD, NO_REGEN_HP_MARGIN,
};
