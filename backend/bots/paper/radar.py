"""Radar d'hypothèses de second ordre — le module qui ose, et qui se note.

L'idée, dite par l'utilisateur : « parce qu'il se passe X, il y aura une
hausse dans des marchés qui n'ont rien à voir en apparence — préviens-moi. Je
ne veux pas du sûr : prends des risques avec moi. »

Le radar lit ce que voient les autres capteurs du module (la presse suivie par
``newswatch``, les dépôts 13F suivis par ``whales``, les tendances sociales du
moteur Market Pulse), en tire 0 à 3 **hypothèses spéculatives assumées** —
puis, et c'est le cœur, **LES NOTE automatiquement à l'échéance** et tient un
bilan cumulé public.

⚠️ **Le radar n'envoie plus RIEN sur Telegram** (spec §13) : ni à la naissance
d'une hypothèse, ni au verdict. Il notifiait à chaque signal, c'est-à-dire
souvent, donc plus personne ne lisait. Tout va désormais à l'état et au carnet
(``Radar.md``), en SILENCE ; la parole est déléguée à ``convergence.py``, qui
n'ouvre la bouche que lorsque plusieurs facteurs indépendants s'alignent. Les
deux formateurs (``format_alert``/``format_verdict``) restent en place : ils
sont la mise en forme de RÉFÉRENCE d'une hypothèse et de son verdict, à
disposition de l'UI et de la convergence.

Doctrine du projet (leçon Oracle) : **un pari non scoré est de l'astrologie.**
Toute hypothèse naît avec sa date d'échéance, ses tickers de mesure et son
critère d'invalidation ; à l'échéance elle devient ``hit`` / ``miss`` /
``unclear``, sans triomphalisme ni excuse. Le bilan cumulé accompagne CHAQUE
nouvelle hypothèse : si le radar se trompe tout le temps, l'utilisateur le lit
sur le message même qui lui vend l'hypothèse suivante.

Trois garde-fous d'honnêteté, non négociables :

1. **Jamais présenté comme sûr.** Le message dit « PARI, PAS UNE CERTITUDE »,
   la confiance est plafonnée à « moyenne » — si le LLM écrit « haute », on
   clampe. Aucun message ne recommande un achat réel : c'est un simulateur.
2. **0 hypothèse est une réponse légitime.** Un radar qui force sa dose
   quotidienne fabrique du bruit ; le prompt l'interdit explicitement, et rien
   dans le code ne réclame un minimum.
3. **La file est bornée** (``MAX_OPEN``) : au-delà, on SCORE mais on ne
   GÉNÈRE plus. La discipline avant le volume — mais jamais le silence : une
   file éternellement pleine rendrait le radar MUET pendant des semaines, alors
   un cran de rotation (``pick_rotation``) note « indécise » la doyenne des
   hypothèses du radar pour rendre UNE place par passage.

Découpage : tout ce qui est marqué PUR n'a AUCUN I/O (prompt, parsing,
scoring, mise en forme) ; ``run_once`` et ``recent`` sont les seules fonctions
d'I/O, et leurs dépendances (LLM, bougies, notifieur, réseau social, horloge)
sont injectables → tests 100 % hors-ligne.

Les modules voisins (``llm``, ``quotes``, ``newswatch``, ``whales``,
``store``, ``pulse.social``) sont importés PARESSEUSEMENT, à l'intérieur des
fonctions : le radar doit rester importable et testable même si l'un d'eux
manque, et chaque source est best-effort — une source muette ne fait jamais
tomber le run, elle incrémente le compteur ``errors``.
"""
import json
import logging
import os
import re
import sys
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Tuple

logger = logging.getLogger("omenserver")

# backend/bots/paper/radar.py -> racine projet = parents[3]
_PROJECT_ROOT = Path(__file__).resolve().parents[3]
# Le moteur Market Pulse porte déjà les collecteurs sociaux (même pont
# sys.path que quotes.py : on réutilise, on ne réécrit pas).
ENGINE_DIR = _PROJECT_ROOT / "market-pulse"

STATE_NAME = "radar.json"
NOTE_NAME = "Radar.md"

# Bornes de production. 3 hypothèses par run au plus, 12 ouvertes au total.
#
# ⚠️ 6 -> 12 le 26/08, sur MESURE. Depuis la v6, la file n'est plus au radar
# seul : chaque idée du coach (``/ideas``) s'y enregistre aussi (``source:
# "coach"``, cf. ``_register_radar_ideas``). Une soirée de questions au coach
# remplissait donc les 6 places, et le générateur du radar se taisait ensuite
# jusqu'à la maturité de la première hypothèse — deux semaines. Constaté sur le
# compte réel : 6 ouvertes = MAX_OPEN, aucune génération depuis le 25/08 13h22.
# Douze places rendent la cohabitation vivable sans faire du radar un bavard.
MAX_PER_RUN = 3
MAX_OPEN = 12

# --- rotation de file (garde-fou anti-mutisme, 2026-08-26) ----------------- #
#
# Le plafond seul a un angle mort : si TOUTES les ouvertes sont des paris longs,
# la file reste pleine des semaines et le radar ne produit plus rien. Le silence
# est alors indiscernable d'une panne, et c'est le pire état possible pour un
# module dont l'honnêteté est le seul produit.
#
# Alors on ROTE : file pleine ET plus aucune hypothèse fraîche (toutes ont
# dépassé ``ROTATION_MIN_AGE_H``) -> la DOYENNE des hypothèses du radar est
# notée par anticipation, verdict « indécis », UNE par passage.
#
# Trois choix explicites :
#   * ``unclear`` TOUJOURS, quel que soit le mouvement mesuré. Déclarer « hit »
#     avant l'échéance serait choisir sa fenêtre après coup — exactement le
#     mensonge que le scoring existe pour empêcher. L'aveu « indécise » vaut
#     mieux que le silence ; il ne vaut pas une réussite ;
#   * ``move_pct`` quand même renseigné si les bougies le permettent : le
#     lecteur a droit au chiffre, même sans verdict ;
#   * JAMAIS une idée du coach. Elles portent le bilan par niveau de risque
#     (``stats_by_level``) : les rogner fabriquerait des « indécises » dans un
#     bilan qu'on lit précisément pour juger ces niveaux-là.
ROTATION_MIN_AGE_H = 48
ROTATION_NOTE = "rotation : file pleine"

# Fenêtres d'entrée : une dépêche de plus de 48 h n'est plus un déclencheur,
# un 13F de plus de 7 jours a déjà été digéré par le marché.
EVENT_WINDOW_H = 48
FILING_WINDOW_D = 7

# Horizon d'une hypothèse : moins de 3 jours c'est du bruit de marché, plus de
# 30 jours c'est un pari qu'on ne saura plus relier à son déclencheur.
MIN_HORIZON_D = 3
MAX_HORIZON_D = 30
DEFAULT_HORIZON_D = 7

# ⚠️ DEUX plafonds, et c'est VOULU (2026-08-25).
#
# 30 jours reste la règle du RADAR : ses hypothèses de second ordre partent d'un
# déclencheur DATÉ (une dépêche, un dépôt 13F), et au-delà d'un mois plus
# personne ne saurait dire si le mouvement vient de ce déclencheur ou d'autre
# chose. Cet argument tient pour LUI.
#
# Il ne tient PAS pour une idée du COACH (``source: "coach"``) : le niveau
# spéculatif propose explicitement du forex en SEMI-LONG — semaines à deux ou
# trois mois — adossé à un moteur macro NOMMÉ (écart de taux, cycle de banque
# centrale, balance commerciale), qui reste lisible sur un trimestre. Scorer un
# tel pari au bout de 30 jours ne mesurerait pas la thèse mais le bruit de son
# premier tiers — et le bilan par niveau reprocherait au niveau spéculatif un
# échec que nous aurions fabriqué nous-mêmes.
MAX_HORIZON_COACH_D = 120

# Seuil de verdict. En dessous de 3 % sur l'horizon, on ne peut pas distinguer
# la thèse du bruit : c'est « indécis », pas une réussite.
MOVE_THRESHOLD_PCT = 3.0
SCORE_RANGE = "3mo"
SCORE_INTERVAL = "1d"

# La confiance est PLAFONNÉE : le radar spécule, il ne sait pas.
VALID_CONFIDENCE = ("basse", "moyenne")
DEFAULT_CONFIDENCE = "moyenne"
VALID_DIRECTIONS = ("up", "down")

