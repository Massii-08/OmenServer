"""Le compte de paper trading DU COACH (LOT 4) — la couche PURE + son état.

Demande de l'utilisateur : « donne-lui son propre compte, qu'il trade lui-même ».
Le coach cesse d'être un commentateur — il reçoit les mêmes 10 000 CHF fictifs
qu'un humain (:data:`COACH_CAPITAL`), sous un nom de compte RÉSERVÉ
(:data:`COACH_USERNAME`, aucun compte d'authentification associé), et ses
positions sont PUBLIQUES par design : c'est tout l'intérêt, voir COMMENT il
fait — et surtout ce qu'il n'a PAS le droit de faire.

Découpage PUR / I-O (même règle que ``weekly.py``/``backup.py``) :
  - PUR : :func:`gate_decision` (le garde-fou), :func:`parse_actions` (le bloc
    structuré que le modèle ajoute en fin de digest), :func:`pass_due`
    (l'horloge), le registre et la courbe de patrimoine — zéro I/O, zéro
    réseau, horloge et données passées en paramètre ;
  - I/O : :func:`state_path`/:func:`load_state`/:func:`save_state` seulement
    (patron ``weekly.load_state``), plus les deux paires ajoutées à ``store``
    (registre ``<user>.ledger.json``, patrimoine ``<user>.equity.json``).

**Doctrine centrale du garde-fou : on REJETTE, on ne rogne JAMAIS en silence.**
Un modèle qui demande 40 % de l'équité ne doit pas se voir servir 30 % sans le
savoir — le refus est PÉDAGOGIQUE et il sera AFFICHÉ (« voulait acheter 40 %
de l'équité — refusé : oversize »). Un garde-fou qui corrige en douce
n'enseigne rien et masque la dérive du modèle ; un garde-fou qui refuse la
montre.

Aucun SHORT dans ce lot : ``short``/``cover`` tombent volontairement en
``unknown_action`` (cf. :data:`ACTION_KINDS`). Le simulateur les gère pour un
humain, le coach ne les manie pas encore.

⚠️ **Non-fantôme** : les fichiers de ce lot (``<user>.ledger.json``,
``<user>.equity.json``, ``coach_trader.state.json``) vivent dans le MÊME
répertoire que les comptes. Ils sont déclarés dans les trois recensements du
paquet (``newswatch._discover_portfolios``, ``weekly._AUX_SUFFIXES``,
``radar._NON_USER_FILES``) — sans quoi ils fabriqueraient exactement les
« traders fantômes » que le dépôt a déjà eu à faire disparaître.
"""
import json
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional
from zoneinfo import ZoneInfo

from backend.bots.paper import models, quotes, risk

# Nom de compte RÉSERVÉ : aucun utilisateur authentifié ne s'appelle ainsi, et
# le nom passe l'allowlist de ``store`` (pas de point) — le coach est un compte
# comme un autre pour la communauté, ses positions se lisent publiquement.
COACH_USERNAME = "coach"
COACH_CAPITAL = 10000.0        # même capital de départ qu'un humain

# Le bloc structuré que le modèle ajoute en toute fin de digest. C'est la SEULE
# partie que la machine consomme ; tout ce qui précède est pour l'utilisateur.
ACTIONS_MARKER = "COACH_ACTIONS"

ACTION_KINDS = ("buy", "sell", "reduce")

LOCAL_TZ = "Europe/Rome"       # même convention que backup.py / weekly.py
STATE_NAME = "coach_trader.state.json"

MAX_LEDGER = 200               # le registre est une trace récente, pas une archive
MAX_EQUITY_POINTS = 730        # deux ans de points quotidiens

# --------------------------------------------------------------------------- #
# Garde-fou — les bornes du mandat confié au coach
#
# Elles ne se négocient pas et elles ne se rognent pas : franchir l'une d'elles
# n'ajuste pas l'ordre, elle le REFUSE (cf. tête de fichier).
# --------------------------------------------------------------------------- #
MAX_RISK_PCT = 2.0        # risque planifié (|entrée-stop| x qty) max, % de l'équité
MIN_POSITION_PCT = 10.0   # « pas des actions en centimes » : sous ce seuil, ce
                          # n'est pas une position, c'est un ticket de loterie
MAX_POSITION_PCT = 30.0   # concentration max d'une ligne (valeur PROJETÉE)
MAX_POSITIONS = 6         # nombre de fronts ouverts simultanément
MAX_CRYPTO = 2            # dont au plus deux cryptos
MIN_CASH_PCT = 5.0        # trésorerie plancher : on ne se met jamais à sec

RUN_AFTER_HOUR = 17       # passe quotidienne : jamais avant 17 h LOCALES

