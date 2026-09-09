/**
 * Ledger du mode scalp — PUR (aucun DOM, aucun `chrome.*`, aucun réseau,
 * jamais `Date.now()`) : tout le temps vient des `ts_ms` fournis par
 * l'appelant (content.js, au tick live).
 *
 * API fonctionnelle, pas orientée objet : `open()` rend un objet "scalp"
 * ordinaire ; `sample()`, `close()`, `serialize()` le reçoivent explicitement
 * en premier argument plutôt que d'appeler une méthode liée dessus — plus
 * facile à tester, rien de caché dans une closure.
 *
 * Échantillons (`scalp.samples`, `[ts_ms, price]`) : `open()` y pousse le
 * prix d'entrée, `sample()` chaque tick intermédiaire (1 Hz côté extension),
 * `close()` le prix de sortie. C'est la MÊME liste qui sert au calcul du
 * MAE/MFE et, décimée, à `serialize()` — un scalp fermé sans aucun
 * `sample()` intermédiaire garde donc un MAE/MFE cohérent avec son résultat
 * réel (l'entrée et la sortie comptent toujours comme des points de la vie
 * du trade).
 *
 * Frais : `fee_pct_per_side/100 * qty * price`, une fois à l'entrée, une
 * fois à la sortie (au prix RÉEL de chaque côté, pas deux fois le même) —
 * c'est une estimation locale pour l'affichage immédiat ; le serveur
 * recalcule tout depuis `fee_profile` seul à la réception de `serialize()`.
 *
 * MAE/MFE : même convention de signe que
 * `backend/bots/paper/tradestats.py::excursions` (vérifiée par lecture
 * directe du fichier) — `mae_pct` est TOUJOURS <= 0 (pire excursion contre
 * la position, en % du prix d'entrée), `mfe_pct` TOUJOURS >= 0 (meilleure
 * excursion en faveur). Long : le creux vient du plus bas échantillonné, le
 * sommet du plus haut. Short (`side: "sell"`) : l'inverse, une baisse est
 * favorable.
 *
 * `serialize()` : contrat EXACT de `POST /api/paper/scalps` tel que confié à
 * cet agent (plan §1.5) — `client_id` (uuid v4, généré à `open()`), `side`,
 * `qty`, `entry`/`exit` en `{price, ts}` ISO, `samples` décimés à <= 600 par
 * pas régulier (le premier et le dernier sont TOUJOURS conservés), et
 * `fee_profile`. Le symbole tradé, la note et l'émotion ne font PAS partie
 * de ce contrat : ledger.js ne connaît pas le titre affiché dans
 * TradingView, c'est à content.js de les fusionner avant l'envoi réel.
 */
