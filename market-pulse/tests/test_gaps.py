"""Gaps et statistiques — fonctions pures sur bougies synthétiques."""
from pulse.gaps import Gap, all_gaps, biggest_gaps, is_same_local_day, latest_gap, weekday_stats
from pulse.quotes import Candle

TZ = "Europe/Rome"
DAY = 86400
# Lundi 2026-07-20 09:00 Rome
MON = 1784530800
# 2026-07-31 / 2026-08-03 09:00 Rome — cas réel ^STOXX50E (défaut #1)
TS_0731 = 1785481200
TS_0803 = 1785740400


def _c(ts, open_, close):
    return Candle(ts=ts, open=open_, high=max(open_, close), low=min(open_, close), close=close)


def test_latest_gap_up():
    candles = [_c(MON, 100.0, 102.0), _c(MON + DAY, 104.04, 105.0)]
    g = latest_gap(candles, TZ)
    assert g is not None
    assert g.gap_pct == 2.0          # (104.04 - 102) / 102
    assert g.prev_close == 102.0
    assert g.date == "2026-07-21"


def test_latest_gap_needs_two_candles():
    assert latest_gap([_c(MON, 100, 101)], TZ) is None
    assert latest_gap([], TZ) is None


def test_all_gaps_chain():
    candles = [_c(MON, 100, 100), _c(MON + DAY, 101, 101), _c(MON + 2 * DAY, 99.99, 100)]
    gaps = all_gaps(candles, TZ)
    assert [g.gap_pct for g in gaps] == [1.0, -1.0]


# --------------------------------------------------------------------------
# Défaut #1 : un open à 0 n'est pas un vrai prix (régression ^STOXX50E)
# --------------------------------------------------------------------------

def test_latest_gap_never_reads_a_zero_open_as_a_real_price():
    """Cas réel mesuré le 2026-08-03 sur ^STOXX50E : Yahoo rend la bougie du
    jour avec open=0.0 / close=None / high=0.0, alors que la clôture du
    2026-07-31 vaut 6358.009765625. L'ancien code ne gardait `cur.open` que
    contre `None` (`prev.close` était protégé par `not prev.close`, qui
    attrape bien le zéro — la garde était ASYMÉTRIQUE) : il lisait ce zéro
    comme un vrai prix d'ouverture -> gap_pct = -100.0, publié tel quel
    (« ult. gap -100,00% ») dans le rapport italien lu par un particulier âgé.
    """
    candles = [
        _c(TS_0731, 6390.0, 6358.009765625),
        Candle(ts=TS_0803, open=0.0, high=0.0, low=0.0, close=None),
    ]
    g = latest_gap(candles, TZ)
    # Aucune séance antérieure exploitable dans cette fenêtre à 2 bougies :
    # None, jamais un gap fabriqué depuis le zéro sentinelle.
    assert g is None


def test_latest_gap_falls_back_to_the_last_session_with_a_usable_open():
    """Avec une séance valable plus tôt dans la fenêtre, le gap se calcule
    sur ELLE — le zéro du jour n'invalide que sa propre paire, pas toute la
    remontée (même logique que la bougie à moitié écrite, déjà protégée)."""
    ts0 = TS_0731 - DAY  # 2026-07-30 : open=6250.0, close=6300.0 (référence)
    candles = [
        _c(ts0, 6250.0, 6300.0),
        _c(TS_0731, 6390.0, 6358.009765625),
        Candle(ts=TS_0803, open=0.0, high=0.0, low=0.0, close=None),
    ]
    g = latest_gap(candles, TZ)
    assert g is not None
    assert g.gap_pct != -100.0
    assert g.open == 6390.0
    assert g.prev_close == 6300.0
    assert g.date == "2026-07-31"
    assert g.gap_pct == round((6390.0 - 6300.0) / 6300.0 * 100.0, 2)


def test_all_gaps_skips_the_degenerate_zero_open_candle_only():
    """Le zéro sentinelle n'écarte QUE la paire inexploitable — les autres
    paires de la série restent calculées normalement."""
    ts0 = TS_0731 - DAY
    candles = [
        _c(ts0, 6250.0, 6300.0),
        _c(TS_0731, 6390.0, 6358.009765625),
        Candle(ts=TS_0803, open=0.0, high=0.0, low=0.0, close=None),
    ]
    gaps = all_gaps(candles, TZ)
    assert all(g.gap_pct != -100.0 for g in gaps)
    assert len(gaps) == 1                 # seule (30/07 -> 31/07) est calculable
    assert gaps[0].date == "2026-07-31"


def test_a_negative_open_is_treated_as_missing_too():
    """Même raisonnement pour toute référence de prix : un `open` négatif est
    aussi impossible pour un indice — traité comme absent, pas comme un
    crash brutal (aucune exception, gap simplement non calculé)."""
    candles = [_c(MON, 100.0, 102.0), _c(MON + DAY, -5.0, -4.0)]
    assert latest_gap(candles, TZ) is None


def test_weekday_stats():
    gaps = [
        Gap("2026-07-20", 1.0, 0, 0),   # lundi
        Gap("2026-07-27", -0.5, 0, 0),  # lundi
        Gap("2026-07-21", 0.4, 0, 0),   # mardi
    ]
    stats = weekday_stats(gaps)
    assert stats["lunedì"]["n"] == 2
    assert stats["lunedì"]["avg_gap_pct"] == 0.25
    assert stats["lunedì"]["avg_abs_gap_pct"] == 0.75
    assert stats["lunedì"]["pct_up"] == 50.0
    assert stats["martedì"]["n"] == 1


def test_biggest_gaps_sorted_by_magnitude():
    gaps = [Gap("2026-07-20", 0.1, 0, 0), Gap("2026-07-21", -2.0, 0, 0), Gap("2026-07-22", 1.0, 0, 0)]
    top = biggest_gaps(gaps, n=2)
    assert [g.gap_pct for g in top] == [-2.0, 1.0]


def test_is_same_local_day():
    assert is_same_local_day(MON, MON + 3600, TZ)
    assert not is_same_local_day(MON, MON + DAY, TZ)
