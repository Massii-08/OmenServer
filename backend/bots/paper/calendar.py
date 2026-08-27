"""Le calendrier du simulateur — les rendez-vous DATÉS, et ce qu'ils ont donné.

Le contexte du coach est fait, pour l'essentiel, de matière dont personne ne
sait dire QUAND elle produira son effet : une dépêche, une rumeur, un dépôt
13F. Ce module isole la fraction qui porte une date, et il la RECALCULE à
chaque lecture au lieu de la stocker : le calendrier est un **dérivé** des
trois mémoires qui existent déjà (l'agenda des banques centrales, les
hypothèses ouvertes du radar, les dépêches de veille). Doctrine du dépôt : un
tableau qui recopie ses sources finit par mentir le jour où elles bougent ; un
tableau qui les relit ne le peut pas.

Trois sources, trois natures de rendez-vous :

======================  ====================================================
``bc``                  réunion de banque centrale (``agenda_bridge``)
``hypothesis``          l'ÉCHÉANCE d'un pari ouvert du radar — la date de
                        notation EST un rendez-vous : c'est le jour où le pari
                        se juge (les idées du coach sont déjà DANS cet état,
                        écrites avec ``source: "coach"``)
``catalyst``            une dépêche de veille (``watch``) dont le TITRE annonce
                        une date future (résultats, assemblée, décision)
======================  ====================================================

La seule chose que ce module PERSISTE, c'est le **verdict du jour J** : « le
rendez-vous a-t-il tenu ce qu'il annonçait ? ». Un verdict est une OBSERVATION
faite à un instant précis — il ne se recalcule pas le lendemain (le cours a
bougé, la presse a tourné), donc lui, il s'écrit.

Découpage habituel : ``extract_date`` / ``event_verdict`` / ``normalize_*`` /
``assemble`` / ``entry_key`` / ``parse_key`` sont PURS (zéro I/O, zéro réseau,
horloge passée en paramètre) ; ``upcoming`` / ``run_verdicts`` /
``calendar_view`` / ``recent_verdicts`` font l'I/O et **toutes** leurs
dépendances sont injectables (horloge, agenda, hypothèses, dépêches, cours) ->
les tests tournent 100 % hors ligne.

Chaque source est best-effort et importée PARESSEUSEMENT : une source muette
rétrécit le calendrier, elle ne le fait jamais tomber.

⚠️ Ce fichier s'appelle ``calendar.py`` comme le module de la bibliothèque
standard. Aucun conflit : Python 3 importe en ABSOLU, donc un ``import
calendar`` ailleurs dans le backend continue de viser la stdlib, et ce module
ne s'atteint que par ``backend.bots.paper.calendar``. Corollaire à respecter
ici : ne jamais faire ``import calendar`` dans CE fichier (on s'importerait
soi-même sous un autre nom).
"""
import hashlib
import json
import logging
import os
import re
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Tuple

logger = logging.getLogger("omenserver")

# ⚠️ Le POINT dans le radical n'est PAS cosmétique — c'est la convention
# anti-fantôme du dépôt. Les fichiers de ``data/paper_trading/`` sont recensés
# comme des COMPTES par ``radar._users_with_portfolio`` (regex
# ``^[A-Za-z0-9_-]+\.json$``) et ``store._SAFE_USERNAME`` REJETTE tout nom qui
# contient un point : un ``calendar_verdicts.json`` deviendrait un utilisateur
# fantôme nommé « calendar_verdicts », à qui la convergence écrirait un carnet.
# Le dépôt a payé ce bug trois fois (``alerts_mode``, ``x_accounts``, puis
# ``backfill``) et l'a rattrapé à chaque fois par une liste d'exclusion qu'il
# fallait penser à tenir. Un radical qui porte un point ne peut PAS matcher :
# c'est structurel, ça ne s'oublie pas, et ça ne demande rien au module d'à côté.
STATE_NAME = "calendar.verdicts.json"

# Horizon du calendrier. 90 jours : c'est aussi le plafond de l'extracteur de
# dates (voir ``CATALYST_MAX_D``) — au-delà, un titre de presse qui annonce une
# date est plus souvent une coquille qu'un rendez-vous.
DEFAULT_HORIZON_D = 90

# Plafond de l'extracteur de dates. Un « September 17 » lu en février désigne
# presque toujours autre chose que le rendez-vous qu'on croit (rétrospective,
# rappel d'un fait passé, année implicite fausse) : au-delà d'un trimestre on
# préfère ne rien dire.
CATALYST_MAX_D = 90

# Profondeur de rétrovision. Un rendez-vous PASSÉ garde son intérêt tant qu'on
# peut lire ce qu'il a donné — c'est même toute l'utilité du verdict. Une
# semaine : au-delà, le verdict est de l'histoire, plus du contexte.
VIEW_BACK_D = 7

# Fenêtre de rattrapage du juge. La machine dort de 01:00 à 06:00 et peut
# rester éteinte : un rendez-vous d'il y a trois jours jamais jugé doit encore
# pouvoir l'être. (Il faut au minimum 2 pour que la re-lecture du « mitigé » à
# D+1 ait lieu.)
VERDICT_BACK_D = 7

# Seuil du mouvement SIGNIFICATIF, en pourcent. Même valeur que
# ``radar.MOVE_THRESHOLD_PCT``, et pourtant une constante SÉPARÉE : le radar
# mesure un déplacement sur tout un horizon (jours à semaines), on mesure ici
# la séance du jour J. Deux mesures différentes qui partagent aujourd'hui le
# même chiffre — les lier ferait bouger l'une le jour où l'autre est recalibrée.
MOVE_THRESHOLD_PCT = 3.0

# Fenêtre de lecture de la presse au jour J.
SENTIMENT_WINDOW_H = 24

# Tonalités de ``newswatch``. On tolère la forme longue : une source qui
# écrirait « negative » ne doit pas devenir muette en silence.
NEGATIVE_TONES = frozenset({"neg", "negative", "negatif", "négatif"})
POSITIVE_TONES = frozenset({"pos", "positive", "positif"})

# Le sentiment qui fait d'une dépêche un CATALYSEUR potentiel : « à surveiller ».
CATALYST_TONE = "watch"

VERDICT_FLOP = "flop"
VERDICT_CONFIRME = "confirme"
VERDICT_MITIGE = "mitige"

KIND_BC = "bc"
KIND_HYPOTHESIS = "hypothesis"
KIND_CATALYST = "catalyst"

# Plafond de longueur d'un libellé. Une thèse de radar peut faire trois lignes ;
# rangée telle quelle dans une liste, elle en devient illisible et gonfle le
# JSON servi à chaque rafraîchissement du tableau de bord.
MAX_LABEL_LEN = 200

