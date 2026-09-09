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

  /*
   * SÉLECTEURS DU PANE — la zone de tracé du graphique, celle dont la hauteur
   * porte l'échelle des prix (Alt+clic, spec §8). Du plus précis au plus
   * large ; le dernier recours est le canvas lui-même. Aucun n'est documenté
   * par TradingView : un clic qui ne tombe dans AUCUN de ces cadres est
   * ignoré en silence (pas d'alerte à un prix inventé).
   *
   * RELEVÉ SUR LA PAGE RÉELLE le 09/09 : ``.chart-markup-table.pane`` et
   * ``.chart-gui-wrapper`` répondent (cadre 734x629), les deux
   * ``[data-name=...]`` ne répondent pas — ils restent au cas où TradingView
   * y revienne, leur absence ne coûte qu'un ``querySelectorAll`` vide.
   */
  var PANE_SELECTORS = [
    '.chart-markup-table.pane',
    '[data-name="pane-widget-chart"]',
    '[data-name="pane"]',
    '.chart-gui-wrapper',
    '.chart-container canvas'
  ];

  /*
   * SÉLECTEURS DE LA WATCHLIST — les lignes du panneau de droite. Les rangées
   * portent le symbole QUALIFIÉ dans ``data-symbol-full`` (``NASDAQ:AAPL``) et
   * sa forme courte dans ``data-symbol-short`` (``AAPL``, inutilisable seule :
   * le mappage Yahoo exige la place). On s'en tient à des conteneurs
   * IDENTIFIÉS comme watchlist — un ``[data-symbol-full]`` cherché dans tout
   * le document ramasserait les pastilles du graphique, et importerait dans
   * les favoris des titres que Massii n'a jamais mis en liste.
   * Aucune correspondance = « watchlist introuvable », pas une erreur.
   *
   * RELEVÉ SUR LA PAGE RÉELLE le 09/09 : ``.widgetbar-widget-watchlist`` rend
   * les 17 rangées de la liste par défaut, chacune portant BIEN le symbole
   * qualifié (``SP:SPX``, ``TVC:NDQ``, ``CBOE:VIX``...) dans
   * ``data-symbol-full`` et sa forme courte dans ``data-symbol-short``. Les
   * sélecteurs ``[data-name="watchlist"]`` ne répondent pas aujourd'hui.
   */
  var WATCHLIST_SELECTORS = [
    '[data-name="watchlists-dialog"] [data-symbol-full]',
    '[data-name="watchlist"] [data-symbol-full]',
    '.widgetbar-widget-watchlist [data-symbol-full]',
    '.widgetbar-wrap [data-symbol-full]',
    '[data-name="watchlist"] [data-symbol-short]',
    '.widgetbar-widget-watchlist [data-symbol-short]',
    '.widgetbar-wrap [data-symbol-short]'
  ];

  /* Au-delà, ce n'est plus une watchlist : on coupe (le panneau replafonne
     de toute façon à 30 créations). */
  var WATCHLIST_MAX_ROWS = 200;

  /* L'hôte du panneau, en monde isolé : un Alt+clic DANS le panneau n'est
     jamais un clic sur le graphique. */
  var PANEL_HOST_ID = 'omen-coach';

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

  /**
   * Symbole d'une rangée de watchlist : le QUALIFIÉ d'abord (``NASDAQ:AAPL``),
   * la forme courte ensuite, le texte en dernier. Rend ``''`` quand la rangée
   * ne dit rien d'exploitable — le panneau écartera les inconnus de toute
   * façon, mais autant ne pas lui envoyer du vide.
   *
   * PUR : prend un objet porteur de ``getAttribute``/``textContent``, pas un
   * vrai nœud (d'où sa testabilité sous Node).
   */
  function symbolFromRow(node) {
    if (!node) { return ''; }
    var attributes = ['data-symbol-full', 'data-symbol', 'data-symbol-short'];
    for (var i = 0; i < attributes.length; i += 1) {
      var value = null;
      try {
        value = typeof node.getAttribute === 'function'
          ? node.getAttribute(attributes[i]) : null;
      } catch (e) {
        value = null;
      }
      var cleaned = String(value === null || value === undefined ? '' : value).trim();
      if (cleaned) { return cleaned; }
    }
    var text = String(node.textContent === undefined || node.textContent === null
      ? '' : node.textContent).trim();
    /*
     * Dernier recours, et il est STRICT. Vérifié sur la page réelle le 09/09 :
     * une rangée rend « SSPXDMarket closed7,636.36−37.16−0.48% », dont le
     * premier mot n'est PAS un symbole. On n'accepte donc que deux formes —
     * qualifiée (``NASDAQ:AAPL``) ou ticker court tout en capitales — ce qui
     * écarte d'office ce charabia comme un prix (« 78.20 »).
     */
    var first = text.split(/\s+/)[0] || '';
    if (/^[A-Z0-9]{1,12}:[A-Z0-9._-]{1,12}$/.test(first)) { return first; }
    if (/^[A-Z][A-Z0-9._-]{0,11}$/.test(first)) { return first; }
    return '';
  }

  var pure = {
    parsePrice: parsePrice,
    priceFromTitle: priceFromTitle,
    symbolFromRow: symbolFromRow,
    BID_ASK_SELECTORS: BID_ASK_SELECTORS,
    PANE_SELECTORS: PANE_SELECTORS,
    WATCHLIST_SELECTORS: WATCHLIST_SELECTORS,
    WATCHLIST_MAX_ROWS: WATCHLIST_MAX_ROWS,
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

  /**
   * Publie un message vers ``content.js``.
   *
   * ATTENTION : la charge utile est APLATIE dans l'enveloppe. Les quatre clés
   * ``omen``, ``nonce``, ``to`` et ``type`` sont donc RÉSERVÉES — une charge
   * qui porterait un champ ``to`` (le haut d'une échelle de prix, par exemple)
   * écraserait le destinataire et le message serait jeté en silence. D'où
   * ``range_from``/``range_to`` dans ``tv:alt_click``.
   */
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

  /* ---- Alt+clic sur le graphique (spec §8) ---------------------------- */

  function queryAll(selector) {
    try {
      var found = document.querySelectorAll(selector);
      return found ? Array.prototype.slice.call(found) : [];
    } catch (e) {
      return [];                 /* sélecteur refusé par le navigateur */
    }
  }

  function rectOf(node) {
    try {
      if (!node || typeof node.getBoundingClientRect !== 'function') { return null; }
      var rect = node.getBoundingClientRect();
      if (!rect || !isFinite(rect.height) || rect.height <= 0) { return null; }
      return rect;
    } catch (e) {
      return null;
    }
  }

  function contains(rect, x, y) {
    return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
  }

  /** Le clic est-il tombé DANS le panneau du coach (shadow DOM) ? */
  function insidePanel(target) {
    var node = target;
    var depth = 0;
    while (node && depth < 12) {
      if (node.id === PANEL_HOST_ID) { return true; }
      node = node.parentNode;
      depth += 1;
    }
    return false;
  }

  /**
   * Le pane sous le point cliqué : d'abord en remontant depuis la cible,
   * sinon le premier cadre du document qui CONTIENT vraiment le point. Rien
   * qui contienne le point = rien du tout (jamais un cadre au hasard, dont la
   * hauteur donnerait un prix inventé).
   */
  function paneFromPoint(target, x, y) {
    var i;
    for (i = 0; i < PANE_SELECTORS.length; i += 1) {
      try {
        if (target && typeof target.closest === 'function') {
          var climbed = target.closest(PANE_SELECTORS[i]);
          var climbedRect = rectOf(climbed);
          if (climbedRect && contains(climbedRect, x, y)) {
            return { node: climbed, rect: climbedRect };
          }
        }
      } catch (e) { /* sélecteur ou closest() refusé : au suivant */ }
    }
    for (i = 0; i < PANE_SELECTORS.length; i += 1) {
      var nodes = queryAll(PANE_SELECTORS[i]);
      for (var n = 0; n < nodes.length; n += 1) {
        var rect = rectOf(nodes[n]);
        if (rect && contains(rect, x, y)) { return { node: nodes[n], rect: rect }; }
      }
    }
    return null;
  }

  /** ``{from, to}`` de l'échelle affichée, ou ``null`` si l'API se tait. */
  function visiblePriceRange() {
    try {
      if (!chart || typeof chart.getVisiblePriceRange !== 'function') { return null; }
      var range = chart.getVisiblePriceRange();
      if (!range) { return null; }
      var from = Number(range.from);
      var to = Number(range.to);
      if (!isFinite(from) || !isFinite(to)) { return null; }
      return { from: from, to: to };
    } catch (e) {
      debug('getVisiblePriceRange indisponible', e);
      return null;
    }
  }

  /**
   * Alt+clic -> ``tv:alt_click`` avec la GÉOMÉTRIE du clic (ordonnée, cadre du
   * pane, plage de prix). La conversion en prix est faite par ``content.js``
   * avec ``lib/price_axis.js`` : les modules ``lib/*`` ne sont chargés que
   * dans le monde ISOLÉ, et les publier dans le monde MAIN reviendrait à poser
   * ``OmenLib`` sur le ``window`` de TradingView — la page pourrait alors
   * décider du prix qu'on envoie au serveur.
   *
   * Ni ``preventDefault`` ni ``stopPropagation`` : on observe, TradingView
   * garde son comportement.
   */
  /* Vu à la vérification : sur le canvas de TradingView, le vrai ``click`` de
     la souris n'arrive JAMAIS (la page le consomme), seul un événement
     synthétique passait. On écoute donc aussi le ``mousedown`` en capture, et
     on dédoublonne les deux (600 ms) pour qu'un clic ne pose qu'un dialogue. */
  var lastAltFireMs = 0;

  function onAltClick(event) {
    if (!event || event.altKey !== true) { return; }
    if (event.button !== undefined && event.button !== null && event.button !== 0) {
      return;
    }
    if (insidePanel(event.target)) { return; }
    var nowMs = Date.now();
    if (nowMs - lastAltFireMs < 600) { return; }
    lastAltFireMs = nowMs;
    var x = Number(event.clientX);
    var y = Number(event.clientY);
    if (!isFinite(x) || !isFinite(y)) { return; }

    var pane = paneFromPoint(event.target, x, y);
    if (!pane) {
      debug('Alt+clic hors de la zone du graphique : ignoré');
      return;
    }
    var range = visiblePriceRange();
    /* ``range_from``/``range_to`` et non ``from``/``to`` : ``to`` est une clé
       RÉSERVÉE de l'enveloppe (le destinataire), cf. ``post``. */
    post('tv:alt_click', {
      y: y,
      top: pane.rect.top,
      height: pane.rect.height,
      range_from: range ? range.from : null,
      range_to: range ? range.to : null,
      last_price: lastPrice
    });
  }

  /* ---- watchlist affichée (spec §8) ----------------------------------- */

  /**
   * Les symboles de la watchlist affichée, dans l'ordre des rangées. Le
   * PREMIER sélecteur qui rend au moins un symbole gagne : les autres sont des
   * replis, pas des compléments (on ne mélange pas deux listes).
   */
  function readWatchlist() {
    for (var i = 0; i < WATCHLIST_SELECTORS.length; i += 1) {
      var nodes = queryAll(WATCHLIST_SELECTORS[i]);
      if (!nodes.length) { continue; }
      var symbols = [];
      var seen = {};
      for (var n = 0; n < nodes.length && symbols.length < WATCHLIST_MAX_ROWS; n += 1) {
        var symbol = symbolFromRow(nodes[n]);
        if (!symbol) { continue; }
        var key = symbol.toUpperCase();
        if (Object.prototype.hasOwnProperty.call(seen, key)) { continue; }
        seen[key] = true;
        symbols.push(symbol);
      }
      if (symbols.length) {
        return { symbols: symbols, selector: WATCHLIST_SELECTORS[i] };
      }
    }
    return null;
  }

  function postWatchlist() {
    var found = readWatchlist();
    if (!found) {
      debug('watchlist introuvable (sélecteurs à revoir ?)');
      post('tv:watchlist', { symbols: [], error: 'not_found' });
      return;
    }
    debug('watchlist lue', found.symbols.length, 'symboles via', found.selector);
    post('tv:watchlist', { symbols: found.symbols, selector: found.selector });
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
    if (data.type === 'tv:watchlist_request') { postWatchlist(); return; }
  }

  function start() {
    chart = activeChart();
    window.addEventListener('message', onMessage, false);
    /* En CAPTURE : TradingView arrête volontiers les clics du graphique avant
       qu'ils ne remontent jusqu'au document. */
    try {
      document.addEventListener('mousedown', onAltClick, true);
      document.addEventListener('click', onAltClick, true);
    } catch (e) {
      debug('écoute du Alt+clic impossible', e);
    }
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
