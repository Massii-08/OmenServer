"""Le graphe des connexions — ce que la mémoire relie à TES titres.

Vue façon Obsidian : les titres au centre (détenus, suivis, en projet), et
autour tout ce que les autres modules ont retenu — dépêches, catalyseurs,
annonces politiques, actualité crypto, posts X, hypothèses du radar,
mouvements des grands gérants.

**LA doctrine du module, celle qui explique tout le reste : les nœuds sont
étiquetés à l'ÉCRITURE, les arêtes sont résolues à la LECTURE.** Chaque module
range déjà ce qu'il sait avec son symbole, ses tickers ou son nom d'émetteur ;
personne n'écrit jamais un lien sur le disque. Un lien stocké périmerait — le
titre sort du portefeuille, l'hypothèse se referme, la position se solde, et
le graphe continuerait d'afficher une arête qui ne veut plus rien dire. Ici
rien ne périme : à chaque appel on repart des faits.

Deux vues, une seule fonction :

* **globale** — toutes les ancres et tout ce qui s'y rattache ;
* **branche** (``symbol=X``) — l'ancre X, ses voisins DIRECTS, et rien d'autre.

Six règles qui tiennent le graphe honnête :

1. **Aucun lien inventé.** Un rapprochement se fait sur un symbole, un ticker
   ou un nom d'émetteur rapproché par ``whales.match_issuer`` — jamais sur une
   intuition. Ce qui ne se rattache à rien de connu n'est pas rattaché.
2. **Un graphe montre des connexions, pas un dépotoir.** Une info qui ne
   touche aucune ancre est OMISE de la vue globale. Trois exceptions, et trois
   seulement : le macro (annonce politique, actualité crypto sans titre nommé)
   rejoint un pivot « monde » ; les tendances Reddit rejoignent un pivot
   « foule » ; les hypothèses du radar dont aucun ticker n'est ancré rejoignent
   un pivot « radar ». Aucun des trois n'est relié à une ancre — donc aucun
   n'apparaît dans une branche par titre.
3. **Les ancres ne se coupent jamais.** Quand le plafond mord, on garde toutes
   les ancres et on sacrifie les infos les plus VIEILLES ; le retour porte
   alors ``truncated: True``, jamais un silence.
4. **Un bosquet ne mange pas les branches.** Chaque pivot a son PROPRE
   sous-plafond (``MAX_GROVE``), pris HORS du budget des branches ; le
   débordement devient UN nœud d'agrégat « +N autres ». Mesuré le 26/08 sur le
   compte réel : 79 annonces politiques avaient rempli les 80 places, ne
   laissant au graphe qu'une ancre et un pivot — le sujet du graphe expulsé
   par son décor. Un débordement de bosquet ne lève PAS ``truncated`` : rien
   n'est perdu en silence, l'agrégat dit combien il en reste — et
   ``build_grove`` rend ce reste à qui veut le LIRE (« quand on ouvre, on voit
   tout » : le canvas garde ses douze, la masse passe en liste).
5. **Une famille qui déborde se coupe en SUJETS.** Au-delà de
   ``THEME_MIN_LEAVES`` feuilles d'une même famille, un niveau de THÈMES
   s'intercale entre l'hôte (pivot ou ancre) et ses feuilles. Mesuré le 26/08
   sur le compte réel : douze feuilles « Politique » dont HUIT sur la même
   histoire Trump/Canada — douze points identiques à survoler un par un. Le
   regroupement emprunte ``newswatch.story_key``, le regroupeur DÉJÀ calibré
   sur ce flux ; il RÉPARTIT sans rien ajouter (les douze dessinés restent
   douze) et il ne s'invite jamais là où rien ne se groupe.
6. **Un sujet qui déborde se coupe encore.** Passé ``SUBTHEME_MIN_LEAVES``
   items dans un même thème de LISTE, un second étage s'ouvre — les tokens du
   parent retirés du comptage, ce qui reste nomme le sous-sujet (« Beef »,
   « Steel », « Autos »). Il ne concerne QUE la liste (``build_grove``) : le
   dessin garde un seul niveau de thèmes, parce qu'au-delà on ne lit plus un
   graphe, on l'explore.

Module PUR au sens du dépôt : aucune I/O, aucune écriture, aucune horloge
implicite (``now`` est un paramètre). Le seul import du dehors est PARESSEUX et
ne sert qu'à emprunter une autre fonction pure (``whales.match_issuer``).
"""
import hashlib
from datetime import datetime, timedelta, timezone
from typing import Any, Callable, Dict, List, Optional, Tuple

# --------------------------------------------------------------------------- #
# Contrat public
# --------------------------------------------------------------------------- #

# Fenêtre de fraîcheur des nœuds d'INFO. Sept jours, comme
# ``convergence.WHALE_MOVE_FRESH_D`` : au-delà, un signal n'éclaire plus une
# décision, il encombre l'écran.
WINDOW_D = 7

# Plafonds d'affichage. Au-delà, un graphe ne se lit plus — il se contemple.
MAX_NODES = 80
MAX_EDGES = 160

# Une thèse d'hypothèse tient en une ligne de nœud.
LABEL_CAP = 60

# Types d'ANCRE, dans l'ordre de PRÉCÉDENCE quand un même titre est à la fois
# détenu, en projet et suivi : l'argent engagé prime sur la décision en cours,
# qui prime sur la simple curiosité.
ANCHOR_TYPES = ("position", "pipeline", "watchlist")
DEFAULT_ANCHOR_TYPE = "watchlist"
_ANCHOR_RANK = {kind: rank for rank, kind in enumerate(ANCHOR_TYPES)}

# Étape de pipeline qui sort une ligne du graphe : la boucle est bouclée.
CLOSED_STAGE = "clos"

# Types de nœuds d'INFO.
INFO_TYPES = ("news", "catalyst", "gov", "crypto", "eco", "climat", "x",
              "bsky", "reddit", "hypothesis", "whale_move", "reddit_trend")

# Les trois pivots — reliés à RIEN d'autre que leurs satellites.
CONTEXT_TYPE = "context"
WORLD_ID = "monde"
WORLD_LABEL = "Monde"
CROWD_ID = "foule"
CROWD_LABEL = "Foule Reddit"
RADAR_ID = "radar"
RADAR_LABEL = "Radar"

# L'ORDRE d'émission des bosquets — figé pour que deux appels rendent
# exactement le même graphe.
PIVOT_IDS = (WORLD_ID, CROWD_ID, RADAR_ID)
_PIVOT_LABELS = {WORLD_ID: WORLD_LABEL, CROWD_ID: CROWD_LABEL,
                 RADAR_ID: RADAR_LABEL}

# Sous-plafond PAR bosquet, PRIS HORS du budget des branches. Douze satellites
# suffisent à dire « il se passe quelque chose de ce côté » ; au-delà on ne lit
# plus un bosquet, on le subit — et surtout il expulsait les branches, qui sont
# le SUJET du graphe (mesure du 26/08, cf. règle 4 en tête de fichier).
MAX_GROVE = 12

# Le nœud qui dit ce que le sous-plafond a laissé dehors. Un seul par bosquet :
# « +67 autres » se lit, 67 points anonymes ne se lisent pas.
AGGREGATE_TYPE = "aggregate"
_AGGREGATE_PREFIX = "agg:"

# --- Les THÈMES : une branche qui déborde se coupe en sous-sujets ----------- #
#
# Mesuré le 26/08 (capture utilisateur) : douze feuilles « Politique » sous un
# même rameau, dont HUIT sur la même histoire Trump/Canada. Le lecteur voyait
# douze points identiques et devait les survoler un par un. « Pourquoi pas une
# branche que pour ça, ça se répartit mieux. »
#
# Le regroupeur existe DÉJÀ dans la maison : ``newswatch.story_key``, calibré
# sur ce flux précis (stopwords, verbes de dépêche, « trump » neutralisé). On
# l'emprunte — on ne le réécrit pas.
THEME_TYPE = "theme"
_THEME_PREFIX = "th:"

# Au-delà de six feuilles dans une même famille, le sous-niveau vaut la peine.
# À six ou moins, l'ajouter ne fait qu'allonger le chemin de l'œil.
THEME_MIN_LEAVES = 6

# Deux histoires se rejoignent quand elles partagent au moins DEUX tokens
# significatifs. Un seul token commun ne dit rien (« canada » à lui seul relie
# une taxe douanière à un match de hockey) ; deux disent un sujet.
THEME_MERGE_MIN_SHARED = 2

# Un nom de thème tient en deux mots — « Canada · Tariffs ». Trois se lisent
# comme une phrase tronquée, un seul ne distingue plus rien.
THEME_LABEL_TOKENS = 2

# Le fourre-tout : les feuilles que rien ne rapproche. Le libellé part en
# français comme celui des pivots et de l'agrégat ; le frontend le RETRADUIT
# par la clé (whitelist fermée), il n'affiche jamais le mot du serveur.
MISC_THEME_KEY = "divers"
MISC_THEME_LABEL = "Divers"

