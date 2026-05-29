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
#  Vérification d'identité émetteur (fix 2026-05-29 — bug Iccrea→ICBC)
# ============================================================================
#
#  Brave `site:fitchratings.com {issuer}` renvoie TOUJOURS des résultats,
#  même quand Fitch ne note pas l'émetteur. La SERP contient alors des pages
#  d'AUTRES émetteurs (même secteur / nom voisin). Sans vérification d'identité
#  on extrayait le rating de la MAUVAISE entité :
#    "Iccrea Banca" → "Fitch Affirms ICBC at 'A'" → Iccrea taggé 'A'.
#    (ICBC = Industrial & Commercial Bank of China ≠ Iccrea Banca.)
#  C'est EXACTEMENT le symptôme rapporté : un rating introuvable à la main sur
#  Fitch pour l'émetteur réel. Pire, le score +2 ('Affirms'/'IDR') PRÉFÉRAIT
#  ces pages-autre-émetteur à la propre page (sans rating) du bon émetteur.
#
#  Garde-fou : on n'accepte un rating QUE si le token identitaire de l'émetteur
#  (1er mot distinctif, ex. "dominion"/"iccrea"/"bayerische") apparaît comme
#  TOKEN du titre OU du slug de l'URL Fitch. Match par token (pas substring)
#  → "ubs" ne matche pas "subsidiary".

# Tokens trop génériques pour identifier un émetteur (formes juridiques + mots
# bancaires/sectoriels ultra-communs, multilingue car bonds EU/US/UK).
_GENERIC_NAME_TOKENS = frozenset({
    'bank', 'banca', 'banque', 'banco', 'banken',
    'group', 'groupe', 'gruppo', 'grupo',
    'financial', 'finance', 'financiere', 'finanz',
    'holding', 'holdings', 'capital', 'capitale',
    'corporation', 'corp', 'company', 'compagnie', 'compagnia',
    'inc', 'incorporated', 'sa', 'ag', 'nv', 'plc', 'spa', 'gmbh',
    'ltd', 'limited', 'llc', 'lp', 'srl', 'se', 'oyj', 'ab', 'asa', 'as',
    'international', 'internazionale', 'investment', 'investments',
    'services', 'service', 'trust', 'public', 'co',
    'energy', 'power', 'utilities', 'utility', 'pharma', 'pharmaceutical',
    'telecom', 'telecommunications', 'insurance', 'assurance',
    'real', 'estate', 'properties', 'property', 'industries', 'industrial',
    'the', 'of', 'and', 'fur', 'von', 'der', 'des', 'du', 'de',
    'la', 'le', 'el', 'und', 'per', 'azioni', 'am', 'an', 'im',
    # --- Mots GÉOGRAPHIQUES / nationaux (fix 2026-05-29 bis) ---
    # Ces mots NE distinguent PAS un émetteur : "deutschland" matchait
    # "Telefonica Deutschland" (→ Bund allemand taggé BBB !) et "deutsche"
    # matchait "Deutsche Bank" (→ DZ BANK taggé A-). On les neutralise pour
    # que le token identitaire tombe sur la VRAIE marque (telekom, zentral…).
    'deutsche', 'deutschland', 'deutscher', 'deutsches', 'germany', 'german',
    'germania', 'bundesrepublik', 'republik', 'republic', 'republica',
    'repubblica', 'republique', 'republik', 'kingdom', 'koninkrijk',
    'kongeriket', 'kongerike', 'federal', 'federale', 'national', 'nationale',
    'nazionale', 'staat', 'stato', 'etat', 'etats', 'estado',
    'france', 'french', 'francaise', 'francais', 'frankreich', 'francia',
    'italia', 'italy', 'italian', 'italiana', 'italiano', 'italie',
    'espana', 'spain', 'spanish', 'espagne', 'espanola',
    'america', 'american', 'americas', 'amerika', 'usa',
    'united', 'britain', 'british', 'england', 'english', 'royaume',
    'europe', 'european', 'europa', 'europea', 'europeenne', 'europaische',
    'netherlands', 'nederland', 'dutch', 'niederlande', 'belgium', 'belgique',
    'belgian', 'belgien', 'luxembourg', 'luxemburg',
    'sweden', 'swedish', 'sverige', 'norway', 'norwegian', 'norge',
    'denmark', 'danish', 'danmark', 'finland', 'finnish', 'suomi',
    'austria', 'osterreich', 'austrian', 'autriche', 'switzerland', 'swiss',
    'suisse', 'schweiz', 'svizzera', 'japan', 'japanese', 'nippon',
    'china', 'chinese', 'korea', 'korean', 'canada', 'canadian',
    'australia', 'australian', 'ireland', 'irish', 'portugal', 'poland',
})

