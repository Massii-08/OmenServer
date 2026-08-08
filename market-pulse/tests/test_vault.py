"""Écriture dans le coffre Obsidian — c'est ce qui fait vivre le graphe.

Chaque briefing dépose une note qui POINTE vers sa place et vers ses thèmes.
Les rétroliens d'Obsidian font le reste : ouvrir `[[inflazione]]` montre tous
les jours où le sujet a touché une place, et laquelle a bougé.
"""
import io
import os

from pulse.sentiment import THEMES, find_prescriptive
from pulse.vault import (BUZZ_TITLE, note_filename, render_note, theme_slug,
                         write_note)

NOW = 1785398400   # 2026-07-30 (jeudi)

BRIEFING = {
    "exchange": "euronext", "label": "Euronext",
    "country": "Area euro (NL, FR, BE, PT, IE, IT, NO)",
    "index": {"symbol": "^N100", "label": "Euronext 100", "price": 1904.55,
              "change_pct": 0.35, "currency": "EUR",
              "gap": {"gap_pct": 0.21, "date": "2026-07-30"}, "gap_is_today": True,
              "gap_note": None},
    "session": {"tz": "Europe/Paris", "opens_at": "09:00", "closes_at": "17:30",
                "lunch": None, "windows": [["09:00", "17:30"]]},
    "comparison": [{"label": "Nikkei 225", "change_pct": -1.49, "state": "chiuso"},
                   {"label": "S&P 500", "change_pct": -1.52, "state": "chiuso"}],
    "agenda": [{"when": "2026-07-30T12:15:00Z", "what": "BCE — decisione sui tassi",
                "at_stake": "costo del denaro"}],
    "news": {"items": [
        {"title": "Chipotle hikes same-store sales forecast", "source": "CNBC",
         "url": "https://x.test/1",
         "event": {"is_event": True, "actor": "azienda", "actions": ["previsioni"]}},
        {"title": "Is the AI rally running out of steam?", "source": "MarketWatch",
         "url": "https://x.test/2",
         "event": {"is_event": False, "actor": None, "actions": []}}],
        "themes": [{"theme": "utili societari", "count": 3, "examples": []},
                   {"theme": "banche centrali", "count": 2, "examples": []}],
        "tone": {"positive": 2, "negative": 1, "total": 6},
        "sources_ok": ["CNBC"], "sources_failed": [], "stale_sources": [],
        "filtered_advice": 1, "filtered_offtopic": 0},
    "followed": [{"symbol": "RACE.MI", "label": "Ferrari", "change_pct": -0.45}],
    "discovered": [{"symbol": "CMG", "name": "Chipotle Mexican Grill",
                    "exchange_id": "nyse", "mentions": 1,
                    "headline": "Chipotle hikes same-store sales forecast"}],
    "errors": [], "generated_at": NOW,
}

ANALYSIS = {"text": "Stamattina Euronext apre dopo una seduta asiatica in ribasso.",
            "model": "claude-sonnet-5", "degraded": False, "reason": None}


# --------------------------------------------------------------------------
# Le lien entre les deux mondes : le slug de thème
# --------------------------------------------------------------------------

def test_theme_slug_matches_the_vault_filenames():
    assert theme_slug("banche centrali") == "banche-centrali"
    assert theme_slug("debito e titoli di stato") == "debito-e-titoli-di-stato"
    assert theme_slug("inflazione") == "inflazione"


def test_every_engine_theme_has_a_slug():
    """Sans ça, un thème produit par le moteur créerait un lien mort dans le
    coffre — et la page de thème correspondante n'existerait jamais."""
    for name in THEMES:
        slug = theme_slug(name)
        assert slug and " " not in slug and slug == slug.lower()


def test_theme_slug_tolerates_garbage():
    assert theme_slug(None) == ""
    assert theme_slug("") == ""


# --------------------------------------------------------------------------
# Le nom de fichier
# --------------------------------------------------------------------------

def test_note_filename_is_dated_and_named_after_the_venue():
    assert note_filename(BRIEFING, NOW) == "2026-07-30 — Euronext.md"


def test_a_venue_label_with_a_slash_does_not_break_the_path():
    b = dict(BRIEFING, label="Euronext / Milan")
    assert "/" not in note_filename(b, NOW)


# --------------------------------------------------------------------------
# Le contenu — ce sont les LIENS qui font le graphe
# --------------------------------------------------------------------------

def test_the_note_links_to_its_exchange():
    md = render_note(BRIEFING, ANALYSIS, NOW)
    assert "[[Euronext]]" in md


def test_the_note_links_to_each_theme_by_slug():
    md = render_note(BRIEFING, ANALYSIS, NOW)
    assert "[[utili-societari]]" in md
    assert "[[banche-centrali]]" in md
    assert "[[utili societari]]" not in md, "lien non slugifié = lien mort"


