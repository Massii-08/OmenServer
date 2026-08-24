"""Veille news des positions du simulateur de paper trading -> notification
Telegram immédiate (Lot E, spec docs/superpowers/specs/2026-08-24-paper-trading-design.md,
section 13 pour l'extension politique/radar du 24/08 soir).

Deux volets :
  1. Par utilisateur -- tant qu'un utilisateur détient une position, on
     interroge le flux RSS Yahoo Finance de chaque symbole détenu et on
     notifie par Telegram toute news classée bonne/mauvaise (déjà tombée) OU
     catalyseur à venir (anticipation d'un mouvement -- résultats annoncés,
     fusion/acquisition, décision FDA...).
  2. GLOBAL (pas par utilisateur) -- veille des annonces politiques à impact
     économique probable (tarifs, sanctions, participation de l'État...),
     tirée de Google News + de l'archive RSS Truth Social. Tourne à CHAQUE
     cycle, même si personne ne détient de position -- une politique
     commerciale n'attend pas qu'on ait un portefeuille pour bouger le marché.

Objectif des deux volets : que l'utilisateur puisse se positionner dans le
simulateur AVANT que le marché n'ait fini de digérer la nouvelle, pas
seulement après.

Séparation stricte PUR / I-O (même règle que le reste du lot, cf. store.py) :
  - PUR  : parse_rss / classify / classify_gov / format_message /
           format_gov_message -- zéro I/O, 100% testable hors-ligne.
  - I/O  : tout le reste -- fetch réseau (curl_cffi), Telegram (notify.py /
           telegram_config.py), lecture/écriture des états "vu" sur disque.
           fetch/notifier/tg_cfg/sleep sont TOUS injectables dans run_once().

Pas de configuration Telegram -> le watcher NE FAIT RIEN (aucun accès disque,
aucun accès réseau, PAS MÊME le volet politique global) : silencieux, log
debug uniquement. C'est une feature opt-in, pas un flux qu'on peut oublier
d'éteindre.

États "vu" :
  - par utilisateur : data/paper_trading/<user>.news_seen.json (même dossier
    que les portefeuilles -- chemin dérivé de store.portfolio_path(), jamais
    recalculé à la main, pour rester valide même si DATA_DIR est monkeypatché
    en test) ;
  - global (politique) : data/paper_trading/newswatch_global.json.
Écriture atomique 0o600 pour les deux, même patron que store.py /
telegram_config.py / unblocker_config.py (le fichier tmp NAÎT en 0o600 via
os.open, jamais un open()+chmod() qui laisserait une fenêtre world-readable).

recent_events(username) FUSIONNE désormais les événements propres à
l'utilisateur ET les événements politiques globaux (sentiment "gov", symbole
"GOV", partagés par tout le monde) -- le router n'a rien à changer, la
fusion est interne à cette fonction.

Aucune nouvelle dépendance : curl_cffi (déjà utilisé par bond-scanner et
market-pulse -- Yahoo bloque les clients HTTP nus au niveau TLS, piège #67/#68)
+ stdlib (xml.etree, email.utils, re, hashlib, json, os).
"""
import hashlib
import json
import logging
import os
import re
import time
import xml.etree.ElementTree as ET
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Tuple
from urllib.parse import quote

from backend.bots.harvester import notify, telegram_config
from backend.bots.paper import store

logger = logging.getLogger("omenserver")

# --------------------------------------------------------------------------- #
# Constantes
# --------------------------------------------------------------------------- #

_RSS_URL_TEMPLATE = "https://feeds.finance.yahoo.com/rss/2.0/headline?s={symbol}&region=CH&lang=fr-CH"

_MAX_AGE_S = 48 * 3600          # une news plus vieille ne déclenche jamais de notif
_MAX_NOTIFY_PER_SYMBOL = 3      # cap PAR SYMBOLE PAR RUN, partagé pos/neg/watch
_MAX_EVENTS = 100                # cap de l'historique persisté (par état)
_SEEN_MAX_AGE_DAYS = 30          # purge des entrées "seen" trop vieilles
_PACE_S = 1.1                    # piège #67 : un burst de requêtes = 429

