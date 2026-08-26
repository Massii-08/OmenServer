"""Dossier HISTORIQUE des titres suivis — la BASE que la mémoire vive n'a pas.

Le problème, tel que l'utilisateur l'a posé : « envoyer le radar chercher des
VIEILLES infos qui donnent une BASE aux infos qu'on a maintenant ». La mémoire
du simulateur (``data/paper_trading/``) ne contient que quelques JOURS
d'événements — la veille ne garde pas d'archive. Résultat : le coach lit une
dépêche du jour sans savoir si elle rompt avec douze mois de calme ou si elle
répète la même histoire pour la quatrième fois. Une nouvelle n'est NEUVE que
par rapport à quelque chose.

Ce module va donc chercher, **en pur code (zéro LLM)**, ce que la presse a
écrit sur chaque titre suivi au cours des douze derniers mois, découpé en
quatre fenêtres trimestrielles, et le range en un dossier par symbole que le
coach, le radar et la revue de positions lisent comme n'importe quel autre
fait.

SOURCE — Google News RSS avec opérateurs de dates, sondée le 26/08 :
``news.google.com/rss/search?q="Nvidia" after:2025-06-01 before:2025-09-01``
→ 200, 101 items, **100/100 dans la fenêtre demandée**. L'opérateur est donc
fiable : on lui fait confiance pour le découpage, sans refiltrer les dates
côté client (on jette seulement les items dont la date est illisible).

⚠️ On interroge le **NOM**, jamais le ticker : la presse écrit « Nestlé », pas
« NESN.SW ». Les suffixes de forme juridique (S.A./Inc/Corp…) sont retirés de
la requête — et EUX SEULS : retirer « Worldwide », « Holdings » ou « Capital »
fabrique des faux positifs sur une AUTRE entité (piège #29a du dépôt, vécu sur
Hilton Worldwide → Hilton Grand Vacations).

RÉUTILISATION, jamais duplication (le module ne redéfinit rien de ce que la
veille sait déjà faire) :
  - ``newswatch.parse_rss``  — le parseur RSS 2.0 du volet politique, qui lit
    déjà Google News (titre + ``pubDate``) ;
  - ``newswatch.classify``   — les classifieurs pos/neg/watch, mots-clés
    FR/EN/IT compris ;
  - ``newswatch._fetch_rss`` — le client curl_cffi (empreinte TLS Chrome,
    session partagée). Nom privé assumé : le dupliquer ouvrirait une SECONDE
    session TLS et une seconde politique de pacing, exactement ce qu'on veut
    éviter. Tout est de toute façon injectable (``fetch``/``sleep``).
  - ``newswatch._discover_portfolios`` / ``_merged_symbols`` — les lecteurs
    d'ancres (positions ∪ watchlist). Les redéfinir ici, c'est recopier la
    liste d'exclusion des fichiers de module — et c'est précisément comme ça
    qu'on fabrique un utilisateur fantôme.

Séparation PUR / I-O, même règle que ``newswatch.py`` et ``store.py`` :
  - PUR : ``quarter_windows`` / ``query_name`` / ``search_url`` / ``is_advice``
    / ``digest_for`` (à état fourni) — zéro I/O, 100 % testable hors ligne ;
  - I/O : ``load_state`` / ``save_state`` / ``backfill_symbol`` /
    ``anchor_symbols`` / ``pending_backfills`` / ``run_pending`` — et TOUT ce
    qui sort de la machine (``fetch``, ``sleep``, ``now``, ``resolve_name``)
    est injectable.

FILE DE TRAVAIL NON BLOQUANTE. Un dossier coûte quatre requêtes espacées de
1,1 s : le construire pour toute la watchlist d'un coup gèlerait l'appelant.
``run_pending`` en traite donc **un** par défaut, et se rappelle tout seul au
fil des passages du radar. Un dossier vaut 30 jours (``FRESH_DAYS``) : on ne
repaie pas douze mois d'archives chaque nuit.

État : ``data/paper_trading/backfill.json``, écriture ATOMIQUE 0o600 (le
fichier temporaire NAÎT en 0o600 via ``os.open`` — jamais un ``open()`` suivi
d'un ``chmod()``), même patron que ``radar.save_state``.

⚠️ ``backfill.json`` vit dans le MÊME répertoire que les portefeuilles et son
radical ne porte pas de point : sans exclusion explicite, « backfill » serait
recensé comme un compte et recevrait un carnet — le bug des utilisateurs
fantômes. D'où les deux verrous posés en même temps que ce module :
``radar._NON_USER_FILES`` et ``store.RESERVED_VAULT_NAMES``.

Aucune nouvelle dépendance : stdlib + le client curl_cffi déjà utilisé par la
veille.
"""
import json
import logging
import os
import re
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional
from urllib.parse import quote

