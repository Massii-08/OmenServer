"""
Gestionnaire de sessions MC Agent.

Spawn le process Node (mc-agent/index.js) en subprocess détaché, lit son stdout
ligne-par-ligne (events JSON), maintient un registre de sessions en mémoire, et
permet de piloter chaque session (stop, say). Pattern miroir de Yield/Scanner.
"""
import json
import os
import re
import signal
import subprocess
import threading
import time
from datetime import datetime, timezone
from pathlib import Path

from . import mc_agent_world_memory as world_memory
from . import mc_agent_servers as servers_store
from . import mc_agent_secrets

# backend/bots/mc_agent_manager.py → racine projet = parents[2], puis mc-agent/
_PROJECT_ROOT = Path(__file__).resolve().parents[2]
MC_AGENT_DIR = _PROJECT_ROOT / "mc-agent"
# Fichiers temp de whitelist de commandes par session (dossier propre au bot, PAS data/servers/).
RUNS_DIR = _PROJECT_ROOT / "data" / "mc_agent_runs"
# Captures REC distillées (mc_capture_distill.py) : data/mc-captures-distilled/<joueur>/{style.json, clips/}.
# Si un groupe a `clone_player`, _spawn_bot passe --style/--clips → le bot rejoue la motricité humaine réelle.
DISTILLED_DIR = _PROJECT_ROOT / "data" / "mc-captures-distilled"
# Clé Claude posée depuis le dashboard (gitignored, chmod 600). La var d'env prime.
API_KEY_PATH = _PROJECT_ROOT / "data" / "secrets" / "anthropic.key"

_sessions = {}        # session_id (int) -> dict
_lock = threading.Lock()
_counter = 0

# Mémoire de monde partagée par groupe (server_id) : cache en mémoire + verrou (un seul écrivain,
# le process backend). Les events bot biome_seen/cave_found/material_found + exposed_ore_found/
# ore_mined/ore_gone (minerais notés par un cartographe, retirés quand minés/disparus) y sont routés.
_WM_EVENTS = ("biome_seen", "cave_found", "material_found", "exposed_ore_found", "ores_found", "ore_mined", "ore_gone", "structure_found")
_wm_lock = threading.Lock()
_wm_cache = {}        # group_id -> memory dict


def _mask_key(key):
    """Masque une clé pour l'affichage (jamais révélée en clair)."""
    if not key or len(key) < 12:
        return "***"
    return f"{key[:8]}…{key[-4:]}"


def _read_api_key():
    """Clé Claude effective : var d'env (prioritaire) sinon fichier secret, sinon ''."""
    env_key = os.environ.get("ANTHROPIC_API_KEY")
    if env_key:
        return env_key.strip()
    try:
        if API_KEY_PATH.is_file():
            return API_KEY_PATH.read_text(encoding="utf-8").strip()
    except OSError:
        pass
    return ""


def get_api_key_status():
    """État de la clé pour le dashboard (sans la révéler)."""
    if os.environ.get("ANTHROPIC_API_KEY"):
        return {"has_key": True, "preview": _mask_key(_read_api_key()), "source": "env_var"}
    key = _read_api_key()
    if key:
        return {"has_key": True, "preview": _mask_key(key), "source": "file"}
    return {"has_key": False, "preview": None, "source": None}


def set_api_key(key):
    """Écrit la clé Claude dans le fichier secret (chmod 600). Retourne le preview masqué."""
    key = (key or "").strip()
    API_KEY_PATH.parent.mkdir(parents=True, exist_ok=True)
    API_KEY_PATH.write_text(key, encoding="utf-8")
    API_KEY_PATH.chmod(0o600)
    return _mask_key(key)


def clear_api_key():
    """Supprime le fichier de clé (la var d'env, si présente, reste prioritaire)."""
    try:
        API_KEY_PATH.unlink()
        return True
    except FileNotFoundError:
        return False


def parse_event_line(line):
    """Parse une ligne stdout du process Node. Retourne un dict event valide, sinon None."""
    line = (line or "").strip()
    if not line:
        return None
    try:
        obj = json.loads(line)
    except (ValueError, TypeError):
        return None
    if not isinstance(obj, dict) or "type" not in obj:
        return None
    return obj


def _now_iso():
    return datetime.now(timezone.utc).isoformat()


