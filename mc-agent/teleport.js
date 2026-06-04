'use strict';
// Téléportation (#10 retours live Massii) : « si le bot est TP quelque part, il doit comprendre où
// il est ». Détection PURE (delta de position bien au-delà de la marche) + câblage bot
// (forcedMove + move) : émet teleport_detected{from,to}, abandonne le goal pathfinder en cours
// (il visait l'ANCIENNE position — jamais y retourner à pied), et laisse un `pending` que la
// boucle consommatrice (mapper) consomme pour se RÉ-ANCRER au nouveau lieu.
// Le TP devient un moyen de DIRIGER le bot : Massii /tp le bot → il mappe DE LÀ.

// Seuil : bien au-delà du déplacement max par tick/échantillon d'un joueur (sprint ~0.3 bloc/tick,
// chute libre ~1, ender pearl/knockback restent < 10). Un /tp ou /home fait des dizaines/milliers.
const TP_THRESHOLD = 16;

function _v(p) { return p ? { x: p.x, y: p.y, z: p.z } : null; }

/** Le passage from→to est-il un saut de téléportation ? (distance 3D > threshold). PUR. */
function isTeleportJump(from, to, opts = {}) {
  if (!from || !to) return false;
  const th = opts.threshold != null ? opts.threshold : TP_THRESHOLD;
  const dx = to.x - from.x, dy = (to.y || 0) - (from.y || 0), dz = to.z - from.z;
  return dx * dx + dy * dy + dz * dz > th * th;
}

/**
 * Suit la position échantillon par échantillon (move/forcedMove) et détecte les sauts.
 *  - update(pos) : retourne {from,to} UNE fois au moment de la détection (sinon null) ;
 *  - peek()/consume() : pending lisible/consommable par la boucle (mapper → ré-ancrage) ;
 *    2 TPs avant consume → `to` reflète la DERNIÈRE position réelle (on se ré-ancre LÀ) ;
 *  - anchor(pos) : ré-ancre sans détection (spawn initial).
 */
function createTeleportWatcher(opts = {}) {
  let last = null;     // dernière position connue (marche normale)
  let pending = null;  // TP détecté pas encore consommé
  return {
    update(pos) {
      const cur = _v(pos);
      if (!cur) return null;
      let hit = null;
      if (last && isTeleportJump(last, cur, opts)) {
        // chaîne de TPs : on garde le point de départ INITIAL, la destination devient la dernière
        pending = { from: pending ? pending.from : last, to: cur };
        hit = pending;
      }
      last = cur;
      return hit;
    },
    peek() { return pending; },
    consume() { const p = pending; pending = null; return p; },
    anchor(pos) { last = _v(pos); pending = null; },
  };
}

/**
 * Câble la détection sur un bot mineflayer : `forcedMove` (TP serveur) + `move` (filet de sécurité).
 * À la détection : émet teleport_detected{from,to} (coords arrondies) et appelle onTeleport()
 * (→ stopMotion : ABANDONNER le goal pathfinder qui visait l'ancienne position).
 * Le pending reste dans le watcher pour le ré-ancrage de la boucle mapper.
 */
function wireTeleportDetection(bot, watcher, opts = {}) {
  const emit = opts.emit || (() => {});
  const onTeleport = opts.onTeleport || (() => {});
  const round = (p) => ({ x: Math.round(p.x), y: Math.round(p.y), z: Math.round(p.z) });
  const check = () => {
    const p = bot.entity && bot.entity.position;
    const hit = watcher.update(p);
    if (hit) {
      emit({ type: 'teleport_detected', from: round(hit.from), to: round(hit.to) });
      try { onTeleport(hit); } catch (e) { /* best-effort */ }
    }
  };
  bot.on('forcedMove', check);
  bot.on('move', check);
}

module.exports = { TP_THRESHOLD, isTeleportJump, createTeleportWatcher, wireTeleportDetection };
