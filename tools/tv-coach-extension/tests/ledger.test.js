"use strict";

/**
 * Tests de tools/tv-coach-extension/lib/ledger.js — module PUR (aucun DOM,
 * aucun chrome.*, aucun réseau, jamais Date.now() : tout le temps vient des
 * ts_ms passés par l'appelant).
 *
 * Convention d'API (fonctionnelle, pas orientée objet) : open() rend un
 * objet "scalp" ordinaire ; sample()/close()/serialize() le reçoivent
 * explicitement en premier argument — jamais de méthode liée dessus.
 *
 * Frais = fee_pct_per_side/100 * qty * price, une fois à l'entrée, une fois
 * à la sortie. MAE/MFE en % du prix d'entrée, même convention de signe que
 * backend/bots/paper/tradestats.py::excursions (vérifiée par lecture directe
 * du fichier) : long -> le creux vient du plus bas échantillonné, le sommet
 * du plus haut ; short -> l'inverse (une baisse est favorable). Les
 * échantillons couvrent TOUTE la vie du scalp, entrée et sortie comprises
 * (open() pousse l'entrée comme premier échantillon, close() pousse la
 * sortie comme dernier) — un scalp fermé sans aucun sample() intermédiaire
 * a donc quand même un MAE/MFE cohérent avec son résultat réel.
 */

const assert = require("node:assert/strict");
const { test } = require("node:test");
const ledger = require("../lib/ledger.js");

const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function closeTo(actual, expected, eps = 1e-9, message) {
  assert.ok(
    Math.abs(actual - expected) < eps,
    message || `attendu ~${expected}, obtenu ${actual}`
  );
}

// --------------------------------------------------------------------------- #
// open() — forme du scalp, client_id uuid v4
// --------------------------------------------------------------------------- #
test("open() rend un scalp avec un client_id uuid v4 et l'entrée comme premier échantillon", () => {
  const scalp = ledger.open({
    side: "buy",
    qty: 2,
    price: 100,
    ts_ms: 0,
    fee_profile: "kraken_spot",
    fee_pct_per_side: 0.26,
  });
  assert.match(scalp.clientId, UUID_V4_RE);
  assert.deepEqual(scalp.samples, [[0, 100]]);
});

test("deux scalps ouverts séparément ont des client_id différents", () => {
  const a = ledger.open({ side: "buy", qty: 1, price: 10, ts_ms: 0, fee_profile: "custom", fee_pct_per_side: 0.1 });
  const b = ledger.open({ side: "buy", qty: 1, price: 10, ts_ms: 0, fee_profile: "custom", fee_pct_per_side: 0.1 });
  assert.notEqual(a.clientId, b.clientId);
});

// --------------------------------------------------------------------------- #
// buy gagnant
// --------------------------------------------------------------------------- #
test("buy gagnant : pnl net, frais des deux côtés, MAE/MFE et durée corrects", () => {
  const scalp = ledger.open({
    side: "buy",
    qty: 2,
    price: 100,
    ts_ms: 0,
    fee_profile: "kraken_spot",
    fee_pct_per_side: 0.26,
  });
  ledger.sample(scalp, 30000, 101);
  ledger.sample(scalp, 60000, 99); // pire creux flottant (long) : -1%
  const result = ledger.close(scalp, 105, 90000);

  const expectedFees = (0.26 / 100) * 2 * 100 + (0.26 / 100) * 2 * 105;
  const expectedGross = (105 - 100) * 2;
  const expectedNet = expectedGross - expectedFees;
  const expectedPct = (expectedNet / (2 * 100)) * 100;

  closeTo(result.fees, expectedFees);
  closeTo(result.pnl_gross, expectedGross);
  closeTo(result.pnl_net, expectedNet);
  closeTo(result.pnl_pct, expectedPct);
  assert.equal(result.mae_pct, -1); // (99-100)/100*100
  assert.equal(result.mfe_pct, 5); // (105-100)/100*100 (le sommet est le prix de sortie)
  assert.equal(result.duration_s, 90);
  assert.deepEqual(result.samples, [
    [0, 100],
    [30000, 101],
    [60000, 99],
    [90000, 105],
  ]);
});

// --------------------------------------------------------------------------- #
// sell gagnant
// --------------------------------------------------------------------------- #
test("sell gagnant : une baisse est favorable, le sommet flottant est l'excursion adverse", () => {
  const scalp = ledger.open({
    side: "sell",
    qty: 1,
    price: 200,
    ts_ms: 1000,
    fee_profile: "custom",
    fee_pct_per_side: 0.1,
  });
  ledger.sample(scalp, 1500, 205); // monte contre le short : pire excursion
  ledger.sample(scalp, 2000, 195);
  const result = ledger.close(scalp, 190, 3000);

  const expectedFees = (0.1 / 100) * 1 * 200 + (0.1 / 100) * 1 * 190;
  const expectedGross = (190 - 200) * 1 * -1; // = 10, un short qui baisse gagne
  const expectedNet = expectedGross - expectedFees;
  const expectedPct = (expectedNet / (1 * 200)) * 100;

  closeTo(result.fees, expectedFees);
  closeTo(result.pnl_gross, expectedGross);
  closeTo(result.pnl_net, expectedNet);
  closeTo(result.pnl_pct, expectedPct);
  assert.equal(result.mae_pct, -2.5); // (200-205)/200*100
  assert.equal(result.mfe_pct, 5); // (200-190)/200*100
  assert.equal(result.duration_s, 2);
});

