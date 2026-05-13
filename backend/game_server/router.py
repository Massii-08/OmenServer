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
from backend.auth.permissions import has_permission
from backend.auth.access_control import (
    can_access_resource, get_accessible_resource_ids, get_user_access_level
)
from backend.game_server.models import GameServer
from backend.game_server import docker_manager
from backend.game_server.games_config import get_all_games, get_game_config

router = APIRouter(prefix="/api/servers", tags=["Serveurs de jeux"])


# --- Schémas ---

class CreateServerRequest(BaseModel):
    """Données pour créer un nouveau serveur."""
    name: str
    game_type: str = "minecraft"
    server_type: str = "VANILLA"       # VANILLA, PAPER, SPIGOT, FORGE, FABRIC, NEOFORGE, MOHIST, PURPUR, QUILT
    version: str = "LATEST"
    port: Optional[int] = None
    memory_mb: Optional[int] = None
    custom_image: Optional[str] = None
    cf_page_url: Optional[str] = None   # URL page CurseForge du modpack
    cf_file_id: Optional[int] = None    # ID fichier spécifique (version précise)


class ServerResponse(BaseModel):
    """Réponse avec les infos d'un serveur."""
    id: int
    name: str
    game_type: str
    server_type: str = "VANILLA"
    version: str
    port: int
    memory_mb: int
    cpu_percent: int = 100
    status: str
    docker_id: Optional[str]
    player_count: int = 0
    player_max: int = 20
    jvm_flags: str = ""
    ready: bool = False  # True seulement quand le jeu répond (pas juste Docker running)
    owner_id: Optional[int] = None
    steam_app_id: Optional[int] = None    # App ID Steam (jeux Steam uniquement)
    mod_source: Optional[str] = None      # "steam", "curseforge", "modrinth" ou None

    class Config:
        from_attributes = True


class ChangeVersionRequest(BaseModel):
    """Données pour changer la version/type d'un serveur."""
    server_type: str          # VANILLA, PAPER, SPIGOT, FORGE, etc.
    version: str = "LATEST"   # Version du jeu
    reset_data: bool = False  # Si True, supprime /data et réinstalle tout
    cf_page_url: Optional[str] = None   # URL page CurseForge du modpack
    cf_file_id: Optional[int] = None    # ID fichier spécifique (version précise)


class UpdateResourcesRequest(BaseModel):
    """Données pour modifier les ressources d'un serveur."""
    memory_mb: int
    cpu_percent: int


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
    """Retourne la liste des serveurs accessibles par l'utilisateur."""
    # RBAC : filtrer par ownership + shared access (admins voient tout)
    accessible_ids = get_accessible_resource_ids(current_user, "server", db)
    if accessible_ids is not None:
        servers = db.query(GameServer).filter(GameServer.id.in_(accessible_ids)).all()
    else:
        servers = db.query(GameServer).all()

    result = []

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

        # Construire la réponse avec player_count, ready et access_level
        resp = ServerResponse.model_validate(server, from_attributes=True)

        # Enrichir avec les infos Steam depuis games_config
        game_cfg = get_game_config(server.game_type)
        resp.steam_app_id = game_cfg.get("steam_app_id")
        resp.mod_source = game_cfg.get("mod_source")
        resp.owner_id = server.owner_id

        if server.status == "running" and server.game_type in ("minecraft", "minecraft_bedrock"):
            ping = docker_manager.mc_server_ping(server.port)
            if ping:
                resp.player_count = ping["online"]
                resp.player_max = ping["max"]
                resp.ready = True
            else:
                resp.ready = False
        elif server.status == "running":
            # Pour les autres jeux, on considère ready si Docker est running
            resp.ready = True
        result.append(resp)

    return result


