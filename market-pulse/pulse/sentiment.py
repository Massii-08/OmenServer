"""Thèmes de presse et garde-fou éditorial — pur, déterministe, sans LLM.

Trois rôles :

1. **`is_advice`** / **`find_prescriptive`** : un titre de presse peut
   LUI-MÊME être un conseil d'investissement (« We're upgrading our rating on
   Boeing », « Le 5 azioni da comprare »). Le bot s'interdit toute
   recommandation ; recopier celle d'un journal la ferait passer pour la
   sienne auprès d'un lecteur âgé. Ces titres sont donc écartés, et comptés —
   pas cachés. `PRESCRIPTIVE_PATTERNS` est la SOURCE UNIQUE de ce vocabulaire,
   partagée avec `analyst.check_synthesis` (le même garde-fou, appliqué à la
   synthèse LLM SORTANTE plutôt qu'aux titres ENTRANTS) — pour qu'une
   formulation refusée à l'un des deux bouts le soit toujours à l'autre.
2. **`is_offtopic`** : chronique de vie privée, courrier des lecteurs, ou
   actualité générale sans angle de marché (politique, voyage) — ce n'est pas
   de l'actualité de bourse, et publié sous le nom d'une place ça se lit
   comme si le bot en parlait.
3. **`extract_themes`** : de quoi parle la presse ce matin, par comptage de
   mots-clés bilingues. Aucun modèle, aucun score d'opinion : un thème est un
   fait vérifiable (« l'inflation revient dans 4 titres »).
"""
import re
import unicodedata
from typing import Any, Dict, List, Optional

# Vocabulaire prescriptif, italien et anglais. Un titre — ou une synthèse LLM,
# cf. `find_prescriptive` — qui en contient un est une recommandation (ou une
# invitation à en suivre une) → écarté du rapport, ou rejeté au profit du mode
# dégradé. C'est la SOURCE UNIQUE : `is_advice` (titres ENTRANTS) et
# `analyst.check_synthesis` (synthèse SORTANTE) partagent cette même liste au
# lieu d'en maintenir chacun une copie — c'est exactement une divergence de ce
# genre (le filtre d'entrée durci après un incident réel, celui de sortie
# resté à sa version d'origine) qui laissait passer en synthèse une
# formulation déjà refusée comme titre de presse.
#
# ⚠️ Pour un terme AMBIGU en italien financier courant (« rating » désigne
# aussi bien la note d'une agence — un FAIT — qu'un conseil d'achat/vente), on
# raisonne en MOTIF (« upgrade », « outperform », « target price »...), jamais
# en mot nu : un bot trop strict jette systématiquement la synthèse et personne
# ne le remarque puisque le mode dégradé est silencieux.
PRESCRIPTIVE_PATTERNS = [
    # anglais
    r"\bbuy\b", r"\bsell\b", r"\bupgrad", r"\bdowngrad",
    r"price target", r"target price",
    r"\btop picks?\b", r"best stocks?", r"stocks? to (buy|watch|own)",
    r"should you (buy|sell)", r"\boverweight\b", r"\bunderweight\b",
    r"\bstrong buy\b", r"\boutperform\b", r"raises? (its )?target",
    r"\brecommend",
    # italien
    r"\bcomprare\b", r"\bvendere\b", r"\bacquistare\b", r"\bconviene\b",
    r"consigli", r"raccomand", r"\bsuggeriamo\b", r"da comprare",
    r"su cui investire", r"\bmigliori titoli\b", r"titoli da\b",
    r"portafoglio consigliato",
    r"occasione d(?:i|')\s*acquisto", r"opportunita d(?:i|')\s*acquisto",
    r"prezzo obiettivo", r"promoss[oa] a",
    r"dovrebbe (salire|scendere)",
    # « previsione »/« prevediamo »/« prevedo » : le SUBSTANTIF et les verbes à
    # la 1re personne — jamais « previsto/a », le PARTICIPE qu'emploie une
    # simple donnée d'AGENDA factuelle (« la riunione della BCE prevista per
    # oggi »). Border chaque forme pour ne pas avaler ce cas.
    r"\bprevisione\b", r"\bprevediamo\b", r"\bprevedo\b",
    # Analyse graphique. Ce n'est pas un « achetez » explicite, mais c'est une
    # PRÉVISION de direction — et recopiée sous le nom de la bourse, un lecteur
    # âgé la prend pour celle du bot. Mesuré sur la recherche Bluesky
    # « borsa milano » : « Il supporto del 38,2% di Fibonacci e il canale
    # ribassista potrebbero preparare un rimbalzo ».
    r"\bfibonacci\b", r"analisi tecnica", r"technical analysis",
    r"\bcanale (ribassista|rialzista)\b",
    r"potrebbe(ro)? (salire|scendere|crollare|rimbalzare|puntare|preparare un)",
]
PRESCRIPTIVE_RE = [re.compile(p, re.IGNORECASE) for p in PRESCRIPTIVE_PATTERNS]


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


def find_prescriptive(text: Any) -> Optional[str]:
    """Le premier fragment prescriptif trouvé dans `text` (le texte matché,
    pas le motif regex) — ou `None` si `text` est propre.

    SOURCE UNIQUE utilisée par les deux garde-fous du bot : `is_advice`
    ci-dessous (titres de presse ENTRANTS) et `analyst.check_synthesis`
    (synthèse LLM SORTANTE, import direct de cette fonction — jamais une
    liste dupliquée). Un futur durcissement de `PRESCRIPTIVE_PATTERNS` profite
    donc automatiquement aux deux, sans qu'on ait à se souvenir de le
    répercuter à la main.
    """
    norm = _norm(text)
    if not norm:
        return None
    for rx in PRESCRIPTIVE_RE:
        m = rx.search(norm)
        if m:
            return m.group(0)
    return None


