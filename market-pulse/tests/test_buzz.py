"""Détecteur d'emballement de l'opinion — pur, hors ligne, horloge injectée.

Reddit n'est PAS un fil d'actualité dans ce bot : c'est un capteur d'opinion.
Le signal n'est jamais dans un post isolé, il est dans le fait qu'un sujet se
mette SOUDAINEMENT à être beaucoup plus discuté que d'habitude.

Ces tests verrouillent trois choses :

1. l'extraction ne fabrique pas de sujets à partir de mots-outils ;
2. la détection est SILENCIEUSE par défaut (jour calme = rien) et honnête à
   l'amorçage (elle dit qu'elle ne sait pas encore, elle ne se tait pas) ;
3. aucune sortie ne peut porter un terme prescriptif — c'est la ligne rouge :
   un baromètre d'opinion lu par un particulier âgé se lit très vite comme un
   conseil s'il en emprunte le vocabulaire.
"""
import io
import json
import os

from pulse import buzz
from pulse.sentiment import find_prescriptive

NOW = 1785398400        # 2026-07-30 (jeudi)


def _keys(pairs):
    return [k for k, _label in pairs]


def _post(title, published=NOW, source="Reddit r/investing"):
    return {"title": title, "source": source, "published": published, "lang": "en"}


# --------------------------------------------------------------------------
# Extraction des sujets — un sujet est un mot (ou une paire) qui revient, pas
# un ticker : aucun résolveur, aucun réseau.
# --------------------------------------------------------------------------

def test_a_topic_is_extracted_from_a_plain_title():
    assert "nvidia" in _keys(buzz.topics_of("Nvidia beats earnings, chip stocks rally"))


def test_tool_words_are_never_topics():
    """« stocks », « earnings » sont dans les jeux de mots-outils déjà présents
    dans le dépôt — en réécrire un troisième le ferait diverger des deux
    autres."""
    keys = _keys(buzz.topics_of("Nvidia beats earnings, chip stocks rally"))
    for tool in ("stocks", "earnings", "market", "the"):
        assert tool not in keys


def test_tone_words_are_never_topics():
    """« rally » / « crollo » décrivent le MOUVEMENT, pas le sujet — et ils sont
    déjà comptés à part comme tonalité."""
    keys = _keys(buzz.topics_of("Nvidia rally continua, poi il crollo"))
    assert "nvidia" in keys
    assert "rally" not in keys and "crollo" not in keys


def test_a_prescriptive_word_can_never_become_a_topic():
    """Ligne rouge, premier verrou : le vocabulaire de conseil est écarté à
    l'extraction, avant même d'avoir une chance d'atteindre l'écran."""
    keys = _keys(buzz.topics_of("Le 5 azioni Fineco da comprare subito"))
    assert "fineco" in keys
    assert "comprare" not in keys


def test_english_tool_words_are_never_topics():
    """`discover._STOPWORDS` est calibré pour repérer des NOMS DE SOCIÉTÉS dans
    des dépêches italiennes/françaises/allemandes ; il ne couvre pas l'anglais
    fonctionnel. Mesuré sur la moisson réelle du 2026-08-04 : « says », « year »
    et « advice » occupaient TROIS des six places de la section."""
    for word in ("says", "year", "years", "today", "which", "while", "first",
                 "like", "long", "made", "main", "make", "need", "right",
                 "since", "work", "through", "story", "truth", "better",
                 "behind", "below", "amid", "come", "doesn", "everything",
                 "yourself", "help", "helped", "thread", "daily", "discussion",
                 "general", "advice", "article", "posts", "news", "business",
                 "company", "money", "people", "thing", "things", "week",
                 "month", "time", "part", "back", "next", "last", "good",
                 "best", "real"):
        assert not buzz.is_topic(word), word


