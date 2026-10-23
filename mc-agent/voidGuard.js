'use strict';
// ─── GARDE ANTI-VIDE (live 22/10, NethBot3 : 17 « fell from a high place » en 40 min) ─────────────
// Mécanisme prouvé par les logs : la migration de zone pose base + /spawnpoint + home `safe` en
// (-343,75,359) ; plus tard une tranche 'mine' du bûcheron part de CE point (/home safe → descente),
// creuse un puits VERTICAL y74→y44 sous la base (branchMine:enter à x/z identiques, y43.9). Dès lors
// chaque respawn tombe 32 blocs dans son propre puits — et le respawn suivant posait même `safe` EN
// PLEIN VOL (safe_home_set y59), d'où le « teleport destination is unsafe » d'Essentials.
// Ce module est PUR (lecture de blocs injectée) : sol sous les pieds, case sûre la plus proche,
// distance aux ancres (base/home), décalage de départ de descente, message de mort par chute et
// boucle de mort par chute au même endroit.

const PASSABLE = /(^|_)(air|water|lava|fire|torch|button|lever|sign|banner|carpet|flower|sapling|grass$|short_grass|tall_grass|fern|vine|rail|pressure_plate|snow$|cobweb|bubble_column|kelp|seagrass|dead_bush|mushroom$|sugar_cane|wheat|carrots|potatoes|beetroots|tripwire|string|redstone_wire|light$|structure_void|moss_carpet)/;
const FLUID = /(^|_)(water|lava|bubble_column)$/;

/** Bloc PLEIN sur lequel on peut se tenir (ni air, ni fluide, ni plante/torche…). null = inconnu. */
function isSolid(b) {
  if (!b || !b.name) return null;
  if (FLUID.test(b.name)) return false;
  if (b.boundingBox === 'block') return true;
  if (b.boundingBox === 'empty') return false;
  return !PASSABLE.test(b.name);
}

/** Case où les pieds/la tête peuvent se tenir (ni plein, ni fluide). */
function isClear(b) {
  if (!b || !b.name) return false;
  if (FLUID.test(b.name)) return false;
  return isSolid(b) === false;
}

const _fl = (p) => ({ x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) });

/**
 * Sol sous les pieds : `need` blocs PLEINS d'affilée sous la case des pieds.
 * → { ok:true } | { ok:false, reason:'void_below', solid:n } | { ok:null, reason:'unknown' } (chunk illisible).
 */
function groundCheck(blockAt, pos, need = 2) {
  if (typeof blockAt !== 'function' || !pos || !Number.isFinite(pos.x) || !Number.isFinite(pos.y)) {
    return { ok: null, reason: 'unknown' };
  }
  const f = _fl(pos);
  let solid = 0;
  for (let i = 1; i <= need; i++) {
    let b = null;
    try { b = blockAt({ x: f.x, y: f.y - i, z: f.z }); } catch (e) { b = null; }
    const s = isSolid(b);
    if (s === null) return { ok: null, reason: 'unknown', solid };
    if (!s) return { ok: false, reason: 'void_below', solid };
    solid++;
  }
  return { ok: true, solid };
}

/**
 * Profondeur de vide sous les pieds (0 = debout sur un plein). Un FLUIDE arrête la mesure (on y atterrit
 * sans dégâts de chute). Plafonnée à `max`. Bloc illisible (chunk pas encore reçu) avant tout appui →
 * null (« on ne sait pas » : jamais un verdict de vide sur un chunk absent).
 */
function dropDepth(blockAt, pos, max = 40) {
  if (typeof blockAt !== 'function' || !pos) return null;
  const f = _fl(pos);
  for (let d = 0; d < max; d++) {
    let b = null;
    try { b = blockAt({ x: f.x, y: f.y - 1 - d, z: f.z }); } catch (e) { b = null; }
    if (!b || !b.name) return null;
    if (FLUID.test(b.name) || isSolid(b)) return d;
  }
  return max;
}

