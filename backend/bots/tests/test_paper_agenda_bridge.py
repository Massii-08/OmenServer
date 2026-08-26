"""Tests du pont AGENDA (banques centrales) — 100 % HORS LIGNE.

Aucun appel réseau, aucune horloge réelle : ``fetch``, ``sleep``, ``now`` et le
collecteur sont injectés.

Choix de méthode : les tests des deux pièges hérités (réunion sur deux jours,
flux BNS servi à l'envers) traversent les **VRAIS parseurs** de
``pulse.agenda`` avec du HTML/XML à la forme mesurée. Doubler le collecteur les
ferait passer à côté de ce qu'ils prétendent vérifier — on saurait seulement
que le pont recopie ce qu'on lui donne.
"""
import json
from datetime import datetime, timedelta

import pytest

from backend.bots.paper import agenda_bridge as ab


NOW = datetime(2026, 9, 15, 10, 0, 0)


@pytest.fixture(autouse=True)
def _isolated_data_dir(tmp_path, monkeypatch):
    """Cache en tmp — jamais le vrai ``data/``."""
    monkeypatch.setattr(ab, "DATA_DIR", tmp_path / "paper_trading")
    return tmp_path


class Recorder(object):
    """Faux ``sleep`` : enregistre au lieu d'attendre."""

    def __init__(self):
        self.calls = []

    def __call__(self, seconds):
        self.calls.append(seconds)


def _day(offset):
    return NOW + timedelta(days=offset)


def _iso(offset):
    return _day(offset).strftime("%Y-%m-%d")


# =========================================================================== #
#  Fixtures à la forme RÉELLE des sources
# =========================================================================== #

def fomc_html(year, month_name, first_day, last_day):
    """Panneau annuel de la page calendrier de la Fed (forme mesurée)."""
    return (
        '<h4><a id="1">%d FOMC Meetings</a></h4>'
        '<div class="fomc-meeting__month"><strong>%s</strong></div>'
        '<div class="fomc-meeting__date">%d-%d</div>'
        % (year, month_name, first_day, last_day))


def snb_rss(items):
    """Flux BNS : ``items`` = [(titre, lien, date ISO)], DANS L'ORDRE DONNÉ."""
    body = "".join(
        "<item><title>%s</title><link>%s</link><cb:date>%s</cb:date></item>"
        % (title, link, when) for (title, link, when) in items)
    return ('<rss xmlns:cb="http://www.cbwiki.net/wiki/index.php/Specification_1.2">'
            '<channel>%s</channel></rss>' % body)


def _fed_source(url="https://fed.test/cal"):
    return ({"name": "Fed", "kind": "fomc_html", "venues": ("nyse",),
             "url": url},)


def _snb_source(url="https://snb.test/rss"):
    return ({"name": "BNS", "kind": "snb_rss", "venues": (),
             "url": url},)


def _collector(sources, pages, curated_path):
    """Un ``collect_agenda`` REEL, mais borné aux sources de fixture."""
    from backend.bots import market_engine
    agenda = market_engine._pulse("agenda")

    def collect(**kwargs):
        kwargs.setdefault("sources", sources)
        kwargs.setdefault("curated_path", str(curated_path))
        kwargs.setdefault("fetch", lambda url: pages[url])
        kwargs.setdefault("sleep", Recorder())
        return agenda.collect_agenda(**kwargs)

    return collect


# =========================================================================== #
#  PUR — normalisation
# =========================================================================== #

def test_normalize_keeps_day_bank_label_and_link():
    rows = ab.normalize([{
        "when": "2026-09-24T08:30:00+0000", "when_ts": 1,
        "what": "BNS — valutazione di politica monetaria",
        "source": "BNS", "source_url": "https://snb.test/x"}])
    assert rows == [{"date": "2026-09-24", "bank": "BNS",
                     "label": "BNS — valutazione di politica monetaria",
                     "source_url": "https://snb.test/x"}]


def test_normalize_drops_what_has_neither_date_nor_label():
    rows = ab.normalize([
        {"when": "", "what": "sans date"},
        {"when": "2026-09-24", "what": ""},
        {"when": "pas-une-date", "what": "illisible"},
        "pas un dictionnaire",
        {"when": "2026-09-24", "what": "bon"},
    ])
    assert [r["label"] for r in rows] == ["bon"]
    assert rows[0]["bank"] == "agenda"        # source absente -> repli neutre


