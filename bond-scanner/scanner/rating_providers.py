"""
Provider di rating multi-source per le obbligazioni.

Ogni provider tenta di recuperare il rating di un bond da una fonte specifica.
I risultati vengono poi combinati per dare un rating finale con tracciabilità
della fonte (es: "AA- (DB, BS)").

Fonti supportate:
1. Deutsche Börse API JSON — dai dati già intercettati
2. Börse Frankfurt HTML — scraping DOM della pagina dettaglio
3. Börse Stuttgart HTML — navigazione alla pagina Stammdaten

Strategia: Cascade — si prova la fonte più rapida per prima,
e si cercano le altre solo se non si trova rating.
"""

import logging
import re
from abc import ABC, abstractmethod
from typing import Dict, Any, List, Optional

from scanner.models import RatingInfo

logger = logging.getLogger(__name__)

# ================================================================
#  Validazione dei rating
# ================================================================

# Pattern validi per rating S&P/Fitch
SP_RATING_PATTERN = re.compile(
    r'^(AAA|AA\+|AA|AA-|A\+|A|A-|BBB\+|BBB|BBB-|BB\+|BB|BB-|B\+|B|B-|'
    r'CCC\+|CCC|CCC-|CC|C|D)$',
    re.IGNORECASE
)

# Pattern validi per rating Moody's
MOODY_RATING_PATTERN = re.compile(
    r'^(Aaa|Aa[123]?|A[123]?|Baa[123]?|Ba[123]?|B[123]?|'
    r'Caa[123]?|Ca|C)$',
    re.IGNORECASE
)

# Valori da ignorare
INVALID_RATINGS = {
    'nr', 'n/a', 'na', '-', 'not rated', 'unrated', 'none',
    'n.a.', 'n.r.', '--', '—', '', 'k.a.', 'keine angabe',
    'bitte melden sie sich an',  # Börse Stuttgart login-wall
}


def is_valid_rating(value: str) -> bool:
    """Verifica se una stringa è un rating valido (S&P, Fitch o Moody's)."""
    if not value or not isinstance(value, str):
        return False
    cleaned = value.strip()
    if cleaned.lower() in INVALID_RATINGS:
        return False
    if len(cleaned) < 1 or len(cleaned) > 10:
        return False
    return bool(SP_RATING_PATTERN.match(cleaned) or MOODY_RATING_PATTERN.match(cleaned))


# ================================================================
#  Classe base
# ================================================================

class RatingProvider(ABC):
    """Interfaccia per un fornitore di rating."""

    @abstractmethod
    async def get_rating(self, isin: str, page=None, api_responses: Dict[str, Any] = None) -> Optional[RatingInfo]:
        """
        Tenta di recuperare il rating per questo ISIN.

        Args:
            isin: Codice ISIN dell'obbligazione
            page: Pagina Playwright (per scraping HTML)
            api_responses: Risposte API già intercettate (per Deutsche Börse)

        Returns:
            RatingInfo se trovato, None altrimenti
        """
        pass

    @property
    @abstractmethod
    def source_tag(self) -> str:
        """Tag corto della fonte (es: 'DB', 'BF', 'BS')."""
        pass

    @property
    @abstractmethod
    def source_name(self) -> str:
        """Nome completo della fonte."""
        pass


# ================================================================
#  Source 1: Deutsche Börse API JSON
# ================================================================

class DeutscheBoerseApiProvider(RatingProvider):
    """
    Estrae il rating dalle risposte API JSON di Deutsche Börse.

    Questa è la fonte più veloce perché riutilizza i dati API
    già intercettati durante l'enrichment del bond (nessuna
    navigazione aggiuntiva necessaria).
    """

    RATING_KEYS = {
        'rating', 'sprating', 'moodyrating', 'fitchrating', 'creditrating',
        'ratingvalue', 'ratingmoodys', 'ratingfitch', 'ratingsp',
        'standardandpoorsrating', 'moodyslongtermrating', 'fitchlongtermrating',
        'splongtermrating', 'issuerrating', 'bondrating', 'currentrating',
        'ratingclass', 'ratinggrade',
    }

    @property
    def source_tag(self) -> str:
        return "DB"

    @property
    def source_name(self) -> str:
        return "Deutsche Börse"

    async def get_rating(self, isin: str, page=None, api_responses: Dict[str, Any] = None) -> Optional[RatingInfo]:
        if not api_responses:
            return None

        for url, data in api_responses.items():
            rating_value = self._search_rating_recursive(data, depth=0, max_depth=5)
            if rating_value:
                logger.info(f"    📊 Rating da {self.source_name}: {rating_value}")
                return RatingInfo(
                    value=rating_value,
                    source=self.source_tag,
                    source_full=self.source_name,
                )

        return None

    def _search_rating_recursive(self, data: Any, depth: int, max_depth: int) -> Optional[str]:
        """Cerca ricorsivamente un campo rating nei dati JSON."""
        if depth > max_depth or data is None:
            return None

        if isinstance(data, dict):
            for key, value in data.items():
                key_lower = key.lower()
                if key_lower in self.RATING_KEYS:
                    if isinstance(value, str) and is_valid_rating(value):
                        return value.strip()

                if isinstance(value, (dict, list)):
                    result = self._search_rating_recursive(value, depth + 1, max_depth)
                    if result:
                        return result

        elif isinstance(data, list):
            for item in data[:10]:
                result = self._search_rating_recursive(item, depth + 1, max_depth)
                if result:
                    return result

        return None


