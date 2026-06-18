"""Helper LLM via le CLI Claude Code (abonnement, AUCUNE clé API) — porté du
Upwork Sniper. SETUP ONLY : c'est la seule étape IA du harvester.

`claude -p` lit le prompt sur stdin ; `--output-format json` renvoie une
enveloppe {..., "result": "<texte>"}. `run` est injectable → test sans CLI.
Chemin complet du binaire car le service systemd a un PATH minimal."""
import json
import os
import subprocess
from typing import Any, Callable, Dict

CLAUDE_BIN = os.environ.get("CLAUDE_BIN") or os.path.expanduser("~/.local/bin/claude")


def extract_json(text: str) -> Dict[str, Any]:
    start, end = text.find("{"), text.rfind("}")
    if start == -1 or end == -1:
        raise ValueError("no JSON in LLM response: {0}".format(text[:200]))
    return json.loads(text[start:end + 1])


def _claude(prompt: str, model: str = "", timeout: int = 180,
            run: Callable = subprocess.run) -> Dict[str, Any]:
    cmd = [CLAUDE_BIN, "-p", "--output-format", "json"]
    if model:
        cmd += ["--model", model]
    proc = run(cmd, input=prompt, capture_output=True, text=True, timeout=timeout)
    if proc.returncode != 0:
        raise RuntimeError("claude cli rc={0}: {1}".format(
            proc.returncode, (proc.stderr or "")[:200]))
    env = json.loads(proc.stdout)
    if env.get("is_error"):
        raise RuntimeError("claude error: {0}".format(str(env.get("result", ""))[:200]))
    return extract_json(env.get("result", ""))