def test_the_note_carries_the_facts():
    md = render_note(BRIEFING, ANALYSIS, NOW)
    assert "1.904,55" in md          # format italien
    assert "+0,35%" in md
    assert "Nikkei 225" in md
    assert "BCE" in md
    assert "Chipotle" in md


def test_the_note_carries_the_synthesis_when_there_is_one():
    md = render_note(BRIEFING, ANALYSIS, NOW)
    assert "seduta asiatica in ribasso" in md
    assert "claude-sonnet-5" in md


def test_the_note_says_when_the_synthesis_is_missing():
    md = render_note(BRIEFING, {"text": None, "degraded": True,
                                "reason": "claude introuvable", "model": "x"}, NOW)
    assert "non disponibile" in md.lower()
    assert "claude introuvable" in md


def test_facts_come_before_commentary_in_the_note():
    md = render_note(BRIEFING, ANALYSIS, NOW)
    assert md.index("Chipotle") < md.index("AI rally")


# --------------------------------------------------------------------------
# Une troncature muette se lit comme « il n'y avait que ça » — mesuré sur un
# run réel : Euronext avait 13 titres dans le contrat, la note n'en rendait
# que 8, sans jamais le dire (le plafond de 6 sur « Commenti e analisi » est
# légitime pour rester lisible, c'est son SILENCE qui ne l'était pas).
# --------------------------------------------------------------------------

def test_the_note_says_how_many_extra_comments_were_left_out():
    items = [{"title": "Commento %d" % i, "source": "S",
              "event": {"is_event": False}} for i in range(9)]
    b = dict(BRIEFING, news={"items": items})
    md = render_note(b, ANALYSIS, NOW)
    assert "(e altre 3 notizie non mostrate)" in md


def test_the_note_says_how_many_extra_facts_were_left_out():
    items = [{"title": "Fatto %d" % i, "source": "S",
              "event": {"is_event": True, "actor": "azienda", "actions": ["x"]}}
             for i in range(20)]
    b = dict(BRIEFING, news={"items": items})
    md = render_note(b, ANALYSIS, NOW)
    assert "(e altre 8 notizie non mostrate)" in md


def test_the_note_stays_silent_when_nothing_is_left_out():
    """Peu d'items (le cas normal) : aucune mention parasite."""
    md = render_note(BRIEFING, ANALYSIS, NOW)
    assert "non mostrate" not in md


def test_followed_and_discovered_are_two_distinct_sections():
    md = render_note(BRIEFING, ANALYSIS, NOW)
    assert "Ferrari" in md and "Chipotle Mexican Grill" in md
    assert md.index("RACE.MI") != md.index("CMG")


def test_frontmatter_is_valid_and_carries_the_venue():
    md = render_note(BRIEFING, ANALYSIS, NOW)
    assert md.startswith("---\n")
    head = md.split("---")[1]
    assert "date: 2026-07-30" in head
    assert "borsa: euronext" in head


def test_a_briefing_with_no_index_still_renders():
    md = render_note(dict(BRIEFING, index=None), ANALYSIS, NOW)
    assert "[[Euronext]]" in md
    assert "n/d" in md


def test_errors_are_written_not_hidden():
    b = dict(BRIEFING, errors=[{"symbol": "^N100", "error": "HTTPError: 503"}])
    md = render_note(b, ANALYSIS, NOW)
    assert "^N100" in md and "503" in md


def test_the_note_contains_no_advice():
    md = render_note(BRIEFING, ANALYSIS, NOW).lower()
    for banned in ("consiglio", "conviene", "comprare", "vendere", "target price"):
        assert banned not in md


# --------------------------------------------------------------------------
# Baromètre d'opinion — une section SILENCIEUSE par défaut, et purement
# descriptive quand elle parle. C'est la section la plus dangereuse de la
# note : un chiffre de conversation se lit très vite comme une prévision.
# --------------------------------------------------------------------------

def _buzz_section(md):
    """Le texte de la section « di cosa si parla », ou "" si elle est absente."""
    if BUZZ_TITLE not in md:
        return ""
    tail = md.split(BUZZ_TITLE, 1)[1]
    return tail.split("\n## ", 1)[0]


BUZZ = [{"topic": "nvidia", "label": "Nvidia", "count": 18, "baseline": 3.0,
         "tone_pos": 2, "tone_neg": 11, "examples": ["Nvidia, che succede?"]}]


def test_a_calm_day_shows_no_section_at_all():
    """Pas de baromètre permanent : les jours calmes, il n'y a rien à dire et
    la note n'en parle pas."""
    md = render_note(dict(BRIEFING, buzz=[]), ANALYSIS, NOW)
    assert BUZZ_TITLE not in md


