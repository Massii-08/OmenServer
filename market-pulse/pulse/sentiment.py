"""Thèmes de presse et garde-fou éditorial — pur, déterministe, sans LLM.

Deux rôles :

1. **`is_advice`** : un titre de presse peut LUI-MÊME être un conseil
   d'investissement (« We're upgrading our rating on Boeing », « Le 5 azioni
   da comprare »). Le bot s'interdit toute recommandation ; recopier celle
   d'un journal la ferait passer pour la sienne auprès d'un lecteur âgé. Ces
   titres sont donc écartés, et comptés — pas cachés.
2. **`extract_themes`** : de quoi parle la presse ce matin, par comptage de
   mots-clés bilingues. Aucun modèle, aucun score d'opinion : un thème est un
   fait vérifiable (« l'inflation revient dans 4 titres »).
"""
import re
import unicodedata
from typing import Any, Dict, List, Optional

# Vocabulaire prescriptif, italien et anglais. Un titre qui en contient un est
# une recommandation (ou une invitation à en suivre une) → écarté du rapport.
_ADVICE_PATTERNS = [
    # anglais
    r"\bbuy\b", r"\bsell\b", r"\bupgrad", r"\bdowngrad", r"price target",
    r"\btop picks?\b", r"best stocks?", r"stocks? to (buy|watch|own)",
    r"should you (buy|sell)", r"\boverweight\b", r"\bunderweight\b",
    r"\bstrong buy\b", r"\boutperform\b", r"raises? (its )?target",
    # italien
    r"\bcomprare\b", r"\bvendere\b", r"\bacquistare\b", r"\bconviene\b",
    r"consigli", r"raccomand", r"da comprare", r"su cui investire",
    r"\bmigliori titoli\b", r"titoli da\b", r"portafoglio consigliato",
    r"occasione d[i']acquisto", r"prezzo obiettivo", r"promoss[oa] a",
    # Analyse graphique. Ce n'est pas un « achetez » explicite, mais c'est une
    # PRÉVISION de direction — et recopiée sous le nom de la bourse, un lecteur
    # âgé la prend pour celle du bot. Mesuré sur la recherche Bluesky
    # « borsa milano » : « Il supporto del 38,2% di Fibonacci e il canale
    # ribassista potrebbero preparare un rimbalzo ».
    r"\bfibonacci\b", r"analisi tecnica", r"technical analysis",
    r"\bcanale (ribassista|rialzista)\b",
    r"potrebbe(ro)? (salire|scendere|crollare|rimbalzare|puntare|preparare un)",
]
_ADVICE_RE = [re.compile(p, re.IGNORECASE) for p in _ADVICE_PATTERNS]


# Thèmes suivis. Les mots-clés couvrent l'italien ET l'anglais : la moitié du
# corpus est en anglais, un thème mono-langue ne se déclencherait jamais
# dessus et donnerait un comptage faux.
THEMES = {
    "inflazione": ["inflazione", "inflation", "prezzi al consumo", "cpi",
                   "carovita", "deflazione"],
    "banche centrali": ["bce", "ecb", "fed", "federal reserve", "banca centrale",
                        "central bank", "tassi di interesse", "interest rates",
                        "lagarde", "powell", "boj", "bank of japan"],
    "occupazione": ["occupazione", "disoccupazione", "employment", "jobs",
                    "payrolls", "lavoro", "salari", "wages"],
    "utili societari": ["utile", "utili", "earnings", "trimestrale", "ricavi",
                        "revenue", "profitti", "profit", "bilancio"],
    "materie prime": ["petrolio", "oil", "brent", "gas", "oro", "gold",
                      "rame", "copper", "materie prime", "commodities"],
    "dazi e commercio": ["dazi", "tariffs", "commercio", "trade war", "export",
                         "import", "sanzioni", "sanctions"],
    "debito e titoli di stato": ["btp", "spread", "titoli di stato", "bond",
                                 "treasury", "debito", "debt", "rendimenti",
                                 "yields", "obbligazion"],
    "tecnologia": ["intelligenza artificiale", "artificial intelligence",
                   "chip", "semiconduttor", "semiconductor", "nvidia",
                   "tecnologia", "tech"],
    "energia": ["energia", "energy", "elettricità", "rinnovabil", "nucleare",
                "nuclear"],
    "geopolitica": ["guerra", "war", "geopolit", "elezioni", "election",
                    "governo", "government shutdown"],
}

# Mots de tonalité — un COMPTAGE, pas une analyse. Le rapport l'annonce comme
# tel : « parole di tono positivo/negativo nei titoli ».
_POSITIVE = ["rialzo", "sale", "salgono", "crescita", "cresce", "utile",
             "utili", "record", "recupera", "ottimismo", "positiv",
             "rally", "gains", "rises", "jumps", "surge", "growth", "beats",
             "optimism", "higher"]
