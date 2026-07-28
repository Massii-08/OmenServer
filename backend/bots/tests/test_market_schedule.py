"""Tests de la planification matinale du Market Pulse.

Tout est hors-ligne : les fonctions de décision sont PURES (horloge injectée) et
le scheduler est un double. Le cœur de fiabilité testé ici est
``should_catch_up`` — la machine (Omen) dort de 01:00 à 06:00, un déclenchement
peut être manqué, il faut savoir décider du rattrapage sans se tromper.
"""
from datetime import date, datetime

import pytest
from zoneinfo import ZoneInfo

from backend.bots import market_schedule as ms


ROME = ZoneInfo("Europe/Rome")


def _cfg(**over):
    base = {"enabled": True, "time": "07:30", "tz": "Europe/Rome", "days": "weekdays"}
    base.update(over)
    return base


# --- validation ------------------------------------------------------------

def test_parse_time_accepts_hh_mm():
    assert ms.parse_time("07:30") == (7, 30)
    assert ms.parse_time("7:05") == (7, 5)
    assert ms.parse_time("00:00") == (0, 0)
    assert ms.parse_time("23:59") == (23, 59)


@pytest.mark.parametrize("bad", ["", "abc", "24:00", "07:60", "-1:00", "0730", "07:30:00", None])
def test_parse_time_rejects_garbage(bad):
    with pytest.raises(ms.ScheduleError):
        ms.parse_time(bad)


def test_validate_normalises_time_and_defaults():
    cfg = ms.validate({"enabled": 1, "time": "7:5", "tz": "Europe/Rome", "days": "daily"})
    assert cfg["enabled"] is True
    assert cfg["time"] == "07:05"
    assert cfg["days"] == "daily"


def test_validate_rejects_unknown_timezone():
    with pytest.raises(ms.ScheduleError):
        ms.validate(_cfg(tz="Mars/Olympus"))


def test_validate_rejects_unknown_days():
    with pytest.raises(ms.ScheduleError):
        ms.validate(_cfg(days="lundi-seulement"))


def test_day_of_week_mapping():
    assert ms.day_of_week("daily") == "*"
    assert ms.day_of_week("weekdays") == "mon-fri"


# --- persistance -----------------------------------------------------------

def test_load_returns_defaults_when_file_absent(tmp_path):
    cfg = ms.load(str(tmp_path / "nope.json"))
    assert cfg["enabled"] is False
    assert cfg["time"] == ms.DEFAULT_SCHEDULE["time"]
    assert cfg["days"] == "weekdays"


def test_save_then_load_roundtrip(tmp_path):
    p = str(tmp_path / "sched.json")
    ms.save(_cfg(time="6:45", days="daily"), p)
    cfg = ms.load(p)
    assert cfg["time"] == "06:45"      # normalisé à l'écriture
    assert cfg["days"] == "daily"
    assert cfg["enabled"] is True


def test_save_creates_parent_directory(tmp_path):
    p = str(tmp_path / "deep" / "dir" / "sched.json")
    ms.save(_cfg(), p)
    assert ms.load(p)["time"] == "07:30"


def test_load_tolerates_corrupt_file(tmp_path):
    p = tmp_path / "sched.json"
    p.write_text("{not json", encoding="utf-8")
    assert ms.load(str(p))["enabled"] is False   # défauts, jamais d'exception


def test_save_rejects_invalid_config(tmp_path):
    with pytest.raises(ms.ScheduleError):
        ms.save(_cfg(tz="Nowhere/Nope"), str(tmp_path / "s.json"))


def test_public_view_shape():
    v = ms.public_view(_cfg())
    assert set(v) >= {"enabled", "time", "tz", "days"}
    assert v["next_days"] == "mon-fri"


# --- should_catch_up : le cœur de la fiabilité -----------------------------

def test_catch_up_false_when_disabled():
    now = datetime(2026, 7, 28, 9, 0, tzinfo=ROME)      # mardi
    assert ms.should_catch_up(_cfg(enabled=False), None, now) is False


def test_catch_up_false_before_scheduled_time():
    now = datetime(2026, 7, 28, 6, 5, tzinfo=ROME)      # mardi 06:05, job à 07:30
    assert ms.should_catch_up(_cfg(), None, now) is False


def test_catch_up_true_when_time_passed_and_no_run_today():
    now = datetime(2026, 7, 28, 9, 0, tzinfo=ROME)      # mardi 09:00
    assert ms.should_catch_up(_cfg(), None, now) is True


def test_catch_up_true_when_last_run_is_yesterday():
    now = datetime(2026, 7, 28, 9, 0, tzinfo=ROME)
    assert ms.should_catch_up(_cfg(), "2026-07-27", now) is True


def test_catch_up_false_when_already_ran_today():
    now = datetime(2026, 7, 28, 9, 0, tzinfo=ROME)
    assert ms.should_catch_up(_cfg(), "2026-07-28", now) is False


def test_catch_up_accepts_date_object_for_last_run():
    now = datetime(2026, 7, 28, 9, 0, tzinfo=ROME)
    assert ms.should_catch_up(_cfg(), date(2026, 7, 28), now) is False
    assert ms.should_catch_up(_cfg(), date(2026, 7, 27), now) is True