def _record_world_memory(group_id, event):
    """Route un event de trouvaille (biome/cave/material) vers le store du groupe, sous verrou.

    Cache en mémoire par groupe → évite de relire le fichier à chaque event ; persistance au fil de
    l'eau (save par event, débit faible) pour que la carte survive à la mort d'un bot."""
    if not group_id:
        return
    with _wm_lock:
        mem = _wm_cache.get(group_id)
        if mem is None:
            mem = world_memory.load(group_id)
            _wm_cache[group_id] = mem
        world_memory.apply_event(mem, event, at=_now_iso())
        world_memory.save(group_id, mem)


def _apply_event(session, event):
    """Met à jour l'état d'une session selon l'event reçu."""
    etype = event.get("type")
    if etype == "status":
        session["status"] = event.get("state", session["status"])
    elif etype in ("chat", "say", "msa"):
        # msa = code device-login Microsoft → visible dans le transcript
        session["transcript"].append(event)
        session["transcript"] = session["transcript"][-200:]
    elif etype == "error":
        session["last_error"] = event.get("message")
    elif etype == "quota_progress":
        session["quota"] = event.get("counts")        # barres de progression dashboard
    elif etype == "quota_done":
        session["quota_done"] = True
    session["events"].append(event)
    session["events"] = session["events"][-500:]
    # mémoire de monde partagée : route les trouvailles vers le store du groupe (server_id)
    if etype in _WM_EVENTS and session.get("server_id"):
        _record_world_memory(session["server_id"], event)


def _cleanup_session_files(session):
    """Supprime les fichiers temp de la session (dont login-<sid>.txt = secret en clair).

    Appelé par stop_session ET en fin de pompe (mort naturelle : crash/kick/déco) —
    sinon les fichiers login chmod 600 s'accumulent dans RUNS_DIR (finding revue)."""
    for key in ("cmds_path", "policy_path", "world_path", "wm_path", "quota_path", "login_path"):
        p = session.get(key)
        if p:
            try:
                os.unlink(p)
            except OSError:
                pass


def _pump(session, stream):
    """Boucle de lecture du stdout du process : applique chaque event jusqu'à la fin du flux."""
    for line in stream:
        event = parse_event_line(line)
        if event:
            _apply_event(session, event)
    session["status"] = "stopped"
    # mort naturelle (crash/kick, pas via stop_session) : nettoyer les fichiers temp ici aussi
    _cleanup_session_files(session)
    # un cartographe mort → les survivants se re-partagent le cercle
    if session.get("objective") == "mapper":
        try:
            _rebalance_sectors(session.get("server_id"))
        except Exception:  # noqa: BLE001 — thread de pompe : ne jamais le laisser crasher
            pass
    # Self-healing (phase 2) : session RESOURCE morte naturellement (kick « Timed out »,
    # watchdog, crash) → respawn auto après 15 s (l'inventaire persiste → quota préservé).
    # Jamais si l'utilisateur a stoppé (user_stopped) ; cap 12 respawns (anti-boucle folle).
    rs = session.get("respawn")
    # Garde CRASH-ON-SPAWN : une session qui meurt < 15 s après son spawn, 3 fois d'affilée,
    # est ABANDONNÉE — le cap global (12) ne couvrait pas ce mode : join→crash 4 s→respawn 15 s
    # à l'infini (vécu phase 2, V2Res1 : kit cassé → starved-exit immédiat en boucle).
    lifetime = time.time() - session.get("spawned_at", 0)
    # Un kick « Connection throttled » est un refus AVANT spawn (collision de joins), pas un
    # crash du bot : il ne compte pas pour la garde crash-on-spawn (sinon 3 collisions = abandon).
    _err = str(session.get("last_error") or "").lower()
    _throttled = "throttled" in _err
    fast_fails = 0 if _throttled else ((session.get("fast_fail_count", 0) + 1) if lifetime < 15 else 0)
    if (rs and session.get("objective") in ("resource", "mapper")
            and not session.get("user_stopped")
            and session.get("respawn_count", 0) < 12):
        if fast_fails >= 3:
            session["events"].append({"type": "respawn_given_up", "why": "crash_on_spawn",
                                      "fast_fails": fast_fails})
            return
        def _do_respawn():
            try:
                new_sid = start_for_bot(rs["group_id"], rs["bot_id"], model=rs.get("model"),
                                        autonomous=rs.get("autonomous", True),
                                        objective=rs.get("objective", "resource"),
                                        world_label=rs.get("world_label"), quota=rs.get("quota"),
                                        humanize=rs.get("humanize", False), confine=rs.get("confine"))
                ns = _sessions.get(new_sid)
                if ns is not None:
                    ns["respawn_count"] = session.get("respawn_count", 0) + 1
                    ns["fast_fail_count"] = fast_fails
                if rs.get("objective") == "mapper":
                    _rebalance_sectors(rs["group_id"])  # le revenant reprend un secteur cohérent
            except Exception:  # noqa: BLE001 — best-effort (compte déjà en ligne, groupe parti…)
                pass
        # Jitter anti-synchronisation : des morts simultanées ne re-spawnent plus en phase.
        timer = threading.Timer(15.0 + (hash(str(session.get("user"))) % 80) / 10.0, _do_respawn)
        timer.daemon = True
        timer.start()


