"""Baromètre d'opinion — quand un sujet se met SOUDAINEMENT à être discuté.

Reddit n'est pas un fil d'actualité dans ce bot, et le publier comme tel a
déjà mis « Fanculo Vanguard, io mi butto su ALLW! » sous le nom de la Bourse
de Milan. C'est un **capteur d'opinion** : le signal n'est jamais dans un post
isolé, il est dans le **changement de volume** — « si tout à coup tout le monde
commence à dire que quelque chose est mal, cela pourrait produire des
différences sur le marché ».

Trois décisions structurent le module :

1. **Silencieux par défaut.** Rien ne sort tant qu'aucun sujet ne décolle. Un
   baromètre permanent (« aujourd'hui on parle de X, Y, Z ») serait du bruit
   quotidien qu'on cesse de lire au bout d'une semaine.
2. **On compte des POSTS, pas de l'engagement.** Le flux RSS de Reddit ne
   donne ni votes ni commentaires — c'est une contrainte de la source, pas un
   choix. Le nombre de posts est donc la seule mesure honnête disponible.
3. **La référence est une MÉDIANE**, jamais une moyenne : une moyenne se
   laisse emporter par le pic isolé qu'on cherche justement à détecter. Un
   jour où le sujet est absent compte 0 — sinon un sujet qui n'apparaît que
   les jours d'emballement aurait une référence égale à son propre pic.

⚠️ **Amorçage.** Avec un journal vide, TOUT ressemble à un emballement. En
dessous de `MIN_HISTORY_DAYS` jours enregistrés on ne signale rien, et on DIT
pourquoi (`{"status": "storico insufficiente", "days": N}`) plutôt que de
mentir par omission : un silence se lit « il ne se passe rien », ce qui est
faux pendant la période de chauffe.

⚠️ **Ligne rouge.** Le module ne produit que des FAITS COMPTÉS. Aucun sujet ne
peut porter du vocabulaire prescriptif : `sentiment.find_prescriptive` est la
source unique de ce vocabulaire dans le dépôt (titres entrants, synthèse LLM
sortante) et c'est elle qui filtre ici aussi — on ne duplique pas la liste, on
l'interroge. Le rendu (`vault._buzz_lines`) applique le même garde-fou une
seconde fois : deux verrous plutôt qu'un, parce qu'un baromètre d'opinion lu
par un particulier âgé se lit très vite comme un conseil.

Aucun réseau, aucune dépendance : stdlib seule, plus les jeux de mots-outils
qui existaient déjà dans le dépôt.
"""
import datetime
import io
import json
import os
import re
import time
from typing import Any, Dict, List, Optional, Tuple

# ⚠️ On RÉUTILISE les vocabulaires existants au lieu d'en écrire un troisième :
# un doublon finit toujours par diverger de ses jumeaux (c'est exactement ce
# qu'avaient vécu `is_advice` et `check_synthesis` avant d'être fusionnés sur
# `PRESCRIPTIVE_PATTERNS`).
#   - `discover._STOPWORDS`  : mots-outils IT/EN/DE/FR, déjà éprouvés en réel.
#   - `discover._MIN_NAME_LEN` : « trois lettres, c'est trop court pour être
#     discriminant » — la même raison vaut ici.
#   - `sentiment._POSITIVE/_NEGATIVE` : ces mots décrivent le MOUVEMENT, pas le
#     sujet, et ils sont déjà comptés à part comme tonalité.
from .discover import _MIN_NAME_LEN, _STOPWORDS
from .sentiment import _NEGATIVE, _POSITIVE, _mentions, _norm, find_prescriptive

DEFAULT_PATH = os.path.join(
    os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))),
    "data", "market_pulse", "buzz_history.json")

KEEP_DAYS = 30          # fenêtre glissante du journal
REF_DAYS = 7            # sur combien de journées se calcule la référence
MIN_ABS = 5             # plancher absolu : en dessous, c'est du bruit
FACTOR = 3.0            # combien de fois son niveau habituel
MIN_HISTORY_DAYS = 3    # avant ça, on ne sait rien et on le dit
MAX_TOPICS = 6          # une section lisible, pas un annuaire
MIN_JOURNAL_COUNT = 2   # un mot vu une seule fois n'est pas une tendance

