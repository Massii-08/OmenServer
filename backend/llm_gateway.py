"""Passerelle LLM partagée : API Anthropic d'abord, CLI Claude (abonnement) en repli.

Pourquoi
--------
Tous les appels LLM du serveur passaient par ``claude -p`` (abonnement Max,
jeton OAuth qui expire parfois -> 401 silencieux). Avec un crédit API mensuel
dédié, ce module fait partir les appels d'abord par l'API (clé dédiée) et les
fait retomber AUTOMATIQUEMENT sur le CLI quand le crédit est épuisé, la clé
refusée, l'API en panne ou le budget mensuel atteint.

Module AUTONOME : un seul fichier, stdlib seule à l'import, aucun import de
``backend.*`` -> recopiable tel quel (``~/upwork-sniper/sniper/llm_gateway.py``).
Le SDK ``anthropic`` n'est importé qu'au moment de créer le client : sans lui,
le module s'importe et le chemin CLI fonctionne.

Utilisation
-----------
::

    from backend import llm_gateway as gw

    def _cli():
        # l'appelant lance SON CLI (avec son propre prompt système) et rend le
        # texte ; env=gw.cli_env() est OBLIGATOIRE (voir ci-dessous)
        proc = subprocess.run(cmd, input=prompt, env=gw.cli_env(), ...)
        return texte

    res = gw.complete(prompt, label="coach", tier="sonnet", system=SYSTEM_PROMPT,
                      cli=_cli, notify=envoyer_alerte)
    # res.text, res.backend ("api"|"cli"), res.model, res.cost_usd, res.fallback_reason

Le gateway ne lance JAMAIS le CLI lui-même. ATTENTION : si une clé API traîne
dans l'environnement (``ANTHROPIC_API_KEY`` / ``ANTHROPIC_AUTH_TOKEN``), le CLI
l'utilise À LA PLACE de l'abonnement et brûlerait le crédit en plein repli ->
passer ``env=cli_env()`` au ``subprocess.run`` du CLI.

Configuration
-------------
Précédence : variable d'environnement du process > fichier d'env > défaut.
Une valeur vide vaut « non définie ». Fichier : ``LLM_GATEWAY_ENV_FILE`` (défaut
``~/.config/omen-llm.env``, à mettre en chmod 600), lignes ``CLE=VALEUR``
(commentaires ``#``, guillemets et préfixe ``export`` acceptés). Il est relu dès
que son mtime change : c'est l'interrupteur d'urgence SANS redémarrage
(``LLM_BACKEND=cli`` dans le fichier suffit — à condition de NE PAS définir
``LLM_BACKEND`` dans l'environnement du service, qui primerait).

- ``LLM_GATEWAY_API_KEY`` : la clé (absente -> API désactivée, raison ``no_key``).
  ``ANTHROPIC_API_KEY`` n'est JAMAIS lue.
- ``LLM_BACKEND`` : ``auto`` (défaut : API puis repli CLI) | ``cli`` (jamais
  l'API) | ``api`` (API seule, pas de repli : un échec lève ``GatewayError``).
- ``LLM_MONTHLY_BUDGET_USD`` (90) et ``LLM_DOWNGRADE_AT`` (0.6 : au-delà de cette
  part du budget, le tier ``opus`` est servi par ``sonnet``).
- ``LLM_MODEL_OPUS`` / ``LLM_MODEL_SONNET`` / ``LLM_MODEL_HAIKU`` : ids servis.
- ``LLM_TIER_OVERRIDES`` : ``label=tier,label=tier`` (ex. ``ideas=sonnet,radar=haiku``).
- ``LLM_GATEWAY_STATE_DIR`` (défaut ``~/.local/state/llm-gateway``).

État (le même dossier sert tous les projets de la machine -> budget GLOBAL)
---------------------------------------------------------------------------
- ``usage-YYYY-MM.jsonl`` (mois UTC) : une ligne JSON par appel servi (API ou
  CLI) — jamais le prompt ni la réponse. Une réponse API facturée mais écartée
  (refus, tronquée, vide) a AUSSI sa ligne ``api`` : elle a coûté, le budget
  doit la voir.
- ``state.json`` (+ ``state.lock``) : blocage API en cours et horodatage des
  alertes déjà envoyées.

Fichiers créés en 0600, dossier en 0700. La clé n'apparaît nulle part (ni
journal, ni état, ni log, ni message d'exception, ni alerte) ; l'état ne garde
qu'une empreinte tronquée (sha256) pour lever un blocage dès que la clé change.

Limites assumées
----------------
- Le coût est une ESTIMATION (tokens x tarif public), pas une facture.
- Un appel API qui expire a pu être facturé sans qu'on le voie.
- Des appels en parallèle peuvent dépasser le budget de quelques appels (la
  dépense est lue au début de chaque appel).
- Le SDK réessaie une fois (``max_retries=1``, y compris sur délai dépassé) :
  une panne API peut coûter jusqu'à ~2 x ``timeout`` avant le repli.
- v1 sans cache de prompt ni streaming (v2 possible : ``cache_control`` sur le
  prompt système, streaming pour les gros ``max_tokens``).

Ligne de commande : ``python -m backend.llm_gateway status | selftest [--live]
| summary | unblock``.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import logging
import math
import os
import re
import sys
import threading
import time
import uuid
from contextlib import contextmanager
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Callable, Dict, Iterator, List, Mapping, Optional, Tuple

try:  # verrou inter-processus (POSIX) ; absent sous Windows -> verrou de thread seul
    import fcntl
except ImportError:  # pragma: no cover - Windows
    fcntl = None  # type: ignore[assignment]

logger = logging.getLogger("omenserver")

__all__ = [
    "GatewayError", "Result", "complete", "cli_env", "resolve_model",
    "estimate_cost", "status", "month_summary", "main",
]

# ---------------------------------------------------------------------------
# Constantes
# ---------------------------------------------------------------------------

KEY_VAR = "LLM_GATEWAY_API_KEY"
ENV_FILE_VAR = "LLM_GATEWAY_ENV_FILE"
DEFAULT_ENV_FILE = "~/.config/omen-llm.env"
DEFAULT_STATE_DIR = "~/.local/state/llm-gateway"

TIERS = ("opus", "sonnet", "haiku")
DEFAULT_TIER = "sonnet"
DEFAULT_MODELS = {
    "opus": "claude-opus-5-5",
    "sonnet": "claude-sonnet-5-5",
    "haiku": "claude-haiku-5-5",
}
# Effort par défaut selon le tier DEMANDÉ (la profondeur voulue par l'appelant
# est conservée même quand le budget fait servir « opus » par « sonnet »).
DEFAULT_EFFORT = {"opus": "medium", "sonnet": "medium", "haiku": "low"}
BACKENDS = ("auto", "cli", "api")
DEFAULT_BUDGET_USD = 90.0
DEFAULT_DOWNGRADE_AT = 0.6

BLOCK_CREDIT_S = 3600            # crédit épuisé : on retente l'API dans 1 h
BLOCK_KEY_S = 6 * 3600           # clé refusée : 6 h (ou dès que la clé change)
ALERT_WINDOW_S = 6 * 3600        # une alerte d'un même type au plus toutes les 6 h
ALERT_RETENTION_S = 45 * 86400   # purge des horodatages d'alertes trop vieux

STATE_FILE = "state.json"
LOCK_FILE = "state.lock"
LEDGER_PATTERN = "usage-%s.jsonl"

USAGE_KEYS = (
    "input_tokens", "output_tokens",
    "cache_read_input_tokens", "cache_creation_input_tokens",
)

# Variables qui feraient utiliser une clé API au CLI au lieu de l'abonnement.
CLI_STRIPPED_VARS = ("ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", KEY_VAR)

# Tarifs publics en USD par MILLION de tokens : (entrée, sortie, lecture de cache).
# Lecture de cache à None -> 10 % du prix d'entrée ; écriture de cache = 1.25 x
# l'entrée (TTL 5 min). Le coût calculé est une ESTIMATION, pas une facture.
_PRICES = {
    "claude-opus-5-5": (4.0, 20.0, 0.20),
    "claude-opus-5": (5.0, 25.0, None),
    "claude-opus-4-8": (5.0, 25.0, None),
    "claude-opus-4-7": (5.0, 25.0, None),
    "claude-opus-4-6": (5.0, 25.0, None),
    "claude-sonnet-5-5": (2.0, 10.0, 0.20),
    "claude-sonnet-5": (2.0, 10.0, None),
    "claude-sonnet-4-6": (3.0, 15.0, None),
    "claude-haiku-5-5": (0.10, 0.50, None),   # palier long ci-dessous
    "claude-haiku-4-5": (1.0, 5.0, None),
    "claude-fable-5-1": (10.0, 50.0, 0.25),   # lecture de cache 0.025 x (doc Anthropic)
    "claude-fable-5": (10.0, 50.0, None),
}
_HAIKU55 = "claude-haiku-5-5"
_HAIKU55_LONG_THRESHOLD = 100_000             # tokens de prompt (entrée + cache)
_HAIKU55_LONG_PRICE = (0.50, 2.50, None)
_UNKNOWN_PRICE = (5.0, 25.0, None)            # modèle inconnu : estimation prudente
_CACHE_WRITE_MULT = 1.25
_DEFAULT_CACHE_READ_RATIO = 0.10

# Messages qui signalent un crédit / plafond de dépense épuisé (comparés en minuscules).
_CREDIT_MARKERS = ("credit balance", "usage limit", "spend limit", "workspace api usage")

# Classification SANS dépendre des classes du SDK (il peut être absent en test
# et ses classes changent selon les versions) : nom de classe, puis ``.type``.
_NAME_STATUS = {
    "BadRequestError": 400, "AuthenticationError": 401,
    "PermissionDeniedError": 403, "NotFoundError": 404,
    "RequestTooLargeError": 413, "UnprocessableEntityError": 422,
    "RateLimitError": 429, "InternalServerError": 500,
    "ServiceUnavailableError": 503, "DeadlineExceededError": 504,
    "OverloadedError": 529,
}
_TYPE_STATUS = {
    "invalid_request_error": 400, "authentication_error": 401,
    "billing_error": 402, "permission_error": 403, "not_found_error": 404,
    "request_too_large": 413, "rate_limit_error": 429, "api_error": 500,
    "overloaded_error": 529,
}

# Famille + version d'un id de modèle : ``claude-opus-4-5-20251101`` -> opus 4.5.
# La mineure est UN chiffre suivi de « - » ou de la fin (sinon on lirait la date).
_MODEL_RE = re.compile(r"^claude-(opus|sonnet|haiku|fable|mythos)-(\d+)(?:-(\d)(?=-|$))?")
# Version minimale qui accepte ``output_config.effort`` : on n'envoie jamais un
# effort PAR DÉFAUT à un modèle qui le refuserait (Haiku 4.5, Sonnet 4.5…).
_EFFORT_MIN_VERSION = {"opus": (4, 5), "sonnet": (4, 6), "haiku": (5, 0),
                       "fable": (0, 0), "mythos": (0, 0)}

_KEY_PATTERN = re.compile(r"sk-ant-[A-Za-z0-9_\-]{6,}")
_MASK = "[clé masquée]"
_O_CLOEXEC = getattr(os, "O_CLOEXEC", 0)

# ---------------------------------------------------------------------------
# Types publics
# ---------------------------------------------------------------------------


class GatewayError(RuntimeError):
    """Seule exception levée par :func:`complete` : rien n'a pu répondre.

    ``api_reason`` : pourquoi l'API n'a pas servi (même vocabulaire que
    ``Result.fallback_reason``). Le message ne contient JAMAIS la clé.
    """

    def __init__(self, message: str, api_reason: Optional[str] = None) -> None:
        super().__init__(message)
        self.api_reason = api_reason


@dataclass(frozen=True)
class Result:
    """Réponse d'un appel :func:`complete`."""

    text: str
    backend: str                      # "api" | "cli"
    model: str                        # id API réellement servi ; "cli" si repli
    usage: dict                       # tokens API ; {} pour le CLI
    cost_usd: float                   # estimation ; 0.0 pour le CLI
    fallback_reason: Optional[str]    # None si l'API a répondu


