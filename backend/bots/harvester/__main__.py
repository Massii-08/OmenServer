"""Entrypoint du subprocess détaché : `python -m backend.bots.harvester <run_dir>`.

Charge config.json + store.json depuis run_dir, construit l'engine httpx, et
boucle. Émet la progression en lignes JSON sur stdout (capturées par le router).
fetcher injectable → test offline (run_harvest)."""
import json
import os
import sys
from typing import Any, Dict, Optional

from backend.bots.harvester.config import HarvestConfig
from backend.bots.harvester.engine import Engine
from backend.bots.harvester.fetch import DEFAULT_UA, HttpxFetcher, RateLimiter
from backend.bots.harvester.pacing import AdaptivePacer
from backend.bots.harvester.policy import FieldPolicy
from backend.bots.harvester.robots import resolve_base_interval
from backend.bots.harvester.store import Store

# fichier sentinelle posé par le router pour demander l'arrêt propre
STOP_FILE = "stop.flag"


def _emit(obj: Dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


def _build_fetcher(tier, rate, url):
    """Sélection du tier de fetch. Défaut = httpx (P1). 'stealth' = tier P3b
    (squelette pluggable, évasion à implémenter par l'utilisateur). Tout autre
    valeur retombe sur httpx."""
    if tier == "stealth":
        from backend.bots.harvester.fetch_stealth import StealthFetcher
        return StealthFetcher(rate, warm_url=url)
    return HttpxFetcher(rate)


def _default_robots_get(url):
    """GET robots.txt en httpx (prod). Best-effort -> '' si erreur/4xx-5xx."""
    import httpx
    with httpx.Client(timeout=10.0, follow_redirects=True,
                      headers={"User-Agent": DEFAULT_UA}) as c:
        r = c.get(url)
        return r.text if r.status_code < 400 else ""


def run_harvest(run_dir: str, fetcher: Optional[Any] = None,
                robots_get: Optional[Any] = None) -> int:
    cfg = HarvestConfig.load(run_dir)
    # strict `is True` : le seul producteur légitime (frontend) envoie un booléen
    # JSON true ; évite qu'un plan édité à la main avec "dedupe":"false" l'active.
    store = Store.load(os.path.join(run_dir, "store.json"),
                       dedupe=(cfg.plan or {}).get("dedupe") is True)
    if store.next_todo() is None and not store.counts()["done"]:
        store.add_todo(cfg.url)

    pacing = cfg.pacing or {}
    # C: plancher de pacing = max(configuré, Crawl-delay robots.txt). En prod
    # (fetcher None) on lit robots.txt en httpx ; en test (fetcher injecté) on
    # ne touche pas au réseau sauf si robots_get est fourni.
    if robots_get is None and fetcher is None:
        robots_get = _default_robots_get
    base_interval = resolve_base_interval(
        pacing.get("min_interval_s", 1.5), cfg.url, robots_get)
    pacer = AdaptivePacer(base_interval)

    if fetcher is None:
        # le pacer gouverne l'espacement -> le RateLimiter du fetcher est un
        # simple plancher a 0 (pas de double-pacing).
        rate = RateLimiter(0.0)
        tier = (cfg.plan or {}).get("fetch_tier", "httpx")
        fetcher = _build_fetcher(tier, rate, cfg.url)

    def should_stop():
        return os.path.isfile(os.path.join(run_dir, STOP_FILE))

    def on_progress(counts):
        _emit({"type": "progress", "counts": counts})

    eng = Engine(store, cfg.recipe, fetcher, FieldPolicy(allowed=cfg.recipe.field_names()),
                 cfg.plan, on_progress=on_progress, should_stop=should_stop, pacer=pacer,
                 on_event=_emit)
    try:
        eng.run()
    except Exception as e:  # noqa: BLE001 — surfaced as a final log line
        _emit({"type": "error", "message": repr(e)})
        return 1
    _emit({"type": "done", "counts": store.counts()})
    return 0


def main(argv=None) -> int:
    argv = argv if argv is not None else sys.argv[1:]
    if not argv:
        sys.stderr.write("usage: python -m backend.bots.harvester <run_dir>\n")
        return 2
    return run_harvest(argv[0])


if __name__ == "__main__":
    sys.exit(main())
