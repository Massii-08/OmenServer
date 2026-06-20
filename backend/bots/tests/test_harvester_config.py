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


def test_save_is_chmod_600(tmp_path):
    import os
    import stat
    cfg = HarvestConfig.from_dict(CFG)
    cfg.save(str(tmp_path))
    mode = stat.S_IMODE(os.stat(str(tmp_path / "config.json")).st_mode)
    assert mode == 0o600


def test_save_is_600_even_if_chmod_unavailable(tmp_path, monkeypatch):
    # défense en profondeur : config.json (feed_key + d'éventuels creds proxy)
    # doit NAÎTRE en 0o600 (création atomique), pas via un chmod post-création
    # (fenêtre 0o644 + reste 0o644 si le chmod échoue). Cf. unblocker_config.save.
    import os
    import stat
    from backend.bots.harvester import config as cfg_mod

    def _boom(*a, **k):
        raise OSError("chmod unavailable")
    monkeypatch.setattr(cfg_mod.os, "chmod", _boom)
    if hasattr(cfg_mod.os, "fchmod"):
        monkeypatch.setattr(cfg_mod.os, "fchmod", _boom)
    cfg = HarvestConfig.from_dict(CFG)
    cfg.save(str(tmp_path))
    mode = stat.S_IMODE(os.stat(str(tmp_path / "config.json")).st_mode)
    assert mode == 0o600
