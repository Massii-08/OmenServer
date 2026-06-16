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
function buildGoal(x, y, z) {
  if (goals && goals.GoalNear) return new goals.GoalNear(x, y, z, 1);
  return { x, y, z };
}

async function descendDiagonal(bot, { targetY = -54, maxDepth = 200, onSurvivalTick = null, survivalEvery = 4 } = {}, token = null) {
  let reachedY = bot.entity && bot.entity.position ? bot.entity.position.y : 0;
  if (reachedY <= targetY) return { ok: true, reachedY };

  // Cap arrondi UNE FOIS au début — on garde l'alignement à la grille pour toute la descente.
  const dir = cardinalFromYaw(bot.entity.yaw || 0);
  let steps = 0;

  while (steps < maxDepth) {
    if (token && token.cancelled) return { ok: true, reachedY, cancelled: true };
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
      try { await bot.dig(t); } catch (e) { return { ok: false, reachedY, reason: 'dig_failed' }; }
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

module.exports = { descendDiagonal, cardinalFromYaw };