# Codes d'entité qui s'écrivent en capitales dans un nom de thème (« US » et
# non « Us »). Même liste que le filtre de tokens courts de ``newswatch``.
_THEME_UPPER = frozenset({"us", "eu", "uk", "un"})

# --- Les SOUS-SUJETS : « séparer encore plus » ------------------------------ #
#
# Suite directe des thèmes. Quand un sujet grossit (soixante-dix dépêches
# « Canada · Tariffs »), le niveau qu'on vient d'ajouter ne répartit plus rien :
# on a remplacé un mur de points par un mur de lignes sous un seul intertitre.
# Un DEUXIÈME étage s'ouvre alors — « Beef », « Steel », « Autos »,
# « Retaliation ».
#
# Ce qui change par rapport au premier étage, et pourquoi :
#
# * **les tokens du PARENT sont exclus du comptage.** Sans ça, chaque
#   sous-groupe se ferait nommer « Canada · Tariffs » comme son parent : les
#   mots qui ont formé le thème sont, par construction, ceux que tous ses
#   membres partagent.
# * **le regroupement se fait par MOT DOMINANT**, et non par fusion transitive
#   comme au premier étage — cf. la mesure dans ``subtheme_clusters`` : la
#   fusion, à un seul token partagé (il n'en reste qu'un à exiger, le contexte
#   commun ayant été retiré), ramasse les 72 dépêches en UN bloc.
# * **un seul mot dans le nom** : le parent porte déjà le contexte, le sous-nom
#   n'a qu'à porter la nuance.
SUBTHEME_MIN_LEAVES = 18
SUBTHEME_LABEL_TOKENS = 1

# Un mot porté par une seule dépêche n'est pas un sujet : il nommerait un
# sous-groupe d'un élément, ce que le premier étage refuse déjà.
SUBTHEME_MIN_SHARED_LEAVES = 2

# Un stem présent dans au moins la moitié des titres du groupe est du CONTEXTE,
# pas un sujet — on l'exclut comme on exclut les tokens du parent, même quand
# l'appelant ne l'a pas nommé. C'est ce qui empêche « US » (présent partout)
# de recoller entre eux des sous-sujets qui n'ont rien à voir.
SUBTHEME_COMMON_RATIO = 0.5

# En dessous de deux sous-sujets NOMMÉS, le niveau ne répartit rien : un unique
# intertitre au-dessus de la même liste allonge le chemin de l'œil sans rien
# donner. Règle « pas de niveau inutile », déjà celle de ``_theme_layer``.
SUBTHEME_MIN_CLUSTERS = 2

# FAMILLE d'un nœud d'info = ce que le frontend peint sous un même rameau. Le
# regroupement thématique se fait DANS une famille : un thème doit avoir une
# couleur, et une seule.
#
# ⚠️ MIROIR de ``paper_module._GFAM`` — les deux tables doivent bouger
# ensemble. Une dérive n'est pas fatale (un thème se retrouverait dans un
# rameau dont un enfant a une autre couleur), mais elle se verrait.
_FAMILY_OF = {
    "news": "press", "catalyst": "press",
    "gov": "gov", "crypto": "crypto",
    # Deux familles de plus (26/08 soir) : la macroéconomie et l'écologie à
    # impact économique. Elles sont DISTINCTES de « gov » à dessein — une
    # décision de la Fed n'est pas une annonce politique, et les mélanger
    # rendrait le rameau « Politique » illisible, ce qui est précisément le
    # reproche qui a lancé ces deux volets.
    "eco": "eco", "climat": "climat",
    "x": "social", "reddit": "social", "reddit_trend": "social",
    # Bluesky (W2a) : du social, comme X et Reddit. ⚠️ Le miroir frontend
    # ``paper_module._GFAM`` n'a PAS encore d'entrée « bsky » — ces nœuds
    # tombent donc sur la couleur de repli et n'apparaissent pas dans la
    # légende. Rien n'est cassé (le regroupement par famille, lui, est correct
    # ici), mais la parité reste à faire côté frontend, avec sa clé i18n.
    "bsky": "social",
    "whale_move": "whale", "hypothesis": "radar",
}
DEFAULT_FAMILY = "other"

# Les bosquets qu'on sait LISTER, et le plafond de cette liste.
#
# Le dessin garde ses douze (au-delà un bosquet ne se lit plus, cf. règle 4),
# mais « +71 autres » n'est une réponse que si on peut ALLER VOIR ces 71 —
# sinon l'agrégat annonce une masse et la cache. La liste est donc l'autre
# moitié de la même honnêteté : le canvas montre, la liste énumère.
#
# Cent cinquante : très au-dessus de ce qu'une fenêtre de sept jours produit
# (mesure du 26/08 : 79 annonces politiques), assez bas pour qu'une source
# devenue folle ne fasse pas une réponse de plusieurs mégaoctets. Au-delà,
# ``total`` dit combien la mémoire en garde vraiment — jamais un silence.
GROVE_KINDS = PIVOT_IDS
GROVE_LIST_CAP = 150

# Tonalité d'une dépêche que ``newswatch.classify`` n'a pas su qualifier. Elle
# fait un nœud comme les autres (la branche presse serait vide sans elle) mais
# ne colore AUCUNE arête : un lien sans tonalité se dessine en bordure neutre.
NEUTRAL_SENTIMENT = "neutral"

# Les familles qui ont droit au pivot « monde » quand elles ne nomment aucun
# titre. Une dépêche d'entreprise orpheline, elle, est simplement omise : on ne
# sait pas de quoi elle parle pour CE portefeuille. Un post Reddit orphelin
# suit la même règle — il n'est pas du macro, il parle d'un titre qu'on ne
# suit pas.
#
# ``eco`` et ``climat`` (26/08 soir) y ont droit pour la même raison que
# ``gov`` : « l'inflation américaine accélère » ne nomme aucun titre et
# concerne tout le portefeuille. Quand la dépêche NOMME une entreprise ancrée,
# elle rejoint la branche de ce titre et non le pivot (cf. ``_dispatch``).
PIVOT_TYPES = ("gov", "crypto", "eco", "climat")

# Le bosquet de la foule : les tickers dont Reddit parle. Douze au plus — au-
# delà ce n'est plus une tendance, c'est la liste des tickers du forum.
TREND_TYPE = "reddit_trend"
MAX_TRENDS = 12

# Types d'ARÊTE = le MÉCANISME du rapprochement, pas la famille du nœud (celle-
# ci est déjà lisible sur le nœud source). Le frontend peut ainsi dire qu'un
# lien « émetteur » est plus flou qu'un lien « symbole ».
EDGE_SYMBOL = "symbol"       # l'info porte le symbole de l'ancre
EDGE_TICKER = "ticker"       # l'hypothèse liste le ticker de l'ancre
EDGE_ISSUER = "issuer"       # le nom d'émetteur 13F a été rapproché du ticker
EDGE_CONTEXT = "context"     # le macro rejoint le pivot « monde »
EDGE_THEME = "theme"         # le thème rejoint son hôte (pivot ou ancre)

# ``newswatch`` range les annonces politiques GLOBALES sous le pseudo-symbole
# « GOV ». Ce n'est pas un ticker : le laisser passer accrocherait toute la
# politique du monde à un porteur d'un titre qui s'appellerait GOV.
_PSEUDO_SYMBOLS = frozenset({"GOV"})


# --------------------------------------------------------------------------- #
# Dates et texte — RECOPIÉS de ``convergence`` à dessein
#
# Même raison que là-bas : une fonction pure ne doit pas dépendre d'un module
# d'I/O pour lire une date. Les règles sont les mêmes (ISO, epoch, date courte).
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
    """Identifiant court et STABLE dérivé du contenu — c'est lui qui dédoublonne
    une même dépêche vue par deux comptes."""
    raw = "|".join(_text(p) for p in parts)
    return hashlib.sha1(raw.encode("utf-8")).hexdigest()[:12]


def _cut(text: str, cap: int = LABEL_CAP) -> str:
    """Tronque à ``cap`` caractères, points de suspension COMPRIS."""
    text = _text(text)
    if len(text) <= cap or cap <= 0:
        return text
    return text[:cap - 1].rstrip() + "…"


def _sentiment(event: Dict[str, Any]) -> str:
    return _text(event.get("sentiment")).lower()


def _within(value: Any, cutoff: datetime) -> bool:
    """L'horodatage est-il dans la fenêtre ?

    Une date ILLISIBLE rend ``True`` — même posture que ``convergence._within`` :
    mieux vaut un nœud de trop qu'une info perdue parce qu'une source a changé
    son format de date.
    """
    when = _parse_dt(value)
    return when is None or when >= cutoff


def _tickers(hyp: Dict[str, Any]) -> List[str]:
    """Tickers d'une hypothèse, en majuscules, dédoublonnés dans l'ordre."""
    raw = hyp.get("tickers")
    values = [_upper(t) for t in raw] if isinstance(raw, (list, tuple)) \
        else [_upper(raw)]
    return list(dict.fromkeys([v for v in values if v]))


def _symbol_of(value: Any) -> str:
    """Symbole exploitable comme ANCRE — les pseudo-symboles n'en sont pas."""
    symbol = _upper(value)
    return "" if symbol in _PSEUDO_SYMBOLS else symbol


