"""Router du simulateur de paper trading + coach (spec §9 et §11).

Préfixe ``/api/paper``, tout gated ``require_role("admin", "money")`` — la
convention des trois autres bots finance (Yield, Bond Scanner, Market Pulse).

**Ce que le router fait, et ce qu'il ne fait pas.** Il orchestre : il lit l'état,
appelle les modules PURS (``fees``/``fills``/``risk``/``coach``), et persiste. Il
ne contient aucune règle de marché — celles-ci vivent dans les modules purs, où
elles sont testables sans HTTP. Ce qui vit ici, ce sont les décisions
d'orchestration : quel prix sert pour quel ordre, quand la caisse refuse, quand
le coach apprend.

**Trois invariants à ne pas défaire :**

1. *on avertit, on ne bloque jamais* — une thèse absente, un stop absent, une
   taille trop grosse produisent des ``warnings``, pas des refus. Seule
   l'infaisabilité (cash, quantité, marge) rend 400. C'est la position morale de
   la spec §2 : le coach pousse vers le risque MESURÉ, pas vers l'abstinence.
2. *le tick n'explose jamais* — un symbole dont le cours est indisponible est
   sauté, les autres continuent. Un tick qui rend 502 gèlerait tous les ordres
   du portefeuille pour un seul titre en panne.
3. *le LLM est hors de la boucle* — il rédige (post-mortem, fiche, réponse du
   coach), il ne décide de rien. Toute panne de sa part rend un 502 propre.

Le P&L d'un trade est calculé avec UN SEUL taux de change (celui du jour) :
le simulateur enseigne le mouvement du TITRE, pas la spéculation sur le change.
Les flux de trésorerie réels, eux, portent bien le taux de chaque transaction.
"""
import hashlib
import json
import logging
import time
import uuid
from datetime import datetime
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from backend.auth.models import User
from backend.auth.permissions import require_role
from backend.bots.paper import (alerts, board, coach, fees, fills, graph,
                                idea_journal, llm, models, quotes, risk, store)

logger = logging.getLogger("omenserver")

router = APIRouter(prefix="/api/paper", tags=["paper"])

_PAPER_DIR = Path(__file__).resolve().parent / "paper"
LESSONS_PATH = _PAPER_DIR / "lessons_fr.json"
ARENA_PATH = _PAPER_DIR / "arena.json"

# Contenu pédagogique par langue. L'ANGLAIS n'a volontairement pas de fichier :
# il retombe sur le français (repli SILENCIEUX, cf. ``content_lang``) — la
# demande est « italien d'abord, l'anglais on laisse tomber », et servir une
# traduction anglaise bâclée serait pire que d'assumer le repli.
LESSONS_PATHS = {"fr": LESSONS_PATH, "it": _PAPER_DIR / "lessons_it.json"}
ARENA_PATHS = {"fr": ARENA_PATH, "it": _PAPER_DIR / "arena_it.json"}

# Seuils d'AVERTISSEMENT (jamais de blocage — cf. invariant 1).
CONCENTRATION_PCT = 25.0     # une ligne qui pèse plus d'un quart du portefeuille
OVERSIZED_PCT = 2.0          # risque planifié au-delà de 2 % du capital initial
MIN_THESIS_LEN = 15          # même seuil que coach._NO_THESIS_MIN_LEN

MAX_QUOTE_SYMBOLS = 20
MIN_SEARCH_LEN = 2

# Watchlist : bornée pour rester une liste de titres à CREUSER, pas un
# fourre-tout qui finirait par ne plus rien dire au coach.
MAX_WATCHLIST = 30

# Horizon par défaut d'une idée de trade sans horizon exploitable dans le
# JSON du LLM — même ordre de grandeur que ``radar.DEFAULT_HORIZON_D``.
DEFAULT_IDEA_HORIZON_D = 7

# Fenêtres autorisées pour le graphique. Liste FERMÉE : on ne proxifie pas
# Yahoo en aveugle — un paramètre libre transformerait l'endpoint en relais
# ouvert vers un service tiers, avec notre IP au bout.
CANDLE_RANGES = ("1d", "5d", "1mo", "6mo", "1y", "5y")
CANDLE_INTERVALS = ("15m", "1h", "1d", "1wk")

# Fenêtre lue par le tick : la journée en cours, par tranches de 15 minutes.
# Assez fin pour voir un stop sauter, assez court pour ne pas relire l'histoire.
TICK_RANGE = "1d"
TICK_INTERVAL = "15m"

_SEVERITY_ORDER = {"critical": 0, "warn": 1, "info": 2}

# Cache mémoire du contenu pédagogique (fichiers statiques versionnés), UNE
# entrée par langue effectivement servie.
_lessons_cache: Dict[str, List[Dict[str, Any]]] = {}
_arena_cache: Dict[str, List[Dict[str, Any]]] = {}


class OrderError(Exception):
    """Refus MÉTIER d'un ordre (trésorerie, quantité, marge, incohérence).

    Distinct d'une panne de cours : un OrderError devient un 400 avec un message
    lisible, parce que c'est l'utilisateur qui doit corriger quelque chose.
    """


# --------------------------------------------------------------------------- #
# Horloge et dates
# --------------------------------------------------------------------------- #
def _now_iso() -> str:
    """Horodatage local à la seconde. Fonction module -> monkeypatchable."""
    return datetime.now().isoformat(timespec="seconds")


def _parse_iso(value: Any) -> Optional[datetime]:
    """ISO -> datetime, ou ``None``. Le suffixe ``Z`` est retiré (Python 3.9 ne
    sait pas le lire) : nos horodatages viennent tous de ``datetime.now()``."""
    if not isinstance(value, str):
        return None
    text = value.strip()
    if not text:
        return None
    if text[-1] in ("Z", "z"):
        text = text[:-1]
    try:
        return datetime.fromisoformat(text)
    except (TypeError, ValueError):
        return None


def _epoch(value: Any) -> Optional[float]:
    """ISO -> epoch (secondes), pour se comparer aux ``ts`` des bougies Yahoo."""
    parsed = _parse_iso(value)
    if parsed is None:
        return None
    try:
        return parsed.timestamp()
    except (OSError, OverflowError, ValueError):
        return None


def _week_id(moment: datetime) -> str:
    """Semaine ISO au format ``2026-W34`` — l'identifiant du défi d'Arène."""
    parts = moment.isocalendar()
    return "%04d-W%02d" % (parts[0], parts[1])


def _week_of(value: Any) -> Optional[str]:
    parsed = _parse_iso(value)
    return _week_id(parsed) if parsed is not None else None


# --------------------------------------------------------------------------- #
# État (chargement / création / persistance)
# --------------------------------------------------------------------------- #
def new_portfolio(initial_capital: Optional[float] = None,
                  fee_profile: Optional[str] = None,
                  now_iso: Optional[str] = None) -> models.Portfolio:
    """Un portefeuille neuf. Le carnet et le profil du coach ne sont PAS touchés
    (c'est la mémoire : elle survit à toutes les remises à zéro)."""
    capital = models.DEFAULT_CAPITAL if initial_capital is None else float(initial_capital)
    return models.Portfolio(
        cash_chf=capital,
        initial_capital=capital,
        fee_profile=(fee_profile or models.DEFAULT_FEE_PROFILE),
        created_at=now_iso or _now_iso(),
    )


def _load(username: str) -> models.Portfolio:
    raw = store.load_portfolio(username)
    if raw is None:
        return new_portfolio()
    return models.Portfolio.from_dict(raw)


def _save(username: str, portfolio: models.Portfolio) -> None:
    store.save_portfolio(username, portfolio.to_dict())


def _find_position(portfolio: models.Portfolio, symbol: str,
                   side: Optional[str] = None) -> Optional[models.Position]:
    for position in portfolio.positions:
        if position.symbol != symbol:
            continue
        if side is not None and position.side != side:
            continue
        return position
    return None


def _positions_value_chf(portfolio: models.Portfolio, side: str) -> float:
    """Valeur au PRIX DE REVIENT des lignes d'un sens donné (pas de réseau)."""
    total = 0.0
    for position in portfolio.positions:
        if position.side != side:
            continue
        total += abs(position.qty) * position.avg_price * (position.fx_rate or 1.0)
    return total


# --------------------------------------------------------------------------- #
# Décisions pures (testables sans HTTP)
# --------------------------------------------------------------------------- #
def estimate_entry_price(kind: str, limit_price: Optional[float],
                         stop_price: Optional[float],
                         quote_price: Optional[float]) -> Optional[float]:
    """Prix d'entrée ESTIMÉ d'un ordre — sert à chiffrer le risque à l'avance.

    Pour un ordre à seuil, l'estimation est le seuil lui-même : c'est le prix que
    l'utilisateur a en tête quand il pose son stop. Le prix réel d'exécution,
    lui, sortira de ``fills.try_fill`` (et pourra être pire à cause d'un gap —
    c'est justement la leçon).
    """
    if kind == "limit" and limit_price is not None:
        return float(limit_price)
    if kind == "stop" and stop_price is not None:
        return float(stop_price)
    return None if quote_price is None else float(quote_price)


def planned_risk_chf(entry_price: Optional[float], stop_loss: Optional[float],
                     qty: int, fx_rate: float) -> Optional[float]:
    """Ce que l'utilisateur accepte de perdre, en francs, si le stop saute.

    ``None`` sans stop planifié : sans niveau d'invalidation, le risque n'est pas
    « petit », il est INCONNU — et c'est ce que l'avertissement ``no_stop`` dit.
    """
    if entry_price is None or stop_loss is None:
        return None
    try:
        return round(abs(float(entry_price) - float(stop_loss)) * int(qty) * float(fx_rate), 2)
    except (TypeError, ValueError):
        return None


def compute_warnings(side: str, thesis: str, stop_loss: Optional[float],
                     risk_chf: Optional[float], initial_capital: float,
                     projected_value_chf: Optional[float],
                     equity_chf: Optional[float]) -> List[str]:
    """Codes d'avertissement d'un ordre — le front les traduit (i18n).

    Uniquement sur les ordres d'OUVERTURE : une sortie n'a besoin ni de thèse ni
    de stop, et elle réduit la concentration au lieu de l'augmenter.
    """
    if side not in ("buy", "short"):
        return []

    out: List[str] = []
    if len(str(thesis or "").strip()) < MIN_THESIS_LEN:
        out.append("no_thesis")
    if stop_loss is None:
        out.append("no_stop")
    if risk_chf is not None and initial_capital > 0 \
            and risk_chf > initial_capital * OVERSIZED_PCT / 100.0:
        out.append("oversized")
    if projected_value_chf is not None and equity_chf and equity_chf > 0 \
            and projected_value_chf > equity_chf * CONCENTRATION_PCT / 100.0:
        out.append("concentration")
    return out


def _fees_for(profile: str, notional_chf: float, symbol: str) -> Dict[str, float]:
    """Frais d'une transaction ; un profil inconnu retombe sur le défaut en le
    signalant (un portefeuille ancien ne doit pas devenir inutilisable)."""
    try:
        return fees.compute_fees(profile, notional_chf, symbol)
    except ValueError:
        logger.warning("paper: profil de frais inconnu %r -> repli sur %s",
                       profile, models.DEFAULT_FEE_PROFILE)
        return fees.compute_fees(models.DEFAULT_FEE_PROFILE, notional_chf, symbol)


def execute_order(portfolio: models.Portfolio, order: models.Order,
                  price: float, fx_rate: float, now_iso: str,
                  exit_reason: str = "manual") -> Dict[str, Any]:
    """Exécute ``order`` au prix donné. MUTE ``portfolio``. Lève ``OrderError``.

    Rend le détail de l'exécution (``fill``) : montant, frais, et le ``Trade``
    produit quand l'ordre CLÔTURE tout ou partie d'une position.
    """
    symbol = order.symbol
    qty = int(order.qty)
    if qty <= 0:
        raise OrderError("Quantité invalide.")
    side = order.side
    profile = order.fee_profile or portfolio.fee_profile
    currency = order.currency or models.DEFAULT_CURRENCY

    notional = abs(qty * float(price) * float(fx_rate))
    fee = _fees_for(profile, notional, symbol)

    fill: Dict[str, Any] = {
        "symbol": symbol,
        "side": side,
        "qty": qty,
        "price": float(price),
        "currency": currency,
        "fx_rate": float(fx_rate),
        "notional_chf": round(notional, 2),
        "fees": fee,
        "exit_reason": None,
        "trade": None,
    }

    if side == "buy":
        _open_long(portfolio, order, price, fx_rate, notional, fee, now_iso)
    elif side == "short":
        _open_short(portfolio, order, price, fx_rate, notional, fee, now_iso)
    elif side in ("sell", "cover"):
        trade = _close_leg(portfolio, order, price, fx_rate, notional, fee,
                           now_iso, exit_reason)
        fill["trade"] = trade.to_dict()
        fill["exit_reason"] = trade.exit_reason
    else:
        raise OrderError("Sens d'ordre inconnu: %s" % side)

    return fill


def _open_long(portfolio, order, price, fx_rate, notional, fee, now_iso) -> None:
    symbol = order.symbol
    if _find_position(portfolio, symbol, "short") is not None:
        raise OrderError("Une position short existe sur %s : utilise 'cover' pour "
                         "la racheter." % symbol)
    cost = notional + fee["total_chf"]
    if portfolio.cash_chf + 1e-9 < cost:
        raise OrderError("Trésorerie insuffisante : %.2f CHF nécessaires "
                         "(frais compris), %.2f CHF disponibles."
                         % (cost, portfolio.cash_chf))

    position = _find_position(portfolio, symbol, "long")
    if position is None:
        portfolio.positions.append(models.Position(
            symbol=symbol, qty=int(order.qty), avg_price=float(price),
            currency=order.currency or models.DEFAULT_CURRENCY,
            fx_rate=float(fx_rate), opened_at=now_iso, side="long",
            thesis=order.thesis, stop_loss=order.stop_loss,
            target=order.target, risk_chf=order.risk_chf))
    else:
        _average_into(position, order, price, fx_rate)
    portfolio.cash_chf = round(portfolio.cash_chf - cost, 2)


def _open_short(portfolio, order, price, fx_rate, notional, fee, now_iso) -> None:
    symbol = order.symbol
    if _find_position(portfolio, symbol, "long") is not None:
        raise OrderError("Une position longue existe sur %s : vends-la avant de "
                         "shorter." % symbol)

    # Règle de marge du simulateur : la somme des ventes à découvert ne dépasse
    # jamais l'équité (cash + valeur des lignes longues). Sans plafond, un short
    # serait gratuit — et le short est justement la position dont la perte est
    # théoriquement illimitée.
    shorts = _positions_value_chf(portfolio, "short")
    equity = portfolio.cash_chf + _positions_value_chf(portfolio, "long")
    if shorts + notional > equity + 1e-9:
        raise OrderError("Marge insuffisante : %.2f CHF de ventes à découvert "
                         "demandées au total pour %.2f CHF d'équité."
                         % (shorts + notional, equity))

    position = _find_position(portfolio, symbol, "short")
    if position is None:
        portfolio.positions.append(models.Position(
            symbol=symbol, qty=int(order.qty), avg_price=float(price),
            currency=order.currency or models.DEFAULT_CURRENCY,
            fx_rate=float(fx_rate), opened_at=now_iso, side="short",
            thesis=order.thesis, stop_loss=order.stop_loss,
            target=order.target, risk_chf=order.risk_chf))
    else:
        _average_into(position, order, price, fx_rate)
    portfolio.cash_chf = round(portfolio.cash_chf + notional - fee["total_chf"], 2)


def _average_into(position: models.Position, order: models.Order,
                  price: float, fx_rate: float) -> None:
    """Renforce une ligne existante : prix de revient pondéré, plan mis à jour.

    La devise doit être la MÊME : deux cotations d'un même titre dans deux
    devises ne se moyennent pas (le prix de revient n'aurait plus d'unité).
    """
    if position.currency != (order.currency or position.currency):
        raise OrderError("Devise incohérente sur %s : position en %s, ordre en %s."
                         % (position.symbol, position.currency, order.currency))
    total = position.qty + int(order.qty)
    if total <= 0:
        raise OrderError("Quantité résultante invalide.")
    position.avg_price = (position.avg_price * position.qty
                          + float(price) * int(order.qty)) / float(total)
    position.qty = total
    position.fx_rate = float(fx_rate)
    if order.thesis:
        position.thesis = order.thesis
    if order.stop_loss is not None:
        position.stop_loss = order.stop_loss
    if order.target is not None:
        position.target = order.target
    if order.risk_chf is not None:
        position.risk_chf = order.risk_chf


