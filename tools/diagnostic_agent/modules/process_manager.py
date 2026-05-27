import psutil
import os
import re

SAFE_LIST_EXACT_MATCHES = [
    "explorer.exe",
    "taskmgr.exe",
    "smss.exe",
    "csrss.exe",
    "wininit.exe",
    "winlogon.exe",
    "services.exe",
    "lsass.exe",
    "svchost.exe",
    "spoolsv.exe"
]

SAFE_LIST_PATHS = [
    r"C:\Windows\System32".lower(),
    r"C:\Windows\SysWOW64".lower()
]

def is_process_safe(proc_name: str, proc_path: str) -> bool:
    """
    Vérifie si un processus est critique pour le système et ne doit JAMAIS être touché.
    """
    if not proc_name:
        return True # Doute = Safe
    
    if proc_name.lower() in SAFE_LIST_EXACT_MATCHES:
        return True
    
    if proc_path:
        proc_path_lower = proc_path.lower()
        for safe_path in SAFE_LIST_PATHS:
            if proc_path_lower.startswith(safe_path):
                return True
                
    return False

# ---------------------------------------------------------------------------
# App grouping — identifie l'application d'origine d'un processus pour pouvoir
# présenter Chrome / Discord / VS Code etc. comme UN seul groupe dans le
# dashboard, au lieu d'une liste plate de 50+ helpers.
# ---------------------------------------------------------------------------

_MACOS_BUNDLE_RE = re.compile(r'/([^/]+)\.app/')
_PAREN_SUFFIX_RE = re.compile(r'\s*\([^)]*\)\s*$')

_WINDOWS_FOLDER_MARKERS = (
    "Program Files",
    "Program Files (x86)",
    "Programs",      # AppData\Local\Programs\X
    "WindowsApps",   # MS Store
)

# Marqueurs de chemin "système" → tous bucketés dans un seul groupe "Système"
# (sinon on se retrouve avec des groupes vides de sens comme "MacOS", "libexec",
# "CoreServices", "Versions" qui sont juste des dossiers parents génériques).
_SYSTEM_PATH_MARKERS = (
    "/System/",                     # macOS system core
    "/usr/libexec/",                # macOS/BSD service binaries
    "/usr/sbin/", "/usr/bin/",
    "/sbin/", "/bin/",
    "/Library/Frameworks/",
    "/Library/PrivateFrameworks/",
    "/Library/CoreServices/",
    "/Library/Apple/",
    "\\Windows\\",                  # Windows system32/winsxs
    "\\WinSxS\\",
)

_GENERIC_FOLDER_NAMES = {
    "system32", "syswow64", "windows", "drivers",
    "bin", "sbin", "usr", "system", "library",
    "macos", "versions", "support", "libexec", "coreservices",
    "frameworks", "privateframeworks",
}


def derive_app_group(name, exe):
    """
    Stratégies (par ordre de priorité) :
      1. macOS app bundle  → premier `.app/` rencontré dans le chemin de l'exe.
         Ex: /Applications/Google Chrome.app/Contents/Frameworks/Google Chrome Helper.app/...
             → "Google Chrome"  (le bundle racine, pas le helper)
      2. Chemin système (macOS /System /usr /Library, Windows \\Windows\\)
         → groupe unique "Système" pour pas polluer la liste.
      3. Windows install folder → premier segment sous Program Files / Programs / etc.
         Ex: C:\\Program Files\\Discord\\app-1.0.9027\\Discord.exe → "Discord"
      4. Fallback : nom du process, strippé de `.exe`/`.app` et des suffixes parenthésés.
         Ex: "Google Chrome Helper (Renderer)" → "Google Chrome Helper"
    """
    if not name and not exe:
        return "Inconnu"

    # 1) macOS .app bundle (premier match = bundle racine)
    if exe:
        m = _MACOS_BUNDLE_RE.search(exe)
        if m:
            return m.group(1)

    # 2) Processes système (macOS + Windows) → bucket unique
    if exe:
        norm = exe.replace("\\", "/").replace("//", "/")
        for marker in _SYSTEM_PATH_MARKERS:
            if marker.replace("\\", "/") in norm or marker in exe:
                return "Système"

    # 3) Windows install folder
    if exe and ("\\" in exe or "/" in exe):
        parts = exe.replace("/", "\\").split("\\")
        for marker in _WINDOWS_FOLDER_MARKERS:
            if marker in parts:
                idx = parts.index(marker)
                if idx + 1 < len(parts):
                    return parts[idx + 1]
        # Dossier parent immédiat — uniquement si pas générique
        if len(parts) >= 2:
            folder = parts[-2]
            if folder.lower() not in _GENERIC_FOLDER_NAMES:
                return folder

    # 4) Fallback : nom strippé
    n = name or ""
    for suffix in (".exe", ".app"):
        if n.lower().endswith(suffix):
            n = n[: -len(suffix)]
    n = _PAREN_SUFFIX_RE.sub("", n).strip()
    return n or "Inconnu"


