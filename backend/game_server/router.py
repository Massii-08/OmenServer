"""
Routes du Module Jeux — Gestion des serveurs de jeux via Docker.

Supporte n'importe quel jeu : Minecraft, ARK, Valheim, Terraria, CS2,
Palworld, Garry's Mod, ou un jeu personnalisé avec une image Docker.

Routes:
    GET    /api/servers/games          → Liste des jeux supportés
    GET    /api/servers/docker-status  → Vérifier si Docker est dispo
    GET    /api/servers/connection-info → IP locale pour se connecter
    GET    /api/servers               → Liste des serveurs
    POST   /api/servers               → Créer un serveur
    GET    /api/servers/{id}          → Détails d'un serveur
    POST   /api/servers/{id}/start    → Démarrer
    POST   /api/servers/{id}/stop     → Arrêter
    POST   /api/servers/{id}/restart  → Redémarrer
    GET    /api/servers/{id}/logs     → Logs console
    DELETE /api/servers/{id}          → Supprimer
"""

from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel
from sqlalchemy.orm import Session

from backend.database import get_db
from backend.auth.utils import get_current_user
from backend.auth.models import User
from backend.game_server.models import GameServer
from backend.game_server import docker_manager
from backend.game_server.games_config import get_all_games, get_game_config

router = APIRouter(prefix="/api/servers", tags=["Serveurs de jeux"])


# --- Schémas ---

class CreateServerRequest(BaseModel):
    """Données pour créer un nouveau serveur."""
    name: str
    game_type: str = "minecraft"
    version: str = "LATEST"
    port: Optional[int] = None        # None = utilise le port par défaut du jeu
    memory_mb: Optional[int] = None   # None = utilise la RAM par défaut du jeu
    custom_image: Optional[str] = None  # Pour game_type="custom"


class ServerResponse(BaseModel):
    """Réponse avec les infos d'un serveur."""
    id: int
    name: str
    game_type: str
    version: str
    port: int
    memory_mb: int
    status: str
    docker_id: Optional[str]

    class Config:
        from_attributes = True


# --- Routes ---

@router.get("/games")
def list_games(current_user: User = Depends(get_current_user)):
    """
    Retourne la liste de tous les jeux supportés.
    Le frontend utilise ça pour remplir le sélecteur de jeu.
    """
    return {"games": get_all_games()}


@router.get("/docker-status")
def docker_status(current_user: User = Depends(get_current_user)):
    """Vérifie si Docker est installé et lancé."""
    return {"available": docker_manager.is_docker_available()}


@router.get("/connection-info")
def connection_info(current_user: User = Depends(get_current_user)):
    """
    Retourne l'IP locale du serveur.
    Les joueurs utilisent cette IP pour se connecter aux serveurs de jeux.
    """
    return {"ip": docker_manager.get_local_ip()}