logger = logging.getLogger("omenserver")

# --------------------------------------------------------------------------- #
# Constantes
# --------------------------------------------------------------------------- #

STATE_NAME = "backfill.json"

# Quatre fenêtres de 91 jours = 364 jours, contiguës et sans recouvrement :
# « les douze derniers mois » découpés en trimestres. Le trimestre est la
# bonne maille — c'est celle des résultats d'entreprise, donc celle où une
# histoire a le temps de naître et de retomber.
WINDOWS = 4
WINDOW_DAYS = 91

# Douze titres par fenêtre : assez pour qu'un trimestre raconte quelque chose,
# assez peu pour qu'un dossier complet (48 lignes) reste lisible et que le
# fichier ne devienne pas une archive de presse.
MAX_ITEMS_PER_WINDOW = 12

# Un dossier est valable 30 jours. Douze mois d'archives ne bougent pas d'un
# jour à l'autre : le refaire chaque nuit ne serait que du trafic.
FRESH_DAYS = 30

# Piège #67 : un burst de requêtes vaut un 429. Même plancher que la veille.
PACE_S = 1.1

# Longueurs bornées : à l'écriture (un titre aberrant ne gonfle pas le
# fichier), et à la lecture (le dossier voyage dans un prompt).
MAX_TITLE_STORED = 200
MAX_TITLE_LINE = 120

# Lignes de dossier servies par défaut à un consommateur.
DIGEST_LINES = 6

# Sentiment des titres que les classifieurs ne rangent nulle part. Ils ne sont
# PAS jetés : douze mois de titres ordinaires, c'est justement la base sur
# laquelle une nouvelle du jour se détache.
NEUTRAL = "neutre"

_GNEWS_URL = ("https://news.google.com/rss/search?q=%s"
              "&hl=en-US&gl=US&ceid=US:en")

# Suffixes de FORME JURIDIQUE, et eux seuls (piège #29a : « Worldwide »,
# « Holdings », « Finance », « Capital » font partie du NOM et les retirer
# désigne une autre entité). Comparaison faite sur le token dépouillé de ses
# points et mis en minuscules — « S.A. », « SA » et « s.a. » sont le même mot.
_LEGAL_SUFFIXES = frozenset({
    "sa", "spa", "sas", "srl", "nv", "bv", "ag", "gmbh", "kgaa", "oyj", "ab",
    "asa", "as", "plc", "ltd", "limited", "inc", "incorporated", "corp",
    "corporation", "co", "llc", "lp", "llp", "pte", "pty", "cie", "sarl",
    "se", "kk", "adr", "class",
})

_SYMBOL_RE = re.compile(r"^[A-Za-z0-9._^=-]{1,24}$")


# =========================================================================== #
#  PUR — fenêtres, requête, format
# =========================================================================== #

def _naive(value: datetime) -> datetime:
    """Ramène un datetime en UTC NAÏF (même convention que ``radar._naive``) :
    comparer un datetime naïf à un datetime avec fuseau lève un TypeError, et
    ce module reçoit des dates de trois sources différentes."""
    if value.tzinfo is not None:
        return value.astimezone(timezone.utc).replace(tzinfo=None)
    return value