# --------------------------------------------------------------------------- #
# PUR — les ancres
# --------------------------------------------------------------------------- #

def _anchor_kind(value: Any) -> str:
    kind = _text(value).lower()
    return kind if kind in _ANCHOR_RANK else ""


def collect_anchors(anchors: Any, pipeline: Any) -> Dict[str, Dict[str, Any]]:
    """``{symbole: nœud d'ancre}`` — les titres qui ont droit au centre (PUR).

    ``anchors`` = lignes ``{symbol, name?, kind?}`` où ``kind`` vaut
    ``position`` ou ``watchlist`` (inconnu -> ``watchlist``, la lecture la moins
    engageante : on a vu ce titre quelque part, on ne prétend pas qu'il y a de
    l'argent dessus). ``pipeline`` = les lignes de la vue « Plan », dont les
    CLOSES sont écartées ici — un projet abouti n'est plus un projet.

    Deux arbitrages quand un symbole revient :

    * le TYPE le plus engagé gagne (``ANCHOR_TYPES``) ;
    * un VRAI nom l'emporte toujours sur le repli « le symbole lui-même ». Une
      position ne porte pas de nom (``models.Position`` n'a que le symbole) ;
      c'est la watchlist ou le pipeline qui le fournit, et sans lui aucun
      émetteur 13F ne rejoindrait jamais ce titre (même piège que
      ``convergence._symbol_names``).
    """
    rows: List[Tuple[str, str, str]] = []
    for row in _dicts(anchors):
        symbol = _symbol_of(row.get("symbol"))
        if symbol:
            rows.append((symbol,
                         _anchor_kind(row.get("kind")) or DEFAULT_ANCHOR_TYPE,
                         _text(row.get("name"))))
    for row in _dicts(pipeline):
        symbol = _symbol_of(row.get("symbol"))
        if not symbol or _text(row.get("computed_stage")).lower() == CLOSED_STAGE:
            continue
        rows.append((symbol, "pipeline", _text(row.get("name"))))

    out: Dict[str, Dict[str, Any]] = {}
    for symbol, kind, name in rows:
        node = out.get(symbol)
        if node is None:
            out[symbol] = {"id": symbol, "type": kind,
                           "label": name if _is_real_name(name, symbol) else symbol,
                           "symbol": symbol, "ts": ""}
            continue
        if _ANCHOR_RANK[kind] < _ANCHOR_RANK[node["type"]]:
            node["type"] = kind
        if node["label"] == symbol and _is_real_name(name, symbol):
            node["label"] = name
    return out


def _is_real_name(name: str, symbol: str) -> bool:
    """Un nom qui apporte quelque chose — pas le ticker recopié."""
    return bool(name) and name.upper() != symbol


# --------------------------------------------------------------------------- #
# PUR — les nœuds d'info
# --------------------------------------------------------------------------- #

def _event_type(event: Dict[str, Any]) -> str:
    """La famille d'une dépêche.

    La PROVENANCE d'abord (``src``) : un post X reste un post X, même quand il
    parle de politique — le frontend doit pouvoir le montrer comme tel. C'est
    aussi ce qui distingue une dépêche macro (``eco``) ou climatique
    (``climat``) d'une dépêche d'entreprise : leur TONALITÉ est celle de tout le
    monde (``pos``/``neg``/``watch``), seule leur provenance les nomme. La
    tonalité ensuite : ``gov`` (annonce politique), ``watch`` (catalyseur à
    venir), le reste étant de la dépêche.
    """
    src = _text(event.get("src")).lower()
    # Un communiqué de banque centrale EST une dépêche macro : il rejoint le
    # rameau « éco » plutôt que d'ouvrir une famille à lui tout seul. Ce que sa
    # provenance ajoute (« source officielle ») est déjà dit par son message ;
    # ce qu'un rameau supplémentaire coûterait, c'est un rameau de plus à lire.
    if src == "bc":
        return "eco"
    # La PRESSE mondiale, elle, n'est pas nommée par sa provenance : une dépêche
    # de la BBC sur Nestlé est une dépêche sur Nestlé. Elle tombe donc sur la
    # tonalité comme le volet par symbole (``news``/``catalyst``/``gov``), et
    # atterrit dans la famille « press » — exactement là où on la cherche.
    if src in ("x", "bsky", "crypto", "reddit", "eco", "climat"):
        return src
    tone = _sentiment(event)
    if tone == "gov":
        return "gov"
    if tone == "watch":
        return "catalyst"
    return "news"


def _event_node(event: Dict[str, Any]) -> Dict[str, Any]:
    """Un nœud de dépêche. L'identité est le LIEN (ce qui dédoublonne la même
    dépêche vue par deux comptes) ; sans lien, le couple symbole+titre — la
    même clé que ``convergence._collect_news``."""
    title = _text(event.get("title"))
    link = _text(event.get("link"))
    symbol = _symbol_of(event.get("symbol"))
    node: Dict[str, Any] = {
        "id": "ev:" + _hash(link or "%s|%s" % (symbol, title)),
        "type": _event_type(event),
        "label": title or "(dépêche sans titre)",
        "symbol": symbol,
        "ts": _text(event.get("ts")),
        "sentiment": _sentiment(event),
    }
    if link:
        node["link"] = link
    handle = _text(event.get("handle"))
    if handle:
        node["handle"] = handle
    return node


def _hypothesis_node(hyp: Dict[str, Any]) -> Dict[str, Any]:
    """Un nœud d'hypothèse du radar. La date qui compte est celle du VERDICT
    quand il existe : une hypothèse notée hier est une nouvelle d'hier, même si
    elle a été écrite il y a trois semaines.

    Les tickers voyagent dans ``meta`` : quand AUCUN n'est ancré, l'hypothèse
    part au bosquet « radar » sans la moindre arête, et sans eux le lecteur
    n'aurait aucun moyen de savoir sur quoi elle se mesure (c'est exactement le
    « Canada invisible » du 26/08 — les paris CNI/CP n'apparaissaient nulle
    part parce qu'aucun de leurs tickers n'était détenu).
    """
    thesis = _text(hyp.get("thesis"))
    node: Dict[str, Any] = {
        "id": "hyp:" + (_text(hyp.get("id")) or _hash("hyp", thesis)),
        "type": "hypothesis",
        "label": _cut(thesis) or "(hypothèse sans thèse)",
        "symbol": "",
        "ts": _text(hyp.get("scored_at")) or _text(hyp.get("created_at")),
        "status": _text(hyp.get("status")) or "open",
        "outcome": hyp.get("outcome"),
    }
    level = _text(hyp.get("risk_level"))
    if level:
        node["level"] = level
    tickers = _tickers(hyp)
    if tickers:
        node["meta"] = {"tickers": tickers}
    return node


def _keep_hypothesis(hyp: Dict[str, Any], cutoff: datetime) -> bool:
    """Une hypothèse OUVERTE compte quel que soit son âge (elle est vivante, et
    le radar en borne déjà le nombre par ``MAX_OPEN``). Une hypothèse NOTÉE ne
    compte que si son verdict est frais.

    Volontairement plus strict que ``_within`` : une hypothèse close SANS date
    lisible est écartée. Sans date on ne peut pas prétendre à la fraîcheur, et
    l'inverse ferait grossir le graphe d'archives à chaque passage du radar.
    """
    if (_text(hyp.get("status")) or "open") == "open":
        return True
    when = _parse_dt(hyp.get("scored_at")) or _parse_dt(hyp.get("created_at"))
    return when is not None and when >= cutoff


def _whale_node(move: Dict[str, Any]) -> Dict[str, Any]:
    """Un nœud « mouvement de gérant ». Le libellé porte QUI, QUOI et SUR QUOI :
    « sortie » sans savoir qui est sorti ne veut rien dire.

    L'identité est ``gérant + émetteur`` : dans un même trimestre un gérant n'a
    qu'une action par ligne, donc cette clé ne peut pas confondre deux
    mouvements réellement distincts.
    """
    manager = (_text(move.get("manager_label")) or _text(move.get("manager_id"))
               or "un grand gérant")
    action = _text(move.get("action")) or "mouvement"
    name = _text(move.get("name")) or "?"
    return {
        "id": "whale:" + _hash("whale", manager, name),
        "type": "whale_move",
        "label": "%s · %s · %s" % (manager, action, name),
        "symbol": "",
        "ts": _text(move.get("fetched_at")),
        "action": action,
        "quarter": _text(move.get("quarter")),
        "manager": manager,
    }


def _int(value: Any) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return 0


def _trend_rows(reddit_trends: Any) -> List[Tuple[str, int, int]]:
    """``[(SYMBOLE, count, prev)]`` triés et plafonnés (PUR).

    Du plus mentionné au moins mentionné, le symbole tranchant les ex æquo :
    deux appels rendent exactement le même bosquet. Un symbole sans mention
    n'entre pas — « SYM ×0 » n'est pas une tendance.
    """
    if not isinstance(reddit_trends, dict):
        return []
    rows: List[Tuple[int, str, int]] = []
    for symbol, row in reddit_trends.items():
        symbol = _upper(symbol)
        if not symbol or not isinstance(row, dict):
            continue
        count = _int(row.get("count"))
        if count <= 0:
            continue
        rows.append((-count, symbol, _int(row.get("prev"))))
    return [(symbol, -neg, prev) for neg, symbol, prev in sorted(rows)][:MAX_TRENDS]