def _node_bin():
    """Binaire node : surchargeable via MC_AGENT_NODE_BIN (PATH systemd ≠ PATH shell)."""
    return os.environ.get("MC_AGENT_NODE_BIN", "node")


def _provider():
    """Provider LLM sélectionné (env MC_AGENT_LLM) : 'gemini' (gratuit) ou 'anthropic' (défaut)."""
    return (os.environ.get("MC_AGENT_LLM") or "anthropic").lower()


def has_api_key():
    """True si la clé du provider LLM sélectionné est dispo.

    - gemini    → GEMINI_API_KEY dans l'environnement (héritée du .env via load_dotenv)
    - groq      → GROQ_API_KEY dans l'environnement
    - anthropic → ANTHROPIC_API_KEY (var d'env) OU fichier secret posé via le dashboard
    """
    prov = _provider()
    if prov == "gemini":
        return bool(os.environ.get("GEMINI_API_KEY"))
    if prov == "groq":
        return bool(os.environ.get("GROQ_API_KEY"))
    return bool(_read_api_key())


VALID_OBJECTIVES = ("stone_pickaxe", "iron_pickaxe", "diamond", "mapper", "resource")

# Délai entre deux spawns d'un batch de cartographes : Paper throttle les connexions rapprochées
# depuis la même IP (connection-throttle 4000ms par défaut) → sans étalement, ECONNRESET.
MAPPER_SPAWN_STAGGER_S = 4.5

# Sérialiseur GLOBAL de spawns (phase 3) : Paper throttle les joins <4 s depuis la même IP
# (tous nos bots = localhost). Des morts SIMULTANÉES (freeze serveur → kicks en masse)
# re-spawnaient toutes à t+15 s → re-collision à chaque cycle → 3 « Connection throttled »
# = respawn_given_up (vécu V3Res3 : chaîne 7→10→14 toutes throttled → bot à terre).
SPAWN_MIN_INTERVAL_S = 6.0
_spawn_gate = threading.Lock()
_last_spawn_at = [0.0]


def _spawn_gate_wait():
    """Attend que le créneau de join soit libre (≥ SPAWN_MIN_INTERVAL_S depuis le dernier)."""
    with _spawn_gate:
        wait = _last_spawn_at[0] + SPAWN_MIN_INTERVAL_S - time.time()
        if wait > 0:
            time.sleep(wait)
        _last_spawn_at[0] = time.time()


def _active_mappers(group_id):
    """Sessions cartographe VIVANTES d'un groupe, triées par id (ordre de lancement stable)."""
    if not group_id:
        return []
    return sorted(
        (s for s in list(_sessions.values())
         if s.get("server_id") == group_id and s.get("objective") == "mapper"
         and s.get("proc") and s["proc"].poll() is None),
        key=lambda s: s["id"],
    )


def _rebalance_sectors(group_id):
    """Re-pousse les secteurs (360/N + recouvrement, calcul côté Node) aux mappers actifs du groupe.

    Appelé quand N change (lancement/arrêt d'un mapper) : chaque bot reçoit {'type':'sector',index,count}
    sur stdin → effet au prochain batch de waypoints (pas de redémarrage)."""
    mappers = _active_mappers(group_id)
    n = len(mappers)
    for i, s in enumerate(mappers):
        send_command(s["id"], {"type": "sector", "index": i, "count": n})


