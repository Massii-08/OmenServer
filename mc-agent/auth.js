'use strict';
// Bootstrap AuthMe : décide register vs login depuis le prompt serveur, génère/stocke un pw.
const crypto = require('crypto');

/** 'register' | 'login' | null d'après un message serveur (FR/EN, tolérant). */
function classifyAuthPrompt(msg) {
  const s = String(msg || '').toLowerCase();
  if (s.includes('/register') || s.includes('enregistr') || s.includes('registr')) return 'register';
  if (s.includes('/login') || s.includes('connecte') || s.includes('log in') || s.includes('logged')) return 'login';
  return null;
}

/** Mot de passe aléatoire fort (alphanumérique, 16 chars). */
function genPassword() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  const bytes = crypto.randomBytes(16);
  let pw = '';
  for (let i = 0; i < 16; i++) pw += chars[bytes[i] % chars.length];
  // garantir au moins 1 chiffre + 1 lettre
  return 'A' + pw + '7';
}

module.exports = { classifyAuthPrompt, genPassword };
