"""
OmenServer — Point d'entrée principal.

Ce fichier assemble tous les composants du serveur :
- Monte les routers (auth, monitoring, modules, game_server)
- Sert les fichiers frontend (HTML/CSS/JS)
- Crée les tables de la base de données au démarrage

Pour lancer le serveur :
    cd "Projet serveur"
    source venv/bin/activate
    uvicorn backend.main:app --reload

Puis ouvrir http://localhost:8000 dans le navigateur.
"""

import os
import logging

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from fastapi.middleware.cors import CORSMiddleware

from backend.config import settings
from backend.database import create_tables

# Configuration du logging avec rotation des fichiers
from logging.handlers import RotatingFileHandler

# Handler console
console_handler = logging.StreamHandler()
console_handler.setFormatter(logging.Formatter(
    "%(asctime)s | %(levelname)s | %(name)s | %(message)s"
))

# Handler fichier avec rotation (max 5 Mo, garde 5 fichiers)
_log_dir = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "logs")
os.makedirs(_log_dir, exist_ok=True)
file_handler = RotatingFileHandler(
    os.path.join(_log_dir, "omenserver.log"),
    maxBytes=5 * 1024 * 1024,  # 5 Mo
    backupCount=5,
    encoding="utf-8",
)
file_handler.setFormatter(logging.Formatter(
    "%(asctime)s | %(levelname)s | %(name)s | %(message)s"
))

logging.basicConfig(
    level=logging.INFO,
    handlers=[console_handler, file_handler],
)
logger = logging.getLogger("omenserver")

# --- Création de l'application FastAPI ---
app = FastAPI(
    title="OmenServer",
    description="Panel de gestion de serveur dédié polyvalent",
    version="4.0.0",
    docs_url=None,     # Désactiver Swagger en production (sécurité)
    redoc_url=None,    # Désactiver Redoc en production (sécurité)
)

# --- Middleware CORS ---
# Permet au frontend de communiquer avec le backend pendant le développement
# (quand le frontend et le backend sont sur des ports différents)
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:8000",
        "http://127.0.0.1:8000",
        f"http://{os.getenv('HOST', '0.0.0.0')}:{os.getenv('PORT', '8000')}",
        "https://omenserver.org",
        "http://omenserver.org",
    ],
    allow_credentials=True,
    allow_methods=["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type"],
    expose_headers=["Content-Disposition"],
)


# --- Middleware Rate Limiting ---
from starlette.requests import Request
from backend.rate_limiter import rate_limit_middleware

@app.middleware("http")
async def rate_limit(request: Request, call_next):
    """Protection contre le bombardement de requêtes (120/min par IP, 10/min login)."""
    return await rate_limit_middleware(request, call_next)


# --- Middleware Security Headers ---

@app.middleware("http")
async def security_headers(request: Request, call_next):
    """Ajoute des en-têtes de sécurité à toutes les réponses."""
    response = await call_next(request)
    response.headers["X-Frame-Options"] = "DENY"
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-XSS-Protection"] = "1; mode=block"
    response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
    # CSP : autoriser scripts/styles du même origin + inline (nécessaire pour le SPA vanilla JS)
    response.headers["Content-Security-Policy"] = (
        "default-src 'self'; "
        "script-src 'self' 'unsafe-inline'; "
        "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; "
        "font-src 'self' https://fonts.gstatic.com; "
        "img-src 'self' data: blob: "
        "https://media.forgecdn.net "  # CurseForge mods/modpacks thumbnails
        "https://cdn.modrinth.com "    # Modrinth alt
        "https://steamuserimages-a.akamaihd.net "  # Steam Workshop
        "https://media.steampowered.com "          # Steam Workshop alt
        "https://*.spigotmc.org "      # Spigot plugins
        "; "
        "connect-src 'self' ws: wss:; "
        "frame-ancestors 'none'; "
        "base-uri 'self'; "
        "form-action 'self'"
    )
    response.headers["Permissions-Policy"] = "camera=(), microphone=(), geolocation=()"
    return response

