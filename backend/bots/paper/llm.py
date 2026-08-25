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
from typing import Any, Callable, Dict, Optional

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
RISK_LEVELS = ("mesure", "agressif", "speculatif")
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
}

# Genres d'actifs ouverts À CHAQUE ÉTAGE. C'est cette table qui écrit la liste
# ``asset_kind`` du bloc JSON final : un prompt « mesuré » ne prononce donc
# jamais le mot d'un univers qu'il interdit — l'interdit et le schéma ne
# peuvent pas se contredire.
_LEVEL_KINDS = {
    "mesure": ("equity", "etf"),
    "agressif": ("equity", "etf"),
    "speculatif": ("equity", "etf", "crypto", "forex"),
}

# Le CODE d'un niveau est sans accent (il voyage en JSON, en URL et dans un
# état persisté) ; son ÉTIQUETTE est le mot français, celui que Massii lira en
# tête de réponse. Les deux ne se mélangent pas.
_RISK_LABELS = {
    "mesure": "mesuré",
    "agressif": "agressif",
    "speculatif": "spéculatif",
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
                       risk_level: str = DEFAULT_RISK_LEVEL) -> str:
    """Prompt des idées de trade orientées RENTABILITÉ (extension utilisateur) —
    à la différence de ``build_coach_prompt`` (conversation libre), ici Massii
    ne demande pas de faire le point : il demande des idées concrètes.

    Doctrine explicite : le risque ne se gère JAMAIS en ne choisissant que des
    titres « sûrs » — il se gère par le sizing (petit) et le stop (toujours
    posé). On vise le POTENTIEL (catalyseur, momentum, asymétrie), pas la
    valeur refuge.

    ``risk_level`` choisit l'ÉTAGE (``mesure``/``agressif``/``speculatif``,
    cf. ``_RISK_BLOCKS``) : univers autorisé, fourchette de risque, horizon. Le
    schéma JSON final est écrit DEPUIS cet étage — un prompt « mesuré »
    n'énumère donc jamais un genre d'actif qu'il vient d'interdire.
    """
    level = normalize_risk_level(risk_level)
    kinds = _LEVEL_KINDS[level]
    kinds_text = ", ".join('"%s"' % kind for kind in kinds)
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
        "série ; ``asset_kind`` vaut l'un de : %s) : "
        '```json\n{"ideas": [{"ticker": "AAPL", "direction": "up", '
        '"horizon_days": 10, "thesis": "une phrase courte", '
        '"risk_level": "%s", "asset_kind": "%s"}]}\n```'
        % (level, kinds_text, level, kinds[0]),
    ])


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


def suggest_ideas(context: Optional[Dict[str, Any]], lang: str = "fr",
                  risk_level: str = DEFAULT_RISK_LEVEL,
                  model: str = DEFAULT_MODEL, timeout: int = DEFAULT_TIMEOUT,
                  run: Callable = subprocess.run) -> str:
    """Idées de trade orientées rentabilité (texte + bloc JSON final destiné au
    câblage radar — cf. ``paper_router._parse_ideas_json``).

    ``risk_level`` ∈ ``RISK_LEVELS`` (normalisé, inconnu -> « mesuré ») : c'est
    l'étage de risque demandé, et la SEULE chose que Massii pilote ici.
    """
    return _claude_text(build_ideas_prompt(context, lang, risk_level),
                        model=model, timeout=timeout, run=run)
