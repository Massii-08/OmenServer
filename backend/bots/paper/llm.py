"""Le coach qui RÉDIGE — la seule étape non déterministe du module.

Patron repris de ``market-pulse/pulse/analyst.py`` : CLI Claude sur l'abonnement
(aucune clé d'API), ``subprocess.run`` injectable, chemin du binaire cherché dans
``CLAUDE_BIN`` puis l'emplacement de l'Omen puis le ``PATH``.

Deux différences avec l'analyste de Market Pulse :

1. **on veut du TEXTE, pas du JSON.** ``_claude_text`` rend l'enveloppe brute
   (``result``) : le coach écrit une réponse, pas une structure.
2. **toute panne devient un ``RuntimeError``** (binaire absent, délai dépassé,
   enveloppe d'erreur, sortie illisible). Le router n'a qu'un type à attraper
   pour rendre un 502 propre, et un coach muet ne fait JAMAIS tomber le module.

⚠️ **Exécuté depuis un dossier VIDE et NEUTRE** (piège vécu sur Market Pulse) :
lancé depuis le dépôt, le CLI hérite du ``CLAUDE.md`` du projet et répond à
propos d'un autre bot du serveur. Un appel de bot doit être hermétique.

Le LLM ne DÉCIDE jamais : il reformule des faits déjà calculés (biais
déterministes de ``coach.py``, statistiques de ``risk.py``, chiffres de
``quotes.py``). Le prompt système lui interdit d'inventer un chiffre et de
recommander un titre.
"""
import json
import os
import subprocess
import tempfile
from typing import Any, Callable, Dict, List, Optional

# Seuls imports du paquet dans ce module, et ils sont VOLONTAIRES : le bloc
# d'actions du coach (LOT 4) lit les bornes du garde-fou sur ``coach_trader``
# et la whitelist des setups sur ``models`` plutôt que de les RECOPIER — un
# seuil recopié diverge, et la divergence ne se voit qu'au refus.
# Chaîne vérifiée ACYCLIQUE : coach_trader -> {models, quotes, risk}, et aucun
# des trois n'importe ``llm`` (les quatre modules qui l'utilisent le font par
# import PARESSEUX). ``backend.bots.paper.__init__`` est vide.
from backend.bots.paper import coach_trader, models

DEFAULT_MODEL = "claude-sonnet-5"
DEFAULT_TIMEOUT = 120

# Position morale du coach (§2 de la spec). Ce bloc préfixe LES TROIS prompts —
# c'est la seule garantie que le ton et les interdits ne divergent pas d'un
# endpoint à l'autre.
SYSTEM_PROMPT = (
    "Tu es le coach de trading personnel de Massii, débutant en simulateur "
    "(argent FICTIF, cours réels différés 15 min, résident suisse). "
    "Ton style : direct, tutoiement, exigeant, jamais complaisant. "
    "Ta doctrine : agressif sur les idées, impitoyable sur le dimensionnement — "
    "tu ne pousses PAS vers la prudence molle, tu pousses vers le risque MESURÉ "
    "(1-2 % du capital par trade, R multiple comme unité). "
    "Règles dures : tu ne recommandes JAMAIS d'acheter/vendre un titre précis "
    "avec de l'argent réel ; tu n'inventes AUCUN chiffre — tu n'utilises que les "
    "données fournies, et si une donnée manque (PER, dette…) tu le dis et tu "
    "indiques où la trouver ; tu cites les trades/preuves fournis quand tu "
    "affirmes quelque chose ; réponse en français, 150-400 mots, sans emojis, "
    "sans titres markdown pompeux."
)


def claude_bin() -> str:
    """Chemin du CLI Claude : ``CLAUDE_BIN``, puis l'Omen, puis le ``PATH``.

    ⚠️ Le chemin n'est PAS le même sur les deux machines (``~/.local/bin/claude``
    sur l'Omen, dans le nvm sur le Mac). Codé en dur, le coach tomberait
    silencieusement en panne sur l'une des deux — et une panne silencieuse est
    une fonctionnalité morte qui a l'air de marcher.
    """
    from shutil import which
    explicit = os.environ.get("CLAUDE_BIN")
    if explicit:
        return explicit
    omen = os.path.expanduser("~/.local/bin/claude")
    if os.path.exists(omen):
        return omen
    return which("claude") or omen      # l'échec dira quel chemin a été tenté


def _claude_text(prompt: str, model: str = DEFAULT_MODEL,
                 timeout: int = DEFAULT_TIMEOUT,
                 run: Callable = subprocess.run) -> str:
    """Envoie ``prompt`` au CLI et rend le TEXTE de la réponse.

    ``run`` est injectable : les tests n'ont jamais besoin du binaire.
    Lève ``RuntimeError`` — et rien d'autre — en cas de panne.
    """
    cmd = [claude_bin(), "-p", "--output-format", "json"]
    if model:
        cmd += ["--model", model]

    try:
        with tempfile.TemporaryDirectory(prefix="paper-coach-llm-") as neutral:
            proc = run(cmd, input=prompt, capture_output=True, text=True,
                       timeout=timeout, cwd=neutral)
    except subprocess.TimeoutExpired:
        raise RuntimeError("le coach n'a pas répondu dans les %s s" % timeout)
    except OSError as e:
        raise RuntimeError("CLI Claude introuvable ou inexécutable (%s): %s"
                           % (cmd[0], e))

    if getattr(proc, "returncode", 1) != 0:
        raise RuntimeError("claude cli rc=%s: %s"
                           % (proc.returncode, (getattr(proc, "stderr", "") or "")[:200]))
    try:
        envelope = json.loads(proc.stdout or "")
    except (TypeError, ValueError):
        raise RuntimeError("réponse illisible du CLI Claude: %s"
                           % (getattr(proc, "stdout", "") or "")[:200])
    if not isinstance(envelope, dict):
        raise RuntimeError("enveloppe inattendue du CLI Claude")
    if envelope.get("is_error"):
        raise RuntimeError("claude error: %s" % str(envelope.get("result", ""))[:200])

    text = envelope.get("result", "")
    text = text if isinstance(text, str) else str(text)
    if not text.strip():
        # Une réponse vide n'est pas une réponse : mieux vaut un 502 qu'un
        # encadré blanc dans l'interface.
        raise RuntimeError("le coach a rendu une réponse vide")
    return text.strip()


def _block(title: str, payload: Any) -> str:
    """Un bloc de données JSON, lisible et clairement délimité."""
    return "%s\n```json\n%s\n```" % (
        title, json.dumps(payload, ensure_ascii=False, indent=2, default=str))


# --------------------------------------------------------------------------- #
# Dossier HISTORIQUE — la consigne qui dit au modèle quoi en faire
#
# Le champ ``historique`` voyage DANS le bloc de contexte déjà sérialisé (les
# idées et les scénarios le portent au niveau du contexte, la revue le porte
# sur chaque position) : il n'y a donc pas de second bloc à écrire, seulement
# cette consigne. Elle est écrite UNE fois et injectée dans les trois prompts —
# trois formulations parallèles finiraient par diverger.
#
# La dernière phrase n'est pas une précaution de style : sans elle, un titre
# jamais collecté se lirait comme « il ne s'est rien passé depuis un an », ce
# qui est exactement le contresens qu'on cherche à éviter.
# --------------------------------------------------------------------------- #
_HISTORY_LINE = (
    "HISTORIQUE (12 derniers mois, collecté d'archives) : le champ "
    "``historique`` du contexte ci-dessus (au niveau du contexte, ou porté par "
    "chaque position selon le cas) donne, PAR TITRE, ce que la presse a écrit "
    "sur les douze derniers mois — une ligne par repère, au format "
    "« AAAA-MM titre (sentiment) », de la plus ancienne à la plus récente. "
    "Sers-t'en comme BASE : ce qui est nouveau ne l'est vraiment que par "
    "rapport à ça. Dis si le fait du jour ROMPT avec cette année-là ou s'il la "
    "RÉPÈTE, et nomme alors la ligne d'historique sur laquelle tu t'appuies. "
    "Un titre ABSENT de ``historique`` n'a simplement pas encore été collecté : "
    "n'en conclus RIEN — surtout pas qu'il ne s'est rien passé.")


# --------------------------------------------------------------------------- #
# Balayage FRAIS — la recherche faite AU CLIC (extension 2026-08-26)
#
# « Il se base sur ce qu'il a ET il peut chercher plus profondément au-delà. »
# Le champ ``recherche_fraiche`` voyage DANS le bloc de contexte déjà sérialisé,
# comme ``historique`` : il n'y a donc qu'une consigne à écrire.
#
# Elle dit trois choses, et les trois comptent :
#   1. d'OÙ ça vient (collecté à la seconde, pas lu en mémoire) — sans quoi le
#      modèle traiterait ces titres comme des archives de plus ;
#   2. dans quel ORDRE s'en servir (la mémoire porte la durée, le balayage ne
#      porte que la surprise) — c'est la demande explicite de Massii ;
#   3. ce que veut dire une liste VIDE. Même précaution que ``_HISTORY_LINE`` :
#      là-bas un titre absent ne veut PAS dire « rien ne s'est passé », ici une
#      liste vide veut dire EXACTEMENT « rien de neuf », et confondre les deux
#      ferait dire au coach le contraire de ce que les données montrent.
#
# La consigne n'est injectée QUE si le contexte porte réellement la clé
# (``_sweep_line``) : annoncer une section absente inviterait le modèle à
# inventer ce qu'elle contenait.
# --------------------------------------------------------------------------- #
SWEEP_KEY = "recherche_fraiche"

_SWEEP_LINE = (
    "RECHERCHE À L'INSTANT (balayage fait à ta demande, distinct de la "
    "mémoire) : le champ ``recherche_fraiche`` du contexte ci-dessus n'a PAS "
    "été lu dans la mémoire du simulateur — il vient d'être collecté, à la "
    "seconde où cette demande a été faite : ``titres`` donne, par symbole, ce "
    "que la presse a publié sur les sept derniers jours (titres détenus, "
    "suivis, et ceux dont la foule parle en ce moment), et ``momentum`` donne "
    "leur dernier cours et leur variation sur sept jours. "
    "Appuie-toi D'ABORD sur la MÉMOIRE (``historique``, ``recent_news``, "
    "``whale_moves``, ``radar_open_hypotheses``) : c'est elle qui porte la "
    "durée et le recul. La recherche fraîche sert à VÉRIFIER que rien de NEUF "
    "ne contredit ni ne renforce ce que la mémoire raconte — et quand c'est le "
    "cas, dis-le explicitement et cite le titre sur lequel tu t'appuies. "
    "Une liste VIDE pour un symbole signifie « rien de neuf sur sept jours », "
    "ce qui est une information en soi — à ne pas confondre avec un titre "
    "ABSENT de ``historique``, qui n'a lui jamais été collecté.")