_NAME_TOKEN_RE = re.compile(r'[a-z0-9]+')


def _name_tokens(text: str) -> list:
    """Tokens alphanumériques minuscules (apostrophes/tirets/espaces = séparateurs)."""
    if not text:
        return []
    return _NAME_TOKEN_RE.findall(text.lower())


def _lead_distinctive_token(issuer: str) -> Optional[str]:
    """
    1er token *identitaire* du nom (≥3 lettres, non générique).

    "Dominion Energy"        → "dominion"
    "Iccrea Banca"           → "iccrea"
    "Bayerische Landesbank"  → "bayerische"
    "Banco Santander"        → "santander"  (banco générique → ignoré)
    "Bank Group Holding"     → None         (100% générique → non vérifiable)
    """
    for tok in _name_tokens(issuer):
        if len(tok) >= 3 and tok not in _GENERIC_NAME_TOKENS:
            return tok
    return None


# Anti-péremption (fix 2026-05-29) : les URLs Fitch finissent par la date de
# l'action de notation au format DD-MM-YYYY (ex. .../...-d-...-01-06-2009).
# On rejette les hits trop vieux : un "Fitch Downgrades General Motors to 'D'"
# de 2009 est techniquement sur Fitch mais GM est BBB- aujourd'hui → trompeur.
# 8 ans = assez large pour garder une notation stable peu re-publiée (ex.
# Bayerische Landesbank 2018) tout en tuant les reliques (GM 2009).
RATING_MAX_AGE_YEARS = 8
_RATING_URL_DATE_RE = re.compile(r'(\d{2})-(\d{2})-(\d{4})/?\s*$')


