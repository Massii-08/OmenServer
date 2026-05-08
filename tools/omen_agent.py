#!/usr/bin/env python3
"""
OmenServer Agent — Script de monitoring à installer sur chaque PC.

Ce script envoie les statistiques système (CPU, RAM, Disque, Température)
à OmenServer toutes les 10 secondes.

=== INSTALLATION ===

1. Installer les dépendances :
   pip install psutil requests

2. Configurer les variables ci-dessous :
   - SERVER_URL : l'adresse de ton OmenServer
   - API_KEY    : la clé API visible dans Paramètres > Ordinateurs

3. Lancer l'agent :
   python3 omen_agent.py

4. Pour lancer au démarrage du PC (Linux) :
   Créer un service systemd — voir le fichier omen-agent.service

=== CONFIGURATION ===
"""

import os
import subprocess
import time
import platform
import socket
from datetime import datetime

# ============================
# 🔧 CONFIGURATION — À MODIFIER
# ============================
SERVER_URL = "http://ADRESSE_OMENSERVER:8000"   # ex: http://192.168.1.100:8000
API_KEY = "COLLE_TA_CLE_ICI"                    # Visible dans OmenServer > Paramètres
INTERVAL = 10                                    # Secondes entre chaque envoi
# ============================

try:
    import psutil
except ImportError:
    print("❌ psutil non installé. Lance : pip install psutil")
    exit(1)

try:
    import requests
except ImportError:
    print("❌ requests non installé. Lance : pip install requests")
    exit(1)


def get_stats() -> dict:
    """Collecte toutes les stats système."""
    # CPU
    cpu_percent = psutil.cpu_percent(interval=0.5)
    cpu_count = psutil.cpu_count()

    # RAM
    mem = psutil.virtual_memory()
    ram_total = round(mem.total / (1024 ** 3), 1)
    ram_used = round(mem.used / (1024 ** 3), 1)
    ram_percent = round((mem.used / mem.total) * 100, 1) if mem.total > 0 else 0

    # Disque
    disk = psutil.disk_usage("/")
    disk_total = round(disk.total / (1024 ** 3), 1)
    disk_used = round(disk.used / (1024 ** 3), 1)
    disk_percent = round((disk.used / disk.total) * 100, 1) if disk.total > 0 else 0

    # Température
    temperature = None
    try:
        temps = psutil.sensors_temperatures()
        if temps:
            for name, entries in temps.items():
                if entries:
                    temperature = round(entries[0].current, 1)
                    break
    except Exception:
        pass

    # Si pas de température via psutil, essayer /sys/class/thermal (Linux)
    if temperature is None:
        try:
            with open("/sys/class/thermal/thermal_zone0/temp") as f:
                temperature = round(int(f.read().strip()) / 1000, 1)
        except Exception:
            pass

    # Uptime
    boot_time = datetime.fromtimestamp(psutil.boot_time())
    uptime_hours = round((datetime.now() - boot_time).total_seconds() / 3600, 1)

    # OS
    os_info = f"{platform.system()} {platform.release()}"

    return {
        "hostname": socket.gethostname(),
        "os": os_info,
        "cpu_percent": cpu_percent,
        "cpu_count": cpu_count,
        "ram_total_gb": ram_total,
        "ram_used_gb": ram_used,
        "ram_percent": ram_percent,
        "disk_total_gb": disk_total,
        "disk_used_gb": disk_used,
        "disk_percent": disk_percent,
        "temperature": temperature,
        "uptime_hours": uptime_hours,
    }


def send_heartbeat(stats: dict):
    """Envoie les stats au serveur OmenServer. Retourne les commandes reçues."""
    try:
        r = requests.post(
            f"{SERVER_URL}/api/nodes/heartbeat",
            json=stats,
            headers={"X-Agent-Key": API_KEY},
            timeout=5,
        )
        if r.status_code == 200:
            return r.json()
        return None
    except requests.exceptions.ConnectionError:
        return None
    except Exception as e:
        print(f"⚠️  Erreur: {e}")
        return None


def execute_commands(commands: list):
    """
    Exécute les commandes reçues du serveur OmenServer.
    Commandes supportées : reboot, shutdown
    Sécurité : whitelist stricte, subprocess.run() au lieu de os.system(),
    et logging persistant de chaque commande exécutée.
    """
    import subprocess
    import logging

    # Logger persistant pour traçabilité
    log_file = os.path.join(os.path.dirname(os.path.abspath(__file__)), "agent_commands.log")
    logging.basicConfig(
        filename=log_file,
        level=logging.INFO,
        format="%(asctime)s | %(message)s",
    )

    ALLOWED_COMMANDS = {"reboot", "shutdown"}

    for cmd in commands:
        action = cmd.get("command", "")
        print(f"📩 Commande reçue : {action}")

        if action not in ALLOWED_COMMANDS:
            msg = f"⚠️  Commande non autorisée ignorée : {action}"
            print(msg)
            logging.warning(msg)
            continue

        if action == "reboot":
            print("🔄 REDÉMARRAGE demandé par OmenServer !")
            logging.info(f"REBOOT demandé — exécution dans 5 secondes")
            print("   Redémarrage dans 5 secondes...")
            time.sleep(5)
            if platform.system() == "Linux":
                subprocess.run(["sudo", "reboot"], check=False)
            elif platform.system() == "Windows":
                subprocess.run(
                    ["shutdown", "/r", "/t", "5", "/c", "Redémarrage demandé par OmenServer"],
                    check=False
                )

        elif action == "shutdown":
            print("⏻ EXTINCTION demandée par OmenServer !")
            logging.info(f"SHUTDOWN demandé — exécution dans 5 secondes")
            print("   Extinction dans 5 secondes...")
            time.sleep(5)
            if platform.system() == "Linux":
                subprocess.run(["sudo", "shutdown", "-h", "now"], check=False)
            elif platform.system() == "Windows":
                subprocess.run(
                    ["shutdown", "/s", "/t", "5", "/c", "Extinction demandée par OmenServer"],
                    check=False
                )


# === Boucle principale ===

if __name__ == "__main__":
    hostname = socket.gethostname()
    print(f"🖥️  OmenServer Agent — {hostname}")
    print(f"📡 Serveur: {SERVER_URL}")
    print(f"⏱️  Intervalle: {INTERVAL}s")
    print(f"{'='*40}")

    consecutive_errors = 0

    while True:
        try:
            stats = get_stats()
            result = send_heartbeat(stats)

            if result:
                if consecutive_errors > 0:
                    print(f"✅ Reconnecté au serveur !")
                consecutive_errors = 0
                print(
                    f"📡 [{datetime.now().strftime('%H:%M:%S')}] "
                    f"CPU {stats['cpu_percent']}% | "
                    f"RAM {stats['ram_used_gb']}/{stats['ram_total_gb']}Go ({stats['ram_percent']}%) | "
                    f"Disk {stats['disk_percent']}%"
                    f"{f' | 🌡️{stats[\"temperature\"]}°C' if stats['temperature'] else ''}"
                )

                # Exécuter les commandes reçues du serveur
                commands = result.get("commands", [])
                if commands:
                    execute_commands(commands)
            else:
                consecutive_errors += 1
                if consecutive_errors <= 3 or consecutive_errors % 30 == 0:
                    print(f"⚠️  [{datetime.now().strftime('%H:%M:%S')}] Serveur injoignable ({consecutive_errors}x)")

        except KeyboardInterrupt:
            print("\n👋 Agent arrêté.")
            break
        except Exception as e:
            print(f"❌ Erreur: {e}")

        time.sleep(INTERVAL)
