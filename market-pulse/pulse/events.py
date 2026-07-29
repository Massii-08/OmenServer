"""« Qui a fait quoi » — le tri qui distingue un FAIT d'un COMMENTAIRE.

Critère donné par Massii, et il vaut mieux que la simple récence :

    « l'important des news est de nous donner tout ce qui pourrait changer la
      courbe d'une entreprise, bourse... (genre cette personne a fait ça) »

La différence, sur des titres réels relevés le 2026-07-29 :

    « Ford raises guidance after Q2 earnings beat »        -> un acteur, une action
    « Minister apologizes as ETF investors nurse losses »  -> un ministre a parlé
    « Is the AI rally running out of steam? »              -> personne n'a rien fait

Un titre du troisième type peut être intéressant à lire, mais il ne déplace
aucune courbe : il descend, il ne disparaît pas.

⚠️ **Classer n'est pas prédire.** Dire « ce titre rapporte une action concrète »
est un fait sur la NATURE du titre. Dire dans quel sens la courbe irait serait
une prévision — c'est pourquoi il n'y a ici ni champ `direction`, ni `sentiment`,
ni objectif de cours, et qu'un test le verrouille.
"""
import re
import unicodedata
from typing import Any, Dict, List, Optional

# Qui agit. L'ordre compte : le premier acteur trouvé gagne, du plus
# institutionnel au plus général (une banque centrale citée dans un titre
# d'entreprise reste l'acteur principal de la nouvelle).
ACTOR_KINDS = ("banca centrale", "governo", "giustizia", "azienda", "mercato")

_ACTORS = (
    ("banca centrale", [
        r"\bbce\b", r"\becb\b", r"\bfed\b", r"federal reserve", r"\bboj\b",
        r"bank of (japan|england)", r"\bboe\b", r"\bsnb\b", r"\bpboc\b",
        r"banca centrale", r"zentralbank", r"banque centrale", r"lagarde",
        r"powell", r"\bwarsh\b",
    ]),
    ("governo", [
        r"\bminist", r"\bgovern", r"\bregierung", r"\bpresident", r"\btrump\b",
        r"\bmeloni\b", r"\bmacron\b", r"\bwhite house\b", r"\bcommissione\b",
        r"\beu\b.*\b(approv|ban|fine)", r"\bregulator", r"\bantitrust\b",
        r"\bnetanyahu\b", r"\bparlament", r"\bsenat", r"\bdazi\b", r"\btariff",
        r"\bsanction", r"\bsanzion",
    ]),
    ("giustizia", [
        r"\bcourt\b", r"\bgericht\b", r"\btribunal", r"\bjudge\b", r"\blawsuit\b",
        r"\bcausa legale\b", r"\bindagine\b", r"\binvestigation\b", r"\bfined?\b",
        r"\bmulta\b", r"insolvenz", r"\bbankrupt", r"\bfallimento\b",
        r"\bsettlement\b", r"\bappeal\b",
    ]),
)