@dataclass(frozen=True)
class _Config:
    api_key: Optional[str] = field(repr=False)   # jamais dans un repr/log
    backend: str
    budget: float
    downgrade_at: float
    models: Dict[str, str]
    tier_overrides: Dict[str, str]
    state_dir: str
    env_file: str


# ---------------------------------------------------------------------------
# Petits utilitaires
# ---------------------------------------------------------------------------

_WARNED = set()          # clés des avertissements déjà émis dans ce process
_WARNED_LOCK = threading.Lock()


def _warn_once(key: Any, msg: str, *args: Any) -> None:
    """``logger.warning`` une seule fois par process pour une même ``key``."""
    with _WARNED_LOCK:
        if key in _WARNED:
            return
        _WARNED.add(key)
    logger.warning(msg, *args)


def _redact(text: Any, key: Optional[str] = None) -> str:
    """Masque la clé (valeur exacte + tout motif ``sk-ant-…``) dans un texte."""
    try:
        s = str(text)
    except Exception:  # __str__ exotique
        s = "<message illisible>"
    if key:
        s = s.replace(key, _MASK)
    return _KEY_PATTERN.sub(_MASK, s)


def _short_error(exc: BaseException, key: Optional[str], limit: int = 300) -> str:
    """« Type: message » masqué (AVANT troncature), sur une ligne."""
    msg = "%s: %s" % (type(exc).__name__, _redact(exc, key))
    return " ".join(msg.split())[:limit]


def _safe_getattr(obj: Any, name: str) -> Any:
    """``getattr`` qui ne lève jamais (certaines propriétés d'exceptions lèvent
    autre chose qu'AttributeError)."""
    try:
        return getattr(obj, name, None)
    except Exception:
        return None


def _num(value: Any) -> float:
    """Nombre fini et positif, sinon 0.0 (lecture tolérante du journal / de l'état)."""
    if isinstance(value, bool):
        return 0.0
    try:
        x = float(value)
    except (TypeError, ValueError):
        return 0.0
    return x if math.isfinite(x) and x > 0 else 0.0


def _tok(value: Any) -> int:
    """Nombre de tokens entier et positif, sinon 0."""
    if isinstance(value, bool):
        return 0
    try:
        n = int(value)
    except (TypeError, ValueError):
        return 0
    return n if n > 0 else 0


def _attr(obj: Any, name: str, default: Any = None) -> Any:
    """``obj.name`` ou ``obj[name]`` (réponse SDK, SimpleNamespace ou dict)."""
    if obj is None:
        return default
    if isinstance(obj, Mapping):
        return obj.get(name, default)
    return getattr(obj, name, default)


def _month_of(t: float) -> str:
    return time.strftime("%Y-%m", time.gmtime(t))


def _iso(t: float) -> str:
    return datetime.fromtimestamp(t, tz=timezone.utc).isoformat(timespec="seconds")


def _key_fp(key: Optional[str]) -> str:
    """Empreinte tronquée (irréversible) de la clé : sert à lever un blocage dès
    que la clé change, sans jamais stocker la clé."""
    if not key:
        return ""
    return hashlib.sha256(key.encode("utf-8")).hexdigest()[:12]