def _close_leg(portfolio, order, price, fx_rate, notional, fee,
               now_iso, exit_reason) -> models.Trade:
    """Clôture (totale ou partielle) et produit le ``Trade`` pédagogique.

    Les frais du ``Trade`` AGRÈGENT l'entrée et la sortie (recalculés sur le
    notional d'entrée de la quantité clôturée) : c'est le coût complet de
    l'aller-retour, celui qui enseigne. Les flux de trésorerie, eux, restent
    ceux réellement payés à chaque transaction — l'entrée avait déjà été
    débitée au moment de l'achat.
    """
    symbol = order.symbol
    qty = int(order.qty)
    wanted = "long" if order.side == "sell" else "short"
    position = _find_position(portfolio, symbol, wanted)
    if position is None:
        raise OrderError("Aucune position %s sur %s." % (wanted, symbol))
    if qty > position.qty:
        raise OrderError("Quantité supérieure à la position (%d détenus sur %s)."
                         % (position.qty, symbol))

    entry_notional = abs(qty * position.avg_price * float(fx_rate))
    entry_fee = _fees_for(order.fee_profile or portfolio.fee_profile,
                          entry_notional, symbol)

    if position.side == "long":
        gross = (float(price) - position.avg_price) * qty * float(fx_rate)
    else:
        gross = (position.avg_price - float(price)) * qty * float(fx_rate)

    brokerage = round(fee["brokerage_chf"] + entry_fee["brokerage_chf"], 2)
    stamp = round(fee["stamp_duty_chf"] + entry_fee["stamp_duty_chf"], 2)
    pnl = round(gross - brokerage - stamp, 2)
    pnl_pct = round(pnl / entry_notional * 100.0, 2) if entry_notional > 0 else 0.0

    trade = models.Trade(
        symbol=symbol,
        side=position.side,
        qty=qty,
        entry_price=position.avg_price,
        exit_price=float(price),
        entry_at=position.opened_at,
        exit_at=now_iso,
        fees_chf=brokerage,
        stamp_duty_chf=stamp,
        pnl_chf=pnl,
        pnl_pct=pnl_pct,
        r_multiple=risk.r_multiple(position.avg_price, float(price),
                                   position.stop_loss, position.side),
        thesis=position.thesis,
        exit_reason=exit_reason,
        planned_stop=position.stop_loss,
        currency=position.currency,
        fx_rate=float(fx_rate),
    )
    portfolio.trades.append(trade)

    if position.side == "long":
        portfolio.cash_chf = round(portfolio.cash_chf + notional - fee["total_chf"], 2)
    else:
        portfolio.cash_chf = round(portfolio.cash_chf - notional - fee["total_chf"], 2)

    position.qty -= qty
    if position.qty <= 0:
        portfolio.positions = [p for p in portfolio.positions if p is not position]
    return trade


def close_position(portfolio: models.Portfolio, position: models.Position,
                   qty: int, price: float, fx_rate: float, now_iso: str,
                   exit_reason: str = "manual") -> Dict[str, Any]:
    """Clôture au marché — passe par le MÊME chemin que n'importe quel ordre.

    Un seul code d'exécution : une sortie déclenchée par un stop, par le
    dashboard ou par un ordre limite produit exactement le même ``Trade``.
    """
    order = models.Order(
        id=uuid.uuid4().hex,
        symbol=position.symbol,
        side=("sell" if position.side == "long" else "cover"),
        kind="market",
        qty=int(qty),
        created_at=now_iso,
        status="filled",
        currency=position.currency,
        fee_profile=portfolio.fee_profile,
    )
    return execute_order(portfolio, order, price, fx_rate, now_iso, exit_reason)


# --------------------------------------------------------------------------- #
# Tick — ordres en attente et stops de protection
# --------------------------------------------------------------------------- #
def _exit_reason_for(order: models.Order) -> str:
    if order.kind == "limit":
        return "limit_fill"
    if order.kind == "stop":
        return "stop"
    return "manual"


def _window(candles: List[Dict[str, Any]], since: Optional[float]) -> List[Dict[str, Any]]:
    """Bougies POSTÉRIEURES à ``since``, en ordre chronologique.

    Sans ce filtre, un ordre posé cet après-midi serait exécuté contre la bougie
    de ce matin — l'utilisateur gagnerait sur des prix qu'il n'a jamais vus.
    """
    rows = sorted([c for c in (candles or []) if isinstance(c, dict)],
                  key=lambda c: c.get("ts") or 0)
    if since is None:
        return rows
    return [c for c in rows if (c.get("ts") or 0) > since]


def run_tick(portfolio: models.Portfolio, now_iso: str,
             fetch_candles: Callable[[str], List[Dict[str, Any]]],
             fetch_fx: Callable[[str], float]) -> Dict[str, List[Dict[str, Any]]]:
    """Confronte les ordres ouverts et les stops aux bougies récentes.

    Ne lève JAMAIS : un symbole en panne est consigné dans ``errors`` et les
    autres continuent (invariant 2). Un ordre devenu infaisable (la trésorerie a
    fondu entre-temps) est ANNULÉ, pas exécuté à découvert.
    """
    filled: List[Dict[str, Any]] = []
    stopped: List[Dict[str, Any]] = []
    cancelled: List[Dict[str, Any]] = []
    errors: List[Dict[str, Any]] = []
    cache: Dict[str, Optional[List[Dict[str, Any]]]] = {}

    def candles_for(symbol: str) -> Optional[List[Dict[str, Any]]]:
        if symbol not in cache:
            try:
                cache[symbol] = list(fetch_candles(symbol) or [])
            except Exception as e:            # cours indisponible: on saute
                cache[symbol] = None
                errors.append({"symbol": symbol, "error": str(e)[:200]})
        return cache[symbol]

    for order in list(portfolio.open_orders):
        if order.status != "open":
            continue
        candles = candles_for(order.symbol)
        if not candles:
            continue
        for candle in _window(candles, _epoch(order.created_at)):
            try:
                price = fills.try_fill(order.to_dict(), candle)
            except ValueError as e:           # ordre corrompu: on ne devine pas
                errors.append({"symbol": order.symbol, "error": str(e)[:200]})
                break
            if price is None:
                continue
            try:
                fx_rate = fetch_fx(order.currency)
            except Exception as e:
                errors.append({"symbol": order.symbol, "error": str(e)[:200]})
                break
            try:
                fill = execute_order(portfolio, order, price, fx_rate, now_iso,
                                     _exit_reason_for(order))
            except OrderError as e:
                order.status = "cancelled"
                cancelled.append({"order_id": order.id, "symbol": order.symbol,
                                  "reason": str(e)})
            else:
                order.status = "filled"
                fill["order_id"] = order.id
                filled.append(fill)
            portfolio.open_orders = [o for o in portfolio.open_orders if o is not order]
            break

    for position in list(portfolio.positions):
        if position.stop_loss is None:
            continue
        candles = candles_for(position.symbol)
        if not candles:
            continue
        for candle in _window(candles, _epoch(position.opened_at)):
            try:
                exit_price = fills.check_protective_stops(position.to_dict(),
                                                          position.stop_loss, candle)
            except ValueError as e:
                errors.append({"symbol": position.symbol, "error": str(e)[:200]})
                break
            if exit_price is None:
                continue
            try:
                fx_rate = fetch_fx(position.currency)
            except Exception as e:
                errors.append({"symbol": position.symbol, "error": str(e)[:200]})
                break
            try:
                stopped.append(close_position(portfolio, position, position.qty,
                                              exit_price, fx_rate, now_iso, "stop"))
            except OrderError as e:
                errors.append({"symbol": position.symbol, "error": str(e)})
            break

    return {"fills": filled, "stopped": stopped, "cancelled": cancelled,
            "errors": errors}


# --------------------------------------------------------------------------- #
# Coach — synchronisation du profil et du carnet
# --------------------------------------------------------------------------- #
# 9ᵉ règle de biais : sa phrase de preuve vit ici (et pas dans les gabarits de
# ``coach.py``) parce que la RÈGLE elle-même vit ici — les deux doivent rester
# au même endroit, sinon la prochaine traduction en oubliera une moitié.
_CONCENTRATION_EVIDENCE = {
    "fr": "{symbol} pèse {pct:.1f}% du portefeuille (seuil {threshold:.0f}%)",
    "it": "{symbol} pesa il {pct:.1f}% del portafoglio (soglia {threshold:.0f}%)",
}


def _with_concentration(biases: List[Dict[str, Any]],
                        exposure: Dict[str, Any],
                        lang: str = "fr") -> List[Dict[str, Any]]:
    """Complète les biais déterministes par la CONCENTRATION.

    ``coach.detect_biases`` ne peut pas la calculer : elle demande la valeur de
    marché des lignes, donc le réseau. C'est le seul biais dont la détection
    vit ici — et c'est pour ça qu'elle est isolée dans une fonction pure.
    """
    top = float(exposure.get("max_concentration_pct") or 0.0)
    if top <= CONCENTRATION_PCT:
        return list(biases)

    per = exposure.get("per_position_pct") or {}
    worst = max(per.items(), key=lambda kv: kv[1])[0] if per else "?"
    template = _CONCENTRATION_EVIDENCE.get(normalize_lang(lang),
                                           _CONCENTRATION_EVIDENCE["fr"])
    out = list(biases) + [{
        "code": "concentration",
        "severity": "warn",
        "evidence": [template.format(symbol=worst, pct=top,
                                     threshold=CONCENTRATION_PCT)],
        "metric": round(top / 100.0, 4),
    }]
    out.sort(key=lambda b: _SEVERITY_ORDER.get(b.get("severity"), 99))
    return out


def _safe_bias_note(username: str, code: str, entry: str) -> None:
    """Écrit une page de biais ; un code exotique est ignoré, jamais fatal."""
    try:
        store.append_note(username, "Biais/%s.md" % code, entry)
    except (ValueError, OSError) as e:
        logger.warning("paper: note de biais %r non écrite: %s", code, e)


def _sync_coach(username: str, portfolio: Dict[str, Any],
                now_iso: Optional[str] = None,
                force: bool = False) -> Dict[str, Any]:
    """Fait grandir le profil du coach et APPEND le carnet Markdown (§11).

    Ne fait un vrai passage que si de NOUVEAUX trades sont apparus depuis la
    dernière synchronisation — ou si ``force`` (une session de coaching compte
    même sans nouveau trade). Sans ce garde-fou, chaque appel d'API incrémenterait
    ``n_sessions`` et ré-appenderait les mêmes pages de biais : le carnet
    deviendrait illisible en une journée.

    Rend ``{profile, biases, stats, synced}``.
    """
    now = now_iso or _now_iso()
    profile = store.load_coach(username) or coach.empty_profile()

    trades = portfolio.get("trades") or []
    orders = portfolio.get("open_orders") or []
    capital = portfolio.get("initial_capital") or models.DEFAULT_CAPITAL

    biases = coach.detect_biases(trades, orders, capital)
    stats = risk.portfolio_stats(trades, initial_capital=capital)

    try:
        last_synced = int(profile.get("last_synced_trades") or 0)
    except (TypeError, ValueError):
        last_synced = 0
    if not force and len(trades) <= last_synced:
        return {"profile": profile, "biases": biases, "stats": stats, "synced": False}

    new_profile = coach.update_profile(profile, biases, stats, now)

    # --- diff : une page de biais n'est appendée que si le compteur a MONTÉ.
    old_history = profile.get("bias_history") or {}
    new_history = new_profile.get("bias_history") or {}
    for bias in biases:
        code = bias.get("code") or ""
        before = int((old_history.get(code) or {}).get("count") or 0)
        after = int((new_history.get(code) or {}).get("count") or 0)
        if after > before:
            _safe_bias_note(username, code, coach.bias_note_entry(bias, now))

    # --- résolutions nouvelles (le coach félicite, une seule fois)
    old_resolved = {(r.get("code"), r.get("resolved_at"))
                    for r in (profile.get("resolved_biases") or [])}
    for resolved in (new_profile.get("resolved_biases") or []):
        key = (resolved.get("code"), resolved.get("resolved_at"))
        if key in old_resolved:
            continue
        _safe_bias_note(username, resolved.get("code") or "",
                        coach.resolution_note_entry(resolved.get("code") or "?", now))

    # --- jalons nouveaux -> une entrée de journal
    old_keys = {m.get("key") for m in (profile.get("milestones") or [])}
    for milestone in (new_profile.get("milestones") or []):
        key = milestone.get("key")
        if key in old_keys:
            continue
        _append_journal(username, "jalon atteint",
                        "Jalon **%s** atteint (%s trades clôturés, espérance %s R)."
                        % (key, stats.get("n_trades"), stats.get("expectancy_r")), now)

    new_profile["last_synced_trades"] = len(trades)
    store.save_coach(username, new_profile)
    return {"profile": new_profile, "biases": biases, "stats": stats, "synced": True}


def _append_journal(username: str, title: str, body: str, now_iso: str) -> None:
    """Ajoute une entrée au ``Journal.md``. Best-effort : le carnet ne doit
    jamais faire échouer la réponse HTTP qu'il documente."""
    try:
        store.append_note(username, "Journal.md",
                          coach.journal_entry(title, body, now_iso))
    except (ValueError, OSError) as e:
        logger.warning("paper: entrée de journal non écrite: %s", e)


def _append_discussion(username: str, question: str, answer: str, now_iso: str) -> None:
    """Ajoute la question et la réponse du coach à ``Discussions.md``.

    Carnet PARTAGÉ entre tous les traders (décision utilisateur) : lu par
    n'importe qui via ``/community`` (cf. ``store.list_vault_users``) —
    contrairement au portefeuille (argent + positions), qui reste strictement
    privé et n'est touché nulle part ici.

    ``coach.py`` n'expose aucun générateur pour ce format Q/A (à la différence
    de ``journal_entry``/``bias_note_entry``, pensés pour un titre + un corps
    déjà rédigé) : le bloc est construit ici, dans le même esprit visuel (date
    courte en tête de ligne ``##``). Best-effort comme ``_append_journal`` :
    un échec d'écriture ne casse jamais la réponse HTTP déjà obtenue du LLM.
    """
    date = str(now_iso or "")[:10] or "date inconnue"
    entry = ("## %s — Question de %s\n\n**Q :** %s\n\n**Coach :** %s\n"
             % (date, username, question, answer))
    try:
        store.append_note(username, "Discussions.md", entry)
    except (ValueError, OSError) as e:
        logger.warning("paper: discussion non persistée: %s", e)


def _coach_context(portfolio: models.Portfolio, profile: Dict[str, Any],
                   biases: List[Dict[str, Any]],
                   stats: Dict[str, Any]) -> Dict[str, Any]:
    """Le contexte passé au LLM : des faits déjà calculés, rien de plus."""
    return {
        "stats": stats,
        "biases": biases,
        "coach_summary": coach.coach_summary(profile, biases),
        "last_trades": [t.to_dict() for t in portfolio.trades[-5:]],
        "capital_initial_chf": portfolio.initial_capital,
        "cash_chf": portfolio.cash_chf,
    }


def _watchlist_context(username: str) -> List[Dict[str, Any]]:
    """La watchlist de l'utilisateur, telle quelle (symbol/name/currency/
    added_at) — matière de contexte pour le coach (``/coach/ask``, ``/ideas``).
    Best-effort : un fichier watchlist corrompu ne casse jamais l'appel LLM,
    il rétrécit juste le contexte."""
    try:
        return store.load_watchlist(username)
    except Exception as e:                          # noqa: BLE001 - best-effort
        logger.warning("paper: watchlist indisponible pour le contexte: %s", e)
        return []


# --------------------------------------------------------------------------- #
# Contenu statique : leçons et arène
# --------------------------------------------------------------------------- #
def _load_json_file(path: Path) -> List[Dict[str, Any]]:
    try:
        with open(str(path), "r", encoding="utf-8") as handle:
            data = json.load(handle)
    except (OSError, ValueError) as e:
        logger.error("paper: contenu %s illisible: %s", path.name, e)
        return []
    return [row for row in data if isinstance(row, dict)] if isinstance(data, list) else []


def normalize_lang(value: Any) -> str:
    """Langue DEMANDÉE, normalisée. Inconnue -> ``fr``, jamais d'erreur : une
    langue exotique dans une query string ne doit pas rendre 422 sur du contenu
    pédagogique."""
    return coach.normalize_lang(value)


def content_lang(value: Any, available: Optional[Dict[str, Path]] = None) -> str:
    """Langue effectivement SERVIE pour un contenu statique donné.

    ``en`` est une langue valide de l'interface mais n'a pas de fichier de
    contenu -> repli sur ``fr``. Le repli est silencieux **par contrat** : le
    client demande sa langue, le serveur rend la meilleure disponible.
    """
    lang = normalize_lang(value)
    table = LESSONS_PATHS if available is None else available
    return lang if lang in table else "fr"


def _catalog(paths: Dict[str, Path], cache: Dict[str, List[Dict[str, Any]]],
             lang: Any) -> List[Dict[str, Any]]:
    """Contenu statique d'une langue, mis en cache. Un fichier de traduction
    absent ou illisible retombe sur le FRANÇAIS plutôt que de rendre une liste
    vide : une leçon dans la mauvaise langue reste lisible, une leçon absente
    ne l'est pas."""
    key = content_lang(lang, paths)
    if key not in cache:
        cache[key] = _load_json_file(paths[key]) or _load_json_file(paths["fr"])
    return cache[key]


def lessons_catalog(lang: str = "fr") -> List[Dict[str, Any]]:
    """Catalogue des leçons dans la langue demandée (repli ``fr``)."""
    return _catalog(LESSONS_PATHS, _lessons_cache, lang)


def arena_catalog(lang: str = "fr") -> List[Dict[str, Any]]:
    """Catalogue des défis dans la langue demandée (repli ``fr``)."""
    return _catalog(ARENA_PATHS, _arena_cache, lang)


def public_lesson(lesson: Dict[str, Any]) -> Dict[str, Any]:
    """La leçon telle que le CLIENT a le droit de la voir.

    ``correct`` et ``explain`` sont retirés : la correction se fait côté serveur,
    sinon le quiz s'auto-corrige dans l'onglet réseau du navigateur.
    """
    quiz = []
    for question in (lesson.get("quiz") or []):
        if not isinstance(question, dict):
            continue
        quiz.append({"q": question.get("q", ""),
                     "options": list(question.get("options") or [])})
    return {
        "id": lesson.get("id", ""),
        "title": lesson.get("title", ""),
        "body": lesson.get("body", ""),
        "quiz": quiz,
    }


