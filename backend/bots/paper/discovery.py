"""La DÉCOUVERTE — les titres qui BOUGENT AUJOURD'HUI, pas seulement les
grands noms (LOT 11).

Retour utilisateur (03/09) : l'univers du coach (positions, radar, watchlist,
pool européen — LOT 8b) est fait de GRANDS NOMS par construction (la table
``entities``, le backfill, le pool EU sont tous de grandes valeurs). « Il ne
s'intéresse qu'aux gros titres, alors qu'à tout moment il y a des titres
nouveaux ou peu connus qui pourraient monter. »

Ce module branche une CINQUIÈME source, best-effort de bout en bout : le
flux ``trending`` US de Yahoo Finance (sondé le 03/09 — un mélange de
grands noms ET de titres peu connus qui bougent : ``CHPT``, ``RARE``,
``CRCL``, ``SPCX``...). La DÉCOUVERTE est un BONUS, jamais un point de
panne : toute erreur réseau, JSON, cotation ou tradabilité réduit
simplement le nombre de candidats rendus, elle ne lève jamais.

Cache disque 15 minutes (:data:`CACHE_TTL_S`, patron ``agenda_bridge.py`` /
``store.py``) : trois passes planifiées par jour ouvré plus le gardien ne
doivent pas re-marteler Yahoo à chaque appel.
"""
import json
import logging
import os
import time
from datetime import datetime
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional

from . import coach_trader, quotes

logger = logging.getLogger("omenserver")

# backend/bots/paper/discovery.py -> racine projet = parents[3]
_PROJECT_ROOT = Path(__file__).resolve().parents[3]
DATA_DIR = _PROJECT_ROOT / "data" / "paper_trading"

# ⚠️ Le POINT dans le nom n'est pas cosmétique — même piège documenté dans
# ``agenda_bridge.py`` : les fichiers de ce dossier sont recensés comme des
# COMPTES par ``radar._users_with_portfolio`` (regex ``^[A-Za-z0-9_-]+\\.json$``).
# Un radical qui porte un point ne peut PAS matcher.
CACHE_NAME = "discovery.cache.json"
CACHE_TTL_S = 15 * 60.0

TRENDING_URL = "https://query1.finance.yahoo.com/v1/finance/trending/US"
TIMEOUT_S = 8.0
DEFAULT_COUNT = 15

# Provenance des candidats de ce module — la CINQUIÈME valeur possible du
# champ ``source`` d'un candidat du coach (les quatre premières vivent dans
# ``paper_router.CANDIDATE_SOURCE_*``, LOT 8b). Le prompt de tri
# (``llm.build_coach_screen_prompt``) l'explique au modèle.
CANDIDATE_SOURCE_DISCOVERY = "tendance"

# Combien de titres tendance au PLUS, par défaut — le routeur applique en
# plus sa propre place restante sous le plafond total fusionné (LOT 8b/11).
DEFAULT_CAP = 4

_now: Callable[[], float] = time.time       # horloge du cache (injectable)


# --------------------------------------------------------------------------- #
# Client HTTP (paresseux, injectable) — patron ``whales.py``
# --------------------------------------------------------------------------- #
_client = None


def get_client():
    """Client httpx partagé du module (créé à la première demande)."""
    global _client
    if _client is None:
        import httpx
        _client = httpx.Client(timeout=TIMEOUT_S)
    return _client


def set_client(client) -> None:
    """Remplace le client module (tests, ou client partagé maison)."""
    global _client
    _client = client


def _trending_url(count: int) -> str:
    try:
        n = max(1, int(count))
    except (TypeError, ValueError):
        n = DEFAULT_COUNT
    return "%s?count=%d" % (TRENDING_URL, n)


