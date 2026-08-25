"""Coach du simulateur de paper trading — détection de biais + mémoire qui
grandit. PUR : stdlib uniquement, ZÉRO I/O (aucune écriture disque, aucun
réseau, aucun appel LLM). Le LLM n'intervient jamais ici — seulement plus
tard côté router, pour REDIGER (post-mortem, quiz...), jamais pour décider.

Ce module travaille sur des DICTS PLAINS (les clés du contrat de données
§4 de la spec) plutôt que sur les dataclasses de ``backend/bots/paper/models.py``
— les deux lots avancent en parallèle, ce fichier ne les importe pas.

Trois familles de fonctions :
  - ``detect_biases``            : les 9 règles de détection déterministes.
  - ``empty_profile``/``update_profile``/``coach_summary`` : le profil qui
    grandit (mémoire machine, persistée par store.py).
  - ``bias_note_entry``/``resolution_note_entry``/``journal_entry`` : blocs
    markdown pour le carnet Obsidian du coach (§11) — cette famille ne fait
    QUE construire du texte, jamais d'I/O (store.append_note s'en charge).
"""
from datetime import datetime, timedelta
from typing import Any, Dict, List, Optional

# --------------------------------------------------------------------------- #
# Constantes
# --------------------------------------------------------------------------- #

_SEVERITY_ORDER = {"critical": 0, "warn": 1, "info": 2}

# Bornage défensif de la longueur des listes "evidence" : au-delà, on résume.
# Choix d'implémentation (non demandé par la spec) documenté dans le rapport.
_MAX_EVIDENCE = 20

_REVENGE_WINDOW = timedelta(minutes=30)
_STALE_DAYS = 14
_RECENT_PROGRESS_DAYS = 30
_OVERSIZED_RATIO = 0.02          # 2 % du capital initial
_OVERTRADING_WARN = 4.0          # x le capital
_OVERTRADING_CRITICAL = 4.8      # x le capital
_FEE_BLEED_RATIO = 0.20          # 20 % du P&L brut
_NO_STOP_FRACTION = 0.30         # 30 % des trades clos
_NO_THESIS_FRACTION = 0.30       # 30 % des trades+ordres
_NO_THESIS_MIN_LEN = 15          # caractères
_LOSER_HOLD_MULTIPLIER = 1.5     # 1.5x la durée des gagnants

# Langues de CONTENU servies par le module (le simulateur parle la langue de
# l'interface). ``en`` est reconnu mais retombe sur ``fr`` : les gabarits
# anglais n'existent pas — repli SILENCIEUX et documenté, pas une erreur.
CONTENT_LANGS = ("fr", "en", "it")

MILESTONE_DEFS = [
    ("first_10_trades", lambda s: s.get("n_trades", 0) >= 10),
    ("first_positive_expectancy",
     lambda s: s.get("n_trades", 0) >= 10 and s.get("expectancy_r", 0) > 0),
    ("survived_20pct_drawdown", lambda s: s.get("max_drawdown_pct", 0) >= 20),
    ("fifty_trades", lambda s: s.get("n_trades", 0) >= 50),
]


# --------------------------------------------------------------------------- #
# Gabarits de texte — les seules chaînes VISIBLES par l'utilisateur
#
# Les ``code`` de biais, les seuils et la structure du retour ne dépendent
# JAMAIS de la langue : seule la phrase de preuve change. Un gabarit manquant
# dans une langue ferait un ``KeyError`` au moment le plus visible — d'où le
# repli par langue ENTIÈRE (``_texts``), jamais clé par clé.
#
# Registre italien : celui d'un trader, pas d'un dictionnaire — « size »,
# « revenge trade », « P&L » sont les mots réellement employés en italien.
# --------------------------------------------------------------------------- #

