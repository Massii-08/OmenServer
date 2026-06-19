"""Tier stealth (P3b) — SQUELETTE PLUGGABLE.

⚠️ La logique d'évasion anti-bot N'EST PAS fournie ici, par choix. La coquille
respecte le contrat fetcher (`get(url) -> str`) et l'import paresseux de
patchright, mais le corps d'évasion est un `NotImplementedError` que TU remplis
(le plus simple : porte ta classe `StealthFetcher` de
`~/feedsmith/managed-data-feed-starter/src/feedsmith/stealth.py`, qui fait déjà
warm cf_clearance + attente du challenge + retries — adapte juste le
constructeur pour prendre `rate`).

Une fois `get()` implémenté, AUCUN autre fichier ne change : l'Engine, le
pacing adaptatif (P3a), le store resumable et l'API privée fonctionnent à
l'identique (ils n'appellent que `get()`).

Déploiement : `pip install patchright && patchright install chromium` dans le
venv de l'Omen (l'auto-deploy ne le fait pas). RAM Chrome partagée avec le
MC Agent → petit volume, opt-in."""
from backend.bots.harvester.fetch import FetchError


class StealthFetcher(object):
    """Fetcher navigateur furtif. Même interface que HttpxFetcher : `get(url) -> str`.

    Le corps d'évasion est laissé à implémenter (voir le module docstring)."""

    def __init__(self, rate, warm_url=None, max_wait_s=35, retries=2):
        # rate = RateLimiter (espacement mini anti speed-flag), comme HttpxFetcher.
        self.rate = rate
        self.warm_url = warm_url
        self.max_wait_s = max_wait_s
        self.retries = retries
        self._session = None

    def _ensure_browser(self):
        """Vérifie que patchright est dispo, puis ouvre/réutilise une session
        navigateur furtive. L'ouverture de session est à implémenter."""
        try:
            from patchright.sync_api import sync_playwright  # noqa: F401
        except ImportError:
            raise FetchError(
                "patchright non installé — `pip install patchright && "
                "patchright install chromium` dans le venv de l'Omen "
                "(l'auto-deploy ne le fait pas)."
            )
        # ── À IMPLÉMENTER ── ouvre/réutilise ici une session navigateur furtive.
        raise NotImplementedError(
            "StealthFetcher._ensure_browser: session navigateur à créer "
            "(cf. PatchrightBrowserSession dans ton stealth.py Feedsmith)."
        )

    def get(self, url):
        # type: (str) -> str
        """Contrat : renvoie le HTML rendu de `url`, ou lève FetchError /
        PushbackError. À IMPLÉMENTER (porte ton stealth.py Feedsmith).

        Quand tu implémenteras, l'ossature attendue est :
            self.rate.wait()                     # garde l'espacement (anti speed-flag)
            session = self._ensure_browser()
            # (1ʳᵉ fois) chauffer self.warm_url pour obtenir cf_clearance
            # naviguer vers `url`
            # attendre la résolution du challenge (≤ self.max_wait_s,
            #   jusqu'à self.retries essais), sinon lever FetchError
            # return <contenu de la page>
        """
        raise NotImplementedError(
            "StealthFetcher.get: évasion anti-bot à implémenter "
            "(porte ton stealth.py Feedsmith ici)."
        )
