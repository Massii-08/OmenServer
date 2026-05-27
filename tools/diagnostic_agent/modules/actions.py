"""
Catalogue d'actions du Diagnostic Bot — classifiées par tier de risque.

Tiers
-----
- 🟢 safe     : exécuté sans demander, juste loggé. Aucune perte possible.
                Exemple : vider les caches utilisateur (.recreated par les apps).
- 🟡 moderate : exécuté APRÈS confirmation explicite côté UI. Réversible mais
                impactant (interrompt une session active, ferme une app, etc.).
                Exemple : geler un processus tiers consommant beaucoup de RAM.
- 🔴 risky    : JAMAIS exécuté par l'agent. Renvoie des instructions
                step-by-step que l'utilisateur applique manuellement.
                Exemple : désactiver un service Windows, modifier le registre.

Cross-platform : chaque action déclare `platforms` (liste de noms `sys.platform`).
Le catalogue retourné par `list_actions()` est filtré pour la plateforme courante.

Pattern : chaque action est un dict avec un `runner` callable (None pour risky).
Le runner retourne {status, message, output?, freed_bytes?}.
"""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
import time
from pathlib import Path
from typing import Callable, Dict, List, Optional, Any

TIER_SAFE = "safe"
TIER_MODERATE = "moderate"
TIER_RISKY = "risky"


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _fmt_bytes(n: int) -> str:
    if n is None:
        return "—"
    if n < 1024:
        return f"{n} B"
    if n < 1024 * 1024:
        return f"{n / 1024:.1f} KB"
    if n < 1024 * 1024 * 1024:
        return f"{n / (1024 * 1024):.1f} MB"
    return f"{n / (1024 * 1024 * 1024):.2f} GB"


def _safe_unlink(path: Path) -> int:
    """Supprime un fichier ou dossier en silence. Renvoie les bytes libérés."""
    try:
        if path.is_symlink() or path.is_file():
            size = path.stat().st_size
            path.unlink(missing_ok=True)
            return size
        if path.is_dir():
            total = sum(p.stat().st_size for p in path.rglob('*') if p.is_file())
            shutil.rmtree(path, ignore_errors=True)
            return total
    except (PermissionError, OSError):
        return 0
    return 0


# ---------------------------------------------------------------------------
# 🟢 SAFE runners
# ---------------------------------------------------------------------------

def _run_clear_user_caches_macos() -> Dict[str, Any]:
    """
    Supprime les fichiers de cache utilisateur > 14 jours.

    Bug fix v3.3 : le check précédent comparait `entry.stat().st_mtime` sur le
    DOSSIER de cache de chaque app, pas sur les fichiers DEDANS. Sur macOS,
    quand une app tourne (même brièvement), la mtime du dossier parent est
    mise à jour → tous les caches actifs paraissent "récents" → 0 supprimés.

    Maintenant on descend récursivement et on supprime fichier par fichier
    selon leur propre mtime. Préserve les fichiers récents même dans un cache
    par ailleurs vieux.
    """
    cache_root = Path.home() / "Library" / "Caches"
    if not cache_root.is_dir():
        return {"status": "error", "message": "Dossier de caches introuvable."}
    cutoff = time.time() - 14 * 86400
    freed = 0
    touched = 0
    errors = 0

    for app_cache in cache_root.iterdir():
        # Skip les caches système Apple sauf WebKit (qui peut être énorme)
        if app_cache.name.startswith("com.apple.") and "WebKit" not in app_cache.name:
            continue
        if not app_cache.is_dir():
            continue

        # Descente récursive — supprime UNIQUEMENT les fichiers > 14j,
        # préserve les récents
        try:
            for f in app_cache.rglob("*"):
                if not f.is_file():
                    continue
                try:
                    st = f.stat()
                    if st.st_mtime < cutoff:
                        size = st.st_size
                        f.unlink()
                        freed += size
                        touched += 1
                except (OSError, PermissionError):
                    errors += 1
                    continue
        except (OSError, PermissionError):
            errors += 1
            continue

    msg = f"{touched} fichiers >14j supprimés ({_fmt_bytes(freed)} libérés)"
    if errors > 0:
        msg += f" · {errors} erreurs (permissions)"
    return {
        "status": "success",
        "message": msg,
        "freed_bytes": freed,
        "files_deleted": touched,
        "errors": errors,
    }


