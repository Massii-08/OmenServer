"""Bilan hebdomadaire du dimanche soir (LOT 3, C2).

Demande de l'utilisateur : un rituel régulier, pas seulement des rapports
déclenchés par un trade ou une convergence — « fais le point sur ma semaine,
même si rien de spécial ne s'est passé ». Accroché au cycle du guetteur
(``newswatch.run_once``, toutes les 5 minutes), même patron que la sauvegarde
nocturne (G1, ``backup.py``) : un GATE pur qui décide « c'est le moment »,
et un exécutant best-effort qui ne fait jamais tomber le cycle.

Découpage PUR / I-O (même règle que le reste du lot) :
  - PUR : ``weekly_due`` / ``build_context`` / ``fallback_report`` — zéro I/O,
    horloge et données passées en paramètre, 100 % testable hors ligne ;
  - I/O : ``load_state``/``save_state`` (état, patron ``backup.py``) et
    ``maybe_run`` (le GATE + l'exécution, appelé depuis le cycle du guetteur).

**Envoyé MÊME en mode calme** (contrairement aux émetteurs unitaires du
guetteur) : c'est un RITUEL voulu une fois par semaine, pas une notification
qu'on pourrait vouloir faire taire — même doctrine que la convergence
(``alerts.is_quiet`` n'est JAMAIS consulté ici).

**Écrit au carnet MÊME sans canal Telegram configuré** : le bilan hebdomadaire
a DEUX destinations, et une seule est optionnelle. L'entrée ``Journal.md``
est la trace durable (consultable n'importe quand) ; Telegram n'est que la
notification immédiate. Sans canal, on écrit quand même — et on ARME l'état
quand même (sinon un compte sans Telegram configuré verrait le guetteur
retenter le même travail toutes les 5 minutes pendant toute la soirée du
dimanche).

Panne du LLM -> bilan déterministe COURT envoyé quand même (même patron que
``convergence.fallback_digest``) : la valeur du rituel est la RÉGULARITÉ, pas
la prose.

Heure de référence : ``Europe/Rome``, même convention que ``backup.py``.
"""
import json
import logging
import os
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Tuple
from zoneinfo import ZoneInfo

from backend.bots.paper import coach, risk, tradestats

logger = logging.getLogger("omenserver")

LOCAL_TZ = "Europe/Rome"

STATE_NAME = "weekly.state.json"

# Dimanche (``datetime.weekday()`` : lundi=0 … dimanche=6), pas avant cette
# heure LOCALE — laisser la journée de trading (fictive) finir avant le bilan.
RUN_WEEKDAY = 6
RUN_AFTER_HOUR = 18

# « Trades clos cette semaine » : les 7 derniers jours glissants, pas le
# calendrier ISO — un bilan qui tombe un dimanche doit couvrir toute la
# semaine écoulée, pas seulement depuis lundi.
LOOKBACK_DAYS = 7

# Combien de biais dominants injecter dans le contexte du LLM — au-delà, ce
# n'est plus un TOP, c'est la liste complète (même doctrine que
# ``idea_journal.SUMMARY_LIMIT``).
TOP_BIASES = 3

MAX_FALLBACK_TRADES = 10

HEADER = "[Simulateur] BILAN HEBDOMADAIRE"
FALLBACK_TAIL = "(modèle indisponible — bilan brut, à toi de le commenter.)"

# Fichiers de ``data/paper_trading/`` qui ne sont PAS des portefeuilles — même
# doctrine que ``newswatch._discover_portfolios`` (ceinture ET bretelles : le
# radical de chacun porte un point, donc ``store._sanitize_username`` les
# rejette déjà structurellement comme nom de compte).
_AUX_SUFFIXES = (
    ".coach.json", ".news_seen.json", ".watchlist.json", ".board.json",
    ".ideas.json", ".alerts.json", ".replay.json", ".postmortem_auto.json",
)
_AUX_NAMES = ("alerts_mode.json", "x_accounts.json", "backup.state.json",
             "backfill.json", "calendar.verdicts.json", "convergence.json",
             "radar.json", "newswatch_global.json", "weekly.state.json")


# --------------------------------------------------------------------------- #
# PUR — horloge (heure LOCALE, jamais celle du système)
# --------------------------------------------------------------------------- #

def _aware_utc(now: Any) -> datetime:
    """``now`` en ``datetime`` timezone-aware. Un naïf est traité comme UTC —
    même convention que ``backup._aware_utc``."""
    if not isinstance(now, datetime):
        now = datetime.now(timezone.utc)
    if now.tzinfo is None:
        now = now.replace(tzinfo=timezone.utc)
    return now