def grade_quiz(lesson: Dict[str, Any], answers: Optional[List[int]]) -> Dict[str, Any]:
    """Corrige un quiz côté SERVEUR. Une réponse manquante compte comme fausse."""
    answers = list(answers or [])
    quiz = [q for q in (lesson.get("quiz") or []) if isinstance(q, dict)]
    score = 0
    corrections = []
    for index, question in enumerate(quiz):
        correct = question.get("correct")
        given = answers[index] if index < len(answers) else None
        ok = given is not None and given == correct
        if ok:
            score += 1
        corrections.append({"correct": correct,
                            "explain": question.get("explain", ""),
                            "your_answer": given,
                            "ok": ok})
    total = len(quiz)
    return {"score": score, "total": total,
            "passed": total > 0 and score == total,
            "corrections": corrections}


def select_challenge(catalog: List[Dict[str, Any]], week: str) -> Optional[Dict[str, Any]]:
    """Défi de la semaine — DÉTERMINISTE (sha1 de l'ISO-week), spec §10.

    Déterministe pour que la semaine soit la même à chaque rechargement : un
    défi tiré au sort à chaque appel ne serait pas un défi, ce serait un menu.
    """
    if not catalog:
        return None
    digest = hashlib.sha1(week.encode("utf-8")).hexdigest()
    return catalog[int(digest, 16) % len(catalog)]


def _trade_notional_pct(trade: Dict[str, Any], initial_capital: float) -> float:
    if initial_capital <= 0:
        return 0.0
    qty = abs(float(trade.get("qty") or 0))
    price = float(trade.get("entry_price") or 0.0)
    fx_rate = float(trade.get("fx_rate") or 1.0) or 1.0
    return qty * price * fx_rate / initial_capital * 100.0


def evaluate_check(check: Any, week_trades: List[Dict[str, Any]],
                   initial_capital: float) -> str:
    """Évalue la condition d'un défi sur les trades d'UNE semaine.

    Rend ``done`` / ``failed`` / ``na``. ``na`` (et pas ``failed``) quand la
    condition n'est pas reconnue : un défi qu'on ne sait pas mesurer n'est pas
    un défi raté, et afficher un échec inventé serait pire que de ne rien dire.
    """
    text = str(check or "").strip()
    if not text:
        return "na"

    if text == "has_short_trade_week":
        return "done" if any(t.get("side") == "short" for t in week_trades) else "failed"

    for operator in (">=", "<="):
        if operator not in text:
            continue
        name, _, raw = text.partition(operator)
        try:
            threshold = float(raw)
        except (TypeError, ValueError):
            return "na"
        name = name.strip()
        if name == "n_trades_week":
            value = float(len(week_trades))
        elif name == "max_single_trade_notional_pct":
            values = [_trade_notional_pct(t, initial_capital) for t in week_trades]
            value = max(values) if values else 0.0
        else:
            return "na"
        ok = value >= threshold if operator == ">=" else value <= threshold
        return "done" if ok else "failed"
    return "na"


def arena_view(catalog: List[Dict[str, Any]], history: List[Dict[str, Any]],
               trades: List[Dict[str, Any]], initial_capital: float,
               week: str) -> Dict[str, Any]:
    """Le défi de la semaine + l'historique ÉVALUÉ des semaines passées.

    On n'évalue que le PASSÉ : la semaine en cours n'est pas jugée, elle se
    joue encore.
    """
    by_id = {c.get("id"): c for c in catalog}
    by_week: Dict[str, List[Dict[str, Any]]] = {}
    for trade in trades:
        key = _week_of(trade.get("entry_at"))
        if key:
            by_week.setdefault(key, []).append(trade)

    rows = []
    for entry in history:
        entry_week = entry.get("week") or ""
        challenge = by_id.get(entry.get("id")) or {}
        if entry_week >= week:
            status = "en_cours" if entry_week == week else "na"
        else:
            status = evaluate_check(challenge.get("check"),
                                    by_week.get(entry_week, []), initial_capital)
        rows.append({
            "week": entry_week,
            "id": entry.get("id"),
            "title": challenge.get("title", ""),
            "accepted_at": entry.get("accepted_at"),
            "status": status,
        })
    rows.sort(key=lambda r: r.get("week") or "", reverse=True)

    return {
        "week": week,
        "challenge": select_challenge(catalog, week),
        "accepted": any(r["week"] == week for r in rows),
        "history": rows,
    }


# --------------------------------------------------------------------------- #
# Corps des requêtes
# --------------------------------------------------------------------------- #
class OrderPayload(BaseModel):
    symbol: str = ""
    side: str = "buy"
    kind: str = "market"
    qty: int = 0
    limit_price: Optional[float] = None
    stop_price: Optional[float] = None
    stop_loss: Optional[float] = None
    target: Optional[float] = None
    thesis: str = ""
    fee_profile: Optional[str] = None


class ResetPayload(BaseModel):
    initial_capital: Optional[float] = None
    fee_profile: Optional[str] = None


class ClosePayload(BaseModel):
    qty: Optional[int] = None


class AskPayload(BaseModel):
    question: str = ""
    lang: str = "fr"


class PostmortemPayload(BaseModel):
    trade_index: Optional[int] = None
    lang: str = "fr"


class AnalysisPayload(BaseModel):
    symbol: str = ""
    lang: str = "fr"


class QuizPayload(BaseModel):
    answers: List[int] = []
    lang: str = "fr"


class IdeasPayload(BaseModel):
    lang: str = "fr"
    # Étage de risque demandé : "mesure" (défaut) / "agressif" / "speculatif".
    # Normalisé côté serveur — une valeur inconnue retombe sur "mesure", jamais
    # sur un étage plus haut que celui demandé.
    risk_level: str = llm.DEFAULT_RISK_LEVEL


class WatchlistPayload(BaseModel):
    symbol: str = ""


class AlertsModePayload(BaseModel):
    # "calme" (défaut) ou "tout". Normalisé côté serveur — une valeur inconnue
    # retombe sur "calme", jamais sur le mode bavard.
    mode: str = alerts.DEFAULT_MODE


class XAccountsPayload(BaseModel):
    # REMPLACE la liste entière (ce n'est pas un ajout) : l'interface envoie
    # l'état voulu, le serveur valide et renvoie ce qui s'applique vraiment.
    handles: List[str] = []


class ReviewPayload(BaseModel):
    lang: str = "fr"


class BoardItemPayload(BaseModel):
    symbol: str = ""
    thesis: str = ""


class BoardStagePayload(BaseModel):
    # Seules les DEUX étapes manuelles sont acceptées : les trois autres
    # (ordre/position/clos) se méritent, elles ne se déclarent pas.
    stage_manual: str = ""


class BoardScenarioPayload(BaseModel):
    lang: str = "fr"


class BoardBranchPayload(BaseModel):
    status: str = ""


# --------------------------------------------------------------------------- #
# Endpoints — portefeuille
# --------------------------------------------------------------------------- #
@router.get("/portfolio")
def paper_portfolio(lang: str = "fr",
                    current_user: User = Depends(require_role("admin", "money", "trader"))):
    """État complet : positions valorisées, exposition, statistiques, biais, AFC.

    ``lang`` ne pilote QUE les phrases de preuve des biais (les codes restent
    des codes, traduits côté client) — le reste de la réponse est numérique.
    """
    username = current_user.username
    portfolio = _load(username)

    quote_map: Dict[str, Any] = {}
    prices: Dict[str, float] = {}
    fx_rates: Dict[str, float] = {}
    for position in portfolio.positions:
        symbol = position.symbol
        if symbol in quote_map:
            continue
        try:
            quote = quotes.get_quote(symbol)
        except quotes.QuoteError as e:
            # Best-effort : une ligne sans cours garde son prix de revient dans
            # l'exposition (cf. risk.exposure) plutôt que de disparaître du total.
            quote_map[symbol] = {"symbol": symbol, "price": None,
                                 "currency": position.currency, "change_pct": None,
                                 "name": "", "error": str(e)[:200]}
            continue
        quote_map[symbol] = quote
        if quote.get("price") is not None:
            prices[symbol] = quote["price"]
        currency = (quote.get("currency") or position.currency or "").upper()
        if currency and currency not in fx_rates:
            try:
                fx_rates[currency] = quotes.fx_to_chf(currency)
            except quotes.QuoteError:
                pass

    positions = [p.to_dict() for p in portfolio.positions]
    trades = [t.to_dict() for t in portfolio.trades]
    orders = [o.to_dict() for o in portfolio.open_orders]

    exposure = risk.exposure(positions, prices, portfolio.cash_chf, fx_rates)
    stats = risk.portfolio_stats(trades, initial_capital=portfolio.initial_capital)
    afc = risk.afc_counters(trades, positions, portfolio.initial_capital, _now_iso())
    biases = _with_concentration(
        coach.detect_biases(trades, orders, portfolio.initial_capital, lang=lang),
        exposure, lang)

    return {
        "portfolio": portfolio.to_dict(),
        "quotes": quote_map,
        "fx_rates": fx_rates,
        "exposure": exposure,
        "stats": stats,
        "afc": afc,
        "biases": biases,
        "fee_profiles": fees.list_profiles(),
    }


@router.post("/portfolio/reset")
def paper_reset(data: ResetPayload,
                current_user: User = Depends(require_role("admin", "money", "trader"))):
    """Remet le portefeuille à neuf. Le carnet et le profil du coach SURVIVENT —
    c'est la mémoire : elle est justement ce qu'on ne veut pas perdre."""
    capital = data.initial_capital
    if capital is not None and float(capital) <= 0:
        raise HTTPException(status_code=400, detail="Le capital initial doit être positif.")
    profile = data.fee_profile
    if profile is not None and profile not in fees.FEE_PROFILES:
        raise HTTPException(status_code=400,
                            detail="Profil de frais inconnu: %s" % profile)

    portfolio = new_portfolio(capital, profile, _now_iso())
    _save(current_user.username, portfolio)
    return {"portfolio": portfolio.to_dict(), "message": "Portefeuille remis à zéro."}


# --------------------------------------------------------------------------- #
# Endpoints — cours
# --------------------------------------------------------------------------- #
@router.get("/search")
def paper_search(q: str = "",
                 current_user: User = Depends(require_role("admin", "money", "trader"))):
    """Recherche de ticker. Moins de 2 caractères -> liste vide, sans réseau."""
    if len(str(q or "").strip()) < MIN_SEARCH_LEN:
        return []
    try:
        return quotes.search(q)
    except quotes.QuoteError as e:
        raise HTTPException(status_code=502, detail=str(e))


@router.get("/quotes")
def paper_quotes(symbols: str = "",
                 current_user: User = Depends(require_role("admin", "money", "trader"))):
    """Cotations d'une liste de symboles séparés par des virgules (20 maximum)."""
    wanted = [s.strip().upper() for s in str(symbols or "").split(",") if s.strip()]
    out: Dict[str, Any] = {}
    for symbol in wanted[:MAX_QUOTE_SYMBOLS]:
        try:
            quote = quotes.get_quote(symbol)
        except quotes.QuoteError as e:
            out[symbol] = {"symbol": symbol, "price": None, "error": str(e)[:200]}
            continue
        try:
            fx_rate = quotes.fx_to_chf(quote.get("currency") or "")
        except quotes.QuoteError:
            fx_rate = None
        quote["fx_rate_chf"] = fx_rate
        out[symbol] = quote
    return out


@router.get("/candles")
def paper_candles(symbol: str = "", range_: str = "6mo", interval: str = "1d",
                  current_user: User = Depends(require_role("admin", "money", "trader"))):
    """Bougies brutes d'un titre, pour le graphique du frontend.

    Les bougies « à moitié écrites » (séance en cours : ``close`` encore nul)
    sont CONSERVÉES telles que ``quotes.parse_candles`` les rend — les jeter
    ferait reculer la dernière clôture d'une séance et fausserait la variation
    du jour (piège #67a, vécu sur Market Pulse).

    La devise vient de ``get_meta`` en best-effort : un graphique sans étiquette
    de devise reste lisible, un 502 pour ça ne le serait pas.
    """
    wanted = str(symbol or "").strip().upper()
    if not wanted:
        raise HTTPException(status_code=400, detail="Symbole requis.")
    if range_ not in CANDLE_RANGES:
        raise HTTPException(status_code=400,
                            detail="Fenêtre invalide (attendu : %s)."
                                   % ", ".join(CANDLE_RANGES))
    if interval not in CANDLE_INTERVALS:
        raise HTTPException(status_code=400,
                            detail="Intervalle invalide (attendu : %s)."
                                   % ", ".join(CANDLE_INTERVALS))

    try:
        candles = quotes.get_candles(wanted, range_, interval)
    except quotes.UnknownSymbol as e:
        raise HTTPException(status_code=404, detail=str(e))
    except quotes.QuoteError as e:
        raise HTTPException(status_code=502, detail=str(e))

    currency = None
    try:
        currency = (quotes.get_meta(wanted, range_, interval) or {}).get("currency")
    except Exception as e:                      # noqa: BLE001 - étiquette optionnelle
        logger.debug("paper: devise indisponible pour %s (%s)", wanted, e)

    return {"symbol": wanted, "currency": currency, "candles": candles}


# --------------------------------------------------------------------------- #
# Endpoints — ordres et positions
# --------------------------------------------------------------------------- #
@router.post("/orders")
def paper_place_order(data: OrderPayload,
                      current_user: User = Depends(require_role("admin", "money", "trader"))):
    """Passe un ordre. Marché = exécuté tout de suite ; limite/stop = mis en attente.

    On AVERTIT (thèse absente, pas de stop, taille excessive, concentration) mais
    on ne bloque que l'infaisable : trésorerie, quantité, marge.
    """
    username = current_user.username
    symbol = str(data.symbol or "").strip().upper()
    if not symbol:
        raise HTTPException(status_code=400, detail="Symbole manquant.")

    side = str(data.side or "").strip().lower()
    if side not in models.ORDER_SIDES:
        raise HTTPException(status_code=400, detail="Sens d'ordre invalide: %s" % data.side)
    kind = str(data.kind or "").strip().lower()
    if kind not in models.ORDER_KINDS:
        raise HTTPException(status_code=400, detail="Type d'ordre invalide: %s" % data.kind)
    qty = int(data.qty or 0)
    if qty <= 0:
        raise HTTPException(status_code=400, detail="La quantité doit être positive.")
    if kind == "limit" and data.limit_price is None:
        raise HTTPException(status_code=400, detail="Un ordre limite exige un prix limite.")
    if kind == "stop" and data.stop_price is None:
        raise HTTPException(status_code=400, detail="Un ordre stop exige un prix de déclenchement.")

    portfolio = _load(username)
    fee_profile = data.fee_profile or portfolio.fee_profile
    if fee_profile not in fees.FEE_PROFILES:
        raise HTTPException(status_code=400, detail="Profil de frais inconnu: %s" % fee_profile)

    try:
        quote = quotes.get_quote(symbol)
    except quotes.UnknownSymbol as e:
        raise HTTPException(status_code=404, detail=str(e))
    except quotes.QuoteError as e:
        raise HTTPException(status_code=502, detail=str(e))

    currency = quote.get("currency") or models.DEFAULT_CURRENCY
    try:
        fx_rate = quotes.fx_to_chf(currency)
    except quotes.QuoteError as e:
        raise HTTPException(status_code=502, detail=str(e))

    entry_estimate = estimate_entry_price(kind, data.limit_price, data.stop_price,
                                          quote.get("price"))
    risk_chf = planned_risk_chf(entry_estimate, data.stop_loss, qty, fx_rate)

    order = models.Order(
        id=uuid.uuid4().hex,
        symbol=symbol,
        side=side,
        kind=kind,
        qty=qty,
        limit_price=data.limit_price,
        stop_price=data.stop_price,
        created_at=_now_iso(),
        status="open",
        thesis=str(data.thesis or ""),
        stop_loss=data.stop_loss,
        target=data.target,
        risk_chf=risk_chf,
        currency=currency,
        fee_profile=fee_profile,
    )

    # Avertissements calculés sur la PROJECTION (avant exécution) : une position
    # en attente doit être avertie comme une position exécutée.
    projected = None
    if side in ("buy", "short") and entry_estimate is not None:
        existing = _find_position(portfolio, symbol,
                                  "long" if side == "buy" else "short")
        held = existing.qty if existing is not None else 0
        projected = (held + qty) * entry_estimate * fx_rate
    equity = portfolio.cash_chf + _positions_value_chf(portfolio, "long") \
        + _positions_value_chf(portfolio, "short")
    warnings = compute_warnings(side, order.thesis, data.stop_loss, risk_chf,
                                portfolio.initial_capital, projected, equity)

    fill = None
    if kind == "market":
        price = quote.get("price")
        if price is None:
            raise HTTPException(status_code=404, detail="Aucun cours pour %s." % symbol)
        try:
            fill = execute_order(portfolio, order, price, fx_rate, order.created_at,
                                 "manual")
        except OrderError as e:
            raise HTTPException(status_code=400, detail=str(e))
        order.status = "filled"
    else:
        portfolio.open_orders.append(order)

    _save(username, portfolio)
    _sync_coach(username, portfolio.to_dict())
    return {"order": order.to_dict(), "fill": fill, "warnings": warnings}


@router.post("/orders/{order_id}/cancel")
def paper_cancel_order(order_id: str,
                       current_user: User = Depends(require_role("admin", "money", "trader"))):
    """Annule un ordre en attente."""
    username = current_user.username
    portfolio = _load(username)
    target = None
    for order in portfolio.open_orders:
        if order.id == order_id:
            target = order
            break
    if target is None:
        raise HTTPException(status_code=404, detail="Ordre introuvable.")

    target.status = "cancelled"
    portfolio.open_orders = [o for o in portfolio.open_orders if o is not target]
    _save(username, portfolio)
    return {"order": target.to_dict(), "message": "Ordre annulé."}


