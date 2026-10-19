"""Scanner d'actions — le score (PUR). Les poids de la spec §6 sont verrouillés ici."""
import json
import os
import statistics
from collections import Counter
from datetime import datetime, timedelta, timezone

import pytest

from backend.bots.stockscan import markets as mk
from backend.bots.stockscan import scoring as sg
from backend.bots.stockscan import screener as sc

NOW = datetime(2026, 10, 17, 7, 0, tzinfo=timezone.utc)
TODAY = NOW.date()
FIXTURES = os.path.join(os.path.dirname(__file__), "fixtures", "stockscan")
SNAPSHOT = "screener_snapshot_2026-10-19T1330Z.json"


def _news(title="Eni signs deal", sentiment="neutral", hours=2, family="tradingview"):
    return {"title": title, "url": "https://n/%s" % abs(hash(title)), "sentiment": sentiment,
            "family": family, "published": (NOW - timedelta(hours=hours)).isoformat()}


def _row(**kw):
    base = {"symbol": "ENI.MI", "rel_volume": 1.0, "change_pct": 0.5, "perf_w": 1.0,
            "earnings_next": None}
    base.update(kw)
    return base


def _score(row=None, items=(), slot=None, followed=(), **kw):
    return sg.score_row(row or _row(), list(items), slot, set(followed), NOW, 48, **kw)


def test_weights_are_the_spec_ones():
    assert (sg.NEWS_MAX, sg.NEWS_UNIT, sg.SOURCES_TWO, sg.SOURCES_THREE) == (30, 10, 8, 15)
    assert (sg.POSITIVE, sg.UPCOMING, sg.EARNINGS, sg.ALIGNED) == (10, 8, 10, 5)
    assert (sg.COACH_UP, sg.COACH_DOWN, sg.CROWD, sg.FILING) == (10, -10, 5, 5)
    assert (sg.RED, sg.LATE) == (-25, -10)
    assert sg.VOLUME_STEPS == ((4.0, 20), (2.5, 15), (1.5, 8))


def test_no_catalyst_is_excluded_even_with_huge_volume():
    out = _score(_row(rel_volume=6.0, change_pct=3.0))
    assert out["catalyst"] is False
    assert out["excluded"] == "no_catalyst"


def test_one_fresh_positive_news_with_volume():
    out = _score(_row(rel_volume=2.6, change_pct=1.5), [_news("Eni beats estimates", "pos")])
    c = out["components"]
    assert c == {"news": 10, "positive": 10, "volume": 15, "aligned": 5}
    assert out["score"] == 40
    codes = [r["code"] for r in out["reasons"]]
    assert codes == ["news", "positive", "volume", "aligned"]
    assert out["excluded"] is None


def test_news_points_are_weighted_by_recency_and_nature_and_capped():
    items = [_news("a", "neutral", 1), _news("b", "neutral", 30), _news("c", "watch", 60)]
    # 1×0,5 + 0,6×0,5 + 0,3×1 = 1,1 -> 11 points
    assert _score(items=items)["components"]["news"] == 11
    many = [_news("t%d" % i, "pos", 1) for i in range(10)]
    assert _score(items=many)["components"]["news"] == 30


def test_sources_count_distinct_families_including_coach():
    items = [_news("a", family="tradingview"), _news("b", family="presse")]
    assert _score(items=items)["components"]["sources"] == 8
    slot = {"hypotheses": [{"direction": "up"}]}
    out = _score(items=items, slot=slot)
    assert out["components"]["sources"] == 15
    assert out["components"]["coach_up"] == 10


def test_negative_news_is_red_and_can_exclude():
    items = [_news("Stellantis issues profit warning", "neg")]
    out = _score(items=items)
    assert "red" in out["flags"]
    assert out["components"]["red"] == -25
    assert out["excluded"] is None                    # alerte, pas exclusion par défaut
    assert _score(items=items, exclude_red=True)["excluded"] == "red"
    # une mauvaise nouvelle seule ne gonfle pas le compteur « news »
    assert "news" not in out["components"]


def test_late_flag_on_day_or_week_move():
    late_day = _score(_row(change_pct=-9.0), [_news()])
    assert "late" in late_day["flags"] and late_day["components"]["late"] == -10
    assert "late" in _score(_row(perf_w=21.0), [_news()])["flags"]
    assert "late" not in _score(_row(change_pct=7.9, perf_w=19.9), [_news()])["flags"]


