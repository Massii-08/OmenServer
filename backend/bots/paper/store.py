"""Persistance du simulateur de paper trading — I/O fichier UNIQUEMENT (pas
de logique métier, celle-ci vit dans coach.py/risk.py/etc.).

Deux mémoires par utilisateur, sous ``data/paper_trading/`` :
  - ``<user>.json``       : le portefeuille (Lot A, dict plain).
  - ``<user>.coach.json`` : le profil du coach (voir coach.py).
  - ``<user>-vault/``     : le carnet Markdown lisible façon Obsidian (§11) —
    ``Journal.md`` (append-only) + ``Biais/<code>.md`` (une page par biais).

Écriture ATOMIQUE 0o600 pour les JSON : le fichier temporaire NAÎT en 0o600
(``os.open`` + ``os.fchmod`` best-effort — pas de fenêtre world-readable),
puis ``os.replace`` bascule d'un coup — jamais de ``open()`` suivi d'un
``chmod()``. Même patron que ``backend/bots/harvester/unblocker_config.py``.
Les notes du carnet sont de simples APPENDS (pas de remplacement intégral du
fichier) : pas besoin du couple tmp+replace, ``O_APPEND`` avec création 0o600
suffit à rester atomique-safe.

Lecture tolérante : fichier absent -> None ; JSON corrompu -> None + le
fichier fautif est renommé en ``<nom>.corrupt`` (on ne perd pas la donnée,
on ne fait jamais planter l'appelant).
"""
import json
import os
import re
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional

# backend/bots/paper/store.py -> racine projet = parents[3]
_PROJECT_ROOT = Path(__file__).resolve().parents[3]
DATA_DIR = _PROJECT_ROOT / "data" / "paper_trading"

# Nom d'utilisateur : allowlist stricte (anti path-traversal, même esprit que
# _safe_player de mc_capture_store.py — mais ici on REJETTE plutôt que de
# sanitiser en silence : aucun '.' autorisé donc ".." est structurellement
# impossible à former).
_SAFE_USERNAME = re.compile(r"^[A-Za-z0-9_-]+$")
_USERNAME_MAX_LEN = 128

# Nom de note du carnet : au plus 1 niveau de sous-dossier ("Journal.md" ou
# "Biais/revenge_trade.md"), extension .md obligatoire, mêmes caractères
# autorisés que le username (donc aucun ".." possible non plus).
_SAFE_REL_NOTE = re.compile(r"^[A-Za-z0-9_-]+(/[A-Za-z0-9_-]+)?\.md$")


# --------------------------------------------------------------------------- #
# Helpers internes
# --------------------------------------------------------------------------- #

def _sanitize_username(username: Any) -> str:
    """Valide le nom d'utilisateur. Lève ValueError si invalide — pas de
    troncature/remplacement silencieux, on REJETTE."""
    # fullmatch (pas match) : $ seul matche aussi juste AVANT un '\n' final,
    # donc "alice\n" passerait match() alors qu'il contient un caractère hors
    # de l'allowlist — fullmatch exige que TOUT le texte soit consommé.
    if not isinstance(username, str) or not username or len(username) > _USERNAME_MAX_LEN \
            or not _SAFE_USERNAME.fullmatch(username):
        raise ValueError(f"nom d'utilisateur invalide: {username!r}")
    return username


def _validate_rel_name(rel_name: Any) -> str:
    """Valide le chemin relatif d'une note du carnet. Lève ValueError si
    invalide (mauvais caractères, plus d'un niveau de sous-dossier, pas de
    ``.md``)."""
    # fullmatch, même raison que _sanitize_username (piège $ + '\n' final).
    if not isinstance(rel_name, str) or not _SAFE_REL_NOTE.fullmatch(rel_name):
        raise ValueError(f"nom de note invalide: {rel_name!r}")
    return rel_name


