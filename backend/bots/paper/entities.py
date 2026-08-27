"""Les ENTREPRISES nommées dans un titre — « Nvidia » devient ``NVDA``.

Le trou que ce module bouche : un titre comme « l'administration Trump veut
acheter des cartes graphiques à Nvidia » entrait dans la mémoire SANS symbole.
Il partait donc au pivot « monde » de la toile, il ne rejoignait aucune branche,
et il ne pesait sur aucun facteur de convergence — alors qu'il parle très
précisément d'un titre que l'utilisateur peut détenir. La veille voyait
l'information ; elle ne savait pas de QUI elle parlait.

Doctrine, la même que ``whales.match_issuer`` (leçon du piège #31 du dépôt) :
**on ne devine jamais**. Un rapprochement se fait sur un nom RECONNU, comparé
en MOT ENTIER, jamais en sous-chaîne — « meta » ne doit pas se déclencher sur
« metadata », ni « ubs » sur « subsidiary ». Ce qu'on ne reconnaît pas ne
produit rien, ce qui est infiniment préférable à un symbole inventé : un event
mal étiqueté irait polluer les facteurs « titre détenu » de la convergence.

Deux sources de noms, dans cet ordre de priorité :

1. ``extra`` — les ancres de l'UTILISATEUR (ses positions, sa watchlist),
   construites par l'appelant avec :func:`anchor_index`. Elles priment : si
   quelqu'un suit « Apple » sur une autre place, c'est SON symbole qui doit
   sortir, pas celui de la table livrée ;
2. la table livrée, ~40 méga-capitalisations. Volontairement COURTE : chaque
   entrée est une occasion de se tromper, et la valeur du module vient d'abord
   des ancres de l'utilisateur.

Module PUR au sens du dépôt : aucune I/O, aucun réseau, aucune horloge. Les
expressions de la table sont compilées UNE fois à l'import.

⚠️ Résidu connu et assumé : un nom collé à un trait d'union (« meta-analysis »)
franchit la garde de mot entier, parce que le trait d'union EST une frontière de
mot — et il doit l'être, sans quoi « coca-cola » ou « AMD-powered » ne
matcheraient plus. La conséquence est bornée : le symbole erroné n'est ni détenu
ni suivi, donc l'event est omis de la toile et n'allume aucun facteur.
"""
import re
from functools import lru_cache
from typing import Any, Dict, Iterable, List, Optional, Pattern, Tuple

# Au-delà, un titre ne « parle » plus d'entreprises, il en cite une liste
# (« 3 stocks to watch: … ») — et ces listes-là sont justement ce que la veille
# refuse de relayer.
MAX_PER_TITLE = 3

# Longueur minimale d'une clé de nom. En dessous, on ne reconnaît plus une
# marque, on attrape un mot de la langue.
MIN_NAME_LEN = 3

# Longueur minimale d'un SYMBOLE utilisé comme clé de reconnaissance. Un ticker
# court redevient un mot ordinaire une fois en minuscules (« F » Ford, « GM »,
# « KO », « IT »…) : le laisser entrer étiquetterait la moitié des titres. Les
# tickers courts restent reconnus par le cashtag ``$F``, qui est explicite.
MIN_SYMBOL_LEN = 3

# Formes juridiques et mots de structure retirés en FIN de nom, pour que la
# watchlist « Alphabet Inc. » reconnaisse un titre qui dit « Alphabet ». On ne
# retire jamais un token de TÊTE et on ne réduit jamais un nom à un seul mot
# générique : c'est exactement le piège #31 (« Deutsche » ne suffit pas à
# identifier « Deutsche Bank »).
_LEGAL_SUFFIXES = frozenset((
    "inc", "inc.", "incorporated", "corp", "corp.", "corporation", "co",
    "co.", "company", "ltd", "ltd.", "limited", "plc", "llc", "lp",
    "sa", "s.a.", "sas", "ag", "nv", "n.v.", "bv", "spa", "s.p.a.",
    "gmbh", "ab", "asa", "oyj", "as", "kgaa", "se",
    "holding", "holdings", "group", "groupe", "gruppe",
    "class", "cl", "a", "b", "adr", "ads",
))