# Plafond du calendrier. Cinq banques centrales, une file d'hypothèses et
# trois mois de dépêches ne devraient jamais approcher ce chiffre : c'est un
# garde-fou contre une source devenue folle, pas une politique d'affichage.
MAX_ENTRIES = 200

# Séparateur de la clé d'entrée. Le caractère est absent des trois composantes
# (un genre est un mot, une date est une date, un identifiant de source est un
# identifiant ou un lien) -> ``parse_key`` peut redécouper sans ambiguïté.
KEY_SEP = "|"


# --------------------------------------------------------------------------- #
# PUR — petits utilitaires de texte et de date
# --------------------------------------------------------------------------- #

def _text(value: Any) -> str:
    """Texte compacté (espaces normalisés). ``None`` -> chaîne vide."""
    return " ".join(str(value or "").split())


def _label(value: Any) -> str:
    """Libellé prêt à afficher, borné à ``MAX_LABEL_LEN`` (voir la constante)."""
    text = _text(value)
    if len(text) <= MAX_LABEL_LEN:
        return text
    return text[:MAX_LABEL_LEN - 1].rstrip() + "…"


def _naive(value: datetime) -> datetime:
    """Ramène un ``datetime`` en UTC naïf — comparer un aware et un naïf lève,
    et la moitié des sources date en ISO avec fuseau, l'autre sans."""
    if value.tzinfo is None:
        return value
    return value.astimezone(timezone.utc).replace(tzinfo=None)


def _parse_dt(value: Any) -> Optional[datetime]:
    """Date depuis un ``datetime``, une ``date``, un ISO, un epoch ou un simple
    ``AAAA-MM-JJ``. ``None`` si illisible — jamais d'exception.

    (Même contrat que ``radar._parse_dt``, réécrit plutôt qu'emprunté : ce
    module doit rester lisible sans le radar, qui peut être absent.)
    """
    if value is None or isinstance(value, bool):
        return None
    if isinstance(value, datetime):
        return _naive(value)
    if isinstance(value, date):
        return datetime(value.year, value.month, value.day)
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
        return None


def _now_dt(now: Any = None) -> datetime:
    """L'horloge, injectable partout. Valeur illisible -> maintenant (on ne
    fabrique jamais une date arbitraire à la place de l'appelant)."""
    parsed = _parse_dt(now)
    if parsed is not None:
        return parsed
    return _naive(datetime.now(timezone.utc))


def _today(now: Any = None) -> date:
    """Le JOUR courant selon l'horloge fournie."""
    return _now_dt(now).date()


# ⚠️ Un jour se VALIDE, il ne se mesure pas : tronquer à dix caractères ferait
# passer « pas-une-date » pour une date (piège déjà payé dans agenda_bridge),
# et tout le tri compare ensuite ces chaînes entre elles.
_DAY_RE = re.compile(r"^(\d{4}-\d{2}-\d{2})")


def _day_of(value: Any) -> str:
    """Le jour ``AAAA-MM-JJ`` d'une valeur, ou ``""`` si ce n'en est pas une."""
    found = _DAY_RE.match(_text(value))
    return found.group(1) if found else ""


def _iso_day(value: date) -> str:
    return "%04d-%02d-%02d" % (value.year, value.month, value.day)


def _short_hash(text: str) -> str:
    """Empreinte courte et STABLE d'une chaîne — sert d'identifiant de source
    quand la source n'en fournit pas (une réunion de banque centrale n'a pas
    d'identifiant, seulement une banque et une date)."""
    return hashlib.sha1(text.encode("utf-8", "replace")).hexdigest()[:12]


# --------------------------------------------------------------------------- #
# PUR — l'extracteur de dates
#
# LA pièce délicate du module. Sa règle cardinale : **on n'invente JAMAIS une
# date**. Mieux vaut un catalyseur absent du calendrier qu'un rendez-vous
# fantôme — un lecteur ne peut pas vérifier une date qu'on a devinée, et le
# dépôt s'interdit déjà de publier une date de banque centrale non sourcée
# (piège #68c). Tout ce qui est AMBIGU rend donc ``None``.
# --------------------------------------------------------------------------- #

_MONTHS = {
    "january": 1, "jan": 1,
    "february": 2, "feb": 2,
    "march": 3, "mar": 3,
    "april": 4, "apr": 4,
    "may": 5,
    "june": 6, "jun": 6,
    "july": 7, "jul": 7,
    "august": 8, "aug": 8,
    "september": 9, "sept": 9, "sep": 9,
    "october": 10, "oct": 10,
    "november": 11, "nov": 11,
    "december": 12, "dec": 12,
}

# Alternance triée du plus long au plus court : sans ça « sep » gagnerait sur
# « september » et le reste du mot (« tember ») resterait dans le texte, ce qui
# décalerait la lecture du jour.
_MONTH_ALT = "|".join(sorted(_MONTHS, key=len, reverse=True))

# « September 17 » · « Sept. 17 » · « Sep 17, 2026 » · « September 17th ».
# Le point après l'abréviation est optionnel, le suffixe ordinal aussi, et
# l'année ne se lit qu'en QUATRE chiffres (« September 20 26 » n'est pas une
# année, c'est deux nombres).
_MONTH_DAY_RE = re.compile(
    r"\b(" + _MONTH_ALT + r")\.?\s+(\d{1,2})(?:st|nd|rd|th)?"
    r"(?:\s*,?\s+(\d{4}))?\b",
    re.IGNORECASE,
)

# « 9/17 » · « 9/17/2026 » · « 9/17/26 ».
#
# ⚠️ Lecture MOIS/JOUR à l'américaine — c'est de la presse américaine (Reuters,
# CNBC, MarketWatch) qui charrie cette forme. Un « 9/17 » britannique voudrait
# dire le 9 septembre ; on assume le format US et on ne lit JAMAIS l'inverse,
# parce qu'un module qui devinerait la nationalité d'un titre inventerait des
# dates une fois sur deux.
#
# Les lookarounds (plutôt que ``\b``) empêchent d'attraper un fragment au
# milieu d'une suite de nombres séparés par des barres.
#
# ⚠️ Faux positif connu et ASSUMÉ : une fraction (« up 1/2 point ») a la forme
# d'une date. Elle est très rare dans un titre boursier, et quand elle survient
# elle produit soit une date hors fenêtre (donc ``None``), soit une entrée de
# calendrier isolée et vérifiable par son titre — jamais un verdict inventé.
_NUM_DATE_RE = re.compile(
    r"(?<![\d/])(\d{1,2})/(\d{1,2})(?:/(\d{2}|\d{4}))?(?![\d/])"
)


