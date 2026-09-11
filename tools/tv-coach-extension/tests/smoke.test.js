'use strict';

/**
 * tests/smoke.test.js — on CHARGE vraiment ``content.js`` (et ``bridge.js``)
 * avec un DOM bouchon.
 *
 * Leçon du dépôt : un ``new Function(src)`` ne prouve que la grammaire ; il ne
 * résout aucun accès à ``document``, ``chrome`` ou ``OmenLib``. Ici le panneau
 * démarre pour de bon, sans navigateur et SANS objet ``chrome`` — la voie
 * dégradée doit tenir debout toute seule.
 */
const test = require('node:test');
const assert = require('node:assert');

/* ``bridge.js`` d'abord : sans window/document il n'exporte que ses fonctions
   pures et ne lance aucune minuterie. */
const bridge = require('../bridge.js');

const ORIGIN = 'https://www.tradingview.com';

function makeElement(tag) {
  const listeners = {};
  const attributes = {};
  const element = {
    tagName: String(tag || 'div').toUpperCase(),
    children: [],
    style: {},
    dataset: {},
    innerHTML: '',
    textContent: '',
    hidden: false,
    disabled: false,
    offsetLeft: 0,
    offsetTop: 0,
    listeners: listeners,
    attributes: attributes,
    appendChild: function (child) { element.children.push(child); return child; },
    setAttribute: function (name, value) { attributes[name] = String(value); },
    getAttribute: function (name) {
      return Object.prototype.hasOwnProperty.call(attributes, name)
        ? attributes[name] : null;
    },
    addEventListener: function (type, fn) {
      listeners[type] = listeners[type] || [];
      listeners[type].push(fn);
    },
    removeEventListener: function () { return undefined; },
    querySelector: function () { return null; },
    querySelectorAll: function () { return []; },
    attachShadow: function () {
      element.shadowRoot = makeElement('#shadow');
      return element.shadowRoot;
    },
    remove: function () { return undefined; }
  };
  return element;
}

const windowListeners = {};
const documentListeners = {};
const posted = [];

const documentStub = {
  documentElement: makeElement('html'),
  body: makeElement('body'),
  title: 'AAPL 234,56 ▲ +1,20 %',
  createElement: makeElement,
  addEventListener: function (type, fn) {
    documentListeners[type] = documentListeners[type] || [];
    documentListeners[type].push(fn);
  },
  querySelector: function () { return null; },
  querySelectorAll: function () { return []; }
};

const windowStub = {
  addEventListener: function (type, fn) {
    windowListeners[type] = windowListeners[type] || [];
    windowListeners[type].push(fn);
  },
  postMessage: function (message) { posted.push(message); },
  location: { origin: ORIGIN }
};

global.window = windowStub;
global.document = documentStub;
global.location = { origin: ORIGIN };

/* Les modules purs s'enregistrent dans globalThis.OmenLib ; bars/guards/ledger
   (lot ext-scalp) sont volontairement ABSENTS : le panneau doit tenir sans. */
require('../lib/i18n.js');
require('../lib/symbols.js');
require('../lib/alerts.js');
require('../lib/api.js');
require('../lib/draw.js');
require('../lib/outage.js');

const coach = require('../content.js');

function settled() {
  return new Promise(function (resolve) { setTimeout(resolve, 0); });
}

function shadow() {
  const host = documentStub.body.children[0];
  return host && host.shadowRoot ? host.shadowRoot : null;
}

function sendFromBridge(payload, nonce) {
  const handler = windowListeners.message[0];
  const data = Object.assign({ omen: true, to: 'content',
                               nonce: nonce === undefined ? coach.state.nonce : nonce },
                             payload);
  handler({ source: windowStub, origin: ORIGIN, data: data });
}

test.after(function () { coach.stopTimers(); });

test('le panneau démarre sans chrome.* et pose son nonce', async () => {
  await settled();
  assert.ok(coach.state.nonce, 'aucun nonce tiré');
  assert.strictEqual(documentStub.documentElement.dataset.omenNonce, coach.state.nonce);
  assert.strictEqual(documentStub.documentElement.getAttribute('data-omen-nonce'),
                     coach.state.nonce);
});

test('le panneau est monté en shadow DOM et rendu', async () => {
  await settled();
  const host = documentStub.body.children[0];
  assert.ok(host, 'hôte non ajouté au document');
  assert.strictEqual(host.id, 'omen-coach');
  assert.ok(host.shadowRoot, 'pas de shadow root');
  assert.ok(host.shadowRoot.innerHTML.indexOf('omen-wrap') !== -1);
  assert.ok(host.shadowRoot.listeners.click.length === 1, 'délégation du clic absente');
});

/*
 * render() reconstruit TOUT le panneau (``root.innerHTML = html``) : sans
 * garde-fou, ``.omen-body`` (overflow-y auto) perd sa position de défilement
 * et remonte en haut à chaque repeint — vécu sur « Dessiner les paris » sans
 * pari ouvert (le panneau se comporte comme s'il avait rafraîchi la page).
 *
 * Le bouchon DOM de ce fichier a un ``querySelector`` DÉLIBÉRÉMENT muet
 * (`() => null`, pas un vrai moteur de sélecteurs) et un ``innerHTML`` qui
 * n'est qu'une chaîne : impossible d'y trouver un ``.omen-body`` réel. On le
 * simule ICI, localement (jamais dans le bouchon partagé par tous les autres
 * tests), avec deux objets DISTINCTS pour l'ancien et le nouveau nœud — sinon
 * un ``render()`` qui ne reporterait RIEN passerait quand même le test, le
 * même objet lu puis relu portant encore sa valeur de départ.
 */
test('render() reporte le scrollTop de l’ancien .omen-body vers le nouveau', () => {
  const root = shadow();
  assert.ok(root, 'pas de racine d’ombre');

  const before = { scrollTop: 120 };     /* l'ancien nœud, tel qu'avant le clic */
  const after = { scrollTop: 0 };        /* le nœud RECRÉÉ par innerHTML =, neuf */
  let replaced = false;

  const originalQuerySelector = root.querySelector;
  root.querySelector = function (selector) {
    if (selector !== '.omen-body') { return originalQuerySelector.call(root, selector); }
    return replaced ? after : before;
  };

  let storedHtml = root.innerHTML;
  Object.defineProperty(root, 'innerHTML', {
    configurable: true,
    get: function () { return storedHtml; },
    set: function (value) { storedHtml = value; replaced = true; }
  });

  try {
    coach.render();
    assert.strictEqual(after.scrollTop, 120,
                       'le NOUVEAU .omen-body n’a pas reçu le scrollTop de l’ancien');
    assert.strictEqual(before.scrollTop, 120, 'l’ancien ne doit pas être modifié');
  } finally {
    root.querySelector = originalQuerySelector;
    delete root.innerHTML;
    root.innerHTML = storedHtml;
  }
});

test('render() replié ne touche à aucun scrollTop (pas de .omen-body à replier)',
     () => {
  const root = shadow();
  coach.state.collapsed = true;
  try {
    assert.doesNotThrow(function () { coach.render(); });
    assert.ok(root.innerHTML.indexOf('omen-collapsed') !== -1);
  } finally {
    coach.state.collapsed = false;
    coach.render();
  }
});

test('render() ne lève jamais, même quand .omen-body est introuvable (bouchon dégradé)',
     () => {
  assert.doesNotThrow(function () { coach.render(); });
});

test('sans profil de frais ni token, les bandeaux le disent', async () => {
  await settled();
  assert.ok(Object.prototype.hasOwnProperty.call(coach.state.banners, 'no_fee_profile'));
  assert.ok(Object.prototype.hasOwnProperty.call(coach.state.banners, 'token_missing'));
  assert.ok(shadow().innerHTML.indexOf('Frais non configur') !== -1);
});

test('un message du pont sans le bon nonce est ignoré', () => {
  sendFromBridge({ type: 'tv:symbol', tv_symbol: 'NASDAQ:TSLA', resolution: '60' },
                 'mauvais-nonce');
  assert.notStrictEqual(coach.state.tv_symbol, 'NASDAQ:TSLA');
});

test('un message du pont bien signé met la fiche à jour', async () => {
  sendFromBridge({ type: 'tv:symbol', tv_symbol: 'BINANCE:BTCUSDT.P',
                   resolution: '5', drawing_allowed: true });
  await settled();
  assert.strictEqual(coach.state.tv_symbol, 'BINANCE:BTCUSDT.P');
  assert.strictEqual(coach.state.symbol, 'BTC-USD');
  assert.strictEqual(coach.state.kind, 'crypto');
  assert.strictEqual(coach.state.mode, 'scalp');

  /* Ce changement de titre vient de faire échouer son tout premier appel
     réseau (aucun ``chrome.*`` dans ce harnais, ``GET /brief`` rejette) :
     un blip isolé doit rester invisible (spec bug « Omen injoignable posé
     au 1er échec »), preuve prise dans le flux RÉEL (pas un appel direct à
     ``noteError``). */
  assert.strictEqual(coach.state.outage.status, 'suspect',
                     'le premier échec réseau doit être vu, sans encore alarmer');
  assert.ok(!Object.prototype.hasOwnProperty.call(coach.state.banners, 'server_down'),
            'un premier échec ne doit pas lever le bandeau « Omen injoignable »');
});

test('un titre non mappable lève le bandeau « titre non suivi »', async () => {
  sendFromBridge({ type: 'tv:symbol', tv_symbol: 'WTF:XYZ', resolution: '60' });
  await settled();
  assert.strictEqual(coach.state.symbol, null);
  assert.strictEqual(coach.state.mode, 'swing');
  assert.ok(Object.prototype.hasOwnProperty.call(coach.state.banners, 'symbol_unknown'));
});

