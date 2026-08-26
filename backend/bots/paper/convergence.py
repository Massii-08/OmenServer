"""Convergence — le radar se tait, et quand plusieurs signaux s'alignent, UN
message (spec §13).

Le problème résolu : le radar notifiait à chaque hypothèse et à chaque verdict,
c'est-à-dire souvent, donc plus personne ne lisait. Il ACCUMULE désormais en
silence dans sa mémoire (``radar.json`` + ``Radar.md``) ; ce module regarde
périodiquement ce qui s'est accumulé et n'ouvre la bouche que lorsque
**plusieurs facteurs indépendants convergent**.

Doctrine, verbatim de l'utilisateur : « n'attends pas le parfait parce que ce
sera déjà trop tard — il faut faire des hypothèses pour prévoir ». Le seuil est
donc VOLONTAIREMENT bas (2 facteurs sur 5), et l'honnêteté est reportée sur
l'affichage : chaque digest rappelle le bilan chiffré du radar (réussies /
ratées / indécises). On risque, on ne se ment pas.

Les cinq facteurs, tous mesurés sur une fenêtre de 48 h :

======================  ====================================================
``fresh_hyps``          au moins 2 hypothèses de radar ouvertes et fraîches
``gov``                 au moins une annonce politique (sentiment ``gov``)
``held_catalyst``       un catalyseur (``watch``) sur un titre DÉTENU ou SUIVI
                        (watchlist) — la clé du facteur reste ``held_catalyst``
                        (contrat public stable) même si son déclencheur s'est
                        élargi à la watchlist (extension utilisateur)
``whale_filing``        un dépôt 13F d'un grand gérant
``cross_source``        un même symbole vu dans ≥ 2 familles de sources
``crowd_buzz``          la foule Reddit s'agite sur un titre détenu ou suivi
======================  ====================================================

Trois garde-fous contre le bavardage : seuil de 2 facteurs, **cooldown de 6 h**,
et **empreinte des items contributifs** — si rien de neuf n'est entré depuis le
dernier envoi, le message serait une redite et il ne part pas.

Panne du LLM -> on envoie QUAND MÊME un résumé déterministe : la valeur est
dans le DÉCLENCHEUR (« regarde maintenant »), pas dans la prose.

Découpage habituel du lot : ``collect_factors`` / ``fingerprint`` /
``should_fire`` / ``build_digest_prompt`` / ``fallback_digest`` sont PURS (zéro
I/O, zéro réseau) ; ``maybe_fire`` et ``recent`` sont les seules fonctions
d'I/O et toutes leurs dépendances (horloge, LLM, notifieur, config Telegram,
état du radar) sont injectables -> tests 100 % hors-ligne.

Les modules voisins (``radar``, ``newswatch``, ``whales``, ``store``, ``llm``,
``alerts``) sont importés PARESSEUSEMENT et chaque source est best-effort : une
source muette ne fait jamais tomber le calcul, elle rétrécit juste la matière.
"""
import hashlib
import json
import logging
import os
import threading
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Tuple

logger = logging.getLogger("omenserver")

# --------------------------------------------------------------------------- #
# Sérialisation des déclenchements (extension 2026-08-26 — convergence
# ÉVÉNEMENTIELLE).
#
# Depuis que ``newswatch`` (toutes les 5 min), ``whales`` (30 min) et ``radar``
# (3×/j) consultent tous cette couche à la fin de leur passage, TROIS jobs
# APScheduler du MÊME process uvicorn peuvent entrer ici en même temps. Or la
# protection anti-redite est un cycle « lire l'état -> décider -> envoyer ->
# réécrire l'état » : deux entrées simultanées lisent le même ``last_fired``,
# décident toutes les deux « ok », et l'utilisateur reçoit deux fois le même
# digest à la même seconde. Le verrou rend cette section indivisible.
#
# Il n'est PAS pris autour du calcul de la matière (lectures de fichiers des
# autres modules) : seulement autour de la décision et de ses effets.
# --------------------------------------------------------------------------- #
_FIRE_LOCK = threading.Lock()

STATE_NAME = "convergence.json"
NOTE_NAME = "Signaux.md"

# Fenêtre d'observation. Au-delà de 48 h, un signal a déjà été digéré par le
# marché : le faire compter dans une « convergence » serait se raconter une
# histoire après coup.
WINDOW_H = 48

# Seuil VOLONTAIREMENT bas (doctrine ci-dessus) : 2 facteurs sur 5.
MIN_FACTORS = 2

# Deux digests à moins de 6 h d'intervalle, c'est le bruit qu'on vient de tuer.
COOLDOWN_H = 6

MAX_HISTORY = 30
MAX_ITEMS_IN_PROMPT = 40
MAX_POSITIONS_IN_PROMPT = 20
MAX_FALLBACK_ITEMS = 18
MAX_FALLBACK_LINES = 25

FACTOR_CODES = ("fresh_hyps", "gov", "held_catalyst", "held_risk",
                "whale_filing", "whale_sold_watched", "cross_source",
                "crowd_buzz")

FACTOR_LABELS = {
    "fresh_hyps": "plusieurs hypothèses fraîches du radar",
    "gov": "annonce politique",
    "held_catalyst": "catalyseur sur un titre détenu ou suivi",
    "held_risk": "mauvaise nouvelle sur un titre que tu DÉTIENS",
    "whale_filing": "dépôt SEC d'un grand gérant",
    "whale_sold_watched": "un grand gérant a VENDU ou allégé un titre que tu "
                          "détiens ou suis",
    "cross_source": "même titre vu dans plusieurs sources",
    "crowd_buzz": "la foule Reddit s'agite sur un titre que tu détiens ou suis",
}

# Facteurs de MENACE DIRECTE sur le compte. Ils tirent SEULS (cf. ``should_fire``)
# : « être le dernier à vendre est le seul cas qu'on ne peut pas se permettre ».
# Le coût reste borné par le cooldown et l'empreinte, et ces deux facteurs sont
# intrinsèquement rares — ils n'existent que si un titre DÉTENU ou SUIVI est
# touché.
THREAT_FACTORS = ("held_risk", "whale_sold_watched")

# Un mouvement de gérant plus vieux que ça ne dit plus rien de l'instant : un
# 13F a déjà jusqu'à 45 jours de retard, y ajouter un snapshot périmé
# reviendrait à commenter l'avant-dernier trimestre.
WHALE_MOVE_FRESH_D = 7
WHALE_SELL_ACTIONS = ("sortie", "allégé")

# --- la foule (``crowd_buzz``, extension 2026-08-26) ----------------------- #
#
# Deux conditions, et il FAUT les deux. Le seuil absolu écarte le titre dont
# trois personnes ont parlé (ce n'est pas une foule) ; l'accélération écarte le
# titre dont la foule parle TOUS LES JOURS (ce n'est pas une nouvelle). C'est
# la rencontre des deux qui dit « il se passe quelque chose là, maintenant ».
#
# Facteur NORMAL et non facteur de MENACE (cf. ``THREAT_FACTORS``) : la foule
# ne tire jamais seule. Il lui faut un second facteur — un catalyseur, une
# annonce, une hypothèse — parce que le bruit social est un accélérant, pas une
# preuve. Un forum qui s'excite n'est pas une raison d'ouvrir le téléphone.
CROWD_MIN_MENTIONS = 5
CROWD_ACCELERATION = 2.0

