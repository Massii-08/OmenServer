"""
Configuration du serveur OmenServer.

Ce fichier contient tous les réglages du serveur.
On utilise python-dotenv pour pouvoir changer les réglages
sans modifier le code (via un fichier .env).
"""

import os
from pathlib import Path
from dotenv import load_dotenv

# Chemin racine du projet (le dossier parent de backend/)
PROJECT_DIR = Path(__file__).resolve().parent.parent

# Charge les variables depuis le fichier .env (chemin absolu pour systemd/production)
load_dotenv(PROJECT_DIR / ".env")


class Settings:
    """Tous les réglages du serveur, centralisés ici."""

    # --- Nom du serveur ---
    SERVER_NAME: str = os.getenv("SERVER_NAME", "OmenServer")

    # --- Base de données ---
    # SQLite stocke tout dans un seul fichier, simple et efficace
    # On utilise un chemin absolu pour éviter les problèmes de permissions
    _db_path = PROJECT_DIR / "data" / "omenserver.db"
    DATABASE_URL: str = os.getenv("DATABASE_URL", f"sqlite:///{_db_path}")

    # --- Authentification JWT ---
    SECRET_KEY: str = os.getenv("SECRET_KEY", "change-moi-en-production-stp")
    JWT_ALGORITHM: str = "HS256"
    ACCESS_TOKEN_EXPIRE_MINUTES: int = int(os.getenv("TOKEN_EXPIRE_MINUTES", "1440"))

    # --- Serveur ---
    HOST: str = os.getenv("HOST", "0.0.0.0")
    PORT: int = int(os.getenv("PORT", "8000"))

    # --- Docker ---
    MINECRAFT_IMAGE: str = os.getenv("MINECRAFT_IMAGE", "itzg/minecraft-server")

    # --- Chemins ---
    BASE_DIR: str = str(PROJECT_DIR)
    SERVERS_DATA_DIR: str = os.getenv("SERVERS_DATA_DIR", str(PROJECT_DIR / "data" / "servers"))
    YIELD_BOT_DIR: str = os.getenv("YIELD_BOT_DIR", str(Path.home() / "omenserver" / "bots" / "yield-bot"))


# Instance unique des settings, importable partout
settings = Settings()