test('les ticks nourrissent le prix et gardent le précédent', async () => {
  sendFromBridge({ type: 'tv:tick', price: 100, bid: 99.9, ask: 100.1,
                   ts: Date.now() });
  sendFromBridge({ type: 'tv:tick', price: 101, bid: 100.9, ask: 101.1,
                   ts: Date.now() });
  assert.strictEqual(coach.state.price, 101);
  assert.strictEqual(coach.state.prev_price, 100);
  assert.strictEqual(coach.state.bid, 100.9);
});

test('changer de titre en scalp ne laisse jamais un ticket au prix de l’ancien titre',
     async () => {
  /* Titre A : EURUSD (forex), résolution scalp. */
  sendFromBridge({ type: 'tv:symbol', tv_symbol: 'FX:EURUSD', resolution: '1' });
  await settled();
  assert.strictEqual(coach.state.symbol, 'EURUSD=X');
  assert.strictEqual(coach.state.mode, 'scalp');
  assert.strictEqual(coach.state.ticket, null, 'aucun ticket avant le premier tick');

  sendFromBridge({ type: 'tv:tick', price: 1.16043, bid: 1.16040, ask: 1.16046,
                   ts: Date.now() });
  assert.ok(coach.state.ticket, 'le premier tick du titre A doit ouvrir un ticket');
  assert.strictEqual(coach.state.ticket.symbol, 'EURUSD=X');
  assert.strictEqual(coach.state.ticket.entry, 1.16043);

  /* Titre B : BTC-USD, magnitude de prix totalement différente. Un autre
     ticker TradingView que le test « mode scalp de bout en bout » plus bas
     (``BINANCE:BTCUSDT.P``) pour ne pas fausser SON changement de titre. */
  sendFromBridge({ type: 'tv:symbol', tv_symbol: 'COINBASE:BTCUSD', resolution: '1' });
  await settled();
  assert.strictEqual(coach.state.symbol, 'BTC-USD');
  assert.strictEqual(coach.state.ticket, null,
                     'le ticket du titre A doit être purgé au changement de titre');
  assert.strictEqual(coach.state.price, null,
                     'le prix du titre A ne doit pas survivre au changement de titre');
  assert.strictEqual(coach.state.prev_price, null);
  assert.strictEqual(coach.state.bid, null);
  assert.strictEqual(coach.state.ask, null);

  sendFromBridge({ type: 'tv:tick', price: 77203, bid: 77200.5, ask: 77205.5,
                   ts: Date.now() });
  assert.ok(coach.state.ticket, 'le premier tick du titre B doit ouvrir un ticket');
  assert.strictEqual(coach.state.ticket.symbol, 'BTC-USD');
  assert.strictEqual(coach.state.ticket.entry, 77203);

  /* Stop/cible calculés sur 77203 (±1 %, pas d’ATR jour puisque la fiche
     n’est pas encore arrivée) — JAMAIS sur 1,16043. */
  const expectedStop = 77203 - (77203 * 0.01);
  const expectedTarget = 77203 + (77203 * 0.01 * 2);
  assert.ok(Math.abs(coach.state.ticket.stop - expectedStop) < 1e-6,
            'stop attendu ' + expectedStop + ', reçu ' + coach.state.ticket.stop);
  assert.ok(Math.abs(coach.state.ticket.target - expectedTarget) < 1e-6,
            'cible attendue ' + expectedTarget + ', reçue ' + coach.state.ticket.target);
  assert.notStrictEqual(coach.state.ticket.stop, 1.16043 - (1.16043 * 0.01),
                        'le stop du titre B a été calculé sur le prix du titre A');
});

test('mode scalp uniquement sous 5 minutes', () => {
  assert.strictEqual(coach.modeFor('1'), 'scalp');
  assert.strictEqual(coach.modeFor('5'), 'scalp');
  assert.strictEqual(coach.modeFor('15'), 'swing');
  assert.strictEqual(coach.modeFor('60'), 'swing');
  assert.strictEqual(coach.modeFor('1D'), 'swing');
  assert.strictEqual(coach.modeFor(null), 'swing');
});

test('la charge utile de POST /orders a la forme du serveur', () => {
  const fake = {
    symbol: 'AAPL',
    settings: { fee_profile: 'ibkr' },
    ticket: { side: 'buy', qty: 3.4, stop: 220.5, target: 260, thesis: 'test' }
  };
  const payload = coach.buildOrderPayload(fake, false);
  assert.deepStrictEqual(Object.keys(payload).sort(), [
    'confirmed', 'fee_profile', 'kind', 'qty', 'side', 'stop_loss', 'symbol',
    'target', 'thesis'
  ]);
  assert.strictEqual(payload.kind, 'market');
  assert.strictEqual(payload.qty, 3, 'la quantité doit être un ENTIER');
  assert.strictEqual(payload.stop_loss, 220.5);
  assert.strictEqual(payload.target, 260);
  assert.strictEqual(payload.confirmed, false);
  assert.strictEqual(coach.buildOrderPayload(fake, true).confirmed, true);
  /* Une quantité nulle reste au minimum de 1 : le serveur refusera lui-même. */
  assert.strictEqual(
    coach.buildOrderPayload({ symbol: 'AAPL', settings: {}, ticket: { side: 'sell' } },
                            false).qty, 0);
});

test('tout texte externe est échappé avant d’entrer dans le panneau', () => {
  coach.state.brief = {
    news: [{ ts: '2026-09-09T10:00:00Z', title: '<img src=x onerror=alert(1)>',
             source: 'reuters' }],
    calendar: [], ideas: [], hypotheses: [], alerts: []
  };
  coach.render();
  const html = shadow().innerHTML;
  assert.ok(html.indexOf('&lt;img src=x') !== -1, 'le HTML externe n’est pas échappé');
  assert.ok(html.indexOf('<img src=x') === -1, 'du HTML externe est passé tel quel');
});

test('esc couvre les cinq caractères dangereux', () => {
  assert.strictEqual(coach.esc('<a href="x">&\'</a>'),
                     '&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;');
  assert.strictEqual(coach.esc(null), '');
});

test('bridge : le prix se lit dans le titre, virgule ou point', () => {
  assert.strictEqual(bridge.priceFromTitle('AAPL 234,56 ▲ +1,20 %'), 234.56);
  assert.strictEqual(bridge.priceFromTitle('AAPL 234.56 ▲ +1.20%'), 234.56);
  assert.strictEqual(bridge.priceFromTitle('BTCUSD 78 760,10 ▼ -0,4 %'), 78760.10);
  assert.strictEqual(bridge.priceFromTitle('BTCUSD 78,760.10 ▲ +0.4%'), 78760.10);
  assert.strictEqual(bridge.priceFromTitle('UKOIL 66,20 ▲ +0,50 % — TradingView'), 66.2);
  assert.strictEqual(bridge.priceFromTitle('TradingView'), null);
  assert.strictEqual(bridge.priceFromTitle(''), null);
});

test('bridge : parsePrice tranche les séparateurs ambigus', () => {
  assert.strictEqual(bridge.parsePrice('1 234,50'), 1234.5);
  assert.strictEqual(bridge.parsePrice('1,234.50'), 1234.5);
  assert.strictEqual(bridge.parsePrice('1.234,50'), 1234.5);
  assert.strictEqual(bridge.parsePrice('0,00123'), 0.00123);
  assert.strictEqual(bridge.parsePrice('1,234'), 1234);
  assert.strictEqual(bridge.parsePrice('abc'), null);
  assert.strictEqual(bridge.parsePrice(null), null);
});

test('bridge : les sélecteurs bid/ask vivent dans une seule constante', () => {
  assert.ok(Array.isArray(bridge.BID_ASK_SELECTORS.sell));
  assert.ok(Array.isArray(bridge.BID_ASK_SELECTORS.buy));
  assert.ok(bridge.BID_ASK_SELECTORS.sell.length >= 2);
});

test('formats d’affichage', () => {
  assert.strictEqual(coach.fmtPrice(null), '—');
  assert.strictEqual(coach.fmtPrice(78760.123), '78760.12');
  assert.strictEqual(coach.fmtPrice(0.00012345), '0.000123');
  assert.strictEqual(coach.fmtPct(1.234), '1.23 %');
  assert.strictEqual(coach.fmtTime(null), '');
  /* Heure rendue dans le fuseau de l'écran (attendu calculé ici même, pour
     que le test ne dépende pas du fuseau de la machine). */
  const moment = new Date('2026-09-10T12:30:00Z');
  const expected = String(moment.getHours()).padStart(2, '0') + ':'
    + String(moment.getMinutes()).padStart(2, '0');
  assert.strictEqual(coach.fmtTime('2026-09-10T12:30:00Z'), expected);
  /* Une heure nue (calendar.time_utc) reste telle quelle. */
  assert.strictEqual(coach.fmtTime('12:30'), '12:30');
});

test('l’état des garde-fous se construit même sans fiche ni modules scalp', () => {
  /* Ce test doit rester AVANT le chargement des modules du lot ext-scalp. */
  const guardState = coach.guardState();
  assert.deepStrictEqual(Object.keys(guardState).sort(), [
    'atr1', 'atr1_median', 'calendar', 'equity_chf', 'fee_round_trip_pct',
    'is_perp', 'last_news_ms', 'next_funding_ms', 'now_ms', 'price',
    'scalps_today', 'spread', 'spread_median'
  ]);
  assert.strictEqual(guardState.atr1, null, 'lib/bars.js absent : ATR à null');
  assert.ok(Array.isArray(guardState.calendar));
});

