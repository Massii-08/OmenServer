"""
Module Serveur Web — Router API.

Gère le déploiement de sites web via Docker.
Chaque site tourne dans son propre conteneur (Nginx pour sites statiques,
Node.js pour apps JS, etc.)

Endpoints:
    GET    /api/websites           — Liste des sites
    POST   /api/websites           — Créer un site
    GET    /api/websites/{id}      — Détails d'un site
    DELETE /api/websites/{id}      — Supprimer un site
    POST   /api/websites/{id}/start  — Démarrer
    POST   /api/websites/{id}/stop   — Arrêter
    GET    /api/websites/{id}/logs   — Logs du conteneur
"""

import os
import logging
import docker
import subprocess
from fastapi import APIRouter, HTTPException, Depends
from sqlalchemy.orm import Session
from pydantic import BaseModel
from typing import Optional
from backend.database import get_db
from backend.auth.utils import get_current_user
from backend.webserver.models import Website

logger = logging.getLogger("omenserver.webserver")

router = APIRouter(prefix="/api/websites", tags=["websites"])

WEBSITES_DIR = os.path.expanduser("~/omenserver/websites")

# Images Docker par type de site
SITE_IMAGES = {
    "static": "nginx:alpine",
    "node": "node:20-alpine",
    "php": "php:8.2-apache",
    "python": "python:3.11-slim",
}

SITE_TYPE_LABELS = {
    "static": "🌐 Site statique (Nginx)",
    "node": "⚡ Node.js",
    "php": "🐘 PHP (Apache)",
    "python": "🐍 Python",
}


# === Modèles Pydantic ===
class CreateWebsite(BaseModel):
    name: str
    site_type: str = "static"   # static, node, php, python
    port: int = 3000
    description: str = ""
    git_url: str = ""           # URL Git à cloner (optionnel)


# === Helpers ===
def _get_docker_client():
    try:
        client = docker.from_env()
        client.ping()
        return client
    except Exception as e:
        logger.error(f"Docker non disponible: {e}")
        raise HTTPException(status_code=503, detail="Docker n'est pas disponible.")


def _container_name(site_id):
    return f"omenserver-web-{site_id}"


def _get_container(client, site_id):
    try:
        return client.containers.get(_container_name(site_id))
    except docker.errors.NotFound:
        return None


def _sync_status(db, site, client=None):
    """Synchronise le statut du site avec Docker."""
    if not client:
        try:
            client = docker.from_env()
        except Exception:
            return
    container = _get_container(client, site.id)
    if container:
        site.status = container.status
        site.container_id = container.short_id
    else:
        site.status = "stopped"
        site.container_id = None
    db.commit()


# === Routes ===

@router.get("")
async def list_websites(db: Session = Depends(get_db), user=Depends(get_current_user)):
    """Liste tous les sites web."""
    sites = db.query(Website).order_by(Website.created_at.desc()).all()

    # Sync status avec Docker
    try:
        client = docker.from_env()
        for site in sites:
            _sync_status(db, site, client)
    except Exception:
        pass

    return [
        {
            "id": s.id,
            "name": s.name,
            "site_type": s.site_type,
            "type_label": SITE_TYPE_LABELS.get(s.site_type, s.site_type),
            "port": s.port,
            "domain": s.domain,
            "status": s.status,
            "description": s.description,
            "url": f"http://localhost:{s.port}" if s.status == "running" else None,
            "created_at": s.created_at.isoformat() if s.created_at else None,
        }
        for s in sites
    ]