# --------------------------------------------------------------------------- #
# Doctrine « le pouvoir nomme, l'administration investit » (2026-08-26)
#
# Observation de Massii : quand un dirigeant politique cite une entreprise par
# son nom — commande publique, participation de l'État, contrôle à l'export,
# reproche public — l'argent public suit souvent, et le marché le sait avant
# que le contrat soit signé. Une mention nominative n'est donc pas du bruit
# politique : c'est un INDICATEUR AVANCÉ sur ce titre-là.
#
# La consigne est écrite UNE fois et injectée dans les trois prompts qui
# proposent des mouvements (idées, scénarios, digest de convergence) — trois
# formulations parallèles finiraient par diverger, et c'est exactement le genre
# de dérive qu'on ne verrait jamais.
#
# La deuxième moitié de la phrase compte autant que la première : une mention
# n'est pas une promesse. Un dirigeant qui nomme une entreprise ne signe rien —
# le modèle doit PESER, pas croire.
# --------------------------------------------------------------------------- #
POWER_NAMED_LINE = (
    "DOCTRINE — LE POUVOIR QUI NOMME : une entreprise NOMMÉE par un dirigeant "
    "politique (commande publique, participation de l'État, contrôle à "
    "l'export, reproche public) est un INDICATEUR AVANCÉ sur ce titre — "
    "l'administration investit souvent ensuite, et le marché s'y positionne "
    "avant la signature. Pèse ces mentions comme des CATALYSEURS, au même titre "
    "qu'un résultat annoncé — sans jamais les traiter comme des PROMESSES : "
    "une déclaration n'est pas un contrat, et dis-le si tu t'appuies dessus.")


def _sweep_line(context: Optional[Dict[str, Any]]) -> list:
    """La consigne de balayage frais, ou rien du tout (PUR).

    Rien du tout quand le contexte ne porte pas la clé : un prompt qui décrit
    une section absente invite le modèle à la combler tout seul.
    """
    if isinstance(context, dict) and context.get(SWEEP_KEY):
        return [_SWEEP_LINE]
    return []


# --------------------------------------------------------------------------- #
# Langue de SORTIE
#
# Les prompts eux-mêmes restent en FRANÇAIS : ce sont des instructions au
# modèle, pas du texte lu par Massii. Seule la langue de la RÉPONSE change, via
# une ligne unique injectée juste après ``SYSTEM_PROMPT`` dans les quatre
# prompts — une seule table, donc aucune divergence possible entre endpoints.
# --------------------------------------------------------------------------- #
_LANG_NAMES = {"fr": "français", "en": "English", "it": "italiano"}


def _lang_line(lang: str = "fr") -> str:
    """La consigne de langue de sortie. Langue inconnue -> français."""
    name = _LANG_NAMES.get(str(lang or "fr").strip().lower(), "français")
    return ("Consigne de langue pour CETTE réponse : réponds exclusivement en %s "
            "(cette consigne remplace le « réponse en français » ci-dessus)." % name)


# --------------------------------------------------------------------------- #
# Niveaux de RISQUE des idées (extension utilisateur 2026-08-25)
#
# « Une option où le coach prend des risques élevés — genre short crypto, ou du
# semi-long sur du forex. » Trois étages, et un seul curseur qui bouge : le
# risque assumé par idée. Le reste de la doctrine ne bouge JAMAIS — stop
# toujours posé, thèse écrite, invalidation nommée, aucun titre « sûr » vendu
# comme tel, jamais d'argent réel.
#
# Le niveau pilote trois choses, et rien d'autre : l'UNIVERS autorisé, la
# FOURCHETTE de risque par idée, l'HORIZON. C'est volontairement mécanique :
# ainsi le bilan par niveau (``radar.stats_by_level``) mesure vraiment un étage
# de risque, pas trois prompts qui se contredisent.
# --------------------------------------------------------------------------- #
RISK_LEVELS = ("mesure", "agressif", "speculatif", "crypto")
DEFAULT_RISK_LEVEL = "mesure"

# Un niveau peut arriver de l'interface, d'un test ou d'un vieil état : on
# accepte les accents et l'anglais, tout le reste retombe sur « mesuré ».
_RISK_ALIASES = {
    "mesure": "mesure", "mesuré": "mesure", "mesuree": "mesure",
    "measured": "mesure", "moderate": "mesure",
    "agressif": "agressif", "agressive": "agressif",
    "aggressif": "agressif", "aggressive": "agressif",
    "speculatif": "speculatif", "spéculatif": "speculatif",
    "speculative": "speculatif",
    "crypto": "crypto", "cryptos": "crypto", "cryptomonnaie": "crypto",
    "crypto-monnaie": "crypto",
}

# Genres d'actifs ouverts À CHAQUE ÉTAGE. C'est cette table qui écrit la liste
# ``asset_kind`` du bloc JSON final : un prompt « mesuré » ne prononce donc
# jamais le mot d'un univers qu'il interdit — l'interdit et le schéma ne
# peuvent pas se contredire.
_LEVEL_KINDS = {
    "mesure": ("equity", "etf"),
    "agressif": ("equity", "etf"),
    "speculatif": ("equity", "etf", "crypto", "forex"),
    # Étage 100 % crypto : c'est tout l'intérêt de l'avoir séparé du
    # spéculatif, où la règle « jamais plus de 2 idées crypto sur 4 » empêche
    # justement de comparer les pièces entre elles.
    "crypto": ("crypto",),
}

# Le CODE d'un niveau est sans accent (il voyage en JSON, en URL et dans un
# état persisté) ; son ÉTIQUETTE est le mot français, celui que Massii lira en
# tête de réponse. Les deux ne se mélangent pas.
_RISK_LABELS = {
    "mesure": "mesuré",
    "agressif": "agressif",
    "speculatif": "spéculatif",
    "crypto": "crypto",
}

_RISK_BLOCKS = {
    "mesure": (
        "NIVEAU DE RISQUE DEMANDÉ POUR CETTE SÉRIE : MESURÉ.\n"
        "- Univers autorisé : actions et ETF cotés et liquides. Rien d'autre — "
        "ni monnaies numériques, ni paires de devises, ni contrats à terme.\n"
        "- Risque par idée : 0,5 à 1 % du capital. C'est le montant PERDU si le "
        "stop saute, pas la taille de la position — dis les deux.\n"
        "- Horizon : 5 à 30 jours (swing).\n"
        "- Exigences : un catalyseur IDENTIFIÉ dans le contexte fourni "
        "(résultats, décision de banque centrale, dépôt 13F, dépêche) ou, à "
        "défaut, un momentum MESURABLE dans les chiffres fournis — et tu dis "
        "alors franchement que c'est un pari technique ; une asymétrie "
        "gain/perte d'au moins 2 pour 1 (l'objectif est à au moins deux fois la "
        "distance du stop) ; un stop posé sur un niveau qui a un sens, pas sur "
        "un chiffre rond arbitraire.\n"
        "- Direction : hausse en priorité ; une idée à la baisse est acceptée "
        "si la configuration baissière est franche et documentée.\n"
        "- Ce niveau n'est PAS le niveau « prudent » : c'est celui où l'on "
        "n'entre que sur les meilleures configurations. Une idée sans "
        "catalyseur ni asymétrie n'y a pas sa place — mieux vaut en rendre "
        "moins."
    ),
    "agressif": (
        "NIVEAU DE RISQUE DEMANDÉ POUR CETTE SÉRIE : AGRESSIF.\n"
        "- Univers autorisé : actions et ETF sectoriels, choisis pour leur "
        "momentum fort ou leur catalyseur chaud (résultats imminents, rumeur "
        "d'opération, rotation sectorielle en cours).\n"
        "- Les VENTES À DÉCOUVERT d'actions sont autorisées "
        "(``direction: \"down\"``).\n"
        "- Risque par idée : 1 à 2 % du capital.\n"
        "- Horizon : 3 à 21 jours.\n"
        "- La CONCENTRATION est acceptée à cet étage : plusieurs idées sur le "
        "même thème est un choix assumé, pas une erreur — à condition de le "
        "DIRE et de rappeler que le risque, lui, s'additionne.\n"
        "- Exigence non négociable : un plan d'invalidation SERRÉ et explicite "
        "— le niveau de prix ou l'événement précis qui te fait sortir sans "
        "discuter, ET le délai au bout duquel tu sors si rien ne se passe (une "
        "position agressive qui ne fait rien est une position qui a tort).\n"
        "- Sur une vente à découvert, nomme aussi ce qui peut te tuer vite : "
        "rachat de position vendeuse (short squeeze), publication de "
        "résultats, opération sur le capital, rachat d'actions.\n"
        "- Un momentum n'est un argument que s'il est MESURABLE dans les "
        "données fournies (performance 1 mois, position dans le range 52 "
        "semaines, prix contre moyennes). Sinon c'est une impression, et tu le "
        "dis comme telle."
    ),
    "speculatif": (
        "NIVEAU DE RISQUE DEMANDÉ POUR CETTE SÉRIE : SPÉCULATIF — le plus haut. "
        "L'argent est FICTIF : c'est exactement ici qu'on a le droit "
        "d'apprendre ce qu'on ne testerait pas en réel.\n"
        "- Univers autorisé, EN PLUS des actions et ETF :\n"
        "  * CRYPTO, à la hausse comme à la baisse — un short crypto est une "
        "idée légitime à cet étage (``direction: \"down\"``). Symboles Yahoo "
        "uniquement, toujours en paire : BTC-USD, ETH-USD, SOL-USD…\n"
        "  * FOREX en SEMI-LONG, paires majeures seulement : EURUSD=X, "
        "USDJPY=X, USDCHF=X, GBPUSD=X. Horizon assumé en SEMAINES, deux à "
        "trois MOIS : une paire de devises ne se joue pas sur trois séances, "
        "elle suit un écart de taux, un cycle de banque centrale, une balance "
        "commerciale. Nomme le moteur macro, sinon l'idée n'en est pas une.\n"
        "  * matières premières via ETF (or, pétrole, cuivre…) — jamais via "
        "des contrats à terme.\n"
        "- Risque par idée : 2 à 3 % du capital, JAMAIS plus, quel que soit "
        "l'enthousiasme.\n"
        "- VOLATILITÉ ET TAILLE — la leçon centrale de cet étage : sur une "
        "crypto, le stop doit être LARGE (un stop serré sur un actif qui bouge "
        "de 5 % dans la nuit est un stop qui saute pour rien). Or le risque en "
        "% du capital, lui, ne change pas : c'est donc la TAILLE de la "
        "position qui rétrécit, mécaniquement. Écris-le dans l'idée — « stop "
        "large, donc position petite ». Une idée crypto qui ne dit pas ça est "
        "une idée ratée.\n"
        "- JAMAIS plus de 2 idées crypto sur 4 : le reste vient d'un autre "
        "univers (forex, actions, ETF). Une série 100 % crypto ne mesure plus "
        "qu'une seule chose, le bitcoin.\n"
        "- Spéculatif ne veut pas dire au hasard : chaque idée reste un PARI "
        "ASSUMÉ avec son invalidation nommée, et tu dis ce qui peut la tuer "
        "vite AVANT de dire ce qu'elle peut rapporter."
    ),
    "crypto": (
        "NIVEAU DE RISQUE DEMANDÉ POUR CETTE SÉRIE : CRYPTO — un étage à "
        "part, entièrement dédié aux monnaies numériques.\n"
        "- Univers autorisé : UNIQUEMENT des cryptos, en symboles Yahoo, "
        "toujours en paire — BTC-USD, ETH-USD, SOL-USD, XRP-USD, AVAX-USD, "
        "LINK-USD, DOGE-USD, ADA-USD, DOT-USD… Aucune action, aucun ETF, "
        "aucune paire de devises : si une idée hors crypto te paraît "
        "meilleure, tu la gardes pour toi — c'est Massii qui choisit son "
        "étage.\n"
        "- La HAUSSE comme la BAISSE (``direction: \"down\"`` autorisé).\n"
        "- COMPARE LES CRYPTOS ENTRE ELLES — c'est le cœur de cet étage, et ce "
        "qu'aucun autre ne permet : rotation des grandes capitalisations vers "
        "les petites (ou l'inverse), dominance du bitcoin qui monte ou qui "
        "cède, flux entrants et sortants des fonds indiciels, force relative "
        "d'une pièce contre l'ether ou contre le bitcoin. Quatre fois la même "
        "idée sur quatre pièces différentes n'est PAS une série : c'est un "
        "seul pari, déguisé en quatre.\n"
        "- Risque par idée : 1 à 3 % du capital.\n"
        "- Horizon libre entre 3 et 60 jours — dis-le en jours, et dis "
        "pourquoi cet horizon-là.\n"
        "- VOLATILITÉ ET TAILLE, la règle centrale : sur une crypto le stop "
        "doit être LARGE (un stop serré sur un actif qui bouge de 5 % dans la "
        "nuit saute pour rien). Comme le risque en % du capital ne change pas, "
        "c'est la TAILLE de la position qui rétrécit, mécaniquement. Écris-le "
        "dans chaque idée : « stop large, donc position petite ».\n"
        "- Si le contexte fourni ne porte pas assez de matière crypto "
        "(actualité, flux, chiffres), DIS-LE franchement et rends moins "
        "d'idées — une seule idée solide vaut mieux que quatre inventées."
    ),
}