# --- volet politique GLOBAL (§13 de la spec, ajout 24/08 soir) ------------- #

# Sondées le 24/08 (200 confirmé toutes les deux). Google News ramène toute
# dépêche mentionnant Trump/Maison Blanche/executive order croisée avec un
# mot économique ; trumpstruth.org est l'archive RSS de Truth Social (le
# texte du post EST le titre de l'item).
_GOV_SOURCES = [
    "https://news.google.com/rss/search?q=Trump%20OR%20%22White%20House%22%20OR%20%22executive%20order%22%20(announces%20OR%20tariff%20OR%20tariffs%20OR%20investment%20OR%20sanctions%20OR%20ban%20OR%20stake)&hl=en-US&gl=US&ceid=US:en",
    "https://trumpstruth.org/feed",
]
_GOV_MAX_AGE_S = 24 * 3600       # plus court que le 48h "par symbole" : l'immédiateté est le but
_MAX_GOV_NOTIFY_PER_RUN = 3      # cap partagé entre LES DEUX sources gov, par run


# =========================================================================== #
#  PUR -- zéro I/O, zéro réseau, 100% testable hors-ligne
# =========================================================================== #

def _text(node) -> str:
    """Texte d'un noeud XML, "" si absent (ElementTree fusionne déjà le
    contenu CDATA dans .text -- rien de spécial à faire côté appelant)."""
    return (node.text or "").strip() if node is not None else ""


def _parse_pub_ts(raw: str) -> int:
    """Epoch (UTC) d'un pubDate RFC822. 0 si absent/invalide -- traité comme
    "infiniment vieux" par le filtre de fraîcheur, jamais comme une erreur qui
    ferait planter le parsing du flux entier."""
    raw = (raw or "").strip()
    if not raw:
        return 0
    try:
        dt = parsedate_to_datetime(raw)
    except (TypeError, ValueError, IndexError, OverflowError):
        return 0
    if dt is None:
        return 0
    try:
        return int(dt.timestamp())
    except (OverflowError, OSError, ValueError):
        return 0


def parse_rss(xml_text: str) -> List[Dict[str, Any]]:
    """Parse un flux RSS 2.0 (Yahoo Finance, Google News ou l'archive Truth
    Social -- même structure item/title/link/pubDate) -> [{"title", "link",
    "pub_ts"}].

    Un item sans titre ou sans lien est jeté (donnée inexploitable pour la
    suite). Un XML invalide (ou vide) rend une liste vide -- ne lève JAMAIS,
    cohérent avec le reste du projet : une source cassée ne doit jamais faire
    planter l'appelant (run_once la compte en erreur et passe à la suite)."""
    if not xml_text:
        return []
    try:
        root = ET.fromstring(xml_text)
    except ET.ParseError:
        return []
    items: List[Dict[str, Any]] = []
    for node in root.findall(".//item"):
        title = " ".join(_text(node.find("title")).split())
        link = _text(node.find("link"))
        if not title or not link:
            continue
        items.append({
            "title": title,
            "link": link,
            "pub_ts": _parse_pub_ts(_text(node.find("pubDate"))),
        })
    return items


# --- classification par symbole (mots-clés FR/EN/IT, compacts) ------------- #

# Un conseil d'investissement n'est JAMAIS relayé, quel que soit le reste du
# titre (doctrine Market Pulse, piège #67d) -- vérifié EN PREMIER, prioritaire
# sur tout le reste (neg/pos/watch inclus).
_ADVICE_KEYWORDS = [
    "buy now", "top stocks", "actions à acheter", "da comprare", "best stocks to",
]

