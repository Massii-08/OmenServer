"""La fiche du titre affiché dans TradingView — LECTURE PURE, assemblage seul.

Spec : ``docs/superpowers/specs/2026-09-09-tv-coach-extension-design.md`` §5.1
(le contrat), §4.2 (les sources). Plan : §1.1 (la table des symboles), §1.2.

Ce module n'invente RIEN et ne calcule presque rien : il va chercher, chez les
modules qui savent déjà, les quinze morceaux qui composent l'écran du panneau,
et il les range dans une forme STABLE. « Champs absents = ``null``, jamais
inventés » (§5.1) — un objet qu'on n'a pas vaut ``null``, une liste vide vaut
``[]``, et le nom de toute source en panne est écrit dans ``degraded`` pour que
l'écran puisse dire « je n'ai pas pu lire ça » au lieu de faire comme si.

**Chaque source vit dans son propre ``try``** (§1.2) : une panne de la veille
de presse ne doit pas emporter la cotation. :func:`build` ne lève JAMAIS.

**Injection** : ``deps`` remplace n'importe laquelle des sources par une
fonction à soi — c'est ce qui rend les tests 100 % hors ligne. Sans ``deps``,
:func:`default_deps` câble les vrais modules.
"""
import logging
from typing import Any, Callable, Dict, List, Optional

from backend.bots.paper import fees, models, price_alerts, quotes, ta

logger = logging.getLogger("omenserver")

# --------------------------------------------------------------------------- #
# §1.1 — TradingView -> Yahoo
#
# ⚠️ CETTE TABLE EST UN MIROIR de ``tools/tv-coach-extension/lib/symbols.js``
# (plan §1.1 : « même table, testée à l'identique »). Elle rend donc le symbole
# BRUT de Yahoo, PAS sa forme canonique : l'extension n'a pas accès à
# ``quotes.SYMBOL_ALIASES``, et c'est le routeur qui applique
# :func:`quotes.canonical` derrière (``SIX:ROG`` -> ``ROG.SW`` -> ``RO.SW``).
# Toute correspondance ajoutée ici doit l'être aussi là-bas.
#
# Là où les deux tables diffèrent (relevé le 09/09), celle-ci est un
# SUR-ENSEMBLE : places ARCA/OTC/TRADEGATE, plates-formes crypto BITFINEX,
# GEMINI, OKX, BYBIT, places de change FOREXCOM et SAXO, paires cotées en
# euros. C'est le sens SÛR de l'écart — le serveur sait résoudre un symbole que
# l'extension n'enverra jamais, alors que l'inverse ferait un 400 sur un titre
# parfaitement affichable. AUCUNE entrée de ``lib/symbols.js`` n'est absente
# d'ici (vérifié en comparant les deux tables sur 51 symboles).
# --------------------------------------------------------------------------- #

# Places boursières -> suffixe Yahoo. Les places américaines n'en ont aucun.
TV_EXCHANGE_SUFFIX: Dict[str, str] = {
    "NASDAQ": "", "NYSE": "", "AMEX": "", "BATS": "", "ARCA": "", "OTC": "",
    "SIX": ".SW", "BX": ".SW",
    "XETR": ".DE", "FWB": ".DE", "TRADEGATE": ".DE",
    # EURONEXT couvre Paris, Amsterdam et Bruxelles sous un seul préfixe chez
    # TradingView ; Yahoo les sépare (.PA/.AS/.BR). HYPOTHÈSE ASSUMÉE : Paris,
    # la place que Massii regarde (LVMH, Airbus). Une valeur d'Amsterdam
    # tomberait sur un symbole faux — mieux vaut l'ajouter en override le jour
    # où le cas se présente que de deviner ici.
    "EURONEXT": ".PA",
    "LSE": ".L", "MIL": ".MI",
}

# Places où un ticker désigne une PAIRE crypto (BTCUSD, XBTUSD, ETHUSDT…).
TV_CRYPTO_EXCHANGES = frozenset({
    "BITSTAMP", "BINANCE", "KRAKEN", "COINBASE", "CRYPTO", "BITFINEX",
    "GEMINI", "OKX", "BYBIT",
})

# Places de change.
TV_FOREX_EXCHANGES = frozenset({"FX", "OANDA", "FX_IDC", "FOREXCOM", "SAXO"})

