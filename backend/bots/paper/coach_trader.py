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

**LOT 5 — le short est OUVERT au coach.** Vécu en prod : quatre passes de
suite se sont soldées par un refus d'entrer, parce que ses meilleures thèses
étaient BAISSIÈRES et donc « inexécutables en achat seul ». Le moteur d'ordres
savait déjà vendre à découvert (un humain le peut depuis le premier lot) ;
c'était le MANDAT qui l'interdisait. ``short`` et ``cover`` sont désormais des
actions de plein droit, avec le miroir EXACT des exigences du long — stop
obligatoire, mais AU-DESSUS de l'entrée. S'y ajoute ``adjust_stop``, qui ne
sait faire qu'une chose : RESSERRER (cf. :func:`_gate_adjust_stop`).

⚠️ **Non-fantôme** : les fichiers de ce lot (``<user>.ledger.json``,
``<user>.equity.json``, ``coach_trader.state.json``) vivent dans le MÊME
répertoire que les comptes. Ils sont déclarés dans les trois recensements du
paquet (``newswatch._discover_portfolios``, ``weekly._AUX_SUFFIXES``,
``radar._NON_USER_FILES``) — sans quoi ils fabriqueraient exactement les
« traders fantômes » que le dépôt a déjà eu à faire disparaître.
"""
import json
import re
from datetime import datetime, timedelta, timezone
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

# Les trois familles d'actions, NOMMÉES. Le prompt les cite par ces constantes
# ; il les découpait auparavant par index (``ACTION_KINDS[1:]`` valait « les
# sorties »), ce qui devenait FAUX à la seconde où une entrée s'ajoutait au
# tuple. Une famille se nomme, elle ne se déduit pas d'une position.
ENTRY_ACTIONS = ("buy", "short")            # ouvrent ou renforcent une ligne
EXIT_ACTIONS = ("sell", "reduce", "cover")  # réduisent l'exposition
ACTION_KINDS = ENTRY_ACTIONS + EXIT_ACTIONS + ("adjust_stop", "cancel_pending")

# LOT 9 — LES EMBUSCADES. Une ENTRÉE peut désormais être ARMÉE sur un niveau
# (``kind="stop"`` + ``trigger``) au lieu de partir au marché : le moteur
# exécute à la minute où le cours franchit le seuil, nuit comprise. C'est le
# vrai « ne plus attendre » — le coach guettait « une clôture sous la SMA50 »
# à chaque passe, une embuscade purement MENTALE que rien n'exécutait.
ORDER_PLANS = ("market", "stop")   # les deux formes qu'une entrée peut prendre

# Le sens de position que chaque action manipule. ``reduce`` est ABSENT
# volontairement : il dit « allège » sans dire dans quel sens, et c'est la
# ligne DÉJÀ DÉTENUE qui tranche (le moteur interdit de tenir les deux sens sur
# un même titre, il n'y a donc jamais d'ambiguïté).
_SIDE_OF_ACTION = {"buy": "long", "sell": "long",
                   "short": "short", "cover": "short"}

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

# --- Embuscades (LOT 9) --------------------------------------------------- #
MAX_PENDING = 4           # pièges armés simultanément, au plus
# Le risque CUMULÉ des pièges armés, en % de l'équité. Deux trades pleins.
# Pourquoi un plafond distinct, plus serré que le cumul toléré sur les lignes
# ouvertes : une embuscade part SANS que personne regarde. Quatre pièges à
# 2 % chacun qui se déclenchent sur le MÊME choc de marché coûteraient 8 % du
# livre en une nuit, et le coach n'aurait rien vu venir. Il doit choisir.
MAX_PENDING_RISK_PCT = 4.0
# Un piège qui dort trois semaines s'est armé sur un marché qui n'existe plus.
AMBUSH_MARKET_DAYS = 5

RUN_AFTER_HOUR = 17       # ancienne passe unique : jamais avant 17 h LOCALES

# --------------------------------------------------------------------------- #
# BUDGET COACH — mois x20 (LOT 8 : cadence resserrée)
#
# Le plan Claude Max est à x20 : le budget d'appels DU COACH (et de lui
# seul — aucun autre consommateur du dépôt ne bouge) est desserré pour le
# pousser au maximum de ses capacités — mais INTELLIGEMMENT : des appels
# quand les marchés sont OUVERTS et quand le marché BOUGE (cf. le GARDIEN
# plus bas), jamais du bruit. Tout est ICI, en un bloc, pour qu'un retour au
# régime normal soit une modification de CONSTANTES et rien d'autre : remettre
# ``WEEKDAY_SLOTS`` à un seul créneau suffit.
#
# COÛT RÉEL, pire cas d'un jour ouvré :
#     8 créneaux x 2 appels (tri + dossier) = 16 appels
#   + 1 appel de digest (la couche convergence, inchangée)
#   + le GARDIEN (:data:`MAX_GUARDIAN_CALLS_PER_DAY` par position ouverte AU
#     PLUS, et seulement quand le marché BOUGE — la plupart des créneaux de
#     5 min ne déclenchent RIEN)
#   ≈ 20-30 appels/jour ouvré EN PRATIQUE (le plafond théorique est plus haut,
#   mais un créneau où le tri ne retient rien ne coûte qu'UN appel, et le
#   gardien ne parle que sur mouvement réel). Week-end : 2 créneaux CRYPTO
#   uniquement (cf. :func:`tradable_now`) + digest + gardien.
#
# Heures LOCALES (Europe/Rome), et elles ont chacune une raison :
#   09:10 — l'Europe vient d'ouvrir (09:05) : le coach peut ENFIN jouer les
#           actions européennes (.SW/.PA/.DE/.F/.MI/.AS/.MC/.L) dès le matin,
#           plutôt que d'attendre le créneau de fin d'après-midi.
#   11:30 — mi-matinée européenne : les premières tendances du jour se lisent.
#   14:00 — avant l'ouverture US, l'Europe est bien établie.
#   15:40 — dix minutes avant l'ouverture de New York : l'Europe a fait sa
#           journée, les futures US disent ce qui vient.
#   17:00 — première heure de la séance US : les réactions à l'ouverture.
#   18:30 — l'Europe est fermée (17:25), la séance US bat son plein.
#   20:00 — après-midi américaine.
#   21:40 — dernière heure américaine : c'est là que les séances se décident.
# --------------------------------------------------------------------------- #
WEEKDAY_SLOTS = ("09:10", "15:40", "21:40")
# REGIME SEPTEMBRE (03/09) : le x20 d'aout est fini — le compte Max est
# PARTAGE entre le coach et les sessions de developpement, et la soiree du
# 02/09 (6 passes affamees de 16h a minuit) a montre le plafond. 3 creneaux :
# matin EU, ouverture US, derniere heure US. Les convergences, le gardien
# (declenche sur mouvement reel) et les embuscades mecaniques couvrent le
# reste. Remonter = restaurer le tuple du regime x20 ci-dessous :
#   ("09:10", "11:30", "14:00", "15:40", "17:00", "18:30", "20:00", "21:40")
WEEKEND_SLOTS = ("11:00", "18:00")   # crypto UNIQUEMENT (cf. :func:`tradable_now`)
PASSES_PER_DAY = len(WEEKDAY_SLOTS)
MAX_FOCUS = 4                       # dossiers instruits par créneau, au plus
LLM_CALLS_PER_PASS = 2              # tri, puis dossier — jamais davantage

# Un seul seuil de thèse dans tout le simulateur — ``risk`` le porte déjà pour
# la porte de confirmation humaine (LOT 3, C3). On le RÉUTILISE plutôt que d'en
# poser un second qui divergerait au premier ajustement.
MIN_THESIS_LEN = risk.PREORDER_MIN_THESIS_LEN

# Les 18 codes de refus. ``reason`` est TOUJOURS l'un d'eux, JAMAIS une phrase :
# la traduction (fr/en/it) vit dans ``lang.js``, comme partout ailleurs.
#
# Les trois avant-derniers arrivent avec le LOT 5 :
#   ``wrong_side``    — ouvrir à l'envers d'une ligne déjà tenue (le moteur le
#                       refuserait de toute façon, mais trois étages plus bas
#                       et avec un message technique) ;
#   ``stop_widen``    — un stop qui S'ÉLOIGNE n'est pas une gestion, c'est
#                       l'annulation d'une décision déjà prise ;
#   ``market_closed`` — le marché DE CE SYMBOLE est fermé à cet instant
#                       (:func:`tradable_now`, LOT 8 — généralisé depuis le
#                       simple « créneau du week-end » du LOT 6).
# Le dernier arrive avec le LOT 8 :
#   ``out_of_scope``  — décision hors du PÉRIMÈTRE du gardien
#                       (:func:`guardian_gate`) : mauvais symbole, ou
#                       tentative d'ouvrir une ligne NEUVE.
REJECT_CODES = (
    "unknown_action", "no_symbol", "bad_qty", "no_quote",
    "no_thesis", "no_stop", "risk_high", "too_small", "oversize",
    "too_many_positions", "too_many_crypto", "cash_floor",
    "no_position", "qty_over_position",
    "wrong_side", "stop_widen", "market_closed", "out_of_scope",
    # LOT 9 — les embuscades : forme de l'ordre, niveau d'armement, cap,
    # risque cumulé des pièges, et l'annulation d'un piège inexistant.
    "bad_kind", "bad_trigger", "too_many_pending", "pending_risk_high",
    "no_pending",
)

# D'où vient une décision : du digest quotidien, de la passe planifiée (créneau),
# ou du GARDIEN (LOT 8 — la sentinelle déclenchée par un mouvement de marché
# entre deux créneaux). Constante de CONTRAT pour les appelants — le registre,
# lui, archive ce qu'on lui donne sans le policer (une trace ne valide pas,
# elle consigne).
SOURCES = ("digest", "daily", "guardian")

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


def _pos_side(pos: Dict[str, Any]) -> str:
    """Le sens d'une ligne persistée ; ``long`` par défaut (c'est la convention
    de ``models.Position``, dont le champ vaut ``"long"`` s'il manque)."""
    return (_text(pos.get("side")) or "long").lower()


