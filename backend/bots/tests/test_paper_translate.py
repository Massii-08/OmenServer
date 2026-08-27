"""Tests de la traduction des titres de presse ÉTRANGERS non lisibles par
Massii (allemand aujourd'hui -- NZZ/cash.ch/Handelsblatt) -- 100% hors ligne.

``detect_lang`` / ``lookup`` / ``_title_key`` / ``_normalize_title`` /
``_build_prompt`` / ``_parse_translations`` / ``_evict_oldest`` sont PURS
(zéro I/O). ``cache_path`` / ``load_cache`` / ``save_cache`` / ``run_sweep``
font l'I/O -- disque isolé via ``store.DATA_DIR`` (monkeypatché vers
``tmp_path``, même fixture autouse que ``test_paper_calendar.py``), LLM et
horloge TOUJOURS injectés dans ``run_sweep`` : aucun test ne touche le vrai
CLI Claude.

Doctrine du module (« économie LLM par construction ») : la collecte/le rendu
sont 0-LLM, ``run_sweep`` est le SEUL chemin qui en fait un, et borné (gate
horaire + cap par sweep + UN appel par sweep quel que soit le nombre de
candidats).
"""
import json
import os
import stat
from datetime import datetime, timedelta, timezone

import pytest

from backend.bots.paper import store, translate

NOW = datetime(2026, 8, 27, 10, 0, 0, tzinfo=timezone.utc)
# ``run_sweep`` normalise l'horloge en UTC NAÏF avant de la persister (même
# doctrine que calendar.py) -- ``NOW.isoformat()`` porterait encore le
# suffixe ``+00:00`` de l'entrée, jamais celui qu'on retrouve dans le cache.
NOW_ISO = "2026-08-27T10:00:00"


@pytest.fixture(autouse=True)
def _isolate_data_dir(tmp_path, monkeypatch):
    monkeypatch.setattr(store, "DATA_DIR", tmp_path)
    yield


def _de_title(i):
    """Un titre de presse allemand SYNTHÉTIQUE mais riche en mots-vides
    (die/vor/einem/für/den) -- large marge sur le seuil de majorité, pour ne
    pas dépendre d'un cas limite."""
    return "Die Nestlé Bank warnt vor einem Rückgang für den Titel Nummer %d" % i


def _de_event(i, title=None):
    return {"ts": NOW.isoformat(), "symbol": "NESN.SW",
            "title": title or _de_title(i),
            "link": "http://nzz.test/%d" % i, "sentiment": "neg"}


# =========================================================================== #
#  PUR -- detect_lang
# =========================================================================== #

def test_detect_lang_german_real_headline():
    title = ("Nächster Nackenschlag für Nestlé: Zürcher Bank straft den Titel "
             "gleich an zwei Fronten ab")
    assert translate.detect_lang(title) == "de"


def test_detect_lang_english():
    title = "The company posted strong earnings and raised its outlook for the year"
    assert translate.detect_lang(title) == "en"


def test_detect_lang_french():
    title = ("Le gouvernement annonce une nouvelle réforme des retraites "
             "pour les prochaines années")
    assert translate.detect_lang(title) == "fr"


def test_detect_lang_italian():
    title = "Il governo annuncia una nuova riforma delle pensioni per i prossimi anni"
    assert translate.detect_lang(title) == "it"


def test_detect_lang_short_ambiguous_title_is_none():
    """« Nvidia Q3 » : aucun mot-vide reconnu d'aucune langue -- ni court par
    le nombre de mots (2), ni de majorité -- le cas cité par la spec."""
    assert translate.detect_lang("Nvidia Q3") is None


def test_detect_lang_single_word_is_none():
    assert translate.detect_lang("Nestlé") is None


def test_detect_lang_ambiguous_tie_is_none():
    """« an » est un mot-vide ALLEMAND ET ANGLAIS -- répété seul, égalité
    stricte entre les deux comptes -> aucun verdict plutôt qu'un tirage au
    sort."""
    assert translate.detect_lang("an an an") is None


def test_detect_lang_empty_or_none_is_none():
    assert translate.detect_lang("") is None
    assert translate.detect_lang(None) is None


