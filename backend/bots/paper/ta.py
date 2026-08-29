"""Analyse technique — PUR (aucun I/O, aucun réseau, aucune dépendance externe).

Ce module existe pour une raison précise : le coach refusait d'entrer en
position faute de « niveau technique fiable pour poser un stop ». Un stop posé
au hasard (« -5 % parce que c'est rond ») n'est pas un stop, c'est une
superstition. Ici on lui donne des niveaux MESURÉS — moyennes mobiles, bornes
du canal 52 semaines, amplitude moyenne réelle (ATR) — sur lesquels un stop
s'appuie et à partir desquels une taille de position se calcule.

**La règle qui prime sur toutes les autres : on ne fabrique jamais un chiffre.**
Toute valeur non calculable vaut ``None``. Jamais ``0.0``, qui prétendrait
qu'on a mesuré quelque chose et se propagerait tel quel dans le prompt du LLM,
puis dans un stop, puis dans une taille de position. Une « moyenne 200 jours »
calculée sur 60 points est un mensonge (doctrine ``quotes._sma``) : elle rend
``None``.

Entrée : les bougies quotidiennes du projet, CHRONOLOGIQUES (plus ancienne en
tête), forme ``{"ts", "open", "high", "low", "close", "volume"}``. Une bougie
peut être à MOITIÉ écrite — ``close`` à ``None`` tant que Yahoo n'a pas
consolidé la séance du jour (piège #67a). Rien ici ne lève là-dessus : ses
extrémités touchées comptent dans le canal, sa clôture absente ne compte pas
comme cours de référence.

Coercition TOLÉRANTE partout, comme le reste du module papier : un booléen
n'est JAMAIS un nombre (``True`` vaut 1 en Python, le laisser passer fausserait
une moyenne en silence), une valeur illisible est ignorée, jamais une
exception.

CONTRAT — clés de ``technical_summary`` (LUES PAR LE PROMPT DU COACH : les
renommer casse le coach en silence, sans test rouge ailleurs) :

    last_close        dernière clôture connue, l'ancre de tous les niveaux
    sma20/50/200      moyennes mobiles simples (``None`` si trop peu de points)
    rsi14             RSI de Wilder 14 périodes, 0-100
    atr14             amplitude vraie moyenne 14 périodes, en devise du titre
    atr14_pct         la même en % du dernier cours — c'est CE chiffre qui
                      permet de dimensionner sans arithmétique (« un stop à
                      2 ATR coûte 2 x atr14_pct % du capital engagé »)
    week52_high/low   bornes du canal sur la fenêtre FOURNIE (donner ~252
                      séances pour que le nom dise vrai)
    pos_in_range_pct  position du cours dans ce canal (0 = sur le plus bas,
                      100 = sur le plus haut)
    change_5d_pct     variation sur 5 séances, en %
    n_sessions        nombre de clôtures réellement exploitées

Arrondis (fixés une fois pour toutes, pour que deux appels identiques rendent
des chiffres identiques) : prix et ATR à 4 décimales, pourcentages à 2, sauf
``pos_in_range_pct`` à 1 (aligné sur ``quotes.build_facts``) — la position dans
un canal se lit « à 64 % », pas « à 63,72 % ».
"""
from typing import Any, Dict, List, Optional, Tuple

RSI_PERIOD = 14
ATR_PERIOD = 14

#: Clés de ``technical_summary``. Exposé pour que l'appelant puisse pinner le
#: contrat sans dupliquer la liste (cf. l'en-tête du module).
SUMMARY_KEYS = (
    "last_close", "sma20", "sma50", "sma200", "rsi14", "atr14", "atr14_pct",
    "week52_high", "week52_low", "pos_in_range_pct", "change_5d_pct",
    "n_sessions",
)


