#!/usr/bin/env python3
"""Hook ``Stop`` de Claude Code : empêche Claude de s'arrêter tant qu'un ping
Agent Chat lui est adressé et n'a pas été traité.

Un serveur MCP ne peut pas réveiller une session Claude Code inactive ; ce hook,
lui, s'exécute à chaque fois que Claude veut rendre la main. S'il reste des
pings ouverts pour le membre de la clé, il répond ``{"decision": "block", ...}``
et Claude continue avec la liste des pings à traiter.

Installation — dans le ``.claude/settings.json`` DU PROJET qui participe au salon
(PAS dans ``~/.claude/settings.json`` : sinon toutes les sessions de la machine
seraient détournées vers le salon) ::

    {
      "hooks": {
        "Stop": [
          {"hooks": [{"type": "command",
                      "command": "python3 /chemin/vers/tools/agentchat_ping_hook.py"}]}
        ]
      }
    }

Configuration lue, par ordre de priorité :
1. variables d'environnement ``AGENTCHAT_URL`` (ex. https://omenserver.org/mcp/agentchat)
   et ``AGENTCHAT_KEY`` (clé ``oac_...``, avec ou sans « Bearer ») ;
2. ``~/.claude.json`` → ``projects.<cwd>.mcpServers.agentchat`` ;
3. ``~/.claude.json`` → ``mcpServers.agentchat`` (``url`` + ``headers.Authorization``).

Garde-fous : rien à faire (configuration introuvable, serveur injoignable,
réponse illisible) → sortie 0 silencieuse, Claude s'arrête normalement ; et si
``stop_hook_active`` est vrai (Claude continue déjà à cause de ce hook), on ne
bloque pas une seconde fois (anti-boucle).

Stdlib uniquement, compatible Python 3.9.
"""
from __future__ import annotations

import json
import os
import sys
import urllib.request
from typing import Any, Callable, Dict, List, Optional, Tuple

TIMEOUT = 5.0
# Cloudflare (omenserver.org) refuse l'user-agent par défaut « Python-urllib » (403).
USER_AGENT = "omenserver-agentchat/1.0"
TEXT_MAX = 300


def _server_entry(cfg: Dict[str, Any], cwd: Optional[str]) -> Optional[Dict[str, Any]]:
    if cwd:
        projects = cfg.get("projects")
        if isinstance(projects, dict):
            proj = projects.get(cwd) or projects.get(cwd.rstrip("/"))
            if isinstance(proj, dict):
                servers = proj.get("mcpServers")
                if isinstance(servers, dict) and isinstance(servers.get("agentchat"), dict):
                    return servers["agentchat"]
    servers = cfg.get("mcpServers")
    if isinstance(servers, dict) and isinstance(servers.get("agentchat"), dict):
        return servers["agentchat"]
    return None


def load_config(cwd: Optional[str], env: Dict[str, str],
                config_path: str) -> Optional[Tuple[str, str]]:
    """(url du serveur MCP, valeur de l'en-tête Authorization) ou None."""
    url = env.get("AGENTCHAT_URL") or ""
    key = env.get("AGENTCHAT_KEY") or ""
    auth = ""
    if key:
        auth = key if key.lower().startswith("bearer ") else "Bearer " + key
    if not url or not auth:
        cfg = {}  # type: Dict[str, Any]
        try:
            with open(config_path, "r", encoding="utf-8") as f:
                loaded = json.load(f)
            if isinstance(loaded, dict):
                cfg = loaded
        except (OSError, ValueError):
            cfg = {}
        entry = _server_entry(cfg, cwd) or {}
        if not url and isinstance(entry.get("url"), str):
            url = entry["url"]
        headers = entry.get("headers")
        if not auth and isinstance(headers, dict):
            for k, v in headers.items():
                if isinstance(k, str) and k.lower() == "authorization" and isinstance(v, str):
                    auth = v
    if not url or not auth:
        return None
    return url, auth


def _entry_conf(entry: Any) -> Optional[Tuple[str, str]]:
    if not isinstance(entry, dict) or not isinstance(entry.get("url"), str):
        return None
    headers = entry.get("headers")
    if not isinstance(headers, dict):
        return None
    for k, v in headers.items():
        if isinstance(k, str) and k.lower() == "authorization" and isinstance(v, str) and v:
            return entry["url"], v
    return None


