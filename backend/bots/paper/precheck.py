"""Pré-check d'un ordre HYPOTHÉTIQUE — PUR (aucun I/O, aucun réseau, zéro LLM).

Spec : ``docs/superpowers/specs/2026-09-09-tv-coach-extension-design.md`` §5.2
(le contrat), §6.3 (les neuf garde-fous du mode scalp).

Ce que ce module fait : on lui décrit un ticket (« j'achèterais AAPL à 100,
stop 98, cible 110, 1 % de risque ») et il rend la taille, le risque, les
frais aller-retour, le R et **tout ce qui cloche** — sans jamais rien bloquer.
« Le ticket affiche, l'humain décide » (§5.2) : ``warnings`` et ``refusals``
sont deux listes d'INFORMATIONS, pas deux portes.

Ce que ce module ne fait PAS : réinventer une formule d'argent. Chaque règle
déjà écrite ailleurs est APPELÉE, pas recopiée —

* la taille vient de :func:`risk.suggested_qty` (troncature vers le bas
  comprise, y compris pour les fractions de crypto, cf. :func:`_qty`) ;
* le R vient de :func:`risk.r_multiple` (signé, ``None`` si le stop est du
  mauvais côté) ;
* les avertissements pré-ordre viennent de :func:`risk.preorder_warnings` ;
* les frais viennent de :mod:`fees` (``compute_fees``/``round_trip_pct``) ;
* ``fee_ratio``/``stop_in_noise``/``concentration``/``cash_floor`` rejouent
  les contrôles de :func:`coach_trader.gate_decision` en appelant SES helpers
  (``_round_trip_pct``, ``_stop_in_noise``, ``_equity_chf``) et SES seuils ;
* les biais de l'historique viennent de :func:`coach.detect_biases`.

Seuls les NEUF garde-fous scalp (§6.3) sont écrits ici : ils n'existaient nulle
part avant ce lot. Leurs seuils vivent dans :data:`SCALP_THRESHOLDS`, qu'un
appelant peut surcharger clé par clé (les options de l'extension).

⚠️ Devises : comme :func:`risk.preorder_warnings` et
:func:`coach_trader.gate_decision`, ce module travaille dans UNE seule unité
monétaire, celle que l'appelant lui donne. Il ne va jamais chercher un taux de
change : c'est au routeur de convertir avant, avec un seul taux pour toute
l'opération.
"""
from typing import Any, Dict, List, Optional

from backend.bots.paper import coach, coach_trader, fees, models, quotes, risk

# --------------------------------------------------------------------------- #
# Constantes
# --------------------------------------------------------------------------- #

# Risque par défaut d'un ticket qui n'en précise pas — même valeur que le
# ``defaults.risk_pct`` de la fiche (§5.1). C'est un DÉFAUT D'AFFICHAGE, pas
# une politique : l'extension le repropose, l'utilisateur le change.
DEFAULT_RISK_PCT = 1.0

# Les familles d'actifs qui se traitent en FRACTION (on n'achète pas « une
# action » de bitcoin). Quatre décimales : le pas des plateformes crypto, et
# assez fin pour un ticket de quelques centaines de francs.
#
# ⚠️ Ce sont les familles de ``quotes.kind_from_symbol`` (crypto/forex/equity),
# PAS les cinq de ``brief.kind_of`` (qui sert le champ ``kind`` du contrat).
# Les deux vocabulaires s'accordent sur ``crypto`` et ``forex``, les seuls qui
# comptent ici ; un future (``BTC=F``) est « equity » pour l'un et
# « commodity » pour l'autre, et il se traite bien en contrats ENTIERS.
FRACTIONAL_KINDS = ("crypto", "forex")
QTY_DECIMALS = 4
QTY_SCALE = 10 ** QTY_DECIMALS

# MIROIRS DOCUMENTÉS de ``coach_trader.gate_decision`` — les seuils y sont des
# littéraux dans le corps de la fonction, pas des constantes exportables. Le
# dépôt assume déjà ce patron (cf. ``risk.PREORDER_MIN_THESIS_LEN``, miroir de
# ``coach._NO_THESIS_MIN_LEN``) : un miroir NOMMÉ et testé pour équivalence
# vaut mieux qu'un import impossible. Les tests
# ``test_equivalence_fee_ratio_avec_la_porte_du_coach`` et son jumeau
# ``stop_in_noise`` figent l'égalité avec la vraie porte.
FEE_RATIO_MULT = 3.0