# Un seul seuil de thèse dans tout le simulateur — ``risk`` le porte déjà pour
# la porte de confirmation humaine (LOT 3, C3). On le RÉUTILISE plutôt que d'en
# poser un second qui divergerait au premier ajustement.
MIN_THESIS_LEN = risk.PREORDER_MIN_THESIS_LEN

# Les 14 codes de refus. ``reason`` est TOUJOURS l'un d'eux, JAMAIS une phrase :
# la traduction (fr/en/it) vit dans ``lang.js``, comme partout ailleurs.
REJECT_CODES = (
    "unknown_action", "no_symbol", "bad_qty", "no_quote",
    "no_thesis", "no_stop", "risk_high", "too_small", "oversize",
    "too_many_positions", "too_many_crypto", "cash_floor",
    "no_position", "qty_over_position",
)

# D'où vient une décision : du digest quotidien, ou de la passe autonome de
# fin de journée. Constante de CONTRAT pour les appelants — le registre, lui,
# archive ce qu'on lui donne sans le policer (une trace ne valide pas, elle
# consigne).
SOURCES = ("digest", "daily")

# Le setup de repli quand le modèle en invente un hors de ``models.SETUPS``.
DEFAULT_SETUP = "coach_idea"

# L'émotion d'un ordre du coach : il n'en a pas. « calme » est le code neutre
# de ``models.EMOTIONS`` — on ne lui prête pas de FOMO qu'il ne ressent pas.
DEFAULT_EMOTION = "calme"


# --------------------------------------------------------------------------- #
# Helpers PURS
# --------------------------------------------------------------------------- #

def _val(value: Any) -> Optional[float]:
    """Nombre flottant, ou ``None`` si absent/illisible (même helper que
    ``risk._val`` — un booléen n'est JAMAIS un nombre ici)."""
    if value is None or isinstance(value, bool):
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _text(value: Any) -> str:
    """Chaîne strippée ; ``None`` -> ``""`` (jamais la chaîne « None »)."""
    return str(value if value is not None else "").strip()


def _symbol(value: Any) -> str:
    """Symbole canonique (majuscules, sans espaces autour), et SEULEMENT depuis
    une chaîne.

    Un nombre n'est pas un ticker : ``8001`` n'est pas ``8001.T``, et le
    convertir en ``"8001"`` ferait passer une donnée illisible pour un symbole
    valide — le refus arriverait alors trois contrôles plus loin, sous un code
    qui ne dirait pas la vérité (``no_quote`` au lieu de ``no_symbol``).
    """
    return value.strip().upper() if isinstance(value, str) else ""


def _dicts(value: Any) -> List[Dict[str, Any]]:
    """Ne garde que les entrées exploitables d'une liste persistée."""
    if not isinstance(value, list):
        return []
    return [item for item in value if isinstance(item, dict)]


def _as_qty(value: Any) -> Optional[int]:
    """Quantité en ENTIER STRICTEMENT POSITIF, ou ``None``.

    Tronqué vers le bas comme ``models._as_int`` (une action ne se coupe pas) :
    ``0.4`` -> ``0`` -> ``None``. Un booléen n'est pas une quantité.
    """
    number = _val(value)
    if number is None:
        return None
    qty = int(number)
    return qty if qty > 0 else None


def _is_blank_qty(value: Any) -> bool:
    """La quantité est-elle ABSENTE au sens « tout solder » ?

    Absente, chaîne vide, ou zéro — mais PAS illisible : « beaucoup » n'est pas
    une intention de tout vendre, c'est une erreur, et elle doit se voir
    (``bad_qty``).
    """
    if value is None:
        return True
    if isinstance(value, str) and not value.strip():
        return True
    number = _val(value)
    return number is not None and number == 0


def _reject(code: str) -> Dict[str, Any]:
    return {"accepted": False, "reason": code, "order": None}


def _equity_chf(cash_chf: Any, positions: List[Dict[str, Any]]) -> float:
    """Équité = trésorerie + valeur au PRIX DE REVIENT de TOUTES les lignes.

    Reproduit volontairement la convention de ``risk._positions_cost_basis_chf``
    (long ET short comptés en valeur absolue : la marge du simulateur traite les
    deux comme du risque). On ne l'IMPORTE pas — c'est un privé d'un autre
    module, et un import de privé se casse en silence à la première refonte ;
    le miroir est documenté ici et épinglé par les tests des deux côtés.
    """
    total = _val(cash_chf) or 0.0
    for pos in positions:
        qty = _val(pos.get("qty"))
        price = _val(pos.get("avg_price"))
        if qty is None or price is None:
            continue
        fx = _val(pos.get("fx_rate"))
        total += abs(qty) * price * (fx if fx and fx > 0 else 1.0)
    return total