def _local(now: Any) -> datetime:
    return _aware_utc(now).astimezone(ZoneInfo(LOCAL_TZ))


def _parse_iso(value: Any) -> Optional[datetime]:
    """ISO -> ``datetime`` aware (naïf traité comme UTC), ou ``None``."""
    if not isinstance(value, str) or not value.strip():
        return None
    text = value.strip()
    if text[-1] in ("Z", "z"):
        text = text[:-1]
    try:
        parsed = datetime.fromisoformat(text)
    except (TypeError, ValueError):
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed


def _iso_week_local(now: Any) -> str:
    """Semaine ISO (``2026-W35``) à l'heure LOCALE — même format que
    ``paper_router._week_id``."""
    parts = _local(now).isocalendar()
    return "%04d-W%02d" % (parts[0], parts[1])


# --------------------------------------------------------------------------- #
# PUR — le gate
# --------------------------------------------------------------------------- #

def weekly_due(now: Any, last_ts: Optional[str]) -> bool:
    """Le bilan hebdomadaire doit-il partir MAINTENANT ? (PUR)

    Dimanche (heure locale), à partir de :data:`RUN_AFTER_HOUR`, et pas déjà
    fait cette semaine ISO. ``last_ts`` est l'horodatage ISO du DERNIER envoi
    réussi (``state["last_sent_iso"]``) — comparé en SEMAINE, pas à la minute
    près : un premier tir à 18h01 ne doit pas en autoriser un second à 18h37.
    """
    now_dt = _aware_utc(now)
    local = _local(now_dt)
    if local.weekday() != RUN_WEEKDAY:
        return False
    if local.hour < RUN_AFTER_HOUR:
        return False
    last_dt = _parse_iso(last_ts)
    if last_dt is None:
        return True
    return _iso_week_local(last_dt) != _iso_week_local(now_dt)


# --------------------------------------------------------------------------- #
# PUR — le contexte de la semaine (déterministe, zéro LLM)
# --------------------------------------------------------------------------- #

def _dicts(value: Any) -> List[Dict[str, Any]]:
    if not isinstance(value, list):
        return []
    return [item for item in value if isinstance(item, dict)]


def closed_this_week(trades: Any, now: Any, days: int = LOOKBACK_DAYS) -> List[Dict[str, Any]]:
    """Les trades dont ``exit_at`` tombe dans les ``days`` derniers jours
    glissants (PUR). Un horodatage illisible est exclu, jamais deviné."""
    cutoff = _aware_utc(now) - timedelta(days=days)
    out = []
    for trade in _dicts(trades):
        exit_dt = _parse_iso(trade.get("exit_at"))
        if exit_dt is not None and exit_dt >= cutoff:
            out.append(trade)
    return out