# En-tête COMMUN au digest rédigé et au résumé de secours : quel que soit
# l'état du LLM, le message porte la même signature dans le fil Telegram.
HEADER = "[Simulateur] CONVERGENCE — plusieurs signaux s'alignent"

FALLBACK_TAIL = "(LLM indisponible — résumé brut, à toi de composer le mouvement.)"


# --------------------------------------------------------------------------- #
# Horloge & dates — tout en UTC NAÏF
#
# Mêmes règles que ``radar._parse_dt`` (ISO, epoch, date courte), volontairement
# RECOPIÉES ici : les fonctions pures de ce module doivent rester utilisables et
# testables même si le radar n'est pas déployé, et une fonction pure n'a pas à
# dépendre d'un module d'I/O.
# --------------------------------------------------------------------------- #

def _naive(value: datetime) -> datetime:
    """Ramène un datetime en UTC naïf (sans fuseau)."""
    if value.tzinfo is not None:
        return value.astimezone(timezone.utc).replace(tzinfo=None)
    return value


def _now() -> datetime:
    """Maintenant, en UTC naïf."""
    return _naive(datetime.now(timezone.utc))


def _parse_dt(value: Any) -> Optional[datetime]:
    """Date depuis un ISO, un epoch ou ``AAAA-MM-JJ``. ``None`` si illisible."""
    if value is None or isinstance(value, bool):
        return None
    if isinstance(value, datetime):
        return _naive(value)
    if isinstance(value, (int, float)):
        try:
            return _naive(datetime.fromtimestamp(float(value), tz=timezone.utc))
        except (OverflowError, OSError, ValueError):
            return None
    text = str(value).strip()
    if not text:
        return None
    try:
        # fromisoformat (3.9) ne connaît pas le suffixe « Z ».
        return _naive(datetime.fromisoformat(text.replace("Z", "+00:00")))
    except ValueError:
        pass
    try:
        return _naive(datetime.fromtimestamp(float(text), tz=timezone.utc))
    except (TypeError, ValueError, OverflowError, OSError):
        pass
    try:
        return datetime.strptime(text[:10], "%Y-%m-%d")
    except ValueError:
        return None


def _short_date(value: Any) -> str:
    """Les 10 premiers caractères d'un ISO — pour les titres de notes."""
    if not value:
        return "date inconnue"
    text = str(value)
    return text[:10] if len(text) >= 10 else text


# --------------------------------------------------------------------------- #
# Petits utilitaires PURS
# --------------------------------------------------------------------------- #

def _dicts(values: Any) -> List[Dict[str, Any]]:
    """Ne garde que les dictionnaires d'une séquence hétérogène."""
    if not isinstance(values, (list, tuple)):
        return []
    return [v for v in values if isinstance(v, dict)]


def _text(value: Any) -> str:
    return str(value if value is not None else "").strip()


def _upper(value: Any) -> str:
    return _text(value).upper()


def _hash(*parts: Any) -> str:
    """Identifiant court et STABLE dérivé du contenu (quand la source n'en
    fournit aucun : une dépêche sans lien, une hypothèse sans id)."""
    raw = "|".join(_text(p) for p in parts)
    return hashlib.sha1(raw.encode("utf-8")).hexdigest()[:12]


def _stats_line(stats: Optional[Dict[str, Any]]) -> str:
    """« X réussies / Y ratées / Z indécises » — la formule du radar, à
    l'identique : le bilan lu dans un digest doit être littéralement celui
    affiché par le radar."""
    stats = stats or {}

    def _n(key: str) -> int:
        try:
            return int(stats.get(key) or 0)
        except (TypeError, ValueError):
            return 0

    return "%d réussies / %d ratées / %d indécises" % (
        _n("hits"), _n("misses"), _n("unclear"))


def _tickers(hyp: Dict[str, Any]) -> List[str]:
    """Tickers d'une hypothèse, en majuscules, dédoublonnés dans l'ordre."""
    raw = hyp.get("tickers")
    if isinstance(raw, (list, tuple)):
        values = [_upper(t) for t in raw]
    else:
        values = [_upper(raw)]
    return list(dict.fromkeys([v for v in values if v]))


def _sentiment(event: Dict[str, Any]) -> str:
    return _text(event.get("sentiment")).lower()


def _is_polar(event: Dict[str, Any]) -> bool:
    """Dépêche à tonalité marquée (``pos``/``neg`` de ``newswatch.classify``).

    On teste le PRÉFIXE : ``newswatch`` écrit ``pos``/``neg``, mais des états
    plus anciens (ou un futur classifieur) peuvent porter ``positive`` /
    ``negative`` — un facteur ne doit pas s'éteindre sur un synonyme.
    """
    tone = _sentiment(event)
    return tone.startswith("pos") or tone.startswith("neg")


def _within(value: Any, cutoff: datetime) -> bool:
    """L'horodatage est-il dans la fenêtre ?

    Une date ILLISIBLE rend ``True`` : même posture que ``radar._collect_events``
    — mieux vaut un déclencheur de trop qu'un déclencheur perdu parce qu'une
    source a changé son format de date.
    """
    when = _parse_dt(value)
    return when is None or when >= cutoff


# --------------------------------------------------------------------------- #
# PUR — les facteurs
# --------------------------------------------------------------------------- #

def _item_hyp(hyp: Dict[str, Any]) -> Dict[str, Any]:
    thesis = _text(hyp.get("thesis"))
    tickers = _tickers(hyp)
    return {
        "src": "hyp",
        "id": _text(hyp.get("id")) or _hash("hyp", thesis),
        "title": thesis or "(hypothèse sans thèse)",
        "symbol": ", ".join(tickers),
        "ts": _text(hyp.get("created_at")),
    }


def _item_news(event: Dict[str, Any], src: Optional[str] = None) -> Dict[str, Any]:
    """Un item de presse. ``src`` distingue l'annonce politique (``gov``) du
    reste (``news``) : le prompt ne les pèse pas pareil.

    ``src`` explicite force l'étiquette (``neg_held`` pour une mauvaise
    nouvelle qui touche une position DÉTENUE) — le prompt doit pouvoir
    distinguer d'un coup d'œil ce qui menace le portefeuille de ce qui est une
    simple dépêche.
    """
    title = _text(event.get("title"))
    symbol = _upper(event.get("symbol"))
    if not src:
        src = "gov" if _sentiment(event) == "gov" else "news"
    return {
        "src": src,
        "id": _text(event.get("link")) or _hash("news", symbol, title),
        "title": title or "(dépêche sans titre)",
        "symbol": symbol,
        "ts": _text(event.get("ts")),
        "sentiment": _sentiment(event),
    }


