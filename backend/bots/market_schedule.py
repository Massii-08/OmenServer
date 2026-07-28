"""Planification du rapport matinal Market Pulse.

Décisions PURES (horloge injectée) + branchement APScheduler. Deux pièges de
cette machine dictent la conception :

1. **L'Omen dort de 01:00 à 06:00 puis redémarre.** Un déclenchement peut
   tomber pendant la veille ou pendant le boot. Or le `BackgroundScheduler()`
   du dépôt n'a AUCUN jobstore persistant : au redémarrage il ne sait rien des
   déclenchements manqués, donc `misfire_grace_time` et `coalesce` ne
   rattrapent RIEN dans ce cas — ils ne couvrent qu'un retard du process
   vivant. Le vrai rattrapage est `should_catch_up()`, appelé au démarrage du
   backend et arbitré par la date du dernier run.
2. **Le scheduler n'a pas de fuseau configuré** : sans `timezone=` explicite
   sur le trigger, un « 07:30 » partirait à l'heure système de la machine.
"""
import json
import os
from datetime import date, datetime
from pathlib import Path
from typing import Any, Dict, Optional, Tuple

from zoneinfo import ZoneInfo

JOB_ID = "market_pulse_morning"

# Emplacement par défaut de la config. Lu DYNAMIQUEMENT par le router
# (`market_schedule.DEFAULT_PATH`) pour rester substituable en test.
DEFAULT_PATH = str(Path(__file__).resolve().parent.parent.parent
                   / "data" / "market_pulse" / "schedule.json")

# Au-delà, un instantané « d'ouverture » n'a plus de sens : on laisse le
# déclenchement du lendemain faire le travail plutôt que d'envoyer à 23 h un
# rapport intitulé « matin ».
MAX_CATCHUP_LATE_H = 6

DEFAULT_SCHEDULE = {
    "enabled": False,
    "time": "07:30",          # avant l'ouverture de Milan (09:00)
    "tz": "Europe/Rome",
    "days": "weekdays",       # les places sont fermées le week-end
}

_DAYS = {"daily": "*", "weekdays": "mon-fri"}


class ScheduleError(ValueError):
    """Configuration de planification invalide (remontée en HTTP 400)."""


# --------------------------------------------------------------------------
# Validation
# --------------------------------------------------------------------------

def parse_time(value: Any) -> Tuple[int, int]:
    """« 7:05 » → (7, 5). Tout le reste lève ScheduleError."""
    if not isinstance(value, str):
        raise ScheduleError("heure manquante ou invalide")
    parts = value.strip().split(":")
    if len(parts) != 2:
        raise ScheduleError("format d'heure attendu HH:MM : %r" % value)
    try:
        hour, minute = int(parts[0]), int(parts[1])
    except ValueError:
        raise ScheduleError("format d'heure attendu HH:MM : %r" % value)
    # int() accepte « +7 » et les espaces : on exige des chiffres purs, sinon
    # « -1:00 » passerait pour 23:00 après normalisation.
    if not parts[0].strip().isdigit() or not parts[1].strip().isdigit():
        raise ScheduleError("format d'heure attendu HH:MM : %r" % value)
    if not (0 <= hour <= 23) or not (0 <= minute <= 59):
        raise ScheduleError("heure hors bornes : %r" % value)
    return hour, minute


def day_of_week(days: str) -> str:
    try:
        return _DAYS[days]
    except KeyError:
        raise ScheduleError("jours inconnus : %r (attendu daily|weekdays)" % days)


def _tzinfo(name: Any) -> ZoneInfo:
    try:
        return ZoneInfo(str(name))
    except Exception:
        # ZoneInfoNotFoundError, mais aussi tout ce que remonte tzdata.
        raise ScheduleError("fuseau horaire inconnu : %r" % name)


