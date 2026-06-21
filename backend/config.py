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
# interpolate=False : les clés CurseForge contiennent des $ (ex: $2a$10$...)
# que python-dotenv essaierait d'interpoler comme des variables
load_dotenv(PROJECT_DIR / ".env", interpolate=False)


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
    # Sécurité : auto-génère une clé si la valeur par défaut est utilisée
    _raw_secret = os.getenv("SECRET_KEY", "")
    if not _raw_secret or _raw_secret == "change-moi-en-production-stp":
        import secrets as _secrets
        _raw_secret = _secrets.token_urlsafe(64)
        # Écrire la clé générée dans .env pour la persister
        _env_file = PROJECT_DIR / ".env"
        try:
            if _env_file.exists():
                _env_content = _env_file.read_text()
                if "SECRET_KEY=" in _env_content:
                    import re as _re
                    _env_content = _re.sub(
                        r'SECRET_KEY=.*',
                        f'SECRET_KEY={_raw_secret}',
                        _env_content,
                    )
                else:
                    _env_content += f"\nSECRET_KEY={_raw_secret}\n"
                _env_file.write_text(_env_content)
            else:
                _env_file.write_text(f"SECRET_KEY={_raw_secret}\n")
            # Sécurité : le .env contient le secret JWT → restreindre à l'owner (0o600).
            # Best-effort (certains FS ne supportent pas chmod ; ne doit pas crasher le boot).
            try:
                os.chmod(_env_file, 0o600)
            except OSError:
                pass
            import logging as _logging
            _logging.getLogger("omenserver").warning(
                "🔑 SECRET_KEY générée automatiquement et sauvegardée dans .env"
            )
        except Exception:
            pass  # En lecture seule — la clé sera régénérée au prochain restart
    SECRET_KEY: str = _raw_secret
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
