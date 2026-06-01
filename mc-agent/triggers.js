'use strict';
// Décide SI et COMMENT le bot réagit à un message entrant.
// Objectif réalisme + coût : ne PAS répondre à tout le chat général (giveaway #1 + spam + coût LLM).
//  - message privé (/msg, /tell) -> on répond toujours, EN PRIVÉ
//  - chat public -> on ne réagit que selon `publicMode` :
//      'mention' (défaut) : seulement si le bot est nommé
//      'never'            : jamais en public (privé only)
//      'always'           : répond à tout le public (joueur bavard)

/** Le message public nomme-t-il le bot ? Match insensible à la casse, sur un mot entier (pas substring). */
function mentionsBot(message, botUsername) {
  if (!message || !botUsername) return false;
  const esc = String(botUsername).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^\\w])${esc}([^\\w]|$)`, 'i').test(String(message));
}

/**
 * @param {{username:string, message:string, isWhisper:boolean, botUsername:string, publicMode?:string}} ev
 * @returns {null | {private:boolean, to:string, message:string}} null = ignorer (aucun appel LLM)
 */
function decideReaction({ username, message, isWhisper, botUsername, publicMode = 'mention' } = {}) {
  if (!username || username === botUsername) return null;          // jamais réagir à soi-même
  if (isWhisper) return { private: true, to: username, message };  // privé -> toujours, en privé
  if (publicMode === 'never') return null;
  if (publicMode === 'always') return { private: false, to: username, message };
  // 'mention'
  return mentionsBot(message, botUsername) ? { private: false, to: username, message } : null;
}

module.exports = { mentionsBot, decideReaction };
