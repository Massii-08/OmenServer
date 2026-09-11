/**
 * lib/ads.js — fermeture automatique des pubs TradingView (PUR, pas de DOM).
 *
 * Deux surfaces à fermer, et RIEN d'autre :
 *  1. le toast pub du coin bas gauche du graphique (``#charting-ad`` /
 *     ``div-gpt-ad-toast-ad-N``) ;
 *  2. le pop-up qui propose un plan « sans pub » — reconnu par son NOM
 *     (``data-dialog-name`` de la famille ``gopro-dialog``/``offer``/…, cf.
 *     les chunks webpack ``gopro-dialog``/``last-chance-offer-dialog``/
 *     ``thirty-day-free``/``early-bird-banner``/``offer-button-impl``) OU, à
 *     défaut, par son TEXTE (« sans pub », « ad-free », « pubblicità »...).
 *
 * Tout le reste (alerte, recherche de symbole, paramètres du graphique,
 * menus, infobulles, le portail « Acheter au prix du marché » vu sur la page
 * réelle) ne doit JAMAIS être touché — d'où une détection par nom/texte
 * plutôt que par classe CSS (les classes TradingView sont hachées, donc
 * instables) et le refus de cliquer un bouton dont le texte OU le libellé
 * est lui-même une incitation d'achat (« Essayer », « Upgrade », « Acheter »),
 * même s'il matche par ailleurs (name="close" ne suffit pas : mieux vaut
 * rater une pub que valider un achat).
 *
 * ``content.js`` construit un ``snapshot`` DOM -> JSON (``{ads, dialogs}``) ;
 * ``plan()`` rend la liste des boutons à cliquer, sans jamais toucher au DOM
 * lui-même (ça reste le travail du contenu, ce module ne lit rien).
 */
