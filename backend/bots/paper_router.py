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
import random
import threading
import time
import uuid
from datetime import datetime
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from backend.auth.models import User
from backend.auth.permissions import require_role
from backend.bots.paper import (alerts, board, coach, coach_trader, entities,
                                fees, fills, graph, idea_journal, llm, models,
                                mood, price_alerts, quotes, replay, risk,
                                store, ta, tradestats)

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

# Alertes de prix (A1) — même ordre de grandeur que la watchlist, même
# raison : au-delà, ce n'est plus une poignée de niveaux à surveiller.
MAX_ALERTS = price_alerts.MAX_ALERTS_PER_USER

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

# Fenêtre de l'analyse technique du coach (LOT 5) : une ANNÉE de bougies
# quotidiennes. C'est le minimum pour que la moyenne 200 existe — en dessous,
# ``ta`` rend ``None`` plutôt qu'une « moyenne 200 » calculée sur 60 séances,
# qui serait un mensonge.
TECHNICAL_RANGE = "1y"
TECHNICAL_INTERVAL = "1d"

# Bornes du DOSSIER d'un titre retenu par le tri (LOT 5, second temps). Elles
# existent pour que trois dossiers restent lisibles : le but est la PROFONDEUR
# sur peu de titres, pas de rapatrier toute la mémoire.
DOSSIER_NEWS_PER_SYMBOL = 6
DOSSIER_WHALES_PER_SYMBOL = 4
DOSSIER_MEMORY_PER_SYMBOL = 5

# Post-mortem AUTOMATIQUE (LOT 3, C1) : garde-fou anti-rafale, par compte et
# par jour. Chaque clôture détache un appel au modèle (60-90 s, cf. le
# registre de travaux ci-dessous) — sans plafond, une série de stops qui
# sautent en cascade (marché qui plonge pendant la nuit) lancerait autant
# d'appels au CLI Claude que de trades clôturés, sur une machine qui fait
# déjà tourner le serveur et les autres bots.
MAX_AUTO_POSTMORTEMS_PER_DAY = 6

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
# TRAVAUX EN ARRIÈRE-PLAN — les six appels au modèle ne tiennent plus la requête
#
# INCIDENT MESURÉ. Les six endpoints qui appellent le modèle mettent 60 à 90
# secondes. Ils répondaient EN LIGNE, donc la requête HTTP restait ouverte tout
# ce temps, à travers le tunnel Cloudflare — qui coupe vers 100 s. Le moindre
# hoquet réseau pendant l'attente, et l'utilisateur récoltait un 502 : le
# travail avait bien eu lieu (le journal, le pipeline, le radar étaient écrits),
# mais la réponse était perdue et l'écran disait « erreur ».
#
# Le patron est celui des autres bots du dépôt (Bond Scanner, Harvester) : on
# DÉTACHE le travail, la requête rend un accusé, et le client vient chercher le
# résultat. Ici un THREAD suffit là où eux lancent un subprocess — le travail
# est un appel réseau qui attend, pas du calcul, et le résultat doit revenir
# dans le même processus pour être rendu au client.
#
# Trois choix qui méritent d'être dits :
#
# 1. **Le fil est ``daemon``.** Il survit à la requête (c'est tout l'objet), mais
#    il ne retient PAS l'arrêt du serveur : l'auto-deploy redémarre uvicorn
#    toutes les minutes dès qu'un commit arrive, et bloquer 90 s à chaque
#    redémarrage coûterait plus cher que de perdre un digest. Un travail coupé
#    par un redémarrage se relance d'un clic.
# 2. **``current_user`` ne franchit JAMAIS la frontière du fil.** L'objet vient
#    d'une session SQLAlchemy que FastAPI referme à la fin de la requête ; le
#    lire depuis le fil léverait un ``DetachedInstanceError`` — et il le
#    lèverait DANS le fil, donc en silence, le travail se soldant par une erreur
#    incompréhensible. On extrait le nom d'utilisateur AVANT de partir.
# 3. **Une ``HTTPException`` levée dans le travail n'est pas perdue.** Elle est
#    rangée telle quelle (code + message) et rendue par la relève : un 502
#    « le coach n'a pas répondu » doit rester un 502 « le coach n'a pas
#    répondu », pas devenir un 500 anonyme.
#
# Le registre est en MÉMOIRE, comme celui des sessions MC : un redémarrage le
# perd, et c'est assumé (la relève rend alors 404, le client relance).
# --------------------------------------------------------------------------- #

# {id: {"status", "created", "user", "result"?, "error"?, "code"?, "finished"?}}
_JOBS: Dict[str, Dict[str, Any]] = {}
_JOBS_LOCK = threading.Lock()

# Au-delà, un travail est soit fini et déjà lu, soit bloqué depuis longtemps.
# Purgé à chaque création — pas de tâche de fond à surveiller pour ça.
JOB_TTL_S = 30 * 60

JOB_PENDING = "pending"
JOB_DONE = "done"
JOB_ERROR = "error"

# Combien de travaux un même compte peut avoir EN COURS à la fois.
#
# Chaque travail détaché lance un appel au modèle, c'est-à-dire un SUBPROCESS
# du CLI Claude sur l'Omen — une machine de 15 Go qui fait déjà tourner le
# serveur, les conteneurs de jeu et les autres bots. En ligne, la requête HTTP
# servait de frein naturel : on ne pouvait pas en avoir plus d'un par onglet
# ouvert. Détaché, ce frein disparaît, et une boucle de relance côté client (ou
# six boutons cliqués de suite) en démarrerait autant qu'elle veut.
#
# Quatre suffit à couvrir l'usage réel (l'interface interdit déjà le double-clic
# sur un même bouton) et borne la casse. Au-delà : 429, avec un message qui dit
# quoi faire — attendre, pas réessayer.
MAX_PENDING_JOBS_PER_USER = 4

# Verrou des ÉCRITURES D'ÉTAT PARTAGÉ faites dans un travail.
#
# Avant ce lot, deux appels au modèle ne pouvaient pas se chevaucher : la
# requête HTTP les sérialisait de fait. Détachés, ils le peuvent — et trois de
# ces écritures sont des lire-modifier-réécrire SANS verrou
# (``idea_journal.append_entry``, ``radar.save_state``, ``board``) : deux
# travaux qui finissent en même temps, et l'un écrase l'entrée de l'autre.
#
# Pire, ``idea_journal.append_entry`` nomme son fichier temporaire d'après le
# PID SEUL : deux fils du même processus écrivent dans le MÊME temporaire, et
# l'un le renomme pendant que l'autre y écrit encore. Ce n'est plus une entrée
# perdue, c'est un journal corrompu.
#
# Le verrou ne couvre QUE l'écriture (millisecondes), jamais l'appel au modèle
# (une minute et demie) : deux travaux restent parallèles là où ça compte.
#
# ``RLock`` et non ``Lock`` : ces écrivains s'appellent entre eux
# (``_sync_coach`` -> ``_append_journal``, ``_sync_coach`` -> ``_safe_bias_note``).
# Avec un verrou simple, protéger le gros bloc ferait s'auto-bloquer le petit —
# un interblocage qui ne se manifesterait qu'au premier jalon atteint, donc
# jamais en test et toujours en production.
_WRITE_LOCK = threading.RLock()

# Verrou SÉPARÉ pour la collecte des dossiers historiques : elle fait du RÉSEAU
# (plusieurs secondes) avant d'écrire son état, et la mettre sous ``_WRITE_LOCK``
# sérialiserait les travaux pendant tout ce temps. Deux verrous distincts, jamais
# imbriqués — donc aucun interblocage possible.
_BACKFILL_LOCK = threading.Lock()


def _purge_jobs(now: float) -> None:
    """Retire les travaux périmés. À appeler VERROU TENU.

    Purge sur la date de CRÉATION, quel que soit le statut : un travail encore
    ``pending`` après trente minutes n'attend plus rien (l'appel au modèle dure
    une minute et demie), il est bloqué. Le fil qui finirait quand même ne
    ressuscite pas son entrée — ``_finish_job`` ne réécrit que ce qui existe.
    """
    dead = [key for key, job in _JOBS.items()
            if now - float(job.get("created") or 0) > JOB_TTL_S]
    for key in dead:
        _JOBS.pop(key, None)


def _finish_job(job_id: str, outcome: Dict[str, Any]) -> None:
    """Range le résultat — sauf si le travail a été purgé entre-temps."""
    with _JOBS_LOCK:
        job = _JOBS.get(job_id)
        if job is None:
            return
        job.update(outcome)
        job["finished"] = time.time()


def _run_job(job_id: str, work: Callable[[], Any]) -> None:
    """Exécute le travail et range son résultat. N'EXPLOSE JAMAIS : une
    exception qui remonterait d'un fil ne serait vue de personne, et le travail
    resterait ``pending`` à vie."""
    try:
        outcome = {"status": JOB_DONE, "result": work()}
    except HTTPException as e:                      # 502 LLM, 400 métier, 404…
        outcome = {"status": JOB_ERROR, "error": str(e.detail)[:300],
                   "code": e.status_code}
    except Exception as e:                          # noqa: BLE001 — jamais fatal
        logger.exception("paper: travail %s en échec", job_id)
        outcome = {"status": JOB_ERROR, "error": str(e)[:300], "code": 500}
    _finish_job(job_id, outcome)


def _start_job(username: str, work: Callable[[], Any]) -> Dict[str, str]:
    """Détache ``work`` et rend l'accusé ``{"job": id}``.

    ``username`` est le PROPRIÉTAIRE : la relève n'appartient qu'à lui. Les
    identifiants sont déjà imprévisibles, mais le résultat porte un
    portefeuille — deux verrous valent mieux qu'un.

    Au-delà de ``MAX_PENDING_JOBS_PER_USER`` travaux en cours pour ce compte :
    429. La purge tourne AVANT le décompte, donc un travail bloqué depuis une
    demi-heure ne peut pas condamner le compte à vie.
    """
    job_id = uuid.uuid4().hex
    with _JOBS_LOCK:
        _purge_jobs(time.time())
        pending = sum(1 for job in _JOBS.values()
                      if job.get("user") == username
                      and job.get("status") == JOB_PENDING)
        if pending >= MAX_PENDING_JOBS_PER_USER:
            raise HTTPException(
                status_code=429,
                detail="Trop d'analyses en cours (%d). Attends qu'elles "
                       "finissent avant d'en lancer une autre."
                       % MAX_PENDING_JOBS_PER_USER)
        _JOBS[job_id] = {"status": JOB_PENDING, "created": time.time(),
                         "user": username}
    threading.Thread(target=_run_job, args=(job_id, work), daemon=True,
                     name="paper-job-%s" % job_id[:8]).start()
    return {"job": job_id}


def _job_or_sync(sync: Any, username: str,
                 work: Callable[[], Any]) -> Dict[str, Any]:
    """Le branchement des six endpoints : détaché par DÉFAUT, en ligne sur
    ``?sync=1``.

    Le mode en ligne n'est pas là pour décorer : c'est la porte de sortie des
    tests (qui n'ont rien à gagner à tourner un fil pour un LLM doublé) et
    d'un client qui préfère attendre.
    """
    return work() if sync else _start_job(username, work)


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


def _clean_choice(value: Optional[str], whitelist: tuple, field_label: str) -> str:
    """Une valeur de whitelist FERMÉE, optionnelle (LOT 2, B2/B3) : vide/absente
    -> ``""`` ; sinon DOIT être dans ``whitelist``, sinon 400 — même politique
    que ``fee_profile`` un peu plus bas dans ce fichier. Un ``setup``/une
    ``emotion`` inconnus ne sont jamais silencieusement ignorés : ce serait
    laisser croire au client que le tag a été posé."""
    text = str(value or "").strip()
    if not text:
        return ""
    if text not in whitelist:
        raise HTTPException(status_code=400,
                            detail="%s inconnu: %s" % (field_label, text))
    return text


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
                  exit_reason: str = "manual",
                  emotion_close: str = "") -> Dict[str, Any]:
    """Exécute ``order`` au prix donné. MUTE ``portfolio``. Lève ``OrderError``.

    Rend le détail de l'exécution (``fill``) : montant, frais, et le ``Trade``
    produit quand l'ordre CLÔTURE tout ou partie d'une position.

    ``emotion_close`` (LOT 2, B3) ne s'applique qu'à une clôture (``sell``/
    ``cover``) — ignoré sans effet pour un ordre d'ouverture, jamais une
    erreur : un appelant générique n'a pas à connaître le sens de l'ordre pour
    le passer.
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
                           now_iso, exit_reason, emotion_close)
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
            target=order.target, risk_chf=order.risk_chf,
            setup=order.setup, emotion=order.emotion,
            forced_warnings=list(order.forced_warnings)))
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
            target=order.target, risk_chf=order.risk_chf,
            setup=order.setup, emotion=order.emotion,
            forced_warnings=list(order.forced_warnings)))
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
    if order.setup:
        position.setup = order.setup
    if order.emotion:
        position.emotion = order.emotion
    if order.forced_warnings:
        # LOT 3, C3 — même geste que setup/emotion : le renfort le plus
        # récent qui a forcé des avertissements est celui qui compte.
        position.forced_warnings = list(order.forced_warnings)


def _close_leg(portfolio, order, price, fx_rate, notional, fee,
               now_iso, exit_reason, emotion_close: str = "") -> models.Trade:
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
        setup=position.setup,
        emotion=position.emotion,
        emotion_close=str(emotion_close or ""),
        forced_warnings=list(position.forced_warnings),
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
                   exit_reason: str = "manual",
                   emotion_close: str = "") -> Dict[str, Any]:
    """Clôture au marché — passe par le MÊME chemin que n'importe quel ordre.

    Un seul code d'exécution : une sortie déclenchée par un stop, par le
    dashboard ou par un ordre limite produit exactement le même ``Trade``.

    ``emotion_close`` (LOT 2, B3) : SEULE la clôture manuelle en pose une
    (``paper_close_position``) — un stop de protection ou un ordre limite qui
    se déclenche dans le tick n'en fournit jamais, ce qui laisse le champ vide
    par construction (une sortie mécanique n'a pas d'émotion).
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
    return execute_order(portfolio, order, price, fx_rate, now_iso, exit_reason,
                         emotion_close)


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


def _holding_days(entry_at: Any, exit_at: Any) -> Optional[float]:
    """Durée de détention en jours (flottant), ou ``None`` si l'une des deux
    dates est illisible — sert à choisir la fenêtre de bougies de
    ``tradestats.range_for`` (LOT 2, B1)."""
    entry_dt = _parse_iso(entry_at)
    exit_dt = _parse_iso(exit_at)
    if entry_dt is None or exit_dt is None:
        return None
    return (exit_dt - entry_dt).total_seconds() / 86400.0


def _attach_trade_extras(portfolio: models.Portfolio,
                         fill: Optional[Dict[str, Any]],
                         username: str = "") -> None:
    """MAE/MFE + « laissé sur la table » (LOT 2, B1/B5) + post-mortem
    AUTOMATIQUE (LOT 3, C1) sur le ``Trade`` qui vient de se clôturer —
    appelé aux QUATRE points qui en produisent un : l'ordre marché
    (achat/vente immédiats, y compris une vente qui clôture), le bouton
    Clore, et les deux boucles de ``run_tick`` (ordre limite/stop qui
    clôture, stop de protection). C'est le point UNIQUE, documenté, où ces
    quatre chemins convergent — le poser ici plutôt qu'aux quatre endroits
    est ce qui évite d'en oublier un.

    MUTE deux choses en parallèle : le ``Trade`` RÉEL (dernier de
    ``portfolio.trades`` — c'est lui qui sera persisté) ET le dict
    ``fill["trade"]`` déjà construit (c'est lui que la réponse HTTP renvoie)
    — sans les deux, le fichier sur disque et ce que l'écran affiche
    divergeraient.

    ``username`` est FACULTATIF (``""`` par défaut, compat les appels
    directs des tests qui n'en ont pas besoin) : vide, le post-mortem
    automatique est silencieusement sauté — jamais une exception.

    N'ÉCHOUE JAMAIS (best-effort autour de ``quotes.get_candles`` — invariant
    2 du module, cf. le docstring de tête) : un cours indisponible laisse
    simplement les champs MAE/MFE absents, la clôture elle-même a déjà eu
    lieu.
    """
    if not fill or not fill.get("trade") or not portfolio.trades:
        return

    # Post-mortem AUTOMATIQUE (LOT 3, C1) -- AVANT tout retour anticipé des
    # excursions ci-dessous : un cours Yahoo indisponible ne doit PAS priver
    # le trade de son post-mortem, ce sont deux enrichissements INDÉPENDANTS
    # du même Trade qui vient de se clôturer.
    _maybe_auto_postmortem(username, portfolio, fill)

    trade_dict = fill["trade"]
    trade_obj = portfolio.trades[-1]

    holding_days = _holding_days(trade_dict.get("entry_at"), trade_dict.get("exit_at"))
    try:
        range_, interval = tradestats.range_for(holding_days)
        candles = quotes.get_candles(trade_dict.get("symbol") or "", range_, interval)
        exc = tradestats.excursions(candles, trade_dict.get("entry_price"),
                                    trade_dict.get("side"))
    except Exception as e:                          # noqa: BLE001 - best-effort
        logger.warning("paper: excursions indisponibles pour %s: %s",
                       trade_dict.get("symbol"), type(e).__name__)
        return
    if not exc:
        return

    gap = tradestats.best_exit_gap(exc.get("mfe_pct"), trade_dict.get("pnl_pct"))

    trade_obj.mae_pct = exc.get("mae_pct")
    trade_obj.mfe_pct = exc.get("mfe_pct")
    trade_obj.best_exit_gap_pct = gap

    trade_dict.update(exc)
    trade_dict["best_exit_gap_pct"] = gap


