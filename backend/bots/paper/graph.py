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

Trois règles qui tiennent le graphe honnête :

1. **Aucun lien inventé.** Un rapprochement se fait sur un symbole, un ticker
   ou un nom d'émetteur rapproché par ``whales.match_issuer`` — jamais sur une
   intuition. Ce qui ne se rattache à rien de connu n'est pas rattaché.
2. **Un graphe montre des connexions, pas un dépotoir.** Une info qui ne
   touche aucune ancre est OMISE de la vue globale. Deux exceptions, et deux
   seulement : le macro (annonce politique, actualité crypto sans titre nommé)
   rejoint un pivot unique « monde » ; les tendances Reddit rejoignent un
   second pivot « foule ». Ni l'un ni l'autre n'est relié à une ancre — donc
   aucun des deux n'apparaît dans une branche par titre.
3. **Les ancres ne se coupent jamais.** Quand le plafond mord, on garde toutes
   les ancres et on sacrifie les infos les plus VIEILLES ; le retour porte
   alors ``truncated: True``, jamais un silence.

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
INFO_TYPES = ("news", "catalyst", "gov", "crypto", "x", "reddit", "hypothesis",
              "whale_move", "reddit_trend")

# Les deux pivots — reliés à RIEN d'autre que leurs satellites.
CONTEXT_TYPE = "context"
WORLD_ID = "monde"
WORLD_LABEL = "Monde"
CROWD_ID = "foule"
CROWD_LABEL = "Foule Reddit"

# Les familles qui ont droit au pivot « monde » quand elles ne nomment aucun
# titre. Une dépêche d'entreprise orpheline, elle, est simplement omise : on ne
# sait pas de quoi elle parle pour CE portefeuille. Un post Reddit orphelin
# suit la même règle — il n'est pas du macro, il parle d'un titre qu'on ne
# suit pas.
PIVOT_TYPES = ("gov", "crypto")

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
    parle de politique — le frontend doit pouvoir le montrer comme tel. La
    tonalité ensuite : ``gov`` (annonce politique), ``watch`` (catalyseur à
    venir), le reste étant de la dépêche.
    """
    src = _text(event.get("src")).lower()
    if src in ("x", "crypto", "reddit"):
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
    elle a été écrite il y a trois semaines."""
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
# PUR — assemblage
# --------------------------------------------------------------------------- #

def _is_macro(node: Dict[str, Any]) -> bool:
    """Ce nœud parle-t-il du MONDE plutôt que d'un titre ? (annonce politique,
    actualité crypto — y compris quand elle arrive par un post X, d'où le test
    sur la tonalité en plus du type)."""
    return node.get("type") in PIVOT_TYPES or _sentiment(node) == "gov"


def _world_node() -> Dict[str, Any]:
    return {"id": WORLD_ID, "type": CONTEXT_TYPE, "label": WORLD_LABEL,
            "symbol": "", "ts": ""}


def _crowd_node() -> Dict[str, Any]:
    return {"id": CROWD_ID, "type": CONTEXT_TYPE, "label": CROWD_LABEL,
            "symbol": "", "ts": ""}


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