def normalize_risk_level(value: Any) -> str:
    """Niveau de risque ramené dans ``RISK_LEVELS``. Inconnu -> « mesuré ».

    Le repli va vers le BAS, jamais vers le haut : une valeur illisible ne doit
    jamais promouvoir une série d'idées d'un étage qu'on ne lui a pas demandé.
    """
    text = str(value or "").strip().lower()
    return _RISK_ALIASES.get(text, DEFAULT_RISK_LEVEL)


# --------------------------------------------------------------------------- #
# Prompts — PURS (aucun I/O) : testables tels quels
# --------------------------------------------------------------------------- #
def build_coach_prompt(context: Optional[Dict[str, Any]], question: str,
                       lang: str = "fr") -> str:
    """Prompt de la conversation avec le coach."""
    asked = str(question or "").strip() or "Fais le point sur ma méthode."
    return "\n\n".join([
        SYSTEM_PROMPT,
        _lang_line(lang),
        "Voici l'état du simulateur de Massii : statistiques, biais détectés de "
        "façon déterministe (aucun LLM ne les a produits), résumé de son profil "
        "et ses 5 derniers trades clôturés.",
        _block("DONNÉES", context or {}),
        "Sa question : " + asked,
        "Réponds-lui directement. Appuie chaque affirmation sur un chiffre ou un "
        "trade de ces données. Si les données ne permettent pas de répondre, "
        "dis-le et dis ce qu'il faudrait mesurer.",
    ])


def build_postmortem_prompt(trade: Optional[Dict[str, Any]],
                            context: Optional[Dict[str, Any]],
                            lang: str = "fr") -> str:
    """Prompt du post-mortem d'un trade clôturé."""
    return "\n\n".join([
        SYSTEM_PROMPT,
        _lang_line(lang),
        "Post-mortem d'un trade CLÔTURÉ. ``thesis`` est la raison que Massii "
        "avait écrite AVANT d'entrer, ``planned_stop`` le niveau d'invalidation "
        "qu'il s'était fixé, ``r_multiple`` le résultat exprimé en multiples du "
        "risque planifié (``null`` = aucun stop n'avait été planifié).",
        _block("TRADE", trade or {}),
        _block("CONTEXTE", context or {}),
        "Structure ta réponse en quatre parties, dans cet ordre et sans titres "
        "pompeux : ce qui était bien / ce qui a cloché / le biais probable / UNE "
        "seule leçon actionnable pour le prochain trade. "
        "Si la thèse est vide ou trop courte, c'est LE sujet du post-mortem : un "
        "trade sans thèse écrite n'est pas analysable, et c'est ça qu'il faut "
        "corriger avant tout le reste.",
    ])


def build_weekly_prompt(context: Optional[Dict[str, Any]],
                        lang: str = "fr") -> str:
    """Prompt du bilan hebdomadaire du dimanche soir (LOT 3, C2).

    ``context`` (déterministe, construit par ``weekly.build_context``) porte
    les trades clôturés des 7 derniers jours, les statistiques de méthode
    (``risk.portfolio_stats``), le score de discipline, les positions encore
    ouvertes, les biais dominants du coach et le bilan du radar d'hypothèses.
    """
    return "\n\n".join([
        SYSTEM_PROMPT,
        _lang_line(lang),
        "Bilan HEBDOMADAIRE (dimanche soir). C'est un rituel, pas une "
        "urgence : Massii le lit une fois par semaine pour prendre du recul "
        "sur SA méthode, pas sur un trade en particulier.",
        _block("SEMAINE", context or {}),
        "Structure ta réponse en trois parties, dans cet ordre et sans "
        "titres pompeux : un bilan HONNÊTE de la semaine (ce qui a marché, "
        "ce qui a coûté cher — appuie-toi sur les chiffres fournis, "
        "n'invente rien) ; le biais ou l'habitude à surveiller en premier la "
        "semaine prochaine (choisis parmi ceux fournis, ou dis qu'aucun ne "
        "domine) ; UN plan concret et actionnable pour la semaine qui vient "
        "(pas une liste de vœux — une ou deux choses précises à faire ou à "
        "arrêter de faire).",
        "Si aucun trade n'a clôturé cette semaine, dis-le simplement et "
        "commente plutôt les positions encore ouvertes et la discipline "
        "générale — un bilan vide n'est pas un problème à masquer, c'est un "
        "fait à commenter.",
        "En complément, et SEULEMENT si tu as une idée vraiment concrète — "
        "pas à chaque bilan — tu peux terminer ta réponse par ce bloc "
        "optionnel, après le texte normal et rien d'autre dedans que ta "
        "proposition :\n"
        "```AMELIORATION_PROPOSEE\n"
        "UNE proposition concrète d'amélioration de l'outillage, d'une "
        "donnée, ou d'une règle du simulateur — jamais une refonte, jamais "
        "un conseil de trading.\n"
        "```\n"
        "Une seule proposition, jamais une liste, et seulement si elle est "
        "vraiment actionnable — sinon omets le bloc entièrement.",
    ])


def build_ideas_prompt(context: Optional[Dict[str, Any]], lang: str = "fr",
                       risk_level: str = DEFAULT_RISK_LEVEL,
                       journal: Any = None) -> str:
    """Prompt des idées de trade orientées RENTABILITÉ (extension utilisateur) —
    à la différence de ``build_coach_prompt`` (conversation libre), ici Massii
    ne demande pas de faire le point : il demande des idées concrètes.

    Doctrine explicite : le risque ne se gère JAMAIS en ne choisissant que des
    titres « sûrs » — il se gère par le sizing (petit) et le stop (toujours
    posé). On vise le POTENTIEL (catalyseur, momentum, asymétrie), pas la
    valeur refuge.

    ``risk_level`` choisit l'ÉTAGE (``mesure``/``agressif``/``speculatif``/
    ``crypto``, cf. ``_RISK_BLOCKS``) : univers autorisé, fourchette de risque,
    horizon. Le schéma JSON final est écrit DEPUIS cet étage — un prompt
    « mesuré » n'énumère donc jamais un genre d'actif qu'il vient d'interdire.

    ``journal`` = le résumé des dernières séries d'idées
    (``idea_journal.summarize``). C'est la mémoire du coach : sans elle, il
    reproposait tranquillement la même idée toutes les semaines, et le
    ré-entendre n'apprend rien à personne. La règle qui l'accompagne autorise
    explicitement la REDITE quand un facteur a changé — à condition de nommer
    ce qui a changé.
    """
    level = normalize_risk_level(risk_level)
    kinds = _LEVEL_KINDS[level]
    kinds_text = ", ".join('"%s"' % kind for kind in kinds)
    memory: list = []
    rows = [row for row in (journal or []) if isinstance(row, dict)]
    if rows:
        memory = [
            _block("HISTORIQUE DE TES PROPRES IDÉES (le plus récent en tête)",
                   rows),
            "Tu as l'HISTORIQUE de tes propres idées ci-dessus. Il t'est "
            "INTERDIT de reproposer une idée ÉQUIVALENTE (même ticker, même "
            "direction) — sauf si un facteur du contexte a CHANGÉ LA DONNE, et "
            "dans ce cas tu DOIS nommer ce qui a changé, sous la forme « je "
            "l'avais proposée le <date>, depuis <ce qui est arrivé> ». Une "
            "idée dont l'historique montre le résultat (``outcome``) est une "
            "information : sers-t'en, ne l'ignore pas.",
        ]
    return "\n\n".join([
        SYSTEM_PROMPT,
        _lang_line(lang),
        "ICI, ton rôle change de registre : Massii ne te demande pas de faire "
        "le point, il te demande des IDÉES DE TRADE concrètes, orientées "
        "RENTABILITÉ. Ta doctrine : le risque ne se gère JAMAIS en ne "
        "choisissant que des titres « sûrs » — il se gère par le sizing "
        "(petit) et le stop (toujours posé). Vise le POTENTIEL : un "
        "catalyseur identifiable, un momentum mesurable, une asymétrie "
        "gain/perte favorable. Un titre « sûr » sans catalyseur n'a rien à "
        "faire ici.",
        "Voici l'état du simulateur : ses positions, ses statistiques, ses "
        "biais détectés, les titres suivis (watchlist — creuse-les EN "
        "PRIORITÉ, sans t'y limiter), les hypothèses du radar déjà ouvertes "
        "(pour ne pas les reproposer), et les événements récents (presse, "
        "dépôts 13F) qui peuvent servir de catalyseur.",
        _block("CONTEXTE", context or {}),
        _HISTORY_LINE,
        POWER_NAMED_LINE,
    ] + _sweep_line(context) + memory + [
        _RISK_BLOCKS[level],
        "Commence ta réponse par UNE ligne d'en-tête qui annonce le niveau de "
        "cette série et sa fourchette de risque par idée — forme attendue : "
        "« Niveau %s — X à Y %% du capital par idée. » — puis enchaîne "
        "directement sur les idées. Massii doit savoir en une ligne à quel "
        "étage il lit." % _RISK_LABELS[level],
        "Propose 2 à 4 idées. Pour CHACUNE, donne dans le texte : le ticker "
        "Yahoo, la direction (hausse/baisse), pourquoi MAINTENANT (cite un "
        "catalyseur du contexte ci-dessus si le contexte en fournit un — "
        "sinon dis que c'est un pari technique/momentum, sans inventer de "
        "catalyseur), l'horizon (en jours ; en semaines ou en mois quand le "
        "niveau l'autorise — donne alors aussi l'équivalent en jours pour le "
        "champ ``horizon_days``), un stop suggéré (niveau de prix ou %), le "
        "risque conseillé DANS LA FOURCHETTE DU NIVEAU ci-dessus, la taille de "
        "position que ce risque implique compte tenu de la distance du stop, "
        "et la condition « invalidée si ».",
        "Le format 150-400 mots de la consigne générale s'entend ici PAR "
        "IDÉE (un paragraphe court et dense par idée, pas un roman) — 4 "
        "idées bien traitées valent mieux qu'une réponse générique.",
        "Interdits, comme toujours : jamais le mot « sûr » ou « valeur "
        "refuge » pour vendre une idée ; jamais de recommandation avec de "
        "l'argent réel ; n'invente RIEN qui ne soit pas dans le contexte "
        "ci-dessus — si le contexte est trop maigre pour 2 idées sérieuses, "
        "dis-le explicitement et rends-en moins (0 est une réponse "
        "légitime). Et tu ne SORS PAS de l'univers autorisé par le niveau, "
        "même si une idée d'un autre univers te paraît meilleure : c'est "
        "Massii qui choisit son étage, pas toi.",
        "Termine IMPÉRATIVEMENT ta réponse par ce bloc, et rien après "
        "(``risk_level`` vaut exactement \"%s\" pour TOUTES les idées de cette "
        "série ; ``asset_kind`` vaut l'un de : %s ; ``stop``/``risk_pct``/"
        "``invalidated_if``/``why_now`` reprennent EXACTEMENT ce que tu viens "
        "de détailler dans le texte ci-dessus pour cette idée — même stop, "
        "même risque, même condition, même catalyseur, pas une reformulation "
        "approximative) : "
        '```json\n{"ideas": [{"ticker": "AAPL", "direction": "up", '
        '"horizon_days": 10, "thesis": "une phrase courte", '
        '"stop": "niveau de prix ou %% (chaîne courte)", '
        '"risk_pct": 1.0, "invalidated_if": "condition courte", '
        '"why_now": "catalyseur en une phrase", '
        '"risk_level": "%s", "asset_kind": "%s"}]}\n```'
        % (level, kinds_text, level, kinds[0]),
    ])


