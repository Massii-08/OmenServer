"""
Routes Bond Scanner — Scansione automatica del mercato obbligazionario.

Ce router gère le bot spécialisé "Bond Scanner" qui :
1. Scanne le marché obligataire sur Deutsche Börse
2. Filtre selon les critères configurables (prix, yield, scadenza, rating)
3. Calcule le yield avec la formule 30/360
4. Génère un fichier Excel au format "Lista acquisti"

Routes:
    POST   /api/bots/scanner/run          → Lancer un scan
    GET    /api/bots/scanner/status/{id}  → État + logs temps réel
    GET    /api/bots/scanner/download/{id} → Télécharger le résultat
    GET    /api/bots/scanner/usage        → Rate limit (2/jour)
    POST   /api/bots/scanner/stop/{id}    → Arrêter un scan
    GET    /api/bots/scanner/active       → Job actif (reconnexion)
"""

import json
import logging
import os
import re
import subprocess
import sys
import threading
import uuid
from datetime import datetime
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import FileResponse
from pydantic import BaseModel

from backend.auth.models import User
from backend.auth.permissions import require_role

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/bots/scanner", tags=["Bond Scanner"])

# Dossier du bot scanner — dans le repo (synced via git pull)
_project_root = Path(__file__).resolve().parent.parent.parent
SCANNER_BOT_DIR = Path(os.environ.get(
    "SCANNER_BOT_DIR",
    str(_project_root / "bond-scanner")
))
# Outputs dans un dossier séparé
_home = Path.home()
OUTPUTS_DIR = Path(os.environ.get(
    "SCANNER_OUTPUTS_DIR",
    str(_home / "omenserver" / "bots" / "scanner-outputs")
))

# Task 16 (2026-05-28) — Brave Search API key (shared avec le Yield Bot).
# Le fichier est posé par yield_router.py:set_rating_key() OU par le
# nouveau endpoint scanner_router /settings/rating-key (les 2 écrivent au
# même endroit). Le Bond Scanner subprocess récupère la clé via env var
# BRAVE_SEARCH_API_KEY — qu'on injecte ici si pas déjà dans os.environ.
RATING_KEY_PATH = _project_root / "data" / "secrets" / "brave.key"


def _load_rating_key() -> Optional[str]:
    """Retourne la clé Brave : env var prime, sinon le fichier partagé."""
    env_key = os.environ.get("BRAVE_SEARCH_API_KEY")
    if env_key:
        return env_key
    if RATING_KEY_PATH.is_file():
        try:
            content = RATING_KEY_PATH.read_text(encoding="utf-8").strip()
            return content or None
        except Exception as e:
            logger.warning(f"Can't read shared rating key file: {e!r}")
    return None


def _mask_key(key: str) -> str:
    """Preview masqué de la clé. Ex: 'BSAB…YpGn' (6 + … + 4)."""
    if not key or len(key) < 12:
        return "***"
    return f"{key[:6]}…{key[-4:]}"


# Stockage des jobs en mémoire
_scanner_jobs: dict[str, dict] = {}


class ScanRequest(BaseModel):
    max_price: float = 100.0
    min_yield: float = 0.03
    max_maturity: int = 9
    min_rating: str = "BBB"          # Task 15 (2026-05-28) — default BBB
    currencies: str = "EUR,USD,GBP"
    price_threshold: float = 101.0
    target_count: int = 20           # Range 1-20 (2026-05-28, marché bonds qualité petit)


# ================================================================
#  RUN
# ================================================================

