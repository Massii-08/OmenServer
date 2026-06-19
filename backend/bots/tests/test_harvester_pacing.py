from backend.bots.harvester.pacing import AdaptivePacer


def test_starts_at_base():
    p = AdaptivePacer(2.0)
    assert p.interval() == 2.0


def test_penalize_multiplies_and_caps():
    p = AdaptivePacer(2.0, max_interval_s=10.0, backoff_factor=2.0)
    p.penalize()
    assert p.interval() == 4.0
    p.penalize()
    assert p.interval() == 8.0
    p.penalize()
    assert p.interval() == 10.0   # capped at max
    p.penalize()
    assert p.interval() == 10.0


def test_penalize_honours_retry_after():
    p = AdaptivePacer(2.0, max_interval_s=300.0)
    p.penalize(retry_after=30.0)
    assert p.interval() == 30.0


def test_penalize_retry_after_clamped_to_range():
    p = AdaptivePacer(2.0, max_interval_s=20.0)
    p.penalize(retry_after=999.0)
    assert p.interval() == 20.0          # clamp to max
    p2 = AdaptivePacer(5.0)
    p2.penalize(retry_after=1.0)
    assert p2.interval() == 5.0          # never below base


def test_relax_decays_toward_base_never_below():
    p = AdaptivePacer(2.0, max_interval_s=100.0, backoff_factor=2.0, recover_factor=0.5)
    p.penalize(); p.penalize(); p.penalize()  # 16
    assert p.interval() == 16.0
    p.relax(); assert p.interval() == 8.0
    p.relax(); assert p.interval() == 4.0
    p.relax(); assert p.interval() == 2.0
    p.relax(); assert p.interval() == 2.0     # floor at base
