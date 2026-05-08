"""
Routes Yield Bot — Upload, exécution et suivi du bot calcul yield.

Ce router gère le bot spécialisé "Calcul Yield" qui :
1. Prend un fichier Excel d'obligations (.xlsx)
2. Scrape les prix depuis Deutsche Börse (mode --all)
3. Calcule le yield avec formule 30/360
4. Génère un fichier _AGGIORNATO.xlsx avec les données mises à jour

Routes:
    POST   /api/bots/yield/upload         → Upload d'un fichier Excel
    POST   /api/bots/yield/run/{job_id}   → Lancer le bot sur le fichier
    GET    /api/bots/yield/status/{job_id} → État + logs temps réel
    GET    /api/bots/yield/download/{job_id} → Télécharger le résultat
    GET    /api/bots/yield/usage           → Vérifier le rate limit
"""

import json
import logging
import os
import re
import shutil
import subprocess
import sys
import threading
import uuid
from datetime import datetime
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, UploadFile, File
from fastapi.responses import FileResponse
from pydantic import BaseModel

from backend.auth.utils import get_current_user
from backend.auth.models import User

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/bots/yield", tags=["Yield Bot"])

# Dossier du bot yield (configurable via .env)
_home = Path.home()
YIELD_BOT_DIR = Path(os.environ.get(
    "YIELD_BOT_DIR",
    str(_home / "omenserver" / "bots" / "yield-bot")
))
UPLOADS_DIR = YIELD_BOT_DIR / "uploads"

# Stockage des jobs en mémoire
_yield_jobs: dict[str, dict] = {}


class YieldRunRequest(BaseModel):
    mode: str = "all"  # "all" ou "recalculate"
    sheet: Optional[str] = None
    isin: Optional[str] = None


# ================================================================
#  UPLOAD
# ================================================================

@router.post("/upload")
async def upload_yield_file(
    file: UploadFile = File(...),
    current_user: User = Depends(get_current_user),
):
    """Upload d'un fichier Excel pour le bot yield."""
    # Vérifier l'extension
    if not file.filename or not file.filename.endswith('.xlsx'):
        raise HTTPException(400, "Seuls les fichiers .xlsx sont acceptés")

    # Générer un job_id
    job_id = str(uuid.uuid4())[:8]

    # Créer le dossier du job
    job_dir = UPLOADS_DIR / job_id
    job_dir.mkdir(parents=True, exist_ok=True)

    # Sauvegarder le fichier
    file_path = job_dir / file.filename
    content = await file.read()
    file_path.write_bytes(content)

    logger.info(f"[Yield] Fichier uploadé: {file.filename} → {file_path}")

    # Analyser le fichier pour le summary
    bonds_count = 0
    summary = ""
    sheets_info = {}

    try:
        import sys
        sys.path.insert(0, str(YIELD_BOT_DIR))
        from excel.processor import BondExcelProcessor

        processor = BondExcelProcessor(str(file_path))
        all_bonds = processor.get_all_bonds()
        bonds_count = len(all_bonds)

        # Compter par feuille
        for bond in all_bonds:
            sheet_name = bond['sheet']
            sheets_info[sheet_name] = sheets_info.get(sheet_name, 0) + 1

        summary = ", ".join(f"{k}: {v}" for k, v in sheets_info.items())

        # Nettoyer le path d'import
        sys.path.remove(str(YIELD_BOT_DIR))
    except Exception as e:
        logger.warning(f"[Yield] Impossible d'analyser le fichier: {e}")
        summary = "Analyse non disponible"

    # Stocker le job
    _yield_jobs[job_id] = {
        "status": "pending",
        "filename": file.filename,
        "input_path": str(file_path),
        "output_path": None,
        "logs": [],
        "process": None,
        "bonds_count": bonds_count,
        "sheets": list(sheets_info.keys()),
        "mode": None,
        "stats": {"total": bonds_count, "updated": 0, "skipped": 0, "errors": 0},
        "created_at": datetime.utcnow().isoformat(),
    }

    return {
        "job_id": job_id,
        "filename": file.filename,
        "bonds_count": bonds_count,
        "sheets": list(sheets_info.keys()),
        "summary": summary,
    }


