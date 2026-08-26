"""L'agenda des banques centrales — pont vers le moteur ``market-pulse/``.

Le simulateur n'a pas besoin d'un second parseur de calendriers : Market Pulse
en a déjà cinq, sondés à la main et verrouillés par des tests (Fed, BoJ, BNS,
BCE, BoE + un fichier curé pour tout le reste). Ce module ne fait donc **que
brancher** : il emprunte ``pulse.agenda``, met le résultat en cache 24 h et le
rend sous la forme minimale dont le coach a besoin.

Pourquoi un rendez-vous DATÉ vaut plus qu'une rumeur : la moitié du contexte du
coach est faite de dépêches dont il ne peut pas dire quand elles produiront un
effet. Une réunion du FOMC, elle, a une date. C'est la seule matière du contexte
sur laquelle on peut construire un « avant / pendant / après ».

Chemin de l'import : ``backend/bots/market_engine.py`` est, par doctrine, **le
seul endroit du backend qui sait où vit ``market-pulse/``** (répertoire frère au
nom tirété, donc ``import pulse.agenda`` ne marche pas tel quel). On lui demande
le module au lieu de refaire son ``sys.path`` — deux endroits qui connaissent le
chemin, c'est un endroit de trop le jour où il bouge.

⚠️ Deux pièges HÉRITÉS de la source, vérifiés côté moteur et re-verrouillés ici
par des tests qui traversent les VRAIS parseurs :

* **une réunion sur deux jours se date au DERNIER jour** (« October 27-28 » se
  conclut le 28 — annoncer le 27 ferait attendre le communiqué un jour trop
  tôt) ;
* **le flux RSS de la BNS est servi du plus LOINTAIN au plus proche** (2028 en
  premier) : un parseur qui ferait confiance à ``items[0]`` annoncerait 2028
  comme prochain rendez-vous.

⚠️ Garde-fou central, appliqué DEUX fois : une date passée ne sort jamais d'ici.
Le moteur l'écarte à la collecte, et on la ré-écarte à la LECTURE DU CACHE —
sans quoi un cache de la veille ressortirait la réunion d'hier comme « à
venir » pendant vingt-quatre heures.

Les libellés arrivent en ITALIEN : ce sont ceux du moteur, écrits pour le
briefing du grand-père. On les recopie **tels quels** plutôt que de forker cinq
parseurs pour une question de langue — le coach, lui, répond dans la langue
demandée et n'a aucun mal à lire « riunione del FOMC ».

Tout est injectable (``fetch``, ``sleep``, ``now``, ``collect``) : les tests
tournent 100 % hors ligne.
"""
import json
import logging
import os
import re
import time
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional

logger = logging.getLogger("omenserver")

# backend/bots/paper/agenda_bridge.py -> racine projet = parents[3]
_PROJECT_ROOT = Path(__file__).resolve().parents[3]
DATA_DIR = _PROJECT_ROOT / "data" / "paper_trading"

# ⚠️ Le POINT dans le nom n'est pas cosmétique. Les fichiers de ce dossier sont
# recensés comme des COMPTES par ``radar._users_with_portfolio`` (regex
# ``^[A-Za-z0-9_-]+\.json$``), et la convergence écrit un carnet à chaque compte
# qu'elle trouve — un ``agenda_cache.json`` deviendrait un utilisateur fantôme
# nommé « agenda_cache ». Le dépôt a déjà payé ce bug deux fois (``alerts_mode``,
# ``x_accounts``, puis ``backfill``) et l'a rattrapé à chaque fois par une liste
# d'exclusion. Un radical qui porte un point ne peut PAS matcher : c'est
# structurel, ça ne s'oublie pas, et ça ne demande rien au module d'à côté.
CACHE_NAME = "agenda.cache.json"
CACHE_TTL_S = 24 * 3600.0

# Horizon du contexte du coach. Trois semaines : assez loin pour qu'une idée à
# dix jours sache ce qu'elle va traverser, assez court pour que la liste reste
# une liste. (Le moteur, lui, par défaut à sept jours — c'est la fenêtre d'un
# briefing quotidien, pas celle d'une stratégie.)
DEFAULT_HORIZON_D = 21

# Plafond de la collecte. Le moteur en rend huit par défaut, calibré pour une
# section de briefing ; sur trois semaines et cinq banques centrales, huit
# tronquerait en silence.
MAX_ITEMS = 40