def _clean_label(label: Any) -> str:
    s = str(label).strip() if label is not None else ""
    return (s or "sans_label")[:80]


def _ratio(spend: float, budget: float) -> float:
    return spend / budget if budget > 0 else math.inf


def _close_quietly(client: Any) -> None:
    close = getattr(client, "close", None)
    if callable(close):
        try:
            close()
        except Exception:
            pass


# ---------------------------------------------------------------------------
# Configuration (variable du process > fichier d'env > défaut)
# ---------------------------------------------------------------------------

_ENV_LINE_RE = re.compile(r"^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$")
_ENV_CACHE: Dict[str, Tuple[Tuple[int, int, int, int], Dict[str, str]]] = {}
_ENV_CACHE_LOCK = threading.Lock()


def _parse_env_text(text: str) -> Dict[str, str]:
    """Lignes ``CLE=VALEUR`` ; ``#`` commente ; guillemets optionnels."""
    out: Dict[str, str] = {}
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        m = _ENV_LINE_RE.match(line)
        if not m:
            continue                     # ligne illisible ignorée (jamais logguée)
        key, val = m.group(1), m.group(2).strip()
        if val[:1] in ("'", '"'):
            quote = val[0]
            end = val.find(quote, 1)
            val = val[1:end] if end > 0 else val[1:]
        else:
            val = re.sub(r"\s+#.*$", "", val).strip()
        out[key] = val
    return out


def _env_file_path() -> str:
    raw = (os.environ.get(ENV_FILE_VAR) or "").strip() or DEFAULT_ENV_FILE
    return os.path.abspath(os.path.expanduser(raw))


def _read_env_file(path: str) -> Dict[str, str]:
    """Contenu du fichier d'env, relu seulement si sa signature (mtime, taille,
    inode) a changé. Fichier absent ou illisible -> {}."""
    try:
        st = os.stat(path)
    except FileNotFoundError:
        return {}
    except OSError as e:
        _warn_once(("envfile", path), "llm_gateway : fichier d'env %s inaccessible (%s)",
                   path, type(e).__name__)
        return {}
    sig = (st.st_mtime_ns, st.st_size, st.st_ino, st.st_dev)
    with _ENV_CACHE_LOCK:
        hit = _ENV_CACHE.get(path)
        if hit is not None and hit[0] == sig:
            return hit[1]
    try:
        with open(path, "r", encoding="utf-8-sig") as f:
            values = _parse_env_text(f.read())
    except (OSError, UnicodeDecodeError) as e:
        _warn_once(("envfile", path), "llm_gateway : fichier d'env %s illisible (%s)",
                   path, type(e).__name__)
        return {}
    with _ENV_CACHE_LOCK:
        _ENV_CACHE[path] = (sig, values)
    return values


def _float_setting(raw: Optional[str], default: float, name: str) -> float:
    if raw is None:
        return default
    try:
        x = float(raw.replace(",", "."))
    except ValueError:
        x = float("nan")
    if not math.isfinite(x) or x < 0:
        _warn_once(("float", name, raw), "llm_gateway : %s=%r invalide, défaut %s utilisé",
                   name, raw, default)
        return default
    return x


def _parse_overrides(raw: Optional[str]) -> Dict[str, str]:
    """``label=tier,label=tier`` -> {label en minuscules: tier ou id}."""
    out: Dict[str, str] = {}
    if not raw:
        return out
    for part in raw.split(","):
        label, sep, target = part.partition("=")
        label, target = label.strip().lower(), target.strip()
        if not sep or not label or not target:
            if part.strip():
                _warn_once(("override", part.strip()),
                           "llm_gateway : entrée LLM_TIER_OVERRIDES ignorée : %r", part.strip())
            continue
        out[label] = target.lower() if target.lower() in TIERS else target
    return out


def _load_config() -> _Config:
    """Relit la configuration (à CHAQUE appel : interrupteur à chaud)."""
    env_file = _env_file_path()
    file_values = _read_env_file(env_file)

    def get(name: str) -> Optional[str]:
        for source in (os.environ, file_values):
            v = source.get(name)
            if v is not None and v.strip():
                return v.strip()
        return None

    backend = (get("LLM_BACKEND") or "auto").lower()
    if backend not in BACKENDS:
        _warn_once(("backend", backend),
                   "llm_gateway : LLM_BACKEND=%r inconnu, « auto » utilisé", backend)
        backend = "auto"
    state_dir = get("LLM_GATEWAY_STATE_DIR") or DEFAULT_STATE_DIR
    return _Config(
        api_key=get(KEY_VAR),
        backend=backend,
        budget=_float_setting(get("LLM_MONTHLY_BUDGET_USD"), DEFAULT_BUDGET_USD,
                              "LLM_MONTHLY_BUDGET_USD"),
        downgrade_at=_float_setting(get("LLM_DOWNGRADE_AT"), DEFAULT_DOWNGRADE_AT,
                                    "LLM_DOWNGRADE_AT"),
        models={t: (get("LLM_MODEL_" + t.upper()) or DEFAULT_MODELS[t]) for t in TIERS},
        tier_overrides=_parse_overrides(get("LLM_TIER_OVERRIDES")),
        state_dir=os.path.abspath(os.path.expanduser(state_dir)),
        env_file=env_file,
    )


# ---------------------------------------------------------------------------
# Modèles, effort, tarifs
# ---------------------------------------------------------------------------


def _family_of(model: str) -> Optional[str]:
    m = _MODEL_RE.match((model or "").strip().lower())
    return m.group(1) if m else None


def _supports_effort(model: str) -> bool:
    """True si l'id désigne un modèle qui accepte ``output_config.effort``."""
    m = _MODEL_RE.match((model or "").strip().lower())
    if not m:
        return False
    version = (int(m.group(2)), int(m.group(3) or 0))
    return version >= _EFFORT_MIN_VERSION[m.group(1)]


def _requested_name(cfg: _Config, tier_or_model: Optional[str], label: str) -> str:
    """Tier (alias en minuscules) ou id demandé, APRÈS surcharge par label."""
    name = (tier_or_model or "").strip()
    override = cfg.tier_overrides.get((label or "").strip().lower())
    if override:
        name = override
    if not name:
        name = DEFAULT_TIER
    return name.lower() if name.lower() in TIERS else name


def _resolve_name(cfg: _Config, name: str, spend_ratio: float) -> str:
    """Alias de tier -> id (rétrogradation opus -> sonnet passé le seuil) ; un id
    complet est rendu tel quel."""
    if name in TIERS:
        tier = name
        if tier == "opus" and spend_ratio >= cfg.downgrade_at:
            tier = "sonnet"
        return cfg.models[tier]
    return name


def resolve_model(tier_or_model: str, *, label: str = "", spend_ratio: float = 0.0) -> str:
    """Id de modèle servi pour un tier (``opus|sonnet|haiku``) ou un id complet.

    Applique, dans l'ordre : la surcharge ``LLM_TIER_OVERRIDES`` du label (elle
    prime même sur un id explicite : c'est la main de l'opérateur), les ids
    ``LLM_MODEL_*``, puis la rétrogradation ``opus`` -> ``sonnet`` quand
    ``spend_ratio`` (part du budget consommée) atteint ``LLM_DOWNGRADE_AT``.
    """
    cfg = _load_config()
    name = _requested_name(cfg, tier_or_model, _clean_label(label) if label else "")
    return _resolve_name(cfg, name, spend_ratio)