def _spawn_bot(host, port, user, model=None, auth="offline", profile=None, commands=None,
               policy=None, server_id=None, language="fr", autonomous=False,
               objective="stone_pickaxe", world_label=None, login_command=None,
               sector_index=None, sector_count=None, quota=None, stealth=False, humanize=False,
               confine=None):
    """Spawn le process Node détaché et enregistre la session. Retourne son id.

    Point monkeypatchable des lancements par roster (start_for_bot/start_mappers).

    `commands` : liste d'objets {cmd,syntax,desc} (whitelist serveur). Écrite dans un fichier
    temp passé au bot via --commands (le bot ne tapera que ces commandes).
    `autonomous` : si True, seed un world.json avec `objective` (pioche pierre OU pioche fer) +
    passe --world → le bot lance la boucle planner dès le spawn (reprise-au-spawn, 0 token LLM).
    `objective` : 'stone_pickaxe' (défaut) | 'iron_pickaxe' | 'diamond' | 'mapper' | 'resource' — sélectionne la chaîne/boucle côté Node.
    `login_command` : commande de login résolue (ex. '/login monMdp') si le serveur a un login.
    Écrite dans un fichier temp chmod 600 et passée via --login-command <path> → le secret ne
    transite JAMAIS par l'argv ni par un event/log/exception (cf. piège secrets).
    `sector_index`/`sector_count` : si fournis (mapper batch), priment sur le calcul auto du secteur.
    Le mot de passe AuthMe (serveur sans login serveur dédié) est géré côté Node (self-persist dans
    data/mc_agent_secret_<user>.json, chmod 600) — pas besoin de --authpw ici (et surtout PAS dans
    mc_agent_servers.json, exposé par l'API).
    """
    if objective not in VALID_OBJECTIVES:
        objective = "stone_pickaxe"
    global _counter
    with _lock:
        _counter += 1
        sid = _counter
    cmd = [_node_bin(), str(MC_AGENT_DIR / "index.js"),
           "--host", str(host), "--port", str(port), "--user", str(user),
           "--auth", str(auth or "offline")]
    if model:
        cmd += ["--model", str(model)]
    if profile:
        cmd += ["--profile", str(profile)]
    if language:
        cmd += ["--lang", str(language)]
    if stealth:
        # Mode furtif (phase 3) : humanisation (latence chat, loiter, jitter) — off par défaut.
        cmd += ["--stealth", "1"]
    if humanize and not stealth:
        # Humanisation ciblée (spec cartographes) : déplacements naturels + latence de réponse
        # + stop-pour-répondre, SANS le loiter. STEALTH l'implique déjà côté bot.
        cmd += ["--humanize", "1"]
    # Capture-clone : si le profil serveur a `clone_player` ET que ses captures REC sont distillées
    # (DISTILLED_DIR/<joueur>/{style.json,clips/}), passe --style/--clips → le bot rejoue la motricité
    # HUMAINE réelle (swing anti-snap, wobble de visée, latence de réaction). Best-effort + rétro-compat
    # strict : pas de groupe / pas de clone_player / pas de distillation → AUCUN flag → comportement
    # EXACTEMENT inchangé. Le respawn (start_for_bot, même server_id) re-résout → clone préservé gratis.
    if server_id:
        try:
            _grp = servers_store.get_server(server_id) or {}
            _player = _grp.get("clone_player")
        except Exception:  # noqa: BLE001 — lecture du groupe best-effort, jamais bloquante au spawn
            _player = None
        if _player:
            # Assainit le nom (anti path-traversal) : charset pseudo MC + underscore (_all). Les '/'
            # et '.' sont retirés → '..' impossible → aucune évasion de DISTILLED_DIR.
            _safe = re.sub(r"[^A-Za-z0-9_]", "", str(_player))
            if _safe:
                _style_p = DISTILLED_DIR / _safe / "style.json"
                _clips_p = DISTILLED_DIR / _safe / "clips"
                if _style_p.is_file():
                    cmd += ["--style", str(_style_p)]
                if _clips_p.is_dir():
                    cmd += ["--clips", str(_clips_p)]
    cmds_path = None
    if commands:
        RUNS_DIR.mkdir(parents=True, exist_ok=True)
        cmds_path = RUNS_DIR / f"cmds-{sid}.json"
        cmds_path.write_text(json.dumps(commands), encoding="utf-8")
        cmd += ["--commands", str(cmds_path)]
    policy_path = None
    if policy:
        RUNS_DIR.mkdir(parents=True, exist_ok=True)
        policy_path = RUNS_DIR / f"policy-{sid}.json"
        policy_path.write_text(json.dumps(policy), encoding="utf-8")
        cmd += ["--policy", str(policy_path)]
    world_path = None
    if autonomous:
        RUNS_DIR.mkdir(parents=True, exist_ok=True)
        world_path = RUNS_DIR / f"world-{sid}.json"
        world_path.write_text(json.dumps({
            "home": None, "chests": [], "waypoints": [],
            "objective": {"type": objective, "status": "in_progress"},
        }), encoding="utf-8")
        cmd += ["--world", str(world_path)]
    # Bootstrap mémoire de monde : passe la mémoire courante du groupe au bot (il sait où chercher).
    #  - objectif `resource` : chemin LIVE du fichier du groupe (lecture seule + --wm-live → le bot
    #    re-lit pendant que les cartographes alimentent) + fichier de claims partagé du groupe
    #    (anti-collision entre bots ressources ; PAS nettoyé par session, TTL interne).
    #  - autres objectifs : SNAPSHOT worldmem-<sid>.json (comportement historique).
    wm_path = None
    if server_id and objective in ("resource", "mapper"):
        # resource ET mapper (phase 2 frontière) lisent la mémoire LIVE du groupe : les mappers
        # voient la couverture des autres en quasi-temps réel (frontières disjointes).
        world_memory.WORLD_MEMORY_DIR.mkdir(parents=True, exist_ok=True)
        live = world_memory.WORLD_MEMORY_DIR / f"{server_id}.json"
        cmd += ["--world-memory", str(live), "--wm-live", "1"]
        if objective == "resource":
            RUNS_DIR.mkdir(parents=True, exist_ok=True)
            cmd += ["--claims", str(RUNS_DIR / f"claims-{server_id}.json")]
        else:
            cmd += ["--frontier", "1"]          # exploration par frontière + warp + /locate
    elif server_id:
        RUNS_DIR.mkdir(parents=True, exist_ok=True)
        wm_path = RUNS_DIR / f"worldmem-{sid}.json"
        wm_path.write_text(json.dumps(world_memory.load(server_id)), encoding="utf-8")
        cmd += ["--world-memory", str(wm_path)]
    # Quota multi-matériaux (bots ressources) : sidecar quota-<sid>.json + --quota (nettoyé au stop).
    quota_path = None
    if quota:
        RUNS_DIR.mkdir(parents=True, exist_ok=True)
        quota_path = RUNS_DIR / f"quota-{sid}.json"
        quota_path.write_text(json.dumps(quota), encoding="utf-8")
        cmd += ["--quota", str(quota_path)]
    # Cumul bankē PERSISTÉ banked-<server>-<user>.json : keyé server+user (PAS par sid) → STABLE à travers
    # un respawn (start_for_bot ré-utilise server_id+user), une re-entrée de runResource (même process) ET
    # un deploy (relance même user). Sans ça le tracker quota repart à 0 à chaque re-création → la
    # progression bankée (coffres au sol) est oubliée = cause racine du plateau multi-nuits. Le bot le
    # seed au démarrage + le réécrit à chaque dépôt. NON nettoyé au stop/mort (durable comme la mémoire de
    # monde — purge MANUELLE de l'opérateur au swap de monde, sinon stale comme world_memory).
    banked_path = None
    if quota and server_id:
        RUNS_DIR.mkdir(parents=True, exist_ok=True)
        _safe_user = re.sub(r"[^A-Za-z0-9_.-]", "_", str(user)) or "bot"
        banked_path = RUNS_DIR / f"banked-{server_id}-{_safe_user}.json"
        cmd += ["--banked", str(banked_path)]
    if world_label:
        cmd += ["--world-label", str(world_label)]  # monde de minage (overworld-type séparé)
    if confine:
        cmd += ["--confine", str(confine)]  # arène : garder le bot dans R de l'ancre sèche (cf. confine.js)
    # Login serveur automatique : la commande résolue (avec le secret) est écrite dans un fichier
    # temp chmod 600 et passée via --login-command <path>. JAMAIS dans l'argv (anti-fuite).
    login_path = None
    if login_command:
        RUNS_DIR.mkdir(parents=True, exist_ok=True)
        login_path = RUNS_DIR / f"login-{sid}.txt"
        login_path.write_text(str(login_command), encoding="utf-8")
        os.chmod(login_path, 0o600)
        cmd += ["--login-command", str(login_path)]
    # Multi-cartographes (1c) : secteur assigné au lancement. Si fourni explicitement (mapper batch),
    # on respecte sector_index/sector_count ; sinon calcul auto (i = nb de mappers déjà actifs du groupe).
    # Re-balancé live pour TOUS via stdin (cf. _rebalance_sectors, appelé plus bas).
    if objective == "mapper" and autonomous:
        if sector_index is not None and sector_count is not None:
            cmd += ["--sector-index", str(sector_index), "--sector-count", str(sector_count)]
        else:
            k = len(_active_mappers(server_id))
            cmd += ["--sector-index", str(k), "--sector-count", str(k + 1)]
    env = dict(os.environ)
    api_key = _read_api_key()  # injecte la clé (fichier ou env) dans l'env du subprocess Node
    if api_key:
        env["ANTHROPIC_API_KEY"] = api_key
    _spawn_gate_wait()  # anti « Connection throttled » (joins espacés, cf. SPAWN_MIN_INTERVAL_S)
    proc = subprocess.Popen(
        cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        stdin=subprocess.PIPE,
        text=True,
        bufsize=1,
        cwd=str(MC_AGENT_DIR),
        env=env,
        start_new_session=True,  # détaché : survit à un reload uvicorn (cf. piège #30f)
    )
    session = {
        "id": sid, "proc": proc, "status": "starting",
        "transcript": [], "events": [], "last_error": None,
        "host": host, "user": user, "server_id": server_id,
        "objective": objective if autonomous else None,
        "cmds_path": str(cmds_path) if cmds_path else None,
        "policy_path": str(policy_path) if policy_path else None,
        "world_path": str(world_path) if world_path else None,
        "wm_path": str(wm_path) if wm_path else None,
        "quota_path": str(quota_path) if quota_path else None,
        # banked_path : tracé pour debug/observabilité mais VOLONTAIREMENT absent de _cleanup_session_files
        # (durable across stop/mort/respawn — purge manuelle au swap de monde, cf. _spawn_bot).
        "banked_path": str(banked_path) if banked_path else None,
        "spawned_at": time.time(),
        "login_path": str(login_path) if login_path else None,
    }
    _sessions[sid] = session
    t = threading.Thread(target=_pump, args=(session, proc.stdout), daemon=True)
    t.start()
    session["thread"] = t
    if objective == "mapper" and autonomous:
        _rebalance_sectors(server_id)  # les mappers déjà actifs resserrent leur wedge (N a changé)
    return sid


