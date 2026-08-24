"""Exécution des ordres contre une bougie — dont la leçon des gaps."""
import pytest

from backend.bots.paper.fills import check_protective_stops, try_fill


def candle(o, h, l, c):
    return {"open": o, "high": h, "low": l, "close": c}


def order(kind, side, **kw):
    base = {"id": "o1", "symbol": "AAPL", "kind": kind, "side": side, "qty": 10}
    base.update(kw)
    return base


# --------------------------------------------------------------------------- #
# Ordre au marché
# --------------------------------------------------------------------------- #
def test_market_order_fills_at_the_close():
    assert try_fill(order("market", "buy"), candle(100, 105, 99, 103)) == 103


def test_market_order_falls_back_to_the_open_when_yahoo_has_no_close_yet():
    """Bougie a moitié écrite (cf. piège #67a) : on exécute quand meme."""
    assert try_fill(order("market", "sell"), candle(100, 105, 99, None)) == 100


def test_market_order_without_any_price_is_not_filled():
    assert try_fill(order("market", "buy"), candle(None, None, None, None)) is None


# --------------------------------------------------------------------------- #
# Ordres à cours limité
# --------------------------------------------------------------------------- #
def test_limit_buy_fills_when_the_low_reaches_the_limit():
    assert try_fill(order("limit", "buy", limit_price=98.0),
                    candle(100, 102, 97.5, 101)) == 98.0


def test_limit_buy_is_not_filled_when_the_price_stays_above():
    assert try_fill(order("limit", "buy", limit_price=95.0),
                    candle(100, 102, 98, 101)) is None


def test_limit_buy_at_exactly_the_low_is_filled():
    assert try_fill(order("limit", "buy", limit_price=98.0),
                    candle(100, 102, 98.0, 101)) == 98.0


def test_limit_sell_fills_when_the_high_reaches_the_limit():
    assert try_fill(order("limit", "sell", limit_price=104.0),
                    candle(100, 105, 99, 101)) == 104.0


def test_limit_sell_is_not_filled_when_the_price_stays_below():
    assert try_fill(order("limit", "sell", limit_price=110.0),
                    candle(100, 105, 99, 101)) is None


def test_cover_behaves_like_a_buy_and_short_like_a_sell():
    assert try_fill(order("limit", "cover", limit_price=98.0),
                    candle(100, 102, 97.5, 101)) == 98.0
    assert try_fill(order("limit", "short", limit_price=104.0),
                    candle(100, 105, 99, 101)) == 104.0


def test_limit_order_without_a_limit_price_is_never_filled():
    assert try_fill(order("limit", "buy"), candle(100, 105, 90, 101)) is None


# --------------------------------------------------------------------------- #
# Ordres stop
# --------------------------------------------------------------------------- #
def test_stop_sell_fills_at_the_stop_when_the_price_slides_through_it():
    assert try_fill(order("stop", "sell", stop_price=95.0),
                    candle(100, 101, 94.0, 96)) == 95.0


def test_stop_sell_is_not_filled_while_the_low_stays_above():
    assert try_fill(order("stop", "sell", stop_price=90.0),
                    candle(100, 101, 94.0, 96)) is None


def test_stop_buy_fills_at_the_stop_on_a_breakout():
    assert try_fill(order("stop", "buy", stop_price=105.0),
                    candle(100, 107, 99, 106)) == 105.0


def test_stop_order_without_a_stop_price_is_never_filled():
    assert try_fill(order("stop", "sell"), candle(100, 101, 80, 96)) is None


# --------------------------------------------------------------------------- #
# LES GAPS — la leçon pédagogique du module
# --------------------------------------------------------------------------- #
def test_gap_down_a_sell_stop_executes_at_the_open_not_at_the_stop():
    """Profit warning : le titre ouvre a 88 sous un stop a 95. On sort a 88."""
    price = try_fill(order("stop", "sell", stop_price=95.0), candle(88, 90, 85, 89))
    assert price == 88.0


def test_gap_up_a_buy_stop_executes_at_the_open_not_at_the_stop():
    price = try_fill(order("stop", "buy", stop_price=105.0), candle(112, 115, 111, 114))
    assert price == 112.0


def test_gap_down_a_buy_limit_is_served_at_the_open_which_is_better():
    """Meme règle, gap en FAVEUR : limite d'achat a 100, ouverture a 95 -> 95."""
    price = try_fill(order("limit", "buy", limit_price=100.0), candle(95, 99, 93, 97))
    assert price == 95.0


def test_gap_up_a_sell_limit_is_served_at_the_open_which_is_better():
    price = try_fill(order("limit", "sell", limit_price=100.0), candle(106, 110, 104, 108))
    assert price == 106.0


def test_without_an_open_price_the_trigger_is_used():
    assert try_fill(order("stop", "sell", stop_price=95.0),
                    {"high": 96, "low": 90, "close": 92}) == 95.0


# --------------------------------------------------------------------------- #
# Erreurs de programmation : bruyantes, jamais silencieuses
# --------------------------------------------------------------------------- #
def test_unknown_kind_raises():
    with pytest.raises(ValueError):
        try_fill(order("trailing", "buy"), candle(100, 105, 99, 103))


def test_unknown_side_raises():
    with pytest.raises(ValueError):
        try_fill(order("market", "hodl"), candle(100, 105, 99, 103))


# --------------------------------------------------------------------------- #
# Stops de protection sur position ouverte
# --------------------------------------------------------------------------- #
def test_long_stop_triggers_when_the_low_breaks_it():
    assert check_protective_stops({"side": "long"}, 95.0, candle(100, 101, 94, 96)) == 95.0


def test_long_stop_untouched_returns_none():
    assert check_protective_stops({"side": "long"}, 90.0, candle(100, 101, 94, 96)) is None


def test_long_stop_on_a_gap_down_exits_at_the_open():
    assert check_protective_stops({"side": "long"}, 95.0, candle(88, 90, 85, 89)) == 88.0


def test_short_stop_triggers_when_the_high_breaks_it():
    assert check_protective_stops({"side": "short"}, 105.0, candle(100, 107, 99, 106)) == 105.0


def test_short_stop_untouched_returns_none():
    assert check_protective_stops({"side": "short"}, 110.0, candle(100, 107, 99, 106)) is None


def test_short_stop_on_a_gap_up_exits_at_the_open():
    assert check_protective_stops({"side": "short"}, 105.0, candle(112, 115, 111, 114)) == 112.0


def test_no_stop_means_no_protection():
    assert check_protective_stops({"side": "long"}, None, candle(100, 101, 50, 60)) is None


def test_position_side_defaults_to_long_and_unknown_side_raises():
    assert check_protective_stops({}, 95.0, candle(100, 101, 94, 96)) == 95.0
    with pytest.raises(ValueError):
        check_protective_stops({"side": "sideways"}, 95.0, candle(100, 101, 94, 96))
