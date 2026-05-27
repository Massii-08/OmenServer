"""
Diagnostic Agent — version intégrée au hub OmenServer.

Différences vs la version standalone (`bot problème/agent/`) :
  - Le `client_id` n'est plus arbitraire ; c'est le USERNAME OmenServer (= sub du JWT)
  - L'URL WS pointe sur `/ws/sysdoc/agent/{username}` (renommé pour éviter le conflit
    avec backend/monitoring/diagnostic_router.py)
  - Le SECRET_KEY DOIT matcher backend/config.py côté hub (sinon JWT invalide)
  - Le token a une expiration (cohérent avec ACCESS_TOKEN_EXPIRE_MINUTES = 24h)

Config via variables d'environnement :
  OMEN_AGENT_USERNAME  → username OmenServer (ex: "massii_08")
  OMEN_HUB_URL         → ws://localhost:8000/ws/sysdoc  ou  wss://omenserver.org/ws/sysdoc
  OMEN_JWT_SECRET      → SAME secret as hub (copy from backend/config.py SECRET_KEY)
"""

import asyncio
import websockets
import json
import jwt
import os
import sys
import time

from modules.ram_detective import analyze_ram
from modules.process_manager import get_suspensible_processes, suspend_process, resume_process, bulk_suspend
from modules.actions import list_actions, run_action

def _load_local_dotenv():
    """
    Charge un fichier .env situé à côté de main.py s'il existe.
    Pratique sur Windows : pas besoin de set des env vars système permanents,
    juste un fichier `.env` à côté de l'exécutable.
    """
    from pathlib import Path
    env_file = Path(__file__).resolve().parent / ".env"
    if not env_file.exists():
        return
    try:
        for line in env_file.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, value = line.partition("=")
            key = key.strip()
            value = value.strip().strip('"').strip("'")
            # Ne pas écraser une env var déjà définie explicitement (priorité shell)
            if key and key not in os.environ:
                os.environ[key] = value
        print(f"[Agent] Config chargée depuis {env_file}")
    except Exception as e:
        print(f"[Agent] Lecture {env_file} échouée : {e}")


# Charge .env LOCAL avant de lire les env vars (cf. setup_windows.bat)
_load_local_dotenv()

# Configuration
USERNAME = os.environ.get("OMEN_AGENT_USERNAME") or os.environ.get("OMEN_AGENT_ID", "pc-test-1")
# Base de l'URL WS (sans le segment "agent/viewer" ni l'username).
# L'agent connecte sur /ws/sysdoc/agent/{username}.
SERVER_URL = os.environ.get("OMEN_HUB_URL", "ws://localhost:8000/ws/sysdoc")
JWT_SECRET = os.environ.get("OMEN_JWT_SECRET", "")


def _load_secret_from_hub_env() -> str:
    """
    En dev local, l'agent tourne dans tools/diagnostic_agent/ — donc le `.env`
    du hub est à `../../.env`. Si OMEN_JWT_SECRET n'est pas défini explicitement,
    on tente de le charger depuis ce fichier. En prod (agent installé sur un autre
    PC), OMEN_JWT_SECRET DOIT être passé en env var et ce fallback ne match pas.
    """
    from pathlib import Path
    candidates = [
        Path(__file__).resolve().parent.parent.parent / ".env",  # tools/diagnostic_agent/../../.env
        Path.home() / "omenserver" / ".env",                     # install prod possible
    ]
    for p in candidates:
        if not p.exists():
            continue
        try:
            for line in p.read_text(encoding="utf-8").splitlines():
                line = line.strip()
                if line.startswith("SECRET_KEY="):
                    val = line.split("=", 1)[1].strip().strip('"').strip("'")
                    print(f"[Agent] SECRET_KEY chargé depuis {p}")
                    return val
        except Exception as e:
            print(f"[Agent] Lecture {p} échouée : {e}")
    return ""


if not JWT_SECRET:
    JWT_SECRET = _load_secret_from_hub_env()
if not JWT_SECRET:
    print("[Agent] WARN — pas de OMEN_JWT_SECRET défini et .env hub introuvable. "
          "Le JWT sera invalide.")
    JWT_SECRET = "super-secret-key-for-dev"

# Renommée pour cohérence interne, l'ancien nom existe encore pour rétrocompat
CLIENT_ID = USERNAME


def generate_agent_token():
    """
    Génère un JWT compatible avec OmenServer (sub=username, exp=+24h, HS256).
    Le hub décode via `python-jose` mais PyJWT et python-jose sont interoperables.
    """
    payload = {
        "sub": USERNAME,
        "exp": int(time.time()) + 24 * 3600,  # 24h d'expiration
    }
    return jwt.encode(payload, JWT_SECRET, algorithm="HS256")