def _price_for(model: str, prompt_tokens: int) -> Tuple[float, float, Optional[float]]:
    m = (model or "").strip().lower()
    base = m if m in _PRICES else None
    if base is None:   # id daté (claude-opus-4-6-2026…) : préfixe connu le plus long
        for k in _PRICES:
            if m.startswith(k + "-") and (base is None or len(k) > len(base)):
                base = k
    if base is None:
        _warn_once(("price", m), "llm_gateway : tarif inconnu pour %r, estimation prudente "
                   "à 5/25 $ par million de tokens", model)
        return _UNKNOWN_PRICE
    if base == _HAIKU55 and prompt_tokens > _HAIKU55_LONG_THRESHOLD:
        return _HAIKU55_LONG_PRICE
    return _PRICES[base]


def estimate_cost(model: str, usage: Mapping[str, Any]) -> float:
    """Coût ESTIMÉ en USD d'une réponse API (tokens x tarif public).

    Ce n'est pas une facture : arrondis, remises et tarifs futurs non compris.
    Écriture de cache = 1.25 x l'entrée ; lecture = tarif listé ou 10 % de
    l'entrée ; Haiku 5.5 passe au palier long au-delà de 100K tokens de prompt.
    """
    usage = usage or {}
    inp = _tok(usage.get("input_tokens"))
    out = _tok(usage.get("output_tokens"))
    cache_read = _tok(usage.get("cache_read_input_tokens"))
    cache_write = _tok(usage.get("cache_creation_input_tokens"))
    p_in, p_out, p_read = _price_for(model, inp + cache_read + cache_write)
    if p_read is None:
        p_read = p_in * _DEFAULT_CACHE_READ_RATIO
    total = (inp * p_in + cache_write * p_in * _CACHE_WRITE_MULT
             + cache_read * p_read + out * p_out)
    return total / 1_000_000.0


# ---------------------------------------------------------------------------
# Journal de consommation (usage-YYYY-MM.jsonl)
# ---------------------------------------------------------------------------


def _ensure_dir(path: str) -> None:
    os.makedirs(path, mode=0o700, exist_ok=True)


def _fchmod_600(fd: int) -> None:
    try:
        os.fchmod(fd, 0o600)
    except (AttributeError, OSError):
        pass


def _ledger_path(state_dir: str, month: str) -> str:
    return os.path.join(state_dir, LEDGER_PATTERN % month)


def _ledger_record(t: float, label: str, backend: str, model: str, tier: str,
                   usage: Mapping[str, Any], cost: float, reason: Optional[str],
                   request_id: Optional[str]) -> Dict[str, Any]:
    """Une ligne de journal : jamais le prompt, jamais la réponse."""
    return {
        "ts": round(t, 3),
        "label": label[:80],
        "backend": backend,
        "model": str(model)[:80],
        "tier": tier,
        "in": _tok(usage.get("input_tokens")),
        "out": _tok(usage.get("output_tokens")),
        "cache_read": _tok(usage.get("cache_read_input_tokens")),
        "cache_write": _tok(usage.get("cache_creation_input_tokens")),
        "cost_usd": round(cost, 8),
        "fallback_reason": reason,
        "request_id": request_id,
    }


def _append_ledger(state_dir: str, record: Dict[str, Any], t: float) -> None:
    """Ajoute UNE ligne par un seul ``os.write`` en O_APPEND (atomique : la ligne
    fait quelques centaines d'octets). Une panne d'écriture ne casse jamais l'appel."""
    data = (json.dumps(record, ensure_ascii=False, separators=(",", ":")) + "\n").encode("utf-8")
    path = _ledger_path(state_dir, _month_of(t))
    try:
        _ensure_dir(state_dir)
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_APPEND | _O_CLOEXEC, 0o600)
        try:
            _fchmod_600(fd)
            written = os.write(fd, data)
            if written != len(data):   # disque plein… : on termine la ligne
                logger.warning("llm_gateway : écriture partielle du journal (%d/%d octets)",
                               written, len(data))
                os.write(fd, b"\n")
        finally:
            os.close(fd)
    except Exception as e:   # la comptabilité ne fait JAMAIS tomber un appel
        logger.warning("llm_gateway : journal %s non écrit (%s)", path, type(e).__name__)


def _iter_ledger(path: str) -> Iterator[Dict[str, Any]]:
    """Lignes valides du journal ; une ligne corrompue est ignorée."""
    try:
        f = open(path, "r", encoding="utf-8", errors="replace")
    except FileNotFoundError:
        return
    except OSError as e:
        _warn_once(("ledger", path), "llm_gateway : journal %s illisible (%s)",
                   path, type(e).__name__)
        return
    with f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                rec = json.loads(line)
            except ValueError:
                continue
            if isinstance(rec, dict):
                yield rec


def _month_spend(state_dir: str, month: str) -> float:
    """Dépense API du mois = somme des ``cost_usd`` des lignes ``backend == "api"``."""
    return sum((_num(r.get("cost_usd")) for r in _iter_ledger(_ledger_path(state_dir, month))
                if r.get("backend") == "api"), 0.0)


# ---------------------------------------------------------------------------
# État partagé (state.json + verrou)
# ---------------------------------------------------------------------------

_STATE_TLOCK = threading.Lock()    # sérialise les transactions de CE process
_MEM_ALERTS: Dict[str, float] = {}  # dédoublonnage de secours si l'état est inutilisable


def _blank_state() -> Dict[str, Any]:
    return {"api_blocked_until": 0.0, "blocked_reason": "", "blocked_key_fp": "",
            "alerts": {}}


def _normalize_state(raw: Any) -> Dict[str, Any]:
    state = _blank_state()
    if not isinstance(raw, dict):
        return state
    state["api_blocked_until"] = _num(raw.get("api_blocked_until"))
    for k in ("blocked_reason", "blocked_key_fp"):
        v = raw.get(k)
        state[k] = v if isinstance(v, str) else ""
    alerts = raw.get("alerts")
    if isinstance(alerts, dict):
        state["alerts"] = {str(k): _num(v) for k, v in alerts.items() if _num(v) > 0}
    return state


def _read_state(state_dir: str) -> Dict[str, Any]:
    """Lecture sans verrou (le remplacement atomique garantit un fichier entier)."""
    path = os.path.join(state_dir, STATE_FILE)
    try:
        with open(path, "r", encoding="utf-8") as f:
            raw = json.load(f)
    except FileNotFoundError:
        return _blank_state()
    except (OSError, ValueError) as e:
        _warn_once(("state", path), "llm_gateway : état %s illisible (%s), repart de zéro",
                   path, type(e).__name__)
        return _blank_state()
    return _normalize_state(raw)


def _unlink_quietly(path: str) -> None:
    try:
        os.unlink(path)
    except OSError:
        pass


def _write_state(state_dir: str, state: Dict[str, Any]) -> None:
    """Écriture atomique : fichier temporaire 0600 + fsync + ``os.replace``."""
    data = (json.dumps(state, ensure_ascii=False, sort_keys=True, indent=1) + "\n").encode("utf-8")
    final = os.path.join(state_dir, STATE_FILE)
    tmp = os.path.join(state_dir, ".%s.%d.%s.tmp"
                       % (STATE_FILE, os.getpid(), uuid.uuid4().hex[:12]))
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | _O_CLOEXEC, 0o600)
    done = False
    try:
        _fchmod_600(fd)
        view = memoryview(data)
        while view:
            view = view[os.write(fd, view):]
        os.fsync(fd)
        os.close(fd)
        fd = -1
        os.replace(tmp, final)
        done = True
    finally:
        if fd >= 0:
            os.close(fd)
        if not done:
            _unlink_quietly(tmp)