test('bridge : le symbole d’une rangée de watchlist, du qualifié au texte', () => {
  const row = (attributes, text) => ({
    getAttribute: (name) => (Object.prototype.hasOwnProperty.call(attributes, name)
      ? attributes[name] : null),
    textContent: text === undefined ? '' : text
  });
  assert.strictEqual(
    bridge.symbolFromRow(row({ 'data-symbol-full': 'NASDAQ:AAPL',
                               'data-symbol-short': 'AAPL' })), 'NASDAQ:AAPL');
  assert.strictEqual(bridge.symbolFromRow(row({ 'data-symbol-short': 'AAPL' })), 'AAPL');
  /* Dernier recours : le premier mot du texte, et seulement s'il ressemble à
     un symbole. Le texte RÉEL d'une rangée (relevé sur la page le 09/09) est
     du charabia collé — il doit être écarté, pas importé. */
  assert.strictEqual(bridge.symbolFromRow(row({}, 'NESN  78.20  +1,2 %')), 'NESN');
  assert.strictEqual(bridge.symbolFromRow(row({}, 'SP:SPX 7,636.36')), 'SP:SPX');
  assert.strictEqual(bridge.symbolFromRow(row({}, '   ')), '');
  assert.strictEqual(bridge.symbolFromRow(row({}, '78.20')), '',
                     'un prix n’est pas un symbole');
  assert.strictEqual(
    bridge.symbolFromRow(row({}, 'SSPXDMarket closed7,636.36−37.16−0.48%')), '',
    'le texte collé d’une rangée réelle ne doit rien produire');
  assert.strictEqual(bridge.symbolFromRow(null), '');
  /* Un getAttribute qui lève ne casse pas la lecture. */
  assert.strictEqual(bridge.symbolFromRow({
    getAttribute: () => { throw new Error('nœud mort'); }, textContent: 'TSLA'
  }), 'TSLA');
});

test('bridge : pane et watchlist ont chacun leur constante de sélecteurs', () => {
  assert.ok(Array.isArray(bridge.PANE_SELECTORS));
  assert.ok(bridge.PANE_SELECTORS.length >= 3);
  assert.ok(Array.isArray(bridge.WATCHLIST_SELECTORS));
  assert.ok(bridge.WATCHLIST_SELECTORS.length >= 3);
  /* Aucun sélecteur de watchlist ne ratisse tout le document : un
     ``[data-symbol-full]`` nu importerait les pastilles du graphique. */
  for (const selector of bridge.WATCHLIST_SELECTORS) {
    assert.ok(selector.indexOf(' ') !== -1,
              'sélecteur trop large : ' + selector);
  }
  assert.strictEqual(typeof bridge.WATCHLIST_MAX_ROWS, 'number');
});

test('Alt+clic sans lib/price_axis.js : le prix live sert de repli', () => {
  /* Ce test doit rester AVANT le chargement de lib/price_axis.js. */
  sendFromBridge({ type: 'tv:alt_click', y: 300, top: 100, height: 400,
                   range_from: 78000, range_to: 80000, last_price: 78500 });
  assert.ok(coach.state.alert_draft, 'aucun brouillon d’alerte');
  assert.strictEqual(coach.state.alert_draft.price, 78500,
                     'sans le module d’échelle, on retombe sur le prix connu');
  assert.strictEqual(coach.state.alert_draft.op, 'above');
  coach.state.alert_draft = null;
});

/* --------------------------------------------------------------------- *
 * Avec les modules du lot ext-scalp : cycle complet d'un scalp.
 * Ces ``require`` arrivent VOLONTAIREMENT après les tests ci-dessus, qui
 * vérifient la tenue du panneau SANS eux.
 * --------------------------------------------------------------------- */

test('mode scalp de bout en bout : barres, garde-fous, ledger, file locale',
     async () => {
  require('../lib/bars.js');
  const guards = require('../lib/guards.js');
  require('../lib/ledger.js');

  coach.state.settings.fee_profile = 'kraken_spot';

  sendFromBridge({ type: 'tv:symbol', tv_symbol: 'BINANCE:BTCUSDT.P',
                   resolution: '1', drawing_allowed: true });
  await settled();
  assert.strictEqual(coach.state.mode, 'scalp');

  /* La fiche est posée APRÈS le changement de titre : ``onSymbol`` vide le
     cache du titre précédent, c'est justement ce qu'on veut vérifier. */
  assert.strictEqual(coach.state.brief, null, 'la fiche du titre précédent a survécu');
  coach.state.brief = {
    news: [], calendar: [], ideas: [], hypotheses: [], alerts: [],
    fees: { profile: 'kraken_spot', round_trip_pct: 0.52 },
    defaults: { risk_pct: 1, equity_chf: 9796 },
    ta: { atr14_d: 900, vwap: 100, day_high: 102, day_low: 98 }
  };

  const start = Date.now();
  for (let i = 0; i < 5; i += 1) {
    sendFromBridge({ type: 'tv:tick', price: 100 + i, bid: 99.9 + i,
                     ask: 100.1 + i, ts: start + (i * 1000) });
  }
  const scalpState = coach.guardState();
  assert.strictEqual(typeof scalpState.spread, 'number', 'l’écart n’est pas nourri');
  assert.strictEqual(scalpState.is_perp, true);
  assert.strictEqual(scalpState.fee_round_trip_pct, 0.52);
  /* Les garde-fous tournent et ne lèvent jamais, même à moitié nourris. */
  assert.ok(Array.isArray(guards.evaluate(scalpState)));
  coach.refreshGuards();
  assert.ok(Array.isArray(coach.state.scalp.guards));

  /* Ouverture puis fermeture : l'Omen est injoignable ici, le scalp doit
     finir dans la file locale — jamais perdu. */
  coach.state.ticket = coach.state.ticket || {};
  coach.state.ticket.qty = 2;
  coach.openScalp('buy');
  assert.strictEqual(coach.state.scalp.open, true);
  assert.ok(coach.state.scalp.handle, 'le ledger n’a pas rendu de scalp');

  sendFromBridge({ type: 'tv:tick', price: 106, bid: 105.9, ask: 106.1,
                   ts: start + 6000 });
  coach.closeScalp();
  await settled();
  assert.strictEqual(coach.state.scalp.open, false);
  assert.ok(coach.state.scalp.result, 'aucun résultat de scalp');
  assert.ok(coach.state.scalp.result.pnl_net > 0, 'P&L attendu positif');
  assert.strictEqual(coach.state.scalp.queued, 1, 'le scalp n’est pas en file');
});

/* --------------------------------------------------------------------- *
 * Lot ext-F : Alt+clic, watchlist, note rapide, bilan automatique.
 * Les modules du lot sont chargés ICI : les tests plus haut prouvent que le
 * panneau tient debout SANS eux.
 * --------------------------------------------------------------------- */

test('Alt+clic : l’ordonnée devient un prix et la condition se choisit seule',
     () => {
  require('../lib/price_axis.js');
  require('../lib/watchlist.js');
  require('../lib/note.js');
  require('../lib/idle.js');

  /* Le dernier tick du test de scalp a posé le prix à 106. */
  assert.strictEqual(coach.state.price, 106);

  /* Pane de 400 px à 100 px du haut, plage 100 -> 110 : y = 300 est au
     milieu, donc 105 — soit SOUS le cours : « en dessous ». */
  sendFromBridge({ type: 'tv:alt_click', y: 300, top: 100, height: 400,
                   range_from: 100, range_to: 110, last_price: 106 });
  assert.ok(coach.state.alert_draft, 'aucun brouillon d’alerte');
  assert.strictEqual(coach.state.alert_draft.price, 105);
  assert.strictEqual(coach.state.alert_draft.op, 'below');

  /* Au-dessus du cours, la condition bascule. */
  sendFromBridge({ type: 'tv:alt_click', y: 140, top: 100, height: 400,
                   range_from: 100, range_to: 110, last_price: 106 });
  assert.strictEqual(coach.state.alert_draft.price, 109);
  assert.strictEqual(coach.state.alert_draft.op, 'above');
});

test('le brouillon d’alerte s’affiche avec ses deux conditions', () => {
  coach.render();
  const html = shadow().innerHTML;
  assert.ok(html.indexOf('data-omen-act="alert-create"') !== -1, 'bouton Créer absent');
  assert.ok(html.indexOf('data-omen-act="alert-above"') !== -1, 'bouton Au-dessus absent');
  assert.ok(html.indexOf('data-omen-act="alert-below"') !== -1, 'bouton En dessous absent');
  assert.ok(html.indexOf('data-omen-field="alert_price"') !== -1, 'prix non éditable');
  assert.ok(html.indexOf('Nouvelle alerte') !== -1);
});

test('alerte sur un titre non suivi : refusée en local, sans appel', async () => {
  coach.state.symbol = null;
  coach.createAlert();
  await settled();
  assert.strictEqual(coach.state.alert_draft.status,
                     'Titre non suivi : alerte impossible.');
  coach.state.symbol = 'BTC-USD';
  coach.state.alert_draft = null;
  coach.render();
});

test('un changement de titre jette le brouillon d’alerte', async () => {
  sendFromBridge({ type: 'tv:alt_click', y: 300, top: 100, height: 400,
                   range_from: 100, range_to: 110, last_price: 106 });
  assert.ok(coach.state.alert_draft);
  sendFromBridge({ type: 'tv:symbol', tv_symbol: 'NASDAQ:AAPL', resolution: '1' });
  await settled();
  assert.strictEqual(coach.state.alert_draft, null);
});

test('la section Watchlist et son bouton d’import sont rendus', () => {
  const html = shadow().innerHTML;
  assert.ok(html.indexOf('data-omen-act="watchlist-import"') !== -1,
            'bouton d’import absent');
  assert.ok(html.indexOf('Importer la watchlist') !== -1);
});

