"""
Rating Fitch PAR ISIN — source UNIQUE, précise, vérifiable à la main.

Stratégie (décidée 2026-05-29, demande Massii « fitch only ISIN ») :
- On interroge l'API GraphQL publique de Fitch `api.fitchratings.com` avec
  `search(term: <ISIN>, item: IDENTIFIERS)`. L'ISIN étant unique, AUCUNE
  ambiguïté de nom (fini les Iccrea→ICBC, Bund→Telefonica, etc.).
- Cloudflare bloque les clients serveur au niveau TLS → on utilise `curl_cffi`
  qui imite l'empreinte TLS de Chrome (validé : 200 sur www + api).
- La réponse contient :
    entity[]  → l'émetteur + ses notations (Long Term Issuer Default Rating…)
    issue[]   → les titres, chacun avec son tableau `isin` + ses notations
                (Long Term Rating du titre — peut différer de l'IDR pour les
                secured/subordinated, ex. Oncor : IDR BBB+ mais note secured A)
- Par défaut on rend la **note du TITRE exact** (l'ISIN cherché — c'est LE rating
  du bond, ex. Oncor secured → A), avec fallback sur la note émetteur Long Term
  IDR si le titre n'a pas de note propre. Décision Massii 2026-05-29. La note
  émetteur reste dispo (champ `issuer_rating`) — bascule via PREFER_SECURITY_RATING.
- Si Fitch ne couvre pas l'ISIN (totalHits 0 / pas de note LT) → None →
  bond exclu (scanner) / cellule '?' (yield bot).

URL de vérification (cliquable, = la recherche manuelle de Massii) :
    https://www.fitchratings.com/search/?query=<ISIN>

Cache : ~/.cache/bond-scanner-ratings.json (réutilise _Cache, TTL 30j, négatifs
inclus, stocke l'URL).
"""
from __future__ import annotations

import logging
import time
from datetime import date, timedelta
from pathlib import Path
from typing import Optional

from scanner.models import RatingInfo
from scanner.rating_providers import _Cache, is_valid_rating, normalize_to_sp

logger = logging.getLogger(__name__)

# ============================================================================
#  Contrat GraphQL (extrait par rétro-ingénierie du bundle Fitch, 2026-05-29)
# ============================================================================

FITCH_GRAPHQL_ENDPOINT = "https://api.fitchratings.com/"
FITCH_VERIFY_URL = "https://www.fitchratings.com/search/?query={isin}"

_SEARCH_QUERY = (
    "query($t:String!,$i:SearchItem){"
    "search(term:$t,item:$i){"
    "totalHits "
    "entity{name ratings{ratingTypeDescription ratingActionDescription ratingCode ratingEffectiveDate}} "
    "issue{isin ratableTypeDescription "
    "ratings{ratingTypeDescription ratingActionDescription ratingCode ratingEffectiveDate}}"
    "}}"
)

# DÉFAUT = note du TITRE exact (issue matchant l'ISIN) quand elle existe — c'est
# LE rating du bond précis (ex. Oncor secured → A). Fallback sur la note émetteur
# (Long Term IDR) si le titre n'a pas de note propre. (Décision Massii 2026-05-29 :
# « la note du titre exact ».) Mettre False pour préférer la note émetteur.
PREFER_SECURITY_RATING = True

_LONG_TERM_IDR = "long term issuer default rating"
_LONG_TERM = "long term"

_HEADERS = {
    "content-type": "application/json",
    "accept": "application/json",
    "origin": "https://www.fitchratings.com",
    "referer": "https://www.fitchratings.com/",
}


# ============================================================================
#  Parsing pur (testable sans réseau)
# ============================================================================

def _first_lt_rating(ratings: list, *, idr_only: bool) -> Optional[dict]:
    """
    Renvoie la 1ère notation Long Term valide d'une liste `ratings`.

    idr_only=True  → uniquement "Long Term Issuer Default Rating" (émetteur).
    idr_only=False → toute notation dont le type contient "Long Term" (titre).
    """
    for r in ratings or []:
        typ = (r.get("ratingTypeDescription") or "").strip().lower()
        code = (r.get("ratingCode") or "").strip()
        if idr_only:
            if typ != _LONG_TERM_IDR:
                continue
        else:
            if _LONG_TERM not in typ:
                continue
        if is_valid_rating(code):
            return r
    return None