@contextmanager
def _state_txn(state_dir: str) -> Iterator[Dict[str, Any]]:
    """Lecture-modification-écriture de l'état sous verrou (thread + ``flock``).

    L'état n'est réécrit que s'il a changé. Lève OSError si le dossier est
    inutilisable (l'appelant décide quoi en faire).
    """
    with _STATE_TLOCK:
        _ensure_dir(state_dir)
        lock_fd = os.open(os.path.join(state_dir, LOCK_FILE),
                          os.O_RDWR | os.O_CREAT | _O_CLOEXEC, 0o600)
        try:
            _fchmod_600(lock_fd)
            if fcntl is not None:
                fcntl.flock(lock_fd, fcntl.LOCK_EX)
            state = _read_state(state_dir)
            before = json.dumps(state, sort_keys=True)
            yield state
            if json.dumps(state, sort_keys=True) != before:
                _write_state(state_dir, state)
        finally:
            os.close(lock_fd)   # libère aussi le flock


def _active_block(state: Mapping[str, Any], t: float, key_fp: str) -> Optional[str]:
    """Raison du blocage API en cours, ou None (expiré, ou clé changée depuis)."""
    if t >= _num(state.get("api_blocked_until")):
        return None
    fp = state.get("blocked_key_fp") or ""
    if fp and key_fp and fp != key_fp:
        return None   # nouvelle clé depuis le blocage : on retente l'API
    return state.get("blocked_reason") or "inconnu"


def _block_api(cfg: _Config, t: float, seconds: int, reason: str, key_fp: str) -> None:
    try:
        with _state_txn(cfg.state_dir) as st:
            until = t + seconds
            if until > st["api_blocked_until"] or st["blocked_key_fp"] != key_fp:
                st["api_blocked_until"] = until
                st["blocked_reason"] = reason
                st["blocked_key_fp"] = key_fp
    except Exception as e:   # l'état ne fait JAMAIS tomber un appel
        logger.warning("llm_gateway : blocage API non enregistré (%s)", type(e).__name__)


# ---------------------------------------------------------------------------
# Alertes
# ---------------------------------------------------------------------------


def _alert_due(alerts: Mapping[str, float], key: str, t: float, window: Optional[int]) -> bool:
    last = alerts.get(key)
    if last is None:
        return True
    if window is None:          # clé déjà datée (ex. budget du mois) : une seule fois
        return False
    return t - last >= window


def _safe_notify(notify: Callable[[str], None], text: str) -> None:
    try:
        notify(text)
    except Exception as e:  # jamais propagé ; message non loggué (il peut porter un jeton)
        logger.warning("llm_gateway : notify a échoué (%s), alerte non transmise",
                       type(e).__name__)


def _alert(cfg: _Config, notify: Optional[Callable[[str], None]], key: str, text: str,
           t: float, window: Optional[int], also_mark: Tuple[str, ...] = ()) -> None:
    """Envoie ``text`` au plus une fois (``window=None``) ou une fois par ``window``
    secondes, dédoublonné dans state.json (donc entre TOUS les process)."""
    if notify is None:
        # Pas de canal : on ne consomme pas le créneau (un autre appelant pourra
        # alerter) ; trace locale une fois par process.
        _warn_once(("alert", key), "llm_gateway : %s", text)
        return
    send = False
    try:
        with _state_txn(cfg.state_dir) as st:
            alerts = st["alerts"]
            if _alert_due(alerts, key, t, window):
                send = True
                alerts[key] = t
                for extra in also_mark:
                    alerts.setdefault(extra, t)
                for old in [k for k, v in alerts.items() if t - v > ALERT_RETENTION_S]:
                    del alerts[old]
    except Exception as e:   # état inutilisable : dédoublonnage de secours en mémoire
        logger.warning("llm_gateway : état non inscriptible (%s), alertes dédoublonnées en "
                       "mémoire", type(e).__name__)
        with _STATE_TLOCK:
            if _alert_due(_MEM_ALERTS, key, t, window):
                send = True
                _MEM_ALERTS[key] = t
                for extra in also_mark:
                    _MEM_ALERTS.setdefault(extra, t)
    if send:
        logger.warning("llm_gateway : alerte %s : %s", key, text)
        _safe_notify(notify, text)


def _text_credit(label: str) -> str:
    return ("LLM gateway : crédit API Anthropic épuisé (appel « {} »). Bascule sur le CLI "
            "abonnement ; recharge sur console.anthropic.com ; nouvelle tentative API dans "
            "1 h (commande « unblock » du module pour réessayer tout de suite).").format(label)


def _text_key_invalid(cfg: _Config, label: str) -> str:
    return ("LLM gateway : clé API refusée par Anthropic (401/403, appel « {} »). Bascule "
            "sur le CLI abonnement pendant 6 h ; vérifie ou régénère la clé sur "
            "console.anthropic.com puis remplace LLM_GATEWAY_API_KEY dans {} : une nouvelle "
            "clé est prise en compte sans redémarrage et lève le blocage."
            ).format(label, cfg.env_file)


def _text_budget80(cfg: _Config, spend: float) -> str:
    return ("LLM gateway : 80 % du budget API mensuel consommé ({:.2f} $ sur {:.2f} $). "
            "À 100 %, tous les appels passeront par le CLI abonnement jusqu'au 1er du mois "
            "(UTC). Pour relever le plafond : LLM_MONTHLY_BUDGET_USD dans {}."
            ).format(spend, cfg.budget, cfg.env_file)


def _text_budget100(cfg: _Config, spend: float) -> str:
    return ("LLM gateway : budget API mensuel atteint ({:.2f} $ sur {:.2f} $). Tous les appels "
            "passent par le CLI abonnement jusqu'au 1er du mois (UTC). Pour reprendre l'API, "
            "relève LLM_MONTHLY_BUDGET_USD dans {} (pris en compte sans redémarrage)."
            ).format(spend, cfg.budget, cfg.env_file)


def _budget_alerts(cfg: _Config, notify: Optional[Callable[[str], None]], spend: float,
                   t: float, month: str) -> None:
    """Alerte à 80 % puis à 100 % du budget, une fois par mois et par seuil.
    Passé directement à 100 %, seule l'alerte 100 % part (le 80 % est marqué)."""
    if cfg.budget <= 0:
        return   # budget nul = API coupée volontairement : pas d'alerte
    ratio = spend / cfg.budget
    if ratio >= 1.0:
        _alert(cfg, notify, "budget100:" + month, _text_budget100(cfg, spend), t, None,
               also_mark=("budget80:" + month,))
    elif ratio >= 0.8:
        _alert(cfg, notify, "budget80:" + month, _text_budget80(cfg, spend), t, None)


# ---------------------------------------------------------------------------
# SDK et classification des erreurs
# ---------------------------------------------------------------------------


def _sdk_available() -> bool:
    """Le SDK ``anthropic`` est-il importable ? (import réel, mis en cache par Python)."""
    try:
        import anthropic  # noqa: F401
    except Exception:   # absent, ou installé mais cassé
        return False
    return True


def _sdk_version() -> Optional[str]:
    try:
        from importlib import metadata
        return metadata.version("anthropic")
    except Exception:
        return getattr(sys.modules.get("anthropic"), "__version__", None)


def _default_client_factory(*, api_key: str, timeout: float, max_retries: int) -> Any:
    """Client officiel, clé passée EXPLICITEMENT (un client sans argument
    ramasserait ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN / un profil par hasard)."""
    import anthropic   # import PARESSEUX : le module vit sans le SDK
    return anthropic.Anthropic(api_key=api_key, timeout=timeout, max_retries=max_retries)


def _status_of(exc: BaseException) -> Optional[int]:
    for holder in (exc, _safe_getattr(exc, "response")):
        s = _safe_getattr(holder, "status_code")
        if isinstance(s, int) and not isinstance(s, bool):
            return s
    return None


