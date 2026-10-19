"""Séances de bourse du scanner d'actions (PUR) — voir stockscan/sessions.py.

Né du rapport de test réel du 19/10 : un scan lancé pendant la séance
européenne comparait le volume PARTIEL du jour en Europe (médiane 0,22-0,30)
au volume COMPLET de la veille aux États-Unis (médiane 1,17) — 21 lignes US
sur 25 — et confirmait des news du lundi avec des cours du vendredi.
"""
import json
import os
from collections import Counter
from datetime import datetime, timezone
from statistics import median

import pytest

from backend.bots.stockscan import markets as mk
from backend.bots.stockscan import screener as sc
from backend.bots.stockscan import sessions as ss

FIXTURES = os.path.join(os.path.dirname(__file__), "fixtures", "stockscan")
SNAPSHOT_MARKETS = ("switzerland", "italy", "germany", "france", "america")


def utc(*args):
    return datetime(*args, tzinfo=timezone.utc)


# Lundi 19 octobre 2026, 13:00 UTC = 15:00 à Milan (heure d'été), 09:00 à New York.
MON_1300 = utc(2026, 10, 19, 13, 0)


def test_every_scanner_market_has_hours():
    from backend.bots.stockscan import markets as mk
    assert {m.id for m in mk.MARKETS} <= set(ss.HOURS)


def test_european_market_mid_session_is_open_with_elapsed_fraction():
    st = ss.session_state("italy", MON_1300)
    assert st["state"] == "open"
    # 09:00 -> 17:30 = 8 h 30 ; 15:00 = 6 h écoulées
    assert abs(st["elapsed"] - 6 / 8.5) < 1e-6
    assert st["local_time"] == "15:00"


def test_us_market_before_its_open_is_closed_and_prices_date_from_friday():
    st = ss.session_state("america", MON_1300)
    assert st["state"] == "closed" and st["elapsed"] is None
    # dernière clôture = vendredi 16 octobre 16:00 New York = 20:00 UTC
    assert st["last_close"] == "2026-10-16T20:00:00+00:00"


def test_after_the_close_the_last_close_is_today():
    st = ss.session_state("italy", utc(2026, 10, 19, 17, 0))     # 19:00 Milan
    assert st["state"] == "closed"
    assert st["last_close"] == "2026-10-19T15:30:00+00:00"       # 17:30 Milan


def test_weekend_is_closed():
    st = ss.session_state("germany", utc(2026, 10, 17, 10, 0))   # samedi
    assert st["state"] == "closed"
    assert st["last_close"] == "2026-10-16T15:30:00+00:00"


def test_london_uses_its_own_hours_and_winter_time():
    # 2 novembre 2026 : Londres en heure d'hiver (UTC+0), séance 08:00-16:30
    st = ss.session_state("uk", utc(2026, 11, 2, 12, 15))
    assert st["state"] == "open" and abs(st["elapsed"] - 4.25 / 8.5) < 1e-6


def test_unknown_market_is_unknown_never_guessed():
    st = ss.session_state("atlantis", MON_1300)
    assert st["state"] == "unknown" and st["elapsed"] is None and st["last_close"] is None


# --------------------------------------------------------------------------- #
# Volume relatif : « à l'heure », rapporté à la médiane de son marché
# --------------------------------------------------------------------------- #

def _snapshot_rows():
    """Les lignes PARSÉES de la capture réelle du 19/10 à 13:30 UTC (5 marchés)."""
    with open(os.path.join(FIXTURES, "screener_snapshot_2026-10-19T1330Z.json"),
              encoding="utf-8") as f:
        snap = json.load(f)
    rows = []
    for market_id in SNAPSHOT_MARKETS:
        rows += sc.parse_response(snap["markets"][market_id], mk.by_id(market_id))[0]
    return rows


def _vol_rows(market, at_time, ten_day=None):
    ten_day = ten_day if ten_day is not None else [None] * len(at_time)
    return [{"symbol": "%s%d" % (market, i), "market": market,
             "rel_volume_time": t, "rel_volume": d}
            for i, (t, d) in enumerate(zip(at_time, ten_day))]


def test_volume_constants_are_locked():
    assert ss.VOLUME_MEDIAN_MIN_ROWS == 8
    assert ss.VOLUME_MEDIAN_CLAMP == (0.5, 2.0)