# Mauvaise nouvelle DÉJÀ TOMBÉE -- prioritaire sur "pos" ET sur "watch" (si un
# titre matche neg ET watch, la nouvelle est déjà tombée, ce n'est plus une
# anticipation).
_NEG_KEYWORDS = [
    "profit warning", "downgrade", "cut guidance", "guidance cut",
    "misses estimates", "miss estimates", "lawsuit", "recall", "probe",
    "investigation", "fraud", "plunge", "sinks", "slumps", "tumbles",
    "layoffs", "bankruptcy",
    "chute", "effondre", "avertissement sur résultats", "abaisse", "enquête",
    "rappel de produits", "licenciements", "faillite",
    "perdita", "crolla", "indagine", "richiamo", "fallimento", "taglia le stime",
]

# Bonne nouvelle DÉJÀ TOMBÉE -- prioritaire sur "watch".
_POS_KEYWORDS = [
    "beats estimates", "beats expectations", "raises guidance", "upgrade",
    "record profit", "buyback", "dividend increase", "dividend hike",
    "surges", "soars", "jumps", "wins contract", "approval",
    "relève ses prévisions", "bénéfice record", "rachat d'actions",
    "hausse du dividende", "bondit", "s'envole", "contrat remporté",
    "utile record",
    "alza le stime", "balza", "vola", "maxi commessa",
]

# Catalyseur À VENIR -- rien n'est encore tombé, c'est une anticipation
# (résultats annoncés, M&A, décision réglementaire...). Extension de mission
# 2026-08-24 : signaler AUSSI ces titres pour permettre de se positionner
# AVANT le mouvement. Priorité la PLUS BASSE (neg > pos > watch) : si la
# nouvelle est déjà arrivée, ce n'est plus une anticipation.
_WATCH_KEYWORDS = [
    "to report earnings", "reports q1", "reports q2", "reports q3", "reports q4",
    "earnings preview", "ahead of earnings", "earnings date", "set to announce",
    "poised to", "expected to report", "merger", "takeover bid",
    "acquisition of", "to acquire", "fda decision", "pdufa", "investor day",
    "product launch", "to launch", "unveils", "guidance update",
    "outlook update", "spin-off", "ipo of",
    "publiera ses résultats", "résultats attendus", "avant les résultats",
    "devrait annoncer", "opa sur", "offre publique", "fusion",
    "acquisition de", "lancement de", "journée investisseurs", "scission",
    "pubblicherà i risultati", "risultati attesi", "opa su", "fusione",
    "acquisizione di", "lancio di", "scissione",
]


def _keyword_matches(title_lower: str, keyword: str) -> bool:
    """Un mot-clé SANS espace = un mot entier -> \\b (évite "chute" trouvé
    dans "parachute", "fusion" dans "confusion"). Un mot-clé AVEC espace = un
    composé -> substring simple (une séquence de plusieurs mots ne peut pas
    se retrouver "à l'intérieur" d'un autre mot)."""
    if " " in keyword:
        return keyword in title_lower
    return re.search(r"\b" + re.escape(keyword) + r"\b", title_lower) is not None


def classify(title: str) -> Optional[str]:
    """Classe un titre de news PAR SYMBOLE : "neg" | "pos" | "watch" | None.

    Ordre de priorité (le premier qui matche gagne) :
      1. conseil d'investissement -> None, TOUJOURS, quel que soit le reste
         du titre (on ne relaie jamais un conseil, doctrine Market Pulse) ;
      2. "neg"   -- mauvaise nouvelle déjà tombée ;
      3. "pos"   -- bonne nouvelle déjà tombée ;
      4. "watch" -- catalyseur à venir (anticipation, rien n'est encore
         arrivé) ;
      5. sinon None (neutre).
    """
    if not title:
        return None
    t = title.lower()
    if any(_keyword_matches(t, kw) for kw in _ADVICE_KEYWORDS):
        return None
    if any(_keyword_matches(t, kw) for kw in _NEG_KEYWORDS):
        return "neg"
    if any(_keyword_matches(t, kw) for kw in _POS_KEYWORDS):
        return "pos"
    if any(_keyword_matches(t, kw) for kw in _WATCH_KEYWORDS):
        return "watch"
    return None


