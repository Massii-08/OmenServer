"""Tests du module PUR des alertes de prix (Lot A1) — zéro I/O, zéro horloge
réelle."""
from backend.bots.paper import price_alerts as pa


# --------------------------------------------------------------------------- #
# is_valid_op
# --------------------------------------------------------------------------- #

def test_is_valid_op_accepts_above_and_below():
    assert pa.is_valid_op("above") is True
    assert pa.is_valid_op("below") is True


def test_is_valid_op_rejects_anything_else():
    for bad in ("Above", "ABOVE", "eq", "", None, 123, "above "):
        assert pa.is_valid_op(bad) is False


# --------------------------------------------------------------------------- #
# new_alert -- forme COMPLÈTE et stable
# --------------------------------------------------------------------------- #

def test_new_alert_shape_is_complete_and_armed():
    row = pa.new_alert("abc123", "nesn.sw", "above", 100.5, "2026-08-27T10:00:00")
    assert row == {
        "id": "abc123",
        "symbol": "NESN.SW",
        "op": "above",
        "price": 100.5,
        "created_at": "2026-08-27T10:00:00",
        "status": "armed",
        "triggered_at": None,
        "trigger_price": None,
    }


def test_new_alert_uppercases_symbol():
    assert pa.new_alert("i", "tsla", "below", 200, "t")["symbol"] == "TSLA"


# --------------------------------------------------------------------------- #
# condition_met -- franchissement inclusif, jamais sur une valeur manquante
# --------------------------------------------------------------------------- #

def test_condition_met_above_true_when_price_at_or_over_level():
    assert pa.condition_met("above", 100.0, 100.0) is True
    assert pa.condition_met("above", 100.01, 100.0) is True


def test_condition_met_above_false_when_price_under_level():
    assert pa.condition_met("above", 99.99, 100.0) is False


def test_condition_met_below_true_when_price_at_or_under_level():
    assert pa.condition_met("below", 50.0, 50.0) is True
    assert pa.condition_met("below", 49.99, 50.0) is True


def test_condition_met_below_false_when_price_over_level():
    assert pa.condition_met("below", 50.01, 50.0) is False


def test_condition_met_false_when_price_missing():
    assert pa.condition_met("above", None, 100.0) is False


def test_condition_met_false_when_level_missing():
    assert pa.condition_met("above", 100.0, None) is False


def test_condition_met_false_on_unknown_op():
    assert pa.condition_met("sideways", 100.0, 100.0) is False


def test_condition_met_false_on_unparseable_values():
    assert pa.condition_met("above", "not-a-number", 100.0) is False


# --------------------------------------------------------------------------- #
# active_count -- seules les ARMÉES pèsent sur le quota
# --------------------------------------------------------------------------- #

def test_active_count_counts_only_armed():
    rows = [
        {"status": "armed"},
        {"status": "armed"},
        {"status": "triggered"},
        "not-a-dict",
    ]
    assert pa.active_count(rows) == 2


def test_active_count_empty_list_is_zero():
    assert pa.active_count([]) == 0
    assert pa.active_count(None) == 0


# --------------------------------------------------------------------------- #
# trigger -- copie, jamais de mutation de l'original
# --------------------------------------------------------------------------- #

def test_trigger_returns_a_new_dict_without_mutating_the_original():
    original = pa.new_alert("x", "AAPL", "above", 200, "2026-08-27T10:00:00")
    fired = pa.trigger(original, 201.5, "2026-08-27T10:05:00")

    assert original["status"] == "armed"          # inchangée
    assert original["triggered_at"] is None
    assert fired["status"] == "triggered"
    assert fired["triggered_at"] == "2026-08-27T10:05:00"
    assert fired["trigger_price"] == 201.5
    assert fired["id"] == "x" and fired["symbol"] == "AAPL"   # le reste survit


# --------------------------------------------------------------------------- #
# format_trigger_message -- sobre, sans emoji, doctrine du dépôt
# --------------------------------------------------------------------------- #

def test_format_trigger_message_names_symbol_user_and_prices():
    text = pa.format_trigger_message("massii", "NESN.SW", "above", 100, 101.25)
    assert "NESN.SW" in text
    assert "massii" in text
    assert "101.25" in text
    assert "100" in text


def test_format_trigger_message_has_no_emoji():
    text = pa.format_trigger_message("massii", "TSLA", "below", 200, 199.5)
    # L'em-dash (U+2014) est de la PONCTUATION ordinaire du dépôt (même
    # caractère que newswatch.format_message) -- ce qui est réellement
    # interdit, ce sont les émoji/pictogrammes (plage U+1F000+, et les
    # symboles divers U+2600-27BF type ⏰/✅/👍).
    assert not any(0x2600 <= ord(ch) <= 0x27BF or ord(ch) >= 0x1F000 for ch in text)


def test_format_trigger_message_wording_differs_above_vs_below():
    above = pa.format_trigger_message("m", "X", "above", 10, 11)
    below = pa.format_trigger_message("m", "X", "below", 10, 9)
    assert above != below
    assert "dépassé" in above
    assert "franchi" in below


def test_format_trigger_message_trims_trailing_zeros():
    text = pa.format_trigger_message("m", "X", "above", 100.0, 100.5000)
    assert "100.0" not in text.split("(")[0]  # le niveau s'écrit "100", pas "100.0000"
    assert "100.5" in text