test('l’import interroge le pont, et une watchlist absente rend la main',
     async () => {
  const before = posted.length;
  coach.importWatchlist();
  assert.strictEqual(coach.state.watchlist.busy, true);
  const asked = posted.slice(before).some((m) => m.type === 'tv:watchlist_request');
  assert.ok(asked, 'le pont n’a pas été interrogé');

  sendFromBridge({ type: 'tv:watchlist', symbols: [], error: 'not_found' });
  await settled();
  assert.strictEqual(coach.state.watchlist.busy, false);
  assert.strictEqual(coach.state.watchlist.status,
                     'Watchlist TradingView introuvable sur cette page.');
});

test('watchlist lue mais Omen injoignable : import interrompu, jamais bloqué',
     async () => {
  coach.importWatchlist();
  sendFromBridge({ type: 'tv:watchlist',
                   symbols: ['NASDAQ:AAPL', 'SIX:NESN', 'WTF:XYZ'] });
  await settled();
  await settled();
  assert.strictEqual(coach.state.watchlist.busy, false);
  assert.strictEqual(coach.state.watchlist.status.indexOf('Import interrompu'), 0,
                     'statut inattendu : ' + coach.state.watchlist.status);
});

test('le récapitulatif compte importés, ignorés et inconnus', () => {
  const plan = { post: ['AAPL', 'NESN.SW'], skipped: ['TSLA'], unknown: ['WTF:XYZ'],
                 capped: true, cap: 30, seen: 4 };
  const recap = coach.watchlistRecap(plan, 2, plan.unknown, '');
  assert.strictEqual(recap.indexOf('2 importés, 1 ignorés, 1 inconnus.'), 0, recap);
  assert.ok(recap.indexOf('Import limité à 30 titres.') !== -1, recap);
  assert.ok(recap.indexOf('Inconnus : WTF:XYZ') !== -1, recap);
});

test('la note rapide s’affiche, garde son texte et refuse le vide', async () => {
  const html = shadow().innerHTML;
  assert.ok(html.indexOf('data-omen-field="note"') !== -1, 'champ de note absent');
  assert.ok(html.indexOf('data-omen-act="note-send"') !== -1, 'bouton Noter absent');
  assert.ok(html.indexOf('maxlength="500"') !== -1, 'longueur non bornée');

  /* Une note vide n'appelle rien : le statut reste tel quel. */
  coach.state.note.text = '   ';
  coach.sendNote();
  await settled();
  assert.strictEqual(coach.state.note.status, '');

  /* Le texte survit à un repeint (toast qui expire, garde-fou qui change). */
  coach.state.note.text = 'cassure du VWAP';
  coach.render();
  assert.ok(shadow().innerHTML.indexOf('cassure du VWAP') !== -1,
            'la note a été effacée par le rendu');
});

test('Ctrl+Entrée envoie la note ; Omen injoignable -> le texte est GARDÉ',
     async () => {
  const textarea = {
    getAttribute: (name) => (name === 'data-omen-field' ? 'note' : null),
    value: 'range serré sous le VWAP'
  };
  let prevented = false;
  const handlers = shadow().listeners.keydown || [];
  assert.strictEqual(handlers.length, 1, 'aucun écouteur de touche');
  handlers[0]({ target: textarea, key: 'Enter', ctrlKey: true,
                preventDefault: () => { prevented = true; } });
  assert.strictEqual(prevented, true, 'Ctrl+Entrée doit couper le saut de ligne');
  await settled();
  assert.strictEqual(coach.state.note.status.indexOf('Note refusée'), 0,
                     'statut inattendu : ' + coach.state.note.status);
  assert.strictEqual(coach.state.note.text, 'range serré sous le VWAP',
                     'une note non partie ne doit pas être perdue');
  coach.state.note.text = '';
  coach.state.note.status = '';
});

test('le minuteur du bilan automatique ne part pas sans attendre', () => {
  coach.state.scalp.open = false;
  coach.touchIdle();
  coach.checkIdleReview();
  assert.notStrictEqual(coach.state.advice.status, 'pending',
                        'un scalp qui vient de fermer ne déclenche pas de bilan');
});

/* --------------------------------------------------------------------- *
 * Fermeture automatique des pubs : le balayage tourne VRAIMENT sur un DOM
 * bouchon (un parse ne prouve rien, piège #64). Le toast pub et le pop-up
 * « sans pub » sont fermés ; l'alerte, le conteneur des toasts, le portail
 * « Acheter au prix du marché » et un pop-up trop petit ne sont jamais touchés.
 * --------------------------------------------------------------------- */

test('adSweep ferme le toast pub et le pop-up « sans pub », et rien d’autre', () => {
  require('../lib/ads.js');

  const clicks = [];
  const fakeButton = (spec) => ({
    getAttribute: (name) => (Object.prototype.hasOwnProperty.call(spec, name) ? spec[name] : null),
    textContent: spec.text || '',
    click: () => { clicks.push(spec.text || spec['data-name'] || ''); }
  });
  const fakeBox = (spec, buttons) => ({
    getAttribute: (name) => (Object.prototype.hasOwnProperty.call(spec, name) ? spec[name] : null),
    textContent: spec.text || '',
    children: [],
    getBoundingClientRect: () => ({ width: spec.width || 0, height: spec.height || 0 }),
    querySelectorAll: (selector) => (selector.indexOf('button') === 0 ? buttons : []),
    querySelector: () => null
  });

  /* Le toast réel : ``#charting-ad`` ET le slot Google dans le MÊME ``li``,
     bouton « Fermer la publicité » frère (texte caché, ni aria-label ni
     data-name) à côté d'une incitation d'achat. */
  const toast = fakeBox({}, [fakeButton({ text: 'Essayer' }),
                             fakeButton({ text: 'Fermer la publicité' })]);
  const adNode = { closest: (selector) => (selector === 'li' ? toast : null) };
  const gptNode = { closest: (selector) => (selector === 'li' ? toast : null) };

  const toastsContainer = fakeBox({ 'data-id': 'chart-toasts-container', role: 'dialog',
                                    width: 600, height: 400, text: 'sans pub' },
                                  [fakeButton({ text: 'Fermer' })]);
  const gopro = fakeBox({ 'data-dialog-name': 'gopro-dialog', role: 'dialog',
                          width: 420, height: 300,
                          text: 'Débloque des fonctionnalités avancées' },
                        [fakeButton({ text: 'Essayer gratuitement' }),
                         fakeButton({ 'data-name': 'close', 'aria-label': 'Fermer' })]);
  const alertDialog = fakeBox({ 'data-dialog-name': 'alert-dialog', role: 'dialog',
                                width: 420, height: 300, text: 'Alerte sur BTCUSD' },
                              [fakeButton({ text: 'Fermer' })]);
  const marketPortal = fakeBox({ width: 160, height: 30,
                                 text: 'Acheter au prix du marché Shift B' },
                               [fakeButton({ text: 'Fermer' })]);
  const tinyUpsell = fakeBox({ role: 'dialog', width: 200, height: 100, text: 'sans pub' },
                             [fakeButton({ text: 'Non merci' })]);
  /* Le paywall (spec 2026-09-11) : NI role NI data-dialog-name — c'est
     justement ce qui l'a fait échapper à l'ancienne détection. Un seul
     bouton, une incitation d'achat : aucun bouton fermable, le repli Échap
     doit prendre le relais SANS jamais cliquer. */
  const paywall = fakeBox({ width: 500, height: 400,
                            text: 'Débarrassez-vous des publicités' },
                          [fakeButton({ text: 'Essayer gratuitement' })]);
  /* Un menu/tooltip QUELCONQUE, sans role ni data-dialog-name lui non plus,
     trop petit (200×40 < 240×120) : doit rester écarté par la seule taille,
     maintenant que le rôle n'est plus exigé pour les enfants d'overlap. */
  const tinyMenu = fakeBox({ width: 200, height: 40, text: 'Paramètres rapides' },
                           [fakeButton({ text: 'OK' })]);
  const overlap = { children: [toastsContainer, gopro, alertDialog, marketPortal, tinyUpsell,
                               paywall, tinyMenu] };

  const savedQuerySelectorAll = documentStub.querySelectorAll;
  documentStub.querySelectorAll = (selector) => (selector.indexOf('#charting-ad') === 0
    ? [adNode, gptNode] : []);
  documentStub.getElementById = (id) => (id === 'overlap-manager-root' ? overlap : null);

  /* Le repli Échap dispatche sur document.activeElement || document.body :
     ce bouchon n'a pas d'activeElement, donc document.body. dispatchEvent
     n'existe pas nativement sur le bouchon — on le simule ICI, localement,
     comme le SEUL saut de bulle qui compte pour ce test (body -> document). */
  const escapes = [];
  const onKeydown = (e) => { if (e.key === 'Escape') { escapes.push(e); } };
  document.addEventListener('keydown', onKeydown);
  const savedBodyDispatch = documentStub.body.dispatchEvent;
  documentStub.body.dispatchEvent = function (evt) {
    const list = documentListeners[evt.type] || [];
    for (const fn of list) { fn(evt); }
    return true;
  };

  try {
    coach.state.ads_closed = 0;
    coach.state.settings.ads_auto_close = true;
    coach.adSweep();
    assert.deepStrictEqual(clicks, ['Fermer la publicité', 'close']);
    assert.strictEqual(coach.state.ads_closed, 2);
    assert.ok(shadow().innerHTML.indexOf('Pubs fermées : 2') !== -1,
              'la ligne « Pubs fermées » manque en pied de panneau');
    assert.strictEqual(escapes.length, 1,
                       'le repli Échap n’a pas été dispatché sur le paywall sans bouton');

    /* Même DOM au tour suivant : aucun reclic, le compteur ne bouge pas. */
    coach.adSweep();
    assert.deepStrictEqual(clicks, ['Fermer la publicité', 'close']);
    assert.strictEqual(coach.state.ads_closed, 2);

    /* Option décochée : le balayage ne lit même plus la page. */
    coach.state.settings.ads_auto_close = false;
    documentStub.querySelectorAll = () => { throw new Error('lecture interdite'); };
    coach.adSweep();
    assert.strictEqual(coach.state.ads_closed, 2);
  } finally {
    documentStub.querySelectorAll = savedQuerySelectorAll;
    delete documentStub.getElementById;
    /* documentStub n'a pas de removeEventListener : on retire la fonction
       de la liste que addEventListener a réellement remplie. */
    const idx = (documentListeners.keydown || []).indexOf(onKeydown);
    if (idx !== -1) { documentListeners.keydown.splice(idx, 1); }
    documentStub.body.dispatchEvent = savedBodyDispatch;
    coach.state.settings.ads_auto_close = true;
    coach.state.ads_closed = 0;
    coach.render();
  }
});

