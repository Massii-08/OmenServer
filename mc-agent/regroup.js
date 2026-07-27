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

// ⚠️ LE CHEF DOIT ÊTRE CELUI QUI TRAVAILLE (Massii, live 27/07) : « les bots qui sont en
// difficulté ou qui ne font rien doivent se tp vers ceux qui sont SOUS TERRE et qui farment le
// fer pour les aider — le team fonctionne mais ils se tp aux bots en SURFACE donc ils ne
// descendent jamais ». Le critère alphabétique était déterministe mais AVEUGLE : si le bot au nom
// le plus petit traînait en surface, toute la squad remontait le rejoindre et plus personne ne
// minait. On garde le déterminisme (indispensable : chacun calcule le même chef sans se
// coordonner) en changeant simplement la clé de tri — le TRAVAIL d'abord, le nom en départage.
const UNDERGROUND_Y = 40;   // sous ce niveau on est dans la mine, pas en balade

/** Ce coéquipier est-il un mineur AU TRAVAIL ? (sous terre ET produisant du fer dans sa zone) */
function _isWorkingMiner(m) {
  return !!m && Number.isFinite(m.y) && m.y <= UNDERGROUND_Y && (m.ironZone || 0) > 0;
}

/**
 * PUR — le chef de la squad, déterministe (les N bots désignent le même sans se parler) :
 *   1. le MINEUR SOUTERRAIN le plus productif (le travail prime) ;
 *   2. à productivité égale, le nom le plus petit ;
 *   3. si personne ne mine, l'ancien critère alphabétique seul.
 * `self` (optionnel) permet au bot de se compter comme mineur — sinon un mineur productif
 * remonterait rejoindre un flâneur.
 */
function squadLeader({ selfName, mates, now, self, freshMs = FRESH_MS } = {}) {
  const t = now || Date.now();
  const all = [];
  if (selfName) all.push(Object.assign({}, self || {}, { name: String(selfName) }));
  for (const m of mates || []) {
    if (!m || !m.name || m.role === 'mapper') continue;      // les mappeurs sont ailleurs par métier
    if ((t - (m.at || 0)) > freshMs) continue;                // mort ou déconnecté
    all.push(m);
  }
  if (!all.length) return null;

  const miners = all.filter(_isWorkingMiner);
  const pool = miners.length ? miners : all;
  let best = null;
  for (const m of pool) {
    if (!best) { best = m; continue; }
    // Tri déterministe : productivité DESC, puis nom ASC. Jamais l'ordre du tableau.
    const dIron = (m.ironZone || 0) - (best.ironZone || 0);
    if (miners.length ? (dIron > 0 || (dIron === 0 && String(m.name) < String(best.name)))
      : String(m.name) < String(best.name)) best = m;
  }
  return best ? String(best.name) : null;
}

/**
 * PUR — faut-il rejoindre la squad maintenant ? {name, dist} ou null.
 * null quand : je SUIS le chef · pas de chef · déjà assez près · cooldown · armure complète
 * (une fois équipé, la règle historique de Massii reste « chacun reprend sa route »).
 */
function squadTarget({
  self, selfName, mates, armorComplete, now, lastAt, busy,
  near = SQUAD_NEAR, cooldownMs = SQUAD_COOLDOWN_MS, freshMs = FRESH_MS,
} = {}) {
  // busy = minage/tâche longue en cours. Piège #42c : tp'er un bot en plein goto rejette la
  // promesse pathfinder → unreachable → il RELÂCHE sa claim et repart explorer. L'enforcement
  // confine respectait déjà ce garde-fou (shouldEnforceConfine) ; le squad, non → il yankait les
  // mineurs. On diffère : le confine tient la poche, le prochain tick libre resserrera la squad.
  if (!self || armorComplete || busy) return null;
  const t = now || Date.now();
  if (lastAt && (t - lastAt) < cooldownMs) return null;
  const leader = squadLeader({ selfName, mates, now: t, self, freshMs });
  if (!leader || leader === String(selfName)) return null;   // le chef ne suit personne
  const m = (mates || []).find((x) => x && x.name === leader
    && typeof x.x === 'number' && typeof x.z === 'number');
  if (!m) return null;
  // ⚠️ LA VERTICALE COMPTE (mesuré live 27/07). `_d` est horizontale : un bot de SURFACE à 17
  // blocs à plat d'un mineur à y=12 était jugé « déjà assez près » — alors qu'il y a 44 blocs de
  // ROCHE entre eux et qu'il ne descendra jamais tout seul. C'est exactement ce que Massii
  // voyait : « il y a neth 4-5 qui sont toujours en surface » alors que le chef était bien le
  // mineur. On mesure donc en 3D quand les deux altitudes sont connues ; sinon on garde le
  // comportement horizontal d'origine (rétro-compat des présences sans `y`).
  const dxz = _d(m.x, m.z, self.x, self.z);
  const dy = (Number.isFinite(m.y) && Number.isFinite(self.y)) ? Math.abs(m.y - self.y) : 0;
  const d = Math.hypot(dxz, dy);
  // Le chef est au FOND, moi en surface → je descends, quelle que soit la distance à plat.
  // C'est tout l'objet de la demande : « les bots qui ne font rien doivent se tp vers ceux qui
  // sont sous terre ». Un seuil de distance ne peut pas exprimer ça — mesuré live, NethBot4 était
  // à 17 blocs à plat (donc « assez près ») et 44 blocs de roche au-dessus du seul mineur du run.
  const leaderIsUnderground = _isWorkingMiner(m);
  const iAmUnderground = Number.isFinite(self.y) && self.y <= UNDERGROUND_Y;
  if (leaderIsUnderground && !iAmUnderground) return { name: leader, dist: Math.round(d) };
  if (d <= near) return null;
  return { name: leader, dist: Math.round(d) };
}

module.exports = {
  pickRegroupTarget, FRESH_MS, MIN_FAR, COOLDOWN_MS,
  squadLeader, squadTarget, SQUAD_NEAR, SQUAD_COOLDOWN_MS, UNDERGROUND_Y,
};