# Pacing du moteur entre deux sources (low-and-slow : on ne martèle personne).
PACING_S = 0.4

_now: Callable[[], float] = time.time       # horloge du cache (injectable)


# --------------------------------------------------------------------------- #
# Accès au moteur
# --------------------------------------------------------------------------- #

def agenda_module():
    """Le module ``pulse.agenda`` du moteur Market Pulse, ou ``None``.

    ``None`` et non une exception : un déploiement partiel (le simulateur sans
    Market Pulse) doit coûter l'agenda, jamais le contexte du coach.
    """
    try:
        from backend.bots import market_engine
        return market_engine._pulse("agenda")
    except Exception as exc:                      # noqa: BLE001 — best-effort
        logger.warning("paper agenda: moteur market-pulse indisponible (%s)",
                       type(exc).__name__)
        return None


# --------------------------------------------------------------------------- #
# PUR — normalisation et fenêtrage
# --------------------------------------------------------------------------- #

def _text(value: Any) -> str:
    return " ".join(str(value or "").split())


# ⚠️ Un jour se VALIDE, il ne se mesure pas. Une première version se contentait
# de tronquer à dix caractères et de vérifier la longueur : « pas-une-date »
# passait (ses dix premiers caractères en font dix) et ressortait comme une
# date. Tout le fenêtrage compare ensuite ces chaînes entre elles — une fausse
# date se serait donc rangée quelque part dans l'ordre, en silence.
_DAY_RE = re.compile(r"^(\d{4}-\d{2}-\d{2})")


def _day_of(value: Any) -> str:
    """Le JOUR ``AAAA-MM-JJ`` d'une valeur, ou ``""`` si ce n'en est pas une.

    Accepte un horodatage complet (le RSS de la BNS date à la minute) et n'en
    garde que le jour : mélanger les deux formes dans un contexte de LLM invite
    à des comparaisons fausses.
    """
    found = _DAY_RE.match(_text(value))
    return found.group(1) if found else ""


def normalize(events: Any) -> List[Dict[str, str]]:
    """Les événements du moteur → ``[{date, bank, label, source_url}]`` (PUR).

    ``date`` est le JOUR (``AAAA-MM-JJ``), validé par ``_day_of`` — pas une
    troncature à dix caractères.

    Un événement sans date lisible ou sans libellé est écarté : il ne dirait ni
    quand, ni quoi.
    """
    out: List[Dict[str, str]] = []
    for event in events or []:
        if not isinstance(event, dict):
            continue
        date = _day_of(event.get("when"))
        label = _text(event.get("what"))
        if not date or not label:
            continue
        out.append({
            "date": date,
            "bank": _text(event.get("source")) or "agenda",
            "label": label,
            # Le lien qui PROUVE la date. Il ne voyage pas dans les événements
            # de la mémoire (deux réunions d'une même banque partagent la même
            # page, et la mémoire dédoublonne par lien — elles fusionneraient) ;
            # il voyage ici, où il ne sert qu'à vérifier.
            "source_url": _text(event.get("source_url")),
        })
    out.sort(key=lambda row: (row["date"], row["bank"], row["label"]))
    return out


def _as_datetime(value: Any) -> datetime:
    """Normalise une horloge : ``datetime`` tel quel, epoch -> ``datetime``.
    Illisible -> maintenant (on ne fabrique jamais une date arbitraire)."""
    if isinstance(value, datetime):
        return value
    try:
        return datetime.fromtimestamp(float(value))
    except (TypeError, ValueError, OverflowError, OSError):
        return datetime.fromtimestamp(_now())


def events_within(rows: Any, now: Any = None,
                  days: int = DEFAULT_HORIZON_D) -> List[Dict[str, str]]:
    """Les rendez-vous entre AUJOURD'HUI et ``days`` jours (PUR).

    La borne basse est le JOUR COURANT et non l'instant : un rendez-vous daté
    « au jour » compte jusqu'à la fin de sa journée — c'est précisément le jour
    où il compte, le faire disparaître à 00:00:01 serait absurde (même règle que
    ``pulse.agenda._still_ahead``).
    """
    now_dt = _as_datetime(now if now is not None else _now())
    today = now_dt.strftime("%Y-%m-%d")
    try:
        span = max(0, int(days))
    except (TypeError, ValueError):
        span = DEFAULT_HORIZON_D
    last = (now_dt + timedelta(days=span)).strftime("%Y-%m-%d")
    out = []
    for row in rows or []:
        if not isinstance(row, dict):
            continue
        date = _day_of(row.get("date"))
        if not date or date < today or date > last:
            continue
        out.append(dict(row))
    out.sort(key=lambda r: (r["date"], r.get("bank") or "", r.get("label") or ""))
    return out


