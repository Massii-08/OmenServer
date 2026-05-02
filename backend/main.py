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

# Configuration du logging (affiche les messages dans la console)
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s | %(levelname)s | %(name)s | %(message)s",
)
logger = logging.getLogger("omenserver")

# --- Création de l'application FastAPI ---
app = FastAPI(
    title="OmenServer",
    description="Panel de gestion de serveur dédié polyvalent",
    version="1.0.0",
)

# --- Middleware CORS ---
# Permet au frontend de communiquer avec le backend pendant le développement
# (quand le frontend et le backend sont sur des ports différents)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # En production, restreindre aux domaines autorisés
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

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
        return FileResponse(index_path)
    return {"message": f"{settings.SERVER_NAME} API is running"}


@app.get("/login")
async def serve_login():
    """Page de connexion."""
    login_path = os.path.join(frontend_dir, "login.html")
    if os.path.exists(login_path):
        return FileResponse(login_path)
    return {"message": "Login page not found"}


@app.get("/favicon.svg")
async def serve_favicon():
    """Favicon du panel."""
    favicon_path = os.path.join(frontend_dir, "favicon.svg")
    if os.path.exists(favicon_path):
        return FileResponse(favicon_path, media_type="image/svg+xml")
    return {"message": "Favicon not found"}


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
