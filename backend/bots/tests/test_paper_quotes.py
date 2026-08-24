"""Tests du pont Yahoo du simulateur — 100 % hors ligne (client injecté).

Deux pièges du dépôt sont verrouillés ici :
  * #67a — la bougie à moitié écrite se GARDE, la bougie nulle se jette ;
  * #68e — la variation se calcule sur les CLÔTURES, jamais sur
    ``chartPreviousClose`` (qui dépend de la fenêtre demandée).
"""
import pytest

from backend.bots.paper import quotes


class FakeClient(object):
    """Client chart minimal : rend une réponse préparée, note ses appels."""

    def __init__(self, payloads=None, error=None):
        self.payloads = payloads or {}
        self.error = error
        self.calls = []

    def get_chart(self, symbol, range_="10d", interval="1d"):
        self.calls.append((symbol, range_, interval))
        if self.error is not None:
            raise self.error
        if symbol not in self.payloads:
            raise RuntimeError("pas de fixture pour %s" % symbol)
        return self.payloads[symbol]


def chart(symbol="NESN.SW", currency="CHF", price=100.0, name="Nestle SA",
          timestamps=None, opens=None, highs=None, lows=None, closes=None,
          volumes=None, previous_close=None, error=None):
    """Fabrique une réponse ``/v8/finance/chart`` réaliste."""
    if error is not None:
        return {"chart": {"error": error, "result": None}}
    timestamps = timestamps if timestamps is not None else [1, 2]
    body = {
        "meta": {
            "symbol": symbol,
            "shortName": name,
            "currency": currency,
            "regularMarketPrice": price,
            "chartPreviousClose": previous_close,
            "exchangeTimezoneName": "Europe/Zurich",
            "fullExchangeName": "Swiss",
        },
        "timestamp": timestamps,
        "indicators": {"quote": [{
            "open": opens if opens is not None else [None] * len(timestamps),
            "high": highs if highs is not None else [None] * len(timestamps),
            "low": lows if lows is not None else [None] * len(timestamps),
            "close": closes if closes is not None else [None] * len(timestamps),
            "volume": volumes if volumes is not None else [None] * len(timestamps),
        }]},
    }
    return {"chart": {"error": None, "result": [body]}}


@pytest.fixture(autouse=True)
def _clean_state():
    """Aucun état ne fuit d'un test à l'autre (cache FX, client partagé)."""
    quotes.clear_fx_cache()
    quotes.set_client(None)
    yield
    quotes.clear_fx_cache()
    quotes.set_client(None)


# ================================================================
#  parsing des bougies (piège #67a)
# ================================================================

def test_half_written_candle_is_kept():
    # séance en cours : ouverture connue, clôture pas encore consolidée
    raw = chart(timestamps=[1, 2], opens=[10.0, 11.0], closes=[10.5, None])
    candles = quotes.parse_candles(raw["chart"]["result"][0])
    assert len(candles) == 2
    assert candles[1]["open"] == 11.0
    assert candles[1]["close"] is None


def test_fully_null_candle_is_dropped():
    # jour férié / trou de données : ni ouverture ni clôture
    raw = chart(timestamps=[1, 2, 3], opens=[10.0, None, 12.0],
                closes=[10.5, None, 12.5])
    candles = quotes.parse_candles(raw["chart"]["result"][0])
    assert [c["ts"] for c in candles] == [1, 3]


def test_missing_high_low_rebuilt_from_known_ends():
    raw = chart(timestamps=[1], opens=[10.0], closes=[12.0],
                highs=[None], lows=[None])
    candle = quotes.parse_candles(raw["chart"]["result"][0])[0]
    assert candle["high"] == 12.0
    assert candle["low"] == 10.0


def test_volume_is_carried():
    raw = chart(timestamps=[1], opens=[10.0], closes=[12.0], volumes=[4242])
    assert quotes.parse_candles(raw["chart"]["result"][0])[0]["volume"] == 4242


# ================================================================
#  variation (piège #68e)
# ================================================================

def test_change_pct_uses_closes_not_chart_previous_close():
    candles = [{"ts": 1, "open": 99.0, "high": 101.0, "low": 98.0, "close": 100.0},
               {"ts": 2, "open": 100.0, "high": 111.0, "low": 100.0, "close": 110.0}]
    # 110 contre la clôture précédente 100 = +10 %.
    assert quotes.change_pct(candles, 110.0) == 10.0


def test_change_pct_ignores_the_unconsolidated_last_candle():
    candles = [{"ts": 1, "close": 100.0}, {"ts": 2, "close": 110.0},
               {"ts": 3, "open": 111.0, "close": None}]
    assert quotes.change_pct(candles, 112.0) == pytest.approx(1.82, abs=0.01)