def test_a_pair_of_two_tool_words_is_never_a_topic():
    """« Daily Discussion », « Advice Thread » sont les fils ÉPINGLÉS de Reddit :
    des rubriques, pas des sujets. Et ils reviendront à chaque sub ajouté."""
    for title, ghost in (("Daily Discussion Thread", "daily discussion"),
                         ("Advice Thread - August", "advice thread"),
                         ("Daily General Discussion", "daily general")):
        assert ghost not in _keys(buzz.topics_of(title)), ghost
    assert not buzz.is_topic("daily discussion")


def test_real_subjects_survive_the_filter():
    """Le garde-fou anti-sur-filtrage : en cas de doute on GARDE un mot, sa
    médiane le neutralisera — tandis qu'un vrai sujet écarté ne revient
    jamais."""
    for title, expected in (
            ("Nikkei chiude in forte calo", "nikkei"),
            ("Palantir pubblica i conti", "palantir"),
            ("Acer e Asus alzano i prezzi", "acer"),
            ("Acer e Asus alzano i prezzi", "asus"),
            ("Micron e la memory shortage", "micron"),
            ("Micron e la memory shortage", "memory shortage"),
            ("Spotify forecasts third quarter revenue", "spotify"),
            ("SpaceX lancia un nuovo satellite", "spacex"),
            ("Fineco e Intesa a confronto", "fineco"),
            ("Fineco e Intesa a confronto", "intesa"),
            ("Bayer perde una causa", "bayer"),
            ("Teleborsa: il Ftse Mib apre debole", "teleborsa"),
            ("US inflation slows in July", "inflation"),
            ("New tariff on European cars", "tariff"),
            ("Taxes on capital gains", "taxes"),
            ("Timori sull'intelligenza artificiale", "intelligenza artificiale"),
            ("Il conto corrente non rende nulla", "conto corrente"),
            ("Come costruire un portafoglio", "portafoglio")):
        assert expected in _keys(buzz.topics_of(title)), (title, expected)


def test_a_theme_needs_no_ticker_at_all():
    """« Fineco » (un courtier), « VWCE » (un ETF) : des sujets libres, pas des
    sociétés à résoudre — aucun appel réseau n'est fait pour les reconnaître."""
    assert "fineco" in _keys(buzz.topics_of("Problemi con Fineco stamattina"))
    assert "vwce" in _keys(buzz.topics_of("Accumulo su VWCE ogni mese"))


def test_accents_and_case_collapse_to_one_topic():
    assert _keys(buzz.topics_of("SOCIETÀ")) == _keys(buzz.topics_of("società"))


def test_the_label_keeps_the_way_the_topic_was_written():
    """« Vwce » se lirait comme une coquille : on garde la graphie du post."""
    seen = dict(buzz.topics_of("Accumulo su VWCE ogni mese"))
    assert seen["vwce"] == "VWCE"


def test_two_adjacent_words_also_form_a_topic():
    pairs = buzz.topics_of("Nvidia Blackwell arriva")
    assert ("nvidia blackwell", "Nvidia Blackwell") in pairs
    assert "nvidia" in _keys(pairs)


def test_a_pair_needs_two_words_that_really_follow_each_other():
    """Une virgule, un point ou une apostrophe séparent deux idées : les
    recoller fabrique des sujets qui n'ont jamais été écrits (mesuré sur une
    vraie dépêche : « sull'intelligenza artificiale » donnait « sull
    intelligenza »)."""
    pairs = buzz.topics_of("Nvidia, Blackwell arriva")
    assert "nvidia blackwell" not in _keys(pairs)
    assert "blackwell arriva" in _keys(pairs)

    keys = _keys(buzz.topics_of("Timori sull'intelligenza artificiale"))
    assert "intelligenza artificiale" in keys
    assert "sull intelligenza" not in keys


def test_short_words_and_bare_numbers_are_not_topics():
    keys = _keys(buzz.topics_of("AI 2026 su 10 anni"))
    assert "ai" not in keys and "2026" not in keys and "10" not in keys