# Un token = une suite de lettres/chiffres latins. L'apostrophe et la
# ponctuation SÉPARENT (« l'inflazione » donne « inflazione »). Les écritures
# non latines ne produisent pas de sujets : sans espaces, un `\w+` avalerait un
# titre japonais entier et fabriquerait un faux sujet géant.
_TOKEN_RE = re.compile(r"[0-9A-Za-zÀ-ÿ]+")

_TONE_WORDS = frozenset(_POSITIVE) | frozenset(_NEGATIVE)

# ⚠️ Mots-outils ANGLAIS — le complément indispensable à `discover._STOPWORDS`.
#
# Cette liste-là est calibrée pour repérer des NOMS DE SOCIÉTÉS dans des
# dépêches italiennes, françaises et allemandes : elle couvre les mots
# capitalisés qui traînent en tête de titre, pas l'anglais fonctionnel. Or la
# moitié de la matière du baromètre vient de subreddits anglophones.
#
# MESURÉ sur la moisson réelle du 2026-08-04 : sur les six places de la
# section, TROIS étaient prises par « says » (6), « year » (6) et « advice »
# (5) — contre « nikkei » (17) et « palantir » (6), les deux seuls vrais
# signaux. L'argument d'auto-régulation par la médiane reste exact en régime
# établi, mais il ne protège pas là où ça compte, pour deux raisons :
#
#   1. `MAX_TOPICS` fait du déchet un CONCURRENT du signal. Un mot vide ne
#      coûte pas une ligne en trop : il prend la place d'un vrai sujet, qui
#      n'est alors jamais affiché — et personne ne peut le savoir.
#   2. La fenêtre de vulnérabilité n'est pas seulement l'amorçage. Toute
#      source ajoutée ou renommée repart d'une référence à zéro pour ses
#      mots-outils, et « daily discussion » / « advice thread » / « daily
#      general » sont les fils ÉPINGLÉS de Reddit : ils reviendront.
#
# Règle de constitution : uniquement des mots de classe FERMÉE (grammaticaux),
# leurs flexions, et le vocabulaire de RUBRIQUE des forums. **En cas de doute
# sur un mot, on le GARDE** : sa médiane finira par le neutraliser, alors qu'un
# vrai sujet écarté ne revient jamais. C'est pourquoi « tech », « chips »,
# « profit », « revenue », « forecasts », « social », « quarter », « media »,
# « points » ou « numbers » n'y figurent PAS — ce sont des sujets discutables,
# pas des mots vides, et c'est au rapport ×3 de les trier.
_EN_TOOL_WORDS = frozenset([
    # pronoms, déterminants, auxiliaires, contractions (l'apostrophe coupe le
    # token : « doesn't » donne « doesn »)
    "mine", "ours", "yours", "hers", "theirs", "myself", "yourself",
    "yourselves", "himself", "herself", "itself", "ourselves", "themselves",
    "someone", "somebody", "something", "anyone", "anybody", "anything",
    "everyone", "everybody", "everything", "none", "nobody", "nothing",
    "each", "every", "both", "either", "neither", "such", "same", "other",
    "others", "another", "else", "ever", "done", "doing", "having",
    "doesn", "didn", "hadn", "hasn", "haven", "aren", "wasn", "weren",
    "wouldn", "couldn", "shouldn", "gonna", "wanna",
    # interrogatifs, relatifs, connecteurs, prépositions
    "which", "while", "whom", "whose", "whether", "because", "though",
    "although", "however", "therefore", "thus", "since", "until", "unless",
    "upon", "onto", "amid", "amidst", "among", "amongst", "against",
    "between", "beyond", "behind", "below", "beneath", "beside", "besides",
    "above", "across", "along", "toward", "towards", "through", "throughout",
    "within", "without", "during", "despite", "regarding",
    # temps et fréquence
    "year", "years", "today", "tomorrow", "yesterday", "week", "weeks",
    "weekend", "month", "months", "time", "times", "hour", "hours",
    "minute", "minutes", "tonight", "morning", "evening", "night", "days",
    "soon", "later", "latest", "early", "earlier", "recent", "recently",
    "current", "currently", "always", "never", "often", "sometimes",
    "usually", "again", "already", "once", "twice", "ahead", "past",
    "next", "last", "previous", "upcoming",
    # quantité, degré, qualité générique
    "good", "better", "worse", "worst", "great", "real", "really", "true",
    "false",
    "wrong", "right", "sure", "main", "major", "minor", "whole", "full",
    "half", "many", "much", "least", "little", "long", "term", "terms",
    "high", "huge", "large", "enough", "quite", "very", "rather", "pretty",
    "plenty", "several", "various", "certain", "possible", "likely",
    "unlikely", "important", "interesting", "useful", "simple", "easy",
    "hard", "difficult", "similar", "different", "actual", "actually",
    "probably", "maybe", "perhaps", "almost", "nearly", "exactly", "simply",
    "clearly", "obviously", "basically", "honestly", "personally", "totally",
    "completely", "entirely", "mostly", "generally", "especially",
    # verbes génériques : dire, faire, avoir, aller — jamais un sujet
    "says", "said", "saying", "tells", "telling", "told", "asks", "asked",
    "asking", "make", "makes", "making", "made", "need", "needs", "needed",
    "want", "wants", "wanted", "help", "helps", "helped", "helping",
    "work", "works", "working", "worked", "come", "comes", "coming", "came",
    "goes", "going", "gone", "went", "gets", "getting", "take", "takes",
    "taking", "taken", "give", "gives", "giving", "given", "keep", "keeps",
    "keeping", "kept", "look", "looks", "looking", "seem", "seems",
    "think", "thinks", "thinking", "thought", "know", "knows", "knew",
    "feel", "feels", "used", "uses", "using", "mean", "means", "meant",
    # rubriques de forum et méta-publication : ce sont des ÉTIQUETTES de fil,
    # pas des sujets (« Daily Discussion Thread », « Advice Thread »)
    "thread", "threads", "megathread", "daily", "weekly", "monthly",
    "discussion", "discussions", "general", "advice", "question",
    "questions", "answer", "answers", "comment", "comments", "post",
    "posts", "posting", "article", "articles", "story", "stories", "news",
    "updates", "guide", "guides", "tips", "please", "thanks", "welcome",
    "repost", "crosspost", "subreddit", "reddit", "forum",
    # génériques du quotidien : trop larges pour désigner quoi que ce soit
    "business", "businesses", "company", "companies", "money", "people",
    "person", "thing", "things", "part", "parts", "ways", "stuff", "truth",
    "like", "likes", "first", "second", "third",
])


