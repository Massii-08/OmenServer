"""Sauvegarde nocturne des données du simulateur — un fichier par jour, pas
un flux qu'on pourrait oublier de regarder.

``data/paper_trading/`` porte tout ce que le simulateur sait : portefeuilles,
carnets Markdown, alertes de prix, mémoire du coach. Ce module en fait un
``tar.gz`` quotidien, rangé HORS de ce dossier (``data/backups/paper_trading/``)
pour ne jamais s'archiver lui-même.

Découpage PUR / I-O (même règle que le reste du lot) :
  - PUR : ``should_run`` / ``_local_day`` / ``_local_hour`` — zéro I/O, horloge
    passée en paramètre, 100 % testable hors ligne ;
  - I/O : ``run_backup`` (tarfile + rotation, chemins INJECTÉS — c'est
    l'appelant qui décide où lire et où écrire, jamais une constante figée
    ici) et ``maybe_run`` (le GATE appelé depuis le cycle du guetteur).

Écriture ATOMIQUE 0o600 pour l'état (``backup.state.json``) — même patron que
``store.py``/``calendar.py`` : le fichier temporaire NAÎT en 0o600 (``os.open``
+ ``os.fchmod`` best-effort), puis ``os.replace`` bascule d'un coup. L'archive
elle-même suit le même principe (``.tmp`` puis ``os.replace``) : un cycle
interrompu en cours d'écriture ne laisse jamais un ``.tar.gz`` à moitié écrit
sous son nom final.

⚠️ Le radical de l'état PORTE UN POINT (``backup.state.json``) — convention
anti-fantôme du dépôt (cf. tête de ``store.py`` / ``calendar.py``) : un
utilisateur ne peut pas s'appeler "backup" (le radical devrait être
"backup.state", qui contient un point, donc structurellement rejeté par
``store._sanitize_username``). Rangé DANS ``data/paper_trading/`` : c'est une
donnée du simulateur comme une autre, et il n'y a aucun mal à ce qu'elle soit
elle-même incluse dans l'archive qu'elle décrit.

Heure de référence : ``Europe/Rome``, même convention que
``market-pulse/pulse/excel_out.USER_TZ`` (l'heure de l'utilisateur, pas celle,
arbitraire, de l'horloge système du serveur).
"""
import json
import logging
import os
import tarfile
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Any, Callable, Dict, Optional
from zoneinfo import ZoneInfo

logger = logging.getLogger("omenserver")

# Même fuseau que market-pulse (pulse/excel_out.USER_TZ) : LA convention du
# dépôt pour "l'heure de l'utilisateur", pas celle du serveur.
LOCAL_TZ = "Europe/Rome"

STATE_NAME = "backup.state.json"

# Ne pas sauvegarder avant cette heure locale : la veille peut encore tourner
# (le guetteur, la convergence), pas la peine de lancer une sauvegarde en
# pleine nuit avant que la journée n'ait vraiment commencé.
RUN_AFTER_HOUR = 7

# Rotation : 14 jours d'historique — assez pour revenir en arrière sur un bug
# découvert tard, jamais un dossier qui grossit sans fin.
KEEP = 14

ARCHIVE_PREFIX = "paper-"
ARCHIVE_SUFFIX = ".tar.gz"


# --------------------------------------------------------------------------- #
# PUR — horloge (heure LOCALE, jamais celle du système)
# --------------------------------------------------------------------------- #

def _aware_utc(now: Any) -> datetime:
    """``now`` en ``datetime`` timezone-aware. Un naïf est traité comme UTC —
    même convention que le reste du lot (cf. ``calendar._naive``, dans
    l'autre sens)."""
    if not isinstance(now, datetime):
        now = datetime.now(timezone.utc)
    if now.tzinfo is None:
        now = now.replace(tzinfo=timezone.utc)
    return now


def _local(now: Any) -> datetime:
    return _aware_utc(now).astimezone(ZoneInfo(LOCAL_TZ))


def _iso_day(d: date) -> str:
    return "%04d-%02d-%02d" % (d.year, d.month, d.day)