def select_rating(response: dict, isin: str,
                  prefer_security: bool = PREFER_SECURITY_RATING) -> Optional[dict]:
    """
    Extrait la notation pour `isin` depuis la réponse GraphQL Fitch.

    Accepte soit la réponse complète ({"data":{"search":{...}}}), soit
    directement l'objet `search`. Renvoie un dict ou None.

    dict : {
      isin, rating, issuer_rating, issuer_name, security_rating,
      rating_type, action, effective_date, url
    }
    """
    if not response or not isin:
        return None
    search = response.get("data", {}).get("search") if "data" in response else response.get("search", response)
    if not isinstance(search, dict):
        return None

    # 1. Note émetteur (Long Term IDR) depuis entity[]
    issuer_rating = None
    issuer_name = None
    issuer_meta = None
    for e in (search.get("entity") or []):
        hit = _first_lt_rating(e.get("ratings"), idr_only=True)
        if hit:
            issuer_rating = normalize_to_sp(hit["ratingCode"].strip())
            issuer_name = e.get("name")
            issuer_meta = hit
            break

    # 2. Note du TITRE exact depuis issue[] dont le tableau isin contient l'ISIN
    security_rating = None
    security_meta = None
    isin_u = isin.strip().upper()
    for iss in (search.get("issue") or []):
        isins = [str(x).strip().upper() for x in (iss.get("isin") or [])]
        if isin_u not in isins:
            continue
        hit = _first_lt_rating(iss.get("ratings"), idr_only=False)
        if hit:
            security_rating = normalize_to_sp(hit["ratingCode"].strip())
            security_meta = hit
            break

    # 3. Note primaire : émetteur par défaut, titre si prefer_security.
    if prefer_security and security_rating:
        primary, meta = security_rating, security_meta
    elif issuer_rating:
        primary, meta = issuer_rating, issuer_meta
    elif security_rating:
        # pas d'IDR émetteur mais le titre est noté → on prend le titre
        primary, meta = security_rating, security_meta
    else:
        return None

    eff = (meta or {}).get("ratingEffectiveDate") or ""
    return {
        "isin": isin,
        "rating": primary,
        "issuer_rating": issuer_rating,
        "issuer_name": issuer_name,
        "security_rating": security_rating,
        "rating_type": (meta or {}).get("ratingTypeDescription"),
        "action": (meta or {}).get("ratingActionDescription"),
        "effective_date": eff[:10] if eff else None,
        "url": FITCH_VERIFY_URL.format(isin=isin),
    }


# ============================================================================
#  Client réseau (curl_cffi — empreinte TLS Chrome pour passer Cloudflare)
# ============================================================================