# --------------------------------------------------------------------------- #
# Cache 24 h — écriture ATOMIQUE 0o600 (patron obligatoire du dépôt)
# --------------------------------------------------------------------------- #

def cache_path() -> Path:
    return DATA_DIR / CACHE_NAME


def _atomic_write_json(path: Path, data: Any) -> None:
    """Le temporaire NAÎT en 0o600 (``os.open``, pas de fenêtre
    world-readable), puis ``os.replace`` bascule d'un coup."""
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


# --------------------------------------------------------------------------- #
# API publique
# --------------------------------------------------------------------------- #

def upcoming_events(now: Any = None,
                    fetch: Optional[Callable[[str], Any]] = None,
                    horizon_days: int = DEFAULT_HORIZON_D,
                    sleep: Optional[Callable[[float], None]] = None,
                    collect: Optional[Callable[..., Any]] = None,
                    force: bool = False) -> List[Dict[str, str]]:
    """Les rendez-vous datés des banques centrales — ``[{date, bank, label,
    source_url}]``, du plus proche au plus lointain.

    Politique du cache, dans cet ordre :

      1. cache frais (< 24 h) et ``force`` absent → on le sert, zéro requête ;
      2. sinon on collecte ; une collecte NON VIDE remplace le cache ;
      3. collecte vide ou en panne → on sert le cache PÉRIMÉ s'il existe. Cinq
         sites de banque centrale muets en même temps, c'est un incident de
         réseau, pas un monde sans réunions.

    Dans les trois cas, la liste est re-fenêtrée à la lecture : une date passée
    ne sort jamais d'ici (cf. le garde-fou central en tête de fichier).

    Ne lève JAMAIS : perdre l'agenda ne doit pas coûter une réponse du coach.
    """
    now_dt = _as_datetime(now if now is not None else _now())
    stamp = now_dt.timestamp()

    cached = _load_cache()
    rows = cached.get("events") if isinstance(cached.get("events"), list) else []
    try:
        cached_ts = float(cached.get("fetched_ts"))
    except (TypeError, ValueError):
        cached_ts = None

    fresh = (rows and cached_ts is not None
             and 0 <= (stamp - cached_ts) < CACHE_TTL_S)
    if fresh and not force:
        return events_within(rows, now_dt, horizon_days)

    collected = _collect(now_dt, fetch, horizon_days, sleep, collect)
    if collected:
        try:
            _atomic_write_json(cache_path(),
                               {"fetched_ts": stamp,
                                "fetched_at": now_dt.isoformat(),
                                "events": collected})
        except OSError:
            pass                                  # un cache non écrit n'invalide
                                                  # pas une donnée déjà obtenue
        return events_within(collected, now_dt, horizon_days)

    # Rien de neuf : le périmé vaut mieux que le vide (et le fenêtrage ci-dessous
    # garantit qu'aucune date révolue n'en sort).
    return events_within(rows, now_dt, horizon_days)


def _collect(now_dt: datetime, fetch, horizon_days, sleep, collect) -> List[Dict[str, str]]:
    """Une collecte, best-effort intégral -> ``[]` en cas de pépin."""
    collector = collect
    if collector is None:
        module = agenda_module()
        if module is None:
            return []
        collector = module.collect_agenda
    kwargs: Dict[str, Any] = {
        "now_ts": int(now_dt.timestamp()),
        "horizon_h": float(max(0, int(horizon_days or 0))) * 24.0,
        "max_items": MAX_ITEMS,
        "pacing_s": PACING_S,
    }
    if fetch is not None:
        kwargs["fetch"] = fetch
    if sleep is not None:
        kwargs["sleep"] = sleep
    try:
        result = collector(**kwargs)
    except Exception as exc:                      # noqa: BLE001 — best-effort
        logger.warning("paper agenda: collecte impossible (%s)", type(exc).__name__)
        return []
    events = (result or {}).get("events") if isinstance(result, dict) else result
    return normalize(events)