def test_detect_lang_is_case_insensitive():
    assert translate.detect_lang(
        "DIE NESTLÉ BANK WARNT VOR EINEM RÜCKGANG FÜR DEN TITEL") == "de"


# =========================================================================== #
#  PUR -- _title_key / _normalize_title / lookup
# =========================================================================== #

def test_title_key_is_stable_across_case_and_whitespace():
    a = translate._title_key("Nestlé   unter Druck")
    b = translate._title_key("  nestlé unter   druck  ")
    assert a == b


def test_title_key_differs_for_different_titles():
    assert translate._title_key("Titre un") != translate._title_key("Titre deux")


def test_lookup_hits_a_cached_title():
    key = translate._title_key("Nestlé unter Druck")
    cache = {"entries": {key: {"fr": "Nestlé sous pression", "src": "de",
                               "ts": NOW.isoformat()}}}
    assert translate.lookup("Nestlé unter Druck", cache) == \
        {"fr": "Nestlé sous pression", "src": "de", "ts": NOW.isoformat()}


def test_lookup_is_insensitive_to_whitespace_and_case():
    key = translate._title_key("Nestlé unter Druck")
    cache = {"entries": {key: {"fr": "Nestlé sous pression", "src": "de",
                               "ts": NOW.isoformat()}}}
    assert translate.lookup("  NESTLÉ   UNTER DRUCK  ", cache) is not None


def test_lookup_misses_an_unknown_title():
    cache = {"entries": {translate._title_key("Autre titre"): {"fr": "x"}}}
    assert translate.lookup("Titre jamais vu", cache) is None


def test_lookup_on_malformed_cache_is_none_not_an_exception():
    assert translate.lookup("peu importe", {}) is None
    assert translate.lookup("peu importe", {"entries": "pas un dict"}) is None
    assert translate.lookup("peu importe", {"entries": {}}) is None


def test_lookup_empty_title_is_none():
    cache = {"entries": {translate._title_key(""): {"fr": "x"}}}
    assert translate.lookup("", cache) is None
    assert translate.lookup(None, cache) is None


# =========================================================================== #
#  PUR -- _evict_oldest
# =========================================================================== #

def test_evict_oldest_keeps_the_most_recent_entries():
    entries = {
        "a": {"ts": "2026-08-01T00:00:00"},
        "b": {"ts": "2026-08-03T00:00:00"},
        "c": {"ts": "2026-08-02T00:00:00"},
    }
    translate._evict_oldest(entries, 2)
    assert set(entries.keys()) == {"b", "c"}


def test_evict_oldest_is_a_noop_under_the_cap():
    entries = {"a": {"ts": "2026-08-01T00:00:00"}}
    translate._evict_oldest(entries, 10)
    assert set(entries.keys()) == {"a"}


def test_evict_oldest_tolerates_a_missing_or_malformed_ts():
    entries = {
        "a": {"ts": "2026-08-03T00:00:00"},
        "b": {},                       # pas de ts -- traité comme le plus ancien
        "c": {"ts": "2026-08-02T00:00:00"},
    }
    translate._evict_oldest(entries, 2)
    assert "b" not in entries
    assert set(entries.keys()) == {"a", "c"}


# =========================================================================== #
#  PUR -- _parse_translations (parse numéroté TOLÉRANT)
# =========================================================================== #

def test_parse_translations_clean_numbered_reply():
    raw = "1. Bonjour le monde\n2. Au revoir"
    assert translate._parse_translations(raw, 2) == \
        {1: "Bonjour le monde", 2: "Au revoir"}


def test_parse_translations_tolerates_a_missing_line():
    raw = "1. Bonjour le monde"
    assert translate._parse_translations(raw, 2) == {1: "Bonjour le monde"}


def test_parse_translations_ignores_prose_around_the_numbered_lines():
    raw = "Voici les traductions :\n1. Bonjour\n2. Au revoir\nVoilà, c'est tout."
    assert translate._parse_translations(raw, 2) == {1: "Bonjour", 2: "Au revoir"}


def test_parse_translations_tolerates_various_separators():
    raw = "1) Bonjour\n2: Au revoir"
    assert translate._parse_translations(raw, 2) == {1: "Bonjour", 2: "Au revoir"}


