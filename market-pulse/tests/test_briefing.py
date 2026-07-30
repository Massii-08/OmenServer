"""Assemblage du briefing d'UNE place — pur, tout injecté, aucun réseau.

C'est la pièce qui relie tout : l'indice de la place, la comparaison avec les
bourses déjà ouvertes, l'agenda daté, les news triées par « qui a fait quoi »,
les titres suivis et les nouveaux titres apparus.
"""
import json

from pulse.briefing import build_briefing
from pulse.exchanges import by_id

NOW = 1785310800   # 2026-07-29 09:00 Europe/Paris

SNAPSHOT = {
    "generated_at": NOW,
    "markets": [
        {"symbol": "^N100", "label": "Euronext 100", "region": "europe",
         "kind": "index", "price": 1904.55, "prev_close": 1898.0,
         "change_pct": 0.35, "gap": {"date": "2026-07-29", "gap_pct": 0.21,
                                     "open": 1901.9, "prev_close": 1898.0,
                                     "prev_date": "2026-07-28"},
         "gap_is_today": True, "gap_note": None, "currency": "EUR",
         "clock": {"status": "open", "opens_at": None, "closes_at": NOW + 30600,
                   "local_time": "09:00", "tz_name": "Europe/Paris",
                   "session_open": "09:00", "session_close": "17:30"}},
        {"symbol": "^N225", "label": "Nikkei 225 (Tokyo)", "region": "asia",
         "kind": "index", "price": 62364.92, "prev_close": 64931.19,
         "change_pct": -3.95, "gap": None, "gap_is_today": False,
         "gap_note": None, "currency": "JPY",
         "clock": {"status": "closed", "opens_at": None, "closes_at": None,
                   "local_time": "16:00", "tz_name": "Asia/Tokyo",
                   "session_open": "09:00", "session_close": "15:30"}},
        {"symbol": "^GSPC", "label": "S&P 500", "region": "usa",
         "kind": "index", "price": 7450.02, "prev_close": 7413.18,
         "change_pct": 0.50, "gap": None, "gap_is_today": False,
         "gap_note": None, "currency": "USD",
         "clock": {"status": "closed", "opens_at": NOW + 16200, "closes_at": None,
                   "local_time": "03:00", "tz_name": "America/New_York",
                   "session_open": "09:30", "session_close": "16:00"}},
    ],
    "errors": [],
}

NEWS = {"items": [
    {"title": "Webuild lancia opa su Trevi da 295 milioni", "source": "Il Sole 24 Ore",
     "url": "https://x.test/a", "published": NOW - 3600, "lang": "it"},
    {"title": "Is the AI rally running out of steam?", "source": "MarketWatch",
     "url": "https://x.test/b", "published": NOW - 600, "lang": "en"},
], "themes": [{"theme": "utili societari", "count": 3, "examples": ["a"]}],
    "tone": {"positive": 1, "negative": 1, "total": 2},
    "sources_ok": ["Il Sole 24 Ore"], "sources_failed": [],
    "stale_sources": [], "filtered_advice": 1, "generated_at": NOW}

AGENDA = [{"when": "2026-07-30T12:15:00Z", "what": "BCE — decisione sui tassi",
           "at_stake": "costo del denaro nell'area euro",
           "source_url": "https://ecb.test/cal"}]

FOLLOWED = [
    {"symbol": "RACE.MI", "label": "Ferrari", "price": 339.8, "change_pct": -0.45,
     "currency": "EUR", "earnings": {"date": "2026-07-30", "status": "confermata"}},
]

DISCOVERED = [
    {"symbol": "WBD.MI", "name": "WEBUILD", "exchange_id": "euronext",
     "mentions": 1, "headline": "Webuild lancia opa su Trevi da 295 milioni",
     "headlines": ["Webuild lancia opa su Trevi da 295 milioni"]},
]


def _build(**over):
    kwargs = dict(exchange=by_id("euronext"), snapshot=SNAPSHOT, news=NEWS,
                  agenda=AGENDA, followed=FOLLOWED, discovered=DISCOVERED,
                  now_ts=NOW)
    kwargs.update(over)
    return build_briefing(**kwargs)


# --------------------------------------------------------------------------
# Forme du contrat
# --------------------------------------------------------------------------

def test_the_briefing_has_the_expected_shape():
    b = _build()
    for key in ("exchange", "label", "index", "comparison", "agenda", "news",
                "followed", "discovered", "generated_at", "session"):
        assert key in b, key
    assert b["exchange"] == "euronext"
    assert b["label"] == "Euronext"
    json.dumps(b)                      # sérialisable tel quel


def test_the_index_is_the_one_of_this_venue():
    b = _build()
    assert b["index"]["symbol"] == "^N100"