@router.post("/run")
async def run_scanner(
    data: ScanRequest,
    current_user: User = Depends(require_role("admin", "money")),
):
    """Lance une scansione del mercato."""
    # Générer un job_id
    job_id = str(uuid.uuid4())[:8]

    # Créer le dossier de sortie
    job_dir = OUTPUTS_DIR / job_id
    job_dir.mkdir(parents=True, exist_ok=True)

    # Chemin du fichier de sortie
    output_path = str(job_dir / f"Opportunita_Bond_{datetime.now().strftime('%Y-%m-%d')}.xlsx")

    # Construire la commande
    cmd = [
        sys.executable, "main.py", "--scan",
        "--max-price", str(data.max_price),
        "--min-yield", str(data.min_yield),
        "--max-maturity", str(data.max_maturity),
        "--min-rating", data.min_rating,
        "--currencies", data.currencies,
        "--price-threshold", str(data.price_threshold),
        "--target-count", str(data.target_count),
        "--output", output_path,
    ]

    logger.info(f"[Scanner] Lancement: {' '.join(cmd)}")

    # Créer le job
    _scanner_jobs[job_id] = {
        "status": "running",
        "logs": [],
        "process": None,
        "output_path": output_path,
        "criteria": data.dict(),
        "stats": {
            "total_scanned": 0,
            "total_filtered": 0,
            "total_discarded": 0,
            "total_errors": 0,
        },
        "created_at": datetime.utcnow().isoformat(),
        "user": current_user.username,
    }

    job = _scanner_jobs[job_id]

    # Task 16 — injecte la clé Brave dans l'env si pas déjà présente
    # (ainsi le fichier data/secrets/brave.key prend effet sans restart).
    subprocess_env = {**os.environ, "PYTHONUNBUFFERED": "1"}
    if "BRAVE_SEARCH_API_KEY" not in subprocess_env:
        loaded_key = _load_rating_key()
        if loaded_key:
            subprocess_env["BRAVE_SEARCH_API_KEY"] = loaded_key

    try:
        proc = subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            bufsize=1,
            cwd=str(SCANNER_BOT_DIR),
            env=subprocess_env,
        )
        job["process"] = proc

        # Thread pour capturer les logs
        def _capture_logs(proc, job_id):
            job = _scanner_jobs.get(job_id)
            if not job:
                return
            try:
                for line in proc.stdout:
                    stripped = line.rstrip()
                    if stripped:
                        job["logs"].append(stripped)
                        # Garder les 500 dernières lignes
                        if len(job["logs"]) > 500:
                            job["logs"] = job["logs"][-500:]
                        # Parser la progression
                        _parse_scanner_progress(job, stripped)
            except Exception:
                pass

            # Marquer comme terminé
            proc.wait()
            if proc.returncode == 0:
                job["status"] = "completed"
                # Vérifier que le fichier existe
                if not os.path.exists(job["output_path"]):
                    job["status"] = "completed"
                    job["output_path"] = None
            else:
                job["status"] = "error"
                job["logs"].append(f"❌ Process terminato con codice {proc.returncode}")

            job["process"] = None
            logger.info(f"[Scanner] Job {job_id} terminato: {job['status']}")

        t = threading.Thread(target=_capture_logs, args=(proc, job_id), daemon=True)
        t.start()

        return {"status": "running", "job_id": job_id}

    except Exception as e:
        job["status"] = "error"
        job["logs"].append(f"❌ Errore di avvio: {str(e)}")
        logger.error(f"[Scanner] Erreur lancement job {job_id}: {e}")
        raise HTTPException(500, f"Erreur au lancement: {e}")


