'use strict';
// Chasse de mobs PASSIFS pour se nourrir (kit de survie) : tue jusqu'à `count` proies proches
// (meilleure arme équipée), attend la mort (borné), va ramasser les drops sur place.
// N'engage JAMAIS un hostile ici (la défense est gérée par survival.js/reflexes).
//
// 22/10 (chrono de 61 min : 5× `no_prey:hunt_failed`, chacun = 20 s perdues) : la proie était confiée
// d'emblée à mineflayer-pvp, qui la suit avec SES propres Movements et un délai de 20 s — une vache à
// 40 blocs derrière un ruisseau n'était jamais rattrapée, et un seul échec terminait la sortie alors que
// trois autres bêtes broutaient à côté. Comme un joueur : on MARCHE d'abord jusqu'à la bête (pathfinder,
// nos Movements, borné), on ne frappe qu'une fois au contact, et une bête ratée est écartée pour la
// sortie — on passe à la suivante (au plus `maxFails` ratés).
const { bestWeapon } = require('../tools');
const { isReachablePrey } = require('../huntReach');
const { FOOD_POINTS } = require('../food');
let pfGoals; try { pfGoals = require('mineflayer-pathfinder').goals; } catch (e) { pfGoals = null; }

const APPROACH_NEAR = 3.5;          // assez près pour frapper (portée de mêlée ≈ 3)
// En deçà, mineflayer-pvp finit la poursuite lui-même (il l'a toujours fait, et son délai suffit) ;
// au-delà, c'est nous qui marchons — c'est là que les `hunt_failed` de 20 s naissaient.
const APPROACH_DIRECT = 16;
const APPROACH_MS = 30000;          // une bête à 96 blocs ≈ 20 s de marche ; au-delà on la laisse
const APPROACH_LEG_MS = 10000;      // la bête bouge : on re-vise sa position toutes les 10 s au plus
const KILL_TIMEOUT_MS = 15000;      // au contact, 3-4 coups suffisent ; 15 s = elle a fui

function _dist(bot, e) {
  const s = bot.entity && bot.entity.position;
  if (!s || !e || !e.position) return Infinity;
  if (typeof e.position.distanceTo === 'function') return e.position.distanceTo(s);
  return Math.hypot(e.position.x - s.x, e.position.y - s.y, e.position.z - s.z);
}

/** La proie la plus proche, hors bêtes ratées pendant cette sortie (`avoid` = Set d'entités). */
function _pickPrey(bot, { radius, names, avoid }) {
  const self = bot.entity && bot.entity.position;
  if (!self || typeof bot.nearestEntity !== 'function') return null;
  const e = bot.nearestEntity((x) => !avoid.has(x)
    && isReachablePrey(x, self, { radius: Infinity, names: Array.isArray(names) && names.length ? names : null }));
  if (!e) return null;
  return _dist(bot, e) <= radius ? e : null;
}

/**
 * Marche jusqu'à la bête : jambes de ≤ 10 s re-visées sur sa position (elle broute, elle fuit), jeton
 * relu à 4 Hz. → true au contact, false sinon (perdue, NoPath répété, délai, tâche annulée).
 * Sans pathfinder (tests anciens, bot partiel) : true — mineflayer-pvp la suivra, comme avant.
 */
async function _approach(bot, prey, token, ms) {
  if (!pfGoals || !bot.pathfinder || typeof bot.pathfinder.goto !== 'function') return true;
  // Tout près, mineflayer-pvp la rattrape seul (comportement historique, inchangé).
  if (_dist(bot, prey) <= APPROACH_DIRECT) return true;
  const t0 = Date.now();
  let errors = 0;
  while (Date.now() - t0 < ms) {
    if ((token && token.cancelled) || prey.isValid === false) return false;
    const d0 = _dist(bot, prey);
    if (d0 <= APPROACH_NEAR) return true;
    const p = prey.position;
    const legMs = Math.min(APPROACH_LEG_MS, ms - (Date.now() - t0));
    let poll = null;
    let failed = false;
    try {
      const leg = bot.pathfinder.goto(new pfGoals.GoalNear(p.x, p.y, p.z, 2));
      // Le setGoal(null) du sondeur fait rejeter ce goto APRÈS la course : jamais de rejet orphelin.
      if (leg && typeof leg.catch === 'function') leg.catch(() => {});
      await Promise.race([
        leg,
        new Promise((resolve) => {
          const tl = Date.now();
          poll = setInterval(() => {
            if ((token && token.cancelled) || prey.isValid === false || Date.now() - tl >= legMs || _dist(bot, prey) <= APPROACH_NEAR) {
              try { bot.pathfinder.setGoal(null); } catch (e) {}
              resolve();
            }
          }, 250);
        }),
      ]);
    } catch (e) { failed = true; }
    finally { if (poll) clearInterval(poll); }
    const d1 = _dist(bot, prey);
    if (d1 <= APPROACH_DIRECT && !failed) return true;     // à portée de pvp : il finit la poursuite
    // Deux jambes de suite sans se rapprocher (NoPath, ou un goto qui « réussit » sur place) : la bête
    // est derrière l'eau / sur une île. On la laisse.
    if (d1 >= d0 - 1) { if (++errors >= 2) return false; } else errors = 0;
  }
  return _dist(bot, prey) <= APPROACH_DIRECT;
}