def _atomic_write_json(path: Path, data: Any) -> None:
    """Écrit ``data`` en JSON de façon atomique et 0o600 (pattern obligatoire
    du projet). Si l'écriture échoue, le fichier final n'est jamais touché et
    le temporaire est nettoyé (best-effort)."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = path.parent / f".{path.name}.tmp-{os.getpid()}-{id(data):x}"
    fd = os.open(str(tmp_path), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    try:
        os.fchmod(fd, 0o600)
    except (AttributeError, OSError):
        pass
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
        os.replace(str(tmp_path), str(path))
    except Exception:
        try:
            os.remove(str(tmp_path))
        except OSError:
            pass
        raise


def _load_json(path: Path) -> Optional[Any]:
    """Charge un JSON. None si absent. Si corrompu : renomme en ``.corrupt``
    (on garde la trace) et retourne None plutôt que de planter."""
    path = Path(path)
    if not path.is_file():
        return None
    try:
        with open(str(path), "r", encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        corrupt_path = path.parent / (path.name + ".corrupt")
        try:
            os.replace(str(path), str(corrupt_path))
        except OSError:
            pass
        return None


def _vault_path(username: str) -> Path:
    """Chemin du carnet SANS effet de bord (pas de mkdir) — pour les lectures."""
    safe = _sanitize_username(username)
    return DATA_DIR / f"{safe}-vault"


# --------------------------------------------------------------------------- #
# API publique — portefeuille & profil coach (JSON, écriture intégrale)
# --------------------------------------------------------------------------- #

def portfolio_path(username: str) -> Path:
    """Chemin du fichier portefeuille de l'utilisateur (username validé)."""
    safe = _sanitize_username(username)
    return DATA_DIR / f"{safe}.json"


def coach_path(username: str) -> Path:
    """Chemin du fichier mémoire du coach de l'utilisateur (username validé)."""
    safe = _sanitize_username(username)
    return DATA_DIR / f"{safe}.coach.json"


def load_portfolio(username: str) -> Optional[Dict[str, Any]]:
    """Charge le portefeuille de l'utilisateur. None si absent/corrompu."""
    return _load_json(portfolio_path(username))


def save_portfolio(username: str, data: Dict[str, Any]) -> None:
    """Persiste le portefeuille de façon atomique, 0o600."""
    _atomic_write_json(portfolio_path(username), data)


def load_coach(username: str) -> Optional[Dict[str, Any]]:
    """Charge le profil coach de l'utilisateur. None si absent/corrompu."""
    return _load_json(coach_path(username))


def save_coach(username: str, data: Dict[str, Any]) -> None:
    """Persiste le profil coach de façon atomique, 0o600."""
    _atomic_write_json(coach_path(username), data)


def watchlist_path(username: str) -> Path:
    """Chemin du fichier watchlist de l'utilisateur (username validé).

    Fichier SÉPARÉ du portefeuille (``<user>.watchlist.json``, pas une clé du
    JSON ``<user>.json``) : le portefeuille round-trippe par la dataclass
    ``models.Portfolio`` (``from_dict``/``to_dict``), qui STRIPPE toute clé
    inconnue — y ranger la watchlist la ferait disparaître au premier
    ``_save`` (même classe de bug que le piège #61 du dépôt).
    """
    safe = _sanitize_username(username)
    return DATA_DIR / f"{safe}.watchlist.json"


def load_watchlist(username: str) -> List[Dict[str, Any]]:
    """Charge la watchlist de l'utilisateur. Absente/corrompue -> liste vide."""
    raw = _load_json(watchlist_path(username))
    if not isinstance(raw, dict):
        return []
    symbols = raw.get("symbols")
    return [s for s in symbols if isinstance(s, dict)] if isinstance(symbols, list) else []


def save_watchlist(username: str, symbols: List[Dict[str, Any]]) -> None:
    """Persiste la watchlist de façon atomique, 0o600."""
    _atomic_write_json(watchlist_path(username), {"symbols": list(symbols or [])})


def alerts_path(username: str) -> Path:
    """Chemin du fichier d'alertes de prix de l'utilisateur (username validé).

    Fichier SÉPARÉ du portefeuille (``<user>.alerts.json``) — même raison que
    la watchlist (``watchlist_path`` ci-dessus) : le round-trip par la
    dataclass ``models.Portfolio`` stripperait toute clé inconnue.
    """
    safe = _sanitize_username(username)
    return DATA_DIR / f"{safe}.alerts.json"