def test_parse_translations_ignores_out_of_range_indices():
    raw = "1. Bonjour\n5. Hors plage"
    assert translate._parse_translations(raw, 1) == {1: "Bonjour"}


def test_parse_translations_non_string_input_is_empty():
    assert translate._parse_translations(None, 3) == {}
    assert translate._parse_translations(123, 3) == {}
    assert translate._parse_translations([], 3) == {}


def test_parse_translations_blank_line_after_number_is_skipped():
    raw = "1. \n2. Au revoir"
    assert translate._parse_translations(raw, 2) == {2: "Au revoir"}


def test_parse_translations_empty_string_is_empty():
    assert translate._parse_translations("", 3) == {}


# =========================================================================== #
#  I/O -- cache_path / load_cache / save_cache
# =========================================================================== #

def test_cache_path_has_a_dot_in_its_radical():
    """Convention anti-fantôme du dépôt (cf. calendar.STATE_NAME) : un fichier
    de data/paper_trading/ SANS point dans son radical serait pris pour un
    COMPTE par radar._users_with_portfolio (regex ``^[A-Za-z0-9_-]+\\.json$``)."""
    name = translate.cache_path().name
    assert name == "translations.cache.json"
    radical = name.rsplit(".json", 1)[0]
    assert "." in radical


def test_load_cache_absent_file_is_a_blank_default():
    assert translate.load_cache() == {"last_sweep_ts": None, "entries": {}}


def test_save_then_load_roundtrips():
    cache = {"last_sweep_ts": NOW.isoformat(),
             "entries": {"abc123": {"fr": "Bonjour", "src": "de",
                                    "ts": NOW.isoformat()}}}
    translate.save_cache(cache)
    assert translate.load_cache() == cache


def test_save_cache_is_0600():
    translate.save_cache({"last_sweep_ts": None, "entries": {}})
    mode = stat.S_IMODE(os.stat(str(translate.cache_path())).st_mode)
    assert mode == 0o600


def test_save_cache_leaves_no_tmp_file_behind():
    translate.save_cache({"last_sweep_ts": None, "entries": {}})
    leftovers = [p for p in translate.cache_path().parent.iterdir()
                if p.name.startswith(".translations.cache.json.tmp-")]
    assert leftovers == []


def test_load_cache_corrupt_json_returns_blank_default():
    path = translate.cache_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("{not json", encoding="utf-8")
    assert translate.load_cache() == {"last_sweep_ts": None, "entries": {}}


def test_load_cache_not_a_dict_returns_blank_default():
    path = translate.cache_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps([1, 2, 3]), encoding="utf-8")
    assert translate.load_cache() == {"last_sweep_ts": None, "entries": {}}


def test_load_cache_drops_malformed_entries():
    path = translate.cache_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({
        "last_sweep_ts": "2026-08-27T00:00:00",
        "entries": {"good": {"fr": "Bonjour", "src": "de", "ts": "x"},
                    "bad": "pas un dict",
                    "bad2": {"src": "de"}},          # pas de "fr"
    }), encoding="utf-8")
    cache = translate.load_cache()
    assert list(cache["entries"].keys()) == ["good"]
    assert cache["last_sweep_ts"] == "2026-08-27T00:00:00"


def test_load_cache_malformed_last_sweep_ts_becomes_none():
    path = translate.cache_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({"last_sweep_ts": 12345, "entries": {}}),
                    encoding="utf-8")
    assert translate.load_cache()["last_sweep_ts"] is None


# =========================================================================== #
#  I/O -- run_sweep
# =========================================================================== #

def test_run_sweep_first_ever_call_is_not_too_soon():
    """Aucun cache -> jamais balayé -> PAS trop tôt."""
    result = translate.run_sweep(now=NOW, llm=lambda p: "1. Traduction",
                                 events=[_de_event(1)])
    assert result["translated"] == 1


def test_run_sweep_too_soon_is_a_noop():
    translate.save_cache({"last_sweep_ts": NOW.isoformat(), "entries": {}})
    calls = []
    llm = lambda prompt: calls.append(prompt) or "1. peu importe"
    later = NOW + timedelta(minutes=30)      # sous le seuil d'1h
    result = translate.run_sweep(now=later, llm=llm, events=[_de_event(1)])
    assert result == {"translated": 0, "skipped": "too_soon"}
    assert calls == []