def test_change_pct_none_when_series_too_short():
    assert quotes.change_pct([{"ts": 1, "close": 100.0}], 110.0) is None
    assert quotes.change_pct([], 110.0) is None


def test_get_quote_never_reads_chart_previous_close():
    # chartPreviousClose volontairement absurde : s'il servait, la variation
    # serait de +120 % au lieu de +10 %.
    client = FakeClient({"NESN.SW": chart(price=110.0, previous_close=50.0,
                                          timestamps=[1, 2],
                                          opens=[99.0, 100.0],
                                          closes=[100.0, 110.0])})
    quote = quotes.get_quote("NESN.SW", client=client)
    assert quote["price"] == 110.0
    assert quote["change_pct"] == 10.0
    assert quote["currency"] == "CHF"
    assert quote["name"] == "Nestle SA"


# ================================================================
#  cotation
# ================================================================

def test_get_quote_falls_back_on_last_close_without_market_price():
    client = FakeClient({"X": chart(symbol="X", price=None, timestamps=[1, 2],
                                    opens=[9.0, 10.0], closes=[9.5, 10.5])})
    assert quotes.get_quote("X", client=client)["price"] == 10.5


def test_get_quote_raises_unknown_symbol_without_any_price():
    client = FakeClient({"X": chart(symbol="X", price=None, timestamps=[1],
                                    opens=[None], closes=[None])})
    with pytest.raises(quotes.UnknownSymbol):
        quotes.get_quote("X", client=client)


def test_get_quote_raises_unknown_symbol_on_yahoo_error():
    client = FakeClient({"NOPE": chart(error={"code": "Not Found"})})
    with pytest.raises(quotes.UnknownSymbol):
        quotes.get_quote("NOPE", client=client)


def test_network_failure_becomes_quote_error():
    client = FakeClient(error=IOError("TLS"))
    with pytest.raises(quotes.QuoteError):
        quotes.get_quote("NESN.SW", client=client)


def test_get_candles_passes_range_and_interval():
    client = FakeClient({"NESN.SW": chart(timestamps=[1], opens=[1.0], closes=[1.0])})
    quotes.get_candles("NESN.SW", "1d", "15m", client=client)
    assert client.calls == [("NESN.SW", "1d", "15m")]


# ================================================================
#  taux de change
# ================================================================

def test_fx_chf_is_one_without_any_call():
    client = FakeClient()
    assert quotes.fx_to_chf("CHF", client=client) == 1.0
    assert client.calls == []


def test_fx_reads_the_pair_last_close():
    client = FakeClient({"USDCHF=X": chart(symbol="USDCHF=X", currency="CHF",
                                           price=None, timestamps=[1, 2],
                                           opens=[0.9, 0.9], closes=[0.89, 0.88])})
    assert quotes.fx_to_chf("usd", client=client) == 0.88
    assert client.calls == [("USDCHF=X", "5d", "1d")]


def test_fx_is_cached_within_the_ttl(monkeypatch):
    clock = {"t": 1000.0}
    monkeypatch.setattr(quotes, "_now", lambda: clock["t"])
    client = FakeClient({"USDCHF=X": chart(symbol="USDCHF=X", price=None,
                                           timestamps=[1], opens=[0.9], closes=[0.88])})
    assert quotes.fx_to_chf("USD", client=client) == 0.88
    clock["t"] += quotes.FX_TTL_S - 1
    assert quotes.fx_to_chf("USD", client=client) == 0.88
    assert len(client.calls) == 1                      # servi par le cache

    clock["t"] += 2                                    # TTL dépassé
    assert quotes.fx_to_chf("USD", client=client) == 0.88
    assert len(client.calls) == 2


def test_fx_failure_raises_a_clear_error():
    client = FakeClient(error=IOError("réseau"))
    with pytest.raises(quotes.QuoteError):
        quotes.fx_to_chf("USD", client=client)


def test_fx_unknown_pair_is_not_an_unknown_symbol():
    """Le symbole fautif est la PAIRE, pas le titre demandé par l'utilisateur :
    le router ne doit pas répondre 404 sur le titre."""
    client = FakeClient({"XXXCHF=X": chart(error={"code": "Not Found"})})
    with pytest.raises(quotes.QuoteError) as excinfo:
        quotes.fx_to_chf("XXX", client=client)
    assert not isinstance(excinfo.value, quotes.UnknownSymbol)


def test_fx_without_currency_raises():
    with pytest.raises(quotes.QuoteError):
        quotes.fx_to_chf("")


# ================================================================
#  recherche
# ================================================================

