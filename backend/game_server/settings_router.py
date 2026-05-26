"""
Routes Paramètres serveur — Lecture/écriture des fichiers de configuration.

Permet de lire et modifier server.properties et d'autres fichiers
de configuration directement dans le conteneur Docker.

Routes:
    GET  /api/servers/{id}/properties       → Lire les propriétés du serveur
    PUT  /api/servers/{id}/properties       → Modifier les propriétés
    GET  /api/servers/{id}/config/{file}    → Lire un fichier config quelconque
    PUT  /api/servers/{id}/config/{file}    → Écrire dans un fichier config
"""

import logging

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from backend.database import get_db
from backend.auth.utils import get_current_user
from backend.auth.models import User
from backend.game_server.models import GameServer
from backend.game_server import docker_manager

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/servers", tags=["Paramètres serveur"])


# --- Schémas ---

class PropertiesUpdateRequest(BaseModel):
    """Données pour mettre à jour des propriétés du serveur."""
    properties: dict  # {"motd": "Mon serveur", "max-players": "20", ...}


class ConfigFileUpdateRequest(BaseModel):
    """Écrire du contenu brut dans un fichier config."""
    content: str


# --- Helpers Docker ---

def _docker_exec(docker_id: str, cmd: str) -> str:
    """Exécute une commande dans le conteneur.
    Si le conteneur est arrêté, utilise docker cp pour accéder aux fichiers."""
    client = docker_manager._get_docker_client()
    if not client:
        raise RuntimeError("Docker non disponible")
    try:
        container = client.containers.get(docker_id)

        # Si le conteneur tourne, utiliser exec_run comme avant
        if container.status == "running":
            result = container.exec_run(["sh", "-c", cmd], demux=True)
            stdout = result.output[0] if result.output[0] else b""
            return stdout.decode("utf-8", errors="replace")

        # Conteneur arrêté → utiliser docker cp via subprocess
        return _docker_exec_stopped(docker_id, cmd)

    except Exception as e:
        logger.error(f"Erreur docker exec: {e}")
        raise RuntimeError(f"Erreur d'exécution: {e}")