_NEGATIVE = ["ribasso", "scende", "scendono", "calo", "cala", "perdita",
             "perdite", "crollo", "timori", "negativ", "tensione", "crisi",
             "falls", "drops", "slides", "losses", "fears", "slump",
             "selloff", "lower", "warns"]


def _norm(text: Any) -> str:
    """Minuscules sans accents : « Perché conviene » et « perche conviene »
    doivent se comporter pareil."""
    if not isinstance(text, str):
        return ""
    folded = unicodedata.normalize("NFKD", text)
    return "".join(c for c in folded if not unicodedata.combining(c)).lower()


def is_advice(title: Any) -> bool:
    """Le titre est-il une recommandation d'investissement ?"""
    text = _norm(title)
    if not text:
        return False
    return any(rx.search(text) for rx in _ADVICE_RE)


# Courrier des lecteurs / finances personnelles. Les fils « top stories » des
# médias financiers en charrient (sondé : « My stepdad is dying from cancer.
# How can I help my mom… » en une de MarketWatch). Ce n'est pas du marché, et
# dans un rapport lu chaque matin par une personne âgée, c'est brutal.
_OFFTOPIC_PATTERNS = [
    r"^\s*(my|our) (husband|wife|mom|mother|dad|father|stepdad|stepmom|son|"
    r"daughter|brother|sister|parents|in-laws|boyfriend|girlfriend|partner|"
    r"neighbou?r|friend|boss)\b",
    r"^\s*i'?m \d{1,3}\b", r"^\s*i am \d{1,3}\b",
    # Les courriers de lecteurs s'ouvrent souvent sur une CITATION, ce qui
    # faisait rater tous mes ancrages en début de chaîne. Mesuré :
    # « 'I'm in my peak earning years': I'm working beyond 70 » et
    # « 'We already have wills': We're in our 60s with $1.5 million ».
    r"^\s*[\u2018\u2019'\"\u201c\u201d]",
    r"\bwe'?re in our \d{2}s\b", r"\bi'?m in my\b", r"\bmy (wife|husband|partner)\b",
    r"\bshould (we|i) \b", r"\bwill that (help|affect)\b", r"\bsocial security\b",
    r"\bmy \d{1,3}-year-old\b", r"\bin my (peak|golden) \w+ years\b",
    r"\bdear (quentin|moneyist|therapist)\b", r"\bthe moneyist\b",
    r"\bmio (marito|figlio|padre|suocero)\b", r"\bmia (moglie|figlia|madre)\b",
]
_OFFTOPIC_RE = [re.compile(p, re.IGNORECASE) for p in _OFFTOPIC_PATTERNS]


def is_offtopic(title: Any) -> bool:
    """Chronique de vie privée / courrier des lecteurs plutôt que du marché."""
    text = _norm(title)
    if not text:
        return False
    return any(rx.search(text) for rx in _OFFTOPIC_RE)


def _mentions(haystack: str, needle: str) -> bool:
    """Occurrence sur limite de mot : « oro » ne doit pas matcher « lavoro »."""
    return re.search(r"(?<![0-9a-z])" + re.escape(needle), haystack) is not None


def extract_themes(items: Optional[List[Dict[str, Any]]],
                   max_examples: int = 2) -> List[Dict[str, Any]]:
    """Thèmes présents dans les titres, du plus au moins cité."""
    out = []
    for theme, words in THEMES.items():
        count = 0
        examples = []
        for item in (items or []):
            title = (item or {}).get("title") if isinstance(item, dict) else None
            text = _norm(title)
            if not text:
                continue
            if any(_mentions(text, _norm(w)) for w in words):
                count += 1
                if len(examples) < max_examples and title not in examples:
                    examples.append(title)
        if count:
            out.append({"theme": theme, "count": count, "examples": examples})
    out.sort(key=lambda t: (-t["count"], t["theme"]))
    return out


def tone_counts(items: Optional[List[Dict[str, Any]]]) -> Dict[str, int]:
    """Combien de titres portent un mot de tonalité positive / négative.

    C'est un comptage de mots, pas un jugement sur le marché — le rapport le
    présente avec ces mots-là.
    """
    positive = negative = total = 0
    for item in (items or []):
        title = (item or {}).get("title") if isinstance(item, dict) else None
        text = _norm(title)
        if not text:
            continue
        total += 1
        if any(_mentions(text, w) for w in _POSITIVE):
            positive += 1
        if any(_mentions(text, w) for w in _NEGATIVE):
            negative += 1
    return {"positive": positive, "negative": negative, "total": total}
