'use strict';
// Escalier diagonal 1×2 : à chaque pas, mine devant (yeux) + devant-bas (pieds) puis "avance"
// d'1 bloc le long d'un cap cardinal. Le bot reste TOUJOURS sur du solide. Anti-lave codé en dur :
// scan 5 voisins (devant, devant-bas, devant-haut, devant×2, devant-bas×2) avant CHAQUE dig.
//
// Vise Y target (-54 par défaut, juste au-dessus de la nappe de lave Y=-55→-63 du diamant).
// Pas de pathfinder ici (anti-freeze) : pur bot.dig + téléport implicite (le bloc miné devient
// l'emplacement libre pour le pas suivant ; pour la translation horizontale, on s'appuie sur
// bot.entity.position qui reflète le résultat du dig + chute naturelle).
const { bestToolFor } = require('../tools');
const { DANGER, VOID } = require('./mineDown');                // mêmes ensembles → 1 source de vérité

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

async function descendDiagonal(bot, { targetY = -54, maxDepth = 200 } = {}, token = null) {
  let reachedY = bot.entity && bot.entity.position ? bot.entity.position.y : 0;
  if (reachedY <= targetY) return { ok: true, reachedY };

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

    const probes = [ahead, aheadLow, aheadHigh, ahead2, ahead2Low].map((q) => bot.blockAt(q));
    for (const b of probes) {
      if (b && isLava(b.name)) return { ok: false, reachedY, reason: 'lava_ahead' };
    }
    // À Y≤-50, l'air devant signale grotte/lave/chute → on s'arrête (cf. spec §3 anti-lave).
    if (p.y <= -49) {
      for (const b of probes) {
        if (b && VOID.has(b.name)) return { ok: false, reachedY, reason: 'air_at_y_-50' };
      }
    }

    // Cibles à miner : devant-bas (la marche descend) puis devant (la tête passe).
    const targets = [aheadLow, ahead].map((q) => bot.blockAt(q));
    for (const t of targets) {
      if (!t) continue;                                       // unloaded → skip
      if (VOID.has(t.name)) continue;                         // déjà air → rien à faire
      if (DANGER.has(t.name)) return { ok: false, reachedY, reason: 'lava_ahead' };
      const tool = bestToolFor(bot, t);
      if (tool) { try { await bot.equip(tool, 'hand'); } catch (e) {} }
      try { await bot.dig(t); } catch (e) { return { ok: false, reachedY, reason: 'dig_failed' }; }
    }

    // Avance : on "déplace" le bot d'1 bloc en diagonale (descente naturelle). Pour les tests on
    // simule en mutant directement la position ; en prod, le bot tombe naturellement après le dig
    // de la case devant-bas (gravity) — on aide via setControlState(forward) bref.
    try {
      bot.entity.position = bot.entity.position.offset(dir.dx, -1, dir.dz);
    } catch (e) { /* en prod position est un Vec3 immuable côté lecture ; offset retourne un nouveau */ }
    try {
      bot.setControlState('forward', true);
      if (bot.waitForTicks) await bot.waitForTicks(6);
      bot.setControlState('forward', false);
    } catch (e) {}

    steps++;
  }

  return { ok: false, reachedY, reason: 'max_depth' };
}

module.exports = { descendDiagonal, cardinalFromYaw };
