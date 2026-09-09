"use strict";

/**
 * Tests de tools/tv-coach-extension/lib/guards.js — module PUR (aucun DOM,
 * aucun chrome.*, aucun réseau, jamais Date.now() : tout le temps vient de
 * state.now_ms).
 *
 * Chaque test construit un état "sûr" (aucun garde-fou ne se déclenche) puis
 * modifie EXACTEMENT le ou les champs nécessaires pour isoler le code testé —
 * de sorte qu'un test qui casse pointe sans ambiguïté vers la règle en cause.
 */

const assert = require("node:assert/strict");
const { test } = require("node:test");
const guards = require("../lib/guards.js");

const MIN = 60000;
const NOW = 1_700_000_000_000; // ancre arbitraire, sans rapport avec Date.now()

/**
 * État qui ne déclenche AUCUN garde-fou :
 * - fee_round_trip_pct=0.02% -> exigé = 3*0.02 = 0.06% ; atr1=15 sur
 *   price=50000 -> mouvement attendu = 15*3/50000*100 = 0.09% >= 0.06%
 *   (fee_coverage ne se déclenche pas) ;
 * - atr1 == atr1_median (15==15) -> pas de vol_spike ;
 * - spread == spread_median (0.05==0.05) -> pas de spread_wide ;
 * - calendar/scalps_today vides, next_funding_ms/last_news_ms absents.
 */
function safeState(overrides) {
  const base = {
    now_ms: NOW,
    calendar: [],
    next_funding_ms: null,
    last_news_ms: null,
    atr1: 15,
    atr1_median: 15,
    spread: 0.05,
    spread_median: 0.05,
    fee_round_trip_pct: 0.02,
    price: 50000,
    scalps_today: [],
    equity_chf: 10000,
    is_perp: false,
  };
  return Object.assign(base, overrides);
}

function codesOf(results) {
  return results.map((r) => r.code).sort();
}

// --------------------------------------------------------------------------- #
// Tout vert
// --------------------------------------------------------------------------- #
test("un état sûr ne déclenche aucun garde-fou", () => {
  assert.deepEqual(guards.evaluate(safeState()), []);
});

// --------------------------------------------------------------------------- #
// Un cas par code (9)
// --------------------------------------------------------------------------- #
test("event_risk (rouge) : événement d'importance >= 1 dans la fenêtre autour de now", () => {
  const state = safeState({
    calendar: [{ ts_ms: NOW + 10 * MIN, importance: 1 }],
  });
  const results = guards.evaluate(state);
  assert.deepEqual(codesOf(results), ["event_risk"]);
  assert.equal(results[0].level, "red");
});

test("event_risk ne se déclenche pas hors fenêtre (importance basse ou trop loin dans le temps)", () => {
  const tooFar = safeState({ calendar: [{ ts_ms: NOW + 60 * MIN, importance: 1 }] });
  assert.deepEqual(guards.evaluate(tooFar), []);

  const tooLowImportance = safeState({ calendar: [{ ts_ms: NOW + 1 * MIN, importance: 0 }] });
  assert.deepEqual(guards.evaluate(tooLowImportance), []);
});

test("funding_soon (ambre) : perp dont le funding tombe dans moins de 5 minutes", () => {
  const state = safeState({ is_perp: true, next_funding_ms: NOW + 3 * MIN });
  const results = guards.evaluate(state);
  assert.deepEqual(codesOf(results), ["funding_soon"]);
  assert.equal(results[0].level, "amber");
});

test("funding_soon ignore un funding lointain ou un titre qui n'est pas un perp", () => {
  const farFunding = safeState({ is_perp: true, next_funding_ms: NOW + 30 * MIN });
  assert.deepEqual(guards.evaluate(farFunding), []);

  const notPerp = safeState({ is_perp: false, next_funding_ms: NOW + 1 * MIN });
  assert.deepEqual(guards.evaluate(notPerp), []);
});