_TEXTS: Dict[str, Dict[str, str]] = {
    "fr": {
        "unknown_date": "date inconnue",
        "dur_hours": "{hours:.1f}h",
        "dur_days": "{days:.1f}j",
        "more": "... et {n} autres",

        "cut_winners_summary": ("R moyen des gagnants +{avg_win:.2f}R < R moyen des "
                                "perdants {avg_loss:.2f}R (|{abs_loss:.2f}R|)"),
        "cut_winners_item": "{symbol} ({date}): clôturé à +{r:.2f}R",

        "let_losers_summary": ("Durée moyenne de détention des perdants {loss_dur} > "
                               "{multiplier}x celle des gagnants {win_dur} "
                               "(ratio {ratio:.2f}x)"),
        "let_losers_item": "{symbol} ({entry} → {exit}): détenu {duration} en perte",

        "no_stop_summary": "{missing}/{n} trades clos sans stop planifié ({pct:.0f}%)",
        "no_stop_item": "{symbol} ({entry} → {exit}): aucun stop planifié",

        "oversized_order": ("Ordre {symbol} ({date}): risque planifié {risk:.2f} CHF "
                            "({pct:.1f}% du capital)"),
        "oversized_trade": ("{symbol} ({date}): risque planifié {risk:.2f} CHF "
                            "({pct:.1f}% du capital)"),

        "revenge_summary": ("{n} entrée(s) en revanche détectée(s) (< {window} min "
                            "après une perte, taille supérieure)"),
        "revenge_item": ("{symbol} ({date}): entré {minutes} min après une perte sur "
                         "{loser}, taille notionnelle supérieure"),

        "overtrading_summary": ("Volume annualisé estimé {volume:.2f} CHF, soit "
                                "{multiplier:.2f}x le capital initial ({n} trades "
                                "clos en {year})"),
        "overtrading_item": "{symbol} ({date})",

        "fee_bleed_summary": ("Frais cumulés {fees:.2f} CHF = {pct:.0f}% du P&L brut "
                              "({pnl:.2f} CHF sur {n} trades)"),
        "fee_bleed_item": "{symbol} ({date}): {fees:.2f} CHF de frais/timbre",

        "no_thesis_summary": ("{missing}/{n} trades+ordres sans thèse (ou < {min_len} "
                              "caractères) ({pct:.0f}%)"),
        "no_thesis_item": "{symbol} ({date}): thèse absente ou trop courte",
    },
    "it": {
        "unknown_date": "data sconosciuta",
        "dur_hours": "{hours:.1f}h",
        "dur_days": "{days:.1f}g",
        "more": "... e altri {n}",

        "cut_winners_summary": ("R media dei trade vincenti +{avg_win:.2f}R < R media "
                                "dei perdenti {avg_loss:.2f}R (|{abs_loss:.2f}R|)"),
        "cut_winners_item": "{symbol} ({date}): chiuso a +{r:.2f}R",

        "let_losers_summary": ("Durata media di detenzione dei perdenti {loss_dur} > "
                               "{multiplier}x quella dei vincenti {win_dur} "
                               "(rapporto {ratio:.2f}x)"),
        "let_losers_item": "{symbol} ({entry} → {exit}): tenuto {duration} in perdita",

        "no_stop_summary": "{missing}/{n} trade chiusi senza stop pianificato ({pct:.0f}%)",
        "no_stop_item": "{symbol} ({entry} → {exit}): nessuno stop pianificato",

        "oversized_order": ("Ordine {symbol} ({date}): rischio pianificato {risk:.2f} CHF "
                            "({pct:.1f}% del capitale)"),
        "oversized_trade": ("{symbol} ({date}): rischio pianificato {risk:.2f} CHF "
                            "({pct:.1f}% del capitale)"),

        "revenge_summary": ("{n} revenge trade rilevati (< {window} min dopo una "
                            "perdita, con size maggiore)"),
        "revenge_item": ("{symbol} ({date}): entrato {minutes} min dopo una perdita su "
                         "{loser}, size nozionale maggiore"),

        "overtrading_summary": ("Volume annuo stimato {volume:.2f} CHF, pari a "
                                "{multiplier:.2f}x il capitale iniziale ({n} trade "
                                "chiusi nel {year})"),
        "overtrading_item": "{symbol} ({date})",

        "fee_bleed_summary": ("Costi cumulati {fees:.2f} CHF = {pct:.0f}% del P&L lordo "
                              "({pnl:.2f} CHF su {n} trade)"),
        "fee_bleed_item": "{symbol} ({date}): {fees:.2f} CHF di commissioni/bollo",

        "no_thesis_summary": ("{missing}/{n} trade+ordini senza tesi (o < {min_len} "
                              "caratteri) ({pct:.0f}%)"),
        "no_thesis_item": "{symbol} ({date}): tesi assente o troppo corta",
    },
}