// COMPTAGE HONNÊTE (25/10, monde de 8 h : `food_trip_done {arrived:true, kills:4, got:0}`) : un « kill »
// était compté dès que `prey.isValid` tombait à faux — or une entité devient invalide AUSSI quand elle
// sort de la portée de suivi du serveur (entity_destroy sans mort). Quatre « kills », zéro viande, et le
// troupeau (périmé) n'était jamais oublié parce que l'expédition « avait tué ». Désormais, sur un vrai
// bot (émetteur d'événements), une proie disparue ne compte que si sa MORT a été vue (`entityDead`) ou
// si la nourriture en poche a augmenté ; sinon c'est une proie PERDUE (`lost`, comptée en échec).
// Bot sans `on` (doublures des tests anciens) : comportement historique.

/** Pièces comestibles en poche (FOOD_POINTS) — 0 si l'inventaire est illisible. */
function _foodCount(bot) {
  try {
    const items = (bot.inventory && typeof bot.inventory.items === 'function') ? bot.inventory.items() : [];
    let n = 0;
    for (const it of items || []) {
      if (it && typeof it.name === 'string' && Object.prototype.hasOwnProperty.call(FOOD_POINTS, it.name)) n += Number(it.count) || 0;
    }
    return n;
  } catch (e) { return 0; }
}

/**
 * PUR — verdict sur une proie qui n'est plus valide.
 * s = { tracked: bool (on écoute entityDead), died: bool, foodBefore, foodAfter }
 * → 'kill' | 'lost'
 */
function preyOutcome(s = {}) {
  if (!s.tracked) return 'kill';                                   // historique : pas d'événement à lire
  if (s.died) return 'kill';
  if ((Number(s.foodAfter) || 0) > (Number(s.foodBefore) || 0)) return 'kill';
  return 'lost';                                                    // sortie de portée, pas une mort
}

/**
 * huntPassive(bot, {count, maxDistance, names, maxFails}, token, deps) → {ok, kills, fails}
 * deps : sleep, goto (ramassage), approach(prey,{ms,token})→bool, killTimeoutMs, approachMs, pickupMs.
 * `names` (optionnel) : ne chasser QUE ces espèces (ex. ['sheep'] pour la laine du lit, cf. bed.js).
 */
async function huntPassive(bot, { count = 1, maxDistance = 32, names = null, maxFails = 2 } = {}, token = null, deps = {}) {
  const sleep = deps.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const killTimeoutMs = deps.killTimeoutMs || KILL_TIMEOUT_MS;
  const approachMs = deps.approachMs || APPROACH_MS;
  const avoid = new Set();
  let kills = 0;
  let fails = 0;
  let lost = 0;
  const tracked = typeof bot.on === 'function';
  const dead = new Set();
  const onDead = (e) => { try { dead.add(e); } catch (err) {} };
  if (tracked) { try { bot.on('entityDead', onDead); } catch (e) {} }
  try {
  while (kills < count && fails < maxFails) {
    if (token && token.cancelled) break;
    const prey = _pickPrey(bot, { radius: maxDistance, names, avoid });
    if (!prey) break;                                       // plus de proie → on rend ce qu'on a
    const near = deps.approach
      ? await deps.approach(prey, { ms: approachMs, token })
      : await _approach(bot, prey, token, approachMs);
    if (token && token.cancelled) break;
    if (!near) { avoid.add(prey); fails++; continue; }      // injoignable : la suivante
    const w = bestWeapon(bot);
    if (w) { try { await bot.equip(w, 'hand'); } catch (e) {} }
    let last = prey.position;
    const food0 = _foodCount(bot);
    try { bot.pvp.attack(prey); } catch (e) {}
    const t0 = Date.now();
    while (prey.isValid && Date.now() - t0 < killTimeoutMs) {
      if (token && token.cancelled) break;
      if (prey.position) last = prey.position;              // suivre la proie (elle fuit)
      await sleep(250);
    }
    try { bot.pvp.stop(); } catch (e) {}
    if (token && token.cancelled) break;
    if (prey.isValid) { avoid.add(prey); fails++; continue; } // enfuie : on n'insiste pas sur CELLE-LÀ
    // Disparue sans mort vue : sortie de portée de suivi. Pas de ramassage (rien n'est tombé), pas de kill.
    if (tracked && !dead.has(prey) && preyOutcome({ tracked, died: false, foodBefore: food0, foodAfter: _foodCount(bot) }) === 'lost') {
      avoid.add(prey); fails++; lost++; continue;
    }
    kills++;
    // ramasser les drops : aller sur le lieu de mort (pickup automatique au contact)
    try {
      if (deps.goto) await deps.goto(last);
      else if (pfGoals && bot.pathfinder && bot.pathfinder.goto) {
        await bot.pathfinder.goto(new pfGoals.GoalNear(last.x, last.y, last.z, 1));
      }
    } catch (e) { /* drops perdus → tant pis, proie suivante */ }
    await sleep(deps.pickupMs != null ? deps.pickupMs : 800);
  }
  } finally {
    if (tracked) { try { (bot.removeListener || bot.off).call(bot, 'entityDead', onDead); } catch (e) {} }
  }
  const out = { ok: kills > 0, kills, fails };
  if (lost > 0) out.lost = lost;                            // champ AJOUTÉ seulement quand il dit quelque chose
  return out;
}

module.exports = { huntPassive, preyOutcome, APPROACH_NEAR, APPROACH_MS, KILL_TIMEOUT_MS };
