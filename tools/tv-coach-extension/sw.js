/**
 * sw.js — le service worker : le SEUL à voir le token et le réseau.
 *
 * Il détient ``chrome.storage.local`` (token, URL de l'Omen, profil de frais,
 * risque, langue, mode scalp auto, position du panneau), fait tous les appels
 * HTTP (``host_permissions``), tient le WebSocket de poussée ``/ws/paper`` et,
 * en mode scalp BTC seulement, le flux public Binance. Le panneau ne fait que
 * lui envoyer des messages.
 *
 * Les onglets destinataires ne sont PAS cherchés par ``chrome.tabs.query``
 * (qui exigerait la permission « tabs ») : chaque panneau s'abonne au démarrage
 * (``ws:subscribe``) et l'onglet est retenu par son id — un envoi qui échoue
 * retire l'abonné.
 */
'use strict';

/* ``lib/i18n.js`` sert aux titres de notification ; ``lib/symbols.js`` est
   chargé pour rester disponible côté worker (mapping identique au panneau)
   sans dupliquer la table. Les deux s'enregistrent dans ``globalThis.OmenLib``. */
importScripts('lib/symbols.js', 'lib/i18n.js');

var NS = '[omen-coach]';
var API_PREFIX = '/api/paper';
var WS_PATH = '/ws/paper';
var BINANCE_WS = 'wss://fstream.binance.com/ws/btcusdt@markPrice@1s/btcusdt@forceOrder';
var WS_BACKOFF_MIN_MS = 1000;
var WS_BACKOFF_MAX_MS = 30000;
var KEEPALIVE_ALARM = 'omen-keepalive';

/* Icône de notification : Chrome exige une image bitmap ; ce PNG 1x1 évite
   d'embarquer un fichier binaire dans le dépôt. */
var ICON_URL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

var DEFAULTS = {
  token: '',
  api_base: 'https://omenserver.org',
  fee_profile: '',
  custom_pct: null,
  risk_pct: 1,
  lang: 'fr',
  scalp_auto: true,
  ads_auto_close: true,
  panel_pos: null,
  scalp_queue: []
};

function debug() {
  try {
    var args = Array.prototype.slice.call(arguments);
    args.unshift(NS);
    console.debug.apply(console, args);
  } catch (e) { /* rien */ }
}

function settings() {
  return new Promise(function (resolve) {
    chrome.storage.local.get(DEFAULTS, function (stored) {
      resolve(stored || DEFAULTS);
    });
  });
}

function saveSettings(patch) {
  return new Promise(function (resolve) {
    chrome.storage.local.set(patch, function () { resolve(true); });
  });
}

/* ------------------------------------------------------------------ */
/* Appels HTTP                                                         */
/* ------------------------------------------------------------------ */