# Les seules bases crypto reconnues — liste FERMÉE (même doctrine que
# ``price_alerts.OPS``) : un ticker inconnu doit rendre ``None``, pas fabriquer
# un « DOGE-USD » que Yahoo pourrait ne pas connaître sous cette forme.
CRYPTO_BASES = ("BTC", "ETH", "SOL", "XRP")

# Écritures alternatives de la même base (Kraken écrit le bitcoin « XBT »).
CRYPTO_BASE_ALIASES = {"XBT": "BTC"}

# Devises de cotation qu'on retire pour retrouver la base.
CRYPTO_QUOTES = ("USDT", "USDC", "USD", "EUR")

# Correspondances qui ne suivent aucune règle : un ticker local qui ne
# ressemble pas au symbole Yahoo, un indice de matière première, un future.
TV_OVERRIDES: Dict[str, str] = {
    "BX:NESR": "NESN.SW",       # Nestlé cotée sur BX Swiss sous un autre code
    "TVC:UKOIL": "BZ=F",        # Brent
    "TVC:USOIL": "CL=F",        # WTI
    "TVC:GOLD": "GC=F",         # or
    "CME:BTC1!": "BTC=F",       # future bitcoin CME (contrat continu)
}

# Suffixe TradingView des contrats perpétuels — retiré avant tout le reste.
PERP_SUFFIX = ".P"

# Les suffixes Yahoo d'une paire CRYPTO. Le plan §1.1 n'en nomme qu'un
# (``-USD``) parce que c'est le seul que la table produit ; les trois autres
# existent bel et bien chez Yahoo (``BTC-EUR``…) et un symbole tapé à la main
# dans la barre d'adresse doit être reconnu pour ce qu'il est. Même liste que
# ``kindOf`` de ``lib/symbols.js``.
CRYPTO_SUFFIXES = ("-USD", "-EUR", "-USDT", "-CHF")

KIND_CRYPTO = "crypto"
KIND_FOREX = "forex"
KIND_COMMODITY = "commodity"
KIND_INDEX = "index"
KIND_STOCK = "stock"

# Le différé de Yahoo sur les actions (§3 : « différé 15 min actions »). Les
# cryptos et le change cotent en continu et sans retard chez le même
# fournisseur.
YAHOO_DELAY_MIN = 15
REALTIME_KINDS = (KIND_CRYPTO, KIND_FOREX)

# Risque par défaut proposé par le ticket, cf. ``precheck.DEFAULT_RISK_PCT``
# (MIROIR DOCUMENTÉ : les deux modules ne s'importent pas l'un l'autre pour
# rester chacun sur son étage — la fiche affiche, le pré-check calcule).
DEFAULT_RISK_PCT = 1.0

# Dernières dépêches servies au panneau. Dix : ce que la colonne du panneau
# montre sans devoir défiler.
NEWS_LIMIT = 10

# Les quinze sources injectables. L'ORDRE n'a aucune importance ; le NOM, si :
# c'est celui qui apparaît dans ``degraded``.
DEP_NAMES = ("quote", "portfolio", "coach_positions", "ideas_for_symbol",
             "hypotheses", "news", "calendar", "whales", "mood", "btc",
             "alerts", "candles_1m", "candles_1d", "fees_profile")


def tv_to_yahoo(tv_symbol: Any) -> Optional[str]:
    """``EXCHANGE:TICKER`` de TradingView -> symbole Yahoo (PUR).

    Insensible à la casse, suffixe ``.P`` des perpétuels retiré, préfixe
    ``CRYPTO:`` accepté. Place inconnue, ticker vide, crypto hors liste
    blanche -> ``None`` : « inconnu -> null » (§1.1). Mieux vaut un panneau
    vide qu'un panneau qui parle d'un autre titre.
    """
    if not isinstance(tv_symbol, str):
        return None
    raw = tv_symbol.strip().upper()
    if ":" not in raw:
        return None
    exchange, _, ticker = raw.partition(":")
    exchange = exchange.strip()
    ticker = ticker.strip()
    if ticker.endswith(PERP_SUFFIX):
        ticker = ticker[:-len(PERP_SUFFIX)]
    if not exchange or not ticker:
        return None

    override = TV_OVERRIDES.get("%s:%s" % (exchange, ticker))
    if override:
        return override

    if exchange in TV_CRYPTO_EXCHANGES:
        return _crypto_pair(ticker)

    if exchange in TV_FOREX_EXCHANGES:
        # Une paire de change s'écrit en SIX lettres chez TradingView comme
        # chez Yahoo (``EURUSD``), la seule différence est le suffixe.
        if len(ticker) == 6 and ticker.isalpha():
            return ticker + "=X"
        return None

    suffix = TV_EXCHANGE_SUFFIX.get(exchange)
    if suffix is None:
        return None
    if not suffix:
        # Places américaines : le ticker Yahoo est celui de TradingView, à un
        # détail près — le POINT des classes d'actions devient un TIRET chez
        # Yahoo (``NYSE:BRK.B`` -> ``BRK-B``). Sans cette conversion, le
        # panneau de l'extension (qui la fait, cf. ``lib/symbols.js``)
        # demanderait une fiche que le serveur refuserait en 400.
        ticker = ticker.replace(".", "-")
    return ticker + suffix