def _item_filing(filing: Dict[str, Any]) -> Dict[str, Any]:
    label = _text(filing.get("label")) or _text(filing.get("manager_id")) or "?"
    form = _text(filing.get("form")) or "13F"
    date = _text(filing.get("filing_date")) or _text(filing.get("ts"))
    return {
        "src": "filing",
        "id": _text(filing.get("accession")) or _hash("filing", label, date),
        "title": "%s — dépôt %s" % (label, form),
        "symbol": "",
        "ts": date,
    }


def _item_whale(move: Dict[str, Any]) -> Dict[str, Any]:
    """Un item « mouvement de gérant ». Le libellé porte l'action ET le gérant :
    « sortie » sans savoir QUI est sorti ne veut rien dire."""
    label = _text(move.get("manager_label")) or "un grand gérant"
    action = _text(move.get("action")) or "mouvement"
    name = _text(move.get("name")) or "?"
    delta = move.get("delta_pct")
    detail = " (%s %%)" % delta if delta is not None else ""
    return {
        "src": "whale_move",
        "id": _hash("whale", label, action, name, _text(move.get("quarter"))),
        "title": "%s — %s sur %s%s" % (label, action, name, detail),
        "symbol": _upper(move.get("symbol")),
        "ts": _text(move.get("fetched_at")),
    }


def _int(value: Any) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return 0


def _item_crowd(symbol: str, count: int, prev: int) -> Dict[str, Any]:
    """Un item « la foule s'agite ». Le libellé porte le NOMBRE et
    l'ACCÉLÉRATION : « ça monte » sans dire de combien ne se vérifie pas.

    L'identité inclut les deux compteurs — donc elle CHANGE quand la vague
    grossit. C'est voulu : l'empreinte anti-redite doit laisser repartir un
    digest quand la foule est passée de 6 à 40 mentions, mais pas quand rien
    n'a bougé depuis le dernier envoi.
    """
    if prev > 0:
        detail = "%d mentions en 24 h, ×%s" % (
            count, ("%.1f" % (float(count) / prev)).replace(".", ","))
    else:
        detail = "%d mentions en 24 h, aucune la veille" % count
    return {
        "src": "crowd",
        "id": _hash("crowd", symbol, count, prev),
        "title": "la foule Reddit s'agite sur %s (%s)" % (symbol, detail),
        "symbol": symbol,
        "ts": "",
    }


def _crowd_items(reddit_trends: Any, watched: set) -> List[Dict[str, Any]]:
    """Les tickers dont la foule s'agite ET que ce portefeuille regarde (PUR).

    ``reddit_trends`` = ``{SYMBOLE: {count, prev}}``, tel que le rend
    ``newswatch.trends_view``. Le filtre par ``watched`` est ici et pas dans le
    guetteur : la veille compte les mentions du marché entier, c'est la
    convergence qui sait ce que CE portefeuille regarde.

    Tri par nombre de mentions décroissant, le symbole tranchant les ex æquo —
    deux appels rendent exactement la même liste, donc la même empreinte.
    """
    if not isinstance(reddit_trends, dict) or not watched:
        return []
    rows: List[Tuple[int, int, str]] = []
    for symbol, row in reddit_trends.items():
        symbol = _upper(symbol)
        if not symbol or symbol not in watched or not isinstance(row, dict):
            continue
        count, prev = _int(row.get("count")), _int(row.get("prev"))
        if count < CROWD_MIN_MENTIONS or count < CROWD_ACCELERATION * prev:
            continue
        rows.append((-count, prev, symbol))
    return [_item_crowd(symbol, -neg_count, prev)
            for neg_count, prev, symbol in sorted(rows)]


