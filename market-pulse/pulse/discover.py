"""Découverte de titres — « une liste de nouveaux titres déjà analysés ».

Demande de Massii, et son mot « entrer » veut dire **entrer dans la liste de
suivi**, pas entrer en position. On repère les sociétés citées dans l'actualité
du jour, on écarte celles qu'il suit déjà, et on lui présente les autres avec
leur fiche remplie. C'est lui qui choisit.

⚠️ **Aucun jugement n'accompagne la liste.** « Cette société est apparue dans
l'actualité, voici ses chiffres » est un fait. « Cette société est intéressante »
serait un conseil. Il n'y a donc ni note, ni score, ni classement par qualité —
seulement par nombre de mentions, ce qui mesure l'attention de la presse, pas
la valeur du titre. Un test verrouille l'absence de tout autre champ.

Le rattachement à une place se fait par le **code d'échange** rendu par la
recherche Yahoo (NYQ, NMS, MIL, AMS, GER…) : un titre coté hors des places
suivies est écarté, sinon la liste proposerait Varsovie à quelqu'un qui suit
Milan.
"""
import re
from typing import Any, Callable, Dict, List, Optional, Tuple

# Codes d'échange Yahoo → identifiant d'opérateur du catalogue.
# ⚠️ Euronext regroupe plusieurs codes : Amsterdam, Paris, Bruxelles, Lisbonne,
# Dublin, Milan et Oslo pointent tous vers la MÊME entrée.
EXCHANGE_MAP = {
    "NYQ": "nyse", "NYS": "nyse", "PCX": "nyse", "ASE": "nyse",
    "NMS": "nasdaq", "NGM": "nasdaq", "NCM": "nasdaq", "NAS": "nasdaq",
    "MIL": "euronext", "AMS": "euronext", "PAR": "euronext", "BRU": "euronext",
    "LIS": "euronext", "DUB": "euronext", "OSL": "euronext", "ISE": "euronext",
    "GER": "deutsche_boerse", "FRA": "deutsche_boerse", "XETRA": "deutsche_boerse",
    "LSE": "lse", "LON": "lse",
    "JPX": "jpx", "TYO": "jpx", "JNX": "jpx",
    "HKG": "hkex",
    "SHH": "sse", "SHZ": "szse",
    "NSI": "nse", "BSE": "nse",
}

# Un ticker explicite : entre parenthèses ou préfixé d'un dollar. Trois lettres
# minimum — deux, c'est trop ambigu (« AP », « EU »).
_TICKER_PAREN = re.compile(r"\(([A-Z]{3,6}(?:\.[A-Z]{1,3})?)\)")
_TICKER_CASH = re.compile(r"\$([A-Z]{2,6}(?:\.[A-Z]{1,3})?)\b")

# Sigles d'agences et mots courants qui traînent entre parenthèses.
_NOT_TICKERS = {"REUTERS", "AP", "AFP", "ANSA", "PDF", "USA", "GDP", "CEO",
                "CFO", "ETF", "IPO", "OPA", "EPS", "GMT", "CET", "SEE",
                "CHART", "UPDATE", "LIVE", "EXCLUSIVE"}

