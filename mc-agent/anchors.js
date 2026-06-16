'use strict';

// Ancres profondes SÈCHES (anti boucle de noyade, vécu live ResBot2 16/06).
//
// Problème : sur un monde au spawn humide, un bot qui mine profond touche un aquifère → noyade →
// warp anti-noyade vers la surface near-spawn → re-descente de ~160 blocs dans le MÊME quadrant →
// re-aquifère → re-noyade. La mémoire de monde des bots `resource` est VIDE (ores=0, biomes=0 : pas
// de mappeurs) → `driestCell` renvoie toujours null → le warp retombe sur homeBase()±40 (humide) →
// boucle improductive (0 progrès diamant, vécu live : 6💎 en 35 min).
//
// Fix : pendant le minage profond, on mémorise les positions où l'OXYGÈNE est plein (= certainement
// hors de l'eau) comme « ancres sèches ». Sur une noyade, on /tp DIRECTEMENT vers une ancre sèche
// LOIN du point de noyade — au lieu de re-warper en surface. Casse la boucle ET économise la
// re-descente (gain de débit). Module pur → testable sans client MC.

// Ajoute `pos` à la liste d'ancres (arrondie). Fusionne avec une ancre quasi-colocalisée (move-to-end)
// pour ne pas accumuler 50 ancres au même tunnel ; FIFO borné à `max`. Retourne une NOUVELLE liste.
function recordAnchor(list, pos, opts = {}) {
  const max = opts.max != null ? opts.max : 4;
  const minSep = opts.minSep != null ? opts.minSep : 16; // 2 ancres distinctes = ≥ minSep en X ou Z
  const out = Array.isArray(list) ? list.slice() : [];
  if (!pos || !Number.isFinite(pos.x) || !Number.isFinite(pos.y) || !Number.isFinite(pos.z)) return out;
  const p = { x: Math.round(pos.x), y: Math.round(pos.y), z: Math.round(pos.z) };
  const near = out.findIndex((a) => Math.abs(a.x - p.x) < minSep && Math.abs(a.z - p.z) < minSep);
  if (near >= 0) out.splice(near, 1); // rafraîchit la position (la plus récente passe en queue)
  out.push(p);
  while (out.length > max) out.shift(); // garde les plus récentes
  return out;
}

// Choisit l'ancre sèche la PLUS LOIN de `fromPos` (le point de noyade) tout en étant ≥ `minDist`
// horizontalement — pour ne PAS re-téléporter dans la poche d'eau qu'on vient de fuir. Renvoie
// l'ancre {x,y,z} ou null (aucune assez loin → l'appelant retombe sur le warp surface).
function pickDryAnchor(list, fromPos, minDist = 20) {
  if (!Array.isArray(list) || !list.length || !fromPos
      || !Number.isFinite(fromPos.x) || !Number.isFinite(fromPos.z)) return null;
  const md2 = minDist * minDist;
  let best = null;
  let bestD2 = -1;
  for (const a of list) {
    if (!a || !Number.isFinite(a.x) || !Number.isFinite(a.z)) continue;
    const dx = a.x - fromPos.x;
    const dz = a.z - fromPos.z;
    const d2 = dx * dx + dz * dz;
    if (d2 < md2) continue; // trop proche du point de noyade
    if (d2 > bestD2) { bestD2 = d2; best = a; }
  }
  return best;
}

module.exports = { recordAnchor, pickDryAnchor };