def _held_long(positions: List[Dict[str, Any]], symbol: str) -> float:
    """Quantité DÉTENUE À LA HAUSSE sur ce symbole, toutes lignes confondues.

    Le sens compte : une ligne ``short`` ne se solde pas par une vente (aucun
    short dans ce lot, cf. tête de fichier), elle n'est donc jamais comptée.
    """
    total = 0.0
    for pos in positions:
        if _symbol(pos.get("symbol")) != symbol:
            continue
        if (_text(pos.get("side")) or "long").lower() != "long":
            continue
        qty = _val(pos.get("qty"))
        if qty is not None:
            total += abs(qty)
    return total


def _crypto_symbols(positions: List[Dict[str, Any]]) -> set:
    """Les symboles CRYPTO détenus, dédupliqués (une « ligne » = un symbole).

    Le genre se lit par ``quotes.kind_from_symbol``, qui est PUR (il ne fait
    que regarder la FORME du ticker : ``BTC-USD`` -> crypto) — aucun appel
    réseau ne doit sortir d'un module de ce fichier.
    """
    out = set()
    for pos in positions:
        symbol = _symbol(pos.get("symbol"))
        if symbol and quotes.kind_from_symbol(symbol) == "crypto":
            out.add(symbol)
    return out


# --------------------------------------------------------------------------- #
# PUR — le garde-fou
# --------------------------------------------------------------------------- #

def gate_decision(decision: Any, portfolio: Any, quote: Any) -> Dict[str, Any]:
    """Une décision du modèle passe-t-elle le mandat ? (PUR)

    **On REJETTE, on ne rogne JAMAIS en silence** (cf. tête de fichier) : le
    refus est pédagogique, il sera AFFICHÉ tel quel et archivé au registre.

    ``decision`` : le dict BRUT rendu par le modèle
    (``{"action","symbol","qty","stop","target","thesis","setup"}``) — tout
    peut manquer ou être n'importe quoi, c'est précisément le travail de cette
    fonction.
    ``portfolio`` : ``models.Portfolio.to_dict()`` (``cash_chf``/``positions``/
    ``initial_capital``).
    ``quote`` : ``{"price", "currency", "fx_rate"}``. **La conversion en CHF
    est la responsabilité de l'APPELANT** — exactement la doctrine de
    ``risk.preorder_warnings`` (dont l'argument ``level`` arrive déjà converti) :
    ce module reste PUR, il n'ira jamais chercher un taux sur le réseau. On
    applique le ``fx_rate`` FOURNI, le même pour toute l'opération.

    Rend ``{"accepted": bool, "reason": str|None, "order": dict|None}``.
    ``reason`` est TOUJOURS un code de :data:`REJECT_CODES`.

    Ordre des contrôles — le PREMIER échec gagne, et cet ordre est DÉTERMINISTE
    (épinglé par les tests) parce qu'il décide ce que l'utilisateur lira quand
    deux règles sont violées à la fois : on nomme d'abord le problème le plus
    grossier (la décision est-elle seulement lisible ?) avant le plus fin (la
    taille est-elle raisonnable ?).

      1. ``unknown_action`` — action absente ou hors :data:`ACTION_KINDS`
         (``short``/``cover`` compris : hors périmètre de ce lot).
      2. ``no_symbol``
      3. ``bad_qty`` — sauf pour ``sell`` sans quantité : « tout solder ».
      4. ``no_quote`` — sans prix ni taux valides, aucun contrôle de taille
         n'a de sens ; refuser vaut mieux que calculer sur un chiffre inventé.
      5. SORTIE (``sell``/``reduce``) : ``no_position``, ``qty_over_position``.
      6. ENTRÉE (``buy``) : ``no_thesis``, ``no_stop``, ``risk_high``,
         ``too_small``, ``oversize``, ``too_many_positions``,
         ``too_many_crypto``, ``cash_floor``.
    """
    decision = decision if isinstance(decision, dict) else {}
    portfolio = portfolio if isinstance(portfolio, dict) else {}
    quote = quote if isinstance(quote, dict) else {}

    action = _text(decision.get("action")).lower()
    if action not in ACTION_KINDS:
        return _reject("unknown_action")

    symbol = _symbol(decision.get("symbol"))
    if not symbol:
        return _reject("no_symbol")

    qty_raw = decision.get("qty")
    qty = _as_qty(qty_raw)
    if qty is None and not (action == "sell" and _is_blank_qty(qty_raw)):
        # ``reduce`` = allègement PARTIEL : sans quantité il n'y a pas d'ordre.
        return _reject("bad_qty")

    price = _val(quote.get("price"))
    fx = _val(quote.get("fx_rate"))
    if price is None or price <= 0 or fx is None or fx <= 0:
        return _reject("no_quote")

    positions = _dicts(portfolio.get("positions"))
    held = _held_long(positions, symbol)

    # ----------------------------------------------------------------- #
    # SORTIE — n'exige QUE l'existence de la position.
    #
    # Une sortie réduit TOUJOURS l'exposition : elle n'a besoin ni de thèse ni
    # de stop (même restriction que ``risk.preorder_warnings``, qui ne
    # s'applique qu'aux ouvertures), et aucun plafond de taille ne la concerne.
    # ----------------------------------------------------------------- #
    if action in ("sell", "reduce"):
        if held <= 0:
            return _reject("no_position")
        if qty is None:
            qty = int(held)          # « tout solder »
        if qty > held:
            return _reject("qty_over_position")
        return _accept(symbol, "sell", qty, decision)

    # ----------------------------------------------------------------- #
    # ENTRÉE
    # ----------------------------------------------------------------- #
    thesis = _text(decision.get("thesis"))
    if len(thesis) < MIN_THESIS_LEN:
        return _reject("no_thesis")

    stop = _val(decision.get("stop"))
    if stop is None or stop >= price:
        # Un « stop » au-dessus du prix d'entrée d'un long ne protège rien :
        # c'est l'absence de stop, pas un stop large.
        return _reject("no_stop")

    equity = _equity_chf(portfolio.get("cash_chf"), positions)
    level_chf = price * fx
    stop_chf = stop * fx
    value_chf = qty * level_chf

    if abs(level_chf - stop_chf) * qty > equity * MAX_RISK_PCT / 100.0:
        return _reject("risk_high")

    if value_chf < equity * MIN_POSITION_PCT / 100.0:
        return _reject("too_small")

    # Valeur PROJETÉE (ligne déjà détenue + nouvelle quantité), même convention
    # que ``risk.preorder_warnings`` : renforcer trois fois une ligne de 10 %
    # est un dépassement, même si chaque achat pris seul semblait raisonnable.
    if (held + qty) * level_chf > equity * MAX_POSITION_PCT / 100.0:
        return _reject("oversize")

    # Renforcer une ligne existante n'ouvre pas un front NOUVEAU — le plafond
    # compte les fronts à surveiller, pas les ordres.
    if len(positions) >= MAX_POSITIONS and held <= 0:
        return _reject("too_many_positions")

    crypto = _crypto_symbols(positions)
    n_crypto = len(crypto) + (1 if quotes.kind_from_symbol(symbol) == "crypto"
                              and symbol not in crypto else 0)
    if n_crypto > MAX_CRYPTO:
        return _reject("too_many_crypto")

    # ⚠️ Les FRAIS ne sont pas déduits ici : ce module est PUR, il n'a pas le
    # barème (``fees.py`` le porte). Le plancher est donc CONSERVATEUR — le
    # moteur d'ordres refusera de toute façon une trésorerie réellement
    # insuffisante, et mieux vaut un plancher un peu large qu'un module pur
    # qui se met à connaître la grille tarifaire du courtier.
    cash = _val(portfolio.get("cash_chf")) or 0.0
    if cash - value_chf < equity * MIN_CASH_PCT / 100.0:
        return _reject("cash_floor")

    return _accept(symbol, "buy", qty, decision)