# La table livrée : ``(nom en minuscules, symbole Yahoo)``. Plusieurs noms
# peuvent pointer le même symbole (« alphabet » et « google »).
_COMPANIES: Tuple[Tuple[str, str], ...] = (
    ("nvidia", "NVDA"),
    ("apple", "AAPL"),
    ("microsoft", "MSFT"),
    ("tesla", "TSLA"),
    ("amazon", "AMZN"),
    ("alphabet", "GOOGL"), ("google", "GOOGL"),
    ("meta", "META"), ("facebook", "META"),
    ("boeing", "BA"),
    ("intel", "INTC"),
    ("amd", "AMD"), ("advanced micro devices", "AMD"),
    ("netflix", "NFLX"),
    ("berkshire", "BRK-B"), ("berkshire hathaway", "BRK-B"),
    ("jpmorgan", "JPM"), ("jp morgan", "JPM"), ("j.p. morgan", "JPM"),
    ("goldman", "GS"), ("goldman sachs", "GS"),
    ("exxon", "XOM"), ("exxonmobil", "XOM"), ("exxon mobil", "XOM"),
    ("chevron", "CVX"),
    ("pfizer", "PFE"),
    ("moderna", "MRNA"),
    ("coca-cola", "KO"), ("coca cola", "KO"),
    ("pepsi", "PEP"), ("pepsico", "PEP"),
    ("mcdonald", "MCD"), ("mcdonalds", "MCD"),
    ("disney", "DIS"),
    ("nike", "NKE"),
    ("walmart", "WMT"),
    ("ford", "F"),
    ("general motors", "GM"),
    ("lockheed", "LMT"), ("lockheed martin", "LMT"),
    ("rtx", "RTX"), ("raytheon", "RTX"),
    ("palantir", "PLTR"),
    ("coinbase", "COIN"),
    # Suisse et Europe : ce sont les places de l'utilisateur, elles ne peuvent
    # pas manquer d'une table qui sert d'abord SON portefeuille.
    ("nestle", "NESN.SW"), ("nestlé", "NESN.SW"),
    ("novartis", "NOVN.SW"),
    # Yahoo cote Roche sous ``RO.SW`` — ``ROG.SW`` (ticker officiel SIX) n'y
    # existe pas (cf. ``quotes.SYMBOL_ALIASES``, vécu). Même émetteur, même
    # cohérence : un événement « Roche » ne doit pas pointer vers un symbole
    # que le reste du simulateur ne connaît pas.
    ("roche", "RO.SW"),
    ("ubs", "UBSG.SW"),
    ("lvmh", "MC.PA"),
    # Semis et pharma : la matière la plus fréquente des annonces politiques
    # (droits de douane, contrôles à l'export) est justement là.
    ("broadcom", "AVGO"),
    ("qualcomm", "QCOM"),
    ("tsmc", "TSM"), ("taiwan semiconductor", "TSM"),
    ("eli lilly", "LLY"),
)


@lru_cache(maxsize=1024)
def _word_pattern(name: str) -> Pattern:
    """L'expression qui reconnaît ce nom en MOT ENTIER.

    ``(?<!\\w)``/``(?!\\w)`` plutôt que ``\\b`` : un nom peut commencer ou finir
    par un caractère non alphanumérique (« j.p. morgan »), et ``\\b`` change
    alors de sens — la garde par regard alentour, elle, dit toujours la même
    chose (« pas de lettre ni de chiffre collé »).

    MÉMORISÉE : les ancres de l'utilisateur sont recompilées à chaque titre, et
    un passage Reddit en examine cent d'un coup. Le cache est BORNÉ — les noms
    viennent d'une watchlist, pas d'une source ouverte.
    """
    return re.compile(r"(?<!\w)" + re.escape(name) + r"(?!\w)")


_BUILTIN: Tuple[Tuple[str, str, Pattern], ...] = tuple(
    (name, symbol, _word_pattern(name)) for name, symbol in _COMPANIES)


# --------------------------------------------------------------------------- #
# Les ancres de l'utilisateur
# --------------------------------------------------------------------------- #

def _clean(value: Any) -> str:
    return str(value if value is not None else "").strip()


def strip_legal_suffix(name: Any) -> str:
    """« Alphabet Inc. » -> « alphabet », « Roche Holding AG » -> « roche ».

    Retire les formes juridiques et les mots de structure en FIN de nom, jamais
    en tête, et **refuse de rendre une chaîne vide** : un nom qui ne serait fait
    que de ces mots-là ressort inchangé plutôt que de disparaître.
    """
    tokens = _clean(name).lower().split()
    while len(tokens) > 1 and tokens[-1].strip(",;") in _LEGAL_SUFFIXES:
        tokens.pop()
    return " ".join(tokens).strip(" .,-")


