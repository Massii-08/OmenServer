"""Scanner d'actions — le score (PUR). Les poids de la spec §6 sont verrouillés ici."""
from datetime import datetime, timedelta, timezone

from backend.bots.stockscan import scoring as sg

NOW = datetime(2026, 10, 17, 7, 0, tzinfo=timezone.utc)


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
