"""Catalogue des places boursières — pur, aucun réseau.

Les dix opérateurs de la liste de Massii. Tout ce qui est testé ici a été SONDÉ
en réel le 2026-07-29 (symboles, fuseaux, heures d'ouverture, pauses déjeuner).
"""
from zoneinfo import ZoneInfo

import pytest

from pulse.exchanges import (DEFAULT_EXCHANGES, Exchange, by_id, opening_groups,
                             session_windows)
from pulse.news import FEEDS  # noqa: F401  (garde le contrat de flux aligné)


def test_the_ten_venues_of_the_list_are_present():
    ids = [e.id for e in DEFAULT_EXCHANGES]
    assert set(ids) == {"nyse", "nasdaq", "jpx", "euronext", "hkex",
                        "sse", "lse", "nse", "szse", "deutsche_boerse"}
    assert len(ids) == len(set(ids)), "identifiants dupliqués"


def test_every_timezone_is_a_real_iana_zone():
    for e in DEFAULT_EXCHANGES:
        ZoneInfo(e.tz)          # lève si le fuseau n'existe pas


def test_every_opening_hour_is_well_formed():
    for e in DEFAULT_EXCHANGES:
        hour, minute = e.opens_at.split(":")
        assert 0 <= int(hour) <= 23 and 0 <= int(minute) <= 59, e.id


def test_every_venue_has_a_symbol_and_local_press():
    for e in DEFAULT_EXCHANGES:
        assert e.symbol, e.id
        assert e.feeds, "aucune source locale pour %s" % e.id
        for feed in e.feeds:
            assert feed["url"].startswith("https://"), (e.id, feed)
            assert feed["name"] and feed["lang"]


def test_euronext_carries_its_seven_places_including_milan():
    """Euronext est UN opérateur pour sept pays — la bourse du grand-père en
    fait partie, c'est la subtilité de cette entrée."""
    euronext = by_id("euronext")
    places = {p["city"]: p for p in euronext.places}
    assert len(places) == 7
    assert "Milano" in places
    assert places["Milano"]["symbol"] == "FTSEMIB.MI"
    assert places["Milano"]["tz"] == "Europe/Rome"
    for city in ("Amsterdam", "Parigi", "Bruxelles", "Lisbona", "Dublino", "Oslo"):
        assert city in places


def test_only_euronext_groups_several_places():
    for e in DEFAULT_EXCHANGES:
        if e.id != "euronext":
            assert e.places == (), e.id


def test_lunch_breaks_are_declared_where_they_exist():
    """Yahoo rend la séance en UN bloc : sans cette donnée, on afficherait
    « aperto » pendant la pause de Tokyo, ce qui serait faux."""
    assert by_id("jpx").lunch == ("11:30", "12:30")
    assert by_id("hkex").lunch == ("12:00", "13:00")
    assert by_id("sse").lunch == ("11:30", "13:00")
    assert by_id("szse").lunch == ("11:30", "13:00")
    for vid in ("nyse", "nasdaq", "euronext", "lse", "nse", "deutsche_boerse"):
        assert by_id(vid).lunch is None, vid


def test_by_id_returns_none_for_an_unknown_venue():
    assert by_id("bourse-de-mars") is None
    assert by_id("") is None
    assert by_id(None) is None


# --------------------------------------------------------------------------
# Regroupement des ouvertures — dix opérateurs ne font PAS dix déclencheurs
# --------------------------------------------------------------------------

def test_venues_sharing_an_opening_are_grouped():
    """Dix opérateurs ne font que CINQ déclencheurs — mesuré, pas supposé.

    Deux regroupements ne sautent pas aux yeux :
    - Londres ouvre à 08:00 locales, Paris et Francfort à 09:00 : c'est le
      MÊME instant (Londres est toujours une heure derrière l'Europe
      continentale, été comme hiver).
    - Hong Kong 09:30 et Shanghai/Shenzhen 09:30 sont aussi le même instant
      (tous en UTC+8, sans changement d'heure).
    """
    groups = opening_groups(DEFAULT_EXCHANGES)
    keyed = {frozenset(ids) for ids, _tz, _hhmm in groups}
    assert frozenset(["nyse", "nasdaq"]) in keyed
    assert frozenset(["hkex", "sse", "szse"]) in keyed
    assert frozenset(["euronext", "lse", "deutsche_boerse"]) in keyed
    assert frozenset(["jpx"]) in keyed
    assert frozenset(["nse"]) in keyed
    assert len(groups) == 5


