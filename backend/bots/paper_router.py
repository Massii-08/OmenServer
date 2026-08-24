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
import uuid
from datetime import datetime
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from backend.auth.models import User
from backend.auth.permissions import require_role
from backend.bots.paper import coach, fees, fills, llm, models, quotes, risk, store

logger = logging.getLogger("omenserver")

router = APIRouter(prefix="/api/paper", tags=["paper"])

_PAPER_DIR = Path(__file__).resolve().parent / "paper"
LESSONS_PATH = _PAPER_DIR / "lessons_fr.json"
ARENA_PATH = _PAPER_DIR / "arena.json"

# Seuils d'AVERTISSEMENT (jamais de blocage — cf. invariant 1).
CONCENTRATION_PCT = 25.0     # une ligne qui pèse plus d'un quart du portefeuille
OVERSIZED_PCT = 2.0          # risque planifié au-delà de 2 % du capital initial
MIN_THESIS_LEN = 15          # même seuil que coach._NO_THESIS_MIN_LEN

MAX_QUOTE_SYMBOLS = 20
MIN_SEARCH_LEN = 2

# Fenêtre lue par le tick : la journée en cours, par tranches de 15 minutes.
# Assez fin pour voir un stop sauter, assez court pour ne pas relire l'histoire.
TICK_RANGE = "1d"
TICK_INTERVAL = "15m"

_SEVERITY_ORDER = {"critical": 0, "warn": 1, "info": 2}

# Cache mémoire du contenu pédagogique (fichiers statiques versionnés).
_lessons_cache: Optional[List[Dict[str, Any]]] = None
_arena_cache: Optional[List[Dict[str, Any]]] = None


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
def _with_concentration(biases: List[Dict[str, Any]],
                        exposure: Dict[str, Any]) -> List[Dict[str, Any]]:
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
    out = list(biases) + [{
        "code": "concentration",
        "severity": "warn",
        "evidence": ["%s pèse %.1f%% du portefeuille (seuil %.0f%%)"
                     % (worst, top, CONCENTRATION_PCT)],
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


def lessons_catalog() -> List[Dict[str, Any]]:
    global _lessons_cache
    if _lessons_cache is None:
        _lessons_cache = _load_json_file(LESSONS_PATH)
    return _lessons_cache


def arena_catalog() -> List[Dict[str, Any]]:
    global _arena_cache
    if _arena_cache is None:
        _arena_cache = _load_json_file(ARENA_PATH)
    return _arena_cache


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


class PostmortemPayload(BaseModel):
    trade_index: Optional[int] = None


class AnalysisPayload(BaseModel):
    symbol: str = ""


class QuizPayload(BaseModel):
    answers: List[int] = []


# --------------------------------------------------------------------------- #
# Endpoints — portefeuille
# --------------------------------------------------------------------------- #
@router.get("/portfolio")
def paper_portfolio(current_user: User = Depends(require_role("admin", "money"))):
    """État complet : positions valorisées, exposition, statistiques, biais, AFC."""
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
        coach.detect_biases(trades, orders, portfolio.initial_capital), exposure)

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
                current_user: User = Depends(require_role("admin", "money"))):
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
                 current_user: User = Depends(require_role("admin", "money"))):
    """Recherche de ticker. Moins de 2 caractères -> liste vide, sans réseau."""
    if len(str(q or "").strip()) < MIN_SEARCH_LEN:
        return []
    try:
        return quotes.search(q)
    except quotes.QuoteError as e:
        raise HTTPException(status_code=502, detail=str(e))


@router.get("/quotes")
def paper_quotes(symbols: str = "",
                 current_user: User = Depends(require_role("admin", "money"))):
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


# --------------------------------------------------------------------------- #
# Endpoints — ordres et positions
# --------------------------------------------------------------------------- #
@router.post("/orders")
def paper_place_order(data: OrderPayload,
                      current_user: User = Depends(require_role("admin", "money"))):
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
                       current_user: User = Depends(require_role("admin", "money"))):
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
                         current_user: User = Depends(require_role("admin", "money"))):
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
def paper_tick(current_user: User = Depends(require_role("admin", "money"))):
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
def paper_coach(current_user: User = Depends(require_role("admin", "money"))):
    """Biais courants + résumé du profil + statistiques. Aucun réseau, aucun LLM."""
    username = current_user.username
    portfolio = _load(username)
    profile = store.load_coach(username) or coach.empty_profile()

    trades = [t.to_dict() for t in portfolio.trades]
    orders = [o.to_dict() for o in portfolio.open_orders]
    biases = coach.detect_biases(trades, orders, portfolio.initial_capital)
    stats = risk.portfolio_stats(trades, initial_capital=portfolio.initial_capital)

    return {
        "biases": biases,
        "summary": coach.coach_summary(profile, biases),
        "stats": stats,
        "profile": profile,
    }