def _run_clear_temp_windows() -> Dict[str, Any]:
    """Supprime les fichiers >7j dans %TEMP%."""
    temp = Path(os.environ.get("TEMP") or os.environ.get("TMP") or "")
    if not temp.is_dir():
        return {"status": "error", "message": "%TEMP% introuvable."}
    cutoff = time.time() - 7 * 86400
    freed = 0
    touched = 0
    for entry in temp.iterdir():
        try:
            if entry.stat().st_mtime < cutoff:
                freed += _safe_unlink(entry)
                touched += 1
        except OSError:
            continue
    return {
        "status": "success",
        "message": f"{touched} fichiers >7j supprimés dans %TEMP% ({_fmt_bytes(freed)} libérés)",
        "freed_bytes": freed,
    }


def _run_flush_dns_windows() -> Dict[str, Any]:
    """ipconfig /flushdns — sans privilèges, juste vide le cache DNS local."""
    try:
        result = subprocess.run(
            ["ipconfig", "/flushdns"],
            capture_output=True, text=True, timeout=10,
        )
        if result.returncode == 0:
            return {"status": "success", "message": "Cache DNS local vidé.",
                    "output": result.stdout.strip()}
        return {"status": "error",
                "message": f"flushdns a échoué (code {result.returncode})",
                "output": result.stderr.strip()}
    except (subprocess.SubprocessError, FileNotFoundError) as e:
        return {"status": "error", "message": f"Erreur : {e}"}


def _run_flush_dns_macos() -> Dict[str, Any]:
    """
    Relance mDNSResponder via `sudo -n` (non-interactive).

    macOS Catalina+ exige sudo pour HUP mDNSResponder. L'agent LaunchAgent
    tourne en user → on s'appuie sur une règle sudoers PRÉ-INSTALLÉE :

        /etc/sudoers.d/omen-diagnostic-agent
        <user> ALL=(root) NOPASSWD: /usr/bin/killall -HUP mDNSResponder

    Cette règle est créée par `setup_macos.sh enable-dns-flush` (one-shot,
    demande sudo une fois pour écrire le fichier sudoers, puis l'agent peut
    flush DNS sans password à vie).

    Si la règle n'est pas installée, sudo -n échoue immédiatement → on
    renvoie un message clair indiquant comment l'activer.
    """
    try:
        # Tentative 1 : sans sudo (au cas où, rarement permis)
        result = subprocess.run(
            ["killall", "-HUP", "mDNSResponder"],
            capture_output=True, text=True, timeout=5,
        )
        if result.returncode == 0:
            return {"status": "success", "message": "Cache DNS vidé (mDNSResponder relancé)."}

        # Tentative 2 : sudo -n (s'appuie sur sudoers.d/omen-diagnostic-agent)
        result = subprocess.run(
            ["sudo", "-n", "killall", "-HUP", "mDNSResponder"],
            capture_output=True, text=True, timeout=5,
        )
        if result.returncode == 0:
            return {"status": "success", "message": "Cache DNS vidé (mDNSResponder relancé via sudo)."}

        # Échec : probablement pas de règle sudoers
        return {
            "status": "error",
            "message": (
                "sudo requis. Active la règle sudoers une fois pour autoriser cette action : "
                "lance `./setup_macos.sh enable-dns-flush` dans tools/diagnostic_agent/ "
                "(demande ton password macOS une seule fois)."
            ),
            "output": (result.stderr or "").strip(),
        }
    except (subprocess.SubprocessError, FileNotFoundError) as e:
        return {"status": "error", "message": f"Erreur : {e}"}