test("flash_news (ambre) : news publiée depuis moins de 2 minutes", () => {
  const state = safeState({ last_news_ms: NOW - 1 * MIN });
  const results = guards.evaluate(state);
  assert.deepEqual(codesOf(results), ["flash_news"]);
  assert.equal(results[0].level, "amber");
});

test("vol_spike (ambre) : ATR(1 min) > 2x sa médiane 4h", () => {
  const state = safeState({ atr1: 40, atr1_median: 15 }); // 40 > 2*15=30
  const results = guards.evaluate(state);
  assert.deepEqual(codesOf(results), ["vol_spike"]);
  assert.equal(results[0].level, "amber");
});

test("spread_wide (ambre) : spread > 2x sa médiane de session", () => {
  const state = safeState({ spread: 0.2, spread_median: 0.05 }); // 0.2 > 2*0.05=0.1
  const results = guards.evaluate(state);
  assert.deepEqual(codesOf(results), ["spread_wide"]);
  assert.equal(results[0].level, "amber");
});

test("fee_coverage (rouge) : mouvement attendu (ATR*3/price) sous 3x les frais A/R, values.required_pct = 3*fee_round_trip_pct", () => {
  const state = safeState({ fee_round_trip_pct: 1.0 }); // requis = 3.0% ; attendu = 15*3/50000*100 = 0.09%
  const results = guards.evaluate(state);
  assert.deepEqual(codesOf(results), ["fee_coverage"]);
  assert.equal(results[0].level, "red");
  assert.equal(results[0].values.required_pct, 3.0);
});

test("cooldown (ambre) : dernier scalp perdant fermé il y a moins de 10 minutes", () => {
  const state = safeState({
    scalps_today: [{ closed_ms: NOW - 4 * MIN, pnl_chf: -20 }],
  });
  const results = guards.evaluate(state);
  assert.deepEqual(codesOf(results), ["cooldown"]);
  assert.equal(results[0].level, "amber");
});

test("cooldown ignore un scalp perdant fermé il y a plus de 10 minutes", () => {
  const state = safeState({
    scalps_today: [{ closed_ms: NOW - 20 * MIN, pnl_chf: -20 }],
  });
  assert.deepEqual(guards.evaluate(state), []);
});

test("pace (ambre) : plus de 6 scalps fermés dans la dernière heure", () => {
  const scalps_today = [];
  for (let i = 0; i < 7; i++) {
    scalps_today.push({ closed_ms: NOW - (5 + i * 7) * MIN, pnl_chf: 5 });
  }
  const state = safeState({ scalps_today });
  const results = guards.evaluate(state);
  assert.deepEqual(codesOf(results), ["pace"]);
  assert.equal(results[0].level, "amber");
});

test("pace ne se déclenche pas à exactement 6 scalps dans l'heure", () => {
  const scalps_today = [];
  for (let i = 0; i < 6; i++) {
    scalps_today.push({ closed_ms: NOW - (5 + i * 8) * MIN, pnl_chf: 5 });
  }
  const state = safeState({ scalps_today });
  assert.deepEqual(guards.evaluate(state), []);
});

test("daily_loss (rouge) : P&L réalisé du jour <= -2% de l'équité", () => {
  const state = safeState({
    scalps_today: [{ closed_ms: NOW - 30 * MIN, pnl_chf: -250 }], // -2.5% de 10000
    equity_chf: 10000,
  });
  const results = guards.evaluate(state);
  assert.deepEqual(codesOf(results), ["daily_loss"]);
  assert.equal(results[0].level, "red");
});

test("daily_loss ignore une perte du jour sous le seuil de -2%", () => {
  const state = safeState({
    scalps_today: [{ closed_ms: NOW - 30 * MIN, pnl_chf: -100 }], // -1% de 10000
    equity_chf: 10000,
  });
  assert.deepEqual(guards.evaluate(state), []);
});