def test_run_sweep_runs_again_after_the_hour():
    translate.save_cache({"last_sweep_ts": NOW.isoformat(), "entries": {}})
    later = NOW + timedelta(hours=1, seconds=1)
    result = translate.run_sweep(now=later, llm=lambda p: "1. Traduction",
                                 events=[_de_event(1)])
    assert result["translated"] == 1


def test_run_sweep_translates_german_candidates_and_caches_them():
    events = [_de_event(1), _de_event(2)]
    result = translate.run_sweep(
        now=NOW, llm=lambda p: "1. Traduction Un\n2. Traduction Deux",
        events=events)
    assert result["translated"] == 2
    cache = translate.load_cache()
    assert translate.lookup(events[0]["title"], cache) == \
        {"fr": "Traduction Un", "src": "de", "ts": NOW_ISO}
    assert translate.lookup(events[1]["title"], cache) == \
        {"fr": "Traduction Deux", "src": "de", "ts": NOW_ISO}


def test_run_sweep_calls_the_llm_exactly_once_for_many_candidates():
    calls = []

    def llm(prompt):
        calls.append(prompt)
        return "\n".join("%d. T%d" % (i, i) for i in range(1, 21))

    events = [_de_event(i) for i in range(20)]
    result = translate.run_sweep(now=NOW, llm=llm, events=events)
    assert len(calls) == 1
    assert result["translated"] == 20


def test_run_sweep_cap_is_40_candidates_per_sweep():
    calls = []

    def llm(prompt):
        calls.append(prompt)
        return "\n".join("%d. T%d" % (i, i) for i in range(1, 41))

    events = [_de_event(i) for i in range(50)]
    result = translate.run_sweep(now=NOW, llm=llm, events=events)
    assert len(calls) == 1
    assert result["translated"] == translate.SWEEP_CAP == 40
    cache = translate.load_cache()
    # Les 10 dépassant le cap ne sont PAS en cache -- ils retenteront au sweep
    # suivant (au lieu d'être perdus).
    assert translate.lookup(events[49]["title"], cache) is None
    assert translate.lookup(events[0]["title"], cache) is not None


def test_run_sweep_skips_non_german_candidates():
    fr_event = {"ts": NOW.isoformat(), "symbol": "X", "link": "http://x/1",
                "title": ("Le gouvernement annonce une nouvelle réforme des "
                         "retraites pour tous")}
    en_event = {"ts": NOW.isoformat(), "symbol": "X", "link": "http://x/2",
                "title": ("The company posted strong earnings and raised "
                         "its outlook")}
    it_event = {"ts": NOW.isoformat(), "symbol": "X", "link": "http://x/3",
                "title": ("Il governo annuncia una nuova riforma delle "
                         "pensioni per tutti")}
    calls = []
    llm = lambda prompt: calls.append(prompt) or "1. peu importe"
    result = translate.run_sweep(now=NOW, llm=llm,
                                 events=[fr_event, en_event, it_event])
    assert result == {"translated": 0, "skipped": "no_candidates"}
    assert calls == []


def test_run_sweep_skips_titles_already_in_cache():
    ev = _de_event(1)
    translate.save_cache({"last_sweep_ts": None, "entries": {
        translate._title_key(ev["title"]):
            {"fr": "Déjà traduit", "src": "de", "ts": NOW.isoformat()}}})
    calls = []
    llm = lambda prompt: calls.append(prompt) or "1. Nouveau"
    result = translate.run_sweep(now=NOW, llm=llm, events=[ev])
    assert result == {"translated": 0, "skipped": "no_candidates"}
    assert calls == []


def test_run_sweep_dedups_repeated_titles_within_the_same_batch():
    ev = _de_event(1)
    calls = []

    def llm(prompt):
        calls.append(prompt)
        return "1. Traduction unique"

    result = translate.run_sweep(now=NOW, llm=llm, events=[ev, dict(ev)])
    assert len(calls) == 1
    assert result["translated"] == 1


