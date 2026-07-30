"""Traduction des titres étrangers — « on ne sait pas lire du chinois ».

Couvrir Tokyo avec de la presse japonaise et Shanghai avec de la presse chinoise
est un choix de conception : c'est là que se dit ce qui bouge cette place. Le
prix à payer est un briefing rempli de titres que le lecteur ne peut pas lire.

La traduction se greffe sur **l'appel LLM qui existe déjà** (celui de la
synthèse) : le même appel rend la synthèse ET les titres traduits, donc la
fonctionnalité ne coûte aucune requête de plus.

Trois principes :

1. **Le titre d'origine n'est jamais écrasé.** Une traduction est une
   transformation ; elle s'ajoute (`title_display`) et laisse le fait intact,
   pour que le lecteur puisse vérifier.
2. **Sans traduction, on affiche l'original et on le DIT** (`needs_translation`
   reste vrai). Masquer une news qu'on n'a pas su traduire ferait sortir une
   section vide qui a l'air normale — le défaut le plus cher de ce projet.
3. **Le filtre anti-conseil tourne AUSSI sur la traduction.** `is_advice` ne
   connaît que l'italien et l'anglais : un titre chinois qui dit « les 5 actions
   à acheter » traverse la collecte sans encombre et ne se révèle qu'une fois
   traduit. C'est le dernier endroit où on peut l'arrêter.
"""
from typing import Any, Dict, List, Optional, Tuple

# Langues de lecture proposées. Le défaut est l'italien : c'est la langue du
# rapport, de la synthèse, du carnet — et du lecteur final.
SUPPORTED = ("it", "fr", "en")
DEFAULT_LANG = "it"

_NAMES = {"it": ("italiano", "in ITALIANO"),
          "fr": ("francese", "in FRANCESE"),
          "en": ("inglese", "in INGLESE")}

MAX_TITLES = 14        # ce que l'écran affiche ; traduire plus serait perdu


def base_lang(value: Any) -> str:
    """« zh-Hant » → « zh ». Comparer les chaînes entières ferait traduire de
    l'allemand vers de l'allemand (`de-CH` != `de`)."""
    if not isinstance(value, str):
        return ""
    return value.strip().lower().replace("_", "-").split("-")[0]


def to_translate(items: Optional[List[Dict[str, Any]]], target: str,
                 max_items: int = MAX_TITLES) -> List[Tuple[int, str]]:
    """Les titres qui ne sont pas déjà dans la langue de lecture.

    Un item **sans langue déclarée** est laissé tranquille : traduire au hasard
    serait pire que ne rien faire.
    """
    target = base_lang(target) or DEFAULT_LANG
    out = []
    for index, item in enumerate(items or []):
        if not isinstance(item, dict):
            continue
        lang = base_lang(item.get("lang"))
        title = (item.get("title") or "").strip()
        if not lang or not title or lang == target:
            continue
        out.append((index, title))
        if len(out) >= max_items:
            break
    return out


def build_prompt(pairs: List[Tuple[int, str]], target: str) -> str:
    """Le bloc de traduction, à coller dans le prompt de la synthèse."""
    name, emphasis = _NAMES.get(base_lang(target), _NAMES[DEFAULT_LANG])
    lines = "\n".join("%d. %s" % (index, title) for index, title in pairs)
    return (
        "Traduci %s i titoli qui sotto. Sono TITOLI DI GIORNALE: la traduzione "
        "deve restare un titolo.\n"
        "- NON aggiungere nulla, nessun commento, nessuna spiegazione, nessuna "
        "opinione.\n"
        "- Non riassumere e non allungare: traduci.\n"
        "- Lascia i nomi propri e i simboli di borsa come sono.\n"
        "Lingua di arrivo: %s.\n\n"
        "TITOLI:\n%s" % (emphasis, name, lines))


def parse_response(answer: Any) -> Dict[int, str]:
    """`{"traduzioni": {"1": "..."}}` → `{1: "..."}`. Tolérant, jamais d'erreur.

    Les clés reviennent tantôt en texte, tantôt en nombre selon l'humeur du
    modèle ; une clé non numérique est ignorée plutôt que de faire tomber tout
    le lot.
    """
    if not isinstance(answer, dict):
        return {}
    raw = answer.get("traduzioni") or answer.get("translations") or {}
    if not isinstance(raw, dict):
        return {}
    out = {}
    for key, value in raw.items():
        try:
            index = int(key)
        except (TypeError, ValueError):
            continue
        text = value.strip() if isinstance(value, str) else ""
        if text:
            out[index] = text
    return out


def apply(items: Optional[List[Dict[str, Any]]], translations: Dict[int, str],
          target: str) -> Tuple[List[Dict[str, Any]], Dict[str, int]]:
    """Pose `title_display` sur chaque item et rend `(items, statistiques)`.

    Ne modifie jamais la liste reçue : on rend des copies, parce que le même lot
    de news peut servir à plusieurs places.
    """
    from .sentiment import is_advice

    target = base_lang(target) or DEFAULT_LANG
    translations = translations or {}
    kept = []
    stats = {"translated": 0, "untranslated": 0, "dropped_advice": 0}

    for index, item in enumerate(items or []):
        if not isinstance(item, dict):
            continue
        row = dict(item)
        lang = base_lang(row.get("lang"))
        original = row.get("title") or ""
        foreign = bool(lang) and lang != target
        text = translations.get(index)

        if foreign and text:
            # Dernière barrière : le titre ne révèle qu'ici ce qu'il dit.
            if is_advice(text):
                stats["dropped_advice"] += 1
                continue
            row["title_display"] = text
            row["translated"] = True
            row["needs_translation"] = True
            stats["translated"] += 1
        else:
            row["title_display"] = original
            row["translated"] = False
            row["needs_translation"] = foreign
            if foreign:
                stats["untranslated"] += 1
        kept.append(row)

    return kept, stats
