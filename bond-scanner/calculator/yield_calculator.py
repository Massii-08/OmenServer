"""
Calcolatore di Yield per obbligazioni.

Replica la formula della "Scheda Esempio" Excel dell'utente.
Il yield viene calcolato dal bot, NON preso dalla bourse.

Formula (dalla Scheda Esempio):
    Rendimento = (Tasso/100) / (Prezzo/100)
    Tempo alla scadenza = DAYS360(Scadenza, Data) / 360
    Ripartizione = (100 - Prezzo) / Tempo_scadenza / 100
    Yield = Rendimento - Ripartizione

Copiato dal Bot Calcul Yield — stessa logica esatta.
"""

from datetime import date
from typing import Optional
from calculator.days360 import days360


def calculate_yield_at_current_price(
    coupon_rate: float,
    current_price: float,
    maturity_date: date,
    reference_date: date = None
) -> float:
    """
    Calcola il Yield al corso attuale.

    Args:
        coupon_rate: Tasso cedola in percentuale (es: 3.375 per 3,375%)
        current_price: Prezzo corrente di mercato (es: 99.03 su base 100)
        maturity_date: Data di scadenza dell'obbligazione
        reference_date: Data di riferimento (default: oggi)

    Returns:
        Yield al corso attuale come decimale (es: 0.0127 = 1.27%)
    """
    if reference_date is None:
        reference_date = date.today()

    if current_price == 0:
        raise ValueError("Il prezzo corrente non può essere zero")

    tasso_decimale = coupon_rate / 100
    rendimento = tasso_decimale / (current_price / 100)

    giorni = days360(maturity_date, reference_date, method_eu=False)

    if giorni == 0:
        raise ValueError("Il tempo alla scadenza non può essere zero")

    tempo_scadenza = giorni / 360

    ripartizione = (100 - current_price) / tempo_scadenza / 100
    yield_scadenza = rendimento - ripartizione

    return yield_scadenza


def calculate_yield_zero_coupon(
    current_price: float,
    maturity_date: date,
    reference_date: date = None
) -> float:
    """
    Calcola il Yield di un'obbligazione zero-coupon.

    Formula: yield = (100 / prezzo) ^ (1 / anni) - 1
    """
    if reference_date is None:
        reference_date = date.today()

    if current_price <= 0:
        raise ValueError("Il prezzo non può essere zero o negativo")

    giorni = abs(days360(maturity_date, reference_date, method_eu=False))
    if giorni == 0:
        raise ValueError("Il tempo alla scadenza non può essere zero")

    anni = giorni / 360
    yield_zc = (100 / current_price) ** (1 / anni) - 1

    return yield_zc


def calculate_yield_perpetual(
    coupon_rate: float,
    current_price: float
) -> float:
    """
    Calcola il Yield di un'obbligazione perpetua (senza scadenza).

    Formula semplificata: yield = cedola / prezzo
    """
    if current_price <= 0:
        raise ValueError("Il prezzo non può essere zero o negativo")

    yield_perp = (coupon_rate / 100) / (current_price / 100)

    return yield_perp