def _crypto_pair(ticker: str) -> Optional[str]:
    """``BTCUSDT``/``XBTUSD`` -> ``BTC-USD`` (PUR), ``None`` hors liste."""
    base = ticker
    for quote_ccy in CRYPTO_QUOTES:
        if base.endswith(quote_ccy) and len(base) > len(quote_ccy):
            base = base[:-len(quote_ccy)]
            break
    base = CRYPTO_BASE_ALIASES.get(base, base)
    if base not in CRYPTO_BASES:
        return None
    # Toujours coté en dollars chez Yahoo, quelle que soit la devise de la
    # paire TradingView : c'est le marché de référence du titre.
    return base + "-USD"


def kind_of(symbol: Any) -> str:
    """La famille d'actif déduite du SYMBOLE Yahoo (PUR, §1.1).

    :data:`CRYPTO_SUFFIXES` -> crypto, ``=X`` -> change, ``=F`` -> matière
    première (ou future, ``BTC=F`` compris — c'est un contrat, pas une crypto
    au comptant), ``^`` -> indice, sinon action.
    """
    text = str(symbol or "").strip().upper()
    if text.endswith(CRYPTO_SUFFIXES):
        return KIND_CRYPTO
    if text.endswith("=X"):
        return KIND_FOREX
    if text.endswith("=F"):
        return KIND_COMMODITY
    if text.startswith("^"):
        return KIND_INDEX
    return KIND_STOCK


# --------------------------------------------------------------------------- #
# Sources par défaut — les VRAIS modules, câblés paresseusement
# --------------------------------------------------------------------------- #
def _default_coach_positions() -> List[Dict[str, Any]]:
    """Les lignes du compte du COACH (livre public par design, cf.
    ``paper_router.paper_coach_trader``) — lecture disque seule."""
    from backend.bots.paper import coach_trader, store
    raw = store.load_portfolio(coach_trader.COACH_USERNAME) or {}
    return [row for row in (raw.get("positions") or []) if isinstance(row, dict)]


def _default_ideas(username: str, symbol: str) -> List[Dict[str, Any]]:
    """Les idées du journal qui portent ce ticker (même filtre que
    ``paper_router.paper_ideas_for_symbol``, côté journal seulement — les
    hypothèses du radar ont leur propre source ci-dessous)."""
    from backend.bots.paper import idea_journal
    out: List[Dict[str, Any]] = []
    for entry in idea_journal.load_entries(username):
        for idea in (entry.get("ideas") or []):
            if not isinstance(idea, dict):
                continue
            if str(idea.get("ticker") or "").strip().upper() != symbol:
                continue
            out.append({"ts": entry.get("ts"),
                        "direction": idea.get("direction"),
                        "horizon_days": idea.get("horizon_days"),
                        "risk_level": idea.get("risk_level"),
                        "thesis": idea.get("thesis"),
                        "tracked": bool(idea.get("tracked"))})
    return out


def _default_hypotheses(symbol: str) -> List[Dict[str, Any]]:
    """Les hypothèses OUVERTES du radar sur ce ticker."""
    from backend.bots.paper import radar
    rows = (radar.load_state() or {}).get("hypotheses") or []
    out: List[Dict[str, Any]] = []
    for hyp in rows:
        if not isinstance(hyp, dict):
            continue
        tickers = [str(t or "").strip().upper() for t in (hyp.get("tickers") or [])]
        if symbol in tickers:
            out.append(hyp)
    return out