def _trend_node(symbol: str, count: int, prev: int) -> Dict[str, Any]:
    """Un nœud du bosquet de la foule.

    Pas d'horodatage : une tendance est un COMPTEUR courant, pas un événement
    daté. Conséquence assumée du tri par fraîcheur d'``_assemble`` — quand le
    plafond de nœuds mord, c'est le bosquet qui part en premier, avant une
    dépêche datée. C'est le bon ordre : une dépêche dit ce qui s'est passé, un
    compteur dit seulement que ça bruisse.
    """
    return {"id": "rt:%s" % symbol, "type": TREND_TYPE,
            "label": "%s ×%d" % (symbol, count), "symbol": symbol, "ts": "",
            "meta": {"count": count, "prev": prev}}


def _default_matcher() -> Optional[Callable[[Any, Any], Optional[str]]]:
    """``whales.match_issuer`` — le rapprochement « nom d'émetteur -> ticker »
    qui existe DÉJÀ, et qui est lui-même pur (tokens significatifs, jamais un
    mot générique seul — piège #31 du dépôt). On l'emprunte plutôt que de le
    réécrire ; l'import est PARESSEUX pour que ce module reste chargeable dans
    un déploiement où ``whales`` manque."""
    try:
        from backend.bots.paper import whales
        return whales.match_issuer
    except Exception:      # noqa: BLE001 — module absent
        return None


def _whale_symbol(move: Dict[str, Any], names: Dict[str, str],
                  matcher: Optional[Callable[[Any, Any], Optional[str]]]) -> str:
    """Le ticker d'une ancre que ce mouvement concerne, ou ``""``.

    Un ``symbol`` déjà posé par l'appelant (``convergence._collect_whale_moves``
    le fait) est honoré tel quel s'il désigne une ancre — sinon on rapproche par
    le nom. Aucun rapprochement -> aucun lien : un mouvement attribué au mauvais
    titre serait pire que pas de mouvement du tout.
    """
    explicit = _upper(move.get("symbol"))
    if explicit and explicit in names:
        return explicit
    if matcher is None:
        return ""
    try:
        matched = matcher(move.get("name"), names)
    except Exception:      # noqa: BLE001 — un rapprochement bancal ne casse rien
        return ""
    matched = _upper(matched)
    return matched if matched in names else ""


# --------------------------------------------------------------------------- #
# PUR — les thèmes : découper une famille trop nombreuse en sous-sujets
# --------------------------------------------------------------------------- #

def _story_tools() -> Optional[Tuple[Callable[[str], List[str]],
                                     Callable[[str], str],
                                     Callable[[str], str]]]:
    """``(story_tokens, story_key, story_stem)`` de ``newswatch`` — le
    regroupeur de la maison, calibré sur CE flux (stopwords, verbes de dépêche,
    « trump » neutralisé).

    Import PARESSEUX pour la même raison que ``_default_matcher`` : ce module
    doit rester chargeable dans un déploiement où ``newswatch`` manque. Sans
    lui, il n'y a simplement pas de thèmes — le graphe garde sa forme d'avant,
    à plat, ce qui se lit toujours.
    """
    try:
        from backend.bots.paper import newswatch
        return (newswatch.story_tokens, newswatch.story_key, newswatch.story_stem)
    except Exception:      # noqa: BLE001 — module absent
        return None


def _family_of(node: Dict[str, Any]) -> str:
    """La famille de source d'un nœud d'info (cf. ``_FAMILY_OF``)."""
    return _FAMILY_OF.get(_text(node.get("type")), DEFAULT_FAMILY)


def _theme_word(token: str) -> str:
    """Un token de titre rendu présentable : « us » -> « US », « tariffs » ->
    « Tariffs ». On ne touche QUE la première lettre — mettre le reste en
    minuscules abîmerait un sigle."""
    word = _text(token)
    if not word:
        return ""
    if word.lower() in _THEME_UPPER:
        return word.upper()
    return word[:1].upper() + word[1:]


def _theme_label(titles: List[str],
                 tokens_of: Callable[[str], List[str]],
                 stem_of: Callable[[str], str],
                 drop: Any = (),
                 limit: int = THEME_LABEL_TOKENS) -> str:
    """Le nom HUMAIN d'un thème : les deux tokens les plus fréquents dans ses
    titres, capitalisés, joints par « · » (PUR).

    Deux subtilités qui font la différence entre un nom lisible et une bouillie
    de racines :

    * on COMPTE par stem (``tariff`` + ``tariffs`` = un seul sujet, huit
      occurrences) — sinon deux orthographes du même mot se battraient et
      perdraient toutes les deux contre un mot moins pertinent ;
    * on AFFICHE la forme de surface la plus fréquente de ce stem (« Nuclear »,
      pas « Nuclea » ; « Tariffs », pas « Tariff »). Le stem est un artefact de
      la clé, il n'a pas à s'afficher.

    Tri TOTAL de bout en bout (fréquence décroissante puis ordre alphabétique,
    aux deux étages) : deux appels rendent exactement le même nom.

    ``drop`` = les stems à NE PAS compter (les mots du thème parent, au
    deuxième étage) ; ``limit`` = combien de mots tient le nom. Les deux ont
    leur valeur du premier étage par défaut : un appel écrit avant les
    sous-sujets se comporte exactement comme avant.
    """
    dropped = set(drop or ())
    counts: Dict[str, int] = {}
    surfaces: Dict[str, Dict[str, int]] = {}
    for title in titles:
        for token in tokens_of(title):
            stem = stem_of(token)
            if not stem or stem in dropped:
                continue
            counts[stem] = counts.get(stem, 0) + 1
            bag = surfaces.setdefault(stem, {})
            bag[token] = bag.get(token, 0) + 1
    if not counts:
        return ""
    best = sorted(counts, key=lambda s: (-counts[s], s))[:max(1, int(limit))]
    words = []
    for stem in best:
        bag = surfaces[stem]
        word = sorted(bag, key=lambda w: (-bag[w], w))[0]
        words.append(_theme_word(word))
    return " · ".join([w for w in words if w])


def _merge_stories(keys: List[str], stems: Dict[str, set]) -> Dict[str, str]:
    """``{clé d'histoire: clé du groupe}`` — la fusion par tokens partagés (PUR).

    Union-find sur les clés TRIÉES, la représentante d'un groupe étant toujours
    la plus petite : l'identité d'un groupe ne dépend donc ni de l'ordre des
    entrées ni du hasard d'un dictionnaire.

    La comparaison porte sur le jeu de tokens ORIGINAL de chaque histoire (pas
    sur celui, grandissant, du groupe) : sinon un groupe absorberait de proche
    en proche tout ce qui partage deux mots avec n'importe lequel de ses
    membres — l'effet boule de neige.
    """
    parent = {k: k for k in keys}

    def find(key: str) -> str:
        while parent[key] != key:
            parent[key] = parent[parent[key]]
            key = parent[key]
        return key

    for i, left in enumerate(keys):
        for right in keys[i + 1:]:
            if len(stems[left] & stems[right]) < THEME_MERGE_MIN_SHARED:
                continue
            a, b = find(left), find(right)
            if a == b:
                continue
            # La plus PETITE clé devient la représentante -> ``find`` rend le
            # ``min`` du groupe, qui sert de clé publique du thème.
            if a < b:
                parent[b] = a
            else:
                parent[a] = b
    return {k: find(k) for k in keys}


def theme_clusters(leaves: Any) -> List[Dict[str, Any]]:
    """Les SOUS-SUJETS d'un paquet de feuilles — ``[{key, label, leaf_ids}]`` (PUR).

    Trois étapes, dans cet ordre :

    1. **une histoire = une ``newswatch.story_key``** du libellé. C'est le
       regroupeur calibré de la maison : deux reprises de la même dépêche par
       deux médias tombent sur la même clé. Un libellé vide (ou dont il ne
       reste aucun token significatif) part directement au fourre-tout.
    2. **fusion des variantes** : deux histoires partageant au moins
       ``THEME_MERGE_MIN_SHARED`` tokens significatifs se rejoignent, par
       fermeture transitive (``_merge_stories``).

       ⚠️ La comparaison porte sur les tokens du TITRE, pas sur ceux de la
       clé. Mesuré sur les huit titres Trump/Canada de la capture : la clé ne
       garde que les quatre stems alphabétiquement premiers, si bien que
       « tariff » en tombe une fois sur deux (``autos-canada-confir-exempt``,
       ``canada-double-mexico-steel``…) — la fusion par clé n'en regroupait
       que trois sur huit, les cinq autres restant en « Divers », c'est-à-dire
       exactement le mur de points que l'utilisateur a signalé. Par tokens de
       titre, les huit partagent ``{canada, tariff}`` et se rejoignent.
    3. **nommage** (``_theme_label``) et **rangement** : les thèmes nommés du
       plus gros au plus petit (clé alphabétique aux ex æquo), le fourre-tout
       TOUJOURS en dernier — c'est un reste, pas un sujet.

    Une feuille SEULE n'est pas un thème : elle rejoint le fourre-tout. Le
    fourre-tout n'est rendu que s'il a au moins une feuille.

    Rend une liste VIDE quand ``newswatch`` n'est pas là, ou quand aucune
    feuille exploitable n'a été fournie — l'appelant retombe alors sur la forme
    à plat, qui se lit toujours.
    """
    prepared = _prepare_rows(leaves)
    if prepared is None:
        return []
    return _cluster(prepared)


