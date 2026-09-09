"""Le volet BITCOIN du coach — funding, intérêt ouvert, DVOL, Fear & Greed,
prime Coinbase, gap CME, agenda calculé et deux facteurs de convergence.

Ce que ce module apporte au panneau TradingView, en une phrase : **le contexte
que le prix ne dit pas**. Un scalp de trois minutes sur BTC se joue au milieu
d'un funding qui se règle toutes les huit heures, d'un intérêt ouvert qui
gonfle sans que le prix bouge, d'une expiration d'options le vendredi matin et
d'un trou laissé par le future CME le week-end. Aucune de ces choses n'est
visible sur une bougie ; toutes changent la lecture qu'on en fait.

Six sources publiques, **toutes sondées le 09/09 et toutes 200 SANS CLÉ** depuis
l'Omen (cf. spec §3) — c'est la raison pour laquelle elles ont été retenues
plutôt que des sources « meilleures » mais payantes ou bloquées (Glassnode,
Farside en 403 Cloudflare, Polymarket en DNS suisse) :

==============================  ==========================================
Binance ``premiumIndex``        prix de marque, indice, funding, prochain
                                règlement
Binance ``openInterest``        intérêt ouvert du perpétuel
Deribit ``get_volatility_...``  DVOL (volatilité implicite BTC) — le « VIX »
                                du bitcoin, lu comme le chip de ``mood.py``
Deribit ``get_index_price``     indice BTC de référence des options
alternative.me ``fng``          Fear & Greed (0-100 + étiquette)
Coinbase ``prices/BTC-USD``     spot US, d'où la PRIME Coinbase
==============================  ==========================================

**Doctrine tenue partout, sans exception :**

* **panne isolée** — chaque source est appelée dans son propre ``try`` ;
  une source morte met son champ à ``None`` et son nom dans ``degraded``, et
  n'emporte jamais les cinq autres. :func:`snapshot` ne lève JAMAIS ;
* **champ inconnu = ``None``, jamais une valeur inventée** (même règle que
  ``mood.build`` : pas de mood sans VIX) ;
* **on mesure que le champ VARIE avant d'en dériver une métrique** — un
  ``openInterest`` bit-à-bit identique sur vingt-quatre heures n'est pas un
  marché immobile, c'est un champ GELÉ ; ``oi_24h_pct`` vaut alors ``None`` et
  non ``0``, parce que 0 % serait une mesure qu'on n'a pas faite ;
* **tout est injectable** (``client``, ``state``, ``now``, ``candles_fn``) :
  les tests tournent 100 % hors ligne et à horloge figée ;
* **les probabilités d'options ne sont PAS un facteur.** Le consensus Deribit
  reste hors de ce module : la leçon Oracle (w* = −2,14) dit qu'on peut
  l'AFFICHER, jamais en faire un pari. Ce qui entre ici est déterministe et
  mesurable, rien d'autre.

**Horodatages : UTC NAÏF**, comme partout dans ``paper/`` (``_naive`` de
``calendar.py`` et ``convergence.py``). Python 3.9 ne sait pas relire un
suffixe « Z » ; on convertit en UTC puis on retire le fuseau, et les noms de
champs disent l'UTC (``next_funding_utc``, ``time_utc``).
"""
import json
from collections import deque
from datetime import date as _date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Callable, Deque, Dict, List, Optional, Tuple

from backend.bots.paper import store

# --------------------------------------------------------------------------- #
# Sources — URL EXACTES vérifiées 200 sans clé le 09/09 (spec §3)
# --------------------------------------------------------------------------- #
BINANCE_PREMIUM_URL = "https://fapi.binance.com/fapi/v1/premiumIndex?symbol=BTCUSDT"
BINANCE_OI_URL = "https://fapi.binance.com/fapi/v1/openInterest?symbol=BTCUSDT"
DERIBIT_DVOL_URL = ("https://www.deribit.com/api/v2/public/"
                    "get_volatility_index_data?currency=BTC&resolution=3600"
                    "&start_timestamp=%d&end_timestamp=%d")
DERIBIT_INDEX_URL = ("https://www.deribit.com/api/v2/public/get_index_price"
                     "?index_name=btc_usd")
FNG_URL = "https://api.alternative.me/fng/?limit=2"
COINBASE_SPOT_URL = "https://api.coinbase.com/v2/prices/BTC-USD/spot"

# Un User-Agent qui DIT qui appelle. Les six sources répondent 200 avec ;
# certaines répondent 403 à un client anonyme (mesuré le 09/09).
USER_AGENT = "Mozilla/5.0 (OmenServer coach)"
HEADERS = {"User-Agent": USER_AGENT, "Accept": "application/json"}
TIMEOUT_S = 10.0

# Le symbole Yahoo du future CME BTC (le gap du week-end) et le symbole
# canonique porté par les items de convergence.
CME_SYMBOL = "BTC=F"
CME_RANGE = "1mo"
CME_INTERVAL = "1d"
BTC_SYMBOL = "BTC-USD"

