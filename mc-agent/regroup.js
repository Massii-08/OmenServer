'use strict';
// REGROUPEMENT APRÈS MORT (idée Massii 25/07) : « qu'ils restent en groupe jusqu'à ce que chacun
// ait une armure en fer — si un meurt, il se retp aux autres ».
//
// Pourquoi ça vaut le coup : avec keepInventory, mourir ne coûte presque RIEN (l'inventaire suit) —
// ce qui coûte, c'est le RETOUR à pied depuis le point de réapparition, souvent 200-400 blocs à
// travers les mobs, qui se solde régulièrement par une 2e mort (spirale vécue : 8 morts en 4 min).
// Un /tpa vers un coéquipier supprime exactement ce trajet. C'est 100 % « vrai joueur » : aucune
// commande admin, et /tpa passe le filtre sans-give (≠ /tp<espace>).
//
// Ce module ne fait QUE décider (pur, testable). L'exécution — /tpa + awaitWarp — vit dans index.js,
// exactement comme mapperTp/pickMapperTp.

const FRESH_MS = 180000;    // présence plus vieille que 3 min = coéquipier mort ou déconnecté
const MIN_FAR = 120;        // en-deçà, marcher est plus sûr qu'un /tpa (et moins spammy)
const COOLDOWN_MS = 120000; // anti-spam : au plus un regroupement par 2 min

function _d(ax, az, bx, bz) { return Math.hypot(ax - bx, az - bz); }

/**
 * PUR — à qui demander le /tpa pour rejoindre le groupe après une mort ? null = personne / inutile.
 *
 * Différence de fond avec pickMapperTp : celui-ci cherche le mappeur le plus LOIN (aller vers la
 * frontière) ; ici on veut le coéquipier le PLUS PROCHE (se regrouper coûte le moins de trajet et
 * ramène le bot vers la zone déjà sécurisée/minée par le groupe).
 *
 * @param {{self:{x:number,z:number}, selfName:string, mates:Array, armorComplete:boolean,
 *          now:number, lastAt:number, opts:object}} p
 * @returns {{name:string, dist:number}|null}
 */
function pickRegroupTarget({ self, selfName, mates, armorComplete, now, lastAt, opts = {} } = {}) {
  if (!self) return null;
  // Règle Massii : le groupe ne sert que TANT QUE l'armure n'est pas là. Une fois équipé, le bot
  // reprend sa route seul (sinon 3 bots se marchent dessus dans la même mine à vie).
  if (armorComplete) return null;
  const t = now || Date.now();
  const freshMs = opts.freshMs || FRESH_MS;
  const minFar = opts.minFar || MIN_FAR;
  const cooldownMs = opts.cooldownMs === undefined ? COOLDOWN_MS : opts.cooldownMs;
  if (lastAt && (t - lastAt) < cooldownMs) return null;

  const cands = (mates || []).filter((m) => m
    && m.name && m.name !== selfName
    && m.role !== 'mapper'                                  // les mappeurs sont AILLEURS par métier
    && typeof m.x === 'number' && typeof m.z === 'number'
    && (t - (m.at || 0)) <= freshMs);
  if (!cands.length) return null;

  let best = null, bestD = Infinity;
  for (const m of cands) {
    const d = _d(m.x, m.z, self.x, self.z);
    if (d < bestD) { bestD = d; best = m; }
  }
  // Trop près = le trajet ne justifie pas un TP (et on éviterait un aller-retour absurde).
  if (!best || bestD < minFar) return null;
  return { name: best.name, dist: Math.round(bestD) };
}

module.exports = { pickRegroupTarget, FRESH_MS, MIN_FAR, COOLDOWN_MS };