@router.post("")
async def create_website(req: CreateWebsite, db: Session = Depends(get_db), user=Depends(get_current_user)):
    """Créer un nouveau site web."""
    if req.site_type not in SITE_IMAGES:
        raise HTTPException(status_code=400, detail=f"Type non supporté. Types : {', '.join(SITE_IMAGES.keys())}")

    # Vérifier que le port n'est pas déjà utilisé
    existing = db.query(Website).filter(Website.port == req.port).first()
    if existing:
        raise HTTPException(status_code=409, detail=f"Le port {req.port} est déjà utilisé par '{existing.name}'.")

    # Créer le site en base
    site = Website(
        name=req.name,
        site_type=req.site_type,
        port=req.port,
        description=req.description,
    )
    db.add(site)
    db.commit()
    db.refresh(site)

    # Créer le dossier source
    site_dir = os.path.join(WEBSITES_DIR, str(site.id))
    os.makedirs(site_dir, exist_ok=True)

    # Si une URL Git est fournie, cloner le repo
    if req.git_url and req.git_url.strip():
        # Validation de sécurité : seuls les repos HTTPS de domaines connus sont autorisés
        import re
        git_url = req.git_url.strip()
        if not re.match(r'^https://(github\.com|gitlab\.com|bitbucket\.org|codeberg\.org)/', git_url):
            raise HTTPException(
                status_code=400,
                detail="Seuls les repos HTTPS de GitHub, GitLab, Bitbucket et Codeberg sont autorisés"
            )
        try:
            git_bin = "/usr/bin/git"
            # Chercher git dans les emplacements courants
            for p in ["/usr/bin/git", "/usr/local/bin/git", "/opt/homebrew/bin/git"]:
                if os.path.exists(p):
                    git_bin = p
                    break
            result = subprocess.run(
                [git_bin, "clone", "--depth", "1", git_url, "."],
                cwd=site_dir, capture_output=True, text=True, timeout=120
            )
            if result.returncode != 0:
                logger.error(f"Git clone échoué: {result.stderr}")
                raise HTTPException(status_code=400, detail=f"Erreur git clone: {result.stderr[:200]}")
            logger.info(f"📦 Repo cloné: {git_url} → {site_dir}")
        except subprocess.TimeoutExpired:
            raise HTTPException(status_code=408, detail="Timeout: le clone a pris trop de temps (>120s)")
        except HTTPException:
            raise
        except Exception as e:
            raise HTTPException(status_code=500, detail=f"Erreur git: {str(e)}")
    else:
        # Créer un fichier index par défaut selon le type
        if req.site_type == "static":
            with open(os.path.join(site_dir, "index.html"), "w") as f:
                f.write(f"""<!DOCTYPE html>
<html><head><title>{req.name}</title>
<style>body{{font-family:sans-serif;display:flex;justify-content:center;align-items:center;height:100vh;margin:0;background:#0f172a;color:white;}}
h1{{font-size:2em;}}</style></head>
<body><div style="text-align:center"><h1>🌐 {req.name}</h1><p>Site hébergé par OmenServer</p></div></body></html>""")
        elif req.site_type == "node":
            with open(os.path.join(site_dir, "index.js"), "w") as f:
                f.write(f"""const http = require('http');
const server = http.createServer((req, res) => {{
    res.writeHead(200, {{'Content-Type': 'text/html'}});
    res.end('<h1>⚡ {req.name}</h1><p>App Node.js sur OmenServer</p>');
}});
server.listen(3000, () => console.log('Serveur Node.js sur le port 3000'));
""")
        elif req.site_type == "python":
            with open(os.path.join(site_dir, "app.py"), "w") as f:
                f.write(f"""from http.server import HTTPServer, SimpleHTTPRequestHandler
import os

class Handler(SimpleHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200)
        self.send_header('Content-type', 'text/html')
        self.end_headers()
        self.wfile.write(b'<h1>🐍 {req.name}</h1><p>App Python sur OmenServer</p>')

HTTPServer(('0.0.0.0', 8080), Handler).serve_forever()
""")

    site.source_path = site_dir
    db.commit()

    logger.info(f"🌐 Site créé: {req.name} (type={req.site_type}, port={req.port})")

    return {
        "id": site.id,
        "name": site.name,
        "site_type": site.site_type,
        "port": site.port,
        "message": f"Site '{req.name}' créé !",
    }


@router.delete("/{site_id}")
async def delete_website(site_id: int, db: Session = Depends(get_db), user=Depends(get_current_user)):
    """Supprimer un site web et son conteneur."""
    site = db.query(Website).filter(Website.id == site_id).first()
    if not site:
        raise HTTPException(status_code=404, detail="Site non trouvé.")

    # Arrêter et supprimer le conteneur Docker
    try:
        client = _get_docker_client()
        container = _get_container(client, site_id)
        if container:
            if container.status == "running":
                container.stop(timeout=5)
            container.remove()
    except Exception as e:
        logger.warning(f"Erreur suppression conteneur: {e}")

    # Supprimer de la base
    db.delete(site)
    db.commit()

    logger.info(f"🗑️ Site supprimé: {site.name}")
    return {"success": True, "message": f"Site '{site.name}' supprimé."}