def _parse_trending(payload: Any) -> List[str]:
    """PUR — la forme RÉELLE sondée le 03/09 : ``{"finance": {"result":
    [{"quotes": [{"symbol": ...}, ...]}]}}``. Toute déviation (contrat
    externe changé, réponse tronquée) rend une liste vide, jamais une
    exception."""
    if not isinstance(payload, dict):
        return []
    finance = payload.get("finance")
    result = finance.get("result") if isinstance(finance, dict) else None
    if not isinstance(result, list) or not result:
        return []
    first = result[0]
    quotes_list = first.get("quotes") if isinstance(first, dict) else None
    if not isinstance(quotes_list, list):
        return []
    out: List[str] = []
    for row in quotes_list:
        if not isinstance(row, dict):
            continue
        symbol = row.get("symbol")
        if isinstance(symbol, str) and symbol.strip():
            out.append(symbol.strip())
    return out


def fetch_trending(client=None, count: int = DEFAULT_COUNT) -> List[str]:
    """Les tickers du flux ``trending`` US de Yahoo Finance, dans l'ordre
    rendu — best-effort STRICT : toute panne (réseau, statut, JSON illisible,
    forme inattendue) rend ``[]``, jamais une exception. La découverte est un
    bonus, elle ne doit jamais coûter une passe du coach."""
    cli = client if client is not None else get_client()
    url = _trending_url(count)
    try:
        resp = cli.get(url, timeout=TIMEOUT_S)
    except Exception as exc:                      # noqa: BLE001 — transport
        logger.warning("paper discovery: tendance indisponible (%s)",
                       type(exc).__name__)
        return []
    status = getattr(resp, "status_code", 0)
    if status != 200:
        logger.warning("paper discovery: tendance a répondu %s", status)
        return []
    try:
        payload = resp.json()
    except Exception as exc:                      # noqa: BLE001 — corps illisible
        logger.warning("paper discovery: tendance illisible (%s)",
                       type(exc).__name__)
        return []
    return _parse_trending(payload)


# --------------------------------------------------------------------------- #
# Cache 15 min — écriture ATOMIQUE 0o600 (patron obligatoire du dépôt,
# ``agenda_bridge._atomic_write_json``)
# --------------------------------------------------------------------------- #

def cache_path() -> Path:
    return DATA_DIR / CACHE_NAME


