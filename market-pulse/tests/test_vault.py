"""Écriture dans le coffre Obsidian — c'est ce qui fait vivre le graphe.

Chaque briefing dépose une note qui POINTE vers sa place et vers ses thèmes.
Les rétroliens d'Obsidian font le reste : ouvrir `[[inflazione]]` montre tous
les jours où le sujet a touché une place, et laquelle a bougé.
"""
import io
import os

from pulse.sentiment import THEMES
from pulse.vault import (note_filename, render_note, theme_slug, write_note)

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