def test_a_venue_whose_index_is_missing_still_produces_a_briefing():
    """Le snapshot peut avoir échoué sur cet indice précis : le briefing sort
    quand même, avec le reste, et le dit."""
    snap = {"generated_at": NOW, "markets": [], "errors": [
        {"symbol": "^N100", "error": "HTTPError: 503"}]}
    b = _build(snapshot=snap)
    assert b["index"] is None
    assert b["errors"], "l'échec doit être visible"


# --------------------------------------------------------------------------
# La comparaison — les places DÉJÀ passées, pas toutes les places
# --------------------------------------------------------------------------

def test_comparison_holds_the_markets_already_traded_today():
    """Quand l'Europe ouvre, l'Asie a déjà fermé et l'Amérique n'a pas ouvert :
    seule l'Asie éclaire cette ouverture."""
    b = _build()
    labels = [c["label"] for c in b["comparison"]]
    assert "Nikkei 225 (Tokyo)" in labels
    assert "Euronext 100" not in labels, "la place elle-même n'est pas sa comparaison"


def test_comparison_marks_what_has_not_opened_yet():
    b = _build()
    entry = [c for c in b["comparison"] if c["label"] == "S&P 500"][0]
    assert entry["state"] == "non ancora aperto"


def test_comparison_is_empty_when_nothing_else_is_known():
    snap = {"generated_at": NOW, "markets": [SNAPSHOT["markets"][0]], "errors": []}
    assert _build(snapshot=snap)["comparison"] == []


# --------------------------------------------------------------------------
# News : triées par « qui a fait quoi »
# --------------------------------------------------------------------------

def test_news_are_ranked_facts_first():
    b = _build()
    titles = [n["title"] for n in b["news"]["items"]]
    assert titles[0].startswith("Webuild"), "le fait doit passer devant l'opinion"
    assert b["news"]["items"][0]["event"]["is_event"] is True


def test_news_keeps_the_transparency_counters():
    b = _build()
    assert b["news"]["filtered_advice"] == 1
    assert b["news"]["sources_failed"] == []
    assert "tone" in b["news"]


def test_a_briefing_without_news_is_still_valid():
    b = _build(news=None)
    assert b["news"]["items"] == []
    assert b["news"]["filtered_advice"] == 0


# --------------------------------------------------------------------------
# Agenda et titres
# --------------------------------------------------------------------------

def test_agenda_is_carried_as_is():
    b = _build()
    assert b["agenda"][0]["what"].startswith("BCE")


def test_a_collection_alarm_reaches_the_briefing():
    """Une source qui a changé de format doit se voir à l'écran.

    Sans ce passage, l'alarme mourrait dans les logs et le briefing sortirait
    vide en ayant l'air normal — le pire échec possible ici.
    """
    b = _build(news={"items": [], "alarms": ["x.com/CNBC : 0 post sur 300 Ko"]})
    assert b["news"]["alarms"] == ["x.com/CNBC : 0 post sur 300 Ko"]


def test_no_alarm_is_an_empty_list_never_missing():
    b = _build(news=None)
    assert b["news"]["alarms"] == []


def test_followed_and_discovered_are_kept_separate():
    """Ne JAMAIS mélanger ce qu'il suit avec ce qu'on lui propose : la
    distinction est tout l'intérêt de la liste."""
    b = _build()
    assert [f["symbol"] for f in b["followed"]] == ["RACE.MI"]
    assert [d["symbol"] for d in b["discovered"]] == ["WBD.MI"]


def test_empty_lists_are_lists_not_none():
    b = _build(followed=None, discovered=None, agenda=None)
    assert b["followed"] == [] and b["discovered"] == [] and b["agenda"] == []


# --------------------------------------------------------------------------
# Séance : la pause déjeuner doit être dite
# --------------------------------------------------------------------------

def test_the_session_windows_are_exposed():
    b = _build(exchange=by_id("jpx"))
    assert b["session"]["windows"] == [["09:00", "11:30"], ["12:30", "15:30"]]
    assert b["session"]["lunch"] == ["11:30", "12:30"]


def test_a_venue_without_lunch_break_says_so():
    b = _build()
    assert b["session"]["lunch"] is None
    assert len(b["session"]["windows"]) == 1


# --------------------------------------------------------------------------
# Robustesse et ligne rouge
# --------------------------------------------------------------------------

def test_no_exchange_no_briefing():
    assert build_briefing(exchange=None, snapshot=SNAPSHOT, now_ts=NOW) is None


def test_a_briefing_carries_no_advice_field():
    b = _build()
    flat = json.dumps(b).lower()
    for banned in ("recommend", "consiglio", "target_price", "buy", "sell",
                   "direction", "prediction"):
        assert banned not in flat, "champ ou valeur interdit : %s" % banned