def test_earnings_soon_is_a_catalyst_but_never_a_past_date():
    soon = _score(_row(earnings_next="2026-10-20"))
    assert soon["catalyst"] is True
    assert soon["components"]["earnings"] == 10
    assert "earnings_soon" in soon["flags"]
    assert soon["reasons"][0] == {"code": "earnings", "value": "2026-10-20"}
    assert _score(_row(earnings_next="2026-10-17"))["catalyst"] is True     # aujourd'hui
    assert _score(_row(earnings_next="2026-10-16"))["catalyst"] is False    # passée
    assert _score(_row(earnings_next="2026-10-25"))["catalyst"] is False    # au-delà de 7 j


def test_coach_down_hypothesis_is_an_alert():
    out = _score(slot={"hypotheses": [{"direction": "down"}]})
    assert out["catalyst"] is True
    assert "coach_down" in out["flags"]
    assert out["components"]["coach_down"] == -10
    assert out["score"] == 0                          # borné à zéro


def test_crowd_needs_volume_and_acceleration():
    assert sg.crowd_buzz({"count": 6, "prev": 2})
    assert not sg.crowd_buzz({"count": 6, "prev": 4})
    assert not sg.crowd_buzz({"count": 4, "prev": 0})
    out = _score(items=[_news()], slot={"reddit": {"count": 9, "prev": 1}})
    assert out["components"]["crowd"] == 5 and "crowd" in out["flags"]


def test_filing_in_window_counts():
    slot = {"filings": [{"form": "8-K", "published": (NOW - timedelta(hours=5)).isoformat()}]}
    out = _score(slot=slot)
    assert out["catalyst"] and out["components"]["filing"] == 5
    old = {"filings": [{"form": "8-K", "published": (NOW - timedelta(hours=90)).isoformat()}]}
    assert _score(slot=old)["catalyst"] is False


def test_followed_and_unverified_flags():
    out = _score(items=[_news()], followed={"ENI.MI"}, news_verified=False)
    assert "followed" in out["flags"] and "news_unverified" in out["flags"]


def test_score_is_capped_at_100():
    items = [_news("t%d" % i, "pos", 1, fam) for i, fam in
             enumerate(["tradingview", "presse", "social", "sec"] * 3)]
    items.append(_news("Ferrari to report earnings", "watch", 1))
    slot = {"hypotheses": [{"direction": "up"}], "reddit": {"count": 20, "prev": 1},
            "filings": [{"form": "8-K", "published": NOW.isoformat()}]}
    out = _score(_row(rel_volume=5, change_pct=3, earnings_next="2026-10-18"), items, slot)
    assert out["score"] == 100


def test_display_news_keeps_a_negative_visible():
    items = [_news("n%d" % i, "pos", 1 + i * 0.1) for i in range(8)]
    items.append(_news("Old profit warning", "neg", 20))
    shown = sg.display_news(items, limit=6)
    assert len(shown) == 6
    assert any(i["sentiment"] == "neg" for i in shown)


def test_pre_score_prefers_activity_and_coach_signals():
    today = NOW.date()
    calm = sg.pre_score(_row(rel_volume=0.8, change_pct=0.1), None, today)
    busy = sg.pre_score(_row(rel_volume=3.0, change_pct=4.0), None, today)
    talked = sg.pre_score(_row(rel_volume=0.8, change_pct=0.1),
                          {"news": [_news(), _news("b")], "hypotheses": [{"direction": "up"}]},
                          today)
    assert busy > calm and talked > calm
    assert sg.pre_score(_row(earnings_next="2026-10-19"), None, today) >= 10


def test_missing_values_never_crash():
    out = sg.score_row({"symbol": None}, [], None, set(), NOW, 48)
    assert out["excluded"] == "no_catalyst"
    assert sg.volume_points("abc") == 0
    assert sg.is_late(None, None) is False


# --------------------------------------------------------------------------- #
# Biais horaire : volume comparé à SON marché, présélection avec quota
# --------------------------------------------------------------------------- #

def test_volume_and_shortlist_constants_are_locked():
    assert sg.VOLUME_MEDIAN_MIN_ROWS == 8
    assert sg.VOLUME_MEDIAN_CLAMP == (0.5, 2.0)
    assert sg.SHORTLIST_RESERVED_SHARE == 0.5


def _snapshot_rows():
    """Lignes parsées de la capture RÉELLE du 19/10/2026 13:30 UTC (5 marchés)."""
    with open(os.path.join(FIXTURES, SNAPSHOT), encoding="utf-8") as f:
        snap = json.load(f)
    rows = []
    for market_id, payload in snap["markets"].items():
        parsed, _ = sc.parse_response(payload, mk.by_id(market_id))
        rows.extend(parsed)
    return rows