def _year_of(raw: Optional[str]) -> Optional[int]:
    """Année d'un groupe capturé. Deux chiffres -> 20xx (une dépêche ne parle
    pas du XXᵉ siècle). Absent -> ``None`` (année à déduire)."""
    if not raw:
        return None
    number = int(raw)
    return 2000 + number if number < 100 else number


def _candidates(text: str) -> List[Tuple[int, int, Optional[int]]]:
    """Toutes les dates candidates d'un titre, en ``(mois, jour, année|None)``.

    On les collecte TOUTES et on ne tranche qu'après : c'est le décompte qui
    décide de l'ambiguïté, pas la première trouvée.
    """
    found: List[Tuple[int, int, Optional[int]]] = []
    for match in _MONTH_DAY_RE.finditer(text):
        month = _MONTHS.get(match.group(1).lower())
        if month is None:                      # impossible via l'alternance,
            continue                           # ceinture et bretelles
        found.append((month, int(match.group(2)), _year_of(match.group(3))))
    for match in _NUM_DATE_RE.finditer(text):
        found.append((int(match.group(1)), int(match.group(2)),
                      _year_of(match.group(3))))
    return found


def _resolve_day(month: int, day: int, year: Optional[int],
                 today: date) -> Optional[date]:
    """Une candidate -> un vrai jour du calendrier, ou ``None`` si elle n'en
    désigne aucun (PUR).

    Sans année, on prend **la première année qui rend la date future** : un
    « March 5 » lu en août désigne mars prochain, pas mars dernier. Une année
    où la date n'existe pas est simplement sautée (le 29 février d'une année
    non bissextile), ce qui laisse « February 30 » sans aucune solution — donc
    ``None``, comme il se doit.
    """
    if year is not None:
        try:
            return date(year, month, day)
        except ValueError:
            return None
    for candidate_year in (today.year, today.year + 1):
        try:
            resolved = date(candidate_year, month, day)
        except ValueError:
            continue
        if resolved >= today:
            return resolved
    return None


def _within_window(day: date, today: date,
                   max_days: int = CATALYST_MAX_D) -> bool:
    """Le jour est-il un rendez-vous utilisable : ni passé, ni trop lointain ?

    AUJOURD'HUI compte : un rendez-vous daté « au jour » vaut jusqu'à la fin de
    sa journée — le faire disparaître à 00:00:01 le jour même où il compte
    serait absurde (même règle que ``agenda_bridge.events_within``).
    """
    if day < today:
        return False
    return (day - today).days <= max(0, int(max_days))


def extract_date(title: Any, now: Any = None) -> Optional[str]:
    """La date annoncée par un titre de presse, en ``AAAA-MM-JJ`` (PUR).

    ``None`` dès qu'il y a le moindre doute, et c'est le comportement
    RECHERCHÉ :

      * aucune date lisible (« 17 » nu, « 2026 » seul) ;
      * DEUX dates ou plus (on ne choisit pas à la place du lecteur) ;
      * une date impossible (« February 30 ») — même accompagnée d'une valide ;
      * une date PASSÉE (un rendez-vous passé n'est pas un rendez-vous) ;
      * une date au-delà de ``CATALYST_MAX_D``.

    Formats lus : « September 17 », « Sept. 17 », « Sep 17, 2026 »,
    « September 17th », « 9/17 », « 9/17/2026 » (mois/jour, cf. la note de
    ``_NUM_DATE_RE``).
    """
    text = _text(title)
    if not text:
        return None
    raw = _candidates(text)
    if not raw:
        return None

    today = _today(now)
    resolved = [_resolve_day(month, day, year, today)
                for (month, day, year) in raw]
    # Une candidate irrésolue est un signal d'ambiguïté, pas un simple déchet :
    # « February 30 and March 5 » ne désigne rien de sûr.
    if any(day is None for day in resolved):
        return None
    distinct = set(resolved)
    if len(distinct) != 1:
        return None

    day = distinct.pop()
    if day is None or not _within_window(day, today):
        return None
    return _iso_day(day)


# --------------------------------------------------------------------------- #
# PUR — le verdict du jour J
# --------------------------------------------------------------------------- #

def _tone_flags(sentiments: Any) -> Tuple[bool, bool]:
    """(presse positive présente, presse négative présente)."""
    has_pos = False
    has_neg = False
    for tone in sentiments or []:
        text = str(tone or "").strip().lower()
        if text in POSITIVE_TONES:
            has_pos = True
        elif text in NEGATIVE_TONES:
            has_neg = True
    return has_pos, has_neg


def _as_float(value: Any) -> Optional[float]:
    if value is None or isinstance(value, bool):
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def event_verdict(move_pct: Any, sentiments: Any,
                  expected_direction: Any = None) -> str:
    """Le rendez-vous a-t-il tenu ? -> ``flop`` / ``confirme`` / ``mitige``
    (PUR, zéro LLM).

    Deux régimes, et c'est l'ARBITRAGE central de la fonction :

    * **Un pari (``expected_direction`` fourni) se juge sur le PRIX, pas sur
      l'humeur de la presse.** Le sens attendu est celui qu'on a parié : un
      pari « down » qui baisse de 4 % est ``confirme``, jamais un ``flop`` —
      et il le reste même si les journaux sont enthousiastes ce jour-là. Un
      marché qui donne raison contre l'avis général, c'est précisément ce
      qu'on cherchait à mesurer ; laisser le ton de la presse renverser ce
      verdict reviendrait à noter le pari sur ce que d'autres en pensent.

    * **Un catalyseur (pas de direction) n'a pas de sens attendu**, donc on le
      juge contre le seul repère disponible : la tonalité des dépêches du jour.
      Presse négative confirmée par une baisse -> ``flop`` (l'événement a
      déçu) ; presse positive confirmée par une hausse -> ``confirme``.

    Tout le reste est ``mitige``, et c'est un aveu, pas un défaut :

      * mouvement plat (|move| < ``MOVE_THRESHOLD_PCT``) — il ne s'est rien
        passé de mesurable ;
      * cours introuvable (``move_pct is None``) — on ne juge pas sans mesure ;
      * presse et cours incohérents (mauvaise nouvelle, titre qui monte) ;
      * presse muette ou contradictoire (du positif ET du négatif) — une
        presse qui dit tout ne dit rien.
    """
    move = _as_float(move_pct)
    if move is None or abs(move) < MOVE_THRESHOLD_PCT:
        return VERDICT_MITIGE

    direction = str(expected_direction or "").strip().lower()
    if direction in ("up", "down"):
        went_up = move >= MOVE_THRESHOLD_PCT
        expected_up = direction == "up"
        return VERDICT_CONFIRME if went_up == expected_up else VERDICT_FLOP

    has_pos, has_neg = _tone_flags(sentiments)
    if has_pos and has_neg:
        return VERDICT_MITIGE
    if has_neg and move <= -MOVE_THRESHOLD_PCT:
        return VERDICT_FLOP
    if has_pos and move >= MOVE_THRESHOLD_PCT:
        return VERDICT_CONFIRME
    return VERDICT_MITIGE