def _default_news(username: str) -> List[Dict[str, Any]]:
    from backend.bots.paper import newswatch
    return list(newswatch.recent_events(username) or [])


def _default_calendar() -> List[Dict[str, Any]]:
    from backend.bots.paper import calendar as calendar_module
    return list(calendar_module.calendar_view() or [])


def _default_whales(symbol: str) -> List[Dict[str, Any]]:
    """Les mouvements 13F qui touchent ce titre — CACHE SEUL (``moves_summary``
    ne sort jamais sur la SEC, cf. sa docstring)."""
    from backend.bots.paper import whales
    rows = whales.moves_summary() or []
    return [row for row in rows
            if isinstance(row, dict)
            and str(row.get("symbol") or "").strip().upper() == symbol]


def _default_mood() -> Dict[str, Any]:
    from backend.bots.paper import mood
    return mood.get()


def _default_btc() -> Optional[Dict[str, Any]]:
    """Le volet Bitcoin (§9) — import PARESSEUX et dans un ``try`` de
    l'appelant : ``btc.py`` est livré par un AUTRE lot, et la fiche doit vivre
    sans lui (``btc: null`` + ``"btc"`` dans ``degraded``)."""
    from backend.bots.paper import btc as btc_module
    return btc_module.snapshot()


def _default_alerts(username: str) -> List[Dict[str, Any]]:
    from backend.bots.paper import store
    return list(store.load_alerts(username) or [])


def _default_portfolio(username: str) -> Dict[str, Any]:
    from backend.bots.paper import store
    return store.load_portfolio(username) or {}


def _default_fees_profile(username: str) -> str:
    raw = _default_portfolio(username)
    return str(raw.get("fee_profile") or models.DEFAULT_FEE_PROFILE)


def default_deps() -> Dict[str, Callable]:
    """Le câblage RÉEL des quinze sources (§4.2). Chaque entrée est appelée
    avec les arguments documentés dans :func:`build`."""
    return {
        "quote": lambda symbol: quotes.get_quote(symbol),
        "portfolio": _default_portfolio,
        "coach_positions": _default_coach_positions,
        "ideas_for_symbol": _default_ideas,
        "hypotheses": _default_hypotheses,
        "news": _default_news,
        "calendar": _default_calendar,
        "whales": _default_whales,
        "mood": _default_mood,
        "btc": _default_btc,
        "alerts": _default_alerts,
        # Les bougies du JOUR à la minute (VWAP, haut/bas, ATR 1 min) et six
        # mois de bougies quotidiennes (ATR14 jour) — les deux fenêtres que
        # ``quotes.get_candles`` sait servir en un appel chacune.
        "candles_1m": lambda symbol: quotes.get_candles(symbol, "1d", "1m"),
        "candles_1d": lambda symbol: quotes.get_candles(symbol, "6mo", "1d"),
        "fees_profile": _default_fees_profile,
    }


# --------------------------------------------------------------------------- #
# Outils internes
# --------------------------------------------------------------------------- #
def _val(value: Any) -> Optional[float]:
    if isinstance(value, bool) or value is None:
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _rows(value: Any) -> List[Dict[str, Any]]:
    if not isinstance(value, (list, tuple)):
        return []
    return [row for row in value if isinstance(row, dict)]


class _Sources(object):
    """Les quinze sources, appelées UNE fois chacune, chacune dans son ``try``.

    Une source qui lève est notée dans ``degraded`` et rend la valeur de repli
    demandée par l'appelant — jamais une exception qui remonterait jusqu'au
    routeur (§1.2 : « panne isolée »).
    """

    def __init__(self, deps: Optional[Dict[str, Callable]]):
        self.deps = dict(default_deps())
        if isinstance(deps, dict):
            self.deps.update(deps)
        self.degraded: List[str] = []

    def get(self, name: str, *args, **kwargs) -> Any:
        default = kwargs.pop("default", None)
        fn = self.deps.get(name)
        if fn is None:
            self._degrade(name)
            return default
        try:
            return fn(*args)
        except Exception as exc:            # noqa: BLE001 — panne ISOLÉE
            logger.warning("paper brief: source %s indisponible (%s)",
                           name, type(exc).__name__)
            self._degrade(name)
            return default

    def _degrade(self, name: str) -> None:
        if name not in self.degraded:
            self.degraded.append(name)


