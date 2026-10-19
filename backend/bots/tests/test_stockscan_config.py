"""Scanner d'actions — catalogue des marchés et validation de la config."""
import itertools
import json
import os
import stat

import pytest

from backend.bots.stockscan import config as cfgmod
from backend.bots.stockscan import markets as mk


# --------------------------------------------------------------------------- #
# Catalogue + pont TradingView -> Yahoo
# --------------------------------------------------------------------------- #

def test_catalogue_is_closed_and_default_markets_exist():
    ids = [m["id"] for m in mk.catalogue()]
    assert len(ids) == len(set(ids))
    for market_id in mk.DEFAULT_MARKETS:
        assert market_id in ids
    assert mk.by_id("japan") is None
    assert mk.by_id(None) is None
    assert mk.by_id(" Italy ").id == "italy"


def test_catalogue_labels_follow_language():
    fr = {m["id"]: m["label"] for m in mk.catalogue("fr")}
    it = {m["id"]: m["label"] for m in mk.catalogue("it")}
    assert fr["switzerland"].startswith("Suisse")
    assert it["switzerland"].startswith("Svizzera")
    # langue inconnue -> français, jamais une clé vide
    assert mk.catalogue("de")[0]["label"]


def test_tv_to_yahoo_uses_coach_table():
    assert mk.tv_to_yahoo("MIL:ENI", "italy") == "ENI.MI"
    assert mk.tv_to_yahoo("XETR:SAP", "germany") == "SAP.DE"
    assert mk.tv_to_yahoo("NASDAQ:AAPL", "america") == "AAPL"
    # classe d'actions : le point devient un tiret chez Yahoo
    assert mk.tv_to_yahoo("NYSE:BRK.B", "america") == "BRK-B"
    assert mk.tv_to_yahoo("LSE:SHEL", "uk") == "SHEL.L"


def test_tv_to_yahoo_euronext_depends_on_scanned_market():
    # la table du coach suppose Paris ; Amsterdam doit donner .AS
    assert mk.tv_to_yahoo("EURONEXT:MC", "france") == "MC.PA"
    assert mk.tv_to_yahoo("EURONEXT:ASML", "netherlands") == "ASML.AS"
    assert mk.tv_to_yahoo("BME:SAN", "spain") == "SAN.MC"


def test_tv_to_yahoo_applies_coach_aliases():
    # Yahoo cote Roche sous RO.SW (alias vérifié du coach)
    assert mk.tv_to_yahoo("SIX:ROG", "switzerland") == "RO.SW"
    assert mk.tv_to_yahoo("SIX:NESN", "switzerland") == "NESN.SW"


def test_tv_to_yahoo_never_invents():
    assert mk.tv_to_yahoo("TSE:7203", "america") is None
    assert mk.tv_to_yahoo("ENI", "italy") is None
    assert mk.tv_to_yahoo("", "italy") is None
    assert mk.tv_to_yahoo(None, "italy") is None


def test_chart_url_is_encoded():
    assert mk.chart_url("MIL:ENI") == "https://www.tradingview.com/chart/?symbol=MIL%3AENI"
    assert mk.chart_url("nope") is None


def test_currency_conversion_is_symmetric():
    ch = mk.by_id("switzerland")
    assert round(mk.to_eur(mk.to_local(1000, ch), ch), 6) == 1000
    assert mk.to_eur(None, ch) is None


# --------------------------------------------------------------------------- #
# validate
# --------------------------------------------------------------------------- #

def test_validate_empty_gives_defaults_without_warning():
    clean, warnings = cfgmod.validate({})
    assert clean == cfgmod.DEFAULTS
    assert warnings == []
    clean, warnings = cfgmod.validate(None)
    assert clean == cfgmod.DEFAULTS


def test_validate_drops_unknown_markets_with_warning():
    clean, warnings = cfgmod.validate({"markets": ["italy", "japan", "ITALY", "uk"]})
    assert clean["markets"] == ["italy", "uk"]
    assert {"code": "unknown_market", "value": "japan"} in warnings


def test_validate_only_unknown_markets_falls_back_to_defaults():
    clean, warnings = cfgmod.validate({"markets": ["japan"]})
    assert clean["markets"] == list(mk.DEFAULT_MARKETS)
    assert {"code": "default_markets"} in warnings


def test_validate_accepts_comma_string():
    clean, _ = cfgmod.validate({"markets": "italy, germany"})
    assert clean["markets"] == ["italy", "germany"]