def subtheme_clusters(leaves: Any, parent_tokens: Any = ()) -> List[Dict[str, Any]]:
    """Les SOUS-SUJETS d'un thème déjà formé — même contrat que
    :func:`theme_clusters` (``[{key, label, leaf_ids}]``, PUR).

    Deux différences avec l'étage du dessus, et la seconde vient d'une mesure.

    **1. Les tokens du PARENT ne comptent plus.** Deux sources, cumulées :

    * ``parent_tokens`` — ce que l'appelant sait du parent (les mots de son
      nom, typiquement) ; passés en formes de surface, ils sont réduits en
      stems ici même ;
    * les stems présents dans au moins ``SUBTHEME_COMMON_RATIO`` des titres du
      paquet : un mot que la moitié du groupe partage EST le contexte du
      groupe, que l'appelant l'ait nommé ou non.

    Sans ça, chaque sous-groupe se ferait nommer comme son parent — les mots
    qui ont formé le thème sont, par construction, ceux que tous ses membres
    partagent.

    **2. Le regroupement se fait par MOT DOMINANT, pas par fusion transitive.**
    C'est le point où cet étage s'écarte du précédent, et ce n'est pas un choix
    d'esthétique : la fusion transitive du premier étage, ramenée ici à un seul
    token partagé (il en faut bien un seul, le contexte commun ayant été
    retiré), ramasse TOUT en un bloc. Mesuré sur un corpus de 72 dépêches
    « Canada · Tariffs » réparties en quatre sujets nets (bœuf, acier, autos,
    représailles) : **un seul groupe de 72**, parce qu'un « bite » ou un
    « hit » traînant dans deux familles suffit à les souder de proche en
    proche. Un sous-niveau qui rend un seul sous-groupe ne répartit rien.

    La règle retenue : le sous-sujet d'une dépêche est **le mot résiduel qui
    revient le plus souvent dans le paquet** (ex æquo tranchés
    alphabétiquement). Elle ne chaîne pas — chaque feuille est jugée seule — et
    elle nomme le sujet par le mot qui le porte vraiment.

    Vont au fourre-tout : les titres dont il ne reste RIEN après exclusion (on
    ne saurait les nommer autrement que par leur parent), ceux dont aucun mot
    résiduel n'est partagé par au moins ``SUBTHEME_MIN_SHARED_LEAVES`` feuilles
    (un mot qu'on ne voit qu'une fois n'est pas un sujet), et les groupes
    restés seuls.
    """
    prepared = _prepare_rows(leaves)
    if prepared is None:
        return []
    tokens_of, _key_of, stem_of = prepared["tools"]
    drop = {stem_of(_text(t).lower()) for t in (parent_tokens or ()) if _text(t)}
    drop.discard("")
    drop |= _common_stems(prepared["titles"], tokens_of, stem_of)

    rows = prepared["rows"]
    order = {_text(row.get("id")): i for i, row in enumerate(rows)}
    per_row = [{stem_of(t) for t in tokens_of(title)
                if stem_of(t) and stem_of(t) not in drop}
               for title in prepared["titles"]]

    counts: Dict[str, int] = {}
    for stems in per_row:
        for stem in stems:
            counts[stem] = counts.get(stem, 0) + 1

    loose: List[str] = []
    groups: Dict[str, Dict[str, Any]] = {}
    for row, title, stems in zip(rows, prepared["titles"], per_row):
        node_id = _text(row.get("id"))
        shared = [s for s in stems if counts[s] >= SUBTHEME_MIN_SHARED_LEAVES]
        if not shared:
            loose.append(node_id)
            continue
        best = sorted(shared, key=lambda s: (-counts[s], s))[0]
        group = groups.setdefault(best, {"ids": [], "titles": []})
        if node_id not in group["ids"]:
            group["ids"].append(node_id)
        group["titles"].append(title)

    named: List[Dict[str, Any]] = []
    for stem in sorted(groups):
        group = groups[stem]
        if len(group["ids"]) < 2:
            loose.extend(group["ids"])          # une feuille seule n'est pas un sujet
            continue
        # Même précaution qu'au premier étage : une clé qui vaudrait le mot du
        # fourre-tout est décalée plutôt que de s'y confondre à l'écran.
        public = (stem + "-") if stem == MISC_THEME_KEY else stem
        label = _theme_label(group["titles"], tokens_of, stem_of, drop=drop,
                             limit=SUBTHEME_LABEL_TOKENS)
        named.append({"key": public, "label": label or public,
                      "leaf_ids": sorted(group["ids"], key=lambda i: order[i])})

    named.sort(key=lambda c: (-len(c["leaf_ids"]), c["key"]))
    if loose:
        named.append({"key": MISC_THEME_KEY, "label": MISC_THEME_LABEL,
                      "leaf_ids": sorted(set(loose), key=lambda i: order[i])})
    return named


def _prepare_rows(leaves: Any) -> Optional[Dict[str, Any]]:
    """Le préambule commun aux deux étages : les outils de ``newswatch``, les
    feuilles IDENTIFIÉES et leurs titres. ``None`` quand il n'y a rien à
    grouper (module absent, aucune feuille exploitable)."""
    tools = _story_tools()
    rows = [row for row in _dicts(leaves) if _text(row.get("id"))]
    if tools is None or not rows:
        return None
    return {"tools": tools, "rows": rows,
            "titles": [_text(row.get("label")) for row in rows]}


def _common_stems(titles: List[str],
                  tokens_of: Callable[[str], List[str]],
                  stem_of: Callable[[str], str]) -> set:
    """Les stems présents dans au moins ``SUBTHEME_COMMON_RATIO`` des titres —
    le CONTEXTE du paquet (PUR).

    Compté par TITRE et non par occurrence : un titre qui répète « tariffs »
    trois fois ne vote qu'une fois. En dessous de trois titres, la notion n'a
    pas de sens (avec deux titres, tout mot commun serait « partagé par la
    moitié ») et on ne retire rien.
    """
    if len(titles) < 3:
        return set()
    counts: Dict[str, int] = {}
    for title in titles:
        for stem in {stem_of(t) for t in tokens_of(title) if stem_of(t)}:
            counts[stem] = counts.get(stem, 0) + 1
    threshold = SUBTHEME_COMMON_RATIO * len(titles)
    return {stem for stem, count in counts.items() if count >= threshold}


def _cluster(prepared: Dict[str, Any]) -> List[Dict[str, Any]]:
    """Le moteur du PREMIER étage (PUR) — cf. :func:`theme_clusters` pour les
    trois étapes. Le second étage a le sien (:func:`subtheme_clusters`), pour
    la raison mesurée qui y est écrite."""
    tokens_of, key_of, stem_of = prepared["tools"]
    rows = prepared["rows"]

    order = {_text(row.get("id")): i for i, row in enumerate(rows)}
    loose: List[str] = []                                  # feuilles sans histoire
    stories: Dict[str, Dict[str, Any]] = {}
    for row, title in zip(rows, prepared["titles"]):
        node_id = _text(row.get("id"))
        key = key_of(title) if title else ""
        if not key:
            loose.append(node_id)
            continue
        story = stories.setdefault(key, {"ids": [], "titles": []})
        if node_id not in story["ids"]:
            story["ids"].append(node_id)
        story["titles"].append(title)

    keys = sorted(stories)
    stems = {k: {stem_of(t) for title in stories[k]["titles"]
                 for t in tokens_of(title)} for k in keys}
    groups_of = _merge_stories(keys, stems)

    merged: Dict[str, Dict[str, Any]] = {}
    for key in keys:
        group = merged.setdefault(groups_of[key], {"ids": [], "titles": []})
        group["ids"].extend(stories[key]["ids"])
        group["titles"].extend(stories[key]["titles"])

    named: List[Dict[str, Any]] = []
    for key in sorted(merged):
        group = merged[key]
        if len(group["ids"]) < 2:
            loose.extend(group["ids"])              # une feuille seule n'est pas un sujet
            continue
        # Une clé d'histoire est faite de stems [a-z0-9] joints par « - » : elle
        # pourrait, une fois sur mille, valoir le mot du fourre-tout. On la
        # décale plutôt que de laisser deux thèmes se confondre à l'écran.
        public = (key + "-") if key == MISC_THEME_KEY else key
        label = _theme_label(group["titles"], tokens_of, stem_of)
        named.append({"key": public, "label": label or public,
                      "leaf_ids": sorted(group["ids"], key=lambda i: order[i])})

    named.sort(key=lambda c: (-len(c["leaf_ids"]), c["key"]))
    if loose:
        named.append({"key": MISC_THEME_KEY, "label": MISC_THEME_LABEL,
                      "leaf_ids": sorted(set(loose), key=lambda i: order[i])})
    return named


