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

from fastapi import APIRouter, Depends, HTTPException, UploadFile, File
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

# Racine FIXE de téléchargement : tout download Drive est confiné ici. ni le
# `dest_path` du body ni le `file_name` (métadonnées Drive, attaquant-contrôlable)
# ne peuvent faire sortir de cette racine -> pas d'écriture host arbitraire
# (~/.ssh, repo, cron). Override possible via env pour la prod.
GDRIVE_DOWNLOADS_DIR = Path(os.environ.get(
    "GDRIVE_DOWNLOADS_DIR", str(_home / "omenserver" / "downloads")))


def _safe_download_target(dest_path: str, file_name: str) -> Path:
    """Résout la destination d'un download Drive en la CONFINANT sous
    ``GDRIVE_DOWNLOADS_DIR``. Lève HTTPException(400) si la cible sort de la
    racine (path-traversal via dest_path ou file_name).

    - ``dest_path`` est traité comme un sous-chemin RELATIF à la racine (un
      chemin absolu ou avec ``..`` qui s'évade -> rejet).
    - ``file_name`` est réduit à son basename (rejette ``../``, séparateurs)."""
    root = GDRIVE_DOWNLOADS_DIR.resolve()

    # 1) nom de fichier : basename strict (jamais de séparateur ni '..')
    base = os.path.basename(file_name or "")
    if not base or base in (".", ".."):
        raise HTTPException(400, "Nom de fichier invalide")

    # 2) sous-dossier : relatif à la racine. On strip un éventuel '/' de tête
    #    (sinon Path('/x') ignore la racine), puis on resolve et on vérifie le
    #    confinement.
    sub = (dest_path or "").strip()
    if sub:
        sub = sub.lstrip("/\\")
        target_dir = (root / sub).resolve()
    else:
        target_dir = root

    if target_dir != root and root not in target_dir.parents:
        raise HTTPException(400, "Destination hors du dossier de téléchargement autorisé")

    final = (target_dir / base).resolve()
    if root not in final.parents:
        raise HTTPException(400, "Destination hors du dossier de téléchargement autorisé")
    return final

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
        import google.auth.transport.requests
        import httplib2
        from google_auth_httplib2 import AuthorizedHttp
        # Utiliser httplib2 pour le refresh (fix SSL LibreSSL)
        http = httplib2.Http()
        request = google.auth.transport.requests.Request()
        try:
            creds.refresh(request)
        except Exception:
            # Fallback: refresh manuel via httplib2
            from urllib.parse import urlencode
            import json as _json
            body = urlencode({
                "client_id": creds.client_id,
                "client_secret": creds.client_secret,
                "refresh_token": creds.refresh_token,
                "grant_type": "refresh_token",
            })
            resp, content = http.request(
                "https://oauth2.googleapis.com/token", "POST",
                body=body,
                headers={"Content-Type": "application/x-www-form-urlencoded"},
            )
            if resp.status == 200:
                token_data = _json.loads(content.decode())
                creds.token = token_data.get("access_token")
                creds.expiry = None
                TOKEN_FILE.write_text(creds.to_json())
        else:
            TOKEN_FILE.write_text(creds.to_json())

    if not creds or not creds.valid:
        return None

    # Construire le service avec httplib2 (fix SSL)
    import httplib2
    from google_auth_httplib2 import AuthorizedHttp
    authorized_http = AuthorizedHttp(creds, http=httplib2.Http())
    return build('drive', 'v3', http=authorized_http)


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


# Stockage temporaire du state OAuth (anti-CSRF)
_oauth_states: dict = {}

@router.post("/connect")
def gdrive_connect(current_user: User = Depends(get_current_user)):
    """Génère l'URL d'authentification Google avec redirect localhost."""
    if not _google_available:
        raise HTTPException(400, "Librairies Google non installées")

    if not CREDENTIALS_FILE.exists():
        raise HTTPException(400, "credentials.json manquant")

    try:
        import json
        import secrets as sec
        import time as _time
        cred_data = json.loads(CREDENTIALS_FILE.read_text())
        creds_info = cred_data.get("web") or cred_data.get("installed", {})
        client_id = creds_info.get("client_id", "")

        redirect_uri = "http://localhost:8000/api/gdrive/oauth-redirect"

        # Générer un state anti-CSRF unique
        state = sec.token_urlsafe(32)
        _oauth_states[state] = _time.time()  # Stocker avec timestamp

        auth_url = (
            "https://accounts.google.com/o/oauth2/v2/auth"
            f"?client_id={client_id}"
            f"&redirect_uri={redirect_uri}"
            "&response_type=code"
            "&scope=https://www.googleapis.com/auth/drive"
            "&access_type=offline"
            "&prompt=consent"
            f"&state={state}"
        )

        return {"auth_url": auth_url}
    except Exception as e:
        raise HTTPException(500, f"Erreur: {e}")


