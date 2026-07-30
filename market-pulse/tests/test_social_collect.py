"""Collecte sociale — la couche qui MANQUAIT. Hors ligne, fixtures réelles.

`social.py` savait déjà *lire* Reddit, Bluesky et X ; il n'y avait aucune couche
pour *aller les chercher*, et `main.py` ne l'appelait jamais. Les quatre options
`reddit` / `bluesky` / `x` / `x_account` de `prefs.json` étaient donc
décoratives — exactement le piège que le dépôt paie le plus cher : le code
s'exécute, les tests passent, la fonctionnalité ne fait rien.

Ces tests verrouillent le contraire : sans option cochée, **aucune requête ne
part** ; avec l'option cochée, l'URL exacte est demandée.
"""
import io
import json
import os

import pytest

from pulse.social import (bluesky_author_url, bluesky_search_url,
                          collect_social as _collect_social, reddit_url, x_url)

FIXTURES = os.path.join(os.path.dirname(__file__), "fixtures")


def _raw(name, binary=True):
    mode = "rb" if binary else "r"
    kw = {} if binary else {"encoding": "utf-8"}
    with io.open(os.path.join(FIXTURES, name), mode, **kw) as f:
        return f.read()


REDDIT = _raw("reddit_multi.xml")
BSKY_SEARCH = _raw("bluesky_search.json")
BSKY_AUTHOR = _raw("bluesky_author.json")
X_HTML = _raw("x_profile.html", binary=False)

# 2026-07-29 19:00 UTC — juste après la capture des fixtures, pour que le filtre
# de fraîcheur (36 h) les garde.
NOW = 1785351600


def collect_social(*a, **kw):
    """Wrapper des tests : pas d'espacement réseau dans une suite hors ligne."""
    kw.setdefault("sleep", lambda _s: None)
    return _collect_social(*a, **kw)


class Recorder(object):
    """fetch enregistré : c'est LUI qui prouve qu'une branche est branchée."""

    def __init__(self, mapping=None, fail=()):
        self.urls = []
        self.mapping = mapping or {}
        self.fail = fail

    def __call__(self, url):
        self.urls.append(url)
        for needle in self.fail:
            if needle in url:
                raise RuntimeError("503 sur %s" % needle)
        for needle, payload in self.mapping.items():
            if needle in url:
                return payload
        return b""


def _all():
    return Recorder({"reddit.com": REDDIT,
                     "searchPosts": BSKY_SEARCH,
                     "getAuthorFeed": BSKY_AUTHOR,
                     "x.com": X_HTML})


# --------------------------------------------------------------------------
# URL
# --------------------------------------------------------------------------

def test_reddit_uses_ONE_multireddit_request_for_all_the_subs():
    # Une requête par sub coûterait un 429 dès le troisième (plafond mesuré :
    # 1 requête / 60 s / IP). Le multireddit rend 100 posts en une fois.
    url = reddit_url(["investing", "stocks", "StockMarket"])
    assert url == ("https://www.reddit.com/r/investing+stocks+StockMarket/"
                   ".rss?limit=100")


def test_reddit_url_is_empty_without_any_sub():
    assert reddit_url([]) == ""


def test_bluesky_search_url_encodes_the_query():
    url = bluesky_search_url("piazza affari")
    assert url.startswith("https://api.bsky.app/xrpc/app.bsky.feed.searchPosts?")
    assert "piazza%20affari" in url or "piazza+affari" in url


def test_bluesky_author_url_uses_the_public_host():
    url = bluesky_author_url("reuters.com")
    assert url.startswith("https://public.api.bsky.app/xrpc/app.bsky.feed.getAuthorFeed?")
    assert "reuters.com" in url


def test_x_url_is_the_plain_profile_page():
    assert x_url("CNBC") == "https://x.com/CNBC"
    assert x_url("@CNBC") == "https://x.com/CNBC"


# --------------------------------------------------------------------------
# Rien de coché = rien ne part (la branche morte, verrouillée)
# --------------------------------------------------------------------------

def test_nothing_selected_means_no_request_at_all():
    rec = _all()
    got = collect_social(fetch=rec, now_ts=NOW)
    assert rec.urls == []
    assert got["items"] == []


def test_reddit_alone_does_not_call_bluesky_or_x():
    rec = _all()
    collect_social(fetch=rec, subs=["investing"], now_ts=NOW)
    assert len(rec.urls) == 1
    assert "reddit.com" in rec.urls[0]


def test_x_is_only_called_when_handles_are_given():
    rec = _all()
    collect_social(fetch=rec, subs=["investing"], queries=["dax"], now_ts=NOW)
    assert not any("x.com" in u for u in rec.urls), rec.urls
    rec2 = _all()
    collect_social(fetch=rec2, handles=["CNBC"], now_ts=NOW)
    assert any(u == "https://x.com/CNBC" for u in rec2.urls), rec2.urls