def _theme_node(host_id: str, family: str, cluster: Dict[str, Any]) -> Dict[str, Any]:
    """Le nœud intermédiaire d'un thème.

    Comme le pivot et l'agrégat, c'est un nœud de STRUCTURE : ni symbole, ni
    date — il ne représente aucun événement, il en rassemble plusieurs. Son
    identité tient à l'hôte ET à la famille en plus de la clé : deux rameaux
    différents peuvent parler du même sujet sans partager un nœud.
    """
    return {"id": _THEME_PREFIX + _hash("theme", host_id, family, cluster["key"]),
            "type": THEME_TYPE, "label": cluster["label"], "symbol": "", "ts": "",
            "meta": {"count": len(cluster["leaf_ids"]), "key": cluster["key"]}}


def _theme_layer(host_id: str, leaves: List[Dict[str, Any]]
                 ) -> Tuple[List[Dict[str, Any]], Dict[str, str]]:
    """``([nœuds thème], {id de feuille: id de thème})`` pour un hôte (PUR).

    Une famille de ``THEME_MIN_LEAVES`` feuilles ou moins reste À PLAT : un
    niveau de plus ne se justifie que quand l'œil ne suit plus. Et une famille
    où RIEN ne se groupe (que du fourre-tout) reste à plat aussi — un unique
    nœud « Divers » qui rassemble tout allonge le chemin sans rien répartir.

    Les familles sont traitées dans l'ordre de PREMIÈRE APPARITION des feuilles,
    qui arrivent déjà triées : la sortie ne dépend d'aucun dictionnaire.
    """
    order: List[str] = []
    by_family: Dict[str, List[Dict[str, Any]]] = {}
    for node in leaves:
        family = _family_of(node)
        if family not in by_family:
            by_family[family] = []
            order.append(family)
        by_family[family].append(node)

    themes: List[Dict[str, Any]] = []
    mapping: Dict[str, str] = {}
    for family in order:
        members = by_family[family]
        if len(members) <= THEME_MIN_LEAVES:
            continue
        clusters = theme_clusters(members)
        if not [c for c in clusters if c["key"] != MISC_THEME_KEY]:
            continue
        for cluster in clusters:
            node = _theme_node(host_id, family, cluster)
            themes.append(node)
            for leaf_id in cluster["leaf_ids"]:
                mapping[leaf_id] = node["id"]
    return themes, mapping


# --------------------------------------------------------------------------- #
# PUR — assemblage
# --------------------------------------------------------------------------- #

def _is_macro(node: Dict[str, Any]) -> bool:
    """Ce nœud parle-t-il du MONDE plutôt que d'un titre ? (annonce politique,
    actualité crypto, macroéconomie, écologie à impact — y compris quand elles
    arrivent par un post X, d'où le test sur la tonalité en plus du type)."""
    return node.get("type") in PIVOT_TYPES or _sentiment(node) == "gov"


def _pivot_node(pivot_id: str) -> Dict[str, Any]:
    return {"id": pivot_id, "type": CONTEXT_TYPE,
            "label": _PIVOT_LABELS.get(pivot_id, pivot_id),
            "symbol": "", "ts": ""}


def _aggregate_node(pivot_id: str, count: int) -> Dict[str, Any]:
    """« +N autres » — le reste d'un bosquet, en UN nœud.

    Il n'a pas d'horodatage : il ne représente aucun événement, il compte ce
    qu'on ne montre pas. C'est ce qui rend un débordement de bosquet HONNÊTE
    sans lever ``truncated`` : le lecteur voit qu'il y a plus.
    """
    return {"id": _AGGREGATE_PREFIX + pivot_id, "type": AGGREGATE_TYPE,
            "label": "+%d autres" % count, "symbol": "", "ts": "",
            "meta": {"count": count}}


def _edge_tone(node: Dict[str, Any]) -> str:
    """La tonalité qui a le droit de COLORER une arête.

    ``neutral`` n'en est pas une : une dépêche que le classifieur n'a pas su
    qualifier ne doit pas peindre son lien comme si elle disait quelque chose.
    L'arête sort alors sans ``sentiment`` — bordure neutre côté frontend.
    """
    tone = _text(node.get("sentiment"))
    return "" if tone.lower() == NEUTRAL_SENTIMENT else tone


def _context_edge(node: Dict[str, Any], pivot_id: str) -> Dict[str, Any]:
    """L'arête d'un satellite vers SON pivot — même forme que les autres pour
    que le frontend colore un lien de la même façon qu'il vienne d'une ancre ou
    d'un bosquet."""
    edge = {"source": node["id"], "target": pivot_id, "type": EDGE_CONTEXT}
    tone = _edge_tone(node)
    if tone:
        edge["sentiment"] = tone
    return edge


def _recency_key(node: Dict[str, Any]) -> Tuple[int, float, str]:
    """Du plus RÉCENT au plus ancien ; date illisible en dernier (on ne peut pas
    prétendre qu'elle est fraîche), puis l'identifiant pour que deux appels
    rendent exactement le même ordre.

    Le premier rang sépare « daté » de « non daté » plutôt que de s'en remettre
    à une valeur sentinelle : ``datetime.timestamp()`` lève sur les dates
    extrêmes, et un tri qui plante emporterait tout le graphe.
    """
    when = _parse_dt(node.get("ts"))
    if when is not None:
        try:
            return (0, -when.timestamp(), node["id"])
        except (OverflowError, OSError, ValueError):
            pass
    return (1, 0.0, node["id"])


def _radar_key(node: Dict[str, Any]) -> Tuple[Any, ...]:
    """Dans le bosquet du radar : les hypothèses OUVERTES d'abord (ce sont les
    paris encore en jeu), les notées ensuite, de la plus fraîche à la plus
    vieille."""
    return (0 if _text(node.get("status")) == "open" else 1,) + _recency_key(node)


_GROVE_KEYS: Dict[str, Callable[[Dict[str, Any]], Tuple[Any, ...]]] = {
    RADAR_ID: _radar_key,
}


def _grove(pivot_id: str, members: List[Dict[str, Any]]
           ) -> Tuple[List[Dict[str, Any]], List[Dict[str, Any]]]:
    """Un bosquet -> ``(nœuds, arêtes)``, sous-plafond appliqué (PUR).

    Les ``MAX_GROVE`` premiers selon la clé du bosquet, puis UN agrégat pour
    tout le reste. Un bosquet vide ne rend rien — donc pas de pivot, donc pas
    de nœud solitaire à l'écran.

    Quand une famille déborde (``_theme_layer``), ses satellites passent par un
    niveau de THÈMES : le satellite rejoint son thème, le thème rejoint le
    pivot. Les douze dessinés restent douze — le thème RÉPARTIT, il n'ajoute
    aucune feuille.
    """
    ordered = sorted(members, key=_GROVE_KEYS.get(pivot_id, _recency_key))
    shown = ordered[:MAX_GROVE]
    themes, theme_of = _theme_layer(pivot_id, shown)
    nodes = list(shown) + themes
    edges = [_context_edge(node, theme_of.get(node["id"], pivot_id))
             for node in shown]
    edges.extend([{"source": node["id"], "target": pivot_id, "type": EDGE_THEME}
                  for node in themes])
    extra = len(ordered) - len(shown)
    if extra > 0:
        aggregate = _aggregate_node(pivot_id, extra)
        nodes.append(aggregate)
        edges.append({"source": aggregate["id"], "target": pivot_id,
                      "type": EDGE_CONTEXT})
    return nodes, edges