# Longueur d'une ligne de THÈME rendue au modèle. Assez pour reconnaître un
# catalyseur (« blocage d'Ormuz », « tarifs sur l'acier »), trop court pour
# recopier la thèse entière : ce bloc doit rester PETIT, il est réinjecté dans
# TROIS prompts à chaque passe.
MAX_THEME_LEN = 140


def deployment_view(portfolio: Any) -> Dict[str, Any]:
    """Le DÉPLOIEMENT du livre, en trois chiffres lisibles (PUR — LOT 9).

    Né d'un vécu : le coach tenait UNE ligne et attendait, passe après passe,
    « une clôture sous la SMA50 » — une embuscade purement MENTALE, re-jugée
    passivement à chaque réveil. Le mandat lui demande désormais d'être
    DÉPLOYÉ ; encore faut-il qu'il SACHE où il en est. Un modèle ne compte pas
    ses lignes de façon fiable dans un JSON de contexte : on lui donne le
    chiffre.

    Rend ``{"cash_pct", "n_positions", "themes_ouverts"}``.

    ``cash_pct`` suit la convention du GARDE-FOU (:func:`_equity_chf`, prix de
    revient, les deux sens en valeur absolue) et non celle de l'affichage : le
    prompt lui dit « si ton cash dépasse 50 % de l'équité, justifie-toi », et
    c'est cette équité-là qui le REFUSERA ensuite. Deux chiffres différents
    rendraient la consigne inapplicable.

    ``themes_ouverts`` n'est PAS une taxonomie. On ne classe pas
    automatiquement un thème (« carburant/Iran » ne se déduit d'aucun champ
    persisté, et une classification inventée mentirait) : on rend les THÈSES
    ouvertes, une par ligne, tronquées. C'est le modèle qui juge si son
    prochain pari est le MÊME catalyseur ou un pari indépendant — exactement
    le jugement qu'il faisait déjà correctement en refusant UAL et LUV quand
    il tenait DAL.

    **NE LÈVE JAMAIS** : un portefeuille abîmé rend la vue neutre (0/0/[]),
    ce que le bloc de prompt sait afficher sans mentir.
    """
    book = portfolio if isinstance(portfolio, dict) else {}
    positions = _dicts(book.get("positions"))
    equity = _equity_chf(book.get("cash_chf"), positions)
    cash = _val(book.get("cash_chf")) or 0.0

    themes: List[str] = []
    for pos in positions:
        symbol = _symbol(pos.get("symbol")) or "?"
        thesis = _text(pos.get("thesis")) or "(sans thèse écrite)"
        line = "%s (%s) — %s" % (symbol, _pos_side(pos), thesis)
        if len(line) > MAX_THEME_LEN:
            line = line[:MAX_THEME_LEN - 1].rstrip() + "…"
        themes.append(line)

    return {
        "cash_pct": round(cash / equity * 100.0, 1) if equity > 0 else 0.0,
        "n_positions": len(positions),
        "themes_ouverts": themes,
    }


def pending_ambushes(portfolio: Any) -> List[Dict[str, Any]]:
    """Les EMBUSCADES ARMÉES d'un livre (PUR — LOT 9).

    Une embuscade est un ordre ``open`` de forme ``kind="stop"`` sur un
    ``side`` d'ENTRÉE (``buy``/``short``). Le filtre est strict des DEUX côtés :

    - un ordre LIMITE en attente n'en est pas une (le coach en pose un à chaque
      objectif — les compter ferait sauter le cap au bout de quatre gains) ;
    - un ``stop`` de PROTECTION non plus : il vit sur la Position
      (``stop_loss``), jamais dans ``open_orders``.
    """
    book = portfolio if isinstance(portfolio, dict) else {}
    out = []
    for order in _dicts(book.get("open_orders")):
        if _text(order.get("status") or "open").lower() != "open":
            continue
        if _text(order.get("kind")).lower() != "stop":
            continue
        if _text(order.get("side")).lower() not in ENTRY_ACTIONS:
            continue
        out.append(order)
    return out


def _pending_risk_chf(ambushes: List[Dict[str, Any]]) -> float:
    """Somme des pertes PLANIFIÉES des pièges armés, déjà en CHF.

    On lit ``risk_chf``, calculé À L'ARMEMENT avec le taux de change du
    moment : l'ordre persisté ne porte pas son ``fx_rate``, et le recalculer
    ici avec un taux d'aujourd'hui serait faux. Un piège sans ``risk_chf``
    compte pour 0 — il n'y en a pas (le router le pose systématiquement), et
    inventer un chiffre serait pire que de l'ignorer.
    """
    total = 0.0
    for order in ambushes:
        total += abs(_val(order.get("risk_chf")) or 0.0)
    return total


def market_days_after(moment: Any, days: int = AMBUSH_MARKET_DAYS) -> str:
    """L'horodatage ISO de ``moment`` + ``days`` JOURS DE MARCHÉ (PUR).

    « Jour de marché » = jour de semaine : on saute samedi et dimanche. C'est
    volontairement une règle UNIQUE, y compris pour les cryptos qui cotent le
    week-end — deux calendriers de péremption pour une même liste d'ordres
    seraient une source de bug silencieux, et l'écart (deux jours) n'a aucune
    conséquence sur un piège dont la durée de vie est de toute façon un ordre
    de grandeur, pas une minute.

    Date illisible -> chaîne VIDE : un ordre sans péremption ne périme jamais
    (cf. :func:`is_expired`), ce qui est le comportement d'AVANT ce lot.
    """
    start = _parse_iso(moment) if isinstance(moment, str) else None
    if start is None and isinstance(moment, datetime):
        start = moment if moment.tzinfo else moment.replace(tzinfo=timezone.utc)
    if start is None:
        return ""
    try:
        left = max(0, int(days))
    except (TypeError, ValueError):
        left = AMBUSH_MARKET_DAYS
    current = start
    while left > 0:
        current = current + timedelta(days=1)
        if current.weekday() < 5:
            left -= 1
    return current.isoformat()