def load_alerts(username: str) -> List[Dict[str, Any]]:
    """Charge les alertes de prix de l'utilisateur. Absentes/corrompues -> []."""
    raw = _load_json(alerts_path(username))
    if not isinstance(raw, dict):
        return []
    rows = raw.get("alerts")
    return [a for a in rows if isinstance(a, dict)] if isinstance(rows, list) else []


def save_alerts(username: str, alerts: List[Dict[str, Any]]) -> None:
    """Persiste les alertes de prix de façon atomique, 0o600."""
    _atomic_write_json(alerts_path(username), {"alerts": list(alerts or [])})


def replay_path(username: str) -> Path:
    """Chemin du journal d'entraînement « bar replay » (LOT 3, A3) de
    l'utilisateur (username validé).

    Fichier SÉPARÉ du portefeuille (``<user>.replay.json``) — même raison que
    la watchlist/les alertes ci-dessus : le round-trip par la dataclass
    ``models.Portfolio`` stripperait toute clé inconnue.
    """
    safe = _sanitize_username(username)
    return DATA_DIR / f"{safe}.replay.json"


def load_replay_sessions(username: str) -> List[Dict[str, Any]]:
    """Les sessions d'entraînement de l'utilisateur, la plus RÉCENTE en tête.
    Absentes/corrompues -> []."""
    raw = _load_json(replay_path(username))
    if not isinstance(raw, dict):
        return []
    rows = raw.get("sessions")
    return [s for s in rows if isinstance(s, dict)] if isinstance(rows, list) else []


def save_replay_sessions(username: str, sessions: List[Dict[str, Any]]) -> None:
    """Persiste les sessions d'entraînement de façon atomique, 0o600. Le
    plafond (``replay.MAX_REPLAY_SESSIONS``) est de la RESPONSABILITÉ de
    l'appelant — ce module ne fait que l'I/O, jamais du métier (cf. tête de
    fichier)."""
    _atomic_write_json(replay_path(username), {"sessions": list(sessions or [])})


def ledger_path(username: str) -> Path:
    """Chemin du REGISTRE des décisions du compte (LOT 4) — ce qu'il a fait ET
    ce qu'on lui a refusé, la plus RÉCENTE en tête (username validé).

    Fichier SÉPARÉ du portefeuille (``<user>.ledger.json``) — même raison que
    la watchlist/les alertes/le replay ci-dessus : le round-trip par la
    dataclass ``models.Portfolio`` (``from_dict``/``to_dict``) STRIPPE toute
    clé inconnue, y ranger le registre le ferait disparaître au premier
    ``_save`` (piège #61 du dépôt).
    """
    safe = _sanitize_username(username)
    return DATA_DIR / f"{safe}.ledger.json"


def load_ledger(username: str) -> List[Dict[str, Any]]:
    """Le registre des décisions, la plus RÉCENTE en tête. Absent/corrompu -> []."""
    raw = _load_json(ledger_path(username))
    if not isinstance(raw, dict):
        return []
    rows = raw.get("rows")
    return [r for r in rows if isinstance(r, dict)] if isinstance(rows, list) else []


def save_ledger(username: str, rows: List[Dict[str, Any]]) -> None:
    """Persiste le registre de façon atomique, 0o600. Le plafond
    (``coach_trader.MAX_LEDGER``) est de la RESPONSABILITÉ de l'appelant — ce
    module ne fait que l'I/O, jamais du métier (cf. tête de fichier)."""
    _atomic_write_json(ledger_path(username), {"rows": list(rows or [])})


def equity_path(username: str) -> Path:
    """Chemin de la courbe de PATRIMOINE du compte (LOT 4) — une photo
    ``{"date", "equity"}`` par jour, ordre CHRONOLOGIQUE (username validé).

    Fichier SÉPARÉ du portefeuille (``<user>.equity.json``), même raison que
    :func:`ledger_path` juste au-dessus.
    """
    safe = _sanitize_username(username)
    return DATA_DIR / f"{safe}.equity.json"


def load_equity(username: str) -> List[Dict[str, Any]]:
    """Les points de la courbe de patrimoine, du plus ANCIEN au plus récent.
    Absents/corrompus -> []."""
    raw = _load_json(equity_path(username))
    if not isinstance(raw, dict):
        return []
    points = raw.get("points")
    return [p for p in points if isinstance(p, dict)] if isinstance(points, list) else []