# Ce qui est fait. Une action concrète, verifiable, datable.
_ACTIONS = (
    ("risultati", [
        r"\bearnings\b", r"\bresults\b", r"\brisultati\b", r"\btrimestral",
        r"\bquarterl", r"\bq[1-4]\b", r"\bprofit", r"\butile\b", r"\butili\b",
        r"\bloss(es)?\b", r"\blost\b", r"\bperdit[ae]\b", r"\bperde\b", r"\brevenue", r"\bricavi\b", r"\bbeat\b",
        r"\bmiss(ed|es)?\b", r"\bposts? (a )?(wider|narrower|record)",
        r"\bbilanz", r"\bumsatz",
    ]),
    ("previsioni", [
        r"\bguidance\b", r"\bforecast\b", r"\boutlook\b", r"\bhikes?\b",
        r"\braises?\b", r"\bcuts?\b", r"\blowers?\b", r"\bconfirm", r"\bconferma",
        r"\btagli", r"\balza\b", r"\brivede\b",
    ]),
    ("dirigenti", [
        r"\bceo\b", r"\bcfo\b", r"\bchairman\b", r"\bamministratore delegato\b",
        r"\bnomina\b", r"\bappoints?\b", r"\bsteps? down\b", r"\bresign",
        r"\bdimission", r"\bvorstand", r"\bnamed\b.*\bchief\b",
    ]),
    ("operazioni", [
        r"\bacquisi", r"\bacquires?\b", r"\bmerger\b", r"\bfusione\b",
        r"\bstake\b", r"\bquota\b", r"\bbuyback\b", r"\briacquisto\b",
        r"\bipo\b", r"\bopa\b", r"\btakeover\b", r"\btender offer\b",
        r"\blancia (un[ae] )?(opa|offerta)\b", r"\bofferta pubblica\b",
        r"\bdelisting\b", r"\bspin[- ]?off\b", r"\bdividend",
        r"\bdividendo\b", r"\bemission", r"\bbond sale\b",
    ]),
    ("produzione", [
        r"\brecall", r"\brichiama\b", r"\bstrike\b", r"\bsciopero\b",
        r"\bplant\b", r"\bstabilimento\b", r"\blayoff", r"\blicenziament",
        r"\bshutdown\b", r"\bdifetto\b", r"\bdefect\b", r"\bproduction\b",
    ]),
    ("politica monetaria", [
        r"\brate (decision|hold|hike|cut)", r"\bholds? its key\b", r"\btassi\b",
        r"\bzinsen\b", r"\btaux\b", r"\binflazione\b", r"\binflation\b",
        r"\bvoted to\b",
    ]),
    ("prezzi", [
        r"\btumbles?\b", r"\bplunges?\b", r"\bsettles? at\b", r"\bfalls?\b",
        r"\bsurges?\b", r"\bjumps?\b", r"\bcrolla\b", r"\bbalza\b",
        r"\brally\b.*\b(record|high)\b", r"\bchiude in\b", r"\bapre in\b",
        r"\b2-week (low|high)\b", r"\brecord (high|low)\b",
    ]),
    ("geopolitica", [
        r"\bstruck\b", r"\battack", r"\bwar\b", r"\bguerra\b", r"\bmeets? with\b",
        r"\bincontra\b", r"\bagreement\b", r"\baccordo\b", r"\bdeal\b",
    ]),
)

# Marqueurs d'OPINION : si le titre n'est qu'une question ou une analyse, il
# n'y a pas d'action. Ces motifs ne suffisent pas à disqualifier seuls — ils
# tranchent quand aucune action nette n'a été trouvée.
_OPINION = [
    r"^\s*(is|are|why|what|how|should|does|do)\b",
    r"^\s*(perch[eé]|come|cosa|quali|quanto)\b",
    r"^\s*(warum|wieso|was)\b",
    r"\brunning out of steam\b", r"\bforget\b", r"\bwhat('s| is) really behind\b",
    r"\bthat's a problem\b", r"\bcose da sapere\b", r"\bthings to know\b",
    r"\bfavorite activity\b", r"\bdo not exist\b", r"\blooks cheap\b",
    r"\bpiling into\b",
]

# Le MODE du verbe tranche mieux qu'une liste d'opinions. « La Fed pourrait
# baisser ses taux » a un acteur ET une action, mais rien n'a eu lieu : c'est du
# conditionnel. Mesuré sur un vrai titre qui passait à travers ma première
# version : « A surging El Nino could kill Fed rate cuts ».
_SPECULATION = [
    r"\bcould\b", r"\bmay\b", r"\bmight\b", r"\bwould\b", r"\bcan\b",
    r"\bis (set|expected|poised|likely) to\b", r"\bare (set|expected|likely) to\b",
    r"\bpotrebbe\b", r"\bdovrebbe\b", r"\bpotrebbero\b", r"\batteso\b",
    r"\bk[oö]nnte\b", r"\bd[uü]rfte\b", r"\bpourrait\b", r"\bdevrait\b",
]