def is_expired(order: Any, now: Any) -> bool:
    """Ce piège a-t-il dépassé sa date ? (PUR)

    Sans ``expires_at``, JAMAIS — c'est le cas de tous les ordres d'avant ce
    lot et de ceux d'un humain, qu'on ne doit pas se mettre à annuler.
    """
    row = order if isinstance(order, dict) else {}
    limit = _parse_iso(row.get("expires_at"))
    if limit is None:
        return False
    moment = _parse_iso(now) if isinstance(now, str) else None
    if moment is None and isinstance(now, datetime):
        moment = now if now.tzinfo else now.replace(tzinfo=timezone.utc)
    if moment is None:
        return False
    return moment > limit


def _held(positions: List[Dict[str, Any]], symbol: str, side: str) -> float:
    """Quantité détenue sur ce symbole DANS CE SENS, toutes lignes confondues.

    Le sens compte, et il compte dans les deux directions : une ligne vendue à
    découvert ne se solde pas par une vente (``sell``) mais par un rachat
    (``cover``), et confondre les deux DOUBLERAIT l'exposition au lieu de la
    fermer.
    """
    total = 0.0
    for pos in positions:
        if _symbol(pos.get("symbol")) != symbol or _pos_side(pos) != side:
            continue
        qty = _val(pos.get("qty"))
        if qty is not None:
            total += abs(qty)
    return total


def _line_of(positions: List[Dict[str, Any]], symbol: str) -> Optional[Dict[str, Any]]:
    """La PREMIÈRE ligne tenue sur ce symbole, quel qu'en soit le sens.

    Le moteur d'ordres interdit de tenir un achat ET une vente à découvert sur
    le même titre (``_open_long``/``_open_short`` se refusent mutuellement) :
    « la première » est donc « la seule », et c'est elle qui dit dans quel sens
    on est engagé — l'information dont ``reduce`` et ``adjust_stop`` ont besoin
    pour ne pas avoir à la deviner.
    """
    for pos in positions:
        if _symbol(pos.get("symbol")) == symbol:
            return pos
    return None


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

def gate_decision(decision: Any, portfolio: Any, quote: Any,
                  now: Any = None) -> Dict[str, Any]:
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

    ``now`` (LOT 8, remplace le ``crypto_only`` de LOT 5) : l'instant de la
    décision. Sert à :func:`tradable_now` à juger, SYMBOLE PAR SYMBOLE, si le
    marché de ``symbol`` est ouvert MAINTENANT ; sinon l'ordre est refusé
    (``market_closed``) au lieu de dormir jusqu'à la réouverture sous un prix
    que personne n'a vu. Déplacer un stop reste permis — ce n'est pas une
    exécution. ``now`` est OPTIONNEL : ``None`` (par défaut) désactive ce
    contrôle — un appelant qui ne s'occupe pas des horaires de marché continue
    de voir un marché ouvert.

    Ordre des contrôles — le PREMIER échec gagne, et cet ordre est DÉTERMINISTE
    (épinglé par les tests) parce qu'il décide ce que l'utilisateur lira quand
    deux règles sont violées à la fois : on nomme d'abord le problème le plus
    grossier (la décision est-elle seulement lisible ?) avant le plus fin (la
    taille est-elle raisonnable ?).

      1. ``unknown_action`` — action absente ou hors :data:`ACTION_KINDS`.
      2. ``no_symbol``
      3. ``market_closed`` — le marché de ``symbol`` est fermé à cet instant
         (:func:`tradable_now`). Placé AVANT la quantité et le cours : l'heure
         ferme le marché pour tout le monde, il n'y a pas à examiner un ordre
         qui ne partira pas.
      4. ``adjust_stop`` prend sa propre porte (:func:`_gate_adjust_stop`) —
         il n'échange rien, ni quantité ni taille ne le concernent.
      5. ``bad_qty`` — sauf pour ``sell``/``cover`` sans quantité : « tout
         solder ».
      6. ``no_quote`` — sans prix ni taux valides, aucun contrôle de taille
         n'a de sens ; refuser vaut mieux que calculer sur un chiffre inventé.
      7. SORTIE (``sell``/``cover``/``reduce``) : ``no_position``,
         ``qty_over_position``.
      8. ENTRÉE (``buy``/``short``) : ``wrong_side``, ``no_thesis``,
         ``no_stop``, ``risk_high``, ``too_small``, ``oversize``,
         ``too_many_positions``, ``too_many_crypto``, ``cash_floor``.
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

    positions = _dicts(portfolio.get("positions"))
    ambushes = pending_ambushes(portfolio)

    # LOT 9 — la FORME de l'ordre, lue avant tout le reste : c'est elle qui
    # décide si la décision est une exécution (soumise à l'heure de marché) ou
    # une consigne au CARNET (qui n'agira que plus tard).
    plan_kind = _text(decision.get("kind")).lower() or "market"
    if plan_kind not in ORDER_PLANS:
        # On REJETTE, on ne rogne pas : servir un ordre au marché à qui a
        # demandé une limite serait exactement la dégradation silencieuse que
        # ce module s'interdit (cf. tête de fichier).
        return _reject("bad_kind")
    if plan_kind == "stop" and action not in ENTRY_ACTIONS:
        # Une SORTIE ne s'arme pas dans ce lot : le stop de PROTECTION d'une
        # ligne vit sur la position elle-même, pas dans le carnet.
        return _reject("bad_kind")

    # Marché fermé : seules les consignes au CARNET gardent un sens, puisqu'elles
    # n'agiront qu'à la réouverture — déplacer un stop, retirer une embuscade,
    # et ARMER une embuscade (c'est tout son intérêt : le piège ne s'exécute
    # pas maintenant ; l'interdire reviendrait à ne pouvoir l'armer qu'aux
    # heures où l'on pourrait déjà agir directement). ``now`` absent -> aucun
    # contrôle (cf. docstring) : sans horloge, rien à juger.
    if now is not None and action not in ("adjust_stop", "cancel_pending") \
            and plan_kind != "stop" and not tradable_now(symbol, now):
        return _reject("market_closed")

    if action == "cancel_pending":
        return _gate_cancel_pending(symbol, ambushes)

    if action == "adjust_stop":
        return _gate_adjust_stop(symbol, decision, positions, quote)

    qty_raw = decision.get("qty")
    qty = _as_qty(qty_raw)
    if qty is None and not (action in ("sell", "cover")
                            and _is_blank_qty(qty_raw)):
        # ``reduce`` = allègement PARTIEL : sans quantité il n'y a pas d'ordre.
        return _reject("bad_qty")

    price = _val(quote.get("price"))
    fx = _val(quote.get("fx_rate"))
    if price is None or price <= 0 or fx is None or fx <= 0:
        return _reject("no_quote")

    # ----------------------------------------------------------------- #
    # SORTIE — n'exige QUE l'existence de la position.
    #
    # Une sortie réduit TOUJOURS l'exposition : elle n'a besoin ni de thèse ni
    # de stop (même restriction que ``risk.preorder_warnings``, qui ne
    # s'applique qu'aux ouvertures), et aucun plafond de taille ne la concerne.
    #
    # ``reduce`` lit le SENS de la ligne qu'il trouve : « allège » ne dit pas
    # dans quel sens, et le deviner à l'envers doublerait l'exposition. Les
    # deux autres l'imposent — ``sell`` solde un achat, ``cover`` un short.
    # ----------------------------------------------------------------- #
    if action in EXIT_ACTIONS:
        if action == "reduce":
            line = _line_of(positions, symbol)
            wanted = _pos_side(line) if line is not None else "long"
        else:
            wanted = _SIDE_OF_ACTION[action]
        held = _held(positions, symbol, wanted)
        if held <= 0:
            return _reject("no_position")
        if qty is None:
            qty = int(held)          # « tout solder »
        if qty > held:
            return _reject("qty_over_position")
        return _accept(symbol, "sell" if wanted == "long" else "cover",
                       qty, decision)

    # ----------------------------------------------------------------- #
    # ENTRÉE
    # ----------------------------------------------------------------- #
    wanted = _SIDE_OF_ACTION[action]          # "long" pour buy, "short" pour short
    opposite = "short" if wanted == "long" else "long"
    if _held(positions, symbol, opposite) > 0:
        # Le moteur d'ordres refuserait aussi, mais trois étages plus bas et
        # avec un message technique. Le mandat le dit ici, avec son code.
        return _reject("wrong_side")
    held = _held(positions, symbol, wanted)

    thesis = _text(decision.get("thesis"))
    if len(thesis) < MIN_THESIS_LEN:
        return _reject("no_thesis")

    # LOT 9 — le NIVEAU DE RÉFÉRENCE de tous les contrôles qui suivent. Pour un
    # ordre au marché c'est le cours ; pour une EMBUSCADE c'est le TRIGGER,
    # parce que c'est là que l'entrée aura lieu. Mesurer le risque d'un piège
    # armé à 110 contre un cours de 100 donnerait un chiffre FAUX — et le
    # piège partirait à 110 avec un risque jamais contrôlé.
    trigger = None
    if plan_kind == "stop":
        trigger = _val(decision.get("trigger"))
        if trigger is None or trigger <= 0:
            return _reject("bad_trigger")
        # Un piège du mauvais côté du cours partirait au premier tick : ce
        # n'est pas une embuscade, c'est un ordre au marché déguisé.
        armable = trigger > price if wanted == "long" else trigger < price
        if not armable:
            return _reject("bad_trigger")
        if len(ambushes) >= MAX_PENDING:
            return _reject("too_many_pending")

    entry = trigger if trigger is not None else price

    stop = _val(decision.get("stop"))
    if stop is None or not _stop_protects(wanted, stop, entry):
        # Un « stop » au-dessus du prix d'entrée d'un long ne protège rien :
        # c'est l'absence de stop, pas un stop large. Le miroir vaut pour un
        # short, dont l'invalidation est AU-DESSUS.
        return _reject("no_stop")

    equity = _equity_chf(portfolio.get("cash_chf"), positions)
    level_chf = entry * fx
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
    #
    # LOT 9 — les EMBUSCADES ARMÉES sont des fronts PROJETÉS : si les quatre
    # pièges partaient tous, le livre doit rester dans les règles. Sans ça, le
    # sur-armement serait invisible — on tiendrait 6 lignes après avoir armé
    # 4 pièges sur un livre qui n'en tolère que 6 au total.
    fronts = {_symbol(p.get("symbol")) for p in positions}
    fronts |= {_symbol(a.get("symbol")) for a in ambushes}
    fronts.add(symbol)
    fronts.discard("")
    if len(fronts) > MAX_POSITIONS:
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
    #
    # ⚠️ Une VENTE À DÉCOUVERT n'achète rien : elle ne peut pas mettre le
    # compte à sec, et lui appliquer le plancher interdirait de shorter dès
    # que la trésorerie est investie. Sa contrainte à elle est la MARGE, que
    # le moteur d'ordres fait respecter (``_open_short``).
    if wanted == "long":
        cash = _val(portfolio.get("cash_chf")) or 0.0
        if cash - value_chf < equity * MIN_CASH_PCT / 100.0:
            return _reject("cash_floor")

    # LOT 9 — le risque CUMULÉ des pièges, en tout dernier (le contrôle le plus
    # fin). Il ne s'applique QU'À une embuscade : un ordre au MARCHÉ est jugé
    # sur SON risque (``risk_high``) et ne doit pas être empêché parce que des
    # pièges dorment — le mandat déployé demande d'agir, pas de s'auto-bloquer.
    #
    # ⚠️ Le plancher de trésorerie, lui, n'est PAS projeté sur les pièges
    # armés : l'ordre persisté ne porte pas son taux de change, et le
    # recalculer avec un taux d'aujourd'hui serait faux. Le MOTEUR d'ordres a
    # le dernier mot au moment du fill (trésorerie réellement insuffisante ->
    # ``OrderError`` -> le piège est annulé proprement par le tick), exactement
    # la doctrine déjà retenue pour les frais plus haut.
    if plan_kind == "stop":
        cumul = _pending_risk_chf(ambushes) + abs(level_chf - stop_chf) * qty
        if cumul > equity * MAX_PENDING_RISK_PCT / 100.0:
            return _reject("pending_risk_high")

    return _accept(symbol, action, qty, decision, kind=plan_kind,
                   trigger=trigger)