# --- bilan PAR NIVEAU DE RISQUE (extension 2026-08-25) --------------------- #
# Le radar héberge deux populations d'hypothèses : les siennes (générées ici) et
# celles du coach (idées de ``/ideas``, ``source: "coach"``), qui portent
# désormais un étage de risque. Les mélanger dans un bilan unique cacherait
# exactement ce qu'on veut voir : est-ce que le niveau spéculatif gagne, ou
# est-ce qu'il brûle du crédit ?
#
# ⚠️ MIROIR de ``llm.RISK_LEVELS`` — et volontairement PAS un import : le radar
# doit rester importable sans le module LLM (patron du fichier : tous les
# voisins sont importés paresseusement). La correspondance est figée par un test
# (piège #61 : un champ qui traverse plusieurs couches diverge en silence).
RISK_BUCKETS = ("mesure", "agressif", "speculatif", "crypto")
DEFAULT_BUCKET = "mesure"
# Les hypothèses générées par le radar lui-même n'ont PAS de niveau de risque :
# elles ne sont pas des idées de trade dimensionnées, elles n'ont donc rien à
# faire dans le bilan d'un étage. Leur propre case.
RADAR_BUCKET = "radar"
COACH_SOURCE = "coach"

# --- tendances sociales (spec §13) ----------------------------------------- #
# Reddit : plafond MESURÉ à 1 requête / 60 s / IP -> UNE seule requête par run,
# en multireddit (jamais sub par sub, on prendrait un 429 au troisième).
SOCIAL_SUBS = ("wallstreetbets", "stocks", "investing", "StockMarket")
SOCIAL_REDDIT_LIMIT = 50
SOCIAL_BLUESKY_QUERIES = ("stock market", "tariffs markets")
SOCIAL_BLUESKY_LIMIT = 25
SOCIAL_X_HANDLES = ("DeItaone", "FirstSquawk")
MAX_SOCIAL_ITEMS = 25
SOCIAL_PACING_S = 0.4

# Bornes de prompt : au-delà, on paie des jetons pour du bruit.
MAX_EVENTS_IN_PROMPT = 40
MAX_FILINGS_IN_PROMPT = 20
MAX_SCORED_IN_PROMPT = 12
MAX_WHALE_MOVES = 20

# Fichiers de ``data/paper_trading/`` qui ne sont PAS des portefeuilles.
# ``<user>.coach.json`` et ``<user>.news_seen.json`` sont écartés par la regex
# (leur radical porte un point) ; ceux-ci ne le sont pas -> liste explicite.
# ⚠️ Les états des MODULES vivent dans le même répertoire que les comptes :
# oublier l'un d'eux fabrique un utilisateur fantôme (« whales_watch » recevrait
# des notes de carnet dans son propre vault). Tout nouvel état de module doit
# être ajouté ici.
_NON_USER_FILES = frozenset({
    STATE_NAME,
    "convergence.json",
    "whales_cache.json",
    "whales_watch.json",
    "newswatch_global.json",
    # Réglages ajoutés le 26/08. Leur radical ne contient PAS de point : sans
    # cette liste, ``alerts_mode`` et ``x_accounts`` seraient recensés comme des
    # comptes — et la convergence leur écrirait un carnet, recréant exactement
    # les utilisateurs fantômes qu'on vient de faire disparaître de l'écran.
    "alerts_mode.json",
    "x_accounts.json",
    # Dossiers historiques (26/08). Même piège, en plus vicieux : le chemin
    # ``backfill.json`` EST exactement ``store.portfolio_path("backfill")`` —
    # sans cette ligne, « backfill » serait recensé comme un compte ET son
    # état passerait pour un portefeuille.
    "backfill.json",
})
_USER_FILE_RE = re.compile(r"^([A-Za-z0-9_-]+)\.json$")


# --------------------------------------------------------------------------- #
# Horloge & dates — tout est ramené en UTC NAÏF
#
# Comparer un datetime naïf à un datetime avec fuseau lève un TypeError : le
# radar reçoit des dates de trois sources différentes (nos ISO, les epochs
# Yahoo, les dates de newswatch), donc on normalise TOUT au même format une
# fois pour toutes plutôt que de se protéger à chaque comparaison.
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
    """Date depuis un ISO, un epoch (int/float ou chaîne de chiffres) ou une
    simple date ``AAAA-MM-JJ``. ``None`` si illisible — jamais d'exception."""
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


def _iso(value: Any) -> str:
    """ISO en UTC naïf. Une valeur illisible rend une chaîne vide."""
    parsed = _parse_dt(value) if not isinstance(value, datetime) else _naive(value)
    return parsed.isoformat() if parsed is not None else ""


def _short_date(value: Any) -> str:
    """Les 10 premiers caractères d'un ISO — pour les titres de notes."""
    if not value:
        return "date inconnue"
    text = str(value)
    return text[:10] if len(text) >= 10 else text


# --------------------------------------------------------------------------- #
# Petits utilitaires PURS
# --------------------------------------------------------------------------- #

def _as_list(value: Any, cap: int = 8) -> List[str]:
    """Normalise ``liste | chaîne | None`` en liste de chaînes non vides."""
    if value is None:
        return []
    if isinstance(value, (list, tuple)):
        items = [str(v).strip() for v in value]
    else:
        items = [str(value).strip()]
    return [v for v in items if v][:cap]


def _median(values: List[float]) -> Optional[float]:
    """Médiane (moyenne des deux valeurs centrales si le compte est pair)."""
    clean = sorted(float(v) for v in values if v is not None)
    if not clean:
        return None
    middle = len(clean) // 2
    if len(clean) % 2:
        return clean[middle]
    return (clean[middle - 1] + clean[middle]) / 2.0


def _chain_text(chain: Any) -> str:
    """La chaîne causale rendue lisible : maillons reliés par des flèches."""
    if isinstance(chain, (list, tuple)):
        links = [str(c).strip() for c in chain if str(c).strip()]
        return " → ".join(links)
    return str(chain or "").strip()


def _join(values: Any, sep: str = ", ") -> str:
    """Liste (ou chaîne) rendue en une ligne."""
    if isinstance(values, (list, tuple)):
        return sep.join(str(v).strip() for v in values if str(v).strip())
    return str(values or "").strip()


def _stats_line(stats: Optional[Dict[str, Any]]) -> str:
    """« X réussies / Y ratées / Z indécises » — la même formule partout, pour
    que le bilan lu dans une alerte soit littéralement celui du prompt."""
    stats = stats or {}

    def _n(key: str) -> int:
        try:
            return int(stats.get(key) or 0)
        except (TypeError, ValueError):
            return 0

    return "%d réussies / %d ratées / %d indécises" % (
        _n("hits"), _n("misses"), _n("unclear"))


def _clamp_horizon(value: Any, max_days: int = MAX_HORIZON_D) -> int:
    """Horizon borné à [3, ``max_days``] jours. Valeur absente/illisible ->
    défaut. Le plafond par défaut est celui du radar (30) : c'est
    ``hypothesis_horizon`` qui l'ouvre à 120 pour les idées du coach."""
    try:
        days = int(float(value))
    except (TypeError, ValueError):
        return DEFAULT_HORIZON_D
    return max(MIN_HORIZON_D, min(max_days, days))


def _is_coach(hyp: Optional[Dict[str, Any]]) -> bool:
    """L'hypothèse vient-elle du COACH (``/ideas``) plutôt que du radar ?

    Trois décisions en dépendent — le plafond d'horizon, la case de bilan, et
    l'exemption de rotation — d'où ce prédicat unique : trois relectures
    indépendantes du même champ finiraient par diverger (piège #61).
    """
    return str((hyp or {}).get("source") or "").strip().lower() == COACH_SOURCE


def max_horizon_for(hyp: Optional[Dict[str, Any]]) -> int:
    """Le plafond d'horizon applicable à CETTE hypothèse (PUR).

    Il dépend de la SOURCE, pas du contenu : idée du coach -> 120 jours (le
    semi-long forex du niveau spéculatif), tout le reste -> 30 jours. Un état
    ANCIEN, sans champ ``source``, retombe donc sur 30 : rien ne change pour ce
    qui a été écrit avant.
    """
    return MAX_HORIZON_COACH_D if _is_coach(hyp) else MAX_HORIZON_D


