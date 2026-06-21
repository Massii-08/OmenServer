"""
Fixtures partagées pour les tests de sécurité du module game_server.

Monte une mini-app FastAPI avec un router ciblé + une DB SQLite IN-MEMORY
isolée (JAMAIS la vraie base). Override get_db et get_current_user pour
simuler un owner (id=1) et un intrus (id=2, rôle spectator).

Le but est de prouver que le gate d'autorisation court-circuite AVANT tout
appel Docker → l'intrus reçoit 403 sans qu'on ait besoin de mocker Docker.
"""

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from backend.database import Base, get_db

# Enregistre toutes les tables nécessaires
import backend.auth.models  # noqa: F401
import backend.auth.shared_access  # noqa: F401
import backend.game_server.models  # noqa: F401
import backend.bots.models  # noqa: F401

from backend.auth.models import User
from backend.auth.shared_access import SharedAccess
from backend.game_server.models import GameServer
from backend.auth.utils import get_current_user


def make_engine():
    """Crée un moteur SQLite in-memory frais et les tables."""
    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(engine)
    return engine


def seed_db(SessionFactory):
    """Crée 2 users (owner id=1, intrus id=2 spectator) + un GameServer owner_id=1."""
    db = SessionFactory()
    try:
        owner = User(id=1, username="owner", hashed_password="x", is_admin=False, role="player")
        intruder = User(id=2, username="intruder", hashed_password="x", is_admin=False, role="spectator")
        admin = User(id=3, username="admin", hashed_password="x", is_admin=True, role="admin")
        db.add_all([owner, intruder, admin])
        srv = GameServer(id=1, name="OwnerServer", game_type="minecraft",
                         docker_id="deadbeefcafe", port=25565, owner_id=1, status="stopped")
        db.add(srv)
        db.commit()
    finally:
        db.close()


def build_client(router, user_getter):
    """
    Construit un TestClient pour un router donné, avec une DB in-memory seedée
    et un override de get_current_user qui retourne l'utilisateur fourni par
    user_getter (callable -> User détaché de session, re-attaché à chaque requête).
    """
    engine = make_engine()
    SessionFactory = sessionmaker(autocommit=False, autoflush=False, bind=engine)
    seed_db(SessionFactory)

    app = FastAPI()
    app.include_router(router)

    def override_get_db():
        db = SessionFactory()
        try:
            yield db
        finally:
            db.close()

    def override_get_current_user():
        # Recharge l'utilisateur depuis la DB de test à chaque requête.
        db = SessionFactory()
        try:
            u = db.query(User).filter(User.id == user_getter()).first()
            # Détacher pour pouvoir l'utiliser après fermeture de session
            db.expunge(u)
            return u
        finally:
            db.close()

    app.dependency_overrides[get_db] = override_get_db
    app.dependency_overrides[get_current_user] = override_get_current_user

    return TestClient(app, raise_server_exceptions=False), SessionFactory


# IDs pratiques
OWNER_ID = 1
INTRUDER_ID = 2
ADMIN_ID = 3
