'use strict';
// CHASSE À LA FICELLE — le maillon qui manquait à la chaîne de nourriture (run world_mn15, 18/08).
//
// Mesure live : 5 « starved to death » en 10 minutes sur 4 bots BLINDÉS (armure fer complète,
// épées). Ce n'est donc plus un problème de combat, c'est un problème d'ACQUISITION — la chaîne
// était rompue en bout de course :
//     faim → chasse (`no_prey` : la zone est chassée à mort depuis des heures)
//          → pêche  (`no_rod` ×444 : la canne coûte 3 bâtons + 2 FICELLES, il n'y a pas de ficelle)
//          → RIEN.
// La pêche est le seul plan qui ne s'épuise pas, mais sans canne elle n'existe pas ; et la ficelle
// n'a qu'une source : l'ARAIGNÉE. Or elle pullule autour du camp — les bots la tuaient déjà quand
// ils étaient NUS, par pure légitime défense. Maintenant qu'ils sont blindés et armés, aller la
// chercher exprès est le geste le moins risqué de la journée.
//
// Trois règles gravées ici :
//   1. LA SURVIE PRIME, TOUJOURS. Avant d'engager et à chaque battement du combat, on redemande à
//      `combatDecision` : dès qu'elle dit « flee » (creeper, meute, PV bas, faim critique…), on
//      lâche prise. Aucune ficelle ne vaut une explosion.
//   2. JAMAIS `cave_spider` : elle empoisonne, et le poison achève un bot déjà affamé.
//   3. BORNÉ ET ANNULABLE (piège #47d : un but nourriture bloquant stalle à vie). Budget total,
//      délai de mise à mort, compte de proies — et le token coupe tout à n'importe quel moment.
const {
  nearbyHostiles, isArmored, combatDecision, hasFleeOnly, armorPoints, weaponDamage, combatCapability,
} = require('../survival');
const { bestWeapon } = require('../tools');
const { ROD_STRING } = require('./fish');   // 2 : la quantité qui débloque la canne (source unique)

// L'araignée COMMUNE, et elle seule. `cave_spider` est volontairement absente (venin).
const SPIDERS = new Set(['spider']);

/** L'araignée commune la plus proche dans le rayon (null si aucune). Ignore les entités mortes. */
function nearestSpider(bot, radius = 24) {
  const self = bot && bot.entity && bot.entity.position;
  if (!self || typeof bot.nearestEntity !== 'function') return null;
  const e = bot.nearestEntity((x) => x && SPIDERS.has(x.name) && x.position && x.isValid !== false);
  if (!e) return null;
  const d = e.position.distanceTo ? e.position.distanceTo(self) : Infinity;
  return d <= radius ? e : null;
}

/**
 * La survie ordonne-t-elle de décrocher ? Même lecture que `survivalTick` (mêmes seuils, même
 * source), simplement posée en VETO au lieu d'une action : ici c'est le tick de survie et les
 * réflexes qui agissent, on se contente d'abandonner la chasse pour leur laisser la main.
 * `lavaNear` n'est pas scanné (coût) : le tick de survie couvre déjà ce cas globalement.
 */
function _fleeAdvised(bot) {
  try {
    const hostiles = nearbyHostiles(bot, 10);
    if (!hostiles.length) return false;
    return combatDecision({
      health: bot.health,
      hostileCount: hostiles.length,
      armored: isArmored(bot),
      hasCreeper: hostiles.some((h) => h && h.name === 'creeper'),
      fleeOnly: hasFleeOnly(hostiles, bot.health),
      capability: combatCapability(armorPoints(bot), weaponDamage(bot)),
      food: bot.food,
    }) === 'flee';
  } catch (e) { return false; }   // lecture du monde impossible → on ne bloque pas la chasse dessus
}

function _stringCount(bot) {
  let n = 0;
  for (const it of ((bot.inventory && bot.inventory.items()) || [])) {
    if (it && it.name === 'string') n += (it.count || 0);
  }
  return n;
}