/* --------------------------------------------------------------------- *
 * Le VRAI paywall gopro capturé à l'écran chez Massii (11/09) : un
 * PORTAIL 0×0 en enfant direct d'#overlap-manager-root, le dialogue
 * (data-dialog-name="gopro", 1440×782) plusieurs niveaux plus bas, des
 * boutons de carrousel (Pause + deux flèches, texte vide) à côté du vrai
 * bouton de fermeture (aria-label « Fermeture », data-qa-id contenant
 * « close »). L'ancienne détection mesurait le portail lui-même (0×0) et
 * écartait tout le dialogue.
 * --------------------------------------------------------------------- */

test('adSweep ferme le VRAI paywall gopro (portail 0×0 -> dialogue data-dialog-name="gopro")',
     () => {
  const clicks = [];
  const fakeButton = (spec) => ({
    getAttribute: (name) => (Object.prototype.hasOwnProperty.call(spec, name) ? spec[name] : null),
    textContent: spec.text || '',
    click: () => { clicks.push(spec['data-qa-id'] || spec['aria-label'] || spec.text || ''); }
  });

  const closeBtn = fakeButton({ 'aria-label': 'Fermeture',
                                'data-qa-id': 'promo-dialog-close-button', text: '' });
  const pauseBtn = fakeButton({ 'aria-label': 'Pause', text: '' });
  const leftBtn = fakeButton({ text: '' });
  const rightBtn = fakeButton({ text: '' });
  const upgradeBtn = fakeButton({ 'data-qa-id': 'upgrade_paywall_button',
                                  'data-offer-kind': 'trial',
                                  text: 'Upgradez pour un accès sans publicité' });
  const buttons = [closeBtn, pauseBtn, leftBtn, rightBtn, upgradeBtn];

  const paywallText = 'Sans publicité. Nulle part. Les annonces sont importantes, mais avec '
    + 'nos plans upgradés vous ne les verrez plus.';

  /* Le dialogue lui-même : marqué data-dialog-name, 1440×782 (voile +
     dialogue plein écran). C'est LUI que la garde de taille doit mesurer —
     jamais le portail 0×0 qui le contient. */
  const dialogDiv = {
    getAttribute: (name) => (name === 'data-dialog-name' ? 'gopro' : null),
    children: [],
    getBoundingClientRect: () => ({ width: 1440, height: 782 }),
    textContent: paywallText,
    querySelectorAll: () => [],
    querySelector: () => null
  };
  const portal = {
    getAttribute: (name) => (name === 'data-id' ? '5HZcv8THU4Yu7B_5K8y6X' : null),
    children: [dialogDiv],
    getBoundingClientRect: () => ({ width: 0, height: 0 }),   /* le portail : 0×0 */
    textContent: paywallText,
    querySelectorAll: (selector) => {
      if (selector.indexOf('button') === 0) { return buttons; }
      if (selector.indexOf('[data-dialog-name]') === 0) { return [dialogDiv, closeBtn, upgradeBtn]; }
      return [];
    },
    querySelector: (selector) => (selector.indexOf('[data-focus-trap]') === 0 ? dialogDiv : null)
  };

  const overlap = { children: [portal] };
  documentStub.getElementById = (id) => (id === 'overlap-manager-root' ? overlap : null);
  const savedQuerySelectorAll = documentStub.querySelectorAll;
  documentStub.querySelectorAll = () => [];

  try {
    coach.state.ads_closed = 0;
    coach.state.settings.ads_auto_close = true;
    coach.adSweep();
    assert.deepStrictEqual(clicks, ['promo-dialog-close-button'],
                           'seul le bouton de fermeture doit être cliqué (jamais Pause/carrousel/Upgradez)');
    assert.strictEqual(coach.state.ads_closed, 1);
    assert.ok(shadow().innerHTML.indexOf('Pubs fermées : 1') !== -1,
              'la ligne « Pubs fermées » manque en pied de panneau');
  } finally {
    delete documentStub.getElementById;
    documentStub.querySelectorAll = savedQuerySelectorAll;
    coach.state.settings.ads_auto_close = true;
    coach.state.ads_closed = 0;
    coach.render();
  }
});

test('adSweep ferme un paywall SANS data-dialog-name (repli sur le plus grand descendant + texte)',
     () => {
  const clicks = [];
  const fakeButton = (spec) => ({
    getAttribute: (name) => (Object.prototype.hasOwnProperty.call(spec, name) ? spec[name] : null),
    textContent: spec.text || '',
    click: () => { clicks.push(spec['data-qa-id'] || spec['aria-label'] || spec.text || ''); }
  });
  const closeBtn = fakeButton({ 'aria-label': 'Fermeture',
                                'data-qa-id': 'promo-dialog-close-button', text: '' });

  /* Aucun marqueur nulle part (ni data-dialog-name, ni role, ni aria-modal,
     ni data-focus-trap) : seuls la TAILLE (plus grand descendant des 3
     premiers niveaux) et le TEXTE (« Sans publicité ») permettent de le
     reconnaître comme dialogue pub. */
  const panel = {
    getAttribute: () => null, children: [],
    getBoundingClientRect: () => ({ width: 1440, height: 782 }),
    textContent: 'Sans publicité'
  };
  const wrapper = {
    getAttribute: () => null, children: [panel],
    getBoundingClientRect: () => ({ width: 0, height: 0 }),
    textContent: 'Sans publicité'
  };
  const portal = {
    getAttribute: () => null,
    children: [wrapper],
    getBoundingClientRect: () => ({ width: 0, height: 0 }),
    textContent: 'Sans publicité',
    querySelectorAll: (selector) => (selector.indexOf('button') === 0 ? [closeBtn] : []),
    querySelector: () => null
  };

  const overlap = { children: [portal] };
  documentStub.getElementById = (id) => (id === 'overlap-manager-root' ? overlap : null);
  const savedQuerySelectorAll = documentStub.querySelectorAll;
  documentStub.querySelectorAll = () => [];

  try {
    coach.state.ads_closed = 0;
    coach.state.settings.ads_auto_close = true;
    coach.adSweep();
    assert.deepStrictEqual(clicks, ['promo-dialog-close-button']);
    assert.strictEqual(coach.state.ads_closed, 1);
  } finally {
    delete documentStub.getElementById;
    documentStub.querySelectorAll = savedQuerySelectorAll;
    coach.state.settings.ads_auto_close = true;
    coach.state.ads_closed = 0;
    coach.render();
  }
});

test('dialogue pub sans bouton élu : Échap une fois, un second essai après 2 s, jamais un troisième',
     () => {
  const fakeButton = (spec) => ({
    getAttribute: (name) => (Object.prototype.hasOwnProperty.call(spec, name) ? spec[name] : null),
    textContent: spec.text || '',
    click: () => { throw new Error('ce bouton d’achat ne doit jamais être cliqué'); }
  });
  const fakeBox = (spec, buttons) => ({
    getAttribute: (name) => (Object.prototype.hasOwnProperty.call(spec, name) ? spec[name] : null),
    textContent: spec.text || '',
    children: [],
    getBoundingClientRect: () => ({ width: spec.width || 0, height: spec.height || 0 }),
    querySelectorAll: (selector) => (selector.indexOf('button') === 0 ? buttons : []),
    querySelector: () => null
  });

  const paywall = fakeBox({ width: 500, height: 400, text: 'sans publicité' },
                          [fakeButton({ text: 'Essayer' })]);
  const overlap = { children: [paywall] };

  const escapes = [];
  const onKeydown = (e) => { if (e.key === 'Escape') { escapes.push(Date.now()); } };
  document.addEventListener('keydown', onKeydown);
  const savedBodyDispatch = documentStub.body.dispatchEvent;
  documentStub.body.dispatchEvent = function (evt) {
    const list = documentListeners[evt.type] || [];
    for (const fn of list) { fn(evt); }
    return true;
  };
  const savedQuerySelectorAll = documentStub.querySelectorAll;
  documentStub.querySelectorAll = (selector) => (selector.indexOf('#charting-ad') === 0
    ? [] : []);
  documentStub.getElementById = (id) => (id === 'overlap-manager-root' ? overlap : null);

  const realNow = Date.now;
  let fakeNow = realNow();
  Date.now = () => fakeNow;

  try {
    coach.state.settings.ads_auto_close = true;

    coach.adSweep();
    assert.strictEqual(escapes.length, 1, 'le premier essai n’a pas eu lieu');

    /* Moins de 2 s plus tard : pas de second essai. */
    fakeNow += 500;
    coach.adSweep();
    assert.strictEqual(escapes.length, 1, 'un second essai est parti trop tôt (< 2 s)');

    /* 2 s (et plus) après le PREMIER essai : le second part. */
    fakeNow += 2000;
    coach.adSweep();
    assert.strictEqual(escapes.length, 2, 'le second essai (2 s plus tard) n’a pas eu lieu');

    /* Encore plus tard, plusieurs tours : jamais un TROISIÈME essai. */
    fakeNow += 10000;
    coach.adSweep();
    coach.adSweep();
    assert.strictEqual(escapes.length, 2, 'un troisième essai a été dispatché');
  } finally {
    Date.now = realNow;
    documentStub.querySelectorAll = savedQuerySelectorAll;
    delete documentStub.getElementById;
    const idx = (documentListeners.keydown || []).indexOf(onKeydown);
    if (idx !== -1) { documentListeners.keydown.splice(idx, 1); }
    documentStub.body.dispatchEvent = savedBodyDispatch;
    coach.state.settings.ads_auto_close = true;
    coach.render();
  }
});