def _local_day(now: Any) -> str:
    """Le jour ``AAAA-MM-JJ`` à l'heure LOCALE (PUR)."""
    return _iso_day(_local(now).date())


def _local_hour(now: Any) -> int:
    """L'heure LOCALE (0-23, PUR)."""
    return _local(now).hour


def should_run(now: Any, last_backup_date: Optional[str]) -> bool:
    """Faut-il sauvegarder MAINTENANT ? (PUR)

    Une fois par jour (heure locale) et pas avant :data:`RUN_AFTER_HOUR`.
    ``last_backup_date`` déjà égal au jour local courant -> ``False`` (déjà
    fait aujourd'hui, on ne réarchive pas à chaque passage du guetteur).
    """
    today = _local_day(now)
    if str(last_backup_date or "") == today:
        return False
    return _local_hour(now) >= RUN_AFTER_HOUR


# --------------------------------------------------------------------------- #
# I/O — chemins par défaut, résolus PARESSEUSEMENT depuis store.DATA_DIR (un
# test qui monkeypatch ce dernier isole donc aussi ce module, sans avoir à le
# connaître — même patron que alerts.paper_path()/calendar.state_path()).
# --------------------------------------------------------------------------- #

def _store():
    from backend.bots.paper import store
    return store


def default_src_dir() -> Path:
    """Ce qu'on sauvegarde : TOUT ``data/paper_trading/``."""
    return Path(_store().DATA_DIR)


def default_dest_dir() -> Path:
    """Où l'archive atterrit : ``data/backups/paper_trading/`` — un dossier
    FRÈRE de ``paper_trading/`` (jamais un enfant : l'archive ne doit pas
    s'engloutir elle-même d'un jour sur l'autre)."""
    return Path(_store().DATA_DIR).parent / "backups" / "paper_trading"


def state_path() -> Path:
    return Path(_store().DATA_DIR) / STATE_NAME


