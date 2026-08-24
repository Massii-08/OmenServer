"""Exécution des ordres contre une bougie — PUR (aucun I/O, aucun réseau).

Une bougie = ``{"open", "high", "low", "close"}`` de la période écoulée (Yahoo,
différé ~15 min). On ne simule pas le carnet d'ordres : on décide seulement SI un
ordre aurait été touché pendant la période, et À QUEL PRIX.

**Règle unique du prix d'exécution** (celle qui enseigne les gaps) :

    si la bougie OUVRE déjà au-delà du seuil, l'ordre part À L'OUVERTURE,
    pas au seuil.

Un stop de vente à 95 sur un titre qui ouvre à 88 après un profit warning
n'exécute pas à 95 : il exécute à 88. C'est exactement ce que le débutant ne
soupçonne pas — un stop n'est pas une assurance, c'est une intention.
La même règle s'applique aux limites, mais le gap y joue en FAVEUR du trader
(une limite d'achat a 100 sur une bougie qui ouvre a 95 est servie a 95).

⚠️ Un ``side``/``kind`` inconnu lève ``ValueError`` : c'est une erreur de
programmation, pas un « pas d'exécution ». ``None`` veut dire, et veut dire
seulement, « l'ordre n'a pas été touché ».
"""
from typing import Any, Dict, Optional, Tuple

ORDER_KINDS = frozenset({"market", "limit", "stop"})
ORDER_SIDES = frozenset({"buy", "sell", "short", "cover"})
POSITION_SIDES = frozenset({"long", "short"})

# Sens de l'exposition visée par l'ordre.
_BUY_SIDES = frozenset({"buy", "cover"})     # on ACHÈTE (ouverture longue / rachat de short)
_SELL_SIDES = frozenset({"sell", "short"})   # on VEND (clôture longue / ouverture short)


def _num(source: Optional[Dict[str, Any]], key: str) -> Optional[float]:
    """Lit un nombre d'un dict ; ``None`` si absent, nul ou illisible."""
    if not source:
        return None
    value = source.get(key)
    if value is None or isinstance(value, bool):
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _ohlc(candle: Optional[Dict[str, Any]]) -> Tuple[Optional[float], Optional[float],
                                                     Optional[float], Optional[float]]:
    """Extrait (open, high, low, close) en comblant high/low manquants.

    Yahoo peut livrer une bougie à moitié écrite (clôture pas encore consolidée,
    cf. piège #67a). On reconstruit high/low à partir des extrémités connues
    plutôt que de refuser d'exécuter.
    """
    o = _num(candle, "open")
    h = _num(candle, "high")
    l = _num(candle, "low")
    c = _num(candle, "close")
    known = [v for v in (o, c) if v is not None]
    if h is None and known:
        h = max(known)
    if l is None and known:
        l = min(known)
    return o, h, l, c


def _fill_price(trigger: float, open_price: Optional[float], upward: bool) -> float:
    """Prix d'exécution une fois le seuil touché.

    ``upward`` = le seuil se franchit par le HAUT (il faut ``high >= trigger``).
    Si l'ouverture est déjà au-delà, c'est elle qui sert de prix.
    """
    if open_price is None:
        return trigger
    return max(trigger, open_price) if upward else min(trigger, open_price)


def try_fill(order_dict: Dict[str, Any], candle: Dict[str, Any]) -> Optional[float]:
    """Prix auquel l'ordre aurait été exécuté pendant cette bougie, ou ``None``.

    - ``market``  : à la clôture de la bougie (repli sur l'ouverture si Yahoo n'a
      pas encore consolidé la clôture).
    - ``limit``   : achat/rachat touché si ``low <= limit`` ; vente/short touché
      si ``high >= limit``.
    - ``stop``    : achat/rachat touché si ``high >= stop`` ; vente/short touché
      si ``low <= stop`` (stop de protection ou entrée sur cassure).

    Dans les deux derniers cas, le prix est celui du seuil SAUF si la bougie a
    ouvert au-delà — alors c'est l'ouverture (voir l'en-tête du module).
    """
    order_dict = order_dict or {}
    kind = str(order_dict.get("kind") or "").strip().lower()
    side = str(order_dict.get("side") or "").strip().lower()
    if kind not in ORDER_KINDS:
        raise ValueError("kind d'ordre inconnu: %r" % (order_dict.get("kind"),))
    if side not in ORDER_SIDES:
        raise ValueError("side d'ordre inconnu: %r" % (order_dict.get("side"),))

    o, h, l, c = _ohlc(candle)

    if kind == "market":
        return c if c is not None else o

    trigger = _num(order_dict, "limit_price" if kind == "limit" else "stop_price")
    if trigger is None:
        return None

    # limit vente/short et stop achat/rachat se déclenchent par le HAUT.
    upward = (kind == "limit" and side in _SELL_SIDES) or (kind == "stop" and side in _BUY_SIDES)

    if upward:
        if h is None or h < trigger:
            return None
    else:
        if l is None or l > trigger:
            return None
    return _fill_price(trigger, o, upward)


def check_protective_stops(position_dict: Dict[str, Any],
                           stop_loss: Optional[float],
                           candle: Dict[str, Any]) -> Optional[float]:
    """Prix de sortie si le stop de protection d'une position ouverte a sauté.

    - position ``long``  : déclenché si ``low <= stop`` → ``min(stop, open)``
    - position ``short`` : déclenché si ``high >= stop`` → ``max(stop, open)``

    ``None`` si aucun stop n'est posé (cas fréquent — et c'est précisément ce que
    le biais ``no_stop`` du coach traque) ou si le stop n'a pas été touché.
    """
    position_dict = position_dict or {}
    side = str(position_dict.get("side") or "long").strip().lower()
    if side not in POSITION_SIDES:
        raise ValueError("side de position inconnu: %r" % (position_dict.get("side"),))

    if stop_loss is None or isinstance(stop_loss, bool):
        return None
    try:
        stop = float(stop_loss)
    except (TypeError, ValueError):
        return None

    o, h, l, _c = _ohlc(candle)

    if side == "long":
        if l is None or l > stop:
            return None
        return _fill_price(stop, o, upward=False)
    if h is None or h < stop:
        return None
    return _fill_price(stop, o, upward=True)
