"""Boucle de moisson : frontier -> fetch -> extract -> no-PII gate -> store ->
pacing -> reprise. Déterministe, zéro IA. fetch/sleep/stop/horloge injectés →
test offline, zéro réseau.

Pacing = deux niveaux : l'intervalle minimal est tenu par le RateLimiter DANS
le fetcher (anti speed-flag), et l'engine ajoute un jitter par étape si fourni.
Le back-off adaptatif riche (429/cooldown) arrive en P3 ; P1 a un back-off
linéaire simple sur erreur de fetch."""
import time
from typing import Any, Callable, Dict, Optional

from backend.bots.harvester.crawl import next_page_url
from backend.bots.harvester.fetch import FetchError, PushbackError


class Engine(object):
    def __init__(self, store, recipe, fetcher, policy, plan,
                 sleep: Callable[[float], None] = time.sleep,
                 jitter: Optional[Callable[[], float]] = None,
                 on_progress: Optional[Callable[[Dict[str, Any]], None]] = None,
                 should_stop: Optional[Callable[[], bool]] = None,
                 error_backoff_s: float = 10.0,
                 pacer=None, max_pushback_retries: int = 5) -> None:
        self.store = store
        self.recipe = recipe
        self.fetcher = fetcher
        self.policy = policy
        self.plan = plan or {}
        self._sleep = sleep
        self._jitter = jitter
        self._on_progress = on_progress
        self._should_stop = should_stop or (lambda: False)
        self.error_backoff_s = error_backoff_s
        self._pacer = pacer
        self.max_pushback_retries = max_pushback_retries
        self._pushbacks = {}  # type: Dict[str, int]

    def _progress(self) -> None:
        if self._on_progress:
            self._on_progress(self.store.counts())

    def _pace(self) -> None:
        if self._pacer is not None:
            self._sleep(self._pacer.interval())
        elif self._jitter is not None:
            self._sleep(self._jitter())

    def step(self) -> bool:
        if self._should_stop():
            return False
        url = self.store.next_todo()
        if url is None:
            return False

        try:
            html = self.fetcher.get(url)
        except PushbackError as e:
            if self._pacer is not None:
                self._pacer.penalize(e.retry_after)
                n = self._pushbacks.get(url, 0) + 1
                self._pushbacks[url] = n
                self.store.save()
                self._progress()
                self._pace()  # wait the (now larger) interval
                if n >= self.max_pushback_retries:
                    # give up on this url so the loop can converge
                    self.store.add_error()
                    self.store.mark_done(url)
                    self.store.save()
                return True
            # no pacer -> treat like a generic error (P1 behaviour)
            self.store.add_error()
            self.store.mark_done(url)
            self.store.save()
            self._progress()
            self._sleep(self.error_backoff_s)
            return True
        except FetchError:
            self.store.add_error()
            self.store.mark_done(url)
            self.store.save()
            self._progress()
            self._sleep(self.error_backoff_s)
            return True

        for raw in self.recipe.extract(html):
            clean = self.policy.validate(raw)   # PolicyViolation -> propagates (fatal)
            self.store.add_record(clean)

        if self.plan.get("mode") == "pagination":
            nxt = next_page_url(html, url, self.plan.get("next_selector") or {})
            if nxt:
                self.store.add_todo(nxt)

        self.store.mark_done(url)
        self.store.save()
        self._progress()
        if self._pacer is not None:
            self._pacer.relax()
        self._pace()
        return True

    def run(self) -> None:
        while True:
            if self._should_stop():
                return
            if not self.step():
                return