def test_validate_clamps_numbers_and_says_so():
    clean, warnings = cfgmod.validate({"top_n": 500, "min_cap_meur": 1})
    assert clean["top_n"] == 80       # plafond de la présélection (budget de news)
    assert clean["min_cap_meur"] == 50
    codes = [(w["code"], w.get("field")) for w in warnings]
    assert ("clamped", "top_n") in codes
    assert ("clamped", "min_cap_meur") in codes


def test_validate_bad_values_fall_back():
    clean, warnings = cfgmod.validate({"top_n": "abc", "window_h": 36,
                                       "exclude_red": "yes", "lang": "de"})
    assert clean["top_n"] == cfgmod.DEFAULTS["top_n"]
    assert clean["window_h"] == 48
    assert clean["exclude_red"] is False
    assert clean["lang"] == "fr"
    fields = sorted(w["field"] for w in warnings if w["code"] == "bad_value")
    assert fields == ["exclude_red", "lang", "top_n", "window_h"]


def test_validate_bool_is_not_a_number():
    clean, warnings = cfgmod.validate({"top_n": True})
    assert clean["top_n"] == cfgmod.DEFAULTS["top_n"]
    assert warnings[0]["code"] == "bad_value"


def test_validate_shortlist_never_shorter_than_top_n():
    clean, warnings = cfgmod.validate({"top_n": 60, "shortlist": 20})
    assert clean["shortlist"] == 60
    assert any(w["code"] == "clamped" and w["field"] == "shortlist" for w in warnings)


def test_validate_flags_unknown_keys():
    _, warnings = cfgmod.validate({"min_yield": 4})
    assert {"code": "unknown_key", "field": "min_yield"} in warnings


def test_validate_window_accepts_allowed_values():
    for window in (24, 48, 72, "72", 24.0):
        clean, warnings = cfgmod.validate({"window_h": window})
        assert clean["window_h"] == int(float(window))
        assert warnings == []


# --------------------------------------------------------------------------- #
# Bornes couplées et idempotence
# --------------------------------------------------------------------------- #
# La liste rendue (top_n) est prélevée DANS la présélection (shortlist) : les
# deux partagent le même plafond, 80 = budget de requêtes de news TradingView
# (partagé avec le coach du simulateur). Si top_n pouvait le dépasser, la règle
# de couplage pousserait shortlist hors de ses bornes et validate ne serait plus
# idempotent : le moteur revalide le config.json écrit par le routeur et
# journalise chaque avertissement (ping-pong shortlist 100 -> 80 -> 100).

def test_limits_top_n_can_never_exceed_the_shortlist_ceiling():
    assert cfgmod.LIMITS["top_n"][1] <= cfgmod.LIMITS["shortlist"][1]
    # Le « correctif » tentant — relever la présélection à 100 — est INTERDIT :
    # 100 requêtes de news au lieu de 80 mangent le budget du coach.
    assert cfgmod.LIMITS["shortlist"][1] == 80, "budget de news partagé : ne pas relever"


@pytest.mark.parametrize("raw_top_n", [81, 100, 9999])
def test_validate_caps_top_n_at_the_shortlist_ceiling(raw_top_n):
    # top_n 100 est atteignable : le curseur de l'UI va jusqu'à la borne servie.
    clean, warnings = cfgmod.validate({"top_n": raw_top_n})
    assert clean["top_n"] == 80
    assert clean["shortlist"] == 80
    # chaque correction laisse un avertissement, dès le PREMIER passage
    assert {"code": "clamped", "field": "top_n", "value": raw_top_n, "used": 80} in warnings
    assert any(w["code"] == "clamped" and w["field"] == "shortlist" and w["used"] == 80
               for w in warnings)
    for field, (lo, hi) in cfgmod.LIMITS.items():
        assert lo <= clean[field] <= hi, field


_ABSENT = object()                       # « la clé n'est pas dans la config brute »
_TOP_N_GRID = (-5, 0, 5, 25, 79, 80, 81, 100, 9999, "abc", True, _ABSENT)
_SHORTLIST_GRID = (-1, 5, 10, 40, 79, 80, 81, 100, 9999, _ABSENT)
# Les autres champs : valides, invalides, hors bornes, clés inconnues.
_OTHERS_GRID = (
    {},
    {"markets": ["italy", "germany"], "window_h": 24, "lang": "it"},
    {"markets": ["japan"], "window_h": 36, "lang": "de"},
    {"markets": "uk, america, japan", "window_h": "72", "lang": " EN "},
    {"markets": [], "window_h": None, "lang": None},
    {"min_cap_meur": 1, "min_value_meur": 99999, "exclude_red": "yes"},
    {"min_cap_meur": "abc", "min_value_meur": -3, "exclude_red": True, "min_yield": 4},
)