def _docker_exec_stopped(docker_id: str, cmd: str) -> str:
    """Exécute une commande d'accès fichier sur un conteneur arrêté via docker cp."""
    import subprocess, tempfile, os

    # Parse les commandes courantes : cat, ls, stat, grep
    cmd_stripped = cmd.strip()

    # cat /path/to/file
    if cmd_stripped.startswith("cat "):
        filepath = cmd_stripped.replace("cat ", "").split("2>")[0].strip().strip('"').strip("'")
        try:
            with tempfile.TemporaryDirectory() as tmp:
                dest = os.path.join(tmp, "file")
                r = subprocess.run(
                    ["docker", "cp", f"{docker_id}:{filepath}", dest],
                    capture_output=True, timeout=15
                )
                if r.returncode != 0:
                    return ""
                with open(dest, "r", errors="replace") as f:
                    return f.read()
        except Exception:
            return ""

    # ls -la /path
    if "ls " in cmd_stripped:
        import re
        path_match = re.search(r'"([^"]+)"', cmd_stripped) or re.search(r'(/\S+)', cmd_stripped.split("ls")[1])
        target_path = path_match.group(1) if path_match else "/data"
        try:
            with tempfile.TemporaryDirectory() as tmp:
                dest = os.path.join(tmp, "dir")
                r = subprocess.run(
                    ["docker", "cp", f"{docker_id}:{target_path}/.", dest],
                    capture_output=True, timeout=15
                )
                if r.returncode != 0:
                    return "ERROR"
                # Simuler un ls -la via Python (compatible macOS)
                import stat as stat_mod
                from datetime import datetime
                lines = ["total 0"]
                for entry in os.scandir(dest):
                    st = entry.stat(follow_symlinks=False)
                    is_dir = entry.is_dir(follow_symlinks=False)
                    perms = "d" if is_dir else "-"
                    perms += "rwxr-xr-x" if is_dir else "rw-r--r--"
                    mtime = datetime.fromtimestamp(st.st_mtime).strftime("%Y-%m-%d %H:%M")
                    size = st.st_size
                    lines.append(f"{perms}  1 root root {size} {mtime} {entry.name}")
                return "\n".join(lines)
        except Exception:
            return "ERROR"

    # stat -c %s /path
    if "stat " in cmd_stripped:
        import re
        path_match = re.search(r'"([^"]+)"', cmd_stripped) or re.search(r'(/\S+)', cmd_stripped.split("stat")[1])
        filepath = path_match.group(1) if path_match else None
        if filepath:
            try:
                with tempfile.TemporaryDirectory() as tmp:
                    dest = os.path.join(tmp, "file")
                    r = subprocess.run(
                        ["docker", "cp", f"{docker_id}:{filepath}", dest],
                        capture_output=True, timeout=15
                    )
                    if r.returncode != 0:
                        return "0"
                    return str(os.path.getsize(dest))
            except Exception:
                return "0"

    # grep
    if "grep " in cmd_stripped:
        import re
        path_match = re.search(r'(/data\S+)', cmd_stripped)
        filepath = path_match.group(1) if path_match else None
        pattern = re.search(r"'([^']+)'", cmd_stripped)
        if filepath and pattern:
            try:
                with tempfile.TemporaryDirectory() as tmp:
                    dest = os.path.join(tmp, "file")
                    subprocess.run(
                        ["docker", "cp", f"{docker_id}:{filepath}", dest],
                        capture_output=True, timeout=15
                    )
                    if os.path.exists(dest):
                        with open(dest, "r", errors="replace") as f:
                            for line in f:
                                if re.match(pattern.group(1), line):
                                    key_val = line.strip().split("=", 1)
                                    return key_val[1] if len(key_val) > 1 else line.strip()
                return ""
            except Exception:
                return ""

    # du / for - world listing
    if "du " in cmd_stripped or "for " in cmd_stripped:
        try:
            with tempfile.TemporaryDirectory() as tmp:
                dest = os.path.join(tmp, "data")
                subprocess.run(
                    ["docker", "cp", f"{docker_id}:/data/.", dest],
                    capture_output=True, timeout=30
                )
                if not os.path.exists(dest):
                    return ""
                result = []
                for entry in os.listdir(dest):
                    if entry.startswith("world") and os.path.isdir(os.path.join(dest, entry)):
                        size_proc = subprocess.run(
                            ["du", "-sh", os.path.join(dest, entry)],
                            capture_output=True, text=True, timeout=10
                        )
                        size = size_proc.stdout.split("\t")[0] if size_proc.stdout else "?"
                        result.append(f"{entry}|{size}")
                return "\n".join(result)
        except Exception:
            return ""

    # rm / mkdir / mv → utiliser un conteneur temporaire busybox avec --volumes-from
    # Sécurité : valider les paths et construire des commandes sûres (pas de sh -c)
    if any(x in cmd_stripped for x in ["rm ", "mkdir ", "mv "]):
        import shlex
        try:
            # Parser la commande pour extraire le binaire et les arguments
            parts = shlex.split(cmd_stripped)
            if not parts:
                return ""
            cmd_name = parts[0]
            # Whitelist stricte des commandes autorisées
            if cmd_name not in ("rm", "mkdir", "mv"):
                logger.warning(f"Commande non autorisée bloquée: {cmd_name}")
                return ""
            # Valider que tous les arguments de chemin restent sous /data
            for arg in parts[1:]:
                if arg.startswith("-"):
                    # Whitelist de flags autorisés
                    if arg not in ("-rf", "-r", "-f", "-p"):
                        logger.warning(f"Flag non autorisé bloqué: {arg}")
                        return ""
                    continue
                # Vérifier que le chemin est sous /data
                import posixpath
                resolved = posixpath.normpath(arg)
                if not resolved.startswith("/data/") and resolved != "/data":
                    logger.warning(f"Chemin hors /data bloqué: {arg} → {resolved}")
                    raise RuntimeError(f"Chemin non autorisé: {arg}")
            r = subprocess.run(
                ["docker", "run", "--rm", "--volumes-from", docker_id,
                 "busybox"] + parts,
                capture_output=True, text=True, timeout=30
            )
            return r.stdout
        except Exception as e:
            logger.error(f"Erreur busybox exec: {e}")
            raise RuntimeError(f"Erreur: {e}")

    return ""


def _docker_write(docker_id: str, path: str, content: str):
    """Écrit du contenu dans un fichier à l'intérieur du conteneur.
    Fonctionne que le conteneur soit allumé ou éteint."""
    import base64
    client = docker_manager._get_docker_client()
    if not client:
        raise RuntimeError("Docker non disponible")
    try:
        container = client.containers.get(docker_id)

        if container.status == "running":
            b64 = base64.b64encode(content.encode("utf-8")).decode("ascii")
            container.exec_run(["sh", "-c", f"echo '{b64}' | base64 -d > {path}"])
        else:
            # Conteneur arrêté → docker cp
            import subprocess, tempfile, os
            with tempfile.NamedTemporaryFile(mode="w", suffix=".tmp", delete=False) as f:
                f.write(content)
                tmp_path = f.name
            try:
                subprocess.run(
                    ["docker", "cp", tmp_path, f"{docker_id}:{path}"],
                    capture_output=True, timeout=15, check=True
                )
            finally:
                os.unlink(tmp_path)

    except subprocess.CalledProcessError as e:
        logger.error(f"Erreur docker cp write: {e}")
        raise RuntimeError(f"Erreur d'écriture: {e}")
    except Exception as e:
        logger.error(f"Erreur docker write: {e}")
        raise RuntimeError(f"Erreur d'écriture: {e}")