def get_suspensible_processes():
    """
    Retourne une liste de processus qui ne sont pas dans la Safe List (susceptibles d'être gelés).
    Chaque entrée a : pid, name, status, exe, memory_mb (RSS), app_group.
    """
    suspensible = []
    for proc in psutil.process_iter(['pid', 'name', 'exe', 'status', 'memory_info']):
        try:
            info = proc.info
            name = info.get('name')
            exe = info.get('exe') or ''
            if is_process_safe(name, exe):
                continue
            mem_info = info.get('memory_info')
            rss = mem_info.rss if mem_info else 0
            suspensible.append({
                "pid": info['pid'],
                "name": name,
                "status": info['status'],
                "exe": exe,
                "memory_mb": round(rss / (1024 * 1024), 1),
                "app_group": derive_app_group(name, exe),
            })
        except (psutil.NoSuchProcess, psutil.AccessDenied, psutil.ZombieProcess):
            pass
    return suspensible


def bulk_suspend(pids):
    """
    Suspend une liste de PIDs en une seule opération. Renvoie un dict agrégé :
    { status, message, results: [{pid, status, message}], success_count, total }
    """
    if not pids:
        return {"status": "error", "message": "Aucun PID fourni", "results": [], "success_count": 0, "total": 0}
    results = []
    success = 0
    for pid in pids:
        try:
            pid_int = int(pid)
        except (TypeError, ValueError):
            results.append({"pid": pid, "status": "error", "message": "PID invalide"})
            continue
        r = suspend_process(pid_int)
        results.append({"pid": pid_int, **r})
        if r.get("status") == "success":
            success += 1
    total = len(pids)
    return {
        "status": "success" if success else "error",
        "message": f"{success}/{total} processus gelés",
        "results": results,
        "success_count": success,
        "total": total,
    }

def suspend_process(pid: int) -> dict:
    """
    Suspend (freeze) un processus au lieu de le tuer (Gaming Mode).
    """
    try:
        proc = psutil.Process(pid)
        # Vérification Safe List de dernière minute
        # proc.exe() peut lever AccessDenied sur certains process système — on le gère
        try:
            proc_exe = proc.exe()
        except (psutil.AccessDenied, psutil.ZombieProcess):
            proc_exe = None

        if is_process_safe(proc.name(), proc_exe):
            return {"status": "error", "message": f"Processus {pid} protégé par la Safe List."}
        
        proc.suspend()
        return {"status": "success", "message": f"Processus {pid} suspendu avec succès."}
    except psutil.AccessDenied:
        return {"status": "error", "message": f"Accès refusé pour suspendre {pid}."}
    except psutil.NoSuchProcess:
        return {"status": "error", "message": f"Processus {pid} introuvable."}
    except Exception as e:
        return {"status": "error", "message": f"Erreur inattendue: {str(e)}"}

def resume_process(pid: int) -> dict:
    """
    Reprend un processus suspendu.
    """
    try:
        proc = psutil.Process(pid)
        proc.resume()
        return {"status": "success", "message": f"Processus {pid} a repris son exécution."}
    except psutil.AccessDenied:
        return {"status": "error", "message": f"Accès refusé pour reprendre {pid}."}
    except psutil.NoSuchProcess:
        return {"status": "error", "message": f"Processus {pid} introuvable."}
    except Exception as e:
        return {"status": "error", "message": f"Erreur inattendue: {str(e)}"}
