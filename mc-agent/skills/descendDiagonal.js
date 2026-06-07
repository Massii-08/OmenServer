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

async function descendDiagonal(bot, { targetY = -54, maxDepth = 200 } = {}, token = null) {
  let reachedY = bot.entity && bot.entity.position ? bot.entity.position.y : 0;
  if (reachedY <= targetY) return { ok: true, reachedY };

  // Cap arrondi UNE FOIS au début — on garde l'alignement à la grille pour toute la descente.
  const dir = cardinalFromYaw(bot.entity.yaw || 0);
  let steps = 0;

  while (steps < maxDepth) {
    if (token && token.cancelled) return { ok: true, reachedY, cancelled: true };

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
        if (!(safeToDrop(a, bot.health) && noOvershoot)) {
          const bridged = await bridgeGap(bot, { x: aheadLow.x, y: aheadLow.y - 1, z: aheadLow.z });
          if (!bridged) return { ok: false, reachedY, reason: 'drop_ahead' };
        }
        // sinon : on laisse le pas se faire — le bot tombe, la boucle reprend du nouveau y
      }
    }

    // Cibles à miner : devant-bas (la marche descend) puis devant (la tête passe).
    const targets = [aheadLow, ahead].map((q) => bot.blockAt(_at(q)));
    for (const t of targets) {
      if (!t) continue;                                       // unloaded → skip
      if (VOID.has(t.name)) continue;                         // déjà air → rien à faire
      if (DANGER.has(t.name)) return { ok: false, reachedY, reason: 'lava_ahead' };
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
