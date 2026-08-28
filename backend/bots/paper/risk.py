"""Mesure du risque — PUR (aucun I/O, aucun réseau).

Le module qui ENSEIGNE : dimensionnement, R multiple, statistiques de méthode,
concentration, et le garde-fou fiscal suisse (circulaire AFC n°36).

Le R multiple est la métrique centrale du module : un gain de 3 % ne dit rien,
un gain de +2 R dit que le trader a encaissé deux fois ce qu'il avait accepté de
perdre. C'est le risque PLANIFIÉ (entrée -> stop) qui sert d'unité, pas le capital.

Sur les dates : ``datetime.fromisoformat`` (Python 3.9) ne sait pas lire le
suffixe ``Z`` — on le retire. Et si un horodatage porte un décalage horaire, on le
retire aussi (lecture « heure au mur ») : mélanger des ``datetime`` avec et sans
fuseau lève un TypeError au moindre calcul de durée.
"""
import math
from datetime import datetime
from typing import Any, Dict, List, Optional

# Circulaire AFC n°36 — statut d'investisseur privé.
AFC_VOLUME_LIMIT = 5.0        # volume de transactions <= 5x le capital
AFC_MIN_HOLDING_DAYS = 183    # détention >= 6 mois

POSITION_SIDES = frozenset({"long", "short"})


# --------------------------------------------------------------------------- #
# Helpers
# --------------------------------------------------------------------------- #
def _val(value: Any) -> Optional[float]:
    """Nombre flottant, ou ``None`` si absent/illisible."""
    if value is None or isinstance(value, bool):
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _parse_iso(value: Any) -> Optional[datetime]:
    """Horodatage ISO -> ``datetime`` NAÏF, ou ``None`` si illisible.

    Accepte ``2026-08-24``, ``2026-08-24T10:30:00``, ``...Z`` et ``...+02:00``.
    Le fuseau est retiré (pas converti) : on ne compare que des dates civiles.
    """
    if not isinstance(value, str):
        return None
    text = value.strip()
    if not text:
        return None
    if text[-1] in ("Z", "z"):
        text = text[:-1]
    try:
        parsed = datetime.fromisoformat(text)
    except (TypeError, ValueError):
        return None
    if parsed.tzinfo is not None:
        parsed = parsed.replace(tzinfo=None)
    return parsed


def _dicts(items: Any) -> List[Dict[str, Any]]:
    """Ne garde que les entrées exploitables d'une liste persistée."""
    if not isinstance(items, list):
        return []
    return [item for item in items if isinstance(item, dict)]


def _mean(values: List[float]) -> Optional[float]:
    if not values:
        return None
    return sum(values) / float(len(values))


# --------------------------------------------------------------------------- #
# R multiple et dimensionnement
# --------------------------------------------------------------------------- #
def r_multiple(entry: Any, exit_: Any, stop: Any, side: str = "long") -> Optional[float]:
    """Résultat exprimé en multiples du risque planifié.

    ``long``  : (sortie - entrée) / (entrée - stop)
    ``short`` : (entrée - sortie) / (stop - entrée)

    Retourne ``None`` si aucun stop n'était planifié, si un prix manque, ou si le
    risque est nul/négatif (stop du mauvais côté de l'entrée) — dans ce cas la
    métrique n'a AUCUN sens et on refuse d'inventer un chiffre.
    """
    side_key = str(side or "long").strip().lower()
    if side_key not in POSITION_SIDES:
        raise ValueError("side de position inconnu: %r" % (side,))

    entry_v, exit_v, stop_v = _val(entry), _val(exit_), _val(stop)
    if entry_v is None or exit_v is None or stop_v is None:
        return None

    if side_key == "long":
        risk = entry_v - stop_v
        gain = exit_v - entry_v
    else:
        risk = stop_v - entry_v
        gain = entry_v - exit_v

    if risk <= 0:
        return None
    return round(gain / risk, 2)


