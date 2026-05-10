"""
Informations système — Lecture CPU, RAM, disque, température, réseau.

On utilise la librairie 'psutil' (Process and System Utilities) qui sait
lire les capteurs de l'ordinateur. Elle fonctionne sur Windows, Linux et Mac.

Chaque fonction retourne un dictionnaire avec les infos formatées,
prêt à être envoyé au frontend en JSON.
"""

import psutil
import platform
from datetime import datetime


def get_cpu_info() -> dict:
    """
    Retourne les infos sur le processeur.

    Exemple de retour:
    {
        "percent": 45.2,          # Utilisation en %
        "count": 8,               # Nombre de cœurs
        "freq_current": 3200.0    # Fréquence actuelle en MHz
    }
    """
    freq = psutil.cpu_freq()
    return {
        "percent": psutil.cpu_percent(interval=0.5),
        "count": psutil.cpu_count(),
        "freq_current": round(freq.current, 0) if freq else 0,
    }


def get_memory_info() -> dict:
    """
    Retourne les infos sur la RAM.

    Exemple de retour:
    {
        "total_gb": 16.0,     # RAM totale en Go
        "used_gb": 8.5,       # RAM utilisée en Go
        "available_gb": 7.5,  # RAM disponible en Go
        "percent": 53.1       # Utilisation en %
    }
    """
    mem = psutil.virtual_memory()
    total_gb = round(mem.total / (1024 ** 3), 1)
    used_gb = round(mem.used / (1024 ** 3), 1)
    # Calcul du % basé sur used/total (et non (total-available)/total de psutil
    # qui inclut le cache/wired/inactive sur macOS et donne des valeurs trop élevées)
    percent = round((mem.used / mem.total) * 100, 1) if mem.total > 0 else 0
    return {
        "total_gb": total_gb,
        "used_gb": used_gb,
        "available_gb": round(mem.available / (1024 ** 3), 1),
        "percent": percent,
    }


def get_disk_info() -> dict:
    """
    Retourne les infos sur TOUS les disques physiques combinés.

    Somme les partitions physiques réelles (exclut les pseudo-fs
    comme tmpfs, devtmpfs, loop, snap, overlay, etc.)

    Exemple de retour:
    {
        "total_gb": 1382.0,
        "used_gb": 234.5,
        "free_gb": 1147.5,
        "percent": 17.0,
        "disks": [
            {"mount": "/", "total_gb": 914.0, "used_gb": 9.0, "free_gb": 867.0},
            {"mount": "/mnt/ssd", "total_gb": 469.0, "used_gb": 0.0, "free_gb": 445.0}
        ]
    }
    """
    # Pseudo-filesystems à exclure
    _EXCLUDED_FS = {'tmpfs', 'devtmpfs', 'squashfs', 'overlay', 'devfs',
                    'iso9660', 'udf', 'hugetlbfs', 'mqueue', 'proc',
                    'sysfs', 'cgroup', 'cgroup2', 'autofs', 'fusectl',
                    'securityfs', 'pstore', 'debugfs', 'tracefs',
                    'configfs', 'binfmt_misc', 'efivarfs', 'fuse.snapfuse'}

    seen_devices = set()
    total_bytes = 0
    used_bytes = 0
    free_bytes = 0
    disks_list = []

    for part in psutil.disk_partitions(all=False):
        # Exclure les pseudo-fs et les snaps
        if part.fstype in _EXCLUDED_FS:
            continue
        if '/snap/' in part.mountpoint or '/loop' in part.device:
            continue
        # Éviter les doublons de device (bind mounts)
        if part.device in seen_devices:
            continue
        seen_devices.add(part.device)

        try:
            usage = psutil.disk_usage(part.mountpoint)
            total_bytes += usage.total
            used_bytes += usage.used
            free_bytes += usage.free
            disks_list.append({
                "mount": part.mountpoint,
                "total_gb": round(usage.total / (1024 ** 3), 1),
                "used_gb": round(usage.used / (1024 ** 3), 1),
                "free_gb": round(usage.free / (1024 ** 3), 1),
            })
        except (PermissionError, OSError):
            continue

    # Fallback si rien trouvé
    if not disks_list:
        disk = psutil.disk_usage("/")
        total_bytes = disk.total
        used_bytes = disk.used
        free_bytes = disk.free
        disks_list = [{"mount": "/",
                       "total_gb": round(disk.total / (1024 ** 3), 1),
                       "used_gb": round(disk.used / (1024 ** 3), 1),
                       "free_gb": round(disk.free / (1024 ** 3), 1)}]

    total_gb = round(total_bytes / (1024 ** 3), 1)
    used_gb = round(used_bytes / (1024 ** 3), 1)
    free_gb = round(free_bytes / (1024 ** 3), 1)
    percent = round((used_bytes / total_bytes) * 100, 1) if total_bytes > 0 else 0

    return {
        "total_gb": total_gb,
        "used_gb": used_gb,
        "free_gb": free_gb,
        "percent": percent,
        "disks": disks_list,
    }