@router.post("/positions/{symbol}/close")
def paper_close_position(symbol: str, data: ClosePayload,
                         current_user: User = Depends(require_role("admin", "money", "trader"))):
    """Clôture au marché tout ou partie d'une ligne."""
    username = current_user.username
    wanted = str(symbol or "").strip().upper()
    portfolio = _load(username)
    position = _find_position(portfolio, wanted)
    if position is None:
        raise HTTPException(status_code=404, detail="Aucune position sur %s." % wanted)

    qty = position.qty if data.qty is None else int(data.qty)
    if qty <= 0:
        raise HTTPException(status_code=400, detail="La quantité doit être positive.")
    if qty > position.qty:
        raise HTTPException(status_code=400,
                            detail="Quantité supérieure à la position (%d)." % position.qty)

    try:
        quote = quotes.get_quote(wanted)
    except quotes.UnknownSymbol as e:
        raise HTTPException(status_code=404, detail=str(e))
    except quotes.QuoteError as e:
        raise HTTPException(status_code=502, detail=str(e))
    price = quote.get("price")
    if price is None:
        raise HTTPException(status_code=404, detail="Aucun cours pour %s." % wanted)
    try:
        fx_rate = quotes.fx_to_chf(quote.get("currency") or position.currency)
    except quotes.QuoteError as e:
        raise HTTPException(status_code=502, detail=str(e))

    try:
        fill = close_position(portfolio, position, qty, price, fx_rate, _now_iso())
    except OrderError as e:
        raise HTTPException(status_code=400, detail=str(e))

    _save(username, portfolio)
    _sync_coach(username, portfolio.to_dict())
    return {"fill": fill}


@router.post("/tick")
def paper_tick(current_user: User = Depends(require_role("admin", "money", "trader"))):
    """Confronte ordres en attente et stops aux bougies récentes (15 min).

    Appelé par le front au chargement et au rafraîchissement. Ne rend jamais
    d'erreur pour un symbole en panne : il le consigne et continue.
    """
    username = current_user.username
    portfolio = _load(username)

    def fetch_candles(symbol: str) -> List[Dict[str, Any]]:
        return quotes.get_candles(symbol, TICK_RANGE, TICK_INTERVAL)

    result = run_tick(portfolio, _now_iso(), fetch_candles, quotes.fx_to_chf)
    _save(username, portfolio)
    _sync_coach(username, portfolio.to_dict())
    return result


# --------------------------------------------------------------------------- #
# Endpoints — coach
# --------------------------------------------------------------------------- #
@router.get("/coach")
def paper_coach(lang: str = "fr",
                current_user: User = Depends(require_role("admin", "money", "trader"))):
    """Biais courants + résumé du profil + statistiques. Aucun réseau, aucun LLM."""
    username = current_user.username
    portfolio = _load(username)
    profile = store.load_coach(username) or coach.empty_profile()

    trades = [t.to_dict() for t in portfolio.trades]
    orders = [o.to_dict() for o in portfolio.open_orders]
    biases = coach.detect_biases(trades, orders, portfolio.initial_capital, lang=lang)
    stats = risk.portfolio_stats(trades, initial_capital=portfolio.initial_capital)

    return {
        "biases": biases,
        "summary": coach.coach_summary(profile, biases, lang=lang),
        "stats": stats,
        "profile": profile,
    }


@router.post("/coach/ask")
def paper_coach_ask(data: AskPayload,
                    current_user: User = Depends(require_role("admin", "money", "trader"))):
    """Une question au coach. Le LLM RÉDIGE à partir de faits déjà calculés.

    ``lang`` change la langue de la RÉPONSE, pas celle du contexte : les faits
    passés au modèle restent en français (ce sont ceux que ``_sync_coach`` vient
    d'écrire dans le carnet, qui reste français par décision) — un modèle lit
    des faits dans une langue et rédige dans une autre sans difficulté.
    """
    username = current_user.username
    portfolio = _load(username)
    synced = _sync_coach(username, portfolio.to_dict(), force=True)
    context = _coach_context(portfolio, synced["profile"], synced["biases"],
                             synced["stats"])
    context["watchlist"] = _watchlist_context(username)
    question = data.question or ""
    try:
        answer = llm.ask_coach(context, question, lang=normalize_lang(data.lang))
    except RuntimeError as e:
        raise HTTPException(status_code=502, detail=str(e)[:300])

    now = _now_iso()
    _append_journal(username, "session coach", answer, now)
    _append_discussion(username, question, answer, now)
    return {"answer": answer}


@router.post("/postmortem")
def paper_postmortem(data: PostmortemPayload,
                     current_user: User = Depends(require_role("admin", "money", "trader"))):
    """Post-mortem d'un trade clôturé, archivé dans le ``Journal.md`` (§11)."""
    username = current_user.username
    portfolio = _load(username)
    if not portfolio.trades:
        raise HTTPException(status_code=404, detail="Aucun trade clôturé à analyser.")

    index = len(portfolio.trades) - 1 if data.trade_index is None else int(data.trade_index)
    if index < 0:
        index += len(portfolio.trades)
    if index < 0 or index >= len(portfolio.trades):
        raise HTTPException(status_code=404, detail="Trade introuvable.")

    trade = portfolio.trades[index].to_dict()
    profile = store.load_coach(username) or coach.empty_profile()
    trades = [t.to_dict() for t in portfolio.trades]
    orders = [o.to_dict() for o in portfolio.open_orders]
    biases = coach.detect_biases(trades, orders, portfolio.initial_capital)
    stats = risk.portfolio_stats(trades, initial_capital=portfolio.initial_capital)

    try:
        text = llm.write_postmortem(trade,
                                    _coach_context(portfolio, profile, biases, stats),
                                    lang=normalize_lang(data.lang))
    except RuntimeError as e:
        raise HTTPException(status_code=502, detail=str(e)[:300])

    r_multiple = trade.get("r_multiple")
    label = "%s %s" % (trade.get("symbol") or "?",
                       "?R" if r_multiple is None else "%+.2fR" % r_multiple)
    _append_journal(username, label, text, _now_iso())
    return {"postmortem": text, "trade": trade, "trade_index": index}


@router.post("/analysis")
def paper_analysis(data: AnalysisPayload,
                   current_user: User = Depends(require_role("admin", "money", "trader"))):
    """Fiche pédagogique d'un titre : les chiffres ET leur lecture, sans opinion."""
    symbol = str(data.symbol or "").strip().upper()
    if not symbol:
        raise HTTPException(status_code=400, detail="Symbole manquant.")
    try:
        facts = quotes.fiche_facts(symbol)
    except quotes.UnknownSymbol as e:
        raise HTTPException(status_code=404, detail=str(e))
    except quotes.QuoteError as e:
        raise HTTPException(status_code=502, detail=str(e))
    try:
        text = llm.write_analysis(facts, lang=normalize_lang(data.lang))
    except RuntimeError as e:
        raise HTTPException(status_code=502, detail=str(e)[:300])
    return {"facts": facts, "analysis": text}


@router.get("/coach/notes")
def paper_notes(current_user: User = Depends(require_role("admin", "money", "trader"))):
    """Liste des pages du carnet Markdown (contrat §11 : la liste, telle quelle)."""
    return store.list_notes(current_user.username)


@router.get("/coach/notes/{name:path}")
def paper_note(name: str,
               current_user: User = Depends(require_role("admin", "money", "trader"))):
    """Contenu brut d'une page du carnet (nom validé par ``store``, anti-traversal)."""
    try:
        markdown = store.read_note(current_user.username, name)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    if markdown is None:
        raise HTTPException(status_code=404, detail="Note introuvable.")
    return {"name": name, "markdown": markdown}


# --------------------------------------------------------------------------- #
# Endpoints — communauté (carnets PARTAGÉS entre tous les traders)
#
# Décision utilisateur : les discussions de coaching et l'analyse de biais
# profitent à toute la communauté — SEULS l'argent et les positions restent
# strictement privés (le portefeuille, lui, ne change rien : toujours résolu
# par le ``username`` de la session courante, jamais par un ``user`` de path).
# Lecture SEULE : aucun endpoint n'écrit dans le carnet d'un AUTRE utilisateur.
# --------------------------------------------------------------------------- #
@router.get("/community")
def paper_community(current_user: User = Depends(require_role("admin", "money", "trader"))):
    """Catalogue de la communauté : chaque trader qui a un carnet + ses notes."""
    return {"users": [{"user": u, "notes": store.list_notes(u)}
                       for u in store.list_vault_users()]}


@router.get("/community/{user}/{name:path}")
def paper_community_note(user: str, name: str,
                         current_user: User = Depends(require_role("admin", "money", "trader"))):
    """Contenu brut d'une note du carnet d'UN AUTRE trader (lecture seule).

    ``user`` doit être un carnet RÉELLEMENT recensé par
    ``store.list_vault_users`` — c'est la même allowlist que partout ailleurs
    dans ``store`` : un nom forgé (ex. ``..``) n'y figure jamais, donc 404
    avant même de toucher le disque (pas de tentative de lecture hors
    sandbox). ``name`` passe par la même validation que ``/coach/notes`` —
    400 si le format est invalide.
    """
    if user not in store.list_vault_users():
        raise HTTPException(status_code=404, detail="Utilisateur introuvable.")
    try:
        markdown = store.read_note(user, name)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    if markdown is None:
        raise HTTPException(status_code=404, detail="Note introuvable.")
    return {"user": user, "name": name, "markdown": markdown}


# --------------------------------------------------------------------------- #
# Endpoints — pédagogie
# --------------------------------------------------------------------------- #
@router.get("/lessons")
def paper_lessons(lang: str = "fr",
                  current_user: User = Depends(require_role("admin", "money", "trader"))):
    """Catalogue des leçons SANS les réponses + progression de l'utilisateur.

    ``passed`` est une liste d'``id`` : la progression est donc INDÉPENDANTE de
    la langue — une leçon réussie en français reste réussie en italien, parce
    que c'est la même leçon.
    """
    profile = store.load_coach(current_user.username) or coach.empty_profile()
    passed = [str(x) for x in (profile.get("lessons_passed") or [])]
    return {"lessons": [public_lesson(l) for l in lessons_catalog(lang)],
            "passed": passed}


@router.post("/lessons/{lesson_id}/quiz")
def paper_quiz(lesson_id: str, data: QuizPayload,
               current_user: User = Depends(require_role("admin", "money", "trader"))):
    """Corrige le quiz côté serveur et enregistre la réussite dans le profil.

    La correction se fait sur le catalogue de la LANGUE demandée : les
    ``explain`` rendus au client suivent la langue de lecture. Les index
    ``correct`` sont identiques d'une langue à l'autre (parité verrouillée par
    un test) — c'est ce qui garantit qu'une traduction ne peut pas fausser une
    correction.
    """
    username = current_user.username
    lesson = None
    for row in lessons_catalog(data.lang):
        if row.get("id") == lesson_id:
            lesson = row
            break
    if lesson is None:
        raise HTTPException(status_code=404, detail="Leçon introuvable.")

    result = grade_quiz(lesson, data.answers)
    if result["passed"]:
        profile = store.load_coach(username) or coach.empty_profile()
        passed = [str(x) for x in (profile.get("lessons_passed") or [])]
        if lesson_id not in passed:
            passed.append(lesson_id)
            profile["lessons_passed"] = passed
            store.save_coach(username, profile)
    return result


@router.get("/arena")
def paper_arena(lang: str = "fr",
                current_user: User = Depends(require_role("admin", "money", "trader"))):
    """Défi de la semaine (déterministe) + historique évalué des semaines passées.

    Le tirage du défi et l'évaluation des semaines passées travaillent sur les
    ``id`` et les ``check`` : changer de langue ne change NI le défi de la
    semaine NI le verdict d'une semaine déjà jouée, seulement leur libellé.
    """
    username = current_user.username
    portfolio = _load(username)
    profile = store.load_coach(username) or coach.empty_profile()
    history = [h for h in (profile.get("arena_history") or []) if isinstance(h, dict)]
    return arena_view(arena_catalog(lang), history,
                      [t.to_dict() for t in portfolio.trades],
                      portfolio.initial_capital, _week_id(datetime.now()))


@router.post("/arena/accept")
def paper_arena_accept(current_user: User = Depends(require_role("admin", "money", "trader"))):
    """Accepte le défi de la semaine. Idempotent : deux clics = une acceptation."""
    username = current_user.username
    week = _week_id(datetime.now())
    challenge = select_challenge(arena_catalog(), week)
    if challenge is None:
        raise HTTPException(status_code=404, detail="Aucun défi disponible.")

    profile = store.load_coach(username) or coach.empty_profile()
    history = [h for h in (profile.get("arena_history") or []) if isinstance(h, dict)]
    if not any(h.get("week") == week for h in history):
        history.append({"week": week, "id": challenge.get("id"),
                        "accepted_at": _now_iso()})
        profile["arena_history"] = history
        store.save_coach(username, profile)
    return {"week": week, "challenge": challenge, "accepted": True}


# --------------------------------------------------------------------------- #
# Endpoints — modules optionnels (veille news, radar), écrits par d'autres lots
#
# Les deux passent par une INDIRECTION d'import : le router doit vivre sans eux
# (déploiement partiel), et les tests doivent pouvoir simuler leur absence sans
# toucher au mécanisme d'import de Python.
# --------------------------------------------------------------------------- #
def _radar():
    """Le module radar (hypothèses spéculatives), importé paresseusement."""
    from backend.bots.paper import radar
    return radar


@router.get("/radar")
def paper_radar(current_user: User = Depends(require_role("admin", "money", "trader"))):
    """Hypothèses du radar et leur score. Module absent -> radar vide, pas d'erreur.

    La réponse porte aussi ``stats_by_level`` (bilan ventilé par étage de risque
    des idées du coach) — vide dans les replis, pour que le client n'ait jamais
    à distinguer « pas de radar » de « pas encore de verdict ».
    """
    try:
        module = _radar()
    except ImportError:
        return {"stats": {}, "stats_by_level": {}, "hypotheses": []}
    try:
        return module.recent()
    except Exception as e:                      # noqa: BLE001 - lecture best-effort
        logger.warning("paper: radar indisponible: %s", e)
        return {"stats": {}, "stats_by_level": {}, "hypotheses": [],
                "error": str(e)[:200]}


@router.post("/radar/run")
def paper_radar_run(current_user: User = Depends(require_role("admin", "money", "trader"))):
    """Lance un passage du radar. SYNCHRONE et long (~2 min) : l'UI affiche un
    chargement. Ici, contrairement à la lecture, l'absence du module est une
    vraie erreur — l'utilisateur a demandé une action qui ne peut pas avoir lieu."""
    try:
        module = _radar()
    except ImportError:
        raise HTTPException(status_code=503,
                            detail="Le radar n'est pas déployé sur ce serveur.")
    try:
        return module.run_once()
    except RuntimeError as e:
        raise HTTPException(status_code=502, detail=str(e)[:300])


def _newswatch():
    """Le module de veille, importé PARESSEUSEMENT.

    Il peut ne pas être déployé (lot parallèle) : l'indirection permet au router
    de vivre sans lui, et aux tests de simuler son absence sans toucher au
    mécanisme d'import de Python.
    """
    from backend.bots.paper import newswatch
    return newswatch


@router.get("/news")
def paper_news(current_user: User = Depends(require_role("admin", "money", "trader"))):
    """Dernières nouvelles concernant les positions détenues.

    Best-effort de bout en bout : module absent ou veille en panne -> liste vide.
    Un tableau de bord ne tombe pas parce qu'un flux RSS a hoqueté.
    """
    try:
        module = _newswatch()
    except ImportError:
        return {"events": []}
    try:
        return {"events": list(module.recent_events(current_user.username) or [])}
    except Exception as e:                      # noqa: BLE001 - veille best-effort
        logger.warning("paper: veille news indisponible: %s", e)
        return {"events": [], "error": str(e)[:200]}


def _convergence():
    """Le module de convergence (digest Telegram), importé paresseusement."""
    from backend.bots.paper import convergence
    return convergence


@router.get("/digest")
def paper_digest(current_user: User = Depends(require_role("admin", "money", "trader"))):
    """Historique des digests de convergence. Best-effort comme ses voisins."""
    try:
        module = _convergence()
    except ImportError:
        return {"history": []}
    try:
        return module.recent()
    except Exception as e:                      # noqa: BLE001 - lecture best-effort
        logger.warning("paper: convergence indisponible: %s", e)
        return {"history": [], "error": str(e)[:200]}


@router.post("/digest/run")
def paper_digest_run(force: bool = False,
                     current_user: User = Depends(require_role("admin", "money", "trader"))):
    """Évalue la convergence maintenant et envoie un digest si elle est réunie.

    ``force=true`` saute le cooldown de 6 h et l'empreinte anti-redite — c'est
    la porte de sortie du test manuel, qui ne doit pas attendre six heures. Il
    ne saute PAS le seuil de facteurs : avec moins de deux facteurs, la réponse
    reste ``{"fired": false, "reason": "too_few"}``, parce qu'un digest sans
    convergence n'aurait rien à dire.

    Comme pour le radar, l'absence du module est ici une vraie erreur (503) :
    l'utilisateur a demandé une action qui ne peut pas avoir lieu.
    """
    try:
        module = _convergence()
    except ImportError:
        raise HTTPException(status_code=503,
                            detail="La convergence n'est pas déployée sur ce serveur.")
    try:
        return module.maybe_fire(force=bool(force))
    except RuntimeError as e:
        raise HTTPException(status_code=502, detail=str(e)[:300])


def _whales():
    """Le module 13F (Grands portefeuilles), importé paresseusement — même
    esprit que ``_radar``/``_newswatch``/``_convergence`` : le router doit
    vivre sans lui (déploiement partiel)."""
    from backend.bots.paper import whales
    return whales