def _stop_protects(side: str, stop: float, price: float) -> bool:
    """Le stop est-il du bon côté du cours pour protéger cette ligne ?

    Un long s'invalide EN DESSOUS, un short AU-DESSUS. Un stop du mauvais côté
    partirait à la seconde même : ce n'est pas une protection large, c'est une
    sortie déguisée — et on la refuse sous le même code que son absence, parce
    que dans les deux cas la ligne n'est pas protégée.
    """
    return stop < price if side == "long" else stop > price


def _gate_adjust_stop(symbol: str, decision: Dict[str, Any],
                      positions: List[Dict[str, Any]],
                      quote: Dict[str, Any]) -> Dict[str, Any]:
    """Déplacer le stop d'une ligne ouverte — il ne peut QUE se resserrer.

    C'est ce qui rend tenable la consigne « laisse courir les gagnants » : sans
    ce geste, la seule façon de protéger un gain serait de solder la ligne,
    exactement ce qu'on lui reproche. Mais le mouvement est à SENS UNIQUE — un
    stop qui s'éloigne n'est pas une gestion, c'est l'annulation d'une décision
    déjà prise, et c'est par là que les petites pertes deviennent grandes.

    Resserrer, c'est MONTER pour un long et DESCENDRE pour un short. Une ligne
    sans stop accepte n'importe quel niveau valide : son invalidation était à
    l'infini, tout niveau la rapproche.

    Aucune quantité n'est demandée : rien ne s'échange.
    """
    line = _line_of(positions, symbol)
    if line is None:
        return _reject("no_position")

    stop = _val(decision.get("stop"))
    if stop is None:
        return _reject("no_stop")

    side = _pos_side(line)
    price = _val(quote.get("price"))
    if price is not None and price > 0 and not _stop_protects(side, stop, price):
        return _reject("no_stop")

    current = _val(line.get("stop_loss"))
    if current is not None:
        tighter = stop > current if side == "long" else stop < current
        if not tighter:
            return _reject("stop_widen")

    return _accept(symbol, "adjust_stop", 0, decision)


def _gate_cancel_pending(symbol: str,
                        ambushes: List[Dict[str, Any]]) -> Dict[str, Any]:
    """Retirer une EMBUSCADE armée (PUR — LOT 9).

    Rien ne s'échange : c'est une consigne au carnet, permise marché fermé.
    Le seul contrôle est l'EXISTENCE du piège — annuler dans le vide donnerait
    une ligne de registre « accepté » pour un geste qui n'a rien fait, et le
    registre doit dire la vérité. Un ordre LIMITE d'objectif n'est pas visé :
    il n'est pas une embuscade (cf. :func:`pending_ambushes`), et le retirer
    laisserait une position ouverte sans son objectif, en silence.
    """
    if not any(_symbol(a.get("symbol")) == symbol for a in ambushes):
        return _reject("no_pending")
    return _accept(symbol, "cancel_pending", 0, {})