# Ticket de RÉFÉRENCE pour chiffrer un aller-retour quand la quantité n'est pas
# calculable (ticket sans stop) : 10 % de l'équité, exactement le plancher
# ``coach_trader.MIN_POSITION_PCT`` en dessous duquel une ligne « n'est pas
# des actions en centimes ». Sans lui, ``fee_coverage`` n'aurait aucun chiffre.
REFERENCE_TICKET_PCT = coach_trader.MIN_POSITION_PCT

LEVEL_AMBER = "amber"
LEVEL_RED = "red"

# Les neuf codes de §6.3, dans l'ordre du tableau de la spec.
SCALP_CODES = ("event_risk", "funding_soon", "flash_news", "vol_spike",
               "spread_wide", "fee_coverage", "cooldown", "pace", "daily_loss")

# Seuils par défaut des neuf garde-fous (§6.3). SURCHARGEABLES clé par clé via
# l'argument ``thresholds`` — le dict de module n'est JAMAIS muté.
SCALP_THRESHOLDS: Dict[str, float] = {
    "event_risk_before_min": 15.0,   # événement macro à venir dans < 15 min
    "event_risk_after_min": 5.0,     # ou passé depuis moins de 5 min
    "funding_soon_min": 5.0,         # règlement du funding dans < 5 min
    "flash_news_min": 2.0,           # dépêche publiée il y a < 2 min
    "vol_spike_mult": 2.0,           # ATR 1 min > 2 x sa médiane 4 h
    "spread_wide_mult": 2.0,         # spread > 2 x sa médiane de séance
    "fee_coverage_mult": 3.0,        # mouvement attendu < 3 x frais A/R
    "cooldown_min": 10.0,            # dernier scalp PERDANT il y a < 10 min
    "pace_per_hour": 6.0,            # plus de 6 scalps dans l'heure
    "daily_loss_pct": -2.0,          # P&L du jour <= -2 % de l'équité
}

# Textes (français, sobres — même doctrine que ``price_alerts``: un fait, pas
# un emoji). ``%s``/``%.2f`` remplis à l'émission.
_TEXTS = {
    "no_thesis": "Aucune thèse écrite (ou trop courte).",
    "no_stop": "Aucun stop : la perte n'a pas de plancher.",
    "risk_high": "Risque planifié au-delà de %.1f %% du capital." % risk.PREORDER_RISK_PCT,
    "reward_risk_below_1": "La cible rapporte moins que le stop ne risque.",
    "oversize": "Ligne projetée au-delà de %.0f %% de l'équité." % risk.PREORDER_SIZE_PCT,
    "fee_ratio": ("L'objectif ne rapporte pas %.0f x le coût d'un aller-retour "
                  "(%.2f %%)."),
    "stop_in_noise": ("Stop à %.2f %% du cours : sous le bruit ordinaire du "
                      "titre (plancher %.2f %%)."),
    "concentration": "Ligne projetée au-delà de %.0f %% de l'équité (plafond du coach).",
    "cash_floor": "Trésorerie restante sous le plancher de %.0f %% de l'équité.",
    "event_risk": "Événement macro à haute importance : %s.",
    "funding_soon": "Règlement du funding dans %.0f min.",
    "flash_news": "Dépêche publiée il y a moins de %.0f min.",
    "vol_spike": "Volatilité 1 min à %.1f x sa médiane.",
    "spread_wide": "Spread à %.1f x sa médiane de séance.",
    "fee_coverage": ("Ce scalp doit gagner %.2f %% pour payer le courtier "
                     "(mouvement attendu %.2f %%)."),
    "cooldown": "Dernier scalp perdant il y a %.0f min.",
    "pace": "%d scalps dans la dernière heure.",
    "daily_loss": "P&L du jour à %.1f %% de l'équité — stop pour aujourd'hui.",
}