def build_context(portfolio: Optional[Dict[str, Any]], now: Any,
                  radar_stats: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """Le contexte de la semaine passé au LLM — des faits déjà calculés, rien
    de plus (même doctrine que ``paper_router._coach_context``).

    ``radar_stats`` (``{"hits","misses","unclear"}``, cf. ``radar.load_state``)
    est INJECTÉ par l'appelant : c'est un état PARTAGÉ (pas par compte), lu
    UNE fois par cycle plutôt qu'une fois par compte."""
    portfolio = portfolio or {}
    trades = _dicts(portfolio.get("trades"))
    orders = _dicts(portfolio.get("open_orders"))
    capital = portfolio.get("initial_capital")

    return {
        "closed_this_week": closed_this_week(trades, now),
        "stats": risk.portfolio_stats(trades, initial_capital=capital),
        "discipline": tradestats.discipline_score(trades, capital),
        "open_positions": _dicts(portfolio.get("positions")),
        "top_biases": coach.detect_biases(trades, orders, capital)[:TOP_BIASES],
        "radar": radar_stats or {},
        "cash_chf": portfolio.get("cash_chf"),
        "initial_capital_chf": capital,
    }


def fallback_report(context: Optional[Dict[str, Any]]) -> str:
    """Le bilan de secours quand le LLM ne répond pas (PUR), même patron que
    ``convergence.fallback_digest`` : déterministe, compact, ENVOYÉ QUAND
    MÊME — la valeur du rituel est la régularité, pas la prose."""
    ctx = context or {}
    trades = _dicts(ctx.get("closed_this_week"))
    stats = ctx.get("stats") or {}
    discipline = ctx.get("discipline") or {}
    positions = _dicts(ctx.get("open_positions"))

    lines = [HEADER, ""]
    if trades:
        lines.append("%d trade(s) clôturé(s) cette semaine, P&L cumulé %.2f CHF."
                     % (len(trades), float(stats.get("total_pnl_chf") or 0.0)))
        for trade in trades[:MAX_FALLBACK_TRADES]:
            symbol = trade.get("symbol") or "?"
            pnl = trade.get("pnl_chf")
            lines.append("- %s : %s" % (symbol,
                         "%+.2f CHF" % pnl if isinstance(pnl, (int, float)) else "?"))
        extra = len(trades) - MAX_FALLBACK_TRADES
        if extra > 0:
            lines.append("- … et %d autre(s)." % extra)
    else:
        lines.append("Aucun trade clôturé cette semaine.")

    score = discipline.get("score")
    lines.append("Score de discipline : %s." % (score if score is not None else "n/d (moins de 5 trades)"))
    lines.append("Positions encore ouvertes : %d." % len(positions))
    lines.append("")
    lines.append(FALLBACK_TAIL)
    return "\n".join(lines)


def with_header(text: Any) -> str:
    """Préfixe le bilan de l'en-tête commun (idempotent : le secours le porte
    déjà) — même geste que ``convergence.with_header``."""
    body = str(text or "").strip()
    if body.startswith(HEADER):
        return body
    return "%s\n%s" % (HEADER, body) if body else HEADER


# --------------------------------------------------------------------------- #
# I/O — chemins et état, résolus PARESSEUSEMENT depuis store.DATA_DIR (même
# patron que ``backup.py``/``alerts.py`` : un test qui isole DATA_DIR isole
# aussi ce module)
# --------------------------------------------------------------------------- #

def _store():
    from backend.bots.paper import store
    return store


def state_path() -> Path:
    return Path(_store().DATA_DIR) / STATE_NAME


def load_state() -> Dict[str, Any]:
    """L'état (``{"last_sent_iso": "..."}"``). Absent/corrompu -> ``{}`` — le
    rituel ne doit jamais tomber parce qu'un fichier a été touché à la main."""
    path = state_path()
    if not path.is_file():
        return {}
    try:
        with open(str(path), "r", encoding="utf-8") as handle:
            data = json.load(handle)
    except (OSError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


def save_state(state: Dict[str, Any]) -> None:
    """Persiste l'état de façon atomique, 0o600 — même patron que
    ``backup.save_state``/``radar.save_state`` (le temporaire NAÎT en 0o600
    via ``os.open``+``os.fchmod``, jamais ``open()``+``chmod()``)."""
    path = state_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = path.parent / (".%s.tmp-%d" % (path.name, os.getpid()))
    fd = os.open(str(tmp_path), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    try:
        os.fchmod(fd, 0o600)
    except (AttributeError, OSError):
        pass
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(dict(state or {}), handle, ensure_ascii=False, indent=2)
        os.replace(str(tmp_path), str(path))
    except Exception:
        try:
            os.remove(str(tmp_path))
        except OSError:
            pass
        raise


def _discover_accounts() -> List[Tuple[str, Dict[str, Any]]]:
    """``[(username, portfolio)]`` pour CHAQUE compte réel (a un fichier
    portefeuille lisible) — sans le filtre « a une position ou une watchlist »
    de ``newswatch._discover_portfolios`` : un compte entièrement à plat
    mérite quand même son bilan (« aucun trade cette semaine » est un fait à
    commenter, pas une raison de sauter le compte, cf. tête de fichier)."""
    store = _store()
    data_dir = Path(store.DATA_DIR)
    if not data_dir.is_dir():
        return []
    out: List[Tuple[str, Dict[str, Any]]] = []
    for path in sorted(data_dir.glob("*.json")):
        name = path.name
        if name.endswith(_AUX_SUFFIXES) or name in _AUX_NAMES:
            continue
        username = path.stem
        try:
            portfolio = store.load_portfolio(username)
        except ValueError:
            continue
        if isinstance(portfolio, dict):
            out.append((username, portfolio))
    return out


def _default_llm(context: Dict[str, Any]) -> str:
    from backend.bots.paper import llm
    return llm.write_weekly_report(context)


def _usable(cfg: Optional[Dict[str, Any]]) -> bool:
    """Même définition que ``alerts._usable`` : un canal n'est utilisable que
    COMPLET. Revérifié ICI (et pas seulement dans ``alerts.send``) parce que
    ``notifier`` peut être un notifieur INJECTÉ (tests, ou un futur canal qui
    ne connaît pas cette notion) — l'appelant ne doit jamais dépendre du bon
    vouloir du notifieur pour savoir s'il doit tenter l'envoi."""
    if not isinstance(cfg, dict):
        return False
    return bool(cfg.get("token")) and bool(cfg.get("chat_id"))


def _send(notifier: Optional[Callable[[str, Dict[str, Any]], Any]],
          text: str, cfg: Optional[Dict[str, Any]]) -> bool:
    """Envoi best-effort — même patron que ``convergence._send``, gate de
    présence du canal EN PLUS (cf. :func:`_usable`)."""
    if not _usable(cfg):
        return False
    try:
        if notifier is not None:
            return bool(notifier(text, cfg))
        from backend.bots.paper import alerts
        return bool(alerts.send(text, cfg))
    except Exception:      # noqa: BLE001 — ne fuite jamais le jeton
        return False


def _note(username: str, title: str, body: str, now_iso: str) -> None:
    """Écrit l'entrée au carnet PERSONNEL du compte, ``Journal.md`` — le
    même fichier que les post-mortems et les sessions coach (cf.
    ``coach.journal_entry``, ``paper_router._append_journal``). Best-effort :
    un carnet en échec pour UN compte ne doit jamais faire perdre les
    autres."""
    try:
        store = _store()
        store.append_note(username, "Journal.md",
                          coach.journal_entry(title, body, now_iso))
    except Exception as exc:      # noqa: BLE001
        logger.warning("paper weekly: carnet de %s non écrit (%s)",
                       username, type(exc).__name__)


# --------------------------------------------------------------------------- #
# I/O — le GATE, appelé depuis le cycle du guetteur (best-effort STRICT)
# --------------------------------------------------------------------------- #

def maybe_run(now: Any = None,
             llm: Optional[Callable[[Dict[str, Any]], str]] = None,
             notifier: Optional[Callable[[str, Dict[str, Any]], Any]] = None,
             tg_cfg: Optional[Dict[str, Any]] = None,
             portfolios: Optional[List[Tuple[str, Dict[str, Any]]]] = None,
             radar_stats: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """Le bilan hebdomadaire, si c'est le moment. NE LÈVE JAMAIS —
    l'appelant (``newswatch.run_once``) ne doit jamais perdre un cycle de
    veille pour une panne du rituel du dimanche.

    L'état est ARMÉ dès que le travail a été FAIT (contexte construit, texte
    écrit au carnet), que Telegram ait accusé réception ou non — sans canal
    configuré, retenter toutes les 5 minutes jusqu'à minuit n'apporterait
    rien de plus (cf. tête de fichier)."""
    now_dt = _aware_utc(now)
    try:
        state = load_state()
        if not weekly_due(now_dt, state.get("last_sent_iso")):
            return {"ran": False, "reason": "not_due", "n_accounts": 0, "sent": 0}

        accounts = portfolios if portfolios is not None else _discover_accounts()

        cfg = tg_cfg
        if cfg is None:
            try:
                from backend.bots.paper import alerts
                cfg = alerts.load_cfg()
            except Exception:      # noqa: BLE001
                cfg = None

        radar = radar_stats
        if radar is None:
            try:
                from backend.bots.paper import radar as radar_mod
                radar = (radar_mod.load_state() or {}).get("stats") or {}
            except Exception:      # noqa: BLE001 — radar absent ou en panne
                radar = {}

        now_iso = now_dt.isoformat()
        sent = 0
        for username, portfolio in accounts:
            try:
                context = build_context(portfolio, now_dt, radar_stats=radar)
                used_llm = True
                try:
                    text = (llm or _default_llm)(context)
                    text = str(text or "").strip()
                    if not text:
                        raise RuntimeError("bilan vide")
                except Exception:      # noqa: BLE001 — LLM muet : secours brut
                    used_llm = False
                    text = fallback_report(context)
                message = with_header(text)

                if _send(notifier, message, cfg):
                    sent += 1

                title = "bilan hebdomadaire" if used_llm \
                    else "bilan hebdomadaire (secours)"
                _note(username, title, text, now_iso)
            except Exception as exc:      # noqa: BLE001 — un compte ne casse pas les autres
                logger.warning("paper weekly: bilan de %s en échec (%s)",
                               username, type(exc).__name__)

        state = dict(state)
        state["last_sent_iso"] = now_iso
        save_state(state)
        return {"ran": True, "n_accounts": len(accounts), "sent": sent}
    except Exception as exc:      # noqa: BLE001 — jamais fatal pour le cycle
        logger.warning("paper weekly: bilan impossible (%s)", type(exc).__name__)
        return {"ran": False, "reason": "error", "n_accounts": 0, "sent": 0}
