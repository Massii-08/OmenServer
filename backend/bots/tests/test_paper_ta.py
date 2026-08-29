"""Analyse technique — PUR (aucun réseau, aucun I/O).

Deux familles de tests, et la seconde compte autant que la première :

1. des valeurs CALCULÉES À LA MAIN (séries arithmétiques, RSI de Wilder posé
   au crayon, ATR dont on connaît le vrai range) — sinon on ne teste que la
   stabilité d'un chiffre, pas sa justesse ;
2. des séries TROP COURTES ou ILLISIBLES, qui doivent rendre ``None`` et jamais
   lever. Un stop se pose sur ces niveaux : une moyenne inventée sur trois
   points vaut moins que pas de moyenne du tout.
"""
from backend.bots.paper import ta


# --------------------------------------------------------------------------- #
# Fabriques de séries
# --------------------------------------------------------------------------- #
def _candle(high, low, close, open_=None, ts=0):
    return {"ts": ts, "open": open_ if open_ is not None else close,
            "high": high, "low": low, "close": close, "volume": 1000.0}


def _flat_candles(n, high=102.0, low=100.0, close=101.0):
    """n bougies au range constant (2.0) et sans gap : ATR connu d'avance."""
    return [_candle(high, low, close, ts=1700000000 + i * 86400) for i in range(n)]


def _realistic(n, start=100.0):
    """Série déterministe : deux hausses pour une baisse.

    Volontairement PAS monotone — un RSI de 100 ne prouverait rien sur le
    lissage de Wilder.
    """
    out = []
    price = start
    for i in range(n):
        price = price * (1.004 if i % 3 else 0.997)
        out.append(_candle(price * 1.01, price * 0.99, price,
                           ts=1700000000 + i * 86400))
    return out


# --------------------------------------------------------------------------- #
# sma — la doctrine « une moyenne 200 sur 60 points est un mensonge »
# --------------------------------------------------------------------------- #
def test_sma_on_a_known_arithmetic_series():
    closes = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]
    assert ta.sma(closes, 10) == 5.5          # 55 / 10
    assert ta.sma(closes, 5) == 8.0           # (6+7+8+9+10) / 5


def test_sma_reads_only_the_last_n_closes():
    # Les mille premiers points ne doivent pas peser sur une moyenne 3.
    assert ta.sma([0.0] * 1000 + [10.0, 20.0, 30.0], 3) == 20.0


def test_sma_returns_none_when_the_series_is_shorter_than_the_window():
    assert ta.sma([1, 2, 3], 4) is None
    assert ta.sma([], 1) is None


def test_sma_refuses_a_window_that_is_not_a_positive_whole_number():
    closes = [1, 2, 3, 4, 5]
    assert ta.sma(closes, 0) is None
    assert ta.sma(closes, -3) is None
    assert ta.sma(closes, None) is None
    assert ta.sma(closes, "abc") is None


def test_sma_ignores_unreadable_values_and_never_counts_a_bool_as_a_number():
    # True vaut 1 en Python : le laisser passer fausserait la moyenne en silence.
    assert ta.sma([True, False, 1.0, 2.0, 3.0], 3) == 2.0
    assert ta.sma([None, "x", 1.0, 2.0, 3.0], 3) == 2.0


def test_sma_accepts_numeric_strings_like_the_rest_du_depot():
    assert ta.sma(["1", "2", "3"], 3) == 2.0


def test_sma_on_garbage_input_returns_none_without_raising():
    assert ta.sma(None, 3) is None
    assert ta.sma("101,102,103", 3) is None
    assert ta.sma(42, 3) is None


def test_sma_is_rounded_to_four_decimals():
    assert ta.sma([1.0, 1.0, 2.0], 3) == 1.3333


# --------------------------------------------------------------------------- #
# rsi14 — Wilder, pas une variante maison
# --------------------------------------------------------------------------- #
def test_rsi14_needs_fifteen_closes_because_it_needs_fourteen_variations():
    assert ta.rsi14(list(range(14))) is None      # 14 clôtures = 13 variations
    assert ta.rsi14(list(range(15))) is not None


