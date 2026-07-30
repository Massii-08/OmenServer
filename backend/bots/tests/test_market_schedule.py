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


# ==========================================================================
#  PHASE D — un job par OUVERTURE, pas un par bourse
# ==========================================================================
#
# Dix opérateurs ne font que cinq ouvertures : Londres ouvre au même instant que
# Paris et Francfort, Hong Kong au même instant que Shanghai et Shenzhen, NYSE au
# même instant que le Nasdaq. Produire deux briefings identiques à la même
# seconde n'aurait aucun sens — et coûterait deux appels au LLM.

# Forme rendue par pulse.exchanges.opening_groups : (ids, fuseau, "HH:MM").
G_TOKYO = (["jpx"], "Asia/Tokyo", "09:00")
G_EUROPE = (["euronext", "lse", "deutsche_boerse"], "Europe/Paris", "09:00")
G_NY = (["nyse", "nasdaq"], "America/New_York", "09:30")


class FullScheduler(FakeScheduler):
    """Double qui sait aussi énumérer ses jobs (comme APScheduler)."""

    class _Job(object):
        def __init__(self, job_id):
            self.id = job_id

    def add_job(self, func, **kwargs):
        FakeScheduler.add_job(self, func, **kwargs)
        self._ids = getattr(self, "_ids", [])
        self._ids.append(kwargs["id"])

    def get_jobs(self):
        return [self._Job(i) for i in getattr(self, "_ids", [])]

    def remove_job(self, job_id):
        FakeScheduler.remove_job(self, job_id)
        self._ids = [i for i in getattr(self, "_ids", []) if i != job_id]


# --- l'heure de déclenchement ---------------------------------------------

def test_the_job_fires_a_quarter_of_an_hour_BEFORE_the_bell():
    assert ms.lead_time("09:00") == "08:45"
    assert ms.lead_time("09:30") == "09:15"
    assert ms.lead_time("09:15") == "09:00"
    assert ms.lead_time("08:00") == "07:45"


def test_lead_time_wraps_around_midnight_without_going_negative():
    # Aucune de nos places n'ouvre à 00:05, mais un « -1:50 » deviendrait 23:50
    # après normalisation et partirait le mauvais jour.
    assert ms.lead_time("00:05") == "23:50"


def test_lead_time_is_configurable():
    assert ms.lead_time("09:00", lead_minutes=30) == "08:30"


# --- la clé de groupe ------------------------------------------------------

def test_the_group_key_is_the_utc_instant_so_it_survives_a_selection_change():
    # Londres 08:00 et Paris 09:00 sont le MÊME instant : même clé.
    assert ms.group_key("Europe/London", "08:00") == ms.group_key("Europe/Paris", "09:00")
    # Retirer Londres de la sélection ne doit pas renommer le groupe, sinon le
    # rattrapage croirait n'avoir jamais tourné et relancerait un run.
    assert ms.group_key("Europe/Paris", "09:00") != ms.group_key("Asia/Tokyo", "09:00")


def test_the_group_key_is_a_safe_job_id_fragment():
    key = ms.group_key("America/New_York", "09:30")
    assert key and key.replace("_", "").isalnum(), key


# --- installation des jobs -------------------------------------------------

def test_one_job_per_opening_group_each_with_its_own_timezone():
    sched = FullScheduler()
    ids = ms.register_exchange_jobs(sched, _run, [G_TOKYO, G_EUROPE, G_NY], _cfg())
    assert len(ids) == 3
    assert len(sched.added) == 3
    zones = set()
    for _fn, kw in sched.added:
        trigger = kw["trigger"]
        # ⚠️ Sans timezone explicite, « 08:45 » partirait à l'heure système.
        zones.add(str(trigger.timezone))
        assert kw["coalesce"] is True
        assert kw["misfire_grace_time"] >= 900
        assert kw["max_instances"] == 1
        assert kw["replace_existing"] is True
        assert kw["id"].startswith(ms.EXCHANGE_JOB_PREFIX)
    assert zones == {"Asia/Tokyo", "Europe/Paris", "America/New_York"}


def test_the_job_carries_the_ids_of_its_group():
    sched = FullScheduler()
    ms.register_exchange_jobs(sched, _run, [G_NY], _cfg())
    _fn, kw = sched.added[0]
    assert kw["args"] == [["nyse", "nasdaq"]]


def test_the_trigger_minute_is_the_lead_time_not_the_bell():
    sched = FullScheduler()
    ms.register_exchange_jobs(sched, _run, [G_NY], _cfg())
    trigger = sched.added[0][1]["trigger"]
    names = trigger.FIELD_NAMES
    assert str(trigger.fields[names.index("hour")]) == "9"
    assert str(trigger.fields[names.index("minute")]) == "15"
    assert str(trigger.fields[names.index("day_of_week")]) == "mon-fri"


def test_no_group_means_no_job_at_all():
    sched = FullScheduler()
    assert ms.register_exchange_jobs(sched, _run, [], _cfg()) == []
    assert sched.added == []