def format_message(symbol: str, title: str, link: str, sentiment: str, lang: str = "fr") -> str:
    """Message Telegram sobre, sans emoji, pour une news PAR SYMBOLE.

    "watch" a un texte dédié qui ne dit JAMAIS "achète"/"investis" -- on
    signale un catalyseur, on ne recommande jamais un titre (même doctrine
    que le coach, section 2 de la spec). ``lang`` n'a qu'une variante FR pour
    l'instant (seule formulation demandée) -- gardé pour cohérence de
    signature avec le reste du projet, ignoré sinon."""
    if sentiment == "watch":
        return (
            f"[Simulateur] Catalyseur à venir — {symbol}\n"
            f"« {title} »\n"
            f"Mouvement possible : si tu veux le jouer, pose ta thèse dans le "
            f"simulateur maintenant (argent fictif).\n"
            f"{link}"
        )
    label = "Bonne" if sentiment == "pos" else "Mauvaise"
    return f"[Simulateur] {label} nouvelle potentielle — {symbol}\n« {title} »\n{link}"


# --- classification GLOBALE politique (§13, ajout 24/08 soir) -------------- #

# Vocabulaire à impact ÉCONOMIQUE probable. Matching en SUBSTRING SIMPLE
# (contrairement à _keyword_matches ci-dessus, pas de \b) : (a) le
# vocabulaire est spécifique et le risque de collision par substring est
# faible ("sanctions"/"bailout"/"subvention" ne sont substrings d'aucun autre
# mot courant) ; (b) "nationaliz" est un RADICAL délibéré, à substring
# obligatoire pour couvrir nationalize/nationalide/nationalise/
# nationalization/nationalized -- un \b échouerait sur toutes ces formes.
# "tariff"/"tariffs" listés séparément pour rester lisible, mais "tariff" en
# substring couvre déjà "tariffs" à lui seul.
_GOV_KEYWORDS = [
    "tariff", "tariffs", "droits de douane", "executive order", "sanctions",
    "export ban", "import ban", "government stake", "state stake", "nationaliz",
    "subsidy", "subsidies", "subvention", "bailout", "price cap",
    "trade deal", "accord commercial", "defense contract", "chips act",
    "emergency declaration", "announces investment", "federal funding",
]


def classify_gov(title: str) -> bool:
    """True si un titre parle d'une annonce politique à impact ÉCONOMIQUE
    probable (tarifs, sanctions, participation de l'État, subventions...).
    Un titre purement électoral/sondage/polémique SANS mot économique ->
    False PAR CONSTRUCTION (aucun mot-clé ne matche) -- pas de liste
    d'exclusion séparée à maintenir : un post "Fake Polls" ne contient aucun
    des mots ci-dessus, donc ne bouge jamais ce classifieur."""
    if not title:
        return False
    t = title.lower()
    return any(kw in t for kw in _GOV_KEYWORDS)


def format_gov_message(title: str, link: str) -> str:
    """Message Telegram pour une annonce politique à impact économique
    probable. Ne recommande JAMAIS un titre précis -- signale un contexte,
    laisse la thèse (et la décision) à l'utilisateur, même doctrine que le
    coach (section 2 de la spec)."""
    return (
        "[Simulateur] Annonce politique — mouvement de marché possible\n"
        f"« {title} »\n"
        f"{link}\n"
        "Si un secteur te semble touché : simulateur, thèse, petit sizing."
    )


# =========================================================================== #
#  I/O -- réseau (curl_cffi), Telegram, disque. Tout injectable dans run_once.
# =========================================================================== #

# --- fetch RSS (curl_cffi, empreinte TLS Chrome) ---------------------------- #