# --------------------------------------------------------------------------- #
# PUR — clé d'entrée
#
# La clé PORTE le genre et la date (``kind|date|source_id``). Ce n'est pas de
# la coquetterie : un verdict survit à l'entrée qui l'a produit (une hypothèse
# notée sort de la file des ouvertes, une dépêche vieillit hors du cache), et
# sans cette information un verdict orphelin serait un identifiant opaque.
# ``parse_key`` le rend lisible sans avoir à retrouver sa source.
# --------------------------------------------------------------------------- #

def entry_key(entry: Optional[Dict[str, Any]]) -> str:
    """Clé STABLE et reproductible d'une entrée de calendrier (PUR)."""
    entry = entry or {}
    return KEY_SEP.join((
        _text(entry.get("kind")),
        _text(entry.get("date")),
        _text(entry.get("source_id")),
    ))


def parse_key(key: Any) -> Tuple[str, str, str]:
    """``"kind|date|source_id"`` -> le triplet (PUR). Clé déformée -> triplet
    de chaînes vides (jamais d'exception : une clé vient d'un fichier)."""
    parts = str(key or "").split(KEY_SEP, 2)
    while len(parts) < 3:
        parts.append("")
    return (parts[0], _day_of(parts[1]), parts[2])


# --------------------------------------------------------------------------- #
# PUR — normalisation des trois sources
# --------------------------------------------------------------------------- #

def _entry(kind: str, day: str, label: str, source_id: str,
           symbol: Optional[str] = None,
           tickers: Optional[List[str]] = None,
           direction: Optional[str] = None) -> Dict[str, Any]:
    """Fabrique une entrée à la forme COMPLÈTE et stable.

    Tous les champs sont TOUJOURS présents (``symbol``/``direction`` à
    ``None``, ``tickers`` à ``[]`` quand ils ne s'appliquent pas). Une forme à
    géométrie variable oblige chaque consommateur — router, toile, convergence
    — à se souvenir de quels champs existent pour quel genre ; c'est
    exactement la classe de bug que le dépôt paie régulièrement (un champ
    absent lu comme faux, et la branche ne se déclenche jamais).
    """
    entry = {
        "kind": kind,
        "date": day,
        "label": _label(label),
        "source_id": _text(source_id),
        "symbol": symbol or None,
        "tickers": list(tickers or []),
        "direction": direction or None,
    }
    entry["key"] = entry_key(entry)
    return entry


def normalize_bc(events: Any) -> List[Dict[str, Any]]:
    """Réunions de banque centrale -> entrées ``bc`` (PUR).

    ``agenda_bridge`` rend ``{date, bank, label, source_url}``. L'identifiant
    de source est une empreinte de ``banque|date`` : une réunion n'a pas
    d'identifiant propre, et le lien ne peut pas en tenir lieu (deux réunions
    d'une même banque partagent la même page).
    """
    out: List[Dict[str, Any]] = []
    for event in events or []:
        if not isinstance(event, dict):
            continue
        day = _day_of(event.get("date"))
        label = _text(event.get("label"))
        if not day or not label:
            continue                            # ni quand, ni quoi
        bank = _text(event.get("bank")) or "agenda"
        out.append(_entry(KIND_BC, day, "%s — %s" % (bank, label),
                          "bc:" + _short_hash("%s|%s" % (bank, day))))
    return out


def hypothesis_due_date(hyp: Any, horizon_days: Any = None) -> Optional[str]:
    """L'échéance d'une hypothèse : ``created_at`` + son horizon (PUR).

    ``horizon_days`` non fourni -> on DEMANDE au radar (``hypothesis_horizon``,
    qui connaît le plafond applicable : 30 jours pour lui, 120 pour une idée du
    coach). Le radar absent, on retombe sur son défaut. Réimplémenter le calcul
    d'horizon donnerait un calendrier qui annonce une date de notation
    différente de celle à laquelle le pari est réellement noté — le genre de
    mensonge tranquille qu'on ne voit qu'au bout de trois mois.
    """
    if not isinstance(hyp, dict):
        return None
    created = _parse_dt(hyp.get("created_at"))
    if created is None:
        return None
    days = _as_float(horizon_days)
    if days is None:
        days = _as_float(_radar_horizon(hyp))
    if days is None:
        return None
    try:
        return _iso_day((created + timedelta(days=int(days))).date())
    except (OverflowError, ValueError):
        return None


def normalize_hypotheses(hypotheses: Any,
                         horizon_days: Any = None) -> List[Dict[str, Any]]:
    """Hypothèses OUVERTES du radar -> entrées ``hypothesis`` (PUR).

    Le filtre ``status == "open"`` vit ICI et pas dans la collecte : un test —
    et demain un appelant qui aurait déjà l'état en main — doit pouvoir
    injecter une file complète et vérifier que les paris clos n'encombrent pas
    le calendrier.

    ``symbol`` est le PREMIER ticker : une hypothèse peut en porter jusqu'à
    trois, mais le verdict du jour J se mesure sur un cours, donc sur un seul.
    Les autres restent dans ``tickers`` pour qui veut les afficher.
    """
    out: List[Dict[str, Any]] = []
    for hyp in hypotheses or []:
        if not isinstance(hyp, dict):
            continue
        if str(hyp.get("status") or "").strip().lower() != "open":
            continue
        day = hypothesis_due_date(hyp, horizon_days)
        if not day:
            continue
        tickers = [str(t).strip().upper() for t in (hyp.get("tickers") or [])
                   if str(t or "").strip()]
        identifier = _text(hyp.get("id"))
        if not identifier:
            # Une hypothèse sans identifiant est anormale (le radar en pose un
            # à la création) mais ne doit pas disparaître du calendrier : son
            # échéance reste un rendez-vous. Empreinte de ce qui l'identifie.
            identifier = _short_hash("%s|%s" % (_text(hyp.get("thesis")), day))
        direction = str(hyp.get("direction") or "").strip().lower()
        out.append(_entry(
            KIND_HYPOTHESIS, day,
            _text(hyp.get("thesis")) or "hypothèse du radar",
            identifier,
            symbol=tickers[0] if tickers else None,
            tickers=tickers,
            direction=direction if direction in ("up", "down") else None,
        ))
    return out


