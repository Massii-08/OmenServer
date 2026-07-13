"""
oracle_router — dashboard READ-ONLY du bot Oracle (Polymarket × Deribit).

Le projet Oracle vit hors du repo OmenServer (~/oracle, timers systemd) et
écrit un snapshot JSON complet à chaque cycle (oracle/snapshot.py). Ce router
ne fait QUE lire ce fichier et l'exposer, admin-only. Zéro couplage au venv
Oracle, zéro subprocess, aucune écriture — pure lecture d'un JSON.

Le chemin par défaut suppose Oracle installé dans ~/oracle ; surchargable par
la variable d'env ORACLE_SNAPSHOT (le backend et Oracle tournent sur la même
machine, l'Omen).
"""

import json
import logging
import os
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException

from backend.auth.models import User
from backend.auth.utils import get_current_user

logger = logging.getLogger("omenserver")

router = APIRouter(prefix="/api/bots/oracle", tags=["Oracle"])

ORACLE_SNAPSHOT = Path(os.environ.get(
    "ORACLE_SNAPSHOT",
    str(Path.home() / "oracle" / "data" / "snapshot.json")))


def _require_admin(user) -> None:
    if not getattr(user, "is_admin", False):
        raise HTTPException(status_code=403, detail="Admin uniquement")


def _read_snapshot() -> dict:
    if not ORACLE_SNAPSHOT.is_file():
        raise HTTPException(
            status_code=404,
            detail="Snapshot Oracle introuvable — le bot n'a pas encore "
                   "écrit de cycle (ou Oracle n'est pas installé sur cette "
                   "machine).")
    try:
        return json.loads(ORACLE_SNAPSHOT.read_text(encoding="utf-8"))
    except (OSError, ValueError) as e:
        logger.error("oracle snapshot illisible: %s", e)
        raise HTTPException(status_code=500, detail="Snapshot Oracle illisible")


@router.get("/snapshot")
def oracle_snapshot(current_user: User = Depends(get_current_user)):
    """Dump complet : santé, verdict, portefeuille, marché, transactions,
    en-cours. Admin-only."""
    _require_admin(current_user)
    return _read_snapshot()


@router.get("/status")
def oracle_status(current_user: User = Depends(get_current_user)):
    """Résumé léger pour un badge/poll rapide (sans les gros tableaux)."""
    _require_admin(current_user)
    snap = _read_snapshot()
    health = snap.get("health", {})
    verdict = snap.get("verdict", {})
    bankroll = snap.get("bankroll", {})
    return {
        "generated_iso": snap.get("generated_iso"),
        "status": health.get("status"),
        "executor_mode": health.get("executor_mode"),
        "cycles_24h": health.get("cycles_24h"),
        "degraded_cycles": health.get("degraded_cycles"),
        "n_resolved": verdict.get("n_resolved"),
        "min_n": verdict.get("min_n"),
        "clusters": verdict.get("clusters"),
        "min_clusters": verdict.get("min_clusters"),
        "bankroll_final": bankroll.get("final"),
        "bankroll_net_pnl": bankroll.get("net_pnl"),
    }