def test_garbage_in_gives_an_empty_list():
    assert buzz.topics_of(None) == []
    assert buzz.topics_of("") == []
    assert buzz.topics_of(42) == []


# --------------------------------------------------------------------------
# L'agrégat du jour — on compte des POSTS, jamais des occurrences
# --------------------------------------------------------------------------

def test_a_topic_repeated_inside_one_post_counts_for_one_post():
    agg = buzz.aggregate([_post("Nvidia, ancora Nvidia, sempre Nvidia")])
    assert agg["nvidia"]["count"] == 1


def test_two_posts_on_the_same_topic_count_two():
    agg = buzz.aggregate([_post("Nvidia sale"), _post("Nvidia scende")])
    assert agg["nvidia"]["count"] == 2


def test_tone_is_counted_not_judged():
    agg = buzz.aggregate([_post("Nvidia crollo e timori"),
                          _post("Nvidia record e ottimismo"),
                          _post("Nvidia presenta un chip")])
    assert agg["nvidia"]["count"] == 3
    assert agg["nvidia"]["tone_neg"] == 1
    assert agg["nvidia"]["tone_pos"] == 1


def test_examples_are_capped():
    agg = buzz.aggregate([_post("Nvidia %d oggi" % i) for i in range(6)])
    assert len(agg["nvidia"]["examples"]) == 2


def test_aggregating_nothing_is_an_empty_dict():
    assert buzz.aggregate([]) == {}
    assert buzz.aggregate(None) == {}
    assert buzz.aggregate([{"title": None}, "pas un dict"]) == {}


# --------------------------------------------------------------------------
# Le journal — 30 jours glissants, écriture atomique, jamais de levée
# --------------------------------------------------------------------------

def test_the_journal_survives_a_round_trip(tmp_path):
    path = str(tmp_path / "buzz_history.json")
    buzz.record_day(path, "2026-07-30",
                    buzz.aggregate([_post("Nvidia sale"), _post("Nvidia scende")]))
    assert buzz.load_history(path)["days"]["2026-07-30"]["nvidia"] == 2


def test_the_journal_is_written_atomically(tmp_path):
    path = str(tmp_path / "buzz_history.json")
    buzz.record_day(path, "2026-07-30", {"nvidia": {"count": 4}})
    assert os.path.isfile(path)
    assert [f for f in os.listdir(str(tmp_path)) if f.endswith(".tmp")] == []


def test_recording_the_same_day_twice_never_triples_the_counters(tmp_path):
    """Trois briefings dans un run, cinq ouvertures dans une journée : le
    compteur du jour ne doit ni s'additionner ni effacer un pic déjà vu."""
    path = str(tmp_path / "h.json")
    buzz.record_day(path, "2026-07-30", {"nvidia": {"count": 8}})
    buzz.record_day(path, "2026-07-30", {"nvidia": {"count": 2}})
    assert buzz.load_history(path)["days"]["2026-07-30"]["nvidia"] == 8


def test_a_day_without_any_post_is_not_recorded(tmp_path):
    """Un jour où la collecte a échoué n'est PAS un jour où le sujet était
    absent : l'enregistrer ferait chuter la référence et tout aurait l'air de
    décoller le lendemain."""
    path = str(tmp_path / "h.json")
    buzz.record_day(path, "2026-07-29", {"nvidia": {"count": 4}})
    buzz.record_day(path, "2026-07-30", {})
    assert "2026-07-30" not in buzz.load_history(path)["days"]


def test_a_topic_seen_only_once_in_a_day_is_not_journalled():
    """Un mot vu une seule fois n'est pas une tendance ; le garder ferait
    grossir le journal de plusieurs centaines d'entrées par jour pour rien."""
    assert buzz.day_counts({"nvidia": {"count": 1}, "fineco": {"count": 2}}) \
        == {"fineco": 2}


