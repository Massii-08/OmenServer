"""Journal niveau pro (LOT 2) — PUR (aucun I/O, aucun réseau).

Quatre familles, toutes DÉRIVÉES à la lecture depuis les trades CLÔTURÉS —
rien n'est stocké en double (même doctrine que ``board.learning_summary`` :
« le tableau ne peut pas mentir », piège #59 du dépôt) :

- **B1** ``excursions``/``range_for`` : MAE/MFE (pire creux / meilleur sommet
  flottants pendant la détention), et la fenêtre de bougies qui les couvre ;
- **B5** ``best_exit_gap`` : ce qu'un trade a laissé sur la table ;
- **B2/B3** ``setup_breakdown``/``emotion_breakdown`` : performance groupée
  par étiquette (posée à l'entrée, cf. ``models.SETUPS``/``models.EMOTIONS``) ;
- **B4** ``discipline_score`` : 4 composantes équipondérées, honnête sous 5
  trades clos (``{"score": None}``, pas un chiffre inventé sur du vide).

Ce module importe ``risk`` (pur, sans dépendance) mais JAMAIS ``quotes`` ni
``paper_router`` : le réseau (``quotes.get_candles``) et le seuillage best-
effort restent la responsabilité de l'appelant (cf. ``paper_router.
_attach_trade_extras``) — un module qui calcule ne doit pas aussi décider
quoi faire d'un cours indisponible.
"""
from typing import Any, Dict, List, Optional, Tuple

from backend.bots.paper import models, risk

# --------------------------------------------------------------------------- #
# Helpers numériques (mêmes garanties que ``risk._val``/``models._as_float`` —
# dupliqué à dessein : un helper d'une poignée de lignes ne justifie pas un
# couplage supplémentaire entre modules purs).
# --------------------------------------------------------------------------- #
def _val(value: Any) -> Optional[float]:
    if value is None or isinstance(value, bool):
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _dicts(items: Any) -> List[Dict[str, Any]]:
    if not isinstance(items, list):
        return []
    return [item for item in items if isinstance(item, dict)]


# --------------------------------------------------------------------------- #
# B1 — MAE / MFE
# --------------------------------------------------------------------------- #
def excursions(candles: List[Dict[str, Any]], entry_price: Any,
               side: str) -> Dict[str, float]:
    """MAE/MFE en % de l'entrée, sur la période couverte par ``candles``.

    - ``mae_pct`` (Maximum Adverse Excursion) : pire creux flottant pendant la
      détention — TOUJOURS <= 0 (0 = jamais allé sous l'eau).
    - ``mfe_pct`` (Maximum Favorable Excursion) : meilleur sommet flottant —
      TOUJOURS >= 0.

    Long : le creux vient des ``low``, le sommet des ``high``. Short :
    l'inverse (une hausse est défavorable, une baisse favorable). Les deux
    bornes sont CLAMPÉES à leur signe : si la fenêtre de bougies ne couvre pas
    exactement l'instant d'entrée (imprécision de fenêtre Yahoo), un creux
    mesuré au-dessus de l'entrée ne doit jamais s'afficher comme un MAE
    positif — ce serait contredire le nom de la métrique.

    ``{}`` (jamais un ``0.0``) si les bougies sont vides ou l'entrée
    inconnue/non positive : un zéro prétendrait avoir mesuré quelque chose.
    """
    entry = _val(entry_price)
    if entry is None or entry <= 0 or not candles:
        return {}
    rows = [c for c in candles if isinstance(c, dict)]
    highs = [_val(c.get("high")) for c in rows]
    lows = [_val(c.get("low")) for c in rows]
    highs = [h for h in highs if h is not None]
    lows = [l for l in lows if l is not None]
    if not highs or not lows:
        return {}

    highest = max(highs)
    lowest = min(lows)
    side_key = str(side or "long").strip().lower()

    if side_key == "short":
        mae_raw = (entry - highest) / entry * 100.0
        mfe_raw = (entry - lowest) / entry * 100.0
    else:
        mae_raw = (lowest - entry) / entry * 100.0
        mfe_raw = (highest - entry) / entry * 100.0

    return {"mae_pct": round(min(mae_raw, 0.0), 2),
            "mfe_pct": round(max(mfe_raw, 0.0), 2)}


# Fenêtres FERMÉES pour la bougie d'excursion — MÊMES valeurs que
# ``paper_router.CANDLE_RANGES``/``CANDLE_INTERVALS`` (dupliquées ici : ce
# module reste pur et ne doit importer ni le router ni ``quotes``, qui
# parlent réseau — importer le router depuis ici créerait en plus un cycle,
# puisque c'est LUI qui importera ``tradestats``).
_RANGE_STEPS: Tuple[Tuple[float, str, str], ...] = (
    (1.0, "1d", "15m"),
    (5.0, "5d", "15m"),
    (30.0, "1mo", "1h"),
    (180.0, "6mo", "1d"),
    (365.0, "1y", "1d"),
)
_RANGE_FALLBACK = ("5y", "1wk")


