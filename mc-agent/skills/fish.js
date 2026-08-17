'use strict';
// PÊCHE — la source de nourriture qui ne s'épuise pas.
//
// Constat live : les bots meurent de faim en série (20+ « starved to death » en 3 h de run) alors
// que leur SEUL plan nourriture est la chasse (`huntCook`). Or la chasse échoue à 100 % (`no_prey`)
// dès que la zone est vidée de ses animaux — et elle se vide vite, parce que les bots y tournent
// des heures. La pêche répare exactement ce trou : le poisson ne s'épuise pas, il ne fuit pas, il
// ne rend pas les coups, et il mord aussi bien de nuit qu'en plein jour.
//
// `bot.fish()` est NATIF mineflayer (plugin `fishing`, chargé d'office par le loader) : zéro
// nouvelle dépendance npm.
//
// Deux règles gravées ici :
//   1. LE BOT NE RENTRE JAMAIS DANS L'EAU. Il pêche depuis la berge. La noyade est le premier
//      tueur du projet (118 sauvetages `water_rescue` sur un seul run) ; il serait absurde
//      d'introduire une compétence qui envoie le bot à l'eau volontairement.
//   2. C'EST UN OUTIL BORNÉ, PAS UN BUT BLOQUANT (piège #47d : un but nourriture bloquant stalle
//      à vie). Tout est plafonné — nombre de prises, temps par prise, temps total — et annulable.
//      `bot.fish()` ne se résout QUE sur les particules de touche : bouchon posé sur la terre
//      ferme, désync, chunk déchargé → la promesse ne se règle JAMAIS (piège #41d). D'où la
//      course contre une horloge à CHAQUE lancer, sans exception.

// Vrai Vec3 pour bot.blockAt/lookAt (leçon dcd874d : un POJO nu fait throw `.floored()`).
let vec3; try { vec3 = require('vec3'); } catch (e) { vec3 = null; }
function _at(x, y, z) { return vec3 ? vec3(x, y, z) : { x, y, z }; }

// Recette vanilla de la canne : 3 bâtons + 2 ficelles, en 3×3 (donc table requise — c'est
// `deps.craft` (craftSmart) qui gère la table portable, on ne la réimplémente pas ici).
const ROD_STICKS = 3;
const ROD_STRING = 2;

const WATER_NAMES = new Set(['water', 'flowing_water', 'seagrass', 'tall_seagrass', 'kelp', 'kelp_plant', 'bubble_column']);
const AIR_NAMES = new Set(['air', 'cave_air', 'void_air']);

// ─── Décisions PURES ────────────────────────────────────────────────────────────────────────────

/**
 * PUR — que faut-il pour tenir une canne à pêche ?
 * @param {Array<{name,count}>} inventory
 * @returns {{have:true} | {craft:true} | {missing:{sticks:number, string:number}}}
 * `missing` est le DÉFICIT (ce qu'il reste à trouver), pas le coût total : l'appelant peut
 * l'afficher tel quel ou l'enchaîner sur une récolte (bois → bâtons, araignées → ficelle).
 */
function rodPlan(inventory) {
  let rods = 0, sticks = 0, string = 0;
  for (const it of inventory || []) {
    if (!it || !it.name) continue;
    const n = it.count || 0;
    if (it.name === 'fishing_rod') rods += n;
    else if (it.name === 'stick') sticks += n;
    else if (it.name === 'string') string += n;
  }
  if (rods > 0) return { have: true };
  if (sticks >= ROD_STICKS && string >= ROD_STRING) return { craft: true };
  return {
    missing: {
      sticks: Math.max(0, ROD_STICKS - sticks),
      string: Math.max(0, ROD_STRING - string),
    },
  };
}

const _key = (x, y, z) => `${x},${y},${z}`;
// Les 4 voisins horizontaux : une berge est toujours à côté, jamais au-dessus ni en dessous.
const _SIDES = [[1, 0], [-1, 0], [0, 1], [0, -1]];