# Mots capitalisés qui ne désignent jamais une société cotable : institutions,
# lieux, débuts de phrase courants. Sans ce filtre la liste serait ridicule
# (mesuré : « Federal », « Global », « Here », « Love »).
_STOPWORDS = {
    "the", "a", "an", "and", "or", "but", "for", "with", "from", "after",
    "before", "here", "there", "this", "that", "these", "those", "what",
    "why", "how", "when", "who", "global", "world", "markets", "market",
    "stocks", "stock", "shares", "wall", "street", "street's", "asia",
    "asian", "europe", "european", "america", "american", "us", "uk", "eu",
    "china", "chinese", "japan", "japanese", "korea", "korean", "india",
    "german", "germany", "france", "french", "italy", "italian", "trump",
    "fed", "federal", "reserve", "ecb", "bce", "boj", "imf", "opec", "nato",
    "treasury", "senate", "congress", "house", "white", "president",
    "minister", "government", "court", "reuters", "bloomberg", "cnbc",
    "investors", "investor", "analysts", "analyst", "earnings", "results",
    "borsa", "borse", "piazza", "affari", "milano", "wednesday", "thursday",
    "friday", "monday", "tuesday", "saturday", "sunday", "january",
    "february", "march", "april", "may", "june", "july", "august",
    "september", "october", "november", "december", "love", "island",
    "five", "one", "two", "three", "four", "new", "york", "air", "force",
    "bond", "oil", "gold", "dollar", "euro", "yen", "update", "live",
    "exclusive", "breaking", "opinion", "review", "big", "top", "best",
    # Mots-outils anglais qui manquaient encore. Mesuré en réel : « Should we
    # set up a trust » produisait le candidat « Should », resolu en
    # « Shoulder Innovations Inc. ». Un mot commun capitalisé au milieu d'une
    # phrase est aussi dangereux qu'en tête.
    "should", "would", "could", "will", "shall", "must", "have", "has",
    "our", "your", "their", "his", "her", "its", "we", "you", "they",
    "she", "him", "them", "were", "was", "been", "being", "does", "did",
    "more", "most", "less", "than", "then", "into", "over", "under",
    "about", "just", "only", "also", "even", "still", "back", "down",
    # ⚠️ Mots-outils NON ANGLAIS. Ma première liste était anglocentrée, et
    # ça se voyait immédiatement en réel : « Per quota 49,9%... » (italien
    # pour « pour ») se résolvait en Performance Shipping, « Tap offerte da
    # Lufthansa » en Tapestry. Un titre italien ou allemand commence lui
    # aussi par une majuscule.
    "per", "dopo", "prima", "senza", "sotto", "sopra", "tra", "verso",
    "secondo", "nuovo", "nuova", "tutti", "ancora", "oggi", "ieri", "domani",
    "chiusura", "apertura", "seduta", "titolo", "titoli", "azioni", "quota",
    "utile", "ricavi", "conti", "governo", "banca", "mercati",
    "nach", "vor", "ohne", "unter", "ueber", "mit", "auch", "noch", "heute",
    "aktie", "aktien", "boerse", "kurs", "gewinn", "umsatz",
    "pour", "apres", "avant", "sans", "sous", "vers", "selon", "aujourd",
    "bourse", "action", "actions", "seance", "hausse", "baisse",
}

# Longueur minimale d'un nom NU (sans ticker explicite). « Tap » a trois
# lettres et se résout en Tapestry : trop court pour être discriminant.
_MIN_NAME_LEN = 4

# Un nom de société commence par une majuscule ; on garde aussi les formes
# « SK Hynix » (deux mots capitalisés consécutifs).
_WORD = re.compile(r"\b([A-Z][A-Za-z][A-Za-z'&\.\-]*(?:\s[A-Z][A-Za-z'&\.\-]+)?)")


def extract_tickers(title: Any) -> List[str]:
    """Tickers écrits explicitement : « Nike (NKE) », « $AAPL »."""
    if not isinstance(title, str):
        return []
    found = []
    for rx in (_TICKER_PAREN, _TICKER_CASH):
        for sym in rx.findall(title):
            base = sym.split(".")[0]
            if base in _NOT_TICKERS or len(base) < 3:
                continue
            if sym not in found:
                found.append(sym)
    return found