def range_for(holding_days: Any) -> Tuple[str, str]:
    """La fenêtre ``(range, interval)`` qui couvre une détention de
    ``holding_days`` jours — pour interroger ``quotes.get_candles``.

    Choisit la fenêtre la plus ÉTROITE qui couvre toute la détention : plus
    fin pour un day-trade (15 min sur 1 jour), plus large pour un trade de
    plusieurs mois (bougies journalières sur 6 mois/1 an), jusqu'à 5 ans en
    hebdomadaire. Une durée manquante ou négative retombe sur la fenêtre la
    plus courte — mieux vaut une fenêtre trop étroite (qui peut rater un
    extrême plus ancien) qu'une combinaison choisie au hasard.
    """
    days = _val(holding_days)
    if days is None or days < 0:
        days = 0.0
    for limit, range_, interval in _RANGE_STEPS:
        if days <= limit:
            return range_, interval
    return _RANGE_FALLBACK


# --------------------------------------------------------------------------- #
# B5 — ce que le trade a laissé sur la table
# --------------------------------------------------------------------------- #
def best_exit_gap(mfe_pct: Any, realized_pct: Any) -> Optional[float]:
    """``mfe_pct - realized_pct`` : ce qu'un trade a laissé sur la table.

    ``realized_pct`` est le ``pnl_pct`` du trade (déjà net de frais). Peut être
    NÉGATIF (l'exit a fait mieux que la fenêtre de bougies relue, cf. les gaps
    d'ouverture) — un signal honnête, pas une erreur. ``None`` si l'un des
    deux manque : un trade sans excursion calculable ne doit pas afficher un
    « laissé » inventé.
    """
    mfe = _val(mfe_pct)
    realized = _val(realized_pct)
    if mfe is None or realized is None:
        return None
    return round(mfe - realized, 2)


# --------------------------------------------------------------------------- #
# B2/B3 — stats dérivées par étiquette (setup / émotion)
# --------------------------------------------------------------------------- #
UNTAGGED = "untagged"


def _bucket_key(value: Any, whitelist: Tuple[str, ...]) -> str:
    """Clé de regroupement : la valeur si elle est dans la whitelist FERMÉE,
    sinon ``UNTAGGED`` — qu'elle soit absente, vide, ou une valeur historique
    qui n'existe plus (jamais une clé fantôme dans la réponse)."""
    text = str(value or "").strip()
    return text if text in whitelist else UNTAGGED


def _bucket_stats(rows: List[Dict[str, Any]]) -> Dict[str, Any]:
    """``{n, winrate, avg_r}`` d'un groupe de trades — jamais vide (appelé
    seulement sur des listes non vides, une clé n'existe que si >= 1 trade)."""
    n = len(rows)
    wins = sum(1 for t in rows if (_val(t.get("pnl_chf")) or 0.0) > 0)
    r_values = [v for v in (_val(t.get("r_multiple")) for t in rows) if v is not None]
    avg_r = round(sum(r_values) / len(r_values), 2) if r_values else None
    return {"n": n, "winrate": round(wins / n * 100.0, 1), "avg_r": avg_r}


def setup_breakdown(trades: Any) -> List[Dict[str, Any]]:
    """Performance PAR SETUP (B2) — ``{setup, n, winrate, avg_r, total_pnl_chf}``,
    triée par nombre de trades décroissant (le plus représenté d'abord),
    départagée par nom. Les trades sans setup (ou un setup qui n'existe plus)
    sont regroupés sous ``"untagged"``."""
    buckets: Dict[str, List[Dict[str, Any]]] = {}
    for trade in _dicts(trades):
        key = _bucket_key(trade.get("setup"), models.SETUPS)
        buckets.setdefault(key, []).append(trade)

    rows = []
    for key, rows_in_bucket in buckets.items():
        stats = _bucket_stats(rows_in_bucket)
        stats["setup"] = key
        stats["total_pnl_chf"] = round(
            sum((_val(t.get("pnl_chf")) or 0.0) for t in rows_in_bucket), 2)
        rows.append(stats)
    rows.sort(key=lambda r: (-r["n"], r["setup"]))
    return rows


def emotion_breakdown(trades: Any) -> List[Dict[str, Any]]:
    """Performance PAR ÉMOTION D'ENTRÉE (B3) — ``{emotion, n, winrate, avg_r}``.

    Regroupe sur ``emotion`` (posée à l'ouverture), PAS ``emotion_close`` : un
    fill mécanique (stop, limite, tick) n'a jamais d'émotion de clôture — ce
    serait vider la moitié des trades de toute donnée exploitable — alors que
    l'émotion d'entrée est là dès qu'on l'a taguée à l'ordre, quelle que soit
    la façon dont le trade s'est refermé. Pas de ``total_pnl_chf`` (à la
    différence de B2) : la mission ne le demande pas pour cet axe."""
    buckets: Dict[str, List[Dict[str, Any]]] = {}
    for trade in _dicts(trades):
        key = _bucket_key(trade.get("emotion"), models.EMOTIONS)
        buckets.setdefault(key, []).append(trade)

    rows = []
    for key, rows_in_bucket in buckets.items():
        stats = _bucket_stats(rows_in_bucket)
        stats["emotion"] = key
        rows.append(stats)
    rows.sort(key=lambda r: (-r["n"], r["emotion"]))
    return rows


