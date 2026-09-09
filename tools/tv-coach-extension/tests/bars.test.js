"use strict";

/**
 * Tests de tools/tv-coach-extension/lib/bars.js — module PUR (aucun DOM,
 * aucun chrome.*, aucun réseau, jamais Date.now()).
 *
 * Convention : chaque bougie est construite à coups de push(ts_ms, price)
 * puisque bars.js n'accepte pas de bougies déjà faites — c'est le module qui
 * les fabrique tick par tick, exactement comme content.js l'alimentera à
 * 1 Hz sur le prix live TradingView.
 *
 * Choix documenté (voir aussi le rapport final de l'agent) : une bougie ne se
 * ferme JAMAIS sur un minuteur — elle se ferme quand le PREMIER tick de la
 * minute suivante arrive. Conséquence directe : la dernière minute nourrie
 * reste toujours ouverte et n'apparaît jamais dans bars(). Une séquence de
 * ticks qui couvre 30 minutes distinctes (0..29) ne ferme donc que les
 * minutes 0..28, soit 29 bougies fermées — c'est le cas testé ci-dessous.
 */

const assert = require("node:assert/strict");
const { test } = require("node:test");
const { createBars } = require("../lib/bars.js");

const MIN = 60000;
const DAY = 86400000;

/** Nourrit une minute entière avec une série de prix répartis à intervalles
 * réguliers à l'intérieur de la minute [minuteIndex*MIN, minuteIndex*MIN+MIN). */
function feedMinute(bars, minuteIndex, prices, originMs = 0) {
  const start = originMs + minuteIndex * MIN;
  const step = Math.floor(MIN / prices.length);
  prices.forEach((price, i) => bars.push(start + i * step, price));
}

const FLAT = [101, 102, 100, 101]; // O=101 H=102 L=100 C=101 (range 2, sans gap)
const GAP = [109, 110, 108, 109]; // O=109 H=110 L=108 C=109

/**
 * Fixture calquée sur backend/bots/tests/test_paper_ta.py
 * (test_atr14_applies_wilder_smoothing_after_the_seed) : 15 bougies plates
 * (range 2, aucun gap) -> amorce ATR = 2.0 ; puis une bougie qui OUVRE loin
 * (gap) -> TR = 9 -> Wilder (2.0*13+9)/14 = 2.5 ; puis une bougie calme au
 * nouveau niveau -> TR = 2 -> Wilder (2.5*13+2)/14 = 34.5/14 ≈ 2.4642857143.
 * Les mêmes valeurs sont déjà vérifiées côté Python contre une implémentation
 * indépendante : les retrouver ici valide l'algorithme de Wilder en JS.
 */
function buildWilderFixture() {
  const bars = createBars();
  for (let m = 0; m <= 14; m++) feedMinute(bars, m, FLAT); // minutes 0..14 (15 bougies plates)
  feedMinute(bars, 15, GAP); // minute 15 : gap (ferme aussi la bougie 14)
  feedMinute(bars, 16, GAP); // minute 16 : calme au nouveau niveau (ferme la 15)
  bars.push(17 * MIN, 999); // un seul tick minute 17 : ferme la bougie 16
  return bars;
}

// --------------------------------------------------------------------------- #
// Bougies 1 minute — fermeture, ordre, forme
// --------------------------------------------------------------------------- #
test("30 minutes de ticks (plusieurs par minute) ferment 29 bougies, la 30e minute reste ouverte", () => {
  const bars = createBars();
  for (let m = 0; m < 30; m++) {
    feedMinute(bars, m, [100 + m, 102 + m, 99 + m, 101 + m]);
  }
  const closed = bars.bars();
  assert.equal(closed.length, 29);

  assert.deepEqual(closed[0], { t: 0, o: 100, h: 102, l: 99, c: 101 });
  assert.deepEqual(closed[28], { t: 28 * MIN, o: 128, h: 130, l: 127, c: 129 });

  for (let i = 1; i < closed.length; i++) {
    assert.equal(closed[i].t - closed[i - 1].t, MIN);
  }
});

test("une bougie se ferme dès qu'un tick de la minute suivante arrive", () => {
  const bars = createBars();
  for (let m = 0; m < 30; m++) {
    feedMinute(bars, m, [100 + m, 102 + m, 99 + m, 101 + m]);
  }
  assert.equal(bars.bars().length, 29);

  bars.push(30 * MIN, 999); // un seul tick minute 30 -> ferme la bougie 29
  const closed = bars.bars();
  assert.equal(closed.length, 30);
  assert.deepEqual(closed[29], { t: 29 * MIN, o: 129, h: 131, l: 128, c: 130 });
});

// --------------------------------------------------------------------------- #
// ATR de Wilder — calculé à la main, valeurs croisées avec ta.atr14 (Python)
// --------------------------------------------------------------------------- #
test("atr(14) est null en dessous de 15 bougies fermées, défini à partir de 15", () => {
  const below = createBars();
  for (let m = 0; m <= 14; m++) feedMinute(below, m, FLAT); // 15 appels -> 14 bougies fermées
  assert.equal(below.bars().length, 14);
  assert.equal(below.atr(14), null);

  const atMinimum = createBars();
  for (let m = 0; m <= 15; m++) feedMinute(atMinimum, m, FLAT); // 16 appels -> 15 bougies fermées
  assert.equal(atMinimum.bars().length, 15);
  assert.notEqual(atMinimum.atr(14), null);
});

test("atr(14) sur 15 bougies plates (aucun gap) = amorce = le range constant, 2.0", () => {
  const bars = createBars();
  for (let m = 0; m <= 15; m++) feedMinute(bars, m, FLAT); // 15 bougies fermées
  assert.equal(bars.bars().length, 15);
  assert.equal(bars.atr(14), 2.0);
});

