"""Jauge d'humeur du marché — le VIX, caché en MÉMOIRE (jamais un fichier).

Le VIX (« indice de la peur ») mesure la volatilité IMPLICITE attendue sur le
S&P 500 dans les 30 prochains jours — pas un cours qu'on détient, un
THERMOMÈTRE du marché. Ce module en fait une lecture à trois chiffres
(``vix``, ``change_pct``, ``mood``), servie par :func:`get` et cachée
``CACHE_TTL_S`` secondes — même doctrine de cache que ``quotes.fx_to_chf``
(``_FX_CACHE``/``_now`` injectable), mais ici EXPLICITEMENT en mémoire
processus : la spec A1/D3 dit « pas un fichier », et un cache disque
survivrait à un déploiement avec une valeur périmée sans qu'on ait de raison
de le vouloir (le VIX bouge en continu pendant les séances).

Best-effort de bout en bout : ``get()`` ne lève JAMAIS. VIX introuvable
(marché fermé, Yahoo en panne, moteur absent) -> ``{}`` — le routeur en fait
un 200 vide, l'interface n'affiche alors AUCUN chip (mieux qu'un chip qui
mentirait sur une valeur inventée).
"""
import time
from typing import Any, Callable, Dict, Optional

VIX_SYMBOL = "^VIX"

# 10 minutes : assez pour ne pas re-sonder Yahoo à chaque poll de 60 s du
# dashboard, assez court pour rester une lecture du JOUR, pas de la veille.
CACHE_TTL_S = 600.0

# Seuils calibrés sur la lecture usuelle du VIX (piège du dépôt : personne ne
# les invente au hasard, ce sont les repères communément admis d'un indice de
# volatilité implicite S&P 500).
CALME_MAX = 15.0        # < 15 : marché calme
NORMAL_MAX = 20.0       # 15-20 : régime normal
NERVEUX_MAX = 30.0      # 20-30 : nerveux ; >= 30 : panique

MOOD_CALME = "calme"
MOOD_NORMAL = "normal"
MOOD_NERVEUX = "nerveux"
MOOD_PANIQUE = "panique"

# Horloge du cache, injectable (les tests avancent le temps sans dormir).
_now: Callable[[], float] = time.monotonic
_CACHE: Dict[str, Any] = {}     # {"data": {...}, "at": float}


def clear_cache() -> None:
    """Vide le cache (tests, ou changement délibéré de lecture)."""
    _CACHE.clear()


def classify(vix: Optional[float]) -> Optional[str]:
    """Le mood d'un niveau de VIX (PUR). ``None`` si le VIX est inconnu —
    jamais un mood inventé pour une valeur qu'on n'a pas."""
    if vix is None:
        return None
    try:
        value = float(vix)
    except (TypeError, ValueError):
        return None
    if value < CALME_MAX:
        return MOOD_CALME
    if value < NORMAL_MAX:
        return MOOD_NORMAL
    if value < NERVEUX_MAX:
        return MOOD_NERVEUX
    return MOOD_PANIQUE


def build(vix: Optional[float], change_pct: Optional[float]) -> Dict[str, Any]:
    """Assemble la lecture (PUR) — ``{}`` si le VIX n'est pas exploitable, la
    forme complète ``{vix, change_pct, mood}`` sinon."""
    mood = classify(vix)
    if mood is None:
        return {}
    return {"vix": float(vix), "change_pct": change_pct, "mood": mood}


def get(quote_fn: Optional[Callable[[str], Any]] = None,
       ttl_s: float = CACHE_TTL_S) -> Dict[str, Any]:
    """La lecture courante, best-effort et CACHÉE EN MÉMOIRE.

    ``quote_fn`` par défaut : ``quotes.get_quote`` (import paresseux — même
    patron que ``calendar._default_quote``). Échec, moteur absent, ou marché
    fermé sans dernière clôture lisible -> ``{}``, jamais une exception.
    """
    cached = _CACHE.get("data")
    at = _CACHE.get("at")
    if cached is not None and at is not None and (_now() - at) < ttl_s:
        return dict(cached)

    fetch = quote_fn
    if fetch is None:
        try:
            from backend.bots.paper import quotes
            fetch = quotes.get_quote
        except Exception:      # noqa: BLE001 — moteur absent
            fetch = None

    data: Dict[str, Any] = {}
    if fetch is not None:
        try:
            quote = fetch(VIX_SYMBOL) or {}
            data = build(quote.get("price"), quote.get("change_pct"))
        except Exception:      # noqa: BLE001 — best-effort strict
            data = {}

    _CACHE["data"] = data
    _CACHE["at"] = _now()
    return dict(data)