# ================================================================
#  RUN
# ================================================================

@router.post("/run/{job_id}")
async def run_yield_bot(
    job_id: str,
    data: YieldRunRequest,
    current_user: User = Depends(get_current_user),
):
    """Lance le bot yield sur un fichier uploadé."""
    if job_id not in _yield_jobs:
        raise HTTPException(404, "Job non trouvé")

    job = _yield_jobs[job_id]

    if job["status"] == "running":
        raise HTTPException(400, "Le bot est déjà en cours d'exécution")

    input_path = job["input_path"]
    if not os.path.exists(input_path):
        raise HTTPException(404, "Fichier uploadé introuvable")

    # Vérifier le mode
    if data.mode not in ("all", "recalculate"):
        raise HTTPException(400, "Mode invalide. Utiliser 'all' ou 'recalculate'")

    # Construire la commande
    cmd = [sys.executable, "main.py", f"--{data.mode}", "--file", input_path]

    if data.sheet:
        # Override: utiliser --sheet au lieu de --all/--recalculate
        cmd = [sys.executable, "main.py", "--sheet", data.sheet, "--file", input_path]

    if data.isin:
        cmd = [sys.executable, "main.py", "--isin", data.isin, "--file", input_path]

    logger.info(f"[Yield] Lancement: {' '.join(cmd)}")

    # Reset le job
    job["status"] = "running"
    job["mode"] = data.mode
    job["logs"] = []
    job["stats"] = {"total": job["bonds_count"], "updated": 0, "skipped": 0, "errors": 0}

    try:
        proc = subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            bufsize=1,
            cwd=str(YIELD_BOT_DIR),
            env={**os.environ, "PYTHONUNBUFFERED": "1"},
        )
        job["process"] = proc

        # Thread pour capturer les logs
        def _capture_logs(proc, job_id):
            job = _yield_jobs.get(job_id)
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
                        _parse_progress(job, stripped)
            except Exception:
                pass

            # Marquer comme terminé
            proc.wait()
            if proc.returncode == 0:
                job["status"] = "completed"
                # Trouver le fichier de sortie
                base = os.path.splitext(job["input_path"])[0]
                output_path = f"{base}_AGGIORNATO.xlsx"
                if os.path.exists(output_path):
                    job["output_path"] = output_path
            else:
                job["status"] = "error"
                job["logs"].append(f"❌ Process terminé avec code {proc.returncode}")

            job["process"] = None
            logger.info(f"[Yield] Job {job_id} terminé: {job['status']}")

        t = threading.Thread(target=_capture_logs, args=(proc, job_id), daemon=True)
        t.start()

        return {"status": "running", "job_id": job_id}

    except Exception as e:
        job["status"] = "error"
        job["logs"].append(f"❌ Erreur de lancement: {str(e)}")
        logger.error(f"[Yield] Erreur lancement job {job_id}: {e}")
        raise HTTPException(500, f"Erreur au lancement: {e}")