def is_advice(title: Any) -> bool:
    """Le titre est-il une recommandation d'investissement ?"""
    return find_prescriptive(title) is not None


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

    # Particuliers italiens qui demandent un avis (forums de finance perso
    # type r/ItaliaPersonalFinance) : mesures a 0/13 titres ecartes alors
    # qu'un briefing de bourse en publiait tel quel. Ce n'est pas de
    # l'actualite de marche, et sous le nom d'une place ca se lit comme du
    # conseil. Categorie = PREMIERE PERSONNE + demande d'avis -- les motifs
    # generalisent (ages/formulations differents), pas les mots exacts d'un
    # titre precis.
    r"\bho \d{1,3} anni\b",
    r"\b(cosa|che) ne pens",
    r"\bdubb(?:io|i)\s+(su|circa)\b",
    # Titre-etiquette sans verbe ni sujet ("Gestione del patrimonio",
    # typique d'un fil de forum) -- ancre sur TOUT le titre pour ne jamais
    # mordre une vraie depeche qui mentionnerait ces mots en passant
    # ("La Bce vara un piano di gestione del patrimonio da 500 miliardi"
    # doit rester une info de marche : ces mots n'en forment pas le titre
    # entier).
    r"^\s*gestione (del|della|dei|delle) (patrimonio|risparmio|finanze|soldi)"
    r"[.?!]?\s*$",

    # Durcissement anti-bavardage de forum (mesure : les 3 items Reddit
    # publies un matin etaient tous du bavardage, is_offtopic() rendait
    # False sur les trois). Le point commun n'est pas le sujet mais le
    # REGISTRE -- premiere personne, demande d'avis, recit personnel,
    # question d'assistance, langage familier/vulgaire -- jamais un acteur
    # qui fait une action.
    #
    # Registre vulgaire / familier : une depeche de presse financiere
    # n'emploie jamais ces mots, quel que soit le sujet (mesure : "Fanculo
    # Vanguard, io mi butto su ALLW!"). Italien ET anglais -- les subreddits
    # sources (r/investing, r/stocks...) sont bilingues.
    r"\b(vaffanculo|fanculo|cazz\w*|minchia|stronz\w*|merda|fuck\w*|shit)\b",
    # Declaration de position personnelle a la 1re personne -- meme registre
    # sans forcement de vulgarite ("mi butto su X", "sono entrato su X") :
    # un pari personnel raconte au present/preterit, jamais une depeche.
    r"\b(mi butto|mi sono buttat[oa]|sono entrat[oa]) (su|in)\b",

    # Question d'assistance envers un courtier -- titre-etiquette qui OUVRE
    # sur le probleme (mesure : "Problemi con acquisto etf su fineco"), pas
    # sur l'acteur (les vraies depeches de ce flux ouvrent TOUJOURS sur
    # l'acteur : "Prysmian acquisisce...", "Gme, il prezzo..."). Double
    # garde-fou pour ne jamais mordre une operation de M&A relatee par la
    # presse ("Deutsche Bank, problemi con l'acquisto di una quota...") :
    # ancre en tete de titre + exige une preposition de plateforme/courtier
    # a proximite (su/dal/presso/verso) -- jamais "da" seul, trop frequent
    # dans "acquisto ... da parte di" (M&A).
    r"^\s*problem[ai]\s+(con|nel|nella)\b[^.?!]{0,25}\b"
    r"(acquisto|vendita|bonifico|prelievo|deposito|trasferimento|ordine)\b"
    r"[^.?!]{0,20}\b(su|dal|presso|verso)\b",

    # Sollicitation de l'avis/l'experience de la communaute -- jamais le
    # registre d'une depeche (mesure : "What's a piece of investing content
    # you'd hand a beginner today?"). 2e personne conditionnelle suivie
    # d'un verbe de conseil, ou ouverture "anyone else/does anyone"/
    # "qualcuno ha" typique d'un fil de forum.
    r"\b(you'?d|would you)\b[^.?!]{0,40}\b(hand|give|recommend|suggest|tell|"
    r"advise|share|pass)\b",
    r"^\s*(anyone else|does anyone|has anyone|is anyone)\b",
    r"^\s*qualcuno\s+(ha|usa|conosce|sa)\b",

    # Actualite generale / geopolitique SANS angle de marche -- le fil
    # "top stories" d'une agence generaliste (Reuters, AP) en charrie sous
    # le nom d'une bourse (deja vecu : une depeche sur un opposant detenu
    # publiee sous le nom de la Borsa di Milano). Motifs de la CONVENTION
    # journalistique (attribution en fin de titre, vocabulaire diplomatique/
    # droits politiques), jamais les mots-sujets seuls : "guerra"/"war"
    # restent libres, ils portent aussi de vraies infos de marche ("diesel
    # prices... since the Iran war started").
    r",\s*(government|authorities|officials) says?\b",
    r"\bdetained\b", r"\bopposition (figure|leader)\b",

    # Tourisme / voyage -- idiomes reconnaissables du journalisme de voyage,
    # jamais les mots-sujets seuls ("tourism" reste libre : "Tourism price
    # wars threaten... consumer spending" est de la macro, pas un article de
    # voyage).
    r"\breason to (stop|visit)\b", r"\btours? in\b",
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