# --------------------------------------------------------------------------- #
# Budgets de requêtes (spec §9) — bornés PAR HÔTE
#
# Binance 30/min, Deribit 10/min. Avec le cache de 60 s, une photo consomme au
# pire 2 + 2 requêtes par minute : le budget n'est pas une optimisation, c'est
# le garde-fou du jour où un appelant boucle. Budget épuisé -> la source est
# traitée exactement comme une source morte (``None`` + ``degraded``), jamais
# martelée.
# --------------------------------------------------------------------------- #
BINANCE_BUDGET_PER_MIN = 30
DERIBIT_BUDGET_PER_MIN = 10
BUDGET_WINDOW_S = 60.0

# --------------------------------------------------------------------------- #
# Caches. Deux vitesses, parce que les sources n'ont pas le même RYTHME :
# funding, intérêt ouvert et spot bougent à la seconde (60 s) ; le Fear & Greed
# est publié UNE FOIS PAR JOUR et le DVOL est une bougie horaire — les
# re-sonder toutes les minutes serait du bruit payé au prix d'une requête.
# --------------------------------------------------------------------------- #
CACHE_TTL_S = 60.0
SLOW_CACHE_TTL_S = 3600.0

# --------------------------------------------------------------------------- #
# Historiques et fenêtres de mesure
# --------------------------------------------------------------------------- #
HISTORY_H = 48                  # fenêtre glissante des séries (spec : 48 h)
REF_TARGET_H = 24.0             # la référence « 24 h » qu'on cherche
REF_MIN_H = 12.0                # sous 12 h, appeler ça « 24 h » serait mentir
REF_MAX_H = 36.0                # au-delà, ce n'est plus la même journée
FUNDING_HISTORY_MAX = 12        # quatre jours de règlements (3 par jour)
FUNDING_INTERVAL_H = 8          # le perpétuel Binance règle toutes les 8 h

# --------------------------------------------------------------------------- #
# Seuils des deux facteurs (spec §9.2) — DÉTERMINISTES, aucun réglage caché
# --------------------------------------------------------------------------- #
FUNDING_EXTREME_PCT = 0.05      # |funding| >= 0,05 % par 8 h...
FUNDING_EXTREME_COUNT = 2       # ...sur deux règlements CONSÉCUTIFS
FUNDING_FRESH_H = 24.0          # au-delà, l'historique est PÉRIMÉ, pas un signal
OI_BUILDUP_PCT = 10.0           # intérêt ouvert +10 % en 24 h...
PRICE_FLAT_PCT = 1.0            # ...avec un prix qui n'a pas bougé de 1 %

FACTOR_FUNDING = "funding_extreme"
FACTOR_OI = "oi_buildup"

# --------------------------------------------------------------------------- #
# État persisté
#
# ⚠️ Le POINT dans le RADICAL n'est pas cosmétique (même piège que
# ``agenda.cache.json``) : les fichiers de ``data/paper_trading/`` sont recensés
# comme des COMPTES par ``radar._users_with_portfolio`` (regex
# ``^[A-Za-z0-9_-]+\.json$``). Un ``btc.json`` deviendrait un utilisateur
# fantôme nommé « btc », à qui la convergence écrirait un carnet. Un radical qui
# porte un point ne peut PAS matcher : c'est structurel, ça ne s'oublie pas.
# --------------------------------------------------------------------------- #
STATE_NAME = "btc.state.json"


class BtcError(Exception):
    """Une source n'a pas répondu (statut >= 400, transport, budget épuisé).

    Interne au module : elle ne sort JAMAIS de :func:`snapshot`, elle s'y
    convertit en ``None`` + une ligne dans ``degraded``.
    """


# --------------------------------------------------------------------------- #
# Client HTTP (paresseux, injectable) et budgets — patron de ``whales.py``
# --------------------------------------------------------------------------- #
_client = None


def get_client():
    """Client httpx partagé du module (créé à la première demande)."""
    global _client
    if _client is None:
        import httpx
        _client = httpx.Client(timeout=TIMEOUT_S, headers=dict(HEADERS),
                               follow_redirects=True)
    return _client


def set_client(client) -> None:
    """Remplace le client module (tests, ou client partagé maison)."""
    global _client
    _client = client


class _Budget(object):
    """Fenêtre glissante de ``limit`` requêtes sur ``window_s`` secondes.

    L'horloge est PASSÉE à chaque appel (et non lue ici) : la même horloge
    injectée sert le cache, les fenêtres de 24 h et le budget, donc un test à
    horloge figée mesure exactement ce que la prod mesure.
    """

    def __init__(self, limit: int, window_s: float = BUDGET_WINDOW_S) -> None:
        self.limit = int(limit)
        self.window_s = float(window_s)
        self._calls: Deque[float] = deque()

    def take(self, at_s: float) -> bool:
        """Consomme un jeton. ``False`` si le budget est épuisé (rien n'est
        consommé dans ce cas : on ne pénalise pas la minute suivante)."""
        while self._calls and (at_s - self._calls[0]) >= self.window_s:
            self._calls.popleft()
        if len(self._calls) >= self.limit:
            return False
        self._calls.append(at_s)
        return True

    def clear(self) -> None:
        self._calls.clear()


_BINANCE_BUDGET = _Budget(BINANCE_BUDGET_PER_MIN)
_DERIBIT_BUDGET = _Budget(DERIBIT_BUDGET_PER_MIN)


def reset_budgets() -> None:
    """Vide les budgets (tests, ou reprise après un incident)."""
    _BINANCE_BUDGET.clear()
    _DERIBIT_BUDGET.clear()


