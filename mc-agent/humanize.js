'use strict';
// Réalisme PARAMÉTRÉ (spec §7.1) : transforme une réponse « parfaite » en réponse d'apparence
// humaine via des modèles contrôlés par le formateur (distribution, taux de faute).
// JAMAIS de clonage d'un vrai joueur — c'est une signature analysable, pas une imitation.

/** Échantillonne un temps de réaction (ms) depuis une normale (Box-Muller), tronqué. */
function sampleDelay(params, rng = Math.random) {
  const chat = (params && params.chat) || {};
  const mean = chat.latencyMeanMs == null ? 800 : chat.latencyMeanMs;
  const std = chat.latencyStdMs == null ? 300 : chat.latencyStdMs;
  const u1 = Math.max(rng(), 1e-9);
  const u2 = rng();
  const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  const ms = mean + z * std;
  // borné : jamais < 80ms (réflexe humain mini), jamais > mean + 3*std (anti-traîne)
  return Math.round(Math.min(Math.max(ms, 80), mean + 3 * std));
}

/** Insère occasionnellement des fautes de frappe (taux paramétré). 0 = aucune. */
function applyTypos(text, rate = 0, rng = Math.random) {
  if (!text || rate <= 0) return text;
  const chars = String(text).split('');
  for (let i = 0; i < chars.length; i++) {
    if (!/[a-zA-Zàâéèêëîïôûùç]/.test(chars[i])) continue;
    if (rng() >= rate) continue;
    if (i + 1 < chars.length && rng() < 0.5) {
      const t = chars[i]; chars[i] = chars[i + 1]; chars[i + 1] = t; i++; // inversion
    } else {
      chars[i] = ''; // omission
    }
  }
  return chars.join('');
}

/** Post-traite la réponse selon le profil → { text (avec fautes), delayMs (latence humaine) }. */
function humanizeReply(profile, reply, rng = Math.random) {
  const params = (profile && profile.params) || {};
  const typoRate = (params.chat && params.chat.typoRate) || 0;
  return {
    text: applyTypos(String(reply == null ? '' : reply), typoRate, rng),
    delayMs: sampleDelay(params, rng),
  };
}

module.exports = { sampleDelay, applyTypos, humanizeReply };