def start_session(host, port, user, model=None, auth="offline", profile=None, commands=None, policy=None, server_id=None, language="fr", autonomous=False, objective="stone_pickaxe", world_label=None, quota=None, stealth=False, humanize=True, confine=None):
    """Lancement manuel (path historique du router + compat tests). Délègue à `_spawn_bot`.

    `humanize` par DÉFAUT True (paquet 1 anti-tell, décision Massii 07/06) : un bot lancé
    manuellement partage le serveur avec de vrais joueurs → motricité/latence/réaction humaines
    + posture évasive (nie être un bot). Passer humanize=False pour un grind pur non observé.
    """
    return _spawn_bot(host, port, user, model=model, auth=auth, profile=profile,
                      commands=commands, policy=policy, server_id=server_id, language=language,
                      autonomous=autonomous, objective=objective, world_label=world_label,
                      quota=quota, stealth=stealth, humanize=humanize, confine=confine)


def _resolve_login_command(group, group_id, bot_id, secret):
    """Résout la commande de login (secret substitué) si le groupe en exige une, sinon None.

    Lève ValueError si le serveur a un login mais qu'aucun secret n'est enregistré pour ce bot.
    La commande retournée contient le secret en clair → l'appelant ne doit JAMAIS la logger.
    """
    if not group.get("has_login"):
        return None
    if not secret:
        raise ValueError("Secret manquant pour ce bot (le serveur a un login)")
    template = group.get("login_command") or "/login {pwd}"
    return template.replace("{pwd}", secret)