def normalize_catalysts(events: Any, now: Any = None,
                        back_days: int = 0) -> List[Dict[str, Any]]:
    """Dépêches de veille -> entrées ``catalyst`` (PUR).

    Ne retient que le sentiment ``watch`` (« à surveiller ») dont le TITRE
    porte une date lisible. Tout le reste — une dépêche positive, une annonce
    politique, un titre sans date — n'est pas un rendez-vous : c'est du
    contexte, et le contexte a déjà sa place ailleurs.

    ⚠️ ``back_days`` recule le POINT DE REPÈRE de l'extraction, il n'assouplit
    pas l'extracteur. Trouvé en écrivant les tests : ``extract_date`` refuse
    une date passée (règle voulue, cf. sa docstring), donc un catalyseur
    DISPARAISSAIT du calendrier le lendemain de son rendez-vous — et avec lui
    la re-lecture du « mitigé » à D+1, qui est justement le cœur du juge, ainsi
    que l'affichage « ce rendez-vous a donné ceci ». Plutôt que d'ouvrir une
    porte dérobée dans l'extracteur (qui doit rester intraitable : c'est lui
    qui empêche d'inventer des dates), on lit le titre COMME SI on était
    ``back_days`` jours plus tôt, et c'est ``assemble`` qui fait ensuite le
    vrai fenêtrage. Effet de bord assumé : l'horizon avant s'étire d'autant
    (90 + ``back_days``), ce qu'``assemble`` rogne de toute façon.

    L'identifiant de source est le LIEN de la dépêche (unique par article) ; à
    défaut, une empreinte de ``symbole|titre``.
    """
    try:
        behind = max(0, int(back_days))
    except (TypeError, ValueError):
        behind = 0
    reference = _now_dt(now) - timedelta(days=behind)

    out: List[Dict[str, Any]] = []
    for event in events or []:
        if not isinstance(event, dict):
            continue
        if str(event.get("sentiment") or "").strip().lower() != CATALYST_TONE:
            continue
        title = _text(event.get("title"))
        day = extract_date(title, reference)
        if not day:
            continue
        symbol = _text(event.get("symbol")).upper() or None
        link = _text(event.get("link"))
        source_id = link or ("news:" + _short_hash("%s|%s" % (symbol or "", title)))
        out.append(_entry(KIND_CATALYST, day, title, source_id,
                          symbol=symbol,
                          tickers=[symbol] if symbol else []))
    return out


# --------------------------------------------------------------------------- #
# PUR — assemblage : dédup, fenêtrage, tri
# --------------------------------------------------------------------------- #

def _dedup_key(entry: Dict[str, Any]) -> Tuple[str, str, str]:
    """L'identité d'un RENDEZ-VOUS, pour n'en garder qu'un exemplaire.

    ⚠️ Arbitrage — la clé n'est pas la même pour les trois genres, et c'est
    volontaire :

    * ``catalyst`` -> ``(kind, date, symbole)``. C'est LÀ que la duplication
      existe vraiment : les résultats d'Apple le 17 arrivent par Reuters ET par
      CNBC, deux liens différents pour un seul rendez-vous. Le symbole est donc
      la vraie identité, pas la source.
    * ``bc`` et ``hypothesis`` -> ``(kind, date, source_id)``. Dédoublonner ces
      deux-là par symbole les DÉTRUIRAIT : une entrée ``bc`` n'a pas de symbole,
      donc deux banques centrales réunies le même jour (Fed et BoE, ça arrive)
      fusionneraient en une ; et deux paris distincts sur le même titre arrivant
      à échéance le même jour n'en feraient plus qu'un, ce qui effacerait une
      thèse du bilan. Leur ``source_id`` EST déjà l'identité du rendez-vous.
    """
    kind = str(entry.get("kind") or "")
    day = str(entry.get("date") or "")
    if kind == KIND_CATALYST and entry.get("symbol"):
        return (kind, day, str(entry.get("symbol")))
    return (kind, day, str(entry.get("source_id") or ""))


def _sort_key(entry: Dict[str, Any]) -> Tuple[str, str, str, str]:
    return (str(entry.get("date") or ""), str(entry.get("kind") or ""),
            str(entry.get("label") or ""), str(entry.get("source_id") or ""))


def assemble(entries: Any, now: Any = None,
             horizon_days: int = DEFAULT_HORIZON_D,
             back_days: int = 0,
             max_entries: int = MAX_ENTRIES) -> List[Dict[str, Any]]:
    """Fenêtre, dédoublonne et trie une liste d'entrées (PUR).

    Le TRI PRÉCÈDE la déduplication : le survivant d'un doublon est alors
    toujours le même, quel que soit l'ordre dans lequel les sources ont été
    lues. Deux passages sur les mêmes données rendent le même calendrier — ce
    qui est indispensable, puisque ``source_id`` sert de clé au verdict.

    ``back_days`` autorise le passé : à 0 le calendrier commence aujourd'hui,
    au-delà il remonte d'autant de jours (c'est ce que lisent le juge et la
    vue, qui ont besoin des rendez-vous échus pour en montrer le verdict).
    """
    today = _today(now)
    try:
        ahead = max(0, int(horizon_days))
    except (TypeError, ValueError):
        ahead = DEFAULT_HORIZON_D
    try:
        behind = max(0, int(back_days))
    except (TypeError, ValueError):
        behind = 0
    first = _iso_day(today - timedelta(days=behind))
    last = _iso_day(today + timedelta(days=ahead))

    windowed = []
    for entry in entries or []:
        if not isinstance(entry, dict):
            continue
        day = _day_of(entry.get("date"))
        if not day or day < first or day > last:
            continue
        windowed.append(entry)
    windowed.sort(key=_sort_key)

    out: List[Dict[str, Any]] = []
    seen = set()
    for entry in windowed:
        marker = _dedup_key(entry)
        if marker in seen:
            continue
        seen.add(marker)
        out.append(dict(entry))
        if len(out) >= max(1, int(max_entries or MAX_ENTRIES)):
            break
    return out


# --------------------------------------------------------------------------- #
# PUR — lecture de la presse au jour J
# --------------------------------------------------------------------------- #

def sentiments_for(symbol: Any, events: Any, now: Any = None,
                   window_h: int = SENTIMENT_WINDOW_H) -> List[str]:
    """Les tonalités des dépêches d'un symbole sur les dernières heures (PUR),
    de la plus récente à la plus ancienne."""
    wanted = _text(symbol).upper()
    if not wanted:
        return []
    now_dt = _now_dt(now)
    floor = now_dt - timedelta(hours=max(0, int(window_h or 0)))
    rows = []
    for event in events or []:
        if not isinstance(event, dict):
            continue
        if _text(event.get("symbol")).upper() != wanted:
            continue
        stamp = _parse_dt(event.get("ts"))
        if stamp is None or stamp < floor or stamp > now_dt:
            continue
        rows.append((stamp, _text(event.get("sentiment")).lower()))
    rows.sort(key=lambda row: row[0], reverse=True)
    return [tone for (_stamp, tone) in rows if tone]


