"""Contrat de données du paper trading : sérialisation et tolérance du schéma."""
import json

from backend.bots.paper.models import (
    DEFAULT_CAPITAL,
    Order,
    Portfolio,
    Position,
    Trade,
)


def _full_portfolio() -> Portfolio:
    return Portfolio(
        cash_chf=7345.20,
        positions=[
            Position(symbol="NESN.SW", qty=10, avg_price=95.5, currency="CHF",
                     fx_rate=1.0, opened_at="2026-08-01T09:15:00", side="long",
                     thesis="franchit sa résistance de juin sur volume",
                     stop_loss=91.0, target=104.0, risk_chf=45.0),
            Position(symbol="AAPL", qty=5, avg_price=201.4, currency="USD",
                     fx_rate=0.88, opened_at="2026-08-10T15:35:00", side="short"),
        ],
        open_orders=[
            Order(id="ord-1", symbol="ABBN.SW", side="buy", kind="limit", qty=20,
                  limit_price=44.5, created_at="2026-08-20T08:00:00",
                  thesis="cassure du range sur volume", stop_loss=42.0, target=50.0,
                  risk_chf=50.0, currency="CHF", fee_profile="yuh"),
        ],
        trades=[
            Trade(symbol="UBSG.SW", side="long", qty=30, entry_price=28.0,
                  exit_price=31.5, entry_at="2026-06-02T09:05:00",
                  exit_at="2026-07-14T16:20:00", fees_chf=4.2, stamp_duty_chf=1.35,
                  pnl_chf=99.45, pnl_pct=11.83, r_multiple=1.75,
                  thesis="rebond sur la moyenne 50", exit_reason="target",
                  planned_stop=26.0, currency="CHF", fx_rate=1.0),
        ],
        fee_profile="swissquote",
        initial_capital=10000.0,
        created_at="2026-05-01T00:00:00",
    )


# --------------------------------------------------------------------------- #
# Round-trip
# --------------------------------------------------------------------------- #
def test_portfolio_round_trip_through_json_is_identical():
    original = _full_portfolio()
    revived = Portfolio.from_dict(json.loads(json.dumps(original.to_dict())))
    assert revived == original


def test_to_dict_is_json_serialisable_and_recursive():
    data = _full_portfolio().to_dict()
    json.dumps(data)  # ne doit pas lever
    assert isinstance(data["positions"][0], dict)
    assert isinstance(data["open_orders"][0], dict)
    assert isinstance(data["trades"][0], dict)
    assert data["positions"][0]["symbol"] == "NESN.SW"


def test_each_structure_round_trips_on_its_own():
    for obj, cls in (
        (_full_portfolio().positions[0], Position),
        (_full_portfolio().open_orders[0], Order),
        (_full_portfolio().trades[0], Trade),
    ):
        assert cls.from_dict(json.loads(json.dumps(obj.to_dict()))) == obj


# --------------------------------------------------------------------------- #
# Tolérance : le fichier JSON doit survivre aux évolutions du schéma
# --------------------------------------------------------------------------- #
def test_from_dict_fills_missing_fields_with_defaults():
    pos = Position.from_dict({"symbol": "NESN.SW"})
    assert (pos.qty, pos.avg_price, pos.currency, pos.fx_rate, pos.side) == (
        0, 0.0, "CHF", 1.0, "long")
    assert (pos.thesis, pos.stop_loss, pos.target, pos.risk_chf) == ("", None, None, None)

    order = Order.from_dict({"id": "x", "symbol": "AAPL"})
    assert (order.side, order.kind, order.status, order.limit_price,
            order.stop_loss, order.fee_profile) == ("buy", "market", "open", None, None, "yuh")

    trade = Trade.from_dict({"symbol": "AAPL"})
    assert (trade.side, trade.qty, trade.r_multiple, trade.planned_stop,
            trade.fx_rate) == ("long", 0, None, None, 1.0)