def _accept(symbol: str, side: str, qty: int,
            decision: Dict[str, Any]) -> Dict[str, Any]:
    """L'ordre normalisé, prêt pour le moteur d'ordres du simulateur.

    ``sell`` et ``reduce`` rendent tous deux ``side="sell"`` : la différence
    n'est pas dans l'exécution (une vente est une vente) mais dans l'INTENTION,
    déjà consignée au registre.

    ``setup`` est conservé s'il appartient à ``models.SETUPS``, sinon ramené à
    :data:`DEFAULT_SETUP` — la whitelist du journal est FERMÉE, un libellé
    inventé par le modèle ne doit pas y entrer par la porte de derrière.
    """
    setup = _text(decision.get("setup")).lower()
    if setup not in models.SETUPS:
        setup = DEFAULT_SETUP
    return {
        "accepted": True,
        "reason": None,
        "order": {
            "symbol": symbol,
            "side": side,
            "kind": "market",
            "qty": int(qty),
            "thesis": _text(decision.get("thesis")),
            "stop_loss": _val(decision.get("stop")),
            "target": _val(decision.get("target")),
            "setup": setup,
            "emotion": DEFAULT_EMOTION,
        },
    }


# --------------------------------------------------------------------------- #
# PUR — le bloc structuré de fin de digest
# --------------------------------------------------------------------------- #

# Le bloc clôturant, tel que le prompt le demande :
#
#     ```COACH_ACTIONS
#     {"actions": [ {...} ]}
#     ```
#
# La clôture est OPTIONNELLE quand le bloc court jusqu'au bout du texte : un
# modèle tronqué en fin de réponse ne doit pas laisser du JSON à moitié écrit
# dans un message Telegram (cf. :func:`parse_actions`).
_BLOCK_RE = re.compile(
    r"```[ \t]*" + ACTIONS_MARKER + r"[ \t]*\r?\n(.*?)(?:```|\Z)",
    re.DOTALL | re.IGNORECASE)