def headline_for(symbol: Any, events: Any, now: Any = None,
                 window_h: int = SENTIMENT_WINDOW_H) -> str:
    """Le titre le plus RÉCENT du symbole sur la fenêtre (PUR), ou ``""``.

    Il ne sert qu'à rendre le verdict lisible : « flop » sans la dépêche qui
    l'accompagne oblige le lecteur à repartir en chasse.
    """
    wanted = _text(symbol).upper()
    if not wanted:
        return ""
    now_dt = _now_dt(now)
    floor = now_dt - timedelta(hours=max(0, int(window_h or 0)))
    best_stamp = None
    best_title = ""
    for event in events or []:
        if not isinstance(event, dict):
            continue
        if _text(event.get("symbol")).upper() != wanted:
            continue
        stamp = _parse_dt(event.get("ts"))
        if stamp is None or stamp < floor or stamp > now_dt:
            continue
        if best_stamp is None or stamp > best_stamp:
            best_stamp = stamp
            best_title = _label(event.get("title"))
    return best_title


# --------------------------------------------------------------------------- #
# PUR — la règle de re-lecture
# --------------------------------------------------------------------------- #

def should_judge(row: Any, today: Any) -> bool:
    """Faut-il (re)juger cette entrée ? (PUR)

    Un rendez-vous se juge **UNE fois** — sinon le verdict serait celui du
    dernier passage du planificateur, pas celui du jour J.

    UNE exception : un ``mitige``. Le marché digère parfois un jour de plus (la
    séance du jour J se termine à plat, le vrai mouvement tombe le lendemain à
    l'ouverture). On lui redonne donc **une** chance, et une seule, le jour
    SUIVANT — d'où les deux conditions : verdict mitigé, pas encore relu, et
    journée différente de celle du premier jugement. Après quoi c'est définitif :
    laisser un mitigé se rejuger indéfiniment reviendrait à choisir sa fenêtre
    de mesure après coup, exactement le mensonge que le scoring existe pour
    empêcher (doctrine ``radar``).
    """
    if not isinstance(row, dict):
        return True                              # jamais jugé
    if str(row.get("verdict") or "") != VERDICT_MITIGE:
        return False
    if row.get("rechecked"):
        return False
    checked_day = _day_of(row.get("checked_at"))
    day = _day_of(today) or _iso_day(_today(today))
    return bool(checked_day) and checked_day < day


# --------------------------------------------------------------------------- #
# I/O — état persistant, data/paper_trading/calendar.verdicts.json
#
# Écriture ATOMIQUE 0o600 (patron obligatoire du dépôt) : le temporaire NAÎT en
# 0o600 via ``os.open`` — jamais ``open()`` suivi d'un ``chmod()``, qui laisse
# une fenêtre world-readable et reste en 0o644 si le chmod échoue — puis
# ``os.replace`` bascule d'un coup.
# --------------------------------------------------------------------------- #

def _store():
    """Le module de persistance du paper trading (import paresseux)."""
    from backend.bots.paper import store
    return store


def state_path() -> Path:
    """Chemin du fichier de verdicts, relu à CHAQUE appel depuis
    ``store.DATA_DIR`` — un test qui isole ce répertoire isole aussi ce
    module, sans avoir à connaître son existence."""
    return Path(_store().DATA_DIR) / STATE_NAME


def load_verdicts() -> Dict[str, Dict[str, Any]]:
    """Les verdicts déjà rendus, ``{clé: {checked_at, verdict, move_pct,
    headline}}``. Fichier absent, illisible ou déformé -> dictionnaire vide."""
    try:
        path = state_path()
        if not path.is_file():
            return {}
        with open(str(path), "r", encoding="utf-8") as handle:
            raw = json.load(handle)
    except (OSError, ValueError, ImportError):
        return {}
    if not isinstance(raw, dict):
        return {}
    return {str(key): dict(value) for key, value in raw.items()
            if isinstance(value, dict)}


def save_verdicts(verdicts: Dict[str, Dict[str, Any]]) -> None:
    """Persiste les verdicts de façon atomique, 0o600."""
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
            json.dump(verdicts or {}, handle, ensure_ascii=False, indent=2)
        os.replace(str(tmp_path), str(path))
    except Exception:
        try:
            os.remove(str(tmp_path))
        except OSError:
            pass
        raise


def verdict_for(key: Any,
                verdicts: Optional[Dict[str, Dict[str, Any]]] = None
                ) -> Optional[Dict[str, Any]]:
    """Le verdict d'une entrée, ou ``None``. ``verdicts`` injectable pour
    éviter de relire le fichier dans une boucle."""
    table = verdicts if verdicts is not None else load_verdicts()
    row = table.get(str(key or ""))
    return dict(row) if isinstance(row, dict) else None


# --------------------------------------------------------------------------- #
# I/O — collecte des trois sources, toutes best-effort
# --------------------------------------------------------------------------- #

def _radar_module():
    """Le radar, ou ``None`` (déploiement partiel / import cassé)."""
    try:
        from backend.bots.paper import radar
        return radar
    except Exception:                             # noqa: BLE001 — best-effort
        return None


def _radar_horizon(hyp: Dict[str, Any]) -> Optional[int]:
    """L'horizon EFFECTIF d'une hypothèse selon le radar, ou son défaut."""
    radar = _radar_module()
    if radar is None:
        return None
    try:
        return int(radar.hypothesis_horizon(hyp))
    except Exception:                             # noqa: BLE001
        try:
            return int(radar.DEFAULT_HORIZON_D)
        except Exception:                         # noqa: BLE001
            return None


def _fetch_bc(now_dt: datetime, horizon_days: int) -> List[Dict[str, Any]]:
    """Les réunions de banque centrale. Source en panne -> ``[]``."""
    try:
        from backend.bots.paper import agenda_bridge
        rows = agenda_bridge.upcoming_events(now=now_dt,
                                             horizon_days=horizon_days)
    except Exception as exc:                      # noqa: BLE001
        logger.warning("paper calendar: agenda indisponible (%s)",
                       type(exc).__name__)
        return []
    return [row for row in (rows or []) if isinstance(row, dict)]