def candidate_names(title: Any) -> List[str]:
    """Noms de sociétés plausibles dans un titre.

    Volontairement prudent : on préfère manquer une société que polluer la
    liste. La résolution qui suit écarte de toute façon ce qui n'est pas coté.
    """
    if not isinstance(title, str) or not title.strip():
        return []
    out = []
    for match in _WORD.finditer(title):
        raw = match.group(1).strip(" .,'&-")
        if not raw:
            continue
        head = raw.split()[0]
        # Le possessif est retiré AVANT le test de mot commun : « Here's »
        # n'est pas dans la liste des mots communs, il y passait donc, puis
        # devenait « Here » -> résolu en « Here Group Limited ». Vu en vrai.
        if head.endswith("'s") or head.endswith("’s"):
            head = head[:-2]
        # Un mot commun reste un mot commun, même en tête de phrase.
        if head.lower() in _STOPWORDS:
            continue
        if len(head) < _MIN_NAME_LEN:
            continue
        # « Starbucks stock jumps » : on ne garde que la partie société, donc on
        # coupe dès qu'un mot commun suit.
        parts = []
        for word in raw.split():
            if word.lower() in _STOPWORDS and parts:
                break
            # Un POSSESSIF marque la fin du nom : ce qui suit appartient à
            # l'entité, il n'en fait pas partie. « Meta's Reality Labs » désigne
            # la société Meta, pas une société « Meta's Reality ».
            if word.endswith("'s") or word.endswith("’s"):
                parts.append(word[:-2])
                break
            parts.append(word)
        name = " ".join(parts).strip(" .,'&-")
        if name and name not in out:
            out.append(name)
    return out


def discover(items: Optional[List[Dict[str, Any]]],
             followed: Tuple[str, ...] = (),
             resolve: Optional[Callable[..., Optional[Dict[str, str]]]] = None,
             venues: Optional[Tuple[str, ...]] = None,
             max_candidates: int = 8) -> List[Dict[str, Any]]:
    """Sociétés apparues dans l'actualité et pas encore suivies.

    `resolve(nom)` doit rendre `{"symbol", "name", "exchange"}` ou None — il est
    injecté pour que les tests n'aient aucun réseau, et parce que chaque
    résolution coûte une requête.
    """
    if not items or resolve is None:
        return []
    followed_up = {f.upper() for f in (followed or ())}

    # nom -> titres qui le citent, dans l'ordre d'apparition
    seen_names = []            # type: List[str]
    per_name = {}              # type: Dict[str, List[str]]
    lang_of = {}               # type: Dict[str, str]
    for item in items:
        if not isinstance(item, dict):
            continue
        title = item.get("title")
        if not isinstance(title, str) or not title.strip():
            continue
        for name in candidate_names(title):
            if name not in per_name:
                per_name[name] = []
                seen_names.append(name)
                # La LANGUE du titre est l'indice décisif contre le mauvais
                # homonyme : « Trevi » dans une dépêche italienne est Trevi
                # Finanziaria à Milan, pas Trevi Therapeutics au Nasdaq.
                lang_of[name] = item.get("lang") or ""
            per_name[name].append(title)

    resolved_cache = {}        # une résolution par nom distinct, jamais deux
    out = {}                   # symbole -> candidat
    for name in seen_names:
        if name not in resolved_cache:
            try:
                resolved_cache[name] = resolve(name, lang_of.get(name) or "")
            except Exception:
                resolved_cache[name] = None
        info = resolved_cache[name]
        if not info or not info.get("symbol"):
            continue
        symbol = info["symbol"]
        if symbol.upper() in followed_up:
            continue
        venue = EXCHANGE_MAP.get((info.get("exchange") or "").upper())
        if not venue or (venues and venue not in venues):
            continue
        headlines = per_name[name]
        if symbol in out:
            out[symbol]["headlines"].extend(headlines)
            out[symbol]["mentions"] = len(out[symbol]["headlines"])
            continue
        out[symbol] = {
            "symbol": symbol,
            "name": info.get("name") or name,
            "exchange_id": venue,
            "mentions": len(headlines),
            "headline": headlines[0],
            "headlines": list(headlines),
        }

    # Classé par ATTENTION de la presse, pas par qualité du titre — la nuance
    # est ce qui sépare un fait d'un conseil.
    ranked = sorted(out.values(), key=lambda c: -c["mentions"])
    return ranked[:max_candidates]
