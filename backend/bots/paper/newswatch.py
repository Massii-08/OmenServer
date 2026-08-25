"""Veille news des positions du simulateur de paper trading -> notification
Telegram immédiate (Lot E, spec docs/superpowers/specs/2026-08-24-paper-trading-design.md,
section 13 pour l'extension politique/radar du 24/08 soir).

Deux volets :
  1. Par utilisateur -- tant qu'un utilisateur détient une position OU un
     symbole en watchlist (union des deux, extension 25/08 -- cf.
     _merged_symbols), on interroge le flux RSS Yahoo Finance de chaque
     symbole surveillé et on notifie par Telegram toute news classée
     bonne/mauvaise (déjà tombée) OU catalyseur à venir (anticipation d'un
     mouvement -- résultats annoncés, fusion/acquisition, décision FDA...).
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
  - I/O  : tout le reste -- fetch réseau (curl_cffi), Telegram (paper/alerts.py
           -- le bot ORACLE, spec §13), lecture/écriture des états "vu" sur
           disque. fetch/notifier/tg_cfg/sleep sont TOUS injectables dans
           run_once().

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

Canal Telegram : ``paper/alerts.py`` (bot Oracle, repli sur la config du
Harvester). Les paramètres ``notifier``/``tg_cfg`` restent injectables — seuls
les DÉFAUTS ont changé.

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

from backend.bots.paper import alerts, store

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

# --------------------------------------------------------------------------- #
# Anti-spam du volet politique — incident mesuré le 24/08 au soir : ~53 messages
# entre 20h et 22h.
#
# Cause exacte : le dédoublonnage se fait par LIEN, or la MÊME histoire (les
# tarifs Trump/Canada, les sanctions Iran) est reprise par une quinzaine de
# médias, donc quinze liens différents -> quinze messages. Multiplié par les 12
# passages horaires du planificateur (IntervalTrigger 5 min) et le cap de 3
# notifications par passage, le plafond réel était de 36 messages par heure.
#
# Deux couches, dans cet ordre :
#
#   1. ``story_key`` — une clé d'HISTOIRE dérivée du titre. Une histoire déjà
#      envoyée il y a moins de ``_GOV_STORY_MUTE_H`` heures est mise en
#      sourdine. Elle rattrape les reprises quasi identiques (fil repris tel
#      quel, titre re-ponctué, suffixe « - Source » de Google News) ;
#   2. ``_GOV_MAX_SENDS_PER_HOUR`` — un budget DUR sur une fenêtre glissante
#      d'une heure. C'est LA garantie : quelle que soit la matière entrante,
#      le téléphone ne reçoit pas plus de 4 annonces politiques par heure.
#
# Rien n'est perdu : un item mis en sourdine est marqué vu ET journalisé avec
# ``"muted": True`` -> il reste visible dans le feed de l'UI et il compte
# toujours comme facteur pour la convergence. Seul l'ENVOI est supprimé.
_GOV_STORY_MUTE_H = 6            # même histoire : au plus un envoi / 6 h
_GOV_MAX_SENDS_PER_HOUR = 4      # budget dur, fenêtre glissante


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


# --- anti-spam du volet politique : clé d'HISTOIRE (cf. le commentaire de
# tête de fichier ~L99 pour le design complet -- deux couches, story_key ici
# pour la couche 1) ---------------------------------------------------------- #

# 4 et non 6 : la règle PRIMAIRE décrite au design (les 6 tokens
# significatifs les plus longs) a été essayée en premier et NE CONVERGE PAS
# naturellement sur les paires réelles de calibration -- des mots longs mais
# non partagés ("economic"/"unveils"/"partners") battent systématiquement des
# mots courts mais identifiants ("Iran"/"US") dans une sélection par
# longueur. Repli DOCUMENTÉ (comme prévu) : 4 tokens, triés alphabétiquement.
# Validé par calibration -- cf. tests test_story_key_*.
_STORY_KEY_TOKENS = 4
_STORY_KEY_TRUNC = 6   # troncature légère type "stemming pauvre" -- unifie
                        # threatened/threats -> "threat", tariff/tariffs ->
                        # "tariff", sans dépendance externe.

_STORY_KEY_STOPWORDS = frozenset(
    ("the a an of to on as and in for with after new les des sur "
     "at its against by from "
     "le la les des du un une et ou mais donc car dans sous avec sans pour "
     "par en au aux ce cet cette ces qui que quoi dont").split()
) | frozenset({
    # Verbes de reportage génériques -- omniprésents dans les titres de
    # presse quel que soit le SUJET (annoncer/dévoiler/avertir...), donc zéro
    # pouvoir discriminant pour identifier UNE histoire précise (même
    # raisonnement que "new"/"after" ci-dessus, juste plus long à énumérer).
    "unveils", "unveiled", "announces", "announced", "says", "said",
    "tells", "told", "warns", "warned", "reports", "reported",
    "vows", "vowed", "urges", "urged", "look", "looks", "looking",
    "eyes", "eyed",
    # "trump" : quasi omniprésent dans CE flux précis -- la requête Google
    # News de _GOV_SOURCES filtre déjà sur Trump/White House/executive
    # order -- donc zéro pouvoir discriminant pour séparer une histoire
    # d'une autre ICI (vérifié sans collision entre histoires réellement
    # différentes dans les tests de calibration).
    "trump",
})

# Suffixe " - Source" de Google News (1 à 5 mots après le tiret -- borné pour
# ne pas avaler une vraie clause finale du titre qui utiliserait aussi un
# tiret comme séparateur).
_GNEWS_SUFFIX_RE = re.compile(r"\s+-\s+[A-Za-z0-9.&']+(?:\s+[A-Za-z0-9.&']+){0,4}$")
# Citation entre guillemets (droits ou courbes) : la formule PERSONNELLE de
# quelqu'un, pas le fait rapporté par l'article -- ne se retrouve quasiment
# jamais telle quelle dans la reprise d'un autre média.
_QUOTED_RE = re.compile(r'["“”].*?["“”]')
# "trading partner(s)" : formule diplomatique générique (n'importe quel pays
# a des "trading partners") -- même statut que "trade deal"/"executive
# order", déjà traités comme génériques dans _GOV_KEYWORDS.
_TRADING_PARTNERS_RE = re.compile(r"trading partners?", re.IGNORECASE)
_STORY_KEY_PUNCT_RE = re.compile(r"[^a-z0-9]+")


def story_key(title: str) -> str:
    """Clé d'HISTOIRE dérivée d'un titre (PUR -- cf. le commentaire de tête
    de fichier ~L99 pour le design complet de l'anti-spam politique).

    Pipeline : retrait du suffixe " - Source" de Google News -> retrait des
    citations entre guillemets -> retrait de la formule "trading partner(s)"
    -> minuscules -> retrait ponctuation -> retrait stopwords EN/FR + verbes
    de reportage génériques + "trump" (cf. _STORY_KEY_STOPWORDS) -> troncature
    légère à 6 caractères (stemming pauvre) -> garde les 4 tokens
    significatifs restants (dédupliqués), triés alphabétiquement, joints
    par '-'. "" si le titre est vide.

    4 et non 6 -- cf. le commentaire au-dessus de _STORY_KEY_TOKENS : la
    règle des 6 tokens les plus longs ne convergeait pas naturellement sur
    les paires réelles de calibration, ce repli à 4 est le résultat DOCUMENTÉ
    de cette calibration."""
    if not title:
        return ""
    t = _GNEWS_SUFFIX_RE.sub("", title)
    t = _QUOTED_RE.sub(" ", t)
    t = _TRADING_PARTNERS_RE.sub(" ", t)
    t = t.lower()
    t = t.replace("’", "'")
    t = re.sub(r"[.']", "", t)            # "U.S." -> "us" (pas "u s")
    t = _STORY_KEY_PUNCT_RE.sub(" ", t)    # reste de la ponctuation -> espace
    tokens = [w for w in t.split() if w]
    tokens = [w for w in tokens if w not in _STORY_KEY_STOPWORDS]
    # Token court gardé seulement s'il est un code entité reconnu (US/UE/
    # UK/ONU) -- sinon c'est du bruit (particule/article mal filtré).
    tokens = [w for w in tokens if len(w) >= 3 or w in ("us", "eu", "uk", "un")]
    tokens = [w[:_STORY_KEY_TRUNC] for w in tokens]
    seen_local = set()
    significant = []
    for w in tokens:
        if w not in seen_local:
            seen_local.add(w)
            significant.append(w)
    return "-".join(sorted(significant)[:_STORY_KEY_TOKENS])


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
    return {"seen": {}, "events": [], "seeded": {}, "stories": {}, "sent_log": []}


def _load_seen_state(path: Path) -> Dict[str, Any]:
    """Charge un état "vu" depuis un chemin quelconque (sert les deux
    stores : par-utilisateur et global). Absent -> état vierge. Corrompu ->
    état vierge SANS jamais planter (le fichier fautif est renommé en
    .corrupt, même convention que store.py -- on garde la trace du bug sans
    perdre la capacité de tourner).

    "stories" (dict story_key -> dernier envoi ISO) et "sent_log" (liste
    d'horodatages ISO d'envois gov, fenêtre glissante 1h) ne servent QUE
    l'état global politique (anti-spam par histoire, cf. tête de fichier
    ~L99) -- absents/mal typés (y compris un état "ancien format" écrit
    AVANT cette extension) -> repartent d'un dict/liste vide SANS planter,
    même philosophie que "seen"/"events"/"seeded" ci-dessous."""
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
    stories = data.get("stories")
    sent_log = data.get("sent_log")
    return {
        "seen": seen if isinstance(seen, dict) else {},
        "events": events if isinstance(events, list) else [],
        "seeded": seeded if isinstance(seeded, dict) else {},
        "stories": stories if isinstance(stories, dict) else {},
        "sent_log": sent_log if isinstance(sent_log, list) else [],
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


def _purge_old_sent_log(sent_log: List[str], now_dt: datetime, max_age_h: float) -> None:
    """Purge EN PLACE les horodatages d'envoi gov plus vieux que max_age_h
    heures -- fenêtre glissante du budget dur (_GOV_MAX_SENDS_PER_HOUR, cf.
    tête de fichier ~L99). Une entrée illisible est purgée par prudence,
    même raisonnement que _purge_old_seen : mieux vaut sous-compter le budget
    (donc parfois muter un envoi qui aurait pu passer) que le laisser
    grossir indéfiniment sur une entrée cassée."""
    cutoff = now_dt.timestamp() - max_age_h * 3600
    kept = []
    for iso_ts in sent_log:
        try:
            ts = datetime.fromisoformat(iso_ts)
            if ts.tzinfo is None:
                ts = ts.replace(tzinfo=timezone.utc)
            if ts.timestamp() >= cutoff:
                kept.append(iso_ts)
        except (TypeError, ValueError):
            continue
    sent_log[:] = kept


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


# --- portefeuilles + watchlist (extension 25/08 -- "sans baisser le nombre
# d'infos générales" : le volet gov ci-dessus est INCHANGÉ, cette union ne
# touche QUE le volet par-symbole) ------------------------------------------ #

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


def _load_watchlist_symbols(username: str) -> List[str]:
    """Symboles de la watchlist d'un utilisateur -- délègue à
    store.load_watchlist() (source de vérité I/O du paquet paper/, écrite et
    lue via le même chemin store.watchlist_path() par TOUS les modules,
    watchlist et news compris ; corrompu/absent -> [] par construction, cf.
    store.py). Entrée sans "symbol" -> ignorée en silence, jamais de crash --
    le volet news ne doit jamais tomber pour une donnée d'un AUTRE module."""
    symbols: List[str] = []
    for entry in store.load_watchlist(username):
        sym = entry.get("symbol")
        if isinstance(sym, str) and sym:
            symbols.append(sym)
    return symbols