# ...sauf si le titre RAPPORTE une parole ou un acte accompli. « Trump says
# tariffs could rise » est un fait (il l'a dit), pas une spéculation du
# journaliste.
_REPORTING = [
    r"\bsays?\b", r"\bsaid\b", r"\bannounce", r"\bposts?\b", r"\bposted\b",
    r"\bvoted?\b", r"\breports?\b", r"\bapologi", r"\bconfirm", r"\braises?\b",
    r"\bhikes?\b", r"\bnomina\b", r"\brichiama\b", r"\bdichiara\b",
    r"\bannuncia\b", r"\bha detto\b", r"\bsagt\b", r"\bteilt mit\b",
    r"\btells?\b", r"\bwarns?\b", r"\bfiles?\b", r"\blaunche",
]

_RX_SPECULATION = [re.compile(p) for p in _SPECULATION]
_RX_REPORTING = [re.compile(p) for p in _REPORTING]

_RX_ACTORS = [(kind, [re.compile(p) for p in pats]) for kind, pats in _ACTORS]
_RX_ACTIONS = [(kind, [re.compile(p) for p in pats]) for kind, pats in _ACTIONS]
_RX_OPINION = [re.compile(p) for p in _OPINION]


def _norm(text: Any) -> str:
    if not isinstance(text, str):
        return ""
    folded = unicodedata.normalize("NFKD", text)
    return "".join(c for c in folded if not unicodedata.combining(c)).lower()


def classify(title: Any) -> Dict[str, Any]:
    """Ce titre rapporte-t-il une action, et de qui ?

    Rend `{"is_event": bool, "actor": str|None, "actions": [str]}` — et rien
    d'autre : pas de direction, pas de sentiment, pas d'objectif de cours.
    """
    text = _norm(title)
    empty = {"is_event": False, "actor": None, "actions": []}
    if not text:
        return empty

    actions = [kind for kind, pats in _RX_ACTIONS
               if any(rx.search(text) for rx in pats)]
    actor = None
    for kind, pats in _RX_ACTORS:
        if any(rx.search(text) for rx in pats):
            actor = kind
            break

    # Conditionnel sans parole rapportée = spéculation du journaliste, pas un
    # fait. C'est ce filtre-là qui écarte « ... could kill Fed rate cuts »,
    # lequel a pourtant bien un acteur et une action.
    reported = any(rx.search(text) for rx in _RX_REPORTING)
    if not reported and any(rx.search(text) for rx in _RX_SPECULATION):
        return empty

    opinion = any(rx.search(text) for rx in _RX_OPINION)
    if opinion and not actions:
        return empty
    if not actions and actor is None:
        return empty
    # Une opinion qui cite une action reste une opinion si l'action est faible
    # (un seul motif de prix, typiquement « piling into », déjà écarté ci-dessus).
    if opinion and actions and actor is None and len(actions) == 1:
        return empty

    if actor is None:
        # Une action sans acteur nommé : c'est une société ou le marché.
        actor = "mercato" if actions == ["prezzi"] else "azienda"
    return {"is_event": True, "actor": actor, "actions": actions}


def is_event(title: Any) -> bool:
    """Raccourci : ce titre rapporte-t-il quelque chose que quelqu'un a fait ?"""
    return classify(title)["is_event"]


def rank_events(items: Optional[List[Dict[str, Any]]]) -> List[Dict[str, Any]]:
    """Classe les titres : les faits devant, le commentaire derrière.

    On CLASSE, on ne censure pas — c'est au rapport de décider combien il en
    montre. À l'intérieur de chaque groupe, le plus récent d'abord.
    """
    out = []
    for item in (items or []):
        if not isinstance(item, dict) or not item.get("title"):
            continue
        enriched = dict(item)
        enriched["event"] = classify(item.get("title"))
        out.append(enriched)
    out.sort(key=lambda i: (0 if i["event"]["is_event"] else 1,
                            -(i.get("published") or 0)))
    return out