# --------------------------------------------------------------------------- #
# PUR — temps, nombres, tolérance
# --------------------------------------------------------------------------- #

_EPOCH = datetime(1970, 1, 1)


def _naive(moment: datetime) -> datetime:
    """UTC sans fuseau — la forme d'horodatage du paquet ``paper/``."""
    if moment.tzinfo is None:
        return moment
    return moment.astimezone(timezone.utc).replace(tzinfo=None)


def _epoch_s(moment: datetime) -> float:
    """Secondes epoch d'un instant UTC NAÏF.

    ⚠️ Surtout pas ``time.mktime`` : il interprète un ``timetuple`` en heure
    LOCALE, donc l'URL DVOL demanderait une fenêtre décalée du fuseau de la
    machine — deux serveurs rendraient deux photos différentes.
    """
    return (_naive(moment) - _EPOCH).total_seconds()


def _as_dt(value: Any) -> datetime:
    """L'instant de référence : ``None`` -> maintenant (UTC naïf)."""
    if isinstance(value, datetime):
        return _naive(value)
    parsed = _parse_iso(value)
    if parsed is not None:
        return parsed
    return _naive(datetime.now(timezone.utc))


def _parse_iso(value: Any) -> Optional[datetime]:
    """ISO -> datetime UTC naïf, ou ``None``. Le suffixe ``Z`` est retiré :
    Python 3.9 ne sait pas le lire (même correctif que ``paper_router``)."""
    if isinstance(value, datetime):
        return _naive(value)
    if not isinstance(value, str):
        return None
    text = value.strip()
    if not text:
        return None
    if text.endswith("Z"):
        text = text[:-1]
    try:
        return _naive(datetime.fromisoformat(text))
    except ValueError:
        return None


def _iso(moment: Optional[datetime]) -> Optional[str]:
    """Horodatage à la SECONDE (les microsecondes d'une API ne disent rien)."""
    if moment is None:
        return None
    return _naive(moment).replace(microsecond=0).isoformat()


def _from_ms(value: Any) -> Optional[datetime]:
    """Millisecondes epoch -> datetime UTC naïf (Binance, Deribit)."""
    number = _num(value)
    if number is None:
        return None
    try:
        return _naive(datetime.fromtimestamp(number / 1000.0, tz=timezone.utc))
    except (OverflowError, OSError, ValueError):
        return None


def _from_s(value: Any) -> Optional[datetime]:
    """Secondes epoch -> datetime UTC naïf (alternative.me, bougies Yahoo)."""
    number = _num(value)
    if number is None:
        return None
    try:
        return _naive(datetime.fromtimestamp(number, tz=timezone.utc))
    except (OverflowError, OSError, ValueError):
        return None


def _num(value: Any) -> Optional[float]:
    """Nombre exploitable, ou ``None``. Les API rendent leurs décimaux en
    CHAÎNE (``"78766.50000000"``) : on convertit, on ne suppose pas."""
    if isinstance(value, bool) or value is None:
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    if number != number or number in (float("inf"), float("-inf")):
        return None                      # NaN / infini : pas une mesure
    return number


def _dict(value: Any) -> Dict[str, Any]:
    return value if isinstance(value, dict) else {}


def _pct_txt(value: Optional[float], decimals: int = 3) -> str:
    """Un pourcentage écrit en FRANÇAIS (virgule décimale), signe compris."""
    if value is None:
        return "?"
    return ("%+.*f" % (decimals, value)).replace(".", ",") + " %"


# --------------------------------------------------------------------------- #
# PUR — les six parseurs
#
# Tous rendent une forme COMPLÈTE avec des ``None`` : une forme à géométrie
# variable obligerait chaque appelant à se souvenir de quels champs existent
# quand la source a répondu à moitié (piège #61 du dépôt).
# --------------------------------------------------------------------------- #

def parse_premium(payload: Any) -> Dict[str, Any]:
    """Binance ``premiumIndex`` -> prix de marque, indice, funding, échéances.

    ⚠️ ``lastFundingRate`` est une FRACTION (``0.00006335``), pas un
    pourcentage : le champ public ``funding_pct`` vaut donc ×100.

    ``settled_at`` est l'identité du règlement DÉJÀ passé que porte
    ``lastFundingRate`` : le perpétuel règle toutes les huit heures, donc c'est
    ``nextFundingTime`` moins huit heures. C'est de cette clé que sort la
    déduplication de l'historique — sans elle, chaque photo de la minute
    réinscrirait le même règlement.
    """
    data = _dict(payload)
    rate = _num(data.get("lastFundingRate"))
    next_dt = _from_ms(data.get("nextFundingTime"))
    settled = next_dt - timedelta(hours=FUNDING_INTERVAL_H) if next_dt else None
    return {
        "mark": _num(data.get("markPrice")),
        "index": _num(data.get("indexPrice")),
        "funding_pct": round(rate * 100.0, 6) if rate is not None else None,
        "next_funding_utc": _iso(next_dt),
        "settled_at": _iso(settled),
    }


def parse_oi(payload: Any) -> Dict[str, Any]:
    """Binance ``openInterest`` -> ``{oi, ts}`` (contrats BTC du perpétuel)."""
    data = _dict(payload)
    return {"oi": _num(data.get("openInterest")),
            "ts": _iso(_from_ms(data.get("time")))}


