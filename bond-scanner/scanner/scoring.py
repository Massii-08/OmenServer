"""
Composite scoring + top-N per currency (Task 15, 2026-05-28).

Strategia decisa con Massii il 2026-05-28 :
- Scoring composito Defensive (20% prezzo / 40% yield / 40% rating)
  perché il prezzo è già filtrato in 85-110 quindi tutti i candidati sono
  "nella zona d'acquisto" — yield e rating sono i veri differenziatori.
- Edge case "pool secco" : Opzione A — ratio strict. Se una valuta ha
  meno candidati della sua quota, prende quel che c'è, niente compensazione
  sulle altre valute. L'Excel può contenere meno di target_count bond.

Riferimento : docs/superpowers/plans/2026-05-28-bond-scanner-brave-fitch-rating.md
"""
from __future__ import annotations

import logging
from typing import Dict, List, Sequence

from scanner.models import ScannedBond
from scanner.rating_providers import RATING_SCALE, normalize_to_sp

logger = logging.getLogger(__name__)


# ============================================================================
#  Pesi del scoring composito (default Defensive)
# ============================================================================

DEFAULT_WEIGHTS = {
    'price': 0.20,
    'yield': 0.40,
    'rating': 0.40,
}

# Range del prezzo per la normalizzazione score_price.
# Il prezzo entra normalizzato come (PRICE_MAX - price) / (PRICE_MAX - PRICE_MIN).
# Lo slider UI è bloccato in [85, 110] (Task 17).
PRICE_MIN = 85.0
PRICE_MAX = 110.0


def _score_price(price: float | None) -> float:
    """
    Normalizza il prezzo in [0, 1] dove 1 = prezzo basso (85), 0 = prezzo alto (110).
    Se price è None → 0.5 (centro, signal neutro).
    Clamp ai bordi se fuori range.
    """
    if price is None:
        return 0.5
    if price <= PRICE_MIN:
        return 1.0
    if price >= PRICE_MAX:
        return 0.0
    return (PRICE_MAX - price) / (PRICE_MAX - PRICE_MIN)


def _score_yield(bond_yield: float | None, max_yield: float) -> float:
    """
    Normalizza il yield in [0, 1] relativo al max yield del pool.
    Se max_yield è 0 (caso degenerato), tutti i score sono 0.
    """
    if bond_yield is None or max_yield <= 0:
        return 0.0
    return max(0.0, min(1.0, bond_yield / max_yield))


def _score_rating(rating: str | None) -> float:
    """
    Normalizza il rating in [0, 1] dove 1 = AAA (top), 0 = D (bottom).
    Se il rating non è normalizzabile → 0 (deve essere già stato filtrato a monte).
    """
    if not rating:
        return 0.0
    normalized = normalize_to_sp(rating)
    if not normalized or normalized not in RATING_SCALE:
        return 0.0
    idx = RATING_SCALE.index(normalized)
    return 1.0 - (idx / (len(RATING_SCALE) - 1))


def compute_composite_score(
    bond: ScannedBond,
    max_yield: float,
    weights: Dict[str, float] = None,
) -> float:
    """
    Calcola il score composito di un bond.

    Args:
        bond: ScannedBond con price/yield/rating valorizzati.
        max_yield: massimo yield del pool corrente (per normalizzazione).
        weights: opzionale, default DEFAULT_WEIGHTS (20/40/40 Defensive).

    Returns:
        float in [0, 1]. Più alto = bond migliore secondo i pesi scelti.
    """
    if weights is None:
        weights = DEFAULT_WEIGHTS

    sp = _score_price(bond.current_price)
    sy = _score_yield(bond.calculated_yield, max_yield)
    sr = _score_rating(bond.rating)

    return (
        weights['price'] * sp
        + weights['yield'] * sy
        + weights['rating'] * sr
    )


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

def top_n_per_currency(
    bonds: Sequence[ScannedBond],
    target_count: int,
    currencies: Sequence[str],
    weights: Dict[str, float] = None,
) -> Dict[str, List[ScannedBond]]:
    """
    Calcola il score composito per ogni bond, poi prende i top-K bond
    per valuta secondo le quote calcolate da compute_quotas().

    Edge case "pool secco" : Opzione A — ratio strict. Se una valuta ha
    meno bond della sua quota, prende quello che ha. Niente travaso sulle
    altre valute. L'Excel finale può contenere meno di target_count bond.

    Args:
        bonds: tutti i bond che hanno passato i filter (incl. rating Fitch).
        target_count: numero target di bond nell'Excel finale.
        currencies: lista delle valute selezionate (es. ['EUR', 'USD']).
        weights: pesi del scoring composito (default Defensive 20/40/40).

    Returns:
        Dict {currency: [top-K bonds ordinati per score desc]}.
        Il bond ha l'attributo .composite_score impostato in posto.
    """
    if not bonds or not currencies:
        return {c: [] for c in currencies}

    # 1. Calcola il max yield globalmente (per la normalizzazione)
    max_yield = max(
        (b.calculated_yield or 0 for b in bonds),
        default=0,
    )

    # 2. Calcola e attribuisce il composite_score
    for b in bonds:
        b.composite_score = compute_composite_score(b, max_yield, weights)

    # 3. Raggruppa per valuta
    by_currency: Dict[str, List[ScannedBond]] = {c: [] for c in currencies}
    for b in bonds:
        c = (b.currency or '').upper()
        if c in by_currency:
            by_currency[c].append(b)

    # 4. Calcola le quote e prende i top-K per valuta
    quotas = compute_quotas(target_count, len(currencies))

    result: Dict[str, List[ScannedBond]] = {}
    for currency, quota in zip(currencies, quotas):
        pool = by_currency.get(currency.upper(), [])
        # Tri "best-N" (demande Massii 2026-05-28) : rating DÉCROISSANT en
        # priorité (les meilleurs ratings en haut, ratings plus bas vers la
        # fin), puis composite (yield/prix) comme départage à rating égal.
        pool_sorted = sorted(
            pool,
            key=lambda b: (_score_rating(b.rating), b.composite_score),
            reverse=True,
        )
        taken = pool_sorted[:quota]
        if len(taken) < quota:
            logger.warning(
                f"  ⚠️  Pool {currency} secco: {len(taken)}/{quota} bond. "
                f"L'Excel avrà {len(taken)} righe invece di {quota} per "
                f"questa valuta (politica ratio strict, opzione A)."
            )
        result[currency.upper()] = taken

    return result
