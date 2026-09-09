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
