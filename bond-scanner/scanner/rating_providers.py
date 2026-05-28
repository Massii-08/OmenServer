"""
Provider di rating Bond Scanner — Brave Search API + site:fitchratings.com.

Strategia (decisa 2026-05-28 PM, mirror Yield Bot) :
- Source UNIQUE = pagine fitchratings.com indicizzate da Brave Search.
- Lettura del TITOLO della pagina Fitch (es. "Fitch Affirms IBM's IDR at 'A-'").
- Se Fitch non rate l'emittente → 0 hits → rating restituito None.
- Cache JSON 30 giorni per ISIN (~/.cache/bond-scanner-ratings.json).

Politica fitch_only:
- Si NON accetta rating S&P/Moody's da fallback.
- Cellula Excel resta vuota se Fitch non copre l'emittente.

Configurazione:
- Env var BRAVE_SEARCH_API_KEY (condivisa con Yield Bot, lookup via Keychain).
- Se assente → provider restituisce None senza errore.

Riferimento porting :
- Projet serveur/yield-bot/scraper/rating_fetcher.py:370 (_try_brave_search)
- Projet serveur/yield-bot/scraper/rating_fetcher.py:163 (FITCH_TITLE_RATING_RE)
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import re
from abc import ABC, abstractmethod
from datetime import date, timedelta
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from scanner.models import RatingInfo

logger = logging.getLogger(__name__)

# ============================================================================
#  Costanti rating (riusate da filter/criteria.py)
# ============================================================================

SP_RATING_PATTERN = re.compile(
    r'^(AAA|AA\+|AA|AA-|A\+|A|A-|BBB\+|BBB|BBB-|BB\+|BB|BB-|B\+|B|B-|'
    r'CCC\+|CCC|CCC-|CC|C|D)$',
    re.IGNORECASE,
)
MOODY_RATING_PATTERN = re.compile(
    r'^(Aaa|Aa[123]?|A[123]?|Baa[123]?|Ba[123]?|B[123]?|'
    r'Caa[123]?|Ca|C)$',
    re.IGNORECASE,
)
INVALID_RATINGS = {
    'nr', 'n/a', 'na', '-', 'not rated', 'unrated', 'none',
    'n.a.', 'n.r.', '--', '—', '', 'k.a.', 'keine angabe',
}


def is_valid_rating(value: str) -> bool:
    """Verifica se una stringa è un rating S&P/Fitch o Moody's valido."""
    if not value or not isinstance(value, str):
        return False
    cleaned = value.strip()
    if cleaned.lower() in INVALID_RATINGS:
        return False
    if len(cleaned) < 1 or len(cleaned) > 10:
        return False
    return bool(
        SP_RATING_PATTERN.match(cleaned) or MOODY_RATING_PATTERN.match(cleaned)
    )


RATING_SCALE = [
    'AAA', 'AA+', 'AA', 'AA-',
    'A+', 'A', 'A-',
    'BBB+', 'BBB', 'BBB-',
    'BB+', 'BB', 'BB-',
    'B+', 'B', 'B-',
    'CCC+', 'CCC', 'CCC-',
    'CC', 'C', 'D',
]

MOODY_TO_SP = {
    'Aaa': 'AAA',
    'Aa1': 'AA+', 'Aa2': 'AA', 'Aa3': 'AA-', 'Aa': 'AA',
    'A1': 'A+', 'A2': 'A', 'A3': 'A-',
    'Baa1': 'BBB+', 'Baa2': 'BBB', 'Baa3': 'BBB-', 'Baa': 'BBB',
    'Ba1': 'BB+', 'Ba2': 'BB', 'Ba3': 'BB-', 'Ba': 'BB',
    'B1': 'B+', 'B2': 'B', 'B3': 'B-',
    'Caa1': 'CCC+', 'Caa2': 'CCC', 'Caa3': 'CCC-', 'Caa': 'CCC',
    'Ca': 'CC', 'C': 'C',
}


def normalize_to_sp(rating: str) -> Optional[str]:
    """Normalizza un rating al formato S&P (consumato da filter/criteria)."""
    if not rating:
        return None
    rating = rating.strip()
    if rating.upper() in [r.upper() for r in RATING_SCALE]:
        return rating.upper()
    if rating in MOODY_TO_SP:
        return MOODY_TO_SP[rating]
    for moody, sp in MOODY_TO_SP.items():
        if rating.lower() == moody.lower():
            return sp
    return rating.upper()


# ============================================================================
#  Regex sui titoli Fitch (porting esatto da yield-bot)
# ============================================================================

