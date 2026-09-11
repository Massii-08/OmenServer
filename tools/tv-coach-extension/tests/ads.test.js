'use strict';

/**
 * tests/ads.test.js — fermeture automatique des pubs TradingView (PUR).
 *
 * Deux surfaces à fermer : le toast pub du coin bas gauche, et le pop-up
 * « plan sans pub » (reconnu par NOM `data-dialog-name` OU par TEXTE). Rien
 * d'autre : un dialogue d'alerte, de recherche, de paramètres, ou le portail
 * « Acheter au prix du marché » vu sur la page réelle ne doivent jamais
 * produire d'action, même s'ils ont un bouton « Fermer ».
 */
const test = require('node:test');
const assert = require('node:assert');

const ads = require('../lib/ads.js');

test('isCloseLabel reconnaît les libellés de fermeture, toutes langues', () => {
  const positive = [
    'Fermer la publicité', 'Fermer', 'Close ad', 'Close',
    'Chiudi l’annuncio', 'Chiudi', 'Cerrar anuncio', 'Anzeige schließen',
    '  fermer  ', 'CLOSE'
  ];
  for (const label of positive) {
    assert.strictEqual(ads.isCloseLabel(label), true, label + ' aurait dû être reconnu');
  }
  const negative = ['Acheter', 'Publier', 'OK', 'Enregistrer', ''];
  for (const label of negative) {
    assert.strictEqual(ads.isCloseLabel(label), false, label + ' n’aurait pas dû être reconnu');
  }
});

test('isUpsellText reconnaît un texte qui parle de se débarrasser des pubs', () => {
  const positive = [
    'sans pub', 'sans publicité', 'publicités', 'se débarrasser des pubs',
    'supprimer les publicités', 'ad-free', 'without ads', 'get rid of ads',
    'remove ads', 'no ads', 'senza pubblicità', 'annunci'
  ];
  for (const text of positive) {
    assert.strictEqual(ads.isUpsellText(text), true, text + ' aurait dû être reconnu');
  }
  const negative = [
    'Acheter au prix du marché', 'Publier l’idée', 'Paramètres du graphique',
    'Alerte sur BTCUSD', ''
  ];
  for (const text of negative) {
    assert.strictEqual(ads.isUpsellText(text), false, text + ' n’aurait pas dû être reconnu');
  }
});

test('isUpsellName reconnaît le data-dialog-name des dialogues d’incitation', () => {
  const positive = [
    'gopro-dialog', 'last-chance-offer-dialog', 'thirty-day-free',
    'early-bird-banner', 'offer-button-impl'
  ];
  for (const name of positive) {
    assert.strictEqual(ads.isUpsellName(name), true, name + ' aurait dû être reconnu');
  }
  const negative = ['alert', 'symbol-search', 'chart-properties', 'notes-dialog', ''];
  for (const name of negative) {
    assert.strictEqual(ads.isUpsellName(name), false, name + ' n’aurait pas dû être reconnu');
  }
});

test('isDismissLabel reconnaît les renvois, jamais une incitation d’achat', () => {
  const positive = [
    'Non merci', 'Non, merci', 'Plus tard', 'Pas maintenant',
    'Continuer avec les pubs', 'No thanks', 'Not now', 'Maybe later', 'Later',
    'Continue with ads', 'Keep ads', 'No, grazie', 'Più tardi',
    'Continua con gli annunci'
  ];
  for (const text of positive) {
    assert.strictEqual(ads.isDismissLabel(text), true, text + ' aurait dû être reconnu');
  }
  const negative = [
    'Essayer gratuitement', 'Try it free', 'Passer à Premium', 'Upgrade',
    'Acheter', ''
  ];
  for (const text of negative) {
    assert.strictEqual(ads.isDismissLabel(text), false, text + ' n’aurait pas dû être reconnu');
  }
});

test('pickCloser priorise name=close avant tout le reste', () => {
  const buttons = [
    { name: '', label: 'Fermer', text: 'Fermer' },
    { name: 'close', label: '', text: '' }
  ];
  assert.strictEqual(ads.pickCloser(buttons), 1);
});

test('pickCloser priorise le libellé (aria-label) avant le renvoi et le texte', () => {
  const buttons = [
    { name: '', label: '', text: 'Non merci' },
    { name: '', label: 'Fermer', text: 'OK' }
  ];
  assert.strictEqual(ads.pickCloser(buttons), 1);
});

test('pickCloser priorise le renvoi (« Plus tard ») avant le texte de fermeture', () => {
  const buttons = [
    { name: '', label: '', text: 'Fermer' },
    { name: '', label: '', text: 'Plus tard' }
  ];
  assert.strictEqual(ads.pickCloser(buttons), 1);
});

test('pickCloser retombe sur le texte de fermeture en dernier recours', () => {
  const buttons = [
    { name: '', label: '', text: 'OK' },
    { name: '', label: '', text: 'Fermer' }
  ];
  assert.strictEqual(ads.pickCloser(buttons), 1);
});

test('pickCloser rend -1 quand rien ne matche', () => {
  assert.strictEqual(ads.pickCloser([{ name: '', label: '', text: 'OK' }]), -1);
  assert.strictEqual(ads.pickCloser([]), -1);
  assert.strictEqual(ads.pickCloser(null), -1);
  assert.strictEqual(ads.pickCloser([{}]), -1);
});

