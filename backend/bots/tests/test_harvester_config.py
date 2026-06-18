from backend.bots.harvester.config import HarvestConfig
from backend.bots.harvester.recipe import Recipe

CFG = {
    "url": "https://books.toscrape.com/catalogue/page-1.html",
    "recipe": {
        "item_selector": {"tag": "article", "class": "product_pod"},
        "fields": {"title": {"selector": {"tag": "a"}, "extract": "attr:title"}},
    },
    "plan": {"mode": "pagination", "next_selector": {"tag": "li", "class": "next"}},
    "pacing": {"min_interval_s": 1.5, "jitter": [0.5, 2.0]},
    "feed_key": "abc123",
}


def test_from_dict_to_dict_roundtrip():
    cfg = HarvestConfig.from_dict(CFG)
    assert isinstance(cfg.recipe, Recipe)
    assert cfg.feed_key == "abc123"
    assert cfg.to_dict() == CFG


def test_save_and_load_run_dir(tmp_path):
    cfg = HarvestConfig.from_dict(CFG)
    cfg.save(str(tmp_path))
    assert (tmp_path / "config.json").is_file()
    loaded = HarvestConfig.load(str(tmp_path))
    assert loaded.to_dict() == CFG