# --------------------------------------------------------------------------- #
# Lecture tolérante
# --------------------------------------------------------------------------- #
def _num(value: Any) -> Optional[float]:
    """Nombre lisible, ou ``None``.

    Un booléen est explicitement rejeté : ``True`` vaut 1 pour Python, et une
    série où un ``True`` s'est glissé rendrait une moyenne fausse sans que rien
    ne le signale.
    """
    if value is None or isinstance(value, bool):
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _field(row: Any, key: str) -> Optional[float]:
    """Champ numérique d'une bougie ; ``None`` si la bougie n'en est pas une."""
    if not isinstance(row, dict):
        return None
    return _num(row.get(key))


def _floats(values: Any) -> List[float]:
    """Série de nombres lisibles extraite d'une liste quelconque.

    Les trous sont ÉCARTÉS, pas comblés (doctrine ``quotes._closes``). Une
    fenêtre de 20 peut donc couvrir 21 séances si l'une n'a pas de clôture :
    c'est le compromis assumé du dépôt — refuser toute la série pour un trou
    unique priverait le coach de ses niveaux bien plus souvent que ça ne le
    tromperait.
    """
    if not isinstance(values, (list, tuple)):
        return []
    out = []  # type: List[float]
    for value in values:
        number = _num(value)
        if number is not None:
            out.append(number)
    return out


def _span(row: Any) -> Tuple[Optional[float], Optional[float], Optional[float]]:
    """(high, low, close) d'une bougie, extrémités manquantes reconstruites.

    Une bougie à moitié écrite n'a parfois ni ``high`` ni ``low`` : on les
    rebâtit depuis les extrémités connues plutôt que de jeter la séance
    (même geste que ``fills._ohlc``).
    """
    first = _field(row, "open")
    high = _field(row, "high")
    low = _field(row, "low")
    close = _field(row, "close")
    known = [v for v in (first, close) if v is not None]
    if high is None and known:
        high = max(known)
    if low is None and known:
        low = min(known)
    return high, low, close


def _window(n: Any) -> Optional[int]:
    """Fenêtre valide : un entier strictement positif, et rien d'autre."""
    if isinstance(n, bool) or not isinstance(n, int) or n <= 0:
        return None
    return n


# --------------------------------------------------------------------------- #
# Moyennes mobiles
# --------------------------------------------------------------------------- #
def sma(closes: Any, n: Any) -> Optional[float]:
    """Moyenne mobile simple sur les ``n`` DERNIÈRES clôtures.

    ``None`` si la série est plus courte que la fenêtre : une moyenne 200
    calculée sur 60 points porterait le nom d'un niveau long terme sans en
    avoir la substance, et c'est exactement le genre de chiffre sur lequel on
    poserait un stop en croyant s'appuyer sur une décennie de marché.
    """
    window = _window(n)
    if window is None:
        return None
    series = _floats(closes)
    if len(series) < window:
        return None
    return round(sum(series[-window:]) / float(window), 4)


# --------------------------------------------------------------------------- #
# RSI (Wilder)
# --------------------------------------------------------------------------- #
def rsi14(closes: Any) -> Optional[float]:
    """RSI de Wilder sur 14 périodes, arrondi à 2 décimales.

    C'est le RSI STANDARD, pas une variante maison : moyenne simple des 14
    premières variations pour amorcer, puis lissage exponentiel de Wilder
    ``(precedent * 13 + courant) / 14``. Un RSI calculé en moyenne simple
    glissante donne des chiffres différents de ceux que Massii lit sur son
    graphique — un indicateur qui contredit l'écran ne sert à rien.

    Il faut donc 15 clôtures pour 14 variations ; en dessous, ``None``.

    Trois cas limites tranchés explicitement :
    - que des hausses (aucune perte) : 100.0
    - que des baisses (aucun gain)   : 0.0
    - série parfaitement plate       : 50.0, car l'absence de mouvement n'est
      ni de la force ni de la faiblesse (la renvoyer à 100 la ferait lire
      comme une surchauffe, ce qui serait faux et dangereux).
    """
    series = _floats(closes)
    if len(series) < RSI_PERIOD + 1:
        return None

    gains = []  # type: List[float]
    losses = []  # type: List[float]
    for i in range(1, len(series)):
        delta = series[i] - series[i - 1]
        gains.append(delta if delta > 0 else 0.0)
        losses.append(-delta if delta < 0 else 0.0)

    avg_gain = sum(gains[:RSI_PERIOD]) / float(RSI_PERIOD)
    avg_loss = sum(losses[:RSI_PERIOD]) / float(RSI_PERIOD)
    for i in range(RSI_PERIOD, len(gains)):
        avg_gain = (avg_gain * (RSI_PERIOD - 1) + gains[i]) / float(RSI_PERIOD)
        avg_loss = (avg_loss * (RSI_PERIOD - 1) + losses[i]) / float(RSI_PERIOD)

    if avg_gain == 0.0 and avg_loss == 0.0:
        return 50.0
    if avg_loss == 0.0:
        return 100.0
    if avg_gain == 0.0:
        return 0.0
    return round(100.0 - 100.0 / (1.0 + avg_gain / avg_loss), 2)


