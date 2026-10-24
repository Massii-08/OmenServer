'use strict';
// Branch mining déterministe à Y target (-54 par défaut, juste au-dessus de la nappe de lave
// du diamant — cf. spec §3). Tunnel principal 1×2 + branches latérales 1×2 espacées de
// `branchSpacing` blocs. Anti-lave : sondage 6-voisins avant chaque dig ; lave détectée → murage
// avec cobblestone/cobbled_deepslate (réserve ≥8 sinon `cobble_low`). Opportuniste : tout ore
// quota (diamant/fer/or/redstone/lapis/charbon/cuivre/émeraude) visible dans le voisinage du
// bloc miné est ramassé via gather (collectBlock).
//
// PHASE 3 (vitesse) :
//  - la ROCHE NUE est minée via bot.dig DIRECT (pas collectBlock : son pathfinding vers chaque
//    drop doublait le temps par bloc — le bot ramasse les drops en avançant dans le tunnel) ;
//  - equip avec CACHE (on ne ré-équipe pas l'outil déjà en main : ~50-100 ms/bloc économisés) ;
//  - `opts.stopOre {items, count}` : arrêt sur DELTA d'items récoltés depuis le début du call
//    (mode quota : le bot PORTE déjà des diamants — l'ancien stop `diamond >= 1` absolu rendait
//    branchMine inutilisable après le 1er diamant → tout venait des cibles mappées lointaines) ;
//  - `opts.heading {dx,dz}` : cap imposé par l'appelant (persistance entre calls → le tunnel
//    CONTINUE tout droit au lieu de repartir dans une direction aléatoire et se recroiser) ;
//  - `opts.torchEvery` : pose une torche au sol tous les N paliers du tunnel principal
//    (mob-aware, phase B — best-effort : sans torche en poche, on continue sans).
//
// /!\ Important : avant chaque paire de digs (foot+head), on appelle pathfinder.goto pour
// s'APPROCHER de la cible (GoalNear range 3). Sans ça, le bot reste à la position de départ et
// dès que i≥6-7 le bloc cible est hors range mineflayer (~6 blocs) → bot.dig échoue silencieusement
// → stall (risque #5 du rapport build précédent).
const { bestToolFor, canHarvestWith } = require('../tools');
const { cheapestPickFor } = require('../gear');
const { assessDrop, safeToDrop } = require('./fallCheck');
const { gather } = require('./gather');
const lawnMine = require('../lawnMine');
const { Vec3 } = require('vec3');
let _emit; try { _emit = require('../io').emit; } catch (e) { _emit = () => {}; }
function dbg(_label, payload) { try { _emit({ type: 'dbg', from: 'branchMine', ...payload }); } catch (e) {} }

// Pathfinder.goals — utilisé uniquement pour le DÉPLACEMENT entre digs. Charge optionnelle (tests).
let goals;
try { goals = require('mineflayer-pathfinder').goals; } catch (e) { goals = null; }
function buildNearGoal(x, y, z, range = 3) {
  if (goals && goals.GoalNear) return new goals.GoalNear(x, y, z, range);
  return { x, y, z };
}

// Borne un await : RÉSOUT (ne rejette jamais) après ms si la promesse n'a pas tranché. Sert à
// éviter qu'un pathfinder.goto reste suspendu indéfiniment au milieu d'une branche (hole E :
// goto sans timeout = hang éternel → quota figé toute la nuit). Le timer N'EST PAS unref() :
// quand la vraie promesse ne se résout JAMAIS (le cas même qu'on garde), il doit maintenir
// l'event-loop en vie le temps de tirer et résoudre ; clearTimeout dès que la promesse tranche.
function withTimeout(promise, ms) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    const timer = setTimeout(() => finish({ timedOut: true }), ms);
    Promise.resolve(promise).then((v) => { clearTimeout(timer); finish(v); },
      () => { clearTimeout(timer); finish({ rejected: true }); });
  });
}

// Stoppe au mieux le mouvement du bot (après un timeout d'approche) : coupe le goal pathfinder
// puis remet à zéro les control states qui pourraient laisser le bot dériver.
function stopMotion(bot) {
  try { if (bot.pathfinder && bot.pathfinder.setGoal) bot.pathfinder.setGoal(null); } catch (e) {}
  if (typeof bot.setControlState === 'function') {
    for (const c of ['forward', 'back', 'left', 'right', 'jump', 'sneak']) {
      try { bot.setControlState(c, false); } catch (e) {}
    }
  }
}

// Rapproche le bot d'une cible avant le dig. Si le pathfinder est indisponible (tests sans mock),
// no-op silencieux. Si la cible est inaccessible, on ne fait pas échouer : le dig direct prendra
// le relais et échouera proprement avec dig_failed si vraiment hors range. Le goto est BORNÉ
// (opts.approachTimeoutMs, déf 20s) : sur timeout on coupe le mouvement et on rend la main.
// INSTRUMENTATION OOM (23/10) : ~85 sessions mortes « heap out of memory » pendant une approche du
// serpentin, sans le moindre event. `bm_approach` borne chaque goto (start/end, durée, timeout) et la
// phase courante est lisible par l'échantillonneur de heap d'index.js (`currentPhase()`).
// VIE PÉRIMÉE / DÉPLACÉ (23/10, NethBot1 13:45 et NethBot2 13:56 UTC : `bm_approach` vers la galerie qui
// venait de tuer le bot, ~120 blocs depuis le point de réapparition). `opts.isStale()` vrai → aucun goto
// (la vie qui a lancé ce serpentin est finie). `opts.maxApproachDist` (posé par branchMine seulement : les
// cibles du serpentin sont toujours voisines du bot) → une cible plus loin que ça veut dire que le bot a
// été téléporté/réapparu : aucun goto, `opts.onDisplaced(dist)` prévient la boucle. Rend { stale } /
// { displaced } (undefined sinon, comportement historique).
function _isStale(opts) {
  if (!opts || typeof opts.isStale !== 'function') return false;
  try { return !!opts.isStale(); } catch (e) { return false; }
}
async function approach(bot, target, range = 3, opts = null) {
  if (!bot.pathfinder || !bot.pathfinder.goto) return;
  if (_isStale(opts)) return { stale: true };
  const maxD = opts && opts.maxApproachDist;
  const here = bot.entity && bot.entity.position;
  if (maxD > 0 && here) {
    const d = Math.hypot(here.x - target.x, here.y - target.y, here.z - target.z);
    if (d > maxD) {
      if (typeof opts.onDisplaced === 'function') { try { opts.onDisplaced(d); } catch (e) { /* jamais bloquant */ } }
      return { displaced: true, dist: d };
    }
  }
  const ms = (opts && opts.approachTimeoutMs) || 20000;
  const t0 = Date.now();
  const tgt = { x: target.x, y: target.y, z: target.z };
  setPhase('approach', { target: tgt, range }, opts);
  try { _emit({ type: 'bm_approach', phase: 'start', range, target: tgt }); } catch (e) {}
  let timedOut = false;
  let rejected = false;
  try {
    const res = await withTimeout(bot.pathfinder.goto(buildNearGoal(target.x, target.y, target.z, range)), ms);
    timedOut = !!(res && res.timedOut);
    rejected = !!(res && res.rejected);
    if (timedOut) stopMotion(bot);   // goto trop long → on arrête le mouvement
  } catch (e) { rejected = true; /* cible bloquée → on tente quand même le dig direct */ }
  try { _emit({ type: 'bm_approach', phase: 'end', timedOut, rejected, ms: Date.now() - t0 }); } catch (e) {}
  setPhase('approach_done', null, opts);
}

// Phase courante du branch-mine (NIVEAU MODULE : lue par un timer d'index.js, piège #56). Copie des
// coordonnées, jamais une référence à `bot.entity.position` (mutée en place).
let _phase = { name: 'idle', at: 0 };
function setPhase(name, extra, opts) {
  _phase = Object.assign({ name, at: Date.now() }, extra || {});
  if (opts && typeof opts.onPhase === 'function') { try { opts.onPhase(name, extra || null); } catch (e) { /* jamais bloquant */ } }
}
function currentPhase() { return _phase; }

const COBBLE_RESERVE_MIN = 8;
const COBBLE_LOW_STREAK = 12;   // pas sous la réserve SANS gain avant d'abandonner `cobble_low`
const COBBLE_TARGET_INIT = 16;
// Matériaux de murage anti-lave : le creusage de deepslate génère du cobbled_deepslate à l'infini
// → fini les aborts cobble_low en profondeur (le cobblestone de surface n'est plus le seul stock).
const WALL_BLOCKS = ['cobblestone', 'cobbled_deepslate'];