def _merged_symbols(portfolio: Dict[str, Any], username: str) -> List[str]:
    """Symboles à surveiller pour un utilisateur : positions ouvertes UNION
    watchlist, dédupliqués de façon insensible à la casse (la casse de la
    PREMIÈRE occurrence est conservée -- positions d'abord, puis
    watchlist)."""
    merged: List[str] = []
    seen_upper = set()
    for sym in _position_symbols(portfolio):
        upper = sym.upper()
        if upper not in seen_upper:
            seen_upper.add(upper)
            merged.append(sym)
    for sym in _load_watchlist_symbols(username):
        upper = sym.upper()
        if upper not in seen_upper:
            seen_upper.add(upper)
            merged.append(sym)
    return merged


def _discover_portfolios() -> List[Tuple[str, Dict[str, Any]]]:
    """Liste (username, portfolio) pour chaque portefeuille possédant au
    moins une position ouverte OU un symbole en watchlist (extension 25/08).
    Ignore les fichiers auxiliaires (.coach.json, .news_seen.json,
    .watchlist.json -- ils matchent aussi le glob "*.json") ; les fichiers
    corrompus sont déjà hors du glob (store.py les renomme en .corrupt à la
    lecture, extension qui ne matche plus "*.json")."""
    data_dir = store.DATA_DIR
    if not data_dir.is_dir():
        return []
    out: List[Tuple[str, Dict[str, Any]]] = []
    for path in sorted(data_dir.glob("*.json")):
        name = path.name
        if (name.endswith(".coach.json") or name.endswith(".news_seen.json")
                or name.endswith(".watchlist.json")):
            continue
        username = path.stem
        try:
            portfolio = store.load_portfolio(username)
        except ValueError:
            continue
        if not isinstance(portfolio, dict):
            continue
        if _position_symbols(portfolio) or _load_watchlist_symbols(username):
            out.append((username, portfolio))
    return out


