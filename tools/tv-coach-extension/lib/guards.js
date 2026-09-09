/**
 * Garde-fous du mode scalp — spec `2026-09-09-tv-coach-extension-design.md`
 * §6.3. PUR et DÉTERMINISTE : aucun DOM, aucun `chrome.*`, aucun réseau,
 * jamais `Date.now()` — tout le temps vient de `state.now_ms`, fourni par
 * l'appelant (content.js, alimenté par bridge.js et bars.js).
 *
 * `evaluate(state, thresholds = DEFAULTS)` ne lève JAMAIS : un champ de
 * `state` absent (`null`/`undefined`) ou mal formé désarme SEULEMENT la
 * règle qui en dépend, les autres continuent d'être évaluées normalement.
 * Rien ne bloque un ordre — l'extension affiche, l'humain décide.
 *
 * Fenêtre `event_risk` : [now - event_before_ms, now + event_after_ms],
 * c'est-à-dire un événement qui s'est produit il y a moins de 5 minutes OU
 * qui tombe dans moins de 15 minutes (seuils par défaut). Point à vérifier
 * auprès de Massii/Fable : la prose de la spec §6.3 dit littéralement
 * « 15 min avant ou 5 min après », soit la fenêtre inverse — la mission
 * confiée à cet agent donne explicitement [now-5min, now+15min] comme
 * valeur EXACTE à respecter à la lettre, et c'est aussi la convention usuelle
 * (flat quelques minutes avant une publication connue, prudence plus longue
 * après le choc de volatilité). DEFAULTS ci-dessous suit cette seconde
 * lecture ; à confirmer, cf. rapport final de l'agent.
 */