def quarter_windows(now: Optional[datetime] = None) -> List[Dict[str, str]]:
    """Les ``WINDOWS`` fenêtres trimestrielles couvrant les douze derniers
    mois, **de la plus ANCIENNE à la plus récente** (PUR).

    Contiguës et sans recouvrement : la borne ``to`` d'une fenêtre est la borne
    ``from`` de la suivante. Google News traite ``after``/``before`` comme des
    bornes de journée, donc un titre publié pile à la charnière peut apparaître
    des deux côtés — c'est sans conséquence : ``ts`` reste sa vraie date, et le
    dossier est de toute façon dédoublonné à la lecture par sa mise en forme
    chronologique.
    """
    ref = _naive(now) if isinstance(now, datetime) else datetime.utcnow()
    today = ref.date()
    out: List[Dict[str, str]] = []
    for index in range(WINDOWS):
        start = today - timedelta(days=WINDOW_DAYS * (WINDOWS - index))
        end = today - timedelta(days=WINDOW_DAYS * (WINDOWS - index - 1))
        out.append({"from": start.isoformat(), "to": end.isoformat()})
    return out


def query_name(name: Any) -> str:
    """Le nom tel qu'on l'envoie à la presse : sans suffixe de forme juridique
    (PUR).

    « NVIDIA Corporation » -> « NVIDIA », « Nestlé S.A. » -> « Nestlé »,
    « Alphabet Inc. » -> « Alphabet ». Mais « ASML Holding N.V. » -> « ASML
    Holding » : ``Holding`` fait partie du nom, pas de la forme juridique.

    Un nom qui ne serait QUE des suffixes est rendu tel quel — mieux vaut une
    requête bancale qu'une requête vide, qui ramènerait la une du jour.
    """
    text = " ".join(str(name or "").replace(",", " ").split())
    if not text:
        return ""
    tokens = text.split(" ")
    while len(tokens) > 1:
        last = tokens[-1].replace(".", "").lower()
        if last in _LEGAL_SUFFIXES:
            tokens.pop()
            continue
        break
    stripped = " ".join(tokens).strip(" .-")
    return stripped or text


def search_url(name: Any, window: Optional[Dict[str, Any]] = None) -> str:
    """L'URL Google News RSS d'un nom sur une fenêtre (PUR).

    Le nom part ENTRE GUILLEMETS : sans eux, « Alphabet » ramène de la
    linguistique et « Visa » de l'administratif. Fenêtre absente ou incomplète
    -> requête sans borne de date (le comportement le moins surprenant : on
    interroge quand même, sur l'actualité récente).
    """
    term = query_name(name)
    parts = ['"%s"' % term] if term else []
    if isinstance(window, dict):
        if window.get("from"):
            parts.append("after:%s" % window["from"])
        if window.get("to"):
            parts.append("before:%s" % window["to"])
    return _GNEWS_URL % quote(" ".join(parts), safe="")


def is_advice(title: Any) -> bool:
    """Ce titre est-il un CONSEIL d'investissement (PUR) ?

    Doctrine Market Pulse (piège #67d) : « 3 stocks to buy right now » recopié
    dans notre dossier se lirait comme l'avis DU COACH. Un conseil n'entre donc
    jamais dans l'historique — les autres titres neutres, si.

    Le vocabulaire est celui de la veille (``newswatch._ADVICE_KEYWORDS``), lu
    par ``getattr`` : si la veille n'est pas déployée ou renomme sa liste, on
    rend ``False`` plutôt que de faire tomber une collecte — la classification
    de sentiment, elle, tombera au neutre par le même chemin.
    """
    text = str(title or "").lower()
    if not text:
        return False
    try:
        from backend.bots.paper import newswatch
    except Exception:      # noqa: BLE001 — veille absente (déploiement partiel)
        return False
    keywords = getattr(newswatch, "_ADVICE_KEYWORDS", None)
    matches = getattr(newswatch, "_keyword_matches", None)
    if not keywords or not callable(matches):
        return False
    try:
        return any(matches(text, keyword) for keyword in keywords)
    except Exception:      # noqa: BLE001
        return False


