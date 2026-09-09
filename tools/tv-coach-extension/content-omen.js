/**
 * content-omen.js — le pont de confiance, côté OmenServer.
 *
 * Aucun mot de passe ne transite par l'extension (spec §10) : sur
 * ``omenserver.org`` (ou ``localhost:8000`` en vérification locale) DÉJÀ
 * connecté, un bouton propose de copier le token JWT du site vers
 * ``chrome.storage.local``. La copie n'a lieu QUE sur un clic explicite.
 *
 * Clés lues (vérifiées dans le dépôt) : ``omenserver_token``
 * (``frontend/js/auth.js``, ``Auth.TOKEN_KEY``) et ``omen-lang``
 * (``frontend/js/lang.js``). Le bouton vit dans un shadow DOM : le CSS du site
 * ne peut pas le déformer, et lui ne peut rien casser du site.
 */
(function () {
  'use strict';

  var NS = '[omen-coach]';
  var TOKEN_KEY = 'omenserver_token';
  var LANG_KEY = 'omen-lang';
  var POLL_MS = 3000;
  var POLL_MAX = 40;             /* ~2 min : le temps de se connecter */

  var LABELS = {
    fr: { connect: 'Connecter l’extension coach', done: 'Extension connectée',
          fail: 'Connexion impossible' },
    it: { connect: 'Collega l’estensione coach', done: 'Estensione collegata',
          fail: 'Collegamento impossibile' },
    en: { connect: 'Connect the coach extension', done: 'Extension connected',
          fail: 'Connection failed' }
  };

  function debug() {
    try {
      var args = Array.prototype.slice.call(arguments);
      args.unshift(NS);
      console.debug.apply(console, args);
    } catch (e) { /* rien */ }
  }

  function readStorage(key) {
    try {
      return window.localStorage ? window.localStorage.getItem(key) : null;
    } catch (e) {
      debug('localStorage illisible', e);
      return null;
    }
  }

  function labels() {
    var lang = String(readStorage(LANG_KEY) || 'fr').slice(0, 2).toLowerCase();
    return LABELS[lang] || LABELS.fr;
  }

  var host = null;
  var button = null;
  var polls = 0;

  function mount() {
    if (host) { return; }
    host = document.createElement('div');
    host.id = 'omen-coach-connect';
    host.style.position = 'fixed';
    host.style.right = '18px';
    host.style.bottom = '18px';
    host.style.zIndex = '2147483000';
    (document.body || document.documentElement).appendChild(host);

    var root = typeof host.attachShadow === 'function'
      ? host.attachShadow({ mode: 'open' }) : host;

    /* Style écrit ici (et pas dans panel.css) : ce bouton vit sur OmenServer,
       où panel.css n'est pas injecté. Couleurs Ion, mode clair « Givre ». */
    var style = document.createElement('style');
    style.textContent = [
      ':host{all:initial}',
      'button{font:600 13px/1.2 system-ui,-apple-system,Segoe UI,sans-serif;',
      'padding:10px 14px;border-radius:10px;border:1px solid #1C2947;',
      'background:#0A101E;color:#EDF2FA;cursor:pointer;',
      'box-shadow:0 8px 30px rgba(0,0,0,.35)}',
      'button:hover{border-color:#00FFB0;color:#00FFB0}',
      'button[disabled]{cursor:default;color:#00FFB0;border-color:#00FFB0}',
      '@media (prefers-color-scheme: light){',
      'button{background:#F7FAFF;color:#0C1526;border-color:#CBD7EB}',
      'button:hover{border-color:#00885C;color:#00885C}',
      'button[disabled]{color:#00885C;border-color:#00885C}}'
    ].join('');
    root.appendChild(style);

    button = document.createElement('button');
    button.type = 'button';
    button.textContent = labels().connect;
    button.addEventListener('click', onConnect, false);
    root.appendChild(button);
  }

  function onConnect() {
    var token = readStorage(TOKEN_KEY);
    if (!token) {
      button.textContent = labels().fail;
      return;
    }
    var message = {
      type: 'token',
      token: token,
      lang: readStorage(LANG_KEY) || 'fr',
      api_base: location.origin
    };
    try {
      chrome.runtime.sendMessage(message, function () {
        if (chrome.runtime.lastError) {
          debug('service worker injoignable', chrome.runtime.lastError.message);
          button.textContent = labels().fail;
          return;
        }
        button.textContent = labels().done;
        button.disabled = true;
      });
    } catch (e) {
      debug('envoi du token refusé', e);
      button.textContent = labels().fail;
    }
  }

  function check() {
    polls += 1;
    if (readStorage(TOKEN_KEY)) { mount(); return; }
    if (polls >= POLL_MAX) { return; }
    setTimeout(check, POLL_MS);
  }

  if (typeof document !== 'undefined' && typeof window !== 'undefined') {
    check();
    window.addEventListener('focus', function () {
      if (readStorage(TOKEN_KEY)) { mount(); }
    }, false);
  }
})();