def _accept(symbol: str, side: str, qty: int,
            decision: Dict[str, Any], kind: str = "market",
            trigger: Optional[float] = None) -> Dict[str, Any]:
    """L'ordre normalisé, prêt pour le moteur d'ordres du simulateur.

    ``side`` est un sens du MOTEUR (``models.ORDER_SIDES``), pas le nom de
    l'action : ``reduce`` rend ``sell`` ou ``cover`` selon la ligne trouvée —
    la différence n'est pas dans l'exécution (une vente est une vente) mais
    dans l'INTENTION, déjà consignée au registre.

    ``adjust_stop`` est le seul ``side`` qui ne soit pas un ordre : il ne passe
    pas par le moteur, il repose le ``stop_loss`` de la ligne. Sa quantité vaut
    0 — rien ne s'échange.

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
            # LOT 9 — ``market`` (exécution immédiate) ou ``stop`` (EMBUSCADE
            # armée sur ``trigger``, exécutée par le tick quand le niveau
            # casse). ``trigger`` vaut ``None`` pour tout le reste.
            "kind": kind,
            "trigger": trigger,
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
def _block_re(marker: str):
    """L'expression qui isole un bloc de clôture nommé ``marker``.

    Fabriquée plutôt que constante depuis le LOT 5 : le processus en deux temps
    lit DEUX blocs de forme identique (``COACH_FOCUS`` au tri, ``COACH_ACTIONS``
    au dossier), et deux expressions écrites à la main auraient divergé au
    premier ajustement de tolérance.
    """
    return re.compile(r"```[ \t]*" + marker + r"[ \t]*\r?\n(.*?)(?:```|\Z)",
                      re.DOTALL | re.IGNORECASE)


_BLOCK_RE = _block_re(ACTIONS_MARKER)

# Le bloc du PREMIER temps : le tri. Le modèle y désigne les ≤3 dossiers qu'il
# veut instruire ; c'est ce qui décide si un second appel part.
FOCUS_MARKER = "COACH_FOCUS"
_FOCUS_RE = _block_re(FOCUS_MARKER)


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


def parse_focus(text: Any) -> Dict[str, Any]:
    """Le bloc du PREMIER temps : les dossiers que le coach veut instruire (PUR).

    Rend ``{"text": str, "focus": [symboles], "note": str|None, "error": None|
    "no_block"|"parse_failed"}`` — le miroir exact de :func:`parse_actions`,
    dont il partage le lecteur de bloc et la tolérance.

    **Pourquoi ce tri existe** : le contexte complet (livre, candidats, radar,
    agenda, humeur) suffit à REPÉRER ce qui mérite un examen, pas à le
    DÉCIDER. Le deuxième appel, lui, ne reçoit que trois titres mais tout ce
    qu'on sait d'eux — analyse technique, presse récente, dossier historique,
    mouvements de gérants. Un seul appel qui porterait ces dossiers pour vingt
    candidats serait illisible autant qu'inabordable.

    Un tri VIDE est une réponse légitime (« rien ne mérite un dossier
    aujourd'hui ») et coûte alors UN SEUL appel au modèle.

    Les symboles sont canonisés en majuscules et dédoublonnés dans l'ordre
    d'apparition, puis plafonnés à :data:`MAX_FOCUS` — un modèle bavard ne doit
    pas faire exploser le coût du second appel. Une entrée qui n'est pas une
    chaîne est ÉCARTÉE : un nombre n'est pas un ticker (même doctrine que
    :func:`_symbol`).
    """
    body = text if isinstance(text, str) else ""
    matches = list(_FOCUS_RE.finditer(body))
    if not matches:
        return {"text": _tidy(body), "focus": [], "note": None,
                "error": "no_block"}

    cleaned = _tidy(_FOCUS_RE.sub("", body))
    try:
        payload = json.loads(matches[0].group(1).strip())
    except (TypeError, ValueError):
        return {"text": cleaned, "focus": [], "note": None,
                "error": "parse_failed"}

    if isinstance(payload, dict):
        raw = payload.get("focus")
    elif isinstance(payload, list):
        raw = payload
    else:
        return {"text": cleaned, "focus": [], "note": None,
                "error": "parse_failed"}
    if not isinstance(raw, list):
        return {"text": cleaned, "focus": [], "note": None,
                "error": "parse_failed"}

    focus: List[str] = []
    for item in raw:
        symbol = _symbol(item)
        if symbol and symbol not in focus:
            focus.append(symbol)
        if len(focus) >= MAX_FOCUS:
            break
    return {"text": cleaned, "focus": focus, "note": _note_of(payload),
            "error": None}


# --------------------------------------------------------------------------- #
# PUR — l'horloge (heure LOCALE, jamais celle du système)
# --------------------------------------------------------------------------- #

def _aware_utc(now: Any) -> datetime:
    """``now`` en ``datetime`` timezone-aware. Un naïf est traité comme UTC —
    même convention que ``weekly._aware_utc``.

    **LOT 6** : une chaîne ISO est PARSÉE (même tolérance que
    :func:`_parse_iso`, naïf traité comme UTC), pas ignorée. Sans ça, la
    passe FORCÉE (qui ne porte l'instant que sous forme d'une chaîne
    ``_now_iso()``) retombait silencieusement sur l'heure RÉELLE du système à
    chaque appel de ``crypto_only_at`` (LOT 6, retiré en LOT 8, remplacée par
    :func:`tradable_now`) — invisible en prod (c'est
    toujours « maintenant » de toute façon), mais rendait le calcul
    intestable à horloge figée, et surtout AUCUN appelant existant ne passait
    de chaîne ici avant ce lot (seul ``last_ts`` de :func:`pass_due` en
    recevait, via :func:`_parse_iso`) : zéro régression.
    """
    if isinstance(now, str):
        parsed = _parse_iso(now)
        if parsed is not None:
            return parsed
        now = None
    if not isinstance(now, datetime):
        now = datetime.now(timezone.utc)
    if now.tzinfo is None:
        now = now.replace(tzinfo=timezone.utc)
    return now


def _local(now: Any) -> datetime:
    """L'instant en heure de Rome — convention MAISON (LOT 4) : un horodatage
    NAÏF est DÉJÀ de l'heure locale (tout le simulateur parle en naïf local),
    seul un horodatage AWARE se convertit. VÉCU (31/08 14:00) : relire le naïf
    comme de l'UTC ajoutait +2 h fantômes → le coach a shorté UAL à 14:00,
    NYSE fermée, sur le cours figé de vendredi."""
    if isinstance(now, datetime) and now.tzinfo is None:
        return now.replace(tzinfo=ZoneInfo(LOCAL_TZ))
    if isinstance(now, str):
        parsed = _parse_iso_naive_as_local(now)
        if parsed is not None:
            return parsed.replace(tzinfo=ZoneInfo(LOCAL_TZ))
    return _aware_utc(now).astimezone(ZoneInfo(LOCAL_TZ))


def _parse_iso_naive_as_local(value: str) -> Optional[datetime]:
    """Chaîne ISO NAÏVE -> datetime naïf (déjà local) ; aware/illisible -> None
    (l'appelant retombe sur la conversion _aware_utc)."""
    raw = value.strip()
    if not raw:
        return None
    if raw[-1] in ("Z", "z"):
        return None
    try:
        parsed = datetime.fromisoformat(raw)
    except ValueError:
        return None
    if parsed.tzinfo is not None:
        return None
    return parsed


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


def slots_for(now: Any) -> tuple:
    """Les créneaux du JOUR de ``now`` (heure LOCALE), du plus tôt au plus tard.

    Huit en semaine, deux le week-end (cf. le bloc « BUDGET COACH »).
    """
    return WEEKEND_SLOTS if _local(now).weekday() > 4 else WEEKDAY_SLOTS


# --------------------------------------------------------------------------- #
# PUR — l'univers : quel marché, quelles heures (LOT 8)
#
# Remplace ``crypto_only_at`` (LOT 6), qui ne posait qu'une question binaire
# pour toute la passe (« est-on le week-end ? ») et ratait toute la semaine :
# un short US à 10h du matin Rome n'a JAMAIS eu de raison de passer (Wall
# Street n'ouvre qu'à 15h35 locales), et rien ne le refusait. Ici, la question
# se pose PAR SYMBOLE et PAR INSTANT — exactement ce que chaque décision
# individuelle a besoin de savoir.
# --------------------------------------------------------------------------- #

# Suffixes Yahoo des places EUROPÉENNES qu'on sait situer. Table FERMÉE : un
# suffixe absent d'ici n'est PAS une place inconnue par défaut — c'est une
# place qu'on refuse de DEVINER (cf. :func:`market_of`).
_EUROPE_SUFFIXES = (".SW", ".PA", ".DE", ".F", ".MI", ".AS", ".MC", ".L")

# ``.TO`` (Toronto) n'a pas sa propre fenêtre horaire : elle ouvre et ferme
# dans la même heure que Wall Street (9h30-16h heure de l'Est). L'approximation
# « horaires US » est DOCUMENTÉE ici, pas devinée en silence ailleurs.
_US_HOURS_SUFFIXES = (".TO",)

# Fenêtres locales (Europe/Rome), lundi-vendredi uniquement — ``((h,m), (h,m))``
# de l'ouverture à la fermeture. La crypto n'y figure pas : elle ne connaît ni
# jour ni heure (cf. :func:`tradable_now`).
_MARKET_WINDOWS = {
    "europe": ((9, 5), (17, 25)),
    "us": ((15, 35), (21, 55)),
}


def market_of(symbol: Any) -> str:
    """Le marché d'un symbole, DEVINÉ depuis sa FORME (PUR, aucun réseau) —
    ``"crypto"``/``"europe"``/``"us"``/``"unknown"``.

    Table FERMÉE, doctrine assumée : un suffixe qu'on ne sait pas situer rend
    ``"unknown"``, jamais un repli optimiste — on ne trade pas ce qu'on ne
    sait pas situer (cf. :func:`tradable_now`). Un symbole SANS suffixe est
    une action/ETF US par convention Yahoo (``AAPL``, ``DAL``…).
    """
    text = _symbol(symbol)
    if not text:
        return "unknown"
    if quotes.kind_from_symbol(text) == "crypto":
        return "crypto"
    if text.endswith("=X"):
        return "unknown"       # forex : hors du mandat du coach, aucune fenêtre connue
    if text.endswith(_EUROPE_SUFFIXES):
        return "europe"
    if text.endswith(_US_HOURS_SUFFIXES):
        return "us"
    if "." in text:
        return "unknown"       # un suffixe non recensé : on ne le devine pas
    return "us"


def tradable_now(symbol: Any, now: Any) -> bool:
    """Ce symbole s'échange-t-il À CET INSTANT ? (PUR, LOT 8)

    Crypto : 24 h/24, 7 j/7. Europe et US : lundi-vendredi, dans leur fenêtre
    LOCALE (Europe/Rome) respective (:data:`_MARKET_WINDOWS`) — c'est
    délibérément l'heure de Rome, pas celle de la place elle-même : c'est
    l'heure à laquelle le coach AGIT, la seule qui compte pour décider si son
    ordre partira ou dormira. Marché inconnu -> ``False`` : impossible de dire
    qu'une place est ouverte quand on ne sait même pas laquelle c'est.

    ``now`` accepte la même tolérance que :func:`pass_due`/:func:`_aware_utc`
    (``datetime`` naïf traité comme UTC, chaîne ISO parsée) — les 3 chemins
    (passe naturelle, forcée, digest) le portent parfois sous forme de chaîne.
    """
    market = market_of(symbol)
    if market == "crypto":
        return True
    window = _MARKET_WINDOWS.get(market)
    if window is None:
        return False
    local = _local(now)
    if local.weekday() > 4:
        return False
    (start_h, start_m), (end_h, end_m) = window
    minutes_now = local.hour * 60 + local.minute
    return start_h * 60 + start_m <= minutes_now <= end_h * 60 + end_m


def _slot_minutes(slot: Any) -> Optional[int]:
    """``"15:40"`` -> 940 minutes depuis minuit. Illisible -> ``None``."""
    text = _text(slot)
    parts = text.split(":")
    if len(parts) != 2:
        return None
    try:
        hours, minutes = int(parts[0]), int(parts[1])
    except (TypeError, ValueError):
        return None
    if not (0 <= hours < 24 and 0 <= minutes < 60):
        return None
    return hours * 60 + minutes


def due_slot(now: Any, state: Any) -> Optional[str]:
    """Quel créneau doit tourner MAINTENANT, ou ``None`` (PUR).

    On rend le DERNIER créneau atteint, s'il n'a pas déjà tourné aujourd'hui.

    ⚠️ **Un créneau manqué ne se rattrape PAS**, et c'est délibéré. La valeur
    de ces horaires est dans l'HEURE elle-même : 15h40 vaut « dix minutes avant
    l'ouverture de New York », pas « la première passe de la journée ». Le
    rattraper à 18 h ferait payer un appel au modèle pour une lecture dont le
    moment est passé, et enchaînerait deux passes en dix minutes sur un
    contexte identique. Une machine éteinte tout l'après-midi ne perd donc pas
    sa journée — elle reprend au créneau courant, qui est le seul encore vrai.

    Une passe par créneau et par jour, comparée sur la DATE LOCALE (comme
    :func:`pass_due`) : un horodatage absent OU ILLISIBLE compte comme « jamais
    tourné » — mieux vaut une passe de trop qu'un compte qui cesse de trader en
    silence parce qu'un fichier a été touché à la main.
    """
    local = _local(now)
    minutes_now = local.hour * 60 + local.minute
    stamps = {}
    if isinstance(state, dict) and isinstance(state.get("slots"), dict):
        stamps = state["slots"]

    for slot in reversed(slots_for(now)):
        threshold = _slot_minutes(slot)
        if threshold is None or minutes_now < threshold:
            continue
        last = _parse_iso(stamps.get(slot))
        if last is None or _local(last).date() != local.date():
            return slot
        return None            # le créneau courant a déjà tourné
    return None


def arm_slot(state: Any, slot: Any, now_iso: Any) -> Dict[str, Any]:
    """L'état, ce créneau marqué comme ayant tourné (PUR, ne mute rien).

    Les autres créneaux sont CONSERVÉS : armer celui de 18 h ne doit pas
    effacer la trace de celui de 15h40, sinon le rattrapage le relancerait.
    """
    out = dict(state if isinstance(state, dict) else {})
    slots = out.get("slots")
    out["slots"] = dict(slots) if isinstance(slots, dict) else {}
    out["slots"][_text(slot)] = _text(now_iso)
    return out


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
# PUR — le GARDIEN (LOT 8) : la sentinelle déclenchée par le MARCHÉ, entre
# deux créneaux planifiés.
#
# « Profite du plan Max x20 pour faire PLUS D'APPELS » ne doit pas dire « plus
# de bruit » : les 8 créneaux du bloc BUDGET COACH couvrent le calendrier, le
# gardien couvre l'IMPRÉVU — un titre détenu qui décroche de 3 % à 15h12,
# entre le créneau de 14h00 et celui de 15h40, ne doit pas attendre 88 minutes
# pour être regardé. Il ne PROPOSE jamais d'idée neuve (cf. :func:`guardian_gate`) :
# il gère la ligne qui l'a réveillé, et rien d'autre.
# --------------------------------------------------------------------------- #

GUARDIAN_STATE_NAME = "coach_guardian.state.json"
GUARDIAN_SOURCE = "guardian"

GUARDIAN_COOLDOWN_MIN = 45          # minutes entre deux passes gardien sur le MÊME symbole
MAX_GUARDIAN_CALLS_PER_DAY = 4      # par symbole — le plafond que le bloc BUDGET COACH cite
GUARDIAN_MOVE_PCT = 2.0             # déclencheur A : |variation depuis le dernier regard|
GUARDIAN_STOP_PROXIMITY_PCT = 2.5   # déclencheur B : distance au stop — « ça chauffe »
GUARDIAN_TARGET_PROXIMITY_PCT = 1.5 # déclencheur C : distance à l'objectif — « ça mûrit »

# Les trois codes de déclencheur, DANS L'ORDRE DE SÉVÉRITÉ retenu par
# :func:`guardian_trigger` (le premier qui s'applique gagne) : un stop qui
# chauffe (risque de PERTE) prime sur un objectif qui mûrit (opportunité de
# GAIN), qui prime sur un simple mouvement (routine). Les trois peuvent
# survenir ensemble sur la même ligne ; un seul est nommé au modèle.
GUARDIAN_TRIGGERS = ("stop", "target", "move")

# Les seules actions qu'une décision GARDIEN a le droit de proposer (cf.
# :func:`guardian_gate`) : gérer la ligne existante, jamais en ouvrir une
# neuve — ``buy``/``short`` restent le privilège des passes planifiées, qui
# seules voient le CONTEXTE COMPLET (radar, candidats, agenda) nécessaire pour
# juger qu'une thèse neuve mérite d'entrer.
GUARDIAN_ALLOWED_ACTIONS = EXIT_ACTIONS + ("adjust_stop",)


def guardian_trigger(position: Any, live_price: Any, last_seen: Any) -> Optional[str]:
    """Le déclencheur du GARDIEN pour cette position, ou ``None`` (PUR, LOT 8).

    Un code de :data:`GUARDIAN_TRIGGERS`, le PREMIER qui s'applique dans
    l'ordre de sévérité documenté sur cette constante :

      - ``"stop"``   — distance au stop <= :data:`GUARDIAN_STOP_PROXIMITY_PCT`.
      - ``"target"`` — distance à l'objectif <= :data:`GUARDIAN_TARGET_PROXIMITY_PCT`.
      - ``"move"``   — |variation depuis le dernier regard| >= :data:`GUARDIAN_MOVE_PCT`.

    Distances calculées en VALEUR ABSOLUE (``|prix - niveau| / prix``) — à la
    différence de ``paper_router._coach_dist_pct`` (qui SIGNE selon le sens
    pour l'affichage), ce contrôle ne se soucie que de la PROXIMITÉ, pas de la
    direction : le sens ne change rien à la question « faut-il regarder cette
    ligne maintenant ? ».

    ``position`` : ``{"stop_loss", "target"}`` (les deux optionnels — une
    ligne sans l'un des deux ne peut simplement pas déclencher ce contrôle-là).
    ``live_price`` : le cours ACTUEL, illisible -> ``None`` (aucun calcul n'a
    de sens sans lui). ``last_seen`` : le DERNIER cours vu par le gardien à un
    tour précédent (``None`` -> premier regard, le déclencheur ``"move"`` ne
    peut pas se calculer).
    """
    price = _val(live_price)
    if price is None or price <= 0:
        return None

    position = position if isinstance(position, dict) else {}

    stop = _val(position.get("stop_loss"))
    if stop is not None and stop > 0 \
            and abs(price - stop) / price * 100.0 <= GUARDIAN_STOP_PROXIMITY_PCT:
        return "stop"

    target = _val(position.get("target"))
    if target is not None and target > 0 \
            and abs(price - target) / price * 100.0 <= GUARDIAN_TARGET_PROXIMITY_PCT:
        return "target"

    last = _val(last_seen)
    if last is not None and last > 0 \
            and abs(price - last) / last * 100.0 >= GUARDIAN_MOVE_PCT:
        return "move"

    return None


def guardian_decision(symbol: Any, position: Any, live_price: Any,
                      state: Any, now: Any) -> Dict[str, Any]:
    """Le gardien doit-il APPELER le modèle sur ce symbole MAINTENANT ? (PUR, LOT 8)

    Rend ``{"fire": bool, "trigger": str|None, "reason": str|None}``.
    ``trigger`` est le code de :func:`guardian_trigger`, posé dès qu'il existe
    même si ``fire`` est ``False`` (un cooldown/plafond BLOQUE un déclencheur
    RÉEL, il ne l'efface pas — utile pour le diagnostic). ``reason`` explique
    un ``fire=False`` : ``"no_price"``/``"market_closed"``/``"cooldown"``/
    ``"daily_cap"``, ou ``None`` si rien n'a simplement déclenché.

    Ordre des contrôles, le PREMIER qui bloque gagne :
      1. cours illisible -> ``"no_price"`` (rien à évaluer).
      2. marché fermé pour ce symbole MAINTENANT (:func:`tradable_now`) ->
         ``"market_closed"`` — un appel qui ne peut mener à AUCUN ordre
         exécutable est un appel gaspillé, vérifié AVANT le déclencheur.
      3. aucun déclencheur (:func:`guardian_trigger`) -> pas de raison,
         situation normale.
      4. cooldown non expiré (:data:`GUARDIAN_COOLDOWN_MIN` depuis le dernier
         appel SUR CE SYMBOLE) -> ``"cooldown"``.
      5. plafond quotidien atteint (:data:`MAX_GUARDIAN_CALLS_PER_DAY`, remis
         à zéro à la date LOCALE) -> ``"daily_cap"``.

    ``state`` : l'état PERSISTÉ du gardien, ``{symbole: {"last_price",
    "last_call", "calls_today", "calls_date"}}`` (:func:`load_guardian_state`)
    — TOLÉRANT, n'importe quelle forme absente/inattendue compte comme
    « jamais vu ». Ne LÈVE JAMAIS.
    """
    price = _val(live_price)
    if price is None or price <= 0:
        return {"fire": False, "trigger": None, "reason": "no_price"}

    try:
        symbol_text = _symbol(symbol)
        if not tradable_now(symbol_text, now):
            return {"fire": False, "trigger": None, "reason": "market_closed"}
    except Exception:      # noqa: BLE001 — horloge/symbole illisible : prudence
        return {"fire": False, "trigger": None, "reason": "market_closed"}

    sym_state = state.get(symbol_text) if isinstance(state, dict) else None
    sym_state = sym_state if isinstance(sym_state, dict) else {}

    trigger = guardian_trigger(position, price, sym_state.get("last_price"))
    if trigger is None:
        return {"fire": False, "trigger": None, "reason": None}

    last_call = _parse_iso(sym_state.get("last_call"))
    if last_call is not None:
        elapsed_min = (_aware_utc(now) - last_call).total_seconds() / 60.0
        if elapsed_min < GUARDIAN_COOLDOWN_MIN:
            return {"fire": False, "trigger": trigger, "reason": "cooldown"}

    local_day = _local(now).date().isoformat()
    calls_today = sym_state.get("calls_today") or 0
    if sym_state.get("calls_date") != local_day:
        calls_today = 0
    if calls_today >= MAX_GUARDIAN_CALLS_PER_DAY:
        return {"fire": False, "trigger": trigger, "reason": "daily_cap"}

    return {"fire": True, "trigger": trigger, "reason": None}


def guardian_seen(state: Any, symbol: Any, price: Any) -> Dict[str, Any]:
    """Le DERNIER cours vu par le gardien sur ce symbole, mis à jour (PUR).

    Appelé à CHAQUE regard, déclenchement ou non — la fenêtre du déclencheur
    ``"move"`` (:func:`guardian_trigger`) est le cycle guetteur (~5 min), pas
    le temps écoulé depuis le dernier APPEL au modèle (:func:`guardian_mark_
    fired`, qui touche des clés DIFFÉRENTES du même sous-dict). Ne mute jamais
    l'état reçu.
    """
    out = dict(state if isinstance(state, dict) else {})
    symbol_text = _symbol(symbol)
    sym = dict(out.get(symbol_text) if isinstance(out.get(symbol_text), dict) else {})
    sym["last_price"] = _val(price)
    out[symbol_text] = sym
    return out


def guardian_mark_fired(state: Any, symbol: Any, now: Any) -> Dict[str, Any]:
    """Enregistre un appel du gardien sur ce symbole (PUR) — pose le cooldown
    et incrémente le plafond quotidien, remis à zéro à la date LOCALE. Ne mute
    jamais l'état reçu ; ne touche pas ``last_price`` (:func:`guardian_seen`)."""
    out = dict(state if isinstance(state, dict) else {})
    symbol_text = _symbol(symbol)
    sym = dict(out.get(symbol_text) if isinstance(out.get(symbol_text), dict) else {})
    local_day = _local(now).date().isoformat()
    calls_today = sym.get("calls_today") or 0
    if sym.get("calls_date") != local_day:
        calls_today = 0
    sym["calls_today"] = calls_today + 1
    sym["calls_date"] = local_day
    sym["last_call"] = _aware_utc(now).isoformat()
    out[symbol_text] = sym
    return out


def guardian_gate(decision: Any, focus_symbol: Any) -> Optional[str]:
    """Le garde-fou de PÉRIMÈTRE du gardien (PUR, LOT 8) — SUPPLÉMENTAIRE à
    :func:`gate_decision`, qu'il ne remplace pas : une passe gardien ne gère
    QUE la position qui l'a déclenchée, jamais une autre ligne, jamais une
    ouverture neuve (cf. :data:`GUARDIAN_ALLOWED_ACTIONS`).

    Rend ``"out_of_scope"`` (:data:`REJECT_CODES`) si la décision sort du
    périmètre, ``None`` sinon — la décision passe alors par
    :func:`gate_decision`, INCHANGÉ.
    """
    decision = decision if isinstance(decision, dict) else {}
    action = _text(decision.get("action")).lower()
    if action not in GUARDIAN_ALLOWED_ACTIONS:
        return "out_of_scope"
    if _symbol(decision.get("symbol")) != _symbol(focus_symbol):
        return "out_of_scope"
    return None


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
# I/O — l'état du GARDIEN (LOT 8), MÊME PATRON que ci-dessus, fichier séparé
# (par SYMBOLE, pas par compte — cf. tête de section PURE du gardien).
# --------------------------------------------------------------------------- #

def guardian_state_path() -> Path:
    return Path(_store().DATA_DIR) / GUARDIAN_STATE_NAME


def load_guardian_state() -> Dict[str, Any]:
    """L'état du gardien (``{symbole: {"last_price","last_call","calls_today",
    "calls_date"}}``). Absent/corrompu -> ``{}`` — le gardien ne doit jamais
    tomber parce qu'un fichier a été touché à la main."""
    path = guardian_state_path()
    if not path.is_file():
        return {}
    try:
        with open(str(path), "r", encoding="utf-8") as handle:
            data = json.load(handle)
    except (OSError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


def save_guardian_state(state: Dict[str, Any]) -> None:
    """Persiste l'état du gardien de façon atomique, 0o600 — même mécanisme
    que :func:`save_state`."""
    _store()._atomic_write_json(guardian_state_path(), dict(state or {}))


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


def _default_guardian(now_iso: str) -> Any:
    return _router().run_coach_guardian_pass(now_iso)


def maybe_run(now: Any = None,
              tick_fn: Optional[Any] = None,
              snapshot_fn: Optional[Any] = None,
              pass_fn: Optional[Any] = None,
              guardian_fn: Optional[Any] = None) -> Dict[str, Any]:
    """Le compte du coach, appelé à CHAQUE passage du guetteur (5 min).

    NE LÈVE JAMAIS — l'appelant (``newswatch.run_once``) ne doit jamais perdre
    un cycle de veille pour une panne du compte du coach (même doctrine que
    ``weekly.maybe_run``/``backup.maybe_run``).

    **Quatre volets, chacun best-effort STRICT** — aucun ne peut faire tomber
    les autres :

    1. **le tick, À CHAQUE PASSAGE** (cf. le commentaire de section ci-dessus :
       c'est la garantie d'inclusion, pas une commodité). Il tourne aussi le
       week-end : un stop peut sauter sur une crypto un dimanche.
    2. **la photo de patrimoine, une fois par jour, POUR TOUS LES COMPTES**
       (coach ET humains). Le gate extérieur interroge la série DU COACH — le
       seul compte dont l'existence est garantie ; le gate par compte, lui,
       vit dans ``snapshot_equity_all`` et reste l'autorité sur la donnée.
       Conséquence assumée : un compte humain créé APRÈS la photo du jour
       attend celle de demain — sans conséquence sur une courbe quotidienne.
    3. **la passe de gestion, PAR CRÉNEAU** (:func:`due_slot` — huit par jour
       ouvré, deux le week-end et CRYPTO uniquement, cf. le bloc « BUDGET
       COACH »). L'état est ARMÉ après la TENTATIVE, quel qu'en soit le
       résultat — même doctrine que ``weekly`` : sans cela, une panne du modèle
       ferait retenter toutes les 5 minutes jusqu'au créneau suivant.
    4. **le GARDIEN (LOT 8), l'IMPRÉVU entre deux créneaux** — SEULEMENT
       quand AUCUN créneau ne tourne ce cycle-ci (``slot is None``, verrou
       simple : « jamais pendant qu'une passe à créneau tourne »). Une passe
       créneau vient déjà de relire TOUT le livre ; le gardien serait
       redondant dans le même cycle. Ses propres cooldown/plafond quotidien
       (``coach_trader.guardian_decision``) vivent dans SON état
       (``coach_guardian.state.json``), séparé de celui-ci.

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

    Les quatre ``*_fn`` sont injectables : les tests n'ont jamais besoin du
    router, du réseau ni du modèle.

    Rend ``{"ticked", "snapshotted", "passed", "reason", "guarded"}`` —
    ``reason`` décrit le sort du VOLET 3 (``None`` s'il a tourné, ``"not_due"``
    si l'horloge a refusé, ``"error"`` s'il a échoué), le seul dont l'inaction
    soit normale. S'y ajoute ``slot`` quand un créneau a été retenu : savoir
    LEQUEL a tourné est la première chose qu'on regarde quand la cadence
    surprend. ``guarded`` dit si le VOLET 4 a été TENTÉ (verrou levé) — pas
    s'il a APPELÉ le modèle sur une ligne : ça, c'est ``run_coach_guardian_
    pass`` qui le sait, via son propre ``{"checked","fired","ledger"}``.

    ⚠️ **LOT 8** : ce volet ne calcule plus un ``crypto_only`` global pour
    toute la passe (LOT 6) — l'univers se juge désormais SYMBOLE PAR SYMBOLE,
    à l'intérieur même de la passe (``coach_trader.tradable_now``, appelée par
    ``gate_decision`` avec l'horodatage de CHAQUE décision). Une passe de
    semaine peut donc parfaitement agir sur une action européenne à 10 h et se
    voir refuser une action US à la même heure, dans le MÊME appel.
    """
    out = {"ticked": False, "snapshotted": False, "passed": False,
           "reason": None, "guarded": False}
    try:
        local_iso = _local(now).replace(tzinfo=None).isoformat(timespec="seconds")
        state_iso = _aware_utc(now).isoformat()
        day = local_iso[:10]
    except Exception:      # noqa: BLE001 — horloge illisible : rien n'est sûr
        return {"ticked": False, "snapshotted": False, "passed": False,
                "reason": "error", "guarded": False}

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

    # --- 3) la passe de gestion, PAR CRÉNEAU (LOT 5) ------------------- #
    try:
        state = load_state()
    except Exception:      # noqa: BLE001 — état illisible : on retente
        state = {}
    slot = due_slot(now, state)
    if slot is None:
        out["reason"] = "not_due"
        # --- 4) LE GARDIEN (LOT 8) — verrou : jamais pendant qu'une passe à
        # créneau tourne. Aucun créneau ce cycle-ci -> le verrou est levé.
        try:
            (guardian_fn or _default_guardian)(local_iso)
            out["guarded"] = True
        except Exception as exc:      # noqa: BLE001
            logger.warning("paper coach_trader: passe gardien en panne (%s)",
                           type(exc).__name__)
        return out

    out["slot"] = slot
    try:
        (pass_fn or _default_pass)(local_iso)
        out["passed"] = True
    except Exception as exc:      # noqa: BLE001
        out["reason"] = "error"
        logger.warning("paper coach_trader: passe du créneau %s en panne (%s)",
                       slot, type(exc).__name__)

    # ARMÉ APRÈS LA TENTATIVE, quel qu'en soit le résultat (cf. docstring).
    # ``last_pass`` reste écrit à côté de ``slots`` : il ne gate plus rien
    # (c'est ``due_slot`` qui décide, créneau par créneau) mais il dit quand le
    # coach a tourné pour la dernière fois, toutes passes confondues — une
    # trace qu'on ne veut pas perdre en passant aux créneaux.
    try:
        state = arm_slot(state, slot, state_iso)
        state["last_pass"] = state_iso
        save_state(state)
    except Exception as exc:      # noqa: BLE001
        logger.warning("paper coach_trader: état de passe non persisté (%s)",
                       type(exc).__name__)
    return out
