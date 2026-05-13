"""
Calcolatore di Yield per obbligazioni.

Replica la formula della "Scheda Esempio" Excel dell'utente.
Il yield viene calcolato dal bot, NON preso dalla bourse.

Formula (dalla Scheda Esempio):
    Rendimento = (Tasso/100) / (Prezzo/100)
    Tempo alla scadenza = DAYS360(Scadenza, Data) / 360
    Ripartizione = (100 - Prezzo) / Tempo_scadenza / 100
    Yield = Rendimento - Ripartizione
"""

from datetime import date
from typing import Optional
from calculator.days360 import days360


def calculate_yield_at_purchase(
    coupon_rate: float,
    purchase_price: float,
    purchase_date: date,
    maturity_date: date
) -> float:
    """
    Calcola il Yield all'acquisto (corrisponde a J28 della Scheda Esempio).
    
    Usa il prezzo d'acquisto per determinare il rendimento effettivo
    dell'obbligazione tenuta fino a scadenza.
    
    Args:
        coupon_rate: Tasso cedola in percentuale (es: 3.375 per 3,375%)
        purchase_price: Prezzo d'acquisto (es: 89.43 su base 100)
        purchase_date: Data di acquisto dell'obbligazione
        maturity_date: Data di scadenza dell'obbligazione
    
    Returns:
        Yield all'acquisto come decimale (es: 0.0294 = 2.94%)
    
    Raises:
        ValueError: Se il tempo alla scadenza è zero o il prezzo è zero
    """
    if purchase_price == 0:
        raise ValueError("Il prezzo d'acquisto non può essere zero")
    
    # D6 = C6/100 → Tasso come decimale
    tasso_decimale = coupon_rate / 100
    
    # J24 = D6 / (J23/100) → Rendimento all'acquisto
    # J23 = F11 = prezzo d'acquisto
    rendimento = tasso_decimale / (purchase_price / 100)
    
    # J26 = DAYS360(D8, D7) / 360 → Tempo alla scadenza in anni
    # NOTA: nella Scheda Esempio, DAYS360(Scadenza, Data_acquisto)
    # restituisce un valore NEGATIVO (perché scadenza > acquisto)
    giorni = days360(maturity_date, purchase_date, method_eu=False)
    
    if giorni == 0:
        raise ValueError("Il tempo alla scadenza non può essere zero")
    
    tempo_scadenza = giorni / 360  # Sarà negativo
    
    # J27 = (100 - J23) / J26 / 100 → Ripartizione nel periodo
    ripartizione = (100 - purchase_price) / tempo_scadenza / 100
    
    # J28 = J24 - J27 → Yield all'acquisto
    yield_acquisto = rendimento - ripartizione
    
    return yield_acquisto