@router.get("/", response_model=list[ServerResponse])
def list_servers(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Retourne la liste de tous les serveurs de jeux."""
    servers = db.query(GameServer).all()

    for server in servers:
        if server.docker_id:
            ds = docker_manager.get_container_status(server.docker_id)
            real_status = ds.get("status", "unknown")
            if real_status == "running":
                server.status = "running"
            elif real_status in ("exited", "created"):
                server.status = "stopped"
            elif real_status == "not_found":
                server.status = "error"
            db.commit()

    return servers


@router.post("/", response_model=ServerResponse, status_code=status.HTTP_201_CREATED)
def create_server(
    request: CreateServerRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Crée un nouveau serveur de jeu (n'importe quel jeu supporté)."""
    # Récupérer la config du jeu pour les valeurs par défaut
    game_config = get_game_config(request.game_type)
    actual_port = request.port or game_config["default_port"]
    actual_memory = request.memory_mb or game_config["default_memory_mb"]

    # Vérifier que le port n'est pas déjà utilisé
    existing = db.query(GameServer).filter(GameServer.port == actual_port).first()
    if existing:
        raise HTTPException(
            status_code=400,
            detail=f"Le port {actual_port} est déjà utilisé par '{existing.name}'"
        )

    # Créer le conteneur Docker
    try:
        result = docker_manager.create_game_server(
            name=request.name,
            game_type=request.game_type,
            port=actual_port,
            memory_mb=actual_memory,
            version=request.version,
            custom_image=request.custom_image,
        )
    except RuntimeError as e:
        raise HTTPException(status_code=500, detail=str(e))

    # Sauvegarder en base de données
    server = GameServer(
        name=request.name,
        game_type=request.game_type,
        version=request.version,
        port=actual_port,
        memory_mb=actual_memory,
        docker_id=result["docker_id"],
        status="stopped",
    )
    db.add(server)
    db.commit()
    db.refresh(server)

    return server


@router.get("/{server_id}", response_model=ServerResponse)
def get_server(
    server_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Retourne les détails d'un serveur spécifique."""
    server = db.query(GameServer).filter(GameServer.id == server_id).first()
    if not server:
        raise HTTPException(status_code=404, detail="Serveur non trouvé")
    return server


@router.post("/{server_id}/start")
def start_server(
    server_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Démarre un serveur de jeu."""
    server = db.query(GameServer).filter(GameServer.id == server_id).first()
    if not server:
        raise HTTPException(status_code=404, detail="Serveur non trouvé")
    if not server.docker_id:
        raise HTTPException(status_code=400, detail="Conteneur Docker non trouvé")

    try:
        docker_manager.start_container(server.docker_id)
        server.status = "running"
        db.commit()
        return {"message": f"Serveur '{server.name}' démarré", "status": "running"}
    except RuntimeError as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/{server_id}/stop")
def stop_server(
    server_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Arrête un serveur de jeu proprement."""
    server = db.query(GameServer).filter(GameServer.id == server_id).first()
    if not server:
        raise HTTPException(status_code=404, detail="Serveur non trouvé")
    if not server.docker_id:
        raise HTTPException(status_code=400, detail="Conteneur Docker non trouvé")

    try:
        docker_manager.stop_container(server.docker_id)
        server.status = "stopped"
        db.commit()
        return {"message": f"Serveur '{server.name}' arrêté", "status": "stopped"}
    except RuntimeError as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/{server_id}/restart")
def restart_server(
    server_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Redémarre un serveur (arrêt + démarrage)."""
    server = db.query(GameServer).filter(GameServer.id == server_id).first()
    if not server:
        raise HTTPException(status_code=404, detail="Serveur non trouvé")
    if not server.docker_id:
        raise HTTPException(status_code=400, detail="Conteneur Docker non trouvé")

    try:
        docker_manager.stop_container(server.docker_id)
        docker_manager.start_container(server.docker_id)
        server.status = "running"
        db.commit()
        return {"message": f"Serveur '{server.name}' redémarré", "status": "running"}
    except RuntimeError as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/{server_id}/logs")
def get_server_logs(
    server_id: int,
    tail: int = 100,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Retourne les dernières lignes de logs du serveur."""
    server = db.query(GameServer).filter(GameServer.id == server_id).first()
    if not server:
        raise HTTPException(status_code=404, detail="Serveur non trouvé")
    if not server.docker_id:
        return {"logs": "Aucun conteneur Docker associé"}

    logs = docker_manager.get_container_logs(server.docker_id, tail=tail)
    return {"logs": logs}


@router.delete("/{server_id}")
def delete_server(
    server_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Supprime un serveur et son conteneur Docker."""
    server = db.query(GameServer).filter(GameServer.id == server_id).first()
    if not server:
        raise HTTPException(status_code=404, detail="Serveur non trouvé")

    if server.docker_id:
        try:
            docker_manager.delete_container(server.docker_id)
        except RuntimeError:
            pass

    db.delete(server)
    db.commit()
    return {"message": f"Serveur '{server.name}' supprimé"}