def _assemble(anchor_nodes: List[Dict[str, Any]],
              info_nodes: List[Dict[str, Any]],
              edges: List[Dict[str, Any]],
              groves: Optional[Dict[str, List[Dict[str, Any]]]] = None
              ) -> Dict[str, Any]:
    """Applique les plafonds et recompose ``{nodes, edges, truncated}``.

    **Deux budgets, pas un.** Les bosquets (``groves`` = ``{pivot: membres}``)
    sont servis EN PREMIER, chacun dans sa propre limite de ``MAX_GROVE``, et ce
    qu'ils consomment ne se prend PAS sur les branches : un pivot ne peut donc
    plus expulser le sujet du graphe. Le débordement d'un bosquet devient un
    agrégat et ne lève PAS ``truncated`` — rien n'est perdu en silence.

    Ordre de coupe des branches ensuite : **toutes** les ancres d'abord (elles
    sont le sujet du graphe, jamais l'accessoire), puis les infos les plus
    récentes jusqu'au plafond, puis les arêtes qui relient ce qui reste. C'est
    là, et là seulement, que ``truncated`` se lève.

    Les pivots sont émis EN DERNIER, et seulement si une arête les vise encore
    APRÈS les deux coupes — un pivot solitaire ne dirait rien. Le décider avant
    laisserait un nœud orphelin le jour où le plafond d'arêtes mord là.

    Les arêtes de bosquet passent APRÈS celles des branches : quand le plafond
    d'arêtes mord, c'est le décor qui saute, jamais un lien vers une ancre.
    """
    grove_nodes: List[Dict[str, Any]] = []
    grove_edges: List[Dict[str, Any]] = []
    for pivot_id in PIVOT_IDS:
        nodes_, edges_ = _grove(pivot_id, (groves or {}).get(pivot_id) or [])
        grove_nodes.extend(nodes_)
        grove_edges.extend(edges_)

    truncated = False
    ordered = sorted(info_nodes, key=_recency_key)
    room = max(0, MAX_NODES - len(anchor_nodes))
    if len(ordered) > room:
        ordered = ordered[:room]
        truncated = True

    nodes = list(anchor_nodes) + ordered + grove_nodes
    # Les pivots sont admis d'office comme CIBLES : aucune arête n'en part
    # jamais (ils ne sont reliés qu'à leurs satellites), donc rien ne peut se
    # glisser par là.
    kept = {node["id"] for node in nodes} | set(PIVOT_IDS)

    out_edges = [edge for edge in list(edges) + grove_edges
                 if edge["source"] in kept and edge["target"] in kept]
    if len(out_edges) > MAX_EDGES:
        out_edges = out_edges[:MAX_EDGES]
        truncated = True
    targets = {edge["target"] for edge in out_edges}
    for pivot_id in PIVOT_IDS:
        if pivot_id in targets:
            nodes.append(_pivot_node(pivot_id))
    return {"nodes": nodes, "edges": out_edges, "truncated": truncated}


def _collect(anchors: Any, events: Any, hypotheses: Any, whale_moves: Any,
             pipeline: Any, now: Any, reddit_trends: Any
             ) -> Tuple[Dict[str, Dict[str, Any]], Dict[str, Dict[str, Any]],
                        List[Dict[str, Any]]]:
    """Le BALAYAGE, une seule fois pour tout le monde — ``(ancres, infos,
    arêtes)`` (PUR).

    C'est le corps historique de ``build_graph``, sorti tel quel pour que la
    liste complète d'un bosquet (``build_grove``) reparte des MÊMES faits, des
    mêmes fenêtres et du même rapprochement d'émetteurs que le dessin. Deux
    balayages parallèles finiraient par diverger — un item listé mais jamais
    dessiné, ou l'inverse — et c'est exactement le genre d'écart qu'un lecteur
    prendrait pour un bug de la mémoire.
    """
    now_dt = _parse_dt(now) or _now()
    cutoff = now_dt - timedelta(days=WINDOW_D)

    anchor_map = collect_anchors(anchors, pipeline)
    names = {sym: node["label"] for sym, node in anchor_map.items()}
    matcher = _default_matcher()

    info: Dict[str, Dict[str, Any]] = {}
    edges: List[Dict[str, Any]] = []
    seen_edges = set()

    def _add(node: Dict[str, Any], targets: List[str], edge_type: str) -> None:
        """Enregistre le nœud (le premier gagne — l'id est stable, donc c'est le
        même contenu) et tire une arête vers chaque ancre concernée."""
        node = info.setdefault(node["id"], node)
        for target in targets:
            key = (node["id"], target, edge_type)
            if key in seen_edges:
                continue
            seen_edges.add(key)
            edge = {"source": node["id"], "target": target, "type": edge_type}
            tone = _edge_tone(node)
            if tone:
                edge["sentiment"] = tone
            edges.append(edge)

    for event in _dicts(events):
        if not _within(event.get("ts"), cutoff):
            continue
        node = _event_node(event)
        _add(node, [node["symbol"]] if node["symbol"] in anchor_map else [],
             EDGE_SYMBOL)

    for hyp in _dicts(hypotheses):
        if not _keep_hypothesis(hyp, cutoff):
            continue
        _add(_hypothesis_node(hyp),
             [t for t in _tickers(hyp) if t in anchor_map], EDGE_TICKER)

    for move in _dicts(whale_moves):
        if not _within(move.get("fetched_at"), cutoff):
            continue
        matched = _whale_symbol(move, names, matcher)
        node = _whale_node(move)
        if matched:
            node["symbol"] = matched
        _add(node, [matched] if matched else [], EDGE_ISSUER)

    # Le bosquet de la foule. Chaque tendance rejoint TOUJOURS son pivot — un
    # ticker dont Reddit parle a sa place à l'écran même si le portefeuille ne
    # le connaît pas, c'est précisément là qu'on découvre un titre. L'arête
    # vers le pivot est posée par ``_grove`` (le bosquet possède ses liens,
    # comme les deux autres). Quand ce ticker EST une ancre, il gagne EN PLUS
    # une arête vers elle : il apparaît alors dans la branche de ce titre, à
    # côté des dépêches qui le concernent.
    for trend_symbol, count, prev in _trend_rows(reddit_trends):
        node = _trend_node(trend_symbol, count, prev)
        node = info.setdefault(node["id"], node)
        if trend_symbol in anchor_map:
            edges.append({"source": node["id"], "target": trend_symbol,
                          "type": EDGE_SYMBOL})

    return anchor_map, info, edges


def build_graph(anchors: Any, events: Any, hypotheses: Any, whale_moves: Any,
                pipeline: Any, now: Any = None,
                symbol: Any = None, reddit_trends: Any = None) -> Dict[str, Any]:
    """Le graphe des connexions (PUR) — ``{"nodes", "edges", "truncated"}``.

    Sans ``symbol`` : la vue GLOBALE — les ancres, tout ce qui s'y rattache, le
    pivot « monde » pour le macro qui ne nomme aucun titre, le pivot « foule »
    pour les tendances Reddit, et le pivot « radar » pour les hypothèses dont
    aucun ticker n'est ancré. Ce qui ne se rattache à rien est OMIS (un graphe
    montre des connexions).

    Avec ``symbol`` : la BRANCHE de ce titre — son ancre, ses voisins directs,
    et les arêtes entre eux uniquement. Les pivots n'y entrent jamais : ils
    ne sont reliés à aucune ancre, donc ils ne sont les voisins de personne. Un
    symbole qui n'est ni détenu, ni suivi, ni en projet n'a pas d'ancre : la
    branche est alors VIDE plutôt que d'inventer un centre que la mémoire ne
    porte pas.

    ``events`` = les dépêches de ``newswatch.recent_events`` (elles portent déjà
    leur symbole et leur tonalité), ``hypotheses`` = l'état du radar tel quel,
    ``whale_moves`` = ``whales.moves_summary``, ``pipeline`` = la vue « Plan »,
    ``reddit_trends`` = ``newswatch.recent_trends`` (``{SYM: {count, prev}}``).
    Chaque entrée est lue avec prudence : une liste absente vaut liste vide.
    """
    anchor_map, info, edges = _collect(anchors, events, hypotheses, whale_moves,
                                       pipeline, now, reddit_trends)
    wanted = _upper(symbol)
    if wanted:
        return _branch(anchor_map, info, edges, wanted)
    return _overview(anchor_map, info, edges)


def build_grove(kind: Any, anchors: Any, events: Any, hypotheses: Any,
                whale_moves: Any, pipeline: Any, now: Any = None,
                reddit_trends: Any = None) -> Dict[str, Any]:
    """TOUT un bosquet (PUR) — ``{"kind", "items", "total"}``.

    Ce que le dessin ne montre PAS. Le graphe plafonne chaque bosquet à
    ``MAX_GROVE`` satellites et résume le reste en « +N autres » ; ici on rend
    la liste ENTIÈRE de ce même bosquet, dans le MÊME ordre (la clé de tri du
    bosquet : les hypothèses ouvertes d'abord au radar, la fraîcheur partout
    ailleurs). Les items sont les nœuds tels quels — ils portent déjà leur date,
    leur libellé, leur tonalité, leur lien et leur ``meta``.

    ``total`` est le nombre RÉEL de membres, avant le plafond de liste : quand
    ``len(items) < total``, la mémoire en garde davantage et le dit.

    ``kind`` doit être l'un de ``GROVE_KINDS`` — un bosquet inconnu lève
    ``ValueError`` plutôt que de rendre une liste vide qui se lirait « il n'y a
    rien » alors qu'on a simplement mal demandé.

    Chaque item porte en plus son ``theme_key``/``theme_label`` et la liste est
    RANGÉE par thème (cf. ``_grove_themed``). Le clustering tourne ici sur la
    liste ENTIÈRE, alors que le dessin ne voit que ses douze : les thèmes de la
    liste sont donc plus riches que ceux de la toile, et c'est voulu — c'est
    justement en ouvrant qu'on veut voir la répartition.

    Un thème qui déborde à son tour porte un SECOND étage (``subtheme_label``,
    cf. ``subtheme_clusters``) — présent seulement là où il veut dire quelque
    chose. Le DESSIN, lui, n'en sait rien : la toile garde ses thèmes de
    premier niveau, le second étage est une affaire de liste.
    """
    wanted = _text(kind).lower()
    if wanted not in GROVE_KINDS:
        raise ValueError("bosquet inconnu: %s" % _text(kind))
    _, info, edges = _collect(anchors, events, hypotheses, whale_moves,
                              pipeline, now, reddit_trends)
    _, groves = _dispatch(info, edges)
    members = sorted(groves.get(wanted) or [],
                     key=_GROVE_KEYS.get(wanted, _recency_key))
    return {"kind": wanted, "items": _grove_themed(members)[:GROVE_LIST_CAP],
            "total": len(members)}


