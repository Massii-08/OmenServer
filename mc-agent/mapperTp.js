'use strict';
// TP-AU-MAPPEUR (Massii 15/07) : les mappeurs explorent LOIN du spawn (frontière/warp) pendant
// que les bots ressource (re)partent du spawn à pied — des minutes de marche mortelle en hard.
// Un /tpa vers un mappeur (auto-accepté entre bots du même groupe, cf. policy.group_bots) est un
// raccourci 100 % « vrai joueur » : aucune commande admin, passe nogive (/tpa ≠ /tp<espace>).
// Décision PURE : à qui demander le TP ? (l'exécution — /tpa + awaitWarp — vit dans index.js)

const FRESH_MS = 180000;   // présence plus vieille que 3 min = bot probablement mort/déco
const MIN_GAIN = 150;      // avec cible : le TP doit RAPPROCHER d'au moins 150 blocs
const MIN_FAR = 250;       // sans cible : un mappeur à <250 ne vaut pas un /tpa (marche directe)

function _d(ax, az, bx, bz) { return Math.hypot(ax - bx, az - bz); }

/**
 * pickMapperTp({self:{x,z}, selfName?, goal:{x,z}|null, mappers:[{name,x,z,role,at}], now, opts})
 *   → {name, gain} | null
 * - avec goal : le mappeur le plus proche de la CIBLE, si le TP fait gagner ≥ minGain blocs ;
 * - sans goal : le mappeur le plus LOIN de moi, s'il est à ≥ minFar (aller vers la frontière).
 */
function pickMapperTp({ self, selfName, goal, mappers, now, opts = {} } = {}) {
  if (!self) return null;
  const freshMs = opts.freshMs || FRESH_MS;
  const minGain = opts.minGain || MIN_GAIN;
  const minFar = opts.minFar || MIN_FAR;
  const t = now || Date.now();
  const cands = (mappers || []).filter((m) => m
    && m.role === 'mapper'
    && m.name && m.name !== selfName
    && typeof m.x === 'number' && typeof m.z === 'number'
    && (t - (m.at || 0)) <= freshMs);
  if (!cands.length) return null;

  if (goal) {
    const selfToGoal = _d(self.x, self.z, goal.x, goal.z);
    let best = null, bestD = Infinity;
    for (const m of cands) {
      const d = _d(m.x, m.z, goal.x, goal.z);
      if (d < bestD) { bestD = d; best = m; }
    }
    const gain = selfToGoal - bestD;
    if (!best || gain < minGain) return null;
    return { name: best.name, gain: Math.round(gain) };
  }

  let best = null, bestD = 0;
  for (const m of cands) {
    const d = _d(m.x, m.z, self.x, self.z);
    if (d > bestD) { bestD = d; best = m; }
  }
  if (!best || bestD < minFar) return null;
  return { name: best.name, gain: Math.round(bestD) };
}

module.exports = { pickMapperTp, MIN_GAIN, MIN_FAR };
