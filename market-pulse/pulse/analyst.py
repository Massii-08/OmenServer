"""L'étape LLM — la SEULE du bot, une fois par place et par jour.

Tout le reste du moteur est déterministe. Ici, on demande une synthèse en
italien simple des faits déjà rassemblés. Le LLM **reformule et relie**, il
n'apporte aucune donnée.

Trois garde-fous, parce qu'un texte fluide est plus dangereux qu'un tableau :

1. **Dégradation gracieuse** — sans LLM disponible, le briefing sort tel quel.
   La synthèse embellit, elle ne conditionne rien. `analyse()` ne lève jamais.
2. **Vocabulaire** — une synthèse contenant un mot prescriptif est JETÉE, pas
   publiée. Le prompt l'interdit déjà ; ce contrôle est la ceinture.
3. **Chiffres** — tout nombre de la synthèse doit se retrouver dans le briefing.
   C'est le garde-fou contre l'invention : un chiffre plausible mais faux est le
   pire défaut possible pour un lecteur âgé, qui n'a aucun moyen de le vérifier.
   ⚠️ **Limite assumée** : ce contrôle vérifie qu'un chiffre EXISTE dans les
   données, pas qu'il est attaché au bon marché. Une synthèse qui donnerait la
   variation de Tokyo à Hong Kong passerait. Au premier appel réel l'attribution
   était juste sur les quatre places citées, mais la garantie ne va pas plus
   loin que ça — et un contrôle sémantique demanderait un second appel.

Modèle : Sonnet. Une reformulation factuelle n'a pas besoin d'Opus, et le quota
est celui de l'abonnement de Massii.
"""
import json
import os
import re
import subprocess
from typing import Any, Callable, Dict, Optional, Tuple

DEFAULT_MODEL = "claude-sonnet-5"
CLAUDE_BIN = os.environ.get("CLAUDE_BIN") or os.path.expanduser("~/.local/bin/claude")

# Vocabulaire prescriptif ou prédictif. Volontairement dupliqué du test du
# rapport : là-bas c'est un PIN indépendant, ici un contrôle d'exécution. Si
# l'un des deux dérive, l'autre le rattrape.
FORBIDDEN_WORDS = (
    "comprare", "vendere", "acquistare", "consiglio", "consigliamo",
    "conviene", "raccomand", "occasione", "opportunità di acquisto",
    "target price", "prezzo obiettivo", "previsione", "prevediamo", "prevedo",
    "dovrebbe salire", "dovrebbe scendere", "suggeriamo", "portafoglio",
)

# On ne contrôle que les nombres qui ressemblent à une DONNÉE de marché : au
# moins une décimale, ou quatre chiffres et plus. « il 30 luglio », « 2026 »,
# « tra 2 giorni » ne sont pas des chiffres de marché et exiger leur présence
# dans les données rejetterait toute phrase normale.
_NUM = re.compile(r"\d[\d.,]*")
_MIN_INT_DIGITS = 4


def _canon(num: str) -> str:
    """Réduit un nombre à ses chiffres, quelle que soit la notation.

    Le LLM écrit à l'italienne (1.904,55) ce que les données portent à
    l'anglo-saxonne (1904.55) : sans cette normalisation, tout chiffre correct
    serait déclaré inventé.
    """
    return re.sub(r"\D", "", num).lstrip("0") or "0"


def _is_market_number(raw: str) -> bool:
    digits = re.sub(r"\D", "", raw)
    if not digits:
        return False
    has_decimal = ("," in raw or "." in raw) and not raw.rstrip(".,").isdigit()
    if re.search(r"[.,]\d", raw):
        has_decimal = True
    return has_decimal or len(digits) >= _MIN_INT_DIGITS


def _numbers_of(payload: Any) -> set:
    """Tous les nombres présents dans le briefing, sous forme canonique."""
    blob = json.dumps(payload, ensure_ascii=False, default=str)
    out = set()
    for raw in _NUM.findall(blob):
        out.add(_canon(raw))
        # 0.35 dans les données peut s'écrire « 0,35 » ou « 35 » (pourcentage
        # déjà exprimé) : on accepte aussi la forme sans zéro de tête.
        out.add(_canon(raw).lstrip("0") or "0")
    return out


def check_synthesis(text: Any, briefing: Any) -> Tuple[bool, Optional[str]]:
    """La synthèse est-elle publiable ? Rend (ok, raison_du_refus)."""
    if not isinstance(text, str) or not text.strip():
        return False, "sintesi vuota"

    low = text.lower()
    for word in FORBIDDEN_WORDS:
        if word in low:
            return False, "vocabolario prescrittivo: %r" % word

    known = _numbers_of(briefing)
    for raw in _NUM.findall(text):
        if not _is_market_number(raw):
            continue
        if _canon(raw) not in known:
            return False, "cifra assente dai dati: %r" % raw
    return True, None