def validate(cfg: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    """Normalise et valide. Lève ScheduleError si quoi que ce soit cloche."""
    cfg = dict(DEFAULT_SCHEDULE, **(cfg or {}))
    hour, minute = parse_time(cfg.get("time"))
    days = cfg.get("days")
    day_of_week(days)             # valide
    _tzinfo(cfg.get("tz"))        # valide
    return {
        "enabled": bool(cfg.get("enabled")),
        "time": "%02d:%02d" % (hour, minute),
        "tz": str(cfg.get("tz")),
        "days": days,
    }


def public_view(cfg: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """Vue rendue par l'API (rien de secret ici, mais forme stable)."""
    try:
        clean = validate(cfg)
    except ScheduleError:
        clean = dict(DEFAULT_SCHEDULE)
    out = dict(clean)
    out["next_days"] = _DAYS[clean["days"]]
    return out


# --------------------------------------------------------------------------
# Persistance
# --------------------------------------------------------------------------

def load(path: Optional[str] = None) -> Dict[str, Any]:
    """Config sur disque, ou les défauts. Ne lève JAMAIS : un fichier corrompu
    ne doit pas empêcher le backend de démarrer."""
    path = path or DEFAULT_PATH
    try:
        with open(path, "r", encoding="utf-8") as f:
            raw = json.load(f)
    except (OSError, ValueError):
        return dict(DEFAULT_SCHEDULE)
    try:
        return validate(raw)
    except ScheduleError:
        return dict(DEFAULT_SCHEDULE)


def save(cfg: Dict[str, Any], path: Optional[str] = None) -> Dict[str, Any]:
    """Valide PUIS écrit (une config invalide ne doit jamais atterrir sur le
    disque : elle serait rechargée à chaque boot)."""
    clean = validate(cfg)
    path = path or DEFAULT_PATH
    parent = os.path.dirname(path)
    if parent:
        os.makedirs(parent, exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(clean, f, indent=1, ensure_ascii=False)
    return clean


# --------------------------------------------------------------------------
# Rattrapage — le cœur de la fiabilité quotidienne
# --------------------------------------------------------------------------

def _as_day(value: Any) -> Optional[str]:
    if value is None:
        return None
    if isinstance(value, datetime):
        return value.date().isoformat()
    if isinstance(value, date):
        return value.isoformat()
    return str(value).strip() or None


def should_catch_up(cfg: Optional[Dict[str, Any]], last_run: Any,
                    now: datetime, max_late_h: float = MAX_CATCHUP_LATE_H) -> bool:
    """Faut-il lancer le rapport MAINTENANT parce que l'heure prévue est passée
    sans qu'il ait tourné ?

    Appelé au démarrage du backend : c'est ce qui rattrape le matin où la
    machine dormait encore, ou bootait, à l'heure du déclenchement.
    """
    try:
        clean = validate(cfg)
    except ScheduleError:
        return False
    if not clean["enabled"]:
        return False

    tz = _tzinfo(clean["tz"])
    # Un `now` naïf est lu dans le fuseau de la config (c'est l'intention de
    # l'appelant) ; un `now` conscient est CONVERTI — sinon un backend réglé
    # sur UTC comparerait 05:45 à un seuil pensé pour Rome.
    local = now.replace(tzinfo=tz) if now.tzinfo is None else now.astimezone(tz)

    if clean["days"] == "weekdays" and local.weekday() >= 5:
        return False

    hour, minute = parse_time(clean["time"])
    scheduled = local.replace(hour=hour, minute=minute, second=0, microsecond=0)
    if local < scheduled:
        return False
    if (local - scheduled).total_seconds() > max_late_h * 3600.0:
        return False

    return _as_day(last_run) != local.date().isoformat()


# --------------------------------------------------------------------------
# Branchement APScheduler
# --------------------------------------------------------------------------

def register_job(scheduler, run_fn, cfg: Optional[Dict[str, Any]] = None):
    """(Ré)installe le job quotidien. Retourne l'id du job, ou None si désactivé."""
    from apscheduler.triggers.cron import CronTrigger

    clean = validate(cfg)
    try:
        scheduler.remove_job(JOB_ID)
    except Exception:
        pass  # JobLookupError au premier passage : normal.
    if not clean["enabled"]:
        return None

    hour, minute = parse_time(clean["time"])
    scheduler.add_job(
        run_fn,
        trigger=CronTrigger(hour=hour, minute=minute,
                            day_of_week=_DAYS[clean["days"]],
                            timezone=_tzinfo(clean["tz"])),
        id=JOB_ID,
        name="Market Pulse — rapport %s (%s)" % (clean["time"], clean["tz"]),
        replace_existing=True,
        # Un déclenchement en retard (boot en cours, machine chargée) doit
        # quand même partir : la grâce par défaut d'APScheduler est de 1 s.
        misfire_grace_time=3600,
        coalesce=True,
        max_instances=1,
    )
    return JOB_ID