# --------------------------------------------------------------------------
# Extraction des sujets
# --------------------------------------------------------------------------

def _key(surface: str) -> str:
    """Forme normalisée d'un mot : minuscules, sans accent, sans ponctuation.

    « SOCIETÀ », « Società » et « societa » doivent être LE MÊME sujet, sinon
    un emballement se répartit sur trois compteurs et n'atteint aucun seuil.
    """
    return re.sub(r"[^a-z0-9]", "", _norm(surface))


def _is_word_topic(key: str) -> bool:
    if len(key) < _MIN_NAME_LEN or not any(c.isalpha() for c in key):
        return False
    return not (key in _STOPWORDS or key in _EN_TOOL_WORDS or key in _TONE_WORDS)


def is_topic(key: Any) -> bool:
    """Ce sujet est-il recevable — mot isolé comme paire de mots ?

    SOURCE UNIQUE du filtrage, appliquée à DEUX endroits :

    - à l'extraction (`topics_of`), pour que le journal ne se remplisse plus de
      mots vides ;
    - à la détection (`detect_surge`), parce que **le journal survit au
      déploiement**. Sans ce second passage, les « says » / « advice » déjà
      inscrits ressortiraient au premier run d'après — c'est exactement le
      piège du cache de notations du Bond Scanner, dans une autre robe.

    Une paire n'existe que si ses DEUX mots sont recevables : « daily
    discussion » et « advice thread » sont des rubriques de forum, pas des
    sujets, et deux mots vides accolés n'en font pas un plein.
    """
    parts = str(key or "").split()
    if not parts or not all(_is_word_topic(p) for p in parts):
        return False
    return find_prescriptive(key) is None


