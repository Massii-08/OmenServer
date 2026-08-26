"""Le canal Telegram du simulateur — le bot ORACLE, pas celui du Harvester.

Décision de l'utilisateur (spec §13) : les messages du paper trading doivent
arriver sur SON bot Oracle, pas dans le fil du Harvester. Le module donne au
paper trading **un seul point de sortie** : ``newswatch``, ``whales`` et
``convergence`` passent tous par ici, donc changer de bot se fait en posant un
fichier, jamais en éditant trois modules.

Deux niveaux, dans cet ordre :

1. ``data/paper_telegram.json`` — la config du bot Oracle, posée côté serveur
   (même forme que celle du Harvester : ``{"token", "chat_id"}``) ;
2. **repli** sur la config du Harvester si le fichier paper est absent,
   illisible ou incomplet — le canal historique continue de marcher tant que
   personne n'a posé le fichier dédié.

Rien nulle part -> ``None`` : les appelants savent déjà quoi faire d'un canal
éteint (``newswatch`` et ``whales`` ne font alors AUCUN réseau ; c'est une
fonctionnalité opt-in, pas un flux qu'on peut oublier d'allumer).

🔒 **Aucune valeur n'est jamais loguée** — ni le jeton, ni le chat, ni un
extrait : les seules traces sont « config absente » / « envoi échoué ». La
même posture que ``harvester/notify.py``, qui avale toute exception pour ne
jamais faire fuiter un jeton dans une trace d'erreur.

La config Telegram est posée à la main côté serveur (0o600), ce module ne fait
que la LIRE. Le seul fichier qu'il ÉCRIT est le mode d'alerte (voir plus bas),
qui est un réglage utilisateur. Pas de nouvelle dépendance — l'envoi réel est
délégué à ``harvester/notify.py`` (httpx, déjà en prod).

--------------------------------------------------------------------------
Le MODE d'alerte (extension 2026-08-26)
--------------------------------------------------------------------------
Retour utilisateur : « je reçois plein de notifs du scanner, pas le temps de
tout lire ni de comprendre — le coach doit tout intégrer et ne m'avertir QUE
quand des facteurs s'alignent ». D'où deux modes, et **« calme » par défaut** :

* ``calme`` — les émetteurs UNITAIRES se taisent (une dépêche par symbole, une
  annonce politique, un dépôt 13F). Ils continuent d'ENREGISTRER : la mémoire,
  le fil de l'interface et la convergence voient exactement la même matière
  qu'avant. Seul l'ENVOI est supprimé ;
* ``tout`` — le comportement historique, message par message.

**La convergence, elle, parle dans LES DEUX modes** : c'est elle la voix. Faire
taire le digest en mode calme reviendrait à éteindre la seule chose que
l'utilisateur a demandé à garder.

Un mode illisible ou inconnu retombe sur ``calme`` : le repli va vers le
SILENCE, jamais vers le bruit — c'est le sens de la demande.
"""
import json
import logging
import os
from pathlib import Path
from typing import Any, Dict, Optional

logger = logging.getLogger("omenserver")

# backend/bots/paper/alerts.py -> racine projet = parents[3]
_PROJECT_ROOT = Path(__file__).resolve().parents[3]

PAPER_TG_NAME = "paper_telegram.json"
PAPER_TG_PATH = _PROJECT_ROOT / "data" / PAPER_TG_NAME

# Réglage utilisateur, rangé AVEC les données du simulateur (et non dans
# ``data/`` comme la config Telegram : celle-ci est une config d'exploitation
# posée par l'administrateur, celui-là est un choix de lecture).
MODE_NAME = "alerts_mode.json"
MODES = ("calme", "tout")
DEFAULT_MODE = "calme"

# Un mode peut arriver de l'interface, d'un test ou d'un état recopié : on
# accepte quelques synonymes, tout le reste retombe sur « calme ».
_MODE_ALIASES = {
    "calme": "calme", "quiet": "calme", "silencieux": "calme",
    "tout": "tout", "all": "tout", "verbeux": "tout",
}


def paper_path() -> Path:
    """Chemin du fichier de config du bot Oracle.

    Résolu à CHAQUE appel depuis ``store.DATA_DIR`` (dont le parent est le
    ``data/`` du projet), pour qu'un test qui isole le répertoire de données
    isole aussi ce canal — même patron que ``radar.state_path()``. Le module
    ``store`` indisponible -> la constante, calculée à l'import.
    """
    try:
        from backend.bots.paper import store
        return Path(store.DATA_DIR).parent / PAPER_TG_NAME
    except Exception:      # noqa: BLE001 — un chemin ne doit jamais faire tomber
        return PAPER_TG_PATH


