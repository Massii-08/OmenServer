"""Scanner d'actions — l'état de séance (PUR) : de QUAND datent variation, gap et volume.

Horodatages réels du relevé du lundi 19/10/2026 13:30 UTC : barre journalière
européenne ouverte à 07:00 UTC le lundi, barre américaine ouverte à 13:30 UTC
le VENDREDI 16/10 (les États-Unis étaient en pré-ouverture).
"""
from datetime import datetime, timezone

import pytest

from backend.bots.stockscan import session as ss

MONDAY_1330 = datetime(2026, 10, 19, 13, 30, 37, tzinfo=timezone.utc)
EU_BAR = 1792393200          # lundi 19/10/2026 07:00 UTC (09:00 à Rome)
US_BAR = 1792157400          # vendredi 16/10/2026 13:30 UTC (09:30 à New York)
LATE_MONDAY = datetime(2026, 10, 19, 23, 30, tzinfo=timezone.utc)   # mardi 08:30 à Tokyo


# --------------------------------------------------------------------------- #
# state_of
# --------------------------------------------------------------------------- #

@pytest.mark.parametrize("raw,expected", [
    ("market", "open"),
    ("pre_market", "pre_open"),
    ("post_market", "closed"),
    ("out_of_session", "closed"),
])
def test_state_of_known_values(raw, expected):
    assert ss.state_of(raw) == expected


@pytest.mark.parametrize("raw", [None, "", "closed", "regular", "MARKET", 1, True, ["market"]])
def test_state_of_never_guesses(raw):
    assert ss.state_of(raw) is None


# --------------------------------------------------------------------------- #
# bar_date
# --------------------------------------------------------------------------- #

@pytest.mark.parametrize("bar_time,tz,expected", [
    (EU_BAR, "Europe/Rome", "2026-10-19"),
    (US_BAR, "America/New_York", "2026-10-16"),
    (EU_BAR * 1000, "Europe/Rome", "2026-10-19"),             # millisecondes
    (float(US_BAR), "America/New_York", "2026-10-16"),
])
def test_bar_date_is_the_local_day_of_the_place(bar_time, tz, expected):
    assert ss.bar_date(bar_time, tz) == expected


def test_bar_date_uses_the_place_clock_not_utc():
    """Une barre ouverte à 23:00 UTC le dimanche est la séance du LUNDI à Sydney."""
    sydney_open = int(datetime(2026, 10, 18, 23, 0, tzinfo=timezone.utc).timestamp())
    assert ss.bar_date(sydney_open, "Australia/Sydney") == "2026-10-19"
    assert ss.bar_date(sydney_open, None) == "2026-10-18"     # sans fuseau : jour UTC


@pytest.mark.parametrize("tz", [None, "", "Mars/Olympus_Mons", "../../etc/passwd",
                                "/etc/localtime", "Europe/../../etc/passwd", 42])
def test_bar_date_falls_back_to_utc_day_on_bad_timezone(tz):
    late = int(LATE_MONDAY.timestamp())                        # mardi à Tokyo, lundi en UTC
    assert ss.bar_date(late, tz) == "2026-10-19"


@pytest.mark.parametrize("bar_time", [None, "", "lundi", 0, -5, 12345, True,
                                      float("nan"), float("inf"), [EU_BAR]])
def test_bar_date_unreadable_timestamp_is_none(bar_time):
    assert ss.bar_date(bar_time, "Europe/Rome") is None


# --------------------------------------------------------------------------- #
# local_today
# --------------------------------------------------------------------------- #

def test_local_today_uses_the_place_clock():
    assert ss.local_today(LATE_MONDAY, "Asia/Tokyo") == "2026-10-20"
    assert ss.local_today(LATE_MONDAY, "America/New_York") == "2026-10-19"
    assert ss.local_today(LATE_MONDAY, None) == "2026-10-19"                  # UTC
    assert ss.local_today(LATE_MONDAY, "../../etc/passwd") == "2026-10-19"    # UTC
    # une horloge sans fuseau est lue comme de l'UTC, jamais à l'heure de la machine :
    # 15:30 UTC = 00:30 le mardi à Tokyo (lu à l'heure de Rome, ce serait encore lundi)
    assert ss.local_today(datetime(2026, 10, 19, 15, 30), "Asia/Tokyo") == "2026-10-20"


@pytest.mark.parametrize("now", [None, "2026-10-19", 1792393200])
def test_local_today_without_a_clock_is_none(now):
    assert ss.local_today(now, "Europe/Rome") is None


# --------------------------------------------------------------------------- #
# is_stale
# --------------------------------------------------------------------------- #

def test_pre_open_monday_with_friday_figures_is_stale():
    """La variation de -11,9 % de CoreWeave lue lundi à 13:30 UTC est celle de vendredi."""
    assert ss.is_stale("pre_open", "2026-10-16", "America/New_York", MONDAY_1330) is True


def test_open_session_is_never_stale():
    assert ss.is_stale("open", "2026-10-19", "Europe/Rome", MONDAY_1330) is False
    assert ss.is_stale("open", "2026-10-16", "America/New_York", MONDAY_1330) is False


def test_closed_after_todays_close_is_not_stale():
    evening = datetime(2026, 10, 19, 17, 50, tzinfo=timezone.utc)
    assert ss.is_stale("closed", "2026-10-19", "Europe/Rome", evening) is False


def test_closed_with_an_earlier_session_is_stale():
    tuesday_dawn = datetime(2026, 10, 20, 5, 0, tzinfo=timezone.utc)      # 07:00 à Rome
    assert ss.is_stale("closed", "2026-10-19", "Europe/Rome", tuesday_dawn) is True
    saturday = datetime(2026, 10, 24, 10, 0, tzinfo=timezone.utc)         # week-end
    assert ss.is_stale("closed", "2026-10-23", "Europe/Paris", saturday) is True


def test_stale_compares_with_the_local_day_of_the_place():
    # lundi 23:30 UTC : déjà mardi à Tokyo, encore lundi à New York
    assert ss.is_stale("pre_open", "2026-10-19", "Asia/Tokyo", LATE_MONDAY) is True
    assert ss.is_stale("pre_open", "2026-10-19", "America/New_York", LATE_MONDAY) is False


@pytest.mark.parametrize("state,day", [
    (None, "2026-10-16"), ("weird", "2026-10-16"), ("pre_market", "2026-10-16"),
    ("pre_open", None), ("closed", ""), ("closed", "vendredi"), ("pre_open", 20261016),
])
def test_unknown_state_or_date_is_never_stale(state, day):
    assert ss.is_stale(state, day, "America/New_York", MONDAY_1330) is False


def test_stale_without_a_clock_is_false():
    assert ss.is_stale("pre_open", "2026-10-16", "America/New_York", None) is False
