'use strict';

/**
 * tests/i18n.test.js — parité stricte FR / IT / EN et comportement de ``t()``.
 */
const test = require('node:test');
const assert = require('node:assert');

const i18n = require('../lib/i18n.js');

test('les trois dictionnaires ont exactement les mêmes clés', () => {
  const fr = Object.keys(i18n.STRINGS.fr).sort();
  const it = Object.keys(i18n.STRINGS.it).sort();
  const en = Object.keys(i18n.STRINGS.en).sort();
  assert.deepStrictEqual(it, fr, 'clés IT différentes des clés FR');
  assert.deepStrictEqual(en, fr, 'clés EN différentes des clés FR');
  assert.ok(fr.length >= 60, 'le panneau attend au moins 60 clés, vu ' + fr.length);
});

test('aucune valeur vide, aucune valeur non-texte', () => {
  for (const lang of i18n.LANGS) {
    const dict = i18n.STRINGS[lang];
    for (const key of Object.keys(dict)) {
      assert.strictEqual(typeof dict[key], 'string', lang + '/' + key + ' n’est pas du texte');
      assert.ok(dict[key].trim().length > 0, lang + '/' + key + ' est vide');
    }
  }
});

test('les emplacements {…} d’une clé sont les mêmes dans les trois langues', () => {
  const placeholders = (text) => {
    const found = String(text).match(/\{[a-z0-9_]+\}/gi) || [];
    return found.sort();
  };
  for (const key of Object.keys(i18n.STRINGS.fr)) {
    const reference = placeholders(i18n.STRINGS.fr[key]);
    assert.deepStrictEqual(placeholders(i18n.STRINGS.it[key]), reference,
                           'IT/' + key + ' : emplacements différents');
    assert.deepStrictEqual(placeholders(i18n.STRINGS.en[key]), reference,
                           'EN/' + key + ' : emplacements différents');
  }
});

test('t rend la chaîne de la langue demandée', () => {
  assert.strictEqual(i18n.t('ticket.buy', 'fr'), 'Acheter');
  assert.strictEqual(i18n.t('ticket.buy', 'it'), 'Compra');
  assert.strictEqual(i18n.t('ticket.buy', 'en'), 'Buy');
});

test('langue inconnue -> français ; clé inconnue -> la clé', () => {
  assert.strictEqual(i18n.t('ticket.buy', 'de'), 'Acheter');
  assert.strictEqual(i18n.t('ticket.buy', null), 'Acheter');
  assert.strictEqual(i18n.t('rien.du.tout', 'fr'), 'rien.du.tout');
  assert.strictEqual(i18n.normalizeLang('IT-ch'), 'it');
});

test('interpolation des valeurs', () => {
  assert.strictEqual(i18n.t('alerts.above', 'fr', { price: '80 000' }),
                     'au-dessus de 80 000');
  assert.strictEqual(i18n.t('draw.done', 'en', { n: 3 }), '3 drawings placed.');
  /* Une valeur absente laisse l'emplacement visible plutôt que du vide. */
  assert.strictEqual(i18n.t('draw.done', 'en'), '{n} drawings placed.');
});

test('maker fige la langue', () => {
  const t = i18n.maker('it');
  assert.strictEqual(t('ticket.cancel'), 'Annulla');
});

test('aucun emoji dans les chaînes du panneau', () => {
  const emoji = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u;
  for (const lang of i18n.LANGS) {
    const dict = i18n.STRINGS[lang];
    for (const key of Object.keys(dict)) {
      assert.ok(!emoji.test(dict[key]), lang + '/' + key + ' contient un emoji');
    }
  }
});

test('banner.token_expired nomme omenserver.org et le libellé exact du bouton par langue', () => {
  const button = {
    fr: 'Connecter l’extension coach',
    it: 'Collega l’estensione coach',
    en: 'Connect the coach extension'
  };
  for (const lang of i18n.LANGS) {
    const text = i18n.t('banner.token_expired', lang);
    assert.ok(text.includes('omenserver.org'), lang + ' : omenserver.org absent du bandeau');
    assert.ok(text.includes(button[lang]), lang + ' : libellé du bouton absent du bandeau');
  }
});
