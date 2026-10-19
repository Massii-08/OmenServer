"""Scanner d'actions — screener TradingView (requête, parseur, client).

⚠️ La fixture ``screener_italy_synthetic.json`` est SYNTHÉTIQUE (forme tirée du
paquet ``tradingview-screener`` 3.2.2) : le conteneur de développement rendait
403 sur ``scanner.tradingview.com``. À remplacer par une capture ``--probe``.
"""
import json
import os

import pytest

from backend.bots.stockscan import markets as mk
from backend.bots.stockscan import screener as sc

FIXTURES = os.path.join(os.path.dirname(__file__), "fixtures", "stockscan")
ITALY = mk.by_id("italy")
CFG = {"min_cap_meur": 1000}


def _load(name):
    with open(os.path.join(FIXTURES, name), "r", encoding="utf-8") as f:
        return json.load(f)


# --------------------------------------------------------------------------- #
# build_query
# --------------------------------------------------------------------------- #

def test_build_query_shape():
    q = sc.build_query(ITALY, CFG)
    assert q["markets"] == ["italy"]
    assert q["columns"] == list(sc.COLUMNS)
    assert q["sort"] == {"sortBy": "Value.Traded", "sortOrder": "desc"}
    assert q["range"] == [0, ITALY.rows_limit]
    assert q["ignore_unknown_fields"] is False
    lefts = [f["left"] for f in q["filter"]]
    assert lefts == ["type", "typespecs", "is_primary", "market_cap_basic"]


def test_build_query_converts_cap_to_market_currency():
    ch = mk.by_id("switzerland")
    q = sc.build_query(ch, {"min_cap_meur": 1050})
    cap = [f for f in q["filter"] if f["left"] == "market_cap_basic"][0]["right"]
    assert cap == 1_000_000_000          # 1050 M EUR / 1,05 ≈ 1000 M CHF


def test_build_query_ignore_unknown_flag():
    assert sc.build_query(ITALY, CFG, ignore_unknown=True)["ignore_unknown_fields"] is True


# --------------------------------------------------------------------------- #
# parse_response
# --------------------------------------------------------------------------- #

def test_parse_fixture_rows_and_drops():
    rows, info = sc.parse_response(_load("screener_italy_synthetic.json"), ITALY)
    symbols = [r["tv_symbol"] for r in rows]
    assert symbols == ["MIL:UCG", "MIL:ENI", "MIL:STLAM", "MIL:LDO", "MIL:RACE",
                       "MIL:ENEL", "MIL:TINY"]
    assert info["total"] == 212
    assert info["returned"] == 7
    assert info["dropped"] == 2          # symbole vide + cours absent


def test_parse_maps_fields():
    rows, _ = sc.parse_response(_load("screener_italy_synthetic.json"), ITALY)
    eni = [r for r in rows if r["ticker"] == "ENI"][0]
    assert eni["symbol"] == "ENI.MI"
    assert eni["name"] == "Eni S.p.A."
    assert eni["price"] == 15.48
    assert eni["change_pct"] == 2.31
    assert eni["rel_volume"] == 2.4
    assert eni["earnings_next"] == "2026-10-24"
    # 1,3e7 titres × 15,48 € ≈ 201,24 M€ échangés par jour
    assert eni["avg_value_meur"] == 201.24
    assert eni["market_cap_meur"] == 50200.0
    assert eni["sector"] == "Energy Minerals"


def test_parse_missing_optional_values_are_none():
    rows, _ = sc.parse_response(_load("screener_italy_synthetic.json"), ITALY)
    tiny = [r for r in rows if r["ticker"] == "TINY"][0]
    assert tiny["earnings_next"] is None
    assert tiny["pe"] is None
    assert tiny["industry"] is None


