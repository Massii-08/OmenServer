"""
Diagnostic automatique — Analyse la santé du système et des serveurs.

Vérifie CPU, RAM, disque, conteneurs Docker et réseau.
Retourne une liste de diagnostics avec niveau (ok, warning, critical) et suggestions.

Routes:
    GET /api/diagnostic  → Lancer un diagnostic complet
"""

import logging
import psutil

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from backend.database import get_db
from backend.auth.utils import get_current_user
from backend.auth.models import User
from backend.game_server.models import GameServer
from backend.game_server import docker_manager

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api", tags=["Diagnostic"])


@router.get("/diagnostic")
def run_diagnostic(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Diagnostic complet du système et des serveurs."""
    checks = []

    # --- CPU ---
    cpu = psutil.cpu_percent(interval=0.5)
    if cpu > 90:
        checks.append({"id": "cpu", "name": "CPU", "icon": "⚡", "level": "critical",
            "value": f"{cpu}%", "message": "CPU surchargé ! Les serveurs risquent de laguer.",
            "suggestion": "Arrêtez un serveur ou réduisez les limites CPU dans Paramètres > Hébergement."})
    elif cpu > 70:
        checks.append({"id": "cpu", "name": "CPU", "icon": "⚡", "level": "warning",
            "value": f"{cpu}%", "message": "CPU en charge élevée.",
            "suggestion": "Surveillez la charge. Si ça persiste, réduisez le nombre de serveurs actifs."})
    else:
        checks.append({"id": "cpu", "name": "CPU", "icon": "⚡", "level": "ok",
            "value": f"{cpu}%", "message": "Charge CPU normale."})

    # --- RAM ---
    mem = psutil.virtual_memory()
    # Calcul cohérent : used/total (et non (total-available)/total de psutil)
    ram_pct = round((mem.used / mem.total) * 100, 1) if mem.total > 0 else 0
    ram_avail_gb = round(mem.available / (1024**3), 1)
    if ram_pct > 90:
        checks.append({"id": "ram", "name": "RAM", "icon": "🧠", "level": "critical",
            "value": f"{ram_pct}% ({ram_avail_gb} Go libre)",
            "message": "Mémoire presque pleine ! Risque de crash.",
            "suggestion": "Réduisez la RAM allouée aux serveurs (Paramètres > Hébergement) ou arrêtez des services."})
    elif ram_pct > 75:
        checks.append({"id": "ram", "name": "RAM", "icon": "🧠", "level": "warning",
            "value": f"{ram_pct}% ({ram_avail_gb} Go libre)",
            "message": "RAM en utilisation élevée.",
            "suggestion": "Vérifiez les sliders de RAM des serveurs. Java utilise souvent toute la RAM allouée."})
    else:
        checks.append({"id": "ram", "name": "RAM", "icon": "🧠", "level": "ok",
            "value": f"{ram_pct}% ({ram_avail_gb} Go libre)",
            "message": "Mémoire OK."})

    # --- Disque ---
    disk = psutil.disk_usage("/")
    # Calcul cohérent : used/total
    disk_pct = round((disk.used / disk.total) * 100, 1) if disk.total > 0 else 0
    disk_free_gb = round(disk.free / (1024**3), 1)
    if disk_pct > 90:
        checks.append({"id": "disk", "name": "Disque", "icon": "💾", "level": "critical",
            "value": f"{disk_pct}% ({disk_free_gb} Go libre)",
            "message": "Espace disque critique ! Les sauvegardes pourraient échouer.",
            "suggestion": "Supprimez d'anciennes sauvegardes ou des mondes inutilisés."})
    elif disk_pct > 75:
        checks.append({"id": "disk", "name": "Disque", "icon": "💾", "level": "warning",
            "value": f"{disk_pct}% ({disk_free_gb} Go libre)",
            "message": "Espace disque limité.",
            "suggestion": "Pensez à nettoyer les logs et les sauvegardes anciennes."})
    else:
        checks.append({"id": "disk", "name": "Disque", "icon": "💾", "level": "ok",
            "value": f"{disk_pct}% ({disk_free_gb} Go libre)",
            "message": "Espace disque suffisant."})

    # --- Docker ---
    client = docker_manager._get_docker_client()
    if client:
        try:
            containers = client.containers.list(all=True)
            running = [c for c in containers if c.status == "running"]
            stopped = [c for c in containers if c.status != "running"]
            checks.append({"id": "docker", "name": "Docker", "icon": "🐳", "level": "ok",
                "value": f"{len(running)} actif(s), {len(stopped)} arrêté(s)",
                "message": f"Docker opérationnel. {len(containers)} conteneur(s) total."})
        except Exception as e:
            checks.append({"id": "docker", "name": "Docker", "icon": "🐳", "level": "critical",
                "value": "Erreur", "message": f"Erreur Docker: {e}",
                "suggestion": "Vérifiez que Docker Desktop est lancé."})
    else:
        checks.append({"id": "docker", "name": "Docker", "icon": "🐳", "level": "critical",
            "value": "Non connecté", "message": "Docker n'est pas accessible.",
            "suggestion": "Lancez Docker Desktop ou vérifiez le socket Docker."})

    # --- Serveurs de jeux ---
    servers = db.query(GameServer).all()
    crashed = []
    for s in servers:
        if s.docker_id and client:
            try:
                c = client.containers.get(s.docker_id)
                if c.status == "exited":
                    # Vérifier si crash (exit code != 0)
                    info = c.attrs.get("State", {})
                    exit_code = info.get("ExitCode", 0)
                    if exit_code != 0:
                        crashed.append(f"{s.name} (code {exit_code})")
            except Exception:
                pass

    if crashed:
        checks.append({"id": "servers", "name": "Serveurs", "icon": "🎮", "level": "warning",
            "value": f"{len(crashed)} crash(es)",
            "message": f"Serveurs crashés: {', '.join(crashed)}",
            "suggestion": "Consultez les logs du serveur pour identifier le problème. Vérifiez la RAM allouée."})
    else:
        checks.append({"id": "servers", "name": "Serveurs", "icon": "🎮", "level": "ok",
            "value": f"{len(servers)} serveur(s)",
            "message": "Tous les serveurs fonctionnent normalement."})

    # --- Réseau ---
    try:
        net = psutil.net_io_counters()
        checks.append({"id": "network", "name": "Réseau", "icon": "🌐", "level": "ok",
            "value": f"↓ {round(net.bytes_recv / (1024**3), 1)} Go / ↑ {round(net.bytes_sent / (1024**3), 1)} Go",
            "message": "Interface réseau active."})
    except Exception:
        checks.append({"id": "network", "name": "Réseau", "icon": "🌐", "level": "warning",
            "value": "Inconnu", "message": "Impossible de lire les stats réseau."})

    # Score global
    levels = [c["level"] for c in checks]
    if "critical" in levels:
        overall = "critical"
    elif "warning" in levels:
        overall = "warning"
    else:
        overall = "ok"

    return {
        "overall": overall,
        "checks": checks,
        "total": len(checks),
        "ok": levels.count("ok"),
        "warnings": levels.count("warning"),
        "criticals": levels.count("critical"),
    }
