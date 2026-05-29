"""
Criteri di filtro per la scansione delle obbligazioni.

Definisce i parametri configurabili per selezionare le obbligazioni "sicure":
- Prezzo basso (sotto la pari)
- Scadenza entro N anni
- Yield alto
- Rating Investment Grade (≥ BBB-)
"""

import logging
from dataclasses import dataclass, field
from datetime import date
from typing import List, Optional, Tuple

logger = logging.getLogger(__name__)

# Scala dei rating S&P/Fitch (dal migliore al peggiore)
RATING_SCALE = [
    'AAA', 'AA+', 'AA', 'AA-',
    'A+', 'A', 'A-',
    'BBB+', 'BBB', 'BBB-',  # ← Investment Grade cutoff
    'BB+', 'BB', 'BB-',
    'B+', 'B', 'B-',
    'CCC+', 'CCC', 'CCC-',
    'CC', 'C', 'D',
]

# Scala Moody's → S&P equivalente
# Include sia le forme con numero (Aa1, Aa2, Aa3) che senza (Aa)
# come mostrato nella tabella "Rating equivalence between the Big Three"
MOODY_TO_SP = {
    'Aaa': 'AAA',
    'Aa1': 'AA+', 'Aa2': 'AA', 'Aa3': 'AA-', 'Aa': 'AA',
    'A1': 'A+', 'A2': 'A', 'A3': 'A-',
    'Baa1': 'BBB+', 'Baa2': 'BBB', 'Baa3': 'BBB-', 'Baa': 'BBB',
    'Ba1': 'BB+', 'Ba2': 'BB', 'Ba3': 'BB-', 'Ba': 'BB', 'BA': 'BB',
    'B1': 'B+', 'B2': 'B', 'B3': 'B-',
    'Caa1': 'CCC+', 'Caa2': 'CCC', 'Caa3': 'CCC-', 'Caa': 'CCC',
    'Ca': 'CC', 'C': 'C',
}


def _normalize_rating(rating: str) -> Optional[str]:
    """Normalizza un rating a formato S&P."""
    if not rating:
        return None
    rating = rating.strip()
    # Già formato S&P?
    if rating.upper() in [r.upper() for r in RATING_SCALE]:
        return rating.upper()
    # Moody's?
    if rating in MOODY_TO_SP:
        return MOODY_TO_SP[rating]
    # Tentativo case-insensitive
    for moody, sp in MOODY_TO_SP.items():
        if rating.lower() == moody.lower():
            return sp
    return None


def _rating_index(rating: str) -> int:
    """Restituisce l'indice del rating nella scala (0=AAA, migliore)."""
    normalized = _normalize_rating(rating)
    if normalized is None:
        return 999  # Rating sconosciuto → trattato come peggiore
    try:
        return RATING_SCALE.index(normalized)
    except ValueError:
        return 999


@dataclass
class ScanCriteria:
    """
    Criteri configurabili per la scansione delle obbligazioni.

    Tutti i parametri sono configurabili dall'interfaccia web.
    """

    # Prezzo massimo (sotto la pari = buona opportunità)
    max_price: float = 100.0

    # Yield minimo come decimale (es: 0.03 = 3%)
    min_yield: float = 0.03

    # Scadenza massima in anni dalla data odierna
    max_maturity_years: int = 9

    # Rating minimo (Investment Grade)
    min_rating: str = "BBB-"

    # Valute di interesse
    currencies: List[str] = field(default_factory=lambda: ["EUR", "USD", "GBP"])

    # Filtri opzionali avanzati
    min_volume: Optional[float] = None       # Volume minimo in EUR
    max_min_piece: Optional[float] = None    # Pièce minimale max (accessibilità)

    def matches(self, bond, *, check_rating: bool = True) -> Tuple[bool, str]:
        """
        Verifica se un'obbligazione soddisfa tutti i criteri.

        Args:
            bond: ScannedBond da verificare
            check_rating: Se False, skip il check del rating (Task 13 pattern :
                          chiamato in modalità "pre-filter" prima di pagare la
                          Brave Search per ottenere il rating Fitch).

        Returns:
            (matches, reason): True se corrisponde, False + motivo se scartata
        """
        # 1. Prezzo: deve essere ≤ max_price
        if bond.current_price is not None and bond.current_price > self.max_price:
            return False, f"Prezzo {bond.current_price:.2f} > {self.max_price}"

        # 2. Scadenza: deve essere entro max_maturity_years
        if bond.maturity_date is not None:
            years = bond.years_to_maturity()
            if years is not None:
                if years <= 0:
                    return False, f"Obbligazione già scaduta"
                if years > self.max_maturity_years:
                    return False, f"Scadenza {years:.1f} anni > {self.max_maturity_years} anni"
        else:
            # Senza data di scadenza, non possiamo verificare → accettiamo
            # (le obbligazioni perpetue non hanno scadenza)
            pass

        # 3. Yield: deve essere ≥ min_yield
        if bond.calculated_yield is not None and bond.calculated_yield < self.min_yield:
            return False, f"Yield {bond.calculated_yield:.4%} < {self.min_yield:.2%}"

        # 4. Rating: OBBLIGATORIO + ≥ min_rating (Investment Grade)
        # Politica (demande Massii 2026-05-29) : un bond SANS rating Fitch
        # vérifié ne doit JAMAIS entrer dans l'Excel — "sinon il faut pas
        # mettre le bond dans la liste". On rejette donc TOUT bond sans rating,
        # même si min_rating n'est pas défini (avant : rejet seulement si
        # min_rating set → des bonds sans rating pouvaient passer cellule vide).
        # check_rating=False salta questo blocco (pre-filter mode, Task 13).
        if check_rating:
            if not bond.rating:
                return False, "Nessun rating Fitch verificato (politica fitch_only)"
            if self.min_rating:
                bond_idx = _rating_index(bond.rating)
                min_idx = _rating_index(self.min_rating)
                if bond_idx > min_idx:
                    return False, f"Rating {bond.rating} < {self.min_rating}"

        # 5. Valuta: deve essere nella lista
        if bond.currency and bond.currency.upper() not in [c.upper() for c in self.currencies]:
            return False, f"Valuta {bond.currency} non nelle valute selezionate"

        # 6. Volume minimo (opzionale)
        if self.min_volume is not None and bond.volume is not None:
            try:
                vol = float(str(bond.volume).replace('k', '000').replace(',', '').replace("'", ''))
                if vol < self.min_volume:
                    return False, f"Volume {bond.volume} < minimo"
            except ValueError:
                pass

        # 7. Pezzo minimo max (opzionale)
        if self.max_min_piece is not None and bond.min_piece is not None:
            try:
                mp = float(str(bond.min_piece).replace('k', '000').replace(',', '').replace("'", ''))
                if mp > self.max_min_piece:
                    return False, f"Pezzo minimo {bond.min_piece} > max"
            except ValueError:
                pass

        return True, "OK"

    def to_dict(self) -> dict:
        """Serializza i criteri per logging/salvataggio."""
        return {
            "max_price": self.max_price,
            "min_yield": self.min_yield,
            "max_maturity_years": self.max_maturity_years,
            "min_rating": self.min_rating,
            "currencies": self.currencies,
            "min_volume": self.min_volume,
            "max_min_piece": self.max_min_piece,
        }

    def __str__(self) -> str:
        return (
            f"Criteri: prezzo≤{self.max_price}, yield≥{self.min_yield:.2%}, "
            f"scadenza≤{self.max_maturity_years}anni, rating≥{self.min_rating}, "
            f"valute={','.join(self.currencies)}"
        )
