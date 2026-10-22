'use strict';
// CHASSE — PORTÉE ET MÉMOIRE DES TROUPEAUX (22/10, chrono « zéro → armure » de 61 min, 3 ouvriers).
//
// Mesure live : `hunt_cook_done` = 17× `no_prey:no_passive`, 5× `no_prey:hunt_failed`, 4 `ate` en 1 h
// pour 3 bots, alors que le serveur comptait 7 vaches, 11 cochons, 11 poules et 3 moutons à ≤ 160 blocs
// du spawn. Cause : la chasse ne regardait qu'à 32 blocs (`HUNT_SIGHT_RADIUS`) quand le serveur
// envoie les animaux jusqu'à 96 (`spigot.yml entity-tracking-range.animals: 96`, relevé sur l'Omen) —
// une vache à 40 blocs, DANS `bot.entities`, n'était pas « en vue ». Et l'expédition, seul recours
// au-delà, ne visait que des cellules de BIOME (« il y a peut-être des bêtes dans cette plaine »),
// jamais un endroit où un bot les avait VUES.
//
// Ce module est pur (aucun bot, aucune horloge en dur) :
//   • HUNT_REACH_RADIUS / HUNT_MAX_DY — ce qu'un joueur appelle « un animal que je vois » ;
//   • herdSightings  — les animaux de `bot.entities` regroupés par cellule de 32 blocs ;
//   • herds*         — la mémoire des troupeaux vus (mémo de base : survit aux morts et aux relances) ;
//   • pickHerd       — le troupeau connu le plus proche, cible de l'expédition AVANT les biomes.

// Portée de chasse = portée de suivi des animaux du serveur : au-delà, l'entité n'existe pas côté client.
const HUNT_REACH_RADIUS = 96;
// Une bête 20 blocs au-dessus ou en dessous est sur une falaise ou au fond d'une grotte : la poursuivre
// coûte la sortie entière pour rien (un `hunt_failed` de 20 s). On la laisse.
const HUNT_MAX_DY = 20;

const PASSIVE_NAMES = Object.freeze(['cow', 'pig', 'chicken', 'sheep', 'rabbit', 'mooshroom']);
const _PASSIVE = new Set(PASSIVE_NAMES);

const HERD_MEMO_KEY = 'herds';          // champ du mémo de base
const HERD_CELL = 32;                   // un troupeau tient dans une cellule de 32 blocs
// Les animaux ne réapparaissent pas, mais ils ne disparaissent pas non plus : ils broutent à quelques
// blocs de là où on les a vus. 1 h couvre la session ; au-delà, d'autres bots les ont peut-être mangés.
const HERD_TTL_MS = 60 * 60000;
const HERD_CAP = 16;                    // borné : la liste voyage dans le mémo de base
// Au-delà, l'aller coûte plus que la sortie ne rapporte : la marche de l'expédition est plafonnée à
// 75 s (foodTrip.FOOD_TRIP_MS) ≈ 250 blocs en terrain réel.
const HERD_MAX_DIST = 250;
// L'expédition vise un troupeau qu'on NE voit PAS d'ici : à moins de la portée de vue, il n'y est plus
// (sinon la chasse l'aurait pris). Un peu en dessous de 96 : le bord de la portée est flou.
const HERD_MIN_DIST = 64;
const HERD_FORGET_RADIUS = 48;          // arrivé sur place sans rien tuer : on oublie ce qui est autour

const _fin = (v) => typeof v === 'number' && Number.isFinite(v);

function _cellOf(v) { return Math.floor(v / HERD_CELL) * HERD_CELL; }

/** Cet animal est-il chassable d'ici ? (passif, vivant, à portée, pas sur une falaise). */
function isReachablePrey(e, self, { radius = HUNT_REACH_RADIUS, maxDy = HUNT_MAX_DY, names = null, avoid = null } = {}) {
  if (!e || !e.position || e.isValid === false || !self) return false;
  if (names ? !names.includes(e.name) : !_PASSIVE.has(e.name)) return false;
  if (avoid && e.id != null && avoid.has(e.id)) return false;
  const dx = e.position.x - self.x, dy = e.position.y - self.y, dz = e.position.z - self.z;
  if (!_fin(dx) || !_fin(dy) || !_fin(dz)) return false;
  if (Math.abs(dy) > maxDy) return false;
  return Math.hypot(dx, dy, dz) <= radius;
}

/**
 * Les animaux passifs de `entities` (objet ou tableau), regroupés par cellule de 32 blocs.
 * → [{ x, z, n, species:[…] }] (x/z = barycentre arrondi), le plus peuplé d'abord.
 */
function herdSightings(entities, self, { radius = HUNT_REACH_RADIUS } = {}) {
  if (!self) return [];
  const list = Array.isArray(entities) ? entities : Object.values(entities || {});
  const cells = new Map();
  for (const e of list) {
    if (!isReachablePrey(e, self, { radius, maxDy: Infinity })) continue;
    const k = `${_cellOf(e.position.x)},${_cellOf(e.position.z)}`;
    let c = cells.get(k);
    if (!c) { c = { sx: 0, sz: 0, n: 0, species: new Set() }; cells.set(k, c); }
    c.sx += e.position.x; c.sz += e.position.z; c.n++; c.species.add(e.name);
  }
  return [...cells.values()]
    .map((c) => ({ x: Math.round(c.sx / c.n), z: Math.round(c.sz / c.n), n: c.n, species: [...c.species].sort() }))
    .sort((a, b) => b.n - a.n || a.x - b.x || a.z - b.z);
}