(function () {
  'use strict';

  /** Minuscules, apostrophes courbes -> droites, espaces normalisés. */
  function normalizeText(value) {
    if (value === null || value === undefined) { return ''; }
    return String(value)
      .replace(/[‘’ʼ`]/g, '\'')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();
  }

  /* Libellés de fermeture relevés (fr/en/it) + repli es/de : les dialogues
     TradingView ne suivent pas forcément la langue réglée dans l'extension.
     ``×``/``✕`` : le glyphe EST le libellé quand le bouton n'a ni texte
     visible ni aria-label plus explicite. */
  var CLOSE_LABELS = [
    'fermer la publicité',
    'fermer',
    'close ad',
    'close',
    'chiudi l\'annuncio',
    'chiudi',
    'cerrar anuncio',
    'anzeige schließen',
    '×',
    '✕'
  ];

  /* Renvois (« pas maintenant ») : ça ferme le pop-up sans jamais valider. */
  var DISMISS_LABELS = [
    'non merci',
    'non, merci',
    'plus tard',
    'pas maintenant',
    'continuer avec les pubs',
    'no thanks',
    'not now',
    'maybe later',
    'later',
    'continue with ads',
    'keep ads',
    'no, grazie',
    'più tardi',
    'continua con gli annunci'
  ];

  /* Mots entiers : la pub SE DIT, jamais devinée sur une classe hachée.
     ``débarrass``/``sponsor`` : le paywall TradingView (module ``toast-ad``,
     ``_onCloseToast`` -> ``openPaywall({feature:"adFree"})``) ne garantit ni
     ``role="dialog"`` ni ``data-dialog-name`` sur sa racine — le TEXTE reste
     le seul repère fiable, d'où la liste élargie. ``Essential``/``Plus``/
     ``Premium`` sont des noms de PLAN qui apparaissent hors contexte pub
     (ex. un bandeau de compte) : DÉLIBÉRÉMENT absents d'ici, ils ne comptent
     que combinés à un des mots ci-dessous, dans le MÊME texte. */
  var UPSELL_TEXT_PATTERNS = [
    /\bpubs?\b/i,
    /\bads?\b/i,
    /publicit/i,
    /pubblicit/i,
    /annunci/i,
    /ad-free/i,
    /adfree/i,
    /without ads/i,
    /no ads/i,
    /no more ads/i,
    /remove ads/i,
    /get rid of ads/i,
    /go ad-free/i,
    /sans pub/i,
    /senza pubblicit/i,
    /senza annunci/i,
    /d[ée]barrass/i,
    /sponsor/i
  ];

  /* data-dialog-name (ou data-name/data-qa-id/id) des dialogues d'incitation
     à l'abonnement — noms de chunks webpack TradingView + le paywall
     (``paywall-manager``/``open-paywall``). ``plan``/``upgrade``/
     ``subscription``/``sponsored`` sont volontairement larges : cette
     détection n'agit QUE sur des candidats déjà filtrés par la taille
     (content.js) et reste combinée à un TEXTE ou un NOM — jamais un
     dialogue fermé au seul motif « il est grand ». */
  var UPSELL_NAME_RE = /gopro|go-pro|last-chance|offer|promo|upsell|thirty-day|early-bird|ad-free|adfree|ad_free|no-?ads|paywall|sponsored|subscription|upgrade|plan/i;

  /* Jamais cliqué, même si le reste matche : ce sont des boutons D'ACHAT. */
  var BUY_WORDS = [
    'essayer', 'try', 'upgrade', 'passer à', 'passer a', 'acheter', 'buy',
    'abbonati', 'prova'
  ];

  function isCloseLabel(text) {
    var value = normalizeText(text);
    if (!value) { return false; }
    return CLOSE_LABELS.indexOf(value) !== -1;
  }

  function isDismissLabel(text) {
    var value = normalizeText(text);
    if (!value) { return false; }
    return DISMISS_LABELS.indexOf(value) !== -1;
  }

  function isUpsellText(text) {
    var value = normalizeText(text);
    if (!value) { return false; }
    for (var i = 0; i < UPSELL_TEXT_PATTERNS.length; i += 1) {
      if (UPSELL_TEXT_PATTERNS[i].test(value)) { return true; }
    }
    return false;
  }

  function isUpsellName(name) {
    var value = normalizeText(name);
    if (!value) { return false; }
    return UPSELL_NAME_RE.test(value);
  }

  function isBuyLabel(text) {
    var value = normalizeText(text);
    if (!value) { return false; }
    for (var i = 0; i < BUY_WORDS.length; i += 1) {
      if (value.indexOf(BUY_WORDS[i]) !== -1) { return true; }
    }
    return false;
  }

  /** ``data-qa-id`` qui CONTIENT « close » (ex. ``qa-close-btn``) : signal
   *  structurel aussi fort que ``name === 'close'``, pas un mot à traduire. */
  function isCloseQaId(value) {
    var normalized = normalizeText(value);
    return !!normalized && normalized.indexOf('close') !== -1;
  }

  /**
   * ``pickCloser(buttons)`` -> l'INDEX du bouton à cliquer, ou ``-1``.
   * ``buttons`` : ``[{name, label, text, qa}, ...]`` (chaînes, vides si
   * absentes, ``name``/``label``/``qa`` = ``data-name``/``aria-label``/
   * ``data-qa-id``, ``text`` = contenu).
   *
   * Priorité, la première trouvée gagne (recherchée sur TOUS les boutons
   * avant de passer au palier suivant) :
   *   1. ``name === 'close'`` OU ``qa`` contient « close » ;
   *   2. libellé de fermeture porté par ``label`` (aria — couvre aussi un
   *      bouton dont le texte visible n'est qu'un glyphe ``×``/``✕``) ;
   *   3. libellé de renvoi porté par ``text`` (« Non merci »...) ;
   *   4. libellé de fermeture porté par ``text``.
   *
   * Un bouton d'achat (``label`` OU ``text``) est écarté AVANT toute
   * priorité — jamais élu, même s'il matche par ailleurs.
   */
  function pickCloser(buttons) {
    var list = Array.isArray(buttons) ? buttons : [];
    var candidates = [];
    var i;
    for (i = 0; i < list.length; i += 1) {
      var raw = list[i] || {};
      var text = String(raw.text || '');
      var label = String(raw.label || '');
      if (isBuyLabel(text) || isBuyLabel(label)) { continue; }
      candidates.push({
        index: i, name: String(raw.name || ''), label: label, text: text,
        qa: String(raw.qa || '')
      });
    }
    for (i = 0; i < candidates.length; i += 1) {
      if (normalizeText(candidates[i].name) === 'close' || isCloseQaId(candidates[i].qa)) {
        return candidates[i].index;
      }
    }
    for (i = 0; i < candidates.length; i += 1) {
      if (isCloseLabel(candidates[i].label)) { return candidates[i].index; }
    }
    for (i = 0; i < candidates.length; i += 1) {
      if (isDismissLabel(candidates[i].text)) { return candidates[i].index; }
    }
    for (i = 0; i < candidates.length; i += 1) {
      if (isCloseLabel(candidates[i].text)) { return candidates[i].index; }
    }
    return -1;
  }

  /**
   * ``plan(snapshot)`` -> ``[{kind: 'ad'|'upsell', id, button}
   *                         | {kind: 'upsell', id, button: -1, escape: true}, ...]``.
   * ``snapshot = { ads: [{id, buttons}], dialogs: [{id, name, text, buttons}] }``.
   *
   * Un ``ad`` (toast) est toujours candidat à la fermeture. Un ``dialog``
   * n'en est un QUE s'il parle de pub — par son ``name`` (data-dialog-name
   * et apparentés) OU son ``text`` — jamais une alerte, une recherche, des
   * paramètres, même avec un bouton « Fermer ».
   *
   * Un dialogue pub SANS bouton élu (ex. le paywall TradingView, dont la
   * structure DOM exacte des boutons n'est pas connue) rend une action
   * ``{button: -1, escape: true}`` : ``content.js`` interprète ça comme un
   * repli clavier (Échap), jamais un clic dans le vide. Les toasts (``ad``)
   * n'ont PAS ce repli — un toast sans bouton reconnu est juste ignoré,
   * Échap n'a aucune raison de fermer une pub qui n'est pas un dialogue.
   */
  function plan(snapshot) {
    var data = snapshot || {};
    var ads = Array.isArray(data.ads) ? data.ads : [];
    var dialogs = Array.isArray(data.dialogs) ? data.dialogs : [];
    var actions = [];
    var i;
    for (i = 0; i < ads.length; i += 1) {
      var ad = ads[i] || {};
      var adIndex = pickCloser(ad.buttons);
      if (adIndex !== -1) { actions.push({ kind: 'ad', id: ad.id, button: adIndex }); }
    }
    for (i = 0; i < dialogs.length; i += 1) {
      var dialog = dialogs[i] || {};
      var isAd = isUpsellName(dialog.name) || isUpsellText(dialog.text);
      if (!isAd) { continue; }
      var dlgIndex = pickCloser(dialog.buttons);
      if (dlgIndex !== -1) {
        actions.push({ kind: 'upsell', id: dialog.id, button: dlgIndex });
      } else {
        actions.push({ kind: 'upsell', id: dialog.id, button: -1, escape: true });
      }
    }
    return actions;
  }

  var api = {
    isCloseLabel: isCloseLabel,
    isCloseQaId: isCloseQaId,
    isUpsellText: isUpsellText,
    isUpsellName: isUpsellName,
    isDismissLabel: isDismissLabel,
    pickCloser: pickCloser,
    plan: plan
  };

  globalThis.OmenLib = globalThis.OmenLib || {};
  globalThis.OmenLib.ads = api;
  if (typeof module !== 'undefined' && module.exports) { module.exports = api; }
})();
