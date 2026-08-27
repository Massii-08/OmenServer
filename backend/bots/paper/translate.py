"""Traduction des titres de presse ÉTRANGERS non lisibles par Massii vers le
français.

CONTEXTE : le simulateur collecte de la presse financière sur SEPT pays
(``newswatch._run_pressefi_volet``, cascade Market Pulse). Trois de ces
sources sont en allemand (NZZ, cash.ch, Handelsblatt) -- illisibles pour un
lecteur francophone. Ce module traduit ces titres SANS JAMAIS écraser
l'original : une traduction est une transformation, pas un remplacement --
c'est le lecteur qui doit pouvoir vérifier (piège Market Pulse #68k, doctrine
reprise ici telle quelle).

Doctrine du module (« économie LLM par construction ») : la collecte et le
rendu du simulateur sont 0-LLM par construction ; ``run_sweep`` est le SEUL
chemin de ce fichier qui appelle le modèle, et il est borné de trois façons
indépendantes -- gate HORAIRE (``last_sweep_ts``, écrit dans le cache
lui-même), cap de candidats par sweep (``SWEEP_CAP``) et UN SEUL appel LLM
par sweep quel que soit le nombre de candidats (un prompt, une liste
numérotée, une réponse numérotée).

Séparation stricte PUR / I-O (même règle que le reste du lot) :
  - PUR : ``detect_lang`` / ``lookup`` / ``_title_key`` / ``_normalize_title``
          / ``_build_prompt`` / ``_parse_translations`` / ``_evict_oldest``.
  - I/O : ``cache_path`` / ``load_cache`` / ``save_cache`` / ``run_sweep``
          (LLM et horloge injectables -- tests 100 % hors ligne).

État persistant : ``data/paper_trading/translations.cache.json``.

⚠️ Le POINT dans le radical n'est PAS cosmétique -- c'est la convention
anti-fantôme du dépôt (cf. ``calendar.STATE_NAME``). Les fichiers de
``data/paper_trading/`` sont recensés comme des COMPTES par
``radar._users_with_portfolio`` (regex ``^[A-Za-z0-9_-]+\\.json$``) : un
``translations_cache.json`` (ou tout radical SANS point) deviendrait un
utilisateur fantôme. ``translations.cache.json`` a un point dans son
radical (``translations.cache``) : structurellement hors de portée de cette
regex, ça ne s'oublie pas.

Écriture ATOMIQUE 0o600 (patron obligatoire du dépôt, cf. ``calendar.py`` /
``store.py`` / ``newswatch._save_seen_state``) : le temporaire NAÎT en 0o600
via ``os.open`` -- jamais ``open()`` suivi d'un ``chmod()``, qui laisse une
fenêtre world-readable et reste en 0o644 si le chmod échoue -- puis
``os.replace`` bascule d'un coup.

⚠️ Le gating horaire vit DANS ce fichier (``last_sweep_ts``), PAS dans un
compteur de cycle ajouté à ``newswatch._load_seen_state`` : ce serait
retomber dans son piège allowlist documenté en tête de fichier -- une clé de
cadence oubliée à la relecture y est SILENCIEUSEMENT perdue, et le volet
tournerait alors à chaque cycle sans que rien ne le signale. Volontaire.
"""
import hashlib
import json
import logging
import os
import re
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Tuple

logger = logging.getLogger("omenserver")

CACHE_NAME = "translations.cache.json"

# Cap du cache -- éviction des entrées les plus ANCIENNES (par ``ts``) au-delà.
# Une presse à sept pays ne produit jamais assez de titres allemands pour
# atteindre ça vite (cf. le rapport de mission pour l'estimation de charge) ;
# le plafond protège seulement contre une croissance illimitée sur des mois.
CACHE_CAP = 4000

# Gate horaire du sweep -- protège le PIRE cas (plein de candidats à chaque
# cycle de veille, 5 min) ; le cas normal (rien de neuf) ne coûte de toute
# façon jamais rien, gate ou pas (zéro candidat -> zéro appel LLM).
SWEEP_MIN_INTERVAL_S = 3600