def test_disabled_schedule_installs_nothing():
    sched = FullScheduler()
    assert ms.register_exchange_jobs(sched, _run, [G_NY], _cfg(enabled=False)) == []
    assert sched.added == []


def test_a_group_that_is_no_longer_selected_has_its_job_REMOVED():
    """Décocher une bourse doit vraiment éteindre son réveil.

    Sans ce ménage, l'ancien job resterait armé dans le scheduler et produirait
    un briefing pour une place que l'utilisateur ne suit plus.
    """
    sched = FullScheduler()
    ms.register_exchange_jobs(sched, _run, [G_TOKYO, G_NY], _cfg())
    sched.added = []
    ms.register_exchange_jobs(sched, _run, [G_NY], _cfg())
    survivors = [j.id for j in sched.get_jobs()]
    assert survivors == [ms.exchange_job_id(ms.group_key(*G_NY[1:]))]


def test_turning_the_schedule_off_removes_the_jobs_that_were_installed():
    sched = FullScheduler()
    ms.register_exchange_jobs(sched, _run, [G_TOKYO, G_NY], _cfg())
    ms.register_exchange_jobs(sched, _run, [G_TOKYO, G_NY], _cfg(enabled=False))
    assert [j.id for j in sched.get_jobs()] == []


def test_a_scheduler_without_get_jobs_still_works():
    # Le double le plus simple (et un vieux APScheduler) n'énumère pas ses jobs.
    sched = FakeScheduler()
    ids = ms.register_exchange_jobs(sched, _run, [G_NY], _cfg())
    assert len(ids) == 1


# --- rattrapage PAR GROUPE -------------------------------------------------

GROUPS = [G_TOKYO, G_EUROPE, G_NY]


def _keys():
    return dict((ms.group_key(tz, at), ids) for ids, tz, at in GROUPS)


def test_at_six_in_the_morning_the_asian_opening_missed_during_sleep_is_caught_up():
    """L'Omen dort de 01:00 à 06:00. Tokyo ouvre pendant son sommeil.

    APScheduler n'a aucun jobstore persistant : au réveil il ne sait RIEN du
    déclenchement manqué. C'est ici, et seulement ici, que Tokyo est rattrapé.
    """
    now = datetime(2026, 7, 30, 6, 0, tzinfo=ROME)       # jeudi 06:00
    todo = ms.groups_to_catch_up(_cfg(), GROUPS, {}, now)
    ids = sorted(sum([g["ids"] for g in todo], []))
    assert "jpx" in ids, todo


def test_a_group_whose_bell_has_not_rung_yet_is_not_caught_up():
    now = datetime(2026, 7, 30, 6, 0, tzinfo=ROME)       # 06:00 Rome
    todo = ms.groups_to_catch_up(_cfg(), GROUPS, {}, now)
    ids = sum([g["ids"] for g in todo], [])
    # New York déclenche à 09:15 heure de New York = 15:15 à Rome.
    assert "nyse" not in ids, todo


def test_a_group_that_already_ran_today_is_not_run_twice():
    now = datetime(2026, 7, 30, 6, 0, tzinfo=ROME)
    tokyo_key = ms.group_key(*G_TOKYO[1:])
    todo = ms.groups_to_catch_up(_cfg(), GROUPS, {tokyo_key: "2026-07-30"}, now)
    assert "jpx" not in sum([g["ids"] for g in todo], []), todo


def test_yesterdays_run_does_not_count_as_todays():
    now = datetime(2026, 7, 30, 6, 0, tzinfo=ROME)
    tokyo_key = ms.group_key(*G_TOKYO[1:])
    todo = ms.groups_to_catch_up(_cfg(), GROUPS, {tokyo_key: "2026-07-29"}, now)
    assert "jpx" in sum([g["ids"] for g in todo], []), todo


def test_nothing_is_caught_up_when_the_schedule_is_off():
    now = datetime(2026, 7, 30, 6, 0, tzinfo=ROME)
    assert ms.groups_to_catch_up(_cfg(enabled=False), GROUPS, {}, now) == []


def test_nothing_is_caught_up_on_a_weekend():
    sat = datetime(2026, 8, 1, 12, 0, tzinfo=ROME)
    assert ms.groups_to_catch_up(_cfg(), GROUPS, {}, sat) == []


def test_an_opening_missed_by_far_too_long_is_dropped_not_run_at_night():
    # 23:30 à Rome : rattraper l'ouverture de Tokyo de ce matin-là n'a plus de
    # sens, la séance est finie depuis longtemps.
    now = datetime(2026, 7, 30, 23, 30, tzinfo=ROME)
    ids = sum([g["ids"] for g in ms.groups_to_catch_up(_cfg(), GROUPS, {}, now)], [])
    assert "jpx" not in ids


def test_each_group_to_catch_up_carries_what_the_router_needs():
    now = datetime(2026, 7, 30, 6, 0, tzinfo=ROME)
    todo = ms.groups_to_catch_up(_cfg(), GROUPS, {}, now)
    assert todo
    for group in todo:
        assert set(group) >= {"key", "ids", "time", "tz"}