def _url_age_years(url: str) -> Optional[float]:
    """Âge (années) de l'action de notation d'après la date en fin d'URL Fitch.

    Renvoie None si aucune date parsable (page entité, format inattendu) →
    le hit n'est PAS filtré sur l'âge (prudence : on ne jette pas par défaut).
    """
    if not url:
        return None
    m = _RATING_URL_DATE_RE.search(url.strip())
    if not m:
        return None
    try:
        d = date(int(m.group(3)), int(m.group(2)), int(m.group(1)))
    except ValueError:
        return None
    return (date.today() - d).days / 365.25


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

    def set(self, isin: str, rating: str, agency: str, source: str, url: str = ''):
        self._data[isin] = {
            'rating': rating,
            'agency': agency,
            'source': source,
            'url': url,  # URL Fitch vérifiable (fix 2026-05-29)
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
    # 'withdraw' (2026-05-29) : une notation RETIRÉE n'est plus valide
    # (ex. "Fitch Affirms Vodafone West GmbH at 'BBB'; Withdraws Ratings").
    'withdraw',
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

    # On arrête quand il reste ≤ 50 requêtes mensuelles. Ces 50 sont RÉSERVÉES
    # au Yield Bot (clé Brave PARTAGÉE) pour qu'il puisse toujours rater ses bonds.
    BRAVE_SAFETY_BUFFER = 50

    def _read_remaining(self, response):
        """
        Lit X-RateLimit-Remaining de la réponse Brave et met à jour
        self.remaining_monthly + self.quota_low.

        Format Brave : "X-RateLimit-Remaining: 1, 1965" → [par_sec, par_mois].
        On prend la DERNIÈRE valeur (mensuelle). Robuste si une seule valeur.
        """
        try:
            headers = response.headers
            raw = headers.get('X-RateLimit-Remaining') or \
                headers.get('x-ratelimit-remaining')
            if not raw:
                return
            parts = [p.strip() for p in str(raw).split(',') if p.strip()]
            if not parts:
                return
            monthly = int(float(parts[-1]))

            # FIX 2026-05-29 : le plan Brave de Massii est métré (50 req/s,
            # AUCUN cap mensuel). L'API renvoie alors :
            #   x-ratelimit-limit:     50, 0
            #   x-ratelimit-remaining: 49, 0
            # Le "0" mensuel = "pas de quota mensuel configuré", PAS "0 restant"
            # (les requêtes répondent 200). Sans ce garde on lisait 0 ≤ 50 →
            # quota_low=True → scan stoppé après le 1er bond + nouveaux scans
            # bloqués en boucle. On n'arme la réserve QUE s'il existe un VRAI
            # cap mensuel (limite mensuelle > 0).
            raw_limit = headers.get('X-RateLimit-Limit') or \
                headers.get('x-ratelimit-limit')
            monthly_limit = None
            if raw_limit:
                lparts = [p.strip() for p in str(raw_limit).split(',') if p.strip()]
                if lparts:
                    try:
                        monthly_limit = int(float(lparts[-1]))
                    except ValueError:
                        monthly_limit = None

            # limite inconnue (None) → prudence, on garde le comportement
            # historique ; limite == 0 → plan sans cap mensuel → jamais d'alerte.
            has_monthly_cap = (monthly_limit is None) or (monthly_limit > 0)

            # Pas de cap mensuel → remaining_monthly n'a pas de sens : on le
            # met à None (et non 0) pour ne pas persister un "0" qui ferait
            # bloquer le pré-lancement backend (scanner_router._brave_remaining).
            self.remaining_monthly = monthly if has_monthly_cap else None

            if has_monthly_cap and monthly <= self.BRAVE_SAFETY_BUFFER:
                self.quota_low = True
                logger.warning(
                    f"    ⚠️  Réserve Brave basse : {monthly} requêtes restantes "
                    f"(≤ {self.BRAVE_SAFETY_BUFFER}) → arrêt préventif."
                )
        except (ValueError, AttributeError) as e:
            logger.debug(f"    parse X-RateLimit: {e!r}")

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

    def _issuer_matches_hit(self, issuer: str, title: str, url: str) -> bool:
        """
        True si le hit Fitch parle bien DE l'émetteur recherché (fix 2026-05-29).

        On exige que le token identitaire de l'émetteur (ex. "dominion",
        "iccrea", "bayerische") apparaisse comme TOKEN du titre ou du slug de
        l'URL Fitch. Match par token exact (pas substring) → "ubs" ne matche
        pas "subsidiary". Si l'émetteur n'a aucun token distinctif (nom 100%
        générique) → rejet : mieux vaut PAS de rating qu'un faux.

        C'est le garde-fou qui tue le faux positif "Iccrea Banca → ICBC 'A'".
        """
        lead = _lead_distinctive_token(issuer)
        if not lead:
            return False
        haystack = set(_name_tokens(title)) | set(_name_tokens(url))
        return lead in haystack

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
                    source_url=cached.get('url', ''),
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
            # Notation RETIRÉE — le signal "withdraw" est souvent SEULEMENT dans
            # l'URL (titre tronqué par Brave), ex. Vodafone West GmbH 2020.
            if 'withdraw' in url.lower():
                logger.debug(f"    ⊘ Rating retiré (URL withdraw): {url[-60:]!r}")
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

            # GARDE-FOU IDENTITÉ (fix 2026-05-29) : le hit doit parler DU bon
            # émetteur. Sinon Brave nous refile le rating d'une autre entité
            # (Iccrea Banca → ICBC 'A'). On vérifie titre + slug de l'URL.
            if not self._issuer_matches_hit(issuer_short, title, url):
                logger.debug(
                    f"    ⊘ Identité émetteur non confirmée ({issuer_short!r}): "
                    f"{title[:80]!r}"
                )
                continue

            # ANTI-PÉREMPTION (fix 2026-05-29) : on jette les notations trop
            # vieilles (ex. GM 'D' de 2009). Un rating périmé est trompeur même
            # s'il est "vrai" sur Fitch.
            age = _url_age_years(url)
            if age is not None and age > RATING_MAX_AGE_YEARS:
                logger.debug(
                    f"    ⊘ Rating périmé ({age:.0f} ans > {RATING_MAX_AGE_YEARS}): "
                    f"{title[:70]!r}"
                )
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
            self.cache.set(isin, rating, 'Fitch', 'Brave Search', url=hit_url)
            return RatingInfo(
                value=rating,
                source=self.source_tag,
                source_full=self.source_name,
                source_url=hit_url,
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
