"""
Modelli dati per le obbligazioni.
"""

from dataclasses import dataclass, field
from datetime import date
from typing import Optional


@dataclass
class BondData:
    """Dati di un'obbligazione recuperati da Deutsche Börse."""
    
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
    rating: Optional[str] = None
    
    # Yield calcolato (non dalla bourse)
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
    
    def __repr__(self) -> str:
        return (
            f"BondData(isin={self.isin}, name='{self.name}', "
            f"price={self.current_price}, coupon={self.coupon_rate}%, "
            f"maturity={self.maturity_date}, currency={self.currency})"
        )