def _atomic_write_json(path: Path, data: Any) -> None:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = path.parent / (".%s.tmp-%d" % (path.name, os.getpid()))
    fd = os.open(str(tmp_path), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    try:
        os.fchmod(fd, 0o600)
    except (AttributeError, OSError):
        pass
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(data, handle, ensure_ascii=False, indent=2)
        os.replace(str(tmp_path), str(path))
    except Exception:
        try:
            os.remove(str(tmp_path))
        except OSError:
            pass
        raise


def _load_cache() -> Dict[str, Any]:
    """Cache absent ou corrompu -> cache vide, jamais d'exception."""
    path = cache_path()
    if not path.is_file():
        return {}
    try:
        with open(str(path), "r", encoding="utf-8") as handle:
            data = json.load(handle)
    except (OSError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


def _as_datetime(value: Any) -> datetime:
    """Normalise ``now`` : ``datetime`` tel quel, chaîne ISO parsée, epoch
    numérique -> ``datetime``. Illisible ou absent -> l'horloge du module
    (:data:`_now`, injectable) — jamais une date arbitraire."""
    if isinstance(value, datetime):
        return value
    if isinstance(value, str):
        try:
            return datetime.fromisoformat(value)
        except ValueError:
            return datetime.fromtimestamp(_now())
    if value is None:
        return datetime.fromtimestamp(_now())
    try:
        return datetime.fromtimestamp(float(value))
    except (TypeError, ValueError, OverflowError, OSError):
        return datetime.fromtimestamp(_now())


def trending_symbols(now: Any = None, client=None, count: int = DEFAULT_COUNT,
                     force: bool = False) -> List[str]:
    """La liste TENDANCE, mise en cache :data:`CACHE_TTL_S` (15 min) — trois
    passes planifiées par jour ouvré plus le gardien ne doivent pas la
    redemander à chaque appel (même politique que
    ``agenda_bridge.upcoming_events``) :

      1. cache frais (< 15 min) et ``force`` absent -> servi tel quel, zéro
         requête ;
      2. sinon on tente un fetch frais ; NON VIDE -> remplace le cache ;
      3. fetch vide ou en panne -> sert le cache PÉRIMÉ s'il existe (une
         tendance vieille de quelques minutes vaut mieux qu'aucune), sinon
         liste vide.

    Ne lève JAMAIS.
    """
    now_dt = _as_datetime(now)
    stamp = now_dt.timestamp()

    cached = _load_cache()
    rows = cached.get("symbols") if isinstance(cached.get("symbols"), list) else []
    try:
        cached_ts = float(cached.get("fetched_ts"))
    except (TypeError, ValueError):
        cached_ts = None

    fresh = (rows and cached_ts is not None
             and 0 <= (stamp - cached_ts) < CACHE_TTL_S)
    if fresh and not force:
        return list(rows)

    fetched = fetch_trending(client=client, count=count)
    if fetched:
        try:
            _atomic_write_json(cache_path(), {"fetched_ts": stamp,
                                              "fetched_at": now_dt.isoformat(),
                                              "symbols": fetched})
        except OSError:
            pass                                  # un cache non écrit n'invalide
                                                  # pas une donnée déjà obtenue
        return fetched
    return list(rows)


# --------------------------------------------------------------------------- #
# discovery_candidates — le filtre complet, prêt pour la 5e source du coach
# --------------------------------------------------------------------------- #

def _default_quote(symbol: str) -> Optional[Dict[str, Any]]:
    """Un titre est-il COTABLE ? Même garde-fou que
    ``paper_router._coach_quote`` (prix valide), en plus petit : la
    découverte n'a besoin que de savoir SI le titre a un prix, pas de le
    porter — ``_coach_candidates`` recotera chaque candidat retenu,
    découverte comprise, à l'étape suivante."""
    try:
        q = quotes.get_quote(symbol)
    except Exception:                             # noqa: BLE001 — best-effort
        return None
    if not isinstance(q, dict):
        return None
    try:
        price = float(q.get("price"))
    except (TypeError, ValueError):
        return None
    return q if price > 0 else None


def discovery_candidates(existing_symbols: Any, now: Any,
                         quote: Optional[Callable[[str], Any]] = None,
                         cap: int = DEFAULT_CAP) -> List[Dict[str, Any]]:
    """Jusqu'à ``cap`` titres TENDANCE, ABSENTS (canonique) de
    ``existing_symbols``, tradables MAINTENANT et COTABLES — chacun porte
    ``{"symbol", "source": CANDIDATE_SOURCE_DISCOVERY}``.

    Best-effort de bout en bout (cf. tête de module) : la tendance en panne,
    un cours qui lève, un ``now`` illisible RÉDUISENT le nombre de candidats
    rendus, jamais une exception.
    """
    try:
        cap_n = max(0, int(cap))
    except (TypeError, ValueError):
        cap_n = DEFAULT_CAP
    if cap_n == 0:
        return []

    existing = set()
    for raw in (existing_symbols if isinstance(existing_symbols, (list, tuple, set))
               else []):
        if isinstance(raw, str):
            symbol = quotes.canonical(raw)
            if symbol:
                existing.add(symbol)

    quote_fn = quote if quote is not None else _default_quote

    try:
        trending = trending_symbols(now=now)
    except Exception as exc:                      # noqa: BLE001 — best-effort
        logger.warning("paper discovery: tendance indisponible (%s)",
                       type(exc).__name__)
        trending = []

    out: List[Dict[str, Any]] = []
    seen: set = set()
    for raw in trending or []:
        symbol = quotes.canonical(raw) if isinstance(raw, str) else ""
        if not symbol or symbol in existing or symbol in seen:
            continue
        try:
            if not coach_trader.tradable_now(symbol, now):
                continue
        except Exception:                          # noqa: BLE001 — best-effort
            continue
        try:
            q = quote_fn(symbol)
        except Exception:                          # noqa: BLE001 — best-effort
            q = None
        if not q:
            continue
        seen.add(symbol)
        out.append({"symbol": symbol, "source": CANDIDATE_SOURCE_DISCOVERY})
        if len(out) >= cap_n:
            break
    return out