def mode_path() -> Path:
    """Chemin du fichier de mode, résolu à CHAQUE appel depuis
    ``store.DATA_DIR`` (même raison que ``paper_path``: un test qui isole le
    répertoire de données isole aussi le réglage). ``store`` indisponible ->
    le chemin par défaut, calculé à l'import."""
    try:
        from backend.bots.paper import store
        return Path(store.DATA_DIR) / MODE_NAME
    except Exception:      # noqa: BLE001 — un chemin ne doit jamais faire tomber
        return _PROJECT_ROOT / "data" / "paper_trading" / MODE_NAME


def normalize_mode(value: Any) -> str:
    """Mode ramené dans ``MODES``. Inconnu -> « calme » (repli vers le
    silence : une valeur illisible ne doit JAMAIS rallumer le bruit)."""
    return _MODE_ALIASES.get(str(value or "").strip().lower(), DEFAULT_MODE)


def get_mode(path: Optional[Any] = None) -> str:
    """Le mode d'alerte courant. Fichier absent/illisible -> « calme »."""
    data = _read_json(Path(path) if path is not None else mode_path())
    return normalize_mode(data.get("mode"))


def set_mode(value: Any, path: Optional[Any] = None) -> str:
    """Persiste le mode (atomique, 0o600) et rend le mode RÉELLEMENT écrit.

    Le retour est le mode NORMALISÉ, pas celui demandé : l'appelant affiche ce
    qui s'applique, jamais ce qu'il croyait demander (même posture que
    ``llm.normalize_risk_level`` renvoyé par ``/ideas``).
    """
    mode = normalize_mode(value)
    target = Path(path) if path is not None else mode_path()
    target.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = target.parent / (".%s.tmp-%d" % (target.name, os.getpid()))
    fd = os.open(str(tmp_path), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    try:
        os.fchmod(fd, 0o600)
    except (AttributeError, OSError):
        pass
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump({"mode": mode}, handle, ensure_ascii=False, indent=2)
        os.replace(str(tmp_path), str(target))
    except Exception:
        try:
            os.remove(str(tmp_path))
        except OSError:
            pass
        raise
    return mode


def is_quiet(mode: Optional[Any] = None) -> bool:
    """Les émetteurs unitaires doivent-ils se taire ?

    ``mode=None`` = « débrouille-toi » -> lecture du disque. Un mode passé
    explicitement court-circuite le disque : c'est ce qui permet à un cycle de
    veille de décider UNE fois et de rester cohérent d'un bout à l'autre du
    passage (et à un test de ne dépendre d'aucun fichier).
    """
    return normalize_mode(mode if mode is not None else get_mode()) == "calme"


def _read_json(path: Path) -> Dict[str, Any]:
    """Lit un JSON objet. Absent, illisible ou déformé -> ``{}``."""
    try:
        if not path.is_file():
            return {}
        with open(str(path), "r", encoding="utf-8") as handle:
            data = json.load(handle)
    except (OSError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


def _usable(cfg: Any) -> bool:
    """Une config n'est utilisable QUE complète : un jeton sans destinataire
    (ou l'inverse) est une config à moitié posée, pas un canal."""
    if not isinstance(cfg, dict):
        return False
    return bool(cfg.get("token")) and bool(cfg.get("chat_id"))


def load_cfg(path: Optional[Any] = None) -> Optional[Dict[str, Any]]:
    """La config Telegram du paper trading, ou ``None`` si aucun canal.

    Ordre : fichier paper (bot Oracle) -> config du Harvester -> ``None``.
    ``path`` surcharge le fichier paper (tests, ou déploiement exotique).
    """
    cfg = _read_json(Path(path) if path is not None else paper_path())
    if _usable(cfg):
        return cfg

    try:
        from backend.bots.harvester import telegram_config
        fallback = telegram_config.load()
    except Exception:      # noqa: BLE001 — module absent = pas de repli
        fallback = None
    if _usable(fallback):
        return fallback

    logger.debug("paper alerts: aucun canal Telegram configuré")
    return None


def send(text: str, cfg: Optional[Dict[str, Any]] = None, client: Any = None) -> bool:
    """Envoie ``text`` sur le canal du paper trading. ``True`` si c'est parti.

    Best-effort de bout en bout : aucune exception ne sort d'ici, et un canal
    absent rend ``False`` **sans toucher au réseau**.

    ``cfg`` explicite à ``{}`` (ou toute valeur vide) = canal ÉTEINT : on ne
    retombe PAS sur le disque. C'est la convention des voisins (``newswatch``,
    ``whales``, ``radar`` traitent ``tg_cfg={}`` comme « pas de Telegram »), et
    la seule qui permette à un test de garantir qu'aucun message ne part.
    ``cfg=None`` (le défaut) = « débrouille-toi » -> ``load_cfg()``.
    """
    if cfg is None:
        cfg = load_cfg()
    if not _usable(cfg):
        return False
    try:
        from backend.bots.harvester import notify
        return bool(notify.send(text, cfg, client=client))
    except Exception:      # noqa: BLE001 — ne fuite jamais le jeton dans une trace
        logger.debug("paper alerts: envoi Telegram échoué")
        return False