def _parse_scanner_progress(job: dict, line: str):
    """Parse une ligne de log pour extraire les stats en temps réel."""
    # Bond trovati: "📊 EUR: 150 bond trovati sul mercato"
    match = re.search(r'(\d+) bond trovati sul mercato', line)
    if match:
        count = int(match.group(1))
        job["stats"]["total_scanned"] = job["stats"].get("total_scanned", 0) + count

    # Pre-filtro scartati: "📋 Pre-filtro: X candidati (scartati Y per ...)"
    match = re.search(r'Pre-filtro:.*scartati (\d+)', line)
    if match:
        count = int(match.group(1))
        job["stats"]["total_discarded"] = job["stats"].get("total_discarded", 0) + count

    # Bond accettato: "ACCETTATO"
    if "ACCETTATO" in line:
        job["stats"]["total_filtered"] = job["stats"].get("total_filtered", 0) + 1

    # Bond scartato: "❌ Scartato:"
    if "❌ Scartato:" in line:
        job["stats"]["total_discarded"] = job["stats"].get("total_discarded", 0) + 1

    # Errori: "❌ Errore:"
    if "❌ Errore:" in line and "Scartato" not in line:
        job["stats"]["total_errors"] = job["stats"].get("total_errors", 0) + 1

    # Progression: "[X/Y]"
    match = re.search(r'\[(\d+)/(\d+)\]', line)
    if match:
        job["_current"] = int(match.group(1))
        job["_total_candidates"] = int(match.group(2))

    # Valuta completata: "📊 EUR completato: X accettati"
    match = re.search(r'(\w+) completato: (\d+) accettati', line)
    if match:
        currency = match.group(1)
        accepted = int(match.group(2))
        job["_completed_currencies"] = job.get("_completed_currencies", [])
        job["_completed_currencies"].append(currency)

    # Résumé final: écraser avec les chiffres exacts
    if "RIEPILOGO SCANSIONE" in line:
        job["_in_summary"] = True

    if job.get("_in_summary"):
        match = re.search(r'Bond scansionati:\s*(\d+)', line)
        if match:
            job["stats"]["total_scanned"] = int(match.group(1))

        match = re.search(r'Bond accettati:\s*(\d+)', line)
        if match:
            job["stats"]["total_filtered"] = int(match.group(1))

        match = re.search(r'Bond scartati:\s*(\d+)', line)
        if match:
            job["stats"]["total_discarded"] = int(match.group(1))

        match = re.search(r'Errori:\s*(\d+)', line)
        if match:
            job["stats"]["total_errors"] = int(match.group(1))


# ================================================================
#  STATUS
# ================================================================

@router.get("/status/{job_id}")
async def get_scanner_status(
    job_id: str,
    current_user: User = Depends(require_role("admin", "money")),
):
    """État de la scansione + logs en temps réel."""
    if job_id not in _scanner_jobs:
        raise HTTPException(404, "Job non trovato")

    job = _scanner_jobs[job_id]

    # Progression
    current = job.get("_current", 0)
    total_candidates = job.get("_total_candidates", 0)
    completed_currencies = job.get("_completed_currencies", [])

    # Estimer la progression globale
    currencies = job.get("criteria", {}).get("currencies", "EUR,USD,GBP").split(",")
    total_currencies = len(currencies)
    completed_count = len(completed_currencies)

    if total_currencies > 0:
        if job["status"] == "completed" or job["status"] == "error":
            progress_percent = 100
        elif completed_count > 0:
            # Progression basée sur les valutes terminées + progression dans la valute courante
            base_progress = (completed_count / total_currencies) * 100
            if total_candidates > 0:
                current_progress = (current / total_candidates) * (100 / total_currencies)
            else:
                current_progress = 0
            progress_percent = min(99, int(base_progress + current_progress))
        else:
            # Première valute en cours
            if total_candidates > 0:
                progress_percent = min(30, int((current / total_candidates) * 33))
            else:
                progress_percent = 5  # En attente de résultats
    else:
        progress_percent = 0

    return {
        "status": job["status"],
        "progress_percent": progress_percent,
        "stats": job["stats"],
        "logs": job["logs"][-100:],
        "logs_count": len(job["logs"]),
        "result_file": os.path.basename(job["output_path"]) if job.get("output_path") and os.path.exists(job.get("output_path", "")) else None,
        "criteria": job.get("criteria"),
        "completed_currencies": completed_currencies,
    }


# ================================================================
#  DOWNLOAD
# ================================================================