def _postmortem_auto_allowed(username: str, today: str) -> bool:
    """Compte + autorise/refuse un post-mortem AUTOMATIQUE (LOT 3, C1) —
    :data:`MAX_AUTO_POSTMORTEMS_PER_DAY` par compte et par jour (le jour du
    SERVEUR, ``_now_iso()[:10]`` — même granularité simple que le reste du
    router, aucune finesse de fuseau ici).

    MUTE l'état SEULEMENT en cas d'acceptation : un refus ne consomme rien de
    plus (le compteur reste ce qu'il était). À appeler sous ``_WRITE_LOCK``
    (lire-modifier-réécrire, même précaution que ``_append_journal``)."""
    state = store.load_postmortem_auto(username)
    count = int(state.get("count") or 0) if state.get("date") == today else 0
    if count >= MAX_AUTO_POSTMORTEMS_PER_DAY:
        return False
    store.save_postmortem_auto(username, {"date": today, "count": count + 1})
    return True


def _maybe_auto_postmortem(username: str, portfolio: models.Portfolio,
                           fill: Dict[str, Any]) -> None:
    """Déclenche EN ARRIÈRE-PLAN le post-mortem du trade qui vient de se
    clôturer (LOT 3, C1) — best-effort TOTAL : ne lève JAMAIS, la clôture
    n'attend jamais (même doctrine que le reste de cette fonction).

    Réutilise le registre de travaux détachés (``_start_job``) et le CŒUR du
    bouton manuel « Post-mortem » (``_postmortem_core``) : c'est le MÊME
    prompt, le MÊME appel au modèle, la MÊME écriture au carnet — seul le
    DÉCLENCHEUR change. ``_postmortem_core`` (pas ``_postmortem_work``) parce
    que ce dernier RECHARGE le portefeuille depuis le disque, qui n'a pas
    encore été sauvegardé à cet instant (cf. son docstring) : le job capture
    ``portfolio``, l'objet EN MÉMOIRE de la requête en cours, par fermeture.

    ``fill`` gagne TOUJOURS la clé ``postmortem_job`` (id du travail, ou
    ``None`` si aucun n'a été lancé — pas de username, rafale du jour
    dépassée, ou erreur). Les DEUX endpoints manuels (ordre marché, bouton
    Clore) la font remonter au client, qui la sonde via l'infra existante
    pour afficher un toast quand c'est prêt. Les fills MÉCANIQUES du tick
    (stop, ordre limite/stop qui clôture) la reçoivent aussi, mais personne
    ne la sonde côté client : le travail s'écrit au carnet en silence, ce qui
    est le comportement voulu (cf. mission — pas de toast pour un fill que
    personne ne regarde en direct).
    """
    fill["postmortem_job"] = None
    if not username or not portfolio.trades:
        return
    try:
        today = _now_iso()[:10]
        with _WRITE_LOCK:
            if not _postmortem_auto_allowed(username, today):
                return
        index = len(portfolio.trades) - 1
        job = _start_job(username,
                         lambda: _postmortem_core(username, portfolio, index, "fr"))
        fill["postmortem_job"] = job.get("job")
    except Exception as e:                      # noqa: BLE001 — jamais fatal
        logger.warning("paper: post-mortem automatique non déclenché (%s): %s",
                       username, type(e).__name__)


def run_tick(portfolio: models.Portfolio, now_iso: str,
             fetch_candles: Callable[[str], List[Dict[str, Any]]],
             fetch_fx: Callable[[str], float],
             username: str = "") -> Dict[str, List[Dict[str, Any]]]:
    """Confronte les ordres ouverts et les stops aux bougies récentes.

    Ne lève JAMAIS : un symbole en panne est consigné dans ``errors`` et les
    autres continuent (invariant 2). Un ordre devenu infaisable (la trésorerie a
    fondu entre-temps) est ANNULÉ, pas exécuté à découvert.

    ``username`` (LOT 3, C1, facultatif) — transmis à ``_attach_trade_extras``
    pour le post-mortem automatique : un ordre limite/stop qui clôture ou un
    stop de protection qui saute PENDANT LA NUIT sont exactement les fills
    qu'un post-mortem silencieux sert le mieux (personne n'est là pour
    cliquer le bouton). Vide -> aucun déclenché, jamais une exception.
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
                _attach_trade_extras(portfolio, fill, username)
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
                fill = close_position(portfolio, position, position.qty,
                                      exit_price, fx_rate, now_iso, "stop")
            except OrderError as e:
                errors.append({"symbol": position.symbol, "error": str(e)})
            else:
                _attach_trade_extras(portfolio, fill, username)
                stopped.append(fill)
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

    Sous ``_WRITE_LOCK`` (réentrant : ce corps appelle ``_append_journal`` et
    ``_safe_bias_note``, qui le prennent aussi) — c'est un lire-modifier-
    réécrire du profil, et deux travaux détachés commencent tous les deux par
    un ``force=True``.
    """
    with _WRITE_LOCK:
        return _sync_coach_locked(username, portfolio, now_iso, force)