def topics_of(title: Any) -> List[Tuple[str, str]]:
    """Sujets d'un titre : `[(clé normalisée, graphie d'origine), …]`.

    Mots isolés **et** paires de mots adjacents — « Nvidia Blackwell » dit plus
    que « Nvidia » et « Blackwell » pris séparément. La graphie d'origine est
    conservée parce que « Vwce » se lirait comme une coquille là où « VWCE »
    est le nom que le lecteur connaît.

    Aucune identification de société, aucun résolveur, aucun réseau : un sujet
    est juste un mot qui revient.
    """
    if not isinstance(title, str) or not title.strip():
        return []
    kept = [(m.start(), m.end(), m.group(0), _key(m.group(0)))
            for m in _TOKEN_RE.finditer(title)]
    kept = [t for t in kept if is_topic(t[3])]

    out = []            # type: List[Tuple[str, str]]
    seen = set()

    def add(key, label):
        if key not in seen:
            seen.add(key)
            out.append((key, label))

    for _start, _end, surface, key in kept:
        add(key, surface)
    for left, right in zip(kept, kept[1:]):
        # Deux mots ne font une paire que s'ils se suivent VRAIMENT : une
        # virgule, un point ou une apostrophe séparent deux idées. Sans ce
        # test, « sull'intelligenza artificiale » fabriquait le faux sujet
        # « sull intelligenza », et une énumération « Milano, Tokyo » collait
        # deux places qui n'ont rien à voir.
        if not title[left[1]:right[0]].strip(" \t -") == "":
            continue
        pair = left[3] + " " + right[3]
        if is_topic(pair):
            add(pair, left[2] + " " + right[2])
    return out


# --------------------------------------------------------------------------
# L'agrégat du jour
# --------------------------------------------------------------------------

def _tone_of(title: str) -> Tuple[bool, bool]:
    """(porte un mot positif, porte un mot négatif) — un COMPTAGE, pas un
    jugement, et exactement le même lexique que le reste du bot."""
    text = _norm(title)
    return (any(_mentions(text, w) for w in _POSITIVE),
            any(_mentions(text, w) for w in _NEGATIVE))


def aggregate(items: Optional[List[Dict[str, Any]]],
              max_examples: int = 2) -> Dict[str, Dict[str, Any]]:
    """`{sujet: {count, tone_pos, tone_neg, examples, label}}` pour aujourd'hui.

    ⚠️ `count` compte des POSTS, pas des occurrences : un post qui répète trois
    fois « Nvidia » ne vaut pas trois voix.
    """
    out = {}       # type: Dict[str, Dict[str, Any]]
    for item in (items or []):
        if not isinstance(item, dict):
            continue
        title = item.get("title")
        if not isinstance(title, str) or not title.strip():
            continue
        pairs = topics_of(title)
        if not pairs:
            continue
        positive, negative = _tone_of(title)
        for key, label in pairs:
            entry = out.get(key)
            if entry is None:
                entry = out[key] = {"topic": key, "label": label, "count": 0,
                                    "tone_pos": 0, "tone_neg": 0, "examples": []}
            entry["count"] += 1
            entry["tone_pos"] += 1 if positive else 0
            entry["tone_neg"] += 1 if negative else 0
            if len(entry["examples"]) < max_examples and title not in entry["examples"]:
                entry["examples"].append(title)
    return out


# --------------------------------------------------------------------------
# Le journal — 30 jours glissants, écriture atomique, jamais de levée
# --------------------------------------------------------------------------

