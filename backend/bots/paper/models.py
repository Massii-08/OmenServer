"""Contrat de données du simulateur de paper trading — PUR (aucun I/O, aucun réseau).

Toutes les structures se sérialisent en JSON via ``to_dict()`` et se relisent via
``from_dict()``.

``from_dict`` est volontairement **TOLÉRANT** : un champ absent prend sa valeur par
défaut, un champ inconnu est ignoré, une valeur du mauvais type retombe sur le
défaut. Le fichier de portefeuille sur disque survit donc aux évolutions du schéma
(ajouter un champ ne casse pas les portefeuilles déjà enregistrés).

Convention de devise : tout ce qui est suffixé ``_chf`` est déjà converti en francs.
``fx_rate`` est le taux devise-du-titre -> CHF **au moment de l'opération** (1.0 pour
un titre déjà en CHF).
"""
from dataclasses import asdict, dataclass, field
from typing import Any, Dict, List, Optional

DEFAULT_CAPITAL = 10000.0
DEFAULT_CURRENCY = "CHF"
DEFAULT_FEE_PROFILE = "yuh"

POSITION_SIDES = ("long", "short")
ORDER_SIDES = ("buy", "sell", "short", "cover")
ORDER_KINDS = ("market", "limit", "stop")
ORDER_STATUSES = ("open", "filled", "cancelled")

# Journal niveau pro (LOT 2) — deux whitelists FERMÉES, posées à l'entrée
# (``setup``/``emotion`` sur l'ordre) et portées jusqu'au ``Trade`` clos. Ce
# sont des CODES internes (comme ``ORDER_SIDES``/``ORDER_KINDS`` ci-dessus) :
# ``EMOTIONS`` est en français ici parce que c'est le vocabulaire que Massii a
# fixé lui-même pour ce lot — l'affichage traduit ×3 langues (via
# ``paper.emotion_<code>``) vit dans le frontend, comme pour tout le reste.
SETUPS = ("breakout", "pullback", "news", "coach_idea", "trend", "contrarian", "other")
EMOTIONS = ("calme", "fomo", "revanche", "doute", "euphorie")


# --------------------------------------------------------------------------- #
# Coercitions tolérantes (un JSON abîmé ne doit jamais faire planter la lecture)
# --------------------------------------------------------------------------- #
def _as_float(value: Any, default: float = 0.0) -> float:
    """Nombre flottant, ou ``default`` si la valeur est absente/illisible."""
    if value is None or isinstance(value, bool):
        return default
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def _as_opt_float(value: Any) -> Optional[float]:
    """Nombre flottant optionnel : ``None`` reste ``None`` (champ non renseigné)."""
    if value is None or isinstance(value, bool):
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _as_int(value: Any, default: int = 0) -> int:
    """Entier, ou ``default``. Un flottant est tronqué (une action ne se coupe pas)."""
    if value is None or isinstance(value, bool):
        return default
    try:
        return int(float(value))
    except (TypeError, ValueError):
        return default


def _as_str(value: Any, default: str = "") -> str:
    """Chaîne, ou ``default`` si absente."""
    if value is None:
        return default
    if isinstance(value, str):
        return value
    return str(value)


def _as_dict_list(value: Any) -> List[Dict[str, Any]]:
    """Liste de dictionnaires ; toute entrée qui n'en est pas un est ignorée."""
    if not isinstance(value, list):
        return []
    return [item for item in value if isinstance(item, dict)]


def _as_str_list(value: Any) -> List[str]:
    """Liste de codes-chaînes (LOT 3, C3 : ``forced_warnings``) ; toute entrée
    qui n'est pas une chaîne est ignorée, jamais une exception."""
    if not isinstance(value, list):
        return []
    return [item for item in value if isinstance(item, str)]