def normalize_lang(value: Any) -> str:
    """Normalise une langue demandée. Inconnue -> ``fr``, jamais d'erreur."""
    code = str(value or "").strip().lower()
    return code if code in CONTENT_LANGS else "fr"


def _texts(lang: Any) -> Dict[str, str]:
    """Table de gabarits d'UNE langue. ``en`` (pas de table) retombe sur ``fr``."""
    return _TEXTS.get(normalize_lang(lang)) or _TEXTS["fr"]


# --------------------------------------------------------------------------- #
# Helpers internes
# --------------------------------------------------------------------------- #

def _safe_iso(value: Any) -> Optional[datetime]:
    """Parse un timestamp ISO naïf. None si absent/illisible — jamais de crash."""
    if not value:
        return None
    if isinstance(value, datetime):
        return value
    try:
        return datetime.fromisoformat(str(value))
    except (ValueError, TypeError):
        return None


def _short_date(value: Any, texts: Optional[Dict[str, str]] = None) -> str:
    """Réduit un ISO à sa date (10 premiers caractères) pour des libellés courts."""
    if not value:
        return (texts or _TEXTS["fr"])["unknown_date"]
    s = str(value)
    return s[:10] if len(s) >= 10 else s


def _fmt_duration(seconds: float, texts: Optional[Dict[str, str]] = None) -> str:
    t = texts or _TEXTS["fr"]
    hours = seconds / 3600.0
    if hours < 48:
        return t["dur_hours"].format(hours=hours)
    return t["dur_days"].format(days=hours / 24)


def _trade_notional(trade: Dict[str, Any]) -> float:
    """Taille notionnelle d'un trade en CHF (qty * entry_price * fx_rate).

    fx_rate = taux devise-du-titre -> CHF (défaut 1.0, cf. models.py)."""
    qty = trade.get("qty")
    price = trade.get("entry_price")
    if qty is None or price is None:
        return 0.0
    fx = trade.get("fx_rate", 1.0)
    if fx is None:
        fx = 1.0
    return abs(float(qty)) * abs(float(price)) * float(fx)


def _item_date(item: Dict[str, Any]) -> Any:
    """Date représentative d'un trade (entry_at) ou d'un ordre (created_at)."""
    return item.get("entry_at") or item.get("created_at") or item.get("exit_at")


def _cap_evidence(evidence: List[str],
                  texts: Optional[Dict[str, str]] = None) -> List[str]:
    """Borne une liste de preuves pour ne pas noyer le coach (choix d'implém.)."""
    if len(evidence) <= _MAX_EVIDENCE:
        return evidence
    kept = list(evidence[:_MAX_EVIDENCE])
    kept.append((texts or _TEXTS["fr"])["more"].format(n=len(evidence) - _MAX_EVIDENCE))
    return kept


def _bias(code: str, severity: str, evidence: List[str],
          metric: Optional[float] = None,
          texts: Optional[Dict[str, str]] = None) -> Dict[str, Any]:
    return {"code": code, "severity": severity,
            "evidence": _cap_evidence(list(evidence), texts),
            "metric": metric}


# --------------------------------------------------------------------------- #
# Règle 1 — cut_winners_early
# --------------------------------------------------------------------------- #

def _rule_cut_winners_early(trades: List[Dict[str, Any]],
                             texts: Dict[str, str]) -> Optional[Dict[str, Any]]:
    scoped = [t for t in trades if t.get("r_multiple") is not None]
    winners = [t for t in scoped if t["r_multiple"] > 0]
    losers = [t for t in scoped if t["r_multiple"] < 0]
    if len(winners) < 3 or len(losers) < 3:
        return None
    avg_win = sum(t["r_multiple"] for t in winners) / len(winners)
    avg_loss = sum(t["r_multiple"] for t in losers) / len(losers)
    if avg_win >= abs(avg_loss):
        return None
    summary = texts["cut_winners_summary"].format(
        avg_win=avg_win, avg_loss=avg_loss, abs_loss=abs(avg_loss))
    evidence = [summary] + [
        texts["cut_winners_item"].format(symbol=t.get("symbol", "?"),
                                         date=_short_date(t.get("exit_at"), texts),
                                         r=t["r_multiple"])
        for t in winners
    ]
    ratio = avg_win / abs(avg_loss) if avg_loss != 0 else None
    return _bias("cut_winners_early", "warn", evidence, ratio, texts)


