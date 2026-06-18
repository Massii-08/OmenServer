import pytest

from backend.bots.harvester.engine import Engine
from backend.bots.harvester.policy import FieldPolicy, PolicyViolation
from backend.bots.harvester.recipe import Recipe
from backend.bots.harvester.store import Store

LISTING_RECIPE = {
    "item_selector": {"tag": "article", "class": "product_pod"},
    "fields": {
        "title": {"selector": {"tag": "a"}, "extract": "attr:title"},
        "price": {"selector": {"tag": "p", "class": "price_color"}, "extract": "text"},
    },
}

PAGE1 = """<html><body>
  <article class="product_pod"><h3><a title="A">a</a></h3><p class="price_color">£1</p></article>
  <ul class="pager"><li class="next"><a href="page-2.html">next</a></li></ul>
</body></html>"""

PAGE2 = """<html><body>
  <article class="product_pod"><h3><a title="B">b</a></h3><p class="price_color">£2</p></article>
</body></html>"""

PLAN = {"mode": "pagination", "next_selector": {"tag": "li", "class": "next"}}


class FakeFetcher(object):
    def __init__(self, pages):
        self.pages = pages
        self.calls = []

    def get(self, url):
        self.calls.append(url)
        return self.pages[url]


def _store(tmp_path):
    return Store(str(tmp_path / "store.json"))


def test_engine_follows_pagination_and_collects_all(tmp_path):
    pages = {
        "https://x.test/page-1.html": PAGE1,
        "https://x.test/page-2.html": PAGE2,
    }
    store = _store(tmp_path)
    store.add_todo("https://x.test/page-1.html")
    slept = []
    eng = Engine(store, Recipe.from_dict(LISTING_RECIPE), FakeFetcher(pages),
                 FieldPolicy(allowed=["title", "price"]), PLAN,
                 sleep=lambda s: slept.append(s), jitter=lambda: 2.5)
    eng.run()
    assert store.records() == [
        {"title": "A", "price": "£1"},
        {"title": "B", "price": "£2"},
    ]
    assert store.counts()["done"] == 2
    assert store.counts()["todo"] == 0
    assert 2.5 in slept  # per-step jitter applied


def test_engine_ordering_fetch_then_extract_then_store(tmp_path):
    pages = {"https://x.test/page-1.html": PAGE1, "https://x.test/page-2.html": PAGE2}
    fetcher = FakeFetcher(pages)
    store = _store(tmp_path)
    store.add_todo("https://x.test/page-1.html")
    eng = Engine(store, Recipe.from_dict(LISTING_RECIPE), fetcher,
                 FieldPolicy(allowed=["title", "price"]), PLAN, sleep=lambda s: None)
    eng.run()
    assert fetcher.calls == ["https://x.test/page-1.html", "https://x.test/page-2.html"]


def test_engine_resume_skips_done_urls(tmp_path):
    pages = {"https://x.test/page-1.html": PAGE1, "https://x.test/page-2.html": PAGE2}
    store = _store(tmp_path)
    store.add_todo("https://x.test/page-1.html")
    store.mark_done("https://x.test/page-1.html")   # already fetched in a prior run
    store.add_todo("https://x.test/page-2.html")
    fetcher = FakeFetcher(pages)
    eng = Engine(store, Recipe.from_dict(LISTING_RECIPE), fetcher,
                 FieldPolicy(allowed=["title", "price"]), PLAN, sleep=lambda s: None)
    eng.run()
    assert fetcher.calls == ["https://x.test/page-2.html"]  # page-1 not re-fetched


def test_engine_should_stop_halts_loop(tmp_path):
    pages = {"https://x.test/page-1.html": PAGE1, "https://x.test/page-2.html": PAGE2}
    store = _store(tmp_path)
    store.add_todo("https://x.test/page-1.html")
    eng = Engine(store, Recipe.from_dict(LISTING_RECIPE), FakeFetcher(pages),
                 FieldPolicy(allowed=["title", "price"]), PLAN,
                 sleep=lambda s: None, should_stop=lambda: True)
    eng.run()
    assert store.records() == []          # stopped before first fetch
    assert store.counts()["done"] == 0


def test_engine_fetch_error_backs_off_and_marks_done(tmp_path):
    from backend.bots.harvester.fetch import FetchError

    class BoomFetcher(object):
        def get(self, url):
            raise FetchError("boom")

    store = _store(tmp_path)
    store.add_todo("https://x.test/page-1.html")
    slept = []
    eng = Engine(store, Recipe.from_dict(LISTING_RECIPE), BoomFetcher(),
                 FieldPolicy(allowed=["title", "price"]), PLAN,
                 sleep=lambda s: slept.append(s), error_backoff_s=10.0)
    eng.run()
    assert store.counts()["errors"] == 1
    assert store.counts()["done"] == 1   # marked done so it isn't retried forever
    assert 10.0 in slept                 # back-off applied


def test_engine_policy_violation_is_fatal(tmp_path):
    pages = {"https://x.test/page-1.html": PAGE1, "https://x.test/page-2.html": PAGE2}
    store = _store(tmp_path)
    store.add_todo("https://x.test/page-1.html")
    bad_recipe = {
        "item_selector": {"tag": "article", "class": "product_pod"},
        "fields": {"email": {"selector": {"tag": "a"}, "extract": "attr:title"}},
    }
    eng = Engine(store, Recipe.from_dict(bad_recipe), FakeFetcher(pages),
                 FieldPolicy(allowed=["email"]), PLAN, sleep=lambda s: None)
    with pytest.raises(PolicyViolation):
        eng.run()


def test_engine_sitemap_mode_no_pagination(tmp_path):
    store = _store(tmp_path)
    store.add_todo("https://x.test/page-1.html")
    fetcher = FakeFetcher({"https://x.test/page-1.html": PAGE1})
    eng = Engine(store, Recipe.from_dict(LISTING_RECIPE), fetcher,
                 FieldPolicy(allowed=["title", "price"]),
                 {"mode": "sitemap"}, sleep=lambda s: None)
    eng.run()
    assert fetcher.calls == ["https://x.test/page-1.html"]  # no next-link followed
    assert store.records() == [{"title": "A", "price": "£1"}]
