"""Séances de bourse du scanner d'actions (PUR) — voir stockscan/sessions.py.

Né du rapport de test réel du 19/10 : un scan lancé pendant la séance
européenne comparait le volume PARTIEL du jour en Europe (médiane 0,22-0,30)
au volume COMPLET de la veille aux États-Unis (médiane 1,17) — 21 lignes US
sur 25 — et confirmait des news du lundi avec des cours du vendredi.
"""
from collections import Counter
from datetime import datetime, timezone

from backend.bots.stockscan import sessions as ss


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
# Volume relatif : rapporté à la part de séance écoulée
# --------------------------------------------------------------------------- #

def _rows(market, values):
    return [{"symbol": "%s%d" % (market, i), "market": market, "rel_volume": v}
            for i, v in enumerate(values)]


def test_rel_volume_of_an_open_market_is_divided_by_the_elapsed_fraction():
    states = {"italy": {"state": "open", "elapsed": 0.5}}
    rows = _rows("italy", [0.25, 0.3, 1.0])
    report = ss.adjust_rel_volume(rows, states)
    assert [r["rel_volume"] for r in rows] == [0.5, 0.6, 2.0]
    assert [r["rel_volume_raw"] for r in rows] == [0.25, 0.3, 1.0]
    assert report == {"adjusted": ["italy"], "skipped": []}


def test_closed_market_keeps_its_complete_session_volume():
    states = {"america": {"state": "closed", "elapsed": None}}
    rows = _rows("america", [1.2, 3.0])
    report = ss.adjust_rel_volume(rows, states)
    assert [r["rel_volume"] for r in rows] == [1.2, 3.0]
    assert all("rel_volume_raw" not in r for r in rows)
    assert report == {"adjusted": [], "skipped": []}


def test_the_very_start_of_a_session_is_floored():
    # 5 min après l'ouverture : diviser par 0,01 ferait de n'importe quel
    # ordre isolé une « anomalie » ×100. Le plancher borne l'amplification.
    states = {"italy": {"state": "open", "elapsed": 0.01}}
    rows = _rows("italy", [0.02, 0.03, 0.05])
    ss.adjust_rel_volume(rows, states)
    assert rows[0]["rel_volume"] == round(0.02 / ss.MIN_ELAPSED, 4)


def test_implausible_adjustment_is_skipped_and_reported():
    # Un jour férié en semaine : la table croit la bourse ouverte, mais le
    # screener rend la séance PRÉCÉDENTE, complète (médiane ~1). Diviser par
    # une petite fraction gonflerait tout le marché : on n'ajuste pas.
    states = {"italy": {"state": "open", "elapsed": 0.2}}
    rows = _rows("italy", [0.9, 1.0, 1.1])
    report = ss.adjust_rel_volume(rows, states)
    assert [r["rel_volume"] for r in rows] == [0.9, 1.0, 1.1]
    assert report == {"adjusted": [], "skipped": ["italy"]}


def test_missing_rel_volume_stays_missing():
    states = {"italy": {"state": "open", "elapsed": 0.5}}
    rows = _rows("italy", [None, 0.4, 0.5])
    ss.adjust_rel_volume(rows, states)
    assert rows[0]["rel_volume"] is None


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