def test_catch_up_false_on_weekend_when_weekdays_only():
    sat = datetime(2026, 8, 1, 9, 0, tzinfo=ROME)
    sun = datetime(2026, 8, 2, 9, 0, tzinfo=ROME)
    assert sat.weekday() == 5 and sun.weekday() == 6
    assert ms.should_catch_up(_cfg(), None, sat) is False
    assert ms.should_catch_up(_cfg(), None, sun) is False


def test_catch_up_true_on_weekend_when_daily():
    sat = datetime(2026, 8, 1, 9, 0, tzinfo=ROME)
    assert ms.should_catch_up(_cfg(days="daily"), None, sat) is True


def test_catch_up_false_when_far_too_late():
    # Un instantané "d'ouverture" lancé à 23h n'a plus aucun sens : au-delà de
    # MAX_CATCHUP_LATE_H on laisse le cron du lendemain faire le travail.
    now = datetime(2026, 7, 28, 23, 30, tzinfo=ROME)
    assert ms.should_catch_up(_cfg(), None, now) is False


def test_catch_up_respects_custom_lateness_bound():
    now = datetime(2026, 7, 28, 23, 30, tzinfo=ROME)
    assert ms.should_catch_up(_cfg(), None, now, max_late_h=24) is True


def test_catch_up_converts_aware_now_to_config_timezone():
    # 05:45 à New York = 11:45 à Rome -> l'heure de Rome est passée -> rattrapage.
    ny = datetime(2026, 7, 28, 5, 45, tzinfo=ZoneInfo("America/New_York"))
    assert ms.should_catch_up(_cfg(), None, ny) is True
    # 00:30 à New York = 06:30 à Rome -> pas encore l'heure.
    ny2 = datetime(2026, 7, 28, 0, 30, tzinfo=ZoneInfo("America/New_York"))
    assert ms.should_catch_up(_cfg(), None, ny2) is False


def test_catch_up_accepts_naive_now_as_local():
    assert ms.should_catch_up(_cfg(), None, datetime(2026, 7, 28, 9, 0)) is True
    assert ms.should_catch_up(_cfg(), None, datetime(2026, 7, 28, 6, 0)) is False


def test_catch_up_false_on_invalid_config():
    now = datetime(2026, 7, 28, 9, 0, tzinfo=ROME)
    assert ms.should_catch_up(_cfg(tz="Nope/Nope"), None, now) is False


def test_catch_up_exactly_at_scheduled_minute_is_true():
    now = datetime(2026, 7, 28, 7, 30, tzinfo=ROME)
    assert ms.should_catch_up(_cfg(), None, now) is True


# --- register_job (APScheduler) --------------------------------------------

class FakeScheduler(object):
    def __init__(self):
        self.added = []
        self.removed = []

    def add_job(self, func, **kwargs):
        self.added.append((func, kwargs))

    def remove_job(self, job_id):
        self.removed.append(job_id)


def _run():  # cible factice
    return None


def test_register_job_passes_explicit_timezone():
    sched = FakeScheduler()
    ms.register_job(sched, _run, _cfg())
    assert len(sched.added) == 1
    _fn, kw = sched.added[0]
    trigger = kw["trigger"]
    # ⚠️ le BackgroundScheduler du dépôt n'a PAS de fuseau configuré : sans ce
    # timezone explicite le job partirait à l'heure système, pas à Rome.
    assert trigger.timezone == ZoneInfo("Europe/Rome")
    assert str(trigger.fields[trigger.FIELD_NAMES.index("hour")]) == "7"
    assert str(trigger.fields[trigger.FIELD_NAMES.index("minute")]) == "30"
    assert str(trigger.fields[trigger.FIELD_NAMES.index("day_of_week")]) == "mon-fri"


def test_register_job_is_misfire_tolerant_and_coalesced():
    # La machine dort de 01:00 à 06:00 et redémarre : un déclenchement peut
    # arriver en retard. Grâce par défaut d'APScheduler = 1 s -> il serait SAUTÉ.
    sched = FakeScheduler()
    ms.register_job(sched, _run, _cfg())
    _fn, kw = sched.added[0]
    assert kw["coalesce"] is True
    assert kw["misfire_grace_time"] >= 900
    assert kw["max_instances"] == 1
    assert kw["replace_existing"] is True
    assert kw["id"] == ms.JOB_ID


def test_register_job_removes_job_when_disabled():
    sched = FakeScheduler()
    assert ms.register_job(sched, _run, _cfg(enabled=False)) is None
    assert sched.removed == [ms.JOB_ID]
    assert sched.added == []


def test_register_job_replaces_previous_job():
    sched = FakeScheduler()
    ms.register_job(sched, _run, _cfg())
    ms.register_job(sched, _run, _cfg(time="08:00"))
    assert sched.removed == [ms.JOB_ID, ms.JOB_ID]
    assert len(sched.added) == 2


def test_register_job_daily_uses_star():
    sched = FakeScheduler()
    ms.register_job(sched, _run, _cfg(days="daily"))
    trigger = sched.added[0][1]["trigger"]
    assert str(trigger.fields[trigger.FIELD_NAMES.index("day_of_week")]) == "*"


def test_register_job_raises_on_invalid_config():
    sched = FakeScheduler()
    with pytest.raises(ms.ScheduleError):
        ms.register_job(sched, _run, _cfg(time="99:99"))
