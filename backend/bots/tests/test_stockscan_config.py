"""Scanner d'actions — catalogue des marchés et validation de la config."""
import json
import os
import stat

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
    assert clean["top_n"] == cfgmod.LIMITS["top_n"][1]
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
    assert clean["lang"] == "it"
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
    cfgmod.save_defaults({"lang": "en"})        # une valeur DIFFÉRENTE du défaut
    data = json.loads(cfgmod.defaults_path().read_text(encoding="utf-8"))
    assert data["lang"] == "en"


def test_the_excel_is_italian_by_default():
    # Comme le Bond Scanner : l'Excel est lu par papy (demande Massii du 19/10).
    assert cfgmod.DEFAULTS["lang"] == "it"
    assert cfgmod.validate({})[0]["lang"] == "it"


def test_validate_is_idempotent_even_at_the_top_n_ceiling():
    # Rapport de test réel du 19/10 : top_n=100 poussait shortlist à 100,
    # au-delà de sa propre borne (80) -> 100 -> 80 -> 100 à chaque passage,
    # et 100 requêtes de news. Les deux bornes doivent être compatibles.
    clean, _ = cfgmod.validate({"top_n": 100})
    again, warnings = cfgmod.validate(clean)
    assert again == clean and warnings == []
    assert clean["top_n"] <= clean["shortlist"] <= cfgmod.LIMITS["shortlist"][1]
    assert cfgmod.LIMITS["top_n"][1] <= cfgmod.LIMITS["shortlist"][1]
