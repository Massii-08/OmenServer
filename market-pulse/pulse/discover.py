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

# ⚠️ Homonymie : toponymes et mots courants (piège apparenté au WRONG-ISSUER
# du Bond Scanner, piège #31 du dépôt). Mesuré en réel (2026-08-04, 45% de
# faux positifs sur un run — 5/11) : un rapprochement sur UN SEUL mot n'est
# pas fiable même quand ce mot apparaît bel et bien dans le nom OFFICIEL de
# la société trouvée — le résolveur n'a pas menti, le mot ne suffit juste
# pas à prouver que l'article parle DE cette société :
#   « Okayama » / « Hiroshima » (préfectures japonaises, Nikkei suivi) →
#     OKAYAMAKEN FREIGHT TRANSPORTATI / HIROSHIMA GAS CO — de vraies
#     sociétés RÉGIONALES japonaises portent littéralement le nom de leur
#     préfecture ; l'article parlait du lieu, pas de la société.
#   « California » (état américain, S&P/Nasdaq suivis) → Banc of California.
#   « Beyond » / « Hope » (mots anglais courants en tête de phrase) →
#     Beyond Meat / Hope Bancorp.
# Même esprit que bond-scanner/scanner/rating_providers.py
# _GENERIC_NAME_TOKENS (piège #31g, "le seul token distinctif d'une société
# ne peut pas être un pays ou une ville") : un candidat d'UN SEUL mot dont ce
# mot est un toponyme ou un mot du dictionnaire ne déclenche pas de
# proposition. Recall < correctness — perdre une vraie « Banc of California »
# est acceptable, en proposer une fausse ne l'est pas (piège #31, "le lecteur
# est un investisseur qui prend la liste pour argent comptant").
#
# ⚠️ CONTRAIREMENT À _STOPWORDS : cette catégorie ne s'applique QU'AUX
# candidats d'UN SEUL MOT, jamais au premier mot d'un candidat multi-mots.
# Accompagné d'un second mot capitalisé, le toponyme DEVIENT discriminant —
# « Tokyo Electron » (poids lourd du Nikkei) ou « Texas Instruments » (S&P
# 500) n'ont aucun rapport avec un article sur la ville/l'état seuls, tout
# comme « Osaka Gas » n'est pas la ville d'Osaka. Un premier essai qui
# vérifiait `head` dès le début (comme _STOPWORDS) rendait ces deux sociétés
# invisibles — bug trouvé à la vérification (mesuré : `candidate_names()`
# rendait `[]` pour "Tokyo Electron shares jump…"). D'où le check est fait
# UNE FOIS le nom entièrement assemblé (`len(parts) == 1`), jamais sur `head`
# seul. Catégorie OUVERTE, comme _STOPWORDS ci-dessus : à étendre au fil des
# cas mesurés en réel plutôt que de viser l'exhaustivité d'un gazetteer.
_GENERIC_NAME_TOKENS = {
    # --- Préfectures / villes japonaises (Nikkei suivi ; Okayama et
    # Hiroshima sont 2 des 5 faux positifs mesurés) ---
    "tokyo", "osaka", "okayama", "hiroshima", "nagoya", "yokohama", "kyoto",
    "kobe", "fukuoka", "sapporo", "sendai", "kawasaki", "saitama", "chiba",
    "hokkaido", "kansai", "kanto", "kyushu", "honshu", "shikoku", "okinawa",
    "nagano", "niigata", "shizuoka", "hyogo", "aichi", "kanagawa",
    # --- États américains (S&P/Nasdaq suivis ; California est le 5e faux
    # positif mesuré, résolu en Banc of California) ---
    "california", "texas", "florida", "nevada", "illinois", "ohio",
    "georgia", "arizona", "oregon", "michigan", "colorado", "virginia",
    "massachusetts", "pennsylvania", "washington",
    # --- Autres places suivies (Shanghai/Hang Seng, DAX, CAC, FTSE MIB,
    # IBEX, SMI) — même risque, à titre préventif ---
    "shanghai", "beijing", "shenzhen", "guangzhou", "seoul", "mumbai",
    "sydney", "toronto", "singapore", "zurich", "geneva", "milan", "madrid",
    "berlin", "vienna", "amsterdam", "brussels", "dublin", "lisbon",
    # --- Mots anglais courants, capitalisés en tête de phrase, qui sont
    # AUSSI des noms de sociétés cotées réelles : Beyond Meat / Hope Bancorp
    # sont les 2 faux positifs "mot commun" mesurés ; Snap Inc. / Block Inc.
    # sont la même classe de risque (marque = mot du dictionnaire). ---
    "beyond", "hope", "snap", "block",
    # --- Noms communs ABSTRAITS, fréquemment le mot de TÊTE d'une raison
    # sociale (2026-08-04, 6e faux positif mesuré : « Tourism » — tête de
    # « Tourism price wars threaten... » — résout en TOURISM FINANCE
    # CORPORATION OF INDIA. Le mot EST le mot de tête du nom résolu, donc la
    # règle du mot de tête l'accepterait à raison selon sa propre logique ;
    # BSE -> nse est une place suivie, le filtre venues ne coupe rien non
    # plus. Seule cette extension arrête ce cas — c'est précisément l'usage
    # prévu pour cette liste : catégorie OUVERTE, étendue au cas mesuré).
    # Employés SEULS dans un titre de presse, ces mots désignent presque
    # toujours le CONCEPT (le secteur, la nation, le standard), jamais une
    # société précise — recall < correctness assumé : « United » seul ne
    # doit plus proposer United Airlines, « American » seul ne doit plus
    # proposer American Express. Un article qui parle vraiment d'elles
    # écrit les DEUX mots (« United Airlines »), candidat multi-mots, donc
    # jamais concerné par cette règle mono-mot (cf. commentaire plus haut
    # sur Tokyo Electron/Texas Instruments). ---
    "tourism", "finance", "energy", "capital", "general", "national",
    "international", "standard", "universal", "health", "industrial",
    "federal", "global", "continental", "pacific", "atlantic", "first",
    "united", "american", "european", "oriental", "central", "public",
    "private", "modern", "premier", "superior",
}