def suggested_qty(capital_chf: Any, risk_pct: Any,
                  entry_price_chf: Any, stop_price_chf: Any) -> int:
    """Nombre d'actions pour risquer ``risk_pct`` % du capital, pas un centime de plus.

    ``risk_pct`` est un POURCENTAGE (``2.0`` = 2 % du capital), pas une fraction.

    Le résultat est tronqué vers le bas : on ne dépasse jamais le risque décidé.
    Retourne ``0`` si le stop est invalide (absent, nul, négatif, ou collé à
    l'entrée) — un risque par action nul autoriserait une taille infinie.

    ⚠️ Ce calcul ignore volontairement la trésorerie disponible : avec un stop
    très serré il peut proposer plus d'actions que le cash ne permet d'acheter.
    C'est à la couche qui passe l'ordre de plafonner par le cash.
    """
    capital = _val(capital_chf)
    pct = _val(risk_pct)
    entry = _val(entry_price_chf)
    stop = _val(stop_price_chf)
    if capital is None or pct is None or entry is None or stop is None:
        return 0
    if capital <= 0 or pct <= 0 or entry <= 0 or stop <= 0:
        return 0

    per_share = abs(entry - stop)
    if per_share <= 0:
        return 0

    budget = capital * (pct / 100.0)
    # +1e-9 : absorbe le bruit binaire (0.25 stocké 0.2500000000000009 ferait
    # perdre une action entière au plancher).
    return max(0, int(math.floor(budget / per_share + 1e-9)))


# --------------------------------------------------------------------------- #
# Statistiques de méthode
# --------------------------------------------------------------------------- #
def portfolio_stats(trades: List[Dict[str, Any]],
                    initial_capital: Any = 0.0) -> Dict[str, Any]:
    """Bilan des trades CLÔTURÉS. Listes vides tolérées (jamais de division par zéro).

    - ``win_rate`` : POURCENTAGE (0-100) de trades gagnants sur le total. Un trade
      à zéro n'est ni gagnant ni perdant mais compte au dénominateur.
    - ``avg_r_win`` / ``avg_r_loss`` / ``expectancy_r`` : moyennes des R multiples
      DISPONIBLES (les trades sans stop planifié n'ont pas de R et sont exclus).
      ``expectancy_r`` est l'espérance en R par trade : c'est elle qui dit si la
      méthode gagne, pas le taux de réussite.
    - ``total_fees_chf`` : courtage + droit de timbre (le coût réel, tout compris).
    - ``max_drawdown_pct`` : plus forte baisse depuis un sommet sur la courbe
      d'équité ``initial_capital + cumul des P&L``. **Passer ``initial_capital``**
      : sans lui (défaut 0) la baisse est mesurée sur le cumul des gains seuls,
      ce qui la surestime massivement (1000 -> 200 = « -80 % » alors que le
      portefeuille n'a perdu que 8 % de 10 000).
    - ``profit_factor`` : gains / |pertes|. ``None`` si aucune perte (ratio infini,
      on ne le maquille pas en nombre) ou si aucun trade.
    """
    rows = _dicts(trades)
    n = len(rows)

    pnls = []
    fees_total = 0.0
    for row in rows:
        pnls.append(_val(row.get("pnl_chf")) or 0.0)
        fees_total += (_val(row.get("fees_chf")) or 0.0)
        fees_total += (_val(row.get("stamp_duty_chf")) or 0.0)

    wins_r, losses_r, all_r = [], [], []
    n_wins = 0
    for row, pnl in zip(rows, pnls):
        r = _val(row.get("r_multiple"))
        if r is not None:
            all_r.append(r)
        if pnl > 0:
            n_wins += 1
            if r is not None:
                wins_r.append(r)
        elif pnl < 0:
            if r is not None:
                losses_r.append(r)

    gains_sum = sum(p for p in pnls if p > 0)
    losses_sum = abs(sum(p for p in pnls if p < 0))
    if losses_sum > 0:
        profit_factor = round(gains_sum / losses_sum, 2)
    else:
        profit_factor = None  # aucune perte -> infini, ou aucun trade

    avg_win = _mean(wins_r)
    avg_loss = _mean(losses_r)
    expectancy = _mean(all_r)

    return {
        "n_trades": n,
        "win_rate": round(n_wins / float(n) * 100.0, 1) if n else 0.0,
        "avg_r_win": round(avg_win, 2) if avg_win is not None else None,
        "avg_r_loss": round(avg_loss, 2) if avg_loss is not None else None,
        "expectancy_r": round(expectancy, 2) if expectancy is not None else None,
        "total_pnl_chf": round(sum(pnls), 2),
        "total_fees_chf": round(fees_total, 2),
        "max_drawdown_pct": _max_drawdown_pct(pnls, _val(initial_capital) or 0.0),
        "profit_factor": profit_factor,
    }