def test_days_older_than_the_window_are_purged(tmp_path):
    path = str(tmp_path / "h.json")
    for n in range(1, 41):
        day = "2026-06-%02d" % n if n <= 30 else "2026-07-%02d" % (n - 30)
        buzz.record_day(path, day, {"x": {"count": 3}}, keep_days=30)
    days = buzz.load_history(path)["days"]
    assert len(days) == 30
    assert "2026-06-01" not in days
    assert "2026-07-10" in days


def test_an_unreadable_journal_gives_an_empty_history_and_never_raises(tmp_path):
    path = str(tmp_path / "h.json")
    with io.open(path, "w", encoding="utf-8") as f:
        f.write("{ceci n'est pas du json")
    assert buzz.load_history(path) == {"days": {}}


def test_a_missing_journal_gives_an_empty_history(tmp_path):
    assert buzz.load_history(str(tmp_path / "jamais-ecrit.json")) == {"days": {}}


def test_recording_never_raises_on_an_unwritable_path():
    """Le baromètre est un CONFORT : un journal qu'on n'arrive pas à écrire ne
    doit pas faire tomber le briefing du matin."""
    got = buzz.record_day("/proc/interdit/nulle-part/h.json", "2026-07-30",
                          {"x": {"count": 3}})
    assert "days" in got


# --------------------------------------------------------------------------
# La référence — MÉDIANE, un jour d'absence comptant zéro
# --------------------------------------------------------------------------

def _hist(days):
    return {"days": days}


def test_the_baseline_is_the_median_not_the_mean():
    """Une moyenne se laisse emporter par un seul pic ; c'est exactement ce
    qu'on cherche à détecter, donc exactement ce qui ne doit pas entrer dans
    la référence."""
    days = {"2026-07-%02d" % d: {"nvidia": 2} for d in range(20, 26)}
    days["2026-07-26"] = {"nvidia": 90}
    assert buzz.baseline(_hist(days), "nvidia", "2026-07-30") == 2


def test_a_day_where_the_topic_is_absent_counts_zero():
    days = {"2026-07-20": {"nvidia": 6}, "2026-07-21": {},
            "2026-07-22": {}, "2026-07-23": {}}
    assert buzz.baseline(_hist(days), "nvidia", "2026-07-30") == 0


def test_the_baseline_uses_the_last_recorded_days_not_the_calendar():
    """Le bot ne tourne pas tous les jours (week-ends, machine éteinte) :
    compter les jours du CALENDRIER injecterait des zéros et ferait décoller
    tout le monde au retour."""
    days = {"2026-07-01": {"x": 4}, "2026-07-02": {"x": 4}, "2026-07-03": {"x": 4},
            "2026-07-04": {"x": 4}, "2026-07-05": {"x": 4},
            "2026-07-13": {"x": 4}, "2026-07-14": {"x": 4}}
    assert buzz.baseline(_hist(days), "x", "2026-07-15") == 4


def test_the_current_day_never_feeds_its_own_baseline():
    days = {"2026-07-27": {"x": 1}, "2026-07-28": {"x": 1},
            "2026-07-29": {"x": 1}, "2026-07-30": {"x": 40}}
    assert buzz.baseline(_hist(days), "x", "2026-07-30") == 1


# --------------------------------------------------------------------------
# La détection — silencieuse par défaut, honnête à l'amorçage
# --------------------------------------------------------------------------

def _seed(n_days=7, counts=None):
    days = {}
    for d in range(20, 20 + n_days):
        days["2026-07-%02d" % d] = dict(counts or {})
    return _hist(days)


def test_with_an_empty_journal_nothing_is_ever_flagged():
    """Sans historique TOUT ressemble à un emballement : le piège d'amorçage."""
    agg = buzz.aggregate([_post("Nvidia %d" % i) for i in range(40)])
    found = buzz.detect_surge(agg, _hist({}), "2026-07-30")
    assert [f for f in found if "topic" in f] == []


def test_the_warmup_says_why_instead_of_staying_silent():
    agg = buzz.aggregate([_post("Nvidia %d" % i) for i in range(40)])
    found = buzz.detect_surge(agg, _hist({"2026-07-29": {"nvidia": 1}}),
                              "2026-07-30")
    assert found == [{"status": "storico insufficiente", "days": 1}]


