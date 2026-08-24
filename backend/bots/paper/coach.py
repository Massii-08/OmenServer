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

MILESTONE_DEFS = [
    ("first_10_trades", lambda s: s.get("n_trades", 0) >= 10),
    ("first_positive_expectancy",
     lambda s: s.get("n_trades", 0) >= 10 and s.get("expectancy_r", 0) > 0),
    ("survived_20pct_drawdown", lambda s: s.get("max_drawdown_pct", 0) >= 20),
    ("fifty_trades", lambda s: s.get("n_trades", 0) >= 50),
]


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


def _short_date(value: Any) -> str:
    """Réduit un ISO à sa date (10 premiers caractères) pour des libellés courts."""
    if not value:
        return "date inconnue"
    s = str(value)
    return s[:10] if len(s) >= 10 else s


def _fmt_duration(seconds: float) -> str:
    hours = seconds / 3600.0
    if hours < 48:
        return f"{hours:.1f}h"
    return f"{hours / 24:.1f}j"


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


def _cap_evidence(evidence: List[str]) -> List[str]:
    """Borne une liste de preuves pour ne pas noyer le coach (choix d'implém.)."""
    if len(evidence) <= _MAX_EVIDENCE:
        return evidence
    kept = list(evidence[:_MAX_EVIDENCE])
    kept.append(f"... et {len(evidence) - _MAX_EVIDENCE} autres")
    return kept


def _bias(code: str, severity: str, evidence: List[str],
          metric: Optional[float] = None) -> Dict[str, Any]:
    return {"code": code, "severity": severity, "evidence": _cap_evidence(list(evidence)),
            "metric": metric}


# --------------------------------------------------------------------------- #
# Règle 1 — cut_winners_early
# --------------------------------------------------------------------------- #