def _classify(title: Any) -> str:
    """Le sentiment d'un titre, via les classifieurs de la veille. Rien de
    reconnu (ou veille absente) -> ``NEUTRAL``."""
    try:
        from backend.bots.paper import newswatch
        return newswatch.classify(str(title or "")) or NEUTRAL
    except Exception:      # noqa: BLE001
        return NEUTRAL


def _norm_symbol(value: Any) -> str:
    """Symbole normalisé (majuscules, sans espace). Forme inattendue -> ``""``
    (une watchlist abîmée ne doit jamais faire tomber une collecte)."""
    text = str(value or "").strip().upper()
    return text if _SYMBOL_RE.match(text) else ""


def _symbol_root(symbol: Any) -> str:
    """« NESN.SW » -> « NESN ». Dernier recours quand on n'a AUCUN nom : une
    requête sur un ticker ne vaut pas grand-chose, mais elle vaut mieux que
    pas de dossier du tout."""
    return str(symbol or "").split(".")[0].strip()


def _short(title: Any, limit: int) -> str:
    """Titre borné, coupé sur un mot quand c'est possible (piège #68h : une
    ligne tronquée en plein milieu d'un mot se lit mal dans un prompt)."""
    text = " ".join(str(title or "").split())
    if len(text) <= limit:
        return text
    cut = text[:limit]
    space = cut.rfind(" ")
    if space > limit // 2:
        cut = cut[:space]
    return cut.rstrip(" ,;:-") + "…"


def _is_signal(item: Any) -> bool:
    """L'item porte-t-il un sentiment CLASSÉ (pos/neg/watch) ?"""
    return (isinstance(item, dict)
            and str(item.get("sentiment") or NEUTRAL) != NEUTRAL)


def _digest_lines(entry: Any, limit: int) -> List[str]:
    """Les lignes de dossier d'un symbole (PUR) — ``"AAAA-MM titre (sentiment)"``.

    Deux règles, et elles comptent autant l'une que l'autre :

    1. **étalées sur les quatre fenêtres** — on sert en tourniquet, une par
       trimestre, avant de reprendre au deuxième rang. Six lignes toutes tirées
       du dernier trimestre ne seraient pas une base, juste de l'actualité un
       peu moins fraîche ;
    2. **les titres classés d'abord** — avec six lignes, dépenser le budget en
       titres neutres reviendrait à ne rien dire. Les neutres complètent quand
       les classés ne suffisent pas.

    Le rendu final est CHRONOLOGIQUE (du plus ancien au plus récent) : un
    historique se lit comme une histoire, pas comme un fil d'actualité.
    """
    if not isinstance(entry, dict):
        return []
    try:
        limit = max(0, int(limit))
    except (TypeError, ValueError):
        limit = DIGEST_LINES
    if not limit:
        return []

    buckets: List[List[Dict[str, Any]]] = []
    for window in entry.get("windows") or []:
        if not isinstance(window, dict):
            continue
        items = [i for i in (window.get("items") or [])
                 if isinstance(i, dict) and i.get("ts") and i.get("title")]
        items.sort(key=lambda i: str(i.get("ts")), reverse=True)
        buckets.append(items)
    if not buckets:
        return []

    picked: List[Dict[str, Any]] = []
    for wanted_signal in (True, False):
        groups = [[i for i in items if _is_signal(i) is wanted_signal]
                  for items in buckets]
        rank = 0
        while len(picked) < limit:
            added = False
            for items in groups:
                if len(picked) >= limit:
                    break
                if rank < len(items):
                    picked.append(items[rank])
                    added = True
            if not added:
                break
            rank += 1

    picked.sort(key=lambda i: str(i.get("ts")))
    return ["%s %s (%s)" % (str(item.get("ts"))[:7],
                            _short(item.get("title"), MAX_TITLE_LINE),
                            str(item.get("sentiment") or NEUTRAL))
            for item in picked]


