"""
Classifica equilibrata rating / yield + top-N per valuta (Bond Scanner).

Storia delle decisioni :
- 2026-05-28 (Task 15) : scoring composito 20% prezzo / 40% yield / 40%
  rating, ma il tri finale era "rating prima di tutto" : il composito serviva
  solo a spareggiare due bond con lo stesso rating → la lista si riempiva di
  AAA / AA+ (soprattutto titoli di Stato) a yield basso.
- 2026-10-17 (richiesta Massii : "invece dei migliori rating, la lista deve
  essere un compromesso tra i migliori rating e yield") : classifica
  EQUILIBRATA 50% rating / 50% yield, calcolata PER VALUTA.

Calcolo, per ogni valuta selezionata, sul pool dei bond che hanno superato i
filtri (rating Fitch verificato incluso) :
- punti rating : posizione lineare tra il rating MINIMO dello scan (= 0) e AAA
  (= 1). Minimo assente/sconosciuto → BBB- (DEFAULT_RATING_FLOOR).
- punti yield  : rango percentile del yield NEL POOL DELLA STESSA VALUTA
  (peggiore = 0, migliore = 1, pari merito = rango medio). Yield assente = 0 ;
  pool con un solo yield = 1. Un solo yield estremo non schiaccia gli altri
  (a differenza di una normalizzazione in valore, tipo yield / max).
- score = RATING_WEIGHT * punti_rating + (1 - RATING_WEIGHT) * punti_yield,
  in [0, 1], salvato in ScannedBond.composite_score.
- Il PREZZO non entra nella classifica : resta un filtro (prezzo max). Il yield
  include già lo sconto sotto la pari, contarlo anche nel prezzo sarebbe un
  doppione.
- Ordine : score decrescente, poi miglior rating, poi miglior yield, poi ISIN
  crescente (ordine deterministico).

Edge case "pool secco" : Opzione A — ratio strict (decisione 2026-05-28). Se una
valuta ha meno candidati della sua quota, prende quel che c'è, niente
compensazione sulle altre valute. L'Excel può contenere meno di target_count bond.

Riferimento : docs/superpowers/specs/2026-10-17-bond-scanner-balanced-score-design.md
"""
from __future__ import annotations

import logging
from bisect import bisect_left, bisect_right
from typing import Dict, List, Optional, Sequence, Tuple

from scanner.models import ScannedBond
from scanner.rating_providers import RATING_SCALE, normalize_to_sp

logger = logging.getLogger(__name__)


# ============================================================================
#  Parametri del classement (decisione Massii 2026-10-17)
# ============================================================================

# Parte del rating nello score ; il yield prende (1 - RATING_WEIGHT).
# Costante di modulo, nessun cursore UI (opzione scartata da Massii).
RATING_WEIGHT = 0.5

# Rating minimo usato come "zero" dei punti rating se lo scan non ne fornisce
# uno (o se è sconosciuto). Allineato al default di ScanCriteria.min_rating.
DEFAULT_RATING_FLOOR = 'BBB-'

# Indice di ogni rating S&P nella scala (0 = AAA, migliore).
_SCALE_INDEX = {rating: idx for idx, rating in enumerate(RATING_SCALE)}

# Rating assente/sconosciuto = peggiore di tutti nel tri di spareggio.
_UNKNOWN_RATING_INDEX = 999


# ============================================================================
#  Punti rating / punti yield (funzioni pure)
# ============================================================================

def _scale_index(rating: Optional[str]) -> Optional[int]:
    """
    Indice del rating in RATING_SCALE (0 = AAA), anche se espresso in notazione
    Moody's (normalizzato via normalize_to_sp). None se assente o sconosciuto.
    """
    if not rating or not isinstance(rating, str):
        return None
    return _SCALE_INDEX.get(normalize_to_sp(rating))


def rating_points(rating: Optional[str], floor: Optional[str] = None) -> float:
    """
    Punti rating in [0, 1] : 1 = AAA, 0 = rating minimo dello scan (`floor`).

    Posizione lineare sulla scala S&P tra il minimo e AAA. Un rating sotto il
    minimo (non dovrebbe arrivare qui, già filtrato a monte) vale 0.

    Args:
        rating: rating del bond (S&P/Fitch o Moody's). Assente/sconosciuto → 0.
        floor: rating minimo dello scan. Assente/sconosciuto →
            DEFAULT_RATING_FLOOR. Se è AAA, solo AAA vale 1 (niente divisione
            per zero).
    """
    ri = _scale_index(rating)
    if ri is None:
        return 0.0
    fi = _scale_index(floor)
    if fi is None:
        fi = _SCALE_INDEX[DEFAULT_RATING_FLOOR]
    if fi == 0:
        return 1.0 if ri == 0 else 0.0
    return max(0.0, min(1.0, (fi - ri) / fi))


def yield_points(value: Optional[float], sorted_pool_yields: Sequence[float]) -> float:
    """
    Punti yield in [0, 1] : rango percentile di `value` nel pool della valuta.

    Il peggiore del pool vale 0, il migliore 1 ; in caso di pari merito si
    prende il rango medio del gruppo. Yield assente → 0. Pool con un solo yield
    (o vuoto) → 1 : niente da confrontare, non si penalizza.

    Args:
        value: yield del bond (decimale). None → 0.
        sorted_pool_yields: yield del pool in ORDINE CRESCENTE e senza None
            (preparato una sola volta per valuta da top_n_per_currency).
    """
    if value is None:
        return 0.0
    n = len(sorted_pool_yields)
    if n <= 1:
        return 1.0
    below = bisect_left(sorted_pool_yields, value)
    equal = bisect_right(sorted_pool_yields, value) - below
    points = (below + (equal - 1) / 2) / (n - 1)
    return max(0.0, min(1.0, points))