# --------------------------------------------------------------------------- #
# Règle 2 — let_losers_run
# --------------------------------------------------------------------------- #

def _rule_let_losers_run(trades: List[Dict[str, Any]],
                          texts: Dict[str, str]) -> Optional[Dict[str, Any]]:
    winners, losers = [], []
    for t in trades:
        pnl = t.get("pnl_chf")
        entry_dt = _safe_iso(t.get("entry_at"))
        exit_dt = _safe_iso(t.get("exit_at"))
        if pnl is None or entry_dt is None or exit_dt is None:
            continue
        dur = (exit_dt - entry_dt).total_seconds()
        if dur < 0:
            continue
        if pnl > 0:
            winners.append((t, dur))
        elif pnl < 0:
            losers.append((t, dur))
    if len(winners) < 3 or len(losers) < 3:
        return None
    avg_win_dur = sum(d for _, d in winners) / len(winners)
    avg_loss_dur = sum(d for _, d in losers) / len(losers)
    if avg_win_dur <= 0:
        # dégénéré (gagnants clôturés instantanément) : pas de multiplicateur sensé
        return None
    if avg_loss_dur <= _LOSER_HOLD_MULTIPLIER * avg_win_dur:
        return None
    ratio = avg_loss_dur / avg_win_dur
    summary = texts["let_losers_summary"].format(
        loss_dur=_fmt_duration(avg_loss_dur, texts),
        multiplier=_LOSER_HOLD_MULTIPLIER,
        win_dur=_fmt_duration(avg_win_dur, texts), ratio=ratio)
    evidence = [summary] + [
        texts["let_losers_item"].format(
            symbol=t.get("symbol", "?"),
            entry=_short_date(t.get("entry_at"), texts),
            exit=_short_date(t.get("exit_at"), texts),
            duration=_fmt_duration(d, texts))
        for t, d in losers
    ]
    return _bias("let_losers_run", "warn", evidence, ratio, texts)


# --------------------------------------------------------------------------- #
# Règle 3 — no_stop
# --------------------------------------------------------------------------- #

def _rule_no_stop(trades: List[Dict[str, Any]],
                   texts: Dict[str, str]) -> Optional[Dict[str, Any]]:
    n = len(trades)
    if n < 5:
        return None
    missing = [t for t in trades if t.get("planned_stop") is None]
    frac = len(missing) / n
    if frac <= _NO_STOP_FRACTION:
        return None
    summary = texts["no_stop_summary"].format(missing=len(missing), n=n, pct=frac * 100)
    evidence = [summary] + [
        texts["no_stop_item"].format(symbol=t.get("symbol", "?"),
                                     entry=_short_date(t.get("entry_at"), texts),
                                     exit=_short_date(t.get("exit_at"), texts))
        for t in missing
    ]
    return _bias("no_stop", "critical", evidence, frac, texts)


# --------------------------------------------------------------------------- #
# Règle 4 — oversized
# --------------------------------------------------------------------------- #