def test_real_snapshot_volume_is_brought_back_to_its_market():
    # Lundi 19/10 à 13:30 UTC (Europe en séance, US en pré-ouverture) : le
    # volume « à l'heure » a pour médiane CH 1,064 · IT 0,912 · DE 0,856 ·
    # FR 0,987 · US 1,187 — là où le 10 j donnait 0,27 à 0,40 en Europe contre
    # 1,22 aux US. Divisé par la médiane de son marché, chacun revient à 1,0.
    rows = _snapshot_rows()
    medians = ss.normalize_volume(rows)
    assert medians == {"switzerland": 1.064, "italy": 0.912, "germany": 0.856,
                       "france": 0.987, "america": 1.187}
    for market_id in SNAPSHOT_MARKETS:
        group = [r for r in rows if r["market"] == market_id]
        assert all(r["rel_volume_raw"] == r["rel_volume_time"] for r in group)
        divisor = median(r["rel_volume_raw"] for r in group)
        assert [r["rel_volume"] for r in group] == \
            [round(r["rel_volume_raw"] / divisor, 2) for r in group]
        assert abs(median(r["rel_volume"] for r in group) - 1.0) <= 0.01


def test_divisor_is_clamped_but_the_median_is_reported_as_measured():
    # Un marché entier à 0,2 ou à 5 fois son volume habituel : la correction
    # est bornée (÷ 0,5 au plus, ÷ 2 au plus), la médiane rendue reste la vraie.
    low = _vol_rows("italy", [0.1, 0.2, 0.2, 0.2, 0.2, 0.3, 0.3, 0.3])
    high = _vol_rows("america", [4.0, 5.0, 5.0, 5.0, 5.0, 6.0, 6.0, 6.0])
    assert ss.normalize_volume(low + high) == {"italy": 0.2, "america": 5.0}
    assert [r["rel_volume"] for r in low] == [0.2, 0.4, 0.4, 0.4, 0.4, 0.6, 0.6, 0.6]
    assert [r["rel_volume"] for r in high] == [2.0, 2.5, 2.5, 2.5, 2.5, 3.0, 3.0, 3.0]


def test_fewer_than_eight_values_leave_the_volume_as_is():
    # 8 lignes mais 7 valeurs (une sans aucun volume) : pas de médiane fiable.
    rows = _vol_rows("italy", [0.5, 0.8, 1.0, 1.2, 1.5, 2.0, 3.0, None])
    assert ss.normalize_volume(rows) == {"italy": None}
    assert [r["rel_volume"] for r in rows] == [0.5, 0.8, 1.0, 1.2, 1.5, 2.0, 3.0, None]
    assert [r["rel_volume_raw"] for r in rows] == [0.5, 0.8, 1.0, 1.2, 1.5, 2.0, 3.0, None]


def test_without_the_volume_at_time_the_ten_day_volume_takes_over():
    # Colonne « à l'heure » morte (renommée chez TradingView) ou repli Yahoo :
    # le 10 j sert de signal ; une valeur « à l'heure » connue l'emporte.
    rows = _vol_rows("italy", [None] * 7 + [1.6],
                     ten_day=[0.4, 0.6, 0.8, 0.8, 0.8, 0.8, 1.2, 9.9])
    assert ss.normalize_volume(rows) == {"italy": 0.8}
    assert [r["rel_volume_raw"] for r in rows] == [0.4, 0.6, 0.8, 0.8, 0.8, 0.8, 1.2, 1.6]
    assert [r["rel_volume"] for r in rows] == [0.5, 0.75, 1.0, 1.0, 1.0, 1.0, 1.5, 2.0]


def test_non_finite_volumes_are_ignored_and_never_reach_the_json():
    nan, inf = float("nan"), float("inf")
    rows = _vol_rows("italy", [inf, nan, -inf, None, True] + [1.0] * 6,
                     ten_day=[2.0, inf, nan, True, 1.0] + [None] * 6)
    # signaux : 2,0 (10 j) · rien · rien · rien · 1,0 (10 j) · six fois 1,0
    assert ss.normalize_volume(rows) == {"italy": 1.0}
    assert [r["rel_volume"] for r in rows] == [2.0, None, None, None] + [1.0] * 7
    assert [r["rel_volume_time"] for r in rows] == [None] * 5 + [1.0] * 6
    json.dumps(rows, allow_nan=False)        # jamais d'« Infinity » dans results.json