def parse_dvol(payload: Any) -> Dict[str, Any]:
    """Deribit ``get_volatility_index_data`` -> ``{dvol, ts}``.

    ``result.data`` est une liste de bougies ``[ts_ms, open, high, low, close]``.
    Le DVOL du moment est le **close** de la dernière : prendre l'ouverture
    donnerait la valeur d'il y a une heure sans que rien ne le signale.
    """
    rows = _dict(_dict(payload).get("result")).get("data")
    if not isinstance(rows, list):
        return {"dvol": None, "ts": None}
    for row in reversed(rows):
        if not isinstance(row, (list, tuple)) or len(row) < 5:
            continue
        close = _num(row[4])
        if close is None:
            continue
        return {"dvol": close, "ts": _iso(_from_ms(row[0]))}
    return {"dvol": None, "ts": None}


def parse_deribit_index(payload: Any) -> Optional[float]:
    """Deribit ``get_index_price`` -> l'indice BTC, ou ``None``."""
    return _num(_dict(_dict(payload).get("result")).get("index_price"))


def parse_fng(payload: Any) -> Dict[str, Any]:
    """alternative.me ``fng`` -> ``{value, label, ts}`` (0-100 + étiquette).

    L'étiquette (``Fear``, ``Greed``…) vient de la source et se recopie TELLE
    QUELLE : la reclasser nous-mêmes ajouterait un seuil de plus à entretenir
    pour rien.
    """
    rows = _dict(payload).get("data")
    row = _dict(rows[0]) if isinstance(rows, list) and rows else {}
    value = _num(row.get("value"))
    label = row.get("value_classification")
    return {
        "value": int(value) if value is not None else None,
        "label": str(label) if isinstance(label, str) and label else None,
        "ts": _iso(_from_s(row.get("timestamp"))),
    }


def parse_coinbase(payload: Any) -> Optional[float]:
    """Coinbase ``prices/BTC-USD/spot`` -> le spot US, ou ``None``."""
    return _num(_dict(_dict(payload).get("data")).get("amount"))


# --------------------------------------------------------------------------- #
# PUR — le gap CME
# --------------------------------------------------------------------------- #

def cme_gap(candles_btc_f: Any, spot: Any,
            now: Any = None) -> Optional[Dict[str, Any]]:
    """Le trou laissé par le future CME du week-end (PUR).

    Le future ``BTC=F`` ferme le vendredi soir et rouvre le dimanche ; le spot,
    lui, ne dort pas. Le prix du week-end s'écarte donc de la dernière clôture
    du future, et ce **niveau** attire souvent le prix à la réouverture. La
    seule chose qu'on affirme ici : où est le niveau, et a-t-il été retraversé.

    ``candles_btc_f`` = bougies JOURNALIÈRES Yahoo (``quotes.get_candles``,
    forme ``{ts, open, high, low, close}``). ``level`` = clôture de la dernière
    bougie de VENDREDI antérieure à ``now``. Le gap est ``open`` tant que le
    prix n'est pas repassé par ce niveau depuis :

    1. une bougie postérieure dont la mèche COUVRE le niveau l'a comblé ;
    2. à défaut, si le spot est passé de l'autre côté du niveau par rapport au
       premier prix connu après la clôture, il a forcément traversé.

    ``None`` (et jamais une supposition) quand il n'y a pas de vendredi lisible
    dans la fenêtre, ou quand le spot est inconnu : sans prix courant, dire
    « ouvert » serait inventer la moitié de la réponse.
    """
    moment = _as_dt(now)
    rows = _clean_candles(candles_btc_f, moment)
    friday_at = None
    level = None
    for index, (day, candle) in enumerate(rows):
        if day.weekday() == 4 and _num(candle.get("close")) is not None:
            friday_at = index
            level = _num(candle.get("close"))
    if friday_at is None or level is None:
        return None

    spot_value = _num(spot)
    if spot_value is None:
        return None

    after = [candle for _, candle in rows[friday_at + 1:]]
    for candle in after:
        low = _num(candle.get("low"))
        high = _num(candle.get("high"))
        if low is not None and high is not None and low <= level <= high:
            return {"level": level, "open": False}

    first_after = None
    for candle in after:
        first_after = _num(candle.get("open"))
        if first_after is None:
            first_after = _num(candle.get("close"))
        if first_after is not None:
            break
    if first_after is None:
        first_after = spot_value
    if (first_after - level) * (spot_value - level) <= 0:
        return {"level": level, "open": False}
    return {"level": level, "open": True}


def _clean_candles(candles: Any,
                   now: datetime) -> List[Tuple[datetime, Dict[str, Any]]]:
    """Bougies datées et chronologiques, jamais POSTÉRIEURES à ``now``.

    Une bougie du futur (séance en cours mal datée, fixture recopiée) déciderait
    sinon qu'un gap est comblé avant l'heure.
    """
    if not isinstance(candles, list):
        return []
    rows: List[Tuple[datetime, Dict[str, Any]]] = []
    for candle in candles:
        if not isinstance(candle, dict):
            continue
        day = _from_s(candle.get("ts"))
        if day is None or day > now:
            continue
        rows.append((day, candle))
    rows.sort(key=lambda row: row[0])
    return rows


# --------------------------------------------------------------------------- #
# PUR — l'agenda crypto, entièrement CALCULÉ
# --------------------------------------------------------------------------- #

