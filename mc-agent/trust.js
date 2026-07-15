'use strict';
// Liste de gens de confiance + gating des ordres + détection des demandes TP/trade (Essentials).
// Logique pure, testable sans client MC (cf. piège #38). Policy = {trusted:[], trade:null}.
const fs = require('fs');

/** Charge la policy depuis un fichier JSON. Absent/illisible → {trusted:[], trade:null}. */
function loadPolicy(filePath) {
  if (!filePath) return { trusted: [], trade: null, kit_command: '' };
  try {
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const trusted = Array.isArray(data.trusted) ? data.trusted.filter((u) => typeof u === 'string') : [];
    const trade = (data.trade && typeof data.trade === 'object' && typeof data.trade.acceptCmd === 'string')
      ? { acceptCmd: data.trade.acceptCmd, requestPattern: String(data.trade.requestPattern || '') }
      : null;
    // kit_command (survie mappeur) : DOIT être propagé — sinon le bot ne lance jamais /kit.
    const kit_command = typeof data.kit_command === 'string' ? data.kit_command : '';
    return { trusted, trade, kit_command };
  } catch (e) {
    return { trusted: [], trade: null, kit_command: '' };
  }
}

/** L'émetteur est-il de confiance ? Match exact, insensible à la casse + trim. */
function isTrusted(user, trusted) {
  if (!user || !Array.isArray(trusted) || !trusted.length) return false;
  const u = String(user).trim().toLowerCase();
  return trusted.some((t) => String(t).trim().toLowerCase() === u);
}

// Patterns de demande TP Essentials (EN + FR). 1er groupe = le demandeur.
// Ancrés sur ^\w → le chat joueur "<Bob> ..." (commence par '<') ne matche jamais.
const TP_PATTERNS = [
  /^(\w+) has requested to teleport to you\b/i,
  /^(\w+) has requested that you teleport to (?:them|you)\b/i,
  /^(\w+)\b.{0,30}\bdemand.{0,40}t[ée]l[ée]port/i,
];

/** Extrait le demandeur d'une ligne de demande TP Essentials, ou null. */
function parseTpRequest(msgStr) {
  const s = String(msgStr || '');
  for (const re of TP_PATTERNS) {
    const m = s.match(re);
    if (m) return m[1];
  }
  return null;
}

/** Extrait le demandeur d'une demande trade selon le pattern configuré, ou null. */
function parseTradeRequest(msgStr, tradeCfg) {
  if (!tradeCfg || !tradeCfg.requestPattern) return null;
  let re;
  try { re = new RegExp(tradeCfg.requestPattern, 'i'); } catch (e) { return null; }
  const m = String(msgStr || '').match(re);
  return m ? (m[1] || null) : null;
}

/**
 * Gate les ORDRES : si l'émetteur n'est pas de confiance, retire action + command
 * (le bot ne garde que reply). Liste vide → gating OFF (tout passe). Question seule → inchangé.
 * Retourne la MÊME référence si rien à gater (permet de détecter le refus côté appelant).
 */
function gateDecision(decision, username, trusted) {
  if (!decision) return decision;
  if (!Array.isArray(trusted) || trusted.length === 0) return decision;
  if (isTrusted(username, trusted)) return decision;
  if (!decision.action && !decision.command) return decision;
  return Object.assign({}, decision, { action: null, command: null });
}

/** Bloc texte pour le system prompt. '' si pas de liste (gating off). */
function buildTrustDocs(trusted) {
  if (!Array.isArray(trusted) || !trusted.length) return '';
  return "Tu n'obeis aux ORDRES (deplacement, minage, attaque, commandes serveur) QUE de ces joueurs de confiance : "
    + trusted.join(', ')
    + ". Si un AUTRE joueur te donne un ordre, refuse gentiment en restant dans ton personnage (ne fais pas l'action). "
    + "Mais tu reponds normalement aux QUESTIONS de tout le monde.";
}

module.exports = { loadPolicy, isTrusted, parseTpRequest, parseTradeRequest, gateDecision, buildTrustDocs };