# --------------------------------------------------------------------------- #
# Présélection : la MOITIÉ réservée à parts égales, le reste au mérite
# --------------------------------------------------------------------------- #

_PREFIX = {"america": "US", "italy": "IT", "france": "FR", "germany": "DE",
           "switzerland": "CH"}


def _ranked(*groups):
    """``("america", 3), ("italy", 2)`` -> US0, US1, US2, IT0, IT1 (dans cet ordre)."""
    return [{"symbol": "%s%d" % (_PREFIX.get(market, market), i), "market": market}
            for market, count in groups for i in range(count)]


def _in_rank_order(picked, ranked):
    positions = [ranked.index(r) for r in picked]
    return positions == sorted(positions)


def test_half_of_the_shortlist_is_reserved():
    # Verrou : le partage INTÉGRAL de la présélection donnait, sur le snapshot
    # réel du 19/10, 4 lignes US sur 23 et 17 candidats sans catalyseur.
    assert ss.SHORTLIST_RESERVED_SHARE == 0.5


def test_quota_reserves_slots_for_every_market_then_fills_by_rank():
    ranked = _ranked(("america", 10), ("italy", 10))
    picked = ss.shortlist_with_quota(ranked, 6, ["america", "italy"])
    # moitié réservée : 3 places // 2 marchés = 1 chacun, puis le mérite (les
    # US, mieux classés ici) ; ordre du classement conservé
    assert [r["symbol"] for r in picked] == ["US0", "US1", "US2", "US3", "US4", "IT0"]


def test_reserved_half_is_split_evenly_and_the_rest_goes_to_merit():
    # La configuration réelle : 40 places, 5 marchés -> 20 réservées (4 par
    # marché) et 20 au classement global. Les US, mieux classés ici, prennent
    # les 20 places au mérite : 24 US et 4 par place européenne, la répartition
    # de la version de référence sur le snapshot du 19/10.
    markets = ["switzerland", "italy", "germany", "france", "america"]
    ranked = _ranked(("america", 50), ("switzerland", 10), ("italy", 10),
                     ("germany", 10), ("france", 10))
    picked = ss.shortlist_with_quota(ranked, 40, markets)
    assert Counter(r["market"] for r in picked) == {
        "america": 24, "switzerland": 4, "italy": 4, "germany": 4, "france": 4}
    # chaque marché garde ses MEILLEURS titres, dans l'ordre du classement
    assert [r["symbol"] for r in picked if r["market"] == "italy"] == ["IT0", "IT1", "IT2", "IT3"]
    assert _in_rank_order(picked, ranked)


def test_reserve_never_exceeds_half_of_an_odd_shortlist():
    # 15 places : la moitié réservée est arrondie vers le BAS (7), soit 3 par
    # marché — pas 4.
    ranked = _ranked(("america", 20), ("italy", 10))
    picked = ss.shortlist_with_quota(ranked, 15, ["america", "italy"])
    assert Counter(r["market"] for r in picked) == {"america": 12, "italy": 3}


def test_reserve_is_shared_among_the_markets_actually_present():
    # Un marché demandé mais absent du classement (screener en échec) ne garde
    # pas de place : la moitié réservée se partage entre les marchés PRÉSENTS.
    ranked = _ranked(("america", 20), ("italy", 10))
    picked = ss.shortlist_with_quota(ranked, 12, ["america", "italy", "france"])
    assert Counter(r["market"] for r in picked) == {"america": 9, "italy": 3}


def test_quota_gives_unused_slots_back_to_the_global_ranking():
    # 12 places, 2 marchés -> 3 réservées chacun ; l'Italie n'a qu'un titre.
    ranked = _ranked(("america", 20), ("italy", 1))
    picked = ss.shortlist_with_quota(ranked, 12, ["america", "italy"])
    assert [r["symbol"] for r in picked] == ["US%d" % i for i in range(11)] + ["IT0"]