FUNDING_HOURS_UTC = (0, 8, 16)
DERIBIT_EXPIRY_HOUR_UTC = 8
CME_CLOSE_HOUR_UTC = 21
CME_REOPEN_HOUR_UTC = 22
US_OPEN_UTC = (13, 30)

LABEL_FUNDING = "Règlement du funding BTC (perpétuel)"
LABEL_EXPIRY_WEEKLY = "Expiration hebdomadaire des options BTC (Deribit)"
LABEL_EXPIRY_MONTHLY = "Expiration mensuelle des options BTC (Deribit)"
LABEL_CME_CLOSE = "Fermeture hebdomadaire du future CME BTC"
LABEL_CME_REOPEN = "Réouverture du future CME BTC"
LABEL_US_OPEN = "Ouverture de la séance américaine"


def crypto_agenda(now: Any = None, days: int = 7) -> List[Dict[str, Any]]:
    """Les rendez-vous crypto des ``days`` prochains jours (PUR).

    **Tout est calculé, rien n'est inventé et rien n'est recopié d'une liste** :
    ces rendez-vous sont des règles de marché fixes, pas des annonces. C'est
    exactement l'inverse de ``tvcalendar`` (dont chaque date vient du champ
    ``date`` de l'API) — ici, une date écrite à la main serait une date fausse
    dès le mois suivant.

    Les cinq règles, toutes en UTC :

    * **funding** à 00:00, 08:00 et 16:00 — l'intervalle de huit heures du
      perpétuel Binance ;
    * **expiration Deribit** le vendredi à 08:00. Le DERNIER vendredi du mois
      porte l'expiration MENSUELLE (la grosse : c'est elle qui déplace le
      marché), et elle REMPLACE l'hebdomadaire de ce vendredi-là plutôt que de
      s'y ajouter ;
    * **CME** : fermeture le vendredi à 21:00, réouverture le dimanche à
      22:00 — les deux bornes du trou du week-end (cf. :func:`cme_gap`) ;
    * **ouverture américaine** à 13:30, les jours ouvrés seulement.

    Entrées ``{date, time_utc, kind: "crypto", label}``, triées, sans doublon,
    STRICTEMENT postérieures à ``now`` et dans la fenêtre. ``days <= 0`` -> ``[]``.
    """
    start = _as_dt(now)
    try:
        horizon = int(days)
    except (TypeError, ValueError):
        horizon = 0
    if horizon <= 0:
        return []
    end = start + timedelta(days=horizon)

    out: List[Dict[str, Any]] = []
    seen = set()
    day = start.date()
    last_day = end.date()
    while day <= last_day:
        for moment, label in _day_events(day):
            if moment <= start or moment > end:
                continue
            key = (moment, label)
            if key in seen:
                continue
            seen.add(key)
            out.append({"date": moment.strftime("%Y-%m-%d"),
                        "time_utc": moment.strftime("%H:%M"),
                        "kind": "crypto",
                        "label": label})
        day = day + timedelta(days=1)
    out.sort(key=lambda entry: (entry["date"], entry["time_utc"],
                                entry["label"]))
    return out


def _day_events(day: _date) -> List[Tuple[datetime, str]]:
    """Les rendez-vous d'UNE journée (PUR) — le cœur calculé de l'agenda."""
    events: List[Tuple[datetime, str]] = []
    for hour in FUNDING_HOURS_UTC:
        events.append((datetime(day.year, day.month, day.day, hour, 0),
                       LABEL_FUNDING))
    weekday = day.weekday()
    if weekday == 4:                                     # vendredi
        expiry = (LABEL_EXPIRY_MONTHLY if is_last_friday(day)
                  else LABEL_EXPIRY_WEEKLY)
        events.append((datetime(day.year, day.month, day.day,
                                DERIBIT_EXPIRY_HOUR_UTC, 0), expiry))
        events.append((datetime(day.year, day.month, day.day,
                                CME_CLOSE_HOUR_UTC, 0), LABEL_CME_CLOSE))
    if weekday == 6:                                     # dimanche
        events.append((datetime(day.year, day.month, day.day,
                                CME_REOPEN_HOUR_UTC, 0), LABEL_CME_REOPEN))
    if weekday <= 4:                                     # lundi -> vendredi
        events.append((datetime(day.year, day.month, day.day,
                                US_OPEN_UTC[0], US_OPEN_UTC[1]), LABEL_US_OPEN))
    return events


def is_last_friday(day: _date) -> bool:
    """``day`` est-il le DERNIER vendredi de son mois ? (PUR)

    Calculé, pas tabulé : ajouter sept jours doit changer de mois.
    """
    if day.weekday() != 4:
        return False
    return (day + timedelta(days=7)).month != day.month


# --------------------------------------------------------------------------- #
# PUR — séries, références et pourcentages sur 24 h
# --------------------------------------------------------------------------- #

def _series(history: Any, now: datetime) -> List[Tuple[datetime, float]]:
    """Une série ``[[ts, valeur], …]`` relue, nettoyée, triée, bornée à 48 h."""
    if not isinstance(history, list):
        return []
    floor = now - timedelta(hours=HISTORY_H)
    rows: List[Tuple[datetime, float]] = []
    for row in history:
        if not isinstance(row, (list, tuple)) or len(row) < 2:
            continue
        moment = _parse_iso(row[0])
        value = _num(row[1])
        if moment is None or value is None:
            continue
        if moment < floor or moment > now:
            continue
        rows.append((moment, value))
    rows.sort(key=lambda item: item[0])
    return rows


