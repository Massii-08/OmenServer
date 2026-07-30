"""Tes préférences — un fichier JSON simple, tolérant, et qui SIGNALE les fautes."""
import io, json, os
from pulse.prefs import (DEFAULT_BORSE, DEFAULT_OPZIONI, load, save, validate,
                         write_example)


def test_no_file_means_sensible_defaults():
    """Le bot doit tourner dès l'installation, sans rien configurer."""
    prefs, warnings = load("/tmp/n-existe-pas-du-tout.json")
    assert prefs["borse"] == DEFAULT_BORSE
    assert prefs["opzioni"]["sintesi"] is True
    assert warnings == []


def test_a_typo_in_a_key_is_SIGNALLED_not_swallowed():
    """« bourse » au lieu de « borse » doit se voir. Une clé avalée en silence
    est la pire des configs : on croit avoir changé quelque chose."""
    prefs, warnings = validate({"bourse": ["nyse"]})
    assert any("bourse" in w for w in warnings)
    assert prefs["borse"] == DEFAULT_BORSE


def test_an_unknown_exchange_is_signalled_and_dropped():
    prefs, warnings = validate({"borse": ["euronext", "bourse-de-mars"]})
    assert prefs["borse"] == ["euronext"]
    assert any("mars" in w for w in warnings)


def test_all_exchanges_unknown_falls_back_instead_of_producing_nothing():
    prefs, warnings = validate({"borse": ["mars", "venus"]})
    assert prefs["borse"] == DEFAULT_BORSE
    assert any("aucune bourse valide" in w for w in warnings)


def test_duplicates_are_collapsed():
    prefs, _ = validate({"borse": ["nyse", "nyse", "jpx"]})
    assert prefs["borse"] == ["nyse", "jpx"]


def test_followed_stocks_are_kept_per_exchange():
    prefs, _ = validate({"titoli": {"euronext": ["RACE.MI", " ASML.AS "]}})
    assert prefs["titoli"]["euronext"] == ["RACE.MI", "ASML.AS"]


def test_followed_stocks_of_an_unknown_exchange_are_signalled():
    prefs, warnings = validate({"titoli": {"mars": ["X"]}})
    assert prefs["titoli"] == {}
    assert any("mars" in w for w in warnings)


def test_options_keep_their_type_and_signal_a_wrong_one():
    prefs, warnings = validate({"opzioni": {"sintesi": "oui"}})
    assert prefs["opzioni"]["sintesi"] is DEFAULT_OPZIONI["sintesi"]
    assert any("sintesi" in w for w in warnings)


def test_a_number_option_is_bounded():
    assert validate({"opzioni": {"max_notizie": 9999}})[0]["opzioni"]["max_notizie"] == 50
    assert validate({"opzioni": {"max_notizie": 0}})[0]["opzioni"]["max_notizie"] == 1


def test_an_unknown_option_is_signalled():
    _prefs, warnings = validate({"opzioni": {"turbo": True}})
    assert any("turbo" in w for w in warnings)


def test_switching_x_on_is_one_boolean():
    prefs, warnings = validate({"opzioni": {"x": True, "x_account": ["Reuters"]}})
    assert prefs["opzioni"]["x"] is True
    assert prefs["opzioni"]["x_account"] == ["Reuters"]
    assert warnings == []


def test_a_corrupt_file_does_not_break_the_morning_run(tmp_path):
    p = tmp_path / "prefs.json"
    p.write_text("{ceci n'est pas du json", encoding="utf-8")
    prefs, warnings = load(str(p))
    assert prefs["borse"] == DEFAULT_BORSE
    assert any("illisible" in w for w in warnings)


def test_save_then_load_roundtrip(tmp_path):
    p = str(tmp_path / "prefs.json")
    save({"borse": ["lse"], "opzioni": {"x": True}}, p)
    prefs, warnings = load(p)
    assert prefs["borse"] == ["lse"] and prefs["opzioni"]["x"] is True
    assert warnings == []


def test_save_refuses_to_write_something_broken(tmp_path):
    """Une config cassée écrite sur le disque serait rechargée chaque matin."""
    p = str(tmp_path / "prefs.json")
    save({"borse": ["mars"]}, p)
    assert load(p)[0]["borse"] == DEFAULT_BORSE


def test_the_example_file_lists_the_available_exchanges(tmp_path):
    path = write_example(str(tmp_path / "prefs.json"))
    data = json.load(io.open(path, encoding="utf-8"))
    assert "euronext" in data["_borse_disponibili"]
    assert "_come_usare" in data


# --------------------------------------------------------------------------
# La langue de lecture — « on ne sait pas lire du chinois »
# --------------------------------------------------------------------------

def test_the_reading_language_defaults_to_italian():
    prefs, _warnings = validate({})
    assert prefs["opzioni"]["lingua"] == "it"


def test_the_reading_language_can_be_changed():
    prefs, warnings = validate({"opzioni": {"lingua": "fr"}})
    assert prefs["opzioni"]["lingua"] == "fr"
    assert warnings == []


def test_an_unsupported_language_falls_back_and_SAYS_so():
    prefs, warnings = validate({"opzioni": {"lingua": "kr"}})
    assert prefs["opzioni"]["lingua"] == "it"
    assert any("lingua" in w for w in warnings), warnings


def test_the_language_is_normalised():
    prefs, _w = validate({"opzioni": {"lingua": "  FR  "}})
    assert prefs["opzioni"]["lingua"] == "fr"