def build_scenarios_prompt(context: Optional[Dict[str, Any]],
                           lang: str = "fr") -> str:
    """Prompt des ARBRES DE SCÉNARIOS — le coach dessine les chemins que le
    marché peut prendre (vue « Plan »).

    Registre encore différent des trois autres : ici on ne fait ni le point
    (``build_coach_prompt``), ni des paris (``build_ideas_prompt``) — on
    CARTOGRAPHIE. La valeur d'un arbre n'est pas de deviner la bonne branche,
    c'est d'avoir écrit AVANT ce qu'on ferait dans chacune : le jour où l'une
    se réalise, la décision est déjà prise à froid.

    D'où les deux exigences structurelles du prompt : des chemins qui
    DIVERGENT vraiment (trois formulations du même scénario ne préparent à
    rien) et des probabilités COHÉRENTES entre elles (trois « haute » sur trois
    chemins qui s'excluent, c'est une contradiction, pas une prévision).
    """
    return "\n\n".join([
        SYSTEM_PROMPT,
        _lang_line(lang),
        "ICI, ton rôle change de registre : tu es le STRATÈGE du simulateur. "
        "Massii ne te demande ni un bilan ni des paris — il te demande de "
        "CARTOGRAPHIER les chemins que le marché peut prendre à partir "
        "d'aujourd'hui, pour savoir d'avance quoi faire dans chaque cas. Un "
        "arbre de scénarios ne sert pas à deviner la bonne branche : il sert à "
        "ce que la décision soit déjà prise, à froid, le jour où l'une des "
        "branches se réalise.",
        "Voici l'état du simulateur : ses positions, ses statistiques, les "
        "titres suivis, les futurs achats déjà notés dans son tableau "
        "(``pipeline``), les hypothèses du radar ouvertes, et les événements "
        "récents (presse, annonces politiques, dépôts 13F).",
        _block("CONTEXTE", context or {}),
        _HISTORY_LINE,
        POWER_NAMED_LINE,
    ] + _sweep_line(context) + [
        "Construis UN SEUL arbre :\n"
        "- un TITRE : la question macro du moment, celle dont dépend le reste "
        "(ex. « La Fed baisse-t-elle en septembre ? ») — une question, pas un "
        "thème vague ;\n"
        "- un CONTEXTE de 2 à 3 phrases : où on en est, et pourquoi cette "
        "question se pose MAINTENANT, en citant les faits du contexte "
        "ci-dessus ;\n"
        "- 2 à 4 BRANCHES, c'est-à-dire des chemins qui DIVERGENT vraiment et "
        "s'excluent les uns les autres (ex. « la Fed coupe » / « statu quo » / "
        "« surprise restrictive »). Trois façons de dire la même chose ne sont "
        "pas trois branches et ne préparent à rien.\n"
        "Pour CHAQUE branche : un ``label`` court (quelques mots) ; une "
        "probabilité ``prob`` parmi « faible », « moyenne », « haute » ; une "
        "``consequence`` CONCRÈTE (quels secteurs, quels actifs bougent, dans "
        "quel sens) ; 1 ou 2 ``plays`` — le ticker Yahoo exact et la direction "
        "(``up`` / ``down``) ; et, seulement si ça éclaire quelque chose, 1 ou "
        "2 sous-branches (deux niveaux au MAXIMUM, on n'en lit pas plus).",
        "Les probabilités doivent être COHÉRENTES entre elles : des chemins "
        "qui s'excluent ne peuvent pas être tous « haute ». Si tu ne sais pas "
        "départager, mets « moyenne » partout et DIS-LE dans le texte — c'est "
        "une information, pas un aveu de faiblesse.",
        "Interdits, comme toujours : jamais le mot « sûr » ni « valeur "
        "refuge » ; jamais de recommandation avec de l'argent réel ; "
        "n'invente RIEN qui ne soit pas dans le contexte ci-dessus — si le "
        "contexte ne permet pas de poser une vraie question macro, prends la "
        "question qui découle le plus directement des positions et des titres "
        "suivis, et dis franchement qu'elle est déduite de son portefeuille et "
        "non de l'actualité.",
        "Écris d'abord 3 à 6 lignes de texte : la question, pourquoi elle se "
        "pose, et ce que Massii doit surveiller pour savoir quelle branche "
        "l'emporte. Termine IMPÉRATIVEMENT par ce bloc, et rien après "
        "(``status`` et identifiants sont posés par le serveur, ne les écris "
        "pas) : "
        '```json\n{"title": "La Fed baisse-t-elle en septembre ?", '
        '"context": "deux ou trois phrases", "branches": [{"label": "la Fed '
        'coupe", "prob": "moyenne", "consequence": "ce qui bouge, et dans '
        'quel sens", "plays": [{"ticker": "IWM", "direction": "up"}], '
        '"children": [{"label": "et l\'inflation repart", "prob": "faible", '
        '"consequence": "...", "plays": [{"ticker": "GLD", "direction": '
        '"up"}]}]}]}\n```',
    ])


# --------------------------------------------------------------------------- #
# Revue des positions DÉTENUES — la « prévision de vente » demandée
#
# Demande de l'utilisateur : « un bouton dans le portefeuille qui analyse avec
# les infos qu'on a déjà ». Deux mots comptent : *déjà* (aucune nouvelle
# source, on assemble ce que le simulateur sait) et *analyse* (on éclaire, on
# ne décide pas — dans un simulateur, garder / alléger / sortir sont des choix
# qui appartiennent à Massii).
# --------------------------------------------------------------------------- #
REVIEW_STANCES = ("garder", "surveiller", "alleger", "sortir")
# Repli sur « surveiller » : une posture illisible ne doit ni rassurer
# (« garder ») ni pousser à la sortie. C'est la même règle que
# ``_scenario_prob``, qui ne promeut jamais un chemin sur une valeur cassée.
REVIEW_DEFAULT_STANCE = "surveiller"

_STANCE_ALIASES = {
    "garder": "garder", "hold": "garder", "conserver": "garder",
    "surveiller": "surveiller", "watch": "surveiller", "attendre": "surveiller",
    "alleger": "alleger", "alléger": "alleger", "trim": "alleger",
    "reduire": "alleger", "réduire": "alleger",
    "sortir": "sortir", "exit": "sortir", "vendre": "sortir", "sell": "sortir",
}


def normalize_stance(value: Any) -> str:
    """Posture ramenée dans ``REVIEW_STANCES``. Inconnue -> « surveiller »."""
    return _STANCE_ALIASES.get(str(value or "").strip().lower(),
                               REVIEW_DEFAULT_STANCE)


def build_review_prompt(context: Optional[Dict[str, Any]],
                        lang: str = "fr") -> str:
    """Prompt de la revue des positions DÉTENUES (PUR).

    Le contexte est un fait-pack DÉTERMINISTE assemblé par le router : par
    position, son prix de revient, son cours, sa plus ou moins-value, son stop
    et la distance qui l'en sépare, les dépêches récentes qui la concernent, et
    les mouvements de grands gérants sur ce titre. Le modèle ne va rien
    chercher : il LIT ces faits et les met en mots.
    """
    return "\n\n".join([
        SYSTEM_PROMPT,
        _lang_line(lang),
        "ICI, ton rôle change de registre : Massii ne te demande ni un bilan "
        "ni des idées neuves — il te demande de PASSER EN REVUE les positions "
        "qu'il DÉTIENT DÉJÀ, avec les seules informations que le simulateur a "
        "sous la main. Il est DÉBUTANT : explique en phrases simples, et "
        "définis en trois mots tout terme de métier que tu emploies.",
        "Chaque position ci-dessous porte : le prix payé (``avg_price``), le "
        "cours actuel (``last_price``, ``null`` si le cours n'a pas pu être "
        "récupéré — dis-le alors, ne l'invente pas), la plus ou moins-value en "
        "pourcentage (``pnl_pct``), le stop posé (``stop_loss``) et la distance "
        "qui l'en sépare (``distance_stop_pct``), les dépêches récentes de ce "
        "titre (``news_recentes``), s'il y a eu une annonce politique récente "
        "(``gov_recent``) et les mouvements de grands gérants sur ce titre "
        "(``whale_moves_on_this``).",
        _block("POSITIONS ET FAITS", context or {}),
        _HISTORY_LINE,
        "Écris d'abord, pour CHAQUE position, un paragraphe court : où elle en "
        "est, ce qui la menace, ce qui la soutient, et ce que tu surveillerais "
        "pour trancher. Puis conclus par ta posture.",
        "PARLE TÔT, ici aussi : « surveiller » n'est PAS un refuge. Si tu "
        "choisis cette posture, tu DOIS donner le déclencheur PRÉCIS qui te "
        "fera trancher — un niveau de prix ou un événement nommé, ET le délai "
        "au bout duquel tu tranches si rien ne se passe. Une revue qui répond "
        "« on verra » sur toute la ligne n'a servi à rien.",
        "Rappels non négociables : les décisions restent à LUI — tu éclaires, "
        "tu ne décides pas ; jamais de recommandation avec de l'argent réel ; "
        "n'invente aucun chiffre ni aucun événement absent des faits ci-dessus.",
        "Termine IMPÉRATIVEMENT par ce bloc, et rien après (``stance`` vaut "
        "exactement l'un de : %s) : "
        '```json\n{"verdicts": [{"symbol": "AAPL", "stance": "surveiller", '
        '"reason": "une seule phrase"}]}\n```'
        % ", ".join('"%s"' % s for s in REVIEW_STANCES),
    ])