def calculate_yield_at_current_price(
    coupon_rate: float,
    current_price: float,
    maturity_date: date,
    reference_date: date = None
) -> float:
    """
    Calcola il Yield al corso attuale (corrisponde a E28 della Scheda Esempio).
    
    Usa il prezzo corrente di mercato per determinare il rendimento 
    se l'obbligazione venisse acquistata oggi.
    
    Args:
        coupon_rate: Tasso cedola in percentuale (es: 3.375 per 3,375%)
        current_price: Prezzo corrente di mercato (es: 99.03 su base 100)
        maturity_date: Data di scadenza dell'obbligazione
        reference_date: Data di riferimento (default: oggi)
    
    Returns:
        Yield al corso attuale come decimale (es: 0.0127 = 1.27%)
    
    Raises:
        ValueError: Se il tempo alla scadenza è zero o il prezzo è zero
    """
    if reference_date is None:
        reference_date = date.today()
    
    if current_price == 0:
        raise ValueError("Il prezzo corrente non può essere zero")
    
    # D6 = C6/100 → Tasso come decimale
    tasso_decimale = coupon_rate / 100
    
    # F24 = D6 / (F23/100) → Rendimento al corso attuale
    rendimento = tasso_decimale / (current_price / 100)
    
    # E26 = DAYS360(D8, C23) / 360 → Tempo alla scadenza da oggi
    giorni = days360(maturity_date, reference_date, method_eu=False)
    
    if giorni == 0:
        raise ValueError("Il tempo alla scadenza non può essere zero")
    
    tempo_scadenza = giorni / 360  # Sarà negativo
    
    # E27 = (100 - F23) / E26 / 100 → Ripartizione nel periodo
    ripartizione = (100 - current_price) / tempo_scadenza / 100
    
    # E28 = F24 - E27 → Yield a scadenza
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
    
    Args:
        current_price: Prezzo corrente (es: 95.87)
        maturity_date: Data di scadenza
        reference_date: Data di riferimento (default: oggi)
    
    Returns:
        Yield come decimale (es: 0.0145 = 1.45%)
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
    
    Args:
        coupon_rate: Tasso cedola in percentuale (es: 6.125)
        current_price: Prezzo corrente (es: 102.30)
    
    Returns:
        Yield come decimale (es: 0.0599 = 5.99%)
    """
    if current_price <= 0:
        raise ValueError("Il prezzo non può essere zero o negativo")
    
    yield_perp = (coupon_rate / 100) / (current_price / 100)
    
    return yield_perp


def extract_coupon_from_name(bond_name: str) -> Optional[float]:
    """
    Estrae il tasso cedola dal nome dell'obbligazione.
    
    Esempi:
        "Deutsche Post AG 3,375% - 03.07.33" → 3.375
        "Dell 5,3 - 01.10.29" → 5.3
        "POWER FIN  1,841 - 21.09.28" → 1.841
    
    Args:
        bond_name: Nome dell'obbligazione come nel file Excel
    
    Returns:
        Tasso cedola come float, o None se non trovato
    """
    import re
    
    # Pattern 1: percentuale esplicita (es: "3,375%")
    match = re.search(r'(\d+[,.]?\d*)\s*%', bond_name)
    if match:
        return float(match.group(1).replace(',', '.'))
    
    # Pattern 2: frazioni tipo "1 1/8" (deve essere prima dei numeri semplici)
    match = re.search(r'\s(\d+)\s+(\d+)/(\d+)\s', bond_name)
    if match:
        whole = int(match.group(1))
        numerator = int(match.group(2))
        denominator = int(match.group(3))
        return whole + numerator / denominator
    
    # Pattern 3: numero con virgola/punto prima di un trattino e una data
    # es: "Dell 5,3 - 01.10.29" o "POWER FIN 1,841 - 21.09.28"
    match = re.search(r'\s(\d+[,.]\d+)\s*[-\u2013]\s*\d{1,2}[./]\d{1,2}', bond_name)
    if match:
        return float(match.group(1).replace(',', '.'))
    
    # Pattern 4: numero intero prima di un trattino e una data
    # es: "COMMERZBANK AG 4 - 05.12.30"
    match = re.search(r'\s(\d{1,2})\s*[-\u2013]\s*\d{1,2}[./]\d{1,2}', bond_name)
    if match:
        val = int(match.group(1))
        if 0 < val < 20:  # Range ragionevole per cedola
            return float(val)
    
    return None


def extract_maturity_from_name(bond_name: str) -> Optional[date]:
    """
    Estrae la data di scadenza dal nome dell'obbligazione.
    
    Esempi:
        "Deutsche Post AG 3,375% - 03.07.33" → 2033-07-03
        "Dell 5,3 - 01.10.29" → 2029-10-01
        "Realty Income Corp. 3,375% - 20.06.2031" → 2031-06-20
    
    Args:
        bond_name: Nome dell'obbligazione come nel file Excel
    
    Returns:
        Data di scadenza, o None se non trovata
    """
    import re
    
    # Pattern 1: DD.MM.YYYY (4 cifre anno)
    match = re.search(r'(\d{1,2})[./](\d{1,2})[./](\d{4})', bond_name)
    if match:
        day = int(match.group(1))
        month = int(match.group(2))
        year = int(match.group(3))
        try:
            return date(year, month, day)
        except ValueError:
            pass
    
    # Pattern 2: DD.MM.YY (2 cifre anno)
    match = re.search(r'(\d{1,2})[./](\d{1,2})[./](\d{2})(?!\d)', bond_name)
    if match:
        day = int(match.group(1))
        month = int(match.group(2))
        year = int(match.group(3))
        # Assumiamo 2000s
        year += 2000
        try:
            return date(year, month, day)
        except ValueError:
            pass
    
    return None