def _online_usernames(group_id):
    """Set (minuscule) des usernames actuellement en ligne dans le groupe (sessions vivantes)."""
    out = set()
    for s in list(_sessions.values()):
        if s.get("server_id") != group_id:
            continue
        proc = s.get("proc")
        if proc is None or proc.poll() is None:
            out.add(str(s.get("user") or "").lower())
    return out


def start_for_bot(group_id, bot_id, model=None, autonomous=False, objective="stone_pickaxe", world_label=None, quota=None, humanize=False, confine=None):
    """Lance un bot du roster d'un groupe (résout connexion + compte + login + intelligence).

    Lève LookupError si le groupe ou le bot est introuvable, ValueError si le compte est déjà en
    ligne ou s'il manque un secret alors que le serveur exige un login.
    """
    group = servers_store.get_server(group_id)
    if not group:
        raise LookupError("Groupe introuvable")
    bot = next((b for b in group.get("bots", []) if b.get("id") == bot_id), None)
    if not bot:
        raise LookupError("Bot introuvable")
    if bot["username"].lower() in _online_usernames(group_id):
        raise ValueError("Ce compte est déjà en ligne")
    secret = mc_agent_secrets.get_secret(group_id, bot_id)
    login_command = _resolve_login_command(group, group_id, bot_id, secret)
    sid = _spawn_bot(
        host=group["host"], port=group["port"], user=bot["username"], auth=bot["auth"],
        profile=group["intelligence"], commands=servers_store.resolve_commands(group),
        policy=servers_store.resolve_policy(group), server_id=group_id,
        language=group.get("language", "fr"), autonomous=autonomous, objective=objective,
        world_label=world_label, model=model, login_command=login_command, quota=quota,
        stealth=bool(group.get("stealth")), humanize=humanize, confine=confine,
    )
    # Self-healing (phase 2) : mémorise QUOI respawner si le process meurt naturellement
    # (kick/Timed out/watchdog) — l'inventaire du compte persiste, le quota repart d'où il était.
    sess = _sessions.get(sid)
    if sess is not None:
        sess["respawn"] = {"group_id": group_id, "bot_id": bot_id, "model": model,
                           "autonomous": autonomous, "objective": objective,
                           "world_label": world_label, "quota": quota, "humanize": humanize,
                           "confine": confine}
        sess.setdefault("respawn_count", 0)
    return sid