def test_normalize_sorts_by_date():
    rows = ab.normalize([
        {"when": "2026-10-28", "what": "Fed", "source": "Fed"},
        {"when": "2026-09-24", "what": "BNS", "source": "BNS"},
    ])
    assert [r["date"] for r in rows] == ["2026-09-24", "2026-10-28"]


# =========================================================================== #
#  PUR — fenêtrage
# =========================================================================== #

def test_events_within_keeps_today_and_drops_yesterday():
    """Un rendez-vous daté « au jour » compte jusqu'à la fin de sa journée :
    le faire disparaître à 00:00:01 le supprimerait le jour où il compte."""
    rows = [{"date": _iso(-1), "bank": "Fed", "label": "hier"},
            {"date": _iso(0), "bank": "Fed", "label": "aujourd'hui"},
            {"date": _iso(3), "bank": "BCE", "label": "dans trois jours"}]
    kept = ab.events_within(rows, NOW, days=21)
    assert [r["label"] for r in kept] == ["aujourd'hui", "dans trois jours"]


def test_events_within_respects_the_horizon():
    rows = [{"date": _iso(6), "bank": "Fed", "label": "dedans"},
            {"date": _iso(8), "bank": "BCE", "label": "dehors"}]
    assert [r["label"] for r in ab.events_within(rows, NOW, days=7)] == ["dedans"]


def test_events_within_sorts_and_tolerates_garbage():
    rows = ["pas un dict", {"date": "", "label": "x"},
            {"date": _iso(5), "bank": "BCE", "label": "après"},
            {"date": _iso(2), "bank": "Fed", "label": "avant"}]
    assert [r["label"] for r in ab.events_within(rows, NOW)] == ["avant", "après"]


# =========================================================================== #
#  Les deux pièges HÉRITÉS — traversent les vrais parseurs du moteur
# =========================================================================== #

def test_a_two_day_meeting_is_dated_on_the_LAST_day(tmp_path):
    """« 27-28 octobre » se conclut le 28 : annoncer le 27 ferait attendre le
    communiqué un jour trop tôt."""
    target = _day(4)
    url = "https://fed.test/cal"
    pages = {url: fomc_html(target.year, target.strftime("%B"),
                            target.day - 1, target.day)}
    rows = ab.upcoming_events(
        now=NOW, horizon_days=21,
        collect=_collector(_fed_source(url), pages, tmp_path / "absent.json"))
    assert [r["date"] for r in rows] == [target.strftime("%Y-%m-%d")]
    assert "%d-%d" % (target.day - 1, target.day) in rows[0]["label"]
    assert rows[0]["bank"] == "Fed"


def test_the_snb_feed_is_served_farthest_first_and_we_sort_it(tmp_path):
    """Le flux BNS arrive du plus LOINTAIN au plus proche : un parseur qui
    ferait confiance à ``items[0]`` annoncerait le mauvais rendez-vous."""
    far, near = _day(6), _day(2)
    url = "https://snb.test/rss"
    pages = {url: snb_rss([
        ("%s - Monetary policy assessment" % far.strftime("%Y-%m-%d"),
         "https://snb.test/loin", far.strftime("%Y-%m-%dT08:30:00Z")),
        ("%s - Monetary policy assessment" % near.strftime("%Y-%m-%d"),
         "https://snb.test/proche", near.strftime("%Y-%m-%dT08:30:00Z")),
    ])}
    rows = ab.upcoming_events(
        now=NOW, horizon_days=21,
        collect=_collector(_snb_source(url), pages, tmp_path / "absent.json"))
    assert [r["date"] for r in rows] == [near.strftime("%Y-%m-%d"),
                                         far.strftime("%Y-%m-%d")]
    assert rows[0]["source_url"] == "https://snb.test/proche"


def test_a_past_meeting_never_comes_out(tmp_path):
    past = _day(-30)
    url = "https://fed.test/cal"
    pages = {url: fomc_html(past.year, past.strftime("%B"), past.day, past.day)}
    assert ab.upcoming_events(
        now=NOW, horizon_days=21,
        collect=_collector(_fed_source(url), pages, tmp_path / "absent.json")) == []


# =========================================================================== #
#  Cache 24 h
# =========================================================================== #

class CountingCollector(object):
    def __init__(self, rows):
        self.rows = rows
        self.calls = 0

    def __call__(self, **kwargs):
        self.calls += 1
        return {"events": list(self.rows)}


def _raw(offset, what="Fed — riunione del FOMC", source="Fed"):
    return {"when": _iso(offset), "when_ts": 0, "what": what,
            "source": source, "source_url": "https://fed.test/cal"}