def test_short_market_places_go_to_merit_not_to_the_other_quotas():
    # 12 places, 3 marchés -> 2 réservées chacun. L'Italie n'en remplit qu'une :
    # la place restante revient au CLASSEMENT GLOBAL (ici un titre américain),
    # elle n'agrandit pas la réserve de la France.
    ranked = _ranked(("america", 20), ("italy", 1), ("france", 10))
    picked = ss.shortlist_with_quota(ranked, 12, ["america", "italy", "france"])
    assert [r["symbol"] for r in picked] == \
        ["US%d" % i for i in range(9)] + ["IT0", "FR0", "FR1"]


def test_every_market_keeps_at_least_one_place():
    # Petite présélection, beaucoup de marchés : 10 // 2 = 5 places réservées
    # pour 8 marchés tomberait à 0 par marché — chacun en garde UNE.
    markets = ["m%d" % i for i in range(8)]
    ranked = _ranked(("m0", 30), *[(m, 2) for m in markets[1:]])
    picked = ss.shortlist_with_quota(ranked, 10, markets)
    counts = Counter(r["market"] for r in picked)
    assert set(counts) == set(markets) and len(picked) == 10
    assert counts["m0"] == 3                     # sa place réservée + les 2 du mérite
    assert _in_rank_order(picked, ranked)


def test_single_market_is_a_plain_ranking_cut():
    ranked = _ranked(("italy", 30))
    picked = ss.shortlist_with_quota(ranked, 12, ["america", "italy"])
    assert picked == ranked[:12]


def test_quota_never_returns_more_than_asked_nor_duplicates():
    ranked = [{"symbol": "S%d" % i, "market": m} for i, m in
              enumerate(["a", "b", "c", "a", "b", "c", "a"])]
    picked = ss.shortlist_with_quota(ranked, 4, ["a", "b", "c"])
    assert len(picked) == 4 and len({r["symbol"] for r in picked}) == 4
    # plus de marchés que de places : une place réservée chacun dépasserait la
    # taille demandée — on coupe, sans doublon, dans l'ordre du classement
    picked = ss.shortlist_with_quota(ranked, 2, ["a", "b", "c"])
    assert len(picked) == 2 and len({r["symbol"] for r in picked}) == 2
    assert _in_rank_order(picked, ranked)


# --------------------------------------------------------------------------- #
# État de séance lu dans TradingView (fériés compris) — la table en repli
# --------------------------------------------------------------------------- #

# Horodatages RÉELS de la capture du 19/10 (``time`` = ouverture de la barre
# journalière : la séance que décrivent variation, gap et volume).
TOKYO_MON = 1792368000      # 19/10 09:00 JST
HONG_KONG_FRI = 1792114200  # 16/10 09:30 HKT : le lundi 19/10 était férié à Hong Kong
SYDNEY_MON = 1792360800     # 19/10 09:00 AEDT = 18/10 22:00 UTC
EUROPE_MON = 1792393200     # 19/10 07:00 UTC = 09:00 à Milan
US_FRI = 1792157400         # 16/10 13:30 UTC = 09:30 à New York
SNAPSHOT_NOW = utc(2026, 10, 19, 13, 30, 37)


@pytest.mark.parametrize("raw,expected", [
    ("market", "open"), ("pre_market", "pre_open"), ("post_market", "closed"),
    ("out_of_session", "closed"),
    ("lunch_break", None), ("MARKET", None), ("", None), (None, None), (1, None),
])
def test_tradingview_session_is_mapped_never_guessed(raw, expected):
    assert ss.tv_session_state(raw) == expected


@pytest.mark.parametrize("stamp,tz,expected", [
    (TOKYO_MON, "Asia/Tokyo", "2026-10-19"),
    (HONG_KONG_FRI, "Asia/Hong_Kong", "2026-10-16"),
    (SYDNEY_MON, "Australia/Sydney", "2026-10-19"),          # en UTC : le 18 !
    (EUROPE_MON, "Europe/Rome", "2026-10-19"),
    (US_FRI, "America/New_York", "2026-10-16"),
    (SYDNEY_MON * 1000, "Australia/Sydney", "2026-10-19"),   # millisecondes
])
def test_session_date_is_the_local_date_of_the_place(stamp, tz, expected):
    assert ss.session_date(stamp, tz) == expected


@pytest.mark.parametrize("tz", [None, "", 42, "Mars/Olympus_Mons", "America", "../../etc",
                                "/etc/passwd", "Etc/../Europe/Rome", "Europe/Rome\x00"])
