"""Frais suisses simulés : courtage par profil + droit de timbre fédéral."""
import pytest

from backend.bots.paper.fees import (
    FEE_PROFILES,
    STAMP_DUTY_FOREIGN,
    STAMP_DUTY_SWISS,
    compute_fees,
    is_swiss_security,
    list_profiles,
    round_trip_pct,
    stamp_duty_rate,
)


# --------------------------------------------------------------------------- #
# Titre suisse ou étranger
# --------------------------------------------------------------------------- #
def test_is_swiss_security_reads_the_sw_suffix():
    assert is_swiss_security("NESN.SW") is True
    assert is_swiss_security("nesn.sw") is True
    assert is_swiss_security(" ABBN.SW ") is True
    assert is_swiss_security("AAPL") is False
    assert is_swiss_security("SW") is False          # pas un suffixe
    assert is_swiss_security("") is False
    assert is_swiss_security(None) is False


def test_stamp_duty_rate_depends_on_the_security():
    assert stamp_duty_rate("NESN.SW") == STAMP_DUTY_SWISS == 0.00075
    assert stamp_duty_rate("AAPL") == STAMP_DUTY_FOREIGN == 0.0015


# --------------------------------------------------------------------------- #
# Yuh — pourcentage avec minimum
# --------------------------------------------------------------------------- #
def test_yuh_charges_half_a_percent_plus_swiss_stamp_duty():
    fees = compute_fees("yuh", 10000.0, "NESN.SW")
    assert fees["brokerage_chf"] == 50.0        # 0,5 %
    assert fees["stamp_duty_chf"] == 7.5        # 0,075 % titre suisse
    assert fees["total_chf"] == 57.5


def test_yuh_doubles_the_stamp_duty_on_a_foreign_security():
    fees = compute_fees("yuh", 10000.0, "AAPL")
    assert fees["stamp_duty_chf"] == 15.0       # 0,15 % titre étranger
    assert fees["total_chf"] == 65.0


def test_yuh_applies_its_minimum_on_a_small_order():
    fees = compute_fees("yuh", 100.0, "AAPL")
    assert fees["brokerage_chf"] == 1.0         # 0,50 CHF -> plancher a 1 CHF
    assert fees["stamp_duty_chf"] == 0.15
    assert fees["total_chf"] == 1.15


def test_profile_key_is_case_insensitive():
    assert compute_fees("YUH", 10000.0, "AAPL") == compute_fees("yuh", 10000.0, "AAPL")


# --------------------------------------------------------------------------- #
# Swissquote — paliers
# --------------------------------------------------------------------------- #
@pytest.mark.parametrize("amount,expected", [
    (500.0, 9.0),
    (1000.0, 9.0),        # borne incluse
    (1000.01, 20.0),
    (5000.0, 20.0),
    (5000.01, 30.0),
    (10000.0, 30.0),
    (10000.01, 55.0),
    (15000.0, 55.0),
    (15000.01, 80.0),
    (25000.0, 80.0),
    (25000.01, 135.0),
    (500000.0, 135.0),
])
def test_swissquote_tiers(amount, expected):
    assert compute_fees("swissquote", amount, "AAPL")["brokerage_chf"] == expected


def test_swissquote_also_pays_the_stamp_duty():
    fees = compute_fees("swissquote", 1000.0, "AAPL")
    assert fees["brokerage_chf"] == 9.0
    assert fees["stamp_duty_chf"] == 1.5
    assert fees["total_chf"] == 10.5


# --------------------------------------------------------------------------- #
# IBKR — courtier étranger, pas de droit de timbre
# --------------------------------------------------------------------------- #
def test_ibkr_is_cheap_and_pays_no_stamp_duty():
    fees = compute_fees("ibkr", 10000.0, "AAPL")
    assert fees["brokerage_chf"] == 5.0         # 0,05 %
    assert fees["stamp_duty_chf"] == 0.0
    assert fees["total_chf"] == 5.0


def test_ibkr_pays_no_stamp_duty_even_on_a_swiss_security():
    assert compute_fees("ibkr", 10000.0, "NESN.SW")["stamp_duty_chf"] == 0.0


def test_ibkr_minimum():
    assert compute_fees("ibkr", 100.0, "AAPL")["brokerage_chf"] == 1.5


def test_the_three_profiles_are_ordered_as_advertised():
    """La leçon du module : le meme aller simple coûte 3 prix très différents."""
    amount = 10000.0
    yuh = compute_fees("yuh", amount, "AAPL")["total_chf"]
    sq = compute_fees("swissquote", amount, "AAPL")["total_chf"]
    ibkr = compute_fees("ibkr", amount, "AAPL")["total_chf"]
    assert ibkr < sq < yuh


