"""L'agenda daté — les « prévisions » honnêtes. Hors ligne, fixtures RÉELLES.

Ce que le briefing appelle « prévision », c'est **une date et ce qui est en jeu**,
jamais une direction. Trois sources ont été sondées à la main le 2026-07-30 :

- **Fed** — `federalreserve.gov/monetarypolicy/fomccalendars.htm` : les huit
  réunions 2026 ET 2027, en clair, dans des panneaux par année.
- **BoJ** — `boj.or.jp/en/mopo/mpmsche_minu/index.htm` : le calendrier des
  réunions, année en légende de tableau (« Table : 2026 »).
- **BNS** — `snb.ch/public/rss/en/events` : 58 items **futurs** (jusqu'en 2028),
  date ISO. C'est le seul flux RSS réellement daté dans le futur qu'on ait
  trouvé chez une banque centrale.

⚠️ BCE et BoE rendent 200 mais leur calendrier est construit en JavaScript : les
dates ne sont PAS dans le HTML. Elles passent par le fichier curé — jamais par
une date inventée.

Le garde-fou central, testé ici plusieurs fois : **une date passée ne doit jamais
sortir comme prochain rendez-vous**. C'est le même piège que la date de résultats
de Yahoo (spec §3quinquies) et que le flux MarketWatch vieux de treize mois.
"""
import io
import json
import os

from pulse.agenda import collect_agenda as _collect_agenda
from pulse.agenda import upcoming_events as _upcoming_events
from pulse.agenda import (for_venue, load_curated, parse_boj_schedule,
                          parse_fomc_calendar, parse_snb_events)

FIXTURES = os.path.join(os.path.dirname(__file__), "fixtures")


def _raw(name, binary=True):
    mode = "rb" if binary else "r"
    kw = {} if binary else {"encoding": "utf-8"}
    with io.open(os.path.join(FIXTURES, name), mode, **kw) as f:
        return f.read()


SNB = _raw("agenda_snb.xml")
FOMC = _raw("agenda_fomc.html", binary=False)
BOJ = _raw("agenda_boj.html", binary=False)

# 2026-07-30 12:00 UTC — le jour où les trois sources ont été sondées.
NOW = 1785412800

FORBIDDEN = [
    "comprare", "vendere", "consiglio", "consigliamo", "conviene",
    "raccomand", "occasione", "target price", "previsione", "prevedo",
    "prevediamo", "dovrebbe salire", "dovrebbe scendere", "suggeriamo",
    "acquistare", "portafoglio",
]


# --------------------------------------------------------------------------
# Fed
# --------------------------------------------------------------------------

def test_fomc_calendar_yields_the_eight_meetings_of_each_year():
    events = parse_fomc_calendar(FOMC)
    years = {}
    for e in events:
        years.setdefault(e["when"][:4], 0)
        years[e["when"][:4]] += 1
    assert years.get("2026") == 8, years
    assert years.get("2027") == 8, years


def test_fomc_meeting_is_dated_on_its_DECISION_day_not_its_first_day():
    # « October 27-28 » : la décision tombe le 28. Annoncer le 27 ferait
    # attendre le communiqué un jour trop tôt.
    events = parse_fomc_calendar(FOMC)
    october = [e for e in events if e["when"].startswith("2026-10")]
    assert len(october) == 1
    assert october[0]["when"] == "2026-10-28", october[0]


def test_fomc_asterisk_of_the_projections_meetings_is_not_shown_to_the_reader():
    # Le « * » du site signale les réunions avec projections économiques : il ne
    # doit pas se retrouver tel quel dans un texte lu par un particulier.
    for e in parse_fomc_calendar(FOMC):
        assert "*" not in e["what"], e["what"]


def test_fomc_events_are_tagged_for_the_american_venues_only():
    for e in parse_fomc_calendar(FOMC):
        assert set(e["venues"]) == {"nyse", "nasdaq"}, e


def test_fomc_dates_are_day_only_because_no_hour_was_measured():
    # On a mesuré une DATE, pas une heure : prétendre « 20:00 » serait inventer.
    for e in parse_fomc_calendar(FOMC):
        assert e["day_only"] is True
        assert len(e["when"]) == 10


def test_fomc_label_is_in_italian_with_the_day_range():
    events = [e for e in parse_fomc_calendar(FOMC) if e["when"] == "2026-10-28"]
    assert "ottobre" in events[0]["what"], events[0]["what"]
    assert "27" in events[0]["what"] and "28" in events[0]["what"]


# --------------------------------------------------------------------------
# BoJ
# --------------------------------------------------------------------------

def test_boj_schedule_reads_the_year_from_the_table_caption():
    events = parse_boj_schedule(BOJ)
    years = sorted({e["when"][:4] for e in events})
    # Le fixture contient les tableaux 2026 et 2025.
    assert "2026" in years and "2025" in years, years