/**
 * PUR — élit le poste de pêche : un bloc où SE TENIR, adjacent à l'eau, jamais dans l'eau.
 *
 * @param {Array<{x,y,z}>} candidates positions des blocs d'EAU repérés (surface de préférence)
 * @param {{x,y,z}} botPos
 * @param {{isStandable?:(pos)=>boolean}} opts `isStandable` = la seule interrogation du monde,
 *        injectée par l'appelant (sol solide + place pour le corps). Défaut permissif : la
 *        fonction reste utilisable/testable sans client MC.
 * @returns {{x,y,z,water:{x,y,z}} | null} le poste le plus PROCHE du bot (coordonnées des pieds),
 *          avec la case d'eau qu'il vise ; null si aucune berge praticable.
 *
 * Deux niveaux sont proposés pour chaque côté : au niveau de l'eau (berge de plain-pied) et un
 * cran au-dessus (rive en surplomb, cas le plus courant — l'herbe est au-dessus du plan d'eau).
 * Une colonne d'eau est écartée aux DEUX niveaux : s'y tenir, c'est être dans l'eau ; se tenir
 * au-dessus, c'est flotter dessus. Cette exclusion-là est PURE (on connaît l'ensemble des cases
 * d'eau), elle ne dépend pas du prédicat — donc elle tient même sans interrogation du monde.
 */
function pickFishingSpot(candidates, botPos, opts = {}) {
  const list = candidates || [];
  if (!list.length || !botPos) return null;
  const isStandable = opts.isStandable || (() => true);

  const waters = [];
  const wet = new Set();
  for (const c of list) {
    if (!c) continue;
    const w = { x: Math.floor(c.x), y: Math.floor(c.y), z: Math.floor(c.z) };
    waters.push(w);
    wet.add(_key(w.x, w.y, w.z));
  }

  let best = null, bestD = Infinity;
  for (const w of waters) {
    for (const [dx, dz] of _SIDES) {
      const bx = w.x + dx, bz = w.z + dz;
      if (wet.has(_key(bx, w.y, bz))) continue;          // colonne d'eau : ni dedans, ni dessus
      for (const by of [w.y, w.y + 1]) {
        const stand = { x: bx, y: by, z: bz };
        if (!isStandable(stand)) continue;
        const d = Math.hypot(bx - botPos.x, by - botPos.y, bz - botPos.z);
        if (d < bestD) { bestD = d; best = { x: bx, y: by, z: bz, water: { x: w.x, y: w.y, z: w.z } }; }
      }
    }
  }
  return best;
}

// ─── Lecture du monde (petits helpers, non exportés) ────────────────────────────────────────────

function _isWater(b) { return !!b && WATER_NAMES.has(b.name); }
/** Traversable ET sec : ni eau, ni lave, ni bloc plein. `null` (chunk absent) = non (prudence). */
function _passable(b) {
  if (!b) return false;
  if (_isWater(b) || b.name === 'lava') return false;
  return AIR_NAMES.has(b.name) || b.boundingBox === 'empty';
}
/** Sol porteur : un vrai bloc plein, sec. */
function _solid(b) {
  return !!b && b.boundingBox === 'block' && !_isWater(b) && b.name !== 'lava';
}
function _blockAt(bot, x, y, z) {
  try { return bot.blockAt(_at(x, y, z)); } catch (e) { return null; }
}
/** Le bot peut-il TENIR ici ? pieds + tête libres et secs, sol solide dessous. */
function _standable(bot, p) {
  return _passable(_blockAt(bot, p.x, p.y, p.z))
    && _passable(_blockAt(bot, p.x, p.y + 1, p.z))
    && _solid(_blockAt(bot, p.x, p.y - 1, p.z));
}
/** Eau de SURFACE : de l'air juste au-dessus, sinon le bouchon n'a nulle part où flotter. */
function _isSurfaceWater(bot, w) {
  return _passable(_blockAt(bot, w.x, w.y + 1, w.z));
}

/**
 * Course contre l'horloge qui ne rejette JAMAIS et ne laisse jamais de minuterie en vie.
 * → {ok:true} | {timedOut:true} | {error}
 */