@router.post("/coach/ask")
def paper_coach_ask(data: AskPayload,
                    current_user: User = Depends(require_role("admin", "money"))):
    """Une question au coach. Le LLM RÉDIGE à partir de faits déjà calculés."""
    username = current_user.username
    portfolio = _load(username)
    synced = _sync_coach(username, portfolio.to_dict(), force=True)
    context = _coach_context(portfolio, synced["profile"], synced["biases"],
                             synced["stats"])
    try:
        answer = llm.ask_coach(context, data.question or "")
    except RuntimeError as e:
        raise HTTPException(status_code=502, detail=str(e)[:300])

    _append_journal(username, "session coach", answer, _now_iso())
    return {"answer": answer}


@router.post("/postmortem")
def paper_postmortem(data: PostmortemPayload,
                     current_user: User = Depends(require_role("admin", "money"))):
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
        text = llm.write_postmortem(trade, _coach_context(portfolio, profile, biases, stats))
    except RuntimeError as e:
        raise HTTPException(status_code=502, detail=str(e)[:300])

    r_multiple = trade.get("r_multiple")
    label = "%s %s" % (trade.get("symbol") or "?",
                       "?R" if r_multiple is None else "%+.2fR" % r_multiple)
    _append_journal(username, label, text, _now_iso())
    return {"postmortem": text, "trade": trade, "trade_index": index}


@router.post("/analysis")
def paper_analysis(data: AnalysisPayload,
                   current_user: User = Depends(require_role("admin", "money"))):
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
        text = llm.write_analysis(facts)
    except RuntimeError as e:
        raise HTTPException(status_code=502, detail=str(e)[:300])
    return {"facts": facts, "analysis": text}


@router.get("/coach/notes")
def paper_notes(current_user: User = Depends(require_role("admin", "money"))):
    """Liste des pages du carnet Markdown (contrat §11 : la liste, telle quelle)."""
    return store.list_notes(current_user.username)


@router.get("/coach/notes/{name:path}")
def paper_note(name: str,
               current_user: User = Depends(require_role("admin", "money"))):
    """Contenu brut d'une page du carnet (nom validé par ``store``, anti-traversal)."""
    try:
        markdown = store.read_note(current_user.username, name)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    if markdown is None:
        raise HTTPException(status_code=404, detail="Note introuvable.")
    return {"name": name, "markdown": markdown}


# --------------------------------------------------------------------------- #
# Endpoints — pédagogie
# --------------------------------------------------------------------------- #
@router.get("/lessons")
def paper_lessons(current_user: User = Depends(require_role("admin", "money"))):
    """Catalogue des leçons SANS les réponses + progression de l'utilisateur."""
    profile = store.load_coach(current_user.username) or coach.empty_profile()
    passed = [str(x) for x in (profile.get("lessons_passed") or [])]
    return {"lessons": [public_lesson(l) for l in lessons_catalog()], "passed": passed}


@router.post("/lessons/{lesson_id}/quiz")
def paper_quiz(lesson_id: str, data: QuizPayload,
               current_user: User = Depends(require_role("admin", "money"))):
    """Corrige le quiz côté serveur et enregistre la réussite dans le profil."""
    username = current_user.username
    lesson = None
    for row in lessons_catalog():
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
def paper_arena(current_user: User = Depends(require_role("admin", "money"))):
    """Défi de la semaine (déterministe) + historique évalué des semaines passées."""
    username = current_user.username
    portfolio = _load(username)
    profile = store.load_coach(username) or coach.empty_profile()
    history = [h for h in (profile.get("arena_history") or []) if isinstance(h, dict)]
    return arena_view(arena_catalog(), history,
                      [t.to_dict() for t in portfolio.trades],
                      portfolio.initial_capital, _week_id(datetime.now()))


@router.post("/arena/accept")
def paper_arena_accept(current_user: User = Depends(require_role("admin", "money"))):
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
def paper_radar(current_user: User = Depends(require_role("admin", "money"))):
    """Hypothèses du radar et leur score. Module absent -> radar vide, pas d'erreur."""
    try:
        module = _radar()
    except ImportError:
        return {"stats": {}, "hypotheses": []}
    try:
        return module.recent()
    except Exception as e:                      # noqa: BLE001 - lecture best-effort
        logger.warning("paper: radar indisponible: %s", e)
        return {"stats": {}, "hypotheses": [], "error": str(e)[:200]}


@router.post("/radar/run")
def paper_radar_run(current_user: User = Depends(require_role("admin", "money"))):
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
def paper_news(current_user: User = Depends(require_role("admin", "money"))):
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