def _actions_of(payload: Any) -> Optional[List[Dict[str, Any]]]:
    """La liste d'actions d'un bloc décodé, ou ``None`` si la forme est
    inattendue.

    Deux formes acceptées : ``{"actions": [...]}`` (celle du prompt) et une
    liste nue (celle que le modèle rend un jour sur deux). Une entrée qui n'est
    pas un dict est ÉCARTÉE ; une entrée dict INCOMPLÈTE est CONSERVÉE — c'est
    le garde-fou qui la refusera avec son code, et ce refus doit se voir.
    """
    if isinstance(payload, dict):
        raw = payload.get("actions")
    elif isinstance(payload, list):
        raw = payload
    else:
        return None
    if not isinstance(raw, list):
        return None
    return [item for item in raw if isinstance(item, dict)]


def _tidy(text: str) -> str:
    """Recolle le texte après retrait d'un bloc : pas de trou de trois lignes
    vides là où le bloc se trouvait."""
    return re.sub(r"\n{3,}", "\n\n", text).strip()


def _note_of(payload: Any) -> Optional[str]:
    """Le ``note`` de tête du bloc, ou ``None`` — TOLÉRANT (PUR).

    Une liste nue (l'autre forme acceptée par :func:`_actions_of`) n'a pas de
    clé ``note`` possible -> ``None``, jamais une exception. Un ``note`` d'un
    autre type que ``str`` (le modèle a un jour sur deux des lubies de forme,
    cf. :func:`_actions_of`) compte aussi comme absent : mieux vaut zéro note
    qu'une note inventée en stringifiant n'importe quoi. Une chaîne vide ou
    blanche compte de même comme absente — elle ne dit rien de plus qu'un
    silence, et l'appelant a déjà son repli générique pour ce cas.
    """
    if not isinstance(payload, dict):
        return None
    value = payload.get("note")
    if not isinstance(value, str):
        return None
    text = value.strip()
    return text or None


def parse_actions(text: Any) -> Dict[str, Any]:
    """Sépare le digest LISIBLE du bloc d'actions qu'il porte (PUR).

    Rend ``{"text": str, "actions": list, "note": str|None, "error": None|
    "no_block"|"parse_failed"}``.

    **On n'invente JAMAIS un ordre** : pas de bloc lisible ⇒ zéro action. Un
    digest sans bloc est un digest normal (le coach n'a rien à faire ce
    jour-là), pas une anomalie à rattraper en devinant des intentions dans la
    prose.

    Le bloc est TOUJOURS retiré du texte rendu, même quand son contenu est
    illisible : l'utilisateur ne doit jamais recevoir du JSON cassé sur
    Telegram. Plusieurs blocs -> on prend le PREMIER (le modèle s'est répété)
    et on les retire TOUS, aucun résidu.

    Le texte rendu est strippé à ses deux bouts et ses trous recollés
    (:func:`_tidy`) ; il n'est jamais réécrit autrement.

    ``note`` (LOT 4bis) est le champ de tête FACULTATIF du bloc — la raison
    ARGUMENTÉE du coach quand ``actions`` est vide, ou une phrase de lecture
    de marché quand il agit (cf. ``llm.coach_actions_block``, seul endroit qui
    écrit ce contrat). Absent, mal typé ou vide -> ``None`` (:func:`_note_of`)
    ; jamais de bloc lisible du tout (``"no_block"``/``"parse_failed"``) ->
    ``None`` aussi, on n'a rien pu lire.
    """
    body = text if isinstance(text, str) else ""
    matches = list(_BLOCK_RE.finditer(body))
    if not matches:
        return {"text": _tidy(body), "actions": [], "note": None,
                "error": "no_block"}

    cleaned = _tidy(_BLOCK_RE.sub("", body))

    try:
        payload = json.loads(matches[0].group(1).strip())
    except (TypeError, ValueError):
        return {"text": cleaned, "actions": [], "note": None,
                "error": "parse_failed"}

    actions = _actions_of(payload)
    if actions is None:
        return {"text": cleaned, "actions": [], "note": None,
                "error": "parse_failed"}
    return {"text": cleaned, "actions": actions, "note": _note_of(payload),
            "error": None}


# --------------------------------------------------------------------------- #
# PUR — l'horloge (heure LOCALE, jamais celle du système)
# --------------------------------------------------------------------------- #

def _aware_utc(now: Any) -> datetime:
    """``now`` en ``datetime`` timezone-aware. Un naïf est traité comme UTC —
    même convention que ``weekly._aware_utc``."""
    if not isinstance(now, datetime):
        now = datetime.now(timezone.utc)
    if now.tzinfo is None:
        now = now.replace(tzinfo=timezone.utc)
    return now


def _local(now: Any) -> datetime:
    return _aware_utc(now).astimezone(ZoneInfo(LOCAL_TZ))


