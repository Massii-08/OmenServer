"""Collecteurs sociaux — Reddit, Bluesky et X. Hors ligne, fixtures RÉELLES.

Les trois routes ont été sondées et vérifiées à la main le 2026-07-29 :
- Reddit : le `.json` rend 403, mais le `.rss` multireddit rend 100 posts en
  UNE requête. C'est cette voie-là.
- Bluesky : httpx nu, sans compte, et il rend de l'italien.
- X : `x.com/<handle>` rend les 5 derniers posts dans le HTML rendu côté
  serveur. ⚠️ Ce n'est PAS du JSON — sérialisation Relay, clés NON quotées,
  horodatage `created_at_ms` en millisecondes.
"""
import io
import json
import os

from pulse.social import (parse_bluesky, parse_reddit, parse_x,
                          XSerializationChanged)

FIXTURES = os.path.join(os.path.dirname(__file__), "fixtures")


def _raw(name, binary=True):
    mode = "rb" if binary else "r"
    with io.open(os.path.join(FIXTURES, name), mode,
                 **({} if binary else {"encoding": "utf-8"})) as f:
        return f.read()


REDDIT = _raw("reddit_multi.xml")
BSKY_SEARCH = _raw("bluesky_search.json")
BSKY_AUTHOR = _raw("bluesky_author.json")
X_HTML = _raw("x_profile.html", binary=False)


# --------------------------------------------------------------------------
# Reddit
# --------------------------------------------------------------------------

def test_reddit_multireddit_is_parsed():
    items = parse_reddit(REDDIT)
    assert len(items) == 25
    first = items[0]
    assert first["title"]
    assert first["url"].startswith("https://")
    assert isinstance(first["published"], int)
    assert first["source"].startswith("Reddit")


def test_reddit_keeps_the_subreddit_of_each_post():
    """Le `category` de l'Atom porte le sub : sans lui, un multireddit devient
    une bouillie où l'on ne sait plus qui a dit quoi."""
    items = parse_reddit(REDDIT)
    subs = {i["subreddit"] for i in items}
    assert len(subs) >= 2
    assert all(i["source"] == "Reddit r/" + i["subreddit"] for i in items)


def test_reddit_on_garbage_is_empty_not_an_exception():
    assert parse_reddit(b"pas du xml") == []
    assert parse_reddit(b"") == []
    assert parse_reddit(None) == []


# --------------------------------------------------------------------------
# Bluesky
# --------------------------------------------------------------------------

def test_bluesky_search_is_parsed():
    items = parse_bluesky(BSKY_SEARCH, source="Bluesky")
    assert len(items) == 8
    assert all(i["title"] for i in items)
    assert all(isinstance(i["published"], int) for i in items)


def test_bluesky_author_feed_is_parsed():
    """Le fil d'un compte a une forme DIFFÉRENTE de la recherche : `feed[].post`
    au lieu de `posts[]`. Les deux doivent passer par la même porte."""
    items = parse_bluesky(BSKY_AUTHOR, source="Bluesky Reuters")
    assert len(items) == 8
    assert all(i["source"] == "Bluesky Reuters" for i in items)


def test_bluesky_builds_a_usable_link():
    items = parse_bluesky(BSKY_AUTHOR, source="B")
    assert any(i["url"].startswith("https://bsky.app/profile/") for i in items)


def test_bluesky_on_garbage_is_empty():
    assert parse_bluesky(b"{pas du json", source="B") == []
    assert parse_bluesky(b"{}", source="B") == []
    assert parse_bluesky(None, source="B") == []


# --------------------------------------------------------------------------
# X — la sérialisation Relay
# --------------------------------------------------------------------------

def test_x_extracts_posts_from_the_relay_payload():
    items = parse_x(X_HTML, handle="CNBC")
    assert len(items) == 5
    for i in items:
        assert i["title"]
        assert isinstance(i["published"], int)
        assert i["source"] == "X @CNBC"


def test_x_posts_are_sorted_most_recent_first():
    """Le post ÉPINGLÉ casse l'ordre naturel de la page : mesuré sur
    MarketWatch, un post de 7 h arrivait avant quatre posts d'une heure."""
    items = parse_x(X_HTML, handle="CNBC")
    stamps = [i["published"] for i in items]
    assert stamps == sorted(stamps, reverse=True)


def test_x_does_not_hardcode_five_posts():
    """zerohedge en rend six. Le compte ne doit jamais être codé en dur."""
    doubled = X_HTML + X_HTML.replace("created_at_ms:1", "created_at_ms:2")
    assert len(parse_x(doubled, handle="X")) > 5


def test_x_alarms_when_a_big_page_yields_nothing():
    """LE garde-fou : si X change sa sérialisation, la page répond toujours 200
    et fait toujours 300 Ko — mais on n'en tire plus rien. Sans alarme, le
    briefing sortirait silencieusement vide."""
    big_but_empty = "<html>" + ("x" * 150000) + "</html>"
    try:
        parse_x(big_but_empty, handle="CNBC")
    except XSerializationChanged as e:
        assert "CNBC" in str(e)
    else:
        raise AssertionError("aucune alarme sur une grande page sans post")


def test_x_stays_silent_on_a_small_empty_page():
    """Une petite page vide (redirection, erreur) n'est pas un changement de
    format : on rend une liste vide, on n'alarme pas."""
    assert parse_x("<html>vide</html>", handle="CNBC") == []
    assert parse_x("", handle="CNBC") == []
    assert parse_x(None, handle="CNBC") == []


def test_x_unescapes_the_text():
    items = parse_x(X_HTML, handle="CNBC")
    joined = " ".join(i["title"] for i in items)
    assert "\\n" not in joined
    assert "\\/" not in joined


# --------------------------------------------------------------------------
# Contrat commun — les trois doivent rendre la MÊME forme que news.py
# --------------------------------------------------------------------------

def test_the_three_collectors_share_the_news_item_shape():
    batches = [parse_reddit(REDDIT),
               parse_bluesky(BSKY_SEARCH, source="Bluesky"),
               parse_x(X_HTML, handle="CNBC")]
    for items in batches:
        assert items
        for i in items:
            assert set(i) >= {"title", "source", "url", "published", "lang"}
            assert isinstance(i["title"], str) and i["title"].strip()