test('un [data-focus-trap] mounté n’importe où dans body est remonté à son conteneur ; dédoublonné ; jamais dans notre propre panneau',
     () => {
  const fakeButton = (spec) => ({
    getAttribute: (name) => (Object.prototype.hasOwnProperty.call(spec, name) ? spec[name] : null),
    textContent: spec.text || '',
    click: () => { throw new Error('jamais cliqué dans ce test (bouton d’achat seul)'); }
  });

  /* Le focus-trap est profondément niché dans un wrapper anonyme, mounté
     DIRECTEMENT DANS BODY — PAS sous overlap-manager-root (celui-ci reste
     VIDE : ce test ne prouve rien si le chemin (a) pouvait, à lui seul,
     trouver ce dialogue). Deux focus-trap SIBLINGS sous le même wrapper
     remontent au MÊME conteneur : un seul dialogue doit en sortir
     (dédoublonnage à l'intérieur même du chemin (b)). */
  const buyBtn = fakeButton({ text: 'Essayer 30 jours' });
  const focusTrap = {
    getAttribute: (name) => (name === 'data-focus-trap' ? 'true' : null),
    parentNode: null, children: [],
    querySelectorAll: () => [], querySelector: () => null, textContent: ''
  };
  const focusTrap2 = {
    getAttribute: (name) => (name === 'data-focus-trap' ? 'true' : null),
    parentNode: null, children: [],
    querySelectorAll: () => [], querySelector: () => null, textContent: ''
  };
  const wrapperMid = {
    getAttribute: () => null, parentNode: null, children: [focusTrap, focusTrap2],
    querySelectorAll: () => [], querySelector: () => null, textContent: ''
  };
  const dialogRoot = {
    getAttribute: (name) => (name === 'data-qa-id' ? 'paywall-root' : null),
    parentNode: null, children: [wrapperMid],
    textContent: 'Passez à un plan sans publicité',
    getBoundingClientRect: () => ({ width: 500, height: 400 }),
    querySelectorAll: (selector) => (selector.indexOf('button') === 0 ? [buyBtn] : []),
    querySelector: () => null
  };
  focusTrap.parentNode = wrapperMid;
  focusTrap2.parentNode = wrapperMid;
  wrapperMid.parentNode = dialogRoot;
  dialogRoot.parentNode = documentStub.body;   /* PAS overlap : body seulement */

  const overlap = { children: [] };   /* rien côté (a) : la preuve vient du (b) seul */

  /* Second focus-trap, celui-ci À L'INTÉRIEUR de notre propre panneau
     (#omen-coach) : jamais un candidat, quoi qu'il porte. ``ownPanelHost``
     (ce que topLevelContainer résout, remonté jusqu'à body) porte volontairement
     une taille ET un texte pub — s'il devenait un candidat malgré tout, il
     produirait un DEUXIÈME Échap et ferait échouer l'assertion ci-dessous ;
     ça prouve que c'est bien ``isInsideOwnPanel`` qui l'arrête, pas un autre
     garde-fou (taille, contenu) qui l'aurait de toute façon écarté. */
  const ownPanelHost = {
    getAttribute: (name) => (name === 'id' ? 'omen-coach' : null),
    parentNode: documentStub.body, children: [],
    textContent: 'sans pub', getBoundingClientRect: () => ({ width: 500, height: 400 }),
    querySelectorAll: () => [], querySelector: () => null
  };
  const insideOwnPanel = {
    getAttribute: (name) => (name === 'data-focus-trap' ? 'true' : null),
    parentNode: ownPanelHost, children: [],
    querySelectorAll: () => [], querySelector: () => null, textContent: ''
  };

  const escapes = [];
  const onKeydown = (e) => { if (e.key === 'Escape') { escapes.push(e); } };
  document.addEventListener('keydown', onKeydown);
  const savedBodyDispatch = documentStub.body.dispatchEvent;
  documentStub.body.dispatchEvent = function (evt) {
    const list = documentListeners[evt.type] || [];
    for (const fn of list) { fn(evt); }
    return true;
  };
  documentStub.getElementById = (id) => (id === 'overlap-manager-root' ? overlap : null);
  documentStub.querySelectorAll = (selector) => (selector.indexOf('[data-focus-trap]') === 0
    ? [focusTrap, focusTrap2, insideOwnPanel] : []);

  try {
    /* Preuve DIRECTE du dédoublonnage, sur le snapshot lui-même : passer
       par adSweep()/l'action Échap ne le prouverait pas seul, puisque
       maybeEscape() dédoublonne AUSSI par nœud (deux entrées du MÊME nœud
       ne produiraient qu'un Échap de toute façon, même sans dédoublonnage
       dans snapshotDialogs). */
    const dialogs = coach.snapshotDialogs(new Map());
    assert.strictEqual(dialogs.length, 1,
                       'les deux focus-trap remontant au même conteneur ont produit ' +
                       dialogs.length + ' dialogue(s) au lieu d’un seul (dédoublonnage)');

    coach.state.settings.ads_auto_close = true;
    coach.adSweep();
    /* UNE seule action Échap : les deux focus-trap remontent au MÊME
       dialogRoot (dédoublonné dans le chemin (b) lui-même) — jamais deux,
       et jamais celui niché dans #omen-coach. */
    assert.strictEqual(escapes.length, 1,
                       'attendu exactement 1 Échap (dédoublonné, panneau exclu)');
  } finally {
    delete documentStub.getElementById;
    documentStub.querySelectorAll = () => [];
    const idx = (documentListeners.keydown || []).indexOf(onKeydown);
    if (idx !== -1) { documentListeners.keydown.splice(idx, 1); }
    documentStub.body.dispatchEvent = savedBodyDispatch;
    coach.state.settings.ads_auto_close = true;
    coach.render();
  }
});

/* --------------------------------------------------------------------- *
 * Taille automatique d'un scalp (lib/sizing).
 *
 * Ces tests viennent EN DERNIER : le premier a besoin que ``lib/sizing.js`` ne
 * soit pas encore chargé, pour prouver qu'un module absent REFUSE le scalp au
 * lieu de retomber sur l'ancien défaut « 1 » (un bitcoin, le 11/09).
 * --------------------------------------------------------------------- */

/** Remet le panneau dans l'état du 11/09 : BTC-USD à 77 216, 10 000 CHF. */
function scalpSetup() {
  coach.state.mode = 'scalp';
  coach.state.tv_symbol = 'BINANCE:BTCUSDT.P';
  coach.state.symbol = 'BTC-USD';
  coach.state.kind = 'crypto';
  coach.state.settings.fee_profile = 'kraken_spot';
  coach.state.settings.risk_pct = 1;
  coach.state.ticket = null;
  coach.state.scalp.open = false;
  coach.state.scalp.handle = null;
  coach.state.scalp.result = null;
  coach.state.price = 77216;
  coach.state.toasts = [];
  coach.state.brief = {
    news: [], calendar: [], ideas: [], hypotheses: [], alerts: [],
    quote: { price: 77216, currency: 'USD', fx_to_chf: 0.8129 },
    fees: { profile: 'kraken_spot', round_trip_pct: 0.52 },
    defaults: { risk_pct: 1, equity_chf: 10000 },
    ta: {}
  };
}

test('sans lib/sizing.js, un scalp sans ticket est REFUSÉ (jamais 1 unité)', () => {
  scalpSetup();
  assert.strictEqual(coach.scalpSizing(), null, 'le module ne devrait pas être chargé');
  coach.openScalp('buy');
  assert.strictEqual(coach.state.scalp.open, false, 'un scalp a été ouvert sans taille');
  assert.strictEqual(coach.state.scalp.handle, null);
  const refusal = coach.state.toasts[coach.state.toasts.length - 1];
  assert.ok(refusal && refusal.text.indexOf('Capital insuffisant') === 0,
            'le refus n’est pas expliqué');
});

test('sans ticket, le scalp prend la taille auto, annoncée avant le clic', () => {
  require('../lib/sizing.js');
  scalpSetup();

  const sizing = coach.scalpSizing();
  assert.strictEqual(sizing.qty, 0.1593, '0,1593 BTC attendu (plafond de capital)');
  assert.strictEqual(sizing.capped_by, 'notional');
  assert.ok(sizing.notional_chf <= 10000);

  /* La ligne est à l'écran AVANT le clic, avec la taille ET son coût. */
  coach.render();
  const html = shadow().innerHTML;
  assert.ok(html.indexOf('Taille auto') !== -1, 'la ligne de taille manque');
  assert.ok(html.indexOf('0.1593') !== -1, 'la quantité n’est pas affichée');
  /* 9999,08 CHF x 2 côtés x 0,26 % = 52,00 CHF d'aller-retour — le chiffre
     qui manquait à l'écran le 11/09 (326 CHF payés sans les avoir vus). */
  assert.ok(html.indexOf('52.00') !== -1, 'les frais aller-retour manquent');

  coach.openScalp('buy');
  assert.strictEqual(coach.state.scalp.open, true);
  assert.strictEqual(coach.state.scalp.handle.qty, 0.1593,
                     'le ledger a reçu autre chose que la taille auto');
  coach.closeScalp();
});