# --------------------------------------------------------------------------- #
# Dossier HISTORIQUE (12 mois d'archives de presse, collectés en pur code)
#
# « Envoyer le radar chercher des VIEILLES infos qui donnent une BASE aux infos
# qu'on a maintenant » : la mémoire du simulateur n'a que quelques jours
# d'événements, donc rien à quoi comparer la dépêche du jour. Le module
# ``paper/backfill.py`` comble ce trou ; le router le LIT (contexte du coach,
# fait-pack de la revue) et l'ALIMENTE (endpoint de collecte).
#
# Tout est best-effort : sans dossier, le coach écrit sans — il écrit juste
# moins bien.
# --------------------------------------------------------------------------- #

def _backfill():
    """Le module des dossiers historiques, importé paresseusement — même
    indirection que ``_radar``/``_newswatch``/``_whales`` : le router doit
    vivre sans lui (déploiement partiel), et les tests doivent pouvoir simuler
    son absence sans toucher au mécanisme d'import de Python."""
    from backend.bots.paper import backfill
    return backfill


# Lignes d'historique servies à un prompt. Quatre : c'est ce qu'il faut pour
# qu'un an tienne debout (une par trimestre) sans que le passé prenne la place
# des faits du jour — le dossier est une BASE de comparaison, pas le sujet.
HISTORY_LINES = 4


def _backfill_digest(symbols: Any,
                     limit_per: int = HISTORY_LINES) -> Dict[str, List[str]]:
    """Le dossier historique des symboles demandés, prêt pour un prompt.

    Lecture PURE côté réseau : on ne collecte RIEN ici (une collecte coûte
    quatre requêtes espacées et n'a rien à faire dans le chemin d'un endpoint
    interactif) — on lit ce que la file de travail a déjà rangé.

    Best-effort de bout en bout : module absent ou état illisible -> ``{}``.
    """
    wanted: List[str] = []
    seen = set()
    for raw in symbols or []:
        symbol = str(raw or "").strip().upper()
        if symbol and symbol not in seen:
            seen.add(symbol)
            wanted.append(symbol)
    if not wanted:
        return {}
    try:
        return _backfill().digest_for(wanted, limit_per) or {}
    except ImportError:
        return {}
    except Exception as e:                      # noqa: BLE001 - lecture best-effort
        logger.warning("paper: historique indisponible pour le contexte: %s", e)
        return {}


# --------------------------------------------------------------------------- #
# Balayage FRAIS — le coach cherche AU-DELÀ de ce qu'il a
#
# Décision utilisateur (26/08) : « quand le coach génère des idées, il se base
# sur ce qu'il a ET il peut chercher plus profondément au-delà ».
#
# Ce que la mémoire ne peut pas donner : la veille tourne toutes les 5 minutes
# mais seulement sur les titres SUIVIS, le dossier historique a 30 jours de
# fraîcheur, et les tendances Reddit ne sont que des compteurs. Au moment PRÉCIS
# où Massii clique, rien ne garantit qu'une dépêche des trois derniers jours a
# été vue. On va donc la chercher — à la demande, jamais en tâche de fond.
#
# Trois bornes, parce qu'un endpoint interactif attend :
#   * SWEEP_MAX_SYMBOLS symboles au plus, ancres D'ABORD (ce qu'il détient et
#     suit est le sujet ; les tendances ne prennent que les places qui restent —
#     conséquence assumée : un gros portefeuille consomme tout le budget et le
#     balayage reste alors sur ses propres titres) ;
#   * une SEULE requête de presse par symbole, espacée de SWEEP_PACE_S
#     (piège #67 : un burst vaut un 429) -> ~5,5 s d'attente au pire ;
#   * best-effort INTÉGRAL — un symbole muet coûte sa ligne, une panne totale
#     coûte la clé entière, et l'appel au modèle part quand même. Le coach a
#     toujours su répondre sans ce balayage : il répondait juste sans.
# --------------------------------------------------------------------------- #

SWEEP_MAX_SYMBOLS = 6
SWEEP_TREND_MAX = 3
SWEEP_PACE_S = 1.1
SWEEP_MOMENTUM_DAYS = 7
SWEEP_MOMENTUM_RANGE = "1mo"


def _positive_int(value: Any) -> int:
    """Un compteur lu d'un état sur disque — illisible vaut 0 (PUR)."""
    try:
        return max(0, int(value))
    except (TypeError, ValueError):
        return 0


def _sweep_targets(username: str) -> List[Dict[str, str]]:
    """Les ``[{"symbol", "name"}]`` à balayer : ancres puis foule (best-effort).

    Les ancres viennent des positions et de la watchlist ; seule la watchlist
    porte un NOM (``models.Position`` n'en a pas), et c'est le nom qui fait une
    bonne requête de presse — d'où la fusion, comme dans ``_graph_inputs``.

    Les tendances Reddit apportent ce que la mémoire ne peut pas apporter : un
    ticker dont on ne sait RIEN parce qu'on ne le suit pas. C'est là qu'on
    découvre un titre, donc elles entrent dans le balayage même sans nom (la
    requête retombera sur la racine du ticker).
    """
    targets: List[Dict[str, str]] = []
    seen = set()

    def _add(symbol: Any, name: Any = "") -> None:
        key = str(symbol or "").strip().upper()
        if not key or key in seen or len(targets) >= SWEEP_MAX_SYMBOLS:
            return
        seen.add(key)
        targets.append({"symbol": key, "name": str(name or "").strip()})

    try:
        for position in _load(username).positions:
            _add(position.symbol)
    except Exception as e:                          # noqa: BLE001 — best-effort
        logger.warning("paper: portefeuille indisponible pour le balayage: %s", e)
    for row in _watchlist_context(username):
        _add(row.get("symbol"), row.get("name"))

    # Les plus mentionnés d'abord ; le symbole tranche les ex æquo pour que deux
    # clics d'affilée balayent la même chose. Un état de tendances abîmé
    # (compteur non numérique) ne doit JAMAIS faire tomber l'endpoint : il coûte
    # la découverte, pas la réponse.
    try:
        ranked = sorted(
            (-_positive_int((row or {}).get("count")), str(symbol or "").upper())
            for symbol, row in (_reddit_trends() or {}).items()
            if isinstance(row, dict))
    except Exception as e:                          # noqa: BLE001
        logger.warning("paper: tendances illisibles pour le balayage: %s", e)
        ranked = []
    for neg_count, symbol in ranked[:SWEEP_TREND_MAX]:
        if neg_count < 0:                           # « SYM ×0 » n'est pas une tendance
            _add(symbol)
    return targets


def _pct_over_days(candles: Any, days: int, now_ts: float) -> Optional[float]:
    """Variation % entre la dernière clôture et celle d'il y a ``days`` jours
    (PUR). ``None`` dès qu'un des deux bouts manque — mieux vaut pas de chiffre
    qu'un chiffre mesuré contre la mauvaise séance.

    La référence est la clôture la plus RÉCENTE parmi celles antérieures à la
    borne : sept jours calendaires ne tombent pas sur une séance (week-ends,
    fériés), et exiger une bougie pile à la date ne rendrait presque jamais rien.
    """
    rows = [c for c in (candles or [])
            if isinstance(c, dict) and c.get("close") is not None]
    if len(rows) < 2:
        return None
    cutoff = now_ts - days * 86400
    ref = None
    for candle in rows[:-1]:
        try:
            when = float(candle.get("ts") or 0)
        except (TypeError, ValueError):
            continue
        if when <= cutoff:
            ref = candle["close"]
    if ref is None:
        ref = rows[0]["close"]                      # série plus courte que la fenêtre
    try:
        ref = float(ref)
        last = float(rows[-1]["close"])
    except (TypeError, ValueError):
        return None
    if ref == 0:
        return None
    return round((last - ref) / ref * 100.0, 2)


def _fresh_momentum(symbol: str, now_ts: float) -> Dict[str, Any]:
    """``{prix, pct_7j}`` d'un symbole — best-effort STRICT.

    Une seule requête de bougies (le cours courant en est la dernière clôture) :
    demander en plus une cotation doublerait le trafic pour la même information.
    Panne ou symbole inconnu -> ``{}``, jamais une exception.
    """
    try:
        candles = quotes.get_candles(symbol, SWEEP_MOMENTUM_RANGE, "1d")
    except Exception:                               # noqa: BLE001 — cours muet
        return {}
    rows = [c for c in (candles or [])
            if isinstance(c, dict) and c.get("close") is not None]
    if not rows:
        return {}
    out: Dict[str, Any] = {"prix": rows[-1]["close"]}
    pct = _pct_over_days(rows, SWEEP_MOMENTUM_DAYS, now_ts)
    if pct is not None:
        out["pct_7j"] = pct
    return out


def _fresh_sweep(targets: Any,
                 fetch: Optional[Callable[[str], str]] = None,
                 sleep: Optional[Callable[[float], None]] = None
                 ) -> Dict[str, Any]:
    """Le balayage de presse + momentum fait AU CLIC — best-effort intégral.

    Rend le bloc ``recherche_fraiche`` du contexte, ou ``{}`` quand rien n'a pu
    être récolté : la clé est alors ABSENTE du contexte, et le prompt n'annonce
    pas une section qui n'existe pas (le modèle croirait à un silence de la
    presse là où il n'y a qu'une panne).

    Une liste de titres VIDE pour un symbole, elle, est CONSERVÉE : « rien de
    neuf sur sept jours » est une information, et elle se distingue d'un symbole
    absent — c'est ce que la consigne du prompt explique au modèle.

    ``fetch`` et ``sleep`` sont injectables : les tests tournent hors ligne et
    sans attendre.
    """
    rows = [t for t in (targets or []) if isinstance(t, dict) and t.get("symbol")]
    if not rows:
        return {}
    try:
        backfill_mod = _backfill()
    except ImportError:
        return {}

    sleep = sleep if sleep is not None else time.sleep
    now_ts = time.time()
    titles: Dict[str, Any] = {}
    momentum: Dict[str, Any] = {}
    reached = 0

    for index, target in enumerate(rows):
        symbol = target["symbol"]
        if index:
            try:
                sleep(SWEEP_PACE_S)
            except Exception:                       # noqa: BLE001 — horloge injectée bavarde
                pass
        try:
            items = backfill_mod.sweep_recent(target.get("name") or symbol,
                                              fetch=fetch)
        except Exception as e:                      # noqa: BLE001 — source muette
            logger.warning("paper: balayage frais muet pour %s: %s", symbol, e)
        else:
            titles[symbol] = list(items or [])
            reached += 1
        shot = _fresh_momentum(symbol, now_ts)
        if shot:
            momentum[symbol] = shot

    if not reached and not momentum:
        return {}                                   # panne totale -> clé absente
    out: Dict[str, Any] = {"fenetre_jours": backfill_mod.SWEEP_DAYS,
                           "fait_a": _now_iso()}
    if titles:
        out["titres"] = titles
    if momentum:
        out["momentum"] = momentum
    return out


# --------------------------------------------------------------------------- #
# Auto-backfill des tickers que le coach vient de CHOISIR
#
# Doctrine : **la curiosité du coach nourrit sa base.** La file de travail
# nocturne ne collecte que les ANCRES (positions ∪ watchlist) — un ticker que le
# coach découvre aujourd'hui n'y entrera que le jour où Massii l'aura mis en
# watchlist, c'est-à-dire trop tard pour la prochaine série d'idées. En le
# collectant tout de suite, la deuxième fois qu'on parlera de ce titre, on aura
# douze mois de recul dessus.
#
# Cap à IDEAS_BACKFILL_MAX : une collecte coûte 4 requêtes espacées de 1,1 s,
# soit ~3,3 s d'attente par ticker, AJOUTÉES à une réponse déjà payée. Deux, pas
# plus. Les autres ne sont pas perdus : ils reviendront au prochain clic (ils
# seront toujours absents du dossier), ou par la file nocturne dès qu'ils
# deviendront des ancres.
# --------------------------------------------------------------------------- #

IDEAS_BACKFILL_MAX = 2


def _backfill_new_tickers(ideas: Any,
                          fetch: Optional[Callable[[str], str]] = None,
                          sleep: Optional[Callable[[float], None]] = None
                          ) -> List[str]:
    """Collecte le dossier des tickers INCONNUS du bloc d'idées (best-effort).

    « Inconnu » = aucune entrée dans l'état du backfill. Un dossier PÉRIMÉ n'est
    pas rafraîchi ici : ce serait le travail de la file nocturne, et le refaire
    dans le chemin d'un endpoint coûterait la latence sans rien apprendre de
    neuf (``backfill_symbol`` le sauterait de toute façon, il est frais 30 j).

    Rend la liste des symboles réellement collectés — jamais une exception.
    """
    try:
        backfill_mod = _backfill()
    except ImportError:
        return []

    wanted: List[str] = []
    seen = set()
    for idea in (ideas or []):
        if not isinstance(idea, dict):
            continue
        symbol = str(idea.get("ticker") or "").strip().upper()
        if not symbol or symbol in seen:
            continue
        seen.add(symbol)
        try:
            known = bool(backfill_mod.entry_for(symbol))
        except Exception:                           # noqa: BLE001 — état illisible
            known = True                            # dans le doute, on ne collecte pas
        if not known:
            wanted.append(symbol)

    done: List[str] = []
    for symbol in wanted[:IDEAS_BACKFILL_MAX]:
        # Le NOM fait la requête (piège #29a) : sans lui, « ASML » interroge la
        # presse sur quatre lettres. Cotation best-effort, repli sur le ticker.
        try:
            name = str((quotes.get_quote(symbol) or {}).get("name") or "").strip()
        except Exception:                           # noqa: BLE001
            name = ""
        try:
            result = backfill_mod.backfill_symbol(symbol, name=name or None,
                                                  fetch=fetch, sleep=sleep)
        except Exception as e:                      # noqa: BLE001 — jamais fatal
            logger.warning("paper: dossier non collecté pour %s: %s", symbol, e)
            continue
        if isinstance(result, dict) and result.get("reason") == "collected":
            done.append(symbol)
    return done


class BackfillPayload(BaseModel):
    """Corps de ``POST /backfill/run``. Défini ICI, à côté de son endpoint,
    plutôt qu'avec les autres modèles : ce lot a été écrit en parallèle d'un
    autre sur le même fichier, et un bloc contigu vaut mieux qu'une ligne
    ajoutée au milieu d'un bloc partagé."""
    symbol: Optional[str] = None


@router.post("/backfill/run")
def paper_backfill_run(data: Optional[BackfillPayload] = None,
                       current_user: User = Depends(require_role("admin", "money", "trader"))):
    """Avance la collecte des dossiers historiques.

    Avec ``symbol`` : ce titre précisément, et on REFAIT son dossier même s'il
    est encore frais — c'est le geste manuel « regarde celui-là maintenant »,
    qui n'aurait aucun sens s'il répondait « déjà fait le mois dernier ».

    Sans ``symbol`` : les trois premiers titres en attente de la file. Trois et
    pas trente : chaque titre coûte quatre requêtes espacées de 1,1 s, donc une
    quinzaine de secondes — au-delà, l'appel deviendrait un gel de l'interface.

    Comme pour le radar, l'absence du module est ici une vraie erreur (503) :
    l'utilisateur a demandé une action qui ne peut pas avoir lieu.
    """
    try:
        module = _backfill()
    except ImportError:
        raise HTTPException(
            status_code=503,
            detail="La collecte d'historique n'est pas déployée sur ce serveur.")

    symbol = str((data.symbol if data else None) or "").strip().upper()
    try:
        if symbol:
            outcome = module.backfill_symbol(symbol, force=True)
            return {"processed": 0 if outcome.get("skipped") else 1,
                    "skipped": 1 if outcome.get("skipped") else 0,
                    "items": outcome.get("items", 0),
                    "errors": outcome.get("errors", 0),
                    "symbols": [] if outcome.get("skipped") else [symbol]}
        return module.run_pending(max_symbols=3)
    except RuntimeError as e:
        raise HTTPException(status_code=502, detail=str(e)[:300])


@router.get("/backfill")
def paper_backfill(symbol: str = "",
                   current_user: User = Depends(require_role("admin", "money", "trader"))):
    """Le dossier historique BRUT d'un titre (fenêtres et titres), ou l'index
    de ce qui est collecté quand ``symbol`` est absent.

    Lecture best-effort : module absent ou état illisible -> dossier vide. Un
    titre jamais collecté rend lui aussi un dossier vide — c'est un 200, pas
    une erreur : « pas encore collecté » est une réponse légitime.
    """
    wanted = str(symbol or "").strip().upper()
    try:
        module = _backfill()
        if wanted:
            return {"symbol": wanted, "entry": module.entry_for(wanted)}
        state = module.load_state()
        return {"symbols": sorted(
            ({"symbol": key,
              "name": entry.get("name"),
              "fetched_at": entry.get("fetched_at"),
              "windows": len(entry.get("windows") or [])}
             for key, entry in (state.get("symbols") or {}).items()
             if isinstance(entry, dict)),
            key=lambda row: row["symbol"])}
    except ImportError:
        return {"symbol": wanted, "entry": {}} if wanted else {"symbols": []}
    except Exception as e:                      # noqa: BLE001 - lecture best-effort
        logger.warning("paper: dossier historique indisponible: %s", e)
        return {"symbol": wanted, "entry": {}, "error": str(e)[:200]} if wanted \
            else {"symbols": [], "error": str(e)[:200]}


# --------------------------------------------------------------------------- #
# Endpoints — idées de trade (extension utilisateur, orientées rentabilité)
#
# Le coach change de registre : il ne fait plus le point, il PROPOSE. Chaque
# idée valide est enregistrée comme hypothèse RADAR (``source: "coach"``),
# bornée par ``radar.MAX_OPEN`` comme n'importe quelle autre hypothèse.
# --------------------------------------------------------------------------- #