def hypothesis_horizon(hyp: Optional[Dict[str, Any]]) -> int:
    """L'horizon EFFECTIF d'une hypothèse, en jours (PUR).

    UNE seule définition, utilisée par le scoring (``is_mature``) ET par tout ce
    qui l'affiche (prompt, alertes, notes de carnet). Deux définitions
    divergentes donneraient un carnet qui annonce 30 jours pour un pari
    réellement noté à 75 — le genre de mensonge tranquille qu'on ne voit qu'au
    bout de trois mois.
    """
    return _clamp_horizon((hyp or {}).get("horizon_days"), max_horizon_for(hyp))


def _clamp_confidence(value: Any) -> str:
    """Confiance ramenée dans {basse, moyenne}. TOUT le reste (« haute »,
    « élevée », « certaine »…) devient « moyenne » : le radar n'a pas le droit
    de se dire sûr, quoi qu'en pense le LLM."""
    text = str(value or "").strip().lower()
    if text in ("basse", "faible", "low"):
        return "basse"
    return DEFAULT_CONFIDENCE


def _clamp_direction(value: Any) -> str:
    """Direction ramenée dans {up, down}. Inconnue -> « up » (défaut de la
    spec) ; quelques synonymes français sont acceptés au passage."""
    text = str(value or "").strip().lower()
    if text in ("down", "baisse", "bear", "bearish", "short", "descente"):
        return "down"
    return "up"


# --------------------------------------------------------------------------- #
# État persistant — data/paper_trading/radar.json
#
# Écriture ATOMIQUE 0o600 (patron du projet) : le temporaire NAÎT en 0o600 via
# ``os.open`` (pas de fenêtre world-readable), ``os.fchmod`` couvre un fichier
# préexistant, ``os.replace`` bascule d'un coup.
# --------------------------------------------------------------------------- #

def _store():
    """Le module de persistance du paper trading (import paresseux)."""
    from backend.bots.paper import store
    return store


def state_path() -> Path:
    """Chemin du fichier d'état. Lu à CHAQUE appel depuis ``store.DATA_DIR``
    pour qu'un test qui isole ce répertoire isole aussi le radar."""
    return Path(_store().DATA_DIR) / STATE_NAME


def blank_state() -> Dict[str, Any]:
    """État vierge (PUR) — la forme canonique, en un seul endroit."""
    return {"hypotheses": [], "stats": {"hits": 0, "misses": 0, "unclear": 0}}


def load_state() -> Dict[str, Any]:
    """Charge l'état. Absent, illisible ou déformé -> état vierge : le radar
    ne doit jamais tomber parce qu'un fichier a été touché à la main."""
    state = blank_state()
    path = state_path()
    try:
        if not path.is_file():
            return state
        with open(str(path), "r", encoding="utf-8") as handle:
            raw = json.load(handle)
    except (OSError, ValueError):
        return state
    if not isinstance(raw, dict):
        return state
    hypotheses = raw.get("hypotheses")
    if isinstance(hypotheses, list):
        state["hypotheses"] = [h for h in hypotheses if isinstance(h, dict)]
    stats = raw.get("stats")
    if isinstance(stats, dict):
        for key in ("hits", "misses", "unclear"):
            try:
                state["stats"][key] = int(stats.get(key) or 0)
            except (TypeError, ValueError):
                state["stats"][key] = 0
    return state