def test_rsi14_is_100_when_every_session_rises():
    assert ta.rsi14([100 + i for i in range(20)]) == 100.0


def test_rsi14_is_0_when_every_session_falls():
    assert ta.rsi14([100 - i for i in range(20)]) == 0.0


def test_rsi14_is_50_on_a_perfectly_flat_series():
    # Ni hausse ni baisse : ce n'est ni de la force (100) ni de la faiblesse (0).
    assert ta.rsi14([100.0] * 20) == 50.0


def test_rsi14_on_a_hand_computed_seed():
    # 14 variations : une baisse de 1 puis treize hausses de 1.
    # moyenne gains = 13/14, moyenne pertes = 1/14 -> RS = 13
    # RSI = 100 - 100/(1+13) = 92.857... -> 92.86
    closes = [100, 99] + [99 + i for i in range(1, 14)]
    assert len(closes) == 15
    assert ta.rsi14(closes) == 92.86


def test_rsi14_applies_wilder_smoothing_after_the_seed():
    # On prolonge la série précédente d'une baisse de 1 (15e variation).
    # gains  = (13/14 * 13 + 0) / 14 = 169/196
    # pertes = (1/14  * 13 + 1) / 14 =  27/196
    # RSI = 100 * 169 / (169+27) = 86.224... -> 86.22
    # Chiffres RECALCULÉS à la main pour les variantes concurrentes : moyenne
    # simple sur les 14 dernières variations -> 92.86 ; sur toutes -> 86.67 ;
    # EMA classique 2/(n+1) -> 80.48. Aucune ne tombe sur 86.22 : ce test
    # distingue donc bien Wilder d'un autre lissage.
    closes = [100, 99] + [99 + i for i in range(1, 14)] + [111]
    assert len(closes) == 16
    assert ta.rsi14(closes) == 86.22


def test_rsi14_ignores_holes_and_bad_types_in_the_series():
    clean = [100 + i for i in range(20)]
    dirty = [None] + clean[:5] + ["x"] + clean[5:] + [True]
    assert ta.rsi14(dirty) == ta.rsi14(clean) == 100.0


def test_rsi14_on_garbage_input_returns_none_without_raising():
    assert ta.rsi14(None) is None
    assert ta.rsi14([]) is None
    assert ta.rsi14("100 101 102") is None
    assert ta.rsi14([None, "x", True]) is None


# --------------------------------------------------------------------------- #
# high_low_52w — le canal dans lequel on situe le cours
# --------------------------------------------------------------------------- #
def test_high_low_52w_reads_the_extremes_and_the_position_in_the_channel():
    candles = [_candle(120, 90, 100), _candle(110, 80, 95), _candle(115, 85, 100)]
    out = ta.high_low_52w(candles)
    assert out == {"high": 120.0, "low": 80.0, "pos_pct": 50.0}   # (100-80)/(120-80)


def test_high_low_52w_puts_the_cours_at_the_extremes_of_the_channel():
    on_the_high = [_candle(120, 80, 100), _candle(120, 80, 120)]
    on_the_low = [_candle(120, 80, 100), _candle(120, 80, 80)]
    assert ta.high_low_52w(on_the_high)["pos_pct"] == 100.0
    assert ta.high_low_52w(on_the_low)["pos_pct"] == 0.0


def test_high_low_52w_has_no_position_when_the_channel_is_flat():
    # high == low : diviser par zéro n'a pas de sens, et 50 % serait inventé.
    out = ta.high_low_52w([_candle(100, 100, 100), _candle(100, 100, 100)])
    assert out["high"] == 100.0 and out["low"] == 100.0
    assert out["pos_pct"] is None


def test_high_low_52w_falls_back_on_closes_when_highs_and_lows_are_missing():
    candles = [{"close": 90.0}, {"close": 110.0}, {"close": 100.0}]
    assert ta.high_low_52w(candles) == {"high": 110.0, "low": 90.0, "pos_pct": 50.0}