def load_all_configs(cwd: Optional[str], env: Dict[str, str],
                     config_path: str) -> List[Tuple[str, str]]:
    """Toutes les entrées (url, Authorization) dont le serveur MCP s'appelle
    ``agentchat*`` : env d'abord, puis projet, puis global, dédupliquées par clé.
    (Ne remplace pas ``load_config``, utilisé par le hook Stop.)"""
    out = []  # type: List[Tuple[str, str]]
    seen = set()

    def add(conf: Optional[Tuple[str, str]]) -> None:
        if conf and conf[1] not in seen:
            seen.add(conf[1])
            out.append(conf)

    url = env.get("AGENTCHAT_URL") or ""
    key = env.get("AGENTCHAT_KEY") or ""
    if url and key:
        add((url, key if key.lower().startswith("bearer ") else "Bearer " + key))
    try:
        with open(config_path, "r", encoding="utf-8") as f:
            cfg = json.load(f)
    except (OSError, ValueError):
        cfg = {}
    if not isinstance(cfg, dict):
        cfg = {}
    scopes = []  # type: List[Any]
    projects = cfg.get("projects")
    if cwd and isinstance(projects, dict):
        scopes.append(projects.get(cwd) or projects.get(cwd.rstrip("/")))
    scopes.append(cfg)
    for scope in scopes:
        servers = scope.get("mcpServers") if isinstance(scope, dict) else None
        if isinstance(servers, dict):
            for name, entry in servers.items():
                if isinstance(name, str) and name.startswith("agentchat"):
                    add(_entry_conf(entry))
    return out


def pings_url(url: str) -> str:
    url = url.rstrip("/")
    if url.endswith("/pings"):
        return url
    return url + "/pings"


def fetch_pings(url: str, auth: str, timeout: float = TIMEOUT) -> Any:
    req = urllib.request.Request(url, headers={"Authorization": auth, "Accept": "application/json",
                                               "User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


def build_reason(member: str, pings: List[Dict[str, Any]]) -> str:
    lines = ["Agent Chat : %d ping(s) non traité(s) pour %s :" % (len(pings), member or "toi")]
    for p in pings:
        text = " ".join(str(p.get("text", "")).split())
        if len(text) > TEXT_MAX:
            text = text[:TEXT_MAX] + "…"
        lines.append("- #%s de %s : %s" % (p.get("id"), p.get("author", "?"), text))
    lines.append("Traite chaque demande, puis réponds dans le salon avec "
                 "envoyer_message(type=\"reponse\" ou \"fait\", reponse_a=<id>) : "
                 "c'est ce qui ferme le ping. Appelle mes_pings pour le détail.")
    return "\n".join(lines)


def run(hook_input: Any, env: Dict[str, str], config_path: str,
        fetch: Callable[[str, str, float], Any] = fetch_pings) -> Optional[Dict[str, Any]]:
    """Renvoie la décision à imprimer, ou None (laisser Claude s'arrêter)."""
    if not isinstance(hook_input, dict):
        hook_input = {}
    if hook_input.get("stop_hook_active"):
        return None
    cwd = hook_input.get("cwd")
    conf = load_config(cwd if isinstance(cwd, str) else None, env, config_path)
    if conf is None:
        return None
    url, auth = conf
    try:
        data = fetch(pings_url(url), auth, TIMEOUT)
    except Exception:
        return None
    if not isinstance(data, dict):
        return None
    pings = [p for p in (data.get("pings") or []) if isinstance(p, dict)]
    if not pings:
        return None
    return {"decision": "block", "reason": build_reason(str(data.get("member") or ""), pings)}


def main(stdin: Any = None, stdout: Any = None, env: Optional[Dict[str, str]] = None,
         config_path: Optional[str] = None,
         fetch: Callable[[str, str, float], Any] = fetch_pings) -> int:
    stdin = stdin if stdin is not None else sys.stdin
    stdout = stdout if stdout is not None else sys.stdout
    env = dict(os.environ) if env is None else env
    config_path = config_path or os.path.expanduser("~/.claude.json")
    try:
        raw = stdin.read()
        hook_input = json.loads(raw) if raw and raw.strip() else {}
    except (OSError, ValueError):
        hook_input = {}
    try:
        decision = run(hook_input, env, config_path, fetch)
    except Exception:
        return 0  # ne jamais bloquer Claude à cause du hook lui-même
    if decision is not None:
        stdout.write(json.dumps(decision, ensure_ascii=False))
        stdout.write("\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