(function (root) {
  "use strict";

  var DEFAULTS = {
    event_before_ms: 5 * 60 * 1000,
    event_after_ms: 15 * 60 * 1000,
    event_min_importance: 1,
    funding_soon_ms: 5 * 60 * 1000,
    flash_news_ms: 2 * 60 * 1000,
    vol_spike_mult: 2,
    spread_wide_mult: 2,
    fee_coverage_mult: 3,
    cooldown_ms: 10 * 60 * 1000,
    pace_window_ms: 60 * 60 * 1000,
    pace_max: 6,
    daily_loss_pct: 2,
  };

  function isNum(value) {
    return typeof value === "number" && Number.isFinite(value);
  }

  function isArr(value) {
    return Array.isArray(value);
  }

  /** Entrée calendrier valide : {ts_ms: number, importance: number}. */
  function validCalendarItem(item) {
    return item && typeof item === "object" && isNum(item.ts_ms) && isNum(item.importance);
  }

  /** Scalp du jour valide : {closed_ms: number, pnl_chf: number}. Un item
   * dont l'un des deux champs est illisible est écarté PARTOUT (cooldown,
   * pace, daily_loss) plutôt que d'être exploité pour un seul de ses champs —
   * un scalp mal formé n'inspire pas confiance à moitié. */
  function validScalpItem(item) {
    return item && typeof item === "object" && isNum(item.closed_ms) && isNum(item.pnl_chf);
  }

  function evaluate(state, thresholds) {
    state = state || {};
    thresholds = thresholds || DEFAULTS;
    var out = [];
    var now = state.now_ms;

    // event_risk — rouge
    if (isNum(now) && isArr(state.calendar)) {
      var lo = now - thresholds.event_before_ms;
      var hi = now + thresholds.event_after_ms;
      var hit = null;
      for (var i = 0; i < state.calendar.length; i++) {
        var ev = state.calendar[i];
        if (!validCalendarItem(ev)) continue;
        if (ev.importance >= thresholds.event_min_importance && ev.ts_ms >= lo && ev.ts_ms <= hi) {
          hit = ev;
          break;
        }
      }
      if (hit) {
        out.push({
          code: "event_risk",
          level: "red",
          values: { ts_ms: hit.ts_ms, importance: hit.importance, window_start_ms: lo, window_end_ms: hi },
        });
      }
    }

    // funding_soon — ambre
    if (state.is_perp === true && isNum(now) && isNum(state.next_funding_ms)) {
      var untilFunding = state.next_funding_ms - now;
      if (untilFunding >= 0 && untilFunding < thresholds.funding_soon_ms) {
        out.push({
          code: "funding_soon",
          level: "amber",
          values: { next_funding_ms: state.next_funding_ms, ms_remaining: untilFunding },
        });
      }
    }

    // flash_news — ambre
    if (isNum(now) && isNum(state.last_news_ms)) {
      var newsAge = now - state.last_news_ms;
      if (newsAge >= 0 && newsAge < thresholds.flash_news_ms) {
        out.push({
          code: "flash_news",
          level: "amber",
          values: { last_news_ms: state.last_news_ms, age_ms: newsAge },
        });
      }
    }

    // vol_spike — ambre
    if (isNum(state.atr1) && isNum(state.atr1_median) && state.atr1_median > 0) {
      var volThreshold = thresholds.vol_spike_mult * state.atr1_median;
      if (state.atr1 > volThreshold) {
        out.push({
          code: "vol_spike",
          level: "amber",
          values: { atr1: state.atr1, atr1_median: state.atr1_median, threshold: volThreshold },
        });
      }
    }

    // spread_wide — ambre
    if (isNum(state.spread) && isNum(state.spread_median) && state.spread_median > 0) {
      var spreadThreshold = thresholds.spread_wide_mult * state.spread_median;
      if (state.spread > spreadThreshold) {
        out.push({
          code: "spread_wide",
          level: "amber",
          values: { spread: state.spread, spread_median: state.spread_median, threshold: spreadThreshold },
        });
      }
    }

    // fee_coverage — rouge
    if (isNum(state.atr1) && isNum(state.price) && state.price > 0 && isNum(state.fee_round_trip_pct)) {
      var expectedMovePct = (state.atr1 * 3 / state.price) * 100;
      var requiredPct = thresholds.fee_coverage_mult * state.fee_round_trip_pct;
      if (expectedMovePct < requiredPct) {
        out.push({
          code: "fee_coverage",
          level: "red",
          values: {
            expected_move_pct: expectedMovePct,
            required_pct: requiredPct,
            fee_round_trip_pct: state.fee_round_trip_pct,
          },
        });
      }
    }

    // cooldown — ambre (revenge_trade côté coach)
    if (isNum(now) && isArr(state.scalps_today)) {
      var lastLossClosedMs = null;
      for (var j = 0; j < state.scalps_today.length; j++) {
        var scalp = state.scalps_today[j];
        if (!validScalpItem(scalp) || scalp.pnl_chf >= 0) continue;
        if (lastLossClosedMs === null || scalp.closed_ms > lastLossClosedMs) {
          lastLossClosedMs = scalp.closed_ms;
        }
      }
      if (lastLossClosedMs !== null) {
        var sinceLoss = now - lastLossClosedMs;
        if (sinceLoss >= 0 && sinceLoss < thresholds.cooldown_ms) {
          out.push({
            code: "cooldown",
            level: "amber",
            values: { closed_ms: lastLossClosedMs, since_ms: sinceLoss },
          });
        }
      }
    }

    // pace — ambre (overtrading côté coach)
    if (isNum(now) && isArr(state.scalps_today)) {
      var windowStart = now - thresholds.pace_window_ms;
      var count = 0;
      for (var k = 0; k < state.scalps_today.length; k++) {
        var s = state.scalps_today[k];
        if (!validScalpItem(s)) continue;
        if (s.closed_ms > windowStart && s.closed_ms <= now) count++;
      }
      if (count > thresholds.pace_max) {
        out.push({
          code: "pace",
          level: "amber",
          values: { count: count, window_ms: thresholds.pace_window_ms },
        });
      }
    }

    // daily_loss — rouge
    if (isArr(state.scalps_today) && isNum(state.equity_chf) && state.equity_chf > 0) {
      var sum = 0;
      var any = false;
      for (var m = 0; m < state.scalps_today.length; m++) {
        var entry = state.scalps_today[m];
        if (!validScalpItem(entry)) continue;
        sum += entry.pnl_chf;
        any = true;
      }
      if (any) {
        var lossPct = (sum / state.equity_chf) * 100;
        if (lossPct <= -thresholds.daily_loss_pct) {
          out.push({
            code: "daily_loss",
            level: "red",
            values: { pnl_chf: sum, pnl_pct: lossPct, equity_chf: state.equity_chf },
          });
        }
      }
    }

    return out;
  }

  var api = { DEFAULTS: DEFAULTS, evaluate: evaluate };
  root.OmenLib = root.OmenLib || {};
  root.OmenLib.guards = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