def _position_of(portfolio: Any, symbol: str,
                 price: Optional[float]) -> Optional[Dict[str, Any]]:
    """La ligne du portefeuille sur CE titre, valorisée au cours du jour.

    ``None`` s'il n'y a pas de ligne — jamais un dict vide, qui se lirait
    comme « position à zéro » (§5.1 : « position … est ``null`` quand sans
    objet »).
    """
    for row in _rows((portfolio or {}).get("positions")):
        if str(row.get("symbol") or "").strip().upper() != symbol:
            continue
        qty = _val(row.get("qty"))
        avg = _val(row.get("avg_price"))
        side = str(row.get("side") or "long")
        pnl = None
        if qty is not None and avg is not None and price is not None:
            gain = (price - avg) if side != "short" else (avg - price)
            pnl = round(gain * abs(qty) * (_val(row.get("fx_rate")) or 1.0), 2)
        return {"side": side, "qty": qty, "avg": avg,
                "stop": _val(row.get("stop_loss")),
                "target": _val(row.get("target")),
                "pnl_chf": pnl}
    return None


def _coach_position_of(positions: Any, symbol: str) -> Optional[Dict[str, Any]]:
    """La ligne du COACH sur ce titre — sa thèse comprise : c'est l'intérêt du
    livre public (« il est short pendant que je suis long »)."""
    for row in _rows(positions):
        if str(row.get("symbol") or "").strip().upper() != symbol:
            continue
        return {"side": str(row.get("side") or "long"),
                "qty": _val(row.get("qty")),
                "stop": _val(row.get("stop_loss")),
                "target": _val(row.get("target")),
                "thesis": row.get("thesis") or ""}
    return None


def _pending_of(portfolio: Any, symbol: str) -> List[Dict[str, Any]]:
    """Les ordres ENCORE OUVERTS sur ce titre (les pièges armés du panneau)."""
    return [row for row in _rows((portfolio or {}).get("orders"))
            if str(row.get("symbol") or "").strip().upper() == symbol
            and str(row.get("status") or "open") == "open"]


def _alerts_of(alerts: Any, symbol: str) -> List[Dict[str, Any]]:
    """Les alertes ARMÉES du titre.

    Seulement les armées : l'extension les réévalue sur le prix vif (§7,
    levier 5), et une alerte déjà déclenchée n'a plus rien à surveiller —
    l'envoyer la ferait tirer une deuxième fois.
    """
    return [row for row in _rows(alerts)
            if str(row.get("symbol") or "").strip().upper() == symbol
            and row.get("status", price_alerts.STATUS_ARMED)
            == price_alerts.STATUS_ARMED]


def _news_of(events: Any, symbol: str, tv_symbol: str) -> List[Dict[str, Any]]:
    """Les dépêches du titre, mises à la forme du panneau (§5.1).

    Le filtre accepte le symbole Yahoo ET, pour le volet TradingView, le
    symbole TRADINGVIEW : ``tvnews`` conserve l'identifiant tel que le flux
    l'écrit (``BITSTAMP:BTCUSD``), et le retraduire des deux côtés ferait
    perdre les dépêches dont la place n'est pas celle qu'on regarde.
    """
    wanted = {symbol, str(tv_symbol or "").strip().upper()}
    wanted.discard("")
    out: List[Dict[str, Any]] = []
    for event in _rows(events):
        if str(event.get("symbol") or "").strip().upper() not in wanted:
            continue
        via = event.get("via") or event.get("src")
        out.append({
            "ts": event.get("ts"),
            "title": event.get("title"),
            # ``provider`` est le média (Reuters, CNBC…) que le volet
            # TradingView conserve ; ``src``/``via`` est le CANAL par lequel il
            # nous arrive. Les deux sont servis, jamais confondus.
            "source": event.get("provider") or event.get("source") or via,
            "via": via,
            "sentiment": event.get("sentiment"),
            "url": event.get("url") or event.get("link"),
        })
        if len(out) >= NEWS_LIMIT:
            break
    return out


