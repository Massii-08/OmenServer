"""Boucle de moisson : frontier -> fetch -> extract -> no-PII gate -> store ->
pacing -> reprise. Déterministe, zéro IA. fetch/sleep/stop/horloge injectés →
test offline, zéro réseau.

Pacing = deux niveaux : l'intervalle minimal est tenu par le RateLimiter DANS
le fetcher (anti speed-flag), et l'engine ajoute un jitter par étape si fourni.
Le back-off adaptatif riche (429/cooldown) arrive en P3 ; P1 a un back-off
linéaire simple sur erreur de fetch."""
import time
from typing import Any, Callable, Dict, Optional
from urllib.parse import urlparse

from backend.bots.harvester.crawl import next_page_url
from backend.bots.harvester.fetch import FetchError, PushbackError


def _same_host_public_filter(url, source_url):
    """Filtre par défaut des URL DÉCOUVERTES (pagination / sitemap) avant de les
    ajouter au frontier. N'autorise que :
      - un schéma http(s) vers une destination publique (anti-SSRF : un
        <loc>http://127.0.0.1/…</loc> ou next-link interne est jeté), ET
      - le MÊME host que la page source (un sitemap ne doit pas faire diverger
        la moisson vers un domaine arbitraire).
    Importé paresseusement (net_guard) -> reste découplé/testable."""
    try:
        from backend import net_guard
    except Exception:  # pragma: no cover — defensive
        return False
    if not net_guard.is_public_url(url):
        return False
    try:
        return urlparse(url).hostname == urlparse(source_url).hostname
    except (ValueError, AttributeError):
        return False


class Engine(object):
    def __init__(self, store, recipe, fetcher, policy, plan,
                 sleep: Callable[[float], None] = time.sleep,
                 jitter: Optional[Callable[[], float]] = None,
                 on_progress: Optional[Callable[[Dict[str, Any]], None]] = None,
                 should_stop: Optional[Callable[[], bool]] = None,
                 error_backoff_s: float = 10.0,
                 pacer=None, max_pushback_retries: int = 5,
                 recommend_after: int = 5,
                 on_event: Optional[Callable[[Dict[str, Any]], None]] = None,
                 url_filter: Optional[Callable[[str, str], bool]] = None) -> None:
        self.store = store
        self.recipe = recipe
        self.fetcher = fetcher
        self.policy = policy
        self.plan = plan or {}
        self._sleep = sleep
        self._jitter = jitter
        self._on_progress = on_progress
        self._on_event = on_event
        self._should_stop = should_stop or (lambda: False)
        # filtre anti-SSRF des URL découvertes (None -> public + même host). Les
        # tests offline injectent un filtre permissif (hôtes .test fictifs).
        self._url_filter = url_filter if url_filter is not None else _same_host_public_filter
        self.error_backoff_s = error_backoff_s
        self._pacer = pacer
        self.max_pushback_retries = max_pushback_retries
        self.recommend_after = recommend_after
        self._pushbacks = {}  # type: Dict[str, int]
        self._empty = {}  # type: Dict[str, int]   # pages 0-record (B)
        # reco de tier : blocages consécutifs SANS progrès (remis à 0 sur tout
        # fetch réussi) ; l'événement n'est émis qu'UNE fois par run.
        self._consec_pushbacks = 0
        self._recommended = False

    def _progress(self) -> None:
        if self._on_progress:
            self._on_progress(self.store.counts())

    def _event(self, obj: Dict[str, Any]) -> None:
        if self._on_event:
            self._on_event(obj)

    def _maybe_recommend(self, url: str) -> None:
        """Au seuil de blocages consécutifs, recommande UNE fois le tier
        'unblocker' (sauf s'il est déjà actif). Déterministe — aucun LLM."""
        if self._recommended or self._consec_pushbacks < self.recommend_after:
            return
        tier = (self.plan or {}).get("fetch_tier", "httpx")
        if tier == "unblocker":
            return  # déjà au tier le plus haut, rien à recommander
        self._recommended = True
        self._event({
            "type": "recommend_tier",
            "tier": "unblocker",
            "from_tier": tier,
            "consecutive_blocks": self._consec_pushbacks,
            "url": url,
            "reason": ("{0} blocages consécutifs sur ce run (Cloudflare / anti-bot) "
                       "sans contournement — le tier '{1}' ne passe pas. Essaie le "
                       "tier Débloqueur (API managée).").format(
                           self._consec_pushbacks, tier),
        })

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
            # blocage : streak +1 -> recommande le tier débloqueur au seuil
            self._consec_pushbacks += 1
            self._maybe_recommend(url)
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
            # échec NON-blocage (4xx/5xx/timeout) -> casse le streak de blocages :
            # 'consécutifs' = strictement des PushbackError d'affilée (reco fiable).
            self._consec_pushbacks = 0
            self.store.add_error()
            self.store.mark_done(url)
            self.store.save()
            self._progress()
            self._sleep(self.error_backoff_s)
            return True

        # fetch réussi -> le streak de blocages repart de zéro
        self._consec_pushbacks = 0

        extracted = list(self.recipe.extract(html))
        for raw in extracted:
            clean = self.policy.validate(raw)   # PolicyViolation -> propagates (fatal)
            self.store.add_record(clean)

        if not extracted:
            # B: page 0-record -> signal de soft-block (visibilité opérateur)
            self._event({"type": "zero_items", "url": url})
            if self.plan.get("pushback_on_empty") and self._pacer is not None:
                nb = self._empty.get(url, 0) + 1
                self._empty[url] = nb
                if nb < self.max_pushback_retries:
                    self._pacer.penalize(None)
                    self.store.save()
                    self._progress()
                    self._pace()
                    return True   # réessaie la MÊME url (pas de done/pagination)
                self.store.add_error()   # abandon après N essais -> on poursuit

        if self.plan.get("mode") == "pagination":
            nxt = next_page_url(html, url, self.plan.get("next_selector") or {})
            # filtre anti-SSRF : un next-link interne / hors-host n'entre pas dans
            # le frontier (sinon un site malveillant pourrait nous faire viser
            # 127.0.0.1 ou un domaine arbitraire via la pagination).
            if nxt and self._url_filter(nxt, url):
                self.store.add_todo(nxt)
            elif nxt:
                self._event({"type": "url_skipped", "url": nxt, "reason": "ssrf_filter"})

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
