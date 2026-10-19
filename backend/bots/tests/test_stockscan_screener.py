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


def test_parse_gbx_value_traded_is_in_pounds_not_pence():
    # Chiffres RÉELS de la sonde du 19/10 (LSE:RR.) : 13 313 707 titres ×
    # 1327,2 pence = 1,767e10 pence = 176,7 M£, et TradingView rend
    # ``Value.Traded`` = 176 699 519 — donc en LIVRES, alors que ``close`` et
    # ``currency`` sont en pence. Le convertir comme des pence le rendait
    # cent fois trop petit.
    uk = mk.by_id("uk")
    payload = {"totalCount": 1, "data": [{"s": "LSE:RR.", "d": _values(
        name="RR.", description="Rolls-Royce Holdings plc", currency="GBX",
        close=1327.2, volume=13313707, average_volume_10d_calc=20748745.0,
        **{"Value.Traded": 176699519.304},
        market_cap_basic=111914036139, fundamental_currency_code="GBP")}]}
    rows, _ = sc.parse_response(payload, uk)
    rr = rows[0]
    assert rr["value_traded_meur"] == round(176699519.304 * 1.17 / 1e6, 2)
    # le montant moyen, lui, est calculé depuis le cours en pence : inchangé
    assert rr["avg_value_meur"] == round(20748745.0 * 1327.2 * 0.0117 / 1e6, 2)
    assert rr["market_cap_meur"] == round(111914036139 * 1.17 / 1e6, 2)


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