def _grid():
    for top_n, shortlist, others in itertools.product(_TOP_N_GRID, _SHORTLIST_GRID, _OTHERS_GRID):
        raw = dict(others)
        if top_n is not _ABSENT:
            raw["top_n"] = top_n
        if shortlist is not _ABSENT:
            raw["shortlist"] = shortlist
        yield raw


def test_validate_is_idempotent_and_within_limits_on_a_grid():
    failures = []
    count = 0
    for raw in _grid():
        count += 1
        c1, _ = cfgmod.validate(raw)
        out_of_limits = [f for f, (lo, hi) in cfgmod.LIMITS.items() if not lo <= c1[f] <= hi]
        # revalider une config déjà propre la rend telle quelle, SANS avertissement
        c2, w2 = cfgmod.validate(c1)
        if out_of_limits or c1["shortlist"] < c1["top_n"] or c2 != c1 or w2:
            failures.append({"raw": raw, "out_of_limits": out_of_limits, "c1": c1, "w2": w2})
    # la grille ne s'est pas vidée par accident
    assert count == len(_TOP_N_GRID) * len(_SHORTLIST_GRID) * len(_OTHERS_GRID)
    assert not failures, "%d/%d cas fautifs, ex. %r" % (len(failures), count, failures[:3])


# --------------------------------------------------------------------------- #
# Défauts persistés
# --------------------------------------------------------------------------- #

def test_defaults_roundtrip_is_validated_and_600(tmp_path, monkeypatch):
    monkeypatch.setattr(cfgmod, "DATA_DIR", tmp_path)
    saved = cfgmod.save_defaults({"markets": ["uk", "japan"], "top_n": 10})
    assert saved["markets"] == ["uk"]
    path = cfgmod.defaults_path()
    assert stat.S_IMODE(os.stat(str(path)).st_mode) == 0o600
    loaded, warnings = cfgmod.load_defaults()
    assert loaded == saved
    assert warnings == []


def test_load_defaults_tolerates_missing_and_corrupt(tmp_path, monkeypatch):
    monkeypatch.setattr(cfgmod, "DATA_DIR", tmp_path)
    clean, warnings = cfgmod.load_defaults()
    assert clean == cfgmod.DEFAULTS and warnings == []
    cfgmod.defaults_path().write_text("{oops", encoding="utf-8")
    clean, _ = cfgmod.load_defaults()
    assert clean == cfgmod.DEFAULTS
    # le défaut d'usine n'est jamais muté par un appelant
    clean["markets"].append("uk")
    assert "uk" not in cfgmod.DEFAULTS["markets"]


def test_saved_file_is_plain_json(tmp_path, monkeypatch):
    monkeypatch.setattr(cfgmod, "DATA_DIR", tmp_path)
    cfgmod.save_defaults({"lang": "it"})
    data = json.loads(cfgmod.defaults_path().read_text(encoding="utf-8"))
    assert data["lang"] == "it"


def test_load_defaults_brings_a_legacy_top_n_100_file_back_within_limits(tmp_path, monkeypatch):
    # defaults.json écrit AVANT la correction : top_n 100 avait poussé shortlist à 100.
    monkeypatch.setattr(cfgmod, "DATA_DIR", tmp_path)
    cfgmod.defaults_path().write_text(json.dumps({"top_n": 100, "shortlist": 100}),
                                      encoding="utf-8")
    clean, warnings = cfgmod.load_defaults()
    assert (clean["top_n"], clean["shortlist"]) == (80, 80)
    for field, (lo, hi) in cfgmod.LIMITS.items():
        assert lo <= clean[field] <= hi, field
    assert {"code": "clamped", "field": "top_n", "value": 100, "used": 80} in warnings
    assert {"code": "clamped", "field": "shortlist", "value": 100, "used": 80} in warnings


def test_defaults_saved_at_the_top_n_ceiling_reload_without_warning(tmp_path, monkeypatch):
    # Le curseur de l'UI au maximum, puis la fois suivante : aucun ping-pong.
    monkeypatch.setattr(cfgmod, "DATA_DIR", tmp_path)
    saved = cfgmod.save_defaults({"top_n": 100})
    loaded, warnings = cfgmod.load_defaults()
    assert loaded == saved
    assert warnings == []