_session = None  # session curl_cffi partagée, créée à la demande (import paresseux)


def _get_session():
    """Session curl_cffi paresseuse et RÉUTILISÉE entre les appels (empreinte
    TLS Chrome -- Yahoo bloque les clients HTTP nus, même patron que
    market-pulse/pulse/fetcher.py et bond-scanner/scanner/fitch_isin.py)."""
    global _session
    if _session is None:
        from curl_cffi import requests as creq  # import paresseux
        _session = creq.Session(impersonate="chrome")
    return _session


def _rss_url(symbol: str) -> str:
    return _RSS_URL_TEMPLATE.format(symbol=quote(symbol, safe=""))


def _fetch_rss(url: str) -> str:
    """Récupère le texte d'un flux RSS (Yahoo, Google News ou Truth Social --
    même client pour les trois). Lève si le statut HTTP n'est pas 200 ou en
    cas d'erreur réseau/TLS -- laissé à l'appelant (run_once) de comptabiliser
    l'erreur : best-effort, jamais de crash du run entier."""
    session = _get_session()
    resp = session.get(url, timeout=15.0)
    if resp.status_code != 200:
        raise RuntimeError(f"RSS HTTP {resp.status_code} pour {url}")
    return resp.text


# --- états "vu" (générique -- sert le state par-utilisateur ET le state global) #

def _news_seen_path(username: str) -> Path:
    """Chemin du fichier d'état "vu" PAR UTILISATEUR, dans le MÊME dossier
    que les portefeuilles. Délègue à store.portfolio_path() pour la
    validation du nom d'utilisateur ET la résolution du dossier -- reste
    valide même si store.DATA_DIR est monkeypatché (les tests le font)."""
    portfolio_p = store.portfolio_path(username)  # valide + lève ValueError si invalide
    return portfolio_p.parent / f"{username}.news_seen.json"


def _global_seen_path() -> Path:
    """Chemin de l'état "vu" GLOBAL (annonces politiques, pas par
    utilisateur). Relit store.DATA_DIR à chaque appel (pas de constante
    figée à l'import) pour rester valide même monkeypatché en test."""
    return store.DATA_DIR / "newswatch_global.json"


def _default_seen_state() -> Dict[str, Any]:
    return {"seen": {}, "events": [], "seeded": {}}


def _load_seen_state(path: Path) -> Dict[str, Any]:
    """Charge un état "vu" depuis un chemin quelconque (sert les deux
    stores : par-utilisateur et global). Absent -> état vierge. Corrompu ->
    état vierge SANS jamais planter (le fichier fautif est renommé en
    .corrupt, même convention que store.py -- on garde la trace du bug sans
    perdre la capacité de tourner)."""
    if not path.is_file():
        return _default_seen_state()
    try:
        with open(str(path), "r", encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, ValueError):
        try:
            os.replace(str(path), str(path.parent / (path.name + ".corrupt")))
        except OSError:
            pass
        return _default_seen_state()
    if not isinstance(data, dict):
        return _default_seen_state()
    seen = data.get("seen")
    events = data.get("events")
    seeded = data.get("seeded")
    return {
        "seen": seen if isinstance(seen, dict) else {},
        "events": events if isinstance(events, list) else [],
        "seeded": seeded if isinstance(seeded, dict) else {},
    }