def parse_review(raw: Any) -> List[Dict[str, Any]]:
    """Les verdicts du bloc JSON final de la revue (PUR).

    Tolérant comme ses voisins : pas de bloc, JSON illisible, forme inattendue
    -> liste VIDE, jamais une exception. Le texte de la revue reste affiché même
    si la machine n'a rien pu en tirer — c'est lui que Massii lit.

    Une posture inconnue (ou forgée) retombe sur « surveiller » : le modèle
    n'a pas le droit d'inventer une posture que l'interface ne sait pas rendre.
    """
    if not isinstance(raw, str):
        return []
    start, end = raw.find("{"), raw.rfind("}")
    if start < 0 or end <= start:
        return []
    try:
        payload = json.loads(raw[start:end + 1])
    except ValueError:
        return []
    if not isinstance(payload, dict) or not isinstance(payload.get("verdicts"), list):
        return []

    out: List[Dict[str, Any]] = []
    for item in payload["verdicts"]:
        if not isinstance(item, dict):
            continue
        symbol = str(item.get("symbol") or "").strip().upper()
        if not symbol:
            continue
        out.append({
            "symbol": symbol,
            "stance": normalize_stance(item.get("stance")),
            "reason": str(item.get("reason") or "").strip(),
        })
    return out


def build_analysis_prompt(facts: Optional[Dict[str, Any]],
                          lang: str = "fr") -> str:
    """Prompt de la fiche pédagogique d'un titre."""
    return "\n\n".join([
        SYSTEM_PROMPT,
        _lang_line(lang),
        "Fiche pédagogique sur un titre. Tous les chiffres ci-dessous sont "
        "calculés depuis les bougies Yahoo ; un champ ``null`` veut dire que la "
        "série ne permettait pas de le calculer — dis-le, ne le remplace pas.",
        _block("FAITS", facts or {}),
        # « en mots simples » et non « en français simple » : la langue de sortie
        # est décidée UNIQUEMENT par _lang_line, sinon les deux consignes se
        # contredisent dès que Massii lit en italien.
        "Écris trois choses : (1) la lecture de ces chiffres en mots simples "
        "(où est le cours dans son année, ce que disent les moyennes et la "
        "volatilité) ; (2) ce qu'un swing trader regarderait ensuite sur ce "
        "titre ; (3) les questions que Massii doit se poser AVANT d'écrire une "
        "thèse dessus. "
        "INTERDIT ABSOLU : ne donne aucun avis d'achat ou de vente, aucun "
        "objectif de cours, aucune prévision. Tu décris et tu enseignes à lire.",
    ])


# --------------------------------------------------------------------------- #
# LOT 4 — le coach a SON compte, et il DÉCIDE dans le même souffle qu'il PARLE
#
# Demande de Massii : « quand tu m'envoies une convergence, il doit réagir lui
# aussi » et « mesurer si ce qu'il m'annonce fonctionne ». D'où l'exigence
# centrale : ce que le coach DIT et ce qu'il FAIT sortent du MÊME appel au
# modèle. Deux appels séparés ne mesureraient rien — ils compareraient deux
# discours, et le second aurait toujours raison après coup.
#
# DEUX prompts réclament donc ce même bloc de clôture : le digest de
# convergence (``convergence.build_digest_prompt``) et la passe quotidienne de
# gestion (:func:`build_coach_trader_prompt`). Il est écrit ICI, une seule
# fois — un format décrit à deux endroits diverge au premier ajustement, et la
# divergence ne se voit que le jour où le parseur rend zéro action, en silence.
#
# Les SEUILS ne sont PAS recopiés : ils sont lus sur ``coach_trader``, la
# source unique du garde-fou. Ainsi le prompt et le refus parlent toujours des
# mêmes chiffres — un seuil ajusté d'un côté ne peut plus mentir de l'autre.
# --------------------------------------------------------------------------- #

def _pct(value: Any) -> str:
    """« 2 % » et non « 2.0 % » : ce texte se LIT, il ne se sérialise pas."""
    try:
        number = float(value)
    except (TypeError, ValueError):
        return "?"
    return "%s %%" % ("%g" % number).replace(".", ",")


def _coach_book_of(context: Any) -> Dict[str, Any]:
    """Le compte du coach, extrait d'un contexte de passe quotidienne (PUR).

    Les cinq clés sont TOUJOURS présentes, même vides : le bloc d'actions ne
    doit pas disparaître d'un prompt sous prétexte que le compte est neuf (un
    coach sans position doit pouvoir ouvrir sa première ligne).

    ``candidates`` (LOT 4bis) : le cours ACTUEL des tickers suivis par le
    radar (``_coach_pass_context``/``coach_book`` en sont les producteurs côté
    router). Né d'un vécu en prod : un livre neuf ou vide n'a AUCUN prix hors
    de ce qu'il détient déjà, et le coach a passé trois soirs de suite à
    refuser d'ouvrir quoi que ce soit faute de cours pour fixer un stop — une
    faim de données, pas de la timidité.
    """
    ctx = context if isinstance(context, dict) else {}
    return {
        "cash_chf": ctx.get("cash_chf"),
        "equity_chf": ctx.get("equity_chf"),
        "positions": ctx.get("positions") or [],
        "open_orders": ctx.get("open_orders") or [],
        "candidates": ctx.get("candidates") or [],
        # LOT 9 — le déploiement CHIFFRÉ (``coach_trader.deployment_view``).
        # Il traverse le book parce que le mandat « sois DÉPLOYÉ » vit dans le
        # bloc PARTAGÉ : le poser ailleurs le ferait exister d'un seul côté.
        "deployment": ctx.get("deployment") or {},
    }


def _deployment_lines(view: Any) -> list:
    """La ligne CHIFFRÉE du déploiement, ou rien (PUR — LOT 9).

    Absente quand la vue manque : la CONSIGNE (« sois déployé ») reste dans le
    bloc de toute façon — c'est le chiffre qui est facultatif, jamais le
    mandat. Un modèle ne recompte pas ses lignes de façon fiable dans un JSON
    de contexte ; quand on peut le lui donner, on le lui donne.
    """
    if not isinstance(view, dict) or not view:
        return []
    n = view.get("n_positions")
    themes = view.get("themes_ouverts")
    line = ("TON DÉPLOIEMENT À CETTE SECONDE : %s de ton équité dort en "
            "trésorerie, %s ligne(s) ouverte(s)."
            % (_pct(view.get("cash_pct")), n if isinstance(n, int) else "?"))
    if isinstance(themes, list) and themes:
        line += (" Thèmes DÉJÀ engagés — n'en rejoue AUCUN, cherche ailleurs : "
                 + " | ".join(str(t) for t in themes))
    else:
        line += (" Aucun thème engagé : tout l'univers t'est ouvert, et une "
                 "passe de plus sans rien armer se verra.")
    return [line]