def test_normalize_volume_on_real_snapshot_centres_each_market_on_one():
    rows = _snapshot_rows()
    medians = sg.normalize_volume(rows)
    # médianes du volume « à l'heure » (le 10 j disait 0,37 / 0,40 / 0,31 / 0,27
    # pour l'Europe en séance contre 1,22 pour les États-Unis en pré-ouverture)
    assert medians == {"switzerland": 1.064, "italy": 0.912, "germany": 0.856,
                       "france": 0.987, "america": 1.187}
    for market_id in medians:
        adj = [r["rel_volume_adj"] for r in rows if r["market"] == market_id]
        assert len(adj) == 20
        assert statistics.median(adj) == pytest.approx(1.0, abs=0.01)


def _vol_rows(market, values, key="rel_volume_time", **extra):
    return [dict({"market": market, "symbol": "%s.%d" % (market, i), key: v}, **extra)
            for i, v in enumerate(values)]


def test_normalize_volume_clamps_the_divisor():
    quiet = _vol_rows("q", [0.2] * 8)
    busy = _vol_rows("b", [5.0] * 8)
    medians = sg.normalize_volume(quiet + busy)
    assert medians == {"q": 0.2, "b": 5.0}                    # médianes brutes, pour transparence
    assert {r["rel_volume_adj"] for r in quiet} == {0.4}       # 0,2 / 0,5 (borne basse)
    assert {r["rel_volume_adj"] for r in busy} == {2.5}        # 5,0 / 2,0 (borne haute)


def test_normalize_volume_needs_enough_values_per_market():
    rows = _vol_rows("x", [0.3] * 7) + [{"market": "x", "symbol": "NOVOL"}]
    medians = sg.normalize_volume(rows)
    assert medians == {"x": None}                              # 7 valeurs < 8 : pas de médiane
    assert [r["rel_volume_adj"] for r in rows] == [0.3] * 7 + [None]   # diviseur 1


def test_normalize_volume_falls_back_to_the_10d_volume():
    timed = _vol_rows("x", [1.0] * 4, rel_volume=0.3)
    untimed = _vol_rows("x", [2.0] * 4, key="rel_volume", rel_volume_time=None)
    # colonne « à l'heure » morte sur tout un marché : le 10 j, rapporté à SA
    # médiane (0,4, bornée à 0,5)
    dead = _vol_rows("y", [0.2, 0.3, 0.3, 0.4, 0.4, 0.4, 0.5, 0.6], key="rel_volume")
    medians = sg.normalize_volume(timed + untimed + dead)
    assert medians == {"x": 1.5, "y": 0.4}
    assert [r["rel_volume_adj"] for r in timed] == [0.67] * 4       # 1,0 / 1,5 (pas 0,3)
    assert [r["rel_volume_adj"] for r in untimed] == [1.33] * 4     # 2,0 / 1,5
    assert [r["rel_volume_adj"] for r in dead] == [0.4, 0.6, 0.6, 0.8, 0.8, 0.8, 1.0, 1.2]


def test_normalize_volume_is_per_market_and_adds_one_field_only():
    eu = _vol_rows("eu", [0.8, 0.9, 1.0, 1.0, 1.0, 1.1, 1.2, 3.0], rel_volume=0.3)
    us = _vol_rows("us", [1.6] * 8, rel_volume=1.6)
    before = [dict(r) for r in eu + us]
    medians = sg.normalize_volume(eu + us)
    assert medians == {"eu": 1.0, "us": 1.6}
    assert eu[-1]["rel_volume_adj"] == 3.0
    assert {r["rel_volume_adj"] for r in us} == {1.0}
    for old, new in zip(before, eu + us):
        assert {k: v for k, v in new.items() if k != "rel_volume_adj"} == old


def test_score_row_uses_the_volume_compared_to_its_market():
    # en pleine séance : 0,3 sur 10 j (journée partielle), mais 2,64 fois la
    # normale de son marché à cette heure
    out = _score(_row(rel_volume=0.3, rel_volume_adj=2.64, change_pct=1.5),
                 [_news("Eni beats estimates", "pos")])
    assert out["components"]["volume"] == 15
    assert {"code": "volume", "value": 2.6} in out["reasons"]
    # le 10 j de la séance complète de la veille ne compte plus quand l'ajusté est connu
    assert "volume" not in _score(_row(rel_volume=3.0, rel_volume_adj=0.9), [_news()])["components"]
    # sans ajusté (ligne qui n'est pas passée par normalize_volume) : le 10 j, comme avant
    unadjusted = _score(_row(rel_volume=2.6, rel_volume_adj=None), [_news()])
    assert unadjusted["components"]["volume"] == 15


def test_pre_score_uses_the_volume_compared_to_its_market():
    assert sg.pre_score(_row(rel_volume=0.3, rel_volume_adj=4.2, change_pct=0.0), None, TODAY) == 20
    assert sg.pre_score(_row(rel_volume=4.2, rel_volume_adj=0.3, change_pct=0.0), None, TODAY) == 0
    assert sg.pre_score(_row(rel_volume=4.2, change_pct=0.0), None, TODAY) == 20


