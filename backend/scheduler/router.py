"""
Routes API pour les tâches planifiées.

Routes:
    GET    /api/scheduler/                     → Liste de toutes les tâches
    GET    /api/scheduler/server/{server_id}    → Tâches d'un serveur
    POST   /api/scheduler/                     → Créer une tâche
    PUT    /api/scheduler/{task_id}             → Modifier une tâche
    DELETE /api/scheduler/{task_id}             → Supprimer une tâche
    POST   /api/scheduler/{task_id}/toggle      → Activer/désactiver
"""

from datetime import datetime, timedelta

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel
from sqlalchemy.orm import Session
from typing import Optional

from backend.database import get_db
from backend.auth.utils import get_current_user
from backend.auth.models import User
from backend.game_server.models import GameServer
from backend.scheduler.models import ScheduledTask
from backend.scheduler import engine

router = APIRouter(prefix="/api/scheduler", tags=["Tâches planifiées"])


# --- Schémas ---

class CreateTaskRequest(BaseModel):
    """Données pour créer une tâche planifiée."""
    server_id: int
    task_type: str = "backup"        # "backup" ou "restart"
    interval_hours: int = 6          # Intervalle en heures


class UpdateTaskRequest(BaseModel):
    """Données pour modifier une tâche."""
    interval_hours: Optional[int] = None
    enabled: Optional[bool] = None


class TaskResponse(BaseModel):
    """Réponse avec les infos d'une tâche."""
    id: int
    server_id: int
    task_type: str
    interval_hours: int
    enabled: bool
    last_run: Optional[datetime]
    next_run: Optional[datetime]
    server_name: Optional[str] = None

    class Config:
        from_attributes = True


# --- Routes ---

@router.get("/")
def list_tasks(
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Liste toutes les tâches planifiées."""
    tasks = db.query(ScheduledTask).all()
    result = []
    for task in tasks:
        server = db.query(GameServer).filter(GameServer.id == task.server_id).first()
        result.append({
            "id": task.id,
            "server_id": task.server_id,
            "server_name": server.name if server else "Serveur supprimé",
            "task_type": task.task_type,
            "interval_hours": task.interval_hours,
            "enabled": task.enabled,
            "last_run": task.last_run.isoformat() if task.last_run else None,
            "next_run": task.next_run.isoformat() if task.next_run else None,
        })
    return result


@router.get("/server/{server_id}")
def list_server_tasks(
    server_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Liste les tâches d'un serveur spécifique."""
    tasks = db.query(ScheduledTask).filter(ScheduledTask.server_id == server_id).all()
    return [{
        "id": t.id,
        "server_id": t.server_id,
        "task_type": t.task_type,
        "interval_hours": t.interval_hours,
        "enabled": t.enabled,
        "last_run": t.last_run.isoformat() if t.last_run else None,
        "next_run": t.next_run.isoformat() if t.next_run else None,
    } for t in tasks]


@router.post("/", status_code=status.HTTP_201_CREATED)
def create_task(
    request: CreateTaskRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Crée une nouvelle tâche planifiée."""
    # Vérifier que le serveur existe
    server = db.query(GameServer).filter(GameServer.id == request.server_id).first()
    if not server:
        raise HTTPException(status_code=404, detail="Serveur non trouvé")

    # Validation
    if request.task_type not in ("backup", "restart"):
        raise HTTPException(status_code=400, detail="Type de tâche invalide (backup ou restart)")
    if request.interval_hours < 1 or request.interval_hours > 168:
        raise HTTPException(status_code=400, detail="Intervalle: entre 1h et 168h (7 jours)")

    # Vérifier qu'il n'existe pas déjà une tâche identique
    existing = db.query(ScheduledTask).filter(
        ScheduledTask.server_id == request.server_id,
        ScheduledTask.task_type == request.task_type,
    ).first()
    if existing:
        raise HTTPException(
            status_code=400,
            detail=f"Une tâche '{request.task_type}' existe déjà pour ce serveur"
        )

    task = ScheduledTask(
        server_id=request.server_id,
        task_type=request.task_type,
        interval_hours=request.interval_hours,
        enabled=True,
        next_run=datetime.utcnow() + timedelta(hours=request.interval_hours),
    )
    db.add(task)
    db.commit()
    db.refresh(task)

    # Ajouter au scheduler
    engine.add_task(task)

    return {
        "message": f"✅ Tâche '{task.task_type}' créée (toutes les {task.interval_hours}h)",
        "task": {
            "id": task.id,
            "server_id": task.server_id,
            "task_type": task.task_type,
            "interval_hours": task.interval_hours,
            "enabled": task.enabled,
        },
    }


@router.put("/{task_id}")
def update_task(
    task_id: int,
    request: UpdateTaskRequest,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Modifie une tâche planifiée."""
    task = db.query(ScheduledTask).filter(ScheduledTask.id == task_id).first()
    if not task:
        raise HTTPException(status_code=404, detail="Tâche non trouvée")

    if request.interval_hours is not None:
        if request.interval_hours < 1 or request.interval_hours > 168:
            raise HTTPException(status_code=400, detail="Intervalle: entre 1h et 168h")
        task.interval_hours = request.interval_hours
        task.next_run = datetime.utcnow() + timedelta(hours=request.interval_hours)

    if request.enabled is not None:
        task.enabled = request.enabled

    db.commit()

    # Mettre à jour dans le scheduler
    engine.update_task(task)

    return {"message": "✅ Tâche mise à jour", "enabled": task.enabled}


@router.delete("/{task_id}")
def delete_task(
    task_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Supprime une tâche planifiée."""
    task = db.query(ScheduledTask).filter(ScheduledTask.id == task_id).first()
    if not task:
        raise HTTPException(status_code=404, detail="Tâche non trouvée")

    engine.remove_task(task.id)

    db.delete(task)
    db.commit()
    return {"message": "✅ Tâche supprimée"}


@router.post("/{task_id}/toggle")
def toggle_task(
    task_id: int,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Active ou désactive une tâche."""
    task = db.query(ScheduledTask).filter(ScheduledTask.id == task_id).first()
    if not task:
        raise HTTPException(status_code=404, detail="Tâche non trouvée")

    task.enabled = not task.enabled
    if task.enabled:
        task.next_run = datetime.utcnow() + timedelta(hours=task.interval_hours)
    db.commit()

    engine.update_task(task)

    status_text = "activée ✅" if task.enabled else "désactivée ⏸️"
    return {"message": f"Tâche {status_text}", "enabled": task.enabled}