def test_boj_july_meeting_of_the_probe_day_is_read_with_its_decision_day():
    # « July 30 (Thurs.), 31 (Fri.) » → la décision tombe le 31.
    events = parse_boj_schedule(BOJ)
    july = [e for e in events if e["when"].startswith("2026-07")]
    assert len(july) == 1, july
    assert july[0]["when"] == "2026-07-31", july[0]


def test_boj_handles_the_abbreviated_month_names_of_the_page():
    # « Sept. » et « Mar. » ne sont pas des noms de mois standards.
    events = parse_boj_schedule(BOJ)
    got = {e["when"] for e in events}
    assert "2026-09-18" in got, sorted(got)
    assert "2026-03-19" in got, sorted(got)


def test_boj_events_are_tagged_for_tokyo():
    for e in parse_boj_schedule(BOJ):
        assert e["venues"] == ["jpx"], e


def test_boj_pdf_noise_never_reaches_the_label():
    for e in parse_boj_schedule(BOJ):
        assert "PDF" not in e["what"], e["what"]


# --------------------------------------------------------------------------
# BNS
# --------------------------------------------------------------------------

def test_snb_events_feed_is_read_and_dated():
    events = parse_snb_events(SNB)
    assert len(events) > 40
    for e in events:
        assert e["when_ts"] > 0
        assert e["source"] == "BNS"


def test_snb_events_come_back_in_chronological_order():
    # ⚠️ Le flux est servi du plus LOINTAIN au plus proche : un parseur qui fait
    # confiance à items[0] annoncerait 2028 comme prochain rendez-vous.
    events = parse_snb_events(SNB)
    stamps = [e["when_ts"] for e in events]
    assert stamps == sorted(stamps)


def test_snb_monetary_policy_assessment_is_labelled_in_italian():
    events = parse_snb_events(SNB)
    assessments = [e for e in events if "politica monetaria" in e["what"]]
    assert assessments, [e["what"] for e in events[:5]]


def test_snb_date_prefix_of_the_title_is_not_repeated_in_the_label():
    for e in parse_snb_events(SNB):
        assert not e["what"].startswith("20"), e["what"]


def test_snb_keeps_the_ics_link_so_the_reader_can_check():
    for e in parse_snb_events(SNB):
        assert e["source_url"].startswith("https://"), e


# --------------------------------------------------------------------------
# Le garde-fou : jamais une date passée
# --------------------------------------------------------------------------

def _fetch_all(url):
    if "snb.ch" in url:
        return SNB
    if "federalreserve" in url:
        return FOMC
    if "boj.or.jp" in url:
        return BOJ
    raise AssertionError("URL inattendue: %s" % url)


def collect_agenda(*a, **kw):
    """Wrapper des tests : le pacing réseau (0,4 s par source) n'a rien à faire
    dans une suite hors ligne — il coûtait 10 s sur 12 tests."""
    kw.setdefault("sleep", lambda _s: None)
    return _collect_agenda(*a, **kw)


def upcoming_events(*a, **kw):
    kw.setdefault("sleep", lambda _s: None)
    return _upcoming_events(*a, **kw)


def test_no_past_event_can_ever_be_announced_as_upcoming():
    got = collect_agenda(NOW, fetch=_fetch_all, curated_path="/nonexistent",
                         horizon_h=24 * 365 * 3)
    assert got["events"], "aucun événement — le filtre a tout mangé"
    for e in got["events"]:
        assert e["when_ts"] + 86400 >= NOW, e


def test_a_day_only_event_falling_TODAY_is_still_upcoming():
    # La réunion BoJ du 31 juillet 2026 est encore devant nous le 30 à midi ;
    # celle du 30 juillet aussi (elle court toute la journée).
    got = collect_agenda(NOW, fetch=_fetch_all, curated_path="/nonexistent",
                         horizon_h=48)
    whens = [e["when"] for e in got["events"]]
    assert "2026-07-31" in whens, whens


def test_the_horizon_is_respected():
    got = collect_agenda(NOW, fetch=_fetch_all, curated_path="/nonexistent",
                         horizon_h=48, max_items=50)
    for e in got["events"]:
        assert e["when_ts"] <= NOW + 48 * 3600 + 86400, e


def test_events_are_sorted_from_the_nearest_to_the_farthest():
    got = collect_agenda(NOW, fetch=_fetch_all, curated_path="/nonexistent",
                         horizon_h=24 * 400, max_items=50)
    stamps = [e["when_ts"] for e in got["events"]]
    assert stamps == sorted(stamps)


def test_a_broken_source_never_costs_the_others():
    def half_broken(url):
        if "federalreserve" in url:
            raise RuntimeError("503")
        return _fetch_all(url)

    got = collect_agenda(NOW, fetch=half_broken, curated_path="/nonexistent",
                         horizon_h=24 * 400, max_items=50)
    assert got["events"], "une source en panne a tout emporté"
    assert any("Fed" in s["source"] for s in got["sources_failed"]), got["sources_failed"]
    assert "BoJ" in got["sources_ok"] or "BNS" in got["sources_ok"], got["sources_ok"]