def test_search_short_query_does_no_network(monkeypatch):
    called = []
    monkeypatch.setattr(quotes, "_fetch_json", lambda url: called.append(url))
    assert quotes.search("a") == []
    assert quotes.search("") == []
    assert called == []


def test_search_keeps_equity_and_etf_only(monkeypatch):
    payload = {"quotes": [
        {"symbol": "NESN.SW", "shortname": "Nestle", "longname": "Nestle SA",
         "exchDisp": "Swiss", "currency": "chf", "quoteType": "EQUITY"},
        {"symbol": "CSPX.L", "shortname": "iShares Core", "exchDisp": "LSE",
         "currency": "USD", "quoteType": "ETF"},
        {"symbol": "EURCHF=X", "shortname": "EUR/CHF", "quoteType": "CURRENCY"},
        {"symbol": "^SSMI", "shortname": "SMI", "quoteType": "INDEX"},
    ]}
    monkeypatch.setattr(quotes, "_fetch_json", lambda url: payload)
    results = quotes.search("nestle")
    assert [r["symbol"] for r in results] == ["NESN.SW", "CSPX.L"]
    assert results[0] == {"symbol": "NESN.SW", "name": "Nestle SA",
                          "exchange": "Swiss", "currency": "CHF"}


def test_search_encodes_the_query(monkeypatch):
    seen = {}

    def fake(url):
        seen["url"] = url
        return {"quotes": []}

    monkeypatch.setattr(quotes, "_fetch_json", fake)
    quotes.search("banque cantonale")
    assert "banque+cantonale" in seen["url"] or "banque%20cantonale" in seen["url"]


def test_search_network_failure_raises_quote_error(monkeypatch):
    def boom(url):
        raise IOError("réseau")

    monkeypatch.setattr(quotes, "_fetch_json", boom)
    with pytest.raises(quotes.QuoteError):
        quotes.search("nestle")


# ================================================================
#  fiche d'analyse
# ================================================================

def _linear_series(n=260, volume=1000):
    """Série synthétique : clôture = 100 + i, high = low = close, volume fixe."""
    timestamps = list(range(1, n + 1))
    closes = [100.0 + i for i in range(n)]
    return chart(symbol="ACME", currency="USD", price=closes[-1], name="Acme",
                 timestamps=timestamps, opens=closes, highs=closes, lows=closes,
                 closes=closes, volumes=[volume] * n)


def test_fiche_facts_on_a_synthetic_year():
    client = FakeClient({"ACME": _linear_series()})
    facts = quotes.fiche_facts("ACME", client=client)

    assert client.calls == [("ACME", "1y", "1d")]
    assert facts["symbol"] == "ACME"
    assert facts["currency"] == "USD"
    assert facts["price"] == 359.0
    assert facts["n_sessions"] == 260
    assert facts["week52_high"] == 359.0
    assert facts["week52_low"] == 100.0
    assert facts["pos_in_range_pct"] == pytest.approx(100.0, abs=0.1)
    assert facts["sma50"] == pytest.approx(334.5, abs=0.01)
    assert facts["sma200"] == pytest.approx(259.5, abs=0.01)
    assert facts["trend"] == "haussier"
    assert facts["avg_volume_3m"] == 1000
    assert facts["change_1d_pct"] == pytest.approx(0.28, abs=0.01)
    assert facts["perf_1m_pct"] == pytest.approx(6.21, abs=0.01)
    assert facts["perf_6m_pct"] == pytest.approx(54.08, abs=0.01)
    assert facts["perf_1y_pct"] == pytest.approx(235.51, abs=0.01)
    assert facts["volatility_ann_pct"] > 0


def test_fiche_facts_short_series_yields_none_not_lies():
    client = FakeClient({"NEW": chart(symbol="NEW", price=12.0,
                                      timestamps=list(range(1, 11)),
                                      opens=[10.0] * 10, highs=[10.0] * 10,
                                      lows=[10.0] * 10, closes=[10.0] * 10)})
    facts = quotes.fiche_facts("NEW", client=client)
    assert facts["sma50"] is None
    assert facts["sma200"] is None
    assert facts["trend"] is None
    assert facts["volatility_ann_pct"] is None
    assert facts["perf_1m_pct"] is None
    assert facts["perf_1y_pct"] is None
    assert facts["avg_volume_3m"] is None


def test_trend_is_bearish_below_both_averages():
    closes = [400.0 - i for i in range(260)]
    raw = chart(symbol="DOWN", price=closes[-1], timestamps=list(range(1, 261)),
                opens=closes, highs=closes, lows=closes, closes=closes)
    facts = quotes.build_facts(quotes.parse_meta(raw["chart"]["result"][0]),
                               quotes.parse_candles(raw["chart"]["result"][0]))
    assert facts["trend"] == "baissier"