# Les familles d'entrées du calendrier qui concernent TOUT LE MONDE, quel que
# soit le titre affiché (macro TradingView, agenda crypto calculé) — les
# autres ne sont servies que si elles portent le ticker.
CALENDAR_GLOBAL_KINDS = ("macro", "bc", "crypto")


def _calendar_of(entries: Any, symbol: str) -> List[Dict[str, Any]]:
    """Les rendez-vous à afficher pour ce titre."""
    out: List[Dict[str, Any]] = []
    for entry in _rows(entries):
        kind = str(entry.get("kind") or "")
        tickers = [str(t or "").strip().upper() for t in (entry.get("tickers") or [])]
        own = str(entry.get("symbol") or "").strip().upper()
        if kind in CALENDAR_GLOBAL_KINDS or symbol == own or symbol in tickers:
            out.append(entry)
    return out


def _session_ta(candles_1m: Any, candles_1d: Any) -> Dict[str, Any]:
    """Le bloc ``ta`` (§5.1) — jamais une clé absente, seulement des ``None``.

    ``atr14_d`` et ``atr1_m`` sont le MÊME ``ta.atr14`` appliqué aux deux
    séries : l'ATR ne connaît pas l'unité de temps de ses bougies, et écrire
    un second calcul « pour la minute » créerait une divergence sans raison.

    ``vwap`` = Σ(clôture × volume) / Σ volume — ``None`` sans volume, parce
    qu'une moyenne des cours déguisée en prix moyen pondéré est exactement le
    genre de chiffre sur lequel on poserait un stop en croyant s'appuyer sur
    le flux.
    """
    out = {"atr14_d": None, "atr1_m": None, "vwap": None,
           "day_high": None, "day_low": None}
    try:
        out["atr14_d"] = ta.atr14(candles_1d)
    except Exception:                       # noqa: BLE001
        out["atr14_d"] = None

    minutes = _rows(candles_1m)
    if not minutes:
        return out
    try:
        out["atr1_m"] = ta.atr14(minutes)
    except Exception:                       # noqa: BLE001
        out["atr1_m"] = None

    highs = [_val(row.get("high")) for row in minutes]
    lows = [_val(row.get("low")) for row in minutes]
    highs = [value for value in highs if value is not None]
    lows = [value for value in lows if value is not None]
    out["day_high"] = max(highs) if highs else None
    out["day_low"] = min(lows) if lows else None

    total_volume = 0.0
    total_value = 0.0
    for row in minutes:
        close = _val(row.get("close"))
        volume = _val(row.get("volume"))
        if close is None or volume is None or volume <= 0:
            continue
        total_volume += volume
        total_value += close * volume
    if total_volume > 0:
        out["vwap"] = round(total_value / total_volume, 4)
    return out


def _fees_view(profile: Any, symbol: str, equity: float,
               position_value: float) -> Dict[str, Any]:
    """Profil de frais et coût d'un ALLER-RETOUR, en % (§5.1).

    Le pourcentage dépend du montant chez les courtiers à paliers ou à
    minimum : on le chiffre sur la ligne DÉJÀ DÉTENUE quand il y en a une (le
    montant que l'écran est en train de montrer), sinon sur un ticket de
    référence de ``coach_trader.MIN_POSITION_PCT`` % de l'équité — le plancher
    en dessous duquel une ligne « n'est pas des actions en centimes ». Le
    montant retenu est SERVI (``notional_chf``) : rien de caché.
    """
    from backend.bots.paper import coach_trader
    key = str(profile or "").strip().lower()
    if key not in fees.FEE_PROFILES:
        key = models.DEFAULT_FEE_PROFILE
    notional = position_value
    if not notional or notional <= 0:
        notional = max(equity, 0.0) * coach_trader.MIN_POSITION_PCT / 100.0
    try:
        round_trip = fees.round_trip_pct(key, notional, symbol)
    except (ValueError, TypeError):
        round_trip = None
    return {"profile": key, "round_trip_pct": round_trip,
            "notional_chf": round(notional, 2)}