# --------------------------------------------------------------------------- #
# Canal 52 semaines
# --------------------------------------------------------------------------- #
def high_low_52w(candles: Any) -> Dict[str, Optional[float]]:
    """Bornes du canal sur la fenêtre fournie, et position du cours dedans.

    Les bornes viennent des ``high``/``low`` (les prix réellement TOUCHÉS —
    c'est là que les stops des autres ont sauté, donc là où sont les niveaux),
    avec repli sur les clôtures quand la bougie ne les porte pas.

    Le cours de référence est la dernière clôture CONNUE : une bougie du jour
    non consolidée apporte bien ses extrémités au canal, mais son absence de
    clôture ne doit pas faire reculer la mesure sur une séance arbitraire.
    Quand la série n'a aucune clôture du tout, on se rabat sur sa dernière
    ouverture — mieux qu'un ``None`` alors qu'un prix est connu.

    ``pos_pct`` vaut ``None`` si le canal est plat (``high == low``) : la
    division n'a pas de sens, et répondre 50 % serait inventer une position.
    """
    empty = {"high": None, "low": None, "pos_pct": None}  # type: Dict[str, Optional[float]]
    if not isinstance(candles, (list, tuple)):
        return empty

    highs = []  # type: List[float]
    lows = []  # type: List[float]
    last_close = None  # type: Optional[float]
    last_first = None  # type: Optional[float]
    for row in candles:
        high, low, close = _span(row)
        if high is not None:
            highs.append(high)
        if low is not None:
            lows.append(low)
        if close is not None:
            last_close = close
        opening = _field(row, "open")
        if opening is not None:
            last_first = opening

    if not highs or not lows:
        return empty

    top = max(highs)
    bottom = min(lows)
    reference = last_close if last_close is not None else last_first

    pos = None  # type: Optional[float]
    if reference is not None and top > bottom:
        pos = round((reference - bottom) / (top - bottom) * 100.0, 1)

    return {"high": round(top, 4), "low": round(bottom, 4), "pos_pct": pos}


# --------------------------------------------------------------------------- #
# Variation courte
# --------------------------------------------------------------------------- #
def change_5d_pct(closes: Any) -> Optional[float]:
    """Variation en % entre la clôture d'il y a 5 séances et la dernière.

    Il faut 6 points : la référence est ``closes[-6]``, pas ``closes[-5]``
    (cinq séances SÉPARENT ces deux clôtures). ``None`` si la série est plus
    courte, ou si la référence est nulle — une division par zéro renverrait un
    pourcentage infini qui se lirait comme une explosion du titre.
    """
    series = _floats(closes)
    if len(series) < 6:
        return None
    reference = series[-6]
    if reference == 0:
        return None
    return round((series[-1] - reference) / reference * 100.0, 2)