def _rule_oversized(trades: List[Dict[str, Any]], orders: List[Dict[str, Any]],
                     initial_capital: Optional[float],
                     texts: Dict[str, str]) -> Optional[Dict[str, Any]]:
    if not initial_capital or initial_capital <= 0:
        return None
    threshold = _OVERSIZED_RATIO * initial_capital
    evidence: List[str] = []
    max_ratio = 0.0

    # ``orders`` est par contrat la liste des ordres OUVERTS (Portfolio.open_orders) :
    # pas de re-filtrage par statut ici, on fait confiance à l'appelant.
    for o in orders:
        risk = o.get("risk_chf")
        if risk is None or risk <= threshold:
            continue
        ratio = risk / initial_capital
        max_ratio = max(max_ratio, ratio)
        evidence.append(texts["oversized_order"].format(
            symbol=o.get("symbol", "?"),
            date=_short_date(o.get("created_at"), texts),
            risk=risk, pct=ratio * 100))

    for t in trades:
        stop = t.get("planned_stop")
        entry = t.get("entry_price")
        qty = t.get("qty")
        if stop is None or entry is None or qty is None:
            continue
        fx = t.get("fx_rate", 1.0) or 1.0
        risk = abs(entry - stop) * qty * fx
        if risk <= threshold:
            continue
        ratio = risk / initial_capital
        max_ratio = max(max_ratio, ratio)
        evidence.append(texts["oversized_trade"].format(
            symbol=t.get("symbol", "?"),
            date=_short_date(t.get("entry_at"), texts),
            risk=risk, pct=ratio * 100))

    if not evidence:
        return None
    return _bias("oversized", "critical", evidence, max_ratio, texts)


# --------------------------------------------------------------------------- #
# Règle 5 — revenge_trade
# --------------------------------------------------------------------------- #