/**
 * PUR — une arrivée (respawn, /home, /tpa) au-dessus de `drop` blocs de vide est-elle DANGEREUSE ?
 * (live 23/10, NethBot1 : réapparition à 4 blocs au-dessus du sol — feuillage, petite marche — lue comme
 * « au-dessus du vide » : `/delhome safe` et ré-ancrage forcé à CHAQUE vie.) Une chute de ≤ 4 blocs coûte
 * au plus un cœur : ce n'est pas du vide. Dangereux = > 4 blocs (ou plafond de mesure atteint), ou
 * profondeur illisible ALORS QUE le chunk est chargé (`chunkLoaded === true`). Illisible faute de chunk →
 * pas de verdict (false).
 */
const SAFE_LANDING_DROP = 4;
function dangerousDrop(drop, opts = {}) {
  if (drop === null || drop === undefined) return !!(opts && opts.chunkLoaded === true);
  if (typeof drop !== 'number' || Number.isNaN(drop)) return false;
  return drop > SAFE_LANDING_DROP;
}

/**
 * Case sûre la plus proche (rayon `radius` en X/Z, ±2 en Y) : pieds + tête dégagés, `need` pleins dessous.
 * Rend {x,y,z} (coordonnées de BLOC des pieds) ou null. Ordre déterministe (distance, puis x, z, y).
 */
function nearestSafeStand(blockAt, pos, radius = 4, need = 2) {
  if (typeof blockAt !== 'function' || !pos) return null;
  const f = _fl(pos);
  const cands = [];
  for (let dx = -radius; dx <= radius; dx++) {
    for (let dz = -radius; dz <= radius; dz++) {
      if (dx * dx + dz * dz > radius * radius) continue;
      for (let dy = 2; dy >= -2; dy--) {
        cands.push({ x: f.x + dx, y: f.y + dy, z: f.z + dz, d: dx * dx + dz * dz + dy * dy });
      }
    }
  }
  cands.sort((a, b) => a.d - b.d || a.x - b.x || a.z - b.z || b.y - a.y);
  for (const c of cands) {
    let feet = null; let head = null;
    try { feet = blockAt({ x: c.x, y: c.y, z: c.z }); head = blockAt({ x: c.x, y: c.y + 1, z: c.z }); } catch (e) { continue; }
    if (!isClear(feet) || !isClear(head)) continue;
    if (groundCheck(blockAt, c, need).ok === true) return { x: c.x, y: c.y, z: c.z };
  }
  return null;
}

/**
 * Ancre (base / home safe / point de respawn) dont la COLONNE serait percée par une descente partie
 * d'ici : à ≤ `radius` blocs en X/Z ET pas déjà loin sous elle (un mineur à y16 sous une base y70 ne
 * crève pas son plancher). Rend l'ancre fautive ou null.
 */
function anchorAbove(pos, anchors, radius = 3, below = 8) {
  if (!pos || !Array.isArray(anchors)) return null;
  for (const a of anchors) {
    if (!a || !Number.isFinite(a.x) || !Number.isFinite(a.z)) continue;
    const dx = pos.x - a.x; const dz = pos.z - a.z;
    if (dx * dx + dz * dz > radius * radius) continue;
    if (Number.isFinite(a.y) && Number.isFinite(pos.y) && pos.y < a.y - below) continue;
    return a;
  }
  return null;
}

const DIRS8 = [[1, 0], [0, 1], [-1, 0], [0, -1], [1, 1], [-1, 1], [-1, -1], [1, -1]];

/**
 * Point de départ de descente décalé : à `dist` blocs, dans la direction qui ÉLOIGNE le plus de toutes
 * les ancres (à égalité : ordre DIRS8). Rend {x,z} ou null si aucune ancre n'est concernée.
 */
