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
