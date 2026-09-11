'use strict';

/**
 * tests/manifest.test.js — le manifeste doit rester chargeable par Chrome.
 *
 * Les trois modules du lot ``ext-scalp`` (bars/guards/ledger) peuvent ne pas
 * encore être sur le disque pendant que les deux lots avancent en parallèle :
 * leur absence est SIGNALÉE, pas transformée en échec.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const RAW = fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8');
const MANIFEST = JSON.parse(RAW);

/* Écrits par le lot ext-scalp, en parallèle. */
const EXTERNAL = ['lib/bars.js', 'lib/guards.js', 'lib/ledger.js'];

test('JSON valide, en-tête MV3', () => {
  assert.strictEqual(MANIFEST.manifest_version, 3);
  assert.strictEqual(MANIFEST.name, 'OmenServer Coach');
  assert.match(String(MANIFEST.version), /^\d+\.\d+\.\d+$/);
  assert.strictEqual(MANIFEST.background.service_worker, 'sw.js');
  assert.strictEqual(MANIFEST.options_page, 'options.html');
});

test('le pont est injecté dans le monde MAIN', () => {
  const bridge = MANIFEST.content_scripts.find((entry) => entry.world === 'MAIN');
  assert.ok(bridge, 'aucun content script en world MAIN');
  assert.deepStrictEqual(bridge.js, ['bridge.js']);
  assert.deepStrictEqual(bridge.matches, ['*://*.tradingview.com/chart/*']);
  assert.strictEqual(bridge.run_at, 'document_idle');
});

test('le panneau est injecté en monde isolé avec ses modules et son CSS', () => {
  const panel = MANIFEST.content_scripts.find(
    (entry) => entry.world !== 'MAIN' && entry.js.indexOf('content.js') !== -1);
  assert.ok(panel, 'aucun content script pour content.js');
  assert.deepStrictEqual(panel.css, ['panel.css']);
  for (const module of ['lib/i18n.js', 'lib/symbols.js', 'lib/alerts.js',
                        'lib/api.js', 'lib/draw.js', 'lib/ads.js',
                        'lib/sizing.js'].concat(EXTERNAL)) {
    assert.ok(panel.js.indexOf(module) !== -1, module + ' absent du manifeste');
  }
  /* content.js vient APRÈS ses modules. */
  assert.strictEqual(panel.js[panel.js.length - 1], 'content.js');
});

test('la page OmenServer a son propre content script', () => {
  const omen = MANIFEST.content_scripts.find(
    (entry) => entry.js.indexOf('content-omen.js') !== -1);
  assert.ok(omen, 'content-omen.js absent');
  assert.deepStrictEqual(omen.matches,
                         ['https://omenserver.org/*', 'http://localhost:8000/*']);
});

test('permissions et hôtes attendus', () => {
  for (const permission of ['storage', 'notifications', 'alarms']) {
    assert.ok(MANIFEST.permissions.indexOf(permission) !== -1,
              'permission manquante : ' + permission);
  }
  for (const host of ['https://omenserver.org/*', 'http://localhost:8000/*',
                      'wss://fstream.binance.com/*']) {
    assert.ok(MANIFEST.host_permissions.indexOf(host) !== -1,
              'host_permission manquante : ' + host);
  }
  /* Aucune permission large : le panneau ne liste pas les onglets. */
  assert.strictEqual(MANIFEST.permissions.indexOf('tabs'), -1);
});

test('panel.css est accessible depuis la page (shadow DOM)', () => {
  const entry = (MANIFEST.web_accessible_resources || [])[0];
  assert.ok(entry, 'web_accessible_resources absent');
  assert.ok(entry.resources.indexOf('panel.css') !== -1);
});

test('tous les fichiers cités existent (hors modules du lot ext-scalp)', (t) => {
  const cited = ['sw.js', 'options.html'];
  for (const entry of MANIFEST.content_scripts) {
    for (const file of entry.js) { cited.push(file); }
    for (const file of (entry.css || [])) { cited.push(file); }
  }
  for (const entry of (MANIFEST.web_accessible_resources || [])) {
    for (const file of entry.resources) { cited.push(file); }
  }
  const missing = [];
  for (const file of cited) {
    if (fs.existsSync(path.join(ROOT, file))) { continue; }
    if (EXTERNAL.indexOf(file) !== -1) {
      t.diagnostic('module du lot ext-scalp pas encore livré : ' + file);
      continue;
    }
    missing.push(file);
  }
  assert.deepStrictEqual(missing, []);
});