# --------------------------------------------------------------------------- #
# Structures
# --------------------------------------------------------------------------- #
@dataclass
class Position:
    """Une ligne détenue en portefeuille.

    ``qty`` est un COMPTE (toujours positif) ; c'est ``side`` qui porte le sens
    (``long`` = acheté, ``short`` = vendu à découvert).

    Les 4 derniers champs portent le PLAN du trade. L'ordre d'entrée est consommé
    dès qu'il est exécuté : sans cette copie, le tick n'aurait plus de stop de
    protection à appliquer et le coach n'aurait plus de thèse à confronter à la
    sortie. Ils sont optionnels (une position peut exister sans plan — et c'est
    exactement ce que le biais ``no_stop`` traque).
    """

    symbol: str
    qty: int = 0
    avg_price: float = 0.0
    currency: str = DEFAULT_CURRENCY
    fx_rate: float = 1.0
    opened_at: str = ""
    side: str = "long"
    thesis: str = ""
    stop_loss: Optional[float] = None
    target: Optional[float] = None
    risk_chf: Optional[float] = None
    # Étiquettes du journal (LOT 2, B2/B3) : posées à l'ouverture (via l'ordre),
    # portées jusqu'au ``Trade`` clos — même geste que ``thesis``/``stop_loss``.
    setup: str = ""
    emotion: str = ""
    # LOT 3, C3 — les codes du garde-fou pré-ordre (``no_stop``/``no_thesis``/
    # ``risk_high``/``reward_risk_below_1``/``oversize``) que Massii a EXPLICITEMENT forcés
    # (``confirmed: true`` malgré l'avertissement). Portée depuis l'ordre
    # jusqu'au ``Trade`` clos, même geste que ``setup``/``emotion`` — le score
    # de discipline pourra les lire plus tard (stocké, pas encore câblé).
    forced_warnings: List[str] = field(default_factory=list)

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: Optional[Dict[str, Any]]) -> "Position":
        data = data or {}
        return cls(
            symbol=_as_str(data.get("symbol")),
            qty=_as_int(data.get("qty")),
            avg_price=_as_float(data.get("avg_price")),
            currency=_as_str(data.get("currency"), DEFAULT_CURRENCY),
            fx_rate=_as_float(data.get("fx_rate"), 1.0),
            opened_at=_as_str(data.get("opened_at")),
            side=_as_str(data.get("side"), "long"),
            thesis=_as_str(data.get("thesis")),
            stop_loss=_as_opt_float(data.get("stop_loss")),
            target=_as_opt_float(data.get("target")),
            risk_chf=_as_opt_float(data.get("risk_chf")),
            setup=_as_str(data.get("setup")),
            emotion=_as_str(data.get("emotion")),
            forced_warnings=_as_str_list(data.get("forced_warnings")),
        )


@dataclass
class Order:
    """Un ordre passé par l'utilisateur, en attente ou déjà exécuté.

    ``thesis`` (la raison écrite AVANT l'entrée) et ``stop_loss`` sont volontairement
    dans l'ordre : le coach les exige, ils ne sont pas décoratifs.
    """

    id: str
    symbol: str
    side: str = "buy"
    kind: str = "market"
    qty: int = 0
    limit_price: Optional[float] = None
    stop_price: Optional[float] = None
    created_at: str = ""
    status: str = "open"
    thesis: str = ""
    stop_loss: Optional[float] = None
    target: Optional[float] = None
    risk_chf: Optional[float] = None
    currency: str = DEFAULT_CURRENCY
    fee_profile: str = DEFAULT_FEE_PROFILE
    # Étiquettes du journal (LOT 2, B2/B3) — transférées à la ``Position`` que
    # l'ordre crée ou renforce (cf. ``_open_long``/``_open_short``/``_average_into``).
    setup: str = ""
    emotion: str = ""
    # LOT 3, C3 — cf. le même champ sur ``Position`` : posé par le router quand
    # l'ordre passe malgré des avertissements pré-ordre (``confirmed: true``).
    forced_warnings: List[str] = field(default_factory=list)

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: Optional[Dict[str, Any]]) -> "Order":
        data = data or {}
        return cls(
            id=_as_str(data.get("id")),
            symbol=_as_str(data.get("symbol")),
            side=_as_str(data.get("side"), "buy"),
            kind=_as_str(data.get("kind"), "market"),
            qty=_as_int(data.get("qty")),
            limit_price=_as_opt_float(data.get("limit_price")),
            stop_price=_as_opt_float(data.get("stop_price")),
            created_at=_as_str(data.get("created_at")),
            status=_as_str(data.get("status"), "open"),
            thesis=_as_str(data.get("thesis")),
            stop_loss=_as_opt_float(data.get("stop_loss")),
            target=_as_opt_float(data.get("target")),
            risk_chf=_as_opt_float(data.get("risk_chf")),
            currency=_as_str(data.get("currency"), DEFAULT_CURRENCY),
            fee_profile=_as_str(data.get("fee_profile"), DEFAULT_FEE_PROFILE),
            setup=_as_str(data.get("setup")),
            emotion=_as_str(data.get("emotion")),
            forced_warnings=_as_str_list(data.get("forced_warnings")),
        )