# --- Import et montage des routers ---
# Chaque router gère un groupe de routes (ex: /api/auth/*, /api/monitoring/*, etc.)
from backend.auth.router import router as auth_router
from backend.auth.invite_router import router as invite_router
from backend.monitoring.router import router as monitoring_router
from backend.modules.router import router as modules_router
from backend.game_server.router import router as game_server_router
from backend.game_server.websocket import router as ws_router
from backend.game_server.backup_router import router as backup_router
from backend.scheduler.router import router as scheduler_router
from backend.mods.router import router as mods_router
from backend.game_server.settings_router import router as settings_router
from backend.game_server.players_router import router as players_router
from backend.game_server.access_router import router as access_router
from backend.game_server.files_router import router as files_router
from backend.monitoring.container_router import router as container_router
from backend.activity.router import router as activity_router
from backend.mods.plugin_router import router as plugin_router
from backend.notifications.router import router as notification_router
from backend.monitoring.diagnostic_router import router as diagnostic_router
from backend.bots.router import router as bots_router
from backend.bots.yield_router import router as yield_router
from backend.bots.scanner_router import router as scanner_router
from backend.bots.mc_agent_router import router as mc_agent_router
from backend.bots.mc_capture_router import router as mc_capture_router
from backend.bots.harvester_router import router as harvester_router
from backend.bots.oracle_router import router as oracle_router
from backend.gdrive.router import router as gdrive_router
from backend.media.router import router as media_router
from backend.webserver.router import router as webserver_router
from backend.network.router import router as network_router
from backend.scheduler.power_router import router as power_router
from backend.monitoring.nodes_router import router as nodes_router
from backend.auth.sharing_router import router as sharing_router
from backend.sysdoc.router import router as sysdoc_router
from backend.sysdoc.ws_router import router as sysdoc_ws_router

app.include_router(auth_router)
app.include_router(invite_router)
app.include_router(monitoring_router)
app.include_router(modules_router)
app.include_router(game_server_router)
app.include_router(ws_router)
app.include_router(backup_router)
app.include_router(scheduler_router)
app.include_router(mods_router)
app.include_router(settings_router)
app.include_router(players_router)
app.include_router(access_router)
app.include_router(files_router)
app.include_router(container_router)
app.include_router(activity_router)
app.include_router(plugin_router)
app.include_router(notification_router)
app.include_router(diagnostic_router)
app.include_router(bots_router)
app.include_router(yield_router)
app.include_router(scanner_router)
app.include_router(mc_agent_router)
app.include_router(mc_capture_router)
app.include_router(harvester_router)
app.include_router(oracle_router)
app.include_router(gdrive_router)
app.include_router(media_router)
app.include_router(webserver_router)
app.include_router(network_router)
app.include_router(power_router)
app.include_router(nodes_router)
app.include_router(sharing_router)
app.include_router(sysdoc_router)
app.include_router(sysdoc_ws_router)


