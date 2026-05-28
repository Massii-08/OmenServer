# Bond Scanner — Migrate to Brave/Fitch-only Rating Strategy

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Bond Scanner's 5-provider rating cascade with a single Brave Search API call against `site:fitchratings.com`, mirroring exactly the Yield Bot strategy validated on 2026-05-28 PM. If Fitch doesn't rate an issuer, the Excel rating cell stays empty (no `'?'` placeholder, no fallback agency).

**Architecture:** Strip `DeutscheBoerseApiProvider`, `BoerseFrankfurtHtmlProvider`, `IssuerReferenceProvider`, `BoerseStuttgartProvider`, and `FitchRatingsProvider` from `scanner/rating_providers.py`. Replace `ALL_PROVIDERS` with a single async `BraveFitchProvider` that ports `_try_brave_search()` from `Projet serveur/yield-bot/scraper/rating_fetcher.py:370`. Add a JSON file cache (30-day TTL by ISIN — same pattern as Yield Bot's `_Cache`). Simplify `market_scraper.fetch_ratings()` to a single async call. Patch the Excel writer to leave the cell empty instead of writing `'?'`. Apply every code change to BOTH copies (`bot obbligation/` standalone + `Projet serveur/bond-scanner/` in-server) and verify they stay byte-identical with `diff -q`.

**Tech Stack:** Python 3.9, `httpx>=0.24` (new dep), Playwright async (existing). Brave Search API key shared with Yield Bot via `BRAVE_SEARCH_API_KEY` env var. No external test framework — light TDD via `pytest`-style assertions in a `tests/test_rating_brave.py` runnable through `python -m unittest`.

---

## File Structure

| Path | Action | Responsibility |
|---|---|---|
| `bot obbligation/scanner/rating_providers.py` | Rewrite | Single `BraveFitchProvider` class + cache + helpers. Strip 5 old providers + `ALL_PROVIDERS` + `merge_ratings()` (single source = no merge needed). Keep `normalize_to_sp()`, `RATING_SCALE`, `MOODY_TO_SP` for `filter/criteria.py` consumers. |
| `Projet serveur/bond-scanner/scanner/rating_providers.py` | Rewrite (identical) | Same file, second location. |
| `bot obbligation/scanner/market_scraper.py:339-464` | Modify | Simplify `fetch_ratings()` to a single `await provider.get_rating(bond)`. Remove imports of stripped providers. |
| `Projet serveur/bond-scanner/scanner/market_scraper.py:339-464` | Modify (identical) | Same. |
| `bot obbligation/excel/report_generator.py:263` | Modify | `ws[f'G{row}'] = bond.rating_display or ''` (no `'?'` fallback). |
| `Projet serveur/bond-scanner/excel/report_generator.py:263` | Modify (identical) | Same. |
| `bot obbligation/requirements.txt` | Modify | Add `httpx>=0.24`. |
| `Projet serveur/bond-scanner/requirements.txt` | Modify (identical) | Same. |
| `bot obbligation/tests/test_rating_brave.py` | Create | Unit tests for `FITCH_TITLE_RATING_RE`, scoring, REJECT keywords, cache TTL. Live API call gated behind env var. |
| `Projet serveur/bond-scanner/tests/test_rating_brave.py` | Create (identical) | Same. |
| `bot obbligation/CLAUDE.md` | Modify | Section "Rating" — describe new Brave/Fitch-only strategy. |
| `Projet serveur/bond-scanner/CLAUDE.md` | Modify (identical) | Same. |
| `Projet serveur/CLAUDE.md` | Modify | Section "Historique récent" — log this migration. |

**Why no merge layer?** The Yield Bot returns `(rating, agency)`. The Bond Scanner uses `RatingInfo(value, source, source_full)` because it previously fused multiple sources. After this plan there is only one source → `bond.ratings` becomes a one-element list, `bond.rating == bond.ratings[0].value`, `bond.rating_display == "BBB+ (Fitch)"`. We keep the existing `RatingInfo` shape (downstream code unchanged) but the `merge_ratings()` function is no longer called.

**Filter consequence:** `filter/criteria.py:132` already short-circuits when `bond.rating is None` — unrated bonds pass the filter today. After migration that becomes the common case for issuers Fitch doesn't cover. Out of scope for this plan; flagged at the end for a future `--require-rating` CLI flag.

---

## Task 1 — Snapshot baseline

Capture the current rating output for one known issuer before touching anything, so we can compare after the migration.

**Files:**
- Test: `bot obbligation/baseline_before.txt` (gitignored — local artefact)

- [ ] **Step 1: Confirm both Bond Scanner copies are byte-identical**

Run:
```bash
diff -q "/Users/massimiliano/omenserver Project/bot obbligation/scanner/rating_providers.py" \
        "/Users/massimiliano/omenserver Project/Projet serveur/bond-scanner/scanner/rating_providers.py"
diff -q "/Users/massimiliano/omenserver Project/bot obbligation/scanner/market_scraper.py" \
        "/Users/massimiliano/omenserver Project/Projet serveur/bond-scanner/scanner/market_scraper.py"
diff -q "/Users/massimiliano/omenserver Project/bot obbligation/excel/report_generator.py" \
        "/Users/massimiliano/omenserver Project/Projet serveur/bond-scanner/excel/report_generator.py"
diff -q "/Users/massimiliano/omenserver Project/bot obbligation/requirements.txt" \
        "/Users/massimiliano/omenserver Project/Projet serveur/bond-scanner/requirements.txt"
```
Expected: 4 empty outputs (no diff). If any file diverges, STOP and resolve before continuing — the plan assumes parallel state.

- [ ] **Step 2: Run the existing Yield Bot fetcher as smoke baseline**

The Yield Bot rating fetcher is the reference. Confirm it still works against Brave to validate the API key and the regex.

Run:
```bash
cd "/Users/massimiliano/omenserver Project/Projet serveur/yield-bot"
export BRAVE_SEARCH_API_KEY="$(security find-generic-password -a "$USER" -s 'BRAVE_SEARCH_API_KEY' -w)"
python -m scraper.rating_fetcher US25746UCY38 "Dominion Energy Inc"
```
Expected output:
```
Result: BBB+ (Fitch)
```
If `Result: NOT FOUND` → check the Keychain entry and Brave portal status. Do not proceed until this works.

- [ ] **Step 3: Note the baseline behavior for one bond on Bond Scanner**

The actual production-grade test (full scan) is gated by the rate limiter at 2/day → don't burn one. Instead, document the current `rating_display` format expected from a known issuer (Dominion would currently produce something like `"BBB+ (REF)"` because `Dominion Energy` is in the issuer reference table for many corporates — or `"?"` if not). Capture this in a one-line note `bot obbligation/baseline_before.txt` so reviewers know what changed.

```bash
echo "Pre-migration baseline (2026-05-28): rating cascade DB/BF/REF/BS/FR → merge_ratings → 'AA- (DB, REF)' style display. Tested issuer baseline N/A (scan rate-limited)." > "/Users/massimiliano/omenserver Project/bot obbligation/baseline_before.txt"
```

- [ ] **Step 4: Commit the baseline note (or skip if you prefer to leave it untracked)**

```bash
cd "/Users/massimiliano/omenserver Project/bot obbligation"
echo "baseline_before.txt" >> .gitignore  # keep it local
```
No commit needed for this task — it's pre-migration context only.

---

## Task 2 — Write the regex + scoring tests (TDD)

Create the test file FIRST so the new provider implementation has a known target.

**Files:**
- Create: `bot obbligation/tests/__init__.py`
- Create: `bot obbligation/tests/test_rating_brave.py`
- Create: `Projet serveur/bond-scanner/tests/__init__.py`
- Create: `Projet serveur/bond-scanner/tests/test_rating_brave.py`

- [ ] **Step 1: Write the failing test file** (both locations — content is identical)

Create file content (write to BOTH paths):

```python
"""
Unit tests for the Brave/Fitch rating provider.

Pure-Python: parser regex, scoring, REJECT keywords, cache TTL.
No network calls — the live Brave API is exercised manually via
`python -m scanner.rating_providers <ISIN> <issuer>` after wiring.
"""
import asyncio
import json
import tempfile
import unittest
from datetime import date, timedelta
from pathlib import Path

from scanner.rating_providers import (
    FITCH_TITLE_RATING_RE,
    BraveFitchProvider,
    _Cache,
    is_valid_rating,
    normalize_to_sp,
)


class TestFitchTitleRegex(unittest.TestCase):
    """Regex tested against the 5 confirmed Fitch title formats."""

    def test_idr_with_simple_quotes(self):
        m = FITCH_TITLE_RATING_RE.search("Fitch Affirms IBM's IDR at 'A-'; Outlook Stable")
        self.assertIsNotNone(m)
        self.assertEqual(m.group('rating'), 'A-')

    def test_upgrade_double_quotes(self):
        m = FITCH_TITLE_RATING_RE.search('Fitch Upgrades Broadcom to "BBB+"; Outlook Positive')
        self.assertIsNotNone(m)
        self.assertEqual(m.group('rating'), 'BBB+')

    def test_senior_notes(self):
        m = FITCH_TITLE_RATING_RE.search("Fitch Rates Dominion Energy's Senior Notes 'BBB+'")
        self.assertIsNotNone(m)
        self.assertEqual(m.group('rating'), 'BBB+')

    def test_curly_quotes(self):
        # Fitch parfois sert des guillemets typographiques
        m = FITCH_TITLE_RATING_RE.search("Fitch Upgrades AstraZeneca to ‘A’; Outlook Positive")
        self.assertIsNotNone(m)
        self.assertEqual(m.group('rating'), 'A')

    def test_longest_match_wins(self):
        # Garde-fou : "AA-" doit matcher AVANT "A" sur "Affirms 'AA-'"
        m = FITCH_TITLE_RATING_RE.search("Fitch Affirms SomeIssuer at 'AA-'")
        self.assertIsNotNone(m)
        self.assertEqual(m.group('rating'), 'AA-')


class TestScoring(unittest.TestCase):
    """Provider scoring: HIGH_PREF > issue-specific > 0."""

    def setUp(self):
        self.p = BraveFitchProvider(api_key='dummy')

    def test_idr_keyword_scores_higher_than_senior_notes(self):
        idr_title = "Fitch Affirms IBM's IDR at 'A-'; Outlook Stable"
        sn_title = "Fitch Rates IBM's Senior Notes 'A-'"
        self.assertGreater(
            self.p._score_title(idr_title),
            self.p._score_title(sn_title),
        )

    def test_upgrade_keyword_scores_high(self):
        self.assertGreaterEqual(
            self.p._score_title("Fitch Upgrades Broadcom to 'BBB+'"),
            2,
        )

    def test_reject_keyword_returns_negative(self):
        # Special sentinel: REJECT keywords get -999 so the hit is dropped
        title = "Fitch Affirms Hilton Grand Vacations Trust 2026-1 at 'BB-'"
        self.assertLess(self.p._score_title(title), 0)


class TestIssuerStrip(unittest.TestCase):
    """Test the prudent strip: legal-pure suffixes only."""

    def setUp(self):
        self.p = BraveFitchProvider(api_key='dummy')

    def test_strip_inc(self):
        self.assertEqual(self.p._strip_issuer('Dominion Energy Inc'), 'Dominion Energy')

    def test_strip_corp(self):
        self.assertEqual(self.p._strip_issuer('Broadcom Corp'), 'Broadcom')

    def test_dont_strip_worldwide(self):
        # Critical: "Hilton Worldwide" ≠ "Hilton Grand Vacations"
        self.assertEqual(self.p._strip_issuer('Hilton Worldwide'), 'Hilton Worldwide')

    def test_dont_strip_finance(self):
        self.assertEqual(
            self.p._strip_issuer('AstraZeneca Finance LLC'),
            'AstraZeneca Finance',
        )

    def test_only_one_strip(self):
        # We strip the FIRST matching suffix only — no recursive strip
        self.assertEqual(self.p._strip_issuer('Foo Inc.'), 'Foo')


class TestCacheTTL(unittest.TestCase):
    """30-day TTL by ISIN."""

    def setUp(self):
        self.tmp = tempfile.NamedTemporaryFile(
            mode='w', suffix='.json', delete=False,
        )
        self.tmp.close()
        self.path = Path(self.tmp.name)
        self.path.unlink()  # we want a fresh start

    def tearDown(self):
        if self.path.exists():
            self.path.unlink()

    def test_set_then_get(self):
        cache = _Cache(self.path)
        cache.set('US25746UCY38', 'BBB+', 'Fitch', 'Brave Search')
        entry = cache.get('US25746UCY38')
        self.assertIsNotNone(entry)
        self.assertEqual(entry['rating'], 'BBB+')

    def test_ttl_expiry(self):
        cache = _Cache(self.path)
        cache.set('XX', 'A', 'Fitch', 'src')
        # Manually backdate the entry past TTL
        cache._data['XX']['date'] = (date.today() - timedelta(days=31)).isoformat()
        cache._save()
        cache2 = _Cache(self.path)  # reload
        self.assertIsNone(cache2.get('XX'))

    def test_miss_returns_none(self):
        cache = _Cache(self.path)
        self.assertIsNone(cache.get('NONEXISTENT'))


class TestValidators(unittest.TestCase):
    """Carried over from old rating_providers — confirm still exported."""

    def test_is_valid_rating(self):
        self.assertTrue(is_valid_rating('BBB+'))
        self.assertFalse(is_valid_rating('not rated'))

    def test_normalize_moodys(self):
        self.assertEqual(normalize_to_sp('Baa1'), 'BBB+')


if __name__ == '__main__':
    unittest.main()
```

Write to both paths verbatim. Also create empty `tests/__init__.py` at each location.

- [ ] **Step 2: Verify the tests fail with ImportError**

```bash
cd "/Users/massimiliano/omenserver Project/bot obbligation"
python -m unittest tests.test_rating_brave -v 2>&1 | head -20
```
Expected: `ImportError: cannot import name 'BraveFitchProvider' from 'scanner.rating_providers'` (or similar). This proves the test file is wired up and the symbols don't exist yet.

- [ ] **Step 3: Commit the failing tests**

```bash
cd "/Users/massimiliano/omenserver Project/bot obbligation"
git add tests/__init__.py tests/test_rating_brave.py 2>/dev/null || echo "not a git repo — skip"
```

The standalone `bot obbligation/` is not a git repo per Task 1 Step 1 verification. The in-server copy is tracked by the `Projet serveur/` repo:

```bash
cd "/Users/massimiliano/omenserver Project/Projet serveur"
git add bond-scanner/tests/__init__.py bond-scanner/tests/test_rating_brave.py
git commit -m "test(bond-scanner): failing tests for BraveFitchProvider port"
```

Do NOT push yet — keep all changes local until Task 8 verification passes.

---

## Task 3 — Rewrite `rating_providers.py` (port Brave fetcher + cache)

Replace the entire content of `scanner/rating_providers.py` in both locations with the new single-provider implementation.

**Files:**
- Modify: `bot obbligation/scanner/rating_providers.py` (full rewrite)
- Modify: `Projet serveur/bond-scanner/scanner/rating_providers.py` (full rewrite, identical)

- [ ] **Step 1: Write the new module content** (both files, identical content)

The implementation below ports `_try_brave_search()` from `Projet serveur/yield-bot/scraper/rating_fetcher.py:370` but adapts to:
- Async (`httpx.AsyncClient`) instead of sync `httpx.get` — the Bond Scanner runs inside Playwright's event loop
- Returns `RatingInfo` instead of `(rating, agency)` — matches existing downstream contract
- Keeps `is_valid_rating`, `normalize_to_sp`, `RATING_SCALE`, `MOODY_TO_SP` (consumed by `filter/criteria.py`)

```python
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
        Scoring:
          +2 : HIGH_PREF keyword (upgrades/downgrades/affirms/idr/credit ratings)
           0 : ISSUE_SPECIFIC keyword (senior notes / junior / sub notes / ...)
        -999 : REJECT keyword (trust / abs / rmbs / cmbs / ...) — special sentinel

        REJECT è marcato con uno score profondamente negativo per essere
        facilmente filtrabile dal chiamante senza una flag separata.
        """
        title_lower = title.lower()
        if any(kw in title_lower for kw in _REJECT):
            return -999
        score = 0
        if any(kw in title_lower for kw in _HIGH_PREF):
            score += 2
        # ISSUE_SPECIFIC tag est neutre (0). Garde la branche pour clarté.
        if any(kw in title_lower for kw in _ISSUE_SPECIFIC):
            score += 0
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

        if r.status_code == 429:
            logger.warning(
                "    ⚠️  Brave rate-limited (429). Free tier = 1 req/sec."
            )
            return None
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
```

Write this entire content to BOTH:
- `/Users/massimiliano/omenserver Project/bot obbligation/scanner/rating_providers.py`
- `/Users/massimiliano/omenserver Project/Projet serveur/bond-scanner/scanner/rating_providers.py`

- [ ] **Step 2: Verify files are byte-identical**

```bash
diff -q "/Users/massimiliano/omenserver Project/bot obbligation/scanner/rating_providers.py" \
        "/Users/massimiliano/omenserver Project/Projet serveur/bond-scanner/scanner/rating_providers.py"
```
Expected: empty output (no diff).

- [ ] **Step 3: Run the unit tests — should pass**

```bash
cd "/Users/massimiliano/omenserver Project/bot obbligation"
python -m unittest tests.test_rating_brave -v
```
Expected: `OK` with ~15 tests passed.

Same on the in-server copy:
```bash
cd "/Users/massimiliano/omenserver Project/Projet serveur/bond-scanner"
python -m unittest tests.test_rating_brave -v
```
Expected: `OK`.

- [ ] **Step 4: Commit**

```bash
cd "/Users/massimiliano/omenserver Project/Projet serveur"
git add bond-scanner/scanner/rating_providers.py bond-scanner/tests/__init__.py bond-scanner/tests/test_rating_brave.py
git commit -m "feat(bond-scanner): port BraveFitchProvider from yield-bot

- Replace 5-source rating cascade with single Brave Search call against
  site:fitchratings.com (mirror Yield Bot strategy validated 2026-05-28).
- Keep RatingInfo shape for downstream compat.
- Add 30-day JSON cache (~/.cache/bond-scanner-ratings.json) including
  negative-result caching to avoid re-querying Fitch-uncovered issuers.
- Tests cover regex, scoring, REJECT keywords, strip safety, cache TTL.

Ref: docs/superpowers/plans/2026-05-28-bond-scanner-brave-fitch-rating.md"
```

---

## Task 4 — Simplify `market_scraper.fetch_ratings()`

Now wire the new provider into the orchestration. Replace the 5-source cascade with a single async call.

**Files:**
- Modify: `bot obbligation/scanner/market_scraper.py:339-464`
- Modify: `Projet serveur/bond-scanner/scanner/market_scraper.py:339-464`

- [ ] **Step 1: Update the imports block at the top of `market_scraper.py`**

In BOTH files, find the existing import block (around line 25-35):

```python
from scanner.models import ScannedBond, RatingInfo
from scanner.rating_providers import (
    ALL_PROVIDERS,
    DeutscheBoerseApiProvider,
    BoerseFrankfurtHtmlProvider,
    BoerseStuttgartProvider,
    FitchRatingsProvider,
    IssuerReferenceProvider,
    is_valid_rating,
    merge_ratings,
)
```

Replace with:

```python
from scanner.models import ScannedBond, RatingInfo
from scanner.rating_providers import BraveFitchProvider
```

- [ ] **Step 2: Replace `fetch_ratings()` body entirely** (both files)

Find the existing method (`async def fetch_ratings(self, bond: ScannedBond)` starting around line 339) and replace EVERYTHING from the `def` line through the closing `return bond` (around line 464) with:

```python
    async def fetch_ratings(self, bond: ScannedBond) -> ScannedBond:
        """
        Recupera il rating Fitch tramite Brave Search API.

        Strategia (2026-05-28, mirror Yield Bot) :
        - Source UNIQUE = site:fitchratings.com via Brave
        - Politica fitch_only : nessun fallback S&P/Moody's
        - Cellula Excel resta vuota se Fitch non rate l'emittente

        Args:
            bond: ScannedBond con isin e name popolati

        Returns:
            ScannedBond con bond.ratings, bond.rating, bond.rating_display
            aggiornati. Se nessun rating Fitch → bond.rating_display = None.
        """
        provider = BraveFitchProvider()
        try:
            rating_info = await provider.get_rating(
                bond.isin, bond_name=bond.name,
            )
        except Exception as e:
            logger.debug(f"    ⚠️  Errore BraveFitchProvider: {e}")
            rating_info = None

        if rating_info:
            bond.ratings = [rating_info]
            bond.rating = rating_info.value
            bond.rating_display = f"{rating_info.value} (Fitch)"
            logger.info(f"    📊 Rating finale: {bond.rating_display}")
        else:
            bond.ratings = []
            bond.rating = None
            bond.rating_display = None
            logger.info(
                f"    ⚠️  Nessun rating Fitch per {bond.isin} ({bond.name[:40]})"
            )

        return bond
```

- [ ] **Step 3: Confirm both files are still byte-identical**

```bash
diff -q "/Users/massimiliano/omenserver Project/bot obbligation/scanner/market_scraper.py" \
        "/Users/massimiliano/omenserver Project/Projet serveur/bond-scanner/scanner/market_scraper.py"
```
Expected: empty output.

- [ ] **Step 4: Syntax check (Python won't run because Playwright deps may differ on Mac vs Omen, but parse must succeed)**

```bash
python -c "import ast; ast.parse(open('/Users/massimiliano/omenserver Project/bot obbligation/scanner/market_scraper.py').read()); print('OK')"
```
Expected: `OK`.

- [ ] **Step 5: Commit**

```bash
cd "/Users/massimiliano/omenserver Project/Projet serveur"
git add bond-scanner/scanner/market_scraper.py
git commit -m "refactor(bond-scanner): simplify fetch_ratings to single BraveFitch source

- Strip 5-provider cascade (DB API / BF HTML / REF / BS / Fitch Playwright)
- Use BraveFitchProvider exclusively
- Set rating_display=None when Fitch doesn't rate (no '?' placeholder)
- bond.ratings is now always a 0- or 1-element list

Mirrors Yield Bot fitch_only policy decided 2026-05-28 PM."
```

---

## Task 5 — Empty Excel cell when no rating

`report_generator.py:263` currently writes `'?'` as fallback. New policy: leave the cell empty so the Excel stays "intact" (cf. user directive "on laisse la cellule telle quelle").

**Files:**
- Modify: `bot obbligation/excel/report_generator.py:263`
- Modify: `Projet serveur/bond-scanner/excel/report_generator.py:263`

- [ ] **Step 1: Locate the exact line** (both files)

```bash
grep -n "rating_display or bond.rating or" "/Users/massimiliano/omenserver Project/bot obbligation/excel/report_generator.py"
```
Expected: one match (~line 263).

- [ ] **Step 2: Apply the change** (both files)

Find:
```python
        ws[f'G{row}'] = bond.rating_display or bond.rating or '?'
```
Replace with:
```python
        # No fallback placeholder: if Fitch doesn't rate this issuer, leave
        # the cell empty (policy "on laisse la cellule telle quelle", 2026-05-28).
        ws[f'G{row}'] = bond.rating_display or bond.rating or ''
```

- [ ] **Step 3: Verify both files identical**

```bash
diff -q "/Users/massimiliano/omenserver Project/bot obbligation/excel/report_generator.py" \
        "/Users/massimiliano/omenserver Project/Projet serveur/bond-scanner/excel/report_generator.py"
```
Expected: empty output.

- [ ] **Step 4: Commit**

```bash
cd "/Users/massimiliano/omenserver Project/Projet serveur"
git add bond-scanner/excel/report_generator.py
git commit -m "feat(bond-scanner): leave rating cell empty when Fitch uncovered

Was: writes '?' if no rating found.
Now: blank cell. Mirrors Yield Bot 'don't pollute the Excel' policy."
```

---

## Task 6 — Add `httpx` to requirements

**Files:**
- Modify: `bot obbligation/requirements.txt`
- Modify: `Projet serveur/bond-scanner/requirements.txt`

- [ ] **Step 1: Append `httpx>=0.24` to both files**

```bash
echo "httpx>=0.24" >> "/Users/massimiliano/omenserver Project/bot obbligation/requirements.txt"
echo "httpx>=0.24" >> "/Users/massimiliano/omenserver Project/Projet serveur/bond-scanner/requirements.txt"
```

- [ ] **Step 2: Verify identical**

```bash
diff -q "/Users/massimiliano/omenserver Project/bot obbligation/requirements.txt" \
        "/Users/massimiliano/omenserver Project/Projet serveur/bond-scanner/requirements.txt"
```
Expected: empty.

- [ ] **Step 3: Install `httpx` in the Bond Scanner venv on Mac (if it has its own)**

The Bond Scanner is run via subprocess from OmenServer. The active venv is `Projet serveur/venv/`. Check whether `httpx` is already there (the OmenServer hub uses it for other purposes):

```bash
"/Users/massimiliano/omenserver Project/Projet serveur/venv/bin/pip" show httpx 2>/dev/null | head -2
```

If `httpx` is already installed (very likely — the hub uses it elsewhere), no install needed for the Mac dev environment.

If it's missing:
```bash
"/Users/massimiliano/omenserver Project/Projet serveur/venv/bin/pip" install "httpx>=0.24"
```

- [ ] **Step 4: Commit**

```bash
cd "/Users/massimiliano/omenserver Project/Projet serveur"
git add bond-scanner/requirements.txt
git commit -m "build(bond-scanner): add httpx for Brave Search API client"
```

---

## Task 7 — CLI smoke test on Mac

Validate the provider end-to-end before touching prod.

**Files:**
- No code change — pure verification.

- [ ] **Step 1: Verify the Brave API key is in Keychain**

```bash
security find-generic-password -a "$USER" -s "BRAVE_SEARCH_API_KEY" -w | wc -c
```
Expected: a number around 32-40 (the key length). If `command failed` → the key wasn't stored by the Yield Bot session; ask user to re-add via:
```bash
security add-generic-password -a "$USER" -s "BRAVE_SEARCH_API_KEY" -w '<KEY>'
```

- [ ] **Step 2: Run the CLI smoke test on a known-rated issuer**

```bash
cd "/Users/massimiliano/omenserver Project/Projet serveur/bond-scanner"
export BRAVE_SEARCH_API_KEY="$(security find-generic-password -a "$USER" -s 'BRAVE_SEARCH_API_KEY' -w)"
python -m scanner.rating_providers US25746UCY38 "Dominion Energy Inc"
```
Expected (within ~3-5 seconds):
```
HH:MM:SS | 📊 Rating da Fitch (Brave): BBB+ — https://www.fitchratings.com/...

Result: BBB+ (Fitch Ratings via Brave)
```

- [ ] **Step 3: Test a Fitch-uncovered issuer**

```bash
python -m scanner.rating_providers US863667BF72 "Stryker Corporation"
```
Expected:
```
HH:MM:SS |     Brave: 0 hit per 'site:fitchratings.com Stryker'

Result: NOT FOUND (Fitch ne rate pas cet émetteur)
```

- [ ] **Step 4: Test cache hit**

Re-run the Dominion command from Step 2. Expected output should now include the cache hit log line within ~50ms:
```
HH:MM:SS |     📦 Cache hit US25746UCY38 → BBB+ (Fitch)
Result: BBB+ (Fitch Ratings via Brave)
```

- [ ] **Step 5: Verify cache file exists**

```bash
cat "$HOME/.cache/bond-scanner-ratings.json" | python -m json.tool
```
Expected: a JSON object with `US25746UCY38` and `US863667BF72` keys (the second with empty rating string — negative cache).

- [ ] **Step 6: Sync the standalone copy and run the same smoke**

```bash
cd "/Users/massimiliano/omenserver Project/bot obbligation"
python -m scanner.rating_providers US25746UCY38 "Dominion Energy Inc"
```
Expected: cache hit (same `.json` file shared between both copies since both use `~/.cache/`).

No commit for this task — verification only.

---

## Task 8 — Update documentation (CLAUDE.md × 3)

**Files:**
- Modify: `bot obbligation/CLAUDE.md`
- Modify: `Projet serveur/bond-scanner/CLAUDE.md`
- Modify: `Projet serveur/CLAUDE.md` (Historique récent + pièges section)

- [ ] **Step 1: Patch both Bond Scanner CLAUDE.md files**

Find the section `### Rating` (around line 88-95) in both files and replace its content with:

```markdown
### Rating
- Le rating est récupéré **uniquement** via Brave Search API en mode `site:fitchratings.com {issuer}` (mirror Yield Bot, 2026-05-28)
- Parsing du rating depuis le **titre** des pages Fitch indexées (regex `FITCH_TITLE_RATING_RE`)
- Politique **fitch_only strict** : pas de fallback S&P / Moody's converti
- Si Fitch ne rate pas l'émetteur → `bond.rating_display = None` → cellule Excel vide (pas de `'?'` placeholder)
- Cache `~/.cache/bond-scanner-ratings.json` (TTL 30 jours par ISIN, négatifs inclus)
- Clé API : `BRAVE_SEARCH_API_KEY` (partagée avec Yield Bot — 1000 req/mois free largement suffisant pour les 2 bots cumulés)
- Le `merge_ratings()` legacy n'est plus appelé (1 seule source = pas de fusion)
- Échelle S&P / conversions Moody's (`MOODY_TO_SP`, `RATING_SCALE`) conservées car consommées par `filter/criteria.py`
```

Apply the SAME patch to BOTH files. Verify identical:

```bash
diff -q "/Users/massimiliano/omenserver Project/bot obbligation/CLAUDE.md" \
        "/Users/massimiliano/omenserver Project/Projet serveur/bond-scanner/CLAUDE.md"
```

- [ ] **Step 2: Add a new pitfall #29 to `Projet serveur/CLAUDE.md`**

Find the `## ⚠️ Pièges connus` section. After pitfall #28 (backtick PowerShell), append:

```markdown
29. **Rating Bond Scanner / Yield Bot — Brave Search API single source** : les deux bots partagent la même clé `BRAVE_SEARCH_API_KEY` (free tier 1000 req/mois). Stratégie `site:fitchratings.com {issuer}` parsée sur les titres indexés. Pièges spécifiques : (a) strip prudent des suffixes (Inc/Corp/LLC/PLC/SA/AG/NV/GmbH/SpA uniquement — JAMAIS Worldwide/Finance/Holdings/Capital sinon faux positif type Hilton Worldwide → Hilton Grand Vacations Trust BB-) ; (b) REJECT keywords `trust/abs/rmbs/cmbs/grand vacations/presale/covered bond/mortgage/clo/spv` (skip les hits sur structures de securitisation) ; (c) cache négatif obligatoire 30j (sinon on re-burn la quota pour les issuers que Fitch ne couvre pas — typiquement 30-40% des corporates US) ; (d) Brave portal a migré `api.search.brave.com` → `api-dashboard.search.brave.com` mais l'endpoint search reste `api.search.brave.com/res/v1/web/search`.
```

- [ ] **Step 3: Add an entry to `Projet serveur/CLAUDE.md` Historique récent table**

Find the table at the bottom of the section `## 📝 Historique récent`. Add at the top:

```markdown
| 2026-05-28 | 🔍 Bond Scanner — port stratégie rating Brave/Fitch-only (mirror Yield Bot). Strip cascade 5-providers → single `BraveFitchProvider`. Cache 30j + negative caching. Cellule Excel vide si Fitch uncovered. |
```

- [ ] **Step 4: Commit the docs**

```bash
cd "/Users/massimiliano/omenserver Project/Projet serveur"
git add bond-scanner/CLAUDE.md CLAUDE.md
git commit -m "docs: bond-scanner rating strategy migration + pitfall #29

- Update bond-scanner CLAUDE.md (both copies) with Brave/Fitch policy
- Add pitfall #29 to project CLAUDE.md (strip rules, REJECT keywords,
  negative caching, Brave portal URL migration)
- Add migration entry to Historique récent"
```

---

## Task 9 — End-to-end test with a real (small) scan

The rate limiter caps scans at 2/day. Use one budget slot now to validate the full pipeline.

**Files:**
- No code change.

- [ ] **Step 1: Check the rate limit budget**

```bash
cd "/Users/massimiliano/omenserver Project/Projet serveur/bond-scanner"
python main.py --usage
```
Expected: `Rimangono N/2 scansioni oggi`. If `0/2` → wait until midnight or bump the limit temporarily for this test only (NOT in committed code).

- [ ] **Step 2: Run a small scan with very tight filters**

A narrow filter window keeps the run short (~5-10 min) and produces fewer Brave calls.

```bash
export BRAVE_SEARCH_API_KEY="$(security find-generic-password -a "$USER" -s 'BRAVE_SEARCH_API_KEY' -w)"
python main.py --scan \
  --max-price 95 --min-yield 0.04 --max-maturity 5 --min-rating A- \
  --currencies EUR \
  --output /tmp/bond-scanner-brave-test.xlsx
```
Expected:
- Logs show `📊 Rating da Fitch (Brave): <X>` for issuers Fitch covers, `⚠️ Nessun rating Fitch per <ISIN>` for the rest.
- No `📊 Rating da Deutsche Börse` / `Börse Frankfurt` / `Tabella Emittenti` / `Börse Stuttgart` lines (those providers are gone).
- Output Excel `/tmp/bond-scanner-brave-test.xlsx` opens cleanly.
- Column G (Rating) shows `"BBB+ (Fitch)"` style strings, OR empty cells where Fitch doesn't cover. No `?` placeholders.

- [ ] **Step 3: Spot-check the Excel**

```bash
"/Users/massimiliano/omenserver Project/Projet serveur/venv/bin/python" -c "
from openpyxl import load_workbook
wb = load_workbook('/tmp/bond-scanner-brave-test.xlsx')
for sheet in wb.sheetnames:
    ws = wb[sheet]
    print(f'Sheet: {sheet}, rows: {ws.max_row}')
    for row in ws.iter_rows(min_row=2, max_row=min(6, ws.max_row), values_only=True):
        print(f'  ISIN={row[0]!r:25s} rating={row[6]!r}')
"
```
Expected: each sheet shows 5 sample rows. Ratings either `'BBB+ (Fitch)'` style or `None`/`''`. No `'?'`.

- [ ] **Step 4: Verify cache populated**

```bash
python -c "
import json
data = json.load(open('$HOME/.cache/bond-scanner-ratings.json'))
positive = sum(1 for v in data.values() if v.get('rating'))
negative = sum(1 for v in data.values() if not v.get('rating'))
print(f'Cache entries: {len(data)} total ({positive} positive, {negative} negative)')
"
```
Expected: a healthy split — e.g. `Cache entries: 47 total (28 positive, 19 negative)` for a EUR-only narrow scan.

No commit — this task validates the implementation.

---

## Task 10 — Production rollout on Omen

The Bond Scanner runs as a subprocess from OmenServer (`omenserver.service`). Env var `BRAVE_SEARCH_API_KEY` needs to be readable by the service. Mirror the Yield Bot rollout pattern (cf. daily note 2026-05-28 entry 11:00 "À faire ensuite").

**Files:**
- Server-side: `/etc/systemd/system/omenserver.service.d/env.conf` (or existing `EnvironmentFile`)

- [ ] **Step 1: Push the local commits**

The Bond Scanner code now lives only in the in-server copy that's committed in `Projet serveur/`. Push:

```bash
cd "/Users/massimiliano/omenserver Project/Projet serveur"
git push origin main
```

The cron auto-deploy on Omen (every minute) will git-pull within 60s.

- [ ] **Step 2: Get the Omen's current local IP**

The Omen LAN IP changes via DHCP — never assume. Per [feedback_omen_ip_lookup](memory):
1. Open https://omenserver.org
2. Module Réseau → carte "IP locale" → copy the IP

- [ ] **Step 3: SSH to Omen and check if `BRAVE_SEARCH_API_KEY` is already set**

```bash
ssh massii08@<IP_FROM_STEP_2>
sudo systemctl show omenserver | grep -E "Environment|EnvironmentFile"
```

Two possible outcomes:
- **A.** A drop-in `/etc/systemd/system/omenserver.service.d/env.conf` already exists (created during Yield Bot rollout). It already contains `BRAVE_SEARCH_API_KEY=...` → **no change needed**. Skip to Step 5.
- **B.** No drop-in or no Brave key → continue to Step 4.

- [ ] **Step 4: (Conditional) Create/edit the systemd drop-in**

```bash
sudo mkdir -p /etc/systemd/system/omenserver.service.d
sudo tee /etc/systemd/system/omenserver.service.d/env.conf >/dev/null <<'EOF'
[Service]
Environment="BRAVE_SEARCH_API_KEY=BSA..."
EOF
```

Replace `BSA...` with the actual key. Retrieve it from your Mac:
```bash
# (on your Mac, before SSH)
security find-generic-password -a "$USER" -s "BRAVE_SEARCH_API_KEY" -w
```
Then paste into the heredoc on the Omen.

```bash
sudo chmod 600 /etc/systemd/system/omenserver.service.d/env.conf
sudo systemctl daemon-reload
sudo systemctl restart omenserver
```

- [ ] **Step 5: Verify the env var is loaded by the service**

```bash
sudo systemctl show omenserver -p Environment | tr ' ' '\n' | grep BRAVE
```
Expected: `BRAVE_SEARCH_API_KEY=BSA...` (truncated).

- [ ] **Step 6: Trigger a scan from the OmenServer panel**

From the dashboard:
1. Bots → Bond Scanner → set narrow filters (similar to Task 9 Step 2)
2. Run
3. Watch logs — same `📊 Rating da Fitch (Brave)` lines should appear
4. Download Excel, spot-check column G

- [ ] **Step 7: (Optional but recommended) Persist a cron sanity check**

Add a one-line cron on Omen that tests the Brave key once a day and alerts on failure:

```bash
# Not in scope of this plan — flag as future improvement
```

No commit — server-side config.

---

## Task 11 — Update Obsidian vault

Per the global CLAUDE.md ("À chaque fin de discussion … MAJ le vault AVANT de finir").

**Files:**
- Modify: `~/Documents/Obsidian Vault/OmenServer Ecosystem/Daily/2026-05-28.md`
- Modify: `~/Documents/Obsidian Vault/OmenServer Ecosystem/90 - Concepts transverses/🌐 Scraping Deutsche Börse.md`

- [ ] **Step 1: Append a daily note entry**

Append to `Daily/2026-05-28.md`:

```markdown
## 🕐 <current HH:MM> — Bond Scanner rating port (Brave/Fitch-only) ✅

**Cwd** : `/Users/massimiliano/omenserver Project/Projet serveur/bond-scanner`

**Ce qui a été fait** :
- Plan détaillé : `docs/superpowers/plans/2026-05-28-bond-scanner-brave-fitch-rating.md`
- Strip de 5 providers (DB API JSON / Börse Frankfurt HTML / Issuer Reference table / Börse Stuttgart / Fitch Playwright) → 1 seul provider `BraveFitchProvider`
- Cache JSON 30j (`~/.cache/bond-scanner-ratings.json`), avec **negative caching** (les issuers Fitch ne couvre pas sont aussi cachés → on n'épuise pas la quota Brave en re-querying)
- Cellule Excel vide si pas de rating (suppression du `'?'` placeholder)
- Tests unitaires : regex Fitch titles, scoring, REJECT keywords, strip safety, cache TTL
- Patch appliqué aux 2 copies (`bot obbligation/` + `Projet serveur/bond-scanner/`) — sync vérifié via `diff -q`

**Décisions / nouveau pattern** :
- **Negative caching** : pour les API à quota mensuel, cacher aussi le résultat "no hit" évite de re-burn la quota chaque scan sur les issuers que la source ne couvre pas. Pattern à généraliser sur tout fetcher avec quota.
- **Strip prudent partagé** : la règle "Inc/Corp/LLC/PLC/SA/AG/NV/GmbH/SpA only" est dupliquée entre Yield Bot et Bond Scanner. Si on découvre un cas borderline (genre "PJSC" russe ou "Bhd" malaisien), MAJ les 2 fichiers en même temps. Cf. piège #29.
- **Brave key partagée** : 1 seule clé pour les 2 bots, free tier 1000 req/mois largement suffisant (Yield Bot ~5/mois, Bond Scanner ~150 premier scan puis ~30/mois grâce au cache 30j).

**Wikilinks** : [[🔍 Bond Scanner]], [[🏦 Yield Bot]], [[🌐 Scraping Deutsche Börse]]
```

- [ ] **Step 2: Update the Scraping Deutsche Börse concept page**

In `90 - Concepts transverses/🌐 Scraping Deutsche Börse.md`, find the section "✅ Résolution finale — Brave Search API + site:fitchratings.com" (created during the Yield Bot session). Add a subsection at the end:

```markdown
### Portage Bond Scanner (2026-05-28 PM)

La même stratégie est appliquée au [[🔍 Bond Scanner]] :
- Strip complet du cascade 5-providers (`DeutscheBoerseApiProvider` / `BoerseFrankfurtHtmlProvider` / `IssuerReferenceProvider` / `BoerseStuttgartProvider` / `FitchRatingsProvider`)
- Remplacement par `BraveFitchProvider` (1 seule source, mirror exact `_try_brave_search` du Yield Bot)
- **Adaptation async** : `httpx.AsyncClient` au lieu de `httpx.get` sync, parce que `fetch_ratings()` tourne dans la loop Playwright
- **Negative caching ajouté** : les ISINs sans hit Fitch sont aussi mis en cache 30j (Yield Bot peut bénéficier du même pattern lors d'une session future)
- Politique fitch_only strict identique : cellule Excel vide si Fitch ne couvre pas l'émetteur

Conséquence durable : la même clé Brave alimente les 2 bots → 1 quota à surveiller (`/usage-limits` dans le portail Brave). 1000 free credits/mois largement suffisants même cumulés.
```

- [ ] **Step 3: No commit for vault** (vault is not git-tracked from the project repo)

---

## Task 12 — Self-cleanup verification

Before declaring done, sweep for leftovers.

- [ ] **Step 1: Verify no dead imports remain**

```bash
cd "/Users/massimiliano/omenserver Project/Projet serveur/bond-scanner"
grep -rn "DeutscheBoerseApiProvider\|BoerseFrankfurtHtmlProvider\|IssuerReferenceProvider\|BoerseStuttgartProvider\|FitchRatingsProvider\|merge_ratings\|ALL_PROVIDERS" --include="*.py"
```
Expected: zero matches outside `tests/`. If any remain in `scanner/` or `excel/` or `filter/` → patch them.

- [ ] **Step 2: Verify both copies are still byte-identical for the 3 modified files**

```bash
for f in scanner/rating_providers.py scanner/market_scraper.py excel/report_generator.py requirements.txt CLAUDE.md; do
  diff -q "/Users/massimiliano/omenserver Project/bot obbligation/$f" \
          "/Users/massimiliano/omenserver Project/Projet serveur/bond-scanner/$f" \
    && echo "✓ $f"
done
```
Expected: 5 lines starting with `✓`. Any divergence → reconcile.

- [ ] **Step 3: Run the unit tests one final time**

```bash
cd "/Users/massimiliano/omenserver Project/Projet serveur/bond-scanner"
python -m unittest tests.test_rating_brave -v
```
Expected: `OK` with ~15 tests passing.

- [ ] **Step 4: Final smoke from CLI**

```bash
export BRAVE_SEARCH_API_KEY="$(security find-generic-password -a "$USER" -s 'BRAVE_SEARCH_API_KEY' -w)"
python -m scanner.rating_providers US25746UCY38 "Dominion Energy Inc"
```
Expected: `Result: BBB+ (Fitch Ratings via Brave)` (cache hit, instant).

- [ ] **Step 5: Push if not pushed already**

```bash
cd "/Users/massimiliano/omenserver Project/Projet serveur"
git log origin/main..HEAD --oneline
```
If any commits aren't pushed:
```bash
git push origin main
```

---

## Out of scope (flagged for later)

- **Rate limiter for Brave**: free plan = 1 req/sec. Sequential scan ≤ 200 bonds/run is fine, but parallel scans across multiple users would blow it. Not relevant today.
- **`--require-rating` CLI flag**: with fitch_only, ~30-40% of US corporates fall through (Fitch coverage gap). A future flag could drop these bonds from the Excel entirely instead of leaving blank cells. Add to backlog after first prod run reveals how many bonds are affected.
- **Quota dashboard**: add a tiny widget to the OmenServer panel showing current Brave usage (free 1000/mo). Optional.
- **Migrate Yield Bot to negative-caching**: the negative cache pattern introduced here (cache the "no hit" result too) should be backported to `yield-bot/scraper/rating_fetcher.py` to also stop re-burning Brave quota on uncovered issuers.

---

**Plan complete.** Saved to `docs/superpowers/plans/2026-05-28-bond-scanner-brave-fitch-rating.md`.

**Two execution options:**

1. **Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.
2. **Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

**Which approach?**