# UN sweep traduit au plus 40 titres -- au-delà, les candidats en trop ne
# rejoignent PAS le cache : ils retentent au sweep suivant plutôt que d'être
# perdus (cf. run_sweep).
SWEEP_CAP = 40


# --------------------------------------------------------------------------- #
# PUR -- détection de langue par mots-vides (ensembles fermés, mot ENTIER,
# insensible à la casse)
# --------------------------------------------------------------------------- #

_WORD_RE = re.compile(r"[^\W\d_]+", re.UNICODE)

# Mots-vides ULTRA-fréquents (articles/prépositions/conjonctions/auxiliaires) :
# ce qui domine la fréquence d'un titre de presse, quelle que soit la langue,
# et qui reste presque toujours EXCLUSIF à une langue -- les rares mots
# partagés (« an », « le »/« la »/« i » entre FR/IT) sont noyés par les autres
# dès qu'un titre a plus de 3-4 mots, ce qui est le cas de toute dépêche.
_STOPWORDS: Dict[str, set] = {
    "de": {
        "der", "die", "das", "den", "dem", "des", "ein", "eine", "einen",
        "einem", "einer", "und", "oder", "aber", "auch", "nicht", "kein",
        "keine", "für", "mit", "von", "zu", "bei", "nach", "aus", "auf",
        "im", "an", "am", "um", "ab", "vor", "über", "unter", "durch",
        "gegen", "ohne", "gleich", "zwei", "ist", "sind", "war", "wird",
        "werden", "hat", "haben", "sich", "wie", "als", "dass", "wenn",
    },
    "en": {
        "the", "of", "and", "to", "in", "a", "is", "for", "on", "with",
        "as", "by", "at", "from", "an", "are", "its", "this", "that", "be",
        "will", "has", "have", "was", "were", "after", "over", "into",
        "than", "amid", "but", "not", "new", "says", "said",
    },
    "fr": {
        "le", "la", "les", "de", "des", "du", "et", "en", "un", "une",
        "au", "aux", "pour", "sur", "dans", "par", "avec", "ne", "pas",
        "que", "qui", "se", "ce", "ces", "son", "sa", "ses", "plus", "vers",
        "sans", "chez", "entre", "est", "sont", "comme",
    },
    "it": {
        "il", "lo", "la", "i", "gli", "le", "di", "e", "un", "una", "per",
        "in", "con", "su", "da", "che", "non", "si", "del", "della", "dei",
        "delle", "dello", "al", "allo", "alla", "tra", "fra", "come",
        "più", "anche", "dopo", "è", "sono",
    },
}


def detect_lang(text: Any) -> Optional[str]:
    """Langue d'un titre parmi ``fr``/``en``/``it``/``de`` -- PUR, aucune
    dépendance externe.

    Verdict = la langue dont les mots-vides sont STRICTEMENT majoritaires
    dans le titre, avec AU MOINS deux occurrences. Un titre trop court pour
    porter deux mots-vides d'une même langue, ou une égalité entre deux
    langues, rend ``None`` -- mieux vaut ne rien affirmer qu'un tirage au
    sort (ex. « Nvidia Q3 », ou une répétition du mot-vide « an », partagé
    par l'allemand et l'anglais)."""
    tokens = [t.lower() for t in _WORD_RE.findall(str(text or ""))]
    if len(tokens) < 2:
        return None
    counts = {lang: 0 for lang in _STOPWORDS}
    for token in tokens:
        for lang, words in _STOPWORDS.items():
            if token in words:
                counts[lang] += 1
    best_count = max(counts.values())
    if best_count < 2:
        return None
    winners = [lang for lang, count in counts.items() if count == best_count]
    if len(winners) != 1:
        return None
    return winners[0]


# --------------------------------------------------------------------------- #
# PUR -- clé de cache
# --------------------------------------------------------------------------- #