def _max_drawdown_pct(pnls: List[float], initial_capital: float) -> float:
    """Plus forte baisse depuis un sommet, en % du sommet."""
    equity = float(initial_capital)
    peak = equity
    worst = 0.0
    for pnl in pnls:
        equity += pnl
        if equity > peak:
            peak = equity
        if peak > 0:
            drop = (peak - equity) / peak * 100.0
            if drop > worst:
                worst = drop
    return round(worst, 2)


# --------------------------------------------------------------------------- #
# Exposition
# --------------------------------------------------------------------------- #
def exposure(positions: List[Dict[str, Any]],
             quotes: Dict[str, float],
             cash_chf: Any,
             fx_rates: Optional[Dict[str, float]] = None) -> Dict[str, Any]:
    """Répartition du portefeuille — la matière du biais ``concentration``.

    Valorise chaque ligne ``|qty| x cours x fx_rate``. L'exposition est BRUTE : une
    vente à découvert compte comme du risque au même titre qu'un achat.

    - ``quotes`` : cours courant par symbole. Symbole absent -> repli sur
      ``avg_price`` de la position (dernier prix connu) plutôt que d'effacer la
      ligne du total.
    - ``fx_rates`` (optionnel) : taux devise -> CHF du jour ; à défaut on garde le
      ``fx_rate`` historique enregistré dans la position.
    """
    rows = _dicts(positions)
    quotes = quotes if isinstance(quotes, dict) else {}
    rates = fx_rates if isinstance(fx_rates, dict) else {}
    cash = _val(cash_chf) or 0.0

    per_symbol: Dict[str, float] = {}
    invested = 0.0
    for pos in rows:
        symbol = str(pos.get("symbol") or "").strip()
        qty = _val(pos.get("qty"))
        if not symbol or qty is None or abs(qty) <= 0:
            continue

        price = _val(quotes.get(symbol))
        if price is None:
            price = _val(quotes.get(symbol.upper()))
        if price is None:
            price = _val(pos.get("avg_price"))
        if price is None:
            continue

        currency = str(pos.get("currency") or "CHF").strip().upper()
        fx = _val(rates.get(currency))
        if fx is None or fx <= 0:
            fx = _val(pos.get("fx_rate"))
        if fx is None or fx <= 0:
            fx = 1.0

        value = abs(qty) * price * fx
        per_symbol[symbol] = per_symbol.get(symbol, 0.0) + value
        invested += value

    total = invested + cash
    if total > 0:
        per_pct = {sym: round(val / total * 100.0, 2) for sym, val in per_symbol.items()}
    else:
        per_pct = {sym: 0.0 for sym in per_symbol}

    return {
        "invested_chf": round(invested, 2),
        "cash_chf": round(cash, 2),
        "total_chf": round(total, 2),
        "per_position_pct": per_pct,
        "max_concentration_pct": max(per_pct.values()) if per_pct else 0.0,
    }


# --------------------------------------------------------------------------- #
# Garde-fou PRÉ-ordre (LOT 3, C3) — la porte de confirmation
# --------------------------------------------------------------------------- #