# --------------------------------------------------------------------------- #
# Achat ET vente, montants dégénérés, profil inconnu
# --------------------------------------------------------------------------- #
def test_stamp_duty_is_charged_on_both_legs():
    """Le droit de timbre frappe l'achat ET la vente : l'aller-retour coûte double."""
    buy = compute_fees("yuh", 10000.0, "NESN.SW")
    sell = compute_fees("yuh", 10000.0, "NESN.SW")
    assert buy["stamp_duty_chf"] == sell["stamp_duty_chf"] == 7.5
    assert buy["total_chf"] + sell["total_chf"] == 115.0


def test_negative_amount_never_produces_negative_fees():
    assert compute_fees("yuh", -10000.0, "NESN.SW") == compute_fees("yuh", 10000.0, "NESN.SW")


def test_zero_amount_costs_nothing():
    assert compute_fees("yuh", 0.0, "NESN.SW") == {
        "brokerage_chf": 0.0, "stamp_duty_chf": 0.0, "total_chf": 0.0}


def test_unknown_profile_raises():
    with pytest.raises(ValueError):
        compute_fees("degiro", 1000.0, "AAPL")
    with pytest.raises(ValueError):
        compute_fees("", 1000.0, "AAPL")


def test_totals_are_rounded_to_the_centime():
    fees = compute_fees("yuh", 1234.56, "AAPL")
    assert fees["brokerage_chf"] == 6.17          # 6,1728
    assert fees["stamp_duty_chf"] == 1.85         # 1,85184
    assert fees["total_chf"] == 8.02              # somme des composantes affichées


def test_catalogue_exposes_the_three_profiles():
    ids = [p["id"] for p in list_profiles()]
    assert ids == sorted(FEE_PROFILES)
    assert {p["id"]: p["stamp_duty"] for p in list_profiles()} == {
        "ibkr": False, "swissquote": True, "yuh": True}


# --------------------------------------------------------------------------- #
# round_trip_pct — LOT 12 : la conscience des frais
# --------------------------------------------------------------------------- #
def test_round_trip_pct_yuh_foreign_matches_two_legs_of_compute_fees():
    """Yuh, titre ETRANGER : 2 x (0,5 % + 0,15 % timbre) = 1,3 % — pas de
    barème invente, on relit juste compute_fees des deux cotes."""
    leg = compute_fees("yuh", 1000.0, "AAPL")
    expected = round(leg["total_chf"] * 2.0 / 1000.0 * 100.0, 4)
    assert round_trip_pct("yuh", 1000.0, "AAPL") == expected
    assert round_trip_pct("yuh", 1000.0, "AAPL") == pytest.approx(1.3)


def test_round_trip_pct_yuh_swiss_is_cheaper_than_foreign():
    """Le timbre suisse (0,075 %) coute moins cher que l'etranger (0,15 %) :
    NESN.SW doit couter moins que AAPL a montant egal."""
    swiss = round_trip_pct("yuh", 1000.0, "NESN.SW")
    foreign = round_trip_pct("yuh", 1000.0, "AAPL")
    assert swiss < foreign
    assert swiss == pytest.approx(1.15)


def test_round_trip_pct_defaults_to_foreign_stamp_duty_without_symbol():
    """Sans symbole (contexte generique) : taux le plus penalisant (etranger),
    doctrine du plancher conservateur du reste du module."""
    assert round_trip_pct("yuh", 1000.0) == round_trip_pct("yuh", 1000.0, "AAPL")


def test_round_trip_pct_zero_notional_costs_nothing():
    assert round_trip_pct("yuh", 0.0, "AAPL") == 0.0


def test_round_trip_pct_negative_notional_mirrors_the_positive_one():
    """Même doctrine que ``compute_fees`` : un montant négatif ne produit
    jamais un pourcentage négatif ni un pourcentage nul — il compte comme sa
    valeur absolue."""
    assert round_trip_pct("yuh", -1000.0, "AAPL") == round_trip_pct("yuh", 1000.0, "AAPL")


def test_round_trip_pct_unknown_profile_raises():
    with pytest.raises(ValueError):
        round_trip_pct("degiro", 1000.0, "AAPL")


def test_round_trip_pct_ibkr_no_stamp_duty_is_cheapest():
    """IBKR (etranger, pas de timbre) : 2 x 0,05 % = 0,1 % pour un montant
    assez grand pour depasser le plancher de 1,50 CHF."""
    assert round_trip_pct("ibkr", 100000.0, "AAPL") == pytest.approx(0.1)
