'use strict';
// Capture-clone étape B (loader) : charge un style.json distillé (backend/bots/mc_capture_distill.py)
// → objet `params` consommable par humanize.js (reaction / lookJitter / chat). Sans --style, le bot
// garde EXACTEMENT son comportement d'avant (rétro-compat) : c'est l'appelant qui décide d'utiliser
// (ou non) ces params à la place de profile.params.
const fs = require('fs');

// PUR (testable) : style.json → params humanize. Normalise movementJitter (degrés BRUTS de la capture,
// p99 ≈ 27°/tick) en INTENSITÉ [0,1] attendue par nextLook (÷30 ≈ p99). reaction.meanMs/stdMs sont de
// VRAIES mesures (mob_appear/damage → réponse, n≈479 sur Massitom2008) → délais de réflexe humains.
function styleToParams(style) {
  if (!style || typeof style !== 'object') return null;
  const dp = style.derivedParams || {};
  const params = {};
  if (style.reaction && style.reaction.meanMs != null) {
    params.reaction = { meanMs: Number(style.reaction.meanMs), stdMs: Number(style.reaction.stdMs) };
  }
  const chat = dp.chat || style.chat;
  if (chat && chat.latencyMeanMs != null) {
    params.chat = {
      latencyMeanMs: Number(chat.latencyMeanMs),
      latencyStdMs: Number(chat.latencyStdMs),
      typoRate: chat.typoRate != null ? Number(chat.typoRate) : undefined,
    };
  }
  const rawJit = dp.movementJitter != null ? dp.movementJitter : style.movementJitter;
  if (rawJit != null) {
    const intensity = Math.min(Math.max(Number(rawJit) / 30, 0), 1);  // deg bruts → [0,1] (÷ p99≈30°)
    params.lookJitter = intensity;       // nextLook lit lookJitter en priorité (visée)
    params.movementJitter = intensity;   // fallback marche
  }
  if (dp.errorRate != null) params.errorRate = Number(dp.errorRate);
  params._player = style.player;
  return params;
}

// Charge depuis un fichier (best-effort : fichier absent/illisible → null → l'appelant garde les défauts).
function loadStyle(file) {
  if (!file) return null;
  try { return styleToParams(JSON.parse(fs.readFileSync(String(file), 'utf8'))); }
  catch (e) { return null; }
}

module.exports = { loadStyle, styleToParams };