@router.get("/download/{job_id}")
async def download_scanner_result(
    job_id: str,
    current_user: User = Depends(require_role("admin", "money")),
):
    """Télécharge le fichier Excel résultat."""
    output_path = None

    # 1. Chercher dans les jobs en mémoire
    if job_id in _scanner_jobs:
        job = _scanner_jobs[job_id]
        if job["status"] != "completed":
            raise HTTPException(400, "La scansione non è ancora terminata")
        output_path = job.get("output_path")

    # 2. Fallback : chercher le fichier sur le disque
    #    (utile après un redémarrage de uvicorn où les jobs mémoire sont perdus)
    if not output_path or not os.path.exists(output_path):
        job_dir = OUTPUTS_DIR / job_id
        if job_dir.is_dir():
            xlsx_files = list(job_dir.glob("*.xlsx"))
            if xlsx_files:
                output_path = str(xlsx_files[0])

    if not output_path or not os.path.exists(output_path):
        raise HTTPException(404, "File risultato non trovato")

    download_name = os.path.basename(output_path)

    return FileResponse(
        path=output_path,
        filename=download_name,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": f'attachment; filename="{download_name}"'},
    )


@router.get("/download-file/{job_id}/{filename}")
async def download_scanner_file(
    job_id: str,
    filename: str,
    token: str = "",
):
    """Téléchargement avec token dans l'URL."""
    from backend.auth.utils import decode_token as _decode_token

    if not token:
        raise HTTPException(401, "Token manquant")

    payload = _decode_token(token)
    if not payload or not payload.get("sub"):
        raise HTTPException(401, "Token invalide")

    output_path = None

    # 1. Chercher dans les jobs en mémoire
    if job_id in _scanner_jobs:
        job = _scanner_jobs[job_id]
        if job["status"] != "completed":
            raise HTTPException(400, "La scansione non è ancora terminata")
        output_path = job.get("output_path")

    # 2. Fallback : chercher sur le disque
    if not output_path or not os.path.exists(output_path):
        job_dir = OUTPUTS_DIR / job_id
        if job_dir.is_dir():
            xlsx_files = list(job_dir.glob("*.xlsx"))
            if xlsx_files:
                output_path = str(xlsx_files[0])

    if not output_path or not os.path.exists(output_path):
        raise HTTPException(404, "File risultato non trovato")

    download_name = os.path.basename(output_path)

    return FileResponse(
        path=output_path,
        filename=download_name,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": f'attachment; filename="{download_name}"'},
    )


# ================================================================
#  STOP
# ================================================================

@router.post("/stop/{job_id}")
async def stop_scanner(
    job_id: str,
    current_user: User = Depends(require_role("admin", "money")),
):
    """Arrête un scan en cours."""
    if job_id not in _scanner_jobs:
        raise HTTPException(404, "Job non trovato")

    job = _scanner_jobs[job_id]

    if job["status"] != "running":
        raise HTTPException(400, "La scansione non è in esecuzione")

    proc = job.get("process")
    if proc and proc.poll() is None:
        proc.terminate()
        logger.info(f"[Scanner] Job {job_id} arrêté")

    job["status"] = "stopped"
    job["process"] = None
    job["logs"].append("⏹ Scansione interrotta dall'utente")

    return {"status": "stopped", "job_id": job_id}


# ================================================================
#  USAGE (RATE LIMIT)
# ================================================================

@router.get("/usage")
async def get_scanner_usage(
    current_user: User = Depends(require_role("admin", "money")),
):
    """Vérifie le rate limit du scanner."""
    try:
        import sys as _sys
        _sys.path.insert(0, str(SCANNER_BOT_DIR))
        from bot.rate_limiter import get_usage_data
        usage = get_usage_data()
        _sys.path.remove(str(SCANNER_BOT_DIR))
        return usage
    except Exception as e:
        logger.warning(f"[Scanner] Erreur lecture usage: {e}")
        return {
            "today_scans": 0,
            "max_scans": 2,
            "remaining": 2,
            "history": [],
        }