def test_parse_gbx_is_divided_by_hundred():
    uk = mk.by_id("uk")
    payload = {"totalCount": 1, "data": [{"s": "LSE:SHEL", "d": _values(
        name="SHEL", description="Shell plc", currency="GBX", close=2450.0,
        average_volume_10d_calc=1.0e7, market_cap_basic=1.5e11,
        fundamental_currency_code="GBP")}]}
    rows, _ = sc.parse_response(payload, uk)
    shel = rows[0]
    assert shel["symbol"] == "SHEL.L"
    # 1e7 × 2450 pence = 245 M£ ≈ 286,65 M€ — et pas 28 665 M€
    assert shel["avg_value_meur"] == 286.65
    assert shel["market_cap_meur"] == 175500.0


# --- Value.Traded : devise COMPTABLE, pas devise de cotation ---------------- #
#
# Lignes RÉELLES du screener, relevé du 19/10/2026 13:30 UTC (8 marchés). Le
# rapport Value.Traded / (volume × close) y vaut 1,0 quand cotation et comptes
# sont dans la même devise, 0,01 pour GBX/GBP, et le taux de change sinon (USD/GBP
# 0,7503, USD/EUR 0,8899) : la valeur échangée est exprimée dans
# ``fundamental_currency_code`` (celle de la capitalisation), PAS dans ``currency``.

RR_LSE = {            # cours en pence (GBX), comptes en livres (GBP)
    "name": "RR.", "currency": "GBX", "fundamental_currency_code": "GBP",
    "close": 1332.6, "volume": 13635755, "Value.Traded": 181710071.13,
    "average_volume_10d_calc": 20780949.8, "market_cap_basic": 111914036139,
}
CPG_LSE = {           # cotée en dollars à Londres, comptes en livres
    "name": "CPG", "currency": "USD", "fundamental_currency_code": "GBP",
    "close": 32.49, "volume": 308584, "Value.Traded": 7522428.388247999,
    "average_volume_10d_calc": 1764787.2, "market_cap_basic": 41538441458.590195,
}
TFG_AMS = {           # cotée en dollars à Amsterdam, comptes en euros
    "name": "TFG", "currency": "USD", "fundamental_currency_code": "EUR",
    "close": 14.95, "volume": 4746, "Value.Traded": 63143.1491691,
    "average_volume_10d_calc": 9728.4, "market_cap_basic": 1067421656.678443,
}


def _parse_one(tv_symbol, market_id, cols):
    """Une seule ligne, construite par colonne (``_values``), parsée."""
    # ``_values`` ignore en silence une colonne inconnue : une faute de frappe
    # ferait passer un test à vide.
    assert set(cols) <= set(sc.COLUMNS)
    payload = {"totalCount": 1, "data": [{"s": tv_symbol, "d": _values(**cols)}]}
    rows, _ = sc.parse_response(payload, mk.by_id(market_id))
    assert len(rows) == 1
    return rows[0]


def test_value_traded_gbx_quote_is_converted_as_gbp():
    """Londres, cours en pence : Value.Traded est en LIVRES. Lue comme des pence
    elle sortait 100 fois trop petite (2,13 M€ au lieu de 212,6)."""
    rr = _parse_one("LSE:RR.", "uk", RR_LSE)
    # 181,7 M£ × 1,17 ≈ 212,6 M€
    assert rr["value_traded_meur"] == round(181710071.13 * mk.eur_rate("GBP") / 1e6, 2)


def test_value_traded_usd_quote_gbp_accounting_uses_gbp_rate():
    """Cotée en USD mais comptes en GBP : Value.Traded est en livres."""
    cpg = _parse_one("LSE:CPG", "uk", CPG_LSE)
    # 7,52 M£ × 1,17 ≈ 8,80 M€ (avec le taux USD, 0,92, on lirait 6,92)
    assert cpg["value_traded_meur"] == round(7522428.388247999 * mk.eur_rate("GBP") / 1e6, 2)