/** La liste persistée, élaguée (TTL, entrées illisibles). */
function herdsPrune(list, now = Date.now()) {
  const out = [];
  for (const h of Array.isArray(list) ? list : []) {
    if (!h || !_fin(h.x) || !_fin(h.z) || !_fin(h.at)) continue;
    if (now - h.at > HERD_TTL_MS || h.at > now + 60000) continue;   // vieux, ou venu du futur (autre monde)
    out.push(h);
  }
  return out;
}

function herdsLoad(memo, now = Date.now()) {
  return herdsPrune(memo && typeof memo === 'object' ? memo[HERD_MEMO_KEY] : null, now);
}

/**
 * Fusionne des observations dans la liste : une observation remplace l'entrée de sa cellule
 * (position et effectif à jour). Bornée à HERD_CAP en gardant les plus récentes.
 */
function herdsMerge(list, sightings, now = Date.now()) {
  const map = new Map();
  for (const h of herdsPrune(list, now)) map.set(`${_cellOf(h.x)},${_cellOf(h.z)}`, h);
  for (const s of Array.isArray(sightings) ? sightings : []) {
    if (!s || !_fin(s.x) || !_fin(s.z) || !(s.n > 0)) continue;
    const k = `${_cellOf(s.x)},${_cellOf(s.z)}`;
    map.delete(k);                                     // ré-insertion = la plus récente en fin de liste
    map.set(k, { x: Math.round(s.x), z: Math.round(s.z), n: s.n, species: Array.isArray(s.species) ? s.species.slice(0, 6) : [], at: now });
  }
  const out = [...map.values()];
  return out.length > HERD_CAP ? out.slice(out.length - HERD_CAP) : out;
}

/**
 * Une passe d'observation : les troupeaux mémorisés tout près de nous (≤ `clearRadius`, bien dans la
 * portée de vue) qu'on ne voit plus sont oubliés — mangés, ou partis — puis les observations fusionnées.
 */
function herdsObserve(list, sightings, self, now = Date.now(), { clearRadius = HERD_FORGET_RADIUS } = {}) {
  const seen = new Set((Array.isArray(sightings) ? sightings : []).filter((s) => s && _fin(s.x) && _fin(s.z))
    .map((s) => `${_cellOf(s.x)},${_cellOf(s.z)}`));
  const kept = herdsPrune(list, now).filter((h) => !(self && _fin(self.x) && _fin(self.z)
    && Math.hypot(h.x - self.x, h.z - self.z) <= clearRadius && !seen.has(`${_cellOf(h.x)},${_cellOf(h.z)}`)));
  return herdsMerge(kept, sightings, now);
}

/** Oublie les troupeaux autour d'un point (on y est allé : il n'y avait rien à tuer). */
function herdsForget(list, at, radius = HERD_FORGET_RADIUS) {
  if (!at || !_fin(at.x) || !_fin(at.z)) return Array.isArray(list) ? list.slice() : [];
  return (Array.isArray(list) ? list : []).filter((h) => !(h && Math.hypot(h.x - at.x, h.z - at.z) <= radius));
}

/** La liste a-t-elle changé au point de valoir une écriture du mémo ? (nouvelle cellule, cellule perdue, effectif). */
function herdsChanged(prev, next) {
  const key = (l) => (Array.isArray(l) ? l : []).map((h) => `${_cellOf(h.x)},${_cellOf(h.z)}:${h.n}`).sort().join('|');
  return key(prev) !== key(next);
}

/**
 * Le troupeau connu le plus proche à viser, hors portée de vue et hors cellules ratées.
 * → { x, z, biome:'herd', dist, herd:true, n } | null — même forme que foodTrip.pickGrazingCell.
 */
function pickHerd(list, from, { minDist = HERD_MIN_DIST, maxDist = HERD_MAX_DIST, avoid = null, now = Date.now() } = {}) {
  if (!from || !_fin(from.x) || !_fin(from.z)) return null;
  const avoided = (h) => (Array.isArray(avoid) ? avoid : []).some((a) => a && _fin(a.x) && _fin(a.z)
    && Math.hypot(a.x - h.x, a.z - h.z) <= HERD_CELL);
  let best = null;
  for (const h of herdsPrune(list, now)) {
    const dist = Math.hypot(h.x - from.x, h.z - from.z);
    if (dist < minDist || dist > maxDist || avoided(h)) continue;
    if (!best || dist < best.dist || (dist === best.dist && (h.n || 0) > (best.n || 0))) {
      best = { x: h.x, z: h.z, biome: 'herd', dist, herd: true, n: h.n || 0 };
    }
  }
  return best;
}

module.exports = {
  HUNT_REACH_RADIUS, HUNT_MAX_DY, PASSIVE_NAMES,
  HERD_MEMO_KEY, HERD_CELL, HERD_TTL_MS, HERD_CAP, HERD_MAX_DIST, HERD_MIN_DIST, HERD_FORGET_RADIUS,
  isReachablePrey, herdSightings, herdsPrune, herdsLoad, herdsMerge, herdsObserve, herdsForget, herdsChanged, pickHerd,
};