def _push(history: Any, now: datetime, value: Optional[float]) -> List[List[Any]]:
    """Ajoute un point à une série et fait GLISSER la fenêtre de 48 h."""
    rows = _series(history, now)
    if value is not None:
        rows = [row for row in rows if row[0] != now]
        rows.append((now, value))
        rows.sort(key=lambda item: item[0])
    return [[_iso(moment), value] for moment, value in rows]


def pct_24h(history: Any, now: Any = None) -> Optional[float]:
    """Variation sur ~24 h d'une série ``[[ts, valeur], …]`` (PUR).

    Deux garde-fous, et ce sont eux qui font la valeur de cette fonction :

    * **la référence doit avoir le bon ÂGE** — entre 12 h et 36 h, la plus
      proche de 24 h. Un point de deux heures rendrait un « +10 % en 24 h »
      qui n'a pas été mesuré sur vingt-quatre heures ;
    * **le champ doit VARIER** — si toutes les valeurs de la fenêtre sont
      identiques au bit près, la source est GELÉE (réponse cachée, endpoint
      mort) et non le marché immobile. On rend ``None`` et non ``0`` : 0 %
      serait une mesure qu'on n'a pas faite.
    """
    moment = _as_dt(now)
    rows = _series(history, moment)
    if len(rows) < 2:
        return None
    if len(set(round(value, 9) for _, value in rows)) < 2:
        return None
    last_value = rows[-1][1]
    reference = _reference(rows[:-1], moment)
    if reference is None or not reference[1]:
        return None
    return round((last_value - reference[1]) / reference[1] * 100.0, 2)


def _reference(rows: List[Tuple[datetime, float]],
               now: datetime) -> Optional[Tuple[datetime, float]]:
    """Le point de la série dont l'âge est le plus proche de 24 h, dans la
    fourchette ``[REF_MIN_H, REF_MAX_H]``. Aucun candidat -> ``None``."""
    best = None
    best_gap = None
    for moment, value in rows:
        age_h = (now - moment).total_seconds() / 3600.0
        if age_h < REF_MIN_H or age_h > REF_MAX_H:
            continue
        gap = abs(age_h - REF_TARGET_H)
        if best_gap is None or gap < best_gap:
            best, best_gap = (moment, value), gap
    return best


# --------------------------------------------------------------------------- #
# PUR — les deux facteurs de convergence (spec §9.2)
# --------------------------------------------------------------------------- #

def factors(state: Any, now: Any = None) -> Dict[str, List[Dict[str, Any]]]:
    """Les deux facteurs BTC et les items qui les portent (PUR).

    * ``funding_extreme`` — ``|funding| >= 0,05 %`` sur DEUX règlements
      consécutifs. Un seul règlement extrême, c'est un pic ; deux d'affilée,
      c'est un positionnement qui paie pour rester en place ;
    * ``oi_buildup`` — intérêt ouvert ``+10 %`` en 24 h avec un prix qui n'a
      pas bougé de 1 %. De la position qui s'accumule sans que le prix aille
      nulle part : quelqu'un se prépare, et la sortie sera brutale.

    Les items portent des ids **DISJOINTS** (``btc:funding:<ts>`` et
    ``btc:oi:<jour>``) : c'est ce qui permet à ``convergence.independent_factors``
    de compter deux signaux et non deux étiquettes sur la même matière.

    Ne lève JAMAIS : un état absent, tronqué ou corrompu rend deux listes vides.
    """
    moment = _as_dt(now)
    data = _dict(state)
    return {
        FACTOR_FUNDING: _funding_items(data.get("funding_history"), moment),
        FACTOR_OI: _oi_items(data, moment),
    }


def _funding_items(history: Any, now: datetime) -> List[Dict[str, Any]]:
    """``funding_extreme`` : deux règlements consécutifs au-dessus du seuil."""
    if not isinstance(history, list):
        return []
    rows = []
    for row in history:
        if not isinstance(row, dict):
            continue
        moment = _parse_iso(row.get("ts"))
        value = _num(row.get("funding_pct"))
        if moment is None or value is None:
            continue
        rows.append((moment, value))
    rows.sort(key=lambda item: item[0])
    if len(rows) < FUNDING_EXTREME_COUNT:
        return []

    last = rows[-FUNDING_EXTREME_COUNT:]
    # Un historique PÉRIMÉ (état recopié d'une autre machine, guetteur arrêté
    # trois jours) ne doit pas ressortir le funding de la semaine dernière
    # comme s'il était d'aujourd'hui — même leçon que le cache d'agenda qui
    # ressortait la réunion de la veille comme « à venir ».
    if (now - last[-1][0]).total_seconds() / 3600.0 > FUNDING_FRESH_H:
        return []
    if any(abs(value) < FUNDING_EXTREME_PCT for _, value in last):
        return []

    text = ("Funding BTC extrême : %s puis %s sur deux règlements consécutifs"
            % (_pct_txt(last[0][1]), _pct_txt(last[-1][1])))
    return [{"id": "btc:funding:%s" % _iso(last[-1][0]),
             "kind": FACTOR_FUNDING, "text": text}]