# --------------------------------------------------------------------------- #
# ATR (Wilder) — la matière première d'un stop technique
# --------------------------------------------------------------------------- #
def atr14(candles: Any) -> Optional[float]:
    """Average True Range 14 périodes (Wilder), arrondi à 4 décimales.

    Le « true range » n'est pas l'amplitude de la bougie : c'est le maximum de
    ``high - low``, ``|high - cloture_precedente|`` et ``|low - cloture_precedente|``.
    La différence est tout l'intérêt de l'indicateur — un titre qui a ouvert
    9 points sous sa clôture de la veille a BOUGÉ de 9 points, même si sa
    bougie du jour est étroite. Un stop calibré sur l'amplitude intraday seule
    saute sur le premier gap.

    Il faut 15 bougies exploitables : la première ne sert que de clôture de
    référence, les 14 suivantes fournissent les true ranges. Une bougie dont
    on ne peut tirer ni haut ni bas est écartée (elle n'est pas comblée), donc
    une série de 15 dont une est vide rend ``None``.

    Quand la clôture précédente est inconnue (bougie à moitié écrite au milieu
    de la série), le true range se réduit à ``high - low`` : on perd la
    composante de gap, on ne l'invente pas.
    """
    if not isinstance(candles, (list, tuple)):
        return None

    usable = []  # type: List[Tuple[float, float, Optional[float]]]
    for row in candles:
        high, low, close = _span(row)
        if high is None or low is None:
            continue
        usable.append((high, low, close))

    if len(usable) < ATR_PERIOD + 1:
        return None

    ranges = []  # type: List[float]
    for i in range(1, len(usable)):
        high, low, _close = usable[i]
        previous_close = usable[i - 1][2]
        true_range = high - low
        if previous_close is not None:
            true_range = max(true_range,
                             abs(high - previous_close),
                             abs(low - previous_close))
        ranges.append(true_range)

    value = sum(ranges[:ATR_PERIOD]) / float(ATR_PERIOD)
    for i in range(ATR_PERIOD, len(ranges)):
        value = (value * (ATR_PERIOD - 1) + ranges[i]) / float(ATR_PERIOD)
    return round(value, 4)


# --------------------------------------------------------------------------- #
# Résumé — le dict que lit le prompt du coach
# --------------------------------------------------------------------------- #
def technical_summary(candles: Any) -> Dict[str, Any]:
    """Résumé technique compact d'une série de bougies quotidiennes.

    Toutes les clés de ``SUMMARY_KEYS`` sont TOUJOURS présentes : le prompt
    n'a pas à tester l'existence d'un champ, seulement sa nullité. Une entrée
    vide, nulle ou mal typée rend le dict intégralement à ``None`` — y compris
    ``n_sessions``, car un ``0`` se lirait comme une mesure (« j'ai regardé, il
    n'y a rien ») alors que la vérité est « je n'ai rien pu lire ». C'est le
    seul écart assumé avec ``quotes.build_facts``, qui expose un compteur
    entier parce qu'il travaille sur une série déjà validée.
    """
    empty = dict((key, None) for key in SUMMARY_KEYS)  # type: Dict[str, Any]
    if not isinstance(candles, (list, tuple)):
        return empty

    closes = _floats([row.get("close") for row in candles if isinstance(row, dict)])
    if not closes:
        return empty

    channel = high_low_52w(candles)
    last = closes[-1]
    average_range = atr14(candles)

    range_pct = None  # type: Optional[float]
    if average_range is not None and last:
        range_pct = round(average_range / last * 100.0, 2)

    return {
        "last_close": round(last, 4),
        "sma20": sma(closes, 20),
        "sma50": sma(closes, 50),
        "sma200": sma(closes, 200),
        "rsi14": rsi14(closes),
        "atr14": average_range,
        "atr14_pct": range_pct,
        "week52_high": channel["high"],
        "week52_low": channel["low"],
        "pos_in_range_pct": channel["pos_pct"],
        "change_5d_pct": change_5d_pct(closes),
        "n_sessions": len(closes),
    }