def day_key(now_ts: Optional[int] = None) -> str:
    """« 2026-07-30 » — la journée CIVILE locale, comme le nom des notes."""
    ts = int(now_ts if now_ts is not None else time.time())
    return datetime.datetime.fromtimestamp(ts).strftime("%Y-%m-%d")


def day_counts(agg: Optional[Dict[str, Dict[str, Any]]]) -> Dict[str, int]:
    """Ce qu'on garde du jour : `{sujet: nombre de posts}`.

    Les sujets vus UNE seule fois sont écartés — ils n'ont aucune chance
    d'atteindre le plancher un autre jour, et les garder ferait grossir le
    journal de plusieurs centaines d'entrées quotidiennes pour rien.
    """
    out = {}
    for topic, entry in (agg or {}).items():
        try:
            count = int((entry or {}).get("count") or 0)
        except (TypeError, ValueError, AttributeError):
            continue
        if count >= MIN_JOURNAL_COUNT:
            out[topic] = count
    return out


def load_history(path: Optional[str] = None) -> Dict[str, Any]:
    """Le journal du disque. Illisible ou absent ⇒ historique vide, jamais une
    levée : le baromètre est un confort, il ne fait pas tomber le briefing."""
    path = path or DEFAULT_PATH
    try:
        with io.open(path, encoding="utf-8") as f:
            raw = json.load(f)
    except (OSError, ValueError):
        return {"days": {}}
    days = raw.get("days") if isinstance(raw, dict) else None
    if not isinstance(days, dict):
        return {"days": {}}
    clean = {}
    for day, counts in days.items():
        if isinstance(day, str) and isinstance(counts, dict):
            clean[day] = {t: int(n) for t, n in counts.items()
                          if isinstance(t, str) and isinstance(n, int)}
    return {"days": clean}


def save_history(path: Optional[str], history: Dict[str, Any]) -> bool:
    """Écriture ATOMIQUE : un journal tronqué par une coupure serait relu comme
    « le sujet n'existait pas », donc comme un emballement le lendemain."""
    path = path or DEFAULT_PATH
    tmp = path + ".tmp"
    try:
        parent = os.path.dirname(path)
        if parent:
            os.makedirs(parent, exist_ok=True)
        with io.open(tmp, "w", encoding="utf-8") as f:
            f.write(json.dumps(history, ensure_ascii=False, sort_keys=True) + "\n")
        os.replace(tmp, path)
        return True
    except OSError:
        try:
            os.remove(tmp)
        except OSError:
            pass
        return False


def record_day(path: Optional[str], day: str,
               agg: Optional[Dict[str, Dict[str, Any]]],
               keep_days: int = KEEP_DAYS) -> Dict[str, Any]:
    """Inscrit la journée et rend le journal à jour.

    Deux règles, toutes deux nées du fonctionnement réel du bot :

    - **Fusion par MAXIMUM, jamais par addition.** Une journée porte cinq
      ouvertures de bourse, donc cinq runs, et un run peut produire trois
      briefings : additionner triplerait les compteurs du jour. Écraser
      effacerait un pic déjà observé le matin. Le maximum ne fait ni l'un ni
      l'autre, et re-jouer un run ne change rien.
    - **Une journée sans le moindre post n'est PAS inscrite.** « Nous n'avons
      rien observé » ne veut pas dire « le sujet était absent » : inscrire des
      zéros ferait chuter toutes les références et tout aurait l'air de
      décoller le lendemain.
    """
    history = load_history(path)
    if not agg:
        return history
    days = history["days"]
    previous = days.get(day) or {}
    merged = dict(previous)
    for topic, count in day_counts(agg).items():
        merged[topic] = max(int(previous.get(topic, 0)), int(count))
    days[day] = merged
    if keep_days and len(days) > keep_days:
        for old in sorted(days)[:-int(keep_days)]:
            del days[old]
    save_history(path, history)
    return history


# --------------------------------------------------------------------------
# La référence et la détection
# --------------------------------------------------------------------------

