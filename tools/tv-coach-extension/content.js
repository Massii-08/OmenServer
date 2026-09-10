/**
 * content.js — le panneau « omen-coach » (monde isolé de la page TradingView).
 *
 * Il ne parle JAMAIS au réseau lui-même (spec §10) : tout passe par ``sw.js``
 * via ``lib/api.js``. Il ne touche jamais ``TradingViewApi`` non plus : le
 * symbole, l'intervalle, le prix et le dessin passent par ``bridge.js``
 * (monde MAIN) en ``postMessage`` nonce + origine vérifiés.
 *
 * Règles de tenue :
 *  - tout texte affiché passe par ``esc()`` (le panneau écrit du HTML) ;
 *  - aucun ``onclick=`` en ligne : attributs ``data-omen-act`` + délégation ;
 *  - aucun accès direct à ``chrome.*`` hors de l'adaptateur ``ext`` (le module
 *    doit se charger sous ``node --test`` avec un DOM bouchon, cf.
 *    ``tests/smoke.test.js``) ;
 *  - un ``catch`` silencieux cache un bug : on journalise en ``console.debug``
 *    préfixé ``[omen-coach]``.
 */
(function () {
  'use strict';

  var NS = '[omen-coach]';
  var SCALP_RESOLUTIONS = ['1', '2', '3', '5'];
  var BRIEF_REFRESH_MS = 300000;      /* 5 min (spec §7, levier 2) */
  var FOCUS_MS = 120000;              /* battement de focus (spec §4.3) */
  var PRECHECK_DEBOUNCE_MS = 300;
  var QUEUE_FLUSH_MS = 60000;
  var TOAST_MS = 9000;
  var MAX_NEWS = 5;
  var MAX_AGENDA = 3;
  var MAX_IDEAS = 3;
  var WATCHLIST_CAP = 30;             /* = paper_router.MAX_WATCHLIST */
  var WATCHLIST_WAIT_MS = 5000;       /* au-delà, le pont ne répondra plus */
  var IDLE_REVIEW_MS = 1200000;       /* 20 min sans scalp -> bilan (spec §8) */
  var NOTE_MAX = 500;                 /* = lib/note.MAX_LEN */

  var DEFAULT_SETTINGS = {
    token: '',
    api_base: 'https://omenserver.org',
    fee_profile: '',
    custom_pct: null,
    risk_pct: 1,
    lang: 'fr',
    scalp_auto: true,
    panel_pos: null
  };

  /* --------------------------------------------------------------- */
  /* Outils                                                           */
  /* --------------------------------------------------------------- */

  function debug() {
    try {
      var args = Array.prototype.slice.call(arguments);
      args.unshift(NS);
      console.debug.apply(console, args);
    } catch (e) { /* console absente : rien à faire */ }
  }

  /** Échappement HTML — même règle que ``frontend/js/lang.js``. */
  function esc(value) {
    return String(value === null || value === undefined ? '' : value)
      .replace(/[&<>"']/g, function (c) {
        if (c === '&') { return '&amp;'; }
        if (c === '<') { return '&lt;'; }
        if (c === '>') { return '&gt;'; }
        if (c === '"') { return '&quot;'; }
        return '&#39;';
      });
  }

  /** Les modules ``lib/*.js`` sont lus À L'APPEL : l'ordre de chargement ne
   *  compte pas, et un module absent (lot parallèle) ne casse rien. */
  function lib(name) {
    var root = globalThis.OmenLib || {};
    return Object.prototype.hasOwnProperty.call(root, name) ? root[name] : null;
  }

  function num(value) {
    if (value === null || value === undefined || value === '') { return null; }
    var parsed = Number(value);
    return isFinite(parsed) ? parsed : null;
  }

  function uuid() {
    try {
      if (typeof crypto !== 'undefined' && crypto && typeof crypto.randomUUID === 'function') {
        return crypto.randomUUID();
      }
    } catch (e) { debug('randomUUID indisponible', e); }
    var out = '';
    for (var i = 0; i < 32; i += 1) {
      out += Math.floor(Math.random() * 16).toString(16);
    }
    return out;
  }

  /** Prix lisible : la précision suit l'ordre de grandeur. */
  function fmtPrice(value) {
    var parsed = num(value);
    if (parsed === null) { return '—'; }
    var abs = Math.abs(parsed);
    var digits = 2;
    if (abs < 1) { digits = 6; } else if (abs < 100) { digits = 4; }
    return parsed.toFixed(digits);
  }

  /** L'écart s'écrit avec la précision du PRIX (« 3.50 », pas « 3.5000 »). */
  function fmtSpread(bid, ask, reference) {
    var low = num(bid);
    var high = num(ask);
    if (low === null || high === null) { return '—'; }
    var scale = num(reference);
    var abs = Math.abs(scale === null ? high : scale);
    var digits = abs < 1 ? 6 : (abs < 100 ? 4 : 2);
    return (high - low).toFixed(digits);
  }

  function fmtNum(value, digits) {
    var parsed = num(value);
    if (parsed === null) { return '—'; }
    return parsed.toFixed(digits === undefined ? 2 : digits);
  }

  function fmtPct(value, digits) {
    var parsed = num(value);
    if (parsed === null) { return '—'; }
    return parsed.toFixed(digits === undefined ? 2 : digits) + ' %';
  }

  function pad2(value) {
    return (value < 10 ? '0' : '') + String(value);
  }

  /**
   * Horodatage -> ``HH:MM`` dans le fuseau de l'écran (Massii lit l'heure de
   * Zurich, pas UTC). Une heure NUE (``12:30``, comme ``calendar.time_utc``)
   * n'est pas convertible : elle est rendue telle quelle, et l'agenda la
   * marque explicitement « UTC » pour qu'aucun doute ne subsiste.
   */
  function fmtTime(value) {
    var text = String(value === null || value === undefined ? '' : value);
    if (!text) { return ''; }
    var stamp = Date.parse(text);
    if (isFinite(stamp)) {
      var moment = new Date(stamp);
      return pad2(moment.getHours()) + ':' + pad2(moment.getMinutes());
    }
    var found = text.match(/(\d{1,2}:\d{2})/);
    return found ? found[1] : '';
  }

  function isoNow() {
    return new Date().toISOString();
  }

  /* --------------------------------------------------------------- */
  /* Adaptateur chrome.* (le SEUL endroit qui touche l'API extension)  */
  /* --------------------------------------------------------------- */

  function makeExt() {
    var root = (typeof chrome !== 'undefined' && chrome && chrome.runtime) ? chrome : null;

    function send(message) {
      return new Promise(function (resolve, reject) {
        if (!root) {
          reject(new Error('extension indisponible'));
          return;
        }
        try {
          root.runtime.sendMessage(message, function (response) {
            var failure = root.runtime.lastError;
            if (failure) { reject(new Error(failure.message || 'runtime')); return; }
            resolve(response);
          });
        } catch (e) {
          reject(e instanceof Error ? e : new Error(String(e)));
        }
      });
    }

    function storageGet(defaults) {
      return new Promise(function (resolve) {
        if (!root || !root.storage || !root.storage.local) { resolve(defaults); return; }
        try {
          root.storage.local.get(defaults, function (stored) {
            resolve(stored || defaults);
          });
        } catch (e) {
          debug('storage.get refusé', e);
          resolve(defaults);
        }
      });
    }

    function storageSet(patch) {
      return new Promise(function (resolve) {
        if (!root || !root.storage || !root.storage.local) { resolve(false); return; }
        try {
          root.storage.local.set(patch, function () { resolve(true); });
        } catch (e) {
          debug('storage.set refusé', e);
          resolve(false);
        }
      });
    }

    function onMessage(handler) {
      if (!root || !root.runtime || !root.runtime.onMessage) { return; }
      try {
        root.runtime.onMessage.addListener(function (message) {
          try { handler(message); } catch (e) { debug('message du sw refusé', e); }
        });
      } catch (e) {
        debug('onMessage indisponible', e);
      }
    }

    function onStorageChanged(handler) {
      if (!root || !root.storage || !root.storage.onChanged) { return; }
      try {
        root.storage.onChanged.addListener(function (changes, area) {
          if (area !== 'local') { return; }
          try { handler(changes); } catch (e) { debug('onChanged refusé', e); }
        });
      } catch (e) {
        debug('storage.onChanged indisponible', e);
      }
    }

    function getURL(path) {
      try {
        if (root && root.runtime && typeof root.runtime.getURL === 'function') {
          return root.runtime.getURL(path);
        }
      } catch (e) { debug('getURL refusé', e); }
      return null;
    }

    return {
      available: !!root,
      send: send,
      storageGet: storageGet,
      storageSet: storageSet,
      onMessage: onMessage,
      onStorageChanged: onStorageChanged,
      getURL: getURL
    };
  }

  var ext = makeExt();
  var api = null;

  function apiClient() {
    if (api === null) {
      var factory = lib('api');
      if (!factory || typeof factory.createApi !== 'function') { return null; }
      api = factory.createApi({ send: ext.send });
    }
    return api;
  }

  /* --------------------------------------------------------------- */
  /* État                                                             */
  /* --------------------------------------------------------------- */

  var state = {
    nonce: null,
    tv_symbol: null,
    symbol: null,
    kind: null,
    resolution: null,
    mode: 'swing',
    brief: null,
    brief_at: null,
    brief_symbol: null,
    price: null,
    prev_price: null,
    bid: null,
    ask: null,
    alerts: [],
    fired: {},
    collapsed: false,
    settings: JSON.parse(JSON.stringify(DEFAULT_SETTINGS)),
    ticket: null,
    scalp: { open: false, handle: null, guards: [], result: null, queued: 0,
             status: '' },
    advice: { status: 'idle', text: '', error: '' },
    banners: {},
    toasts: [],
    drawing: { allowed: true, available: true, denied_for: null },
    server_ok: true,
    degraded: [],
    /* Alt+clic sur le graphique : la confirmation avant de poser l'alerte. */
    alert_draft: null,
    watchlist: { busy: false, status: '' },
    note: { text: '', status: '' }
  };

  var root = null;         /* racine d'ombre (ou hôte si attachShadow absent) */
  var host = null;
  var timers = [];
  var precheckTimer = null;
  var drawRequests = {};
  var flushing = false;
  var lastBtcWanted = null;
  var watchlistTimer = null;
  var idleReview = null;

  function t(key, values) {
    var i18n = lib('i18n');
    if (!i18n) { return key; }
    return i18n.t(key, state.settings.lang, values);
  }

  /* --------------------------------------------------------------- */
  /* Bandeaux et toasts                                               */
  /* --------------------------------------------------------------- */

  function setBanner(key, on, values) {
    if (on) {
      state.banners[key] = values || true;
    } else if (Object.prototype.hasOwnProperty.call(state.banners, key)) {
      delete state.banners[key];
    }
  }

  function toast(text, level) {
    state.toasts.push({ id: uuid(), text: String(text || ''), level: level || 'info',
                        at: Date.now() });
    if (state.toasts.length > 4) { state.toasts.shift(); }
    render();
  }

  function pruneToasts() {
    var now = Date.now();
    var kept = [];
    for (var i = 0; i < state.toasts.length; i += 1) {
      if ((now - state.toasts[i].at) < TOAST_MS) { kept.push(state.toasts[i]); }
    }
    if (kept.length !== state.toasts.length) {
      state.toasts = kept;
      render();
    }
  }

  /* --------------------------------------------------------------- */
  /* Réglages                                                         */
  /* --------------------------------------------------------------- */

  function applySettings(stored) {
    var keys = Object.keys(DEFAULT_SETTINGS);
    for (var i = 0; i < keys.length; i += 1) {
      var key = keys[i];
      if (stored && stored[key] !== undefined && stored[key] !== null) {
        state.settings[key] = stored[key];
      }
    }
    setBanner('no_fee_profile', !state.settings.fee_profile);
    setBanner('token_missing', !state.settings.token);
  }

  function loadSettings() {
    return ext.storageGet(DEFAULT_SETTINGS).then(function (stored) {
      applySettings(stored);
      return state.settings;
    });
  }

  /* --------------------------------------------------------------- */
  /* Pont MAIN <-> isolé                                              */
  /* --------------------------------------------------------------- */

  function postToBridge(type, payload) {
    if (!state.nonce || typeof window === 'undefined') { return; }
    var message = { omen: true, nonce: state.nonce, to: 'bridge', type: type };
    var keys = payload ? Object.keys(payload) : [];
    for (var i = 0; i < keys.length; i += 1) { message[keys[i]] = payload[keys[i]]; }
    try {
      window.postMessage(message, location.origin);
    } catch (e) {
      debug('postMessage vers le pont refusé', e);
    }
  }

  function onWindowMessage(event) {
    if (!event || event.source !== window) { return; }
    if (event.origin !== location.origin) { return; }
    var data = event.data;
    if (!data || data.omen !== true || data.to !== 'content') { return; }
    if (!state.nonce || data.nonce !== state.nonce) { return; }

    if (data.type === 'tv:ready') { onBridgeReady(data); return; }
    if (data.type === 'tv:unavailable') { onBridgeUnavailable(data); return; }
    if (data.type === 'tv:symbol') { onSymbol(data); return; }
    if (data.type === 'tv:tick') { onTick(data); return; }
    if (data.type === 'tv:line_moved') { onLineMoved(data); return; }
    if (data.type === 'tv:alt_click') { onAltClick(data); return; }
    if (data.type === 'tv:watchlist') { onWatchlist(data); return; }
    if (data.type === 'draw:result') { onDrawResult(data); return; }
  }

  function onBridgeReady(data) {
    state.drawing.available = true;
    state.drawing.allowed = data.drawing_allowed !== false;
    setBanner('draw_unavailable', false);
    render();
  }

  function onBridgeUnavailable(data) {
    state.drawing.available = false;
    setBanner('draw_unavailable', true);
    debug('pont sans API TradingView', data && data.reason);
    render();
  }

  function modeFor(resolution) {
    if (!state.settings.scalp_auto) { return 'swing'; }
    return SCALP_RESOLUTIONS.indexOf(String(resolution || '')) === -1 ? 'swing' : 'scalp';
  }

  function onSymbol(data) {
    var symbols = lib('symbols');
    var tvSymbol = data.tv_symbol ? String(data.tv_symbol) : null;
    var changed = tvSymbol !== state.tv_symbol;
    state.tv_symbol = tvSymbol;
    state.resolution = data.resolution ? String(data.resolution) : null;
    state.mode = modeFor(state.resolution);
    if (data.drawing_allowed === false) { state.drawing.allowed = false; }

    var described = symbols ? symbols.describe(tvSymbol) : { symbol: null, kind: null };
    state.symbol = described.symbol;
    state.kind = described.kind;
    setBanner('symbol_unknown', tvSymbol !== null && described.symbol === null,
              { tv: tvSymbol });

    if (changed) {
      state.drawing.denied_for = null;    /* 1 seul essai de dessin PAR TITRE */
      state.ticket = null;
      state.advice = { status: 'idle', text: '', error: '' };
      /* Une alerte se pose sur le titre où on a cliqué, jamais sur le suivant. */
      state.alert_draft = null;
      state.brief = null;
      refreshBrief(true);
      sendFocus();
    }
    /* En scalp, le ticket est toujours ouvert (c'est le ledger) : la quantité
       vient du pré-check dès l'arrivée sur le titre, sans rien dessiner. */
    if (state.mode === 'scalp' && !state.ticket && state.price !== null) {
      openTicket('buy', false);
    }
    syncBtcStream();
    render();
  }

  /** Le flux Binance ne tourne QUE tant qu'un onglet BTC est en mode scalp
   *  (spec §9.1) : c'est l'onglet lui-même qui l'annonce au service worker. */
  function syncBtcStream() {
    var wanted = state.mode === 'scalp' && state.symbol === 'BTC-USD';
    if (wanted === lastBtcWanted) { return; }
    lastBtcWanted = wanted;
    ext.send({ type: 'btc:scalp', on: wanted })
      .catch(function (error) { debug('btc:scalp refusé', error && error.message); });
  }

  function onTick(data) {
    var price = num(data.price);
    if (price !== null) {
      state.prev_price = state.price;
      state.price = price;
    }
    state.bid = num(data.bid);
    state.ask = num(data.ask);
    feedBars(data);
    evaluateAlerts();
    sampleScalp(price, num(data.ts));
    renderLive();
  }

  function onLineMoved(data) {
    if (!state.ticket) { return; }
    var price = num(data.price);
    if (price === null) { return; }
    if (data.key === 'stop') { state.ticket.stop = price; }
    else if (data.key === 'target') { state.ticket.target = price; }
    else if (data.key === 'entry') { state.ticket.entry = price; }
    schedulePrecheck();
    render();
  }

  function onDrawResult(data) {
    var pending = drawRequests[data.id];
    if (pending) { delete drawRequests[data.id]; }
    if (data.error === 'not_authenticated') {
      /* Un seul essai par titre (spec §11) : on note le titre refusé. */
      state.drawing.denied_for = state.tv_symbol;
      setBanner('draw_login', true);
      render();
      return;
    }
    if (data.error) {
      debug('dessin refusé', data.error, data.message || '');
      return;
    }
    setBanner('draw_login', false);
    var count = Array.isArray(data.ids) ? data.ids.length : 0;
    if (pending === 'apply' && count > 0) { toast(t('draw.done', { n: count })); }
    render();
  }

  /* --------------------------------------------------------------- */
  /* Appels serveur                                                   */
  /* --------------------------------------------------------------- */

  function markServer(ok, error) {
    state.server_ok = ok;
    setBanner('server_down', !ok);
    if (!ok && error) { debug('Omen injoignable', error.message || error); }
  }

  /**
   * Une erreur d'appel n'est pas forcément une panne : un 401 ou un 404 prouve
   * que l'Omen répond. Seuls le réseau muet et les 5xx verrouillent le ticket.
   */
  function noteError(error) {
    var status = (error && error.status) || 0;
    if (status === 0 || status >= 500) { markServer(false, error); return; }
    markServer(true);
    debug('appel refusé', status, (error && error.detail) || '');
  }

  function refreshBrief(force) {
    var client = apiClient();
    if (!client || !state.symbol) { return Promise.resolve(null); }
    if (!force && state.brief_symbol === state.symbol && state.brief_at
        && (Date.now() - state.brief_at) < BRIEF_REFRESH_MS) {
      return Promise.resolve(state.brief);
    }
    return client.get('/brief', { symbol: state.symbol, tv: state.tv_symbol })
      .then(function (data) {
        markServer(true);
        setBanner('token_expired', false);
        state.brief = data || null;
        state.brief_at = Date.now();
        state.brief_symbol = state.symbol;
        state.degraded = (data && Array.isArray(data.degraded)) ? data.degraded : [];
        var alerts = lib('alerts');
        state.alerts = (data && Array.isArray(data.alerts))
          ? (alerts ? alerts.forSymbol(data.alerts, state.symbol) : data.alerts)
          : [];
        if (state.mode === 'scalp') { loadScalpHistory(); }
        render();
        return data;
      })
      .catch(function (error) {
        noteError(error);
        if (error && error.status === 401) { setBanner('token_expired', true); }
        render();
        return null;
      });
  }

  function sendFocus() {
    var client = apiClient();
    if (!client || !state.symbol) { return; }
    /* Le focus ne vaut que pour l'onglet REGARDÉ (spec §4.3, levier 3) : un
       onglet en arrière-plan ne doit pas accaparer le scan à 60 s. */
    if (typeof document !== 'undefined' && document.visibilityState
        && document.visibilityState !== 'visible') {
      return;
    }
    client.post('/focus', { symbol: state.symbol }).then(function () {
      markServer(true);
    }).catch(function (error) {
      debug('focus refusé', error && error.message);
    });
  }

  /* --------------------------------------------------------------- */
  /* Alertes live                                                     */
  /* --------------------------------------------------------------- */

  function alertCondition(alert) {
    return alert.op === 'above'
      ? t('alerts.above', { price: fmtPrice(alert.price) })
      : t('alerts.below', { price: fmtPrice(alert.price) });
  }

  function evaluateAlerts() {
    var alertsLib = lib('alerts');
    if (!alertsLib || !state.alerts.length || state.price === null) { return; }
    var fired = alertsLib.evaluate(state.alerts, state.price, state.prev_price);
    for (var i = 0; i < fired.length; i += 1) { fireAlert(fired[i]); }
  }

  function findAlert(id) {
    for (var i = 0; i < state.alerts.length; i += 1) {
      if (String(state.alerts[i].id) === String(id)) { return state.alerts[i]; }
    }
    return null;
  }

  function fireAlert(alertId) {
    if (state.fired[alertId]) { return; }
    state.fired[alertId] = true;
    var alert = findAlert(alertId);
    if (alert) { alert.fired = true; }

    var text = t('alerts.fired', {
      symbol: state.symbol || state.tv_symbol || '',
      condition: alert ? alertCondition(alert) : '',
      price: fmtPrice(state.price)
    });
    toast(text, 'alert');
    ext.send({ type: 'notify', title: t('section.alerts'), message: text,
               symbol: state.symbol })
      .catch(function (error) { debug('notification refusée', error && error.message); });

    var client = apiClient();
    if (!client) { return; }
    client.post('/alerts/' + encodeURIComponent(alertId) + '/fire',
                { price: state.price, ts: isoNow(), by: 'extension' })
      .then(function () { markServer(true); })
      .catch(function (error) {
        /* 409 = le serveur l'avait déjà vue : c'est le filet, pas une panne. */
        if (error && error.status === 409) { return; }
        debug('alerts/fire refusé', error && error.message);
      });
  }

  /* --------------------------------------------------------------- */
  /* Alerte au clic sur le graphique (Alt+clic, spec §8)              */
  /* --------------------------------------------------------------- */

  /**
   * Le pont (monde MAIN) envoie la GÉOMÉTRIE du clic — ordonnée, cadre du
   * pane, plage de prix affichée — et c'est ici que ``lib/price_axis.js``
   * la convertit en prix : les modules ``lib/*`` ne vivent que dans le monde
   * isolé, et les publier dans le monde MAIN reviendrait à laisser la page
   * TradingView décider du prix qu'on enverrait au serveur.
   *
   * Rien de tout cela n'a besoin du dessin : Alt+clic marche même sans être
   * connecté à TradingView (``is_authenticated === false``).
   */
  function onAltClick(data) {
    var axis = lib('price_axis');
    var price = null;
    if (axis) {
      /* ``range_from``/``range_to`` : ``to`` est réservé à l'enveloppe du
         message (le destinataire), cf. ``post`` dans ``bridge.js``. */
      price = axis.priceAtY(data.y, data.top, data.height,
                            data.range_from, data.range_to);
    }
    if (price === null) { price = num(data.last_price); }
    if (price === null) { price = state.price; }
    if (price === null) {
      debug('Alt+clic sans prix exploitable (échelle et titre muets)');
      return;
    }
    if (axis) { price = axis.roundPrice(price); }
    state.alert_draft = {
      price: price,
      op: axis ? axis.opForPrice(price, state.price) : 'above',
      status: ''
    };
    /* Un clic sur le graphique doit SE VOIR : le panneau se rouvre. */
    state.collapsed = false;
    render();
  }

  /** La liste d'alertes rendue par le serveur, filtrée sur le titre affiché. */
  function applyAlerts(data) {
    var rows = (data && Array.isArray(data.alerts)) ? data.alerts : null;
    if (!rows) { refreshBrief(true); return; }
    var alertsLib = lib('alerts');
    state.alerts = alertsLib ? alertsLib.forSymbol(rows, state.symbol) : rows;
  }

  /**
   * ``POST /api/paper/alerts`` — forme EXACTE lue dans ``paper_router.py``
   * (``AlertPayload``) : ``{symbol, op: 'above'|'below', price}``, réponse
   * ``{alert, alerts}``. Le serveur REFUSE en 400 une condition déjà vraie :
   * le panneau prévient avant, il ne l'empêche pas.
   */
  function createAlert() {
    var draft = state.alert_draft;
    var client = apiClient();
    if (!draft || !client) { return; }
    if (!state.symbol) {
      draft.status = t('alert.no_symbol');
      render();
      return;
    }
    var price = num(draft.price);
    if (price === null || price <= 0) {
      draft.status = t('alert.error', { error: t('alert.price') });
      render();
      return;
    }
    var condition = draft.op === 'above'
      ? t('alerts.above', { price: fmtPrice(price) })
      : t('alerts.below', { price: fmtPrice(price) });
    draft.status = t('ticket.computing');
    render();
    client.post('/alerts', { symbol: state.symbol, op: draft.op, price: price })
      .then(function (data) {
        markServer(true);
        state.alert_draft = null;
        applyAlerts(data);
        toast(t('alert.created', { condition: condition }), 'ok');
        render();
      })
      .catch(function (error) {
        noteError(error);
        if (state.alert_draft !== draft) { return; }
        draft.status = t('alert.error', { error: (error && error.detail) || '' });
        render();
      });
  }

  /* --------------------------------------------------------------- */
  /* Import de la watchlist TradingView -> favoris OmenServer         */
  /* --------------------------------------------------------------- */

  function finishWatchlist(status) {
    if (watchlistTimer !== null) { clearTimeout(watchlistTimer); watchlistTimer = null; }
    state.watchlist.busy = false;
    state.watchlist.status = status || '';
    render();
  }

  /** Clic sur « Importer la watchlist » : on interroge le pont, qui lit le DOM. */
  function importWatchlist() {
    if (state.watchlist.busy) { return; }
    if (!apiClient()) { return; }
    state.watchlist.busy = true;
    state.watchlist.status = t('watchlist.reading');
    render();
    postToBridge('tv:watchlist_request', {});
    /* Le pont peut ne jamais répondre (API TradingView absente) : on ne laisse
       pas le bouton tourner indéfiniment. */
    watchlistTimer = setTimeout(function () {
      watchlistTimer = null;
      finishWatchlist(t('watchlist.not_found'));
    }, WATCHLIST_WAIT_MS);
  }

  function watchlistRecap(plan, added, unknownList, stopped) {
    var parts = [t('watchlist.done', {
      added: added,
      skipped: plan.skipped.length,
      unknown: unknownList.length
    })];
    if (plan.capped) { parts.push(t('watchlist.capped', { cap: plan.cap })); }
    if (unknownList.length) {
      parts.push(t('watchlist.unknown_list', { list: unknownList.join(', ') }));
    }
    if (stopped) { parts.push(t('watchlist.failed', { error: stopped })); }
    return parts.join(' ');
  }

  /** Les créations, UNE PAR UNE : la route pose une cotation par appel. */
  function runWatchlistPlan(plan) {
    var client = apiClient();
    var total = plan.post.length;
    var unknownList = plan.unknown.slice(0);
    var added = 0;
    var stopped = '';
    var index = 0;

    function step() {
      if (index >= total || stopped) { return Promise.resolve(); }
      var symbol = plan.post[index];
      index += 1;
      state.watchlist.status = t('watchlist.importing', { done: index, total: total });
      render();
      return client.post('/watchlist', { symbol: symbol }).then(function () {
        markServer(true);
        added += 1;
        return step();
      }).catch(function (error) {
        /* 404 = Yahoo ne connaît pas ce titre : il rejoint les inconnus et
           l'import CONTINUE. Tout le reste (liste pleine, 5xx, réseau muet)
           arrête la boucle — insister ferait trente refus identiques. */
        if (error && error.status === 404) {
          unknownList.push(symbol);
          return step();
        }
        noteError(error);
        stopped = (error && (error.detail || error.message)) || '';
        return Promise.resolve();
      });
    }

    step().then(function () {
      var recap = watchlistRecap(plan, added, unknownList, stopped);
      finishWatchlist(recap);
      toast(recap, stopped ? 'warn' : 'ok');
    });
  }

  function onWatchlist(data) {
    if (watchlistTimer !== null) { clearTimeout(watchlistTimer); watchlistTimer = null; }
    if (!state.watchlist.busy) { return; }
    var symbols = (data && Array.isArray(data.symbols)) ? data.symbols : [];
    if (data && data.error === 'not_found') {
      finishWatchlist(t('watchlist.not_found'));
      return;
    }
    if (!symbols.length) { finishWatchlist(t('watchlist.empty')); return; }

    var planner = lib('watchlist');
    var client = apiClient();
    if (!planner || !client) { finishWatchlist(t('watchlist.failed', { error: '' })); return; }

    /* Les favoris DÉJÀ posés, pour ne pas reposter ce qui existe. */
    client.get('/watchlist').then(function (existing) {
      markServer(true);
      var plan = planner.planImport(symbols,
                                    (existing && existing.symbols) || [],
                                    { cap: WATCHLIST_CAP });
      if (!plan.post.length) {
        var recap = watchlistRecap(plan, 0, plan.unknown, '');
        finishWatchlist(recap);
        toast(recap, 'info');
        return;
      }
      runWatchlistPlan(plan);
    }).catch(function (error) {
      noteError(error);
      finishWatchlist(t('watchlist.failed',
                        { error: (error && (error.detail || error.message)) || '' }));
    });
  }

  /* --------------------------------------------------------------- */
  /* Note rapide au carnet d'idées                                    */
  /* --------------------------------------------------------------- */

  /**
   * ``POST /api/paper/ideas/note {text, symbol?, lang?}`` -> ``{ok, entry}``.
   * ``lib/note.js`` coupe à 500 caractères et n'envoie jamais une note vide.
   */
  function sendNote() {
    var client = apiClient();
    var noteLib = lib('note');
    if (!client || !noteLib) { return; }
    var payload = noteLib.build({
      text: state.note.text,
      symbol: state.symbol,
      lang: state.settings.lang
    });
    if (!payload) { return; }
    state.note.status = t('ticket.computing');
    render();
    client.post('/ideas/note', payload).then(function () {
      markServer(true);
      state.note.text = '';
      state.note.status = '';
      toast(t('note.sent'), 'ok');
      render();
    }).catch(function (error) {
      noteError(error);
      state.note.status = t('note.error',
                            { error: (error && (error.detail || error.message)) || '' });
      render();
    });
  }

  /* --------------------------------------------------------------- */
  /* Bilan automatique après 20 min sans scalp                        */
  /* --------------------------------------------------------------- */

  function idleHandle() {
    if (idleReview !== null) { return idleReview; }
    var mod = lib('idle');
    if (!mod || typeof mod.createIdle !== 'function') { return null; }
    idleReview = mod.createIdle({ idle_ms: IDLE_REVIEW_MS });
    return idleReview;
  }

  /** Un scalp vient d'être fermé : l'horloge des 20 minutes repart de zéro. */
  function touchIdle() {
    var handle = idleHandle();
    if (handle) { handle.touch(Date.now()); }
  }

  function checkIdleReview() {
    if (state.mode !== 'scalp' || state.scalp.open) { return; }
    if (state.advice.status === 'pending') { return; }
    var handle = idleHandle();
    if (!handle || !handle.due(Date.now())) { return; }
    runAutoReview();
  }

  /**
   * Même travail détaché que le bouton « Bilan de session » (``{"job": id}``
   * puis ``GET /job/{id}``), plus une notification navigateur. Un 429 est le
   * plafond de trois bilans par jour : on se TAIT jusqu'à demain, sans
   * réessai — c'est ``lib/idle.js`` qui tient cette mémoire.
   */
  function runAutoReview() {
    var client = apiClient();
    if (!client) { return; }
    state.advice = { status: 'pending', text: '', error: '', auto: true };
    render();
    client.job('/scalps/review', { lang: state.settings.lang }, { intervalMs: 3000 })
      .then(function (result) {
        markServer(true);
        var text = (result && (result.answer || result.text)) || '';
        state.advice = { status: 'done', text: text, error: '', auto: true };
        render();
        ext.send({ type: 'notify', title: t('coach.review'),
                   message: text.slice(0, 300) })
          .catch(function (error) {
            debug('notification du bilan refusée', error && error.message);
          });
      })
      .catch(function (error) {
        var handle = idleHandle();
        if (error && error.status === 429) {
          if (handle) { handle.mute(Date.now()); }
          state.advice = { status: 'idle', text: '', error: '' };
          toast(t('review.capped'), 'warn');
          render();
          return;
        }
        noteError(error);
        state.advice = { status: 'error', text: '', auto: true,
                         error: (error && (error.detail || error.message)) || '' };
        render();
      });
  }

  /* --------------------------------------------------------------- */
  /* Barres, garde-fous, ledger (modules du lot ext-scalp)            */
  /* --------------------------------------------------------------- */

  var bars = null;
  var scalpHistory = [];

  function barsHandle() {
    if (bars !== null) { return bars; }
    var mod = lib('bars');
    if (!mod) { return null; }
    bars = (typeof mod.createBars === 'function') ? mod.createBars() : mod;
    return bars;
  }

  /**
   * ``lib/ledger.js`` (lot ext-scalp) est FONCTIONNEL : ``open(order)`` rend
   * l'objet scalp, que ``sample``/``close``/``serialize`` reçoivent en premier
   * argument. Le panneau garde donc l'objet dans ``state.scalp.handle``.
   */
  function ledgerModule() {
    var mod = lib('ledger');
    return (mod && typeof mod.open === 'function') ? mod : null;
  }

  function scalpModulesReady() {
    return !!(lib('bars') && lib('guards') && ledgerModule());
  }

  function feedBars(sample) {
    var handle = barsHandle();
    if (!handle || typeof handle.push !== 'function') { return; }
    var price = num(sample.price);
    if (price === null) { return; }
    try {
      handle.push(num(sample.ts) || Date.now(), price);
      if (typeof handle.pushSpread === 'function'
          && state.bid !== null && state.ask !== null) {
        handle.pushSpread(state.bid, state.ask);
      }
    } catch (e) {
      debug('bars.push refusé', e);
    }
  }

  function callBars(name, fallback) {
    var handle = barsHandle();
    if (!handle || typeof handle[name] !== 'function') { return fallback; }
    try {
      var out = handle[name].apply(handle, Array.prototype.slice.call(arguments, 2));
      return out === undefined ? fallback : out;
    } catch (e) {
      debug('bars.' + name + ' refusé', e);
      return fallback;
    }
  }

  function calendarForGuards() {
    var brief = state.brief;
    if (!brief || !Array.isArray(brief.calendar)) { return []; }
    var out = [];
    for (var i = 0; i < brief.calendar.length; i += 1) {
      var entry = brief.calendar[i];
      if (!entry || !entry.date) { continue; }
      var stamp = Date.parse(String(entry.date) + 'T'
        + (entry.time_utc ? String(entry.time_utc) : '00:00') + ':00Z');
      if (!isFinite(stamp)) { continue; }
      out.push({ ts_ms: stamp, importance: num(entry.importance) === null ? 1
        : num(entry.importance) });
    }
    return out;
  }

  function guardState() {
    var brief = state.brief || {};
    var btc = brief.btc || null;
    var news = Array.isArray(brief.news) && brief.news.length ? brief.news[0] : null;
    var lastNews = news && news.ts ? Date.parse(String(news.ts)) : null;
    var nextFunding = btc && btc.next_funding_utc
      ? Date.parse(String(btc.next_funding_utc)) : null;
    var fees = brief.fees || {};
    var defaults = brief.defaults || {};
    var symbols = lib('symbols');

    return {
      now_ms: Date.now(),
      calendar: calendarForGuards(),
      next_funding_ms: isFinite(nextFunding) ? nextFunding : null,
      last_news_ms: isFinite(lastNews) ? lastNews : null,
      atr1: callBars('atr', null, 14),
      atr1_median: callBars('medianAtr', null, 4),
      /* ``bars`` rend l'écart en POURCENT ; le médian l'est aussi, la
         comparaison de ``spread_wide`` reste donc homogène. */
      spread: callBars('spread', null),
      spread_median: callBars('medianSpread', null),
      fee_round_trip_pct: num(fees.round_trip_pct),
      price: state.price,
      scalps_today: scalpHistory,
      equity_chf: num(defaults.equity_chf),
      is_perp: symbols ? symbols.isPerp(state.tv_symbol) : false
    };
  }

  function refreshGuards() {
    var guards = lib('guards');
    if (!guards || typeof guards.evaluate !== 'function') {
      state.scalp.guards = [];
      return;
    }
    var before = state.scalp.guards.map(function (g) { return g.code + ':' + g.level; })
      .join(',');
    try {
      var out = guards.evaluate(guardState());
      state.scalp.guards = Array.isArray(out) ? out : [];
    } catch (e) {
      debug('guards.evaluate refusé', e);
      state.scalp.guards = [];
    }
    var after = state.scalp.guards.map(function (g) { return g.code + ':' + g.level; })
      .join(',');
    /* Repeint SEULEMENT quand le bandeau change : les garde-fous sont évalués
       à chaque seconde, le panneau n'a pas à clignoter pour autant. */
    if (before !== after) { render(); }
  }

  function loadScalpHistory() {
    var client = apiClient();
    if (!client) { return; }
    client.get('/scalps', { limit: 50 }).then(function (data) {
      var items = (data && Array.isArray(data.items)) ? data.items : [];
      var out = [];
      for (var i = 0; i < items.length; i += 1) {
        var item = items[i];
        var closed = item && (item.exit_ts || item.closed_at || item.ts);
        var stamp = closed ? Date.parse(String(closed)) : NaN;
        if (!isFinite(stamp)) { continue; }
        out.push({ closed_ms: stamp, pnl_chf: num(item.pnl_chf) || 0 });
      }
      scalpHistory = out;
      refreshGuards();
      render();
    }).catch(function (error) {
      debug('GET /scalps refusé', error && error.message);
    });
  }

  /* --------------------------------------------------------------- */
  /* Ticket (mode swing)                                              */
  /* --------------------------------------------------------------- */

  function openTicket(side, autoDraw) {
    var price = state.price;
    state.ticket = {
      side: side,
      entry: price,
      stop: null,
      target: null,
      qty: null,
      precheck: null,
      warnings: [],
      needs_confirm: null,
      status: '',
      thesis: ''
    };
    /* Stop et cible proposés à ±1 ATR (jour) quand la fiche les donne. */
    var ta = (state.brief && state.brief.ta) ? state.brief.ta : {};
    var atr = num(ta.atr14_d) || (price === null ? null : price * 0.01);
    if (price !== null && atr !== null) {
      var sign = (side === 'buy') ? 1 : -1;
      state.ticket.stop = price - (sign * atr);
      state.ticket.target = price + (sign * atr * 2);
    }
    schedulePrecheck();
    if (autoDraw !== false) { drawTicketLevels(); }
    render();
  }

  function closeTicket() {
    state.ticket = null;
    clearDrawings();
    render();
  }

  function schedulePrecheck() {
    if (precheckTimer !== null) { clearTimeout(precheckTimer); }
    precheckTimer = setTimeout(function () {
      precheckTimer = null;
      runPrecheck();
    }, PRECHECK_DEBOUNCE_MS);
  }

  function runPrecheck() {
    var client = apiClient();
    var ticket = state.ticket;
    if (!client || !ticket || !state.symbol) { return; }
    var payload = {
      symbol: state.symbol,
      side: ticket.side,
      price: ticket.entry === null ? state.price : ticket.entry,
      stop: ticket.stop,
      target: ticket.target,
      risk_pct: num(state.settings.risk_pct),
      mode: state.mode,
      /* Le profil choisi dans les options : sans lui, le serveur chiffrait le
       * ticket avec le profil du portefeuille (Yuh), pas celui du scalp. */
      fee_profile: state.settings.fee_profile || null,
      custom_pct: num(state.settings.custom_pct)
    };
    ticket.status = t('ticket.computing');
    render();
    client.post('/precheck', payload).then(function (data) {
      markServer(true);
      if (state.ticket !== ticket) { return; }
      ticket.precheck = data || null;
      ticket.qty = data ? num(data.qty) : null;
      ticket.warnings = (data && Array.isArray(data.warnings)) ? data.warnings : [];
      ticket.status = '';
      render();
    }).catch(function (error) {
      noteError(error);
      if (state.ticket !== ticket) { return; }
      ticket.status = t('ticket.error', { error: (error && error.detail) || '' });
      render();
    });
  }

  /**
   * Forme EXACTE de ``POST /api/paper/orders`` (lue dans ``paper_router.py`` :
   * ``OrderPayload``) — ``qty`` est un ENTIER, la cible s'appelle ``target``
   * (pas ``take_profit``), et ``confirmed`` est la porte de confirmation :
   * le serveur répond ``{needs_confirm: true, warnings: [...]}`` tant qu'elle
   * est fermée, sans rien exécuter.
   */
  function buildOrderPayload(current, confirmed) {
    var ticket = current.ticket || {};
    var qty = num(ticket.qty);
    return {
      symbol: current.symbol,
      side: ticket.side === 'sell' ? 'sell' : 'buy',
      kind: 'market',
      qty: qty === null ? 0 : Math.max(1, Math.round(qty)),
      stop_loss: num(ticket.stop),
      target: num(ticket.target),
      thesis: String(ticket.thesis || ''),
      fee_profile: current.settings.fee_profile || null,
      confirmed: confirmed === true
    };
  }

  function submitOrder(confirmed) {
    var client = apiClient();
    var ticket = state.ticket;
    if (!client || !ticket || !state.symbol) { return; }
    if (!state.server_ok) { toast(t('ticket.locked'), 'warn'); return; }
    var payload = buildOrderPayload(state, confirmed);
    ticket.status = t('ticket.computing');
    render();
    client.post('/orders', payload).then(function (data) {
      markServer(true);
      if (data && data.needs_confirm) {
        ticket.needs_confirm = Array.isArray(data.warnings) ? data.warnings : [];
        ticket.status = t('ticket.needs_confirm', { codes: ticket.needs_confirm.join(', ') });
        render();
        return;
      }
      toast(t('ticket.sent'), 'ok');
      closeTicket();
      refreshBrief(true);
    }).catch(function (error) {
      noteError(error);
      ticket.status = t('ticket.error', { error: (error && error.detail) || '' });
      render();
    });
  }

  /* --------------------------------------------------------------- */
  /* Scalp (mode scalp)                                               */
  /* --------------------------------------------------------------- */

  function feePctPerSide() {
    var brief = state.brief || {};
    var fees = brief.fees || {};
    var roundTrip = num(fees.round_trip_pct);
    if (roundTrip !== null) { return roundTrip / 2; }
    return num(state.settings.custom_pct);
  }

  function openScalp(side) {
    /* Sans profil de frais, le ticket REFUSE d'ouvrir un scalp (spec §6.4). */
    if (!state.settings.fee_profile) { toast(t('scalp.no_profile'), 'warn'); return; }
    var mod = ledgerModule();
    if (!mod) {
      setBanner('scalp_modules_missing', true);
      render();
      return;
    }
    if (state.price === null) { debug('scalp sans prix : refusé'); return; }
    if (state.ticket) { state.ticket.side = side; schedulePrecheck(); }
    var ticket = state.ticket || {};
    var qty = num(ticket.qty);
    try {
      state.scalp.handle = mod.open({
        side: side,
        qty: qty === null ? 1 : qty,
        price: state.price,
        ts_ms: Date.now(),
        fee_profile: state.settings.fee_profile,
        fee_pct_per_side: feePctPerSide()
      });
      state.scalp.open = true;
      state.scalp.result = null;
      state.scalp.status = '';
      drawTicketLevels();
    } catch (e) {
      debug('ledger.open refusé', e);
      state.scalp.status = String((e && e.message) || e);
    }
    render();
  }

  function sampleScalp(price, tsMs) {
    if (!state.scalp.open || price === null || !state.scalp.handle) { return; }
    var mod = ledgerModule();
    if (!mod || typeof mod.sample !== 'function') { return; }
    try {
      mod.sample(state.scalp.handle, tsMs || Date.now(), price);
    } catch (e) {
      debug('ledger.sample refusé', e);
    }
  }

  function closeScalp() {
    var mod = ledgerModule();
    var handle = state.scalp.handle;
    if (!state.scalp.open || !mod || !handle) { return; }
    var result = null;
    try {
      result = mod.close(handle, state.price, Date.now());
    } catch (e) {
      debug('ledger.close refusé', e);
      return;
    }
    state.scalp.open = false;
    state.scalp.result = result || null;
    /* Le compte à rebours du bilan automatique part du DERNIER scalp fermé,
       que l'envoi au serveur réussisse ou non : le scalp a bien eu lieu. */
    touchIdle();

    var payload = {};
    try {
      payload = mod.serialize(handle) || {};
    } catch (e) {
      debug('ledger.serialize refusé', e);
    }
    /* ``client_id`` vient du ledger ; s'il manque on en pose un : c'est LUI
       qui garantit qu'un scalp rejoué depuis la file n'est jamais dupliqué. */
    payload.client_id = payload.client_id || uuid();
    payload.tv_symbol = state.tv_symbol;
    payload.symbol = state.symbol;
    payload.fee_profile = state.settings.fee_profile;
    state.scalp.handle = null;
    sendScalp(payload);
    render();
  }

  function queueScalp(payload) {
    return ext.storageGet({ scalp_queue: [] }).then(function (stored) {
      var queue = Array.isArray(stored.scalp_queue) ? stored.scalp_queue : [];
      for (var i = 0; i < queue.length; i += 1) {
        if (queue[i] && queue[i].client_id === payload.client_id) { return false; }
      }
      queue.push(payload);
      state.scalp.queued = queue.length;
      return ext.storageSet({ scalp_queue: queue });
    });
  }

  function dropFromQueue(clientId) {
    return ext.storageGet({ scalp_queue: [] }).then(function (stored) {
      var queue = Array.isArray(stored.scalp_queue) ? stored.scalp_queue : [];
      var kept = [];
      for (var i = 0; i < queue.length; i += 1) {
        if (queue[i] && queue[i].client_id !== clientId) { kept.push(queue[i]); }
      }
      state.scalp.queued = kept.length;
      return ext.storageSet({ scalp_queue: kept });
    });
  }

  function sendScalp(payload) {
    var client = apiClient();
    if (!client) { return queueScalp(payload); }
    return client.post('/scalps', payload).then(function () {
      markServer(true);
      state.scalp.status = t('scalp.sent');
      loadScalpHistory();
      render();
      return true;
    }).catch(function (error) {
      if (error && error.status === 400) {
        /* Refus DÉFINITIF (prix hors ±5 %, horodatage trop vieux) : le garder
           en file le ferait échouer à l'infini — on le journalise. */
        debug('scalp refusé définitivement', error.detail || error.message);
        state.scalp.status = t('ticket.error', { error: error.detail || '' });
        render();
        return false;
      }
      noteError(error);
      state.scalp.status = t('scalp.queued');
      render();
      return queueScalp(payload);
    });
  }

  function flushScalpQueue() {
    if (flushing) { return Promise.resolve(false); }
    var client = apiClient();
    if (!client) { return Promise.resolve(false); }
    flushing = true;
    return ext.storageGet({ scalp_queue: [] }).then(function (stored) {
      var queue = Array.isArray(stored.scalp_queue) ? stored.scalp_queue : [];
      state.scalp.queued = queue.length;
      if (!queue.length) { return false; }
      var payload = queue[0];
      return client.post('/scalps', payload).then(function () {
        return dropFromQueue(payload.client_id).then(function () { return true; });
      }).catch(function (error) {
        if (error && error.status === 400) {
          debug('scalp de la file refusé définitivement', error.detail || error.message);
          return dropFromQueue(payload.client_id).then(function () { return true; });
        }
        return false;
      });
    }).then(function (done) {
      flushing = false;
      if (done) { render(); }
      return done;
    }).catch(function (error) {
      flushing = false;
      debug('file de scalps illisible', error && error.message);
      return false;
    });
  }

  /* --------------------------------------------------------------- */
  /* Conseil et bilan (jobs LLM)                                      */
  /* --------------------------------------------------------------- */

  function askQuestion() {
    var pieces = [];
    pieces.push(state.symbol || state.tv_symbol || '');
    if (state.price !== null) { pieces.push('prix ' + fmtPrice(state.price)); }
    pieces.push('mode ' + state.mode);
    if (state.resolution) { pieces.push('intervalle ' + state.resolution); }
    return 'Sur ' + pieces.join(', ') + ' : que ferais-tu, et pourquoi ?';
  }

  function askCoach(path, body) {
    var client = apiClient();
    if (!client) { return; }
    state.advice = { status: 'pending', text: '', error: '' };
    render();
    client.job(path, body, { intervalMs: 3000 }).then(function (result) {
      markServer(true);
      state.advice = {
        status: 'done',
        text: (result && (result.answer || result.text)) || '',
        error: ''
      };
      render();
    }).catch(function (error) {
      state.advice = { status: 'error', text: '',
                       error: (error && (error.detail || error.message)) || '' };
      render();
    });
  }

  /* --------------------------------------------------------------- */
  /* Dessin                                                           */
  /* --------------------------------------------------------------- */

  function canDraw() {
    if (!state.drawing.available) { return false; }
    if (state.drawing.denied_for && state.drawing.denied_for === state.tv_symbol) {
      return false;
    }
    return true;
  }

  function sendDraw(commands) {
    if (!canDraw() || !commands || !commands.length) { return; }
    var requestId = uuid();
    drawRequests[requestId] = 'apply';
    postToBridge('draw:apply', { id: requestId, commands: commands });
  }

  function clearDrawings() {
    if (!state.drawing.available) { return; }
    var requestId = uuid();
    drawRequests[requestId] = 'clear';
    postToBridge('draw:clear', { id: requestId });
  }

  function drawTicketLevels() {
    var draw = lib('draw');
    var ticket = state.ticket;
    if (!draw || !ticket) { return; }
    sendDraw(draw.levels({
      entry: ticket.entry, stop: ticket.stop, target: ticket.target,
      side: ticket.side, qty: ticket.qty
    }));
  }

  function drawBets() {
    var draw = lib('draw');
    if (!draw || !state.brief) { return; }
    var hypotheses = Array.isArray(state.brief.hypotheses) ? state.brief.hypotheses : [];
    var nowSec = Math.floor(Date.now() / 1000);
    sendDraw(draw.bets(hypotheses, state.price, nowSec));
  }

  function drawScalpLevels() {
    var draw = lib('draw');
    if (!draw) { return; }
    var ta = (state.brief && state.brief.ta) ? state.brief.ta : {};
    var btc = (state.brief && state.brief.btc) ? state.brief.btc : {};
    sendDraw(draw.scalp({
      vwap: ta.vwap,
      day_high: ta.day_high === undefined ? callBars('dayHigh', null) : ta.day_high,
      day_low: ta.day_low === undefined ? callBars('dayLow', null) : ta.day_low,
      cme_gap: btc.cme_gap
    }, Math.floor(Date.now() / 1000)));
  }

  /* --------------------------------------------------------------- */
  /* Rendu                                                            */
  /* --------------------------------------------------------------- */

  function button(action, label, extraClass, attrs) {
    return '<button type="button" class="omen-btn ' + esc(extraClass || '')
      + '" data-omen-act="' + esc(action) + '"' + (attrs || '') + '>'
      + esc(label) + '</button>';
  }

  function row(label, value, className) {
    return '<div class="omen-row ' + esc(className || '') + '">'
      + '<span class="omen-k">' + esc(label) + '</span>'
      + '<span class="omen-v">' + esc(value) + '</span></div>';
  }

  function section(title, body) {
    return '<section class="omen-section"><h3>' + esc(title) + '</h3>' + body + '</section>';
  }

  function renderBanners() {
    var out = [];
    var keys = Object.keys(state.banners);
    for (var i = 0; i < keys.length; i += 1) {
      var key = keys[i];
      var values = state.banners[key] === true ? null : state.banners[key];
      var level = (key === 'server_down' || key === 'token_missing'
        || key === 'token_expired' || key === 'no_fee_profile') ? 'warn' : 'info';
      out.push('<div class="omen-banner omen-' + esc(level) + '">'
        + esc(t('banner.' + key, values)) + '</div>');
    }
    if (state.degraded.length) {
      out.push('<div class="omen-banner omen-info">'
        + esc(t('panel.degraded', { list: state.degraded.join(', ') })) + '</div>');
    }
    return out.join('');
  }

  function renderToasts() {
    if (!state.toasts.length) { return ''; }
    var out = ['<div class="omen-toasts">'];
    for (var i = 0; i < state.toasts.length; i += 1) {
      out.push('<div class="omen-toast omen-' + esc(state.toasts[i].level) + '">'
        + esc(state.toasts[i].text) + '</div>');
    }
    out.push('</div>');
    return out.join('');
  }

  function renderHeader() {
    var symbolLabel = state.symbol || state.tv_symbol || t('panel.no_symbol');
    var spread = fmtSpread(state.bid, state.ask, state.price);
    return '<header class="omen-head" data-omen-act="drag">'
      + '<div class="omen-title">'
      + '<span class="omen-sym">' + esc(symbolLabel) + '</span>'
      + '<span class="omen-mode">' + esc(t('panel.mode.' + state.mode)) + '</span>'
      + '</div>'
      + '<div class="omen-live">'
      + '<span class="omen-price" data-omen-live="price">' + esc(fmtPrice(state.price))
      + '</span>'
      + '<span class="omen-bidask" data-omen-live="bidask">'
      + esc(fmtPrice(state.bid)) + ' / ' + esc(fmtPrice(state.ask))
      + ' (' + esc(spread) + ')</span>'
      + '</div>'
      + '<div class="omen-head-actions">'
      + button('refresh', t('panel.refresh'), 'omen-ghost')
      + button('options', t('panel.options'), 'omen-ghost')
      + button('collapse', t('panel.collapse'), 'omen-ghost')
      + '</div></header>';
  }

  function renderPosition() {
    var brief = state.brief;
    if (!brief || !brief.position) { return section(t('section.position'),
      '<p class="omen-empty">' + esc(t('position.none')) + '</p>'); }
    var position = brief.position;
    var body = [
      row(t('position.qty'), fmtNum(position.qty, 4) + ' '
        + t('position.' + (position.side === 'short' ? 'short' : 'long'))),
      row(t('position.avg'), fmtPrice(position.avg)),
      row(t('position.stop'), fmtPrice(position.stop)),
      row(t('position.target'), fmtPrice(position.target)),
      row(t('position.pnl'), fmtNum(position.pnl_chf, 2) + ' CHF',
          num(position.pnl_chf) !== null && num(position.pnl_chf) < 0 ? 'omen-neg' : 'omen-pos')
    ].join('');
    return section(t('section.position'), body);
  }

  function renderCoach() {
    var brief = state.brief || {};
    var out = [];
    if (brief.coach_position) {
      out.push(row(t('coach.position'),
        (brief.coach_position.side || '') + ' ' + fmtNum(brief.coach_position.qty, 4)
        + ' / ' + fmtPrice(brief.coach_position.stop)));
      if (brief.coach_position.thesis) {
        out.push('<p class="omen-note">' + esc(brief.coach_position.thesis) + '</p>');
      }
    } else {
      out.push('<p class="omen-empty">' + esc(t('coach.position_none')) + '</p>');
    }

    var ideas = Array.isArray(brief.ideas) ? brief.ideas.slice(0, MAX_IDEAS) : [];
    if (ideas.length) {
      out.push('<h4>' + esc(t('coach.ideas')) + '</h4><ul class="omen-list">');
      for (var i = 0; i < ideas.length; i += 1) {
        var idea = ideas[i];
        out.push('<li>' + esc(idea.title || idea.label || idea.thesis || '') + '</li>');
      }
      out.push('</ul>');
    } else {
      out.push('<p class="omen-empty">' + esc(t('coach.ideas_none')) + '</p>');
    }

    var hypotheses = Array.isArray(brief.hypotheses) ? brief.hypotheses : [];
    if (hypotheses.length) {
      out.push('<h4>' + esc(t('coach.hypotheses')) + '</h4><ul class="omen-list">');
      for (var h = 0; h < hypotheses.length; h += 1) {
        var hypothesis = hypotheses[h];
        out.push('<li>' + esc(hypothesis.label || hypothesis.title || hypothesis.id || '')
          + ' <span class="omen-dim">' + esc(hypothesis.confidence || '') + '</span></li>');
      }
      out.push('</ul>');
    } else {
      out.push('<p class="omen-empty">' + esc(t('coach.hypotheses_none')) + '</p>');
    }

    out.push('<div class="omen-actions">');
    out.push(button('ask', t('coach.ask'), 'omen-primary'));
    if (state.mode === 'scalp') { out.push(button('review', t('coach.review'), '')); }
    out.push(button('draw-bets', t('draw.bets'), ''));
    out.push(button('draw-clear', t('draw.clear'), 'omen-ghost'));
    out.push('</div>');

    if (state.advice.status === 'pending') {
      out.push('<p class="omen-note">'
        + esc(state.advice.auto ? t('review.auto_pending') : t('coach.ask_pending'))
        + '</p>');
    } else if (state.advice.status === 'error') {
      out.push('<p class="omen-note omen-neg">'
        + esc(t('coach.ask_error', { error: state.advice.error })) + '</p>');
    } else if (state.advice.text) {
      if (state.advice.auto) {
        out.push('<p class="omen-empty">' + esc(t('review.auto_done')) + '</p>');
      }
      out.push('<p class="omen-answer">' + esc(state.advice.text) + '</p>');
    }
    out.push(renderNote());
    return section(t('section.coach'), out.join(''));
  }

  /**
   * La note rapide : deux lignes, 500 caractères, Ctrl/Cmd+Entrée pour
   * envoyer. Le texte vit dans l'état — un repeint (toast qui expire,
   * garde-fou qui change) ne doit pas l'effacer.
   */
  function renderNote() {
    var noteLib = lib('note');
    var left = noteLib ? noteLib.remaining(state.note.text) : NOTE_MAX;
    var out = ['<h4>' + esc(t('note.title')) + '</h4>'];
    out.push('<textarea class="omen-textarea" rows="2" maxlength="'
      + String(NOTE_MAX) + '" data-omen-field="note" placeholder="'
      + esc(t('note.placeholder')) + '">' + esc(state.note.text) + '</textarea>');
    out.push('<div class="omen-actions">');
    out.push(button('note-send', t('note.send'), 'omen-ghost'));
    out.push('</div>');
    out.push('<p class="omen-empty">' + esc(t('note.hint', { left: left })) + '</p>');
    if (state.note.status) {
      out.push('<p class="omen-note">' + esc(state.note.status) + '</p>');
    }
    return out.join('');
  }

  function renderNews() {
    var brief = state.brief || {};
    var news = Array.isArray(brief.news) ? brief.news.slice(0, MAX_NEWS) : [];
    if (!news.length) {
      return section(t('section.news'),
        '<p class="omen-empty">' + esc(t('news.none')) + '</p>');
    }
    var out = ['<ul class="omen-list">'];
    for (var i = 0; i < news.length; i += 1) {
      var item = news[i];
      out.push('<li><span class="omen-dim">' + esc(fmtTime(item.ts)) + '</span> '
        + esc(item.title || '') + ' <span class="omen-dim">'
        + esc(item.source || '') + '</span></li>');
    }
    out.push('</ul>');
    return section(t('section.news'), out.join(''));
  }

  function renderAgenda() {
    var brief = state.brief || {};
    var entries = Array.isArray(brief.calendar) ? brief.calendar.slice(0, MAX_AGENDA) : [];
    if (!entries.length) {
      return section(t('section.agenda'),
        '<p class="omen-empty">' + esc(t('agenda.none')) + '</p>');
    }
    var out = ['<ul class="omen-list">'];
    for (var i = 0; i < entries.length; i += 1) {
      var entry = entries[i];
      /* ``time_utc`` est une heure NUE : on la dit UTC plutôt que de la
         convertir à l'aveugle (le contrat §1.8 la donne en UTC). */
      out.push('<li><span class="omen-dim">' + esc(entry.date || '') + ' '
        + esc(entry.time_utc || '') + (entry.time_utc ? ' UTC' : '')
        + '</span> ' + esc(entry.label || '') + '</li>');
    }
    out.push('</ul>');
    return section(t('section.agenda'), out.join(''));
  }

  /** La confirmation d'un Alt+clic : prix ÉDITABLE, condition pré-choisie. */
  function renderAlertDraft() {
    var draft = state.alert_draft;
    if (!draft) { return ''; }
    var axis = lib('price_axis');
    var refused = axis
      ? axis.wouldBeRefused(draft.op, draft.price, state.price) : false;
    var out = ['<div class="omen-draft">'];
    out.push('<h4>' + esc(t('alert.title')) + '</h4>');
    out.push('<label class="omen-field"><span>' + esc(t('alert.price')) + '</span>'
      + '<input type="text" data-omen-field="alert_price" value="'
      + esc(draft.price === null ? '' : fmtPrice(draft.price)) + '"></label>');
    out.push('<div class="omen-actions">');
    out.push(button('alert-above', t('alert.op_above'),
                    draft.op === 'above' ? 'omen-primary' : 'omen-ghost'));
    out.push(button('alert-below', t('alert.op_below'),
                    draft.op === 'below' ? 'omen-primary' : 'omen-ghost'));
    out.push(button('alert-create', t('alert.create'), 'omen-primary'));
    out.push(button('alert-cancel', t('alert.cancel'), 'omen-ghost'));
    out.push('</div>');
    if (refused) {
      out.push('<p class="omen-warn">' + esc(t('alert.already_true')) + '</p>');
    }
    if (draft.status) {
      out.push('<p class="omen-note">' + esc(draft.status) + '</p>');
    }
    out.push('</div>');
    return out.join('');
  }

  function renderAlerts() {
    var out = [renderAlertDraft()];
    if (!state.alerts.length) {
      out.push('<p class="omen-empty">' + esc(t('alerts.none')) + '</p>');
    } else {
      out.push('<ul class="omen-list">');
      for (var i = 0; i < state.alerts.length; i += 1) {
        var alert = state.alerts[i];
        var done = alert.fired || alert.status === 'triggered';
        out.push('<li class="' + (done ? 'omen-dim' : '') + '">'
          + esc(alertCondition(alert)) + '</li>');
      }
      out.push('</ul>');
    }
    if (!state.alert_draft) {
      out.push('<p class="omen-empty">' + esc(t('alert.hint')) + '</p>');
    }
    return section(t('section.alerts'), out.join(''));
  }

  /** Import à sens unique : TradingView -> favoris OmenServer (spec §8). */
  function renderWatchlist() {
    var out = ['<div class="omen-actions">'];
    out.push(button('watchlist-import', t('watchlist.import'), 'omen-ghost'));
    out.push('</div>');
    if (state.watchlist.status) {
      out.push('<p class="omen-note">' + esc(state.watchlist.status) + '</p>');
    } else {
      out.push('<p class="omen-empty">' + esc(t('watchlist.hint')) + '</p>');
    }
    return section(t('section.watchlist'), out.join(''));
  }

  function chip(label, value) {
    return '<span class="omen-chip">' + esc(label) + ' <b>' + esc(value) + '</b></span>';
  }

  function renderChips() {
    var brief = state.brief || {};
    var mood = brief.mood || {};
    var btc = brief.btc || {};
    var out = [];
    if (num(mood.vix) !== null) { out.push(chip(t('chip.vix'), fmtNum(mood.vix, 1))); }
    if (num(mood.fng) !== null) { out.push(chip(t('chip.fng'), fmtNum(mood.fng, 0))); }
    if (num(mood.dvol) !== null) { out.push(chip(t('chip.dvol'), fmtNum(mood.dvol, 1))); }
    if (num(btc.funding_pct) !== null) {
      out.push(chip(t('chip.funding'), fmtPct(btc.funding_pct, 4)));
    }
    if (btc.next_funding_utc) {
      out.push(chip(t('chip.next_funding'), fmtTime(btc.next_funding_utc)));
    }
    if (num(btc.oi_24h_pct) !== null) {
      out.push(chip(t('chip.oi'), fmtPct(btc.oi_24h_pct, 1)));
    }
    if (num(btc.coinbase_premium_pct) !== null) {
      out.push(chip(t('chip.premium'), fmtPct(btc.coinbase_premium_pct, 3)));
    }
    if (btc.cme_gap && num(btc.cme_gap.level) !== null && btc.cme_gap.open !== false) {
      out.push(chip(t('chip.cme_gap'), fmtPrice(btc.cme_gap.level)));
    }
    if (!out.length) { return ''; }
    return '<div class="omen-chips">' + out.join('') + '</div>';
  }

  function renderWarnings(warnings) {
    if (!warnings || !warnings.length) { return ''; }
    var parts = [];
    var level = 'amber';
    for (var i = 0; i < warnings.length; i += 1) {
      var warning = warnings[i];
      if (warning && warning.level === 'red') { level = 'red'; }
      /* Le serveur envoie un texte ; s'il n'envoie qu'un code, le panneau le
         traduit lui-même (clés ``warn.*``) plutôt que d'afficher un jargon. */
      if (warning && warning.text) { parts.push(warning.text); }
      else if (warning && warning.code) { parts.push(t('warn.' + warning.code)); }
      else { parts.push(String(warning)); }
    }
    return '<p class="omen-warn omen-' + esc(level) + '">'
      + esc(parts.join(' · ')) + '</p>';
  }

  function renderTicket() {
    if (state.mode === 'scalp') { return renderScalp(); }
    var out = [];
    if (!state.ticket) {
      out.push('<div class="omen-actions">');
      out.push(button('buy', t('ticket.buy'), 'omen-primary'));
      out.push(button('sell', t('ticket.sell'), 'omen-danger'));
      out.push('</div>');
      if (!state.server_ok) {
        out.push('<p class="omen-note">' + esc(t('ticket.locked')) + '</p>');
      }
      return section(t('section.ticket'), out.join(''));
    }

    var ticket = state.ticket;
    out.push(renderTicketFields());
    if (ticket.status) { out.push('<p class="omen-note">' + esc(ticket.status) + '</p>'); }
    out.push('<div class="omen-actions">');
    out.push(button(ticket.needs_confirm ? 'confirm-forced' : 'confirm',
      ticket.needs_confirm ? t('ticket.confirm_anyway') : t('ticket.confirm'),
      'omen-primary'));
    out.push(button('cancel', t('ticket.cancel'), 'omen-ghost'));
    out.push(button('draw-levels', t('draw.levels'), 'omen-ghost'));
    out.push('</div>');
    return section(t('section.ticket'), out.join(''));
  }

  function guardLevel() {
    var level = 'ok';
    for (var i = 0; i < state.scalp.guards.length; i += 1) {
      var guard = state.scalp.guards[i];
      if (guard && guard.level === 'red') { return 'red'; }
      if (guard && guard.level === 'amber') { level = 'amber'; }
    }
    return level;
  }

  /** Les valeurs des garde-fous sont des nombres bruts : on les arrondit avant
   *  de les afficher (« 0,5199999 % » ne dit rien de plus que « 0,52 % »). */
  function guardValues(guard) {
    var values = (guard && guard.values) || null;
    if (!values) { return null; }
    var out = {};
    var keys = Object.keys(values);
    for (var i = 0; i < keys.length; i += 1) {
      var value = values[keys[i]];
      out[keys[i]] = (typeof value === 'number' && isFinite(value))
        ? Number(value.toFixed(2)) : value;
    }
    return out;
  }

  function renderGuards() {
    if (!scalpModulesReady()) {
      return section(t('section.guards'),
        '<p class="omen-empty">' + esc(t('banner.scalp_modules_missing')) + '</p>');
    }
    var level = guardLevel();
    if (!state.scalp.guards.length) {
      return section(t('section.guards'),
        '<div class="omen-guard omen-ok">' + esc(t('guard.all_clear')) + '</div>');
    }
    var out = [];
    for (var i = 0; i < state.scalp.guards.length; i += 1) {
      var guard = state.scalp.guards[i];
      var code = (guard && guard.code) || '';
      out.push('<div class="omen-guard omen-' + esc(guard.level || 'amber') + '">'
        + esc(t('guard.' + code, guardValues(guard))) + '</div>');
    }
    /* Bandeau JAMAIS bloquant (spec §6.2) : il informe, il n'empêche rien. */
    return section(t('section.guards'),
      '<div class="omen-guard-band omen-' + esc(level) + '">' + out.join('') + '</div>');
  }

  /** Les champs communs aux deux modes : quantité calculée par le serveur,
   *  stop et cible modifiables ici ET par déplacement de la ligne d'ordre. */
  function renderTicketFields() {
    var ticket = state.ticket;
    if (!ticket) { return ''; }
    var precheck = ticket.precheck || {};
    return [
      row(t('ticket.qty'), fmtNum(ticket.qty, 4)),
      '<label class="omen-field"><span>' + esc(t('ticket.stop')) + '</span>',
      '<input type="text" data-omen-field="stop" value="',
      esc(ticket.stop === null ? '' : fmtPrice(ticket.stop)), '"></label>',
      '<label class="omen-field"><span>' + esc(t('ticket.target')) + '</span>',
      '<input type="text" data-omen-field="target" value="',
      esc(ticket.target === null ? '' : fmtPrice(ticket.target)), '"></label>',
      row(t('ticket.risk'), fmtNum(precheck.risk_chf, 2) + ' CHF'),
      row(t('ticket.fees'), fmtNum(precheck.fees_chf, 2) + ' CHF ('
        + fmtPct(precheck.fees_pct_round_trip, 2) + ')'),
      row(t('ticket.r_multiple'), fmtNum(precheck.r_multiple, 2)),
      row(t('ticket.move_to_beat'), fmtPct(precheck.expected_move_pct, 2)),
      renderWarnings(precheck.warnings),
      renderWarnings(precheck.refusals)
    ].join('');
  }

  function renderScalp() {
    var out = [];
    if (!state.settings.fee_profile) {
      out.push('<p class="omen-note omen-warn">' + esc(t('scalp.no_profile')) + '</p>');
    }
    out.push(renderTicketFields());
    if (state.scalp.open) {
      out.push('<div class="omen-actions">');
      out.push(button('scalp-close', t('scalp.close'), 'omen-danger'));
      out.push(button('draw-scalp', t('draw.levels'), 'omen-ghost'));
      out.push('</div>');
    } else {
      out.push('<div class="omen-actions">');
      out.push(button('scalp-buy', t('ticket.buy'), 'omen-primary'));
      out.push(button('scalp-sell', t('ticket.sell'), 'omen-danger'));
      out.push(button('draw-scalp', t('draw.levels'), 'omen-ghost'));
      out.push('</div>');
    }
    var result = state.scalp.result;
    if (result) {
      out.push(row(t('scalp.result'), fmtNum(result.pnl_net, 2) + ' CHF ('
        + fmtPct(result.pnl_pct, 2) + ')'));
      out.push(row(t('scalp.mae'), fmtPct(result.mae_pct, 2)));
      out.push(row(t('scalp.mfe'), fmtPct(result.mfe_pct, 2)));
    }
    if (state.scalp.queued) {
      out.push('<p class="omen-note">' + esc(t('scalp.queued')) + ' ('
        + esc(String(state.scalp.queued)) + ')</p>');
    }
    if (state.scalp.status) {
      out.push('<p class="omen-note">' + esc(state.scalp.status) + '</p>');
    }
    return section(t('section.ledger'), out.join(''));
  }

  function renderBody() {
    var out = [];
    out.push(renderBanners());
    out.push(renderChips());
    out.push(renderPosition());
    if (state.mode === 'scalp') { out.push(renderGuards()); }
    out.push(renderTicket());
    out.push(renderCoach());
    out.push(renderNews());
    out.push(renderAgenda());
    out.push(renderAlerts());
    out.push(renderWatchlist());
    if (state.brief_at) {
      out.push('<p class="omen-stamp">'
        + esc(t('panel.updated_at', { time: fmtTime(new Date(state.brief_at).toISOString()) }))
        + '</p>');
    }
    return out.join('');
  }

  function styleTag() {
    var url = ext.getURL('panel.css');
    if (url) { return '<link rel="stylesheet" href="' + esc(url) + '">'; }
    /* Repli minimal quand ``chrome.runtime`` n'est pas là (tests, page nue). */
    return '<style>:host{all:initial;font-family:system-ui,sans-serif}</style>';
  }

  function render() {
    if (!root) { return; }
    var html;
    if (state.collapsed) {
      html = styleTag() + '<div class="omen-wrap omen-collapsed">'
        + '<button type="button" class="omen-fab" data-omen-act="expand">'
        + esc(t('panel.expand')) + '</button></div>';
    } else {
      html = styleTag() + '<div class="omen-wrap">'
        + renderHeader()
        + '<div class="omen-body">' + renderBody() + '</div>'
        + renderToasts()
        + '</div>';
    }
    try {
      root.innerHTML = html;
    } catch (e) {
      debug('rendu impossible', e);
    }
  }

  /** Mise à jour à 1 Hz SANS reconstruire le panneau (les champs de saisie
   *  garderaient sinon le focus une demi-seconde). */
  function renderLive() {
    if (!root || state.collapsed || typeof root.querySelector !== 'function') { return; }
    try {
      var priceNode = root.querySelector('[data-omen-live="price"]');
      if (priceNode) { priceNode.textContent = fmtPrice(state.price); }
      var bidAskNode = root.querySelector('[data-omen-live="bidask"]');
      if (bidAskNode) {
        bidAskNode.textContent = fmtPrice(state.bid) + ' / ' + fmtPrice(state.ask)
          + ' (' + fmtSpread(state.bid, state.ask, state.price) + ')';
      }
    } catch (e) {
      debug('mise à jour live impossible', e);
    }
  }

  /* --------------------------------------------------------------- */
  /* Interactions                                                     */
  /* --------------------------------------------------------------- */

  function findAction(node) {
    var current = node;
    var depth = 0;
    while (current && depth < 8) {
      if (typeof current.getAttribute === 'function') {
        var action = current.getAttribute('data-omen-act');
        if (action) { return { action: action, el: current }; }
      }
      current = current.parentNode;
      depth += 1;
    }
    return null;
  }

  function onClick(event) {
    var found = findAction(event && event.target);
    if (!found) { return; }
    var action = found.action;

    if (action === 'collapse') { state.collapsed = true; render(); return; }
    if (action === 'expand') { state.collapsed = false; render(); return; }
    if (action === 'refresh') { refreshBrief(true); return; }
    if (action === 'options') {
      ext.send({ type: 'open-options' })
        .catch(function (error) { debug('ouverture des options refusée', error); });
      return;
    }
    if (action === 'buy') { openTicket('buy'); return; }
    if (action === 'sell') { openTicket('sell'); return; }
    if (action === 'cancel') { closeTicket(); return; }
    if (action === 'confirm') { submitOrder(false); return; }
    if (action === 'confirm-forced') { submitOrder(true); return; }
    if (action === 'ask') {
      askCoach('/coach/ask', { question: askQuestion(), lang: state.settings.lang });
      return;
    }
    if (action === 'review') {
      askCoach('/scalps/review', { lang: state.settings.lang });
      return;
    }
    if (action === 'scalp-buy') { openScalp('buy'); return; }
    if (action === 'scalp-sell') { openScalp('sell'); return; }
    if (action === 'scalp-close') { closeScalp(); return; }
    if (action === 'draw-levels') { drawTicketLevels(); return; }
    if (action === 'draw-bets') { drawBets(); return; }
    if (action === 'draw-scalp') { drawScalpLevels(); return; }
    if (action === 'draw-clear') { clearDrawings(); return; }
    if (action === 'alert-above' || action === 'alert-below') {
      if (state.alert_draft) {
        state.alert_draft.op = action === 'alert-above' ? 'above' : 'below';
        render();
      }
      return;
    }
    if (action === 'alert-create') { createAlert(); return; }
    if (action === 'alert-cancel') { state.alert_draft = null; render(); return; }
    if (action === 'watchlist-import') { importWatchlist(); return; }
    if (action === 'note-send') { sendNote(); return; }
  }

  function onInput(event) {
    var target = event && event.target;
    if (!target || typeof target.getAttribute !== 'function') { return; }
    var field = target.getAttribute('data-omen-field');
    if (!field) { return; }
    if (field === 'note') {
      /* Texte BRUT ici : ``normalize`` coupe les espaces de bord, ce qui
         empêcherait d'écrire un mot après un espace. La coupe se fait à
         l'envoi (``note.build``), et le navigateur borne déjà à 500. */
      state.note.text = String(target.value === undefined ? '' : target.value);
      return;
    }
    if (field === 'alert_price') {
      /* La condition N'EST PAS recalculée : elle a pu être choisie à la main. */
      if (state.alert_draft) { state.alert_draft.price = num(target.value); }
      return;
    }
    if (!state.ticket) { return; }
    var value = num(target.value);
    if (field === 'stop') { state.ticket.stop = value; }
    else if (field === 'target') { state.ticket.target = value; }
    else if (field === 'qty') { state.ticket.qty = value; }
    schedulePrecheck();
    drawTicketLevels();
  }

  /** Ctrl/Cmd+Entrée dans la note = envoi (Entrée seule saute une ligne). */
  function onKeyDown(event) {
    var target = event && event.target;
    if (!target || typeof target.getAttribute !== 'function') { return; }
    if (target.getAttribute('data-omen-field') !== 'note') { return; }
    var noteLib = lib('note');
    if (!noteLib || !noteLib.isSendKey(event)) { return; }
    try {
      if (typeof event.preventDefault === 'function') { event.preventDefault(); }
    } catch (e) { debug('preventDefault refusé', e); }
    state.note.text = String(target.value === undefined ? '' : target.value);
    sendNote();
  }

  /* Déplacement du panneau : la position est mémorisée dans le stockage. */
  var dragging = null;

  function onPointerDown(event) {
    var found = findAction(event && event.target);
    if (!found || found.action !== 'drag' || !host) { return; }
    dragging = { x: event.clientX, y: event.clientY,
                 left: host.offsetLeft, top: host.offsetTop };
  }

  function onPointerMove(event) {
    if (!dragging || !host) { return; }
    var left = dragging.left + (event.clientX - dragging.x);
    var top = dragging.top + (event.clientY - dragging.y);
    try {
      host.style.left = String(Math.max(0, left)) + 'px';
      host.style.top = String(Math.max(0, top)) + 'px';
      host.style.right = 'auto';
      host.style.bottom = 'auto';
    } catch (e) { debug('déplacement refusé', e); }
  }

  function onPointerUp() {
    if (!dragging || !host) { return; }
    dragging = null;
    var pos = { left: host.style.left, top: host.style.top };
    state.settings.panel_pos = pos;
    ext.storageSet({ panel_pos: pos });
  }

  /* --------------------------------------------------------------- */
  /* Montage                                                          */
  /* --------------------------------------------------------------- */

  function mountPanel() {
    host = document.createElement('div');
    host.id = 'omen-coach';
    if (host.style) {
      host.style.position = 'fixed';
      host.style.right = '16px';
      host.style.bottom = '16px';
      host.style.zIndex = '2147483000';
    }
    var pos = state.settings.panel_pos;
    if (pos && host.style) {
      if (pos.left) { host.style.left = pos.left; host.style.right = 'auto'; }
      if (pos.top) { host.style.top = pos.top; host.style.bottom = 'auto'; }
    }
    var parent = document.body || document.documentElement;
    if (parent && typeof parent.appendChild === 'function') { parent.appendChild(host); }

    root = (typeof host.attachShadow === 'function')
      ? host.attachShadow({ mode: 'open' }) : host;

    if (typeof root.addEventListener === 'function') {
      root.addEventListener('click', onClick, false);
      root.addEventListener('input', onInput, false);
      root.addEventListener('change', onInput, false);
      root.addEventListener('keydown', onKeyDown, false);
      root.addEventListener('pointerdown', onPointerDown, false);
    }
    if (typeof document.addEventListener === 'function') {
      document.addEventListener('pointermove', onPointerMove, false);
      document.addEventListener('pointerup', onPointerUp, false);
    }
    render();
  }

  function makeNonce() {
    return uuid().replace(/-/g, '').slice(0, 24);
  }

  function every(ms, fn) {
    var id = setInterval(function () {
      try { fn(); } catch (e) { debug('minuterie', e); }
    }, ms);
    timers.push(id);
    return id;
  }

  function stopTimers() {
    for (var i = 0; i < timers.length; i += 1) { clearInterval(timers[i]); }
    timers = [];
    if (precheckTimer !== null) { clearTimeout(precheckTimer); precheckTimer = null; }
    if (watchlistTimer !== null) { clearTimeout(watchlistTimer); watchlistTimer = null; }
  }

  function onRuntimeMessage(message) {
    if (!message || !message.type) { return; }
    if (message.type === 'ws' || message.type === 'push') {
      /* Poussée du serveur : la fiche a changé, ou une menace est arrivée. */
      if (message.payload && message.payload.type === 'brief_changed') {
        refreshBrief(true);
      }
      if (message.payload && message.payload.type === 'alert') {
        toast(String((message.payload.payload && message.payload.payload.text)
          || t('section.alerts')), 'alert');
      }
      return;
    }
    if (message.type === 'btc:mark' || message.type === 'btc:liq') {
      if (state.brief && state.brief.btc && message.payload) {
        if (message.type === 'btc:mark' && num(message.payload.mark) !== null) {
          state.brief.btc.mark = num(message.payload.mark);
        }
      }
      return;
    }
    if (message.type === 'settings') {
      applySettings(message.settings || {});
      render();
    }
  }

  function boot() {
    state.nonce = makeNonce();
    try {
      var docRoot = document.documentElement;
      if (docRoot) {
        if (docRoot.dataset) { docRoot.dataset.omenNonce = state.nonce; }
        if (typeof docRoot.setAttribute === 'function') {
          docRoot.setAttribute('data-omen-nonce', state.nonce);
        }
      }
    } catch (e) {
      debug('nonce non posé', e);
    }

    if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
      window.addEventListener('message', onWindowMessage, false);
    }
    ext.onMessage(onRuntimeMessage);
    ext.onStorageChanged(function (changes) {
      var patch = {};
      var keys = Object.keys(changes);
      for (var i = 0; i < keys.length; i += 1) { patch[keys[i]] = changes[keys[i]].newValue; }
      applySettings(patch);
      /* Token renouvelé depuis omenserver.org (bouton « Connecter... ») : on
         repart tout de suite plutôt que d'attendre le refresh planifié (5 min). */
      if (Object.prototype.hasOwnProperty.call(changes, 'token') && changes.token.newValue) {
        setBanner('token_expired', false);
        state.brief_at = 0;
        refreshBrief(true);
        sendFocus();
      }
      render();
    });

    loadSettings().then(function () {
      mountPanel();
      postToBridge('tv:request', {});
      ext.send({ type: 'ws:subscribe' })
        .catch(function (error) { debug('ws:subscribe refusé', error && error.message); });
      flushScalpQueue();
    }).catch(function (error) {
      debug('réglages illisibles', error);
      mountPanel();
    });

    every(BRIEF_REFRESH_MS, function () { refreshBrief(true); });
    every(FOCUS_MS, function () { sendFocus(); });
    every(QUEUE_FLUSH_MS, function () { flushScalpQueue(); });
    every(1000, function () {
      pruneToasts();
      if (state.mode === 'scalp') { refreshGuards(); checkIdleReview(); }
    });
    debug('panneau monté');
  }

  var exported = {
    esc: esc,
    fmtPrice: fmtPrice,
    fmtPct: fmtPct,
    fmtTime: fmtTime,
    modeFor: modeFor,
    buildOrderPayload: buildOrderPayload,
    guardState: guardState,
    openScalp: openScalp,
    closeScalp: closeScalp,
    refreshGuards: refreshGuards,
    createAlert: createAlert,
    importWatchlist: importWatchlist,
    watchlistRecap: watchlistRecap,
    sendNote: sendNote,
    touchIdle: touchIdle,
    checkIdleReview: checkIdleReview,
    state: state,
    boot: boot,
    render: render,
    stopTimers: stopTimers,
    SCALP_RESOLUTIONS: SCALP_RESOLUTIONS,
    DEFAULT_SETTINGS: DEFAULT_SETTINGS
  };

  globalThis.OmenCoach = exported;
  if (typeof module !== 'undefined' && module.exports) { module.exports = exported; }
  if (typeof document !== 'undefined' && typeof window !== 'undefined') { boot(); }
})();