def _fetch_hypotheses() -> List[Dict[str, Any]]:
    """Les hypothèses du radar (TOUTES — le filtre ``open`` vit dans la
    normalisation). Radar en panne -> ``[]``."""
    radar = _radar_module()
    if radar is None:
        return []
    try:
        state = radar.load_state()
    except Exception as exc:                      # noqa: BLE001
        logger.warning("paper calendar: radar illisible (%s)", type(exc).__name__)
        return []
    rows = (state or {}).get("hypotheses") if isinstance(state, dict) else None
    return [row for row in (rows or []) if isinstance(row, dict)]


def _fetch_events() -> List[Dict[str, Any]]:
    """Les dépêches récentes de tous les comptes, dédupliquées par lien.

    ``newswatch.recent_events`` fusionne les événements politiques GLOBAUX dans
    le retour de CHAQUE utilisateur : sans déduplication, une même dépêche
    compterait autant de fois qu'il y a de comptes (même piège que
    ``convergence._collect_news``).
    """
    try:
        from backend.bots.paper import newswatch
    except Exception:                             # noqa: BLE001
        return []
    radar = _radar_module()
    try:
        users = list(radar._users_with_portfolio() or []) if radar else []
    except Exception:                             # noqa: BLE001
        users = []

    out: List[Dict[str, Any]] = []
    seen = set()
    for username in users:
        try:
            rows = newswatch.recent_events(username)
        except Exception:                         # noqa: BLE001 — compte tordu
            continue
        for event in rows or []:
            if not isinstance(event, dict):
                continue
            marker = _text(event.get("link")) or _text(event.get("title"))
            if marker in seen:
                continue
            seen.add(marker)
            out.append(event)
    return out


# --------------------------------------------------------------------------- #
# API PUBLIQUE
# --------------------------------------------------------------------------- #

def upcoming(now: Any = None,
             bc_events: Any = None,
             hypotheses: Any = None,
             events: Any = None,
             horizon_days: int = DEFAULT_HORIZON_D,
             back_days: int = 0,
             max_entries: int = MAX_ENTRIES) -> List[Dict[str, Any]]:
    """Le calendrier : les rendez-vous datés, du plus proche au plus lointain.

    Chaque entrée a la forme COMPLÈTE et stable ::

        {"key": "kind|date|source_id",
         "kind": "bc" | "hypothesis" | "catalyst",
         "date": "AAAA-MM-JJ",
         "label": str,
         "source_id": str,          # identifiant stable de la pièce d'origine
         "symbol": str | None,
         "tickers": [str, ...],     # [] quand ça ne s'applique pas
         "direction": "up" | "down" | None}

    Injection : ``None`` = « va chercher la source toi-même, best-effort » ;
    une valeur fournie = « sers-toi de ça » (le mode des tests, et celui d'un
    appelant qui aurait déjà les données en main). Une source en panne est
    ABSENTE du résultat, jamais une exception.

    ``back_days`` remonte dans le passé (0 = à partir d'aujourd'hui).
    """
    now_dt = _now_dt(now)
    try:
        ahead = max(0, int(horizon_days))
    except (TypeError, ValueError):
        ahead = DEFAULT_HORIZON_D

    rows_bc = bc_events if bc_events is not None else _fetch_bc(now_dt, ahead)
    rows_hyp = hypotheses if hypotheses is not None else _fetch_hypotheses()
    rows_news = events if events is not None else _fetch_events()

    entries: List[Dict[str, Any]] = []
    for producer in (lambda: normalize_bc(rows_bc),
                     lambda: normalize_hypotheses(rows_hyp),
                     lambda: normalize_catalysts(rows_news, now_dt, back_days)):
        try:
            entries.extend(producer())
        except Exception as exc:                  # noqa: BLE001 — best-effort
            logger.warning("paper calendar: source illisible (%s)",
                           type(exc).__name__)

    return assemble(entries, now_dt, horizon_days=ahead,
                    back_days=back_days, max_entries=max_entries)


def _default_quote(symbol: str) -> Optional[float]:
    """Variation du jour d'un titre, en % — ``None`` si le cours est
    introuvable (le verdict devient alors ``mitige``, pas une invention)."""
    try:
        from backend.bots.paper import quotes
        return _as_float(quotes.get_quote(symbol).get("change_pct"))
    except Exception:                             # noqa: BLE001
        return None


def run_verdicts(now: Any = None,
                 entries: Any = None,
                 quote: Optional[Callable[[str], Any]] = None,
                 events: Any = None,
                 back_days: int = VERDICT_BACK_D,
                 verdicts: Optional[Dict[str, Dict[str, Any]]] = None,
                 save: bool = True) -> Dict[str, Any]:
    """Le passage de jugement : note les rendez-vous ÉCHUS (jour J ou avant).

    Retourne ``{"checked": int, "judged": [ligne, ...]}`` où chaque ligne est
    ``{key, kind, date, symbol, verdict, move_pct, headline, checked_at}`` —
    de quoi alerter ou journaliser sans relire le fichier.

    Ne lève JAMAIS : un juge qui plante emporterait le planificateur avec lui.
    ``save=False`` calcule sans écrire (utile à un appelant qui veut prévisualiser).
    """
    try:
        now_dt = _now_dt(now)
        today = _iso_day(now_dt.date())
        rows = entries if entries is not None else upcoming(
            now_dt, back_days=max(1, int(back_days or VERDICT_BACK_D)))
        news = events if events is not None else _fetch_events()
        table = dict(verdicts) if verdicts is not None else load_verdicts()
        get_move = quote if quote is not None else _default_quote

        judged: List[Dict[str, Any]] = []
        checked = 0
        for entry in rows or []:
            if not isinstance(entry, dict):
                continue
            day = _day_of(entry.get("date"))
            if not day or day > today:
                continue                          # le rendez-vous n'a pas eu lieu
            symbol = entry.get("symbol") or (entry.get("tickers") or [None])[0]
            if not symbol:
                continue                          # rien à mesurer (réunion de BC)
            key = _text(entry.get("key")) or entry_key(entry)
            previous = table.get(key)
            if not should_judge(previous, today):
                continue

            checked += 1
            try:
                move = _as_float(get_move(str(symbol)))
            except Exception:                     # noqa: BLE001 — cours en panne
                move = None
            tones = sentiments_for(symbol, news, now_dt)
            verdict = event_verdict(move, tones, entry.get("direction"))
            row = {
                "checked_at": now_dt.isoformat(),
                "verdict": verdict,
                "move_pct": move,
                "headline": headline_for(symbol, news, now_dt),
                # ---- identité FIGÉE AU TIR ------------------------------- #
                # Le calendrier, lui, est un dérivé qu'on recalcule ; un
                # verdict, non : c'est une observation, et une observation qui
                # ne dit plus de QUOI elle parle ne vaut rien. L'instant du
                # jugement est le SEUL où ces champs existent encore — une
                # hypothèse notée sort de la file des ouvertes, une dépêche
                # vieillit hors du cache. Les relire plus tard rendrait
                # ``symbol``/``tickers`` à ``None``, et un consommateur qui
                # s'en sert pour savoir si le titre est DÉTENU aurait une
                # branche éternellement fausse, sans la moindre erreur (la
                # classe de bug du piège #61). D'où la copie ici, et d'où
                # ``recent_verdicts`` qui n'a plus rien à aller chercher.
                "kind": _text(entry.get("kind")),
                "label": _text(entry.get("label")),
                "symbol": str(symbol),
                "tickers": [str(t) for t in (entry.get("tickers") or [])],
                "direction": entry.get("direction") or None,
            }
            # Le drapeau ne se pose qu'à la SECONDE lecture : c'est lui qui fige
            # définitivement un mitigé (cf. ``should_judge``).
            if isinstance(previous, dict) and previous.get("verdict") == VERDICT_MITIGE:
                row["rechecked"] = True
            table[key] = row

            line = dict(row)
            line.update({"key": key, "kind": entry.get("kind"),
                         "date": day, "symbol": symbol})
            judged.append(line)

        if judged and save:
            try:
                save_verdicts(table)
            except Exception as exc:              # noqa: BLE001
                logger.warning("paper calendar: verdicts non persistés (%s)",
                               type(exc).__name__)
        return {"checked": checked, "judged": judged}
    except Exception as exc:                      # noqa: BLE001 — ne lève jamais
        logger.warning("paper calendar: passage de jugement impossible (%s)",
                       type(exc).__name__)
        return {"checked": 0, "judged": []}