def test_high_low_52w_keeps_a_half_written_candle_in_the_channel():
    # Bougie du jour non consolidée (piège #67a) : son high/low a bien été
    # touché, il compte ; sa clôture manquante ne devient pas le cours de
    # référence -- c'est la dernière clôture CONNUE qui situe le titre.
    candles = [_candle(120, 80, 100), _candle(130, 85, None, open_=126)]
    out = ta.high_low_52w(candles)
    assert out["high"] == 130.0
    assert out["low"] == 80.0
    assert out["pos_pct"] == 40.0            # (100-80)/(130-80) = 40 %


def test_high_low_52w_on_empty_or_garbage_returns_all_none():
    expected = {"high": None, "low": None, "pos_pct": None}
    assert ta.high_low_52w([]) == expected
    assert ta.high_low_52w(None) == expected
    assert ta.high_low_52w(["nope", 42, None]) == expected
    assert ta.high_low_52w("AAPL") == expected


# --------------------------------------------------------------------------- #
# change_5d_pct
# --------------------------------------------------------------------------- #
def test_change_5d_pct_compares_the_last_close_to_the_one_five_sessions_earlier():
    assert ta.change_5d_pct([100.0, 1, 2, 3, 4, 110.0]) == 10.0
    assert ta.change_5d_pct([200.0, 1, 2, 3, 4, 190.0]) == -5.0


def test_change_5d_pct_needs_six_closes():
    assert ta.change_5d_pct([1, 2, 3, 4, 5]) is None
    assert ta.change_5d_pct([]) is None


def test_change_5d_pct_refuses_a_zero_or_unreadable_reference():
    assert ta.change_5d_pct([0.0, 1, 2, 3, 4, 110.0]) is None
    assert ta.change_5d_pct(None) is None
    assert ta.change_5d_pct("100 110") is None


def test_change_5d_pct_is_rounded_to_two_decimals():
    assert ta.change_5d_pct([3.0, 1, 2, 3, 4, 4.0]) == 33.33


# --------------------------------------------------------------------------- #
# atr14 — la matière première d'un stop technique
# --------------------------------------------------------------------------- #
def test_atr14_on_fifteen_candles_of_identical_range_is_that_range():
    # 15 bougies -> 14 true ranges de 2.0 (aucun gap) -> ATR = 2.0
    assert ta.atr14(_flat_candles(15)) == 2.0


def test_atr14_true_range_includes_the_gap_against_the_previous_close():
    # Seed sur 15 bougies plates = 2.0, puis une bougie qui OUVRE loin :
    # TR = max(110-108, |110-101|, |108-101|) = 9
    # Wilder : (2.0 * 13 + 9) / 14 = 2.5
    candles = _flat_candles(15) + [_candle(110.0, 108.0, 109.0)]
    assert ta.atr14(candles) == 2.5


def test_atr14_applies_wilder_smoothing_after_the_seed():
    # 15 bougies plates (seed = 2.0), puis un gap (TR = 9), puis une bougie
    # calme au nouveau niveau (TR = 2) :
    #   Wilder : (2.0 * 13 + 9) / 14 = 2.5 ; (2.5 * 13 + 2) / 14 = 2.4643
    # Une moyenne SIMPLE sur les 14 derniers true ranges donnerait 2.5 — sans
    # ce troisième palier, les deux formules se confondent et le lissage n'est
    # pas testé du tout.
    gap = _candle(110.0, 108.0, 109.0)
    candles = _flat_candles(15) + [gap, _candle(110.0, 108.0, 109.0)]
    assert ta.atr14(candles) == 2.4643


def test_atr14_needs_fifteen_usable_candles():
    assert ta.atr14(_flat_candles(14)) is None
    assert ta.atr14(_flat_candles(15)) is not None


def test_atr14_survives_a_half_written_last_candle():
    # La clôture manquante ne sert qu'à la bougie SUIVANTE : ici il n'y en a pas.
    candles = _flat_candles(15)
    candles[-1] = _candle(102.0, 100.0, None, open_=101.0)
    assert ta.atr14(candles) == 2.0


def test_atr14_rebuilds_a_missing_high_low_from_open_and_close():
    candles = _flat_candles(15)
    candles[7] = {"ts": 0, "open": 100.0, "high": None, "low": None, "close": 102.0}
    assert ta.atr14(candles) is not None