# Même seuil que ``paper_router.MIN_THESIS_LEN`` (qui mirrore lui-même
# ``coach._NO_THESIS_MIN_LEN``) : les trois vivent dans des modules qui ne
# peuvent pas s'importer entre eux (``paper_router`` importe déjà ``risk``,
# l'inverse créerait un cycle) — même politique de MIROIR DOCUMENTÉ que le
# couple existant, pas une nouvelle divergence.
PREORDER_MIN_THESIS_LEN = 15

# Mêmes proportions que ``paper_router.OVERSIZED_PCT``/``CONCENTRATION_PCT``,
# sous des noms dédiés : ce sont deux gardes-fous DISTINCTS (l'un informatif et
# non bloquant, l'autre une porte de confirmation) qui partagent la même
# doctrine de seuil, pas la même variable.
PREORDER_RISK_PCT = 2.0
PREORDER_SIZE_PCT = 25.0


def preorder_warnings(payload: Dict[str, Any], portfolio: Dict[str, Any],
                      level: Optional[float]) -> List[str]:
    """Avertissements PRÉ-ordre (LOT 3, C3) — la porte de confirmation posée
    par le router AVANT d'exécuter un ordre d'OUVERTURE, PURE (aucun réseau).

    Codes possibles, dans cet ordre : ``no_thesis`` (thèse vide ou trop
    courte), ``no_stop`` (aucun stop de protection planifié), ``risk_high``
    (risque planifié au-delà de ``PREORDER_RISK_PCT`` % du capital initial),
    ``oversize`` (position projetée au-delà de ``PREORDER_SIZE_PCT`` % de
    l'équité). Liste vide -> rien à confirmer.

    Ne s'applique qu'aux ordres d'OUVERTURE (``buy``/``short``) — une sortie
    n'a besoin ni de thèse ni de stop, et elle réduit toujours l'exposition
    (même restriction que l'avertissement informatif jumeau du router,
    ``compute_warnings``).

    ``payload`` : les champs bruts de l'ordre (``side``/``thesis``/
    ``stop_loss``/``qty``) — un dict, jamais le modèle Pydantic (ce module
    reste PUR au sens du dépôt : zéro dépendance FastAPI).
    ``portfolio`` : ``Portfolio.to_dict()`` — ``cash_chf``/``positions``/
    ``initial_capital``.
    ``level`` : le prix de référence de l'ordre, DÉJÀ CONVERTI EN CHF par
    l'appelant (même taux que le reste du trade — invariant du module, cf.
    tête de ``paper_router.py`` : un seul taux de change par opération).
    ``None`` -> ``risk_high``/``oversize`` ne peuvent pas être évalués et ne
    sortent jamais (mieux vaut ne rien confirmer que confirmer sur un chiffre
    inventé).
    """
    side = str((payload or {}).get("side") or "").strip().lower()
    if side not in ("buy", "short"):
        return []

    out: List[str] = []
    thesis = str((payload or {}).get("thesis") or "").strip()
    if len(thesis) < PREORDER_MIN_THESIS_LEN:
        out.append("no_thesis")

    stop_loss = _val((payload or {}).get("stop_loss"))
    if stop_loss is None:
        out.append("no_stop")

    qty = _val((payload or {}).get("qty")) or 0.0
    price = _val(level)

    if price is not None and stop_loss is not None and qty > 0:
        risk_chf = abs(price - stop_loss) * qty
        capital = _val((portfolio or {}).get("initial_capital"))
        if capital and capital > 0 and risk_chf > capital * PREORDER_RISK_PCT / 100.0:
            out.append("risk_high")

    if price is not None and qty > 0:
        symbol = str((payload or {}).get("symbol") or "").strip()
        wanted_side = "long" if side == "buy" else "short"
        rows = _dicts((portfolio or {}).get("positions"))
        held = sum(abs(_val(p.get("qty")) or 0.0) for p in rows
                  if str(p.get("symbol") or "") == symbol
                  and str(p.get("side") or "long") == wanted_side)
        projected = (held + qty) * price
        equity = (_val((portfolio or {}).get("cash_chf")) or 0.0) \
            + _positions_cost_basis_chf(rows)
        if equity > 0 and projected > equity * PREORDER_SIZE_PCT / 100.0:
            out.append("oversize")

    return out