function isLava(name) { return name === 'lava' || name === 'flowing_lava'; }
// `lava_avoided {where}` limité à un par lieu / 10 s (NIVEAU MODULE, piège #56).
const _lavaAvoidedOk = require('../lavaGuard').createAvoidedThrottle(10000);
function lavaAvoidedEmit(where, at) {
  try {
    if (!_lavaAvoidedOk(where)) return;
    _emit({ type: 'lava_avoided', where, x: Math.floor(at.x), y: Math.floor(at.y), z: Math.floor(at.z) });
  } catch (e) { /* jamais bloquant */ }
}
function isWater(name) { return name === 'water' || name === 'flowing_water'; }

function countItem(bot, name) {
  return (bot.inventory.items() || []).filter((i) => i.name === name).reduce((s, i) => s + i.count, 0);
}
function countItems(bot, names) {
  const set = new Set(names || []);
  return (bot.inventory.items() || []).filter((i) => set.has(i.name)).reduce((s, i) => s + i.count, 0);
}
function countWallable(bot) { return countItems(bot, WALL_BLOCKS); }

// Équipe `tool` seulement s'il n'est pas déjà en main (cache : equip a un coût par appel).
async function equipCached(bot, tool) {
  if (!tool) {
    // ⚠️ AUCUN OUTIL ADAPTÉ : on RETIRE celui qu'on tient au lieu de miner avec (Massii, 27/07 :
    // « quasi tous les bots tapent à mains nues ou avec des outils qui ne sont pas des pioches »).
    // Le `return` sec d'avant laissait en main l'épée du dernier combat — et miner de la pierre à
    // l'épée est PLUS LENT qu'à mains nues, en plus d'user l'arme pour rien.
    try {
      const h = bot.heldItem;
      if (h && /_(sword|axe|shovel|hoe)$/.test(h.name)) await bot.unequip('hand');
    } catch (e) { /* best-effort */ }
    return;
  }
  if (bot.heldItem && bot.heldItem.name === tool.name) return;
  try { await bot.equip(tool, 'hand'); } catch (e) {}
}

// Compteurs ores ramassés via gather (delta vs avant).
function snapshotOres(bot) {
  return {
    diamond: countItem(bot, 'diamond'),
    iron: countItem(bot, 'raw_iron') + countItem(bot, 'iron_ingot'),
    coal: countItem(bot, 'coal'),
  };
}

