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

Aucune écriture ici : le fichier est posé à la main côté serveur (0o600), ce
module ne fait que le LIRE. Pas de nouvelle dépendance — l'envoi réel est
délégué à ``harvester/notify.py`` (httpx, déjà en prod).
"""
import json
import logging
from pathlib import Path
from typing import Any, Dict, Optional

logger = logging.getLogger("omenserver")

# backend/bots/paper/alerts.py -> racine projet = parents[3]
_PROJECT_ROOT = Path(__file__).resolve().parents[3]

PAPER_TG_NAME = "paper_telegram.json"
PAPER_TG_PATH = _PROJECT_ROOT / "data" / PAPER_TG_NAME


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
