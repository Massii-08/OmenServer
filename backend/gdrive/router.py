"""
Module Google Drive — Intégration cloud personnel.

Permet de naviguer, uploader, télécharger et synchroniser des fichiers
entre le serveur OmenServer et Google Drive.

⚠️ Configuration requise:
    1. Aller sur https://console.cloud.google.com/
    2. Créer un projet et activer "Google Drive API"
    3. Créer des identifiants OAuth 2.0 (type: Application de bureau)
    4. Télécharger le fichier credentials.json
    5. Le placer dans /opt/omenserver/gdrive/credentials.json

Routes:
    GET    /api/gdrive/status       → Vérifier si Google Drive est connecté
    POST   /api/gdrive/connect      → Lancer le processus d'authentification OAuth
    GET    /api/gdrive/files        → Lister les fichiers Drive
    POST   /api/gdrive/upload       → Uploader un fichier vers Drive
    POST   /api/gdrive/download     → Télécharger un fichier depuis Drive
"""

import os
import logging
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from backend.database import get_db
from backend.auth.utils import get_current_user
from backend.auth.models import User

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/gdrive", tags=["Google Drive"])

_home = Path.home()
GDRIVE_DIR = Path(os.environ.get("GDRIVE_DIR", str(_home / "omenserver" / "gdrive")))
CREDENTIALS_FILE = GDRIVE_DIR / "credentials.json"
TOKEN_FILE = GDRIVE_DIR / "token.json"

# Flag pour vérifier si les librairies Google sont installées
_google_available = False
try:
    from google.oauth2.credentials import Credentials
    from google_auth_oauthlib.flow import InstalledAppFlow
    from google.auth.transport.requests import Request
    from googleapiclient.discovery import build
    _google_available = True
except ImportError:
    logger.warning("Google Drive API libraries not installed. Run: pip install google-api-python-client google-auth-oauthlib")


SCOPES = ['https://www.googleapis.com/auth/drive']


def _get_drive_service():
    """Créer un service Google Drive authentifié."""
    if not _google_available:
        return None

    creds = None
    if TOKEN_FILE.exists():
        creds = Credentials.from_authorized_user_file(str(TOKEN_FILE), SCOPES)

    if creds and creds.expired and creds.refresh_token:
        creds.refresh(Request())
        TOKEN_FILE.write_text(creds.to_json())

    if not creds or not creds.valid:
        return None

    return build('drive', 'v3', credentials=creds)


@router.get("/status")
def gdrive_status(current_user: User = Depends(get_current_user)):
    """Vérifier si Google Drive est configuré et connecté."""
    if not _google_available:
        return {
            "connected": False,
            "status": "not_installed",
            "message": "Librairies Google non installées. Exécutez: pip install google-api-python-client google-auth-oauthlib",
        }

    if not CREDENTIALS_FILE.exists():
        return {
            "connected": False,
            "status": "no_credentials",
            "message": "Fichier credentials.json manquant. Créez des identifiants sur console.cloud.google.com",
        }

    service = _get_drive_service()
    if service:
        try:
            about = service.about().get(fields="user").execute()
            email = about.get("user", {}).get("emailAddress", "")
            return {
                "connected": True,
                "status": "connected",
                "email": email,
                "message": f"Connecté en tant que {email}",
            }
        except Exception as e:
            return {"connected": False, "status": "error", "message": str(e)}
    else:
        return {
            "connected": False,
            "status": "not_authenticated",
            "message": "Non authentifié. Cliquez sur 'Connecter' pour lancer l'authentification OAuth.",
        }


@router.post("/connect")
def gdrive_connect(current_user: User = Depends(get_current_user)):
    """Lancer le processus d'authentification OAuth dans un thread séparé."""
    if not _google_available:
        raise HTTPException(400, "Librairies Google non installées")

    if not CREDENTIALS_FILE.exists():
        raise HTTPException(400, "credentials.json manquant")

    try:
        import threading

        def _run_oauth():
            try:
                flow = InstalledAppFlow.from_client_secrets_file(str(CREDENTIALS_FILE), SCOPES)
                for port in [8091, 8092, 8093, 8094, 8095]:
                    try:
                        creds = flow.run_local_server(port=port, open_browser=True)
                        break
                    except OSError:
                        continue
                else:
                    logger.error("Tous les ports OAuth occupés")
                    return

                GDRIVE_DIR.mkdir(parents=True, exist_ok=True)
                TOKEN_FILE.write_text(creds.to_json())
                logger.info("✅ Google Drive authentifié avec succès")
            except Exception as e:
                logger.error(f"Erreur OAuth: {e}")

        t = threading.Thread(target=_run_oauth, daemon=True)
        t.start()

        return {
            "message": "Authentification lancée ! Une page Google va s'ouvrir dans ton navigateur. Autorise l'accès puis reviens ici.",
            "started": True,
        }
    except Exception as e:
        raise HTTPException(500, f"Erreur OAuth: {e}")


@router.get("/files")
def gdrive_list_files(
    folder_id: str = "root",
    current_user: User = Depends(get_current_user),
):
    """Lister les fichiers dans un dossier Drive."""
    service = _get_drive_service()
    if not service:
        raise HTTPException(401, "Google Drive non connecté")

    try:
        query = f"'{folder_id}' in parents and trashed = false"
        results = service.files().list(
            q=query,
            pageSize=100,
            fields="files(id, name, mimeType, size, modifiedTime, iconLink, webViewLink)",
            orderBy="folder,name",
        ).execute()

        files = results.get("files", [])
        return {
            "files": [{
                "id": f["id"],
                "name": f["name"],
                "type": "folder" if f["mimeType"] == "application/vnd.google-apps.folder" else "file",
                "mimeType": f["mimeType"],
                "size": int(f.get("size", 0)),
                "modified": f.get("modifiedTime"),
                "icon": f.get("iconLink"),
                "link": f.get("webViewLink"),
            } for f in files],
            "folder_id": folder_id,
        }
    except Exception as e:
        raise HTTPException(500, f"Erreur Drive: {e}")


@router.post("/download")
def gdrive_download(
    data: dict,
    current_user: User = Depends(get_current_user),
):
    """Télécharger un fichier depuis Drive vers le serveur."""
    service = _get_drive_service()
    if not service:
        raise HTTPException(401, "Google Drive non connecté")

    file_id = data.get("file_id")
    dest_path = data.get("dest_path", "/opt/omenserver/downloads")

    if not file_id:
        raise HTTPException(400, "file_id requis")

    try:
        from googleapiclient.http import MediaIoBaseDownload
        import io

        file_meta = service.files().get(fileId=file_id, fields="name,size").execute()
        file_name = file_meta["name"]

        request = service.files().get_media(fileId=file_id)
        dest = Path(dest_path)
        dest.mkdir(parents=True, exist_ok=True)

        fh = io.FileIO(str(dest / file_name), 'wb')
        downloader = MediaIoBaseDownload(fh, request)

        done = False
        while not done:
            _, done = downloader.next_chunk()

        return {"message": f"Fichier '{file_name}' téléchargé", "path": str(dest / file_name)}
    except Exception as e:
        raise HTTPException(500, f"Erreur: {e}")
