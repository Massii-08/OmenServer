'use strict';
// Communication structurée avec le backend Python : events JSON sur stdout, commandes sur stdin.

/** Émet un événement structuré (1 ligne JSON) sur stdout. */
function emit(event) {
  process.stdout.write(JSON.stringify(event) + '\n');
}

/**
 * Écoute les commandes du backend (1 ligne JSON par commande) sur `input` (stdin par défaut).
 * Appelle cb(commande) pour chaque ligne JSON valide ; ignore les lignes vides ou non-JSON.
 */
function onCommand(cb, input = process.stdin) {
  let buffer = '';
  input.setEncoding('utf8');
  input.on('data', (chunk) => {
    buffer += chunk;
    let idx;
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line) continue;
      try { cb(JSON.parse(line)); } catch { /* ligne non-JSON ignorée */ }
    }
  });
}

module.exports = { emit, onCommand };
