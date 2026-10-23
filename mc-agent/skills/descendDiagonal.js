'use strict';
// Escalier diagonal 1×2 : à chaque palier, mine devant-bas (la marche) + devant (la tête)
// puis AVANCE physiquement via pathfinder.goto(GoalNear(footStepPos, 1)) — sinon le bot reste
// sur place et le dig du palier suivant tombe hors range (~6 blocs max, mineflayer).
// Anti-lave codé en dur : scan 5 voisins (devant, devant-bas, devant-haut, devant×2, devant-bas×2)
// avant CHAQUE dig. Vise Y target (-54 par défaut, juste au-dessus de la nappe de lave Y=-55→-63).
const { bestToolFor } = require('../tools');
const { cheapestPickFor } = require('../gear');
const { assessDrop, safeToDrop } = require('./fallCheck');     // saut « joueur réel » vs pont
const { DANGER, VOID } = require('./mineDown');                // mêmes ensembles → 1 source de vérité
// Vrai Vec3 pour bot.blockAt (leçon dcd874d, déjà appliquée à branchMine/tunnelTo — PAS ici :
// un POJO nu throw .floored en vrai mineflayer → mineFor 'error' en boucle, vécu phase 2).
let vec3; try { vec3 = require('vec3'); } catch (e) { vec3 = null; }
function _at(q) { return vec3 ? vec3(q.x, q.y, q.z) : q; }

// Pathfinder est requis ici uniquement pour le DÉPLACEMENT (digs faits à la main). Pas de canDig
// custom pour ne pas que pathfinder mine autre chose que les blocs déjà ouverts par notre dig.
let goals;
try { goals = require('mineflayer-pathfinder').goals; } catch (e) { goals = null; }