def baseline(history: Optional[Dict[str, Any]], topic: str, day: str,
             ref_days: int = REF_DAYS) -> float:
    """Niveau habituel du sujet : médiane des `ref_days` dernières journées
    ENREGISTRÉES avant `day`, une journée sans le sujet comptant 0.

    ⚠️ « Journées enregistrées », pas « jours du calendrier » : le bot ne tourne
    ni le week-end ni quand la machine dort. Compter les jours du calendrier
    injecterait des zéros et ferait décoller tout le monde au retour.
    """
    days = (history or {}).get("days") or {}
    past = sorted(d for d in days if d < day)
    past = past[-int(ref_days):] if ref_days and ref_days > 0 else []
    if not past:
        return 0.0
    values = sorted(float(days[d].get(topic, 0) or 0) for d in past)
    middle = len(values) // 2
    if len(values) % 2:
        return values[middle]
    return (values[middle - 1] + values[middle]) / 2.0


def _drop_absorbed(hits: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """« Nvidia Blackwell » cité huit fois ne doit pas produire aussi
    « Nvidia » et « Blackwell » : trois lignes qui disent la même chose.

    On n'écarte le mot seul que si son compteur est EXACTEMENT celui de la
    paire — c'est-à-dire s'il n'a jamais été cité en dehors d'elle. Un mot qui
    vit aussi de son côté garde sa ligne.
    """
    by_topic = dict((h["topic"], h) for h in hits)
    absorbed = set()
    for topic, hit in by_topic.items():
        if " " not in topic:
            continue
        for word in topic.split():
            alone = by_topic.get(word)
            if alone is not None and alone["count"] == hit["count"]:
                absorbed.add(word)
    return [h for h in hits if h["topic"] not in absorbed]


def detect_surge(agg: Optional[Dict[str, Dict[str, Any]]],
                 history: Optional[Dict[str, Any]],
                 day: str,
                 min_abs: int = MIN_ABS,
                 factor: float = FACTOR,
                 ref_days: int = REF_DAYS,
                 min_history_days: int = MIN_HISTORY_DAYS,
                 max_topics: int = MAX_TOPICS) -> List[Dict[str, Any]]:
    """Les sujets qui décollent aujourd'hui — une liste, vide les jours calmes.

    Un sujet décolle si `count >= min_abs` **et** (il était absent de la
    référence **ou** il vaut `factor` fois son niveau habituel). Le plancher
    absolu passe avant le rapport : quatre posts sur un sujet neuf, ce n'est
    pas un emballement, c'est du bruit.

    Un mot toujours fréquent a une référence haute et ne déclenche donc jamais
    — le mécanisme s'auto-régule, il n'y a **aucune liste noire de sujets**.

    Pendant la chauffe, rend une seule entrée qui dit pourquoi : mentir par
    omission ferait passer l'ignorance pour du calme.
    """
    days = (history or {}).get("days") or {}
    known = [d for d in days if d < day]
    if len(known) < int(min_history_days):
        return [{"status": "storico insufficiente", "days": len(known)}]

    hits = []
    for topic, entry in (agg or {}).items():
        count = int(entry.get("count") or 0)
        if count < int(min_abs):
            continue
        # Second passage du filtre : un journal écrit AVANT ce garde-fou porte
        # encore des mots vides, et il survit au déploiement (cf. `is_topic`).
        if not is_topic(topic):
            continue
        usual = baseline(history, topic, day, ref_days)
        if usual and count < float(factor) * usual:
            continue
        hits.append({
            "topic": topic,
            "label": entry.get("label") or topic,
            "count": count,
            "baseline": round(usual, 1),
            "tone_pos": int(entry.get("tone_pos") or 0),
            "tone_neg": int(entry.get("tone_neg") or 0),
            "examples": list(entry.get("examples") or []),
        })
    hits = _drop_absorbed(hits)
    hits.sort(key=lambda h: (-h["count"], h["topic"]))
    return hits[:int(max_topics)]