def _error_text(exc: BaseException) -> str:
    """Tout le texte d'erreur disponible, en minuscules (message + corps JSON)."""
    parts = []
    try:
        parts.append(str(exc))
    except Exception:
        pass
    msg = _safe_getattr(exc, "message")
    if isinstance(msg, str):
        parts.append(msg)
    body = _safe_getattr(exc, "body")
    if isinstance(body, dict):
        err = body.get("error") if isinstance(body.get("error"), dict) else body
        inner = err.get("message")
        if isinstance(inner, str):
            parts.append(inner)
    return " ".join(parts).lower()


def _classify(exc: BaseException) -> str:
    """Raison d'échec d'un appel API, SANS importer le SDK : nom de classe,
    ``status_code`` (ou ``.type``) et message en minuscules."""
    name = type(exc).__name__
    lname = name.lower()
    etype = _safe_getattr(exc, "type")
    etype = etype if isinstance(etype, str) else None
    status = _status_of(exc)
    if status is None:
        status = _NAME_STATUS.get(name) or (_TYPE_STATUS.get(etype) if etype else None)
    text = _error_text(exc)

    # Délais d'abord (APITimeoutError hérite d'APIConnectionError dans le SDK).
    if status == 408 or (status is None and (
            name == "APITimeoutError" or isinstance(exc, TimeoutError) or "timeout" in lname)):
        return "timeout"
    if status == 402 or etype == "billing_error":
        return "credit_exhausted"
    if status in (400, 429) and any(marker in text for marker in _CREDIT_MARKERS):
        return "credit_exhausted"
    if status in (401, 403) or name in ("AuthenticationError", "PermissionDeniedError"):
        return "key_invalid"
    if status == 429:
        return "rate_limit"
    if status == 529 or "overloaded" in lname or etype == "overloaded_error":
        return "overloaded"
    if status is not None and status >= 500:
        return "server_error"
    if status is not None and 400 <= status < 500 and status != 409:
        return "bad_request"   # 400, 404 (modèle inconnu), 413, 422 : à corriger, pas transitoire
    if name == "APIConnectionError" or isinstance(exc, OSError) or "connect" in lname:
        return "connection"
    return "other"


def _create(client: Any, kwargs: Dict[str, Any]) -> Any:
    """``messages.create`` ; un SDK trop vieux pour ``output_config`` lève
    TypeError -> un seul réessai avec ``extra_body``."""
    try:
        return client.messages.create(**kwargs)
    except TypeError as e:
        if "output_config" not in kwargs or "output_config" not in str(e):
            raise
        retry = dict(kwargs)
        retry["extra_body"] = {"output_config": retry.pop("output_config")}
        _warn_once(("old_sdk",), "llm_gateway : SDK sans paramètre output_config, effort "
                   "transmis via extra_body (mettre à jour le SDK anthropic)")
        return client.messages.create(**retry)


def _parse_response(resp: Any) -> Tuple[str, Dict[str, int], Optional[str], Optional[str]]:
    """(texte, usage, stop_reason, request_id). Texte = blocs ``text`` concaténés
    (les blocs ``thinking`` sont ignorés), ``.strip()``."""
    parts: List[str] = []
    for block in _attr(resp, "content") or []:
        if _attr(block, "type") == "text":
            txt = _attr(block, "text")
            if isinstance(txt, str):
                parts.append(txt)
    raw_usage = _attr(resp, "usage")
    usage = {k: _tok(_attr(raw_usage, k)) for k in USAGE_KEYS}
    stop = _attr(resp, "stop_reason")
    rid = _attr(resp, "_request_id")
    return ("".join(parts).strip(), usage, stop if isinstance(stop, str) else None,
            str(rid)[:80] if rid else None)


# ---------------------------------------------------------------------------
# Appel principal
# ---------------------------------------------------------------------------


def _skip_reason(cfg: _Config, t: float, spend: float, key_fp: str,
                 have_factory: bool) -> Optional[str]:
    """Pourquoi l'API ne sera même pas tentée (None = on la tente)."""
    if cfg.backend == "cli":
        return "backend_cli"
    if not cfg.api_key:
        return "no_key"
    if not have_factory and not _sdk_available():
        _warn_once(("sdk_missing",), "llm_gateway : SDK « anthropic » absent ou inutilisable "
                   "dans cet environnement : appels servis par le CLI (pip install anthropic)")
        return "sdk_missing"
    blocked = _active_block(_read_state(cfg.state_dir), t, key_fp)
    if blocked:
        return "blocked:" + blocked
    if cfg.budget <= 0 or spend >= cfg.budget:
        return "budget_reached"
    return None


def _on_api_exception(cfg: _Config, reason: str, exc: BaseException, label: str,
                      notify: Optional[Callable[[str], None]], t: float, key_fp: str) -> None:
    """Effets d'un échec API : blocage + alerte (crédit, clé) ou simple log."""
    detail = _short_error(exc, cfg.api_key)
    if reason == "credit_exhausted":
        _block_api(cfg, t, BLOCK_CREDIT_S, reason, key_fp)
        logger.warning("llm_gateway[%s] crédit API épuisé : API bloquée 1 h, repli CLI (%s)",
                       label, detail)
        _alert(cfg, notify, "credit_exhausted", _text_credit(label), t, ALERT_WINDOW_S)
    elif reason == "key_invalid":
        _block_api(cfg, t, BLOCK_KEY_S, reason, key_fp)
        logger.warning("llm_gateway[%s] clé API refusée : API bloquée 6 h, repli CLI (%s)",
                       label, detail)
        _alert(cfg, notify, "key_invalid", _text_key_invalid(cfg, label), t, ALERT_WINDOW_S)
    elif reason == "bad_request":
        logger.error("llm_gateway[%s] requête API rejetée (erreur de programmation ou de "
                     "configuration) : %s", label, detail)
    elif reason == "sdk_missing":
        _warn_once(("sdk_missing",), "llm_gateway : SDK « anthropic » absent ou inutilisable "
                   "(%s) : appels servis par le CLI", detail)
    else:
        logger.warning("llm_gateway[%s] API indisponible (%s : %s), repli CLI",
                       label, reason, detail)


def _cli_text(out: Any) -> Optional[str]:
    if isinstance(out, str):
        return out.strip()
    if isinstance(out, (bytes, bytearray)):
        return bytes(out).decode("utf-8", "replace").strip()
    return None


def _serve_cli(cfg: _Config, cli: Callable[[], str], label: str, tier: str,
               reason: str, t: float) -> Result:
    """Repli CLI (ou GatewayError en mode ``api``)."""
    if cfg.backend == "api":
        msg = "API: %s; CLI: désactivé (LLM_BACKEND=api)" % reason
        logger.error("llm_gateway[%s] %s", label, msg)
        raise GatewayError(msg, api_reason=reason)
    error = None
    text = ""
    try:
        out = cli()
    except Exception as e:   # n'importe quelle panne du CLI
        error = _short_error(e, cfg.api_key, limit=200)
    else:
        parsed = _cli_text(out)
        if parsed is None:
            error = "retour non textuel (%s)" % type(out).__name__
        elif not parsed:
            error = "réponse vide"
        else:
            text = parsed
    if error is not None:
        # Levée HORS du bloc except : aucune exception d'origine (qui pourrait
        # citer un secret) n'est chaînée à la GatewayError.
        msg = "API: %s; CLI: %s" % (reason, error)
        logger.error("llm_gateway[%s] échec complet : %s", label, msg)
        raise GatewayError(msg, api_reason=reason)
    _append_ledger(cfg.state_dir,
                   _ledger_record(t, label, "cli", "cli", tier, {}, 0.0, reason, None), t)
    return Result(text=text, backend="cli", model="cli", usage={}, cost_usd=0.0,
                  fallback_reason=reason)