def _parse_ideas_json(text: Any,
                      risk_level: str = llm.DEFAULT_RISK_LEVEL) -> List[Dict[str, Any]]:
    """Extrait le bloc JSON final ``{"ideas": [...]}`` de la réponse texte du
    coach (PUR — aucune I/O). Même patron find/rfind que ``radar.parse_llm``
    (tolérant : bloc absent ou invalide -> liste vide, jamais une exception —
    le texte pédagogique reste affiché même sans câblage radar).

    Un item invalide (pas de ticker) est jeté SEUL, jamais tout le lot.

    Deux champs sont posés par le SERVEUR, pas lus du LLM :

    * ``risk_level`` est l'étage DEMANDÉ. Le modèle n'a pas le droit de se
      promouvoir : une série demandée « mesurée » reste mesurée dans le bilan,
      quoi qu'il écrive dans son JSON ;
    * ``asset_kind`` est repris du LLM s'il est valide, sinon DEVINÉ depuis la
      forme du ticker (``BTC-USD`` -> crypto, ``EURUSD=X`` -> forex). Une idée
      crypto étiquetée « action » salirait le bilan par étage.
    """
    if not isinstance(text, str):
        return []
    level = llm.normalize_risk_level(risk_level)
    start = text.find("{")
    end = text.rfind("}")
    if start < 0 or end <= start:
        return []
    try:
        payload = json.loads(text[start:end + 1])
    except ValueError:
        return []
    if not isinstance(payload, dict):
        return []
    items = payload.get("ideas")
    if not isinstance(items, list):
        return []

    out: List[Dict[str, Any]] = []
    for item in items:
        if not isinstance(item, dict):
            continue
        ticker = str(item.get("ticker") or "").strip().upper()
        if not ticker:
            continue
        direction = str(item.get("direction") or "").strip().lower()
        if direction not in ("up", "down"):
            direction = "up"
        try:
            horizon_days = int(float(item.get("horizon_days")))
        except (TypeError, ValueError):
            horizon_days = DEFAULT_IDEA_HORIZON_D
        asset_kind = str(item.get("asset_kind") or "").strip().lower()
        if asset_kind not in quotes.ASSET_KINDS:
            asset_kind = quotes.kind_from_symbol(ticker)
        out.append({
            "ticker": ticker,
            "direction": direction,
            "horizon_days": horizon_days,
            "thesis": str(item.get("thesis") or "").strip(),
            "risk_level": level,
            "asset_kind": asset_kind,
        })
    return out


def _radar_hypotheses() -> List[Dict[str, Any]]:
    """TOUTES les hypothèses du radar, ouvertes comme notées — best-effort :
    module absent ou en panne -> liste vide, jamais une exception.

    Deux consommateurs, deux besoins : ``/ideas`` ne veut que les vivantes (voir
    ``_open_radar_hypotheses``), le graphe des connexions veut aussi les
    verdicts récents. Une seule lecture d'état pour les deux — deux lectures
    parallèles finiraient par diverger.
    """
    try:
        radar_module = _radar()
    except ImportError:
        return []
    try:
        state = radar_module.load_state()
    except Exception as e:                      # noqa: BLE001 - lecture best-effort
        logger.warning("paper: radar indisponible: %s", e)
        return []
    return [h for h in (state.get("hypotheses") or []) if isinstance(h, dict)]


def _open_radar_hypotheses() -> List[Dict[str, Any]]:
    """Hypothèses radar actuellement OUVERTES — matière de contexte pour
    ``/ideas`` (pour ne pas reproposer ce que le radar suit déjà)."""
    return [h for h in _radar_hypotheses() if h.get("status") == "open"]


def _recent_news(username: str) -> List[Dict[str, Any]]:
    """Les dépêches récentes de la veille — best-effort : module absent ou en
    panne -> liste vide, jamais une exception (le coach écrit sans, il écrit
    juste moins bien)."""
    try:
        return list(_newswatch().recent_events(username) or [])
    except ImportError:
        return []
    except Exception as e:                      # noqa: BLE001 - veille best-effort
        logger.warning("paper: veille news indisponible pour le contexte: %s", e)
        return []


def _recent_filings() -> List[Dict[str, Any]]:
    """Les dépôts 13F récents — best-effort, même contrat que ``_recent_news``."""
    try:
        return list(_whales().recent_filing_events() or [])
    except ImportError:
        return []
    except Exception as e:                      # noqa: BLE001 - dépôts best-effort
        logger.warning("paper: dépôts 13F indisponibles pour le contexte: %s", e)
        return []


# Les grandes capitalisations que le fait-pack crypto va chercher. Six, et pas
# vingt : au-delà, le coach lit une liste au lieu de comparer des pièces — et
# chaque symbole coûte deux requêtes.
CRYPTO_MAJORS = ("BTC-USD", "ETH-USD", "SOL-USD", "XRP-USD", "AVAX-USD",
                 "LINK-USD")
CRYPTO_FACTS_RANGE = "1mo"
CRYPTO_FACTS_INTERVAL = "1d"
CRYPTO_WEEK_SESSIONS = 7      # une crypto cote 7 j/7 : 7 bougies = 7 jours


def _pct(new: Any, old: Any) -> Optional[float]:
    """Variation en pourcentage, ou ``None`` si elle n'est pas calculable."""
    try:
        new, old = float(new), float(old)
    except (TypeError, ValueError):
        return None
    if old == 0:
        return None
    return round((new - old) * 100.0 / old, 2)


def _crypto_factpack() -> List[Dict[str, Any]]:
    """Prix et variations des grandes cryptos — fait-pack DÉTERMINISTE.

    Raison d'être : en niveau « crypto », le coach répondait honnêtement « le
    contexte ne contient aucune donnée crypto ». Le trou était dans la
    collecte, pas dans le prompt. Avec ce bloc il a TOUJOURS des chiffres, même
    quand la presse crypto est muette.

    Best-effort PAR SYMBOLE : un cours indisponible fait tomber CETTE ligne,
    jamais la réponse — et une variation qu'on ne sait pas calculer sort à
    ``null`` plutôt qu'inventée.
    """
    out: List[Dict[str, Any]] = []
    for symbol in CRYPTO_MAJORS:
        row: Dict[str, Any] = {"symbol": symbol, "price": None,
                               "change_24h_pct": None, "change_7d_pct": None}
        try:
            quote = quotes.get_quote(symbol)
            row["price"] = quote.get("price")
            # Une crypto cote sans interruption : la clôture quotidienne
            # précédente est donc bien « il y a 24 h ».
            row["change_24h_pct"] = quote.get("change_pct")
        except Exception as e:                      # noqa: BLE001 — best-effort
            logger.warning("paper: cours crypto indisponible (%s): %s", symbol, e)
        try:
            candles = quotes.get_candles(symbol, CRYPTO_FACTS_RANGE,
                                         CRYPTO_FACTS_INTERVAL) or []
            closes = [c.get("close") for c in candles
                      if isinstance(c, dict) and c.get("close") is not None]
            if len(closes) > CRYPTO_WEEK_SESSIONS:
                row["change_7d_pct"] = _pct(closes[-1],
                                            closes[-1 - CRYPTO_WEEK_SESSIONS])
        except Exception as e:                      # noqa: BLE001
            logger.warning("paper: bougies crypto indisponibles (%s): %s",
                           symbol, e)
        out.append(row)
    return out


def _recent_crypto(username: str) -> List[Dict[str, Any]]:
    """Les dépêches CRYPTO de la veille globale (best-effort).

    Extraites du même flux d'événements que le reste (``recent_events`` fusionne
    les événements globaux dans le retour de chaque compte) : on les isole pour
    que le coach les voie ÉTIQUETÉES, et non noyées dans la presse actions.
    """
    return [e for e in _recent_news(username)
            if isinstance(e, dict) and e.get("src") == "crypto"]


def _reddit_trends() -> Dict[str, Any]:
    """Les tickers dont la foule Reddit parle — ``{SYM: {count, prev}}``.

    Lecture d'un fichier LOCAL (l'état du guetteur) : aucune requête vers
    Reddit ici, c'est ``newswatch`` qui l'interroge, un cycle sur trois — et le
    plafond mesuré est d'une requête par minute, ce qui interdit d'y toucher
    depuis un endpoint. Même contrat best-effort que ``_recent_news`` : un état
    absent rend un dictionnaire vide, jamais une exception.
    """
    try:
        return dict(_newswatch().recent_trends() or {})
    except ImportError:
        return {}
    except Exception as e:                          # noqa: BLE001
        logger.warning("paper: tendances Reddit indisponibles: %s", e)
        return {}


def _whale_moves() -> List[Dict[str, Any]]:
    """Les mouvements des grands gérants, depuis le CACHE seul (best-effort).

    Demande de l'utilisateur : « ils peuvent voir quelque chose qu'on ne voit
    pas en VENDANT leurs actions ». Aucune requête SEC ici — le guetteur des
    dépôts tient ce cache au chaud, précisément pour que le coach puisse le
    lire à chaque fois qu'il réfléchit.
    """
    try:
        return list(_whales().moves_summary() or [])
    except ImportError:
        return []
    except Exception as e:                          # noqa: BLE001
        logger.warning("paper: mouvements 13F indisponibles: %s", e)
        return []


# --------------------------------------------------------------------------- #
# AGENDA MACRO — les rendez-vous DATÉS (W2b)
#
# La moitié du contexte du coach est faite de dépêches dont il ne peut pas dire
# QUAND elles produiront un effet. Une réunion du FOMC, elle, a une date : c'est
# la seule matière sur laquelle il peut construire un « avant / pendant /
# après ». D'où la consigne, qui voyage AVEC les dates plutôt qu'en ligne
# séparée du prompt : le bloc ``CONTEXTE`` est sérialisé en entier vers le
# modèle (même mécanique que le champ ``historique``, cf. ``llm._HISTORY_LINE``),
# et une consigne posée à côté de la donnée qu'elle commente ne peut pas s'en
# désynchroniser.
#
# ⚠️ Contrairement à ``_whale_moves`` (cache SEUL, jamais de requête SEC), cet
# accès peut RELEVER l'agenda quand son cache de 24 h est froid — cinq sites de
# banque centrale, ~2 s, une fois par jour. C'est délibéré : le seul autre
# rafraîchisseur est la ronde des dépôts, et celle-ci ne tourne QUE si Telegram
# est configuré. Un accès en lecture seule rendrait donc la fonctionnalité
# silencieusement morte chez qui n'a pas branché Telegram — exactement la classe
# de bug « la branche est toujours fausse et personne ne le voit ». Deux
# secondes une fois par jour, sur un endpoint qui appelle déjà un LLM, se
# paient ; une section vide pour toujours, non.
# --------------------------------------------------------------------------- #

AGENDA_CONSIGNE = (
    "AGENDA MACRO (rendez-vous datés officiels) : un catalyseur DATÉ vaut plus "
    "qu'une rumeur — construis autour. Ces dates sont des FAITS vérifiables "
    "(calendriers publiés par les banques centrales) ; dis ce qui est EN JEU à "
    "chacune, jamais dans quel sens elle tournera."
)


def _agenda_macro() -> Dict[str, Any]:
    """Les rendez-vous de banques centrales à venir, prêts pour le prompt.

    Rend ``{}`` quand il n'y a rien (agenda vide, moteur Market Pulse absent,
    cache jamais rempli) : l'appelant n'ajoute alors PAS la clé. Décrire au
    modèle une section vide, c'est l'inviter à la remplir tout seul — la même
    règle que ``llm._sweep_line`` pour la recherche fraîche.
    """
    try:
        from backend.bots.paper import agenda_bridge
        rows = list(agenda_bridge.upcoming_events() or [])
    except ImportError:
        return {}
    except Exception as e:                          # noqa: BLE001 — best-effort
        logger.warning("paper: agenda macro indisponible: %s", e)
        return {}
    if not rows:
        return {}
    return {"consigne": AGENDA_CONSIGNE, "rendez_vous": rows}


def _strategy_context(username: str,
                      risk_level: Optional[str] = None) -> Dict[str, Any]:
    """Le contexte du coach quand il PROPOSE (``/ideas``) ou qu'il
    CARTOGRAPHIE (``/board/scenarios/generate``).

    UNE seule fonction pour les deux : ce sont les mêmes faits, et deux
    assemblages parallèles finiraient par diverger (l'un recevrait les
    annonces politiques, l'autre pas — sans que rien ne le signale).

    ``risk_level`` ne change rien à la doctrine : il n'ouvre QUE le fait-pack
    crypto, qui coûte une douzaine de requêtes et n'a aucun intérêt pour une
    série d'actions.
    """
    portfolio = _load(username)
    synced = _sync_coach(username, portfolio.to_dict(), force=True)
    context = _coach_context(portfolio, synced["profile"], synced["biases"],
                             synced["stats"])
    context["watchlist"] = _watchlist_context(username)
    context["radar_open_hypotheses"] = _open_radar_hypotheses()
    context["recent_news"] = _recent_news(username)
    context["recent_filings"] = _recent_filings()
    context["recent_crypto"] = _recent_crypto(username)
    context["whale_moves"] = _whale_moves()
    # Les rendez-vous DATÉS (W2b) — la clé n'existe que s'il y en a.
    agenda = _agenda_macro()
    if agenda:
        context["agenda_macro"] = agenda
    # La BASE : douze mois d'archives sur ce qu'il détient et ce qu'il suit.
    # Sans elle, chaque dépêche du contexte se lit comme un fait isolé, et le
    # coach ne peut pas dire si elle rompt avec l'année ou si elle la répète.
    context["historique"] = _backfill_digest(
        [position.symbol for position in portfolio.positions]
        + [row.get("symbol") for row in context["watchlist"]])
    if llm.normalize_risk_level(risk_level) == "crypto" and risk_level:
        context["crypto_market"] = _crypto_factpack()
    return context


def _register_radar_ideas(ideas: List[Dict[str, Any]], now_iso: str) -> List[Dict[str, Any]]:
    """Enregistre chaque idée comme hypothèse radar ``source: "coach"`` — même
    forme d'hypothèse que ``radar._score_and_generate`` (id/created_at/status/
    outcome/scored_at/move_pct), et respecte ``radar.MAX_OPEN`` : au-delà,
    l'idée est rendue au client mais PAS enregistrée (``tracked: False``).

    Best-effort de bout en bout : le module radar absent ou en panne (à
    N'IMPORTE quelle étape — lecture, écriture) ne casse jamais la réponse ;
    dans ce cas TOUTES les idées reviennent non trackées plutôt que de
    prétendre à moitié un enregistrement qui n'a pas eu lieu.
    """
    if not ideas:
        return []
    try:
        radar_module = _radar()
    except ImportError:
        return [dict(idea, tracked=False) for idea in ideas]

    try:
        state = radar_module.load_state()
        hypotheses = state["hypotheses"]
        open_count = sum(1 for h in hypotheses
                         if isinstance(h, dict) and h.get("status") == "open")
        out: List[Dict[str, Any]] = []
        changed = False
        for idea in ideas:
            row = dict(idea)
            if open_count >= radar_module.MAX_OPEN:
                row["tracked"] = False
                out.append(row)
                continue
            hypotheses.append({
                "id": uuid.uuid4().hex[:8],
                "created_at": now_iso,
                "status": "open",
                "outcome": None,
                "scored_at": None,
                "move_pct": None,
                "source": "coach",
                "thesis": idea.get("thesis") or "",
                "chain": [],
                "markets": [],
                "tickers": [idea.get("ticker")] if idea.get("ticker") else [],
                "direction": idea.get("direction") or "up",
                "horizon_days": idea.get("horizon_days") or DEFAULT_IDEA_HORIZON_D,
                "confidence": "moyenne",
                "invalidation": "(non précisée)",
                # Champs TRAVERSANTS : c'est eux qui permettent au radar de
                # ventiler son bilan par étage (``radar.stats_by_level``). Une
                # hypothèse écrite sans eux compterait sous « radar » et le
                # niveau spéculatif ne serait jamais jugé.
                "risk_level": idea.get("risk_level") or llm.DEFAULT_RISK_LEVEL,
                "asset_kind": idea.get("asset_kind") or quotes.DEFAULT_KIND,
            })
            open_count += 1
            changed = True
            row["tracked"] = True
            out.append(row)
        if changed:
            radar_module.save_state(state)
        return out
    except Exception as e:                       # noqa: BLE001 - best-effort
        logger.warning("paper: idées non enregistrées au radar: %s", e)
        return [dict(idea, tracked=False) for idea in ideas]


def _pipeline_from_ideas(username: str, ideas: List[Dict[str, Any]]) -> None:
    """Le coach ÉCRIT dans le tableau : chaque idée effectivement SUIVIE par le
    radar devient aussi une ligne du pipeline (``source: "coach"``).

    C'est le point de la demande — « le coach pourra utiliser aussi cet
    outil » : sans ça, ses idées vivraient dans une réponse qu'on ferme, au
    lieu d'atterrir dans la file de travail.

    Seules les idées ``tracked`` sont reprises : une idée refusée par la file
    du radar (``MAX_OPEN``) n'est suivie nulle part, l'écrire ici ferait croire
    le contraire. Le dédoublonnage est celui de ``board.add_pipeline_item``
    (par symbole ACTIF) — le coach peut reproposer AAPL trois jours de suite,
    il n'y aura qu'une ligne.

    Best-effort PAR IDÉE : un symbole bancal ne doit pas faire perdre les
    autres, ni casser une réponse LLM déjà payée.
    """
    for idea in ideas or []:
        if not idea.get("tracked"):
            continue
        try:
            board.add_pipeline_item(username, idea.get("ticker") or "",
                                    idea.get("thesis") or "", "coach",
                                    now_iso=_now_iso())
        except Exception as e:                  # noqa: BLE001 - tableau best-effort
            logger.warning("paper: idée %r non ajoutée au pipeline: %s",
                           idea.get("ticker"), e)


