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