def test_three_recorded_days_are_enough_to_start():
    agg = buzz.aggregate([_post("Nvidia %d" % i) for i in range(9)])
    found = buzz.detect_surge(agg, _seed(3), "2026-07-30")
    assert [f["topic"] for f in found] == ["nvidia"]
    assert found[0]["count"] == 9
    assert found[0]["baseline"] == 0


def test_a_calm_day_reports_nothing_at_all():
    agg = buzz.aggregate([_post("Nvidia %d" % i) for i in range(6)])
    assert buzz.detect_surge(agg, _seed(counts={"nvidia": 6}), "2026-07-30") == []


def test_a_topic_below_the_absolute_floor_is_never_flagged():
    """Quatre posts sur un sujet neuf, ce n'est pas un emballement — c'est du
    bruit. Le plancher absolu passe AVANT le rapport de multiplication."""
    agg = buzz.aggregate([_post("Fineco %d" % i) for i in range(4)])
    assert buzz.detect_surge(agg, _seed(), "2026-07-30") == []


def test_a_topic_must_triple_its_usual_level():
    seeded = _seed(counts={"fineco": 3})
    nine = buzz.aggregate([_post("Fineco %d" % i) for i in range(9)])
    eight = buzz.aggregate([_post("Fineco %d" % i) for i in range(8)])
    assert [f["topic"] for f in buzz.detect_surge(nine, seeded, "2026-07-30")] == ["fineco"]
    assert buzz.detect_surge(eight, seeded, "2026-07-30") == []


def test_a_word_that_is_always_frequent_regulates_itself():
    """Pas de liste noire de sujets : un mot très courant a une référence haute,
    donc il ne déclenche jamais. Le mécanisme s'auto-régule."""
    agg = buzz.aggregate([_post("Inflazione %d oggi" % i) for i in range(25)])
    seeded = _seed(counts={"inflazione": 22})
    assert buzz.detect_surge(agg, seeded, "2026-07-30") == []


def test_the_thresholds_are_parameters():
    agg = buzz.aggregate([_post("Fineco %d" % i) for i in range(3)])
    assert buzz.detect_surge(agg, _seed(), "2026-07-30", min_abs=3)


def test_a_surge_carries_the_facts_needed_to_write_the_line():
    agg = buzz.aggregate([_post("Nvidia crollo %d" % i) for i in range(7)])
    found = buzz.detect_surge(agg, _seed(counts={"nvidia": 2}), "2026-07-30")
    entry = found[0]
    for key in ("topic", "label", "count", "baseline", "tone_pos", "tone_neg",
                "examples"):
        assert key in entry, key
    assert entry["count"] == 7 and entry["baseline"] == 2 and entry["tone_neg"] == 7
    json.dumps(found)


def test_surges_are_ordered_by_how_much_is_said():
    agg = buzz.aggregate([_post("Fineco oggi") for _ in range(6)]
                         + [_post("Nvidia oggi") for _ in range(12)])
    found = buzz.detect_surge(agg, _seed(), "2026-07-30")
    assert [f["topic"] for f in found] == ["nvidia", "fineco"]


def test_a_pair_absorbs_its_words_when_they_only_appear_together():
    """« Nvidia Blackwell » cité 8 fois produirait sinon trois lignes qui
    disent exactement la même chose."""
    agg = buzz.aggregate([_post("Nvidia Blackwell %d" % i) for i in range(8)])
    topics = [f["topic"] for f in buzz.detect_surge(agg, _seed(), "2026-07-30")]
    assert "nvidia blackwell" in topics
    assert "nvidia" not in topics and "blackwell" not in topics


