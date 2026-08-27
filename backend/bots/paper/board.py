"""La vue « Plan » — pipeline d'achats, progression, arbres de scénarios.

Trois mémoires dans UN fichier par utilisateur, ``data/paper_trading/<user>.board.json`` :

  - ``pipeline``  : les futurs achats, de l'étude à la position clôturée ;
  - ``scenarios`` : les chemins que le coach imagine pour le marché (arbres) ;
  - (la progression d'apprentissage n'est PAS stockée ici — elle est
    RECALCULÉE depuis le profil coach et les trades, cf. ``learning_summary``.)

**L'invariant du tableau : il ne peut pas mentir.** Un item de pipeline ne
porte qu'UN état déclaré à la main (``etude`` / ``pret``) ; les trois autres
(``ordre`` / ``position`` / ``clos``) sont DÉRIVÉS du portefeuille à chaque
lecture, jamais stockés. Un état stocké dériverait du réel au premier ordre
passé ailleurs que par ce tableau — et un tableau de suivi qui ment est pire
que pas de tableau. C'est la même leçon que le piège #59 du dépôt : quand la
mesure au sol contredit l'état déclaré, c'est le sol qui a raison.

I/O : le chemin délègue à ``store.portfolio_path()`` (validation du nom
d'utilisateur ET résolution du dossier — reste valide quand les tests
monkeypatchent ``store.DATA_DIR``). Écriture ATOMIQUE 0o600, le temporaire
NAÎT en 0o600 via ``os.open`` (jamais ``open()`` puis ``chmod()``, qui
laisserait une fenêtre world-readable). Lecture tolérante : absent -> tableau
vierge ; corrompu -> tableau vierge + fichier renommé ``.corrupt`` (on garde la
trace du bug sans perdre la capacité de tourner). Même patron que
``newswatch._save_seen_state``.

⚠️ Le fichier s'appelle ``<user>.board.json`` : le point dans le radical le
sort du glob des comptes (``radar._USER_FILE_RE``) et le fait rejeter par
``store.portfolio_path`` côté newswatch — sans quoi il fabriquerait un
utilisateur FANTÔME (cf. la note de ``radar._NON_USER_FILES``). Deux tests
verrouillent ce point, un par veilleur.
"""
import json
import os
import uuid
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional

from backend.bots.paper import risk, store, tradestats

# --------------------------------------------------------------------------- #
# Contrat
# --------------------------------------------------------------------------- #

# Les deux étapes que Massii déclare lui-même…
MANUAL_STAGES = ("etude", "pret")
# …et la chaîne complète, dont les trois dernières sont DÉRIVÉES du portefeuille.
STAGES = ("etude", "pret", "ordre", "position", "clos")

PIPELINE_SOURCES = ("moi", "coach")
DEFAULT_SOURCE = "moi"

# Un pipeline est une file de travail, pas une archive : au-delà, les items
# CLOS (la boucle est bouclée, la leçon est au carnet) sont purgés en premier.
MAX_PIPELINE = 40

# Trois arbres actifs : au-delà on ne raisonne plus, on collectionne.
MAX_ACTIVE_TREES = 3
MAX_ARCHIVED_TREES = 10

# Un arbre : 2 à 4 chemins DIVERGENTS, deux niveaux au maximum. Trois niveaux
# ne se lisent plus à l'écran et ne se jugent plus honnêtement.
MIN_BRANCHES = 2
MAX_BRANCHES = 4
MAX_DEPTH = 2
MAX_PLAYS = 2

BRANCH_PROBS = ("faible", "moyenne", "haute")
DEFAULT_PROB = "moyenne"
# Une branche naît OUVERTE ; seul un fait la referme.
BRANCH_STATUSES = ("open", "happened", "invalidated")
RESOLVABLE_STATUSES = ("happened", "invalidated")
PLAY_DIRECTIONS = ("up", "down")

TREE_STATUSES = ("active", "archived")


# --------------------------------------------------------------------------- #
# Helpers internes
# --------------------------------------------------------------------------- #