// --------------------------------------------------------------------------- #
// Champs manquants -> règle ignorée, jamais d'exception
// --------------------------------------------------------------------------- #
test("un état vide ne lève jamais et ne déclenche rien", () => {
  assert.doesNotThrow(() => guards.evaluate({}));
  assert.deepEqual(guards.evaluate({}), []);
});

test("guards.evaluate() sans aucun argument ne lève pas", () => {
  assert.doesNotThrow(() => guards.evaluate());
});

test("des champs manquants un par un désarment chaque règle sans lever d'exception", () => {
  const fields = [
    "now_ms",
    "calendar",
    "atr1",
    "atr1_median",
    "spread",
    "spread_median",
    "fee_round_trip_pct",
    "price",
    "scalps_today",
    "equity_chf",
  ];
  for (const field of fields) {
    const state = safeState({
      // on pousse chaque garde-fou pertinent au bord du déclenchement, puis
      // on efface un champ à la fois : jamais d'exception, et le résultat
      // reste un tableau.
      calendar: [{ ts_ms: NOW + 1 * MIN, importance: 1 }],
      is_perp: true,
      next_funding_ms: NOW + 1 * MIN,
      last_news_ms: NOW - 1 * MIN,
      atr1: 999,
      scalps_today: [{ closed_ms: NOW - 1 * MIN, pnl_chf: -9999 }],
    });
    delete state[field];
    let results;
    assert.doesNotThrow(() => {
      results = guards.evaluate(state);
    });
    assert.ok(Array.isArray(results));
  }
});

test("un item du calendrier ou des scalps mal formé est ignoré sans lever", () => {
  const state = safeState({
    calendar: [null, "nope", 42, { ts_ms: "pas un nombre", importance: 1 }],
    scalps_today: [null, "nope", { closed_ms: "pas un nombre", pnl_chf: -50 }],
  });
  assert.doesNotThrow(() => guards.evaluate(state));
  assert.deepEqual(guards.evaluate(state), []);
});

// --------------------------------------------------------------------------- #
// Plusieurs codes en même temps
// --------------------------------------------------------------------------- #
test("un état peut déclencher plusieurs codes indépendants à la fois (vol_spike + spread_wide + fee_coverage)", () => {
  const state = safeState({
    atr1: 40, // > 2*15=30 -> vol_spike
    atr1_median: 15,
    spread: 0.2, // > 2*0.05=0.1 -> spread_wide
    spread_median: 0.05,
    fee_round_trip_pct: 1.0, // requis 3.0% ; attendu = 40*3/50000*100 = 0.24% -> fee_coverage
  });
  const results = guards.evaluate(state);
  assert.deepEqual(codesOf(results), ["fee_coverage", "spread_wide", "vol_spike"]);
});

// --------------------------------------------------------------------------- #
// Seuils par défaut exposés (DEFAULTS)
// --------------------------------------------------------------------------- #
test("DEFAULTS est exporté et evaluate() l'utilise implicitement", () => {
  assert.ok(guards.DEFAULTS);
  const state = safeState({ atr1: 40, atr1_median: 15 });
  const withDefaults = guards.evaluate(state);
  const withExplicitDefaults = guards.evaluate(state, guards.DEFAULTS);
  assert.deepEqual(codesOf(withDefaults), codesOf(withExplicitDefaults));
});

test("des seuils personnalisés remplacent DEFAULTS", () => {
  const state = safeState({ atr1: 20, atr1_median: 15 }); // 20 < 2*15=30 -> pas de vol_spike par défaut
  assert.deepEqual(guards.evaluate(state), []);

  const looseThresholds = Object.assign({}, guards.DEFAULTS, { vol_spike_mult: 1.1 });
  const results = guards.evaluate(state, looseThresholds); // 20 > 1.1*15=16.5 -> se déclenche
  assert.deepEqual(codesOf(results), ["vol_spike"]);
});
