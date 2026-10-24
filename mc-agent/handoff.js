'use strict';
// REMISE EN MAIN PROPRE D'UNE PIÈCE D'ARMURE (24/10, livraison perdue au cartographe).
//
// Vécu (MapBot1, groupe 943e2c) : NethBot3 `gift_tpa` → `gift_delivered pieces:2` 500 ms plus tard →
// `/home work` 300 ms après — et MapBot1 est resté à 2/4 pendant 1 h 30 (même lot livré DEUX fois, les
// deux fois perdu). Trois défauts cumulés :
//   1. le donneur jetait à l'aveugle aussitôt arrivé (l'entité du receveur n'est souvent pas encore
//      connue du client 500 ms après un TP → pas de `lookAt`, la pièce part dans l'ancien regard) ;
//   2. il déclarait `gift_delivered` sur le seul fait d'avoir jeté — or un objet jeté n'est ramassable
//      qu'au bout de 40 ticks (2 s), et il était déjà reparti ;
//   3. le receveur ne savait pas qu'on le livrait : le cartographe repartait explorer, le mineur
//      reprenait son tunnel, et MapBot1 avait la poche PLEINE (`craft_fail_ctx … empty: 0`) — un
//      joueur à la poche pleine ne ramasse rien, l'objet reste par terre et despawn en 5 min.
// Comme deux joueurs : le receveur s'arrête et fait de la place, le donneur s'approche, regarde, jette,
// et ne repart qu'après avoir VU la pièce ramassée (event `playerCollect` du receveur, ou son heartbeat
// qui ne la liste plus manquante) — sinon il reprend ses objets et réessaie.
//
// PUR : aucune dépendance au bot. Le câblage (TP, jet, ramassage, verrou de but) vit dans index.js.

const HANDOFF_TOSS_MAX_DIST = 2;       // on ne jette qu'à ≤ 2 blocs du receveur
const HANDOFF_CONFIRM_MS = 15000;      // attente de la preuve de ramassage après le jet
const HANDOFF_RECEIVE_WAIT_MS = 30000; // le receveur attend au plus 30 s
const HANDOFF_PICKUP_RADIUS = 4;       // le receveur va chercher les objets au sol à ≤ 4 blocs
const HANDOFF_MAX_TRIES = 2;           // 1 jet + 1 nouvel essai
const HANDOFF_ENTITY_WAIT_MS = 3000;   // après le TP, l'entité du receveur met un instant à apparaître
const HANDOFF_APPROACH_MS = 8000;      // marche bornée jusqu'au receveur
const HANDOFF_POLL_MS = 500;
const HANDOFF_BEAT_CHECK_MS = 2000;    // présence relue au plus toutes les 2 s (verrou partagé)
const HANDOFF_DONOR_GONE_MS = 3000;    // donneur hors de vue depuis 3 s et rien au sol → fin d'attente

const GIFT_ITEM_RE = /_(helmet|chestplate|leggings|boots)$|^shield$/;

/** Le TP entrant est-il une LIVRAISON pour moi ? Vrai si `requester` tient la réservation `marmor:<me>`. */
function isGiftForMe({ claim, me, requester } = {}) {
  if (!claim || !requester || requester === me) return false;
  return claim.by === requester;
}

/** Cases à libérer pour recevoir `expected` objets (chacun prend une case : l'armure ne s'empile pas). */
function slotsToFree({ emptySlots, expected } = {}) {
  const want = Math.max(1, Math.floor(Number(expected) || 0));
  const free = Math.max(0, Math.floor(Number(emptySlots) || 0));
  return Math.max(0, want - free);
}

/** Objet au sol qui vaut le détour : pièce d'armure ou bouclier (nom inconnu → on le prend). */
function isGiftItemName(name) {
  if (name == null) return true;
  return GIFT_ITEM_RE.test(String(name));
}

/**
 * Objets au sol à ramasser : à ≤ `radius` blocs (3D), cadeaux seulement, le plus proche d'abord.
 * `items` = [{ id, name, x, y, z }].
 */