def _new_id() -> str:
    """Identifiant court (8 hex) — même forme que les hypothèses du radar."""
    return uuid.uuid4().hex[:8]


def _text(value: Any, cap: int = 400) -> str:
    """Texte nettoyé et borné (un LLM bavard ne doit pas gonfler le fichier)."""
    if value is None:
        return ""
    out = value if isinstance(value, str) else str(value)
    return out.strip()[:cap]


def _dicts(items: Any) -> List[Dict[str, Any]]:
    """Ne garde que les entrées exploitables d'une liste persistée."""
    if not isinstance(items, list):
        return []
    return [item for item in items if isinstance(item, dict)]


def _parse_iso(value: Any) -> Optional[datetime]:
    """Horodatage ISO -> ``datetime`` NAÏF, ou ``None`` si illisible.

    Même lecture « heure au mur » que ``risk._parse_iso`` : le suffixe ``Z`` et
    tout décalage horaire sont RETIRÉS (pas convertis) — comparer un datetime
    avec fuseau à un datetime sans fuseau lève un ``TypeError``.
    """
    if not isinstance(value, str):
        return None
    text = value.strip()
    if not text:
        return None
    if text[-1] in ("Z", "z"):
        text = text[:-1]
    try:
        parsed = datetime.fromisoformat(text)
    except (TypeError, ValueError):
        return None
    if parsed.tzinfo is not None:
        parsed = parsed.replace(tzinfo=None)
    return parsed


def _symbol(value: Any) -> str:
    """Symbole normalisé pour comparaison — MAJUSCULES, sans espaces.

    Toute comparaison de symboles du module passe par ici : Yahoo écrit
    ``NESN.SW``, le LLM écrit parfois ``nesn.sw``, et deux items pour le même
    titre casseraient le dédoublonnage sans cette normalisation.
    """
    return str(value or "").strip().upper()


def _float(value: Any) -> Optional[float]:
    if value is None or isinstance(value, bool):
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


# --------------------------------------------------------------------------- #
# I/O — <user>.board.json
# --------------------------------------------------------------------------- #

def board_path(username: str) -> Path:
    """Chemin du tableau de bord, dans le MÊME dossier que les portefeuilles.

    Délègue à ``store.portfolio_path()`` pour la validation du nom
    d'utilisateur (lève ``ValueError`` si invalide) ET la résolution du dossier
    — reste donc valide quand ``store.DATA_DIR`` est monkeypatché, ce que font
    tous les tests. Même patron que ``newswatch._news_seen_path``.
    """
    portfolio_p = store.portfolio_path(username)
    return portfolio_p.parent / ("%s.board.json" % username)


def blank_board() -> Dict[str, Any]:
    """Tableau vierge — la forme est le contrat, elle ne varie jamais."""
    return {"pipeline": [], "scenarios": []}


def load_board(username: str) -> Dict[str, Any]:
    """Charge le tableau. Absent -> vierge. Corrompu -> vierge, et le fichier
    fautif est renommé ``.corrupt`` (même convention que ``store._load_json``)."""
    path = board_path(username)
    if not path.is_file():
        return blank_board()
    try:
        with open(str(path), "r", encoding="utf-8") as handle:
            data = json.load(handle)
    except (OSError, ValueError):
        try:
            os.replace(str(path), str(path.parent / (path.name + ".corrupt")))
        except OSError:
            pass
        return blank_board()
    if not isinstance(data, dict):
        return blank_board()
    return {
        "pipeline": _dicts(data.get("pipeline")),
        "scenarios": _dicts(data.get("scenarios")),
    }