def _parse_progress(job: dict, line: str):
    """
    Parse une ligne de log pour extraire la progression et les stats en temps réel.
    
    Format des logs du bot:
      Mode all:    "📌 [Sheet:row] Bond Name"
      Mode recalc: "  [Sheet:row] Bond Name"
      Yield OK:    "   📈 Yield calcolato: ..."  ou  "    Yield: old → new"
      Skip:        "   ⚠️ Nessun prezzo" / "⚠️ Dati insufficienti" / "⚠️ Prezzo non numerico"
      Error:       "   ❌ Errore: ..."  ou  "⚠️ Errore: ..."
      Summary:     "  ✅ Aggiornate:       X"
    """
    # Détecter une nouvelle obligation traitée: "[SheetName:row]"
    # Le nom de feuille peut contenir espaces, accents, tirets, etc.
    if re.search(r'\[.+?:\d+\]', line):
        job["_processed"] = job.get("_processed", 0) + 1

    # Incrémenter les stats en temps réel
    if "Yield calcolato:" in line or ("Yield:" in line and "→" in line):
        job["stats"]["updated"] = job["stats"].get("updated", 0) + 1
    elif "Zero-coupon: Yield=" in line or "Yield zero-coupon:" in line:
        job["stats"]["updated"] = job["stats"].get("updated", 0) + 1
    elif "Perpetua: Yield=" in line or "Yield perpetuo:" in line:
        job["stats"]["updated"] = job["stats"].get("updated", 0) + 1

    # Détecter les skips (⚠️ sans "Errore")
    if ("⚠️ Nessun prezzo" in line
            or "⚠️ Dati insufficienti" in line
            or "⚠️ Prezzo non numerico" in line
            or "⚠️ Scraping fallito" in line):
        job["stats"]["skipped"] = job["stats"].get("skipped", 0) + 1

    # Détecter les erreurs
    if "❌ Errore:" in line or "⚠️ Errore:" in line or "⚠️  Errore:" in line:
        job["stats"]["errors"] = job["stats"].get("errors", 0) + 1

    # Détecter le résumé final — écraser avec les chiffres exacts
    if "RIEPILOGO" in line:
        job["_in_summary"] = True

    if job.get("_in_summary"):
        match = re.search(r'Aggiornate:\s*(\d+)', line)
        if match:
            job["stats"]["updated"] = int(match.group(1))

        match = re.search(r'Saltate:\s*(\d+)', line)
        if match:
            job["stats"]["skipped"] = int(match.group(1))

        match = re.search(r'Errori:\s*(\d+)', line)
        if match:
            job["stats"]["errors"] = int(match.group(1))


# ================================================================
#  STATUS
# ================================================================

@router.get("/status/{job_id}")
async def get_yield_status(
    job_id: str,
    current_user: User = Depends(get_current_user),
):
    """État de l'exécution + logs en temps réel."""
    if job_id not in _yield_jobs:
        raise HTTPException(404, "Job non trouvé")

    job = _yield_jobs[job_id]

    # Progression: utiliser le compteur live au lieu de re-scanner
    processed = job.get("_processed", 0)
    total = job["bonds_count"] or 1
    progress = f"{processed}/{total}"

    # Vérifier si le process est encore vivant
    if job["process"] is not None and job["process"].poll() is not None:
        # Le process est terminé mais le thread n'a pas encore mis à jour
        pass

    return {
        "status": job["status"],
        "progress": progress,
        "progress_percent": min(100, int(processed / total * 100)) if total > 0 else 0,
        "logs": job["logs"][-100:],  # Dernières 100 lignes
        "logs_count": len(job["logs"]),
        "result_file": os.path.basename(job["output_path"]) if job.get("output_path") else None,
        "filename": job["filename"],
        "mode": job.get("mode"),
        "stats": job["stats"],
    }


# ================================================================
#  DOWNLOAD
# ================================================================

@router.get("/download/{job_id}")
async def download_yield_result(
    job_id: str,
    token: Optional[str] = None,
    current_user: User = Depends(get_current_user),
):
    """Télécharge le fichier résultat _AGGIORNATO.xlsx."""
    if job_id not in _yield_jobs:
        raise HTTPException(404, "Job non trouvé")

    job = _yield_jobs[job_id]

    if job["status"] != "completed":
        raise HTTPException(400, "Le job n'est pas encore terminé")

    output_path = job.get("output_path")
    if not output_path or not os.path.exists(output_path):
        raise HTTPException(404, "Fichier résultat introuvable")

    # Nom du fichier pour le téléchargement
    download_name = os.path.basename(output_path)

    return FileResponse(
        path=output_path,
        filename=download_name,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    )


@router.get("/download-direct/{job_id}")
async def download_yield_direct(
    job_id: str,
    token: str = "",
):
    """
    Téléchargement direct — le token JWT est passé en query param.
    Permet au navigateur de télécharger le fichier via window.open()
    avec le bon nom (Content-Disposition) sans passer par un blob URL.
    """
    from backend.auth.utils import decode_token as _decode_token
    from backend.database import SessionLocal

    if not token:
        raise HTTPException(401, "Token manquant")

    payload = _decode_token(token)
    if not payload or not payload.get("sub"):
        raise HTTPException(401, "Token invalide")

    if job_id not in _yield_jobs:
        raise HTTPException(404, "Job non trouvé")

    job = _yield_jobs[job_id]

    if job["status"] != "completed":
        raise HTTPException(400, "Le job n'est pas encore terminé")

    output_path = job.get("output_path")
    if not output_path or not os.path.exists(output_path):
        raise HTTPException(404, "Fichier résultat introuvable")

    download_name = os.path.basename(output_path)

    return FileResponse(
        path=output_path,
        filename=download_name,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": f'attachment; filename="{download_name}"'},
    )