function descentOffset(pos, anchors, radius = 3, dist = 7) {
  if (!anchorAbove(pos, anchors, radius)) return null;
  const valid = anchors.filter((a) => a && Number.isFinite(a.x) && Number.isFinite(a.z));
  let best = null;
  for (const [ux, uz] of DIRS8) {
    const n = Math.hypot(ux, uz);
    const x = Math.round(pos.x + (ux / n) * dist); const z = Math.round(pos.z + (uz / n) * dist);
    const minD = Math.min(...valid.map((a) => Math.hypot(x - a.x, z - a.z)));
    if (!best || minD > best.minD + 1e-9) best = { x, z, minD };
  }
  return best && best.minD > radius ? { x: best.x, z: best.z } : null;
}

/** Message de mort par CHUTE de ce joueur (vanilla, en/fr/it). */
function isFallDeathMessage(msg, username) {
  if (typeof msg !== 'string' || !username) return false;
  const m = msg.trim();
  if (!m.startsWith(username + ' ')) return false;
  return /fell from a high place|hit the ground too hard|was doomed to fall|fell off|fell out of the world|fell too far|est tomb|a heurt|caduto|è precipitat/i.test(m.slice(username.length));
}

/**
 * Boucle de mort par chute : ≥ `min` morts de chute à ≤ `radius` blocs (X/Z) dans `windowMs`.
 * → { loop:true, x, z, count } (centre = dernière mort) | { loop:false }.
 */
function fallDeathLoop(falls, now, { windowMs = 120000, radius = 6, min = 2 } = {}) {
  const recent = (Array.isArray(falls) ? falls : [])
    .filter((f) => f && Number.isFinite(f.x) && Number.isFinite(f.z) && Number.isFinite(f.at) && now - f.at <= windowMs && f.at <= now);
  if (!recent.length) return { loop: false };
  const last = recent[recent.length - 1];
  const near = recent.filter((f) => Math.hypot(f.x - last.x, f.z - last.z) <= radius);
  return near.length >= min ? { loop: true, x: last.x, z: last.z, count: near.length } : { loop: false };
}

/** Une mort par chute à `death` condamne-t-elle cette ancre (même colonne, mort nettement PLUS BAS) ? */
function deathBelowAnchor(death, anchor, radius = 3, drop = 3) {
  if (!death || !anchor || !Number.isFinite(anchor.x) || !Number.isFinite(death.x)) return false;
  if (Math.hypot(death.x - anchor.x, death.z - anchor.z) > radius) return false;
  if (Number.isFinite(death.y) && Number.isFinite(anchor.y)) return death.y < anchor.y - drop;
  return true;
}

/**
 * Où poser un bloc de remblai pour se rattraper après un téléport au-dessus du vide : la case sous
 * les pieds (puis celle d'en dessous), contre une face PLEINE voisine. Rend {target, ref, face} ou null.
 */
function catchBlockPlan(blockAt, pos) {
  if (typeof blockAt !== 'function' || !pos) return null;
  const f = _fl(pos);
  for (const dy of [1, 2]) {
    const t = { x: f.x, y: f.y - dy, z: f.z };
    let tb = null;
    try { tb = blockAt(t); } catch (e) { tb = null; }
    if (!isClear(tb) && !(tb && FLUID.test(tb.name))) continue;
    for (const [rx, ry, rz] of [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, -1, 0]]) {
      const r = { x: t.x + rx, y: t.y + ry, z: t.z + rz };
      let rb = null;
      try { rb = blockAt(r); } catch (e) { rb = null; }
      if (isSolid(rb)) return { target: t, ref: r, face: { x: -rx, y: -ry, z: -rz } };
    }
  }
  return null;
}

module.exports = {
  isSolid, isClear, groundCheck, dropDepth, dangerousDrop, SAFE_LANDING_DROP, nearestSafeStand, anchorAbove, descentOffset,
  isFallDeathMessage, fallDeathLoop, deathBelowAnchor, catchBlockPlan,
};