def digest_for(symbols: Any, limit_per: int = DIGEST_LINES,
               state: Optional[Dict[str, Any]] = None) -> Dict[str, List[str]]:
    """Le dossier historique de chaque symbole demandé, prêt pour un prompt :
    ``{symbol: ["AAAA-MM titre (sentiment)", ...]}``.

    Mise en forme PURE : à ``state`` fourni, la fonction ne touche à rien. Le
    défaut (``state=None`` -> ``load_state()``) n'est qu'un raccourci pour les
    appelants — même patron que ``radar.recent()``.

    Un symbole sans dossier est ABSENT du retour (pas une clé vide) : le
    consommateur doit pouvoir distinguer « rien collecté » de « collecté, rien
    trouvé », et un prompt ne doit pas se remplir de listes vides.
    """
    if state is None:
        state = load_state()
    entries = state.get("symbols") if isinstance(state, dict) else None
    if not isinstance(entries, dict):
        return {}
    out: Dict[str, List[str]] = {}
    for raw in symbols or []:
        symbol = _norm_symbol(raw)
        if not symbol or symbol in out:
            continue
        lines = _digest_lines(entries.get(symbol), limit_per)
        if lines:
            out[symbol] = lines
    return out


# =========================================================================== #
#  I/O — état sur disque
# =========================================================================== #

def _store():
    """Le module de persistance du paper trading (import paresseux — même
    indirection que ``radar._store``, pour qu'un test qui isole ``DATA_DIR``
    isole aussi ce module)."""
    from backend.bots.paper import store
    return store


def state_path() -> Path:
    """Chemin du dossier historique. ``DATA_DIR`` est relu à CHAQUE appel."""
    return Path(_store().DATA_DIR) / STATE_NAME


def blank_state() -> Dict[str, Any]:
    """État vierge (PUR) — la forme canonique, en un seul endroit."""
    return {"symbols": {}}


def load_state() -> Dict[str, Any]:
    """Charge l'état. Absent, illisible ou déformé -> état vierge : un fichier
    touché à la main ne doit jamais faire tomber un run.

    Tolère AUSSI la forme « à plat » (``{symbol: {...}}`` sans enveloppe) : le
    fichier est ramené à la forme canonique à la lecture, et réécrit à la forme
    canonique à la prochaine collecte.
    """
    state = blank_state()
    path = state_path()
    try:
        if not path.is_file():
            return state
        with open(str(path), "r", encoding="utf-8") as handle:
            raw = json.load(handle)
    except (OSError, ValueError):
        return state
    if not isinstance(raw, dict):
        return state
    entries = raw.get("symbols")
    if not isinstance(entries, dict):
        # Forme à plat : tout ce qui ressemble à une entrée de symbole.
        entries = {k: v for k, v in raw.items() if isinstance(v, dict)}
    for key, value in entries.items():
        symbol = _norm_symbol(key)
        if symbol and isinstance(value, dict):
            state["symbols"][symbol] = value
    return state