def test_portfolio_from_dict_tolerates_empty_and_none():
    for payload in ({}, None):
        pf = Portfolio.from_dict(payload)
        assert pf.cash_chf == DEFAULT_CAPITAL
        assert pf.initial_capital == DEFAULT_CAPITAL
        assert pf.fee_profile == "yuh"
        assert (pf.positions, pf.open_orders, pf.trades) == ([], [], [])


def test_portfolio_from_dict_reads_an_old_file_without_the_newest_fields():
    """Un portefeuille écrit avant l'ajout de fx_rate/fee_profile reste lisible."""
    legacy = {
        "cash_chf": 5000.0,
        "positions": [{"symbol": "AAPL", "qty": 3, "avg_price": 190.0,
                       "opened_at": "2026-01-05T10:00:00", "side": "long"}],
        "open_orders": [],
        "trades": [{"symbol": "AAPL", "qty": 3, "entry_price": 100.0,
                    "exit_price": 120.0, "pnl_chf": 60.0}],
    }
    pf = Portfolio.from_dict(legacy)
    assert pf.positions[0].fx_rate == 1.0
    assert pf.positions[0].currency == "CHF"
    assert pf.positions[0].stop_loss is None
    assert pf.positions[0].thesis == ""
    assert pf.trades[0].r_multiple is None
    assert pf.fee_profile == "yuh"


def test_from_dict_ignores_unknown_fields():
    pos = Position.from_dict({"symbol": "AAPL", "qty": 2, "moon_phase": "gibbous"})
    assert pos.symbol == "AAPL" and pos.qty == 2
    assert not hasattr(pos, "moon_phase")


def test_from_dict_survives_wrong_types():
    pos = Position.from_dict({"symbol": "AAPL", "qty": "oops", "avg_price": None,
                              "fx_rate": "n/a"})
    assert (pos.qty, pos.avg_price, pos.fx_rate) == (0, 0.0, 1.0)

    order = Order.from_dict({"id": "x", "symbol": "AAPL", "limit_price": "abc"})
    assert order.limit_price is None


def test_numeric_strings_are_accepted():
    pos = Position.from_dict({"symbol": "AAPL", "qty": "7", "avg_price": "190.5"})
    assert pos.qty == 7 and pos.avg_price == 190.5


def test_portfolio_from_dict_skips_non_dict_entries_in_lists():
    pf = Portfolio.from_dict({
        "positions": [{"symbol": "AAPL"}, "corrompu", None, 42],
        "open_orders": "pas une liste",
        "trades": [{"symbol": "NESN.SW"}],
    })
    assert len(pf.positions) == 1 and pf.positions[0].symbol == "AAPL"
    assert pf.open_orders == []
    assert len(pf.trades) == 1


# --------------------------------------------------------------------------- #
# Le PLAN vit sur la position : l'ordre d'entrée est consommé une fois exécuté
# --------------------------------------------------------------------------- #
def test_position_carries_the_trade_plan_and_it_survives_the_round_trip():
    pos = Position(symbol="ABBN.SW", qty=20, avg_price=44.5,
                   opened_at="2026-08-21T09:05:00", side="long",
                   thesis="cassure du range sur volume", stop_loss=42.0,
                   target=50.0, risk_chf=50.0)
    revived = Position.from_dict(json.loads(json.dumps(pos.to_dict())))
    assert revived == pos
    assert (revived.thesis, revived.stop_loss, revived.target, revived.risk_chf) == (
        "cassure du range sur volume", 42.0, 50.0, 50.0)