function apiUrl(base, path) {
  var clean = String(path || '');
  if (/^https?:\/\//i.test(clean)) { return clean; }
  if (clean.indexOf(API_PREFIX) !== 0) { clean = API_PREFIX + clean; }
  return String(base || DEFAULTS.api_base).replace(/\/+$/, '') + clean;
}

function parseBody(response) {
  return response.text().then(function (text) {
    if (!text) { return null; }
    try {
      return JSON.parse(text);
    } catch (e) {
      return { detail: text.slice(0, 500) };
    }
  });
}

function fetchApi(message) {
  return settings().then(function (conf) {
    var url = apiUrl(conf.api_base, message.path);
    var init = {
      method: message.method || 'GET',
      headers: { Accept: 'application/json' },
      credentials: 'omit'
    };
    if (conf.token) { init.headers.Authorization = 'Bearer ' + conf.token; }
    if (message.body !== null && message.body !== undefined) {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(message.body);
    }
    return fetch(url, init).then(function (response) {
      return parseBody(response).then(function (data) {
        if (!response.ok) {
          return {
            ok: false,
            status: response.status,
            error: 'HTTP ' + response.status,
            detail: (data && (data.detail || data.error)) || ''
          };
        }
        return { ok: true, status: response.status, data: data };
      });
    });
  }).catch(function (error) {
    debug('appel échoué', message && message.path, error);
    return { ok: false, status: 0, error: String((error && error.message) || error),
             detail: 'network' };
  });
}

/* ------------------------------------------------------------------ */
/* Abonnés (onglets TradingView)                                       */
/* ------------------------------------------------------------------ */

var subscribers = {};      /* tabId -> {btc_scalp: bool} */

function subscribe(tabId, patch) {
  if (tabId === null || tabId === undefined) { return; }
  var key = String(tabId);
  var entry = subscribers[key] || { btc_scalp: false };
  var keys = patch ? Object.keys(patch) : [];
  for (var i = 0; i < keys.length; i += 1) { entry[keys[i]] = patch[keys[i]]; }
  subscribers[key] = entry;
}

function unsubscribe(tabId) {
  var key = String(tabId);
  if (Object.prototype.hasOwnProperty.call(subscribers, key)) {
    delete subscribers[key];
  }
}

function broadcast(message) {
  var keys = Object.keys(subscribers);
  for (var i = 0; i < keys.length; i += 1) {
    (function (key) {
      try {
        chrome.tabs.sendMessage(Number(key), message, function () {
          if (chrome.runtime.lastError) { unsubscribe(key); }
        });
      } catch (e) {
        unsubscribe(key);
      }
    })(keys[i]);
  }
}

function btcWanted() {
  var keys = Object.keys(subscribers);
  for (var i = 0; i < keys.length; i += 1) {
    if (subscribers[keys[i]] && subscribers[keys[i]].btc_scalp) { return true; }
  }
  return false;
}

/* ------------------------------------------------------------------ */
/* WebSocket de poussée /ws/paper                                      */
/* ------------------------------------------------------------------ */

var omenSocket = null;
var omenBackoff = WS_BACKOFF_MIN_MS;
var omenTimer = null;

function wsUrl(base) {
  var clean = String(base || DEFAULTS.api_base).replace(/\/+$/, '');
  if (clean.indexOf('https://') === 0) { return 'wss://' + clean.slice(8) + WS_PATH; }
  if (clean.indexOf('http://') === 0) { return 'ws://' + clean.slice(7) + WS_PATH; }
  return clean + WS_PATH;
}

function scheduleOmenReconnect() {
  if (omenTimer !== null) { return; }
  var delay = omenBackoff;
  omenBackoff = Math.min(WS_BACKOFF_MAX_MS, omenBackoff * 2);
  omenTimer = setTimeout(function () {
    omenTimer = null;
    connectOmenSocket();
  }, delay);
}

function connectOmenSocket() {
  if (omenSocket && (omenSocket.readyState === 0 || omenSocket.readyState === 1)) {
    return;
  }
  settings().then(function (conf) {
    if (!conf.token) { debug('WS : pas de token, on attend'); return; }
    var url = wsUrl(conf.api_base);
    var socket;
    try {
      socket = new WebSocket(url);
    } catch (e) {
      debug('WS impossible à ouvrir', url, e);
      scheduleOmenReconnect();
      return;
    }
    omenSocket = socket;

    socket.onopen = function () {
      omenBackoff = WS_BACKOFF_MIN_MS;
      /* Auth par PREMIER MESSAGE, jamais en query string (spec §5.3). */
      try { socket.send(JSON.stringify({ token: conf.token })); }
      catch (e) { debug('envoi du token refusé', e); }
    };

    socket.onmessage = function (event) {
      var payload = null;
      try { payload = JSON.parse(event.data); }
      catch (e) { debug('message WS illisible', e); return; }
      if (payload && payload.type === 'ping') {
        try { socket.send(JSON.stringify({ type: 'pong' })); }
        catch (e) { debug('pong refusé', e); }
        return;
      }
      broadcast({ type: 'ws', payload: payload });
      if (payload && (payload.type === 'threat' || payload.type === 'alert')) {
        notifyPush(payload);
      }
    };

    socket.onclose = function () { omenSocket = null; scheduleOmenReconnect(); };
    socket.onerror = function () {
      debug('WS en erreur');
      try { socket.close(); } catch (e) { /* déjà fermé */ }
    };
  });
}

/** Titre de notification dans la langue réglée (d'où l'``importScripts``). */
function notifyPush(payload) {
  settings().then(function (conf) {
    var i18n = (globalThis.OmenLib && globalThis.OmenLib.i18n) || null;
    var key = payload.type === 'threat' ? 'section.coach' : 'section.alerts';
    var title = i18n ? i18n.t(key, conf.lang) : 'OmenServer Coach';
    notify(title, summarize(payload));
  });
}

function summarize(payload) {
  if (!payload) { return ''; }
  var body = payload.payload || {};
  var text = body.text || body.title || body.message || '';
  var symbol = payload.symbol ? String(payload.symbol) + ' — ' : '';
  return (symbol + String(text)).slice(0, 200);
}

/* ------------------------------------------------------------------ */
/* WebSocket Binance (mode scalp BTC seulement)                        */
/* ------------------------------------------------------------------ */

var btcSocket = null;
var btcBackoff = WS_BACKOFF_MIN_MS;
var btcTimer = null;

function closeBtcSocket() {
  if (btcTimer !== null) { clearTimeout(btcTimer); btcTimer = null; }
  if (btcSocket) {
    try { btcSocket.close(); } catch (e) { /* déjà fermé */ }
    btcSocket = null;
  }
}

function connectBtcSocket() {
  if (!btcWanted()) { closeBtcSocket(); return; }
  if (btcSocket && (btcSocket.readyState === 0 || btcSocket.readyState === 1)) { return; }
  var socket;
  try {
    socket = new WebSocket(BINANCE_WS);
  } catch (e) {
    debug('WS Binance impossible', e);
    return;
  }
  btcSocket = socket;

  socket.onopen = function () { btcBackoff = WS_BACKOFF_MIN_MS; };
  socket.onmessage = function (event) {
    var payload = null;
    try { payload = JSON.parse(event.data); }
    catch (e) { return; }
    if (!payload) { return; }
    if (payload.e === 'markPriceUpdate') {
      broadcast({ type: 'btc:mark', payload: {
        mark: Number(payload.p), funding_pct: Number(payload.r) * 100,
        next_funding_ms: Number(payload.T)
      } });
      return;
    }
    if (payload.e === 'forceOrder' && payload.o) {
      var order = payload.o;
      broadcast({ type: 'btc:liq', payload: {
        side: order.S, qty: Number(order.q), price: Number(order.ap || order.p),
        usd: Number(order.q) * Number(order.ap || order.p), ts_ms: Number(order.T)
      } });
    }
  };
  socket.onclose = function () {
    btcSocket = null;
    if (!btcWanted()) { return; }
    var delay = btcBackoff;
    btcBackoff = Math.min(WS_BACKOFF_MAX_MS, btcBackoff * 2);
    btcTimer = setTimeout(function () { btcTimer = null; connectBtcSocket(); }, delay);
  };
  socket.onerror = function () {
    try { socket.close(); } catch (e) { /* déjà fermé */ }
  };
}

/* ------------------------------------------------------------------ */
/* Notifications                                                       */
/* ------------------------------------------------------------------ */

function notify(title, message) {
  try {
    chrome.notifications.create('', {
      type: 'basic',
      iconUrl: ICON_URL,
      title: String(title || 'OmenServer Coach').slice(0, 80),
      message: String(message || '').slice(0, 300)
    }, function () {
      if (chrome.runtime.lastError) {
        debug('notification refusée', chrome.runtime.lastError.message);
      }
    });
  } catch (e) {
    debug('notifications indisponibles', e);
  }
}

/* ------------------------------------------------------------------ */
/* Messages du panneau et de la page OmenServer                        */
/* ------------------------------------------------------------------ */

chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
  if (!message || !message.type) { return false; }
  var tabId = (sender && sender.tab) ? sender.tab.id : null;

  if (message.type === 'api') {
    fetchApi(message).then(sendResponse);
    return true;
  }

  if (message.type === 'notify') {
    notify(message.title, message.message);
    sendResponse({ ok: true });
    return true;
  }

  if (message.type === 'ws:subscribe') {
    subscribe(tabId, { btc_scalp: message.btc_scalp === true });
    connectOmenSocket();
    connectBtcSocket();
    sendResponse({ ok: true });
    return true;
  }

  if (message.type === 'btc:scalp') {
    subscribe(tabId, { btc_scalp: message.on === true });
    connectBtcSocket();
    sendResponse({ ok: true });
    return true;
  }

  if (message.type === 'token') {
    /* Envoyé par ``content-omen.js`` après un clic EXPLICITE de Massii. */
    var patch = { token: String(message.token || '') };
    if (message.api_base) { patch.api_base = String(message.api_base); }
    settings().then(function (conf) {
      /* La langue du site ne sert de défaut qu'à la PREMIÈRE connexion : une
         reconnexion (jeton expiré) ne doit pas écraser celle des options. */
      if (message.lang && !conf.token) { patch.lang = String(message.lang); }
      return saveSettings(patch);
    }).then(function () {
      try {
        if (omenSocket) { omenSocket.close(); }
      } catch (e) { debug('fermeture WS refusée', e); }
      omenSocket = null;
      omenBackoff = WS_BACKOFF_MIN_MS;
      connectOmenSocket();
      broadcast({ type: 'settings', settings: patch });
      sendResponse({ ok: true });
    });
    return true;
  }

  if (message.type === 'open-options') {
    try { chrome.runtime.openOptionsPage(); }
    catch (e) { debug('page d’options indisponible', e); }
    sendResponse({ ok: true });
    return true;
  }

  if (message.type === 'settings:get') {
    settings().then(function (conf) { sendResponse({ ok: true, data: conf }); });
    return true;
  }

  return false;
});

chrome.tabs.onRemoved.addListener(function (tabId) {
  unsubscribe(tabId);
  if (!btcWanted()) { closeBtcSocket(); }
});

/* Le service worker MV3 s'endort : l'alarme le réveille et rouvre le WS. */
try {
  chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 1 });
  chrome.alarms.onAlarm.addListener(function (alarm) {
    if (alarm && alarm.name === KEEPALIVE_ALARM) {
      connectOmenSocket();
      connectBtcSocket();
    }
  });
} catch (e) {
  debug('alarmes indisponibles', e);
}

chrome.runtime.onInstalled.addListener(function () {
  /* Rien n'est réécrit ici : ``settings()`` applique DEFAULTS à la lecture, et
   * réécrire ``api_base`` après une lecture asynchrone écrasait une valeur posée
   * entre-temps (course vue à la vérification : l'URL locale repassait en prod). */
  settings().then(function (conf) {
    if (!conf.fee_profile) {
      /* Premier lancement : le profil de frais se choisit à la main (spec §6.4). */
      try { chrome.runtime.openOptionsPage(); }
      catch (e) { debug('ouverture des options refusée', e); }
    }
  });
});

connectOmenSocket();