def test_a_briefing_without_the_field_renders_as_before():
    """Rétro-compatibilité : les briefings déjà écrits n'ont pas le champ."""
    assert BUZZ_TITLE not in render_note(BRIEFING, ANALYSIS, NOW)


def test_a_surge_is_written_as_a_counted_fact():
    md = render_note(dict(BRIEFING, buzz=BUZZ), ANALYSIS, NOW)
    section = _buzz_section(md)
    assert "Nvidia" in section
    assert "18" in section and "3" in section
    assert "11" in section, "le comptage de tonalité doit être là"


def test_a_topic_never_seen_before_says_so_instead_of_showing_a_zero():
    entry = dict(BUZZ[0], baseline=0.0, count=9)
    section = _buzz_section(render_note(dict(BRIEFING, buzz=[entry]), ANALYSIS, NOW))
    assert "mai" in section.lower()
    assert "contro 0" not in section


def test_a_topic_without_any_tone_word_says_nothing_about_tone():
    entry = dict(BUZZ[0], tone_pos=0, tone_neg=0)
    section = _buzz_section(render_note(dict(BRIEFING, buzz=[entry]), ANALYSIS, NOW))
    assert "tono" not in section.lower()


def test_the_warmup_says_why_the_section_is_quiet():
    """« Je ne sais pas encore » vaut mieux qu'un silence qui se lit « il ne se
    passe rien »."""
    md = render_note(dict(BRIEFING, buzz=[{"status": "storico insufficiente",
                                           "days": 1}]), ANALYSIS, NOW)
    section = _buzz_section(md)
    assert section.strip(), "la chauffe doit être dite"
    assert "3" in section, "on dit combien de journées il faut"


# ⚠️ LIGNE ROUGE. Le rendu est le SECOND verrou (le premier est l'extraction,
# cf. tests/test_buzz.py) : même si un sujet prescriptif atteignait le champ,
# il ne doit pas atteindre l'écran.

def test_the_rendered_section_can_carry_no_prescriptive_word():
    md = render_note(dict(BRIEFING, buzz=BUZZ), ANALYSIS, NOW)
    assert find_prescriptive(_buzz_section(md)) is None


def test_a_prescriptive_topic_is_dropped_at_render_time():
    poisoned = [dict(BUZZ[0], topic="da comprare", label="da comprare"),
                dict(BUZZ[0], topic="prezzo obiettivo", label="Prezzo obiettivo")]
    md = render_note(dict(BRIEFING, buzz=poisoned), ANALYSIS, NOW)
    assert BUZZ_TITLE not in md, "aucune ligne valable : pas de section vide"
    assert find_prescriptive(md.split("## Nota di raccolta")[0]) is None


def test_the_section_never_predicts_nor_advises():
    md = render_note(dict(BRIEFING, buzz=BUZZ), ANALYSIS, NOW)
    section = _buzz_section(md).lower()
    for banned in ("potrebbe", "si deteriora", "pessimist", "segnale",
                   "vendita", "acquisto", "previsione", "investitori"):
        assert banned not in section, banned


def test_render_without_a_briefing():
    assert render_note(None, ANALYSIS, NOW) is None


# --------------------------------------------------------------------------
# L'écriture
# --------------------------------------------------------------------------

def test_write_creates_the_daily_folder_and_the_file(tmp_path):
    path = write_note(str(tmp_path), BRIEFING, ANALYSIS, NOW)
    assert os.path.isfile(path)
    assert "20 - Giornaliero" in path
    body = io.open(path, encoding="utf-8").read()
    assert "[[Euronext]]" in body


def test_writing_twice_the_same_day_replaces_instead_of_duplicating(tmp_path):
    """Un rattrapage peut relancer le briefing du jour : on remplace, on
    n'accumule pas deux notes contradictoires pour la même date."""
    first = write_note(str(tmp_path), BRIEFING, ANALYSIS, NOW)
    second = write_note(str(tmp_path), BRIEFING, ANALYSIS, NOW)
    assert first == second
    folder = os.path.dirname(first)
    assert len([f for f in os.listdir(folder) if f.endswith(".md")]) == 1


def test_write_returns_none_without_a_briefing(tmp_path):
    assert write_note(str(tmp_path), None, ANALYSIS, NOW) is None


def test_write_never_raises_on_an_unwritable_root():
    """Le coffre est un CONFORT : si l'écriture échoue, le briefing a déjà été
    publié ailleurs et le run ne doit pas tomber pour autant."""
    assert write_note("/proc/interdit/nulle-part", BRIEFING, ANALYSIS, NOW) is None