def save_board(username: str, data: Dict[str, Any]) -> None:
    """Persiste le tableau de façon ATOMIQUE et 0o600 (le temporaire naît en
    0o600 via ``os.open`` — pas de fenêtre world-readable, patron obligatoire
    du dépôt)."""
    path = board_path(username)
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "pipeline": _dicts((data or {}).get("pipeline")),
        "scenarios": _dicts((data or {}).get("scenarios")),
    }
    tmp_path = path.parent / (".%s.tmp-%d" % (path.name, os.getpid()))
    fd = os.open(str(tmp_path), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    try:
        os.fchmod(fd, 0o600)
    except (AttributeError, OSError):
        pass
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(payload, handle, ensure_ascii=False, indent=2)
        os.replace(str(tmp_path), str(path))
    except Exception:
        try:
            os.remove(str(tmp_path))
        except OSError:
            pass
        raise


# --------------------------------------------------------------------------- #
# PUR — l'étape RÉELLE d'un item (dérivée du portefeuille)
# --------------------------------------------------------------------------- #

def _holds_symbol(rows: Any, symbol: str) -> bool:
    """Le symbole figure-t-il dans cette liste (ordres ou positions) ?"""
    for row in _dicts(rows):
        if _symbol(row.get("symbol")) == symbol:
            return True
    return False


def _closing_trade(item: Optional[Dict[str, Any]],
                   portfolio: Optional[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    """Le trade CLÔTURÉ le plus récent qui referme la boucle de cet item.

    « Qui referme la boucle » = même symbole ET postérieur à la création de
    l'item : un trade d'il y a six mois sur le même titre ne dit RIEN d'une
    idée notée ce matin.

    Dates : on lit ``exit_at`` (la clôture) avec repli sur ``entry_at``. Un
    trade dont aucune date n'est lisible est écarté — on ne peut pas prouver
    qu'il est postérieur, et marquer « clos » à tort viderait l'item de la file
    de travail. À l'inverse, un item dont le ``created_at`` est illisible
    accepte n'importe quel trade : l'item est déjà abîmé, montrer la boucle
    fermée reste plus utile que de le laisser éternellement « à l'étude ».
    """
    symbol = _symbol((item or {}).get("symbol"))
    if not symbol:
        return None
    since = _parse_iso((item or {}).get("created_at"))

    best: Optional[Dict[str, Any]] = None
    best_dt: Optional[datetime] = None
    for trade in _dicts((portfolio or {}).get("trades")):
        if _symbol(trade.get("symbol")) != symbol:
            continue
        moment = _parse_iso(trade.get("exit_at")) or _parse_iso(trade.get("entry_at"))
        if moment is None:
            continue
        if since is not None and moment < since:
            continue
        # `>=` : à égalité de date, le DERNIER de la liste gagne (ordre
        # d'écriture du portefeuille = ordre chronologique réel).
        if best_dt is None or moment >= best_dt:
            best, best_dt = trade, moment
    return best


def computed_stage(item: Optional[Dict[str, Any]],
                   portfolio: Optional[Dict[str, Any]]) -> str:
    """L'étape RÉELLE d'un item de pipeline (PUR).

    Ordre de priorité, du plus engageant au moins engageant :
    ``ordre`` (le symbole est dans ``open_orders``) > ``position`` (dans
    ``positions``) > ``clos`` (un trade clôturé postérieur à la création) >
    l'étape déclarée à la main (``stage_manual``, ``etude`` par défaut).

    Un ordre annulé n'est plus dans ``open_orders`` (le router l'en retire à
    l'annulation) : l'item retombe donc de lui-même à son étape déclarée.
    """
    row = item if isinstance(item, dict) else {}
    symbol = _symbol(row.get("symbol"))
    manual = str(row.get("stage_manual") or "").strip().lower()
    if manual not in MANUAL_STAGES:
        manual = MANUAL_STAGES[0]
    if not symbol:
        return manual

    pf = portfolio if isinstance(portfolio, dict) else {}
    if _holds_symbol(pf.get("open_orders"), symbol):
        return "ordre"
    if _holds_symbol(pf.get("positions"), symbol):
        return "position"
    if _closing_trade(row, pf) is not None:
        return "clos"
    return manual


def pipeline_view(items: Any, portfolio: Optional[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Les items enrichis de ce que le portefeuille SAIT (PUR) :
    ``computed_stage`` et, quand la boucle est fermée, ``last_r`` — le R
    multiple du dernier trade concerné (``None`` si aucun stop n'avait été
    planifié : la métrique n'a alors aucun sens, cf. ``risk.r_multiple``)."""
    pf = portfolio if isinstance(portfolio, dict) else {}
    out: List[Dict[str, Any]] = []
    for item in _dicts(items):
        stage = computed_stage(item, pf)
        last_r = None
        if stage == "clos":
            trade = _closing_trade(item, pf)
            if trade is not None:
                last_r = _float(trade.get("r_multiple"))
        row = dict(item)
        row["computed_stage"] = stage
        row["last_r"] = last_r
        out.append(row)
    return out


# --------------------------------------------------------------------------- #
# Pipeline — écriture
# --------------------------------------------------------------------------- #

def _sort_key(item: Dict[str, Any]) -> str:
    """Clé de tri chronologique. Une date illisible trie en TÊTE (donc purgée
    en premier) : un item sans date de naissance est déjà un item abîmé."""
    return str(item.get("created_at") or "")


def _purge_to_cap(items: List[Dict[str, Any]],
                  portfolio: Optional[Dict[str, Any]],
                  cap: int = MAX_PIPELINE) -> None:
    """Fait de la place pour UN item de plus, en place.

    Purge d'abord les CLOS les plus anciens (leur boucle est bouclée). S'il
    n'en reste plus, purge le plus ancien tout court — le cap est une borne
    dure : sans ce repli, un pipeline de 40 items tous actifs refuserait
    silencieusement toute nouvelle idée.
    """
    while len(items) >= cap and items:
        closed = [row for row in items if computed_stage(row, portfolio) == "clos"]
        victim = min(closed or items, key=_sort_key)
        items.remove(victim)


def add_pipeline_item(username: str, symbol: str, thesis: str = "",
                      source: str = DEFAULT_SOURCE,
                      name: Optional[str] = None,
                      now_iso: Optional[str] = None) -> Dict[str, Any]:
    """Ajoute un futur achat au pipeline (ou rend l'existant).

    **Dédoublonnage par symbole ACTIF** : si le même titre est déjà suivi et
    que son étape réelle n'est pas ``clos``, on ne double PAS — on rend l'item
    existant marqué ``duplicate: True``. Un titre déjà tradé ET refermé, lui,
    peut légitimement revenir : c'est une nouvelle idée sur le même titre.

    C'est ce dédoublonnage qui permet au coach d'écrire dans le tableau sans
    le noyer : ``/ideas`` peut reproposer AAPL trois jours de suite, il n'y
    aura qu'une ligne.
    """
    ticker = _symbol(symbol)
    if not ticker:
        raise ValueError("symbole manquant")
    src = str(source or "").strip().lower()
    if src not in PIPELINE_SOURCES:
        src = DEFAULT_SOURCE

    data = load_board(username)
    items = data["pipeline"]
    # Le portefeuille est la SOURCE des trois étapes dérivées : sans lui, le
    # dédoublonnage ne saurait pas distinguer un titre encore en cours d'un
    # titre déjà refermé (et refuserait une idée légitime).
    portfolio = store.load_portfolio(username)
    if not isinstance(portfolio, dict):
        portfolio = {}

    for existing in items:
        if _symbol(existing.get("symbol")) != ticker:
            continue
        if computed_stage(existing, portfolio) != "clos":
            row = dict(existing)
            row["duplicate"] = True
            return row

    _purge_to_cap(items, portfolio)
    item = {
        "id": _new_id(),
        "symbol": ticker,
        "name": _text(name, cap=120),
        "thesis": _text(thesis),
        "source": src,
        "stage_manual": MANUAL_STAGES[0],
        "created_at": now_iso or datetime.now().isoformat(timespec="seconds"),
    }
    items.append(item)
    save_board(username, data)
    row = dict(item)
    row["duplicate"] = False
    return row


def set_stage(username: str, item_id: str, stage_manual: str) -> Optional[Dict[str, Any]]:
    """Change l'étape DÉCLARÉE d'un item (``etude`` <-> ``pret``).

    Lève ``ValueError`` sur une étape hors des deux manuelles : les trois
    autres se MÉRITENT (un ordre passé, une position ouverte, un trade clos),
    elles ne se déclarent pas — les accepter ici rendrait le tableau menteur.
    Rend ``None`` si l'item n'existe pas.
    """
    stage = str(stage_manual or "").strip().lower()
    if stage not in MANUAL_STAGES:
        raise ValueError("étape manuelle inconnue: %r" % (stage_manual,))
    wanted = str(item_id or "").strip()

    data = load_board(username)
    for item in data["pipeline"]:
        if str(item.get("id") or "") == wanted:
            item["stage_manual"] = stage
            save_board(username, data)
            return item
    return None


def remove_pipeline_item(username: str, item_id: str) -> bool:
    """Retire un item du pipeline. ``False`` s'il n'y était pas."""
    wanted = str(item_id or "").strip()
    data = load_board(username)
    items = data["pipeline"]
    remaining = [row for row in items if str(row.get("id") or "") != wanted]
    if len(remaining) == len(items):
        return False
    data["pipeline"] = remaining
    save_board(username, data)
    return True


# --------------------------------------------------------------------------- #
# Scénarios — normalisation (PUR)
# --------------------------------------------------------------------------- #

def _norm_prob(value: Any) -> str:
    """Probabilité ramenée dans ``BRANCH_PROBS``. Inconnue -> « moyenne » :
    le repli va vers le MILIEU, jamais vers « haute » — une valeur illisible ne
    doit pas promouvoir un chemin en tête de liste."""
    text = str(value or "").strip().lower()
    return text if text in BRANCH_PROBS else DEFAULT_PROB


def _norm_plays(value: Any) -> List[Dict[str, str]]:
    """Les mouvements d'une branche : ``{ticker, direction}``, 2 au plus."""
    out: List[Dict[str, str]] = []
    for play in _dicts(value):
        ticker = _symbol(play.get("ticker"))
        if not ticker:
            continue
        direction = str(play.get("direction") or "").strip().lower()
        if direction not in PLAY_DIRECTIONS:
            direction = PLAY_DIRECTIONS[0]
        out.append({"ticker": ticker, "direction": direction})
        if len(out) >= MAX_PLAYS:
            break
    return out


def _norm_branch(raw: Any, depth: int = 1) -> Optional[Dict[str, Any]]:
    """Une branche normalisée, ou ``None`` si elle n'a même pas de libellé.

    ``id`` et ``status`` sont posés par le SERVEUR : le modèle n'a pas le droit
    de déclarer qu'un chemin s'est déjà réalisé (ce serait lui laisser écrire
    le verdict de son propre pari), et un identifiant venu du dehors casserait
    la résolution par ``branch_id``.
    """
    row = raw if isinstance(raw, dict) else {}
    label = _text(row.get("label"), cap=120)
    if not label:
        return None
    children: List[Dict[str, Any]] = []
    if depth < MAX_DEPTH:
        for child in _dicts(row.get("children"))[:MAX_BRANCHES]:
            norm = _norm_branch(child, depth + 1)
            if norm is not None:
                children.append(norm)
    return {
        "id": _new_id(),
        "label": label,
        "prob": _norm_prob(row.get("prob")),
        "consequence": _text(row.get("consequence")),
        "plays": _norm_plays(row.get("plays")),
        "status": BRANCH_STATUSES[0],
        "children": children,
    }


def normalize_tree(raw: Any, now_iso: str, tree_id: Optional[str] = None) -> Dict[str, Any]:
    """Un arbre de scénarios prêt à persister (PUR).

    Tolérant par construction (une branche sans libellé est jetée SEULE,
    jamais tout l'arbre) et borné : ``MAX_BRANCHES`` chemins, ``MAX_DEPTH``
    niveaux. C'est ici que le serveur reprend la main sur les ids, les statuts
    et les dates.
    """
    row = raw if isinstance(raw, dict) else {}
    branches: List[Dict[str, Any]] = []
    for candidate in _dicts(row.get("branches"))[:MAX_BRANCHES]:
        norm = _norm_branch(candidate, 1)
        if norm is not None:
            branches.append(norm)
    return {
        "id": tree_id or _new_id(),
        "title": _text(row.get("title"), cap=160) or "Scénarios",
        "context": _text(row.get("context"), cap=800),
        "created_at": now_iso,
        "updated_at": now_iso,
        "status": TREE_STATUSES[0],
        "branches": branches,
    }


def resolve_branch(tree: Optional[Dict[str, Any]], branch_id: str, status: str) -> bool:
    """Marque une branche « ce chemin s'est produit » / « ce chemin est mort ».

    PUR (aucune I/O) et RÉCURSIF : une sous-branche se résout comme une
    branche de tête. Modifie ``tree`` en place et rend ``True`` si la branche a
    été trouvée.

    Lève ``ValueError`` sur tout statut autre que ``happened``/``invalidated``
    : ré-ouvrir une branche déjà jugée effacerait la seule chose qui a de la
    valeur ici — la trace de ce qu'on avait prévu, et de ce qui est arrivé.
    """
    wanted_status = str(status or "").strip().lower()
    if wanted_status not in RESOLVABLE_STATUSES:
        raise ValueError("statut de branche inconnu: %r" % (status,))
    wanted = str(branch_id or "").strip()
    if not wanted:
        return False

    def walk(branches: Any) -> bool:
        for branch in _dicts(branches):
            if str(branch.get("id") or "") == wanted:
                branch["status"] = wanted_status
                return True
            if walk(branch.get("children")):
                return True
        return False

    return walk((tree or {}).get("branches"))


# --------------------------------------------------------------------------- #
# Scénarios — écriture
# --------------------------------------------------------------------------- #

def _active(trees: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    return [t for t in trees if str(t.get("status") or "") != "archived"]


def _archived(trees: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    return [t for t in trees if str(t.get("status") or "") == "archived"]


def add_scenario(username: str, raw: Any, now_iso: str) -> Dict[str, Any]:
    """Range un nouvel arbre. Au-delà de ``MAX_ACTIVE_TREES`` actifs, le PLUS
    VIEUX passe « archivé » (il n'est pas supprimé : un scénario périmé raconte
    ce qu'on croyait) ; les archives elles-mêmes sont bornées."""
    data = load_board(username)
    trees = data["scenarios"]
    tree = normalize_tree(raw, now_iso)

    actives = _active(trees)
    while len(actives) >= MAX_ACTIVE_TREES and actives:
        oldest = min(actives, key=_sort_key)
        oldest["status"] = "archived"
        oldest["updated_at"] = now_iso
        actives = _active(trees)

    trees.append(tree)

    archived = _archived(trees)
    while len(archived) > MAX_ARCHIVED_TREES:
        oldest = min(archived, key=_sort_key)
        trees.remove(oldest)
        archived = _archived(trees)

    save_board(username, data)
    return tree


def resolve_scenario_branch(username: str, tree_id: str, branch_id: str,
                            status: str, now_iso: str) -> Optional[Dict[str, Any]]:
    """Résout une branche d'un arbre persisté. ``None`` si l'arbre ou la
    branche n'existe pas (le router en fait un 404). Lève ``ValueError`` sur un
    statut interdit (400)."""
    wanted = str(tree_id or "").strip()
    data = load_board(username)
    for tree in data["scenarios"]:
        if str(tree.get("id") or "") != wanted:
            continue
        if not resolve_branch(tree, branch_id, status):
            return None
        tree["updated_at"] = now_iso
        save_board(username, data)
        return tree
    return None


def archive_scenario(username: str, tree_id: str, now_iso: str) -> Optional[Dict[str, Any]]:
    """Archive un arbre (jamais de suppression dure : on garde la trace de ce
    qu'on avait imaginé). ``None`` si l'arbre n'existe pas."""
    wanted = str(tree_id or "").strip()
    data = load_board(username)
    for tree in data["scenarios"]:
        if str(tree.get("id") or "") != wanted:
            continue
        tree["status"] = "archived"
        tree["updated_at"] = now_iso
        save_board(username, data)
        return tree
    return None


def scenarios_view(data: Optional[Dict[str, Any]], cap: int = 5) -> List[Dict[str, Any]]:
    """Les arbres à afficher : ACTIFS d'abord (du plus récent au plus ancien),
    puis les archivés, le tout borné — la vue « Plan » montre ce qu'on suit,
    pas la totalité de ce qu'on a un jour imaginé."""
    trees = _dicts((data or {}).get("scenarios"))
    actives = sorted(_active(trees), key=_sort_key, reverse=True)
    archived = sorted(_archived(trees), key=_sort_key, reverse=True)
    return (actives + archived)[:max(0, int(cap))]


# --------------------------------------------------------------------------- #
# Progression d'apprentissage (PUR) — RECALCULÉE, jamais stockée
# --------------------------------------------------------------------------- #

def learning_summary(profile: Optional[Dict[str, Any]],
                     trades: Optional[List[Dict[str, Any]]],
                     lessons_total: int = 8,
                     initial_capital: Any = 0.0,
                     arena_rows: Optional[List[Dict[str, Any]]] = None) -> Dict[str, Any]:
    """Où en est Massii dans son apprentissage (PUR).

    Tout est LU depuis le profil coach (``lessons_passed``, ``arena_history``,
    ``bias_history``, ``resolved_biases``, ``milestones``) et les trades — rien
    n'est stocké en double dans le tableau : une progression persistée
    divergerait du profil au premier quiz passé ailleurs.

    Un champ absent ou mal typé vaut 0 / liste vide, JAMAIS une exception : un
    profil vierge (un compte neuf) doit rendre un tableau lisible, pas un 500.

    ``arena_rows`` = l'historique ÉVALUÉ des défis (``arena_view(...)["history"]``).
    Le profil ne STOCKE pas le verdict d'un défi — il est recalculé à chaque
    lecture depuis le catalogue et les trades de la semaine ; le compter depuis
    le profil seul serait une branche morte (le compteur resterait à zéro pour
    toujours en ayant l'air de marcher, cf. pièges #52a/#61 du dépôt). Sans cet
    argument, ``done`` vaut donc 0 en toute honnêteté.

    ``initial_capital`` est transmis à ``risk.portfolio_stats`` : sans lui, la
    baisse maximale y serait mesurée sur le cumul des gains seuls et donc
    massivement surestimée. Elle n'est pas RENDUE ici (le tableau n'affiche que
    l'espérance), mais on ne fabrique pas un chiffre faux au passage.
    """
    prof = profile if isinstance(profile, dict) else {}
    rows = trades if isinstance(trades, list) else []

    passed = prof.get("lessons_passed")
    passed_n = len({str(x) for x in passed}) if isinstance(passed, list) else 0

    arena_history = _dicts(prof.get("arena_history"))
    evaluated = _dicts(arena_rows)
    done_n = sum(1 for row in evaluated if str(row.get("status") or "") == "done")

    bias_history = prof.get("bias_history")
    active_n = len(bias_history) if isinstance(bias_history, dict) else 0
    resolved_n = len(_dicts(prof.get("resolved_biases")))

    stats = risk.portfolio_stats(rows, initial_capital=initial_capital)

    try:
        total = int(lessons_total)
    except (TypeError, ValueError):
        total = 0

    return {
        "lessons": {"passed": passed_n, "total": max(0, total)},
        "arena": {"accepted": len(arena_history), "done": done_n},
        "biases": {"active": active_n, "resolved": resolved_n},
        "milestones": [dict(m) for m in _dicts(prof.get("milestones"))],
        "n_trades": stats.get("n_trades", 0),
        "expectancy_r": stats.get("expectancy_r"),
        # LOT 2, B4 : même doctrine que le reste de ce tableau — RECALCULÉ à
        # chaque lecture depuis les trades, jamais stocké dans le profil.
        "discipline": tradestats.discipline_score(rows, initial_capital),
    }