def coach_actions_block(book: Any) -> str:
    """Le bloc de clôture qui transforme un avis en DÉCISION (PUR).

    ``book`` = ``{"cash_chf", "equity_chf", "positions", "open_orders"}``.
    ``None``, vide ou d'une autre forme -> chaîne VIDE : un prompt qui décrit
    une section absente invite le modèle à la combler tout seul (même
    précaution que :func:`_sweep_line`).

    Il dit quatre choses, et les quatre comptent :
      1. ce que le coach a en main (sans quoi il dimensionne à l'aveugle) ;
      2. les bornes DURES du mandat, en clair — un modèle qui ne les connaît
         pas propose des ordres refusés, et le refus est PUBLIC ;
      3. le format exact du bloc que la machine lira ;
      4. que **zéro action est une réponse légitime** — on n'invente jamais un
         ordre pour avoir l'air actif.
    """
    if not isinstance(book, dict) or not book:
        return ""

    setups = ", ".join('"%s"' % setup for setup in models.SETUPS)
    kinds = " | ".join(coach_trader.ACTION_KINDS)

    # ⚠️ ORDRE SIGNIFIANT : la consigne « termine par ce bloc, et RIEN après »
    # doit être VRAIE dans la mise en page. Elle et son exemple ferment donc la
    # section — une consigne démentie par ce qui la suit apprend au modèle que
    # les consignes sont approximatives, et le bloc finirait au milieu du
    # message. Épinglé par un test.
    entrees = " et ".join(coach_trader.ENTRY_ACTIONS)
    sorties = " et ".join(coach_trader.EXIT_ACTIONS)

    return "\n\n".join([
        "Voici ce que tu as en main à cette seconde — c'est TON livre, pas "
        "celui de Massii :",
        _block("TON COMPTE", book),
        # LOT 4bis — vécu en prod : un livre neuf n'a NULLE PART de cours hors
        # de ce qu'il détient déjà (``positions`` ne cote QUE l'existant), et
        # le coach a enchaîné trois passes « je ne peux rien ouvrir sans cours
        # pour fixer un stop » — une faim de données, pas de la prudence.
        "``candidates`` (dans TON COMPTE ci-dessus) donne le cours ACTUEL, "
        "converti en CHF, de chaque ticker suivi par une hypothèse OUVERTE du "
        "radar : tu as tout pour dimensionner un stop technique et une "
        "taille cohérente avec ton risque — entre quand une thèse le mérite, "
        "le manque de données n'est plus une excuse. Une liste vide veut "
        "dire qu'aucune hypothèse n'est ouverte en ce moment, pas qu'aucun "
        "titre n'existe.",
        # LOT 5 — l'autre moitié du blocage vécu : « je n'ai pas de niveau
        # technique fiable pour poser un stop ». Il l'a maintenant.
        "Chaque candidat et chaque ligne portent un champ ``technical`` : "
        "moyennes mobiles 20/50/200, RSI 14, ATR 14 (en valeur ET en % du "
        "cours), plus haut et plus bas de 52 semaines, position dans ce canal, "
        "variation sur 5 séances. POSE DES STOPS TECHNIQUES : sous un support "
        "ou une moyenne pour un achat, au-dessus d'une résistance ou d'une "
        "moyenne pour une vente à découvert. L'ATR te donne l'ORDRE DE "
        "GRANDEUR — un stop plus serré que 1 ATR se fait sortir par le bruit "
        "ordinaire du titre, un stop à 2 ou 3 ATR laisse respirer la thèse. "
        "Un champ ``null`` veut dire que la donnée n'a pas pu être calculée "
        "(série trop courte) : ne l'invente pas, sers-toi du reste.",
        # Le mur vécu : quatre refus d'entrer d'affilée, ses meilleures thèses
        # étant BAISSIÈRES. Le moteur savait shorter, le mandat l'interdisait.
        "LE SHORT EST DISPONIBLE. Une thèse BAISSIÈRE à conviction se JOUE "
        "(``short``), elle ne se regarde plus passer : tu vends à découvert, "
        "avec un stop AU-DESSUS de ton entrée (le miroir exact de l'achat, où "
        "il est en dessous), et tu refermes par ``cover``. Les mêmes plafonds "
        "s'appliquent, à un détail près : une vente à découvert n'achète rien, "
        "elle ne consomme donc pas ton plancher de trésorerie. Tu ne peux pas "
        "tenir les deux sens sur un même titre — solde avant de retourner ta "
        "position.",
        "``adjust_stop`` déplace le stop d'une ligne ouverte, et il ne sait "
        "faire qu'UNE chose : le RESSERRER (le monter sous un achat, le "
        "descendre au-dessus d'une vente à découvert). C'est ce qui rend "
        "tenable « laisser courir les gagnants » — protéger un gain sans "
        "solder la ligne. Un stop qui s'éloigne est REFUSÉ : ce ne serait pas "
        "de la gestion, ce serait annuler une décision que tu as déjà prise.",
        # Directive de Massii : « le but, vu que c'est un test, c'est qu'il
        # gagne le plus possible — cela ne veut pas dire d'oublier toute mesure
        # de sûreté ». La sûreté vit dans le garde-fou DÉTERMINISTE
        # (``coach_trader.gate_decision``), qui ne bouge pas d'un iota ; le
        # PROMPT, lui, doit viser la performance. Sans ce paragraphe, un modèle
        # à qui on n'énonce que des plafonds joue systématiquement en dessous
        # — et un livre trop timide ne mesure rien.
        "MANDAT — TU JOUES POUR GAGNER. Ce compte est un TEST : l'objectif est "
        "la PERFORMANCE la plus haute possible SOUS les règles ci-dessous, pas "
        "la préservation du capital pour elle-même. Un livre qui dort en cash "
        "sans raison échoue à ce test autant qu'un livre qui explose. "
        "Concrètement : quand la conviction est là, vise un risque PROCHE du "
        "plafond de %s de ton équité sur le trade — jamais au-dessus, le "
        "garde-fou refuse — et une taille PLEINE entre %s et %s de ton équité. "
        "Viser le bas de la fourchette « par prudence » est un MAUVAIS RÉFLEXE "
        "ici : le plancher de %s existe déjà pour ça, la prudence est DANS les "
        "règles, tu n'as pas à en rajouter par-dessus. Laisse COURIR les "
        "gagnants — on déplace le stop, on ne solde pas pour encaisser un "
        "mini-profit rassurant. Coupe VITE ce qui est invalidé, le jour où "
        "c'est invalidé. Et ne JAMAIS moyenner à la baisse une thèse morte : "
        "ajouter à une perte, c'est doubler une erreur." % (
            _pct(coach_trader.MAX_RISK_PCT),
            _pct(coach_trader.MIN_POSITION_PCT),
            _pct(coach_trader.MAX_POSITION_PCT),
            _pct(coach_trader.MIN_POSITION_PCT)),
        "Ces bornes sont celles de TON livre. Elles n'ont rien à voir avec le "
        "dimensionnement prudent que tu conseilles à un débutant : la "
        "cohérence qu'on te demande entre ce que tu dis et ce que tu fais "
        "porte sur la LECTURE (le titre, le sens, la thèse), pas sur la "
        "taille.",
        "RÈGLES DURES DU MANDAT (elles ne se négocient pas, et elles ne se "
        "rognent pas : franchir l'une d'elles ne réduit pas ton ordre, elle le "
        "REFUSE, et le refus est archivé publiquement avec son motif) — "
        "un achat SANS stop est refusé ; une ligne qui vaudrait moins de %s de "
        "ton équité est refusée (pas d'actions en centimes : ce n'est pas une "
        "position, c'est un ticket de loterie) ; une ligne qui dépasserait %s "
        "de ton équité est refusée ; un ordre dont la perte planifiée "
        "(distance entrée-stop x quantité) dépasse %s de ton équité est "
        "refusé ; tu ne tiens jamais plus de %d lignes ouvertes, dont au plus "
        "%d cryptos ; et il te reste TOUJOURS au moins %s de trésorerie — on "
        "ne se met jamais à sec." % (
            _pct(coach_trader.MIN_POSITION_PCT),
            _pct(coach_trader.MAX_POSITION_PCT),
            _pct(coach_trader.MAX_RISK_PCT),
            coach_trader.MAX_POSITIONS,
            coach_trader.MAX_CRYPTO,
            _pct(coach_trader.MIN_CASH_PCT)),
        "Une SORTIE (%s) n'a besoin ni de thèse ni de stop : elle réduit "
        "l'exposition. Une ENTRÉE (%s) exige une thèse écrite d'au moins %d "
        "caractères et un stop du BON CÔTÉ du prix — sous lui pour un achat, "
        "au-dessus pour une vente à découvert — sans quoi elle est refusée."
        % (sorties, entrees, coach_trader.MIN_THESIS_LEN),
        # LOT 9 — « on ne peut pas rester à attendre » (directive de Massii,
        # née d'un vécu : UNE ligne tenue, et des passes entières à guetter
        # « une clôture sous la SMA50 » sans jamais rien armer). Le mandat ne
        # dit plus seulement ce qui est INTERDIT, il dit ce qui est ATTENDU.
        "RÉGIME DÉPLOYÉ : vise 3 à 5 positions OUVERTES sur des THÈMES "
        "DIFFÉRENTS. Le même catalyseur ne se joue qu'UNE fois (ta règle "
        "anti-corrélation est juste) — mais chaque THÈME distinct à "
        "conviction se joue : carburant/Iran, tarifs, semi-conducteurs, "
        "l'Europe, la crypto sont des paris INDÉPENDANTS. Si ton cash "
        "dépasse 50 % de l'équité ALORS QU'il existe des candidats "
        "tradables à thèse valable, tu DOIS expliquer pourquoi tu n'es pas "
        "déployé — l'attente du parfait est une faute (doctrine du "
        "propriétaire : n'attends pas le parfait, ce sera déjà trop tard). "
        "L'inaction se paie en crédibilité : ton taux de déploiement est "
        "archivé et comparé.",
    ] + _deployment_lines(book.get("deployment")) + [
        "TU ES NOTÉ, ET LA NOTE EST PUBLIQUE. Chaque décision est archivée puis "
        "comparée : le REGISTRE garde tes ordres acceptés ET tes REFUS avec "
        "leur motif ; un score de DISCIPLINE mesure le respect de ta propre "
        "méthode ; chaque trade clos est mesuré en MAE/MFE (le pire creux et "
        "le meilleur sommet traversés avant ta sortie) ; et ta COURBE de "
        "patrimoine s'affiche FACE à celle de Massii. Tu joues ta CRÉDIBILITÉ "
        "à chaque ligne — c'est ce qui te tient honnête, et c'est pourquoi ni "
        "le sur-risque ni la timidité ne passent inaperçus.",
        "Si tu n'as RIEN à faire aujourd'hui, rends les actions VIDES : "
        '``{"actions": []}``. Ne rien faire reste une réponse légitime, et '
        "parfois la bonne — mais ce doit être un CHOIX ARGUMENTÉ, jamais de la "
        "timidité : le registre archive AUSSI les passes sans action. On "
        "n'invente jamais un ordre pour avoir l'air actif ; on ne s'abstient "
        "jamais non plus pour éviter d'avoir tort. Dans ce cas précis, "
        "``note`` devient OBLIGATOIRE : explique en 2 à 3 phrases "
        "SPÉCIFIQUES ce que tu vois et ce que tu attends pour agir — un "
        "niveau de prix précis, un événement daté de l'agenda, une "
        "confirmation nommée. Une généralité comme « j'attends une "
        "meilleure opportunité » ne passe pas : ça ne dit rien, et le "
        "registre l'afficherait tel quel, mot pour mot.",
        "Termine IMPÉRATIVEMENT ta réponse par ce bloc, et RIEN après. Il est "
        "purement TECHNIQUE : il ne répète rien du texte lisible qui précède, "
        "c'est la machine qui le lit, pas Massii. ``action`` vaut %s ; "
        "``symbol`` est un ticker Yahoo ; ``qty`` est un entier ; ``stop`` et "
        "``target`` sont des PRIX exprimés dans la DEVISE DU TITRE (jamais "
        "convertis) ; ``thesis`` tient en une phrase ; ``setup`` est "
        "facultatif et vaut l'un de : %s. Un ``sell`` ou un ``cover`` SANS "
        "``qty`` veut dire « solder la ligne entière » ; un ``adjust_stop`` "
        "ne prend que ``symbol`` et ``stop`` (rien ne s'échange). ``note`` "
        "est un champ de TÊTE, à côté de ``actions`` (pas dedans) : "
        "FACULTATIF et bienvenu en une phrase de lecture de marché quand tu "
        "agis, OBLIGATOIRE quand tu n'agis pas (cf. ci-dessus)."
        % (kinds, setups),
        "```%s\n"
        '{"actions": [{"action": "buy", "symbol": "NESN.SW", "qty": 12, '
        '"stop": 92.5, "target": 118.0, "thesis": "une phrase courte", '
        '"setup": "news"}], "note": "une phrase de lecture de marché"}\n'
        "```" % coach_trader.ACTIONS_MARKER,
    ])