def get_temperature() -> dict:
    """
    Retourne la température du CPU (si le capteur est disponible).
    Essaie plusieurs méthodes selon l'OS :
    1. psutil.sensors_temperatures() (Linux)
    2. /sys/class/thermal (Linux fallback)
    3. osx-cpu-temp (macOS, via Homebrew)
    """
    import subprocess
    import os

    # Méthode 1 : psutil (fonctionne surtout sur Linux)
    try:
        temps = psutil.sensors_temperatures()
        if temps:
            for name, entries in temps.items():
                if entries:
                    return {
                        "cpu_temp": round(entries[0].current, 1),
                        "available": True,
                    }
    except (AttributeError, Exception):
        pass

    # Méthode 2 : Linux thermal zones
    thermal_path = "/sys/class/thermal/thermal_zone0/temp"
    if os.path.exists(thermal_path):
        try:
            with open(thermal_path) as f:
                temp = int(f.read().strip()) / 1000
                return {"cpu_temp": round(temp, 1), "available": True}
        except Exception:
            pass

    # Méthode 3 : macOS via osx-cpu-temp (brew install osx-cpu-temp)
    if platform.system() == "Darwin":
        try:
            result = subprocess.run(
                ["osx-cpu-temp"], capture_output=True, text=True, timeout=3
            )
            if result.returncode == 0 and result.stdout:
                temp_str = result.stdout.strip().replace("°C", "").strip()
                return {"cpu_temp": round(float(temp_str), 1), "available": True}
        except (FileNotFoundError, subprocess.TimeoutExpired, ValueError):
            pass

    return {"cpu_temp": 0, "available": False}


def get_network_info() -> dict:
    """
    Retourne les infos réseau (bytes envoyés/reçus depuis le démarrage).

    Exemple de retour:
    {
        "bytes_sent_mb": 1234.5,
        "bytes_recv_mb": 5678.9
    }
    """
    net = psutil.net_io_counters()
    return {
        "bytes_sent_mb": round(net.bytes_sent / (1024 ** 2), 1),
        "bytes_recv_mb": round(net.bytes_recv / (1024 ** 2), 1),
    }


def get_system_info() -> dict:
    """
    Retourne les infos générales sur le système.
    Appelé une seule fois au chargement du dashboard (pas en boucle).
    """
    boot_time = datetime.fromtimestamp(psutil.boot_time())
    uptime = datetime.now() - boot_time

    return {
        "hostname": platform.node(),
        "os": f"{platform.system()} {platform.release()}",
        "python_version": platform.python_version(),
        "boot_time": boot_time.isoformat(),
        "uptime_hours": round(uptime.total_seconds() / 3600, 1),
    }


def get_all_stats() -> dict:
    """
    Retourne TOUTES les stats en un seul appel.
    C'est cette fonction que le frontend appelle toutes les 2 secondes.
    """
    return {
        "cpu": get_cpu_info(),
        "memory": get_memory_info(),
        "disk": get_disk_info(),
        "temperature": get_temperature(),
        "network": get_network_info(),
        "timestamp": datetime.now().isoformat(),
    }
