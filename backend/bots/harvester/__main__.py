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
from backend.bots.harvester.fetch import HttpxFetcher, RateLimiter
from backend.bots.harvester.pacing import AdaptivePacer
from backend.bots.harvester.policy import FieldPolicy
from backend.bots.harvester.store import Store

# fichier sentinelle posé par le router pour demander l'arrêt propre
STOP_FILE = "stop.flag"


def _emit(obj: Dict[str, Any]) -> None:
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


def run_harvest(run_dir: str, fetcher: Optional[Any] = None) -> int:
    cfg = HarvestConfig.load(run_dir)
    store = Store.load(os.path.join(run_dir, "store.json"))
    if store.next_todo() is None and not store.counts()["done"]:
        store.add_todo(cfg.url)

    pacing = cfg.pacing or {}
    base_interval = float(pacing.get("min_interval_s", 1.5))
    pacer = AdaptivePacer(base_interval)

    if fetcher is None:
        # le pacer gouverne l'espacement -> le RateLimiter du fetcher est un
        # simple plancher a 0 (pas de double-pacing).
        rate = RateLimiter(0.0)
        fetcher = HttpxFetcher(rate)

    def should_stop():
        return os.path.isfile(os.path.join(run_dir, STOP_FILE))

    def on_progress(counts):
        _emit({"type": "progress", "counts": counts})

    eng = Engine(store, cfg.recipe, fetcher, FieldPolicy(allowed=cfg.recipe.field_names()),
                 cfg.plan, on_progress=on_progress, should_stop=should_stop, pacer=pacer)
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