@router.post("/ideas")
def paper_ideas(data: IdeasPayload,
                current_user: User = Depends(require_role("admin", "money", "trader"))):
    """Idées de trade orientées RENTABILITÉ — le coach change de registre : il
    ne fait plus le point, il propose (décision utilisateur).

    Contexte assemblé COMME ``/coach/ask`` (portefeuille synchronisé, biais,
    stats, watchlist) + les hypothèses radar déjà ouvertes (pour ne pas les
    reproposer) + les événements récents (presse, dépôts 13F) — les trois
    derniers en best-effort, modules importés paresseusement comme leurs
    voisins ``/news``/``/radar``/``whales``.

    Chaque idée valide (ticker Yahoo présent) est enregistrée comme
    hypothèse RADAR ``source: "coach"`` — la file reste bornée par
    ``radar.MAX_OPEN`` : au-delà, l'idée est rendue au client
    (``tracked: false``) mais pas persistée. Panne LLM -> 502 propre.

    Les idées SUIVIES atterrissent en plus dans le pipeline de la vue « Plan »
    (``_pipeline_from_ideas``, best-effort) : le coach ne se contente pas de
    parler, il remplit le tableau.

    ``risk_level`` choisit l'étage (« mesuré » par défaut, « agressif »,
    « spéculatif » = crypto et forex ouverts). Il est NORMALISÉ ici et renvoyé
    dans la réponse : le client lit l'étage réellement appliqué, pas celui qu'il
    croit avoir demandé. Chaque idée le porte, et le radar le garde — c'est ce
    qui rend le bilan par niveau possible.
    """
    username = current_user.username
    lang = normalize_lang(data.lang)
    risk_level = llm.normalize_risk_level(data.risk_level)
    context = _strategy_context(username, risk_level=data.risk_level)
    # Il se base sur ce qu'il A (le contexte ci-dessus, la mémoire) ET il va
    # voir AU-DELÀ, à la seconde du clic. Best-effort : rien récolté -> pas de
    # clé, et l'appel au modèle part quand même.
    sweep = _fresh_sweep(_sweep_targets(username))
    if sweep:
        context["recherche_fraiche"] = sweep
    journal = _journal_summary(username)

    try:
        text = llm.suggest_ideas(context, lang, risk_level, journal)
    except RuntimeError as e:
        raise HTTPException(status_code=502, detail=str(e)[:300])

    ideas = _register_radar_ideas(_parse_ideas_json(text, risk_level), _now_iso())
    # La curiosité du coach nourrit sa base : les titres qu'il vient de choisir
    # et sur lesquels on n'a aucun recul sont collectés maintenant (cap 2).
    _backfill_new_tickers(ideas)
    _pipeline_from_ideas(username, ideas)
    _journal_append(username, "ideas", text, lang=lang, risk_level=risk_level,
                    ideas=ideas)
    return {"text": text, "ideas": ideas, "risk_level": risk_level}


# --------------------------------------------------------------------------- #
# Endpoints — journal des idées (mémoire du coach)
#
# « Journal des vieilles idées avec dates, le coach y a accès pour ne pas
# reproposer les mêmes. » Le journal est écrit à chaque réponse et relu à
# chaque demande : c'est ce qui transforme une suite de réponses isolées en
# une conversation qui se souvient.
# --------------------------------------------------------------------------- #

JOURNAL_PAGE_LIMIT = 20
IDEAS_FOR_SYMBOL_LIMIT = 10


def _journal_summary(username: str) -> List[Dict[str, Any]]:
    """Le résumé du journal destiné au prompt (best-effort).

    Croisé avec l'état du radar pour dire ce que les idées passées ont DONNÉ.
    Une panne ici ne doit jamais empêcher le coach de répondre : il répondrait
    juste sans mémoire.
    """
    try:
        entries = idea_journal.load_entries(username)
    except Exception as e:                          # noqa: BLE001
        logger.warning("paper: journal des idées illisible: %s", e)
        return []
    outcomes: Dict[str, str] = {}
    try:
        outcomes = idea_journal.outcome_index(_radar().load_state()
                                              .get("hypotheses") or [])
    except Exception:                               # noqa: BLE001 — radar absent
        outcomes = {}
    return idea_journal.summarize(entries, outcomes=outcomes)


def _journal_append(username: str, kind: str, text: str, lang: str = "fr",
                    risk_level: Optional[str] = None,
                    ideas: Any = None, verdicts: Any = None) -> None:
    """Ajoute une entrée au journal — best-effort STRICT.

    Une écriture qui échoue ne doit JAMAIS faire perdre une réponse LLM déjà
    payée : c'est le même raisonnement que ``_pipeline_from_ideas``.
    """
    try:
        idea_journal.append_entry(username, kind=kind, text=text, lang=lang,
                                  risk_level=risk_level, ideas=ideas,
                                  verdicts=verdicts, now_iso=_now_iso())
    except Exception as e:                          # noqa: BLE001
        logger.warning("paper: entrée de journal non écrite: %s", e)


@router.get("/ideas/journal")
def paper_ideas_journal(limit: int = JOURNAL_PAGE_LIMIT,
                        current_user: User = Depends(require_role("admin", "money", "trader"))):
    """Le journal des idées et des revues, la plus récente en tête."""
    try:
        limit = max(0, int(limit))
    except (TypeError, ValueError):
        limit = JOURNAL_PAGE_LIMIT
    entries = idea_journal.load_entries(current_user.username)
    return {"entries": entries[:limit]}


@router.get("/ideas/for-symbol")
def paper_ideas_for_symbol(symbol: str = "",
                           current_user: User = Depends(require_role("admin", "money", "trader"))):
    """Tout ce que le coach a déjà dit sur UN titre — LECTURE PURE.

    Zéro appel au modèle, zéro requête réseau : on assemble ce qui est déjà
    écrit sur le disque. Deux sources, trois familles de lignes :

    * l'état du RADAR — les hypothèses (toutes sources confondues) qui portent
      ce ticker, avec leur verdict quand elles ont été notées ;
    * le JOURNAL — les idées proposées sur ce ticker, et les postures de revue
      qui le concernent.

    Trié du plus récent au plus ancien, borné à ``IDEAS_FOR_SYMBOL_LIMIT``.
    Aucun résultat -> ``{"items": []}`` et un 200 : le frontend n'affiche rien,
    ce n'est pas une erreur.
    """
    wanted = str(symbol or "").strip().upper()
    if not wanted:
        raise HTTPException(status_code=400, detail="Symbole manquant.")

    items: List[Dict[str, Any]] = []
    try:
        hypotheses = _radar().load_state().get("hypotheses") or []
    except Exception:                               # noqa: BLE001 — radar absent
        hypotheses = []
    for hyp in hypotheses:
        if not isinstance(hyp, dict):
            continue
        tickers = [str(t or "").strip().upper() for t in (hyp.get("tickers") or [])]
        if wanted not in tickers:
            continue
        row = {
            "from": "radar",
            "ts": hyp.get("created_at"),
            "source": hyp.get("source"),
            "direction": hyp.get("direction"),
            "horizon_days": hyp.get("horizon_days"),
            "thesis": hyp.get("thesis"),
            "status": hyp.get("status"),
            "outcome": hyp.get("outcome"),
            "move_pct": hyp.get("move_pct"),
        }
        if hyp.get("risk_level"):
            row["risk_level"] = hyp.get("risk_level")
        items.append(row)

    for entry in idea_journal.load_entries(current_user.username):
        ts = entry.get("ts")
        for idea in (entry.get("ideas") or []):
            if not isinstance(idea, dict):
                continue
            if str(idea.get("ticker") or "").strip().upper() != wanted:
                continue
            items.append({
                "from": "journal",
                "ts": ts,
                "risk_level": idea.get("risk_level") or entry.get("risk_level"),
                "direction": idea.get("direction"),
                "horizon_days": idea.get("horizon_days"),
                "thesis": idea.get("thesis"),
                "tracked": bool(idea.get("tracked")),
            })
        for verdict in (entry.get("verdicts") or []):
            if not isinstance(verdict, dict):
                continue
            if str(verdict.get("symbol") or "").strip().upper() != wanted:
                continue
            items.append({
                "from": "review",
                "ts": ts,
                "stance": verdict.get("stance"),
                "reason": verdict.get("reason"),
            })

    items.sort(key=lambda row: str(row.get("ts") or ""), reverse=True)
    return {"items": items[:IDEAS_FOR_SYMBOL_LIMIT]}


# --------------------------------------------------------------------------- #
# Endpoint — revue des positions détenues (« prévision de vente »)
# --------------------------------------------------------------------------- #

REVIEW_NEWS_MAX_AGE_D = 7
REVIEW_NEWS_PER_SYMBOL = 4


def _position_factpack(username: str,
                       portfolio: models.Portfolio) -> Dict[str, Any]:
    """Les faits DÉTERMINISTES de chaque position détenue.

    Tout est calculé ici, jamais demandé au modèle : sa plus-value, la distance
    au stop, les dépêches récentes de ce titre, les mouvements de gérants qui
    le concernent. Le modèle met en mots des chiffres qu'il ne peut pas se
    tromper à calculer.

    Un cours indisponible sort à ``null`` — et le prompt DIT au modèle de le
    signaler plutôt que de l'inventer.
    """
    news = _recent_news(username)
    cutoff = _epoch(_now_iso())
    cutoff = (cutoff - REVIEW_NEWS_MAX_AGE_D * 86400) if cutoff else None
    gov_recent = any(isinstance(e, dict) and e.get("sentiment") == "gov"
                     and (cutoff is None or (_epoch(e.get("ts")) or 0) >= cutoff)
                     for e in news)
    moves = _whale_moves()

    # Un seul appel de cours PAR SYMBOLE (une ligne longue et une ligne vendeuse
    # sur le même titre ne le paient pas deux fois).
    quotes_by_symbol: Dict[str, Dict[str, Any]] = {}
    for position in portfolio.positions:
        symbol = str(position.symbol).upper()
        if symbol in quotes_by_symbol:
            continue
        try:
            quotes_by_symbol[symbol] = quotes.get_quote(position.symbol) or {}
        except Exception as e:                      # noqa: BLE001 — best-effort
            logger.warning("paper: cours indisponible pour la revue (%s): %s",
                           symbol, e)
            quotes_by_symbol[symbol] = {}

    # ⚠️ ``models.Position`` ne porte PAS de nom : sans le nom Yahoo (la
    # cotation) ou celui de la watchlist, ``match_issuer`` comparerait
    # « APPLE INC » à « AAPL » et ne rapprocherait JAMAIS un mouvement de
    # gérant d'une position. Le repli sur le ticker ne sert qu'à garder la clé.
    names = {symbol: (str(quote.get("name") or "").strip() or symbol)
             for symbol, quote in quotes_by_symbol.items()}
    for row in _watchlist_context(username):
        symbol = str(row.get("symbol") or "").upper()
        name = str(row.get("name") or "").strip()
        if symbol in names and names[symbol] == symbol and name:
            names[symbol] = name

    # Un seul appel pour toutes les positions : le dossier historique est un
    # état sur disque, pas une requête par titre.
    history = _backfill_digest([p.symbol for p in portfolio.positions])

    rows: List[Dict[str, Any]] = []
    for position in portfolio.positions:
        symbol = str(position.symbol).upper()
        last_price = quotes_by_symbol.get(symbol, {}).get("price")
        pnl_pct = _pct(last_price, position.avg_price)
        if position.side == "short" and pnl_pct is not None:
            pnl_pct = round(-pnl_pct, 2)            # vendeur : le gain est inversé

        titles = []
        for event in news:
            if not isinstance(event, dict):
                continue
            if str(event.get("symbol") or "").upper() != symbol:
                continue
            if event.get("sentiment") not in ("pos", "neg"):
                continue
            if cutoff is not None and (_epoch(event.get("ts")) or 0) < cutoff:
                continue
            titles.append({"title": event.get("title"),
                           "sentiment": event.get("sentiment"),
                           "ts": event.get("ts")})
            if len(titles) >= REVIEW_NEWS_PER_SYMBOL:
                break

        on_this = []
        for move in moves:
            try:
                matched = _whales().match_issuer(move.get("name"), names)
            except Exception:                       # noqa: BLE001
                matched = None
            if matched == symbol:
                on_this.append({"manager_label": move.get("manager_label"),
                                "action": move.get("action"),
                                "quarter": move.get("quarter"),
                                "delta_pct": move.get("delta_pct")})

        rows.append({
            "symbol": symbol,
            "side": position.side,
            "qty": position.qty,
            "avg_price": position.avg_price,
            "last_price": last_price,
            "pnl_pct": pnl_pct,
            "stop_loss": position.stop_loss,
            "distance_stop_pct": _pct(position.stop_loss, last_price),
            "news_recentes": titles,
            "gov_recent": gov_recent,
            "whale_moves_on_this": on_this,
            "historique": history.get(symbol, []),
        })
    return {"positions": rows}


@router.post("/positions/review")
def paper_positions_review(data: ReviewPayload,
                           current_user: User = Depends(require_role("admin", "money", "trader"))):
    """Revue des positions DÉTENUES — « le bouton qui analyse avec les infos
    qu'on a déjà ».

    Aucune nouvelle source : on assemble un fait-pack déterministe (prix de
    revient, cours, plus-value, stop et sa distance, presse récente du titre,
    mouvements de gérants) puis le coach le met en mots et conclut par une
    posture par position.

    Portefeuille sans position -> 400 avec un message clair : demander une
    revue de rien n'est pas une erreur du serveur, c'est un malentendu.
    Panne LLM -> 502. Le texte est APPENDÉ au journal, comme les idées.
    """
    username = current_user.username
    portfolio = _load(username)
    if not portfolio.positions:
        raise HTTPException(
            status_code=400,
            detail="Aucune position ouverte : il n'y a rien à passer en revue.")

    lang = normalize_lang(data.lang)
    context = _position_factpack(username, portfolio)
    synced = _sync_coach(username, portfolio.to_dict(), force=True)
    context["stats"] = synced["stats"]
    context["radar_open_hypotheses"] = [
        h for h in _open_radar_hypotheses()
        if isinstance(h, dict) and any(
            str(t or "").upper() in {str(p.symbol).upper()
                                     for p in portfolio.positions}
            for t in (h.get("tickers") or []))
    ]
    # Les rendez-vous DATÉS (W2b) — même fait-pack que ``/ideas``. Garder une
    # position en portefeuille jusqu'à la veille d'une réunion de banque
    # centrale, ce n'est pas la même décision que la garder un mois ordinaire :
    # la revue doit voir ce que la position va TRAVERSER.
    agenda = _agenda_macro()
    if agenda:
        context["agenda_macro"] = agenda

    try:
        text = llm.review_positions(context, lang)
    except RuntimeError as e:
        raise HTTPException(status_code=502, detail=str(e)[:300])

    verdicts = llm.parse_review(text)
    _journal_append(username, "review", text, lang=lang, verdicts=verdicts)
    return {"text": text, "verdicts": verdicts}


# --------------------------------------------------------------------------- #
# Endpoints — réglages de la veille (mode d'alerte, comptes X suivis)
#
# Réservés à ``admin``/``money`` : ce sont des réglages qui changent ce que le
# téléphone reçoit et ce que le serveur va chercher sur le réseau, pas des
# actions de trading.
# --------------------------------------------------------------------------- #

@router.get("/alerts-mode")
def paper_alerts_mode(current_user: User = Depends(require_role("admin", "money"))):
    """Le mode d'alerte courant et les modes disponibles."""
    return {"mode": alerts.get_mode(), "modes": list(alerts.MODES)}


@router.post("/alerts-mode")
def paper_set_alerts_mode(data: AlertsModePayload,
                          current_user: User = Depends(require_role("admin", "money"))):
    """Change le mode d'alerte. Rend le mode RÉELLEMENT appliqué (normalisé)."""
    try:
        mode = alerts.set_mode(data.mode)
    except OSError as e:
        raise HTTPException(status_code=500,
                            detail="Mode non enregistré: %s" % str(e)[:200])
    return {"mode": mode, "modes": list(alerts.MODES)}


@router.get("/x-accounts")
def paper_x_accounts(current_user: User = Depends(require_role("admin", "money"))):
    """Les comptes X suivis par la veille."""
    module = _newswatch()
    return {"handles": module.load_x_accounts(), "max": module.X_MAX_HANDLES}


@router.post("/x-accounts")
def paper_set_x_accounts(data: XAccountsPayload,
                         current_user: User = Depends(require_role("admin", "money"))):
    """REMPLACE la liste des comptes X suivis. Rend la liste réellement écrite
    — un handle invalide est écarté en silence plutôt que corrigé : un nom
    sanitisé pointerait sur un AUTRE compte que celui demandé."""
    module = _newswatch()
    try:
        handles = module.save_x_accounts(data.handles)
    except OSError as e:
        raise HTTPException(status_code=500,
                            detail="Comptes non enregistrés: %s" % str(e)[:200])
    return {"handles": handles, "max": module.X_MAX_HANDLES}


# --------------------------------------------------------------------------- #
# Endpoints — watchlist (titres favoris à creuser)
#
# Fichier SÉPARÉ du portefeuille (cf. ``store.watchlist_path``) : le round-trip
# par la dataclass ``models.Portfolio`` stripperait toute clé inconnue.
# --------------------------------------------------------------------------- #

@router.get("/watchlist")
def paper_watchlist_list(current_user: User = Depends(require_role("admin", "money", "trader"))):
    """La watchlist de l'utilisateur, telle quelle."""
    return {"symbols": store.load_watchlist(current_user.username)}