def save_state(state: Dict[str, Any]) -> None:
    """Persiste l'état de façon atomique, 0o600."""
    path = state_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = path.parent / (".%s.tmp-%d" % (path.name, os.getpid()))
    fd = os.open(str(tmp_path), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    try:
        os.fchmod(fd, 0o600)
    except (AttributeError, OSError):
        pass
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(state, handle, ensure_ascii=False, indent=2)
        os.replace(str(tmp_path), str(path))
    except Exception:
        try:
            os.remove(str(tmp_path))
        except OSError:
            pass
        raise


# --------------------------------------------------------------------------- #
# PUR — le prompt
# --------------------------------------------------------------------------- #

def build_prompt(events: Any, filings: Any, open_hyps: Any, scored_hyps: Any,
                 stats: Any, now_iso: str, social: Any = None,
                 whale_moves: Any = None, history: Any = None) -> str:
    """Le prompt du radar (PUR — aucune I/O, aucun appel).

    Il porte toute la doctrine : chercher le RICOCHET et pas le premier degré,
    avoir le droit de ne rien rendre, ne jamais se dire certain, apprendre de
    ses propres échecs déjà notés, et donner de quoi être noté (tickers +
    horizon + invalidation).
    """
    lines: List[str] = []

    lines.append(
        "Tu es le RADAR DE SECOND ORDRE d'un simulateur d'apprentissage du "
        "trading (argent FICTIF, utilisateur débutant, résident suisse).")
    lines.append("Date du jour : %s." % (now_iso or "inconnue"))
    lines.append("")
    lines.append(
        "TON TRAVAIL : repérer des enchaînements NON ÉVIDENTS, du type "
        "« parce que [événement], alors [un marché ou un secteur SANS lien "
        "apparent] pourrait monter ou baisser », en écrivant la chaîne causale "
        "maillon par maillon (2 à 4 maillons).")
    lines.append(
        "Le premier degré ne vaut rien ici : « Nestlé publie de bons résultats "
        "donc Nestlé monte » n'est PAS une hypothèse de second ordre. On "
        "cherche le ricochet : fournisseur, client, substitut, concurrent, "
        "matière première, fret, énergie, devise, taux, réglementation, "
        "comportement de l'épargnant.")
    lines.append("")

    lines.append("RÈGLES DURES :")
    lines.append(
        "1. Rendre 0 hypothèse est une réponse LÉGITIME, et souvent la bonne. "
        "Il est INTERDIT d'inventer une hypothèse pour remplir : un radar qui "
        "force sa dose quotidienne fait de l'astrologie, pas de l'analyse. "
        "Maximum 3, et seulement si le matériau du jour les porte vraiment.")
    lines.append(
        "2. Aucune hypothèse n'est une certitude. Tu écris des PARIS assumés, "
        "jamais des prévisions sûres : la confiance est donc plafonnée à "
        "\"basse\" ou \"moyenne\", et JAMAIS plus haut.")
    lines.append(
        "3. Tu ne reproposes AUCUNE des hypothèses déjà ouvertes listées "
        "plus bas, ni une simple reformulation de l'une d'elles.")
    lines.append(
        "4. Tu APPRENDS des hypothèses déjà notées (fournies avec leur "
        "verdict) : si un type de chaîne causale a raté plusieurs fois, "
        "dis-le dans ta thèse et évite ce schéma.")
    lines.append(
        "5. Chaque hypothèse porte 1 à 3 tickers Yahoo LIQUIDES et "
        "REPRÉSENTATIFS du marché visé, plus une direction : ce sont eux qui "
        "serviront à te NOTER automatiquement à l'échéance. Un ticker mal "
        "choisi te fera compter une hypothèse juste comme ratée.")
    lines.append(
        "6. horizon_days est un entier entre 3 et 30 jours.")
    lines.append(
        "7. Le champ invalidation est OBLIGATOIRE : ce qui, si ça se produit, "
        "TUE l'hypothèse.")
    lines.append(
        "8. Il est INTERDIT de recommander un achat ou une vente avec de "
        "l'argent réel : c'est un simulateur d'apprentissage.")
    lines.append("")

    lines.append("ÉVÉNEMENTS DE PRESSE RÉCENTS (48 h) :")
    rows = list(events or [])[:MAX_EVENTS_IN_PROMPT]
    if rows:
        for event in rows:
            event = event if isinstance(event, dict) else {}
            lines.append("- [%s] %s%s%s" % (
                _short_date(event.get("ts")),
                str(event.get("title") or "").strip() or "(sans titre)",
                (" — titre suivi : %s" % event.get("symbol")) if event.get("symbol") else "",
                (" — tonalité : %s" % event.get("sentiment")) if event.get("sentiment") else "",
            ))
    else:
        lines.append("- (aucun)")
    lines.append("")

    lines.append("DÉPÔTS 13F RÉCENTS (7 jours, allocation des grands gérants) :")
    rows = list(filings or [])[:MAX_FILINGS_IN_PROMPT]
    if rows:
        for filing in rows:
            filing = filing if isinstance(filing, dict) else {}
            lines.append("- [%s] %s (%s)" % (
                _short_date(filing.get("filing_date") or filing.get("ts")),
                str(filing.get("label") or filing.get("manager_id") or "?").strip(),
                str(filing.get("form") or "13F").strip(),
            ))
    else:
        lines.append("- (aucun)")
    lines.append("")

    lines.append(
        "MOUVEMENTS DE PORTEFEUILLE DES GRANDS GÉRANTS (ce qu'ils ont VENDU "
        "ou allégé d'abord — c'est là qu'ils disent le plus ; ⚠️ un 13F est "
        "publié avec jusqu'à 45 jours de retard, et un allègement peut n'être "
        "qu'une rotation) :")
    rows = [m for m in (whale_moves or []) if isinstance(m, dict)][:MAX_WHALE_MOVES]
    if rows:
        for move in rows:
            delta = move.get("delta_pct")
            lines.append("- %s — %s sur %s%s" % (
                str(move.get("manager_label") or "?").strip(),
                str(move.get("action") or "mouvement").strip(),
                str(move.get("name") or "?").strip(),
                (" (%s %%)" % delta) if delta is not None else "",
            ))
    else:
        lines.append("- (aucun)")
    lines.append("")

    lines.append("TENDANCES SOCIALES (bruit élevé, non vérifié — à recouper "
                 "avant d'en tirer une hypothèse) :")
    rows = list(social or [])[:MAX_SOCIAL_ITEMS]
    if rows:
        for post in rows:
            post = post if isinstance(post, dict) else {}
            text = str(post.get("text") or "").strip()
            if not text:
                continue
            lines.append("- [%s] %s" % (str(post.get("source") or "social"), text))
    else:
        lines.append("- (aucune)")
    lines.append("")

    lines.append(
        "HISTORIQUE (12 derniers mois, collecté d'archives de presse) — c'est "
        "la BASE : un événement d'aujourd'hui n'est NEUF que par rapport à "
        "ça. Sers-t'en pour savoir si le matériau ci-dessus rompt avec les "
        "douze derniers mois ou s'il répète une histoire déjà vue :")
    rows = [(symbol, lines_)
            for symbol, lines_ in sorted((history or {}).items())
            if isinstance(lines_, list) and lines_] \
        if isinstance(history, dict) else []
    if rows:
        for symbol, symbol_lines in rows:
            lines.append("- %s :" % symbol)
            for entry in symbol_lines:
                lines.append("  · %s" % str(entry))
    else:
        lines.append("- (aucun dossier historique collecté pour l'instant)")
    lines.append("")

    lines.append("HYPOTHÈSES DÉJÀ OUVERTES (à NE PAS reproposer) :")
    rows = [h for h in (open_hyps or []) if isinstance(h, dict)]
    if rows:
        for hyp in rows:
            lines.append("- %s [marchés : %s | horizon %d j]" % (
                str(hyp.get("thesis") or "").strip() or "(sans thèse)",
                _join(hyp.get("markets")) or "?",
                hypothesis_horizon(hyp),
            ))
    else:
        lines.append("- (aucune)")
    lines.append("")

    lines.append("HYPOTHÈSES DÉJÀ NOTÉES (apprends-en) :")
    rows = [h for h in (scored_hyps or []) if isinstance(h, dict)][-MAX_SCORED_IN_PROMPT:]
    if rows:
        for hyp in rows:
            move = hyp.get("move_pct")
            move_text = ("%+.1f %%" % float(move)) if isinstance(move, (int, float)) \
                else "mouvement non mesuré"
            lines.append("- [%s] %s → chaîne : %s (%s)" % (
                str(hyp.get("outcome") or "?"),
                str(hyp.get("thesis") or "").strip() or "(sans thèse)",
                _chain_text(hyp.get("chain")) or "?",
                move_text,
            ))
    else:
        lines.append("- (aucune pour l'instant)")
    lines.append("")

    lines.append("BILAN CUMULÉ DU RADAR : %s." % _stats_line(stats))
    lines.append(
        "Ce bilan est public et accompagne chaque hypothèse envoyée : "
        "un pari non scoré serait de l'astrologie, donc tout ce que tu écris "
        "sera noté automatiquement à l'échéance.")
    lines.append("")

    lines.append("FORMAT DE SORTIE — un JSON strict, et RIEN d'autre autour :")
    lines.append('{"hypotheses": [{"thesis": "une phrase", '
                 '"chain": ["maillon 1", "maillon 2", "maillon 3"], '
                 '"markets": ["secteur ou marché en clair"], '
                 '"tickers": ["AAPL"], "direction": "up", '
                 '"horizon_days": 10, "confidence": "moyenne", '
                 '"invalidation": "ce qui tuerait l\'hypothèse"}]}')
    lines.append('Aucune hypothèse aujourd\'hui ? Rends exactement : '
                 '{"hypotheses": []}')

    return "\n".join(lines)


# --------------------------------------------------------------------------- #
# PUR — lecture de la réponse du LLM
# --------------------------------------------------------------------------- #

def parse_llm(raw: Any) -> List[Dict[str, Any]]:
    """Extrait et VALIDE les hypothèses de la réponse du LLM (PUR).

    Un item invalide est jeté SEUL — jamais le lot : une hypothèse bancale ne
    doit pas faire perdre les deux autres. Les champs de gestion
    (``id``/``status``/``outcome``) appartiennent à l'état, pas au LLM : ils
    sont ignorés même s'il les invente.
    """
    if raw is None:
        return []
    text = raw if isinstance(raw, str) else str(raw)
    start = text.find("{")
    end = text.rfind("}")
    if start < 0 or end <= start:
        return []
    try:
        payload = json.loads(text[start:end + 1])
    except ValueError:
        return []
    if not isinstance(payload, dict):
        return []
    items = payload.get("hypotheses")
    if not isinstance(items, list):
        return []

    out: List[Dict[str, Any]] = []
    for item in items:
        if not isinstance(item, dict):
            continue
        thesis = str(item.get("thesis") or "").strip()
        chain = _as_list(item.get("chain"), cap=6)
        tickers = [t.upper() for t in _as_list(item.get("tickers"), cap=3)]
        # Dédoublonnage en gardant l'ordre : deux fois le même ticker
        # fausserait la médiane du scoring.
        tickers = list(dict.fromkeys(tickers))
        if not thesis or not chain or not tickers:
            continue
        invalidation = str(item.get("invalidation") or "").strip() or "(non précisée)"
        out.append({
            "thesis": thesis,
            "chain": chain,
            "markets": _as_list(item.get("markets"), cap=6),
            "tickers": tickers,
            "direction": _clamp_direction(item.get("direction")),
            "horizon_days": _clamp_horizon(item.get("horizon_days")),
            "confidence": _clamp_confidence(item.get("confidence")),
            "invalidation": invalidation,
        })
        if len(out) >= MAX_PER_RUN:
            break
    return out


# --------------------------------------------------------------------------- #
# PUR — le scoring, seule chose qui distingue ce radar d'un horoscope
# --------------------------------------------------------------------------- #

def is_mature(hyp: Optional[Dict[str, Any]], now: Any) -> bool:
    """L'hypothèse a-t-elle atteint son échéance ?

    Une date de naissance illisible rend ``True`` : mieux vaut clore un pari
    dont on a perdu la date que le laisser ouvert pour toujours (une hypothèse
    éternelle ne serait jamais notée — exactement ce qu'on s'interdit).

    L'échéance est celle de ``hypothesis_horizon`` : 30 jours au plus pour le
    radar, 120 pour une idée du coach (le semi-long forex). Une idée à 75 jours
    n'est donc PAS mature au 40ᵉ jour — la noter là serait mesurer le bruit du
    premier tiers de la thèse.
    """
    created = _parse_dt((hyp or {}).get("created_at"))
    if created is None:
        return True
    now_dt = _parse_dt(now)
    if now_dt is None:
        return False
    return now_dt >= created + timedelta(days=hypothesis_horizon(hyp))


def _move_pct(candles: Any, created: Optional[datetime]) -> Optional[float]:
    """Variation % entre la première clôture postérieure à ``created`` et la
    dernière clôture connue. ``None`` si la mesure est impossible."""
    if not isinstance(candles, (list, tuple)):
        return None
    entry: Optional[float] = None
    last: Optional[float] = None
    for candle in candles:
        if not isinstance(candle, dict):
            continue
        close = candle.get("close")
        if close is None or isinstance(close, bool):
            continue
        try:
            close = float(close)
        except (TypeError, ValueError):
            continue
        if entry is None:
            when = _parse_dt(candle.get("ts"))
            if created is None or when is None or when >= created:
                entry = close
        last = close
    if entry is None or entry == 0 or last is None:
        return None
    return (last - entry) / entry * 100.0


def score_hypothesis(hyp: Optional[Dict[str, Any]],
                     candles_by_ticker: Optional[Dict[str, Any]],
                     now: Any) -> Optional[Dict[str, Any]]:
    """Note une hypothèse arrivée à échéance (PUR).

    Rend ``None`` tant que l'échéance n'est pas atteinte (« pas encore
    scorable »), sinon ``{outcome, move_pct, moves, scored_at}``.

    Le mouvement retenu est la MÉDIANE des variations des tickers disponibles :
    un ticker aberrant (suspension, split mal répercuté) ne doit pas décider
    seul du verdict. Aucun ticker mesurable -> ``unclear``, jamais un verdict
    inventé.
    """
    if not isinstance(hyp, dict) or not is_mature(hyp, now):
        return None

    created = _parse_dt(hyp.get("created_at"))
    moves: Dict[str, float] = {}
    for ticker, candles in (candles_by_ticker or {}).items():
        pct = _move_pct(candles, created)
        if pct is not None:
            moves[str(ticker)] = pct

    move = _median(list(moves.values()))
    direction = _clamp_direction(hyp.get("direction"))

    if move is None:
        outcome = "unclear"
    elif direction == "up":
        if move >= MOVE_THRESHOLD_PCT:
            outcome = "hit"
        elif move <= -MOVE_THRESHOLD_PCT:
            outcome = "miss"
        else:
            outcome = "unclear"
    else:
        if move <= -MOVE_THRESHOLD_PCT:
            outcome = "hit"
        elif move >= MOVE_THRESHOLD_PCT:
            outcome = "miss"
        else:
            outcome = "unclear"

    return {
        "outcome": outcome,
        "move_pct": move,
        "moves": moves,
        "scored_at": _iso(now) or _iso(_now()),
    }


def _older_than(hyp: Dict[str, Any], now_dt: datetime, hours: int) -> bool:
    """L'hypothèse a-t-elle passé ``hours`` heures ? Date illisible -> ``True``
    (même posture qu'``is_mature`` : une date perdue ne rend pas éternel)."""
    created = _parse_dt(hyp.get("created_at"))
    if created is None:
        return True
    try:
        return now_dt >= created + timedelta(hours=hours)
    except OverflowError:              # date absurde -> pas de rotation dessus
        return False


def _rotation_key(hyp: Dict[str, Any]) -> Tuple[datetime, str]:
    """La doyenne d'abord ; l'identifiant tranche les ex æquo pour que deux
    passages sur le même état choisissent la MÊME victime. Une date illisible
    passe en tête : on ne saura jamais quand la noter autrement."""
    return (_parse_dt(hyp.get("created_at")) or datetime.min,
            str(hyp.get("id") or ""))


def pick_rotation(open_hyps: Any, now: Any) -> Optional[Dict[str, Any]]:
    """L'hypothèse à noter par anticipation pour rendre UNE place (PUR).

    ``None`` — c'est-à-dire on ne touche à rien — dans tous ces cas :

    * la file n'est pas pleine (le radar peut générer, rien ne bloque) ;
    * au moins une ouverte a moins de ``ROTATION_MIN_AGE_H`` : la file tourne
      encore, l'embouteillage n'est pas installé ;
    * il ne reste que des idées du COACH : leur bilan par niveau de risque
      n'est pas à nous, on préfère se taire un tour de plus.

    Sinon : la plus ancienne hypothèse du radar. Une seule — libérer la file
    d'un coup reviendrait à jeter les paris pour pouvoir en prendre d'autres.
    """
    rows = [h for h in (open_hyps or []) if isinstance(h, dict)]
    if len(rows) < MAX_OPEN:
        return None
    now_dt = _parse_dt(now) or _now()
    if not all(_older_than(h, now_dt, ROTATION_MIN_AGE_H) for h in rows):
        return None
    mine = [h for h in rows if not _is_coach(h)]
    return min(mine, key=_rotation_key) if mine else None


# --------------------------------------------------------------------------- #
# PUR — bilan ventilé par niveau de risque
# --------------------------------------------------------------------------- #

def level_bucket(hyp: Optional[Dict[str, Any]]) -> str:
    """La case de bilan d'une hypothèse (PUR).

    Trois cas, dans cet ordre :

    1. un ``risk_level`` connu -> sa case (``mesure``/``agressif``/
       ``speculatif``). Un niveau écrit mais illisible retombe sur « mesuré » :
       le repli va vers le BAS, jamais vers le haut ;
    2. pas de niveau mais ``source: "coach"`` -> « mesuré ». Ce sont les idées
       d'AVANT cette fonctionnalité : elles ont été produites avec la doctrine
       qui est devenue le niveau mesuré, les compter ailleurs serait faux ;
    3. tout le reste -> ``radar`` : les hypothèses de second ordre générées par
       le radar lui-même, qui ne sont pas des idées de trade dimensionnées.
    """
    hyp = hyp or {}
    level = str(hyp.get("risk_level") or "").strip().lower()
    if level:
        return level if level in RISK_BUCKETS else DEFAULT_BUCKET
    return DEFAULT_BUCKET if _is_coach(hyp) else RADAR_BUCKET


def stats_by_level(hypotheses: Any) -> Dict[str, Dict[str, int]]:
    """Bilan ``{case: {hits, misses, unclear}}`` des hypothèses NOTÉES (PUR).

    Calculé à la volée depuis l'état, jamais accumulé dans un compteur : un
    bilan recalculé ne peut pas dériver de la réalité qu'il prétend décrire (et
    la ventilation par niveau peut donc changer de définition sans migration).

    Seules les hypothèses ``status == "scored"`` comptent — une hypothèse
    ouverte n'a encore rien prouvé. Une case sans aucune hypothèse notée est
    ABSENTE du résultat plutôt que remplie de zéros : « 0 réussie / 0 ratée »
    se lirait comme un échec, alors que c'est simplement « pas encore de
    verdict ».
    """
    out: Dict[str, Dict[str, int]] = {}
    for hyp in (hypotheses or []):
        if not isinstance(hyp, dict) or hyp.get("status") != "scored":
            continue
        row = out.setdefault(level_bucket(hyp),
                             {"hits": 0, "misses": 0, "unclear": 0})
        key = {"hit": "hits", "miss": "misses"}.get(
            str(hyp.get("outcome") or "").strip().lower(), "unclear")
        row[key] += 1
    return out


# --------------------------------------------------------------------------- #
# PUR — mise en forme (Telegram + carnet)
# --------------------------------------------------------------------------- #

_OUTCOME_FR = {"hit": "réussie", "miss": "ratée", "unclear": "indécise"}


def _move_text(hyp: Optional[Dict[str, Any]]) -> str:
    """« +4.2 % » ou l'aveu qu'on n'a pas pu mesurer."""
    move = (hyp or {}).get("move_pct")
    if isinstance(move, (int, float)) and not isinstance(move, bool):
        return "%+.1f %%" % float(move)
    return "mouvement non mesurable"


def format_alert(hyp: Dict[str, Any], stats: Optional[Dict[str, Any]] = None) -> str:
    """Le message d'alerte d'une hypothèse (PUR).

    ⚠️ Le radar ne l'envoie PLUS lui-même (spec §13) : il reste la mise en forme
    de référence d'une hypothèse, réutilisable par la couche de convergence et
    par l'UI.

    Sobre, et honnête dès la première ligne : « PARI, PAS UNE CERTITUDE ».
    Le bilan cumulé ferme le message — l'utilisateur voit le taux de réussite
    du radar au moment même où il lit l'hypothèse suivante.
    """
    hyp = hyp or {}
    tickers = _join(hyp.get("tickers")) or "—"
    markets = _join(hyp.get("markets")) or "—"
    return "\n".join([
        "[Simulateur] Hypothèse radar — PARI, PAS UNE CERTITUDE (confiance %s)"
        % _clamp_confidence(hyp.get("confidence")),
        str(hyp.get("thesis") or "").strip(),
        "Chaîne : %s" % (_chain_text(hyp.get("chain")) or "—"),
        "Marchés : %s (ex. %s)" % (markets, tickers),
        "Horizon ~%d j. Invalidée si : %s" % (
            hypothesis_horizon(hyp),
            str(hyp.get("invalidation") or "(non précisée)").strip()),
        "Si tu veux la jouer : simulateur, thèse écrite, petit sizing (≤ 1 %).",
        "Bilan du radar : %s." % _stats_line(stats),
    ])


def format_verdict(hyp: Dict[str, Any], stats: Optional[Dict[str, Any]] = None) -> str:
    """Le message du verdict à l'échéance (PUR). Court et factuel.

    Plus envoyé par le radar (spec §13) — conservé au même titre que
    ``format_alert`` : mise en forme de référence, réutilisable ailleurs."""
    hyp = hyp or {}
    outcome = _OUTCOME_FR.get(str(hyp.get("outcome") or ""), "indécise")
    return ("[Simulateur] Verdict radar : %s → %s (%s). Bilan : %s."
            % (str(hyp.get("thesis") or "").strip(), outcome,
               _move_text(hyp), _stats_line(stats)))


def format_hypothesis_note(hyp: Dict[str, Any]) -> str:
    """Bloc markdown appendable à ``Radar.md`` à la naissance d'une hypothèse.

    Même convention que le carnet du coach : ``## date — titre``, bloc terminé
    par une ligne vide pour que deux appends restent lisibles.
    """
    hyp = hyp or {}
    date = _short_date(hyp.get("created_at"))
    confidence = _clamp_confidence(hyp.get("confidence"))
    direction = "hausse" if _clamp_direction(hyp.get("direction")) == "up" else "baisse"
    lines = [
        "## %s — hypothèse ouverte (confiance %s)" % (date, confidence),
        "",
        str(hyp.get("thesis") or "").strip(),
        "",
        "- Chaîne : %s" % (_chain_text(hyp.get("chain")) or "—"),
        "- Marchés : %s" % (_join(hyp.get("markets")) or "—"),
        "- Mesurée sur : %s (%s attendue)" % (
            _join(hyp.get("tickers")) or "—", direction),
        "- Horizon : %d jours" % hypothesis_horizon(hyp),
        "- Invalidée si : %s" % str(hyp.get("invalidation") or "(non précisée)").strip(),
        "- Pari assumé, pas une certitude. Sera notée automatiquement à l'échéance.",
        "",
        "[[Journal]]",
        "",
    ]
    return "\n".join(lines) + "\n"


def format_outcome_note(hyp: Dict[str, Any]) -> str:
    """Bloc markdown appendable à ``Radar.md`` au verdict.

    Ton factuel : ni triomphalisme quand ça passe, ni excuse quand ça rate.
    C'est le compte-rendu qui donne sa valeur au radar.

    Une hypothèse notée par ROTATION le DIT (``note``) : sans cette ligne, le
    carnet montrerait une indécise de plus, impossible à distinguer d'un vrai
    match nul — et le bilan deviendrait illisible pour la seule raison qu'on a
    voulu le garder vivant.
    """
    hyp = hyp or {}
    date = _short_date(hyp.get("scored_at") or hyp.get("created_at"))
    outcome = _OUTCOME_FR.get(str(hyp.get("outcome") or ""), "indécise")
    lines = [
        "## %s — verdict : %s (%s)" % (date, outcome, _move_text(hyp)),
        "",
        str(hyp.get("thesis") or "").strip(),
        "",
        "- Chaîne : %s" % (_chain_text(hyp.get("chain")) or "—"),
        "- Mesurée sur : %s (%s attendue)" % (
            _join(hyp.get("tickers")) or "—",
            "hausse" if _clamp_direction(hyp.get("direction")) == "up" else "baisse"),
        "- Ouverte le %s, horizon %d jours." % (
            _short_date(hyp.get("created_at")), hypothesis_horizon(hyp)),
    ]
    note = str(hyp.get("note") or "").strip()
    if note:
        lines.append("- Notée AVANT son échéance (%s) : « indécise » est un "
                     "aveu, pas un verdict." % note)
    lines += ["", "[[Journal]]", ""]
    return "\n".join(lines) + "\n"


# --------------------------------------------------------------------------- #
# I/O — dépendances par défaut, toutes importées PARESSEUSEMENT
# --------------------------------------------------------------------------- #

def _default_llm(prompt: str) -> str:
    """Le CLI Claude via ``paper/llm.py`` (texte brut)."""
    from backend.bots.paper import llm as llm_mod
    return llm_mod._claude_text(prompt)


def _default_fetch_candles(symbol: str, range_: str, interval: str) -> Any:
    """Les bougies Yahoo via ``paper/quotes.py``."""
    from backend.bots.paper import quotes
    return quotes.get_candles(symbol, range_, interval)


def _social_module():
    """``pulse.social`` du moteur Market Pulse (pont sys.path, comme quotes)."""
    path = str(ENGINE_DIR)
    if path not in sys.path:
        sys.path.insert(0, path)
    from pulse import social
    return social


def _users_with_portfolio() -> List[str]:
    """Les utilisateurs qui ont un portefeuille.

    ``<user>.coach.json`` et ``<user>.news_seen.json`` sont écartés par la
    regex (leur radical contient un point) ; ``radar.json`` et
    ``whales_cache.json`` par la liste explicite — ce sont des fichiers de
    module, pas des comptes.
    """
    try:
        data_dir = Path(_store().DATA_DIR)
        if not data_dir.is_dir():
            return []
        names = []
        for path in sorted(data_dir.glob("*.json")):
            if path.name in _NON_USER_FILES or not path.is_file():
                continue
            match = _USER_FILE_RE.match(path.name)
            if match:
                names.append(match.group(1))
        return names
    except OSError:
        return []


def _collect_events(users: List[str], now: datetime) -> List[Dict[str, Any]]:
    """Les dépêches récentes de tous les utilisateurs, dédupliquées par lien.

    Best-effort par utilisateur : ``newswatch`` absent ou en panne rend une
    liste vide, jamais une exception. Un ``ts`` illisible est CONSERVÉ (mieux
    vaut un déclencheur de trop qu'un déclencheur perdu).
    """
    try:
        from backend.bots.paper import newswatch
    except Exception:      # noqa: BLE001 — module voisin absent
        return []

    cutoff = now - timedelta(hours=EVENT_WINDOW_H)
    out: List[Dict[str, Any]] = []
    seen = set()
    for username in users:
        try:
            events = newswatch.recent_events(username) or []
        except Exception:  # noqa: BLE001 — une source muette ne casse rien
            continue
        for event in events:
            if not isinstance(event, dict):
                continue
            when = _parse_dt(event.get("ts"))
            if when is not None and when < cutoff:
                continue
            key = str(event.get("link") or "").strip() or \
                ("%s|%s" % (event.get("symbol"), event.get("title")))
            if key in seen:
                continue
            seen.add(key)
            out.append(event)
    return out


def _collect_history() -> Dict[str, List[str]]:
    """Le dossier HISTORIQUE des titres suivis (12 mois d'archives de presse,
    collecté en pur code par ``backfill``) — best-effort STRICT.

    Sa valeur au radar est exactement celle qu'on lui demande partout ailleurs :
    dire si la dépêche du jour rompt avec l'année écoulée ou si elle rejoue une
    histoire déjà vue. Module absent ou état illisible -> ``{}`` : le radar
    raisonne sans, il raisonne juste moins bien.
    """
    try:
        from backend.bots.paper import backfill
        return backfill.digest_for_anchors() or {}
    except Exception as exc:   # noqa: BLE001 — module voisin absent ou en panne
        logger.warning("paper radar: historique indisponible (%s)",
                       type(exc).__name__)
        return {}


def _fill_history() -> Dict[str, Any]:
    """Avance la file des dossiers historiques d'UN symbole — best-effort.

    Branché à la toute fin du run, pour la même raison que la convergence : le
    radar a déjà fait son travail et sauvé son état quand on arrive ici. Un
    symbole par passage (quatre requêtes espacées), pas la watchlist entière :
    c'est ce qui rend la collecte invisible pour l'appelant.
    """
    try:
        from backend.bots.paper import backfill
        return backfill.run_pending(max_symbols=1) or {}
    except Exception as exc:   # noqa: BLE001 — jamais fatal
        logger.warning("paper radar: collecte historique indisponible (%s)",
                       type(exc).__name__)
        return {}


def _collect_whale_moves() -> List[Dict[str, Any]]:
    """Ce que les grands gérants ont VENDU, allégé, acheté ou renforcé — depuis
    le CACHE seul (aucune requête SEC ici, cf. ``whales.moves_summary``).

    Best-effort : module absent ou cache vide -> liste vide. Un dépôt DIT
    qu'un gérant a bougé ; ces lignes disent SUR QUOI — c'est cette seconde
    information qui peut porter une hypothèse de second ordre.
    """
    try:
        from backend.bots.paper import whales
        return list(whales.moves_summary() or [])
    except Exception:      # noqa: BLE001
        return []


def _collect_filings(now: datetime) -> List[Dict[str, Any]]:
    """Les dépôts 13F récents (7 jours). Best-effort, même posture."""
    try:
        from backend.bots.paper import whales
    except Exception:      # noqa: BLE001
        return []
    try:
        filings = whales.recent_filing_events() or []
    except Exception:      # noqa: BLE001
        return []

    cutoff = now - timedelta(days=FILING_WINDOW_D)
    out = []
    for filing in filings:
        if not isinstance(filing, dict):
            continue
        when = _parse_dt(filing.get("ts") or filing.get("filing_date"))
        if when is not None and when < cutoff:
            continue
        out.append(filing)
    return out


def _collect_social(fetch: Optional[Callable[[str], Any]] = None,
                    sleep: Optional[Callable[[float], None]] = None
                    ) -> Tuple[List[Dict[str, Any]], int]:
    """Les tendances sociales (spec §13) — ``(items, erreurs)``.

    Réutilise ``pulse.social`` du moteur Market Pulse : on ne réécrit ni les
    parseurs ni la reprise sur 429 (``_fetch_once`` s'en charge, UNE seule
    reprise — marteler un service qui vient de dire non est le meilleur moyen
    de se faire bloquer l'IP).

    Cinq requêtes au plus, chacune indépendante et best-effort : Reddit en UNE
    requête multireddit (plafond MESURÉ à 1 requête / 60 s / IP), deux
    recherches Bluesky, deux comptes X. Le scraping de X est fragile par
    nature — ``XSerializationChanged`` est avalée comme le reste ici : le
    radar n'a pas à tomber parce qu'un site a changé son HTML, il compte
    l'erreur et continue.

    Tout texte passe par ``clean_social_text`` (URL, grappes de hashtags et
    marqueurs de continuation retirés) avant d'entrer dans le prompt.
    """
    try:
        social = _social_module()
    except Exception:      # noqa: BLE001 — moteur absent
        return [], 1

    if fetch is None:
        fetch = social._default_fetch
    if sleep is None:
        import time as _time
        sleep = _time.sleep

    jobs: List[Tuple[str, str, Callable[[Any], Any]]] = []
    reddit_target = social.reddit_url(SOCIAL_SUBS, SOCIAL_REDDIT_LIMIT)
    if reddit_target:
        jobs.append(("Reddit", reddit_target, lambda raw: social.parse_reddit(raw)))
    for query in SOCIAL_BLUESKY_QUERIES:
        label = "Bluesky « %s »" % query
        jobs.append((label,
                     social.bluesky_search_url(query, SOCIAL_BLUESKY_LIMIT),
                     lambda raw, s=label: social.parse_bluesky(raw, s)))
    for handle in SOCIAL_X_HANDLES:
        jobs.append(("X @%s" % handle, social.x_url(handle),
                     lambda raw, h=handle: social.parse_x(raw, h)))

    by_source: List[List[Dict[str, Any]]] = []
    errors = 0
    for index, (label, url, parser) in enumerate(jobs):
        if index and SOCIAL_PACING_S:
            try:
                sleep(SOCIAL_PACING_S)
            except Exception:  # noqa: BLE001
                pass
        try:
            raw = social._fetch_once(fetch, url, sleep)
            parsed = parser(raw) or []
        except Exception:  # noqa: BLE001 — inclut XSerializationChanged
            errors += 1
            continue
        mine = []
        for post in parsed:
            if not isinstance(post, dict):
                continue
            text = social.clean_social_text(post.get("title"))
            if not text:
                continue
            mine.append({"source": post.get("source") or label, "text": text})
        if mine:
            by_source.append(mine)

    # Partage ÉQUITABLE avant de tronquer (leçon Market Pulse, piège #68e) :
    # Reddit rend 50 posts d'un coup et mangerait à lui seul les 25 places —
    # on perdrait Bluesky et X sans que rien ne le signale. Tour de table.
    items: List[Dict[str, Any]] = []
    round_index = 0
    while len(items) < MAX_SOCIAL_ITEMS and any(len(s) > round_index for s in by_source):
        for source_items in by_source:
            if round_index < len(source_items) and len(items) < MAX_SOCIAL_ITEMS:
                items.append(source_items[round_index])
        round_index += 1
    return items, errors


# --------------------------------------------------------------------------- #
# I/O — le run
# --------------------------------------------------------------------------- #

def _note_all(users: List[str], text: str) -> None:
    """Appende un bloc à ``Radar.md`` de CHAQUE utilisateur. Best-effort : une
    note qui échoue ne doit jamais faire perdre l'état du radar."""
    store = _store()
    for username in users:
        try:
            store.append_note(username, NOTE_NAME, text)
        except Exception:  # noqa: BLE001
            pass


def _bump(stats: Dict[str, Any], key: str) -> None:
    """Incrémente un compteur de bilan — un état corrompu repart de 1 plutôt
    que de faire tomber le run."""
    try:
        stats[key] = int(stats.get(key) or 0) + 1
    except (TypeError, ValueError):
        stats[key] = 1


def _rotate(hyp: Dict[str, Any], fetch_candles: Callable[..., Any],
            now_dt: datetime, stats: Dict[str, Any],
            counters: Dict[str, Any]) -> None:
    """Note UNE hypothèse par ANTICIPATION pour rendre sa place (I/O bougies).

    Le verdict est ``unclear`` par construction — pas parce que le mouvement
    serait faible, mais parce qu'on note AVANT l'échéance : appeler « réussite »
    un pari qu'on interrompt reviendrait à choisir sa fenêtre de mesure après
    coup. ``move_pct`` est quand même renseigné quand les bougies le permettent
    (le chiffre appartient au lecteur), et ``note`` dit POURQUOI ce verdict
    tombe maintenant — sans elle, le bilan afficherait une indécise de plus sans
    que personne puisse la distinguer d'un vrai match nul.
    """
    moves: Dict[str, float] = {}
    created = _parse_dt(hyp.get("created_at"))
    for ticker in hyp.get("tickers") or []:
        try:
            candles = fetch_candles(ticker, SCORE_RANGE, SCORE_INTERVAL)
        except Exception:  # noqa: BLE001 — un ticker muet coûte son chiffre, pas la rotation
            counters["errors"] += 1
            continue
        pct = _move_pct(candles, created)
        if pct is not None:
            moves[str(ticker)] = pct

    hyp["status"] = "scored"
    hyp["outcome"] = "unclear"
    hyp["move_pct"] = _median(list(moves.values()))
    hyp["scored_at"] = now_dt.isoformat()
    hyp["note"] = ROTATION_NOTE
    _bump(stats, "unclear")
    counters["scored"] += 1


def _score_and_generate(now_dt: datetime,
                        llm: Callable[[str], str],
                        fetch_candles: Callable[..., Any],
                        social_fetch: Optional[Callable[[str], Any]],
                        sleep: Optional[Callable[[float], None]]) -> Dict[str, Any]:
    """Le tour de radar proprement dit — scoring puis génération, EN SILENCE.

    Extrait de ``run_once`` pour une raison précise : la boucle sort tôt dans
    trois cas (file pleine, aucune matière, LLM muet), et la convergence doit
    être consultée dans TOUS les cas — c'est même quand le radar n'a plus rien
    à produire que ce qui s'est accumulé mérite un regard.
    """
    counters = {"generated": 0, "notified": 0, "scored": 0, "errors": 0}
    now_iso = now_dt.isoformat()

    state = load_state()
    hypotheses: List[Dict[str, Any]] = state["hypotheses"]
    stats: Dict[str, Any] = state["stats"]
    users = _users_with_portfolio()

    # ---- 1) SCORING (avant tout : un pari non scoré est de l'astrologie) --- #
    for hyp in hypotheses:
        if hyp.get("status") != "open" or not is_mature(hyp, now_dt):
            continue
        candles_by_ticker: Dict[str, Any] = {}
        for ticker in hyp.get("tickers") or []:
            try:
                candles_by_ticker[ticker] = fetch_candles(
                    ticker, SCORE_RANGE, SCORE_INTERVAL)
            except Exception:  # noqa: BLE001 — un ticker muet est ignoré
                counters["errors"] += 1
        verdict = score_hypothesis(hyp, candles_by_ticker, now_dt)
        if not verdict:
            continue
        hyp["status"] = "scored"
        hyp["outcome"] = verdict["outcome"]
        hyp["move_pct"] = verdict["move_pct"]
        hyp["scored_at"] = now_iso
        _bump(stats, {"hit": "hits",
                      "miss": "misses"}.get(verdict["outcome"], "unclear"))
        counters["scored"] += 1
        # Le verdict va au carnet, PAS sur Telegram (spec §13) : le bilan reste
        # lisible dans l'UI et dans ``Radar.md``, sans réveiller personne.
        _note_all(users, format_outcome_note(hyp))

    # ---- 1bis) ROTATION (anti-mutisme) ------------------------------------ #
    # Après le scoring normal : si l'échéance a déjà libéré une place, il n'y a
    # rien à roter. C'est le dernier recours, pas un raccourci.
    victim = pick_rotation([h for h in hypotheses if h.get("status") == "open"],
                           now_dt)
    if victim is not None:
        _rotate(victim, fetch_candles, now_dt, stats, counters)
        _note_all(users, format_outcome_note(victim))

    # ---- 2) GÉNÉRATION ---------------------------------------------------- #
    open_hyps = [h for h in hypotheses if h.get("status") == "open"]
    if len(open_hyps) >= MAX_OPEN:
        # File pleine : on a scoré, on ne génère pas. La discipline avant le
        # volume — douze paris ouverts suffisent à juger le radar. (Si on
        # arrive ici, c'est qu'aucune rotation n'était légitime : il reste des
        # hypothèses fraîches, ou la file n'est faite que d'idées du coach.)
        save_state(state)
        return counters

    events = _collect_events(users, now_dt)
    filings = _collect_filings(now_dt)
    whale_moves = _collect_whale_moves()
    social_items, social_errors = _collect_social(social_fetch, sleep)
    counters["errors"] += social_errors

    if not events and not filings and not social_items:
        # Rien à raisonner : pas d'appel LLM. Un radar qui « réfléchit » sans
        # matière produit exactement le genre d'astrologie qu'on s'interdit.
        save_state(state)
        return counters

    scored_hyps = [h for h in hypotheses if h.get("status") == "scored"]
    prompt = build_prompt(events, filings, open_hyps, scored_hyps, stats,
                          now_iso, social_items, whale_moves,
                          _collect_history())
    try:
        raw = llm(prompt)
    except Exception:  # noqa: BLE001 — LLM muet = run dégradé, jamais perdu
        counters["errors"] += 1
        save_state(state)          # le scoring déjà fait est sauvé
        return counters

    for item in parse_llm(raw):
        item["id"] = uuid.uuid4().hex[:8]
        item["created_at"] = now_iso
        item["status"] = "open"
        item["outcome"] = None
        item["scored_at"] = None
        item["move_pct"] = None
        hypotheses.append(item)
        counters["generated"] += 1
        # Naissance silencieuse elle aussi : l'hypothèse s'accumule, c'est la
        # convergence qui décidera si l'ensemble mérite un message.
        _note_all(users, format_hypothesis_note(item))

    save_state(state)
    return counters


def _fire_convergence(now_dt: datetime,
                      llm: Optional[Callable[[str], str]],
                      notifier: Optional[Callable[[str, Dict[str, Any]], Any]],
                      tg_cfg: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    """Consulte la couche de convergence à la fin du run — best-effort STRICT.

    Le radar a déjà fait son travail et sauvé son état quand on arrive ici :
    une convergence en panne ne doit jamais faire perdre un scoring. L'échec
    est donc compté (``errors``) et logué, jamais propagé.
    """
    try:
        from backend.bots.paper import convergence
        result = convergence.maybe_fire(now=now_dt, llm=llm, notifier=notifier,
                                        tg_cfg=tg_cfg) or {}
    except Exception as exc:   # noqa: BLE001 — module absent ou bug interne
        logger.warning("paper radar: convergence indisponible (%s)",
                       type(exc).__name__)
        return {"fired": False, "errors": 1, "notified": 0}
    return {
        "fired": bool(result.get("fired")),
        "errors": 0,
        "notified": 1 if result.get("sent") else 0,
    }


def run_once(now: Any = None,
             llm: Optional[Callable[[str], str]] = None,
             fetch_candles: Optional[Callable[..., Any]] = None,
             notifier: Optional[Callable[[str, Dict[str, Any]], Any]] = None,
             tg_cfg: Optional[Dict[str, Any]] = None,
             social_fetch: Optional[Callable[[str], Any]] = None,
             sleep: Optional[Callable[[float], None]] = None) -> Dict[str, Any]:
    """Un tour de radar : on NOTE d'abord, on génère ensuite, on se tait — puis
    on demande à la convergence si l'accumulation mérite UN message.

    Retourne ``{"generated", "notified", "scored", "errors", "fired"}``.

    L'ordre du scoring n'est pas anodin : scorer d'abord libère des places dans
    la file et met le bilan à jour AVANT que la nouvelle hypothèse ne l'affiche.

    ``notified`` ne compte PLUS les hypothèses ni les verdicts (le radar est
    muet depuis la spec §13) : il vaut 1 quand le digest de convergence est
    effectivement parti, 0 sinon. ``fired`` dit si ce digest a été déclenché.

    Toutes les dépendances sont injectables (``llm``, ``fetch_candles``,
    ``notifier``, ``tg_cfg``, ``social_fetch``, ``sleep``, ``now``) → les tests
    tournent 100 % hors-ligne. ``notifier``/``tg_cfg`` ne servent plus qu'à la
    convergence, à laquelle ils sont passés TELS QUELS : non fournis, c'est
    ``paper/alerts.py`` (bot Oracle) qui tranche ; ``{}`` explicite éteint le
    canal sans rien empêcher d'autre.
    """
    now_dt = _parse_dt(now) if now is not None else _now()
    if now_dt is None:
        now_dt = _now()

    counters = _score_and_generate(now_dt,
                                   llm or _default_llm,
                                   fetch_candles or _default_fetch_candles,
                                   social_fetch, sleep)

    outcome = _fire_convergence(now_dt, llm, notifier, tg_cfg)
    counters["errors"] += outcome["errors"]
    counters["notified"] += outcome["notified"]
    counters["fired"] = outcome["fired"]

    # En DERNIER, et sans jamais rien remonter dans les compteurs du radar :
    # la collecte d'archives sert le PROCHAIN passage, pas celui-ci. Une
    # erreur ici ne doit pas se lire comme une erreur de radar.
    _fill_history()
    return counters


def recent(limit: int = 30) -> Dict[str, Any]:
    """CONTRAT PUBLIC pour le router : le bilan + les N hypothèses les plus
    récentes, les ouvertes d'abord (ce sont elles qui engagent le radar), puis
    les notées de la plus fraîche à la plus ancienne.

    ``stats_by_level`` ventile le bilan par étage de risque (idées du coach) et
    isole les hypothèses du radar sous ``radar``. Il porte sur TOUT l'état, pas
    sur la tranche rendue : un bilan qui rétrécirait avec ``limit`` ne serait
    plus un bilan.
    """
    try:
        limit = max(0, int(limit))
    except (TypeError, ValueError):
        limit = 30

    state = load_state()
    hypotheses = state["hypotheses"]
    opens = [h for h in hypotheses if h.get("status") == "open"]
    others = [h for h in hypotheses if h.get("status") != "open"]
    opens.sort(key=lambda h: str(h.get("created_at") or ""), reverse=True)
    others.sort(key=lambda h: str(h.get("scored_at") or h.get("created_at") or ""),
                reverse=True)
    return {"stats": state["stats"],
            "stats_by_level": stats_by_level(hypotheses),
            "hypotheses": (opens + others)[:limit]}
