"""Tier 'unblocker' (P3c) — délègue le fetch à une API managée de débloquage
(type ZenRows / ScrapingBee / Bright Data Web Unlocker) qui résout le Cloudflare
AGRESSIF côté serveur (proxy résidentiel + solveur Turnstile gérés par eux).

C'est le 3e et dernier tier, après ``httpx`` (rapide, cibles propres) et
``stealth`` (patchright + vrai Chrome). Opt-in par feed, clé en ``.env`` ;
AUCUN impact si non configuré. Il MIROITE le contrat de :mod:`fetch_stealth` :
interface ``.get(url) -> str``, lève :class:`PushbackError` quand le provider
ou la cible pousse (l'engine recule), :class:`FetchError` sur échec dur ou
absence de configuration (comme ``fetch_stealth`` lève pour patchright absent).

Provider-agnostique : endpoint + clé + params lus de l'environnement
(``HARVESTER_UNBLOCKER_ENDPOINT`` / ``HARVESTER_UNBLOCKER_KEY``), surchargeables
par le plan. Le client httpx est INJECTABLE -> 100% testable offline (pas de
réseau, pas de clé). Réutilise ``httpx`` (déjà une dépendance) -> ZÉRO nouvelle
dépendance (cf. piège #33).

🔒 Sécurité : la clé d'API n'apparaît JAMAIS dans un message d'erreur — sur
exception httpx on n'expose que ``type(e).__name__`` (jamais ``repr(e)``, qui
fuiterait l'URL+clé si la clé est passée en query).
"""
from __future__ import annotations

import os
import time
from typing import Any, Callable, Dict, Optional

from backend.bots.harvester.fetch import (
    DEFAULT_UA,
    FetchError,
    PushbackError,
    RateLimiter,
    _parse_retry_after,
    is_challenge,
)
from backend.bots.harvester.fetch_stealth import is_challenge_html

_KEY_PLACEMENTS = ("body", "header", "query")