# --------------------------------------------------------------------------
# Collecte
# --------------------------------------------------------------------------

def test_reddit_posts_come_back_as_news_items():
    got = collect_social(fetch=_all(), subs=["investing", "stocks"], now_ts=NOW)
    assert got["items"]
    for item in got["items"]:
        assert item["title"]
        assert item["source"].startswith("Reddit")
        assert item["url"].startswith("http")


def test_bluesky_search_and_author_feed_both_land_in_the_same_contract():
    got = collect_social(fetch=_all(), queries=["borsa milano"],
                         authors=["reuters.com"], now_ts=NOW, max_items=40)
    sources = {i["source"] for i in got["items"]}
    assert any("Bluesky" in s for s in sources), sources
    for item in got["items"]:
        assert set(("title", "source", "url", "published", "lang")) <= set(item)


def test_the_query_is_named_in_the_source_so_the_reader_knows_where_it_comes_from():
    got = collect_social(fetch=_all(), queries=["borsa milano"], now_ts=NOW)
    assert any("borsa milano" in i["source"] for i in got["items"]), \
        [i["source"] for i in got["items"]]


def test_items_are_ordered_from_the_most_recent():
    got = collect_social(fetch=_all(), subs=["investing"], queries=["dax"],
                         authors=["reuters.com"], now_ts=NOW, max_items=50)
    stamps = [i["published"] or 0 for i in got["items"]]
    assert stamps == sorted(stamps, reverse=True)


def test_a_stale_post_is_dropped():
    # Fixtures du 28-29 juillet : demandées « au 15 août », tout est périmé.
    got = collect_social(fetch=_all(), subs=["investing"],
                         now_ts=NOW + 17 * 86400)
    assert got["items"] == []


def test_the_same_post_seen_twice_is_only_kept_once():
    rec = Recorder({"searchPosts": BSKY_SEARCH, "getAuthorFeed": BSKY_SEARCH})
    got = collect_social(fetch=rec, queries=["a"], authors=["b"], now_ts=NOW,
                         max_items=50)
    titles = [i["title"] for i in got["items"]]
    assert len(titles) == len(set(titles))


def test_max_items_is_respected():
    got = collect_social(fetch=_all(), subs=["investing"], now_ts=NOW,
                         max_items=3, per_source=10)
    assert len(got["items"]) == 3


# --------------------------------------------------------------------------
# Filtres — les mêmes que la presse
# --------------------------------------------------------------------------

def _bsky_with(texts):
    posts = [{"uri": "at://x/app.bsky.feed.post/p%d" % n,
              "author": {"handle": "someone.bsky.social"},
              "record": {"text": t, "createdAt": "2026-07-29T18:00:00.000Z"}}
             for n, t in enumerate(texts)]
    return json.dumps({"posts": posts}).encode("utf-8")


def test_a_post_that_is_itself_a_buy_recommendation_is_dropped_and_counted():
    payload = _bsky_with(["Le 5 azioni da comprare adesso", "Eni batte le stime"])
    rec = Recorder({"searchPosts": payload})
    got = collect_social(fetch=rec, queries=["borsa"], now_ts=NOW)
    titles = [i["title"] for i in got["items"]]
    assert "Eni batte le stime" in titles
    assert not any("comprare" in t for t in titles), titles
    assert got["filtered_advice"] == 1


def test_a_chart_prediction_post_is_treated_as_advice():
    # Mesuré sur la vraie recherche Bluesky : « Il supporto del 38,2% di
    # Fibonacci … potrebbero preparare un rimbalzo ». Recopié sous le nom de la
    # bourse, ça se lit comme la prévision DU BOT.
    payload = _bsky_with(["Il supporto del 38,2% di Fibonacci prepara il rimbalzo",
                          "Eni batte le stime"])
    got = collect_social(fetch=Recorder({"searchPosts": payload}),
                         queries=["borsa"], now_ts=NOW)
    titles = [i["title"] for i in got["items"]]
    assert titles == ["Eni batte le stime"], titles


def test_a_private_life_post_is_dropped_and_counted():
    payload = _bsky_with(["My stepdad is dying from cancer. How can I help my mom",
                          "Eni batte le stime"])
    got = collect_social(fetch=Recorder({"searchPosts": payload}),
                         queries=["borsa"], now_ts=NOW)
    assert [i["title"] for i in got["items"]] == ["Eni batte le stime"]
    assert got["filtered_offtopic"] == 1


# --------------------------------------------------------------------------
# 429 — la règle mesurée : lire le reset, réessayer UNE fois, abandonner
# --------------------------------------------------------------------------

class FakeResponse(object):
    def __init__(self, status_code, headers=None):
        self.status_code = status_code
        self.headers = headers or {}


class FakeHttpError(Exception):
    def __init__(self, response):
        Exception.__init__(self, "HTTP %s" % response.status_code)
        self.response = response


