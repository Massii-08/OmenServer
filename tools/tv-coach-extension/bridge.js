/**
 * bridge.js — le pont, injecté dans le monde MAIN de la page TradingView.
 *
 * POURQUOI : un content script classique vit dans un monde isolé et n'y voit
 * PAS ``window.TradingViewApi`` (fait vérifié le 09/09, spec §3). Seul un
 * script en ``world: "MAIN"`` peut lire le symbole, l'intervalle et poser des
 * dessins. Il ne fait QUE ça : il n'appelle aucun réseau, ne détient aucun
 * token, et n'exécute que des commandes de dessin TYPÉES (jamais du code).
 *
 * SÉCURITÉ du canal (spec §10) : chaque message porte le nonce tiré par
 * ``content.js`` et posé sur ``document.documentElement.dataset.omenNonce``
 * AVANT que le pont ne publie quoi que ce soit ; ``event.origin`` est comparé
 * à ``location.origin`` dans les deux sens. Un message sans le bon nonce est
 * ignoré en silence.
 *
 * Ce fichier est aussi chargeable sous Node (``module.exports``) pour tester
 * les fonctions PURES de lecture du titre — le câblage navigateur ne démarre
 * que si ``window``/``document`` existent.
 */
(function () {
  'use strict';

  var NS = '[omen-coach]';
  var RETRY_MS = 500;
  var RETRY_MAX = 40;          /* 500 ms x 40 = 20 s d'attente maximum */
  var TICK_MS = 1000;          /* le prix du titre est échantillonné à 1 Hz */
  var BADGE_RESOLVE_MS = 30000;

  /*
   * SÉLECTEURS DOM TRADINGVIEW — la SEULE constante qui dépende du balisage de
   * la page. Les pastilles SELL/BUY (widget de trading, en haut à gauche du
   * graphique) portent le bid et l'ask. Ces sélecteurs ne sont pas documentés
   * par TradingView et changent au fil des refontes : leur absence n'est JAMAIS
   * une erreur, on retombe sur le prix du titre d'onglet (bid/ask à null, le
   * garde-fou ``spread_wide`` se tait alors de lui-même).
   */
  var BID_ASK_SELECTORS = {
    sell: [
      '[data-name="legend-sell-button"]',
      '[data-name="sell-button"]',
      '.js-button-sell',
      '[class*="sellButton"]',
      '[class*="bidPrice"]'
    ],
    buy: [
      '[data-name="legend-buy-button"]',
      '[data-name="buy-button"]',
      '.js-button-buy',
      '[class*="buyButton"]',
      '[class*="askPrice"]'
    ]
  };

  /* ------------------------------------------------------------------ */
  /* Partie PURE (testable hors navigateur)                              */
  /* ------------------------------------------------------------------ */

  /**
   * Nombre écrit à la mode d'ici ou d'ailleurs -> ``Number``.
   *
   * TradingView écrit le prix selon la langue de l'interface : « 78 760,10 »
   * (virgule décimale, espace fine insécable pour les milliers) ou
   * « 78,760.10 » (point décimal, virgule pour les milliers). Règle : quand
   * les deux séparateurs sont présents, le plus à DROITE est le décimal ;
   * seul, un séparateur suivi d'exactement trois chiffres sur un nombre de la
   * forme ``1,234`` est lu comme un séparateur de milliers (ambiguïté connue et
   * assumée : un prix français « 1,234 » vaudrait 1,234).
   */
  function parsePrice(raw) {
    if (raw === null || raw === undefined) { return null; }
    var cleaned = String(raw).replace(/[\s'\u2019]/g, '');
    var found = cleaned.match(/-?\d[\d.,]*/);
    if (!found) { return null; }
    var body = found[0];
    var lastDot = body.lastIndexOf('.');
    var lastComma = body.lastIndexOf(',');

    if (lastDot >= 0 && lastComma >= 0) {
      if (lastDot > lastComma) {
        body = body.replace(/,/g, '');
      } else {
        body = body.replace(/\./g, '').replace(',', '.');
      }
    } else if (lastComma >= 0) {
      body = /^-?\d{1,3}(,\d{3})+$/.test(body)
        ? body.replace(/,/g, '')
        : body.replace(/,/g, '.');
    } else if (lastDot >= 0 && /^-?\d{1,3}(\.\d{3})+$/.test(body)) {
      body = body.replace(/\./g, '');
    }

    var value = Number(body);
    return isFinite(value) ? value : null;
  }

  /**
   * Titre d'onglet -> prix. Forme observée : ``SYMBOL PRIX ▲ +x %`` (le prix
   * y est mis à jour en direct, fait vérifié le 09/09).
   */
  function priceFromTitle(title) {
    var raw = String(title || '');
    var arrow = raw.search(/[▲▼]/);
    var head = arrow >= 0 ? raw.slice(0, arrow) : raw;
    /* « 78 760,10 » : on recolle les groupes de milliers avant de découper. */
    head = head.replace(/(\d)[\s'\u2019](\d)/g, '$1$2');
    var tokens = head.trim().split(/\s+/);
    for (var i = 0; i < tokens.length; i += 1) {
      if (/^\d[\d.,]*$/.test(tokens[i])) {
        var value = parsePrice(tokens[i]);
        if (value !== null && value > 0) { return value; }
      }
    }
    return null;
  }

  var pure = {
    parsePrice: parsePrice,
    priceFromTitle: priceFromTitle,
    BID_ASK_SELECTORS: BID_ASK_SELECTORS,
    RETRY_MS: RETRY_MS,
    RETRY_MAX: RETRY_MAX,
    TICK_MS: TICK_MS
  };

  if (typeof module !== 'undefined' && module.exports) { module.exports = pure; }
  if (typeof window === 'undefined' || typeof document === 'undefined') { return; }

  /* ------------------------------------------------------------------ */
  /* Câblage navigateur                                                  */
  /* ------------------------------------------------------------------ */

  var nonce = null;
  var chart = null;
  var lastSymbol = null;
  var lastResolution = null;
  var lastPrice = null;
  var badges = { sell: null, buy: null, at: 0 };
  var createdIds = [];          /* ids des FORMES posées par l'extension */
  var orderLines = {};          /* clef -> ligne d'ordre déplaçable */
  var tickTimer = null;

  function debug() {
    try {
      var args = Array.prototype.slice.call(arguments);
      args.unshift(NS);
      console.debug.apply(console, args);
    } catch (e) { /* une console absente ne casse rien */ }
  }

  function readNonce() {
    try {
      var root = document.documentElement;
      if (!root) { return null; }
      var value = (root.dataset && root.dataset.omenNonce)
        || (root.getAttribute && root.getAttribute('data-omen-nonce'));
      return value ? String(value) : null;
    } catch (e) {
      return null;
    }
  }

  function post(type, payload) {
    if (!nonce) { return; }
    var message = { omen: true, nonce: nonce, to: 'content', type: type };
    var keys = payload ? Object.keys(payload) : [];
    for (var i = 0; i < keys.length; i += 1) { message[keys[i]] = payload[keys[i]]; }
    try {
      window.postMessage(message, location.origin);
    } catch (e) {
      debug('postMessage refusé', e);
    }
  }

  function activeChart() {
    try {
      var tvApi = window.TradingViewApi;
      if (!tvApi || typeof tvApi.activeChart !== 'function') { return null; }
      return tvApi.activeChart();
    } catch (e) {
      return null;
    }
  }

  /* ---- lecture du symbole, de l'intervalle, du prix, du bid/ask ------ */

  function currentSymbol() {
    try {
      return chart && typeof chart.symbol === 'function' ? String(chart.symbol()) : null;
    } catch (e) { return null; }
  }

  function currentResolution() {
    try {
      return chart && typeof chart.resolution === 'function'
        ? String(chart.resolution()) : null;
    } catch (e) { return null; }
  }

  function firstMatch(selectors) {
    for (var i = 0; i < selectors.length; i += 1) {
      try {
        var node = document.querySelector(selectors[i]);
        if (node) { return node; }
      } catch (e) { /* sélecteur refusé par le navigateur : au suivant */ }
    }
    return null;
  }

  function resolveBadges(nowMs) {
    if (badges.at && (nowMs - badges.at) < BADGE_RESOLVE_MS
        && (badges.sell || badges.buy)) {
      return;
    }
    badges.at = nowMs;
    badges.sell = firstMatch(BID_ASK_SELECTORS.sell);
    badges.buy = firstMatch(BID_ASK_SELECTORS.buy);
  }

  function badgePrice(node) {
    if (!node) { return null; }
    try {
      return parsePrice(node.textContent);
    } catch (e) {
      return null;
    }
  }

  function readTick(nowMs) {
    resolveBadges(nowMs);
    var price = priceFromTitle(document.title);
    if (price === null) { price = lastPrice; }
    lastPrice = price;
    return {
      price: price,
      bid: badgePrice(badges.sell),
      ask: badgePrice(badges.buy),
      ts: nowMs
    };
  }

  /* ---- dessin -------------------------------------------------------- */

  function drawingRefused(error) {
    var message = String((error && error.message) || error || '');
    return /cannot create/i.test(message) || /not authenticated/i.test(message);
  }

  function shapeOptions(command) {
    return {
      shape: command.shape,
      text: command.text || '',
      lock: true,
      disableSelection: false,
      disableSave: true,
      overrides: command.overrides || {}
    };
  }

  function runShape(command) {
    return Promise.resolve(chart.createShape(command.point, shapeOptions(command)))
      .then(function (id) {
        if (id !== null && id !== undefined) { createdIds.push(id); }
        return id;
      });
  }

  function runMultipoint(command) {
    return Promise.resolve(
      chart.createMultipointShape(command.points, shapeOptions(command))
    ).then(function (id) {
      if (id !== null && id !== undefined) { createdIds.push(id); }
      return id;
    });
  }

  function wireOrderLine(key, line) {
    if (!line || typeof line.onMove !== 'function') { return; }
    try {
      line.onMove(function () {
        var price = null;
        try { price = typeof line.getPrice === 'function' ? line.getPrice() : null; }
        catch (e) { price = null; }
        post('tv:line_moved', { key: key, price: price });
      });
    } catch (e) {
      debug('onMove indisponible pour', key, e);
    }
  }

  function applyOrderLine(command) {
    var key = String(command.key || 'line');
    var existing = orderLines[key];
    if (existing) {
      try {
        if (typeof existing.setPrice === 'function') { existing.setPrice(command.price); }
        if (typeof existing.setText === 'function') { existing.setText(command.text || ''); }
        return Promise.resolve(key);
      } catch (e) {
        debug('mise à jour de ligne impossible', key, e);
      }
    }
    return Promise.resolve(chart.createOrderLine()).then(function (line) {
      if (!line) { return null; }
      try {
        if (typeof line.setPrice === 'function') { line.setPrice(command.price); }
        if (typeof line.setText === 'function') { line.setText(command.text || ''); }
        if (typeof line.setQuantity === 'function') {
          line.setQuantity(String(command.quantity === undefined ? '' : command.quantity));
        }
        if (command.color && typeof line.setLineColor === 'function') {
          line.setLineColor(command.color);
        }
      } catch (e) {
        debug('habillage de ligne partiel', key, e);
      }
      orderLines[key] = line;
      wireOrderLine(key, line);
      return key;
    });
  }

  /** N'efface QUE ce que l'extension a posé (spec §6.1). */
  function clearDrawings() {
    var removed = 0;
    for (var i = 0; i < createdIds.length; i += 1) {
      try {
        chart.removeEntity(createdIds[i]);
        removed += 1;
      } catch (e) {
        debug('removeEntity refusé', createdIds[i], e);
      }
    }
    createdIds = [];
    var keys = Object.keys(orderLines);
    for (var k = 0; k < keys.length; k += 1) {
      var line = orderLines[keys[k]];
      try {
        if (line && typeof line.remove === 'function') { line.remove(); removed += 1; }
      } catch (e) {
        debug('remove() de ligne refusé', keys[k], e);
      }
    }
    orderLines = {};
    return Promise.resolve(removed);
  }

  function runCommand(command) {
    if (!command || typeof command !== 'object') { return Promise.resolve(null); }
    if (command.kind === 'clear') { return clearDrawings(); }
    if (command.kind === 'shape') { return runShape(command); }
    if (command.kind === 'multipoint') { return runMultipoint(command); }
    if (command.kind === 'orderline') { return applyOrderLine(command); }
    debug('commande de dessin inconnue', command.kind);
    return Promise.resolve(null);
  }

  function applyCommands(requestId, commands) {
    if (!chart) {
      post('draw:result', { id: requestId, error: 'no_chart', ids: [] });
      return;
    }
    if (window.is_authenticated === false) {
      /* Gate ``ensureDrawingCreationAllowed`` : inutile d'essayer (spec §11). */
      post('draw:result', { id: requestId, error: 'not_authenticated', ids: [] });
      return;
    }
    var list = Array.isArray(commands) ? commands : [];
    var done = [];
    var chain = Promise.resolve();
    list.forEach(function (command) {
      chain = chain.then(function () {
        return runCommand(command).then(function (id) {
          if (id !== null && id !== undefined) { done.push(String(id)); }
        });
      });
    });
    chain.then(function () {
      post('draw:result', { id: requestId, ids: done });
    }).catch(function (error) {
      post('draw:result', {
        id: requestId,
        ids: done,
        error: drawingRefused(error) ? 'not_authenticated' : 'draw_failed',
        message: String((error && error.message) || error).slice(0, 200)
      });
    });
  }

  /* ---- boucle et écoute ---------------------------------------------- */

  function postSymbol() {
    var symbol = currentSymbol();
    var resolution = currentResolution();
    lastSymbol = symbol;
    lastResolution = resolution;
    post('tv:symbol', {
      tv_symbol: symbol,
      resolution: resolution,
      drawing_allowed: window.is_authenticated !== false
    });
  }

  function tick() {
    var nowMs = Date.now();
    var symbol = currentSymbol();
    var resolution = currentResolution();
    if (symbol !== lastSymbol || resolution !== lastResolution) {
      postSymbol();
    }
    var sample = readTick(nowMs);
    post('tv:tick', sample);
  }

  function onMessage(event) {
    if (event.source !== window) { return; }
    if (event.origin !== location.origin) { return; }
    var data = event.data;
    if (!data || data.omen !== true || data.to !== 'bridge') { return; }
    if (!nonce || data.nonce !== nonce) { return; }

    if (data.type === 'draw:apply') { applyCommands(data.id, data.commands); return; }
    if (data.type === 'draw:clear') {
      if (!chart) {
        post('draw:result', { id: data.id, error: 'no_chart', ids: [] });
        return;
      }
      clearDrawings().then(function (removed) {
        post('draw:result', { id: data.id, ids: [], removed: removed });
      });
      return;
    }
    if (data.type === 'tv:request') { postSymbol(); return; }
  }

  function start() {
    chart = activeChart();
    window.addEventListener('message', onMessage, false);
    try {
      if (chart && typeof chart.onSymbolChanged === 'function') {
        chart.onSymbolChanged().subscribe(null, function () { postSymbol(); });
      }
    } catch (e) {
      debug('onSymbolChanged indisponible', e);
    }
    post('tv:ready', { drawing_allowed: window.is_authenticated !== false });
    postSymbol();
    tickTimer = setInterval(tick, TICK_MS);
    debug('pont prêt');
  }

  var attempts = 0;
  function waitForPage() {
    attempts += 1;
    nonce = readNonce();
    var ready = activeChart();
    if (nonce && ready) { start(); return; }
    if (attempts >= RETRY_MAX) {
      if (nonce) {
        /* Le panneau doit savoir qu'il tournera sans dessin ni bid/ask. */
        post('tv:unavailable', { reason: ready ? 'no_nonce' : 'no_api' });
      }
      debug('API TradingView ou nonce absents après', attempts, 'essais');
      return;
    }
    setTimeout(waitForPage, RETRY_MS);
  }

  waitForPage();
})();