test("atr(14) intègre le gap contre la clôture précédente : Wilder (2.0*13+9)/14 = 2.5", () => {
  const bars = createBars();
  for (let m = 0; m <= 14; m++) feedMinute(bars, m, FLAT); // amorce (15 bougies)
  feedMinute(bars, 15, GAP); // ferme la 15e bougie (plate), ouvre le gap
  bars.push(16 * MIN, 999); // ferme la bougie gap
  assert.equal(bars.bars().length, 16);
  assert.equal(bars.atr(14), 2.5);
});

test("atr(14) applique un second palier de lissage de Wilder : 34.5/14 ≈ 2.4642857143", () => {
  const bars = buildWilderFixture();
  assert.equal(bars.bars().length, 17);
  const atr = bars.atr(14);
  assert.ok(Math.abs(atr - 34.5 / 14) < 1e-9, `atr=${atr}`);
});

// --------------------------------------------------------------------------- #
// medianAtr — médiane des ATR(14) glissants sur la fenêtre
// --------------------------------------------------------------------------- #
test("medianAtr(4) est la médiane des trois ATR(14) glissants [2.0, 2.5, 2.4642857143]", () => {
  const bars = buildWilderFixture();
  // Rolling ATR aux bougies d'indices 14, 15, 16 (les seules avec >= 15
  // bougies d'historique) : 2.0, 2.5, 34.5/14. Triés : [2.0, 34.5/14, 2.5] ->
  // médiane = 34.5/14 (élément du milieu, la fenêtre de 4h couvre tout
  // puisque la fixture ne dure que 17 minutes).
  const median = bars.medianAtr(4);
  assert.ok(Math.abs(median - 34.5 / 14) < 1e-9, `median=${median}`);
});

test("medianAtr(hours) restreint la fenêtre : une fenêtre étroite n'inclut que le dernier ATR glissant", () => {
  const bars = buildWilderFixture();
  // lastTs = 17*MIN = 1 020 000 ms. On choisit une fenêtre de 90 000 ms
  // (0.025 h) : windowStart = 930 000 ms, strictement entre la bougie 15
  // (t=900 000) et la bougie 16 (t=960 000). Seule la bougie 16 qualifie ->
  // médiane = son propre ATR glissant, 34.5/14.
  const hours = 90000 / 3600000;
  const median = bars.medianAtr(hours);
  assert.ok(Math.abs(median - 34.5 / 14) < 1e-9, `median=${median}`);
});

test("medianAtr(4) est null tant qu'aucun ATR glissant n'est calculable", () => {
  const bars = createBars();
  for (let m = 0; m <= 10; m++) feedMinute(bars, m, FLAT); // seulement 10 bougies fermées
  assert.equal(bars.medianAtr(4), null);
});

// --------------------------------------------------------------------------- #
// dayHigh / dayLow — échantillons du jour UTC courant, remis à zéro au
// changement de jour
// --------------------------------------------------------------------------- #
test("dayHigh/dayLow suivent les échantillons bruts (pas seulement les bougies fermées) du jour UTC courant", () => {
  const bars = createBars();
  assert.equal(bars.dayHigh(), null);
  assert.equal(bars.dayLow(), null);

  bars.push(0, 100);
  bars.push(1000, 105);
  bars.push(2000, 95);
  assert.equal(bars.dayHigh(), 105);
  assert.equal(bars.dayLow(), 95);
});

test("un changement de jour UTC remet dayHigh/dayLow à zéro", () => {
  const bars = createBars();
  bars.push(0, 100);
  bars.push(1000, 105);
  bars.push(2000, 95);
  assert.equal(bars.dayHigh(), 105);
  assert.equal(bars.dayLow(), 95);

  bars.push(DAY, 50); // premier échantillon du jour UTC suivant
  assert.equal(bars.dayHigh(), 50);
  assert.equal(bars.dayLow(), 50);

  bars.push(DAY + 500, 70);
  bars.push(DAY + 800, 40);
  assert.equal(bars.dayHigh(), 70);
  assert.equal(bars.dayLow(), 40);
});

// --------------------------------------------------------------------------- #
// Spread — dernier et médiane sur les 200 derniers
// --------------------------------------------------------------------------- #
test("spread()/medianSpread() lisent le dernier spread % du mid et sa médiane", () => {
  const bars = createBars();
  assert.equal(bars.spread(), null);
  assert.equal(bars.medianSpread(), null);

  bars.pushSpread(99.75, 100.25); // mid=100, spread=0.5 -> 0.5%
  bars.pushSpread(99.5, 100.5); // mid=100, spread=1 -> 1%
  bars.pushSpread(99.0, 101.0); // mid=100, spread=2 -> 2%

  assert.equal(bars.spread(), 2);
  assert.equal(bars.medianSpread(), 1);
});

test("medianSpread() ne regarde que les 200 derniers échantillons", () => {
  const bars = createBars();
  for (let k = 1; k <= 250; k++) {
    bars.pushSpread(100 - 0.5 * k, 100 + 0.5 * k); // spread% = k exactement
  }
  assert.equal(bars.spread(), 250);
  // Les 200 derniers sont k=51..250 ; médiane de 200 valeurs paires ->
  // moyenne des deux valeurs centrales (150 et 151) = 150.5.
  assert.equal(bars.medianSpread(), 150.5);
});

// --------------------------------------------------------------------------- #
// vwap — documenté : sans volume, la vraie valeur vient du serveur
// --------------------------------------------------------------------------- #
test("vwap() rend toujours null (le VWAP réel vient de brief.ta.vwap côté serveur)", () => {
  const bars = createBars();
  bars.push(0, 100);
  bars.push(1000, 110);
  assert.equal(bars.vwap(), null);
});