def collect_factors(now: Any, hypotheses: Any, news_events: Any,
                    filing_events: Any, watched_symbols: Any,
                    held_symbols: Any = None,
                    whale_moves: Any = None,
                    reddit_trends: Any = None) -> Dict[str, Any]:
    """Les huit facteurs et les items qui les portent (PUR).

    Rend ``{"factors": {code: bool, ...}, "items": [...]}``. Chaque item porte
    un ``src`` (``hyp``/``news``/``gov``/``filing``) et un ``id`` STABLE : c'est
    de ces ids que sort l'empreinte anti-redite.

    ``items`` ne contient QUE des éléments contributifs — ceux qui portent au
    moins un facteur VRAI. Un signal isolé qui n'allume rien n'a pas à peser
    dans l'empreinte : sinon la moindre dépêche ferait repartir un digest
    identique sur le fond.

    ``watched_symbols`` = titres DÉTENUS ∪ titres SUIVIS (watchlist) —
    l'union est faite par l'appelant (``maybe_fire``), cette fonction PURE ne
    sait pas d'où viennent les symboles, elle regarde juste si un catalyseur
    (sentiment ``watch``) en touche un. Le facteur produit reste nommé
    ``held_catalyst`` (clé stable du contrat public) même si son déclencheur
    s'est élargi.

    ``held_symbols`` = les titres RÉELLEMENT DÉTENUS, et eux seuls. C'est le
    facteur ``held_risk`` : une mauvaise nouvelle (sentiment ``neg``) sur un
    titre qu'on possède n'est pas de l'information, c'est de l'argent qui
    bouge — d'où un facteur distinct de ``held_catalyst``, qui lui accepte la
    watchlist. Absent -> ensemble VIDE (jamais un repli sur ``watched``, qui
    ferait passer un titre simplement suivi pour une position menacée).

    ``whale_moves`` = les mouvements de gérants DÉJÀ rapprochés d'un symbole
    par l'appelant (chaque entrée porte un champ ``symbol``). Le rapprochement
    nom d'émetteur -> ticker vit dans ``whales.match_issuer`` ; le faire ici
    obligerait cette fonction pure à importer un module d'I/O. Facteur
    ``whale_sold_watched`` : une SORTIE ou un ALLÈGEMENT sur un titre détenu ou
    suivi, vu par un snapshot de moins de ``WHALE_MOVE_FRESH_D`` jours.

    ``reddit_trends`` = ``{SYMBOLE: {count, prev}}`` (``newswatch.trends_view``)
    — le facteur ``crowd_buzz``, cf. ``_crowd_items``. Il ne participe
    VOLONTAIREMENT pas à ``cross_source`` : une quatrième famille faite de bruit
    social permettrait à une seule dépêche de fabriquer un croisement, et on
    aurait converti du bruit en facteur au lieu de le peser pour ce qu'il est.
    """
    now_dt = _parse_dt(now) or _now()
    cutoff = now_dt - timedelta(hours=WINDOW_H)
    watched = {_upper(s) for s in (watched_symbols or []) if _text(s)}
    held = {_upper(s) for s in (held_symbols or []) if _text(s)}

    fresh_hyps = [h for h in _dicts(hypotheses)
                  if (_text(h.get("status")) or "open") == "open"
                  and _within(h.get("created_at"), cutoff)]
    fresh_news = [e for e in _dicts(news_events) if _within(e.get("ts"), cutoff)]
    fresh_filings = [f for f in _dicts(filing_events)
                     if _within(f.get("ts") or f.get("filing_date"), cutoff)]

    gov_events = [e for e in fresh_news if _sentiment(e) == "gov"]
    watch_events = [e for e in fresh_news if _sentiment(e) == "watch"]
    held_catalysts = [e for e in watch_events if _upper(e.get("symbol")) in watched]
    # Le préfixe (et pas l'égalité) : ``newswatch`` écrit « neg », un état plus
    # ancien peut porter « negative » — même prudence que ``_is_polar``.
    held_risks = [e for e in fresh_news
                  if _sentiment(e).startswith("neg")
                  and _upper(e.get("symbol")) in held]

    whale_cutoff = now_dt - timedelta(days=WHALE_MOVE_FRESH_D)
    whale_sells = [m for m in _dicts(whale_moves)
                   if _text(m.get("action")) in WHALE_SELL_ACTIONS
                   and _upper(m.get("symbol")) in watched
                   and _within(m.get("fetched_at"), whale_cutoff)]

    # --- cross_source : le même symbole vu par des familles DIFFÉRENTES ----- #
    # Trois familles seulement (hypothèses / dépêches à tonalité / catalyseurs) :
    # deux dépêches du même flux sur le même titre, ce n'est pas une
    # convergence, c'est la même information comptée deux fois.
    fam_hyp = {t for h in fresh_hyps for t in _tickers(h)}
    fam_news = {_upper(e.get("symbol")) for e in fresh_news if _is_polar(e)}
    fam_watch = {_upper(e.get("symbol")) for e in watch_events}
    families = [{s for s in fam if s} for fam in (fam_hyp, fam_news, fam_watch)]

    crossing = set()
    for symbol in set().union(*families) if families else set():
        if sum(1 for fam in families if symbol in fam) >= 2:
            crossing.add(symbol)

    cross_items: List[Dict[str, Any]] = []
    for hyp in fresh_hyps:
        if crossing.intersection(_tickers(hyp)):
            cross_items.append(_item_hyp(hyp))
    for event in fresh_news:
        if _upper(event.get("symbol")) in crossing and (_is_polar(event)
                                                        or _sentiment(event) == "watch"):
            cross_items.append(_item_news(event))

    by_factor: Dict[str, List[Dict[str, Any]]] = {
        "fresh_hyps": [_item_hyp(h) for h in fresh_hyps] if len(fresh_hyps) >= 2 else [],
        "gov": [_item_news(e) for e in gov_events],
        "held_catalyst": [_item_news(e) for e in held_catalysts],
        "held_risk": [_item_news(e, src="neg_held") for e in held_risks],
        "whale_filing": [_item_filing(f) for f in fresh_filings],
        "whale_sold_watched": [_item_whale(m) for m in whale_sells],
        "cross_source": cross_items,
        "crowd_buzz": _crowd_items(reddit_trends, watched),
    }
    factors = {code: bool(by_factor[code]) for code in FACTOR_CODES}

    # Dédoublonnage par IDENTIFIANT SEUL (et non par ``(src, id)``) : depuis
    # ``held_risk``, une même dépêche peut être proposée sous deux étiquettes
    # (``neg_held`` puis ``news`` via ``cross_source``) — la compter deux fois
    # gonflerait artificiellement la matière. L'identifiant est déjà qualifié
    # par famille à la source (lien, accession, ``_hash("hyp"|"news"|…)``), donc
    # cette clé plus courte ne peut pas confondre deux items différents.
    items: List[Dict[str, Any]] = []
    seen = set()
    for code in FACTOR_CODES:
        if not factors[code]:
            continue
        for item in by_factor[code]:
            key = item["id"]
            if key in seen:
                continue
            seen.add(key)
            items.append(item)

    return {"factors": factors, "items": items}


def fingerprint(items: Any) -> str:
    """Empreinte STABLE des items contributifs (PUR).

    Indépendante de l'ordre (les sources ne rendent pas toujours leurs listes
    dans le même sens) et qualifiée par la source : deux familles différentes
    peuvent porter le même identifiant sans se confondre.
    """
    keys = sorted("%s:%s" % (_text(i.get("src")) or "?", _text(i.get("id")))
                  for i in _dicts(items))
    return hashlib.sha1("|".join(keys).encode("utf-8")).hexdigest()


def _flags(factors: Any) -> Dict[str, bool]:
    """Normalise l'entrée : on accepte le dict de drapeaux OU le retour complet
    de ``collect_factors`` (une signature tolérante évite le bug idiot du
    mauvais niveau — piège #61 du dépôt)."""
    if isinstance(factors, dict) and isinstance(factors.get("factors"), dict):
        factors = factors["factors"]
    if not isinstance(factors, dict):
        return {code: False for code in FACTOR_CODES}
    return {code: bool(factors.get(code)) for code in FACTOR_CODES}


def active_factors(factors: Any) -> List[str]:
    """Les codes de facteurs VRAIS, dans l'ordre canonique (PUR)."""
    flags = _flags(factors)
    return [code for code in FACTOR_CODES if flags[code]]


def should_fire(factors: Any, state: Any, now: Any, fingerprint_: Any,
                force: bool = False) -> Tuple[bool, str]:
    """Faut-il envoyer un digest ? (PUR) -> ``(bool, raison)``.

    Raisons : ``ok`` / ``too_few`` (moins de 2 facteurs) / ``cooldown`` (moins
    de 6 h depuis le dernier envoi) / ``same_items`` (exactement la même
    matière que la dernière fois).

    **Un facteur de MENACE DIRECTE tire SEUL** (``THREAT_FACTORS`` :
    ``held_risk``, ``whale_sold_watched``). Le seuil de deux facteurs sert à
    filtrer le bruit d'opportunité ; il n'a rien à faire devant une mauvaise
    nouvelle sur un titre qu'on POSSÈDE — être le dernier à vendre est le seul
    cas qu'on ne peut pas se permettre. Le cooldown et l'empreinte, eux, restent
    en place : le coût est borné exactement pareil.

    ``force`` saute le cooldown et l'empreinte — PAS le seuil de facteurs : un
    digest sans convergence n'a rien à dire, le forcer produirait justement le
    bruit qu'on vient de supprimer.

    Un ``last_fired`` situé dans le FUTUR (horloge décalée, état recopié depuis
    une autre machine) est IGNORÉ plutôt que respecté : sinon le cooldown se
    verrouillerait pour toujours (leçon du piège #66a).
    """
    state = state if isinstance(state, dict) else {}
    active = active_factors(factors)
    threatened = any(code in THREAT_FACTORS for code in active)
    if len(active) < MIN_FACTORS and not threatened:
        return False, "too_few"
    if force:
        return True, "ok"

    now_dt = _parse_dt(now) or _now()
    last = _parse_dt(state.get("last_fired"))
    if last is not None and last <= now_dt and (now_dt - last) < timedelta(hours=COOLDOWN_H):
        return False, "cooldown"

    fp = _text(fingerprint_)
    if fp and fp == _text(state.get("last_fingerprint")):
        return False, "same_items"
    return True, "ok"