@router.get("/oauth-redirect")
def gdrive_oauth_redirect(code: str = None, error: str = None, state: str = None):
    """Callback OAuth — Google redirige ici avec le code. Vérifie le state anti-CSRF."""
    from fastapi.responses import HTMLResponse
    import time as _time

    if error:
        return HTMLResponse("<html><body><h2>❌ Erreur d'authentification</h2><p><a href='http://localhost:8000'>Retour au panel</a></p></body></html>")

    if not code:
        return HTMLResponse("<html><body><h2>❌ Pas de code reçu</h2></body></html>")

    # Vérifier le state anti-CSRF
    if not state or state not in _oauth_states:
        return HTMLResponse("<html><body><h2>❌ Requête invalide (state manquant)</h2><p>Tentative CSRF détectée ou session expirée.</p><p><a href='http://localhost:8000'>Retour au panel</a></p></body></html>")

    # Vérifier que le state n'est pas trop vieux (max 10 minutes)
    state_age = _time.time() - _oauth_states.pop(state, 0)
    if state_age > 600:
        return HTMLResponse("<html><body><h2>❌ Session expirée</h2><p><a href='http://localhost:8000'>Retour au panel</a></p></body></html>")

    try:
        import json
        cred_data = json.loads(CREDENTIALS_FILE.read_text())
        installed = cred_data.get("web") or cred_data.get("installed", {})

        import httplib2
        from urllib.parse import urlencode
        h = httplib2.Http(timeout=15)
        body = urlencode({
            "code": code,
            "client_id": installed.get("client_id"),
            "client_secret": installed.get("client_secret"),
            "redirect_uri": "http://localhost:8000/api/gdrive/oauth-redirect",
            "grant_type": "authorization_code",
        })
        resp, content = h.request(
            "https://oauth2.googleapis.com/token", "POST",
            body=body,
            headers={"Content-Type": "application/x-www-form-urlencoded"},
        )

        if resp.status != 200:
            return HTMLResponse(f"<html><body><h2>❌ Erreur token: {content.decode()}</h2></body></html>")

        token_data = json.loads(content.decode())

        # Sauvegarder le token
        GDRIVE_DIR.mkdir(parents=True, exist_ok=True)
        TOKEN_FILE.write_text(json.dumps({
            "token": token_data.get("access_token"),
            "refresh_token": token_data.get("refresh_token"),
            "token_uri": "https://oauth2.googleapis.com/token",
            "client_id": installed.get("client_id"),
            "client_secret": installed.get("client_secret"),
            "scopes": SCOPES,
        }))

        return HTMLResponse("""
        <html><body style="background:#0f172a;color:white;font-family:sans-serif;display:flex;justify-content:center;align-items:center;height:100vh;margin:0;">
            <div style="text-align:center;">
                <div style="font-size:64px;">✅</div>
                <h1>Google Drive connecté !</h1>
                <p style="color:#94a3b8;">Tu peux fermer cet onglet et retourner sur OmenServer.</p>
                <a href="http://localhost:8000" style="color:#3b82f6;">← Retour au panel</a>
            </div>
        </body></html>
        """)
    except Exception as e:
        return HTMLResponse(f"<html><body><h2>❌ Erreur: {e}</h2></body></html>")


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
    """Télécharger un fichier depuis Drive vers le serveur (admin uniquement).

    La destination est CONFINÉE sous ``GDRIVE_DOWNLOADS_DIR`` : ni le
    ``dest_path`` du body ni le nom du fichier (métadonnées Drive) ne peuvent
    écrire hors de cette racine (anti-écriture host arbitraire)."""
    # écriture de fichier sur l'hôte -> admin strict
    if not getattr(current_user, "is_admin", False):
        raise HTTPException(403, "Seuls les administrateurs peuvent télécharger vers le serveur")

    service = _get_drive_service()
    if not service:
        raise HTTPException(401, "Google Drive non connecté")

    file_id = data.get("file_id")
    dest_path = data.get("dest_path", "")

    if not file_id:
        raise HTTPException(400, "file_id requis")

    try:
        from googleapiclient.http import MediaIoBaseDownload
        import io

        file_meta = service.files().get(fileId=file_id, fields="name,size").execute()
        file_name = file_meta["name"]

        # confine la cible AVANT tout I/O (lève 400 si évasion)
        final = _safe_download_target(dest_path, file_name)
        final.parent.mkdir(parents=True, exist_ok=True)

        request = service.files().get_media(fileId=file_id)
        fh = io.FileIO(str(final), 'wb')
        downloader = MediaIoBaseDownload(fh, request)

        done = False
        while not done:
            _, done = downloader.next_chunk()

        return {"message": f"Fichier '{final.name}' téléchargé", "path": str(final)}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(500, f"Erreur: {e}")


@router.post("/upload")
def gdrive_upload(
    file: UploadFile = File(...),
    folder_id: str = "root",
    current_user: User = Depends(get_current_user),
):
    """Uploader un fichier vers Google Drive."""
    service = _get_drive_service()
    if not service:
        raise HTTPException(401, "Google Drive non connecté")

    try:
        from googleapiclient.http import MediaInMemoryUpload

        content = file.file.read()
        media = MediaInMemoryUpload(content, mimetype=file.content_type or "application/octet-stream")

        metadata = {"name": file.filename}
        if folder_id and folder_id != "root":
            metadata["parents"] = [folder_id]

        uploaded = service.files().create(body=metadata, media_body=media, fields="id,name").execute()

        return {"message": f"Fichier '{uploaded['name']}' uploadé", "file_id": uploaded["id"]}
    except Exception as e:
        raise HTTPException(500, f"Erreur upload: {e}")