@router.post("/reset-usage")
async def reset_scanner_usage(
    current_user: User = Depends(require_role("admin")),
):
    """Reset del contatore rate limit (solo admin)."""
    import json as _json
    rate_file = SCANNER_BOT_DIR / "bot" / ".rate_limit.json"
    try:
        reset_data = {"date": "", "scans": 0, "history": []}
        with open(rate_file, 'w') as f:
            _json.dump(reset_data, f, indent=2)
        logger.info(f"[Scanner] Rate limit resettato da {current_user.username}")
        return {"status": "ok", "message": "Contatore resettato a 0"}
    except Exception as e:
        logger.error(f"[Scanner] Erreur reset usage: {e}")
        raise HTTPException(500, f"Errore reset: {e}")


# ================================================================
#  ACTIVE JOB (RECONNEXION)
# ================================================================

@router.get("/active")
async def get_active_scanner_job(
    current_user: User = Depends(require_role("admin", "money")),
):
    """Vérifie s'il y a un job actif pour la reconnexion."""
    # Trouver le job le plus récent
    if not _scanner_jobs:
        return {"found": False}

    # Chercher d'abord un job running
    for job_id, job in sorted(
        _scanner_jobs.items(),
        key=lambda x: x[1].get("created_at", ""),
        reverse=True,
    ):
        if job["status"] == "running":
            return {
                "found": True,
                "job_id": job_id,
                "status": "running",
                "criteria": job.get("criteria"),
            }

    # Sinon, le dernier job terminé
    for job_id, job in sorted(
        _scanner_jobs.items(),
        key=lambda x: x[1].get("created_at", ""),
        reverse=True,
    ):
        if job["status"] in ("completed", "error", "stopped"):
            return {
                "found": True,
                "job_id": job_id,
                "status": job["status"],
                "criteria": job.get("criteria"),
                "result_file": os.path.basename(job["output_path"]) if job.get("output_path") and os.path.exists(job.get("output_path", "")) else None,
                "stats": job.get("stats"),
            }

    return {"found": False}


# ================================================================
#  SETTINGS — Brave Search API key (Task 16, 2026-05-28)
# ================================================================
#
# Le Bond Scanner et le Yield Bot partagent le MÊME fichier secret
# `data/secrets/brave.key` (lu par les 2 backends, écrit indifféremment
# par les 2 admin UIs). C'est un patron "1 secret partagé" : poser la
# clé via le panneau d'un bot l'active aussi pour l'autre.
#
# Sécurité :
# - Endpoint admin only (require_role("admin")) — pas "money"
# - La clé n'est JAMAIS retournée en clair (masquée via _mask_key)
# - Le fichier est chmod 600 (root + propriétaire seulement)
# - data/secrets/ est dans .gitignore


class RatingKeyPayload(BaseModel):
    key: str


@router.get("/settings/rating-key")
async def get_scanner_rating_key_status(
    current_user: User = Depends(require_role("admin")),
):
    """État de la clé Brave (sans la révéler). Source = env_var > file > none."""
    env_key = os.environ.get("BRAVE_SEARCH_API_KEY")
    if env_key:
        return {
            "has_key": True,
            "preview": _mask_key(env_key),
            "source": "env_var",
            "path": None,
            "shared_with": "yield-bot",
        }
    if RATING_KEY_PATH.is_file():
        try:
            content = RATING_KEY_PATH.read_text(encoding="utf-8").strip()
            if content:
                return {
                    "has_key": True,
                    "preview": _mask_key(content),
                    "source": "file",
                    "path": str(RATING_KEY_PATH),
                    "shared_with": "yield-bot",
                }
        except Exception as e:
            logger.warning(f"Can't read rating key file: {e!r}")

    return {
        "has_key": False,
        "preview": None,
        "source": None,
        "path": str(RATING_KEY_PATH),
        "shared_with": "yield-bot",
    }