# --------------------------------------------------------------------------- #
# Petits outils (tolérants : rien de ce qui arrive du réseau n'est de confiance)
# --------------------------------------------------------------------------- #
def _val(value: Any) -> Optional[float]:
    """Nombre lisible, ou ``None`` — jamais une exception."""
    if isinstance(value, bool) or value is None:
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _rows(value: Any) -> List[Dict[str, Any]]:
    """Les dicts d'une liste. Tout le reste (chaîne, dict nu, entier) -> []."""
    if not isinstance(value, (list, tuple)):
        return []
    return [row for row in value if isinstance(row, dict)]


def _minutes_between(later: Any, earlier: Any) -> Optional[float]:
    """Minutes écoulées de ``earlier`` à ``later`` (négatif = ``earlier`` est
    dans le futur). Réutilise ``coach_trader._aware_utc`` : un horodatage naïf
    y est lu comme de l'UTC, ce qui est exactement la convention des champs
    ``time_utc``/``next_funding_utc`` de ce lot."""
    try:
        a = coach_trader._aware_utc(later)
        b = coach_trader._aware_utc(earlier)
    except Exception:                       # noqa: BLE001 — entrée illisible
        return None
    return (a - b).total_seconds() / 60.0


def _threshold(overrides: Any, key: str) -> float:
    """Seuil courant : la surcharge de l'appelant, sinon le défaut."""
    if isinstance(overrides, dict):
        value = _val(overrides.get(key))
        if value is not None:
            return value
    return SCALP_THRESHOLDS[key]


def _warn(out: List[Dict[str, Any]], code: str, level: str, text: str) -> None:
    """Ajoute un avertissement, SANS doublon de code.

    Un même code émis deux fois (une fois pour le ticket, une fois pour
    l'historique — ``no_stop`` par exemple) afficherait deux bandeaux qui se
    contredisent presque. Le PREMIER gagne : les règles du ticket courant sont
    évaluées avant les biais du passé, et c'est le ticket qu'on est en train
    d'écrire.
    """
    for row in out:
        if row["code"] == code:
            return
    out.append({"code": code, "level": level, "text": text})


# --------------------------------------------------------------------------- #
# Quantité et équité
# --------------------------------------------------------------------------- #
def _equity_chf(portfolio: Any) -> float:
    """Équité BRUTE du portefeuille — ``risk.exposure`` sans cours du jour
    (chaque ligne retombe alors sur son prix de revient, cf. sa docstring).
    Zéro si le portefeuille est illisible."""
    if not isinstance(portfolio, dict):
        return 0.0
    try:
        view = risk.exposure(portfolio.get("positions") or [], {},
                             portfolio.get("cash_chf"))
    except Exception:                       # noqa: BLE001 — portefeuille tordu
        return 0.0
    return _val(view.get("total_chf")) or 0.0


def _qty(kind: str, equity: float, risk_pct: Optional[float],
         price: Optional[float], stop: Optional[float]) -> Optional[float]:
    """Taille du ticket, ``None`` si elle n'est pas calculable.

    Actions : :func:`risk.suggested_qty` tel quel (un ENTIER tronqué vers le
    bas). Crypto et forex : le MÊME appel, sur un capital multiplié par
    ``QTY_SCALE`` puis divisé d'autant — la troncature de ``suggested_qty``
    devient alors une troncature à la quatrième décimale, et il n'y a toujours
    qu'UNE implémentation de « combien puis-je acheter sans dépasser mon
    risque » dans ce dépôt.
    """
    if price is None or stop is None or risk_pct is None:
        return None
    if kind in FRACTIONAL_KINDS:
        scaled = risk.suggested_qty(equity * QTY_SCALE, risk_pct, price, stop)
        return scaled / float(QTY_SCALE)
    return risk.suggested_qty(equity, risk_pct, price, stop)


# --------------------------------------------------------------------------- #
# Les neuf garde-fous du mode scalp (§6.3)
# --------------------------------------------------------------------------- #
def _is_high_importance(entry: Dict[str, Any]) -> bool:
    """Un rendez-vous « haute importance » au sens de TradingView
    (``importance == 1``, cf. spec §4.2). Une entrée qui ne le dit pas n'est
    PAS présumée haute : on ne bloque pas un scalp sur un stock de gaz."""
    value = entry.get("importance")
    if isinstance(value, str):
        return value.strip().lower() in ("1", "high", "haute")
    return _val(value) == 1.0