FITCH_TITLE_RATING_RE = re.compile(
    r"['\"‘’“”]"
    r"(?P<rating>"
    r"AAA|AA\+|AA-|AA|A\+|A-"
    r"|BBB\+|BBB-|BBB|BB\+|BB-|BB|B\+|B-"
    r"|CCC\+|CCC-|CCC|CC|D"
    r"|A|B|C"
    r")"
    r"['\"‘’“”]"
)


# ============================================================================
#  Cache JSON 30-day TTL (porting da yield-bot _Cache)
# ============================================================================

CACHE_PATH = Path.home() / '.cache' / 'bond-scanner-ratings.json'
CACHE_TTL = timedelta(days=30)


class _Cache:
    def __init__(self, path: Path = CACHE_PATH):
        self.path = path
        self._data: dict = {}
        self._load()

    def _load(self):
        try:
            self._data = json.loads(self.path.read_text())
        except (FileNotFoundError, json.JSONDecodeError):
            self._data = {}

    def _save(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.path.write_text(json.dumps(self._data, indent=2, sort_keys=True))

    def get(self, isin: str) -> Optional[dict]:
        entry = self._data.get(isin)
        if not entry:
            return None
        try:
            cached_date = date.fromisoformat(entry.get('date', ''))
        except ValueError:
            return None
        if date.today() - cached_date > CACHE_TTL:
            return None
        return entry

    def set(self, isin: str, rating: str, agency: str, source: str):
        self._data[isin] = {
            'rating': rating,
            'agency': agency,
            'source': source,
            'date': date.today().isoformat(),
        }
        self._save()


# ============================================================================
#  Provider base (kept for forward compat — if we re-add sources later)
# ============================================================================

class RatingProvider(ABC):
    @abstractmethod
    async def get_rating(
        self, isin: str, bond_name: str = None, **kwargs
    ) -> Optional[RatingInfo]:
        pass

    @property
    @abstractmethod
    def source_tag(self) -> str:
        pass

    @property
    @abstractmethod
    def source_name(self) -> str:
        pass


# ============================================================================
#  BraveFitchProvider — SOLE source
# ============================================================================

# Suffissi legali puri — stripabili senza rischio di confondere entità diverse.
# NON includere "Worldwide" / "Finance" / "Holdings" / "Capital" — questi
# distinguono entità separate con rating diversi (Hilton Worldwide vs Hilton
# Grand Vacations Trust, AstraZeneca Finance LLC vs AstraZeneca PLC parent).
_LEGAL_SUFFIXES = (
    ' Inc.', ' Inc', ' Corporation', ' Corp.', ' Corp',
    ' LLC', ' PLC', ' Plc', ' Ltd.', ' Ltd',
    ' SA', ' AG', ' NV', ' GmbH', ' SpA',
)

# Scoring keywords (ported verbatim from yield-bot)
_HIGH_PREF = (
    'upgrades', 'downgrades', 'affirms', 'idr', 'credit ratings',
)
_ISSUE_SPECIFIC = (
    'senior notes', 'junior', 'sub notes', 'convertible', 'subordinated',
)
# Reject keywords: securitisation structures whose rating is unrelated
# to the underlying corporate bond.
_REJECT = (
    'trust', 'grand vacations', 'abs', 'rmbs', 'cmbs',
    'presale', 'covered bond', 'mortgage', 'clo', 'spv',
)


class BraveFitchProvider(RatingProvider):
    """
    Rating provider unico per il Bond Scanner.

    Cerca il rating Fitch dell'emittente tramite Brave Search API
    con `site:fitchratings.com {issuer}`. Parsing del rating nel
    TITOLO della pagina Fitch indicizzata, tra apici (curli o dritti).

    Restituisce RatingInfo("BBB+", "Fitch", "Fitch Ratings via Brave")
    oppure None se Fitch non rate l'emittente.
    """

    BRAVE_ENDPOINT = 'https://api.search.brave.com/res/v1/web/search'

    @property
    def source_tag(self) -> str:
        return 'Fitch'

    @property
    def source_name(self) -> str:
        return 'Fitch Ratings via Brave'

    def __init__(
        self,
        api_key: Optional[str] = None,
        cache: Optional[_Cache] = None,
        http_timeout_s: float = 15.0,
    ):
        self.api_key = api_key or os.environ.get('BRAVE_SEARCH_API_KEY')
        self.cache = cache if cache is not None else _Cache()
        self.timeout = http_timeout_s
        # Task post-15:30 (2026-05-28) : détection quota Brave épuisée.
        # Brave renvoie 429 pour 2 cas distincts :
        #   - throttling per-seconde (1 req/s sur free tier) → transient
        #   - quota mensuelle dépassée (1000 req/mois free)   → terminal
        # On détecte le terminal soit par le body (mots-clés 'quota'/'monthly'/
        # 'exhausted'), soit par 3 x 429 consécutifs (fallback). Une fois le
        # flag posé, get_rating() court-circuite — pas d'appel HTTP — pour
        # laisser le scan se finir vite et générer l'Excel avec un banner.
        self.quota_exhausted: bool = False
        self._consecutive_429: int = 0
        # Réserve de sécurité Brave (demande Massii 2026-05-28).
        self.remaining_monthly: Optional[int] = None  # dernier X-RateLimit-Remaining mensuel
        self.quota_low: bool = False                    # True si remaining ≤ buffer

    BRAVE_SAFETY_BUFFER = 50  # on arrête quand il reste ≤ 50 requêtes mensuelles

    def _read_remaining(self, response):
        """
        Lit X-RateLimit-Remaining de la réponse Brave et met à jour
        self.remaining_monthly + self.quota_low.

        Format Brave : "X-RateLimit-Remaining: 1, 1965" → [par_sec, par_mois].
        On prend la DERNIÈRE valeur (mensuelle). Robuste si une seule valeur.
        """
        try:
            raw = response.headers.get('X-RateLimit-Remaining') or \
                  response.headers.get('x-ratelimit-remaining')
            if not raw:
                return
            parts = [p.strip() for p in str(raw).split(',') if p.strip()]
            if not parts:
                return
            monthly = int(float(parts[-1]))
            self.remaining_monthly = monthly
            if monthly <= self.BRAVE_SAFETY_BUFFER:
                self.quota_low = True
                logger.warning(
                    f"    ⚠️  Réserve Brave basse : {monthly} requêtes restantes "
                    f"(≤ {self.BRAVE_SAFETY_BUFFER}) → arrêt préventif."
                )
        except (ValueError, AttributeError) as e:
            logger.debug(f"    parse X-RateLimit-Remaining: {e!r}")

    # ---- helpers ----------------------------------------------------

    def _strip_issuer(self, issuer: str) -> str:
        """Strip prudente: solo suffissi legali puri, mai 'Worldwide'/'Finance'."""
        if not issuer:
            return ''
        out = issuer.strip()
        for suffix in _LEGAL_SUFFIXES:
            if out.endswith(suffix):
                return out[: -len(suffix)].strip()
        return out

    def _score_title(self, title: str) -> int:
        """
        Punteggia un titolo Fitch per preferire i hit Issuer.

        Returns:
            int: punteggio (più alto = più preferito), oppure -999 se il titolo
            contiene una keyword REJECT (sentinella per scartare i hit, evita
            di propagare un secondo flag bool al chiamante).

        Scala:
          +2  : HIGH_PREF keyword (upgrades/downgrades/affirms/idr/credit ratings)
                → annuncio di rating Issuer, fonte autoritativa.
           0  : nessun match (neutro). I titoli ISSUE_SPECIFIC come "Senior
                Notes" / "Sub Notes" sono lasciati a 0 — accettabili come
                fallback ma sovrascritti dal primo hit Issuer trovato.
        -999  : REJECT keyword (trust/abs/rmbs/cmbs/grand vacations/...)
                → securitisation, rating senza rapporto con il bond corporate.
        """
        title_lower = title.lower()
        if any(kw in title_lower for kw in _REJECT):
            return -999
        score = 0
        if any(kw in title_lower for kw in _HIGH_PREF):
            score += 2
        return score

    # ---- main entry --------------------------------------------------

    async def get_rating(
        self, isin: str, bond_name: str = None, **kwargs
    ) -> Optional[RatingInfo]:
        if not isin or not bond_name:
            return None

        # 1. Cache
        cached = self.cache.get(isin)
        if cached:
            logger.info(
                f"    📦 Cache hit {isin} → {cached['rating']} ({cached['agency']})"
            )
            if cached.get('agency') == 'Fitch' and cached.get('rating'):
                return RatingInfo(
                    value=cached['rating'],
                    source=self.source_tag,
                    source_full=self.source_name,
                )
            # Cache entry exists but was None (sentinel for "no Fitch") → skip
            return None

        # 2. No API key → skip silently
        if not self.api_key:
            logger.debug("    ⚠️  BRAVE_SEARCH_API_KEY assente, skip rating")
            return None

        # 2b. Quota déjà détectée épuisée → court-circuite, pas d'appel HTTP
        if self.quota_exhausted:
            return None

        # 3. HTTP call
        issuer_short = self._strip_issuer(bond_name)
        if not issuer_short:
            return None

        query = f'site:fitchratings.com {issuer_short}'
        headers = {
            'X-Subscription-Token': self.api_key,
            'Accept': 'application/json',
        }
        params = {'q': query, 'count': 10, 'result_filter': 'web'}

        try:
            import httpx
        except ImportError:
            logger.warning(
                "    ⚠️  httpx non installato — aggiungere a requirements.txt"
            )
            return None

        try:
            async with httpx.AsyncClient(timeout=self.timeout) as client:
                r = await client.get(
                    self.BRAVE_ENDPOINT, headers=headers, params=params,
                )
        except Exception as e:
            logger.debug(f"    ⚠️  Brave fetch error: {e!r}")
            return None

        # Réserve de sécurité (2026-05-28, demande Massii) : Brave renvoie
        # X-RateLimit-Remaining ("<par_sec>, <par_mois>"). On lit le restant
        # MENSUEL (dernière valeur). Si ≤ BRAVE_SAFETY_BUFFER (50), on lève un
        # flag quota_low → le scan s'arrête proprement et les nouveaux scans
        # sont bloqués (garde-fou backend). Protège une réserve de 50 requêtes.
        self._read_remaining(r)

        if r.status_code == 429:
            # 429 a deux causes possibles : throttling per-seconde (transient)
            # OU quota mensuelle dépassée (terminal). On détecte le terminal :
            body_lower = (r.text or '').lower()
            quota_keywords = ('quota', 'monthly', 'exhausted', 'limit exceeded',
                              'plan limit', 'subscription')
            is_quota_terminal = any(kw in body_lower for kw in quota_keywords)

            self._consecutive_429 += 1
            if is_quota_terminal or self._consecutive_429 >= 5:
                self.quota_exhausted = True
                logger.error(
                    f"    🚫 BRAVE QUOTA ÉPUISÉE détectée "
                    f"(consecutive 429={self._consecutive_429}, "
                    f"body match={is_quota_terminal}). "
                    f"Interrompo gli appels Brave per il resto dello scan."
                )
            else:
                logger.warning(
                    f"    ⚠️  Brave 429 transient ({self._consecutive_429}/5). "
                    f"Body: {r.text[:120]!r}"
                )
            return None

        # Reset le compteur 429 sur tout autre statut (recovery propre)
        self._consecutive_429 = 0

        if r.status_code != 200:
            logger.debug(
                f"    ⚠️  Brave status={r.status_code} body={r.text[:200]}"
            )
            return None

        try:
            data = r.json()
        except Exception:
            return None

        results = data.get('web', {}).get('results', []) or []
        if not results:
            logger.debug(f"    Brave: 0 hit per {query!r}")
            # Cache the negative result so we don't re-query for 30 days
            self.cache.set(isin, '', '', f'Brave no-hit ({issuer_short})')
            return None

        # 4. Scoring + selection
        best: Optional[Tuple[int, str, str]] = None  # (score, rating, url)

        for res in results:
            url = res.get('url', '') or ''
            if 'fitchratings.com' not in url.lower():
                continue
            title = res.get('title', '') or ''
            title_lower = title.lower()
            if 'fitch' not in title_lower:
                continue
            score = self._score_title(title)
            if score < 0:
                logger.debug(f"    ⊘ Reject: {title[:80]!r}")
                continue
            m = FITCH_TITLE_RATING_RE.search(title)
            if not m:
                continue
            rating = normalize_to_sp(m.group('rating'))
            if not rating:
                continue
            logger.debug(
                f"    · score={score:+d} rating={rating} title={title[:80]!r}"
            )
            if best is None or score > best[0]:
                best = (score, rating, url)

        if best:
            _score, rating, hit_url = best
            logger.info(
                f"    📊 Rating da Fitch (Brave): {rating} — {hit_url}"
            )
            self.cache.set(isin, rating, 'Fitch', 'Brave Search')
            return RatingInfo(
                value=rating,
                source=self.source_tag,
                source_full=self.source_name,
            )

        # No usable hit despite results returned → still cache as negative
        self.cache.set(isin, '', '', f'Brave no-match ({issuer_short})')
        return None


# ============================================================================
#  CLI smoke test
# ============================================================================

if __name__ == '__main__':
    import argparse

    logging.basicConfig(
        level=logging.INFO,
        format='%(asctime)s | %(message)s',
        datefmt='%H:%M:%S',
    )
    parser = argparse.ArgumentParser(
        description='Smoke test BraveFitchProvider.'
    )
    parser.add_argument('isin', help='ISIN (es: US25746UCY38)')
    parser.add_argument('issuer', help='Nome emittente (es: "Dominion Energy Inc")')
    args = parser.parse_args()

    async def _main():
        provider = BraveFitchProvider()
        ri = await provider.get_rating(args.isin, bond_name=args.issuer)
        if ri:
            print(f"\nResult: {ri.value} ({ri.source_full})")
        else:
            print("\nResult: NOT FOUND (Fitch ne rate pas cet émetteur)")

    asyncio.run(_main())
