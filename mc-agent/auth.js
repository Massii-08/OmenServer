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

/**
 * Décide quelle chaîne chatter pour s'authentifier (fonction pure, testable).
 *
 * - login + loginCommand (login serveur configuré par l'admin) → chatte la commande telle quelle
 *   (le secret y est déjà substitué côté backend) ; PAS de /login {pw} self-persist.
 * - login + pw (pas de loginCommand, AuthMe self-persist) → /login {pw}
 * - login sans rien → null (on ne peut pas se connecter)
 * - register + pw → /register {pw} {pw} (loginCommand ignorée : register n'utilise jamais le login)
 * - register sans pw → null (l'appelant doit générer/persister un pw au préalable)
 * - kind null → null
 *
 * @returns {{chat:string, action:'login'|'register'}|null}
 */
function resolveAuthChat({ kind, loginCommand, pw } = {}) {
  if (kind === 'login') {
    if (loginCommand) return { chat: loginCommand, action: 'login' };
    if (pw) return { chat: `/login ${pw}`, action: 'login' };
    return null;
  }
  if (kind === 'register') {
    if (pw) return { chat: `/register ${pw} ${pw}`, action: 'register' };
    return null;
  }
  return null;
}

module.exports = { classifyAuthPrompt, genPassword, resolveAuthChat };