def _save_seen_state(path: Path, state: Dict[str, Any]) -> None:
    """Persiste un état "vu" (générique) de façon atomique et 0o600 -- même
    patron que store.py/telegram_config.py (le fichier tmp NAÎT en 0o600 via
    os.open, jamais un open()+chmod() qui laisserait une fenêtre
    world-readable)."""
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = path.parent / f".{path.name}.tmp-{os.getpid()}"
    fd = os.open(str(tmp_path), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    try:
        os.fchmod(fd, 0o600)
    except (AttributeError, OSError):
        pass
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(state, f, ensure_ascii=False, indent=2)
        os.replace(str(tmp_path), str(path))
    except Exception:
        try:
            os.remove(str(tmp_path))
        except OSError:
            pass
        raise


def _load_seen(username: str) -> Dict[str, Any]:
    return _load_seen_state(_news_seen_path(username))


def _save_seen(username: str, state: Dict[str, Any]) -> None:
    _save_seen_state(_news_seen_path(username), state)


def _load_global_seen() -> Dict[str, Any]:
    return _load_seen_state(_global_seen_path())


def _save_global_seen(state: Dict[str, Any]) -> None:
    _save_seen_state(_global_seen_path(), state)


def _purge_old_seen(state: Dict[str, Any], now_dt: datetime,
                    max_age_days: int = _SEEN_MAX_AGE_DAYS) -> None:
    """Purge EN PLACE les entrées "seen" plus vieilles que max_age_days (évite
    une croissance illimitée du fichier -- vaut pour les deux stores). Une
    date illisible est purgée par prudence -- mieux vaut re-détecter un item
    une fois qu'accumuler une fuite silencieuse."""
    seen = state.get("seen")
    if not isinstance(seen, dict):
        return
    cutoff = now_dt.timestamp() - max_age_days * 86400
    stale = []
    for key, iso_ts in seen.items():
        keep = False
        try:
            ts = datetime.fromisoformat(iso_ts)
            if ts.tzinfo is None:
                ts = ts.replace(tzinfo=timezone.utc)
            keep = ts.timestamp() >= cutoff
        except (TypeError, ValueError):
            keep = False
        if not keep:
            stale.append(key)
    for key in stale:
        del seen[key]


def _hash_link(link: str) -> str:
    return hashlib.md5(link.encode("utf-8")).hexdigest()


def recent_events(username: str) -> List[Dict[str, Any]]:
    """CONTRAT PUBLIC (consommé par le router) : événements news récents pour
    un utilisateur, TRIÉS PAR ts DÉCROISSANT -- fusionne les événements
    propres à l'utilisateur ET les événements politiques GLOBAUX (sentiment
    "gov", symbole "GOV", partagés par tout le monde, y compris un
    utilisateur qui n'a jamais eu de portefeuille). Fichier(s) absent(s) ->
    juste la partie manquante compte pour []. Username invalide -> lève
    ValueError (même convention que store.py : on rejette, on ne sanitize
    jamais en silence) -- vérifié EN PREMIER, avant même de toucher l'état
    global."""
    user_events = list(_load_seen(username).get("events", []))
    gov_events = list(_load_global_seen().get("events", []))
    merged = user_events + gov_events
    merged.sort(key=lambda e: e.get("ts") or "", reverse=True)
    return merged


# --- portefeuilles ------------------------------------------------------------ #

def _position_symbols(portfolio: Dict[str, Any]) -> List[str]:
    """Symboles distincts (ordre de première apparition) des positions
    ouvertes d'un portefeuille."""
    symbols: List[str] = []
    for pos in portfolio.get("positions") or []:
        if not isinstance(pos, dict):
            continue
        sym = pos.get("symbol")
        if sym and sym not in symbols:
            symbols.append(sym)
    return symbols


def _discover_portfolios() -> List[Tuple[str, Dict[str, Any]]]:
    """Liste (username, portfolio) pour chaque portefeuille possédant au
    moins une position ouverte. Ignore les fichiers auxiliaires (.coach.json,
    .news_seen.json -- ils matchent aussi le glob "*.json") ; les fichiers
    corrompus sont déjà hors du glob (store.py les renomme en .corrupt à la
    lecture, extension qui ne matche plus "*.json")."""
    data_dir = store.DATA_DIR
    if not data_dir.is_dir():
        return []
    out: List[Tuple[str, Dict[str, Any]]] = []
    for path in sorted(data_dir.glob("*.json")):
        name = path.name
        if name.endswith(".coach.json") or name.endswith(".news_seen.json"):
            continue
        username = path.stem
        try:
            portfolio = store.load_portfolio(username)
        except ValueError:
            continue
        if not isinstance(portfolio, dict):
            continue
        if _position_symbols(portfolio):
            out.append((username, portfolio))
    return out


# --- le cycle ----------------------------------------------------------------- #

def run_once(now: Optional[datetime] = None,
            fetch: Optional[Callable[[str], str]] = None,
            notifier: Optional[Callable[[str, Dict[str, Any]], bool]] = None,
            tg_cfg: Optional[Dict[str, Any]] = None,
            sleep: Optional[Callable[[float], None]] = None) -> Dict[str, int]:
    """Un cycle de veille news : (1) volet politique GLOBAL (toujours, même
    sans portefeuille) puis (2) pour chaque portefeuille ayant des positions,
    interroge le flux RSS Yahoo de chaque symbole détenu. Notifie Telegram sur
    toute news neg/pos/watch (par symbole) ou gov (globale) nouvelle. Retourne
    les compteurs {users, symbols, fetched, notified, errors} -- le volet gov
    contribue à fetched/notified/errors mais jamais à users/symbols (qui ne
    parlent que des portefeuilles).

    Sans config Telegram -> ne fait RIEN du tout, ni le volet gov ni le volet
    par utilisateur (ni disque ni réseau, feature opt-in silencieuse) : c'est
    vérifié EN PREMIER, avant tout accès à data/.
    """
    counters = {"users": 0, "symbols": 0, "fetched": 0, "notified": 0, "errors": 0}

    cfg = tg_cfg if tg_cfg is not None else telegram_config.load()
    if not cfg.get("token") or not cfg.get("chat_id"):
        logger.debug("paper newswatch: Telegram non configuré, rien à faire")
        return counters

    now_dt = now if now is not None else datetime.now(timezone.utc)
    if now_dt.tzinfo is None:
        now_dt = now_dt.replace(tzinfo=timezone.utc)
    fetch_fn = fetch if fetch is not None else _fetch_rss
    notify_fn = notifier if notifier is not None else notify.send
    sleep_fn = sleep if sleep is not None else time.sleep

    first_call = True

    # ----------------------------------------------------------------- #
    # Volet 1 -- annonces politiques GLOBALES (§13). Tourne TOUJOURS, même
    # si personne ne détient de position : une politique commerciale ne
    # demande pas la permission d'un portefeuille pour bouger le marché.
    # ----------------------------------------------------------------- #
    gov_state = _load_global_seen()
    gov_seen = gov_state["seen"]
    gov_seeded = gov_state["seeded"]
    gov_events = gov_state["events"]
    gov_changed = False
    gov_is_first_pass = "gov" not in gov_seeded
    gov_notified_count = 0

    for gov_url in _GOV_SOURCES:
        if not first_call:
            sleep_fn(_PACE_S)
        first_call = False

        try:
            xml_text = fetch_fn(gov_url)
        except Exception as exc:
            logger.warning("paper newswatch: fetch gov échoué (%s)", type(exc).__name__)
            counters["errors"] += 1
            continue
        counters["fetched"] += 1
        items = parse_rss(xml_text)

        for item in items:
            link = item.get("link")
            if not link:
                continue
            key = _hash_link(link)
            if key in gov_seen:
                continue
            gov_seen[key] = now_dt.isoformat()
            gov_changed = True

            if gov_is_first_pass:
                continue  # anti-tempête au déploiement : seed, on ne notifie rien

            pub_ts = item.get("pub_ts") or 0
            age_s = now_dt.timestamp() - pub_ts
            if age_s < 0 or age_s > _GOV_MAX_AGE_S:
                continue
            if gov_notified_count >= _MAX_GOV_NOTIFY_PER_RUN:
                continue
            if not classify_gov(item.get("title", "")):
                continue  # neutre/électoral -> juste marqué vu

            message = format_gov_message(item["title"], link)
            try:
                ok = notify_fn(message, cfg)
            except Exception as exc:
                logger.warning("paper newswatch: notif gov échouée (%s)", type(exc).__name__)
                ok = False
            if ok:
                counters["notified"] += 1
                gov_notified_count += 1
                gov_events.insert(0, {
                    "ts": now_dt.isoformat(),
                    "symbol": "GOV",
                    "title": item["title"],
                    "link": link,
                    "sentiment": "gov",
                })
            else:
                counters["errors"] += 1

    if gov_is_first_pass:
        gov_seeded["gov"] = True
        gov_changed = True  # persiste le flag même si les deux flux étaient vides

    if gov_changed:
        gov_state["events"] = gov_events[:_MAX_EVENTS]
        _purge_old_seen(gov_state, now_dt)
        _save_global_seen(gov_state)

    # ----------------------------------------------------------------- #
    # Volet 2 -- par utilisateur, par symbole détenu.
    # ----------------------------------------------------------------- #
    for username, portfolio in _discover_portfolios():
        counters["users"] += 1
        symbols = _position_symbols(portfolio)
        state = _load_seen(username)
        seen = state["seen"]
        seeded = state["seeded"]
        events = state["events"]
        changed = False

        for symbol in symbols:
            counters["symbols"] += 1
            if not first_call:
                sleep_fn(_PACE_S)
            first_call = False

            try:
                xml_text = fetch_fn(_rss_url(symbol))
            except Exception as exc:  # réseau/TLS/HTTP -- best-effort
                logger.warning("paper newswatch: fetch échoué pour %s (%s)",
                               symbol, type(exc).__name__)
                counters["errors"] += 1
                continue
            counters["fetched"] += 1
            items = parse_rss(xml_text)

            is_first_pass = symbol not in seeded
            notified_for_symbol = 0

            for item in items:
                link = item.get("link")
                if not link:
                    continue
                key = _hash_link(link)
                if key in seen:
                    continue
                # marqué vu dans TOUS les cas -- jamais retraité, jamais
                # renotifié, même si non éligible / au-delà du cap ci-dessous.
                seen[key] = now_dt.isoformat()
                changed = True

                if is_first_pass:
                    continue  # anti-tempête au déploiement : on seed, on ne notifie rien

                pub_ts = item.get("pub_ts") or 0
                age_s = now_dt.timestamp() - pub_ts
                if age_s < 0 or age_s > _MAX_AGE_S:
                    continue  # trop vieux (ou horloge en avance) -> vu, pas notifié
                if notified_for_symbol >= _MAX_NOTIFY_PER_SYMBOL:
                    continue  # cap atteint -> le reste reste marqué vu, pas notifié

                sentiment = classify(item.get("title", ""))
                if sentiment is None:
                    continue  # neutre (ou conseil) -> juste marqué vu

                message = format_message(symbol, item["title"], link, sentiment)
                try:
                    ok = notify_fn(message, cfg)
                except Exception as exc:
                    # notify.send ne lève déjà jamais lui-même ; on reste
                    # défensif si un futur notifier injecté, lui, lève.
                    logger.warning(
                        "paper newswatch: notif Telegram échouée pour %s (%s)",
                        symbol, type(exc).__name__)
                    ok = False
                if ok:
                    counters["notified"] += 1
                    notified_for_symbol += 1
                    events.insert(0, {
                        "ts": now_dt.isoformat(),
                        "symbol": symbol,
                        "title": item["title"],
                        "link": link,
                        "sentiment": sentiment,
                    })
                else:
                    counters["errors"] += 1

            if is_first_pass:
                seeded[symbol] = True
                changed = True  # persiste le flag même si le flux était vide

        if changed:
            state["events"] = events[:_MAX_EVENTS]
            _purge_old_seen(state, now_dt)
            _save_seen(username, state)

    return counters