def _positions_cost_basis_chf(positions: List[Dict[str, Any]]) -> float:
    """Valeur au PRIX DE REVIENT de TOUTES les lignes (long et short
    confondus, la marge du simulateur traite les deux comme du risque) — pas
    de réseau, même calcul que ``paper_router._positions_value_chf`` sommé
    sur les deux sens."""
    total = 0.0
    for pos in positions:
        qty = _val(pos.get("qty"))
        price = _val(pos.get("avg_price"))
        fx = _val(pos.get("fx_rate"))
        if qty is None or price is None:
            continue
        total += abs(qty) * price * (fx if fx and fx > 0 else 1.0)
    return total


# --------------------------------------------------------------------------- #
# Garde-fou fiscal suisse (circulaire AFC n°36)
# --------------------------------------------------------------------------- #
def afc_counters(trades: List[Dict[str, Any]],
                 positions: List[Dict[str, Any]],
                 initial_capital: Any,
                 now_iso: str) -> Dict[str, Any]:
    """Les 5 critères du statut d'investisseur privé, sur l'ANNÉE CIVILE de ``now_iso``.

    - ``volume_ratio`` : (achats + ventes de l'année) / capital initial. L'entrée
      d'un trade compte l'année où elle a eu lieu, la sortie l'année de la sortie ;
      les positions encore ouvertes comptent leur achat.
    - ``short_holdings`` : trades clôturés dans l'année et détenus moins de
      6 mois (183 jours). C'est le critère le plus vite franchi en swing trading.
    - ``uses_leverage`` / ``uses_derivatives`` : toujours ``False`` — le simulateur
      n'offre ni marge ni dérivés.
    - ``status`` : ``prive`` tant que le volume tient sous 5x le capital ET
      qu'aucune position n'a été détenue moins de 6 mois ; sinon ``a_risque``.

    Un horodatage illisible n'est jamais compté (mieux vaut sous-compter que
    d'inventer une transaction dans une année qui n'est pas la sienne).
    """
    now = _parse_iso(now_iso)
    year = now.year if now else None

    trade_rows = _dicts(trades)
    position_rows = _dicts(positions)

    volume = 0.0
    short_holdings = 0
    n_trades_year = 0

    for trade in trade_rows:
        qty = abs(_val(trade.get("qty")) or 0.0)
        fx = _val(trade.get("fx_rate"))
        if fx is None or fx <= 0:
            fx = 1.0
        entry_at = _parse_iso(trade.get("entry_at"))
        exit_at = _parse_iso(trade.get("exit_at"))

        if year is not None and entry_at is not None and entry_at.year == year:
            volume += qty * (_val(trade.get("entry_price")) or 0.0) * fx
        if year is not None and exit_at is not None and exit_at.year == year:
            volume += qty * (_val(trade.get("exit_price")) or 0.0) * fx
            n_trades_year += 1
            if entry_at is not None:
                held_days = (exit_at - entry_at).days
                if held_days < AFC_MIN_HOLDING_DAYS:
                    short_holdings += 1

    for pos in position_rows:
        opened_at = _parse_iso(pos.get("opened_at"))
        if year is None or opened_at is None or opened_at.year != year:
            continue
        qty = abs(_val(pos.get("qty")) or 0.0)
        fx = _val(pos.get("fx_rate"))
        if fx is None or fx <= 0:
            fx = 1.0
        volume += qty * (_val(pos.get("avg_price")) or 0.0) * fx

    capital = _val(initial_capital) or 0.0
    volume_ratio = round(volume / capital, 2) if capital > 0 else 0.0

    ok = volume_ratio <= AFC_VOLUME_LIMIT and short_holdings == 0
    return {
        "volume_ratio": volume_ratio,
        "volume_limit": AFC_VOLUME_LIMIT,
        "short_holdings": short_holdings,
        "n_trades_year": n_trades_year,
        "uses_leverage": False,
        "uses_derivatives": False,
        "status": "prive" if ok else "a_risque",
    }