@router.get("/download-file/{job_id}/{filename}")
async def download_yield_file(
    job_id: str,
    filename: str,
    token: str = "",
):
    """
    Téléchargement avec nom de fichier dans l'URL.
    Le navigateur utilise le dernier segment de l'URL comme nom de fichier,
    donc cette route garantit le bon nom même avec window.open().
    """
    from backend.auth.utils import decode_token as _decode_token

    if not token:
        raise HTTPException(401, "Token manquant")

    payload = _decode_token(token)
    if not payload or not payload.get("sub"):
        raise HTTPException(401, "Token invalide")

    if job_id not in _yield_jobs:
        raise HTTPException(404, "Job non trouvé")

    job = _yield_jobs[job_id]

    if job["status"] != "completed":
        raise HTTPException(400, "Le job n'est pas encore terminé")

    output_path = job.get("output_path")
    if not output_path or not os.path.exists(output_path):
        raise HTTPException(404, "Fichier résultat introuvable")

    download_name = os.path.basename(output_path)

    return FileResponse(
        path=output_path,
        filename=download_name,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": f'attachment; filename="{download_name}"'},
    )


# ================================================================
#  USAGE / RATE LIMIT
# ================================================================

@router.get("/usage")
async def get_yield_usage(
    current_user: User = Depends(get_current_user),
):
    """Vérifie le rate limit quotidien du scraping."""
    rate_file = YIELD_BOT_DIR / "bot" / ".rate_limit.json"

    from datetime import date
    today = date.today().isoformat()

    try:
        if rate_file.exists():
            data = json.loads(rate_file.read_text())
            if data.get("date") == today:
                runs = data.get("runs", 0)
                history = data.get("history", [])
                return {
                    "today_runs": runs,
                    "max_runs": 5,
                    "remaining": max(0, 5 - runs),
                    "history": history,
                }
    except Exception as e:
        logger.warning(f"[Yield] Erreur lecture rate limit: {e}")

    return {
        "today_runs": 0,
        "max_runs": 5,
        "remaining": 5,
        "history": [],
    }


# ================================================================
#  STOP
# ================================================================

@router.post("/stop/{job_id}")
async def stop_yield_bot(
    job_id: str,
    current_user: User = Depends(get_current_user),
):
    """Arrête le bot yield en cours d'exécution."""
    if job_id not in _yield_jobs:
        raise HTTPException(404, "Job non trouvé")

    job = _yield_jobs[job_id]

    if job["status"] != "running" or job["process"] is None:
        raise HTTPException(400, "Aucun process en cours")

    try:
        job["process"].terminate()
        try:
            job["process"].wait(timeout=5)
        except subprocess.TimeoutExpired:
            job["process"].kill()

        job["status"] = "stopped"
        job["process"] = None
        job["logs"].append("⏹ Bot arrêté par l'utilisateur")

        return {"message": "Bot arrêté"}
    except Exception as e:
        raise HTTPException(500, f"Erreur à l'arrêt: {e}")


# ================================================================
#  CLEANUP
# ================================================================

@router.delete("/job/{job_id}")
async def cleanup_yield_job(
    job_id: str,
    current_user: User = Depends(get_current_user),
):
    """Supprime un job et ses fichiers."""
    if job_id not in _yield_jobs:
        raise HTTPException(404, "Job non trouvé")

    job = _yield_jobs[job_id]

    # Arrêter le process si en cours
    if job.get("process") and job["process"].poll() is None:
        job["process"].terminate()

    # Supprimer le dossier du job
    job_dir = UPLOADS_DIR / job_id
    if job_dir.exists():
        shutil.rmtree(job_dir, ignore_errors=True)

    del _yield_jobs[job_id]

    return {"message": "Job supprimé"}