def test_run_sweep_llm_failure_is_swallowed_but_sweep_is_marked():
    def boom(prompt):
        raise RuntimeError("cli indisponible")

    result = translate.run_sweep(now=NOW, llm=boom, events=[_de_event(1)])
    assert result == {"translated": 0, "skipped": "llm_failed"}
    # Le sweep est quand même marqué fait -- pas de tempête de tentatives à
    # chaque cycle de 5 min tant que le CLI reste en panne.
    assert translate.load_cache()["last_sweep_ts"] == NOW_ISO


def test_run_sweep_updates_last_sweep_ts_even_with_zero_candidates():
    result = translate.run_sweep(now=NOW, llm=lambda p: "1. x", events=[])
    assert result == {"translated": 0, "skipped": "no_candidates"}
    assert translate.load_cache()["last_sweep_ts"] == NOW_ISO


def test_run_sweep_never_raises_on_broken_events():
    result = translate.run_sweep(now=NOW, llm=lambda p: "1. x",
                                 events="pas une liste")
    assert result["translated"] == 0
    result2 = translate.run_sweep(
        now=NOW + timedelta(hours=2), llm=lambda p: "1. x",
        events=[{"ts": NOW.isoformat()}, "pas un dict", None, 42])
    assert result2["translated"] == 0


def test_run_sweep_ignores_events_without_a_readable_title():
    events = [{"ts": NOW.isoformat()}, {"title": ""}, {"title": None}]
    result = translate.run_sweep(now=NOW, llm=lambda p: "1. x", events=events)
    assert result == {"translated": 0, "skipped": "no_candidates"}


def test_run_sweep_prompt_lists_every_candidate_numbered():
    captured = {}

    def llm(prompt):
        captured["prompt"] = prompt
        return "1. A\n2. B"

    ev1, ev2 = _de_event(1), _de_event(2)
    translate.run_sweep(now=NOW, llm=llm, events=[ev1, ev2])
    assert ("1. " + ev1["title"]) in captured["prompt"]
    assert ("2. " + ev2["title"]) in captured["prompt"]


def test_run_sweep_tolerates_a_missing_translation_line():
    """Une ligne absente de la réponse -- ce titre-là repart bredouille (il
    n'entre pas dans le cache, il retentera au sweep suivant), les autres
    sont quand même traduits."""
    ev1, ev2 = _de_event(1), _de_event(2)
    result = translate.run_sweep(now=NOW, llm=lambda p: "2. Traduction Deux",
                                 events=[ev1, ev2])
    assert result["translated"] == 1
    cache = translate.load_cache()
    assert translate.lookup(ev1["title"], cache) is None
    assert translate.lookup(ev2["title"], cache) is not None


def test_run_sweep_evicts_the_oldest_entries_beyond_the_cap(monkeypatch):
    monkeypatch.setattr(translate, "CACHE_CAP", 2)
    translate.save_cache({"last_sweep_ts": None, "entries": {
        "old1": {"fr": "Vieux 1", "src": "de", "ts": "2020-01-01T00:00:00"},
        "old2": {"fr": "Vieux 2", "src": "de", "ts": "2020-01-02T00:00:00"},
    }})
    ev = _de_event(1)
    translate.run_sweep(now=NOW, llm=lambda p: "1. Nouveau", events=[ev])
    cache = translate.load_cache()
    assert len(cache["entries"]) == 2
    assert "old1" not in cache["entries"]           # le plus ancien saute
    assert "old2" in cache["entries"]
    assert translate.lookup(ev["title"], cache) is not None


def test_run_sweep_default_llm_is_the_paper_llm_module(monkeypatch):
    """Sans ``llm=``, l'appel tombe sur le CLI Claude via ``paper/llm.py`` --
    câblage vérifié en substituant ``_claude_text``, jamais le vrai binaire."""
    from backend.bots.paper import llm as llm_mod
    calls = []
    monkeypatch.setattr(llm_mod, "_claude_text",
                        lambda prompt, **kw: calls.append(prompt) or "1. Traduit")
    result = translate.run_sweep(now=NOW, events=[_de_event(1)])
    assert len(calls) == 1
    assert result["translated"] == 1