def _oi_items(state: Dict[str, Any], now: datetime) -> List[Dict[str, Any]]:
    """``oi_buildup`` : l'intérêt ouvert gonfle, le prix ne bouge pas."""
    oi_pct = pct_24h(state.get("oi_history"), now)
    price_pct = pct_24h(state.get("price_history"), now)
    if oi_pct is None or price_pct is None:
        return []
    if oi_pct < OI_BUILDUP_PCT or abs(price_pct) >= PRICE_FLAT_PCT:
        return []
    text = ("Intérêt ouvert BTC %s en 24 h alors que le prix n'a pas bougé (%s)"
            % (_pct_txt(oi_pct, 1), _pct_txt(price_pct, 2)))
    return [{"id": "btc:oi:%s" % now.strftime("%Y-%m-%d"),
             "kind": FACTOR_OI, "text": text}]


# --------------------------------------------------------------------------- #
# État persisté — lecture tolérante, écriture ATOMIQUE 0o600
# --------------------------------------------------------------------------- #

def state_path() -> Path:
    """Chemin du fichier d'état. ``store.DATA_DIR`` est lu à CHAQUE appel :
    les tests le redirigent vers un ``tmp_path``."""
    return Path(store.DATA_DIR) / STATE_NAME


def load_state() -> Dict[str, Any]:
    """L'état persisté. Absent, illisible ou corrompu -> ``{}`` (jamais une
    exception : une photo doit pouvoir se prendre sur un disque neuf)."""
    path = state_path()
    if not path.is_file():
        return {}
    try:
        with open(str(path), "r", encoding="utf-8") as handle:
            data = json.load(handle)
    except (OSError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


def save_state(state: Any) -> None:
    """Persiste l'état (atomique, 0o600 — le patron obligatoire du dépôt).

    Best-effort : un disque plein ne doit pas faire tomber la route. On perd la
    mémoire de la minute, pas la réponse.
    """
    try:
        store._atomic_write_json(state_path(), _dict(state))
    except Exception:      # noqa: BLE001 — la persistance n'est jamais bloquante
        pass


# --------------------------------------------------------------------------- #
# I/O — la photo
# --------------------------------------------------------------------------- #

def _default_candles(symbol: str, range_: str, interval: str) -> Any:
    """Les bougies Yahoo, par import PARESSEUX (le module démarre même si le
    moteur de cours manque — même posture que ``mood.get``)."""
    from backend.bots.paper import quotes
    return quotes.get_candles(symbol, range_, interval)


def _fetch(url: str, client, budget: Optional[_Budget], at_s: float) -> Any:
    """GET JSON borné : budget, User-Agent, timeout. Lève ``BtcError`` sur tout
    statut >= 400 (429 et 5xx compris), toute panne de transport, tout corps
    illisible et tout budget épuisé — l'appelant en fait un ``degraded``."""
    if budget is not None and not budget.take(at_s):
        raise BtcError("budget de requêtes épuisé")
    cli = client if client is not None else get_client()
    try:
        response = cli.get(url, headers=dict(HEADERS), timeout=TIMEOUT_S)
    except Exception as exc:               # noqa: BLE001 — transport
        raise BtcError("transport (%s)" % type(exc).__name__)
    status = getattr(response, "status_code", 0)
    if status >= 400:
        raise BtcError("statut %s" % status)
    try:
        return response.json()
    except Exception as exc:               # noqa: BLE001 — corps illisible
        raise BtcError("corps illisible (%s)" % type(exc).__name__)


def _cached(state: Dict[str, Any], key: str, ttl_s: float, now: datetime,
            loader: Callable[[], Any], degraded: List[str],
            label: str) -> Any:
    """Une source, CACHÉE et en panne ISOLÉE.

    Cache frais -> la valeur mémorisée, sans une requête. Cache froid ->
    ``loader()`` ; s'il échoue, la source est notée ``degraded`` et le champ
    vaut ``None``. On ne ressert JAMAIS une valeur périmée en la faisant passer
    pour fraîche : le panneau afficherait un funding d'hier comme s'il était de
    l'heure, ce qui est pire qu'un trou (le trou, lui, se voit).
    """
    cache = state.setdefault("cache", {})
    if not isinstance(cache, dict):
        cache = {}
        state["cache"] = cache
    entry = _dict(cache.get(key))
    at = _parse_iso(entry.get("at"))
    if at is not None and 0 <= (now - at).total_seconds() < ttl_s:
        return entry.get("data")
    try:
        data = loader()
    except BtcError:
        degraded.append(label)
        return None
    except Exception:      # noqa: BLE001 — best-effort strict
        degraded.append(label)
        return None
    cache[key] = {"at": _iso(now), "data": data}
    return data


def snapshot(client: Any = None, state: Any = None, now: Any = None,
             candles_fn: Any = None) -> Dict[str, Any]:
    """La photo BTC du moment (clé ``btc`` du brief, spec §5.1).

    ``{funding_pct, next_funding_utc, mark, index, oi, oi_24h_pct, dvol, fng,
    fng_label, coinbase_spot, coinbase_premium_pct, cme_gap, degraded, ts}``.

    Six sources, six ``try`` séparés : une panne met son champ à ``None`` et
    son nom dans ``degraded``, jamais une exception qui remonte. Les caches
    (60 s ; 1 h pour le Fear & Greed et le DVOL) vivent dans ``state`` — un
    dict INJECTABLE. Sans ``state``, on relit et on réécrit
    ``data/paper_trading/btc.state.json`` ; avec, on ne touche pas au disque
    (c'est ce qui rend les tests hors ligne).

    ``state`` porte aussi les trois mémoires du volet : ``oi_history`` et
    ``price_history`` (48 h glissantes, d'où sortent les variations sur 24 h)
    et ``funding_history`` (les règlements RÉELLEMENT observés, dédupliqués par
    leur heure de règlement).
    """
    moment = _as_dt(now)
    at_s = _epoch_s(moment)
    persist = state is None
    data = load_state() if persist else state
    if not isinstance(data, dict):
        data = {}
    degraded: List[str] = []

    premium = parse_premium(_cached(
        data, "premium", CACHE_TTL_S, moment,
        lambda: _fetch(BINANCE_PREMIUM_URL, client, _BINANCE_BUDGET, at_s),
        degraded, "binance_premium"))
    oi = parse_oi(_cached(
        data, "oi", CACHE_TTL_S, moment,
        lambda: _fetch(BINANCE_OI_URL, client, _BINANCE_BUDGET, at_s),
        degraded, "binance_oi"))
    dvol = parse_dvol(_cached(
        data, "dvol", SLOW_CACHE_TTL_S, moment,
        lambda: _fetch(_dvol_url(moment), client, _DERIBIT_BUDGET, at_s),
        degraded, "deribit_dvol"))
    deribit_index = parse_deribit_index(_cached(
        data, "deribit_index", CACHE_TTL_S, moment,
        lambda: _fetch(DERIBIT_INDEX_URL, client, _DERIBIT_BUDGET, at_s),
        degraded, "deribit_index"))
    fng = parse_fng(_cached(
        data, "fng", SLOW_CACHE_TTL_S, moment,
        lambda: _fetch(FNG_URL, client, None, at_s), degraded, "fng"))
    coinbase = parse_coinbase(_cached(
        data, "coinbase", CACHE_TTL_S, moment,
        lambda: _fetch(COINBASE_SPOT_URL, client, None, at_s),
        degraded, "coinbase"))

    mark = premium["mark"]
    index = premium["index"] if premium["index"] is not None else deribit_index

    # Les trois mémoires. On n'écrit QUE ce qu'on a mesuré : un ``None`` ne
    # rentre pas dans une série (il y ferait un trou qui se lirait comme zéro).
    data["oi_history"] = _push(data.get("oi_history"), moment, oi["oi"])
    data["price_history"] = _push(data.get("price_history"), moment, mark)
    _record_funding(data, premium)

    spot = coinbase if coinbase is not None else mark
    gap = None
    try:
        fetch_candles = candles_fn if candles_fn is not None else _default_candles
        gap = cme_gap(fetch_candles(CME_SYMBOL, CME_RANGE, CME_INTERVAL),
                      spot, moment)
    except Exception:      # noqa: BLE001 — Yahoo est une source comme une autre
        degraded.append("cme_gap")

    out = {
        "funding_pct": premium["funding_pct"],
        "next_funding_utc": premium["next_funding_utc"],
        "mark": mark,
        "index": index,
        "oi": oi["oi"],
        "oi_24h_pct": pct_24h(data.get("oi_history"), moment),
        "dvol": dvol["dvol"],
        "fng": fng["value"],
        "fng_label": fng["label"],
        "coinbase_spot": coinbase,
        "coinbase_premium_pct": _premium_pct(coinbase, mark),
        "cme_gap": gap,
        "degraded": degraded,
        "ts": _iso(moment),
    }
    if persist:
        save_state(data)
    return out


def _dvol_url(now: datetime) -> str:
    """L'URL DVOL sur les 24 dernières heures (résolution horaire)."""
    end_ms = int(_epoch_s(now)) * 1000
    start_ms = end_ms - 24 * 3600 * 1000
    return DERIBIT_DVOL_URL % (start_ms, end_ms)


def _premium_pct(coinbase: Optional[float],
                 mark: Optional[float]) -> Optional[float]:
    """La prime Coinbase — « la demande US paie-t-elle plus cher ? ».

    Sans prix de marque, il n'y a pas de dénominateur : ``None``, jamais un
    calcul contre une autre référence choisie en douce.
    """
    if coinbase is None or not mark:
        return None
    return round((coinbase - mark) / mark * 100.0, 4)


def _record_funding(state: Dict[str, Any], premium: Dict[str, Any]) -> None:
    """Inscrit le règlement observé, DÉDUPLIQUÉ par son heure de règlement.

    Sans cette clé, chaque photo de la minute réinscrirait le même règlement et
    « deux règlements consécutifs » se déclencherait sur une seule mesure lue
    deux fois — la définition même d'un faux signal.
    """
    settled = premium.get("settled_at")
    value = premium.get("funding_pct")
    if not settled or value is None:
        return
    rows = [row for row in state.get("funding_history") or []
            if isinstance(row, dict) and row.get("ts")]
    if any(row.get("ts") == settled for row in rows):
        return
    rows.append({"ts": settled, "funding_pct": value})
    rows.sort(key=lambda row: str(row.get("ts")))
    state["funding_history"] = rows[-FUNDING_HISTORY_MAX:]