def save_equity(username: str, points: List[Dict[str, Any]]) -> None:
    """Persiste la courbe de patrimoine de façon atomique, 0o600. Le plafond
    (``coach_trader.MAX_EQUITY_POINTS``) est de la RESPONSABILITÉ de
    l'appelant, comme pour le registre."""
    _atomic_write_json(equity_path(username), {"points": list(points or [])})


def postmortem_auto_path(username: str) -> Path:
    """Chemin du compteur anti-rafale des post-mortems AUTOMATIQUES (LOT 3,
    C1) de l'utilisateur (username validé) — ``<user>.postmortem_auto.json``,
    même famille que ``watchlist_path``/``alerts_path``/``replay_path``."""
    safe = _sanitize_username(username)
    return DATA_DIR / f"{safe}.postmortem_auto.json"


def load_postmortem_auto(username: str) -> Dict[str, Any]:
    """L'état du compteur anti-rafale (``{"date", "count"}``). Absent/corrompu
    -> ``{}`` (le compteur repart de zéro, jamais une exception)."""
    raw = _load_json(postmortem_auto_path(username))
    return raw if isinstance(raw, dict) else {}


def save_postmortem_auto(username: str, state: Dict[str, Any]) -> None:
    """Persiste l'état du compteur anti-rafale de façon atomique, 0o600."""
    _atomic_write_json(postmortem_auto_path(username), dict(state or {}))


# --------------------------------------------------------------------------- #
# API publique — carnet Markdown façon Obsidian (§11)
# --------------------------------------------------------------------------- #

# Noms de MODULE qui ont pu, avant le correctif 83a8d4b, se voir écrire un
# carnet comme s'ils étaient des comptes. Ces répertoires ``*-vault`` existent
# ENCORE sur les installations déployées : ils ne se suppriment pas tout seuls,
# et sans cette liste ils continueraient d'apparaître dans la communauté comme
# des « traders » fantômes (constaté à l'écran : « newswatch_global »,
# « whales_watch »).
#
# ⚠️ Ceinture ET bretelles : la vraie garantie est la règle ci-dessous (« un
# utilisateur a un portefeuille OU un profil coach »), qui écarte AUSSI les
# fantômes futurs dont on ignore encore le nom. Cette liste ne fait que
# DOCUMENTER ceux qu'on connaît.
RESERVED_VAULT_NAMES = frozenset({
    "newswatch_global", "whales_watch", "whales_cache", "convergence", "radar",
    "alerts_mode", "x_accounts",
    # ⚠️ « backfill » (dossiers historiques, 26/08) est le seul nom de cette
    # liste dont le fichier d'état, ``backfill.json``, est AUSSI le chemin que
    # ``portfolio_path`` rendrait pour un compte du même nom. La règle « un
    # utilisateur a un portefeuille » ci-dessous répondrait donc VRAI pour lui :
    # c'est cette ligne, vérifiée en premier, qui ferme la porte.
    "backfill",
})


def _is_real_account(username: str) -> bool:
    """Ce nom correspond-il à un VRAI compte ?

    Un carnet seul ne prouve rien : c'est justement par un carnet écrit à tort
    que les fantômes sont apparus. La preuve d'existence est un portefeuille
    (``<user>.json``) ou un profil de coach (``<user>.coach.json``) — les deux
    seuls fichiers qu'on n'écrit QUE pour un compte connecté.

    Un compte qui a discuté avec le coach sans jamais passer d'ordre a un
    profil mais pas de portefeuille : il compte, d'où le OU.
    """
    if username in RESERVED_VAULT_NAMES:
        return False
    try:
        return portfolio_path(username).is_file() or coach_path(username).is_file()
    except (ValueError, OSError):
        return False