test('pickCloser n’élit JAMAIS un bouton d’achat, même s’il matche autre chose', () => {
  /* name="close" mais le texte est une incitation d'achat : écarté quand même. */
  assert.strictEqual(
    ads.pickCloser([{ name: 'close', label: '', text: 'Essayer gratuitement' }]), -1);
  /* Le même piège, avec un vrai bouton de fermeture en repli. */
  const buttons = [
    { name: 'close', label: '', text: 'Essayer gratuitement' },
    { name: '', label: '', text: 'Fermer' }
  ];
  assert.strictEqual(ads.pickCloser(buttons), 1);
  /* Incitation portée par le libellé aria plutôt que le texte visible. */
  assert.strictEqual(
    ads.pickCloser([{ name: '', label: 'Try it free', text: 'Fermer' }]), -1);
});

test('plan ferme les pubs (toast) qui ont un bouton reconnu', () => {
  const snapshot = {
    ads: [{ id: 'ad1', buttons: [{ name: '', label: 'Fermer la publicité', text: '' }] }],
    dialogs: []
  };
  assert.deepStrictEqual(ads.plan(snapshot), [{ kind: 'ad', id: 'ad1', button: 0 }]);
});

test('plan ignore une pub sans bouton reconnu', () => {
  const snapshot = {
    ads: [{ id: 'ad1', buttons: [{ name: '', label: '', text: 'X' }] }],
    dialogs: []
  };
  assert.deepStrictEqual(ads.plan(snapshot), []);
});

test('plan ne touche JAMAIS un dialogue non-pub, même avec un bouton Fermer', () => {
  const snapshot = {
    ads: [],
    dialogs: [{
      id: 'dlg1', name: 'alert-dialog', text: 'Alerte sur BTCUSD',
      buttons: [{ name: '', label: '', text: 'Fermer' }]
    }]
  };
  assert.deepStrictEqual(ads.plan(snapshot), []);
});

test('plan ne touche jamais le portail « Acheter au prix du marché »', () => {
  const snapshot = {
    ads: [],
    dialogs: [{
      id: 'portal1', name: '', text: 'Acheter au prix du marché Shift B',
      buttons: [{ name: '', label: '', text: 'Fermer' }]
    }]
  };
  assert.deepStrictEqual(ads.plan(snapshot), []);
});

test('plan ferme un dialogue reconnu par son TEXTE (pas de nom)', () => {
  const snapshot = {
    ads: [],
    dialogs: [{
      id: 'dlg2', name: '', text: 'Profite d’un abonnement sans pub',
      buttons: [{ name: '', label: '', text: 'Non merci' }]
    }]
  };
  assert.deepStrictEqual(ads.plan(snapshot), [{ kind: 'upsell', id: 'dlg2', button: 0 }]);
});

test('plan ferme un dialogue reconnu par son NOM seul, sans mot « pub » dans le texte', () => {
  const snapshot = {
    ads: [],
    dialogs: [{
      id: 'dlg3', name: 'gopro-dialog', text: 'Débloque des fonctionnalités avancées',
      buttons: [{ name: 'close', label: '', text: '' }]
    }]
  };
  assert.deepStrictEqual(ads.plan(snapshot), [{ kind: 'upsell', id: 'dlg3', button: 0 }]);
});

test('plan : un dialogue alert-dialog reste ignoré même avec un bouton Fermer', () => {
  const snapshot = {
    ads: [],
    dialogs: [{
      id: 'dlg4', name: 'alert-dialog', text: 'Créer une alerte',
      buttons: [{ name: '', label: '', text: 'Fermer' }]
    }]
  };
  assert.deepStrictEqual(ads.plan(snapshot), []);
});

test('plan complet : pubs et dialogues mélangés, dans l’ordre du snapshot', () => {
  const snapshot = {
    ads: [
      { id: 'ad1', buttons: [{ name: '', label: 'Fermer la publicité', text: '' }] },
      { id: 'ad2', buttons: [{ name: '', label: '', text: 'X' }] }
    ],
    dialogs: [
      {
        id: 'dlg1', name: 'alert-dialog', text: 'Alerte sur BTCUSD',
        buttons: [{ name: '', label: '', text: 'Fermer' }]
      },
      {
        id: 'dlg2', name: 'last-chance-offer-dialog', text: 'Dernière chance : abonne-toi',
        buttons: [{ name: '', label: '', text: 'Essayer' },
                  { name: '', label: '', text: 'Non merci' }]
      }
    ]
  };
  assert.deepStrictEqual(ads.plan(snapshot), [
    { kind: 'ad', id: 'ad1', button: 0 },
    { kind: 'upsell', id: 'dlg2', button: 1 }
  ]);
});

test('plan tolère une entrée absente ou malformée sans jamais lever', () => {
  assert.deepStrictEqual(ads.plan({}), []);
  assert.deepStrictEqual(ads.plan(null), []);
  assert.deepStrictEqual(ads.plan({ ads: [{}], dialogs: [{}] }), []);
});