# --------------------------------------------------------------------------- #
# PUR — le prompt et son filet de secours
# --------------------------------------------------------------------------- #

def _item_line(item: Dict[str, Any]) -> str:
    """Une ligne d'item, même forme dans le prompt et dans le résumé brut."""
    symbol = _text(item.get("symbol"))
    return "- [%s] %s%s%s" % (
        _text(item.get("src")) or "?",
        _text(item.get("title")) or "(sans titre)",
        (" — %s" % symbol) if symbol else "",
        (" — %s" % _short_date(item.get("ts"))) if item.get("ts") else "",
    )


def build_digest_prompt(factors: Any, items: Any, stats: Any, positions: Any,
                        now_iso: str) -> str:
    """Le prompt du digest de convergence (PUR).

    Il demande explicitement des MOUVEMENTS À JOUER — c'est la demande de
    l'utilisateur, qui veut du risque assumé et pas une revue de presse — tout
    en interdisant les deux dérives : le vocabulaire de la certitude et le
    conseil d'investissement réel.

    Depuis le passage en **mode calme** (2026-08-26), ce message est le SEUL
    que l'utilisateur reçoit : les émetteurs unitaires se taisent. Deux
    conséquences écrites dans le prompt :

    * il s'adresse à un DÉBUTANT — il doit expliquer POURQUOI ces facteurs
      ensemble comptent, en phrases simples. Un digest qu'on ne comprend pas
      est un digest qu'on n'ouvre plus, donc le bruit qu'on vient de tuer ;
    * quand ``held_risk`` est allumé, une section DÉDIÉE dit ce qui menace le
      portefeuille. C'est la moitié de la demande (« opportunité d'achat OU
      chute de nos actions ») et elle n'existait nulle part.
    """
    flags = _flags(factors)
    rows = _dicts(items)[:MAX_ITEMS_IN_PROMPT]
    lines: List[str] = []

    lines.append(
        "Tu es le conseiller d'un SIMULATEUR de trading (argent FICTIF, "
        "utilisateur débutant, résident suisse, cours différés 15 min).")
    lines.append("Date du jour : %s." % (now_iso or "inconnue"))
    lines.append("")
    lines.append(
        "Cet utilisateur VEUT du risque ASSUMÉ : il apprend à parier et à "
        "dimensionner, pas à attendre le signal parfait. Sa doctrine : "
        "« n'attends pas le parfait, ce serait déjà trop tard — il faut faire "
        "des hypothèses pour prévoir ». Tu es donc DIRECT et ASSERTIF, tu le "
        "tutoies, et tu proposes des mouvements — en assumant que ce sont des "
        "PARIS raisonnés, jamais des prédictions.")
    lines.append("")
    lines.append(
        "IMPORTANT — il est DÉBUTANT, et ce message est le SEUL qu'il reçoit : "
        "les alertes unitaires sont éteintes, tout passe par toi. Explique donc "
        "POURQUOI ces facteurs ENSEMBLE comptent, en phrases simples, sans "
        "jargon non défini : si tu emploies un terme de métier (catalyseur, "
        "dépôt 13F, asymétrie, stop…), tu le définis en trois mots au passage. "
        "Il doit pouvoir décider sans aller chercher ailleurs ce que tu as "
        "voulu dire.")
    lines.append("")
    lines.append(
        "PARLE TÔT — c'est la consigne la plus importante. Tu interviens "
        "PENDANT que la situation se forme, pas après confirmation. Quand les "
        "facteurs s'alignent, tu prends POSITION (simulateur) : dis ce que TU "
        "ferais MAINTENANT — le mouvement, une taille PETITE, le stop, "
        "l'invalidation — plutôt que « à surveiller ». L'incertitude se gère "
        "par la TAILLE, jamais par l'attente. Il t'est INTERDIT de conclure "
        "par « attendre la confirmation » sans proposer au moins une action "
        "concrète assortie de son invalidation. Être tôt et parfois faux "
        "(petit) vaut mieux qu'être sûr et dernier — ton bilan public te tient "
        "honnête.")
    lines.append("")

    lines.append("POURQUOI CE MESSAGE PART MAINTENANT — facteurs alignés :")
    for code in FACTOR_CODES:
        if flags[code]:
            lines.append("- %s (%s)" % (FACTOR_LABELS[code], code))
    lines.append("")

    lines.append("MATIÈRE (48 h) — tu n'as le droit d'utiliser QUE ceci :")
    if rows:
        for item in rows:
            lines.append(_item_line(item))
    else:
        lines.append("- (aucun item)")
    lines.append("")

    lines.append("POSITIONS ACTUELLEMENT DÉTENUES DANS LE SIMULATEUR :")
    held = _dicts(positions)[:MAX_POSITIONS_IN_PROMPT]
    if held:
        for pos in held:
            lines.append("- %s %s x%s" % (
                _upper(pos.get("symbol")) or "?",
                _text(pos.get("side")) or "long",
                _text(pos.get("qty")) or "?"))
    else:
        lines.append("- (aucune)")
    lines.append("")

    lines.append("BILAN CUMULÉ DU RADAR : %s." % _stats_line(stats))
    lines.append("")

    lines.append("STRUCTURE IMPOSÉE DE TA RÉPONSE, dans cet ordre :")
    blocks = [
        "Un bloc titré exactement « CE QUI S'ALIGNE » : 2 à 4 phrases de "
        "DÉBUTANT expliquant ce qui converge et pourquoi ces éléments, mis "
        "ensemble, comptent MAINTENANT — pas chacun séparément, c'est leur "
        "rencontre qui fait le message.",
        "Un bloc titré exactement « OPPORTUNITÉS (simulateur) » : 2 à "
        "4 mouvements, chacun sur ce moule — direction (achat/vente à "
        "découvert) + ticker(s) Yahoo + thèse en UNE ligne + horizon en jours "
        "+ risque suggéré entre 0,5 % et 1 % du capital + « invalidé si : … ». "
        "Si la matière ne porte AUCUNE opportunité honnête, écris le titre du "
        "bloc et dis-le franchement — zéro est une réponse légitime.",
    ]
    if flags.get("held_risk"):
        blocks.append(
            "Un bloc titré exactement « RISQUES SUR TES POSITIONS » — "
            "OBLIGATOIRE ici, parce que le facteur « mauvaise nouvelle sur un "
            "titre que tu détiens » est allumé. Dis : quelles positions sont "
            "menacées (les lignes marquées [neg_held] ci-dessus), par QUOI "
            "exactement, et ce que TU surveillerais pour trancher. Dans un "
            "simulateur, garder / alléger / sortir sont des choix qui lui "
            "appartiennent : tu éclaires la décision, tu ne la prends pas à sa "
            "place.")
    if flags.get("whale_sold_watched"):
        blocks.append(
            "Un bloc titré exactement « UN GRAND GÉRANT A VENDU » — "
            "OBLIGATOIRE ici. Les lignes marquées [whale_move] ci-dessus sont "
            "des sorties ou des allègements portant sur un titre qu'il détient "
            "ou qu'il suit. Dis ce que ça PEUT vouloir dire (le gérant voit "
            "peut-être quelque chose que le marché n'a pas encore prix), et "
            "dis dans la MÊME section ce que ça ne prouve PAS : un formulaire "
            "13F est publié avec jusqu'à 45 jours de retard — la vente a donc "
            "déjà eu lieu il y a des semaines — et un allègement peut n'être "
            "qu'une rotation interne ou une sortie de fonds, pas un avis sur "
            "le titre. Cette double honnêteté est OBLIGATOIRE : sans elle, "
            "l'information est trompeuse.")
    if flags.get("crowd_buzz"):
        blocks.append(
            "Un bloc titré exactement « LA FOULE S'AGITE » — OBLIGATOIRE ici. "
            "Les lignes marquées [crowd] ci-dessus comptent combien de fois un "
            "ticker a été cité sur les forums boursiers de Reddit en 24 heures, "
            "comparé aux 24 heures d'avant. Reprends le titre et le nombre, "
            "puis dis-le franchement dans la même section : le bruit social est "
            "un ACCÉLÉRANT, pas une preuve — il dit que d'autres regardent le "
            "même titre au même moment (donc que ça peut bouger vite, dans les "
            "DEUX sens), jamais que la thèse est bonne. Une foule peut avoir "
            "tort longtemps. Si aucun autre élément de la matière ne soutient "
            "ce titre, dis-le aussi : l'agitation seule ne se joue pas.")
    blocks.append("Une dernière ligne rappelant le bilan du radar : %s."
                  % _stats_line(stats))
    for index, block in enumerate(blocks, start=1):
        lines.append("%d. %s" % (index, block))
    lines.append("")

    lines.append("INTERDITS ABSOLUS :")
    lines.append(
        "- les mots « sûr » et « garanti », et tout vocabulaire de la "
        "certitude : ce sont des paris, tu le dis ;")
    lines.append(
        "- toute recommandation d'acheter ou de vendre avec de l'ARGENT RÉEL : "
        "on est dans un simulateur d'apprentissage ;")
    lines.append(
        "- inventer une donnée, un chiffre ou un événement qui n'est pas dans "
        "la matière ci-dessus.")
    lines.append("")
    lines.append("Réponds en français, sans emojis, sans titres markdown "
                 "pompeux, 150 à 400 mots.")

    return "\n".join(lines)