def test_session_date_falls_back_to_utc_without_a_usable_timezone(tz):
    assert ss.session_date(SYDNEY_MON, tz) == "2026-10-18"


@pytest.mark.parametrize("stamp", [None, "", "hier", True, 0, -5, 12345,
                                   float("nan"), float("inf"), 1e17, 1e30, [1]])
def test_session_date_of_an_unreadable_timestamp_is_none(stamp):
    assert ss.session_date(stamp, "Europe/Rome") is None


def test_local_today_is_the_day_on_the_spot():
    assert ss.local_today("Australia/Sydney", utc(2026, 10, 19, 23, 40)) == "2026-10-20"
    assert ss.local_today("America/New_York", utc(2026, 10, 20, 2, 0)) == "2026-10-19"
    assert ss.local_today("../../etc", utc(2026, 10, 19, 23, 40)) == "2026-10-19"   # UTC


@pytest.mark.parametrize("day,tz,now,expected", [
    # pré-ouverture du lundi à New York : chiffres du vendredi
    ("2026-10-16", "America/New_York", SNAPSHOT_NOW, True),
    # Europe en séance : chiffres du jour
    ("2026-10-19", "Europe/Rome", SNAPSHOT_NOW, False),
    # Tokyo clôturée le jour même, 23:40 JST : chiffres du jour
    ("2026-10-19", "Asia/Tokyo", utc(2026, 10, 19, 14, 40), False),
    # Hong Kong férié le lundi : la barre est celle du vendredi
    ("2026-10-16", "Asia/Hong_Kong", SNAPSHOT_NOW, True),
    # lundi 23:40 UTC : déjà mardi à Sydney, les chiffres sont ceux de lundi
    ("2026-10-19", "Australia/Sydney", utc(2026, 10, 19, 23, 40), True),
], ids=["us-pre-ouverture", "europe-ouverte", "tokyo-cloturee", "hong-kong-ferie",
        "sydney-deja-mardi"])
def test_figures_are_stale_when_they_predate_the_local_day(day, tz, now, expected):
    assert ss.is_stale(day, tz, now) is expected


def _tv_row(market, state, day, tz):
    return {"market": market, "session_state": state, "session_date": day, "session_tz": tz}


def test_row_session_us_pre_open_monday_prices_date_from_friday_close():
    # 13:30:37 UTC = 09:30 à New York : la table dirait « ouverte », mais les
    # données (différées) sont en pré-ouverture, avec la barre du vendredi.
    s = ss.row_session(_tv_row("america", "pre_open", "2026-10-16", "America/New_York"),
                       SNAPSHOT_NOW)
    assert s == {"source": "tradingview", "state": "pre_open", "date": "2026-10-16",
                 "stale": True, "elapsed": None, "local_time": "09:30",
                 "last_close": "2026-10-16T20:00:00+00:00"}


def test_row_session_europe_open_today_has_live_prices_and_the_table_elapsed():
    s = ss.row_session(_tv_row("italy", "open", "2026-10-19", "Europe/Rome"), SNAPSHOT_NOW)
    assert s["source"] == "tradingview" and s["state"] == "open"
    assert s["date"] == "2026-10-19" and s["stale"] is False
    assert s["last_close"] is None                           # cours vivants
    assert s["elapsed"] == round(ss.session_state("italy", SNAPSHOT_NOW)["elapsed"], 3)
    assert s["local_time"] == "15:30"


def test_row_session_open_for_tradingview_but_not_for_the_table_has_no_elapsed():
    s = ss.row_session(_tv_row("italy", "open", "2026-10-19", "Europe/Rome"),
                       utc(2026, 10, 19, 16, 0))                 # 18:00 à Milan
    assert s["state"] == "open" and s["elapsed"] is None and s["last_close"] is None


def test_row_session_open_but_stale_dates_the_prices_from_that_session():
    # Place ouverte, mais aucun échange aujourd'hui sur ce titre : sa barre est
    # celle du vendredi, ses chiffres aussi.
    s = ss.row_session(_tv_row("italy", "open", "2026-10-16", "Europe/Rome"), SNAPSHOT_NOW)
    assert s["stale"] is True and s["last_close"] == "2026-10-16T15:30:00+00:00"