def _grove_themed(members: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Les membres d'un bosquet, chacun portant son thème, RANGÉS par thème (PUR).

    L'ordre : les thèmes dans celui que ``theme_clusters`` a fixé (les nommés du
    plus gros au plus petit, le fourre-tout en dernier), et DANS un thème,
    l'ordre du bosquet lui-même — celui du dessin, donc la fraîcheur partout et
    les hypothèses ouvertes d'abord au radar. Reprendre un tri par date ici
    ferait diverger la liste du dessin sur le seul bosquet où l'ordre dit
    quelque chose.

    Quand RIEN ne se groupe (que du fourre-tout, ou pas de ``newswatch``), les
    membres ressortent tels quels, SANS champ de thème : le frontend affiche
    alors une liste à plat, plutôt qu'un unique intertitre « Divers » qui ne
    répartit rien.

    Un thème qui DÉBORDE à son tour (plus de ``SUBTHEME_MIN_LEAVES`` items)
    gagne un second étage : ses items portent en plus ``subtheme_label`` et
    sont rangés par sous-sujet. Le sous-fourre-tout ne porte AUCUN champ de
    sous-thème — « sans sous-sujet » se dit par l'absence, jamais par un
    intertitre « Divers » de plus — et ses items ferment le thème.

    Les items sont des COPIES : le nœud du dessin n'est pas touché.
    """
    clusters = theme_clusters(members)
    if not [c for c in clusters if c["key"] != MISC_THEME_KEY]:
        return list(members)

    out: List[Dict[str, Any]] = []
    placed = set()
    for cluster in clusters:
        rows = _members_of(members, cluster["leaf_ids"], placed)
        for node, sub in _with_subthemes(cluster, rows):
            placed.add(_text(node.get("id")))
            item = dict(node, theme_key=cluster["key"],
                        theme_label=cluster["label"])
            if sub is not None:
                # Le LIBELLÉ seul, et pas de clé : à ce niveau le nom EST
                # l'identité (un sous-sujet = un mot), et deux identités pour
                # un même groupe finiraient par diverger. L'absence du champ
                # dit « sans sous-sujet », comme au niveau du dessus.
                item["subtheme_label"] = sub["label"]
            out.append(item)
    # Ceinture : une feuille qu'aucun thème n'a réclamée (identifiant vide) ne
    # doit pas disparaître de la liste — on la rend telle quelle, à la fin.
    out.extend([dict(node) for node in members
                if _text(node.get("id")) not in placed])
    return out


def _members_of(members: List[Dict[str, Any]], leaf_ids: List[str],
                placed: set) -> List[Dict[str, Any]]:
    """Les membres d'un cluster, dans l'ordre DU BOSQUET (celui du dessin) et
    sans redite."""
    wanted = set(leaf_ids)
    return [node for node in members
            if _text(node.get("id")) in wanted
            and _text(node.get("id")) not in placed]


def _label_tokens(label: Any) -> List[str]:
    """Les mots d'un nom de thème (« Canada · Tariffs » -> [canada, tariffs]).

    C'est ce que l'appelant sait du parent quand il redescend d'un étage : les
    mots qui l'ont nommé sont, par construction, ceux que tous ses membres
    partagent.
    """
    return [w for w in _text(label).lower().replace("·", " ").split() if w]


def _with_subthemes(cluster: Dict[str, Any], rows: List[Dict[str, Any]]
                    ) -> List[Tuple[Dict[str, Any], Optional[Dict[str, Any]]]]:
    """``[(membre, sous-thème ou None)]`` — le second étage d'UN thème (PUR).

    Trois portes, et il faut les trois : le thème n'est pas le fourre-tout (un
    reste n'a pas de sous-sujets), il DÉBORDE (``SUBTHEME_MIN_LEAVES``), et le
    découpage produit au moins ``SUBTHEME_MIN_CLUSTERS`` sous-sujets nommés.
    Sinon les membres ressortent dans l'ordre du bosquet, sans second étage —
    règle « pas de niveau inutile ».
    """
    if (cluster["key"] == MISC_THEME_KEY
            or len(rows) <= SUBTHEME_MIN_LEAVES):
        return [(node, None) for node in rows]

    subs = subtheme_clusters(rows, _label_tokens(cluster["label"]))
    named = [c for c in subs if c["key"] != MISC_THEME_KEY]
    if len(named) < SUBTHEME_MIN_CLUSTERS:
        return [(node, None) for node in rows]

    out: List[Tuple[Dict[str, Any], Optional[Dict[str, Any]]]] = []
    seen: set = set()
    for sub in named:
        for node in _members_of(rows, sub["leaf_ids"], seen):
            seen.add(_text(node.get("id")))
            out.append((node, sub))
    # Le sous-fourre-tout ferme le thème, SANS champ de sous-sujet.
    out.extend([(node, None) for node in rows
                if _text(node.get("id")) not in seen])
    return out


def _branch(anchor_map: Dict[str, Dict[str, Any]],
            info: Dict[str, Dict[str, Any]],
            edges: List[Dict[str, Any]], wanted: str) -> Dict[str, Any]:
    """La branche d'un titre : son ancre et ses voisins DIRECTS.

    Quand une famille de voisins déborde, un niveau de THÈMES s'intercale :
    l'arête du voisin est RE-ROUTÉE vers son thème (elle garde son mécanisme et
    sa tonalité — c'est elle qui colore le lien), et le thème rejoint l'ancre.
    Aucune arête ne pend : ce qui n'entre dans aucun thème garde son lien direct.
    """
    anchor = anchor_map.get(wanted)
    if anchor is None:
        return {"nodes": [], "edges": [], "truncated": False}
    kept_edges = [edge for edge in edges if edge["target"] == wanted]
    neighbours: List[Dict[str, Any]] = []
    seen = set()
    for edge in kept_edges:
        node = info.get(edge["source"])
        if node is None or node["id"] in seen:
            continue
        seen.add(node["id"])
        neighbours.append(node)

    themes, theme_of = _theme_layer(wanted, neighbours)
    if themes:
        kept_edges = [dict(edge, target=theme_of[edge["source"]])
                      if edge["source"] in theme_of else edge
                      for edge in kept_edges]
        kept_edges.extend([{"source": node["id"], "target": wanted,
                            "type": EDGE_THEME} for node in themes])
        neighbours = neighbours + themes
    return _assemble([anchor], neighbours, kept_edges)


def _dispatch(info: Dict[str, Dict[str, Any]], edges: List[Dict[str, Any]]
              ) -> Tuple[List[Dict[str, Any]],
                         Dict[str, List[Dict[str, Any]]]]:
    """Range chaque nœud d'info — ``(branches, {pivot: membres})`` (PUR).

    Le tri, dans CET ordre :

    1. une **tendance Reddit** va toujours au bosquet « foule », même quand
       elle touche une ancre — elle garde alors EN PLUS son arête vers ce
       titre (elle est comptée une fois, dans le bosquet) ;
    2. tout ce qui **touche une ancre** est une branche : c'est le sujet ;
    3. le **macro** orphelin (politique, crypto) va au bosquet « monde » ;
    4. une **hypothèse** dont aucun ticker n'est ancré va au bosquet
       « radar » — le pari existe, il doit se voir (« Canada invisible ») ;
    5. le reste est OMIS : une dépêche d'entreprise qu'on ne sait rattacher à
       rien de ce portefeuille n'est pas une connexion.

    Sorti de ``_overview`` pour que la LISTE d'un bosquet (``build_grove``) le
    compose exactement comme le DESSIN : un item qui apparaîtrait dans l'une et
    pas dans l'autre passerait pour une perte de mémoire.
    """
    linked = {edge["source"] for edge in edges}
    kept: List[Dict[str, Any]] = []
    groves: Dict[str, List[Dict[str, Any]]] = {pid: [] for pid in PIVOT_IDS}
    for node in info.values():
        if node["type"] == TREND_TYPE:
            groves[CROWD_ID].append(node)
        elif node["id"] in linked:
            kept.append(node)
        elif _is_macro(node):
            groves[WORLD_ID].append(node)
        elif node["type"] == "hypothesis":
            groves[RADAR_ID].append(node)
    return kept, groves


def _overview(anchor_map: Dict[str, Dict[str, Any]],
              info: Dict[str, Dict[str, Any]],
              edges: List[Dict[str, Any]]) -> Dict[str, Any]:
    """La vue globale : les ancres, leurs infos, et les trois bosquets."""
    kept, groves = _dispatch(info, edges)
    return _assemble(list(anchor_map.values()), kept, edges, groves)