def _rule_revenge_trade(trades: List[Dict[str, Any]],
                         texts: Dict[str, str]) -> Optional[Dict[str, Any]]:
    parsed = [(t, _safe_iso(t.get("entry_at")), _safe_iso(t.get("exit_at"))) for t in trades]
    flagged = []
    for t, entry_dt, _exit_dt in parsed:
        if entry_dt is None:
            continue
        t_notional = _trade_notional(t)
        for loser, _l_entry_dt, l_exit_dt in parsed:
            if loser is t or l_exit_dt is None:
                continue
            loss = loser.get("pnl_chf")
            if loss is None or loss >= 0:
                continue
            delta = (entry_dt - l_exit_dt).total_seconds()
            if not (0 <= delta < _REVENGE_WINDOW.total_seconds()):
                continue
            if t_notional > _trade_notional(loser):
                flagged.append((t, loser, delta))
                break  # une preuve suffit par trade candidat
    if not flagged:
        return None
    window_min = int(_REVENGE_WINDOW.total_seconds() // 60)
    summary = texts["revenge_summary"].format(n=len(flagged), window=window_min)
    evidence = [summary] + [
        texts["revenge_item"].format(symbol=t.get("symbol", "?"),
                                     date=_short_date(t.get("entry_at"), texts),
                                     minutes=int(delta // 60),
                                     loser=loser.get("symbol", "?"))
        for t, loser, delta in flagged
    ]
    return _bias("revenge_trade", "warn", evidence, float(len(flagged)), texts)


# --------------------------------------------------------------------------- #
# Règle 6 — overtrading
# --------------------------------------------------------------------------- #

def _rule_overtrading(trades: List[Dict[str, Any]],
                       initial_capital: Optional[float],
                       texts: Dict[str, str]) -> Optional[Dict[str, Any]]:
    if not initial_capital or initial_capital <= 0:
        return None
    # "année civile courante" exige une horloge : cf. section "Points douteux"
    # du rapport — seule entorse à la pureté stricte de ce module.
    year = datetime.now().year
    this_year = []
    for t in trades:
        exit_dt = _safe_iso(t.get("exit_at"))
        if exit_dt is not None and exit_dt.year == year:
            this_year.append(t)
    if not this_year:
        return None
    notional_sum = sum(_trade_notional(t) for t in this_year)
    volume = 2 * notional_sum  # achat + vente
    multiplier = volume / initial_capital
    if multiplier < _OVERTRADING_WARN:
        return None
    severity = "critical" if multiplier >= _OVERTRADING_CRITICAL else "warn"
    summary = texts["overtrading_summary"].format(
        volume=volume, multiplier=multiplier, n=len(this_year), year=year)
    evidence = [summary] + [
        texts["overtrading_item"].format(symbol=t.get("symbol", "?"),
                                         date=_short_date(t.get("exit_at"), texts))
        for t in this_year
    ]
    return _bias("overtrading", severity, evidence, multiplier, texts)


# --------------------------------------------------------------------------- #
# Règle 7 — concentration : NON implémentée ici.
#
# Elle exige la valeur de marché LIVE des positions ouvertes (cours Yahoo,
# I/O réseau) pour calculer le poids d'une position dans le portefeuille —
# incompatible avec ce module PUR (zéro I/O). Le router s'en chargera via
# risk.exposure (Lot A) une fois les cours récupérés.
# --------------------------------------------------------------------------- #


# --------------------------------------------------------------------------- #
# Règle 8 — fee_bleed
# --------------------------------------------------------------------------- #

def _rule_fee_bleed(trades: List[Dict[str, Any]],
                     texts: Dict[str, str]) -> Optional[Dict[str, Any]]:
    n = len(trades)
    if n < 5:
        return None
    fees_sum = sum((t.get("fees_chf") or 0) + (t.get("stamp_duty_chf") or 0) for t in trades)
    pnl_abs_sum = sum(abs(t.get("pnl_chf") or 0) for t in trades)
    if pnl_abs_sum <= 0:
        return None
    ratio = fees_sum / pnl_abs_sum
    if ratio <= _FEE_BLEED_RATIO:
        return None
    summary = texts["fee_bleed_summary"].format(
        fees=fees_sum, pct=ratio * 100, pnl=pnl_abs_sum, n=n)
    ranked = sorted(trades, key=lambda t: (t.get("fees_chf") or 0) + (t.get("stamp_duty_chf") or 0),
                     reverse=True)
    top = [t for t in ranked if (t.get("fees_chf") or 0) + (t.get("stamp_duty_chf") or 0) > 0][:5]
    evidence = [summary] + [
        texts["fee_bleed_item"].format(
            symbol=t.get("symbol", "?"),
            date=_short_date(t.get("exit_at"), texts),
            fees=(t.get("fees_chf") or 0) + (t.get("stamp_duty_chf") or 0))
        for t in top
    ]
    return _bias("fee_bleed", "warn", evidence, ratio, texts)


# --------------------------------------------------------------------------- #
# Règle 9 — no_thesis
# --------------------------------------------------------------------------- #

def _has_thesis(item: Dict[str, Any]) -> bool:
    thesis = item.get("thesis")
    return bool(thesis) and len(str(thesis).strip()) >= _NO_THESIS_MIN_LEN


def _rule_no_thesis(trades: List[Dict[str, Any]], orders: List[Dict[str, Any]],
                     texts: Dict[str, str]) -> Optional[Dict[str, Any]]:
    items = list(trades) + list(orders)
    n = len(items)
    if n < 3:
        return None
    missing = [it for it in items if not _has_thesis(it)]
    frac = len(missing) / n
    if frac <= _NO_THESIS_FRACTION:
        return None
    summary = texts["no_thesis_summary"].format(
        missing=len(missing), n=n, min_len=_NO_THESIS_MIN_LEN, pct=frac * 100)
    evidence = [summary] + [
        texts["no_thesis_item"].format(symbol=it.get("symbol", "?"),
                                       date=_short_date(_item_date(it), texts))
        for it in missing
    ]
    return _bias("no_thesis", "warn", evidence, frac, texts)


# --------------------------------------------------------------------------- #
# API publique — détection
# --------------------------------------------------------------------------- #

def detect_biases(trades: List[Dict[str, Any]], orders: List[Dict[str, Any]],
                   initial_capital: float,
                   lang: str = "fr") -> List[Dict[str, Any]]:
    """Détecte les biais comportementaux du trader, 100% déterministe (zéro LLM).

    ``trades`` = positions CLÔTURÉES (contrat Trade §4). ``orders`` = ordres
    OUVERTS (``Portfolio.open_orders``, contrat Order §4). Retourne une liste
    de dicts ``{"code", "severity", "evidence", "metric"}``, triée critical
    puis warn puis info (tri stable : à égalité de sévérité, ordre des règles
    ci-dessus 1→9).

    ``lang`` ne touche QUE les phrases de ``evidence`` : les ``code``, les
    ``severity``, les ``metric`` et les seuils sont identiques dans toutes les
    langues (le frontend traduit les codes, le backend traduit les preuves).
    Défaut ``fr`` -> un appel à trois arguments rend exactement ce qu'il rendait
    avant l'ajout du paramètre.
    """
    trades = trades or []
    orders = orders or []
    texts = _texts(lang)
    rules = (
        _rule_cut_winners_early(trades, texts),
        _rule_let_losers_run(trades, texts),
        _rule_no_stop(trades, texts),
        _rule_oversized(trades, orders, initial_capital, texts),
        _rule_revenge_trade(trades, texts),
        _rule_overtrading(trades, initial_capital, texts),
        # règle 7 (concentration) volontairement absente, cf. commentaire ci-dessus
        _rule_fee_bleed(trades, texts),
        _rule_no_thesis(trades, orders, texts),
    )
    results = [r for r in rules if r is not None]
    results.sort(key=lambda b: _SEVERITY_ORDER.get(b["severity"], 99))
    return results


# --------------------------------------------------------------------------- #
# API publique — profil qui grandit
# --------------------------------------------------------------------------- #

def empty_profile() -> Dict[str, Any]:
    """Profil coach vierge (avant toute session). Forme figée par le contrat."""
    return {
        "created_at": None,
        "n_sessions": 0,
        "bias_history": {},
        "resolved_biases": [],
        "milestones": [],
        "arena_history": [],
        "notes": [],
    }


def update_profile(profile: Dict[str, Any], biases: List[Dict[str, Any]],
                    stats: Dict[str, Any], now_iso: str) -> Dict[str, Any]:
    """Fait grandir le profil après une session. Retourne un NOUVEAU dict —
    ``profile`` n'est jamais muté (copie profonde manuelle des structures
    imbriquées que cette fonction modifie).
    """
    stats = stats or {}
    biases = biases or []

    new_profile: Dict[str, Any] = dict(profile)
    if new_profile.get("created_at") is None:
        new_profile["created_at"] = now_iso

    new_profile["n_sessions"] = int(new_profile.get("n_sessions", 0)) + 1

    # --- bias_history : incrémente/crée une entrée par code détecté cette session
    bh: Dict[str, Any] = {k: dict(v) for k, v in (profile.get("bias_history") or {}).items()}
    detected_codes = {b["code"] for b in biases}
    for b in biases:
        code = b["code"]
        entry = bh.get(code)
        if entry is None:
            bh[code] = {
                "count": 1,
                "first_seen": now_iso,
                "last_seen": now_iso,
                "last_severity": b.get("severity"),
            }
        else:
            entry["count"] = entry.get("count", 0) + 1
            entry["last_seen"] = now_iso
            entry["last_severity"] = b.get("severity")

    # --- résolution : un biais silencieux depuis > 14 jours (et vu >= 2 fois)
    # est DÉPLACÉ (retiré de bias_history) vers resolved_biases — la récompense
    # du coach qui constate le progrès.
    resolved = [dict(r) for r in (profile.get("resolved_biases") or [])]
    now_dt = _safe_iso(now_iso)
    for code in list(bh.keys()):
        if code in detected_codes:
            continue
        entry = bh[code]
        if entry.get("count", 0) < 2:
            continue
        last_seen_dt = _safe_iso(entry.get("last_seen"))
        if now_dt is None or last_seen_dt is None:
            continue
        age_days = (now_dt - last_seen_dt).total_seconds() / 86400.0
        if age_days > _STALE_DAYS:
            resolved.append({"code": code, "resolved_at": now_iso})
            del bh[code]

    new_profile["bias_history"] = bh
    new_profile["resolved_biases"] = resolved

    # --- milestones : ajout une seule fois chacun (garde une clé)
    milestones = [dict(m) for m in (profile.get("milestones") or [])]
    existing_keys = {m.get("key") for m in milestones}
    for key, predicate in MILESTONE_DEFS:
        if key in existing_keys:
            continue
        try:
            hit = bool(predicate(stats))
        except (TypeError, ValueError):
            hit = False
        if hit:
            milestones.append({"key": key, "reached_at": now_iso})
            existing_keys.add(key)
    new_profile["milestones"] = milestones

    # champs non touchés par cette fonction : recopiés tels quels (nouvelles listes,
    # pour ne jamais partager de référence mutable avec l'entrée)
    new_profile["arena_history"] = list(profile.get("arena_history") or [])
    new_profile["notes"] = list(profile.get("notes") or [])

    return new_profile


def coach_summary(profile: Dict[str, Any], biases: List[Dict[str, Any]],
                   lang: str = "fr") -> Dict[str, Any]:
    """Résumé compact du profil — c'est ce que le router passera au LLM comme
    contexte (jamais pour décider, seulement pour rédiger).

    ``biases`` (détections de la session en cours) n'entre dans AUCUN des 4
    champs ci-dessous à la lettre de la spec : dans le flux attendu
    (``detect_biases`` → ``update_profile`` → ``coach_summary``),
    ``bias_history`` du profil passé ici a déjà absorbé ``biases``. Le
    paramètre est conservé pour la stabilité de l'interface — cf. rapport.

    ⚠️ ``lang`` est accepté (symétrie avec ``detect_biases`` : le router passe
    la même langue aux deux) mais la SORTIE est identique dans toutes les
    langues, et c'est voulu — ce résumé ne contient AUCUNE phrase, seulement
    des CODES (``top_biases``, ``recent_progress[].code``, ``milestones[].key``)
    que le client traduit avec ses propres libellés. Traduire ici casserait
    justement ce contrat. Le jour où une phrase apparaît dans ce résumé, elle
    aura déjà sa langue sous la main sans changer aucun appelant.
    """
    _texts(lang)                                  # valide la langue, ne l'utilise pas
    bh = profile.get("bias_history") or {}
    top = sorted(bh.items(), key=lambda kv: (kv[1] or {}).get("count", 0), reverse=True)
    top_codes = [code for code, _ in top[:3]]

    resolved = profile.get("resolved_biases") or []
    now = datetime.now()
    recent = []
    for r in resolved:
        dt = _safe_iso(r.get("resolved_at"))
        if dt is not None and (now - dt).total_seconds() <= _RECENT_PROGRESS_DAYS * 86400:
            recent.append(r)

    return {
        "top_biases": top_codes,
        "recent_progress": recent,
        "n_sessions": profile.get("n_sessions", 0),
        "milestones": list(profile.get("milestones") or []),
    }


# --------------------------------------------------------------------------- #
# API publique — carnet Markdown façon Obsidian (§11)
#
# Ces trois fonctions ne font que CONSTRUIRE du texte — aucune écriture
# disque (store.append_note s'en charge). Chaque bloc se termine par une
# ligne vide pour séparer proprement deux entrées appendées successivement
# dans le même fichier.
# --------------------------------------------------------------------------- #

def bias_note_entry(bias: Dict[str, Any], now_iso: str) -> str:
    """Bloc markdown appendable à ``Biais/<code>.md`` lors d'une détection."""
    date = _short_date(now_iso)
    severity = bias.get("severity", "info")
    evidence = bias.get("evidence") or []
    lines = [f"## {date} — détection ({severity})", ""]
    if evidence:
        lines.extend(f"- {ev}" for ev in evidence)
    else:
        lines.append("- (aucune preuve détaillée)")
    lines.extend(["", "[[Journal]]", ""])
    return "\n".join(lines) + "\n"


def resolution_note_entry(code: str, now_iso: str) -> str:
    """Bloc de félicitations sobre pour ``Biais/<code>.md`` quand un biais se
    résout (plus détecté depuis >= 14 jours, cf. ``update_profile``)."""
    date = _short_date(now_iso)
    lines = [
        f"## {date} — résolu",
        "",
        f"Le biais **{code}** n'est plus détecté depuis au moins {_STALE_DAYS} jours. Progrès noté.",
        "",
        "[[Journal]]",
        "",
    ]
    return "\n".join(lines) + "\n"


def journal_entry(title: str, body: str, now_iso: str) -> str:
    """Bloc markdown appendable à ``Journal.md`` : une entrée datée, titre +
    corps déjà rédigé (par le LLM ou ailleurs — cette fonction assemble, elle
    ne rédige pas le corps)."""
    date = _short_date(now_iso)
    text = body if isinstance(body, str) else str(body)
    return f"## {date} — {title}\n\n{text.strip()}\n\n"