def anchor_index(rows: Any) -> Dict[str, str]:
    """``{nom en minuscules: SYMBOLE}`` pour les ancres de l'utilisateur (PUR).

    ``rows`` = des lignes ``{symbol, name?}`` — positions, watchlist, pipeline,
    dans n'importe quel ordre. Trois clés au plus par ligne : le nom complet, le
    nom sans sa forme juridique, et le SYMBOLE lui-même quand il est assez long
    pour ne pas se confondre avec un mot (cf. ``MIN_SYMBOL_LEN``).

    ⚠️ Une POSITION ne porte pas de nom (``models.Position`` n'a que le
    symbole) : c'est la watchlist qui le fournit. D'où l'intérêt de passer les
    deux familles — et d'écrire la clé du symbole même quand le nom manque.
    """
    out: Dict[str, str] = {}
    if not isinstance(rows, (list, tuple)):
        return out
    for row in rows:
        if not isinstance(row, dict):
            continue
        symbol = _clean(row.get("symbol")).upper()
        if not symbol:
            continue
        keys = []
        name = _clean(row.get("name")).lower()
        if name and name != symbol.lower():
            keys.append(name)
            keys.append(strip_legal_suffix(name))
        if len(symbol) >= MIN_SYMBOL_LEN:
            keys.append(symbol.lower())
        for key in keys:
            if len(key) >= MIN_NAME_LEN:
                out.setdefault(key, symbol)
    return out


# --------------------------------------------------------------------------- #
# La détection
# --------------------------------------------------------------------------- #

def _extra_pairs(extra: Any) -> Iterable[Tuple[str, str, Pattern]]:
    """Les ancres de l'utilisateur, compilées à la volée (elles sont peu
    nombreuses et changent avec le portefeuille : les figer n'aurait pas de
    sens)."""
    if not isinstance(extra, dict):
        return ()
    out: List[Tuple[str, str, Pattern]] = []
    for name, symbol in extra.items():
        key = _clean(name).lower()
        value = _clean(symbol).upper()
        if len(key) < MIN_NAME_LEN or not value:
            continue
        out.append((key, value, _word_pattern(key)))
    return out


def detect_companies(title: Any, extra: Any = None) -> List[str]:
    """Les symboles des entreprises NOMMÉES dans ce titre (PUR).

    Rend au plus ``MAX_PER_TITLE`` symboles, dédoublonnés, **dans l'ordre où
    ils apparaissent dans le titre** : la première entreprise citée est celle
    dont le titre parle. À position égale, le nom le plus LONG gagne (« general
    motors » plutôt qu'un hypothétique « general »), puis le symbole tranche —
    deux appels rendent donc toujours exactement la même liste.

    ``extra`` (cf. :func:`anchor_index`) PRIME sur la table livrée : un même nom
    présent des deux côtés sort avec le symbole de l'utilisateur.
    """
    text = _clean(title)
    if not text:
        return []
    low = text.lower()

    seen_names = set()
    hits: List[Tuple[int, int, str, str]] = []

    def _scan(pairs: Iterable[Tuple[str, str, Pattern]]) -> None:
        for name, symbol, pattern in pairs:
            if name in seen_names:
                continue          # déjà résolu par une source prioritaire
            seen_names.add(name)
            match = pattern.search(low)
            if match is not None:
                hits.append((match.start(), -len(name), symbol, name))

    _scan(_extra_pairs(extra))
    _scan(_BUILTIN)

    hits.sort()
    out: List[str] = []
    for _, _, symbol, _name in hits:
        if symbol not in out:
            out.append(symbol)
        if len(out) >= MAX_PER_TITLE:
            break
    return out


def first_company(title: Any, extra: Any = None) -> Optional[str]:
    """Le symbole de l'entreprise dont ce titre parle, ou ``None`` (PUR).

    Raccourci de confort pour les appelants qui n'en veulent qu'un — c'est le
    cas de tous les événements de veille, qui ne portent qu'un ``symbol``.
    """
    found = detect_companies(title, extra)
    return found[0] if found else None