def _parse_iso(value: Any) -> Optional[datetime]:
    """ISO -> ``datetime`` aware (naïf traité comme UTC), ou ``None`` —
    ``fromisoformat`` (3.9) ne connaît pas le suffixe ``Z``."""
    if not isinstance(value, str) or not value.strip():
        return None
    raw = value.strip()
    if raw[-1] in ("Z", "z"):
        raw = raw[:-1]
    try:
        parsed = datetime.fromisoformat(raw)
    except (TypeError, ValueError):
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed


def pass_due(now: Any, last_ts: Any, *, hour: int = RUN_AFTER_HOUR) -> bool:
    """La passe quotidienne du coach doit-elle tourner MAINTENANT ? (PUR)

    Jour de semaine (lundi-vendredi) et pas avant ``hour``, **en heure LOCALE
    ``Europe/Rome``** — 22h30 UTC un vendredi, c'est déjà samedi à Rome, et un
    seuil lu en UTC déclencherait la passe le week-end ou une heure trop tôt
    l'hiver.

    ``last_ts`` est l'horodatage ISO de la DERNIÈRE passe : la comparaison se
    fait sur la DATE LOCALE, pas à la minute près (une passe par jour, qu'elle
    ait tourné à 17h01 ou à 23h50). Absent ou illisible -> due (première fois,
    ou fichier touché à la main : mieux vaut une passe de trop qu'un compte
    qui ne trade plus jamais en silence).
    """
    try:
        threshold = int(hour)
    except (TypeError, ValueError):
        threshold = RUN_AFTER_HOUR

    local = _local(now)
    if local.weekday() > 4:          # samedi/dimanche : les marchés sont fermés
        return False
    if local.hour < threshold:
        return False

    last = _parse_iso(last_ts)
    if last is None:
        return True
    return _local(last).date() != local.date()


# --------------------------------------------------------------------------- #
# PUR — le registre (ce qu'il a fait, ET ce qu'on lui a refusé)
# --------------------------------------------------------------------------- #

def ledger_entry(ts: Any, source: Any, action: Any, symbol: Any, accepted: Any,
                 reason: Any = None, detail: Any = None) -> Dict[str, Any]:
    """Une ligne de registre.

    Les REFUS y sont archivés AVEC leur code : c'est le cœur de « voir COMMENT
    il fait ». Un registre qui ne garderait que les ordres passés montrerait un
    coach irréprochable et cacherait tout ce que le mandat a empêché.

    ``source`` ∈ :data:`SOURCES` (contrat pour les appelants). La valeur est
    normalisée mais pas policée : un registre CONSIGNE ce qui s'est passé, il
    ne valide pas — inventer « digest » à la place d'une valeur inattendue
    falsifierait la trace.
    """
    return {
        "ts": _text(ts),
        "source": _text(source).lower(),
        "action": _text(action).lower(),
        "symbol": _text(symbol).upper(),
        "accepted": bool(accepted),
        "reason": _text(reason) or None,
        "detail": _text(detail) or None,
    }


def push_ledger(rows: Any, entry: Any, cap: int = MAX_LEDGER) -> List[Dict[str, Any]]:
    """Ajoute une ligne EN TÊTE (plus récent d'abord) et plafonne (PUR).

    Ne modifie jamais la liste reçue — même patron que
    ``idea_journal.append_entry`` côté forme, sans l'I/O.
    """
    try:
        limit = max(0, int(cap))
    except (TypeError, ValueError):
        limit = MAX_LEDGER
    head = [entry] if isinstance(entry, dict) else []
    return (head + _dicts(rows))[:limit]


# --------------------------------------------------------------------------- #
# PUR — la courbe de patrimoine (une photo par jour)
# --------------------------------------------------------------------------- #

def should_snapshot(series: Any, date_str: Any) -> bool:
    """Faut-il photographier l'équité aujourd'hui ? (PUR)

    Faux si le DERNIER point porte déjà cette date — la question posée est
    « ai-je déjà photographié aujourd'hui ? », et la série est chronologique
    donc la réponse est en queue (test O(1), appelé à chaque cycle).
    Une date vide -> faux : un point sans date ne se place sur aucune courbe.
    """
    day = _text(date_str)
    if not day:
        return False
    rows = _dicts(series)
    if not rows:
        return True
    return _text(rows[-1].get("date")) != day