test('la quantité du ticket, quand il y en a une, reste prioritaire', () => {
  scalpSetup();
  coach.state.ticket = { side: 'buy', qty: 3, stop: null, target: null,
                         precheck: {}, warnings: [] };
  coach.openScalp('buy');
  assert.strictEqual(coach.state.scalp.handle.qty, 3);

  /* Et le panneau ne double pas la ligne : c'est le ticket qui annonce. */
  coach.state.scalp.open = false;
  coach.state.scalp.handle = null;
  coach.render();
  assert.strictEqual(shadow().innerHTML.indexOf('Taille auto'), -1,
                     'la taille auto s’affiche alors que le ticket a une quantité');
});

test('capital hors de portée : le panneau prévient et le scalp est refusé', () => {
  scalpSetup();
  coach.state.brief.defaults.equity_chf = 5;    /* 5 CHF contre un bitcoin */
  assert.strictEqual(coach.scalpSizing().qty, 0);

  coach.render();
  assert.ok(shadow().innerHTML.indexOf('Capital insuffisant') !== -1,
            'le panneau n’explique pas le refus');

  coach.openScalp('buy');
  assert.strictEqual(coach.state.scalp.open, false);
  assert.strictEqual(coach.state.scalp.handle, null);
});

/* --------------------------------------------------------------------- *
 * Le profil de frais part AVEC la demande de fiche.
 *
 * Vu sur UKOIL : « frais A/R ≈ 128.98 CHF » — le barème de Yuh (1,3 %), le
 * courtier du SITE, alors que l'extension enregistre ses scalps chez Kraken
 * (0,52 %). Le serveur ne pouvait pas deviner : personne ne le lui disait.
 * --------------------------------------------------------------------- */

test('la demande de fiche porte le profil de frais de l’extension', () => {
  scalpSetup();                                  /* fee_profile kraken_spot */
  const query = coach.briefQuery();
  assert.strictEqual(query.symbol, 'BTC-USD');
  assert.strictEqual(query.tv, 'BINANCE:BTCUSDT.P');
  assert.strictEqual(query.fee_profile, 'kraken_spot');
  assert.strictEqual(query.custom_pct, null);

  /* Et le sérialiseur OMET la valeur absente au lieu d'envoyer « null ». */
  const buildQuery = require('../lib/api.js').buildQuery;
  assert.strictEqual(
    buildQuery(query),
    '?symbol=BTC-USD&tv=BINANCE%3ABTCUSDT.P&fee_profile=kraken_spot');
});

test('le taux personnalisé ne part QUE sur le profil « custom »', () => {
  scalpSetup();
  const buildQuery = require('../lib/api.js').buildQuery;

  coach.state.settings.custom_pct = 0.1;
  assert.strictEqual(coach.briefQuery().custom_pct, null, 'taux envoyé hors custom');
  assert.strictEqual(buildQuery(coach.briefQuery()).indexOf('custom_pct'), -1);

  coach.state.settings.fee_profile = 'custom';
  assert.strictEqual(coach.briefQuery().custom_pct, 0.1);
  assert.ok(buildQuery(coach.briefQuery()).indexOf('custom_pct=0.1') !== -1);

  /* Profil custom SANS taux lisible : rien ne part, le serveur gardera son
     défaut plutôt que de recevoir « null » ou « NaN ». */
  for (const bogus of [null, '', 'zéro virgule un', undefined]) {
    coach.state.settings.custom_pct = bogus;
    assert.strictEqual(coach.briefQuery().custom_pct, null, String(bogus));
  }
  coach.state.settings.custom_pct = null;
});

test('sans profil réglé, la demande n’impose rien au serveur', () => {
  scalpSetup();
  coach.state.settings.fee_profile = '';
  const query = coach.briefQuery();
  assert.strictEqual(query.fee_profile, '');
  assert.strictEqual(require('../lib/api.js').buildQuery(query).indexOf('fee_profile'),
                     -1, 'un profil vide ne doit pas partir du tout');
});

test('fiche pas encore arrivée : le panneau se tait, le clic refuse quand même',
     () => {
  scalpSetup();
  coach.state.brief = null;                 /* changement de titre en cours */

  coach.render();
  assert.strictEqual(shadow().innerHTML.indexOf('Capital insuffisant'), -1,
                     'le panneau accuse un manque de capital qu’il ignore');

  coach.openScalp('buy');
  assert.strictEqual(coach.state.scalp.open, false, 'ouvert sans savoir l’équité');
  const refusal = coach.state.toasts[coach.state.toasts.length - 1];
  assert.ok(refusal && refusal.text.indexOf('Capital insuffisant') === 0);
});

/* --------------------------------------------------------------------- *
 * Remplissage d'un scalp au bid/ask réel (fillPrice), pas au dernier
 * échange (state.price) — un preneur achète au BUY (ask) et vend au SELL
 * (bid), l'écart est un coût réel que le ledger ignorait jusqu'ici.
 * --------------------------------------------------------------------- */

test('fillPrice : ouvrir un achat entre au ASK, le fermer (vendre) sort au BID', () => {
  scalpSetup();
  coach.state.ticket = { side: 'buy', qty: 1, stop: null, target: null,
                         precheck: {}, warnings: [] };
  coach.state.price = 101;
  coach.state.bid = 100;
  coach.state.ask = 102;

  coach.openScalp('buy');
  assert.strictEqual(coach.state.scalp.open, true);
  const handle = coach.state.scalp.handle;
  assert.ok(handle, 'le ledger n’a pas rendu de scalp');
  assert.strictEqual(handle.entryPrice, 102, 'un achat doit entrer au ASK (102), pas à 101');

  /* Affichage : « Rempli à 102.00 (au BUY) » pendant que le scalp est ouvert
     (langue par défaut du panneau = fr). */
  coach.render();
  assert.ok(shadow().innerHTML.indexOf('102.00') !== -1,
            'le prix de remplissage réel n’apparaît pas à l’écran');
  assert.ok(shadow().innerHTML.indexOf('au BUY') !== -1,
            'le côté (BUY) du remplissage n’apparaît pas à l’écran');

  coach.closeScalp();
  assert.strictEqual(coach.state.scalp.open, false);
  assert.strictEqual(handle.exitPrice, 100,
                     'fermer un achat (le revendre) doit sortir au BID (100), pas à 101');

  coach.state.bid = null;
  coach.state.ask = null;
});

test('fillPrice : ouvrir une vente entre au BID, la fermer (racheter) sort au ASK', () => {
  scalpSetup();
  coach.state.ticket = { side: 'sell', qty: 1, stop: null, target: null,
                         precheck: {}, warnings: [] };
  coach.state.price = 101;
  coach.state.bid = 100;
  coach.state.ask = 102;

  coach.openScalp('sell');
  assert.strictEqual(coach.state.scalp.open, true);
  const handle = coach.state.scalp.handle;
  assert.ok(handle, 'le ledger n’a pas rendu de scalp');
  assert.strictEqual(handle.entryPrice, 100, 'une vente doit entrer au BID (100), pas à 101');

  coach.closeScalp();
  assert.strictEqual(coach.state.scalp.open, false);
  assert.strictEqual(handle.exitPrice, 102,
                     'fermer une vente (la racheter) doit sortir au ASK (102), pas à 101');

  coach.state.bid = null;
  coach.state.ask = null;
});

test('fillPrice : sans bid/ask, repli sur le dernier échange dans les deux sens', () => {
  scalpSetup();
  coach.state.ticket = { side: 'buy', qty: 1, stop: null, target: null,
                         precheck: {}, warnings: [] };
  coach.state.price = 101;
  coach.state.bid = null;
  coach.state.ask = null;

  coach.openScalp('buy');
  const handle = coach.state.scalp.handle;
  assert.ok(handle, 'le ledger n’a pas rendu de scalp');
  assert.strictEqual(handle.entryPrice, 101, 'sans ask, le repli doit être le dernier échange');

  coach.closeScalp();
  assert.strictEqual(handle.exitPrice, 101, 'sans bid, le repli doit être le dernier échange');
});

test('fillPrice : une pastille aberrante (> 1 % du dernier échange) retombe sur state.price',
     () => {
  scalpSetup();
  coach.state.ticket = { side: 'buy', qty: 1, stop: null, target: null,
                         precheck: {}, warnings: [] };
  coach.state.price = 101;
  coach.state.bid = 100;
  /* 150 pour un dernier échange à 101 : bien plus de 1 % d'écart — une
     pastille figée (ou une page qui ne l'expose plus) ne doit jamais
     fabriquer un remplissage faux. */
  coach.state.ask = 150;

  coach.openScalp('buy');
  const handle = coach.state.scalp.handle;
  assert.ok(handle, 'le ledger n’a pas rendu de scalp');
  assert.strictEqual(handle.entryPrice, 101,
                     'un ask aberrant doit être ignoré au profit du dernier échange');

  coach.state.bid = null;
  coach.state.ask = null;
});

/* --------------------------------------------------------------------- *
 * Omen injoignable : un blip isolé reste invisible (lib/outage.js).
 *
 * L'auto-déploiement de l'Omen redémarre le serveur à chaque push sur
 * ``main`` (quelques secondes de trou) — avant ce fix, le tout premier appel
 * raté pendant ce trou verrouillait le ticket et affichait le bandeau
 * jusqu'au prochain appel réussi (5 min plus tard, ou 2 min pour le focus).
 * État remis à zéro EXPLICITEMENT : les tests précédents ont déjà fait
 * échouer d'autres appels réseau (aucun ``chrome.*`` dans ce harnais).
 * --------------------------------------------------------------------- */