# --- Événement de démarrage ---
@app.on_event("startup")
async def startup_event():
    """
    Exécuté au démarrage du serveur.
    - Crée les tables de la base de données (si elles n'existent pas)
    - Crée le dossier data/ pour stocker les fichiers des serveurs
    """
    logger.info(f"🖥️  {settings.SERVER_NAME} démarre...")
    create_tables()
    logger.info("📦 Base de données initialisée")

    # Migration : ajouter les colonnes manquantes (SQLite ne supporte pas ALTER TABLE IF NOT EXISTS)
    from sqlalchemy import text
    from backend.database import SessionLocal
    db = SessionLocal()
    try:
        migrations = [
            ("game_servers", "cpu_percent", "INTEGER DEFAULT 100"),
            ("users", "role", "VARCHAR(20) DEFAULT 'player'"),
            ("users", "invited_by", "INTEGER"),
            ("users", "allowed_modules", "VARCHAR(500)"),
            ("scheduled_tasks", "bot_id", "INTEGER REFERENCES bots(id) ON DELETE CASCADE"),
            ("scheduled_tasks", "schedule_time", "VARCHAR(5)"),
            ("scheduled_tasks", "schedule_days", "VARCHAR(50)"),
            # RBAC : ownership des ressources
            ("game_servers", "owner_id", "INTEGER REFERENCES users(id)"),
            ("game_servers", "connect_alias", "VARCHAR(100)"),
            ("game_servers", "sftp_password", "VARCHAR(50)"),
            ("bots", "owner_id", "INTEGER REFERENCES users(id)"),
            ("websites", "owner_id", "INTEGER REFERENCES users(id)"),
            # Invitations multi-usage avec échéance temporelle
            ("invitations", "expires_at", "DATETIME"),
            ("invitations", "max_uses", "INTEGER DEFAULT 0"),
            ("invitations", "uses", "INTEGER DEFAULT 0"),
        ]
        for table, column, col_type in migrations:
            try:
                db.execute(text(f"ALTER TABLE {table} ADD COLUMN {column} {col_type}"))
                db.commit()
                logger.info(f"🔧 Migration: ajouté {table}.{column}")
            except Exception:
                db.rollback()  # La colonne existe déjà
    finally:
        db.close()

    # Migration RBAC : assigner les serveurs/bots sans owner à l'admin principal
    from backend.database import SessionLocal
    from backend.auth.models import User
    from backend.game_server.models import GameServer
    from backend.bots.models import Bot
    db = SessionLocal()
    try:
        admin = db.query(User).filter(User.is_admin == True).first()
        if admin:
            # Serveurs sans owner → assigner à l'admin
            orphan_servers = db.query(GameServer).filter(GameServer.owner_id == None).all()
            for srv in orphan_servers:
                srv.owner_id = admin.id
                logger.info(f"🔧 RBAC: serveur '{srv.name}' → owner={admin.username}")

            # Bots sans owner → assigner à l'admin
            orphan_bots = db.query(Bot).filter(Bot.owner_id == None).all()
            for bot in orphan_bots:
                bot.owner_id = admin.id
                logger.info(f"🔧 RBAC: bot '{bot.name}' → owner={admin.username}")

            if orphan_servers or orphan_bots:
                db.commit()
    finally:
        db.close()

    # Migration : corriger les admins qui n'ont pas role="admin"
    from backend.database import SessionLocal
    from backend.auth.models import User
    db = SessionLocal()
    try:
        admins_without_role = db.query(User).filter(
            User.is_admin == True,
            (User.role == None) | (User.role == "player")
        ).all()
        for admin in admins_without_role:
            admin.role = "admin"
            logger.info(f"🔧 Migration: {admin.username} → role=admin")
        if admins_without_role:
            db.commit()
    finally:
        db.close()

    # Créer le dossier data/servers si nécessaire
    os.makedirs(settings.SERVERS_DATA_DIR, exist_ok=True)
    logger.info("📁 Dossiers de données créés")

    # Démarrer le scheduler (tâches planifiées)
    from backend.scheduler.engine import start_scheduler
    start_scheduler()

    # Auto-redémarrage des serveurs de jeux
    # Quand l'Omen reboot ou OmenServer redémarre (auto-deploy),
    # on vérifie que tous les conteneurs Docker sont bien running.
    try:
        from backend.database import SessionLocal
        from backend.game_server.models import GameServer
        db = SessionLocal()
        try:
            servers = db.query(GameServer).filter(GameServer.docker_id != None).all()
            if servers:
                import docker
                try:
                    client = docker.from_env()
                    client.ping()
                except Exception as e:
                    logger.warning(f"🐳 Docker non disponible, skip auto-restart: {e}")
                    servers = []  # Skip si Docker n'est pas dispo

                started = 0
                for srv in servers:
                    try:
                        container = client.containers.get(srv.docker_id)
                        if container.status == "running":
                            # Déjà running → juste sync le statut DB
                            if srv.status != "running":
                                srv.status = "running"
                                logger.info(f"🔄 Sync statut: {srv.name} → running")
                        elif container.status in ("exited", "created", "paused"):
                            if srv.status == "running":
                                # État désiré = allumé → on le restaure après reboot/auto-deploy
                                container.start()
                                started += 1
                                logger.info(f"🚀 Auto-restart: {srv.name} ({container.status} → running)")
                            else:
                                # Éteint volontairement (status 'stopped'/'error') → on le LAISSE éteint
                                srv.status = "stopped"
                                logger.info(f"💤 {srv.name} laissé éteint (arrêt volontaire respecté)")
                        else:
                            # État inconnu (restarting, dead, etc.)
                            srv.status = container.status
                            logger.warning(f"⚠️ {srv.name} en état: {container.status}")
                    except Exception as e:
                        srv.status = "error"
                        logger.warning(f"❌ Auto-restart échoué: {srv.name} → {e}")

                db.commit()
                if started > 0:
                    logger.info(f"🎮 {started} serveur(s) de jeu redémarré(s) automatiquement")
                else:
                    logger.info(f"🎮 {len(servers)} serveur(s) de jeu vérifiés — tous OK")

            # Démarrer/recréer le conteneur SFTP
            try:
                from backend.game_server.sftp_manager import rebuild_sftp_container
                sftp_result = rebuild_sftp_container(db)
                logger.info(f"📁 SFTP: {sftp_result.get('status', 'unknown')} ({sftp_result.get('users', 0)} utilisateurs)")
            except Exception as e:
                logger.warning(f"SFTP rebuild au démarrage échoué: {e}")
        finally:
            db.close()
    except Exception as e:
        logger.warning(f"Erreur auto-restart serveurs: {e}")

    # Reprise auto des moissons interrompues (tuées par le restart/auto-deploy).
    # Le store frontier persiste sur disque -> on relance depuis là où elles en
    # étaient, sans toucher à systemd. Survie réelle au restart pour le harvester.
    try:
        from backend.bots.harvester_router import purge_old_runs, resume_interrupted_runs
        resumed = resume_interrupted_runs()
        if resumed:
            logger.info(f"🌾 Harvester: {len(resumed)} moisson(s) reprise(s) depuis la frontière: {resumed}")
        purged = purge_old_runs()
        if purged:
            logger.info(f"🧹 Harvester: {len(purged)} run(s) ancien(s) purgé(s)")
    except Exception as e:
        logger.warning(f"Harvester resume au démarrage échoué: {e}")

    logger.info(f"🚀 {settings.SERVER_NAME} est prêt ! → http://localhost:{settings.PORT}")


