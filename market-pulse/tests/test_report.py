"""Rapport quotidien italien — tests hors ligne sur les fixtures RÉELLES.

Aucun accès réseau : on relit `snapshot_sample.json` / `history_sample.json`
(capturés en vrai le 2026-07-28) et on injecte `now_ts`.
"""
import copy
import json
import os

import pytest

from pulse.report import build_report, fmt_bp, fmt_number, fmt_pct

FIXTURES = os.path.join(os.path.dirname(__file__), "fixtures")


def _load(name):
    with open(os.path.join(FIXTURES, name)) as f:
        return json.load(f)


SNAPSHOT = _load("snapshot_sample.json")
HISTORY = _load("history_sample.json")
NOW = SNAPSHOT["generated_at"]  # 2026-07-28 18:58 Europe/Rome

NEWS = {
    "items": [
        {"title": "Inflazione dell'area euro in rallentamento a luglio",
         "source": "Il Sole 24 Ore", "url": "https://example.it/a",
         "published": 1785250000, "lang": "it"},
        {"title": "Tokyo chiude in forte ribasso dopo i dati sui salari",
         "source": "Il Sole 24 Ore", "url": "https://example.it/b",
         "published": 1785246400, "lang": "it"},
        {"title": "Fed officials signal patience on policy",
         "source": "Reuters", "url": "https://example.com/c",
         "published": None, "lang": "en"},
    ],
    "themes": [
        {"theme": "inflazione", "count": 4, "examples": ["a", "b"]},
        {"theme": "banche centrali", "count": 3, "examples": ["c"]},
    ],
    "sources_ok": ["Il Sole 24 Ore", "Reuters"],
    "sources_failed": [{"source": "ANSA", "error": "timeout"}],
}


def _markets(snapshot):
    return snapshot["markets"]


def _snapshot_with(regions=None, symbols=None):
    """Copie du snapshot filtrée par région et/ou symbole."""
    snap = copy.deepcopy(SNAPSHOT)
    rows = snap["markets"]
    if regions is not None:
        rows = [m for m in rows if m["region"] in regions]
    if symbols is not None:
        rows = [m for m in rows if m["symbol"] in symbols]
    snap["markets"] = rows
    return snap


# --------------------------------------------------------------------------
# Formateurs
# --------------------------------------------------------------------------

def test_fmt_number_uses_italian_separators():
    assert fmt_number(51698.19) == "51.698,19"
    assert fmt_number(1234567.891) == "1.234.567,89"
    assert fmt_number(8458.78) == "8.458,78"


def test_fmt_number_small_negative_and_zero():
    assert fmt_number(0.5) == "0,50"
    assert fmt_number(0) == "0,00"
    assert fmt_number(-3.95) == "-3,95"
    assert fmt_number(-1234.5) == "-1.234,50"


def test_fmt_number_decimals_argument():
    assert fmt_number(1.1394972801208496, 4) == "1,1395"
    assert fmt_number(51698.19, 0) == "51.698"
    assert fmt_number(4.592, 2) == "4,59"


def test_fmt_number_none_and_garbage_give_nd():
    assert fmt_number(None) == "n/d"
    assert fmt_number("pippo") == "n/d"
    assert fmt_number(float("nan")) == "n/d"
    assert fmt_number(float("inf")) == "n/d"


def test_fmt_pct_always_carries_its_sign():
    assert fmt_pct(0.41) == "+0,41%"
    assert fmt_pct(-3.95) == "-3,95%"
    assert fmt_pct(1.29) == "+1,29%"


def test_fmt_pct_zero_has_no_sign_and_never_shows_minus_zero():
    assert fmt_pct(0) == "0,00%"
    assert fmt_pct(0.0) == "0,00%"
    assert fmt_pct(-0.001) == "0,00%"   # -0,00% serait un faux signal
    assert fmt_pct(0.001) == "0,00%"


def test_fmt_pct_none_and_decimals():
    assert fmt_pct(None) == "n/d"
    assert fmt_pct(2.0416, 1) == "+2,0%"
    assert fmt_pct(-1234.5) == "-1.234,50%"


def test_fmt_bp_converts_rate_points_to_basis_points():
    assert fmt_bp(0.04) == "+4 pb"
    assert fmt_bp(-0.048999794006348) == "-5 pb"   # 4,641% -> 4,592%
    assert fmt_bp(0.255) == "+26 pb"
    assert fmt_bp(0) == "0 pb"
    assert fmt_bp(None) == "n/d"
    assert fmt_bp("pippo") == "n/d"


# --------------------------------------------------------------------------
# Rapport — structure
# --------------------------------------------------------------------------

def test_report_has_the_expected_sections():
    rep = build_report(SNAPSHOT, history=HISTORY, news=NEWS, now_ts=NOW)
    for title in ("ASIA — chiusura",
                  "FUTURES, VALUTE E MATERIE PRIME",
                  "TASSI E VOLATILITÀ",
                  "EUROPA",
                  "USA",
                  "STATISTICHE STORICHE",
                  "NOTIZIE"):
        assert title in rep, "sezione mancante: %s" % title


