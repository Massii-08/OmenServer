"""
Utilitaires d'authentification — Hash de mots de passe et tokens JWT.

Comment ça marche :
1. L'utilisateur s'inscrit → on "hashe" son mot de passe (on le transforme
   en chaîne illisible) avant de le stocker. Même si quelqu'un vole la base
   de données, il ne peut pas retrouver le mot de passe.

2. L'utilisateur se connecte → on vérifie que son mot de passe correspond
   au hash stocké, puis on lui donne un JWT (JSON Web Token).

3. Le JWT est un "badge d'accès" temporaire. Le frontend l'envoie à chaque
   requête pour prouver que l'utilisateur est connecté.
"""

from datetime import datetime, timedelta

from fastapi import Depends, HTTPException, status
from fastapi.security import OAuth2PasswordBearer
from jose import JWTError, jwt
from passlib.context import CryptContext
from sqlalchemy.orm import Session

from backend.config import settings
from backend.database import get_db
from backend.auth.models import User

# --- Hash des mots de passe ---
# bcrypt est l'algorithme recommandé : lent exprès pour résister au bruteforce
pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")


def hash_password(password: str) -> str:
    """
    Transforme un mot de passe en hash.
    Exemple: "monmdp123" → "$2b$12$LJ3m5..."
    """
    return pwd_context.hash(password)


def verify_password(plain_password: str, hashed_password: str) -> bool:
    """
    Vérifie si un mot de passe correspond à un hash.
    Retourne True si ça correspond, False sinon.
    """
    return pwd_context.verify(plain_password, hashed_password)


# --- Tokens JWT ---
# OAuth2PasswordBearer dit à FastAPI où trouver le token dans la requête
# (dans le header "Authorization: Bearer <token>")
oauth2_scheme = OAuth2PasswordBearer(tokenUrl="/api/auth/login")


def create_access_token(data: dict) -> str:
    """
    Crée un token JWT avec une date d'expiration.

    Le token contient les données (ex: {"sub": "admin"}) + une date d'expiration.
    Il est signé avec la SECRET_KEY pour qu'on puisse vérifier qu'il n'a pas
    été modifié.
    """
    to_encode = data.copy()
    expire = datetime.utcnow() + timedelta(minutes=settings.ACCESS_TOKEN_EXPIRE_MINUTES)
    to_encode.update({"exp": expire})
    encoded_jwt = jwt.encode(to_encode, settings.SECRET_KEY, algorithm=settings.JWT_ALGORITHM)
    return encoded_jwt


def decode_token(token: str) -> dict:
    """
    Décode un token JWT et retourne le payload.
    Utilisé par les WebSockets (qui ne peuvent pas utiliser Depends).
    Retourne None si le token est invalide.
    """
    try:
        payload = jwt.decode(token, settings.SECRET_KEY, algorithms=[settings.JWT_ALGORITHM])
        return payload
    except JWTError:
        return None


def get_current_user(
    token: str = Depends(oauth2_scheme),
    db: Session = Depends(get_db)
) -> User:
    """
    Dépendance FastAPI qui vérifie le token et retourne l'utilisateur.

    Utilisation dans un router:
        @router.get("/protege")
        def route_protegee(user: User = Depends(get_current_user)):
            return {"message": f"Salut {user.username}!"}

    Si le token est invalide ou expiré → erreur 401 automatique.
    """
    credentials_exception = HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Token invalide ou expiré",
        headers={"WWW-Authenticate": "Bearer"},
    )
    try:
        # Décode le token et vérifie la signature + expiration
        payload = jwt.decode(token, settings.SECRET_KEY, algorithms=[settings.JWT_ALGORITHM])
        username: str = payload.get("sub")
        if username is None:
            raise credentials_exception
    except JWTError:
        raise credentials_exception

    # Cherche l'utilisateur dans la base de données
    user = db.query(User).filter(User.username == username).first()
    if user is None:
        raise credentials_exception
    return user
