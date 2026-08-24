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
# Prompts — PURS (aucun I/O) : testables tels quels
# --------------------------------------------------------------------------- #
def build_coach_prompt(context: Optional[Dict[str, Any]], question: str) -> str:
    """Prompt de la conversation avec le coach."""
    asked = str(question or "").strip() or "Fais le point sur ma méthode."
    return "\n\n".join([
        SYSTEM_PROMPT,
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
                            context: Optional[Dict[str, Any]]) -> str:
    """Prompt du post-mortem d'un trade clôturé."""
    return "\n\n".join([
        SYSTEM_PROMPT,
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


def build_analysis_prompt(facts: Optional[Dict[str, Any]]) -> str:
    """Prompt de la fiche pédagogique d'un titre."""
    return "\n\n".join([
        SYSTEM_PROMPT,
        "Fiche pédagogique sur un titre. Tous les chiffres ci-dessous sont "
        "calculés depuis les bougies Yahoo ; un champ ``null`` veut dire que la "
        "série ne permettait pas de le calculer — dis-le, ne le remplace pas.",
        _block("FAITS", facts or {}),
        "Écris trois choses : (1) la lecture de ces chiffres en français simple "
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
              model: str = DEFAULT_MODEL, timeout: int = DEFAULT_TIMEOUT,
              run: Callable = subprocess.run) -> str:
    """Réponse du coach à une question (ou point général si la question est vide)."""
    return _claude_text(build_coach_prompt(context, question),
                        model=model, timeout=timeout, run=run)


def write_postmortem(trade: Optional[Dict[str, Any]],
                     context: Optional[Dict[str, Any]] = None,
                     model: str = DEFAULT_MODEL, timeout: int = DEFAULT_TIMEOUT,
                     run: Callable = subprocess.run) -> str:
    """Post-mortem rédigé d'un trade clôturé (destiné au carnet ``Journal.md``)."""
    return _claude_text(build_postmortem_prompt(trade, context),
                        model=model, timeout=timeout, run=run)


def write_analysis(facts: Optional[Dict[str, Any]],
                   model: str = DEFAULT_MODEL, timeout: int = DEFAULT_TIMEOUT,
                   run: Callable = subprocess.run) -> str:
    """Fiche d'analyse pédagogique d'un titre — sans opinion d'achat ni de vente."""
    return _claude_text(build_analysis_prompt(facts),
                        model=model, timeout=timeout, run=run)