def start_mappers(group_id, count):
    """Lance jusqu'à `count` cartographes du roster (role=mapper) non déjà en ligne.

    Les secteurs sont répartis 0..k-1 / count=k sur les bots EFFECTIVEMENT lancés. Un bot dont le
    secret manque (serveur à login) est SKIPPÉ (pas d'exception qui tuerait le batch). Retourne
    {'sessions':[sids], 'launched':n, 'available':nb_dispo, 'skipped':[usernames]}.
    """
    group = servers_store.get_server(group_id)
    if not group:
        raise LookupError("Groupe introuvable")
    online = _online_usernames(group_id)
    dispo = [b for b in group.get("bots", [])
             if b.get("role") == "mapper" and b["username"].lower() not in online]
    available = len(dispo)
    try:
        count = int(count)
    except (TypeError, ValueError):
        count = 0
    k = min(max(count, 0), available)
    if k == 0:
        return {"sessions": [], "launched": 0, "available": available, "skipped": []}
    # 1re passe : résout chaque bot retenu (secret/login) en SKIPPANT ceux sans secret requis.
    runnable = []  # (bot_id, username, auth, login_command)
    skipped = []
    for bot in dispo[:k]:
        secret = mc_agent_secrets.get_secret(group_id, bot["id"])
        try:
            login_command = _resolve_login_command(group, group_id, bot["id"], secret)
        except ValueError:
            skipped.append(bot["username"])
            continue
        runnable.append((bot["id"], bot["username"], bot["auth"], login_command))
    n = len(runnable)
    sessions = []
    commands = servers_store.resolve_commands(group)
    policy = servers_store.resolve_policy(group)
    for i, (bot_id, username, auth, login_command) in enumerate(runnable):
        # Étale les connexions : les serveurs MC throttlent les joins rapprochés depuis la même IP
        # (Paper connection-throttle 4s par défaut) → le 2e bot simultané meurt en ECONNRESET (vécu live).
        if i > 0:
            time.sleep(MAPPER_SPAWN_STAGGER_S)
        sid = _spawn_bot(
            host=group["host"], port=group["port"], user=username, auth=auth,
            profile=group["intelligence"], commands=commands, policy=policy,
            server_id=group_id, language=group.get("language", "fr"), autonomous=True,
            objective="mapper", login_command=login_command, sector_index=i, sector_count=n,
            stealth=bool(group.get("stealth")), humanize=True,
        )
        # Self-healing mapper (Massii #1) : un cartographe tué par les mobs REVIENT (mêmes
        # règles que resource : 15 s + jitter, cap 12, garde crash-on-spawn, spawn gate).
        sess = _sessions.get(sid)
        if sess is not None:
            sess["respawn"] = {"group_id": group_id, "bot_id": bot_id, "model": None,
                               "autonomous": True, "objective": "mapper",
                               "world_label": None, "quota": None, "humanize": True}
            sess.setdefault("respawn_count", 0)
        sessions.append(sid)
    return {"sessions": sessions, "launched": n, "available": available, "skipped": skipped}