def test_a_word_that_also_lives_outside_the_pair_keeps_its_own_line():
    agg = buzz.aggregate([_post("Nvidia Blackwell %d" % i) for i in range(6)]
                         + [_post("Nvidia oggi %d" % i) for i in range(6)])
    topics = [f["topic"] for f in buzz.detect_surge(agg, _seed(), "2026-07-30")]
    assert "nvidia" in topics and "nvidia blackwell" in topics


def test_the_number_of_reported_topics_is_capped():
    agg = buzz.aggregate([_post("Argomento%d oggi" % i)
                          for i in range(40) for _ in range(6)])
    assert len(buzz.detect_surge(agg, _seed(), "2026-07-30")) <= buzz.MAX_TOPICS


# --------------------------------------------------------------------------
# La moisson RÉELLE du 2026-08-04 — la mesure qui a montré que trois des six
# places de la section étaient squattées par des mots vides.
# --------------------------------------------------------------------------

# Compteurs relevés dans le journal de l'Omen, tronqués aux sujets capables
# d'atteindre le plancher de 5 (en dessous, aucun ne peut être signalé).
REAL_DAY = {
    "nikkei": 17, "palantir": 6, "profit": 6, "says": 6, "year": 6,
    "acer": 5, "advice": 5, "asus": 5, "chips": 5, "news": 5, "spacex": 5,
    "tech": 5, "years": 5, "amid": 4, "cxmt": 4, "daily": 4, "discussion": 4,
    "first": 4, "forecasts": 4, "revenue": 4, "social": 4, "spotify": 4,
    "spotify forecasts": 4, "today": 4,
}


def _agg_from_counts(counts):
    """Rejoue un agrégat depuis des compteurs de journal — exactement le chemin
    qu'emprunte un journal DÉJÀ écrit, mots vides compris."""
    return dict((topic, {"topic": topic, "label": topic, "count": n,
                         "tone_pos": 0, "tone_neg": 0, "examples": []})
                for topic, n in counts.items())


def test_the_real_harvest_of_the_day_shows_only_real_signals():
    seeded = _hist({"2026-07-%02d" % d: {"nikkei": 2, "palantir": 2,
                                         "profit": 3, "which": 4, "today": 4}
                    for d in range(20, 27)})
    topics = [f["topic"] for f in
              buzz.detect_surge(_agg_from_counts(REAL_DAY), seeded, "2026-07-30")]
    assert topics[:2] == ["nikkei", "palantir"], topics
    for junk in ("says", "year", "years", "advice", "news", "today", "first",
                 "daily", "discussion", "amid"):
        assert junk not in topics, junk
    assert "acer" in topics, topics


def test_a_frequent_word_is_still_filtered_by_the_multiplier_not_by_a_list():
    """« profit » est un vrai sujet et reste dans le vocabulaire : c'est le
    rapport ×3 (6 contre une référence de 3) qui l'écarte, pas une liste."""
    seeded = _hist({"2026-07-%02d" % d: {"profit": 3} for d in range(20, 27)})
    topics = [f["topic"] for f in
              buzz.detect_surge(_agg_from_counts({"profit": 6}), seeded,
                                "2026-07-30")]
    assert topics == []
    topics = [f["topic"] for f in
              buzz.detect_surge(_agg_from_counts({"profit": 12}), seeded,
                                "2026-07-30")]
    assert topics == ["profit"]


def test_a_journal_written_before_the_filter_is_never_replayed():
    """Le journal SURVIT au déploiement — même classe de piège que le cache de
    notations du Bond Scanner. Les mots vides déjà inscrits ne doivent pas
    ressortir au premier run d'après, sans qu'on ait à purger le fichier."""
    agg = _agg_from_counts({"says": 9, "advice thread": 9, "nikkei": 9})
    topics = [f["topic"] for f in buzz.detect_surge(agg, _seed(), "2026-07-30")]
    assert topics == ["nikkei"]


