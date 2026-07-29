"""Résolution nom de société → symbole boursier, via la recherche Yahoo.

C'est le chaînon qui manquait : `discover()` rend une liste VIDE sans résolveur,
et `main.py` l'appelait sans en fournir — l'option « scoperte » ne produisait
donc jamais rien, sans la moindre erreur. Bug vécu, corrigé ici.

⚠️ **La règle anti-homonyme.** Deux sociétés peuvent porter le même nom :
« Trevi » est une société de construction cotée à Milan, et aussi un laboratoire
américain au Nasdaq. Quand une dépêche ITALIENNE parle de Trevi, elle parle de
l'italienne — mais la recherche Yahoo rend l'américaine en tête. Nommer la
mauvaise société est pire que n'en nommer aucune : c'est la leçon du piège #31
du dépôt (Iccrea Banca résolu en ICBC).

Donc : quand la langue de la dépêche désigne une place, on n'accepte QUE une
cotation sur cette place. Si elle n'existe pas dans les résultats, **on
abandonne** le candidat. Recall < correctness, comme pour les notations Fitch.
"""
import json
import time
from typing import Any, Callable, Dict, Optional

from .discover import EXCHANGE_MAP

SEARCH_URL = ("https://query1.finance.yahoo.com/v1/finance/search"
              "?q=%s&quotesCount=6&newsCount=0")

# La langue de la dépêche désigne une place. « en » n'en désigne aucune : un
# titre anglais peut parler de n'importe quelle société du monde.
LANG_VENUE = {
    "it": "euronext",
    "fr": "euronext",
    "nl": "euronext",
    "de": "deutsche_boerse",
    "ja": "jpx",
}


def _fetch(url: str) -> Optional[Dict[str, Any]]:
    """Requête curl_cffi — la recherche Yahoo exige l'empreinte Chrome."""
    from curl_cffi import requests as creq
    session = getattr(_fetch, "_session", None)
    if session is None:
        session = creq.Session(impersonate="chrome")
        _fetch._session = session
    response = session.get(url, timeout=20)
    if response.status_code != 200:
        return None
    try:
        return response.json()
    except (ValueError, json.JSONDecodeError):
        return None


def make_resolver(fetch: Callable[[str], Optional[Dict[str, Any]]] = None,
                  pacing_s: float = 0.4,
                  sleep: Callable[[float], None] = time.sleep
                  ) -> Callable[..., Optional[Dict[str, str]]]:
    """Construit le résolveur que `discover()` attend.

    `fetch` est injectable pour que les tests n'aient aucun réseau.
    """
    fetch = fetch or _fetch

    def resolve(name: str, lang: str = "") -> Optional[Dict[str, str]]:
        if not name or not str(name).strip():
            return None
        if pacing_s:
            sleep(pacing_s)
        try:
            payload = fetch(SEARCH_URL % str(name).replace(" ", "+"))
        except Exception:
            return None
        if not payload:
            return None

        first_word = str(name).split()[0].lower()
        candidates = []
        for quote in (payload.get("quotes") or []):
            if quote.get("quoteType") != "EQUITY" or not quote.get("symbol"):
                continue
            # Garde-fou d'IDENTITÉ : le nom rendu doit vraiment contenir le nom
            # cherché. Sans ça, « Tap » ressort en « Tapestry ».
            shortname = (quote.get("shortname") or quote.get("longname") or "").lower()
            if first_word not in shortname:
                continue
            candidates.append(quote)
        if not candidates:
            return None

        wanted = LANG_VENUE.get((lang or "").lower())
        if wanted:
            for quote in candidates:
                venue = EXCHANGE_MAP.get((quote.get("exchange") or "").upper())
                if venue == wanted:
                    return _shape(quote)
            # La langue désignait une place et aucune cotation ne s'y trouve :
            # on ABANDONNE plutôt que de nommer un homonyme étranger.
            return None
        return _shape(candidates[0])

    return resolve


def _shape(quote: Dict[str, Any]) -> Dict[str, str]:
    return {
        "symbol": quote["symbol"],
        "name": quote.get("shortname") or quote.get("longname") or quote["symbol"],
        "exchange": quote.get("exchange") or "",
    }