// Cap arrondi au plus proche des 4 cardinaux. yaw mineflayer : 0 = sud, -π/2 = est, π = nord, π/2 = ouest.
// On veut retourner {dx, dz} ∈ {(1,0), (-1,0), (0,1), (0,-1)}.
function cardinalFromYaw(yaw) {
  const norm = ((yaw % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
  const q = Math.round(norm / (Math.PI / 2)) % 4;
  // q=0 → sud (+z) ; q=1 → ouest (-x) ; q=2 → nord (-z) ; q=3 → est (+x). Mineflayer convention.
  if (q === 0) return { dx: 0, dz: 1 };
  if (q === 1) return { dx: -1, dz: 0 };
  if (q === 2) return { dx: 0, dz: -1 };
  return { dx: 1, dz: 0 };
}

const NO_PROGRESS_STEPS = 8;

// DIG INTERROMPU (23/10, NethBot1 session 408 : `descend_y16 dig_failed` ×8 en 10 min, 4 d'affilée au
// MÊME chantier y39, chacun ~0,3 s après le /home work). mineflayer n'a qu'UN dig à la fois : tout autre
// `bot.dig` (ramassage opportuniste du minerai à portée), une fuite de creeper ou un repas appelle
// `stopDigging` → le dig de l'escalier rejette « Digging aborted ». Ce n'est pas une impasse du terrain :
// on attend que la main soit libre et on retente le MÊME bloc, borné. Une erreur non transitoire
// (bloc incassable → « dig time … is Infinity ») échoue tout de suite. L'échec porte `err`.
const DIG_ATTEMPTS = 3;
const FOREIGN_DIG_WAIT_MS = 3000;   // dig d'un autre en cours : on le laisse finir (minerai = ~1-2 s)
const _sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function isTransientDigError(msg) { return /aborted/i.test(String(msg || '')); }

/** Attend que personne d'autre ne creuse (borné). */
async function waitHandFree(bot, maxMs, stepMs) {
  const t0 = Date.now();
  while (bot.targetDigBlock && Date.now() - t0 < maxMs) await _sleep(Math.max(1, stepMs));
}

/** Creuse `t` avec retry borné. → { ok:true } | { ok:false, err, cancelled? } */
async function digStep(bot, t, token, retryMs) {
  let lastErr = null;
  for (let attempt = 0; attempt < DIG_ATTEMPTS; attempt++) {
    if (token && token.cancelled) return { ok: false, cancelled: true, err: lastErr };
    await waitHandFree(bot, FOREIGN_DIG_WAIT_MS, Math.min(100, retryMs));
    // Relu à chaque essai : un autre a pu miner le bloc, ou de l'eau/lave a coulé dedans.
    const cur = attempt === 0 ? t : bot.blockAt(_at(t.position));
    if (!cur || VOID.has(cur.name)) return { ok: true };
    if (attempt > 0) {
      if (isWater(cur.name) || DANGER.has(cur.name)) return { ok: false, err: lastErr, fluid: cur.name };
      if (typeof bot.canDigBlock === 'function' && !bot.canDigBlock(cur)) return { ok: false, err: lastErr, why: 'out_of_reach' };
    }
    try { await bot.dig(cur); return { ok: true }; }
    catch (e) {
      lastErr = (e && e.message) ? String(e.message).slice(0, 80) : String(e);
      if (!isTransientDigError(lastErr)) return { ok: false, err: lastErr };
      await _sleep(retryMs);
    }
  }
  // Dernier essai avorté : le bloc a peut-être quand même cédé (dig fini côté serveur entre-temps).
  const after = bot.blockAt(_at(t.position));
  if (!after || VOID.has(after.name)) return { ok: true };
  return { ok: false, err: lastErr };
}   // paliers sans gagner 1 bloc de profondeur → `no_progress`

function isLava(name) { return name === 'lava' || name === 'flowing_lava'; }
function isWater(name) { return name === 'water' || name === 'flowing_water'; }

// Blocs de remblai pour ponter un vide (mêmes matériaux que le murage anti-lave de branchMine).
const BRIDGE_BLOCKS = ['cobblestone', 'cobbled_deepslate', 'dirt'];

/** Pose un bloc de remblai à `where` contre une face solide adjacente. true si posé. */
async function bridgeGap(bot, where) {
  const items = (bot.inventory && bot.inventory.items()) || [];
  const mat = items.find((i) => BRIDGE_BLOCKS.includes(i.name));
  if (!mat || typeof bot.placeBlock !== 'function') return false;
  const dirs = [[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]];
  for (const [dx, dy, dz] of dirs) {
    const ref = bot.blockAt(_at({ x: where.x - dx, y: where.y - dy, z: where.z - dz }));
    if (!ref || ref.boundingBox !== 'block') continue;
    try {
      await bot.equip(mat, 'hand');
      await bot.placeBlock(ref, { x: dx, y: dy, z: dz });
      return true;
    } catch (e) { /* autre face */ }
  }
  return false;
}

// Construit un GoalNear si pathfinder dispo (range=1 = arrive sur le bloc exact ou un voisin).
// Fallback : objet POJO accepté par notre fake-bot (tests).
// ⚠️ PUITS VERTICAL (live 22/10, NethBot3) : GoalNear(marche, 1) acceptait AUSSI le nœud « creuser
// sous ses pieds » — la case sous le bot est à distance 1 de la marche — et l'A* le préférait dès que le
// pas en avant coûtait un bloc de plus (marche non dégagée). Résultat mesuré : 30 paliers à x/z
// IDENTIQUES (y74→y44), un puits sous la base qui a tué 17 respawns. La fin exige donc la COLONNE de la
// marche (même x/z), à sa hauteur ou plus bas (saut survivable autorisé plus haut), jamais à côté.
function buildGoal(x, y, z) {
  if (goals && goals.GoalNear) {
    const g = new goals.GoalNear(x, y, z, 1);
    g.isEnd = (n) => !!n && n.x === x && n.z === z && n.y <= y && n.y >= y - 24;
    return g;
  }
  return { x, y, z };
}

// `stopWhen` (optionnel, () => bool, 21/10) : relu avant CHAQUE palier ; vrai → on s'arrête net avec
// {ok:true, stopped:true}. Sert à l'escalier « pierre » (stoneDig.js) : un joueur qui veut 30 cobble
// creuse un escalier jusqu'à les avoir, il ne descend pas jusqu'à Y16. Un prédicat qui lève = « non ».
async function descendDiagonal(bot, { targetY = -54, maxDepth = 200, onSurvivalTick = null, survivalEvery = 4, stopWhen = null, digRetryMs = 400 } = {}, token = null) {
  let reachedY = bot.entity && bot.entity.position ? bot.entity.position.y : 0;
  if (reachedY <= targetY) return { ok: true, reachedY };

  // Cap arrondi UNE FOIS au début — on garde l'alignement à la grille pour toute la descente.
  const dir = cardinalFromYaw(bot.entity.yaw || 0);
  let steps = 0;
  // SURPLACE (21/10, NethBot3 : `descend_y16` → `max_depth` ×19, chacun en 10-20 s) : 200 « paliers »
  // en 10 s = AUCUN palier réel — les cibles étaient air / invisibles (canSeeBlock) et le goto vers la
  // marche échouait aussitôt, donc `steps++` tournait à vide jusqu'à maxDepth. Un escalier descend d'un
  // bloc par palier : NO_PROGRESS_STEPS paliers sans gagner un bloc de profondeur = on est coincé ici,
  // échec NOMMÉ `no_progress` (positionnel → l'appelant tourne/se décale, cf. dropAhead.js).
  let bestY = Infinity;
  let stagnant = 0;

  while (steps < maxDepth) {
    if (token && token.cancelled) return { ok: true, reachedY, cancelled: true };
    if (typeof stopWhen === 'function') {
      let stop = false;
      try { stop = !!stopWhen(); } catch (e) { stop = false; }
      if (stop) return { ok: true, reachedY: bot.entity.position.y, stopped: true };
    }
    // SURVIE PENDANT LA DESCENTE (hole E / bug review #7) : la descente Y64→-58 dure plusieurs minutes,
    // pendant lesquelles AUCUNE survie ne tournait (réflexes event-driven seuls). Hook LÉGER tous les
    // survivalEvery paliers : combat/fuite/manger UNIQUEMENT (l'appelant n'y met PAS ensureTorches —
    // miner du charbon déplacerait le bot et désalignerait l'escalier). Best-effort, jamais bloquant.
    if (onSurvivalTick && steps % survivalEvery === 0) {
      try { await onSurvivalTick(steps); } catch (e) { /* survie best-effort */ }
    }

    const p = bot.entity.position;
    const fx = Math.floor(p.x);
    const fy = Math.floor(p.y);
    const fz = Math.floor(p.z);
    reachedY = p.y;
    if (p.y <= targetY) return { ok: true, reachedY };
    if (fy < bestY) { bestY = fy; stagnant = 0; }
    else if (++stagnant >= NO_PROGRESS_STEPS) return { ok: false, reachedY, reason: 'no_progress', steps };

    // 5 sondages anti-lave/anti-cave : devant-bas (cible escalier), devant (yeux), devant-haut,
    // devant×2 (à voir si grotte plus loin), devant-bas×2 (idem niveau pied).
    const ahead = { x: fx + dir.dx, y: fy, z: fz + dir.dz };
    const aheadLow = { x: ahead.x, y: fy - 1, z: ahead.z };
    const aheadHigh = { x: ahead.x, y: fy + 1, z: ahead.z };
    const ahead2 = { x: fx + 2 * dir.dx, y: fy, z: fz + 2 * dir.dz };
    const ahead2Low = { x: ahead2.x, y: fy - 1, z: ahead2.z };

    const probes = [ahead, aheadLow, aheadHigh, ahead2, ahead2Low].map((q) => bot.blockAt(_at(q)));
    for (const b of probes) {
      if (b && isLava(b.name)) return { ok: false, reachedY, reason: 'lava_ahead' };
      // EAU devant (anti-noyade descente, BUG live 16/06) : une poche d'aquifère localisée → on
      // TOURNE (l'appelant longe 8 blocs dans une nouvelle direction), jamais creuser/avancer dedans.
      if (b && isWater(b.name)) return { ok: false, reachedY, reason: 'water_ahead' };
    }
    // À Y≤-50, l'air devant signale grotte/lave/chute → on s'arrête (cf. spec §3 anti-lave).
    if (p.y <= -49) {
      for (const b of probes) {
        if (b && VOID.has(b.name)) return { ok: false, reachedY, reason: 'air_at_y_-50' };
      }
    }

    // ANTI-CHUTE « joueur réel » (affinage Massii 07/06) : vide ≥2 sous la marche → on évalue
    // la chute. Survivable (dégâts ≤ ½ PV, ou EAU en bas) ET pas d'overshoot sous targetY →
    // on SAUTE (la chute est un raccourci de descente, bien plus rapide qu'un pont). Sinon
    // pont (remblai) ; pose impossible → drop_ahead (l'appelant tourne).
    {
      const under1 = bot.blockAt(_at({ x: aheadLow.x, y: aheadLow.y - 1, z: aheadLow.z }));
      const under2 = bot.blockAt(_at({ x: aheadLow.x, y: aheadLow.y - 2, z: aheadLow.z }));
      if (under1 && VOID.has(under1.name) && under2 && VOID.has(under2.name)) {
        const a = assessDrop(bot, { x: aheadLow.x, y: aheadLow.y - 1, z: aheadLow.z },
          { blockAt: (q) => bot.blockAt(_at(q)) });
        const noOvershoot = (aheadLow.y - 1 - a.depth) >= targetY - 6;
        // EAU en bas (anti-noyade descente, BUG live 16/06) : safeToDrop la croit sûre (anti dégâts de
        // chute) MAIS une nappe profonde NOIE. On ne SAUTE JAMAIS dans l'eau en descente → pont ; sans
        // pont possible → water_ahead (l'appelant tourne), jamais le saut noyade.
        const landingWater = (a.surface === 'water');
        if (landingWater || !(safeToDrop(a, bot.health) && noOvershoot)) {
          const bridged = await bridgeGap(bot, { x: aheadLow.x, y: aheadLow.y - 1, z: aheadLow.z });
          if (!bridged) return { ok: false, reachedY, reason: landingWater ? 'water_ahead' : 'drop_ahead' };
        }
        // sinon : on laisse le pas se faire — le bot tombe, la boucle reprend du nouveau y
      }
    }

    // SANS PIOCHE : on ne creuse JAMAIS la roche à la main (~9 s/bloc deepslate, absurde —
    // vécu V3Res4). L'appelant déclenche la récupération de pioche.
    if (!((bot.inventory && bot.inventory.items()) || []).some((i) => i.name && i.name.endsWith('_pickaxe'))) {
      return { ok: false, reachedY, reason: 'no_pickaxe' };
    }
    // Cibles à miner : DEVANT (les yeux, face adjacente visible) PUIS devant-bas — l'ordre
    // inverse minait la marche À TRAVERS LE COIN (irréaliste, vécu V3Res3). Chaque dig est
    // gaté reachability (ligne de vue + portée) quand mineflayer expose les checks.
    const targets = [ahead, aheadLow].map((q) => bot.blockAt(_at(q)));
    for (const t of targets) {
      if (!t) continue;                                       // unloaded → skip
      if (VOID.has(t.name)) continue;                         // déjà air → rien à faire
      if (isWater(t.name)) return { ok: false, reachedY, reason: 'water_ahead' };  // ne JAMAIS creuser dans l'eau
      if (DANGER.has(t.name)) return { ok: false, reachedY, reason: 'lava_ahead' };
      // Reachability « vrai joueur » : pas de minage en diagonale à travers un coin.
      if (typeof bot.canSeeBlock === 'function' && !bot.canSeeBlock(t)) continue; // re-tenté après le bloc visible
      if (typeof bot.canDigBlock === 'function' && !bot.canDigBlock(t)) continue;
      // Pioche la moins chère pour la roche (durabilité fer > gain de vitesse, vécu V3Res1) +
      // equip avec cache (phase 3) : ne ré-équipe pas l'outil déjà en main.
      const pickName = cheapestPickFor((bot.inventory && bot.inventory.items()) || [], t.name);
      let tool = pickName ? ((bot.inventory && bot.inventory.items()) || []).find((i) => i.name === pickName) : null;
      if (!tool) tool = bestToolFor(bot, t);
      if (tool && !(bot.heldItem && bot.heldItem.name === tool.name)) {
        try { await bot.equip(tool, 'hand'); } catch (e) {}
      }
      const d = await digStep(bot, t, token, digRetryMs);
      if (d.cancelled) return { ok: true, reachedY, cancelled: true };
      if (d.fluid) return { ok: false, reachedY, reason: isWater(d.fluid) ? 'water_ahead' : 'lava_ahead' };
      if (!d.ok) return { ok: false, reachedY, reason: 'dig_failed', err: d.err || d.why || 'unknown' };
    }

    // AVANCE : pathfinder.goto vers la marche (devant-bas) — c'est le seul moyen FIABLE de
    // déplacer le bot horizontalement en prod (mineflayer écrase toute mutation directe de
    // bot.entity.position au tick suivant). En tests, le fake-bot simule le téléport.
    if (bot.pathfinder && bot.pathfinder.goto) {
      try {
        await bot.pathfinder.goto(buildGoal(aheadLow.x, aheadLow.y, aheadLow.z));
      } catch (e) { /* cible peut être inaccessible ponctuellement — on retentera au prochain tour */ }
    }

    steps++;
  }

  return { ok: false, reachedY, reason: 'max_depth' };
}

module.exports = { descendDiagonal, cardinalFromYaw, NO_PROGRESS_STEPS, buildGoal, DIG_ATTEMPTS, isTransientDigError };