def _normalize_title(title: Any) -> str:
    """Texte compacté (espaces normalisés) et minuscule -- deux flux qui
    livrent la même dépêche avec une casse ou un espacement différent
    doivent tomber sur la MÊME clé de cache."""
    return " ".join(str(title or "").split()).lower()


def _title_key(title: Any) -> str:
    """Clé de cache d'un titre -- sha1 du titre NORMALISÉ."""
    return hashlib.sha1(_normalize_title(title).encode("utf-8")).hexdigest()


def lookup(title: Any, cache: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """Traduction en cache pour ce titre -- PUR (aucune E/S), opère sur un
    dict DÉJÀ CHARGÉ par l'appelant (cf. ``load_cache``). Le service qui sert
    ``/graph``/``/graph/grove``/``/digest`` charge le cache UNE SEULE FOIS
    par requête, jamais par item -- c'est cette fonction, pure, qui rend ça
    possible.

    Titre vide, cache mal formé ou absence -> ``None``, jamais une
    exception : un confort d'affichage ne doit jamais faire tomber la page
    qui le sert."""
    text = _normalize_title(title)
    if not text or not isinstance(cache, dict):
        return None
    entries = cache.get("entries")
    if not isinstance(entries, dict):
        return None
    row = entries.get(_title_key(title))
    return dict(row) if isinstance(row, dict) else None


# --------------------------------------------------------------------------- #
# PUR -- petits utilitaires d'horloge (dupliqués volontairement, cf. la même
# doctrine que calendar.py/graph.py/convergence.py : un module de ce dépôt
# reste lisible seul, sans dépendre d'un helper partagé qui pourrait manquer)
# --------------------------------------------------------------------------- #

def _naive(value: datetime) -> datetime:
    if value.tzinfo is None:
        return value
    return value.astimezone(timezone.utc).replace(tzinfo=None)


def _parse_dt(value: Any) -> Optional[datetime]:
    if value is None or isinstance(value, bool):
        return None
    if isinstance(value, datetime):
        return _naive(value)
    if isinstance(value, date):
        return datetime(value.year, value.month, value.day)
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
        return None


def _now_dt(now: Any = None) -> datetime:
    parsed = _parse_dt(now)
    if parsed is not None:
        return parsed
    return _naive(datetime.now(timezone.utc))


def _text(value: Any) -> str:
    return " ".join(str(value or "").split())


# --------------------------------------------------------------------------- #
# I/O -- cache disque, écriture ATOMIQUE 0o600 (patron obligatoire du dépôt)
# --------------------------------------------------------------------------- #

def _store():
    """Le module de persistance du paper trading (import paresseux)."""
    from backend.bots.paper import store
    return store


def cache_path() -> Path:
    """Chemin du cache de traduction, relu à CHAQUE appel depuis
    ``store.DATA_DIR`` -- un test qui isole ce répertoire isole aussi ce
    module, sans avoir à connaître son existence."""
    return Path(_store().DATA_DIR) / CACHE_NAME


def _default_cache() -> Dict[str, Any]:
    return {"last_sweep_ts": None, "entries": {}}


def load_cache() -> Dict[str, Any]:
    """Le cache de traduction, ``{"last_sweep_ts": iso|None, "entries": {...}}``.
    Fichier absent, illisible ou déformé -> cache VIERGE, jamais une
    exception. Une entrée dont la forme est cassée (pas un dict, pas de
    traduction ``fr`` en texte) est SILENCIEUSEMENT écartée -- mieux vaut
    re-traduire un titre que servir une entrée à moitié lisible."""
    path = cache_path()
    if not path.is_file():
        return _default_cache()
    try:
        with open(str(path), "r", encoding="utf-8") as handle:
            raw = json.load(handle)
    except (OSError, ValueError):
        return _default_cache()
    if not isinstance(raw, dict):
        return _default_cache()

    entries_raw = raw.get("entries")
    entries: Dict[str, Any] = {}
    if isinstance(entries_raw, dict):
        for key, value in entries_raw.items():
            if isinstance(value, dict) and isinstance(value.get("fr"), str):
                entries[str(key)] = {
                    "fr": value.get("fr"),
                    "src": str(value.get("src") or ""),
                    "ts": str(value.get("ts") or ""),
                }

    last_sweep_ts = raw.get("last_sweep_ts")
    return {
        "last_sweep_ts": last_sweep_ts if isinstance(last_sweep_ts, str) else None,
        "entries": entries,
    }


def save_cache(cache: Dict[str, Any]) -> None:
    """Persiste le cache de façon atomique, 0o600 -- même patron que
    ``calendar.save_verdicts``."""
    path = cache_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = path.parent / (".%s.tmp-%d" % (path.name, os.getpid()))
    fd = os.open(str(tmp_path), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    try:
        os.fchmod(fd, 0o600)
    except (AttributeError, OSError):
        pass
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(cache or _default_cache(), handle, ensure_ascii=False,
                      indent=2)
        os.replace(str(tmp_path), str(path))
    except Exception:
        try:
            os.remove(str(tmp_path))
        except OSError:
            pass
        raise


def _evict_oldest(entries: Dict[str, Any], cap: int) -> None:
    """Éviction EN PLACE des entrées les plus ANCIENNES au-delà de ``cap`` --
    tri par ``ts`` (ISO 8601, donc l'ordre lexical EST l'ordre chronologique).
    Une entrée sans ``ts`` lisible est traitée comme la plus ancienne
    possible -- elle saute en premier plutôt qu'une entrée datée."""
    if cap < 0 or len(entries) <= cap:
        return
    ordered = sorted(
        entries.items(),
        key=lambda kv: _text(kv[1].get("ts")) if isinstance(kv[1], dict) else "")
    excess = len(entries) - cap
    for key, _ in ordered[:excess]:
        del entries[key]


# --------------------------------------------------------------------------- #
# I/O -- appel LLM (CLI Claude via paper/llm.py), prompt + parse TOLÉRANT
# --------------------------------------------------------------------------- #

def _default_llm(prompt: str) -> str:
    """Le CLI Claude via ``paper/llm.py`` (texte brut) -- même patron que
    ``convergence._default_llm``."""
    from backend.bots.paper import llm as llm_mod
    return llm_mod._claude_text(prompt)


def _build_prompt(candidates: List[Tuple[str, str]]) -> str:
    """Prompt de traduction -- UNE liste numérotée, UNE réponse numérotée
    attendue en retour (PUR)."""
    numbered = "\n".join(
        "%d. %s" % (i + 1, title) for i, (_, title) in enumerate(candidates))
    return (
        "Traduis en français chacun des titres de presse financière "
        "suivants, un par ligne. Réponds avec EXACTEMENT le même nombre de "
        "lignes, numérotées à l'identique (\"1. ...\", \"2. ...\"), rien "
        "d'autre : pas d'introduction, pas de commentaire, pas de guillemets "
        "autour de la traduction.\n\n" + numbered
    )


_LINE_RE = re.compile(r"^\s*(\d+)\s*[.):]\s*(.+?)\s*$")


def _parse_translations(raw: Any, n: int) -> Dict[int, str]:
    """Parse la réponse numérotée du LLM -- TOLÉRANT : une ligne absente ou
    mal formée est simplement SAUTÉE (ce titre-là ne sera pas traduit ce
    coup-ci -- il n'entre jamais dans le cache, donc il retente au sweep
    suivant) ; ne lève JAMAIS, quelle que soit la forme de ``raw``."""
    if not isinstance(raw, str):
        return {}
    out: Dict[int, str] = {}
    for line in raw.splitlines():
        match = _LINE_RE.match(line)
        if not match:
            continue
        try:
            idx = int(match.group(1))
        except ValueError:
            continue
        if idx < 1 or idx > n:
            continue
        text = match.group(2).strip()
        if text:
            out[idx] = text
    return out


# --------------------------------------------------------------------------- #
# I/O -- le sweep : gate horaire -> candidats -> UN appel LLM -> cache
# --------------------------------------------------------------------------- #

def run_sweep(now: Any = None,
             llm: Optional[Callable[[str], str]] = None,
             events: Any = None) -> Dict[str, Any]:
    """Traduit vers le français les titres de presse ALLEMANDE accumulés
    dans ``events`` (aujourd'hui : NZZ/cash.ch/Handelsblatt, cf.
    ``newswatch._run_pressefi_volet``).

    Best-effort STRICT (ne lève JAMAIS) -- même patron que
    ``calendar.run_verdicts`` : un module de confort qui plante ne doit
    jamais emporter le cycle de veille qui l'appelle.

    Retourne toujours ``{"translated": int, ...}`` :
      - ``{"translated": 0, "skipped": "too_soon"}`` -- moins d'une heure
        depuis le dernier sweep ABOUTI ;
      - ``{"translated": 0, "skipped": "no_candidates"}`` -- rien à
        traduire (zéro appel LLM) ;
      - ``{"translated": 0, "skipped": "llm_failed"}`` -- le CLI a échoué ;
      - ``{"translated": N, "candidates": M}`` -- succès (``N`` peut être
        inférieur à ``M`` : une ligne manquante de la réponse ne compte pas).

    ``last_sweep_ts`` est réécrit à CHAQUE sweep qui s'exécute réellement
    (candidats ou pas, LLM en panne ou pas) -- c'est lui qui fait tenir le
    gate horaire : sans ça, un cycle sans candidat repartirait immédiatement
    « jamais balayé » et le gate ne protégerait plus rien le jour où les
    candidats recommencent à arriver."""
    try:
        now_dt = _now_dt(now)
        cache = load_cache()
        last_ts = _parse_dt(cache.get("last_sweep_ts"))
        if last_ts is not None and \
                (now_dt - last_ts).total_seconds() < SWEEP_MIN_INTERVAL_S:
            return {"translated": 0, "skipped": "too_soon"}

        entries = dict(cache.get("entries") or {})
        candidates: List[Tuple[str, str]] = []
        seen_keys = set()
        for event in (events or []):
            if not isinstance(event, dict):
                continue
            title = _text(event.get("title"))
            if not title:
                continue
            key = _title_key(title)
            if key in entries or key in seen_keys:
                continue
            if detect_lang(title) != "de":
                continue
            seen_keys.add(key)
            candidates.append((key, title))
            if len(candidates) >= SWEEP_CAP:
                break

        now_iso = now_dt.isoformat()
        if not candidates:
            cache["last_sweep_ts"] = now_iso
            save_cache(cache)
            return {"translated": 0, "skipped": "no_candidates"}

        llm_fn = llm if llm is not None else _default_llm
        try:
            raw = llm_fn(_build_prompt(candidates))
        except Exception as exc:      # noqa: BLE001 -- LLM muet, sweep reporté
            logger.warning("paper translate: appel LLM en panne (%s)",
                           type(exc).__name__)
            cache["last_sweep_ts"] = now_iso
            save_cache(cache)
            return {"translated": 0, "skipped": "llm_failed"}

        parsed = _parse_translations(raw, len(candidates))
        translated = 0
        for idx, (key, _title) in enumerate(candidates):
            fr_text = parsed.get(idx + 1)
            if not fr_text:
                continue
            entries[key] = {"fr": fr_text, "src": "de", "ts": now_iso}
            translated += 1

        _evict_oldest(entries, CACHE_CAP)
        cache["entries"] = entries
        cache["last_sweep_ts"] = now_iso
        save_cache(cache)
        return {"translated": translated, "candidates": len(candidates)}
    except Exception as exc:          # noqa: BLE001 -- ne lève jamais
        logger.warning("paper translate: sweep impossible (%s)",
                       type(exc).__name__)
        return {"translated": 0, "error": type(exc).__name__}