def _public(session):
    """Vue sérialisable d'une session (sans proc/thread)."""
    return {
        "id": session["id"], "status": session["status"], "host": session["host"],
        "user": session["user"], "last_error": session["last_error"],
        "server_id": session.get("server_id"),
        "quota": session.get("quota"), "quota_done": session.get("quota_done", False),
    }


def get_status(sid):
    s = _sessions.get(sid)
    return _public(s) if s else None


def get_transcript(sid):
    s = _sessions.get(sid)
    return list(s["transcript"]) if s else None


def list_active():
    # list(...) : snapshot des valeurs avant itération → évite RuntimeError si start_session
    # insère une session sur un autre thread pendant un poll /active concurrent.
    return [_public(s) for s in list(_sessions.values())
            if s.get("proc") is None or s["proc"].poll() is None]


def send_command(sid, command):
    """Envoie une commande JSON sur le stdin du process Node. False si session inconnue."""
    s = _sessions.get(sid)
    if not s or not s.get("proc") or not s["proc"].stdin:
        return False
    try:
        s["proc"].stdin.write(json.dumps(command) + "\n")
        s["proc"].stdin.flush()
    except (ValueError, OSError):
        return False
    return True


def stop_session(sid):
    """Arrête une session (SIGTERM au groupe de process). False si session inconnue."""
    s = _sessions.get(sid)
    if not s:
        return False
    s["user_stopped"] = True          # pas d'auto-respawn après un stop volontaire
    proc = s.get("proc")
    if proc and proc.poll() is None:
        try:
            os.killpg(os.getpgid(proc.pid), signal.SIGTERM)
        except (ProcessLookupError, PermissionError, OSError):
            proc.terminate()
    s["status"] = "stopped"
    _cleanup_session_files(s)
    if s.get("objective") == "mapper":
        _rebalance_sectors(s.get("server_id"))  # les survivants élargissent leur wedge
    return True


def stop_group(group_id):
    """Arrête toutes les sessions actives d'un groupe (server_id). Retourne le nb arrêté."""
    if not group_id:
        return 0
    n = 0
    for sid, s in list(_sessions.items()):
        if s.get("server_id") == group_id and s.get("proc") and s["proc"].poll() is None:
            if stop_session(sid):
                n += 1
    return n


def forget_group(group_id):
    """Cascade : oublie le cache mémoire + supprime le fichier mémoire du groupe. True si supprimé."""
    with _wm_lock:
        _wm_cache.pop(group_id, None)
    return world_memory.delete_memory(group_id)


_LIST_PROFILES_JS = MC_AGENT_DIR / "bin" / "list-profiles.js"


def list_profiles():
    """Profils + fiches de tells, lus depuis les fichiers Node (source unique). [] si échec."""
    try:
        res = subprocess.run(
            [_node_bin(), str(_LIST_PROFILES_JS)],
            cwd=str(MC_AGENT_DIR),
            capture_output=True,
            text=True,
            timeout=15,
        )
    except (OSError, subprocess.SubprocessError):
        return []
    if res.returncode != 0 or not res.stdout:
        return []
    try:
        data = json.loads(res.stdout)
    except (ValueError, TypeError):
        return []
    return data if isinstance(data, list) else []