def load_state() -> Dict[str, Any]:
    """L'état de sauvegarde (``{"last_backup_date": "AAAA-MM-JJ"}``). Absent
    ou corrompu -> ``{}`` (jamais d'exception — un état vierge relance
    simplement une sauvegarde au prochain passage éligible)."""
    path = state_path()
    if not path.is_file():
        return {}
    try:
        with open(str(path), "r", encoding="utf-8") as handle:
            data = json.load(handle)
    except (OSError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


def save_state(state: Dict[str, Any]) -> None:
    """Persiste l'état de façon atomique, 0o600 (patron obligatoire du dépôt :
    le temporaire NAÎT en 0o600 via ``os.open``, jamais ``open()``+``chmod()``)."""
    path = state_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = path.parent / (".%s.tmp-%d" % (path.name, os.getpid()))
    fd = os.open(str(tmp_path), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    try:
        os.fchmod(fd, 0o600)
    except (AttributeError, OSError):
        pass
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(state or {}, handle, ensure_ascii=False, indent=2)
        os.replace(str(tmp_path), str(path))
    except Exception:
        try:
            os.remove(str(tmp_path))
        except OSError:
            pass
        raise


# --------------------------------------------------------------------------- #
# I/O — l'archive elle-même (chemins INJECTÉS : PUR-testable au sens du dépôt,
# même si tarfile touche le disque — aucune constante de chemin figée ici).
# --------------------------------------------------------------------------- #

def _rotate(dest_dir: Path, keep: int) -> None:
    """Ne garde que les ``keep`` archives les plus RÉCENTES. Le tri
    lexicographique suffit : le nom porte la date en ``AAAA-MM-JJ``, donc
    l'ordre alphabétique EST l'ordre chronologique."""
    try:
        archives = sorted(Path(dest_dir).glob(ARCHIVE_PREFIX + "*" + ARCHIVE_SUFFIX))
    except OSError:
        return
    excess = len(archives) - max(0, int(keep))
    for stale in archives[:max(0, excess)]:
        try:
            stale.unlink()
        except OSError:
            pass


def run_backup(now: Any, src_dir: Any, dest_dir: Any, keep: int = KEEP) -> Path:
    """Archive ``src_dir`` -> ``dest_dir/paper-AAAAMMJJ.tar.gz`` (écriture
    ``.tmp`` puis ``os.replace``, jamais un fichier à moitié écrit sous son nom
    final), puis fait tourner la rotation. Rend le chemin de l'archive.

    ``src_dir`` absent -> archive VIDE (pas d'erreur : une installation neuve
    sans aucune donnée n'a rien à sauvegarder, ce n'est pas une panne).

    Le dossier de destination n'est normalement JAMAIS sous la source (en
    prod, ``data/backups/paper_trading/`` est hors de ``data/paper_trading/``)
    — mais si un appelant configurait les deux chemins l'un dans l'autre,
    l'archive ne s'engloberait pas elle-même : tout ce qui vit sous
    ``dest_dir`` est exclu du contenu archivé.
    """
    src = Path(src_dir)
    dest = Path(dest_dir)
    dest.mkdir(parents=True, exist_ok=True)

    day = _iso_day(_local(now).date())
    target = dest / (ARCHIVE_PREFIX + day.replace("-", "") + ARCHIVE_SUFFIX)
    tmp_path = dest / (".%s.tmp-%d" % (target.name, os.getpid()))

    dest_rel: Optional[Path] = None
    try:
        dest_rel = dest.resolve().relative_to(src.resolve())
    except (OSError, ValueError):
        dest_rel = None      # dest hors de src (le cas normal) -> rien à exclure

    def _exclude_dest(tarinfo: tarfile.TarInfo) -> Optional[tarfile.TarInfo]:
        if dest_rel is None:
            return tarinfo
        # tarinfo.name est préfixé par arcname (ex. "paper_trading/sous/x") —
        # on compare le reste au chemin de dest RELATIF à src.
        rest = tarinfo.name.split("/", 1)
        member_rel = Path(rest[1]) if len(rest) > 1 else Path(".")
        try:
            member_rel.relative_to(dest_rel)
        except ValueError:
            return tarinfo
        return None           # sous dest_dir -> exclu

    try:
        with tarfile.open(str(tmp_path), "w:gz") as tar:
            if src.is_dir():
                tar.add(str(src), arcname=src.name, filter=_exclude_dest)
        os.replace(str(tmp_path), str(target))
    except Exception:
        try:
            os.remove(str(tmp_path))
        except OSError:
            pass
        raise

    _rotate(dest, keep)
    return target


# --------------------------------------------------------------------------- #
# I/O — le GATE, appelé depuis le cycle du guetteur (best-effort STRICT)
# --------------------------------------------------------------------------- #

def maybe_run(now: Any = None, src_dir: Any = None, dest_dir: Any = None,
             keep: int = KEEP,
             runner: Optional[Callable[..., Path]] = None) -> Dict[str, Any]:
    """Sauvegarde si c'est le moment, sinon ne fait rien. NE LÈVE JAMAIS —
    l'appelant (``newswatch.run_once``) ne doit jamais perdre un cycle de
    veille pour une panne de sauvegarde.

    Rend ``{"ran": bool, "path": str|None}`` (``"error"`` en plus si un échec
    a été avalé) — utile aux tests, ignoré du guetteur qui n'appelle ceci que
    pour son effet de bord.
    """
    now_dt = _aware_utc(now)
    try:
        state = load_state()
        if not should_run(now_dt, state.get("last_backup_date")):
            return {"ran": False, "path": None}

        src = src_dir if src_dir is not None else default_src_dir()
        dest = dest_dir if dest_dir is not None else default_dest_dir()
        do_run = runner if runner is not None else run_backup
        target = do_run(now_dt, src, dest, keep=keep)

        state = dict(state)
        state["last_backup_date"] = _local_day(now_dt)
        save_state(state)
        logger.info("paper backup: sauvegarde écrite (%s)", target)
        return {"ran": True, "path": str(target)}
    except Exception as exc:      # noqa: BLE001 — jamais fatal pour le cycle
        logger.warning("paper backup: sauvegarde impossible (%s)",
                       type(exc).__name__)
        return {"ran": False, "path": None, "error": type(exc).__name__}