def test_a_429_is_retried_exactly_once_never_in_a_loop():
    calls = {"n": 0}

    def always_429(url):
        calls["n"] += 1
        raise FakeHttpError(FakeResponse(429, {"x-ratelimit-reset": "2"}))

    got = collect_social(fetch=always_429, subs=["investing"], now_ts=NOW)
    assert calls["n"] == 2, "429 : une seule reprise, jamais une boucle"
    assert got["items"] == []
    assert any("429" in s["error"] or "429" in str(s) for s in got["sources_failed"])


def test_the_retry_waits_the_delay_the_server_asked_for():
    waited = []
    state = {"n": 0}

    def once_429(url):
        state["n"] += 1
        if state["n"] == 1:
            raise FakeHttpError(FakeResponse(429, {"x-ratelimit-reset": "3"}))
        return REDDIT

    got = _collect_social(fetch=once_429, subs=["investing"], now_ts=NOW,
                          sleep=lambda s: waited.append(s), pacing_s=0)
    assert waited and 3 <= waited[0] <= 4, waited
    assert got["items"], "la reprise a bien resservi la réponse"


def test_an_absurd_reset_is_capped_so_the_run_never_hangs():
    waited = []

    def always_429(url):
        raise FakeHttpError(FakeResponse(429, {"x-ratelimit-reset": "99999"}))

    _collect_social(fetch=always_429, subs=["investing"], now_ts=NOW,
                    sleep=lambda s: waited.append(s), pacing_s=0)
    assert waited and max(waited) <= 60, waited


def test_a_429_on_reddit_does_not_cost_bluesky():
    rec = Recorder({"searchPosts": BSKY_SEARCH}, fail=("reddit.com",))
    got = collect_social(fetch=rec, subs=["investing"], queries=["borsa milano"],
                         now_ts=NOW)
    assert got["items"], "une source en panne a tout emporté"
    assert any("Reddit" in s["source"] for s in got["sources_failed"])


# --------------------------------------------------------------------------
# L'alarme X — celle qui empêche un briefing vide qui a l'air normal
# --------------------------------------------------------------------------

def test_x_serialization_change_is_raised_as_an_ALARM_not_swallowed():
    # Une page de 300 Ko sans un seul post = X a changé sa sérialisation. Sans
    # alarme, le briefing sort vide et ressemble à « il n'y avait rien ».
    big = "<html>" + ("x" * 200000) + "</html>"
    got = collect_social(fetch=Recorder({"x.com": big}), handles=["CNBC"],
                         now_ts=NOW)
    assert got["alarms"], "l'alarme de sérialisation a été avalée"
    assert "CNBC" in got["alarms"][0]
    assert got["items"] == []


def test_a_small_empty_page_is_not_an_alarm_just_an_empty_source():
    got = collect_social(fetch=Recorder({"x.com": "<html></html>"}),
                         handles=["CNBC"], now_ts=NOW)
    assert got["alarms"] == []


def test_x_posts_are_collected_when_the_page_is_normal():
    got = collect_social(fetch=Recorder({"x.com": X_HTML}), handles=["CNBC"],
                         now_ts=NOW)
    assert got["items"]
    assert all(i["source"] == "X @CNBC" for i in got["items"])


# --------------------------------------------------------------------------
# Robustesse
# --------------------------------------------------------------------------

def test_collect_social_never_raises_whatever_the_fetch_does():
    def broken(url):
        raise ValueError("réponse illisible")

    got = collect_social(fetch=broken, subs=["a"], queries=["b"],
                         authors=["c"], handles=["d"], now_ts=NOW)
    assert got["items"] == []
    assert len(got["sources_failed"]) == 4


def test_garbage_payload_is_not_a_crash():
    got = collect_social(fetch=Recorder({"reddit.com": b"<<<not xml",
                                         "searchPosts": b"not json"}),
                         subs=["a"], queries=["b"], now_ts=NOW)
    assert got["items"] == []


@pytest.mark.parametrize("key", ["items", "sources_ok", "sources_failed",
                                 "filtered_advice", "filtered_offtopic", "alarms"])
def test_the_payload_always_carries_the_full_contract(key):
    got = collect_social(fetch=_all(), now_ts=NOW)
    assert key in got


def test_a_social_item_is_recognisable_as_social():
    """La découverte de titres doit pouvoir écarter le social.

    Mesuré au premier run réel : les posts sociaux ont fait « découvrir »
    `NEXT` (extrait de « NIKKEI NEWS NEXT ») et `9TO.F`. Une dépêche de presse
    est de la prose éditée ; un post est une soupe de hashtags.
    """
    got = collect_social(fetch=_all(), subs=["investing"], queries=["dax"],
                         handles=["CNBC"], now_ts=NOW, max_items=40)
    assert got["items"]
    for item in got["items"]:
        assert item["source"].startswith(("Reddit", "Bluesky", "X @")), item["source"]
