'use strict';
// Garde-fou des commandes serveur (logique pure, testable sans client MC, cf. piège #35).
// La whitelist = liste d'objets {cmd, syntax, desc} écrite par le backend au lancement
// (fichier passé via --commands). Le bot ne tape une commande que si elle y figure.
const fs = require('fs');

/** Charge la whitelist depuis un fichier JSON. Chemin vide / fichier illisible → []. */
function loadCommands(filePath) {
  if (!filePath) return [];
  try {
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return Array.isArray(data) ? data.filter((c) => c && typeof c.cmd === 'string') : [];
  } catch (e) {
    return [];
  }
}

/** Nom de commande normalisé : '/TPA Bob' → 'tpa'. '' si le texte n'est pas une commande. */
function commandName(text) {
  const s = String(text || '').trim();
  if (!s.startsWith('/')) return '';
  return (s.slice(1).split(/\s+/)[0] || '').toLowerCase();
}

/**
 * Texte sortant autorisé ?
 *  - chat normal (ne commence pas par '/') → toujours true.
 *  - commande '/x ...' → true ssi 'x' ∈ whitelist.
 */
function isAllowed(text, whitelist) {
  const name = commandName(text);
  if (!name) return true;
  const set = new Set((whitelist || []).map((c) => commandName(c.cmd)));
  return set.has(name);
}

/** Bloc texte pour le system prompt : commandes dispo + syntaxe. '' si whitelist vide. */
function buildCommandDocs(whitelist) {
  const list = (whitelist || []).filter((c) => c && c.cmd);
  if (!list.length) return '';
  const lines = list.map((c) => `${c.syntax || c.cmd}${c.desc ? ' — ' + c.desc : ''}`);
  return 'Commandes serveur disponibles (utilise UNIQUEMENT celles-ci, jamais d\'autre commande ; '
    + 'mets la commande choisie dans le champ "command") : ' + lines.join(' ; ') + '.';
}

module.exports = { loadCommands, commandName, isAllowed, buildCommandDocs };
