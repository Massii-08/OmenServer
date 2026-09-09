/**
 * options.js — les réglages de l'extension (page d'extension, CSP MV3 : aucun
 * script en ligne, aucune ``eval``).
 *
 * Le profil de frais n'a PAS de défaut caché (spec §6.4) : tant qu'il est vide,
 * un bandeau le réclame et le ticket refuse d'ouvrir un scalp. Le token peut
 * être collé ici, mais la voie normale reste le bouton « Connecter l'extension
 * coach » sur omenserver.org.
 */
(function () {
  'use strict';

  var NS = '[omen-coach]';

  var DEFAULTS = {
    token: '',
    api_base: 'https://omenserver.org',
    fee_profile: '',
    custom_pct: null,
    risk_pct: 1,
    lang: 'fr',
    scalp_auto: true
  };

  function debug() {
    try {
      var args = Array.prototype.slice.call(arguments);
      args.unshift(NS);
      console.debug.apply(console, args);
    } catch (e) { /* rien */ }
  }

  function byId(id) { return document.getElementById(id); }

  function t(key, lang, values) {
    var i18n = (globalThis.OmenLib && globalThis.OmenLib.i18n) || null;
    return i18n ? i18n.t(key, lang, values) : key;
  }

  function paintLabels(lang) {
    var pairs = [
      ['title', 'options.title'],
      ['l-fee', 'options.fee_profile'],
      ['h-fee', 'options.fee_profile_hint'],
      ['l-custom', 'options.custom_pct'],
      ['l-risk', 'options.risk_pct'],
      ['l-lang', 'options.lang'],
      ['l-scalp', 'options.scalp_auto'],
      ['l-base', 'options.api_base'],
      ['l-token', 'options.token'],
      ['h-token', 'options.token_hint'],
      ['save', 'options.save']
    ];
    for (var i = 0; i < pairs.length; i += 1) {
      var node = byId(pairs[i][0]);
      if (node) { node.textContent = t(pairs[i][1], lang); }
    }
    document.title = t('options.title', lang);
  }

  function refreshFeeBanner(lang) {
    var banner = byId('fee-banner');
    var profile = byId('fee_profile').value;
    if (!banner) { return; }
    if (profile) {
      banner.hidden = true;
      banner.textContent = '';
    } else {
      banner.hidden = false;
      banner.textContent = t('options.choose_fee_profile', lang);
    }
    byId('custom-wrap').hidden = profile !== 'custom';
  }

  function load() {
    chrome.storage.local.get(DEFAULTS, function (stored) {
      var conf = stored || DEFAULTS;
      byId('fee_profile').value = conf.fee_profile || '';
      byId('custom_pct').value = conf.custom_pct === null
        || conf.custom_pct === undefined ? '' : String(conf.custom_pct);
      byId('risk_pct').value = String(conf.risk_pct === null
        || conf.risk_pct === undefined ? 1 : conf.risk_pct);
      byId('lang').value = conf.lang || 'fr';
      byId('scalp_auto').checked = conf.scalp_auto !== false;
      byId('api_base').value = conf.api_base || DEFAULTS.api_base;
      byId('token').value = conf.token || '';
      paintLabels(byId('lang').value);
      refreshFeeBanner(byId('lang').value);
    });
  }

  function numberOrNull(raw) {
    if (raw === null || raw === undefined || String(raw).trim() === '') { return null; }
    var value = Number(raw);
    return isFinite(value) ? value : null;
  }

  function save() {
    var lang = byId('lang').value || 'fr';
    var patch = {
      fee_profile: byId('fee_profile').value || '',
      custom_pct: numberOrNull(byId('custom_pct').value),
      risk_pct: numberOrNull(byId('risk_pct').value) === null
        ? 1 : numberOrNull(byId('risk_pct').value),
      lang: lang,
      scalp_auto: byId('scalp_auto').checked === true,
      api_base: String(byId('api_base').value || DEFAULTS.api_base).replace(/\/+$/, ''),
      token: String(byId('token').value || '').trim()
    };
    chrome.storage.local.set(patch, function () {
      if (chrome.runtime.lastError) {
        debug('enregistrement refusé', chrome.runtime.lastError.message);
        return;
      }
      var status = byId('status');
      if (status) {
        status.textContent = t('options.saved', lang);
        setTimeout(function () { status.textContent = ''; }, 2500);
      }
      paintLabels(lang);
      refreshFeeBanner(lang);
    });
  }

  document.addEventListener('DOMContentLoaded', function () {
    load();
    byId('save').addEventListener('click', save, false);
    byId('fee_profile').addEventListener('change', function () {
      refreshFeeBanner(byId('lang').value);
    }, false);
    byId('lang').addEventListener('change', function () {
      paintLabels(byId('lang').value);
      refreshFeeBanner(byId('lang').value);
    }, false);
  }, false);
})();