@dataclass
class Trade:
    """Une position CLÔTURÉE — la matière première du coach.

    ``r_multiple`` = résultat / risque initial planifié. C'est LA métrique qui
    enseigne le risque ; elle vaut ``None`` quand aucun stop n'avait été planifié
    (et cette absence est elle-même un signal pour le coach).
    """

    symbol: str
    side: str = "long"
    qty: int = 0
    entry_price: float = 0.0
    exit_price: float = 0.0
    entry_at: str = ""
    exit_at: str = ""
    fees_chf: float = 0.0
    stamp_duty_chf: float = 0.0
    pnl_chf: float = 0.0
    pnl_pct: float = 0.0
    r_multiple: Optional[float] = None
    thesis: str = ""
    exit_reason: str = ""
    planned_stop: Optional[float] = None
    currency: str = DEFAULT_CURRENCY
    fx_rate: float = 1.0
    # Étiquettes du journal (LOT 2, B2/B3) — ``setup``/``emotion`` viennent de
    # la position (l'intention à l'ENTRÉE) ; ``emotion_close`` n'existe que sur
    # une clôture MANUELLE (``/positions/{symbol}/close``) — un fill mécanique
    # (stop, limite, tick) n'a pas d'émotion, cf. ``paper_router.close_position``.
    setup: str = ""
    emotion: str = ""
    emotion_close: str = ""
    # Excursions (LOT 2, B1/B5) — best-effort depuis les bougies de la période
    # de détention (cf. ``tradestats.excursions``) : ``None`` tant que le cours
    # n'a pas pu être relu, JAMAIS un 0.0 qui prétendrait avoir mesuré quelque
    # chose. ``best_exit_gap_pct`` = ``mfe_pct`` - ``pnl_pct`` (B5).
    mae_pct: Optional[float] = None
    mfe_pct: Optional[float] = None
    best_exit_gap_pct: Optional[float] = None
    # LOT 3, C3 — copié depuis la ``Position`` à la clôture (cf. ``_close_leg``) :
    # ce que Massii avait forcé à L'ENTRÉE. Stocké pour que le score de
    # discipline puisse un jour le lire ; rien ne le consomme encore.
    forced_warnings: List[str] = field(default_factory=list)

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: Optional[Dict[str, Any]]) -> "Trade":
        data = data or {}
        return cls(
            symbol=_as_str(data.get("symbol")),
            side=_as_str(data.get("side"), "long"),
            qty=_as_int(data.get("qty")),
            entry_price=_as_float(data.get("entry_price")),
            exit_price=_as_float(data.get("exit_price")),
            entry_at=_as_str(data.get("entry_at")),
            exit_at=_as_str(data.get("exit_at")),
            fees_chf=_as_float(data.get("fees_chf")),
            stamp_duty_chf=_as_float(data.get("stamp_duty_chf")),
            pnl_chf=_as_float(data.get("pnl_chf")),
            pnl_pct=_as_float(data.get("pnl_pct")),
            r_multiple=_as_opt_float(data.get("r_multiple")),
            thesis=_as_str(data.get("thesis")),
            exit_reason=_as_str(data.get("exit_reason")),
            planned_stop=_as_opt_float(data.get("planned_stop")),
            currency=_as_str(data.get("currency"), DEFAULT_CURRENCY),
            fx_rate=_as_float(data.get("fx_rate"), 1.0),
            setup=_as_str(data.get("setup")),
            emotion=_as_str(data.get("emotion")),
            emotion_close=_as_str(data.get("emotion_close")),
            mae_pct=_as_opt_float(data.get("mae_pct")),
            mfe_pct=_as_opt_float(data.get("mfe_pct")),
            best_exit_gap_pct=_as_opt_float(data.get("best_exit_gap_pct")),
            forced_warnings=_as_str_list(data.get("forced_warnings")),
        )


@dataclass
class Portfolio:
    """L'état complet d'un portefeuille fictif (ce qui est persisté sur disque)."""

    cash_chf: float = DEFAULT_CAPITAL
    positions: List[Position] = field(default_factory=list)
    open_orders: List[Order] = field(default_factory=list)
    trades: List[Trade] = field(default_factory=list)
    fee_profile: str = DEFAULT_FEE_PROFILE
    initial_capital: float = DEFAULT_CAPITAL
    created_at: str = ""

    def to_dict(self) -> Dict[str, Any]:
        """Dictionnaire 100 % JSON-sérialisable (récursif sur les sous-structures)."""
        return {
            "cash_chf": self.cash_chf,
            "positions": [p.to_dict() for p in self.positions],
            "open_orders": [o.to_dict() for o in self.open_orders],
            "trades": [t.to_dict() for t in self.trades],
            "fee_profile": self.fee_profile,
            "initial_capital": self.initial_capital,
            "created_at": self.created_at,
        }

    @classmethod
    def from_dict(cls, data: Optional[Dict[str, Any]]) -> "Portfolio":
        """Relit un portefeuille. Tout champ manquant prend son défaut."""
        data = data or {}
        return cls(
            cash_chf=_as_float(data.get("cash_chf"), DEFAULT_CAPITAL),
            positions=[Position.from_dict(d) for d in _as_dict_list(data.get("positions"))],
            open_orders=[Order.from_dict(d) for d in _as_dict_list(data.get("open_orders"))],
            trades=[Trade.from_dict(d) for d in _as_dict_list(data.get("trades"))],
            fee_profile=_as_str(data.get("fee_profile"), DEFAULT_FEE_PROFILE),
            initial_capital=_as_float(data.get("initial_capital"), DEFAULT_CAPITAL),
            created_at=_as_str(data.get("created_at")),
        )