@pytest.mark.parametrize("scale", [1, 1000])
def test_value_traded_usd_quote_eur_accounting_uses_eur_rate(scale):
    """Cotée en USD mais comptes en EUR : Value.Traded est en euros (taux 1,0).

    À l'échelle 1 (relevé brut, 63 143 €) l'arrondi à 2 décimales donne 0,06
    avec le taux EUR comme avec le taux USD : ce cas ne distingue rien. Les
    montants ×1000 (même rapport mesuré, 0,8899) donnent 63,14 contre 58,09.
    """
    cols = dict(TFG_AMS)
    cols["volume"] = TFG_AMS["volume"] * scale
    cols["Value.Traded"] = TFG_AMS["Value.Traded"] * scale
    tfg = _parse_one("EURONEXT:TFG", "netherlands", cols)
    assert tfg["value_traded_meur"] == round(cols["Value.Traded"] * mk.eur_rate("EUR") / 1e6, 2)


def test_value_traded_follows_row_accounting_currency_not_market_currency():
    """Ligne SYNTHÉTIQUE (pas un relevé) : les trois lignes réelles ci-dessus ont
    des comptes dans la devise de leur marché (uk -> GBP, netherlands -> EUR) et
    ne distinguent donc pas « devise comptable de la LIGNE » de « devise du
    marché ». Ici : un titre étranger coté en USD sur le marché ``america``,
    comptes en EUR, avec le rapport mesuré USD/EUR (0,8899)."""
    cols = {"name": "ADR", "currency": "USD", "fundamental_currency_code": "EUR",
            "close": 1000.0, "volume": 1_000_000, "Value.Traded": 889_900_000.0}
    adr = _parse_one("NASDAQ:ADR", "america", cols)
    # 889,9 M€ — et pas 818,71 (taux USD, que la devise de cotation comme celle
    # du marché ``america`` donneraient)
    assert adr["value_traded_meur"] == round(889_900_000.0 * mk.eur_rate("EUR") / 1e6, 2)


def test_avg_value_stays_in_quote_currency_for_gbx():
    """``avg_value_meur`` = moyenne 10 j (titres) × cours (pence) : c'est la
    devise de COTATION qui convertit ; la corriger comme Value.Traded la
    rendrait 100 fois trop grosse."""
    rr = _parse_one("LSE:RR.", "uk", RR_LSE)
    assert rr["avg_value_meur"] == round(20780949.8 * 1332.6 * mk.eur_rate("GBX") / 1e6, 2)


def test_parse_dedups_symbols_and_tolerates_short_rows():
    payload = {"totalCount": 2, "data": [
        {"s": "MIL:ENI", "d": ["ENI", "Eni", "stock", ["common"], "MIL", "EUR", 15.0]},
        {"s": "mil:eni", "d": ["ENI", "Eni", "stock", ["common"], "MIL", "EUR", 15.0]},
    ]}
    rows, info = sc.parse_response(payload, ITALY)
    assert len(rows) == 1
    assert rows[0]["change_pct"] is None
    assert info["null_columns"] == []    # échantillon trop petit pour juger


def test_parse_reports_dead_columns():
    data = [{"s": "MIL:A%d" % i, "d": _values(name="A%d" % i, close=10.0 + i,
                                              relative_volume_10d_calc=None)}
            for i in range(6)]
    rows, info = sc.parse_response({"totalCount": 6, "data": data}, ITALY)
    assert len(rows) == 6
    assert "relative_volume_10d_calc" in info["null_columns"]
    # une colonne légitimement vide (dividende) n'est pas déclarée morte
    assert "dividends_yield_current" not in info["null_columns"]


@pytest.mark.parametrize("payload", [None, [], "x", {"data": "nope"}, {"totalCount": 3}])
def test_parse_never_raises(payload):
    rows, info = sc.parse_response(payload, ITALY)
    assert rows == []


@pytest.mark.parametrize("raw,expected", [
    (1792800000, "2026-10-24"),
    (1792800000000, "2026-10-24"),
    ("2026-10-24", "2026-10-24"),
    ("2026-10-24T13:30:00Z", "2026-10-24"),
    (None, None), (0, None), ("demain", None), (12345, None),
])
def test_date_of(raw, expected):
    assert sc._date_of(raw) == expected