def test_junk_no_longer_competes_for_the_capped_slots():
    """Le vrai coût du bruit n'était pas sa présence, c'était la PLACE qu'il
    prenait : sous plafond, un mot vide évince un vrai sujet et personne ne le
    saura jamais."""
    counts = {"says": 20, "year": 19, "advice": 18, "today": 17, "news": 16,
              "daily": 15, "nikkei": 9, "palantir": 8, "fineco": 7}
    topics = [f["topic"] for f in
              buzz.detect_surge(_agg_from_counts(counts), _seed(), "2026-07-30")]
    assert topics == ["nikkei", "palantir", "fineco"]


# --------------------------------------------------------------------------
# LIGNE ROUGE — aucune sortie ne peut porter un terme prescriptif
# --------------------------------------------------------------------------

def test_no_surge_can_carry_prescriptive_vocabulary():
    """`sentiment.find_prescriptive` est la SOURCE UNIQUE du vocabulaire
    interdit (titres entrants, synthèse LLM sortante, et maintenant le
    baromètre) — on ne duplique pas la liste, on l'interroge."""
    agg = buzz.aggregate(
        [_post("Titoli da comprare: Nvidia, secondo gli analisti") for _ in range(9)]
        + [_post("Prezzo obiettivo alzato su Fineco") for _ in range(9)])
    found = buzz.detect_surge(agg, _seed(), "2026-07-30")
    assert found, "le cas de test doit produire des sujets pour prouver quelque chose"
    for entry in found:
        assert find_prescriptive(entry["topic"]) is None, entry["topic"]
        assert find_prescriptive(entry["label"]) is None, entry["label"]


def test_the_day_key_is_the_local_calendar_day():
    assert buzz.day_key(NOW) == "2026-07-30"


# --------------------------------------------------------------------------
# CÂBLAGE — la logique peut être parfaite et la fonctionnalité MORTE
#
# C'est le piège le plus cher du dépôt, vécu trois fois : l'agenda et les
# collecteurs sociaux ont été « livrés » sans jamais être appelés. Code
# exécuté, tests verts, rien qui marche. Les tests ci-dessous ne vérifient
# donc pas ce que les fonctions savent faire, mais ce que `main` en FAIT :
# le fichier réellement écrit, et le champ réellement propagé.
# --------------------------------------------------------------------------

import main as engine                                          # noqa: E402


def _press():
    return {"items": [{"title": "Prysmian acquisisce Encore Wire",
                       "source": "Il Sole 24 Ore", "url": "https://x.test/1",
                       "published": NOW, "lang": "it"}],
            "themes": [], "tone": {}, "sources_ok": ["Il Sole 24 Ore"],
            "sources_failed": [], "stale_sources": [], "filtered_advice": 0,
            "filtered_offtopic": 0, "alarms": []}


REDDIT_TITLES = ["Nvidia %d oggi" % i for i in range(6)]
BLUESKY_TITLE = "Piazza Affari apre debole sui bancari"


def _social():
    posts = [{"title": t, "source": "Reddit r/investing", "url": "",
              "published": NOW, "lang": "en"} for t in REDDIT_TITLES]
    posts.append({"title": BLUESKY_TITLE, "source": "Bluesky « borsa milano »",
                  "url": "", "published": NOW, "lang": "it"})
    return {"items": posts, "sources_ok": ["Reddit r/investing"],
            "sources_failed": [], "alarms": [], "filtered_advice": 0,
            "filtered_offtopic": 0, "generated_at": NOW}


def test_reddit_never_reaches_the_headlines():
    """Reddit n'est pas un fil d'actualité : le publier comme tel a mis
    « Fanculo Vanguard, io mi butto su ALLW! » sous le nom de la Bourse de
    Milan. Bluesky, lui, garde sa place dans les titres."""
    kept = engine._headline_posts(_social()["items"], limit=10)
    titles = [i["title"] for i in kept]
    assert BLUESKY_TITLE in titles
    assert not [t for t in titles if t in REDDIT_TITLES]