def _sync_coach_locked(username: str, portfolio: Dict[str, Any],
                       now_iso: Optional[str], force: bool) -> Dict[str, Any]:
    """Le corps de ``_sync_coach``, VERROU TENU."""
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
    jamais faire échouer la réponse HTTP qu'il documente.

    Sous ``_WRITE_LOCK`` : deux travaux détachés peuvent finir en même temps.
    """
    try:
        with _WRITE_LOCK:
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
        # Carnet PARTAGÉ -> deux traders peuvent y écrire en même temps, et
        # depuis ce lot deux travaux d'un même trader aussi.
        with _WRITE_LOCK:
            store.append_note(username, "Discussions.md", entry)
    except (ValueError, OSError) as e:
        logger.warning("paper: discussion non persistée: %s", e)


# --------------------------------------------------------------------------- #
# Compte de paper trading DU COACH (LOT 4)
#
# Le coach cesse d'être un commentateur : il reçoit SES 10 000 CHF fictifs, les
# mêmes frais et le même moteur d'ordres qu'un humain, et il trade lui-même. Le
# but est de MESURER ce qu'il annonce et de VOIR COMMENT il fait.
#
# Le mandat (ce qu'il a le droit de faire) est PUR et vit dans
# ``paper.coach_trader`` ; ce qui vit ici, c'est l'ORCHESTRATION : le cours à
# aller chercher, la conversion en francs, le moteur d'ordres, le registre, le
# carnet.
#
# ⚠️ Le mot d'ordre du registre : **on n'invente jamais un ordre, et on
# n'efface jamais un refus.** Un registre qui ne garderait que les ordres
# passés montrerait un coach irréprochable et cacherait tout ce que le mandat
# a empêché.
# --------------------------------------------------------------------------- #
COACH_DISPLAY = "Coach"

# Ce que dit le registre quand le coach a délibérément choisi de ne rien faire
# ET n'a laissé aucune raison exploitable (``note`` absente/vide, LOT 4bis) —
# le repli générique historique. Son inaction doit être un CHOIX visible,
# jamais un silence : sans cette ligne, une soirée sans décision et une soirée
# où la passe n'a pas tourné se ressembleraient à l'écran.
COACH_HOLD_DETAIL = "aucune action : le coach a choisi de ne rien changer"

# Le nombre de tickers DISTINCTS des hypothèses radar ouvertes dont le coach
# reçoit le cours (LOT 4bis, ``_coach_candidates``). Même ordre de grandeur
# que ``MAX_POSITIONS_IN_PROMPT``/``radar.MAX_OPEN`` : assez pour couvrir tout
# ce que le radar suit activement, borné pour ne pas facturer un cours par
# ticker jamais retenu par une hypothèse morte.
MAX_COACH_CANDIDATES = 10


def _num(value: Any) -> Optional[float]:
    """Nombre flottant, ou ``None`` (un booléen n'est jamais un nombre) —
    même coercition tolérante que ``risk._val``/``coach_trader._val``."""
    if value is None or isinstance(value, bool):
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _ensure_coach_account() -> models.Portfolio:
    """Le portefeuille du coach, créé au premier besoin.

    ``coach_trader.COACH_USERNAME`` est un nom **RÉSERVÉ** : aucun compte
    d'authentification ne porte ce nom (il n'est ni dans ``users`` ni
    inscriptible), et pourtant le fichier ``coach.json`` est un portefeuille
    tout à fait ordinaire — c'est voulu.

    **Ses positions sont PUBLIQUES par design**, contrairement à celles des
    humains (strictement privées) : tout l'intérêt du lot est de le REGARDER
    FAIRE. Il est donc recensé comme un vrai compte par
    ``radar._users_with_portfolio`` et ``store._is_real_account``, et il
    apparaît dans ``/api/paper/community`` dès qu'il a un carnet.

    Créé avec ``coach_trader.COACH_CAPITAL`` en trésorerie ET en capital
    initial — les mêmes 10 000 CHF qu'un humain, sans quoi la comparaison de
    performance ne voudrait rien dire — puis persisté tout de suite : un compte
    qui n'existerait qu'en mémoire disparaîtrait au premier redémarrage.
    """
    username = coach_trader.COACH_USERNAME
    raw = store.load_portfolio(username)
    if raw is not None:
        return models.Portfolio.from_dict(raw)
    portfolio = new_portfolio(coach_trader.COACH_CAPITAL, None, _now_iso())
    _save(username, portfolio)
    return portfolio


def _coach_quote(symbol: str) -> Optional[Dict[str, Any]]:
    """``{"price", "currency", "fx_rate"}`` pour le garde-fou, ou ``None``.

    ``coach_trader.gate_decision`` est PUR : **la conversion en CHF est la
    responsabilité de l'appelant**, c'est-à-dire d'ici. On résout donc le
    cours ET le taux du jour, et on les passe ensemble — un seul taux pour
    toute l'opération (invariant du module, cf. tête de fichier).

    ``None`` sur toute panne de cours : sans prix ni taux valides, aucun
    contrôle de taille n'a de sens, et refuser vaut mieux que calculer sur un
    chiffre inventé.
    """
    try:
        quote = quotes.get_quote(symbol)
        currency = quote.get("currency") or models.DEFAULT_CURRENCY
        rate = quotes.fx_to_chf(currency)
    except quotes.QuoteError:          # ``UnknownSymbol`` en hérite
        return None
    price = _num(quote.get("price"))
    rate = _num(rate)
    if price is None or price <= 0 or rate is None or rate <= 0:
        return None
    return {"price": price, "currency": currency, "fx_rate": rate}


def _coach_candidate_symbols(hypotheses: Any) -> List[str]:
    """Tickers DISTINCTS des hypothèses radar reçues, dans l'ordre où ils
    apparaissent (PUR — aucun réseau), plafonnés à
    :data:`MAX_COACH_CANDIDATES`.

    Appelée avec des hypothèses déjà filtrées OUVERTES
    (``_open_radar_hypotheses``) : ce filtre-ci ne fait QUE dédoublonner et
    canoniser, il ne relit pas le statut."""
    seen: List[str] = []
    for hyp in hypotheses or []:
        if not isinstance(hyp, dict):
            continue
        # LOT 5 — les tickers que le marché ne connaît pas (``radar.mark_
        # unquoted``, posé à la NAISSANCE de l'hypothèse) sont sautés. Vécu :
        # « SAP.TO » n'existe pas chez Yahoo ; il entrait dans l'univers du
        # coach, y prenait une place et sa cotation échouait à chaque passe,
        # en silence. L'hypothèse, elle, RESTE — c'est son ticker de mesure
        # qui est faux, pas forcément sa thèse.
        muets = {quotes.canonical(t)
                 for t in (hyp.get("unquoted") or []) if isinstance(t, str)}
        for ticker in hyp.get("tickers") or []:
            symbol = quotes.canonical(ticker) if isinstance(ticker, str) else ""
            if not symbol or symbol in seen or symbol in muets:
                continue
            seen.append(symbol)
            if len(seen) >= MAX_COACH_CANDIDATES:
                return seen
    return seen


def _coach_candidates(hypotheses: Any) -> List[Dict[str, Any]]:
    """Le cours ACTUEL, converti en CHF, de chaque candidat des hypothèses
    radar OUVERTES — un par ticker DISTINCT (:func:`_coach_candidate_symbols`).

    Vécu en prod (2026-08-28) : sans lui, le coach n'a AUCUN prix hors de ce
    qu'il détient déjà — ``positions``/``coach_book`` ne cotent QUE
    l'existant, et un livre neuf ou vide n'a alors RIEN à dimensionner. Trois
    passes de suite se sont terminées sur la même raison honnête : « il me
    faut le cours actuel du titre pour fixer un stop technique et une taille
    cohérente avec le risque à 2 % ». Il était affamé de données, pas timide.

    Best-effort PAR SYMBOLE (même doctrine que ``_coach_quote``) : une panne
    de cours OMET le candidat plutôt que de lever ou d'inventer un prix, et un
    symbole qui plante N'EMPÊCHE PAS les suivants d'être cotés.
    """
    out: List[Dict[str, Any]] = []
    for symbol in _coach_candidate_symbols(hypotheses):
        try:
            quote = _coach_quote(symbol)
        except Exception as e:                  # noqa: BLE001 — jamais fatal
            logger.warning("paper coach: cours candidat indisponible pour %s (%s)",
                           symbol, type(e).__name__)
            continue
        if quote is None:
            continue
        out.append({
            "symbol": symbol,
            "price_chf": round(quote["price"] * quote["fx_rate"], 2),
            "currency": quote["currency"],
            # LOT 5 — le cours seul ne permet pas de POSER un stop : il faut
            # un niveau. Absent (``None``) quand les bougies manquent, jamais
            # inventé.
            "technical": _coach_technical(symbol),
        })
    return out


def _coach_technical(symbol: str) -> Optional[Dict[str, Any]]:
    """L'analyse technique d'un titre, prête pour le prompt (LOT 5).

    Vécu en prod : le coach a refusé d'entrer faute d'« un niveau technique
    fiable pour poser un stop ». Il avait le cours et rien d'autre — impossible
    de nommer un support, impossible de dire si un stop à 3 % est serré ou
    large sur CE titre. ``ta.technical_summary`` lui donne les moyennes, le
    RSI, l'ATR et les extrêmes de 52 semaines ; l'ATR à lui seul répond à la
    question « quelle distance de stop a un sens ici ».

    Une année de bougies quotidiennes : c'est le minimum pour que la moyenne
    200 existe (en dessous, ``ta`` rend ``None`` plutôt qu'un chiffre faux).

    Best-effort STRICT : bougies en panne -> ``None``, jamais une exception et
    jamais une valeur inventée. Le coach décidera sans, il décidera juste
    moins bien — c'est très exactement ce que ce lot cherche à réduire, mais
    une panne de Yahoo ne doit pas faire tomber toute la passe.
    """
    try:
        candles = quotes.get_candles(symbol, TECHNICAL_RANGE, TECHNICAL_INTERVAL)
    except Exception as e:                      # noqa: BLE001 — jamais fatal
        logger.warning("paper coach: bougies indisponibles pour %s (%s)",
                       symbol, type(e).__name__)
        return None
    try:
        summary = ta.technical_summary(candles)
    except Exception as e:                      # noqa: BLE001 — jamais fatal
        logger.warning("paper coach: analyse technique illisible pour %s (%s)",
                       symbol, type(e).__name__)
        return None
    # Une série trop courte rend toutes les clés à ``None`` : mieux vaut ne
    # rien montrer qu'un bloc de douze « null » qui occupe le prompt sans rien
    # dire.
    if not any(value is not None for value in summary.values()):
        return None
    return summary


def _coach_equity_chf(portfolio: models.Portfolio) -> float:
    """Équité au PRIX DE REVIENT : trésorerie + lignes longues − lignes
    courtes. Le cash porte DÉJÀ le produit d'une vente à découvert : la ligne
    courte est une DETTE de rachat, l'additionner la compterait deux fois
    (vécu 30/08 : tuile Patrimonio à +41 % un week-end, marchés fermés)."""
    return (portfolio.cash_chf + _positions_value_chf(portfolio, "long")
            - _positions_value_chf(portfolio, "short"))


def _coach_reject_detail(code: str, decision: Dict[str, Any],
                         portfolio: models.Portfolio,
                         quote: Optional[Dict[str, Any]]) -> Optional[str]:
    """La phrase LISIBLE et CHIFFRÉE qui accompagne un code de refus.

    Le code (``oversize``) dit CE QUI a été violé ; ce détail dit DE COMBIEN.
    C'est lui que l'écran affichera sous le refus — « voulait 4200.00 CHF, 42 %
    de l'équité » enseigne quelque chose, « oversize » tout seul n'enseigne
    rien. Best-effort : un détail illisible ne doit jamais empêcher le refus
    d'être consigné, d'où le ``None`` de repli.
    """
    try:
        symbol = str(decision.get("symbol") or "") or "?"
        qty = _num(decision.get("qty"))
        equity = _coach_equity_chf(portfolio)
        level = None
        if quote:
            level = float(quote["price"]) * float(quote["fx_rate"])
        # La ligne du symbole, QUEL QUE SOIT son sens (LOT 5) : le moteur
        # interdit de tenir les deux, « la première » est donc « la seule ».
        held = _find_position(portfolio, symbol)
        held_qty = float(held.qty) if held is not None else 0.0
        value = None if (level is None or qty is None) else qty * level

        if code == "unknown_action":
            return "action inconnue : %s" % (str(decision.get("action") or "")
                                             or "(absente)")
        if code == "no_symbol":
            return "aucun symbole"
        if code == "bad_qty":
            return "quantité illisible : %s" % (decision.get("qty"),)
        if code == "no_quote":
            return "aucun cours exploitable pour %s" % symbol
        if code == "no_thesis":
            return ("thèse de %d caractères (minimum %d)"
                    % (len(str(decision.get("thesis") or "").strip()),
                       coach_trader.MIN_THESIS_LEN))
        if code == "no_stop":
            stop = _num(decision.get("stop"))
            if stop is None:
                return "aucun stop"
            # Le stop d'un long s'attend SOUS le cours, celui d'un short
            # AU-DESSUS : nommer le mauvais côté serait pire que se taire.
            sens = str(decision.get("action") or "").strip().lower()
            if held is not None:
                sens = held.side
            attendu = "au-dessus" if sens in ("short", "cover") else "sous"
            return ("stop %.2f du mauvais côté du cours %.2f — on l'attend %s, "
                    "il ne protège rien"
                    % (stop, quote["price"] if quote else 0.0, attendu))
        if code == "wrong_side":
            tenu = held.side if held is not None else "?"
            return ("une position %s est déjà ouverte sur %s — il faut d'abord "
                    "la solder" % (tenu, symbol))
        if code == "stop_widen":
            stop = _num(decision.get("stop"))
            actuel = held.stop_loss if held is not None else None
            return ("stop %.2f plus loin que le %.2f en place — un stop ne se "
                    "desserre pas"
                    % (stop or 0.0, actuel if actuel is not None else 0.0))
        if code == "market_closed":
            return ("%s ne s'échange pas ce jour-là — seules les cryptos cotent "
                    "le week-end" % symbol)
        if code == "risk_high":
            stop = _num(decision.get("stop"))
            risk_chf = (abs(level - stop * float(quote["fx_rate"])) * qty
                        if (level is not None and stop is not None
                            and qty is not None) else 0.0)
            return ("risque %.2f CHF, %.1f%% de l'équité (plafond %.0f%%)"
                    % (risk_chf, _pct_of(risk_chf, equity),
                       coach_trader.MAX_RISK_PCT))
        if code == "too_small":
            return ("%.2f CHF, sous le plancher de %.0f%%"
                    % (value or 0.0, coach_trader.MIN_POSITION_PCT))
        if code == "oversize":
            projected = ((held_qty + (qty or 0.0)) * level) if level else 0.0
            return ("voulait %.2f CHF, %.0f%% de l'équité (plafond %.0f%%)"
                    % (projected, _pct_of(projected, equity),
                       coach_trader.MAX_POSITION_PCT))
        if code == "too_many_positions":
            return ("%d lignes déjà ouvertes (plafond %d)"
                    % (len(portfolio.positions), coach_trader.MAX_POSITIONS))
        if code == "too_many_crypto":
            return "plafond de %d cryptos atteint" % coach_trader.MAX_CRYPTO
        if code == "cash_floor":
            left = portfolio.cash_chf - (value or 0.0)
            floor = equity * coach_trader.MIN_CASH_PCT / 100.0
            return ("resterait %.2f CHF, sous le plancher de %.0f%% (%.2f CHF)"
                    % (left, coach_trader.MIN_CASH_PCT, floor))
        if code == "no_position":
            return "aucune position sur %s" % symbol
        if code == "qty_over_position":
            return "%d demandés, %d détenus" % (int(qty or 0), int(held_qty))
    except Exception as e:                  # noqa: BLE001 — jamais fatal
        logger.warning("paper coach: détail de refus illisible (%s)",
                       type(e).__name__)
    return None


def _pct_of(value: float, total: float) -> float:
    return (value / total * 100.0) if total else 0.0


def _coach_journal_entry(order: models.Order, fill: Dict[str, Any],
                         source: str) -> Any:
    """Le titre et le corps de l'entrée de carnet d'une décision EXÉCUTÉE.

    C'est la trace lisible de « comment il fait » — et accessoirement ce qui
    donne un carnet au coach, donc sa présence dans la communauté."""
    verb = "achat" if order.side == "buy" else "vente"
    lines = ["%d x %s @ %.2f %s (%s)"
             % (order.qty, order.symbol, float(fill.get("price") or 0.0),
                order.currency, source)]
    if order.thesis:
        lines.append("Thèse : %s" % order.thesis)
    if order.stop_loss is not None:
        lines.append("Stop : %.2f" % order.stop_loss)
    if order.target is not None:
        lines.append("Objectif : %.2f" % order.target)
    if order.forced_warnings:
        lines.append("Avertissements consignés : %s"
                     % ", ".join(order.forced_warnings))
    return ("%s %s" % (verb, order.symbol), "\n\n".join(lines))


def _push_coach_ledger(entries: List[Dict[str, Any]]) -> None:
    """Archive les lignes de registre, la plus récente en tête. Best-effort :
    un registre en échec ne doit pas défaire un ordre déjà exécuté."""
    try:
        rows = store.load_ledger(coach_trader.COACH_USERNAME)
        for entry in entries:
            rows = coach_trader.push_ledger(rows, entry)
        store.save_ledger(coach_trader.COACH_USERNAME, rows)
    except (ValueError, OSError) as e:
        logger.warning("paper coach: registre non persisté: %s", e)


def _coach_execute_one(portfolio: models.Portfolio, action: Dict[str, Any],
                       source: str, now_iso: str,
                       crypto_only: bool = False) -> Any:
    """UNE décision : cours -> garde-fou -> moteur d'ordres.

    Rend ``(entrée_de_registre, (titre, corps)|None)``. MUTE ``portfolio``
    seulement si la décision est acceptée ET exécutée.
    """
    raw = action.get("symbol")
    symbol = quotes.canonical(raw) if isinstance(raw, str) else ""
    kind = str(action.get("action") or "").strip().lower()
    decision = dict(action)
    if symbol:
        # Le symbole CANONIQUE, jamais un alias : sinon les consommateurs en
        # aval (veille par symbole, graphe, dossiers) verraient deux identités
        # pour le même titre (même geste que ``paper_place_order``).
        decision["symbol"] = symbol

    quote = _coach_quote(symbol) if symbol else None
    if symbol and quote is None:
        return (coach_trader.ledger_entry(
            now_iso, source, kind, symbol, False, reason="no_quote",
            detail="aucun cours exploitable pour %s" % symbol), None)

    verdict = coach_trader.gate_decision(decision, portfolio.to_dict(),
                                         quote or {}, crypto_only=crypto_only)
    if not verdict.get("accepted"):
        code = str(verdict.get("reason") or "")
        return (coach_trader.ledger_entry(
            now_iso, source, kind, symbol, False, reason=code,
            detail=_coach_reject_detail(code, decision, portfolio, quote)), None)

    plan = verdict.get("order") or {}
    price = float(quote["price"])
    fx_rate = float(quote["fx_rate"])
    qty = int(plan.get("qty") or 0)

    # ``adjust_stop`` (LOT 5) n'est PAS un ordre : rien ne s'échange, aucune
    # trésorerie ne bouge, aucun trade ne naît. Il repose le niveau
    # d'invalidation de la ligne — et c'est ce qui rend tenable la consigne
    # « laisse courir les gagnants » : sans lui, la seule façon de protéger un
    # gain serait de solder la position, exactement ce qu'on lui reproche.
    if plan.get("side") == "adjust_stop":
        return (_coach_move_stop(portfolio, symbol, plan, source, now_iso), None)

    order = models.Order(
        id=uuid.uuid4().hex,
        symbol=plan.get("symbol") or symbol,
        side=plan.get("side") or "buy",
        kind="market",
        qty=qty,
        created_at=now_iso,
        status="open",
        thesis=str(plan.get("thesis") or ""),
        stop_loss=plan.get("stop_loss"),
        target=plan.get("target"),
        risk_chf=planned_risk_chf(price, plan.get("stop_loss"), qty, fx_rate),
        currency=quote["currency"],
        fee_profile=portfolio.fee_profile,
        setup=str(plan.get("setup") or ""),
        emotion=str(plan.get("emotion") or ""),
    )

    # ⚠️ La porte de confirmation N'EST PAS contournée, elle est CONSIGNÉE.
    # ``needs_confirm`` est une pause d'INTERFACE, destinée à un humain devant
    # un formulaire — il n'y a personne à qui poser la question ici. Et le
    # coach vient de franchir un garde-fou PLUS STRICT que celle-ci
    # (``gate_decision`` REFUSE là où ``preorder_warnings`` se contente
    # d'avertir : 30 % contre 25 % sur la taille, et un stop est OBLIGATOIRE).
    # Les avertissements sont donc posés sur l'ordre — exactement comme pour un
    # humain qui confirme — et suivent la chaîne jusqu'au ``Trade`` clos.
    order.forced_warnings = risk.preorder_warnings(
        {"side": order.side, "symbol": order.symbol, "thesis": order.thesis,
         "stop_loss": order.stop_loss, "target": order.target, "qty": order.qty},
        portfolio.to_dict(), price * fx_rate)

    try:
        fill = execute_order(portfolio, order, price, fx_rate, now_iso, "coach")
    except OrderError as e:
        # Refus du MOTEUR (trésorerie ou marge réelle, frais compris), pas du
        # mandat : le garde-fou est conservateur (il ignore les frais, cf.
        # ``coach_trader``), le moteur a le dernier mot.
        return (coach_trader.ledger_entry(
            now_iso, source, kind, symbol, False, reason="engine",
            detail=str(e)[:200]), None)

    order.status = "filled"
    _attach_trade_extras(portfolio, fill, coach_trader.COACH_USERNAME)

    # --- l'objectif, rendu EXÉCUTABLE ------------------------------------ #
    # ``fills.check_protective_stops`` ne connaît QUE ``stop_loss`` : un
    # ``target`` posé sur une Position n'est JAMAIS exécuté mécaniquement.
    # C'est cet ordre limite en attente qui rend l'objectif réel — et c'est la
    # PREMIÈRE boucle de ``run_tick`` qui le déclenchera. Si le stop part
    # d'abord, la position n'existe plus : l'ordre échouera proprement en
    # ``cancelled`` au tick suivant (comportement déjà géré par ``run_tick``).
    #
    # ⚠️ Le sens du RETOUR dépend de celui de l'aller (LOT 5) : l'objectif
    # d'une vente à découvert se prend en RACHETANT sous le prix. Poser un
    # ``sell`` de plus doublerait l'exposition au lieu de la fermer — et il
    # serait refusé, faute de ligne longue à vendre.
    target = _num(plan.get("target"))
    if order.side in ("buy", "short") and target is not None and target > 0:
        portfolio.open_orders.append(models.Order(
            id=uuid.uuid4().hex,
            symbol=order.symbol,
            side=("sell" if order.side == "buy" else "cover"),
            kind="limit",
            qty=qty,
            limit_price=target,
            created_at=now_iso,
            status="open",
            thesis=order.thesis,
            currency=order.currency,
            fee_profile=portfolio.fee_profile,
        ))

    entry = coach_trader.ledger_entry(
        now_iso, source, kind, order.symbol, True,
        detail="%d x %.2f %s" % (qty, price, order.currency))
    return entry, _coach_journal_entry(order, fill, source)


def _coach_move_stop(portfolio: models.Portfolio, symbol: str,
                     plan: Dict[str, Any], source: str,
                     now_iso: str) -> Dict[str, Any]:
    """Repose le stop d'une ligne ouverte. MUTE ``portfolio``.

    Le garde-fou a DÉJÀ tranché (:func:`coach_trader._gate_adjust_stop`) : le
    niveau est du bon côté du cours et il RESSERRE. Il ne reste qu'à l'écrire
    là où il agira — dans la position elle-même, que ``fills.check_protective_
    stops`` relira au prochain tick. Un stop qui ne vivrait qu'au registre
    serait une décision affichée mais jamais appliquée.

    Rend une ligne de registre ; ``None`` de position (course entre la
    validation et l'écriture) redevient un refus honnête plutôt qu'un succès
    silencieux.
    """
    stop = _num(plan.get("stop_loss"))
    position = _find_position(portfolio, symbol)
    if position is None or stop is None:
        return coach_trader.ledger_entry(
            now_iso, source, "adjust_stop", symbol, False, reason="no_position",
            detail="aucune position sur %s" % symbol)

    ancien = position.stop_loss
    position.stop_loss = stop
    detail = ("stop %.2f -> %.2f" % (ancien, stop) if ancien is not None
              else "stop posé à %.2f (la ligne n'en avait aucun)" % stop)
    return coach_trader.ledger_entry(now_iso, source, "adjust_stop", symbol,
                                     True, detail=detail)


def _clean_coach_note(value: Any) -> Optional[str]:
    """Le ``note`` du coach, texte propre ou ``None`` — TOLÉRANT (PUR).

    Même doctrine que ``coach_trader._note_of`` (qui l'a déjà nettoyé une
    première fois côté parseur) : un type inattendu ou une chaîne vide/blanche
    ne doit JAMAIS lever ici, et ne dit rien de plus qu'une absence. Cette
    fonction-ci est la SECONDE ligne de défense — ``execute_coach_actions``
    est une API publique que d'autres appelants (tests, une tâche future)
    peuvent nourrir directement, sans repasser par le parseur.
    """
    if not isinstance(value, str):
        return None
    text = value.strip()
    return text or None


def execute_coach_actions(actions: Any, source: str = "digest",
                          now_iso: Optional[str] = None,
                          parse_error: Any = None,
                          note: Any = None,
                          crypto_only: bool = False,
                          **_ignored: Any) -> List[Dict[str, Any]]:
    """Exécute les décisions du coach. Rend les lignes de registre produites.

    **NE LÈVE JAMAIS** (best-effort TOTAL) : elle est appelée depuis un cycle
    de veille ET depuis la couche de convergence — ni l'un ni l'autre ne doit
    tomber parce que le compte du coach a hoqueté.

    ``**_ignored`` est délibéré : l'appelant convergence peut lui passer des
    mots-clés qu'elle ne connaît pas encore (un ``trigger``, une langue), et
    une signature trop stricte transformerait un ajout anodin en panne.

    ``note`` (LOT 4bis) est le champ de tête FACULTATIF du bloc ``COACH_
    ACTIONS`` (``coach_trader.parse_actions``/``convergence._parse_coach_
    actions`` en sont les producteurs) — TOLÉRANT (:func:`_clean_coach_note`) :
    absent, vide ou mal typé compte comme aucune note.

    Trois cas, dans cet ordre :

    1. ``parse_error`` non nul -> UNE ligne ``action="parse"`` et rien d'autre,
       ``note`` IGNORÉE. **On n'invente jamais un ordre** : un bloc absent ou
       illisible ne se rattrape pas en devinant des intentions dans la prose,
       et une panne n'a rien à voir avec une lecture de marché.
    2. aucune action, aucune erreur -> UNE ligne ``action="hold"``,
       ``accepted=True``. C'est le SEUL cas où une ligne acceptée ne
       correspond pas à un ordre passé : le modèle a répondu et a choisi de ne
       rien changer, et ce choix doit se VOIR (une panne, elle, a déjà sa
       ligne ``parse`` — les deux ne doivent pas se confondre à l'écran).
       ⚠️ Vécu en prod : le coach a enchaîné deux passes ``hold`` dont le
       registre n'archivait que la phrase générique — sa vraie raison,
       écrite dans ``note``, était perdue. Elle devient désormais le
       ``detail`` de cette ligne (repli sur :data:`COACH_HOLD_DETAIL` si
       ``note`` est absente/vide).
    3. sinon, chaque décision passe par le cours, le garde-fou, puis le moteur
       d'ordres. Un refus n'interrompt jamais la suivante. Si ``note`` est
       fournie, UNE ligne D'ACCOMPAGNEMENT ``action="note"`` (``accepted=
       True``, ``detail=note``) est ajoutée EN PLUS des lignes d'actions —
       choix ARGUMENTÉ plutôt que de poser la note sur le ``detail`` de la
       1ʳᵉ ligne, qui écraserait un contenu déjà signifiant (« 15 x 100.00
       CHF » pour un ordre exécuté, ou le motif chiffré d'un refus).
    """
    try:
        return _execute_coach_actions_locked(actions, source, now_iso,
                                             parse_error,
                                             _clean_coach_note(note),
                                             bool(crypto_only))
    except Exception as e:                  # noqa: BLE001 — jamais fatal
        logger.exception("paper coach: exécution des décisions en échec (%s)",
                         type(e).__name__)
        return []


def _execute_coach_actions_locked(actions: Any, source: str,
                                  now_iso: Optional[str],
                                  parse_error: Any,
                                  note: Optional[str],
                                  crypto_only: bool = False
                                  ) -> List[Dict[str, Any]]:
    """Le corps de ``execute_coach_actions``.

    Le lire-modifier-écrire (portefeuille + registre) est sous ``_WRITE_LOCK``
    ; le carnet et la synchro du profil sortent du verrou — ils le reprennent
    eux-mêmes (il est réentrant) et n'ont pas à rallonger la section critique.
    """
    now = now_iso or _now_iso()

    if parse_error:
        entry = coach_trader.ledger_entry(now, source, "parse", "", False,
                                          reason=str(parse_error))
        with _WRITE_LOCK:
            _push_coach_ledger([entry])
        return [entry]

    pending = [a for a in (actions or []) if isinstance(a, dict)]
    journal: List[Any] = []
    rows: List[Dict[str, Any]] = []

    with _WRITE_LOCK:
        portfolio = _ensure_coach_account()
        if not pending:
            entry = coach_trader.ledger_entry(
                now, source, "hold", "", True,
                detail=note if note else COACH_HOLD_DETAIL)
            _push_coach_ledger([entry])
            return [entry]

        for action in pending:
            entry, journal_entry = _coach_execute_one(portfolio, action, source,
                                                      now, crypto_only)
            rows.append(entry)
            if journal_entry is not None:
                journal.append(journal_entry)
        if note:
            # EN PLUS des lignes d'actions, jamais À LA PLACE d'une : voir la
            # docstring d'``execute_coach_actions`` pour le choix documenté.
            # Ajoutée en DERNIER dans ``rows`` -> ``_push_coach_ledger``
            # (qui pousse « en tête » un par un) la place la plus RÉCENTE du
            # lot au registre : la raison d'ensemble se lit avant l'action
            # concrète qu'elle accompagne.
            rows.append(coach_trader.ledger_entry(
                now, source, "note", "", True, detail=note))
        _save(coach_trader.COACH_USERNAME, portfolio)
        _push_coach_ledger(rows)

    _sync_coach(coach_trader.COACH_USERNAME, portfolio.to_dict())
    for title, body in journal:
        _append_journal(coach_trader.COACH_USERNAME, title, body, now)
    return rows


def tick_coach_account(now_iso: Optional[str] = None) -> Dict[str, Any]:
    """Confronte les ordres et les stops DU COACH aux bougies récentes.

    ⚠️ **C'est la garantie d'inclusion du coach dans le simulateur.**
    ``run_tick`` n'énumère AUCUN compte : c'est une fonction par-portefeuille,
    appelée depuis ``POST /api/paper/tick``, que déclenche le NAVIGATEUR de
    l'utilisateur connecté. Le coach n'a pas de navigateur — sans cet appel
    (branché sur le cycle du guetteur via ``coach_trader.maybe_run``), ses
    stops et ses objectifs ne s'exécuteraient JAMAIS.

    Chemin STRICTEMENT identique à celui d'un humain (``paper_tick``), verrou
    compris (aucun : ``run_tick`` fait du réseau, le mettre sous
    ``_WRITE_LOCK`` sérialiserait tout le module pendant plusieurs secondes).
    """
    username = coach_trader.COACH_USERNAME
    now = now_iso or _now_iso()
    portfolio = _ensure_coach_account()

    def fetch_candles(symbol: str) -> List[Dict[str, Any]]:
        return quotes.get_candles(symbol, TICK_RANGE, TICK_INTERVAL)

    result = run_tick(portfolio, now, fetch_candles, quotes.fx_to_chf, username)
    _save(username, portfolio)
    _sync_coach(username, portfolio.to_dict())
    return result


def _snapshot_usernames() -> List[str]:
    """Les comptes recensés — la liste du radar, la seule du paquet qui parte
    des PORTEFEUILLES (et donc qui inclut le coach). Isolée dans sa propre
    fonction pour rester substituable en test."""
    return list(_radar()._users_with_portfolio())


def _equity_now_chf(raw: Dict[str, Any], prices: Dict[str, float],
                    rates: Dict[str, float]) -> float:
    """Équité d'un compte AU COURS DU JOUR : trésorerie + valeur de marché.

    Un cours indisponible retombe sur le PRIX DE REVIENT de la ligne (et son
    taux historique) plutôt que de perdre le point — exactement la doctrine de
    ``risk.exposure`` : une ligne sans cours garde son dernier prix connu au
    lieu de disparaître du total, ce qui creuserait un faux trou dans la
    courbe.
    """
    total = _num(raw.get("cash_chf")) or 0.0
    for position in raw.get("positions") or []:
        if not isinstance(position, dict):
            continue
        qty = abs(_num(position.get("qty")) or 0.0)
        avg = _num(position.get("avg_price")) or 0.0
        stored_rate = _num(position.get("fx_rate")) or 1.0
        symbol = str(position.get("symbol") or "").upper()
        currency = str(position.get("currency") or "").upper()

        price = prices.get(symbol)
        if price is None:
            price, rate = avg, stored_rate
        else:
            rate = rates.get(currency) or stored_rate
        # ⚠️ Une ligne VENDUE À DÉCOUVERT se SOUSTRAIT (LOT 5). Le produit de
        # la vente est déjà dans la trésorerie (``_open_short`` l'y a crédité)
        # ; ce qui reste à porter, c'est la DETTE de rachat — sa valeur de
        # marché, en négatif. L'additionner ferait grossir le compte de la
        # taille de la ligne à la seconde où il shorte, et grossir ENCORE
        # quand le titre monte contre lui : la courbe de patrimoine dirait
        # l'exact inverse de la vérité.
        if str(position.get("side") or "long").lower() == "short":
            total -= qty * price * rate
        else:
            total += qty * price * rate
    return round(total, 2)


def snapshot_equity_all(now_iso: Optional[str] = None) -> Dict[str, Any]:
    """Une photo de patrimoine par jour, POUR TOUS LES COMPTES (coach ET
    humains) — c'est elle qui alimente les « graphiques du patrimoine ».

    UN SEUL batch de cours par passage, sur les symboles DISTINCTS de tous les
    comptes réunis (patron de ``newswatch._run_price_alerts_volet``) : jamais
    un appel Yahoo par compte, sinon dix comptes détenant le même titre le
    demanderaient dix fois.

    Best-effort de bout en bout : un compte illisible, un cours en panne ou une
    écriture en échec ne font jamais perdre les autres, et ne lèvent jamais.

    Le gate par compte est ``coach_trader.should_snapshot`` — c'est LUI
    l'autorité sur la donnée (``push_equity`` refuse en plus toute date déjà
    présente). Le gate extérieur de ``coach_trader.maybe_run`` ne fait
    qu'éviter d'appeler cette fonction 288 fois par jour.
    """
    now = now_iso or _now_iso()
    day = str(now)[:10]
    out: Dict[str, Any] = {"day": day, "accounts": 0, "points": 0}

    try:
        usernames = _snapshot_usernames()
    except Exception as e:                  # noqa: BLE001 — jamais fatal
        logger.warning("paper coach: comptes illisibles pour la photo (%s)",
                       type(e).__name__)
        return out

    holdings: Dict[str, Dict[str, Any]] = {}
    symbols = set()
    currencies = set()
    for username in usernames:
        try:
            raw = store.load_portfolio(username)
        except (ValueError, OSError):
            continue
        if not isinstance(raw, dict):
            continue
        holdings[username] = raw
        for position in raw.get("positions") or []:
            if not isinstance(position, dict):
                continue
            symbol = str(position.get("symbol") or "").upper()
            if symbol:
                symbols.add(symbol)
            currency = str(position.get("currency") or "").upper()
            if currency:
                currencies.add(currency)
    out["accounts"] = len(holdings)

    prices: Dict[str, float] = {}
    for symbol in sorted(symbols):
        try:
            quote = quotes.get_quote(symbol)
        except Exception:                   # noqa: BLE001 — cours en panne
            continue
        price = _num((quote or {}).get("price"))
        if price is not None:
            prices[symbol] = price
        currency = str((quote or {}).get("currency") or "").upper()
        if currency:
            currencies.add(currency)

    rates: Dict[str, float] = {}
    for currency in sorted(currencies):
        try:
            rate = _num(quotes.fx_to_chf(currency))
        except Exception:                   # noqa: BLE001 — taux en panne
            continue
        if rate:
            rates[currency] = rate

    for username, raw in holdings.items():
        try:
            series = store.load_equity(username)
            if not coach_trader.should_snapshot(series, day):
                continue
            equity = _equity_now_chf(raw, prices, rates)
            store.save_equity(username,
                              coach_trader.push_equity(series, day, equity))
            out["points"] += 1
        except Exception as e:              # noqa: BLE001 — un compte n'en casse pas d'autre
            logger.warning("paper coach: photo de patrimoine ratée pour %s (%s)",
                           username, type(e).__name__)
    return out


def _coach_position_row(position: models.Position,
                        price: Optional[float],
                        rate: Optional[float]) -> Dict[str, Any]:
    """Une ligne du coach, valorisée, pour le contexte de sa passe.

    ``side`` est DANS la ligne (LOT 5) : sans lui, le modèle ne peut pas savoir
    qu'une position se solde par un RACHAT et proposerait un ``sell``, refusé.

    ``pnl_pct`` est INVERSÉ pour une vente à découvert — même geste que la
    revue de positions (``positions_review``) et que l'écran. Un short gagnant
    affiché « -10 % » pousserait le coach à couper un gagnant, c'est-à-dire
    l'erreur exacte que son mandat lui interdit.
    """
    fx = rate if rate else (position.fx_rate or 1.0)
    live = price if price is not None else position.avg_price
    cost = position.avg_price or 0.0
    pnl_pct = round((live - cost) / cost * 100.0, 2) if cost else None
    if position.side == "short" and pnl_pct is not None:
        pnl_pct = round(-pnl_pct, 2)
    return {
        "symbol": position.symbol,
        "qty": position.qty,
        "side": position.side,
        "avg_price": position.avg_price,
        "currency": position.currency,
        "price": live,
        "value_chf": round(abs(position.qty) * live * fx, 2),
        "pnl_pct": pnl_pct,
        "thesis": position.thesis,
        "stop_loss": position.stop_loss,
        "target": position.target,
        "opened_at": position.opened_at,
    }


def _coach_pass_context(portfolio: models.Portfolio,
                        now_iso: str) -> Dict[str, Any]:
    """Le contexte de la passe quotidienne : des faits DÉJÀ CALCULÉS.

    100 % DÉTERMINISTE, et best-effort sur ses sources annexes : radar, humeur
    de marché et agenda macro sont ABSENTS quand ils sont en panne, jamais une
    exception — le coach décidera sans, il décidera juste moins bien.
    """
    positions: List[Dict[str, Any]] = []
    equity = portfolio.cash_chf
    for position in portfolio.positions:
        quote = _coach_quote(position.symbol)
        row = _coach_position_row(position,
                                  quote["price"] if quote else None,
                                  quote["fx_rate"] if quote else None)
        # LOT 5 — gérer une ligne (resserrer un stop, laisser courir) demande
        # exactement les mêmes niveaux qu'en ouvrir une.
        row["technical"] = _coach_technical(position.symbol)
        positions.append(row)
        # ⚠️ Une ligne courte se SOUSTRAIT (LOT 5, même raison que
        # ``_equity_now_chf``) : son produit de vente est déjà dans la
        # trésorerie, ce qui reste à porter est la dette de rachat. L'ajouter
        # ferait lire au coach une équité qui GROSSIT quand son short perd.
        if position.side == "short":
            equity -= row["value_chf"]
        else:
            equity += row["value_chf"]

    trades = [t.to_dict() for t in portfolio.trades]
    context: Dict[str, Any] = {
        "now": now_iso,
        "cash_chf": round(portfolio.cash_chf, 2),
        "equity_chf": round(equity, 2),
        "initial_capital": portfolio.initial_capital,
        "positions": positions,
        "open_orders": [o.to_dict() for o in portfolio.open_orders],
        "stats": risk.portfolio_stats(trades,
                                      initial_capital=portfolio.initial_capital),
        "discipline": tradestats.discipline_score(trades,
                                                  portfolio.initial_capital),
        "radar": _open_radar_hypotheses(),
        "market_mood": {},
        "agenda": [],
        "candidates": [],
        "verdicts": [],
    }
    try:
        context["market_mood"] = mood.get() or {}
    except Exception:                       # noqa: BLE001 — best-effort
        context["market_mood"] = {}
    try:
        context["agenda"] = list((_agenda_macro() or {}).get("rendez_vous") or [])
    except Exception:                       # noqa: BLE001 — best-effort
        context["agenda"] = []
    try:
        # LOT 4bis — le cours de ce qu'il ne détient PAS ENCORE : sans lui, un
        # livre neuf n'a aucun prix pour dimensionner une entrée (cf. tête de
        # fonction de ``_coach_candidates``).
        context["candidates"] = _coach_candidates(context["radar"])
    except Exception:                       # noqa: BLE001 — best-effort
        context["candidates"] = []
    try:
        # LOT 5 — les rendez-vous RÉCEMMENT JUGÉS : « la réunion a-t-elle tenu
        # ce qu'elle annonçait ? ». C'est ce qui distingue un catalyseur qui a
        # produit son effet d'un autre qui est passé sans rien donner — et
        # donc une thèse encore vivante d'une thèse à couper. LECTURE PURE
        # (``calendar.recent_verdicts`` ne collecte rien, c'est son contrat).
        context["verdicts"] = list(_calendar().recent_verdicts() or [])
    except Exception:                       # noqa: BLE001 — best-effort
        context["verdicts"] = []
    return context


def _coach_dossier(symbol: str, username: str,
                   news: List[Dict[str, Any]],
                   history: Dict[str, List[str]],
                   moves: List[Dict[str, Any]]) -> Dict[str, Any]:
    """TOUT ce que la mémoire sait d'UN titre (LOT 5, second temps).

    Le tri (premier temps) voit beaucoup de titres et peu de choses ; le
    dossier voit TROIS titres et tout ce qu'on sait d'eux. C'est là qu'est le
    gain de la passe en deux temps : porter ce niveau de détail sur vingt
    candidats donnerait un prompt illisible autant qu'inabordable.

    Les trois sources collectives (presse, historique, gérants) sont relues UNE
    FOIS pour les trois dossiers et filtrées ici — pas un balayage par titre.
    """
    titles = []
    for event in news:
        if not isinstance(event, dict):
            continue
        if str(event.get("symbol") or "").upper() != symbol:
            continue
        titles.append({"title": event.get("title"),
                       "sentiment": event.get("sentiment"),
                       "ts": event.get("ts")})
        if len(titles) >= DOSSIER_NEWS_PER_SYMBOL:
            break

    whales = [move for move in moves
              if str((move or {}).get("symbol") or "").upper() == symbol]

    return {
        "symbol": symbol,
        "technical": _coach_technical(symbol),
        "news": titles,
        "history": history.get(symbol) or [],
        "whale_moves": whales[:DOSSIER_WHALES_PER_SYMBOL],
        "memory": _coach_symbol_memory(symbol, username),
    }


def _coach_symbol_memory(symbol: str, username: str) -> List[Dict[str, Any]]:
    """Ce que le coach a DÉJÀ dit de ce titre : hypothèses du radar qui le
    portent, avec leur verdict quand elles ont été notées.

    C'est sa branche de toile, en liste. Elle lui évite de re-proposer une
    thèse qu'il a déjà vue échouer — et l'oubli de ses propres erreurs est
    précisément ce qu'on lui reproche le plus facilement.

    Best-effort : radar absent ou illisible -> liste vide.
    """
    out: List[Dict[str, Any]] = []
    try:
        hypotheses = _radar().load_state().get("hypotheses") or []
    except Exception:                           # noqa: BLE001 — radar absent
        return []
    for hyp in hypotheses:
        if not isinstance(hyp, dict):
            continue
        tickers = [str(t or "").strip().upper() for t in (hyp.get("tickers") or [])]
        if symbol not in tickers:
            continue
        out.append({
            "thesis": hyp.get("thesis"),
            "direction": hyp.get("direction"),
            "status": hyp.get("status"),
            "outcome": hyp.get("outcome"),
            "created_at": hyp.get("created_at"),
        })
        if len(out) >= DOSSIER_MEMORY_PER_SYMBOL:
            break
    return out


def _coach_dossiers(symbols: List[str],
                    username: str) -> List[Dict[str, Any]]:
    """Les dossiers complets des titres retenus par le tri (best-effort).

    Les sources collectives sont relues UNE SEULE FOIS ici, puis distribuées
    par :func:`_coach_dossier` — un balayage par titre coûterait trois fois le
    même travail.
    """
    wanted = [s for s in (symbols or []) if s][:coach_trader.MAX_FOCUS]
    if not wanted:
        return []
    try:
        news = _recent_news(username)
    except Exception:                           # noqa: BLE001 — best-effort
        news = []
    try:
        history = _backfill_digest(wanted)
    except Exception:                           # noqa: BLE001 — best-effort
        history = {}
    try:
        moves = _whale_moves()
    except Exception:                           # noqa: BLE001 — best-effort
        moves = []

    out: List[Dict[str, Any]] = []
    for symbol in wanted:
        try:
            out.append(_coach_dossier(symbol, username, news, history, moves))
        except Exception as e:                  # noqa: BLE001 — un titre n'en casse pas d'autre
            logger.warning("paper coach: dossier illisible pour %s (%s)",
                           symbol, type(e).__name__)
    return out


def coach_book() -> Dict[str, Any]:
    """CONTRAT PUBLIC — le compte du coach, dans la forme que le PROMPT lit.

    Les cinq clés (``cash_chf``, ``equity_chf``, ``positions``,
    ``open_orders``, ``candidates``) sont EXACTEMENT celles que
    ``llm.coach_actions_block`` consomme — ``llm._coach_book_of`` en est
    l'extracteur côté passe quotidienne, et un test épingle l'égalité des deux
    jeux de clés. C'est ``convergence._coach_book`` qui appelle cette
    fonction : sans elle, le digest ne demanderait aucune action et le coach
    ne ferait jamais rien.

    **``equity_chf`` = ``_coach_equity_chf``** (trésorerie + lignes au PRIX DE
    REVIENT, bâti sur ``_positions_value_chf``) et NON la valeur de marché. La
    raison est dure : le prompt dit au modèle de viser « une taille pleine
    entre X et Y % de TON équité », et c'est ``coach_trader._equity_chf`` — la
    même convention, au prix de revient — qui REFUSE ensuite. Lui montrer une
    autre équité le ferait dimensionner contre un chiffre dont le garde-fou ne
    se sert pas, et les refus paraîtraient arbitraires.
    ⚠️ Divergence assumée : la passe quotidienne, elle, montre bien la valeur
    de MARCHÉ sur les POSITIONS DÉJÀ DÉTENUES. Deux photos, deux usages — pas
    un oubli.

    Les lignes de ``positions`` sont celles de ``_coach_position_row``
    PRIVÉES de ``price`` et ``pnl_pct`` : faute de cours, ces deux champs
    vaudraient le prix de revient et « 0 % », c'est-à-dire toutes les lignes à
    plat — un fait FAUX. Absent vaut mieux qu'inventé. Le reste (thèse, stop,
    objectif) est précisément ce qu'il faut au modèle pour décider de déplacer
    un stop ou de sortir.

    **``candidates`` (LOT 4bis, ``_coach_candidates``) FAIT du réseau** — un
    cours par ticker DISTINCT suivi par une hypothèse radar OUVERTE, plafonné
    à :data:`MAX_COACH_CANDIDATES` — ce qui ÉTAIT faux de cette fonction avant
    ce lot (elle ne cotait rien). Sans lui, un livre neuf ou vide n'a NUL PART
    de prix pour dimensionner une entrée : trois passes de suite se sont
    terminées sur la même raison honnête (« il me faut le cours actuel du
    titre »), le coach était affamé de données, pas timide. Ce n'est pas un
    problème pour l'invariant « l'évaluation d'un cycle de 5 min reste
    gratuite » de ``maybe_fire`` : cette fonction n'est appelée qu'APRÈS que
    ``should_fire``/« aucun canal » ont laissé passer un digest RÉEL sur le
    point de partir, jamais à chaque passage du radar.

    **NE LÈVE JAMAIS** : un pépin rend un livre VIDE (``{}``), le seul retour
    qui dégrade correctement des DEUX côtés — ``coach_actions_block`` ne rend
    alors aucune section (le modèle ne dimensionne pas à l'aveugle) et
    ``maybe_fire``, qui teste la vérité du livre, n'engage pas l'exécuteur.
    """
    try:
        portfolio = _ensure_coach_account()
        positions = []
        for position in portfolio.positions:
            row = _coach_position_row(position, None, None)
            # cf. docstring : sans cours, ces deux-là seraient INVENTÉS.
            row.pop("price", None)
            row.pop("pnl_pct", None)
            positions.append(row)
        return {
            "cash_chf": round(portfolio.cash_chf, 2),
            "equity_chf": round(_coach_equity_chf(portfolio), 2),
            "positions": positions,
            "open_orders": [o.to_dict() for o in portfolio.open_orders],
            "candidates": _coach_candidates(_open_radar_hypotheses()),
        }
    except Exception as e:                  # noqa: BLE001 — jamais fatal
        logger.warning("paper coach: livre indisponible pour le digest (%s)",
                       type(e).__name__)
        return {}


def _coach_llm_failure(now_iso: str, detail: str) -> List[Dict[str, Any]]:
    """Une panne du modèle -> AUCUNE action, mais une ligne au registre.

    Le silence serait le pire des cas : une soirée où le coach n'a rien fait
    parce qu'il l'a décidé et une soirée où il n'a rien pu faire doivent se
    distinguer à l'écran."""
    entry = coach_trader.ledger_entry(now_iso, "daily", "pass", "", False,
                                      reason="llm_failed",
                                      detail=str(detail)[:200])
    with _WRITE_LOCK:
        _push_coach_ledger([entry])
    return [entry]


def run_coach_daily_pass(now_iso: Optional[str] = None,
                         claude: Optional[Callable[[str], str]] = None,
                         crypto_only: bool = False) -> Dict[str, Any]:
    """La passe de gestion du compte du coach, EN DEUX TEMPS (LOT 5).

    Contexte DÉTERMINISTE -> **tri** -> dossiers des élus -> **décision** ->
    bloc structuré -> exécution. Le modèle ne fait que PROPOSER : c'est
    ``coach_trader.gate_decision`` qui tranche, et ``execute_coach_actions``
    qui exécute ce qui a survécu.

    **Pourquoi deux temps.** Le contexte complet (livre, candidats cotés,
    radar, agenda, humeur du marché) suffit à REPÉRER ce qui mérite un examen ;
    il ne suffit pas à le DÉCIDER. Poser un stop technique demande des niveaux,
    et juger une thèse demande la presse, le dossier historique et les
    mouvements de gérants — soit, par titre, plusieurs fois le volume du
    contexte lui-même. Le porter pour vingt candidats donnerait un prompt
    illisible autant qu'inabordable ; le porter pour trois est exactement ce
    qu'il faut.

    **Coût : deux appels au plus, UN seul quand le tri ne retient rien** —
    et ne rien retenir reste une réponse légitime, archivée avec sa raison.

    ``crypto_only`` (créneau du week-end) descend jusqu'au garde-fou : un ordre
    sur une action y est refusé (``market_closed``) plutôt que de dormir
    jusqu'au lundi pour s'exécuter à un prix que personne n'a vu.

    ``claude`` est injectable (les tests n'ont jamais besoin du CLI).

    Les constructeurs de prompt sont résolus par un ``getattr`` TOLÉRANT :
    leur absence doit dégrader proprement (une ligne de registre) plutôt que
    faire tomber le cycle de veille.

    ⚠️ Un bloc ABSENT (``"no_block"``) n'est PAS une anomalie — c'est une
    journée où le coach n'a rien à faire — donc il ressort en ligne ``hold``,
    là où ``"parse_failed"`` (bloc présent mais illisible) reste une ligne
    ``parse``. Cette distinction vaut pour les DEUX temps.

    NE LÈVE JAMAIS.
    """
    now = now_iso or _now_iso()
    try:
        portfolio = _ensure_coach_account()
        context = _coach_pass_context(portfolio, now)
    except Exception as e:                  # noqa: BLE001 — jamais fatal
        logger.warning("paper coach: contexte de passe indisponible (%s)",
                       type(e).__name__)
        return {"ledger": [], "error": type(e).__name__}

    screen_builder = getattr(llm, "build_coach_screen_prompt", None)
    builder = getattr(llm, "build_coach_trader_prompt", None)
    if builder is None or screen_builder is None:
        return {"ledger": _coach_llm_failure(now, "prompt indisponible")}

    speak = claude if claude is not None else llm._claude_text
    context["crypto_only"] = bool(crypto_only)

    # --- PREMIER TEMPS : le tri ---------------------------------------- #
    answer = _coach_speak(speak, screen_builder, context, now)
    if answer is None:
        return {"ledger": _coach_llm_failure(now, "tri sans réponse")}

    screened = coach_trader.parse_focus(answer)
    if screened.get("error") == "parse_failed":
        return {"ledger": execute_coach_actions([], source="daily", now_iso=now,
                                                parse_error="parse_failed"),
                "text": screened.get("text") or ""}

    focus = screened.get("focus") or []
    if not focus:
        # Rien à instruire : le second appel NE PART PAS. La raison du coach
        # (``note``) devient le détail de sa ligne ``hold`` — c'est elle qu'on
        # lira, pas un repli générique.
        return {"ledger": execute_coach_actions([], source="daily", now_iso=now,
                                                note=screened.get("note")),
                "text": screened.get("text") or ""}

    # --- SECOND TEMPS : les dossiers ----------------------------------- #
    try:
        context["dossiers"] = _coach_dossiers(focus, coach_trader.COACH_USERNAME)
    except Exception as e:                  # noqa: BLE001 — best-effort
        logger.warning("paper coach: dossiers indisponibles (%s)",
                       type(e).__name__)
        context["dossiers"] = []
    context["focus"] = list(focus)
    context["focus_note"] = screened.get("note")

    answer = _coach_speak(speak, builder, context, now)
    if answer is None:
        return {"ledger": _coach_llm_failure(now, "décision sans réponse")}

    parsed = coach_trader.parse_actions(answer)
    error = parsed.get("error")
    rows = execute_coach_actions(parsed.get("actions") or [], source="daily",
                                 now_iso=now,
                                 parse_error=(error if error == "parse_failed"
                                              else None),
                                 note=parsed.get("note"),
                                 crypto_only=crypto_only)
    return {"ledger": rows, "text": parsed.get("text") or ""}


def _coach_speak(speak: Callable[[str], str], builder: Callable[[Any], str],
                 context: Dict[str, Any], now: str) -> Optional[str]:
    """Un tour de parole du modèle : construit, demande, rend le texte.

    ``None`` sur panne OU réponse vide — l'appelant en fait une ligne de
    registre. Une réponse vide n'est pas « rien à faire » : c'est une panne,
    et les deux doivent se distinguer à l'écran (cf. ``_coach_llm_failure``).
    """
    try:
        answer = speak(builder(context))
    except Exception as e:                  # noqa: BLE001 — modèle en panne
        logger.warning("paper coach: passe sans réponse (%s)", type(e).__name__)
        return None
    return answer if str(answer or "").strip() else None


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
    # LOT 2 (B2/B3) — whitelists FERMÉES, cf. ``_clean_choice``.
    setup: Optional[str] = None
    emotion: Optional[str] = None
    # LOT 3, C3 — la porte de confirmation : ``False`` (le défaut) = « laisse
    # le serveur prévenir avant d'exécuter s'il y a un avertissement pré-ordre » ;
    # ``True`` = « je sais, exécute quand même ». Ignoré silencieusement pour
    # un ordre de SORTIE (jamais gated, cf. ``risk.preorder_warnings``).
    confirmed: bool = False


class ResetPayload(BaseModel):
    initial_capital: Optional[float] = None
    fee_profile: Optional[str] = None


class ClosePayload(BaseModel):
    qty: Optional[int] = None
    # LOT 2 (B3) — SEULE la clôture manuelle en propose une (cf. ``close_position``).
    emotion_close: Optional[str] = None


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


class AlertPayload(BaseModel):
    symbol: str = ""
    op: str = ""
    price: float = 0.0


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
# Endpoint — la RELÈVE d'un travail détaché
# --------------------------------------------------------------------------- #

@router.get("/job/{job_id}")
def paper_job(job_id: str,
              current_user: User = Depends(require_role("admin", "money", "trader"))):
    """Où en est un travail lancé par l'un des six endpoints du modèle.

    Trois formes, et une seule d'entre elles est un 200 « tout va bien » :

    * ``{"status": "pending"}`` — il tourne encore, revenir dans deux secondes ;
    * ``{"status": "done", "result": {...}}`` — ``result`` est EXACTEMENT ce
      que l'endpoint rendait avant ce lot, sans réenveloppe ;
    * ``{"status": "error", "error": "...", "code": 502}`` — le travail a
      échoué. C'est un 200 HTTP : la relève, elle, a réussi. Mélanger les deux
      (rendre 502 ici) empêcherait le client de distinguer « le coach est en
      panne » de « ma requête de relève est passée à côté ».

    Travail inconnu -> 404. Travail d'un AUTRE compte -> 404 aussi, jamais 403 :
    répondre « interdit » confirmerait qu'il existe.
    """
    with _JOBS_LOCK:
        job = _JOBS.get(str(job_id or ""))
        if job is None or job.get("user") != current_user.username:
            raise HTTPException(status_code=404, detail="Travail introuvable.")
        out: Dict[str, Any] = {"status": job.get("status") or JOB_PENDING}
        if job.get("status") == JOB_DONE:
            out["result"] = job.get("result")
        elif job.get("status") == JOB_ERROR:
            out["error"] = job.get("error") or "erreur inconnue"
            out["code"] = job.get("code") or 500
        return out


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
        # Courbe de patrimoine (LOT 4) : la carte « Courbe d'équité » du
        # dashboard la lit depuis toujours (``_equitySeries``) — aucun backend
        # ne l'avait jamais produite, elle affichait donc « pas assez
        # d'historique » en permanence. Les points sont écrits une fois par
        # jour par ``snapshot_equity_all``.
        "equity_curve": store.load_equity(username),
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
    """Recherche de ticker. Moins de 2 caractères -> liste vide, sans réseau.

    Si la requête, une fois passée par :func:`quotes.canonical`, matche un
    alias connu (ex. ``ROG.SW`` -> ``RO.SW``), on cherche sur le symbole
    CANONIQUE — sinon Yahoo rendrait 0 résultat sur un ticker qu'il ne connaît
    que sous une autre forme. Aucun alias touché -> requête inchangée
    (comportement actuel, y compris pour une recherche par NOM comme
    « nestle » qui n'est pas un symbole).
    """
    term = str(q or "").strip()
    if len(term) < MIN_SEARCH_LEN:
        return []
    canon = quotes.canonical(term)
    query = canon if canon != term.upper() else term
    try:
        return quotes.search(query)
    except quotes.QuoteError as e:
        raise HTTPException(status_code=502, detail=str(e))


@router.get("/quotes")
def paper_quotes(symbols: str = "",
                 current_user: User = Depends(require_role("admin", "money", "trader"))):
    """Cotations d'une liste de symboles séparés par des virgules (20 maximum).

    Chaque symbole passe par :func:`quotes.canonical` : un alias connu (ex.
    ``ROG.SW``) est traduit AVANT l'appel Yahoo, sinon la ligne rendrait une
    erreur pour un titre qui existe bel et bien sous son vrai symbole.
    """
    wanted = [quotes.canonical(s) for s in str(symbols or "").split(",") if s.strip()]
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


@router.get("/market-mood")
def paper_market_mood(current_user: User = Depends(require_role("admin", "money", "trader"))):
    """Jauge d'humeur du marché (^VIX, Lot D3) — cachée EN MÉMOIRE 10 min côté
    ``mood.get()``, jamais un fichier. VIX introuvable -> ``{}`` (200 vide) :
    l'interface n'affiche alors AUCUN chip, jamais une valeur inventée."""
    return mood.get()


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

    Le symbole passe par :func:`quotes.canonical` (un alias connu, ex.
    ``ROG.SW``, est traduit avant l'appel Yahoo).
    """
    wanted = quotes.canonical(symbol)
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

    Le symbole passe par :func:`quotes.canonical` : la position ouverte (ou
    renforcée) est stockée sous le symbole CANONIQUE, jamais sous un alias —
    sinon les consommateurs en aval (veille par symbole, graphe, backfill)
    verraient deux identités pour le même titre.
    """
    username = current_user.username
    symbol = quotes.canonical(data.symbol)
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
    setup = _clean_choice(data.setup, models.SETUPS, "Setup")
    emotion = _clean_choice(data.emotion, models.EMOTIONS, "Émotion")

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
        setup=setup,
        emotion=emotion,
    )

    # Avertissements calculés sur la PROJECTION (avant exécution) : une position
    # en attente doit être avertie comme une position exécutée.
    projected = None
    if side in ("buy", "short") and entry_estimate is not None:
        existing = _find_position(portfolio, symbol,
                                  "long" if side == "buy" else "short")
        held = existing.qty if existing is not None else 0
        projected = (held + qty) * entry_estimate * fx_rate
    equity = _coach_equity_chf(portfolio)
    warnings = compute_warnings(side, order.thesis, data.stop_loss, risk_chf,
                                portfolio.initial_capital, projected, equity)

    # Porte de confirmation (LOT 3, C3) — AVANT toute exécution ou mise en
    # attente. ``level`` = le même prix de référence que ``risk_chf``/
    # ``projected`` ci-dessus (l'estimation d'entrée, DÉJÀ convertie en CHF —
    # ``preorder_warnings`` reste pur, zéro réseau, zéro taux de change à
    # elle). Un ordre de SORTIE ne rend jamais de code (cf. la fonction) :
    # ``confirm_codes`` y est systématiquement vide, la porte ne se referme
    # donc jamais sur un ``sell``/``cover``.
    confirm_level = None if entry_estimate is None else entry_estimate * fx_rate
    confirm_codes = risk.preorder_warnings(
        {"side": side, "symbol": symbol, "thesis": data.thesis,
         "stop_loss": data.stop_loss, "target": data.target, "qty": qty},
        portfolio.to_dict(), confirm_level)
    if confirm_codes and not data.confirmed:
        # 200, JAMAIS un refus dur (invariant 1 du module) : une pause, pas
        # un blocage — rien n'est exécuté, rien n'est mis en attente, rien
        # n'est sauvegardé.
        return {"needs_confirm": True, "warnings": confirm_codes}
    if confirm_codes:
        # Le score de discipline pourra un jour les lire sur le Trade clos
        # (stocké, pas câblé — cf. mission) : posé sur l'ORDRE, il suit la
        # même chaîne que setup/emotion jusqu'à la Position puis le Trade.
        order.forced_warnings = confirm_codes

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
        _attach_trade_extras(portfolio, fill, username)
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
    """Clôture au marché tout ou partie d'une ligne.

    Le symbole passe par :func:`quotes.canonical` : une position ouverte sous
    l'alias avant ce lot n'existe pas (Yahoo la refusait déjà à la création),
    mais un client qui tape encore l'alias dans l'URL doit retomber sur la
    même ligne que celle affichée (stockée canonique).
    """
    username = current_user.username
    wanted = quotes.canonical(symbol)
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
    emotion_close = _clean_choice(data.emotion_close, models.EMOTIONS, "Émotion")

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
        fill = close_position(portfolio, position, qty, price, fx_rate, _now_iso(),
                              emotion_close=emotion_close)
    except OrderError as e:
        raise HTTPException(status_code=400, detail=str(e))
    _attach_trade_extras(portfolio, fill, username)

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

    result = run_tick(portfolio, _now_iso(), fetch_candles, quotes.fx_to_chf, username)
    _save(username, portfolio)
    _sync_coach(username, portfolio.to_dict())
    return result


# --------------------------------------------------------------------------- #
# Endpoints — journal niveau pro (LOT 2)
#
# Les trois endpoints ci-dessous ne font QUE lire le portefeuille et appeler
# les fonctions PURES de ``tradestats`` — aucun réseau, aucun LLM, rien de
# stocké en double (même doctrine que ``board.learning_summary`` : le journal
# ne peut pas mentir, il est recalculé à chaque lecture).
# --------------------------------------------------------------------------- #
@router.get("/journal/setups")
def paper_journal_setups(
        current_user: User = Depends(require_role("admin", "money", "trader"))):
    """Performance PAR SETUP sur les trades clôturés (B2)."""
    portfolio = _load(current_user.username)
    trades = [t.to_dict() for t in portfolio.trades]
    return {"rows": tradestats.setup_breakdown(trades)}


@router.get("/journal/emotions")
def paper_journal_emotions(
        current_user: User = Depends(require_role("admin", "money", "trader"))):
    """Performance PAR ÉMOTION D'ENTRÉE sur les trades clôturés (B3)."""
    portfolio = _load(current_user.username)
    trades = [t.to_dict() for t in portfolio.trades]
    return {"rows": tradestats.emotion_breakdown(trades)}


@router.get("/discipline")
def paper_discipline(
        current_user: User = Depends(require_role("admin", "money", "trader"))):
    """Score de discipline 0-100 (B4). Moins de 5 trades clos -> ``score: null``."""
    portfolio = _load(current_user.username)
    trades = [t.to_dict() for t in portfolio.trades]
    return tradestats.discipline_score(trades, portfolio.initial_capital)


# --------------------------------------------------------------------------- #
# Endpoints — compte de trading DU COACH (LOT 4)
# --------------------------------------------------------------------------- #
@router.get("/coach-trader")
def paper_coach_trader(
        current_user: User = Depends(require_role("admin", "money", "trader"))):
    """Le compte du coach, en entier — et la courbe de l'appelant à côté.

    **Aucun filtrage** : le livre du coach est PUBLIC par design (positions,
    registre, refus compris). C'est tout l'intérêt du lot — mesurer si ce qu'il
    annonce fonctionne, et voir COMMENT il fait.

    ``equity.user`` est la série de l'utilisateur QUI APPELLE : la comparaison
    (« il gagne, et moi ? ») exige les deux courbes dans la même réponse,
    sinon l'écran devrait les recoller lui-même.

    Effet de bord assumé : la première lecture CRÉE le compte
    (``_ensure_coach_account``). Le coach est un compte permanent du
    simulateur, pas une ressource optionnelle — le faire naître à la lecture
    évite un écran vide qui ne se remplirait qu'après la première passe.
    """
    portfolio = _ensure_coach_account()

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
            quote_map[symbol] = {"symbol": symbol, "price": None,
                                 "currency": position.currency,
                                 "change_pct": None, "name": "",
                                 "error": str(e)[:200]}
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
    last_pass = coach_trader.load_state().get("last_pass")

    return {
        "username": coach_trader.COACH_USERNAME,
        "display": COACH_DISPLAY,
        "portfolio": portfolio.to_dict(),
        "quotes": quote_map,
        # ⚠️ Le PATRIMOINE de la tuile — équité NETTE au cours du jour (les
        # shorts se SOUSTRAIENT, cf. _equity_now_chf). ``exposure`` en dessous
        # est BRUT par sémantique (un short EST du risque) : l'écran ne doit
        # JAMAIS l'utiliser comme patrimoine (vécu 30/08 : +41 % un week-end).
        "equity_now_chf": _equity_now_chf(portfolio.to_dict(), prices,
                                          fx_rates),
        "exposure": risk.exposure(positions, prices, portfolio.cash_chf,
                                  fx_rates),
        "stats": risk.portfolio_stats(trades,
                                      initial_capital=portfolio.initial_capital),
        "discipline": tradestats.discipline_score(trades,
                                                  portfolio.initial_capital),
        "ledger": store.load_ledger(coach_trader.COACH_USERNAME),
        "equity": {
            "coach": store.load_equity(coach_trader.COACH_USERNAME),
            "user": store.load_equity(current_user.username),
        },
        "next_pass": {
            # ``pass_due(None, …)`` prend l'heure courante (UTC) et la lit en
            # heure LOCALE — le module est l'unique horloge de ce rituel.
            "due": coach_trader.pass_due(None, last_pass),
            "after_hour": coach_trader.RUN_AFTER_HOUR,
            "last_pass": last_pass,
        },
        "capital": coach_trader.COACH_CAPITAL,
    }


@router.post("/coach-trader/run")
def paper_coach_trader_run(
        sync: bool = False,
        current_user: User = Depends(require_role("admin"))):
    """Force la passe quotidienne du coach — **admin STRICT**.

    La LECTURE du compte reste ouverte aux trois rôles ; ce bouton-ci consomme
    le modèle (60-90 s de CLI Claude sur une machine qui fait déjà tourner le
    serveur et les autres bots), il n'a rien à faire entre toutes les mains.

    Saute l'horloge (``pass_due``) — c'est le sens du mot « forcer » — mais
    **respecte la porte LLM** : sans modèle disponible, la passe échoue
    proprement en consignant ``llm_failed`` au registre, elle n'invente aucun
    ordre.

    ⚠️ **LOT 6** — elle ne saute PAS le gate d'UNIVERS. Vécu en prod : un
    short d'action US un dimanche 01:47, parce que ``crypto_only`` restait au
    défaut ``False`` de ``run_coach_daily_pass`` — rien ne le calculait ici.
    « Forcer » lève le gate d'HORAIRE (``pass_due``), jamais celui du week-end
    (``coach_trader.crypto_only_at``, la MÊME fonction pure que la passe
    naturelle) : une action ne s'échange toujours pas hors semaine, même sur
    un clic admin.

    Détaché par DÉFAUT, en ligne sur ``?sync=1`` : même patron ``_job_or_sync``
    que les six autres endpoints coûteux de ce fichier, et pour la même raison
    (un appel au modèle dépasse largement le délai d'une requête HTTP).
    """
    now_iso = _now_iso()
    crypto_only = coach_trader.crypto_only_at(now_iso)
    return _job_or_sync(sync, current_user.username,
                        lambda: run_coach_daily_pass(now_iso,
                                                     crypto_only=crypto_only))


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
def paper_coach_ask(data: AskPayload, sync: bool = False,
                    current_user: User = Depends(require_role("admin", "money", "trader"))):
    """Une question au coach. Le LLM RÉDIGE à partir de faits déjà calculés.

    DÉTACHÉ par défaut (cf. le registre de travaux en tête de fichier) : rend
    ``{"job": id}``, le résultat se relève sur ``GET /job/{id}``. ``?sync=1``
    garde l'ancien comportement en ligne.
    """
    # Le nom est extrait ICI : ``current_user`` meurt avec la session (cf. le
    # point 2 du registre de travaux). Même geste dans les cinq voisins.
    username = current_user.username
    return _job_or_sync(sync, username, lambda: _coach_ask_work(username, data))


def _coach_ask_work(username: str, data: AskPayload) -> Dict[str, Any]:
    """Le travail de ``/coach/ask`` — exécuté en ligne ou dans un fil.

    ``lang`` change la langue de la RÉPONSE, pas celle du contexte : les faits
    passés au modèle restent en français (ce sont ceux que ``_sync_coach`` vient
    d'écrire dans le carnet, qui reste français par décision) — un modèle lit
    des faits dans une langue et rédige dans une autre sans difficulté.
    """
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
def paper_postmortem(data: PostmortemPayload, sync: bool = False,
                     current_user: User = Depends(require_role("admin", "money", "trader"))):
    """Post-mortem d'un trade clôturé, archivé dans le ``Journal.md`` (§11).

    DÉTACHÉ par défaut ; ``?sync=1`` pour l'ancien comportement en ligne.
    """
    username = current_user.username
    return _job_or_sync(sync, username, lambda: _postmortem_work(username, data))


def _postmortem_core(username: str, portfolio: models.Portfolio, index: int,
                     lang: str = "fr") -> Dict[str, Any]:
    """Le cœur du post-mortem — PAS de rechargement disque : opère sur le
    ``portfolio`` DÉJÀ EN MÉMOIRE que l'appelant fournit.

    Partagé entre le bouton manuel (``_postmortem_work``, qui recharge depuis
    le disque avant d'appeler — une requête séparée, longtemps après la
    clôture) et le déclenchement AUTOMATIQUE (LOT 3, C1, ``_maybe_auto_postmortem``
    — qui capture le ``portfolio`` de la requête EN COURS). La distinction
    compte : un job détaché qui rechargerait le disque pour un trade qui
    vient tout juste de se clôturer courrait après une sauvegarde pas encore
    écrite (``_save`` n'a lieu qu'APRÈS ``_attach_trade_extras``, plus loin
    dans l'endpoint) — mesuré en test, le job atterrissait sur un
    portefeuille vide et rendait 404.
    """
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
                                    lang=normalize_lang(lang))
    except RuntimeError as e:
        raise HTTPException(status_code=502, detail=str(e)[:300])

    r_multiple = trade.get("r_multiple")
    label = "%s %s" % (trade.get("symbol") or "?",
                       "?R" if r_multiple is None else "%+.2fR" % r_multiple)
    _append_journal(username, label, text, _now_iso())
    return {"postmortem": text, "trade": trade, "trade_index": index}


def _postmortem_work(username: str, data: PostmortemPayload) -> Dict[str, Any]:
    """Le travail de ``/postmortem`` — exécuté en ligne ou dans un fil.

    Les 404 (aucun trade, trade introuvable) sont levés ICI, donc DANS le
    travail : la relève les rend tels quels, code compris.

    Recharge le portefeuille depuis le DISQUE : c'est une requête MANUELLE,
    une action séparée de celle qui a clôturé le trade, potentiellement
    longtemps après — contrairement au déclenchement automatique (LOT 3, C1),
    cf. ``_postmortem_core``.
    """
    portfolio = _load(username)
    if not portfolio.trades:
        raise HTTPException(status_code=404, detail="Aucun trade clôturé à analyser.")

    index = len(portfolio.trades) - 1 if data.trade_index is None else int(data.trade_index)
    if index < 0:
        index += len(portfolio.trades)
    return _postmortem_core(username, portfolio, index, data.lang)


@router.post("/analysis")
def paper_analysis(data: AnalysisPayload, sync: bool = False,
                   current_user: User = Depends(require_role("admin", "money", "trader"))):
    """Fiche pédagogique d'un titre : les chiffres ET leur lecture, sans opinion.

    DÉTACHÉ par défaut ; ``?sync=1`` pour l'ancien comportement en ligne.
    """
    return _job_or_sync(sync, current_user.username,
                        lambda: _analysis_work(data))


def _analysis_work(data: AnalysisPayload) -> Dict[str, Any]:
    """Le travail de ``/analysis`` — le seul des six qui ne touche à aucune
    mémoire d'utilisateur (il lit une cotation et fait rédiger).

    Le symbole passe par :func:`quotes.canonical` (alias -> symbole Yahoo).
    """
    symbol = quotes.canonical(data.symbol)
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
# Endpoints — LOT 3, A3 : le « bar replay » (entraînement)
#
# Trois endpoints, aucun LLM : ``replay.py`` est PUR, tout ce qui touche au
# réseau (le choix du symbole, ses bougies) vit ICI.
# --------------------------------------------------------------------------- #

# Fenêtre journalière assez longue pour couvrir large des séries de 90+
# bougies pour la quasi-totalité des ~40 titres de la table — 5 ans en
# quotidien, même fenêtre que ``CANDLE_RANGES`` en propose de toute façon.
REPLAY_RANGE = "5y"
REPLAY_INTERVAL = "1d"

# Un symbole introuvable/trop jeune (IPO récente) ne doit pas faire échouer
# tout de suite : on en tente un autre, borné — jamais une boucle qui
# ratisserait toute la table à chaque requête.
REPLAY_MAX_ATTEMPTS = 3


def _new_rng() -> random.Random:
    """Source d'aléa de la fenêtre d'entraînement. Fonction MODULE,
    monkeypatchable (même patron que ``_now_iso``) — les tests substituent un
    générateur déterministe sans jamais toucher au module ``random`` global."""
    return random.Random()


def _replay_symbol_pool() -> List[str]:
    """Symboles de l'univers du jeu (~40 méga-capitalisations, la même table
    que la reconnaissance de titres dans un texte) — accès PUBLIC via
    ``entities.known_symbols()``, jamais ``entities._COMPANIES`` directement."""
    return list(entities.known_symbols())


class ReplayLogPayload(BaseModel):
    id: str = ""
    decisions: List[Dict[str, Any]] = []
    # Facultatifs : le client peut les envoyer pour SON propre affichage en
    # direct pendant la partie, mais ce qui est ARCHIVÉ est TOUJOURS recalculé
    # par ``replay.grade`` côté serveur à partir de ``decisions`` — un seul
    # calcul fait foi, jamais deux qui pourraient diverger.
    pnl_pct: Optional[float] = None
    hold_pnl_pct: Optional[float] = None


@router.get("/replay/window")
def paper_replay_window(
        current_user: User = Depends(require_role("admin", "money", "trader"))):
    """Une fenêtre d'entraînement : 60 bougies visibles + 20 à révéler d'un
    titre réel PIOCHÉ AU HASARD dans l'univers de la toile.

    ``reveal`` porte le symbole ET les 20 bougies cachées — exposé au client
    dès cette réponse (cf. la doctrine « pas d'anti-triche » de ``replay.py``,
    documentée en tête de ce module).
    """
    pool = _replay_symbol_pool()
    rng = _new_rng()
    last_detail = "aucun titre exploitable pour l'instant."
    for _ in range(REPLAY_MAX_ATTEMPTS):
        symbol = rng.choice(pool)
        try:
            candles = quotes.get_candles(symbol, REPLAY_RANGE, REPLAY_INTERVAL)
            window = replay.make_window(candles, rng)
        except (quotes.QuoteError, quotes.UnknownSymbol, ValueError) as e:
            last_detail = str(e)[:200]
            continue
        return {
            "id": uuid.uuid4().hex,
            "candles": window["candles"],
            "reveal": {"candles": window["reveal"], "symbol": symbol,
                      "period": REPLAY_INTERVAL},
        }
    raise HTTPException(status_code=503,
                        detail="Aucune fenêtre d'entraînement disponible pour "
                               "l'instant (%s)" % last_detail)


@router.post("/replay/log")
def paper_replay_log(data: ReplayLogPayload,
                     current_user: User = Depends(require_role("admin", "money", "trader"))):
    """Archive une session d'entraînement terminée. Plafonné à
    :data:`replay.MAX_REPLAY_SESSIONS` (les plus RÉCENTES) — le journal sert à
    mesurer une tendance, pas à archiver une vie entière de parties."""
    username = current_user.username
    graded = replay.grade({"decisions": data.decisions})
    entry = {
        "id": str(data.id or "")[:64],
        "ts": _now_iso(),
        "pnl_pct": graded["pnl_pct"],
        "hold_pnl_pct": graded["hold_pnl_pct"],
        "n_decisions": graded["n_decisions"],
    }
    sessions = ([entry] + store.load_replay_sessions(username))[:replay.MAX_REPLAY_SESSIONS]
    store.save_replay_sessions(username, sessions)
    return {"session": entry}


@router.get("/replay/stats")
def paper_replay_stats(
        current_user: User = Depends(require_role("admin", "money", "trader"))):
    """Statistiques cumulées du journal d'entraînement de l'utilisateur."""
    sessions = store.load_replay_sessions(current_user.username)
    return replay.stats(sessions)


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
        events = list(module.recent_events(current_user.username) or [])
        _enrich_titles(events, key="title")
        return {"events": events}
    except Exception as e:                      # noqa: BLE001 - veille best-effort
        logger.warning("paper: veille news indisponible: %s", e)
        return {"events": [], "error": str(e)[:200]}


def _convergence():
    """Le module de convergence (digest Telegram), importé paresseusement."""
    from backend.bots.paper import convergence
    return convergence


def _translate():
    """Le module de traduction des titres étrangers, importé paresseusement
    (même patron que ``_convergence``/``_newswatch`` : un confort d'affichage
    ne doit jamais empêcher le router de vivre sans lui)."""
    from backend.bots.paper import translate
    return translate


def _enrich_titles(items: Any, key: str = "label") -> None:
    """Ajoute ``title_fr``/``src_lang`` EN PLACE aux items dont le titre a une
    traduction en cache -- lecture disque PURE, ZÉRO LLM dans le chemin de
    rendu (doctrine du module : « économie LLM par construction » -- le sweep
    qui PEUPLE ce cache tourne à part, cf. ``newswatch._run_translate_sweep``).

    ``key`` vaut ``"label"`` pour les nœuds de toile (``/graph``,
    ``/graph/grove``, ``/digest/{ref}/graph`` -- même forme de nœud partout,
    cf. ``graph._event_node``/``convergence._entry_node``) et ``"title"``
    pour les items compacts du journal des convergences (``/digest``, cf.
    ``convergence.history_items``) -- deux vocabulaires pour le même concept,
    jamais mélangés dans ce dépôt.

    Cache chargé UNE SEULE FOIS ici, jamais par item : une toile ou un
    bosquet peut porter des dizaines de nœuds. L'ORIGINAL n'est JAMAIS
    modifié -- une traduction est une transformation, pas un remplacement
    (piège Market Pulse #68k) : le frontend doit pouvoir montrer les deux.

    Best-effort : module absent ou cache illisible -> les items ressortent
    intacts, jamais un 500 pour un confort d'affichage.
    """
    if not items:
        return
    try:
        module = _translate()
        cache = module.load_cache()
    except Exception as e:                      # noqa: BLE001 - confort best-effort
        logger.warning("paper: cache de traduction indisponible: %s", e)
        return
    for item in items:
        if not isinstance(item, dict):
            continue
        text = item.get(key)
        if not text:
            continue
        try:
            hit = module.lookup(text, cache)
        except Exception as e:                  # noqa: BLE001 - confort best-effort
            logger.warning("paper: traduction illisible pour un titre: %s", e)
            continue
        if hit:
            item["title_fr"] = hit.get("fr")
            item["src_lang"] = str(hit.get("src") or "").upper()


@router.get("/digest")
def paper_digest(current_user: User = Depends(require_role("admin", "money", "trader"))):
    """Historique des digests de convergence. Best-effort comme ses voisins.

    Chaque entrée porte désormais ses ``items`` — les pièces qui ont déclenché
    ce digest, figées au moment du tir. C'est ce qui rend le journal cliquable
    (le mini-graphe d'une entrée se demande à ``/digest/{ref}/graph``). Les
    entrées d'avant le 27/08 n'en ont pas : le champ est simplement absent.
    """
    try:
        module = _convergence()
    except ImportError:
        return {"history": []}
    try:
        result = module.recent()
    except Exception as e:                      # noqa: BLE001 - lecture best-effort
        logger.warning("paper: convergence indisponible: %s", e)
        return {"history": [], "error": str(e)[:200]}
    # Traduction des titres allemands -- ce sont CES items (``_convItem`` côté
    # frontend) qui affichent « les éléments un par un » du journal, cf.
    # ``_enrich_titles``.
    for entry in (result.get("history") or []):
        if isinstance(entry, dict):
            _enrich_titles(entry.get("items"), key="title")
    return result


def _digest_entry(module: Any, ref: str) -> Optional[Dict[str, Any]]:
    """L'entrée d'historique désignée par ``ref`` — un INDEX ou un horodatage.

    Les deux formes parce que les deux sont naturelles côté client : la liste
    est rendue dans l'ordre, donc l'index suffit ; mais l'horodatage est la
    seule clé qui reste JUSTE quand un nouveau digest est parti entre
    l'affichage de la liste et le clic (l'index, lui, a glissé d'un cran).
    """
    history = [h for h in (module.load_state().get("history") or [])
               if isinstance(h, dict)]
    ref = str(ref or "").strip()
    if not ref:
        return None
    try:
        index = int(ref)
    except (TypeError, ValueError):
        for entry in history:
            if str(entry.get("ts") or "") == ref:
                return entry
        return None
    if index < 0:
        index += len(history)
    return history[index] if 0 <= index < len(history) else None


@router.get("/digest/{ref}/graph")
def paper_digest_graph(ref: str,
                       current_user: User = Depends(require_role("admin", "money", "trader"))):
    """Le MINI-GRAPHE d'UNE convergence : ce qui a été dit, et les liens entre.

    ``ref`` est l'index dans l'historique (0 = le plus récent) ou l'horodatage
    ``ts`` de l'entrée. Mêmes types de nœuds et d'arêtes que la grande toile
    (``/graph``), pour que le frontend le dessine avec le même code.

    Une entrée ANTÉRIEURE à ce lot n'a pas gardé ses pièces : elle rend un
    graphe vide marqué ``legacy: true``. Le client peut alors le DIRE, au lieu
    d'afficher un vide qui se lirait « cette convergence ne reposait sur rien ».

    Entrée introuvable -> 404. Module absent -> 503 : on a demandé quelque chose
    de précis, rendre un graphe vide ferait passer une panne pour un fait.
    """
    try:
        module = _convergence()
    except ImportError:
        raise HTTPException(status_code=503,
                            detail="La convergence n'est pas déployée sur ce serveur.")
    try:
        entry = _digest_entry(module, ref)
    except Exception as e:                      # noqa: BLE001 - lecture best-effort
        logger.warning("paper: historique de convergence illisible: %s", e)
        raise HTTPException(status_code=503, detail="Historique illisible.")
    if entry is None:
        raise HTTPException(status_code=404, detail="Convergence introuvable.")
    built = module.entry_graph(entry)
    _enrich_titles(built.get("nodes"))
    return {"ts": entry.get("ts") or "", "factors": entry.get("factors") or [],
            "n_items": entry.get("n_items") or 0,
            "nodes": built.get("nodes") or [], "edges": built.get("edges") or [],
            "legacy": bool(built.get("legacy"))}


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


def _calendar():
    """Le module du calendrier (rendez-vous datés + verdict du jour J), importé
    paresseusement — même esprit que ses voisins."""
    from backend.bots.paper import calendar as calendar_module
    return calendar_module


@router.get("/calendar")
def paper_calendar(current_user: User = Depends(require_role("admin", "money", "trader"))):
    """Les rendez-vous que le simulateur a NOTÉS À L'AVANCE, et ce qu'ils ont
    donné — LECTURE PURE.

    Trois familles, assemblées par le module : les réunions de banque centrale,
    les échéances des hypothèses ouvertes (le jour où le pari se juge), et les
    catalyseurs dont une dépêche portait une date lisible. Chaque entrée échue
    porte son verdict (``flop``/``confirme``/``mitige``) et le mouvement chiffré
    du titre.

    Le calendrier est DÉRIVÉ : il n'est stocké nulle part, il est recalculé à
    chaque lecture depuis les mémoires qui existent déjà. Seuls les VERDICTS
    sont persistés — parce qu'eux, on ne peut plus les recalculer une fois le
    jour passé (les cours d'hier ne reviennent pas).

    Best-effort comme ses voisins : module absent ou état illisible -> liste
    vide, jamais un 500. Un tableau de bord ne tombe pas parce qu'un site de
    banque centrale a hoqueté.
    """
    try:
        module = _calendar()
    except ImportError:
        return {"entries": []}
    try:
        return {"entries": list(module.calendar_view() or [])}
    except Exception as e:                      # noqa: BLE001 - lecture best-effort
        logger.warning("paper: calendrier indisponible: %s", e)
        return {"entries": [], "error": str(e)[:200]}


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

    Sous ``_BACKFILL_LOCK`` et NON ``_WRITE_LOCK`` : ``backfill_symbol`` fait
    des requêtes réseau (plusieurs secondes) avant de réécrire son état, qu'il
    a relu au début. Le mettre sous le verrou des écritures rapides
    sérialiserait deux travaux détachés pendant tout ce réseau, pour rien. Les
    deux verrous ne sont JAMAIS imbriqués — aucun interblocage possible.
    """
    try:
        backfill_mod = _backfill()
    except ImportError:
        return []
    with _BACKFILL_LOCK:
        return _backfill_new_tickers_locked(backfill_mod, ideas, fetch, sleep)


def _backfill_new_tickers_locked(backfill_mod: Any, ideas: Any,
                                 fetch: Optional[Callable[[str], str]],
                                 sleep: Optional[Callable[[float], None]]
                                 ) -> List[str]:
    """Le corps de ``_backfill_new_tickers``, VERROU TENU."""
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

    symbol = quotes.canonical(data.symbol if data else None)
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
    wanted = quotes.canonical(symbol)
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

    Quatre champs ADDITIFS portent le CONSEIL structuré (``stop``,
    ``risk_pct``, ``invalidated_if``, ``why_now``) — TOLÉRANTS : absents,
    vides ou mal typés -> ``None``, jamais une exception. Ils traversent tels
    quels vers le journal (``idea_journal.append_entry`` stocke l'idée
    entière) puis vers ``/ideas/for-symbol``, qui les sert à la pop-up « le
    coach sur <symbole> ». Une réponse d'AVANT cet enrichissement (ou un
    modèle qui les oublie) reste un idée valide, juste sans conseil détaillé.
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
            "stop": _optional_text(item.get("stop")),
            "risk_pct": _optional_float(item.get("risk_pct")),
            "invalidated_if": _optional_text(item.get("invalidated_if")),
            "why_now": _optional_text(item.get("why_now")),
        })
    return out


def _optional_text(value: Any) -> Optional[str]:
    """``str`` nettoyée, ou ``None`` si vide/absente — jamais une chaîne vide
    qui se lirait comme un vrai conseil (utilisé par ``_parse_ideas_json``)."""
    text = str(value or "").strip()
    return text or None


def _optional_float(value: Any) -> Optional[float]:
    """``float``, ou ``None`` si absente/illisible — TOLÉRANT (utilisé par
    ``_parse_ideas_json`` pour ``risk_pct``, un champ que le modèle peut
    laisser vide ou écrire en texte libre)."""
    if value is None:
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


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


# Plafond des dépêches recopiées dans le PROMPT du coach (``/ideas`` et
# ``/board/scenarios/generate``).
#
# Posé le 27/08 en même temps que le passage de ``newswatch._MAX_EVENTS`` de
# 100 à 300. Tous les autres consommateurs de la veille bornent par le TEMPS
# (48 h pour la convergence, sept jours pour la toile) ; celui-ci recopiait la
# liste ENTIÈRE dans un prompt facturé au jeton. Sans plafond, tripler
# l'historique aurait triplé la facture de chaque appel au modèle — un effet de
# bord invisible à la lecture du diff de ``newswatch``.
#
# 200 = exactement le pire cas D'AVANT le bump (un état utilisateur de 100 plus
# l'état global de 100, que ``recent_events`` fusionne) : ce plafond ne retire
# rien de ce que le coach voyait hier, il empêche seulement la croissance. Et
# ``recent_events`` rend la liste triée du plus récent au plus ancien, donc
# tronquer garde les dépêches fraîches.
STRATEGY_NEWS_CAP = 200


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


# En dessous, une émotion n'a pas assez de trades pour dire quoi que ce soit
# — même seuil que la mission (LOT 2, B3) : « n>=3 ».
MIN_EMOTION_PATTERN_N = 3


def _emotion_context_lines(trades: List[Dict[str, Any]]) -> List[str]:
    """Résumé COMPACT des émotions d'entrée significatives (LOT 2, B3).

    Le coach VOIT la corrélation émotion -> résultat déjà calculée (même
    doctrine que le reste de ``_strategy_context`` : des faits, jamais un
    calcul délégué au LLM). ``untagged`` est toujours écarté : on ne sait pas
    CE QUI a été tagué, donc rien à en dire.
    """
    lines: List[str] = []
    for row in tradestats.emotion_breakdown(trades):
        if row["emotion"] == tradestats.UNTAGGED or row["n"] < MIN_EMOTION_PATTERN_N:
            continue
        avg_r = "?" if row["avg_r"] is None else ("%.2f" % row["avg_r"])
        lines.append("%s: %d trades, %.1f%% de réussite, R moyen %s"
                     % (row["emotion"], row["n"], row["winrate"], avg_r))
    return lines


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
    portfolio_dict = portfolio.to_dict()
    synced = _sync_coach(username, portfolio_dict, force=True)
    context = _coach_context(portfolio, synced["profile"], synced["biases"],
                             synced["stats"])
    context["watchlist"] = _watchlist_context(username)
    # LOT 2, B3 : la clé n'existe que s'il y a au moins une émotion
    # significative — même politique que ``agenda_macro`` un peu plus bas.
    emotion_patterns = _emotion_context_lines(portfolio_dict.get("trades") or [])
    if emotion_patterns:
        context["emotion_patterns"] = emotion_patterns
    context["radar_open_hypotheses"] = _open_radar_hypotheses()
    # ⚠️ PLAFONNÉ — cf. ``STRATEGY_NEWS_CAP``. C'est le seul consommateur de la
    # veille qui recopiait tout dans un PROMPT, et le seul qui ne bornait rien.
    context["recent_news"] = _recent_news(username)[:STRATEGY_NEWS_CAP]
    context["recent_filings"] = _recent_filings()
    context["recent_crypto"] = _recent_crypto(username)[:STRATEGY_NEWS_CAP]
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

    Sous ``_WRITE_LOCK`` : lire l'état du radar, compter les hypothèses
    ouvertes, ajouter, réécrire — deux travaux détachés qui s'entrelacent ici
    perdraient un lot d'idées ET fausseraient le décompte de ``MAX_OPEN``.
    """
    if not ideas:
        return []
    try:
        radar_module = _radar()
    except ImportError:
        return [dict(idea, tracked=False) for idea in ideas]

    with _WRITE_LOCK:
        return _register_radar_ideas_locked(radar_module, ideas, now_iso)


def _register_radar_ideas_locked(radar_module: Any, ideas: List[Dict[str, Any]],
                                 now_iso: str) -> List[Dict[str, Any]]:
    """Le corps de ``_register_radar_ideas``, VERROU TENU."""
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
            # LOT 5 — même hygiène qu'au point d'écriture du radar : un ticker
            # inventé par le modèle est marqué à la NAISSANCE, pas découvert
            # trois passes plus tard par une cotation qui échoue en silence.
            # Le surcoût (une cotation) est négligeable dans un endpoint qui
            # vient d'appeler un LLM.
            radar_module.mark_unquoted(hypotheses[-1])
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

    Sous ``_WRITE_LOCK`` : ``add_pipeline_item`` relit le tableau, dédoublonne
    par symbole actif, puis réécrit — sans verrou, deux travaux détachés se
    dédoublonnent l'un contre un tableau que l'autre est en train de remplacer.
    """
    for idea in ideas or []:
        if not idea.get("tracked"):
            continue
        try:
            with _WRITE_LOCK:
                board.add_pipeline_item(username, idea.get("ticker") or "",
                                        idea.get("thesis") or "", "coach",
                                        now_iso=_now_iso())
        except Exception as e:                  # noqa: BLE001 - tableau best-effort
            logger.warning("paper: idée %r non ajoutée au pipeline: %s",
                           idea.get("ticker"), e)


@router.post("/ideas")
def paper_ideas(data: IdeasPayload, sync: bool = False,
                current_user: User = Depends(require_role("admin", "money", "trader"))):
    """Idées de trade — DÉTACHÉ par défaut, ``?sync=1`` pour l'ancien
    comportement en ligne. Le travail est décrit par ``_ideas_work``."""
    username = current_user.username
    return _job_or_sync(sync, username, lambda: _ideas_work(username, data))


def _ideas_work(username: str, data: IdeasPayload) -> Dict[str, Any]:
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

    ⚠️ Sous ``_WRITE_LOCK``, et c'est ICI que ça compte le plus :
    ``append_entry`` relit tout le journal, ajoute en tête, réécrit — et nomme
    son fichier temporaire d'après le seul PID. Deux travaux détachés qui
    finissent ensemble ne perdraient pas seulement une entrée, ils se
    marcheraient dessus dans le même temporaire.
    """
    try:
        with _WRITE_LOCK:
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


_ADVICE_STRUCTURED_FIELDS = ("stop", "risk_pct", "invalidated_if", "why_now")


def _add_advice(row: Dict[str, Any], idea: Dict[str, Any],
                entry: Dict[str, Any], ticker: str) -> None:
    """Ajoute le CONSEIL du coach à une ligne ``from: "journal"`` — MUTE
    ``row``, ne rend rien (patron des ajouts conditionnels de cet endpoint,
    cf. le ``risk_level`` du bloc radar juste au-dessus).

    Deux sources, jamais les deux à la fois :

    1. les champs STRUCTURÉS de l'idée (schéma JSON enrichi, cf.
       ``_parse_ideas_json``) — quand au moins un existe, ils suffisent : le
       frontend les affiche en lignes compactes ;
    2. à défaut (idée journalisée AVANT l'enrichissement, ou modèle qui les a
       oubliés), le PARAGRAPHE du texte complet qui parle de ce ticker
       (``idea_journal.advice_from_text``) — c'est le même conseil, juste pas
       encore découpé par titre.

    Rien de tout ça -> ``row`` reste tel quel (pas de clé ``advice`` vide qui
    ferait afficher un cadre sans contenu).
    """
    structured = {field: idea.get(field) for field in _ADVICE_STRUCTURED_FIELDS}
    if any(value not in (None, "") for value in structured.values()):
        for field, value in structured.items():
            if value not in (None, ""):
                row[field] = value
        return
    advice = idea_journal.advice_from_text(entry.get("text"), ticker)
    if advice:
        row["advice"] = advice


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

    Le symbole passe par :func:`quotes.canonical` — cohérent avec le reste des
    endpoints, même si les tickers du radar/journal sont déjà écrits sous leur
    forme canonique depuis la création de l'ordre ou de l'idée.
    """
    wanted = quotes.canonical(symbol)
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
            row = {
                "from": "journal",
                "ts": ts,
                "risk_level": idea.get("risk_level") or entry.get("risk_level"),
                "direction": idea.get("direction"),
                "horizon_days": idea.get("horizon_days"),
                "thesis": idea.get("thesis"),
                "tracked": bool(idea.get("tracked")),
            }
            _add_advice(row, idea, entry, wanted)
            items.append(row)
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
def paper_positions_review(data: ReviewPayload, sync: bool = False,
                           current_user: User = Depends(require_role("admin", "money", "trader"))):
    """Revue des positions détenues — DÉTACHÉ par défaut, ``?sync=1`` pour
    l'ancien comportement en ligne. Le travail est décrit par
    ``_positions_review_work``."""
    username = current_user.username
    return _job_or_sync(sync, username,
                        lambda: _positions_review_work(username, data))


def _positions_review_work(username: str, data: ReviewPayload) -> Dict[str, Any]:
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
    liste inchangée) — dédoublonnage CASE-INSENSITIVE.

    Le symbole passe par :func:`quotes.canonical` : la ligne est stockée sous
    le symbole CANONIQUE, jamais sous un alias.
    """
    symbol = quotes.canonical(data.symbol)
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
    """Retire un titre de la watchlist. 404 s'il n'y était pas.

    Le symbole passe par :func:`quotes.canonical` — symétrique de l'ajout.
    """
    username = current_user.username
    wanted = quotes.canonical(symbol)
    symbols = store.load_watchlist(username)
    remaining = [row for row in symbols
                if str(row.get("symbol") or "").upper() != wanted]
    if len(remaining) == len(symbols):
        raise HTTPException(status_code=404, detail="Titre absent de la liste de suivi.")
    store.save_watchlist(username, remaining)
    return {"symbols": remaining}


# --------------------------------------------------------------------------- #
# Endpoints — alertes de prix personnalisées (A1)
#
# Vérifiées par ``newswatch._run_price_alerts_volet`` (cycle du guetteur,
# toutes les 5 min) — ce router ne fait que CRUD + le garde-fou de création
# (« ne tire pas à la seconde où on la pose »).
# --------------------------------------------------------------------------- #

@router.post("/alerts")
def paper_create_alert(data: AlertPayload,
                       current_user: User = Depends(require_role("admin", "money", "trader"))):
    """Pose une alerte de prix. Refuse une condition DÉJÀ vraie au moment de
    la création (une alerte qui tire à la seconde où on la pose ne sert à
    rien) — mais un cours introuvable n'empêche PAS d'armer : mieux vaut une
    alerte posée que pas d'alerte du tout parce que Yahoo hoquette."""
    symbol = quotes.canonical(data.symbol)
    if not symbol:
        raise HTTPException(status_code=400, detail="Symbole manquant.")
    if not price_alerts.is_valid_op(data.op):
        raise HTTPException(status_code=400,
                            detail="Condition invalide (au-dessus / en dessous attendu).")
    if data.price is None or data.price <= 0:
        raise HTTPException(status_code=400, detail="Prix invalide.")

    username = current_user.username
    rows = store.load_alerts(username)
    if price_alerts.active_count(rows) >= MAX_ALERTS:
        raise HTTPException(status_code=400,
                            detail="Trop d'alertes actives (%d maximum)." % MAX_ALERTS)

    current_price = None
    try:
        current_price = quotes.get_quote(symbol).get("price")
    except quotes.QuoteError:
        current_price = None      # cours indisponible -> on arme quand même
    if current_price is not None and price_alerts.condition_met(
            data.op, current_price, data.price):
        raise HTTPException(
            status_code=400,
            detail="Le cours (%s) est déjà au-delà de ce niveau." % current_price)

    alert = price_alerts.new_alert(uuid.uuid4().hex[:8], symbol, data.op,
                                   data.price, _now_iso())
    rows.append(alert)
    store.save_alerts(username, rows)
    return {"alert": alert, "alerts": rows}


@router.get("/alerts")
def paper_list_alerts(current_user: User = Depends(require_role("admin", "money", "trader"))):
    """Les alertes de prix de l'utilisateur, telles quelles."""
    return {"alerts": store.load_alerts(current_user.username)}


@router.delete("/alerts/{alert_id}")
def paper_delete_alert(alert_id: str,
                       current_user: User = Depends(require_role("admin", "money", "trader"))):
    """Retire une alerte (armée ou déjà déclenchée). 404 si l'id est inconnu."""
    username = current_user.username
    rows = store.load_alerts(username)
    remaining = [row for row in rows if str(row.get("id")) != str(alert_id)]
    if len(remaining) == len(rows):
        raise HTTPException(status_code=404, detail="Alerte introuvable.")
    store.save_alerts(username, remaining)
    return {"alerts": remaining}


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

    Le symbole passe par :func:`quotes.canonical` (alias -> symbole Yahoo).
    """
    symbol = quotes.canonical(data.symbol)
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
def paper_board_scenarios_generate(data: BoardScenarioPayload, sync: bool = False,
                                   current_user: User = Depends(require_role("admin", "money", "trader"))):
    """Arbre de scénarios — DÉTACHÉ par défaut, ``?sync=1`` pour l'ancien
    comportement en ligne. Le travail est décrit par ``_scenarios_work``."""
    username = current_user.username
    return _job_or_sync(sync, username, lambda: _scenarios_work(username, data))


def _scenarios_work(username: str, data: BoardScenarioPayload) -> Dict[str, Any]:
    """Le coach dessine un arbre de chemins possibles pour le marché.

    Contexte assemblé comme ``/ideas`` (``_strategy_context``) + le pipeline en
    cours : les futurs achats notés font partie de ce qui est en jeu.

    L'arbre est normalisé et rangé côté serveur (identifiants, statuts, dates
    — jamais lus du modèle). Réponse illisible (pas d'arbre exploitable) ->
    502, comme une panne du LLM : mieux vaut le dire que d'afficher un
    demi-arbre.
    """
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

    # Sous ``_WRITE_LOCK`` : ``add_scenario`` relit le tableau et le réécrit.
    with _WRITE_LOCK:
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
                 now_iso: Optional[str] = None,
                 name: Optional[str] = None) -> Dict[str, Any]:
    """Assemble puis construit — le chemin COMMUN au graphe et au compteur.

    ``now_iso`` vient de l'appelant pour que la fenêtre de fraîcheur et le
    ``generated_at`` de la réponse parlent du MÊME instant.

    ``name`` (optionnel) n'intervient QUE pour une branche précise (``symbol``
    non vide) dont l'ancre EXACTE est vide : cf. :func:`_resolve_via_company`.
    Sans ``symbol`` (vue d'ensemble), un nom n'a rien à y résoudre.
    """
    data = _graph_inputs(username)
    now_iso = now_iso or _now_iso()
    built = graph.build_graph(data["anchors"], data["events"], data["hypotheses"],
                              data["whale_moves"], data["pipeline"], now_iso,
                              symbol=symbol, reddit_trends=data["reddit_trends"])
    if symbol and not built.get("nodes") and name:
        via = _resolve_via_company(data, symbol, name, now_iso)
        if via is not None:
            built = via
    return built


def _resolve_via_company(data: Dict[str, Any], wanted: str, name: str,
                         now_iso: str) -> Optional[Dict[str, Any]]:
    """Retente la branche d'un symbole FRÈRE de la même société, trouvé par
    NOM (``entities.py``) — ``None`` si rien ne fait mieux que la branche déjà
    vide de ``wanted``.

    Vécu : chercher « nestlé » peut faire tomber sur ``NSRGY`` (ADR US, OTC)
    alors que positions/watchlist/pipeline ne connaissent le titre QUE sous
    ``NESN.SW`` (SIX) — c'est le symbole réellement négocié, pas tous les
    tickers d'une même société. Le symbole EXACT reste toujours prioritaire
    (déjà tenté par l'appelant) ; ceci n'est qu'un second essai.

    ⚠️ PAS un alias de PRIX : NSRGY et NESN.SW sont deux instruments réels, en
    deux devises différentes (cf. ``quotes.SYMBOL_ALIASES`` — décision
    explicite de ne PAS les confondre). Cette résolution ne touche QUE la
    toile (dépêches/hypothèses/mouvements déjà rattachés au symbole ancré),
    jamais un cours.

    ``entities.anchor_index`` (les ancres de l'utilisateur) PRIME sur la table
    livrée : si Massii suit une société sous un nom qui lui est propre, c'est
    CE symbole qui doit sortir en premier.
    """
    try:
        extra = entities.anchor_index(data["anchors"])
        candidates = entities.detect_companies(name, extra=extra)
    except Exception as e:                      # noqa: BLE001 — best-effort
        logger.warning("paper: résolution par société indisponible pour %r: %s",
                       name, e)
        return None
    for candidate in candidates:
        candidate = str(candidate or "").strip().upper()
        if not candidate or candidate == wanted:
            continue
        alt = graph.build_graph(data["anchors"], data["events"], data["hypotheses"],
                                data["whale_moves"], data["pipeline"], now_iso,
                                symbol=candidate, reddit_trends=data["reddit_trends"])
        if alt.get("nodes"):
            alt = dict(alt, via_symbol=candidate)
            return alt
    return None


@router.get("/graph")
def paper_graph(symbol: str = "", name: str = "",
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

    ``name`` (optionnel, ex. « Nestlé S.A. ») : si la branche exacte est vide,
    on retente via le symbole d'une société repérée dans ce nom
    (``entities.py``) — cf. :func:`_resolve_via_company`. La réponse porte
    alors ``via_symbol`` en plus, pour que le frontend le dise. Rien trouvé ->
    comportement inchangé.
    """
    wanted = quotes.canonical(symbol)
    now_iso = _now_iso()
    built = _build_graph(current_user.username, wanted or None, now_iso,
                         name=str(name or "").strip() or None)
    _enrich_titles(built.get("nodes"))
    out = {"nodes": built["nodes"], "edges": built["edges"],
          "truncated": built["truncated"], "generated_at": now_iso}
    if built.get("via_symbol"):
        out["via_symbol"] = built["via_symbol"]
    return out


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
    _enrich_titles(built.get("items"))
    return {"kind": built["kind"], "items": built["items"],
            "total": built["total"]}


@router.get("/graph/count")
def paper_graph_count(symbol: str = "", name: str = "",
                      current_user: User = Depends(require_role("admin", "money", "trader"))):
    """Combien de connexions la mémoire porte sur CE titre — réponse minimale,
    faite pour un pastillage (« N connexions en mémoire ») sans transporter tout
    le graphe. Même assemblage que ``/graph`` (``name`` compris) : les deux ne
    peuvent pas diverger — sinon le chip resterait à zéro pendant que le
    dessin, lui, trouve une branche via le nom."""
    wanted = quotes.canonical(symbol)
    if not wanted:
        raise HTTPException(status_code=400, detail="Symbole manquant.")
    built = _build_graph(current_user.username, wanted,
                         name=str(name or "").strip() or None)
    nodes = built["nodes"]
    # ``nodes`` = l'ancre + ses voisins (vide si le titre n'est pas une ancre).
    # Les nœuds de THÈME sont des intercalaires de mise en forme, pas des
    # connexions : les compter ferait grimper « N connexions en mémoire » sans
    # qu'une seule information de plus soit arrivée.
    real = [n for n in nodes if n.get("type") != graph.THEME_TYPE]
    out = {"count": max(0, len(real) - 1)}
    if built.get("via_symbol"):
        out["via_symbol"] = built["via_symbol"]
    return out