def build_coach_screen_prompt(context: Optional[Dict[str, Any]],
                              lang: str = "fr") -> str:
    """PREMIER TEMPS de la passe : le TRI (PUR, LOT 5).

    Il reçoit le contexte COMPLET (livre, candidats cotés avec leur analyse
    technique, radar, humeur du marché, agenda) et ne rend qu'une chose : les
    ``MAX_FOCUS`` titres qui méritent un dossier. C'est ce tri qui décide si un
    second appel part — et « aucun » est une réponse légitime qui n'en coûte
    aucun.

    Il ne PASSE PAS d'ordre : aucun bloc d'actions ici, exprès. Un modèle à qui
    on demande de décider avec un contexte large décide mal ; on lui demande
    donc de REPÉRER, puis on lui donne les moyens de décider sur trois titres.
    """
    ctx = context if isinstance(context, dict) else {}
    return "\n\n".join([
        SYSTEM_PROMPT,
        _lang_line(lang),
        "PREMIER TEMPS — LE TRI. Tu gères TON livre, et tu commences par "
        "regarder large : ce que tu détiens, ce que le radar suit, la "
        "nervosité du marché, les rendez-vous datés qui approchent. Ta seule "
        "tâche ici est de DÉSIGNER les titres qui méritent qu'on ouvre leur "
        "dossier complet — tu ne passes aucun ordre à cette étape.",
        _block("CONTEXTE", ctx),
        "Regarde d'abord tes propres lignes : une position dont la thèse ne "
        "tient plus, dont le stop mérite d'être resserré ou dont le catalyseur "
        "est passé sans rien produire mérite un dossier autant qu'une "
        "opportunité neuve. Regarde ensuite les candidats du radar : un écart "
        "de prix marquant, un niveau technique atteint, un rendez-vous "
        "imminent.",
        "⚠️ Chaque candidat porte un champ ``tradable`` : ``true`` si son "
        "marché est OUVERT à cet instant, ``false`` sinon (bourse fermée hors "
        "de ses horaires locaux, week-end compris — les cryptos, elles, sont "
        "TOUJOURS ``tradable``). Tu ne peux agir — ouvrir, alléger ou sortir — "
        "QUE sur un titre ``tradable`` : un ordre sur un marché fermé sera "
        "automatiquement refusé (``market_closed``). Tu peux en revanche "
        "TOUJOURS resserrer le stop d'une ligne, marché ouvert ou fermé : "
        "c'est une consigne au carnet, elle n'agira qu'à la réouverture.",
        # LOT 8b — chaque candidat sait maintenant dire POURQUOI il est là :
        # sans ça, un candidat du pool européen (jamais mentionné par une
        # actualité) et une opportunité repérée par le radar se ressemblent
        # à l'écran, alors qu'elles ne méritent pas le même degré de
        # confiance a priori.
        "Chaque candidat porte aussi un champ ``source`` : ``position`` (tu "
        "la détiens déjà), ``radar`` (une hypothèse ouverte le suit), "
        "``watchlist`` (Massii le surveille personnellement — tu peux "
        "creuser plus volontiers ce type de titre) ou ``europe_pool`` (une "
        "grande valeur suisse ou européenne, TOUJOURS présente même sans "
        "actualité récente, pour que tu aies un univers à examiner même aux "
        "heures où seule l'Europe est ouverte). Ce n'est pas une note de "
        "qualité : un ``europe_pool`` sans rien de neuf ne mérite peut-être "
        "aucun dossier, un ``radar`` peut être daté — la source dit "
        "seulement d'où vient le titre, c'est TOI qui juges s'il mérite un "
        "dossier, et tu peux citer cette raison dans ta note.",
        "Retiens AU PLUS %d titres, et seulement ceux sur lesquels tu es "
        "prêt à agir aujourd'hui — pas ceux qui « pourraient être "
        "intéressants ». Une liste VIDE est une réponse légitime quand rien "
        "n'atteint tes critères, et elle t'évite un examen inutile ; mais "
        "elle doit être un CHOIX, pas de la timidité : le registre archive "
        "aussi les journées sans action." % coach_trader.MAX_FOCUS,
        "Écris d'abord deux ou trois phrases de lecture du marché et de ton "
        "livre, puis termine IMPÉRATIVEMENT par ce bloc, et RIEN après. "
        "``focus`` est une liste de tickers Yahoo (au plus %d, éventuellement "
        "vide) ; ``note`` dit en une à trois phrases SPÉCIFIQUES pourquoi ces "
        "titres — ou, si la liste est vide, ce que tu attends précisément pour "
        "agir : un niveau de prix, une date de l'agenda, une confirmation "
        "nommée. « J'attends une meilleure opportunité » ne dit rien et sera "
        "affiché tel quel." % coach_trader.MAX_FOCUS,
        "```%s\n"
        '{"focus": ["NESN.SW", "BTC-USD"], "note": "pourquoi ces deux-là"}\n'
        "```" % coach_trader.FOCUS_MARKER,
    ])


def _dossier_line(context: Any) -> list:
    """La section DOSSIERS du second temps, ou rien (PUR).

    Absente quand le tri n'a rien retenu — une section vide inviterait le
    modèle à la combler tout seul (même précaution que :func:`_sweep_line`).
    """
    ctx = context if isinstance(context, dict) else {}
    dossiers = ctx.get("dossiers")
    if not isinstance(dossiers, list) or not dossiers:
        return []
    return [
        "DOSSIERS — voici TOUT ce que la mémoire sait des titres que tu as "
        "retenus au premier temps. Pour chacun : son analyse technique "
        "(``technical``), la presse récente (``news``), son dossier historique "
        "(``history``), les mouvements de grands gérants qui le concernent "
        "(``whale_moves``) et ce que TU as déjà dit de lui (``memory`` : tes "
        "hypothèses passées et leur verdict). C'est sur cette matière que tu "
        "décides — et ``memory`` est là pour que tu ne rejoues pas une thèse "
        "que tu as déjà vue échouer.",
        _block("DOSSIERS", dossiers),
    ]


def build_coach_trader_prompt(context: Optional[Dict[str, Any]],
                              lang: str = "fr") -> str:
    """Prompt de la PASSE QUOTIDIENNE de gestion du compte du coach (PUR).

    Registre distinct des autres : ici il ne conseille personne, il GÈRE son
    livre. Une passe par jour de marché au maximum (``coach_trader.pass_due``),
    donc un appel au modèle par jour — l'économie est le contrat.

    ``context`` (tout facultatif, un contexte partiel ne LÈVE jamais) :
    ``now``/``cash_chf``/``equity_chf``/``initial_capital``/``positions``/
    ``open_orders``/``stats``/``discipline``/``radar``/``market_mood``/
    ``agenda``. Le compte passé au bloc de clôture en est extrait
    (:func:`_coach_book_of`) : une seule vérité, jamais deux photos du même
    portefeuille à deux endroits du prompt.
    """
    ctx = context if isinstance(context, dict) else {}
    return "\n\n".join([
        SYSTEM_PROMPT,
        _lang_line(lang),
        "PASSE QUOTIDIENNE DE GESTION. Tu n'es pas ici en train de conseiller "
        "quelqu'un : tu gères TON livre, comme un professionnel discipliné. Ta "
        "doctrine tient en quatre gestes — tu COUPES ce qui est invalidé (la "
        "thèse ne tient plus, le stop est touché, le catalyseur est passé sans "
        "rien produire), tu laisses COURIR ce qui marche (une position qui "
        "travaille ne se solde pas pour encaisser un petit gain rassurant), tu "
        "n'entres que par CONVICTION (une thèse que tu peux écrire en une "
        "phrase, un stop que tu peux nommer), et tu assumes de NE RIEN FAIRE "
        "quand il n'y a rien à faire.",
        _block("CONTEXTE", ctx),
    ] + _dossier_line(ctx) + [
        "Écris, dans cet ordre et sans titres pompeux : (1) l'état de ton "
        "livre en deux ou trois phrases — ce qui travaille, ce qui traîne, ce "
        "qui te coûte ; (2) ligne par ligne, ce que tu fais de chacune "
        "(garder, alléger, sortir) et POURQUOI, en nommant le niveau qui "
        "invaliderait ta lecture ; (3) ce que tu ouvres aujourd'hui, s'il y a "
        "quelque chose à ouvrir — avec la thèse, le stop et la taille.",
        "Sers-toi de tout ce que le contexte te donne : tes statistiques (ce "
        "que ta méthode réussit ET ce qu'elle rate), ton score de discipline, "
        "les hypothèses ouvertes du radar, la nervosité du marché, et "
        "l'agenda des rendez-vous à venir — une échéance dans trois jours sur "
        "une ligne que tu détiens change ce que tu en fais aujourd'hui.",
        "INTERDITS ABSOLUS, comme toujours : jamais les mots « sûr » ou "
        "« garanti », ni aucun vocabulaire de la certitude — ce sont des "
        "paris, tu le dis ; jamais aucune recommandation d'acheter ou de "
        "vendre avec de l'ARGENT RÉEL (ceci est un simulateur d'apprentissage, "
        "et ce compte est fictif) ; et n'invente RIEN qui ne soit pas dans le "
        "contexte ci-dessus — pas un chiffre, pas un événement, pas un cours.",
        coach_actions_block(_coach_book_of(ctx)),
    ])


_GUARDIAN_TRIGGER_LINES = {
    "move": "le cours a bougé de %s ou plus depuis le dernier passage du "
           "gardien sur cette ligne — un mouvement de cette ampleur en un "
           "seul cycle de veille mérite un coup d'œil.",
    "stop": "le cours est à moins de %s de ton STOP — ÇA CHAUFFE. Vérifie "
           "si la thèse tient encore, ou si c'est déjà l'heure de couper.",
    "target": "le cours est à moins de %s de ton OBJECTIF — il MÛRIT. "
             "Pense à RESSERRER le stop pour protéger le gain plutôt que "
             "d'attendre passivement qu'il soit atteint.",
}


def build_coach_guardian_prompt(context: Optional[Dict[str, Any]],
                                lang: str = "fr") -> str:
    """Prompt de la passe GARDIEN — gestion FOCALISÉE d'UNE SEULE position,
    entre deux passes planifiées (PUR, LOT 8).

    COURT, DÉLIBÉRÉMENT : le gardien réagit à un mouvement de marché sur UNE
    ligne, il ne relit pas tout le livre (radar, candidats, agenda) comme les
    passes planifiées — juste la ligne qui l'a réveillé, avec ce qu'il faut
    pour en juger (cours, technique, plan, P&L, déclencheur nommé). C'est ce
    qui rend soutenable un appel toutes les quelques minutes sur un titre qui
    bouge, là où le prompt complet des passes planifiées ne l'est pas.

    ``context`` : ``{"symbol","side","qty","avg_price","current_price",
    "pnl_pct","stop_loss","target","dist_stop_pct","dist_target_pct",
    "technical","thesis","trigger"}`` — ``trigger`` ∈ ``coach_trader.
    GUARDIAN_TRIGGERS``, tout le reste tolère l'absence (PUR, ne lève jamais).

    Le bloc de clôture réutilise ``coach_trader.ACTIONS_MARKER``/``parse_
    actions`` (MÊME contrat que les passes planifiées) mais restreint la
    LISTE des actions à ``coach_trader.GUARDIAN_ALLOWED_ACTIONS`` : le
    périmètre (cette ligne, jamais une ouverture neuve) est ENFONCÉ dans le
    prompt ET vérifié au garde-fou (``coach_trader.guardian_gate``) — la
    double sécurité habituelle de ce module.
    """
    ctx = context if isinstance(context, dict) else {}
    symbol = str(ctx.get("symbol") or "").strip() or "SYMBOLE"
    trigger = str(ctx.get("trigger") or "").strip()
    pct_by_trigger = {
        "move": coach_trader.GUARDIAN_MOVE_PCT,
        "stop": coach_trader.GUARDIAN_STOP_PROXIMITY_PCT,
        "target": coach_trader.GUARDIAN_TARGET_PROXIMITY_PCT,
    }
    if trigger in _GUARDIAN_TRIGGER_LINES:
        pourquoi = _GUARDIAN_TRIGGER_LINES[trigger] % _pct(pct_by_trigger[trigger])
    else:
        pourquoi = "le marché a bougé sur cette ligne."

    kinds = " | ".join(coach_trader.GUARDIAN_ALLOWED_ACTIONS)
    return "\n\n".join([
        SYSTEM_PROMPT,
        _lang_line(lang),
        "PASSE GARDIEN — GESTION FOCALISÉE D'UNE SEULE LIGNE. Une sentinelle "
        "déterministe t'a réveillé, entre deux passes planifiées, POUR CETTE "
        "POSITION SEULE (%s) : %s" % (symbol, pourquoi),
        _block("LA POSITION", ctx),
        "Tu ne gères QUE cette ligne — aucune autre, et surtout aucune "
        "OUVERTURE nouvelle (ça, c'est le travail des passes planifiées, qui "
        "voient tout le livre). Trois gestes possibles : COUPER (``sell``/"
        "``cover`` pour solder, ``reduce`` pour alléger) si la thèse ne tient "
        "plus ou que le stop est touché ; RESSERRER (``adjust_stop``, il ne "
        "sait QUE monter le stop d'un long ou descendre celui d'un short) si "
        "la position travaille et qu'un gain mérite d'être protégé ; ou NE "
        "RIEN FAIRE — un choix ARGUMENTÉ, jamais un silence : ``note`` "
        "devient alors OBLIGATOIRE, en une phrase précise (pas « je "
        "surveille », ça ne dit rien).",
        "Termine IMPÉRATIVEMENT ta réponse par ce bloc, et RIEN après. "
        "``action`` vaut %s ; ``symbol`` est « %s » (rien d'autre n'a de sens "
        "ici, toute autre valeur est refusée) ; un ``sell``/``cover`` SANS "
        "``qty`` veut dire « solder la ligne entière »." % (kinds, symbol),
        "```%s\n"
        '{"actions": [{"action": "adjust_stop", "symbol": "%s", "stop": %s}], '
        '"note": "une phrase courte"}\n'
        "```" % (coach_trader.ACTIONS_MARKER, symbol,
                 _num_or_null(ctx.get("stop_loss"))),
    ])