@app.on_event("shutdown")
async def shutdown_event():
    """Arrêter proprement le scheduler."""
    from backend.scheduler.engine import stop_scheduler
    stop_scheduler()


# --- Servir le frontend ---
# On sert les fichiers statiques (CSS, JS) depuis le dossier frontend/
frontend_dir = os.path.join(os.path.dirname(os.path.dirname(__file__)), "frontend")

if os.path.exists(frontend_dir):
    # Monter les fichiers CSS et JS
    css_dir = os.path.join(frontend_dir, "css")
    js_dir = os.path.join(frontend_dir, "js")

    if os.path.exists(css_dir):
        app.mount("/css", StaticFiles(directory=css_dir), name="css")
    if os.path.exists(js_dir):
        app.mount("/js", StaticFiles(directory=js_dir), name="js")


@app.get("/")
async def serve_index():
    """Page principale du panel (redirige vers login si pas connecté)."""
    index_path = os.path.join(frontend_dir, "index.html")
    if os.path.exists(index_path):
        return FileResponse(index_path, headers={"Cache-Control": "no-cache, no-store, must-revalidate"})
    return {"message": f"{settings.SERVER_NAME} API is running"}


@app.get("/login")
async def serve_login():
    """Page de connexion."""
    login_path = os.path.join(frontend_dir, "login.html")
    if os.path.exists(login_path):
        return FileResponse(login_path, headers={"Cache-Control": "no-cache, no-store, must-revalidate"})
    return {"message": "Login page not found"}


@app.get("/favicon.svg")
async def serve_favicon():
    """Favicon du panel."""
    favicon_path = os.path.join(frontend_dir, "favicon.svg")
    if os.path.exists(favicon_path):
        return FileResponse(favicon_path, media_type="image/svg+xml")
    return {"message": "Favicon not found"}


@app.get("/sw.js")
async def serve_sw():
    """Service Worker — doit être servi depuis la racine pour le bon scope."""
    sw_path = os.path.join(frontend_dir, "sw.js")
    if os.path.exists(sw_path):
        return FileResponse(sw_path, media_type="application/javascript",
                          headers={"Cache-Control": "no-cache", "Service-Worker-Allowed": "/"})
    return {"message": "Service Worker not found"}


@app.get("/manifest.json")
async def serve_manifest():
    """Manifest PWA."""
    manifest_path = os.path.join(frontend_dir, "manifest.json")
    if os.path.exists(manifest_path):
        return FileResponse(manifest_path, media_type="application/manifest+json")
    return {"message": "Manifest not found"}


@app.get("/icon-512.svg")
async def serve_icon_512():
    """Icône PWA 512x512."""
    icon_path = os.path.join(frontend_dir, "icon-512.svg")
    if os.path.exists(icon_path):
        return FileResponse(icon_path, media_type="image/svg+xml")
    return {"message": "Icon not found"}


# --- Route de santé ---
@app.get("/api/health")
async def health_check():
    """
    Route de vérification de santé.
    Utilisée pour vérifier que le serveur fonctionne.
    """
    return {
        "status": "healthy",
        "server_name": settings.SERVER_NAME,
        "version": "1.0.0",
    }
