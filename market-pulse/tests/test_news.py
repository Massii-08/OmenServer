"""Collecte presse — hors ligne, sur des flux RSS RÉELS capturés le 2026-07-28.

Aucun accès réseau : `fetch` et `now_ts` sont injectés.
"""
import os

import pytest

from pulse.news import FEEDS, collect_news, parse_feed

FIXTURES = os.path.join(os.path.dirname(__file__), "fixtures")

# 2026-07-28 20:20 UTC — juste après la capture des flux.
NOW = 1785270000


def _raw(name):
    with open(os.path.join(FIXTURES, name), "rb") as f:
        return f.read()


ILSOLE = _raw("feed_ilsole.xml")
CNBC = _raw("feed_cnbc.xml")
ANSA = _raw("feed_ansa.xml")
GNEWS = _raw("feed_gnews.xml")


# --------------------------------------------------------------------------
# Parsing
# --------------------------------------------------------------------------

def test_parses_real_italian_feed():
    items = parse_feed(ILSOLE, "Il Sole 24 Ore", "it")
    assert len(items) >= 30
    first = items[0]
    assert first["title"]
    assert first["url"].startswith("http")
    assert first["source"] == "Il Sole 24 Ore"
    assert first["lang"] == "it"
    assert isinstance(first["published"], int)


def test_parses_real_english_feed():
    items = parse_feed(CNBC, "CNBC", "en")
    assert len(items) >= 25
    assert all(i["source"] == "CNBC" for i in items)


def test_parses_feed_with_offset_dates():
    """ANSA date en +0200, pas en GMT — les deux doivent donner un epoch."""
    items = parse_feed(ANSA, "ANSA", "it")
    assert items and isinstance(items[0]["published"], int)
    assert items[0]["published"] > 1_700_000_000


def test_google_news_titles_drop_the_source_suffix():
    """Google News suffixe « - NomDuJournal » à chaque titre ; on le retire et
    on garde le vrai nom de la source, sinon chaque titre traîne du bruit."""
    items = parse_feed(GNEWS, "Google News", "it")
    assert items
    assert not any(i["title"].endswith(" - " + i["title"].split(" - ")[-1])
                   and i["title"].count(" - ") == 1 and i["source"] == "Google News"
                   for i in items[:5]), "suffixe de source non retiré"


def test_parses_atom_feed():
    atom = b"""<?xml version="1.0" encoding="utf-8"?>
    <feed xmlns="http://www.w3.org/2005/Atom">
      <entry>
        <title>Titolo atom</title>
        <link href="https://example.test/a"/>
        <updated>2026-07-28T18:00:00Z</updated>
      </entry>
    </feed>"""
    items = parse_feed(atom, "Fonte Atom", "it")
    assert len(items) == 1
    assert items[0]["title"] == "Titolo atom"
    assert items[0]["url"] == "https://example.test/a"
    assert items[0]["published"]


def test_parse_feed_on_garbage_returns_empty_not_exception():
    assert parse_feed(b"pas du xml <<<", "X", "it") == []
    assert parse_feed(b"", "X", "it") == []
    assert parse_feed(None, "X", "it") == []


def test_parse_feed_skips_items_without_a_title():
    rss = b"""<rss><channel>
      <item><link>https://a.test</link></item>
      <item><title>Vero titolo</title><link>https://b.test</link></item>
    </channel></rss>"""
    items = parse_feed(rss, "X", "it")
    assert [i["title"] for i in items] == ["Vero titolo"]


# --------------------------------------------------------------------------
# Collecte
# --------------------------------------------------------------------------

def _feeds(*names):
    return [{"name": n, "url": "https://example.test/" + n, "lang": "it"} for n in names]


def _fetch_map(mapping):
    def fetch(url):
        for key, payload in mapping.items():
            if url.endswith(key):
                if isinstance(payload, Exception):
                    raise payload
                return payload
        raise OSError("404")
    return fetch


def test_collect_merges_sources_and_reports_which_worked():
    out = collect_news(fetch=_fetch_map({"a": ILSOLE, "b": CNBC}),
                       feeds=_feeds("a", "b"), now_ts=NOW)
    assert set(out["sources_ok"]) == {"a", "b"}
    assert out["sources_failed"] == []
    assert out["items"]
    assert out["generated_at"] == NOW


def test_a_dead_source_does_not_kill_the_others():
    out = collect_news(
        fetch=_fetch_map({"a": ILSOLE, "b": OSError("timeout")}),
        feeds=_feeds("a", "b"), now_ts=NOW)
    assert out["sources_ok"] == ["a"]
    assert [f["source"] for f in out["sources_failed"]] == ["b"]
    assert "timeout" in out["sources_failed"][0]["error"]
    assert out["items"]


def test_all_sources_dead_gives_an_empty_but_valid_payload():
    out = collect_news(fetch=_fetch_map({"zz": OSError("nope")}),
                       feeds=_feeds("a", "b"), now_ts=NOW)
    assert out["items"] == []
    assert out["themes"] == []
    assert len(out["sources_failed"]) == 2