@router.post("/settings/rating-key")
async def set_scanner_rating_key(
    payload: RatingKeyPayload,
    current_user: User = Depends(require_role("admin")),
):
    """
    Pose ou remplace la clé Brave Search API.

    Le fichier est partagé avec le Yield Bot — modifier la clé ici la
    change aussi pour le Yield Bot (et inversement). Validation : la clé
    doit commencer par 'BSA' et faire au moins 20 caractères.
    """
    key = (payload.key or "").strip()
    if not key:
        raise HTTPException(400, "La clé est vide")
    if not key.startswith("BSA"):
        raise HTTPException(
            400,
            "Format inattendu : une clé Brave Search commence par 'BSA'. "
            "Vérifie que tu as bien copié la clé complète depuis "
            "api-dashboard.search.brave.com/app/keys"
        )
    if len(key) < 20:
        raise HTTPException(400, "Clé trop courte (< 20 caractères)")

    try:
        RATING_KEY_PATH.parent.mkdir(parents=True, exist_ok=True)
        RATING_KEY_PATH.write_text(key, encoding="utf-8")
        RATING_KEY_PATH.chmod(0o600)
    except Exception as e:
        logger.exception("Failed to write rating key")
        raise HTTPException(500, f"Impossible d'écrire le fichier : {e!r}")

    logger.info(
        f"Rating key posée par {current_user.username} via Bond Scanner "
        f"(preview {_mask_key(key)})"
    )
    return {
        "message": "Clé enregistrée. Prochain scan l'utilisera (partagée avec Yield Bot).",
        "preview": _mask_key(key),
        "path": str(RATING_KEY_PATH),
        "shared_with": "yield-bot",
    }


@router.delete("/settings/rating-key")
async def delete_scanner_rating_key(
    current_user: User = Depends(require_role("admin")),
):
    """Supprime la clé Brave (rating fetcher désactivé pour les 2 bots)."""
    if not RATING_KEY_PATH.is_file():
        return {"message": "Aucune clé à supprimer (fichier absent)"}
    try:
        RATING_KEY_PATH.unlink()
    except Exception as e:
        logger.exception("Failed to delete rating key")
        raise HTTPException(500, f"Impossible de supprimer : {e!r}")
    logger.info(
        f"Rating key supprimée par {current_user.username} via Bond Scanner "
        f"(impacte aussi Yield Bot)"
    )
    return {"message": "Clé supprimée (impact: les 2 bots ne pourront plus récupérer le rating Fitch)"}


# ================================================================
#  DEDUP — Historique des bonds déjà livrés (2026-05-28)
# ================================================================
#
# La dédup persistante du Bond Scanner stocke les ISINs déjà livrés dans
# ~/.cache/bond-scanner-found-isins.json (écrit par le subprocess bot).
# Le backend lit/supprime ce fichier directement (même user → même path)
# sans importer le package bond-scanner.

FOUND_STORE_PATH = Path.home() / ".cache" / "bond-scanner-found-isins.json"


@router.get("/found-count")
async def get_found_count(
    current_user: User = Depends(require_role("admin", "money")),
):
    """Nombre de bonds dans l'historique dédup (déjà livrés)."""
    if not FOUND_STORE_PATH.is_file():
        return {"count": 0}
    try:
        data = json.loads(FOUND_STORE_PATH.read_text())
        return {"count": len(data) if isinstance(data, dict) else 0}
    except Exception:
        return {"count": 0}


@router.post("/reset-found")
async def reset_found(
    current_user: User = Depends(require_role("admin")),
):
    """Vide l'historique dédup : les bonds déjà livrés redeviennent cherchables."""
    if not FOUND_STORE_PATH.is_file():
        return {"message": "Aucun historique à vider", "cleared": 0}
    try:
        data = json.loads(FOUND_STORE_PATH.read_text())
        n = len(data) if isinstance(data, dict) else 0
    except Exception:
        n = 0
    try:
        FOUND_STORE_PATH.unlink()
    except OSError as e:
        raise HTTPException(500, f"Impossible de vider l'historique : {e!r}")
    logger.info(f"Historique dédup vidé par {current_user.username} ({n} bond)")
    return {"message": f"{n} bond effacés de l'historique — ils redeviennent cherchables", "cleared": n}
