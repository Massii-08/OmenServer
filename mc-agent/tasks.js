'use strict';
// Contrôleur de tâche longue : une seule active. Démarrer une nouvelle annule la précédente
// (exécute son cleanup + arme token.cancelled). Les boucles vérifient token.cancelled.

function createTaskController() {
  let current = null; // { name, cleanup, token }

  function cancel() {
    if (!current) return;
    const c = current;
    current = null;
    c.token.cancelled = true;
    if (typeof c.cleanup === 'function') { try { c.cleanup(); } catch (e) {} }
  }

  function begin(name, cleanup) {
    cancel();
    const token = { cancelled: false };
    current = { name, cleanup: cleanup || (() => {}), token };
    return token;
  }

  function setCleanup(fn) { if (current) current.cleanup = fn || (() => {}); }

  return { begin, cancel, setCleanup, get active() { return current ? current.name : null; } };
}

module.exports = { createTaskController };