def test_collect_agenda_never_raises_even_without_any_source():
    got = collect_agenda(NOW, fetch=lambda u: (_ for _ in ()).throw(OSError("down")),
                         curated_path="/nonexistent")
    assert got["events"] == []
    assert len(got["sources_failed"]) >= 1


# --------------------------------------------------------------------------
# Filtre par place
# --------------------------------------------------------------------------

def test_an_event_tagged_for_new_york_does_not_show_under_tokyo():
    got = collect_agenda(NOW, fetch=_fetch_all, curated_path="/nonexistent",
                         horizon_h=24 * 400, max_items=80)
    tokyo = for_venue(got["events"], "jpx")
    for e in tokyo:
        assert (not e["venues"]) or "jpx" in e["venues"], e


def test_an_untagged_event_shows_everywhere():
    events = [{"when": "2026-08-01", "when_ts": NOW + 3600, "day_only": True,
               "what": "x", "at_stake": "", "source": "s", "source_url": "",
               "venues": []}]
    assert for_venue(events, "jpx") == events
    assert for_venue(events, "euronext") == events


def test_no_venue_asked_means_everything():
    got = collect_agenda(NOW, fetch=_fetch_all, curated_path="/nonexistent",
                         horizon_h=24 * 400, max_items=80)
    assert for_venue(got["events"], None) == got["events"]


# --------------------------------------------------------------------------
# Fichier curé
# --------------------------------------------------------------------------

def test_curated_file_is_read_and_merged(tmp_path):
    path = tmp_path / "agenda.json"
    path.write_text(json.dumps({"eventi": [
        {"when": "2026-07-31T11:45Z", "what": "BCE — decisione sui tassi",
         "at_stake": "il costo del denaro nell'area euro",
         "source_url": "https://www.ecb.europa.eu/", "venues": ["euronext"]},
    ]}, ensure_ascii=False), encoding="utf-8")
    got = collect_agenda(NOW, fetch=_fetch_all, curated_path=str(path),
                         horizon_h=48, max_items=50)
    labels = [e["what"] for e in got["events"]]
    assert any("BCE" in x for x in labels), labels
    milan = for_venue(got["events"], "euronext")
    assert any("BCE" in e["what"] for e in milan)


def test_a_curated_entry_without_a_date_is_dropped_not_crashed(tmp_path):
    path = tmp_path / "agenda.json"
    path.write_text(json.dumps({"eventi": [
        {"what": "senza data"},
        {"when": "pas une date", "what": "data illeggibile"},
        {"when": "2026-08-01", "what": "buono"},
    ]}), encoding="utf-8")
    events = load_curated(str(path))
    assert [e["what"] for e in events] == ["buono"]


def test_a_curated_file_that_is_broken_json_yields_nothing(tmp_path):
    path = tmp_path / "agenda.json"
    path.write_text("{ pas du json", encoding="utf-8")
    assert load_curated(str(path)) == []


def test_a_missing_curated_file_is_not_an_error():
    assert load_curated("/nonexistent/agenda.json") == []


def test_a_curated_list_at_the_root_is_accepted_too(tmp_path):
    # Écrit à la main : accepter les deux formes évite un fichier « ignoré en
    # silence » parce qu'il manque la clé enveloppe.
    path = tmp_path / "agenda.json"
    path.write_text(json.dumps([{"when": "2026-08-01", "what": "ok"}]), encoding="utf-8")
    assert len(load_curated(str(path))) == 1


# --------------------------------------------------------------------------
# Ligne rouge
# --------------------------------------------------------------------------

def test_the_agenda_never_carries_prescriptive_or_predictive_vocabulary():
    got = collect_agenda(NOW, fetch=_fetch_all, curated_path="/nonexistent",
                         horizon_h=24 * 400, max_items=80)
    flat = json.dumps(got, ensure_ascii=False).lower()
    for word in FORBIDDEN:
        assert word not in flat, "vocabolario vietato nell'agenda: %r" % word


def test_an_event_says_what_is_at_stake_never_which_way_it_goes():
    got = collect_agenda(NOW, fetch=_fetch_all, curated_path="/nonexistent",
                         horizon_h=24 * 400, max_items=80)
    for e in got["events"]:
        low = (e.get("at_stake") or "").lower()
        for banned in ("salirà", "scenderà", "rialzo previsto", "taglio previsto"):
            assert banned not in low, e


def test_upcoming_events_is_the_thin_wrapper_the_briefing_consumes():
    events = upcoming_events(NOW, fetch=_fetch_all, curated_path="/nonexistent",
                             horizon_h=24 * 400, venue="nyse")
    assert isinstance(events, list)
    for e in events:
        assert (not e["venues"]) or "nyse" in e["venues"], e