def push_equity(series: Any, date_str: Any, equity: Any,
                cap: int = MAX_EQUITY_POINTS) -> List[Dict[str, Any]]:
    """Ajoute un point ``{"date", "equity"}`` EN QUEUE (PUR).

    Ordre CHRONOLOGIQUE (plus ancien en tête) : c'est ce que dessine une
    courbe, et l'inverser une fois à l'écran coûterait un tri à chaque rendu.

    Ne fait RIEN si la date est déjà présente N'IMPORTE OÙ dans la série
    (contrôle plus large que :func:`should_snapshot`, qui n'interroge que la
    queue : ici on protège la donnée, là on évite un calcul), si la date est
    vide, ou si l'équité est illisible — on ne pose jamais un 0 qui prétendrait
    avoir mesuré quelque chose.

    Plafond GLISSANT qui garde les points les plus RÉCENTS.
    """
    rows = _dicts(series)
    day = _text(date_str)
    value = _val(equity)
    if not day or value is None:
        return rows
    if any(_text(point.get("date")) == day for point in rows):
        return rows

    try:
        limit = max(0, int(cap))
    except (TypeError, ValueError):
        limit = MAX_EQUITY_POINTS

    rows.append({"date": day, "equity": round(value, 2)})
    return rows[-limit:] if limit > 0 else []


# --------------------------------------------------------------------------- #
# I/O — l'état du module, résolu PARESSEUSEMENT depuis store.DATA_DIR (même
# patron que ``weekly.py``/``backup.py`` : un test qui isole DATA_DIR isole
# aussi ce module)
# --------------------------------------------------------------------------- #

def _store():
    from backend.bots.paper import store
    return store


def state_path() -> Path:
    return Path(_store().DATA_DIR) / STATE_NAME