def build(username: str, symbol: str, tv_symbol: str,
          deps: Optional[Dict[str, Callable]] = None,
          now: Any = None) -> Dict[str, Any]:
    """La fiche complète du titre (§5.1). **Ne lève jamais.**

    ``username`` : le compte qui regarde. ``symbol`` : le symbole YAHOO déjà
    canonique (le routeur applique ``quotes.canonical``). ``tv_symbol`` : le
    symbole TradingView affiché, conservé tel quel dans la réponse (il sert au
    filtre des dépêches et au dessin côté extension).

    ``deps`` : les sources, une par une (voir :data:`DEP_NAMES`). Chacune est
    appelée ainsi — ``quote(symbol)``, ``portfolio(username)``,
    ``coach_positions()``, ``ideas_for_symbol(username, symbol)``,
    ``hypotheses(symbol)``, ``news(username)``, ``calendar()``,
    ``whales(symbol)``, ``mood()``, ``btc()``, ``alerts(username)``,
    ``candles_1m(symbol)``, ``candles_1d(symbol)``, ``fees_profile(username)``.
    Absente -> la vraie implémentation (:func:`default_deps`).

    ``now`` : l'horodatage servi dans ``quote.ts`` (l'instant de la LECTURE,
    pas celui du tick — Yahoo ne donne pas l'heure de sa dernière transaction).
    """
    symbol = str(symbol or "").strip().upper()
    tv_symbol = str(tv_symbol or "").strip().upper()
    kind = kind_of(symbol)
    src = _Sources(deps)

    # --- cotation --------------------------------------------------------- #
    raw_quote = src.get("quote", symbol)
    quote = None
    price = None
    if isinstance(raw_quote, dict):
        price = _val(raw_quote.get("price"))
        quote = {
            "price": price,
            "currency": raw_quote.get("currency"),
            "change_pct": _val(raw_quote.get("change_pct")),
            "name": raw_quote.get("name"),
            "ts": now,
            "delay_min": 0 if kind in REALTIME_KINDS else YAHOO_DELAY_MIN,
        }

    # --- portefeuille (position, ordres, équité, défauts) ------------------ #
    portfolio = src.get("portfolio", username, default={})
    if not isinstance(portfolio, dict):
        portfolio = {}
    position = _position_of(portfolio, symbol, price)
    pending_orders = _pending_of(portfolio, symbol)

    equity = 0.0
    try:
        from backend.bots.paper import risk
        equity = _val(risk.exposure(portfolio.get("positions") or [], {},
                                    portfolio.get("cash_chf")).get("total_chf")) or 0.0
    except Exception:                       # noqa: BLE001 — portefeuille tordu
        equity = 0.0

    position_value = 0.0
    if position and position.get("qty") is not None:
        reference = price if price is not None else position.get("avg")
        if reference is not None:
            position_value = abs(position["qty"]) * reference

    # --- le volet Bitcoin, seulement pour une crypto ---------------------- #
    btc = None
    if kind == KIND_CRYPTO:
        btc = src.get("btc")
        if not isinstance(btc, dict):
            btc = None

    # --- humeur (le VIX, plus le Fear & Greed / DVOL du volet Bitcoin) ---- #
    raw_mood = src.get("mood")
    mood_view = None
    if isinstance(raw_mood, dict):
        mood_view = dict(raw_mood)
    if btc:
        for key in ("fng", "dvol"):
            if btc.get(key) is not None:
                mood_view = mood_view if mood_view is not None else {}
                mood_view[key] = btc.get(key)

    fees_profile = src.get("fees_profile", username)

    out = {
        "symbol": symbol,
        "tv_symbol": tv_symbol,
        "kind": kind,
        "quote": quote,
        "position": position,
        "coach_position": _coach_position_of(src.get("coach_positions"), symbol),
        "pending_orders": pending_orders,
        "alerts": _alerts_of(src.get("alerts", username), symbol),
        "ideas": _rows(src.get("ideas_for_symbol", username, symbol)),
        "hypotheses": _rows(src.get("hypotheses", symbol)),
        "news": _news_of(src.get("news", username), symbol, tv_symbol),
        "calendar": _calendar_of(src.get("calendar"), symbol),
        "whales": _rows(src.get("whales", symbol)),
        "mood": mood_view,
        "btc": btc,
        "fees": _fees_view(fees_profile, symbol, equity, position_value),
        "ta": _session_ta(src.get("candles_1m", symbol),
                          src.get("candles_1d", symbol)),
        "defaults": {"risk_pct": DEFAULT_RISK_PCT,
                     "equity_chf": round(equity, 2) if equity else None},
        "degraded": src.degraded,
    }
    return out