def test_the_plan_of_the_order_transfers_verbatim_to_the_position():
    """Ce que le tick applique et ce que le coach relit vient de la position."""
    order = Order(id="ord-1", symbol="ABBN.SW", side="buy", kind="limit", qty=20,
                  limit_price=44.5, thesis="cassure du range sur volume",
                  stop_loss=42.0, target=50.0, risk_chf=50.0)
    pos = Position(symbol=order.symbol, qty=order.qty, avg_price=44.5,
                   opened_at="2026-08-21T09:05:00", side="long",
                   thesis=order.thesis, stop_loss=order.stop_loss,
                   target=order.target, risk_chf=order.risk_chf)
    for field_name in ("thesis", "stop_loss", "target", "risk_chf"):
        assert getattr(pos, field_name) == getattr(order, field_name)


def test_a_position_without_a_plan_stays_valid():
    """Une entrée sans stop reste enregistrable — c'est le biais no_stop qui la juge."""
    pos = Position.from_dict({"symbol": "AAPL", "qty": 5, "avg_price": 190.0})
    assert pos.stop_loss is None and pos.thesis == ""
    assert Position.from_dict(pos.to_dict()) == pos


def test_plan_fields_tolerate_wrong_types():
    pos = Position.from_dict({"symbol": "AAPL", "stop_loss": "n/a", "target": None,
                              "risk_chf": "beaucoup", "thesis": None})
    assert (pos.stop_loss, pos.target, pos.risk_chf, pos.thesis) == (None, None, None, "")


# --------------------------------------------------------------------------- #
# Journal niveau pro (LOT 2) — setup/emotion/emotion_close + MAE/MFE/gap
# --------------------------------------------------------------------------- #
def test_setup_and_emotion_default_to_empty_and_survive_the_round_trip():
    pos = Position(symbol="NESN.SW", setup="breakout", emotion="fomo")
    assert Position.from_dict(json.loads(json.dumps(pos.to_dict()))) == pos

    order = Order(id="x", symbol="NESN.SW", setup="pullback", emotion="calme")
    assert Order.from_dict(json.loads(json.dumps(order.to_dict()))) == order

    # Défaut d'un vieux portefeuille écrit avant le LOT 2 : chaîne vide, jamais
    # une exception ni un ``None`` (même politique que ``thesis``).
    assert Position.from_dict({"symbol": "AAPL"}).setup == ""
    assert Position.from_dict({"symbol": "AAPL"}).emotion == ""
    assert Order.from_dict({"id": "x", "symbol": "AAPL"}).setup == ""
    assert Order.from_dict({"id": "x", "symbol": "AAPL"}).emotion == ""


def test_trade_carries_journal_tags_and_excursions_and_tolerates_their_absence():
    trade = Trade(symbol="NESN.SW", setup="trend", emotion="doute",
                  emotion_close="euphorie", mae_pct=-3.2, mfe_pct=5.8,
                  best_exit_gap_pct=3.7)
    revived = Trade.from_dict(json.loads(json.dumps(trade.to_dict())))
    assert revived == trade

    # Un trade d'avant le LOT 2 (fichier existant) n'a AUCUN de ces champs :
    # ils retombent sur leur défaut, jamais une exception.
    legacy = Trade.from_dict({"symbol": "AAPL"})
    assert (legacy.setup, legacy.emotion, legacy.emotion_close) == ("", "", "")
    assert (legacy.mae_pct, legacy.mfe_pct, legacy.best_exit_gap_pct) == (None, None, None)


def test_excursion_fields_tolerate_wrong_types():
    trade = Trade.from_dict({"symbol": "AAPL", "mae_pct": "n/a", "mfe_pct": None,
                             "best_exit_gap_pct": "beaucoup"})
    assert (trade.mae_pct, trade.mfe_pct, trade.best_exit_gap_pct) == (None, None, None)


def test_setups_and_emotions_whitelists_are_closed_and_match_the_mission():
    from backend.bots.paper.models import EMOTIONS, SETUPS
    assert SETUPS == ("breakout", "pullback", "news", "coach_idea", "trend",
                      "contrarian", "other")
    assert EMOTIONS == ("calme", "fomo", "revanche", "doute", "euphorie")