def calendar_view(now: Any = None,
                  bc_events: Any = None,
                  hypotheses: Any = None,
                  events: Any = None,
                  horizon_days: int = DEFAULT_HORIZON_D,
                  back_days: int = VIEW_BACK_D,
                  verdicts: Optional[Dict[str, Dict[str, Any]]] = None,
                  max_entries: int = MAX_ENTRIES) -> List[Dict[str, Any]]:
    """CONTRAT PUBLIC (le router) : le calendrier AVEC son verdict fusionné.

    Retourne les entrées d'``upcoming`` — même forme, mêmes clés — enrichies
    de quatre champs TOUJOURS présents ::

        {..., "verdict": "flop"|"confirme"|"mitige"|None,
              "move_pct": float | None,
              "headline": str,
              "checked_at": str | None}

    ``None``/``""`` = pas encore jugé (rendez-vous à venir, ou échu mais jamais
    passé au juge). La fenêtre remonte de ``back_days`` jours : un rendez-vous
    récent SANS son verdict n'aurait aucun intérêt, c'est le verdict qu'on vient
    lire.
    """
    rows = upcoming(now=now, bc_events=bc_events, hypotheses=hypotheses,
                    events=events, horizon_days=horizon_days,
                    back_days=back_days, max_entries=max_entries)
    table = verdicts if verdicts is not None else load_verdicts()
    out: List[Dict[str, Any]] = []
    for entry in rows:
        merged = dict(entry)
        row = table.get(str(entry.get("key") or "")) or {}
        merged["verdict"] = row.get("verdict") or None
        merged["move_pct"] = _as_float(row.get("move_pct"))
        merged["headline"] = _text(row.get("headline"))
        merged["checked_at"] = row.get("checked_at") or None
        out.append(merged)
    return out


def recent_verdicts(now: Any = None, days: int = VIEW_BACK_D,
                    verdicts: Optional[Dict[str, Dict[str, Any]]] = None,
                    entries: Any = None) -> List[Dict[str, Any]]:
    """CONTRAT PUBLIC (la convergence) : les rendez-vous jugés RÉCEMMENT.

    Retourne, du plus récemment jugé au plus ancien ::

        [{"key", "kind", "date", "label", "symbol", "tickers", "direction",
          "verdict", "move_pct", "headline", "checked_at"}, ...]

    ⚠️ **LECTURE PURE : cette fonction ne collecte RIEN.** Elle lit le fichier
    de verdicts, point. C'est un contrat, pas une optimisation : la convergence
    l'appelle à chaque cycle, et un repli qui reconstruisait le calendrier
    faisait ré-interroger le guetteur de presse une seconde fois par cycle —
    un test voisin l'a attrapé en épinglant la liste des comptes sondés
    (``["alice", "bob", "alice", "bob"]``). Si ce repli revient, la
    déduplication des dépêches entre comptes retombe avec lui.

    C'est possible parce que ``run_verdicts`` FIGE l'identité du rendez-vous
    dans la ligne au moment du jugement (voir son commentaire) : un verdict se
    suffit à lui-même, même quand son entrée a depuis disparu des sources.
    ``kind`` et ``date`` gardent en plus la CLÉ comme filet (``kind|date|
    source_id``), ce qui rend lisible une ligne écrite avant ce changement.

    ``entries`` reste injectable, mais seulement comme SURCOUCHE pour un
    appelant qui a déjà le calendrier frais sous la main ; ``None`` ne
    déclenche aucune collecte.
    """
    now_dt = _now_dt(now)
    try:
        span = max(0, int(days))
    except (TypeError, ValueError):
        span = VIEW_BACK_D
    floor = now_dt - timedelta(days=span)
    table = verdicts if verdicts is not None else load_verdicts()

    by_key: Dict[str, Dict[str, Any]] = {}
    for entry in entries or []:
        if isinstance(entry, dict) and entry.get("key"):
            by_key[str(entry["key"])] = entry

    out: List[Dict[str, Any]] = []
    for key, row in (table or {}).items():
        if not isinstance(row, dict) or not row.get("verdict"):
            continue
        stamp = _parse_dt(row.get("checked_at"))
        if stamp is None or stamp < floor:
            continue
        kind, day, _source_id = parse_key(key)
        entry = by_key.get(str(key)) or {}
        tickers = entry.get("tickers") or row.get("tickers") or []
        out.append({
            "key": str(key),
            "kind": entry.get("kind") or row.get("kind") or kind,
            "date": entry.get("date") or day,
            "label": _text(entry.get("label") or row.get("label")),
            "symbol": entry.get("symbol") or row.get("symbol") or None,
            "tickers": [str(t) for t in tickers],
            "direction": entry.get("direction") or row.get("direction") or None,
            "verdict": row.get("verdict"),
            "move_pct": _as_float(row.get("move_pct")),
            "headline": _text(row.get("headline")),
            "checked_at": row.get("checked_at"),
        })
    out.sort(key=lambda r: str(r.get("checked_at") or ""), reverse=True)
    return out