def fallback_digest(factors: Any, items: Any, stats: Any) -> str:
    """Le résumé de secours quand le LLM ne répond pas (PUR).

    Déterministe, compact, et ENVOYÉ QUAND MÊME : la valeur du digest est le
    déclencheur (« regarde maintenant, voici ce qui s'est aligné »), pas la
    prose. Borné à ``MAX_FALLBACK_LINES`` (25) lignes pour rester lisible sur
    un téléphone.
    """
    flags = _flags(factors)
    rows = _dicts(items)
    labels = [FACTOR_LABELS[c] for c in FACTOR_CODES if flags[c]] or ["(aucun)"]

    lines = [HEADER, "Facteurs alignés : %s." % ", ".join(labels)]
    for item in rows[:MAX_FALLBACK_ITEMS]:
        lines.append(_item_line(item))
    extra = len(rows) - MAX_FALLBACK_ITEMS
    if extra > 0:
        lines.append("- … et %d autre(s) élément(s)." % extra)
    lines.append("Bilan du radar : %s." % _stats_line(stats))
    lines.append(FALLBACK_TAIL)
    return "\n".join(lines[:MAX_FALLBACK_LINES])


def with_header(text: Any) -> str:
    """Préfixe le digest de l'en-tête commun (idempotent : le résumé de secours
    le porte déjà)."""
    body = _text(text)
    if body.startswith(HEADER):
        return body
    return "%s\n%s" % (HEADER, body) if body else HEADER


def format_note(digest: str, now_iso: str, factors: Any, used_llm: bool) -> str:
    """Bloc markdown appendable à ``Signaux.md`` (PUR) — même convention que le
    carnet du coach et ``Radar.md`` : ``## date — titre``, bloc terminé par une
    ligne vide pour que deux appends restent lisibles.

    Le titre ne porte que les trois premiers facteurs : une ligne de titre de
    200 caractères n'est plus un titre, et le détail complet est de toute façon
    dans le digest juste en dessous.
    """
    codes = active_factors(factors)
    labels = [FACTOR_LABELS[c] for c in codes[:3]] or ["(aucun)"]
    if len(codes) > 3:
        labels.append("+%d" % (len(codes) - 3))
    lines = [
        "## %s — convergence (%s)" % (_short_date(now_iso), ", ".join(labels)),
        "",
        _text(digest),
        "",
        "- Rédigé par le modèle." if used_llm
        else "- Résumé de secours (modèle indisponible).",
        "- Ce sont des paris de simulateur, notés par le radar à l'échéance.",
        "",
        "[[Radar]] · [[Journal]]",
        "",
    ]
    return "\n".join(lines) + "\n"


# --------------------------------------------------------------------------- #
# État persistant — data/paper_trading/convergence.json
#
# Écriture ATOMIQUE 0o600 (patron du projet) : le temporaire NAÎT en 0o600 via
# ``os.open``, ``os.replace`` bascule d'un coup.
# --------------------------------------------------------------------------- #

def _store():
    """Le module de persistance du paper trading (import paresseux)."""
    from backend.bots.paper import store
    return store


def state_path() -> Path:
    """Chemin du fichier d'état, relu à CHAQUE appel depuis ``store.DATA_DIR``
    (un test qui isole ce répertoire isole aussi la convergence)."""
    return Path(_store().DATA_DIR) / STATE_NAME


def blank_state() -> Dict[str, Any]:
    """État vierge (PUR) — la forme canonique, en un seul endroit."""
    return {"last_fired": None, "last_fingerprint": None, "history": []}


def load_state() -> Dict[str, Any]:
    """Charge l'état. Absent, illisible ou déformé -> état vierge."""
    state = blank_state()
    try:
        path = state_path()
        if not path.is_file():
            return state
        with open(str(path), "r", encoding="utf-8") as handle:
            raw = json.load(handle)
    except (OSError, ValueError, ImportError):
        return state
    if not isinstance(raw, dict):
        return state
    last_fired = raw.get("last_fired")
    state["last_fired"] = last_fired if isinstance(last_fired, str) else None
    fp = raw.get("last_fingerprint")
    state["last_fingerprint"] = fp if isinstance(fp, str) else None
    history = raw.get("history")
    if isinstance(history, list):
        state["history"] = [h for h in history if isinstance(h, dict)][:MAX_HISTORY]
    return state


def save_state(state: Dict[str, Any]) -> None:
    """Persiste l'état de façon atomique, 0o600."""
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