// Cardinal arrondi depuis le yaw du bot (même convention que descendDiagonal).
function cardinalFromYaw(yaw) {
  const norm = ((yaw % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
  const q = Math.round(norm / (Math.PI / 2)) % 4;
  if (q === 0) return { dx: 0, dz: 1 };
  if (q === 1) return { dx: -1, dz: 0 };
  if (q === 2) return { dx: 0, dz: -1 };
  return { dx: 1, dz: 0 };
}

// Perpendiculaire 90° gauche d'un cap.
function leftOf(dir) { return { dx: -dir.dz, dz: dir.dx }; }

// Pos = Vec3 (mineflayer's blockAt et placeBlock font des `.floored()` internes : un POJO throw
// `TypeError: pos.floored is not a function`, smoke phase A v3 a confirmé). On garde l'API offset
// pour ne pas casser les tests qui patchent blockAt avec des POJO comparables.
function p(x, y, z) { return new Vec3(x, y, z); }

// Probe 6 voisins (±x, ±y, ±z) du bloc cible — détecte lave/source/flowing.
function neighborsHaveLava(bot, target) {
  const d = [[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]];
  for (const [dx, dy, dz] of d) {
    const b = bot.blockAt(p(target.x + dx, target.y + dy, target.z + dz));
    if (b && isLava(b.name)) return { ahead: p(target.x + dx, target.y + dy, target.z + dz), block: b };
  }
  return null;
}

// Probe 6 voisins — détecte l'EAU (source/flowing). Retourne TOUTES les positions d'eau (à sceller
// chacune), car un aquifère a souvent plusieurs faces ouvertes. [] si sec.
function neighborsHaveWater(bot, target) {
  const d = [[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]];
  const out = [];
  for (const [dx, dy, dz] of d) {
    const b = bot.blockAt(p(target.x + dx, target.y + dy, target.z + dz));
    if (b && isWater(b.name)) out.push(p(target.x + dx, target.y + dy, target.z + dz));
  }
  return out;
}

// Tente de poser un bloc de murage (cobble OU cobbled_deepslate) pour murer la lave à `where`.
// On utilise placeBlock contre une face solide adjacente. Retourne true si placé, false sinon.
async function wallLava(bot, where) {
  const wall = bot.inventory.items().find((i) => WALL_BLOCKS.includes(i.name));
  if (!wall) return false;
  // Cherche un voisin solide auquel attacher le bloc.
  const dirs = [[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]];
  for (const [dx, dy, dz] of dirs) {
    const ref = bot.blockAt(p(where.x - dx, where.y - dy, where.z - dz));
    if (!ref || ref.boundingBox !== 'block') continue;
    try {
      await bot.equip(wall, 'hand');
      await bot.placeBlock(ref, { x: dx, y: dy, z: dz });
      return true;
    } catch (e) { /* essaie une autre face */ }
  }
  return false;
}

// ── GROTTE SUR LE CÔTÉ : BOUCHER au lieu de traverser (run 21/10 soir) ─────────────────────────────
// Sur 14 morts en tunnel (NethBot2/3, iron_deep), plusieurs à 4-6 hostiles qui arrivaient « de nulle
// part » dans un couloir 1×2 : le serpentin avait percé une grotte (air sur le côté ou devant) et la
// grotte, noire, déversait ses mobs dans le couloir. Un joueur qui débouche sur une grotte rebouche le
// trou (ou la traverse en l'éclairant) ; il ne laisse pas une porte ouverte derrière lui.
// Une case d'air isolée (poche de filon qu'on vient de vider) n'est PAS une grotte : on exige
// CAVE_MIN_AIR cases d'air dans la sonde au-delà de l'ouverture.
const CAVE_MIN_AIR = 4;
const TORCH_JITTER = 3;          // écart entre deux torches : [torchEvery, torchEvery + 2]
const TORCH_CORNER_MIN = 5;      // torche au coude du serpentin si la dernière est à ≥ 5 pas
const CAVE_SEAL_RESERVE = COBBLE_RESERVE_MIN + 2;   // la réserve anti-lave passe avant
const _AIR = new Set(['air', 'cave_air', 'void_air']);
function isAirBlock(b) { return !!(b && _AIR.has(b.name)); }

/** Nombre de cases d'air au-delà de l'ouverture `side` de la case (x,y,z) : 3 blocs de profondeur × pieds/tête + dessous/dessus. */
function caveAirBeyond(bot, cell, side) {
  let n = 0;
  for (let k = 1; k <= 3; k++) {
    for (let dy = -1; dy <= 2; dy++) {
      const b = bot.blockAt(p(cell.x + side.dx * k, cell.y + dy, cell.z + side.dz * k));
      if (isAirBlock(b)) n++;
    }
  }
  return n;
}

/**
 * Après avoir creusé la case `cell` (pieds) du couloir de cap `heading` : bouche les ouvertures de GROTTE
 * sur les deux côtés (pieds + tête) et, si `front`, devant. Rend { sealed, front } — `front` = vrai si
 * une grotte s'ouvre DEVANT (l'appelant tourne au lieu de la traverser). Best-effort, jamais bloquant.
 */
async function sealCaveOpenings(bot, cell, heading, opts = {}) {
  const out = { sealed: 0, front: false };
  const sides = [leftOf(heading), { dx: -leftOf(heading).dx, dz: -leftOf(heading).dz }];
  if (opts.front) sides.push({ dx: heading.dx, dz: heading.dz });
  for (const side of sides) {
    const isFront = side.dx === heading.dx && side.dz === heading.dz;
    const feet = p(cell.x + side.dx, cell.y, cell.z + side.dz);
    const head = p(feet.x, feet.y + 1, feet.z);
    const openings = [feet, head].filter((q) => isAirBlock(bot.blockAt(q)));
    if (!openings.length || caveAirBeyond(bot, cell, side) < CAVE_MIN_AIR) continue;
    if (isFront) out.front = true;
    for (const q of openings) {
      if (countWallable(bot) < CAVE_SEAL_RESERVE) break;
      try {
        let ok = await wallLava(bot, q);
        // Ouverture en plein vide (grande grotte : aucune face pleine autour) → on pose d'abord un appui
        // SOUS l'ouverture, accroché au sol de notre propre case, puis on bouche par-dessus.
        if (!ok && q.y === cell.y && isAirBlock(bot.blockAt(p(q.x, q.y - 1, q.z)))) {
          if (await wallLava(bot, p(q.x, q.y - 1, q.z))) ok = await wallLava(bot, q);
        }
        if (ok) out.sealed++;
      } catch (e) { /* best-effort */ }
    }
  }
  if (out.sealed || out.front) {
    try { _emit({ type: 'cave_sealed', sealed: out.sealed, front: out.front, x: cell.x, y: cell.y, z: cell.z }); } catch (e) {}
  }
  return out;
}

// Pose une torche près de `floorTarget` (la case des pieds du tunnel). Best-effort : pas de torche / pas
// de face → on continue sans (phase B mob-aware, jamais bloquant).
// Run 21/10 soir : 36 poses ratées sur 82 (`placed: false`) dans le branch-mine, ALTERNÉES avec des
// réussites — la torche était en poche, c'est la SURFACE qui manquait : seul le sol était essayé (sol de
// minerai miné, `placeBlock` qui refuse pendant un pas…). On essaie maintenant le sol PUIS les quatre murs
// de la case (torche murale), comme un joueur. Rend { placed, why } (why : floor | wall | no_torch |
// cell_full | no_face | message de l'exception) — la raison d'un échec ne se perd plus.
async function placeTorchAt(bot, floorTarget) {
  const torch = bot.inventory.items().find((i) => i.name === 'torch');
  if (!torch) return { placed: false, why: 'no_torch' };
  const cell = bot.blockAt(p(floorTarget.x, floorTarget.y, floorTarget.z));
  if (cell && cell.boundingBox === 'block') return { placed: false, why: 'cell_full' };
  const refs = [[0, -1, 0, { x: 0, y: 1, z: 0 }],
    [1, 0, 0, { x: -1, y: 0, z: 0 }], [-1, 0, 0, { x: 1, y: 0, z: 0 }],
    [0, 0, 1, { x: 0, y: 0, z: -1 }], [0, 0, -1, { x: 0, y: 0, z: 1 }]];
  let why = 'no_face';
  for (const [dx, dy, dz, face] of refs) {
    const ref = bot.blockAt(p(floorTarget.x + dx, floorTarget.y + dy, floorTarget.z + dz));
    if (!ref || ref.boundingBox !== 'block') continue;
    try {
      await bot.equip(torch, 'hand');
      await bot.placeBlock(ref, face);
      return { placed: true, why: dy === -1 ? 'floor' : 'wall' };
    } catch (e) { why = String((e && e.message) || e).slice(0, 60); }
  }
  return { placed: false, why };
}

// INSTRUMENTATION (Massii 26/07 : « ils placent des torches dans des zones déjà illuminées »).
// Ce chemin-ci posait les torches de tunnel SANS émettre le moindre event — le seul `torch_placed`
// du projet vit dans index.js, un autre chemin. Le comportement observé était donc littéralement
// invisible dans la télémétrie (même classe de silence que les tables de craft abandonnées).
// On mesure AVANT de corriger : deux causes restent possibles et aucune n'est établie — lumière
// client encore périmée juste après le creusage, ou lecture sur un bloc qui ne porte pas la
// lumière. `skyLight` est loggué aussi, mais il vaut 0 en profondeur : il ne peut pas expliquer
// le symptôme sous terre, seulement en surface.
async function placeTorchLogged(bot, floorTarget, light) {
  _phase = { name: 'torch', at: Date.now() };
  let skyLight = null;
  try { const c = bot.blockAt(floorTarget); if (c && c.skyLight != null) skyLight = c.skyLight; } catch (e) {}
  const r = await placeTorchAt(bot, floorTarget);
  const placed = r.placed;
  try {
    _emit({
      type: 'torch_placed', from: 'branchMine', placed: !!placed, why: r.why,
      light, skyLight,
      x: Math.round(floorTarget.x), y: Math.round(floorTarget.y), z: Math.round(floorTarget.z),
    });
  } catch (e) { /* best-effort */ }
  return placed;
}

// Détecte un ore dans les voisins 6-connectés d'un bloc. Tous les ores UTILES (quota + torches).
const ORE_NAMES = new Set([
  'diamond_ore', 'deepslate_diamond_ore',
  'iron_ore', 'deepslate_iron_ore',
  'coal_ore', 'deepslate_coal_ore',
  'gold_ore', 'deepslate_gold_ore',
  'redstone_ore', 'deepslate_redstone_ore',
  'lapis_ore', 'deepslate_lapis_ore',
  // cuivre retire : inutile aux chaines fer/diamant et jete par junkItems (cf. oregrab.js)
  'emerald_ore', 'deepslate_emerald_ore',
]);
function oresInNeighborhood(bot, target) {
  const found = [];
  const d = [[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]];
  for (const [dx, dy, dz] of d) {
    const b = bot.blockAt(p(target.x + dx, target.y + dy, target.z + dz));
    if (b && ORE_NAMES.has(b.name)) found.push(b.name);
  }
  return found;
}

// Famille d'ore : variante normale + deepslate = même veine logique (diamond_ore ↔ deepslate_diamond_ore).
function oreFamily(name) {
  return String(name || '').replace(/^deepslate_/, '').replace(/_ore$/, '');
}

// 6 voisins ORTHOGONAUX (faces) UNIQUEMENT — bug #1 (Massii, tell X-ray) : on suit la veine FACE par
// face, JAMAIS par les arêtes/coins. Un mineur humain ne peut pas casser un bloc connecté seulement en
// diagonale (occlus par le coin) → suivre la diagonale = tell X-ray direct. On SACRIFIE les blocs
// diagonaux-seuls (ils ont peut-être leur propre face exposée ailleurs → trouvés comme veine séparée).
const NEIGH_FACES = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];

// FLOOD-FILL d'une veine (§1.6/§3.G — minage HUMAIN, jamais X-ray) : dès qu'un ore est exposé, on vide
// TOUTE la veine connectée du même type (BFS 6-FACES orthogonales) avant de reprendre la branche — un
// mineur humain SUIT la veine face par face ; un X-rayer casse à travers les coins. Borné (maxVein).
// OUTIL RÉCOLTANT AVANT LE COLLECT (OOM 23/10, cf. ../toolGuard.js) : sans pioche de palier suffisant
// (diamant/or/redstone à la pioche de pierre, pioche cassée au milieu du filon), `collectBlock.collect`
// faisait boucler mineflayer-tool à l'infini (récursion en microtâches → tas plein, process tué, re-crash
// au même endroit à la relance : le minerai est toujours là). Un joueur laisse le bloc : il attendra la
// bonne pioche. Inventaire illisible (tests, bot pas prêt) → on ne bloque rien.
const _veinNoToolOk = require('../lavaGuard').createAvoidedThrottle(10000);
const _capRep = require('../loopGuard').createCapReporter({ emit: (e) => _emit(e) });
function _canHarvestVeinBlock(bot, b) {
  try {
    if (!bot || !bot.inventory || typeof bot.inventory.items !== 'function') return true;
    let tool = null;
    try { tool = bestToolFor(bot, b); } catch (e) { tool = null; }
    const held = (tool && tool.name) || (bot.heldItem && bot.heldItem.name) || null;
    return canHarvestWith(b.name, held);
  } catch (e) { return true; }
}

async function floodFillVein(bot, start, token, maxVein = 64) {
  try { _phase = { name: 'vein', at: Date.now(), target: { x: start.x, y: start.y, z: start.z } }; } catch (e) {}
  const b0 = bot.blockAt(p(start.x, start.y, start.z));
  if (!b0 || !ORE_NAMES.has(b0.name)) return 0;
  const fam = oreFamily(b0.name);
  const seen = new Set();
  const queue = [[start.x, start.y, start.z]];
  let mined = 0;
  // Borne DURE d'itérations (garde générique, `sync_loop_capped {where:'floodFillVein'}`) : une veine de
  // `maxVein` blocs ouvre au plus 6 faces par bloc — au-delà, la file ne décrit plus une veine.
  const over = require('../loopGuard').loopCap(maxVein * 8, 'floodFillVein', _capRep);
  while (queue.length && mined < maxVein) {
    if (token && token.cancelled) break;
    if (over()) break;
    const [x, y, z] = queue.shift();
    const k = x + ',' + y + ',' + z;
    if (seen.has(k)) continue;
    seen.add(k);
    const b = bot.blockAt(p(x, y, z));
    if (!b || !ORE_NAMES.has(b.name) || oreFamily(b.name) !== fam) continue;
    // VEINE AU BORD DE LA LAVE (23/10, NethBot1 : brûlé 0,5 s après la fin d'une collecte en serpentin) :
    // seul le 1er bloc de la veine passait par la garde lave — les suivants étaient minés à l'aveugle.
    // On mure ce qu'on peut ; s'il reste de la lave contre le bloc, on le laisse (le filon attendra).
    if (neighborsHaveLava(bot, { x, y, z })) {
      let left = neighborsHaveLava(bot, { x, y, z });
      for (let pass = 0; left && pass < 6; pass++) {
        if (!(await wallLava(bot, left.ahead))) break;
        left = neighborsHaveLava(bot, { x, y, z });
      }
      if (left) { lavaAvoidedEmit('vein', { x, y, z }); continue; }
    }
    // ⚠️ ÉQUIPER LA PIOCHE — `collectBlock.collect` n'équipe RIEN (limite connue, déjà corrigée
    // pour la reprise de blocs mais jamais ici). Sans ça le bot minait le filon avec ce qu'il avait
    // en main : Massii a filmé le 26/07 un bot frappant un diamant de deepslate AVEC UN BOUCLIER —
    // vitesse mains nues (le bloc semble increvable), et aucun drop même s'il finit par céder.
    try { await equipCached(bot, bestToolFor(bot, b)); } catch (e) { /* best-effort */ }
    if (!_canHarvestVeinBlock(bot, b)) {
      try { if (_veinNoToolOk(b.name)) _emit({ type: 'vein_no_tool', ore: b.name, x, y, z }); } catch (e) { /* télémétrie */ }
      continue;
    }
    // collectBlock.collect(b) = mine CE bloc précis (positionnel, ≠ gather qui prend le plus proche)
    // + ramasse le drop. Borné (un collect peut geler, piège #42). Échec → on saute ce bloc.
    try { await withTimeout(bot.collectBlock.collect(b), 30000); mined++; }
    catch (e) { continue; }
    for (const [dx, dy, dz] of NEIGH_FACES) queue.push([x + dx, y + dy, z + dz]);  // faces seulement (anti X-ray)
  }
  return mined;
}

// Positions (pas noms) des ores dans le voisinage 6-faces — pour lancer un flood-fill sur chacun.
function oreNeighborPositions(bot, target) {
  const found = [];
  for (const [dx, dy, dz] of [[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]]) {
    const pos = { x: target.x + dx, y: target.y + dy, z: target.z + dz };
    const b = bot.blockAt(p(pos.x, pos.y, pos.z));
    if (b && ORE_NAMES.has(b.name)) found.push(pos);
  }
  return found;
}

// ANTI-CHUTE (phase 3, vécu V3Res3 « fell from a high place ») : sol absent sous la case des
// pieds (plafond de grotte). PONT d'abord (garde le PLAN de minage — retomber 5 blocs plus bas
// casse le rythme du tunnel) ; pose impossible → chute acceptée si SURVIVABLE (≤ ½ PV / eau,
// affinage « joueur réel ») — approach() re-pathera. true = on peut continuer.
async function ensureFloor(bot, footTarget) {
  const u1 = bot.blockAt(p(footTarget.x, footTarget.y - 1, footTarget.z));
  if (!u1 || u1.boundingBox === 'block' || isLava(u1.name)) return true; // sol ok (la lave est gérée par neighborsHaveLava)
  const u2 = bot.blockAt(p(footTarget.x, footTarget.y - 2, footTarget.z));
  if (u2 && u2.boundingBox === 'block') return true;                     // trou d'1 : chute bénigne
  if (await wallLava(bot, p(footTarget.x, footTarget.y - 1, footTarget.z))) return true; // pont posé
  const a = assessDrop(bot, { x: footTarget.x, y: footTarget.y - 1, z: footTarget.z },
    { blockAt: (q) => bot.blockAt(p(q.x, q.y, q.z)) });
  return safeToDrop(a, bot.health);                                      // chute « joueur réel » ou stop
}

// Mine un bloc avec garde-fou lave + opportunisme ore. Retourne {ok, walled?:bool}.
// `loopOpts` (optionnel) porte le bornage d'approche (approachTimeoutMs) jusqu'au approach() interne.
async function safeDigAndOpportunism(bot, target, token, debug, loopOpts) {
  // Anti-lave 6-voisins.
  let lava;
  try { lava = neighborsHaveLava(bot, target); }
  catch (e) { if (debug) dbg('safeDig', { phase: 'safeDig:neighborsThrew', err: String(e && e.message || e).slice(0,200) }); return { ok: false, reason: 'neighbor_err' }; }
  if (lava) {
    // TOUTES les faces (23/10 : mort en serpentin à y≈14) : l'ancienne garde ne murait que la PREMIÈRE
    // face de lave trouvée — une mare touche souvent le bloc par deux côtés (devant + dessous, côté +
    // plafond) et la seconde coulait dans la galerie dès le coup de pioche. On mure, on relit, jusqu'à
    // ce que plus aucune face ne soit de la lave (≤ 6 passes) ; sinon on ne creuse pas.
    let left = lava;
    for (let pass = 0; left && pass < 6; pass++) {
      const walled = await wallLava(bot, left.ahead);
      if (!walled) break;
      try { left = neighborsHaveLava(bot, target); } catch (e) { left = null; }
    }
    if (left) {
      lavaAvoidedEmit('branch_dig', target);
      return { ok: false, walled: false, reason: 'lava_unwallable' };
    }
  }
  // Anti-EAU (aquifères à profondeur diamant, frein #1 live) : sceller l'eau voisine AVANT de miner.
  // Sinon le tunnel se noie → réflexe anti-noyade → surface → water_rescue → warp → re-descend →
  // re-eau (vécu live ResBot1/3 : boucle eau, 0 minage). On mure chaque face d'eau via wallLava
  // (générique : mure n'importe quel fluide). Best-effort : eau non scellée → on mine quand même
  // (le réflexe anti-noyade reste le filet), jamais bloquant.
  try {
    for (const w of neighborsHaveWater(bot, target)) {
      try { await wallLava(bot, w); } catch (e) { /* face suivante */ }
    }
  } catch (e) { /* best-effort, ne jamais bloquer le minage */ }
  const block = bot.blockAt(target);
  if (debug) { try { dbg('safeDig', { phase: 'safeDig:probe', target: { x: target.x, y: target.y, z: target.z }, blockName: block ? block.name : null }); } catch (e) {} }
  // Survie PRIME (BUG #1 Massii, noyade live à -53) : NE JAMAIS creuser dans / avancer vers l'eau.
  // Le boundingBox de l'eau = 'empty' → l'ancien `!== 'block'` la prenait pour de l'AIR et le bot
  // y AVANÇAIT (vécu : nappe à profondeur diamant → noyade → water_rescue → re-descente en boucle,
  // 0 minage). On la traite comme un obstacle DUR → l'appelant TOURNE vers le sec (heading
  // perpendiculaire, comme l'anti-chute) : on N'ENTRE PAS, on sacrifie ce tunnel. Le scellement
  // best-effort ci-dessus gère l'eau ADJACENTE (face) ; ici c'est la case CIBLE qui est mouillée
  // → on la SCELLE aussi (fix n°2 water-wall : wallLava pose DANS le fluide — sans mur, la source
  // coule dans la galerie dès qu'elle est ouverte → inondation → water_rescue surface → churn).
  // Nécessaire en serpentin : le `break` sur water_ahead saute le head → le scellement mutuel
  // foot↔head (neighborsHaveWater) n'a pas lieu. Best-effort : échec → le demi-tour reste le filet.
  if (block && isWater(block.name)) {
    try { await wallLava(bot, target); } catch (e) { /* best-effort */ }
    return { ok: false, reason: 'water_ahead' };
  }
  // ⚠️ NE PAS CREUSER EN ÉTANT SOI-MÊME DANS L'EAU (Massii, 27/07 : « les bots continuent à
  // creuser dans l'eau »). La garde ci-dessus protège la case CIBLE, mais si la galerie s'est
  // inondée APRÈS l'ouverture, le bot poursuit son tunnel en apnée : minage 5× plus lent, noyade
  // au bout, et chaque bloc ouvert agrandit la nappe. On rend la main avec la même raison que
  // l'eau devant — l'appelant sait déjà tourner vers le sec et compter l'échec pour la zone.
  try {
    const self = bot.entity && bot.entity.position;
    const head = self && bot.blockAt(p(Math.floor(self.x), Math.floor(self.y) + 1, Math.floor(self.z)));
    if (head && isWater(head.name)) return { ok: false, reason: 'water_ahead' };
  } catch (e) { /* lecture ratée → on ne bloque pas le minage */ }
  if (!block || block.boundingBox !== 'block') return { ok: true };       // déjà air → rien à faire
  if (isLava(block.name)) return { ok: false, reason: 'lava_at_target' };

  // ⚠️ JAMAIS UN MINERAI À MAINS NUES (Massii, 27/07 : « il tape avec les mains là »). Casser du
  // fer sans pioche DÉTRUIT le bloc et ne donne RIEN : le bot dépense de longues secondes, perd
  // le filon, et recommence ailleurs. Un joueur ne fait jamais ça. `equipCached` plus haut a déjà
  // tenté d'équiper le meilleur outil ; s'il n'y en a AUCUN qui récolte, on laisse le bloc en
  // place — il sera toujours là quand le bot aura refait une pioche.
  // Si le bloc cible EST un ore utile : §3.G → on vide la VEINE ENTIÈRE (flood-fill), pas juste ce
  // bloc — allure mineur humain (suit la veine), jamais X-ray (1 bloc puis repart).
  if (ORE_NAMES.has(block.name)) {
    try { await floodFillVein(bot, target, token); }
    catch (e) { /* fallback dig direct ci-dessous */ }
    return { ok: true };
  }

  // ROCHE NUE → dig DIRECT (phase 3) : collectBlock re-pathfindait vers CHAQUE drop (~1-2 s/bloc
  // de surcoût × milliers de blocs). Les drops tombent dans le tunnel 1×2 — le bot les aspire en
  // avançant (approach() du palier suivant passe dessus). Pioche la MOINS CHÈRE pour la roche
  // (la durabilité fer = 3 lingots/250 blocs, plus cher que le gain de vitesse — vécu V3Res1).
  // SANS PIOCHE : jamais de minage à la MAIN (~9 s/bloc deepslate, vécu V3Res4) → bail propre,
  // l'appelant déclenche la récupération de pioche.
  const pickName = cheapestPickFor((bot.inventory && bot.inventory.items()) || [], block.name);
  if (!pickName) return { ok: false, reason: 'no_pickaxe' };
  let tool = ((bot.inventory && bot.inventory.items()) || []).find((i) => i.name === pickName) || null;
  if (!tool) tool = bestToolFor(bot, block);
  await equipCached(bot, tool);
  // ⚠️ APRÈS l'équipement : l'outil en main récolte-t-il vraiment ce bloc ? Vaut pour TOUT bloc
  // qui exige un outil, pas seulement les minerais — la pierre elle-même ne donne du cobble
  // qu'avec une pioche. Sans outil récoltant, creuser c'est détruire pour rien (Massii, 27/07 :
  // « quasi tous les bots tapent à mains nues ou avec des outils qui ne sont pas des pioches »).
  // On juge sur l'outil qu'on vient de SÉLECTIONNER (pas sur `bot.heldItem` : l'equip est async,
  // et `tool` est justement le meilleur outil disponible en inventaire).
  const _held = (tool && tool.name) || (bot.heldItem && bot.heldItem.name);
  if (!canHarvestWith(block.name, _held)) {
    return { ok: false, reason: 'no_pickaxe' };
  }
  // Reachability « vrai joueur » (vécu V3Res3 : dig en diagonale à travers un coin) : si le bloc
  // n'est ni visible ni à portée, on se RAPPROCHE une fois ; toujours pas → dig_failed (skip).
  if ((typeof bot.canSeeBlock === 'function' && !bot.canSeeBlock(block))
      || (typeof bot.canDigBlock === 'function' && !bot.canDigBlock(block))) {
    await approach(bot, target, 1, loopOpts);
    if (_isStale(loopOpts)) return { ok: false, reason: 'stale' };
    if ((typeof bot.canSeeBlock === 'function' && !bot.canSeeBlock(block))
        || (typeof bot.canDigBlock === 'function' && !bot.canDigBlock(block))) {
      return { ok: false, reason: 'dig_failed' };
    }
  }
  try {
    await bot.dig(block);
  } catch (e) {
    if (debug) { try { dbg('safeDig', { phase: 'safeDig:fail', target: { x: target.x, y: target.y, z: target.z }, err: String(e && e.message || e).slice(0, 200) }); } catch (e2) {} }
    return { ok: false, reason: 'dig_failed' };
  }

  // ANTI-GRAVIER (vécu V3Res4 « suffocated in a wall ») : un bloc à GRAVITÉ au-dessus de la case
  // creusée tombe sur la tête du bot. On le mine tant qu'il en retombe (≤4, colonnes de gravier).
  for (let g = 0; g < 4; g++) {
    const above = bot.blockAt(p(target.x, target.y + 1, target.z));
    if (!above || (above.name !== 'gravel' && above.name !== 'sand')) break;
    await equipCached(bot, bestToolFor(bot, above));
    try { await bot.dig(above); } catch (e) { break; }
  }

  // Opportunisme → FLOOD-FILL (§3.G) : chaque ore révélé aux abords par le dig déclenche l'extraction
  // de sa VEINE ENTIÈRE (un humain suit la veine), pas juste le bloc voisin.
  if ((token && token.cancelled) || _isStale(loopOpts)) return { ok: true };
  for (const pos of oreNeighborPositions(bot, target)) {
    try { await floodFillVein(bot, pos, token); } catch (e) { /* opportuniste : on continue */ }
  }
  return { ok: true };
}

/**
 * Boucle de branch mining déterministe à Y target.
 *  - tunnel principal 1×2 dans le cap initial du bot (ou opts.heading {dx,dz} si fourni)
 *  - tous les `branchSpacing` blocs (>0), creuse 2 branches symétriques (gauche puis droite) de
 *    `branchLength` blocs
 *  - 6-voisins lava check avant chaque dig (mure si possible)
 *  - opportuniste sur tous les ores quota voisins (gather)
 *  - stop : opts.stopOre {items:[names], count:n} = DELTA récolté depuis le début du call
 *    (mode quota) ; défaut legacy = diamant en inventaire (DIAMOND_CHAIN) ;
 *    mainLength atteint, ou réserve de murage <8.
 *  - opts.torchEvery (déf 0=off) : torche au sol tous les N paliers du tunnel principal.
 */
async function branchMine(bot, opts = {}, token = null) {
  // RETOUR VIDE (24/10, NethBot2/NethBot3 en iron_help) : `stats.digs` compte les coups de pioche TENTÉS.
  // Un retour sans aucun coup ni minerai est marqué `empty` (cf. bmBail) : l'appelant le dit (`bm_bail`) et
  // le compte comme un échec, au lieu d'une boucle silencieuse goal → enter → goal ×4 → retry 90 s.
  const stats = { digs: 0 };
  try {
    const r = await _branchMine(bot, Object.assign({}, opts || {}, { _stats: stats }), token);
    if (r && typeof r === 'object' && stats.digs === 0) {
      const o = r.ores || {};
      if (!((o.diamond || 0) + (o.iron || 0) + (o.coal || 0))) r.empty = true;
    }
    return r;
  }
  finally { setPhase('idle', null, null); }
}

/**
 * PUR — retour VIDE de branchMine (aucun coup de pioche, aucun minerai) → { bail, result }.
 *  bail   : null (retour utile), sinon la raison à émettre dans `bm_bail` (raison du skill, 'stale:<why>',
 *           'cancelled' ou 'empty' quand le skill a rendu ok:true sans rien faire).
 *  result : le résultat à rendre au planner — un ok:true vide (hors jeton annulé) devient
 *           { ok:false, reason:'bm_empty' } pour nourrir failStreak / goal_failed (backoff du planner).
 */
function bmBail(r) {
  if (!r || typeof r !== 'object' || !r.empty) return { bail: null, result: r };
  let bail;
  if (r.stale) bail = 'stale:' + (r.why || 'life_changed');
  else if (r.cancelled) bail = 'cancelled';
  else bail = r.reason || 'empty';
  const result = (r.ok !== false && !r.cancelled)
    ? Object.assign({}, r, { ok: false, reason: 'bm_empty', bmReason: r.reason || null })
    : r;
  return { bail, result };
}

// Distance max d'une cible d'approche au bot DANS le serpentin/couloir : la case suivante est voisine, le
// retour d'une branche latérale au couloir ≤ branchLength. Au-delà, le bot a été téléporté ou est réapparu.
const DISPLACED_DIST = 32;

async function _branchMine(bot, opts0 = {}, token = null) {
  // VIE PÉRIMÉE (23/10) : `opts0.isStale` (fourni par l'appelant : génération de vie changée) OU déplacement
  // détecté par approach → `abort` posé, la boucle sort au prochain point de contrôle avec
  // { ok:false, reason:'stale', why } et `opts0.onStale(why)` UNE fois. Copie : on n'écrit pas chez l'appelant.
  let abort = null;
  const userStale = () => _isStale(opts0);
  const opts = Object.assign({}, opts0, {
    isStale: () => !!abort || userStale() || !!(token && token.cancelled),
    onDisplaced: () => { if (!abort) abort = 'displaced'; },
    maxApproachDist: opts0.maxApproachDist || DISPLACED_DIST,
  });
  // Vrai si la vie est finie (jeton annulé exclu : il garde son retour historique { ok:true, cancelled }).
  const stale = () => { if (!abort && userStale()) abort = 'life_changed'; return !!abort; };
  let staleSaid = false;
  const staleOut = () => {
    if (!staleSaid) { staleSaid = true; if (typeof opts0.onStale === 'function') { try { opts0.onStale(abort); } catch (e) { /* jamais bloquant */ } } }
    return { ok: false, reason: 'stale', why: abort, stale: true };
  };
  const targetY = opts.targetY !== undefined ? opts.targetY : -54;
  const mainLength = opts.mainLength || 32;
  const branchSpacing = opts.branchSpacing || 3;
  const branchLength = opts.branchLength || 8;
  const stopOre = opts.stopOre || null;                  // {items:[...], count:n} — delta depuis le départ
  const torchEvery = opts.torchEvery || 0;
  const rng = opts.rng || Math.random;
  // Cadence des torches (run 21/10 soir) : l'ancien écart [N, 2N[ laissait jusqu'à 15 blocs sans
  // lumière avec N = 8 — et une torche n'éclaire qu'à ~7 blocs au-dessus du seuil d'apparition. Un
  // joueur en pose une tous les ~8 blocs : écart [N, N+2], le jitter reste (jamais métronomique).
  const torchGap = () => torchEvery + Math.floor(rng() * TORCH_JITTER);
  const sealCaves = opts.sealCaves !== false;            // boucher les grottes percées (déf. oui)
  const debug = !!opts.debug;
  // Hole E — détection de stall interne + hook de survie PENDANT le tunnel (avant, survie/lumière
  // ne tournaient qu'ENTRE les appels branchMine, pas durant les branches de plusieurs minutes).
  const now = opts.now || Date.now;                      // horloge injectable (tests déterministes)
  const stallMs = opts.stallMs || 30000;                 // pas de progrès > stallMs → 'stalled'
  const onSurvivalTick = opts.onSurvivalTick || null;    // async, opt-in
  const survivalEvery = opts.survivalEvery || 4;

  // PIOCHE CASSÉE EN BAS (21/10, NethBot2 : 6 `no_pickaxe` en 37 min d'iron_deep). `opts.onNoPickaxe`
  // (async → bool) re-crafte une pioche SUR PLACE (3 cobble + 2 bâtons, table portable) ; vrai → on
  // retente le même bloc et le couloir continue, au lieu d'abandonner le branch-mine. Une fois par bloc.
  const digStep = async (t) => {
    setPhase('dig', { target: { x: t.x, y: t.y, z: t.z } }, opts);
    if (opts._stats) opts._stats.digs++;
    let r = await safeDigAndOpportunism(bot, t, token, debug, opts);
    if (r && !r.ok && r.reason === 'no_pickaxe' && typeof opts.onNoPickaxe === 'function') {
      let fixed = false;
      try { fixed = !!(await opts.onNoPickaxe()); } catch (e) { fixed = false; }
      if (fixed && !(token && token.cancelled)) r = await safeDigAndOpportunism(bot, t, token, debug, opts);
    }
    return r;
  };
  const start = bot.entity && bot.entity.position;
  setPhase('enter', start ? { x: start.x, y: start.y, z: start.z } : null, opts);
  dbg('start', { phase: 'branchMine:enter', y: start ? start.y : null, x: start ? start.x : null, z: start ? start.z : null, targetY, mainLength, wall: countWallable(bot) });
  if (!start) { dbg('start', { phase: 'branchMine:bail', reason: 'no_pos' }); return { ok: false, reason: 'no_pos' }; }
  // Trop HAUT (au-dessus de la cible) de >2 = mauvaise couche → bail. Trop PROFOND est SANS RISQUE
  // (la couche reste minable bien sous targetY) et index.js admet le bot jusqu'à targetY-6 avant
  // d'appeler branchMine ; exiger |Δ|≤2 faisait baill un bot à targetY-3..-6 → relocate → boucle
  // surface, 0 minage (live 22/06 soir : lapis bloqué 0, bots à y-61 pour targetY -58). On s'aligne
  // sur la fenêtre d'index.js : [targetY-6, targetY+2].
  // opts.allowDeeper (cycle 2 water-wall, opt-in chaînes armure) : un bot SOUS la fenêtre (ex. y=4
  // pour targetY=16, ramené là par water_rescue → /home safe) bouclait à vie wrong_depth (descend
  // met à y≤18, rien ne remonte). Le minage se fait AU NIVEAU COURANT (targetY ne sert qu'à cette
  // porte) → on l'admet tant qu'il reste au-dessus du plancher bedrock (y ≥ -59).
  const tooDeep = start.y < targetY - 6 && !(opts.allowDeeper && start.y >= -59);
  if (start.y > targetY + 2 || tooDeep) { dbg('start', { phase: 'branchMine:bail', reason: 'wrong_depth', startY: start.y, targetY }); return { ok: false, reason: 'wrong_depth' }; }

  // PIOCHE D'ABORD (21/10). Sans pioche on ne mine RIEN (jamais à la main, Massii #5) : le dire tout de
  // suite, avec le vrai nom, au lieu du `cobble_low` qui le masquait (NethBot2 à y=13 : 16 `cobble_low`
  // en < 50 ms par rafale — il n'avait plus de pioche, et 3 cobble). Une re-fabrication sur place est
  // tentée d'abord (opts.onNoPickaxe), comme en cours de tunnel.
  const hasPick = () => ((bot.inventory && bot.inventory.items()) || []).some((it) => it && /_pickaxe$/.test(it.name));
  if (!hasPick()) {
    let fixed = false;
    if (typeof opts.onNoPickaxe === 'function') { try { fixed = !!(await opts.onNoPickaxe()); } catch (e) { fixed = false; } }
    if (!fixed || !hasPick()) return { ok: false, reason: 'no_pickaxe' };
  }
  // RÉSERVE DE MURAGE : PAS une condition de départ (21/10). Miner PRODUIT le cobble (chaque bloc de
  // pierre/deepslate creusé en rend un) : exiger 8 blocs avant le 1er coup de pioche refusait le
  // minage précisément au bot qui en avait le plus besoin. On démarre avec ce qu'on a ; on ne s'arrête
  // `cobble_low` que si la réserve reste sous le minimum SANS remonter pendant COBBLE_LOW_STREAK pas
  // (couche qui ne rend rien de murable : tuf, granite, grotte…).
  let lowStreak = 0;
  let lastWall = countWallable(bot);
  const cobbleLow = () => {
    const w = countWallable(bot);
    if (w >= COBBLE_RESERVE_MIN || w > lastWall) { lowStreak = 0; lastWall = w; return false; }
    lastWall = w;
    return ++lowStreak >= COBBLE_LOW_STREAK;
  };

  const dir = (opts.heading && (opts.heading.dx || opts.heading.dz))
    ? { dx: Math.sign(opts.heading.dx || 0), dz: Math.sign(opts.heading.dz || 0) }
    : cardinalFromYaw((bot.entity.yaw || 0));
  const left = leftOf(dir);
  const oresBefore = snapshotOres(bot);
  const stopStart = stopOre ? countItems(bot, stopOre.items) : 0;
  // Défaut SANS stopOre = 1 diamant de PLUS qu'au départ (delta), jamais « un diamant en poche » :
  // l'ancien test absolu sortait au 1er pas sans rien creuser dès que le bot PORTAIT un diamant (vécu
  // 24/10 : iron_help → iron_deep ×4 en 300 ms puis retry 90 s, 30 min, NethBot3 18 💎 / NethBot2 28 💎 —
  // et le repli « tunnel vers la grotte suivante » de caveHunt faisait pareil en phase diamant).
  const diamondStart = stopOre ? 0 : countItem(bot, 'diamond');
  const stopReached = () => stopOre
    ? (countItems(bot, stopOre.items) - stopStart >= stopOre.count)
    : (countItem(bot, 'diamond') - diamondStart >= 1);

  // Point de départ figé : on calcule les cibles depuis CE point, jamais depuis la position
  // courante (sinon les targets dériveraient à mesure que le bot avance via pathfinder).
  const origin = bot.entity.position;
  const ox = Math.floor(origin.x);
  const oy = Math.floor(origin.y);
  const oz = Math.floor(origin.z);

  let i = 1;
  let stopReason = null;
  let nextTorchAt = torchEvery > 0 ? torchEvery : Infinity;   // 1re torche après ~torchEvery paliers

  // Suivi de PROGRÈS (hole E) : le bot a progressé si sa position floorée a bougé d'≥1 bloc
  // OU si le compteur d'ores a augmenté (PAS i — i avance même quand le bot est physiquement
  // coincé sur des digs qui échouent). Signal ore = quota stopOre + ores ramassés (diamant/fer/charbon).
  const flooredPos = () => {
    const pp = bot.entity && bot.entity.position;
    return pp ? `${Math.floor(pp.x)},${Math.floor(pp.y)},${Math.floor(pp.z)}` : 'none';
  };
  const oreSignal = () => {
    const o = snapshotOres(bot);
    return (stopOre ? countItems(bot, stopOre.items) : 0) + o.diamond + o.iron + o.coal;
  };
  let lastProgressAt = now();
  let lastPosKey = flooredPos();
  let lastOreSignal = oreSignal();
  // Détection de stall FACTORISÉE (réutilisée boucle principale ET branches latérales — bug review
  // #4 : les for-j de branches, jusqu'à branchLength×2 cibles = plusieurs min, n'avaient NI survie NI
  // détection de stall → un bot coincé dans une branche stallait jusqu'au timeout 900s). true = stall.
  const checkStall = () => {
    const posKey = flooredPos();
    const oreNow = oreSignal();
    if (posKey !== lastPosKey || oreNow > lastOreSignal) {
      lastProgressAt = now(); lastPosKey = posKey; lastOreSignal = oreNow;
      return false;
    }
    return now() - lastProgressAt > stallMs;
  };

  // ── MODE SERPENTIN (BUG PRIO 3.1 Massii — minage profond du DIAMANT sans grille/tell X-ray).
  // UNE SEULE galerie 1×2 ONDULANTE : on avance 1 bloc à la fois dans le cap courant, et on TOURNE
  // 90° (gauche/droite tirés au sort) à des intervalles IRRÉGULIERS (segments de 4..8 blocs). Aucune
  // branche symétrique régulière. Réutilise tout l'arsenal de branchMine (scellement eau+lave par
  // safeDigAndOpportunism, flood-fill des veines, anti-chute, survie, torches) → reste SEC à -58.
  if (opts.serpentine) {
    let cx = ox, cz = oz;                                   // front de taille (cumulatif : la galerie tourne)
    let heading = { dx: dir.dx, dz: dir.dz };
    let stepsLeft = 4 + Math.floor(rng() * 5);              // longueur du 1er segment (4..8, irrégulier)
    // LACETS (22/10, lawnMine.js) : opts.lawn → les virages suivent des galeries PARALLÈLES espacées
    // de 3 au lieu du hasard. opts.lawnState (état rendu par l'appel précédent) reprend le tracé là
    // où il s'était arrêté — sinon on repart du cap courant. Sans opts.lawn : serpentin d'avant.
    const lawnO = opts.lawn ? Object.assign({ rng }, typeof opts.lawn === 'object' ? opts.lawn : {}) : null;
    let lawn = null;
    if (lawnO) {
      lawn = lawnMine.lawnValid(opts.lawnState) ? opts.lawnState : lawnMine.lawnInit(heading, lawnO);
      heading = { dx: lawn.heading.dx, dz: lawn.heading.dz };
    }
    // Virage : lacets (obstacle → décalage tout de suite) ou serpentin aléatoire historique.
    const turnAway = () => {
      if (lawn) { lawn = lawnMine.lawnObstacle(lawn, lawnO); heading = { dx: lawn.heading.dx, dz: lawn.heading.dz }; return; }
      heading = (rng() < 0.5) ? leftOf(heading) : { dx: heading.dz, dz: -heading.dx };
      stepsLeft = 4 + Math.floor(rng() * 5);
    };
    const lawnOut = () => (lawn ? { lawn } : {});
    let stopReasonS = null;
    let wetTurns = 0;                                       // demi-tours eau CONSÉCUTIFS (sans avancer) → waterlocked
    let nextTorchAtS = torchEvery > 0 ? torchEvery : Infinity;
    let lastTorchS = 0;                                     // pas de la dernière pose (torche au coude)
    for (let n = 1; n <= mainLength; n++) {
      if (stale()) return staleOut();
      if (token && token.cancelled) return Object.assign({ ok: true, cancelled: true, ores: deltaOres(oresBefore, snapshotOres(bot)), gotDiamond: countItem(bot, 'diamond') > 0, heading }, lawnOut());
      if (checkStall()) { stopReasonS = 'stalled'; break; }
      if (cobbleLow()) { stopReasonS = 'cobble_low'; break; }
      if (stopReached()) break;                             // quota du type rempli
      if (onSurvivalTick && n % survivalEvery === 0) { setPhase('survival', null, opts); try { await onSurvivalTick(n); } catch (e) { /* best-effort */ } }
      const footTarget = p(cx + heading.dx, oy, cz + heading.dz);
      const headTarget = p(footTarget.x, footTarget.y + 1, footTarget.z);
      try { await approach(bot, footTarget, 3, opts); } catch (e) { /* dig direct prendra le relais */ }
      if (stale()) return staleOut();
      // Anti-chute : trou sous la prochaine case (grotte/ravin) → on ne s'y jette PAS, on TOURNE
      // (le serpentin contourne au lieu de tomber/stopper — plus robuste qu'un break sur 1er trou).
      let floorOk = true;
      setPhase('floor', null, opts);
      try { floorOk = await ensureFloor(bot, footTarget); } catch (e) { /* best-effort */ }
      if (!floorOk) { turnAway(); continue; }
      let hardStop = false;
      let wetTurn = false;
      for (const t of [footTarget, headTarget]) {
        let r;
        try { r = await digStep(t); }
        catch (e) { r = { ok: false, reason: 'threw' }; }
        // Eau devant (survie prime, BUG #1) : on N'ENTRE PAS → on TOURNE vers le sec (serpentin),
        // la branche continue ailleurs au lieu de se noyer. ≠ lave (hardStop) : l'eau est contournable.
        if (!r.ok && r.reason === 'water_ahead') { wetTurn = true; break; }
        if (!r.ok && r.reason === 'lava_unwallable') { stopReasonS = 'lava'; hardStop = true; break; }
        if (!r.ok && r.reason === 'no_pickaxe') { stopReasonS = 'no_pickaxe'; hardStop = true; break; }
        if (stale()) return staleOut();
      }
      if (hardStop) break;
      if (wetTurn) {                                          // demi-tour anti-noyade, on reste SEC
        if (debug) { try { dbg('branch', { phase: 'branch:water_turn', x: cx, y: oy, z: cz }); } catch (e) {} }
        // Aquifère VERROUILLANT (fix n°2 water-wall) : ≥6 demi-tours eau sans avancer d'un bloc =
        // toutes les directions mouillées et scellement inopérant → échec RAPIDE et NOMMÉ (l'ancien
        // comportement tournait en boucle jusqu'au stall 30s ; l'appelant se décale sur waterlocked).
        if (++wetTurns >= 6) { stopReasonS = 'waterlocked'; break; }
        turnAway();
        continue;
      }
      wetTurns = 0;                                        // le front a avancé → l'eau n'enferme pas
      cx += heading.dx; cz += heading.dz;                  // le front a avancé (case minée)
      // Grotte percée sur le côté ou devant : on la BOUCHE ; devant → on tourne au lieu de la traverser.
      let caveAhead = false;
      if (sealCaves) {
        setPhase('seal', null, opts);
        try { caveAhead = !!(await sealCaveOpenings(bot, footTarget, heading, { front: true })).front; } catch (e) { /* best-effort */ }
      }
      const torchHere = async () => {
        lastTorchS = n;
        nextTorchAtS = n + torchGap();
        let light = 0;
        try { const cell = bot.blockAt(footTarget); if (cell && cell.light != null) light = cell.light; } catch (e) { /* inconnue = sombre */ }
        if (light < 8) { try { await placeTorchLogged(bot, footTarget, light); } catch (e) { /* best-effort */ } }
      };
      if (n >= nextTorchAtS) await torchHere();
      // VIRAGE à intervalle IRRÉGULIER (jamais métronomique = pas une grille) — ou forcé par une grotte devant.
      let turned = false;
      if (lawn) {
        const before = lawn.heading;
        lawn = caveAhead ? lawnMine.lawnObstacle(lawn, lawnO) : lawnMine.lawnAfterStep(lawn, lawnO);
        heading = { dx: lawn.heading.dx, dz: lawn.heading.dz };
        turned = before.dx !== heading.dx || before.dz !== heading.dz;
      } else if (--stepsLeft <= 0 || caveAhead) {
        heading = (rng() < 0.5) ? leftOf(heading) : { dx: heading.dz, dz: -heading.dx };
        stepsLeft = 4 + Math.floor(rng() * 5);
        turned = true;
      }
      if (turned) {
        // TORCHE AU CROISEMENT : un coude non éclairé est l'angle mort où le mob attend. Pas si une
        // torche a été posée il y a moins de TORCH_CORNER_MIN pas (la lumière porte déjà jusque-là).
        if (torchEvery > 0 && n - lastTorchS >= TORCH_CORNER_MIN) await torchHere();
      }
    }
    const oresAfterS = snapshotOres(bot);
    return {
      ok: !stopReasonS || stopReasonS === 'lava' || stopReasonS === 'drop',
      gotDiamond: oresAfterS.diamond >= 1,
      ores: deltaOres(oresBefore, oresAfterS),
      reason: stopReasonS || undefined,
      heading,
      ...lawnOut(),
    };
  }

  let wetSteps = 0;             // pas de couloir CONSÉCUTIFS face à l'eau (scellés, non creusés) → waterlocked
  outer:
  while (i <= mainLength) {
    if (stale()) return staleOut();
    if (token && token.cancelled) return { ok: true, cancelled: true, ores: deltaOres(oresBefore, snapshotOres(bot)), gotDiamond: countItem(bot, 'diamond') > 0, heading: dir };
    // Stall : aucun progrès (position figée + aucun ore récolté) depuis > stallMs → échec réel
    // (l'appelant relocate). On échantillonne EN TÊTE de boucle.
    if (checkStall()) { stopReason = 'stalled'; break; }
    if (cobbleLow()) { stopReason = 'cobble_low'; break; }
    if (stopReached()) break;                                          // objectif rempli

    // Survie/lumière PENDANT le tunnel (hole E) : tous les survivalEvery paliers, hook opt-in.
    if (onSurvivalTick && i % survivalEvery === 0) {
      try { await onSurvivalTick(i); } catch (e) { /* best-effort : ne casse pas le minage */ }
    }

    // Tunnel 1×2 : pieds + tête. Targets calculés depuis origin (point fixe).
    const footTarget = p(ox + dir.dx * i, oy, oz + dir.dz * i);
    const headTarget = p(footTarget.x, footTarget.y + 1, footTarget.z);
    if (debug) dbg('iter', { phase: 'branchMine:iter', i, footTarget: { x: footTarget.x, y: footTarget.y, z: footTarget.z } });
    // Approche AVANT le dig : sinon hors range à i>=6 (cf. risque #5). GoalNear 3 = arrive à ≤3 blocs.
    try { await approach(bot, footTarget, 3, opts); } catch (e) { if (debug) dbg('iter', { phase: 'branchMine:approachThrew', err: String(e).slice(0,150) }); }
    if (stale()) return staleOut();
    // Sol manquant sous la prochaine case (grotte) → ponté, sinon on arrête le tunnel ici (anti-chute).
    try { if (!(await ensureFloor(bot, footTarget))) { stopReason = 'drop'; break; } } catch (e) { /* best-effort */ }
    let stepWet = false;
    for (const t of [footTarget, headTarget]) {
      let r;
      try { r = await digStep(t); }
      catch (e) { if (debug) dbg('iter', { phase: 'branchMine:safeDigThrew', err: String(e).slice(0,150) }); r = { ok: false, reason: 'threw' }; }
      if (!r.ok && r.reason === 'water_ahead') stepWet = true;   // scellé best-effort ; on n'entre pas
      if (!r.ok && r.reason === 'lava_unwallable') { stopReason = 'lava'; break outer; }
      if (!r.ok && r.reason === 'no_pickaxe') { stopReason = 'no_pickaxe'; break outer; } // jamais à la main (Massii #5)
      if (stale()) return staleOut();
    }
    // Fix n°2 water-wall : ≥8 pas consécutifs face à l'eau = le couloir traverse une nappe que le
    // scellement n'assèche pas → échec RAPIDE et NOMMÉ (l'ancien couloir « avançait » à l'aveugle
    // le long de la nappe sans jamais creuser → water_rescue → churn). L'appelant se décale.
    if (stepWet) { if (++wetSteps >= 8) { stopReason = 'waterlocked'; break; } }
    else wetSteps = 0;
    // Grotte percée sur le côté du couloir principal : bouchée (pas aux croisements, où la branche
    // va de toute façon creuser ce côté-là).
    if (sealCaves && !(i > 0 && i % branchSpacing === 0)) {
      try { await sealCaveOpenings(bot, footTarget, dir); } catch (e) { /* best-effort */ }
    }
    // Torches « joueur réel » (affinage Massii 07/06) : basées sur la LUMIÈRE + jitter — pose
    // SEULEMENT si l'endroit est sombre (< seuil spawn mob, lumière inconnue = sombre) et pas
    // de cadence métronomique (prochaine pose à torchEvery + 0..2 paliers aléatoires, cf. torchGap).
    if (i >= nextTorchAt) {
      nextTorchAt = i + torchGap();
      let light = 0;
      try {
        const cell = bot.blockAt(footTarget);
        if (cell && cell.light !== undefined && cell.light !== null) light = cell.light;
      } catch (e) { /* inconnue = sombre */ }
      if (light < 8) {
        try { await placeTorchLogged(bot, footTarget, light); } catch (e) { /* best-effort */ }
      }
    }

    // Branches latérales alternées à intervalles de branchSpacing — gauche puis droite (i et i+1 décalés).
    if (i > 0 && i % branchSpacing === 0) {
      for (const side of [left, { dx: -left.dx, dz: -left.dz }]) {
        for (let j = 1; j <= branchLength; j++) {
          if (stale()) return staleOut();
          if (token && token.cancelled) break;
          if (stopReached()) break outer;
          if (cobbleLow()) { stopReason = 'cobble_low'; break outer; }
          // Survie + détection de stall DANS la branche (bug review #4) : sans ça, une branche de
          // plusieurs minutes laissait le bot sans défense (mobs) et un blocage stallait 900s.
          if (checkStall()) { stopReason = 'stalled'; break outer; }
          if (onSurvivalTick && (j === 1 || j % survivalEvery === 0)) {
            try { await onSurvivalTick('branch' + j); } catch (e) { /* best-effort */ }
          }
          const ft = p(footTarget.x + side.dx * j, footTarget.y, footTarget.z + side.dz * j);
          const ht = p(ft.x, ft.y + 1, ft.z);
          // Approche aussi avant la branche — j peut monter à 8, donc range hors limite sans goto.
          await approach(bot, ft, 3, opts);
          if (stale()) return staleOut();
          // Anti-chute : trou de grotte dans la branche → ponté, sinon la branche s'arrête là.
          let floorOk = true;
          try { floorOk = await ensureFloor(bot, ft); } catch (e) { /* best-effort */ }
          if (!floorOk) break;                                         // branche suivante
          let branchWet = false;
          for (const t of [ft, ht]) {
            const r = await digStep(t);
            if (!r.ok && r.reason === 'water_ahead') branchWet = true;  // scellé best-effort
            if (!r.ok && r.reason === 'lava_unwallable') { stopReason = 'lava'; break outer; }
            if (!r.ok && r.reason === 'no_pickaxe') { stopReason = 'no_pickaxe'; break outer; }
            if (stale()) return staleOut();
          }
          // Fix n°2 water-wall : la branche a rencontré l'eau → on l'arrête LÀ (l'ancienne boucle
          // continuait à creuser j+1..branchLength DANS la nappe → inondation de la galerie).
          if (branchWet) break;
        }
      }
    }

    i++;
  }

  const oresAfter = snapshotOres(bot);
  const gotDiamond = oresAfter.diamond >= 1;
  return {
    // lava/drop = arrêts PROPRES (progrès partiel, l'appelant tourne le cap) — pas des échecs.
    ok: !stopReason || stopReason === 'lava' || stopReason === 'drop',
    gotDiamond,
    ores: deltaOres(oresBefore, oresAfter),
    reason: stopReason || undefined,
    heading: dir,
  };
}

function deltaOres(a, b) {
  return { diamond: Math.max(0, b.diamond - a.diamond), iron: Math.max(0, b.iron - a.iron), coal: Math.max(0, b.coal - a.coal) };
}

module.exports = { branchMine, bmBail, currentPhase, approach, cardinalFromYaw, leftOf, ORE_NAMES, WALL_BLOCKS, floodFillVein, oreFamily, sealCaveOpenings, placeTorchAt, CAVE_MIN_AIR, TORCH_JITTER, TORCH_CORNER_MIN };