class UnblockerFetcher(object):
    """Fetcher via une API managée de débloquage. ``client`` httpx injectable."""

    def __init__(
        self,
        rate: RateLimiter,
        endpoint: Optional[str] = None,
        api_key: Optional[str] = None,
        *,
        client: Optional[Any] = None,
        render_js: bool = False,
        params: Optional[Dict[str, Any]] = None,
        method: str = "POST",
        url_param: str = "url",
        key_param: str = "apikey",
        key_in: str = "body",
        render_param: str = "render_js",
        result_field: Optional[str] = None,
        error_field: str = "error",
        status_field: Optional[str] = None,
        timeout: float = 90.0,
        retries: int = 2,
        sleep: Callable[[float], None] = time.sleep,
    ) -> None:
        self.rate = rate
        # endpoint/clé : plan d'abord, sinon env. Stockés en privé (la clé ne
        # transite jamais dans un attribut exposé par l'API du router).
        self._endpoint = endpoint or os.environ.get("HARVESTER_UNBLOCKER_ENDPOINT")
        self._api_key = api_key or os.environ.get("HARVESTER_UNBLOCKER_KEY")
        self._client = client
        self.render_js = bool(render_js)
        self.params = dict(params) if isinstance(params, dict) else {}
        self.method = (method or "POST").upper()
        self.url_param = url_param or "url"
        self.key_param = key_param or "apikey"
        self.key_in = key_in if key_in in _KEY_PLACEMENTS else "body"
        self.render_param = render_param or "render_js"
        self.result_field = result_field
        # champs de l'enveloppe JSON (providers qui rendent 200 + {html,status,error})
        self.error_field = error_field
        self.status_field = status_field
        # clamp aussi ici (pas que via _build_fetcher) -> robuste en usage direct
        try:
            t = float(timeout)
            self.timeout = t if t > 0 else 90.0
        except (TypeError, ValueError):
            self.timeout = 90.0
        self.retries = max(1, int(retries))
        self._sleep = sleep

    def _get_client(self):
        if self._client is not None:
            return self._client
        import httpx  # lazy — réseau seulement en prod
        self._client = httpx.Client(
            timeout=self.timeout,
            follow_redirects=True,
            headers={"User-Agent": DEFAULT_UA},
        )
        return self._client

    def _build_request(self, url: str):
        """Compose (payload, query, headers) selon le placement de la clé."""
        payload = dict(self.params)
        payload[self.url_param] = url
        if self.render_js:
            payload[self.render_param] = True
        headers = {}  # type: Dict[str, str]
        query = {}    # type: Dict[str, str]
        if self.key_in == "header":
            headers[self.key_param] = self._api_key
        elif self.key_in == "query":
            query[self.key_param] = self._api_key
        else:  # body
            payload[self.key_param] = self._api_key
        return payload, query, headers

    def _request(self, client, url: str):
        payload, query, headers = self._build_request(url)
        if self.method == "GET":
            # GET : tout part en query (pas de corps)
            q = dict(query)
            q.update(payload)
            return client.get(self._endpoint, params=q, headers=headers,
                              timeout=self.timeout)
        return client.post(self._endpoint, json=payload,
                           params=query or None, headers=headers,
                           timeout=self.timeout)

    def _envelope_status(self, data: Dict[str, Any]):
        """Statut CIBLE reporté dans l'enveloppe (int) ou None. Provider-agnostique :
        champ configurable, sinon noms communs. ``bool`` ignoré (True != 1)."""
        keys = [self.status_field] if self.status_field else \
            ["status_code", "statusCode", "status"]
        for k in keys:
            v = data.get(k)
            if isinstance(v, bool):
                continue
            if isinstance(v, int):
                return v
            if isinstance(v, str) and v.isdigit():
                return int(v)
        return None

    def _read_body(self, resp) -> str:
        """HTML brut, ou champ d'une enveloppe JSON si ``result_field`` est posé.

        Beaucoup de débloqueurs renvoient HTTP 200 et reportent le statut/erreur
        de la CIBLE *dans* l'enveloppe -> on l'inspecte pour ne pas rendre un
        blocage comme un faux succès (sinon la reco déterministe, qui compte les
        PushbackError, ne se déclencherait jamais)."""
        if not self.result_field:
            return resp.text or ""
        try:
            data = resp.json()
        except Exception:  # noqa: BLE001 — pas du JSON -> texte brut
            return resp.text or ""
        if not isinstance(data, dict):
            return resp.text or ""
        # erreur explicite reportée par le provider
        if self.error_field and data.get(self.error_field):
            raise FetchError("unblocker envelope error: {0}".format(
                str(data.get(self.error_field))[:120]))
        # statut cible >= 400 reporté dans l'enveloppe (HTTP 200 au niveau API)
        st = self._envelope_status(data)
        if st is not None and st >= 400:
            if st in (429, 503):
                raise PushbackError("unblocker target HTTP {0}".format(st), status=st)
            raise FetchError("unblocker target HTTP {0}".format(st))
        val = data.get(self.result_field)
        if isinstance(val, str) and val:
            return val
        # result_field configuré mais vide/absent -> échec dur (pas un faux succès)
        raise FetchError(
            "unblocker envelope missing/empty '{0}'".format(self.result_field))

    def get(self, url: str) -> str:
        """Fetch ``url`` via le débloqueur ; lève FetchError si non configuré /
        échec dur, PushbackError si le provider ou la cible pousse."""
        if not self._endpoint or not self._api_key:
            raise FetchError(
                "unblocker non configuré : pose HARVESTER_UNBLOCKER_KEY (et "
                "HARVESTER_UNBLOCKER_ENDPOINT) dans .env")
        client = self._get_client()
        last = None  # type: Optional[str]
        for attempt in range(self.retries):
            self.rate.wait()
            try:
                resp = self._request(client, url)
            except Exception as e:  # noqa: BLE001
                # 🔒 get() est la frontière qui possède la clé : on réduit TOUTE
                # exception de requête à son nom de classe — jamais repr(e), qui
                # porterait l'URL (donc la clé si key_in='query'). Couvre aussi
                # les exceptions httpx hors HTTPError (InvalidURL, etc.).
                last = type(e).__name__
            else:
                sc = resp.status_code
                # pushback : 429, ou 503 avec Retry-After -> l'engine recule
                if sc == 429 or (sc == 503 and resp.headers.get("Retry-After")):
                    raise PushbackError(
                        "unblocker HTTP {0}".format(sc), status=sc,
                        retry_after=_parse_retry_after(resp.headers.get("Retry-After")))
                if sc >= 400:
                    last = "HTTP {0}".format(sc)
                else:
                    # _read_body peut lever (enveloppe d'erreur / vide) -> pas
                    # de faux succès ; ces exceptions ne sont PAS rattrapées ici.
                    html = self._read_body(resp)
                    # même en 200, le provider peut nous rendre une page de
                    # challenge non résolue -> ne jamais l'accepter comme contenu
                    if is_challenge(html) or is_challenge_html(html):
                        raise PushbackError("unblocker returned challenge page",
                                            status=sc, retry_after=None)
                    return html
            if attempt < self.retries - 1:
                self._sleep(1.0 * (attempt + 1))  # back-off linéaire (transitoire)
        raise FetchError("GET {0} via unblocker failed: {1}".format(url, last))