async def send_metrics_loop(websocket):
    """
    Boucle infinie qui envoie les métriques de RAM et la liste des processus réguliérement.
    """
    while True:
        try:
            ram_stats = analyze_ram()
            
            # Calcul de l'"Indice de Souffrance Système"
            # Formule arbitraire pour simplifier l'UX: basé sur l'usage global RAM et RAM fantôme
            suffering_index = min(100, int((ram_stats["percent_used"] * 0.7) + ((ram_stats["phantom_ram_mb"] / (ram_stats["total_ram_mb"] + 1)) * 100 * 0.3)))
            
            payload = {
                "type": "metrics",
                "data": {
                    "ram": ram_stats,
                    "suffering_index": suffering_index,
                    # On n'envoie pas les process à chaque fois pour économiser la BP,
                    # à moins de le faire sur demande. Ici on l'envoie pour simplifier la V1.
                    "processes": get_suspensible_processes()
                }
            }
            await websocket.send(json.dumps(payload))
            await asyncio.sleep(5) # Envoi toutes les 5 secondes
        except websockets.exceptions.ConnectionClosed:
            break
        except Exception as e:
            print(f"[Agent] Erreur metrics_loop: {e}")
            await asyncio.sleep(5)

async def listen_commands_loop(websocket):
    """
    Écoute les commandes du Hub (Dashboard).

    Commandes supportées :
      - SUSPEND_PROCESS / RESUME_PROCESS  → gel/reprise d'un PID
      - LIST_ACTIONS                       → renvoie le catalogue d'actions 3 tiers
      - RUN_ACTION { action_id, payload }  → exécute une action safe/moderate (risky refusée)
    """
    try:
        async for message in websocket:
            try:
                data = json.loads(message)
                command = data.get("command")
                payload = data.get("payload", {}) or {}

                if command == "SUSPEND_PROCESS":
                    pid = payload.get("pid")
                    if pid:
                        result = suspend_process(pid)
                        await websocket.send(json.dumps({"type": "command_result", "result": result}))

                elif command == "RESUME_PROCESS":
                    pid = payload.get("pid")
                    if pid:
                        result = resume_process(pid)
                        await websocket.send(json.dumps({"type": "command_result", "result": result}))

                elif command == "BULK_SUSPEND":
                    pids = payload.get("pids") or []
                    result = bulk_suspend(pids)
                    await websocket.send(json.dumps({"type": "command_result", "result": result}))

                elif command == "LIST_ACTIONS":
                    catalog = list_actions()
                    await websocket.send(json.dumps({
                        "type": "actions_catalog",
                        "data": {"actions": catalog},
                    }))

                elif command == "RUN_ACTION":
                    action_id = payload.get("action_id")
                    action_payload = payload.get("payload") or {}
                    if not action_id:
                        await websocket.send(json.dumps({
                            "type": "action_result",
                            "result": {"status": "error", "message": "action_id manquant"},
                        }))
                    else:
                        result = run_action(action_id, action_payload)
                        await websocket.send(json.dumps({
                            "type": "action_result",
                            "data": {"action_id": action_id},
                            "result": result,
                        }))

                else:
                    print(f"[Agent] Commande inconnue : {command}")

            except json.JSONDecodeError:
                print("[Agent] Reçu un message non-JSON")
    except websockets.exceptions.ConnectionClosed:
        print("[Agent] Connexion WebSocket fermée par le serveur.")

async def main():
    token = generate_agent_token()
    # On cible explicitement le rôle "agent" pour ne pas se mélanger avec le viewer.
    url = f"{SERVER_URL}/agent/{USERNAME}?token={token}"

    print(f"[Agent] Connexion à {SERVER_URL}/agent/{USERNAME} en tant que {USERNAME}...")

    # Floor de 1s entre 2 tentatives de connexion — empêche les reconnect storms quand
    # `listen_commands_loop` exit normalement (le `async with` referme la WS proprement
    # SANS lever d'exception → on tomberait dans une reconnexion immédiate sans ça).
    MIN_BACKOFF = 1.0
    while True:
        cycle_start = asyncio.get_event_loop().time()
        try:
            async with websockets.connect(url) as websocket:
                print("[Agent] Connecté au Hub avec succès.")
                # On lance les deux boucles en parallèle
                metrics_task = asyncio.create_task(send_metrics_loop(websocket))
                commands_task = asyncio.create_task(listen_commands_loop(websocket))

                done, pending = await asyncio.wait(
                    {metrics_task, commands_task},
                    return_when=asyncio.FIRST_COMPLETED,
                )

                for task in pending:
                    task.cancel()
                    try:
                        await task
                    except (asyncio.CancelledError, Exception):
                        pass

        except ConnectionRefusedError:
            print("[Agent] Le serveur est inaccessible. Nouvelle tentative dans 5 secondes...")
            await asyncio.sleep(5)
            continue
        except websockets.exceptions.ConnectionClosedOK:
            print("[Agent] Connexion fermée proprement par le serveur.")
        except websockets.exceptions.ConnectionClosedError as e:
            print(f"[Agent] Connexion perdue (erreur: {e}).")
        except Exception as e:
            print(f"[Agent] Erreur inattendue: {e.__class__.__name__}: {e}")

        # Backoff garanti : si le cycle a duré moins que MIN_BACKOFF, on attend la
        # différence. Sinon (cycle long), on reconnecte tout de suite.
        elapsed = asyncio.get_event_loop().time() - cycle_start
        if elapsed < MIN_BACKOFF:
            await asyncio.sleep(MIN_BACKOFF - elapsed)

if __name__ == "__main__":
    try:
        # Configuration "headless" pour Windows (si on le lance via pythonw.exe)
        # Rediriger stdout/stderr vers un fichier de log si besoin.
        asyncio.run(main())
    except KeyboardInterrupt:
        print("[Agent] Arrêt demandé par l'utilisateur.")
        sys.exit(0)