# ================================================================
#  Source 2: Börse Frankfurt / Deutsche Börse — DOM Scraping
# ================================================================

class BoerseFrankfurtHtmlProvider(RatingProvider):
    """
    Scraping del DOM della pagina dettaglio su Deutsche Börse / Börse Frankfurt.

    Cerca il rating nella sezione Master Data / Key Data della pagina HTML.
    Utilizza la stessa pagina già navigata durante l'enrichment
    (nessuna navigazione aggiuntiva).
    """

    @property
    def source_tag(self) -> str:
        return "BF"

    @property
    def source_name(self) -> str:
        return "Börse Frankfurt"

    async def get_rating(self, isin: str, page=None, api_responses: Dict[str, Any] = None) -> Optional[RatingInfo]:
        if page is None:
            return None

        try:
            # Cerca nel DOM della pagina già caricata (live.deutsche-boerse.com/bond/...)
            # I dati master sono spesso in tabelle <dl>, <table>, o coppie label/value

            # Strategia 1: Cercare testo che contiene "Rating" come label
            rating_selectors = [
                # Tabella master data con coppie dt/dd
                'dt:has-text("Rating") + dd',
                'dt:has-text("rating") + dd',
                # Tabella con th/td
                'th:has-text("Rating") ~ td',
                'th:has-text("rating") ~ td',
                # Span/div con label
                'label:has-text("Rating") + span',
                'label:has-text("Rating") + div',
                # Qualsiasi elemento con data-field="rating"
                '[data-field*="rating"]',
                '[data-field*="Rating"]',
                # Key-value generic
                '.key-value-pair:has-text("Rating") .value',
                '.detail-row:has-text("Rating") .detail-value',
            ]

            for selector in rating_selectors:
                try:
                    locator = page.locator(selector).first
                    if await locator.is_visible(timeout=500):
                        text = (await locator.text_content() or "").strip()
                        if is_valid_rating(text):
                            logger.info(f"    📊 Rating da {self.source_name} (HTML): {text}")
                            return RatingInfo(
                                value=text,
                                source=self.source_tag,
                                source_full=self.source_name,
                            )
                except Exception:
                    continue

            # Strategia 2: Cerca nel testo complet della pagina con regex
            try:
                page_text = await page.inner_text('body', timeout=1000)
                # Cerca pattern come "Rating  AA-" o "S&P Rating: BBB+"
                patterns = [
                    r'(?:S&P|Fitch|Moody)[\'s]*\s*(?:Rating|rating)[:\s]*([A-D][a-z0-9+\-]{0,4})',
                    r'(?:Rating|rating)[:\s]+([A-D][A-Za-z0-9+\-]{0,4})',
                    r'(?:Credit\s*Rating)[:\s]+([A-D][A-Za-z0-9+\-]{0,4})',
                ]
                for pattern in patterns:
                    match = re.search(pattern, page_text)
                    if match:
                        candidate = match.group(1).strip()
                        if is_valid_rating(candidate):
                            logger.info(f"    📊 Rating da {self.source_name} (testo): {candidate}")
                            return RatingInfo(
                                value=candidate,
                                source=self.source_tag,
                                source_full=self.source_name,
                            )
            except Exception:
                pass

        except Exception as e:
            logger.debug(f"    ⚠️ Errore scraping HTML {self.source_name}: {e}")

        return None


# ================================================================
#  Source 3: Börse Stuttgart — Pagina Stammdaten
# ================================================================