def test_row_session_closed_the_same_day_is_not_stale():
    s = ss.row_session(_tv_row("italy", "closed", "2026-10-19", "Europe/Rome"),
                       utc(2026, 10, 19, 17, 0))                 # 19:00 à Milan
    assert s["stale"] is False and s["last_close"] == "2026-10-19T15:30:00+00:00"


def test_row_session_never_dates_prices_from_a_close_still_to_come():
    # Barre du JOUR en pré-ouverture : sa clôture n'a pas encore eu lieu.
    s = ss.row_session(_tv_row("america", "pre_open", "2026-10-19", "America/New_York"),
                       SNAPSHOT_NOW)
    assert s["stale"] is False and s["last_close"] is None


def test_row_session_judges_staleness_on_the_local_day_of_the_row():
    # Lundi 23:40 UTC : déjà mardi à Sydney — la barre du lundi est d'hier.
    # En UTC (encore lundi), on la croirait du jour.
    s = ss.row_session(_tv_row("australia", "closed", "2026-10-19", "Australia/Sydney"),
                       utc(2026, 10, 19, 23, 40))
    assert s["stale"] is True


def test_row_session_of_a_market_unknown_to_the_table_never_guesses_a_close():
    # Hong Kong (absent de HOURS), férié le lundi : chiffres du vendredi, mais
    # aucune heure de clôture connue, donc pas d'instant inventé.
    s = ss.row_session(_tv_row("hong_kong", "closed", "2026-10-16", "Asia/Hong_Kong"),
                       SNAPSHOT_NOW)
    assert s["source"] == "tradingview" and s["stale"] is True
    assert s["last_close"] is None and s["elapsed"] is None


def test_row_session_falls_back_to_the_table_without_tradingview_fields():
    # Repli Yahoo ou colonnes mortes : la table, comme avant (samedi : fermée).
    s = ss.row_session({"market": "germany"}, utc(2026, 10, 17, 10, 0))
    assert s == {"source": "table", "state": "closed", "date": None, "stale": False,
                 "elapsed": None, "local_time": "12:00",
                 "last_close": "2026-10-16T15:30:00+00:00"}
    # un état sans date ne suffit pas ; place ouverte : cours vivants
    s = ss.row_session({"market": "italy", "session_state": "open"}, MON_1300)
    assert s["source"] == "table" and s["state"] == "open" and s["last_close"] is None
    assert s["elapsed"] == round(6 / 8.5, 3)


def test_price_asof_reads_the_last_close_of_the_session():
    assert ss.price_asof({"state": "pre_open", "last_close": "2026-10-16T20:00:00+00:00"}) == \
        utc(2026, 10, 16, 20, 0)
    # ouverte mais chiffres d'une séance antérieure : figés eux aussi
    assert ss.price_asof({"state": "open", "stale": True,
                          "last_close": "2026-10-16T15:30:00+00:00"}) == utc(2026, 10, 16, 15, 30)
    assert ss.price_asof({"state": "open", "last_close": None}) is None
    assert ss.price_asof({"state": "closed", "last_close": "hier"}) is None
    assert ss.price_asof(None) is None


def test_market_summary_is_derived_from_the_rows_of_its_universe():
    # les lignes minoritaires EN PREMIER : le résumé est la majorité, pas la 1re
    # ligne (un état minoritaire aux US, une date minoritaire en Italie : un
    # titre sans échange aujourd'hui garde la barre du vendredi)
    rows = [_tv_row("america", "open", "2026-10-19", "America/New_York")] + \
           [_tv_row("america", "pre_open", "2026-10-16", "America/New_York")] * 3 + \
           [_tv_row("italy", "open", "2026-10-16", "Europe/Rome")] + \
           [_tv_row("italy", "open", "2026-10-19", "Europe/Rome")] * 2 + \
           [{"market": "germany"}]
    summary = ss.market_sessions(rows, SNAPSHOT_NOW)
    assert set(summary) == {"america", "italy", "germany"}
    assert summary["america"] == {"state": "pre_open", "date": "2026-10-16", "stale": True,
                                  "elapsed": None, "source": "tradingview"}
    assert (summary["italy"]["state"], summary["italy"]["date"], summary["italy"]["stale"]) == \
        ("open", "2026-10-19", False)
    assert summary["italy"]["elapsed"] is not None
    assert summary["germany"]["source"] == "table" and summary["germany"]["date"] is None