def complete(prompt: str, *, label: str, cli: Callable[[], str], tier: str = "sonnet",
             model: Optional[str] = None, effort: Optional[str] = None,
             max_tokens: int = 16000, timeout: float = 300.0,
             system: Optional[str] = None,
             notify: Optional[Callable[[str], None]] = None,
             client_factory: Optional[Callable[..., Any]] = None,
             now: Optional[Callable[[], float]] = None) -> Result:
    """Appel LLM : API Anthropic d'abord, ``cli()`` en repli.

    - ``label`` : nom de l'usage (journal, surcharges de tier, alertes).
    - ``cli`` : callable SANS argument fourni par l'appelant, qui lance le CLI et
      RENVOIE LE TEXTE (ou lève). Le gateway ne lance jamais le CLI lui-même.
    - ``tier`` (``opus|sonnet|haiku``) ou ``model`` (id complet, prioritaire).
    - ``effort`` : None -> défaut du tier demandé (opus et sonnet ``medium``, haiku
      ``low``), jamais envoyé par défaut à un modèle qui ne l'accepte pas.
      (Sonnet était à ``low`` au départ ; relevé à ``medium`` le 12/10 : l'ancien
      chemin CLI tournait à l'effort par défaut du modèle, et les appels du coach
      qui décident ne doivent pas perdre en profondeur au passage à l'API.)
    - ``notify(texte)`` : alertes (crédit épuisé, clé refusée, budget 80/100 %),
      dédoublonnées ; une panne de ``notify`` ne casse jamais l'appel.
    - ``client_factory(api_key=, timeout=, max_retries=)`` et ``now()`` : injectables
      (tests hors-ligne).

    Ne lève que :class:`GatewayError` (ni l'API ni le CLI n'ont répondu, ou mode
    ``api`` sans repli).
    """
    clock = now if now is not None else time.time
    t = float(clock())
    cfg = _load_config()
    lab = _clean_label(label)
    month = _month_of(t)
    spend = _month_spend(cfg.state_dir, month)
    name = _requested_name(cfg, model or tier, lab)
    req_tier = name if name in TIERS else (_family_of(name) or "custom")
    key_fp = _key_fp(cfg.api_key)

    # 1. L'API est-elle seulement envisageable ?
    reason = _skip_reason(cfg, t, spend, key_fp, client_factory is not None)
    # 2. Alertes budget (une fois par mois et par seuil).
    _budget_alerts(cfg, notify, spend, t, month)
    # 3. Non : directement le CLI (ou GatewayError en mode api).
    if reason is not None:
        expected = reason in ("backend_cli", "no_key", "sdk_missing")
        logger.log(logging.DEBUG if expected else logging.INFO,
                   "llm_gateway[%s] API écartée (%s)", lab, reason)
        return _serve_cli(cfg, cli, lab, req_tier, reason, t)

    # 4. Appel API.
    served = _resolve_name(cfg, name, _ratio(spend, cfg.budget))
    eff = effort or (DEFAULT_EFFORT.get(req_tier) if _supports_effort(served) else None)
    kwargs: Dict[str, Any] = {
        "model": served,
        "max_tokens": int(max_tokens),
        "messages": [{"role": "user", "content": prompt}],
    }
    if system:
        kwargs["system"] = system
    if eff:
        kwargs["output_config"] = {"effort": eff}
    # Jamais : temperature/top_p/top_k, thinking, tool_choice forcé, prefill (400
    # sur les modèles 5.5), ni beta ni « fallbacks ». Pas de cache_control en v1
    # (v2 possible : mettre en cache le prompt système).
    factory = client_factory if client_factory is not None else _default_client_factory
    resp = None
    failure: Optional[str] = None
    exc: Optional[BaseException] = None
    client = None
    try:
        client = factory(api_key=cfg.api_key, timeout=float(timeout), max_retries=1)
        resp = _create(client, kwargs)
    except Exception as e:
        exc = e
        failure = "sdk_missing" if isinstance(e, ImportError) else _classify(e)
    finally:
        _close_quietly(client)

    if resp is not None:
        # 5. Réponse reçue : validée, et TOUJOURS journalisée (elle a été facturée).
        text, usage, stop, rid = _parse_response(resp)
        cost = estimate_cost(served, usage)
        if stop == "refusal":
            failure = "refusal"
        elif stop == "max_tokens":
            failure = "truncated"      # un bloc JSON tronqué casserait l'appelant
        elif not text:
            failure = "empty"
        _append_ledger(cfg.state_dir, _ledger_record(t, lab, "api", served, req_tier, usage,
                                                     cost, failure, rid), t)
        if failure is None:
            logger.info("llm_gateway[%s] API %s : in=%d out=%d, ~%.4f $", lab, served,
                        usage["input_tokens"], usage["output_tokens"], cost)
            return Result(text=text, backend="api", model=served, usage=usage,
                          cost_usd=round(cost, 8), fallback_reason=None)
        category = _attr(_attr(resp, "stop_details"), "category") if failure == "refusal" else None
        logger.warning("llm_gateway[%s] réponse API écartée (%s%s), repli",
                       lab, failure, " : %s" % category if category else "")
    elif exc is not None and failure is not None:
        # 6. Échec API : blocage et alerte selon la cause.
        _on_api_exception(cfg, failure, exc, lab, notify, t, key_fp)
    else:   # le client n'a rien renvoyé, sans lever
        failure = "other"
        logger.warning("llm_gateway[%s] le client API n'a rien renvoyé, repli", lab)
    # 7. Repli CLI (ou GatewayError en mode api).
    return _serve_cli(cfg, cli, lab, req_tier, failure or "other", t)


def cli_env(base: Optional[Mapping[str, str]] = None) -> Dict[str, str]:
    """Copie de l'environnement (``os.environ`` par défaut) SANS ``ANTHROPIC_API_KEY``,
    ``ANTHROPIC_AUTH_TOKEN`` ni ``LLM_GATEWAY_API_KEY``.

    À passer à ``subprocess.run(env=...)`` pour le CLI : avec une clé API dans
    l'environnement, le CLI l'utilise À LA PLACE de l'abonnement et brûlerait le
    crédit en plein repli.
    """
    env = dict(os.environ if base is None else base)
    for name in CLI_STRIPPED_VARS:
        env.pop(name, None)
    return env


# ---------------------------------------------------------------------------
# Lecture : état et agrégats
# ---------------------------------------------------------------------------


def status(now: Optional[Callable[[], float]] = None) -> Dict[str, Any]:
    """État lisible du gateway (jamais la valeur de la clé)."""
    t = float((now or time.time)())
    cfg = _load_config()
    month = _month_of(t)
    spend = _month_spend(cfg.state_dir, month)
    ratio = _ratio(spend, cfg.budget)
    key_fp = _key_fp(cfg.api_key)
    state = _read_state(cfg.state_dir)
    blocked = _active_block(state, t, key_fp)
    sdk = _sdk_available()
    return {
        "mode": cfg.backend,
        "api_key_present": bool(cfg.api_key),
        "sdk_installed": sdk,
        "sdk_version": _sdk_version() if sdk else None,
        "month": month,
        "budget_usd": cfg.budget,
        "spent_usd": round(spend, 4),
        "spend_ratio": round(ratio, 4) if math.isfinite(ratio) else None,
        "budget_reached": cfg.budget <= 0 or spend >= cfg.budget,
        "downgrade_at": cfg.downgrade_at,
        "opus_served_by_sonnet": ratio >= cfg.downgrade_at,
        "blocked": blocked is not None,
        "blocked_reason": blocked,
        "blocked_until": _iso(state["api_blocked_until"]) if blocked else None,
        "api_skip_reason": _skip_reason(cfg, t, spend, key_fp, False),
        "models": dict(cfg.models),
        "tier_overrides": dict(cfg.tier_overrides),
        "state_dir": cfg.state_dir,
        "ledger_file": _ledger_path(cfg.state_dir, month),
        "env_file": cfg.env_file,
        "env_file_exists": os.path.isfile(cfg.env_file),
    }


