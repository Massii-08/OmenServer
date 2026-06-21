"""Tests P4 — export client : `exporter.build_export(config)` produit un zip
standalone (moteur déterministe réutilisé tel quel + config figée + serve.py +
requirements + README + .env.example), **zéro IA** (pas de llm/setup). Pur,
offline (assemblage de fichiers, aucun réseau)."""
import io
import json
import re
import zipfile

from backend.bots.harvester import exporter

SAMPLE_CONFIG = {
    "url": "https://books.toscrape.com/catalogue/page-1.html",
    "recipe": {"item_selector": {"tag": "article", "class": "product_pod"},
               "fields": {"title": {"selector": {"tag": "a"}, "extract": "attr:title"}}},
    "plan": {"mode": "pagination", "next_selector": {"tag": "li", "class": "next"}},
    "pacing": {"min_interval_s": 1.5},
    "feed_key": "CLIENTKEY123",
}


def _zip(config=None):
    return zipfile.ZipFile(io.BytesIO(exporter.build_export(config or SAMPLE_CONFIG)))


def test_build_export_returns_valid_zip():
    blob = exporter.build_export(SAMPLE_CONFIG)
    assert isinstance(blob, bytes) and blob[:2] == b"PK"     # signature zip
    assert zipfile.ZipFile(io.BytesIO(blob)).namelist()


def test_export_contains_engine_and_wrappers():
    import os
    names = set(_zip().namelist())
    for expected in [
        "backend/__init__.py", "backend/bots/__init__.py",
        "backend/bots/harvester/__init__.py",
        "backend/bots/harvester/engine.py", "backend/bots/harvester/store.py",
        "backend/bots/harvester/fetch.py", "backend/bots/harvester/recipe.py",
        "backend/bots/harvester/__main__.py",
        "config.json", "serve.py", "requirements.txt", "README.md", ".env.example",
    ]:
        assert expected in names, "manque: " + expected
    # net_guard : bundlé SI présent dans la source (pas sur toutes les branches)
    pkg = os.path.dirname(exporter.__file__)
    backend_dir = os.path.dirname(os.path.dirname(pkg))
    if os.path.isfile(os.path.join(backend_dir, "net_guard.py")):
        assert "backend/net_guard.py" in names


def test_export_excludes_ai_modules():
    names = "\n".join(_zip().namelist())
    assert "llm.py" not in names      # zéro IA dans le runtime client
    assert "setup.py" not in names


def test_export_config_frozen():
    z = _zip()
    cfg = json.loads(z.read("config.json"))
    assert cfg["url"] == SAMPLE_CONFIG["url"]
    assert cfg["feed_key"] == "CLIENTKEY123"
    assert cfg["recipe"]["item_selector"]["class"] == "product_pod"


def test_export_requirements_minimal():
    req = _zip().read("requirements.txt").decode().lower()
    assert "httpx" in req and "fastapi" in req and "uvicorn" in req
    assert "bs4" not in req and "lxml" not in req and "patchright" not in req


def test_export_readme_mentions_feed_key():
    readme = _zip().read("README.md").decode()
    assert "CLIENTKEY123" in readme


def test_export_serve_imports_the_package():
    serve = _zip().read("serve.py").decode()
    assert "from backend.bots.harvester" in serve


def test_export_bundled_engine_matches_source():
    import os
    pkg = os.path.dirname(exporter.__file__)
    src = open(os.path.join(pkg, "engine.py"), encoding="utf-8").read()
    assert _zip().read("backend/bots/harvester/engine.py").decode() == src


def test_export_no_unbundled_backend_imports():
    """Garde anti-régression : tout `from backend...` d'un .py bundlé doit
    pointer vers un fichier PRÉSENT dans le zip (sinon ImportError chez le client)."""
    z = _zip()
    names = set(z.namelist())
    for n in [x for x in names if x.endswith(".py")]:
        src = z.read(n).decode()
        for m in re.finditer(r'^\s*from\s+(backend[\w.]*)\s+import\s+(.+)', src, re.M):
            mod, imported = m.group(1), m.group(2)
            base = mod.replace(".", "/")
            if base + ".py" in names:
                continue                                  # `from a.module import sym` -> OK
            if base + "/__init__.py" in names:
                # `from a.package import submodules` -> chaque submodule doit être bundlé
                syms = re.sub(r"[()]", "", imported).split("#")[0]
                for sym in [s.strip().split(" as ")[0].strip() for s in syms.split(",")]:
                    if not sym or sym == "*":
                        continue
                    assert base + "/" + sym + ".py" in names, \
                        "{0} importe {1}.{2} non bundlé".format(n, mod, sym)
                continue
            assert False, "{0} importe {1} (ni module ni package bundlé)".format(n, mod)
