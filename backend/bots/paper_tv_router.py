"""Routes de l'extension TradingView « coach » — préfixe ``/api/paper``.

Spec : ``docs/superpowers/specs/2026-09-09-tv-coach-extension-design.md``.
Plan : ``docs/superpowers/plans/2026-09-09-tv-coach-extension.md``.

Chaque lot ajoute ses routes SOUS SON ANCRE et n'y touche pas ailleurs ; les
helpers communs s'importent depuis ``backend.bots.paper_router``
(``_job_or_sync``, ``_load``, ``_now_iso``, ``_append_journal``).
"""

from fastapi import APIRouter

router = APIRouter(prefix="/api/paper", tags=["paper-tv"])

# --- LOT A/B : brief, precheck, alerts/{id}/fire (brief.py, precheck.py) ---

# --- LOT C : focus, tvcalendar (focus.py, tvnews.py, tvcalendar.py) ---

# --- LOT D : scalps (scalps.py) ---

# --- LOT E : btc (btc.py) ---
