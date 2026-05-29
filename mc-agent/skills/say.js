'use strict';
/** Fait parler le bot dans le chat. No-op si message vide. */
async function say(bot, message) {
  if (!message) return;
  bot.chat(String(message));
}
module.exports = { say };