def test_the_grouping_holds_in_winter_too():
    """Le regroupement ne doit pas dépendre de la saison : sinon le bot
    produirait cinq briefings l'été et sept l'hiver, sans que rien ne l'ait
    demandé. Vérifié en janvier comme en juillet."""
    from datetime import datetime
    from pulse.exchanges import _minutes_utc
    for day in (datetime(2026, 7, 29), datetime(2026, 1, 15)):
        buckets = {}
        for e in DEFAULT_EXCHANGES:
            buckets.setdefault(_minutes_utc(e, day), []).append(e.id)
        assert len(buckets) == 5, day
        groups = {frozenset(v) for v in buckets.values()}
        assert frozenset(["euronext", "lse", "deutsche_boerse"]) in groups, day
        assert frozenset(["hkex", "sse", "szse"]) in groups, day


def test_each_venue_appears_in_exactly_one_group():
    seen = []
    for ids, _tz, _hhmm in opening_groups(DEFAULT_EXCHANGES):
        seen.extend(ids)
    assert sorted(seen) == sorted(e.id for e in DEFAULT_EXCHANGES)


def test_groups_are_ordered_by_moment_of_opening():
    """L'Asie ouvre avant l'Europe, qui ouvre avant New York : l'ordre du
    briefing de la journée doit suivre le soleil."""
    groups = opening_groups(DEFAULT_EXCHANGES)
    first_ids = groups[0][0]
    last_ids = groups[-1][0]
    assert "jpx" in first_ids
    assert set(last_ids) == {"nyse", "nasdaq"}


def test_grouping_a_subset_only_returns_that_subset():
    subset = [by_id("euronext"), by_id("nyse")]
    groups = opening_groups(subset)
    assert len(groups) == 2
    assert sorted(i for ids, _, _ in groups for i in ids) == ["euronext", "nyse"]


def test_grouping_nothing_is_not_an_error():
    assert opening_groups([]) == []
    assert opening_groups(None) == []


# --------------------------------------------------------------------------
# Fenêtres de séance (pause déjeuner comprise)
# --------------------------------------------------------------------------

def test_session_windows_splits_around_the_lunch_break():
    assert session_windows(by_id("jpx")) == [("09:00", "11:30"), ("12:30", "15:30")]


def test_session_windows_is_a_single_block_without_a_break():
    windows = session_windows(by_id("nyse"))
    assert len(windows) == 1
    assert windows[0][0] == "09:30"


def test_session_windows_needs_a_venue():
    assert session_windows(None) == []


# --------------------------------------------------------------------------
# Le catalogue est sérialisable — l'UI et le briefing le consomment en JSON
# --------------------------------------------------------------------------

def test_a_venue_serialises_to_plain_json():
    import json
    payload = [e.as_dict() for e in DEFAULT_EXCHANGES]
    json.dumps(payload)                       # ne doit pas lever
    milano = [p for p in payload if p["id"] == "euronext"][0]
    assert milano["places"][5]["city"] == "Milano"


def test_exchange_is_immutable():
    """Le catalogue est une constante : personne ne doit le muter en place."""
    with pytest.raises(Exception):
        DEFAULT_EXCHANGES[0].symbol = "PIRATE"


def test_exchange_can_be_built_ad_hoc():
    e = Exchange(id="test", label="Test", country="Nulle part", symbol="^X",
                 index_label="X", tz="Europe/Rome", opens_at="09:00",
                 feeds=({"name": "F", "url": "https://x.test/f", "lang": "it"},))
    assert e.lunch is None and e.places == ()
    assert session_windows(e) == [("09:00", None)]