def save_state(state: Dict[str, Any]) -> None:
    """Persiste l'état de façon ATOMIQUE et 0o600 (le temporaire naît en 0o600
    via ``os.open`` — pas de fenêtre world-readable), même patron que
    ``radar.save_state`` et ``store._atomic_write_json``."""
    path = state_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = path.parent / (".%s.tmp-%d" % (path.name, os.getpid()))
    fd = os.open(str(tmp_path), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    try:
        os.fchmod(fd, 0o600)
    except (AttributeError, OSError):
        pass
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(state, handle, ensure_ascii=False, indent=2)
        os.replace(str(tmp_path), str(path))
    except Exception:
        try:
            os.remove(str(tmp_path))
        except OSError:
            pass
        raise


def _parse_iso(value: Any) -> Optional[datetime]:
    """Un ISO du dépôt -> datetime UTC naïf. Illisible -> ``None``."""
    text = str(value or "").strip()
    if not text:
        return None
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"
    try:
        return _naive(datetime.fromisoformat(text))
    except ValueError:
        return None


def is_fresh(entry: Any, now: Optional[datetime] = None,
             max_age_days: int = FRESH_DAYS) -> bool:
    """Ce dossier est-il encore valable (PUR) ?

    ``fetched_at`` absent ou illisible -> PAS frais : mieux vaut repayer quatre
    requêtes que servir un dossier dont on ne sait pas dater le contenu. Une
    date dans le FUTUR (état hérité d'une autre machine, horloge décalée) est
    traitée comme fraîche — c'est ce qu'elle dit, et une collecte en boucle
    serait pire que d'attendre.
    """
    if not isinstance(entry, dict):
        return False
    fetched = _parse_iso(entry.get("fetched_at"))
    if fetched is None:
        return False
    ref = _naive(now) if isinstance(now, datetime) else datetime.utcnow()
    return (ref - fetched) < timedelta(days=max_age_days)


# =========================================================================== #
#  I/O — collecte
# =========================================================================== #

def _default_fetch(url: str) -> str:
    """Le client RSS de la veille (curl_cffi, empreinte TLS Chrome, session
    partagée). Voir l'en-tête du module : on ne rouvre pas une seconde session
    TLS pour la même famille de flux."""
    from backend.bots.paper import newswatch
    return newswatch._fetch_rss(url)


def _parse(xml_text: str) -> List[Dict[str, Any]]:
    """Le parseur RSS de la veille. Veille absente -> aucun item (jamais une
    exception : une source muette ne casse pas un run)."""
    try:
        from backend.bots.paper import newswatch
        return list(newswatch.parse_rss(xml_text) or [])
    except Exception:      # noqa: BLE001
        return []


def _items_from(xml_text: str) -> List[Dict[str, Any]]:
    """Les items retenus d'un flux : conseils écartés, dates illisibles
    écartées, sentiment posé, les ``MAX_ITEMS_PER_WINDOW`` plus RÉCENTS gardés.

    Une date à 0 (``pubDate`` absent ou invalide) est jetée : sans date, un
    titre ne peut pas servir de repère dans le temps — et c'est exactement ce
    qu'on lui demande ici.
    """
    rows: List[Dict[str, Any]] = []
    for item in _parse(xml_text):
        title = str(item.get("title") or "").strip()
        pub_ts = item.get("pub_ts") or 0
        if not title or not pub_ts:
            continue
        if is_advice(title):
            continue
        try:
            when = datetime.utcfromtimestamp(int(pub_ts))
        except (TypeError, ValueError, OSError, OverflowError):
            continue
        rows.append({"ts": when.isoformat(),
                     "title": _short(title, MAX_TITLE_STORED),
                     "sentiment": _classify(title)})
    rows.sort(key=lambda r: r["ts"], reverse=True)
    return rows[:MAX_ITEMS_PER_WINDOW]


def backfill_symbol(symbol: Any, name: Any = None,
                    now: Optional[datetime] = None,
                    fetch: Optional[Callable[[str], str]] = None,
                    sleep: Optional[Callable[[float], None]] = None,
                    force: bool = False) -> Dict[str, Any]:
    """Construit (ou rafraîchit) le dossier historique d'UN symbole.

    Quatre requêtes, une par trimestre, espacées de ``PACE_S``. Retourne
    ``{"symbol", "name", "windows", "items", "errors", "skipped", "reason"}``.

    **Best-effort par fenêtre** : une fenêtre en panne est comptée dans
    ``errors`` et la collecte continue — trois trimestres valent mieux que
    zéro.

    ⚠️ **``fetched_at`` n'est posé que si au moins une fenêtre a RÉPONDU.**
    Sinon, un hoquet réseau condamnerait le symbole à trente jours sans
    dossier. Une fenêtre qui répond 200 avec zéro titre, elle, est un SUCCÈS :
    « la presse n'a rien écrit ce trimestre-là » est une information, et la
    réessayer indéfiniment n'en produirait pas d'autre.
    """
    key = _norm_symbol(symbol)
    result: Dict[str, Any] = {"symbol": key, "name": "", "windows": 0,
                              "items": 0, "errors": 0, "skipped": False,
                              "reason": ""}
    if not key:
        result["skipped"] = True
        result["reason"] = "invalid"
        return result

    ref = _naive(now) if isinstance(now, datetime) else datetime.utcnow()
    state = load_state()
    existing = state["symbols"].get(key)
    if not force and is_fresh(existing, ref):
        result["skipped"] = True
        result["reason"] = "fresh"
        result["name"] = str((existing or {}).get("name") or "")
        return result

    label = str(name or "").strip() or str((existing or {}).get("name") or "").strip() \
        or _symbol_root(key)
    result["name"] = label

    fetch = fetch or _default_fetch
    sleep = sleep if sleep is not None else time.sleep

    windows: List[Dict[str, Any]] = []
    answered = 0
    for index, window in enumerate(quarter_windows(ref)):
        if index:
            try:
                sleep(PACE_S)
            except Exception:      # noqa: BLE001 — une horloge injectée bavarde
                pass
        try:
            xml_text = fetch(search_url(label, window))
        except Exception as exc:   # noqa: BLE001 — source muette, jamais fatale
            logger.warning("paper backfill: %s %s->%s indisponible (%s)",
                           key, window["from"], window["to"], type(exc).__name__)
            result["errors"] += 1
            continue
        answered += 1
        items = _items_from(xml_text)
        windows.append({"from": window["from"], "to": window["to"],
                        "items": items})
        result["items"] += len(items)

    if not answered:
        result["reason"] = "unreachable"
        return result

    state["symbols"][key] = {"name": label, "fetched_at": ref.isoformat(),
                             "windows": windows}
    try:
        save_state(state)
    except OSError as exc:
        logger.warning("paper backfill: état non persisté (%s)", type(exc).__name__)
        result["errors"] += 1
        result["reason"] = "unsaved"
        return result

    result["windows"] = len(windows)
    result["reason"] = "collected"
    return result


# =========================================================================== #
#  I/O — ancres et file de travail
# =========================================================================== #

def anchor_symbols() -> List[Dict[str, str]]:
    """Les ANCRES de tous les comptes : positions ouvertes ∪ watchlist,
    dédupliquées, ``[{"symbol", "name"}]``.

    Délègue aux lecteurs de la veille (``_discover_portfolios`` /
    ``_merged_symbols``) : ce sont eux qui portent la liste des fichiers de
    module à écarter, et en tenir une SECONDE copie ici serait la façon la plus
    sûre de recréer un utilisateur fantôme le jour où l'une des deux évolue.

    Le ``name`` vient de la watchlist quand elle le porte (elle seule le
    connaît : ``models.Position`` n'a pas de nom). Vide sinon — c'est
    ``run_pending`` qui tentera alors de le résoudre.
    """
    try:
        from backend.bots.paper import newswatch
        store_mod = _store()
    except Exception:      # noqa: BLE001 — déploiement partiel
        return []

    out: List[Dict[str, str]] = []
    seen = set()
    try:
        portfolios = newswatch._discover_portfolios()
    except Exception as exc:   # noqa: BLE001 — lecture best-effort
        logger.warning("paper backfill: ancres illisibles (%s)", type(exc).__name__)
        return []

    for username, portfolio in portfolios:
        try:
            symbols = newswatch._merged_symbols(portfolio, username)
            names = {}
            for row in store_mod.load_watchlist(username):
                symbol = _norm_symbol(row.get("symbol"))
                label = str(row.get("name") or "").strip()
                if symbol and label:
                    names.setdefault(symbol, label)
        except Exception as exc:   # noqa: BLE001 — un compte abîmé n'en bloque pas d'autres
            logger.warning("paper backfill: ancres de %s illisibles (%s)",
                           username, type(exc).__name__)
            continue
        for raw in symbols:
            symbol = _norm_symbol(raw)
            if not symbol or symbol in seen:
                continue
            seen.add(symbol)
            out.append({"symbol": symbol, "name": names.get(symbol, "")})
    return out


def pending_backfills(now: Optional[datetime] = None) -> List[Dict[str, str]]:
    """Les ancres SANS dossier frais — la file de travail, dans l'ordre où on
    la traitera. Lecture seule."""
    ref = _naive(now) if isinstance(now, datetime) else datetime.utcnow()
    state = load_state()
    return [anchor for anchor in anchor_symbols()
            if not is_fresh(state["symbols"].get(anchor["symbol"]), ref)]


def _default_resolve_name(symbol: str) -> str:
    """Le nom du titre chez Yahoo — best-effort, pour les symboles qui sont
    en position sans être en watchlist (une position ne porte pas de nom).
    Indisponible -> ``""``, et la collecte retombera sur la racine du ticker."""
    try:
        from backend.bots.paper import quotes
        return str((quotes.get_quote(symbol) or {}).get("name") or "").strip()
    except Exception:      # noqa: BLE001 — cours indisponible, jamais fatal
        return ""


def run_pending(max_symbols: int = 1, now: Optional[datetime] = None,
                fetch: Optional[Callable[[str], str]] = None,
                sleep: Optional[Callable[[float], None]] = None,
                resolve_name: Optional[Callable[[str], str]] = None,
                force: bool = False) -> Dict[str, Any]:
    """Traite les ``max_symbols`` premières ancres en attente — **un** par
    défaut.

    C'est la file NON BLOQUANTE : quatre requêtes espacées de 1,1 s coûtent
    ~5 s par symbole, donc en traiter dix d'un coup gèlerait l'appelant (le
    radar, un endpoint). On en fait un par passage et la file se vide toute
    seule.

    Retourne ``{"processed", "skipped", "items", "errors", "symbols"}``. Une
    collecte qui échoue est comptée, jamais propagée : ce module est branché en
    best-effort à la fin d'un run qui a déjà fait son travail.
    """
    counters: Dict[str, Any] = {"processed": 0, "skipped": 0, "items": 0,
                                "errors": 0, "symbols": []}
    try:
        max_symbols = max(0, int(max_symbols))
    except (TypeError, ValueError):
        max_symbols = 1
    if not max_symbols:
        return counters

    ref = _naive(now) if isinstance(now, datetime) else datetime.utcnow()
    resolve = resolve_name or _default_resolve_name

    for anchor in pending_backfills(ref)[:max_symbols]:
        symbol = anchor["symbol"]
        label = anchor.get("name") or ""
        if not label:
            try:
                label = resolve(symbol) or ""
            except Exception:      # noqa: BLE001
                label = ""
        try:
            outcome = backfill_symbol(symbol, label, now=ref, fetch=fetch,
                                      sleep=sleep, force=force)
        except Exception as exc:   # noqa: BLE001 — best-effort de bout en bout
            logger.warning("paper backfill: %s a échoué (%s)", symbol,
                           type(exc).__name__)
            counters["errors"] += 1
            continue
        counters["errors"] += outcome["errors"]
        counters["items"] += outcome["items"]
        if outcome["skipped"]:
            counters["skipped"] += 1
            continue
        # ⚠️ « pas sauté » ne veut pas dire « fait » : une source totalement
        # muette (``unreachable``) ne range RIEN et ne pose pas de date de
        # collecte — la compter comme traitée ferait dire au compteur que le
        # symbole est réglé alors qu'il reste en tête de file. Ses fenêtres en
        # panne sont déjà dans ``errors``.
        if outcome.get("reason") != "collected":
            continue
        counters["processed"] += 1
        counters["symbols"].append(symbol)
    return counters


def digest_for_anchors(limit_per: int = DIGEST_LINES) -> Dict[str, List[str]]:
    """Le dossier de TOUTES les ancres — le raccourci que lisent le radar et
    les endpoints. Ancres illisibles -> ``{}`` (best-effort)."""
    try:
        symbols = [anchor["symbol"] for anchor in anchor_symbols()]
    except Exception:      # noqa: BLE001
        return {}
    return digest_for(symbols, limit_per)


def entry_for(symbol: Any) -> Dict[str, Any]:
    """Le dossier BRUT d'un symbole (fenêtres et titres), ou ``{}``. Sert
    l'endpoint de lecture — l'UI a besoin du détail, pas des six lignes
    condensées que reçoit un prompt."""
    key = _norm_symbol(symbol)
    if not key:
        return {}
    entry = load_state()["symbols"].get(key)
    return entry if isinstance(entry, dict) else {}