def test_report_header_shows_italian_date_and_hour():
    rep = build_report(SNAPSHOT, now_ts=NOW)
    assert "Martedì 28 luglio 2026" in rep
    assert "ore 18:58" in rep


def test_report_falls_back_on_generated_at_when_now_is_not_given():
    rep = build_report(SNAPSHOT)
    assert "Martedì 28 luglio 2026" in rep


def test_report_uses_italian_labels_of_the_watchlist():
    rep = build_report(SNAPSHOT, now_ts=NOW)
    for label in ("FTSE MIB (Milano)", "Nikkei 225 (Tokyo)", "Petrolio Brent",
                  "Treasury USA 10 anni", "VIX (volatilità)", "Oro"):
        assert label in rep


def test_report_formats_prices_the_italian_way():
    rep = build_report(SNAPSHOT, now_ts=NOW)
    assert "51.698,19" in rep     # FTSE MIB
    assert "62.364,92" in rep     # Nikkei
    assert "-3,95%" in rep        # variation du Nikkei
    assert "51,698.19" not in rep  # jamais le format anglo-saxon


def test_rate_is_shown_as_a_level_and_a_move_in_basis_points():
    """-1,06% sur un rendement est trompeur : la bonne lecture est -5 pb."""
    rep = build_report(SNAPSHOT, now_ts=NOW)
    assert "4,59%" in rep
    assert "-5 pb" in rep
    assert "-1,06%" not in rep


def test_fx_is_shown_with_four_decimals():
    rep = build_report(SNAPSHOT, now_ts=NOW)
    assert "1,1400" in rep


def test_europe_section_states_that_no_european_future_is_available():
    rep = build_report(SNAPSHOT, now_ts=NOW)
    assert "future" in rep.lower()
    assert "nessun valore di apertura europea" in rep.lower()


def test_report_shows_market_clock_state():
    rep = build_report(SNAPSHOT, now_ts=NOW)
    assert "chiuso" in rep          # Europa a 18:58
    assert "aperto" in rep          # Wall Street a 12:58 NY
    assert "apertura alle 09:00" in rep


def test_gap_of_the_day_and_older_gap_are_distinguished():
    rep = build_report(SNAPSHOT, now_ts=NOW)
    assert "gap ap." in rep         # gap_is_today = True (USA, Europa)
    assert "ult. gap" in rep        # gap_is_today = False (Asia)


# --------------------------------------------------------------------------
# Rapport — ligne rouge : aucun conseil, aucune prédiction
# --------------------------------------------------------------------------

FORBIDDEN = [
    "comprare", "vendere", "consiglio", "consigliamo", "conviene",
    "raccomand", "occasione", "opportunità di acquisto", "target price",
    "previsione", "prevedo", "prevediamo", "dovrebbe salire",
    "dovrebbe scendere", "suggeriamo", "acquistare",
]


@pytest.mark.parametrize("kwargs", [
    {},
    {"history": HISTORY},
    {"news": NEWS},
    {"history": HISTORY, "news": NEWS},
])
def test_report_never_uses_prescriptive_or_predictive_vocabulary(kwargs):
    rep = build_report(SNAPSHOT, now_ts=NOW, **kwargs).lower()
    for word in FORBIDDEN:
        assert word not in rep, "vocabolario vietato nel rapporto: %r" % word


def test_report_states_that_it_carries_no_investment_advice():
    rep = build_report(SNAPSHOT, now_ts=NOW).lower()
    assert "nessuna indicazione operativa" in rep


# --------------------------------------------------------------------------
# Rapport — robustesse
# --------------------------------------------------------------------------

def test_report_says_it_loud_when_every_market_failed():
    snap = {"generated_at": NOW, "markets": [],
            "errors": [{"symbol": "^GSPC", "error": "HTTPError: 503"},
                       {"symbol": "^N225", "error": "TimeoutError: timeout"}]}
    rep = build_report(snap, now_ts=NOW)
    assert "nessun dato di mercato" in rep.lower()
    assert "^GSPC" in rep and "^N225" in rep
    assert "HTTPError: 503" in rep
    # Aucune section de marché ne doit être affichée
    assert "ASIA — chiusura" not in rep
    assert "USA\n" not in rep


def test_report_handles_none_prices_gaps_and_changes():
    snap = copy.deepcopy(SNAPSHOT)
    for m in snap["markets"]:
        m["price"] = None
        m["prev_close"] = None
        m["change_pct"] = None
        m["gap"] = None
    rep = build_report(snap, now_ts=NOW)
    assert "n/d" in rep
    assert "0,00%" not in rep          # on n'invente jamais une variation nulle
    assert "FTSE MIB (Milano)" in rep


def test_report_survives_a_snapshot_without_optional_keys():
    snap = {"generated_at": NOW,
            "markets": [{"symbol": "^GSPC", "label": "S&P 500", "region": "usa",
                         "kind": "index"}]}
    rep = build_report(snap, now_ts=NOW)
    assert "S&P 500" in rep
    assert "n/d" in rep