/**
 * huntSpiders(bot, deps, opts) → { ok, strings, kills, reason }
 *
 * deps (injectés — aucune dépendance à index.js) :
 *   loot(o)  : balayage du butin (lootNearby d'index.js). Sans lui, repli sur `goto` + attente.
 *   goto(p)  : déplacement borné (repli de ramassage).
 *   emit(e)  : télémétrie — UN seul `string_hunt` par tentative.
 *   sleep(ms): temporisation (injectable pour les tests).
 *   now()    : horloge (injectable pour les tests).
 *   shouldAbort(bot) : surcharge du veto de survie.
 *
 * opts : { count=2, maxDistance=24, totalMs=60000, targetStrings=ROD_STRING, killTimeoutMs=20000,
 *          pollMs=250, lootRadius=8, lootMs=12000, token }
 *
 * `ok` = « on ramène de la FICELLE » (strings > 0) — pas « on a tué des araignées » : c'est la
 * ficelle, pas le cadavre, qui débloque la pêche. `reason` dit toujours pourquoi on s'est arrêté :
 * 'target' (assez de ficelle) | 'count' (quota de proies atteint) | 'no_spider' | 'kill_timeout'
 * | 'flee' | 'timeout' | 'cancelled' | 'no_pvp'.
 */
async function huntSpiders(bot, deps = {}, opts = {}) {
  const count = opts.count != null ? opts.count : 2;
  const maxDistance = opts.maxDistance != null ? opts.maxDistance : 24;
  const totalMs = opts.totalMs != null ? opts.totalMs : 60000;
  const targetStrings = opts.targetStrings != null ? opts.targetStrings : ROD_STRING;
  const killTimeoutMs = opts.killTimeoutMs != null ? opts.killTimeoutMs : 20000;
  const pollMs = opts.pollMs != null ? opts.pollMs : 250;
  const lootRadius = opts.lootRadius != null ? opts.lootRadius : 8;
  const lootMs = opts.lootMs != null ? opts.lootMs : 12000;
  const token = opts.token || null;

  const emit = deps.emit || (() => {});
  const sleep = deps.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const now = deps.now || (() => Date.now());
  const shouldAbort = deps.shouldAbort || _fleeAdvised;

  const before = _stringCount(bot);
  let kills = 0;
  const t0 = now();
  const left = () => totalMs - (now() - t0);
  const cancelled = () => !!(token && token.cancelled);

  // Sortie UNIQUE : tout retour passe par ici, donc toute tentative laisse EXACTEMENT une trace.
  // Un échec silencieux finit toujours par cacher un bug pendant des runs entiers (#55a).
  const done = (reason) => {
    try { bot.pvp && bot.pvp.stop(); } catch (e) {}
    const strings = Math.max(0, _stringCount(bot) - before);
    try { emit({ type: 'string_hunt', kills, strings, reason }); } catch (e) {}
    return { ok: strings > 0, strings, kills, reason };
  };

  if (cancelled()) return done('cancelled');
  if (!bot || !bot.pvp || typeof bot.pvp.attack !== 'function') return done('no_pvp');

  for (let i = 0; i < count; i++) {
    if (cancelled()) return done('cancelled');
    if (left() <= 0) return done('timeout');
    if (shouldAbort(bot)) return done('flee');

    const prey = nearestSpider(bot, maxDistance);
    if (!prey) return done('no_spider');

    // ÉPÉE AVANT LE PREMIER COUP : au poing c'est 1 dégât contre 5, et le bot garde en main la
    // pioche du minage si on ne le lui dit pas (cause des 235 combats menés au poing, #54c).
    const w = bestWeapon(bot);
    if (w) { try { await bot.equip(w, 'hand'); } catch (e) { /* désync : on frappe quand même */ } }

    let last = prey.position;
    try { bot.pvp.attack(prey); } catch (e) {}

    const deadline = now() + Math.min(killTimeoutMs, Math.max(0, left()));
    while (prey.isValid && now() < deadline) {
      if (cancelled()) return done('cancelled');
      if (shouldAbort(bot)) return done('flee');   // la meute arrive EN PLEIN combat → on lâche
      if (prey.position) last = prey.position;      // l'araignée bouge : on suit son point de mort
      await sleep(pollMs);
    }
    try { bot.pvp.stop(); } catch (e) {}
    if (prey.isValid) return done('kill_timeout');  // pas tuée → on n'insiste pas (pas d'acharnement)
    kills++;

    // LE BUTIN, SINON RIEN : `bot.pvp` ne ramasse pas. Une araignée tuée dont on laisse la ficelle
    // au sol n'a servi à rien — c'est exactement le trou qui laissait `no_rod` éternel.
    try {
      if (deps.loot) await deps.loot({ radius: lootRadius, maxItems: 4, budgetMs: lootMs });
      else if (deps.goto && last) { await deps.goto({ x: last.x, y: last.y, z: last.z }); await sleep(pollMs); }
    } catch (e) { /* best-effort : un drop inatteignable ne fait pas tomber la chasse */ }

    if (_stringCount(bot) - before >= targetStrings) return done('target');
  }
  return done('count');
}

module.exports = { huntSpiders, nearestSpider, SPIDERS };
