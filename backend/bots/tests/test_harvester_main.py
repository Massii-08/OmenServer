import json

from backend.bots.harvester import __main__ as entry
from backend.bots.harvester.config import HarvestConfig
from backend.bots.harvester.store import Store

CFG = {
    "url": "https://x.test/page-1.html",
    "recipe": {
        "item_selector": {"tag": "article", "class": "product_pod"},
        "fields": {"title": {"selector": {"tag": "a"}, "extract": "attr:title"}},
    },
    "plan": {"mode": "sitemap"},
    "pacing": {"min_interval_s": 0.0, "jitter": [0.0, 0.0]},
    "feed_key": "k",
}

PAGE = ('<html><body><article class="product_pod"><h3>'
        '<a title="A">a</a></h3></article></body></html>')


class FakeFetcher(object):
    def get(self, url):
        return PAGE


def test_run_harvest_writes_store(tmp_path, monkeypatch):
    HarvestConfig.from_dict(CFG).save(str(tmp_path))
    # seed the frontier with the start url
    store = Store(str(tmp_path / "store.json"))
    store.add_todo(CFG["url"])
    store.save()

    rc = entry.run_harvest(str(tmp_path), fetcher=FakeFetcher())
    assert rc == 0

    written = Store.load(str(tmp_path / "store.json"))
    assert written.records() == [{"title": "A"}]
    assert written.counts()["done"] == 1


def test_build_engine_uses_adaptive_pacer_from_config(tmp_path, monkeypatch):
    from backend.bots.harvester import __main__ as entry
    from backend.bots.harvester.pacing import AdaptivePacer

    cfg = dict(CFG)
    cfg["pacing"] = {"min_interval_s": 7.0, "jitter": [0.0, 0.0]}
    HarvestConfig.from_dict(cfg).save(str(tmp_path))
    store = Store(str(tmp_path / "store.json"))
    store.add_todo(cfg["url"])
    store.save()

    captured = {}
    real_engine = entry.Engine

    def spy_engine(*args, **kwargs):
        captured["pacer"] = kwargs.get("pacer")
        return real_engine(*args, **kwargs)

    monkeypatch.setattr(entry, "Engine", spy_engine)
    rc = entry.run_harvest(str(tmp_path), fetcher=FakeFetcher())
    assert rc == 0
    assert isinstance(captured["pacer"], AdaptivePacer)
    assert captured["pacer"].base == 7.0