def list_vault_users() -> List[str]:
    """Utilisateurs qui ont un carnet (``<user>-vault/`` sous ``DATA_DIR``) ET
    qui sont de VRAIS comptes, ordre alphabétique. Sert la communauté (carnets
    PARTAGÉS entre traders) : trouver QUI a un carnet avant de lister/lire ses
    notes.

    Lecture seule : ``DATA_DIR`` absent -> ``[]`` (même esprit que
    ``list_notes`` — une liste ne crée jamais de répertoire).

    Chaque nom candidat est revalidé par ``_sanitize_username`` (même
    allowlist que partout ailleurs dans ce module), puis par
    ``_is_real_account``. Cette seconde barrière est le correctif du 26/08 :
    la fonction listait tout répertoire ``*-vault``, or le bug d'avant 83a8d4b
    en avait créé pour des NOMS DE MODULE, et ces répertoires existent toujours
    sur le disque de production. Comme ``/community/{user}/{name}`` valide son
    paramètre CONTRE cette même liste, le filtre ferme les deux portes d'un
    coup — la liste et la lecture.
    """
    if not DATA_DIR.is_dir():
        return []
    out: List[str] = []
    for entry in DATA_DIR.iterdir():
        if not entry.is_dir() or not entry.name.endswith("-vault"):
            continue
        candidate = entry.name[: -len("-vault")]
        try:
            _sanitize_username(candidate)
        except ValueError:
            continue
        if not _is_real_account(candidate):
            continue
        out.append(candidate)
    out.sort()
    return out


def vault_dir(username: str) -> Path:
    """Répertoire du carnet Markdown de l'utilisateur (créé au besoin). Le
    sous-dossier ``Biais/`` n'est PAS créé ici — ``append_note`` le crée à la
    volée seulement quand une note y est effectivement écrite."""
    d = _vault_path(username)
    d.mkdir(parents=True, exist_ok=True)
    return d


def append_note(username: str, rel_name: str, markdown_text: str) -> None:
    """Ajoute (append) un bloc markdown à une note du carnet — crée la note
    et son éventuel sous-dossier (ex. ``Biais/``) au besoin.

    Écriture APPEND atomique-safe : ``O_APPEND`` avec création 0o600 via
    ``os.open`` (pas de fenêtre world-readable) — un append n'a pas besoin du
    couple tmp+``os.replace`` (pas de remplacement intégral du contenu).
    N'ajoute aucun formatage : le texte est écrit tel quel (c'est coach.py qui
    construit des blocs déjà séparés par des lignes vides).
    """
    safe_rel = _validate_rel_name(rel_name)
    vault = vault_dir(username)
    target = vault / safe_rel
    target.parent.mkdir(parents=True, exist_ok=True)
    text = markdown_text if isinstance(markdown_text, str) else str(markdown_text)
    fd = os.open(str(target), os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
    try:
        os.fchmod(fd, 0o600)
    except (AttributeError, OSError):
        pass
    with os.fdopen(fd, "a", encoding="utf-8") as f:
        f.write(text)


def list_notes(username: str) -> List[Dict[str, Any]]:
    """Liste les notes du carnet ``{"name", "size", "modified"}``, triées par
    date de modification décroissante. Vault jamais écrit -> ``[]`` (ne crée
    PAS le répertoire — une liste est une lecture, pas une écriture)."""
    vault = _vault_path(username)
    if not vault.is_dir():
        return []
    out: List[Dict[str, Any]] = []
    for path in vault.rglob("*.md"):
        if not path.is_file():
            continue
        try:
            st = path.stat()
        except OSError:
            continue
        out.append({
            "name": path.relative_to(vault).as_posix(),
            "size": st.st_size,
            "modified": datetime.fromtimestamp(st.st_mtime).isoformat(),
        })
    out.sort(key=lambda n: n["modified"], reverse=True)
    return out


def read_note(username: str, rel_name: str) -> Optional[str]:
    """Lit le contenu markdown d'une note. None si absente. Confinement
    ceinture+bretelles : au-delà de la regex de ``rel_name`` (qui interdit déjà
    toute séquence ``..``), le chemin résolu doit rester sous le vault résolu."""
    safe_rel = _validate_rel_name(rel_name)
    vault = _vault_path(username)
    target = vault / safe_rel
    try:
        vault_resolved = vault.resolve()
        target_resolved = target.resolve()
        target_resolved.relative_to(vault_resolved)
    except (OSError, ValueError):
        return None
    if not target_resolved.is_file():
        return None
    try:
        return target_resolved.read_text(encoding="utf-8")
    except OSError:
        return None