def load_state() -> Dict[str, Any]:
    """L'état du module (``{"last_pass_iso": "..."}``). Absent/corrompu ->
    ``{}`` — la passe du coach ne doit jamais tomber parce qu'un fichier a été
    touché à la main."""
    path = state_path()
    if not path.is_file():
        return {}
    try:
        with open(str(path), "r", encoding="utf-8") as handle:
            data = json.load(handle)
    except (OSError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


def save_state(state: Dict[str, Any]) -> None:
    """Persiste l'état de façon atomique, 0o600 — via ``store._atomic_write_json``
    (le fichier temporaire NAÎT en 0o600, jamais ``open()`` puis ``chmod()``)."""
    _store()._atomic_write_json(state_path(), dict(state or {}))


# --------------------------------------------------------------------------- #
# I/O — le CROCHET du cycle de veille (best-effort STRICT), tâche 3
#
# ⚠️ POURQUOI CE CROCHET EXISTE, et pourquoi il n'est pas optionnel :
# ``paper_router.run_tick`` n'énumère AUCUN compte. C'est une fonction
# par-portefeuille, appelée uniquement depuis ``POST /api/paper/tick``, que
# déclenche le NAVIGATEUR de l'utilisateur connecté. Le coach n'a pas de
# navigateur — sans ce crochet, ses stops et ses objectifs ne s'exécuteraient
# JAMAIS. Il porte donc la GARANTIE D'INCLUSION du compte du coach dans le
# cycle, au même titre que la sauvegarde nocturne et le bilan hebdomadaire.
# --------------------------------------------------------------------------- #
# ``logging`` arrive ici et pas en tête de fichier : la couche PURE de la
# tâche 1 n'en avait aucun besoin (zéro I/O, zéro effet de bord), et ce lot
# n'ajoute qu'en fin de fichier. Même nom de journal que partout ailleurs.
import logging

logger = logging.getLogger("omenserver")


def _router():
    """Import PARESSEUX du router (il importe ce module au chargement) — sans
    lui, le cycle d'import serait circulaire."""
    from backend.bots import paper_router
    return paper_router


def _default_tick(now_iso: str) -> Any:
    return _router().tick_coach_account(now_iso)


def _default_snapshot(now_iso: str) -> Any:
    return _router().snapshot_equity_all(now_iso)


def _default_pass(now_iso: str) -> Any:
    return _router().run_coach_daily_pass(now_iso)


def maybe_run(now: Any = None,
              tick_fn: Optional[Any] = None,
              snapshot_fn: Optional[Any] = None,
              pass_fn: Optional[Any] = None) -> Dict[str, Any]:
    """Le compte du coach, appelé à CHAQUE passage du guetteur (5 min).

    NE LÈVE JAMAIS — l'appelant (``newswatch.run_once``) ne doit jamais perdre
    un cycle de veille pour une panne du compte du coach (même doctrine que
    ``weekly.maybe_run``/``backup.maybe_run``).

    **Trois volets, chacun best-effort STRICT** — aucun ne peut faire tomber
    les deux autres :

    1. **le tick, À CHAQUE PASSAGE** (cf. le commentaire de section ci-dessus :
       c'est la garantie d'inclusion, pas une commodité). Il tourne aussi le
       week-end : un stop peut sauter sur une crypto un dimanche.
    2. **la photo de patrimoine, une fois par jour, POUR TOUS LES COMPTES**
       (coach ET humains). Le gate extérieur interroge la série DU COACH — le
       seul compte dont l'existence est garantie ; le gate par compte, lui,
       vit dans ``snapshot_equity_all`` et reste l'autorité sur la donnée.
       Conséquence assumée : un compte humain créé APRÈS la photo du jour
       attend celle de demain — sans conséquence sur une courbe quotidienne.
    3. **la passe quotidienne de gestion** (:func:`pass_due` : jour de semaine,
       pas avant 17 h locales, une par jour). L'état est ARMÉ après la
       TENTATIVE, quel qu'en soit le résultat — même doctrine que ``weekly`` :
       sans cela, une panne du modèle ferait retenter toutes les 5 minutes
       jusqu'à minuit.

    **Un SEUL horodatage local** (``Europe/Rome``) est passé aux trois volets.
    C'est délibéré : la photo se range sous une DATE, et le gate
    ``should_snapshot`` interroge cette même date. Deux horloges (l'une UTC,
    l'autre locale) rateraient la photo un soir sur deux — 23 h 30 UTC un
    28 août, c'est déjà le 29 à Rome.

    ⚠️ Cet horodatage est **NAÏF**, comme tous ceux du simulateur
    (``paper_router._now_iso`` rend ``datetime.now().isoformat()``). Un
    horodatage AWARE poserait un ``+02:00`` sur les ordres et les trades du
    coach : mélangé aux ``opened_at`` naïfs déjà en base, il fait exploser
    ``coach._rule_let_losers_run`` avec « can't subtract offset-naive and
    offset-aware datetimes » — mesuré, dans le fil détaché du post-mortem
    automatique, donc invisible depuis la réponse HTTP.

    L'état ``last_pass``, lui, est stocké **AWARE (UTC)** : il n'est jamais
    affiché, il n'est relu que par :func:`pass_due`, et un naïf y serait
    interprété comme de l'UTC — un « 23 h 30 » de Rome relu comme UTC bascule
    au LENDEMAIN en local, et la passe repartirait cinq minutes plus tard.

    ⚠️ La clé d'état est ``last_pass`` (le docstring d'exemple de
    :func:`load_state`, écrit avant ce crochet, montre ``last_pass_iso`` : ce
    nom-là n'est lu ni écrit nulle part). Écriture et lecture se font ici, sur
    la MÊME clé — une divergence rendrait ``pass_due`` toujours vrai, donc une
    passe toutes les 5 minutes après 17 h.

    Les trois ``*_fn`` sont injectables : les tests n'ont jamais besoin du
    router, du réseau ni du modèle.

    Rend ``{"ticked", "snapshotted", "passed", "reason"}`` — ``reason`` décrit
    le sort du VOLET 3 (``None`` s'il a tourné, ``"not_due"`` si l'horloge a
    refusé, ``"error"`` s'il a échoué), le seul dont l'inaction soit normale.
    """
    out = {"ticked": False, "snapshotted": False, "passed": False,
           "reason": None}
    try:
        local_iso = _local(now).replace(tzinfo=None).isoformat(timespec="seconds")
        state_iso = _aware_utc(now).isoformat()
        day = local_iso[:10]
    except Exception:      # noqa: BLE001 — horloge illisible : rien n'est sûr
        return {"ticked": False, "snapshotted": False, "passed": False,
                "reason": "error"}

    # --- 1) le tick, à chaque passage --------------------------------- #
    try:
        (tick_fn or _default_tick)(local_iso)
        out["ticked"] = True
    except Exception as exc:      # noqa: BLE001
        logger.warning("paper coach_trader: tick du compte en panne (%s)",
                       type(exc).__name__)

    # --- 2) la photo de patrimoine, une fois par jour ----------------- #
    try:
        series = _store().load_equity(COACH_USERNAME)
        if should_snapshot(series, day):
            (snapshot_fn or _default_snapshot)(local_iso)
            out["snapshotted"] = True
    except Exception as exc:      # noqa: BLE001
        logger.warning("paper coach_trader: photo de patrimoine en panne (%s)",
                       type(exc).__name__)

    # --- 3) la passe quotidienne de gestion --------------------------- #
    try:
        state = load_state()
    except Exception:      # noqa: BLE001 — état illisible : on retente
        state = {}
    if not pass_due(now, state.get("last_pass")):
        out["reason"] = "not_due"
        return out

    try:
        (pass_fn or _default_pass)(local_iso)
        out["passed"] = True
    except Exception as exc:      # noqa: BLE001
        out["reason"] = "error"
        logger.warning("paper coach_trader: passe quotidienne en panne (%s)",
                       type(exc).__name__)

    # ARMÉ APRÈS LA TENTATIVE, quel qu'en soit le résultat (cf. docstring).
    try:
        state = dict(state)
        state["last_pass"] = state_iso
        save_state(state)
    except Exception as exc:      # noqa: BLE001
        logger.warning("paper coach_trader: état de passe non persisté (%s)",
                       type(exc).__name__)
    return out