# --------------------------------------------------------------------------- #
# I/O — collecte des entrées, toutes best-effort
# --------------------------------------------------------------------------- #

def _default_llm(prompt: str) -> str:
    """Le CLI Claude via ``paper/llm.py`` (texte brut)."""
    from backend.bots.paper import llm as llm_mod
    return llm_mod._claude_text(prompt)


def _radar_state(fetch_state: Optional[Callable[[], Any]]) -> Dict[str, Any]:
    """L'état du radar : ses hypothèses et son bilan. Injectable pour les tests
    (et pour un futur appelant qui l'aurait déjà en main)."""
    try:
        if fetch_state is not None:
            state = fetch_state()
        else:
            from backend.bots.paper import radar
            state = radar.load_state()
    except Exception:      # noqa: BLE001 — radar absent ou en panne
        return {}
    return state if isinstance(state, dict) else {}


def _users() -> List[str]:
    """Les comptes ayant un portefeuille — la liste du RADAR (source unique :
    deux listes divergentes écriraient les notes chez des gens différents)."""
    try:
        from backend.bots.paper import radar
        return list(radar._users_with_portfolio() or [])
    except Exception:      # noqa: BLE001
        return []


def _collect_news(users: List[str]) -> List[Dict[str, Any]]:
    """Les dépêches récentes de tous les comptes, dédupliquées par lien.

    ``newswatch.recent_events`` fusionne déjà les événements politiques
    GLOBAUX dans le retour de chaque utilisateur : sans déduplication, une
    annonce politique compterait autant de fois qu'il y a de comptes.
    """
    try:
        from backend.bots.paper import newswatch
    except Exception:      # noqa: BLE001
        return []

    out: List[Dict[str, Any]] = []
    seen = set()
    for username in users:
        try:
            events = newswatch.recent_events(username) or []
        except Exception:  # noqa: BLE001 — une source muette ne casse rien
            continue
        for event in _dicts(events):
            key = _text(event.get("link")) or "%s|%s" % (
                _text(event.get("symbol")), _text(event.get("title")))
            if key in seen:
                continue
            seen.add(key)
            out.append(event)
    return out


def _collect_filings() -> List[Dict[str, Any]]:
    """Les dépôts 13F détectés (best-effort)."""
    try:
        from backend.bots.paper import whales
        return _dicts(whales.recent_filing_events() or [])
    except Exception:      # noqa: BLE001
        return []


def _collect_positions(users: List[str]) -> Tuple[List[Dict[str, Any]], List[str]]:
    """``(positions, symboles détenus)`` de tous les comptes (best-effort).

    Le simulateur est mono-utilisateur en pratique ; on additionne quand même
    les comptes pour que le facteur « catalyseur sur une position détenue » ne
    dépende pas de QUI a ouvert la ligne.
    """
    positions: List[Dict[str, Any]] = []
    held: List[str] = []
    try:
        store = _store()
    except Exception:      # noqa: BLE001
        return positions, held

    for username in users:
        try:
            portfolio = store.load_portfolio(username) or {}
        except Exception:  # noqa: BLE001
            continue
        for pos in _dicts(portfolio.get("positions")):
            symbol = _upper(pos.get("symbol"))
            if not symbol:
                continue
            positions.append({"symbol": symbol,
                              "side": _text(pos.get("side")) or "long",
                              "qty": pos.get("qty")})
            if symbol not in held:
                held.append(symbol)
    return positions, held


def _symbol_names(users: List[str]) -> Dict[str, str]:
    """``{symbole: nom}`` des titres détenus ET suivis (best-effort).

    Ce sont ces noms — venus de Yahoo, déjà stockés — qui permettent de
    rapprocher un émetteur 13F (« APPLE INC ») d'un ticker. Sans nom, pas de
    rapprochement : on ne devine jamais.

    ⚠️ Une POSITION ne porte PAS de nom (``models.Position`` n'a que le
    symbole) ; la WATCHLIST, elle, en porte un. Un vrai nom l'emporte donc
    TOUJOURS sur le repli « le symbole lui-même » — sans quoi un titre à la
    fois détenu et suivi serait enregistré sous son ticker (lu en premier),
    et plus aucun émetteur 13F ne le rejoindrait.
    """
    out: Dict[str, str] = {}

    def _remember(symbol: str, name: str) -> None:
        if not symbol:
            return
        if name and name.upper() != symbol:
            out[symbol] = name              # un VRAI nom gagne toujours
        elif symbol not in out:
            out[symbol] = symbol            # repli : au moins la clé existe

    try:
        store = _store()
    except Exception:      # noqa: BLE001
        return out
    for username in users:
        try:
            portfolio = store.load_portfolio(username) or {}
        except Exception:  # noqa: BLE001
            portfolio = {}
        for pos in _dicts(portfolio.get("positions")):
            _remember(_upper(pos.get("symbol")), _text(pos.get("name")))
        try:
            rows = store.load_watchlist(username) or []
        except Exception:  # noqa: BLE001
            rows = []
        for row in _dicts(rows):
            _remember(_upper(row.get("symbol")), _text(row.get("name")))
    return out


def _collect_whale_moves(names: Dict[str, str]) -> List[Dict[str, Any]]:
    """Les mouvements de gérants RAPPROCHÉS d'un ticker (best-effort).

    Lit le CACHE seul (``whales.moves_summary``) — jamais la SEC : c'est le
    guetteur des dépôts qui tient ce cache au chaud. Un mouvement qu'on ne sait
    pas rattacher à un titre suivi est écarté ici : il n'a rien à dire à ce
    portefeuille, et un rapprochement approximatif serait pire que rien.
    """
    if not names:
        return []
    try:
        from backend.bots.paper import whales
        rows = whales.moves_summary() or []
    except Exception:      # noqa: BLE001 — module absent ou cache illisible
        return []
    out: List[Dict[str, Any]] = []
    for move in _dicts(rows):
        try:
            symbol = whales.match_issuer(move.get("name"), names)
        except Exception:  # noqa: BLE001
            symbol = None
        if not symbol:
            continue
        row = dict(move)
        row["symbol"] = symbol
        out.append(row)
    return out


def _collect_reddit_trends(now: Any = None) -> Dict[str, Any]:
    """Les mentions Reddit par ticker, depuis l'état du guetteur (best-effort).

    Lecture de fichier LOCAL seulement : c'est ``newswatch`` qui interroge
    Reddit (un cycle sur trois, plafond de 1 requête/60 s). Cette fonction est
    appelée à chaque évaluation de convergence — donc toutes les 5 minutes —
    et doit rester gratuite.
    """
    try:
        from backend.bots.paper import newswatch
        rows = newswatch.recent_trends(now)
    except Exception:      # noqa: BLE001 — module absent ou état illisible
        return {}
    return rows if isinstance(rows, dict) else {}