# --------------------------------------------------------------------------- #
# B4 — score de discipline
# --------------------------------------------------------------------------- #
MIN_TRADES_FOR_SCORE = 5

# Même seuil que ``paper_router.OVERSIZED_PCT`` — dupliqué ici pour la même
# raison que les fenêtres de bougies (rester pur, éviter le cycle d'import).
RISK_LIMIT_PCT = 2.0

# Un profit factor de 2 (deux francs gagnés pour un perdu) vaut les 25 points
# pleins ; en dessous, la note est LINÉAIRE jusqu'à 0 -> 0 point.
PROFIT_FACTOR_TARGET = 2.0

_POINTS_PER_COMPONENT = 25.0


def _trade_risk_chf(trade: Dict[str, Any]) -> Optional[float]:
    """Risque planifié du trade, recalculé depuis ce qu'il porte (entrée,
    stop planifié, quantité, taux de change) — mirroir de ``paper_router.
    planned_risk_chf`` SANS l'importer (ce module resterait pur et sans
    dépendance circulaire vers le router, qui importera ``tradestats``).
    ``None`` si un des ingrédients manque : le risque est alors INCONNU, pas
    nul."""
    entry = _val(trade.get("entry_price"))
    stop = _val(trade.get("planned_stop"))
    qty = _val(trade.get("qty"))
    if entry is None or stop is None or qty is None:
        return None
    fx = _val(trade.get("fx_rate"))
    if fx is None or fx <= 0:
        fx = 1.0
    return abs(entry - stop) * abs(qty) * fx


def discipline_score(trades: Any, initial_capital: Any) -> Dict[str, Any]:
    """Score de discipline 0-100 (B4), 4 composantes équipondérées (25 pts
    chacune) sur les trades CLÔTURÉS :

    1. **stop_set** — part des trades avec un stop planifié.
    2. **thesis_written** — part des trades avec une thèse non vide.
    3. **risk_respected** — part des trades dont le risque planifié (recalculé
       depuis entrée/stop/quantité) tient sous 2 % du capital initial. Un
       trade SANS stop compte automatiquement comme risque non tenu : sans
       niveau d'invalidation, le risque n'est pas petit, il est inconnu, et
       ne peut donc pas être compté comme « tenu ».
    4. **profit_factor** — 0 point à profit factor 0, 25 points à partir de 2,
       linéaire entre les deux. Si aucune perte n'a été enregistrée (aucun
       trade perdant, y compris zéro trade perdant sur des gains OU des
       break-even), ``risk.portfolio_stats`` rend ``None`` (ratio infini) :
       25 points PLEINS sur cet axe, puisqu'aucune perte n'est restée sans
       filet.

    ``<5`` trades clos -> ``{"score": None}`` : pas de note sur du vide, c'est
    plus honnête qu'un chiffre qui donnerait une fausse impression de
    précision sur 1, 2 ou 3 trades.
    """
    rows = _dicts(trades)
    n = len(rows)
    if n < MIN_TRADES_FOR_SCORE:
        return {"score": None}

    capital = _val(initial_capital) or 0.0

    n_stop = sum(1 for t in rows if t.get("planned_stop") is not None)
    n_thesis = sum(1 for t in rows if str(t.get("thesis") or "").strip())
    n_risk_ok = 0
    for t in rows:
        if t.get("planned_stop") is None:
            continue
        trade_risk = _trade_risk_chf(t)
        if trade_risk is not None and capital > 0 \
                and trade_risk <= capital * RISK_LIMIT_PCT / 100.0:
            n_risk_ok += 1

    stats = risk.portfolio_stats(rows)
    pf = stats.get("profit_factor")
    if pf is None:
        pf_points = _POINTS_PER_COMPONENT
    else:
        ratio = min(max(pf, 0.0), PROFIT_FACTOR_TARGET) / PROFIT_FACTOR_TARGET
        pf_points = round(_POINTS_PER_COMPONENT * ratio, 1)

    stop_points = round(n_stop / n * _POINTS_PER_COMPONENT, 1)
    thesis_points = round(n_thesis / n * _POINTS_PER_COMPONENT, 1)
    risk_points = round(n_risk_ok / n * _POINTS_PER_COMPONENT, 1)

    total = stop_points + thesis_points + risk_points + pf_points
    return {
        "score": int(round(total)),
        "components": {
            "stop_set": {"pct": round(n_stop / n * 100.0, 1), "points": stop_points},
            "thesis_written": {"pct": round(n_thesis / n * 100.0, 1),
                               "points": thesis_points},
            "risk_respected": {"pct": round(n_risk_ok / n * 100.0, 1),
                               "points": risk_points},
            "profit_factor": {"value": pf, "points": pf_points},
        },
    }