def _scalp_guards(out: List[Dict[str, Any]], *, now: Any, price: Optional[float],
                  round_trip: float, expected_move_pct: Optional[float],
                  equity: float, atr1_m: Optional[float],
                  atr1_m_median: Optional[float], spread_pct: Optional[float],
                  spread_median_pct: Optional[float], calendar: Any, news: Any,
                  btc: Any, scalps_today: Any, thresholds: Any) -> None:
    """Les neuf règles de §6.3, dans l'ordre du tableau. Chacune est MUETTE
    quand sa matière manque : un garde-fou qui n'a pas ses données ne doit pas
    inventer une alerte (ni la taire au point de mentir — il ne dit rien)."""

    # 1. event_risk — rouge.
    before = _threshold(thresholds, "event_risk_before_min")
    after = _threshold(thresholds, "event_risk_after_min")
    for entry in _rows(calendar):
        if not _is_high_importance(entry):
            continue
        date = str(entry.get("date") or "").strip()
        time_utc = str(entry.get("time_utc") or "").strip()
        if not date or not time_utc:
            continue                        # sans heure, rien à comparer
        delta = _minutes_between("%sT%s:00" % (date, time_utc[:5]), now)
        if delta is None:
            continue
        if -after <= delta <= before:
            _warn(out, "event_risk", LEVEL_RED,
                  _TEXTS["event_risk"] % (entry.get("label") or "sans nom"))
            break

    # 2. funding_soon — ambre.
    if isinstance(btc, dict):
        # Minutes qui RESTENT avant le règlement (négatif = déjà passé).
        delta = _minutes_between(btc.get("next_funding_utc"), now)
        if delta is not None:
            if 0.0 <= delta < _threshold(thresholds, "funding_soon_min"):
                _warn(out, "funding_soon", LEVEL_AMBER,
                      _TEXTS["funding_soon"] % delta)

    # 3. flash_news — ambre.
    fresh = _threshold(thresholds, "flash_news_min")
    for item in _rows(news):
        age = _minutes_between(now, item.get("ts"))
        # Borne basse à -1 min : une dépêche horodatée une poignée de secondes
        # dans le futur (décalage d'horloge entre l'Omen et la source) est
        # évidemment fraîche ; au-delà, c'est une date illisible, on l'ignore.
        if age is not None and -1.0 < age < fresh:
            _warn(out, "flash_news", LEVEL_AMBER, _TEXTS["flash_news"] % fresh)
            break

    # 4. vol_spike — ambre.
    median = _val(atr1_m_median)
    if atr1_m is not None and median is not None and median > 0:
        ratio = atr1_m / median
        if ratio > _threshold(thresholds, "vol_spike_mult"):
            _warn(out, "vol_spike", LEVEL_AMBER, _TEXTS["vol_spike"] % ratio)

    # 5. spread_wide — ambre.
    spread = _val(spread_pct)
    spread_median = _val(spread_median_pct)
    if spread is not None and spread_median is not None and spread_median > 0:
        ratio = spread / spread_median
        if ratio > _threshold(thresholds, "spread_wide_mult"):
            _warn(out, "spread_wide", LEVEL_AMBER, _TEXTS["spread_wide"] % ratio)

    # 6. fee_coverage — rouge. « Ce scalp doit gagner X % pour payer le
    #    courtier » : X est le SEUIL DE RENTABILITÉ (l'aller-retour), et la
    #    règle se déclenche tant que le mouvement attendu n'en couvre pas
    #    ``fee_coverage_mult`` fois (même exigence que ``fee_ratio``).
    if expected_move_pct is not None and round_trip > 0:
        if expected_move_pct < _threshold(thresholds, "fee_coverage_mult") * round_trip:
            _warn(out, "fee_coverage", LEVEL_RED,
                  _TEXTS["fee_coverage"] % (round_trip, expected_move_pct))

    # 7/8/9 — la discipline de la SÉANCE, lue dans les scalps du jour.
    scalps = _rows(scalps_today)
    cooldown = _threshold(thresholds, "cooldown_min")
    for row in scalps:
        pnl = _val(row.get("pnl_chf"))
        if pnl is None or pnl >= 0:
            continue
        age = _minutes_between(now, row.get("closed_ts"))
        if age is not None and 0.0 <= age < cooldown:
            _warn(out, "cooldown", LEVEL_AMBER, _TEXTS["cooldown"] % age)
            break

    recent = 0
    for row in scalps:
        age = _minutes_between(now, row.get("closed_ts"))
        if age is not None and 0.0 <= age <= 60.0:
            recent += 1
    if recent > _threshold(thresholds, "pace_per_hour"):
        _warn(out, "pace", LEVEL_AMBER, _TEXTS["pace"] % recent)

    if equity > 0:
        realized = sum(_val(row.get("pnl_chf")) or 0.0 for row in scalps)
        day_pct = realized / equity * 100.0
        if day_pct <= _threshold(thresholds, "daily_loss_pct"):
            _warn(out, "daily_loss", LEVEL_RED, _TEXTS["daily_loss"] % day_pct)