def test_headlines_stay_capped_per_source():
    posts = [{"title": "Post %d" % i, "source": "Bluesky « x »",
              "published": NOW} for i in range(20)]
    assert len(engine._headline_posts(posts, limit=100, per_source=6)) == 6


def _run_briefings(tmp_path, monkeypatch, borse=("euronext", "nyse", "jpx")):
    out = tmp_path / "out"
    out.mkdir()
    prefs = tmp_path / "prefs.json"
    with io.open(str(prefs), "w", encoding="utf-8") as f:
        f.write(json.dumps({
            "borse": list(borse), "titoli": {},
            "opzioni": {"reddit": True, "bluesky": True, "x": False,
                        "sintesi": False, "scoperte": False, "quaderno": False,
                        "max_notizie": 9}}))
    history = tmp_path / "buzz_history.json"
    # Cinq journées déjà connues : au-dessus du seuil d'amorçage, donc la
    # détection est réellement armée pendant le test.
    buzz.save_history(str(history),
                      {"days": {"2026-07-%02d" % d: {"borsa": 12}
                                for d in range(20, 25)}})

    monkeypatch.setattr("pulse.news.collect_news", lambda **kw: _press())
    monkeypatch.setattr("pulse.agenda.collect_agenda",
                        lambda *a, **kw: {"events": [], "sources_ok": [],
                                          "sources_failed": [], "horizon_h": 168.0})
    monkeypatch.setattr("pulse.social.collect_social", lambda **kw: _social())

    args = engine._parser().parse_args(
        ["--out", str(out), "--prefs", str(prefs),
         "--buzz-history", str(history)])
    briefs = engine._briefings(args, {"generated_at": NOW, "markets": [],
                                      "errors": []}, NOW)
    return briefs, str(history), out


def test_main_really_writes_the_journal(tmp_path, monkeypatch):
    """Le journal doit exister sur le disque, à l'endroit demandé — sinon la
    référence de demain est vide et tout décollera."""
    _briefs, history, _out = _run_briefings(tmp_path, monkeypatch)
    days = buzz.load_history(history)["days"]
    assert buzz.day_key(NOW) in days
    assert days[buzz.day_key(NOW)]["nvidia"] == 6


def test_three_briefings_do_not_triple_the_counters_of_the_day(tmp_path, monkeypatch):
    """Toutes les bourses d'un run voient les mêmes posts : les compter une
    fois par place inventerait un emballement tous les matins. Depuis
    « collecter partout », le run sort un briefing par place du catalogue mais
    n'en ANALYSE que trois — et le journal du jour reste compté UNE fois."""
    briefs, history, _out = _run_briefings(tmp_path, monkeypatch)
    assert len([b for b in briefs.values() if b.get("selected")]) == 3
    assert len(briefs) > 3, "la collecte couvre tout le catalogue"
    assert buzz.load_history(history)["days"][buzz.day_key(NOW)]["nvidia"] == 6


def test_the_buzz_reaches_every_briefing(tmp_path, monkeypatch):
    briefs, _history, _out = _run_briefings(tmp_path, monkeypatch)
    for venue, brief in briefs.items():
        topics = [b.get("topic") for b in brief["buzz"]]
        assert "nvidia" in topics, venue


def test_reddit_feeds_the_buzz_but_not_the_news_of_the_briefing(tmp_path, monkeypatch):
    briefs, _history, _out = _run_briefings(tmp_path, monkeypatch)
    titles = [i["title"] for i in briefs["euronext"]["news"]["items"]]
    assert not [t for t in titles if t in REDDIT_TITLES], titles
    assert BLUESKY_TITLE in titles, "Bluesky garde sa place dans les titres"


def test_the_buzz_is_written_into_briefings_json(tmp_path, monkeypatch):
    _briefs, _history, out = _run_briefings(tmp_path, monkeypatch)
    with io.open(str(out / "briefings.json"), encoding="utf-8") as f:
        saved = json.load(f)
    assert [b["topic"] for b in saved["nyse"]["buzz"]] == ["nvidia"]