def _assemble(anchor_nodes: List[Dict[str, Any]],
              info_nodes: List[Dict[str, Any]],
              edges: List[Dict[str, Any]]) -> Dict[str, Any]:
    """Applique les plafonds et recompose ``{nodes, edges, truncated}``.

    Ordre de coupe : **toutes** les ancres d'abord (elles sont le sujet du
    graphe, jamais l'accessoire), puis les infos les plus récentes jusqu'au
    plafond, puis les arêtes qui relient ce qui reste.

    Les deux pivots (« monde », « foule ») sont émis EN DERNIER, et seulement
    si une arête les vise encore APRÈS les deux coupes — un pivot solitaire ne
    dirait rien. Le décider avant laisserait un nœud orphelin le jour où le
    plafond d'arêtes mord précisément là.
    """
    truncated = False
    ordered = sorted(info_nodes, key=_recency_key)
    room = max(0, MAX_NODES - len(anchor_nodes))
    if len(ordered) > room:
        ordered = ordered[:room]
        truncated = True

    nodes = list(anchor_nodes) + ordered
    # Les pivots sont admis d'office comme CIBLES : aucune arête n'en part
    # jamais (ils ne sont reliés qu'à leurs satellites), donc rien ne peut se
    # glisser par là.
    kept = {node["id"] for node in nodes} | {WORLD_ID, CROWD_ID}

    out_edges = [edge for edge in edges
                 if edge["source"] in kept and edge["target"] in kept]
    if len(out_edges) > MAX_EDGES:
        out_edges = out_edges[:MAX_EDGES]
        truncated = True
    targets = {edge["target"] for edge in out_edges}
    if WORLD_ID in targets:
        nodes.append(_world_node())
    if CROWD_ID in targets:
        nodes.append(_crowd_node())
    return {"nodes": nodes, "edges": out_edges, "truncated": truncated}


def build_graph(anchors: Any, events: Any, hypotheses: Any, whale_moves: Any,
                pipeline: Any, now: Any = None,
                symbol: Any = None, reddit_trends: Any = None) -> Dict[str, Any]:
    """Le graphe des connexions (PUR) — ``{"nodes", "edges", "truncated"}``.

    Sans ``symbol`` : la vue GLOBALE — les ancres, tout ce qui s'y rattache, le
    pivot « monde » pour le macro qui ne nomme aucun titre, et le pivot
    « foule » pour les tendances Reddit. Ce qui ne se rattache à rien est OMIS
    (un graphe montre des connexions).

    Avec ``symbol`` : la BRANCHE de ce titre — son ancre, ses voisins directs,
    et les arêtes entre eux uniquement. Les deux pivots n'y entrent jamais : ils
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
            tone = _text(node.get("sentiment"))
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
    # le connaît pas, c'est précisément là qu'on découvre un titre. Et quand ce
    # ticker EST une ancre, il gagne EN PLUS une arête vers elle : il apparaît
    # alors dans la branche de ce titre, à côté des dépêches qui le concernent.
    for trend_symbol, count, prev in _trend_rows(reddit_trends):
        node = _trend_node(trend_symbol, count, prev)
        node = info.setdefault(node["id"], node)
        edges.append({"source": node["id"], "target": CROWD_ID,
                      "type": EDGE_CONTEXT})
        if trend_symbol in anchor_map:
            edges.append({"source": node["id"], "target": trend_symbol,
                          "type": EDGE_SYMBOL})

    wanted = _upper(symbol)
    if wanted:
        return _branch(anchor_map, info, edges, wanted)
    return _overview(anchor_map, info, edges)


def _branch(anchor_map: Dict[str, Dict[str, Any]],
            info: Dict[str, Dict[str, Any]],
            edges: List[Dict[str, Any]], wanted: str) -> Dict[str, Any]:
    """La branche d'un titre : son ancre et ses voisins DIRECTS."""
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
    return _assemble([anchor], neighbours, kept_edges)


def _overview(anchor_map: Dict[str, Dict[str, Any]],
              info: Dict[str, Dict[str, Any]],
              edges: List[Dict[str, Any]]) -> Dict[str, Any]:
    """La vue globale : les ancres, leurs infos, et le pivot du macro."""
    linked = {edge["source"] for edge in edges}
    kept: List[Dict[str, Any]] = []
    all_edges = list(edges)
    for node in info.values():
        if node["id"] in linked:
            kept.append(node)
            continue
        if not _is_macro(node):
            continue                    # orphelin : omis, ce n'est pas un lien
        kept.append(node)
        edge = {"source": node["id"], "target": WORLD_ID, "type": EDGE_CONTEXT}
        tone = _text(node.get("sentiment"))
        if tone:
            # Même forme que les autres arêtes : le frontend colore un lien de
            # la même façon qu'il vienne d'une ancre ou du pivot.
            edge["sentiment"] = tone
        all_edges.append(edge)
    return _assemble(list(anchor_map.values()), kept, all_edges)
