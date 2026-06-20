"""Entrypoint du subprocess détaché : `python -m backend.bots.harvester <run_dir>`.

Charge config.json + store.json depuis run_dir, construit l'engine httpx, et
boucle. Émet la progression en lignes JSON sur stdout (capturées par le router).
fetcher injectable → test offline (run_harvest)."""
import functools
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


def _as_int(value, default, lo=None, hi=None):
    """int() tolérant + bornage. Une valeur de plan éditée à la main ('60.0',
    'abc', None) ne crashe jamais -> retombe sur le défaut, puis clamp [lo,hi]."""
    try:
        n = int(float(value))
    except (TypeError, ValueError):
        n = default
    if lo is not None:
        n = max(lo, n)
    if hi is not None:
        n = min(hi, n)
    return n


def _as_float(value, default, lo=None, hi=None):
    try:
        n = float(value)
    except (TypeError, ValueError):
        n = default
    if lo is not None:
        n = max(lo, n)
    if hi is not None:
        n = min(hi, n)
    return n


def _build_fetcher(tier, rate, url, plan=None, run_dir=None):
    """Sélection du tier de fetch. Défaut = httpx. 'stealth' = patchright + options
    lues du plan : proxy, pace_min/max, max_wait, retries, wait_after (settle JS),
    locale, timezone, rewarm_every. 'unblocker' = API managée de débloquage
    (endpoint/clé en env, surchargés par le plan). Valeurs bornées + tolérantes
    (jamais de crash sur un plan édité à la main). Tout autre tier -> httpx."""
    plan = plan or {}
    if tier == "unblocker":
        from backend.bots.harvester.fetch_unblocker import UnblockerFetcher
        extra = plan.get("unblocker_params")
        return UnblockerFetcher(
            rate,
            endpoint=plan.get("unblocker_endpoint"),    # None -> env
            api_key=plan.get("unblocker_key"),          # None -> env
            render_js=bool(plan.get("render_js", False)),
            params=extra if isinstance(extra, dict) else None,
            method=plan.get("unblocker_method") or "POST",
            url_param=plan.get("unblocker_url_param") or "url",
            key_param=plan.get("unblocker_key_param") or "apikey",
            key_in=plan.get("unblocker_key_in") or "body",
            render_param=plan.get("unblocker_render_param") or "render_js",
            result_field=plan.get("unblocker_result_field"),
            error_field=plan.get("unblocker_error_field", "error"),
            status_field=plan.get("unblocker_status_field"),
            timeout=_as_float(plan.get("unblocker_timeout"), 90.0, lo=5.0, hi=300.0),
            retries=_as_int(plan.get("unblocker_retries"), 2, lo=1, hi=10),
        )
    if tier == "stealth":
        from backend.bots.harvester.fetch_stealth import StealthFetcher, jitter_delay
        proxy = plan.get("proxy")
        if isinstance(proxy, str):
            proxy = {"server": proxy}     # confort : une URL string -> dict playwright
        if isinstance(proxy, dict) and not proxy.get("server"):
            proxy = None                  # proxy sans 'server' -> ignoré (pas de crash opaque)
        elif not isinstance(proxy, (dict, type(None))):
            proxy = None
        browser_opts = {
            "proxy": proxy,
            "locale": plan.get("locale"),
            "timezone_id": plan.get("timezone"),
            "settle_ms": _as_int(plan.get("wait_after", 0), 0, lo=0, hi=30000),
        }
        has_pace = ("pace_min" in plan) or ("pace_max" in plan)
        pmin = _as_float(plan.get("pace_min"), 3.0, lo=0.1, hi=120.0)
        pmax = _as_float(plan.get("pace_max"), 8.0, lo=0.1, hi=120.0)
        pmin, pmax = sorted((pmin, pmax))   # fenêtre toujours bien formée (min<=max)
        jitter = (functools.partial(jitter_delay, lo=pmin, hi=pmax)
                  if has_pace else jitter_delay)
        return StealthFetcher(
            rate, warm_url=url, jitter=jitter,
            max_wait_s=_as_int(plan.get("max_wait"), 35, lo=1, hi=120),
            retries=_as_int(plan.get("retries"), 2, lo=1, hi=10),
            run_dir=run_dir, browser_opts=browser_opts,
            rewarm_every=_as_int(plan.get("rewarm_every"), 0, lo=0, hi=10000),
        )
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

    def should_stop():
        return os.path.isfile(os.path.join(run_dir, STOP_FILE))

    def on_progress(counts):
        _emit({"type": "progress", "counts": counts})

    # Build du fetcher DANS le try : une option de plan invalide (proxy mal formé,
    # etc.) est surfacée en {"type":"error"} au lieu de tuer le subprocess en
    # silence avant le démarrage du moteur.
    try:
        if fetcher is None:
            # le pacer gouverne l'espacement -> RateLimiter plancher a 0.
            rate = RateLimiter(0.0)
            tier = (cfg.plan or {}).get("fetch_tier", "httpx")
            fetcher = _build_fetcher(tier, rate, cfg.url, cfg.plan, run_dir)
        eng = Engine(store, cfg.recipe, fetcher,
                     FieldPolicy(allowed=cfg.recipe.field_names()), cfg.plan,
                     on_progress=on_progress, should_stop=should_stop, pacer=pacer,
                     on_event=_emit)
        eng.run()
    except Exception as e:  # noqa: BLE001 — toute erreur (config/proxy/run) -> log
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