# ---------------------------------------------------------------------------
# 🟡 MODERATE runners
# ---------------------------------------------------------------------------

def _run_suspend_heavy_user_apps(payload: Dict[str, Any]) -> Dict[str, Any]:
    """
    Gel des processus tiers consommant le plus de RAM (top-N défini par payload).
    Délègue à process_manager.suspend_process en respectant la Safe List.
    """
    import psutil
    from modules.process_manager import suspend_process, is_process_safe

    top_n = int(payload.get("top_n", 3)) if payload else 3
    candidates = []
    for proc in psutil.process_iter(['pid', 'name', 'exe', 'status', 'memory_info']):
        try:
            info = proc.info
            if is_process_safe(info.get('name'), info.get('exe')):
                continue
            if info.get('status') not in ('running', 'sleeping'):
                continue
            mem = (info.get('memory_info') or None)
            rss = mem.rss if mem else 0
            candidates.append((rss, info['pid'], info['name']))
        except Exception:
            continue
    candidates.sort(reverse=True)
    targets = candidates[:top_n]
    if not targets:
        return {"status": "error", "message": "Aucun processus suspensible trouvé."}

    results = []
    success_count = 0
    for rss, pid, name in targets:
        r = suspend_process(pid)
        results.append({"pid": pid, "name": name, "rss": rss, **r})
        if r.get("status") == "success":
            success_count += 1
    return {
        "status": "success" if success_count else "error",
        "message": f"{success_count}/{len(targets)} processus gelés (top-{top_n} RAM)",
        "output": results,
    }


# ---------------------------------------------------------------------------
# 🔴 RISKY — instructions only, NO runner
# ---------------------------------------------------------------------------

_INSTRUCTIONS_DISABLE_WINDOWS_TELEMETRY = [
    "Ouvrir l'invite Exécuter avec **Win + R**",
    "Taper `services.msc` puis Entrée",
    "Localiser le service **Connected User Experiences and Telemetry** (DiagTrack)",
    "Clic droit → **Propriétés**",
    "Type de démarrage → **Désactivé** → Appliquer",
    "Cliquer sur **Arrêter** s'il tourne",
    "Redémarrer Windows pour appliquer définitivement",
]

_INSTRUCTIONS_DISABLE_MACOS_LOGIN_ITEMS = [
    "Ouvrir **Réglages Système**",
    "Aller dans **Général** > **Ouverture**",
    "Onglet **Ouverture** : décocher les apps que tu ne veux pas voir au login",
    "Onglet **Autoriser en arrière-plan** : désactiver les services tiers non essentiels",
    "Redémarrer pour valider que rien d'important ne casse",
]


# ---------------------------------------------------------------------------
# Catalogue (déclaratif)
# ---------------------------------------------------------------------------