def _rule_cut_winners_early(trades: List[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    scoped = [t for t in trades if t.get("r_multiple") is not None]
    winners = [t for t in scoped if t["r_multiple"] > 0]
    losers = [t for t in scoped if t["r_multiple"] < 0]
    if len(winners) < 3 or len(losers) < 3:
        return None
    avg_win = sum(t["r_multiple"] for t in winners) / len(winners)
    avg_loss = sum(t["r_multiple"] for t in losers) / len(losers)
    if avg_win >= abs(avg_loss):
        return None
    summary = (f"R moyen des gagnants +{avg_win:.2f}R < R moyen des perdants "
               f"{avg_loss:.2f}R (|{abs(avg_loss):.2f}R|)")
    evidence = [summary] + [
        f"{t.get('symbol', '?')} ({_short_date(t.get('exit_at'))}): clôturé à +{t['r_multiple']:.2f}R"
        for t in winners
    ]
    ratio = avg_win / abs(avg_loss) if avg_loss != 0 else None
    return _bias("cut_winners_early", "warn", evidence, ratio)


# --------------------------------------------------------------------------- #
# Règle 2 — let_losers_run
# --------------------------------------------------------------------------- #

def _rule_let_losers_run(trades: List[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
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
    summary = (f"Durée moyenne de détention des perdants {_fmt_duration(avg_loss_dur)} "
               f"> {_LOSER_HOLD_MULTIPLIER}x celle des gagnants {_fmt_duration(avg_win_dur)} "
               f"(ratio {ratio:.2f}x)")
    evidence = [summary] + [
        f"{t.get('symbol', '?')} ({_short_date(t.get('entry_at'))} → {_short_date(t.get('exit_at'))}): "
        f"détenu {_fmt_duration(d)} en perte"
        for t, d in losers
    ]
    return _bias("let_losers_run", "warn", evidence, ratio)


# --------------------------------------------------------------------------- #
# Règle 3 — no_stop
# --------------------------------------------------------------------------- #

def _rule_no_stop(trades: List[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    n = len(trades)
    if n < 5:
        return None
    missing = [t for t in trades if t.get("planned_stop") is None]
    frac = len(missing) / n
    if frac <= _NO_STOP_FRACTION:
        return None
    summary = f"{len(missing)}/{n} trades clos sans stop planifié ({frac * 100:.0f}%)"
    evidence = [summary] + [
        f"{t.get('symbol', '?')} ({_short_date(t.get('entry_at'))} → {_short_date(t.get('exit_at'))}): "
        f"aucun stop planifié"
        for t in missing
    ]
    return _bias("no_stop", "critical", evidence, frac)


# --------------------------------------------------------------------------- #
# Règle 4 — oversized
# --------------------------------------------------------------------------- #

def _rule_oversized(trades: List[Dict[str, Any]], orders: List[Dict[str, Any]],
                     initial_capital: Optional[float]) -> Optional[Dict[str, Any]]:
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
        evidence.append(
            f"Ordre {o.get('symbol', '?')} ({_short_date(o.get('created_at'))}): "
            f"risque planifié {risk:.2f} CHF ({ratio * 100:.1f}% du capital)"
        )

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
        evidence.append(
            f"{t.get('symbol', '?')} ({_short_date(t.get('entry_at'))}): "
            f"risque planifié {risk:.2f} CHF ({ratio * 100:.1f}% du capital)"
        )

    if not evidence:
        return None
    return _bias("oversized", "critical", evidence, max_ratio)


# --------------------------------------------------------------------------- #
# Règle 5 — revenge_trade
# --------------------------------------------------------------------------- #

def _rule_revenge_trade(trades: List[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
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
    summary = f"{len(flagged)} entrée(s) en revanche détectée(s) (< 30 min après une perte, taille supérieure)"
    evidence = [summary] + [
        f"{t.get('symbol', '?')} ({_short_date(t.get('entry_at'))}): entré {int(delta // 60)} min après "
        f"une perte sur {loser.get('symbol', '?')}, taille notionnelle supérieure"
        for t, loser, delta in flagged
    ]
    return _bias("revenge_trade", "warn", evidence, float(len(flagged)))


# --------------------------------------------------------------------------- #
# Règle 6 — overtrading
# --------------------------------------------------------------------------- #

def _rule_overtrading(trades: List[Dict[str, Any]],
                       initial_capital: Optional[float]) -> Optional[Dict[str, Any]]:
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
    summary = (f"Volume annualisé estimé {volume:.2f} CHF, soit {multiplier:.2f}x le capital "
               f"initial ({len(this_year)} trades clos en {year})")
    evidence = [summary] + [
        f"{t.get('symbol', '?')} ({_short_date(t.get('exit_at'))})"
        for t in this_year
    ]
    return _bias("overtrading", severity, evidence, multiplier)


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

def _rule_fee_bleed(trades: List[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
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
    summary = (f"Frais cumulés {fees_sum:.2f} CHF = {ratio * 100:.0f}% du P&L brut "
               f"({pnl_abs_sum:.2f} CHF sur {n} trades)")
    ranked = sorted(trades, key=lambda t: (t.get("fees_chf") or 0) + (t.get("stamp_duty_chf") or 0),
                     reverse=True)
    top = [t for t in ranked if (t.get("fees_chf") or 0) + (t.get("stamp_duty_chf") or 0) > 0][:5]
    evidence = [summary] + [
        f"{t.get('symbol', '?')} ({_short_date(t.get('exit_at'))}): "
        f"{(t.get('fees_chf') or 0) + (t.get('stamp_duty_chf') or 0):.2f} CHF de frais/timbre"
        for t in top
    ]
    return _bias("fee_bleed", "warn", evidence, ratio)


# --------------------------------------------------------------------------- #
# Règle 9 — no_thesis
# --------------------------------------------------------------------------- #

def _has_thesis(item: Dict[str, Any]) -> bool:
    thesis = item.get("thesis")
    return bool(thesis) and len(str(thesis).strip()) >= _NO_THESIS_MIN_LEN


def _rule_no_thesis(trades: List[Dict[str, Any]],
                     orders: List[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    items = list(trades) + list(orders)
    n = len(items)
    if n < 3:
        return None
    missing = [it for it in items if not _has_thesis(it)]
    frac = len(missing) / n
    if frac <= _NO_THESIS_FRACTION:
        return None
    summary = f"{len(missing)}/{n} trades+ordres sans thèse (ou < {_NO_THESIS_MIN_LEN} caractères) ({frac * 100:.0f}%)"
    evidence = [summary] + [
        f"{it.get('symbol', '?')} ({_short_date(_item_date(it))}): thèse absente ou trop courte"
        for it in missing
    ]
    return _bias("no_thesis", "warn", evidence, frac)


# --------------------------------------------------------------------------- #
# API publique — détection
# --------------------------------------------------------------------------- #

def detect_biases(trades: List[Dict[str, Any]], orders: List[Dict[str, Any]],
                   initial_capital: float) -> List[Dict[str, Any]]:
    """Détecte les biais comportementaux du trader, 100% déterministe (zéro LLM).

    ``trades`` = positions CLÔTURÉES (contrat Trade §4). ``orders`` = ordres
    OUVERTS (``Portfolio.open_orders``, contrat Order §4). Retourne une liste
    de dicts ``{"code", "severity", "evidence", "metric"}``, triée critical
    puis warn puis info (tri stable : à égalité de sévérité, ordre des règles
    ci-dessus 1→9).
    """
    trades = trades or []
    orders = orders or []
    rules = (
        _rule_cut_winners_early(trades),
        _rule_let_losers_run(trades),
        _rule_no_stop(trades),
        _rule_oversized(trades, orders, initial_capital),
        _rule_revenge_trade(trades),
        _rule_overtrading(trades, initial_capital),
        # règle 7 (concentration) volontairement absente, cf. commentaire ci-dessus
        _rule_fee_bleed(trades),
        _rule_no_thesis(trades, orders),
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


def coach_summary(profile: Dict[str, Any], biases: List[Dict[str, Any]]) -> Dict[str, Any]:
    """Résumé compact du profil — c'est ce que le router passera au LLM comme
    contexte (jamais pour décider, seulement pour rédiger).

    ``biases`` (détections de la session en cours) n'entre dans AUCUN des 4
    champs ci-dessous à la lettre de la spec : dans le flux attendu
    (``detect_biases`` → ``update_profile`` → ``coach_summary``),
    ``bias_history`` du profil passé ici a déjà absorbé ``biases``. Le
    paramètre est conservé pour la stabilité de l'interface — cf. rapport.
    """
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