def _collect_watchlist(users: List[str]) -> List[str]:
    """Symboles SUIVIS (watchlist) de tous les comptes, dédoublonnés en
    majuscules, ordre stable (best-effort — un compte sans watchlist ou en
    panne ne casse rien, même posture que ``_collect_positions``)."""
    out: List[str] = []
    try:
        store = _store()
    except Exception:      # noqa: BLE001
        return out
    seen = set()
    for username in users:
        try:
            symbols = store.load_watchlist(username) or []
        except Exception:  # noqa: BLE001
            continue
        for row in _dicts(symbols):
            symbol = _upper(row.get("symbol"))
            if not symbol or symbol in seen:
                continue
            seen.add(symbol)
            out.append(symbol)
    return out


def _note_all(users: List[str], text: str) -> None:
    """Appende un bloc à ``Signaux.md`` de CHAQUE compte. Best-effort : une
    note qui échoue ne doit jamais faire perdre l'état."""
    try:
        store = _store()
    except Exception:      # noqa: BLE001
        return
    for username in users:
        try:
            store.append_note(username, NOTE_NAME, text)
        except Exception:  # noqa: BLE001
            pass


def _send(notifier: Optional[Callable[[str, Dict[str, Any]], Any]],
          text: str, cfg: Dict[str, Any]) -> bool:
    """Envoi best-effort. Le notifieur injecté a la même signature que celui du
    radar et du newswatch : ``(texte, cfg) -> bool``."""
    try:
        if notifier is not None:
            return bool(notifier(text, cfg))
        from backend.bots.paper import alerts
        return bool(alerts.send(text, cfg))
    except Exception:      # noqa: BLE001 — ne fuite jamais le jeton
        return False


# --------------------------------------------------------------------------- #
# I/O — le déclencheur
# --------------------------------------------------------------------------- #

def maybe_fire(now: Any = None,
               llm: Optional[Callable[[str], str]] = None,
               notifier: Optional[Callable[[str, Dict[str, Any]], Any]] = None,
               tg_cfg: Optional[Dict[str, Any]] = None,
               fetch_state: Optional[Callable[[], Any]] = None,
               force: bool = False) -> Dict[str, Any]:
    """Regarde ce qui s'est accumulé et envoie UN digest si ça converge.

    Retourne ``{fired, reason, factors, sent, llm}``. ``fired`` dit si un
    digest est parti (ou a tenté de partir), ``reason`` pourquoi pas
    (``too_few``/``cooldown``/``same_items``/``no_telegram``), ``sent`` si
    Telegram a accusé réception, ``llm`` si la prose vient du modèle.

    Appelée à la fin de chaque passage du radar (3×/jour) et par
    ``POST /api/paper/digest/run``. Toutes les dépendances sont injectables ->
    tests 100 % hors-ligne.

    **L'état est armé même si l'envoi Telegram échoue** : le cooldown et
    l'empreinte protègent de la REDITE, et une panne de réseau qui les laisserait
    désarmés ferait repartir le même message à chaque passage du radar. Un
    digest perdu se rattrape au prochain signal ; une boucle de redites, non.
    En revanche, **aucun canal configuré n'arme rien** : le message n'a jamais
    été composé pour personne, il doit pouvoir partir dès qu'un canal existe.
    """
    now_dt = _parse_dt(now) if now is not None else _now()
    if now_dt is None:
        now_dt = _now()
    now_iso = now_dt.isoformat()

    radar_state = _radar_state(fetch_state)
    hypotheses = radar_state.get("hypotheses") if isinstance(radar_state, dict) else []
    stats = radar_state.get("stats") if isinstance(radar_state, dict) else {}

    users = _users()
    news = _collect_news(users)
    filings = _collect_filings()
    positions, held = _collect_positions(users)
    watchlist_symbols = _collect_watchlist(users)
    # Union, ordre stable : un titre juste SUIVI mérite le même facteur qu'un
    # titre DÉTENU (extension utilisateur — la clé reste ``held_catalyst``).
    watched_symbols = list(dict.fromkeys(held + watchlist_symbols))

    whale_moves = _collect_whale_moves(_symbol_names(users))
    # ``now_dt`` et pas l'horloge du système : les fenêtres 24 h / 24-48 h du
    # compteur de mentions doivent parler du même instant que le reste du
    # calcul, sinon un test à horloge figée mesurerait autre chose que la prod.
    reddit_trends = _collect_reddit_trends(now_dt)

    collected = collect_factors(now_dt, hypotheses, news, filings,
                                watched_symbols, held_symbols=held,
                                whale_moves=whale_moves,
                                reddit_trends=reddit_trends)
    flags = collected["factors"]
    items = collected["items"]
    fp = fingerprint(items)

    # --- section critique : lire l'état -> décider -> envoyer -> réécrire --- #
    # Trois guetteurs peuvent arriver ici en même temps (cf. ``_FIRE_LOCK``).
    with _FIRE_LOCK:
        state = load_state()
        ok, reason = should_fire(flags, state, now_dt, fp, force=force)
        if not ok:
            # Sortie AVANT tout appel au LLM et tout envoi : c'est ce qui rend
            # l'évaluation à chaque cycle de 5 min gratuite (pur I/O local).
            return {"fired": False, "reason": reason, "factors": flags,
                    "sent": False, "llm": False}

        cfg = tg_cfg
        if cfg is None:
            try:
                from backend.bots.paper import alerts
                cfg = alerts.load_cfg()
            except Exception:  # noqa: BLE001
                cfg = None
        if not (cfg or {}).get("token") or not (cfg or {}).get("chat_id"):
            logger.debug("paper convergence: convergence détectée mais aucun canal")
            return {"fired": False, "reason": "no_telegram", "factors": flags,
                    "sent": False, "llm": False}

        used_llm = True
        try:
            text = (llm or _default_llm)(
                build_digest_prompt(flags, items, stats, positions, now_iso))
            text = _text(text)
            if not text:
                raise RuntimeError("digest vide")
        except Exception:  # noqa: BLE001 — LLM muet : on envoie le résumé brut
            used_llm = False
            text = fallback_digest(flags, items, stats)
        message = with_header(text)

        sent = _send(notifier, message, cfg)

        state["last_fired"] = now_iso
        state["last_fingerprint"] = fp
        entry = {
            "ts": now_iso,
            "factors": active_factors(flags),
            "n_items": len(items),
            "digest": message,
            "llm": used_llm,
        }
        state["history"] = ([entry] + list(state.get("history") or []))[:MAX_HISTORY]
        try:
            save_state(state)
        except (OSError, ImportError):
            logger.warning("paper convergence: état non persisté")

    _note_all(users, format_note(message, now_iso, flags, used_llm))
    return {"fired": True, "reason": "ok", "factors": flags,
            "sent": sent, "llm": used_llm}


def recent(limit: int = 10) -> Dict[str, Any]:
    """CONTRAT PUBLIC pour le router : les derniers digests, le plus récent en
    tête (l'historique est déjà stocké dans cet ordre)."""
    try:
        limit = max(0, int(limit))
    except (TypeError, ValueError):
        limit = 10
    state = load_state()
    return {"history": list(state.get("history") or [])[:limit]}