function _bounded(makePromise, ms) {
  let p;
  try { p = makePromise(); } catch (e) { return Promise.resolve({ error: e }); }
  return new Promise((resolve) => {
    let done = false;
    const t = setTimeout(() => { if (!done) { done = true; resolve({ timedOut: true }); } }, ms);
    Promise.resolve(p).then(
      () => { if (!done) { done = true; clearTimeout(t); resolve({ ok: true }); } },
      (e) => { if (!done) { done = true; clearTimeout(t); resolve({ error: e || new Error('rejected') }); } },
    );
  });
}

// ─── Le skill ───────────────────────────────────────────────────────────────────────────────────

/**
 * fishCatch(bot, deps, opts) → { ok, caught, reason }
 *
 * deps (fonctions injectées — aucune dépendance à index.js) :
 *   craft(args)  : craftSmart d'index.js (gère la table portable). Sans lui, pas de fabrication.
 *   goto(pos)    : déplacement borné. Sans lui, on pêche d'où l'on est (best-effort).
 *   emit(event)  : télémétrie.
 *   sleep(ms)    : temporisation (injectable pour les tests).
 *   pickSpot(...): surcharge de l'élection du poste (tests / stratégies).
 *
 * opts : { target=4, perCatchMs=45000, totalMs=180000, token, maxDistance=24,
 *          maxMisses=2, gotoMs=60000, recastMs=600 }
 *
 * `ok` = « on ramène du poisson » (caught > 0) — comme `huntPassive`, une prise partielle nourrit.
 * `reason` dit toujours POURQUOI on s'est arrêté : 'target' | 'timeout' | 'cancelled' | 'no_bite'
 * | 'rod_lost' | 'no_rod' | 'no_water' | 'no_spot' | 'unreachable' | 'no_fish_api'.
 */
