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

# Une venue = un snapshot (instances Oracle séparées ; 2026-07-20 Kalshi).
# Whitelist stricte -> aucun chemin dérivé d'une entrée utilisateur.
SNAPSHOTS = {
    "polymarket": Path(os.environ.get(
        "ORACLE_SNAPSHOT",
        str(Path.home() / "oracle" / "data" / "snapshot.json"))),
    "kalshi": Path(os.environ.get(
        "ORACLE_SNAPSHOT_KALSHI",
        str(Path.home() / "oracle" / "data" / "snapshot-kalshi.json"))),
    # Oracle MK (2026-07-30) : portefeuille papier maker/taker. Forme de
    # snapshot TOTALEMENT différente des deux autres (rules/verdict/execution
    # au lieu de health/bankroll/edges) -> le frontend a sa propre vue.
    "mk": Path(os.environ.get(
        "ORACLE_SNAPSHOT_MK",
        str(Path.home() / "oracle" / "data" / "snapshot-mk.json"))),
}


def _require_admin(user) -> None:
    if not getattr(user, "is_admin", False):
        raise HTTPException(status_code=403, detail="Admin uniquement")


def _read_snapshot(venue: str = "polymarket") -> dict:
    path = SNAPSHOTS.get(venue)
    if path is None:
        raise HTTPException(status_code=400, detail="Venue inconnue")
    if not path.is_file():
        raise HTTPException(
            status_code=404,
            detail="Snapshot Oracle introuvable — le bot n'a pas encore "
                   "écrit de cycle (ou Oracle n'est pas installé sur cette "
                   "machine).")
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as e:
        logger.error("oracle snapshot illisible: %s", e)
        raise HTTPException(status_code=500, detail="Snapshot Oracle illisible")


@router.get("/snapshot")
def oracle_snapshot(venue: str = "polymarket",
                    current_user: User = Depends(get_current_user)):
    """Dump complet : santé, verdict, portefeuille, marché, transactions,
    en-cours. Admin-only. ?venue=polymarket|kalshi (whitelist)."""
    _require_admin(current_user)
    return _read_snapshot(venue)


@router.get("/status")
def oracle_status(venue: str = "polymarket",
                  current_user: User = Depends(get_current_user)):
    """Résumé léger pour un badge/poll rapide (sans les gros tableaux)."""
    _require_admin(current_user)
    snap = _read_snapshot(venue)
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
