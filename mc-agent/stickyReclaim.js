'use strict';
// Reclaim DIFFÉRÉ de la table portable (retour Massii C) : poser la table, servir TOUS les crafts
// du burst, puis la reprendre après `delayMs` d'inactivité — jamais pose+casse instantanées
// (le tell visuel n°1). Debounce pur, horloge injectable (tests).

function createStickyReclaim(reclaimFn, delayMs = 12000, setT = setTimeout, clearT = clearTimeout) {
  let cur = null; // { pos, timer }
  const samePos = (a, b) => a && b && a.x === b.x && a.y === b.y && a.z === b.z;
  return {
    /** (Re)programme le reclaim de la table en `pos`. Une table précédente AILLEURS est reprise tout de suite. */
    schedule(pos) {
      if (cur) {
        clearT(cur.timer);
        if (!samePos(cur.pos, pos)) { const old = cur.pos; Promise.resolve(reclaimFn(old)).catch(() => {}); }
      }
      const timer = setT(() => {
        const p = cur && cur.pos;
        cur = null;
        if (p) Promise.resolve(reclaimFn(p)).catch(() => {});
      }, delayMs);
      if (timer && timer.unref) timer.unref();
      cur = { pos, timer };
    },
    /** Position de la table posée en attente de reclaim, ou null. */
    pending() { return cur ? cur.pos : null; },
    /** Annule sans reprendre (ex. stop du bot). */
    cancel() { if (cur) { clearT(cur.timer); cur = null; } },
  };
}

module.exports = { createStickyReclaim };