def test_stale_items_are_dropped():
    """Un flux peut répondre 200 avec des titres d'il y a une semaine — c'est
    le piège des flux abandonnés. Le rapport du matin n'en veut pas."""
    fresh = collect_news(fetch=_fetch_map({"a": ILSOLE}), feeds=_feeds("a"),
                         now_ts=NOW, max_age_h=36)
    stale = collect_news(fetch=_fetch_map({"a": ILSOLE}), feeds=_feeds("a"),
                         now_ts=NOW + 30 * 86400, max_age_h=36)
    assert fresh["items"]
    assert stale["items"] == []
    assert stale["sources_ok"] == ["a"]          # la source a répondu…
    assert stale["stale_sources"] == ["a"]       # …mais n'a rien d'actuel


def test_advice_headlines_are_filtered_and_counted():
    """Un titre de presse peut ÊTRE un conseil (« 3 stocks to buy »). Le bot
    n'en relaie aucun — et le dit, au lieu de les faire disparaître."""
    rss = b"""<rss><channel>
      <item><title>3 stocks to buy right now</title><link>https://a.test</link></item>
      <item><title>Le azioni da comprare secondo gli analisti</title><link>https://b.test</link></item>
      <item><title>Wall Street apre in rialzo</title><link>https://c.test</link></item>
    </channel></rss>"""
    out = collect_news(fetch=_fetch_map({"a": rss}), feeds=_feeds("a"),
                       now_ts=NOW, max_age_h=10 ** 6)
    titles = [i["title"] for i in out["items"]]
    assert titles == ["Wall Street apre in rialzo"]
    assert out["filtered_advice"] == 2


def test_duplicate_titles_across_sources_are_merged():
    rss = b"""<rss><channel>
      <item><title>Stessa notizia</title><link>https://a.test</link></item>
    </channel></rss>"""
    out = collect_news(fetch=_fetch_map({"a": rss, "b": rss}),
                       feeds=_feeds("a", "b"), now_ts=NOW, max_age_h=10 ** 6)
    assert len(out["items"]) == 1


def _synthetic_feed(n, when="Tue, 28 Jul 2026 18:00:00 GMT"):
    items = b"".join(
        ("<item><title>Notizia numero %d</title><link>https://x.test/%d</link>"
         "<pubDate>%s</pubDate></item>" % (i, i, when)).encode("utf-8")
        for i in range(n))
    return b"<rss><channel>" + items + b"</channel></rss>"


def test_per_source_cap_keeps_the_report_readable():
    """Cap testé sur un flux SYNTHÉTIQUE : sur une fixture réelle le nombre
    d'items frais dépend du jour de capture, le test mesurerait la météo."""
    feed = _synthetic_feed(10)
    out = collect_news(fetch=_fetch_map({"a": feed}), feeds=_feeds("a"),
                       now_ts=NOW, per_source=3)
    assert len(out["items"]) == 3
    uncapped = collect_news(fetch=_fetch_map({"a": feed}), feeds=_feeds("a"),
                            now_ts=NOW, per_source=50)
    assert len(uncapped["items"]) == 10          # le cap mord bien


def test_global_cap_bounds_the_whole_payload():
    out = collect_news(fetch=_fetch_map({"a": _synthetic_feed(40)}),
                       feeds=_feeds("a"), now_ts=NOW, per_source=40, max_items=12)
    assert len(out["items"]) == 12


def test_items_are_sorted_most_recent_first():
    out = collect_news(fetch=_fetch_map({"a": ILSOLE, "b": ANSA}),
                       feeds=_feeds("a", "b"), now_ts=NOW)
    stamps = [i["published"] for i in out["items"] if i["published"]]
    assert stamps == sorted(stamps, reverse=True)


def test_collect_produces_themes_and_tone():
    out = collect_news(fetch=_fetch_map({"a": ILSOLE, "b": ANSA}),
                       feeds=_feeds("a", "b"), now_ts=NOW)
    assert isinstance(out["themes"], list)
    assert set(out["tone"]) == {"positive", "negative", "total"}


def test_payload_is_the_shape_the_report_expects():
    out = collect_news(fetch=_fetch_map({"a": ILSOLE}), feeds=_feeds("a"), now_ts=NOW)
    for key in ("items", "themes", "tone", "sources_ok", "sources_failed",
                "filtered_advice", "stale_sources", "generated_at"):
        assert key in out, key
    for item in out["items"]:
        assert set(item) >= {"title", "source", "url", "published", "lang"}


# --------------------------------------------------------------------------
# Configuration des flux
# --------------------------------------------------------------------------

def test_default_feeds_are_declared_and_plausible():
    assert len(FEEDS) >= 5
    for feed in FEEDS:
        assert feed["url"].startswith("https://")
        assert feed["name"]
        assert feed["lang"] in ("it", "en")
    # Le lecteur est italien : il faut de l'italien dans la liste.
    assert any(f["lang"] == "it" for f in FEEDS)


def test_no_reddit_in_the_default_feeds():
    """Les endpoints .json publics de Reddit répondent 403 depuis 2026 (sondé
    le 2026-07-28) : les garder donnerait une source morte à chaque run."""
    assert not any("reddit" in f["url"].lower() for f in FEEDS)
