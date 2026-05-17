"""
Modelli dati per il Bond Scanner.

ScannedBond rappresenta un'obbligazione trovata durante la scansione
del mercato, con tutti i dati necessari per il filtraggio e il calcolo yield.
"""

from dataclasses import dataclass, field
from datetime import date
from typing import List, Optional


@dataclass
class RatingInfo:
    """Un rating proveniente da una fonte specifica."""

    value: str        # Es: "AA-", "BBB+", "Baa1"
    source: str       # Tag corto: "DB", "BF", "BS"
    source_full: str  # Nome completo: "Deutsche Börse", "Börse Frankfurt", "Börse Stuttgart"

    def __repr__(self) -> str:
        return f"{self.value} ({self.source})"


@dataclass
class ScannedBond:
    """Dati di un'obbligazione trovata durante la scansione del mercato."""

    isin: str
    name: str = ""

    # Dati di prezzo
    current_price: Optional[float] = None
    currency: str = "EUR"

    # Dati master
    coupon_rate: Optional[float] = None  # Tasso cedola (es: 3.375)
    maturity_date: Optional[date] = None
    issue_date: Optional[date] = None

    # Dati aggiuntivi
    volume: Optional[str] = None
    min_piece: Optional[str] = None

    # Rating multi-source
    ratings: List[RatingInfo] = field(default_factory=list)  # Tutti i rating trovati
    rating: Optional[str] = None          # Rating finale (per filtro compatibilità)
    rating_display: Optional[str] = None  # Per Excel: "AA- (DB, BS)" o "AA- (DB) / A+ (BS)"

    # Yield calcolato dal bot
    calculated_yield: Optional[float] = None

    # Metadata
    source: str = "Deutsche Börse"
    fetch_date: Optional[date] = None
    error: Optional[str] = None

    def is_complete(self) -> bool:
        """Verifica se abbiamo tutti i dati necessari per calcolare il yield."""
        return all([
            self.current_price is not None,
            self.coupon_rate is not None,
            self.maturity_date is not None,
        ])

    def years_to_maturity(self) -> Optional[float]:
        """Calcola gli anni rimanenti alla scadenza."""
        if self.maturity_date is None:
            return None
        today = date.today()
        delta = self.maturity_date - today
        return delta.days / 365.25

    def __repr__(self) -> str:
        return (
            f"ScannedBond(isin={self.isin}, name='{self.name[:40]}', "
            f"price={self.current_price}, coupon={self.coupon_rate}%, "
            f"maturity={self.maturity_date}, yield={self.calculated_yield}, "
            f"currency={self.currency})"
        )