(function (root) {
  "use strict";

  var MAX_SERIALIZED_SAMPLES = 600;

  function isFiniteNumber(value) {
    return typeof value === "number" && Number.isFinite(value);
  }

  /** uuid v4 — corrélation client uniquement (jamais un secret), Math.random
   * suffit : pas de dépendance crypto pour un identifiant de scalp local. */
  function uuidV4() {
    var bytes = new Array(16);
    for (var i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
    bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
    bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant 10xx

    var hex = bytes.map(function (b) {
      return ("0" + b.toString(16)).slice(-2);
    });
    return (
      hex.slice(0, 4).join("") +
      "-" +
      hex.slice(4, 6).join("") +
      "-" +
      hex.slice(6, 8).join("") +
      "-" +
      hex.slice(8, 10).join("") +
      "-" +
      hex.slice(10, 16).join("")
    );
  }

  function open(order) {
    order = order || {};
    var side = order.side === "sell" ? "sell" : "buy";
    return {
      clientId: uuidV4(),
      side: side,
      qty: order.qty,
      entryPrice: order.price,
      entryTs: order.ts_ms,
      feeProfile: order.fee_profile,
      feePctPerSide: order.fee_pct_per_side,
      samples: [[order.ts_ms, order.price]],
      closed: false,
      exitPrice: null,
      exitTs: null,
    };
  }

  function sample(scalp, ts_ms, price) {
    if (!scalp || scalp.closed) return;
    if (!isFiniteNumber(ts_ms) || !isFiniteNumber(price)) return;
    scalp.samples.push([ts_ms, price]);
  }

  /** Excursions en % du prix d'entrée sur TOUTE la liste de prix
   * échantillonnés (entrée et sortie comprises). Même convention de signe
   * que tradestats.py::excursions : mae_pct <= 0, mfe_pct >= 0. */
  function excursions(prices, entryPrice, side) {
    var highest = Math.max.apply(null, prices);
    var lowest = Math.min.apply(null, prices);

    var maeRaw;
    var mfeRaw;
    if (side === "sell") {
      maeRaw = ((entryPrice - highest) / entryPrice) * 100;
      mfeRaw = ((entryPrice - lowest) / entryPrice) * 100;
    } else {
      maeRaw = ((lowest - entryPrice) / entryPrice) * 100;
      mfeRaw = ((highest - entryPrice) / entryPrice) * 100;
    }
    return { mae_pct: Math.min(maeRaw, 0), mfe_pct: Math.max(mfeRaw, 0) };
  }

  function close(scalp, price, ts_ms) {
    scalp.exitPrice = price;
    scalp.exitTs = ts_ms;
    scalp.closed = true;
    scalp.samples.push([ts_ms, price]);

    var qty = scalp.qty;
    var entryPrice = scalp.entryPrice;
    var sign = scalp.side === "sell" ? -1 : 1;
    var feeRate = scalp.feePctPerSide / 100;

    var fees = feeRate * qty * entryPrice + feeRate * qty * price;
    var pnlGross = (price - entryPrice) * qty * sign;
    var pnlNet = pnlGross - fees;
    var pnlPct = (pnlNet / (qty * entryPrice)) * 100;
    var durationS = (ts_ms - scalp.entryTs) / 1000;

    var prices = scalp.samples.map(function (pair) {
      return pair[1];
    });
    var exc = excursions(prices, entryPrice, scalp.side);

    return {
      pnl_gross: pnlGross,
      fees: fees,
      pnl_net: pnlNet,
      pnl_pct: pnlPct,
      mae_pct: exc.mae_pct,
      mfe_pct: exc.mfe_pct,
      duration_s: durationS,
      samples: scalp.samples.slice(),
    };
  }

  /** Décimation régulière par index à <= maxLen points : conserve TOUJOURS
   * le premier et le dernier échantillon, répartit le reste à pas constant.
   * En dessous de maxLen, rend la liste telle quelle (copie). */
  function decimate(list, maxLen) {
    if (list.length <= maxLen) return list.slice();
    var lastIndex = list.length - 1;
    var out = [];
    for (var i = 0; i < maxLen; i++) {
      var idx = Math.round((i * lastIndex) / (maxLen - 1));
      out.push(list[idx]);
    }
    return out;
  }

  function isoOf(ts_ms) {
    return new Date(ts_ms).toISOString();
  }

  function serialize(scalp) {
    var decimated = decimate(scalp.samples, MAX_SERIALIZED_SAMPLES);
    var samples = decimated.map(function (pair) {
      return [isoOf(pair[0]), pair[1]];
    });

    return {
      client_id: scalp.clientId,
      side: scalp.side,
      qty: scalp.qty,
      entry: { price: scalp.entryPrice, ts: isoOf(scalp.entryTs) },
      exit: { price: scalp.exitPrice, ts: isoOf(scalp.exitTs) },
      samples: samples,
      fee_profile: scalp.feeProfile,
    };
  }

  var api = { open: open, sample: sample, close: close, serialize: serialize };
  root.OmenLib = root.OmenLib || {};
  root.OmenLib.ledger = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