def test_a_fresh_cache_costs_zero_request():
    collector = CountingCollector([_raw(3)])
    first = ab.upcoming_events(now=NOW, collect=collector)
    assert [r["date"] for r in first] == [_iso(3)]
    assert collector.calls == 1

    second = ab.upcoming_events(now=NOW + timedelta(hours=6), collect=collector)
    assert [r["date"] for r in second] == [_iso(3)]
    assert collector.calls == 1                  # servi par le cache


def test_the_cache_file_is_0600_and_readable():
    ab.upcoming_events(now=NOW, collect=CountingCollector([_raw(3)]))
    path = ab.cache_path()
    assert oct(path.stat().st_mode & 0o777) == "0o600"
    data = json.loads(path.read_text(encoding="utf-8"))
    assert data["events"][0]["label"].startswith("Fed")
    assert "fetched_ts" in data and "fetched_at" in data


def test_an_expired_cache_is_refreshed():
    collector = CountingCollector([_raw(3)])
    ab.upcoming_events(now=NOW, collect=collector)
    ab.upcoming_events(now=NOW + timedelta(hours=25), collect=collector)
    assert collector.calls == 2


def test_force_bypasses_a_fresh_cache():
    collector = CountingCollector([_raw(3)])
    ab.upcoming_events(now=NOW, collect=collector)
    ab.upcoming_events(now=NOW, collect=collector, force=True)
    assert collector.calls == 2


def test_a_stale_cache_survives_a_dead_source_but_still_drops_past_dates():
    """Cinq banques centrales muettes en même temps, c'est un incident réseau —
    pas un monde sans réunions. Le périmé ressort, MAIS re-fenêtré : la réunion
    devenue passée entre-temps ne repasse pas pour « à venir »."""
    ab.upcoming_events(now=NOW, collect=CountingCollector([_raw(1), _raw(10)]))

    def boom(**kwargs):
        raise RuntimeError("fed injoignable")

    later = NOW + timedelta(days=5)              # cache périmé + une date passée
    rows = ab.upcoming_events(now=later, collect=boom)
    assert [r["date"] for r in rows] == [_iso(10)]


def test_an_empty_collection_does_not_wipe_a_usable_cache():
    ab.upcoming_events(now=NOW, collect=CountingCollector([_raw(4)]))
    rows = ab.upcoming_events(now=NOW + timedelta(hours=25),
                              collect=CountingCollector([]))
    assert [r["date"] for r in rows] == [_iso(4)]


def test_a_corrupt_cache_is_just_an_empty_cache():
    ab.cache_path().parent.mkdir(parents=True, exist_ok=True)
    ab.cache_path().write_text("<<<pas du json>>>", encoding="utf-8")
    collector = CountingCollector([_raw(2)])
    assert [r["date"] for r in ab.upcoming_events(now=NOW, collect=collector)] \
        == [_iso(2)]
    assert collector.calls == 1


# =========================================================================== #
#  Déploiement partiel et pannes — l'agenda ne coûte JAMAIS une réponse
# =========================================================================== #

def test_without_the_market_pulse_engine_the_agenda_is_empty(monkeypatch):
    monkeypatch.setattr(ab, "agenda_module", lambda: None)
    assert ab.upcoming_events(now=NOW) == []


def test_a_collector_that_explodes_never_raises():
    def boom(**kwargs):
        raise RuntimeError("boom")

    assert ab.upcoming_events(now=NOW, collect=boom) == []


def test_the_real_engine_module_is_reachable():
    """Ceinture : le pont ne sert à rien si ``pulse.agenda`` n'est pas
    joignable depuis le backend (répertoire frère au nom tirété)."""
    module = ab.agenda_module()
    assert module is not None
    assert hasattr(module, "collect_agenda")


def test_pacing_and_fetch_are_forwarded_to_the_engine():
    """``fetch`` et ``sleep`` doivent VRAIMENT descendre jusqu'au moteur :
    sans ça, un test « hors ligne » irait sur le vrai site de la Fed."""
    seen = {}

    def collect(**kwargs):
        seen.update(kwargs)
        return {"events": []}

    sleeper = Recorder()
    ab.upcoming_events(now=NOW, fetch=lambda url: "", sleep=sleeper,
                       horizon_days=7, collect=collect)
    assert seen["horizon_h"] == 7 * 24.0
    assert seen["sleep"] is sleeper
    assert callable(seen["fetch"])
    assert seen["max_items"] == ab.MAX_ITEMS