def _market_rows(market, changes, value=100.0):
    """Lignes dont le pré-score vaut |variation| (ni volume, ni résultats, ni coach)."""
    return [{"market": market, "symbol": "%s.%d" % (market, i), "change_pct": c,
             "rel_volume": None, "avg_value_meur": value, "earnings_next": None}
            for i, c in enumerate(changes)]


def _plain_sort(rows, slots=None):
    """L'ancien tri du moteur, tel quel."""
    slots = slots or {}
    return sorted(rows, key=lambda r: (-sg.pre_score(r, slots.get(r.get("symbol")), TODAY),
                                       -(r.get("avg_value_meur") or 0.0)))


def test_shortlist_reserves_half_its_seats_equally_per_market():
    us = _market_rows("america", [9.0 - 0.1 * i for i in range(10)])    # 9,0 … 8,1
    it = _market_rows("italy", [1.0, 0.9, 0.8])
    fr = _market_rows("france", [0.5])
    out = sg.select_shortlist(us + it + fr, {}, TODAY, 12)
    # 12 × 0,5 = 6 places réservées / 3 marchés = 2 chacun ; la France n'a qu'une
    # ligne et rend l'autre au pot commun, rempli au mérite (les États-Unis)
    assert len(out) == 12
    assert Counter(r["market"] for r in out) == {"america": 9, "italy": 2, "france": 1}
    assert it[2] not in out


def test_shortlist_keeps_the_global_order():
    rows = (_market_rows("america", [9.0, 8.0, 7.0, 6.0]) + _market_rows("italy", [5.0, 0.5])
            + _market_rows("france", [3.0, 0.2]))
    out = sg.select_shortlist(rows, {}, TODAY, 4)
    # 4 × 0,5 = 2 / 3 marchés -> au moins 1 place chacun (US 9, IT 5, FR 3), puis
    # US 8 au mérite ; rendu dans l'ordre du classement global
    assert [r["change_pct"] for r in out] == [9.0, 8.0, 5.0, 3.0]


def test_shortlist_ranks_with_the_engine_key():
    """Pré-score (signaux du coach compris), puis échanges moyens — la clé de l'ancien tri."""
    rows = _market_rows("italy", [2.0, 2.0, 2.0], value=50.0)
    rows[1]["avg_value_meur"] = 80.0          # à pré-score égal, le plus échangé d'abord
    slots = {rows[2]["symbol"]: {"news": [_news()]}}      # +5 : le coach en parle
    out = sg.select_shortlist(rows, slots, TODAY, 3)
    assert out == [rows[2], rows[1], rows[0]]
    assert out == _plain_sort(rows, slots)


def test_shortlist_larger_than_universe_returns_everything_in_order():
    rows = _market_rows("america", [1.0, 7.0]) + _market_rows("italy", [3.0])
    assert sg.select_shortlist(rows, {}, TODAY, 3) == _plain_sort(rows)
    assert sg.select_shortlist(rows, {}, TODAY, 40) == _plain_sort(rows)
    assert sg.select_shortlist([], {}, TODAY, 40) == []


def test_shortlist_single_market_is_the_plain_sort():
    rows = _market_rows("italy", [(i * 7) % 11 + 0.01 * i for i in range(30)])
    for size in (1, 5, 12, 29):
        assert sg.select_shortlist(rows, {}, TODAY, size) == _plain_sort(rows)[:size]


def test_shortlist_never_exceeds_its_size():
    rows = []
    for m in range(8):
        rows += _market_rows("m%d" % m, [float(m), float(m) - 0.5])
    for size in (0, 1, 3, 7, 15):
        assert len(sg.select_shortlist(rows, {}, TODAY, size)) == size
    # plus de marchés que de places : une place chacun, aux meilleurs du classement global
    assert [r["market"] for r in sg.select_shortlist(rows, {}, TODAY, 3)] == ["m7", "m6", "m5"]


def test_shortlist_identifies_rows_by_position_not_by_symbol():
    twins = [{"market": "x", "symbol": None, "change_pct": 1.0, "avg_value_meur": 10.0}
             for _ in range(4)]
    others = [{"market": "y", "symbol": None, "change_pct": 0.5, "avg_value_meur": 10.0}
              for _ in range(2)]
    out = sg.select_shortlist(twins + others, {}, TODAY, 3)
    assert len({id(r) for r in out}) == 3                 # trois lignes distinctes
    assert [r["market"] for r in out] == ["x", "x", "y"]