def month_summary(now: Optional[Callable[[], float]] = None) -> Dict[str, Any]:
    """Agrégat du mois courant par (label, backend, model) : appels, tokens, coût.

    ``fallback_reasons`` compte les appels servis par le CLI par raison ;
    ``api_rejected`` les réponses API facturées mais écartées (refus, tronquée…).
    """
    t = float((now or time.time)())
    cfg = _load_config()
    month = _month_of(t)
    path = _ledger_path(cfg.state_dir, month)
    groups: Dict[Tuple[str, str, str], Dict[str, Any]] = {}
    totals = {"calls": 0, "api_calls": 0, "cli_calls": 0, "in": 0, "out": 0,
              "cache_read": 0, "cache_write": 0, "cost_usd": 0.0}
    fallbacks: Dict[str, int] = {}
    rejected: Dict[str, int] = {}
    for rec in _iter_ledger(path):
        backend = str(rec.get("backend") or "?")
        key = (str(rec.get("label") or "?"), backend, str(rec.get("model") or "?"))
        row = groups.setdefault(key, {"label": key[0], "backend": key[1], "model": key[2],
                                      "calls": 0, "in": 0, "out": 0, "cache_read": 0,
                                      "cache_write": 0, "cost_usd": 0.0})
        cost = _num(rec.get("cost_usd")) if backend == "api" else 0.0
        for target in (row, totals):
            target["calls"] += 1
            for field_name in ("in", "out", "cache_read", "cache_write"):
                target[field_name] += _tok(rec.get(field_name))
            target["cost_usd"] += cost
        if backend == "api":
            totals["api_calls"] += 1
        elif backend == "cli":
            totals["cli_calls"] += 1
        reason = rec.get("fallback_reason")
        if isinstance(reason, str) and reason:
            bucket = rejected if backend == "api" else fallbacks
            bucket[reason] = bucket.get(reason, 0) + 1
    rows = sorted(groups.values(), key=lambda r: (-r["cost_usd"], -r["calls"], r["label"]))
    for row in rows:
        row["cost_usd"] = round(row["cost_usd"], 6)
    totals["cost_usd"] = round(totals["cost_usd"], 6)
    return {"month": month, "ledger_file": path, "budget_usd": cfg.budget, "rows": rows,
            "totals": totals, "fallback_reasons": fallbacks, "api_rejected": rejected}


# ---------------------------------------------------------------------------
# Ligne de commande
# ---------------------------------------------------------------------------


def _unblock(now: Optional[Callable[[], float]] = None) -> Dict[str, Any]:
    """Lève un blocage API en cours (ex. juste après avoir rechargé le crédit)."""
    t = float((now or time.time)())
    cfg = _load_config()
    previous = None
    with _state_txn(cfg.state_dir) as st:
        if st["api_blocked_until"] > t:
            previous = st["blocked_reason"] or "inconnu"
        st["api_blocked_until"] = 0.0
        st["blocked_reason"] = ""
        st["blocked_key_fp"] = ""
    return {"unblocked": previous is not None, "previous_reason": previous}


def _selftest_no_cli() -> str:
    raise RuntimeError("repli CLI désactivé pendant le selftest (on teste l'API)")


def _selftest(live: bool, now: Optional[Callable[[], float]] = None) -> int:
    """Vérifications locales ; ``live`` : un petit appel API réel par tier."""
    report: Dict[str, Any] = {"status": status(now=now)}
    cfg = _load_config()
    problems: List[str] = []
    if not cfg.api_key:
        problems.append("pas de clé (LLM_GATEWAY_API_KEY dans %s) : tous les appels passent "
                        "par le CLI" % cfg.env_file)
    elif not cfg.api_key.startswith("sk-ant-"):
        problems.append("la clé n'a pas le format attendu (sk-ant-...)")
    if not report["status"]["sdk_installed"]:
        problems.append("SDK anthropic absent de cet environnement Python (%s) : "
                        "pip install anthropic" % sys.executable)
    try:
        mode = os.stat(cfg.env_file).st_mode & 0o777
    except FileNotFoundError:
        mode = None
    except OSError as e:
        mode = None
        problems.append("fichier d'env %s illisible (%s)" % (cfg.env_file, type(e).__name__))
    if mode is not None and mode & 0o077:
        problems.append("le fichier d'env %s est lisible par d'autres utilisateurs (mode %03o) : "
                        "chmod 600 %s" % (cfg.env_file, mode, cfg.env_file))
    leaked = [v for v in ("ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN") if os.environ.get(v)]
    if leaked:
        problems.append("%s défini dans l'environnement : le CLI l'utiliserait à la place de "
                        "l'abonnement -> lancer le CLI avec env=cli_env()" % "/".join(leaked))
    try:
        with _state_txn(cfg.state_dir):
            pass
    except OSError as e:
        problems.append("dossier d'état %s inutilisable (%s)" % (cfg.state_dir, type(e).__name__))
    if live:
        results = []
        for tier in TIERS:
            served = resolve_model(tier, label="selftest")
            try:
                r = complete("Réponds OK.", label="selftest", cli=_selftest_no_cli, tier=tier,
                             max_tokens=64, effort="low" if _supports_effort(served) else None,
                             now=now)
                results.append({"tier": tier, "backend": r.backend, "model": r.model,
                                "usage": r.usage, "cost_usd": r.cost_usd, "text": r.text[:40]})
            except GatewayError as e:
                hint = (" (64 tokens de sortie dépassés : réessayer, ou c'est la réflexion du "
                        "modèle)" if e.api_reason == "truncated" else "")
                results.append({"tier": tier, "model": served, "error": str(e) + hint})
                problems.append("appel live %s en échec : %s" % (tier, e))
        report["live"] = results
    report["problems"] = problems
    print(json.dumps(report, indent=2, ensure_ascii=False))
    return 1 if problems else 0


def main(argv: Optional[List[str]] = None) -> int:
    """``python -m backend.llm_gateway status | selftest [--live] | summary | unblock``."""
    parser = argparse.ArgumentParser(
        prog="llm_gateway",
        description="Passerelle LLM : API Anthropic d'abord, CLI Claude (abonnement) en repli.")
    sub = parser.add_subparsers(dest="cmd")
    sub.add_parser("status", help="clé présente, SDK, mode, budget, dépense, blocage")
    p_self = sub.add_parser("selftest", help="vérifications locales (+ --live)")
    p_self.add_argument("--live", action="store_true",
                        help="un petit appel API réel par tier (quelques fractions de centime)")
    sub.add_parser("summary", help="consommation du mois par label / backend / modèle")
    sub.add_parser("unblock", help="lève un blocage API en cours (après recharge du crédit)")
    try:
        args = parser.parse_args(argv)
    except SystemExit as e:   # --help ou arguments invalides
        return e.code if isinstance(e.code, int) else 2
    if args.cmd == "status":
        print(json.dumps(status(), indent=2, ensure_ascii=False))
        return 0
    if args.cmd == "summary":
        print(json.dumps(month_summary(), indent=2, ensure_ascii=False))
        return 0
    if args.cmd == "unblock":
        print(json.dumps(_unblock(), indent=2, ensure_ascii=False))
        return 0
    if args.cmd == "selftest":
        return _selftest(live=args.live)
    parser.print_help()
    return 2


if __name__ == "__main__":
    sys.exit(main())