def compact(briefing: Dict[str, Any], max_news: int = 8) -> Dict[str, Any]:
    """Réduit le briefing à ce dont le LLM a besoin.

    ⚠️ Envoyer le briefing ENTIER faisait TRONQUER la réponse : le JSON revenait
    sans son accolade fermante et la synthèse était perdue (vu au premier
    passage complet). Les URL, les compteurs de collecte et les champs internes
    ne servent pas à rédiger trois phrases.
    """
    news = briefing.get("news") or {}
    items = news.get("items") or []
    facts_only = [i for i in items if (i.get("event") or {}).get("is_event")] or items
    return {
        "borsa": briefing.get("label"),
        "apertura": (briefing.get("session") or {}).get("opens_at"),
        "indice": {k: (briefing.get("index") or {}).get(k)
                   for k in ("label", "price", "change_pct", "currency")}
                  if briefing.get("index") else None,
        "altre_piazze": [{"nome": c.get("label"), "var": c.get("change_pct"),
                          "stato": c.get("state")}
                         for c in (briefing.get("comparison") or [])],
        "agenda": [{"quando": str(a.get("when"))[:16], "cosa": a.get("what")}
                   for a in (briefing.get("agenda") or [])],
        "titoli_notizie": [i.get("title") for i in facts_only[:max_news]],
    }


def build_prompt(briefing: Dict[str, Any]) -> str:
    """Le prompt : les faits, et l'interdiction, explicitement."""
    facts = json.dumps(compact(briefing), ensure_ascii=False, indent=1, default=str)
    return (
        "Sei un redattore che scrive per un investitore privato anziano, in "
        "ITALIANO semplice, senza gergo inglese.\n\n"
        "Ti do i FATTI di stamattina su una borsa. Scrivi da tre a cinque frasi "
        "che li collegano: come hanno chiuso le piazze già passate, come apre "
        "questa, e quali appuntamenti sono in agenda.\n\n"
        "REGOLE ASSOLUTE:\n"
        "- Usa SOLO I FATTI che ti do. NON AGGIUNGERE nessun dato, nessuna "
        "cifra, nessun nome che non sia qui sotto.\n"
        "- NESSUN CONSIGLIO di acquisto o di vendita, nessun prezzo obiettivo, "
        "nessuna previsione su dove andrà un corso. Descrivi ciò che è "
        "accaduto, mai ciò che accadrà.\n"
        "- Nessuna opinione personale, nessun superlativo.\n\n"
        "Rispondi in JSON: {\"synthesis\": \"il tuo testo\"}\n\n"
        "FATTI:\n" + facts
    )


def _claude(prompt: str, model: str = DEFAULT_MODEL, timeout: int = 180,
            run: Callable = subprocess.run) -> Dict[str, Any]:
    """Appel du CLI Claude sur l'abonnement — aucune clé API.

    Même patron que l'Upwork Sniper et le Harvester. `run` est injectable pour
    que les tests n'aient jamais besoin du binaire.

    ⚠️ **Exécuté depuis un dossier VIDE et NEUTRE.** Lancé depuis le dépôt, le
    CLI hérite du `CLAUDE.md` du projet, des hooks et du contexte de session :
    au premier essai réel, il a répondu à propos d'un autre bot du serveur
    (Oracle, Mission Control) au lieu de la synthèse demandée. Un appel de bot
    doit être hermétique — le prompt suffit, le contexte du dépôt le pollue.
    """
    import tempfile
    cmd = [CLAUDE_BIN, "-p", "--output-format", "json"]
    if model:
        cmd += ["--model", model]
    with tempfile.TemporaryDirectory(prefix="market-pulse-llm-") as neutral:
        proc = run(cmd, input=prompt, capture_output=True, text=True,
                   timeout=timeout, cwd=neutral)
    if proc.returncode != 0:
        raise RuntimeError("claude cli rc=%s: %s" % (proc.returncode,
                                                    (proc.stderr or "")[:200]))
    envelope = json.loads(proc.stdout)
    if envelope.get("is_error"):
        raise RuntimeError("claude error: %s" % str(envelope.get("result", ""))[:200])
    raw = envelope.get("result", "")
    start, end = raw.find("{"), raw.rfind("}")
    if start == -1 or end == -1:
        raise ValueError("nessun JSON nella risposta: %s" % raw[:200])
    return json.loads(raw[start:end + 1])


def analyse(briefing: Optional[Dict[str, Any]],
            claude: Optional[Callable[..., Any]] = None,
            model: str = DEFAULT_MODEL) -> Dict[str, Any]:
    """Synthèse italienne du briefing. Ne lève JAMAIS.

    Rend `{"text": str|None, "model": str, "degraded": bool, "reason": str|None}`.
    """
    result = {"text": None, "model": model, "degraded": True, "reason": None}
    if not briefing:
        result["reason"] = "nessun briefing da sintetizzare"
        return result

    caller = claude or _claude
    try:
        answer = caller(build_prompt(briefing), model=model)
    except Exception as e:
        # Le LLM est un LUXE : son absence ne doit jamais coûter le briefing.
        result["reason"] = "%s: %s" % (type(e).__name__, e)
        return result

    text = answer.get("synthesis") if isinstance(answer, dict) else None
    ok, reason = check_synthesis(text, briefing)
    if not ok:
        result["reason"] = reason
        return result

    result["text"] = text.strip()
    result["degraded"] = False
    return result