// --------------------------------------------------------------------------- #
// buy perdant, MAE/MFE choisis à la main (ni l'entrée ni la sortie)
// --------------------------------------------------------------------------- #
test("buy perdant : MAE/MFE viennent d'échantillons intermédiaires, distincts de l'entrée et de la sortie", () => {
  const scalp = ledger.open({
    side: "buy",
    qty: 5,
    price: 50,
    ts_ms: 0,
    fee_profile: "custom",
    fee_pct_per_side: 0.5,
  });
  ledger.sample(scalp, 10000, 53); // meilleur sommet flottant (MFE)
  ledger.sample(scalp, 20000, 47); // pire creux flottant (MAE)
  ledger.sample(scalp, 30000, 49);
  const result = ledger.close(scalp, 48, 40000);

  const expectedFees = (0.5 / 100) * 5 * 50 + (0.5 / 100) * 5 * 48;
  const expectedGross = (48 - 50) * 5;
  const expectedNet = expectedGross - expectedFees;
  const expectedPct = (expectedNet / (5 * 50)) * 100;

  closeTo(result.fees, expectedFees);
  closeTo(expectedFees, 2.45);
  closeTo(result.pnl_gross, expectedGross);
  closeTo(result.pnl_gross, -10);
  closeTo(result.pnl_net, expectedNet);
  closeTo(result.pnl_net, -12.45);
  closeTo(result.pnl_pct, expectedPct);
  closeTo(result.pnl_pct, -4.98);
  assert.equal(result.mae_pct, -6); // (47-50)/50*100, PAS l'entrée ni la sortie
  assert.equal(result.mfe_pct, 6); // (53-50)/50*100
  assert.equal(result.duration_s, 40);
});

// --------------------------------------------------------------------------- #
// Décimation 900 -> 600, premier et dernier conservés, ordre croissant
// --------------------------------------------------------------------------- #
test("serialize() décime 900 échantillons à 600, conserve le premier et le dernier, ordre croissant", () => {
  const scalp = ledger.open({
    side: "buy",
    qty: 1,
    price: 100,
    ts_ms: 0,
    fee_profile: "tv_paper",
    fee_pct_per_side: 0,
  });
  for (let i = 1; i <= 898; i++) {
    ledger.sample(scalp, i * 1000, 100 + i);
  }
  ledger.close(scalp, 999, 899000); // 900e échantillon (entrée + 898 + sortie)
  assert.equal(scalp.samples.length, 900);

  const payload = ledger.serialize(scalp);
  assert.ok(payload.samples.length <= 600);
  assert.equal(payload.samples.length, 600);

  assert.deepEqual(payload.samples[0], [new Date(0).toISOString(), 100]);
  assert.deepEqual(payload.samples[payload.samples.length - 1], [
    new Date(899000).toISOString(),
    999,
  ]);

  for (let i = 1; i < payload.samples.length; i++) {
    const previousTs = new Date(payload.samples[i - 1][0]).getTime();
    const currentTs = new Date(payload.samples[i][0]).getTime();
    assert.ok(currentTs > previousTs, `ordre croissant attendu à l'index ${i}`);
  }
});

test("serialize() garde tous les échantillons quand il y en a déjà <= 600", () => {
  const scalp = ledger.open({ side: "buy", qty: 1, price: 10, ts_ms: 0, fee_profile: "custom", fee_pct_per_side: 0 });
  ledger.sample(scalp, 1000, 11);
  ledger.close(scalp, 12, 2000);
  const payload = ledger.serialize(scalp);
  assert.equal(payload.samples.length, 3);
});

// --------------------------------------------------------------------------- #
// serialize() — conformité au contrat POST /scalps
// --------------------------------------------------------------------------- #
test("serialize() rend exactement le contrat attendu par POST /scalps", () => {
  const scalp = ledger.open({
    side: "buy",
    qty: 2,
    price: 100,
    ts_ms: 0,
    fee_profile: "kraken_spot",
    fee_pct_per_side: 0.26,
  });
  ledger.sample(scalp, 30000, 101);
  ledger.close(scalp, 105, 90000);

  const payload = ledger.serialize(scalp);

  assert.match(payload.client_id, UUID_V4_RE);
  assert.equal(payload.client_id, scalp.clientId);
  assert.equal(payload.side, "buy");
  assert.equal(payload.qty, 2);
  assert.equal(payload.fee_profile, "kraken_spot");

  assert.equal(payload.entry.price, 100);
  assert.equal(payload.entry.ts, new Date(0).toISOString());
  assert.equal(payload.exit.price, 105);
  assert.equal(payload.exit.ts, new Date(90000).toISOString());

  assert.ok(Array.isArray(payload.samples));
  for (const [ts, price] of payload.samples) {
    assert.equal(typeof ts, "string");
    assert.ok(!Number.isNaN(new Date(ts).getTime()));
    assert.equal(typeof price, "number");
  }

  // Contrat EXACT : rien de plus (le symbole/note/émotion sont ajoutés par
  // content.js, ledger.js ne connaît pas le titre tradé).
  assert.deepEqual(Object.keys(payload).sort(), [
    "client_id",
    "entry",
    "exit",
    "fee_profile",
    "qty",
    "samples",
    "side",
  ]);
});