@router.post("/watchlist")
def paper_watchlist_add(data: WatchlistPayload,
                        current_user: User = Depends(require_role("admin", "money", "trader"))):
    """Ajoute un titre à la watchlist. Idempotent sur un doublon (pas d'erreur,
    liste inchangée) — dédoublonnage CASE-INSENSITIVE."""
    symbol = str(data.symbol or "").strip().upper()
    if not symbol:
        raise HTTPException(status_code=400, detail="Symbole manquant.")

    username = current_user.username
    symbols = store.load_watchlist(username)
    if any(str(row.get("symbol") or "").upper() == symbol for row in symbols):
        return {"symbols": symbols}
    if len(symbols) >= MAX_WATCHLIST:
        raise HTTPException(status_code=400,
                            detail="Liste de suivi pleine (%d titres maximum)."
                                   % MAX_WATCHLIST)

    try:
        quote = quotes.get_quote(symbol)
    except quotes.UnknownSymbol as e:
        raise HTTPException(status_code=404, detail=str(e))
    except quotes.QuoteError as e:
        raise HTTPException(status_code=502, detail=str(e))

    symbols.append({
        "symbol": symbol,
        "name": quote.get("name") or "",
        "currency": quote.get("currency") or models.DEFAULT_CURRENCY,
        "added_at": _now_iso(),
    })
    store.save_watchlist(username, symbols)
    return {"symbols": symbols}


@router.delete("/watchlist/{symbol}")
def paper_watchlist_remove(symbol: str,
                           current_user: User = Depends(require_role("admin", "money", "trader"))):
    """Retire un titre de la watchlist. 404 s'il n'y était pas."""
    username = current_user.username
    wanted = str(symbol or "").strip().upper()
    symbols = store.load_watchlist(username)
    remaining = [row for row in symbols
                if str(row.get("symbol") or "").upper() != wanted]
    if len(remaining) == len(symbols):
        raise HTTPException(status_code=404, detail="Titre absent de la liste de suivi.")
    store.save_watchlist(username, remaining)
    return {"symbols": remaining}


# --------------------------------------------------------------------------- #
# Endpoints — vue « Plan » (pipeline d'achats, progression, scénarios)
#
# Le tableau de bord du module, dans l'esprit de Mission Control : ce qu'on
# prépare, où on en est, et les chemins que le coach imagine pour le marché.
#
# Invariant : le tableau ne peut pas mentir. Les trois dernières étapes d'un
# item (ordre/position/clos) sont DÉRIVÉES du portefeuille à chaque lecture, et
# la progression est RECALCULÉE depuis le profil coach — rien de tout cela
# n'est stocké dans le tableau, donc rien ne peut dériver du réel.
# --------------------------------------------------------------------------- #

def _arena_rows(profile: Dict[str, Any],
                portfolio: models.Portfolio) -> List[Dict[str, Any]]:
    """L'historique ÉVALUÉ des défis (``arena_view``), seule source honnête du
    nombre de défis RÉUSSIS : le profil ne stocke que l'acceptation, le verdict
    se recalcule depuis le catalogue et les trades de la semaine."""
    history = [h for h in (profile.get("arena_history") or []) if isinstance(h, dict)]
    view = arena_view(arena_catalog(), history,
                      [t.to_dict() for t in portfolio.trades],
                      portfolio.initial_capital, _week_id(datetime.now()))
    return view.get("history") or []


def _board_payload(username: str) -> Dict[str, Any]:
    """Le tableau complet, tel que l'interface le consomme."""
    portfolio = _load(username)
    portfolio_dict = portfolio.to_dict()
    profile = store.load_coach(username) or coach.empty_profile()
    data = board.load_board(username)
    return {
        "pipeline": board.pipeline_view(data.get("pipeline"), portfolio_dict),
        "learning": board.learning_summary(
            profile, portfolio_dict.get("trades") or [],
            lessons_total=len(lessons_catalog()),
            initial_capital=portfolio.initial_capital,
            arena_rows=_arena_rows(profile, portfolio)),
        "scenarios": board.scenarios_view(data),
    }


def _pipeline_view(username: str) -> List[Dict[str, Any]]:
    """Le pipeline seul, enrichi des étapes dérivées (retour des écritures)."""
    portfolio = _load(username)
    return board.pipeline_view(board.load_board(username).get("pipeline"),
                               portfolio.to_dict())


@router.get("/board")
def paper_board(current_user: User = Depends(require_role("admin", "money", "trader"))):
    """Pipeline (étapes dérivées du portefeuille) + progression + scénarios.

    Aucun réseau, aucun LLM : tout est lu sur disque et recalculé.
    """
    return _board_payload(current_user.username)


@router.post("/board/pipeline")
def paper_board_pipeline_add(data: BoardItemPayload,
                             current_user: User = Depends(require_role("admin", "money", "trader"))):
    """Note un futur achat. Le symbole est VÉRIFIÉ chez Yahoo (404 s'il est
    inconnu) — un pipeline plein de tickers fantômes ne servirait qu'à
    fabriquer des idées sur des titres qui n'existent pas.

    Idempotent par symbole ACTIF : re-poster un titre déjà suivi rend la ligne
    existante (``duplicate: true``) sans rien dupliquer.
    """
    symbol = str(data.symbol or "").strip().upper()
    if not symbol:
        raise HTTPException(status_code=400, detail="Symbole manquant.")

    username = current_user.username
    try:
        quote = quotes.get_quote(symbol)
    except quotes.UnknownSymbol as e:
        raise HTTPException(status_code=404, detail=str(e))
    except quotes.QuoteError as e:
        raise HTTPException(status_code=502, detail=str(e))

    item = board.add_pipeline_item(username, symbol, data.thesis, "moi",
                                   name=quote.get("name") or "",
                                   now_iso=_now_iso())
    pipeline = _pipeline_view(username)
    decorated = next((row for row in pipeline if row.get("id") == item.get("id")), item)
    decorated = dict(decorated)
    decorated["duplicate"] = bool(item.get("duplicate"))
    return {"item": decorated, "pipeline": pipeline}


@router.post("/board/pipeline/{item_id}")
def paper_board_pipeline_stage(item_id: str, data: BoardStagePayload,
                               current_user: User = Depends(require_role("admin", "money", "trader"))):
    """Passe un item de « à l'étude » à « prêt » (et retour).

    400 sur toute autre étape : ``ordre``/``position``/``clos`` se méritent (un
    ordre passé, une position ouverte, un trade clos) — les déclarer à la main
    rendrait le tableau menteur.
    """
    username = current_user.username
    try:
        item = board.set_stage(username, item_id, data.stage_manual)
    except ValueError:
        raise HTTPException(
            status_code=400,
            detail="Étape inconnue (attendu : %s)." % " ou ".join(board.MANUAL_STAGES))
    if item is None:
        raise HTTPException(status_code=404, detail="Ligne introuvable.")

    pipeline = _pipeline_view(username)
    decorated = next((row for row in pipeline if row.get("id") == item.get("id")), item)
    return {"item": decorated, "pipeline": pipeline}


@router.delete("/board/pipeline/{item_id}")
def paper_board_pipeline_remove(item_id: str,
                                current_user: User = Depends(require_role("admin", "money", "trader"))):
    """Retire une ligne du pipeline. 404 si elle n'y était pas."""
    username = current_user.username
    if not board.remove_pipeline_item(username, item_id):
        raise HTTPException(status_code=404, detail="Ligne introuvable.")
    return {"pipeline": _pipeline_view(username)}


@router.post("/board/scenarios/generate")
def paper_board_scenarios_generate(data: BoardScenarioPayload,
                                   current_user: User = Depends(require_role("admin", "money", "trader"))):
    """Le coach dessine un arbre de chemins possibles pour le marché.

    Contexte assemblé comme ``/ideas`` (``_strategy_context``) + le pipeline en
    cours : les futurs achats notés font partie de ce qui est en jeu.

    L'arbre est normalisé et rangé côté serveur (identifiants, statuts, dates
    — jamais lus du modèle). Réponse illisible (pas d'arbre exploitable) ->
    502, comme une panne du LLM : mieux vaut le dire que d'afficher un
    demi-arbre.
    """
    username = current_user.username
    context = _strategy_context(username)
    context["pipeline"] = _pipeline_view(username)
    # Même balayage frais que ``/ideas`` : cartographier les chemins possibles
    # à partir d'une actualité vieille de plusieurs heures dessinerait l'arbre
    # d'hier. Best-effort, comme là-bas.
    sweep = _fresh_sweep(_sweep_targets(username))
    if sweep:
        context["recherche_fraiche"] = sweep

    lang = normalize_lang(data.lang)
    try:
        text = llm.suggest_scenarios(context, lang)
    except RuntimeError as e:
        raise HTTPException(status_code=502, detail=str(e)[:300])

    parsed = llm.parse_scenarios(text)
    if parsed is None:
        raise HTTPException(status_code=502,
                            detail="Le coach n'a pas rendu d'arbre exploitable.")

    tree = board.add_scenario(username, parsed, _now_iso())
    return {"text": llm.intro_of(text), "tree": tree,
            "scenarios": board.scenarios_view(board.load_board(username))}


@router.post("/board/scenarios/{tree_id}/branches/{branch_id}")
def paper_board_branch_resolve(tree_id: str, branch_id: str, data: BoardBranchPayload,
                               current_user: User = Depends(require_role("admin", "money", "trader"))):
    """Marque une branche : ce chemin s'est produit, ou il est mort.

    C'est ce qui donne sa valeur à l'arbre — sans verdict, une prévision reste
    de l'astrologie. Aucun retour en arrière (400 sur tout autre statut) : la
    trace de ce qu'on avait prévu ne se réécrit pas.
    """
    username = current_user.username
    try:
        tree = board.resolve_scenario_branch(username, tree_id, branch_id,
                                             data.status, _now_iso())
    except ValueError:
        raise HTTPException(
            status_code=400,
            detail="Statut inconnu (attendu : %s)." % " ou ".join(board.RESOLVABLE_STATUSES))
    if tree is None:
        raise HTTPException(status_code=404, detail="Scénario ou branche introuvable.")
    return {"tree": tree,
            "scenarios": board.scenarios_view(board.load_board(username))}


@router.delete("/board/scenarios/{tree_id}")
def paper_board_scenario_archive(tree_id: str,
                                 current_user: User = Depends(require_role("admin", "money", "trader"))):
    """Archive un arbre — jamais de suppression dure : un scénario périmé
    raconte ce qu'on croyait, et c'est exactement ce qu'on veut pouvoir
    relire."""
    username = current_user.username
    tree = board.archive_scenario(username, tree_id, _now_iso())
    if tree is None:
        raise HTTPException(status_code=404, detail="Scénario introuvable.")
    return {"tree": tree,
            "scenarios": board.scenarios_view(board.load_board(username))}


# --------------------------------------------------------------------------- #
# Endpoints — graphe des connexions (§ vue « toile »)
#
# Doctrine, en une phrase : les nœuds sont étiquetés à l'ÉCRITURE (chaque module
# range déjà ce qu'il sait avec son symbole, ses tickers, son nom d'émetteur),
# les ARÊTES sont recalculées à la LECTURE. Aucun lien n'est stocké, donc aucun
# lien ne périme quand une position se solde ou qu'une hypothèse se referme.
#
# Zéro appel au modèle, zéro requête réseau : on relit ce qui est déjà sur le
# disque, par les mêmes accès que ``_strategy_context`` et ``/ideas/for-symbol``.
# --------------------------------------------------------------------------- #

def _graph_inputs(username: str) -> Dict[str, Any]:
    """Les entrées du graphe, assemblées par les accès qui EXISTENT déjà.

    BEST-EFFORT PAR SOURCE : une source en panne est simplement ABSENTE du
    graphe — jamais un 500. Un graphe partiel se lit ; une erreur, non. C'est
    la même posture que ``_strategy_context``, dont ce bloc réutilise les
    lecteurs (``_watchlist_context``, ``_recent_news``, ``_whale_moves``,
    ``_radar_hypotheses``) plutôt que d'en ouvrir de parallèles.

    ⚠️ Une POSITION ne porte pas de nom (``models.Position`` n'a que le
    symbole) : c'est la watchlist ou le pipeline qui le fournit, et sans nom
    aucun émetteur 13F ne rejoindrait jamais ce titre. ``graph.collect_anchors``
    fait la fusion — d'où l'intérêt d'envoyer les trois familles telles quelles.
    """
    anchors: List[Dict[str, Any]] = []
    try:
        for position in _load(username).positions:
            symbol = str(position.symbol or "").strip().upper()
            if symbol:
                anchors.append({"symbol": symbol, "kind": "position"})
    except Exception as e:                          # noqa: BLE001 — best-effort
        logger.warning("paper: portefeuille indisponible pour le graphe: %s", e)

    for row in _watchlist_context(username):
        symbol = str(row.get("symbol") or "").strip().upper()
        if symbol:
            anchors.append({"symbol": symbol, "name": row.get("name"),
                            "kind": "watchlist"})

    try:
        pipeline = _pipeline_view(username)
    except Exception as e:                          # noqa: BLE001 — best-effort
        logger.warning("paper: pipeline indisponible pour le graphe: %s", e)
        pipeline = []

    return {
        "anchors": anchors,
        "pipeline": pipeline,
        "events": _recent_news(username),
        "hypotheses": _radar_hypotheses(),
        "whale_moves": _whale_moves(),
        "reddit_trends": _reddit_trends(),
    }


def _build_graph(username: str, symbol: Optional[str],
                 now_iso: Optional[str] = None) -> Dict[str, Any]:
    """Assemble puis construit — le chemin COMMUN au graphe et au compteur.

    ``now_iso`` vient de l'appelant pour que la fenêtre de fraîcheur et le
    ``generated_at`` de la réponse parlent du MÊME instant.
    """
    data = _graph_inputs(username)
    return graph.build_graph(data["anchors"], data["events"], data["hypotheses"],
                             data["whale_moves"], data["pipeline"],
                             now_iso or _now_iso(), symbol=symbol,
                             reddit_trends=data["reddit_trends"])


@router.get("/graph")
def paper_graph(symbol: str = "",
                current_user: User = Depends(require_role("admin", "money", "trader"))):
    """Le graphe des connexions — LECTURE PURE.

    Sans ``symbol`` : la vue d'ensemble, tes titres au centre et autour tout ce
    que la mémoire y rattache (dépêches, catalyseurs, politique, crypto, posts
    X, hypothèses du radar, mouvements des grands gérants). Le macro qui ne
    nomme aucun titre se range sous un pivot « monde » unique, relié à aucune
    ancre — jamais un lien inventé.

    Avec ``symbol=X`` : la BRANCHE de ce titre — son ancre et ses voisins
    directs. Un titre ni détenu, ni suivi, ni en projet n'a pas d'ancre : la
    branche est alors vide, et c'est un 200 (le frontend n'affiche rien, ce
    n'est pas une erreur).
    """
    wanted = str(symbol or "").strip().upper()
    now_iso = _now_iso()
    built = _build_graph(current_user.username, wanted or None, now_iso)
    return {"nodes": built["nodes"], "edges": built["edges"],
            "truncated": built["truncated"], "generated_at": now_iso}


@router.get("/graph/grove")
def paper_graph_grove(kind: str = "",
                      current_user: User = Depends(require_role("admin", "money", "trader"))):
    """TOUT un bosquet, en liste — ce que la toile ne DESSINE pas.

    Le graphe plafonne chaque bosquet à douze satellites et résume le reste en
    « +N autres » : lisible, mais muet sur ces N. Ici on les rend tous (150 au
    plus, ``total`` disant combien la mémoire en garde vraiment), dans le MÊME
    ordre que le dessin — c'est le même balayage, la même fenêtre de fraîcheur
    et le même rapprochement d'émetteurs (``graph._collect``), donc les deux ne
    peuvent pas diverger.

    Un ``kind`` hors des trois bosquets connus est un 400 : rendre une liste
    vide se lirait « il n'y a rien », alors qu'on a simplement mal demandé.

    Même posture best-effort par source que ``/graph`` : une source en panne est
    ABSENTE de la liste, jamais un 500.
    """
    wanted = str(kind or "").strip().lower()
    if wanted not in graph.GROVE_KINDS:
        raise HTTPException(status_code=400, detail="Bosquet inconnu.")
    data = _graph_inputs(current_user.username)
    built = graph.build_grove(wanted, data["anchors"], data["events"],
                              data["hypotheses"], data["whale_moves"],
                              data["pipeline"], _now_iso(),
                              reddit_trends=data["reddit_trends"])
    return {"kind": built["kind"], "items": built["items"],
            "total": built["total"]}


@router.get("/graph/count")
def paper_graph_count(symbol: str = "",
                      current_user: User = Depends(require_role("admin", "money", "trader"))):
    """Combien de connexions la mémoire porte sur CE titre — réponse minimale,
    faite pour un pastillage (« N connexions en mémoire ») sans transporter tout
    le graphe. Même assemblage que ``/graph`` : les deux ne peuvent pas
    diverger."""
    wanted = str(symbol or "").strip().upper()
    if not wanted:
        raise HTTPException(status_code=400, detail="Symbole manquant.")
    nodes = _build_graph(current_user.username, wanted)["nodes"]
    # ``nodes`` = l'ancre + ses voisins (vide si le titre n'est pas une ancre).
    # Les nœuds de THÈME sont des intercalaires de mise en forme, pas des
    # connexions : les compter ferait grimper « N connexions en mémoire » sans
    # qu'une seule information de plus soit arrivée.
    real = [n for n in nodes if n.get("type") != graph.THEME_TYPE]
    return {"count": max(0, len(real) - 1)}