function pickupTargets({ self, items, radius = HANDOFF_PICKUP_RADIUS } = {}) {
  if (!self || !Array.isArray(items)) return [];
  const out = [];
  for (const it of items) {
    if (!it || !Number.isFinite(it.x) || !Number.isFinite(it.y) || !Number.isFinite(it.z)) continue;
    if (!isGiftItemName(it.name)) continue;
    const d = Math.hypot(it.x - self.x, it.y - self.y, it.z - self.z);
    if (d <= radius) out.push(Object.assign({}, it, { dist: d }));
  }
  out.sort((a, b) => a.dist - b.dist);
  return out;
}

/** Peut-on jeter d'ici ? */
function tossReady(dist, maxDist = HANDOFF_TOSS_MAX_DIST) {
  return Number.isFinite(dist) && dist <= maxDist;
}

/**
 * Preuve de remise. `pieces` = noms jetés ; `collected` = nb de ces objets vus RAMASSÉS par le receveur
 * (event playerCollect) ; `receiver` = son entrée de présence (aplatie : `at`, `missing`) ; `tossAt` =
 * instant du jet ; `pocketBack` = nb de ces pièces revenues dans la poche du donneur.
 * → { proven, by, back }. Jamais de preuve tant qu'une pièce est revenue chez le donneur.
 */
function deliveryProof({ pieces, collected = 0, receiver = null, tossAt = 0, pocketBack = 0 } = {}) {
  const list = Array.isArray(pieces) ? pieces.filter(Boolean) : [];
  if (!list.length) return { proven: false, by: null, back: false };
  const back = Number(pocketBack) || 0;
  if (back >= list.length) return { proven: false, by: null, back: true };
  if (back > 0) return { proven: false, by: null, back: false };
  if ((Number(collected) || 0) >= list.length) return { proven: true, by: 'collected', back: false };
  if (receiver && Number(receiver.at) > Number(tossAt) && Array.isArray(receiver.missing)
    && list.every((p) => !receiver.missing.includes(p))) {
    return { proven: true, by: 'heartbeat', back: false };
  }
  return { proven: false, by: null, back: false };
}

/** Donneur : 'delivered' | 'wait' | 'retry' | 'give_up'. */
function handoffNext({ proof, elapsedMs, confirmMs = HANDOFF_CONFIRM_MS, tries = 1, maxTries = HANDOFF_MAX_TRIES } = {}) {
  if (proof && proof.proven) return 'delivered';
  const out = () => (tries < maxTries ? 'retry' : 'give_up');
  if (proof && proof.back) return out();            // tout est revenu chez moi : inutile d'attendre
  if ((Number(elapsedMs) || 0) < confirmMs) return 'wait';
  return out();
}

/**
 * Receveur : 'done' | 'collect' | 'wait' | 'donor_left' | 'timeout'.
 * `gotAll` = plus aucune pièce manquante ; `groundLeft` = objets-cadeaux au sol à portée ;
 * `donorSeen` = le donneur a été vu près de moi ; `donorGoneMs` = depuis quand il n'est plus là (0 = là).
 */
function receiverNext({ elapsedMs, waitMs = HANDOFF_RECEIVE_WAIT_MS, gotAll = false, groundLeft = 0,
  donorSeen = false, donorGoneMs = 0 } = {}) {
  if (gotAll && !groundLeft) return 'done';
  if ((Number(elapsedMs) || 0) >= waitMs) return 'timeout';
  if (groundLeft > 0) return 'collect';
  if (donorSeen && (Number(donorGoneMs) || 0) >= HANDOFF_DONOR_GONE_MS) return 'donor_left';
  return 'wait';
}

module.exports = {
  HANDOFF_TOSS_MAX_DIST, HANDOFF_CONFIRM_MS, HANDOFF_RECEIVE_WAIT_MS, HANDOFF_PICKUP_RADIUS,
  HANDOFF_MAX_TRIES, HANDOFF_ENTITY_WAIT_MS, HANDOFF_APPROACH_MS, HANDOFF_POLL_MS, HANDOFF_BEAT_CHECK_MS,
  HANDOFF_DONOR_GONE_MS,
  isGiftForMe, slotsToFree, isGiftItemName, pickupTargets, tossReady, deliveryProof, handoffNext, receiverNext,
};