# --------------------------------------------------------------------------- #
# Les quatre refus du coach, rejoués sur un ticket hypothétique
# --------------------------------------------------------------------------- #
def _refusals(symbol: str, side: str, price: Optional[float],
              stop: Optional[float], target: Optional[float],
              qty: Optional[float], portfolio: Any, equity: float,
              round_trip: float, atr14_d: Optional[float]) -> List[Dict[str, Any]]:
    """Ce que ``coach_trader.gate_decision`` REFUSERAIT de ce ticket.

    **Informatif** (§1.3) : le coach s'interdit ces ordres, l'humain non. On
    n'appelle pas ``gate_decision`` directement parce qu'elle s'arrête au
    PREMIER refus (elle rend un ``reason``, pas une liste) et parce qu'elle
    juge aussi des choses qui n'ont pas de sens pour un ticket d'écran (thèse,
    heure d'ouverture du marché, nombre de fronts). Les quatre règles qui, elles,
    ont du sens sont rejouées avec LES HELPERS ET LES SEUILS DU COACH.
    """
    out: List[Dict[str, Any]] = []
    if price is None or price <= 0:
        return out

    # fee_ratio — miroir de la porte (cf. FEE_RATIO_MULT).
    if target is not None and target > 0:
        if abs(target - price) / price * 100.0 < FEE_RATIO_MULT * round_trip:
            out.append({"code": "fee_ratio",
                        "text": _TEXTS["fee_ratio"] % (FEE_RATIO_MULT, round_trip)})

    # stop_in_noise — la FONCTION du coach, pas une copie. Un stop INITIAL n'a
    # verrouillé aucun gain : le quatrième argument est 0, comme dans la porte.
    if stop is not None:
        atr_pct = None
        if atr14_d is not None and price > 0:
            atr_pct = atr14_d / price * 100.0
        distance_pct = abs(price - stop) / price * 100.0
        if coach_trader._stop_in_noise(distance_pct, round_trip, atr_pct, 0.0):
            floor = coach_trader._noise_floor_pct(round_trip, atr_pct)
            out.append({"code": "stop_in_noise",
                        "text": _TEXTS["stop_in_noise"] % (distance_pct, floor)})

    if qty is None or qty <= 0 or equity <= 0:
        return out

    value = qty * price
    wanted = "short" if side == "sell" else "long"

    # concentration — plafond de ligne PROJETÉE du coach (MAX_POSITION_PCT).
    held = 0.0
    if isinstance(portfolio, dict):
        for position in _rows(portfolio.get("positions")):
            if str(position.get("symbol") or "").strip().upper() != symbol:
                continue
            if str(position.get("side") or "long") != wanted:
                continue
            held += abs(_val(position.get("qty")) or 0.0)
    if (held + qty) * price > equity * coach_trader.MAX_POSITION_PCT / 100.0:
        out.append({"code": "concentration",
                    "text": _TEXTS["concentration"] % coach_trader.MAX_POSITION_PCT})

    # cash_floor — une VENTE À DÉCOUVERT n'achète rien et ne peut pas mettre le
    # compte à sec : même exception que la porte du coach.
    if wanted == "long" and isinstance(portfolio, dict):
        cash = _val(portfolio.get("cash_chf")) or 0.0
        if cash - value < equity * coach_trader.MIN_CASH_PCT / 100.0:
            out.append({"code": "cash_floor",
                        "text": _TEXTS["cash_floor"] % coach_trader.MIN_CASH_PCT})

    return out