@router.post("/", response_model=ServerResponse, status_code=status.HTTP_201_CREATED)
def create_server(
    request: CreateServerRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Crée un nouveau serveur de jeu (réservé aux moderators, developers et admins)."""
    # RBAC : seuls les rôles avec create_server peuvent créer
    if not has_permission(current_user, "create_server"):
        raise HTTPException(
            status_code=403,
            detail="Seuls les modérateurs, développeurs et administrateurs peuvent créer des serveurs."
        )

    # Quota : moderators et developers = max 1 serveur chacun
    if not current_user.is_admin and current_user.role in ("moderator", "developer"):
        owned_count = db.query(GameServer).filter(GameServer.owner_id == current_user.id).count()
        if owned_count >= 1:
            raise HTTPException(
                status_code=403,
                detail="Tu as atteint ta limite de 1 serveur. Supprime l'existant pour en créer un nouveau."
            )

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
            server_type=request.server_type,
            cf_page_url=request.cf_page_url,
            cf_file_id=request.cf_file_id,
        )
    except RuntimeError as e:
        raise HTTPException(status_code=500, detail=str(e))

    # Sauvegarder en base de données avec owner_id
    server = GameServer(
        name=request.name,
        game_type=request.game_type,
        server_type=request.server_type,
        version=request.version,
        port=actual_port,
        memory_mb=actual_memory,
        docker_id=result["docker_id"],
        status="stopped",
        owner_id=current_user.id,
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

    # RBAC : vérifier l'accès à ce serveur
    if not can_access_resource(current_user, "server", server_id, db, min_level="view_only"):
        raise HTTPException(status_code=403, detail="Tu n'as pas accès à ce serveur.")

    # Mettre à jour le statut Docker en temps réel
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

    resp = ServerResponse.model_validate(server, from_attributes=True)

    # Enrichir avec les infos Steam depuis games_config
    game_cfg = get_game_config(server.game_type)
    resp.steam_app_id = game_cfg.get("steam_app_id")
    resp.mod_source = game_cfg.get("mod_source")
    resp.owner_id = server.owner_id

    if server.status == "running" and server.game_type in ("minecraft", "minecraft_bedrock"):
        ping = docker_manager.mc_server_ping(server.port)
        if ping:
            resp.player_count = ping["online"]
            resp.player_max = ping["max"]
            resp.ready = True
        else:
            resp.ready = False
    elif server.status == "running":
        resp.ready = True
    return resp


@router.post("/{server_id}/start")
def start_server(
    server_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Démarre un serveur de jeu (accessible aux joueurs invités avec accès 'start')."""
    server = db.query(GameServer).filter(GameServer.id == server_id).first()
    if not server:
        raise HTTPException(status_code=404, detail="Serveur non trouvé")

    # RBAC : le joueur doit avoir au minimum le niveau "start"
    if not can_access_resource(current_user, "server", server_id, db, min_level="start"):
        raise HTTPException(status_code=403, detail="Tu n'as pas le droit de démarrer ce serveur.")

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
    """Arrête un serveur de jeu (réservé au propriétaire, managers et admins)."""
    server = db.query(GameServer).filter(GameServer.id == server_id).first()
    if not server:
        raise HTTPException(status_code=404, detail="Serveur non trouvé")

    # RBAC : arrêter = niveau "manage" (les joueurs ne peuvent pas arrêter)
    if not can_access_resource(current_user, "server", server_id, db, min_level="manage"):
        raise HTTPException(status_code=403, detail="Tu n'as pas le droit d'arrêter ce serveur.")

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
    """Redémarre un serveur (réservé au propriétaire, managers et admins)."""
    server = db.query(GameServer).filter(GameServer.id == server_id).first()
    if not server:
        raise HTTPException(status_code=404, detail="Serveur non trouvé")

    # RBAC : restart = niveau "manage"
    if not can_access_resource(current_user, "server", server_id, db, min_level="manage"):
        raise HTTPException(status_code=403, detail="Tu n'as pas le droit de redémarrer ce serveur.")

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


@router.put("/{server_id}/version")
def change_server_version(
    server_id: int,
    request: ChangeVersionRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """
    Change la version et/ou le type de serveur (ex: VANILLA → PAPER).
    Arrête le serveur, supprime le conteneur et en recrée un nouveau.
    Si reset_data=True, supprime aussi les fichiers du serveur.
    """
    server = db.query(GameServer).filter(GameServer.id == server_id).first()
    if not server:
        raise HTTPException(status_code=404, detail="Serveur non trouvé")

    # RBAC : changer la version = niveau "manage"
    if not can_access_resource(current_user, "server", server_id, db, min_level="manage"):
        raise HTTPException(status_code=403, detail="Tu n'as pas le droit de modifier ce serveur.")

    # 1. Arrêter et supprimer l'ancien conteneur
    if server.docker_id:
        try:
            docker_manager.stop_container(server.docker_id)
        except Exception:
            pass
        try:
            docker_manager.remove_container(server.docker_id, delete_data=request.reset_data)
        except Exception:
            pass

    # 2. Recréer le conteneur avec le nouveau type/version
    try:
        result = docker_manager.create_game_server(
            name=server.name,
            game_type=server.game_type,
            port=server.port,
            memory_mb=server.memory_mb,
            version=request.version,
            server_type=request.server_type,
            cf_page_url=request.cf_page_url,
            cf_file_id=request.cf_file_id,
        )
    except RuntimeError as e:
        raise HTTPException(status_code=500, detail=str(e))

    # 3. Mettre à jour la base de données
    server.server_type = request.server_type
    server.version = request.version
    server.docker_id = result["docker_id"]
    server.status = "stopped"
    db.commit()
    db.refresh(server)

    return {
        "message": f"Version changée → {request.server_type} {request.version}",
        "server": {
            "id": server.id,
            "server_type": server.server_type,
            "version": server.version,
            "status": server.status,
        }
    }


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

    # RBAC : voir les logs = niveau "view_only"
    if not can_access_resource(current_user, "server", server_id, db, min_level="view_only"):
        raise HTTPException(status_code=403, detail="Tu n'as pas accès aux logs de ce serveur.")

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
    """Supprime un serveur (réservé au propriétaire et admins)."""
    server = db.query(GameServer).filter(GameServer.id == server_id).first()
    if not server:
        raise HTTPException(status_code=404, detail="Serveur non trouvé")

    # RBAC : seul le propriétaire ou un admin peut supprimer
    if not current_user.is_admin and server.owner_id != current_user.id:
        raise HTTPException(status_code=403, detail="Seul le propriétaire peut supprimer ce serveur.")

    if server.docker_id:
        try:
            docker_manager.delete_container(server.docker_id)
        except RuntimeError:
            pass

    # Supprimer aussi les accès partagés
    from backend.auth.shared_access import SharedAccess
    db.query(SharedAccess).filter(
        SharedAccess.resource_type == "server",
        SharedAccess.resource_id == server_id,
    ).delete()

    db.delete(server)
    db.commit()
    return {"message": f"Serveur '{server.name}' supprimé"}


@router.put("/{server_id}/resources")
def update_resources(
    server_id: int,
    request: UpdateResourcesRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """
    Modifie les ressources (RAM + CPU) d'un serveur.
    Les changements sont appliqués immédiatement au conteneur Docker.
    """
    server = db.query(GameServer).filter(GameServer.id == server_id).first()
    if not server:
        raise HTTPException(status_code=404, detail="Serveur non trouvé")

    # RBAC : modifier les ressources = niveau "manage"
    if not can_access_resource(current_user, "server", server_id, db, min_level="manage"):
        raise HTTPException(status_code=403, detail="Tu n'as pas le droit de modifier ce serveur.")

    # Validation des limites
    if request.memory_mb < 256:
        raise HTTPException(status_code=400, detail="La RAM minimum est 256 Mo")
    if request.memory_mb > 16384:
        raise HTTPException(status_code=400, detail="La RAM maximum est 16 Go")
    if request.cpu_percent < 25:
        raise HTTPException(status_code=400, detail="Le CPU minimum est 25%")
    if request.cpu_percent > 400:
        raise HTTPException(status_code=400, detail="Le CPU maximum est 400% (4 cœurs)")

    # Appliquer au conteneur Docker si possible
    if server.docker_id:
        try:
            docker_manager.update_container_resources(
                docker_id=server.docker_id,
                memory_mb=request.memory_mb,
                cpu_percent=request.cpu_percent,
            )
        except RuntimeError as e:
            raise HTTPException(status_code=500, detail=str(e))

    # Mettre à jour en base
    server.memory_mb = request.memory_mb
    server.cpu_percent = request.cpu_percent
    db.commit()

    return {
        "message": f"Ressources de '{server.name}' mises à jour ✅",
        "memory_mb": server.memory_mb,
        "cpu_percent": server.cpu_percent,
    }


class JvmFlagsRequest(BaseModel):
    """Données pour changer les flags JVM."""
    jvm_flags: str = ""


@router.put("/{server_id}/jvm-flags")
def update_jvm_flags(
    server_id: int,
    request: JvmFlagsRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Met à jour les flags JVM d'un serveur."""
    server = db.query(GameServer).filter(GameServer.id == server_id).first()
    if not server:
        raise HTTPException(status_code=404, detail="Serveur non trouvé")

    server.jvm_flags = request.jvm_flags
    db.commit()

    return {
        "message": f"Flags JVM de '{server.name}' mis à jour ✅",
        "jvm_flags": server.jvm_flags,
        "note": "Redémarrez le serveur pour appliquer les changements.",
    }


# --- Gestion des mondes ---

@router.get("/{server_id}/worlds")
def list_worlds(
    server_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Liste les mondes du serveur (fonctionne même si le serveur est éteint)."""
    server = db.query(GameServer).filter(GameServer.id == server_id).first()
    if not server:
        raise HTTPException(status_code=404, detail="Serveur non trouvé")
    if not server.docker_id:
        raise HTTPException(status_code=400, detail="Pas de conteneur Docker")

    from backend.game_server.settings_router import _docker_exec

    try:
        # Lister les dossiers de mondes
        output = _docker_exec(
            server.docker_id,
            "sh -c 'for d in /data/world*; do if [ -d \"$d\" ]; then size=$(du -sh \"$d\" 2>/dev/null | cut -f1); echo \"$(basename $d)|$size\"; fi; done'"
        )
        worlds = []
        for line in output.strip().split("\n"):
            if "|" in line:
                name, size = line.split("|", 1)
                worlds.append({"name": name.strip(), "size": size.strip()})

        # Lire le seed depuis server.properties
        seed = ""
        try:
            seed_output = _docker_exec(
                server.docker_id,
                "grep '^level-seed=' /data/server.properties"
            )
            if seed_output:
                seed = seed_output.strip().split("=", 1)[-1] if "=" in seed_output else seed_output.strip()
        except Exception:
            pass

        return {"worlds": worlds, "seed": seed}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.delete("/{server_id}/worlds/{world_name}")
def reset_world(
    server_id: int,
    world_name: str,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Supprime/réinitialise un monde (le serveur doit être arrêté pour sécurité)."""
    server = db.query(GameServer).filter(GameServer.id == server_id).first()
    if not server:
        raise HTTPException(status_code=404, detail="Serveur non trouvé")
    if not server.docker_id:
        raise HTTPException(status_code=400, detail="Pas de conteneur Docker")

    # Sécurité : le nom doit commencer par "world"
    if not world_name.startswith("world"):
        raise HTTPException(status_code=400, detail="Nom de monde invalide")

    from backend.game_server.settings_router import _docker_exec

    try:
        _docker_exec(server.docker_id, f"rm -rf /data/{world_name}")
        return {"message": f"Monde '{world_name}' supprimé. Il sera regénéré au prochain démarrage."}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# --- Base de données MySQL ---

class CreateDatabaseRequest(BaseModel):
    """Données pour créer une base de données."""
    db_name: str = "minecraft"
    db_user: str = "mc_user"
    db_password: str = "mc_pass"
    root_password: str = "root_pass"


@router.post("/{server_id}/database")
def create_database(
    server_id: int,
    request: CreateDatabaseRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Crée un conteneur MySQL/MariaDB associé au serveur."""
    server = db.query(GameServer).filter(GameServer.id == server_id).first()
    if not server:
        raise HTTPException(status_code=404, detail="Serveur non trouvé")

    import docker
    client = docker.from_env()

    container_name = f"omen-mysql-{server.id}"

    # Vérifier si déjà existant
    try:
        existing = client.containers.get(container_name)
        return {"message": "Base de données déjà existante", "status": existing.status, "host": container_name, "port": 3306}
    except Exception:
        pass

    try:
        # Télécharger MariaDB
        try:
            client.images.get("mariadb:10")
        except Exception:
            client.images.pull("mariadb:10")

        container = client.containers.create(
            image="mariadb:10",
            name=container_name,
            environment={
                "MYSQL_ROOT_PASSWORD": request.root_password,
                "MYSQL_DATABASE": request.db_name,
                "MYSQL_USER": request.db_user,
                "MYSQL_PASSWORD": request.db_password,
            },
            ports={"3306/tcp": None},  # Port aléatoire
            restart_policy={"Name": "unless-stopped"},
            detach=True,
        )
        container.start()

        return {
            "message": f"Base de données '{request.db_name}' créée ✅",
            "host": container_name,
            "port": 3306,
            "db_name": request.db_name,
            "db_user": request.db_user,
            "db_password": request.db_password,
            "status": "running",
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/{server_id}/database")
def get_database_status(
    server_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Retourne le statut de la base de données du serveur."""
    server = db.query(GameServer).filter(GameServer.id == server_id).first()
    if not server:
        raise HTTPException(status_code=404, detail="Serveur non trouvé")

    import docker
    client = docker.from_env()
    container_name = f"omen-mysql-{server.id}"

    try:
        container = client.containers.get(container_name)
        # Récupérer le port mappé
        ports = container.attrs.get("NetworkSettings", {}).get("Ports", {})
        mapped_port = None
        if "3306/tcp" in ports and ports["3306/tcp"]:
            mapped_port = ports["3306/tcp"][0].get("HostPort")

        return {
            "exists": True,
            "status": container.status,
            "host": "localhost",
            "port": mapped_port or 3306,
            "container_name": container_name,
        }
    except Exception:
        return {"exists": False}


@router.delete("/{server_id}/database")
def delete_database(
    server_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Supprime le conteneur MySQL du serveur."""
    server = db.query(GameServer).filter(GameServer.id == server_id).first()
    if not server:
        raise HTTPException(status_code=404, detail="Serveur non trouvé")

    import docker
    client = docker.from_env()
    container_name = f"omen-mysql-{server.id}"

    try:
        container = client.containers.get(container_name)
        container.remove(force=True)
        return {"message": "Base de données supprimée ✅"}
    except Exception:
        raise HTTPException(status_code=404, detail="Aucune base de données trouvée")