class BoerseStuttgartProvider(RatingProvider):
    """
    Scraping della pagina bond su Börse Stuttgart.

    Naviga a boerse-stuttgart.de e cerca il campo "S&P-RATING"
    nella sezione Stammdaten.

    ⚠️ Alcuni bond richiedono il login per vedere il rating.
    In quel caso, il campo mostra "Bitte melden Sie sich an" → ignorato.
    """

    BASE_URL = "https://www.boerse-stuttgart.de/de-de/produkte/anleihen/stuttgart"

    @property
    def source_tag(self) -> str:
        return "BS"

    @property
    def source_name(self) -> str:
        return "Börse Stuttgart"

    async def get_rating(self, isin: str, page=None, api_responses: Dict[str, Any] = None) -> Optional[RatingInfo]:
        if page is None:
            return None

        try:
            # Naviga alla pagina Börse Stuttgart
            url = f"{self.BASE_URL}/{isin.lower()}"
            logger.debug(f"    🔍 Ricerca rating su {self.source_name}: {url}")

            await page.goto(url, wait_until="domcontentloaded", timeout=10000)
            await page.wait_for_timeout(2000)

            # Cerca il campo S&P-RATING nella pagina
            rating_selectors = [
                # Stammdaten standard
                'dt:has-text("S&P") + dd',
                'dt:has-text("Rating") + dd',
                'dt:has-text("RATING") + dd',
                # Tabella Stammdaten
                'th:has-text("S&P") ~ td',
                'th:has-text("Rating") ~ td',
                # Label generiche
                'span:has-text("S&P-RATING")',
                '.stamp-data-value',
                # Cercare in tutti i data-rows
                'tr:has-text("Rating") td:last-child',
                'tr:has-text("S&P") td:last-child',
                'div:has-text("Rating") + div',
            ]

            for selector in rating_selectors:
                try:
                    locator = page.locator(selector).first
                    if await locator.is_visible(timeout=500):
                        text = (await locator.text_content() or "").strip()
                        if is_valid_rating(text):
                            logger.info(f"    📊 Rating da {self.source_name}: {text}")
                            return RatingInfo(
                                value=text,
                                source=self.source_tag,
                                source_full=self.source_name,
                            )
                except Exception:
                    continue

            # Strategia fallback: cerca nel testo della pagina
            try:
                page_text = await page.inner_text('body', timeout=1000)

                # Cerca pattern "S&P-RATING" seguito da un valore
                patterns = [
                    r'S&P[- ]*RATING[:\s]*([A-D][A-Za-z0-9+\-]{0,4})',
                    r'S&P[:\s]*([A-D][A-Za-z0-9+\-]{0,4})',
                    r"Moody['\s]*s?[:\s]*([A-C][a-z]{1,2}[123]?)",
                    r'Fitch[:\s]*([A-D][A-Za-z0-9+\-]{0,4})',
                    r'Rating[:\s]+([A-D][A-Za-z0-9+\-]{0,4})',
                ]
                for pattern in patterns:
                    match = re.search(pattern, page_text)
                    if match:
                        candidate = match.group(1).strip()
                        if is_valid_rating(candidate):
                            logger.info(f"    📊 Rating da {self.source_name} (testo): {candidate}")
                            return RatingInfo(
                                value=candidate,
                                source=self.source_tag,
                                source_full=self.source_name,
                            )
            except Exception:
                pass

            logger.debug(f"    ⚠️ Nessun rating trovato su {self.source_name}")

        except Exception as e:
            logger.debug(f"    ⚠️ Errore {self.source_name}: {e}")

        return None


# ================================================================
#  Fusione e comparazione dei rating
# ================================================================

# Scala S&P per la normalizzazione
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
    """Normalizza un rating a formato S&P."""
    if not rating:
        return None
    rating = rating.strip()

    # Già S&P?
    if rating.upper() in [r.upper() for r in RATING_SCALE]:
        return rating.upper()

    # Moody's?
    if rating in MOODY_TO_SP:
        return MOODY_TO_SP[rating]

    # Case-insensitive Moody's
    for moody, sp in MOODY_TO_SP.items():
        if rating.lower() == moody.lower():
            return sp

    return rating.upper()  # Fallback: uppercase


def merge_ratings(ratings: List[RatingInfo]) -> tuple:
    """
    Combina i rating da fonti multiple.

    Returns:
        (rating_finale, rating_display)
        - rating_finale: il rating più conservativo (peggiore) per il filtro
        - rating_display: stringa per l'Excel con le fonti

    Esempi:
        - Tutti concordano:  ("AA-", "AA- (DB, BS)")
        - Divergenza:        ("A-",  "AA- (DB) / A- (BS)")
        - Un solo:           ("AA-", "AA- (BS)")
        - Nessuno:           (None,  "?")
    """
    if not ratings:
        return None, "?"

    # Normalizza tutti i rating in S&P
    normalized = []
    for r in ratings:
        sp = normalize_to_sp(r.value)
        normalized.append((sp, r.source, r.value))

    # Raggruppa per valore normalizzato
    groups: Dict[str, List[str]] = {}
    for sp_val, source, original in normalized:
        if sp_val not in groups:
            groups[sp_val] = []
        groups[sp_val].append(source)

    if len(groups) == 1:
        # Tutti concordano
        sp_val = list(groups.keys())[0]
        sources = list(groups.values())[0]
        rating_display = f"{sp_val} ({', '.join(sources)})"
        return sp_val, rating_display
    else:
        # Divergenza: mostra tutti separatamente
        parts = []
        worst_idx = -1
        worst_val = None

        for sp_val, sources in groups.items():
            parts.append(f"{sp_val} ({', '.join(sources)})")
            try:
                idx = RATING_SCALE.index(sp_val)
            except ValueError:
                idx = 999
            if idx > worst_idx:
                worst_idx = idx
                worst_val = sp_val

        rating_display = " / ".join(parts)
        return worst_val, rating_display


# ================================================================
#  Lista dei provider disponibili
# ================================================================

ALL_PROVIDERS: List[RatingProvider] = [
    DeutscheBoerseApiProvider(),
    BoerseFrankfurtHtmlProvider(),
    BoerseStuttgartProvider(),
]
