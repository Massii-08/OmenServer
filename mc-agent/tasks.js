'use strict';
// Contrôleur de tâche longue : une seule active. Démarrer une nouvelle annule la précédente
// (exécute son cleanup + arme token.cancelled). Les boucles vérifient token.cancelled.

function createTaskController() {
  let current = null; // { name, cleanup, token }
  // GÉNÉRATION (22/10) : avance à CHAQUE demande de préemption (begin ou cancel, tâche active ou non).
  // Un consommateur qui n'a pas de jeton vivant à suivre (l'abri de nuit quand le jeton global est déjà
  // mort) compare la génération à celle de son démarrage pour voir les préemptions POSTÉRIEURES.
  let generation = 0;

  function cancel() {
    generation++;
    if (!current) return;
    const c = current;
    current = null;
    c.token.cancelled = true;
    if (typeof c.cleanup === 'function') { try { c.cleanup(); } catch (e) {} }
  }

  function begin(name, cleanup) {
    cancel();                // avance déjà la génération (une seule fois par begin)
    const token = { cancelled: false };
    current = { name, cleanup: cleanup || (() => {}), token };
    return token;
  }

  function setCleanup(fn) { if (current) current.cleanup = fn || (() => {}); }

  return { begin, cancel, setCleanup, get active() { return current ? current.name : null; }, get generation() { return generation; } };
}

module.exports = { createTaskController };