def _values(**kw):
    base = {c: None for c in sc.COLUMNS}
    base.update({"type": "stock", "currency": "EUR"})
    base.update(kw)
    return [base[c] for c in sc.COLUMNS]


# --------------------------------------------------------------------------- #
# ScreenerClient
# --------------------------------------------------------------------------- #

class FakeResp:
    def __init__(self, status, body):
        self.status_code = status
        self._body = body
        self.text = body if isinstance(body, str) else json.dumps(body)

    def json(self):
        if isinstance(self._body, str):
            return json.loads(self._body)
        return self._body


class FakePost:
    def __init__(self, responses):
        self.responses = list(responses)
        self.calls = []

    def __call__(self, url, body, headers, timeout):
        self.calls.append({"url": url, "body": body, "headers": headers})
        resp = self.responses.pop(0)
        if isinstance(resp, Exception):
            raise resp
        return resp


def _client(post, **kw):
    sleeps = []
    clock = {"t": 0.0}

    def sleep(s):
        sleeps.append(s)
        clock["t"] += s

    c = sc.ScreenerClient(post=post, sleep=sleep, monotonic=lambda: clock["t"], **kw)
    return c, sleeps


def test_client_success():
    post = FakePost([FakeResp(200, {"totalCount": 0, "data": []})])
    c, _ = _client(post)
    payload, meta = c.scan(ITALY, CFG)
    assert payload == {"totalCount": 0, "data": []}
    assert meta == {"status": 200, "attempts": 1, "ignored_unknown": False}
    assert post.calls[0]["url"] == "https://scanner.tradingview.com/italy/scan"
    assert "OmenServer" in post.calls[0]["headers"]["User-Agent"]


def test_client_retries_on_429_then_succeeds():
    post = FakePost([FakeResp(429, "slow down"), FakeResp(200, {"data": []})])
    c, sleeps = _client(post)
    payload, meta = c.scan(ITALY, CFG)
    assert meta["attempts"] == 2
    assert sleeps                       # a attendu avant de rejouer


def test_client_replays_once_with_ignore_unknown_fields():
    post = FakePost([FakeResp(400, '{"error":"Unknown field \\"gap\\""}'),
                     FakeResp(200, {"data": []})])
    c, _ = _client(post)
    _, meta = c.scan(ITALY, CFG)
    assert meta["ignored_unknown"] is True
    assert post.calls[0]["body"]["ignore_unknown_fields"] is False
    assert post.calls[1]["body"]["ignore_unknown_fields"] is True


def test_client_error_payload_with_unknown_field_is_replayed():
    post = FakePost([FakeResp(200, {"totalCount": 0, "error": "Unknown field: xyz", "data": None}),
                     FakeResp(200, {"totalCount": 1, "data": []})])
    c, _ = _client(post)
    _, meta = c.scan(ITALY, CFG)
    assert meta["ignored_unknown"] is True


def test_client_gives_up_with_reason():
    post = FakePost([FakeResp(403, "forbidden")])
    c, _ = _client(post)
    with pytest.raises(sc.ScreenerError) as exc:
        c.scan(ITALY, CFG)
    assert exc.value.status == 403
    assert "forbidden" in exc.value.reason


def test_client_network_errors_are_retried_then_raise():
    post = FakePost([OSError("reset"), OSError("reset"), OSError("reset")])
    c, _ = _client(post)
    with pytest.raises(sc.ScreenerError) as exc:
        c.scan(ITALY, CFG)
    assert exc.value.status == 0
    assert len(post.calls) == 3


def test_client_paces_consecutive_calls():
    post = FakePost([FakeResp(200, {"data": []}), FakeResp(200, {"data": []})])
    c, sleeps = _client(post, min_interval=1.5)
    c.scan(ITALY, CFG)
    c.scan(mk.by_id("germany"), CFG)
    assert sleeps == [1.5]