def _num_or_null(value: Any) -> str:
    """``92.5`` -> ``"92.5"``, illisible -> ``"null"`` — pour un exemple JSON
    dont le stop peut être absent (PUR)."""
    try:
        if value is None or isinstance(value, bool):
            return "null"
        return repr(float(value))
    except (TypeError, ValueError):
        return "null"


# --------------------------------------------------------------------------- #
# Lecture de la réponse « scénarios » — PUR
#
# Le bloc JSON final est la SEULE partie que la machine consomme ; le texte qui
# le précède est pour Massii. Les bornes ci-dessous doivent rester identiques à
# celles de ``board.py`` (un test les épingle l'une contre l'autre) : un prompt
# qui promet 4 branches à un stockage qui n'en garde que 3 perdrait la
# dernière en silence.
# --------------------------------------------------------------------------- #
SCENARIO_MIN_BRANCHES = 2
SCENARIO_MAX_BRANCHES = 4
SCENARIO_MAX_DEPTH = 2
SCENARIO_MAX_PLAYS = 2
SCENARIO_PROBS = ("faible", "moyenne", "haute")
SCENARIO_DEFAULT_PROB = "moyenne"
SCENARIO_DIRECTIONS = ("up", "down")


def intro_of(raw: Any) -> str:
    """Le texte d'introduction SEUL — ce que le coach a écrit avant son bloc
    JSON (PUR).

    On coupe à la clôture de code (```` ``` ````) si elle existe, sinon à la
    première accolade. Rien à couper -> le texte entier : mieux vaut afficher
    un peu trop que de rendre un encadré vide parce que le modèle a changé sa
    mise en forme.
    """
    if not isinstance(raw, str):
        return ""
    for marker in ("```", "{"):
        cut = raw.find(marker)
        if cut > 0:
            head = raw[:cut].strip()
            if head:
                return head
    return raw.strip()


def _scenario_prob(value: Any) -> str:
    """Probabilité normalisée. Inconnue -> « moyenne » (jamais « haute » : une
    valeur illisible ne doit pas promouvoir un chemin)."""
    text = str(value or "").strip().lower()
    return text if text in SCENARIO_PROBS else SCENARIO_DEFAULT_PROB


def _scenario_plays(value: Any) -> list:
    """Les mouvements d'une branche : ``{ticker, direction}``, bornés."""
    out = []
    if not isinstance(value, list):
        return out
    for play in value:
        if not isinstance(play, dict):
            continue
        ticker = str(play.get("ticker") or "").strip().upper()
        if not ticker:
            continue
        direction = str(play.get("direction") or "").strip().lower()
        if direction not in SCENARIO_DIRECTIONS:
            direction = SCENARIO_DIRECTIONS[0]
        out.append({"ticker": ticker, "direction": direction})
        if len(out) >= SCENARIO_MAX_PLAYS:
            break
    return out


def _scenario_branch(raw: Any, depth: int = 1) -> Optional[Dict[str, Any]]:
    """Une branche validée, ou ``None`` si elle n'a pas de libellé.

    Une branche bancale est jetée SEULE, jamais tout l'arbre (même patron que
    ``radar.parse_llm``). La profondeur est CLAMPÉE ici : au-delà de
    ``SCENARIO_MAX_DEPTH``, les enfants sont ignorés — on ne rend pas un arbre
    plus profond que ce que l'écran et le jugement supportent.
    """
    if not isinstance(raw, dict):
        return None
    label = str(raw.get("label") or "").strip()
    if not label:
        return None
    children = []
    if depth < SCENARIO_MAX_DEPTH and isinstance(raw.get("children"), list):
        for child in raw["children"][:SCENARIO_MAX_BRANCHES]:
            norm = _scenario_branch(child, depth + 1)
            if norm is not None:
                children.append(norm)
    return {
        "label": label,
        "prob": _scenario_prob(raw.get("prob")),
        "consequence": str(raw.get("consequence") or "").strip(),
        "plays": _scenario_plays(raw.get("plays")),
        "children": children,
    }


def parse_scenarios(raw: Any) -> Optional[Dict[str, Any]]:
    """Extrait l'arbre du bloc JSON final de la réponse (PUR).

    Rend ``None`` — et jamais une exception — quand la réponse ne contient pas
    d'arbre EXPLOITABLE : pas de bloc JSON, JSON illisible, titre absent, ou
    moins de ``SCENARIO_MIN_BRANCHES`` branches valides. Un arbre à une seule
    branche n'est pas un arbre : c'est une prédiction déguisée, exactement ce
    que cette vue refuse de produire. Le router en fait un 502 propre plutôt
    que d'afficher un demi-arbre.

    ``id`` et ``status`` ne sont JAMAIS lus du modèle (le serveur les pose,
    cf. ``board.normalize_tree``) : laisser le modèle déclarer qu'une branche
    s'est déjà réalisée, ce serait lui laisser écrire le verdict de son propre
    pari.
    """
    if not isinstance(raw, str):
        return None
    start = raw.find("{")
    end = raw.rfind("}")
    if start < 0 or end <= start:
        return None
    try:
        payload = json.loads(raw[start:end + 1])
    except ValueError:
        return None
    if not isinstance(payload, dict):
        return None

    title = str(payload.get("title") or "").strip()
    items = payload.get("branches")
    if not title or not isinstance(items, list):
        return None

    branches = []
    for candidate in items[:SCENARIO_MAX_BRANCHES]:
        norm = _scenario_branch(candidate, 1)
        if norm is not None:
            branches.append(norm)
    if len(branches) < SCENARIO_MIN_BRANCHES:
        return None

    return {
        "title": title,
        "context": str(payload.get("context") or "").strip(),
        "branches": branches,
    }


# --------------------------------------------------------------------------- #
# API publique
# --------------------------------------------------------------------------- #
def ask_coach(context: Optional[Dict[str, Any]], question: str = "",
              lang: str = "fr",
              model: str = DEFAULT_MODEL, timeout: int = DEFAULT_TIMEOUT,
              run: Callable = subprocess.run) -> str:
    """Réponse du coach à une question (ou point général si la question est vide)."""
    return _claude_text(build_coach_prompt(context, question, lang),
                        model=model, timeout=timeout, run=run)


def write_postmortem(trade: Optional[Dict[str, Any]],
                     context: Optional[Dict[str, Any]] = None,
                     lang: str = "fr",
                     model: str = DEFAULT_MODEL, timeout: int = DEFAULT_TIMEOUT,
                     run: Callable = subprocess.run) -> str:
    """Post-mortem rédigé d'un trade clôturé (destiné au carnet ``Journal.md``)."""
    return _claude_text(build_postmortem_prompt(trade, context, lang),
                        model=model, timeout=timeout, run=run)


def write_weekly_report(context: Optional[Dict[str, Any]] = None,
                        lang: str = "fr",
                        model: str = DEFAULT_MODEL, timeout: int = DEFAULT_TIMEOUT,
                        run: Callable = subprocess.run) -> str:
    """Bilan hebdomadaire rédigé (LOT 3, C2) — destiné à Telegram ET au
    carnet ``Journal.md``."""
    return _claude_text(build_weekly_prompt(context, lang),
                        model=model, timeout=timeout, run=run)


def write_analysis(facts: Optional[Dict[str, Any]], lang: str = "fr",
                   model: str = DEFAULT_MODEL, timeout: int = DEFAULT_TIMEOUT,
                   run: Callable = subprocess.run) -> str:
    """Fiche d'analyse pédagogique d'un titre — sans opinion d'achat ni de vente."""
    return _claude_text(build_analysis_prompt(facts, lang),
                        model=model, timeout=timeout, run=run)


def suggest_scenarios(context: Optional[Dict[str, Any]], lang: str = "fr",
                      model: str = DEFAULT_MODEL, timeout: int = DEFAULT_TIMEOUT,
                      run: Callable = subprocess.run) -> str:
    """Arbre de scénarios du marché (texte d'introduction + bloc JSON final,
    lu par ``parse_scenarios`` puis rangé par ``board.add_scenario``)."""
    return _claude_text(build_scenarios_prompt(context, lang),
                        model=model, timeout=timeout, run=run)


def review_positions(context: Optional[Dict[str, Any]], lang: str = "fr",
                     model: str = DEFAULT_MODEL, timeout: int = DEFAULT_TIMEOUT,
                     run: Callable = subprocess.run) -> str:
    """Revue des positions détenues (texte + bloc JSON final lu par
    ``parse_review``) — la « prévision de vente » du portefeuille."""
    return _claude_text(build_review_prompt(context, lang),
                        model=model, timeout=timeout, run=run)


def suggest_ideas(context: Optional[Dict[str, Any]], lang: str = "fr",
                  risk_level: str = DEFAULT_RISK_LEVEL,
                  journal: Any = None,
                  model: str = DEFAULT_MODEL, timeout: int = DEFAULT_TIMEOUT,
                  run: Callable = subprocess.run) -> str:
    """Idées de trade orientées rentabilité (texte + bloc JSON final destiné au
    câblage radar — cf. ``paper_router._parse_ideas_json``).

    ``risk_level`` ∈ ``RISK_LEVELS`` (normalisé, inconnu -> « mesuré ») : c'est
    l'étage de risque demandé, et la SEULE chose que Massii pilote ici.
    ``journal`` = le résumé des séries précédentes (mémoire anti-redite).
    """
    return _claude_text(build_ideas_prompt(context, lang, risk_level, journal),
                        model=model, timeout=timeout, run=run)