class FitchIsinClient:
    """
    Client Fitch par ISIN. Réutilise une session curl_cffi (impersonate chrome)
    et un cache JSON 30j. `fetch(isin)` → dict select_rating() ou None.

    Le flag `unreachable` passe à True si Cloudflare/TLS bloque (curl_cffi
    indisponible ou handshake refusé) → le bond_scanner peut arrêter proprement
    plutôt que de marteler une cible injoignable.
    """

    def __init__(self, cache: Optional[_Cache] = None, http_timeout_s: float = 25.0,
                 prefer_security: bool = PREFER_SECURITY_RATING):
        self.cache = cache if cache is not None else _Cache()
        self.timeout = http_timeout_s
        self.prefer_security = prefer_security
        self._session = None
        self.unreachable = False
        self._consecutive_fail = 0

    def _get_session(self):
        if self._session is None:
            from curl_cffi import requests as creq  # import paresseux
            self._session = creq.Session(impersonate="chrome")
        return self._session

    def _query_with_retry(self, isin: str, attempts: int = 3) -> Optional[dict]:
        """POST GraphQL avec retry. Renvoie le dict réponse (clé 'data') ou None.

        La 1ère requête d'une session curl_cffi reçoit parfois un challenge
        Cloudflare HTML (status 200 mais pas de JSON) → on réessaie. On ne lève
        le flag `unreachable` (arrêt du scan) qu'après 5 échecs CONSÉCUTIFS
        (vrai blocage Cloudflare), pas pour un blip ponctuel.
        """
        try:
            session = self._get_session()
        except ImportError:
            logger.warning("    ⚠️  curl_cffi non installé — `pip install curl_cffi`")
            self.unreachable = True
            return None
        payload = {"query": _SEARCH_QUERY, "variables": {"t": isin, "i": "IDENTIFIERS"}}
        for i in range(attempts):
            try:
                r = session.post(FITCH_GRAPHQL_ENDPOINT, json=payload,
                                 headers=_HEADERS, timeout=self.timeout)
            except Exception as e:
                # Exception réseau/TLS → Cloudflare bloque au handshake (persistant)
                logger.warning(f"    ⚠️  Fitch connexion KO ({isin}): {e!r}")
                self._consecutive_fail += 1
                if self._consecutive_fail >= 5:
                    self.unreachable = True
                return None
            if r.status_code == 200:
                try:
                    data = r.json()
                except Exception:
                    time.sleep(0.6 * (i + 1))  # 200 sans JSON = challenge → retry
                    continue
                if isinstance(data, dict) and "data" in data:
                    self._consecutive_fail = 0  # succès → reset
                    return data
                time.sleep(0.6 * (i + 1))
                continue
            if r.status_code in (403, 429, 503):
                time.sleep(0.8 * (i + 1))  # rate-limit/challenge transitoire → retry
                continue
            logger.debug(f"    ⚠️  Fitch status={r.status_code} ({isin})")
            return None
        # tous les essais épuisés sans réponse JSON valide
        self._consecutive_fail += 1
        if self._consecutive_fail >= 5:
            logger.warning(f"    🚫 Fitch injoignable (5 échecs consécutifs) — arrêt.")
            self.unreachable = True
        return None

    def fetch(self, isin: str, bond_name: str = None) -> Optional[RatingInfo]:
        """bond_name est ignoré (recherche par ISIN). Présent pour compat d'API."""
        if not isin:
            return None

        # 1. Cache (positif ET négatif)
        cached = self.cache.get(isin)
        if cached is not None:
            if cached.get("agency") == "Fitch" and cached.get("rating"):
                return RatingInfo(
                    value=cached["rating"], source="Fitch",
                    source_full="Fitch Ratings (ISIN)",
                    source_url=cached.get("url", FITCH_VERIFY_URL.format(isin=isin)),
                )
            return None  # sentinelle négative

        if self.unreachable:
            return None

        # 2. Appel GraphQL Fitch (avec retry : la 1ère requête d'une session
        #    fraîche reçoit parfois un challenge Cloudflare HTML au lieu du JSON).
        data = self._query_with_retry(isin)
        if data is None:
            return None

        result = select_rating(data, isin, prefer_security=self.prefer_security)
        if result:
            logger.info(
                f"    📊 Fitch {isin} → {result['rating']} "
                f"({result.get('rating_type')}) — {result['url']}"
            )
            self.cache.set(isin, result["rating"], "Fitch", "Fitch ISIN", url=result["url"])
            return RatingInfo(
                value=result["rating"], source="Fitch",
                source_full="Fitch Ratings (ISIN)", source_url=result["url"],
            )

        # Pas de note Fitch pour cet ISIN → cache négatif (évite de re-payer 30j)
        self.cache.set(isin, "", "", f"Fitch no-hit ({isin})", url="")
        return None


# ============================================================================
#  CLI smoke test
# ============================================================================

if __name__ == "__main__":
    import argparse
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    ap = argparse.ArgumentParser(description="Smoke test Fitch par ISIN.")
    ap.add_argument("isin")
    ap.add_argument("--security", action="store_true", help="préférer la note du titre")
    args = ap.parse_args()
    client = FitchIsinClient(prefer_security=args.security)
    ri = client.fetch(args.isin)
    print(f"\nRésultat: {ri.value if ri else 'NON NOTÉ par Fitch'}"
          + (f" — {ri.source_url}" if ri else ""))