_CATALOG: List[Dict[str, Any]] = [
    # 🟢 SAFE
    {
        "id": "clear_user_caches_macos",
        "tier": TIER_SAFE,
        "title": "Vider les caches utilisateur (>14 jours)",
        "description": "Supprime les caches dans ~/Library/Caches modifiés il y a plus de 14 jours. Les apps recréeront ce dont elles ont besoin.",
        "platforms": ["darwin"],
        "runner": _run_clear_user_caches_macos,
    },
    {
        "id": "clear_temp_windows",
        "tier": TIER_SAFE,
        "title": "Vider %TEMP% (fichiers >7 jours)",
        "description": "Supprime les fichiers temporaires Windows >7j. Aucune app active n'en a besoin.",
        "platforms": ["win32"],
        "runner": _run_clear_temp_windows,
    },
    {
        "id": "flush_dns_windows",
        "tier": TIER_SAFE,
        "title": "Vider le cache DNS",
        "description": "ipconfig /flushdns — utile si certains sites ne chargent plus depuis un changement de réseau.",
        "platforms": ["win32"],
        "runner": _run_flush_dns_windows,
    },
    {
        "id": "flush_dns_macos",
        "tier": TIER_SAFE,
        "title": "Vider le cache DNS",
        "description": "Relance mDNSResponder — utile après un changement de réseau/VPN. Nécessite une autorisation sudoers une seule fois (voir warning).",
        "platforms": ["darwin"],
        "runner": _run_flush_dns_macos,
        "warning": "Première fois ? Lance `./setup_macos.sh enable-dns-flush` dans tools/diagnostic_agent/ pour autoriser l'agent à exécuter cette commande sans password (one-shot, demande sudo une fois).",
    },

    # 🟡 MODERATE
    {
        "id": "suspend_heavy_user_apps",
        "tier": TIER_MODERATE,
        "title": "Geler les 3 apps tierces les plus gourmandes en RAM",
        "description": "Mode Gaming — suspend les 3 processus non-system les plus consommateurs. Réversible via Reprendre.",
        "platforms": ["win32", "darwin", "linux"],
        "runner": _run_suspend_heavy_user_apps,
        "confirmation_text": "Cette action gèle (suspend) les 3 processus utilisateur les plus gourmands en RAM. Tu pourras les reprendre individuellement depuis la liste ci-dessous. Confirmer ?",
    },

    # 🔴 RISKY (instructions only)
    {
        "id": "disable_windows_telemetry",
        "tier": TIER_RISKY,
        "title": "Désactiver la télémétrie Windows (service DiagTrack)",
        "description": "Le service Connected User Experiences and Telemetry envoie des données à Microsoft. Tu peux le désactiver manuellement.",
        "platforms": ["win32"],
        "runner": None,
        "instructions": _INSTRUCTIONS_DISABLE_WINDOWS_TELEMETRY,
        "warning": "Action persistante. Microsoft peut le réactiver lors d'un Windows Update majeur.",
    },
    {
        "id": "disable_macos_login_items",
        "tier": TIER_RISKY,
        "title": "Désactiver les apps au démarrage (Login Items)",
        "description": "Beaucoup d'apps s'installent au boot sans demander. Voici comment les nettoyer.",
        "platforms": ["darwin"],
        "runner": None,
        "instructions": _INSTRUCTIONS_DISABLE_MACOS_LOGIN_ITEMS,
        "warning": "Désactiver un service tiers peut empêcher certaines fonctionnalités (cloud sync, mises à jour automatiques).",
    },
]


# ---------------------------------------------------------------------------
# API publique
# ---------------------------------------------------------------------------

def list_actions() -> List[Dict[str, Any]]:
    """Retourne le catalogue filtré pour la plateforme courante (sans le `runner`)."""
    plat = sys.platform
    out = []
    for a in _CATALOG:
        if plat not in a["platforms"]:
            continue
        # Ne JAMAIS sérialiser le runner (callable non JSON)
        entry = {k: v for k, v in a.items() if k not in ("runner", "platforms")}
        out.append(entry)
    return out


def run_action(action_id: str, payload: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """
    Exécute une action SAFE ou MODERATE par son id.
    Refuse les tier RISKY (l'agent ne doit JAMAIS les exécuter).
    """
    action = next((a for a in _CATALOG if a["id"] == action_id), None)
    if action is None:
        return {"status": "error", "message": f"Action inconnue : {action_id}"}
    if sys.platform not in action["platforms"]:
        return {"status": "error", "message": f"Action indisponible sur {sys.platform}."}
    if action["tier"] == TIER_RISKY:
        return {
            "status": "error",
            "message": "Cette action est classée 🔴 risquée — l'agent ne l'exécute pas. Suivre les instructions manuellement.",
        }
    runner: Optional[Callable] = action.get("runner")
    if runner is None:
        return {"status": "error", "message": "Aucun runner défini pour cette action."}
    try:
        # Les runners moderate prennent un payload, les safe non
        if action["tier"] == TIER_MODERATE:
            return runner(payload or {})
        return runner()
    except Exception as e:
        return {"status": "error", "message": f"Exception runner : {e.__class__.__name__}: {e}"}