async function fishCatch(bot, deps = {}, opts = {}) {
  const target = opts.target != null ? opts.target : 4;
  const perCatchMs = opts.perCatchMs != null ? opts.perCatchMs : 45000;
  const totalMs = opts.totalMs != null ? opts.totalMs : 180000;
  const maxDistance = opts.maxDistance != null ? opts.maxDistance : 24;
  const maxMisses = opts.maxMisses != null ? opts.maxMisses : 2;
  const gotoMs = opts.gotoMs != null ? opts.gotoMs : 60000;
  const recastMs = opts.recastMs != null ? opts.recastMs : 600;
  const token = opts.token || null;

  const emit = deps.emit || (() => {});
  const sleep = deps.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const pickSpot = deps.pickSpot || pickFishingSpot;

  let caught = 0;
  // Sortie UNIQUE : tout retour passe par ici, donc tout run laisse une trace. Un échec silencieux
  // finit toujours par cacher un bug pendant des runs entiers (#55a : mourir de faim avec 64
  // steaks en poche parce qu'un `.catch(()=>{})` avalait l'échec de `equip`).
  const done = (reason, extra) => {
    try { emit(Object.assign({ type: 'fish', action: 'done', caught, reason }, extra || {})); } catch (e) {}
    return Object.assign({ ok: caught > 0, caught, reason }, extra || {});
  };
  const cancelled = () => !!(token && token.cancelled);

  if (cancelled()) return done('cancelled');
  if (!bot || typeof bot.fish !== 'function') return done('no_fish_api');

  // 1) LA CANNE ────────────────────────────────────────────────────────────────────────────────
  const inv = () => ((bot.inventory && bot.inventory.items()) || []);
  const rodItem = () => inv().find((i) => i && i.name === 'fishing_rod' && (i.count || 0) > 0);
  const equipRod = async () => {
    const rod = rodItem();
    if (!rod) return false;
    try { await bot.equip(rod, 'hand'); } catch (e) { /* désync : on tente la ligne quand même */ }
    return true;
  };

  let plan = rodPlan(inv());
  if (plan.craft) {
    if (!deps.craft) return done('no_rod', { missing: { sticks: 0, string: 0 } });
    emit({ type: 'fish', action: 'craft_rod' });
    try { await deps.craft({ name: 'fishing_rod', count: 1 }); } catch (e) { /* best-effort */ }
    plan = rodPlan(inv());
  }
  if (!plan.have) return done('no_rod', plan.missing ? { missing: plan.missing } : undefined);
  await equipRod();

  // 2) L'EAU ───────────────────────────────────────────────────────────────────────────────────
  const ids = [];
  const byName = (bot.registry && bot.registry.blocksByName) || {};
  for (const n of ['water', 'flowing_water']) if (byName[n]) ids.push(byName[n].id);
  if (!ids.length) return done('no_water');

  let found = [];
  try { found = bot.findBlocks({ matching: ids, maxDistance, count: 64 }) || []; }
  catch (e) { found = []; }
  // Seule l'eau à ciel ouvert vaut un lancer. Une nappe coiffée de roche (aquifère de tunnel)
  // n'est pas un coin de pêche, c'est une noyade en attente.
  const waters = [];
  for (const p of found) {
    if (!p) continue;
    const w = { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) };
    if (_isSurfaceWater(bot, w)) waters.push(w);
  }
  if (!waters.length) return done('no_water');
  if (cancelled()) return done('cancelled');

  // 3) LA BERGE ────────────────────────────────────────────────────────────────────────────────
  const me = (bot.entity && bot.entity.position) || null;
  const spot = pickSpot(waters, me, { isStandable: (p) => _standable(bot, p) });
  if (!spot) return done('no_spot');
  emit({ type: 'fish', action: 'spot', x: spot.x, y: spot.y, z: spot.z });

  if (deps.goto) {
    const trip = await _bounded(() => deps.goto({ x: spot.x, y: spot.y, z: spot.z }), gotoMs);
    if (!trip.ok) return done('unreachable');
    if (cancelled()) return done('cancelled');
  }

  // 4) LA LIGNE ────────────────────────────────────────────────────────────────────────────────
  const aim = _at(spot.water.x + 0.5, spot.water.y + 0.5, spot.water.z + 0.5);
  const t0 = Date.now();
  let misses = 0;
  let recovered = false;          // le rattrapage « canne cassée » ne sert QU'UNE fois

  while (caught < target) {
    if (cancelled()) return done('cancelled');
    const left = totalMs - (Date.now() - t0);
    if (left <= 0) return done('timeout');

    // Visée INTERPOLÉE (`force` false) : un snap-aim instantané est un tell de bot (#44), et la
    // rotation est de toute façon bornée — `look` non forcé s'étale sur plusieurs ticks et pourrait
    // traîner sur un serveur qui rame. Un échec de visée n'empêche pas de lancer.
    await _bounded(() => bot.lookAt(aim, false), 3000);

    const cast = await _bounded(() => bot.fish(), Math.min(perCatchMs, left));

    if (cast.ok) {
      caught++;
      misses = 0;
      emit({ type: 'fish', action: 'caught', caught });
      if (caught >= target) return done('target');
      if (recastMs) await sleep(recastMs);
      continue;
    }

    if (cast.timedOut) {
      // Ça ne mord pas (ou le bouchon n'est jamais tombé à l'eau). On rembobine — `activateItem`
      // relance/annule le lancer en cours — et on ne s'entête pas : deux lancers morts d'affilée
      // veulent dire que le poste ne vaut rien, pas qu'il faut attendre plus longtemps.
      try { bot.activateItem(); } catch (e) {}
      misses++;
      emit({ type: 'fish', action: 'miss', misses });
      if (misses >= maxMisses) return done('no_bite');
      continue;
    }

    // La canne s'use (64 usages) : elle CASSE en pleine session, et `bot.fish()` rejette.
    // On revérifie l'inventaire UNE fois — une seconde canne en poche relance la partie ;
    // sinon on rend la main proprement, avec le poisson déjà pêché.
    if (recovered) return done('rod_lost');
    recovered = true;
    emit({ type: 'fish', action: 'rod_check' });
    const again = rodPlan(inv());
    if (!again.have || !(await equipRod())) return done('rod_lost');
  }

  return done('target');
}

module.exports = { rodPlan, pickFishingSpot, fishCatch, ROD_STICKS, ROD_STRING, WATER_NAMES };