test('un premier échec reste invisible, un second lève le bandeau, un succès l’efface',
     () => {
  coach.state.outage = { status: 'ok', failures: 0, next_probe_at: null };
  coach.state.server_ok = true;
  delete coach.state.banners.server_down;

  coach.noteError({ status: 0 });
  assert.strictEqual(coach.state.outage.status, 'suspect');
  assert.strictEqual(coach.state.outage.failures, 1);
  assert.ok(!Object.prototype.hasOwnProperty.call(coach.state.banners, 'server_down'),
            'un premier échec ne doit pas lever le bandeau');
  assert.strictEqual(coach.state.server_ok, true,
                     'un blip isolé ne doit pas verrouiller le ticket');

  coach.noteError({ status: 0 });
  assert.strictEqual(coach.state.outage.status, 'down');
  assert.strictEqual(coach.state.outage.failures, 2);
  assert.ok(Object.prototype.hasOwnProperty.call(coach.state.banners, 'server_down'),
            'un second échec de suite doit lever le bandeau');
  assert.strictEqual(coach.state.server_ok, false);

  coach.markServer(true);
  assert.ok(!Object.prototype.hasOwnProperty.call(coach.state.banners, 'server_down'),
            'un succès doit retirer le bandeau');
  assert.strictEqual(coach.state.server_ok, true);
  assert.strictEqual(coach.state.outage.status, 'ok');
  assert.strictEqual(coach.state.outage.failures, 0);
});

test('un 5xx compte comme un échec réseau, un 4xx prouve au contraire que l’Omen répond',
     () => {
  coach.state.outage = { status: 'ok', failures: 0, next_probe_at: null };
  delete coach.state.banners.server_down;

  coach.noteError({ status: 503 });
  assert.strictEqual(coach.state.outage.status, 'suspect', '503 doit compter comme un échec');

  /* Un 404 (ou 401) prouve que le serveur RÉPOND : ça efface le doute, ce
     n'est jamais un pas de plus vers le bandeau. */
  coach.noteError({ status: 404 });
  assert.strictEqual(coach.state.outage.status, 'ok',
                     'un 404 doit effacer le doute laissé par l’échec précédent');
  assert.ok(!Object.prototype.hasOwnProperty.call(coach.state.banners, 'server_down'));
});

/* --------------------------------------------------------------------- *
 * Note inline sous le bouton « Dessiner… » cliqué (state.draw_note).
 *
 * Vécu : Massii clique « Dessiner les paris » sur BTC-USD sans pari ouvert
 * -> ``drawOrExplain`` toaste puis ``render()`` reconstruit tout le panneau
 * -> le toast (9 s) passe facilement inaperçu, ça se lit comme « ça bug,
 * rien ne s'est dessiné ». La note reste À L'ÉCRAN, sous le bloc de boutons
 * de la section qui l'a déclenchée.
 * --------------------------------------------------------------------- */

test('« Dessiner les paris » sans pari ouvert pose une note APRÈS les boutons coach',
     () => {
  coach.state.mode = 'swing';
  coach.state.brief = { news: [], calendar: [], ideas: [], hypotheses: [], alerts: [] };
  coach.drawBets();
  assert.ok(coach.state.draw_note, 'aucune note posée');
  assert.strictEqual(coach.state.draw_note.where, 'coach');

  const lastToast = coach.state.toasts[coach.state.toasts.length - 1];
  assert.strictEqual(coach.state.draw_note.text, lastToast.text,
                     'la note doit porter le MÊME texte que le toast');
  coach.state.toasts = [];      /* le toast porte le MÊME texte : évite un faux positif
                                    dans la recherche ci-dessous, qui cherche le <p> */

  coach.render();
  const html = shadow().innerHTML;
  const actionsIdx = html.indexOf('data-omen-act="draw-clear"');
  const notePara = '<p class="omen-note omen-warn">' + coach.esc(coach.state.draw_note.text)
    + '</p>';
  const noteIdx = html.indexOf(notePara);
  assert.ok(actionsIdx !== -1 && noteIdx !== -1 && noteIdx > actionsIdx,
            'la note n’apparaît pas après le bloc de boutons coach');

  coach.state.draw_note = null;
});

test('la note ne s’affiche QUE dans la section qui l’a déclenchée', () => {
  coach.state.mode = 'swing';
  coach.state.draw_note = { where: 'scalp', text: 'texte-scalp-unique-xyz',
                            at: Date.now() };
  coach.render();
  /* Mode swing : renderScalp() n'est jamais appelé -> une note "scalp" n'a
     nulle part où s'afficher, elle ne doit fuiter dans AUCUNE autre section. */
  assert.strictEqual(shadow().innerHTML.indexOf('texte-scalp-unique-xyz'), -1,
                     'une note "scalp" a fui dans une section qui n’est pas la sienne');
  coach.state.draw_note = null;
  coach.render();
});

test('la note expire comme un toast, et pruneDrawNote() la retire activement', () => {
  coach.state.mode = 'swing';
  coach.state.draw_note = { where: 'coach', text: 'note-expiree-test',
                            at: Date.now() - 20000 };
  coach.render();
  assert.strictEqual(shadow().innerHTML.indexOf('note-expiree-test'), -1,
                     'une note expirée doit disparaître du rendu');

  /* pruneDrawNote() la purge activement (comme pruneToasts()) : un panneau
     resté ouvert sans repeint ne doit pas garder une note fantôme. */
  coach.state.draw_note = { where: 'coach', text: 'note-a-purger', at: Date.now() - 20000 };
  coach.pruneDrawNote();
  assert.strictEqual(coach.state.draw_note, null, 'la note expirée n’a pas été purgée');
});

test('dessin refusé (pas connecté à TradingView) : la note ET le toast portent le même texte, la note s’affiche après les boutons scalp',
     () => {
  coach.state.mode = 'scalp';
  coach.state.scalp.open = false;
  coach.state.drawing.allowed = false;
  const before = coach.state.toasts.length;

  coach.drawScalpLevels();
  assert.strictEqual(coach.state.draw_note.where, 'scalp');
  assert.ok(coach.state.toasts.length > before, 'le toast a disparu');
  const lastToast = coach.state.toasts[coach.state.toasts.length - 1];
  assert.strictEqual(coach.state.draw_note.text, lastToast.text);
  coach.state.toasts = [];      /* même texte que le toast : sans ça la recherche du
                                    <p> ci-dessous matcherait le <div> du toast */

  coach.render();
  const html = shadow().innerHTML;
  const actionsIdx = html.indexOf('data-omen-act="draw-scalp"');
  const notePara = '<p class="omen-note omen-warn">' + coach.esc(coach.state.draw_note.text)
    + '</p>';
  const noteIdx = html.indexOf(notePara);
  assert.ok(actionsIdx !== -1 && noteIdx !== -1 && noteIdx > actionsIdx,
            'la note n’apparaît pas après les boutons scalp');

  coach.state.drawing.allowed = true;
  coach.state.mode = 'swing';
  coach.state.draw_note = null;
});

test('« Dessiner les niveaux » du ticket swing sans niveau valable pose la note "ticket"',
     () => {
  coach.state.mode = 'swing';
  coach.state.ticket = { side: 'buy', entry: null, stop: null, target: null,
                         qty: null, precheck: null, warnings: [], needs_confirm: null,
                         status: '', thesis: '', symbol: coach.state.symbol };
  coach.drawTicketLevels();
  assert.strictEqual(coach.state.draw_note.where, 'ticket');
  const lastToast = coach.state.toasts[coach.state.toasts.length - 1];
  assert.strictEqual(coach.state.draw_note.text, lastToast.text);
  coach.state.toasts = [];      /* même texte que le toast : sans ça la recherche du
                                    <p> ci-dessous matcherait le <div> du toast */

  coach.render();
  const html = shadow().innerHTML;
  const actionsIdx = html.indexOf('data-omen-act="draw-levels"');
  const notePara = '<p class="omen-note omen-warn">' + coach.esc(coach.state.draw_note.text)
    + '</p>';
  const noteIdx = html.indexOf(notePara);
  assert.ok(actionsIdx !== -1 && noteIdx !== -1 && noteIdx > actionsIdx,
            'la note n’apparaît pas après les boutons du ticket');

  coach.state.ticket = null;
  coach.state.draw_note = null;
});

test('onDrawResult(not_authenticated) pose la note dans la section qui a demandé le dessin',
     () => {
  coach.state.mode = 'scalp';
  coach.state.drawing.allowed = true;
  coach.state.drawing.available = true;
  coach.state.drawing.denied_for = null;
  coach.state.price = 77216;
  coach.state.brief = { ta: { vwap: 77216 }, btc: {} };

  const before = posted.length;
  coach.drawScalpLevels();
  const sent = posted.slice(before).filter((m) => m.type === 'draw:apply').pop();
  assert.ok(sent, 'aucune commande de dessin envoyée au pont (niveaux vides ?)');

  sendFromBridge({ type: 'draw:result', id: sent.id, error: 'not_authenticated' });
  assert.ok(coach.state.draw_note, 'aucune note posée par onDrawResult');
  assert.strictEqual(coach.state.draw_note.where, 'scalp',
                     'la note doit porter le "where" de la requête d’origine (scalp)');

  coach.state.mode = 'swing';
  coach.state.draw_note = null;
  coach.state.drawing.denied_for = null;
});

test('onDrawResult(not_authenticated) retombe sur "coach" quand la requête d’origine est introuvable',
     () => {
  coach.state.draw_note = null;
  sendFromBridge({ type: 'draw:result', id: 'requete-jamais-envoyee',
                   error: 'not_authenticated' });
  assert.ok(coach.state.draw_note, 'aucune note posée');
  assert.strictEqual(coach.state.draw_note.where, 'coach');
  coach.state.draw_note = null;
  coach.state.drawing.denied_for = null;
});
