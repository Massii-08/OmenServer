"""Résolution nom → symbole, et la règle anti-homonyme. Aucun réseau."""
from pulse.resolve import LANG_VENUE, make_resolver

TREVI = {"quotes": [
    {"quoteType": "EQUITY", "symbol": "TRVI", "shortname": "Trevi Therapeutics, Inc.",
     "exchange": "NMS"},
    {"quoteType": "EQUITY", "symbol": "TFI.MI", "shortname": "TREVI FIN INDUSTRIALE",
     "exchange": "MIL"},
]}
WEBUILD = {"quotes": [
    {"quoteType": "EQUITY", "symbol": "IPJ1.F", "shortname": "Webuild S.p.A.", "exchange": "FRA"},
    {"quoteType": "EQUITY", "symbol": "WBD.MI", "shortname": "WEBUILD", "exchange": "MIL"},
]}
TAP = {"quotes": [
    {"quoteType": "EQUITY", "symbol": "TPR", "shortname": "Tapestry, Inc.", "exchange": "NYQ"},
]}


def _r(payload):
    return make_resolver(fetch=lambda url: payload, pacing_s=0)


def test_an_italian_headline_gets_the_italian_listing():
    """« Webuild » dans une dépêche italienne doit rendre Milan, pas Francfort."""
    assert _r(WEBUILD)("Webuild", "it")["symbol"] == "WBD.MI"


def test_an_italian_homonym_that_has_no_italian_listing_is_ABANDONED():
    """LA règle. « Trevi » italien ne doit JAMAIS ressortir en Trevi
    Therapeutics au Nasdaq : nommer la mauvaise société est pire que n'en
    nommer aucune (piège #31 du dépôt)."""
    only_us = {"quotes": [TREVI["quotes"][0]]}
    assert _r(only_us)("Trevi", "it") is None
    # mais si la cotation italienne existe, on la prend
    assert _r(TREVI)("Trevi", "it")["symbol"] == "TFI.MI"


def test_an_english_headline_designates_no_venue_and_takes_the_first_match():
    assert _r(TREVI)("Trevi", "en")["symbol"] == "TRVI"


def test_the_returned_name_must_really_contain_the_searched_name():
    """« Tap » ne doit pas ressortir en « Tapestry » : garde-fou d'identité."""
    assert _r(TAP)("Tap", "it") is None
    assert _r(TAP)("Tapestry", "en")["symbol"] == "TPR"


def test_non_equity_results_are_ignored():
    etf = {"quotes": [{"quoteType": "ETF", "symbol": "X.TO", "shortname": "Trevi CDR",
                       "exchange": "TOR"}]}
    assert _r(etf)("Trevi", "en") is None


def test_a_dead_or_empty_search_returns_none():
    assert _r(None)("Trevi", "it") is None
    assert _r({})("Trevi", "it") is None
    assert _r({"quotes": []})("Trevi", "it") is None


def test_a_failing_fetch_never_raises():
    def boom(url):
        raise OSError("réseau coupé")
    assert make_resolver(fetch=boom, pacing_s=0)("Trevi", "it") is None


def test_an_empty_name_is_not_searched():
    calls = []
    r = make_resolver(fetch=lambda u: calls.append(u) or TREVI, pacing_s=0)
    assert r("", "it") is None and r(None, "it") is None
    assert calls == []


def test_every_declared_language_maps_to_a_real_venue():
    from pulse.exchanges import DEFAULT_EXCHANGES
    ids = {e.id for e in DEFAULT_EXCHANGES}
    for lang, venue in LANG_VENUE.items():
        assert venue in ids, (lang, venue)
