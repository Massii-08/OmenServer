"""
Base de données SQLite avec SQLAlchemy.

SQLAlchemy est un ORM (Object-Relational Mapper).
Au lieu d'écrire du SQL brut, on manipule des objets Python
et SQLAlchemy les traduit en requêtes SQL automatiquement.

Exemple:
    Au lieu de: "INSERT INTO users (username) VALUES ('admin')"
    On écrit:   user = User(username="admin")
                db.add(user)
"""

from sqlalchemy import create_engine
from sqlalchemy.ext.declarative import declarative_base
from sqlalchemy.orm import sessionmaker

from backend.config import settings

# Crée le "moteur" de connexion à la base de données
# check_same_thread=False est nécessaire pour SQLite avec FastAPI (multi-thread)
engine = create_engine(
    settings.DATABASE_URL,
    connect_args={"check_same_thread": False}
)

# SessionLocal = la "fabrique" de sessions de base de données
# Chaque requête API utilisera sa propre session
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)

# Base = la classe parente de tous nos modèles (User, GameServer, etc.)
Base = declarative_base()


def get_db():
    """
    Dépendance FastAPI qui fournit une session de base de données.

    Utilisation dans un router:
        @router.get("/exemple")
        def mon_endpoint(db: Session = Depends(get_db)):
            # utiliser db ici...

    La session est automatiquement fermée après chaque requête.
    """
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def create_tables():
    """
    Crée toutes les tables dans la base de données.
    Appelé au démarrage du serveur.
    Si les tables existent déjà, ne fait rien.
    """
    # Importer tous les modèles pour que SQLAlchemy les découvre
    import backend.auth.models        # noqa: User, Invitation
    import backend.game_server.models  # noqa: GameServer
    import backend.scheduler.models    # noqa: ScheduledTask
    import backend.bots.models         # noqa: Bot
    import backend.webserver.models    # noqa: Website
    import backend.network.models      # noqa: WolDevice, NetworkLog
    Base.metadata.create_all(bind=engine)