# --- le cycle ----------------------------------------------------------------- #

def run_once(now: Optional[datetime] = None,
            fetch: Optional[Callable[[str], str]] = None,
            notifier: Optional[Callable[[str, Dict[str, Any]], bool]] = None,
            tg_cfg: Optional[Dict[str, Any]] = None,
            sleep: Optional[Callable[[float], None]] = None) -> Dict[str, int]:
    """Un cycle de veille news : (1) volet politique GLOBAL (toujours, même
    sans portefeuille) puis (2) pour chaque utilisateur ayant des positions
    ouvertes ET/OU des symboles en watchlist, interroge le flux RSS Yahoo de
    chaque symbole surveillé (union dédupliquée, cf. _merged_symbols).
    Notifie Telegram sur toute news neg/pos/watch (par symbole) ou gov
    (globale) nouvelle. Retourne les compteurs {users, symbols, fetched,
    notified, errors} -- le volet gov contribue à fetched/notified/errors
    mais jamais à users/symbols (qui ne parlent que des portefeuilles).

    Sans config Telegram -> ne fait RIEN du tout, ni le volet gov ni le volet
    par utilisateur (ni disque ni réseau, feature opt-in silencieuse) : c'est
    vérifié EN PREMIER, avant tout accès à data/.
    """
    counters = {"users": 0, "symbols": 0, "fetched": 0, "notified": 0, "errors": 0}

    cfg = tg_cfg if tg_cfg is not None else (alerts.load_cfg() or {})
    if not cfg.get("token") or not cfg.get("chat_id"):
        logger.debug("paper newswatch: Telegram non configuré, rien à faire")
        return counters

    now_dt = now if now is not None else datetime.now(timezone.utc)
    if now_dt.tzinfo is None:
        now_dt = now_dt.replace(tzinfo=timezone.utc)
    fetch_fn = fetch if fetch is not None else _fetch_rss
    notify_fn = notifier if notifier is not None else alerts.send
    sleep_fn = sleep if sleep is not None else time.sleep

    first_call = True

    # ----------------------------------------------------------------- #
    # Volet 1 -- annonces politiques GLOBALES (§13). Tourne TOUJOURS, même
    # si personne ne détient de position : une politique commerciale ne
    # demande pas la permission d'un portefeuille pour bouger le marché.
    #
    # Anti-spam par HISTOIRE (incident du 24/08 soir, cf. commentaire de tête
    # ~L99) : deux couches AVANT le cap historique par-run
    # (_MAX_GOV_NOTIFY_PER_RUN, inchangé) -- mute par story_key (6h) puis
    # budget dur glissant (_GOV_MAX_SENDS_PER_HOUR). Les deux marquent
    # l'item vu (déjà fait plus haut) ET journalisent un event
    # "muted": True (rien n'est perdu, cf. tête de fichier) ; le cap
    # historique, lui, continue de sauter l'item EN SILENCE (comportement
    # préexistant conservé tel quel).
    # ----------------------------------------------------------------- #
    gov_state = _load_global_seen()
    gov_seen = gov_state["seen"]
    gov_seeded = gov_state["seeded"]
    gov_events = gov_state["events"]
    gov_stories = gov_state["stories"]
    gov_sent_log = gov_state["sent_log"]
    _purge_old_sent_log(gov_sent_log, now_dt, max_age_h=1)
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
            title = item.get("title", "")
            if not classify_gov(title):
                continue  # neutre/électoral -> juste marqué vu

            skey = story_key(title)
            muted = False
            last_sent_iso = gov_stories.get(skey)
            if last_sent_iso:
                try:
                    last_sent_dt = datetime.fromisoformat(last_sent_iso)
                    if last_sent_dt.tzinfo is None:
                        last_sent_dt = last_sent_dt.replace(tzinfo=timezone.utc)
                    age_story_h = (now_dt - last_sent_dt).total_seconds() / 3600
                    muted = age_story_h < _GOV_STORY_MUTE_H
                except (TypeError, ValueError):
                    muted = False  # horodatage illisible -> pas de mute par prudence
            if not muted and len(gov_sent_log) >= _GOV_MAX_SENDS_PER_HOUR:
                muted = True

            if muted:
                gov_events.insert(0, {
                    "ts": now_dt.isoformat(),
                    "symbol": "GOV",
                    "title": title,
                    "link": link,
                    "sentiment": "gov",
                    "muted": True,
                })
                continue

            if gov_notified_count >= _MAX_GOV_NOTIFY_PER_RUN:
                continue

            message = format_gov_message(title, link)
            try:
                ok = notify_fn(message, cfg)
            except Exception as exc:
                logger.warning("paper newswatch: notif gov échouée (%s)", type(exc).__name__)
                ok = False
            if ok:
                counters["notified"] += 1
                gov_notified_count += 1
                gov_stories[skey] = now_dt.isoformat()
                gov_sent_log.append(now_dt.isoformat())
                gov_events.insert(0, {
                    "ts": now_dt.isoformat(),
                    "symbol": "GOV",
                    "title": title,
                    "link": link,
                    "sentiment": "gov",
                    "muted": False,
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
    # Volet 2 -- par utilisateur, par symbole détenu ∪ symbole en watchlist
    # (extension 25/08 -- cf. _merged_symbols).
    # ----------------------------------------------------------------- #
    for username, portfolio in _discover_portfolios():
        counters["users"] += 1
        symbols = _merged_symbols(portfolio, username)
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