# Longueur minimale d'un nom NU (sans ticker explicite). « Tap » a trois
# lettres et se résout en Tapestry : trop court pour être discriminant.
_MIN_NAME_LEN = 4

# Un nom de société commence par une majuscule ; on garde aussi les formes
# « SK Hynix » (deux mots capitalisés consécutifs).
_WORD = re.compile(r"\b([A-Z][A-Za-z][A-Za-z'&\.\-]*(?:\s[A-Z][A-Za-z'&\.\-]+)?)")

# Tokens alphanumériques en minuscules — ponctuation/apostrophes/espaces sont
# des séparateurs. Utilisé par _lead_token() pour normaliser avant comparaison
# (« Amazon.com » -> "amazon"+"com" ; « McDonald's » -> "mcdonald"+"s").
_NAME_TOKEN_RE = re.compile(r"[a-z0-9]+")


def _lead_token(text: Any) -> str:
    """Premier token alphanumérique en minuscules du texte, "" si aucun."""
    tokens = _NAME_TOKEN_RE.findall(str(text or "").lower())
    return tokens[0] if tokens else ""


# ⚠️ 6e faux positif mesuré (2026-08-04) : « Tourism » n'était ni un toponyme
# ni un mot listé dans _GENERIC_NAME_TOKENS — la LISTE ne peut PAS couvrir
# tous les mots communs du monde. Il fallait une RÈGLE, en plus de la liste.
#
# Piège #31 (Bond Scanner) adapté : le token IDENTITAIRE d'une société est le
# PREMIER mot de son nom, jamais un mot du milieu. « Tourism » (tête de
# « Tourism price wars threaten... ») se résolvait en CHINA TOURISM GROUP
# DUTY FREE — mot du MILIEU (tête réelle : « China ») → l'article parle du
# secteur, pas de cette société. À l'inverse « Palantir » EST la tête de
# « Palantir Technologies Inc. » → identitaire, gardé.
#
# Ne s'applique QU'AUX candidats d'UN SEUL MOT (comme _GENERIC_NAME_TOKENS,
# cf. son commentaire) : un candidat multi-mots (« Tokyo Electron », « Texas
# Instruments », « Schneider Electric ») est déjà discriminant par
# construction et n'est jamais soumis à ce test.
def _single_word_candidate_is_verified(candidate: str, resolved_name: str) -> bool:
    """True si `candidate` peut légitimement désigner `resolved_name`.

    - Candidat multi-mots : toujours True, la règle ne le concerne pas.
    - Candidat d'un seul mot : True SEULEMENT si ce mot (normalisé) est le
      mot de TÊTE du nom résolu (normalisé) — comparaison par TOKEN ENTIER,
      pas par sous-chaîne (« Iran » ne doit pas matcher « Irani »).
    - Nom résolu vide/absent : True par défaut (rien à vérifier contre —
      la venue/le symbole restent filtrés ailleurs).
    """
    if len(candidate.split()) != 1:
        return True
    cand = _lead_token(candidate)
    lead = _lead_token(resolved_name)
    if not cand or not lead:
        return True
    return cand == lead


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
        # Toponyme / mot générique : n'écarte QUE les candidats d'UN SEUL
        # MOT (len(parts) == 1) — voir le commentaire de _GENERIC_NAME_TOKENS.
        # Un second mot survivant (« Tokyo Electron », « Texas Instruments »,
        # « Osaka Gas ») rend le toponyme discriminant et le candidat passe.
        if name and len(parts) == 1 and name.lower() in _GENERIC_NAME_TOKENS:
            continue
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
        # Candidat d'un seul mot : n'accepter que si ce mot est le mot de
        # TÊTE du nom résolu, pas un mot du milieu (voir le commentaire de
        # _single_word_candidate_is_verified — piège #31 adapté).
        if not _single_word_candidate_is_verified(name, info.get("name") or ""):
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
