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

// ─── SQUAD : rester ENSEMBLE, pas seulement se retrouver après une mort ─────────────────────────
// Massii 2026-07-26 : « ils ne sont toujours pas ensemble, j'ai vraiment envie qu'ils soient une
// petite squad qui reste ensemble ».
//
// Pourquoi `pickRegroupTarget` ne suffisait pas, mesuré : il ne déclenche qu'à ≥120 blocs d'écart,
// au plus une fois toutes les 2 min, et chaque bot vise « le coéquipier le PLUS PROCHE » — donc les
// bots se courent après (A rejoint B pendant que B rejoint C) au lieu de converger, et entre deux
// déclenchements ils repartent chacun vers son bois. Résultat : une oscillation permanente entre
// 0 et 120 blocs, jamais une squad.
//
// Deux changements de fond :
//   1. UN CHEF DÉTERMINISTE (le nom le plus petit parmi les présences fraîches, self inclus) : tout
//      le monde calcule le MÊME chef sans se coordonner, donc tout le monde converge au même point.
//      Le chef, lui, ne suit personne — sinon la squad se déplace en fuyant sa propre queue.
//   2. UN SEUIL SERRÉ (64 blocs au lieu de 120) et un cooldown court (60 s au lieu de 120 s) :
//      c'est ce qui fait la différence entre « on finit par se revoir » et « on reste ensemble ».
const SQUAD_NEAR = 64;         // au-delà de cette distance du chef, on le rejoint
const SQUAD_COOLDOWN_MS = 30000;   // 30 s : mesuré, à 60 s couplé à une boucle de 90 s ils dérivaient de 300-480 blocs entre deux contrôles

/**
 * PUR — le chef de la squad : le nom le plus petit (ordre lexicographique) parmi les ouvriers
 * présents et frais, self inclus. Déterministe ⇒ les 3 bots désignent le même sans se parler.
 * Retourne null s'il n'y a personne (ni self valide, ni coéquipier).
 */
function squadLeader({ selfName, mates, now, freshMs = FRESH_MS } = {}) {
  const t = now || Date.now();
  const names = [];
  if (selfName) names.push(String(selfName));
  for (const m of mates || []) {
    if (!m || !m.name || m.role === 'mapper') continue;      // les mappeurs sont ailleurs par métier
    if ((t - (m.at || 0)) > freshMs) continue;                // mort ou déconnecté
    names.push(String(m.name));
  }
  if (!names.length) return null;
  names.sort();
  return names[0];
}

/**
 * PUR — faut-il rejoindre la squad maintenant ? {name, dist} ou null.
 * null quand : je SUIS le chef · pas de chef · déjà assez près · cooldown · armure complète
 * (une fois équipé, la règle historique de Massii reste « chacun reprend sa route »).
 */
function squadTarget({
  self, selfName, mates, armorComplete, now, lastAt,
  near = SQUAD_NEAR, cooldownMs = SQUAD_COOLDOWN_MS, freshMs = FRESH_MS,
} = {}) {
  if (!self || armorComplete) return null;
  const t = now || Date.now();
  if (lastAt && (t - lastAt) < cooldownMs) return null;
  const leader = squadLeader({ selfName, mates, now: t, freshMs });
  if (!leader || leader === String(selfName)) return null;   // le chef ne suit personne
  const m = (mates || []).find((x) => x && x.name === leader
    && typeof x.x === 'number' && typeof x.z === 'number');
  if (!m) return null;
  const d = _d(m.x, m.z, self.x, self.z);
  if (d <= near) return null;
  return { name: leader, dist: Math.round(d) };
}

module.exports = {
  pickRegroupTarget, FRESH_MS, MIN_FAR, COOLDOWN_MS,
  squadLeader, squadTarget, SQUAD_NEAR, SQUAD_COOLDOWN_MS,
};
