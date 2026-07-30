"""Passerelle backend → moteur `market-pulse/`.

Le moteur vit dans un répertoire FRÈRE au nom tirété (`market-pulse/`), donc
`import pulse.prefs` ne marche pas tel quel depuis le backend. Ce module est le
seul endroit du backend qui connaît ce détail — d'où des tests qui vérifient
qu'il expose bien ce que le router attend, et rien de plus.
"""
import json

import pytest

from backend.bots import market_engine as me


def test_the_engine_is_reachable_from_the_backend():
    assert me.available() is True


def test_the_catalogue_carries_the_ten_operators():
    rows = me.catalogue()
    ids = [r["id"] for r in rows]
    assert len(ids) == 10, ids
    assert "euronext" in ids and "nyse" in ids and "jpx" in ids


def test_each_catalogue_row_carries_what_the_ui_needs_to_draw_a_block():
    for row in me.catalogue():
        assert set(row) >= {"id", "label", "country", "symbol", "index_label",
                            "tz", "opens_at", "closes_at", "lunch", "places"}


def test_euronext_carries_its_seven_places_including_milan():
    euronext = [r for r in me.catalogue() if r["id"] == "euronext"][0]
    cities = [p["city"] for p in euronext["places"]]
    assert "Milano" in cities, cities
    assert len(cities) == 7, cities


def test_ten_operators_are_regrouped_into_their_real_openings():
    # NYSE et Nasdaq sonnent au même instant : un seul groupe, donc un seul
    # briefing et un seul appel au LLM.
    groups = me.opening_groups(["nyse", "nasdaq", "jpx"])
    assert len(groups) == 2, groups
    sizes = sorted(len(ids) for ids, _tz, _at in groups)
    assert sizes == [1, 2]


def test_no_selection_means_no_group_never_all_ten():
    # Une sélection vide venue d'une config doit produire ZÉRO briefing, pas les
    # dix en silence. C'est la classe de bug la plus coûteuse du dépôt.
    assert me.opening_groups([]) == []
    assert me.opening_groups(None) == []


def test_an_unknown_exchange_id_is_ignored_not_a_crash():
    groups = me.opening_groups(["nyse", "pas-une-bourse"])
    assert len(groups) == 1


def test_prefs_round_trip_on_disk(tmp_path):
    path = str(tmp_path / "prefs.json")
    saved = me.save_prefs({"borse": ["nyse", "jpx"]}, path)
    assert saved["borse"] == ["nyse", "jpx"]
    loaded, warnings = me.load_prefs(path)
    assert loaded["borse"] == ["nyse", "jpx"]
    assert warnings == []


def test_prefs_without_a_file_are_the_defaults_not_an_error(tmp_path):
    loaded, _warnings = me.load_prefs(str(tmp_path / "absent.json"))
    assert loaded["borse"]
    assert "opzioni" in loaded


def test_an_invalid_exchange_is_dropped_and_SAID(tmp_path):
    path = str(tmp_path / "prefs.json")
    me.save_prefs({"borse": ["nyse", "bruxelles-la-vraie"]}, path)
    loaded, warnings = me.load_prefs(path)
    assert loaded["borse"] == ["nyse"]
    # Écrit à la main, une faute de frappe doit se VOIR, pas se perdre.
    _clean, warns = me.validate_prefs({"borse": ["nyse", "bruxelles-la-vraie"]})
    assert any("bruxelles" in w for w in warns), warns


def test_a_broken_prefs_file_falls_back_without_raising(tmp_path):
    path = tmp_path / "prefs.json"
    path.write_text("{ pas du json", encoding="utf-8")
    loaded, warnings = me.load_prefs(str(path))
    assert loaded["borse"]
    assert warnings


def test_saving_never_writes_a_broken_config(tmp_path):
    path = str(tmp_path / "prefs.json")
    me.save_prefs({"borse": "pas une liste", "opzioni": {"max_notizie": "beaucoup"}}, path)
    on_disk = json.loads(open(path, encoding="utf-8").read())
    assert isinstance(on_disk["borse"], list) and on_disk["borse"]
    assert isinstance(on_disk["opzioni"]["max_notizie"], int)


def test_the_default_prefs_path_is_under_the_data_directory():
    assert me.prefs_default_path().endswith("data/market_pulse/prefs.json")