def test_atr14_drops_a_candle_with_no_readable_price_at_all():
    # 15 bougies dont une vide = 14 exploitables : on refuse plutôt qu'inventer.
    candles = _flat_candles(15)
    candles[7] = {"ts": 0, "open": None, "high": None, "low": None, "close": None}
    assert ta.atr14(candles) is None


def test_atr14_on_garbage_input_returns_none_without_raising():
    assert ta.atr14(None) is None
    assert ta.atr14([]) is None
    assert ta.atr14(["nope", 42]) is None
    assert ta.atr14("AAPL") is None


# --------------------------------------------------------------------------- #
# technical_summary — le CONTRAT lu par le prompt du coach
# --------------------------------------------------------------------------- #
KEYS = {
    "last_close", "sma20", "sma50", "sma200", "rsi14", "atr14", "atr14_pct",
    "week52_high", "week52_low", "pos_in_range_pct", "change_5d_pct",
    "n_sessions",
}


def test_technical_summary_exposes_exactly_the_documented_keys():
    # Le prompt LLM lit ces noms : les changer casse le coach en silence.
    assert set(ta.technical_summary(_realistic(260)).keys()) == KEYS
    assert set(ta.technical_summary([]).keys()) == KEYS


def test_technical_summary_on_a_long_series_fills_every_key():
    out = ta.technical_summary(_realistic(260))
    assert all(out[key] is not None for key in KEYS)
    assert out["n_sessions"] == 260
    # Série haussière : le cours doit dominer ses moyennes longues.
    assert out["last_close"] > out["sma50"] > out["sma200"]
    assert 0.0 <= out["rsi14"] <= 100.0
    assert 0.0 <= out["pos_in_range_pct"] <= 100.0
    assert out["atr14"] > 0.0


def test_technical_summary_never_invents_a_long_moving_average():
    out = ta.technical_summary(_realistic(60))
    assert out["sma20"] is not None
    assert out["sma50"] is not None
    assert out["sma200"] is None          # 60 points ne font pas une moyenne 200
    assert out["n_sessions"] == 60


def test_technical_summary_on_an_empty_series_has_every_key_at_none():
    out = ta.technical_summary([])
    assert out == dict((key, None) for key in KEYS)


def test_technical_summary_on_garbage_input_has_every_key_at_none():
    empty = dict((key, None) for key in KEYS)
    assert ta.technical_summary(None) == empty
    assert ta.technical_summary(["nope", 42, None]) == empty
    assert ta.technical_summary("AAPL") == empty
    assert ta.technical_summary({"close": 100}) == empty


def test_technical_summary_survives_a_series_of_half_written_candles():
    candles = _realistic(30)
    candles[-1] = _candle(120.0, 118.0, None, open_=119.0)
    out = ta.technical_summary(candles)
    assert out["n_sessions"] == 29        # la bougie sans clôture ne compte pas
    assert out["rsi14"] is not None
    assert out["week52_high"] == 120.0    # mais son plus haut a bien été touché


def test_technical_summary_atr_pct_relates_the_atr_to_the_last_close():
    # C'est le chiffre qui permet de dimensionner : « un stop à 2 ATR = X % ».
    out = ta.technical_summary(_flat_candles(30))
    assert out["atr14"] == 2.0
    assert out["last_close"] == 101.0
    assert out["atr14_pct"] == 1.98       # 2 / 101 * 100


# --------------------------------------------------------------------------- #
# Pureté du module — aucun I/O, aucun réseau, aucune dépendance externe
# --------------------------------------------------------------------------- #
def test_the_module_imports_nothing_that_touches_the_network_or_the_disk():
    with open(ta.__file__, "r", encoding="utf-8") as handle:
        source = handle.read()
    for forbidden in ("httpx", "requests", "urllib", "socket", "numpy",
                      "open(", "os.path", "json.load"):
        assert forbidden not in source, forbidden


def test_the_module_contains_no_nul_byte():
    with open(ta.__file__, "rb") as handle:
        assert handle.read().count(b"\x00") == 0