@router.post("/{site_id}/start")
async def start_website(site_id: int, db: Session = Depends(get_db), user=Depends(get_current_user)):
    """Démarrer le site web dans un conteneur Docker."""
    site = db.query(Website).filter(Website.id == site_id).first()
    if not site:
        raise HTTPException(status_code=404, detail="Site non trouvé.")

    client = _get_docker_client()
    container = _get_container(client, site_id)

    # Si le conteneur existe, le démarrer
    if container:
        if container.status == "running":
            return {"message": "Le site est déjà en cours d'exécution."}
        container.start()
        site.status = "running"
        db.commit()
        return {"message": f"Site '{site.name}' démarré !", "url": f"http://localhost:{site.port}"}

    # Sinon, créer le conteneur
    site_dir = os.path.join(WEBSITES_DIR, str(site.id))
    if not os.path.exists(site_dir):
        os.makedirs(site_dir, exist_ok=True)

    image = SITE_IMAGES.get(site.site_type, "nginx:alpine")

    try:
        # Pull l'image si nécessaire
        try:
            client.images.get(image)
        except docker.errors.ImageNotFound:
            logger.info(f"📥 Téléchargement de {image}...")
            client.images.pull(image)

        # Config spécifique par type
        if site.site_type == "static":
            container = client.containers.run(
                image, name=_container_name(site_id), detach=True,
                restart_policy={"Name": "unless-stopped"},
                ports={"80/tcp": site.port},
                volumes={site_dir: {"bind": "/usr/share/nginx/html", "mode": "ro"}},
            )
        elif site.site_type == "node":
            container = client.containers.run(
                image, name=_container_name(site_id), detach=True,
                command="node /app/index.js",
                restart_policy={"Name": "unless-stopped"},
                ports={"3000/tcp": site.port},
                volumes={site_dir: {"bind": "/app", "mode": "ro"}},
            )
        elif site.site_type == "php":
            container = client.containers.run(
                image, name=_container_name(site_id), detach=True,
                restart_policy={"Name": "unless-stopped"},
                ports={"80/tcp": site.port},
                volumes={site_dir: {"bind": "/var/www/html", "mode": "ro"}},
            )
        elif site.site_type == "python":
            container = client.containers.run(
                image, name=_container_name(site_id), detach=True,
                command="python /app/app.py",
                restart_policy={"Name": "unless-stopped"},
                ports={"8080/tcp": site.port},
                volumes={site_dir: {"bind": "/app", "mode": "ro"}},
            )
        else:
            raise HTTPException(status_code=400, detail=f"Type '{site.site_type}' non supporté.")

        site.status = "running"
        site.container_id = container.short_id
        db.commit()

        logger.info(f"▶️ Site démarré: {site.name} → http://localhost:{site.port}")
        return {"message": f"Site '{site.name}' démarré !", "url": f"http://localhost:{site.port}"}

    except Exception as e:
        site.status = "error"
        db.commit()
        logger.error(f"❌ Erreur démarrage site: {e}")
        raise HTTPException(status_code=500, detail=f"Erreur: {str(e)}")


@router.post("/{site_id}/stop")
async def stop_website(site_id: int, db: Session = Depends(get_db), user=Depends(get_current_user)):
    """Arrêter un site web."""
    site = db.query(Website).filter(Website.id == site_id).first()
    if not site:
        raise HTTPException(status_code=404, detail="Site non trouvé.")

    client = _get_docker_client()
    container = _get_container(client, site_id)

    if container and container.status == "running":
        container.stop(timeout=5)

    site.status = "stopped"
    db.commit()

    logger.info(f"⏹️ Site arrêté: {site.name}")
    return {"message": f"Site '{site.name}' arrêté."}


@router.get("/{site_id}/logs")
async def get_logs(site_id: int, db: Session = Depends(get_db), user=Depends(get_current_user)):
    """Récupérer les logs du conteneur."""
    site = db.query(Website).filter(Website.id == site_id).first()
    if not site:
        raise HTTPException(status_code=404, detail="Site non trouvé.")

    client = _get_docker_client()
    container = _get_container(client, site_id)

    if not container:
        return {"logs": ["Aucun conteneur trouvé. Démarre le site d'abord."]}

    try:
        logs = container.logs(tail=100, timestamps=True).decode("utf-8", errors="replace")
        return {"logs": logs.strip().split("\n") if logs.strip() else []}
    except Exception as e:
        return {"logs": [f"Erreur: {str(e)}"]}