def test_empty_regions_are_omitted_not_left_blank():
    snap = _snapshot_with(regions=("usa",), symbols=None)
    rep = build_report(snap, now_ts=NOW)
    assert "USA" in rep
    assert "ASIA — chiusura" not in rep
    assert "EUROPA" not in rep


def test_footer_lists_the_instruments_in_error():
    snap = copy.deepcopy(SNAPSHOT)
    snap["errors"] = [{"symbol": "^VIX", "error": "HTTPError: 404"}]
    rep = build_report(snap, now_ts=NOW)
    assert "^VIX" in rep
    assert "HTTPError: 404" in rep


def test_no_error_footer_when_nothing_failed():
    rep = build_report(SNAPSHOT, now_ts=NOW)
    assert "DATI MANCANTI" not in rep


def test_reference_close_is_named_when_a_session_is_missing():
    """Un trou de séance (jour férié) doit être dit, pas masqué."""
    snap = _snapshot_with(symbols=("^GSPC",))
    snap["markets"][0]["gap"] = {
        "date": "2026-07-28", "gap_pct": 1.11, "open": 100.0,
        "prev_close": 98.9, "prev_date": "2026-07-24",
    }
    rep = build_report(snap, now_ts=NOW)
    assert "24/07/2026" in rep

    # Un week-end n'est PAS un trou : vendredi -> lundi reste contigu
    snap2 = _snapshot_with(symbols=("^GSPC",))
    snap2["markets"][0]["gap"] = {
        "date": "2026-07-27", "gap_pct": 1.11, "open": 100.0,
        "prev_close": 98.9, "prev_date": "2026-07-24",
    }
    rep2 = build_report(snap2, now_ts=NOW)
    assert "24/07/2026" not in rep2


def test_report_stays_printable_and_within_78_columns():
    rep = build_report(SNAPSHOT, history=HISTORY, news=NEWS, now_ts=NOW)
    for i, line in enumerate(rep.splitlines(), 1):
        assert len(line) <= 78, "riga %s troppo lunga (%s): %r" % (i, len(line), line)
        assert all(ch.isprintable() for ch in line), "riga %s non stampabile: %r" % (i, line)


def test_report_strips_control_characters_coming_from_the_data():
    snap = _snapshot_with(symbols=("^GSPC",))
    snap["markets"][0]["label"] = "S&P\t500\x07"
    rep = build_report(snap, now_ts=NOW)
    assert "\t" not in rep
    assert "\x07" not in rep


# --------------------------------------------------------------------------
# Rapport — statistiques historiques
# --------------------------------------------------------------------------

def test_history_section_is_absent_without_history():
    rep = build_report(SNAPSHOT, now_ts=NOW)
    assert "STATISTICHE STORICHE" not in rep


def test_history_section_shows_weekday_gaps_and_biggest_gaps():
    rep = build_report(SNAPSHOT, history=HISTORY, now_ts=NOW)
    assert "STATISTICHE STORICHE" in rep
    assert "lunedì" in rep and "venerdì" in rep
    assert "251 sedute" in rep
    assert "08/04/2026" in rep      # le plus gros gap du S&P 500
    assert "+2,08%" in rep


def test_history_section_frames_the_numbers_as_past_observations():
    rep = build_report(SNAPSHOT, history=HISTORY, now_ts=NOW).lower()
    assert "passat" in rep          # « dati del passato » / « osservazioni passate »


def test_history_section_tolerates_an_empty_or_broken_payload():
    assert "STATISTICHE STORICHE" not in build_report(SNAPSHOT, history={}, now_ts=NOW)
    rep = build_report(SNAPSHOT, history={"stats": {"^GSPC": {}}}, now_ts=NOW)
    assert isinstance(rep, str)


# --------------------------------------------------------------------------
# Rapport — notizie
# --------------------------------------------------------------------------

def test_news_section_is_absent_without_news():
    rep = build_report(SNAPSHOT, now_ts=NOW)
    assert "NOTIZIE" not in rep


def test_news_section_groups_titles_by_source_with_the_hour():
    rep = build_report(SNAPSHOT, news=NEWS, now_ts=NOW)
    assert "NOTIZIE" in rep
    assert "Il Sole 24 Ore" in rep
    assert "Reuters" in rep
    assert "Inflazione dell'area euro in rallentamento" in rep
    assert "inflazione" in rep          # thème
    assert "ANSA" in rep                # source en échec, dite honnêtement


def test_news_section_accepts_a_partial_payload():
    rep = build_report(SNAPSHOT, news={"items": [{"title": "Solo un titolo"}]},
                       now_ts=NOW)
    assert "Solo un titolo" in rep
    rep2 = build_report(SNAPSHOT, news={"themes": []}, now_ts=NOW)
    assert isinstance(rep2, str)


def test_news_titles_are_wrapped_not_truncated_into_gibberish():
    long_title = "Titolo molto lungo " * 8
    rep = build_report(SNAPSHOT, news={"items": [
        {"title": long_title, "source": "Fonte", "published": NOW}]}, now_ts=NOW)
    assert "Titolo molto lungo" in rep
    for line in rep.splitlines():
        assert len(line) <= 78