# ============================================================================
#  Distribution delle quote per valuta
# ============================================================================

def compute_quotas(target_count: int, n_currencies: int) -> List[int]:
    """
    Distribuisce target_count su n_currencies valute il più equamente possibile.

    Il resto va alle prime valute della lista (ordine = ordine di iterazione
    in self.criteria.currencies).

    Esempi :
        compute_quotas(100, 1) → [100]
        compute_quotas(100, 2) → [50, 50]
        compute_quotas(100, 3) → [34, 33, 33]
        compute_quotas(75, 3)  → [25, 25, 25]
        compute_quotas(50, 3)  → [17, 17, 16]
    """
    if n_currencies <= 0:
        return []
    if target_count <= 0:
        return [0] * n_currencies
    base = target_count // n_currencies
    remainder = target_count % n_currencies
    return [base + (1 if i < remainder else 0) for i in range(n_currencies)]


# ============================================================================
#  Top-N per valuta (con edge case "pool secco")
# ============================================================================

def _ranking_key(bond: ScannedBond) -> Tuple[int, int, float, str]:
    """
    Chiave di ordinamento (crescente) : score decrescente, poi miglior rating
    (indice più basso ; sconosciuto = ultimo), poi miglior yield, poi ISIN
    crescente → ordine deterministico anche a parità perfetta.
    """
    rating_idx = _scale_index(bond.rating)
    # Score ARRONDI sur une grille binaire 2^-30, SEULEMENT dans cette clé de
    # tri (composite_score stocké reste brut). Des scores mathématiquement égaux
    # (ex. 11/18 obtenu par AA+, A+ ou BBB+ selon le rang du yield) diffèrent de
    # ~1e-16 en flottant : sans arrondi, ce bruit déciderait à la place du
    # départage « meilleur rating ». Un score exact a un dénominateur qui divise
    # 4·fi·(n-1) ≤ 4 × 21 × 1499 ≪ 2^31 : il ne tombe jamais sur une frontière
    # (2k+1)/2^31 (une grille décimale, elle, peut en croiser une), et deux
    # scores distincts (écart ≥ ~1e-5) ne sont jamais fusionnés.
    return (
        -round(bond.composite_score * 2 ** 30),
        _UNKNOWN_RATING_INDEX if rating_idx is None else rating_idx,
        -(bond.calculated_yield or 0),
        bond.isin or '',
    )


def top_n_per_currency(
    bonds: Sequence[ScannedBond],
    target_count: int,
    currencies: Sequence[str],
    rating_floor: Optional[str] = None,
) -> Dict[str, List[ScannedBond]]:
    """
    Calcola lo score equilibrato (50% rating / 50% yield) di ogni bond, PER
    VALUTA, poi prende i top-K bond per valuta secondo le quote calcolate da
    compute_quotas().

    Il rango del yield è calcolato nel pool della STESSA valuta (un EUR al 3,9%
    non è giudicato contro un GBP al 6%). Il prezzo non entra nello score.

    Edge case "pool secco" : Opzione A — ratio strict. Se una valuta ha
    meno bond della sua quota, prende quello che ha. Niente travaso sulle
    altre valute. L'Excel finale può contenere meno di target_count bond.

    Args:
        bonds: tutti i bond che hanno passato i filter (incl. rating Fitch).
        target_count: numero target di bond nell'Excel finale.
        currencies: lista delle valute selezionate (es. ['EUR', 'USD']).
        rating_floor: rating minimo dello scan (= 0 punti rating). Assente o
            sconosciuto → DEFAULT_RATING_FLOOR (BBB-).

    Returns:
        Dict {CURRENCY: [top-K bonds ordinati per score desc]}.
        Il bond ha l'attributo .composite_score impostato in posto
        (solo per le valute selezionate ; le altre sono ignorate).
    """
    if not bonds or not currencies:
        return {c: [] for c in currencies}

    # 1. Raggruppa per valuta selezionata (le altre valute sono ignorate)
    by_currency: Dict[str, List[ScannedBond]] = {c.upper(): [] for c in currencies}
    for b in bonds:
        c = (b.currency or '').upper()
        if c in by_currency:
            by_currency[c].append(b)

    # 2. Calcola le quote e, per ogni valuta, score + top-K
    quotas = compute_quotas(target_count, len(currencies))

    result: Dict[str, List[ScannedBond]] = {}
    for currency, quota in zip(currencies, quotas):
        pool = by_currency.get(currency.upper(), [])

        # Yield del pool (senza None, ordinati) : base del rango percentile.
        pool_yields = sorted(
            b.calculated_yield for b in pool if b.calculated_yield is not None
        )
        for b in pool:
            b.composite_score = (
                RATING_WEIGHT * rating_points(b.rating, rating_floor)
                + (1 - RATING_WEIGHT) * yield_points(b.calculated_yield, pool_yields)
            )

        # Tri "équilibré" (demande Massii 2026-10-17) : score décroissant, puis
        # meilleur rating, meilleur yield, ISIN (ordre déterministe).
        pool_sorted = sorted(pool, key=_ranking_key)
        taken = pool_sorted[:quota]
        if len(taken) < quota:
            logger.warning(
                f"  ⚠️  Pool {currency} secco: {len(taken)}/{quota} bond. "
                f"L'Excel avrà {len(taken)} righe invece di {quota} per "
                f"questa valuta (politica ratio strict, opzione A)."
            )
        result[currency.upper()] = taken

    return result