# --------------------------------------------------------------------------- #
# API publique
# --------------------------------------------------------------------------- #
def evaluate(order: Any, *, portfolio: Any = None, trades: Any = None,
             fees_profile: Any = None, custom_pct: Any = None,
             commission_chf: Any = None, atr1_m: Any = None,
             atr14_d: Any = None, atr1_m_median: Any = None,
             spread_pct: Any = None, spread_median_pct: Any = None,
             calendar: Any = None, news: Any = None, btc: Any = None,
             scalps_today: Any = None, thresholds: Any = None,
             now: Any = None) -> Dict[str, Any]:
    """Le ticket chiffré et commenté d'un ordre qui n'existe pas encore.

    ``order`` : ``{symbol, side: "buy"|"sell", price, stop, target,
    risk_pct?, qty?, mode: "swing"|"scalp"}`` (+ ``thesis`` facultative).
    Tout peut manquer ou être n'importe quoi — c'est le travail de cette
    fonction, qui ne lève JAMAIS.

    Rend ``{qty, risk_pct, risk_chf, fees_chf, fees_pct_round_trip,
    r_multiple, expected_move_pct, warnings, refusals}`` (§1.3). Un chiffre
    qu'on ne peut pas calculer vaut ``None`` — jamais 0, qui se lirait comme
    une mesure.

    ``qty`` prime sur ``risk_pct`` quand les deux sont fournis (l'utilisateur
    a saisi une taille à la main : on ne la corrige pas, on lui dit ce qu'elle
    risque). Sans ``qty``, la taille vient de ``risk_pct`` (défaut
    :data:`DEFAULT_RISK_PCT`).

    Les sources du mode scalp (``calendar``, ``news``, ``btc``,
    ``scalps_today``, ``atr1_m``…) sont toutes OPTIONNELLES et toutes
    tolérantes : une source absente rend son garde-fou muet, une source
    illisible aussi.
    """
    order = order if isinstance(order, dict) else {}

    symbol = quotes.canonical(order.get("symbol"))
    kind = quotes.kind_from_symbol(symbol) if symbol else ""
    side = str(order.get("side") or "").strip().lower()
    mode = "scalp" if str(order.get("mode") or "").strip().lower() == "scalp" \
        else "swing"

    price = _val(order.get("price"))
    stop = _val(order.get("stop"))
    target = _val(order.get("target"))
    atr1_m = _val(atr1_m)
    atr14_d = _val(atr14_d)

    equity = _equity_chf(portfolio)

    # --- taille, risque -------------------------------------------------- #
    given_qty = _val(order.get("qty"))
    asked_pct = _val(order.get("risk_pct"))
    if given_qty is not None and given_qty > 0:
        qty = given_qty
        if kind not in FRACTIONAL_KINDS and float(qty).is_integer():
            qty = int(qty)
    else:
        qty = _qty(kind, equity, asked_pct if asked_pct is not None
                   else DEFAULT_RISK_PCT, price, stop)
        if qty is not None and qty <= 0:
            qty = qty if stop is not None else None

    risk_chf = None
    if qty is not None and price is not None and stop is not None:
        risk_chf = round(abs(price - stop) * qty, 2)

    risk_pct = asked_pct
    if given_qty is not None and given_qty > 0:
        # Une taille imposée REDÉFINIT le risque : on affiche celui qu'elle
        # prend vraiment, pas celui que l'utilisateur avait tapé avant.
        risk_pct = round(risk_chf / equity * 100.0, 4) \
            if (risk_chf is not None and equity > 0) else None
    elif risk_pct is None:
        risk_pct = DEFAULT_RISK_PCT

    # --- frais ------------------------------------------------------------ #
    profile = str(fees_profile or "").strip().lower()
    if not profile and isinstance(portfolio, dict):
        profile = str(portfolio.get("fee_profile") or "").strip().lower()
    if profile not in fees.FEE_PROFILES:
        profile = models.DEFAULT_FEE_PROFILE

    notional = qty * price if (qty is not None and price is not None) else None
    # Sans quantité (ticket sans stop), l'aller-retour se chiffre sur un ticket
    # de RÉFÉRENCE plutôt que sur rien : un pourcentage doit rester lisible
    # même quand la taille ne l'est pas encore.
    reference = notional if notional else equity * REFERENCE_TICKET_PCT / 100.0
    try:
        round_trip = fees.round_trip_pct(profile, reference, symbol, custom_pct,
                                         commission_chf)
    except (ValueError, TypeError):         # profil corrompu -> pas de chiffre
        round_trip = 0.0
    fees_chf = None
    if notional:
        try:
            leg = fees.compute_fees(profile, notional, symbol, custom_pct,
                                    commission_chf)
            fees_chf = round(leg["total_chf"] * 2.0, 2)
        except (ValueError, TypeError):
            fees_chf = None

    # --- R et mouvement attendu ------------------------------------------- #
    r_multiple = risk.r_multiple(price, target, stop,
                                 "short" if side == "sell" else "long")

    expected_move_pct = None
    if price and price > 0:
        if mode == "scalp":
            if atr1_m is not None:
                expected_move_pct = round(atr1_m * 3.0 / price * 100.0, 4)
        elif atr14_d is not None:
            expected_move_pct = round(atr14_d / price * 100.0, 4)

    # --- avertissements ---------------------------------------------------- #
    warnings: List[Dict[str, Any]] = []

    payload = {"side": "short" if side == "sell" else side,
               "symbol": symbol, "stop_loss": stop, "target": target,
               "qty": qty or 0, "thesis": order.get("thesis") or ""}
    try:
        codes = risk.preorder_warnings(payload,
                                       portfolio if isinstance(portfolio, dict) else {},
                                       price)
    except Exception:                       # noqa: BLE001 — jamais un 500 ici
        codes = []
    for code in codes:
        # ``no_thesis`` n'a de sens que si l'appelant a VOULU parler de thèse :
        # le pré-check est une calculette de taille, la thèse est demandée à
        # l'ordre. Sans ce filtre, chaque ticket naîtrait fautif.
        if code == "no_thesis" and "thesis" not in order:
            continue
        _warn(warnings, code, LEVEL_AMBER, _TEXTS.get(code, code))

    if mode == "scalp":
        _scalp_guards(warnings, now=now, price=price, round_trip=round_trip,
                      expected_move_pct=expected_move_pct, equity=equity,
                      atr1_m=atr1_m, atr1_m_median=atr1_m_median,
                      spread_pct=spread_pct, spread_median_pct=spread_median_pct,
                      calendar=calendar, news=news, btc=btc,
                      scalps_today=scalps_today, thresholds=thresholds)

    # Les biais de l'HISTORIQUE (``coach.detect_biases``) en dernier : ils
    # parlent du passé, le ticket parle du présent, et ``_warn`` garde le
    # premier code émis.
    rows = _rows(trades)
    if rows:
        orders = _rows((portfolio or {}).get("orders")) \
            if isinstance(portfolio, dict) else []
        capital = _val((portfolio or {}).get("initial_capital")) \
            if isinstance(portfolio, dict) else None
        try:
            biases = coach.detect_biases(rows, orders, capital or 0.0)
        except Exception:                   # noqa: BLE001 — historique tordu
            biases = []
        for bias in biases:
            if not isinstance(bias, dict) or not bias.get("code"):
                continue
            evidence = bias.get("evidence")
            if isinstance(evidence, (list, tuple)):
                evidence = " ".join(str(part) for part in evidence)
            level = LEVEL_RED if bias.get("severity") == "critical" else LEVEL_AMBER
            _warn(warnings, str(bias["code"]), level,
                  str(evidence or bias["code"]))

    return {
        "qty": qty,
        "risk_pct": risk_pct,
        "risk_chf": risk_chf,
        "fees_chf": fees_chf,
        "fees_pct_round_trip": round_trip,
        "r_multiple": r_multiple,
        "expected_move_pct": expected_move_pct,
        "warnings": warnings,
        "refusals": _refusals(symbol, side, price, stop, target, qty, portfolio,
                              equity, round_trip, atr14_d),
    }