def _get_server_or_404(server_id: int, db: Session) -> GameServer:
    """Récupère un serveur ou lève une 404."""
    server = db.query(GameServer).filter(GameServer.id == server_id).first()
    if not server:
        raise HTTPException(status_code=404, detail="Serveur non trouvé")
    if not server.docker_id:
        raise HTTPException(status_code=400, detail="Conteneur Docker non trouvé")
    return server


# --- Parsing server.properties ---

def _parse_properties(raw: str) -> dict:
    """Parse un fichier server.properties en dictionnaire."""
    props = {}
    for line in raw.splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        if "=" in line:
            key, _, value = line.partition("=")
            props[key.strip()] = value.strip()
    return props


def _build_properties(props: dict, original_raw: str) -> str:
    """
    Reconstruit le fichier server.properties en préservant l'ordre
    et les commentaires de l'original.
    """
    lines = []
    seen_keys = set()
    for line in original_raw.splitlines():
        stripped = line.strip()
        if stripped.startswith("#") or not stripped:
            lines.append(line)
            continue
        if "=" in stripped:
            key, _, _ = stripped.partition("=")
            key = key.strip()
            seen_keys.add(key)
            if key in props:
                lines.append(f"{key}={props[key]}")
            else:
                lines.append(line)
        else:
            lines.append(line)
    # Ajouter les nouvelles clés
    for key, value in props.items():
        if key not in seen_keys:
            lines.append(f"{key}={value}")
    return "\n".join(lines) + "\n"


# --- Routes ---

@router.get("/{server_id}/properties")
def get_properties(
    server_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Lire toutes les propriétés du server.properties."""
    server = _get_server_or_404(server_id, db)
    try:
        # Le fichier est dans /data/server.properties pour l'image itzg/minecraft-server
        raw = _docker_exec(server.docker_id, "cat /data/server.properties 2>/dev/null || echo ''")
        props = _parse_properties(raw)
        return {"properties": props, "raw": raw}
    except RuntimeError as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.put("/{server_id}/properties")
def update_properties(
    server_id: int,
    request: PropertiesUpdateRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """
    Modifier des propriétés dans server.properties.
    Seules les clés envoyées sont modifiées, les autres restent intactes.
    """
    server = _get_server_or_404(server_id, db)
    try:
        # Lire l'original
        raw = _docker_exec(server.docker_id, "cat /data/server.properties 2>/dev/null || echo ''")
        current = _parse_properties(raw)

        # Fusionner les modifications
        current.update(request.properties)

        # Reconstruire et écrire
        new_content = _build_properties(current, raw)
        _docker_write(server.docker_id, "/data/server.properties", new_content)

        return {"message": "Propriétés mises à jour", "properties": current}
    except RuntimeError as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/{server_id}/config/{filename}")
def get_config_file(
    server_id: int,
    filename: str,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """
    Lire un fichier de configuration du serveur.
    Fichiers autorisés : server.properties, spigot.yml, bukkit.yml,
    paper-global.yml, paper-world-defaults.yml
    """
    allowed = [
        "server.properties", "spigot.yml", "bukkit.yml",
        "paper-global.yml", "paper-world-defaults.yml",
        "config/paper-global.yml", "config/paper-world-defaults.yml",
    ]
    if filename not in allowed:
        raise HTTPException(status_code=400, detail="Fichier non autorisé")

    server = _get_server_or_404(server_id, db)
    try:
        content = _docker_exec(server.docker_id, f"cat /data/{filename} 2>/dev/null || echo ''")
        return {"filename": filename, "content": content}
    except RuntimeError as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.put("/{server_id}/config/{filename}")
def update_config_file(
    server_id: int,
    filename: str,
    request: ConfigFileUpdateRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Écrire dans un fichier de configuration autorisé."""
    allowed = [
        "server.properties", "spigot.yml", "bukkit.yml",
        "paper-global.yml", "paper-world-defaults.yml",
    ]
    if filename not in allowed:
        raise HTTPException(status_code=400, detail="Fichier non autorisé")

    server = _get_server_or_404(server_id, db)
    try:
        _docker_write(server.docker_id, f"/data/{filename}", request.content)
        return {"message": f"{filename} mis à jour"}
    except RuntimeError as e:
        raise HTTPException(status_code=500, detail=str(e))
